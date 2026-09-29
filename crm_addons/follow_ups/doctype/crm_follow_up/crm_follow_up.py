# Copyright (c) 2026, Coding Pro
# For internal use in the Coding Pro CRM.

import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import get_datetime

from crm_addons import followups
from crm_addons.utils import REFERENCE_DOCTYPES


class CRMFollowUp(Document):
	def validate(self):
		if self.reference_doctype not in REFERENCE_DOCTYPES:
			frappe.throw(_("A follow-up can only be linked to a Lead."))
		if not frappe.db.exists(self.reference_doctype, self.reference_docname):
			frappe.throw(_("{0} {1} was not found.").format(self.reference_doctype, self.reference_docname))

		self.mode = self.mode or "Call"
		if self.mode == "Call":
			if not self.outcome:
				frappe.throw(_("Choose the call outcome."))
			self.call_status = followups.call_result(self.outcome)
		else:
			self.call_status = None
		self.assigned_to = self.assigned_to or frappe.session.user
		self.followed_up_on = self.followed_up_on or frappe.utils.now_datetime()

		if self.next_follow_up_on and get_datetime(self.next_follow_up_on) < get_datetime(self.followed_up_on):
			frappe.throw(_("The next follow-up cannot be before this one."))

		if self.is_new():
			self.attempt_no = followups.attempt_number(self)
		if self.is_new() or self.has_value_changed("next_follow_up_on"):
			self.next_closed = 0 if self.next_follow_up_on else 1
			self.reminded = 0

	def after_insert(self):
		# The newest follow-up decides what happens next; older open ones are done.
		frappe.db.sql(
			"""update `tabCRM Follow Up` set next_closed = 1
			where reference_doctype = %s and reference_docname = %s and name != %s and next_closed = 0""",
			(self.reference_doctype, self.reference_docname, self.name),
		)
		followups.post_timeline_comment(self)
		followups.escalate_if_needed(self)

	def on_update(self):
		followups.refresh_next_follow_up(self.reference_doctype, self.reference_docname)

	def after_delete(self):
		followups.refresh_next_follow_up(self.reference_doctype, self.reference_docname)
