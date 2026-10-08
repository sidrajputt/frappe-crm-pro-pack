"""Automatic lead updates: "when a lead replies / clicks / opens / bounces / opts out, do this".

A campaign carries a short list of rules (``CRM Campaign Rule``). Each rule is *event -> action*:

* Set lead status        - move the Lead to a status (CRM logs the change like any other)
* Create a follow-up     - a follow-up for the lead's owner, N days from now
* Add a note to the lead - a comment on the Lead's timeline

Each event fires at most once per lead and campaign: the row that saw it is marked in ``events_done`` with one guarded
UPDATE, so a repeated webhook, a second step or two workers cannot run an action twice. A rule never raises into the
code that triggered it (a bounce, a click, a reply): a failing action is logged and the campaign carries on.
"""

from contextlib import contextmanager

import frappe
from frappe import _
from frappe.utils import add_to_date, cint, cstr, escape_html, now_datetime

from crm_addons import debuglog
from crm_addons.campaigns.common import CAMPAIGN, LEAD, RECIPIENT

RULE = "CRM Campaign Rule"
EVENTS = ("Replied", "Clicked a link", "Opened or read", "Failed or bounced", "Opted out")
ACTIONS = ("Set lead status", "Create a follow-up", "Add a note to the lead")
CODE = {"Replied": "replied", "Clicked a link": "clicked", "Opened or read": "opened", "Failed or bounced": "failed", "Opted out": "optout"}
SENT = ("Sent", "Delivered", "Read")
REPLY_WINDOW_DAYS = 30
MAX_FOLLOW_UP_DAYS = 365


# -- validation (called from the campaign's validate) ------------------------------------------------------------


def validate_rules(doc):
	seen = set()
	for row in doc.get("rules") or []:
		if row.event not in EVENTS:
			frappe.throw(_("Lead update {0}: choose when it applies.").format(row.idx))
		if row.action not in ACTIONS:
			frappe.throw(_("Lead update {0}: choose what to do.").format(row.idx))
		value = cstr(row.value).strip()
		row.value = value
		if row.action == "Set lead status":
			if not value or not frappe.db.exists("CRM Lead Status", value):
				frappe.throw(_("Lead update {0}: choose an existing lead status.").format(row.idx))
		elif row.action == "Create a follow-up":
			days = cint(value) if value.lstrip("-").isdigit() else -1
			if days < 0 or days > MAX_FOLLOW_UP_DAYS:
				frappe.throw(_("Lead update {0}: the follow-up needs a number of days between 0 and {1}.").format(row.idx, MAX_FOLLOW_UP_DAYS))
		elif not value:
			frappe.throw(_("Lead update {0}: write the note.").format(row.idx))
		key = (row.event, row.action, value)
		if key in seen:
			frappe.throw(_("Lead update {0} repeats an earlier one.").format(row.idx))
		seen.add(key)


# -- running them ---------------------------------------------------------------------------------------------------


@contextmanager
def _as_administrator():
	"""Rules act for the system, not for whoever triggered them (a lead who clicked a link has no user at all)."""
	# only the user name is switched: ``frappe.set_user`` also resets the request's form data and session id, which the
	# request that triggered this (a lead being saved, a link being opened) still needs afterwards
	session = frappe.local.session
	previous = session.user
	session.user = "Administrator"
	try:
		yield
	finally:
		session.user = previous


def _claim(recipient, lead, campaign, event):
	"""True for exactly one caller per (campaign, lead, event)."""
	code = CODE[event]
	done = frappe.db.sql(
		f"""SELECT 1 FROM `tab{RECIPIENT}` WHERE campaign=%s AND recipient_id=%s
		AND FIND_IN_SET(%s, IFNULL(events_done, '')) LIMIT 1""",
		(campaign, lead, code),
	)
	if done:
		return False
	frappe.db.sql(
		f"""UPDATE `tab{RECIPIENT}` SET events_done = CONCAT_WS(',', NULLIF(events_done, ''), %(code)s)
		WHERE name = %(name)s AND NOT FIND_IN_SET(%(code)s, IFNULL(events_done, ''))""",
		{"code": code, "name": recipient},
	)
	return frappe.db.sql("SELECT ROW_COUNT()")[0][0] == 1


def fire(recipient, event):
	"""Run the campaign's rules for ``event`` on this recipient's lead, and the automations that wait for it. Returns how many
	of the campaign's actions ran."""
	from crm_addons.campaigns import automation

	ran = _fire_rules(recipient, event)
	automation.on_message_event(recipient, event)
	return ran


