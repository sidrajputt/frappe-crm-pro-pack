"""Opt-outs: one list that every campaign checks before every send.

Email unsubscribe links and WhatsApp STOP replies both land here; managers can also add entries.
Frappe's own global ``Email Unsubscribe`` entries are honoured too.
"""

import re

import frappe
from frappe import _
from frappe.utils import cstr

from crm_addons.campaigns.common import normalize_whatsapp, settings, valid_email

UNSUBSCRIBE_METHOD = "/api/method/crm_addons.campaigns.optout.unsubscribe"
STOP_WORDS = {"stop", "unsubscribe", "stop all", "cancel", "optout", "opt out", "opt-out", "unsub"}


def normalize(channel, value):
	if channel == "Email":
		return valid_email(value)
	return normalize_whatsapp(value, settings().get("default_country_code"))


def opt_key(channel, value):
	return f"{channel}:{value}"


def is_opted_out(channel, value):
	value = normalize(channel, value)
	if not value:
		return False
	return value in opted_out_values(channel, [value])


def opted_out_values(channel, values):
	"""Which of these (already normalized) values are opted out. One query per call."""
	values = [v for v in set(values) if v]
	if not values:
		return set()
	found = {
		row.value
		for row in frappe.get_all(
			"CRM Campaign Opt Out",
			filters={"opt_key": ["in", [opt_key(channel, v) for v in values]]},
			fields=["value"],
		)
	}
	if channel == "Email":
		found |= {
			row.email.lower()
			for row in frappe.get_all(
				"Email Unsubscribe", filters={"email": ["in", values], "global_unsubscribe": 1}, fields=["email"]
			)
		}
	return found


def add_opt_out(channel, value, source="Manual", reason="", lead=None):
	"""Record an opt-out. Safe to call twice."""
	value = normalize(channel, value)
	if not value:
		return None
	key = opt_key(channel, value)
	if frappe.db.exists("CRM Campaign Opt Out", {"opt_key": key}):
		return None
	doc = frappe.get_doc(
		{
			"doctype": "CRM Campaign Opt Out",
			"channel": channel,
			"value": value,
			"source": source,
			"reason": reason,
			"lead": lead if lead and frappe.db.exists("CRM Lead", lead) else None,
			"opt_key": key,
		}
	)
	frappe.db.savepoint("campaign_opt_out")  # a lost race must not roll back the caller's other writes
	try:
		doc.insert(ignore_permissions=True)
	except (frappe.DuplicateEntryError, frappe.UniqueValidationError):
		frappe.db.rollback(save_point="campaign_opt_out")
		return None
	if doc.lead and source in ("Unsubscribe Link", "WhatsApp Reply", "Manual"):
		from crm_addons.campaigns import rules  # a person choosing to stop (not a dead address): campaigns may react

		rules.fire_for_lead(doc.lead, "Opted out")
	return doc.name


@frappe.whitelist(allow_guest=True)
def unsubscribe(email, doctype=None, name=None):
	"""Target of the unsubscribe link in campaign emails. The link is signed by Frappe; an edited or
	missing signature is refused before anything is written."""
	from frappe.utils.verified_command import verify_request

	if not frappe.flags.in_test and not verify_request():
		return
	lead = name if doctype == "CRM Lead" else None
	add_opt_out("Email", email, source="Unsubscribe Link", reason=_("Clicked the unsubscribe link"), lead=lead)
	# Also tell Frappe's own mail system, so other emails honour it as well.
	frappe.db.savepoint("campaign_unsubscribe")
	try:
		if not frappe.db.exists("Email Unsubscribe", {"email": email, "global_unsubscribe": 1}):
			frappe.get_doc({"doctype": "Email Unsubscribe", "email": email, "global_unsubscribe": 1}).insert(
				ignore_permissions=True
			)
	except Exception:
		frappe.db.rollback(save_point="campaign_unsubscribe")
	if not frappe.flags.in_test:
		frappe.db.commit()  # nosemgrep: guest endpoint, nothing else commits after this
	frappe.respond_as_web_page(
		_("Unsubscribed"), _("{0} will not receive these emails any more.").format(frappe.utils.escape_html(email)),
		indicator_color="green",
	)


def on_whatsapp_message(doc, method=None):
	"""``doc_events`` hook on WhatsApp Message: a reply of STOP (or similar) opts that number out."""
	try:
		if doc.get("type") != "Incoming" or doc.get("content_type") not in ("text", "button", None, ""):
			return
		text = re.sub(r"\s+", " ", cstr(doc.get("message"))).strip().lower().strip(".!")
		if text not in STOP_WORDS:
			return
		lead = None
		if doc.get("reference_doctype") == "CRM Lead":
			lead = doc.get("reference_name")
		add_opt_out("WhatsApp", doc.get("from"), source="WhatsApp Reply", reason=_("Replied {0}").format(text), lead=lead)
	except Exception:
		frappe.log_error(frappe.get_traceback(), "CRM Campaign: could not process a WhatsApp opt-out")
