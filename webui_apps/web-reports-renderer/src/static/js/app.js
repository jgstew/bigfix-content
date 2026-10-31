// Web Reports Renderer: renders a BigFix Web Reports custom report inside WebUI.
//   1. read a report: uploaded, or chosen from a BigFix site (sites.js); raw report HTML (.besrpt / .beswrpt) or
//      <BESWebReport> XML (.webreport). A site report's relative scripts and stylesheets come from the same site
//      (companions.js), the way Web Reports' <base href> to the site's folder loads them.
//   2. replace every <?Relevance ?> with its session relevance result, the way Web Reports does on the server:
//      the result is coerced to html (strings HTML-escaped, html values not) and plural results are joined
//      with "<br />" (both confirmed against Web Reports 11.0.7)
//   3. render it in a same-origin iframe, inside <div id="wr_datapage"> like Web Reports, with shim.js loaded
//      first so the report's own EvaluateRelevance() / Relevance() / AsyncEvaluateString() calls work
// All relevance runs through the WebUI SDK: POST /api/sdk/sessionrelevance/evaluate.
'use strict'
;(function () {
  const VERSION = '1.5.3'
  const KEEPALIVE_MS = 30000
  const PI_CONCURRENCY = 4
  const MAX_LOG_LINES = 5000

  const $ = (id) => document.getElementById(id)
  const lines = []
  const sensitive = new Set([location.host, location.hostname])

  // ---- log (same pattern as sdk-api-tester) ---------------------------------------------------

  const pad = (n, w) => String(n).padStart(w, '0')
  function log(level, msg) {
    const d = new Date()
    const line = pad(d.getHours(), 2) + ':' + pad(d.getMinutes(), 2) + ':' + pad(d.getSeconds(), 2) + '.' + pad(d.getMilliseconds(), 3) + ' [' + level + '] ' + msg
    lines.push(line)
    if (lines.length > MAX_LOG_LINES) lines.shift()
    const area = $('log-text')
    area.value += line + '\n'
    area.scrollTop = area.scrollHeight
    $('log-count').textContent = String(lines.length)
  }
  // "current wizard" is rewritten to a dashboard id, so its dashboard variables have a namespace. Each report gets
  // its own: WebReportsRenderer-<report name without spaces>.ojo, which never touches the variables the console or
  // Web Reports keep for the same report. DASHBOARD_IDS maps a report name to another id, for a report known to be
  // safe and worth sharing variables with (for example its console dashboard); it is empty until one is.
  const DASHBOARD_IDS = {}
  const dashboardIdFor = (reportName) => DASHBOARD_IDS[reportName] || 'WebReportsRenderer-' + String(reportName).replace(/\s+/g, '') + '.ojo'
  let currentDashboardId = ''
  const dashboardId = () => currentDashboardId

  // shim.js inside the iframe logs through this; relevance.js (here and in the iframe) reads the options
  // The report's alert() calls (shim.js replaces alert in the iframe) land here instead of in a blocking dialog: a Log
  // line, and a list under the report title. Repeats of the last message are counted rather than listed again.
  const MAX_ALERTS = 20
  function reportAlert(message) {
    const text = String(message)
    log('ALERT', text)
    const list = $('wrr-alerts')
    const last = list.lastElementChild
    if (last && last.dataset.text === text) {
      last.dataset.count = String(Number(last.dataset.count) + 1)
      last.textContent = text + ' (x' + last.dataset.count + ')'
    } else if (list.children.length < MAX_ALERTS) {
      const item = document.createElement('li')
      item.dataset.text = text
      item.dataset.count = '1'
      item.textContent = text
      list.appendChild(item)
    }
    list.hidden = false
  }
  function clearAlerts() {
    $('wrr-alerts').textContent = ''
    $('wrr-alerts').hidden = true
  }

  window.WRR = {
    log,
    alert: reportAlert,
    get options() {
      return { webReportsContext: $('opt-wrcontext').checked, dashboardId: dashboardId() }
    }
  }

  function redact(text) {
    if (!$('log-redact').checked) return text
    Array.from(sensitive)
      .filter((s) => s && s.length > 1)
      .sort((a, b) => b.length - a.length)
      .forEach((s, i) => (text = text.split(s).join('<REDACTED_' + (i + 1) + '>')))
    return text.replace(/(https?:\/\/)([^/:\s"'<>]+)(:\d+)/gi, '$1<SERVER>$3')
  }

  async function copy(text, label) {
    try {
      await navigator.clipboard.writeText(text)
      log('INFO', label + ' copied to clipboard (' + text.length + ' chars)')
    } catch (err) {
      log('WARN', 'Clipboard copy failed (' + err + '); the text is selected in the log box, press Ctrl+C / Cmd+C')
      $('log-details').open = true
      $('log-text').value = text
      $('log-text').select()
    }
  }

  let lastReport = null
  function buildReport() {
    const out = ['===== BigFix Web Reports Renderer report =====', 'Renderer version: ' + VERSION, 'Generated: ' + new Date().toString(), 'User agent: ' + navigator.userAgent]
    if (lastReport) {
      out.push('Report: ' + lastReport.name + ' (' + lastReport.format + ', ' + lastReport.bytes + ' bytes)')
      out.push('Relevance instructions: ' + lastReport.piCount + ' (' + lastReport.piErrors + ' failed), rendered in ' + lastReport.ms + 'ms')
    }
    out.push('', '----- Log (' + lines.length + ' lines) -----', lines.join('\n'), '===== end of report =====')
    return redact(out.join('\n'))
  }

  // ---- WebUI requests -------------------------------------------------------------------------

  function xsrfToken() {
    const match = document.cookie.split('; ').find((c) => c.startsWith('XSRF-TOKEN='))
    return match ? decodeURIComponent(match.slice('XSRF-TOKEN='.length)) : ''
  }

  // Resolves to { ok, status, value, message } and never throws, so callers can try a fallback.
  async function evaluate(relevance) {
    try {
      const response = await fetch('/api/sdk/sessionrelevance/evaluate', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-XSRF-TOKEN': xsrfToken() },
        body: JSON.stringify({ session_relevance: window.WRREL.forWebUI('sdk', relevance) })
      })
      const text = await response.text()
      let body = null
      try {
        body = JSON.parse(text)
      } catch (e) {
        // not JSON
      }
      if (response.status === 401 || response.headers.get('iem-login-required')) {
        return { ok: false, status: 401, message: 'WebUI session expired: log in to WebUI again, then render the report again' }
      }
      if (!response.ok) return { ok: false, status: response.status, message: (body && body.message) || text || 'HTTP ' + response.status }
      const value = body && body.value
      return { ok: true, status: 200, value: Array.isArray(value) ? value : [value] }
    } catch (err) {
      return { ok: false, status: 0, message: String(err) }
    }
  }

  function startShell() {
    evaluateMe()
    setInterval(() => fetch('/loggedin', { credentials: 'same-origin' }).catch(() => {}), KEEPALIVE_MS)
  }

  async function evaluateMe() {
    try {
      const me = await (await fetch('/me', { credentials: 'same-origin' })).json()
      if (me && me.userName) {
        sensitive.add(me.userName)
        $('shell-user').textContent = me.userName
      }
    } catch (e) {
      // cosmetic
    }
  }

  // ---- reading a report -----------------------------------------------------------------------

  // Returns { name, format, type, html } or { name, format, type, problem }.
  function parseReport(text, fileName) {
    const trimmed = text.replace(/^﻿/, '').trim()
    if (/<BESWebReport[\s>]/i.test(trimmed.slice(0, 2000))) {
      const xml = new DOMParser().parseFromString(trimmed, 'application/xml')
      if (xml.getElementsByTagName('parsererror').length) return { name: fileName, format: 'BESWebReport XML', type: '?', problem: 'The XML does not parse.' }
      const field = (tag) => {
        const el = xml.getElementsByTagName(tag)[0]
        return el ? el.textContent : ''
      }
      const name = field('Name').trim() || fileName
      const type = field('Type').trim() || 'CustomReport'
      if (type === 'CustomReport') return { name, format: 'BESWebReport XML', type, html: field('Data') }
      if (type === 'ExternalReport') {
        const url = field('Data').trim()
        // only plain web links: a javascript: or data: URL from a file must not be opened
        const externalUrl = /^https?:\/\/[^\s"'<>]+$/i.test(url) ? url : null
        return {
          name,
          format: 'BESWebReport XML',
          type,
          externalUrl,
          problem: 'This is an external report: in Web Reports it shows ' + url + '. WebUI extensions cannot frame other hosts' + (externalUrl ? ', so it can only open in a new tab.' : ', and this URL is not an http(s) link.')
        }
      }
      return { name, format: 'BESWebReport XML', type, problem: 'Only custom reports can be rendered. This is a "' + type + '", which is a saved Web Reports page (' + (field('SourcePage').trim() || 'unknown page') + ') rather than report HTML.' }
    }
    return { name: fileName, format: 'report HTML', type: 'CustomReport', html: text }
  }

  // ---- <?Relevance ?> substitution ------------------------------------------------------------

  const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  const asAnswer = (row) => (Array.isArray(row) ? row.join(', ') : String(row))

  // Web Reports coerces a processing instruction's result to the html type: string results are escaped, html
  // results are not. Preferred: the typed REST query (relevance.js) says the result type exactly, so only html
  // values (or html tuple items) stay unescaped, in one request. Fallback when it is unavailable (no "Can use
  // REST API" permission, HTTP 400): the SDK returns plain strings, so ask the server to do the coercion with
  // "(it as html) of (expr)", which works for string and html results; for other types (numbers, booleans,
  // tuples) that cast fails, so evaluate the expression as written and escape the values here.
  let typedFallbackLogged = false
  async function evaluateInstruction(expr) {
    const relevance = window.WRREL.prepare(expr)
    const typed = await window.WRREL.evaluateTyped(relevance)
    if (typed.ok) return { ok: true, html: window.WRREL.typedToHtml(typed.typed), how: 'typed ' + typed.typed.type, count: typed.typed.result.length }
    if (typed.relevanceError) return { ok: false, message: typed.relevanceError }
    if (!typedFallbackLogged) {
      typedFallbackLogged = true
      log('WARN', 'Typed REST evaluation unavailable (' + typed.unavailable + '); using the SDK API with the "as html" method. Exact types and plurality need "Can use REST API".')
    }
    const coerced = await evaluate('(it as html) of (' + relevance + ')')
    if (coerced.ok) return { ok: true, html: coerced.value.map(asAnswer).join('<br />'), how: 'SDK as html', count: coerced.value.length }
    const raw = await evaluate(relevance)
    if (raw.ok) return { ok: true, html: raw.value.map((v) => escapeHtml(asAnswer(v))).join('<br />'), how: 'SDK escaped', count: raw.value.length }
    return { ok: false, message: raw.message }
  }

  // Runs fn over items with at most `limit` in flight.
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

  const PI_RE = /<\?relevance\b([\s\S]*?)\?>/gi
  const REFRESH_RE = /<\?(Begin|End)RefreshRelevance\b([\s\S]*?)\?>/gi
  const SECTION_RE = /<\?BeginRefreshRelevance\b([\s\S]*?)\?>([\s\S]*?)<\?EndRefreshRelevance\b[\s\S]*?\?>/gi
  const DEFAULT_REFRESH_MS = 60000
  const MIN_REFRESH_MS = 10000

  // "hh:mm:ss" or "d hh:mm:ss" -> milliseconds
  function parseDuration(text) {
    const m = /^\s*(?:(\d+)\s+)?(\d+):(\d+):(\d+)\s*$/.exec(text)
    return m ? (((Number(m[1] || 0) * 24 + Number(m[2])) * 60 + Number(m[3])) * 60 + Number(m[4])) * 1000 : null
  }

  // The console re-evaluates a <?BeginRefreshRelevance?> section when the attributes' change types happen
  // (ManualRefresh="00:01:00", ActionResults="00:01:00", ... each a minimum interval); with no attributes, on every
  // change. Web Reports does not refresh at all. Here a section re-evaluates on a timer: the shortest interval in
  // its attributes, at least MIN_REFRESH_MS, or DEFAULT_REFRESH_MS when it has none.
  function refreshInterval(attrs) {
    const durations = []
    attrs.replace(/(\w+)\s*=\s*"([^"]*)"/g, (m, name, value) => {
      if (name.toLowerCase() !== 'id') {
        const ms = parseDuration(value)
        if (ms !== null) durations.push(ms)
      }
      return m
    })
    return durations.length ? Math.max(MIN_REFRESH_MS, Math.min(...durations)) : DEFAULT_REFRESH_MS
  }

  async function substitute(html, onProgress) {
    // <?BeginRefreshRelevance?> ... <?EndRefreshRelevance?> become the <span id="..."> the console emits (default
    // id __DRRSN). The section's source is kept so render() can re-evaluate it on a timer.
    const sections = []
    html = html.replace(SECTION_RE, (m, attrs, inner) => {
      const id = /id\s*=\s*"([^"]*)"/i.exec(attrs)
      const n = sections.length
      sections.push({ id: id ? id[1] : '__DRRSN', ms: refreshInterval(attrs), template: inner })
      return '<span id="' + escapeHtml(id ? id[1] : '__DRRSN') + '" data-wrr-refresh="' + n + '">' + inner + '</span>'
    })
    // unpaired tags, as before
    html = html.replace(REFRESH_RE, (m, kind, attrs) => {
      if (kind.toLowerCase() === 'end') return '</span>'
      const id = /id\s*=\s*"([^"]*)"/i.exec(attrs)
      return '<span id="' + escapeHtml(id ? id[1] : '__DRRSN') + '">'
    })

    const expressions = []
    html.replace(PI_RE, (m, expr) => {
      expressions.push(expr.trim())
      return m
    })
    const unique = Array.from(new Set(expressions))
    let done = 0
    const answers = await mapLimit(unique, PI_CONCURRENCY, async (expr) => {
      const started = performance.now()
      const result = await evaluateInstruction(expr)
      const ms = Math.round(performance.now() - started)
      const label = expr.length > 120 ? expr.slice(0, 120) + '...' : expr
      if (result.ok) log('PI', 'ok (' + ms + 'ms, ' + result.count + ' results, ' + result.how + ') ' + label)
      else log('PI', 'FAILED (' + ms + 'ms) ' + label + ' -> ' + result.message)
      onProgress(++done, unique.length)
      return result
    })
    const byExpr = new Map(unique.map((e, i) => [e, answers[i]]))

    let errors = 0
    const out = html.replace(PI_RE, (m, expr) => {
      const result = byExpr.get(expr.trim())
      if (result.ok) return result.html
      errors++
      return '<span class="wrr-relevance-error" title="' + escapeHtml(result.message) + '">[relevance error: ' + escapeHtml(result.message) + ']</span>'
    })
    return { html: out, count: expressions.length, unique: unique.length, errors, sections }
  }

  // ---- refresh sections -----------------------------------------------------------------------

  let refreshTimers = []
  function stopRefresh() {
    refreshTimers.forEach((t) => clearInterval(t))
    refreshTimers = []
  }

  // Re-evaluates each section's relevance and replaces the span's contents. Scripts inside a section do not run
  // again (innerHTML), the same as the console's span replacement.
  function startRefresh(sections, frame) {
    stopRefresh()
    if (!sections.length || !$('opt-refresh').checked) return
    sections.forEach((section, n) => {
      log('INFO', 'refresh section "' + section.id + '" every ' + section.ms / 1000 + 's')
      const timer = setInterval(async () => {
        const doc = frame.contentDocument
        const span = doc && doc.querySelector('[data-wrr-refresh="' + n + '"]')
        if (!span) return
        const result = await substitute(section.template, () => {})
        span.innerHTML = rewriteLibraries(result.html).html
        log('INFO', 'refreshed section "' + section.id + '" (' + result.count + ' relevance, ' + result.errors + ' failed)')
      }, section.ms)
      refreshTimers.push(timer)
    })
  }

  // ---- CDN libraries --------------------------------------------------------------------------
  // The report iframe inherits WebUI's CSP (only files from the WebUI server), so a report's cdnjs <script>
  // and <link> tags are rewritten to the local copies fetch_libs.py put in static/libs/. The reports'
  // integrity="sha256-..." attributes still apply, and match, because the copies are byte-identical.

  let libs = null // { files: Set of cdnjs paths, aliases: { url: cdnjs path } }
  let librariesReady = Promise.resolve() // render() waits on this so a report chosen right away gets local copies

  async function loadLibraries() {
    try {
      const response = await fetch(new URL('static/libs/manifest.json', document.baseURI), { cache: 'no-cache', credentials: 'same-origin' })
      if (!response.ok) throw new Error('HTTP ' + response.status)
      const manifest = await response.json()
      libs = { files: new Set(manifest.files), aliases: manifest.aliases || {} }
      log('INFO', libs.files.size + ' local library files available for cdnjs URLs')
    } catch (err) {
      log('WARN', 'No local library copies (' + err.message + '); reports that load jQuery, DataTables, d3 and so on from a CDN will not work. Build with fetch_libs.py.')
    }
  }

  const localLibrary = (path) => new URL('static/libs/cdnjs/' + path, document.baseURI).href

  function rewriteLibraries(html) {
    const rewritten = []
    if (!libs) return { html, rewritten }
    html = html.replace(/(["'(=\s])((?:https?:)?\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/([^"')\s?#]+))/gi, (m, before, url, path) => {
      if (!libs.files.has(path)) return m
      rewritten.push(path)
      return before + localLibrary(path)
    })
    Object.entries(libs.aliases).forEach(([url, path]) => {
      if (libs.files.has(path) && html.includes(url)) {
        rewritten.push(url + ' -> ' + path)
        html = html.split(url).join(localLibrary(path))
      }
    })
    return { html, rewritten }
  }

  // ---- rendering ------------------------------------------------------------------------------

  function buildDocument(reportHtml, title) {
    const helper = new URL('static/js/webui-relevance.js', document.baseURI).href
    const relevance = new URL('static/js/relevance.js', document.baseURI).href
    const shim = new URL('static/js/shim.js', document.baseURI).href
    const css = new URL('static/css/report.css', document.baseURI).href
    // relevance.js and shim.js are plain blocking scripts at the top of <head>, so they run before any of the
    // report's scripts
    return [
      '<!doctype html><html><head><meta charset="utf-8">',
      '<title>' + escapeHtml(title) + '</title>',
      '<script src="' + helper + '"></scr' + 'ipt>',
      '<script src="' + relevance + '"></scr' + 'ipt>',
      '<script src="' + shim + '"></scr' + 'ipt>',
      '<link rel="stylesheet" href="' + css + '">',
      '</head><body><div id="wr_datapage">',
      reportHtml,
      '</div></body></html>'
    ].join('\n')
  }

  function setStatus(text, isError) {
    $('wrr-status').textContent = text
    $('wrr-status').className = 'wrr-status' + (isError ? ' wrr-error-text' : '')
  }

  // The report being shown: { name (file name), from (where it came from, for the log), getText(), source, site }
  // source is a companions.js file source (a site's files) or null for an uploaded report; site is its site name.
  let current = null

  async function render() {
    if (!current) return
    await librariesReady
    const started = performance.now()
    let text
    try {
      setStatus('Loading ' + current.name + '...')
      text = await current.getText()
    } catch (err) {
      setStatus('Could not load ' + current.name + ' from ' + current.from + ': ' + err.message, true)
      log('WARN', 'could not load ' + current.name + ' from ' + current.from + ': ' + err.message)
      return
    }
    const report = parseReport(text, current.name)
    currentDashboardId = dashboardIdFor(report.name)
    log('INFO', '===== Rendering "' + report.name + '" from ' + current.name + ' (' + current.from + ', ' + report.format + ', ' + text.length + ' bytes) =====')
    log('INFO', 'Options: in web reports context = ' + ($('opt-wrcontext').checked ? 'true (rewritten)' : 'as evaluated') + ', dashboard id for current wizard = ' + dashboardId() + ', refresh sections = ' + $('opt-refresh').checked + '; relevance answered by ' + window.WebUIRelevance.sourceName('rest') + ' (REST), ' + window.WebUIRelevance.sourceName('sdk') + ' (SDK)')
    $('wrr-title').textContent = report.name
    clearAlerts()
    $('wrr-frame').hidden = true
    $('wrr-fullscreen').hidden = true
    $('wrr-open-external').hidden = true
    stopRefresh()

    if (report.problem) {
      setStatus(report.problem, true)
      log('WARN', report.problem)
      lastReport = { name: report.name, format: report.format, bytes: text.length, piCount: 0, piErrors: 0, ms: 0 }
      // an external report is just a URL: WebUI cannot frame it, but it can open in a new tab
      if (report.externalUrl) {
        const button = $('wrr-open-external')
        button.textContent = 'Open ' + report.externalUrl + ' in a new tab'
        button.onclick = () => {
          window.open(report.externalUrl, '_blank', 'noopener')
          log('INFO', 'opened external report ' + report.externalUrl)
        }
        button.hidden = false
      }
      return
    }

    setStatus('Evaluating relevance...')
    const result = await substitute(report.html, (n, total) => setStatus('Evaluating relevance: ' + n + ' of ' + total + '...'))
    const ms = Math.round(performance.now() - started)
    lastReport = { name: report.name, format: report.format, bytes: text.length, piCount: result.count, piErrors: result.errors, ms }
    log('INFO', result.count + ' <?Relevance ?> (' + result.unique + ' unique), ' + result.errors + ' failed, in ' + ms + 'ms')

    // after substitution: some reports build their <script src> tags with relevance (GenericDataTables does)
    const libraries = rewriteLibraries(result.html)
    if (libraries.rewritten.length) log('INFO', 'Using local copies for ' + libraries.rewritten.length + ' CDN file(s): ' + libraries.rewritten.join(', '))
    const cdn = Array.from(new Set((libraries.html.match(/(?:src|href)\s*=\s*["']https?:\/\/[^"']+/gi) || []).map((s) => s.replace(/^(?:src|href)\s*=\s*["']/i, ''))))
      .filter((url) => !url.startsWith(location.origin))
    if (cdn.length) log('WARN', cdn.length + ' file(s) from other hosts have no local copy and will be blocked by WebUI: ' + cdn.join(', '))

    // relative scripts, stylesheets, images and fonts: from the report's site, else the newest name match among the
    // renderer's bundled libraries and the other report sites (see companions.js)
    let html = libraries.html
    let companionNote = ''
    const label = current.source ? current.source.label : 'the uploaded report'
    setStatus('Loading files for ' + label + '...')
    const pool = window.WRRFILES.makePool({
      libs: libs ? Array.from(libs.files).map((path) => ({ path, url: localLibrary(path) })) : [],
      sites: siteList
    })
    const files = await window.WRRFILES.resolve(html, current.source, pool, current.site)
    html = files.html
    if (files.inlined.length) log('FILES', 'loaded ' + files.inlined.length + ' script/stylesheet file(s): ' + files.inlined.join(', '))
    files.substituted
      .filter((f) => f.exact)
      .forEach((f) => log('FILES', f.ref + ' is not in ' + label + '; using the same file name from ' + f.from))
    files.substituted
      .filter((f) => !f.exact)
      .forEach((f) => log('WARN', f.ref + ' is not usable from ' + label + '; using ' + f.name + ' from ' + f.from + ' instead (the newest name match, not the same file)'))
    if (files.binary.length) log('FILES', files.binary.length + ' image(s) or font(s) in ' + label + ' cannot load (the WebUI passthrough corrupts binary files) and have no name match: ' + files.binary.join(', '))
    if (files.missing.length) log('FILES', files.missing.length + ' relative file(s) not found anywhere: ' + files.missing.join(', '))
    const loaded = files.inlined.length + files.images.length
    const notLoaded = files.binary.length + files.missing.length
    const similar = files.substituted.filter((f) => !f.exact).length
    if (loaded || notLoaded) companionNote = ' ' + loaded + ' file(s) loaded' + (similar ? ' (' + similar + ' by a similar name)' : '') + (notLoaded ? ', ' + notLoaded + ' not' : '') + ' (see the log).'

    const frame = $('wrr-frame')
    frame.srcdoc = buildDocument(html, report.name)
    frame.hidden = false
    $('wrr-fullscreen').hidden = false
    startRefresh(result.sections, frame)
    setStatus(
      'Rendered ' + result.count + ' relevance instruction' + (result.count === 1 ? '' : 's') + ' in ' + (ms / 1000).toFixed(1) + 's' +
        (result.errors ? ', ' + result.errors + ' failed (see the log)' : '') +
        (cdn.length ? '. ' + cdn.length + ' external file(s) blocked (see the log).' : '.') +
        companionNote,
      result.errors > 0
    )
  }

  // Some reports restyle the page around them through window.parent, the way they would Web Reports' page:
  // index.html has hidden stand-ins for Web Reports' element ids (wr_header, wr_mainpage, ...), and a style set on
  // this page's <html> or <body> (for example overflow: hidden, which stops it scrolling) is undone.
  function keepStyle(el) {
    const original = el.getAttribute('style')
    new MutationObserver(() => {
      const now = el.getAttribute('style')
      if (now === original) return
      log('INFO', 'the report set style="' + (now || '').slice(0, 120) + '" on this page\'s <' + el.tagName.toLowerCase() + '>; undone')
      if (original === null) el.removeAttribute('style')
      else el.setAttribute('style', original)
    }).observe(el, { attributes: true, attributeFilter: ['style'] })
  }
  keepStyle(document.documentElement)
  keepStyle(document.body)

  function chooseFile(file) {
    if (!file) return
    current = { name: file.name, from: 'uploaded file', getText: () => file.text(), source: null, site: null }
    $('wrr-site-report').value = ''
    $('wrr-file-name').textContent = 'from ' + file.name + ' (' + file.size.toLocaleString() + ' bytes)'
    $('wrr-rerender').disabled = false
    render()
  }

  // ---- reports from sites ---------------------------------------------------------------------

  let siteList = [] // what sites.js last reported
  let siteInfo = { busy: true }
  const reportKey = (site, report) => site.name + '\n' + report.id

  // Fills the drop-down, keeping the selection when the list is replaced (cache first, then fresher data).
  function showSiteReports(sites, info) {
    siteList = sites
    siteInfo = info
    const select = $('wrr-site-report')
    const selected = select.value
    const templates = $('opt-templates').checked
    let shown = 0
    let hidden = 0
    select.textContent = ''
    const first = document.createElement('option')
    first.value = ''
    select.appendChild(first)
    sites.forEach((site) => {
      const reports = site.reports.filter((r) => {
        const show = templates || r.type === 'CustomReport'
        if (!show) hidden++
        return show
      })
      if (!reports.length) return
      const group = document.createElement('optgroup')
      group.label = site.name
      reports
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name))
        .forEach((r) => {
          const option = document.createElement('option')
          option.value = reportKey(site, r)
          option.textContent = r.name + (r.type === 'CustomReport' ? '' : ' (' + r.type + ')')
          option.title = r.file
          group.appendChild(option)
          shown++
        })
      select.appendChild(group)
    })
    first.textContent = shown ? 'Choose one of ' + shown + ' report' + (shown === 1 ? '' : 's') + '...' : info.busy ? 'Loading the site list...' : 'No reports found in sites'
    if (selected && Array.from(select.options).some((o) => o.value === selected)) select.value = selected
    select.disabled = !shown
    const parts = []
    if (info.message) parts.push(info.message)
    else if (info.writtenAt) parts.push('Site list from ' + new Date(info.writtenAt).toLocaleString() + '.')
    if (hidden) parts.push(hidden + ' template report' + (hidden === 1 ? '' : 's') + ' hidden.')
    $('wrr-site-status').textContent = parts.join(' ')
    $('wrr-rescan').disabled = !!info.busy
  }

  function chooseSiteReport(key) {
    if (!key) return
    for (const site of siteList) {
      const report = site.reports.find((r) => reportKey(site, r) === key)
      if (!report) continue
      current = {
        name: report.file,
        from: 'site "' + site.name + '"',
        getText: () => window.WRRFILES.getSiteFile(site.path, report.id),
        source: window.WRRFILES.fromSite(site),
        site: site.name
      }
      $('wrr-file').value = ''
      $('wrr-file-name').textContent = 'from site ' + site.name
      $('wrr-rerender').disabled = false
      render()
      return
    }
  }

  const loadSites = (force) => window.WRRSITES.start({ version: VERSION, log, onList: showSiteReports, force }).catch((err) => log('WARN', 'site list failed: ' + err.message))

  // ---- wiring ---------------------------------------------------------------------------------

  $('wrr-file').addEventListener('change', (e) => chooseFile(e.target.files[0]))
  $('wrr-rerender').addEventListener('click', () => render())
  $('wrr-site-report').addEventListener('change', (e) => chooseSiteReport(e.target.value))
  $('wrr-rescan').addEventListener('click', () => loadSites(true))
  $('opt-templates').addEventListener('change', () => showSiteReports(siteList, siteInfo))
  // a report file can be dropped anywhere on the page (outside the report itself, which is its own document)
  const drop = $('wrr-main')
  drop.addEventListener('dragover', (e) => {
    if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes('Files')) return
    e.preventDefault()
    drop.classList.add('wrr-drop-over')
  })
  drop.addEventListener('dragleave', (e) => {
    if (!e.relatedTarget || !drop.contains(e.relatedTarget)) drop.classList.remove('wrr-drop-over')
  })
  drop.addEventListener('drop', (e) => {
    if (!e.dataTransfer || !e.dataTransfer.files.length) return
    e.preventDefault()
    drop.classList.remove('wrr-drop-over')
    chooseFile(e.dataTransfer.files[0])
  })

  // Full screen: the browser's Fullscreen API on the report's stage (Esc leaves). If the browser refuses, for example
  // because WebUI's page does not allow fullscreen, the stage covers the window instead, until Exit or Esc.
  const stage = $('wrr-stage')
  const isFull = () => document.fullscreenElement === stage || stage.classList.contains('wrr-maximized')
  async function enterFullScreen() {
    try {
      await stage.requestFullscreen()
      log('INFO', 'report shown full screen (Esc leaves)')
    } catch (err) {
      stage.classList.add('wrr-maximized')
      log('INFO', 'the browser refused full screen (' + err.message + '); the report covers the window instead (Exit or Esc leaves)')
    }
    $('wrr-exit-fullscreen').focus()
  }
  function exitFullScreen() {
    if (document.fullscreenElement === stage) document.exitFullscreen().catch(() => {})
    stage.classList.remove('wrr-maximized')
  }
  $('wrr-fullscreen').addEventListener('click', () => (isFull() ? exitFullScreen() : enterFullScreen()))
  $('wrr-exit-fullscreen').addEventListener('click', exitFullScreen)
  // Esc for the covering fallback; the real full screen handles Esc itself. Keys pressed inside the report go to its
  // own document, so the frame's document is listened to as well, after each render.
  const onKey = (e) => e.key === 'Escape' && stage.classList.contains('wrr-maximized') && exitFullScreen()
  document.addEventListener('keydown', onKey)
  $('wrr-frame').addEventListener('load', () => {
    try {
      $('wrr-frame').contentDocument.addEventListener('keydown', onKey)
    } catch (e) {
      // not reachable: the Exit button still works
    }
  })
  $('btn-copy-report').addEventListener('click', () => copy(buildReport(), 'Report'))
  $('btn-copy-log').addEventListener('click', () => copy(redact(lines.join('\n')), 'Log'))
  $('btn-clear-log').addEventListener('click', () => {
    lines.length = 0
    $('log-text').value = ''
    $('log-count').textContent = '0'
  })
  window.addEventListener('error', (e) => log('JSERR', 'renderer: ' + e.message))

  // options are a per-viewer convenience: remembered in localStorage when it is available. The key changed in 1.3.0,
  // when "in web reports context" became on by default, so values saved by older versions don't keep it off.
  const OPTIONS_KEY = 'web-reports-renderer-options-v2'
  try {
    const saved = JSON.parse(localStorage.getItem(OPTIONS_KEY) || '{}')
    if (typeof saved.webReportsContext === 'boolean') $('opt-wrcontext').checked = saved.webReportsContext
    if (typeof saved.refresh === 'boolean') $('opt-refresh').checked = saved.refresh
    if (typeof saved.templates === 'boolean') $('opt-templates').checked = saved.templates
  } catch (e) {
    // storage blocked or unreadable: defaults stay
  }
  const saveOptions = () => {
    try {
      localStorage.setItem(OPTIONS_KEY, JSON.stringify({ webReportsContext: $('opt-wrcontext').checked, refresh: $('opt-refresh').checked, templates: $('opt-templates').checked }))
    } catch (e) {
      // not saved; nothing else depends on it
    }
  }
  ;['opt-wrcontext', 'opt-refresh', 'opt-templates'].forEach((id) => $(id).addEventListener('change', saveOptions))
  $('opt-refresh').addEventListener('change', () => {
    if (!$('opt-refresh').checked) {
      stopRefresh()
      log('INFO', 'refresh sections stopped')
    }
  })

  log('INFO', 'Web Reports Renderer ' + VERSION + ' loaded')
  // BES Explorer answers relevance when one is available, Web Reports otherwise, and results differ between them
  window.WebUIRelevance.onChange((api, s) =>
    log(s.webReports ? 'WARN' : 'INFO', 'relevance through the ' + (api === 'sdk' ? 'SDK' : 'REST') + ' API is now answered by ' + window.WebUIRelevance.sourceName(api) + (s.decodes ? '; it decodes %xx once more, so % is sent as %25' : '') + (s.webReports ? ' (no site files there, and slower)' : ''))
  )
  startShell()
  librariesReady = loadLibraries()
  loadSites(false)
})()
