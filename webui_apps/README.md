# BigFix WebUI custom apps (UI extensions)

Notes on building custom apps for the BigFix WebUI with the WebUI SDK. HCL calls these "UI extensions" or "WebUI custom apps". These notes collect what we know so far. Each item says whether it was **confirmed** (seen in code, a build, or the HCL docs) or is **planned** (listed as planned but not yet seen working).

Examples in this folder. Each one builds into a `.webui` file:

| Example | Stack | HCL code in the build | Build needs | `.webui` size |
| --- | --- | --- | --- | --- |
| [sdk-api-tester](sdk-api-tester/) | Plain HTML/JS. Calls all 26 SDK operations as examples and tests, with a copyable log and report. | none | Python 3 (`pack.py`) | about 18 KB |
| [web-reports-renderer](web-reports-renderer/) | Plain HTML/JS "Web Reports Renderer". Pick a custom report stored in a BigFix site (scripts and CSS load from the same site; the list is cached in a shared dashboard variable), or upload one; its `<?Relevance ?>` and JavaScript `EvaluateRelevance` / `Relevance` / `AsyncEvaluateString` calls run through the SDK API, and its CDN libraries are served from local copies. | none | Python 3 (`fetch_libs.py`, `pack.py`) | about 1.3 MB (about 12 KB without the libraries) |
| [session-relevance-query-html](session-relevance-query-html/) | Plain HTML/JS "Relevance Query", with [bigfix-relevance-analyzer](https://github.com/jgstew/bigfix-relevance-analyzer) running as WebAssembly. Auto mode runs client relevance as a BigFix Query and session relevance through the SDK API. | none | Python 3 (`fetch_analyzer.py`, `pack.py`) | about 8.5 MB (about 10 KB without the analyzer) |
| [session-relevance-query](session-relevance-query/) | React on the WebUI SDK template, with `BfApp` providing the standard WebUI nav bar | `bfcore-react` and Patronus | Template, Node, HCL network | about 2.2 MB |

## What a custom app is

- It is front-end only: HTML, JS, CSS, and fonts. **No back-end code is ever installed on the WebUI server.**
- The official way to build one is with React and HCL's WebUI SDK app template, which uses the `bfcore-react` WebUI components and the HCL Patronus design system. You can also hand-write the HTML, as long as the package has the same layout (see [Plain HTML without the template](#plain-html-without-the-template)).
- It is packaged as a `<name>-<version>.webui` zip and installed into a **custom site** (or delivered from an **external site**). Access to the app follows access to that site.
- Once installed, it is served at `/ui_extensions/<name>-<siteId>`. WebUI's **Extensions** menu opens extensions **in a new browser tab**, so the rest of WebUI is usually still open in another tab (confirmed in `bfcore-react`'s nav code).
- It talks to BigFix only through WebUI SDK REST APIs (`/api/sdk/...`). These run as the logged-in WebUI operator, so the normal BigFix permissions apply.
- It cannot read the BFEnterprise database directly. Data comes from **session relevance**, which needs **BigFix Web Reports**.

## Prerequisites

