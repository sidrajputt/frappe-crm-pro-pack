"""Whitelisted API used by the meetings UI, the CRM scripts and the settings page."""

import frappe
from frappe import _
from frappe.utils import cint, escape_html, get_url, now_datetime

from crm_addons import notifications
from crm_addons.providers import provider_catalog
from crm_addons.providers.base import ProviderError
from crm_addons.utils import (
	REFERENCE_DOCTYPES,
	REFERENCE_META,
	get_reference_info,
	get_settings,
	is_manager,
	user_details,
)

LIST_FIELDS = [
	"name",
	"subject",
	"status",
	"provider",
	"starts_on",
	"ends_on",
	"add_video_conferencing",
	"google_meet_link",
	"description",
	"reference_doctype",
	"reference_docname",
	"organizer",
	"owner",
	"creation",
	"sync_status",
	"sync_error",
	"external_event_url",
	"meeting_outcome",
	"outcome_notes",
]


# -- helpers ----------------------------------------------------------------------


def _attendees_by_meeting(names):
	if not names:
		return {}
	rows = frappe.get_all(
		"CRM Meeting Attendee",
		filters={"parent": ["in", [str(n) for n in names]], "parenttype": "CRM Meeting"},
		fields=["parent", "email", "full_name", "user", "attendee_type", "rsvp"],
		order_by="idx asc",
		parent_doctype="CRM Meeting",
	)
	grouped = {}
	for row in rows:
		grouped.setdefault(str(row.parent), []).append(
			{k: row[k] for k in ("email", "full_name", "user", "attendee_type", "rsvp")}
		)
	return grouped


def _can_edit(row, user=None):
	user = user or frappe.session.user
	return is_manager(user) or user in (row.get("owner"), row.get("organizer"))


def _decorate(rows):
	"""Add guests, the Lead title and edit rights to raw meeting rows."""
	guests = _attendees_by_meeting([r["name"] for r in rows])
	cache, out = {}, []
	for row in rows:
		key = (row["reference_doctype"], row["reference_docname"])
		if key not in cache:
			cache[key] = get_reference_info(*key)
		info = cache[key]
		organizer = row.get("organizer") or row.get("owner")
		out.append(
			{
				**row,
				"starts_on": str(row["starts_on"]),
				"ends_on": str(row["ends_on"]),
				"creation": str(row.get("creation") or ""),
				"organizer": organizer,
				"organizer_name": user_details(organizer)[1] or organizer,
				"reference_title": info["title"],
				"reference_url": info["url"],
				"attendees": guests.get(str(row["name"]), []),
				"can_edit": _can_edit(row),
			}
		)
	return out


def _get_meeting(name, ptype="read"):
	if not frappe.db.exists("CRM Meeting", name):
		frappe.throw(_("This meeting no longer exists."), frappe.DoesNotExistError)
	doc = frappe.get_doc("CRM Meeting", name)
	doc.check_permission(ptype)
	return doc


def _serialize(doc):
	row = {f: doc.get(f) for f in LIST_FIELDS}
	return _decorate([row])[0]


def _check_reference(reference_doctype, reference_docname):
	if reference_doctype not in REFERENCE_DOCTYPES:
		frappe.throw(_("A meeting can only be linked to a Lead."))
	if not frappe.db.exists(reference_doctype, reference_docname):
		frappe.throw(_("{0} {1} was not found.").format(reference_doctype, reference_docname))
	if not is_manager():
		frappe.has_permission(reference_doctype, "read", doc=reference_docname, throw=True)


# -- client config --------------------------------------------------------------------


@frappe.whitelist(methods=["GET", "POST"])
def get_csrf_token():
	"""Lets the meetings page (a static file) send changes when it is opened on its own.
	The token is only readable from the same origin, exactly like the one in Desk's HTML."""
	from frappe.sessions import get_csrf_token

	return get_csrf_token()


