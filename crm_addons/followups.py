"""Follow-ups: every call attempt on a Lead, what came of it, and when to follow up next.

An entry is one contact attempt (usually a call). "Attempt" counts the calls in a row that
nobody picked up, and starts again after a connected call. The newest entry with a next
follow-up date is the one that is "open"; logging a newer entry closes the older one.
"""

import frappe
from frappe import _
from frappe.utils import add_days, cint, escape_html, get_datetime, getdate, now_datetime, nowdate

from crm_addons import notifications, scoring
from crm_addons.api import _check_reference
from crm_addons.utils import (
	REFERENCE_DOCTYPES,
	get_reference_info,
	get_settings,
	is_manager,
	link_html,
	user_details,
)

DOCTYPE = "CRM Follow Up"
CONNECTED = "Connected"
UNANSWERED = {"Did Not Pick": "Did Not Pick", "Did Not Connect": "Did Not Connect"}
MISSED = tuple(UNANSWERED)

# read-only summary columns kept on the Lead (list columns, Kanban card fields)
F_LAST_OUTCOME = "addons_last_outcome"
F_LAST_REMARK = "addons_last_remark"
F_ATTEMPT = "addons_call_attempts"
FIELDS = [
	"name",
	"reference_doctype",
	"reference_docname",
	"followed_up_on",
	"mode",
	"assigned_to",
	"call_status",
	"attempt_no",
	"outcome",
	"remark",
	"next_follow_up_on",
	"next_closed",
	"owner",
	"creation",
]
EDITABLE = ("followed_up_on", "mode", "outcome", "remark", "next_follow_up_on", "assigned_to")


# -- rules --------------------------------------------------------------------------------


def _enabled():
	return cint(get_settings().enable_follow_ups)


def call_result(outcome):
	"""Did the call reach the person? "Did Not Pick" / "Did Not Connect" did not; every other outcome did."""
	return UNANSWERED.get(outcome, CONNECTED)


def attempt_number(doc):
	"""How many calls in a row, this one included, have been made without a connect."""
	if doc.mode != "Call":
		return 0
	rows = frappe.get_all(
		DOCTYPE,
		filters={"reference_doctype": doc.reference_doctype, "reference_docname": doc.reference_docname, "mode": "Call"},
		fields=["call_status"],
		order_by="followed_up_on desc, creation desc",
	)
	streak = 0
	for row in rows:
		if row.call_status == CONNECTED:
			break
		streak += 1
	return streak + 1


def refresh_next_follow_up(reference_doctype, reference_docname):
	"""Keep the read-only "Next Follow-up" column on the Lead list up to date."""
	if reference_doctype not in REFERENCE_DOCTYPES or not reference_docname:
		return
	if not frappe.get_meta(reference_doctype).has_field("next_follow_up_on"):
		return
	if not frappe.db.exists(reference_doctype, reference_docname):
		return
	nxt = frappe.db.sql(
		"""select min(next_follow_up_on) from `tabCRM Follow Up`
		where reference_doctype = %s and reference_docname = %s
		and next_closed = 0 and next_follow_up_on is not null""",
		(reference_doctype, reference_docname),
	)[0][0]
	last = frappe.db.get_value(
		DOCTYPE,
		{"reference_doctype": reference_doctype, "reference_docname": reference_docname, "mode": "Call"},
		["outcome", "remark", "attempt_no"],
		order_by="followed_up_on desc, creation desc",
		as_dict=True,
	)
	meta = frappe.get_meta(reference_doctype)
	values = {"next_follow_up_on": nxt}
	values[F_LAST_OUTCOME] = last.outcome if last else None
	values[F_LAST_REMARK] = ((last.remark or "")[:140] or None) if last else None
	values[F_ATTEMPT] = last.attempt_no if last else None
	values = {k: v for k, v in values.items() if meta.has_field(k)}
	frappe.db.set_value(reference_doctype, reference_docname, values, update_modified=False)
	scoring.refresh_score(reference_doctype, reference_docname)


def _post_comment(reference_doctype, reference_docname, html):
	frappe.get_doc(
		{
			"doctype": "Comment",
			"comment_type": "Comment",
			"reference_doctype": reference_doctype,
			"reference_name": reference_docname,
			"content": html,
		}
	).insert(ignore_permissions=True)


