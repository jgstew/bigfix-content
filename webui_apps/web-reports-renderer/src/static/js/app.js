// Web Reports Renderer: renders a BigFix Web Reports custom report inside WebUI.
//   1. read an uploaded report: raw report HTML (.besrpt / .beswrpt) or <BESWebReport> XML (.webreport)
//   2. replace every <?Relevance ?> with its session relevance result, the way Web Reports does on the server:
//      the result is coerced to html (strings HTML-escaped, html values not) and plural results are joined
//      with "<br />" (both confirmed against Web Reports 11.0.7)
//   3. render it in a same-origin iframe, inside <div id="wr_datapage"> like Web Reports, with shim.js loaded
//      first so the report's own EvaluateRelevance() / Relevance() / AsyncEvaluateString() calls work
// All relevance runs through the WebUI SDK: POST /api/sdk/sessionrelevance/evaluate.
'use strict'
;(function () {
  const VERSION = '1.0.1'
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
  // shim.js inside the iframe logs through this
  window.WRR = { log }

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
        body: JSON.stringify({ session_relevance: relevance })
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
        return { name, format: 'BESWebReport XML', type, problem: 'This is an external report: it opens ' + field('Data').trim() + ' in Web Reports. WebUI extensions cannot frame or call other hosts.' }
      }
      return { name, format: 'BESWebReport XML', type, problem: 'Only custom reports can be rendered. This is a "' + type + '", which is a saved Web Reports page (' + (field('SourcePage').trim() || 'unknown page') + ') rather than report HTML.' }
    }
    return { name: fileName, format: 'report HTML', type: 'CustomReport', html: text }
  }

  // ---- <?Relevance ?> substitution ------------------------------------------------------------

  const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  const asAnswer = (row) => (Array.isArray(row) ? row.join(', ') : String(row))

  // Web Reports coerces a processing instruction's result to the html type: string results are escaped,
  // html results are not. The SDK returns every value as a plain string, so ask the server to do the coercion:
  // "(it as html) of (expr)" works for string and html results. Other types (numbers, booleans, tuples) fail
  // that cast; for those, evaluate the expression as written and escape the values here.
  async function evaluateInstruction(expr) {
    const coerced = await evaluate('(it as html) of (' + expr + ')')
    if (coerced.ok) return { ok: true, html: coerced.value.map(asAnswer).join('<br />'), how: 'as html', count: coerced.value.length }
    const raw = await evaluate(expr)
    if (raw.ok) return { ok: true, html: raw.value.map((v) => escapeHtml(asAnswer(v))).join('<br />'), how: 'escaped', count: raw.value.length }
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

  async function substitute(html, onProgress) {
    // <?BeginRefreshRelevance?> / <?EndRefreshRelevance?> become the <span> Web Reports and the console emit;
    // nothing re-evaluates here, so the section stays as first rendered
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
    return { html: out, count: expressions.length, unique: unique.length, errors }
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
    const shim = new URL('static/js/shim.js', document.baseURI).href
    const css = new URL('static/css/report.css', document.baseURI).href
    // shim.js is a plain blocking script at the top of <head>, so it runs before any of the report's scripts
    return [
      '<!doctype html><html><head><meta charset="utf-8">',
      '<title>' + escapeHtml(title) + '</title>',
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

  let currentFile = null

  async function render() {
    if (!currentFile) return
    await librariesReady
    const started = performance.now()
    const text = await currentFile.text()
    const report = parseReport(text, currentFile.name)
    log('INFO', '===== Rendering "' + report.name + '" from ' + currentFile.name + ' (' + report.format + ', ' + text.length + ' bytes) =====')
    $('wrr-title').textContent = report.name
    $('wrr-frame').hidden = true

    if (report.problem) {
      setStatus(report.problem, true)
      log('WARN', report.problem)
      lastReport = { name: report.name, format: report.format, bytes: text.length, piCount: 0, piErrors: 0, ms: 0 }
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

    const frame = $('wrr-frame')
    frame.srcdoc = buildDocument(libraries.html, report.name)
    frame.hidden = false
    setStatus(
      'Rendered ' + result.count + ' relevance instruction' + (result.count === 1 ? '' : 's') + ' in ' + (ms / 1000).toFixed(1) + 's' +
        (result.errors ? ', ' + result.errors + ' failed (see the log)' : '') +
        (cdn.length ? '. ' + cdn.length + ' external file(s) blocked (see the log).' : '.'),
      result.errors > 0
    )
  }

  function chooseFile(file) {
    if (!file) return
    currentFile = file
    $('wrr-file-name').textContent = file.name + ' (' + file.size.toLocaleString() + ' bytes)'
    $('wrr-rerender').disabled = false
    render()
  }

  // ---- wiring ---------------------------------------------------------------------------------

  $('wrr-file').addEventListener('change', (e) => chooseFile(e.target.files[0]))
  $('wrr-rerender').addEventListener('click', () => render())
  const drop = $('wrr-drop')
  drop.addEventListener('dragover', (e) => {
    e.preventDefault()
    drop.classList.add('wrr-drop-over')
  })
  drop.addEventListener('dragleave', () => drop.classList.remove('wrr-drop-over'))
  drop.addEventListener('drop', (e) => {
    e.preventDefault()
    drop.classList.remove('wrr-drop-over')
    chooseFile(e.dataTransfer.files[0])
  })
  $('btn-copy-report').addEventListener('click', () => copy(buildReport(), 'Report'))
  $('btn-copy-log').addEventListener('click', () => copy(redact(lines.join('\n')), 'Log'))
  $('btn-clear-log').addEventListener('click', () => {
    lines.length = 0
    $('log-text').value = ''
    $('log-count').textContent = '0'
  })
  window.addEventListener('error', (e) => log('JSERR', 'renderer: ' + e.message))

  log('INFO', 'Web Reports Renderer ' + VERSION + ' loaded')
  startShell()
  librariesReady = loadLibraries()
})()
