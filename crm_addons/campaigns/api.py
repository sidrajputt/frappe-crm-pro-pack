"""Whitelisted endpoints for the Campaign Manager UI. The browser asks; the server decides.

Every endpoint re-checks permissions, validates every id, filter and template reference itself, and
never accepts a status from the client.
"""

import json
import re

import frappe
from frappe import _
from frappe.utils import cint, cstr, now_datetime

from crm_addons.campaigns import analytics, audience, automation, channels, engine, hygiene, journey, optout, personalization, rules, schedule_view
from crm_addons.campaigns.channels import get_sender
from crm_addons.campaigns.common import (
	CAMPAIGN,
	CHANNELS,
	DEFAULT_TIMEZONE,
	LEAD,
	RECIPIENT,
	activity_clause,
	attachment_limit_bytes,
	cached_read,
	email_account_problem,
	check_attachment_size,
	automation_ready,
	date_range,
	files_for_urls,
	normalize_whatsapp,
	parse_url_list,
	valid_email,
	default_whatsapp_account,
	settings,
	whatsapp_installed,
)
from crm_addons.utils import is_manager, system_timezone

SALES_ROLES = {"System Manager", "Sales Manager", "Sales User"}
CAMPAIGN_FIELDS = (
	"campaign_name", "description", "campaign_type", "campaign_owner", "tags", "notes", "audience_mode",
	"audience_filters", "selected_records", "saved_view", "send_mode", "scheduled_at", "timezone",
	"consent_confirmed", "stop_on_reply", "batch_size", "rate_per_minute", "max_retries", "trigger_event", "trigger_status",
	"track_clicks", "window_enabled", "window_start", "window_end", "window_weekdays_only",
)
RULE_FIELDS = ("event", "action", "value")
STEP_FIELDS = ("channel", "day_offset", "condition", "email_template", "wa_template", "wa_account", "variable_map", "wa_attach", "attachments")
EMAIL_TEMPLATE = "CRM Campaign Email Template"
EMAIL_CATEGORIES = ["Welcome", "Promotion", "Newsletter", "Follow-up", "Event", "Announcement", "Transactional", "Other"]
EDITOR_MODES = ("Visual Builder", "HTML", "Rich Text")
TEST_EMAIL_MAX = 10  # recipients per test-send call
TEST_EMAIL_PER_HOUR = 40  # per user
TEST_WHATSAPP_PER_HOUR = 10  # per user


def _check_user():
	if not (SALES_ROLES & set(frappe.get_roles())):
		frappe.throw(_("Only sales users can use the Campaign Manager."), frappe.PermissionError)


def _json(value):
	return json.loads(value) if isinstance(value, str) else value


def _get(name, ptype="read"):
	_check_user()
	return engine._campaign(name, ptype)


# -- configuration -------------------------------------------------------------------------------------------


@frappe.whitelist()
def get_config():
	_check_user()
	cfg = settings()
	wa_ready = bool(default_whatsapp_account())
	return {
		"channels": list(CHANNELS),
		"whatsapp": {"installed": whatsapp_installed(), "ready": wa_ready, "account": default_whatsapp_account()},
		"email": {"ready": not email_account_problem(), "problem": email_account_problem(), "open_tracking": analytics.email_open_tracking_enabled()},
		"consent_mode": cfg.get("whatsapp_consent_mode") or "Require opt-in",
		"default_country_code": cfg.get("default_country_code") or "",
		"is_manager": is_manager(),
		"lead_statuses": frappe.get_all("CRM Lead Status", pluck="name", order_by="position asc") if frappe.db.exists("DocType", "CRM Lead Status") else [],
		"automation_events": list(automation.EVENTS),
		"rule_events": list(rules.EVENTS),
		"rule_actions": list(rules.ACTIONS),
		"can_configure": frappe.session.user == "Administrator" or "System Manager" in frappe.get_roles(),
		"types": ["Marketing", "Follow-up", "Announcement", "Reminder", "Other"],
		"timezone": DEFAULT_TIMEZONE,
		"now": now_datetime().strftime("%Y-%m-%d %H:%M:%S"),  # the site's wall clock: date pickers use its "today"
		"user": frappe.session.user,
		"email_categories": EMAIL_CATEGORIES,
		"attachment_limit_mb": round(attachment_limit_bytes() / 1048576),
		"test_email_max": TEST_EMAIL_MAX,
		"sender_name": frappe.utils.get_fullname(frappe.session.user),
		"sender_email": frappe.db.get_value("User", frappe.session.user, "email") or "",
	}


@frappe.whitelist()
def get_audience_fields():
	"""Real Lead fields (for filters and variables) and the saved segments the user may use."""
	_check_user()
	segments = frappe.get_all(
		"CRM View Settings",
		filters={"dt": LEAD},
		or_filters=[["public", "=", 1], ["user", "=", frappe.session.user]],
		fields=["name", "label", "public"],
		order_by="label asc",
	)
	return {
		"fields": personalization.lead_fields(),
		"variables": personalization.available_variables(),
		"segments": segments,
		"operators": sorted(audience.OPERATORS),
	}


# -- campaigns ----------------------------------------------------------------------------------------------


_SORTS = {
	"modified": "modified desc", "created": "creation desc", "name": "campaign_name asc",
	"recipients": "total_recipients desc", "scheduled": "scheduled_at desc",
}


