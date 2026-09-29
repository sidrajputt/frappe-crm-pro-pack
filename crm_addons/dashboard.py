"""Charts for the CRM dashboard, contributed through the ``crm_dashboard_charts`` hook.

Every resolver receives ``(from_date, to_date, user)``. CRM passes ``user`` for
sales users (so they only see their own numbers) and ``None`` for managers.
"""

import frappe
from frappe import _
from frappe.utils import add_days, date_diff, get_first_day, get_last_day, getdate, nowdate


def _scope(user):
	"""SQL that limits meetings to those a user created, organizes or was invited to."""
	if not user:
		return "", {}
	return (
		" and (m.owner = %(me)s or m.organizer = %(me)s or exists (select 1 from `tabCRM Meeting Attendee` a "
		"where a.parent = m.name and a.user = %(me)s))",
		{"me": user},
	)


def _count(start, end, user, statuses=("Scheduled", "Completed")):
	"""Meetings starting on [start, end] (inclusive dates)."""
	scope, params = _scope(user)
	params.update({"start": getdate(start), "end": add_days(getdate(end), 1), "statuses": statuses})
	return frappe.db.sql(
		f"""select count(*) from `tabCRM Meeting` m
		where m.starts_on >= %(start)s and m.starts_on < %(end)s and m.status in %(statuses)s {scope}""",
		params,
	)[0][0]


def _delta(current, previous):
	return (current - previous) / previous * 100 if previous else 0


def get_meetings_today(from_date=None, to_date=None, user=None):
	today = nowdate()
	current = _count(today, today, user, ("Scheduled",))
	yesterday = add_days(today, -1)
	return {
		"title": _("Meetings today"),
		"tooltip": _("Scheduled meetings that start today"),
		"value": current,
		"delta": _delta(current, _count(yesterday, yesterday, user)),
		"deltaSuffix": "%",
	}


def get_upcoming_meetings_week(from_date=None, to_date=None, user=None):
	today = nowdate()
	current = _count(today, add_days(today, 6), user, ("Scheduled",))
	return {
		"title": _("Meetings in the next 7 days"),
		"tooltip": _("Scheduled meetings starting in the next 7 days"),
		"value": current,
		"delta": 0,
		"deltaSuffix": "%",
	}


def get_meetings_in_period(from_date=None, to_date=None, user=None):
	span = max(date_diff(to_date, from_date), 1)
	current = _count(from_date, to_date, user)
	previous = _count(add_days(from_date, -span), add_days(from_date, -1), user)
	return {
		"title": _("Meetings"),
		"tooltip": _("Meetings scheduled in the selected period"),
		"value": current,
		"delta": _delta(current, previous),
		"deltaSuffix": "%",
	}


def get_meetings_by_day(from_date=None, to_date=None, user=None):
	scope, params = _scope(user)
	params.update({"start": getdate(from_date), "end": add_days(getdate(to_date), 1)})
	rows = frappe.db.sql(
		f"""select date(m.starts_on) as day, count(*) as meetings from `tabCRM Meeting` m
		where m.starts_on >= %(start)s and m.starts_on < %(end)s and m.status != 'Cancelled' {scope}
		group by date(m.starts_on) order by day""",
		params,
		as_dict=True,
	)
	return {
		"data": [{"date": r.day.strftime("%Y-%m-%d"), "meetings": r.meetings} for r in rows],
		"title": _("Meetings by day"),
		"subtitle": _("How many meetings are scheduled each day"),
		"xAxis": {"title": _("Date"), "key": "date", "type": "time", "timeGrain": "day"},
		"yAxis": {"title": _("Meetings")},
		"series": [{"name": "meetings", "type": "bar"}],
	}


def get_meetings_by_status(from_date=None, to_date=None, user=None):
	scope, params = _scope(user)
	params.update({"start": getdate(from_date), "end": add_days(getdate(to_date), 1)})
	rows = frappe.db.sql(
		f"""select m.status as status, count(*) as meetings from `tabCRM Meeting` m
		where m.starts_on >= %(start)s and m.starts_on < %(end)s {scope} group by m.status""",
		params,
		as_dict=True,
	)
	return {
		"data": [{"status": _(r.status), "meetings": r.meetings} for r in rows],
		"title": _("Meetings by status"),
		"subtitle": _("Scheduled, completed and cancelled"),
		"categoryColumn": "status",
		"valueColumn": "meetings",
	}


