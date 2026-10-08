"""Who sees which campaign. Managers see all; everyone else sees what they own or run."""

import frappe

from crm_addons.utils import is_manager


def campaign_query_conditions(user=None):
	user = user or frappe.session.user
	if is_manager(user):
		return ""
	me = frappe.db.escape(user)
	return f"(`tabCRM Campaign`.owner = {me} or `tabCRM Campaign`.campaign_owner = {me})"


def campaign_has_permission(doc, ptype=None, user=None, debug=False):
	user = user or frappe.session.user
	if is_manager(user) or ptype == "create":
		return True
	return user in (doc.owner, doc.get("campaign_owner"))


def recipient_query_conditions(user=None):
	user = user or frappe.session.user
	if is_manager(user):
		return ""
	me = frappe.db.escape(user)
	return (
		"exists (select 1 from `tabCRM Campaign` c where c.name = `tabCRM Campaign Recipient`.campaign "
		f"and (c.owner = {me} or c.campaign_owner = {me}))"
	)


def recipient_has_permission(doc, ptype=None, user=None, debug=False):
	user = user or frappe.session.user
	if is_manager(user):
		return True
	if ptype not in (None, "read", "report", "export"):
		return False
	owners = frappe.db.get_value("CRM Campaign", doc.campaign, ["owner", "campaign_owner"])
	return bool(owners) and user in owners


def automation_query_conditions(user=None):
	user = user or frappe.session.user
	if is_manager(user):
		return ""
	me = frappe.db.escape(user)
	return f"(`tabCRM Campaign Automation`.owner = {me} or `tabCRM Campaign Automation`.automation_owner = {me})"


def automation_has_permission(doc, ptype=None, user=None, debug=False):
	user = user or frappe.session.user
	if is_manager(user) or ptype == "create":
		return True
	return user in (doc.owner, doc.get("automation_owner"))
