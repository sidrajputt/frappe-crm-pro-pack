# Copyright (c) 2026, Coding Pro
"""Automations: triggers, conditions, actions, the managed message campaign, once-per-lead, and the Campaign Manager API.

Run on a bench:  bench --site <site> run-tests --app crm_addons --module crm_addons.campaigns.doctype.crm_campaign.test_automation
"""

import json
from unittest.mock import patch

import frappe
from frappe.utils import now_datetime

from crm_addons.campaigns import automation, engine, optout, rules, tracking
from crm_addons.campaigns.doctype.crm_campaign.test_campaign_growth import LINK, Growth
from crm_addons.campaigns.doctype.crm_campaign.test_crm_campaign import C, R

A = "CRM Campaign Automation"
RUN = "CRM Automation Run"


class Autos(Growth):
	def make(self, trigger="Lead created", actions=None, steps=None, **kw):
		doc = frappe.new_doc(A)
		doc.update({"automation_name": "Test automation", "trigger_event": trigger, "audience_mode": "CRM Filters", "audience_filters": "[]", **kw})
		for a in ([("Add a note to the lead", "Hello from automation")] if actions is None else actions):
			doc.append("actions", {"action": a[0], "value": a[1]})
		for s in steps or []:
			doc.append("steps", s)
		return doc.insert(ignore_permissions=True)

	def note_count(self, lead, text):
		return frappe.db.count("Comment", {"reference_doctype": "CRM Lead", "reference_name": lead, "content": ["like", f"%{text}%"]})

	def new_lead(self, first="Zed", email="zed.auto@example.com", **kw):
		return self.make_lead(first, email, "9876500123", **kw)

	def sequence(self):
		return [{"channel": "Email", "day_offset": 0, "email_template": self.tpl.name}]


class TestValidation(Autos):
	def test_what_a_valid_automation_needs(self):
		bad = [
			dict(trigger="Nonsense"),
			dict(actions=[]),
			dict(actions=[("Set lead status", "No Such Status")]),
			dict(actions=[("Create a follow-up", "abc")]),
			dict(actions=[("Create a follow-up", "9999")]),
			dict(actions=[("Add a note to the lead", "  ")]),
			dict(actions=[("Send messages", "")]),  # no messages
			dict(actions=[("Send messages", ""), ("Send messages", "")], steps=self.sequence()),
			dict(audience_mode="Selected Records"),
		]
		for kw in bad:
			with self.assertRaises(frappe.ValidationError, msg=str(kw)):
				self.make(**kw)

	def test_messages_are_dropped_when_nothing_sends_them(self):
		doc = self.make(steps=self.sequence())  # a note action only
		self.assertEqual(len(doc.steps), 0)

	def test_the_trigger_fields_that_do_not_apply_are_cleared(self):
		doc = self.make(trigger="Lead created", trigger_status=self.statuses[0], trigger_campaign=None)
		self.assertFalse(doc.trigger_status)


class TestLeadTriggers(Autos):
	def test_a_new_lead_runs_the_actions_once(self):
		target = self.statuses[-1]
		doc = self.make(actions=[("Set lead status", target), ("Add a note to the lead", "Welcome note")], enabled=1)
		lead = self.new_lead()
		self.assertEqual(frappe.db.get_value("CRM Lead", lead.name, "status"), target)
		self.assertEqual(self.note_count(lead.name, "Welcome note"), 1)
		self.assertEqual(frappe.db.count(RUN, {"automation": doc.name}), 1)
		lead.reload()
		lead.save(ignore_permissions=True)
		self.assertEqual(self.note_count(lead.name, "Welcome note"), 1)  # editing the lead is not a new run

	def test_a_switched_off_automation_does_nothing(self):
		self.make(enabled=0)
		self.assertEqual(self.note_count(self.new_lead().name, "Hello from automation"), 0)

	def test_filters_narrow_it_down(self):
		self.make(enabled=1, audience_filters=json.dumps([["first_name", "=", "Zed"]]))
		self.assertEqual(self.note_count(self.new_lead("Zed", "z1.auto@example.com").name, "Hello from automation"), 1)
		self.assertEqual(self.note_count(self.new_lead("Yan", "y1.auto@example.com").name, "Hello from automation"), 0)

	def test_a_status_change_to_the_chosen_status(self):
		a, b = self.statuses[0], self.statuses[1]
		self.make(trigger="Lead status changed", trigger_status=b, enabled=1, actions=[("Create a follow-up", "2")])
		lead = self.new_lead(status=a)
		self.assertFalse(frappe.db.exists("CRM Follow Up", {"reference_docname": lead.name}))
		lead.reload()
		lead.status = b
		lead.save(ignore_permissions=True)
		fu = frappe.get_all("CRM Follow Up", filters={"reference_docname": lead.name}, fields=["mode", "remark", "next_follow_up_on"])
		self.assertEqual(len(fu), 1)
		self.assertIn("Test automation", fu[0].remark)
		self.assertGreater(fu[0].next_follow_up_on, now_datetime())

	def test_one_failing_action_does_not_stop_the_next(self):
		self.make(enabled=1, actions=[("Add a note to the lead", "First"), ("Add a note to the lead", "Second")])
		real = rules._note
		calls = []

		def flaky(lead, text, *a, **k):
			calls.append(text)
			if text == "First":
				raise RuntimeError("boom")
			return real(lead, text, *a, **k)

		with patch.object(rules, "_note", side_effect=flaky), patch("frappe.log_error"):
			lead = self.new_lead()
		self.assertEqual(calls, ["First", "Second"])
		self.assertEqual(self.note_count(lead.name, "Second"), 1)


