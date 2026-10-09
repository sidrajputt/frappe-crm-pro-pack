# Copyright (c) 2026, Coding Pro
"""Tests for click tracking, sending hours, lead-update rules, list clean-up, health alerts, per-step pause, automatic
campaigns, cost / ROI and the calendar.

Run on a bench:  bench --site <site> run-tests --app crm_addons --module crm_addons.campaigns.doctype.crm_campaign.test_campaign_growth
"""

import json
from datetime import datetime, timezone
from unittest.mock import patch
from urllib.parse import parse_qs, urlparse

import frappe
from frappe.utils import add_days, add_to_date, now_datetime, nowdate

from crm_addons.campaigns import analytics, api, audience, common, engine, health, hygiene, journey, optout, roi, rules, schedule_view, tracking, triggers
from crm_addons.campaigns.doctype.crm_campaign.test_crm_campaign import C, Campaigns, R

LINK = "https://example.com/offer?a=1&b=2"


def cfg(**values):
	for key, value in values.items():
		frappe.db.set_single_value("CRM Addons Settings", key, value)
	frappe.clear_document_cache("CRM Addons Settings", "CRM Addons Settings")


class Growth(Campaigns):
	def setUp(self):
		super().setUp()
		# not a "Lost" status: CRM refuses to save those without a lost reason
		self.statuses = frappe.get_all("CRM Lead Status", filters={"type": ["!=", "Lost"]}, pluck="name", order_by="creation asc")
		self.assertGreaterEqual(len(self.statuses), 2, "the test site needs the CRM lead statuses")
		p = patch.object(health, "email_account_problem", return_value=None)  # the test site has no outgoing mail account
		p.start()
		self.addCleanup(p.stop)
		# a swallowed exception is a bug that tests would otherwise never see. The base class replaces ``frappe.log_error``
		# (it commits), so nothing of ours may call it unless the test provokes an error itself. (Frappe's own calls, such as a
		# welcome e-mail it cannot send to a new test user, are not ours.)
		def ours():
			return [c for c in self.log_error.call_args_list if any(k in str(c) for k in ("CRM Campaign", "CRM Automation", "CRM Add-ons"))]

		self.addCleanup(lambda: self.assertEqual(ours(), [], "unexpected Error Log entry"))
		self.linked = frappe.get_doc(
			{"doctype": "CRM Campaign Email Template", "template_name": "Linked Template", "subject": "Offer", "body_html": f'<p>See <a href="{LINK.replace("&", "&amp;")}">the offer</a> or <a href="mailto:a@b.co">mail</a> <a href="#top">top</a></p>', "enabled": 1}
		).insert(ignore_permissions=True)

	def sent_row(self, doc, lead=None, status="Sent"):
		"""One Email recipient row of the campaign, marked as sent a moment ago."""
		lead = lead or self.leads[0]
		name = frappe.get_all(R, filters={"campaign": doc.name, "recipient_id": lead.name, "channel": "Email"}, pluck="name")[0]
		frappe.db.set_value(R, name, {"status": status, "sent_at": now_datetime(), "email_queue": ""})
		return name

	def running(self, **kw):
		kw.setdefault("steps", [{"channel": "Email", "day_offset": 0, "email_template": self.linked.name}])
		doc = self.make_campaign(leads=[self.leads[0]], **kw)
		self.run_launch(doc)
		return doc


