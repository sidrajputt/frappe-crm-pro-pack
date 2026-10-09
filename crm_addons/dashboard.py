"""Charts for the CRM dashboard, contributed through the ``crm_dashboard_charts`` hook.

Every resolver receives ``(from_date, to_date, user)``. CRM passes ``user`` for
sales users (so they only see their own numbers) and ``None`` for managers.
"""

import json

import frappe
from frappe import _
from frappe.utils import add_days, cint, date_diff, get_first_day, get_last_day, getdate, nowdate


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
	span = date_diff(to_date, from_date) + 1  # days in the range, both ends included: the previous period is as long
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
	span = date_diff(to_date, from_date) + 1  # days in the range, both ends included: the previous period is as long
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
	span = date_diff(to_date, from_date) + 1  # days in the range, both ends included: the previous period is as long
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


# -- Lead Nurturing: campaign numbers for the Sales Dashboard -------------------------------------------------

NURTURE_ROLES = ("Sales User", "Sales Manager", "System Manager")
NURTURE_CHANNELS = ("Email", "WhatsApp")
NURTURE_SENT = ("Sent", "Delivered", "Read")
REPLY_WINDOW_DAYS = 14


def _nurture_period(from_date, to_date):
	start = getdate(from_date or add_days(nowdate(), -29))
	end = getdate(to_date or nowdate())
	if end < start:
		start, end = end, start
	if date_diff(end, start) > 366:
		start = add_days(end, -366)
	return start, end


def _nurture_who(user):
	"""The one user whose campaigns to count, or None for every campaign (managers only)."""
	from crm_addons.utils import is_manager

	if not is_manager():
		return frappe.session.user
	return user or None


def _nurture_scope(who):
	"""Same rule as crm_addons.campaigns.permissions: you own the campaign or you run it."""
	if not who:
		return "", {}
	return " and (c.owner = %(who)s or c.campaign_owner = %(who)s)", {"who": who}


def _replied_sql():
	"""SQL that is true for a recipient whose lead wrote back (WhatsApp or email) soon after the send."""
	parts = []
	if frappe.db.exists("DocType", "WhatsApp Message"):
		parts.append(
			"exists (select 1 from `tabWhatsApp Message` w where w.type = 'Incoming' and w.reference_doctype = 'CRM Lead' "
			"and w.reference_name = rp.recipient_id and w.creation > rp.sent_at "
			f"and w.creation <= date_add(rp.sent_at, interval {REPLY_WINDOW_DAYS} day))"
		)
	parts.append(
		"exists (select 1 from `tabCommunication` cm where cm.reference_doctype = 'CRM Lead' "
		"and cm.reference_name = rp.recipient_id and cm.sent_or_received = 'Received' and cm.communication_type = 'Communication' "
		f"and cm.creation > rp.sent_at and cm.creation <= date_add(rp.sent_at, interval {REPLY_WINDOW_DAYS} day))"
	)
	return "(" + " or ".join(parts) + ")"


