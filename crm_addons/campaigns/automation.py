"""Automations: "when this happens to a lead, do these things".

An automation is a rule that lives next to the campaigns, not inside one:

* **When** - a lead is created, its status changes, or it replies / clicks a link / opens or reads a message / has a
  message bounce / opts out (optionally only for the messages of one campaign).
* **Only for leads that match** - optional filters (or a saved segment). No list of leads is chosen up front: the event
  decides who, the filters only narrow it down.
* **Then** - a list of actions, in order: send a sequence of messages, set the lead's status, create a follow-up for the
  lead's owner, or add a note.

A lead goes through an automation **once** (a row in *CRM Automation Run* with a unique key), so editing the lead again or a
repeated webhook never repeats the actions.

"Send messages" reuses the campaign engine: the automation keeps one *managed campaign* (send mode Trigger, linked back by
``CRM Campaign.automation``) holding its message steps, and enrolling a lead is writing that campaign's recipient rows. So
batches, the sending hours, step conditions, tracking, retries and every report work exactly as for a normal campaign, and
the results are one click away. Turning the automation off pauses that campaign; turning it on resumes it.
"""

import hashlib
import json

import frappe
from frappe import _
from frappe.utils import add_to_date, cint, cstr, now_datetime

from crm_addons import debuglog
from crm_addons.campaigns.common import CAMPAIGN, DEFAULT_TIMEZONE, LEAD, MIGRATE_HINT, RECIPIENT, automation_ready

AUTOMATION = "CRM Campaign Automation"
RUN = "CRM Automation Run"
EVENTS = (
	"Lead created", "Lead status changed", "Lead replied", "Lead clicked a link", "Lead opened or read",
	"Message failed or bounced", "Lead opted out",
)
LEAD_EVENTS = EVENTS[:2]
# the message events, as the rules module names them
MESSAGE_EVENTS = {
	"Lead replied": "Replied", "Lead clicked a link": "Clicked a link", "Lead opened or read": "Opened or read",
	"Message failed or bounced": "Failed or bounced", "Lead opted out": "Opted out",
}
ACTIONS = ("Send messages", "Set lead status", "Create a follow-up", "Add a note to the lead")
SENT = ("Sent", "Delivered", "Read")
RECENT_DAYS = 30  # a reply or an opt-out counts as "to a campaign message" when a message went to the lead this recently
MAX_FOLLOW_UP_DAYS = 365


# -- helpers --------------------------------------------------------------------------------------------------------------


def definition_of(doc):
	return {"mode": doc.get("audience_mode") or "CRM Filters", "filters": doc.get("audience_filters"), "selected": None, "saved_view": doc.get("saved_view")}


def owner_of(doc):
	return doc.get("automation_owner") or doc.owner


def sends_messages(doc):
	return any(a.action == "Send messages" for a in doc.get("actions") or [])


def run_key(automation, lead):
	return hashlib.sha1(f"{automation}|{lead}".encode()).hexdigest()


def _recent_sent(lead, campaign=None):
	since = add_to_date(now_datetime(), days=-RECENT_DAYS)
	filters = {"recipient_type": LEAD, "recipient_id": lead, "status": ["in", list(SENT)], "sent_at": [">", since]}
	if campaign:
		filters["campaign"] = campaign
	return bool(frappe.db.exists(RECIPIENT, filters))


# -- validation (called from the doctype) ---------------------------------------------------------------------------------