class TestClickTracking(Growth):
	def mailed(self, doc, **cfg_kw):
		names = engine._claim(doc.name, 50)
		sent = []
		with patch.object(frappe, "sendmail", autospec=True, side_effect=lambda **kw: sent.append(kw) or self.fake_send()):
			engine.send_batch(doc.name, names)
		return sent[0]

	def test_links_are_tracked_in_the_mailed_copy_and_the_lead_keeps_the_real_ones(self):
		doc = self.running()
		kw = self.mailed(doc)
		self.assertIn(tracking.METHOD, kw["message"])
		self.assertIn('href="mailto:a@b.co"', kw["message"])  # not a web link
		self.assertIn('href="#top"', kw["message"])
		self.assertNotIn("example.com/offer", kw["message"])  # the destination is only inside the signed token
		comm = frappe.get_doc("Communication", kw["communication"])
		self.assertIn("https://example.com/offer?a=1&amp;b=2", comm.content)
		self.assertNotIn(tracking.METHOD, comm.content)

	def test_tracking_can_be_switched_off_per_campaign(self):
		doc = self.running(track_clicks=0)
		self.assertNotIn(tracking.METHOD, self.mailed(doc)["message"])

	def test_the_unsubscribe_link_and_already_tracked_links_are_left_alone(self):
		body = f'<a href="https://x.test{optout.UNSUBSCRIBE_METHOD}?e=1">u</a><a href="javascript:alert(1)">j</a><a href="https://y.test/p">p</a>'
		out = tracking.rewrite_links(body, "REC1")
		self.assertIn(f"https://x.test{optout.UNSUBSCRIBE_METHOD}", out)
		self.assertIn("javascript:alert(1)", out)
		self.assertNotIn("https://y.test/p", out)
		self.assertEqual(tracking.rewrite_links(out, "REC1"), out)  # a second pass changes nothing

	def test_a_huge_unbalanced_document_is_rewritten_quickly(self):
		import time

		start = time.monotonic()
		tracking.rewrite_links("<a " * 40000 + '<a href="https://a.test/x">y</a>', "REC1")
		self.assertLess(time.monotonic() - start, 2)

	def test_a_click_is_recorded_counts_as_an_open_and_redirects(self):
		doc = self.running()
		row = self.sent_row(doc)
		query = parse_qs(urlparse(tracking.tracked_url(row, LINK)).query)
		frappe.local.response = frappe._dict()
		tracking.click(row, query["u"][0], query["s"][0])
		self.assertEqual(frappe.local.response["type"], "redirect")
		self.assertEqual(frappe.local.response["location"], LINK)
		rec = frappe.db.get_value(R, row, ["click_count", "clicked_at", "status", "read_at"], as_dict=True)
		self.assertEqual(rec.click_count, 1)
		self.assertTrue(rec.clicked_at and rec.read_at)
		self.assertEqual(rec.status, "Read")
		tracking.click(row, query["u"][0], query["s"][0])
		self.assertEqual(frappe.db.get_value(R, row, "click_count"), 2)
		report = tracking.click_report(doc.name)
		self.assertEqual((report["people"], report["clicks"]), (1, 2))
		self.assertEqual(report["links"][0]["url"], LINK)

	def test_a_forged_or_edited_link_is_refused_and_records_nothing(self):
		doc = self.running()
		row = self.sent_row(doc)
		query = parse_qs(urlparse(tracking.tracked_url(row, LINK)).query)
		other = tracking._encode("https://evil.test/")
		for r, u, s in ((row, other, query["s"][0]), (row, query["u"][0], "0" * 24), ("OTHER", query["u"][0], query["s"][0]), (row, "", ""), (None, None, None)):
			frappe.local.response = frappe._dict()
			tracking.click(r, u, s)
			self.assertNotEqual(frappe.local.response.get("type"), "redirect")
		self.assertEqual(frappe.db.get_value(R, row, "click_count"), 0)

	def test_clicks_show_up_in_the_campaign_numbers(self):
		doc = self.running()
		row = self.sent_row(doc)
		tracking.record(row, LINK)
		out = analytics.get_analytics(doc.name)
		email = {m["key"]: m["value"] for m in out["channels"]["Email"]}
		self.assertEqual(email["clicked"], 1)
		self.assertEqual(out["clicks"]["clicks"], 1)


class TestSendingHours(Growth):
	def campaign(self, **kw):
		return frappe._dict(window_enabled=1, window_start="09:00:00", window_end="18:00:00", timezone="Asia/Kolkata", window_weekdays_only=1, **kw)

	def utc(self, text):
		return datetime.strptime(text, "%Y-%m-%d %H:%M").replace(tzinfo=timezone.utc)

	def test_the_window_is_judged_in_the_campaigns_time_zone(self):
		c = self.campaign()
		self.assertTrue(journey.window_open(c, self.utc("2026-10-07 04:00")))  # Wednesday 09:30 in Kolkata
		self.assertFalse(journey.window_open(c, self.utc("2026-10-07 03:00")))  # 08:30
		self.assertFalse(journey.window_open(c, self.utc("2026-10-07 13:00")))  # 18:30
		self.assertFalse(journey.window_open(c, self.utc("2026-10-10 05:00")))  # Saturday
		self.assertTrue(journey.window_open(frappe._dict(window_enabled=0), self.utc("2026-10-10 05:00")))

	def test_it_says_when_the_hours_next_begin(self):
		c = self.campaign()
		nxt = journey.next_open(c, self.utc("2026-10-09 13:00"))  # Friday evening
		self.assertEqual(nxt.strftime("%Y-%m-%d %H:%M"), "2026-10-12 09:00")  # Monday morning
		self.assertIsNone(journey.next_open(c, self.utc("2026-10-07 04:00")))

	def test_nothing_is_claimed_outside_the_hours_and_it_resumes_inside_them(self):
		doc = self.running()
		with patch("frappe.enqueue") as enq, patch.object(journey, "window_open", return_value=False):
			engine._dispatch_campaign(frappe.get_doc(C, doc.name))
		self.assertEqual(len(self.rows(doc.name, status="Pending")), 1)
		self.assertFalse(enq.called)
		with patch("frappe.enqueue") as enq, patch.object(journey, "window_open", return_value=True):
			engine._dispatch_campaign(frappe.get_doc(C, doc.name))
		self.assertEqual(len(self.rows(doc.name, status="Queued")), 1)

	def test_a_batch_in_flight_stops_when_the_hours_end(self):
		doc = self.make_campaign()
		self.run_launch(doc)
		names = engine._claim(doc.name, 50)
		with patch.object(journey, "window_open", side_effect=[True, False]), patch.object(frappe, "sendmail", autospec=True, side_effect=lambda **kw: self.fake_send()) as mail:
			engine.send_batch(doc.name, names)
		self.assertEqual(mail.call_count, 1)
		self.assertEqual(len(self.rows(doc.name, status="Pending")), 1)  # the rest waits for tomorrow

	def test_the_hours_must_end_after_they_begin(self):
		with self.assertRaises(frappe.ValidationError):
			self.make_campaign(window_enabled=1, window_start="18:00:00", window_end="09:00:00")
		doc = self.make_campaign(window_enabled=1, window_start="09:00:00", window_end="18:00:00")
		self.assertEqual(str(doc.window_start), "09:00:00")