def post_timeline_comment(doc):
	"""A comment on the Lead so the follow-up shows up in its activity."""
	head = _("Follow-up") + (f" ({_('attempt')} {doc.attempt_no})" if doc.mode == "Call" and doc.attempt_no else "")
	lines = [f"\U0001f4de <b>{escape_html(head)}:</b> {escape_html(_(doc.outcome or doc.mode))}"]
	if doc.remark:
		lines.append(escape_html(doc.remark))
	if doc.next_follow_up_on:
		lines.append(
			f"{escape_html(_('Next follow-up'))}: {escape_html(get_datetime(doc.next_follow_up_on).strftime('%a, %d %b %Y, %I:%M %p'))}"
		)
	_post_comment(doc.reference_doctype, doc.reference_docname, "<br>".join(lines))


# -- notifications --------------------------------------------------------------------------------


def _notify(doc, to_user, text, kind):
	if not frappe.db.exists("DocType", "CRM Notification") or not to_user or not frappe.db.exists("User", to_user):
		return
	try:
		frappe.get_doc(
			{
				"doctype": "CRM Notification",
				"type": notifications._notification_type(kind),
				"from_user": doc.owner,
				"to_user": to_user,
				"reference_doctype": doc.reference_doctype,
				"reference_name": doc.reference_docname,
				"notification_type_doctype": DOCTYPE,
				"notification_type_doc": str(doc.name),
				"notification_text": text,
			}
		).insert(ignore_permissions=True)
	except Exception:
		frappe.log_error(title="CRM Add-ons: could not create a follow-up notification", message=frappe.get_traceback())


def _managers():
	users = frappe.get_all("Has Role", filters={"role": "Sales Manager", "parenttype": "User"}, pluck="parent")
	return {u for u in users if u not in ("Administrator", "Guest") and frappe.db.get_value("User", u, "enabled")}


def escalate_if_needed(doc):
	"""After N unanswered calls in a row: leave a note, tell the owner and managers, and
	optionally move the Lead to an "unreachable" status."""
	settings = get_settings()
	limit = cint(settings.escalate_after_attempts)
	if not limit or doc.mode != "Call" or doc.call_status == CONNECTED or cint(doc.attempt_no) != limit:
		return

	info = get_reference_info(doc.reference_doctype, doc.reference_docname)
	_post_comment(
		doc.reference_doctype,
		doc.reference_docname,
		"⚠️ <b>{0}</b>".format(escape_html(_("No answer after {0} calls in a row.").format(limit))),
	)
	text = "<div><b>{0}</b> {1}</div>".format(
		escape_html(info["title"]), escape_html(_("has not picked up after {0} calls.").format(limit))
	)
	for user in ({info["owner"], doc.assigned_to} | _managers()) - {None}:
		_notify(doc, user, text, "escalation")

	status = settings.unreachable_lead_status
	if status and doc.reference_doctype == "CRM Lead":
		try:
			lead = frappe.get_doc("CRM Lead", doc.reference_docname)
			if lead.status != status:
				lead.status = status
				lead.save(ignore_permissions=True)
		except Exception:
			frappe.log_error(title="CRM Add-ons: could not update the lead status", message=frappe.get_traceback())


def send_due_reminders():
	"""Every 5 minutes: tell the owner about follow-ups that have come due."""
	settings = get_settings()
	if not cint(settings.enable_follow_ups) or not cint(settings.follow_up_reminders):
		return
	names = frappe.get_all(
		DOCTYPE,
		filters={"next_closed": 0, "reminded": 0, "next_follow_up_on": ["<=", now_datetime()]},
		pluck="name",
		limit_page_length=200,
	)
	for name in names:
		try:
			doc = frappe.get_doc(DOCTYPE, name)
			doc.db_set("reminded", 1, update_modified=False)
			user = doc.assigned_to or doc.owner
			info = get_reference_info(doc.reference_doctype, doc.reference_docname)
			when = get_datetime(doc.next_follow_up_on).strftime("%a, %d %b %Y, %I:%M %p")
			_notify(
				doc,
				user,
				"<div><b>{0}</b>: {1}<br>{2}</div>".format(
					escape_html(_("Follow-up due")), escape_html(info["title"]), escape_html(when)
				),
				"reminder",
			)
			frappe.db.commit()  # the in-app reminder stands even if the email below cannot be sent
			email = user_details(user)[0]
			if email and cint(settings.email_reminders):
				link = link_html(info["url"], info["title"]) if info["url"] else escape_html(info["title"])
				try:
					frappe.sendmail(
						recipients=[email],
						subject=_("Follow-up due: {0}").format(info["title"]),
						message=f"<p>{escape_html(_('A follow-up is due'))}: {link}<br>{escape_html(when)}</p>"
						+ (f"<p>{escape_html(doc.remark)}</p>" if doc.remark else ""),
					)
					frappe.db.commit()
				except Exception:
					frappe.db.rollback()
					frappe.log_error(
						title=f"CRM Add-ons: follow-up reminder email failed for {name}",
						message=frappe.get_traceback(),
					)
		except Exception:
			frappe.db.rollback()
			frappe.log_error(title=f"CRM Add-ons: follow-up reminder failed for {name}", message=frappe.get_traceback())