def validate(doc):
	from crm_addons.campaigns import audience
	from crm_addons.campaigns.common import valid_timezone
	from crm_addons.campaigns.doctype.crm_campaign.crm_campaign import CRMCampaign

	doc.automation_owner = doc.automation_owner or frappe.session.user
	doc.timezone = doc.timezone or DEFAULT_TIMEZONE
	if not valid_timezone(doc.timezone):
		frappe.throw(_("{0} is not a time zone.").format(doc.timezone))
	if doc.trigger_event not in EVENTS:
		frappe.throw(_("Choose what starts the automation."))
	if doc.trigger_event != "Lead status changed":
		doc.trigger_status = None
	if doc.trigger_event in LEAD_EVENTS:
		doc.trigger_campaign = None
	if doc.trigger_campaign and not frappe.db.exists(CAMPAIGN, doc.trigger_campaign):
		frappe.throw(_("Campaign {0} was not found.").format(doc.trigger_campaign))
	if doc.audience_mode not in ("CRM Filters", "Saved Segment"):
		frappe.throw(_("An automation matches leads by filters or a saved segment."))
	audience.build_filters(definition_of(doc))  # raises on anything invalid

	if not doc.get("actions"):
		frappe.throw(_("Add at least one thing for the automation to do."))
	sending = 0
	for row in doc.actions:
		value = cstr(row.value).strip()
		row.value = value
		if row.action not in ACTIONS:
			frappe.throw(_("Action {0}: choose what to do.").format(row.idx))
		if row.action == "Send messages":
			sending += 1
			row.value = ""
		elif row.action == "Set lead status":
			if not value or not frappe.db.exists("CRM Lead Status", value):
				frappe.throw(_("Action {0}: choose an existing lead status.").format(row.idx))
		elif row.action == "Create a follow-up":
			days = cint(value) if value.lstrip("-").isdigit() else -1
			if days < 0 or days > MAX_FOLLOW_UP_DAYS:
				frappe.throw(_("Action {0}: the follow-up needs a number of days between 0 and {1}.").format(row.idx, MAX_FOLLOW_UP_DAYS))
		elif not value:
			frappe.throw(_("Action {0}: write the note.").format(row.idx))
	if sending > 1:
		frappe.throw(_("An automation can send one message sequence. Put all the messages in it."))
	if sending:
		if not doc.get("steps"):
			frappe.throw(_("Add at least one message to send."))
		CRMCampaign.validate_steps(doc)  # the same rules as a campaign: order, days, conditions, WhatsApp
		CRMCampaign.validate_window(doc)
	else:
		doc.set("steps", [])


# -- the managed campaign ---------------------------------------------------------------------------------------------------


def _steps_shape(steps):
	return [(s.channel, s.idx) for s in steps]


def _check_structure(doc, campaign):
	"""Once leads were enrolled the sequence can be edited (content) or extended, not restructured: their rows point at step
	numbers."""
	if not frappe.db.exists(RECIPIENT, {"campaign": campaign.name}):
		return
	old, new = [s.channel for s in campaign.steps], [s.channel for s in doc.steps]
	if len(new) < len(old) or new[: len(old)] != old:
		frappe.throw(
			_("This automation has already messaged leads, so its steps cannot be removed, reordered or switched to another channel. You can change what a step says or add steps at the end. To start a different sequence, create a new automation.")
		)


def _copy_settings(doc, campaign):
	campaign.campaign_name = _("Automation: {0}").format(doc.automation_name)[:140]
	campaign.campaign_type = "Follow-up"
	campaign.campaign_owner = owner_of(doc)
	campaign.audience_mode = doc.audience_mode
	campaign.audience_filters = doc.audience_filters
	campaign.saved_view = doc.saved_view
	campaign.selected_records = None
	campaign.send_mode = "Trigger"
	campaign.timezone = doc.timezone
	for field in ("consent_confirmed", "stop_on_reply", "track_clicks", "window_enabled", "window_start", "window_end", "window_weekdays_only"):
		campaign.set(field, doc.get(field))
	campaign.set("steps", [])
	for step in doc.steps:
		campaign.append(
			"steps",
			{k: step.get(k) for k in ("channel", "day_offset", "condition", "email_template", "wa_template", "wa_account", "variable_map", "wa_attach", "attachments")},
		)


def sync(doc):
	"""Keep the managed campaign in step with the automation, and start / pause it with the On switch."""
	from crm_addons.campaigns import engine

	if not sends_messages(doc):
		if doc.campaign:
			_release(doc)
		return
	if doc.campaign and frappe.db.exists(CAMPAIGN, doc.campaign) and frappe.db.get_value(CAMPAIGN, doc.campaign, "status") in ("Cancelled", "Completed", "Failed"):
		# someone ended the managed campaign from the Campaigns page: it keeps its results as an ordinary campaign, and the
		# automation starts a fresh one so that "On" means what it says
		frappe.db.set_value(CAMPAIGN, doc.campaign, "automation", None, update_modified=False)
		doc.db_set("campaign", None, update_modified=False)
		doc.campaign = None
	if doc.campaign and frappe.db.exists(CAMPAIGN, doc.campaign):
		campaign = frappe.get_doc(CAMPAIGN, doc.campaign)
		_check_structure(doc, campaign)
	else:
		campaign = frappe.new_doc(CAMPAIGN)
	_copy_settings(doc, campaign)
	campaign.automation = doc.name
	campaign.flags.automation_sync = True
	campaign.flags.ignore_permissions = True
	if campaign.is_new():
		campaign.insert()
	else:
		campaign.save()
	if doc.campaign != campaign.name:
		doc.db_set("campaign", campaign.name, update_modified=False)
		doc.campaign = campaign.name
	status = frappe.db.get_value(CAMPAIGN, campaign.name, "status")
	if cint(doc.enabled):
		if status == "Draft":
			engine.launch(campaign.name)
		elif status == "Paused":
			engine.resume(campaign.name)
	elif status == "Running":
		engine.pause(campaign.name)


