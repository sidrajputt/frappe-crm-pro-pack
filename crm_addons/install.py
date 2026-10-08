"""Everything the app sets up in a CRM site, on install and on every migrate.

All steps are idempotent: they add what is missing and never overwrite what an
admin has customised (settings, dashboard layout, the quick-entry layout).
"""

import json

import frappe

APP_VERSION_KEY = "crm_addons_scripts_version"
SEEDED_KEY = "crm_addons_dashboard_seeded"  # comma-separated chart groups already added once
SCRIPT_VERSION = "5"  # bump when the scripts below change
SCRIPT_PREFIX = "CRM Add-ons"

NEW_SETTING_DEFAULTS = {
	"lead_scoring_enabled": 1,
	"stale_lead_days": 7,
	"missed_call_whatsapp_text": "Hi, I just tried to call you but could not reach you. When is a good time to talk?",
	"enable_follow_ups": 1,
	"follow_up_reminders": 1,
	"escalate_after_attempts": 3,
	"show_floating_buttons": 1,
	"show_sidebar_links": 1,
	"show_record_tabs": 1,
	"show_follow_up_button": 1,
	"hide_deals_menu": 0,
	"hide_notes_menu": 0,
	"hide_tasks_menu": 0,
	"hide_call_logs_menu": 0,
	"hide_convert_button": 0,
	"campaigns_enabled": 1,
	"campaign_batch_size": 100,
	"campaign_rate_per_minute": 300,
	"campaign_max_retries": 2,
	"whatsapp_consent_mode": "Require opt-in",
	"campaign_alerts_enabled": 1,
	"campaign_alert_failure_percent": 30,
	"campaign_alert_min_messages": 20,
}

NEXT_FOLLOWUP_FIELD = {
	"fieldname": "next_follow_up_on",
	"fieldtype": "Datetime",
	"label": "Next Follow-up",
	"read_only": 1,
	"no_copy": 1,
	"print_hide": 1,
	"report_hide": 0,
	"description": "Set automatically by CRM Pro Pack.",
}

SCORE_FIELD = {
	"fieldname": "addons_score",
	"fieldtype": "Int",
	"label": "Lead Score",
	"read_only": 1,
	"no_copy": 1,
	"print_hide": 1,
	"report_hide": 0,
	"description": "0-100, worked out by CRM Pro Pack from calls, outcomes, meetings and recent activity.",
}

STALE_FIELD = {
	"fieldname": "addons_stale_alerted_on",
	"fieldtype": "Date",
	"label": "Stale Alert Sent On",
	"read_only": 1,
	"hidden": 1,
	"no_copy": 1,
	"print_hide": 1,
	"report_hide": 1,
}

NEXT_MEETING_FIELD = {
	"fieldname": "next_meeting_on",
	"fieldtype": "Datetime",
	"label": "Next Meeting",
	"read_only": 1,
	"no_copy": 1,
	"print_hide": 1,
	"report_hide": 0,
	"description": "Set automatically by CRM Pro Pack.",
}

# Consent is the one thing a campaign must never lose, so this field is NOT removed on uninstall.
WA_OPT_IN_FIELD = {
	"fieldname": "crm_wa_opt_in",
	"fieldtype": "Check",
	"label": "WhatsApp Opt-in",
	"no_copy": 1,
	"in_standard_filter": 1,
	"description": "The lead agreed to receive WhatsApp messages. Meta requires this for marketing templates.",
}

STARTER_EMAIL_TEMPLATES = [
	(
		"Follow-up (starter)",
		"Following up on your enquiry, {{ first_name }}",
		"<p>Hi {{ first_name }},</p><p>{{ owner_name or sender_name }} from our team is following up on your enquiry. "
		"Reply to this email or call us whenever it suits you.</p><p>Regards,<br>{{ sender_name }}</p>",
	),
]

# -- CRM scripts ----------------------------------------------------------------------
# Loaded by CRM's own script engine, so no CRM source file is ever edited.

LOADER = """// Managed by the CRM Pro Pack app. It is rewritten when the app updates - do not edit.
function crmAddonsLoad() {
	if (window.crmAddons) return Promise.resolve(window.crmAddons)
	// the add-on script is already on the page and knows the current version of every file
	if (window.crmAddonsUI && window.crmAddonsUI.loadBridge) return window.crmAddonsUI.loadBridge()
	return new Promise((resolve, reject) => {
		const s = document.createElement("script")
		s.src = "/assets/crm_addons/bridge.js?v=__VERSION__"
		s.onload = () => resolve(window.crmAddons)
		s.onerror = () => reject(new Error("CRM Pro Pack could not be loaded"))
		document.head.appendChild(s)
	})
}
"""

