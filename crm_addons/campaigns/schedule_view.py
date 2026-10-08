"""The campaign calendar: what goes out when.

One entry per campaign with a date: its first day, its last day (today while it is still running), and the days its
follow-up steps are due. The page marks the days on which more than one campaign sends, so two blasts are not planned
for the same audience on the same day by accident.
"""

import frappe
from frappe.utils import add_days, cint, getdate, today

from crm_addons.campaigns.common import CAMPAIGN, automation_ready

MAX_EVENTS = 400


def _day(value):
	return getdate(value) if value else None


def events(from_date, to_date):
	"""Campaign entries (visible to the caller) that touch ``from_date`` .. ``to_date`` (inclusive)."""
	start, end = getdate(from_date), getdate(to_date)
	rows = frappe.get_list(
		CAMPAIGN,
		filters={"automation": ["is", "not set"]} if automation_ready() else {},
		fields=["name", "campaign_name", "status", "send_mode", "scheduled_at", "started_at", "completed_at", "trigger_event", "total_recipients", "health_note"],
		limit_page_length=MAX_EVENTS,
		order_by="modified desc",
	)
	steps = {}
	for s in frappe.get_all("CRM Campaign Step", filters={"parenttype": CAMPAIGN, "parent": ["in", [r.name for r in rows] or [""]]}, fields=["parent", "idx", "channel", "day_offset"], order_by="idx asc"):
		steps.setdefault(s.parent, []).append(s)
	out = []
	for r in rows:
		planned = r.status in ("Draft", "Scheduled")
		first = _day(r.scheduled_at) if planned and r.send_mode == "Schedule" else (_day(r.started_at) or _day(r.scheduled_at))
		if not first:
			continue
		running = r.status in ("Queued", "Running", "Paused")
		last = _day(r.completed_at) or (max(getdate(today()), first) if running else first)
		days = sorted({add_days(first, cint(s.day_offset)) for s in steps.get(r.name, []) if cint(s.day_offset) > 0 and r.send_mode != "Trigger"})
		if r.send_mode != "Trigger" and days:
			last = max(last, days[-1]) if planned or running else last
		if last < start or first > end:
			continue
		out.append(
			{
				"name": r.name, "title": r.campaign_name, "status": r.status, "automatic": r.send_mode == "Trigger",
				"trigger": r.trigger_event, "first": str(first), "last": str(last), "recipients": cint(r.total_recipients),
				"step_days": [str(d) for d in days if start <= d <= end], "warning": r.health_note or "",
				"channels": sorted({s.channel for s in steps.get(r.name, [])}),
			}
		)
	return out
