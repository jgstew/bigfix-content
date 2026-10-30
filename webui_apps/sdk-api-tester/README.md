# SDK API Tester - BigFix WebUI extension

A plain HTML/JS WebUI extension that calls **every WebUI SDK REST API** (`/api/sdk/...`) with a minimal example, and doubles as a test suite. It's built the same way as [../session-relevance-query-html](../session-relevance-query-html/): no HCL code, no build step, packaged by `pack.py` (about 18 KB).

Results go into a table. Every request is written to a **Log** that starts collapsed at the bottom of the page. Expand it and click **Copy report** to get the results, the API coverage, and the full log as one block of text you can paste somewhere for troubleshooting.

## Safe vs manual tests

| Kind | How it runs | What it does |
| --- | --- | --- |
| **Safe** (23 tests) | **Run all safe tests**, or each row's **Run** button | Read-only calls. The one exception is a private dashboard variable under `SdkApiTester.ojo`, which is created, read, updated, listed, and then deleted. |
| **Manual** (18 tests) | Only from the button on its card; asks for confirmation first | Anything that changes BigFix: stopping actions, activating analyses, creating a site, importing, editing and deleting content, uploading files, sending a BigFix Query, and passthrough POST/PUT/DELETE |

The manual tests clean up after themselves where the API allows it:

- **Content lifecycle** imports a never-relevant task (`Relevance` is `false`), reads it, edits its title, deletes it, and then checks that it's gone.
- **Operator site import** imports the same task and then deletes it.
- **Not cleaned up:** the SDK has no delete for custom sites or uploaded files. The card text and the confirmation say how to remove them, for example with a passthrough `DELETE api/site/custom/<name>`.

## API coverage

These are all 26 operations listed in the server's `/api/openapi.json` ("WebUI SDK APIs"). The report has a coverage section that maps each one to its tests and their latest status.

| Operation | Tests | Kind |
| --- | --- | --- |
| `POST /api/sdk/sessionrelevance/evaluate` | `sr.singular`, `sr.tuple`, `sr.error`, `sr.noxsrf` | safe |
| `GET /api/sdk/resources/{type}/{id}` | `res.get.{fixlet,task,analysis,baseline,computergroup}`, `res.get.badtype`, `res.get.missing`, `content.get` | safe / manual |
| `GET /api/sdk/resources/{type}/external/{site}/{id}` | `res.get.external` (BES Support) | safe |
| `PUT /api/sdk/resources/{type}/{id}/edit` | `content.edit` | manual |
| `POST /api/sdk/resources/{type}/delete` | `content.delete`, `content.opimport` | manual |
| `GET /api/sdk/dashboardvariables` | `ds.all` (logs a count only; the body can be close to 1 MB) | safe |
| `GET/POST/PUT/DELETE /api/sdk/dashboardvariable/{dashboardId}[/{name}]` | `ds.create`, `ds.get`, `ds.update`, `ds.list`, `ds.delete` | safe |
| `GET /api/sdk/passthrough/{uri}` | `pt.get.serverinfo`, `pt.get.sites`, `pt.get.noprefix`, `pt.get.custom` | safe / manual |
| `POST/PUT/DELETE /api/sdk/passthrough/{uri}` | `pt.post`, `pt.put`, `pt.delete` | manual |
| `POST /api/sdk/actions/stop` | `act.stop` | manual |
| `POST /api/sdk/analyses/activate`, `.../deactivate` | `ana.activate`, `ana.deactivate` | manual |
| `POST /api/sdk/site/custom` | `site.create` | manual |
| `POST /api/sdk/site/custom/{site}/import`, `/api/sdk/site/operator/import` | `content.import`, `content.opimport` | manual |
| `POST /api/sdk/site/custom/{site}/file`, `/api/sdk/site/operator/file`, `/api/sdk/mailbox/{computerId}` | `file.custom`, `file.operator`, `file.mailbox` | manual |
| `POST /api/sdk/clientquery`, `GET /api/sdk/clientqueryresults/{id}` | `cq.submit`, `cq.results` (polls every 5 seconds, for up to 60 seconds) | manual |

The `TakeFixletAction` family is not covered. It comes from the client-side `useBfTakeFixletAction()` hook in `bfcore-react`, which opens the Take Action dialog, and it isn't a REST API.

## Facts confirmed on a live WebUI while writing this

- **`/api/openapi.json`** serves the SDK's OpenAPI 3.0 spec even when `/api/api-docs` (Swagger UI) is not turned on.
- **Responses:** every SDK response is an `objectResponse`: `{"done": true, "id": ..., "value": ...}`.
- **Resources:** `resources/{type}/{id}` returns BES XML. A bad `resourceType` gets a 400 that lists the allowed values: `fixlet`, `task`, `analysis`, `baseline`, `computergroup`.
- **Passthrough URIs need the `api/` prefix:** `passthrough/api/sites` works, and `passthrough/sites` returns 404 from the BigFix server.
- **Missing dashboard variable:** reading a dashboard ID or variable that doesn't exist returns `404 {"message": "Not Found"}`.
- **Custom sites have no site ID** in session relevance (`id of site` fails), so the analysis card prefills the master action site ID. The console's wizard API worked the same way.
- **File uploads** to a custom site or the operator site return `{"done": true, "id": <fileId>, "value": "The file <name> was uploaded with ID: <fileId> on site <site>"}`.
- **The mailbox upload has a bug.** `POST /api/sdk/mailbox/{computerId}` stores the file, but then returns `500 {"message": "Cannot read properties of undefined (reading 'ID')"}`. A passthrough `GET api/mailbox/{computerId}` shows the file as a `<ComputerMailboxFile>` with its `<ID>`, so WebUI's SDK handler seems to choke on that reply. `file.mailbox` checks the mailbox this way and reports WARN instead of FAIL when the file arrived. Seen with BigFix 11.0.7.61.

