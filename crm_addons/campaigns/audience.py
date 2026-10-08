"""Who is in a campaign, resolved on the server.

The browser sends a *definition* (filters, a saved segment, or selected lead names). It is validated
here, run through ``frappe.get_list`` as the acting user (so Lead permissions apply), and read in
pages by name - nothing is ever held in browser memory, and 50,000 leads are just 50 pages.
"""

import json

import frappe
from frappe import _
from frappe.utils import cint, cstr

from crm_addons import debuglog
from crm_addons.campaigns import optout
from crm_addons.campaigns.common import LEAD, normalize_whatsapp, settings, valid_email

PAGE = 1000
MAX_SELECTED = 20000
OPERATORS = {
	"=", "!=", ">", "<", ">=", "<=", "like", "not like", "in", "not in", "between", "is", "descendants of",
	"not descendants of",
}
STANDARD = {"name", "creation", "modified", "owner"}
_NO_FILTER = {"Section Break", "Column Break", "Tab Break", "HTML", "Button", "Table", "Table MultiSelect", "Password"}


def _filterable():
	meta = frappe.get_meta(LEAD)
	return STANDARD | {f.fieldname for f in meta.fields if f.fieldtype not in _NO_FILTER and f.fieldname}


def parse_json(raw, default):
	if raw in (None, ""):
		return default
	if isinstance(raw, (list, dict)):
		return raw
	try:
		return json.loads(raw)
	except ValueError:
		frappe.throw(_("The audience definition is not valid JSON."))


def clean_filters(rows):
	"""[[field, op, value], ...] -> validated list. Anything unexpected is refused, not ignored."""
	allowed = _filterable()
	out = []
	for row in parse_json(rows, []):
		if not isinstance(row, (list, tuple)) or len(row) != 3:
			frappe.throw(_("Each filter must be [field, operator, value]."))
		field, op, value = row
		op = cstr(op).lower()
		if field not in allowed:
			frappe.throw(_("{0} is not a field of the Lead and cannot be used as a filter.").format(frappe.bold(cstr(field))))
		if op not in OPERATORS:
			frappe.throw(_("The operator {0} is not allowed.").format(frappe.bold(op)))
		if op in ("in", "not in") and not isinstance(value, (list, tuple)):
			value = [v.strip() for v in cstr(value).split(",") if v.strip()]
		if op == "between" and not (isinstance(value, (list, tuple)) and len(value) == 2):
			frappe.throw(_("A 'between' filter needs two values."))
		out.append([LEAD, field, op, value])
	return out


def _segment_filters(view_name):
	if not frappe.db.exists("CRM View Settings", view_name):
		frappe.throw(_("The saved segment was not found."))
	view = frappe.db.get_value("CRM View Settings", view_name, ["dt", "user", "public", "filters"], as_dict=True)
	if view.dt != LEAD:
		frappe.throw(_("Only Lead segments can be used for campaigns."))
	if not (cint(view.public) or view.user == frappe.session.user or "System Manager" in frappe.get_roles()):
		frappe.throw(_("You cannot use this saved segment."), frappe.PermissionError)
	raw = parse_json(view.filters, {})
	rows = []
	for field, value in (raw.items() if isinstance(raw, dict) else []):
		if isinstance(value, (list, tuple)) and len(value) == 2 and cstr(value[0]).lower() in OPERATORS:
			rows.append([field, value[0], value[1]])
		else:
			rows.append([field, "=", value])
	return clean_filters(rows)


def definition_of(campaign):
	return {
		"mode": campaign.audience_mode,
		"filters": campaign.audience_filters,
		"selected": campaign.selected_records,
		"saved_view": campaign.saved_view,
	}


def build_filters(definition):
	mode = definition.get("mode") or "CRM Filters"
	if mode == "Selected Records":
		names = parse_json(definition.get("selected"), [])
		if not isinstance(names, list) or not all(isinstance(n, str) for n in names):
			frappe.throw(_("Selected records must be a list of Lead names."))
		if len(names) > MAX_SELECTED:
			frappe.throw(_("Select at most {0} leads, or use filters.").format(MAX_SELECTED))
		return [[LEAD, "name", "in", names or ["__none__"]]]
	if mode == "Saved Segment":
		if not definition.get("saved_view"):
			frappe.throw(_("Choose a saved segment."))
		return _segment_filters(definition["saved_view"])
	if mode == "CRM Filters":
		return clean_filters(definition.get("filters"))
	frappe.throw(_("Unknown audience type {0}.").format(mode))


def _fields():
	have = {f.fieldname for f in frappe.get_meta(LEAD).fields}
	wanted = ["name", "lead_name", "first_name", "last_name", "email", "mobile_no", "phone", "lead_owner", "status", "crm_wa_opt_in"]
	return [f for f in wanted if f in have or f == "name"]


