"""Campaign numbers, computed from the recipient rows and showing only what the integrations report."""

import frappe
from frappe import _
from frappe.utils import cint, cstr, now_datetime

from crm_addons.campaigns import roi, tracking
from crm_addons.campaigns.common import CAMPAIGN, CHANNELS, RECIPIENT, activity_clause, cached_read, date_range, whatsapp_installed

SENT_OR_BETTER = ("Sent", "Delivered", "Read")


def email_open_tracking_enabled():
	return bool(frappe.db.exists("Email Account", {"enable_outgoing": 1, "track_email_status": 1}))


def get_analytics(campaign, from_date=None, to_date=None):
	"""Numbers for one campaign. With ``from_date`` / ``to_date`` (whole days, site time zone) only recipients whose
	activity (sent, else failed, else created) falls in the range are counted, in every number, table and chart."""
	rng, rv = activity_clause("r", from_date, to_date)
	rows = frappe.db.sql(
		f"""SELECT r.channel, r.status, IFNULL(r.email_queue,'') <> '' AS handed, COUNT(*) AS n
		FROM `tab{RECIPIENT}` r WHERE r.campaign = %(c)s{rng} GROUP BY r.channel, r.status, handed""",
		{"c": campaign, **rv},
		as_dict=True,
	)
	by = {c: {} for c in CHANNELS}
	for r in rows:
		bucket = by[r.channel]
		bucket["_all"] = bucket.get("_all", 0) + r.n
		bucket[r.status] = bucket.get(r.status, 0) + r.n
		if r.status == "Queued" and r.handed:
			bucket["_handed"] = bucket.get("_handed", 0) + r.n

	later = {
		r.channel: r.n
		for r in frappe.db.sql(
			f"""SELECT r.channel, COUNT(*) AS n FROM `tab{RECIPIENT}` r
			WHERE r.campaign=%(c)s AND r.status='Pending' AND r.due_at > %(now)s{rng} GROUP BY r.channel""",
			{"c": campaign, "now": now_datetime(), **rv}, as_dict=True,
		)
	}
	tracking = email_open_tracking_enabled()
	clicks = click_summary(campaign, from_date, to_date)
	out = {}
	for channel, b in by.items():
		if not b.get("_all"):
			continue
		total = b["_all"]
		sent = sum(b.get(s, 0) for s in SENT_OR_BETTER)
		metrics = [
			("total", _("Recipients"), total),
			("eligible", _("Eligible"), total - b.get("Skipped", 0) - b.get("Cancelled", 0)),
			("skipped", _("Skipped"), b.get("Skipped", 0)),
		]
		waiting = b.get("Pending", 0) + b.get("Queued", 0) + b.get("Sending", 0) - later.get(channel, 0)
		if later.get(channel):
			metrics.append(("later", _("Scheduled for a later day"), later[channel]))
		if channel == "Email":
			metrics += [
				("queued", _("Waiting to be sent"), waiting),
				("sent", _("Sent"), sent),
				("failed", _("Failed"), b.get("Failed", 0)),
			]
			if tracking or b.get("Read"):
				metrics.append(("opened", _("Opened"), b.get("Read", 0)))
			metrics.append(("clicked", _("Clicked a link"), clicks["people"]))
		else:
			metrics += [
				("queued", _("Waiting to be sent"), waiting),
				("sent", _("Sent"), sent),
				("delivered", _("Delivered"), b.get("Delivered", 0) + b.get("Read", 0)),
				("read", _("Read"), b.get("Read", 0)),
				("failed", _("Failed"), b.get("Failed", 0)),
			]
		out[channel] = [{"key": k, "label": label, "value": cint(v)} for k, label, v in metrics]

	skip = frappe.db.sql(
		f"""SELECT r.channel, r.skip_reason AS reason, COUNT(*) AS n FROM `tab{RECIPIENT}` r
		WHERE r.campaign=%(c)s AND r.status='Skipped'{rng} GROUP BY r.channel, r.skip_reason ORDER BY n DESC""",
		{"c": campaign, **rv}, as_dict=True,
	)
	fail = frappe.db.sql(
		f"""SELECT r.channel, r.failure_reason AS reason, COUNT(*) AS n FROM `tab{RECIPIENT}` r
		WHERE r.campaign=%(c)s AND r.status='Failed'{rng} GROUP BY r.channel, r.failure_reason ORDER BY n DESC LIMIT 10""",
		{"c": campaign, **rv}, as_dict=True,
	)
	return {
		"channels": out,
		"steps": _by_step(campaign, tracking, from_date, to_date),
		"replied": replied_counts(campaign, from_date=from_date, to_date=to_date),
		"clicks": clicks,
		"results": roi.results(campaign, from_date, to_date),
		"timeline": _timeline(campaign, from_date, to_date),
		"range": {"from_date": cstr(from_date or ""), "to_date": cstr(to_date or "")},
		"skip_reasons": skip,
		"failure_reasons": fail,
		"notes": {
			"email_open_tracking": tracking,
			"email_delivered": _("Email delivery is not reported by Frappe's mail system, so it is not shown. Clicks are counted by this app, from the links in the email."),
		},
	}


