# Copyright (c) 2026, Coding Pro
import json

import frappe
from frappe import _
from frappe.model.document import Document

from crm_addons.campaigns import audience, common, journey, rules
from crm_addons.campaigns.common import CHANNELS, valid_timezone
from crm_addons.campaigns.personalization import parse_variable_map
from crm_addons.utils import system_timezone

# Changing any of these after a campaign has started would change who gets what, so it is refused.
PROTECTED = (
	"audience_mode", "audience_filters", "selected_records", "saved_view", "send_mode", "scheduled_at",
	"timezone", "consent_confirmed", "stop_on_reply", "trigger_event", "trigger_status",
)


def _steps_signature(doc):
	return json.dumps(
		[
			[s.channel, s.day_offset, s.condition, s.email_template, s.wa_template, s.wa_account, s.variable_map, s.wa_attach]
			for s in doc.get("steps") or []
		]
	)


class CRMCampaign(Document):
	def validate(self):
		self.audience_doctype = "CRM Lead"
		self.campaign_owner = self.campaign_owner or frappe.session.user
		self.timezone = self.timezone or common.DEFAULT_TIMEZONE
		if not valid_timezone(self.timezone):
			frappe.throw(_("{0} is not a time zone.").format(self.timezone))
		self.guard_status()
		self.validate_steps()
		self.validate_trigger()
		self.validate_window()
		rules.validate_rules(self)
		audience.build_filters(audience.definition_of(self))  # raises on anything invalid
		self.guard_edits()

	def guard_status(self):
		"""Status belongs to the engine. A form save, API call or import cannot change it."""
		if self.is_new():
			self.status = "Draft"
			return
		before = self.get_doc_before_save()
		if before and before.status != self.status:
			frappe.throw(_("The status of a campaign changes through Launch, Pause, Resume and Cancel."))

	def validate_steps(self):
		seen, previous_day = set(), 0
		for step in self.steps:
			if step.channel not in CHANNELS:
				frappe.throw(_("Row {0}: choose Email or WhatsApp.").format(step.idx))
			day = frappe.utils.cint(step.day_offset)
			if day < 0 or day > journey.MAX_DAYS:
				frappe.throw(_("Row {0}: the day must be between 0 and {1}.").format(step.idx, journey.MAX_DAYS))
			if day < previous_day:
				frappe.throw(_("Row {0}: steps run in order, so day {1} cannot come after day {2}.").format(step.idx, day, previous_day))
			previous_day = day
			condition = step.condition or ""
			if condition not in journey.CONDITIONS:
				frappe.throw(_("Row {0}: unknown condition.").format(step.idx))
			if condition and step.idx == 1:
				frappe.throw(_("Row 1 is the first step, so it has no previous step to depend on."))
			if step.channel == "WhatsApp":
				if not common.whatsapp_installed():
					frappe.throw(_("The frappe_whatsapp app is not installed on this site."))
				parse_variable_map(step.variable_map)
			key = (step.channel, step.email_template or step.wa_template, day)
			if key in seen:
				frappe.throw(_("Row {0}: the same {1} template is already used on day {2}.").format(step.idx, step.channel, day))
			seen.add(key)

	def validate_trigger(self):
		if self.send_mode != "Trigger":
			self.trigger_event = None
			self.trigger_status = None
			return
		if self.get("automation"):
			return  # the sequence of an automation: the automation decides who joins and when
		if not self.trigger_event:
			frappe.throw(_("Choose what starts the campaign for a lead."))
		if self.trigger_event != "Lead status changed":
			self.trigger_status = None
		if self.audience_mode == "Selected Records":
			frappe.throw(_("An automatic campaign needs filters or a saved segment, not a hand-picked list."))
		self.scheduled_at = None

	def validate_window(self):
		if not frappe.utils.cint(self.window_enabled):
			return
		start, end = journey._clock(self.window_start, journey.DEFAULT_START), journey._clock(self.window_end, journey.DEFAULT_END)
		if start >= end:
			frappe.throw(_("The sending hours must end after they begin."))
		self.window_start, self.window_end = start.strftime("%H:%M:%S"), end.strftime("%H:%M:%S")

	def guard_edits(self):
		if self.flags.get("automation_sync"):
			return  # its automation keeps it in step (and has already refused changes that would break enrolled leads)
		before = self.get_doc_before_save()
		if self.is_new() or not before or before.status in ("Draft",):
			return
		changed = [f for f in PROTECTED if before.get(f) != self.get(f)] + (
			["steps"] if _steps_signature(before) != _steps_signature(self) else []
		)
		if not changed:
			return
		if before.status == "Scheduled":
			self.status = "Draft"  # edited after scheduling: it must be launched again
			self.flags.back_to_draft = True
			return
		frappe.throw(_("A {0} campaign cannot change its audience, content or schedule.").format(before.status))

	def on_trash(self):
		if self.status in ("Queued", "Running"):
			frappe.throw(_("Pause or cancel the campaign before deleting it."))
		frappe.db.delete("CRM Campaign Recipient", {"campaign": self.name})