# -- serialising --------------------------------------------------------------------------------------


def _dt(value):
	return get_datetime(value).strftime("%Y-%m-%d %H:%M:%S") if value else None


def _can_edit(row, user=None):
	user = user or frappe.session.user
	return is_manager(user) or user in (row.get("owner"), row.get("assigned_to"))


def _decorate(rows):
	cache, out = {}, []
	for row in rows:
		key = (row["reference_doctype"], row["reference_docname"])
		if key not in cache:
			cache[key] = get_reference_info(*key)
		info = cache[key]
		out.append(
			{
				**row,
				"followed_up_on": _dt(row["followed_up_on"]),
				"next_follow_up_on": _dt(row.get("next_follow_up_on")),
				"creation": _dt(row.get("creation")),
				"by": user_details(row.get("owner"))[1] or row.get("owner"),
				"assigned_name": user_details(row.get("assigned_to"))[1] or row.get("assigned_to"),
				"reference_title": info["title"],
				"reference_url": info["url"],
				"can_edit": _can_edit(row),
			}
		)
	return out


def _get(name, ptype="read"):
	if not frappe.db.exists(DOCTYPE, name):
		frappe.throw(_("This follow-up no longer exists."), frappe.DoesNotExistError)
	doc = frappe.get_doc(DOCTYPE, name)
	doc.check_permission(ptype)
	return doc


def _summary(items):
	"""``items`` newest first."""
	streak, calls, last_status = 0, 0, None
	counting = True
	for row in items:
		if row["mode"] != "Call":
			continue
		calls += 1
		last_status = last_status or row["call_status"]
		if counting and row["call_status"] == CONNECTED:
			counting = False
		elif counting:
			streak += 1
	open_row = next((r for r in items if not r["next_closed"] and r["next_follow_up_on"]), None)
	return {"next": open_row, "streak": streak, "calls": calls, "last_status": last_status}


def _for_record(reference_doctype, reference_docname):
	rows = frappe.get_list(
		DOCTYPE,
		filters={"reference_doctype": reference_doctype, "reference_docname": reference_docname},
		fields=FIELDS,
		order_by="followed_up_on desc, creation desc",
		limit_page_length=200,
	)
	items = _decorate(rows)
	score = None
	if frappe.get_meta(reference_doctype).has_field(scoring.FIELD):
		score = frappe.db.get_value(reference_doctype, reference_docname, scoring.FIELD)
	return {
		"items": items,
		"summary": _summary(items),
		"can_delete": is_manager(),
		"score": score,
		"score_band": scoring.band(score) if score is not None else None,
	}


# -- whitelisted API ------------------------------------------------------------------------------------


@frappe.whitelist()
def get_config():
	meta = frappe.get_meta(DOCTYPE)
	templates = frappe.get_all(
		"CRM Follow Up Template",
		filters={"enabled": 1},
		fields=["name", "title", "outcome", "remark", "next_follow_up_after_hours"],
		order_by="title asc",
	)
	return {
		"enabled": _enabled(),
		"templates": templates,
		"whatsapp": _whatsapp_ready(),
		"missed_call_text": get_settings().missed_call_whatsapp_text or "",
		"outcomes": [o for o in (meta.get_field("outcome").options or "").split("\n") if o],
		"missed_outcomes": list(MISSED),
		"escalate_after": cint(get_settings().escalate_after_attempts),
		"user": frappe.session.user,
		"is_manager": is_manager(),
	}


@frappe.whitelist()
def get_form_data(reference_doctype, reference_name, name=None):
	"""Everything the follow-up form needs: options, the Lead's current status, team members,
	the attempt this will be, and (when editing) the entry."""
	_check_reference(reference_doctype, reference_name)
	info = get_reference_info(reference_doctype, reference_name)
	record = _for_record(reference_doctype, reference_name)
	entry = None
	if name:
		_get(name, "write")
		entry = next((i for i in record["items"] if str(i["name"]) == str(name)), None)
	return {
		"config": get_config(),
		"record": {
			"doctype": reference_doctype,
			"name": reference_name,
			"title": info["title"],
			"status": frappe.db.get_value(reference_doctype, reference_name, "status"),
		},
		"statuses": frappe.get_all("CRM Lead Status", fields=["name", "color"], order_by="position asc"),
		"entry": entry,
		"streak": record["summary"]["streak"],
	}