## Build and install

```bash
python3 pack.py
```

Then in WebUI open **Extensions Management**, click **Install extension from file**, pick a custom site, upload `output/sdk-api-tester-<version>.webui`, and click **Install**. To upgrade, bump `version` in `package.json` and install again into the same site.

## Using the log

- **Copy report** gives the header (tester version, user agent, BigFix version, master operator flag), the results, the API coverage, and the full log.
- **Redact server address and user name when copying** is on by default. It replaces the WebUI host name or IP and your user name with `<REDACTED_n>`, and replaces the host in any `https://host:port` URL with `<SERVER>`, such as the BigFix server name in `Resource="..."` attributes. It doesn't scrub other data in response bodies, such as computer names in BigFix Query results or site names, so check before pasting outside your organization.
- **Log response bodies of successful calls** adds the first 400 characters of each successful response. Failed calls always log up to 1,000 characters of the body.
- **Clipboard blocked:** if the browser won't allow clipboard access, the report goes into the log box and is selected, so you can press Ctrl+C or Cmd+C.
- **Session expiry:** on a 401 the tester logs a warning instead of redirecting to the login page, so the log isn't lost.

## Files

| File | Purpose |
| --- | --- |
| `src/index.html` | Layout: toolbar, results table, manual-test cards, and the collapsed log |
| `src/static/js/webui.js` | Logger, redaction, report, and the `SAT.api()` request helper (session cookies plus `X-XSRF-TOKEN`) |
| `src/static/js/tests.js` | The test runner and all test definitions. Add a test with `SAT.test({ id, group, title, api, safe, run })`. |
| `src/static/js/app.js` | Header, results table, buttons, and input helpers (site list, a recently reporting computer ID, analysis lookup) |
| `src/static/css/app.css` | Styles |
| `pack.py` | Builds `output/<name>-<version>.webui` (same script as `session-relevance-query-html`) |

## Testing status

- **Local mock WebUI:** every test passed. The mock copies the response shapes captured from a real server, rewrites `./HOMEPAGE/`, enforces a strict CSP, and requires XSRF. All 23 safe tests passed, and all 18 manual tests passed with `confirm()` auto-accepted. Report redaction and coverage were checked.
- **Real WebUI (BigFix 11.0.7.61, master operator):** installed with **Install extension from file**, and **Run all safe tests** passed **23 of 23** in about 6.5 seconds. Results included:
  - every resource type was returned as BES XML of the right type, including a BES Support fixlet
  - a missing ID got `404 Resource with id ... does not exists.`
  - `ds.all` returned 692 variables, about 788 KB
  - the private test variable was created, read, updated, listed, and deleted, and its read-back was then 404
  - the passthrough returned 59 sites
  - a request without the XSRF header was rejected with 403

  Manual tests run by hand on the same server (1.0.0):

  - **`act.stop` passed.** The response is an array of `{"done": true, "value": "ok", "id": <actionId>}`, one per action.
  - **Content lifecycle passed** in a custom site. `content.import` found the new task's `<ID>` in the import response; `content.get` and `content.edit` read back the right titles; `content.delete` removed the task, and reading it afterwards gave 404.
  - **`cq.submit` passed**, returning query id `{"id": <n>}`.
  - **`cq.results` passed** against an online computer. The answer arrived on the second poll, about 5 seconds after submitting. The response `value` is `{reportingAgents, totalResults, results: [...]}`, and each result row is `{computerID, computerName, subQueryID, isFailure, result, ResponseTime}`.
  - **An earlier run gave WARN** with `{"reportingAgents": 0, "totalResults": 0, "results": []}` for 60 seconds. Its target came from **Use lowest computer id**, which picked a computer that last reported in 2018, so nothing could answer. In 1.0.1 the helper is **Use a recently reporting computer**: it picks a computer that reported in the last hour, and falls back to the lowest ID if none did.

  Later manual runs on 1.0.1:

  - **`file.custom` and `file.operator` passed.** Each returned the new file ID.
  - **`file.mailbox` failed with 500**, even though the file was stored. This is the WebUI bug described above. 1.0.2 confirms the upload through the passthrough and reports WARN.
  - **`cq.submit` and `cq.results` passed again**, against the computer picked by **Use a recently reporting computer**. The answer came in about 5 seconds.
  - **`pt.get.custom` passed** with `api/serverinfo`. That response includes the database type, name, and schema version.

  Not run on a real server yet: `ana.activate`, `ana.deactivate`, `site.create`, `content.opimport`, and passthrough POST/PUT/DELETE.