FORM_SCRIPT = (
	LOADER
	+ """
class __CLASS__ {
	async onLoad() {
		let cm
		try { cm = await crmAddonsLoad() } catch (e) { return }
		const config = await cm.config()
		const buttons = []
		if (config.show_record_buttons) {
			buttons.push({
				label: "Schedule Meeting",
				icon: "calendar",
				onClick: () => cm.openEditor({ reference_doctype: "__DT__", reference_docname: this.doc.name }),
			})
		}
		if (config.follow_ups_enabled && config.show_follow_up_button) {
			buttons.push({
				label: "Add Follow Up",
				icon: "phone-call",
				onClick: () => cm.openFollowUp({ reference_docname: this.doc.name }),
			})
		}
		if (!buttons.length) return
		// append, never replace: other scripts may have added their own buttons
		this.actions = [...(this.actions || []), ...buttons]
	}
}
"""
)

LIST_SCRIPT = (
	LOADER
	+ """
async function setupList() {
	let cm
	try { cm = await crmAddonsLoad() } catch (e) { return {} }
	const config = await cm.config()
	if (!config.show_list_button) return {}
	const actions = [
		{ label: "Meetings", icon: "calendar", onClick: () => cm.openCalendar({ reference_doctype: "__DT__", view: "agenda" }) },
	]
	if (config.campaigns_enabled) {
		actions.push({ label: "Campaigns", icon: "send", onClick: () => cm.openCampaigns() })
	}
	if (config.follow_ups_enabled) {
		actions.push({
			label: "Follow-ups",
			icon: "phone-call",
			onClick: () => window.crmAddonsUI && window.crmAddonsUI.openQueue("__DT__"),
		})
		actions.push({ label: "Sales Dashboard", icon: "bar-chart-2", onClick: () => cm.openDashboard() })
	}
	return { actions }
}
"""
)

SCRIPTS = [
	# (record name, doctype, view, class name, template)
	("Lead page", "CRM Lead", "Form", "CRMLead", FORM_SCRIPT),
	("Leads list", "CRM Lead", "List", None, LIST_SCRIPT),
]

LAST_OUTCOME_FIELD = {
	"fieldname": "addons_last_outcome",
	"fieldtype": "Data",
	"label": "Last Call Outcome",
	"read_only": 1,
	"no_copy": 1,
	"print_hide": 1,
	"report_hide": 0,
}

LAST_REMARK_FIELD = {
	"fieldname": "addons_last_remark",
	"fieldtype": "Small Text",
	"label": "Last Follow-up Remark",
	"read_only": 1,
	"no_copy": 1,
	"print_hide": 1,
	"report_hide": 0,
}

ATTEMPT_FIELD = {
	"fieldname": "addons_call_attempts",
	"fieldtype": "Int",
	"label": "Call Attempt",
	"read_only": 1,
	"no_copy": 1,
	"print_hide": 1,
	"report_hide": 0,
	"description": "The attempt number of the latest call: calls in a row until someone picked up.",
}

CUSTOM_FIELDS = [
	NEXT_MEETING_FIELD,
	NEXT_FOLLOWUP_FIELD,
	LAST_OUTCOME_FIELD,
	LAST_REMARK_FIELD,
	ATTEMPT_FIELD,
	SCORE_FIELD,
	STALE_FIELD,
]

DEFAULT_TEMPLATES = [
	# title, outcome, remark, next follow-up after (hours)
	("Did not pick - try in 2 hours", "Did Not Pick", "Phone was ringing, no pick-up.", 2),
	("Did not pick - try tomorrow", "Did Not Pick", "Did not pick up.", 24),
	("Did not connect - try tomorrow", "Did Not Connect", "Busy, switched off or not reachable.", 24),
	("Interested - follow up in 2 days", "Interested", "Interested. Follow up in a couple of days.", 48),
	("Ask for detail - send and follow up", "Ask for Detail", "Asked for details. Send them and follow up.", 48),
	("Call back later", "Call Back Later", "Asked to be called back later.", 72),
	("Meeting scheduled", "Meeting Scheduled", "Meeting agreed.", 0),
	("Not interested", "Not Interested", "Not interested right now.", 0),
]

