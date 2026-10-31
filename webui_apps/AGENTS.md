# AGENTS.md - working on WebUI apps in this folder

Facts about WebUI, the SDK APIs, packaging and each app live in [README.md](README.md) and each app's README. This file covers **how to work** here: conventions, testing workflow, and traps hit while building these apps. Read the READMEs first; don't copy their content into code comments or new docs.

## Rules for this folder

- **Public repo.** Never commit: server hostnames or IPs, real computer/site/action IDs, user names, internal wiki links or page names, HCL-licensed code (`bfcore-react`, Patronus, the SDK template's files), or built `.webui` files that bundle HCL code. `output/`, `src/static/analyzer/` and `src/static/libs/` are git-ignored; keep it that way.
- **Third-party binaries** are downloaded by a pinned, hash-verified fetch script (`fetch_analyzer.py`, `fetch_libs.py` + committed `libs.lock.json`), never committed.
- **Plain HTML/JS apps** follow the same shape: `package.json`, `src/index.html` with `./HOMEPAGE/` paths, `src/static/{js,css}/`, a copied `pack.py`, `.gitignore`. Copy an existing app rather than inventing a new layout.
- **Version bumps:** change `version` in `package.json` and any `VERSION` constant in JS together, or WebUI and the in-app log disagree.
- **Mark what is confirmed.** Docs say whether a fact was seen on a live server, in code, or only assumed. Record new findings in the relevant README, with the BigFix version.
- **Send session relevance through `shared/webui-relevance.js`** (`WebUIRelevance.prepare('sdk' | 'rest', expr)`): it wraps as `(expr)` and escapes `%` when Web Reports is answering instead of BES Explorer. Plain HTML/JS apps load it first (their `pack.py` copies it in); see "Where WebUI's session relevance comes from" in README.md.

## Testing workflow

1. **Syntax:** `node --check` every JS file (no build step to catch errors).
2. **Unit-ish checks:** small pure helpers (escaping, parsing, result shaping) can be exercised with `node -e` after stubbing `window`/`document`.
3. **Mock WebUI:** a throwaway Python `http.server` in the session scratchpad (not in the repo) that serves `src/` at `/app/`, rewrites `./HOMEPAGE/` to `/app/`, sends the real extension CSP and `X-Content-Type-Options: nosniff`, sets an `XSRF-TOKEN` cookie and requires the header, and fakes only the endpoints under test. Run it through `.claude/launch.json` + the preview tools, and **delete `launch.json` afterwards**. Use mocks for mechanics (loading, CSP, shims, UI); never trust them for relevance results.
4. **Real server:** only with the user's go-ahead. Install with **Install extension from file**, then drive the page from the browser.

## Browser-automation traps

- **The tool hides output** that looks like cookies, query strings or base64 (`[BLOCKED: …]`). Strip `?`, `=`, `&` from returned strings, split `/` with spaces, or return counts instead of raw text.
- **Install form:** attach the `.webui` file **before** picking the site; picking the site first sometimes clears after upload. Re-check with a screenshot before clicking Install, then confirm **Confirm upgrade extension**. Don't use the row's **Update** action (it crashes).
- **Feeding files into a page:** `DataTransfer` + `input.files = dt.files` + dispatch `change`. Get file text into the call by printing it as JSON with Python first.
- **Wait correctly:** clear any status text before triggering a new render, or a stale "Rendered…" ends the wait early.
- **Hidden preview panes don't fire `requestAnimationFrame`**, so libraries that render on it (Font Awesome 5, some charts) look broken there but work in a visible tab.
- **Don't navigate the user's tab** if they're using it; open your own tab and close it when done. Never enter passwords; if WebUI or Web Reports shows a login page, ask the user to log in.
- **Capture instead of opening:** to test links that call `window.open`, override it on the iframe window and record the URLs.

## Investigating WebUI or Web Reports behavior

- Prefer **read-only** probes: `GET`s, session relevance, reading function source (`String(fn)`), and `performance.getEntriesByType('resource')` to see which internal APIs a WebUI page calls. Typing into a WebUI search box is a fine way to learn a request format.
- Anything that changes BigFix (actions, analyses, sites, content, uploads, dashboard variables, BigFix Queries) needs the user's approval; use throwaway names/IDs and clean up afterwards.
- The server's own spec is at `GET /api/openapi.json`; the SDK API Tester's **Copy report** is the quickest whole-API health check.