@frappe.whitelist()
def list_campaigns(search=None, status=None, start=0, page_length=20, channel=None, from_date=None, to_date=None, sort=None):
	"""A page of campaigns with their channels and delivery numbers. ``channel`` is Email, WhatsApp or
	Multi-channel; the dates (whole days, site time zone, end day included) filter on the day the campaign was created."""
	_check_user()
	# a campaign that only holds an automation's messages is shown under Automations (once the site has been migrated for them)
	filters = [[CAMPAIGN, "automation", "is", "not set"]] if automation_ready() else []
	if status:
		filters.append([CAMPAIGN, "status", "=", status])
	start, end = date_range(from_date, to_date)
	if start:
		filters.append([CAMPAIGN, "creation", ">=", start])
	if end:
		filters.append([CAMPAIGN, "creation", "<", end])
	if channel in ("Email", "WhatsApp", "Multi-channel"):
		by = {c: set(frappe.get_all("CRM Campaign Step", filters={"parenttype": CAMPAIGN, "channel": c}, pluck="parent")) for c in CHANNELS}
		names = by["Email"] & by["WhatsApp"] if channel == "Multi-channel" else by[channel]
		filters.append([CAMPAIGN, "name", "in", list(names) or ["__none__"]])
	or_filters = [["campaign_name", "like", f"%{search}%"], ["tags", "like", f"%{search}%"]] if search else None
	rows = frappe.get_list(
		CAMPAIGN, filters=filters, or_filters=or_filters,
		fields=["name", "campaign_name", "status", "campaign_type", "campaign_owner", "owner", "creation", "total_recipients", "scheduled_at", "started_at", "send_mode", "modified", "tags", "audience_mode", "saved_view", "selected_records", "trigger_event", "health_note"],
		order_by=_SORTS.get(sort, _SORTS["modified"]), limit_start=cint(start), limit_page_length=min(cint(page_length) or 20, 100),
	)
	if rows:
		names = [r.name for r in rows]
		steps = frappe.get_all("CRM Campaign Step", filters={"parenttype": CAMPAIGN, "parent": ["in", names]}, fields=["parent", "channel"])
		stats = {}
		for r in frappe.db.sql(
			f"SELECT campaign, status, COUNT(*) AS n FROM `tab{RECIPIENT}` WHERE campaign IN %s GROUP BY campaign, status", (tuple(names),), as_dict=True
		):
			st = stats.setdefault(r.campaign, {"recipients": 0, "sent": 0, "delivered": 0, "opened": 0, "failed": 0, "skipped": 0})
			st["recipients"] += r.n
			if r.status in ("Sent", "Delivered", "Read"):
				st["sent"] += r.n
			if r.status in ("Delivered", "Read"):
				st["delivered"] += r.n
			if r.status == "Read":
				st["opened"] += r.n
			if r.status == "Failed":
				st["failed"] += r.n
			if r.status == "Skipped":
				st["skipped"] += r.n
		views = {v.name: v.label for v in frappe.get_all("CRM View Settings", filters={"name": ["in", [r.saved_view for r in rows if r.saved_view] or [""]]}, fields=["name", "label"])}
		people = {u.name: u.full_name for u in frappe.get_all("User", filters={"name": ["in", list({r.owner for r in rows} | {r.campaign_owner for r in rows if r.campaign_owner})]}, fields=["name", "full_name"])}
		for r in rows:
			r["channels"] = [c for c in CHANNELS if any(s.parent == r.name and s.channel == c for s in steps)]
			r["stats"] = stats.get(r.name, {"recipients": 0, "sent": 0, "delivered": 0, "opened": 0, "failed": 0, "skipped": 0})
			r["audience"] = _audience_label(r, views)
			r["created_by"] = people.get(r.campaign_owner or r.owner) or r.campaign_owner or r.owner
			r.pop("selected_records", None)
	total = frappe.get_list(CAMPAIGN, filters=filters, or_filters=or_filters, fields=["count(name) as c"])
	return {"rows": rows, "total": cint(total[0].c) if total else 0}


def _audience_label(row, views=None):
	mode = row.get("audience_mode")
	if mode == "Saved Segment":
		label = (views or {}).get(row.get("saved_view")) or row.get("saved_view")
		return _("Segment: {0}").format(label) if label else _("Saved segment")
	if mode == "Selected Records":
		try:
			n = len(json.loads(row.get("selected_records") or "[]"))
		except ValueError:
			n = 0
		return _("{0} hand-picked leads").format(n)
	return _("CRM lead filters")


@frappe.whitelist()
def get_campaign(name):
	doc = _get(name)
	data = doc.as_dict()
	data["allowed_actions"] = engine.allowed_actions(doc)
	data["channels"] = engine.channels_of(doc)
	data["owner_name"] = frappe.utils.get_fullname(doc.campaign_owner or doc.owner)
	data["window_open_now"] = journey.window_open(doc)
	opens = journey.next_open(doc)
	data["window_next_open"] = opens.strftime("%Y-%m-%d %H:%M") if opens else None
	data["audience_label"] = _audience_label(
		data, {doc.saved_view: frappe.db.get_value("CRM View Settings", doc.saved_view, "label")} if doc.saved_view else None
	)
	return data


def _apply(doc, data):
	for field in CAMPAIGN_FIELDS:
		if field in data:
			value = data[field]
			if field in ("audience_filters", "selected_records") and not isinstance(value, str):
				value = json.dumps(value)
			doc.set(field, value)
	if "steps" in data:
		doc.set("steps", [])
		for step in _json(data["steps"]) or []:
			doc.append("steps", {k: step.get(k) for k in STEP_FIELDS if k in step})
	if "rules" in data:
		doc.set("rules", [])
		for rule in _json(data["rules"]) or []:
			doc.append("rules", {k: rule.get(k) for k in RULE_FIELDS if k in rule})