def _nurture_numbers(start, end, who, replies=True):
	"""Everything that is summed over [start, end]: sends per day and channel, delivery states, failures,
	people reached and (optionally) people who replied."""
	scope, params = _nurture_scope(who)
	params.update({"s": start, "e": add_days(end, 1)})
	sent_where = (
		"from `tabCRM Campaign Recipient` rp join `tabCRM Campaign` c on c.name = rp.campaign "
		"where rp.sent_at >= %(s)s and rp.sent_at < %(e)s and rp.status in ('Sent', 'Delivered', 'Read')" + scope
	)

	rows = frappe.db.sql(
		f"select rp.channel, rp.status, date(rp.sent_at) as day, count(*) as n {sent_where} group by rp.channel, rp.status, day",
		params,
		as_dict=True,
	)
	by_channel = {c: {"sent": 0, "delivered": 0, "read": 0, "failed": 0, "reached": 0, "replied": 0} for c in NURTURE_CHANNELS}
	by_day = {}
	for r in rows:
		if r.channel not in by_channel:
			continue
		ch = by_channel[r.channel]
		ch["sent"] += r.n
		ch["delivered"] += r.n if r.status in ("Delivered", "Read") else 0
		ch["read"] += r.n if r.status == "Read" else 0
		day = by_day.setdefault(str(r.day), {c: 0 for c in NURTURE_CHANNELS})
		day[r.channel] += r.n

	for r in frappe.db.sql(f"select rp.channel, count(distinct rp.recipient_id) as n {sent_where} group by rp.channel", params, as_dict=True):
		if r.channel in by_channel:
			by_channel[r.channel]["reached"] = r.n
	reached = frappe.db.sql(f"select count(distinct rp.recipient_id) {sent_where}", params)[0][0] or 0

	for r in frappe.db.sql(
		"select rp.channel, count(*) as n from `tabCRM Campaign Recipient` rp join `tabCRM Campaign` c on c.name = rp.campaign "
		"where rp.status = 'Failed' and rp.failed_at >= %(s)s and rp.failed_at < %(e)s" + scope + " group by rp.channel",
		params,
		as_dict=True,
	):
		if r.channel in by_channel:
			by_channel[r.channel]["failed"] = r.n

	replied, replied_by_campaign = 0, {}
	if replies and reached:
		cond = _replied_sql()
		replied = frappe.db.sql(f"select count(distinct rp.recipient_id) {sent_where} and rp.recipient_type = 'CRM Lead' and {cond}", params)[0][0] or 0
		for r in frappe.db.sql(
			f"select rp.channel, count(distinct rp.recipient_id) as n {sent_where} and rp.recipient_type = 'CRM Lead' and {cond} group by rp.channel",
			params,
			as_dict=True,
		):
			if r.channel in by_channel:
				by_channel[r.channel]["replied"] = r.n
		replied_by_campaign = {
			r.campaign: r.n
			for r in frappe.db.sql(
				f"select rp.campaign, count(distinct rp.recipient_id) as n {sent_where} and rp.recipient_type = 'CRM Lead' and {cond} group by rp.campaign",
				params,
				as_dict=True,
			)
		}
	return {"channels": by_channel, "by_day": by_day, "reached": reached, "replied": replied, "replied_by_campaign": replied_by_campaign}


def _rate(part, whole):
	return round(part / whole * 100, 1) if whole else None


def _nurture_totals(numbers, tracking, campaigns, optouts):
	ch = numbers["channels"]
	sent = sum(c["sent"] for c in ch.values())
	delivered = ch["WhatsApp"]["delivered"]
	read = ch["WhatsApp"]["read"] + (ch["Email"]["read"] if tracking or ch["Email"]["read"] else 0)
	read_base = ch["WhatsApp"]["sent"] + (ch["Email"]["sent"] if tracking or ch["Email"]["read"] else 0)
	return {
		"campaigns": campaigns,
		"reached": numbers["reached"],
		"sent": sent,
		"delivered": delivered,
		"read": read,
		"replied": numbers["replied"],
		"failed": sum(c["failed"] for c in ch.values()),
		"optouts": optouts,
		# Meta reports delivery for WhatsApp only; Frappe's mail system reports opens only when tracking is on
		"delivered_rate": _rate(delivered, ch["WhatsApp"]["sent"]),
		"read_rate": _rate(read, read_base),
		"reply_rate": _rate(numbers["replied"], numbers["reached"]),
	}


def _count_campaigns(start, end, who):
	"""Campaigns that were created, started or sent something in the period, by status."""
	scope, params = _nurture_scope(who)
	params.update({"s": start, "e": add_days(end, 1)})
	rows = frappe.db.sql(
		"""select c.status, count(*) as n from `tabCRM Campaign` c
		where ((c.creation >= %(s)s and c.creation < %(e)s) or (c.started_at >= %(s)s and c.started_at < %(e)s)
			or exists (select 1 from `tabCRM Campaign Recipient` rp where rp.campaign = c.name
				and rp.sent_at >= %(s)s and rp.sent_at < %(e)s))"""
		+ scope
		+ " group by c.status",
		params,
		as_dict=True,
	)
	return rows


