// Web Reports Renderer - runs inside the report iframe, before any of the report's own scripts.
// Recreates the JavaScript relevance API that Web Reports gives custom reports, on top of the WebUI SDK
// (POST /api/sdk/sessionrelevance/evaluate). Behavior copied from Web Reports 11.0.7's own functions:
//   EvaluateRelevance(q)          synchronous; singular -> string, plural -> array of strings; throws on error
//   Relevance(q)                  synchronous; like EvaluateRelevance, but tuples stay arrays, dates become Date,
//                                 and plural results get sort(i, fn) / toArray() (WR.makeRelevanceArray)
//   Relevance(q, {success, failure})  the same, asynchronously
//   AsyncEvaluateString(q, id)    asynchronous; puts the result in element id's innerHTML
//   StoreSharedVariable / DeleteSharedVariable   Web Reports' dashboard-variable functions (async, callback),
//                                 plus the console's StoreVariable / StorePrivateVariable / DeleteVariable /
//                                 DeletePrivateVariable, on POST / DELETE /api/sdk/dashboardvariable/{id}/{name}
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
    xhr.send(JSON.stringify({ session_relevance: window.WRREL.forWebUI('sdk', relevance) }))
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
      body: JSON.stringify({ session_relevance: window.WRREL.forWebUI('sdk', relevance) })
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

  // relevance.js (loaded before this file) does the typed REST evaluation and the relevance options
  const R = window.WRREL

  function relevanceError(message) {
    const err = new Error(message)
    err.description = message
    return err
  }

  // Evaluates for the JavaScript API. Returns { plural, result, typed } where result holds native values (typed)
  // or strings (SDK fallback). Typed results know plurality exactly; the fallback guesses one value = singular.
  function evaluateForJsSync(query) {
    const relevance = R.prepare(query)
    const started = performance.now()
    const typed = R.evaluateTypedSync(relevance)
    const ms = Math.round(performance.now() - started)
    if (typed.ok) {
      log('JSREL', 'sync typed (' + ms + 'ms, ' + typed.typed.result.length + ' ' + (typed.typed.plural ? 'plural' : 'singular') + ' ' + typed.typed.type + ') ' + short(relevance))
      return Object.assign({ typed: true }, typed.typed)
    }
    if (typed.relevanceError) {
      log('JSREL', 'sync typed (' + ms + 'ms) ' + short(relevance) + ' -> ' + typed.relevanceError)
      throw relevanceError(typed.relevanceError)
    }
    const rows = evaluateSync(relevance)
    return { typed: false, plural: rows.length !== 1, result: rows }
  }

  async function evaluateForJs(query) {
    const relevance = R.prepare(query)
    const started = performance.now()
    const typed = await R.evaluateTyped(relevance)
    const ms = Math.round(performance.now() - started)
    if (typed.ok) {
      log('JSREL', 'async typed (' + ms + 'ms, ' + typed.typed.result.length + ' ' + (typed.typed.plural ? 'plural' : 'singular') + ' ' + typed.typed.type + ') ' + short(relevance))
      return Object.assign({ typed: true }, typed.typed)
    }
    if (typed.relevanceError) {
      log('JSREL', 'async typed (' + ms + 'ms) ' + short(relevance) + ' -> ' + typed.relevanceError)
      throw relevanceError(typed.relevanceError)
    }
    const rows = await evaluateAsync(relevance)
    return { typed: false, plural: rows.length !== 1, result: rows }
  }

  const answersOf = (r) => (r.typed ? R.typedToAnswers(r) : r.result.map(asAnswer))

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

  // Web Reports: plural -> WR.makeRelevanceArray(result), singular -> result[0]
  const relevanceResult = (r) => {
    const values = r.result.map(asValue)
    return r.plural ? makeRelevanceArray(values) : values[0]
  }

  // Web Reports: plural -> array of answer strings (possibly empty), singular -> the answer string
  window.EvaluateRelevance = function (query) {
    const r = evaluateForJsSync(String(query))
    const answers = answersOf(r)
    return r.plural ? answers : answers[0]
  }

  window.Relevance = function (query, callback) {
    if (!callback) return relevanceResult(evaluateForJsSync(String(query)))
    evaluateForJs(String(query)).then(
      (r) => callback.success && callback.success(relevanceResult(r)),
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
    evaluateForJs(String(query)).then(
      (r) => (target.innerHTML = answersOf(r).join('<br />')),
      (err) => (target.textContent = 'Error: ' + err.message)
    )
  }

  // ---- dashboard variables ---------------------------------------------------------------------
  // Web Reports 11.0.7 (/JavaScript/DashboardAPI/DashboardVariables.js) gives custom reports only:
  //   StoreSharedVariable(dashboardID, name, value, callback, databaseID)
  //   DeleteSharedVariable(dashboardID, name, callback, databaseID)
  // Both are asynchronous POSTs; callback is { success(o), failure(o) } with o the HTTP response object; without a
  // callback a failure shows WR.Notify.error(...). Missing arguments show WR.Notify.error and return.
  // The console's wizard API also has StoreVariable(dashboardID, name, value, isPrivate = false),
  // StorePrivateVariable, DeleteVariable(dashboardID, name, isPrivate = false) and DeletePrivateVariable; reports
  // that double as dashboards call those, so they are provided too (synchronous, throwing on error, like external.*).
  // Everything maps to the WebUI SDK: POST / DELETE /api/sdk/dashboardvariable/{dashboardId}/{name}, with body
  // { value, private }. The SDK treats a missing "private" as true, so it is always sent explicitly.
  // Reading a variable stays session relevance, as in Web Reports: shared variable "x" of current wizard, etc.

  // ---- the WR object: the parts reports use directly ----
  // Web Reports 11.0.7's WR has makeRelevanceArray, HTML, DOM, Notify, Array, URL, run, currentSiteID, Filters.
  // Provided here: makeRelevanceArray, Notify (update/warning/error, their *HTML forms, clear, enableNotifications)
  // as a banner at the top of the report, and URL.ParamMap (add/set/remove/addAll/empty/finish/equals; finish()
  // gives "a=1%202&a=3&b=x%26y": values URL-encoded, repeated keys grouped in first-seen order).
  window.WR = window.WR || {}
  window.WR.makeRelevanceArray = window.WR.makeRelevanceArray || makeRelevanceArray

  function notifyBanner() {
    let box = document.getElementById('wrr-notify')
    if (!box) {
      box = document.createElement('div')
      box.id = 'wrr-notify'
      box.setAttribute('role', 'status')
      ;(document.body || document.documentElement).appendChild(box)
    }
    return box
  }

  function notify(kind, content, isHtml) {
    log(kind === 'error' ? 'ERROR' : kind === 'warning' ? 'WARN' : 'INFO', 'WR.Notify.' + kind + ': ' + (isHtml ? String(content).replace(/<[^>]+>/g, '') : content))
    if (kind === 'error') console.error(content)
    const show = () => {
      const item = document.createElement('div')
      item.className = 'wrr-notify-' + kind
      if (isHtml) item.innerHTML = String(content)
      else item.textContent = String(content)
      const close = document.createElement('button')
      close.type = 'button'
      close.textContent = '×'
      close.title = 'Dismiss'
      close.addEventListener('click', () => item.remove())
      item.appendChild(close)
      notifyBanner().appendChild(item)
      // errors stay until dismissed; other messages clear themselves
      if (kind !== 'error') setTimeout(() => item.remove(), 8000)
    }
    if (document.body) show()
    else document.addEventListener('DOMContentLoaded', show)
  }

  window.WR.Notify = window.WR.Notify || {
    update: (m) => notify('update', m, false),
    updateHTML: (m) => notify('update', m, true),
    warning: (m) => notify('warning', m, false),
    warningHTML: (m) => notify('warning', m, true),
    error: (m) => notify('error', m, false),
    errorHTML: (m) => notify('error', m, true),
    clear: () => {
      const box = document.getElementById('wrr-notify')
      if (box) box.replaceChildren()
    },
    enableNotifications: () => {}
  }

  function ParamMap(parameters) {
    this.params = {}
    this.order = []
    this.addAll(parameters)
  }
  ParamMap.prototype.add = function (key, value) {
    if (!(key in this.params)) {
      this.params[key] = []
      this.order.push(key)
    }
    this.params[key].push(value)
    return this
  }
  ParamMap.prototype.set = function (key, value) {
    this.remove(key)
    return this.add(key, value)
  }
  ParamMap.prototype.remove = function (key) {
    delete this.params[key]
    this.order = this.order.filter((k) => k !== key)
    return this
  }
  ParamMap.prototype.addAll = function (parameters) {
    if (!parameters) return this
    if (parameters instanceof ParamMap) parameters.order.forEach((k) => parameters.params[k].forEach((v) => this.add(k, v)))
    else Object.keys(parameters).forEach((k) => [].concat(parameters[k]).forEach((v) => this.add(k, v)))
    return this
  }
  ParamMap.prototype.empty = function () {
    return this.order.length === 0
  }
  ParamMap.prototype.finish = function () {
    return this.order.map((k) => this.params[k].map((v) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&')).join('&')
  }
  ParamMap.prototype.equals = function (other) {
    return other instanceof ParamMap && other.finish() === this.finish()
  }
  window.WR.URL = window.WR.URL || {}
  window.WR.URL.ParamMap = window.WR.URL.ParamMap || ParamMap

  const variableUrl = (dashboardID, name) => '/api/sdk/dashboardvariable/' + encodeURIComponent(dashboardID) + '/' + encodeURIComponent(name)
  const describe = (method, dashboardID, name, isPrivate) => method + ' ' + (isPrivate ? 'private' : 'shared') + ' variable "' + name + '" of "' + dashboardID + '"'

  // the subset of a YUI/XHR response object that Web Reports' callbacks receive
  const responseObject = (status, statusText, responseText) => ({ status, statusText, responseText })

  function variableRequestSync(method, dashboardID, name, value, isPrivate) {
    const xhr = new XMLHttpRequest()
    xhr.open(method, variableUrl(dashboardID, name), false)
    xhr.setRequestHeader('Accept', 'application/json')
    xhr.setRequestHeader('X-XSRF-TOKEN', xsrfToken())
    if (method === 'POST') xhr.setRequestHeader('Content-Type', 'application/json')
    xhr.send(method === 'POST' ? JSON.stringify({ value: String(value), private: !!isPrivate }) : null)
    log('DSVAR', describe(method, dashboardID, name, isPrivate) + ' -> ' + xhr.status)
    if (xhr.status < 200 || xhr.status >= 300) throw errorFrom(xhr.status, xhr.responseText)
    return responseObject(xhr.status, xhr.statusText, xhr.responseText)
  }

  async function variableRequest(method, dashboardID, name, value, isPrivate) {
    const response = await fetch(variableUrl(dashboardID, name), {
      method,
      credentials: 'same-origin',
      headers: Object.assign({ Accept: 'application/json', 'X-XSRF-TOKEN': xsrfToken() }, method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
      body: method === 'POST' ? JSON.stringify({ value: String(value), private: !!isPrivate }) : undefined
    })
    const text = await response.text()
    log('DSVAR', describe(method, dashboardID, name, isPrivate) + ' -> ' + response.status)
    return Object.assign(responseObject(response.status, response.statusText, text), { ok: response.ok })
  }

  // WebUI SDK quirk (11.0.7): DELETE /api/sdk/dashboardvariable/{id}/{name} has no private/shared flag and removes
  // BOTH the shared and the caller's private variable with that name (and GET of that name returns 500 while both
  // exist). To delete only the one asked for, note the other kind from the dashboard's variable list first, then
  // write it back after the delete.
  const listUrl = (dashboardID) => '/api/sdk/dashboardvariable/' + encodeURIComponent(dashboardID)
  const otherKind = (items, name, isPrivate) => (Array.isArray(items) ? items : []).filter((i) => i.Name === name && (String(i.IsPrivate) === 'true') !== !!isPrivate)

  function listVariablesSync(dashboardID) {
    const xhr = new XMLHttpRequest()
    xhr.open('GET', listUrl(dashboardID), false)
    xhr.setRequestHeader('Accept', 'application/json')
    xhr.setRequestHeader('X-XSRF-TOKEN', xsrfToken())
    xhr.send()
    if (xhr.status !== 200) return [] // 404 when the dashboard has no variables
    return (JSON.parse(xhr.responseText) || {}).value || []
  }

  async function listVariables(dashboardID) {
    const response = await fetch(listUrl(dashboardID), { credentials: 'same-origin', headers: { Accept: 'application/json', 'X-XSRF-TOKEN': xsrfToken() } })
    if (!response.ok) return []
    return ((await response.json()) || {}).value || []
  }

  function restoreSync(keep, dashboardID) {
    keep.forEach((i) => {
      variableRequestSync('POST', dashboardID, i.Name, i.Value, String(i.IsPrivate) === 'true')
      log('WARN', 'restored ' + (String(i.IsPrivate) === 'true' ? 'private' : 'shared') + ' variable "' + i.Name + '" that the SDK delete also removed')
    })
  }

  async function restore(keep, dashboardID) {
    for (const i of keep) {
      await variableRequest('POST', dashboardID, i.Name, i.Value, String(i.IsPrivate) === 'true')
      log('WARN', 'restored ' + (String(i.IsPrivate) === 'true' ? 'private' : 'shared') + ' variable "' + i.Name + '" that the SDK delete also removed')
    }
  }

  function deleteVariableSync(dashboardID, name, isPrivate) {
    const keep = otherKind(listVariablesSync(dashboardID), name, isPrivate)
    variableRequestSync('DELETE', dashboardID, name, null, isPrivate)
    restoreSync(keep, dashboardID)
  }

  async function deleteVariable(dashboardID, name, isPrivate) {
    const keep = otherKind(await listVariables(dashboardID), name, isPrivate)
    const o = await variableRequest('DELETE', dashboardID, name, null, isPrivate)
    if (o.ok) await restore(keep, dashboardID)
    return o
  }

  // Web Reports' signature and behavior: asynchronous, callback object, WR.Notify.error when there is no callback
  function webReportsVariableCall(method, dashboardID, name, value, callback, databaseID) {
    if (databaseID) log('INFO', 'databaseID ' + databaseID + ' ignored: WebUI has a single database')
    const url = method === 'POST' ? '/post/store-shared-variable' : '/post/delete-shared-variable'
    const request = method === 'DELETE' ? deleteVariable(dashboardID, name, false) : variableRequest(method, dashboardID, name, value, false)
    request.then(
      (o) => {
        if (o.ok) {
          if (callback && callback.success) callback.success(o)
        } else if (callback && callback.failure) callback.failure(o)
        else window.WR.Notify.error('HTTP POST Request "' + url + '" failed: ' + o.responseText)
      },
      (err) => {
        const o = responseObject(0, String(err), '')
        if (callback && callback.failure) callback.failure(o)
        else window.WR.Notify.error('HTTP POST Request "' + url + '" failed: ' + err)
      }
    )
  }

  window.StoreSharedVariable = function (dashboardID, variableName, variableValue, callback, databaseID) {
    if (!dashboardID || !variableName || !variableValue) {
      window.WR.Notify.error('Attempt to set dashboard datastore value failed: missing required arguments.')
      return
    }
    webReportsVariableCall('POST', dashboardID, variableName, variableValue, callback, databaseID)
  }

  window.DeleteSharedVariable = function (dashboardID, variableName, callback, databaseID) {
    if (!dashboardID || !variableName) {
      window.WR.Notify.error('Attempt to delete dashboard datastore value failed: missing required arguments.')
      return
    }
    webReportsVariableCall('DELETE', dashboardID, variableName, null, callback, databaseID)
  }

  // Console wizard API (not in Web Reports): synchronous, throws on error
  window.StoreVariable = (dashboardID, name, value, isPrivate) => {
    variableRequestSync('POST', dashboardID, name, value, !!isPrivate)
  }
  window.StorePrivateVariable = (dashboardID, name, value) => {
    variableRequestSync('POST', dashboardID, name, value, true)
  }
  window.DeleteVariable = (dashboardID, name, isPrivate) => {
    deleteVariableSync(dashboardID, name, !!isPrivate)
  }
  window.DeletePrivateVariable = (dashboardID, name) => {
    deleteVariableSync(dashboardID, name, true)
  }
  // dashboards call these as external.StoreVariable(...); window.external is a legacy browser object that
  // accepts new properties in current browsers, but may not everywhere
  try {
    ;['StoreVariable', 'StorePrivateVariable', 'StoreSharedVariable', 'DeleteVariable', 'DeletePrivateVariable', 'DeleteSharedVariable'].forEach((n) => {
      if (window.external && typeof window.external[n] !== 'function') window.external[n] = window[n]
    })
  } catch (e) {
    log('INFO', 'external.* dashboard-variable functions not available: ' + e.message)
  }

  // Relevance evaluated through WebUI is not "in web reports context", so link inspectors return console links,
  // e.g. <A href="linkid:opencomputer(123)">. Open the matching WebUI page instead, in a new tab: WebUI pages send
  // X-Frame-Options: DENY, so they cannot load inside this iframe. One delegated listener also covers links that
  // EvaluateRelevance() or DataTables add later.
  const LINKID_TO_WEBUI = [
    [/^linkid:opencomputer\((\d+)\)$/i, (m) => '/framework/devices/' + m[1]],
    [/^linkid:openaction\((\d+)\)$/i, (m) => '/framework/deployments/' + m[1]]
  ]

  // Fixlets, tasks, analyses and baselines: linkid:openfixlet(<siteId>,<fixletId>). WebUI's pages (11.0.7):
  //   external sites:  /content/tasks/<siteId>/<fixletId>   ("tasks" for fixlets too; /content/fixlets/... is 404)
  //   master action site and custom sites:  /custom/tasks/<webuiSiteId>/<fixletId>
  // For the master action site and every custom site the link carries the MASTER action site id, but WebUI needs
  // the custom site's own id (a different 10-digit number), which session relevance cannot return (id of a custom site fails).
  // WebUI's internal list API /custom/api/tasks?search={"query":"<text>"} returns siteID per item, so the link
  // text (the fixlet name) is searched there and the row with the same contentID is used. If nothing matches,
  // the custom content list opens with that search. WebUI has no detail page for analyses or baselines: those
  // URLs fall back to WebUI's content list.
  let masterSiteId = null
  ;(async () => {
    const typed = await R.evaluateTyped('ids of bes sites whose (master site flag of it)')
    if (typed.ok && typed.typed.result.length) masterSiteId = String(typed.typed.result[0])
  })()

  async function customContentUrl(siteId, fixletId, name) {
    const params = [
      'filter=' + encodeURIComponent('{}'),
      'pagination=' + encodeURIComponent(JSON.stringify({ page: { itemsPerPage: 50, offset: 0 } })),
      'search=' + encodeURIComponent(JSON.stringify({ query: name })),
      'sort=' + encodeURIComponent(JSON.stringify({ method: 'name', order: 'asc' }))
    ].join('&')
    try {
      const response = await fetch('/custom/api/tasks?' + params, { credentials: 'same-origin', headers: { Accept: 'application/json' } })
      const rows = response.ok ? (await response.json()).data || [] : []
      const matches = rows.filter((r) => String(r.contentID) === String(fixletId))
      const pick = matches.find((r) => String(r.siteID) === String(siteId)) || matches[0]
      if (pick) {
        if (matches.length > 1) log('WARN', matches.length + ' custom items have id ' + fixletId + ' and this name; opened the one in "' + pick.siteName + '"')
        return '/custom/tasks/' + pick.siteID + '/' + fixletId
      }
      log('WARN', 'no custom content with id ' + fixletId + ' found by name search' + (response.ok ? '' : ' (HTTP ' + response.status + ')') + '; opening the search instead')
    } catch (err) {
      log('WARN', 'custom content lookup failed (' + err + '); opening the search instead')
    }
    return '/custom/tasks?search=' + encodeURIComponent(JSON.stringify({ query: name }))
  }

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
      const fixlet = /^linkid:openfixlet\((\d+),\s*(\d+)\)$/i.exec(href)
      if (fixlet) {
        const [, siteId, fixletId] = fixlet
        const name = a.textContent.trim()
        // master action site id: known from relevance, or by its size (external site ids are small numbers)
        const isMasterOrCustom = masterSiteId ? siteId === masterSiteId : Number(siteId) > 2147483647
        if (!isMasterOrCustom) {
          const url = '/content/tasks/' + siteId + '/' + fixletId
          window.open(url, '_blank', 'noopener')
          log('INFO', 'opened ' + href + ' as ' + url)
          return
        }
        // open the tab now, inside the click, so the popup blocker allows it; navigate it once the lookup is done
        const win = window.open('', '_blank')
        customContentUrl(siteId, fixletId, name).then((url) => {
          if (win) {
            win.opener = null
            win.location.href = url
          } else window.open(url, '_blank', 'noopener')
          log('INFO', 'opened ' + href + ' as ' + url)
        })
        return
      }
      log('WARN', 'no WebUI page for console link ' + href)
    },
    true
  )

  // Web Reports' ThrowError (Util): throws an Error with the message. WakeOnLan.js and some reports call it.
  if (typeof window.ThrowError !== 'function') {
    window.ThrowError = function (message) {
      const e = new Error()
      e.message = message
      throw e
    }
  }

  // Web Reports' WakeOnLan.js defines SendWakeOnLan(cids, dbid): a synchronous GET /json/wakeonlan on the Web Reports
  // server. WebUI 11.0.7 has nothing to map it to (no SDK API, no REST API resource, no WebUI menu item), so here it
  // is a no-op: it logs, shows a warning, and returns false (not sent) instead of throwing.
  window.SendWakeOnLan = function (cids, dbid) {
    const count = Array.isArray(cids) ? cids.length : cids === undefined || cids === null ? 0 : 1
    log('WOL', 'SendWakeOnLan(' + count + ' computer' + (count === 1 ? '' : 's') + (dbid ? ', dbid ' + dbid : '') + ') ignored: wake-on-LAN is not available in WebUI')
    window.WR.Notify.warning('Wake-on-LAN does not work here: WebUI has no wake-on-LAN API. Nothing was sent. Use the BigFix console or Web Reports to wake computers.')
    return false
  }

  // alert() would stop the renderer page with a modal dialog, and reports use it for errors. Here the message goes to
  // the renderer's Log and under the report title instead, and the report keeps running (alert() returns at once).
  window.alert = function (message) {
    const text = message === undefined ? '' : String(message)
    if (host && host.alert) host.alert(text)
    else console.warn('alert: ' + text)
  }

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
