"""Backend of the Pro Pack setup page (``/pro-pack-setup``).

The page is a friendlier front for the *CRM Addons Settings* record: it reads and writes the same fields (so the desk form
keeps working), and it adds a live setup checklist that says what still needs to be done and how. System Managers only.
"""

import frappe
from frappe import _
from frappe.utils import cint, flt, get_url

LAYOUT = {"Section Break", "Column Break", "Tab Break", "HTML", "Button", "Heading"}
SETTINGS = "CRM Addons Settings"


def _only_admins():
	frappe.only_for("System Manager")


def _fields():
	return {f.fieldname: f for f in frappe.get_meta(SETTINGS).fields if f.fieldtype not in LAYOUT}


def _values():
	doc = frappe.get_doc(SETTINGS)
	out = {}
	for name, df in _fields().items():
		value = doc.get(name)
		if df.fieldtype == "Check":
			value = cint(value)
		elif df.fieldtype in ("Int",):
			value = cint(value)
		elif df.fieldtype in ("Float", "Currency"):
			value = flt(value) or ""  # Frappe stores an empty number as 0; on the page 0 and empty both mean "not set"
		elif df.fieldtype == "Percent":
			value = flt(value)
		out[name] = value if value is not None else ("" if df.fieldtype not in ("Check", "Int") else 0)
	return out


def _choices():
	"""Lists the page needs for its drop-downs."""
	statuses = frappe.get_all("CRM Lead Status", pluck="name", order_by="position asc") if frappe.db.exists("DocType", "CRM Lead Status") else []
	calendars = frappe.get_all("Google Calendar", fields=["name", "enable", "push_to_google_calendar"], order_by="name asc") if frappe.db.exists("DocType", "Google Calendar") else []
	return {
		"lead_statuses": statuses,
		"google_calendars": [{"value": c.name, "label": c.name + ("" if c.enable and c.push_to_google_calendar else " (not ready)")} for c in calendars],
		"providers": ["Google Meet", "Manual Link"],
	}


def _workers_for(queue):
	"""How many background workers listen to ``queue`` (None when that cannot be found out)."""
	try:
		from frappe.utils.background_jobs import get_queues, get_redis_conn
		from rq import Worker

		conn = get_redis_conn()
		prefixed = {q.name for q in get_queues() if queue in q.name}
		return sum(1 for w in Worker.all(connection=conn) if prefixed & {q.name for q in w.queues})
	except Exception:
		return None