DASHBOARD_GROUPS = {
	# group: [(name, type, x, y-offset (rows below the bottom at the time), w, h)]
	"meetings": [
		("meetings_today", "number_chart", 0, 0, 4, 3),
		("upcoming_meetings_week", "number_chart", 4, 0, 4, 3),
		("meetings_in_period", "number_chart", 8, 0, 4, 3),
		("meetings_by_day", "axis_chart", 0, 3, 10, 9),
		("meetings_by_status", "donut_chart", 10, 3, 10, 9),
	],
	"insights": [
		("activity_by_salesperson", "axis_chart", 0, 0, 10, 9),
		("leads_by_score_band", "donut_chart", 10, 0, 10, 9),
		("meetings_by_outcome", "donut_chart", 0, 9, 10, 9),
	],
	"follow_ups": [
		("follow_ups_due_today", "number_chart", 0, 0, 4, 3),
		("overdue_follow_ups", "number_chart", 4, 0, 4, 3),
		("call_connect_rate", "number_chart", 8, 0, 4, 3),
		("attempts_to_connect", "number_chart", 12, 0, 4, 3),
		("follow_ups_by_day", "axis_chart", 0, 3, 10, 9),
		("follow_ups_by_outcome", "donut_chart", 10, 3, 10, 9),
		("calls_by_status", "donut_chart", 0, 12, 10, 9),
	],
}
DASHBOARD_ITEMS = [item for group in DASHBOARD_GROUPS.values() for item in group]


def after_install():
	run_all()


def after_migrate():
	run_all()


def run_all():
	if not frappe.db.exists("DocType", "CRM Lead"):
		return  # Frappe CRM is not on this site
	ensure_settings()
	remove_deal_leftovers()
	ensure_custom_fields()
	ensure_templates()
	ensure_quick_entry_layout()
	ensure_scripts()
	ensure_dashboard()
	ensure_workspace()
	backfill_next_meetings()
	ensure_campaign_setup()


# -- Desk workspace --------------------------------------------------------------------------

WORKSPACE = "CRM Pro Pack"
WORKSPACE_SHORTCUTS = [
	# label, type, target (a doctype, or a URL)
	("CRM Addons Settings", "DocType", "CRM Addons Settings"),
	("Meetings", "DocType", "CRM Meeting"),
	("Follow-ups", "DocType", "CRM Follow Up"),
	("Follow-up Templates", "DocType", "CRM Follow Up Template"),
	("Sales Dashboard", "URL", "/sales-dashboard"),
	("Campaign Manager", "URL", "/campaigns"),
	("Campaigns", "DocType", "CRM Campaign"),
	("Campaign Email Templates", "DocType", "CRM Campaign Email Template"),
	("Campaign Opt-outs", "DocType", "CRM Campaign Opt Out"),
]


def ensure_workspace():
	"""A Desk workspace with the app's settings, lists and the Sales Dashboard, so they can be
	found without knowing the doctype names. Created once; after that the admin owns it. It is
	only a convenience: if the site's Frappe cannot create it, everything else still works."""
	if not frappe.db.exists("DocType", "Workspace") or frappe.db.exists("Workspace", WORKSPACE):
		return
	try:
		blocks = [
			{"id": frappe.generate_hash(length=10), "type": "header", "data": {"text": '<span class="h4"><b>CRM Pro Pack</b></span>', "col": 12}}
		] + [
			{"id": frappe.generate_hash(length=10), "type": "shortcut", "data": {"shortcut_name": label, "col": 3}}
			for label, _type, _target in WORKSPACE_SHORTCUTS
		]
		shortcuts = [
			{"label": label, "type": kind, **({"link_to": target, "doc_view": "List"} if kind == "DocType" else {"url": target})}
			for label, kind, target in WORKSPACE_SHORTCUTS
		]
		frappe.get_doc(
			{
				"doctype": "Workspace",
				"name": WORKSPACE,
				"label": WORKSPACE,
				"title": WORKSPACE,
				"module": "Meetings",
				"public": 1,
				"content": json.dumps(blocks),
				"shortcuts": shortcuts,
			}
		).insert(ignore_permissions=True)
	except Exception:
		frappe.log_error(title="CRM Pro Pack: could not create the Desk workspace", message=frappe.get_traceback())


# -- settings ----------------------------------------------------------------------------


def ensure_settings():
	"""Create the settings with sensible defaults; auto-select a connected Google Calendar."""
	from crm_addons.providers.google_meet import _usable

	first_time = not frappe.db.sql("select 1 from `tabSingles` where doctype = 'CRM Addons Settings' limit 1")
	settings = frappe.get_doc("CRM Addons Settings")
	changed = first_time

	if not settings.google_calendar:
		usable = [
			name
			for name in frappe.get_all(
				"Google Calendar", filters={"enable": 1, "push_to_google_calendar": 1}, pluck="name"
			)
			if _usable(name)
		]
		if len(usable) == 1:  # unambiguous: use it, the admin can change it later
			settings.google_calendar = usable[0]
			changed = True

	if changed:
		settings.flags.ignore_permissions = True
		settings.save()

	# Settings added after a site's first install have no stored value and would read as "off".
	for fieldname, value in NEW_SETTING_DEFAULTS.items():
		stored = frappe.db.sql(
			"select 1 from `tabSingles` where doctype = 'CRM Addons Settings' and field = %s limit 1", fieldname
		)
		if not stored:
			frappe.db.set_single_value("CRM Addons Settings", fieldname, value)
	frappe.clear_document_cache("CRM Addons Settings", "CRM Addons Settings")


