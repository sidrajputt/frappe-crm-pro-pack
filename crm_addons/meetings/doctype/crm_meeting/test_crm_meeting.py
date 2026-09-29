# Copyright (c) 2026, Coding Pro
"""Backend tests.

Plain unittest on purpose: Frappe's IntegrationTestCase seeds sample Users,
Events and Email Accounts into the site, which we do not want on a real site.
Each test runs in a transaction that is rolled back.
"""

import unittest
from unittest.mock import patch

import frappe
import httplib2
from frappe.utils import add_to_date, now_datetime
from googleapiclient.errors import HttpError

from crm_addons import api, notifications
from crm_addons.providers.base import ProviderNotConfigured

GOOGLE = "crm_addons.providers.google_meet.GoogleMeetProvider"
MEET = "https://meet.google.com/abc-defg-hij"


class FakeGoogle:
	"""Stands in for the Google Calendar API client."""

	def __init__(self, error=None, meet=True):
		self.error, self.meet, self.calls = error, meet, []
		self._id = "gcal-1"

	def events(self):
		return self

	def _record(self, verb, **kw):
		self.calls.append((verb, kw))
		self._verb = verb
		return self

	def insert(self, **kw):
		return self._record("insert", **kw)

	def patch(self, **kw):
		return self._record("patch", **kw)

	def delete(self, **kw):
		return self._record("delete", **kw)

	def get(self, **kw):
		return self._record("get", **kw)

	def execute(self):
		if self.error and self._verb != "get":
			raise self.error
		event = {"id": self._id, "htmlLink": "https://calendar.google.com/e/1", "attendees": []}
		if self.meet:
			event["hangoutLink"] = MEET
		return event

	def verbs(self, verb):
		return [kw for v, kw in self.calls if v == verb]


def google_patch(service):
	"""Make the Google provider use ``service`` and a fake connected calendar."""
	return (
		patch(f"{GOOGLE}._service", return_value=(service, "primary-cal")),
		patch("crm_addons.providers.google_meet.pick_calendar", return_value="CRM Add-ons"),
	)


class TestCase(unittest.TestCase):
	def setUp(self):
		frappe.set_user("Administrator")
		frappe.flags.in_test = True
		# log_error commits, which would leak this test's data past the rollback
		patcher = patch("frappe.log_error")
		self.log_error = patcher.start()
		self.addCleanup(patcher.stop)
		self.owner = self.make_user("owner.test@example.org", "Sales User")
		# meetings keep a Link to the calendar they were created on, so it has to exist
		if not frappe.db.exists("Google Calendar", "CRM Add-ons"):
			calendar = frappe.get_doc(
				{"doctype": "Google Calendar", "calendar_name": "CRM Add-ons", "user": "Administrator"}
			)
			calendar.flags.ignore_validate = True  # its validate needs Google API enabled in Google Settings
			calendar.insert(ignore_permissions=True)
		self.lead = frappe.get_doc(
			{
				"doctype": "CRM Lead",
				"first_name": "Meeting",
				"last_name": "Tester",
				"email": "meeting.tester@example.com",
				"lead_owner": self.owner.name,
			}
		).insert(ignore_permissions=True)

	def tearDown(self):
		frappe.set_user("Administrator")
		frappe.db.rollback()

	# helpers
	def make_user(self, email, role="Sales User"):
		user = frappe.get_doc(
			{
				"doctype": "User",
				"email": email,
				"first_name": email.split("@")[0],
				"send_welcome_email": 0,
				"roles": [{"role": role}],
			}
		)
		user.flags.ignore_permissions = True
		return user.insert()

	def data(self, **kw):
		base = {
			"subject": "Intro call",
			"reference_doctype": "CRM Lead",
			"reference_docname": self.lead.name,
			"starts_on": "2030-01-01 10:00:00",
			"ends_on": "2030-01-01 10:30:00",
			"add_video_conferencing": 1,
		}
		return {**base, **kw}

	def save(self, notify="all", **kw):
		return api.save_meeting(frappe.as_json(self.data(**kw)), notify=notify)

	def comments(self):
		return [c.content for c in frappe.get_all("Comment", filters={"reference_doctype": "CRM Lead", "reference_name": self.lead.name}, fields=["content"])]

	def guests(self, meeting):
		return sorted(g["email"] for g in meeting["attendees"])


