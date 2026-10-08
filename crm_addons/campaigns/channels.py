"""Sending adapters. The engine is channel-agnostic; each adapter turns one recipient row into one
message using infrastructure that already exists:

* Email    -> a Communication on the Lead plus Frappe's Email Queue (``frappe.sendmail``).
* WhatsApp -> a ``WhatsApp Message`` from the frappe_whatsapp app, which sends to Meta itself.

Nothing here calls Meta or an SMTP server directly.
"""

import json

import frappe
from frappe import _
from frappe.utils import cstr, get_datetime

from crm_addons.campaigns import guard, optout, personalization, tracking
from crm_addons.campaigns.common import (
	WA_MARKER,
	check_attachment_size,
	email_account_problem,
	files_for_urls,
	parse_url_list,
	default_whatsapp_account,
	normalize_whatsapp,
	settings,
	valid_email,
	whatsapp_installed,
)


def _plain_text(html):
	try:
		from frappe.core.utils import html2text

		return html2text(html)
	except Exception:
		return frappe.utils.strip_html(html)


class ChannelError(Exception):
	"""A send that failed. ``retryable`` is only true when the provider certainly did not take it."""

	def __init__(self, message, retryable=False, code=""):
		super().__init__(message)
		self.retryable = retryable
		self.code = code


class Skip(Exception):
	"""The recipient is no longer eligible. Not a failure."""


# Errors that prove the message was NOT accepted (so a retry cannot duplicate it).
_SAFE_TO_RETRY = (
	"rate limit", "too many", "throughput", "131056", "130429", "80007", "temporarily", "try again later",
	"failed to establish", "connection refused", "name or service not known", "max retries exceeded",
)


def classify(error):
	text = cstr(error).lower()
	return any(token in text for token in _SAFE_TO_RETRY)


class Sender:
	channel = ""

	def check_ready(self, step):
		"""Raise a clear message if the step cannot be sent. Run before launch."""

	def address(self, lead):
		raise NotImplementedError

	def revalidate(self, recipient, lead):
		"""Last check at send time (the audience was resolved earlier). Raise Skip."""

	def send(self, campaign, step, recipient, lead):
		raise NotImplementedError

	def preview(self, campaign, step, lead):
		raise NotImplementedError


