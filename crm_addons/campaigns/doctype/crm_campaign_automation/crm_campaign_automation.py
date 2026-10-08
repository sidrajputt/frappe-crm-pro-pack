# Copyright (c) 2026, Coding Pro
import frappe
from frappe.model.document import Document

from crm_addons.campaigns import automation


class CRMCampaignAutomation(Document):
	def validate(self):
		automation.validate(self)

	def on_update(self):
		automation.sync(self)

	def on_trash(self):
		automation.on_trash(self)
