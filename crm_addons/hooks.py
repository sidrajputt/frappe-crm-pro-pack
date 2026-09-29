from . import __version__ as app_version  # noqa: F401

app_name = "crm_addons"
app_title = "CRM Pro Pack"
app_publisher = "Coding Pro"
app_description = (
	"CRM Pro Pack for Frappe CRM: Google Meet and Google Calendar meetings, call follow-ups with "
	"attempts and outcomes, lead scoring, stale-lead alerts, a role-aware Sales Dashboard with Excel "
	"export, and reminders. Installs like any other Frappe app, with no changes to CRM's code."
)
app_email = ""  # left empty on purpose: no personal address in a public repository
app_license = "MIT"

required_apps = ["crm"]

# Set everything up on install, and re-check on every migrate (idempotent).
after_install = "crm_addons.install.after_install"
after_migrate = "crm_addons.install.after_migrate"
before_uninstall = "crm_addons.install.before_uninstall"

# Managers see every meeting; sales users only the ones they made or were invited to.
permission_query_conditions = {
	"CRM Meeting": "crm_addons.permissions.get_permission_query_conditions",
	"CRM Follow Up": "crm_addons.permissions.get_follow_up_query_conditions",
}
has_permission = {
	"CRM Meeting": "crm_addons.permissions.has_permission",
	"CRM Follow Up": "crm_addons.permissions.has_follow_up_permission",
}

# CRM's page has no place for an app's script, so the tag is added to the response (see inject.py).
after_request = ["crm_addons.inject.add_addon_script"]

# A short address for the full-screen Sales Dashboard.
website_redirects = [{"source": "/sales-dashboard", "target": "/assets/crm_addons/meetings/dashboard.html"}]

scheduler_events = {
	"cron": {
		"*/5 * * * *": [
			"crm_addons.notifications.send_due_reminders",
			"crm_addons.followups.send_due_reminders",
		]
	},
	"hourly": ["crm_addons.utils.refresh_stale_next_meetings"],
	"daily": ["crm_addons.stale.send_stale_alerts", "crm_addons.scoring.refresh_all"],
}

# Charts for the CRM dashboard (CRM's own extension hook).
crm_dashboard_charts = {
	"number_chart": [
		{"label": "Meetings today", "value": "meetings_today", "resolver": "crm_addons.dashboard.get_meetings_today"},
		{
			"label": "Meetings in the next 7 days",
			"value": "upcoming_meetings_week",
			"resolver": "crm_addons.dashboard.get_upcoming_meetings_week",
		},
		{"label": "Meetings", "value": "meetings_in_period", "resolver": "crm_addons.dashboard.get_meetings_in_period"},
		{"label": "Follow-ups due today", "value": "follow_ups_due_today", "resolver": "crm_addons.dashboard.get_follow_ups_due_today"},
		{"label": "Overdue follow-ups", "value": "overdue_follow_ups", "resolver": "crm_addons.dashboard.get_overdue_follow_ups"},
		{"label": "Call connect rate", "value": "call_connect_rate", "resolver": "crm_addons.dashboard.get_call_connect_rate"},
		{
			"label": "Attempts to connect",
			"value": "attempts_to_connect",
			"resolver": "crm_addons.dashboard.get_attempts_to_connect",
		},
	],
	"axis_chart": [
		{"label": "Meetings by day", "value": "meetings_by_day", "resolver": "crm_addons.dashboard.get_meetings_by_day"},
		{"label": "Follow-ups by day", "value": "follow_ups_by_day", "resolver": "crm_addons.dashboard.get_follow_ups_by_day"},
		{
			"label": "Activity by salesperson",
			"value": "activity_by_salesperson",
			"resolver": "crm_addons.dashboard.get_activity_by_salesperson",
		},
	],
	"donut_chart": [
		{
			"label": "Meetings by status",
			"value": "meetings_by_status",
			"resolver": "crm_addons.dashboard.get_meetings_by_status",
		},
		{
			"label": "Follow-ups by outcome",
			"value": "follow_ups_by_outcome",
			"resolver": "crm_addons.dashboard.get_follow_ups_by_outcome",
		},
		{
			"label": "Calls by result",
			"value": "calls_by_status",
			"resolver": "crm_addons.dashboard.get_calls_by_status",
		},
		{"label": "Leads by score", "value": "leads_by_score_band", "resolver": "crm_addons.dashboard.get_leads_by_score_band"},
		{"label": "Meetings by outcome", "value": "meetings_by_outcome", "resolver": "crm_addons.dashboard.get_meetings_by_outcome"},
	],
}

# CRM's get_dashboard leaves contributed charts empty; this fills them in.
override_whitelisted_methods = {"crm.api.dashboard.get_dashboard": "crm_addons.dashboard.get_dashboard"}

# Extension point: register more meeting providers, for example
#   crm_addons_providers = {"Zoom": "my_app.zoom.ZoomProvider"}
# crm_addons_providers = {}