def _validate_attachments(doc):
	"""Every attachment must be a real file the user may read, and one email may not exceed the size limit."""
	for step in doc.steps:
		urls = parse_url_list(step.get("attachments"))
		if not urls:
			continue
		if step.channel != "Email":
			frappe.throw(_("Attachments can only be added to email steps. Use the header media of a WhatsApp template instead."))
		files = files_for_urls(urls)
		for f in files:
			if not frappe.has_permission("File", "read", doc=f.name):
				frappe.throw(_("You cannot use the file {0}.").format(frappe.bold(f.file_name)), frappe.PermissionError)
		check_attachment_size(files)
		step.attachments = json.dumps(urls)


@frappe.whitelist()
def save_campaign(data, name=None):
	"""Create or update a draft. Only whitelisted fields are read; status is never taken from the client."""
	_check_user()
	data = _json(data)
	if name:
		doc = engine._campaign(name, "write")
		if not engine.can_act(doc):
			frappe.throw(_("Only the owner or a manager can edit this campaign."), frappe.PermissionError)
	else:
		doc = frappe.new_doc(CAMPAIGN)
		doc.campaign_owner = frappe.session.user
	if not is_manager() and data.get("campaign_owner") not in (None, frappe.session.user):
		frappe.throw(_("Only a manager can assign a campaign to someone else."), frappe.PermissionError)
	_apply(doc, data)
	_validate_attachments(doc)
	doc.save()
	return get_campaign(doc.name)


@frappe.whitelist()
def delete_campaign(name):
	doc = _get(name, "delete")
	if "delete" not in engine.allowed_actions(doc):
		frappe.throw(_("A {0} campaign cannot be deleted.").format(doc.status))
	frappe.delete_doc(CAMPAIGN, name)
	return True


@frappe.whitelist()
def duplicate_campaign(name, new_name=None):
	"""Copy configuration, audience and content. History is never copied."""
	src = _get(name)
	doc = frappe.new_doc(CAMPAIGN)
	for field in CAMPAIGN_FIELDS:
		doc.set(field, src.get(field))
	doc.campaign_name = new_name or _("{0} (copy)").format(src.campaign_name)
	doc.campaign_owner = frappe.session.user
	doc.duplicate_of = src.name
	doc.scheduled_at = None
	doc.send_mode = "Trigger" if src.send_mode == "Trigger" else "Send Now"
	for step in src.steps:
		doc.append("steps", {k: step.get(k) for k in STEP_FIELDS})
	for rule in src.rules:
		doc.append("rules", {k: rule.get(k) for k in RULE_FIELDS})
	doc.insert()
	return get_campaign(doc.name)


@frappe.whitelist()
def save_as_template(name, template_name, description=""):
	doc = _get(name)
	if not is_manager():
		frappe.throw(_("Only managers can save campaign templates."), frappe.PermissionError)
	config = {f: doc.get(f) for f in ("campaign_type", "audience_mode", "audience_filters", "selected_records", "saved_view", "consent_confirmed", "stop_on_reply", "batch_size", "rate_per_minute", "max_retries", "track_clicks", "window_enabled", "window_start", "window_end", "window_weekdays_only")}
	config["steps"] = [{k: s.get(k) for k in STEP_FIELDS} for s in doc.steps]
	config["rules"] = [{k: r.get(k) for k in RULE_FIELDS} for r in doc.rules]
	tpl = frappe.get_doc(
		{"doctype": "CRM Campaign Template", "template_name": template_name, "description": description, "channels": ", ".join(engine.channels_of(doc)), "config": json.dumps(config, default=str)}
	).insert()
	return tpl.name


@frappe.whitelist()
def list_campaign_templates():
	_check_user()
	return frappe.get_all("CRM Campaign Template", fields=["name", "template_name", "description", "channels"], order_by="template_name asc")


@frappe.whitelist()
def create_from_template(template, campaign_name):
	_check_user()
	tpl = frappe.get_doc("CRM Campaign Template", template)
	tpl.check_permission("read")
	config = json.loads(tpl.config or "{}")
	data = {k: v for k, v in config.items() if k in CAMPAIGN_FIELDS or k in ("steps", "rules")}
	data["campaign_name"] = campaign_name
	out = save_campaign(data)
	frappe.db.set_value(CAMPAIGN, out["name"], "source_template", tpl.name)
	return get_campaign(out["name"])


# -- audience ------------------------------------------------------------------------------------------------


@frappe.whitelist()
def preview_audience(definition, start=0, page_length=20):
	"""Matching count and a page of real recipients for an *unsaved* definition."""
	_check_user()
	definition = _json(definition)
	return {"count": audience.count(definition), "rows": audience.sample(definition, start, page_length)}


def _audience_summary(definition, channels, consent_confirmed):
	"""The eligibility scan reads every matching lead, so a result up to 45 seconds old is reused while the person
	edits the audience (the pages ask again on every change). Launching always scans afresh."""
	key = (json.dumps(definition, sort_keys=True, default=str), tuple(channels), cint(consent_confirmed))
	return cached_read("audience-summary", key, 45, lambda: audience.summary(definition, channels, cint(consent_confirmed)))


@frappe.whitelist()
def audience_summary(definition, channels, consent_confirmed=0):
	"""Eligibility numbers shown before launch (total, eligible, missing, invalid, opted out, duplicates)."""
	_check_user()
	channels = [c for c in _json(channels) if c in CHANNELS]
	return _audience_summary(_json(definition), channels, consent_confirmed)


# -- templates -----------------------------------------------------------------------------------------------


