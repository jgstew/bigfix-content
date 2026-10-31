# Web Reports Renderer - BigFix WebUI extension

Renders a BigFix **Web Reports custom report** inside WebUI, with all of its relevance evaluated through WebUI. It uses the platform REST query (typed, through the SDK passthrough) when the operator has **Can use REST API**, and the SDK's `POST /api/sdk/sessionrelevance/evaluate` otherwise. It's plain HTML and JavaScript with no HCL code, packaged by `pack.py`. The current version is **1.5.1**.

1. **Choose a report**:
   - **from a BigFix site** (since 1.3.0): the **Report from a site** drop-down lists the custom reports stored in sites, the way Web Reports lists them. Their scripts and stylesheets load from the same site. This needs **Can use REST API**. See [Reports from sites](#reports-from-sites-and-the-shared-cache).
   - **or upload / drop one**, such as the ones in [`../../webreports`](../../webreports): `.besrpt` / `.beswrpt` files containing report HTML, or `.webreport` files, which are `<BESWebReport>` XML. Only `<Type>CustomReport</Type>` is rendered.
2. **Every `<?Relevance ?>` is replaced** with its result, the way Web Reports does on the server.
3. **The report renders in an iframe** inside `<div id="wr_datapage">`, like Web Reports, with [`shim.js`](src/static/js/shim.js) loaded first. Its JavaScript calls to `EvaluateRelevance()`, `Relevance()` and `AsyncEvaluateString()` are answered through the same SDK API. Its dashboard-variable calls (`StoreSharedVariable()`, `DeleteSharedVariable()`, and the console's `StoreVariable()` family) go to `/api/sdk/dashboardvariable/...`.
4. **CDN `<script>`/`<link>` tags** are rewritten to local copies, because WebUI blocks every other host.
5. **Console links** (`linkid:...`) for computers, actions, fixlets and tasks open the matching WebUI page in a new tab.
6. **Refresh:** `<?BeginRefreshRelevance?>` sections re-evaluate on a timer.
7. **Config** (collapsed, under the Log): treat `in web reports context` as true (on by default since 1.3.0), and refresh sections. **Show template reports** is next to the site drop-down. `current wizard` always refers to the report's own dashboard id, `WebReportsRenderer-<ReportNameNoSpaces>.ojo`.
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

### Reports in sites (seen on 11.0.7)

- **Listing:** Web Reports' report list includes report files from sites. It opens one as `?page=CustomReport&ReportID=<n>&ReportPath=<file>.beswrpt&ReportSiteID=<Site+Name>`.
- **Companion files:** the report's iframe gets `<base href="/SiteData/<server>/Sites/<Site%20Name>/">`. So `src="jquery-3.7.1.min.js"` loads that site's file, from the folder Web Reports gathered. These are the same files the REST API lists for the site.
- **References that aren't in the site** also fail in Web Reports: `JSResourceManager.js`, `DataService.js`, `json2.js` and `ComponentLibrary.js` from Power Management's reports all give 404 there. They look like console-only files.
- **Images and fonts the custom reports ask for:** 66 distinct file names, which are **40 distinct assets** once colors, sizes and file types are merged (13 colors of the jQuery UI icon sheet count as one, and `sort-asc.gif` and `sort-asc.png` as one). **Only 15 of the 40 exist in any site**, so the other 25 (22 jQuery UI theme images, 6 grid images, 7 Google Fonts files, and some report images) are missing in Web Reports too. Of the 15 that do exist, 3 are library assets (jQuery UI icons and two sort arrows) and 12 are report-specific (print, save, refresh and arrow icons, a header background, and so on).
- **What's in the sites of the test server:** 82 report files in 12 of the 40 sites with files: 27 `CustomReport`, 54 `TemplateReport` (saved Web Reports pages), and one `.btrpt` that's plain HTML. Most SCM Reporting and Power Management reports load 17 to 67 files by relative name, all from the site's top folder: jQuery, jQuery UI, SlickGrid, jqPlot, `ADFAPI_2.2.3.js`, CSS, and images.

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
  - **fixlet or task in the master action site or a custom site** → `/custom/tasks/<webuiSiteId>/<fixletId>`. Master-action-site content uses the master site id (`/custom/tasks/<masterSiteId>/<id>`, which is what WebUI's own list links to). **Custom-site content needs the custom site's own id** (`/custom/tasks/<customSiteId>/<id>`, where `<customSiteId>` is a 10-digit number such as `85899xxxxx`). With the master id, the page loads only an empty "Custom Document".
  - **analysis or baseline** → **no WebUI detail page**. `/content/tasks/<site>/<id>` falls back to the content list, and `/content/baselines/...` is `Page Not Found`.
- **The site id inside `linkid:openfixlet(site, id)`:**
  - external sites: the site's id (`1` for BES Support, `8102` for Power Management)
  - **the master action site and every custom site: the master action site id** (a 10-digit number, `<masterSiteId>`)

  Session relevance can't return a custom site's own id: `id of <custom site>` fails, `id of it | 0` gives `0`, and the REST site XML (`GET api/site/custom/<name>`) has no id either.
- **WebUI's internal custom-content API**, which WebUI's Custom Content page uses and which isn't in the SDK spec:
  - `GET /custom/api/tasks?filter={}&pagination={"page":{"itemsPerPage":N,"offset":0}}&search={"query":"<text>"}&sort={"method":"name","order":"asc"}`, with each value URL-encoded JSON
  - It returns `{count, data: [...], lastUpdated}`. Each row has `contentID`, `siteID` (WebUI's id, `<customSiteId>` for custom sites), `siteName`, `siteType`, `name`, `type`, and about 25 other fields.
  - `search` must be `{"query": "..."}`; other shapes such as `{text}`, `{name}` and `{value}` return 500.
  - `GET /custom/api/tasks/sites` lists `{siteName, Type, OpSiteName, siteCount}` with **no** ids. The test server had 2,880 custom items.
- **WebUI pages send `X-Frame-Options: DENY`,** so they can't open inside the report iframe.

### Typed relevance through the REST passthrough

The platform REST query API, reached through the SDK passthrough, returns what the SDK evaluate API leaves out:

```
POST /api/sdk/passthrough/api/query        Content-Type: text/plain
relevance=<urlencoded relevance>&output=json

-> {"result":[142],"count":1,"plural":false,"type":"integer","evaltime_ms":0.06}
-> {"result":["<computer name>"],"count":1,"plural":true,"type":"string",...}            plural even with one result
-> {"result":["<b>x</b>"],"plural":false,"type":"html",...}
-> {"result":[["<computer name>",<computerId>,"Sat, 31 Oct 2026 06:46:45 -0400"]],"plural":true,"type":"( string, integer, time )"}
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

### BES Explorer or Web Reports answers (seen 31 Oct 2026, 11.0.7.61)

WebUI answers session relevance from BES Explorer when one is running and falls back to Web Reports otherwise, on **both** relevance APIs (`/api/sdk/sessionrelevance/evaluate` and the typed REST passthrough to `/api/query`). On the test server the answers changed partway through the day because **BES Explorer on the root server had stopped**, and they changed back when it was started again. The full comparison is in [../README.md](../README.md#where-webuis-session-relevance-comes-from-confirmed-on-110761).

| | Earlier | Later |
| --- | --- | --- |
| `in web reports context` | `False` | `True` (both APIs) |
| `number of site files of all bes sites` | 4144 | `0` |
| `number of bes computers` | about 300 ms | about 3,600 ms; the REST answer says `evaltime_ms: 0`, so the time goes somewhere else |
| `("%2541")` | evaluated as sent | **`"A"`**: `%xx` is decoded once before the relevance parser, so `("100%25")` fails with *A string constant had an improper %-sequence* and `("x%2520y")` gives `x y` |
| Reading a dashboard variable | about 170 ms | about 3,900 ms |

What the renderer does about it:
- **`%` probe** (1.4.1, and since 1.5.1 through the shared [`../shared/webui-relevance.js`](../shared/webui-relevance.js)): `(in web reports context, "%2541")` once per API at page load and every 5 minutes; the iframe uses the page's instance. When Web Reports answers, every `%` is sent as `%25`, which made `width='100%25'` and the site query work again. The Log says who answers (`relevance through the SDK API is now answered by BES Explorer`), and every render's `Options:` line repeats it.
- **Results differ by source,** and WebUI gives no way to choose one. "Custom - Computer Summary" answered all 7 relevance instructions from Web Reports, but only 6 from BES Explorer: there, `display names of subscribed sites of …` fails with *This operation is not supported*.
- **Empty site list:** a site query with **no** sites is treated as "can't tell", not "no sites". The cached list stays, unchanged and not pruned, with a WARN. In this mode the site list can't be refreshed through relevance, because `site files` is empty.

### Site files through the REST passthrough (11.0.7)

- **Session relevance can't list files:** `<bes site file>` has only `id`; `name`, `size`, `sha1` and the rest aren't defined. `exists site files of <bes site>` and `version of <bes site>` work.
- **No version for some sites:** `version of <bes site>` fails with "Singular expression refers to nonexistent object" for the master action site and custom sites. The REST API's `GET /api/site/<type>/<name>/version` has it, as `<SiteVersion LastModified="…">2132</SiteVersion>`.
- **Listing:** `GET /api/site/<type>/<name>/files` returns `<SiteFile Resource="…/file/<id>">` entries with `<Name>`, `<ID>`, `<LastModified>` and `<IsClientFile>`, with no size or hash. All 40 sites were listed in 1.7 s in parallel; BES Support has 799 files.
- **Path encoding:** the site name in the path is %-encoded, so `BES%20Support` for the REST API itself. **Through the WebUI passthrough it has to be encoded twice** (`BES%2520Support`), because WebUI decodes the path once before forwarding it. A single-encoded path gets `500 {"message":"Request path contains unescaped characters"}`.
- **Content:** `GET …/file/<id>` returns the raw file as `application/octet-stream; charset=utf-8`, with `X-Content-Type-Options: nosniff`. GETs work without the XSRF header.
- **Binary files are corrupted by the passthrough, and it can't be undone.** It decodes the body as UTF-8, so every invalid byte sequence becomes U+FFFD (`ef bf bd`). Measured on Power Management's `A.png`:
  - **Web Reports' copy:** 3,246 bytes, starting `89 50 4e 47`, with 1,536 bytes of 0x80 or above covering all 128 such values
  - **The passthrough's copy:** 5,727 bytes, starting `ef bf bd 50`

  More than a thousand bytes became the same marker, so the originals can't be recovered. `Accept: application/octet-stream`, `image/png`, `*/*`, `Accept-Encoding: identity` and `Content-Type: application/octet-stream` all gave the same bytes, so it happens inside WebUI's passthrough. UTF-8 text survives, **including SVG**. Other images, fonts, and text in other encodings can't be used from sites.
- **Other routes to the bytes are blocked too:** Web Reports' `/SiteData/…` and the root server's gather URLs are other hosts, and the extension's `img-src 'self' blob:` blocks even an `<img>` pointed at them.
- **Scripts and styles can't be referenced directly** even though the URL is same-origin: `nosniff` blocks a script or stylesheet served as `application/octet-stream`.

### The extension's security policy applies to the report too

- **Inherited policy:** extension pages get `default-src 'self'; img-src 'self' blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self' wss:; sandbox …; frame-ancestors 'self'` plus `X-Content-Type-Options: nosniff`. A **`srcdoc` iframe inherits that policy** from its parent page.
- **Effect:** every `<script src>` and `<link href>` to another host in a report is blocked (reported as `script-src-elem` / `style-src-elem` violations), which leaves `$` undefined. Inline `<script>` and `<style>` still run, and so does `eval`.

## What this app does

| Web Reports feature | Here |
| --- | --- |
| All relevance | Goes through `WRREL.prepare()` in [`relevance.js`](src/static/js/relevance.js), which applies the two options below and wraps the expression in `( )`, the JSON-literal workaround. Then it's evaluated **typed** (REST passthrough) when available. Otherwise it uses the SDK API: after the first 403, the typed path is off for the rest of the page, and any other HTTP failure falls back to the SDK for that call. |
| `<?Relevance expr ?>` | **Typed:** values whose type is `html`, including `html` items of a tuple, are inserted as they are; everything else is HTML-escaped, with booleans written `True`/`False`. **SDK fallback:** evaluates `(it as html) of (expr)` so the server escapes strings and leaves `html` alone; if that cast fails, as it does for integers, booleans and tuples, it evaluates `expr` and escapes the values in the page. Either way, tuples become `a, b`, plural results are joined with `<br />`, and errors show inline as `<span class="wrr-relevance-error">[relevance error: …]</span>`. Repeated identical expressions are evaluated once, and up to 4 run at a time. The Log shows how each was done (`typed integer`, `typed ( string, html )`, `SDK as html`, `SDK escaped`). |
| `<?BeginRefreshRelevance id="x" …?>` … `<?EndRefreshRelevance?>` | Become `<span id="x" data-wrr-refresh="n">` … `</span>`; the default id is `__DRRSN`, the console's. With **Refresh sections** on (the default), each section's source is re-evaluated on a timer and the span's `innerHTML` replaced, without running its scripts again. The interval is the shortest `hh:mm:ss` attribute (`ManualRefresh`, `ActionResults`, and so on), with a floor of 10 seconds, or 60 seconds when there are no attributes. Web Reports itself never refreshes; this is the console's behavior. |
| Config: **Treat `in web reports context` as true** | **On by default since 1.3.0** (off before), because the reports are written for Web Reports. In the collapsed **Config** section under the Log. Rewrites the text `in web reports context` to `true` before evaluating, so reports take their Web Reports branch. This is plain text replacement, so it also changes string literals that contain the phrase. |
| `current wizard` (since 1.3.0, no longer an option) | Always rewritten to `(bes wizard whose (dashboard id of it = "<id>"))`, with `<id>` = `WebReportsRenderer-<report name with all whitespace removed>.ojo`, for example `WebReportsRenderer-CVESearch.ojo`. So each report gets its own namespace, and never shares dashboard variables with the console or Web Reports. A `"` in the id becomes `%22`. `DASHBOARD_IDS` in `app.js` can map a report name to a different id, for a report known to be safe and worth sharing variables with; it's empty. 1.0.x to 1.2.x had a text box for this instead, empty by default, which left `current wizard` meaning nothing. |
| Web Reports' page around the report | Some reports restyle Web Reports' page through `window.parent`: `getElementById('wr_header').style.margin = 0`, and `style` on `<html>`/`<body>`. `index.html` has **hidden stand-ins** with Web Reports' ids (`wr_mainpage`, `wr_header`, `wr_headertop`, `wr_logo`, `wr_versionHeader`, `wr_subnavigation`, `saveReport`, `filterSection`, `editSourceLink`, `wr_datapage`, `wr_reportSourceWrapper`), and a `style` a report sets on the renderer's `<html>` or `<body>` is **undone** with an INFO line, because `overflow: hidden` stops the page scrolling. |
| Options storage | Remembered per browser in `localStorage` under `web-reports-renderer-options-v2` (`in web reports context`, refresh sections, show template reports); if storage is blocked, the defaults are used. They apply at the next render. The key is new in 1.3.0, so values saved by older versions are ignored. |
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
| `alert(message)` (since 1.5.0) | No dialog. The message becomes an `ALERT` line in the Log and is listed in red under the report title (`#wrr-alerts`). A repeat of the last message adds a count (`(x2)`), the list keeps 20 messages, and it's cleared at the next render. `alert()` returns at once, so the report's code keeps running where a real dialog would have paused it. |
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

### Reports from sites and the shared cache

[`sites.js`](src/static/js/sites.js) builds the **Report from a site** list. [`companions.js`](src/static/js/companions.js) loads a chosen report's files.

**Building the list:**
1. **Sites:** one session relevance query lists every site with site files: name, version, and REST path.
   - The path is built in relevance, with each special character escaped once (`%20`, `%2F`, `%23`, `%3F`, `%26`, `%25`).
   - For sites without a version (the master action site and custom sites), the version comes from `GET …/version` instead.
2. **Files:** each new or changed site is listed with `GET …/files`, 4 at a time. **Only sites with at least one report file** (`.beswrpt`, `.besrpt`, `.btrpt`, `.webreport`, and not a client file) keep their file list.
3. **Kept files:** the reports, plus every non-client file a report could load (`.js .json .css .html .htm .txt .xml .svg` and the image types).
4. **Report names and types:** each report file is downloaded **once**, to read `<Name>` and `<Type>` from `<BESWebReport>` XML. Raw HTML counts as a `CustomReport` named after the file. A report whose file id and `LastModified` haven't changed reuses the cached name and type.

**The drop-down:**
- It groups reports by site and sorts them by name. Only `CustomReport`s show unless **Show template reports** is checked; the status says how many are hidden.
- **The cached list shows first**, as soon as the shared variable has been read (174 ms after page load on the test server). That happens before the site query answers. Each changed site then replaces its entry as soon as it's listed, and the current selection is kept.
- **Rescan sites** lists every site again.

**The cache** is the shared dashboard variable `WebReportsRenderer-SiteFileListingCache`, under dashboard id `WebReportsRenderer.ojo`:

```json
{
  "schema": 1,
  "writtenAt": "2026-10-31T14:16:58.583Z",
  "writtenBy": { "app": "web-reports-renderer", "version": "1.3.0" },
  "sites": [
    {
      "name": "<site name>", "path": "/api/site/external/<encoded name>/files", "version": 85,
      "reports": [{ "id": 123, "file": "X.beswrpt", "name": "<Name from the file>", "type": "CustomReport", "modified": "<LastModified>" }],
      "files": { "jquery-3.7.1.min.js": 456 }
    }
  ],
  "checked": { "<site with no reports>": 12 }
}
```

- **`checked`** keeps just the name and version of each site that has files but no reports, so those sites aren't listed again on every load.
- **When it's used:** a cache with another `schema`, or written by another **major** version of the renderer, is ignored and rebuilt.
- **Size:** about 65 KB for the test server (12 report sites, 28 kept versions in `checked`).
- **Updates:** a page that changed anything writes the cache back. A page that found nothing changed writes nothing.
- **Deleted sites:** only a **master operator** removes sites that are missing from its own site list. Other operators may not see every site, so they keep entries they can't see. Each reader shows only the sites its own site query returned.

**The lock** is the shared variable `WebReportsRenderer-SiteFileListingCache-Lock`: `{owner, user, app, version, started, expires}`.
- **To get it:** a page that needs to update reads the lock. If it's free or expired (after 2 minutes), the page writes its own random `owner`, waits 1.5 s, and reads it back. Only a page that still sees its own `owner` updates.
- **Release:** the lock is deleted afterwards, but only if it's still this page's.
- **While another page holds it,** this page shows the cached list and says so.
- **Why this is enough:** the SDK has no compare-and-swap, so this is best effort. If two pages still race, both write a complete cache and the last write wins. The lock only saves duplicate work.
- **No permission to write shared variables:** the page lists sites for itself and doesn't save.

**Loading a chosen report:** `GET …/file/<id>` reads the report file. After relevance substitution and the CDN rewrite, [`companions.js`](src/static/js/companions.js) resolves its relative references by last path segment, ignoring case and `?query`. It looks first in that site's file list, then by name in a **pool** (see the next list). Uploaded reports use the pool too.

| Reference | Here |
| --- | --- |
| `<script src="x.js">` | **Inlined** as `<script data-wrr-file="x.js">…</script>`. `src`, `integrity`, `crossorigin`, `async` and `defer` are dropped, other attributes kept. A `</script` inside the file is escaped as `<\/script`. |
| `<link rel="stylesheet" href="x.css">` | **Inlined** as `<style data-wrr-file="x.css">`, keeping `media`. Relative `url()` values inside it are resolved from the same source when it can provide bytes. |
| `<img src>`, `<input src>`, `<source src>`, `style="…url()…"`, and `url()` in inlined CSS | **SVG** from the site becomes a `blob:` URL of type `image/svg+xml`, because SVG is text and survives the passthrough. Other image types and fonts from a site are corrupted, so they come from the pool instead: a bundled copy by its package URL, or an SVG from another site as a `blob:`. |
| Found in the pool | A **bundled** script or stylesheet gets its `src`/`href` pointed at the package copy (same-origin, correct type), without `integrity`/`crossorigin`. A file from **another site** is inlined. The Log says where it came from: an `INFO` for the same file name, a `WARN` for a different one. |
| Not found anywhere | Left alone and logged as `FILES … not found anywhere` |

**The pool** is built for each render, from:
- **The renderer's bundled library copies** (`static/libs`, from `fetch_libs.py`): served by WebUI as real files, so images and fonts work, for example the six jQuery UI 1.12.1 icon sheets, DataTables' sort images, and Font Awesome 4.7 fonts.
- **The text files of every listed report site** (`.js .css .json .html .htm .txt .xml .svg`). Their binary files are left out, because they'd arrive corrupted.

**How a name is matched:**
1. **The same file name.** When the name has a version in it (`jquery-1.12.4.min.js`), that's the same file, so it wins. A name without a version (`jquery.min.js`) says nothing about the version, so it only wins if nothing newer matches in step 2.
2. **The same logical name, newest version first.** Version numbers, `.min`, jQuery UI colors (`_444444`) and sizes (`_256x240`) are removed, `-` and `_` are treated alike, and all image types count as one (`sort-asc.png` matches DataTables' `sort_asc.png`). Ties go to the report's own site, then to a bundled copy.

   This isn't the file the report asked for, so the Log warns, for example `WARN images/ui-icons_2e83ff_256x240.png is not usable from site "SCM Reporting"; using ui-icons_444444_256x240.png from the renderer's bundled jqueryui 1.12.1 instead (the newest name match, not the same file)`. A different jQuery UI icon color, or a newer library version than a report was written for, can look or behave differently.
3. **Fonts** only come from bundled copies; the policy blocks `blob:` and `data:` fonts.

- **Script elements are set aside** behind placeholders while stylesheets and images are processed, then put back. `jquery.jqplot.js` has `<link rel="stylesheet" href="jquery.jqplot.css">` in a comment, which an earlier build replaced inside the JavaScript.
- **File sources are pluggable:** a source is `{ label, has(name), getText(name), getBlob(name) }`. `WRRFILES.fromSite(site)` is the site source, with no `getBlob`. An upload source with real blobs would reuse `resolve()` unchanged. See [Ideas](#ideas-not-done-yet).

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
| jsPDF-AutoTable 3.5.13 (since 1.5.0) | `jspdf.plugin.autotable.min.js` (Power Management "Model Power Savings") |
| Vue 3.3.8 (since 1.5.0) | `vue.global.js` (SCM "ARF Report Generator") |
| DataTables plug-ins 1.10.15 (since 1.5.0) | `api/fnSortNeutral.js`. This is also the alias for `https://cdn.datatables.net/plug-ins/1.10.13/api/fnSortNeutral.js`, which isn't on cdnjs at 1.10.13 but is **byte-identical** (sha256 `d77ccac8…`, checked 31 Oct 2026). |

In total that's 36 files, about 4.1 MB on disk; the built `.webui` is about 1.4 MB.

**Which libraries are bundled:** a run of the renderer on the test server listed every external `.js`/`.css` URL in the 28 site reports, and `grep` did the same for `../../webreports`. Everything pinnable is now bundled. Two URLs can't be, because they name no version: `https://cdn.jsdelivr.net/npm/vue/dist/vue.min.js` and `https://unpkg.com/vue@next` (both in ARF). **The page itself can't fetch a missing library** at run time: the extension policy's `connect-src 'self'` blocks other hosts. So a new one is added at build time: take the URL from the Log's `WARN … no local copy` line, add its cdnjs path to `LIBRARIES`, and run `python3 fetch_libs.py --update-lock`.

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
| The site query failed with "Singular expression refers to nonexistent object" | `version of <bes site>` doesn't exist for the master action site and custom sites | `(if exists version of it then version of it else 0)`, then the REST `…/version` for those sites |
| Site file listing failed with `500 Request path contains unescaped characters` | WebUI decodes the passthrough path once | Encode every `%` again (`%2520`) |
| An SCM report failed with `SyntaxError: Unexpected token '.'` after its files were inlined | `jquery.jqplot.js` has a `<link rel="stylesheet">` example in a comment, and the stylesheet pass replaced it inside the inlined script | Script elements are set aside before the stylesheet and image passes |
| Images from sites don't load | The WebUI passthrough decodes binary files as UTF-8; it can't be reversed, and no request header avoids it | SVG is served from the text. Other images and fonts come from bundled copies or name matches, with a `WARN` when the name differs. |
| "Custom - Computer Summary" got worse later in the day: 6 of 7 relevance instructions failed with *improper %-sequence* | BES Explorer had stopped, so Web Reports answered, and it decodes `%xx` once more (see [BES Explorer or Web Reports answers](#bes-explorer-or-web-reports-answers-seen-31-oct-2026-110761)), so its valid `width='100%25'` reached the parser as `100%'` | A `("%2541")` probe per API at page load, and `%` sent as `%25` when the API decodes |
| In that mode the site query returned no sites, which would have emptied the drop-down, and a master operator's page would have pruned the shared cache | Web Reports has no site files | An empty site list keeps the cached list unchanged |
| `jquery.min.js` matched the bundled jQuery 3.1.1 although a site had jQuery 3.7.1 | An exact name match always won | An exact name only wins outright when it contains a version; otherwise the newest match wins |
| Log4j, Windows 11 and CVE Search reports stopped with `Cannot read properties of null (reading 'style')` | They restyle Web Reports' page through `window.parent.document.getElementById('wr_header')`, and the renderer page had no such element | Hidden stand-ins with Web Reports' ids in `index.html`; `<html>`/`<body>` styles set by a report are undone |
| `SendWakeOnLan` was undefined, so wake-on-LAN buttons threw `ReferenceError` | Web Reports loads `WakeOnLan.js`, and neither WebUI nor its APIs can send wake-on-LAN | A no-op that warns and returns `false`. Opening Web Reports' `/json/wakeonlan` in a tab was tried in 1.2.0 and dropped, because the Web Reports login didn't carry over. |
| `AsyncEvaluateString` in Web Reports shows `[object XMLDocument]` | A Web Reports 11.0.7 bug (`innerHTML = xmlDoc`) | The shim shows the answers instead (a deliberate difference) |
| Font Awesome 5 icons didn't convert in an automated, hidden browser preview | `requestAnimationFrame` never fires in a hidden tab, and Font Awesome batches its DOM changes on it | Not a real problem: the icons render in a visible tab (79 icons on the real server). Remember this when testing in a headless or hidden browser. |
| A local mock made some results look wrong (raw `<string>`, a 70 KB attribute) | The mock returned canned or unescaped answers | Not an app problem. Test relevance results on a real server; use mocks only for CSP, loading and the shim's mechanics. |

## Known limitations

- **Without "Can use REST API":** the SDK fallback can't know plurality or types. There, one value counts as singular, so a plural expression with one result gives a string instead of a one-element array. `Relevance` returns strings, apart from dates, and `<?Relevance ?>` escaping relies on the `(it as html)` method. With REST permission, all of this matches Web Reports.
- **Some bodies are rejected:** WebUI may refuse other relevance text with `400 Bad Request`. The `( )` wrapping only covers the JSON-literal case. A typed request that gets HTTP 400 falls back to the SDK, which may refuse the same text.
- **No Web Reports context:** WebUI evaluates `in web reports context` as `False`. The Config option, on by default, makes it `true` by plain text replacement, so it also changes string literals that contain the phrase. Turn it off to see a report's console branch. There are no Web Reports-only inspectors, and no multi-server Web Reports data.
- **No Web Reports filters or site:** `GetFilterParam()` and `WR.currentSiteID` don't exist here, so a report always sees every computer the WebUI operator can see.
- **Fixlet links:**
  - **Analyses and baselines** have no WebUI detail page, so their links land on WebUI's content list.
  - **Custom and master-site lookups** depend on WebUI's **undocumented** `/custom/api/tasks` API, and on the link text being the item's name. If the API changes, or the name isn't found, the link opens a search of the custom content list instead. When several custom sites have an item with the same id and name, the first match is used.
  - **Other `linkid:` forms** aren't mapped.
- **No wake-on-LAN:** `SendWakeOnLan` does nothing except show a warning, because WebUI has no way to send it ([details](#no-wake-on-lan-in-webui)).
- **Reports from sites:**
  - **Permission:** they need **Can use REST API**, both to list the files and to load them.
  - **A site's own images and fonts can't be used, except SVG.** The WebUI passthrough corrupts binary files irreversibly. A bundled copy or a name match stands in where there is one, sometimes in a different color or version, with a `WARN`. Report-specific images, such as print or save icons, have no stand-in.
  - **Run-time requests:** relative files that a report asks for at run time (`fetch('x.json')`, `$.getScript`, `new Image().src`) aren't served. Only `<script src>`, `<link rel="stylesheet">` and image attributes in the HTML are resolved.
  - **Only the last path segment counts:** `images/x.png` is looked up as `x.png`, the same flat layout as a site folder.
  - **Visibility:** the cache lists every report site its last writer could see. Anyone who can read shared dashboard variables can read those site and file names. Each reader only *shows* the sites it can see, and loads files with its own permissions.
- **Web Workers from `blob:` URLs are blocked** (`worker-src`). SCM's "ARF Report Generator" starts one, so it can't fully work in WebUI even with Vue bundled; it now gets further and then stops with a `TypeError`.
- **Refresh sections:** they refresh on a timer, not on BigFix data changes as the console does. A refreshed section's scripts don't run again. Web Reports doesn't refresh at all, so turn **Refresh sections** off to match it.
- **No report files:** Web Reports serves a report's own files from `/ReportFiles/<reportId>/`, through the `<base href>`. Here there's no `<base>`, and an uploaded report has no stored files, so relative `src`/`href` values (images or scripts shipped with the report) don't load.
- **Missing Web Reports functions:**
  - the rest of the `WR` object (`WR.HTML`, `WR.DOM`, `WR.Array`, `WR.run`, `WR.Filters`, `WR.currentSiteID`)
  - YUI, and Web Reports' own `jQuery/jquery.js`

  A report that uses them without loading its own copy fails, and the error shows in the Log. `WR.Notify`, `WR.URL.ParamMap` and `WR.makeRelevanceArray` **are** provided.
- **Dashboard variables:**
  - **Permissions:** writes run with the WebUI operator's permissions. Web Reports' "admin users only" rule for shared variables isn't enforced here; the SDK applies its own rules.
  - **Restore after delete:** the write-back is two extra calls, so it isn't atomic, and it assumes the private variable in the list is the caller's own. Whether the SDK's `DELETE` also removes **other** operators' private variables with that name wasn't tested; only one operator was used.
  - **Reading:** reports still read with relevance (`shared variable "X" of current wizard`). Since 1.3.0, `current wizard` is the report's own `WebReportsRenderer-<ReportNameNoSpaces>.ojo`, which exists only once a variable has been stored there. To read another dashboard's variables, a report has to name it explicitly, for example `shared variables "X" of bes wizards whose (dashboard id of it = "…")`. That needs a dashboard with that id to exist. Reading a variable written by the shim through relevance wasn't tested.
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
2. Click **Install extension from file**, pick a custom site, upload the `.webui` file, and click **Install**. To upgrade, do the same with a higher version and confirm **Confirm upgrade extension**. Installing the **same** version again asks **Confirm overwrite extension** instead, and replaces it. Re-select the site if the dropdown clears after the file is chosen.
3. Open `/ui_extensions/web-reports-renderer-<siteId>`, or use **Launch**.

## Files

| File | Purpose |
| --- | --- |
| `src/index.html` | The **Report from a site** drop-down, upload and drop area, status, the report iframe (its `sandbox` flags), and the Log |
| `src/static/js/app.js` | Logger, redaction and report; `/me` and `/loggedin` shell; report parsing; `<?Relevance ?>` and refresh-tag substitution; library manifest loading and URL rewriting; building the iframe document |
| `src/static/js/sites.js` | Reports from sites: the site query, file listings, report names and types, the shared cache and its lock |
| `src/static/js/companions.js` | Resolves a report's relative scripts, stylesheets and images from a file source (inlining, `blob:` URLs), and the site file source |
| `../shared/webui-relevance.js` | Shared by the apps here; `pack.py` adds it as `static/js/webui-relevance.js`. Who answers relevance (BES Explorer or Web Reports), the `%` probe, and `(expr)` wrapping. |
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
| Click `linkid:openfixlet(<masterSiteId>,<id>)` (task in a custom site) | `/custom/tasks/<customSiteId>/<id>`, matching WebUI's own URL |
| Click `linkid:openfixlet(<masterSiteId>,<id>)` (task in the master action site) | `/custom/tasks/<masterSiteId>/<id>` |
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

**1.3.0, real WebUI, reports from sites** (40 sites with files, 12 with reports):

| Check | Result |
| --- | --- |
| First load, no cache | 40 sites listed and 82 report files read in **9.0 s**. 28 reports in 10 sites shown, 54 templates hidden. Cache saved: **65,519 characters**. |
| Second load | Cached list in the drop-down **174 ms** after the page loaded. 1 site had changed and was listed again (2.6 s), then the cache was saved. |
| Third load, nothing changed | Cached list in 174 ms; `0 new or changed`; one dashboard-variable request (the read) and no write |
| **Rescan sites** | Lock present during the rescan, gone afterwards; 40 sites in 5.7 s with **0 report files downloaded again** (same id and `LastModified`); cache saved |
| A lock held by another page (a test lock expiring in 60 s), then **Rescan sites** | Kept the cached list, status *Another page is updating the site list…*, log names the holder. The test lock was then deleted. |
| SCM Reporting "Computer Compliance Detail" | 28 files inlined (jQuery, jQuery UI, SlickGrid, jqPlot, `ADFAPI_2.2.3.js`, CSS); 6 images can't load (binary) and 10 CSS images aren't in the site; **no script errors**. The first build hit `SyntaxError` from the jqPlot comment (fixed). |
| All 28 site reports | Rendered. No script errors in the BigFix Labs, SCM Reporting, Tivoli Remote Control, Reporting and Dashboards reports, or in "Model Power Savings". Log4j, Windows 11 and CVE Search are clean since the stand-ins. |
| Script errors still seen, all from the reports' own code | Six Power Management reports: `Unexpected end of JSON input` from jQuery, after `(if exists current wizard then dashboard id of current wizard else "false")`. **Web Reports doesn't list these reports either**; they look like console dashboards. "Wake on Web": `ActiveXObject is not defined` (console-only code). "Difference in the Calculation…": `init is not defined`, because its scripts are the files that also 404 in Web Reports. CyberFOCUS Analytics: `Cannot read properties of undefined (reading 'length')`. |
| CVE Search, compared with Web Reports | Same 220 characters of page text in both, and no console error in Web Reports |
| Default dashboard id | Log shows e.g. `dashboard id for current wizard = WebReportsRenderer-CVESearch.ojo` |
| Installing the same version again | WebUI asked **Confirm overwrite extension** and replaced it |

**1.4.0, name matching and SVG, all 28 site reports again:**

| Check | Result |
| --- | --- |
| "Difference in the Calculation…" (Power Management) | `json2.js`, `JSResourceManager.js`, `DataService.js` and `swfobject.js`, which aren't in Power Management, were found under the same names in BES Support and BES Inventory and License |
| Power Management reports using `jquery-ui.css` | All six `images/ui-icons_<color>_256x240.png` came from the bundled jQuery UI 1.12.1 under the same names. "Power Consumption Over Time" and "Weekly Idle Time Breakdown" no longer show a script error. |
| SCM "Computer Compliance Detail" | 7 name matches with `WARN`s: the three site icon colors (`72a7cf`, `3f5b73`, `2e83ff`) became bundled `ui-icons_444444`, and `sort-asc.png`/`sort-desc.png` became DataTables' `sort_asc.png`/`sort_desc.png` (1.10.19, the newest bundled) |
| Node unit test of the ranking | `jquery.min.js` → a site's `jquery-3.7.1.min.js`; `jquery-1.12.4.min.js` → the exact file; `jquery-1.7.2.min.js` (absent) → `jquery-3.7.1.min.js`; `fontawesome-webfont.woff` → the bundled `.woff2`; an unknown font → nothing; SVG from the site → `blob:` of type `image/svg+xml` |
| Dashboards "Custom - Computer Summary" | `collapse.gif`, added by the report's script at run time and not in any site, stays broken (Web Reports can't load it either) |

**1.4.1, with WebUI answering like Web Reports** (`in web reports context` true, about 3.5 s per request):

| Check | Result |
| --- | --- |
| Probe at page load | `{"sdk": true, "typed": true}`: both APIs decode `%xx` once more |
| Site list | Site query found no sites; the cached list (12 sites, 28 reports) stayed, with the WARN and *The site list could not be checked for changes right now* |
| Dashboards "Custom - Computer Summary" | **7 of 7** relevance instructions worked (with 1.4.0 in this mode: 6 failed), 368 table rows, no script errors; 13.2 s because every request takes about 3.5 s |

**1.5.0, real WebUI:**

| Check | Result |
| --- | --- |
| An uploaded report calling `alert("Could not load the data: test")` twice and `alert("second message")` once | No dialog; three `ALERT` Log lines; under the title in red: `Could not load the data: test (x2)` and `second message`; the script after the alerts ran |
| Power Management "Model Power Savings" | `Using local copies for 1 CDN file(s): jspdf-autotable/3.5.13/jspdf.plugin.autotable.min.js`; no blocked files and no script errors (before: 1 blocked) |
| SCM "ARF Report Generator 1.0.0" | Local `vue/3.3.8/vue.global.js` used; the two unversioned Vue URLs are still blocked; `worker-src` blocked its `blob:` worker; one `TypeError` from code it builds at run time |
| `fetch_libs.py --update-lock`, then a plain run | Only the three new files were added to `libs.lock.json`; every existing hash was unchanged; all three passed cdnjs SRI |

**1.5.1, shared helper, while BES Explorer was stopped and after it was started again:**

| Check | Result |
| --- | --- |
| BES Explorer started again, page loaded | Log: `relevance through the SDK API is now answered by BES Explorer` (and REST). The site query worked again: 40 sites, 1 changed, cache saved. |
| "Custom - Computer Summary" on BES Explorer | 6 of 7: `display names of subscribed sites of …` gives *This operation is not supported* (all 7 worked on Web Reports) |

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
- **Companion files for uploaded reports:** add an upload source to `companions.js` (`{label, has, getText, getBlob}` over several picked files, or a zip). `resolve()` already inlines scripts and CSS and turns images into `blob:` URLs for a source that has bytes.
- **Get the passthrough fixed:** WebUI's `/api/sdk/passthrough/...` should forward response bodies as raw bytes. That would make every site image and font usable. The measurements in [Site files through the REST passthrough](#site-files-through-the-rest-passthrough-1107) are a ready reproduction.
- **Base64 copies for sites you control:** a convention such as `logo.png.b64` next to `logo.png`, which the site source would decode into a real image.
- **More bundled assets:** add jQuery UI theme images (the `ui-bg_*` files) and other common library images to `fetch_libs.py`, so more name matches are exact.
- **Run-time file requests:** intercept `fetch` / `XMLHttpRequest` for relative URLs inside the iframe and answer them from the report's file source.
- **Reports saved in Web Reports itself** (not in sites) aren't reachable from WebUI; only site reports are listed.
- **Refresh on data change** rather than a timer, for example by polling a cheap change marker.
- **Analysis and baseline links:** if a later WebUI adds detail pages for them, map them in `shim.js`.
