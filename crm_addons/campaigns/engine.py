"""The channel-agnostic campaign engine.

Life of a campaign
------------------
``launch`` -> status Queued -> ``materialise`` writes one recipient row per (step, channel, lead)
-> status Running -> the ``dispatch`` scheduler job (every minute) claims small batches of Pending
rows, hands them to ``send_batch`` workers, and each worker sends through the channel adapters ->
provider callbacks and ``sync_statuses`` move rows forward -> ``Completed``.

Why a message is never sent twice
---------------------------------
* The recipient row has a UNIQUE ``dedupe_key`` (campaign + step + channel + lead), so repeating
  ``launch``, restarting the materialise job or double-clicking creates no second row.
* Every state change is a single guarded ``UPDATE ... WHERE status = <expected>``. Only the worker
  whose update changed one row may send; any other worker (duplicate job, retry, restart) sees zero
  rows changed and stops.
* A row stuck in ``Sending`` after a crash is never re-sent automatically: if the provider's own
  record exists it is recovered from it, otherwise it is marked Failed as "outcome unknown".
* Automatic retries happen only for errors that prove the provider did not accept the message.
"""

import json
import time
from datetime import timezone
from zoneinfo import ZoneInfo

import frappe
from frappe import _
from frappe.utils import add_to_date, cint, cstr, get_datetime, now_datetime

from crm_addons import debuglog
from crm_addons.campaigns import audience, hygiene, journey, personalization, rules
from crm_addons.campaigns.channels import ChannelError, Skip, get_sender
from crm_addons.campaigns.common import (
	ACTIONS,
	CAMPAIGN,
	CHANNELS,
	LEAD,
	RECIPIENT,
	WA_MARKER,
	dedupe_key,
	setting_int,
	user_for,
)
from crm_addons.utils import system_timezone

TRIGGER = "Trigger"  # send_mode of an automatic campaign: it never "finishes", leads join it as they qualify
SEND_CHUNK = 25  # recipients per worker job
STALE_SENDING_MINUTES = 15
STALE_QUEUED_MINUTES = 30
LONG = "long"


def _now():
	return now_datetime()


def _commit():
	frappe.db.commit()  # nosemgrep: frappe-manual-commit -- background job; a claim must be durable before work starts


def _rollback():
	"""Undo a failed send's partial writes. Never rolls back the claim, which was committed first."""
	frappe.db.rollback()


# -- permissions and state ---------------------------------------------------------------------------------


def is_manager(user=None):
	from crm_addons.utils import is_manager as _is_manager

	return _is_manager(user)


def can_act(campaign, user=None):
	"""Managers can act on any campaign; everyone else only on their own."""
	user = user or frappe.session.user
	return is_manager(user) or user in (campaign.owner, campaign.get("campaign_owner"))


def allowed_actions(campaign, user=None):
	actions = set(ACTIONS.get(campaign.status, ()))
	if not can_act(campaign, user):
		actions = {a for a in actions if a in ("analytics", "recipients", "duplicate")}
	return sorted(actions)


def _transition(name, to, allowed_from, **fields):
	"""Atomic status change: True only for the caller that actually moved it."""
	sets = ["status = %(to)s", "modified = %(now)s"] + [f"`{k}` = %({k})s" for k in fields]
	frappe.db.sql(
		f"UPDATE `tab{CAMPAIGN}` SET {', '.join(sets)} WHERE name = %(name)s AND status IN %(frm)s",
		{"to": to, "now": _now(), "name": name, "frm": tuple(allowed_from), **fields},
	)
	changed = frappe.db.sql("SELECT ROW_COUNT()")[0][0] == 1
	frappe.clear_document_cache(CAMPAIGN, name)
	return changed


def _status(name):
	return frappe.db.get_value(CAMPAIGN, name, "status")


def _campaign(name, ptype="read"):
	if not frappe.db.exists(CAMPAIGN, name):
		frappe.throw(_("Campaign {0} was not found.").format(name), frappe.DoesNotExistError)
	doc = frappe.get_doc(CAMPAIGN, name)
	doc.check_permission(ptype)
	return doc


# -- launch ----------------------------------------------------------------------------------------------


def channels_of(campaign):
	return [c for c in CHANNELS if any(s.channel == c for s in campaign.steps)]