class EmailSender(Sender):
	channel = "Email"

	def _template(self, step):
		name = step.get("email_template")
		if not name or not frappe.db.exists("CRM Campaign Email Template", name):
			frappe.throw(_("Choose an email template for the Email step."))
		doc = frappe.get_cached_doc("CRM Campaign Email Template", name)
		if not doc.enabled:
			frappe.throw(_("Email template {0} is inactive.").format(frappe.bold(name)))
		return doc

	def attachment_files(self, tpl, step):
		"""Files sent with this email: those attached to the template plus the ones chosen on the step."""
		files = frappe.get_all(
			"File", filters={"attached_to_doctype": tpl.doctype, "attached_to_name": tpl.name},
			fields=["name", "file_url", "file_name", "file_size"],
		)
		have = {f.name for f in files}
		for f in files_for_urls(parse_url_list(step.get("attachments"))):
			if f.name not in have:
				files.append(f)
				have.add(f.name)
		return files

	def check_ready(self, step):
		tpl = self._template(step)
		check_attachment_size(self.attachment_files(tpl, step))
		problem = email_account_problem()
		if problem:
			frappe.throw(problem)

	def address(self, lead):
		return valid_email(lead.get("email"))

	def revalidate(self, recipient, lead):
		email = self.address(lead)
		if not email:
			raise Skip(_("The lead no longer has a valid email"))
		if email != recipient.email:
			raise Skip(_("The lead's email changed after the audience was built"))
		if optout.is_opted_out("Email", email):
			raise Skip(_("Opted out"))

	def render(self, campaign, step, lead):
		tpl = self._template(step)
		context = personalization.build_context(lead, campaign)
		subject = personalization.render(tpl.subject, context)
		html = personalization.render(tpl.body_html, context, html=True)
		text = personalization.render(tpl.body_text, context) if tpl.body_text else None
		return tpl, subject, html, text

	def preview(self, campaign, step, lead):
		_tpl, subject, html, text = self.render(campaign, step, lead)
		return {"channel": "Email", "subject": subject, "html": html, "text": text or _plain_text(html)}

	def send(self, campaign, step, recipient, lead):
		tpl, subject, html, text = self.render(campaign, step, lead)
		if not subject or not html:
			raise ChannelError(_("The email is empty after personalization."))
		owner_email = frappe.db.get_value("User", campaign.get("campaign_owner") or campaign.owner, "email")
		try:
			files = self.attachment_files(tpl, step)
			check_attachment_size(files)
		except frappe.ValidationError as exc:
			raise ChannelError(frappe.utils.strip_html(cstr(exc))) from exc
		attachments = [{"fid": f.name} for f in files]
		# the copy kept on the lead keeps the real links; the copy that is mailed carries tracked ones
		mailed = tracking.rewrite_links(html, recipient.name) if tracking.enabled_for(campaign) else html
		comm = frappe.get_doc(
			{
				"doctype": "Communication",
				"communication_type": "Communication",
				"communication_medium": "Email",
				"sent_or_received": "Sent",
				"subject": subject,
				"content": html,
				"recipients": recipient.email,
				"sender": owner_email or frappe.db.get_value("Email Account", {"default_outgoing": 1}, "email_id"),
				"reference_doctype": recipient.recipient_type,
				"reference_name": recipient.recipient_id,
			}
		).insert(ignore_permissions=True)
		try:
			queue = frappe.sendmail(
				recipients=[recipient.email],
				subject=subject,
				message=mailed,
				reference_doctype=recipient.recipient_type,
				reference_name=recipient.recipient_id,
				communication=comm.name,
				attachments=attachments or None,
				reply_to=owner_email,
				unsubscribe_method=optout.UNSUBSCRIBE_METHOD,
				unsubscribe_message=_("Unsubscribe"),
				add_unsubscribe_link=1,
				email_read_tracker_url="/api/method/frappe.core.doctype.communication.email.mark_email_as_seen",
				delayed=True,
			)
		except frappe.OutgoingEmailError as exc:
			# a setup problem, not a bad address: say so plainly instead of logging an "unexpected" error per lead
			raise ChannelError(cstr(email_account_problem() or exc)) from exc
		if not queue:
			# Frappe dropped every recipient, which is what it does for someone who unsubscribed in Frappe.
			raise Skip(_("Frappe's mail system has this address unsubscribed"))
		return {
			"email_queue": queue.name,
			"communication": comm.name,
			"provider_message_id": cstr(queue.get("message_id")),
			"linked_doctype": "Email Queue",
			"linked_doc": queue.name,
			"template": tpl.name,
		}

	def sync(self, rows):
		"""rows: recipient dicts with an email_queue. -> {recipient: {status, ...}} from Frappe's own records."""
		queues = {
			q.name: q
			for q in frappe.get_all(
				"Email Queue",
				filters={"name": ["in", [r.email_queue for r in rows]]},
				fields=["name", "status", "error", "modified", "communication"],
			)
		}
		comms = {
			c.name: c
			for c in frappe.get_all(
				"Communication",
				filters={"name": ["in", [q.communication for q in queues.values() if q.communication]]},
				fields=["name", "delivery_status", "read_by_recipient", "read_by_recipient_on"],
			)
		}
		out = {}
		for r in rows:
			q = queues.get(r.email_queue)
			if not q:
				continue
			update = {}
			if q.status in ("Sent", "Partially Sent"):
				update = {"status": "Sent", "sent_at": q.modified, "provider_status": q.status}
			elif q.status == "Error":
				update = {"status": "Failed", "failure_reason": cstr(q.error)[:500] or "Email Queue error", "provider_status": "Error"}
			comm = comms.get(q.communication)
			if comm:
				if comm.delivery_status in ("Bounced", "Rejected", "Soft-Bounced", "Marked As Spam"):
					update = {"status": "Failed", "failure_reason": f"{comm.delivery_status} (reported by the mail provider)", "provider_status": comm.delivery_status}
				elif comm.delivery_status == "Opened" or comm.read_by_recipient:
					update = {"status": "Read", "sent_at": q.modified, "read_at": comm.read_by_recipient_on or q.modified, "provider_status": "Opened"}
			if update:
				out[r.name] = update
		return out


