# Copyright (c) 2026, Coding Pro
"""Campaign Manager tests.

Run on a bench:  bench --site <site> run-tests --app crm_addons --module crm_addons.campaigns.doctype.crm_campaign.test_crm_campaign

Same conventions as the rest of the add-on: plain unittest, every test rolled back. The engine's
``_commit`` / ``_rollback`` wrappers are neutralised so a test never leaks (or wipes) data, and the
providers are faked: no mail leaves the site and Meta is never called.
"""

import json
import types
import unittest
from unittest.mock import MagicMock, patch

import frappe
from frappe.utils import add_to_date, now_datetime

import requests

from crm_addons import debuglog, inject
from crm_addons.campaigns import analytics, api, audience, channels, common, engine, guard, journey, optout, personalization
from crm_addons.campaigns.channels import ChannelError, Skip
from crm_addons.meetings.doctype.crm_meeting.test_crm_meeting import TestCase as Base

R = "CRM Campaign Recipient"
C = "CRM Campaign"


class FakeQueue(frappe._dict):
	pass


class Campaigns(Base):
	"""Fixtures: three leads (good, no email, bad number), an email template and helpers."""

	def setUp(self):
		super().setUp()
		for target in ("_commit", "_rollback"):
			p = patch.object(engine, target)
			p.start()
			self.addCleanup(p.stop)
		for sender in (channels.EmailSender, channels.WhatsAppSender):
			p = patch.object(sender, "check_ready")  # readiness has its own checks; here the engine is under test
			p.start()
			self.addCleanup(p.stop)
		frappe.db.set_single_value("CRM Addons Settings", "whatsapp_consent_mode", "Allow unless opted out")
		frappe.db.set_single_value("CRM Addons Settings", "default_country_code", "91")
		frappe.clear_document_cache("CRM Addons Settings", "CRM Addons Settings")

		self.tpl = frappe.get_doc(
			{
				"doctype": "CRM Campaign Email Template",
				"template_name": "Test Template",
				"subject": "Hello {{ first_name }}",
				"body_html": "<p>Hi {{ first_name }}, from {{ sender_name }}</p>",
				"enabled": 1,
			}
		).insert(ignore_permissions=True)
		self.leads = [
			self.make_lead("Asha", "asha.camp@example.com", "9876543210"),
			self.make_lead("Bina", "", "9876543211"),
			self.make_lead("Chet", "chet.camp@example.com", "12"),
		]

	def make_lead(self, first, email, mobile, **kw):
		return frappe.get_doc(
			{"doctype": "CRM Lead", "first_name": first, "last_name": "Camp", "email": email, "mobile_no": mobile, "lead_owner": self.owner.name, **kw}
		).insert(ignore_permissions=True)

	def make_campaign(self, channel_names=("Email",), leads=None, wa_map=None, steps=None, **kw):
		leads = leads or self.leads
		steps = list(steps or [])
		if "Email" in channel_names and not steps:
			steps.append({"channel": "Email", "day_offset": 0, "email_template": self.tpl.name})
		if "WhatsApp" in channel_names and not any(x["channel"] == "WhatsApp" for x in steps):
			steps.append({"channel": "WhatsApp", "day_offset": 0, "wa_template": "WA-T", "variable_map": json.dumps(wa_map or {"1": "{{ first_name }}"})})
		doc = frappe.new_doc(C)
		doc.update(
			{
				"campaign_name": "Test Campaign",
				"campaign_owner": "Administrator",
				"audience_mode": "Selected Records",
				"selected_records": json.dumps([l.name for l in leads]),
				**kw,
			}
		)
		for s in steps:
			doc.append("steps", s)
		with patch.object(common, "whatsapp_installed", return_value=True):
			doc.insert(ignore_permissions=True)
		return doc

	def run_launch(self, doc):
		with patch("frappe.enqueue") as enq:
			result = engine.launch(doc.name)
		engine.materialise(doc.name)
		return result, enq

	def rows(self, campaign, **filters):
		return frappe.get_all(R, filters={"campaign": campaign, **filters}, fields=["name", "status", "channel", "skip_reason", "recipient_id", "email", "email_queue"])

	def fake_send(self, **kw):
		return FakeQueue(name=frappe.generate_hash(length=8), message_id="<m@x>", **kw)


class TestHelpers(unittest.TestCase):
	def test_outgoing_account_problem_names_the_fix(self):
		def exists(doctype, filters=None, *a, **k):
			return have_default if "default_outgoing" in filters else have_any

		for have_any, have_default, expect in ((False, False, "No outgoing"), (True, False, "Default Outgoing"), (True, True, None)):
			with patch.object(frappe.db, "exists", side_effect=exists):
				problem = common.email_account_problem()
			if expect:
				self.assertIn(expect, problem)
			else:
				self.assertIsNone(problem)

	def test_whatsapp_number_normalisation(self):
		n = common.normalize_whatsapp
		self.assertEqual(n("+91 98765 43210"), "919876543210")
		self.assertEqual(n("00919876543210"), "919876543210")
		self.assertEqual(n("9876543210", "91"), "919876543210")
		self.assertEqual(n("919876543210", "91"), "919876543210")
		self.assertIsNone(n("9876543210"))  # national number and no country code known
		self.assertIsNone(n("12", "91"))
		self.assertIsNone(n("abc", "91"))

	def test_dedupe_key_is_per_campaign_step_channel_and_lead(self):
		k = common.dedupe_key
		self.assertEqual(k("C", 1, "Email", "L"), k("C", 1, "Email", "L"))
		self.assertEqual(len({k("C", 1, "Email", "L"), k("C", 2, "Email", "L"), k("C", 1, "WhatsApp", "L"), k("D", 1, "Email", "L")}), 4)

	def test_retry_only_for_errors_that_prove_nothing_was_sent(self):
		self.assertTrue(channels.classify("(#130429) Rate limit hit"))
		self.assertTrue(channels.classify("Max retries exceeded with url"))
		self.assertFalse(channels.classify("Read timed out"))  # may have been accepted: never retried
		self.assertFalse(channels.classify("Template does not exist"))

	def test_unknown_variable_renders_empty_never_as_template_text(self):
		# Frappe's own Jinja prints "{{ typo }}" for an unknown name; that must never reach a customer
		self.assertEqual(personalization.render("[{{ typo }}]", {"a": "b"}), "[]")
		self.assertEqual(personalization.render("{{ a }}", {"a": "<b>"}, html=True), "&lt;b&gt;")

	def test_journey_conditions_are_judged_per_lead(self):
		j = journey.judge
		sent, read, failed = {"status": "Sent"}, {"status": "Read"}, {"status": "Failed"}
		queued_mail, pending = {"status": "Queued", "email_queue": "EQ-1"}, {"status": "Pending"}
		self.assertEqual(j("", failed)[0], "ok")
		self.assertEqual(j("Previous step was sent", sent)[0], "ok")
		self.assertEqual(j("Previous step was sent", queued_mail)[0], "ok")
		self.assertEqual(j("Previous step was sent", failed)[0], "skip")
		self.assertEqual(j("Previous step was read or opened", read)[0], "ok")
		self.assertEqual(j("Previous step was read or opened", sent)[0], "skip")
		self.assertEqual(j("Previous step was not read or opened", sent)[0], "ok")
		self.assertEqual(j("Previous step was not read or opened", read)[0], "skip")
		self.assertEqual(j("Previous step was not read or opened", failed)[0], "skip")  # never delivered is not "unread"
		self.assertEqual(j("Previous step failed or was skipped", failed)[0], "ok")
		self.assertEqual(j("Previous step failed or was skipped", {"status": "Skipped"})[0], "ok")
		self.assertEqual(j("Previous step failed or was skipped", None)[0], "ok")
		self.assertEqual(j("Previous step failed or was skipped", read)[0], "skip")
		self.assertEqual(j("Previous step was read or opened", pending)[0], "defer")  # still on its way
		self.assertEqual(j("Previous step was read or opened", {"status": "Queued"})[0], "defer")

	def test_placeholders_and_mapping(self):
		self.assertEqual(personalization.placeholders_in("Hi {{1}} and {{ 2 }}"), [1, 2])
		with self.assertRaises(frappe.ValidationError):
			personalization.parse_variable_map('{"first": "x"}')


class TestAudience(Campaigns):
	def test_filters_are_validated_on_the_server(self):
		with self.assertRaises(frappe.ValidationError):
			audience.clean_filters([["not_a_field", "=", "x"]])
		with self.assertRaises(frappe.ValidationError):
			audience.clean_filters([["status", "; drop table", "x"]])
		with self.assertRaises(frappe.ValidationError):
			audience.clean_filters([["status", "=", "x", "extra"]])
		self.assertEqual(audience.clean_filters([["status", "in", "a, b"]])[0][3], ["a", "b"])

	def test_selected_records_and_count(self):
		d = {"mode": "Selected Records", "selected": [l.name for l in self.leads]}
		self.assertEqual(audience.count(d), 3)

	def test_summary_reports_missing_invalid_duplicate_and_opted_out(self):
		dup = self.make_lead("Dup", "asha.camp@example.com", "9876543210")
		optout.add_opt_out("Email", "chet.camp@example.com")
		optout.add_opt_out("WhatsApp", "9876543211")
		d = {"mode": "Selected Records", "selected": [l.name for l in self.leads + [dup]]}
		s = audience.summary(d, ["Email", "WhatsApp"])
		self.assertEqual(s["total"], 4)
		self.assertEqual(s["Email"]["reasons"].get("Missing email"), 1)
		self.assertEqual(s["Email"]["reasons"].get("Opted out"), 1)
		self.assertEqual(s["Email"]["reasons"].get("Duplicate email in this campaign"), 1)
		self.assertEqual(s["WhatsApp"]["reasons"].get("Invalid WhatsApp number"), 1)
		self.assertEqual(s["WhatsApp"]["reasons"].get("Opted out"), 1)
		self.assertEqual(s["WhatsApp"]["reasons"].get("Duplicate number in this campaign"), 1)
		self.assertEqual(s["Email"]["eligible"], 1)

	def test_whatsapp_requires_opt_in_unless_the_owner_confirms(self):
		frappe.db.set_single_value("CRM Addons Settings", "whatsapp_consent_mode", "Require opt-in")
		frappe.clear_document_cache("CRM Addons Settings", "CRM Addons Settings")
		d = {"mode": "Selected Records", "selected": [self.leads[0].name]}
		self.assertEqual(audience.summary(d, ["WhatsApp"])["WhatsApp"]["reasons"], {"Not opted in to WhatsApp": 1})
		self.assertEqual(audience.summary(d, ["WhatsApp"], consent_confirmed=1)["WhatsApp"]["eligible"], 1)
		frappe.db.set_value("CRM Lead", self.leads[0].name, "crm_wa_opt_in", 1)
		self.assertEqual(audience.summary(d, ["WhatsApp"])["WhatsApp"]["eligible"], 1)


