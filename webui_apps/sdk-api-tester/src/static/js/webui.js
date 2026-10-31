// SDK API Tester - logging, report, and WebUI request helpers. Loaded before tests.js and app.js.
// Everything hangs off window.SAT so the three plain scripts can share state without a bundler.
'use strict'
window.SAT = window.SAT || {}
;(function (SAT) {
  SAT.VERSION = '1.0.4'
  SAT.lines = []
  SAT.sensitive = new Set() // strings replaced by <REDACTED_n> in copied output when "Redact" is checked
  SAT.state = {} // values shared between tests (ids found by lookups, the test dashboard variable, ...)

  const MAX_LOG_LINES = 5000
  const pad = (n, w) => String(n).padStart(w, '0')

  function timestamp() {
    const d = new Date()
    return pad(d.getHours(), 2) + ':' + pad(d.getMinutes(), 2) + ':' + pad(d.getSeconds(), 2) + '.' + pad(d.getMilliseconds(), 3)
  }

  SAT.checked = (id) => {
    const el = document.getElementById(id)
    return !!(el && el.checked)
  }

  // ---- log ------------------------------------------------------------------------------------

  SAT.log = function (level, msg) {
    const line = timestamp() + ' [' + level + '] ' + msg
    SAT.lines.push(line)
    if (SAT.lines.length > MAX_LOG_LINES) SAT.lines.shift()
    const area = document.getElementById('log-text')
    if (area) {
      area.value += line + '\n'
      area.scrollTop = area.scrollHeight
    }
    const count = document.getElementById('log-count')
    if (count) count.textContent = String(SAT.lines.length)
  }

  SAT.clearLog = function () {
    SAT.lines = []
    const area = document.getElementById('log-text')
    if (area) area.value = ''
    const count = document.getElementById('log-count')
    if (count) count.textContent = '0'
  }

  SAT.snippet = function (text, max) {
    const flat = String(text || '').replace(/\s+/g, ' ').trim()
    return flat.length > max ? flat.slice(0, max) + '... (' + flat.length + ' chars)' : flat
  }

  SAT.errText = (err) => (err && (err.stack || err.message)) || String(err)

  // Masks this server's host name (an IP when WebUI is browsed by address) and the logged-in user so a report can be
  // pasted elsewhere. No generic IPv4 rule: it would also mangle version numbers like 11.0.7.61.
  SAT.redact = function (text) {
    if (!SAT.checked('log-redact')) return text
    const list = Array.from(SAT.sensitive).filter((s) => s && s.length > 1).sort((a, b) => b.length - a.length)
    list.forEach((s, i) => {
      text = text.split(s).join('<REDACTED_' + (i + 1) + '>')
    })
    // BigFix server URLs inside responses, e.g. Resource="https://bigfix.example.com:52311/api/..."
    return text.replace(/(https?:\/\/)([^/:\s"'<>]+)(:\d+)/gi, '$1<SERVER>$3')
  }

  async function copyText(text, label) {
    try {
      await navigator.clipboard.writeText(text)
      SAT.log('INFO', label + ' copied to clipboard (' + text.length + ' chars)')
    } catch (err) {
      // clipboard can be blocked (permissions, non-secure context); fall back to selecting the log text
      SAT.log('WARN', 'Clipboard copy failed (' + err + '); the log is selected, press Ctrl+C / Cmd+C')
      const details = document.getElementById('log-details')
      if (details) details.open = true
      const area = document.getElementById('log-text')
      if (area) {
        area.value = text
        area.focus()
        area.select()
      }
    }
  }

  SAT.buildReport = function () {
    const results = SAT.latestResults()
    const counts = SAT.countResults(results)
    const out = []
    out.push('===== BigFix WebUI SDK API Tester report =====')
    out.push('Tester version: ' + SAT.VERSION)
    out.push('Generated: ' + new Date().toString())
    out.push('Page: ' + location.pathname)
    out.push('User agent: ' + navigator.userAgent)
    out.push('BigFix server: ' + (SAT.state.serverVersion || '?') + '  Master operator: ' + (SAT.state.isMaster === undefined ? '?' : SAT.state.isMaster))
    const rel = window.WebUIRelevance
    out.push('Session relevance answered by: ' + rel.sourceName('sdk') + ' (SDK), ' + rel.sourceName('rest') + ' (REST)' + (rel.state.sdk.decodes || rel.state.rest.decodes ? '; %xx decoded once more, % sent as %25' : ''))
    out.push('Summary (latest result of ' + results.length + ' of ' + SAT.tests.length + ' tests): ' + SAT.formatCounts(counts))
    out.push('')
    out.push('----- Results -----')
    results.forEach((r) => out.push('[' + r.status + '] ' + r.id + ' (' + r.ms + 'ms @' + r.at + '): ' + r.msg))
    out.push('')
    out.push('----- API coverage -----')
    SAT.API_OPERATIONS.forEach((op) => {
      const covering = SAT.tests.filter((t) => t.api === op)
      const status = covering.map((t) => t.id + '=' + (SAT.latest[t.id] ? SAT.latest[t.id].status : 'not run')).join(', ')
      out.push(op + '  ->  ' + (status || 'NO TEST'))
    })
    out.push('')
    out.push('----- Log (' + SAT.lines.length + ' lines) -----')
    out.push(SAT.lines.join('\n'))
    out.push('===== end of report =====')
    return SAT.redact(out.join('\n'))
  }

  SAT.copyReport = () => copyText(SAT.buildReport(), 'Report')
  SAT.copyLog = () => copyText(SAT.redact(SAT.lines.join('\n')), 'Log')

  // ---- WebUI requests ---------------------------------------------------------------------------

  SAT.getCookie = function (name) {
    const match = document.cookie.split('; ').find((c) => c.startsWith(name + '='))
    return match ? decodeURIComponent(match.slice(name.length + 1)) : undefined
  }

  // Sends one request the way bfcore-react's BfHttpClient does (session cookies + X-XSRF-TOKEN) and logs it.
  // Never throws: returns { status, ok, text, json, ms, contentType } so tests can assert on error statuses too.
  // opts: json (object body), body (string or FormData), contentType, xsrf (default true)
  SAT.api = async function (method, url, opts = {}) {
    const headers = { Accept: 'application/json, application/xml;q=0.9, text/plain;q=0.8' }
    const xsrfToken = SAT.getCookie('XSRF-TOKEN')
    if (opts.xsrf !== false && xsrfToken) headers['X-XSRF-TOKEN'] = xsrfToken

    let body = opts.body
    if (opts.json !== undefined) {
      body = JSON.stringify(opts.json)
      headers['Content-Type'] = 'application/json'
    } else if (opts.contentType) {
      headers['Content-Type'] = opts.contentType
    }
    // FormData sets its own multipart Content-Type with the boundary

    const started = performance.now()
    let response
    try {
      response = await fetch(url, { method, credentials: 'same-origin', headers, body })
    } catch (err) {
      const ms = Math.round(performance.now() - started)
      SAT.log('HTTP', method + ' ' + url + ' -> network error: ' + err + ' (' + ms + 'ms)')
      return { status: 0, ok: false, text: '', json: null, ms, contentType: null, error: String(err) }
    }

    const text = await response.text()
    const ms = Math.round(performance.now() - started)
    let json = null
    try {
      json = text ? JSON.parse(text) : null
    } catch (e) {
      // XML or plain text body
    }

    SAT.log('HTTP', method + ' ' + url + (opts.xsrf === false ? ' (no XSRF header)' : '') + ' -> ' + response.status + ' (' + ms + 'ms, ' + text.length + ' bytes)')
    if (!response.ok) SAT.log('BODY', SAT.snippet(text, 1000))
    else if (SAT.checked('log-verbose')) SAT.log('BODY', SAT.snippet(text, 400))

    // don't redirect to /timeout like WebUI pages do: that would throw away the log
    if (response.status === 401 || response.headers.get('iem-login-required')) {
      SAT.log('WARN', 'WebUI session expired. Log in to WebUI in another tab, then run the test again.')
    }

    return { status: response.status, ok: response.ok, text, json, ms, contentType: response.headers.get('content-type') }
  }

  // Server error text for a result: JSON { message } when present, else the start of the body.
  SAT.message = (res) => (res.json && res.json.message) || SAT.snippet(res.text, 200) || 'HTTP ' + res.status

  // Sent as "(relevance)" unless opts.raw: WebUI answers 400 "Bad Request" when the whole relevance text is also
  // valid JSON (true, false, "x", numbers). And when Web Reports answers instead of BES Explorer, WebUI decodes %xx
  // once more, so % is sent as %25 then (../../shared/webui-relevance.js). opts.raw sends the text unchanged (the
  // sr.jsonliteral and sr.percent tests use it to show the quirks).
  SAT.evaluate = (relevance, opts = {}) =>
    SAT.api('POST', '/api/sdk/sessionrelevance/evaluate', { json: { session_relevance: opts.raw ? relevance : window.WebUIRelevance.prepare('sdk', relevance) }, xsrf: opts.xsrf })

  // First value of a session relevance result, or undefined. Values come back as strings.
  SAT.evaluateFirst = async function (relevance) {
    const res = await SAT.evaluate(relevance)
    const rows = res.ok && res.json && Array.isArray(res.json.value) ? res.json.value : []
    return rows.length ? rows[0] : undefined
  }

  SAT.enc = encodeURIComponent
})(window.SAT)
