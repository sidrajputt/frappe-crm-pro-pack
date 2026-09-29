# Changelog

All notable changes to CRM Pro Pack (the `crm_addons` Frappe app).

## 1.0.0 - 2026-09-30

First public release. Built and tested on Frappe v15 with Frappe CRM 1.x.

### Added

- **Meetings**
  - Google Meet and Google Calendar meetings created from a Lead, with guests, invitations, reminders
    and a calendar (Agenda, Month, Week, Day).
  - A Manual Link provider for any Zoom, Teams or other URL, with a calendar file emailed to guests.
  - Meeting outcomes (Held, No Show, Rescheduled) with notes and an optional next follow-up.
- **Follow-ups**
  - Call follow-ups with a call outcome, lead status, remark and next follow-up date.
  - Attempt counting, reminders, escalation after repeated missed calls, a follow-up queue, editable
    quick-fill templates and an optional WhatsApp message after a missed call.
- **Lead intelligence**
  - A 0-100 lead score (Hot, Warm, Cold) and stale-lead alerts.
  - Lead list and Kanban card fields: Next Follow-up, Last Call Outcome, Last Follow-up Remark,
    Call Attempt, Next Meeting, Lead Score.
- **Sales Dashboard**
  - A full-screen, role-aware dashboard (sales users see their own numbers, managers see the team)
    with KPI cards, daily activity, call outcomes, lead funnel, calls by hour, team table, pipeline,
    sources, queue and recent calls.
  - Date range dropdown with presets and a calendar, light and dark theme, and export to Excel or CSV.
- **Inside CRM**
  - Meetings and Follow-ups tabs on the Lead page, header buttons, Kanban buttons, timeline comments
    and charts for CRM's own dashboard, all without changing CRM's code.
  - Optional switches to hide the Deals menu entry and the Convert to Deal button (off by default).
- **Admin**
  - A Desk workspace, a setup checklist with a Google connection test, and a settings page for every
    behaviour. Everything the install sets up is idempotent and removed on uninstall.

### Compatibility

- Frappe v15 (tested). Every Frappe API used also exists on v16 and the v17 development branch.
- Frappe CRM 1.x. CRM 2.0 (Frappe 16 or newer) is best-effort.