def validate_ready(campaign):
	"""Everything that must be true before a campaign may start. Raises with a clear message."""
	if not campaign.steps:
		frappe.throw(_("Add at least one channel with its template."))
	for step in campaign.steps:
		get_sender(step.channel).check_ready(step)
	if campaign.send_mode == TRIGGER:
		if not campaign.trigger_event and not campaign.get("automation"):
			frappe.throw(_("Choose what starts the campaign for a lead."))
		if campaign.audience_mode == "Selected Records":
			frappe.throw(_("An automatic campaign needs filters or a saved segment, not a hand-picked list."))
		audience.build_filters(audience.definition_of(campaign))
		return {"total": 0}  # nobody is enrolled yet: leads join as they qualify
	if campaign.send_mode == "Schedule":
		if not campaign.scheduled_at:
			frappe.throw(_("Choose a date and time to send."))
		if _scheduled_utc(campaign) <= _utcnow():
			frappe.throw(_("The scheduled time is in the past."))
	snapshot = audience.summary(audience.definition_of(campaign), channels_of(campaign), campaign.consent_confirmed)
	if not any(snapshot[c]["eligible"] for c in channels_of(campaign)):
		frappe.throw(_("No lead in this audience can receive this campaign. Check the audience summary."))
	return snapshot


def _utcnow():
	from datetime import datetime

	return datetime.now(timezone.utc)


def _scheduled_utc(campaign):
	tz = ZoneInfo(campaign.timezone or system_timezone())
	return get_datetime(campaign.scheduled_at).replace(tzinfo=tz).astimezone(timezone.utc)


def launch(name):
	"""Validate and start (or schedule) a campaign. Safe to call twice."""
	campaign = _campaign(name, "write")
	if not can_act(campaign):
		frappe.throw(_("Only the campaign owner or a manager can launch it."), frappe.PermissionError)
	if campaign.status not in ("Draft", "Scheduled"):
		frappe.throw(_("This campaign is already {0}.").format(campaign.status))
	snapshot = validate_ready(campaign)
	snapshot_json = json.dumps(snapshot)
	if campaign.send_mode == TRIGGER:
		if not _transition(name, "Running", ("Draft", "Scheduled"), audience_snapshot=snapshot_json, started_at=_now()):
			frappe.throw(_("This campaign is already running."))
		return {"status": "Running"}
	if campaign.send_mode == "Schedule":
		if not _transition(name, "Scheduled", ("Draft", "Scheduled"), audience_snapshot=snapshot_json):
			frappe.throw(_("This campaign changed while you were launching it. Reload and try again."))
		return {"status": "Scheduled"}
	if not _transition(name, "Queued", ("Draft", "Scheduled"), audience_snapshot=snapshot_json, started_at=_now()):
		frappe.throw(_("This campaign is already starting."))
	_enqueue_materialise(name)
	return {"status": "Queued"}


def _enqueue_materialise(name):
	frappe.enqueue(
		"crm_addons.campaigns.engine.materialise",
		queue=LONG,
		timeout=3600,
		job_id=f"crm-campaign-materialise-{name}",
		deduplicate=True,
		enqueue_after_commit=True,
		campaign=name,
	)


def start_scheduled():
	"""Scheduler (every minute): start campaigns whose time has come."""
	for row in frappe.get_all(CAMPAIGN, filters={"status": "Scheduled", "send_mode": "Schedule"}, fields=["name", "scheduled_at", "timezone"]):
		try:
			if _scheduled_utc(row) > _utcnow():
				continue
			if _transition(row.name, "Queued", ("Scheduled",), started_at=_now()):
				_commit()
				frappe.enqueue(
					"crm_addons.campaigns.engine.materialise",
					queue=LONG, timeout=3600, job_id=f"crm-campaign-materialise-{row.name}", deduplicate=True,
					campaign=row.name,
				)
		except Exception:
			frappe.log_error(frappe.get_traceback(), f"CRM Campaign: could not start {row.name}")


# -- materialise: audience -> recipient rows ----------------------------------------------------------------