# -- follow-ups ------------------------------------------------------------------------------------


def _fscope(user):
	"""SQL that limits follow-ups to those a user logged or owns."""
	if not user:
		return "", {}
	return " and (f.owner = %(me)s or f.assigned_to = %(me)s)", {"me": user}


def _range(from_date, to_date):
	return {"start": getdate(from_date), "end": add_days(getdate(to_date), 1)}


def get_follow_ups_due_today(from_date=None, to_date=None, user=None):
	scope, params = _fscope(user)
	today = getdate(nowdate())
	params.update({"start": today, "end": add_days(today, 1)})
	value = frappe.db.sql(
		f"""select count(*) from `tabCRM Follow Up` f
		where f.next_closed = 0 and f.next_follow_up_on >= %(start)s and f.next_follow_up_on < %(end)s {scope}""",
		params,
	)[0][0]
	return {
		"title": _("Follow-ups due today"),
		"tooltip": _("Follow-ups that are due today"),
		"value": value,
		"delta": 0,
		"deltaSuffix": "%",
	}


def get_overdue_follow_ups(from_date=None, to_date=None, user=None):
	scope, params = _fscope(user)
	params["now"] = frappe.utils.now_datetime()
	value = frappe.db.sql(
		f"""select count(*) from `tabCRM Follow Up` f
		where f.next_closed = 0 and f.next_follow_up_on < %(now)s {scope}""",
		params,
	)[0][0]
	return {
		"title": _("Overdue follow-ups"),
		"tooltip": _("Follow-ups whose date has passed and are not done yet"),
		"value": value,
		"delta": 0,
		"deltaSuffix": "%",
	}


def _calls(from_date, to_date, user):
	scope, params = _fscope(user)
	params.update(_range(from_date, to_date))
	row = frappe.db.sql(
		f"""select count(*), sum(f.call_status = 'Connected'), avg(case when f.call_status = 'Connected' then f.attempt_no end)
		from `tabCRM Follow Up` f
		where f.mode = 'Call' and f.followed_up_on >= %(start)s and f.followed_up_on < %(end)s {scope}""",
		params,
	)[0]
	return (row[0] or 0), int(row[1] or 0), float(row[2] or 0)


def get_call_connect_rate(from_date=None, to_date=None, user=None):
	span = max(date_diff(to_date, from_date), 1)
	total, connected, _avg = _calls(from_date, to_date, user)
	p_total, p_connected, _p_avg = _calls(add_days(from_date, -span), add_days(from_date, -1), user)
	rate = connected / total * 100 if total else 0
	previous = p_connected / p_total * 100 if p_total else 0
	return {
		"title": _("Call connect rate"),
		"tooltip": _("Share of calls (in %) that reached the person"),
		"value": round(rate, 1),
		"delta": round(rate - previous, 1),
		"deltaSuffix": "%",
	}


def get_attempts_to_connect(from_date=None, to_date=None, user=None):
	span = max(date_diff(to_date, from_date), 1)
	_t, _c, avg = _calls(from_date, to_date, user)
	_pt, _pc, previous = _calls(add_days(from_date, -span), add_days(from_date, -1), user)
	return {
		"title": _("Attempts to connect"),
		"tooltip": _("Average number of calls it took to reach someone"),
		"value": round(avg, 1),
		"delta": _delta(avg, previous),
		"deltaSuffix": "%",
	}