class TestStepPause(Growth):
	def two_steps(self):
		doc = self.make_campaign(("Email", "WhatsApp"), leads=[self.leads[0]])
		with patch.object(common, "whatsapp_installed", return_value=True):
			self.run_launch(doc)
		return doc

	def test_a_paused_step_sends_nothing_while_the_others_carry_on(self):
		doc = self.two_steps()
		engine.set_step_paused(doc.name, 2, 1)
		with patch("frappe.enqueue"):
			engine._dispatch_campaign(frappe.get_doc(C, doc.name))
		self.assertEqual({r.channel for r in self.rows(doc.name, status="Queued")}, {"Email"})
		self.assertEqual({r.channel for r in self.rows(doc.name, status="Pending")}, {"WhatsApp"})
		engine.set_step_paused(doc.name, 2, 0)
		with patch("frappe.enqueue"):
			engine._dispatch_campaign(frappe.get_doc(C, doc.name))
		self.assertEqual(len(self.rows(doc.name, status="Pending")), 0)

	def test_pausing_after_a_row_was_claimed_puts_it_back_in_line(self):
		doc = self.two_steps()
		names = engine._claim(doc.name, 50)
		engine.set_step_paused(doc.name, 1, 1)
		with patch.object(frappe, "sendmail", autospec=True) as mail:
			engine.send_batch(doc.name, [n for n in names if frappe.db.get_value(R, n, "channel") == "Email"])
		self.assertFalse(mail.called)
		self.assertEqual(frappe.db.get_value(R, [n for n in names if frappe.db.get_value(R, n, "channel") == "Email"][0], "status"), "Pending")

	def test_only_a_started_campaign_can_have_a_step_paused(self):
		doc = self.make_campaign()
		with self.assertRaises(frappe.ValidationError):
			engine.set_step_paused(doc.name, 1, 1)
		with self.assertRaises(frappe.ValidationError):
			engine.set_step_paused(self.two_steps().name, 9, 1)


