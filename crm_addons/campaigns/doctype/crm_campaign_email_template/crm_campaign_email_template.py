# Copyright (c) 2026, Coding Pro
import frappe
from frappe import _
from frappe.model.document import Document

from crm_addons.campaigns import personalization


class CRMCampaignEmailTemplate(Document):
	def validate(self):
		unknown = personalization.unknown_variables(self.subject, self.body_html, self.body_text)
		if unknown:
			frappe.throw(
				_("Unknown variable(s): {0}. Use the variables of the Lead listed in the template editor.").format(
					", ".join(unknown)
				)
			)
		self.variables = ", ".join(sorted(personalization.variables_in(self.subject, self.body_html, self.body_text)))
