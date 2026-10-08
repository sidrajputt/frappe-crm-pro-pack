"""Journey rules: when a step becomes due, and whether a lead should still receive it.

A campaign is a list of steps in order. Every step has a day (days after the campaign starts) and an
optional condition on the *previous* step for the same lead, for example "only if it was read". All
recipient rows of a journey are written when the campaign starts, each with its own ``due_at``; the engine
only claims a row once it is due, and checks the condition at that moment, per lead.
"""

from datetime import datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

from frappe.utils import add_to_date, cint, get_time

CONDITIONS = (
	"",
	"Previous step was sent",
	"Previous step was read or opened",
	"Previous step was not read or opened",
	"Previous step failed or was skipped",
)
SENT = ("Sent", "Delivered", "Read")
IN_FLIGHT = ("Pending", "Sending")
MAX_DAYS = 365
DEFER_MINUTES = 15


def due_at(started_at, day_offset):
	"""None (due now) for day 0, otherwise the start plus N days."""
	days = cint(day_offset)
	return add_to_date(started_at, days=days) if days else None


def judge(condition, previous):
	"""Decide for one lead. ``previous`` is None or {status, email_queue} of the previous step's row.

	Returns ("ok" | "skip" | "defer", reason). "defer" means the previous message is still on its way, so
	the answer is not known yet and the step is looked at again a little later.
	"""
	if not condition:
		return "ok", ""
	status = (previous or {}).get("status")
	handed_to_mailer = bool((previous or {}).get("email_queue"))
	if status in IN_FLIGHT or (status == "Queued" and not handed_to_mailer):
		return "defer", ""
	sent = status in SENT or (status == "Queued" and handed_to_mailer)
	read = status == "Read"
	met = {
		"Previous step was sent": sent,
		"Previous step was read or opened": read,
		"Previous step was not read or opened": sent and not read,
		"Previous step failed or was skipped": not sent,
	}.get(condition)
	if met is None:
		return "skip", f"Unknown condition: {condition}"
	return ("ok", "") if met else ("skip", f"Condition not met: {condition[0].lower()}{condition[1:]} was false for this lead")


# -- sending hours -------------------------------------------------------------------------------------------

DEFAULT_START, DEFAULT_END = time(9, 0), time(18, 0)


def _clock(value, default):
	try:
		return get_time(value) if value else default
	except Exception:
		return default


def window_of(campaign):
	"""``None`` when the campaign sends at any hour, otherwise ``(start, end, weekdays_only, tzinfo)``."""
	if not cint(campaign.get("window_enabled")):
		return None
	try:
		tz = ZoneInfo(campaign.get("timezone") or "UTC")
	except Exception:
		tz = timezone.utc
	return (
		_clock(campaign.get("window_start"), DEFAULT_START),
		_clock(campaign.get("window_end"), DEFAULT_END),
		bool(cint(campaign.get("window_weekdays_only"))),
		tz,
	)


def _day_ok(day, weekdays_only):
	return not weekdays_only or day.weekday() < 5


def window_open(campaign, now_utc=None):
	"""May this campaign send right now? Judged in the campaign's own time zone."""
	window = window_of(campaign)
	if not window:
		return True
	start, end, weekdays_only, tz = window
	local = (now_utc or datetime.now(timezone.utc)).astimezone(tz)
	return _day_ok(local, weekdays_only) and start <= local.time().replace(tzinfo=None) < end


def next_open(campaign, now_utc=None):
	"""When the sending hours next begin (a timezone-aware datetime), or None when there is no window or it is open now."""
	window = window_of(campaign)
	if not window or window_open(campaign, now_utc):
		return None
	start, _end, weekdays_only, tz = window
	local = (now_utc or datetime.now(timezone.utc)).astimezone(tz)
	for add in range(0, 9):
		day = local + timedelta(days=add)
		candidate = datetime.combine(day.date(), start, tzinfo=tz)
		if candidate > local and _day_ok(candidate, weekdays_only):
			return candidate
	return None