class WhatsAppSender(Sender):
	channel = "WhatsApp"

	def _template(self, step):
		name = step.get("wa_template")
		if not whatsapp_installed():
			frappe.throw(_("The frappe_whatsapp app is not installed on this site."))
		if not name or not frappe.db.exists("WhatsApp Templates", name):
			frappe.throw(_("Choose a WhatsApp template for the WhatsApp step."))
		return frappe.get_doc("WhatsApp Templates", name)

	def account(self, step):
		account = step.get("wa_account") or default_whatsapp_account()
		if not account or not frappe.db.exists("WhatsApp Account", account):
			frappe.throw(_("No active default outgoing WhatsApp Account is configured."))
		if cstr(frappe.db.get_value("WhatsApp Account", account, "status")).lower() != "active":
			frappe.throw(_("WhatsApp Account {0} is not active.").format(frappe.bold(account)))
		return account

	def check_ready(self, step):
		tpl = self._template(step)
		self.account(step)
		# Meta only accepts approved templates, and frappe_whatsapp keeps Meta's own status string.
		if cstr(tpl.status).upper() != "APPROVED":
			frappe.throw(_("WhatsApp template {0} is {1}, not approved by Meta.").format(frappe.bold(tpl.name), frappe.bold(cstr(tpl.status) or _("not synced"))))
		wanted = personalization.placeholders_in(tpl.template)
		mapping = personalization.parse_variable_map(step.get("variable_map"))
		missing = [n for n in wanted if str(n) not in mapping]
		if missing:
			frappe.throw(_("Map the template variable(s) {0} to Lead fields.").format(", ".join(f"{{{{{n}}}}}" for n in missing)))
		if wanted and not cstr(tpl.sample_values).strip():
			frappe.throw(_("WhatsApp template {0} has variables but no sample values; frappe_whatsapp needs them to send.").format(frappe.bold(tpl.name)))
		unknown = personalization.unknown_variables(*mapping.values())
		if unknown:
			frappe.throw(_("Unknown variable(s) in the mapping: {0}.").format(", ".join(unknown)))

	def address(self, lead):
		return normalize_whatsapp(lead.get("mobile_no") or lead.get("phone"), settings().get("default_country_code"))

	def revalidate(self, recipient, lead):
		number = self.address(lead)
		if not number:
			raise Skip(_("The lead no longer has a valid WhatsApp number"))
		if number != recipient.whatsapp_number:
			raise Skip(_("The lead's number changed after the audience was built"))
		if optout.is_opted_out("WhatsApp", number):
			raise Skip(_("Opted out"))

	def preview(self, campaign, step, lead):
		tpl = self._template(step)
		params, missing = personalization.render_whatsapp_params(step, personalization.build_context(lead, campaign))
		return {
			"channel": "WhatsApp",
			"header": tpl.header, "header_type": cstr(tpl.get("header_type")).upper(), "body": personalization.fill_placeholders(tpl.template, params),
			"footer": tpl.footer, "language": tpl.language_code, "category": tpl.category, "status": tpl.status,
			"missing": missing, "buttons": [b.get("button_label") for b in (tpl.get("buttons") or [])],
		}

	def send(self, campaign, step, recipient, lead):
		tpl = self._template(step)
		account = self.account(step)
		params, missing = personalization.render_whatsapp_params(step, personalization.build_context(lead, campaign))
		if missing:
			raise Skip(_("Template variable(s) {0} are empty for this lead").format(", ".join(missing)))
		doc = frappe.new_doc("WhatsApp Message")
		doc.update(
			{
				"type": "Outgoing",
				"to": recipient.whatsapp_number,
				"message_type": "Template",
				"use_template": 1,
				"template": tpl.name,
				"message": "Template message",
				"content_type": "text",
				"reference_doctype": recipient.recipient_type,
				"reference_name": recipient.recipient_id,
				"whatsapp_account": account,
				"bulk_message_reference": WA_MARKER + recipient.name,
				"status": "Queued",
				"body_param": json.dumps(params) if params else None,
			}
		)
		if step.get("wa_attach"):
			doc.attach = step.wa_attach
		try:
			# frappe_whatsapp sends to Meta in before_insert and sets no timeout, so one unresponsive request would
			# hold this worker until its job limit. Give the call a time limit; a timeout is reported, not retried
			# (Meta may have accepted the message), see ``classify``.
			with guard.http_timeout(connect=10, read=30):
				doc.insert(ignore_permissions=True)
		except Exception as exc:
			raise ChannelError(cstr(exc), retryable=classify(exc)) from exc
		if not doc.message_id:
			raise ChannelError(_("Meta did not return a message id."))
		return {
			"provider_message_id": doc.message_id,
			"linked_doctype": "WhatsApp Message",
			"linked_doc": doc.name,
			"template": tpl.name,
		}


SENDERS = {"Email": EmailSender(), "WhatsApp": WhatsAppSender()}


def get_sender(channel):
	try:
		return SENDERS[channel]
	except KeyError:
		frappe.throw(_("Unknown channel {0}.").format(channel))


# frappe_whatsapp keeps the raw Meta status on WhatsApp Message.status (sent / delivered / read / failed).
WA_STATUS_MAP = {"sent": "Sent", "delivered": "Delivered", "read": "Read", "failed": "Failed"}
