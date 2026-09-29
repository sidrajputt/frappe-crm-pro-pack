class ProviderError(Exception):
	"""The provider could not complete the request. The message is shown to the user."""


class ProviderNotConfigured(ProviderError):
	"""The provider is not set up yet (for example no Google Calendar is connected)."""


class MeetingProvider:
	"""One way of creating a meeting link (Google Meet, Zoom, Teams, ...).

	To add a provider, subclass this, implement the methods you support and
	register it in your app's hooks.py:

	    crm_addons_providers = {"Zoom": "my_app.zoom.ZoomProvider"}

	Every method receives the CRM Meeting document. ``create`` / ``update``
	return a dict with any of:

	    link                the join URL
	    external_event_id   id of the event in the external calendar
	    external_event_url  link to the event in the external calendar
	    calendar            name of the calendar record used
	    sync_status         "Synced" if the external service delivered the
	                        invitations itself, otherwise "Not synced"
	"""

	key = ""
	label = ""
	description = ""
	implemented = True

	def status(self):
		"""{"ready": bool, "message": str} - shown on the settings page."""
		return {"ready": True, "message": ""}

	def create(self, meeting, notify):
		raise NotImplementedError

	def update(self, meeting, notify):
		return self.create(meeting, notify)

	def cancel(self, meeting, notify):
		return None

	def refresh(self, meeting):
		"""Pull the latest guest responses / link. Return None when unsupported."""
		return None