@frappe.whitelist()
def list_templates(channel=None, search=None, active=None):
	"""Email templates (ours) and WhatsApp templates (read from frappe_whatsapp, never copied)."""
	_check_user()
	out = []
	if channel in (None, "", "Email"):
		filters = {}
		if active not in (None, ""):
			filters["enabled"] = cint(active)
		for t in frappe.get_all("CRM Campaign Email Template", filters=filters, fields=["name", "template_name", "subject", "enabled", "modified", "variables"], order_by="modified desc"):
			if not search or search.lower() in (t.template_name + " " + cstr(t.subject)).lower():
				out.append({"channel": "Email", "name": t.name, "title": t.template_name, "status": "Active" if t.enabled else "Inactive", "subject": t.subject, "variables": t.variables, "editable": True})
	if channel in (None, "", "WhatsApp") and whatsapp_installed():
		for t in frappe.get_all("WhatsApp Templates", fields=["name", "template_name", "status", "language_code", "category", "template", "sample_values", "whatsapp_account"], order_by="modified desc"):
			if active not in (None, "") and cint(active) != int(cstr(t.status).upper() == "APPROVED"):
				continue
			if not search or search.lower() in cstr(t.template_name).lower():
				out.append({
					"channel": "WhatsApp", "name": t.name, "title": t.template_name, "status": t.status or "Not synced",
					"approved": cstr(t.status).upper() == "APPROVED", "language": t.language_code, "category": t.category,
					"body": t.template, "placeholders": personalization.placeholders_in(t.template), "editable": False,
					"account": t.whatsapp_account,
				})
	return out


def _template_files(name):
	return frappe.get_all(
		"File", filters={"attached_to_doctype": EMAIL_TEMPLATE, "attached_to_name": name},
		fields=["name", "file_url", "file_name", "file_size", "is_private"], order_by="creation asc",
	)


def _template_usage(name):
	"""Names of the campaigns whose steps use this email template."""
	return sorted(set(frappe.get_all("CRM Campaign Step", filters={"parenttype": CAMPAIGN, "email_template": name}, pluck="parent")))


@frappe.whitelist()
def get_email_template(name):
	_check_user()
	doc = frappe.get_doc(EMAIL_TEMPLATE, name)
	doc.check_permission("read")
	data = doc.as_dict()
	data["attachments"] = _template_files(name)
	data["used_in"] = _template_usage(name)
	return data


@frappe.whitelist()
def list_email_templates(search=None, category=None, enabled=None):
	"""The shared email template library, with the HTML (for thumbnails) and how often each is used."""
	_check_user()
	filters = {}
	if category:
		filters["category"] = category
	if enabled not in (None, ""):
		filters["enabled"] = cint(enabled)
	rows = frappe.get_list(
		EMAIL_TEMPLATE, filters=filters,
		fields=["name", "template_name", "subject", "body_html", "enabled", "category", "editor_mode", "description", "modified", "owner", "creation"],
		order_by="modified desc", limit_page_length=500,
	)
	if search:
		term = search.lower()
		rows = [r for r in rows if term in f"{r.template_name} {r.subject} {r.description or ''} {r.category or ''}".lower()]
	usage = {}
	for r in frappe.get_all("CRM Campaign Step", filters={"parenttype": CAMPAIGN, "email_template": ["in", [r.name for r in rows] or [""]]}, fields=["email_template", "parent"]):
		usage.setdefault(r.email_template, set()).add(r.parent)
	for r in rows:
		r["used_in"] = len(usage.get(r.name, ()))
		r["editor_mode"] = r.editor_mode or "HTML"
	return rows


@frappe.whitelist()
def save_email_template(data, name=None):
	"""Create or update a shared email template. ``attachments`` (a list of file urls) replaces the files
	attached to the template; ``body_html`` is always what gets sent."""
	_check_user()
	if not is_manager():
		frappe.throw(_("Only managers can manage templates."), frappe.PermissionError)
	data = _json(data)
	if data.get("editor_mode") not in (None, "") + EDITOR_MODES:
		frappe.throw(_("Unknown editor type."))
	if data.get("category") not in (None, "") + tuple(EMAIL_CATEGORIES):
		frappe.throw(_("Unknown template category."))
	doc = frappe.get_doc(EMAIL_TEMPLATE, name) if name else frappe.new_doc(EMAIL_TEMPLATE)
	for f in ("template_name", "enabled", "subject", "body_html", "body_text", "description", "category", "editor_mode"):
		if f in data:
			doc.set(f, data[f])
	if "builder_json" in data:
		doc.builder_json = data["builder_json"] if isinstance(data["builder_json"], str) else json.dumps(data["builder_json"])
	if not name and frappe.db.exists(EMAIL_TEMPLATE, doc.template_name):
		frappe.throw(_("A template named {0} already exists. Choose another name.").format(frappe.bold(doc.template_name)))
	doc.save()
	if "attachments" in data:
		urls = parse_url_list(data["attachments"])
		files = files_for_urls(urls)
		check_attachment_size(files)
		keep = set()
		for f in files:
			if f.attached_to_doctype not in (None, "", EMAIL_TEMPLATE) or (f.attached_to_name not in (None, "", doc.name) and f.attached_to_doctype == EMAIL_TEMPLATE):
				frappe.throw(_("The file {0} belongs to another record.").format(frappe.bold(f.file_name)))
			frappe.db.set_value("File", f.name, {"attached_to_doctype": EMAIL_TEMPLATE, "attached_to_name": doc.name}, update_modified=False)
			keep.add(f.name)
		for f in _template_files(doc.name):
			if f.name not in keep:
				frappe.delete_doc("File", f.name, ignore_permissions=True)
	return get_email_template(doc.name)


@frappe.whitelist()
def duplicate_email_template(name):
	_check_user()
	if not is_manager():
		frappe.throw(_("Only managers can manage templates."), frappe.PermissionError)
	src = frappe.get_doc(EMAIL_TEMPLATE, name)
	doc = frappe.new_doc(EMAIL_TEMPLATE)
	doc.update({f: src.get(f) for f in ("subject", "body_html", "body_text", "description", "category", "editor_mode", "builder_json")})
	n, base = 2, _("{0} (copy)").format(src.template_name)
	title = base
	while frappe.db.exists(EMAIL_TEMPLATE, title):
		title, n = f"{base} {n}", n + 1
	doc.template_name = title
	doc.insert()
	return doc.as_dict()