class TestGoogleMeetFlow(TestCase):
	def test_create_invites_default_guests_and_stores_meet_link(self):
		fake = FakeGoogle()
		p1, p2 = google_patch(fake)
		with p1, p2, patch.object(frappe, "sendmail") as mail:
			result = self.save()

		meeting = result["meeting"]
		insert = fake.verbs("insert")[0]
		# the contact, the organizer and the record owner are invited by default
		self.assertEqual(self.guests(meeting), sorted(["meeting.tester@example.com", "owner.test@example.org"]))
		self.assertEqual({a["email"] for a in insert["body"]["attendees"]}, set(self.guests(meeting)))
		self.assertEqual(insert["sendUpdates"], "all")
		self.assertIn("conferenceData", insert["body"])
		self.assertEqual(meeting["google_meet_link"], MEET)
		self.assertEqual(meeting["sync_status"], "Synced")
		self.assertEqual(result["sync"]["status"], "Synced")
		mail.assert_not_called()  # Google already sent the invitations
		self.assertTrue(any(MEET in c for c in self.comments()))

	def test_choosing_not_to_notify_sends_nothing(self):
		fake = FakeGoogle()
		p1, p2 = google_patch(fake)
		with p1, p2, patch.object(frappe, "sendmail") as mail:
			meeting = self.save(notify="none")["meeting"]
		self.assertEqual(fake.verbs("insert")[0]["sendUpdates"], "none")
		mail.assert_not_called()
		self.assertTrue(any("not notified" in c for c in self.comments()))
		self.assertEqual(meeting["sync_status"], "Synced")

	def test_video_meeting_can_be_left_out(self):
		fake = FakeGoogle(meet=False)
		p1, p2 = google_patch(fake)
		with p1, p2:
			self.save(add_video_conferencing=0)
		self.assertNotIn("conferenceData", fake.verbs("insert")[0]["body"])

	def test_extra_guests_and_removing_a_default_one(self):
		fake = FakeGoogle()
		p1, p2 = google_patch(fake)
		with p1, p2:
			meeting = self.save(attendees=[{"email": "Colleague@Example.org"}, {"email": "colleague@example.org"}])["meeting"]
		self.assertEqual(self.guests(meeting), ["colleague@example.org"])  # de-duplicated, lower-cased, no defaults forced

	def test_reschedule_updates_google_and_can_notify_or_not(self):
		fake = FakeGoogle()
		p1, p2 = google_patch(fake)
		with p1, p2:
			meeting = self.save()["meeting"]
			api.save_meeting(
				frappe.as_json({"name": meeting["name"], "starts_on": "2030-01-02 15:00:00", "ends_on": "2030-01-02 15:45:00"}),
				notify="all",
			)
			api.save_meeting(frappe.as_json({"name": meeting["name"], "subject": "Renamed"}), notify="none")

		patches = fake.verbs("patch")
		self.assertEqual(len(patches), 2)
		self.assertEqual(patches[0]["body"]["start"]["dateTime"], "2030-01-02T15:00:00")
		self.assertEqual(patches[0]["sendUpdates"], "all")
		self.assertEqual(patches[1]["sendUpdates"], "none")
		self.assertEqual(patches[1]["body"]["summary"], "Renamed")
		self.assertTrue(any("rescheduled" in c for c in self.comments()))

	def test_adding_a_guest_later_updates_google(self):
		fake = FakeGoogle()
		p1, p2 = google_patch(fake)
		with p1, p2:
			meeting = self.save(attendees=[{"email": "a@example.org"}])["meeting"]
			updated = api.save_meeting(
				frappe.as_json({"name": meeting["name"], "attendees": [{"email": "a@example.org"}, {"email": "b@example.org"}]}),
				notify="all",
			)["meeting"]
		self.assertEqual(self.guests(updated), ["a@example.org", "b@example.org"])
		self.assertEqual({a["email"] for a in fake.verbs("patch")[0]["body"]["attendees"]}, {"a@example.org", "b@example.org"})

	def test_cancel_deletes_the_google_event_and_locks_the_meeting(self):
		fake = FakeGoogle()
		p1, p2 = google_patch(fake)
		with p1, p2:
			meeting = self.save()["meeting"]
			cancelled = api.cancel_meeting(meeting["name"], notify="all")
			self.assertEqual(cancelled["status"], "Cancelled")
			self.assertEqual(fake.verbs("delete")[0]["sendUpdates"], "all")
			with self.assertRaises(frappe.ValidationError):
				api.save_meeting(frappe.as_json({"name": meeting["name"], "subject": "Nope"}))
		self.assertTrue(any("cancelled" in c.lower() for c in self.comments()))

	def test_google_error_keeps_the_meeting_and_falls_back_to_email(self):
		error = HttpError(httplib2.Response({"status": 403}), b'{"error": {"message": "nope"}}')
		p1, p2 = google_patch(FakeGoogle(error=error))
		with p1, p2, patch.object(frappe, "sendmail") as mail:
			result = self.save()
		self.assertTrue(frappe.db.exists("CRM Meeting", result["meeting"]["name"]))
		self.assertEqual(result["meeting"]["sync_status"], "Failed")
		self.assertIn("Google refused", result["meeting"]["sync_error"])
		mail.assert_called()  # guests are still invited, by our own email
		self.assertIn("meeting.ics", str(mail.call_args.kwargs["attachments"]))

	def test_no_calendar_connected_is_reported_not_raised(self):
		with patch("crm_addons.providers.google_meet.pick_calendar", side_effect=ProviderNotConfigured("No calendar")):
			with patch.object(frappe, "sendmail") as mail:
				meeting = self.save()["meeting"]
		self.assertEqual(meeting["sync_status"], "Not synced")
		self.assertEqual(meeting["sync_error"], "No calendar")
		mail.assert_called()