def _count_optouts(start, end, who):
	params = {"s": start, "e": add_days(end, 1)}
	if not who:
		return frappe.db.sql("select count(*) from `tabCRM Campaign Opt Out` where creation >= %(s)s and creation < %(e)s", params)[0][0]
	params["who"] = who
	return frappe.db.sql(
		"""select count(*) from `tabCRM Campaign Opt Out` o where o.creation >= %(s)s and o.creation < %(e)s
		and o.lead in (select rp.recipient_id from `tabCRM Campaign Recipient` rp join `tabCRM Campaign` c on c.name = rp.campaign
			where rp.recipient_type = 'CRM Lead' and (c.owner = %(who)s or c.campaign_owner = %(who)s))""",
		params,
	)[0][0]


@frappe.whitelist()
def get_nurturing(from_date=None, to_date=None, user=None, top_limit=10):
	"""Campaign analytics for the Lead Nurturing view of the Sales Dashboard.

	Managers see every campaign (and can look at one person's); a sales user only sees what comes from
	the campaigns they own or run, whatever ``user`` says. "In the period" means: sent in the period.
	A reply is a message from the lead (WhatsApp or email) within 14 days after a send.
	"""
	frappe.only_for(NURTURE_ROLES)
	from crm_addons.utils import get_settings, is_manager

	start, end = _nurture_period(from_date, to_date)
	who = _nurture_who(user)
	tracking = bool(frappe.db.exists("Email Account", {"enable_outgoing": 1, "track_email_status": 1}))

	status_rows = _count_campaigns(start, end, who)
	campaigns = sum(r.n for r in status_rows)
	numbers = _nurture_numbers(start, end, who)
	totals = _nurture_totals(numbers, tracking, campaigns, _count_optouts(start, end, who))

	span = date_diff(end, start) + 1
	prev_start, prev_end = add_days(start, -span), add_days(start, -1)
	prev_numbers = _nurture_numbers(prev_start, prev_end, who, replies=False)
	previous = _nurture_totals(prev_numbers, tracking, sum(r.n for r in _count_campaigns(prev_start, prev_end, who)), 0)
	previous["reply_rate"] = None

	days = []
	d = start
	while d <= end:
		row = numbers["by_day"].get(str(d), {})
		days.append({"date": str(d), **{c: row.get(c, 0) for c in NURTURE_CHANNELS}})
		d = add_days(d, 1)

	scope, params = _nurture_scope(who)
	params.update({"s": start, "e": add_days(end, 1)})
	top = frappe.db.sql(
		"""select c.name, c.campaign_name, c.status, count(*) as sent,
			sum(rp.status in ('Delivered', 'Read')) as delivered, sum(rp.status = 'Read') as `read`,
			sum(rp.channel = 'Email') as email, sum(rp.channel = 'WhatsApp') as whatsapp,
			count(distinct rp.recipient_id) as reached
		from `tabCRM Campaign Recipient` rp join `tabCRM Campaign` c on c.name = rp.campaign
		where rp.sent_at >= %(s)s and rp.sent_at < %(e)s and rp.status in ('Sent', 'Delivered', 'Read')"""
		+ scope
		+ " group by c.name, c.campaign_name, c.status order by sent desc, c.creation desc limit " + str(max(1, min(cint(top_limit) or 10, 500))),
		params,
		as_dict=True,
	)
	failed_by = {
		r.campaign: r.n
		for r in frappe.db.sql(
			"select rp.campaign, count(*) as n from `tabCRM Campaign Recipient` rp join `tabCRM Campaign` c on c.name = rp.campaign "
			"where rp.status = 'Failed' and rp.failed_at >= %(s)s and rp.failed_at < %(e)s" + scope + " group by rp.campaign",
			params,
			as_dict=True,
		)
	}
	top_campaigns = [
		{
			"name": r.name,
			"campaign_name": r.campaign_name or r.name,
			"status": r.status,
			"sent": cint(r.sent),
			"reached": cint(r.reached),
			"delivered": cint(r.delivered),
			"read": cint(r.read),
			"failed": cint(failed_by.get(r.name)),
			"replied": cint(numbers["replied_by_campaign"].get(r.name)),
			"email": cint(r.email),
			"whatsapp": cint(r.whatsapp),
			"reply_rate": _rate(cint(numbers["replied_by_campaign"].get(r.name)), cint(r.reached)),
		}
		for r in top
	]

	lead_filter = " and l.lead_owner = %(who)s" if who else ""
	nurtured = frappe.db.sql(
		"""select count(distinct rp.recipient_id) from `tabCRM Campaign Recipient` rp
		join `tabCRM Campaign` c on c.name = rp.campaign join `tabCRM Lead` l on l.name = rp.recipient_id
		where rp.recipient_type = 'CRM Lead' and rp.sent_at >= %(s)s and rp.sent_at < %(e)s
		and rp.status in ('Sent', 'Delivered', 'Read') and ifnull(l.converted, 0) = 0"""
		+ scope
		+ lead_filter,
		params,
	)[0][0]
	open_leads = frappe.db.sql(
		"select count(*) from `tabCRM Lead` l where ifnull(l.converted, 0) = 0" + lead_filter, {"who": who}
	)[0][0]
	any_campaign = bool(frappe.db.sql("select 1 from `tabCRM Campaign` c where 1 = 1" + scope + " limit 1", params))

	order = ["Running", "Queued", "Scheduled", "Paused", "Completed", "Draft", "Cancelled", "Failed"]
	counts = {r.status: r.n for r in status_rows}
	return {
		"enabled": bool(cint(get_settings().campaigns_enabled)),
		"scope": {"from": str(start), "to": str(end), "user": who, "is_manager": is_manager()},
		"totals": totals,
		"previous": previous,
		"channels": numbers["channels"],
		"by_day": days,
		"status_counts": [{"status": s, "count": counts[s]} for s in order if counts.get(s)]
		+ [{"status": s, "count": n} for s, n in counts.items() if s not in order and n],
		"top_campaigns": top_campaigns,
		"nurtured": {"nurtured": cint(nurtured), "open_leads": cint(open_leads), "not_nurtured": max(0, cint(open_leads) - cint(nurtured))},
		"tracking": {"email_open": tracking},
		"has_campaigns": any_campaign,
	}


