from frappe import _

from crm_addons.providers.base import MeetingProvider, ProviderError


class ComingSoonProvider(MeetingProvider):
	implemented = False

	def status(self):
		return {"ready": False, "message": _("Coming soon")}

	def create(self, meeting, notify):
		raise ProviderError(_("{0} meetings are not available yet.").format(self.label))


class ZoomProvider(ComingSoonProvider):
	key = "Zoom"
	label = "Zoom"
	description = "Create Zoom meetings automatically. Planned."


class TeamsProvider(ComingSoonProvider):
	key = "Microsoft Teams"
	label = "Microsoft Teams"
	description = "Create Microsoft Teams meetings automatically. Planned."