def _release(doc):
	"""The automation no longer sends messages: pause the managed campaign and let it stand on its own with its results."""
	from crm_addons.campaigns import engine

	name = doc.campaign
	if frappe.db.exists(CAMPAIGN, name) and frappe.db.get_value(CAMPAIGN, name, "status") == "Running":
		engine.pause(name)
	frappe.db.set_value(CAMPAIGN, name, "automation", None, update_modified=False)
	doc.db_set("campaign", None, update_modified=False)
	doc.campaign = None


def on_trash(doc):
	"""Deleting an automation keeps what it already sent: its campaign is cancelled and becomes an ordinary campaign."""
	from crm_addons.campaigns import engine

	if doc.campaign and frappe.db.exists(CAMPAIGN, doc.campaign):
		status = frappe.db.get_value(CAMPAIGN, doc.campaign, "status")
		if frappe.db.exists(RECIPIENT, {"campaign": doc.campaign}):
			if status in ("Running", "Paused", "Queued"):
				engine._transition(doc.campaign, "Cancelled", ("Running", "Paused", "Queued"), completed_at=now_datetime())
				frappe.db.sql(f"UPDATE `tab{RECIPIENT}` SET status='Cancelled' WHERE campaign=%s AND status='Pending'", doc.campaign)
			frappe.db.set_value(CAMPAIGN, doc.campaign, "automation", None, update_modified=False)
		else:
			frappe.db.set_value(CAMPAIGN, doc.campaign, "status", "Cancelled", update_modified=False)
			frappe.delete_doc(CAMPAIGN, doc.campaign, force=True, ignore_permissions=True)
	frappe.db.delete(RUN, {"automation": doc.name})


# -- running ---------------------------------------------------------------------------------------------------------------


def _enabled(event):
	if not automation_ready():
		return []  # a site that has not been migrated yet: nothing to run, and no error on every lead that is saved
	return frappe.get_all(AUTOMATION, filters={"enabled": 1, "trigger_event": event}, fields=["name", "trigger_status", "trigger_campaign"])


def on_lead_event(lead, event):
	"""A lead was created, or its status changed. Never raises."""
	try:
		for a in _enabled(event):
			if event == "Lead status changed" and a.trigger_status and a.trigger_status != lead.status:
				continue
			run(a.name, lead.name, event)
	except Exception:
		frappe.log_error(frappe.get_traceback(), "CRM Automation: a lead event failed")


def on_message_event(recipient, message_event):
	"""A recipient replied-to / clicked / opened / bounced (``message_event`` as the rules module names it). Never raises."""
	try:
		event = next((k for k, v in MESSAGE_EVENTS.items() if v == message_event), None)
		row = frappe.db.get_value(RECIPIENT, recipient, ["campaign", "recipient_type", "recipient_id"], as_dict=True) if event else None
		if not row or row.recipient_type != LEAD:
			return
		for a in _enabled(event):
			if a.trigger_campaign and a.trigger_campaign != row.campaign:
				continue
			run(a.name, row.recipient_id, event)
	except Exception:
		frappe.log_error(frappe.get_traceback(), "CRM Automation: a message event failed")


def on_lead_message_event(lead, message_event):
	"""A reply or an opt-out belongs to the lead, not to one message: it counts when a campaign message went to the lead
	recently (any campaign, or the one the automation names). Never raises."""
	try:
		event = next((k for k, v in MESSAGE_EVENTS.items() if v == message_event), None)
		if not event or not lead:
			return
		for a in _enabled(event):
			if _recent_sent(lead, a.trigger_campaign or None):
				run(a.name, lead, event)
	except Exception:
		frappe.log_error(frappe.get_traceback(), "CRM Automation: a reply or opt-out event failed")


