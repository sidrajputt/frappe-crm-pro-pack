"""List clean-up: addresses that can never receive a message stop being messaged.

A *hard* failure is one that will not fix itself: an email address that does not exist, a mailbox that bounced or marked
the mail as spam, a phone number that is not on WhatsApp. Those go on the opt-out list (source ``Bounce`` or ``Invalid
Number``), so every later campaign skips them and the sender's reputation is not spent on dead addresses. Temporary
trouble (a full mailbox, a rate limit, a provider outage) is never suppressed.

``scan_history`` applies the same rule to failures that happened before this existed.
"""

import re

import frappe
from frappe import _
from frappe.utils import add_to_date, cint, cstr, now_datetime

from crm_addons.campaigns import optout
from crm_addons.campaigns.common import RECIPIENT

OPT_OUT = "CRM Campaign Opt Out"
SOURCES = ("Bounce", "Invalid Number")
HARD_EMAIL_STATES = ("Bounced", "Rejected", "Marked As Spam")
_EMAIL_PERMANENT = re.compile(
	r"\b5\.1\.[1-2]\b|\b5\.7\.1\b|user unknown|no such user|mailbox (?:not found|unavailable|does not exist)|"
	r"recipient (?:address )?rejected|address rejected|invalid (?:recipient|address|mailbox)|(?:address|mailbox|user|recipient) does not exist|hard bounce|(?<!soft-)(?<!soft )\bbounced\b",
	re.I,
)
_WHATSAPP_PERMANENT = re.compile(
	r"\b131026\b|not (?:a )?valid whatsapp|not (?:registered|on) (?:on )?whatsapp|no whatsapp account|undeliverable|invalid phone number",
	re.I,
)


def hard_failure(channel, reason="", provider_status=""):
	"""True when this failure means the address itself is no good."""
	if channel == "Email":
		return cstr(provider_status) in HARD_EMAIL_STATES or bool(_EMAIL_PERMANENT.search(cstr(reason)))
	if channel == "WhatsApp":
		return bool(_WHATSAPP_PERMANENT.search(cstr(reason) + " " + cstr(provider_status)))
	return False


def suppress(row, reason=""):
	"""Put the failed address on the opt-out list. ``row`` has channel, email / whatsapp_number and recipient_id."""
	channel = row.get("channel")
	value = row.get("email") if channel == "Email" else row.get("whatsapp_number")
	if not value:
		return None
	source = "Bounce" if channel == "Email" else "Invalid Number"
	text = _("The address failed permanently: {0}").format(cstr(reason)[:180]) if reason else _("The address failed permanently.")
	return optout.add_opt_out(channel, value, source=source, reason=text, lead=row.get("recipient_id"))


def on_failed(recipient, reason="", provider_status=""):
	"""Called whenever a recipient ends as Failed. Never raises."""
	try:
		row = frappe.db.get_value(RECIPIENT, recipient, ["channel", "email", "whatsapp_number", "recipient_id"], as_dict=True)
		if row and hard_failure(row.channel, reason, provider_status):
			return suppress(row, reason)
	except Exception:
		frappe.log_error(frappe.get_traceback(), "CRM Campaign: could not clean up a failed address")
	return None


def scan_history(days=90, limit=5000):
	"""Suppress the permanently failed addresses among the failures of the last ``days`` days. Returns how many were added."""
	since = add_to_date(now_datetime(), days=-cint(days or 90))
	rows = frappe.db.sql(
		f"""SELECT channel, email, whatsapp_number, recipient_id, failure_reason, provider_status FROM `tab{RECIPIENT}`
		WHERE status = 'Failed' AND IFNULL(failed_at, modified) > %s ORDER BY modified DESC LIMIT %s""",
		(since, cint(limit)),
		as_dict=True,
	)
	added = 0
	for row in rows:
		if hard_failure(row.channel, row.failure_reason, row.provider_status) and suppress(row, row.failure_reason):
			added += 1
	return added


def list_suppressed(channel=None, source=None, search=None, start=0, page_length=25):
	filters = {"source": ["in", [source] if source in SOURCES else list(SOURCES)]}
	if channel in ("Email", "WhatsApp"):
		filters["channel"] = channel
	or_filters = [["value", "like", f"%{search}%"]] if search else None
	rows = frappe.get_all(
		OPT_OUT, filters=filters, or_filters=or_filters, fields=["name", "channel", "value", "source", "reason", "lead", "creation"],
		order_by="creation desc", limit_start=cint(start), limit_page_length=min(cint(page_length) or 25, 200),
	)
	names = {r.lead for r in rows if r.lead}
	leads = {l.name: l.lead_name for l in frappe.get_all("CRM Lead", filters={"name": ["in", list(names) or [""]]}, fields=["name", "lead_name"])}
	for r in rows:
		r["lead_name"] = leads.get(r.lead) or r.lead
	total = frappe.db.count(OPT_OUT, filters) if not or_filters else len(frappe.get_all(OPT_OUT, filters=filters, or_filters=or_filters, pluck="name", limit_page_length=0))
	counts = {
		row.channel: cint(row.n)
		for row in frappe.db.sql("SELECT channel, COUNT(*) AS n FROM `tabCRM Campaign Opt Out` WHERE source IN %s GROUP BY channel", (SOURCES,), as_dict=True)
	}
	return {"rows": rows, "total": cint(total), "counts": counts}


def restore(name):
	"""Take an address off the list (for example after the lead fixed a typo or confirmed the number works)."""
	doc = frappe.get_doc(OPT_OUT, name)
	if doc.source not in SOURCES:
		frappe.throw(_("Only addresses that were removed after a bounce or an invalid number can be restored here."))
	frappe.delete_doc(OPT_OUT, name, ignore_permissions=True)
	return True
