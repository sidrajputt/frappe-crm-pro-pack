"""Small helpers shared by the controller, API, providers and notifications."""

from datetime import timezone
from zoneinfo import ZoneInfo

import frappe
from frappe.utils import escape_html, get_datetime, get_url

from crm_addons import debuglog

MANAGER_ROLES = ("System Manager", "Sales Manager")
REFERENCE_DOCTYPES = ("CRM Lead",)

# Where each supported record lives in the CRM UI, and which fields describe it.
REFERENCE_META = {
	"CRM Lead": {"route": "leads", "title": "lead_name", "email": "email", "owner": "lead_owner"},
}


def get_settings():
	return frappe.get_cached_doc("CRM Addons Settings")


def is_manager(user=None):
	"""Administrators, System Managers and Sales Managers can see every meeting."""
	user = user or frappe.session.user
	return user == "Administrator" or bool(set(MANAGER_ROLES) & set(frappe.get_roles(user)))


def crm_url(reference_doctype, reference_docname):
	meta = REFERENCE_META.get(reference_doctype)
	if not meta or not reference_docname:
		return None
	return get_url(f"/crm/{meta['route']}/{reference_docname}")


def get_reference_info(reference_doctype, reference_docname):
	"""Title, contact email, owner and CRM link of the Lead a meeting belongs to."""
	meta = REFERENCE_META.get(reference_doctype)
	info = {"title": reference_docname, "email": None, "owner": None, "url": crm_url(reference_doctype, reference_docname)}
	if not meta or not reference_docname:
		return info

	values = frappe.db.get_value(
		reference_doctype,
		reference_docname,
		[meta["title"], meta["email"], meta["owner"]],
		as_dict=True,
	)
	if values:
		info["title"] = values.get(meta["title"]) or reference_docname
		info["email"] = values.get(meta["email"]) or None
		info["owner"] = values.get(meta["owner"]) or None

	return info


def user_details(user):
	"""(email, full name) of a User, or (None, None)."""
	if not user:
		return None, None
	row = frappe.db.get_value("User", user, ["email", "full_name"], as_dict=True)
	return (row.email, row.full_name) if row else (None, None)


def system_timezone():
	getter = getattr(frappe.utils, "get_system_timezone", None) or frappe.utils.get_time_zone
	return getter()


def to_utc(dt):
	"""A naive datetime in the system time zone -> aware UTC datetime."""
	return get_datetime(dt).replace(tzinfo=ZoneInfo(system_timezone())).astimezone(timezone.utc)


def format_when(start, end):
	start, end = get_datetime(start), get_datetime(end)
	same_day = start.date() == end.date()
	first = start.strftime("%a, %d %b %Y, %I:%M %p")
	second = end.strftime("%I:%M %p") if same_day else end.strftime("%a, %d %b %Y, %I:%M %p")
	return f"{first} - {second}"


def _ics_escape(text):
	BS = chr(92)
	text = (text or "").replace(BS, BS * 2).replace(";", BS + ";").replace(",", BS + ",")
	return text.replace("\r\n", BS + "n").replace("\n", BS + "n")


def build_ics(meeting, method="REQUEST"):
	"""An .ics invitation, so a guest can add the meeting to any calendar app."""
	from frappe.utils import now_datetime

	stamp = to_utc(now_datetime()).strftime("%Y%m%dT%H%M%SZ")
	start, end = to_utc(meeting.starts_on), to_utc(meeting.ends_on)
	organizer_email, organizer_name = user_details(meeting.organizer or meeting.owner)
	cancelled = method == "CANCEL" or meeting.status == "Cancelled"

	lines = [
		"BEGIN:VCALENDAR",
		"PRODID:-//CRM Add-ons//Frappe CRM//EN",
		"VERSION:2.0",
		"CALSCALE:GREGORIAN",
		f"METHOD:{'CANCEL' if cancelled else 'REQUEST'}",
		"BEGIN:VEVENT",
		f"UID:crm-meeting-{meeting.name}@{frappe.local.site}",
		f"DTSTAMP:{stamp}",
		f"DTSTART:{start.strftime('%Y%m%dT%H%M%SZ')}",
		f"DTEND:{end.strftime('%Y%m%dT%H%M%SZ')}",
		f"SUMMARY:{_ics_escape(meeting.subject)}",
		f"DESCRIPTION:{_ics_escape(meeting.description or '')}",
		f"STATUS:{'CANCELLED' if cancelled else 'CONFIRMED'}",
		# calendar apps only accept an update whose sequence number went up
		f"SEQUENCE:{int(get_datetime(meeting.modified or meeting.creation).timestamp())}",
	]
	if meeting.google_meet_link:
		lines.append(f"LOCATION:{_ics_escape(meeting.google_meet_link)}")
		lines.append(f"URL:{_ics_escape(meeting.google_meet_link)}")
	if organizer_email:
		lines.append(f"ORGANIZER;CN={_ics_escape(organizer_name or organizer_email)}:mailto:{organizer_email}")
	for row in meeting.attendees or []:
		if row.email:
			lines.append(
				f"ATTENDEE;CN={_ics_escape(row.full_name or row.email)};RSVP=TRUE:mailto:{row.email}"
			)
	lines += ["END:VEVENT", "END:VCALENDAR"]
	return ("\r\n".join(lines) + "\r\n").encode()


def link_html(url, label=None):
	return f'<a href="{escape_html(url)}">{escape_html(label or url)}</a>'


def refresh_next_meeting(reference_doctype, reference_docname):
	"""Keep the read-only "Next Meeting" column on the Lead list up to date."""
	if reference_doctype not in REFERENCE_META or not reference_docname:
		return
	if not frappe.get_meta(reference_doctype).has_field("next_meeting_on"):
		return
	if not frappe.db.exists(reference_doctype, reference_docname):
		return

	nxt = frappe.db.sql(
		"""select min(starts_on) from `tabCRM Meeting`
		where reference_doctype = %s and reference_docname = %s
		and status = 'Scheduled' and ends_on >= %s""",
		(reference_doctype, reference_docname, frappe.utils.now_datetime()),
	)[0][0]
	frappe.db.set_value(reference_doctype, reference_docname, "next_meeting_on", nxt, update_modified=False)

	from crm_addons import scoring

	scoring.refresh_score(reference_doctype, reference_docname)


@debuglog.traced("utils.refresh_stale_next_meetings")
def refresh_stale_next_meetings():
	"""Hourly: a meeting that has passed must stop showing as the "next" one."""
	now = frappe.utils.now_datetime()
	for doctype in REFERENCE_META:
		if not frappe.get_meta(doctype).has_field("next_meeting_on"):
			continue
		for name in frappe.get_all(doctype, filters={"next_meeting_on": ["<", now]}, pluck="name"):
			refresh_next_meeting(doctype, name)