def ensure_campaign_setup():
	"""Campaign Manager: the Lead's consent field and one starter email template. Idempotent, and it
	never touches anything an admin already changed."""
	from frappe.custom.doctype.custom_field.custom_field import create_custom_fields

	create_custom_fields({"CRM Lead": [WA_OPT_IN_FIELD]}, ignore_validate=True)
	if frappe.db.get_default("crm_addons_campaign_templates_seeded") or not frappe.db.exists(
		"DocType", "CRM Campaign Email Template"
	):
		return
	for title, subject, body in STARTER_EMAIL_TEMPLATES:
		if not frappe.db.exists("CRM Campaign Email Template", title):
			frappe.get_doc(
				{"doctype": "CRM Campaign Email Template", "template_name": title, "subject": subject, "body_html": body, "enabled": 1}
			).insert(ignore_permissions=True)
	frappe.db.set_default("crm_addons_campaign_templates_seeded", "1")


def backfill_next_meetings():
	"""Fill the "Next Meeting" column for meetings that already exist."""
	from crm_addons.utils import refresh_next_meeting

	for row in frappe.db.sql(
		"select distinct reference_doctype, reference_docname from `tabCRM Meeting` where status = 'Scheduled'"
	):
		refresh_next_meeting(*row)


# -- Leads only: remove what an earlier version added to Deals -----------------------------------------------


def remove_deal_leftovers():
	"""This app works on Leads only. Clean up the Deal scripts and fields older versions created."""
	if frappe.db.exists("DocType", "CRM Form Script"):
		keep = {f"{SCRIPT_PREFIX}: {label}" for label, *_rest in SCRIPTS}
		for name in frappe.get_all("CRM Form Script", filters={"name": ["like", f"{SCRIPT_PREFIX}:%"]}, pluck="name"):
			if name not in keep:
				frappe.delete_doc("CRM Form Script", name, force=1, ignore_permissions=True)
	for definition in CUSTOM_FIELDS:
		field = f"CRM Deal-{definition['fieldname']}"
		if frappe.db.exists("Custom Field", field):
			frappe.delete_doc("Custom Field", field, force=1, ignore_permissions=True)


# -- follow-up templates ------------------------------------------------------------------------------


def ensure_templates():
	"""Add the starter templates once. After that the admin owns them (edit, disable, delete)."""
	if frappe.db.get_default("crm_addons_templates_seeded") or not frappe.db.exists("DocType", "CRM Follow Up Template"):
		return
	for title, outcome, remark, hours in DEFAULT_TEMPLATES:
		if not frappe.db.exists("CRM Follow Up Template", title):
			frappe.get_doc(
				{
					"doctype": "CRM Follow Up Template",
					"title": title,
					"outcome": outcome,
					"remark": remark,
					"next_follow_up_after_hours": hours,
				}
			).insert(ignore_permissions=True)
	frappe.db.set_default("crm_addons_templates_seeded", "1")


# -- custom fields ------------------------------------------------------------------------


def ensure_custom_fields():
	from frappe.custom.doctype.custom_field.custom_field import create_custom_fields

	create_custom_fields(
		{"CRM Lead": list(CUSTOM_FIELDS)}, ignore_validate=True
	)


# -- quick-entry layout (Desk / generic CRM dialogs) ---------------------------------------------

QUICK_ENTRY_LAYOUT = [
	{
		"name": "first_tab",
		"sections": [
			{"name": "meeting_section", "columns": [{"name": "meeting_column", "fields": ["subject"]}]},
			{
				"name": "time_section",
				"columns": [
					{"name": "starts_column", "fields": ["starts_on"]},
					{"name": "ends_column", "fields": ["ends_on"]},
				],
				"hideBorder": True,
			},
			{
				"name": "details_section",
				"columns": [{"name": "details_column", "fields": ["add_video_conferencing", "description"]}],
				"hideBorder": True,
			},
		],
	}
]


