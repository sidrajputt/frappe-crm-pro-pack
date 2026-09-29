from frappe import _

from crm_addons.providers.base import MeetingProvider, ProviderError


class ManualLinkProvider(MeetingProvider):
	"""Use any meeting URL (Zoom, Teams, Jitsi, ...) that the organizer pastes in.

	Nothing is created in an external calendar, so invitations are sent by the
	CRM itself as an email with a calendar (.ics) file attached.
	"""

	key = "Manual Link"
	label = "Manual link"
	description = "Paste any meeting URL. Guests are invited by email with a calendar file attached."

	def create(self, meeting, notify):
		link = (meeting.google_meet_link or "").strip()
		if meeting.add_video_conferencing and not link.lower().startswith(("http://", "https://")):
			raise ProviderError(_("Paste the full meeting link (starting with https://) for a manual meeting."))
		return {"link": link, "sync_status": "Not synced"}