class TestLeadRules(Growth):
	def rule(self, event, action, value):
		return {"event": event, "action": action, "value": value}

	def test_a_click_sets_the_lead_status_once(self):
		target = self.statuses[-1]
		doc = self.running(rules=[self.rule("Clicked a link", "Set lead status", target)])
		row = self.sent_row(doc)
		tracking.record(row, LINK)
		self.assertEqual(frappe.db.get_value("CRM Lead", self.leads[0].name, "status"), target)
		frappe.db.set_value("CRM Lead", self.leads[0].name, "status", self.statuses[0])
		tracking.record(row, LINK)  # a second click is not a second event
		self.assertEqual(frappe.db.get_value("CRM Lead", self.leads[0].name, "status"), self.statuses[0])

	def test_a_reply_adds_a_note_once_and_stop_is_not_a_reply(self):
		doc = self.running(rules=[self.rule("Replied", "Add a note to the lead", "Wants a call")])
		self.sent_row(doc)

		def reply(text):
			frappe.get_doc({"doctype": "WhatsApp Message", "type": "Incoming", "reference_doctype": "CRM Lead", "reference_name": self.leads[0].name, "message": text, "from": "919876543210", "content_type": "text"}).db_insert()
			rules.on_whatsapp_message(frappe._dict(type="Incoming", reference_doctype="CRM Lead", reference_name=self.leads[0].name, message=text))

		notes = lambda: frappe.db.count("Comment", {"reference_doctype": "CRM Lead", "reference_name": self.leads[0].name, "content": ["like", "%Wants a call%"]})  # noqa: E731
		reply("STOP")
		self.assertEqual(notes(), 0)
		reply("yes please call me")
		self.assertEqual(notes(), 1)
		reply("hello?")
		self.assertEqual(notes(), 1)

	def test_an_email_reply_runs_the_rules(self):
		doc = self.running(rules=[self.rule("Replied", "Add a note to the lead", "Emailed back")])
		self.sent_row(doc)
		frappe.get_doc(
			{"doctype": "Communication", "communication_type": "Communication", "communication_medium": "Email", "sent_or_received": "Received", "subject": "Re: Offer", "content": "ok",
			 "sender": "asha.camp@example.com", "recipients": "me@example.com", "reference_doctype": "CRM Lead", "reference_name": self.leads[0].name}
		).insert(ignore_permissions=True)
		self.assertEqual(frappe.db.count("Comment", {"reference_doctype": "CRM Lead", "reference_name": self.leads[0].name, "content": ["like", "%Emailed back%"]}), 1)

	def test_a_follow_up_is_created_for_the_lead_owner(self):
		doc = self.running(rules=[self.rule("Opened or read", "Create a follow-up", "2")])
		row = self.sent_row(doc)
		engine.advance(row, "Read", read_at=now_datetime())
		fu = frappe.get_all("CRM Follow Up", filters={"reference_docname": self.leads[0].name}, fields=["mode", "assigned_to", "next_follow_up_on", "remark"])
		self.assertEqual(len(fu), 1)
		self.assertEqual((fu[0].mode, fu[0].assigned_to), ("Other", self.owner.name))
		self.assertGreater(fu[0].next_follow_up_on, add_to_date(now_datetime(), days=1))
		self.assertIn(doc.campaign_name, fu[0].remark)

	def test_a_bounce_runs_the_failed_rule_and_cleans_the_address(self):
		doc = self.running(rules=[self.rule("Failed or bounced", "Add a note to the lead", "Bounced mail")])
		row = self.sent_row(doc)
		engine.advance(row, "Failed", failure_reason="Bounced (reported by the mail provider)", provider_status="Bounced")
		self.assertEqual(frappe.db.count("Comment", {"reference_doctype": "CRM Lead", "reference_name": self.leads[0].name, "content": ["like", "%Bounced mail%"]}), 1)
		self.assertTrue(frappe.db.exists("CRM Campaign Opt Out", {"opt_key": "Email:asha.camp@example.com", "source": "Bounce"}))

	def test_an_opt_out_runs_the_rule(self):
		doc = self.running(rules=[self.rule("Opted out", "Add a note to the lead", "Unsubscribed")])
		self.sent_row(doc)
		optout.add_opt_out("Email", "asha.camp@example.com", source="Unsubscribe Link", lead=self.leads[0].name)
		self.assertEqual(frappe.db.count("Comment", {"reference_doctype": "CRM Lead", "reference_name": self.leads[0].name, "content": ["like", "%Unsubscribed%"]}), 1)

	def test_a_broken_rule_never_breaks_the_event(self):
		doc = self.running(rules=[self.rule("Clicked a link", "Add a note to the lead", "x")])
		row = self.sent_row(doc)
		with patch.object(rules, "_note", side_effect=RuntimeError("boom")), patch("frappe.log_error"):
			self.assertTrue(tracking.record(row, LINK))
		self.assertEqual(frappe.db.get_value(R, row, "click_count"), 1)

	def test_rules_are_validated(self):
		for bad in (self.rule("Clicked a link", "Set lead status", "No Such Status"), self.rule("Replied", "Create a follow-up", "abc"), self.rule("Replied", "Create a follow-up", "9999"), self.rule("Replied", "Add a note to the lead", "  "), self.rule("Nope", "Add a note to the lead", "x")):
			with self.assertRaises(frappe.ValidationError, msg=str(bad)):
				self.make_campaign(rules=[bad])
		with self.assertRaises(frappe.ValidationError):
			self.make_campaign(rules=[self.rule("Replied", "Add a note to the lead", "x"), self.rule("Replied", "Add a note to the lead", "x")])