class TestMessageTriggers(Autos):
	def campaign_with_send(self):
		doc = self.make_campaign(leads=[self.leads[0]])
		self.run_launch(doc)
		return doc, self.sent_row(doc)

	def test_a_click_runs_it_once_and_the_campaign_can_be_named(self):
		camp, row = self.campaign_with_send()
		other = self.make(trigger="Lead clicked a link", trigger_campaign=camp.name, enabled=1, actions=[("Add a note to the lead", "Clicked in campaign")])
		tracking.record(row, LINK)
		tracking.record(row, LINK)
		self.assertEqual(self.note_count(self.leads[0].name, "Clicked in campaign"), 1)
		self.assertEqual(frappe.db.count(RUN, {"automation": other.name}), 1)

	def test_a_campaign_scope_excludes_other_campaigns(self):
		camp, row = self.campaign_with_send()
		second = self.make_campaign(leads=[self.leads[0]])
		self.make(trigger="Lead clicked a link", trigger_campaign=second.name, enabled=1, actions=[("Add a note to the lead", "Only the second")])
		tracking.record(row, LINK)
		self.assertEqual(self.note_count(self.leads[0].name, "Only the second"), 0)

	def test_a_reply_needs_a_recent_message_and_stop_is_not_a_reply(self):
		self.make(trigger="Lead replied", enabled=1, actions=[("Add a note to the lead", "Replied note")])
		lead = self.leads[0]
		doc = frappe._dict(type="Incoming", reference_doctype="CRM Lead", reference_name=lead.name, message="yes please")
		rules.on_whatsapp_message(doc)
		self.assertEqual(self.note_count(lead.name, "Replied note"), 0)  # no campaign message went to this lead
		camp, row = self.campaign_with_send()
		rules.on_whatsapp_message(frappe._dict(doc, message="STOP"))
		self.assertEqual(self.note_count(lead.name, "Replied note"), 0)
		rules.on_whatsapp_message(doc)
		rules.on_whatsapp_message(doc)
		self.assertEqual(self.note_count(lead.name, "Replied note"), 1)

	def test_a_bounce_and_an_opt_out(self):
		self.make(trigger="Message failed or bounced", enabled=1, actions=[("Add a note to the lead", "Bounce note")])
		self.make(trigger="Lead opted out", enabled=1, actions=[("Add a note to the lead", "Optout note")], automation_name="Opt-outs")
		camp, row = self.campaign_with_send()
		optout.add_opt_out("Email", "asha.camp@example.com", source="Unsubscribe Link", lead=self.leads[0].name)
		self.assertEqual(self.note_count(self.leads[0].name, "Optout note"), 1)
		engine.advance(row, "Failed", failure_reason="Bounced", provider_status="Bounced")
		self.assertEqual(self.note_count(self.leads[0].name, "Bounce note"), 1)