| Item | Notes |
| --- | --- |
| BigFix WebUI | WebUI extensions first shipped in the **December 2022** WebUI release (site "WebUI Extensions" version 1), alongside BigFix 10.0.8. The 10.0 and 11.0 docs both cover Extensions Management. See [History](#history). |
| Web Reports | Needed for `/api/sdk/sessionrelevance/evaluate`. |
| HCL network access | The template and the Patronus npm packages are HCL-internal. The npm registry is set in the template's `.npmrc`. |
| Node.js | The template README says Node 16. A build with Node 26 / npm 11 also worked, and only showed a bundle-size warning. |

## The template

The template's stack is React 17, react-scripts 5, `bfcore-react` 6.0.65 (shipped as `lib/*.tgz`), and `@patron/patron-react` 2.8.0.

Layout:

```
package.json         name / displayName / version / description, "homepage": "./HOMEPAGE"
src/App.js           <BfApp title=...> wrapping your root component
src/BigfixSamplesExtensions/   samples, one folder per API (see below)
public/              copied into the build; can also host plain HTML loaded through an <iframe>
validatePackage.js   checks name and version before packaging
pack.js              zips build/ into output/<name>-<version>.webui
update-extension.js  dev helper that pushes a rebuilt .webui over an existing install
```

`package.json` rules (enforced by `validatePackage.js`):

- `name` must match `/^[a-z0-9_-]*$/`.
- `version` must match `/^\d+(\.\d+)*$/`.
- `displayName` is what WebUI shows. If it's left at the default, `packit` stops and prompts for one.
- Leave `"homepage": "./HOMEPAGE"` alone. Every asset path in the built `index.html` becomes `./HOMEPAGE/...`, and on install the WebUI server rewrites that to `/ui_extensions/<name>-<siteId>/` (confirmed).

### Commands

```bash
npm install
```
```bash
npm start
```
```bash
npm run packit
```

`npm start` runs a dev server on port 3006. API calls fail there because there is no WebUI session. `npm run packit` runs `validatePackage`, then `build`, then `pack`, and writes `output/<name>-<version>.webui`.

### What is in a `.webui` file (confirmed from a build)

```
package.json                 your package.json plus "main": "./index.html"
<name>-<version>/index.html
<name>-<version>/static/js/main.<hash>.js     includes bfcore-react and Patronus (about 6 MB, 1.8 MB gzipped)
<name>-<version>/static/css/main.<hash>.css
<name>-<version>/static/media/...             Patronus fonts and icons
<name>-<version>/...                          everything else from public/
```

The bundle contains HCL-proprietary `bfcore-react` and Patronus code. **Don't commit built `.webui` files to a public repo.** The example's `.gitignore` excludes `output/`.

## Calling APIs from the app

Use `BfHttpClient` from `bfcore-react`. It is confirmed by reading the bundled code:

- It wraps axios and returns an **RxJS Observable**, so call `.subscribe({ next, error })`. Call `unsubscribe()` on unmount.
- It sends the WebUI session cookies, and sends the `XSRF-TOKEN` cookie back as an `X-XSRF-TOKEN` header. If you skip `BfHttpClient`, you have to do this yourself.
- On a 401, or an `iem-login-required` response header, it redirects to `/timeout?nextpage=...`.
- On an error, `err` is the axios response, so the server's message is in `err?.data?.message`.
- Methods: `get`, `post`, `put`, `patch`, `delete`, and `upload(url, fieldName, file)` for multipart uploads.

```js
import { BfHttpClient } from 'bfcore-react'

new BfHttpClient()
  .post('/api/sdk/sessionrelevance/evaluate', { session_relevance: 'names of bes computers' })
  .subscribe({
    next: (res) => console.log(res?.value ?? res), // the template sample reads .value; tuple rows come back as arrays
    error: (err) => console.error(err?.data?.message)
  })
```

To post XML, pass `{ headers: { 'Content-Type': 'application/xml' } }` as the third argument to `post`.

### Without `BfHttpClient`: plain `fetch`

You can call the SDK APIs with `fetch` if you do the same three things `BfHttpClient` does (from reading its bundled code). `webuiFetch()` in [session-relevance-query-html's `app.js`](session-relevance-query-html/src/static/js/app.js) does this, installed and running on a live WebUI server. The React example's [`sessionRelevanceApi.js`](session-relevance-query/src/SessionRelevanceQuery/sessionRelevanceApi.js) does the same, but that build hasn't been installed. Leaving out the `X-XSRF-TOKEN` header gets **403 `invalid csrf token`**.

Session relevance response on a live server:

- **Success:** `200 {"done": true, "value": [...], "id": {}}`. Every value is a **string**, including numbers and booleans, and a tuple row is an array of strings. `done` was `true` in every test, including one with 27,386 rows.
- **Relevance error:** `500 {"message": "..."}`, for example `The operator "error" is not defined.`

```js
const xsrf = document.cookie.split('; ').find((c) => c.startsWith('XSRF-TOKEN='))?.slice('XSRF-TOKEN='.length)

const res = await fetch('/api/sdk/sessionrelevance/evaluate', {
  method: 'POST',
  credentials: 'same-origin', // WebUI session cookies
  headers: { 'Content-Type': 'application/json', ...(xsrf && { 'X-XSRF-TOKEN': decodeURIComponent(xsrf) }) },
  body: JSON.stringify({ session_relevance: 'names of bes computers' })
})
if (res.status === 401 || res.headers.get('iem-login-required')) {
  window.location.href = '/timeout?nextpage=' + encodeURIComponent(location.pathname + location.search)
}
```

**Troubleshooting API calls on a server:** install [sdk-api-tester](sdk-api-tester/), run **Run all safe tests** (read-only, apart from one private dashboard variable that it deletes again), then expand **Log** and click **Copy report**. The report includes every request's status, timing, and error body, plus which of the 26 operations passed. Redaction of the server address and user name is on by default.

`BfApp` is the one piece that can't easily be replaced, because it provides the standard WebUI header and navigation. Since `bfcore-react` depends on Patronus, Patronus stays in the bundle even if your own code never imports it.

### What `BfApp` contains

This is from reading the minified `bfcore-react` 6.0.65 bundle. There are no docs for it.

- **Document title and translations:** sets `document.title`, and wraps the app in i18next translations. Also adds a `<link href="/fonts/fonts.css">`, which WebUI serves.
- **Navigation bar:** the logo linking to `/`; the Devices, Apps, Deployments, Reports and Extensions tabs; the gear menu; and the user and logout links. It builds these from undocumented endpoints: `/me`, `/apps`, `/platformversion`, `/ivr/api/hasAccess`, `/isRunningApp?appName=uiextensions`, `/ui_extensions/get_extensions`, `/getGearApps`, `/getUserMenu` and `/logout`.
- **Page container:** the title bar; the `bigfix` body class and theme classes from `localStorage["bigfix-webui-theme"]`; and a session keep-alive (`GET /loggedin` every 30 seconds).

## Plain HTML without the template

The `.webui` file is just a zip, so you don't need React or the template. [session-relevance-query-html](session-relevance-query-html/) is a working example. Copy these parts of the template build:

- `package.json` at the zip root, with `name`, `displayName`, `version`, `description`, and `"main": "./index.html"`.
- Files under `<name>-<version>/`, with `index.html` at the top.
- Asset references in the form `<base href="./HOMEPAGE/">` and `./HOMEPAGE/static/...`. The server rewrites `./HOMEPAGE/` to `/ui_extensions/<name>-<siteId>/`. This was confirmed with the hand-written example.
- Everything packaged in the `.webui` file (see the CSP below).

### Content-Security-Policy on extension pages (confirmed)

The WebUI server sent this policy for an installed extension:

```
default-src 'self'; img-src 'self' blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval';
style-src 'self' 'unsafe-inline'; connect-src 'self' wss:;
sandbox allow-same-origin allow-scripts allow-forms allow-popups allow-modals allow-downloads;
frame-ancestors 'self'
```

It also sent `X-Frame-Options: DENY` and `X-Content-Type-Options: nosniff`.

- **No CDNs or external hosts.** Scripts, styles, fonts, and images must ship inside the `.webui` file. `fetch` and XHR can only reach the WebUI server itself, plus any `wss:` WebSocket.
- **Inline scripts and styles are allowed** by this policy. The examples keep their own code out of inline scripts anyway, in case a later WebUI tightens the policy.
- **Images:** `img-src` allows only the server itself and `blob:` URLs, so `data:` image URLs are blocked.
- **`nosniff`:** the browser only runs a file as a script if the server sends a JavaScript `Content-Type`. `.js` files are fine. Don't count on `.mjs` working as a `<script type="module" src>`. To run an ES module, fetch its text and run it as an inline `<script type="module">`, which `'unsafe-inline'` allows.

### Large libraries and WebAssembly (confirmed)

[session-relevance-query-html](session-relevance-query-html/) runs [bigfix-relevance-analyzer](https://github.com/jgstew/bigfix-relevance-analyzer) (a Python package compiled to WebAssembly with componentize-py) inside an extension. On a real server it loaded and passed verification in about 1 second. What made it work:

- **`'unsafe-eval'`** in `script-src` lets the page compile WebAssembly (`WebAssembly.compileStreaming`).
- **`DecompressionStream("gzip")`** and **`crypto.subtle`** are available, because WebUI is served over https. The page inflates gzipped `.wasm` files in the browser and checks every file's SHA-256 before using it.
- **Glue code that fetches its own `.wasm` files:** wrap `window.fetch` so requests for those file names are answered from the verified bytes, sent as `Content-Type: application/wasm`. Run the glue inline, as in the `nosniff` note above.
- **Don't block the page:** start loading after the page is usable, and keep a fallback path (here: plain session relevance) until the library is ready or if it fails.
- **Keep big binaries out of git:** a fetch script downloads a pinned release (version plus SHA-256) into a git-ignored folder that the packager includes. See [`fetch_analyzer.py`](session-relevance-query-html/fetch_analyzer.py).

For a minimal stand-in for `BfApp`, show the user name from `GET /me`, ping `GET /loggedin` every 30 seconds, and link to `/` and `/logout`. The example's [`pack.py`](session-relevance-query-html/pack.py) builds the zip with only the Python standard library.

### SDK endpoints

The SDK endpoints only need **Can use WebUI**. The platform REST pass-through needs **Can use REST API** as well.

This is the complete list of 26 operations, taken from the server's own OpenAPI spec (`GET /api/openapi.json`, "WebUI SDK APIs") on BigFix 11.0.7. [sdk-api-tester](sdk-api-tester/) calls every one of them. Every response is an `objectResponse`: `{"done": true, "id": ..., "value": ...}`.

| Purpose | Endpoint | Request |
| --- | --- | --- |
| Evaluate session relevance | `POST /api/sdk/sessionrelevance/evaluate` | `{"session_relevance": "..."}` |
| Get content | `GET /api/sdk/resources/{type}/{id}` | `type` is one of `fixlet`, `task`, `analysis`, `baseline`, `computergroup`. Works in custom, master and operator sites, and returns BES XML. |
| Get content from an external site | `GET /api/sdk/resources/{type}/external/{siteName}/{id}` | |
| Edit content | `PUT /api/sdk/resources/{type}/{id}/edit` | BES XML (`application/xml`) |
| Delete content | `POST /api/sdk/resources/{type}/delete` | `{"ids": [<int>, ...]}` |
| Dashboard variables | `GET /api/sdk/dashboardvariables` (all), `GET /api/sdk/dashboardvariable/{dashboardId}`, and `GET/POST/PUT/DELETE /api/sdk/dashboardvariable/{dashboardId}/{name}` | POST/PUT body: `{"value": "...", "private": true}`. A missing `private` means private. **When a private and a shared variable have the same name:** `GET …/{name}` returns `500 ".response.value should be object"`, and one `DELETE …/{name}` **removes both** (confirmed on 11.0.7). See [web-reports-renderer](web-reports-renderer/README.md#dashboard-variable-sdk-api-quirks) for a workaround. |
| Platform REST passthrough | `GET/POST/PUT/DELETE /api/sdk/passthrough/{uri}` | The `uri` **must include `api/`**, for example `passthrough/api/sites`. POST/PUT take `application/xml` or `text/plain`. Needs **Can use REST API**. |
| Stop actions | `POST /api/sdk/actions/stop` | `{"ids": [<int>, ...]}` |
| Activate / deactivate analyses | `POST /api/sdk/analyses/activate`, `.../deactivate` | `{"analyses": [{"siteID": "<digits>", "analysisID": <int>}]}` |
| Create custom site | `POST /api/sdk/site/custom` | `{"siteName": "..."}` (1 to 32 characters) |
| Import BES XML | `POST /api/sdk/site/custom/{siteName}/import`, `POST /api/sdk/site/operator/import` | BES XML (`application/xml`) |
| Upload a file | `POST /api/sdk/site/custom/{siteName}/file`, `POST /api/sdk/site/operator/file` | multipart field `file`; query `force=true` to overwrite, `isClientFile=1` to let clients download it |
| Add a file to a computer's mailbox | `POST /api/sdk/mailbox/{computerId}` | multipart field `file`. **Bug seen on 11.0.7:** the file is stored, but the call returns `500 Cannot read properties of undefined (reading 'ID')`. Check with a passthrough `GET api/mailbox/{computerId}`. |
| BigFix Query | `POST /api/sdk/clientquery`, then `GET /api/sdk/clientqueryresults/{queryId}` | `{"ClientQuery": {"ApplicabilityRelevance": "true", "QueryText": "...", "Target": {"ComputerID": [...]}}}`. `Target` takes exactly one of `ComputerID`, `ComputerName`, `ComputerGroup` or `CustomRelevance`. The results URL takes `filter`, `stats=1`, `start` and `count`. |

#### Responses seen on a live server (BigFix 11.0.7.61)

| Call | Response |
| --- | --- |
| Session relevance | `{"done": true, "value": [...], "id": {}}`. Values are strings, and tuple rows are arrays of strings. |
| Get content | BES XML whose first element matches the type (`<Fixlet>`, `<Task>`, `<Analysis>`, `<Baseline>`, `<ComputerGroup>`) |
| Get content, unknown id | `404 {"message": "Resource with id <id> does not exists."}` |
| Get content, bad `resourceType` | `400`, with a message listing the allowed values |
| Import BES XML | BESAPI XML containing the new item's `<ID>` (used for the edit and delete that follow) |
| Edit, then delete content | Both succeed. After a delete, reading the item returns 404. |
| Upload a file | `{"done": true, "id": <fileId>, "value": "The file <name> was uploaded with ID: <fileId> on site <site>"}` |
| Stop actions | An array with one `{"done": true, "value": "ok", "id": <actionId>}` per action |
| All dashboard variables | `value` is an array of `{Dashboard, Name, IsPrivate, User, Value}`, **including other operators' variables** (692 variables, about 788 KB, on the test server) |
| Dashboard variable that doesn't exist | `404 {"message": "Not Found"}` |
| BigFix Query submit | `{"done": true, "id": <queryId>, ...}` |
| BigFix Query results | `value` is `{reportingAgents, totalResults, results: [{computerID, computerName, subQueryID, isFailure, result, ResponseTime}]}` |
| Any call without `X-XSRF-TOKEN` | `403 invalid csrf token` |

**BigFix Query targets:** computers that are online answered in **3 to 5 seconds**. **Offline computers never answer**, and the results simply stay at `reportingAgents: 0`. Session relevance can't sort, so to target the computers that reported most recently, fetch `(id of it, (now - last report time of it) / second) of bes computers whose (now - last report time of it < 1 * hour)`, which returns (computer id, integer seconds), then sort in the page. [session-relevance-query-html](session-relevance-query-html/) picks the 5 freshest this way.

**Site ids:** custom sites (and operator sites) have no `id` in session relevance; `id of site of <fixlet>` fails with "Singular expression refers to nonexistent object". So for an analysis in a custom site, it isn't clear what `siteID` the analyses activate and deactivate APIs expect. The console's wizard API used the master action site id.

Not a REST API: the Take Action dialog helpers (`TakeFixletAction`, `TakeSecureFixletAction`, `TakeFixletActionOnComputers` and `TakeSecureFixletActionOnComputers`) come from `useBfTakeFixletAction()` in `bfcore-react`.

The design doc's planned paths for passthrough, edit and delete differ from the shipped ones. For example, it planned `PUT /api/sdk/fixlet/{siteType}/{siteName}/{id}` and bulk `DELETE /api/sdk/fixlets`. Use the table above.

**API docs:** `GET /api/openapi.json` returns the spec with no server setting. The Swagger UI at `https://<webui-server>/api/api-docs` needs the WebUI server setting `_WebUIAppEnv_ENABLE_API_DOC_SETTING=1` and a WebUI restart.

## Enabling Extensions Management in WebUI

Extensions Management **is not installed by default**. These steps are confirmed in the HCL 11.0 docs:

1. In the BigFix Console, go to **All Content > Computers**. Right-click the WebUI server computer and choose **Edit Computer Settings > Add**.
2. Add `_WebUIAppEnv_ENABLE_EXTENSIONS_MANAGEMENT` with the value `1`. Any other value disables it.
3. **Restart the WebUI service.**

The WebUI menu shows the Extensions entries only when `GET /isRunningApp?appName=uiextensions` reports the app as running. If you open that URL directly in the browser you may get "permission denied", so check the menu instead.

## Installing and updating

Permissions (from the HCL docs):

- **Master Operators and Content Creators** (with read/write access to the target custom site) can install, update, repair, and remove extensions.
- **Non-master operators** can launch extensions on custom sites they can see, from the **Extensions** menu. They can't manage them.

Install from a file:

1. Open **Extensions Management** (`https://<webui-server>/ui_extensions/next`).
2. Click **Install extension from file**, pick a custom site, upload the `.webui` file, and click **Install**. A higher `version` of an installed extension asks **Confirm upgrade extension**; the same version asks **Confirm overwrite extension** and replaces it (both seen on 11.0.7).
3. Click **Launch** on the installed row.

Size: WebUI accepted an **8.3 MB** `.webui` upload (session-relevance-query-html with the analyzer). I don't know the actual limit.

Update: bump `version`, rebuild, and run **Install extension from file** again with the same site. WebUI sees the same `name` with a newer `version`, shows **Confirm upgrade extension**, and replaces the old one (confirmed). The **Update** item in the row's Action menu crashed with a blank page on the test server, from a `ReferenceError` in Extensions Management's own code, so use the install button instead. In a dev loop, `npm run update -- -u=<user> -p=<password> -s=<server:port> [-f]` pushes the build over an existing custom-site install. It uses the undocumented `/ui_extensions/updateextensioncustomsite` endpoint and puts the password on the command line, so use it only on dev machines.

Repair: after a WebUI reinstall or a DR restore, **Repair an extension** reinstalls it from what is stored in the site.

**Upgrading an extension installed from a site** (seen on 11.0.7.61): when the site gets a newer `.webui`, Extensions Management gives no sign of it. The row keeps the old version and **Installed**, and the Action menu's **Update** is greyed out. **Repair** is what upgrades it to the version now in the site. That was tested by hand with Relevance Query 2.0.0 → 2.0.1 from WebUI-JGStew, and again with 2.0.1 → 2.0.2. Before the repair, the row showed 2.0.1 with **Update** greyed out, and the served page was still 2.0.1. **Repair** then asked *"Repair the extension. This feature will reinstall the extension. Do you want to repair?"*, which doesn't mention upgrading. About 8 seconds after **OK**, the row showed 2.0.2, and the page served 2.0.2.

## Delivery without uploading

- **Repository site** (confirmed): a BigFix 11.0.7 repository site with the `.webui` in its `ServerFiles/` folder works with **Install extension from site**. [bigfix-site-webui-jgstew](https://github.com/jgstew/bigfix-site-webui-jgstew) delivered `relevance-query.webui`, a short name with no version. Extensions Management then lists it with site type **External** and the repository site's name, and the name and version come from the `package.json` inside. `web-reports-renderer.webui` installed the same way (1.5.2). To upgrade one, use **Repair** (see above).
- **External site** (documented): HCL can publish the `.webui` file in an external site. Operators then install it from Extensions Management without uploading anything, but they still have to click Install.
- **Custom site:** I found nothing documented for installing from a file that is already in the site. Choosing an already-added site file to update an app (based on the file's LastModified date) is planned but not confirmed in the shipped product.
- **Automatic install** when a file shows up in a site: not documented anywhere I found.

## Open questions

- What is the minimum BigFix platform version for WebUI extensions? The December 2022 WebUI release that introduced them came out the same day as 10.0.8, but neither announcement states a requirement.
- Is there a newer `bfcore-react` than 6.0.65?
- What do `done` and `id` in the session relevance response mean? Can `done` ever be `false`, meaning paged or partial results? It never was in testing.
- What `siteID` do `POST /api/sdk/analyses/activate` and `.../deactivate` expect for an analysis in a custom site, which has no site id in session relevance? Neither call has been run on a real server yet.
- What is the upload size limit for a `.webui` file? 8.3 MB worked.
- Do analyses and baselines have a WebUI detail page? On 11.0.7, `/content/tasks/<site>/<id>` falls back to the content list for them, and `/content/baselines/...` is 404.

## Session relevance through WebUI vs Web Reports (confirmed)

- **No Web Reports context:** relevance evaluated through `/api/sdk/sessionrelevance/evaluate` (or the REST query) is **not** in Web Reports context. `in web reports context` returns `False`.
- **Console links:** `link of <bes computer>` / `<bes action>` / `<bes fixlet>` return console links: `linkid:opencomputer(<id>)`, `linkid:openaction(<id>)` and `linkid:openfixlet(<siteId>,<fixletId>)`.
- **WebUI pages for them:**
  - computers: `/framework/devices/<id>`
  - actions: `/framework/deployments/<id>`
  - external-site fixlets and tasks: `/content/tasks/<siteId>/<id>`, with `tasks` even for fixlets
  - master-action-site and custom-site content: `/custom/tasks/<webuiSiteId>/<id>`

  For master-action-site and custom-site content, the link's site id is always the **master action site id**, while WebUI needs the **custom site's own id**, which relevance can't return. WebUI's internal `/custom/api/tasks?search={"query":"…"}` returns it as `siteID`. See [web-reports-renderer](web-reports-renderer/README.md#how-webui-differs) for how the links are mapped.
- **No wake-on-LAN:** Web Reports has `SendWakeOnLan()`, which calls `GET /json/wakeonlan?cid=…`. WebUI 11.0.7 has nothing like it: no SDK operation, no platform REST resource (`api/help` lists none), and no item in the Devices menus. See [web-reports-renderer](web-reports-renderer/README.md#no-wake-on-lan-in-webui).

## Where WebUI's session relevance comes from (confirmed on 11.0.7.61)

WebUI answers session relevance from **BES Explorer** when one is running, and **falls back to Web Reports** otherwise. That applies to both `/api/sdk/sessionrelevance/evaluate` and the REST query through the passthrough. It was seen switching both ways on the test server on 31 Oct 2026, when BES Explorer on the root server was found stopped and then started again. The two sources answer differently, so the same relevance can give a different result, or an error, depending on which one is up:

| | BES Explorer | Web Reports (fallback) |
| --- | --- | --- |
| `in web reports context` | `False` | `True` |
| Relevance that is valid JSON as a whole (`true`, `"x"`, `5`) | **`400 Bad Request`** | works |
| `%xx` escapes | evaluated as sent | **decoded once more** before the parser: `("%2541")` gives `A`, and the valid `("100%25")` fails with *A string constant had an improper %-sequence* |
| `site files of <bes site>` | available (4143 on the test server) | none |
| Some inspectors | `display names of subscribed sites of …` fails with *This operation is not supported* | works |
| Time for `number of bes computers` | about 200 to 300 ms | about 3.5 s (the REST answer says `evaltime_ms: 0`) |

**[`shared/webui-relevance.js`](shared/webui-relevance.js)** is a dependency-free helper that the plain HTML/JS apps load first. Each app's `pack.py` copies it into the package as `static/js/webui-relevance.js`.
- **`WebUIRelevance.prepare(api, expr)`** returns the text to send: `api` is `"sdk"` or `"rest"`, the expression is wrapped as `(expr)`, and `%` becomes `%25` when that API decodes once more.
- **One probe request per API**, `(in web reports context, "%2541")`, tells both which source is answering and whether `%` needs escaping. It runs when the page loads, every 5 minutes, and on `recheck()`. A call made before any probe has answered probes synchronously.
- **`sourceName(api)`** returns "BES Explorer", "Web Reports" or "unknown". **`onChange(fn)`** reports a switch, so the apps can show who answered.
- A same-origin iframe reuses its parent's instance; the Web Reports Renderer's report frame does this.

The React app ([session-relevance-query](session-relevance-query/)) can't load a plain script through the template build, so `sessionRelevanceApi.js` has a port of the same probe.

## WebUI relevance API quirks (confirmed on 11.0.7)

- **Send `(expr)`:** relevance whose whole text is also valid JSON (`true`, `false`, `"x"`, `"a <b>"`, numbers) gets **`400 Bad Request`** when BES Explorer answers, on both APIs. `(true)`, `True` and `"a <b>" & ""` work. The parentheses evaluate the same and are never valid JSON, and they're harmless when Web Reports answers. [sdk-api-tester](sdk-api-tester/)'s `sr.jsonliteral` test checks for the quirk; it reports INFO when Web Reports is answering.
- **Send `%` as `%25` only when Web Reports answers:** see the table above. `sr.percent` checks it.
- **Typed results:** for plurality, types and native values, use the platform REST query through the passthrough: `POST /api/sdk/passthrough/api/query`, `Content-Type: text/plain`, body `relevance=<urlencoded>&output=json`. It returns `{"result":[...], "count", "plural", "type", "evaltime_ms"}`, or `{"result":[], "error":"..."}` with HTTP 200 for a relevance error, and needs **Can use REST API**. A query string on the passthrough URL is rejected with `400 Bad request parameters`.
- **Site files through the passthrough:** `GET /api/sdk/passthrough/api/site/<type>/<name>/files` and `…/file/<id>` work, but the site name must be **encoded twice** (`BES%2520Support`); single encoding gets `500 Request path contains unescaped characters`. Files come back as `application/octet-stream` and are **decoded as UTF-8, which corrupts binary files** such as images. Session relevance can't list file names (`<bes site file>` has only `id`), and `version of <bes site>` fails for the master action site and custom sites; `…/version` through the passthrough has it. See [web-reports-renderer](web-reports-renderer/README.md#site-files-through-the-rest-passthrough-1107).
- **Right after an upgrade,** an extension's page can return WebUI's *Page Not Found* for a few seconds.

## History

- **15 Dec 2022:** WebUI extensions were introduced in the [December 2022 WebUI release](https://forum.bigfix.com/t/bigfix-webui-new-release-available-december-2022/43756), as "the ability to extend WebUI beyond what is delivered". Extension development was limited to HCL, and an official SDK was planned. The release published site "WebUI Extensions" version 1.
- **Same day:** [BigFix 10.0 Patch 8 (10.0.8.37)](https://forum.bigfix.com/t/bigfix-10-0-patch-8-is-now-available/43749) was the current platform release. Neither post states a minimum platform version for extensions.
- **"WebUI Extensions" site versions in later WebUI releases:**
  - 3 in [May 2023](https://forum.bigfix.com/t/bigfix-webui-new-release-available-may-2023/45100)
  - 8 in [May 2024](https://forum.bigfix.com/t/bigfix-webui-new-release-available-may-2024/48647)
  - 11 in [March 2025](https://forum.bigfix.com/t/bigfix-webui-new-release-available-march-2025/51122)
  - 12 in [April 2025](https://forum.bigfix.com/t/bigfix-webui-new-release-available-april-2025/51420)
  - 14 in [April 2026](https://forum.bigfix.com/t/bigfix-webui-new-release-available-april-2026/54434)

## References

- HCL docs: Get Started with Extensions Management ([10.0](https://help.hcl-software.com/bigfix/10.0/mcm/WebUI/Users_Guide/c_get_started_with_extension.html), [11.0](https://help.hcl-software.com/bigfix/11.0/mcm/WebUI/Users_Guide/c_get_started_with_extension.html)), [WebUI server settings](https://help.hcl-software.com/bigfix/11.0/mcm/WebUI/Admin_Guide/c_server_settings_definitions.html), [Accessing WebUI server settings](https://help.hcl-software.com/bigfix/11.0/mcm/WebUI/Admin_Guide/c_access_webui_server_settings.html)
- [What is new in BigFix 10 Platform](https://help.hcltechsw.com/bigfix/10.0/platform/Platform/Installation/c_versions.html)
- [Session relevance guide](https://developer.bigfix.com/relevance/guide/session/), [BigFix REST API](https://developer.bigfix.com/rest-api/api/)