@debuglog.traced("campaign.materialise")
def materialise(campaign, user=None):
	"""Write the recipient rows, in pages, as the campaign owner (so Lead permissions apply).
	Re-running is harmless: existing rows are skipped by the unique key."""
	doc = frappe.get_doc(CAMPAIGN, campaign)
	acting = user or user_for(doc)
	previous = frappe.session.user
	frappe.set_user(acting)
	try:
		_materialise(doc)
	except Exception:
		_rollback()
		frappe.log_error(frappe.get_traceback(), f"CRM Campaign: audience failed for {campaign}")
		_transition(campaign, "Failed", ("Queued",), status_note=_("Could not build the audience. See the Error Log."), completed_at=_now())
		_commit()
	finally:
		frappe.set_user(previous)


RECIPIENT_COLUMNS = [
	"name", "creation", "modified", "modified_by", "owner", "docstatus", "idx", "campaign", "step_idx", "channel",
	"status", "recipient_type", "recipient_id", "recipient_name", "email", "whatsapp_number", "template",
	"skip_reason", "dedupe_key", "retry_count", "due_at",
]


def recipient_values(doc, per_lead, now, started):
	"""Recipient rows (as value lists for ``RECIPIENT_COLUMNS``) for already evaluated leads: one row per step and lead."""
	values = []
	for row, per in per_lead:
		for idx, step in enumerate(doc.steps, start=1):
			address, reason = per[step.channel]
			template = step.email_template if step.channel == "Email" else step.wa_template
			values.append(
				[
					frappe.generate_hash(length=12), now, now, doc.owner, doc.owner, 0, 0, doc.name, idx, step.channel,
					"Skipped" if reason else "Pending", LEAD, row.name,
					row.get("lead_name") or row.get("first_name") or row.name,
					address if step.channel == "Email" else "", address if step.channel == "WhatsApp" else "",
					template, reason or "", dedupe_key(doc.name, idx, step.channel, row.name), 0,
					journey.due_at(started, step.day_offset),
				]
			)
	return values


def _materialise(doc):
	channels = channels_of(doc)
	evaluator = audience.Evaluator(channels, doc.consent_confirmed)
	now = _now()
	started = doc.started_at or now
	for rows in audience.iter_pages(audience.definition_of(doc)):
		if _status(doc.name) != "Queued":  # cancelled while building
			return
		page_started = time.monotonic()
		values = recipient_values(doc, evaluator.evaluate_page(rows), now, started)
		if values:
			frappe.db.bulk_insert(RECIPIENT, RECIPIENT_COLUMNS, values, ignore_duplicates=True)
		_commit()
		debuglog.log("MATERIALISE page", campaign=doc.name, leads=len(rows), rows=len(values), took=f"{time.monotonic() - page_started:.2f}s")
	total = frappe.db.count(RECIPIENT, {"campaign": doc.name})
	pending = frappe.db.count(RECIPIENT, {"campaign": doc.name, "status": "Pending"})
	if pending:
		_transition(doc.name, "Running", ("Queued",), total_recipients=total)
	else:
		_transition(doc.name, "Completed", ("Queued",), total_recipients=total, completed_at=_now(), status_note=_("Nobody in the audience was eligible."))
	_commit()


# -- dispatch: the scheduler tick --------------------------------------------------------------------------


@debuglog.traced("campaign.dispatch")
def dispatch():
	"""Scheduler (every minute). For each running campaign: recover stuck rows, release due retries,
	claim a rate-limited batch, queue workers, and close the campaign when nothing is left."""
	start_scheduled()
	for name in frappe.get_all(CAMPAIGN, filters={"status": "Running"}, pluck="name"):
		try:
			_dispatch_campaign(frappe.get_doc(CAMPAIGN, name))
		except Exception:
			_rollback()
			frappe.log_error(frappe.get_traceback(), f"CRM Campaign: dispatch failed for {name}")
	_commit()


