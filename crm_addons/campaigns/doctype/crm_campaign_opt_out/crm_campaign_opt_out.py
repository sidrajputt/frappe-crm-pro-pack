# Copyright (c) 2026, Coding Pro
import frappe
from frappe import _
from frappe.model.document import Document

from crm_addons.campaigns import optout


class CRMCampaignOptOut(Document):
	def validate(self):
		value = optout.normalize(self.channel, self.value)
		if not value:
			frappe.throw(_("{0} is not a valid {1} address.").format(frappe.bold(self.value), self.channel))
		self.value = value
		self.opt_key = optout.opt_key(self.channel, value)