class TestLaunchAndDuplicates(Campaigns):
	def test_launch_builds_one_row_per_lead_with_clear_skip_reasons(self):
		doc = self.make_campaign()
		result, enq = self.run_launch(doc)
		self.assertEqual(result["status"], "Queued")
		rows = {r.recipient_id: r for r in self.rows(doc.name)}
		self.assertEqual(rows[self.leads[0].name].status, "Pending")
		self.assertEqual(rows[self.leads[1].name].skip_reason, "Missing email")
		self.assertEqual(rows[self.leads[1].name].status, "Skipped")
		self.assertEqual(rows[self.leads[2].name].status, "Pending")
		self.assertEqual(frappe.db.get_value(C, doc.name, "status"), "Running")
		self.assertEqual(frappe.db.get_value(C, doc.name, "total_recipients"), 3)

	def test_launching_twice_is_refused_and_rebuilding_adds_nothing(self):
		doc = self.make_campaign()
		self.run_launch(doc)
		with self.assertRaises(frappe.ValidationError):
			engine.launch(doc.name)
		before = len(self.rows(doc.name))
		frappe.db.set_value(C, doc.name, "status", "Queued")  # a restarted materialise job
		engine.materialise(doc.name)
		self.assertEqual(len(self.rows(doc.name)), before)

	def test_database_refuses_a_second_row_for_the_same_logical_message(self):
		doc = self.make_campaign()
		self.run_launch(doc)
		existing = frappe.get_doc(R, self.rows(doc.name)[0].name)
		clone = frappe.get_doc({"doctype": R, "campaign": doc.name, "step_idx": existing.step_idx, "channel": existing.channel, "recipient_type": "CRM Lead", "recipient_id": existing.recipient_id})
		with self.assertRaises((frappe.UniqueValidationError, frappe.DuplicateEntryError)):
			clone.insert(ignore_permissions=True)

	def test_status_cannot_be_set_through_a_save(self):
		doc = self.make_campaign()
		doc.status = "Completed"
		with self.assertRaises(frappe.ValidationError):
			doc.save(ignore_permissions=True)

	def test_cannot_edit_audience_of_a_running_campaign(self):
		doc = self.make_campaign()
		self.run_launch(doc)
		doc.reload()
		doc.selected_records = "[]"
		with self.assertRaises(frappe.ValidationError):
			doc.save(ignore_permissions=True)

	def test_scheduled_campaign_waits_and_edits_send_it_back_to_draft(self):
		when = add_to_date(now_datetime(), days=2)
		doc = self.make_campaign(send_mode="Schedule", scheduled_at=when)
		with patch("frappe.enqueue") as enq:
			self.assertEqual(engine.launch(doc.name)["status"], "Scheduled")
		enq.assert_not_called()
		doc.reload()
		doc.selected_records = json.dumps([self.leads[0].name])
		doc.save(ignore_permissions=True)
		self.assertEqual(doc.status, "Draft")

	def test_launch_is_refused_when_nobody_is_eligible(self):
		doc = self.make_campaign(leads=[self.leads[1]])
		with self.assertRaises(frappe.ValidationError):
			engine.launch(doc.name)


class TestSending(Campaigns):
	def started(self, **kw):
		doc = self.make_campaign(**kw)
		self.run_launch(doc)
		return doc

	def claim_all(self, doc):
		return engine._claim(doc.name, 100)

	def test_dispatch_claims_each_row_once(self):
		doc = self.started()
		with patch("frappe.enqueue") as enq:
			engine._dispatch_campaign(frappe.get_doc(C, doc.name))
			first = enq.call_args_list
			engine._dispatch_campaign(frappe.get_doc(C, doc.name))
		self.assertEqual(len(first), 1)
		self.assertEqual(len(enq.call_args_list), 1)  # nothing left to claim the second time
		self.assertEqual(len(self.rows(doc.name, status="Queued")), 2)

	def test_rate_limit_caps_the_batch(self):
		doc = self.started(rate_per_minute=1)
		with patch("frappe.enqueue"):
			engine._dispatch_campaign(frappe.get_doc(C, doc.name))
		self.assertEqual(len(self.rows(doc.name, status="Queued")), 1)

	def test_email_goes_through_frappe_mail_and_the_lead_timeline(self):
		doc = self.started()
		names = self.claim_all(doc)
		with patch.object(frappe, "sendmail", autospec=True, side_effect=lambda **kw: self.fake_send()) as mail:
			engine.send_batch(doc.name, names)
		self.assertEqual(mail.call_count, 2)
		kw = mail.call_args.kwargs
		self.assertEqual(kw["reference_doctype"], "CRM Lead")
		self.assertTrue(kw["communication"])
		self.assertEqual(kw["unsubscribe_method"], optout.UNSUBSCRIBE_METHOD)
		self.assertIn("Hello", kw["subject"])
		sent = self.rows(doc.name, status="Queued")
		self.assertEqual(len(sent), 2)
		self.assertTrue(all(r.email_queue for r in sent))
		self.assertEqual(frappe.db.count("Communication", {"reference_doctype": "CRM Lead", "reference_name": self.leads[0].name}), 1)

	def test_html_in_a_lead_name_is_escaped_in_the_email(self):
		lead = self.make_lead("<script>alert(1)</script>", "evil.camp@example.com", "9876543299")
		doc = self.started(leads=[lead])
		with patch.object(frappe, "sendmail", autospec=True, side_effect=lambda **kw: self.fake_send()) as mail:
			engine.send_batch(doc.name, self.claim_all(doc))
		self.assertNotIn("<script>", mail.call_args.kwargs["message"])

	def test_a_second_worker_for_the_same_rows_sends_nothing(self):
		doc = self.started()
		names = self.claim_all(doc)
		with patch.object(frappe, "sendmail", autospec=True, side_effect=lambda **kw: self.fake_send()) as mail:
			engine.send_batch(doc.name, names)
			engine.send_batch(doc.name, names)  # duplicate job / retry / restart
		self.assertEqual(mail.call_count, 2)

	def test_pause_releases_unsent_rows_and_resume_sends_them(self):
		doc = self.started()
		names = self.claim_all(doc)
		engine.pause(doc.name)
		with patch.object(frappe, "sendmail", autospec=True) as mail:
			engine.send_batch(doc.name, names)
		mail.assert_not_called()
		self.assertEqual(len(self.rows(doc.name, status="Pending")), 2)
		engine.resume(doc.name)
		self.assertEqual(frappe.db.get_value(C, doc.name, "status"), "Running")

	def test_cancel_stops_everything_not_yet_sent(self):
		doc = self.started()
		names = self.claim_all(doc)
		engine.cancel(doc.name)
		with patch.object(frappe, "sendmail", autospec=True) as mail:
			engine.send_batch(doc.name, names)
		mail.assert_not_called()
		self.assertEqual(len(self.rows(doc.name, status="Cancelled")), 2)

	def test_opt_out_after_the_audience_was_built_is_honoured_at_send_time(self):
		doc = self.started()
		names = self.claim_all(doc)
		optout.add_opt_out("Email", "asha.camp@example.com")
		with patch.object(frappe, "sendmail", autospec=True, side_effect=lambda **kw: self.fake_send()):
			engine.send_batch(doc.name, names)
		skipped = self.rows(doc.name, status="Skipped", recipient_id=self.leads[0].name)
		self.assertEqual(skipped[0].skip_reason, "Opted out")

	def test_a_failed_send_is_recorded_not_raised_and_other_recipients_still_go(self):
		doc = self.started()
		names = self.claim_all(doc)
		calls = []

		def flaky(**kw):
			calls.append(kw)
			if len(calls) == 1:
				raise Exception("SMTP down")
			return self.fake_send()

		with patch.object(frappe, "sendmail", autospec=True, side_effect=flaky):
			engine.send_batch(doc.name, names)
		failed = self.rows(doc.name, status="Failed")
		self.assertEqual(len(failed), 1)
		self.assertIn("SMTP down", frappe.db.get_value(R, failed[0].name, "failure_reason"))
		self.assertEqual(len(self.rows(doc.name, status="Queued")), 1)

	def test_rate_limited_whatsapp_send_is_retried_with_backoff_but_others_fail_for_good(self):
		doc = self.make_campaign(("WhatsApp",), leads=[self.leads[0]])
		self.run_launch(doc)
		rec = frappe.get_doc(R, self.rows(doc.name)[0].name)
		campaign = frappe.get_doc(C, doc.name)
		frappe.db.set_value(R, rec.name, "status", "Sending")
		engine._fail(campaign, frappe.get_doc(R, rec.name), "Rate limit hit", True, "130429")
		row = frappe.get_doc(R, rec.name)
		self.assertEqual((row.status, row.retry_count), ("Pending", 1))
		self.assertTrue(row.retry_after)
		frappe.db.set_value(R, rec.name, {"status": "Sending", "retry_count": 2})
		engine._fail(campaign, frappe.get_doc(R, rec.name), "Rate limit hit", True, "130429")
		self.assertEqual(frappe.db.get_value(R, rec.name, "status"), "Failed")

	def test_whatsapp_send_uses_the_existing_whatsapp_message_doctype(self):
		doc = self.make_campaign(("WhatsApp",), leads=[self.leads[0]])
		self.run_launch(doc)
		fake = MagicMock()
		fake.message_id = "wamid.ABC"
		fake.name = "WA-MSG-1"
		tpl = frappe._dict(name="WA-T", status="APPROVED", template="Hi {{1}}")
		with patch.object(channels.WhatsAppSender, "_template", return_value=tpl), patch.object(
			channels.WhatsAppSender, "account", return_value="Acct"
		), patch("frappe.new_doc", return_value=fake):
			engine.send_batch(doc.name, self.claim_all(doc))
		payload = fake.update.call_args.args[0]
		self.assertEqual(payload["to"], "919876543210")
		self.assertEqual(payload["message_type"], "Template")
		self.assertEqual(payload["template"], "WA-T")
		self.assertEqual(json.loads(payload["body_param"]), {"1": "Asha"})
		self.assertTrue(payload["bulk_message_reference"].startswith(common.WA_MARKER))
		fake.insert.assert_called_once()
		row = frappe.get_doc(R, self.rows(doc.name)[0].name)
		self.assertEqual((row.status, row.provider_message_id, row.linked_doc), ("Sent", "wamid.ABC", "WA-MSG-1"))

	def test_whatsapp_template_variable_empty_for_a_lead_skips_that_lead(self):
		doc = self.make_campaign(("WhatsApp",), leads=[self.leads[0]], wa_map={"1": "{{ nothing_here }}"})
		self.run_launch(doc)
		tpl = frappe._dict(name="WA-T", status="APPROVED", template="Hi {{1}}")
		with patch.object(channels.WhatsAppSender, "_template", return_value=tpl), patch.object(channels.WhatsAppSender, "account", return_value="Acct"):
			engine.send_batch(doc.name, self.claim_all(doc))
		self.assertEqual(len(self.rows(doc.name, status="Skipped")), 1, frappe.get_all(R, filters={"campaign": doc.name}, fields=["status", "failure_reason"]))


