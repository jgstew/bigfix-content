# Session Relevance Query (plain HTML) - BigFix WebUI extension

The same session relevance query tool as [../session-relevance-query](../session-relevance-query/), written as plain HTML, CSS, and JavaScript:

- **No HCL code.** No `bfcore-react` and no Patronus, so the source and the built `.webui` file can be shared or committed.
- **No build step.** You don't need Node, npm, the SDK template, or an HCL network connection. Edit the files in `src/` and repackage.
- **Small.** The `.webui` file is about 6 KB, compared with about 2.2 MB for the React template version.

The trade-off is that it doesn't have the standard WebUI navigation bar or WebUI's look. A small header has a **← BigFix WebUI** link to `/`, the app title, the logged-in user name, and **Log out**. WebUI opens extensions in a new browser tab, so the full WebUI is usually still open in another tab.

## Files

| File | Purpose |
| --- | --- |
| `package.json` | `name`, `displayName`, `version`, `description` (read by WebUI) |
| `src/index.html` | Page markup. Asset paths use `./HOMEPAGE/` (see below). |
| `src/static/js/app.js` | WebUI request helper, shell (user name and keep-alive), and the query UI |
| `src/static/css/app.css` | Styles |
| `pack.py` | Builds `output/<name>-<version>.webui` using only the Python standard library |

## Build

```bash
python3 pack.py
```

This writes `output/session-relevance-query-<version>.webui`. Run `python3 pack.py --dry-run` to validate `package.json` and list the files without writing anything.

`pack.py` produces the same zip layout as the SDK template's `npm run packit`:

```
package.json                      package.json plus "main": "./index.html"
<name>-<version>/index.html
<name>-<version>/static/js/app.js
<name>-<version>/static/css/app.css
```

The `name` is the same as the React version (`session-relevance-query`) and the version is 1.1.0, so installing it with **Install extension from file** into the same site upgrades the React version in place. Bump `version` whenever you change anything.

## Install

1. In WebUI, open **Extensions Management** (`https://<webui-server>/ui_extensions/next`). This needs the server setting `_WebUIAppEnv_ENABLE_EXTENSIONS_MANAGEMENT=1` and a WebUI restart.
2. Click **Install extension from file**, pick a custom site, upload the `.webui` file, and click **Install**.
   - **To upgrade**, use this same button with the same site. WebUI sees the same `name` with a newer `version` and asks to replace it (**Confirm upgrade extension**). The **Update** item in the row's Action menu crashed with a blank page on the test server: a `ReferenceError` in WebUI's own Extensions Management code.
3. Click **Launch**. The app is served at `/ui_extensions/<name>-<siteId>`.

## How it works

- **`./HOMEPAGE/` paths:** `index.html` references its assets as `./HOMEPAGE/static/...` with `<base href="./HOMEPAGE/">`, exactly like the create-react-app build the template produces. On install, the WebUI server rewrites `./HOMEPAGE/` to `/ui_extensions/<name>-<siteId>/`. This was confirmed on a real server with this hand-written page.
- **No inline script or style:** everything is in `static/`. The real server's CSP does allow inline scripts and styles, but keeping them out means the page won't break if a later WebUI tightens the policy. The CSP does **not** allow loading anything from other hosts (`default-src 'self'`, `connect-src 'self' wss:`), so every library has to ship inside the `.webui` file. No CDNs.
- **Requests:** `webuiFetch()` in `app.js` does what the template's `BfHttpClient` does:
  - sends the session cookies (`credentials: 'same-origin'`)
  - sends the `XSRF-TOKEN` cookie back as an `X-XSRF-TOKEN` header
  - redirects to `/timeout?nextpage=...` on a 401 or an `iem-login-required` response header
  - rejects with the server's `message` on errors
- **Shell:** WebUI's own page frame does three things this shell copies:
  - shows the user name from `GET /me` (`userName`)
  - pings `GET /loggedin` every 30 seconds, so an open page keeps the session alive
  - has a logout link to `/logout`

  `/me`, `/loggedin`, and `/logout` are not documented APIs. Their use here matches what WebUI's own `bfcore-react` code does.
- **Safe output:** results are written with `textContent`, never `innerHTML`, because relevance results can contain HTML.
- **Query API:** `POST /api/sdk/sessionrelevance/evaluate` with `{"session_relevance": "..."}`. It needs **Can use WebUI** and BigFix Web Reports. On a real WebUI the response is `{"done": true, "value": [...], "id": {}}`. Every value comes back as a **string**, including numbers and booleans, and tuple rows are arrays of strings. `normalizeRows()` also accepts a bare array, which is what the OpenAPI doc describes.

## Testing status

- **Mock server (passed):** tested in a browser against a local mock WebUI server that rewrites `./HOMEPAGE/`, enforces a strict CSP, checks the XSRF header, and fakes `/me`, `/loggedin`, and the query API. These all worked:
  - tuple and singular results
  - the 1000-row cap
  - HTML in results shown as text
  - server error messages
  - Ctrl+Enter and the example buttons
  - redirect to `/timeout` on a 401
  - the 30-second keep-alive
- **Real WebUI API (passed):** the same request code was run from a logged-in WebUI browser session, without installing the extension. Results:
  - `GET /me` returns 200 with `userName` and `userPermission`.
  - `GET /loggedin` returns 200 with the body `true`.
  - A query with the XSRF header returns 200. The same query without it returns **403 `invalid csrf token`**, so the header is required.
  - A relevance error returns **500** `{"message": "The operator \"error\" is not defined."}`. The app shows that message.
  - `done` was `true` every time, including for a 27,386-row result returned in about 1.5 seconds.
- **Installed on a real WebUI (passed):** 1.1.0 was installed as an upgrade over the React 1.0.0 in a custom site, then launched. Results:
  - `./HOMEPAGE/` was rewritten to `/ui_extensions/session-relevance-query-<siteId>/`, and the CSS and JS loaded.
  - The header showed the logged-in user name.
  - The computers tuple query returned 142 rows in 4 columns, in about 340 ms.
  - A bad relevance query showed the server's error message.
  - Ctrl+Enter works.
