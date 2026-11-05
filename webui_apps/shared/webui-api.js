// WebUI request helper, shared by the plain HTML/JS apps in webui_apps/. Each app's pack.py copies this file into its
// package as static/js/webui-api.js; load it after webui-relevance.js and before the app's own scripts.
//
// Requests go out the way bfcore-react's BfHttpClient sends them: session cookies plus the X-XSRF-TOKEN header.
// Nothing here throws: every call resolves to a result object, so callers can show the error or try a fallback.
//
// window.WebUIApi:
//   request(method, url, opts)  opts: json (object body), body (string or FormData), contentType, accept, xsrf (default
//                               true). Resolves to { ok, status, text, json, ms, contentType, expired, message }:
//                               json is the parsed body or null, expired is true when the WebUI session has ended
//                               (401 or the iem-login-required header), message is the server's error text
//   evaluate(expr)              session relevance through the SDK API, sent with WebUIRelevance.prepare('sdk', ...).
//                               Adds rows: always an array (a singular result is one row); tuple rows are arrays of
//                               strings
//   query(expr)                 session relevance through the REST passthrough (needs "Can use REST API"), typed: adds
//                               rows, type and plural. A relevance error comes back as ok: false with its message
//   passthrough(method, uri, opts)  the platform REST API through /api/sdk/passthrough/<uri>; uri starts with "api/".
//                               POST/PUT bodies are application/xml or text/plain
//   onRequest(fn)               fn(method, url, result) after every request, e.g. to log it
//   startSession(onUser)        once per page: GET /me (onUser(userName)) and GET /loggedin every 30 s, which keeps
//                               the WebUI session alive the way WebUI's own pages do
//   xmlField(xmlText, tag)      text of the first <tag> element of an XML body, or ''
//   escapeHtml(s), escapeXml(s), relevanceString(s), snippet(text, max), sleep(ms), xsrfToken()
'use strict'
;(function () {
  const KEEPALIVE_MS = 30000
  const listeners = []

  function xsrfToken() {
    const match = document.cookie.split('; ').find((c) => c.startsWith('XSRF-TOKEN='))
    return match ? decodeURIComponent(match.slice('XSRF-TOKEN='.length)) : ''
  }

  const snippet = (text, max) => {
    const flat = String(text || '').replace(/\s+/g, ' ').trim()
    return flat.length > max ? flat.slice(0, max) + '... (' + flat.length + ' chars)' : flat
  }

  async function request(method, url, opts = {}) {
    const headers = { Accept: opts.accept || 'application/json, application/xml;q=0.9, text/plain;q=0.8' }
    const token = xsrfToken()
    if (opts.xsrf !== false && token) headers['X-XSRF-TOKEN'] = token
    let body = opts.body
    if (opts.json !== undefined) {
      body = JSON.stringify(opts.json)
      headers['Content-Type'] = 'application/json'
    } else if (opts.contentType) {
      headers['Content-Type'] = opts.contentType
    }
    // FormData sets its own multipart Content-Type with the boundary

    const started = performance.now()
    let result
    try {
      const response = await fetch(url, { method, credentials: 'same-origin', headers, body })
      const text = await response.text()
      let json = null
      try {
        json = text ? JSON.parse(text) : null
      } catch (e) {
        // XML or plain text body
      }
      const expired = response.status === 401 || !!response.headers.get('iem-login-required')
      result = {
        ok: response.ok && !expired,
        status: response.status,
        text,
        json,
        ms: Math.round(performance.now() - started),
        contentType: response.headers.get('content-type'),
        expired,
        message: ''
      }
      if (expired) result.message = 'The WebUI session has ended: log in to WebUI again, then retry'
      else if (!response.ok) result.message = (json && json.message) || snippet(text, 300) || 'HTTP ' + response.status
    } catch (err) {
      result = { ok: false, status: 0, text: '', json: null, ms: Math.round(performance.now() - started), contentType: null, expired: false, message: 'Network error: ' + err }
    }
    listeners.forEach((fn) => {
      try {
        fn(method, url, result)
      } catch (e) {
        // a listener's error must not break the request
      }
    })
    return result
  }

  // WebUI answers an "improper %-sequence" error when the server's relevance source changed since the last probe
  // (see webui-relevance.js); recheck so the next call is encoded right.
  function recheckOnPercentError(result) {
    if (!result.ok && /improper %-sequence/i.test(result.message)) window.WebUIRelevance.recheck()
  }

  async function evaluate(expr) {
    const result = await request('POST', window.WebUIRelevance.SDK_URL, { json: { session_relevance: window.WebUIRelevance.prepare('sdk', expr) } })
    if (result.ok) {
      const value = result.json && result.json.value
      result.rows = value === undefined || value === null ? [] : Array.isArray(value) ? value : [value]
    } else {
      recheckOnPercentError(result)
    }
    return result
  }

  async function query(expr) {
    const rel = window.WebUIRelevance
    const result = await request('POST', rel.REST_URL, { body: rel.restBody(rel.prepare('rest', expr)), contentType: 'text/plain' })
    const body = result.json
    if (result.ok && body && body.error) {
      // a relevance error is HTTP 200 with { result: [], error }
      result.ok = false
      result.message = body.error
    }
    if (result.ok && body) {
      result.rows = Array.isArray(body.result) ? body.result : []
      result.type = body.type
      result.plural = body.plural
    }
    recheckOnPercentError(result)
    return result
  }

  const passthrough = (method, uri, opts = {}) => request(method, '/api/sdk/passthrough/' + String(uri).replace(/^\/+/, ''), opts)

  let sessionStarted = false
  function startSession(onUser) {
    if (sessionStarted) return
    sessionStarted = true
    fetch('/me', { credentials: 'same-origin' })
      .then((r) => r.json())
      .then((me) => me && me.userName && onUser && onUser(me.userName))
      .catch(() => {})
    setInterval(() => fetch('/loggedin', { credentials: 'same-origin' }).catch(() => {}), KEEPALIVE_MS)
  }

  function xmlField(xmlText, tag) {
    const doc = new DOMParser().parseFromString(String(xmlText || ''), 'application/xml')
    if (doc.getElementsByTagName('parsererror').length) return ''
    const el = doc.getElementsByTagName(tag)[0]
    return el ? el.textContent : ''
  }

  const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  const escapeXml = (s) => escapeHtml(s).replace(/'/g, '&apos;')
  // A relevance string literal: in relevance strings, % starts an escape (%25 is %, %22 is "), so both are encoded.
  const relevanceString = (s) => '"' + String(s).replace(/%/g, '%25').replace(/"/g, '%22') + '"'
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

  window.WebUIApi = {
    request,
    evaluate,
    query,
    passthrough,
    onRequest: (fn) => listeners.push(fn),
    startSession,
    xmlField,
    escapeHtml,
    escapeXml,
    relevanceString,
    snippet,
    sleep,
    xsrfToken
  }
})()