class TestStatusTracking(Campaigns):
	def row(self, status="Sent", channel="WhatsApp"):
		doc = self.make_campaign((channel,), leads=[self.leads[0]])
		self.run_launch(doc)
		name = self.rows(doc.name)[0].name
		frappe.db.set_value(R, name, "status", status)
		return doc, name

	def test_status_only_moves_forward(self):
		_doc, name = self.row("Sent")
		self.assertTrue(engine.advance(name, "Read"))
		self.assertFalse(engine.advance(name, "Delivered"))  # a late callback
		self.assertFalse(engine.advance(name, "Sent"))
		row = frappe.get_doc(R, name)
		self.assertEqual(row.status, "Read")
		self.assertTrue(row.read_at and row.delivered_at and row.sent_at)  # a read message was delivered and sent

	def test_meta_webhook_status_is_mirrored_onto_the_recipient(self):
		_doc, name = self.row("Sent")
		for meta_status, expected in (("delivered", "Delivered"), ("read", "Read")):
			engine.on_whatsapp_message_update(frappe._dict(bulk_message_reference=common.WA_MARKER + name, status=meta_status))
			self.assertEqual(frappe.db.get_value(R, name, "status"), expected)
		self.assertEqual(frappe.db.get_value(R, name, "provider_status"), "read")

	def test_a_failed_callback_after_sent_marks_the_recipient_failed(self):
		_doc, name = self.row("Sent")
		engine.on_whatsapp_message_update(frappe._dict(bulk_message_reference=common.WA_MARKER + name, status="failed"))
		self.assertEqual(frappe.db.get_value(R, name, "status"), "Failed")

	def test_other_whatsapp_messages_are_ignored(self):
		_doc, name = self.row("Sent")
		engine.on_whatsapp_message_update(frappe._dict(bulk_message_reference="BULK-WA-2026-00001", status="read"))
		engine.on_whatsapp_message_update(frappe._dict(bulk_message_reference=common.WA_MARKER + name, status="Queued"))
		self.assertEqual(frappe.db.get_value(R, name, "status"), "Sent")

	def test_email_status_comes_from_email_queue_and_communication(self):
		_doc, name = self.row("Queued", "Email")
		queue = frappe._dict(name="EQ-1", status="Sent", error=None, modified=now_datetime(), communication="COMM-1")
		comm = frappe._dict(name="COMM-1", delivery_status="Opened", read_by_recipient=1, read_by_recipient_on=now_datetime())
		rec = frappe._dict(name=name, email_queue="EQ-1")
		with patch("frappe.get_all", side_effect=[[queue], [comm]]):
			out = channels.EmailSender().sync([rec])
		self.assertEqual(out[name]["status"], "Read")
		with patch("frappe.get_all", side_effect=[[frappe._dict(queue, status="Error", error="550 no such user", communication=None)], []]):
			out = channels.EmailSender().sync([rec])
		self.assertEqual(out[name]["status"], "Failed")
		self.assertIn("550", out[name]["failure_reason"])

	def test_crashed_worker_rows_are_never_resent(self):
		doc = self.make_campaign()
		self.run_launch(doc)
		name = self.rows(doc.name)[0].name
		frappe.db.set_value(R, name, {"status": "Sending", "started_at": add_to_date(now_datetime(), minutes=-30)})
		with patch.object(frappe, "sendmail", autospec=True) as mail:
			engine.recover_stale(doc.name)
		mail.assert_not_called()
		row = frappe.get_doc(R, name)
		self.assertEqual(row.status, "Failed")
		self.assertIn("not retried", row.failure_reason)

	def test_stale_claims_that_never_started_go_back_in_line(self):
		doc = self.make_campaign()
		self.run_launch(doc)
		name = self.rows(doc.name)[0].name
		frappe.db.set_value(R, name, {"status": "Queued", "queued_at": add_to_date(now_datetime(), minutes=-45)})
		engine.recover_stale(doc.name)
		self.assertEqual(frappe.db.get_value(R, name, "status"), "Pending")

	def test_campaign_completes_when_nothing_is_left(self):
		doc = self.make_campaign()
		self.run_launch(doc)
		for r in self.rows(doc.name, status="Pending"):
			frappe.db.set_value(R, r.name, "status", "Sent")
		engine._finish_if_done(frappe.get_doc(C, doc.name))
		self.assertEqual(frappe.db.get_value(C, doc.name, "status"), "Completed")

	def test_campaign_fails_when_every_message_failed(self):
		doc = self.make_campaign()
		self.run_launch(doc)
		for r in self.rows(doc.name, status="Pending"):
			frappe.db.set_value(R, r.name, "status", "Failed")
		engine._finish_if_done(frappe.get_doc(C, doc.name))
		self.assertEqual(frappe.db.get_value(C, doc.name, "status"), "Failed")

	def test_retry_failed_requeues_only_rows_the_provider_never_saw(self):
		doc = self.make_campaign()
		self.run_launch(doc)
		a, b = [r.name for r in self.rows(doc.name, status="Pending")]
		frappe.db.set_value(C, doc.name, "status", "Paused")
		frappe.db.set_value(R, a, {"status": "Failed", "started_at": now_datetime()})
		frappe.db.set_value(R, b, {"status": "Failed", "started_at": now_datetime(), "provider_message_id": "wamid.X"})
		self.assertEqual(engine.retry_failed(doc.name)["requeued"], 1)
		self.assertEqual(frappe.db.get_value(R, a, "status"), "Pending")
		self.assertEqual(frappe.db.get_value(R, b, "status"), "Failed")


class TestOptOut(Campaigns):
	def test_stop_reply_opts_the_number_out(self):
		msg = frappe._dict(type="Incoming", content_type="text", message=" Stop. ", reference_doctype="CRM Lead", reference_name=self.leads[0].name)
		msg["from"] = "+91 98765 43210"
		optout.on_whatsapp_message(msg)
		self.assertTrue(optout.is_opted_out("WhatsApp", "9876543210"))
		self.assertEqual(frappe.db.get_value("CRM Campaign Opt Out", {"value": "919876543210"}, "source"), "WhatsApp Reply")

	def test_normal_reply_does_not_opt_out(self):
		msg = frappe._dict(type="Incoming", content_type="text", message="Please stop by tomorrow")
		msg["from"] = "919876543210"
		optout.on_whatsapp_message(msg)
		self.assertFalse(optout.is_opted_out("WhatsApp", "919876543210"))

	def test_unsubscribe_link_opts_the_email_out_everywhere(self):
		with patch("frappe.respond_as_web_page"):
			optout.unsubscribe("Asha.Camp@Example.com", "CRM Lead", self.leads[0].name)
			optout.unsubscribe("asha.camp@example.com", "CRM Lead", self.leads[0].name)  # twice is harmless
		self.assertTrue(optout.is_opted_out("Email", "asha.camp@example.com"))
		self.assertEqual(frappe.db.count("CRM Campaign Opt Out", {"value": "asha.camp@example.com"}), 1)
		self.assertTrue(frappe.db.exists("Email Unsubscribe", {"email": "asha.camp@example.com", "global_unsubscribe": 1}))


class TestApiAndPermissions(Campaigns):
	def test_save_campaign_ignores_status_and_unknown_fields(self):
		data = {"campaign_name": "Via API", "status": "Completed", "owner": "someone@else.com", "audience_mode": "Selected Records", "selected_records": json.dumps([self.leads[0].name]), "steps": [{"channel": "Email", "email_template": self.tpl.name}]}
		out = api.save_campaign(data)
		self.assertEqual(out["status"], "Draft")
		self.assertIn("launch", out["allowed_actions"])

	def test_a_draft_can_be_saved_before_any_channel_is_chosen(self):
		# the wizard saves on "Next" from the first step, when there are no steps yet
		out = api.save_campaign({"campaign_name": "Just a name", "audience_mode": "CRM Filters", "audience_filters": "[]", "steps": []})
		self.assertEqual((out["status"], out["steps"]), ("Draft", []))
		with self.assertRaises(frappe.ValidationError):
			engine.launch(out["name"])  # but it cannot be launched without a step

	def test_email_preview_really_renders(self):
		# not mocked: this is the path the wizard's "Show preview" button takes
		out = api.preview_step({"channel": "Email", "email_template": self.tpl.name}, self.leads[0].name)
		self.assertEqual(out["subject"], "Hello Asha")
		self.assertIn("Hi Asha", out["html"])
		self.assertIn("Hi Asha", out["text"])

	def test_sales_user_cannot_launch_or_see_someone_elses_campaign(self):
		doc = self.make_campaign()
		other = self.make_user("other.camp@example.org", "Sales User")
		frappe.set_user(other.name)
		with self.assertRaises(frappe.PermissionError):
			engine.launch(doc.name)
		self.assertNotIn(doc.name, frappe.get_list(C, pluck="name"))
		with self.assertRaises(frappe.PermissionError):
			api.get_campaign(doc.name)

	def test_manager_sees_every_campaign(self):
		doc = self.make_campaign()
		mgr = self.make_user("mgr.camp@example.org", "Sales Manager")
		frappe.set_user(mgr.name)
		self.assertIn(doc.name, frappe.get_list(C, pluck="name"))

	def test_only_the_administrator_and_system_managers_are_offered_settings(self):
		self.assertTrue(api.get_config()["can_configure"])  # the test user is the Administrator
		sysmgr = self.make_user("sysmgr.camp@example.org", "Sales Manager")
		frappe.set_user(sysmgr.name)
		self.assertFalse(api.get_config()["can_configure"])  # a Sales Manager manages campaigns, not the app's settings
		frappe.set_user("Administrator")
		sysmgr.add_roles("System Manager")
		frappe.set_user(sysmgr.name)
		frappe.clear_cache(user=sysmgr.name)
		self.assertTrue(api.get_config()["can_configure"])
		other = self.make_user("sales.camp@example.org", "Sales User")
		frappe.set_user(other.name)
		self.assertFalse(api.get_config()["can_configure"])

	def test_users_without_a_sales_role_are_refused(self):
		stranger = self.make_user("stranger.camp@example.org", "Website Manager")
		frappe.set_user(stranger.name)
		with self.assertRaises(frappe.PermissionError):
			api.list_campaigns()

	def test_duplicate_copies_configuration_but_not_history(self):
		doc = self.make_campaign()
		self.run_launch(doc)
		copy = api.duplicate_campaign(doc.name)
		self.assertEqual(copy["status"], "Draft")
		self.assertEqual(copy["duplicate_of"], doc.name)
		self.assertEqual(len(copy["steps"]), 1)
		self.assertEqual(len(self.rows(copy["name"])), 0)

	def test_save_as_template_and_create_from_it(self):
		doc = self.make_campaign()
		name = api.save_as_template(doc.name, "My Template")
		fresh = api.create_from_template(name, "From Template")
		self.assertEqual(fresh["campaign_name"], "From Template")
		self.assertEqual(fresh["source_template"], name)
		self.assertEqual(len(fresh["steps"]), 1)

	def test_recipient_report_is_scoped_to_campaigns_the_user_can_see(self):
		doc = self.make_campaign()
		self.run_launch(doc)
		other = self.make_user("viewer.camp@example.org", "Sales User")
		frappe.set_user(other.name)
		with self.assertRaises(frappe.PermissionError):
			api.list_recipients(doc.name)

	def test_template_with_unknown_variable_is_rejected(self):
		with self.assertRaises(frappe.ValidationError):
			frappe.get_doc({"doctype": "CRM Campaign Email Template", "template_name": "Bad", "subject": "Hi {{ not_a_real_field }}", "body_html": "x", "enabled": 1}).insert(ignore_permissions=True)