@frappe.whitelist()
def delete_email_template(name):
	"""Delete a template nobody uses. A template used by a campaign cannot be deleted: archive it (enabled = 0)."""
	_check_user()
	if not is_manager():
		frappe.throw(_("Only managers can manage templates."), frappe.PermissionError)
	used = _template_usage(name)
	if used:
		frappe.throw(_("This template is used by {0} campaign(s), so it cannot be deleted. Archive it instead.").format(len(used)))
	frappe.delete_doc(EMAIL_TEMPLATE, name)
	return True


def _sample_or_lead(lead, owner=None):
	"""-> (context, lead info). A real lead the user may read, or realistic sample data."""
	if lead:
		doc = frappe.get_doc(LEAD, lead)
		doc.check_permission("read")
		ctx = personalization.build_context(doc, frappe._dict(campaign_owner=owner or frappe.session.user))
		return ctx, {"name": doc.name, "lead_name": doc.get("lead_name"), "sample": False}
	return personalization.sample_context(owner), {"name": "", "lead_name": "Siddharth Singh", "sample": True}


@frappe.whitelist()
def render_email_preview(subject="", html="", lead=None):
	"""Fill a (possibly unsaved) subject and HTML with a lead's values or realistic sample data."""
	_check_user()
	ctx, info = _sample_or_lead(lead)
	unknown = personalization.unknown_variables(subject, html)
	return {
		"subject": personalization.render(subject, ctx), "html": personalization.render(html, ctx, html=True),
		"unknown": unknown, "lead": info,
	}


@frappe.whitelist()
def render_email_template(name, lead=None):
	"""Subject and HTML of a shared template for one lead (or sample data). Also for follow-up mails."""
	tpl = frappe.get_doc(EMAIL_TEMPLATE, name)
	_check_user()
	tpl.check_permission("read")
	return render_email_preview(tpl.subject, tpl.body_html, lead) | {"template": tpl.name}


def _rate_limit(kind, amount, limit):
	"""A small per-user hourly budget, so a test button cannot be used to send bulk mail."""
	cache, key = frappe.cache(), f"crm_addons:cm_{kind}:{frappe.session.user}"
	used = cint(cache.get_value(key, expires=True))
	if used + amount > limit:
		frappe.throw(_("Too many test messages. You can send {0} per hour; try again later.").format(limit))
	cache.set_value(key, used + amount, expires_in_sec=3600)


def _outgoing_ready():
	return not email_account_problem()


def _addresses(raw):
	if isinstance(raw, str):
		try:
			raw = json.loads(raw)
		except ValueError:
			raw = re.split(r"[,;\s]+", raw)
	out, bad = [], []
	for item in raw or []:
		item = cstr(item).strip()
		if not item:
			continue
		mail = valid_email(item)
		if not mail:
			bad.append(item)
		elif mail not in out:
			out.append(mail)
	if bad:
		frappe.throw(_("Not a valid email address: {0}").format(", ".join(bad)))
	if not out:
		frappe.throw(_("Enter at least one email address."))
	if len(out) > TEST_EMAIL_MAX:
		frappe.throw(_("Send a test to at most {0} addresses at a time.").format(TEST_EMAIL_MAX))
	return out


@frappe.whitelist()
def send_test_email(emails, subject=None, html=None, email_template=None, attachments=None, lead=None):
	"""Send a test of an email to the addresses given, and only to them.

	The content is the (possibly unsaved) ``subject`` / ``html`` from the editor, or the saved template.
	It is filled with a sample lead (or ``lead``), the subject is prefixed ``[Test]``, no recipient row and no
	Communication is created, and the budget is limited per user."""
	_check_user()
	addresses = _addresses(emails)
	tpl = None
	if email_template:
		tpl = frappe.get_doc(EMAIL_TEMPLATE, email_template)
		tpl.check_permission("read")
		subject = subject if subject not in (None, "") else tpl.subject
		html = html if html not in (None, "") else tpl.body_html
	if not cstr(subject).strip() or not cstr(html).strip():
		frappe.throw(_("Add a subject and some content before sending a test."))
	unknown = personalization.unknown_variables(subject, html)
	if unknown:
		frappe.throw(_("Unknown variable(s): {0}.").format(", ".join(unknown)))
	if not _outgoing_ready():
		frappe.throw(email_account_problem())
	files = []
	if tpl:
		files += _template_files(tpl.name)
	have = {f.name for f in files}
	files += [f for f in files_for_urls(parse_url_list(attachments)) if f.name not in have]
	for f in files:
		if not frappe.has_permission("File", "read", doc=f.name):
			frappe.throw(_("You cannot use the file {0}.").format(frappe.bold(f.file_name)), frappe.PermissionError)
	check_attachment_size(files)
	_rate_limit("test_email", len(addresses), TEST_EMAIL_PER_HOUR)
	ctx, info = _sample_or_lead(lead)
	subject_out = "[Test] " + personalization.render(subject, ctx)
	html_out = personalization.render(html, ctx, html=True)
	try:
		frappe.sendmail(
			recipients=addresses, subject=subject_out, message=html_out, attachments=[{"fid": f.name} for f in files] or None,
			reply_to=frappe.db.get_value("User", frappe.session.user, "email"), delayed=False,
		)
	except Exception as exc:
		frappe.log_error(frappe.get_traceback(), "CRM Campaign: test email failed")
		frappe.clear_messages()  # frappe's own message about the mail server would repeat ours
		frappe.throw(_("The test email could not be sent: {0}").format(frappe.utils.strip_html(cstr(exc))[:300]))
	return {"sent": len(addresses), "to": addresses, "subject": subject_out, "lead": info}


