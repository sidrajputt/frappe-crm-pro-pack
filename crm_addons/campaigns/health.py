"""Campaign health check: tell the owner when a running campaign is in trouble instead of letting it fail quietly.

Every five minutes, for each running campaign (and each paused one, because that is when people forget it):

* **High failure rate**: in the last hour at least ``campaign_alert_min_messages`` messages were attempted and the failed
  share is at or above ``campaign_alert_failure_percent``.
* **Sending credentials**: the recent failures say the login was refused (an expired WhatsApp token, a wrong mail password).
* **No way to send**: messages are waiting but the site has no outgoing Email Account, or no active WhatsApp account.

A problem is written on the campaign (``health_note``, shown as a banner in the Campaign Manager) and the owner gets a
notification. The same problem is not repeated for six hours; a campaign that recovers loses its banner.
"""

import re

import frappe
from frappe import _
from frappe.utils import add_to_date, cint, cstr, get_datetime, now_datetime

from crm_addons import debuglog
from crm_addons.campaigns.common import CAMPAIGN, RECIPIENT, default_whatsapp_account, email_account_problem, settings, whatsapp_installed

REPEAT_HOURS = 6
WINDOW_MINUTES = 60
_LOGIN = re.compile(
	r"authentication (?:failed|error)|auth(?:entication)? (?:token )?(?:expired|invalid)|invalid (?:oauth )?(?:access )?token|"
	r"access token|\b190\b|\b401\b|\b535\b|login (?:failed|denied)|credentials|unauthori[sz]ed|permission denied",
	re.I,
)


def _percent(failed, total):
	return round(100.0 * failed / total, 1) if total else 0.0


def problems(campaign):
	"""The list of plain-language problems for one campaign (empty when it is healthy)."""
	cfg = settings()
	if not cint(cfg.get("campaign_alerts_enabled", 1)):
		return []
	threshold = cfg.get("campaign_alert_failure_percent") or 30
	minimum = cint(cfg.get("campaign_alert_min_messages")) or 20
	since = add_to_date(now_datetime(), minutes=-WINDOW_MINUTES)
	out = []
	row = frappe.db.sql(
		f"""SELECT SUM(status='Failed' AND failed_at > %(since)s), SUM(status IN ('Sent','Delivered','Read') AND sent_at > %(since)s)
		FROM `tab{RECIPIENT}` WHERE campaign=%(c)s""",
		{"c": campaign.name, "since": since},
	)[0]
	failed, sent = cint(row[0]), cint(row[1])
	attempted = failed + sent
	if attempted >= minimum and _percent(failed, attempted) >= float(threshold):
		out.append(_("{0}% of the last {1} messages failed.").format(_percent(failed, attempted), attempted))
	if failed:
		reasons = frappe.get_all(
			RECIPIENT, filters={"campaign": campaign.name, "status": "Failed", "failed_at": [">", since]}, pluck="failure_reason", limit_page_length=50,
		)
		if sum(1 for r in reasons if _LOGIN.search(cstr(r))) >= max(3, len(reasons) // 2):
			out.append(_("The sending account refused the login. Check the email password or the WhatsApp access token."))
	waiting = frappe.db.sql(
		f"SELECT channel, COUNT(*) FROM `tab{RECIPIENT}` WHERE campaign=%s AND status='Pending' AND (due_at IS NULL OR due_at <= %s) GROUP BY channel",
		(campaign.name, now_datetime()),
	)
	waiting = {c: n for c, n in waiting}
	if waiting.get("Email") and email_account_problem():
		out.append(cstr(email_account_problem()))
	if waiting.get("WhatsApp") and whatsapp_installed() and not default_whatsapp_account():
		out.append(_("No active default WhatsApp account, so WhatsApp messages cannot be sent."))
	return out


def _notify(campaign, text):
	users = {u for u in (campaign.get("campaign_owner"), campaign.owner) if u and u not in ("Administrator", "Guest")} or {"Administrator"}
	for user in users:
		try:
			frappe.get_doc(
				{
					"doctype": "Notification Log",
					"subject": _("Campaign {0} needs attention").format(campaign.campaign_name),
					"email_content": text,
					"for_user": user,
					"type": "Alert",
					"document_type": CAMPAIGN,
					"document_name": campaign.name,
				}
			).insert(ignore_permissions=True)
		except Exception:
			frappe.log_error(frappe.get_traceback(), "CRM Campaign: could not notify about a campaign problem")


@debuglog.traced("campaign.health_check")
def check():
	"""Scheduler (every 5 minutes)."""
	for name in frappe.get_all(CAMPAIGN, filters={"status": ["in", ["Running", "Paused"]]}, pluck="name"):
		try:
			check_campaign(frappe.get_doc(CAMPAIGN, name))
		except Exception:
			frappe.log_error(frappe.get_traceback(), f"CRM Campaign: health check failed for {name}")
	# a finished campaign no longer shows a warning
	frappe.db.sql(
		f"UPDATE `tab{CAMPAIGN}` SET health_note = NULL WHERE health_note IS NOT NULL AND status NOT IN ('Running','Paused')"
	)
	frappe.db.commit()  # nosemgrep: frappe-manual-commit -- scheduler job


def check_campaign(campaign, now=None):
	"""Returns the list of problems found (and writes / clears the banner, notifying when a problem is new)."""
	now = now or now_datetime()
	found = problems(campaign)
	note = " ".join(found)
	if not found:
		if campaign.get("health_note"):
			frappe.db.set_value(CAMPAIGN, campaign.name, {"health_note": None, "health_alert_at": None}, update_modified=False)
		return []
	last = campaign.get("health_alert_at")
	repeat = not last or campaign.get("health_note") != note or get_datetime(last) < add_to_date(now, hours=-REPEAT_HOURS)
	frappe.db.set_value(CAMPAIGN, campaign.name, "health_note", note, update_modified=False)
	if repeat:
		frappe.db.set_value(CAMPAIGN, campaign.name, "health_alert_at", now, update_modified=False)
		_notify(campaign, note)
		debuglog.log("HEALTH alert", "WARN", campaign=campaign.name, problem=note)
	return found
