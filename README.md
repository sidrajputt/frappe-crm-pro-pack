# CRM Pro Pack for Frappe CRM

**Google Meet and Google Calendar meetings, call follow-ups, lead scoring, stale-lead alerts and a role-aware Sales Dashboard with Excel export - in one app, with no changes to Frappe CRM's own code.**

![License: MIT](https://img.shields.io/badge/license-MIT-green)
![Frappe v15](https://img.shields.io/badge/Frappe-v15-blue)
![Frappe CRM 1.x](https://img.shields.io/badge/Frappe%20CRM-1.x-blue)
![Python 3.10+](https://img.shields.io/badge/python-3.10%2B-blue)

CRM Pro Pack is a free, open-source plugin (a normal Frappe app) that turns [Frappe CRM](https://frappe.io/crm) into a complete sales-follow-up tool. Sales teams schedule Google Meet meetings from a lead, log every call attempt with its outcome, get reminded about the next follow-up, and managers see who is calling whom on a Sales Dashboard they can download as Excel. Admins connect Google once, and nobody else ever signs in to Google.

It installs like any other Frappe app (`bench get-app`, `bench install-app`) and works by adding to CRM's screens from the outside, so **you never fork or patch Frappe CRM**.

## Contents

- [What it does](#what-it-does)
- [Compatibility](#compatibility)
- [Installation](#installation)
- [First-time setup](#first-time-setup)
- [Using it](#using-it)
- [Sales Dashboard](#sales-dashboard)
- [Campaign Manager](#campaign-manager)
- [Roles and permissions](#roles-and-permissions)
- [Settings reference](#settings-reference)
- [How it works](#how-it-works)
- [Troubleshooting](#troubleshooting)
- [FAQ](#faq)
- [Development](#development)
- [License](#license)

## What it does

### Meetings with Google Meet and Google Calendar

- **Schedule from a lead.** A Google-Calendar-style scheduler (Agenda, Month, Week, Day) inside CRM, and a **Schedule Meeting** button on every Lead.
- **Google Meet links and invitations.** The meeting is created on the company calendar with a Meet link; guests get a Google invitation and see it in their own calendar.
- **Choose your guests.** CRM team members, contacts or any email address. The lead's contact, you and the lead owner are pre-selected.
- **You decide who is told.** Send invitations or not when you schedule, change or cancel, and a **Notify guests** button sends a note (email and/or CRM notification) any time.
- **Reminders.** In-app notifications and email shortly before a meeting (30 minutes by default, optionally a day before too).
- **Meeting outcomes.** Record whether the meeting was Held, a No Show or needs Rescheduling, with notes and an optional next follow-up.
- **Not only Google.** A Manual Link provider takes any Zoom, Teams or other URL and emails guests a calendar file. More providers can be plugged in - see [docs/ADDING_A_PROVIDER.md](docs/ADDING_A_PROVIDER.md).

### Call follow-ups with attempts, outcomes and next steps

- **One form for every call.** Quick-fill templates, a **call outcome** (Did Not Pick, Did Not Connect, Interested, Not Interested, Meeting Scheduled, Ask for Detail, Call Back Later), the **lead status** (change it right there), a remark, and the **next follow-up** date and time with quick buttons.
- **Attempt counting.** "Call attempt 1, 2, 3" counts the calls in a row that did not reach the person, and starts again after a call that did.
- **The next follow-up is the outcome.** Logging a newer follow-up closes the older open one.
- **Reminders** to the follow-up owner when one is due, in-app and by email.
- **Automatic escalation.** After N unreached calls in a row (default 3) a note goes on the lead's timeline and the lead owner and Sales Managers are notified. Optionally the lead moves to a status you choose, such as "Unreachable".
- **Follow-ups workspace**, a large pop-up over the CRM with an **Open in a new tab** button for the full-screen page (`/followups`) built like the Sales Dashboard: KPI cards and tabs for Overdue, Due today, Upcoming and Done, search, owner / outcome / due-date filters, a list or a by-day view, click-to-call phone links, and row actions to log a call, mark done, reschedule or open the lead (bulk done and bulk reschedule too). **Managers see everyone's follow-ups by default** and can narrow to one person; sales users only see their own.
- **WhatsApp after a missed call** (optional): when a call is logged as Did Not Pick or Did Not Connect, offer a WhatsApp message through CRM's own WhatsApp integration.
- **Follow-up templates** you edit yourself, for one-tap logging.

### Lead intelligence

- **Lead score** from 0 to 100 (Hot, Warm, Cold) built from connected calls, the latest outcome, meetings held or coming up, and how recently anyone touched the lead.
- **Stale-lead alerts.** Open leads with no activity for N days (default 7) notify their owner once per quiet spell.
- **Columns for the Leads list and Kanban cards:** Next Follow-up, Last Call Outcome, Last Follow-up Remark, Call Attempt, Next Meeting and Lead Score, so the essentials show without opening the lead.

### Campaign Manager (Email and WhatsApp)

- **Journeys.** Chain steps on later days across both channels, each optionally conditional on the previous one (for example a WhatsApp reminder two days after an email that was not opened), with an optional stop when a lead replies.
- **One campaign, both channels.** Pick an audience (CRM filters, a saved Leads-list segment, or selected leads), choose Email, WhatsApp or both, pick templates, preview as a real lead, send now or schedule.
- **Built on what you already run.** Email goes through Frappe's mail system and is logged on the Lead; WhatsApp goes through the frappe_whatsapp app and its approved Meta templates. No second sender, no second template system.
- **Safe at scale.** Background batches with a rate limit, pause / resume / cancel, retry of messages that never reached the provider, and a database guarantee that nobody gets the same message twice.
- **Compliance built in.** Opt-out list, signed unsubscribe link, WhatsApp STOP replies, and a WhatsApp opt-in rule before launch.
- **Honest analytics.** Recipient-level report plus per-channel numbers: only what Frappe and Meta really report.
- **Click tracking.** Links in emails are routed through your own site, signed so they cannot be forged; clicks count as opens and show which links work.
- **Sending hours.** Keep messages to working hours in the campaign's time zone, optionally Monday to Friday; anything due outside waits.
- **List clean-up.** Bounced emails and numbers that are not on WhatsApp are taken off the sending list automatically, with a page to review and restore them.
- **Health alerts.** The owner is told when a running campaign has a high failure rate, a refused login or no way to send.
- **Automations** (own section in the Campaign Manager). *When* a lead is created, changes status, replies, clicks, opens, bounces or opts out, *only for leads that match* optional filters, *then* send a message sequence, set the status, create a follow-up or add a note, in the order you choose. Each lead goes through an automation once; as many automations as you like, each with an on / off switch.
- **Pause one step**, retry failed messages, a **calendar** of what goes out when (busy days flagged), and **cost and results** (price per message, deals and revenue from the leads reached).

See [docs/CAMPAIGN_MANAGER.md](docs/CAMPAIGN_MANAGER.md).

### Built into CRM's own screens

- **Tabs on the Lead page:** Meetings and Follow-ups, next to Activity, Emails, Comments, Calls, Tasks, Notes and Attachments.
- **Header buttons:** Schedule Meeting and Add Follow Up on the Lead page; Meetings, Follow-ups and Sales Dashboard on the Leads list; floating buttons on the Kanban view; a **CRM Pro Pack** group in the left menu and a button group in the Dashboard header (Meetings, Follow-ups, Campaigns, Sales Dashboard).
- **On the Lead timeline:** every meeting, reschedule, cancellation and follow-up is posted as a comment.
- **Optional:** hide the Deals menu entry and the Convert to Deal button, if your team only works with leads.
- **CRM dashboard charts:** meetings and follow-ups charts you can add to CRM's own dashboard.

## Compatibility

| Component | Supported | Notes |
|---|---|---|
| **Frappe Framework** | **v15** (developed and tested on) | Every Frappe API the app uses also exists on v16 and the v17 development branch, so newer versions are allowed but not yet tested. |
| **Frappe CRM** | **1.x** (`main` branch) | CRM 1.x is the version that runs on Frappe v15. CRM 2.0 needs Frappe 16 or newer and is best-effort. |
| Python | 3.10 - 3.12 | |
| Database | MariaDB | Reports use MariaDB SQL. PostgreSQL is not supported. |
| Browser | Current Chrome, Edge, Firefox, Safari | |

Leads only: meetings and follow-ups attach to CRM Leads. Deals are not extended.

## Installation

You need a bench with **Frappe v15** and **Frappe CRM 1.x** installed on the site. If CRM is not installed yet:

```bash
cd ~/frappe-bench
bench get-app crm --branch main                     # Frappe CRM 1.x, the line for Frappe v15
bench --site your-site.com install-app crm
```

Then install CRM Pro Pack:

```bash
bench get-app https://github.com/sidrajputt/frappe-crm-pro-pack --branch main
bench --site your-site.com install-app crm_addons
bench --site your-site.com migrate
bench restart
```

The app's Python package is called `crm_addons`. If the assets were not linked, run `bench build --app crm_addons`, and hard-refresh the browser (Ctrl/Cmd + Shift + R) after installing or updating.

**Update:** `bench update --apps crm_addons` (or `git pull` in `apps/crm_addons`), then `bench --site your-site.com migrate` and `bench restart`.

**Uninstall:** `bench --site your-site.com uninstall-app crm_addons`. This removes the scripts, custom fields, dashboard charts and workspace it added.

Everything is set up by the install itself and re-checked on every migrate (it never overwrites what an admin changed) - see [How it works](#how-it-works).

## First-time setup

About ten minutes, once:

1. Open **CRM Addons Settings** in Desk (search for it, or use the **CRM Pro Pack** workspace). It shows a live checklist of what is connected and what is missing.
2. **Meetings with Google Meet:** follow [docs/ADMIN_GUIDE.md](docs/ADMIN_GUIDE.md) to connect one company Google account. The settings page shows the exact redirect URI for your site and a **Test Google connection** button. Skip this step to start with Manual Link meetings.
3. **Reminders and emails:** enable the scheduler (`bench --site your-site.com enable-scheduler`) and set up an outgoing Email Account on the site.
4. Give people the CRM roles: **Sales User** for the team, **Sales Manager** for managers.

Follow-ups, scoring, the Sales Dashboard and the in-app notifications need no external setup.

## Using it

| You want to | Do this |
|---|---|
| Schedule a meeting | Open a Lead and click **Schedule Meeting**, or open its **Meetings** tab |
| Log a call | Open a Lead and click **Add Follow Up**, or open its **Follow-ups** tab |
| See what is due | On the Leads list or Kanban view click **Follow-ups** |
| See all meetings | On the Leads list click **Meetings** |
| See team numbers | Click **Sales Dashboard** (Leads list, Kanban view or CRM's Dashboard page) |
| Change or cancel a meeting | Open the meeting, then **Edit** or **Cancel meeting** |
| Tell guests something | Open the meeting, then **Notify guests** |
| Add columns to the list | Leads list, **Columns** setting: Next Follow-up, Last Call Outcome, Lead Score and more |

## Sales Dashboard

A large pop-up over the CRM, like the Meetings calendar (open it from the **Sales Dashboard** button); its **Open in a new tab** button gives the full-screen version (`/sales-dashboard`, same tab, date range, person and theme). It follows the roles: **sales users see only their own numbers; managers see the whole team and can pick one person.**

- **Date range picker** (the same one on the Follow-ups page) with presets (today, yesterday, last 7 and 30 days, this and last week, this and last month, this quarter, this year) and a calendar for a custom range, usable with the keyboard (arrow keys, PageUp / PageDown, Esc). A range is always the days from the first to the last, both included, whole days; every number, chart, export and the "previous period" (the same number of days right before it) use that same range. The last range is remembered per page.
- **KPI cards:** calls today, follow-ups due today and overdue, calls, connect rate, follow-ups added, leads added, meetings held, leads converted to deals, average time to first call, stale leads.
- **Daily activity** for calls, follow-ups or leads added, split by result or by person, and a **call outcomes** donut.
- **Lead funnel** (added, contacted, reached on a call, meeting booked, converted), **calls by hour** with the best time to call, and **attempts to connect**.
- **Team performance** table for managers (click a column to sort) and **call outcomes by person**.
- **Pipeline** by status with average age, **leads by source**, **lead temperature**, **meetings by outcome**.
- **Follow-up queue**, **recent calls** and **upcoming meetings**, each opening the lead.
- **Export** to an Excel workbook (a sheet per section plus the full call log) or the call log as CSV. It follows the CRM's light / dark theme (no toggle of its own).
- **Lead Nurturing** tab (when the Campaign Manager is on; `/sales-dashboard#nurturing` opens it directly): the campaigns of the selected date range as KPI cards (campaigns, recipients reached, delivered, read / open and reply rates, failed, opt-outs), messages sent by day and channel, an engagement funnel, Email vs WhatsApp, campaigns by status, top campaigns (each opens in the Campaign Manager) and how many open leads were nurtured. Sales users only see their own campaigns.

## Campaign Manager

Open it from the **Campaigns** button on the Leads list or Kanban view, or go to `/campaigns`. It needs an outgoing Email Account for email and the frappe_whatsapp app (active default account, approved templates) for WhatsApp; either channel works without the other. Full guide, flows, testing checklist and rollback: [docs/CAMPAIGN_MANAGER.md](docs/CAMPAIGN_MANAGER.md).

## Roles and permissions

| Role | Meetings | Follow-ups | Sales Dashboard |
|---|---|---|---|
| System Manager, Sales Manager, Administrator | See and edit all | See and edit all | Whole team, or one person |
| Sales User | Meetings they created, organise or were invited to; edit only their own | Their own | Their own numbers only |

Sales users can only schedule on leads they are allowed to see in CRM. The dashboard and its export enforce the same rules on the server, so a sales user cannot see another person's numbers by changing the address.

## Settings reference

Open the **setup page** at `/pro-pack-setup` (System Managers; the Campaign Manager's *Settings* link goes there too). It groups every option by area, gives each a switch or field and an **(i)** button that explains it on hover, locks options whose parent switch is off and says why, validates numbers before saving, has a search box, and starts with a **setup checklist** (Google, outgoing email, scheduler, background worker, WhatsApp, country code) that shows what still needs doing and how. It reads and writes the same *CRM Addons Settings* record as the classic form at `/app/crm-addons-settings`, which still works.

All settings are in **CRM Addons Settings** (Desk).

| Setting | Default | What it does |
|---|---|---|
| Default Provider | Google Meet | Meeting provider for new meetings (Google Meet or Manual Link) |
| Default Duration | 30 min | Length of a new meeting |
| Add a video meeting by default | On | Pre-ticks the video meeting box |
| Company Google Calendar | (auto-selected if only one is connected) | The calendar all meetings are created on |
| Use each user's own Google Calendar | Off | Use a person's own calendar when they have connected one |
| In-app notifications for meetings | On | Notify the team when a meeting is scheduled, changed or cancelled |
| Reminders before a meeting | On, 30 min | Reminder time, plus an optional early reminder (for example 1440 = a day before) |
| Email reminders to team / external guests | On / Off | Who gets reminder emails |
| Enable follow-ups | On | Turns the follow-up feature on or off |
| Remind the follow-up owner | On | Notification (and email) when a follow-up is due |
| Escalate after N missed calls | 3 (0 = off) | Timeline note and notification after N calls in a row that did not reach the lead |
| Lead status to set when escalated | (none) | Optional status to move the lead to |
| Score Leads from their activity | On | The 0-100 Lead Score |
| Alert the owner after N days without activity | 7 (0 = off) | Stale-lead notification |
| Default WhatsApp message after a missed call | (a friendly text) | Offered when WhatsApp is set up in CRM |
| Show "Schedule Meeting" button | On | Header button on the Lead page |
| Show "Meetings" and "Follow-ups" buttons on the Leads list | On | Header buttons on the Leads list |
| Show "Add Follow Up" button | On | Header button on the Lead page |
| Show floating buttons on the Kanban view | On | Meetings, Follow-ups and Sales Dashboard on Kanban |
| Show links in the side menu | On | Sales Dashboard (it also holds the Lead Nurturing view), Follow-ups, Meetings and Campaigns rows after CRM's own left-menu entries, and a compact button group in the Dashboard header |
| Add Meetings and Follow-ups tabs to Lead pages | On | The tabs beside Activity, Emails, and so on |
| Hide "Deals" from the side menu | Off | Hides the entry on screen only |
| Hide "Notes" / "Tasks" / "Call Logs" from the side menu | Off | Same as Deals, one switch each |
| Hide the "Convert to Deal" button | Off | Hides the button on screen only |

Follow-up templates are managed under **CRM Follow Up Template** (eight starters are added on install).

## How it works

CRM Pro Pack does not modify Frappe CRM. On install and on every migrate (safe to repeat) it:

- creates its doctypes: **CRM Meeting**, **CRM Meeting Attendee**, **CRM Follow Up**, **CRM Follow Up Template**, **CRM Addons Settings**;
- adds read-only fields to CRM Lead: Next Meeting, Next Follow-up, Last Call Outcome, Last Follow-up Remark, Call Attempt and Lead Score (plus a hidden stale-alert date);
- adds CRM Form Scripts for the Lead page and the Leads list (the header buttons);
- adds a short script to CRM's page through a Frappe `after_request` hook, which draws the tabs, Kanban buttons, follow-up form and dashboard link;
- adds charts to CRM's dashboard, once, through CRM's chart hook (and fills them in itself on CRM 1.x, which lacks the hook);
- schedules a job every 5 minutes for reminders, and daily jobs for stale-lead alerts and lead scores;
- creates a **CRM Pro Pack** workspace in Desk with shortcuts to the settings and lists.

The tabs are built by cloning CRM's own tab buttons, and the optional Deals hiding matches CRM's markup. If a future CRM release changes that markup, the tabs or the hiding may stop appearing - the header buttons, the follow-up form and the Sales Dashboard keep working. See [Troubleshooting](#troubleshooting).

## Troubleshooting

| Symptom | What to do |
|---|---|
| No buttons, tabs or Sales Dashboard link in CRM | Run `bench --site your-site.com clear-cache`, restart the bench, hard-refresh the browser. Then check **Error Log** in Desk. |
| Tabs missing but buttons work | CRM's tab markup differs from what the app expects. Open an issue with the HTML of CRM's tab bar. |
| A window opens blank or shows an error message | Hard-refresh (Ctrl/Cmd + Shift + R). Files are versioned automatically, so a stale cache should not happen after that. |
| "Google rejected the saved login" | Authorise the Google Calendar again in Desk. In Google's Testing mode the login expires every 7 days - see the admin guide. |
| Reminders or stale alerts never arrive | Check the scheduler: `bench --site your-site.com scheduler status`, then `bench --site your-site.com enable-scheduler` (and keep `bench start` or the production workers running). |
| Emails are not sent | Set up an outgoing Email Account. The in-app notification is still delivered. |
| A field or doctype looks missing after an update | Run `bench --site your-site.com migrate`. |
| Hidden Deals menu reappears after a CRM update | Check the two hide switches, then open an issue with the menu's HTML. |

## FAQ

**Is this an official Frappe or Frappe CRM app?** No. It is an independent open-source add-on. It is not affiliated with or endorsed by Frappe Technologies.

**Do I need ERPNext?** No. It needs only Frappe and Frappe CRM.

**Will it change or fork my CRM code?** No. Everything is added from the outside, so you keep upgrading CRM normally.

**Do sales users need a Google account?** No. An admin connects one company Google account once; meetings are created on its calendar and the invitations come from it.

**Does it work with Deals?** The features work on Leads. Deals are not extended (you can optionally hide the Deals menu and the Convert to Deal button).

**Can I use Zoom or Microsoft Teams?** Paste any Zoom or Teams link with the Manual Link provider. Automatic Zoom and Teams meetings are planned; other apps can add providers through a hook.

**Does it work on PostgreSQL?** Not at the moment; the dashboard uses MariaDB SQL.

**Is my data sent anywhere?** Only what you enable: meeting details go to Google Calendar, and WhatsApp messages go through CRM's own WhatsApp integration. The dashboard and exports run on your own server.

**Can I export the data?** Yes: the Sales Dashboard exports an Excel workbook and a call-log CSV, and every doctype supports Frappe's standard Data Export.

## Development

```bash
bench --site your-site.com set-config allow_tests true
bench --site your-site.com run-tests --app crm_addons
bench --site your-site.com set-config allow_tests false
```

Tests run in transactions that are rolled back, and do not seed sample data into the site.

```
crm_addons/
  hooks.py            hooks: permissions, scheduler, after_request, chart hook, redirects
  install.py          everything set up on install / migrate, and removed on uninstall
  api.py              meetings API used by the UI
  followups.py        follow-up API, attempts, escalation, reminders
  reports.py          Sales Dashboard data and the Excel / CSV export
  scoring.py          lead score rules
  stale.py            stale-lead alerts
  notifications.py    in-app notifications, emails, reminders
  permissions.py      who sees what
  inject.py           adds the UI script to the CRM page
  providers/          Google Meet, Manual Link, Zoom / Teams placeholders
  meetings/           CRM Meeting, CRM Meeting Attendee, CRM Addons Settings
  follow_ups/         CRM Follow Up, CRM Follow Up Template
  patches/            data upgrades
  public/             bridge.js, addons.js (CRM UI), meetings/ (calendar, follow-up form, dashboard)
docs/                 ADMIN_GUIDE.md, ADDING_A_PROVIDER.md
```

The UI is plain Vue 3 and JavaScript with no build step. Contributions are welcome: open an issue or a pull request.

See [CHANGELOG.md](CHANGELOG.md) for what changed in each release.

## License

[MIT](LICENSE). Frappe and ERPNext are trademarks of Frappe Technologies Pvt. Ltd.; this project is not affiliated with them.

---

*Topics: Frappe CRM plugin, Frappe CRM Google Meet integration, Frappe CRM follow-up and call log, lead scoring, sales dashboard, Google Calendar for Frappe CRM, Frappe v15 app.*