def run(name, lead_name, event):
	"""Run one automation for one lead, once. Returns True when it ran."""
	from crm_addons.campaigns import audience

	doc = frappe.get_doc(AUTOMATION, name)
	if not cint(doc.enabled) or not frappe.db.exists(LEAD, lead_name):
		return False
	if audience.match_lead(definition_of(doc), lead_name, owner_of(doc)) is None:
		return False
	frappe.db.savepoint("automation_run")
	try:
		frappe.get_doc({"doctype": RUN, "automation": name, "lead": lead_name, "event": event, "run_key": run_key(name, lead_name)}).insert(ignore_permissions=True)
	except (frappe.DuplicateEntryError, frappe.UniqueValidationError):
		frappe.db.rollback(save_point="automation_run")
		return False  # this lead already went through this automation
	done = 0
	for action in doc.actions:
		done += _do(doc, lead_name, event, action)
	debuglog.log("AUTOMATION", automation=name, lead=lead_name, trigger=event, actions=done)
	return True


def _do(doc, lead_name, event, action):
	from crm_addons.campaigns import rules, triggers

	frappe.db.savepoint("automation_action")
	try:
		if action.action == "Send messages":
			return 1 if doc.campaign and triggers.enroll(doc.campaign, lead_name) else 0
		with rules._as_administrator():
			if action.action == "Set lead status":
				return rules._set_status(lead_name, action.value)
			if action.action == "Create a follow-up":
				return rules._follow_up(lead_name, cint(action.value), doc.automation_name, event, remark=_("Automation {0}: {1}.").format(doc.automation_name, _(event)))
			return rules._note(lead_name, action.value, doc.automation_name)
	except Exception:
		frappe.db.rollback(save_point="automation_action")
		frappe.log_error(frappe.get_traceback(), f"CRM Automation {doc.name}: '{action.action}' failed for {lead_name}")
		return 0


# -- for the Campaign Manager page ---------------------------------------------------------------------------------------


def _check_user():
	from crm_addons.campaigns.api import _check_user as check

	check()
	if not automation_ready():
		frappe.throw(_(MIGRATE_HINT).format(site=frappe.local.site))


def trigger_text(a):
	if a.trigger_event == "Lead status changed":
		return _("A lead's status changes to {0}").format(a.trigger_status) if a.trigger_status else _("A lead's status changes")
	text = {
		"Lead created": _("A new lead is created"), "Lead replied": _("A lead replies"), "Lead clicked a link": _("A lead clicks a link in an email"),
		"Lead opened or read": _("A lead opens or reads a message"), "Message failed or bounced": _("A message to a lead fails or bounces"),
		"Lead opted out": _("A lead opts out"),
	}.get(a.trigger_event, a.trigger_event)
	if a.get("trigger_campaign"):
		text += " " + _("(campaign {0})").format(frappe.db.get_value(CAMPAIGN, a.trigger_campaign, "campaign_name") or a.trigger_campaign)
	return text


def action_text(row):
	if row.action == "Set lead status":
		return _("Set status to {0}").format(row.value)
	if row.action == "Create a follow-up":
		return _("Create a follow-up in {0} day(s)").format(row.value)
	if row.action == "Add a note to the lead":
		return _("Add a note")
	return _("Send messages")


def _summary(doc):
	stats = frappe.db.sql(
		f"SELECT COUNT(*), SUM(creation > %s) FROM `tab{RUN}` WHERE automation = %s", (add_to_date(now_datetime(), days=-7), doc.name)
	)[0]
	messaged = cint(frappe.db.get_value(CAMPAIGN, doc.campaign, "total_recipients")) if doc.campaign else 0
	return {
		"name": doc.name, "automation_name": doc.automation_name, "enabled": cint(doc.enabled), "description": doc.description,
		"trigger_event": doc.trigger_event, "trigger_status": doc.trigger_status, "trigger_campaign": doc.trigger_campaign,
		"trigger": trigger_text(doc), "audience_mode": doc.audience_mode, "has_conditions": bool(
			(doc.audience_mode == "Saved Segment" and doc.saved_view) or (doc.audience_filters and doc.audience_filters.strip() not in ("", "[]"))
		),
		"actions": [{"action": a.action, "value": a.value, "text": action_text(a)} for a in doc.actions],
		"runs": cint(stats[0]), "runs_7d": cint(stats[1]), "messaged": messaged, "campaign": doc.campaign,
		"campaign_status": frappe.db.get_value(CAMPAIGN, doc.campaign, "status") if doc.campaign else None,
		"owner_name": frappe.utils.get_fullname(owner_of(doc)), "modified": doc.modified,
	}