@frappe.whitelist()
def list_follow_ups(reference_doctype, reference_name):
	_check_reference(reference_doctype, reference_name)
	return _for_record(reference_doctype, reference_name)


@frappe.whitelist()
def save_follow_up(data):
	"""Log a follow-up (or edit one when ``data.name`` is given)."""
	if not _enabled():
		frappe.throw(_("Follow-ups are switched off in CRM Addons Settings."))
	data = frappe.parse_json(data)
	if data.get("name"):
		doc = _get(data["name"], "write")
	else:
		_check_reference(data.get("reference_doctype"), data.get("reference_docname"))
		doc = frappe.new_doc(DOCTYPE)
		doc.reference_doctype = data["reference_doctype"]
		doc.reference_docname = data["reference_docname"]
	if data.get("lead_status") and doc.reference_doctype == "CRM Lead":
		_set_lead_status(doc.reference_docname, data["lead_status"])
	for field in EDITABLE:
		if field in data:
			doc.set(field, data[field] or None)
	doc.save() if data.get("name") else doc.insert()
	return _for_record(doc.reference_doctype, doc.reference_docname)


def _set_lead_status(lead_name, status):
	"""The follow-up form can move the Lead to another status; CRM logs the change itself."""
	if not frappe.db.exists("CRM Lead Status", status):
		frappe.throw(_("Unknown lead status: {0}").format(status))
	lead = frappe.get_doc("CRM Lead", lead_name)
	if lead.status == status:
		return
	lead.check_permission("write")
	lead.status = status
	lead.save()


@frappe.whitelist()
def complete_follow_up(name):
	"""Mark the next follow-up as done without logging anything new."""
	doc = _get(name, "write")
	doc.db_set("next_closed", 1)
	refresh_next_follow_up(doc.reference_doctype, doc.reference_docname)
	return _for_record(doc.reference_doctype, doc.reference_docname)


@frappe.whitelist()
def delete_follow_up(name):
	doc = _get(name, "delete")
	dt, dn = doc.reference_doctype, doc.reference_docname
	frappe.delete_doc(DOCTYPE, name)
	return _for_record(dt, dn)


@frappe.whitelist()
def get_queue(scope="mine", reference_doctype=None):
	"""Open follow-ups that have a next date: overdue, due today and coming up."""
	filters = [["next_closed", "=", 0], ["next_follow_up_on", "is", "set"]]
	if scope != "all" or not is_manager():
		filters.append(["assigned_to", "=", frappe.session.user])
	if reference_doctype in REFERENCE_DOCTYPES:
		filters.append(["reference_doctype", "=", reference_doctype])

	rows = frappe.get_list(
		DOCTYPE,
		filters=filters,
		fields=FIELDS,
		order_by="next_follow_up_on asc",
		limit_page_length=300,
	)
	now = now_datetime()
	tomorrow = get_datetime(add_days(getdate(nowdate()), 1))
	counts = {"overdue": 0, "today": 0, "upcoming": 0}
	items = _decorate(rows)
	for item in items:
		due = get_datetime(item["next_follow_up_on"])
		bucket = "overdue" if due < now else "today" if due < tomorrow else "upcoming"
		item["bucket"] = bucket
		counts[bucket] += 1
	return {"items": items, "counts": counts}


# -- WhatsApp after a missed call ------------------------------------------------------------------------------


def _whatsapp_ready():
	"""True when CRM's WhatsApp is set up (the frappe_whatsapp app, with a default account)."""
	try:
		from crm.api.whatsapp import is_whatsapp_enabled

		return bool(is_whatsapp_enabled())
	except Exception:
		return False


def _phone_for(reference_doctype, reference_docname):
	row = frappe.db.get_value(reference_doctype, reference_docname, ["mobile_no", "phone"], as_dict=True) or {}
	return (row.get("mobile_no") or row.get("phone") or "").strip()


@frappe.whitelist()
def send_missed_call_whatsapp(reference_doctype, reference_name, message):
	"""Send a WhatsApp message to the Lead through CRM's own WhatsApp integration."""
	_check_reference(reference_doctype, reference_name)
	if not _whatsapp_ready():
		frappe.throw(_("WhatsApp is not set up in CRM."))
	message = (message or "").strip()
	if not message:
		frappe.throw(_("Write the WhatsApp message first."))
	number = _phone_for(reference_doctype, reference_name)
	if not number:
		frappe.throw(_("This record has no mobile number to send a WhatsApp message to."))

	from crm.api.whatsapp import create_whatsapp_message

	name = create_whatsapp_message(reference_doctype, reference_name, message, number, "", "")
	return {"message": name, "to": number}