class TestAnalytics(Campaigns):
	def test_only_supported_metrics_are_reported(self):
		doc = self.make_campaign(("Email", "WhatsApp"), leads=[self.leads[0]])
		with patch.object(common, "whatsapp_installed", return_value=True):
			self.run_launch(doc)
		wa = [r for r in self.rows(doc.name) if r.channel == "WhatsApp"][0].name
		em = [r for r in self.rows(doc.name) if r.channel == "Email"][0].name
		frappe.db.set_value(R, wa, "status", "Read")
		frappe.db.set_value(R, em, "status", "Sent")
		with patch.object(analytics, "email_open_tracking_enabled", return_value=False):
			out = analytics.get_analytics(doc.name)["channels"]
		wa_keys = {m["key"]: m["value"] for m in out["WhatsApp"]}
		em_keys = {m["key"]: m["value"] for m in out["Email"]}
		self.assertEqual((wa_keys["sent"], wa_keys["delivered"], wa_keys["read"]), (1, 1, 1))
		self.assertEqual(em_keys["sent"], 1)
		self.assertNotIn("opened", em_keys)  # no open tracking configured: never faked
		self.assertNotIn("delivered", em_keys)
		self.assertEqual(em_keys["clicked"], 0)  # counted by this app from its own links, so it is real, not faked


def email(day=0, condition="", template=None):
	return {"channel": "Email", "day_offset": day, "condition": condition, "email_template": template}


class TestJourney(Campaigns):
	def journey(self, *steps, **kw):
		built = [dict(s, email_template=s.get("email_template") or self.tpl.name) if s["channel"] == "Email" else s for s in steps]
		return self.make_campaign(steps=built, **kw)

	def started(self, *steps, **kw):
		doc = self.journey(*steps, **kw)
		self.run_launch(doc)
		return doc

	def step_rows(self, doc, idx, **filters):
		return frappe.get_all(R, filters={"campaign": doc.name, "step_idx": idx, **filters}, fields=["name", "status", "due_at", "skip_reason", "recipient_id"])

	# -- validation
	def test_steps_must_run_in_day_order(self):
		with self.assertRaises(frappe.ValidationError):
			self.journey(email(5), email(2))

	def test_first_step_cannot_depend_on_a_previous_step(self):
		with self.assertRaises(frappe.ValidationError):
			self.journey(email(0, "Previous step was sent"))

	def test_unknown_condition_and_absurd_day_are_refused(self):
		with self.assertRaises(frappe.ValidationError):
			self.journey(email(0), email(1, "whenever"))
		with self.assertRaises(frappe.ValidationError):
			self.journey(email(0), email(9999))

	def test_same_template_twice_on_the_same_day_is_refused_but_on_another_day_is_fine(self):
		with self.assertRaises(frappe.ValidationError):
			self.journey(email(2), email(2))
		self.assertTrue(self.journey(email(0), email(2)).name)

	# -- scheduling of rows
	def test_every_step_gets_a_row_and_later_steps_get_a_due_time(self):
		doc = self.started(email(0), email(2, "Previous step was read or opened"))
		self.assertEqual(frappe.db.get_value(C, doc.name, "total_recipients"), 6)  # 3 leads x 2 steps (one lead has no email)
		self.assertEqual(len(self.step_rows(doc, 2, status="Skipped")), 1)
		day0 = self.step_rows(doc, 1, status="Pending")
		day2 = self.step_rows(doc, 2, status="Pending")
		self.assertTrue(all(r.due_at is None for r in day0))
		started = frappe.db.get_value(C, doc.name, "started_at")
		for r in day2:
			self.assertAlmostEqual((r.due_at - started).total_seconds(), 2 * 86400, delta=5)

	def test_only_due_rows_are_claimed(self):
		doc = self.started(email(0), email(2))
		claimed = engine._claim(doc.name, 100)
		self.assertEqual(len(claimed), 2)
		self.assertTrue(all(frappe.db.get_value(R, n, "step_idx") == 1 for n in claimed))
		frappe.db.sql(f"update `tab{R}` set due_at = %s where campaign=%s and step_idx=2", (add_to_date(now_datetime(), minutes=-1), doc.name))
		self.assertEqual(len(engine._claim(doc.name, 100)), 2)  # now it is the day

	def test_campaign_is_not_completed_while_later_steps_wait(self):
		doc = self.started(email(0), email(2))
		for r in self.step_rows(doc, 1):
			frappe.db.set_value(R, r.name, "status", "Sent")
		engine._finish_if_done(frappe.get_doc(C, doc.name))
		self.assertEqual(frappe.db.get_value(C, doc.name, "status"), "Running")

	def test_cancel_also_cancels_steps_that_have_not_come_due(self):
		doc = self.started(email(0), email(3))
		engine.cancel(doc.name)
		self.assertEqual(len(self.step_rows(doc, 2, status="Cancelled")), 2)

	def test_changing_a_condition_after_launch_is_refused(self):
		doc = self.started(email(0), email(2, "Previous step was sent"))
		doc.reload()
		doc.steps[1].condition = "Previous step failed or was skipped"
		with self.assertRaises(frappe.ValidationError):
			doc.save(ignore_permissions=True)

	# -- the gate, evaluated when a step is due
	def due(self, doc, idx=2):
		"""Make step ``idx`` due and claim only its rows (the other steps stay exactly as the test left them)."""
		frappe.db.sql(f"update `tab{R}` set due_at = %s where campaign=%s and step_idx=%s", (add_to_date(now_datetime(), minutes=-1), doc.name, idx))
		claimed = engine._claim(doc.name, 100)
		mine = [n for n in claimed if frappe.db.get_value(R, n, "step_idx") == idx]
		others = [n for n in claimed if n not in mine]
		if others:
			frappe.db.sql(f"update `tab{R}` set status='Pending', claim_token=NULL where name in %s", (tuple(others),))
		return mine

	def run_step(self, doc, names):
		with patch.object(frappe, "sendmail", autospec=True, side_effect=lambda **kw: self.fake_send()) as mail:
			engine.send_batch(doc.name, names)
		return mail

	def test_follow_up_is_skipped_for_leads_who_did_not_read_and_sent_to_those_who_did(self):
		doc = self.started(email(0), email(2, "Previous step was read or opened"))
		a, b = [r.recipient_id for r in self.step_rows(doc, 1, status="Pending")]
		frappe.db.set_value(R, {"campaign": doc.name, "step_idx": 1, "recipient_id": a}, "status", "Read")
		frappe.db.set_value(R, {"campaign": doc.name, "step_idx": 1, "recipient_id": b}, "status", "Sent")
		mail = self.run_step(doc, self.due(doc))
		self.assertEqual(mail.call_count, 1)
		skipped = [r for r in self.step_rows(doc, 2, status="Skipped") if r.skip_reason != "Missing email"]
		self.assertEqual([r.recipient_id for r in skipped], [b])
		self.assertIn("Condition not met", skipped[0].skip_reason)

	def test_fallback_step_goes_only_to_leads_whose_first_message_failed(self):
		doc = self.started(email(0), email(1, "Previous step failed or was skipped"))
		a, b = [r.recipient_id for r in self.step_rows(doc, 1, status="Pending")]
		frappe.db.set_value(R, {"campaign": doc.name, "step_idx": 1, "recipient_id": a}, "status", "Failed")
		frappe.db.set_value(R, {"campaign": doc.name, "step_idx": 1, "recipient_id": b}, "status", "Delivered")
		mail = self.run_step(doc, self.due(doc))
		self.assertEqual(mail.call_count, 1)
		self.assertEqual(self.step_rows(doc, 2, status="Queued")[0].recipient_id, a)

	def test_follow_up_waits_when_the_previous_message_has_not_gone_out_yet(self):
		doc = self.started(email(0), email(1, "Previous step was read or opened"))
		names = self.due(doc)  # step 1 is still Pending (nothing sent yet)
		mail = self.run_step(doc, names)
		mail.assert_not_called()
		rows = [r for r in self.step_rows(doc, 2) if r.skip_reason != "Missing email"]
		self.assertEqual(len(rows), 2)
		self.assertTrue(all(r.status == "Pending" and r.due_at > now_datetime() for r in rows))  # looked at again later

	def test_stop_on_reply_skips_later_steps_for_a_lead_who_wrote_back(self):
		doc = self.started(email(0), email(2), stop_on_reply=1)
		lead = frappe.get_doc("CRM Lead", self.step_rows(doc, 1, status="Pending")[0].recipient_id)
		frappe.get_doc({"doctype": "Communication", "communication_type": "Communication", "communication_medium": "Email", "sent_or_received": "Received", "subject": "Re: hello", "content": "interested", "sender": lead.email or "x@example.com", "recipients": "me@example.com", "reference_doctype": "CRM Lead", "reference_name": lead.name}).insert(ignore_permissions=True)
		mail = self.run_step(doc, self.due(doc))
		self.assertEqual(mail.call_count, 1)  # the other lead still gets it
		skipped = [r for r in self.step_rows(doc, 2, status="Skipped") if r.skip_reason != "Missing email"]
		self.assertEqual(skipped[0].recipient_id, lead.name)
		self.assertIn("replied", skipped[0].skip_reason)

	def test_without_stop_on_reply_a_reply_changes_nothing(self):
		doc = self.started(email(0), email(2))
		lead = self.step_rows(doc, 1, status="Pending")[0].recipient_id
		frappe.get_doc({"doctype": "Communication", "communication_type": "Communication", "communication_medium": "Email", "sent_or_received": "Received", "subject": "Re", "content": "x", "sender": "x@example.com", "recipients": "me@example.com", "reference_doctype": "CRM Lead", "reference_name": lead}).insert(ignore_permissions=True)
		self.assertEqual(self.run_step(doc, self.due(doc)).call_count, 2)

	def test_a_second_worker_cannot_resend_a_follow_up(self):
		doc = self.started(email(0), email(2))
		names = self.due(doc)
		with patch.object(frappe, "sendmail", autospec=True, side_effect=lambda **kw: self.fake_send()) as mail:
			engine.send_batch(doc.name, names)
			engine.send_batch(doc.name, names)
		self.assertEqual(mail.call_count, 2)

	# -- reporting
	def test_analytics_separates_later_steps_and_reports_each_step(self):
		doc = self.started(email(0), email(2, "Previous step was read or opened"))
		out = analytics.get_analytics(doc.name)
		em = {m["key"]: m["value"] for m in out["channels"]["Email"]}
		self.assertEqual(em["later"], 2)
		self.assertEqual(em["queued"], 2)
		steps = out["steps"]
		self.assertEqual([(s["step"], s["day"]) for s in steps], [(1, 0), (2, 2)])
		self.assertEqual(steps[1]["condition"], "Previous step was read or opened")
		self.assertEqual((steps[0]["later"], steps[1]["later"]), (0, 2))

	def test_duplicate_and_template_keep_the_journey(self):
		doc = self.journey(email(0), email(2, "Previous step was read or opened"), stop_on_reply=1)
		copy = api.duplicate_campaign(doc.name)
		self.assertEqual(copy["steps"][1]["condition"], "Previous step was read or opened")
		self.assertEqual(copy["steps"][1]["day_offset"], 2)
		self.assertEqual(copy["stop_on_reply"], 1)
		tpl = api.save_as_template(doc.name, "Journey Template")
		self.assertEqual(api.create_from_template(tpl, "From Journey")["steps"][1]["day_offset"], 2)


# ---------------------------------------------------------------------------------------------------------------
# Campaign Manager UI backend: overview, templates, test sends, attachments, segments, audience insight
# ---------------------------------------------------------------------------------------------------------------


