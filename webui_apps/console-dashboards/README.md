# Console Dashboards - BigFix WebUI extension

Runs **BigFix console dashboards** (`.ojo` wizard files) inside WebUI. It is the console counterpart of the [Web Reports Renderer](../web-reports-renderer/): console dashboards can do everything a Web Reports custom report can and more, so this app loads the renderer's whole Web Reports layer (now in [`../shared/wr/`](../shared/wr/)) and adds the rest of the console's dashboard JavaScript API on top, in [`console-shim.js`](src/static/js/console-shim.js). Plain HTML and JavaScript, no HCL code, packaged by `pack.py`. The current version is **1.0.4**.

1. **Choose a dashboard:**
   - **from a BigFix site:** the **Dashboard** drop-down lists what session relevance's `bes wizards` returns, grouped by site. Custom sites show by default; **External sites** adds BES Support and the other HCL sites, most of whose dashboards need console features WebUI doesn't have.
   - **or a file:** **Choose file…**, or drop a `.ojo` anywhere on the page. Plain dashboard HTML (no `<Wizard>` XML) works too.
2. **The wizard XML is read:** `Title`, `UIHooks`, `DefaultPage`, and each `<Page>`'s `Title`, `Head` and `HTML`.
3. **Every `<?Relevance ?>` in the page's `Head` and `HTML` is replaced** with its result, as the console does when it loads a page, together with `<?BeginRefreshRelevance?>` sections and the `<?hxlat?>` / `<?jxlat?>` localization instructions.
4. **The page renders in a same-origin iframe** with the shared Web Reports layer and `console-shim.js` loaded first. The dashboard's console API calls are answered through WebUI (see [The console API here](#the-console-api-here)).
5. **`linkpage:` links switch pages** of a multi-page wizard and carry `TheDataStore`'s contents across, as the console does. A **Page** drop-down appears for wizards with more than one page.
6. **Copy report**, under the collapsed **Log**, gives every relevance evaluation, console API call (`CONSOLE` lines), script error and blocked file as one block of text.

## The console API here

**Why it can be close to 1:1:** almost everything a dashboard does in the console has a WebUI SDK operation or a platform REST resource behind it, reached through the SDK passthrough. The console's functions are synchronous, so the mapped calls use synchronous `XMLHttpRequest`, as the renderer's `EvaluateRelevance` already does. The few that are asynchronous in the console (`TakeFixletAction`, the callback forms) stay asynchronous.

**Changes ask first.** With **Ask before changes** on (the default, under **Config**), anything that changes BigFix shows a `confirm()` naming the change, standing in for the console's password prompt. Cancelling returns what the console returns for a cancel: `undefined` from `ImportXML`, a `UserCancelled` exception from `EditFixlet`, `false` elsewhere.