def ensure_quick_entry_layout():
	if not frappe.db.exists("DocType", "CRM Fields Layout"):
		return
	if frappe.db.exists("CRM Fields Layout", {"dt": "CRM Meeting", "type": "Quick Entry"}):
		return
	frappe.get_doc(
		{
			"doctype": "CRM Fields Layout",
			"dt": "CRM Meeting",
			"type": "Quick Entry",
			"layout": json.dumps(QUICK_ENTRY_LAYOUT),
		}
	).insert(ignore_permissions=True)


# -- CRM form / list scripts ----------------------------------------------------------------------


def _script_body(template, dt, cls):
	return template.replace("__VERSION__", SCRIPT_VERSION).replace("__DT__", dt).replace("__CLASS__", cls or "")


def ensure_scripts():
	"""Install or refresh the scripts that add the buttons to CRM. Standard scripts
	are read-only for admins outside developer mode, so they are updated in place."""
	if not frappe.db.exists("DocType", "CRM Form Script"):
		return
	for label, dt, view, cls, template in SCRIPTS:
		name = f"{SCRIPT_PREFIX}: {label}"
		body = _script_body(template, dt, cls)
		if frappe.db.exists("CRM Form Script", name):
			if frappe.db.get_value("CRM Form Script", name, "script") != body:
				frappe.db.set_value("CRM Form Script", name, {"script": body, "enabled": 1}, update_modified=False)
			continue
		frappe.get_doc(
			{
				"doctype": "CRM Form Script",
				"name": name,
				"dt": dt,
				"view": view,
				"enabled": 1,
				"is_standard": 1,
				"script": body,
			}
		).insert(ignore_permissions=True)


# -- dashboard ---------------------------------------------------------------------------------------


def _seeded():
	return {g for g in (frappe.db.get_default(SEEDED_KEY) or "").split(",") if g}


def ensure_dashboard():
	"""Add each group of add-on charts to the CRM dashboard once. After that the admin owns
	the layout: removing a chart from the dashboard is respected."""
	if not frappe.db.exists("DocType", "CRM Dashboard"):
		return
	todo = [g for g in DASHBOARD_GROUPS if g not in _seeded()]
	if not todo:
		return
	try:
		from crm.fcrm.doctype.crm_dashboard.crm_dashboard import create_default_manager_dashboard

		create_default_manager_dashboard()
		doc = frappe.get_doc("CRM Dashboard", "Manager Dashboard")
		layout = json.loads(doc.layout or "[]")
		present = {item.get("name") for item in layout}
		for group in todo:
			bottom = max((i["layout"]["y"] + i["layout"]["h"] for i in layout if i.get("layout")), default=0)
			for name, chart_type, x, dy, w, h in DASHBOARD_GROUPS[group]:
				if name not in present:
					layout.append({"name": name, "type": chart_type, "layout": {"x": x, "y": bottom + dy, "w": w, "h": h, "i": name}})
		doc.layout = json.dumps(layout)
		doc.save(ignore_permissions=True)
		frappe.db.set_default(SEEDED_KEY, ",".join(sorted(_seeded() | set(todo))))
	except Exception:
		frappe.log_error(title="CRM Add-ons: could not add the dashboard charts", message=frappe.get_traceback())


# -- uninstall ------------------------------------------------------------------------------------------


def before_uninstall():
	if frappe.db.exists("Workspace", WORKSPACE):
		frappe.delete_doc("Workspace", WORKSPACE, force=1, ignore_permissions=True)
	for name in frappe.get_all("CRM Form Script", filters={"name": ["like", f"{SCRIPT_PREFIX}:%"]}, pluck="name"):
		frappe.delete_doc("CRM Form Script", name, force=1, ignore_permissions=True)
	for dt in ("CRM Lead", "CRM Deal"):
		for definition in CUSTOM_FIELDS:
			field = f"{dt}-{definition['fieldname']}"
			if frappe.db.exists("Custom Field", field):
				frappe.delete_doc("Custom Field", field, force=1, ignore_permissions=True)
	if frappe.db.exists("CRM Fields Layout", "CRM Meeting-Quick Entry"):
		frappe.delete_doc("CRM Fields Layout", "CRM Meeting-Quick Entry", force=1, ignore_permissions=True)
	if frappe.db.exists("CRM Dashboard", "Manager Dashboard"):
		doc = frappe.get_doc("CRM Dashboard", "Manager Dashboard")
		ours = {item[0] for item in DASHBOARD_ITEMS}
		layout = [i for i in json.loads(doc.layout or "[]") if i.get("name") not in ours]
		doc.layout = json.dumps(layout)
		doc.save(ignore_permissions=True)
	frappe.db.set_default(SEEDED_KEY, "")
	frappe.db.set_default("crm_addons_templates_seeded", "")