class TestSendMessages(Autos):
	def message_automation(self, **kw):
		return self.make(actions=[("Send messages", ""), ("Add a note to the lead", "Enrolled")], steps=self.sequence(), audience_filters=json.dumps([["first_name", "=", "Zed"]]), **kw)

	def test_turning_it_on_starts_a_managed_campaign_and_leads_are_enrolled(self):
		doc = self.message_automation()
		self.assertTrue(doc.campaign)
		self.assertEqual(frappe.db.get_value(C, doc.campaign, "status"), "Draft")
		doc.enabled = 1
		doc.save()
		camp = frappe.get_doc(C, doc.campaign)
		self.assertEqual((camp.status, camp.send_mode, camp.automation), ("Running", "Trigger", doc.name))
		lead = self.new_lead()
		self.new_lead("Yan", "y2.auto@example.com")
		rows = self.rows(camp.name)
		self.assertEqual([r.recipient_id for r in rows], [lead.name])
		self.assertEqual(self.note_count(lead.name, "Enrolled"), 1)
		self.assertEqual(frappe.db.get_value(C, camp.name, "total_recipients"), 1)

	def test_the_off_switch_pauses_it_and_nobody_joins(self):
		doc = self.message_automation(enabled=1)
		doc.enabled = 0
		doc.save()
		self.assertEqual(frappe.db.get_value(C, doc.campaign, "status"), "Paused")
		self.new_lead()
		self.assertEqual(self.rows(doc.campaign), [])
		doc.enabled = 1
		doc.save()
		self.assertEqual(frappe.db.get_value(C, doc.campaign, "status"), "Running")
		self.new_lead("Zed", "z3.auto@example.com")
		self.assertEqual(len(self.rows(doc.campaign)), 1)

	def test_the_content_can_change_but_not_the_structure_once_leads_joined(self):
		doc = self.message_automation(enabled=1)
		self.new_lead()
		doc.steps[0].email_template = self.linked.name
		doc.save()  # content: fine
		self.assertEqual(frappe.get_doc(C, doc.campaign).steps[0].email_template, self.linked.name)
		doc.append("steps", {"channel": "Email", "day_offset": 2, "email_template": self.tpl.name})
		doc.save()  # adding at the end: fine
		self.assertEqual(len(frappe.get_doc(C, doc.campaign).steps), 2)
		doc.steps = [doc.steps[1]]
		with self.assertRaises(frappe.ValidationError):
			doc.save()  # removing a step the enrolled leads depend on: refused

	def test_its_campaign_is_kept_out_of_the_campaign_list_but_reports_can_open_it(self):
		from crm_addons.campaigns import api

		doc = self.message_automation(enabled=1)
		self.assertNotIn(doc.campaign, [r.name for r in api.list_campaigns(page_length=100)["rows"]])
		self.assertEqual(api.get_campaign(doc.campaign)["automation"], doc.name)

	def test_removing_the_send_action_pauses_and_releases_the_campaign(self):
		doc = self.message_automation(enabled=1)
		name = doc.campaign
		doc.set("actions", [{"action": "Add a note to the lead", "value": "Only a note"}])
		doc.save()
		self.assertFalse(doc.campaign)
		self.assertEqual(frappe.db.get_value(C, name, "status"), "Paused")
		self.assertFalse(frappe.db.get_value(C, name, "automation"))

	def test_deleting_it_keeps_what_it_sent(self):
		doc = self.message_automation(enabled=1)
		self.new_lead()
		name = doc.campaign
		frappe.delete_doc(A, doc.name, ignore_permissions=True)
		self.assertEqual(frappe.db.get_value(C, name, "status"), "Cancelled")
		self.assertTrue(frappe.db.exists(R, {"campaign": name}))
		doc2 = self.message_automation(enabled=1, automation_name="Empty one")
		name2 = doc2.campaign
		frappe.delete_doc(A, doc2.name, ignore_permissions=True)
		self.assertFalse(frappe.db.exists(C, name2))  # nothing was sent: no trace

	def test_ending_the_managed_campaign_by_hand_does_not_leave_the_automation_on_but_dead(self):
		doc = self.message_automation(enabled=1)
		first = doc.campaign
		engine.cancel(first)
		doc.reload()
		doc.description = "touched"
		doc.save()
		self.assertNotEqual(doc.campaign, first)
		self.assertEqual(frappe.db.get_value(C, doc.campaign, "status"), "Running")
		self.assertFalse(frappe.db.get_value(C, first, "automation"))  # the old one stays as an ordinary, cancelled campaign
		self.new_lead()
		self.assertEqual(len(self.rows(doc.campaign)), 1)

	def test_a_campaign_not_ready_to_send_refuses_to_turn_on(self):
		doc = self.message_automation()
		doc.enabled = 1
		with patch("crm_addons.campaigns.channels.EmailSender.check_ready", side_effect=frappe.ValidationError("No outgoing Email Account")):
			with self.assertRaises(frappe.ValidationError):
				doc.save()


