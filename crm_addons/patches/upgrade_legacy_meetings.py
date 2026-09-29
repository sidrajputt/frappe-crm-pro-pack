"""Meetings created by the first version of the app kept their Google event in a
Frappe Event. Point them at the same Google event, and give them a guest list."""

import frappe


def execute():
	frappe.reload_doc("meetings", "doctype", "crm_meeting_attendee")
	frappe.reload_doc("meetings", "doctype", "crm_meeting")

	for name in frappe.get_all("CRM Meeting", pluck="name"):
		meeting = frappe.get_doc("CRM Meeting", name)
		values = {}
		if not meeting.organizer:
			values["organizer"] = meeting.owner
		if not meeting.provider:
			values["provider"] = "Google Meet"

		if meeting.event and frappe.db.exists("Event", meeting.event) and not meeting.external_event_id:
			event = frappe.db.get_value(
				"Event", meeting.event, ["google_calendar_event_id", "google_calendar"], as_dict=True
			)
			if event.google_calendar_event_id:
				values.update(
					external_event_id=event.google_calendar_event_id,
					google_calendar=event.google_calendar,
					sync_status="Synced",
				)
		if values:
			frappe.db.set_value("CRM Meeting", name, values, update_modified=False)

		if not meeting.attendees:
			meeting.organizer = values.get("organizer") or meeting.organizer
			meeting.add_default_guests()
			for row in meeting.attendees:
				row.parent, row.parenttype, row.parentfield = name, "CRM Meeting", "attendees"
				row.db_insert()
