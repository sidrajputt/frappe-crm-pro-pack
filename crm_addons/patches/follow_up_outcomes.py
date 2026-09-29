"""Follow-ups used to record a call status (Ringing, No Answer, ...) and a separate outcome.
They now have one Call Outcome (Did Not Pick, Did Not Connect, Interested, ...). Convert the
entries logged so far, and replace the starter templates, which named the old statuses."""

import frappe

OLD_TEMPLATE_TITLES = [
	"Ringing - try again in 2 hours",
	"No answer - try tomorrow",
	"Busy - try in 1 hour",
	"Switched off - try tomorrow",
	"Interested - send details",
	"Call back later",
	"Not interested",
]
NEW_OUTCOMES = {
	"Did Not Pick", "Did Not Connect", "Interested", "Not Interested", "Meeting Scheduled", "Ask for Detail", "Call Back Later",
}
OUTCOME_MAP = {"Send Details": "Ask for Detail", "No Response": "Did Not Pick", "Wrong Number": "Not Interested"}
STATUS_MAP = {"Ringing": "Did Not Pick", "No Answer": "Did Not Pick", "Busy": "Did Not Connect", "Switched Off": "Did Not Connect"}


def execute():
	frappe.reload_doc("follow_ups", "doctype", "crm_follow_up")
	frappe.reload_doc("follow_ups", "doctype", "crm_follow_up_template")

	from crm_addons import followups

	records = set()
	for row in frappe.get_all("CRM Follow Up", fields=["name", "mode", "call_status", "outcome", "reference_doctype", "reference_docname"]):
		if row.mode != "Call" or row.outcome in NEW_OUTCOMES:
			continue
		outcome = OUTCOME_MAP.get(row.outcome) or STATUS_MAP.get(row.call_status) or "Call Back Later"
		frappe.db.set_value(
			"CRM Follow Up",
			row.name,
			{"outcome": outcome, "call_status": followups.call_result(outcome)},
			update_modified=False,
		)
		records.add((row.reference_doctype, row.reference_docname))

	for title in OLD_TEMPLATE_TITLES:
		if frappe.db.exists("CRM Follow Up Template", title):
			frappe.delete_doc("CRM Follow Up Template", title, force=1, ignore_permissions=True)
	frappe.db.set_default("crm_addons_templates_seeded", "")  # the new starters are added on migrate

	# attempt numbers depend on the call results: recompute per record, oldest first
	for dt, name in records:
		rows = frappe.get_all(
			"CRM Follow Up",
			filters={"reference_doctype": dt, "reference_docname": name, "mode": "Call"},
			fields=["name", "call_status"],
			order_by="followed_up_on asc, creation asc",
		)
		streak = 0
		for row in rows:
			streak += 1
			frappe.db.set_value("CRM Follow Up", row.name, "attempt_no", streak, update_modified=False)
			if row.call_status == "Connected":
				streak = 0