class TestManualLinkAndNotifications(TestCase):
	def test_manual_link_requires_a_url_and_emails_an_ics(self):
		with patch.object(frappe, "sendmail") as mail:
			meeting = self.save(provider="Manual Link", google_meet_link="https://zoom.us/j/123")["meeting"]
		self.assertEqual(meeting["google_meet_link"], "https://zoom.us/j/123")
		self.assertIn("BEGIN:VCALENDAR", mail.call_args.kwargs["attachments"][0]["fcontent"].decode())

		with patch.object(frappe, "sendmail"):
			bad = self.save(provider="Manual Link", google_meet_link="not a url")["meeting"]
		self.assertEqual(bad["sync_status"], "Failed")

	def test_team_members_get_in_app_notifications(self):
		guest = self.make_user("guest.test@example.org")
		p1, p2 = google_patch(FakeGoogle())
		with p1, p2:
			self.save(attendees=[{"email": guest.email}])
		got = {n.to_user for n in frappe.get_all("CRM Notification", fields=["to_user"], filters={"notification_type_doctype": "CRM Meeting"})}
		self.assertIn(guest.name, got)
		self.assertIn(self.owner.name, got)  # the Lead's owner hears about it too
		self.assertNotIn("Administrator", got)  # not the person who scheduled it

	def test_notify_guests_on_demand(self):
		p1, p2 = google_patch(FakeGoogle())
		with p1, p2:
			meeting = self.save()["meeting"]
		with patch.object(frappe, "sendmail") as mail:
			result = api.notify_guests(meeting["name"], message="Running 5 minutes late", email=1, in_app=0)
		self.assertEqual(result["emailed"], 2)
		self.assertIn("Running 5 minutes late", mail.call_args.kwargs["message"])

	def test_reminders_are_sent_once(self):
		p1, p2 = google_patch(FakeGoogle())
		start = add_to_date(now_datetime(), minutes=20)
		with p1, p2:
			meeting = self.save(starts_on=str(start), ends_on=str(add_to_date(start, minutes=30)))["meeting"]
		frappe.db.set_value("CRM Addons Settings", None, {"reminders_enabled": 1, "reminder_minutes_before": 30})
		frappe.clear_document_cache("CRM Addons Settings", "CRM Addons Settings")
		before = frappe.db.count("CRM Notification")
		with patch.object(frappe, "sendmail") as mail, patch.object(frappe.db, "commit"):  # the scheduler commits
			notifications.send_due_reminders()
			first_round = frappe.db.count("CRM Notification") - before
			notifications.send_due_reminders()
			second_round = frappe.db.count("CRM Notification") - before
		self.assertGreater(first_round, 0)
		self.assertEqual(first_round, second_round)  # nothing more on the second run
		self.assertEqual(mail.call_count, 1)
		self.assertIn("30", frappe.db.get_value("CRM Meeting", meeting["name"], "reminders_sent"))