@frappe.whitelist()
def send_test_whatsapp(step, number, lead=None):
	"""Send one approved template to one number through the same sender the campaign uses.

	The message is a normal ``WhatsApp Message`` (so it also shows in frappe_whatsapp), no campaign
	recipient row is created and opt-outs are not touched. It is billed by Meta like any template message."""
	_check_user()
	step = frappe._dict(_json(step))
	if step.get("channel") != "WhatsApp":
		frappe.throw(_("Choose a WhatsApp template first."))
	if not whatsapp_installed():
		frappe.throw(_("The frappe_whatsapp app is not installed on this site."))
	digits = normalize_whatsapp(number, settings().get("default_country_code"))
	if not digits:
		frappe.throw(_("Enter the number with its country code, for example +91 98765 43210."))
	sender = get_sender("WhatsApp")
	sender.check_ready(step)
	_rate_limit("test_wa", 1, TEST_WHATSAPP_PER_HOUR)
	doc = None
	if lead:
		doc = frappe.get_doc(LEAD, lead)
		doc.check_permission("read")
	ctx_lead = doc or dict(personalization.SAMPLE_LEAD, lead_owner=frappe.session.user)
	recipient = frappe._dict(
		name="TEST-" + frappe.generate_hash(length=8), whatsapp_number=digits,
		recipient_type=LEAD if doc else None, recipient_id=doc.name if doc else None,
	)
	fake = frappe._dict(campaign_owner=frappe.session.user, owner=frappe.session.user)
	try:
		out = sender.send(fake, step, recipient, ctx_lead)
	except channels.Skip as exc:
		frappe.throw(cstr(exc))
	except channels.ChannelError as exc:
		frappe.throw(_("Meta did not accept the test message: {0}").format(cstr(exc)[:300]))
	return {"sent": 1, "to": digits, "message": out.get("linked_doc"), "message_id": out.get("provider_message_id")}


# -- WhatsApp templates (owned by frappe_whatsapp; read here, synced from Meta there) -------------------------


@frappe.whitelist()
def list_whatsapp_templates(search=None, category=None, status=None):
	"""Templates from frappe_whatsapp with everything needed to draw them. Read-only."""
	_check_user()
	if not whatsapp_installed():
		return {"installed": False, "rows": [], "can_sync": False}
	filters = {}
	if category:
		filters["category"] = category
	rows = frappe.get_all(
		"WhatsApp Templates", filters=filters,
		fields=["name", "template_name", "actual_name", "status", "language_code", "category", "template", "header", "header_type", "footer", "sample_values", "sample", "whatsapp_account", "id", "modified"],
		order_by="modified desc", limit_page_length=500,
	)
	buttons = {}
	for b in frappe.get_all("WhatsApp Button", filters={"parenttype": "WhatsApp Templates", "parent": ["in", [r.name for r in rows] or [""]]}, fields=["parent", "button_type", "button_label", "website_url", "phone_number"], order_by="idx asc"):
		buttons.setdefault(b.parent, []).append(b)
	out = []
	for r in rows:
		state = cstr(r.status).upper() or "NOT SYNCED"
		if status and state != status.upper():
			continue
		if search and search.lower() not in f"{r.template_name} {r.template}".lower():
			continue
		samples = [x.strip() for x in cstr(r.sample_values).split(",")] if r.sample_values else []
		out.append(
			{
				**r, "state": state, "approved": state == "APPROVED", "synced": bool(r.id),
				"placeholders": personalization.placeholders_in(r.template), "samples": samples, "buttons": buttons.get(r.name, []),
			}
		)
	return {"installed": True, "rows": out, "can_sync": is_manager(), "account": default_whatsapp_account()}


@frappe.whitelist()
def sync_whatsapp_templates():
	"""Pull templates and their approval status from Meta using frappe_whatsapp's own fetch (managers only).
	Nothing is created or edited in Meta."""
	_check_user()
	if not is_manager():
		frappe.throw(_("Only managers can sync WhatsApp templates."), frappe.PermissionError)
	if not whatsapp_installed():
		frappe.throw(_("The frappe_whatsapp app is not installed on this site."))
	try:
		fetch = frappe.get_attr("frappe_whatsapp.frappe_whatsapp.doctype.whatsapp_templates.whatsapp_templates.fetch")
	except Exception:
		frappe.throw(_("This version of frappe_whatsapp has no template sync. Use the sync button in WhatsApp Templates in Desk."))
	message = fetch()
	return {"message": cstr(message), "count": frappe.db.count("WhatsApp Templates")}


# -- saved segments -----------------------------------------------------------------------------------------


def _friendly_filters(view):
	try:
		return [[r[1], r[2], r[3]] for r in audience._segment_filters(view)]
	except Exception:
		frappe.clear_messages()
		return []


@frappe.whitelist()
def list_segments(with_counts=1):
	"""Saved Lead filters (the saved views of the Leads list) the user may use as an audience."""
	_check_user()
	rows = frappe.get_all(
		"CRM View Settings", filters={"dt": LEAD, "type": ["in", ["list", "", None]]},
		or_filters=[["public", "=", 1], ["user", "=", frappe.session.user]],
		fields=["name", "label", "public", "user", "filters", "modified", "icon"], order_by="label asc", limit_page_length=200,
	)
	for r in rows:
		r["name"] = cstr(r.name)  # saved views are numbered; the browser compares names as text
		r["rules"] = _friendly_filters(r.name)
		r["mine"] = r.user == frappe.session.user
		r.pop("filters", None)
		if cint(with_counts):
			try:
				r["count"] = cached_read("segment-count", r.name, 45, lambda view=r.name: audience.count({"mode": "Saved Segment", "saved_view": view}))
			except Exception:
				frappe.clear_messages()
				r["count"] = None
	return rows