def _dispatch_campaign(campaign):
	recover_stale(campaign.name)
	if not journey.window_open(campaign):
		# outside the sending hours: nothing is claimed; messages stay Pending until the window opens
		debuglog.log("DISPATCH waiting for the sending hours", campaign=campaign.name, opens=journey.next_open(campaign))
		return
	batch = setting_int(campaign, "batch_size", "campaign_batch_size", 100)
	rate = setting_int(campaign, "rate_per_minute", "campaign_rate_per_minute", 300)
	in_flight = frappe.db.sql(
		f"""SELECT COUNT(*) FROM `tab{RECIPIENT}` WHERE campaign=%s
		AND (status='Sending' OR (status='Queued' AND IFNULL(email_queue,'')=''))""",
		campaign.name,
	)[0][0]
	capacity = min(batch, max(0, rate - in_flight))
	names = []
	if capacity:
		names = _claim(campaign.name, capacity, paused_steps(campaign))
		for i in range(0, len(names), SEND_CHUNK):
			chunk = names[i : i + SEND_CHUNK]
			frappe.enqueue(
				"crm_addons.campaigns.engine.send_batch",
				queue=LONG, timeout=1800, job_id=f"crm-campaign-send-{chunk[0]}", deduplicate=True,
				campaign=campaign.name, names=chunk,
			)
	debuglog.log("DISPATCH", campaign=campaign.name, in_flight=in_flight, capacity=capacity, claimed=len(names), batch=batch, rate_per_minute=rate)
	_finish_if_done(campaign)


def paused_steps(campaign):
	return tuple(s.idx for s in campaign.steps if cint(s.get("paused")))


def _claim(campaign, limit, paused=()):
	"""Move up to ``limit`` Pending rows to Queued in ONE statement and return exactly those rows.
	Rows of a paused step are left alone."""
	token = frappe.generate_hash(length=12)
	now = _now()
	frappe.db.sql(
		f"""UPDATE `tab{RECIPIENT}` SET status='Queued', queued_at=%(now)s, claim_token=%(token)s
		WHERE campaign=%(c)s AND status='Pending' AND (retry_after IS NULL OR retry_after <= %(now)s)
		AND (due_at IS NULL OR due_at <= %(now)s){" AND step_idx NOT IN %(paused)s" if paused else ""}
		ORDER BY step_idx, creation LIMIT %(limit)s""",
		{"now": now, "token": token, "c": campaign, "limit": int(limit), "paused": tuple(paused) or (0,)},
	)
	_commit()
	return frappe.get_all(RECIPIENT, filters={"campaign": campaign, "claim_token": token, "status": "Queued"}, pluck="name", order_by="creation asc")


def _finish_if_done(campaign):
	if campaign.get("send_mode") == TRIGGER:
		return  # an automatic campaign keeps waiting for the next lead; only Cancel ends it
	row = frappe.db.sql(
		f"""SELECT
			SUM(status='Pending'), SUM(status='Sending'),
			SUM(status='Queued' AND IFNULL(email_queue,'')=''),
			SUM(status IN ('Sent','Delivered','Read') OR (status='Queued' AND IFNULL(email_queue,'')<>'')),
			SUM(status='Failed')
		FROM `tab{RECIPIENT}` WHERE campaign=%s""",
		campaign.name,
	)[0]
	pending, sending, claimed, ok, failed = (cint(v) for v in row)
	if pending or sending or claimed:
		return
	if ok == 0 and failed:
		_transition(campaign.name, "Failed", ("Running",), completed_at=_now(), status_note=_("Every message failed. Open the recipient report for the reasons."))
	else:
		_transition(campaign.name, "Completed", ("Running",), completed_at=_now())


# -- workers -------------------------------------------------------------------------------------------------


@debuglog.traced("campaign.send_batch")
def send_batch(campaign, names):
	"""Worker job: send the claimed rows one by one, stopping the moment the campaign is no longer running."""
	rest = list(names)
	try:
		doc = frappe.get_doc(CAMPAIGN, campaign)
		while rest:
			status = _status(campaign)
			if status != "Running":
				_release(rest, status)
				return
			if not journey.window_open(doc):  # the sending hours ended while this batch was going out
				_release(rest, "Paused")
				rest = []
				return
			name = rest.pop(0)
			_send_one(doc, name)
	finally:
		if rest:
			_release(rest, _status(campaign))


def _release(names, campaign_status):
	"""Rows claimed but not started: back to Pending (paused) or Cancelled."""
	to = "Cancelled" if campaign_status in ("Cancelled", "Failed") else "Pending"
	frappe.db.sql(
		f"UPDATE `tab{RECIPIENT}` SET status=%s, claim_token=NULL WHERE name IN %s AND status='Queued' AND IFNULL(email_queue,'')=''",
		(to, tuple(names)),
	)
	_commit()


