// WebUI relevance helper, shared by the plain HTML/JS apps in webui_apps/. Each app's pack.py copies this file into
// its package as static/js/webui-relevance.js; load it before the app's own scripts. No dependencies.
//
// WebUI answers session relevance from BES Explorer when one is available, and falls back to Web Reports otherwise.
// The two answer differently, and the source can change while a page is open (seen on BigFix 11.0.7.61):
//   BES Explorer: in web reports context = False, site files are available, about 300 ms per request
//   Web Reports:  in web reports context = True, no site files, about 3.5 s per request, and %xx is decoded once
//                 more before the relevance parser sees the text: ("%2541") gives "A" instead of "%41", and the
//                 valid ("100%25") fails with "A string constant had an improper %-sequence"
// Both WebUI relevance APIs also reject relevance that is valid JSON (true, "x", 5) with 400 Bad Request.
//
// So each API is probed with one request, (in web reports context, "%2541"), which tells where its answers come from
// and whether % has to be sent as %25. The probe runs when the page loads, again every 5 minutes, and on recheck().
//
// window.WebUIRelevance:
//   wrap(expr)              "(" + expr + ")": never valid JSON, and evaluates the same
//   encode(api, relevance)  the text to send to api "sdk" (POST /api/sdk/sessionrelevance/evaluate) or "rest" (the
//                           REST query through /api/sdk/passthrough/api/query): % becomes %25 when that API decodes
//                           once more. Probes synchronously the first time, if no probe has answered yet.
//   prepare(api, expr)      encode(api, wrap(expr))
//   state                   { sdk: {...}, rest: {...} } with { known, decodes, webReports, at } per API; rest also
//                           has available: false after a 403 (no "Can use REST API" permission)
//   sourceName(api)         "BES Explorer", "Web Reports", or "unknown"
//   probe()                 re-runs both probes; a Promise of state
//   recheck()               the same, for after an "improper %-sequence" error
//   onChange(fn)            fn(api, state[api]) whenever an API's source or %-decoding changes, including the first
//                           answer
//   xsrfToken(), restBody(relevance), SDK_URL, REST_URL
// A page inside a same-origin frame (the Web Reports Renderer's report iframe) reuses its parent's instance.
'use strict'
;(function () {
  try {
    if (window.parent && window.parent !== window && window.parent.WebUIRelevance) {
      window.WebUIRelevance = window.parent.WebUIRelevance
      return
    }
  } catch (e) {
    // cross-origin parent: use our own instance
  }

  const SDK_URL = '/api/sdk/sessionrelevance/evaluate'
  const REST_URL = '/api/sdk/passthrough/api/query'
  const PROBE = '(in web reports context, "%2541")'
  const RECHECK_MS = 5 * 60 * 1000

  const state = {
    sdk: { known: false, decodes: false, webReports: null, at: null },
    rest: { known: false, decodes: false, webReports: null, at: null, available: true }
  }
  const listeners = []

  function xsrfToken() {
    const match = document.cookie.split('; ').find((c) => c.startsWith('XSRF-TOKEN='))
    return match ? decodeURIComponent(match.slice('XSRF-TOKEN='.length)) : ''
  }

  const wrap = (expr) => '(' + String(expr).trim() + ')'
  const restBody = (relevance) => 'relevance=' + encodeURIComponent(relevance) + '&output=json'

  function request(api, body) {
    return api === 'sdk'
      ? { url: SDK_URL, type: 'application/json', body: JSON.stringify({ session_relevance: body }) }
      : { url: REST_URL, type: 'text/plain', body: restBody(body) }
  }

  // The probe's answer: SDK [["True", "A"]] (strings), REST {"result": [[true, "A"]]}. "A" means %2541 was decoded
  // to %41 before the relevance parser turned it into "A"; evaluated as sent it would be "%41".
  function record(api, status, text) {
    const s = state[api]
    const before = s.known + '|' + s.decodes + '|' + s.webReports
    let row = null
    if (api === 'rest' && (status === 401 || status === 403)) s.available = false
    if (status === 200) {
      try {
        const body = JSON.parse(text)
        const rows = api === 'sdk' ? [].concat(body.value) : body.result
        row = Array.isArray(rows) && Array.isArray(rows[0]) ? rows[0] : null
      } catch (e) {
        // not JSON
      }
    }
    s.at = new Date().toISOString()
    if (row) {
      s.known = true
      s.webReports = String(row[0]).toLowerCase() === 'true'
      s.decodes = row[1] === 'A'
    } else if (!s.known) {
      // no answer (permission, network, not WebUI): send as written until a probe does answer
      s.decodes = false
    }
    if (before !== s.known + '|' + s.decodes + '|' + s.webReports) {
      listeners.forEach((fn) => {
        try {
          fn(api, s)
        } catch (e) {
          // a listener's error must not break relevance
        }
      })
    }
  }

  function probeSync(api) {
    const r = request(api, PROBE)
    const xhr = new XMLHttpRequest()
    xhr.open('POST', r.url, false)
    xhr.setRequestHeader('Content-Type', r.type)
    xhr.setRequestHeader('Accept', 'application/json')
    xhr.setRequestHeader('X-XSRF-TOKEN', xsrfToken())
    try {
      xhr.send(r.body)
      record(api, xhr.status, xhr.responseText)
    } catch (e) {
      record(api, 0, '')
    }
  }

  async function probeOne(api) {
    if (api === 'rest' && !state.rest.available) return
    const r = request(api, PROBE)
    try {
      const response = await fetch(r.url, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': r.type, Accept: 'application/json', 'X-XSRF-TOKEN': xsrfToken() },
        body: r.body
      })
      record(api, response.status, await response.text())
    } catch (e) {
      record(api, 0, '')
    }
  }

  let running = null
  function probe() {
    if (!running) running = Promise.all([probeOne('sdk'), probeOne('rest')]).then(() => ((running = null), state))
    return running
  }

  function encode(api, relevance) {
    const s = state[api]
    if (!s.known && !s.at) probeSync(api)
    return s.decodes ? String(relevance).replace(/%/g, '%25') : String(relevance)
  }

  function sourceName(api) {
    const s = state[api]
    return !s.known ? 'unknown' : s.webReports ? 'Web Reports' : 'BES Explorer'
  }

  window.WebUIRelevance = {
    wrap,
    encode,
    prepare: (api, expr) => encode(api, wrap(expr)),
    state,
    sourceName,
    probe,
    recheck: probe,
    onChange: (fn) => listeners.push(fn),
    xsrfToken,
    restBody,
    SDK_URL,
    REST_URL
  }

  probe()
  setInterval(probe, RECHECK_MS)
})()