class TestListCleanUp(Growth):
	def test_what_counts_as_a_dead_address(self):
		yes = [("Email", "Bounced (reported by the mail provider)", ""), ("Email", "", "Rejected"), ("Email", "(550, b'5.1.1 <a@b.co>: user unknown')", ""), ("Email", "", "Marked As Spam"),
		       ("WhatsApp", "(#131026) Message undeliverable", ""), ("WhatsApp", "The number is not a valid WhatsApp number", "")]
		no = [("Email", "Soft-Bounced (reported by the mail provider)", "Soft-Bounced"), ("Email", "mailbox full, try again later", ""), ("Email", "Connection timed out", ""),
		      ("WhatsApp", "rate limit hit (130429)", ""), ("WhatsApp", "Meta reported the message as failed (the webhook gives no further detail).", ""), ("Email", "", "")]
		for case in yes:
			self.assertTrue(hygiene.hard_failure(*case), case)
		for case in no:
			self.assertFalse(hygiene.hard_failure(*case), case)

	def test_a_bounced_address_is_skipped_by_later_campaigns(self):
		doc = self.running()
		row = self.sent_row(doc)
		engine.advance(row, "Failed", failure_reason="Bounced", provider_status="Bounced")
		row = audience.Evaluator(["Email"]).evaluate_page([frappe.get_doc("CRM Lead", self.leads[0].name)])[0][1]["Email"]
		self.assertEqual(row, ("asha.camp@example.com", "Opted out"))
		with self.assertRaises(frappe.ValidationError):  # nobody left who can receive it
			self.run_launch(self.make_campaign(leads=[self.leads[0]]))

	def test_a_soft_bounce_does_not_remove_the_address(self):
		doc = self.running()
		row = self.sent_row(doc)
		engine.advance(row, "Failed", failure_reason="Soft-Bounced (reported by the mail provider)", provider_status="Soft-Bounced")
		self.assertFalse(frappe.db.exists("CRM Campaign Opt Out", {"opt_key": "Email:asha.camp@example.com"}))

	def test_a_whatsapp_number_that_is_not_on_whatsapp_is_removed_after_a_failed_send(self):
		doc = self.make_campaign(("WhatsApp",), leads=[self.leads[0]])
		with patch.object(common, "whatsapp_installed", return_value=True):
			self.run_launch(doc)
		row = self.rows(doc.name)[0].name
		frappe.db.set_value(R, row, "status", "Sending")
		rec = frappe.get_doc(R, row)
		engine._fail(frappe.get_doc(C, doc.name), rec, "(#131026) Message undeliverable", False, "")
		self.assertTrue(frappe.db.exists("CRM Campaign Opt Out", {"opt_key": "WhatsApp:919876543210", "source": "Invalid Number"}))

	def test_past_failures_can_be_scanned_and_addresses_restored(self):
		doc = self.running()
		row = self.sent_row(doc)
		frappe.db.set_value(R, row, {"status": "Failed", "failed_at": now_datetime(), "failure_reason": "550 5.1.1 user unknown"})
		self.assertEqual(hygiene.scan_history(30), 1)
		self.assertEqual(hygiene.scan_history(30), 0)  # nothing new the second time
		page = hygiene.list_suppressed()
		self.assertEqual(page["total"], 1)
		self.assertEqual(page["rows"][0]["source"], "Bounce")
		self.assertTrue(hygiene.restore(page["rows"][0]["name"]))
		self.assertEqual(hygiene.list_suppressed()["total"], 0)

	def test_a_person_who_unsubscribed_cannot_be_restored_from_here(self):
		name = optout.add_opt_out("Email", "gone@example.com", source="Unsubscribe Link")
		with self.assertRaises(frappe.ValidationError):
			hygiene.restore(name)

	def test_only_managers_can_use_the_clean_up_endpoints(self):
		user = self.make_user("plain.sales@example.org", "Sales User")
		frappe.set_user(user.name)
		for call in (lambda: api.list_suppressed(), lambda: api.scan_failed_addresses(), lambda: api.restore_suppressed("x")):
			with self.assertRaises(frappe.PermissionError):
				call()


