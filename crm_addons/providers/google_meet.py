"""Google Calendar + Google Meet, using the Google Settings / Google Calendar
records that Frappe already provides (OAuth client, refresh token, calendar id).

Frappe's own Event sync always emails every guest and cannot add guests or
cancel cleanly, so meetings talk to the Google Calendar API directly.
"""

import json
import time
import uuid

import frappe
from frappe import _
from frappe.utils import get_datetime

from crm_addons.providers.base import MeetingProvider, ProviderError, ProviderNotConfigured
from crm_addons.utils import get_reference_info, get_settings, system_timezone

RSVP = {
	"needsAction": "Needs action",
	"accepted": "Accepted",
	"declined": "Declined",
	"tentative": "Tentative",
}


def _usable(calendar_name):
	"""True when this Google Calendar record is connected and allowed to push events."""
	if not calendar_name or not frappe.db.exists("Google Calendar", calendar_name):
		return False
	doc = frappe.get_doc("Google Calendar", calendar_name)
	return bool(
		doc.enable
		and doc.push_to_google_calendar
		and doc.google_calendar_id
		and doc.get_password("refresh_token", raise_exception=False)
	)


def _personal_calendar(user):
	if not user:
		return None
	for name in frappe.get_all("Google Calendar", filters={"user": user, "enable": 1}, pluck="name"):
		if _usable(name):
			return name
	return None


def pick_calendar(organizer):
	"""The Google Calendar record a meeting is created on."""
	settings = get_settings()
	if settings.use_personal_calendars:
		name = _personal_calendar(organizer)
		if name:
			return name
	if _usable(settings.google_calendar):
		return settings.google_calendar
	name = _personal_calendar(organizer)  # last resort: the organizer's own calendar
	if name:
		return name
	raise ProviderNotConfigured(
		_("No Google Calendar is connected. Ask an admin to connect one in CRM Addons Settings.")
	)


def explain_error(err):
	"""Turn a Google API error into a message a salesperson can act on."""
	status = getattr(getattr(err, "resp", None), "status", None)
	reason = ""
	try:
		reason = json.loads(err.content.decode())["error"]["message"]
	except Exception:
		reason = str(err)

	if status == 401:
		return _("Google rejected the saved login. An admin needs to authorize the Google Calendar again.")
	if status == 403 and ("not been used" in reason or "disabled" in reason or "accessNotConfigured" in reason):
		return _("The Google Calendar API is not enabled for the Google Cloud project. Enable it, then try again.")
	if status == 403:
		return _("Google refused the request: {0}").format(reason)
	if status in (404, 410):
		return _("The Google calendar or event no longer exists.")
	return _("Google Calendar error {0}: {1}").format(status or "", reason)


