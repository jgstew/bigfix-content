# Web Reports Renderer - BigFix WebUI extension

Renders a BigFix **Web Reports custom report** inside WebUI, with all of its relevance evaluated through WebUI. It uses the platform REST query (typed, through the SDK passthrough) when the operator has **Can use REST API**, and the SDK's `POST /api/sdk/sessionrelevance/evaluate` otherwise. It's plain HTML and JavaScript with no HCL code, packaged by `pack.py`. The current version is **1.2.1**.

1. **Choose or drop a report**, such as the ones in [`../../webreports`](../../webreports):
   - `.besrpt` / `.beswrpt` files containing report HTML
   - `.webreport` files, which are `<BESWebReport>` XML; only `<Type>CustomReport</Type>` is rendered
2. **Every `<?Relevance ?>` is replaced** with its result, the way Web Reports does on the server.
3. **The report renders in an iframe** inside `<div id="wr_datapage">`, like Web Reports, with [`shim.js`](src/static/js/shim.js) loaded first. Its JavaScript calls to `EvaluateRelevance()`, `Relevance()` and `AsyncEvaluateString()` are answered through the same SDK API. Its dashboard-variable calls (`StoreSharedVariable()`, `DeleteSharedVariable()`, and the console's `StoreVariable()` family) go to `/api/sdk/dashboardvariable/...`.
4. **CDN `<script>`/`<link>` tags** are rewritten to local copies, because WebUI blocks every other host.
5. **Console links** (`linkid:...`) for computers, actions, fixlets and tasks open the matching WebUI page in a new tab.
6. **Refresh:** `<?BeginRefreshRelevance?>` sections re-evaluate on a timer.
7. **Options:** treat `in web reports context` as true, and choose the dashboard id that `current wizard` refers to.
8. **External reports** offer a button to open their URL in a new tab.
9. **Copy report:** a collapsed **Log** records every relevance evaluation, JavaScript relevance call, script error, and blocked file. **Copy report** gives it back as one block of text (the same pattern as [sdk-api-tester](../sdk-api-tester/)).

This README records everything found while building and testing it on a live BigFix 11.0.7.61 deployment (WebUI plus Web Reports), so it doesn't need to be investigated again.

- [How Web Reports really does it](#how-web-reports-really-does-it)
- [How WebUI differs](#how-webui-differs)
- [What this app does](#what-this-app-does)
- [Problems found and how they were solved](#problems-found-and-how-they-were-solved)
- [Known limitations](#known-limitations)
- [Security](#security)
- [Build, install, files](#build)
- [Testing status](#testing-status)
- [How to investigate further](#how-to-investigate-further)
- [Ideas not done yet](#ideas-not-done-yet)

## How Web Reports really does it

Everything in this section was **observed on a live Web Reports 11.0.7 server** by reading the functions and the raw HTML of a rendered custom report ("Computer Comments", `/webreports?page=CustomReport&ReportID=17`). Public docs ([developer.bigfix.com Web Reports API](https://developer.bigfix.com/other/web-reports-api/)) only describe this loosely.

### Page structure

- **The report renders in an iframe.** The top page, `/webreports?page=CustomReport&ReportID=<id>`, defines none of the relevance functions. The report is in `<iframe id="wr_reportSourceWrapper" src="/webreports?ShortenedParams=<hash>">`, and that iframe defines `EvaluateRelevance`, `Relevance`, `AsyncEvaluateString`, `JSONRelevanceQuery` and the `WR` object. (Two other iframes on the page, `_yuiResizeMonitor` and `yui-history-iframe`, are YUI helpers.)
- **What the iframe document starts with:**
  - `<meta http-equiv="X-UA-Compatible" content="IE=9">` and `content="chrome=1"`
  - `<base target="_parent" href="http://<wr-host>:<port>/ReportFiles/<reportId>/">`, so relative URLs resolve to files stored with the report, and links open in the top page
  - `<title><report name>&nbsp;- BigFix Web Reports</title>`
  - a script that sets a dashboard-variable request token and `WR.Filters = {}`
  - then **`<div id="wr_datapage">`**, which holds the report HTML
- **Scripts Web Reports loads into the iframe before the report's own** (all under `/JavaScript/`):
  - `WR.js`
  - `DashboardAPI/RelevanceResult.js` and `DashboardAPI/DashboardVariables.js`
  - `Util/HTML.js`, `Util/DOM.js`, `Util/Array.js`, `Util/URL.js` and `Util/Run.js`
  - `Notification/Notification.js`
  - `json2.js`
  - `jQuery/jquery.js`, Web Reports' own copy, which is separate from any jQuery the report loads
  - YUI (`yahoo-dom-event`, `Dom`, `Event`)
  - `FilterCreation/GenerateFilterParameters.js`
  - `CreateRequest.js`
  - `EvaluateString.js`
  - `WakeOnLan/WakeOnLan.js`
- **CDN scripts:** the report's own CDN `<script>` tags are left as they are, because Web Reports has no restrictive CSP. The raw HTML of "Computer Comments" loaded jQuery 3.1.1, jQuery UI 1.12.1 and DataTables 1.10.13 straight from cdnjs.

### `<?Relevance ?>` processing instructions

- **Where it happens:** they're replaced **on the server**, before the page is sent.
- **Escaping:** the result is coerced to the **`html` type**. String results are HTML-escaped, and `html` results (`html "..."`, `html tags`, `trs of ...` and so on) are inserted as they are.
- **Plural results are joined with `<br />` between items, not after each one.** In the raw HTML, a two-row `trs of ...` result came out as `<tbody id="results"> <tr>…</tr><br /><tr>…</tr> </tbody>`: 2 rows and 1 `<br />`. That's why reports carry CSS such as `div#wr_datapage > br + br { display: none; }`.
- **Tuples:** a tuple result prints as `a, b`, the way BigFix formats tuples.

### The JavaScript relevance API (read from the live functions)

**`EvaluateRelevance(query)`**, synchronous:

```js
var http_request = CreateRequest();
http_request.open('POST', '/webreports', false);           // false = synchronous
http_request.setRequestHeader('Content-type', 'application/x-www-form-urlencoded');
http_request.send('page=EvaluateRelevanceOnly&' + GetQueryBody(query));
if (readyState != 4 || status != 200) ThrowError('Error contacting server. Status code: ' + status);
var xmlDoc = http_request.responseXML;
// <error>  -> ThrowError(its text)
// <answerlist> with <answer> elements and <plurality>
//   plurality '0' -> return GetNodeValue(answers[0])   (a string)
//   otherwise     -> return [GetNodeValue(answer), ...] (an array of strings)
// no <answerlist> -> return []                          (an empty array)
```

- `GetQueryBody(query, coerce)` builds `coerce=string` (only if `coerce`), `currentSiteID=<WR.currentSiteID>` (if set), and `expr=<query>`, then adds `GetFilterParam()`, which carries Web Reports' active computer filter.
- `ThrowError(message)` does `var e = new Error(); e.message = message; throw e;`.
- `GetNodeValue(node)` concatenates the `nodeValue` of every child node.
- Answers are **not** HTML-escaped.
- [Web Reports vs Dashboard](https://developer.bigfix.com/other/web-reports-api/wr_vs_dashboard.html) says each call is an HTTP request that "might average up to one second".

**`Relevance(query, callback)`**:

```js
if (!callback) return WR.makeRelevanceArray(JSONRelevanceQuery(query, ParseResult));   // synchronous
YAHOO.util.Connect.asyncRequest('POST', '/json/relevance', {
  success: function (o) { var result = ParseResult(o.responseText);
    if (result.error) callback.failure(result.error);
    else callback.success(result.plural ? WR.makeRelevanceArray(result.result) : result.result[0]); },
  failure: function (o) { callback.failure((o.statusText ? o.statusText + ': ' : '') + (o.responseText || '')); }
}, GetQueryBody(query));
return null;
```

- `callback` is an **object**, `{ success: fn, failure: fn }`, not two functions.
- `JSONRelevanceQuery(query, parser, coerce)` does a synchronous `POST /json/relevance`. A non-200 response throws `'Error contacting server. Status code: N Message: <text>'`, and `result.error` throws. It returns `result.plural ? result.result : result.result[0]`.
- `ParseResult(text)` is `JSON.parse` with a reviver that turns any string matching `^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d\d (Jan|…|Dec) \d\d\d\d \d\d:\d\d:\d\d (\+|-)\d\d\d\d$` into a `Date`.
- `/json/relevance` keeps **tuples as arrays** and other **types as native JS values**. `EvaluateRelevance` flattens everything to strings.
- `WR.makeRelevanceArray(array)` keeps the original `sort` as `parentSort` and adds two methods:
  - `sort(i, fn)`: with a number `i`, sorts by tuple item `i`, using `fn(a[i], b[i])` or `<` / `>`. With a function, it sorts with that function. With nothing, it sorts the default way.
  - `toArray()`: returns the array.

**`AsyncEvaluateString(questionString, answerObjectID)`:**
- **Request:** an asynchronous `POST /webreports` with the body `page=EvaluateRelevanceOnly&expr=<encodeURIComponent(q)>` plus `GetFilterParam()`.
- **What `ReplaceString` does with the element's `innerHTML`:**
  - readyState 1: `'loading...'`
  - readyState 2: `'loaded.'`
  - readyState 4, status 200: `innerHTML = xmlDoc`. **This is a bug:** it assigns the XML Document object, so the element shows `[object XMLDocument]`.
  - any other status: `'Error contacting server. Status code: N'`
- **Missing element:** `WR.Notify.error('The object to contain the evaluation is not valid.')`.

### Dashboard variables (`/JavaScript/DashboardAPI/DashboardVariables.js`, read from the live file)

Web Reports gives custom reports **only two** dashboard-variable functions. Both are asynchronous, and both work on **shared** variables only:

```js
StoreSharedVariable = function (dashboardID, variableName, variableValue, callback, databaseID) {
  if (!dashboardID || !variableName || !variableValue) {
    WR.Notify.error('Attempt to set dashboard datastore value failed: missing required arguments.'); return; }
  var paramMap = new WR.URL.ParamMap(); paramMap.add('Value', variableValue);
  postDashboardVariableRequest('/post/store-shared-variable', dashboardID, variableName, paramMap, callback, databaseID);
}
DeleteSharedVariable = function (dashboardID, variableName, callback, databaseID) {
  if (!dashboardID || !variableName) {
    WR.Notify.error('Attempt to delete dashboard datastore value failed: missing required arguments.'); return; }
  postDashboardVariableRequest('/post/delete-shared-variable', dashboardID, variableName, new WR.URL.ParamMap(), callback, databaseID);
}
// postDashboardVariableRequest adds DashboardID, Name, DatabaseID (if given) and DashboardVariableToken
// (WR.dashboardVariableRequestToken, set in the report page), then YAHOO.util.Connect.asyncRequest('POST', url, ...):
//   success: callback.success(o)       failure: callback.failure(o), or WR.Notify.error('HTTP POST Request "<url>" failed: ' + o.responseText)
//   o is the YUI response object (o.status, o.statusText, o.responseText)
```

- **`variableValue` can't be empty:** an empty string is falsy, so it's rejected as a missing argument.
- **`databaseID`** chooses one of the databases Web Reports aggregates. Without it, the value is written to every one.
- **Only admins can write:** Web Reports only lets a report run by an admin user change shared dashboard data; others get an error.
- **There is no read function.** Reports read variables with session relevance, such as `shared variable "X" of current wizard`, `private variable "X" of current wizard`, or `shared variables "X" of bes wizards`.
- **The console's wizard API has more**, and reports that double as dashboards call it: `StoreVariable(dashboardID, name, value, isPrivate)` (`isPrivate` defaults to **false**, meaning shared), `StorePrivateVariable(...)`, `StoreSharedVariable(...)`, `DeleteVariable(dashboardID, name, isPrivate)`, `DeletePrivateVariable(...)` and `DeleteSharedVariable(...)`. Dashboards usually call them as `external.StoreVariable(...)`, synchronously.

### Wake-on-LAN (`/JavaScript/WakeOnLan/WakeOnLan.js`, read from the live file, 11.0.7)

The whole file is one function, plus `// <?import ...?>` lines for `Notification.js`, `json2.js`, `Util/URL.js`, `ConnectionManager.js` and `CreateRequest.js`:

```js
function SendWakeOnLan( cids, dbid )   // cids: array of computer ids; dbid: optional database id
//   GET /json/wakeonlan?cid=<id>&cid=<id>[&dbid=<dbid>]   (WR.URL.ParamMap, synchronous XMLHttpRequest)
//   HTTP status other than 200 -> ThrowError('Error contacting server. Status code: ... Message: ...')
//   JSON result.error          -> ThrowError(result.error)
//   returns result.success
```

- **`ThrowError(message)`** is a Web Reports global: it creates an `Error`, sets `message`, and throws it.
- **The reply is `{"success":true}`** once Web Reports has accepted the request. It isn't a delivery report: computer ID `1`, which doesn't exist, got the same reply. Seen on a live server, with a real request for one offline computer.
- **It needs the Web Reports session.** A request without the session cookie gets `Invalid username or password.`

**Not defined in Web Reports:** `InsertUtilityDiv`, `OpenComputerGroup` and the other console dashboard functions. Reports that double as console dashboards guard them, or rely on `window.onerror`.

## How WebUI differs

These were all confirmed on WebUI with BigFix 11.0.7.61.

### What the SDK API returns

- **Response:** `POST /api/sdk/sessionrelevance/evaluate` with `{"session_relevance": "..."}` returns `{"done": true, "id": {}, "value": [...]}`. Every value is a **string**, and tuples are arrays of strings.
- **No plurality and no type:** the response gives neither. You can't tell a singular answer from a plural one with one value, or a string from `html`.
- **Errors** return as `500 {"message": "..."}`, and a request without `X-XSRF-TOKEN` gets `403 invalid csrf token`.
- **Synchronous calls work:** a synchronous `XMLHttpRequest` from the iframe to this API works (about 310 ms in testing). Chrome logs its usual deprecation warning for synchronous XHR on the main thread.

### Relevance runs outside Web Reports

- `in web reports context` returns **`False`**.
- **The `link` inspectors return console links**, not Web Reports links:

  | Inspector | Returns |
  | --- | --- |
  | `link of <bes computer>` | `<A href="linkid:opencomputer(<computerId>)">name</A>` |
  | `link of <bes action>` | `<A href="linkid:openaction(<actionId>)">name</A>` |
  | `link(s) of <bes fixlet>` | `<A href="linkid:openfixlet(<siteId>,<fixletId>)">name</A>` |

- **The WebUI pages for those, checked against real objects:**
  - **computer** → `/framework/devices/<computerId>`, which shows that computer (WebUI also redirects it to `/framework/next/devices/<id>`)
  - **action** → `/framework/deployments/<actionId>`, which shows that action
  - **fixlet or task in an external site** → `/content/tasks/<siteId>/<fixletId>`, for example `/content/tasks/1/6120`. The segment is **`tasks` even for a fixlet**: `/content/fixlets/1/6120` is `Page Not Found`.
  - **fixlet or task in the master action site or a custom site** → `/custom/tasks/<webuiSiteId>/<fixletId>`. Master-action-site content uses the master site id (`/custom/tasks/2299662135/49`, which is what WebUI's own list links to). **Custom-site content needs the custom site's own id** (for example `/custom/tasks/8589938636/3571` for the ClientSettings site). With the master id, the page loads only an empty "Custom Document".
  - **analysis or baseline** → **no WebUI detail page**. `/content/tasks/<site>/<id>` falls back to the content list, and `/content/baselines/...` is `Page Not Found`.
- **The site id inside `linkid:openfixlet(site, id)`:**
  - external sites: the site's id (`1` for BES Support, `8102` for Power Management)
  - **the master action site and every custom site: the master action site id** (for example `2299662135`)

  Session relevance can't return a custom site's own id: `id of <custom site>` fails, `id of it | 0` gives `0`, and the REST site XML (`GET api/site/custom/<name>`) has no id either.
- **WebUI's internal custom-content API**, which WebUI's Custom Content page uses and which isn't in the SDK spec:
  - `GET /custom/api/tasks?filter={}&pagination={"page":{"itemsPerPage":N,"offset":0}}&search={"query":"<text>"}&sort={"method":"name","order":"asc"}`, with each value URL-encoded JSON
  - It returns `{count, data: [...], lastUpdated}`. Each row has `contentID`, `siteID` (WebUI's id, for example `8589938636`), `siteName`, `siteType`, `name`, `type`, and about 25 other fields.
  - `search` must be `{"query": "..."}`; other shapes such as `{text}`, `{name}` and `{value}` return 500.
  - `GET /custom/api/tasks/sites` lists `{siteName, Type, OpSiteName, siteCount}` with **no** ids. The test server had 2,880 custom items.
- **WebUI pages send `X-Frame-Options: DENY`,** so they can't open inside the report iframe.

### Typed relevance through the REST passthrough

The platform REST query API, reached through the SDK passthrough, returns what the SDK evaluate API leaves out:

```
POST /api/sdk/passthrough/api/query        Content-Type: text/plain
relevance=<urlencoded relevance>&output=json

-> {"result":[142],"count":1,"plural":false,"type":"integer","evaltime_ms":0.06}
-> {"result":["BIGFIX"],"count":1,"plural":true,"type":"string",...}            plural even with one result
-> {"result":["<b>x</b>"],"plural":false,"type":"html",...}
-> {"result":[["BIGFIX",11333902,"Sat, 31 Oct 2026 06:46:45 -0400"]],"plural":true,"type":"( string, integer, time )"}
-> {"result":[true],"type":"boolean"}      {"result":[],"count":0,"plural":true}   (empty plural)
-> 200 {"result":[],"error":"The operator \"error\" is not defined."}             relevance errors are HTTP 200
-> 200 {"result":[],"error":"Singular expression refers to nonexistent object."}
```

- **What it gives:** exact **plurality**, the exact **type** (including the type of each tuple item), and **native JSON values**: numbers, booleans, and tuples as arrays.
- **Permission:** it needs **Can use REST API**.
- **No query string:** `GET /api/sdk/passthrough/api/query?relevance=…` is rejected with `400 {"message":"Bad request parameters"}`, because the SDK's request validator only allows the `{uri}` path parameter. Encoding the whole query into the path (`/api/sdk/passthrough/api%2Fquery%3Foutput%3Djson%26relevance%3D…`) also works.
- **Same answers as the SDK:** on every expression compared (`names of sites of …`, `task flags …`, `link of …`, `in web reports context`), REST and the SDK gave the same values, with REST adding types.

### Relevance that is valid JSON is rejected

WebUI 11.0.7 answers **`400 {"message":"Bad Request"}`** on **both** `/api/sdk/sessionrelevance/evaluate` and the REST passthrough when the entire relevance text is also a valid JSON value:

| Rejected with 400 | Works |
| --- | --- |
| `true`, `false`, `"x"`, `"a <b>"`, `"<script>"` (and numbers) | `True`, `(true)`, `1 = 1`, `exists true`, `"a <b>" & ""`, `if (true) then "yes" else "no"` |

WebUI apparently JSON-parses the value somewhere. **Workaround:** send `(expr)` instead, which evaluates the same and is never valid JSON. This renderer does that for every relevance it sends, and so do [session-relevance-query-html](../session-relevance-query-html/) (2.0.1), [sdk-api-tester](../sdk-api-tester/) (1.0.3, which has a test for the quirk, `sr.jsonliteral`) and the React [session-relevance-query](../session-relevance-query/) source.

### Dashboard-variable SDK API quirks

These were found with the shim on the real server, using a throwaway dashboard id:

- **Store:** `POST /api/sdk/dashboardvariable/{id}/{name}` with `{"value": "...", "private": true|false}` works. **A missing `private` means private**, so the shim always sends it.
- **Read:** `GET` of one variable returns `value: {Dashboard, Name, IsPrivate, Value}` (and `User` for a private one). A variable that doesn't exist returns `404 {"message": "Not Found"}`.
- **A private and a shared variable can share a name.** While both exist:
  - **`GET …/{name}` returns `500 ".response.value should be object"`**; WebUI's own response check fails.
  - **One `DELETE …/{name}` removes both.** The SDK's `DELETE` has no private/shared flag.
- **List:** `GET /api/sdk/dashboardvariable/{id}` lists the dashboard's variables, both kinds, each with `IsPrivate` (a private one also has `User`), and returns 404 when there are none.

### No wake-on-LAN in WebUI

Checked on BigFix 11.0.7.61, so `SendWakeOnLan` has nothing to map to:

- **SDK:** none of the 26 operations in `/api/openapi.json` sends wake-on-LAN.
- **Platform REST API:** `GET api/help` (through the passthrough) lists no wake-on-LAN resource, and `api/help/wakeonlan` is 404. The REST API docs have no wake-on-LAN page either.
- **WebUI pages:** the Devices list's bulk menus (Deploy, Administration, Configuration) have no wake-on-LAN item, and WebUI's loaded JavaScript doesn't contain the word "wake".
- **Calling Web Reports from WebUI doesn't work:**
  - `fetch`/`XMLHttpRequest` to the Web Reports server are blocked by the extension's `connect-src 'self'`, and by mixed content when Web Reports is plain `http`.
  - **Tried in 1.2.0, then dropped:** opening `<webreports>/json/wakeonlan?cid=…` in a new tab from the report. The tab opened, but Web Reports answered `Invalid username or password.` The same URL typed into a tab returned `{"success":true}`. So the Web Reports session cookie wasn't sent on a navigation that started from the WebUI page, probably because of its SameSite setting. That's not confirmed: the cookie is HttpOnly, so its attributes couldn't be read.

### The extension's security policy applies to the report too

- **Inherited policy:** extension pages get `default-src 'self'; img-src 'self' blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self' wss:; sandbox …; frame-ancestors 'self'` plus `X-Content-Type-Options: nosniff`. A **`srcdoc` iframe inherits that policy** from its parent page.
- **Effect:** every `<script src>` and `<link href>` to another host in a report is blocked (reported as `script-src-elem` / `style-src-elem` violations), which leaves `$` undefined. Inline `<script>` and `<style>` still run, and so does `eval`.

## What this app does

| Web Reports feature | Here |
| --- | --- |
| All relevance | Goes through `WRREL.prepare()` in [`relevance.js`](src/static/js/relevance.js), which applies the two options below and wraps the expression in `( )`, the JSON-literal workaround. Then it's evaluated **typed** (REST passthrough) when available. Otherwise it uses the SDK API: after the first 403, the typed path is off for the rest of the page, and any other HTTP failure falls back to the SDK for that call. |
| `<?Relevance expr ?>` | **Typed:** values whose type is `html`, including `html` items of a tuple, are inserted as they are; everything else is HTML-escaped, with booleans written `True`/`False`. **SDK fallback:** evaluates `(it as html) of (expr)` so the server escapes strings and leaves `html` alone; if that cast fails, as it does for integers, booleans and tuples, it evaluates `expr` and escapes the values in the page. Either way, tuples become `a, b`, plural results are joined with `<br />`, and errors show inline as `<span class="wrr-relevance-error">[relevance error: …]</span>`. Repeated identical expressions are evaluated once, and up to 4 run at a time. The Log shows how each was done (`typed integer`, `typed ( string, html )`, `SDK as html`, `SDK escaped`). |
| `<?BeginRefreshRelevance id="x" …?>` … `<?EndRefreshRelevance?>` | Become `<span id="x" data-wrr-refresh="n">` … `</span>`; the default id is `__DRRSN`, the console's. With **Refresh sections** on (the default), each section's source is re-evaluated on a timer and the span's `innerHTML` replaced, without running its scripts again. The interval is the shortest `hh:mm:ss` attribute (`ManualRefresh`, `ActionResults`, and so on), with a floor of 10 seconds, or 60 seconds when there are no attributes. Web Reports itself never refreshes; this is the console's behavior. |
| Option: **Treat `in web reports context` as true** | Off by default. Rewrites the text `in web reports context` to `true` before evaluating, so reports take their Web Reports branch. This is plain text replacement, so it also changes string literals that contain the phrase. |
| Option: **Dashboard id for `current wizard`** | Empty by default. Rewrites `current wizard` to `(bes wizard whose (dashboard id of it = "<id>"))`, so reads like `shared variable "x" of current wizard` refer to a real dashboard. Without it, `current wizard` refers to nothing. A `"` in the id becomes `%22`. |
| Options storage | Remembered per browser in `localStorage`; if storage is blocked, the defaults are used. They apply at the next render. |
| Page structure | `<!doctype html>`, then `shim.js` as the first, blocking `<script>`, then `report.css`, then `<body><div id="wr_datapage">REPORT</div>`. The `srcdoc` iframe is same-origin, with `sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads"`. |
| `EvaluateRelevance(q)` | Synchronous `XMLHttpRequest`. **Typed:** plural returns an array of answer strings (possibly empty), and singular returns the answer string, **exactly like Web Reports**. Answers are strings: booleans become `True`/`False`, numbers become strings, and tuples become `a, b`. **SDK fallback:** one value counts as singular. Errors throw `Error(message)` with **both** `e.message` and `e.description` set; older console code reads `e.description`. |
| `Relevance(q)` | Synchronous. **Typed:** native values like Web Reports' `/json/relevance`: numbers, booleans, tuples as arrays, and date strings as `Date`. Plural returns `WR.makeRelevanceArray(values)` (`sort(i, fn)`, `toArray()`), singular returns the value. **SDK fallback:** strings, one value counts as singular, and dates still become `Date`. |
| `Relevance(q, {success, failure})` | The same, asynchronously (`fetch`). `failure` gets the server's message. |
| `AsyncEvaluateString(q, id)` | Shows `loading...`, then the answers joined with `<br />`, not escaped. On error it shows `Error: <message>`, and a missing element is logged as WARN. **This differs on purpose** from Web Reports' buggy `[object XMLDocument]`. |
| `WR.makeRelevanceArray`, `WR.URL.ParamMap` | `WR.makeRelevanceArray(array)` is Web Reports' function. `new WR.URL.ParamMap(params)` has `add`, `set`, `remove`, `addAll`, `empty`, `finish` and `equals`; `finish()` gives `a=1%202&a=3&b=x%26y`, which was checked against Web Reports' own output for the same calls. Neither replaces an existing `WR.*` definition. |
| `StoreSharedVariable(id, name, value, callback, databaseID)` / `DeleteSharedVariable(id, name, callback, databaseID)` | Web Reports' behavior: asynchronous, the same missing-argument checks and messages, and `callback.success(o)` / `callback.failure(o)` with `o = {status, statusText, responseText}`. With no callback, a failure calls `WR.Notify.error('HTTP POST Request "/post/…" failed: …')`. Maps to `POST` (`private: false`) / `DELETE /api/sdk/dashboardvariable/{id}/{name}`. `databaseID` is ignored with an INFO line, because WebUI has a single database. |
| `StoreVariable(id, name, value, isPrivate)`, `StorePrivateVariable`, `DeleteVariable(id, name, isPrivate)`, `DeletePrivateVariable` | The console's versions: synchronous, `isPrivate` defaulting to false (shared), throwing `Error(message)` on failure (for example `Not Found` when deleting something that doesn't exist). They're also attached to `window.external` where the browser allows it. |
| Deleting one kind of variable | Before a delete, the shim reads the dashboard's variable list. After the delete, it writes back the same-named variable of the other kind (shared or private) and logs `WARN restored … variable`, because the SDK's `DELETE` removes both. |
| `WR.Notify` | Web Reports' methods: `update`, `updateHTML`, `warning`, `warningHTML`, `error`, `errorHTML`, `clear`, `enableNotifications`. Messages show as a **banner at the top of the report** (`#wrr-notify`, styled in `report.css`). Errors stay until dismissed with ×; others clear after 8 seconds. Each one is also logged (`ERROR`/`WARN`/`INFO`), and errors go to the browser console. It's created only if `WR.Notify` doesn't already exist. |
| `InsertUtilityDiv()`, `RegisterRefreshHandler()`, `ClearAllGlobalFilters()`, `OpenComputerGroup()` | No-ops that log an INFO line, so reports that also work as console dashboards don't stop with an error. |
| `SendWakeOnLan(cids, dbid)` | **A no-op** (see [No wake-on-LAN in WebUI](#no-wake-on-lan-in-webui)). It logs `WOL SendWakeOnLan(N computers) ignored: …` and shows the warning banner *Wake-on-LAN does not work here: WebUI has no wake-on-LAN API. Nothing was sent.* It then returns `false` instead of throwing, so the report keeps running. |
| `ThrowError(message)` | Web Reports' version: throws an `Error` with that message. It's defined only if the report doesn't define its own. |
| `linkid:` links | One capturing click listener on the iframe document, so it also catches links added later, opens a new tab. Other `linkid:` forms are logged as `no WebUI page for console link …`. |
| … `opencomputer(id)` / `openaction(id)` | `/framework/devices/<id>` / `/framework/deployments/<id>` (`window.open(url, '_blank', 'noopener')`) |
| … `openfixlet(site, id)`, external site | `/content/tasks/<site>/<id>` |
| … `openfixlet(site, id)`, master action site or custom site | A site id equal to the master action site id (looked up once with `ids of bes sites whose (master site flag of it)`, or, until that answers, any id above 2147483647) means the item's real site isn't known. The tab opens immediately, **inside the click**, so the popup blocker allows it. Then `/custom/api/tasks?search={"query":"<link text>"}` is called, the row with the same `contentID` is picked (preferring one whose `siteID` equals the link's), and the tab goes to `/custom/tasks/<siteID>/<id>`. If there are several matches, the first is used, with a WARN. If there's no match, the tab shows WebUI's custom content list searched for that name. |
| External reports | The status explains that WebUI can't frame other hosts, and a button offers **Open `<url>` in a new tab**. Only `http(s)://` URLs are offered; a `javascript:`, `data:` or other URL is not. |
| CDN `<script>`/`<link>` | Rewritten to local copies; see [CDN libraries](#cdn-libraries). |
| Script errors and blocked files | `shim.js` sends `error`, `unhandledrejection` and `securitypolicyviolation` events to the Log, as `JSERR` and `BLOCKED` lines. |

**Report file formats:**
- **`<BESWebReport>` XML** is detected in the first 2000 characters and parsed with `DOMParser`, using the `Name`, `Type`, `Data` and `SourcePage` fields:
  - `CustomReport`: renders `Data`, which is usually a CDATA block
  - `ExternalReport`: shows its URL and explains that WebUI extensions can't frame other hosts
  - anything else, such as `TemplateReport`: says it's a saved Web Reports page (`SourcePage`), not report HTML
- **Anything else** is treated as raw report HTML, which is what `.besrpt` / `.beswrpt` exports and the files in `../../webreports` are.
- **Fragments with `<Head>` and `<body>` tags** (dual-use dashboard files like `Computer_Filter_Search`) work, because the browser drops the extra tags and keeps the scripts.

### CDN libraries

`fetch_libs.py` downloads the libraries the example reports use into `src/static/libs/cdnjs/<cdnjs path>`, a git-ignored folder, and writes `src/static/libs/manifest.json` (`{format, base, files[], aliases{}}`). The renderer loads that manifest at startup and waits for it before rendering. Then:
- **Rewrite:** it replaces `https://cdnjs.cloudflare.com/ajax/libs/<path>`, or a protocol-relative `//cdnjs.cloudflare.com/...`, with the absolute local URL whenever `<path>` is in the manifest, along with any alias URL. The match only applies after `"`, `'`, `(`, `=` or whitespace.
- **The rewrite runs after relevance substitution,** because some reports build their `<script>` tags with relevance. `GenericDataTables` tries a "Shared Javascript Library" task's MIME field first, and falls back to a cdnjs `<script>`.
- **`integrity="sha256-…"`** attributes are kept, and they pass, because the copies are byte-identical.
- **Anything still pointing at another host** is listed in a WARN line, and the browser then reports each one as `BLOCKED`.

| Library | Files |
| --- | --- |
| jQuery 3.1.1 | `jquery.min.js` |
| jQuery UI 1.12.1 | `jquery-ui.min.js`, `jquery-ui.min.css`, and 6 `images/ui-icons_*.png` |
| DataTables 1.10.13 and 1.10.19 | `js/jquery.dataTables.min.js`, `css/jquery.dataTables.min.css`, and 5 `images/sort_*.png` each |
| d3 3.5.17 | `d3.js` |
| nvd3 1.8.5 | `nv.d3.js`, `nv.d3.css` |
| Font Awesome 4.7.0 | `css/font-awesome.min.css` and 5 `fonts/fontawesome-webfont.*` |
| Font Awesome 5.3.1 | `js/all.js`. This is also the alias for `https://use.fontawesome.com/releases/v5.3.1/js/all.js`. |

In total that's 33 files, about 3.5 MB on disk; the built `.webui` is about 1.27 MB.

**How `fetch_libs.py` checks the files:**
- **Start list:** `LIBRARIES`, a list of cdnjs paths. Each CSS file's relative `url(...)` references (fonts and images) are added to it automatically.
- **SRI check:** every file is checked against the SRI hash cdnjs publishes for it (`https://api.cdnjs.com/libraries/<name>/<version>?fields=sri`, sha512).
- **Lock file:** fonts and images have no published SRI. The first run records every file's sha256 in **`libs.lock.json`**, which is committed, and every later run must match it exactly. After changing `LIBRARIES` on purpose, run `python3 fetch_libs.py --update-lock`.
- **Safe writes:** downloads go to a temp folder that replaces `src/static/libs/` only after everything succeeds. Requests retry with exponential backoff, and any file over 8 MB is refused.
- **To support another library,** add its cdnjs path to `LIBRARIES`, plus an `ALIASES` entry if reports load it from another CDN.

## Problems found and how they were solved

| Problem | Cause | Solution |
| --- | --- | --- |
| Every CDN `<script>`/`<link>` in a report was blocked, then `$ is not defined` | The `srcdoc` iframe inherits the extension's `default-src 'self'` policy | Local copies from `fetch_libs.py`, with URLs rewritten after relevance substitution |
| The SDK doesn't say whether a value is `html` or a string, so escaping can't be decided in the page | The SDK returns plain strings only | Evaluate `(it as html) of (expr)` so the server applies Web Reports' html coercion; fall back to escaping in the page when that cast fails |
| The SDK doesn't report plurality | Same | Treat one value as singular (see [Known limitations](#known-limitations)) |
| `link of …` links did nothing | Relevance through WebUI isn't in Web Reports context, so the links are `linkid:` console links | A click listener maps computers and actions to WebUI pages, in a new tab because of `X-Frame-Options: DENY` |
| Console-only calls such as `InsertUtilityDiv()` and `OpenComputerGroup()` threw errors | Reports built to work as both dashboards and reports | Logged no-ops |
| `fetch_libs.py` asked cdnjs for `jqueryui/1.12.1/%22images%2Fui-icons_….png%22` and got 403 | `jquery-ui.min.css` contains a URL-encoded copy of its image paths in a ThemeRoller comment | Skip `url()` values that contain `%` |
| A popup from the sandboxed iframe would itself be sandboxed | The sandbox flags carry over to popups by default | Added `allow-popups-to-escape-sandbox` |
| Deleting a private variable also deleted the shared one with the same name, and the other way around | The SDK's `DELETE /api/sdk/dashboardvariable/{id}/{name}` has no private/shared flag and removes both | The shim reads the dashboard's variable list before a delete, and writes back the other kind afterwards, with a WARN in the Log |
| Dashboard-variable functions were missing (the README listed them as not provided) | Web Reports loads `DashboardVariables.js` into the report iframe, and this app didn't have it | Shimmed `StoreSharedVariable` / `DeleteSharedVariable` with Web Reports' exact behavior, plus the console's `StoreVariable` family and a minimal `WR.Notify` |
| A plural expression with one result looked singular, and `Relevance` returned strings | The SDK evaluate API gives neither plurality nor types | The typed REST passthrough query (`plural`, `type`, native values), with the SDK as fallback |
| `true`, `false`, `"x"`, `"a <b>"` and numbers as whole expressions got `400 Bad Request` | WebUI rejects relevance text that's also valid JSON, on both APIs | Every expression is sent as `(expr)` |
| The first passthrough attempt with `?relevance=…` got `400 Bad request parameters` | The SDK validator only allows the `{uri}` path parameter | Use `POST` with a `text/plain` body `relevance=…&output=json` |
| Fixlet and task links opened nothing | `linkid:openfixlet(site,id)` had no known WebUI page | `/content/tasks/<site>/<id>` for external sites |
| Custom-site fixlet links opened an empty "Custom Document" | The link carries the master action site id, while WebUI needs the custom site's own id, which relevance can't return | Look the item up by name in WebUI's `/custom/api/tasks?search={"query":…}` and use its `siteID` |
| Opening a tab after an `await` would be blocked as a popup | Browsers only allow `window.open` during the click | Open a blank tab inside the click, then set its `location` once the lookup finishes |
| `in web reports context` → `true` failed with Bad Request | The rewritten expression was the bare JSON literal `true` | The `( )` wrapping fixed it |
| Refresh sections never refreshed | Not implemented | Timer-based re-evaluation of each section's source |
| `SendWakeOnLan` was undefined, so wake-on-LAN buttons threw `ReferenceError` | Web Reports loads `WakeOnLan.js`, and neither WebUI nor its APIs can send wake-on-LAN | A no-op that warns and returns `false`. Opening Web Reports' `/json/wakeonlan` in a tab was tried in 1.2.0 and dropped, because the Web Reports login didn't carry over. |
| `AsyncEvaluateString` in Web Reports shows `[object XMLDocument]` | A Web Reports 11.0.7 bug (`innerHTML = xmlDoc`) | The shim shows the answers instead (a deliberate difference) |
| Font Awesome 5 icons didn't convert in an automated, hidden browser preview | `requestAnimationFrame` never fires in a hidden tab, and Font Awesome batches its DOM changes on it | Not a real problem: the icons render in a visible tab (79 icons on the real server). Remember this when testing in a headless or hidden browser. |
| A local mock made some results look wrong (raw `<string>`, a 70 KB attribute) | The mock returned canned or unescaped answers | Not an app problem. Test relevance results on a real server; use mocks only for CSP, loading and the shim's mechanics. |

## Known limitations

- **Without "Can use REST API":** the SDK fallback can't know plurality or types. There, one value counts as singular, so a plural expression with one result gives a string instead of a one-element array. `Relevance` returns strings, apart from dates, and `<?Relevance ?>` escaping relies on the `(it as html)` method. With REST permission, all of this matches Web Reports.
- **Some bodies are rejected:** WebUI may refuse other relevance text with `400 Bad Request`. The `( )` wrapping only covers the JSON-literal case. A typed request that gets HTTP 400 falls back to the SDK, which may refuse the same text.
- **No Web Reports context:** `in web reports context` is `False` unless the option is on, so reports take their console branch. The option is plain text replacement. There are no Web Reports-only inspectors, and no multi-server Web Reports data.
- **No Web Reports filters or site:** `GetFilterParam()` and `WR.currentSiteID` don't exist here, so a report always sees every computer the WebUI operator can see.
- **Fixlet links:**
  - **Analyses and baselines** have no WebUI detail page, so their links land on WebUI's content list.
  - **Custom and master-site lookups** depend on WebUI's **undocumented** `/custom/api/tasks` API, and on the link text being the item's name. If the API changes, or the name isn't found, the link opens a search of the custom content list instead. When several custom sites have an item with the same id and name, the first match is used.
  - **Other `linkid:` forms** aren't mapped.
- **No wake-on-LAN:** `SendWakeOnLan` does nothing except show a warning, because WebUI has no way to send it ([details](#no-wake-on-lan-in-webui)).
- **Refresh sections:** they refresh on a timer, not on BigFix data changes as the console does. A refreshed section's scripts don't run again. Web Reports doesn't refresh at all, so turn **Refresh sections** off to match it.
- **No report files:** Web Reports serves a report's own files from `/ReportFiles/<reportId>/`, through the `<base href>`. Here there's no `<base>`, and an uploaded report has no stored files, so relative `src`/`href` values (images or scripts shipped with the report) don't load.
- **Missing Web Reports functions:**
  - the rest of the `WR` object (`WR.HTML`, `WR.DOM`, `WR.Array`, `WR.run`, `WR.Filters`, `WR.currentSiteID`)
  - YUI, and Web Reports' own `jQuery/jquery.js`

  A report that uses them without loading its own copy fails, and the error shows in the Log. `WR.Notify`, `WR.URL.ParamMap` and `WR.makeRelevanceArray` **are** provided.
- **Dashboard variables:**
  - **Permissions:** writes run with the WebUI operator's permissions. Web Reports' "admin users only" rule for shared variables isn't enforced here; the SDK applies its own rules.
  - **Restore after delete:** the write-back is two extra calls, so it isn't atomic, and it assumes the private variable in the list is the caller's own. Whether the SDK's `DELETE` also removes **other** operators' private variables with that name wasn't tested; only one operator was used.
  - **Reading:** reports still read with relevance (`shared variable "X" of current wizard`). `current wizard` has no meaning for an uploaded report, so reports should name the dashboard explicitly, for example `shared variables "X" of bes wizards whose (dashboard id of it = "…")`. That needs a dashboard with that id to exist. Reading a variable written by the shim through relevance wasn't tested.
  - **`databaseID`** is ignored.
- **External and template reports** aren't rendered. An external report only gets an **Open in a new tab** button, because WebUI extensions can't frame or call other hosts. Template reports are saved Web Reports pages, not HTML.
- **Report companion files**, which Web Reports serves from `/ReportFiles/<id>/`, aren't supported (see [Ideas](#ideas-not-done-yet)).
- **Libraries:** only the libraries in `LIBRARIES` are available. Everything else from another host is blocked.
- **Parsing:** a `?>` inside a relevance string literal ends the processing instruction early. Web Reports has the same rule. Processing instructions are matched case-insensitively (`<?relevance`).
- **`AsyncEvaluateString`** differs from Web Reports on purpose (see above).
- **Size:** results over the SDK's limits, and very large reports, are only as fast as the SDK API. Each relevance instruction needs one or two requests.

## Security

The report runs in a **same-origin** iframe with `allow-scripts allow-same-origin`. That's necessary so `shim.js` can call the SDK with the operator's WebUI session and XSRF token. It also means **a report's own JavaScript can call any WebUI or SDK API as the logged-in operator**, including the ones that change BigFix. Web Reports has the same trust model, since a report there runs with the Web Reports session. Only render reports you trust.

The Log's **Redact** option, on by default, masks the WebUI host and the user name in copied text, plus any `https://host:port` URL. It doesn't scrub data in results.

## Build

```bash
python3 fetch_libs.py
```

```bash
python3 pack.py
```

This writes `output/web-reports-renderer-<version>.webui`, about 1.27 MB with the libraries. Without `src/static/libs/`, the package is about 12 KB and the Log warns that CDN libraries will be blocked. Bump `version` in both `package.json` and `VERSION` in `src/static/js/app.js`.

## Install

1. In WebUI, open **Extensions Management** (`https://<webui-server>/ui_extensions/next`). This needs `_WebUIAppEnv_ENABLE_EXTENSIONS_MANAGEMENT=1` and a WebUI restart.
2. Click **Install extension from file**, pick a custom site, upload the `.webui` file, and click **Install**. To upgrade, do the same with a higher version and confirm **Confirm upgrade extension**. Re-select the site if the dropdown clears after the file is chosen.
3. Open `/ui_extensions/web-reports-renderer-<siteId>`, or use **Launch**.

## Files

| File | Purpose |
| --- | --- |
| `src/index.html` | Upload and drop area, status, the report iframe (its `sandbox` flags), and the Log |
| `src/static/js/app.js` | Logger, redaction and report; `/me` and `/loggedin` shell; report parsing; `<?Relevance ?>` and refresh-tag substitution; library manifest loading and URL rewriting; building the iframe document |
| `src/static/js/relevance.js` | Shared by the page and the iframe (loaded before `app.js` and before `shim.js`): typed REST evaluation (sync and async), typed-to-HTML and typed-to-answer conversion, and `prepare()` (the options plus the `( )` wrapping) |
| `src/static/js/shim.js` | Runs inside the iframe right after `relevance.js`: `EvaluateRelevance`, `Relevance`, `AsyncEvaluateString` (typed first, SDK fallback); the dashboard-variable functions (Web Reports and console versions), with the restore after delete; `WR.Notify` (banner), `WR.URL.ParamMap` and `WR.makeRelevanceArray`; the console no-ops; the `SendWakeOnLan` no-op and `ThrowError`; `linkid:` link handling for computers, actions and fixlets; and `JSERR`/`BLOCKED`/`DSVAR` logging back to `parent.WRR.log` |
| `src/static/css/app.css` | Page styles |
| `src/static/css/report.css` | Minimal base styles inside the iframe (Web Reports' `sourcewrapper.css` isn't copied) and the relevance-error style |
| `fetch_libs.py`, `libs.lock.json` | Download and pin the CDN library copies (`libs.lock.json` is committed) |
| `pack.py` | Builds the `.webui` file (same script as the other examples) |
| `.gitignore` | Ignores `output/` and `src/static/libs/` |

## Testing status

**Local mock WebUI.** The mock sent the real extension CSP and `nosniff`, rewrote `./HOMEPAGE/`, required XSRF, and returned canned answers. It was used for mechanics only:
- **Relevance cases:** string, html, number (the escaping fallback), plural (the `<br />` join), the error marker, the refresh span, and a relevance instruction inside an attribute.
- **`EvaluateRelevance`:** the synchronous result and the thrown error with `message` and `description`.
- **`Relevance`:** tuple `sort(1)` gave `alpha,mid,zeta`, `toArray` exists, `now` came back as a `Date`, and the async `success` callback ran.
- **Other shim functions:** `AsyncEvaluateString` and the `InsertUtilityDiv` no-op.
- **CDN libraries:** without local copies, all 4 of `HiddenContentChart`'s cdnjs files were blocked. With them, jQuery, d3 and nvd3 loaded and passed `integrity`, and an nvd3 pie drew 2 slices.

**Real WebUI, BigFix 11.0.7.61, master operator.** Installed with **Install extension from file**, and WebUI accepted the 1.2 MB upload.

| Report (from `../../webreports`) | Result |
| --- | --- |
| `PC_Models_By_Domain.besrpt` | 1 relevance instruction rendered |
| `HiddenContentChart.besrpt` | The relevance inside `<script>` worked. jQuery, d3 and nvd3 loaded from local copies with their `integrity` hashes, and **the pie chart drew from live data**. |
| `GenericDataTables.besrpt` | 3 relevance instructions built `<script>`/`<link>` tags (the cdnjs fallbacks), which were rewritten to local copies. The synchronous `EvaluateRelevance` returned the table in about 310 ms, and **DataTables formatted it**. |
| `ComputerComments.beswrpt` | The comments table rendered with DataTables. Computer links are `linkid:opencomputer(...)`. |
| `RelayCacheSizing.beswrpt` | 3 relevance instructions, including a tuple shown as `name, 48 GB` |
| `Computer_Filter_Search.beswrpt` | 3 relevance instructions, DataTables with 27 rows, and **79 Font Awesome 5 icons**. `in web reports context` was `False`, so the console buttons showed. |
| `external-google.webreport`, `EndOfLifeClients.webreport` | Not rendered, each with a clear message (external report, template report) |
| `WordGame.besrpt` | Not tried (181 KB, with no relevance) |

No relevance failed and nothing was blocked in any of them. In 1.0.1, clicking computer and action links opened `/framework/devices/<id>` and `/framework/deployments/<id>`, including a link added by `EvaluateRelevance()`. The fixlet case wasn't exercised.

**Dashboard variables, real WebUI, 1.0.2 and 1.0.3.** Called from the rendered report's window, against a throwaway dashboard id that was empty again afterwards:

| Call | Result |
| --- | --- |
| `StoreSharedVariable(id, 'wrr_shared', 'one', {success, failure})` | `success 200`; reads back as `one`, `IsPrivate=false` |
| `StoreVariable(id, 'wrr_private', 'two', true)` | reads back as `two`, `IsPrivate=true` |
| `StoreVariable(id, 'wrr_default', 'three')` | reads back as `three`, `IsPrivate=false` (shared by default) |
| `StoreSharedVariable(id, 'wrr_shared', '')` | `WR.Notify.error: Attempt to set dashboard datastore value failed: missing required arguments.` |
| `DeleteSharedVariable` / `DeletePrivateVariable` / `DeleteVariable` | Each deleted its variable; reading afterwards gave 404 |
| Delete of a name that doesn't exist | The console functions throw `Not Found`; `DeleteSharedVariable` calls `failure` with status 404 |
| A private and a shared `same`, then `DeletePrivateVariable` | 1.0.2: **both were gone** (the SDK quirk). 1.0.3: the shared `same=SHARED` remained, with a "restored shared variable" WARN. |
| A private and a shared `same`, then `DeleteSharedVariable` | 1.0.3: `success 200`, and the private `same=PRIVATE2` remained, with a "restored private variable" WARN |

**1.1.0 and 1.1.1, real WebUI, operator with Can use REST API:**

| Check | Result |
| --- | --- |
| `<?Relevance "a <b>" & "" ?>` | typed `string`, escaped: `a &lt;b&gt;` |
| `<?Relevance html "<b>bold</b>" ?>` | typed `html`, left as HTML |
| `number of bes computers`, `exists bes computers` | `142`, `True` (typed `integer`, `boolean`) |
| `(name of it, html "<i>x</i>") of …` | `BIGFIX, <i>x</i>`: typed `( string, html )`, so only the html item is left unescaped |
| `EvaluateRelevance("names of … whose (id of it = …)")`, one match | **array of length 1** (exact plurality) |
| `Relevance("(name, id, last report time) of …")` | array of tuples with a native `number` and a `Date` |
| `Relevance("number of bes computers")` / `Relevance("exists bes computers")` | `number` / `boolean` |
| `EvaluateRelevance("names of error")` | threw `The operator "error" is not defined.` |
| `new WR.URL.ParamMap()`, then `finish()` | `a=1%202&a=3&b=x%26y`, the same as Web Reports |
| `WR.Notify.warning(...)`, `WR.Notify.errorHTML(...)` | warning and error banners in the report |
| `<?BeginRefreshRelevance id="clock" ManualRefresh="00:00:10"?>` with `<?Relevance now ?>` | refreshed every 10 s; the time changed |
| Click `linkid:openfixlet(1,6120)` | `/content/tasks/1/6120` |
| Click `linkid:openfixlet(2299662135,3571)` (task in custom site ClientSettings) | `/custom/tasks/8589938636/3571`, matching WebUI's own URL |
| Click `linkid:openfixlet(2299662135,49)` (task in the master action site) | `/custom/tasks/2299662135/49` |
| Option: dashboard id = an existing `.ojo` dashboard | `name of current wizard` gave that dashboard's name; without the option, `current wizard` gave nothing |
| Option: `in web reports context` as true | 1.1.0: `[relevance error: Bad Request]` (the bare-`true` JSON quirk). **1.1.1: `True`**, and `False` with the option off |
| `<?Relevance "a <b>" ?>`, `<?Relevance 5 ?>`, `<?Relevance false ?>`, `EvaluateRelevance("\"x\"")` | 1.1.1: all work (before the `( )` wrapping, all got 400) |
| External report (`external-google.webreport`) | the status message plus an **Open https://www.google.com/ in a new tab** button |

**1.2.0 and 1.2.1, real WebUI, wake-on-LAN:**

| Check | Result |
| --- | --- |
| Web Reports' own `GET /json/wakeonlan?cid=<offline computer>`, from a Web Reports page | `{"success":true}`. Computer ID `1`, which doesn't exist, got the same. |
| 1.2.0: a report button calling `SendWakeOnLan([id])`, which opened `/json/wakeonlan` in a new tab | The tab opened, but Web Reports answered `Invalid username or password.` The same URL typed into a tab gave `{"success":true}`. The approach was dropped. |
| 1.2.1: a report button calling `SendWakeOnLan([1, 2], 'db1')` | Returned `false`, showed the warning banner, logged `WOL SendWakeOnLan(2 computers, dbid db1) ignored: …`, and opened no window |
| 1.2.1: `ThrowError('boom')` | threw `Error` with message `boom` |

## How to investigate further

**Reading Web Reports' real behavior:** open any custom report in Web Reports, then run this in the browser console:

```js
const w = document.getElementById('wr_reportSourceWrapper').contentWindow
String(w.EvaluateRelevance)  // also Relevance, AsyncEvaluateString, JSONRelevanceQuery, ReplaceString, GetQueryBody, ParseResult
String(w.WR.makeRelevanceArray)
fetch(document.getElementById('wr_reportSourceWrapper').src).then((r) => r.text())  // raw HTML before scripts ran
```

**Testing a report in this app on a server:** open the app's page, then feed a report in from the console:

```js
const dt = new DataTransfer()
dt.items.add(new File([reportText], 'Name.beswrpt', { type: 'text/plain' }))
const input = document.getElementById('wrr-file')
input.files = dt.files
input.dispatchEvent(new Event('change'))
// then read #wrr-status, the Log (#log-text), and document.getElementById('wrr-frame').contentDocument
```

**Finding WebUI pages for other link types:**
- **List pages:** look at the `href` values on WebUI's list pages. `/framework/devices` and `/framework/deployments` gave `/framework/devices/<id>` and `/framework/deployments/<id>`. WebUI's Custom Content list (`/custom/tasks`) links `/custom/tasks/<siteID>/<id>`.
- **API calls behind a page:** `performance.getEntriesByType('resource')` on a WebUI page lists the calls it made. That's how `/custom/api/tasks` and its `search={"query":...}` format were found, by typing into the page's search box.

**Checking typed evaluation:** `fetch('/api/sdk/passthrough/api/query', {method: 'POST', headers: {'Content-Type': 'text/plain', 'X-XSRF-TOKEN': <cookie>}, body: 'relevance=' + encodeURIComponent('(' + expr + ')') + '&output=json'})`.

## Ideas not done yet

- **Wake-on-LAN, if a later BigFix adds an API for it:** check the SDK's `/api/openapi.json` and the passthrough's `GET api/help` for a wake-on-LAN resource, then map `SendWakeOnLan(cids, dbid)` to it in `shim.js`. Only `cids` matters, because WebUI has one database. Test on a single computer.
- **Report companion files (not done, by choice):** accept a zip of the report plus its images, and serve them as `blob:` URLs. WebUI's CSP allows `blob:` for images only, not scripts.
- **Reports already in Web Reports:** load a stored report by id, for example by reading the site files through the SDK, instead of uploading one.
- **Refresh on data change** rather than a timer, for example by polling a cheap change marker.
- **Analysis and baseline links:** if a later WebUI adds detail pages for them, map them in `shim.js`.
