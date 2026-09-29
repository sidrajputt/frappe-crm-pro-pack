# Adding a meeting provider (Zoom, Teams, ...)

Google Meet and Manual link ship with the app. Zoom and Microsoft Teams are listed as "coming soon".
A provider is a small class; the scheduler, permissions, notifications and UI do not change.

## 1. Write the class

```python
# my_app/zoom.py
from crm_addons.providers.base import MeetingProvider, ProviderError, ProviderNotConfigured


class ZoomProvider(MeetingProvider):
    key = "Zoom"                      # shown in the provider list and stored on the meeting
    label = "Zoom"
    description = "Creates a Zoom meeting and emails the guests."
    implemented = True

    def status(self):
        # {"ready": bool, "message": str} - shown on CRM Addons Settings
        return {"ready": bool(credentials_ok()), "message": "Add the Zoom credentials."}

    def create(self, meeting, notify):
        # meeting is the CRM Meeting document (subject, starts_on, ends_on, attendees, ...)
        zoom = create_zoom_meeting(meeting.subject, meeting.starts_on, meeting.ends_on)
        return {
            "link": zoom["join_url"],
            "external_event_id": str(zoom["id"]),
            "sync_status": "Not synced",   # "Synced" only if Zoom itself delivers the invitations
        }

    def update(self, meeting, notify):
        ...

    def cancel(self, meeting, notify):
        ...
```

What the methods must do:

| Method | Called when | Return |
|---|---|---|
| `status()` | The settings page and the editor are drawn | `{"ready", "message"}` |
| `create(meeting, notify)` | A meeting is created | `link`, `external_event_id`, `external_event_url`, `calendar`, `sync_status` |
| `update(meeting, notify)` | Time, title, guests or link changed | same as `create` |
| `cancel(meeting, notify)` | The meeting is cancelled or deleted | nothing |
| `refresh(meeting)` | Someone asks for the latest responses | `{"link", "rsvp": {email: "Accepted"}}` or `None` |

`notify` says whether guests should be told. Raise `ProviderError("plain message")` for something the
user can act on, and `ProviderNotConfigured` when the provider is not set up. The meeting is always
saved; the error is stored on it and shown in the UI. If your provider does **not** send invitations
itself, return `sync_status: "Not synced"` and the app emails the guests with a calendar file.

## 2. Register it

In your app's `hooks.py`:

```python
crm_addons_providers = {"Zoom": "my_app.zoom.ZoomProvider"}
```

## 3. Make it selectable

The meeting's **Meeting Provider** field is a Select. Add your provider's key to its options with a
Property Setter (or a fixture), and, if you want it as a default, to **CRM Addons Settings >
Default Provider**:

```
Google Meet
Manual Link
Zoom
Microsoft Teams
```

Zoom and Microsoft Teams are already in the meeting field's options, so those two only need the
class and the hook.

## 4. Test it

Follow `crm_addons/meetings/doctype/crm_meeting/test_crm_meeting.py`: it replaces the external
service with a small fake and asserts on what was sent, without touching any real account.
