# Relevance Query (plain HTML) - BigFix WebUI extension

A BigFix WebUI extension that runs **session relevance** and **client relevance**, written as plain HTML, CSS, and JavaScript. It has the [bigfix-relevance-analyzer](https://github.com/jgstew/bigfix-relevance-analyzer) (MIT) built in, running in the browser as WebAssembly:

- **Editor:** the analyzer's CodeMirror editor and language server, the same ones its playground and VS Code extension use. You get highlighting, inspector completion, hover help, lint underlines, and quick fixes.
- **Analysis panel:** dialect, parse and type errors, diagnostics, unknown inspectors, complexity and evaluation cost, and a suggested fix you can apply with one click.
- **Auto mode:** the analyzer decides whether the statement is client or session relevance, and the page runs it the right way, using only WebUI SDK APIs:

  | Dialect | How it runs |
  | --- | --- |
  | session | `POST /api/sdk/sessionrelevance/evaluate` |
  | client | BigFix Query: `POST /api/sdk/clientquery`, then `GET /api/sdk/clientqueryresults/{id}` with exponential backoff: waits of 1, 2, 4, 8, 16 and 32 seconds, then **every 60 seconds** until **600 s** (checks at about 0, 1, 3, 7, 15, 31, 63, 123, 183 … 543 and 600 s; since 2.0.3, before which it checked every 3 s for up to 60 s). Results show per computer as they arrive. |
  | both | Both at once, in separate sections |
  | uncertain or undetermined, or the statement doesn't parse | Not run. Choose **Session** or **Client** under **Mode** to run it anyway. |

**The analyzer loads in the background.** The page works the moment it opens, with a plain text box, and every query runs as session relevance until the analyzer is ready. Then the editor replaces the text box (keeping what you typed) and Auto mode starts. If the analyzer can't load, the page stays on session relevance and says why; **Mode** can still run a BigFix Query.

**You don't have to wait for a BigFix Query to finish** (since 2.0.3). **Evaluate** stays enabled while computers are still answering, so you can change the relevance and run again at once. The page stops polling the earlier query and shows only the new run; the earlier query itself keeps running on the server. Before 2.0.3, Evaluate was disabled until every target answered or 60 seconds passed. A run now waits up to 600 seconds for answers, checking less often as time goes on.

**BigFix Query targets** are filled in automatically when the page opens, with the 5 computers that reported most recently. Computers that are offline never answer a BigFix Query. You can type other computer IDs at any time. **Use the 5 most recently reporting computers** fills them in again.

There's **no HCL code**: no `bfcore-react` and no Patronus. A small header replaces the WebUI nav bar, with **← BigFix WebUI**, the app title, the logged-in user name, and **Log out**.

## Files

| File | Purpose |
| --- | --- |
| `package.json` | `name`, `displayName`, `version`, `description` (read by WebUI) |
| `src/index.html` | Page markup. Asset paths use `./HOMEPAGE/` (see below). |
| `src/static/js/analyzer.js` | Loads and verifies the analyzer in the background |
| `src/static/js/app.js` | WebUI request helper, shell (user name and keep-alive), editor swap, analysis panel, and session and client runs |
| `src/static/css/app.css` | Styles, including the CSS variables the analyzer's editor reads |
| `fetch_analyzer.py` | Downloads the pinned analyzer release into `src/static/analyzer/` (git-ignored) |
| `pack.py` | Builds `output/<name>-<version>.webui` using only the Python standard library |

## Build

```bash
python3 fetch_analyzer.py
```

```bash
python3 pack.py
```

`fetch_analyzer.py` downloads `bigfix-relevance-analyzer-web.zip` from the analyzer's **v1.43.0** GitHub release. Both the version and the zip's SHA-256 are pinned in the script. It checks the zip against that hash, then checks every file against the set's `manifest.json`, and unpacks into `src/static/analyzer/`. That folder is git-ignored, so the roughly 9 MB of WebAssembly is never committed. To move to a newer analyzer, update `ANALYZER_VERSION` and `ZIP_SHA256` from that release's `SHA256SUMS.txt`.

Without `src/static/analyzer/`, `pack.py` warns and builds a session-only package, which is about 10 KB.

`pack.py` writes `output/session-relevance-query-<version>.webui`, about 8.5 MB with the analyzer. `python3 pack.py --dry-run` validates and lists the files without writing anything. The zip layout is the same as the SDK template's `npm run packit`:

```
package.json                      package.json plus "main": "./index.html"
<name>-<version>/index.html
<name>-<version>/static/js/...
<name>-<version>/static/css/app.css
<name>-<version>/static/analyzer/manifest.json, editor.js, glue.mjs, analyzer.core*.wasm.gz
```

The `name` is still `session-relevance-query`, so installing 2.0.0 into the same site upgrades the earlier versions in place.

## Install

1. In WebUI, open **Extensions Management** (`https://<webui-server>/ui_extensions/next`). This needs the server setting `_WebUIAppEnv_ENABLE_EXTENSIONS_MANAGEMENT=1` and a WebUI restart.
2. Click **Install extension from file**, pick a custom site, upload the `.webui` file, and click **Install**.
   - **Installed from a site** (WebUI-JGStew): when the site has a newer `relevance-query.webui`, use **Repair** in the row's Action menu. **Update** stays greyed out, and nothing shows that a newer version is there.
   - **To upgrade**, use this same button with the same site. WebUI sees the same `name` with a newer `version` and asks to replace it (**Confirm upgrade extension**). The **Update** item in the row's Action menu crashed with a blank page on the test server: a `ReferenceError` in WebUI's own Extensions Management code.
3. Click **Launch**. The app is served at `/ui_extensions/<name>-<siteId>`.

Permissions: session relevance needs **Can use WebUI** and BigFix Web Reports. BigFix Query needs whatever WebUI requires for BigFix Query on the targeted computers.

## How it works

- **`./HOMEPAGE/` paths:** `index.html` references its assets as `./HOMEPAGE/static/...` with `<base href="./HOMEPAGE/">`, like the create-react-app build the template produces. On install, the WebUI server rewrites `./HOMEPAGE/` to `/ui_extensions/<name>-<siteId>/` (confirmed on a real server).
- **Content-Security-Policy:** WebUI serves extensions with `default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; connect-src 'self' wss:` and `X-Content-Type-Options: nosniff`.
  - The page's own code is in `static/`.
  - The analyzer has to run as inline scripts (`'unsafe-inline'`) and compile WebAssembly (`'unsafe-eval'`).
  - Nothing can be loaded from another host, so the analyzer ships inside the `.webui` file.
- **Analyzer loading** (`analyzer.js`) follows the analyzer's consumer contract (`tools/playground-wasm/SPLIT_ANALYZER.md` in its repo):
  1. Fetch `manifest.json` and every file with `cache: "no-cache"`.
  2. Check every file's size and SHA-256 with `crypto.subtle`. A core that the server already inflated is checked against `raw_size` and `raw_sha256`.
  3. Answer the glue's fetches of `analyzer.coreN.wasm` from the checked bytes, inflated with `DecompressionStream("gzip")` and served as `application/wasm`.
  4. Run `editor.js` and the glue as inline scripts. The glue is run inline because WebUI serves `.mjs` files with a type that `nosniff` blocks for module scripts.
  5. Await `__component.$init`, and refuse to start if `version()` differs from the manifest.
- **Requests:** `webuiFetch()` in `app.js` does what the template's `BfHttpClient` does:
  - sends the session cookies (`credentials: 'same-origin'`)
  - sends the `XSRF-TOKEN` cookie back as an `X-XSRF-TOKEN` header
  - redirects to `/timeout?nextpage=...` on a 401 or an `iem-login-required` response header
  - rejects with the server's `message` on errors
- **Shell:** copies what WebUI's own page frame does:
  - shows the user name from `GET /me`
  - pings `GET /loggedin` every 30 seconds to keep the session alive
  - links to `/logout`
- **BigFix Query targets:** session relevance can't sort, so the page asks for `(id of it, (now - last report time of it) / second) of bes computers` that reported in the last hour, widening to a day if fewer than 5 did. It sorts by age and takes the 5 freshest.
- **Safe output:** results are written with `textContent`, never `innerHTML`, because relevance results can contain HTML.
- **Response shapes:**
  - **Session relevance:** `{"done": true, "value": [...], "id": {}}`. Every value comes back as a string, and tuple rows are arrays of strings.
  - **BigFix Query results:** `value` is `{reportingAgents, totalResults, results: [{computerID, computerName, subQueryID, isFailure, result, ResponseTime}]}`.

- **Session relevance goes through the shared [`../shared/webui-relevance.js`](../shared/webui-relevance.js)** (since 2.0.2), which `pack.py` adds as `static/js/webui-relevance.js`. WebUI answers from BES Explorer when it's running and from Web Reports otherwise, and the two differ (see [../README.md](../README.md#where-webuis-session-relevance-comes-from-confirmed-on-110761)). The helper sends `%` as `%25` when Web Reports answers, and each result line ends with who answered, for example `3 results in 210 ms, answered by BES Explorer`. **2.0.2 on the test server:** upgraded from 2.0.1 with **Repair**, after WebUI-JGStew had the new `relevance-query.webui`. In Session mode, `("100%25", number of bes computers)` gave `100%` and `142`, with the result line *1 result in 292 ms, answered by BES Explorer*.
- **Session relevance is sent as `(expr)`** (since 2.0.1). WebUI 11.0.7 answers `400 Bad Request` when the whole relevance text is also valid JSON (`true`, `false`, `"x"`, numbers). The parentheses evaluate the same and are never valid JSON. The analyzer still sees the text as typed, and BigFix Query text is sent unchanged: its `ApplicabilityRelevance` of `true` works there.

## Testing status

- **2.0.3, local mock WebUI** (real extension CSP and `nosniff`, XSRF required, and a BigFix Query that never finishes: 1 of 3 computers answers):
  - Evaluate stayed enabled while a BigFix Query polled. A session query run then showed its answer right away, the client section stayed hidden, and the mock logged **no further polls** of the first query (it had polled every 3 seconds).
  - A second BigFix Query run during the first: the first query's polling stopped, the second kept polling, and the page showed the second's results.
  - Backoff: the page asked for results at 0, 1, 3, 7 and 15 s after Evaluate (measured over the first 20 s). With the 60-second cap, a Node check of the loop gives the whole schedule: 0, 1, 3, 7, 15, 31, 63, 123, 183, 243, 303, 363, 423, 483, 543 and 600 s.
  - Not yet installed on the test server: it reaches WebUI-JGStew through the site repo, and then needs **Repair**.

- **2.0.0, local mock WebUI:** the mock uses the real server's CSP and `nosniff` header, and serves the v1.43.0 analyzer set. These passed:
  - The analyzer loaded and was verified. Its `version()` matched, and the editor mounted with the typed text and connected to the language server; completion showed.
  - **Non-blocking:** with the analyzer download held back by 4 seconds, a query run during that time ran as session relevance and said so.
  - **Auto routing:** session, client (BigFix Query results arrived after the mock's 2-second delay), both (ran both), uncertain (mixed dialects, not run), parse error (line and column shown, not run), and undetermined (misspelled inspectors listed, not run).
  - **Mode override:** **Session** ran a statement Auto would not run.
  - **Targets:** filled with the 5 freshest computers before the analyzer was ready. The button fills them in again, and typed IDs are kept and used.
  - **Not exercised:** **Apply fix**, because none of the test statements produced a whole-statement fix.
- **2.0.0, real WebUI (BigFix 11.0.7.61):** installed with **Install extension from file** as an upgrade over 1.1.0. WebUI accepted the roughly 8.3 MB upload. Results:
  - The analyzer loaded and passed verification in about **1 second**. The editor replaced the text box, and completion and hover work.
  - The targets box filled with 5 computer IDs as the page opened. The query that picks them, `(id of it, (now - last report time of it) / second) of bes computers whose (now - last report time of it < 1 * hour)`, returns `(computer id, integer seconds)` pairs.
  - **Auto with a client statement** (`name of operating system`): dialect `client`, BigFix Query only. **5 of 5** computers answered in about 3 seconds, with no failures (Ubuntu, Windows Server, macOS, Windows 11).
  - **Auto with a session statement** (`number of bes computers`): dialect `session`, session relevance only, 1 result in about 320 ms.
  - **Auto with a statement valid as both** ran BigFix Query and session relevance together. BigFix Query returned 5 of 5.
- **1.1.0, real WebUI (passed):** installed as an upgrade over the React 1.0.0 and launched. Results:
  - `./HOMEPAGE/` was rewritten and the page loaded.
  - The computers tuple query returned 142 rows in about 340 ms.
  - A request without the XSRF header got 403.
  - A relevance error showed the server's message.