| Console API | Here | Status |
| --- | --- | --- |
| `EvaluateRelevance`, `Relevance` (sync and async), `AsyncEvaluateString`, `WR.*` | The shared Web Reports layer: typed REST query, SDK fallback | confirmed |
| `<?Relevance ?>`, refresh sections, `ManualRefresh(id)`, `ManualRefreshAll()` | Evaluated before render; sections re-evaluate on a timer, or on `ManualRefresh` only when that is their only attribute | confirmed |
| `<?hxlat ?>`, `<?jxlat ?>` | The text, HTML-escaped / JS-string-escaped (no translations) | confirmed |
| `current wizard` | Rewritten to the `.ojo` file name, the console's dashboard id. `dashboard id`, `name`, `link` and `exists` of `current wizard`, and `private` / `shared variable "X" of current wizard`, are answered by the page itself (see below) | confirmed |
| `StoreVariable`, `StorePrivateVariable`, `StoreSharedVariable`, `DeleteVariable`, `DeletePrivateVariable`, `DeleteSharedVariable` (and `external.*`) | `/api/sdk/dashboardvariable/{id}/{name}`; synchronous console forms, and Web Reports' callback forms of the shared ones | confirmed |
| `RegisterRelevance(expr, callback, id)` | Called at registration, after each variable write made through this page, and when a 30-second poll sees a change; `"false"` unregisters | confirmed |
| `RegisterRefreshHandler(id, signal)` | The element's `onclick` gets `RefreshCycle` on a timer (Config, default 60 s), and `Actions` / `CustomContent` after this page changed them | confirmed |
| `InsertUtilityDiv()` and the predefined ids | Hidden elements with the console's ids (`theRegisterRefreshSignalName`, `theScratchFileResult`, …); also added on load | confirmed |
| `ImportXML(xml, openDocuments, site, computerIDs)`, `ImportXMLToSite` | Content: `POST /api/sdk/site/custom/{site}/import` or `…/operator/import`. Actions (`SingleAction`, `MultipleActionGroup`, `SourcedFixletAction`): REST `POST api/actions`. Returns the new ids. `openDocuments` opens WebUI pages | confirmed for content |
| `EditFixlet(id, xml)` | `PUT /api/sdk/resources/{type}/{id}/edit`, type from the XML | confirmed |
| `DeleteFixlet(id)`, `DeleteFixlets(ids)` | `POST /api/sdk/resources/{type}/delete`, type from relevance (custom, master and operator site content) | confirmed |
| `TakeFixletAction`, `TakeSecureFixletAction`, `…OnComputers` | **A Take Action dialog in this page**: applicable computers or custom relevance as targets, the action's parameters (read from its script) and secure parameters, a title. Deploy creates a `SourcedFixletAction` with REST `POST api/actions`, then calls `callback(actionID)` | confirmed (plain, with parameters) |
| `StopAction`, `StopActions` | `POST /api/sdk/actions/stop` | confirmed |
| `API.Get / Post / Put / Delete / DoRestAPIRequest` | The SDK passthrough to `api/<uri>`; `callback(error, status, body)` | confirmed |
| `OpenComputerGroup(ids, title)` | A dialog listing the computers, each linked to its WebUI device page (WebUI has no ad hoc group page) | confirmed |
| `external.OpenWizard(site, id)`, `linkid:openwizard(...)` | This app in a new tab, `#dashboard=<file>&siteid=<id>` | not run on the server |
| `linkid:` links | Computers, actions and fixlets as in the renderer; also `allComputers`, `fixletActions`, `customTask`, … to WebUI lists | confirmed (computers, actions, fixlets in the renderer) |
| Scratch folder: `GetScratchRootPath`, `MakeFolder`, `WriteFile`, `CopyFile`, `CopyFolder`, `MoveFile`, `Delete*`, `GetFileSize`, `GetFileSHA1`, `CalculateFileInfo`, `LoadPresentation` | A folder in the page's memory (the **Scratch files** panel), shared by the dashboard's pages and gone when the page closes. `WriteFile` stores `\r\n` as `\n` like the console; SHA-1 and SHA-256 are computed synchronously | confirmed: the same hashes as the real console for the same writes |
| `BrowseForFile`, `BrowseForFolder`, `DoBrowseDialogWithFlags` | A `prompt()` listing files added under **Scratch files** (a browser can't open a file dialog synchronously); `""` (Cancel) when there are none | mechanics only |
| `DownloadFile`, `DownloadFileWithSHA1`, `DownloadFileEx` | Same-origin URLs only (the extension policy blocks other hosts), into the scratch folder | not run on the server |
| `AddFileToSite`, `AddFileToMailbox` | `POST /api/sdk/site/custom/{site}/file` or `…/operator/file`, and `/api/sdk/mailbox/{id}` (which stores the file but answers 500 on 11.0.7, so the mailbox is checked) | not run on the server |
| `ActivateAnalysis(es)`, `DeactivateAnalysis(es)`, `ReactivateAnalysis(es)`, `BESFixletID` | `POST /api/sdk/analyses/activate` / `deactivate` with `{siteID, analysisID}` from `"siteid:analysisid"` | **not run on the server** |
| `CreateCustomSite`, `DeleteProperty`, `DeleteProperties` | `POST /api/sdk/site/custom`; REST `DELETE api/property/{id}` | **not run on the server** |
| `ToggleSectionVisibility`, `ExpandAll`, `CollapseAll`, `ToggleAll`, `ToggleVisibility`, `BooleanToText`, `hasClass`, `MakeIDListFromArray`, `ColorizeRelevance` | Reimplemented for the console's section markup (`div.section > .sectionHeader img.collapse + .sectionBody`); `ColorizeRelevance` returns escaped text | confirmed |
| `ActiveXObject` | Only when the dashboard's own source mentions it. `Microsoft.XMLDOM` works (DOMParser and XPath); `WScript.Shell` and `Scripting.FileSystemObject` are stubs whose methods throw; any other ProgID throws as IE does for a missing control | confirmed |
| `data:` images | Shown as `blob:` URLs, in the HTML and when added later | confirmed |
| `common.css`, `commonBlue.css` | Stand-ins written for this app ([`static/css/console/`](src/static/css/console/)): the console's own files don't exist outside it | confirmed |
| `UploadFile`, `ArchiveAndUploadFile(2)`, `UploadFileEx`, `UploadFileWithName`, `ArchiveAndUploadFileEx` | **Not available**: return the console's `"Error: …"` or call `failure` | see below |
| `MakeArchive`, `CompleteHashSet` | **Not available** (`Error: …` / `failure`) | |
| `SendWakeOnLANRequest`, `EnableWakeOnLAN` | No-ops: WebUI has no wake-on-LAN API; returns `"not implemented"`, as the console does when wake-on-LAN is off | |
| `OpenFindDialog`, `AddGlobalFilter`, `ClearAllGlobalFilters`, `ClearGlobalFilterOfType` | No-ops: WebUI has no global filters | |
| `GetCurrentDSN`, `GetCurrentUser` | `""`, and the WebUI user name | |
| Dialog wizards (`LaunchType="Dialog"`) | Shown as pages; the OK button's `theXMLToImport` import doesn't run | |

## Facts found on a live WebUI (BigFix 11.0.7.61, 31 Oct 2026)

- **`bes wizards` lists the dashboards in sites:** 164 in 24 sites, in about 0.5 to 2 s, with BES Explorer and with Web Reports answering. `dashboard id of <wizard>` is the `.ojo` file name. `url of <wizard>` is `siteid:<id>,<file>` for external sites but **BES Explorer's own file path** (`file:///C:\…\CustomSite_<name>\<file>`) for custom sites, so the file is located by name in the site's REST file list instead.
- **A dashboard id with only variables is not a `bes wizard`** (seen with BES Explorer answering): after storing a private and a shared variable for a new id, `exists bes wizard whose (dashboard id of it = "<id>")` was `False`, and `shared variable "x" of …` / `private variable "x" of …` / `variables of …` all failed with *Singular expression refers to nonexistent object*. That is why the page answers the `… of current wizard` forms from `GET /api/sdk/dashboardvariable/{id}` itself. A missing variable becomes the nonexistent string `(substring after "a" of "b")`, so `exists` gives `False` and using it gives the console's error.
- **SDK import responses are JSON:** `POST /api/sdk/site/operator/import` answered `{"done":true,"value":{"BESAPI":{"Task":{"Name":"…","ID":"<id>"}}},"id":{}}`, not BESAPI XML.
- **New content takes a few seconds to show in relevance** (BES Explorer answering): `names of bes fixlets whose (id of it = <new id>)` was empty right after the import and found it within about 10 s. The Take Action dialog waits up to 30 s for it.
- **A sourced action through the REST passthrough works:** `POST /api/sdk/passthrough/api/actions` with `<SourcedFixletAction><SourceFixlet><Sitename>ActionSite</Sitename><FixletID>…</FixletID><Action>Action1</Action></SourceFixlet><Target><CustomRelevance>false</CustomRelevance></Target><Parameter Name="p1">…</Parameter><Title>…</Title>` created the action, with the parameter. `name of site of <master-action-site fixlet>` is `ActionSite`, which `Sitename` accepts. `POST /api/sdk/actions/stop`, then passthrough `DELETE api/action/{id}` (`200 ok`) removed it; reading it afterwards was 404.
- **The passthrough can't forward a file body:** `POST /api/sdk/passthrough/api/upload` with `text/plain` got `400 Files were not supplied in request body`; with `multipart/form-data` (fields `file`, `files`, `upload`, `data`, `file[]`, and `api/uploads` too) it got `500 The "string" argument must be of type string or an instance of Buffer or ArrayBuffer. Received an instance of Object`. Retested on 1 Nov 2026 with every body the [REST upload docs](https://developer.bigfix.com/rest-api/api/upload.html) allow: a raw `application/octet-stream` body with `Content-Disposition: attachment; filename="…"`, and a hand-built multipart string or `Blob` with an explicit boundary, all got the same 500. `text/plain` and `application/xml` bodies, with or without `Content-Disposition`, got the 400. WebUI's own `/api/openapi.json` lists only `application/xml` and `text/plain` bodies for `POST passthrough/{uri}`, so it doesn't forward binary or multipart bodies, and the REST server never receives a file. So there is no route to the server's Uploads folder, which `UploadFile` needs. (`GET passthrough/api/uploads` works, read-only.)
- **`api/help` through the passthrough** lists these resources: action(s), admin, analyses/analysis, archivemanager, baseline(s), clientquery(results), computer(s), computergroup(s), dashboardvariable(s), explorer(s), fixlet(s), help, idp…, import, ldap…, login, mailbox, operator(s), peernestmetrics, properties/property, query, replication, role(s), site(s), task(s), token(s), upload(s), webreports. `api/help/action` lists `DELETE /api/action/{id}` and `POST /api/action/{id}/stop`; `api/help/property` lists `DELETE /api/property/{id}`.
- **BES Explorer stopped answering during testing** (about 23:27 local time), while this app was rendering the external sites' dashboards in a loop. WebUI fell back to Web Reports (about 3.6 s per request, `in web reports context` true). Whether the load caused it isn't known. Several BES Support dashboards call relevance from their own `window.onerror`, so with every synchronous call taking 3.6 s, one script error made the page unresponsive for minutes.

## Known limitations

These can't be done in WebUI, or are done differently on purpose. Each was seen on 11.0.7.61 unless it says otherwise.

**No WebUI route for it:**

- **No file uploads to the server's Uploads folder** (`UploadFile`, `UploadFileEx`, `UploadFileWithName`, `ArchiveAndUploadFile(2)`, `ArchiveAndUploadFileEx`): the passthrough doesn't forward binary or multipart bodies (see the fact above). They return the console's `"Error: …"` or call `failure`. `AddFileToSite` and `AddFileToMailbox` use the SDK's own multipart endpoints instead.
- **`MakeArchive` and `CompleteHashSet`** have no equivalent and fail the same way.
- **Wake-on-LAN and global filters** are no-ops: `SendWakeOnLANRequest` / `EnableWakeOnLAN` return `"not implemented"`; `OpenFindDialog`, `AddGlobalFilter`, `ClearAllGlobalFilters` and `ClearGlobalFilterOfType` do nothing.
- **`GetCurrentDSN`** returns `""`.
- **`OpenComputerGroup`** shows a dialog instead of a computer group page: WebUI has no ad hoc group page.
- **Refresh signals:** WebUI can't tell a page when BigFix data changes, so only `RefreshCycle` (on a timer) and the `Actions` / `CustomContent` signals for changes made through this page fire. `RegisterRelevance` likewise re-evaluates only on a 30-second poll and after variable writes made here.

**What a browser can't do:**

- **No synchronous file dialog:** `BrowseForFile`, `BrowseForFolder` and `DoBrowseDialogWithFlags` can only offer files added under **Scratch files**, through `prompt()`.
- **Local disk paths don't exist:** `CopyFile("C:\\…")` only finds files under the scratch root (`C:\WebUIScratch\`) or the added local files (`C:\WebUILocal\`). The scratch folder lives in the page's memory and is gone when the page closes.
- **Downloads are same-origin only:** the extension's security policy blocks other hosts, so `DownloadFile` and its variants can't fetch from the internet or a relay.
- **`location.href = "linkpage:Name"` can't be intercepted** (a browser doesn't let a page hook that assignment). Links (`<a href="linkpage:…">`) and `window.navigate("linkpage:…")` work.
- **ActiveX:** only `Microsoft.XMLDOM` works. `WScript.Shell` and `Scripting.FileSystemObject` are stubs whose methods throw, and any other ProgID throws as IE does for a missing control.