@frappe.whitelist()
def save_segment(label, filters, public=0):
	"""Save the current filter rules as a segment (a CRM saved view of the Leads list)."""
	_check_user()
	rows = audience.clean_filters(filters)
	if not cstr(label).strip():
		frappe.throw(_("Give the segment a name."))
	if not rows:
		frappe.throw(_("Add at least one filter before saving a segment."))
	if frappe.db.exists("CRM View Settings", {"label": cstr(label).strip(), "dt": LEAD, "user": frappe.session.user}):
		frappe.throw(_("You already have a segment named {0}.").format(frappe.bold(cstr(label).strip())))
	doc = frappe.new_doc("CRM View Settings")
	doc.update(
		{
			"label": cstr(label).strip(), "dt": LEAD, "type": "list", "user": frappe.session.user,
			"public": 1 if (cint(public) and is_manager()) else 0, "filters": json.dumps({r[1]: [r[2], r[3]] for r in rows}),
		}
	)
	doc.insert()
	return {"name": cstr(doc.name), "label": doc.label}


@frappe.whitelist()
def delete_segment(name):
	_check_user()
	view = frappe.db.get_value("CRM View Settings", name, ["dt", "user", "public"], as_dict=True)
	if not view or view.dt != LEAD:
		frappe.throw(_("The saved segment was not found."))
	if view.user != frappe.session.user and not is_manager():
		frappe.throw(_("You can only delete your own segments."), frappe.PermissionError)
	if frappe.db.exists(CAMPAIGN, {"saved_view": name, "status": ["in", ["Scheduled", "Queued", "Running", "Paused"]]}):
		frappe.throw(_("A running or scheduled campaign uses this segment."))
	frappe.delete_doc("CRM View Settings", name, ignore_permissions=True)
	return True


@frappe.whitelist()
def audience_insight(definition, channels=None, consent_confirmed=0, start=0, page_length=10, with_summary=1):
	"""Everything the audience step shows: the matching count, a page of real leads with a per-channel
	verdict and the reason when excluded, and (optionally) the eligibility totals for the whole audience."""
	_check_user()
	definition = _json(definition)
	chans = [c for c in (_json(channels) if channels else list(CHANNELS)) if c in CHANNELS] or list(CHANNELS)
	count = audience.count(definition)
	ev = audience.Evaluator(chans, cint(consent_confirmed))
	rows = []
	for row, per in ev.evaluate_page(audience.sample(definition, start, page_length)):
		item = dict(row)
		item["eligibility"] = {c: {"ok": reason is None, "reason": reason, "address": addr} for c, (addr, reason) in per.items()}
		rows.append(item)
	return {
		"count": count, "rows": rows, "channels": chans,
		"summary": _audience_summary(definition, chans, consent_confirmed) if cint(with_summary) else None,
	}


@frappe.whitelist()
def search_field_values(fieldname, txt="", limit=10):
	"""Suggestions for a Link field of the Lead (owner, source...), through Frappe's own permission-aware search."""
	_check_user()
	field = frappe.get_meta(LEAD).get_field(fieldname)
	if not field or field.fieldtype != "Link" or not field.options:
		return []
	from frappe.desk.search import search_link

	return [{"value": r.get("value"), "description": r.get("description")} for r in (search_link(field.options, txt, page_length=max(1, min(cint(limit) or 10, 50))) or [])]


@frappe.whitelist()
def preview_step(step, lead=None, campaign_owner=None, sample=0):
	"""Render one step for one real lead (resolved on the server with the lead's real data), or with realistic
	sample data when ``sample`` is set or the site has no lead to preview with."""
	_check_user()
	step = _json(step)
	if step.get("channel") not in CHANNELS:
		frappe.throw(_("Choose a channel."))
	if not lead and not cint(sample):
		rows = frappe.get_list(LEAD, fields=["name"], order_by="modified desc", limit_page_length=1)
		lead = rows[0].name if rows else None
	owner = campaign_owner or frappe.session.user
	fake = frappe._dict(campaign_owner=owner, owner=frappe.session.user)
	if not lead:
		person = dict(personalization.SAMPLE_LEAD, lead_owner=owner)
		result = get_sender(step["channel"]).preview(fake, frappe._dict(step), person)
		result["lead"] = {"name": "", "lead_name": person["lead_name"], "sample": True}
		return result
	doc = frappe.get_doc(LEAD, lead)
	doc.check_permission("read")
	result = get_sender(step["channel"]).preview(fake, frappe._dict(step), doc)
	result["lead"] = {"name": doc.name, "lead_name": doc.get("lead_name"), "sample": False}
	return result


@frappe.whitelist()
def search_leads(txt=""):
	_check_user()
	return frappe.get_list(LEAD, filters=[["lead_name", "like", f"%{txt}%"]] if txt else None, fields=["name", "lead_name", "email", "mobile_no"], order_by="modified desc", limit_page_length=10)


# -- actions -------------------------------------------------------------------------------------------------


@frappe.whitelist()
def launch(name):
	_check_user()
	return engine.launch(name)


@frappe.whitelist()
def validate_launch(name):
	"""Dry run of everything launch checks; returns the audience snapshot or raises the reason."""
	doc = _get(name, "write")
	return engine.validate_ready(doc)


@frappe.whitelist()
def pause(name):
	_check_user()
	return engine.pause(name)


@frappe.whitelist()
def resume(name):
	_check_user()
	return engine.resume(name)


@frappe.whitelist()
def cancel(name):
	_check_user()
	return engine.cancel(name)


