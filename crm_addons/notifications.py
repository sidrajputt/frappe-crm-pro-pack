"""In-app notifications, emails and reminders for meetings."""

import json

import frappe
from frappe import _
from frappe.utils import cint, escape_html, get_datetime, now_datetime

from crm_addons.utils import build_ics, format_when, get_reference_info, get_settings, user_details

# English source strings; translated where they are used.
ACTIONS = {
	"scheduled": "scheduled a meeting",
	"rescheduled": "changed the meeting",
	"cancelled": "cancelled the meeting",
	"added": "added you to a meeting",
	"message": "sent a note about the meeting",
}


# -- recipients ---------------------------------------------------------------


def internal_recipients(meeting, exclude=None):
	"""CRM users who should hear about this meeting: guests who are team members,
	the organizer and the owner of the Lead."""
	users = {row.user for row in meeting.attendees or [] if row.user}
	users.add(meeting.organizer or meeting.owner)
	users.add(get_reference_info(meeting.reference_doctype, meeting.reference_docname)["owner"])
	users.discard(None)
	users.discard(exclude)
	return {u for u in users if frappe.db.get_value("User", u, "enabled")}


def external_emails(meeting):
	return [row.email for row in meeting.attendees or [] if row.email and not row.user]


# -- in-app --------------------------------------------------------------------


def _notification_type(kind):
	"""CRM 2.x has an "Automation" type; CRM 1.x (Frappe v15) only Mention / Task /
	Assignment / WhatsApp, and rejects anything else."""
	if kind not in ("scheduled", "added"):
		options = (frappe.get_meta("CRM Notification").get_field("type").options or "").split("\n")
		if "Automation" in options:
			return "Automation"
	return "Assignment"


def create_notification(meeting, to_user, text, from_user=None, kind="scheduled"):
	if not frappe.db.exists("DocType", "CRM Notification") or not frappe.db.exists("User", to_user):
		return
	try:
		frappe.get_doc(
			{
				"doctype": "CRM Notification",
				"type": _notification_type(kind),
				"from_user": from_user or meeting.organizer or meeting.owner,
				"to_user": to_user,
				"reference_doctype": meeting.reference_doctype,
				"reference_name": meeting.reference_docname,
				"notification_type_doctype": "CRM Meeting",
				"notification_type_doc": str(meeting.name),
				"notification_text": text,
			}
		).insert(ignore_permissions=True)
	except Exception:
		frappe.log_error(title="CRM Add-ons: could not create a notification", message=frappe.get_traceback())


def create_record_notification(reference_doctype, reference_name, to_user, text, kind="reminder", from_user=None):
	"""An in-app CRM notification about a Lead itself (not about one meeting)."""
	if not frappe.db.exists("DocType", "CRM Notification") or not to_user or not frappe.db.exists("User", to_user):
		return
	try:
		frappe.get_doc(
			{
				"doctype": "CRM Notification",
				"type": _notification_type(kind),
				"from_user": from_user or to_user,
				"to_user": to_user,
				"reference_doctype": reference_doctype,
				"reference_name": reference_name,
				"notification_type_doctype": reference_doctype,
				"notification_type_doc": reference_name,
				"notification_text": text,
			}
		).insert(ignore_permissions=True)
	except Exception:
		frappe.log_error(title="CRM Add-ons: could not create a notification", message=frappe.get_traceback())


def notify_internal(meeting, kind, actor=None, recipients=None, note=None):
	"""In-app CRM notification to the team members involved in a meeting."""
	if kind != "reminder" and kind != "message" and not cint(get_settings().notify_on_schedule):
		return
	actor = actor or frappe.session.user
	_email, actor_name = user_details(actor)
	when = format_when(meeting.starts_on, meeting.ends_on)
	subject = escape_html(meeting.subject)

	if recipients is None:
		recipients = internal_recipients(meeting, exclude=actor if kind != "reminder" else None)

	for user in recipients:
		if kind == "reminder":
			text = f"<div><b>{escape_html(_('Meeting starting soon'))}:</b> {subject}<br>{escape_html(when)}</div>"
		else:
			text = (
				f"<div><b>{escape_html(actor_name or actor)}</b> {escape_html(_(ACTIONS[kind]))} "
				f"<b>{subject}</b><br>{escape_html(when)}"
				+ (f"<br><i>{escape_html(note)}</i>" if note else "")
				+ "</div>"
			)
		create_notification(meeting, user, text, from_user=actor, kind=kind)


# -- email ---------------------------------------------------------------------


