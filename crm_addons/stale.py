"""Tell the owner about open Leads that nobody has touched for a while."""

import frappe
from frappe import _
from frappe.utils import add_days, cint, escape_html, getdate, now_datetime, nowdate

from crm_addons.notifications import create_record_notification
from crm_addons.utils import get_reference_info, get_settings

FIELD = "addons_stale_alerted_on"

# doctype -> (owner field, status doctype, extra condition)
SOURCES = {
	"CRM Lead": ("lead_owner", "CRM Lead Status", "converted = 0"),
}

# (table, reference doctype column, reference name column, time column)
ACTIVITY = [
	("Comment", "reference_doctype", "reference_name", "creation"),
	("Communication", "reference_doctype", "reference_name", "creation"),
	("CRM Call Log", "reference_doctype", "reference_docname", "creation"),
	("CRM Task", "reference_doctype", "reference_docname", "modified"),
	("FCRM Note", "reference_doctype", "reference_docname", "modified"),
	("CRM Follow Up", "reference_doctype", "reference_docname", "followed_up_on"),
	("CRM Meeting", "reference_doctype", "reference_docname", "modified"),
]


def _last_activity_sql(doctype):
	parts = ["r.modified"]
	for table, dt_col, name_col, time_col in ACTIVITY:
		if not frappe.db.table_exists(table):
			continue
		parts.append(
			f"coalesce((select max(a.`{time_col}`) from `tab{table}` a "
			f"where a.`{dt_col}` = %(dt)s and a.`{name_col}` = r.name), r.modified)"
		)
	return f"greatest({', '.join(parts)})"


def stale_records(doctype, days):
	owner_field, status_doctype, extra = SOURCES[doctype]
	cutoff = add_days(now_datetime(), -days)
	return frappe.db.sql(
		f"""select r.name, r.`{owner_field}` as owner_user, {_last_activity_sql(doctype)} as last_activity,
			r.`{FIELD}` as alerted_on
		from `tab{doctype}` r join `tab{status_doctype}` s on s.name = r.status
		where s.type in ('Open', 'Ongoing', 'OnHold') and {extra} and r.`{owner_field}` is not null
		having last_activity < %(cutoff)s and (alerted_on is null or alerted_on < date(last_activity))""",
		{"dt": doctype, "cutoff": cutoff},
		as_dict=True,
	)


def send_stale_alerts():
	"""Daily. One alert per quiet spell: it is sent again only after something happens and
	the record goes quiet again."""
	days = cint(get_settings().stale_lead_days)
	if days <= 0:
		return
	today = getdate(nowdate())
	for doctype in SOURCES:
		if not frappe.get_meta(doctype).has_field(FIELD):
			continue
		try:
			rows = stale_records(doctype, days)
		except Exception:
			frappe.log_error(title=f"CRM Add-ons: stale {doctype} check failed", message=frappe.get_traceback())
			continue
		for row in rows:
			try:
				info = get_reference_info(doctype, row.name)
				idle = (today - getdate(row.last_activity)).days
				create_record_notification(
					doctype,
					row.name,
					row.owner_user,
					"<div><b>{0}</b> {1}</div>".format(
						escape_html(info["title"]), escape_html(_("has had no activity for {0} days.").format(idle))
					),
				)
				frappe.db.set_value(doctype, row.name, FIELD, today, update_modified=False)
			except Exception:
				frappe.log_error(title=f"CRM Add-ons: stale alert failed for {row.name}", message=frappe.get_traceback())
	frappe.db.commit()
