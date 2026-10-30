# Session Relevance Query - example BigFix WebUI extension

A minimal BigFix WebUI custom app ("UI extension") that evaluates session relevance and shows the results as a table.

- One text box to enter session relevance; Ctrl+Enter or **Evaluate** runs it
- Results show in a table: tuples are split into columns `item 0`, `item 1`, ...; singular results get one column
- Result count, elapsed time, error message, and **Copy as TSV**
- Up to 1000 rows are shown. For bigger result sets, limit the query itself.

Only one API is used:

```
POST /api/sdk/sessionrelevance/evaluate
Content-Type: application/json

{"session_relevance": "names of bes computers"}
```

This SDK endpoint needs the operator to have **Can use WebUI**. It does not need **Can use REST API**. It needs BigFix Web Reports, which evaluates the session relevance. Results are limited to what the logged-in operator is allowed to see.

## How it works

These files are not a standalone project. They go on top of HCL's WebUI SDK app template (React 17, `bfcore-react`, Patronus). The template provides:

- `BfHttpClient` from `bfcore-react`: an axios wrapper that returns an RxJS Observable. It sends the WebUI session cookies and the `XSRF-TOKEN` cookie back as an `X-XSRF-TOKEN` header. On a 401 response it redirects to `/timeout`.
- `BfApp`: the standard WebUI page chrome.
- `npm run packit`: builds the app and zips it into `output/<name>-<version>.webui` (`package.json` plus the build folder).

Files in this folder:

| File | Purpose |
| --- | --- |
| `src/App.js` | Replaces the template's `src/App.js`. It renders `SessionRelevanceQuery` instead of the samples accordion. |
| `src/SessionRelevanceQuery/SessionRelevanceQuery.js` | The component |
| `src/SessionRelevanceQuery/SessionRelevanceQuery.css` | Styles |

## Build

Prerequisites: an HCL network connection (Patronus packages come from an internal npm registry set up in the template's `.npmrc`). The template's README asks for Node 16.

1. Get a copy of the WebUI SDK app template.
2. Copy this folder's `src/` over the template's `src/`. This replaces `App.js` and adds `SessionRelevanceQuery/`. You can delete `src/BigfixSamplesExtensions/`.
3. In the template's `package.json`, set:
   ```json
   "name": "session-relevance-query",
   "displayName": "Session Relevance Query",
   "version": "1.0.0",
   "description": "Evaluate session relevance and view results in a table",
   ```
   `name` must match `/^[a-z0-9_-]*$/` and `version` must match `/^\d+(\.\d+)*$/`, or `packit` fails.
4. Build and package:
   ```bash
   npm install
   ```
   ```bash
   npm run packit
   ```
   This produces `output/session-relevance-query-1.0.0.webui`.

To develop locally, use `npm start` (port 3006). The API calls only work when the app is served by a WebUI server, because they need its session cookies.

## Install

1. In WebUI, open **Extensions Management** (`https://<webui-server>/ui_extensions/next`).
2. Click **Install app from file**, pick a custom site, upload the `.webui` file, and confirm.
3. Click **Launch** on the installed extension.

Operators can see the app only if they can access the custom site it was installed to.

To push a rebuilt version over an existing install on a custom site, the template has `npm run update -- -u=<user> -p=<password> -s=<server:port>`. That command passes the password on the command line, so prefer the UI on shared machines.

## Notes

- The template's own `BigfixSamplesExtensions/BigfixSessionRelevanceSample` reads results from `response.value`. The OpenAPI doc describes a bare array. `normalizeRows` accepts either shape.
- WebUI SDK API docs are served at `https://<webui-server>/api/api-docs` once the WebUI server setting `_WebUIAppEnv_ENABLE_API_DOC_SETTING=1` is set.
- Session relevance reference: https://developer.bigfix.com/relevance/guide/session/