def get_follow_ups_by_day(from_date=None, to_date=None, user=None):
	scope, params = _fscope(user)
	params.update(_range(from_date, to_date))
	rows = frappe.db.sql(
		f"""select date(f.followed_up_on) as day, count(*) as follow_ups,
			sum(f.call_status = 'Connected') as connected
		from `tabCRM Follow Up` f
		where f.followed_up_on >= %(start)s and f.followed_up_on < %(end)s {scope}
		group by date(f.followed_up_on) order by day""",
		params,
		as_dict=True,
	)
	return {
		"data": [
			{"date": r.day.strftime("%Y-%m-%d"), "follow_ups": r.follow_ups, "connected": int(r.connected or 0)}
			for r in rows
		],
		"title": _("Follow-ups by day"),
		"subtitle": _("Follow-ups logged each day, and how many reached the person"),
		"xAxis": {"title": _("Date"), "key": "date", "type": "time", "timeGrain": "day"},
		"yAxis": {"title": _("Follow-ups")},
		"series": [{"name": "follow_ups", "type": "bar"}, {"name": "connected", "type": "bar"}],
	}


def get_follow_ups_by_outcome(from_date=None, to_date=None, user=None):
	scope, params = _fscope(user)
	params.update(_range(from_date, to_date))
	rows = frappe.db.sql(
		f"""select coalesce(nullif(f.outcome, ''), 'No outcome') as outcome, count(*) as follow_ups
		from `tabCRM Follow Up` f
		where f.followed_up_on >= %(start)s and f.followed_up_on < %(end)s {scope}
		group by 1 order by 2 desc""",
		params,
		as_dict=True,
	)
	return {
		"data": [{"outcome": _(r.outcome), "follow_ups": r.follow_ups} for r in rows],
		"title": _("Follow-ups by outcome"),
		"subtitle": _("What came of the follow-ups"),
		"categoryColumn": "outcome",
		"valueColumn": "follow_ups",
	}


def get_calls_by_status(from_date=None, to_date=None, user=None):
	scope, params = _fscope(user)
	params.update(_range(from_date, to_date))
	rows = frappe.db.sql(
		f"""select f.call_status as status, count(*) as calls from `tabCRM Follow Up` f
		where f.mode = 'Call' and f.call_status != '' and f.followed_up_on >= %(start)s
		and f.followed_up_on < %(end)s {scope} group by f.call_status order by calls desc""",
		params,
		as_dict=True,
	)
	return {
		"data": [{"status": _(r.status), "calls": r.calls} for r in rows],
		"title": _("Calls by result"),
		"subtitle": _("Connected, did not pick and did not connect"),
		"categoryColumn": "status",
		"valueColumn": "calls",
	}


# -- insights ---------------------------------------------------------------------------------------------


def get_activity_by_salesperson(from_date=None, to_date=None, user=None):
	"""Calls, connected calls and meetings held per person: a simple team leaderboard."""
	params = _range(from_date, to_date)
	calls_who = meetings_who = ""
	if user:
		params["me"] = user
		calls_who, meetings_who = " and f.owner = %(me)s", " and m.organizer = %(me)s"
	calls = frappe.db.sql(
		f"""select f.owner as person, count(*) as calls, sum(f.call_status = 'Connected') as connected
		from `tabCRM Follow Up` f
		where f.mode = 'Call' and f.followed_up_on >= %(start)s and f.followed_up_on < %(end)s
		{calls_who} group by f.owner""",
		params,
		as_dict=True,
	)
	meetings = frappe.db.sql(
		f"""select m.organizer as person, count(*) as meetings from `tabCRM Meeting` m
		where m.status in ('Scheduled', 'Completed') and m.starts_on >= %(start)s and m.starts_on < %(end)s
		{meetings_who} group by m.organizer""",
		params,
		as_dict=True,
	)
	people = {}
	for r in calls:
		people.setdefault(r.person, {})["calls"] = r.calls
		people[r.person]["connected"] = int(r.connected or 0)
	for r in meetings:
		people.setdefault(r.person, {})["meetings"] = r.meetings
	from crm_addons.utils import user_details

	data = [
		{
			"salesperson": user_details(person)[1] or person or "-",
			"calls": v.get("calls", 0),
			"connected": v.get("connected", 0),
			"meetings": v.get("meetings", 0),
		}
		for person, v in people.items()
	]
	data.sort(key=lambda r: (r["calls"] + r["meetings"]), reverse=True)
	return {
		"data": data[:15],
		"title": _("Activity by salesperson"),
		"subtitle": _("Calls, connected calls and meetings in the period"),
		"xAxis": {"title": _("Salesperson"), "key": "salesperson", "type": "category"},
		"yAxis": {"title": _("Count")},
		"series": [{"name": "calls", "type": "bar"}, {"name": "connected", "type": "bar"}, {"name": "meetings", "type": "bar"}],
	}