def click_summary(campaign, from_date=None, to_date=None):
	"""Who clicked, how often, and which links (see ``tracking``)."""
	try:
		return tracking.click_report(campaign, from_date, to_date)
	except Exception:  # the report must never take the whole page down (for example before the new tables are migrated)
		frappe.log_error(frappe.get_traceback(), "CRM Campaign: click report failed")
		return {"people": 0, "clicks": 0, "links": []}


def _timeline(campaign, from_date=None, to_date=None):
	"""Messages sent per day (and how many of them were read / failed), from the recipient rows' own timestamps."""
	rng, rv = activity_clause("r", from_date, to_date)
	rows = frappe.db.sql(
		f"""SELECT DATE(r.sent_at) AS d, COUNT(*) AS sent,
			SUM(r.channel='WhatsApp' AND r.status IN ('Delivered','Read')) AS delivered,
			SUM(r.status='Read') AS rd, SUM(r.status='Failed') AS failed
		FROM `tab{RECIPIENT}` r WHERE r.campaign=%(c)s AND r.sent_at IS NOT NULL{rng} GROUP BY DATE(r.sent_at) ORDER BY d""",
		{"c": campaign, **rv}, as_dict=True,
	)
	return [{"date": cstr(r.d), "sent": cint(r.sent), "delivered": cint(r.delivered), "read": cint(r.rd), "failed": cint(r.failed)} for r in rows]


def _by_step(campaign, tracking, from_date=None, to_date=None):
	"""One line per journey step: when it runs, its condition, and how it went."""
	steps = frappe.get_all(
		"CRM Campaign Step", filters={"parent": campaign, "parenttype": "CRM Campaign"},
		fields=["idx", "channel", "day_offset", "condition", "email_template", "wa_template", "paused"], order_by="idx asc",
	)
	counts = {}
	rng, rv = activity_clause("r", from_date, to_date)
	for r in frappe.db.sql(
		f"""SELECT r.step_idx, r.status, SUM(r.due_at > %(now)s) AS later, COUNT(*) AS n FROM `tab{RECIPIENT}` r
		WHERE r.campaign=%(c)s{rng} GROUP BY r.step_idx, r.status""",
		{"now": now_datetime(), "c": campaign, **rv}, as_dict=True,
	):
		row = counts.setdefault(r.step_idx, {})
		row[r.status] = row.get(r.status, 0) + r.n
		if r.status == "Pending":
			row["_later"] = row.get("_later", 0) + cint(r.later)
	out = []
	for st in steps:
		c = counts.get(st.idx, {})
		sent = sum(c.get(x, 0) for x in SENT_OR_BETTER)
		out.append(
			{
				"step": st.idx, "channel": st.channel, "day": cint(st.day_offset), "condition": st.condition or "",
				"template": st.email_template or st.wa_template, "recipients": sum(v for k, v in c.items() if not k.startswith("_")),
				"sent": sent, "read": c.get("Read", 0), "failed": c.get("Failed", 0), "skipped": c.get("Skipped", 0),
				"later": c.get("_later", 0), "paused": bool(cint(st.paused)),
			}
		)
	return out


# -- replies (no stored field: a reply is a later incoming message from the same lead) ------------------------


def replied_counts(campaign, started_at=None, from_date=None, to_date=None):
	"""{"Email": n, "WhatsApp": n}: distinct leads that wrote back after the campaign started.

	A reply to a WhatsApp recipient is an incoming ``WhatsApp Message``; to an email recipient it is a received
	``Communication``. Nothing is guessed: with no start time there is no reply count (zeros).

	Each count looks up the lead's messages once per recipient, and the campaign page and the Reports overview ask for
	it again on every refresh (once per campaign), so a result up to a minute old is reused."""
	started_at = started_at or frappe.db.get_value(CAMPAIGN, campaign, "started_at")
	if not started_at:
		return {"Email": 0, "WhatsApp": 0}
	key = (campaign, cstr(started_at), cstr(from_date), cstr(to_date))
	return cached_read("replied", key, 60, lambda: _replied_counts(campaign, started_at, from_date, to_date))


