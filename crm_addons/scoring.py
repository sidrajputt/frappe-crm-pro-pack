"""A 0-100 score for a Lead, worked out from what has happened on it.

It is a rule of thumb, not a prediction: calls that connected, the latest outcome, meetings
held or coming up and how recently anyone touched it push the score up; unanswered calls in a
row, a "not interested" outcome and silence push it down. The rules are the numbers below.
"""

import frappe
from frappe.utils import cint, date_diff, getdate, now_datetime

from crm_addons.utils import REFERENCE_DOCTYPES, get_settings

FIELD = "addons_score"
HOT, WARM = 60, 30

OUTCOME_POINTS = {
	"Interested": 20,
	"Meeting Scheduled": 15,
	"Ask for Detail": 5,
	"Call Back Later": 5,
	"Not Interested": -40,
}


def band(score):
	score = cint(score)
	return "Hot" if score >= HOT else "Warm" if score >= WARM else "Cold"


def compute(reference_doctype, reference_docname):
	calls = frappe.get_all(
		"CRM Follow Up",
		filters={"reference_doctype": reference_doctype, "reference_docname": reference_docname},
		fields=["mode", "call_status", "outcome", "followed_up_on"],
		order_by="followed_up_on desc, creation desc",
		limit_page_length=100,
	)
	meetings = frappe.get_all(
		"CRM Meeting",
		filters={"reference_doctype": reference_doctype, "reference_docname": reference_docname},
		fields=["status", "starts_on", "meeting_outcome"],
		limit_page_length=100,
	)
	now = now_datetime()
	points = 0

	connected = sum(1 for c in calls if c.call_status == "Connected")
	points += min(connected, 3) * 10

	latest_outcome = next((c.outcome for c in calls if c.outcome and c.call_status == "Connected"), None)
	points += OUTCOME_POINTS.get(latest_outcome, 0)

	streak = 0
	for c in calls:
		if c.mode != "Call":
			continue
		if c.call_status == "Connected":
			break
		streak += 1
	points -= 5 * min(streak, 4)

	held = sum(1 for m in meetings if m.status == "Completed" and m.meeting_outcome != "No Show")
	upcoming = any(m.status == "Scheduled" and m.starts_on and m.starts_on >= now for m in meetings)
	points += min(held, 2) * 20 + (10 if upcoming else 0)

	touches = [c.followed_up_on for c in calls if c.followed_up_on] + [m.starts_on for m in meetings if m.starts_on and m.starts_on <= now]
	if touches:
		age = date_diff(getdate(now), getdate(max(touches)))
		points += 10 if age <= 7 else -10 if age > 30 else 0
	return max(0, min(100, points))


def refresh_score(reference_doctype, reference_docname):
	"""Store the score on the Lead (the "Lead Score" column)."""
	if reference_doctype not in REFERENCE_DOCTYPES or not reference_docname:
		return
	if not cint(get_settings().lead_scoring_enabled):
		return
	if not frappe.get_meta(reference_doctype).has_field(FIELD) or not frappe.db.exists(reference_doctype, reference_docname):
		return
	frappe.db.set_value(reference_doctype, reference_docname, FIELD, compute(reference_doctype, reference_docname), update_modified=False)


def refresh_all():
	"""Daily: scores drift as things get older, so recompute every record that has any activity."""
	if not cint(get_settings().lead_scoring_enabled):
		return
	seen = set()
	for table, dt_col, name_col in (("CRM Follow Up", "reference_doctype", "reference_docname"), ("CRM Meeting", "reference_doctype", "reference_docname")):
		for dt, name in frappe.db.sql(f"select distinct {dt_col}, {name_col} from `tab{table}`"):
			seen.add((dt, name))
	for dt, name in seen:
		try:
			refresh_score(dt, name)
		except Exception:
			frappe.log_error(title=f"CRM Add-ons: could not score {dt} {name}", message=frappe.get_traceback())
	frappe.db.commit()
