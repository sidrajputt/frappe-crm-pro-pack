"""Link click tracking for campaign emails.

Every ``http(s)`` link in a campaign email is rewritten, per recipient, to
``/api/method/crm_addons.campaigns.tracking.click?r=<recipient>&u=<link>&s=<signature>``. Opening it records the click and
sends the person on to the real address.

The signature is an HMAC of the recipient and the address with the site's own key, so the endpoint can only ever redirect
to an address this site put into an email: it is not an open redirect, and nobody can forge clicks for other recipients.
Mail scanners that open links ahead of the reader can count as clicks; that is a limit of every link tracker.
"""

import base64
import hashlib
import hmac
import html
import re
from urllib.parse import quote

import frappe
from frappe import _
from frappe.utils import cint, get_url, now_datetime

from crm_addons.campaigns import optout
from crm_addons.campaigns.common import RECIPIENT

CLICK = "CRM Campaign Click"
METHOD = "/api/method/crm_addons.campaigns.tracking.click"
MAX_URL = 1800
# an anchor's href attribute; each tag is bounded by its own ">" so a long unbalanced document cannot make it slow
_HREF = re.compile(r"(<a\b[^>]{0,2000}?\bhref\s*=\s*)([\"'])([^\"'>]{1,%d})\2" % (MAX_URL * 2), re.I)


def _secret():
	from frappe.utils.password import get_encryption_key

	return get_encryption_key().encode()


def sign(recipient, url):
	return hmac.new(_secret(), f"{recipient}|{url}".encode(), hashlib.sha256).hexdigest()[:24]


def _encode(url):
	return base64.urlsafe_b64encode(url.encode()).decode().rstrip("=")


def _decode(token):
	return base64.urlsafe_b64decode(token + "=" * (-len(token) % 4)).decode()


def tracked_url(recipient, url):
	return f"{get_url()}{METHOD}?r={quote(recipient)}&u={_encode(url)}&s={sign(recipient, url)}"


def _trackable(url):
	return (
		url.lower().startswith(("http://", "https://"))
		and len(url) <= MAX_URL
		and METHOD not in url
		and optout.UNSUBSCRIBE_METHOD not in url
	)


def rewrite_links(body, recipient):
	"""Replace the links of an email body with tracked ones for this recipient. Anything else is left untouched."""
	if not body or "href" not in body.lower():
		return body

	def swap(match):
		url = html.unescape(match.group(3)).strip()
		if not _trackable(url):
			return match.group(0)
		return f"{match.group(1)}{match.group(2)}{html.escape(tracked_url(recipient, url), quote=True)}{match.group(2)}"

	return _HREF.sub(swap, body)


def _gone(message):
	frappe.respond_as_web_page(_("Link not found"), message, http_status_code=404, indicator_color="red")


@frappe.whitelist(allow_guest=True)
def click(r=None, u=None, s=None):
	"""Record a click, then redirect. A forged or damaged link is refused before anything is written."""
	try:
		url = _decode(u or "")
	except Exception:
		return _gone(_("This link is not valid."))
	if not r or not s or not hmac.compare_digest(sign(r, url), s) or not url.lower().startswith(("http://", "https://")):
		return _gone(_("This link is not valid."))
	try:
		record(r, url)
		if not frappe.flags.in_test:
			frappe.db.commit()  # nosemgrep: guest endpoint, nothing else commits after this
	except Exception:
		frappe.log_error(frappe.get_traceback(), "CRM Campaign: could not record a click")
	frappe.local.response["type"] = "redirect"
	frappe.local.response["location"] = url


def record(recipient, url):
	"""Count one click on a recipient's email. A click also proves the email was opened, so it moves the recipient to Read."""
	from crm_addons.campaigns import engine, rules

	row = frappe.db.get_value(RECIPIENT, recipient, ["campaign", "recipient_type", "recipient_id", "channel"], as_dict=True)
	if not row or row.channel != "Email":
		return False
	now = now_datetime()
	frappe.db.sql(
		f"UPDATE `tab{RECIPIENT}` SET click_count = IFNULL(click_count, 0) + 1, clicked_at = COALESCE(clicked_at, %s) WHERE name = %s",
		(now, recipient),
	)
	frappe.get_doc(
		{"doctype": CLICK, "campaign": row.campaign, "recipient": recipient, "lead": row.recipient_id, "url": url[:MAX_URL]}
	).insert(ignore_permissions=True)
	engine.advance(recipient, "Read", read_at=now)
	rules.fire(recipient, "Clicked a link")
	return True


def click_report(campaign, from_date=None, to_date=None):
	"""``{people, clicks, links: [{url, clicks, people}]}`` for one campaign (the same date range as its other numbers)."""
	from crm_addons.campaigns.common import activity_clause

	rng, rv = activity_clause("r", from_date, to_date)
	one = frappe.db.sql(
		f"""SELECT COUNT(*), IFNULL(SUM(r.click_count), 0) FROM `tab{RECIPIENT}` r
		WHERE r.campaign=%(c)s AND r.click_count > 0{rng}""",
		{"c": campaign, **rv},
	)[0]
	links = frappe.db.sql(
		f"""SELECT k.url AS url, COUNT(*) AS clicks, COUNT(DISTINCT k.recipient) AS people
		FROM `tab{CLICK}` k JOIN `tab{RECIPIENT}` r ON r.name = k.recipient
		WHERE k.campaign=%(c)s{rng} GROUP BY k.url ORDER BY clicks DESC LIMIT 10""",
		{"c": campaign, **rv},
		as_dict=True,
	)
	return {"people": cint(one[0]), "clicks": cint(one[1]), "links": links}


def enabled_for(campaign):
	return bool(cint(campaign.get("track_clicks")))
