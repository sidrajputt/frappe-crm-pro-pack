# Campaign Manager

Email and WhatsApp campaigns inside CRM Pro Pack. One campaign can use both channels, one audience, one
schedule and one analytics page. It is built **on top of** the infrastructure the site already has:

- **Email** goes through Frappe's own mail system (`frappe.sendmail`, Email Queue, Email Account) and is logged
  on the Lead as a normal Communication.
- **WhatsApp** goes through the **frappe_whatsapp** app that Frappe CRM already uses (`WhatsApp Message`,
  `WhatsApp Templates`, `WhatsApp Account`, Meta webhooks). Nothing here calls Meta directly.

Contents: [Architecture](#architecture) · [Reused](#what-is-reused) · [New components](#new-components) ·
[Files](#files) · [Database changes](#database-changes) · [Email flow](#email-flow) · [WhatsApp flow](#whatsapp-flow) ·
[UI guide](#ui-guide) · [Settings](#settings) · [Install and migrate](#install-and-migrate) · [Testing](#testing-checklist) ·
[Rollback](#rollback) · [Limits](#what-it-does-not-do)

## Architecture

```
                          CAMPAIGN MANAGER (UI at /campaigns)
                                       │  whitelisted API (campaigns/api.py) - every check on the server
          ┌────────────────────────────┼─────────────────────────────┐
       Audience                    Content                        Schedule
 (filters / segment / leads)  (templates + variables)        (now / date, time, zone)
          └────────────────────────────┼─────────────────────────────┘
                                       ▼
                       CRM Campaign (+ CRM Campaign Step rows)
                                       │ launch (atomic) → materialise
                                       ▼
                 CRM Campaign Recipient  - one row per step × channel × lead
                 UNIQUE dedupe_key = hash(campaign, step, channel, lead)
                                       │
                dispatch (scheduler, every minute): claim a rate-limited batch
                         UPDATE … SET status='Queued' WHERE status='Pending' … LIMIT n
                                       │ enqueue send_batch (long queue, 25 rows per job)
                            ┌──────────┴───────────┐
                       EmailSender             WhatsAppSender        ← one adapter per channel
                            │                       │
            Communication + Email Queue      WhatsApp Message (frappe_whatsapp)
              (Frappe mail system)            → Meta Cloud API
                            │                       │
              Email Queue status /         Meta webhook → WhatsApp Message.status
              Communication.delivery_status        │ (doc_events hook)
                            └───────────┬───────────┘
                                        ▼
                      recipient status (forward-only) → analytics
```

The engine (`campaigns/engine.py`) knows nothing about email or WhatsApp. A channel is a class in
`campaigns/channels.py` with `check_ready`, `revalidate`, `send`, `preview` (and `sync` for email). A new channel
(SMS, for example) is a new class plus an entry in `SENDERS`.

### Why a message is never sent twice

| Risk | Protection |
|---|---|
| Browser refresh / double click on Launch | Launch is one guarded `UPDATE … WHERE status IN ('Draft','Scheduled')`; only the first call changes a row. |
| Audience built twice (restart, duplicate job) | `dedupe_key` is UNIQUE; recipient rows are bulk-inserted with `IGNORE`. |
| Two workers get the same recipient | A worker may send only if its `UPDATE … SET status='Sending' WHERE status='Queued'` changed one row. |
| Queue retry / worker restart | A row left in `Sending` after a crash is **never** re-sent: it is recovered from the provider's own record or marked Failed ("delivery unknown, not retried"). |
| Automatic retry | Only for errors that prove the provider did not accept the message (rate limits, connection refused). A read timeout is not retried. |
| Out-of-order provider callbacks | Status only moves forward (`Sent → Delivered → Read`); a late callback cannot undo a newer one. |

## What is reused

| Existing piece | Used for |
|---|---|
| `crm_addons.permissions` pattern and `utils.is_manager` | Campaign visibility and actions (managers: all; users: their own) |
| Existing roles (System Manager, Sales Manager, Sales User) | No new roles |
| `CRM Addons Settings` | Batch size, rate limit, retries, WhatsApp consent mode, country code |
| `CRM Lead` and its fields | Recipients and personalization variables (discovered from the live meta, nothing hard-coded) |
| `CRM View Settings` | Saved segments (the saved filters of the Leads list) |
| `install.run_all()` (idempotent, runs on every migrate) | Creates the Lead consent field, starter template and workspace shortcuts |
| `scheduler_events`, `doc_events`, `website_redirects` hooks | Dispatch jobs, WhatsApp status mirroring, the `/campaigns` address |
| `public/bridge.js`, `addons.js`, `meetings/app.css`, bundled Vue | Buttons, Lead tab and the page's look and feel |
| Frappe `Communication`, `Email Queue`, `Email Account`, `Email Unsubscribe` | Email sending, timeline, status, global unsubscribe |
| frappe_whatsapp `WhatsApp Message`, `WhatsApp Templates`, `WhatsApp Account` + its webhook | WhatsApp sending, Meta approval status, delivery and read status |

Not duplicated: no second WhatsApp client, no second template system for WhatsApp, no second mail sender.

## New components

**DocTypes** (module *Campaigns*)

| DocType | Purpose |
|---|---|
| `CRM Campaign` | The campaign: details, audience definition, schedule, delivery settings, status |
| `CRM Campaign Step` (child) | One journey step: channel, template, WhatsApp variable mapping, `day_offset`, `condition`, `attachments` (JSON list of file URLs, email only) |
| `CRM Campaign Recipient` | One row per message: status, timestamps, failure/skip reason, provider ids, links to the Communication / WhatsApp Message |
| `CRM Campaign Email Template` | The shared email template library (campaigns and follow-ups): subject, HTML body, `category`, `editor_mode` (Visual Builder / HTML / Rich Text), `builder_json` (the visual builder's blocks; not used when sending), variables, active flag (inactive = archived); files attached to it are sent as attachments. Frappe builds the plain-text part of the sent email from the HTML. |
| `CRM Campaign Template` | A campaign saved as a reusable template |
| `CRM Campaign Opt Out` | Opt-out list (email or WhatsApp number), unique per channel + value |

**Fields:** `CRM Lead.crm_wa_opt_in` (Check, "WhatsApp Opt-in"); settings `campaigns_enabled`, `campaign_batch_size`,
`campaign_rate_per_minute`, `campaign_max_retries`, `whatsapp_consent_mode`, `default_country_code`.

**API** (`crm_addons.campaigns.api`; every endpoint checks the caller's role and the campaign permission on the server):
`get_config`, `get_audience_fields`, `list_campaigns` (search, status, channel, created-date range, sort; rows carry channels,
delivery numbers, audience label and creator), `get_campaign`, `save_campaign`, `delete_campaign`, `duplicate_campaign`,
`save_as_template`, `list_campaign_templates`, `create_from_template`, `preview_audience`, `audience_summary`,
**`audience_insight`** (count + per-lead, per-channel eligibility with the exclusion reason + totals; one call for the audience step),
**`list_segments` / `save_segment` / `delete_segment`** (saved Lead filters = CRM View Settings), **`search_field_values`**,
`list_templates`, `get_email_template`, **`list_email_templates`**, `save_email_template` (category, editor mode, builder JSON, attachments),
`duplicate_email_template`, **`delete_email_template`** (refused while a campaign uses it: archive instead),
**`render_email_preview`** (subject + HTML, even unsaved, filled with sample data or a lead) and **`render_email_template`** (a saved template for a lead or sample data;
meant for follow-up mails too), **`send_test_email`**, **`send_test_whatsapp`**, **`list_whatsapp_templates`** (read-only, with header, buttons, samples),
**`sync_whatsapp_templates`** (managers: calls frappe_whatsapp's own `fetch`), `preview_step`, `search_leads`, `launch`, `validate_launch`,
`pause`, `resume`, `cancel`, `retry_failed`, `get_analytics` (now also `replied` and a daily `timeline`), `list_recipients`,
`lead_campaign_history`, `opt_out_recipient`; and **`crm_addons.campaigns.analytics.get_overview(from_date, to_date)`**
(totals, by channel, by day, top campaigns, status counts across the campaigns the caller may see; used by the Reports page and the Sales Dashboard).
Plus the guest endpoint `crm_addons.campaigns.optout.unsubscribe` (signed link).

**Background jobs** (`hooks.py`): `engine.dispatch` every minute (starts scheduled campaigns, recovers stuck rows,
claims a rate-limited batch, queues workers, closes finished campaigns); `engine.sync_statuses` every 5 minutes;
`engine.materialise` and `engine.send_batch` are enqueued on the `long` queue.

**Hooks:** `doc_events["WhatsApp Message"]` → `optout.on_whatsapp_message` (STOP replies) and
`engine.on_whatsapp_message_update` (Meta status → recipient); permission query conditions for `CRM Campaign`
and `CRM Campaign Recipient`.

**UI:** `public/campaigns/` (`index.html`, `campaigns.css`, `views.css`, `js/*.js`): a left-rail app with Campaigns, Email templates,
WhatsApp templates, Audiences and Reports (see *UI guide*); buttons on the Leads list and Kanban; a *Campaigns* tab on the Lead page.

## Files

**Created**

```
crm_addons/campaigns/__init__.py
crm_addons/campaigns/common.py            constants, phone/email normalisation, dedupe key
crm_addons/campaigns/personalization.py   variables, sandboxed rendering, WhatsApp parameters
crm_addons/campaigns/audience.py          filter validation, paging, eligibility, summary
crm_addons/campaigns/channels.py          EmailSender, WhatsAppSender
crm_addons/campaigns/engine.py            launch, materialise, dispatch, send, retry, status, pause/cancel
crm_addons/campaigns/optout.py            opt-out list, unsubscribe link, STOP replies
crm_addons/campaigns/analytics.py
crm_addons/campaigns/permissions.py
crm_addons/campaigns/api.py
crm_addons/campaigns/doctype/crm_campaign/{crm_campaign.json,crm_campaign.py,test_crm_campaign.py}
crm_addons/campaigns/doctype/crm_campaign_step/…
crm_addons/campaigns/doctype/crm_campaign_recipient/…
crm_addons/campaigns/doctype/crm_campaign_email_template/…
crm_addons/campaigns/doctype/crm_campaign_template/…
crm_addons/campaigns/doctype/crm_campaign_opt_out/…
crm_addons/public/campaigns/{index.html,campaigns.css,views.css}
crm_addons/public/campaigns/js/{core,ui,email-blocks,email-editors,email-views,audience,whatsapp,list,detail,wizard-steps,wizard,app}.js
docs/CAMPAIGN_MANAGER.md
```

**Modified**

```
crm_addons/hooks.py                 permissions, doc_events, scheduler jobs, /campaigns redirect
crm_addons/install.py               settings defaults, Lead opt-in field, starter template, workspace shortcuts, Leads-list button
crm_addons/modules.txt              adds the Campaigns module
crm_addons/api.py                   campaigns_enabled in the client config
crm_addons/meetings/doctype/crm_addons_settings/crm_addons_settings.json   Campaign Manager settings
crm_addons/public/bridge.js         openCampaigns()
crm_addons/public/addons.js         Campaigns button (Kanban) and Lead tab
README.md, CHANGELOG.md
```

## Database changes

Everything is created by `bench migrate` (doctypes from JSON) and `install.run_all()` (idempotent, runs after every
migrate). There is **no data patch** and no change to existing tables except one new custom field on `CRM Lead`:

- 6 new tables (`tabCRM Campaign`, `tabCRM Campaign Step`, `tabCRM Campaign Recipient`,
  `tabCRM Campaign Email Template`, `tabCRM Campaign Template`, `tabCRM Campaign Opt Out`).
- Indexes on the recipient table: unique `dedupe_key`, `(campaign, status)`, `(campaign, channel, status)`,
  `(recipient_type, recipient_id)`, and single-column indexes on `provider_message_id`, `linked_doc`, `claim_token`.
- Custom Field `CRM Lead-crm_wa_opt_in`.
- Six new settings values (defaults only written when missing, never overwriting an admin's choice).
- One starter email template, created once.

## Email flow

```
Campaign → Audience (filters / segment / leads, as the campaign owner)
  → Recipient rows (valid email? opted out? duplicate? → else Skipped + reason)
  → dispatch claims a batch → send_batch worker
  → re-check email + opt-out → render subject / HTML (values HTML-escaped) / text on the server
  → Communication on the Lead (timeline) + frappe.sendmail(communication=…, unsubscribe link, open-tracker URL)
  → Email Queue (Frappe's mailer sends it) → recipient: Queued
  → sync_statuses: Email Queue Sent → Sent · Error → Failed
                   Communication.delivery_status Opened/Bounced/Rejected → Read(opened)/Failed
  → analytics
```

Tracked: Queued, Sent, Failed always; Opened only when the outgoing Email Account has *Track Email Status*
enabled; Bounced/Rejected when the mail provider reports them to Frappe. Delivered and Clicked are **not** reported by
Frappe's mail system and are not shown.

## WhatsApp flow

```
Campaign → Audience → Recipient rows (valid number? opted out? opted in? duplicate? → else Skipped + reason)
  → dispatch claims a batch → send_batch worker
  → re-check number + opt-out → render template parameters from the mapping (an empty parameter skips that lead)
  → new "WhatsApp Message" (Outgoing, Template, body_param, reference = the Lead,
        bulk_message_reference = "CRMCAMP:<recipient>")  ← frappe_whatsapp sends to Meta in before_insert
  → recipient: Sent (Meta returned a message id)
  → Meta webhook → frappe_whatsapp sets WhatsApp Message.status = sent / delivered / read / failed
  → doc_events on_update → engine.on_whatsapp_message_update → recipient Delivered / Read / Failed
  → analytics (+ the message appears in the Lead's normal WhatsApp tab)
```

Only templates whose status in `WhatsApp Templates` is `APPROVED` can be selected or launched. A template with
variables needs sample values in frappe_whatsapp (its sender needs them), which `check_ready` enforces. frappe_whatsapp
records only the status word for a failed callback, so the recipient shows "Meta reported the message as failed"
without Meta's error text for failures that arrive after sending; failures at send time carry Meta's message.

### Consent and opt-out

Meta requires opt-in for marketing templates. `Settings → WhatsApp consent`:

- **Require opt-in** (default): a lead is eligible only when *WhatsApp Opt-in* is ticked, **or** the campaign owner
  ticks the confirmation on the campaign (recorded in the campaign's version history).
- **Allow unless opted out**: every lead with a valid number is eligible.

In both modes the **opt-out list always wins**. A number is added to it by: a reply of STOP / UNSUBSCRIBE / CANCEL
and similar, a manager from the recipient report, or by hand in *CRM Campaign Opt Out*. Email opt-outs come from the
signed unsubscribe link in every campaign email (which also adds a global Frappe *Email Unsubscribe*).
The opt-in field is **not** deleted on uninstall: consent records should outlive the app.

## UI guide

The page is plain Vue 3 with no build step (the Vue copy in `public/meetings/vendor`), split into a design system
(`campaigns.css`, `js/ui.js`) and one script per area. It **follows CRM's theme** (it reads `html[data-theme]` of the parent when embedded,
then CRM's own `theme` setting in this browser's storage, then the operating system) and has **no theme toggle**. It works on phones (rail becomes a top bar).

**Pop-up and full page.** CRM opens the Campaign Manager as a large pop-up over the page you are on (an iframe loaded with `?embed=1&theme=...`,
like the Meetings calendar). In the pop-up the page fills the frame, the left rail always spans its full height, the content scrolls inside its own pane,
*Back to CRM* is hidden and a small cluster sits top right: **Open in a new tab** (the same screen as a full page, the pop-up stays) and **Close**
(`Esc` does the same, but never while a dialog, drawer, menu or the date picker is open, they take `Esc` first; a template editor with unsaved changes asks,
a named campaign draft with unsaved changes is saved first). Close and lead links talk to the CRM page with `postMessage({source: 'crm-addons', type: 'close'})`
and `{type: 'navigate', url}` (a lead opens in the CRM tab behind the pop-up; outside the pop-up it opens in a new tab as before).

**Date ranges.** Every date filter is the same picker (presets Today, Yesterday, Last 7 / 30 days, This / Last week, This / Last month, This quarter, This year and,
where it makes sense, *Any time*; a one- or two-month calendar with range selection, From / To boxes, keyboard support: arrows, PageUp / PageDown, Enter, Esc). It is on the
campaign list (created date), the campaign page (numbers, charts and recipient report) and Reports (with *Compare to previous period*). The last range of each screen is
remembered in this browser. Days are the **site's** days (`get_config.now` gives the server clock, so a browser in another time zone agrees with the reports) and the end day
counts in full. A message belongs to a range by its *activity*: when it was sent, else when it failed, else when its row was created, the same rule for the totals, the
per-day chart, the funnel, the comparison table and the recipient report. `get_overview`, `get_analytics` and `list_recipients` take `from_date` / `to_date`; `list_campaigns`
filters on the creation day.

| Where | What |
|---|---|
| `https://<site>/campaigns` (new tab) | The Campaign Manager. Also: **Campaigns** button on the Leads list header and Kanban, the *CRM Pro Pack* workspace in Desk. A small *Settings* link opens *CRM Addons Settings* in a new tab. |
| **Campaigns** | Grid / list toggle, search, status chips, channel (Email, WhatsApp, Multi-channel) and created-date range filters, sorting. Each card or row shows name, channel badge, status, audience, schedule, sent / delivered / opened / failed with a progress bar, creator and last update. Skeleton, empty, error and "no match" states; delete and duplicate from the row menu. |
| **Create campaign** | Five steps with a progress bar and a live **summary panel** (audience size and per-channel eligibility, channels, schedule, warnings): **Details** → **Audience** → **Channel and content** → **Preview and test** → **Schedule and review**. The draft is saved on every step change, with *Save draft*, and every 30 seconds while there are unsaved changes; leaving asks first. Advanced options (follow-up journey steps with day and condition, stop on reply, WhatsApp consent) are folded away. Launch has a second confirmation that states the number of messages; a success screen offers the next actions. |
| **Audience** | Three cards: *Filter CRM leads* (rows of field, operator, value with friendly operators per field type; "Save as segment"), *Saved segment* (cards with live counts) and *Pick leads manually* (search and add). Always shows the matching count, how many can receive Email and WhatsApp, why the rest cannot (missing or invalid address, opted out, not opted in, duplicates) and a sample table with the reason per lead. |
| **Email templates** | One shared library for campaigns and follow-ups: miniature live preview cards, search, category filter, favourites (stored in this browser), archive / restore, duplicate, delete (refused while used). *Create template* asks "How would you like to create your email?": **Visual builder** (blocks: heading, text, image, button, divider, spacer, columns, banner, social links, footer, custom HTML; click or drag to add, drag or arrows to reorder, per-block settings, table-based inline-styled output), **HTML editor** (line numbers, syntax colours, Format, Validate, live preview) or **Rich text** (toolbar, links, lists, headings, images), or start from an existing template. *Insert variable* works in the subject and every text field; previews use sample data; the preview has Desktop / Mobile / Full screen in an email-client frame. *Send test* and attachments are in the editor. Managers create and edit; everyone can preview. |
| **WhatsApp templates** | Read from frappe_whatsapp (never copied). Search, category and status filters (Approved / Pending / Rejected / Disabled), *Meta-synced* or *Local* badge, a real chat-bubble preview (header media, text, footer, buttons, variables with sample values), details drawer and **Use in campaign** (approved only). The note "Create and get templates approved in Meta; they appear here after sync" is always shown, with **Refresh** and, for managers, **Sync from Meta** (frappe_whatsapp's own `fetch`). Nothing is created or edited in Meta from here. |
| **Audiences** | The saved segments you may use (private to you, or shared by a manager), with live counts, rules in plain words, a leads drawer, "Use in a campaign" and delete. They are the saved filters of the Leads list. |
| **Reports** | Date range picker (and *Compare to previous period*: each KPI card shows the change against the period of the same length right before it), the chosen range written under the title, KPI cards, messages per day (SVG), campaigns by status, an Email and a WhatsApp funnel, and a sortable comparison table with CSV export; a row opens the campaign. |
| Campaign page | Actions by status (Draft: Edit / Review and launch; Running: Pause / Cancel / Retry failed; Paused: Resume / Cancel; others: Duplicate, Save as template for managers, Delete). KPI cards, messages per day, delivery donut, funnel per channel, failure and skip reasons, the Journey table, and a searchable, filterable **Recipients** report with CSV export. It refreshes itself while running. Only numbers the integrations really report are shown. |
| Lead page → **Campaigns** tab | That lead's campaign history: campaign, channel, status, time. |
| Left menu and Dashboard | Rows in CRM's left menu, right after its own entries (on every CRM page), and a compact button group in the Dashboard header: Meetings, Follow-ups, Campaigns, Lead Nurturing (opens the Sales Dashboard on its Lead Nurturing tab), Sales Dashboard. Switch off with *CRM Addons Settings → Show links in the side menu*. The menu entries are copies of one of CRM's own menu links, so they follow CRM's theme; if CRM's menu markup ever changes and no link can be copied, they simply do not appear and the buttons on the Leads list, Kanban and Dashboard still work. |
| Opt-outs | *Opt-outs* button → the *CRM Campaign Opt Out* list. |

**Attachments.** An email step can carry files (drag and drop or browse, progress, remove) and a template can carry files; both are sent with the email.
Files are uploaded privately through Frappe's `upload_file`. The total per email is limited to **10 MB** (set `campaign_max_attachment_mb` in the settings
to change it) and is checked when you save, when you launch and again when each email is sent. WhatsApp document / image headers use the existing `wa_attach`
file, uploaded **publicly** (Meta has to fetch it) and sent by frappe_whatsapp; it is only offered when the template has a media header.

**Test sends.** *Send test email* (up to 10 addresses per call, 40 per user per hour) uses `frappe.sendmail` with a sample lead, a `[Test]` subject prefix, no
unsubscribe link, and creates no recipient, no Communication and no campaign; the real mail error is shown when it fails. *Send test message* (WhatsApp, 10 per user
per hour) sends one approved template to one number through the same sender as the campaign (a normal `WhatsApp Message`, billed by Meta); without an active
WhatsApp account the step says "Preview only".

Personalization uses `{{ first_name }}`, `{{ lead_name }}`, `{{ email }}`, `{{ mobile_no }}`, `{{ organization }}`, any other
field of the Lead (the editor lists the real ones for your site), and `{{ owner_name }}` (lead owner, "counsellor"),
`{{ sender_name }}`, `{{ today }}`, `{{ lead_url }}`. Unknown variables are rejected when an email template is saved.

## Journeys (multi-step campaigns)

A campaign is a list of steps. Each step has:

- **Send on day** - days after the campaign starts (0 = right away). Steps run in day order.
- **Channel and template** - Email or WhatsApp, so a journey can mix them (Day 0 WhatsApp, Day 2 email, Day 5 WhatsApp...).
- **Send only if** (steps after the first) - a condition on the *previous step for the same lead*, checked when the step is due:
  *previous step was sent*, *was read or opened*, *was not read or opened*, or *failed or was skipped*.
  "Not read" means the message was sent and has not been read; a message that never went out is "failed or skipped", so a
  fallback step ("if the WhatsApp failed, send an email") uses that one.
- **Stop the journey for a lead who replies** (campaign switch) - later steps are skipped for a lead who sent a WhatsApp message or
  an email after the campaign started.

How it runs: every step's recipient row is created when the campaign starts, with a `due_at` for delayed steps, so eligibility,
opt-outs and duplicates are decided up front and the audience summary is the same for the whole journey. The dispatcher only claims
rows whose time has come; at that moment the engine re-checks the lead (opt-out, number, reply) and the condition, then sends or
skips with a clear reason ("Condition not met: previous step was read or opened was false for this lead"). If the previous message
is still on its way, the step is looked at again 15 minutes later instead of guessing. The unique key (campaign + step + channel +
lead) and the guarded status updates apply to every step, so no step can be sent twice. Pausing holds delayed steps too; cancelling
cancels the ones not yet due. Editing the journey after launch is refused.

The campaign page shows a **Journey** table (per step: day, condition, recipients, sent, read/opened, failed, skipped, waiting for
its day), the analytics add "Scheduled for a later day", and the recipient report shows each row's step and due time.

Not supported (needs data the integrations do not give): conditions on email *clicks* (Frappe does not report them), and actions
such as "if clicked, update the lead status".

## Growth features (tracking, hours, rules, clean-up, alerts, automatic campaigns, cost)

| Feature | Where | How it behaves |
|---|---|---|
| Click tracking | Campaign > Advanced options (email) | Links become `/api/method/crm_addons.campaigns.tracking.click?r=..&u=..&s=..`. The signature binds recipient and destination; anything else gets a 404. A click moves the recipient to *Read*. Mail scanners that pre-open links can add a few clicks. |
| Sending hours | Schedule and review step | Judged in the campaign's time zone. Outside the hours nothing is claimed; messages stay *Pending*. |
| Lead updates | Automations (campaign-level rules from earlier versions still run) | *Replied*, *Clicked a link*, *Opened or read*, *Failed or bounced*, *Opted out* -> set status / create follow-up (mode *Other*, for the lead owner) / add a note. |
| List clean-up | Left menu (managers) | Hard bounces and invalid WhatsApp numbers are added to the opt-out list; *Put back* removes one; *Scan past failures* applies the rule to earlier failures. |
| Health alerts | Campaign page banner, Notification Log | Every 5 minutes: failure rate over the last hour, refused logins, no outgoing account. Settings: *Campaign alerts*. |
| Pause a step | Campaign > Journey and content | Other steps carry on. Rows claimed before the pause go back to *Pending*. |
| Calendar | Campaigns > Calendar view | Start, running span and follow-up days; amber days have more than one campaign sending. |
| Automations | Left panel > Automations | When / only for leads that match / then do. Message sequences run in a managed campaign; each lead goes through an automation once. |
| Cost and results | Campaign overview, Reports | Needs prices in CRM Addons Settings. Deals are counted from leads reached, created after the campaign started. |

Tests: `crm_addons.campaigns.doctype.crm_campaign.test_campaign_growth` and `test_automation`.

## Settings

*CRM Addons Settings → Campaign Manager*: **Enable**, **Messages per batch** (default 100),
**Maximum messages per minute per campaign** (default 300; keep under your Meta throughput and mail provider limits),
**Automatic retries** (default 2, exponential back-off from 5 minutes), **WhatsApp consent**, **Default country code**
(for example `91`: numbers of up to 10 digits without a country code get it).
Each campaign can override batch size, rate and retries under *Delivery Settings*.

## Install and migrate

```bash
# on the bench that runs the site (pull the branch you want to deploy)
cd ~/frappe-bench/apps/crm_addons && git fetch origin && git checkout upgrade/next
cd ~/frappe-bench
bench --site your-site.com migrate          # creates the doctypes and runs install.run_all()
bench build --app crm_addons                # only if your setup serves a built asset bundle
bench restart                               # or: sudo supervisorctl restart all
bench --site your-site.com enable-scheduler # dispatch and status jobs need the scheduler
```

Requirements: Frappe v15, Frappe CRM 1.x, a worker for the `long` queue, an outgoing Email Account for email, and the
frappe_whatsapp app with an **Active** default outgoing account and approved templates for WhatsApp. Email-only sites
work without frappe_whatsapp (the WhatsApp channel is simply unavailable). Test on a staging copy first.

## Testing on your own site

After pulling the branch and running `bench migrate` + `bench build` + `bench restart`, **hard-refresh CRM** (Ctrl/Cmd+Shift+R) so the browser loads the new scripts. Then:

1. **Create a campaign:** Leads list → *Campaigns* (or `/campaigns`) → *+ Create campaign*. Give it a name and press *Next*: the draft must save (no error banner).
2. **Audience:** add a filter (for example `status = New`), press *Preview audience* and check the matching count and the sample leads.
3. **Channels:** tick Email only first. Choose an email template and press *Show preview*: the preview must show a real lead's name.
4. **Review:** the audience summary must show total, eligible and the skip reasons. Launch with a **small audience of your own test leads**.
5. **Watch it:** the campaign page refreshes by itself; recipients go Queued → Sent. Check the email arrives and appears on the Lead's timeline. Click the unsubscribe link in it and check the address lands in *Campaign Opt-outs*.
6. **WhatsApp:** repeat with WhatsApp only (an approved template, your own number). Reply STOP and check the number is opted out.
7. **Journey:** day 0 email + a day-1 WhatsApp "only if not read"; use only your own leads.
8. **Menus:** the left menu shows the *CRM Pro Pack* group; the Dashboard header shows the four buttons.

If something fails, the red message in the page is the server's own error; send it with the steps. Server errors also appear in
*Error Log* in Desk and in `bench --site <site> console` output of the worker.

## Testing checklist

**Verified on a real bench** (Frappe 15.121, Frappe CRM 1.74 `main-hotfix`, frappe_whatsapp master, MariaDB 10.11): clean
install and migrate; 50 automated campaign tests pass; the existing meetings tests pass; an end-to-end run with real
`WhatsApp Message` / `Email Queue` / `Communication` records and Meta's status callbacks fed through frappe_whatsapp's own
webhook handler (only the HTTP call to Meta was replaced). Not verified here: real SMTP delivery, real Meta delivery and a
browser session inside a logged-in CRM, so run the manual checks below on staging. Two tests in the existing follow-up suite
(`test_meeting_outcome_closes_the_meeting_and_logs_a_follow_up`, `test_users_without_a_sales_role_cannot_open_it`) also fail on
the released `main` with this Frappe/CRM combination; they are unrelated to the Campaign Manager.

Automated: `bench --site <site> run-tests --app crm_addons --module crm_addons.campaigns.doctype.crm_campaign.test_crm_campaign`
(providers are faked: no email leaves the site and Meta is never called). The suite has 118 tests; the Campaign Manager UI backend (overview analytics, campaign list, template library,
test sends, attachments, segments, audience insight, WhatsApp template list and sync) is covered by the classes `TestOverview`, `TestCampaignList`, `TestEmailTemplates`,
`TestTestEmail`, `TestAttachments`, `TestSegmentsAndInsight`, `TestWhatsAppUi` and `TestDateRanges` (whole days, the last instant of the end day, reversed ranges, the activity rule for
the overview, the campaign page and the recipient report), including role checks. The browser UI was driven with Playwright against a real `bench serve`
(light and dark) with a local SMTP sink for test emails; real SMTP providers, Meta delivery and WhatsApp test messages were **not** verified.
The page was also driven for freezes and stuck overlays (standalone and as the CRM pop-up) by a seeded random clicker that fails on a main-thread stall over 300 ms,
a dialog / menu / scroll lock left behind, a script error or a runaway DOM loop; it needs the bench running and some campaigns and templates in the site.

Run the automated tests on a **test site without an outgoing Email Account**: when one exists, CRM's own lead-assignment
notification issues a real `COMMIT` while a test's fixtures are being created, which leaks test data past the rollback and makes
later tests fail on duplicate records (this affects the add-on's meetings and follow-up tests the same way).

Manual on staging, with a handful of your own test leads:

| Area | Check |
|---|---|
| Email | Email-only campaign → recipients go Queued → Sent; the mail arrives; the Lead timeline shows the email; the unsubscribe link opts the address out. |
| WhatsApp | WhatsApp-only campaign with an approved template → Sent → Delivered → Read on your phone; the message shows in the Lead's WhatsApp tab. |
| Both | One campaign with both channels; analytics shows each channel separately. |
| Templates | An unapproved WhatsApp template cannot be chosen; an email template with `{{ nonsense }}` cannot be saved. |
| Variables | *Preview as* each test lead; a lead with an empty mapped field is skipped with that reason. |
| Scheduling | Schedule 5 minutes ahead; it stays *Scheduled*, then starts by itself. Editing it returns it to Draft. |
| Journeys | Day 0 email + day 1 WhatsApp "only if not read": the WhatsApp goes only to leads who did not open the email, a day later; with *stop on reply*, a lead who replies gets no more steps. |
| Queue | A 500+ lead campaign sends in batches within the per-minute cap; the page shows progress. |
| Duplicates | Click Launch twice, refresh during launch, restart the workers mid-campaign: nobody receives two messages. |
| Failures | Disable the Email Account or use a bad number: failures are recorded with a reason, other recipients continue. *Retry failed* re-queues only messages that never reached the provider. |
| Permissions | A Sales User sees only their own campaigns and cannot launch someone else's; a Sales Manager sees all. |
| Opt-outs | Reply STOP to a test WhatsApp message; the next campaign skips that number as "Opted out". |
| Webhooks | Delivery and read receipts update the recipient within seconds (check the webhook in frappe_whatsapp is reachable from Meta). |
| Email status | With *Track Email Status* on, opens appear; without it, the Opened metric is hidden. |
| Cancel | Cancel a running campaign: unsent messages are *Cancelled*, nothing more is sent. |

## Measured performance

On the test bench (one machine, MariaDB 10.11, nothing tuned), 20,000 leads, Email + WhatsApp (40,000 recipient rows):

| Step | Time |
|---|---|
| Audience summary (every eligibility check, paged 1,000 at a time) | 4.7 s |
| Building the recipient list (`materialise`) | 12 s; running it again adds no rows |
| Claiming a 5,000-message batch and queuing 200 worker jobs | 0.75 s |
| Sending (one worker, mail call stubbed) | about 12 emails/s |

About 60% of the per-email time is Frappe's own `Communication` insert, which is what puts the email on the lead's timeline.
Sending scales by running more `long`-queue workers; the per-campaign rate limit (default 300/min) is the real ceiling, so raise it
only as far as your mail provider and Meta throughput allow. The browser never holds the audience: it receives counts and pages of 20-50 rows.

Also verified over real HTTP against `bench serve`: role isolation (another Sales User gets 403 on someone else's campaign),
rejection of unknown filter fields and operators, the client-supplied `status` being ignored, anonymous callers refused, a tampered
unsubscribe link refused, and a correctly signed one opting the address out.

## Rollback

1. **Stop sending first:** cancel running campaigns in the UI, or untick *Enable Campaign Manager* in settings
   (hides the buttons and tab) and run `bench --site your-site.com set-config pause_scheduler 1` briefly if you need
   every job to stop at once.
2. **Go back to the released code:** `cd apps/crm_addons && git checkout main`, then `bench --site your-site.com migrate`
   and `bench restart`. The earlier code ignores the new tables, the field and the settings, so meetings, follow-ups
   and the dashboard are unaffected.
3. The new tables, the `CRM Lead-crm_wa_opt_in` field and campaign data stay in the database (harmless, and you keep
   consent and history). To remove them deliberately: back up, then `bench --site your-site.com console` and
   `frappe.delete_doc("DocType", "CRM Campaign Recipient", force=1)` for each new doctype, and delete the custom field.
   Keep the opt-out list and the opt-in field if you may use campaigns again.
4. Messages already sent cannot be recalled; WhatsApp messages stay in the Leads' WhatsApp history.

## What it does not do

- Conditions on email clicks or other signals the integrations do not provide (see *Journeys*).
- Email delivered / clicked metrics, and open tracking unless the Email Account supports it.
- Creating or editing WhatsApp templates (that stays in Meta and frappe_whatsapp, which own the approval flow). The page only reads them and can ask frappe_whatsapp to sync them.
- Email delivered and clicked counts, and Email *opened* without open tracking (the page says so instead of showing zeros).
- Deals as recipients (the add-on is Lead-only).
- Throttling across campaigns: the rate limit is per campaign, so size it with your busiest day in mind.