class TestPermissions(TestCase):
	def test_users_only_see_their_own_or_invited_meetings(self):
		a = self.make_user("a.sales@example.org")
		b = self.make_user("b.sales@example.org")
		c = self.make_user("c.sales@example.org")
		manager = self.make_user("mgr.sales@example.org", "Sales Manager")
		# CRM only lets a sales user work with leads they own (or see through the org hierarchy)
		frappe.db.set_value("CRM Lead", self.lead.name, "lead_owner", a.name)

		p1, p2 = google_patch(FakeGoogle())
		with p1, p2:
			frappe.set_user(a.name)
			meeting = api.save_meeting(
				frappe.as_json(self.data(attendees=[{"email": b.email}])), notify="none"
			)["meeting"]
		name = meeting["name"]

		def visible(user):
			frappe.set_user(user)
			return [m["name"] for m in api.list_meetings("2029-12-01", "2030-02-01", scope="all")]

		self.assertIn(name, visible(a.name))  # created it
		self.assertIn(name, visible(b.name))  # was invited
		self.assertNotIn(name, visible(c.name))  # unrelated
		self.assertIn(name, visible(manager.name))  # managers see everything
		self.assertIn(name, visible("Administrator"))

		frappe.set_user(b.name)
		self.assertFalse(api.get_meeting(name)["can_edit"])  # guests are read-only
		with self.assertRaises(frappe.PermissionError):
			api.cancel_meeting(name)
		frappe.set_user(c.name)
		with self.assertRaises(frappe.PermissionError):
			api.get_meeting(name)
		frappe.set_user(manager.name)
		self.assertTrue(api.get_meeting(name)["can_edit"])

	def test_scope_mine_narrows_a_manager_to_their_own(self):
		manager = self.make_user("mgr2.sales@example.org", "Sales Manager")
		p1, p2 = google_patch(FakeGoogle())
		with p1, p2:
			mine = self.save()["meeting"]["name"]
			frappe.set_user(manager.name)
			others = [m["name"] for m in api.list_meetings("2029-12-01", "2030-02-01", scope="mine")]
			everyone = [m["name"] for m in api.list_meetings("2029-12-01", "2030-02-01", scope="all")]
		self.assertNotIn(mine, others)
		self.assertIn(mine, everyone)


class TestHelpers(TestCase):
	def test_next_meeting_column_follows_the_meetings(self):
		future = add_to_date(now_datetime(), days=3)
		p1, p2 = google_patch(FakeGoogle())
		with p1, p2:
			meeting = self.save(starts_on=str(future), ends_on=str(add_to_date(future, hours=1)))["meeting"]
			self.assertIsNotNone(frappe.db.get_value("CRM Lead", self.lead.name, "next_meeting_on"))
			api.cancel_meeting(meeting["name"], notify="none")
		self.assertIsNone(frappe.db.get_value("CRM Lead", self.lead.name, "next_meeting_on"))

	def test_end_must_be_after_start(self):
		with self.assertRaises(frappe.ValidationError):
			self.save(ends_on="2030-01-01 09:00:00")

	def test_only_leads(self):
		for doctype, name in (("User", "Administrator"), ("CRM Deal", "anything")):
			with self.assertRaises(frappe.ValidationError):
				self.save(reference_doctype=doctype, reference_docname=name)

	def test_search_guests_and_records(self):
		found = api.search_guests("owner.test")
		self.assertIn("owner.test@example.org", [g["email"] for g in found])
		records = api.search_records("CRM Lead", "Tester")
		self.assertIn(self.lead.name, [r["name"] for r in records])
		self.assertEqual(api.get_reference("CRM Lead", self.lead.name)["title"], "Meeting Tester")
		defaults = api.get_default_guests("CRM Lead", self.lead.name)
		self.assertIn("meeting.tester@example.com", [g["email"] for g in defaults])

	def test_dashboard_charts_return_the_shapes_crm_expects(self):
		from crm_addons import dashboard

		for fn in (dashboard.get_meetings_today, dashboard.get_upcoming_meetings_week, dashboard.get_meetings_in_period):
			result = fn("2030-01-01", "2030-01-31", None)
			self.assertEqual({"title", "value", "delta"} <= set(result), True)
		self.assertEqual(dashboard.get_meetings_by_day("2030-01-01", "2030-01-31", "Administrator")["xAxis"]["type"], "time")
		self.assertIn("categoryColumn", dashboard.get_meetings_by_status("2030-01-01", "2030-01-31", None))

	def test_ics_is_valid_enough_for_calendar_apps(self):
		p1, p2 = google_patch(FakeGoogle())
		with p1, p2:
			meeting = self.save(description="Line one; two, three")["meeting"]
		doc = frappe.get_doc("CRM Meeting", meeting["name"])
		from crm_addons.utils import build_ics

		ics = build_ics(doc).decode()
		BS = chr(92)  # a backslash: calendar files escape ";" and "," with one
		for needle in ("BEGIN:VEVENT", "SUMMARY:Intro call", "DTSTART:20300101T", "ATTENDEE;", f"Line one{BS}; two{BS}, three"):
			self.assertIn(needle, ics)
		self.assertIn("METHOD:CANCEL", build_ics(doc, "CANCEL").decode())
