"""Meeting providers: the services that create the video-meeting link.

Built in: Google Meet, Manual link. Zoom and Microsoft Teams are listed as
"coming soon". Other apps can add providers through the hook:

    crm_addons_providers = {"Zoom": "my_app.providers.ZoomProvider"}
"""

import frappe
from frappe import _

from crm_addons.providers.base import MeetingProvider, ProviderError, ProviderNotConfigured  # noqa: F401

BUILTIN = {
	"Google Meet": "crm_addons.providers.google_meet.GoogleMeetProvider",
	"Manual Link": "crm_addons.providers.manual_link.ManualLinkProvider",
	"Zoom": "crm_addons.providers.unavailable.ZoomProvider",
	"Microsoft Teams": "crm_addons.providers.unavailable.TeamsProvider",
}


def _registry():
	registry = dict(BUILTIN)
	for key, paths in (frappe.get_hooks("crm_addons_providers", default={}) or {}).items():
		path = paths[-1] if isinstance(paths, (list, tuple)) else paths
		registry[key] = path
	return registry


def get_provider(name):
	path = _registry().get(name)
	if not path:
		raise ProviderError(_("Unknown meeting provider: {0}").format(name))
	provider = frappe.get_attr(path)()
	if not provider.implemented:
		raise ProviderError(_("{0} meetings are not available yet.").format(provider.label))
	return provider


def provider_catalog():
	"""Every known provider with its readiness, for the settings page and the editor."""
	catalog = []
	for key, path in _registry().items():
		provider = frappe.get_attr(path)()
		state = provider.status() if provider.implemented else {"ready": False, "message": _("Coming soon")}
		catalog.append(
			{
				"key": key,
				"label": provider.label or key,
				"description": provider.description,
				"implemented": bool(provider.implemented),
				"ready": bool(state.get("ready")),
				"message": state.get("message") or "",
			}
		)
	return catalog