class TestAutomationApi(Autos):
	def test_the_page_can_list_edit_switch_copy_and_delete(self):
		data = {
			"automation_name": "Welcome", "trigger_event": "Lead created", "audience_mode": "CRM Filters", "audience_filters": "[]",
			"actions": [{"action": "Send messages", "value": ""}, {"action": "Set lead status", "value": self.statuses[-1]}],
			"steps": self.sequence(), "track_clicks": 1, "window_enabled": 1, "window_start": "09:00:00", "window_end": "18:00:00",
		}
		out = automation.save_automation(json.dumps(data))
		self.assertEqual((out["enabled"], out["trigger"], out["has_conditions"]), (0, "A new lead is created", False))
		self.assertEqual([a["text"] for a in out["actions"]][0], "Send messages")
		name = out["name"]
		on = automation.set_enabled(name, 1)
		self.assertEqual((on["enabled"], on["campaign_status"]), (1, "Running"))
		lead = self.new_lead()
		self.assertEqual(automation.get_runs(name)["total"], 1)
		self.assertEqual(automation.get_runs(name)["rows"][0]["lead"], lead.name)
		listed = [r for r in automation.list_automations() if r["name"] == name][0]
		self.assertEqual((listed["runs"], listed["messaged"]), (1, 1))
		copy = automation.duplicate_automation(name)
		self.assertEqual((copy["enabled"], len(copy["steps"]), copy["automation_name"]), (0, 1, "Welcome (copy)"))
		self.assertTrue(automation.delete_automation(copy["name"]))
		self.assertFalse(frappe.db.exists(A, copy["name"]))

	def test_a_sales_user_sees_only_their_own(self):
		doc = self.make()
		other = self.make_user("auto.other@example.org", "Sales User")
		frappe.set_user(other.name)
		self.assertNotIn(doc.name, [r["name"] for r in automation.list_automations()])
		with self.assertRaises(frappe.PermissionError):
			automation.get_automation(doc.name)
		mine = automation.save_automation(json.dumps({"automation_name": "Mine", "trigger_event": "Lead created", "actions": [{"action": "Add a note to the lead", "value": "x"}]}))
		self.assertIn(mine["name"], [r["name"] for r in automation.list_automations()])

	def test_the_config_lists_what_the_page_offers(self):
		from crm_addons.campaigns import api

		self.assertIn("Lead replied", api.get_config()["automation_events"])


class TestNotMigratedYet(Autos):
	"""A site that has the new code but has not run `bench migrate` must not break its pages or its lead saves."""

	def test_the_automations_page_says_what_to_do_instead_of_failing(self):
		with patch("crm_addons.campaigns.automation.automation_ready", return_value=False):
			with self.assertRaises(frappe.ValidationError) as ctx:
				automation.list_automations()
		self.assertIn("migrate", str(ctx.exception))

	def test_saving_leads_and_listing_campaigns_still_work(self):
		from crm_addons.campaigns import api

		with patch("crm_addons.campaigns.automation.automation_ready", return_value=False), patch("crm_addons.campaigns.api.automation_ready", return_value=False), patch("crm_addons.campaigns.triggers.automation_ready", return_value=False):
			lead = self.new_lead()
			self.assertTrue(frappe.db.exists("CRM Lead", lead.name))
			self.assertIn("rows", api.list_campaigns())


class TestIndianTimeByDefault(Autos):
	def test_new_campaigns_and_automations_are_in_indian_time(self):
		from crm_addons.campaigns import api

		self.assertEqual(self.make_campaign().timezone, "Asia/Kolkata")
		self.assertEqual(self.make().timezone, "Asia/Kolkata")
		self.assertEqual(api.get_config()["timezone"], "Asia/Kolkata")