def _status():
	from frappe.utils.scheduler import is_scheduler_disabled

	from crm_addons.campaigns.common import default_whatsapp_account, email_account_problem, whatsapp_installed
	from crm_addons.providers.google_meet import GoogleMeetProvider

	settings = frappe.get_doc(SETTINGS)
	checks = []

	google = GoogleMeetProvider().status()
	checks.append(
		{
			"key": "google", "label": _("Google Meet and Calendar"), "state": "ok" if google["ready"] else "todo",
			"message": google["message"],
			"why": _("Needed to create a Google Meet link when someone schedules a meeting. Skip it if you only use manual links."),
			"fix": {"label": _("Open Google Calendar"), "url": "/app/google-calendar"},
			"steps": [
				_("In Google Cloud Console create a project, switch on the Google Calendar API and create an OAuth client of type Web application."),
				_("Add this Authorized redirect URI: {0}").format(get_url() + "?cmd=frappe.integrations.doctype.google_calendar.google_calendar.google_callback"),
				_("In Google Settings, enable the integration and enter the Client ID and Client Secret."),
				_("Create a Google Calendar record for a company account, tick Enable and Push to Google Calendar, then press Authorize Google Calendar Access."),
				_("Come back here and choose that calendar under Meetings, then save."),
			],
		}
	)
	problem = email_account_problem()
	checks.append(
		{
			"key": "email", "label": _("Outgoing email"), "state": "todo" if problem else "ok",
			"message": problem or _("An outgoing Email Account is ready."),
			"why": _("Campaign emails, meeting invitations and reminders are sent through it."),
			"fix": {"label": _("Open Email Account"), "url": "/app/email-account"},
			"steps": [_("Open Email Account, add or open your sending account."), _("Tick Enable Outgoing and Default Outgoing, then save.")],
		}
	)
	scheduler_on = not is_scheduler_disabled()
	checks.append(
		{
			"key": "scheduler", "label": _("Scheduler"), "state": "ok" if scheduler_on else "todo",
			"message": _("Reminders, campaign sending and health checks run on schedule.") if scheduler_on else _("The scheduler is off, so reminders and campaigns cannot send."),
			"why": _("Campaigns are sent by a job that runs every minute."),
			"fix": None,
			"steps": [_("Run: bench --site your-site enable-scheduler"), _("Make sure the bench is running (bench start, or your process manager).")],
		}
	)
	workers = _workers_for("long") if cint(settings.campaigns_enabled) else None
	if workers is not None:
		checks.append(
			{
				"key": "workers", "label": _("Background worker for campaigns"), "state": "ok" if workers else "todo",
				"message": _("{0} worker(s) are listening.").format(workers) if workers else _("No worker is listening to the long queue, so campaign messages would wait forever."),
				"why": _("Campaign messages are sent by workers on the long queue."),
				"fix": None,
				"steps": [_("Start the bench with its workers (bench start), or add a worker for the long queue to your process manager.")],
			}
		)
	if whatsapp_installed():
		ready = bool(default_whatsapp_account())
		checks.append(
			{
				"key": "whatsapp", "label": _("WhatsApp"), "state": "ok" if ready else "todo",
				"message": _("An active default WhatsApp account is set.") if ready else _("No active default outgoing WhatsApp Account."),
				"why": _("Needed to send WhatsApp campaigns and missed-call messages. Email campaigns work without it."),
				"fix": {"label": _("Open WhatsApp Account"), "url": "/app/whatsapp-account"},
				"steps": [_("Open WhatsApp Account and add your Meta details."), _("Set it to Active and tick Default Outgoing, then sync your templates from the Campaign Manager.")],
			}
		)
		code = (settings.default_country_code or "").strip()
		checks.append(
			{
				"key": "country", "label": _("Default country code"), "state": "ok" if code else "todo",
				"message": _("Numbers without a country code get +{0}.").format(code.lstrip("+")) if code else _("Not set: local phone numbers cannot be turned into WhatsApp numbers."),
				"why": _("Leads often store 98765 43210 without the country code; WhatsApp needs it."),
				"fix": None, "field": "default_country_code",
				"steps": [_("Enter your country's code (for example 91) under Campaigns, then save.")],
			}
		)
	else:
		checks.append(
			{
				"key": "whatsapp", "label": _("WhatsApp"), "state": "optional",
				"message": _("The frappe_whatsapp app is not installed. Email campaigns still work."), "why": _("Only needed for WhatsApp campaigns."),
				"fix": None, "steps": [_("Install the frappe_whatsapp app on this site if you want WhatsApp campaigns.")],
			}
		)
	todo = sum(1 for c in checks if c["state"] == "todo")
	return {"checks": checks, "todo": todo, "ready": sum(1 for c in checks if c["state"] == "ok"), "total": sum(1 for c in checks if c["state"] != "optional")}


@frappe.whitelist()
def get_setup():
	"""Everything the setup page shows: current values, drop-down choices and the setup checklist."""
	_only_admins()
	return {"values": _values(), "choices": _choices(), "status": _status(), "site_url": get_url()}


@frappe.whitelist()
def save_setup(values):
	"""Save the changed settings. Unknown names are refused; the record's own validation decides what is acceptable."""
	_only_admins()
	values = frappe.parse_json(values) or {}
	allowed = _fields()
	unknown = [k for k in values if k not in allowed]
	if unknown:
		frappe.throw(_("Unknown setting: {0}").format(", ".join(unknown)))
	doc = frappe.get_doc(SETTINGS)
	for name, value in values.items():
		kind = allowed[name].fieldtype
		if kind in ("Check", "Int"):
			value = cint(value)
		elif kind in ("Float", "Currency", "Percent"):
			value = None if value in (None, "") else flt(value)
		elif value is None:
			value = ""
		doc.set(name, value)
	doc.save()
	frappe.clear_document_cache(SETTINGS, SETTINGS)
	return {"values": _values(), "status": _status()}