class UiApi(Campaigns):
	def setUp(self):
		super().setUp()
		p = patch.object(api, "_outgoing_ready", return_value=True)  # the test site has no outgoing Email Account
		p.start()
		self.addCleanup(p.stop)
		for kind in ("test_email", "test_wa"):
			for user in ("Administrator", "mgr.ui@example.org", "usr.ui@example.org"):
				frappe.cache().delete_value(f"crm_addons:cm_{kind}:{user}")

	def claim_all(self, doc):
		return engine._claim(doc.name, 100)

	def make_file(self, content=b"hello", name="brochure.txt", private=1):
		f = frappe.get_doc({"doctype": "File", "file_name": name, "content": content, "is_private": private}).insert(ignore_permissions=True)

		def cleanup():
			import os

			path = frappe.get_site_path(f.file_url.lstrip("/"))
			if os.path.exists(path):
				os.remove(path)

		self.addCleanup(cleanup)
		return f


class TestOverview(UiApi):
	def started(self, **kw):
		doc = self.make_campaign(("Email", "WhatsApp"), leads=[self.leads[0]], **kw)
		with patch.object(common, "whatsapp_installed", return_value=True):
			self.run_launch(doc)
		frappe.db.set_value(C, doc.name, "started_at", add_to_date(now_datetime(), hours=-1))
		return doc

	def test_overview_shape_and_numbers(self):
		doc = self.started()
		rows = {r.channel: r.name for r in self.rows(doc.name)}
		frappe.db.set_value(R, rows["WhatsApp"], {"status": "Read", "sent_at": now_datetime()})
		frappe.db.set_value(R, rows["Email"], {"status": "Failed", "failed_at": now_datetime()})
		out = analytics.get_overview()
		self.assertEqual(set(out), {"totals", "by_channel", "by_day", "top_campaigns", "status_counts", "notes", "all_campaigns"})
		self.assertEqual(set(out["totals"]), {"campaigns", "recipients", "sent", "delivered", "read_or_opened", "failed", "replied", "opted_out", "cost"})
		mine = [c for c in out["top_campaigns"] if c["name"] == doc.name][0]
		self.assertEqual((mine["sent"], mine["delivered"], mine["read"], mine["failed"]), (1, 1, 1, 1))
		self.assertEqual(mine["channel"], "Multi-channel")
		self.assertGreaterEqual(out["by_channel"]["WhatsApp"]["read_or_opened"], 1)
		self.assertEqual(out["by_channel"]["Email"]["delivered"], 0)  # email delivery is never reported
		self.assertGreaterEqual(out["totals"]["failed"], 1)
		today = frappe.utils.nowdate()
		self.assertTrue(any(d["date"] == today and d["sent"] >= 1 and d["failed"] >= 1 for d in out["by_day"]))
		self.assertIn("Running", out["status_counts"])

	def test_overview_counts_replies_after_the_start(self):
		doc = self.started()
		wa = [r for r in self.rows(doc.name) if r.channel == "WhatsApp"][0].name
		frappe.db.set_value(R, wa, {"status": "Sent", "sent_at": now_datetime()})
		self.assertEqual(analytics.replied_counts(doc.name)["WhatsApp"], 0)
		with patch.object(frappe.db, "sql", wraps=frappe.db.sql):
			frappe.get_doc({"doctype": "Communication", "communication_type": "Communication", "communication_medium": "Email", "sent_or_received": "Received", "subject": "re", "content": "yes", "sender": "asha.camp@example.com", "reference_doctype": "CRM Lead", "reference_name": self.leads[0].name}).insert(ignore_permissions=True)
		em = [r for r in self.rows(doc.name) if r.channel == "Email"][0].name
		frappe.db.set_value(R, em, {"status": "Sent", "sent_at": now_datetime()})
		self.assertEqual(analytics.replied_counts(doc.name)["Email"], 1)
		mine = [c for c in analytics.get_overview()["top_campaigns"] if c["name"] == doc.name][0]
		self.assertEqual(mine["replied"], 1)
		self.assertEqual(mine["reply_rate"], 50.0)  # 1 reply out of 2 sent messages

	def test_overview_date_range(self):
		self.started()
		self.assertEqual(analytics.get_overview("2000-01-01", "2000-01-02")["totals"]["recipients"], 0)
		self.assertGreaterEqual(analytics.get_overview(frappe.utils.nowdate(), frappe.utils.nowdate())["totals"]["recipients"], 2)

	def test_overview_only_covers_campaigns_the_user_may_see(self):
		doc = self.started()
		other = self.make_user("usr.ui@example.org", "Sales User")
		frappe.set_user(other.name)
		out = analytics.get_overview()
		self.assertNotIn(doc.name, [c["name"] for c in out["all_campaigns"]])
		self.assertNotIn(doc.name, [c["name"] for c in out["top_campaigns"]])
		mgr = self.make_user("mgr.ui@example.org", "Sales Manager")
		frappe.set_user(mgr.name)
		self.assertIn(doc.name, [c["name"] for c in analytics.get_overview()["all_campaigns"]])

	def test_overview_refuses_users_without_a_sales_role(self):
		stranger = self.make_user("stranger.ui@example.org", "Website Manager")
		frappe.set_user(stranger.name)
		with self.assertRaises(frappe.PermissionError):
			analytics.get_overview()

	def test_campaign_analytics_has_a_timeline_and_reply_numbers(self):
		doc = self.started()
		out = analytics.get_analytics(doc.name)
		self.assertIn("timeline", out)
		self.assertEqual(set(out["replied"]), {"Email", "WhatsApp"})


