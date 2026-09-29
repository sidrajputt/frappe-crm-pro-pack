"""Load the add-on UI inside the CRM single-page app without editing CRM.

CRM's page (/crm) is a prebuilt HTML file with no place to include an app's script, so
after Frappe has built the response, the script tag is added just before </body>.
"""

import os

import frappe

MARKER = b"crm_addons/addons.js"


def _asset_version():
	"""The newest modification time of any file under public/. Every script, page and stylesheet
	is requested with this as its ``?v=``, so a browser can never keep serving an older copy of
	one file next to a newer copy of another."""
	newest = 1
	for folder, _dirs, files in os.walk(frappe.get_app_path("crm_addons", "public")):
		for name in files:
			try:
				newest = max(newest, int(os.path.getmtime(os.path.join(folder, name))))
			except OSError:
				continue
	return newest


def add_addon_script(response=None, request=None, **kwargs):
	"""``after_request`` hook."""
	try:
		path = (getattr(request, "path", "") or "").rstrip("/")
		if path != "/crm" and not path.startswith("/crm/"):
			return
		if (
			response is None
			or response.status_code != 200
			or response.direct_passthrough
			or "text/html" not in (response.headers.get("Content-Type") or "")
			or frappe.session.user == "Guest"
		):
			return
		body = response.get_data()
		if MARKER in body or b"</body>" not in body:
			return
		tag = (
			f'<link rel="stylesheet" href="/assets/crm_addons/addons.css?v={_asset_version()}">'
			f'<script src="/assets/crm_addons/addons.js?v={_asset_version()}" defer></script>'
		).encode()
		response.set_data(body.replace(b"</body>", tag + b"</body>", 1))
	except Exception:
		# never break the CRM page over a decoration
		frappe.logger().error("CRM Add-ons: could not add the script to the CRM page", exc_info=True)
