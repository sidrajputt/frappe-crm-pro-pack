# Finding out what freezes the app (temporary diagnostics)

CRM Pro Pack writes a diagnostic log while you use it, so a freeze or a crash leaves evidence. It is **temporary**:
switch it off or remove it when the problem is solved (see the end).

## What to do

1. Restart the bench so the new hooks load: `bench --site your-site.com clear-cache`, then stop and start `bench start`.
2. Hard-refresh the CRM page (Ctrl/Cmd + Shift + R).
3. Use the app until it freezes (the Campaign Manager first).
4. Look at the log, **even if the tab is frozen**. From the bench folder:

   ```bash
   tail -f logs/crm_addons_debug.log                       # watch it live
   grep -nE "WARN|ERROR|STALLED|DID NOT CLOSE" logs/crm_addons_debug.log | tail -60
   ```

   The same lines also appear in the terminal where `bench start` runs, prefixed with `[crm_addons]`.
5. If a tab froze and you had to close or kill it, just open the CRM again. The new page prints
   **"PREVIOUS PAGE DID NOT CLOSE CLEANLY"** with what the old page was doing in its last seconds, in the browser console and in
   the log.
6. Send me the lines around the problem (the `grep` above, or the last 200 lines of the file).

## Where the files are

| What | Where |
|---|---|
| Everything (server and browser) | `<bench>/logs/crm_addons_debug.log` (the old one is kept as `.log.1` after 20 MB) |
| Read it in the browser (System Manager) | `frappe.call({method: "crm_addons.debuglog.tail", args: {lines: 300}})` in the browser console |
| What the page was doing (browser) | type `__crmDebug.dump()` in the browser console, `__crmDebug.stats()` for its health |

## What the lines mean

| Line starts with | Meaning |
|---|---|
| `GET/POST /api/method/crm_addons...` | A request to the app: its status and **how long it took** (`WARN` when over 3 s). Argument *names and sizes* are logged, never the values. |
| `START` / `END` *job* | A background job (campaign dispatch every minute, send batches, building an audience, status sync, reminders, lead scoring) and its duration. `FAILED` includes the traceback. |
| `DISPATCH` | One scheduler pass for a campaign: how many messages were in flight and how many it claimed. |
| `SEND` | One message sent: channel, result and time. A slow `SEND` (over 5 s) is a slow provider. |
| `MATERIALISE page` | Building a campaign's recipient list, 1,000 leads at a time. |
| `audience.summary scanned` | The "who can receive this" scan read that many leads. |
| **`STALLED ... still running after 30s - where it is stuck:`** | Something has been running too long. The lines under it are the **stack trace of the stuck code**, written while it is still stuck. This is the most useful line for a hang. |
| `MEMORY` | The process's peak memory, every 30 s while anything runs. A steady climb is a leak. |
| `CLIENT ... MAIN THREAD WAS BLOCKED` | The browser page did not respond for that long, with what happened just before. |
| `CLIENT ... DOM CHANGE STORM` | Something changed the page thousands of times in a second (a loop). It names what changed most. |
| `CLIENT ... SLOW / failing requests, N requests in flight` | Slow or failing calls, or calls piling up. |
| `CLIENT ... MEMORY grew`, `The page grew by`, `timers ... never stopped` | A leak in the page. |
| `CLIENT ... PREVIOUS PAGE DID NOT CLOSE CLEANLY` | The last page froze or crashed; its last events follow. |

## Privacy

Request arguments are logged by name and size only. The browser reports page paths, the status and timing of calls, errors, and
the first 30 characters of the button or link you clicked. Nothing is sent outside your own server.

## Switching it off

```bash
bench --site your-site.com set-config crm_addons_debug_log 0       # server and browser
bench --site your-site.com set-config crm_addons_debug_console 0   # keep the file, stop the terminal copy
```

or set `CRM_ADDONS_DEBUG=0` in the environment, or run `__crmDebug.off()` in one browser. Then `clear-cache` and restart.

## Removing it completely

Delete `crm_addons/debuglog.py` and `crm_addons/public/debug.js`, and remove every mention:

```bash
grep -rn "debuglog\|debug.js" crm_addons
```

That finds: the `before_request` and `crm_addons.debuglog.after_request` lines in `hooks.py`; the `diagnostics` lines in `inject.py`;
the `debug.js` line in each of `public/meetings/index.html`, `dashboard.html`, `followups.html` and `public/campaigns/index.html`; and the
`@debuglog.traced(...)` lines, `debuglog.log(...)` / `debuglog.watch(...)` calls and `from crm_addons import debuglog` imports in the job
modules (`campaigns/engine.py`, `campaigns/audience.py`, `followups.py`, `notifications.py`, `scoring.py`, `stale.py`, `utils.py`).

## What was already fixed while adding this

See `CHANGELOG.md` ("Fixed: freezes and slow pages"): a recipient-report query that could send tens of thousands of names to the database, a
full lead scan on every audience edit, reply counts recomputed per campaign, a WhatsApp send with no time limit, two refresh timers that could
pile requests on a slow server, and an HTML validator that froze the tab for seconds on large unbalanced input.