class TestHealthAlerts(Growth):
	def trouble(self, failed=2, sent=1, reason="Connection refused"):
		leads = [self.make_lead(f"Sam{i}", f"sam{i}.camp@example.com", f"98765{i}1234") for i in range(4)]
		doc = self.make_campaign(leads=leads)
		self.run_launch(doc)
		rows = frappe.get_all(R, filters={"campaign": doc.name, "status": "Pending"}, pluck="name")
		for i, name in enumerate(rows):
			if i < failed:
				frappe.db.set_value(R, name, {"status": "Failed", "failed_at": now_datetime(), "failure_reason": reason})
			elif i < failed + sent:
				frappe.db.set_value(R, name, {"status": "Sent", "sent_at": now_datetime()})
		cfg(campaign_alerts_enabled=1, campaign_alert_min_messages=2, campaign_alert_failure_percent=30)
		return frappe.get_doc(C, doc.name)

	def test_a_high_failure_rate_raises_one_alert_and_recovery_clears_it(self):
		doc = self.trouble()
		before = frappe.db.count("Notification Log", {"document_name": doc.name})
		self.assertTrue(health.check_campaign(doc))
		doc.reload()
		self.assertIn("failed", doc.health_note)
		self.assertEqual(frappe.db.count("Notification Log", {"document_name": doc.name}), before + 1)
		health.check_campaign(doc)  # the same problem again: no second notification
		self.assertEqual(frappe.db.count("Notification Log", {"document_name": doc.name}), before + 1)
		frappe.db.set_value(R, {"campaign": doc.name, "status": "Failed"}, {"status": "Sent", "sent_at": now_datetime()})
		self.assertEqual(health.check_campaign(doc), [])
		self.assertFalse(frappe.db.get_value(C, doc.name, "health_note"))

	def test_a_refused_login_is_named(self):
		doc = self.trouble(failed=3, sent=0, reason="(#190) Invalid OAuth access token")
		self.assertTrue(any("login" in p for p in health.problems(doc)))

	def test_few_messages_or_switched_off_raises_nothing(self):
		doc = self.trouble(failed=1, sent=0)
		cfg(campaign_alert_min_messages=20)
		self.assertEqual(health.problems(doc), [])
		cfg(campaign_alert_min_messages=1, campaign_alerts_enabled=0)
		self.assertEqual(health.problems(doc), [])

	def test_waiting_messages_with_no_mail_account_are_reported(self):
		doc = self.make_campaign(leads=[self.leads[0]])
		self.run_launch(doc)
		cfg(campaign_alerts_enabled=1)
		with patch.object(health, "email_account_problem", return_value="No outgoing Email Account is set up on this site."):
			self.assertIn("No outgoing Email Account is set up on this site.", health.problems(frappe.get_doc(C, doc.name)))


