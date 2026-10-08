# Copyright (c) 2026, CRM Pro Pack and contributors
# License: MIT

import unittest

import frappe

from crm_addons import api, install

MENU_FLAGS = ("hide_deals_menu", "hide_notes_menu", "hide_tasks_menu", "hide_call_logs_menu")


class TestSideMenuSettings(unittest.TestCase):
	def setUp(self):
		frappe.set_user("Administrator")
		self._saved = {f: frappe.db.get_single_value("CRM Addons Settings", f) for f in MENU_FLAGS}

	def tearDown(self):
		for field, value in self._saved.items():
			frappe.db.set_single_value("CRM Addons Settings", field, value or 0)
		frappe.clear_document_cache("CRM Addons Settings", "CRM Addons Settings")
		frappe.db.commit()

	def test_fields_are_checks_defaulting_to_off(self):
		meta = frappe.get_meta("CRM Addons Settings")
		for field in MENU_FLAGS:
			df = meta.get_field(field)
			self.assertIsNotNone(df, field)
			self.assertEqual(df.fieldtype, "Check")
			self.assertEqual(str(df.default), "0")
			self.assertEqual(install.NEW_SETTING_DEFAULTS[field], 0)

	def test_client_config_exposes_flags_as_ints(self):
		config = api.get_client_config()
		for field in MENU_FLAGS:
			self.assertIn(field, config)
			self.assertIn(config[field], (0, 1))

	def test_each_flag_reaches_the_client_config(self):
		for field in MENU_FLAGS:
			frappe.db.set_single_value("CRM Addons Settings", field, 1)
			frappe.clear_document_cache("CRM Addons Settings", "CRM Addons Settings")
			config = api.get_client_config()
			self.assertEqual(config[field], 1, field)
			self.assertEqual([f for f in MENU_FLAGS if config[f]], [field])
			frappe.db.set_single_value("CRM Addons Settings", field, 0)
		frappe.clear_document_cache("CRM Addons Settings", "CRM Addons Settings")

	def test_existing_installs_get_the_new_defaults(self):
		# a site that never stored the value (installed before the setting existed) is filled in by ensure_settings
		frappe.db.sql(
			"delete from `tabSingles` where doctype = 'CRM Addons Settings' and field in %s", (MENU_FLAGS,)
		)
		install.ensure_settings()
		for field in MENU_FLAGS:
			stored = frappe.db.sql(
				"select value from `tabSingles` where doctype = 'CRM Addons Settings' and field = %s", field
			)
			self.assertEqual(len(stored), 1, field)
			self.assertEqual(int(stored[0][0]), 0)
