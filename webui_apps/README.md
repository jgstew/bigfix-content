# BigFix WebUI custom apps (UI extensions)

Notes on building custom apps for the BigFix WebUI with the WebUI SDK. HCL calls these "UI extensions" or "WebUI custom apps". These notes collect what we know so far. Each item says whether it was **confirmed** (seen in code, a build, or the HCL docs) or is **planned** (listed as planned but not yet seen working).

Example in this folder: [session-relevance-query](session-relevance-query/). It is a session relevance query tool that builds into a `.webui` file.

## What a custom app is

- It is front-end only: HTML, JS, CSS, and fonts. **No back-end code is ever installed on the WebUI server.**
- It is built with React from HCL's WebUI SDK app template. It uses the `bfcore-react` WebUI components and the HCL Patronus design system.
- It is packaged as a `<name>-<version>.webui` zip and installed into a **custom site** (or delivered from an **external site**). Access to the app follows access to that site.
- It talks to BigFix only through WebUI SDK REST APIs (`/api/sdk/...`). These run as the logged-in WebUI operator, so the normal BigFix permissions apply.
- It cannot read the BFEnterprise database directly. Data comes from **session relevance**, which needs **BigFix Web Reports**.

## Prerequisites

| Item | Notes |
| --- | --- |
| BigFix WebUI | The HCL docs describe this in **11.0** (Extensions Management). I couldn't confirm it exists in 10.x. |
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
- Leave `"homepage": "./HOMEPAGE"` alone. Every asset path in the built `index.html` becomes `./HOMEPAGE/...`, and the WebUI server is assumed to rewrite that on install. That part is not confirmed.

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

### SDK endpoints

The SDK endpoints only need **Can use WebUI**. The platform REST pass-through needs **Can use REST API** as well.

| Purpose | Endpoint | Source |
| --- | --- | --- |
| Evaluate session relevance | `POST /api/sdk/sessionrelevance/evaluate` with body `{"session_relevance": "..."}` | template sample (confirmed) |
| Stop actions | `POST /api/sdk/actions/stop` with body `{"ids": [<int>, ...]}` | template sample |
| Activate / deactivate analyses | `POST /api/sdk/analyses/activate`, `.../deactivate` with body `{"analyses": ...}` of `{siteID, analysisID}` objects | template sample (copy the exact shape from the sample) |
| Create custom site | `POST /api/sdk/site/custom` with body `{"siteName": "..."}` | template sample |
| Upload a file to a custom site | `POST /api/sdk/site/custom/{siteName}/file` (multipart, field `file`) | template sample |
| Import BES XML into a custom site | `POST /api/sdk/site/custom/{siteName}/import` (`application/xml`) | template sample |
| Open Take Action dialog, prefilled | `useBfTakeFixletAction()` from `bfcore-react`, which provides `TakeFixletAction`, `TakeSecureFixletAction`, `TakeFixletActionOnComputers`, and `TakeSecureFixletActionOnComputers` | template sample / README |
| Platform REST pass-through | `GET/POST/PUT/DELETE /api/sdk/passthrough/{resource}`, which forwards to `<bfserver>:52315/api/{resource}` | planned (unverified) |
| Dashboard variables | `GET/POST/PUT/DELETE /api/sdk/dashboardvariable/{dashboardID}/{name}` | planned (unverified) |
| Operator-site import / file | `POST /api/sdk/site/operator/import`, `POST /api/sdk/site/operator/file` | planned (unverified) |
| Mailbox file | `POST /api/sdk/mailbox/{computerid}` | planned (unverified) |
| Edit content | `PUT /api/sdk/{fixlet,task,analysis,baseline,computergroup}/{siteType}/{siteName}/{id}` | planned (unverified) |
| Delete content in bulk | `DELETE /api/sdk/{fixlets,tasks,analyses,baselines,computergroups}`, body `[{"siteType","siteName","id"}]` | planned (unverified) |

The "planned" rows come from a list of intended APIs, not a spec, and may differ in the shipped product. For example, the planned stop-action path doesn't match the one the template uses. Check them against the live API docs before relying on them.

**Live API docs:** set the WebUI server setting `_WebUIAppEnv_ENABLE_API_DOC_SETTING=1` and restart WebUI. The docs (OpenAPI 3) are then served at `https://<webui-server>/api/api-docs`.

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
2. Click **Install app from file**, pick a custom site, upload the `.webui` file, and confirm.
3. Click **Launch** on the installed row.

Update: bump `version`, run `npm run packit`, then use **Update an extension** in Extensions Management. In a dev loop, `npm run update -- -u=<user> -p=<password> -s=<server:port> [-f]` pushes the build over an existing custom-site install. It uses the undocumented `/ui_extensions/updateextensioncustomsite` endpoint and puts the password on the command line, so use it only on dev machines.

Repair: after a WebUI reinstall or a DR restore, **Repair an extension** reinstalls it from what is stored in the site.

## Delivery without uploading

- **External site** (documented): HCL can publish the `.webui` file in an external site. Operators then install it from Extensions Management without uploading anything, but they still have to click Install. External sites need an HCL-signed masthead.
- **Custom site:** I found nothing documented for installing from a file that is already in the site. Choosing an already-added site file to update an app (based on the file's LastModified date) is planned but not confirmed in the shipped product.
- **Automatic install** when a file shows up in a site: not documented anywhere I found.

## Open questions

- Does WebUI 10.x support Extensions Management, and which minimum 11.0 patch level is needed?
- How exactly does the server rewrite `./HOMEPAGE/`? Can a hand-written (non-React) `index.html` packaged the same way work?
- What does the WebUI server's Content-Security-Policy (Helmet) allow? For example, inline scripts, or external origins for iframe content.
- Is there a newer `bfcore-react` than 6.0.65?
- Is the response shape of `/api/sdk/sessionrelevance/evaluate` (`{value: [...]}` vs a bare array) and its typed values documented in `/api/api-docs`?

## References

- HCL docs: [Get Started with Extensions Management (11.0)](https://help.hcl-software.com/bigfix/11.0/mcm/WebUI/Users_Guide/c_get_started_with_extension.html), [WebUI server settings](https://help.hcl-software.com/bigfix/11.0/mcm/WebUI/Admin_Guide/c_server_settings_definitions.html), [Accessing WebUI server settings](https://help.hcl-software.com/bigfix/11.0/mcm/WebUI/Admin_Guide/c_access_webui_server_settings.html)
- [Session relevance guide](https://developer.bigfix.com/relevance/guide/session/), [BigFix REST API](https://developer.bigfix.com/rest-api/api/)