class TestAutomaticCampaign(Growth):
	def automatic(self, **kw):
		kw.setdefault("trigger_event", "Lead created")
		kw.setdefault("audience_mode", "CRM Filters")
		kw.setdefault("audience_filters", json.dumps([["first_name", "=", "Zed"]]))
		doc = self.make_campaign(send_mode="Trigger", **kw)
		with patch("frappe.enqueue"):
			engine.launch(doc.name)
		return frappe.get_doc(C, doc.name)

	def new_lead(self, first="Zed", email="zed.camp@example.com", **kw):
		return self.make_lead(first, email, "9876500000", **kw)

	def test_launch_starts_it_immediately_and_enrols_nobody_yet(self):
		doc = self.automatic()
		self.assertEqual(doc.status, "Running")
		self.assertEqual(self.rows(doc.name), [])

	def test_a_new_matching_lead_joins_once_and_others_do_not(self):
		doc = self.automatic()
		zed = self.new_lead()
		self.new_lead("Yan", "yan.camp@example.com")
		rows = self.rows(doc.name)
		self.assertEqual([r.recipient_id for r in rows], [zed.name])
		self.assertEqual(rows[0].status, "Pending")
		zed.reload()
		zed.save(ignore_permissions=True)
		self.assertEqual(len(self.rows(doc.name)), 1)  # saving again never starts the journey again
		self.assertEqual(frappe.db.get_value(C, doc.name, "total_recipients"), 1)

	def test_the_journey_counts_days_from_the_lead_joining(self):
		doc = self.automatic(
			steps=[{"channel": "Email", "day_offset": 0, "email_template": self.tpl.name}, {"channel": "Email", "day_offset": 3, "email_template": self.linked.name}]
		)
		self.new_lead()
		due = {r.step_idx: r.due_at for r in frappe.get_all(R, filters={"campaign": doc.name}, fields=["step_idx", "due_at"])}
		self.assertIsNone(due[1])
		self.assertGreater(due[2], add_to_date(now_datetime(), days=2, hours=23))

	def test_it_starts_on_a_status_change_only_to_the_chosen_status(self):
		a, b = self.statuses[0], self.statuses[1]
		doc = self.automatic(trigger_event="Lead status changed", trigger_status=b, audience_filters="[]")
		lead = self.new_lead("Kay", "kay.camp@example.com", status=a)
		self.assertEqual(self.rows(doc.name), [])
		lead.reload()
		lead.status = b
		lead.save(ignore_permissions=True)
		self.assertEqual(len(self.rows(doc.name)), 1)

	def test_a_lead_that_cannot_receive_is_recorded_as_skipped_with_the_reason(self):
		doc = self.automatic()
		optout.add_opt_out("Email", "zed.camp@example.com", source="Manual")
		self.new_lead()
		self.assertEqual([(r.status, r.skip_reason) for r in self.rows(doc.name)], [("Skipped", "Opted out")])

	def test_two_leads_with_the_same_address_get_one_email(self):
		doc = self.automatic(audience_filters=json.dumps([["last_name", "=", "Camp"], ["first_name", "like", "Z%"]]))
		self.new_lead("Zed", "same.camp@example.com")
		self.new_lead("Zoe", "same.camp@example.com")
		self.assertEqual(sorted(r.status for r in self.rows(doc.name)), ["Pending", "Skipped"])

	def test_it_sends_like_any_campaign_and_never_finishes(self):
		doc = self.automatic()
		self.new_lead()
		names = engine._claim(doc.name, 50)
		with patch.object(frappe, "sendmail", autospec=True, side_effect=lambda **kw: self.fake_send()) as mail:
			engine.send_batch(doc.name, names)
		self.assertEqual(mail.call_count, 1)
		with patch("frappe.enqueue"):
			engine._dispatch_campaign(frappe.get_doc(C, doc.name))
		self.assertEqual(frappe.db.get_value(C, doc.name, "status"), "Running")

	def test_a_paused_or_cancelled_campaign_enrols_nobody(self):
		doc = self.automatic()
		engine.pause(doc.name)
		self.new_lead()
		self.assertEqual(self.rows(doc.name), [])
		engine.resume(doc.name)
		engine.cancel(doc.name)
		self.new_lead("Zed", "zed2.camp@example.com")
		self.assertEqual([r.status for r in self.rows(doc.name)], [])

	def test_it_needs_an_event_and_cannot_use_a_hand_picked_list(self):
		with self.assertRaises(frappe.ValidationError):
			self.make_campaign(send_mode="Trigger")  # no event
		with self.assertRaises(frappe.ValidationError):
			self.make_campaign(send_mode="Trigger", trigger_event="Lead created")  # hand-picked leads (the fixture default)

	def test_an_enrolment_problem_never_stops_the_lead_from_being_saved(self):
		self.automatic()
		with patch.object(triggers, "_enroll", side_effect=RuntimeError("boom")), patch("frappe.log_error") as log:
			lead = self.new_lead()
		self.assertTrue(frappe.db.exists("CRM Lead", lead.name))
		self.assertTrue(log.called)

	def test_the_reply_check_looks_from_the_enrolment_not_the_campaign_start(self):
		doc = self.automatic(
			stop_on_reply=1,
			steps=[{"channel": "Email", "day_offset": 0, "email_template": self.tpl.name}, {"channel": "Email", "day_offset": 2, "email_template": self.linked.name}],
		)
		lead = self.new_lead()
		rec = frappe.get_doc(R, {"campaign": doc.name, "step_idx": 2})
		campaign = frappe.get_doc(C, doc.name)
		self.assertFalse(engine._replied(rec, campaign))
		frappe.get_doc(
			{"doctype": "Communication", "communication_type": "Communication", "communication_medium": "Email", "sent_or_received": "Received", "subject": "Re", "content": "x",
			 "sender": "zed.camp@example.com", "recipients": "me@example.com", "reference_doctype": "CRM Lead", "reference_name": lead.name}
		).insert(ignore_permissions=True)
		self.assertTrue(engine._replied(rec, campaign))


class TestCostAndResults(Growth):
	def test_cost_is_messages_sent_times_the_price_per_channel(self):
		cfg(campaign_cost_email=0.5, campaign_cost_whatsapp_marketing=2)
		doc = self.make_campaign(("Email", "WhatsApp"), leads=[self.leads[0]])
		with patch.object(common, "whatsapp_installed", return_value=True):
			self.run_launch(doc)
		for row in self.rows(doc.name):
			frappe.db.set_value(R, row.name, {"status": "Sent", "sent_at": now_datetime()})
		self.assertEqual(roi.campaign_costs([doc.name])[doc.name], 2.5)
		out = roi.results(doc.name)
		self.assertEqual((out["cost"], out["reached"]), (2.5, 1))
		self.assertEqual(out["cost_per_lead"], 2.5)

	def test_no_prices_means_no_cost_is_shown(self):
		cfg(campaign_cost_email=0, campaign_cost_whatsapp_marketing=0, campaign_cost_whatsapp_utility=0, campaign_cost_whatsapp_authentication=0)
		doc = self.running()
		self.sent_row(doc)
		out = roi.results(doc.name)
		self.assertIsNone(out["cost"])
		self.assertIsNone(out["roi_percent"])
		self.assertEqual(out["reached"], 1)

	def test_deals_made_from_reached_leads_after_the_start_are_counted_and_won_ones_bring_revenue(self):
		cfg(campaign_cost_email=10)
		doc = self.running()
		self.sent_row(doc)
		won = frappe.get_all("CRM Deal Status", filters={"type": "Won"}, pluck="name")
		if not won:
			self.skipTest("the test site has no 'Won' deal status")
		frappe.db.set_value(C, doc.name, "started_at", add_to_date(now_datetime(), days=-1))
		deal = frappe.new_doc("CRM Deal")
		deal.update({"lead": self.leads[0].name, "status": won[0], "deal_value": 1000, "organization": None})
		deal.flags.ignore_mandatory = True
		deal.flags.ignore_links = True
		deal.insert(ignore_permissions=True)
		out = roi._results(doc.name, None, None)
		self.assertEqual((out["deals"], out["won"], out["revenue"]), (1, 1, 1000.0))
		self.assertEqual(out["roi_percent"], 9900.0)  # (1000 - 10) / 10
		self.assertEqual(out["cost_per_deal"], 10.0)

	def test_the_overview_carries_the_cost_per_campaign(self):
		cfg(campaign_cost_email=1)
		doc = self.running()
		self.sent_row(doc)
		top = [c for c in analytics.get_overview()["top_campaigns"] if c["name"] == doc.name][0]
		self.assertEqual(top["cost"], 1.0)


