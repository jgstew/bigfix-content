// Web Reports Renderer - reports stored in BigFix sites, the way Web Reports lists them
// (Web Reports opens them as ?page=CustomReport&ReportPath=<file>&ReportSiteID=<site>).
//
//   1. Session relevance lists the sites that have site files, with each site's REST path and version.
//   2. The REST API lists a site's files (GET /api/site/<type>/<name>/files through the SDK passthrough). Session
//      relevance cannot: a "bes site file" only has an id.
//   3. Sites with at least one report file keep their file list (reports plus the files a report can load). Each
//      report file is downloaded once to read its <Name> and <Type>.
//   4. All of it is cached as JSON in a shared dashboard variable, so pages after the first only list the sites
//      whose version changed. A second shared variable is a best-effort lock for rebuilding (see acquireLock).
// The cached list is shown first, before anything is checked, and replaced as soon as fresher data arrives.
// Listing and downloading need the operator permission "Can use REST API".
'use strict'
;(function () {
  const DASHBOARD = 'WebReportsRenderer.ojo'
  const CACHE_VAR = 'WebReportsRenderer-SiteFileListingCache'
  const LOCK_VAR = 'WebReportsRenderer-SiteFileListingCache-Lock'
  const SCHEMA = 1
  const LOCK_MS = 120000 // a rebuild holding the lock longer than this is assumed dead
  const LOCK_SETTLE_MS = 1500 // wait before reading the lock back, so a racing writer's value shows
  const SITE_CONCURRENCY = 4
  const REPORT_CONCURRENCY = 4
  const REPORT_RE = /\.(beswrpt|besrpt|btrpt|webreport)$/i
  // files a report can load by relative name; images are kept for sources that can provide bytes
  const LOADABLE_RE = /\.(js|json|css|html?|txt|xml|svg|png|gif|jpe?g|bmp|ico)$/i

  // The site query, plus each site's version. The master action site and custom sites have no version in session
  // relevance (11.0.7: "Singular expression refers to nonexistent object"), so it is 0 there and listSites() reads it
  // from the REST API instead. Each name part of the path is %-encoded once ("%2520" in a relevance string is
  // "%20"), which is what the REST API expects; companions.js encodes it once more for the WebUI passthrough.
  const SITES_QUERY =
    '(name of it, (if exists version of it then version of it else 0), "/api/site/" & (if (master site flag of it) then "master" else ((if (external site flag of it) then "external" else if (custom site flag of it) then "custom" else if (operator site flag of it) then "operator" else "<unknown>") & "/" & (concatenation "%2526" of substrings separated by "&" of concatenation "%253F" of substrings separated by "?" of concatenation "%2523" of substrings separated by "#" of concatenation "%2520" of substrings separated by " " of concatenation "%252F" of substrings separated by "/" of concatenation "%2525" of substrings separated by "%25" of name of it))) & "/files") of all bes sites whose (exists site files of it)'

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const parseJson = (text) => {
    try {
      return JSON.parse(text)
    } catch (e) {
      return null
    }
  }

  function xsrfToken() {
    const match = document.cookie.split('; ').find((c) => c.startsWith('XSRF-TOKEN='))
    return match ? decodeURIComponent(match.slice('XSRF-TOKEN='.length)) : ''
  }

  async function request(method, url, body) {
    const response = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: Object.assign({ Accept: 'application/json', 'X-XSRF-TOKEN': xsrfToken() }, body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      body: body !== undefined ? JSON.stringify(body) : undefined
    })
    const text = await response.text()
    const json = parseJson(text)
    return { ok: response.ok, status: response.status, text, json, message: (json && json.message) || text || 'HTTP ' + response.status }
  }

  async function mapLimit(items, limit, fn) {
    const results = new Array(items.length)
    let next = 0
    const worker = async () => {
      while (next < items.length) {
        const i = next++
        results[i] = await fn(items[i], i)
      }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
    return results
  }

  // ---- shared dashboard variables (WebUI SDK) ----------------------------------------------------------------

  const varUrl = (name) => '/api/sdk/dashboardvariable/' + encodeURIComponent(DASHBOARD) + '/' + encodeURIComponent(name)

  // -> the value string, or null when the variable does not exist (404)
  async function getVar(name) {
    const r = await request('GET', varUrl(name))
    if (r.status === 404) return null
    if (!r.ok) throw new Error('read ' + name + ': ' + r.message)
    return r.json && r.json.value ? String(r.json.value.Value) : null
  }

  // POST stores (creates or replaces) a variable; private: false makes it shared
  async function setVar(name, value) {
    const r = await request('POST', varUrl(name), { value, private: false })
    if (!r.ok) throw new Error('write ' + name + ': ' + r.message)
  }

  // The SDK's DELETE also removes a private variable with the same name; nothing writes private ones with these names.
  async function deleteVar(name) {
    const r = await request('DELETE', varUrl(name))
    if (!r.ok && r.status !== 404) throw new Error('delete ' + name + ': ' + r.message)
  }

  // ---- BigFix data -------------------------------------------------------------------------------------------

  // -> [{ name, version, path }]
  async function listSites() {
    const r = await request('POST', '/api/sdk/sessionrelevance/evaluate', { session_relevance: '(' + SITES_QUERY + ')' })
    if (!r.ok) throw new Error(r.message)
    const rows = (r.json && r.json.value) || []
    const sites = (Array.isArray(rows) ? rows : [rows]).map((row) => ({ name: row[0], version: Number(row[1]), path: row[2] }))
    // the master action site and custom sites have no "version" in session relevance (11.0.7), but the REST API's
    // GET /api/site/<type>/<name>/version has it, so changes to them are noticed too
    await Promise.all(
      sites
        .filter((s) => !s.version)
        .map(async (s) => {
          try {
            const response = await fetch(window.WRRFILES.passthrough(s.path, '/version'), { credentials: 'same-origin', headers: { 'X-XSRF-TOKEN': xsrfToken() } })
            const m = response.ok ? /<SiteVersion\b[^>]*>\s*(\d+)\s*</.exec(await response.text()) : null
            if (m) s.version = Number(m[1])
          } catch (e) {
            // stays 0: this site's changes are only picked up by Rescan sites
          }
        })
    )
    return sites
  }

  // -> [{ name, id, modified, client }]; throws with .status on HTTP errors (403 without REST permission)
  async function listFiles(site) {
    const response = await fetch(window.WRRFILES.passthrough(site.path, '/files'), { credentials: 'same-origin', headers: { 'X-XSRF-TOKEN': xsrfToken() } })
    if (!response.ok) {
      const err = new Error('HTTP ' + response.status)
      err.status = response.status
      throw err
    }
    const doc = new DOMParser().parseFromString(await response.text(), 'application/xml')
    const text = (el, tag) => ((el.getElementsByTagName(tag)[0] || {}).textContent || '').trim()
    return Array.from(doc.getElementsByTagName('SiteFile')).map((f) => ({
      name: text(f, 'Name'),
      id: Number(text(f, 'ID')),
      modified: text(f, 'LastModified'),
      client: text(f, 'IsClientFile') === '1'
    }))
  }

  // A report file's display name and type: <BESWebReport> XML has <Name> and <Type>; raw report HTML
  // (.besrpt / .beswrpt exports) is a custom report named after the file.
  async function reportInfo(site, file) {
    const text = await window.WRRFILES.getSiteFile(site.path, file.id)
    const head = text.replace(/^﻿/, '').trim()
    if (/<BESWebReport[\s>]/i.test(head.slice(0, 2000))) {
      const xml = new DOMParser().parseFromString(head, 'application/xml')
      const field = (tag) => ((xml.getElementsByTagName(tag)[0] || {}).textContent || '').trim()
      return { name: field('Name') || file.name, type: field('Type') || 'CustomReport' }
    }
    if (/^<\?xml\b/i.test(head)) return { name: file.name, type: 'other' }
    return { name: file.name, type: 'CustomReport' }
  }

  // ---- cache -------------------------------------------------------------------------------------------------

  const emptyCache = () => ({ schema: SCHEMA, writtenAt: null, writtenBy: null, sites: [], checked: {} })
  const majorOf = (v) => String(v || '').split('.')[0]

  // A cache from another schema or another major version of this app is ignored, and rebuilt on this page.
  function validCache(cache, appVersion) {
    return !!cache && cache.schema === SCHEMA && Array.isArray(cache.sites) && cache.writtenBy && majorOf(cache.writtenBy.version) === majorOf(appVersion)
  }

  // ---- lock --------------------------------------------------------------------------------------------------
  // The SDK has no compare-and-swap, so this is best effort: read the lock; if it is free or expired, write our own
  // token, wait, and read it back; only the page whose token is still there rebuilds. If two pages still race, both
  // write a complete cache and the last write wins, so the lock only saves duplicate work.

  async function acquireLock(appVersion, user) {
    const held = parseJson(await getVar(LOCK_VAR))
    if (held && Date.parse(held.expires) > Date.now()) return { ok: false, holder: held }
    const mine = {
      owner: (crypto.randomUUID && crypto.randomUUID()) || String(Math.random()).slice(2),
      user: user || '',
      app: 'web-reports-renderer',
      version: appVersion,
      started: new Date().toISOString(),
      expires: new Date(Date.now() + LOCK_MS).toISOString()
    }
    await setVar(LOCK_VAR, JSON.stringify(mine))
    await sleep(LOCK_SETTLE_MS)
    const back = parseJson(await getVar(LOCK_VAR))
    return back && back.owner === mine.owner ? { ok: true, lock: mine } : { ok: false, holder: back }
  }

  async function releaseLock(lock) {
    const held = parseJson(await getVar(LOCK_VAR))
    if (held && held.owner === lock.owner) await deleteVar(LOCK_VAR)
  }

  // ---- the list the page shows -------------------------------------------------------------------------------

  let running = null

  // Starts loading. opts: { version, log(level, msg), onList(sites, info), force }
  //   onList is called with [{ name, path, version, reports: [{id, file, name, type, modified}], files: {name: id} }]
  //   (only sites this operator can see, once that is known) and info { source, writtenAt, busy, message }.
  // Calls made while a load is running return that load.
  function start(opts) {
    if (!running) running = load(opts).finally(() => (running = null))
    return running
  }

  async function load({ version, log, onList, force }) {
    const started = performance.now()
    let visible = null // Set of site names from this operator's own site query
    let cache = emptyCache()
    const publish = (source, extra) => {
      const sites = cache.sites.filter((s) => !visible || visible.has(s.name)).sort((a, b) => a.name.localeCompare(b.name))
      onList(sites, Object.assign({ source, writtenAt: cache.writtenAt, busy: false }, extra))
    }

    // 1. start everything that does not depend on anything else, and show the cache the moment it arrives
    const sitesPromise = listSites()
    const mePromise = fetch('/me', { credentials: 'same-origin' })
      .then((r) => r.json())
      .catch(() => ({}))
    let fromCache = false
    try {
      const stored = parseJson(await getVar(CACHE_VAR))
      if (validCache(stored, version)) {
        cache = stored
        fromCache = true
        log('SITES', 'cache from ' + stored.writtenAt + ' (renderer ' + stored.writtenBy.version + '): ' + stored.sites.length + ' sites with reports, ' + (performance.now() - started).toFixed(0) + 'ms')
        publish('cache', { busy: true, message: 'Checking for changes...' })
      } else if (stored) log('SITES', 'cache ignored: written by another schema or major version (' + JSON.stringify(stored.writtenBy || null) + ')')
      else log('SITES', 'no cache yet')
    } catch (err) {
      log('WARN', 'site cache unreadable (' + err.message + '); listing sites instead')
    }
    if (!fromCache) onList([], { source: 'none', writtenAt: null, busy: true, message: 'Listing sites...' })

    // 2. this operator's sites and their versions
    let live
    try {
      live = await sitesPromise
    } catch (err) {
      log('WARN', 'site query failed: ' + err.message)
      publish(fromCache ? 'cache' : 'none', { message: 'The site list could not be read: ' + err.message })
      return
    }
    visible = new Set(live.map((s) => s.name))
    const known = new Map(cache.sites.map((s) => [s.name, s]))
    const changed = live.filter((s) => force || (known.has(s.name) ? known.get(s.name).version !== s.version : cache.checked[s.name] !== s.version))
    log('SITES', live.length + ' sites have files; ' + changed.length + (force ? ' to list (rescan)' : ' new or changed since the cache'))
    if (!changed.length) {
      publish('cache', { message: '' })
      return
    }
    publish(fromCache ? 'cache' : 'none', { busy: true, message: 'Updating ' + changed.length + ' site' + (changed.length === 1 ? '' : 's') + '...' })

    // 3. the lock; without permission to write shared variables, list anyway and keep the result on this page only
    const me = await mePromise
    const isMaster = !!(me.userPermission && String(me.userPermission.IsMaster) === '1')
    let lock = null
    let canWrite = true
    try {
      const got = await acquireLock(version, me.userName)
      if (!got.ok) {
        const h = got.holder || {}
        log('SITES', 'another page is updating the cache (' + (h.user || 'unknown user') + ', renderer ' + (h.version || '?') + ', since ' + (h.started || '?') + '); showing the cached list')
        publish(fromCache ? 'cache' : 'none', { message: 'Another page is updating the site list; this shows the cached one. Rescan later to refresh.' })
        return
      }
      lock = got.lock
    } catch (err) {
      canWrite = false
      log('WARN', 'cannot use the shared cache lock (' + err.message + '); listing sites for this page only')
    }

    // 4. list each changed site; the shown list is updated after every site
    const next = JSON.parse(JSON.stringify(cache))
    const bySite = new Map(next.sites.map((s) => [s.name, s]))
    let restDenied = false
    let reportDownloads = 0
    try {
      await mapLimit(changed, SITE_CONCURRENCY, async (site) => {
        if (restDenied) return
        let files
        try {
          files = await listFiles(site)
        } catch (err) {
          if (err.status === 403 || err.status === 401) restDenied = true
          log('WARN', 'could not list files of "' + site.name + '": ' + err.message)
          return
        }
        const reports = files.filter((f) => !f.client && REPORT_RE.test(f.name))
        if (!reports.length) {
          bySite.delete(site.name)
          next.checked[site.name] = site.version
          return
        }
        // reuse name and type of report files that did not change (same id and modification time)
        const before = new Map(((known.get(site.name) || {}).reports || []).map((r) => [r.id + '|' + r.modified, r]))
        const entries = await mapLimit(reports, REPORT_CONCURRENCY, async (f) => {
          const old = before.get(f.id + '|' + f.modified)
          if (old) return old
          reportDownloads++
          try {
            const info = await reportInfo(site, f)
            return { id: f.id, file: f.name, name: info.name, type: info.type, modified: f.modified }
          } catch (err) {
            log('WARN', 'could not read report "' + f.name + '" in "' + site.name + '": ' + err.message)
            return { id: f.id, file: f.name, name: f.name, type: 'unknown', modified: f.modified }
          }
        })
        const loadable = {}
        files.filter((f) => !f.client && LOADABLE_RE.test(f.name) && !REPORT_RE.test(f.name)).forEach((f) => (loadable[f.name] = f.id))
        bySite.set(site.name, { name: site.name, path: site.path, version: site.version, reports: entries, files: loadable })
        delete next.checked[site.name]
        next.sites = Array.from(bySite.values())
        cache = next
        publish('scan', { busy: true, message: 'Updating sites...' })
      })
      if (restDenied) {
        log('WARN', 'listing site files was refused: it needs the "Can use REST API" permission')
        publish(fromCache ? 'cache' : 'none', { message: 'Listing site files needs the "Can use REST API" permission.' })
        return
      }
      // a master operator sees every site, so sites missing from its list were removed; other operators keep them
      if (isMaster) {
        Array.from(bySite.keys()).forEach((name) => visible.has(name) || bySite.delete(name))
        Object.keys(next.checked).forEach((name) => visible.has(name) || delete next.checked[name])
      }
      next.sites = Array.from(bySite.values()).sort((a, b) => a.name.localeCompare(b.name))
      next.writtenAt = new Date().toISOString()
      next.writtenBy = { app: 'web-reports-renderer', version }
      cache = next
      const ms = Math.round(performance.now() - started)
      log('SITES', 'listed ' + changed.length + ' sites, read ' + reportDownloads + ' report files, in ' + ms + 'ms: ' + next.sites.length + ' sites with reports')
      publish('scan', { message: '' })

      // 5. save it for the next page
      if (canWrite) {
        const json = JSON.stringify(next)
        try {
          await setVar(CACHE_VAR, json)
          log('SITES', 'cache saved to shared variable "' + CACHE_VAR + '" of "' + DASHBOARD + '" (' + json.length.toLocaleString() + ' characters)')
        } catch (err) {
          log('WARN', 'cache not saved (' + json.length.toLocaleString() + ' characters): ' + err.message)
        }
      }
    } finally {
      if (lock) {
        try {
          await releaseLock(lock)
        } catch (err) {
          log('WARN', 'cache lock not released (' + err.message + '); it expires by itself after ' + LOCK_MS / 1000 + 's')
        }
      }
    }
  }

  window.WRRSITES = { start, DASHBOARD, CACHE_VAR, LOCK_VAR, SITES_QUERY }
})()
