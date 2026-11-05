# Destructive Device Actions

A plain HTML/JS WebUI extension for help desk staff. It sends a **destructive action to exactly one device**: an MDM wipe is the first action. Pick the device from a searchable list, check its details in a confirmation, and give a ticket number or reason, which is recorded in the action. It only holds destructive actions, so they aren't mixed in with everyday troubleshooting. No HCL code, packaged by `pack.py`. The current version is **0.1.0**. It has been **tested on a mock WebUI only**, not yet on a real server (see [Testing status](#testing-status)).

Tracked in [jgstew/bigfix-content#56](https://github.com/jgstew/bigfix-content/issues/56).

## How it works

1. **Device list:** one session relevance query lists every computer with its name, ID, last report time, OS and agent type:
   ```
   (id of it, (name of it | ""), ((it as string) of last report time of it | ""), (operating system of it | ""), (agent type of it | "")) of bes computers
   ```
   Devices are sorted by last report time, newest first; devices that never reported come last. Search matches the name or the ID. Devices the chosen action doesn't apply to are hidden; **Show devices it doesn't apply to** shows them greyed out, with the reason. A name that more than one device has is flagged, and a device that hasn't reported for over 7 days is highlighted. At most 200 rows are drawn; search narrows the list.
2. **Confirmation:** a device's **Wipe...** button reloads the list first. If the device is gone, has a different name, or the action no longer applies, nothing is sent. Otherwise a dialog shows the action, the device's details, and cautions for duplicate names, stale devices and devices that never reported. **Cancel** has the focus, and Enter in the reason box does nothing.
3. **Ticket number or reason:** it's required, one line, at least 4 characters that aren't whitespace, and at most 200. The send button stays disabled until it's valid, and **Action XML** shows the exact action that will be sent.
4. **Send:** the action is built from its template (`{{ComputerID}}`, `{{Hostname}}`, `{{Reason}}`) and checked before sending: it must parse and be one `SingleAction` with one `Target` whose only child is that `<ComputerID>`. While the request is in flight, the send and Cancel buttons are disabled, the reason box is read-only, and Esc doesn't close the dialog, because the action would be created anyway. It's posted with the REST passthrough, `POST /api/sdk/passthrough/api/actions` as `application/xml`, which needs **Can use REST API**. The result shows the action ID, a link to `/framework/deployments/<id>`, and **Check status** (`GET api/action/<id>/status`).

## The wipe action

The template is [`actions/Wipe_MDM_device_from_WebUI.bes.mustache`](../../actions/Wipe_MDM_device_from_WebUI.bes.mustache). `pack.py` copies it into the package, so there's one copy.
- **Title:** `Wipe MDM device from WebUI Custom App: {{Hostname}} ({{ComputerID}}) - {{Reason}}`
- **Relevance:** `computer name as lowercase = "{{Hostname}}" as lowercase`, so the action doesn't run if the ID now belongs to a renamed device. Whether `computer name` evaluates on MDM devices is **not confirmed yet**; if it errors there, the action is never relevant and nothing happens.
- **Target:** `<ComputerID>{{ComputerID}}</ComputerID>` only.
- **No end time:** the template has no `<Settings>`, so the action stays open until the device reports, however long that takes; only the name check stops it on a device that was renamed. What end time the server sets when `<Settings>` is missing is not confirmed. **Planned, deferred for now:** expire the wipe after 14 days.
- **MIME fields:** `x-deployment-webui-app-source` = `mdm`, and `x-deployment-webui-app-reason` = the reason.

**Escaping:** the title, the relevance and the reason's MIME value are CDATA sections in the template, so values go in as written; `build()` splits any `]]>` in a value across two CDATA sections, and XML-escapes a placeholder that isn't inside CDATA. The name is used inside a relevance string, so `%` and `"` are sent as `%25` and `%22`. A name with `%` or `"` therefore shows encoded in the title too.

**Which devices it applies to:** the template has commands for Windows, ChromeOS, Android, iOS/iPadOS and macOS, and they only work on devices managed through BigFix MDM. The app treats a device as MDM-managed when its `agent type` is anything but `Native` (compared without case; an empty agent type counts as unknown and doesn't qualify). Any other agent type qualifies too, and so would a proxy agent's, if one reports an OS the template covers; the log lists the agent types it found on each load. Devices with no computer name don't qualify either, because the action's name check could never match. The check is `notApplicable()` in [`actions.js`](src/static/js/actions.js).

## Adding an action

Add an entry to `DDA.ACTIONS` in [`actions.js`](src/static/js/actions.js) with `id`, `label`, `verb`, `template`, `warning` and `notApplicable(device)`. Then add the template file name to `EXTRA_FILES` in `pack.py`. A template can use only the placeholders in `PLACEHOLDERS`, and its action must target `<ComputerID>{{ComputerID}}</ComputerID>` alone.

## Build and install

```bash
python3 pack.py
```

Then **Install extension from file** in Extensions Management with `output/destructive-device-actions-<version>.webui`. Bump `version` in `package.json` and `VERSION` in `src/static/js/app.js` together.

## Files

| File | Purpose |
| --- | --- |
| `src/index.html` | Layout: toolbar, device table, result, log, and the confirmation dialog |
| `src/static/js/actions.js` | The actions, the applicability check, the reason rules, and `DDA.build()` |
| `src/static/js/app.js` | Device list, search, confirmation, sending, status |
| `src/static/css/app.css` | Styles |
| `pack.py` | Builds the package with `../shared/webui_pack.py`, adding `webui-relevance.js`, `webui-frame.js`, `webui-api.js`, `webui-log.js` and the action templates |

## Testing status

- **Mock WebUI (0.1.0):** the mock served the build with the extension CSP and required XSRF, and had 308 fake devices, including a duplicate name, a stale device, a device with no name, and a name with `'`, `"` and `%`. These were checked:
  - search, the 200-row limit, applicability, and duplicate and stale flags
  - the dialog's details, cautions and focus; the reason rule (`a b c` refused, a ticket number accepted); Enter blocked
  - the posted XML for a name with `'`, `"` and `%` and a reason with `<&>"]]>`, which parsed, with the relevance text as intended
  - a rejected POST, which keeps the dialog open with the error and a Retry button
  - while sending: typing in the reason box, a second click, Cancel and Esc can't send twice or close the dialog
  - devices with no name are not applicable, and a multi-target template is rejected
  - a renamed device, which stops before the dialog
  - the action ID, its link, and the status read
  - the copied report
- **Real server:** not tested. Still to confirm there:
  - the `agent type` values on the server, so that only MDM devices are something other than `Native`
  - whether `computer name` evaluates on MDM devices
  - the `POST api/actions` response's `<ID>`
  - the status XML shape
  - that WebUI serves the `.mustache` template from the package (if it doesn't, building the action fails and nothing is sent)

  The real wipe must not be used for that: test with a copy of the action that has an empty action script.
