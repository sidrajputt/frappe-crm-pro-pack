"""Shared constants and helpers for the Campaign Manager."""

import hashlib
import re
from zoneinfo import ZoneInfo

import frappe
from frappe import _
from frappe.utils import add_days, cint, cstr, getdate, validate_email_address

LEAD = "CRM Lead"
CAMPAIGN = "CRM Campaign"
RECIPIENT = "CRM Campaign Recipient"
CHANNELS = ("Email", "WhatsApp")
DEFAULT_TIMEZONE = "Asia/Kolkata"  # campaigns, sending hours and automations are in Indian time unless a record says otherwise

# Rank of the "forward" delivery states. A late or repeated provider callback can only move a
# recipient forward, never back, so a webhook arriving out of order cannot undo a newer state.
RANK = {"Pending": 0, "Queued": 1, "Sending": 2, "Sent": 3, "Delivered": 4, "Read": 5}
TERMINAL = ("Failed", "Skipped", "Cancelled")
ACTIVE_STATUSES = ("Running", "Queued")

# What each campaign status allows. The browser never sets status; the engine does.
ACTIONS = {
	"Draft": ("edit", "launch", "schedule", "duplicate", "delete"),
	"Scheduled": ("edit", "launch", "cancel", "duplicate"),
	"Queued": ("cancel", "analytics", "recipients"),
	"Running": ("pause", "cancel", "retry", "analytics", "recipients", "duplicate"),
	"Paused": ("resume", "cancel", "retry", "analytics", "recipients", "duplicate"),
	"Completed": ("retry", "duplicate", "analytics", "recipients"),
	"Cancelled": ("duplicate", "analytics", "recipients", "delete"),
	"Failed": ("retry", "duplicate", "analytics", "recipients"),
}

WA_MARKER = "CRMCAMP:"  # stored in WhatsApp Message.bulk_message_reference to find the recipient again


def settings():
	return frappe.get_cached_doc("CRM Addons Settings")


def setting_int(campaign, campaign_field, settings_field, default, minimum=1):
	value = cint(campaign.get(campaign_field)) or cint(settings().get(settings_field)) or default
	return max(minimum, value)


def dedupe_key(campaign, step_idx, channel, recipient_id):
	"""One row per campaign + step + channel + lead: the database refuses a second one."""
	raw = f"{campaign}|{cint(step_idx)}|{channel}|{recipient_id}"
	return hashlib.sha1(raw.encode()).hexdigest()


def valid_email(value):
	value = cstr(value).strip().lower()
	return value if value and validate_email_address(value) else None


def normalize_whatsapp(number, default_country_code=None):
	"""Digits in Meta's international format (no +, no spaces), or None when it cannot be one.

	* ``+91 98765 43210`` and ``0091...`` are international already.
	* With a default country code configured, a national number of up to 10 digits gets it.
	* Without one, a number has to arrive in international form (11 to 15 digits).
	"""
	raw = re.sub(r"[\s\-().]", "", cstr(number))
	if not raw:
		return None
	international = raw.startswith("+")
	if raw.startswith("00"):
		raw, international = raw[2:], True
	digits = raw.lstrip("+")
	if not digits.isdigit():
		return None
	if not international:
		code = re.sub(r"\D", "", cstr(default_country_code))
		digits = digits.lstrip("0")
		if code and len(digits) <= 10:
			digits = code + digits
	return digits if 8 <= len(digits) <= 15 and (international or len(digits) >= 11) else None


def valid_timezone(name):
	try:
		ZoneInfo(name)
		return True
	except Exception:
		return False


def whatsapp_installed():
	return bool(frappe.db.exists("DocType", "WhatsApp Message") and frappe.db.exists("DocType", "WhatsApp Templates"))


def default_whatsapp_account():
	"""The default outgoing account of frappe_whatsapp, if it is active."""
	if not whatsapp_installed():
		return None
	row = frappe.db.get_value("WhatsApp Account", {"is_default_outgoing": 1}, ["name", "status"], as_dict=True)
	return row.name if row and cstr(row.status).lower() == "active" else None


def user_for(campaign):
	return campaign.get("campaign_owner") or campaign.owner


def throw_if(condition, message):
	if condition:
		frappe.throw(_(message))


# -- attachments ---------------------------------------------------------------------------------------------

DEFAULT_ATTACHMENT_MB = 10


def attachment_limit_bytes():
	"""Total size of the files sent with one email. Setting ``campaign_max_attachment_mb`` (default 10)."""
	return (cint(settings().get("campaign_max_attachment_mb")) or DEFAULT_ATTACHMENT_MB) * 1024 * 1024


