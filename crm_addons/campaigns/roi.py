"""What a campaign cost and what it brought in.

Cost is the number of messages that actually left, times the price per message set in CRM Addons Settings (one price per
email, and one per WhatsApp category, because Meta bills by category). With no prices set, the cost is simply not shown.

Results are counted from CRM's own records, nothing is guessed: a *deal* counts for a campaign when it was created from
a lead the campaign reached, after the campaign started; it is *won* when its status is of type Won, and its value is the
deal value in the company currency.
"""

import frappe
from frappe.utils import cint, flt

from crm_addons.campaigns.common import CAMPAIGN, RECIPIENT, activity_clause, cached_read, settings, whatsapp_installed

SENT = ("Sent", "Delivered", "Read")
_WA_PRICE = {
	"MARKETING": "campaign_cost_whatsapp_marketing", "": "campaign_cost_whatsapp_marketing",
	"UTILITY": "campaign_cost_whatsapp_utility", "TRANSACTIONAL": "campaign_cost_whatsapp_utility",
	"AUTHENTICATION": "campaign_cost_whatsapp_authentication", "OTP": "campaign_cost_whatsapp_authentication",
}


def currency():
	code = frappe.db.get_default("currency") or frappe.db.get_single_value("System Settings", "currency") or ""
	symbol = frappe.db.get_value("Currency", code, "symbol") if code else ""
	return {"code": code, "symbol": symbol or code}


def prices_set():
	cfg = settings()
	return any(flt(cfg.get(f)) for f in ("campaign_cost_email", *set(_WA_PRICE.values())))


def campaign_costs(names, from_date=None, to_date=None):
	"""``{campaign: cost}`` for these campaigns (0 for those with nothing sent, or with no prices set)."""
	names = list(names)
	out = {n: 0.0 for n in names}
	if not names or not prices_set():
		return out
	cfg = settings()
	rng, rv = activity_clause("r", from_date, to_date)
	join = "LEFT JOIN `tabWhatsApp Templates` t ON r.channel = 'WhatsApp' AND t.name = r.template" if whatsapp_installed() else ""
	category = "UPPER(IFNULL(t.category, ''))" if join else "''"
	rows = frappe.db.sql(
		f"""SELECT r.campaign AS campaign, r.channel AS channel, {category} AS category, COUNT(*) AS n
		FROM `tab{RECIPIENT}` r {join}
		WHERE r.campaign IN %(names)s AND r.status IN %(sent)s{rng} GROUP BY r.campaign, r.channel, category""",
		{"names": tuple(names), "sent": SENT, **rv},
		as_dict=True,
	)
	for row in rows:
		price = flt(cfg.get("campaign_cost_email")) if row.channel == "Email" else flt(cfg.get(_WA_PRICE.get(row.category, "campaign_cost_whatsapp_marketing")))
		out[row.campaign] += price * cint(row.n)
	return out


def results(campaign, from_date=None, to_date=None):
	"""Cost and outcome numbers for one campaign page."""
	key = (campaign, str(from_date), str(to_date))
	return cached_read("roi", key, 60, lambda: _results(campaign, from_date, to_date))


def _results(campaign, from_date, to_date):
	rng, rv = activity_clause("r", from_date, to_date)
	started = frappe.db.get_value(CAMPAIGN, campaign, "started_at")
	reached = cint(
		frappe.db.sql(
			f"SELECT COUNT(DISTINCT r.recipient_id) FROM `tab{RECIPIENT}` r WHERE r.campaign=%(c)s AND r.status IN %(sent)s{rng}",
			{"c": campaign, "sent": SENT, **rv},
		)[0][0]
	)
	cost = campaign_costs([campaign], from_date, to_date)[campaign]
	deals = won = 0
	revenue = 0.0
	if started and reached and frappe.db.exists("DocType", "CRM Deal"):
		row = frappe.db.sql(
			f"""SELECT COUNT(*), SUM(s.type = 'Won'), SUM(IF(s.type = 'Won', IFNULL(d.deal_value, 0) * IFNULL(d.exchange_rate, 1), 0))
			FROM `tabCRM Deal` d LEFT JOIN `tabCRM Deal Status` s ON s.name = d.status
			WHERE d.creation >= %(started)s AND d.lead IN (
				SELECT r.recipient_id FROM `tab{RECIPIENT}` r WHERE r.campaign=%(c)s AND r.status IN %(sent)s{rng})""",
			{"c": campaign, "started": started, "sent": SENT, **rv},
		)[0]
		deals, won, revenue = cint(row[0]), cint(row[1]), flt(row[2])
	priced = prices_set()
	return {
		"currency": currency(), "prices_set": priced, "reached": reached, "cost": round(cost, 2) if priced else None,
		"deals": deals, "won": won, "revenue": round(revenue, 2),
		"cost_per_lead": round(cost / reached, 2) if priced and reached else None,
		"cost_per_deal": round(cost / won, 2) if priced and won else None,
		"roi_percent": round((revenue - cost) / cost * 100, 1) if priced and cost > 0 else None,
	}