def _begin(name):
	# "Queued" also means "handed to Frappe's Email Queue", so a row that already has a provider record is
	# never started again: this is what stops a second worker (retry, duplicate job) re-sending an email.
	frappe.db.sql(
		f"""UPDATE `tab{RECIPIENT}` SET status='Sending', started_at=%s
		WHERE name=%s AND status='Queued' AND IFNULL(email_queue,'')='' AND IFNULL(linked_doc,'')=''
		AND IFNULL(provider_message_id,'')=''""",
		(_now(), name),
	)
	won = frappe.db.sql("SELECT ROW_COUNT()")[0][0] == 1
	_commit()
	return won


def _send_one(campaign, name):
	if not _begin(name):
		return  # another worker owns this row, or it was cancelled: do nothing
	rec = frappe.get_doc(RECIPIENT, name)
	step = campaign.steps[rec.step_idx - 1]
	if frappe.db.get_value("CRM Campaign Step", {"parent": campaign.name, "parenttype": CAMPAIGN, "idx": rec.step_idx}, "paused"):
		frappe.db.sql(f"UPDATE `tab{RECIPIENT}` SET status='Pending', claim_token=NULL WHERE name=%s AND status='Sending'", name)
		return _commit()  # the step was paused after this row was claimed: it goes back in line
	sender = get_sender(rec.channel)
	verdict, why = _journey_gate(campaign, step, rec)
	if verdict == "defer":
		frappe.db.sql(
			f"UPDATE `tab{RECIPIENT}` SET status='Pending', claim_token=NULL, due_at=%s WHERE name=%s AND status='Sending'",
			(add_to_date(_now(), minutes=journey.DEFER_MINUTES), name),
		)
		return _commit()
	if verdict == "skip":
		_finish_row(name, "Skipped", skip_reason=why)
		return _commit()
	sent_started = time.monotonic()
	outcome = "sent"
	try:
		if not frappe.db.exists(rec.recipient_type, rec.recipient_id):
			raise Skip(_("The lead was deleted"))
		lead = frappe.get_doc(rec.recipient_type, rec.recipient_id)
		sender.revalidate(rec, lead)
		result = sender.send(campaign, step, rec, lead)
	except Skip as exc:
		outcome = f"skipped: {cstr(exc)}"
		_rollback()
		_finish_row(name, "Skipped", skip_reason=cstr(exc))
	except ChannelError as exc:
		outcome = f"failed: {cstr(exc)}"
		_rollback()
		_fail(campaign, rec, cstr(exc), exc.retryable, exc.code)
	except Exception as exc:
		outcome = f"error: {type(exc).__name__}: {cstr(exc)}"
		_rollback()
		frappe.log_error(frappe.get_traceback(), f"CRM Campaign {campaign.name}: unexpected send error")
		_fail(campaign, rec, cstr(exc), False, "")
	else:
		_link(name, result)
		# An email is only "Queued" until Frappe's mailer sends it; a WhatsApp message Meta accepted is Sent.
		advance(name, "Queued" if rec.channel == "Email" else "Sent", sent_at=None if rec.channel == "Email" else _now())
	_commit()
	took = time.monotonic() - sent_started
	debuglog.log("SEND", "WARN" if took > 5 else "INFO", campaign=campaign.name, channel=rec.channel, step=rec.step_idx, outcome=outcome, took=f"{took:.2f}s")


def _journey_gate(campaign, step, rec):
	"""For follow-up steps: has the lead replied (if the campaign stops on replies), and is the step's
	condition on the previous step met? Returns ("ok" | "skip" | "defer", reason)."""
	if cint(rec.step_idx) <= 1 and not cint(step.day_offset):
		return "ok", ""
	if cint(campaign.get("stop_on_reply")) and _replied(rec, campaign):
		return "skip", _("The lead replied, so the journey stopped for them")
	condition = step.get("condition")
	if not condition:
		return "ok", ""
	previous = frappe.db.get_value(
		RECIPIENT,
		{"campaign": rec.campaign, "recipient_id": rec.recipient_id, "step_idx": cint(rec.step_idx) - 1},
		["status", "email_queue"],
		as_dict=True,
	)
	return journey.judge(condition, previous)