def _replied_counts(campaign, started_at, from_date, to_date):
	out = {"Email": 0, "WhatsApp": 0}
	sent = "('Sent','Delivered','Read')"
	rng, rv = activity_clause("r", from_date, to_date)
	out["Email"] = cint(
		frappe.db.sql(
			f"""SELECT COUNT(DISTINCT r.recipient_id) FROM `tab{RECIPIENT}` r
			WHERE r.campaign=%(c)s AND r.channel='Email' AND r.status IN {sent}{rng} AND EXISTS (
				SELECT 1 FROM `tabCommunication` c WHERE c.reference_doctype=r.recipient_type AND c.reference_name=r.recipient_id
				AND c.sent_or_received='Received' AND c.communication_type='Communication' AND c.creation > %(since)s)""",
			{"c": campaign, "since": started_at, **rv},
		)[0][0]
	)
	if whatsapp_installed():
		out["WhatsApp"] = cint(
			frappe.db.sql(
				f"""SELECT COUNT(DISTINCT r.recipient_id) FROM `tab{RECIPIENT}` r
				WHERE r.campaign=%(c)s AND r.channel='WhatsApp' AND r.status IN {sent}{rng} AND EXISTS (
					SELECT 1 FROM `tabWhatsApp Message` m WHERE m.reference_doctype=r.recipient_type AND m.reference_name=r.recipient_id
					AND m.type='Incoming' AND m.creation > %(since)s)""",
				{"c": campaign, "since": started_at, **rv},
			)[0][0]
		)
	return out


def _zero():
	return {"recipients": 0, "sent": 0, "delivered": 0, "read_or_opened": 0, "failed": 0, "replied": 0, "opted_out": 0}


def _rate(part, whole):
	return round(100.0 * part / whole, 1) if whole else 0.0


