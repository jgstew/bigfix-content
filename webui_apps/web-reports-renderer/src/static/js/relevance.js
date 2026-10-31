// Web Reports Renderer - relevance evaluation shared by the renderer page (app.js) and the report iframe (shim.js).
//
// Two ways to evaluate session relevance from WebUI:
//   1. Typed (preferred): the platform REST query API through the SDK passthrough,
//        POST /api/sdk/passthrough/api/query   body "relevance=<urlencoded>&output=json"   (text/plain)
//      -> {"result":[...], "count":n, "plural":bool, "type":"integer|string|html|( string, integer, time )|...",
//          "evaltime_ms":n}   or   {"result":[], "error":"..."} for a relevance error (still HTTP 200)
//      Values are native JSON (numbers, booleans), tuples are arrays, and plural / type are exact.
//      Needs the operator permission "Can use REST API". A query string on the passthrough URL is rejected
//      (400 "Bad request parameters": the SDK's request validator only allows the {uri} path parameter), so the
//      relevance goes in a POST body. Some bodies get 400 "Bad Request" from WebUI (seen with the string "a <b>").
//   2. Untyped fallback: POST /api/sdk/sessionrelevance/evaluate {"session_relevance": "..."}
//      -> {"done":true, "value":[...], "id":{}}: every value a string, no plurality, no type.
// Typed is tried first. If it fails at the HTTP level (403 without REST permission, 400, network), the caller
// falls back to the SDK API; after a 403 the typed path is switched off for the rest of the page.
//
// Options (WRR.options, set by app.js): rewrite "in web reports context" to "true", and "current wizard" to the
// dashboard with a chosen id, before any relevance is sent.
'use strict'
;(function () {
  const REST_URL = '/api/sdk/passthrough/api/query'
  const state = { typedAvailable: true }

  function xsrfToken() {
    const match = document.cookie.split('; ').find((c) => c.startsWith('XSRF-TOKEN='))
    return match ? decodeURIComponent(match.slice('XSRF-TOKEN='.length)) : ''
  }

  const restBody = (relevance) => 'relevance=' + encodeURIComponent(relevance) + '&output=json'

  // Returns { ok:true, typed:{plural,type,result} } | { ok:false, relevanceError } | { ok:false, unavailable }
  function interpret(status, text) {
    if (status === 403) state.typedAvailable = false
    if (status !== 200) return { ok: false, unavailable: 'HTTP ' + status }
    let body
    try {
      body = JSON.parse(text)
    } catch (e) {
      return { ok: false, unavailable: 'not JSON' }
    }
    if (body.error) return { ok: false, relevanceError: body.error }
    return { ok: true, typed: { plural: !!body.plural, type: String(body.type || ''), result: Array.isArray(body.result) ? body.result : [] } }
  }

  function evaluateTypedSync(relevance) {
    if (!state.typedAvailable) return { ok: false, unavailable: 'REST query disabled for this page (403)' }
    const xhr = new XMLHttpRequest()
    xhr.open('POST', REST_URL, false)
    xhr.setRequestHeader('Content-Type', 'text/plain')
    xhr.setRequestHeader('Accept', 'application/json')
    xhr.setRequestHeader('X-XSRF-TOKEN', xsrfToken())
    try {
      xhr.send(restBody(relevance))
    } catch (e) {
      return { ok: false, unavailable: String(e) }
    }
    return interpret(xhr.status, xhr.responseText)
  }

  async function evaluateTyped(relevance) {
    if (!state.typedAvailable) return { ok: false, unavailable: 'REST query disabled for this page (403)' }
    try {
      const response = await fetch(REST_URL, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'text/plain', Accept: 'application/json', 'X-XSRF-TOKEN': xsrfToken() },
        body: restBody(relevance)
      })
      return interpret(response.status, await response.text())
    } catch (e) {
      return { ok: false, unavailable: String(e) }
    }
  }

  // "( string, integer, html )" -> ["string", "integer", "html"]; "html" -> ["html"]
  function tupleTypes(type) {
    const t = String(type).trim()
    if (t.startsWith('(') && t.endsWith(')')) return t.slice(1, -1).split(',').map((s) => s.trim())
    return [t]
  }

  // How BigFix prints a value: booleans as True/False, numbers and strings as is
  function asText(v) {
    if (v === true) return 'True'
    if (v === false) return 'False'
    return String(v)
  }

  const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

  // A <?Relevance ?> result the way Web Reports renders it: coerced to html (only html values unescaped),
  // tuples as "a, b", plural results joined with "<br />".
  function typedToHtml(typed) {
    const types = tupleTypes(typed.type)
    return typed.result
      .map((row) => {
        if (!Array.isArray(row)) return types[0] === 'html' ? String(row) : escapeHtml(asText(row))
        return row.map((item, i) => (types[i] === 'html' ? String(item) : escapeHtml(asText(item)))).join(', ')
      })
      .join('<br />')
  }

  // EvaluateRelevance answers: strings, tuples as "a, b"
  const typedToAnswers = (typed) => typed.result.map((row) => (Array.isArray(row) ? row.map(asText).join(', ') : asText(row)))

  // ---- options ----

  const options = () => (window.WRR && window.WRR.options) || (window.parent && window.parent.WRR && window.parent.WRR.options) || {}

  // Applies the renderer's relevance options (plain text replacement, so it also applies inside string literals),
  // then wraps the expression in parentheses.
  // Why the parentheses: WebUI 11.0.7 answers 400 "Bad Request" on BOTH /api/sdk/sessionrelevance/evaluate and
  // the REST passthrough when the whole relevance text is also valid JSON - true, false, "x", "a <b>", numbers -
  // apparently because it JSON-parses the value somewhere. (true), True and "a <b>" & "" all work. "(expr)"
  // evaluates the same as "expr" and is never valid JSON.
  function prepare(relevance) {
    const o = options()
    let r = String(relevance)
    if (o.webReportsContext) r = r.replace(/\bin\s+web\s+reports\s+context\b/gi, 'true')
    if (o.dashboardId) r = r.replace(/\bcurrent\s+wizard\b/gi, '(bes wizard whose (dashboard id of it = "' + o.dashboardId.replace(/"/g, '%22') + '"))')
    return '(' + r.trim() + ')'
  }

  window.WRREL = { evaluateTyped, evaluateTypedSync, typedToHtml, typedToAnswers, tupleTypes, asText, escapeHtml, prepare, state }
})()