def _replied(rec, campaign):
	"""Did this lead write to us (WhatsApp or email) after the campaign started?"""
	# an automatic campaign has no common start: a lead's own journey starts when the lead was enrolled
	since = rec.get("creation") if campaign.get("send_mode") == TRIGGER else campaign.get("started_at")
	if not since:
		return False
	if frappe.db.exists("DocType", "WhatsApp Message") and frappe.db.exists(
		"WhatsApp Message",
		{"type": "Incoming", "reference_doctype": rec.recipient_type, "reference_name": rec.recipient_id, "creation": [">", since]},
	):
		return True
	return bool(
		frappe.db.exists(
			"Communication",
			{
				"reference_doctype": rec.recipient_type, "reference_name": rec.recipient_id,
				"sent_or_received": "Received", "communication_type": "Communication", "creation": [">", since],
			},
		)
	)


def _fail(campaign, rec, reason, retryable, code):
	max_retries = setting_int(campaign, "max_retries", "campaign_max_retries", 2, minimum=0)
	if retryable and cint(rec.retry_count) < max_retries:
		delay = 5 * (2 ** cint(rec.retry_count))
		frappe.db.sql(
			f"""UPDATE `tab{RECIPIENT}` SET status='Pending', claim_token=NULL, retry_count=retry_count+1,
			retry_after=%s, failure_reason=%s, error_code=%s WHERE name=%s AND status='Sending'""",
			(add_to_date(_now(), minutes=delay), reason[:500], code, rec.name),
		)
	else:
		_finish_row(rec.name, "Failed", failure_reason=reason[:500], error_code=code, failed_at=_now(), retryable=0)
		hygiene.on_failed(rec.name, reason)
		rules.fire(rec.name, "Failed or bounced")


def _finish_row(name, status, **fields):
	sets = ", ".join(f"`{k}` = %({k})s" for k in fields)
	frappe.db.sql(
		f"UPDATE `tab{RECIPIENT}` SET status=%(status)s{', ' + sets if sets else ''} WHERE name=%(name)s AND status IN ('Sending','Queued')",
		{"status": status, "name": name, **fields},
	)


# -- status tracking ------------------------------------------------------------------------------------------

_TIME_FIELD = {"Sent": "sent_at", "Delivered": "delivered_at", "Read": "read_at", "Failed": "failed_at"}
_FIELDS = {
	"sent_at", "delivered_at", "read_at", "failed_at", "provider_status", "failure_reason", "provider_message_id",
	"linked_doctype", "linked_doc", "email_queue", "communication", "template", "error_code",
}


# Which states a row may be in for each move. Forward only; Failed can follow anything not yet failed.
_PRIOR = {
	"Queued": ("Sending",),  # an email handed to Frappe's Email Queue
	"Sent": ("Queued", "Sending"),
	"Delivered": ("Queued", "Sending", "Sent"),
	"Read": ("Queued", "Sending", "Sent", "Delivered"),
	"Failed": ("Queued", "Sending", "Sent", "Delivered"),
}


def advance(name, status, **fields):
	"""Move a recipient forward, never backward. Used by workers, provider webhooks and the sync job,
	so an out-of-order callback cannot undo a newer state. Returns True when the row changed."""
	prior = _PRIOR.get(status)
	if not prior:
		return False
	now = _now()
	values = {"status": status, "now": now, "name": name, "prior": prior}
	sets = ["status = %(status)s"]
	time_field = _TIME_FIELD.get(status)
	if time_field:
		sets.append(f"`{time_field}` = COALESCE(`{time_field}`, %(now)s)")
	if status == "Read":  # a read message was delivered, whatever the provider reported
		sets.append("delivered_at = COALESCE(delivered_at, %(now)s)")
	if status in ("Delivered", "Read"):
		sets.append("sent_at = COALESCE(sent_at, %(now)s)")
	for key, value in fields.items():
		if key not in _FIELDS or value in (None, ""):
			continue
		if key in _TIME_FIELD.values():
			sets.append(f"`{key}` = COALESCE(`{key}`, %({key})s)")
		else:
			sets.append(f"`{key}` = %({key})s")
		values[key] = value
	frappe.db.sql(f"UPDATE `tab{RECIPIENT}` SET {', '.join(sets)} WHERE name = %(name)s AND status IN %(prior)s", values)
	changed = frappe.db.sql("SELECT ROW_COUNT()")[0][0] == 1
	if changed and status in ("Read", "Failed"):
		_after_change(name, status, fields)
	return changed


