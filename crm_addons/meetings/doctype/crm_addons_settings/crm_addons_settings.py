import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import cint


class CRMAddonsSettings(Document):
	def validate(self):
		if cint(self.reminder_minutes_before) < 0 or cint(self.early_reminder_minutes) < 0:
			frappe.throw(_("Reminder times cannot be negative."))
		if cint(self.default_duration) < 5:
			self.default_duration = 30
		if self.google_calendar:
			calendar = frappe.db.get_value(
				"Google Calendar", self.google_calendar, ["enable", "push_to_google_calendar"], as_dict=True
			)
			if calendar and not calendar.push_to_google_calendar:
				frappe.msgprint(
					_("\"Push to Google Calendar\" is off on {0}, so meetings cannot be created on it.").format(
						self.google_calendar
					),
					indicator="orange",
				)