class TestCalendar(Growth):
	def test_planned_running_and_automatic_campaigns_appear_on_their_days(self):
		soon = add_days(nowdate(), 3)
		planned = self.make_campaign(send_mode="Schedule", scheduled_at=f"{soon} 09:00:00", steps=[
			{"channel": "Email", "day_offset": 0, "email_template": self.tpl.name}, {"channel": "Email", "day_offset": 2, "email_template": self.linked.name}])
		running = self.running()
		auto = self.make_campaign(send_mode="Trigger", trigger_event="Lead created", audience_mode="CRM Filters", audience_filters="[]")
		with patch("frappe.enqueue"):
			engine.launch(auto.name)
		events = {e["name"]: e for e in schedule_view.events(nowdate(), add_days(nowdate(), 30))}
		self.assertEqual(events[planned.name]["first"], soon)
		self.assertEqual(events[planned.name]["step_days"], [add_days(soon, 2)])
		self.assertEqual(events[planned.name]["last"], add_days(soon, 2))
		self.assertEqual(events[running.name]["first"], nowdate())
		self.assertTrue(events[auto.name]["automatic"])
		self.assertEqual(schedule_view.events(add_days(nowdate(), 60), add_days(nowdate(), 90)), [])


class TestSettingsAndApi(Growth):
	def test_the_config_offers_what_the_wizard_needs(self):
		out = api.get_config()
		self.assertEqual(out["lead_statuses"][:1], self.statuses[:1])
		self.assertIn("Clicked a link", out["rule_events"])
		self.assertIn("Set lead status", out["rule_actions"])

	def test_everything_saves_and_comes_back_through_the_api(self):
		data = {
			"campaign_name": "Roundtrip", "audience_mode": "CRM Filters", "audience_filters": "[]", "send_mode": "Trigger", "trigger_event": "Lead status changed", "trigger_status": self.statuses[1],
			"track_clicks": 0, "window_enabled": 1, "window_start": "08:30:00", "window_end": "17:00:00", "window_weekdays_only": 1,
			"steps": [{"channel": "Email", "day_offset": 0, "email_template": self.tpl.name}],
			"rules": [{"event": "Replied", "action": "Add a note to the lead", "value": "Hot"}],
		}
		out = api.save_campaign(json.dumps(data))
		self.assertEqual((out["send_mode"], out["trigger_event"], out["trigger_status"]), ("Trigger", "Lead status changed", self.statuses[1]))
		self.assertEqual((out["track_clicks"], out["window_enabled"], out["window_weekdays_only"]), (0, 1, 1))
		self.assertEqual([(r["event"], r["value"]) for r in out["rules"]], [("Replied", "Hot")])
		self.assertIn("window_open_now", out)
		copy = api.duplicate_campaign(out["name"])
		self.assertEqual((copy["send_mode"], len(copy["rules"])), ("Trigger", 1))
		tpl = api.save_as_template(out["name"], "Auto template")
		back = api.create_from_template(tpl, "From template")
		self.assertEqual(back["rules"][0]["value"], "Hot")
		self.assertEqual(str(back["window_start"]), "8:30:00" if str(back["window_start"]).startswith("8") else "08:30:00")

	def test_the_calendar_endpoint(self):
		self.running()
		out = api.get_calendar(nowdate(), add_days(nowdate(), 7))
		self.assertTrue(out["events"])
		self.assertEqual(out["today"], nowdate())