def _after_change(name, status, fields):
	"""Things that follow a recipient becoming Read or Failed. They never raise into the status update."""
	try:
		if status == "Read":
			rules.fire(name, "Opened or read")
		else:
			hygiene.on_failed(name, fields.get("failure_reason"), fields.get("provider_status"))
			rules.fire(name, "Failed or bounced")
	except Exception:
		frappe.log_error(frappe.get_traceback(), "CRM Campaign: follow-up work after a status change failed")


def _link(name, fields):
	"""Record which provider message a row became. Not guarded by status: a fast webhook may already
	have advanced the row, and the link must never be lost."""
	fields = {k: v for k, v in fields.items() if k in _FIELDS and v}
	if fields:
		sets = ", ".join(f"`{k}` = %({k})s" for k in fields)
		frappe.db.sql(f"UPDATE `tab{RECIPIENT}` SET {sets} WHERE name = %(name)s", {"name": name, **fields})


def on_whatsapp_message_update(doc, method=None):
	"""``doc_events`` hook: frappe_whatsapp's webhook writes Meta's sent/delivered/read/failed onto the
	WhatsApp Message; mirror it onto the campaign recipient in real time."""
	try:
		ref = cstr(doc.get("bulk_message_reference"))
		if not ref.startswith(WA_MARKER):
			return
		from crm_addons.campaigns.channels import WA_STATUS_MAP

		status = WA_STATUS_MAP.get(cstr(doc.get("status")).lower())
		if not status:
			return
		fields = {"provider_status": cstr(doc.status)}
		if status == "Failed":
			fields["failure_reason"] = _wa_failure_reason(doc)
		advance(ref[len(WA_MARKER) :], status, **fields)
	except Exception:
		frappe.log_error(frappe.get_traceback(), "CRM Campaign: could not mirror a WhatsApp status")


def _wa_failure_reason(doc):
	"""frappe_whatsapp stores only the status word; the detail is in its notification log when it has one."""
	return _("Meta reported the message as failed (the webhook gives no further detail).")


@debuglog.traced("campaign.sync_statuses")
def sync_statuses():
	"""Scheduler (every 5 minutes): catch up anything a callback missed, from the providers' own records."""
	cutoff = add_to_date(_now(), days=-7)
	rows = frappe.get_all(
	RECIPIENT,
		filters={"status": ["in", ["Queued", "Sent", "Delivered"]], "channel": "Email", "email_queue": ["is", "set"], "modified": [">", cutoff]},
		fields=["name", "email_queue"],
		limit_page_length=2000,
	)
	if rows:
		for name, update in get_sender("Email").sync(rows).items():
			status = update.pop("status")
			advance(name, status, **update)
	wa = frappe.get_all(
	RECIPIENT,
		filters={"status": ["in", ["Sent", "Delivered"]], "channel": "WhatsApp", "linked_doc": ["is", "set"], "modified": [">", cutoff]},
		fields=["name", "linked_doc"],
		limit_page_length=2000,
	)
	if wa:
		from crm_addons.campaigns.channels import WA_STATUS_MAP

		msgs = {
			m.name: m
			for m in frappe.get_all("WhatsApp Message", filters={"name": ["in", [r.linked_doc for r in wa]]}, fields=["name", "status"])
		}
		for r in wa:
			m = msgs.get(r.linked_doc)
			status = WA_STATUS_MAP.get(cstr(m.status).lower()) if m else None
			if status:
				advance(r.name, status, provider_status=m.status)
	_commit()