@frappe.whitelist()
def list_automations(search=None):
	_check_user()
	or_filters = [["automation_name", "like", f"%{search}%"]] if search else None
	names = frappe.get_list(AUTOMATION, or_filters=or_filters, pluck="name", order_by="modified desc", limit_page_length=200)
	return [_summary(frappe.get_doc(AUTOMATION, n)) for n in names]


FIELDS = (
	"automation_name", "description", "trigger_event", "trigger_status", "trigger_campaign", "audience_mode", "saved_view", "audience_filters",
	"consent_confirmed", "stop_on_reply", "track_clicks", "window_enabled", "window_start", "window_end", "window_weekdays_only", "timezone",
)
STEP_FIELDS = ("channel", "day_offset", "condition", "email_template", "wa_template", "wa_account", "variable_map", "wa_attach", "attachments")


def _get(name, ptype="read"):
	_check_user()
	if not frappe.db.exists(AUTOMATION, name):
		frappe.throw(_("Automation {0} was not found.").format(name), frappe.DoesNotExistError)
	doc = frappe.get_doc(AUTOMATION, name)
	doc.check_permission(ptype)
	return doc


@frappe.whitelist()
def get_automation(name):
	doc = _get(name)
	data = doc.as_dict()
	data.update(_summary(doc))
	data["actions"] = [{"action": a.action, "value": a.value, "text": action_text(a)} for a in doc.actions]
	return data


@frappe.whitelist()
def save_automation(data, name=None):
	"""Create or update an automation. ``data.enabled`` switches it on or off in the same save."""
	_check_user()
	data = frappe.parse_json(data)
	if name:
		doc = _get(name, "write")
	else:
		doc = frappe.new_doc(AUTOMATION)
		doc.automation_owner = frappe.session.user
	for field in FIELDS:
		if field in data:
			value = data[field]
			if field == "audience_filters" and not isinstance(value, str):
				value = json.dumps(value)
			doc.set(field, value)
	if "enabled" in data:
		doc.enabled = 1 if cint(data["enabled"]) else 0
	if "actions" in data:
		doc.set("actions", [])
		for row in data["actions"] or []:
			doc.append("actions", {"action": row.get("action"), "value": row.get("value")})
	if "steps" in data:
		doc.set("steps", [])
		for step in data["steps"] or []:
			doc.append("steps", {k: step.get(k) for k in STEP_FIELDS if k in step})
	doc.flags.ignore_permissions = False
	doc.save()
	return get_automation(doc.name)


@frappe.whitelist()
def set_enabled(name, enabled):
	doc = _get(name, "write")
	doc.enabled = 1 if cint(enabled) else 0
	doc.save()
	return _summary(doc)


@frappe.whitelist()
def delete_automation(name):
	doc = _get(name, "delete")
	frappe.delete_doc(AUTOMATION, doc.name)
	return True


@frappe.whitelist()
def duplicate_automation(name):
	src = _get(name)
	doc = frappe.new_doc(AUTOMATION)
	for field in FIELDS:
		doc.set(field, src.get(field))
	doc.automation_name = _("{0} (copy)").format(src.automation_name)
	doc.automation_owner = frappe.session.user
	doc.enabled = 0
	for a in src.actions:
		doc.append("actions", {"action": a.action, "value": a.value})
	for s in src.steps:
		doc.append("steps", {k: s.get(k) for k in STEP_FIELDS})
	doc.insert()
	return get_automation(doc.name)


@frappe.whitelist()
def get_runs(name, start=0, page_length=20):
	"""Leads that went through this automation, newest first."""
	doc = _get(name)
	rows = frappe.get_all(
		RUN, filters={"automation": doc.name}, fields=["lead", "event", "creation"], order_by="creation desc", limit_start=cint(start), limit_page_length=min(cint(page_length) or 20, 100)
	)
	names = {l.name: l.lead_name for l in frappe.get_all(LEAD, filters={"name": ["in", [r.lead for r in rows] or [""]]}, fields=["name", "lead_name"])}
	for r in rows:
		r["lead_name"] = names.get(r.lead) or r.lead
	return {"rows": rows, "total": frappe.db.count(RUN, {"automation": doc.name})}
