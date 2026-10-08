# Admin guide - CRM Pro Pack

This is a one-time job. After it, sales users schedule meetings without ever signing in to Google.

## What you need

- A Google account for the company (for example `sales@yourcompany.com`). Meetings are created on
  its calendar and the invitations come from it. A personal account works for a test.
- System Manager access to the site.

## 1. Google Cloud

1. Open <https://console.cloud.google.com> and create (or pick) a project.
2. **APIs & Services > Library**: enable the **Google Calendar API**.
3. **Google Auth Platform** (OAuth consent screen): choose **External** (or **Internal** if you use
   Google Workspace and only your own domain will use it).
   - While the app is in **Testing**, add the company account under **Test users**. Google expires
     the login after **7 days** in this mode, so meetings quietly stop getting Meet links until you
     authorize again. Publish the app (or use an Internal one) for a permanent setup.
   - The scope used is `https://www.googleapis.com/auth/calendar`.
4. **Clients > Create client**: type **Web application**.
   - **Authorized redirect URI**: exactly what **CRM Addons Settings** shows under the guide,
     for example
     `https://crm.yourcompany.com?cmd=frappe.integrations.doctype.google_calendar.google_calendar.google_callback`
     (no trailing slash; `https` for a real site).
   - Copy the **Client ID** and **Client secret**.

A separate OAuth client for each environment (production, staging, your laptop) keeps things clean.

## 2. Frappe

1. **Google Settings**: tick **Enable** and paste the Client ID and Client secret.
2. **Google Calendar > New**:
   - **User**: the admin user who is authorizing
   - **Calendar Name**: for example `CRM Pro Pack` (Google creates a calendar with this name)
   - **Enable** and **Push to Google Calendar** ticked. Leave **Pull from Google Calendar** off,
     otherwise the whole personal calendar is imported.
   - Save, then click **Authorize Google Calendar Access** and sign in with the company account.
   You come back to Frappe with a Google Calendar ID filled in.
3. **CRM Addons Settings**: choose that record as **Company Google Calendar** and save. If it was
   the only connected calendar, this was already done for you. Click **Test Google connection**.

## 3. Email and reminders

- Reminders and fallback invitation emails need an outgoing **Email Account**
  (Desk > Email Account, with "Enable Outgoing" ticked). The settings checklist warns you if it is missing.
- The **scheduler** must be running (`bench --site your-site.com enable-scheduler`). Reminders are
  checked every 5 minutes.
- Guests who are invited through Google get Google's own email. The app only sends its own email
  when Google could not do it (a Manual link, no calendar connected, or a Google error), and for
  reminders and **Notify guests**.

## 4. Settings explained

| Setting | What it does |
|---|---|
| Default provider | Google Meet, or Manual link (paste any URL) |
| Default duration | Length of a new meeting |
| Company Google Calendar | The calendar every meeting is created on |
| Use each user's own Google Calendar | If a user has connected their own calendar, they organize their own meetings |
| Send in-app CRM notifications | Team members are notified when a meeting is scheduled, changed or cancelled |
| Reminder (minutes before) / Early reminder | When reminders go out (0 turns the early one off) |
| Email reminders to CRM team members | Email as well as the in-app notification |
| Also email reminders to external guests | Off by default; Google already reminds guests |
| Show a "Schedule Meeting" button on the Lead page | Turn off if your CRM already has a Meetings tab |
| Show "Meetings" and "Follow-ups" buttons on the Leads list page | The entry point to the calendar |

## 5. Who can do what

See the table in the README. Managers (System Manager, Sales Manager) see every meeting; sales
users see meetings they created or were invited to.

## Testing as a new sales user

Sales users never authorize Google. To see exactly what they will see:

1. **Desk > User > New**: an email, the role **Sales User**, and a password.
2. Make that user the **owner** of a test Lead (Lead Owner). CRM only shows sales
   users the records they own, or that they can reach through the organization hierarchy.