def parse_url_list(raw):
	"""A JSON list (or list) of file urls from the browser -> clean list of strings."""
	import json

	if not raw:
		return []
	try:
		data = json.loads(raw) if isinstance(raw, str) else list(raw)
	except ValueError:
		frappe.throw(_("The attachment list is not valid."))
	out = []
	for item in data if isinstance(data, list) else []:
		url = item.get("file_url") if isinstance(item, dict) else item
		url = cstr(url).strip()
		if url and url not in out:
			out.append(url)
	return out


def files_for_urls(urls):
	"""File rows for these urls. Raises for an url that is not a File of this site."""
	if not urls:
		return []
	rows = frappe.get_all("File", filters={"file_url": ["in", urls]}, fields=["name", "file_url", "file_name", "file_size", "is_private", "attached_to_doctype", "attached_to_name"])
	found = {r.file_url: r for r in rows}
	missing = [u for u in urls if u not in found]
	if missing:
		frappe.throw(_("Attachment {0} was not found. Upload it again.").format(frappe.bold(missing[0].split("/")[-1])))
	return [found[u] for u in urls]


def check_attachment_size(files):
	total = sum(cint(f.get("file_size")) for f in files)
	limit = attachment_limit_bytes()
	if total > limit:
		frappe.throw(
			_("Attachments total {0} MB, more than the {1} MB allowed per email.").format(round(total / 1048576, 1), round(limit / 1048576))
		)
	return total


def date_range(from_date=None, to_date=None):
	"""``(start, end)`` for an inclusive day range in the site's time zone (Frappe stores naive datetimes in it).

	``start`` is ``YYYY-MM-DD 00:00:00`` of the first day and ``end`` is midnight of the day *after* the last day, so
	filter with ``>= start`` and ``< end``: the whole end day counts, down to the last fraction of a second. Either
	side may be empty (open range) and a reversed range is swapped."""
	a, b = (getdate(from_date) if from_date else None), (getdate(to_date) if to_date else None)
	if a and b and a > b:
		a, b = b, a
	return (f"{a} 00:00:00" if a else None), (f"{add_days(b, 1)} 00:00:00" if b else None)


# When a recipient "happened": the moment it was sent, else when it failed, else when the row was created
# (waiting and skipped rows). Every report range filters on this, so totals, charts and tables agree.
ACTIVITY = "COALESCE({a}.sent_at, {a}.failed_at, {a}.creation)"


def activity_clause(alias, from_date=None, to_date=None):
	"""``(sql, values)`` restricting recipient rows (table alias ``alias``) to a date range; ``("", {})`` when open."""
	start, end = date_range(from_date, to_date)
	expr = ACTIVITY.format(a=alias)
	parts, values = [], {}
	if start:
		parts.append(f" AND {expr} >= %(act_from)s")
		values["act_from"] = start
	if end:
		parts.append(f" AND {expr} < %(act_to)s")
		values["act_to"] = end
	return "".join(parts), values


def email_account_problem():
	"""Why no campaign email can go out on this site, or None. Frappe's mail queue needs an outgoing
	Email Account marked as the default one (or one matching the sender); having an outgoing
	account that is not the default still makes every send fail."""
	if frappe.db.exists("Email Account", {"enable_outgoing": 1, "default_outgoing": 1}):
		return None
	if frappe.db.exists("Email Account", {"enable_outgoing": 1}):
		return _("No Email Account is set as the default for outgoing mail. Open Email Account, pick the one to send from and tick 'Default Outgoing'.")
	return _("No outgoing Email Account is set up on this site. Add one under Email Account (enable Outgoing and Default Outgoing).")


def cached_read(namespace, key, seconds, compute):
	"""``compute()`` at most once per ``seconds`` for the same site, user and ``key``.

	For read-only numbers that the pages ask for again and again while someone types or while a campaign runs (the
	audience scan, reply counts, saved-segment counts). A launch never uses it, so what is sent is always based on a
	fresh scan. Skipped under test, so a test always sees its own latest data."""
	if frappe.flags.in_test:
		return compute()
	from crm_addons.campaigns import guard

	return guard.ttl_cached((namespace, frappe.local.site, frappe.session.user, key), seconds, compute)


def automation_ready():
	"""Has this site been migrated for automations (their doctypes exist)?"""
	return bool(frappe.db.exists("DocType", "CRM Campaign Automation") and frappe.get_meta(CAMPAIGN).has_field("automation"))


MIGRATE_HINT = "The database needs an update for this feature. Ask your administrator to run: bench --site {site} migrate (and then restart the bench)."
