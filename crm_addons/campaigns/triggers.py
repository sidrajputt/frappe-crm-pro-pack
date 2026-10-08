"""Automatic campaigns: leads join a running campaign as they qualify.

A campaign whose *send mode* is ``Trigger`` is launched once and then keeps running. Whenever a lead is created, or its
status changes, every such campaign whose event matches looks at that one lead:

1. is the lead in the campaign's audience (its filters or saved segment)?
2. can it receive each channel (valid address, not opted out, WhatsApp consent)?

If so, the lead is *enrolled*: one recipient row per step is written, each due ``day_offset`` days after the enrolment
(not after the campaign started). From there the ordinary engine takes over (batches, rate limit, sending hours, step
conditions, stop-on-reply, retries, tracking), so an automatic campaign sends exactly like any other.

A lead is enrolled once per campaign: the recipient rows have a unique key, so editing the lead again, or a second
event, cannot start the journey a second time. Enrolling never raises into the save of the lead.
"""

import frappe
from frappe import _
from frappe.utils import now_datetime

from crm_addons import debuglog
from crm_addons.campaigns import audience, engine
from crm_addons.campaigns.common import CAMPAIGN, RECIPIENT, automation_ready

CREATED = "Lead created"
STATUS_CHANGED = "Lead status changed"


def _skip_now():
	flags = frappe.flags
	return bool(flags.in_install or flags.in_migrate or flags.in_patch or flags.in_uninstall)


def on_lead_insert(doc, method=None):
	"""``doc_events`` hook: CRM Lead after_insert."""
	_handle(doc, CREATED)


def on_lead_update(doc, method=None):
	"""``doc_events`` hook: CRM Lead on_update."""
	try:
		changed = doc.has_value_changed("status")
	except Exception:
		changed = False
	if changed:
		_handle(doc, STATUS_CHANGED)


def _handle(doc, event):
	if _skip_now() or not frappe.db.exists("DocType", CAMPAIGN):
		return
	from crm_addons.campaigns import automation

	automation.on_lead_event(doc, event)
	try:
		campaigns = frappe.get_all(
			CAMPAIGN,
			filters={"status": "Running", "send_mode": engine.TRIGGER, "trigger_event": event, **({"automation": ["is", "not set"]} if automation_ready() else {})},
			fields=["name", "trigger_status"],
		)
		for campaign in campaigns:
			if event == STATUS_CHANGED and campaign.trigger_status and campaign.trigger_status != doc.status:
				continue
			enroll(campaign.name, doc.name)
	except Exception:
		frappe.log_error(frappe.get_traceback(), "CRM Campaign: automatic enrolment failed")


def enroll(campaign_name, lead_name):
	"""Enrol one lead in one automatic campaign. Returns the number of recipient rows written (0: not eligible, or
	already enrolled)."""
	doc = frappe.get_doc(CAMPAIGN, campaign_name)
	if doc.status != "Running" or doc.send_mode != engine.TRIGGER:
		return 0
	frappe.db.savepoint("campaign_enroll")
	try:
		return _enroll(doc, lead_name)
	except Exception:
		frappe.db.rollback(save_point="campaign_enroll")
		frappe.log_error(frappe.get_traceback(), f"CRM Campaign {campaign_name}: could not enrol {lead_name}")
		return 0


def _enroll(doc, lead_name):
	owner = doc.get("campaign_owner") or doc.owner
	row = audience.match_lead(audience.definition_of(doc), lead_name, owner)
	if not row:
		return 0
	if frappe.db.exists(RECIPIENT, {"campaign": doc.name, "recipient_id": lead_name}):
		return 0  # already enrolled
	evaluator = audience.Evaluator(engine.channels_of(doc), doc.consent_confirmed)
	per_lead = evaluator.evaluate_page([row])
	_mark_shared_addresses(doc, per_lead)
	now = now_datetime()
	values = engine.recipient_values(doc, per_lead, now, now)
	if not values:
		return 0
	frappe.db.bulk_insert(RECIPIENT, engine.RECIPIENT_COLUMNS, values, ignore_duplicates=True)
	frappe.db.sql(f"UPDATE `tab{CAMPAIGN}` SET total_recipients = IFNULL(total_recipients, 0) + %s WHERE name = %s", (len(values), doc.name))
	debuglog.log("ENROLLED", campaign=doc.name, lead=lead_name, rows=len(values))
	return len(values)


def _mark_shared_addresses(doc, per_lead):
	"""A running campaign sees leads one at a time, so the 'same address twice' rule needs the rows already written."""
	for _row, per in per_lead:
		for channel, (address, reason) in list(per.items()):
			if reason or not address:
				continue
			column = "email" if channel == "Email" else "whatsapp_number"
			taken = frappe.db.exists(RECIPIENT, {"campaign": doc.name, "channel": channel, column: address, "status": ["not in", ["Skipped", "Cancelled"]]})
			if taken:
				per[channel] = (address, _("Duplicate email in this campaign") if channel == "Email" else _("Duplicate number in this campaign"))
