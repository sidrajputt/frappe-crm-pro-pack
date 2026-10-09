# Copyright (c) 2026, Coding Pro
"""The setup page's backend: what it shows, what it saves and who may use it.

Run on a bench:  bench --site <site> run-tests --app crm_addons --module crm_addons.meetings.doctype.crm_addons_settings.test_setup_page
"""

import json

import frappe

from crm_addons import setup_page
from crm_addons.meetings.doctype.crm_meeting.test_crm_meeting import TestCase as Base


class TestSetupPage(Base):
	def test_it_shows_every_setting_the_page_knows_about(self):
		out = setup_page.get_setup()
		self.assertTrue({"values", "choices", "status", "site_url"} <= set(out))
		for key in ("default_duration", "enable_follow_ups", "campaign_rate_per_minute", "campaign_cost_email", "whatsapp_consent_mode"):
			self.assertIn(key, out["values"])
		self.assertIn(out["values"]["enable_follow_ups"], (0, 1))
		self.assertIsInstance(out["values"]["campaign_batch_size"], int)
		self.assertIn("lead_statuses", out["choices"])

	def test_the_checklist_says_what_to_do(self):
		checks = {c["key"]: c for c in setup_page.get_setup()["status"]["checks"]}
		for key in ("google", "email", "scheduler"):
			self.assertIn(checks[key]["state"], ("ok", "todo"))
			self.assertTrue(checks[key]["message"])
		for c in checks.values():
			if c["state"] == "todo":
				self.assertTrue(c["steps"], f"{c['key']} needs steps that say how to fix it")
		status = setup_page.get_setup()["status"]
		self.assertEqual(status["todo"], sum(1 for c in status["checks"] if c["state"] == "todo"))

	def test_saving_changes_only_what_was_sent_and_casts_the_values(self):
		before = setup_page.get_setup()["values"]
		out = setup_page.save_setup(json.dumps({"default_duration": "45", "enable_follow_ups": 0, "campaign_cost_email": "0.25", "default_country_code": "44"}))["values"]
		self.assertEqual((out["default_duration"], out["enable_follow_ups"], out["campaign_cost_email"], out["default_country_code"]), (45, 0, 0.25, "44"))
		self.assertEqual(out["campaign_rate_per_minute"], before["campaign_rate_per_minute"])
		self.assertEqual(frappe.db.get_single_value("CRM Addons Settings", "default_duration"), 45)

	def test_an_empty_price_clears_it(self):
		setup_page.save_setup(json.dumps({"campaign_cost_email": 1}))
		self.assertEqual(setup_page.save_setup(json.dumps({"campaign_cost_email": ""}))["values"]["campaign_cost_email"], "")

	def test_an_unknown_setting_is_refused_and_nothing_is_written(self):
		with self.assertRaises(frappe.ValidationError):
			setup_page.save_setup(json.dumps({"default_duration": 50, "not_a_setting": 1}))
		self.assertNotEqual(frappe.db.get_single_value("CRM Addons Settings", "default_duration"), 50)

	def test_the_records_own_rules_still_apply(self):
		with self.assertRaises(frappe.ValidationError):
			setup_page.save_setup(json.dumps({"reminder_minutes_before": -5}))

	def test_only_a_system_manager_may_use_it(self):
		users = [self.make_user(email, role) for role, email in (("Sales Manager", "sm.setup@example.org"), ("Sales User", "su.setup@example.org"))]
		frappe.flags.in_test = False  # (users first: with the flag off, a site that can send mail commits when it creates one)
		self.addCleanup(setattr, frappe.flags, "in_test", True)
		for user in users:
			frappe.set_user(user.name)
			for call in (setup_page.get_setup, lambda: setup_page.save_setup("{}")):
				with self.assertRaises(frappe.PermissionError):
					call()
			frappe.set_user("Administrator")