@frappe.whitelist()
def retry_failed(name):
	_check_user()
	return engine.retry_failed(name)


@frappe.whitelist()
def set_step_paused(name, step_idx, paused=1):
	"""Pause or resume one step of a campaign."""
	_check_user()
	return engine.set_step_paused(name, step_idx, paused)


# -- calendar, list clean-up -------------------------------------------------------------------------------------


@frappe.whitelist()
def get_calendar(from_date, to_date):
	"""Campaigns (and the days their follow-up steps are due) between two dates, for the calendar view."""
	_check_user()
	return {"events": schedule_view.events(from_date, to_date), "today": frappe.utils.nowdate()}


def _manager_only():
	_check_user()
	if not is_manager():
		frappe.throw(_("Only managers can edit the clean-up list."), frappe.PermissionError)


@frappe.whitelist()
def list_suppressed(channel=None, source=None, search=None, start=0, page_length=25):
	"""Email addresses and numbers that were removed from sending after a bounce or an invalid-number failure."""
	_manager_only()
	return hygiene.list_suppressed(channel, source, search, start, page_length)


@frappe.whitelist()
def restore_suppressed(name):
	_manager_only()
	return hygiene.restore(name)


@frappe.whitelist()
def scan_failed_addresses(days=90):
	"""Apply the clean-up rule to failures that happened before it existed."""
	_manager_only()
	return {"added": hygiene.scan_history(days)}


# -- results -------------------------------------------------------------------------------------------------


@frappe.whitelist()
def get_analytics(name, from_date=None, to_date=None):
	doc = _get(name)
	out = analytics.get_analytics(name, from_date, to_date)
	out["campaign"] = {"name": doc.name, "campaign_name": doc.campaign_name, "status": doc.status, "total_recipients": doc.total_recipients, "status_note": doc.status_note, "health_note": doc.health_note, "started_at": doc.started_at, "completed_at": doc.completed_at}
	return out


RECIPIENT_COLUMNS = (
	"name", "recipient_type", "recipient_id", "recipient_name", "channel", "status", "email", "whatsapp_number", "skip_reason",
	"failure_reason", "retry_count", "step_idx", "due_at", "queued_at", "sent_at", "delivered_at", "read_at", "failed_at", "provider_status",
)


@frappe.whitelist()
def list_recipients(name, channel=None, status=None, search=None, start=0, page_length=50, from_date=None, to_date=None):
	"""Recipient rows of a campaign. ``from_date`` / ``to_date`` keep the rows whose activity (sent, else failed, else
	created) is in the range, the same rule as the analytics.

	One query with the range in its WHERE clause. (It used to fetch the name of every recipient in the range and send
	them all back as an ``IN (...)`` list, which for a campaign with tens of thousands of recipients was a multi-megabyte
	query on every page and every step of the CSV export.) Access is the campaign's: ``_get`` has just checked that the
	caller may read it, and recipients are only ever visible through their campaign."""
	_get(name)
	where = ["r.campaign = %(campaign)s"]
	values = {"campaign": name}
	if channel in CHANNELS:
		where.append("r.channel = %(channel)s")
		values["channel"] = channel
	if status:
		where.append("r.status = %(status)s")
		values["status"] = status
	if search:
		where.append("(r.recipient_name LIKE %(q)s OR r.email LIKE %(q)s OR r.whatsapp_number LIKE %(q)s)")
		values["q"] = f"%{search}%"
	rng, rv = activity_clause("r", from_date, to_date)
	clause = " AND ".join(where) + rng
	values.update(rv)
	columns = ", ".join("r.`%s`" % c for c in RECIPIENT_COLUMNS)
	rows = frappe.db.sql(
		f"""SELECT {columns} FROM `tab{RECIPIENT}` r WHERE {clause}
		ORDER BY r.modified DESC, r.name LIMIT %(limit)s OFFSET %(start)s""",
		{**values, "limit": min(cint(page_length) or 50, 200), "start": max(cint(start), 0)},
		as_dict=True,
	)
	total = frappe.db.sql(f"SELECT COUNT(*) FROM `tab{RECIPIENT}` r WHERE {clause}", values)[0][0]
	return {"rows": rows, "total": cint(total)}


@frappe.whitelist()
def lead_campaign_history(lead):
	"""Campaign activity for one Lead (the Lead page tab)."""
	_check_user()
	frappe.get_doc(LEAD, lead).check_permission("read")
	rows = frappe.get_all(
		RECIPIENT,
		filters={"recipient_type": LEAD, "recipient_id": lead, "status": ["not in", ["Pending", "Cancelled"]]},
		fields=["campaign", "channel", "status", "skip_reason", "failure_reason", "sent_at", "delivered_at", "read_at", "failed_at", "modified"],
		order_by="modified desc", limit_page_length=50,
	)
	names = {c.name: c.campaign_name for c in frappe.get_all(CAMPAIGN, filters={"name": ["in", list({r.campaign for r in rows}) or [""]]}, fields=["name", "campaign_name"])}
	for r in rows:
		r["campaign_name"] = names.get(r.campaign, r.campaign)
	return rows


@frappe.whitelist()
def opt_out_recipient(recipient):
	"""Add a recipient's address to the opt-out list (manager action from the recipient report)."""
	_check_user()
	if not is_manager():
		frappe.throw(_("Only managers can edit the opt-out list."), frappe.PermissionError)
	rec = frappe.get_doc(RECIPIENT, recipient)
	rec.check_permission("read")
	value = rec.email if rec.channel == "Email" else rec.whatsapp_number
	optout.add_opt_out(rec.channel, value, source="Manual", reason=_("Added from campaign {0}").format(rec.campaign), lead=rec.recipient_id)
	return True
