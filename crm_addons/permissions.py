"""Who can see and change a meeting.

* System Managers, Sales Managers and Administrator: every meeting.
* Everyone else (Sales Users): only meetings they created, organize, or were
  added to as a guest. Only the creator / organizer can edit or cancel.
"""

import frappe

from crm_addons.utils import is_manager


def get_permission_query_conditions(user=None):
	user = user or frappe.session.user
	if is_manager(user):
		return ""

	me = frappe.db.escape(user)
	return (
		"(`tabCRM Meeting`.owner = {me} or `tabCRM Meeting`.organizer = {me} or exists ("
		"select 1 from `tabCRM Meeting Attendee` a where a.parent = `tabCRM Meeting`.name "
		"and a.parenttype = 'CRM Meeting' and a.user = {me}))"
	).format(me=me)


def has_permission(doc, ptype=None, user=None, debug=False):
	user = user or frappe.session.user
	if is_manager(user) or ptype == "create":
		return True

	is_author = user in (doc.owner, doc.get("organizer"))
	if ptype in ("write", "delete", "cancel", "submit", "amend"):
		return is_author

	return is_author or any(row.user == user for row in (doc.get("attendees") or []))


# -- follow-ups: managers see all; everyone else only what they logged or own ---------------------


def get_follow_up_query_conditions(user=None):
	user = user or frappe.session.user
	if is_manager(user):
		return ""
	me = frappe.db.escape(user)
	return f"(`tabCRM Follow Up`.owner = {me} or `tabCRM Follow Up`.assigned_to = {me})"


def has_follow_up_permission(doc, ptype=None, user=None, debug=False):
	user = user or frappe.session.user
	if is_manager(user) or ptype == "create":
		return True
	return user in (doc.owner, doc.get("assigned_to"))