class TestDateRanges(UiApi):
	"""One date-range rule for every report: whole days in the site time zone, the end day included in full."""

	def setUp(self):
		super().setUp()
		self.today = frappe.utils.nowdate()
		self.yesterday = frappe.utils.add_days(self.today, -1)
		self.doc = self.make_campaign(("Email",), leads=[self.leads[0]], campaign_name="Range Camp")
		self.run_launch(self.doc)
		self.row = self.rows(self.doc.name)[0].name

	def mine(self, out):
		return [c for c in out["all_campaigns"] if c["name"] == self.doc.name]

	def test_date_range_helper_is_inclusive_and_swaps_reversed_ranges(self):
		self.assertEqual(common.date_range("2026-03-01", "2026-03-31"), ("2026-03-01 00:00:00", "2026-04-01 00:00:00"))
		self.assertEqual(common.date_range("2026-03-31", "2026-03-01"), ("2026-03-01 00:00:00", "2026-04-01 00:00:00"))
		self.assertEqual(common.date_range(None, "2026-12-31"), (None, "2027-01-01 00:00:00"))
		self.assertEqual(common.date_range(None, None), (None, None))

	def test_overview_includes_the_last_instant_of_the_end_day(self):
		frappe.db.set_value(R, self.row, {"status": "Sent", "sent_at": f"{self.today} 23:59:59.500000"})
		self.assertEqual(self.mine(analytics.get_overview(self.today, self.today))[0]["sent"], 1)
		self.assertEqual(analytics.get_overview(self.today, self.today)["by_day"][-1]["date"], self.today)
		self.assertFalse(self.mine(analytics.get_overview(self.yesterday, self.yesterday)))
		self.assertEqual(self.mine(analytics.get_overview(self.yesterday, self.today))[0]["sent"], 1)
		self.assertEqual(self.mine(analytics.get_overview(self.today, self.yesterday))[0]["sent"], 1)  # reversed is swapped

	def test_overview_follows_when_a_message_was_sent_not_when_the_row_was_created(self):
		old = frappe.utils.add_days(self.today, -10)
		frappe.db.set_value(R, self.row, {"status": "Delivered", "sent_at": f"{old} 10:00:00"})
		last3 = analytics.get_overview(frappe.utils.add_days(self.today, -3), self.today)
		self.assertFalse(self.mine(last3))
		self.assertFalse([d for d in last3["by_day"] if d["date"] == old])
		around = analytics.get_overview(frappe.utils.add_days(old, -1), frappe.utils.add_days(old, 1))
		self.assertEqual(self.mine(around)[0]["sent"], 1)
		self.assertEqual([d["sent"] for d in around["by_day"] if d["date"] == old], [1])
		self.assertEqual(analytics.get_overview()["totals"]["sent"], analytics.get_overview("2000-01-01", self.today)["totals"]["sent"])

	def test_overview_status_chart_follows_the_range(self):
		out = analytics.get_overview("2000-01-01", "2000-01-02")
		self.assertNotIn(self.doc.status, out["status_counts"])
		self.assertEqual(out["totals"]["campaigns"], 0)
		self.assertTrue(analytics.get_overview(self.today, self.today)["status_counts"])

	def test_campaign_analytics_range(self):
		old = frappe.utils.add_days(self.today, -10)
		frappe.db.set_value(R, self.row, {"status": "Sent", "sent_at": f"{old} 08:00:00"})
		full = analytics.get_analytics(self.doc.name)
		self.assertEqual([m["value"] for m in full["channels"]["Email"] if m["key"] == "sent"], [1])
		miss = analytics.get_analytics(self.doc.name, self.yesterday, self.today)
		self.assertEqual(miss["channels"], {})
		self.assertEqual(miss["timeline"], [])
		self.assertEqual(miss["range"], {"from_date": self.yesterday, "to_date": self.today})
		hit = analytics.get_analytics(self.doc.name, old, old)
		self.assertEqual([m["value"] for m in hit["channels"]["Email"] if m["key"] == "sent"], [1])
		self.assertEqual([d["sent"] for d in hit["timeline"]], [1])
		self.assertEqual(api.get_analytics(self.doc.name, old, old)["timeline"], hit["timeline"])

	def test_recipient_report_range(self):
		old = frappe.utils.add_days(self.today, -10)
		frappe.db.set_value(R, self.row, {"status": "Sent", "sent_at": f"{old} 23:59:59.900000"})
		self.assertEqual(api.list_recipients(self.doc.name)["total"], 1)
		self.assertEqual(api.list_recipients(self.doc.name, from_date=old, to_date=old)["total"], 1)
		self.assertEqual(api.list_recipients(self.doc.name, from_date=self.yesterday, to_date=self.today)["total"], 0)
		self.assertEqual(api.list_recipients(self.doc.name, to_date=old)["rows"][0]["name"], self.row)

	def test_campaign_list_includes_the_whole_end_day(self):
		frappe.db.set_value(C, self.doc.name, "creation", f"{self.yesterday} 23:59:59.900000", update_modified=False)
		names = lambda **kw: {r.name for r in api.list_campaigns(page_length=100, **kw)["rows"]}  # noqa: E731
		self.assertIn(self.doc.name, names(from_date=self.yesterday, to_date=self.yesterday))
		self.assertNotIn(self.doc.name, names(from_date=self.today, to_date=self.today))

	def test_config_reports_the_site_clock(self):
		cfg = api.get_config()
		self.assertRegex(cfg["now"], r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$")
		self.assertEqual(cfg["now"][:10], self.today)


class TestCampaignList(UiApi):
	def test_rows_carry_channels_stats_audience_and_creator(self):
		doc = self.make_campaign(("Email", "WhatsApp"), leads=[self.leads[0]])
		with patch.object(common, "whatsapp_installed", return_value=True):
			self.run_launch(doc)
		em = [r for r in self.rows(doc.name) if r.channel == "Email"][0].name
		frappe.db.set_value(R, em, "status", "Read")
		row = [r for r in api.list_campaigns(search=doc.name and "Test Campaign")["rows"] if r.name == doc.name][0]
		self.assertEqual(row["channels"], ["Email", "WhatsApp"])
		self.assertEqual((row["stats"]["recipients"], row["stats"]["sent"], row["stats"]["opened"]), (2, 1, 1))
		self.assertEqual(row["audience"], "1 hand-picked leads")
		self.assertTrue(row["created_by"])

	def test_channel_status_sort_and_date_filters(self):
		email_only = self.make_campaign(("Email",), leads=[self.leads[0]], campaign_name="UIL Email")
		multi = self.make_campaign(("Email", "WhatsApp"), leads=[self.leads[0]], campaign_name="UIL Multi")
		names = lambda **kw: {r.name for r in api.list_campaigns(page_length=100, **kw)["rows"]}  # noqa: E731
		self.assertIn(email_only.name, names(channel="Email"))
		self.assertIn(multi.name, names(channel="Multi-channel"))
		self.assertNotIn(email_only.name, names(channel="Multi-channel"))
		self.assertNotIn(multi.name, names(channel="WhatsApp") - {multi.name})
		self.assertIn(multi.name, names(status="Draft", from_date=frappe.utils.nowdate(), to_date=frappe.utils.nowdate()))
		self.assertNotIn(multi.name, names(from_date="2000-01-01", to_date="2000-01-02"))
		ordered = [r.campaign_name for r in api.list_campaigns(search="UIL", sort="name")["rows"]]
		self.assertEqual(ordered, sorted(ordered))


class TestEmailTemplates(UiApi):
	def test_template_round_trip_keeps_table_html_and_builder_json(self):
		html = '<table role="presentation" width="100%" style="background-color:#f4f5f7;border-radius:8px"><tr><td style="padding:16px;font-family:Arial"><h1 style="margin:0">Hi {{ first_name }}</h1><a href="https://x.test" style="background:#1a73e8;color:#fff;border-radius:6px">Go</a></td></tr></table>'
		out = api.save_email_template({"template_name": "UI Round Trip", "subject": "S", "body_html": html, "category": "Promotion", "editor_mode": "Visual Builder", "builder_json": [{"type": "heading"}]})
		saved = api.get_email_template(out["name"])
		self.assertIn("background-color:#f4f5f7", saved["body_html"])
		self.assertIn("border-radius:6px", saved["body_html"])
		self.assertIn("<table", saved["body_html"])
		self.assertEqual((saved["category"], saved["editor_mode"]), ("Promotion", "Visual Builder"))
		self.assertEqual(json.loads(saved["builder_json"]), [{"type": "heading"}])

	def test_list_filters_and_usage(self):
		api.save_email_template({"template_name": "UI Newsletter", "subject": "S", "body_html": "<p>x</p>", "category": "Newsletter"})
		self.make_campaign()
		rows = {r.name: r for r in api.list_email_templates()}
		self.assertEqual(rows["UI Newsletter"]["used_in"], 0)
		self.assertEqual(rows[self.tpl.name]["used_in"], 1)
		found = api.list_email_templates(category="Newsletter")
		self.assertIn("UI Newsletter", [r.name for r in found])
		self.assertTrue(all(r.category == "Newsletter" for r in found))
		self.assertIn("UI Newsletter", [r.name for r in api.list_email_templates(search="newsl")])
		self.assertNotIn("UI Newsletter", [r.name for r in api.list_email_templates(enabled=0)])

	def test_delete_refuses_a_template_in_use_but_removes_an_unused_one(self):
		self.make_campaign()
		with self.assertRaises(frappe.ValidationError):
			api.delete_email_template(self.tpl.name)
		api.save_email_template({"template_name": "UI Unused", "subject": "S", "body_html": "<p>x</p>"})
		self.assertTrue(api.delete_email_template("UI Unused"))
		self.assertFalse(frappe.db.exists("CRM Campaign Email Template", "UI Unused"))

	def test_duplicate_keeps_category_and_builder_blocks(self):
		api.save_email_template({"template_name": "UI Orig", "subject": "S", "body_html": "<p>x</p>", "category": "Event", "editor_mode": "Rich Text", "builder_json": "[]"})
		copy = api.duplicate_email_template("UI Orig")
		self.assertEqual((copy["category"], copy["editor_mode"]), ("Event", "Rich Text"))
		self.assertNotEqual(copy["name"], "UI Orig")

	def test_only_managers_write_templates_but_sales_users_can_list(self):
		user = self.make_user("usr.ui@example.org", "Sales User")
		frappe.set_user(user.name)
		self.assertTrue(api.list_email_templates())
		for call in (
			lambda: api.save_email_template({"template_name": "Nope", "subject": "S", "body_html": "x"}),
			lambda: api.delete_email_template(self.tpl.name),
			lambda: api.duplicate_email_template(self.tpl.name),
		):
			with self.assertRaises(frappe.PermissionError):
				call()

	def test_unknown_category_and_editor_are_rejected(self):
		for bad in ({"category": "Spam"}, {"editor_mode": "Magic"}):
			with self.assertRaises(frappe.ValidationError):
				api.save_email_template({"template_name": "UI Bad", "subject": "S", "body_html": "x", **bad})

	def test_template_attachments_are_attached_and_replaced(self):
		f1, f2 = self.make_file(b"first", name="a.txt"), self.make_file(b"second", name="b.txt")
		out = api.save_email_template({"template_name": "UI Files", "subject": "S", "body_html": "<p>x</p>", "attachments": [f1.file_url]})
		self.assertEqual([a["file_name"] for a in out["attachments"]], ["a.txt"])
		out = api.save_email_template({"template_name": "UI Files", "subject": "S", "body_html": "<p>x</p>", "attachments": [f2.file_url]}, name="UI Files")
		self.assertEqual([a["file_name"] for a in out["attachments"]], ["b.txt"])

	def test_render_preview_uses_sample_data_and_reports_unknown_variables(self):
		out = api.render_email_preview("Hi {{ first_name }} {{ nope }}", "<p>{{ organization }} by {{ sender_name }}</p>")
		self.assertTrue(out["lead"]["sample"])
		self.assertTrue(out["subject"].startswith("Hi Siddharth"))  # the demo lead everywhere is Siddharth Singh
		self.assertEqual(out["lead"]["lead_name"], "Siddharth Singh")
		self.assertIn("Acme Learning", out["html"])
		self.assertEqual(out["unknown"], ["nope"])
		real = api.render_email_preview("Hi {{ first_name }}", "<p>x</p>", self.leads[0].name)
		self.assertEqual((real["subject"], real["lead"]["sample"]), ("Hi Asha", False))
		self.assertEqual(api.render_email_template(self.tpl.name, self.leads[0].name)["subject"], "Hello Asha")


class TestTestEmail(UiApi):
	def send(self, emails="me@example.com", **kw):
		kw.setdefault("subject", "Hello {{ first_name }}")
		kw.setdefault("html", "<p>Hi {{ first_name }}</p>")
		with patch.object(frappe, "sendmail", autospec=True) as mail:
			out = api.send_test_email(emails, **kw)
		return out, mail

	def test_sends_only_to_the_given_addresses_with_a_test_subject(self):
		before = (frappe.db.count(R), frappe.db.count("Communication"))
		out, mail = self.send("a@example.com, B@Example.com a@example.com")
		kw = mail.call_args.kwargs
		self.assertEqual(kw["recipients"], ["a@example.com", "b@example.com"])
		self.assertEqual(kw["subject"], "[Test] Hello Siddharth")
		self.assertIn("Hi Siddharth", kw["message"])
		self.assertFalse(kw["delayed"])
		self.assertNotIn("unsubscribe_method", kw)
		self.assertEqual(out["sent"], 2)
		self.assertEqual(before, (frappe.db.count(R), frappe.db.count("Communication")))  # no recipient rows, no timeline entry

	def test_uses_a_saved_template_and_a_real_lead(self):
		out, mail = self.send(subject=None, html=None, email_template=self.tpl.name, lead=self.leads[0].name)
		self.assertEqual(mail.call_args.kwargs["subject"], "[Test] Hello Asha")
		self.assertFalse(out["lead"]["sample"])

	def test_limits_and_validation(self):
		with self.assertRaises(frappe.ValidationError):
			self.send(", ".join(f"u{i}@example.com" for i in range(11)))
		with self.assertRaises(frappe.ValidationError):
			self.send("not-an-email")
		with self.assertRaises(frappe.ValidationError):
			self.send("")
		with self.assertRaises(frappe.ValidationError):
			self.send(subject="", html="")
		with self.assertRaises(frappe.ValidationError):
			self.send(subject="{{ nonsense }}")

	def test_hourly_budget_per_user(self):
		with patch.object(api, "TEST_EMAIL_PER_HOUR", 3):
			self.send("a@example.com, b@example.com")
			with self.assertRaises(frappe.ValidationError):
				self.send("c@example.com, d@example.com")

	def test_a_mail_failure_is_reported_not_swallowed(self):
		with patch.object(frappe, "sendmail", side_effect=Exception("SMTP refused")), self.assertRaises(frappe.ValidationError) as ctx:
			api.send_test_email("a@example.com", subject="S", html="<p>x</p>")
		self.assertIn("SMTP refused", str(ctx.exception))

	def test_refuses_users_without_a_sales_role(self):
		stranger = self.make_user("stranger.ui2@example.org", "Website Manager")
		frappe.set_user(stranger.name)
		with self.assertRaises(frappe.PermissionError):
			self.send()

	def test_attachments_are_sent_and_size_limited(self):
		f = self.make_file(b"x" * 100)
		_out, mail = self.send(attachments=[f.file_url])
		self.assertEqual(mail.call_args.kwargs["attachments"], [{"fid": f.name}])
		with patch.object(common, "attachment_limit_bytes", return_value=50), self.assertRaises(frappe.ValidationError):
			self.send(attachments=[f.file_url])
		with self.assertRaises(frappe.ValidationError):
			self.send(attachments=["/private/files/missing.pdf"])


class TestAttachments(UiApi):
	def step(self, urls):
		return {"channel": "Email", "email_template": self.tpl.name, "attachments": json.dumps(urls)}

	def test_step_attachments_are_validated_and_saved(self):
		f = self.make_file()
		out = api.save_campaign({"campaign_name": "With file", "steps": [self.step([f.file_url, f.file_url])]})
		self.assertEqual(json.loads(out["steps"][0]["attachments"]), [f.file_url])

	def test_missing_oversize_and_whatsapp_attachments_are_refused(self):
		f = self.make_file(b"x" * 100)
		with self.assertRaises(frappe.ValidationError):
			api.save_campaign({"campaign_name": "x", "steps": [self.step(["/private/files/none.pdf"])]})
		with patch.object(common, "attachment_limit_bytes", return_value=50), self.assertRaises(frappe.ValidationError):
			api.save_campaign({"campaign_name": "x", "steps": [self.step([f.file_url])]})
		with self.assertRaises(frappe.ValidationError):
			api.save_campaign({"campaign_name": "x", "steps": [{"channel": "WhatsApp", "wa_template": "T", "attachments": json.dumps([f.file_url])}]})

	def test_attachment_limit_defaults_to_10_mb(self):
		self.assertEqual(common.attachment_limit_bytes(), 10 * 1024 * 1024)

	def test_the_email_sender_attaches_step_and_template_files(self):
		step_file, tpl_file = self.make_file(b"step", name="step.txt"), self.make_file(b"tpl", name="tpl.txt")
		api.save_email_template({"template_name": self.tpl.name, "subject": self.tpl.subject, "body_html": self.tpl.body_html, "attachments": [tpl_file.file_url]}, name=self.tpl.name)
		frappe.clear_document_cache("CRM Campaign Email Template", self.tpl.name)
		doc = self.make_campaign(leads=[self.leads[0]], steps=[self.step([step_file.file_url])])
		self.run_launch(doc)
		with patch.object(frappe, "sendmail", autospec=True, side_effect=lambda **kw: self.fake_send()) as mail:
			engine.send_batch(doc.name, self.claim_all(doc))
		sent = {a["fid"] for a in mail.call_args.kwargs["attachments"]}
		self.assertEqual(sent, {step_file.name, tpl_file.name})

	def test_an_oversize_attachment_fails_that_message_instead_of_sending(self):
		f = self.make_file(b"x" * 100)
		doc = self.make_campaign(leads=[self.leads[0]], steps=[self.step([f.file_url])])
		self.run_launch(doc)
		with patch.object(common, "attachment_limit_bytes", return_value=50), patch.object(frappe, "sendmail", autospec=True) as mail:
			engine.send_batch(doc.name, self.claim_all(doc))
		mail.assert_not_called()
		self.assertEqual(self.rows(doc.name)[0].status, "Failed")

	def test_duplicate_keeps_step_attachments(self):
		f = self.make_file()
		doc = api.save_campaign({"campaign_name": "Dup files", "steps": [self.step([f.file_url])]})
		copy = api.duplicate_campaign(doc["name"])
		self.assertEqual(json.loads(copy["steps"][0]["attachments"]), [f.file_url])


class TestSegmentsAndInsight(UiApi):
	def view(self, label="UI View", user=None, public=0, filters=None):
		return frappe.get_doc({"doctype": "CRM View Settings", "label": label, "dt": "CRM Lead", "type": "list", "user": user or "Administrator", "public": public, "filters": json.dumps(filters or {"last_name": ["like", "%Camp%"]})}).insert(ignore_permissions=True)

	def test_list_segments_gives_rules_and_counts(self):
		v = self.view()
		row = [r for r in api.list_segments() if r.name == str(v.name)][0]
		self.assertEqual(row["rules"], [["last_name", "like", "%Camp%"]])
		self.assertGreaterEqual(row["count"], 3)
		self.assertTrue(row["mine"])

	def test_saved_segments_respect_ownership(self):
		self.make_user("someone.else@example.org", "Sales User")
		private = self.view("UI Private", user="someone.else@example.org")
		public = self.view("UI Public", user="someone.else@example.org", public=1)
		names = {r.name for r in api.list_segments(with_counts=0)}
		self.assertNotIn(str(private.name), names)
		self.assertIn(str(public.name), names)

	def test_save_and_delete_a_segment(self):
		out = api.save_segment("UI Saved", [["name", "=", self.leads[0].name]])
		view = frappe.get_doc("CRM View Settings", out["name"])
		self.assertEqual((view.dt, view.user, view.public), ("CRM Lead", "Administrator", 0))
		self.assertEqual(audience.count({"mode": "Saved Segment", "saved_view": view.name}), 1)
		with self.assertRaises(frappe.ValidationError):
			api.save_segment("", [["last_name", "=", "Camp"]])
		with self.assertRaises(frappe.ValidationError):
			api.save_segment("Bad", [["not_a_field", "=", "x"]])
		with self.assertRaises(frappe.ValidationError):
			api.save_segment("UI Saved", [["name", "=", self.leads[0].name]])  # the same name twice
		self.assertTrue(api.delete_segment(view.name))

	def test_a_user_cannot_delete_someone_elses_segment_or_make_a_public_one(self):
		self.make_user("someone.else@example.org", "Sales User")
		v = self.view("UI Others", user="someone.else@example.org", public=1)
		user = self.make_user("usr.ui@example.org", "Sales User")
		frappe.set_user(user.name)
		with self.assertRaises(frappe.PermissionError):
			api.delete_segment(v.name)
		out = api.save_segment("UI Mine", [["last_name", "=", "Camp"]], public=1)
		self.assertEqual(frappe.db.get_value("CRM View Settings", out["name"], "public"), 0)  # only managers publish

	def test_audience_insight_explains_every_exclusion(self):
		definition = {"mode": "Selected Records", "selected": json.dumps([l.name for l in self.leads])}
		out = api.audience_insight(definition, ["Email", "WhatsApp"])
		self.assertEqual(out["count"], 3)
		by = {r["first_name"]: r["eligibility"] for r in out["rows"]}
		self.assertTrue(by["Asha"]["Email"]["ok"] and by["Asha"]["WhatsApp"]["ok"])
		self.assertEqual(by["Bina"]["Email"]["reason"], "Missing email")
		self.assertEqual(by["Chet"]["WhatsApp"]["reason"], "Invalid WhatsApp number")
		self.assertEqual(out["summary"]["total"], 3)
		self.assertEqual(out["summary"]["Email"]["eligible"], 2)
		self.assertEqual(out["summary"]["Email"]["reasons"], {"Missing email": 1})
		self.assertIsNone(api.audience_insight(definition, ["Email"], with_summary=0)["summary"])

	def test_audience_insight_shows_opt_outs(self):
		optout.add_opt_out("Email", "asha.camp@example.com", reason="test")
		out = api.audience_insight({"mode": "Selected Records", "selected": json.dumps([self.leads[0].name])}, ["Email"])
		self.assertEqual(out["rows"][0]["eligibility"]["Email"]["reason"], "Opted out")

	def test_field_value_suggestions_only_for_link_fields(self):
		self.assertEqual(api.search_field_values("first_name", "A"), [])
		self.assertIsInstance(api.search_field_values("lead_owner", "Adm"), list)


class TestWhatsAppUi(UiApi):
	def make_template(self, name="ui_t1", status="APPROVED", **kw):
		t = frappe.new_doc("WhatsApp Templates")
		t.update({"name": name, "template_name": name, "actual_name": name, "template": "Hi {{1}}, welcome", "language_code": "en", "status": status, "sample_values": "Asha", "category": "MARKETING", "header_type": "IMAGE", "footer": "Reply STOP", "id": "123", **kw})
		t.db_insert()
		frappe.db.sql("INSERT INTO `tabWhatsApp Button` (name, parent, parenttype, parentfield, button_type, button_label, idx) VALUES (%s, %s, 'WhatsApp Templates', 'buttons', 'Quick Reply', 'Yes please', 1)", (frappe.generate_hash(length=10), name))
		return t

	def test_list_filters_and_describes_templates(self):
		self.make_template("ui_ok")
		self.make_template("ui_wait", status="PENDING", id=None)
		out = api.list_whatsapp_templates()
		self.assertTrue(out["installed"])
		rows = {r["name"]: r for r in out["rows"]}
		self.assertEqual((rows["ui_ok"]["state"], rows["ui_ok"]["approved"], rows["ui_ok"]["synced"]), ("APPROVED", True, True))
		self.assertFalse(rows["ui_wait"]["synced"])
		self.assertEqual(rows["ui_ok"]["placeholders"], [1])
		self.assertEqual(rows["ui_ok"]["buttons"][0]["button_label"], "Yes please")
		self.assertEqual(rows["ui_ok"]["samples"], ["Asha"])
		self.assertEqual({r["name"] for r in api.list_whatsapp_templates(status="pending")["rows"]} & {"ui_ok", "ui_wait"}, {"ui_wait"})
		self.assertIn("ui_ok", {r["name"] for r in api.list_whatsapp_templates(search="welcome", category="MARKETING")["rows"]})

	def test_sync_calls_frappe_whatsapps_own_fetch_and_is_manager_only(self):
		fetch = MagicMock(return_value="Successfully fetched templates from meta")
		with patch("frappe.get_attr", return_value=fetch):
			out = api.sync_whatsapp_templates()
		fetch.assert_called_once_with()
		self.assertIn("Successfully", out["message"])
		user = self.make_user("usr.ui@example.org", "Sales User")
		frappe.set_user(user.name)
		with patch("frappe.get_attr", return_value=fetch), self.assertRaises(frappe.PermissionError):
			api.sync_whatsapp_templates()
		self.assertFalse(api.list_whatsapp_templates()["can_sync"])

	def test_whatsapp_test_send_goes_to_one_number_and_creates_no_recipient(self):
		fake = MagicMock(message_id="wamid.T", name="WA-T-1")
		fake.name = "WA-T-1"
		tpl = frappe._dict(name="WA-T", status="APPROVED", template="Hi {{1}}", sample_values="x")
		before = frappe.db.count(R)
		step = {"channel": "WhatsApp", "wa_template": "WA-T", "variable_map": json.dumps({"1": "{{ first_name }}"})}
		with patch.object(channels.WhatsAppSender, "check_ready"), patch.object(channels.WhatsAppSender, "_template", return_value=tpl), patch.object(channels.WhatsAppSender, "account", return_value="Acct"), patch("frappe.new_doc", return_value=fake):
			out = api.send_test_whatsapp(step, "98765 43210")
		payload = fake.update.call_args.args[0]
		self.assertEqual((payload["to"], payload["template"]), ("919876543210", "WA-T"))
		self.assertEqual(json.loads(payload["body_param"]), {"1": "Siddharth"})  # sample lead
		self.assertEqual((out["sent"], out["message"]), (1, "WA-T-1"))
		self.assertEqual(before, frappe.db.count(R))
		with patch.object(channels.WhatsAppSender, "check_ready"), self.assertRaises(frappe.ValidationError):
			api.send_test_whatsapp(step, "12")
		with self.assertRaises(frappe.ValidationError):
			api.send_test_whatsapp({"channel": "Email"}, "919876543210")

	def test_whatsapp_test_send_budget_and_meta_errors(self):
		step = {"channel": "WhatsApp", "wa_template": "WA-T", "variable_map": "{}"}
		with patch.object(channels.WhatsAppSender, "check_ready"), patch.object(channels.WhatsAppSender, "send", side_effect=ChannelError("(#131030) number not allowed")):
			with self.assertRaises(frappe.ValidationError) as ctx:
				api.send_test_whatsapp(step, "919876543210")
			self.assertIn("131030", str(ctx.exception))
			with patch.object(api, "TEST_WHATSAPP_PER_HOUR", 1), self.assertRaises(frappe.ValidationError):
				api.send_test_whatsapp(step, "919876543210")


class TestRecipientReport(UiApi):
	"""``list_recipients`` is one bounded query; it used to fetch every recipient name in the date range and send them
	all back as an ``IN (...)`` list."""

	def setUp(self):
		super().setUp()
		self.doc = self.make_campaign(("Email",), campaign_name="Report Camp")
		self.run_launch(self.doc)
		self.today = frappe.utils.nowdate()

	def test_pages_cover_every_row_exactly_once(self):
		first = api.list_recipients(self.doc.name, start=0, page_length=2)
		second = api.list_recipients(self.doc.name, start=2, page_length=2)
		self.assertEqual((len(first["rows"]), len(second["rows"]), first["total"], second["total"]), (2, 1, 3, 3))
		names = [r["name"] for r in first["rows"] + second["rows"]]
		self.assertEqual(len(set(names)), 3)

	def test_filters(self):
		self.assertEqual([r["recipient_name"] for r in api.list_recipients(self.doc.name, status="Skipped")["rows"]], ["Bina Camp"])
		self.assertEqual(api.list_recipients(self.doc.name, search="asha")["total"], 1)
		self.assertEqual(api.list_recipients(self.doc.name, channel="WhatsApp")["total"], 0)
		self.assertEqual(api.list_recipients(self.doc.name, channel="Email", status="Pending")["total"], 2)

	def test_date_range_is_applied_in_the_query_without_fetching_names(self):
		rows = self.rows(self.doc.name)
		old = frappe.utils.add_days(self.today, -10)
		frappe.db.set_value(R, rows[0].name, {"status": "Sent", "sent_at": f"{old} 09:00:00"})
		with patch.object(frappe.db, "sql_list", side_effect=AssertionError("the range must not load recipient names")):
			today = api.list_recipients(self.doc.name, from_date=self.today, to_date=self.today)
			then = api.list_recipients(self.doc.name, from_date=old, to_date=old)
			everything = api.list_recipients(self.doc.name)
		self.assertEqual((today["total"], then["total"], everything["total"]), (2, 1, 3))
		self.assertEqual([r["name"] for r in then["rows"]], [rows[0].name])
		self.assertEqual(then["rows"][0]["status"], "Sent")

	def test_a_page_is_never_bigger_than_200_and_a_negative_start_is_zero(self):
		out = api.list_recipients(self.doc.name, page_length=100000, start=-5)
		self.assertEqual((len(out["rows"]), out["total"]), (3, 3))

	def test_columns_the_report_shows_are_all_there(self):
		row = api.list_recipients(self.doc.name, page_length=1)["rows"][0]
		for column in ("name", "recipient_id", "recipient_name", "channel", "status", "email", "skip_reason", "failure_reason", "step_idx", "sent_at", "read_at", "provider_status"):
			self.assertIn(column, row)

	def test_someone_who_may_not_see_the_campaign_gets_nothing(self):
		outsider = self.make_user("outsider.report@example.org", "Sales User")
		frappe.set_user(outsider.name)
		with self.assertRaises(frappe.PermissionError):
			api.list_recipients(self.doc.name)


class TestWhatsAppTimeLimit(Campaigns):
	def setUp(self):
		super().setUp()
		self.doc = self.make_campaign(("WhatsApp",), leads=[self.leads[0]])
		self.run_launch(self.doc)
		self.tpl = frappe._dict(name="WA-T", status="APPROVED", template="Hi {{1}}")

	def send(self, insert):
		fake = MagicMock()
		fake.message_id = "wamid.ABC"
		fake.name = "WA-MSG-1"
		fake.insert.side_effect = insert
		with patch.object(channels.WhatsAppSender, "_template", return_value=self.tpl), patch.object(
			channels.WhatsAppSender, "account", return_value="Acct"
		), patch("frappe.new_doc", return_value=fake):
			engine.send_batch(self.doc.name, engine._claim(self.doc.name, 100))
		return frappe.get_doc(R, self.rows(self.doc.name)[0].name)

	def test_the_call_to_meta_is_made_with_a_time_limit_and_the_limit_is_lifted_afterwards(self):
		seen = []
		original = requests.sessions.Session.request
		self.send(lambda **kw: seen.append((guard._HTTP_USERS, requests.sessions.Session.request is not original)))
		self.assertEqual(seen, [(1, True)])  # limited while frappe_whatsapp talks to Meta ...
		self.assertEqual(guard._HTTP_USERS, 0)  # ... and only then
		self.assertIs(requests.sessions.Session.request, original)

	def test_a_read_timeout_is_failed_not_retried_because_meta_may_have_accepted_it(self):
		row = self.send(requests.exceptions.ReadTimeout("HTTPSConnectionPool(host='graph.facebook.com', port=443): Read timed out. (read timeout=30)"))
		self.assertEqual((row.status, row.retry_count), ("Failed", 0))
		self.assertIn("timed out", row.failure_reason)

	def test_a_connect_timeout_is_retried_because_nothing_reached_meta(self):
		row = self.send(requests.exceptions.ConnectTimeout("HTTPSConnectionPool(host='graph.facebook.com', port=443): Max retries exceeded with url: /v17.0/1/messages (Caused by ConnectTimeoutError)"))
		self.assertEqual((row.status, row.retry_count), ("Pending", 1))


class TestShortLivedCaches(UiApi):
	"""The heavy read-only numbers are reused for a few seconds; a launch never uses them."""

	def setUp(self):
		super().setUp()
		frappe.flags.in_test = False  # caching is skipped while testing, so these tests switch it on
		self.addCleanup(setattr, frappe.flags, "in_test", True)
		guard.forget_cached()
		self.addCleanup(guard.forget_cached)

	def definition(self):
		return {"mode": "Selected Records", "selected": [lead.name for lead in self.leads]}

	def test_the_audience_scan_is_reused_while_the_audience_is_being_edited(self):
		with patch.object(audience, "summary", return_value={"total": 3, "Email": {"eligible": 2, "reasons": {}}}) as scan:
			for _i in range(3):
				api.audience_insight(self.definition(), ["Email"], 0, 0, 5, 1)
		self.assertEqual(scan.call_count, 1)

	def test_a_different_audience_or_a_different_person_is_a_different_scan(self):
		with patch.object(audience, "summary", return_value={"total": 0}) as scan:
			api.audience_insight(self.definition(), ["Email"], 0, 0, 5, 1)
			api.audience_insight({"mode": "Selected Records", "selected": [self.leads[0].name]}, ["Email"], 0, 0, 5, 1)
			frappe.set_user(self.owner.name)
			api.audience_insight(self.definition(), ["Email"], 0, 0, 5, 1)
		self.assertEqual(scan.call_count, 3)

	def test_launching_always_scans_afresh(self):
		doc = self.make_campaign(("Email",))
		with patch.object(audience, "summary", wraps=audience.summary) as scan:
			engine.validate_ready(frappe.get_doc(C, doc.name))
			engine.validate_ready(frappe.get_doc(C, doc.name))
		self.assertEqual(scan.call_count, 2)

	def test_reply_counts_are_reused_for_a_minute_per_campaign_and_range(self):
		started = now_datetime()
		with patch.object(analytics, "_replied_counts", return_value={"Email": 1, "WhatsApp": 0}) as lookup:
			analytics.replied_counts("CAMP-A", started)
			analytics.replied_counts("CAMP-A", started)
			analytics.replied_counts("CAMP-B", started)
			analytics.replied_counts("CAMP-A", started, "2026-01-01", "2026-01-31")
		self.assertEqual(lookup.call_count, 3)

	def test_a_campaign_that_has_not_started_has_no_replies_and_costs_nothing(self):
		with patch.object(analytics, "_replied_counts") as lookup:
			self.assertEqual(analytics.replied_counts("CAMP-X", None), {"Email": 0, "WhatsApp": 0})
		lookup.assert_not_called()


class TestGuards(unittest.TestCase):
	def test_cached_read_is_skipped_while_testing(self):
		self.addCleanup(setattr, frappe.flags, "in_test", frappe.flags.in_test)
		frappe.flags.in_test = True
		calls = []
		for _i in range(2):
			common.cached_read("t", "k", 30, lambda: calls.append(1))
		self.assertEqual(len(calls), 2)


class TestDiagnostics(UiApi):
	"""The temporary logging: it writes, it can be switched off, and it never changes what the app does."""

	def setUp(self):
		super().setUp()
		frappe.flags.crm_addons_debug_in_test = True  # the diagnostics stay silent in other tests
		self.addCleanup(frappe.flags.pop, "crm_addons_debug_in_test", None)

	def test_an_event_reaches_the_debug_log_and_a_manager_can_read_it(self):
		debuglog.log("DIAGNOSTIC-TEST-MARKER", campaign="CAMP-1")
		out = debuglog.tail(400)
		self.assertIn("DIAGNOSTIC-TEST-MARKER campaign=CAMP-1", out["lines"])
		self.assertTrue(out["path"].endswith("crm_addons_debug.log"))

	def test_the_log_can_only_be_read_by_a_system_manager(self):
		self.addCleanup(setattr, frappe.flags, "in_test", frappe.flags.in_test)
		frappe.flags.in_test = False  # Frappe's only_for() lets everyone through while tests run; check it for real
		frappe.set_user(self.owner.name)
		with self.assertRaises(frappe.PermissionError):
			debuglog.tail()

	def test_the_browsers_report_is_written(self):
		out = debuglog.client_log([{"l": "WARN", "m": "MAIN THREAD WAS BLOCKED for about 4200 ms", "x": "click button Launch"}], page="/campaigns", session="s1")
		self.assertTrue(out["enabled"])
		lines = debuglog.tail(400)["lines"]
		self.assertIn("CLIENT page=/campaigns session=s1 MAIN THREAD WAS BLOCKED for about 4200 ms", lines)
		self.assertIn("click button Launch", lines)

	def test_switched_off_it_writes_nothing_and_tells_the_browser(self):
		with patch.dict(frappe.conf, {"crm_addons_debug_log": 0}):
			self.assertFalse(debuglog.enabled())
			debuglog.log("SHOULD-NOT-BE-WRITTEN")
			self.assertEqual(debuglog.client_log([{"m": "x"}]), {"enabled": False})
		self.assertNotIn("SHOULD-NOT-BE-WRITTEN", debuglog.tail(400)["lines"])

	def test_a_traced_job_keeps_its_result_and_its_error(self):
		@debuglog.traced("test.job")
		def job(campaign, rows=None):
			if campaign == "bad":
				raise ValueError("kaboom")
			return len(rows or [])

		self.assertEqual(job("ok", rows=[1, 2, 3]), 3)
		with self.assertRaises(ValueError):
			job("bad")
		lines = debuglog.tail(400)["lines"]
		self.assertIn("START test.job campaign=ok rows=3", lines)
		self.assertIn("FAILED test.job", lines)

	def test_the_dispatch_job_is_still_the_same_function_for_the_scheduler(self):
		self.assertEqual(engine.dispatch.__name__, "dispatch")
		self.assertTrue(callable(frappe.get_attr("crm_addons.campaigns.engine.dispatch")))
		self.assertTrue(callable(frappe.get_attr("crm_addons.campaigns.engine.send_batch")))

	def page(self, html=b"<html><body>CRM</body></html>"):
		store = {"body": html}
		return types.SimpleNamespace(
			status_code=200, direct_passthrough=False, headers={"Content-Type": "text/html; charset=utf-8"},
			get_data=lambda: store["body"], set_data=lambda data: store.update(body=data), store=store,
		), types.SimpleNamespace(path="/crm/leads")

	def test_the_crm_page_gets_the_diagnostics_before_the_add_on_script(self):
		response, request = self.page()
		inject.add_addon_script(response, request)
		body = response.store["body"].decode()
		self.assertIn("/assets/crm_addons/debug.js?v=", body)
		self.assertLess(body.index("debug.js"), body.index("addons.js"))

	def test_the_crm_page_has_no_diagnostics_when_switched_off(self):
		response, request = self.page()
		with patch.dict(frappe.conf, {"crm_addons_debug_log": 0}):
			inject.add_addon_script(response, request)
		body = response.store["body"].decode()
		self.assertNotIn("debug.js", body)
		self.assertIn("addons.js", body)