def count(definition):
	filters = build_filters(definition)
	rows = frappe.get_list(LEAD, filters=filters, fields=["count(name) as c"])
	return cint(rows[0].c) if rows else 0


def sample(definition, start=0, page_length=20):
	filters = build_filters(definition)
	fields = _fields()
	return frappe.get_list(
		LEAD, filters=filters, fields=fields, order_by="modified desc", limit_start=cint(start),
		limit_page_length=min(cint(page_length) or 20, 100),
	)


def iter_pages(definition):
	"""Yield lists of lead rows, 1,000 at a time, ordered by name (keyset paging, no OFFSET cost)."""
	filters = build_filters(definition)
	fields = _fields()
	last = ""
	while True:
		page_filters = filters + ([[LEAD, "name", ">", last]] if last else [])
		rows = frappe.get_list(LEAD, filters=page_filters, fields=fields, order_by="name asc", limit_page_length=PAGE)
		if not rows:
			return
		yield rows
		last = rows[-1].name
		if len(rows) < PAGE:
			return


def match_lead(definition, lead_name, user=None):
	"""The lead's row (with the fields the evaluator needs) when it belongs to the audience, else None.

	For automatic campaigns, which look at one lead at a time. The saved-segment check is made as ``user`` (the campaign's
	owner), not as whoever happens to be saving the lead; the query itself is not permission-filtered because the lead has
	just been created or changed by someone who may see it, and the audience is the owner's definition."""
	session = frappe.local.session
	previous = session.user
	if user:
		session.user = user
	try:
		filters = build_filters(definition)
	finally:
		session.user = previous
	rows = frappe.get_all(LEAD, filters=filters + [[LEAD, "name", "=", lead_name]], fields=_fields(), limit_page_length=1)
	return rows[0] if rows else None


class Evaluator:
	"""Channel eligibility for lead rows. The same code feeds the audience summary and the real
	recipient list, so what the user is shown before launch is what the engine will do."""

	def __init__(self, channels, consent_confirmed=False):
		self.channels = channels
		cfg = settings()
		self.cc = cfg.get("default_country_code")
		self.require_opt_in = (cfg.get("whatsapp_consent_mode") or "Require opt-in") == "Require opt-in" and not cint(consent_confirmed)
		self.seen = {"Email": set(), "WhatsApp": set()}

	def evaluate_page(self, rows):
		"""-> [(row, {channel: (address, skip_reason or None)})]"""
		emails = {r.name: valid_email(r.get("email")) for r in rows}
		phones = {r.name: normalize_whatsapp(r.get("mobile_no") or r.get("phone"), self.cc) for r in rows}
		out_email = optout.opted_out_values("Email", emails.values()) if "Email" in self.channels else set()
		out_wa = optout.opted_out_values("WhatsApp", phones.values()) if "WhatsApp" in self.channels else set()
		result = []
		for row in rows:
			per = {}
			if "Email" in self.channels:
				per["Email"] = self._email(row, emails[row.name], out_email)
			if "WhatsApp" in self.channels:
				per["WhatsApp"] = self._whatsapp(row, phones[row.name], out_wa)
			result.append((row, per))
		return result

	def _email(self, row, email, opted_out):
		raw = cstr(row.get("email")).strip()
		if not raw:
			return "", "Missing email"
		if not email:
			return raw, "Invalid email"
		if email in opted_out:
			return email, "Opted out"
		if email in self.seen["Email"]:
			return email, "Duplicate email in this campaign"
		self.seen["Email"].add(email)
		return email, None

	def _whatsapp(self, row, number, opted_out):
		raw = cstr(row.get("mobile_no") or row.get("phone")).strip()
		if not raw:
			return "", "Missing WhatsApp number"
		if not number:
			return raw, "Invalid WhatsApp number"
		if number in opted_out:
			return number, "Opted out"
		if self.require_opt_in and not cint(row.get("crm_wa_opt_in")):
			return number, "Not opted in to WhatsApp"
		if number in self.seen["WhatsApp"]:
			return number, "Duplicate number in this campaign"
		self.seen["WhatsApp"].add(number)
		return number, None


def summary(definition, channels, consent_confirmed=False):
	"""The numbers shown before launch. Reads every matching lead, a page at a time."""
	ev = Evaluator(channels, consent_confirmed)
	out = {"total": 0}
	for channel in channels:
		out[channel] = {"eligible": 0, "reasons": {}}
	with debuglog.watch("audience.summary", channels=",".join(channels)):
		for rows in iter_pages(definition):
			for _row, per in ev.evaluate_page(rows):
				out["total"] += 1
				for channel, (_addr, reason) in per.items():
					bucket = out[channel]
					if reason:
						bucket["reasons"][reason] = bucket["reasons"].get(reason, 0) + 1
					else:
						bucket["eligible"] += 1
		debuglog.log("audience.summary scanned", leads=out["total"])
	return out
