# Copyright (c) 2026, Coding Pro
import frappe
from frappe.model.document import Document


class CRMCampaignRecipient(Document):
	"""Written by the engine only (bulk insert, guarded updates). Users read it."""

	def before_insert(self):
		from crm_addons.campaigns.common import dedupe_key

		self.dedupe_key = self.dedupe_key or dedupe_key(self.campaign, self.step_idx, self.channel, self.recipient_id)


def on_doctype_update():
	frappe.db.add_index("CRM Campaign Recipient", ["campaign", "status"])
	frappe.db.add_index("CRM Campaign Recipient", ["campaign", "channel", "status"])
	frappe.db.add_index("CRM Campaign Recipient", ["recipient_type", "recipient_id"])