def _fire_rules(recipient, event):
	try:
		row = frappe.db.get_value(RECIPIENT, recipient, ["campaign", "recipient_type", "recipient_id"], as_dict=True)
		if not row or row.recipient_type != LEAD:
			return 0
		todo = frappe.get_all(RULE, filters={"parent": row.campaign, "parenttype": CAMPAIGN, "event": event}, fields=["action", "value"], order_by="idx asc")
		if not todo or not _claim(recipient, row.recipient_id, row.campaign, event):
			return 0
		ran = 0
		for rule in todo:
			ran += _run(row.campaign, row.recipient_id, event, rule)
		debuglog.log("RULES", campaign=row.campaign, lead=row.recipient_id, event=event, actions=ran)
		return ran
	except Exception:
		frappe.log_error(frappe.get_traceback(), "CRM Campaign: a lead-update rule failed")
		return 0


def _run(campaign, lead_name, event, rule):
	if not frappe.db.exists(LEAD, lead_name):
		return 0
	name = frappe.db.get_value(CAMPAIGN, campaign, "campaign_name") or campaign
	frappe.db.savepoint("campaign_rule")
	try:
		with _as_administrator():
			if rule.action == "Set lead status":
				return _set_status(lead_name, rule.value)
			if rule.action == "Create a follow-up":
				return _follow_up(lead_name, cint(rule.value), name, event)
			return _note(lead_name, rule.value, name)
	except Exception:
		frappe.db.rollback(save_point="campaign_rule")
		frappe.log_error(frappe.get_traceback(), f"CRM Campaign {campaign}: rule '{rule.action}' failed")
		return 0


def _set_status(lead_name, status):
	if not frappe.db.exists("CRM Lead Status", status):
		return 0
	lead = frappe.get_doc(LEAD, lead_name)
	if lead.status == status:
		return 0
	lead.status = status
	lead.save(ignore_permissions=True)
	return 1


def _follow_up(lead_name, days, campaign_name, event, remark=None):
	from crm_addons import followups

	if not followups._enabled():
		return 0
	owner = frappe.db.get_value(LEAD, lead_name, "lead_owner")
	when = add_to_date(now_datetime(), days=days)
	frappe.get_doc(
		{
			"doctype": "CRM Follow Up",
			"reference_doctype": LEAD,
			"reference_docname": lead_name,
			"mode": "Other",
			"assigned_to": owner or "Administrator",
			"followed_up_on": now_datetime(),
			"next_follow_up_on": when,
			"remark": remark or _("Campaign {0}: the lead {1}.").format(campaign_name, _(event).lower()),
		}
	).insert(ignore_permissions=True)
	return 1


def _note(lead_name, text, campaign_name, label=None):
	from crm_addons.followups import _post_comment

	_post_comment(LEAD, lead_name, f"<b>{escape_html(label or _('Campaign'))} {escape_html(campaign_name)}:</b> {escape_html(text)}")
	return 1


# -- events that do not pass through the recipient row ---------------------------------------------------------------


def fire_for_lead(lead_name, event, within_days=REPLY_WINDOW_DAYS):
	"""A reply or an opt-out belongs to the lead, not to one message: run the rules of every campaign that messaged this
	lead recently and has a rule for the event."""
	from crm_addons.campaigns import automation

	automation.on_lead_message_event(lead_name, event)
	try:
		if not lead_name or not frappe.db.exists("DocType", RULE):
			return 0
		since = add_to_date(now_datetime(), days=-within_days)
		rows = frappe.db.sql(
			f"""SELECT r.campaign, MAX(r.name) AS recipient FROM `tab{RECIPIENT}` r
			JOIN `tab{RULE}` ru ON ru.parent = r.campaign AND ru.parenttype = %(ct)s AND ru.event = %(event)s
			WHERE r.recipient_type = %(lead_type)s AND r.recipient_id = %(lead)s AND r.status IN %(sent)s AND r.sent_at > %(since)s
			GROUP BY r.campaign""",
			{"ct": CAMPAIGN, "event": event, "lead_type": LEAD, "lead": lead_name, "sent": SENT, "since": since},
			as_dict=True,
		)
		return sum(fire(r.recipient, event) for r in rows)
	except Exception:
		frappe.log_error(frappe.get_traceback(), "CRM Campaign: could not look up lead-update rules")
		return 0


def on_whatsapp_message(doc, method=None):
	"""``doc_events`` hook: any incoming WhatsApp message from a lead is a reply."""
	if doc.get("type") == "Incoming" and doc.get("reference_doctype") == LEAD:
		from crm_addons.campaigns import optout

		if " ".join(cstr(doc.get("message")).split()).lower().strip(".!") in optout.STOP_WORDS:
			return  # "STOP" is an opt-out, not an interested reply
		fire_for_lead(doc.get("reference_name"), "Replied")


def on_communication(doc, method=None):
	"""``doc_events`` hook: an email received on a lead is a reply."""
	if doc.get("sent_or_received") == "Received" and doc.get("communication_type") == "Communication" and doc.get("reference_doctype") == LEAD:
		fire_for_lead(doc.get("reference_name"), "Replied")