@frappe.whitelist()
def get_client_config():
	# settings.get(): a field added by a newer version is simply empty until `bench migrate` has run,
	# instead of failing every page load
	settings = get_settings()
	return {
		"user": frappe.session.user,
		"user_name": user_details(frappe.session.user)[1] or frappe.session.user,
		"is_manager": is_manager(),
		"show_record_buttons": cint(settings.get("show_record_buttons")),
		"show_list_button": cint(settings.get("show_list_button")),
		"show_floating_buttons": cint(settings.get("show_floating_buttons")),
		"show_sidebar_links": cint(settings.get("show_sidebar_links")),
		"show_follow_up_button": cint(settings.get("show_follow_up_button")),
		"hide_deals_menu": cint(settings.get("hide_deals_menu")),
		"deals_enabled": 0 if cint(settings.get("hide_deals_menu")) else 1,  # dashboards leave deal numbers out for a team that does not use Deals
		"hide_notes_menu": cint(settings.get("hide_notes_menu")),
		"hide_tasks_menu": cint(settings.get("hide_tasks_menu")),
		"hide_call_logs_menu": cint(settings.get("hide_call_logs_menu")),
		"hide_convert_button": cint(settings.get("hide_convert_button")),
		"hide_lead_calls_tab": cint(settings.get("hide_lead_calls_tab")),
		"hide_lead_tasks_tab": cint(settings.get("hide_lead_tasks_tab")),
		"hide_lead_notes_tab": cint(settings.get("hide_lead_notes_tab")),
		"show_record_tabs": cint(settings.get("show_record_tabs")),
		"follow_ups_enabled": cint(settings.get("enable_follow_ups")),
		"campaigns_enabled": cint(settings.get("campaigns_enabled")),
		"default_duration": cint(settings.get("default_duration")) or 30,
		"default_add_video_meeting": cint(settings.get("default_add_video_meeting")),
		"default_provider": settings.get("default_provider") or "Google Meet",
		"providers": [p for p in provider_catalog() if p["implemented"]],
	}


# -- reading ---------------------------------------------------------------------------


@frappe.whitelist()
def list_meetings(start, end, scope="mine", reference_doctype=None, reference_name=None, status=None, limit=500):
	"""Meetings overlapping [start, end]. Sales users only ever get their own; for
	managers ``scope="all"`` returns everybody's, ``"mine"`` just theirs."""
	filters = [["starts_on", "<=", end], ["ends_on", ">=", start]]
	if reference_doctype:
		filters.append(["reference_doctype", "=", reference_doctype])
	if reference_name:
		filters.append(["reference_docname", "=", reference_name])
	if status:
		filters.append(["status", "=", status])

	rows = frappe.get_list(
		"CRM Meeting",
		filters=filters,
		fields=LIST_FIELDS,
		order_by="starts_on asc",
		limit_page_length=min(cint(limit) or 500, 1000),
	)
	if scope == "mine" and is_manager():
		me = frappe.session.user
		mine = set(
			frappe.get_all(
				"CRM Meeting Attendee",
				filters={"parent": ["in", [str(r["name"]) for r in rows] or [""]], "user": me},
				pluck="parent",
				parent_doctype="CRM Meeting",
			)
		)
		rows = [r for r in rows if me in (r["owner"], r["organizer"]) or str(r["name"]) in mine]
	return _decorate(rows)


@frappe.whitelist()
def get_meeting(name):
	return _serialize(_get_meeting(name))


@frappe.whitelist()
def get_meetings(reference_doctype, reference_name):
	"""Meetings of one Lead (used by a CRM "Meetings" tab, if the CRM has one)."""
	frappe.has_permission(reference_doctype, "read", doc=reference_name, throw=True)
	rows = frappe.get_list(
		"CRM Meeting",
		filters={"reference_doctype": reference_doctype, "reference_docname": reference_name},
		fields=LIST_FIELDS,
		order_by="starts_on desc",
		limit_page_length=200,
	)
	return _decorate(rows)


@frappe.whitelist()
def get_upcoming_meetings(reference_doctype=None, limit=20):
	"""Meetings that have not ended yet, soonest first."""
	filters = [["status", "=", "Scheduled"], ["ends_on", ">=", now_datetime()]]
	if reference_doctype:
		filters.append(["reference_doctype", "=", reference_doctype])
	rows = frappe.get_list(
		"CRM Meeting",
		filters=filters,
		fields=LIST_FIELDS,
		order_by="starts_on asc",
		limit_page_length=min(cint(limit) or 20, 100),
	)
	return _decorate(rows)


# -- writing ------------------------------------------------------------------------------

EDITABLE = (
	"subject",
	"starts_on",
	"ends_on",
	"provider",
	"add_video_conferencing",
	"google_meet_link",
	"description",
)


@frappe.whitelist()
def save_meeting(data, notify="all"):
	"""Create or update a meeting. ``data.attendees`` is the complete guest list.

	``notify`` is ``"all"`` (send invitations / updates) or ``"none"``.
	"""
	data = frappe.parse_json(data)
	if data.get("name"):
		doc = _get_meeting(data["name"], "write")
	else:
		_check_reference(data.get("reference_doctype"), data.get("reference_docname"))
		doc = frappe.new_doc("CRM Meeting")
		doc.reference_doctype = data["reference_doctype"]
		doc.reference_docname = data["reference_docname"]
		doc.organizer = frappe.session.user

	for field in EDITABLE:
		if field in data:
			doc.set(field, data[field])

	if "attendees" in data:
		doc.set("attendees", [])
		for guest in data["attendees"] or []:
			doc.append("attendees", {"email": guest.get("email"), "full_name": guest.get("full_name")})

	doc.flags.notify_guests = notify != "none"
	doc.save() if data.get("name") else doc.insert()
	doc.reload()
	return {"meeting": _serialize(doc), "sync": doc.flags.get("sync_result") or {}}