def recover_stale(campaign):
	"""Rows a crashed worker left behind. Never re-sends: it recovers from the provider or gives up honestly."""
	cutoff = add_to_date(_now(), minutes=-STALE_SENDING_MINUTES)
	for r in frappe.get_all(RECIPIENT, filters={"campaign": campaign, "status": "Sending", "started_at": ["<", cutoff]}, fields=["name", "channel"]):
		wa = frappe.db.get_value("WhatsApp Message", {"bulk_message_reference": WA_MARKER + r.name}, ["name", "message_id"], as_dict=True) if r.channel == "WhatsApp" and frappe.db.exists("DocType", "WhatsApp Message") else None
		if wa and wa.message_id:
			advance(r.name, "Sent", provider_message_id=wa.message_id, linked_doctype="WhatsApp Message", linked_doc=wa.name, sent_at=_now())
		else:
			debuglog.log("RECOVER a row stuck in Sending (the worker that had it stopped)", "WARN", campaign=campaign, recipient=r.name, channel=r.channel)
			_finish_row(r.name, "Failed", failure_reason=_("The worker stopped while sending. Delivery is unknown, so it was not retried automatically to avoid a duplicate."), failed_at=_now())
	frappe.db.sql(
		f"""UPDATE `tab{RECIPIENT}` SET status='Pending', claim_token=NULL
		WHERE campaign=%s AND status='Queued' AND IFNULL(email_queue,'')='' AND queued_at < %s""",
		(campaign, add_to_date(_now(), minutes=-STALE_QUEUED_MINUTES)),
	)


# -- pause / resume / cancel / retry ---------------------------------------------------------------------------


def pause(name):
	campaign = _campaign(name, "write")
	_require(campaign)
	if not _transition(name, "Paused", ("Running",)):
		frappe.throw(_("Only a running campaign can be paused."))
	return {"status": "Paused"}


def resume(name):
	campaign = _campaign(name, "write")
	_require(campaign)
	if not _transition(name, "Running", ("Paused",)):
		frappe.throw(_("Only a paused campaign can be resumed."))
	return {"status": "Running"}


def cancel(name):
	campaign = _campaign(name, "write")
	_require(campaign)
	if not _transition(name, "Cancelled", ("Scheduled", "Queued", "Running", "Paused"), completed_at=_now()):
		frappe.throw(_("This campaign can no longer be cancelled."))
	frappe.db.sql(
		f"UPDATE `tab{RECIPIENT}` SET status='Cancelled' WHERE campaign=%s AND (status='Pending' OR (status='Queued' AND IFNULL(email_queue,'')=''))",
		name,
	)
	return {"status": "Cancelled"}


def retry_failed(name):
	"""Put Failed recipients of a finished or paused campaign back in line. Only rows that never reached
	the provider (no message id, no email queue entry) are eligible, so nobody gets a second copy."""
	campaign = _campaign(name, "write")
	_require(campaign)
	if campaign.status not in ("Running", "Paused", "Completed", "Failed"):
		frappe.throw(_("Retry is available once the campaign has started."))
	frappe.db.sql(
		f"""UPDATE `tab{RECIPIENT}` SET status='Pending', claim_token=NULL, failed_at=NULL, retry_after=NULL
		WHERE campaign=%s AND status='Failed' AND IFNULL(provider_message_id,'')='' AND IFNULL(email_queue,'')=''
		AND IFNULL(linked_doc,'')='' AND started_at IS NOT NULL""",
		name,
	)
	n = frappe.db.sql("SELECT ROW_COUNT()")[0][0]
	if n and campaign.status in ("Completed", "Failed"):
		_transition(name, "Running", ("Completed", "Failed"), completed_at=None)
	return {"requeued": n}


def set_step_paused(name, step_idx, paused):
	"""Pause or resume one step of a campaign. A paused step sends nothing until resumed; the other steps carry on."""
	campaign = _campaign(name, "write")
	_require(campaign)
	if campaign.status not in ("Scheduled", "Queued", "Running", "Paused"):
		frappe.throw(_("Steps can only be paused while the campaign is scheduled or running."))
	step = next((s for s in campaign.steps if s.idx == cint(step_idx)), None)
	if not step:
		frappe.throw(_("This campaign has no step {0}.").format(cint(step_idx)))
	frappe.db.set_value("CRM Campaign Step", step.name, "paused", 1 if cint(paused) else 0, update_modified=False)
	frappe.clear_document_cache(CAMPAIGN, name)
	return {"step": step.idx, "paused": bool(cint(paused))}


def _require(campaign):
	if not can_act(campaign):
		frappe.throw(_("Only the campaign owner or a manager can do this."), frappe.PermissionError)
