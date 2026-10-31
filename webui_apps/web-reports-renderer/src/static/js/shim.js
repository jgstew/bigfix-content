// Web Reports Renderer - runs inside the report iframe, before any of the report's own scripts.
// Recreates the JavaScript relevance API that Web Reports gives custom reports, on top of the WebUI SDK
// (POST /api/sdk/sessionrelevance/evaluate). Behavior copied from Web Reports 11.0.7's own functions:
//   EvaluateRelevance(q)          synchronous; singular -> string, plural -> array of strings; throws on error
//   Relevance(q)                  synchronous; like EvaluateRelevance, but tuples stay arrays, dates become Date,
//                                 and plural results get sort(i, fn) / toArray() (WR.makeRelevanceArray)
//   Relevance(q, {success, failure})  the same, asynchronously
//   AsyncEvaluateString(q, id)    asynchronous; puts the result in element id's innerHTML
// Limitation: Web Reports' server reports whether a result is singular or plural; the SDK does not. Here a
// result with exactly one value is treated as singular. A plural expression that returns one value therefore
// gives a string instead of a one-element array.
// The iframe is same-origin with the extension page, so parent.WRR (app.js) receives the log lines.
'use strict'
;(function () {
  const host = (window.parent && window.parent !== window && window.parent.WRR) || null
  const log = (level, msg) => {
    if (host) host.log(level, msg)
  }
  const API = '/api/sdk/sessionrelevance/evaluate'
  // the same date pattern Web Reports' ParseResult turns into Date objects
  const DATE_RE = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d\d (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d\d\d\d \d\d:\d\d:\d\d (\+|-)\d\d\d\d$/
  const short = (s) => (s.length > 120 ? s.slice(0, 120) + '...' : s)

  function xsrfToken() {
    const match = document.cookie.split('; ').find((c) => c.startsWith('XSRF-TOKEN='))
    return match ? decodeURIComponent(match.slice('XSRF-TOKEN='.length)) : ''
  }

  function errorFrom(status, text) {
    let message = 'HTTP ' + status
    try {
      const body = JSON.parse(text)
      if (body && body.message) message = body.message
    } catch (e) {
      if (text) message = text
    }
    const err = new Error(message)
    err.description = message // the console's EvaluateRelevance exposes e.description; some reports read it
    return err
  }

  // Synchronous evaluation, as Web Reports does it (a synchronous XMLHttpRequest).
  function evaluateSync(relevance) {
    const started = performance.now()
    const xhr = new XMLHttpRequest()
    xhr.open('POST', API, false)
    xhr.setRequestHeader('Content-Type', 'application/json')
    xhr.setRequestHeader('Accept', 'application/json')
    xhr.setRequestHeader('X-XSRF-TOKEN', xsrfToken())
    xhr.send(JSON.stringify({ session_relevance: relevance }))
    const ms = Math.round(performance.now() - started)
    if (xhr.status !== 200) {
      const err = errorFrom(xhr.status, xhr.responseText)
      log('JSREL', 'sync ' + xhr.status + ' (' + ms + 'ms) ' + short(relevance) + ' -> ' + err.message)
      throw err
    }
    const value = JSON.parse(xhr.responseText).value
    const rows = Array.isArray(value) ? value : [value]
    log('JSREL', 'sync 200 (' + ms + 'ms, ' + rows.length + ' results) ' + short(relevance))
    return rows
  }

  async function evaluateAsync(relevance) {
    const started = performance.now()
    const response = await fetch(API, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-XSRF-TOKEN': xsrfToken() },
      body: JSON.stringify({ session_relevance: relevance })
    })
    const text = await response.text()
    const ms = Math.round(performance.now() - started)
    if (!response.ok) {
      const err = errorFrom(response.status, text)
      log('JSREL', 'async ' + response.status + ' (' + ms + 'ms) ' + short(relevance) + ' -> ' + err.message)
      throw err
    }
    const value = JSON.parse(text).value
    const rows = Array.isArray(value) ? value : [value]
    log('JSREL', 'async 200 (' + ms + 'ms, ' + rows.length + ' results) ' + short(relevance))
    return rows
  }

  // EvaluateRelevance answers are strings; a tuple comes back as "a, b" like the console prints it
  const asAnswer = (row) => (Array.isArray(row) ? row.join(', ') : String(row))
  const singularOrArray = (answers) => (answers.length === 1 ? answers[0] : answers)

  // Relevance() values: tuples stay arrays, and date strings become Date objects (Web Reports' ParseResult)
  function asValue(row) {
    if (Array.isArray(row)) return row.map(asValue)
    if (typeof row === 'string' && DATE_RE.test(row)) {
      const d = new Date()
      d.setTime(Date.parse(row))
      return d
    }
    return row
  }

  // Web Reports' WR.makeRelevanceArray: sort(i, fn) sorts by tuple item i, toArray() returns the array
  function makeRelevanceArray(array) {
    const parentSort = array.sort
    array.sort = function (i, fn) {
      if (typeof i === 'number') {
        parentSort.call(this, (a, b) => {
          if (fn) return fn(a[i], b[i])
          if (a[i] < b[i]) return -1
          if (a[i] > b[i]) return 1
          return 0
        })
      } else if (i) parentSort.call(this, i)
      else parentSort.call(this)
      return this
    }
    array.toArray = () => array
    return array
  }

  const relevanceResult = (rows) => {
    const values = rows.map(asValue)
    return values.length === 1 ? values[0] : makeRelevanceArray(values)
  }

  window.EvaluateRelevance = function (query) {
    return singularOrArray(evaluateSync(String(query)).map(asAnswer))
  }

  window.Relevance = function (query, callback) {
    if (!callback) return relevanceResult(evaluateSync(String(query)))
    evaluateAsync(String(query)).then(
      (rows) => callback.success && callback.success(relevanceResult(rows)),
      (err) => callback.failure && callback.failure(err.message)
    )
    return null
  }

  // Web Reports' own version shows "loading..." and then, in 11.0.7, assigns the XML document object to
  // innerHTML (a bug). This does what it was meant to do: the answers, joined like a <?Relevance ?> result.
  window.AsyncEvaluateString = function (query, elementId) {
    const target = document.getElementById(elementId)
    if (!target) {
      log('WARN', 'AsyncEvaluateString: no element with id "' + elementId + '"')
      return
    }
    target.innerHTML = 'loading...'
    evaluateAsync(String(query)).then(
      (rows) => (target.innerHTML = rows.map(asAnswer).join('<br />')),
      (err) => (target.textContent = 'Error: ' + err.message)
    )
  }

  // Relevance evaluated through WebUI is not "in web reports context", so link inspectors return console links,
  // e.g. <A href="linkid:opencomputer(123)">. Open the matching WebUI page instead, in a new tab: WebUI pages send
  // X-Frame-Options: DENY, so they cannot load inside this iframe. One delegated listener also covers links that
  // EvaluateRelevance() or DataTables add later.
  const LINKID_TO_WEBUI = [
    [/^linkid:opencomputer\((\d+)\)$/i, (m) => '/framework/devices/' + m[1]],
    [/^linkid:openaction\((\d+)\)$/i, (m) => '/framework/deployments/' + m[1]]
  ]
  document.addEventListener(
    'click',
    (e) => {
      const a = e.target && e.target.closest ? e.target.closest('a[href^="linkid:" i]') : null
      if (!a) return
      e.preventDefault()
      const href = a.getAttribute('href')
      for (const [re, toUrl] of LINKID_TO_WEBUI) {
        const m = re.exec(href)
        if (m) {
          window.open(toUrl(m), '_blank', 'noopener')
          log('INFO', 'opened ' + href + ' as ' + toUrl(m))
          return
        }
      }
      log('WARN', 'no WebUI page for console link ' + href)
    },
    true
  )

  // Console-dashboard functions that some reports call when they double as dashboards
  ;['InsertUtilityDiv', 'RegisterRefreshHandler', 'ClearAllGlobalFilters', 'OpenComputerGroup'].forEach((name) => {
    if (typeof window[name] !== 'function') {
      window[name] = function () {
        log('INFO', name + '() is a console dashboard function; ignored here')
      }
    }
  })

  // Report problems the report's own code hits, so they show in the renderer's log
  window.addEventListener('error', (e) => log('JSERR', e.message + ' (' + (e.filename ? e.filename.split('/').pop() : 'inline') + ':' + e.lineno + ')'))
  window.addEventListener('unhandledrejection', (e) => log('JSERR', 'unhandled rejection: ' + ((e.reason && e.reason.message) || e.reason)))
  document.addEventListener('securitypolicyviolation', (e) =>
    log('BLOCKED', e.violatedDirective + ' blocked ' + (e.blockedURI || 'inline code') + ' (WebUI only allows files from its own server)')
  )
})()
