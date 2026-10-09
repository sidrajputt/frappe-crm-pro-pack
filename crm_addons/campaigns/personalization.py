"""One personalization engine for every channel.

Variables are the fields of the CRM Lead plus a few computed ones, resolved on the server with
Frappe's sandboxed Jinja. Nothing about a recipient is ever taken from the browser.
"""

import json
import re

import frappe
from frappe import _
from frappe.utils import cstr, escape_html, get_url_to_form, nowdate

from crm_addons.campaigns.common import LEAD

# Frappe's own Jinja environment renders an unknown variable as its placeholder text ("{{ typo }}"), which
# would be sent to a customer. This one is sandboxed too, but renders unknown variables as empty text, so an
# empty value is detected (and the lead skipped) instead of leaking template syntax.
_ENV = None


def _env():
	global _ENV
	if _ENV is None:
		from jinja2.sandbox import SandboxedEnvironment

		_ENV = SandboxedEnvironment(autoescape=False)
	return _ENV

# Lead fields that make no sense as a variable.
_SKIP_TYPES = {
	"Section Break", "Column Break", "Tab Break", "HTML", "Button", "Table", "Table MultiSelect", "Image",
	"Attach", "Attach Image", "Signature", "Code", "Geolocation", "Password", "Text Editor",
	"Markdown Editor", "HTML Editor", "JSON", "Heading", "Fold",
}
_SKIP_NAMES = {"lead_score_internal"}

COMPUTED = {
	"owner_name": "Lead owner's full name (the counsellor)",
	"sender_name": "Campaign owner's full name",
	"today": "Today's date",
	"lead_url": "Link to the lead in CRM",
}


def lead_fields():
	"""Real fields of the CRM Lead on this site: [{fieldname, label, fieldtype, options}]."""
	meta = frappe.get_meta(LEAD)
	fields = [
		{"fieldname": f.fieldname, "label": f.label or f.fieldname, "fieldtype": f.fieldtype, "options": f.options or ""}
		for f in meta.fields
		if f.fieldtype not in _SKIP_TYPES and f.fieldname and f.fieldname not in _SKIP_NAMES and not f.get("hidden")
	]
	return fields


def available_variables():
	out = [{"name": f["fieldname"], "label": f["label"], "kind": "field"} for f in lead_fields()]
	out += [{"name": k, "label": v, "kind": "computed"} for k, v in COMPUTED.items()]
	return out


def _full_name(user):
	return (frappe.db.get_value("User", user, "full_name") if user else "") or ""


def build_context(lead, campaign):
	"""Variables for one lead. ``lead`` is a Document or dict; values are plain strings."""
	row = lead.as_dict() if hasattr(lead, "as_dict") else dict(lead)
	meta = frappe.get_meta(LEAD)
	context = {}
	for f in lead_fields():
		value = row.get(f["fieldname"])
		if value is None:
			context[f["fieldname"]] = ""
		elif f["fieldtype"] in ("Date", "Datetime", "Currency", "Float", "Int", "Percent"):
			context[f["fieldname"]] = cstr(frappe.format_value(value, meta.get_field(f["fieldname"])))
		else:
			context[f["fieldname"]] = cstr(value)
	if not context.get("first_name") and context.get("lead_name"):
		context["first_name"] = context["lead_name"].split(" ")[0]
	context["owner_name"] = _full_name(row.get("lead_owner"))
	context["sender_name"] = _full_name(campaign.get("campaign_owner") or campaign.get("owner"))
	context["today"] = frappe.utils.formatdate(nowdate())
	context["lead_url"] = get_url_to_form(LEAD, row.get("name")) if row.get("name") else ""
	return context


SAMPLE_LEAD = {
	"first_name": "Siddharth", "last_name": "Singh", "lead_name": "Siddharth Singh", "email": "siddharth.singh@example.com",
	"mobile_no": "+91 98765 43210", "phone": "+91 98765 43210", "organization": "Acme Learning", "status": "New",
	"source": "Website", "city": "Pune", "state": "Maharashtra", "country": "India", "job_title": "Operations Manager",
	"website": "https://example.com", "salutation": "Mr", "industry": "Education", "territory": "India", "gender": "Male",
}


def sample_context(campaign_owner=None):
	"""Realistic variable values for previews and test sends when no real lead is chosen."""
	user = campaign_owner or frappe.session.user
	lead = dict(SAMPLE_LEAD, lead_owner=user)
	context = build_context(lead, frappe._dict(campaign_owner=user))
	context["lead_url"] = frappe.utils.get_url() + "/crm/leads/CRM-LEAD-0001"
	context["owner_name"] = context["owner_name"] or "Siddharth Singh"
	context["sender_name"] = context["sender_name"] or "Siddharth Singh"
	return context


def render(template, context, html=False):
	"""Render one template string. Unknown variables render as empty text.

	With ``html=True`` every value is HTML-escaped first: Frappe's Jinja does not autoescape, and a
	lead named ``<script>`` must not become markup in an email.
	"""
	if not template:
		return ""
	if html:
		context = {k: escape_html(v) if isinstance(v, str) else v for k, v in context.items()}
	try:
		return _env().from_string(cstr(template)).render(context).strip()
	except Exception:
		frappe.throw(_("The template could not be filled in: check the {{ }} placeholders."))


def variables_in(*templates):
	"""Names a template uses, found by parsing it (not by running it)."""
	from jinja2 import meta

	found = set()
	for template in templates:
		if not template:
			continue
		try:
			found |= meta.find_undeclared_variables(_env().parse(cstr(template)))
		except Exception:
			frappe.throw(_("The template has a syntax error: check the {{ }} placeholders."))
	return found


def unknown_variables(*templates):
	known = {v["name"] for v in available_variables()}
	return sorted(variables_in(*templates) - known)


def render_whatsapp_params(step, context):
	"""{"1": "Rahul", "2": "Amit"} for a WhatsApp step, in placeholder order, plus the missing ones."""
	mapping = parse_variable_map(step.get("variable_map"))
	params, missing = {}, []
	for key in sorted(mapping, key=int):
		value = render(mapping[key], context)
		if not value:
			missing.append(key)
		params[key] = value
	return params, missing


def parse_variable_map(raw):
	if not raw:
		return {}
	try:
		data = json.loads(raw) if isinstance(raw, str) else dict(raw)
	except ValueError:
		frappe.throw(_("The WhatsApp variable mapping is not valid JSON."))
	if not isinstance(data, dict) or any(not re.fullmatch(r"\d{1,2}", str(k)) for k in data):
		frappe.throw(_("The WhatsApp variable mapping must look like {0}.").format('{"1": "{{ first_name }}"}'))
	return {str(k): cstr(v) for k, v in data.items()}


def placeholders_in(text):
	"""Numbers of the {{1}} {{2}} placeholders in a Meta template body."""
	return sorted({int(n) for n in re.findall(r"\{\{\s*(\d+)\s*\}\}", cstr(text))})


def fill_placeholders(text, params):
	for key, value in params.items():
		text = re.sub(r"\{\{\s*" + re.escape(str(key)) + r"\s*\}\}", lambda _m, v=value: v, cstr(text))
	return text