def get_leads_by_score_band(from_date=None, to_date=None, user=None):
	"""Open Leads by Hot / Warm / Cold, from their Lead Score."""
	from crm_addons import scoring

	params = {"hot": scoring.HOT, "warm": scoring.WARM}
	who = ""
	if user:
		who, params["me"] = " and l.lead_owner = %(me)s", user
	rows = frappe.db.sql(
		f"""select case when l.addons_score >= %(hot)s then 'Hot' when l.addons_score >= %(warm)s then 'Warm' else 'Cold' end as band,
			count(*) as leads
		from `tabCRM Lead` l where l.converted = 0 and l.addons_score is not null {who} group by band""",
		params,
		as_dict=True,
	)
	return {
		"data": [{"band": _(r.band), "leads": r.leads} for r in rows],
		"title": _("Leads by score"),
		"subtitle": _("Hot, warm and cold open leads"),
		"categoryColumn": "band",
		"valueColumn": "leads",
	}


def get_meetings_by_outcome(from_date=None, to_date=None, user=None):
	scope, params = _scope(user)
	params.update(_range(from_date, to_date))
	rows = frappe.db.sql(
		f"""select coalesce(nullif(m.meeting_outcome, ''), 'No outcome yet') as outcome, count(*) as meetings
		from `tabCRM Meeting` m
		where m.status != 'Cancelled' and m.starts_on >= %(start)s and m.starts_on < %(end)s {scope} group by 1""",
		params,
		as_dict=True,
	)
	return {
		"data": [{"outcome": _(r.outcome), "meetings": r.meetings} for r in rows],
		"title": _("Meetings by outcome"),
		"subtitle": _("Held, no-show, rescheduled and not recorded yet"),
		"categoryColumn": "outcome",
		"valueColumn": "meetings",
	}


def _resolvers():
	"""chart name -> dotted path of the function that builds its data.

	CRM 2.x collects contributed charts itself (``get_contributed_charts``). CRM 1.x
	(the one that runs on Frappe v15) has no such hook, so read this app's own
	``crm_dashboard_charts`` hook, which is the same structure.
	"""
	from crm.api import dashboard as core

	getter = getattr(core, "get_contributed_charts", None)
	charts = getter() if getter else frappe.get_hooks("crm_dashboard_charts", default={})
	return {option["value"]: option["resolver"] for options in (charts or {}).values() for option in options}


@frappe.whitelist()
def get_dashboard(from_date=None, to_date=None, user=None):
	"""CRM's dashboard data, plus the data of charts contributed by apps.

	CRM's own ``get_dashboard`` only fills in its built-in charts by name, so a
	contributed chart that is saved in the dashboard layout would come back
	empty (and crash the number-chart component). Registered in hooks.py through
	``override_whitelisted_methods``.
	"""
	from crm.api import dashboard as core

	layout = core.get_dashboard(from_date, to_date, user)
	if not isinstance(layout, list):
		return layout  # a CRM whose dashboard has another shape: leave it alone
	pending = [item for item in layout if item.get("data") is None and item.get("type") != "spacer"]
	if not pending:
		return layout

	resolvers = _resolvers()

	# the same date range and user scoping CRM applies to its own charts
	if not from_date or not to_date:
		from_date = get_first_day(from_date or nowdate())
		to_date = get_last_day(to_date or nowdate())
	roles = frappe.get_roles(frappe.session.user)
	is_manager = "Sales Manager" in roles or "System Manager" in roles
	if "Sales User" in roles and not is_manager:
		user = frappe.session.user

	for item in pending:
		resolver = resolvers.get(item.get("name"))
		if resolver:
			try:
				item["data"] = frappe.get_attr(resolver)(from_date, to_date, user)
			except Exception:
				frappe.log_error(
					title=f"CRM Add-ons: dashboard chart {item.get('name')} failed",
					message=frappe.get_traceback(),
				)
	return layout