@frappe.whitelist()
def cancel_meeting(name, notify="all"):
	doc = _get_meeting(name, "write")
	doc.status = "Cancelled"
	doc.flags.notify_guests = notify != "none"
	doc.save()
	doc.reload()
	return _serialize(doc)


@frappe.whitelist()
def complete_meeting(name):
	doc = _get_meeting(name, "write")
	if doc.status == "Cancelled":
		frappe.throw(_("A cancelled meeting cannot be completed."))
	doc.status = "Completed"
	doc.save()
	return _serialize(doc)


@frappe.whitelist()
def record_meeting_outcome(name, outcome, notes="", next_follow_up_on=None):
	"""What came of a meeting. "Held" and "No Show" close it; "Rescheduled" leaves it open so
	its time can be changed. An optional next follow-up is logged on the Lead."""
	if outcome not in ("Held", "No Show", "Rescheduled"):
		frappe.throw(_("Choose what happened at the meeting."))
	doc = _get_meeting(name, "write")
	if doc.status == "Cancelled":
		frappe.throw(_("A cancelled meeting cannot have an outcome."))
	doc.meeting_outcome = outcome
	doc.outcome_notes = (notes or "").strip()
	if outcome in ("Held", "No Show"):
		doc.status = "Completed"
	doc.flags.notify_guests = False
	doc.save()

	label = {"Held": _("Meeting held"), "No Show": _("Meeting: guest did not show up"), "Rescheduled": _("Meeting to be rescheduled")}[outcome]
	lines = [f"\U0001f4dd <b>{escape_html(label)}:</b> {escape_html(doc.subject)}"]
	if doc.outcome_notes:
		lines.append(escape_html(doc.outcome_notes))
	frappe.get_doc(
		{
			"doctype": "Comment",
			"comment_type": "Comment",
			"reference_doctype": doc.reference_doctype,
			"reference_name": doc.reference_docname,
			"content": "<br>".join(lines),
		}
	).insert(ignore_permissions=True)

	if next_follow_up_on and cint(get_settings().enable_follow_ups):
		from crm_addons import followups

		followups.save_follow_up(
			frappe.as_json(
				{
					"reference_doctype": doc.reference_doctype,
					"reference_docname": doc.reference_docname,
					"mode": "Other",
					"remark": _("After the meeting: {0}").format(doc.subject) + (f" - {doc.outcome_notes}" if doc.outcome_notes else ""),
					"next_follow_up_on": next_follow_up_on,
				}
			)
		)
	doc.reload()
	return _serialize(doc)


@frappe.whitelist()
def delete_meeting(name):
	_get_meeting(name, "delete")
	frappe.delete_doc("CRM Meeting", name)
	return {"deleted": name}


@frappe.whitelist()
def notify_guests(name, message="", email=1, in_app=1):
	"""Tell the guests something about a meeting, whenever you want."""
	doc = _get_meeting(name, "write")
	if doc.status == "Cancelled":
		frappe.throw(_("This meeting was cancelled."))
	result = notifications.notify_guests(doc, message=message, email=cint(email), in_app=cint(in_app))
	return result


@frappe.whitelist()
def refresh_meeting(name):
	"""Pull guest responses and the meeting link from the provider."""
	doc = _get_meeting(name)
	doc.refresh_from_provider()
	doc.reload()
	return _serialize(doc)


# -- pickers ------------------------------------------------------------------------------------


@frappe.whitelist()
def get_reference(reference_doctype, reference_docname):
	"""Title and CRM link of the Lead a meeting is being scheduled for."""
	_check_reference(reference_doctype, reference_docname)
	info = get_reference_info(reference_doctype, reference_docname)
	return {"title": info["title"], "url": info["url"]}


@frappe.whitelist()
def get_default_guests(reference_doctype, reference_docname):
	"""Who is pre-selected on a new meeting: the contact, you, and the record owner."""
	_check_reference(reference_doctype, reference_docname)
	doc = frappe.new_doc("CRM Meeting")
	doc.reference_doctype = reference_doctype
	doc.reference_docname = reference_docname
	doc.organizer = frappe.session.user
	doc.add_default_guests()
	seen, guests = set(), []
	for row in doc.attendees:
		if row.email.lower() not in seen:
			seen.add(row.email.lower())
			guests.append(
				{"email": row.email, "full_name": row.full_name, "user": row.get("user"), "attendee_type": row.attendee_type}
			)
	return guests


