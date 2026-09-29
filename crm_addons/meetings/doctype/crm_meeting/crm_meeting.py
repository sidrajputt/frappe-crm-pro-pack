# Copyright (c) 2026, Coding Pro
# For internal use in the Coding Pro CRM.

import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import escape_html, get_datetime, validate_email_address

from crm_addons import notifications
from crm_addons.providers import get_provider
from crm_addons.providers.base import ProviderError, ProviderNotConfigured
from crm_addons.utils import (
	REFERENCE_DOCTYPES,
	format_when,
	get_reference_info,
	get_settings,
	refresh_next_meeting,
	user_details,
)


class CRMMeeting(Document):
	# -- validation ---------------------------------------------------------
	def validate(self):
		if self.reference_doctype not in REFERENCE_DOCTYPES:
			frappe.throw(_("A meeting can only be linked to a Lead."))
		if get_datetime(self.ends_on) <= get_datetime(self.starts_on):
			frappe.throw(_("The meeting must end after it starts."))

		if self.is_new():
			self.status = self.status or "Scheduled"
			self.organizer = self.organizer or frappe.session.user
			self.provider = self.provider or get_settings().default_provider or "Google Meet"
			if not self.attendees:
				self.add_default_guests()
		else:
			before = self.get_doc_before_save()
			if before and before.status == "Cancelled":
				frappe.throw(_("A cancelled meeting cannot be changed. Schedule a new one instead."))

		self.normalize_attendees()

	def add_default_guests(self):
		"""Contact of the Lead, the organizer and the record owner."""
		info = get_reference_info(self.reference_doctype, self.reference_docname)
		if info["email"]:
			self.append("attendees", {"email": info["email"], "full_name": info["title"], "attendee_type": "Contact"})
		for user in (self.organizer, info["owner"]):
			if user == "Administrator":
				continue  # its address is a placeholder on most sites
			email, full_name = user_details(user)
			if email:
				self.append("attendees", {"email": email, "full_name": full_name, "user": user, "attendee_type": "Team"})

	def normalize_attendees(self):
		"""Lower-case, validate and de-duplicate guests; link the ones that are CRM users."""
		info = get_reference_info(self.reference_doctype, self.reference_docname)
		previous = {(row.email or "").strip().lower(): row.rsvp for row in self.attendees if row.email}
		rows, seen = [], set()
		for row in list(self.attendees):
			email = (row.email or "").strip().lower()
			if not email or email in seen:
				continue
			if not validate_email_address(email):
				frappe.throw(_("{0} is not a valid email address.").format(escape_html(email)))
			seen.add(email)

			user = frappe.db.get_value("User", {"email": email, "enabled": 1}, ["name", "full_name"], as_dict=True)
			rows.append(
				{
					"email": email,
					"full_name": row.full_name or (user.full_name if user else None),
					"user": user.name if user else None,
					"attendee_type": "Team" if user else ("Contact" if email == (info["email"] or "").lower() else "Guest"),
					"rsvp": previous.get(email) or row.rsvp or "Needs action",
				}
			)
		self.set("attendees", [])
		for row in rows:
			self.append("attendees", row)

	# -- lifecycle ------------------------------------------------------------
	def _notify(self):
		"""Whether guests should be told: on unless the caller switched it off."""
		return self.flags.notify_guests is not False

	def after_insert(self):
		notify = self._notify()
		self.sync("create", notify)
		if notify and self.sync_status != "Synced":
			notifications.send_invitation_email(self, "scheduled")
		self.post_timeline_comment("scheduled", notify)
		notifications.notify_internal(self, "scheduled")
		refresh_next_meeting(self.reference_doctype, self.reference_docname)

	def on_update(self):
		if self.flags.in_insert:
			return
		before = self.get_doc_before_save()
		if not before:
			return
		notify = self._notify()

		if before.status != "Cancelled" and self.status == "Cancelled":
			was_synced = before.sync_status == "Synced"
			self.sync("cancel", notify)
			if notify and not was_synced:
				notifications.send_invitation_email(self, "cancelled")
			self.post_timeline_comment("cancelled", notify)
			notifications.notify_internal(self, "cancelled")
		elif self.status == "Scheduled":
			time_changed = (get_datetime(before.starts_on), get_datetime(before.ends_on)) != (
				get_datetime(self.starts_on),
				get_datetime(self.ends_on),
			)
			old_guests = {row.email for row in before.attendees}
			new_guests = [row for row in self.attendees if row.email not in old_guests]
			removed = old_guests - {row.email for row in self.attendees}
			content_changed = any(
				(before.get(f) or "") != (self.get(f) or "")
				for f in ("subject", "description", "add_video_conferencing", "provider", "google_meet_link")
			)
			if time_changed or content_changed or new_guests or removed:
				self.sync("update", notify)
				if notify and self.sync_status != "Synced" and (time_changed or new_guests):
					notifications.send_invitation_email(self, "rescheduled")
			if time_changed:
				self.post_timeline_comment("rescheduled", notify)
				notifications.notify_internal(self, "rescheduled")
			added_users = {row.user for row in new_guests if row.user}
			if added_users:
				notifications.notify_internal(self, "added", recipients=added_users - {frappe.session.user})

		refresh_next_meeting(self.reference_doctype, self.reference_docname)

	def on_trash(self):
		# Deleting is not cancelling: never email guests, but do not leave a ghost event behind.
		if self.external_event_id and self.status != "Cancelled":
			try:
				get_provider(self.provider).cancel(self, False)
			except Exception:
				frappe.log_error(title="CRM Meeting: could not remove the calendar event", message=frappe.get_traceback())
		if self.event and frappe.db.exists("Event", self.event):  # meetings made by an older version
			frappe.delete_doc("Event", self.event, ignore_permissions=True, force=True)

	def after_delete(self):
		refresh_next_meeting(self.reference_doctype, self.reference_docname)

	# -- provider sync --------------------------------------------------------------
	def sync(self, action, notify):
		"""Create / update / cancel the meeting with its provider. Never raises: the
		meeting is always saved, and the outcome is stored for the UI and admins."""
		try:
			provider = get_provider(self.provider)
			if action == "cancel":
				provider.cancel(self, notify)
				result = {"external_event_id": "", "external_event_url": "", "sync_status": "", "sync_error": ""}
			else:
				result = getattr(provider, action)(self, notify)
				result = {**result, "sync_error": ""}
				if "link" in result and not (result["link"] or self.provider == "Google Meet"):
					result.pop("link")
		except ProviderNotConfigured as e:
			result = {"sync_status": "Not synced", "sync_error": str(e)}
		except ProviderError as e:
			frappe.log_error(title="CRM Meeting: sync failed", message=f"{self.name}: {e}")
			result = {"sync_status": "Failed", "sync_error": str(e)}
		except Exception:
			frappe.log_error(title="CRM Meeting: sync failed", message=frappe.get_traceback())
			result = {
				"sync_status": "Failed",
				"sync_error": _("Unexpected error. An admin can see the details in the Error Log."),
			}

		values = {}
		if "link" in result:
			values["google_meet_link"] = result["link"]
		for src, dest in (
			("external_event_id", "external_event_id"),
			("external_event_url", "external_event_url"),
			("calendar", "google_calendar"),
			("sync_status", "sync_status"),
			("sync_error", "sync_error"),
		):
			if src in result:
				values[dest] = result[src]
		if values:
			self.db_set(values, update_modified=False)

		self.flags.sync_result = {"status": self.sync_status, "error": self.sync_error}
		return self.flags.sync_result

	def refresh_from_provider(self):
		"""Pull guest responses (and a late Meet link) from the provider."""
		try:
			data = get_provider(self.provider).refresh(self)
		except ProviderError:
			return False
		if not data:
			return False
		for row in self.attendees:
			response = data.get("rsvp", {}).get(row.email)
			if response and response != row.rsvp:
				frappe.db.set_value("CRM Meeting Attendee", row.name, "rsvp", response, update_modified=False)
				row.rsvp = response
		if data.get("link") and data["link"] != self.google_meet_link:
			self.db_set("google_meet_link", data["link"], update_modified=False)
		return True

	# -- timeline --------------------------------------------------------------------
	def post_timeline_comment(self, kind, notify):
		"""A comment on the Lead so the meeting shows up in its activity."""
		heading = {
			"scheduled": _("Meeting scheduled"),
			"rescheduled": _("Meeting rescheduled"),
			"cancelled": _("Meeting cancelled"),
		}[kind]
		lines = [
			f"\U0001f4c5 <b>{escape_html(heading)}:</b> {escape_html(self.subject)}",
			escape_html(format_when(self.starts_on, self.ends_on)),
		]
		if kind != "cancelled" and self.google_meet_link:
			link = escape_html(self.google_meet_link)
			lines.append(f'{escape_html(_("Meeting link"))}: <a href="{link}">{link}</a>')

		guests = [row.email for row in self.attendees]
		if kind == "cancelled":
			lines.append(escape_html(_("Guests were notified.") if notify and guests else _("Guests were not notified.")))
		elif self.sync_status == "Failed":
			lines.append(escape_html(_("Calendar sync failed: {0}").format(self.sync_error or "")))
		elif self.sync_status == "Not synced" and self.provider == "Google Meet":
			lines.append(escape_html(self.sync_error or _("No Google Calendar is connected.")))
		if kind != "cancelled" and guests:
			lines.append(
				escape_html(
					_("Invited: {0}").format(", ".join(guests))
					if notify
					else _("Guests were not notified ({0} on the list).").format(len(guests))
				)
			)

		frappe.get_doc(
			{
				"doctype": "Comment",
				"comment_type": "Comment",
				"reference_doctype": self.reference_doctype,
				"reference_name": self.reference_docname,
				"content": "<br>".join(lines),
			}
		).insert(ignore_permissions=True)