def _email_html(meeting, heading, note=None):
	info = get_reference_info(meeting.reference_doctype, meeting.reference_docname)
	rows = [
		f"<p style='font-size:16px;font-weight:600;margin:0 0 4px'>{escape_html(meeting.subject)}</p>",
		f"<p style='margin:0 0 12px;color:#555'>{escape_html(format_when(meeting.starts_on, meeting.ends_on))}</p>",
	]
	if note:
		rows.append(f"<p style='margin:0 0 12px;padding:10px 12px;background:#f5f5f5;border-radius:6px'>{escape_html(note)}</p>")
	if meeting.description:
		rows.append(f"<p style='margin:0 0 12px'>{escape_html(meeting.description)}</p>")
	if meeting.google_meet_link and meeting.status != "Cancelled":
		link = escape_html(meeting.google_meet_link)
		rows.append(
			f"<p style='margin:16px 0'><a href='{link}' style='background:#1a73e8;color:#fff;padding:9px 16px;"
			f"border-radius:6px;text-decoration:none;font-weight:600'>{escape_html(_('Join meeting'))}</a></p>"
			f"<p style='margin:0 0 12px;color:#777;font-size:12px'>{link}</p>"
		)
	if info["url"]:
		rows.append(
			f"<p style='margin:12px 0 0;color:#555'>{escape_html(_('Related'))}: "
			f"<a href='{escape_html(info['url'])}'>{escape_html(info['title'])}</a></p>"
		)
	return (
		"<div style='font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:14px;color:#222;max-width:520px'>"
		f"<p style='color:#777;margin:0 0 12px'>{escape_html(heading)}</p>" + "".join(rows) + "</div>"
	)


def send_email(meeting, recipients, subject, heading, note=None, ics_method=None):
	recipients = sorted({r.strip() for r in recipients if r})
	if not recipients:
		return False
	attachments = None
	if ics_method:
		attachments = [{"fname": "meeting.ics", "fcontent": build_ics(meeting, ics_method)}]
	try:
		frappe.sendmail(
			recipients=recipients,
			subject=subject,
			message=_email_html(meeting, heading, note),
			reference_doctype="CRM Meeting",
			reference_name=str(meeting.name),
			attachments=attachments,
		)
		return True
	except Exception:
		frappe.log_error(title="CRM Add-ons: could not send an email", message=frappe.get_traceback())
		return False


def send_invitation_email(meeting, kind, actor=None):
	"""Our own invitation email (with a calendar file), used when the calendar
	provider did not send one - Manual link, no calendar connected, or an error."""
	actor = actor or frappe.session.user
	_email, actor_name = user_details(actor)
	cancelled = kind == "cancelled"
	subject = (
		_("Cancelled: {0}").format(meeting.subject)
		if cancelled
		else _("Invitation: {0}").format(meeting.subject)
		if kind == "scheduled"
		else _("Updated: {0}").format(meeting.subject)
	)
	action = "cancelled" if cancelled else kind if kind in ACTIONS else "scheduled"
	heading = "{0} {1}".format(actor_name or actor, _(ACTIONS[action]))
	recipients = [row.email for row in meeting.attendees or []]
	return send_email(meeting, recipients, subject, heading, ics_method="CANCEL" if cancelled else "REQUEST")


def notify_guests(meeting, message="", email=True, in_app=True, actor=None):
	"""On demand: tell everybody on the guest list something about this meeting."""
	actor = actor or frappe.session.user
	_email, actor_name = user_details(actor)
	if in_app:
		notify_internal(meeting, "message", actor=actor, note=message)
	sent = 0
	if email:
		recipients = [row.email for row in meeting.attendees or [] if row.email]
		sent = len(recipients) if send_email(
			meeting,
			recipients,
			_("Meeting: {0}").format(meeting.subject),
			_("{0} sent you a note about this meeting").format(actor_name or actor),
			note=message,
		) else 0
	return {"emailed": sent}


# -- reminders (scheduler) -------------------------------------------------------


def _offsets(settings):
	return sorted(
		{cint(m) for m in (settings.reminder_minutes_before, settings.early_reminder_minutes) if cint(m) > 0}
	)


def send_due_reminders():
	"""Every 5 minutes: remind people about meetings that are about to start."""
	settings = get_settings()
	if not cint(settings.reminders_enabled):
		return
	offsets = _offsets(settings)
	if not offsets:
		return

	now = now_datetime()
	horizon = frappe.utils.add_to_date(now, minutes=max(offsets))
	names = frappe.get_all(
		"CRM Meeting",
		filters={"status": "Scheduled", "starts_on": ["between", [now, horizon]]},
		pluck="name",
	)
	for name in names:
		try:
			_remind(frappe.get_doc("CRM Meeting", name), offsets, now, settings)
			frappe.db.commit()
		except Exception:
			frappe.db.rollback()
			frappe.log_error(title=f"CRM Add-ons: reminder failed for {name}", message=frappe.get_traceback())


def _remind(meeting, offsets, now, settings):
	minutes_left = (get_datetime(meeting.starts_on) - now).total_seconds() / 60
	sent = set(json.loads(meeting.reminders_sent or "[]"))
	due = [o for o in offsets if minutes_left <= o and o not in sent]
	if not due:
		return
	# If several reminders became due at once (a meeting booked at short notice), send one.
	sent.update(due)
	meeting.db_set("reminders_sent", json.dumps(sorted(sent)), update_modified=False)

	people = internal_recipients(meeting)
	notify_internal(meeting, "reminder", actor=meeting.organizer or meeting.owner, recipients=people)

	left = max(int(round(minutes_left)), 1)
	heading = _("Starts in {0}").format(_("{0} minutes").format(left) if left < 90 else _("{0} hours").format(round(left / 60)))
	subject = _("Reminder: {0}").format(meeting.subject)

	if cint(settings.email_reminders):
		emails = [user_details(u)[0] for u in people]
		send_email(meeting, emails, subject, heading)
	if cint(settings.remind_guests):
		send_email(meeting, external_emails(meeting), subject, heading)