@frappe.whitelist()
def search_guests(txt="", reference_doctype=None, reference_docname=None):
	"""Suggestions for the guest box: CRM team members, contacts and leads."""
	txt = (txt or "").strip()
	like = f"%{txt}%"
	out, seen = [], set()

	def add(email, name, kind):
		if email and email.lower() not in seen:
			seen.add(email.lower())
			out.append({"email": email, "full_name": name, "attendee_type": kind})

	filters = {"enabled": 1, "user_type": "System User", "name": ["not in", ["Administrator", "Guest"]]}
	kwargs = {"or_filters": {"full_name": ["like", like], "email": ["like", like]}} if txt else {}
	for u in frappe.get_all("User", filters=filters, fields=["email", "full_name"], limit_page_length=8, **kwargs):
		add(u.email, u.full_name, "Team")

	if txt and frappe.has_permission("Contact", "read"):
		for row in frappe.db.sql(
			"""select ce.email_id as email, concat_ws(' ', c.first_name, c.last_name) as full_name
			from `tabContact` c join `tabContact Email` ce on ce.parent = c.name
			where ce.email_id like %(like)s or c.first_name like %(like)s or c.last_name like %(like)s
			limit 8""",
			{"like": like},
			as_dict=True,
		):
			add(row.email, row.full_name, "Contact")

	if txt:
		for lead in frappe.get_list(
			"CRM Lead",
			or_filters={"lead_name": ["like", like], "email": ["like", like]},
			fields=["lead_name", "email"],
			limit_page_length=5,
		):
			add(lead.email, lead.lead_name, "Contact")
	return out[:15]


@frappe.whitelist()
def search_records(doctype, txt=""):
	"""Leads to attach a meeting to."""
	if doctype not in REFERENCE_DOCTYPES:
		frappe.throw(_("Choose a Lead."))
	title = REFERENCE_META[doctype]["title"]
	like = f"%{(txt or '').strip()}%"
	rows = frappe.get_list(
		doctype,
		or_filters={"name": ["like", like], title: ["like", like], "email": ["like", like]} if txt else None,
		fields=["name", title, "email"],
		order_by="modified desc",
		limit_page_length=10,
	)
	return [{"name": r["name"], "title": r.get(title) or r["name"], "email": r.get("email")} for r in rows]


# -- admin ---------------------------------------------------------------------------------------


@frappe.whitelist()
def get_setup_status():
	"""Checklist for the admin: what is connected and what still needs doing."""
	frappe.only_for(("System Manager", "Sales Manager"))
	from frappe.utils.scheduler import is_scheduler_disabled

	from crm_addons.providers.google_meet import GoogleMeetProvider

	google = GoogleMeetProvider().status()
	outgoing = bool(frappe.db.exists("Email Account", {"enable_outgoing": 1}))
	scheduler_on = not is_scheduler_disabled()
	return {
		"checks": [
			{"key": "google", "label": _("Google Meet & Calendar"), "ok": google["ready"], "message": google["message"]},
			{
				"key": "email",
				"label": _("Outgoing email"),
				"ok": outgoing,
				"message": _("Ready to send reminders and invitations.")
				if outgoing
				else _("Set up an outgoing Email Account, or reminders and invitation emails cannot be sent."),
			},
			{
				"key": "scheduler",
				"label": _("Scheduler"),
				"ok": scheduler_on,
				"message": _("Reminders run every 5 minutes.")
				if scheduler_on
				else _("The scheduler is off, so reminders will not be sent."),
			},
		],
		"providers": provider_catalog(),
		"redirect_uri": get_url()
		+ "?cmd=frappe.integrations.doctype.google_calendar.google_calendar.google_callback",
		"site_url": get_url(),
	}


@frappe.whitelist()
def test_google_connection():
	frappe.only_for(("System Manager", "Sales Manager"))
	from frappe.integrations.doctype.google_calendar.google_calendar import get_google_calendar_object

	from crm_addons.providers.google_meet import explain_error

	name = get_settings().google_calendar
	if not name:
		return {"ok": False, "message": _("Choose the company Google Calendar first.")}
	try:
		service, account = get_google_calendar_object(name)
		info = service.calendars().get(calendarId=account.google_calendar_id).execute()
		return {"ok": True, "message": _("Connected to the calendar \"{0}\".").format(info.get("summary"))}
	except ProviderError as e:
		return {"ok": False, "message": str(e)}
	except Exception as e:
		try:
			return {"ok": False, "message": explain_error(e)}
		except Exception:
			return {"ok": False, "message": str(e)}