# -- each person's own dashboard layout ---------------------------------------------------------------------------

LAYOUT_VIEWS = ("sales", "campaigns")
LAYOUT_WIDTHS = (2, 3, 4, 6)  # of a 6-column grid: a third, a half, two thirds, the full row
LAYOUT_MAX_ITEMS = 40


def _layout_key(view):
	if view not in LAYOUT_VIEWS:
		frappe.throw(_("Unknown dashboard view."))
	return f"crm_addons_dashboard_{view}"


def _clean_layout(raw):
	"""A layout is ``{kpis: [{id, on}], widgets: [{id, w, on}]}``; anything else in it is dropped, not trusted."""
	import re

	data = frappe.parse_json(raw)
	if not isinstance(data, dict):
		frappe.throw(_("The layout is not valid."))
	ident = re.compile(r"^[a-z0-9_]{1,40}$")

	def items(name, with_width):
		seen, out = set(), []
		for row in (data.get(name) or [])[:LAYOUT_MAX_ITEMS]:
			if not isinstance(row, dict) or not ident.match(str(row.get("id", ""))) or row["id"] in seen:
				continue
			seen.add(row["id"])
			item = {"id": row["id"], "on": 1 if cint(row.get("on", 1)) else 0}
			if with_width:
				item["w"] = cint(row.get("w")) if cint(row.get("w")) in LAYOUT_WIDTHS else 3
			out.append(item)
		return out

	return {"kpis": items("kpis", False), "widgets": items("widgets", True)}


@frappe.whitelist()
def get_layout(view):
	"""The signed-in person's saved layout for ``view`` ("sales" or "campaigns"), or None to use the default."""
	frappe.only_for(NURTURE_ROLES)
	value = frappe.db.get_value("DefaultValue", {"parent": frappe.session.user, "parenttype": "__default", "defkey": _layout_key(view)}, "defvalue")
	try:
		return _clean_layout(value) if value else None
	except Exception:
		return None


@frappe.whitelist()
def save_layout(view, layout):
	frappe.only_for(NURTURE_ROLES)
	clean = _clean_layout(layout)
	frappe.defaults.set_user_default(_layout_key(view), json.dumps(clean), frappe.session.user)
	return clean


@frappe.whitelist()
def reset_layout(view):
	frappe.only_for(NURTURE_ROLES)
	frappe.defaults.clear_default(_layout_key(view), parent=frappe.session.user)
	return None