**Done differently:**

- **Plural `<?Relevance ?>` results** are joined with nothing, like the console: its Presentation Debugger renders `<?Relevance integers in (1,10) ?>` as `12345678910` (seen on 11.0.7, 1 Nov 2026). Web Reports joins them with `<br />`; **Config** offers that and "newline" too. DashboardFeatureTester's `pi.pluralJoin` test reports the exact separator a host uses.
- **Changes ask with `confirm()`** instead of the console's password prompt, and only for the console functions this app maps (see [Security](#security)).
- **Dialog wizards** (`LaunchType="Dialog"`) are shown as pages; the OK button's `theXMLToImport` import doesn't run.
- **`<?hxlat ?>` / `<?jxlat ?>`** give the original text; there are no translations.
- **`common.css` and `commonBlue.css`** are stand-ins written for this app, not the console's own files, so console-styled dashboards look close but not identical.

**Missing files and relevance:**

- **DataTables Buttons 1.2.4** (`cdn.datatables.net/buttons/…`) isn't on cdnjs, so it isn't bundled; dashboards that use it (**BaselineStatusResults**) lose their export buttons.
- **Console-only scripts** that external-site dashboards load by name (`common.js` and others) don't exist here.
- **Relevance BES Explorer doesn't support** fails as it does in the renderer, for example **ComputerSummary**'s `display names of subscribed sites`.
- Everything in the [Web Reports Renderer's limitations](../web-reports-renderer/README.md#known-limitations) that concerns relevance, site files and the extension's security policy applies here too.

## Not settled or not tested yet

**Implemented but not run on the server:**

| Function | What is unknown |
| --- | --- |
| `ActivateAnalysis(es)`, `DeactivateAnalysis(es)`, `ReactivateAnalysis(es)` | Whether the SDK endpoints work, and which `siteID` a custom-site analysis needs (the open question in [../README.md](../README.md#open-questions)). The test (activate an inactive custom analysis, then deactivate it) was blocked by a permission check and not retried. |
| `CreateCustomSite` | Whether `POST /api/sdk/site/custom` takes the console's arguments as mapped. A test needs a throwaway site deleted afterwards. |
| `DeleteProperty`, `DeleteProperties` | Whether REST `DELETE api/property/{id}` through the passthrough works (it is listed in `api/help/property`). |
| `AddFileToSite`, `AddFileToMailbox` | Whether the SDK multipart endpoints work as mapped; the mailbox endpoint is expected to answer 500 while still storing the file. |
| `TakeSecureFixletAction` | Whether the REST API accepts `<SecureParameter>` elements in a `SourcedFixletAction`. |
| `TakeFixletAction…OnComputers` | Only the relevance-targeted form was deployed; targeting listed computer ids wasn't. |
| `ImportXML` of actions | Action XML (`SingleAction`, `MultipleActionGroup`, `SourcedFixletAction`) is sent to REST `POST api/actions`; that endpoint works when called directly, but not through `ImportXML`. |
| `DownloadFile`, `DownloadFileWithSHA1`, `DownloadFileEx` | Not run at all. |
| `external.OpenWizard`, `linkid:openwizard(…)` | Not run; the new tab's `#dashboard=…&siteid=…` link is untested. |
| `linkid:` targets beyond computers, actions and fixlets | `allComputers`, `fixletActions`, `customTask` and the other WebUI list links were only checked by reading the code. |
| `BrowseForFile` and friends | Only the mechanics were checked locally. |
| Dialog wizards | None of this repo's dashboards is one, so none was tried. |

**Open questions:**

- **Plural join in a real dashboard:** the Presentation Debugger shows nothing between results; DashboardFeatureTester 2026-11-01.1 or later should confirm it in a dashboard, where `pi.pluralJoin` should report `separator "" [empty]`.
- **Why BES Explorer stopped answering** during the external-site sweep (see the fact above), and whether this app's load caused it.
- **External-site dashboards:** 7 of 145 were tried. How many can work with stand-ins for their console-only scripts isn't known.
- **Web Reports answering:** everything above was tested with BES Explorer answering, except what ran after it stopped. Results with Web Reports answering (slower, `in web reports context` true, different `%` handling) weren't checked dashboard by dashboard.
- **Non-master operators:** every test ran as a master operator. Permission errors, and the fallback when the operator lacks **Can use REST API** (no typed results, no REST passthrough for actions), weren't tried.
- **Shared dashboard variables:** writing under the real `.ojo` id shares data with the console (1:1, by design); whether that is wanted for every dashboard isn't decided.
- **Other BigFix versions:** only 11.0.7.61 was tested. A later WebUI might forward upload bodies, which would let `UploadFile` work.
- **Version 1.0.4** (the plural-join option and its new default) is installed on the server (1 Nov 2026) and loads with the join set to nothing, but dashboards weren't re-run with it; 1.0.2 is the last version fully tested there.

## Security

As in the renderer, the dashboard runs in a **same-origin** iframe, so its JavaScript can call any WebUI or SDK API as the logged-in operator. **Ask before changes** only covers the console functions this app maps; a dashboard that calls `fetch` itself isn't asked about. Only run dashboards you trust, as in the console.

Dashboard variables are written under the dashboard's real id (its `.ojo` file name), so a dashboard here shares its variables with the same dashboard in the console. That is the point (1:1), but it also means a test here changes the console's data.

## Build

```bash
python3 fetch_libs.py
```

```bash
python3 pack.py
```

`fetch_libs.py` is the renderer's, with the extra libraries the dashboards in [`../../dashboards`](../../dashboards) load (jQuery 3.3.1, jQuery UI unminified, Modernizr, Detectizr, Highcharts 5.0.6, Moment, List.js, SlickGrid 2.4.0, and DataTables' ellipsis plug-in, which is byte-identical to cdnjs 1.10.15). 60 files, about 5.4 MB on disk; the `.webui` is about 1.8 MB. `pack.py` adds the shared files from `../shared/` (`webui-relevance.js`, `webui-frame.js`, and `wr/relevance.js`, `wr/shim.js`, `wr/companions.js`) as `static/js/<name>`. Bump `version` in `package.json` and `VERSION` in `src/static/js/app.js` together.

## Install

As for the other apps: **Extensions Management** → **Install extension from file**, pick a custom site, upload `output/console-dashboards-<version>.webui`, **Install** (and **Confirm upgrade extension** for a newer version). Then open `/ui_extensions/console-dashboards-<siteId>`. A dashboard can be linked to directly with `#dashboard=<file>.ojo&site=<site name>`.

## Files

| File | Purpose |
| --- | --- |
| `src/index.html` | Toolbar (dashboard drop-down, External sites, Reload list, Render again, Choose file), title line with the Page drop-down, the iframe, Log, Scratch files, Config, and the dialog overlay |
| `src/static/js/app.js` | Wizard XML parsing, relevance and localization substitution, refresh sections and signals, CDN rewriting, rendering, `linkpage:` and `TheDataStore`, the scratch folder, the Take Action and computer group dialogs, `OpenWizard`, the `current wizard` answers, and the log and report |
| `src/static/js/dashboards.js` | The dashboard list (`bes wizards`) and loading a dashboard and its site's files |
| `src/static/js/console-shim.js` | The console's dashboard API in the iframe (see the table above) |
| `src/static/css/app.css` | Page styles (the renderer's, plus the dialog and table styles) |
| `src/static/css/dashboard.css` | Base styles inside the iframe (the renderer's `report.css`) |
| `src/static/css/console/common.css`, `commonBlue.css` | Stand-ins for the console's stylesheets of the same names |
| `../shared/wr/*.js` | The Web Reports layer shared with the renderer |
| `fetch_libs.py`, `libs.lock.json`, `pack.py`, `.gitignore` | As in the renderer |

## Testing status

**Real WebUI, BigFix 11.0.7.61, master operator, with BES Explorer answering** (versions 1.0.0 to 1.0.2):

| Check | Result |
| --- | --- |
| SDK API Tester's **Run all safe tests**, before starting | 25 of 25 PASS |
| Dashboard list | 164 dashboards in 24 sites from `bes wizards`; 19 in the custom site holding this repo's dashboards |
| All 19 of those, rendered one after another | All rendered. No relevance failures except **ComputerSummary**'s `display names of subscribed sites`, which BES Explorer doesn't support (also seen in the renderer). No script errors from the shims. Blocked only: DataTables Buttons in **BaselineStatusResults**. |
| **Dashboard_Variables** | 580 variables in DataTables with row grouping, 547 ellipsis cells (the aliased plug-in) |
| **ComputerSummary** | 6 of 7 relevance instructions, 34 sections; `CollapseAll`, `ExpandAll` and the header images' `ToggleSectionVisibility()` work; `collapse.gif` came from the bundled SlickGrid by the same name |
| **Screenshots**, **Computer_Filter_Search** | `data:` images shown as `blob:` URLs, nothing blocked (1.0.0 had them blocked) |
| **AnotherRelevanceTester** | `new ActiveXObject("WScript.Shell")` at load gives a stub, and the rest of its script runs (1.0.0 defined ActiveXObject for every page, which made Modernizr/Detectizr report QuickTime, Flash, PDF and others as installed; fixed in 1.0.1) |
| **DashboardFeatureTester.ojo** (uploaded), its own **Run all safe tests** | **50 PASS, 0 FAIL, 2 WARN** (`CompleteHashSet`, `MakeArchive`), 12 INFO. 76 of 76 documented console functions present. Scratch-folder SHA-1 and SHA-256 were the same as the real console's for the same writes. `MoveFile` and `LoadPresentation` work (both are broken in the real 11.x console). `RegisterRelevance` fired `false`, `false`, then `true` about 670 ms after the trigger, the same pattern as the console. |
| Its `linkpage:SecondPage` and back | Page 2 received `TheDataStore` while loading (1.0.1 restored it too late), and the line page 2 added was back on page 1 |
| Content lifecycle through the console API (all cleaned up) | `ImportXML` → `[id]`; `EditFixlet` → title changed; `TakeFixletAction(id, masterSiteId, "Action1", {p1: …}, cb)` → the dialog showed the task, its action description, `p1` prefilled and 0 applicable computers; Deploy with target relevance `false` → `cb(actionId)`, and the action's XML had the parameter and target; `StopAction` → `true`; `API.Delete("action/<id>")` → `200 ok`; `DeleteFixlet` → `true`; task and action read back 404 |
| `OpenComputerGroup([two real ids, 1], title)` | Dialog with the 2 that exist, linked to WebUI device pages |

**Not run on the server:** see [Not settled or not tested yet](#not-settled-or-not-tested-yet).

**Local checks:** `node --check` on every script; the synchronous SHA-1 and SHA-256 against Node's `crypto` for 13 lengths including the padding boundaries (0, 55, 56, 63, 64, 119, 120 bytes, …); the renderer's package rebuilt byte-identical after its files moved to `../shared/wr/`.

## Ideas not done yet

- **Uploads:** if a later WebUI passthrough forwards file bodies, map `UploadFile` and its variants to REST `POST api/upload`.
- **External sites:** go through BES Support's dashboards one by one (with BES Explorer answering), and add stand-ins for the console-only scripts they load by name (`common.js` and others) where the functions are simple.
- **Refresh on data change:** poll a cheap change marker (for example the latest action id and custom content modification time) and send the matching signals.