class GoogleMeetProvider(MeetingProvider):
	key = "Google Meet"
	label = "Google Meet"
	description = "Creates the meeting in Google Calendar with a Google Meet link and emails the guests."

	# -- status ------------------------------------------------------------
	def status(self):
		settings = get_settings()
		google_settings = frappe.get_cached_doc("Google Settings")
		if not google_settings.enable:
			return {"ready": False, "message": _("Google Settings is not enabled.")}
		if not (google_settings.client_id and google_settings.get_password("client_secret", raise_exception=False)):
			return {"ready": False, "message": _("Add the OAuth Client ID and Secret in Google Settings.")}
		if _usable(settings.google_calendar):
			return {"ready": True, "message": _("Connected: {0}").format(settings.google_calendar)}
		return {
			"ready": False,
			"message": _("Choose a connected Google Calendar as the company calendar in CRM Addons Settings."),
		}

	# -- calls --------------------------------------------------------------
	def _service(self, calendar_name):
		from frappe.integrations.doctype.google_calendar.google_calendar import get_google_calendar_object

		try:
			service, account = get_google_calendar_object(calendar_name)
		except ProviderError:
			raise
		except Exception as e:
			raise ProviderError(_("Could not connect to Google: {0}").format(e)) from e
		return service, account.google_calendar_id

	def _body(self, meeting, with_conference):
		tz = system_timezone()
		info = get_reference_info(meeting.reference_doctype, meeting.reference_docname)
		lines = [meeting.description or ""]
		if info["url"]:
			lines.append(_("CRM record: {0}").format(info["url"]))
		body = {
			"summary": meeting.subject,
			"description": "\n\n".join(x for x in lines if x),
			"start": {"dateTime": get_datetime(meeting.starts_on).isoformat(), "timeZone": tz},
			"end": {"dateTime": get_datetime(meeting.ends_on).isoformat(), "timeZone": tz},
			"attendees": [
				{"email": a.email, **({"displayName": a.full_name} if a.full_name else {})}
				for a in meeting.attendees or []
				if a.email
			],
			"extendedProperties": {"private": {"crm_meeting": str(meeting.name), "crm_site": frappe.local.site}},
		}
		if with_conference:
			body["conferenceData"] = {
				"createRequest": {
					"requestId": uuid.uuid4().hex,
					"conferenceSolutionKey": {"type": "hangoutsMeet"},
				}
			}
		return body

	def _wait_for_link(self, service, calendar_id, event):
		"""Google fills in the Meet link a moment after the event is created."""
		for _attempt in range(4):
			if event.get("hangoutLink"):
				break
			state = (event.get("conferenceData", {}).get("createRequest", {}).get("status", {}) or {}).get("statusCode")
			if state not in (None, "pending"):
				break
			time.sleep(1)
			event = service.events().get(calendarId=calendar_id, eventId=event["id"]).execute()
		return event

	def _result(self, event, calendar_name):
		return {
			"link": event.get("hangoutLink") or "",
			"external_event_id": event.get("id"),
			"external_event_url": event.get("htmlLink"),
			"calendar": calendar_name,
			"sync_status": "Synced",
		}

	def create(self, meeting, notify):
		from googleapiclient.errors import HttpError

		calendar_name = pick_calendar(meeting.organizer or meeting.owner)
		service, calendar_id = self._service(calendar_name)
		want_meet = bool(meeting.add_video_conferencing)
		try:
			event = (
				service.events()
				.insert(
					calendarId=calendar_id,
					body=self._body(meeting, want_meet),
					conferenceDataVersion=1 if want_meet else 0,
					sendUpdates="all" if notify else "none",
				)
				.execute()
			)
			if want_meet:
				event = self._wait_for_link(service, calendar_id, event)
		except HttpError as err:
			raise ProviderError(explain_error(err)) from err
		return self._result(event, calendar_name)

	def update(self, meeting, notify):
		from googleapiclient.errors import HttpError

		if not meeting.external_event_id:
			return self.create(meeting, notify)

		calendar_name = meeting.google_calendar or pick_calendar(meeting.organizer or meeting.owner)
		service, calendar_id = self._service(calendar_name)
		want_meet = bool(meeting.add_video_conferencing)
		body = self._body(meeting, with_conference=False)
		try:
			current = service.events().get(calendarId=calendar_id, eventId=meeting.external_event_id).execute()
			has_meet = bool(current.get("hangoutLink"))
			if want_meet and not has_meet:
				body["conferenceData"] = {
					"createRequest": {"requestId": uuid.uuid4().hex, "conferenceSolutionKey": {"type": "hangoutsMeet"}}
				}
			elif not want_meet and has_meet:
				body["conferenceData"] = None
			event = (
				service.events()
				.patch(
					calendarId=calendar_id,
					eventId=meeting.external_event_id,
					body=body,
					conferenceDataVersion=1,
					sendUpdates="all" if notify else "none",
				)
				.execute()
			)
			if want_meet:
				event = self._wait_for_link(service, calendar_id, event)
		except HttpError as err:
			raise ProviderError(explain_error(err)) from err
		return self._result(event, calendar_name)

	def cancel(self, meeting, notify):
		from googleapiclient.errors import HttpError

		if not meeting.external_event_id:
			return None
		calendar_name = meeting.google_calendar or pick_calendar(meeting.organizer or meeting.owner)
		service, calendar_id = self._service(calendar_name)
		try:
			service.events().delete(
				calendarId=calendar_id,
				eventId=meeting.external_event_id,
				sendUpdates="all" if notify else "none",
			).execute()
		except HttpError as err:
			if getattr(err.resp, "status", None) not in (404, 410):  # already gone is fine
				raise ProviderError(explain_error(err)) from err
		return None

	def refresh(self, meeting):
		"""Latest guest responses and Meet link from Google."""
		from googleapiclient.errors import HttpError

		if not meeting.external_event_id:
			return None
		calendar_name = meeting.google_calendar or pick_calendar(meeting.organizer or meeting.owner)
		service, calendar_id = self._service(calendar_name)
		try:
			event = service.events().get(calendarId=calendar_id, eventId=meeting.external_event_id).execute()
		except HttpError as err:
			raise ProviderError(explain_error(err)) from err

		return {
			"link": event.get("hangoutLink") or "",
			"rsvp": {
				a["email"].lower(): RSVP.get(a.get("responseStatus"), "Needs action")
				for a in event.get("attendees", [])
				if a.get("email")
			},
		}