3. Log in to the CRM as that user and open the Lead. **Schedule Meeting** (or **New Meeting** on the
   Meetings tab) creates the meeting on the *company* calendar, with a real Meet link, and nothing asks
   them to sign in to Google.
4. They see only their own meetings, and there is no **Mine / Everyone** switch (that is for managers).
5. To see what happens when setup is not finished, clear **Company Google Calendar** in CRM Addons
   Settings. The editor then shows "Google Meet is not set up yet ... Ask your admin to finish the
   one-time setup." and the meeting is still saved, without a link. An admin sees an **Open setup** link
   in the same place. Put the calendar back afterwards.

Delete the test user, Lead and meetings when you are done. Cancelling a meeting removes its Google event.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `Error 400: redirect_uri_mismatch` | The redirect URI in Google Cloud does not match the one in the settings guide. Copy it exactly. |
| `Access blocked ... invalid_request` | Google refuses non-`https` addresses other than `localhost`. Use `https`, or on a laptop open the site as `http://localhost:8000`. |
| `Error 403: access_denied` | The consent screen is in Testing and the account is not a Test user. Add it under Audience > Test users. |
| Meet links stopped after a week | The consent screen is in Testing (7-day login). Publish the app, then authorize again. |
| "Google Calendar API is not enabled" | Enable the Calendar API in the Google Cloud project. |
| "Google rejected the saved login" | The authorization expired or was revoked: open the Google Calendar record and authorize again. |
| A meeting has no Meet link | "Add a video meeting" was off, or no calendar is connected (the timeline comment says which). Open the meeting: the reason is shown. |
| Guests did not get an invitation | Invitations were switched off for that meeting (the timeline comment says "Guests were not notified"), or the Lead has no email. |
| No reminders | Scheduler off, no outgoing Email Account, or reminders disabled in the settings. The checklist shows the first two. |
| A sales user cannot see a meeting | They did not create it and were not added as a team-member guest. Add them as a guest, or make them a Sales Manager. |

## Good to know

- Google does not let you notify only the *new* guests of a change, so a change notifies everyone or nobody.
- Times are in the site's time zone (System Settings).
- The company account can see every meeting on its calendar, and guests see each other's addresses (Google's default).
- Deleting a meeting in Desk removes its Google event without emailing anyone; use **Cancel meeting** to tell the guests.


## Follow-ups

In **CRM Addons Settings > Follow-ups**:

- **Enable follow-ups** turns the feature on or off.
- **Remind the follow-up owner** sends an in-app notification (and an email when "Email reminders to
  CRM team members" is on) when a follow-up becomes due. The scheduler must be running.
- **Escalate after this many missed calls** - after that many calls in a row that were not picked or connected a
  note is added to the Lead and its owner and all Sales Managers are notified. `0` = off.
- **Lead status to set when escalated** - optional; pick a Lead Status such as "Unreachable".

Under **CRM Interface**, **Show floating buttons on the Kanban view** and **Add Meetings and
Follow-ups tabs to Lead pages** can be switched off if you do not want them. **Show an "Add Follow Up" button at the top of the Lead page** controls the header button next to Schedule Meeting.

## Scoring, stale leads and WhatsApp

- **Score Leads from their activity** turns the 0-100 Lead Score on or off. Scores are
  refreshed whenever a follow-up or meeting changes, and once a day.
- **Alert the owner after this many days without activity** (`0` = off) sends one in-app
  notification per quiet spell. It runs daily, so the scheduler must be running.
- **Default WhatsApp message after a missed call** is the text offered in the follow-up form. The
  option only appears when CRM's WhatsApp is set up.
- **Follow-up templates** are managed in Desk under **CRM Follow Up Template** (title, call status,
  outcome, remark and how many hours until the next follow-up). Tick or clear **Enabled** to show or
  hide one.

## Sales Dashboard

Open it with **Dashboard** on the Leads list (header), the Leads Kanban view (floating button) or
CRM's own Dashboard page. It opens as a large pop-up over the CRM (like the Meetings calendar); the
**Open in a new tab** button next to Close opens the same tab, date range and person full screen, and
`/sales-dashboard` goes there directly. Esc or a click outside closes the pop-up (Esc first closes an open
dropdown or the date picker). Lead and meeting links move the CRM tab behind the pop-up.

- **Export** (top right) downloads an Excel workbook with a sheet for each section and the full call
  log, or the call log alone as CSV. Sales users can only export their own numbers.
- The date range picker remembers your last choice per page (per browser). A range is the days from the first
  to the last, both included; the cards, charts, the Excel / CSV export and the comparison with the previous
  period (the same number of days right before) all use that same range. Hover the picker for the dates being
  compared. The dashboard follows CRM's light or dark theme and has no toggle of its own.
- "Stale leads" uses the **Alert the owner after this many days without activity** setting; with it
  at `0` the card says the alerts are off.
- **Lead Nurturing** is a second tab next to **Sales** (`/sales-dashboard#nurturing` opens it). It shows only
  when **Enable Campaign Manager** is on and loads its numbers when you open it, for the date range and person
  picked at the top. A campaign counts when it was created, started or sent something in the range. "Replied"
  means the lead wrote back (a WhatsApp message or an email) within 14 days after a send. Delivery is reported by
  WhatsApp only, and email opens only when open tracking is on for the outgoing Email Account, so those cards
  say so instead of guessing. Managers see every campaign; a sales user only the campaigns they own or run.

## Follow-ups page

Open it from **Follow-ups** (Leads list, Kanban view, Dashboard header or the side menu) or go to `/followups`;
it opens as a large pop-up over the CRM (**Open in a new tab** for the full page, keeping your filters) and follows CRM's light or dark theme. Deep links: `/followups#today`,
`#overdue`, `#upcoming`, `#done`.

- **Who sees what:** managers see everyone's follow-ups by default and can pick one owner or switch to
  *My follow-ups*; a sales user only sees follow-ups assigned to them, whatever the address asks for.
- **Tabs and cards:** Overdue, Due today and Upcoming are open follow-ups; Done lists the ones that were
  completed or followed up by a newer call (the last 30 days unless a date range is set). The cards are
  clickable shortcuts to the tabs. Connect rate covers the calls made in the same window.
- **Filters:** search (lead name, phone, email, organisation or remark), owner, call outcome and due-date range.
- **Row actions:** *Log* opens the usual Add follow-up form; the tick marks it done; the clock moves it to
  another time (quick picks or a date and time); the arrow opens the lead. Select rows to mark many done or
  move them together; each one is checked against your permission on its own.
- *List* shows one table; *By day* groups the same rows under their due day.

- Who sees what is decided by role: **Sales Manager**, **System Manager** and **Administrator** see the
  whole team; everybody else with the **Sales User** role sees only their own numbers, even if they
  change the address to ask for someone else.
- The team table lists everyone who has the Sales User or Sales Manager role (with zeros for people who
  did nothing), so you can see who is not calling.
- "Leads added" counts leads created in the period by their **lead owner**. "Converted" counts deals
  created from a lead in the period, by the deal owner.
- The page refreshes itself every two minutes while it is open.

## Hiding Deals

Under **CRM Interface** in CRM Addons Settings:

- **Hide "Deals" from the CRM side menu** hides the Deals entry and any saved Deals views listed
  under it.
- **Hide the "Convert to Deal" button on the Lead page** hides that button.
- **Hide "Notes" / "Tasks" / "Call Logs" from the CRM side menu** work the same way as the Deals switch (entry and its saved views are hidden on screen; the pages stay reachable).

These only hide things on the screen (they are off by default). They do not stop someone who opens
`/crm/deals` directly or calls the API; use Frappe's role permissions on **CRM Deal** for that. The
button is found by its label, so check it after a CRM update. Reload the CRM page after changing a
switch.