@frappe.whitelist()
def get_overview(from_date=None, to_date=None):
	"""Totals across every campaign the caller may see, optionally for a date range.

	``from_date`` / ``to_date`` are whole days in the site's time zone (the end day is included in full). A recipient
	belongs to the range by its activity: the moment it was sent, else failed, else created. So the totals, the funnel,
	the per-day chart and the comparison table all describe the same messages.

	Returns ``{totals, by_channel, by_day, top_campaigns, status_counts, notes}``. Permissions are the campaign
	list's own: managers see all campaigns, everybody else only theirs. ``delivered`` is only reported for
	WhatsApp (Frappe's mail system does not report email delivery), so it is 0 for Email and ``notes`` says so.
	``read_or_opened`` is WhatsApp read plus email opened (email opens need *Track Email Status*)."""
	from crm_addons.campaigns.api import _check_user

	_check_user()
	visible = frappe.get_list(
		CAMPAIGN, fields=["name", "campaign_name", "status", "started_at", "modified", "creation"], limit_page_length=0, order_by="modified desc"
	)
	status_counts = {}
	for c in visible:
		status_counts[c.status] = status_counts.get(c.status, 0) + 1
	empty = {
		"totals": {"campaigns": len(visible), **_zero()},
		"by_channel": {c: _zero() for c in CHANNELS},
		"by_day": [], "top_campaigns": [], "all_campaigns": [], "status_counts": status_counts,
		"notes": {"email_delivered": _("Frappe's mail system does not report email delivery, so Email delivered is always 0."), "email_open_tracking": email_open_tracking_enabled(), "currency": roi.currency()},
	}
	if not visible:
		return empty
	names = [c.name for c in visible]
	start, end = date_range(from_date, to_date)
	rng, rv = activity_clause("r", from_date, to_date)
	values = {"names": tuple(names), "f": start, "t": end, **rv}

	rows = frappe.db.sql(
		f"""SELECT r.campaign, r.channel, r.status, COUNT(*) AS n FROM `tab{RECIPIENT}` r WHERE r.campaign IN %(names)s{rng}
		GROUP BY r.campaign, r.channel, r.status""",
		values, as_dict=True,
	)
	per = {}  # campaign -> channel -> metrics
	for r in rows:
		m = per.setdefault(r.campaign, {}).setdefault(r.channel, _zero())
		m["recipients"] += r.n
		if r.status in SENT_OR_BETTER:
			m["sent"] += r.n
		if r.channel == "WhatsApp" and r.status in ("Delivered", "Read"):
			m["delivered"] += r.n
		if r.status == "Read":
			m["read_or_opened"] += r.n
		if r.status == "Failed":
			m["failed"] += r.n

	by_name = {c.name: c for c in visible}
	for campaign, chans in per.items():
		replies = replied_counts(campaign, by_name[campaign].started_at, from_date, to_date)
		for ch, m in chans.items():
			m["replied"] = replies.get(ch, 0)

	if start or end:  # the status chart counts campaigns that were created or had messages in the range
		in_range = set(per) | {c.name for c in visible if (not start or cstr(c.creation) >= start) and (not end or cstr(c.creation) < end)}
		empty["status_counts"] = {}
		for c in visible:
			if c.name in in_range:
				empty["status_counts"][c.status] = empty["status_counts"].get(c.status, 0) + 1

	totals, by_channel = {"campaigns": len(per), **_zero()}, {c: _zero() for c in CHANNELS}
	top = []
	for campaign, chans in per.items():
		agg = _zero()
		for ch, m in chans.items():
			for k, v in m.items():
				agg[k] += v
				by_channel[ch][k] += v
				totals[k] += v
		top.append(
			{
				"name": campaign, "title": by_name[campaign].campaign_name, "status": by_name[campaign].status,
				"channel": next(iter(chans)) if len(chans) == 1 else "Multi-channel",
				**{k: agg[k] for k in ("recipients", "sent", "delivered", "failed", "replied")}, "read": agg["read_or_opened"],
				"delivery_rate": _rate(agg["delivered"], agg["sent"]), "read_rate": _rate(agg["read_or_opened"], agg["sent"]),
				"reply_rate": _rate(agg["replied"], agg["sent"]), "failure_rate": _rate(agg["failed"], agg["recipients"]),
			}
		)
	costs = roi.campaign_costs([t["name"] for t in top], from_date, to_date)
	for t in top:
		t["cost"] = round(costs.get(t["name"], 0), 2) if roi.prices_set() else None
	totals["cost"] = round(sum(costs.values()), 2) if roi.prices_set() else None
	top.sort(key=lambda r: (-r["sent"], r["title"] or ""))

	optouts = frappe.db.sql(
		f"""SELECT o.channel, COUNT(*) AS n FROM `tabCRM Campaign Opt Out` o
		WHERE o.source IN ('Unsubscribe Link','WhatsApp Reply') {{dates}}
		AND o.lead IN (SELECT r.recipient_id FROM `tab{RECIPIENT}` r WHERE r.campaign IN %(names)s AND r.channel = o.channel)
		GROUP BY o.channel""".replace(
			"{dates}",
			(" AND o.creation >= %(f)s" if start else "") + (" AND o.creation < %(t)s" if end else ""),
		),
		values, as_dict=True,
	)
	for o in optouts:
		if o.channel in by_channel:
			by_channel[o.channel]["opted_out"] = cint(o.n)
			totals["opted_out"] += cint(o.n)

	day_where = ["r.campaign IN %(names)s", "r.sent_at IS NOT NULL"]
	if start:
		day_where.append("r.sent_at >= %(f)s")
	if end:
		day_where.append("r.sent_at < %(t)s")
	days = frappe.db.sql(
		f"""SELECT DATE(r.sent_at) AS d, COUNT(*) AS sent,
			SUM(r.channel='WhatsApp' AND r.status IN ('Delivered','Read')) AS delivered,
			SUM(r.status='Read') AS rd, SUM(r.status='Failed') AS failed
		FROM `tab{RECIPIENT}` r WHERE {' AND '.join(day_where)} GROUP BY DATE(r.sent_at) ORDER BY d""",
		values, as_dict=True,
	)
	failed_days = frappe.db.sql(
		f"""SELECT DATE(r.failed_at) AS d, COUNT(*) AS n FROM `tab{RECIPIENT}` r
		WHERE r.campaign IN %(names)s AND r.status='Failed' AND r.failed_at IS NOT NULL AND r.sent_at IS NULL
		{"AND r.failed_at >= %(f)s" if start else ""} {"AND r.failed_at < %(t)s" if end else ""} GROUP BY DATE(r.failed_at)""",
		values, as_dict=True,
	)
	by_day = {cstr(d.d): {"date": cstr(d.d), "sent": cint(d.sent), "delivered": cint(d.delivered), "read": cint(d.rd), "failed": cint(d.failed)} for d in days}
	for f in failed_days:
		row = by_day.setdefault(cstr(f.d), {"date": cstr(f.d), "sent": 0, "delivered": 0, "read": 0, "failed": 0})
		row["failed"] += cint(f.n)

	empty.update(
		{
			"totals": totals, "by_channel": by_channel, "by_day": [by_day[k] for k in sorted(by_day)],
			"top_campaigns": top[:10], "all_campaigns": top[:100],
		}
	)
	return empty
