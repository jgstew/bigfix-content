// Console Dashboards: runs BigFix console dashboards (.ojo wizards) inside WebUI.
//   1. read a dashboard: chosen from a BigFix site (dashboards.js, from session relevance's "bes wizards") or a file;
//      parse its <BES><Wizard> XML: Title, UIHooks, DefaultPage, and every <Page> with its Title, Head and HTML
//   2. replace every <?Relevance ?> (in Head and HTML) with its result, as the console does when it loads a page, plus
//      <?BeginRefreshRelevance?> sections and the <?hxlat?> / <?jxlat?> localization instructions
//   3. render the page in a same-origin iframe with the shared Web Reports layer (relevance.js, shim.js) and
//      console-shim.js loaded first, so the dashboard's console API calls work; linkpage: links switch pages and keep
//      the contents of the page's TheDataStore element, as the console does
// The console API calls the dashboard makes reach this page through window.WRR.console (Take Action dialog, computer
// groups, scratch folder, refresh, other dashboards).
'use strict'
;(function () {
  const VERSION = '1.0.4'
  const KEEPALIVE_MS = 30000
  const PI_CONCURRENCY = 4
  const MAX_LOG_LINES = 5000

  const $ = (id) => document.getElementById(id)
  const lines = []
  const sensitive = new Set([location.host, location.hostname])
  let userName = ''

  // ---- log (same pattern as the Web Reports Renderer and sdk-api-tester) ------------------------------------

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

  function redact(text) {
    if (!$('log-redact').checked) return text
    Array.from(sensitive)
      .filter((s) => s && s.length > 1)
      .sort((a, b) => b.length - a.length)
      .forEach((s, i) => (text = text.split(s).join('<REDACTED_' + (i + 1) + '>')))
    text = text.replace(/([A-Za-z]:[\\/]+Users[\\/]+)[^\\/\s,)"']+/gi, '$1<USER>')
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

  let lastRender = null
  function buildReport() {
    const rel = window.WebUIRelevance
    const out = [
      '===== BigFix Console Dashboards report =====',
      'Console Dashboards version: ' + VERSION,
      'Generated: ' + new Date().toString(),
      'User agent: ' + navigator.userAgent,
      'Session relevance answered by: ' + rel.sourceName('sdk') + ' (SDK), ' + rel.sourceName('rest') + ' (REST)'
    ]
    if (lastRender) {
      out.push('Dashboard: ' + lastRender.name + ' (' + lastRender.id + ', ' + lastRender.from + '), page "' + lastRender.page + '" of ' + lastRender.pages)
      out.push('Relevance instructions: ' + lastRender.piCount + ' (' + lastRender.piErrors + ' failed), rendered in ' + lastRender.ms + 'ms')
    }
    const counts = {}
    lines.forEach((l) => {
      const m = /\[(JSERR|BLOCKED|WARN|ERROR|CONSOLE)\]/.exec(l)
      if (m) counts[m[1]] = (counts[m[1]] || 0) + 1
    })
    out.push('Log line counts: ' + (Object.keys(counts).map((k) => k + ' ' + counts[k]).join(', ') || 'none of JSERR, BLOCKED, WARN, ERROR, CONSOLE'))
    out.push('', '----- Log (' + lines.length + ' lines) -----', lines.join('\n'), '===== end of report =====')
    return redact(out.join('\n'))
  }

  // ---- options --------------------------------------------------------------------------------------------

  // Config value -> what goes between the results of a plural <?Relevance ?>
  const JOINS = { br: '<br />', newline: '\n', none: '' }
  const options = () => ({
    askBeforeChanges: $('opt-ask').checked,
    webReportsContext: $('opt-wrcontext').checked,
    refresh: $('opt-refresh').checked,
    cycleSeconds: Math.max(0, Number($('opt-cycle').value) || 0),
    join: JOINS[$('opt-join').value] !== undefined ? JOINS[$('opt-join').value] : ''
  })
  const OPTIONS_KEY = 'console-dashboards-options-v2' // v2: the plural-join default changed to nothing
  try {
    const saved = JSON.parse(localStorage.getItem(OPTIONS_KEY) || '{}')
    if (typeof saved.askBeforeChanges === 'boolean') $('opt-ask').checked = saved.askBeforeChanges
    if (typeof saved.webReportsContext === 'boolean') $('opt-wrcontext').checked = saved.webReportsContext
    if (typeof saved.refresh === 'boolean') $('opt-refresh').checked = saved.refresh
    if (typeof saved.cycleSeconds === 'number') $('opt-cycle').value = String(saved.cycleSeconds)
    const savedJoin = Object.keys(JOINS).find((k) => JOINS[k] === saved.join)
    if (savedJoin) $('opt-join').value = savedJoin
    if (typeof saved.external === 'boolean') $('opt-external').checked = saved.external
  } catch (e) {
    // storage blocked: defaults stay
  }
  const saveOptions = () => {
    try {
      localStorage.setItem(OPTIONS_KEY, JSON.stringify(Object.assign(options(), { external: $('opt-external').checked })))
    } catch (e) {
      // not saved
    }
  }
  ;['opt-ask', 'opt-wrcontext', 'opt-refresh', 'opt-cycle', 'opt-join', 'opt-external'].forEach((id) => $(id).addEventListener('change', saveOptions))

  // "current wizard" is rewritten (relevance.js) to the dashboard with this id: the .ojo file name, which is the
  // console's dashboard id, so a dashboard in a site sees its real "current wizard" and shares its variables with the
  // console. An uploaded file uses its file name too.
  let currentDashboardId = ''

  // ---- WebUI shell ----------------------------------------------------------------------------------------

  async function startShell() {
    try {
      const me = await (await fetch('/me', { credentials: 'same-origin' })).json()
      if (me && me.userName) {
        userName = me.userName
        sensitive.add(me.userName)
        $('shell-user').textContent = me.userName
      }
    } catch (e) {
      // cosmetic
    }
    setInterval(() => fetch('/loggedin', { credentials: 'same-origin' }).catch(() => {}), KEEPALIVE_MS)
  }

  const xsrf = () => window.WebUIRelevance.xsrfToken()

  // Untyped SDK evaluation for the page: { ok, value, message }
  async function evaluate(relevance) {
    try {
      const response = await fetch(window.WebUIRelevance.SDK_URL, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-XSRF-TOKEN': xsrf() },
        body: JSON.stringify({ session_relevance: window.WRREL.forWebUI('sdk', relevance) })
      })
      const text = await response.text()
      let body = null
      try {
        body = JSON.parse(text)
      } catch (e) {
        // not JSON
      }
      if (response.status === 401 || response.headers.get('iem-login-required')) return { ok: false, status: 401, message: 'WebUI session expired: log in to WebUI again, then render again' }
      if (!response.ok) return { ok: false, status: response.status, message: (body && body.message) || text || 'HTTP ' + response.status }
      const value = body && body.value
      return { ok: true, value: Array.isArray(value) ? value : [value] }
    } catch (err) {
      return { ok: false, status: 0, message: String(err) }
    }
  }
  const first = async (relevance) => {
    const r = await evaluate(window.WRREL.prepare(relevance))
    return r.ok ? r.value : []
  }

  // ---- reading a dashboard ----------------------------------------------------------------------------------

  // -> { name, uiHooks, defaultPage, pages: [{ name, title, head, html }], format } or { problem }
  function parseDashboard(text, fileName) {
    const trimmed = text.replace(/^\uFEFF/, '').trim()
    if (!/<Wizard[\s>]/i.test(trimmed.slice(0, 8000))) {
      // not wizard XML: plain dashboard HTML (one page)
      return { name: fileName, uiHooks: {}, defaultPage: 'Page', pages: [{ name: 'Page', title: fileName, head: '', html: text }], format: 'HTML' }
    }
    const xml = new DOMParser().parseFromString(trimmed, 'application/xml')
    if (xml.getElementsByTagName('parsererror').length) {
      log('WARN', 'the wizard XML does not parse as XML; reading its pages with a looser parser')
      return parseLoosely(trimmed, fileName)
    }
    const wizard = xml.getElementsByTagName('Wizard')[0]
    const child = (el, tag) => Array.from(el.children).find((c) => c.tagName.toLowerCase() === tag.toLowerCase())
    const text_ = (el) => (el ? el.textContent : '')
    const hooks = child(wizard, 'UIHooks')
    const uiHooks = {}
    if (hooks) Array.from(hooks.attributes).forEach((a) => (uiHooks[a.name] = a.value))
    const pages = Array.from(wizard.children)
      .filter((c) => c.tagName.toLowerCase() === 'page')
      .map((p) => ({ name: p.getAttribute('Name') || p.getAttribute('name') || 'Page', title: text_(child(p, 'Title')).trim(), head: text_(child(p, 'Head')), html: text_(child(p, 'HTML')) }))
    if (!pages.length) return { problem: 'The wizard has no <Page> elements.' }
    return { name: text_(child(wizard, 'Title')).trim() || fileName, uiHooks, defaultPage: text_(child(wizard, 'DefaultPage')).trim() || pages[0].name, pages, format: 'wizard XML' }
  }

  // For wizard files that are not well-formed XML (an unescaped & in an attribute, for example)
  function parseLoosely(text, fileName) {
    const cdata = (s) => String(s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    const tag = (s, name) => {
      const m = new RegExp('<' + name + '\\b[^>]*>([\\s\\S]*?)</' + name + '>', 'i').exec(s)
      return m ? cdata(m[1]) : ''
    }
    const wizardHead = text.split(/<Page\b/i)[0]
    const pages = []
    text.replace(/<Page\b([^>]*)>([\s\S]*?)<\/Page>/gi, (m, attrs, inner) => {
      const name = (/Name\s*=\s*"([^"]*)"/i.exec(attrs) || [])[1] || 'Page'
      pages.push({ name, title: tag(inner, 'Title').trim(), head: tag(inner, 'Head'), html: tag(inner, 'HTML') })
      return m
    })
    if (!pages.length) return { problem: 'No <Page> elements found.' }
    return { name: tag(wizardHead, 'Title').trim() || fileName, uiHooks: {}, defaultPage: tag(wizardHead, 'DefaultPage').trim() || pages[0].name, pages, format: 'wizard XML (loosely parsed)' }
  }

  // ---- <?Relevance ?> substitution (the console does this when it loads a page) -----------------------------

  const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  const asAnswer = (row) => (Array.isArray(row) ? row.join(', ') : String(row))

  // Typed first (exact html/string types), then the SDK with "(it as html)", then escaped SDK answers; see the Web
  // Reports Renderer. Plural results are joined with the Config option (nothing like the console, <br /> like Web Reports, or a newline).
  let typedFallbackLogged = false
  async function evaluateInstruction(expr, join) {
    const relevance = window.WRREL.prepare(expr)
    const typed = await window.WRREL.evaluateTyped(relevance)
    if (typed.ok) {
      const html = typed.typed.result.map((row) => window.WRREL.typedToHtml({ type: typed.typed.type, result: [row] })).join(join)
      return { ok: true, html, how: 'typed ' + typed.typed.type, count: typed.typed.result.length }
    }
    if (typed.relevanceError) return { ok: false, message: typed.relevanceError }
    if (!typedFallbackLogged) {
      typedFallbackLogged = true
      log('WARN', 'Typed REST evaluation unavailable (' + typed.unavailable + '); using the SDK API with the "as html" method. Exact types and plurality need "Can use REST API".')
    }
    const coerced = await evaluate('(it as html) of (' + relevance + ')')
    if (coerced.ok) return { ok: true, html: coerced.value.map(asAnswer).join(join), how: 'SDK as html', count: coerced.value.length }
    const raw = await evaluate(relevance)
    if (raw.ok) return { ok: true, html: raw.value.map((v) => escapeHtml(asAnswer(v))).join(join), how: 'SDK escaped', count: raw.value.length }
    return { ok: false, message: raw.message }
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

  const PI_RE = /<\?relevance\b([\s\S]*?)\?>/gi
  const REFRESH_RE = /<\?(Begin|End)RefreshRelevance\b([\s\S]*?)\?>/gi
  const SECTION_RE = /<\?BeginRefreshRelevance\b([\s\S]*?)\?>([\s\S]*?)<\?EndRefreshRelevance\b[\s\S]*?\?>/gi
  const DEFAULT_REFRESH_MS = 60000
  const MIN_REFRESH_MS = 10000

  function parseDuration(text) {
    const m = /^\s*(?:(\d+)\s+)?(\d+):(\d+):(\d+)\s*$/.exec(text)
    return m ? (((Number(m[1] || 0) * 24 + Number(m[2])) * 60 + Number(m[3])) * 60 + Number(m[4])) * 1000 : null
  }
  // The console re-evaluates a section on data changes, at most as often as its attributes say; here a timer does,
  // at the shortest interval (at least 10 s). ManualRefresh="..." alone means "only when ManualRefresh() is called".
  function refreshInterval(attrs) {
    const durations = []
    let manualOnly = true
    attrs.replace(/(\w+)\s*=\s*"([^"]*)"/g, (m, name, value) => {
      const key = name.toLowerCase()
      if (key !== 'id') {
        if (key !== 'manualrefresh') manualOnly = false
        const ms = parseDuration(value)
        if (ms !== null && key !== 'manualrefresh') durations.push(ms)
      }
      return m
    })
    if (/manualrefresh/i.test(attrs) && manualOnly) return 0
    return durations.length ? Math.max(MIN_REFRESH_MS, Math.min(...durations)) : DEFAULT_REFRESH_MS
  }

  // The localization instructions: the console replaces <?hxlat text?> with the (translated) text HTML-escaped, and
  // <?jxlat text?> with it escaped for a JavaScript string literal. There are no translations here.
  const hxlat = (html) => html.replace(/<\?hxlat\s+([\s\S]*?)\?>/gi, (m, t) => escapeHtml(t))
  const jxlat = (html) => html.replace(/<\?jxlat\s+([\s\S]*?)\?>/gi, (m, t) => t.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/'/g, "\\'"))

  async function substitute(html, onProgress, join) {
    html = jxlat(hxlat(html))
    const sections = []
    html = html.replace(SECTION_RE, (m, attrs, inner) => {
      const id = /id\s*=\s*"([^"]*)"/i.exec(attrs)
      const n = sections.length
      sections.push({ id: id ? id[1] : '__DRRSN', ms: refreshInterval(attrs), template: inner })
      return '<span id="' + escapeHtml(id ? id[1] : '__DRRSN') + '" data-wrr-refresh="' + n + '">' + inner + '</span>'
    })
    html = html.replace(REFRESH_RE, (m, kind, attrs) => {
      if (kind.toLowerCase() === 'end') return '</span>'
      const id = /id\s*=\s*"([^"]*)"/i.exec(attrs)
      return '<span id="' + escapeHtml(id ? id[1] : '__DRRSN') + '">'
    })
    const expressions = []
    html.replace(PI_RE, (m, expr) => (expressions.push(expr.trim()), m))
    const unique = Array.from(new Set(expressions))
    let done = 0
    const answers = await mapLimit(unique, PI_CONCURRENCY, async (expr) => {
      const started = performance.now()
      const result = await evaluateInstruction(expr, join)
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

  // ---- refresh sections and signals -----------------------------------------------------------------------

  let refreshTimers = []
  let sections = []
  let cycleTimer = null
  function stopRefresh() {
    refreshTimers.forEach((t) => clearInterval(t))
    refreshTimers = []
    if (cycleTimer) clearInterval(cycleTimer)
    cycleTimer = null
  }

  async function refreshOne(n) {
    const frame = $('wrr-frame')
    const doc = frame.contentDocument
    const span = doc && doc.querySelector('[data-wrr-refresh="' + n + '"]')
    if (!span) return false
    const section = sections[n]
    const result = await substitute(section.template, () => {}, options().join)
    span.innerHTML = rewriteLibraries(result.html).html
    log('INFO', 'refreshed section "' + section.id + '" (' + result.count + ' relevance, ' + result.errors + ' failed)')
    return true
  }

  function startRefresh() {
    stopRefresh()
    const o = options()
    if (o.refresh) {
      sections.forEach((section, n) => {
        if (!section.ms) {
          log('INFO', 'section "' + section.id + '" refreshes on ManualRefresh() only')
          return
        }
        log('INFO', 'refresh section "' + section.id + '" every ' + section.ms / 1000 + 's')
        refreshTimers.push(setInterval(() => refreshOne(n), section.ms))
      })
    }
    if (o.cycleSeconds) cycleTimer = setInterval(() => sendSignal('RefreshCycle'), o.cycleSeconds * 1000)
  }

  function sendSignal(name) {
    setTimeout(() => {
      try {
        const w = $('wrr-frame').contentWindow
        if (w && w.__cdSignal) w.__cdSignal(name)
      } catch (e) {
        // frame gone
      }
    }, 0)
  }

  // ---- CDN libraries (same as the Web Reports Renderer) -----------------------------------------------------

  let libs = null
  let librariesReady = Promise.resolve()
  async function loadLibraries() {
    try {
      const response = await fetch(new URL('static/libs/manifest.json', document.baseURI), { cache: 'no-cache', credentials: 'same-origin' })
      if (!response.ok) throw new Error('HTTP ' + response.status)
      const manifest = await response.json()
      libs = { files: new Set(manifest.files), aliases: manifest.aliases || {} }
      log('INFO', libs.files.size + ' local library files available for cdnjs URLs')
    } catch (err) {
      log('WARN', 'No local library copies (' + err.message + '); dashboards that load jQuery, DataTables, d3 and so on from a CDN will not work. Build with fetch_libs.py.')
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

  // ---- rendering --------------------------------------------------------------------------------------------

  function buildDocument(head, body, title) {
    const url = (p) => new URL(p, document.baseURI).href
    return [
      '<!doctype html><html><head><meta charset="utf-8">',
      '<title>' + escapeHtml(title) + '</title>',
      '<script src="' + url('static/js/webui-relevance.js') + '"></scr' + 'ipt>',
      '<script src="' + url('static/js/relevance.js') + '"></scr' + 'ipt>',
      '<script src="' + url('static/js/shim.js') + '"></scr' + 'ipt>',
      '<script src="' + url('static/js/console-shim.js') + '"></scr' + 'ipt>',
      '<link rel="stylesheet" href="' + url('static/css/dashboard.css') + '">',
      head,
      '</head><body><div id="wr_datapage">',
      body,
      '</div></body></html>'
    ].join('\n')
  }

  function setStatus(text, isError) {
    $('wrr-status').textContent = text
    $('wrr-status').className = 'wrr-status wrr-small' + (isError ? ' wrr-error-text' : '')
  }

  // The dashboard being shown: { name, id, from, getText(), source, site }, its parsed wizard, and the page shown
  let current = null
  let wizard = null
  let pageName = null
  let carryDataStore = null // TheDataStore contents carried to the next page
  let wantsActiveX = false // the page's source mentions ActiveXObject, so console-shim.js defines it
  // stand-ins for the console's own stylesheets that dashboards link by relative name
  const CONSOLE_STANDINS = ['common.css', 'commonBlue.css']

  async function load() {
    if (!current) return
    await librariesReady
    let text
    try {
      setStatus('Loading ' + current.name + '...')
      text = await current.getText()
    } catch (err) {
      setStatus('Could not load ' + current.name + ' from ' + current.from + ': ' + err.message, true)
      log('WARN', 'could not load ' + current.name + ' from ' + current.from + ': ' + err.message)
      return
    }
    wizard = parseDashboard(text, current.name)
    if (wizard.problem) {
      setStatus(wizard.problem, true)
      log('WARN', wizard.problem)
      return
    }
    currentDashboardId = current.id
    log('INFO', '===== Loaded "' + wizard.name + '" (' + current.id + ', ' + current.from + ', ' + wizard.format + ', ' + text.length + ' bytes, ' + wizard.pages.length + ' page' + (wizard.pages.length === 1 ? '' : 's') + (wizard.uiHooks.LaunchType ? ', LaunchType ' + wizard.uiHooks.LaunchType : '') + ') =====')
    if (/^dialog$/i.test(wizard.uiHooks.LaunchType || '')) log('INFO', 'a Dialog wizard: shown as a page here (WebUI has no dialog windows); its OK-button import (theXMLToImport) does not run')
    const select = $('cd-page')
    select.textContent = ''
    wizard.pages.forEach((p) => {
      const o = document.createElement('option')
      o.value = p.name
      o.textContent = p.name + (p.title ? ' - ' + p.title : '')
      select.appendChild(o)
    })
    $('cd-page-label').hidden = wizard.pages.length < 2
    carryDataStore = null
    await renderPage(wizard.pages.find((p) => p.name === wizard.defaultPage) ? wizard.defaultPage : wizard.pages[0].name)
  }

  async function renderPage(name) {
    const pageDef = wizard && wizard.pages.find((p) => p.name.toLowerCase() === String(name).toLowerCase())
    if (!pageDef) {
      log('WARN', 'linkpage:' + name + ': the wizard has no page with that name')
      return
    }
    pageName = pageDef.name
    $('cd-page').value = pageDef.name
    const started = performance.now()
    const o = options()
    log('INFO', '----- Page "' + pageDef.name + '"' + (pageDef.title ? ' (' + pageDef.title + ')' : '') + ' -----')
    log('INFO', 'Options: dashboard id for current wizard = ' + currentDashboardId + ', in web reports context = ' + (o.webReportsContext ? 'true (rewritten)' : 'as evaluated') + ', ask before changes = ' + o.askBeforeChanges + ', refresh sections = ' + o.refresh + ', RefreshCycle every ' + (o.cycleSeconds || 'never') + (o.cycleSeconds ? 's' : '') + ', plural join = ' + JSON.stringify(o.join) + '; relevance answered by ' + window.WebUIRelevance.sourceName('rest') + ' (REST), ' + window.WebUIRelevance.sourceName('sdk') + ' (SDK)')
    $('wrr-title').textContent = wizard.name
    document.title = (pageDef.title || wizard.name) + ' - Console Dashboards'
    clearAlerts()
    stopRefresh()

    setStatus('Evaluating relevance...')
    let done = 0
    const progress = (n, total) => setStatus('Evaluating relevance: ' + (done + n) + '...')
    const head = await substitute(pageDef.head, progress, o.join)
    done = head.unique
    const body = await substitute(pageDef.html, progress, o.join)
    sections = head.sections.concat(body.sections)
    // section indexes in the body follow the head's
    let html = body.html.replace(/data-wrr-refresh="(\d+)"/g, (m, n) => 'data-wrr-refresh="' + (Number(n) + head.sections.length) + '"')
    const count = head.count + body.count
    const errors = head.errors + body.errors
    const ms = Math.round(performance.now() - started)
    log('INFO', count + ' <?Relevance ?> (' + (head.unique + body.unique) + ' unique), ' + errors + ' failed, in ' + ms + 'ms')

    const libraries = rewriteLibraries(head.html + '\u0000' + html)
    if (libraries.rewritten.length) log('INFO', 'Using local copies for ' + libraries.rewritten.length + ' CDN file(s): ' + libraries.rewritten.join(', '))
    let [headHtml, bodyHtml] = libraries.html.split('\u0000')
    const cdn = Array.from(new Set((libraries.html.match(/(?:src|href)\s*=\s*["']https?:\/\/[^"']+/gi) || []).map((s) => s.replace(/^(?:src|href)\s*=\s*["']/i, '')))).filter((url) => !url.startsWith(location.origin))
    if (cdn.length) log('WARN', cdn.length + ' file(s) from other hosts have no local copy and will be blocked by WebUI: ' + cdn.join(', '))

    // relative files: from the dashboard's site, else the newest name match among the bundled libraries and the
    // stand-ins for the console's own stylesheets (common.css, commonBlue.css, which only the console has)
    const label = current.source ? current.source.label : 'the uploaded dashboard'
    const standins = CONSOLE_STANDINS.map((name) => ({ path: 'console-standins/' + VERSION + '/' + name, url: new URL('static/css/console/' + name, document.baseURI).href }))
    const pool = window.WRRFILES.makePool({ libs: (libs ? Array.from(libs.files).map((path) => ({ path, url: localLibrary(path) })) : []).concat(standins), sites: [] })
    const headFiles = await window.WRRFILES.resolve(headHtml, current.source, pool, current.site)
    const bodyFiles = await window.WRRFILES.resolve(bodyHtml, current.source, pool, current.site)
    headHtml = headFiles.html
    bodyHtml = bodyFiles.html
    ;[headFiles, bodyFiles].forEach((files) => {
      if (files.inlined.length) log('FILES', 'loaded ' + files.inlined.length + ' script/stylesheet file(s): ' + files.inlined.join(', '))
      files.substituted.forEach((f) => log(f.exact ? 'FILES' : 'WARN', f.ref + ' is not ' + (f.exact ? 'in ' : 'usable from ') + label + '; using ' + (f.exact ? 'the same file name' : f.name) + ' from ' + f.from + (f.exact ? '' : ' instead (a name match, not the same file)')))
      if (files.binary.length) log('FILES', files.binary.length + ' image(s) or font(s) in ' + label + ' cannot load (the WebUI passthrough corrupts binary files): ' + files.binary.join(', '))
      if (files.missing.length) log('FILES', files.missing.length + ' relative file(s) not found: ' + files.missing.join(', '))
    })

    // data: images are blocked by WebUI's img-src 'self' blob:; give them blob: URLs with the same bytes (images added
    // later are switched by console-shim.js)
    let dataImages = 0
    const toBlob = (html) =>
      html.replace(/(<img\b[^>]*?\bsrc\s*=\s*)(["'])(data:image\/[^"']+)\2/gi, (m, before, q, url) => {
        const parts = /^data:([^;,]*)(;base64)?,([\s\S]*)$/i.exec(url)
        if (!parts) return m
        try {
          const bin = parts[2] ? atob(parts[3].replace(/\s+/g, '')) : decodeURIComponent(parts[3])
          const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0) & 0xff)
          dataImages++
          return before + q + URL.createObjectURL(new Blob([bytes], { type: parts[1] })) + q
        } catch (e) {
          return m
        }
      })
    headHtml = toBlob(headHtml)
    bodyHtml = toBlob(bodyHtml)
    if (dataImages) log('INFO', dataImages + ' data: image(s) shown as blob: URLs (WebUI blocks data: images)')
    wantsActiveX = /\bActiveXObject\b/.test(pageDef.head + pageDef.html)

    const frame = $('wrr-frame')
    // The console preserves TheDataStore's contents across linkpage: navigation, and they are there when the next
    // page's scripts run, so they go into the page source (an element with id="TheDataStore" or "finishClicked",
    // which is reset to "0"); the load handler covers markup the pattern doesn't match
    const carry = carryDataStore
    carryDataStore = null
    let carried = false
    if (carry !== null) {
      const fill = (html, id, value) =>
        html.replace(new RegExp('(<(\\w+)\\b[^>]*\\bid\\s*=\\s*["\']' + id + '["\'][^>]*>)([\\s\\S]*?)(</\\2>)', 'i'), (m, open, tag, inner, close) => {
          if (id === 'TheDataStore') carried = true
          return open + value + close
        })
      bodyHtml = fill(fill(bodyHtml, 'TheDataStore', carry), 'finishClicked', '0')
      if (carried) log('INFO', 'TheDataStore carried over (' + carry.length + ' chars)')
    }
    frame.onload = () => {
      try {
        frame.contentDocument.addEventListener('keydown', onKey)
        if (carry !== null && !carried) {
          const ds = frame.contentDocument.getElementById('TheDataStore')
          if (ds) {
            ds.innerHTML = carry
            log('INFO', 'TheDataStore carried over after load (' + carry.length + ' chars; its markup did not match, so the page\'s scripts ran before it)')
          }
        }
      } catch (e) {
        // not reachable
      }
    }
    frame.srcdoc = buildDocument(headHtml, bodyHtml, pageDef.title || wizard.name)
    frame.hidden = false
    $('wrr-fullscreen').hidden = false
    startRefresh()
    lastRender = { name: wizard.name, id: currentDashboardId, from: current.from, page: pageDef.name, pages: wizard.pages.length, piCount: count, piErrors: errors, ms }
    setStatus('Rendered page "' + pageDef.name + '": ' + count + ' relevance instruction' + (count === 1 ? '' : 's') + ' in ' + (ms / 1000).toFixed(1) + 's' + (errors ? ', ' + errors + ' failed (see the log)' : '') + (cdn.length ? '. ' + cdn.length + ' external file(s) blocked (see the log).' : '.'), errors > 0)
  }

  async function goToPage(name) {
    try {
      const ds = $('wrr-frame').contentDocument && $('wrr-frame').contentDocument.getElementById('TheDataStore')
      carryDataStore = ds ? ds.innerHTML : null
    } catch (e) {
      carryDataStore = null
    }
    log('INFO', 'linkpage:' + name)
    await renderPage(name)
  }

  // ---- the scratch folder (GetScratchRootPath, WriteFile, CopyFile, ...) ------------------------------------
  // Paths ignore case and accept / or \. Full paths start with ROOT (the dashboard's scratch folder) or LOCAL_ROOT
  // (files the user added in the Scratch files panel, standing in for local disk files).
  const scratch = (() => {
    const ROOT = 'C:\\WebUIScratch\\'
    const LOCAL_ROOT = 'C:\\WebUILocal\\'
    const files = new Map() // key -> { path (as written, under its root), bytes, local }
    const folders = new Set()
    const enc = new TextEncoder()
    const dec = new TextDecoder()
    const norm = (p) => String(p).replace(/\//g, '\\').replace(/\\+/g, '\\')
    // -> { key, local, rel } for a full or scratch-relative path
    function locate(p) {
      let s = norm(p)
      let local = false
      if (s.toLowerCase().startsWith(ROOT.toLowerCase())) s = s.slice(ROOT.length)
      else if (s.toLowerCase().startsWith(LOCAL_ROOT.toLowerCase())) {
        s = s.slice(LOCAL_ROOT.length)
        local = true
      }
      s = s.replace(/^\\+/, '').replace(/\\+$/, '')
      return { key: (local ? 'local:' : '') + s.toLowerCase(), local, rel: s }
    }
    const full = (p) => {
      const l = locate(p)
      return (l.local ? LOCAL_ROOT : ROOT) + l.rel
    }
    const notFound = (p) => 'Error: File error "class FileNotFoundError" on "' + full(p) + '" : "Windows Error 0x2%: The system cannot find the file specified."'
    const parentOf = (key) => key.replace(/\\[^\\]*$/, '').replace(/^[^\\]*$/, '')
    function addFolders(key) {
      let k = parentOf(key)
      while (k && !k.endsWith(':')) {
        folders.add(k)
        k = parentOf(k)
      }
    }
    const under = (folderKey) => Array.from(files.keys()).filter((k) => folderKey === '' || k.startsWith(folderKey + '\\'))
    function put(p, bytes) {
      const l = locate(p)
      if (!l.rel) return 'Error: no file name'
      files.set(l.key, { path: full(p), bytes, local: l.local })
      addFolders(l.key)
      changed()
      return 'Success'
    }
    let onChange = () => {}
    const changed = () => onChange()
    return {
      root: ROOT,
      localRoot: LOCAL_ROOT,
      full,
      baseName: (p) => norm(p).split('\\').pop(),
      makeFolder(p) {
        const l = locate(p)
        folders.add(l.key)
        addFolders(l.key + '\\x')
        changed()
        return 'Success'
      },
      write(p, text, append) {
        const l = locate(p)
        const existing = files.get(l.key)
        if (append && !existing) return 'Error: File does not exist.'
        const add = enc.encode(text)
        if (!append) return put(p, add)
        const joined = new Uint8Array(existing.bytes.length + add.length)
        joined.set(existing.bytes)
        joined.set(add, existing.bytes.length)
        existing.bytes = joined
        changed()
        return 'Success'
      },
      writeBytes: (p, bytes) => put(p, bytes),
      bytes: (p) => {
        const f = files.get(locate(p).key)
        return f ? f.bytes : null
      },
      text: (p) => {
        const f = files.get(locate(p).key)
        return f ? dec.decode(f.bytes) : null
      },
      copy(input, dest, overwrite) {
        const src = files.get(locate(input).key)
        if (!src) return 'Error: File does not exist.'
        if (files.has(locate(dest).key) && !overwrite) return 'Error: The file already exists.'
        return put(dest, src.bytes.slice())
      },
      copyFolder(input, dest, recurse) {
        const from = locate(input).key
        const keys = under(from).filter((k) => recurse || !k.slice(from.length + 1).includes('\\'))
        if (!keys.length && !folders.has(from)) return 'Error: File does not exist.'
        const to = locate(dest).rel
        for (const k of keys) {
          const rel = files.get(k).path.split('\\').slice(full(input).split('\\').length).join('\\')
          if (files.has(locate(to + '\\' + rel).key)) return 'Error: The file already exists.'
          put(to + '\\' + rel, files.get(k).bytes.slice())
        }
        return 'Success'
      },
      move(src, dest, overwrite) {
        const s = locate(src)
        const f = files.get(s.key)
        if (!f) return 'Error: File does not exist.'
        if (files.has(locate(dest).key) && !overwrite) return 'Error: The file already exists.'
        files.delete(s.key)
        return put(dest, f.bytes)
      },
      remove(p) {
        const l = locate(p)
        if (!files.delete(l.key)) return notFound(p)
        changed()
        return 'Success'
      },
      removeAll(p, recurse) {
        const from = locate(p).key
        under(from)
          .filter((k) => recurse || !k.slice(from.length + 1).includes('\\'))
          .forEach((k) => files.delete(k))
        changed()
        return 'Success'
      },
      removeFolder(p) {
        const k = locate(p).key
        if (!folders.has(k)) return notFound(p)
        if (under(k).length || Array.from(folders).some((f) => f.startsWith(k + '\\'))) return 'Error: The directory is not empty.'
        folders.delete(k)
        changed()
        return 'Success'
      },
      removeTree(p) {
        const k = locate(p).key
        under(k).forEach((f) => files.delete(f))
        Array.from(folders)
          .filter((f) => f === k || f.startsWith(k + '\\'))
          .forEach((f) => folders.delete(f))
        changed()
        return 'Success'
      },
      localFiles: () =>
        Array.from(files.values())
          .filter((f) => f.local)
          .map((f) => ({ name: f.path.split('\\').pop(), path: f.path })),
      list: () => Array.from(files.values()).sort((a, b) => a.path.localeCompare(b.path)),
      clear(localToo) {
        Array.from(files.keys())
          .filter((k) => localToo || !k.startsWith('local:'))
          .forEach((k) => files.delete(k))
        folders.clear()
        changed()
      },
      onChange: (fn) => (onChange = fn)
    }
  })()

  function showScratch() {
    const rows = scratch.list()
    $('scratch-count').textContent = String(rows.length)
    const body = $('scratch-table').tBodies[0]
    body.textContent = ''
    rows.forEach((f) => {
      const tr = document.createElement('tr')
      const name = document.createElement('td')
      name.textContent = f.path
      const size = document.createElement('td')
      size.textContent = f.bytes.length.toLocaleString()
      const action = document.createElement('td')
      const a = document.createElement('a')
      a.textContent = 'Save'
      a.href = '#'
      a.addEventListener('click', (e) => {
        e.preventDefault()
        const url = URL.createObjectURL(new Blob([f.bytes]))
        const link = document.createElement('a')
        link.href = url
        link.download = f.path.split('\\').pop()
        link.click()
        setTimeout(() => URL.revokeObjectURL(url), 10000)
      })
      action.appendChild(a)
      tr.append(name, size, action)
      body.appendChild(tr)
    })
  }
  scratch.onChange(showScratch)
  $('scratch-add').addEventListener('change', async (e) => {
    for (const file of Array.from(e.target.files)) {
      scratch.writeBytes(scratch.localRoot + file.name, new Uint8Array(await file.arrayBuffer()))
      log('INFO', 'added local file ' + file.name + ' (' + file.size + ' bytes) as ' + scratch.localRoot + file.name)
    }
    e.target.value = ''
  })
  $('scratch-clear').addEventListener('click', () => {
    scratch.clear(false)
    log('INFO', 'scratch folder cleared (local files kept)')
  })

  // ---- dialogs: Take Action, computer group ----------------------------------------------------------------

  let dialogOpen = false
  function openDialog(title, buildBody, buttons) {
    $('cd-dialog-title').textContent = title
    const body = $('cd-dialog-body')
    body.textContent = ''
    buildBody(body)
    $('cd-dialog-error').hidden = true
    const bar = $('cd-dialog-buttons')
    bar.textContent = ''
    buttons.forEach((b) => {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'wrr-button' + (b.primary ? ' wrr-button-primary' : '')
      button.textContent = b.label
      button.addEventListener('click', b.onClick)
      if (b.id) button.id = b.id
      bar.appendChild(button)
    })
    $('cd-overlay').hidden = false
    dialogOpen = true
  }
  function closeDialog() {
    $('cd-overlay').hidden = true
    dialogOpen = false
  }
  const dialogError = (text) => {
    $('cd-dialog-error').textContent = text
    $('cd-dialog-error').hidden = !text
  }
  const el = (tag, props, children) => {
    const e = document.createElement(tag)
    Object.assign(e, props || {})
    ;(children || []).forEach((c) => e.append(c))
    return e
  }

  let masterSiteId = null
  async function masterId() {
    if (masterSiteId === null) masterSiteId = String((await first('ids of bes sites whose (master site flag of it)'))[0] || '')
    return masterSiteId
  }

  // Finds the fixlet a dashboard means by (id, siteID): the site id is the master action site's for custom, master and
  // operator site content (that is what the console's "id of site" gives there). Content a dashboard has just imported
  // takes a few seconds to show in relevance (seen with BES Explorer answering, 11.0.7), so this retries for up to 30 s.
  async function findFixlet(fixletID, siteID) {
    const master = await masterId()
    const local = String(siteID) === master || Number(siteID) > 2147483647 || !siteID
    const where = local ? '(custom site flag of site of it or master site flag of site of it or operator site flag of site of it)' : '(exists (id of site of it) whose (it = ' + Number(siteID) + '))'
    const query = '(name of it, name of site of it, (if task flag of it then "task" else if baseline flag of it then "baseline" else if analysis flag of it then "analysis" else "fixlet"), (if external site flag of site of it then "external" else "local")) of bes fixlets whose (id of it = ' + Number(fixletID) + ' and ' + where + ')'
    let rows = await first(query)
    for (let i = 0; !rows.length && i < 15; i++) {
      if (!i) setStatus('Waiting for ' + fixletID + ' to show in relevance (new content takes a few seconds)...')
      await new Promise((r) => setTimeout(r, 2000))
      rows = await first(query)
    }
    if (!rows.length) return null
    const [name, site, type, kind] = rows[0]
    return { name, site, type, external: kind === 'external', where }
  }

  // The action's script and description, from the fixlet's BES XML through the SDK (custom content, or an external
  // site by name), and the parameters its script uses
  async function actionDetails(fixletID, fixlet, contentID) {
    const url = fixlet.external ? '/api/sdk/resources/' + fixlet.type + '/external/' + encodeURIComponent(fixlet.site) + '/' + fixletID : '/api/sdk/resources/' + fixlet.type + '/' + fixletID
    try {
      const response = await fetch(url, { credentials: 'same-origin', headers: { Accept: 'application/xml', 'X-XSRF-TOKEN': xsrf() } })
      if (!response.ok) return { parameters: [], description: '', script: '' }
      const doc = new DOMParser().parseFromString(await response.text(), 'application/xml')
      const action = Array.from(doc.querySelectorAll('DefaultAction, Action')).find((a) => a.getAttribute('ID') === contentID)
      if (!action) return { missing: true, parameters: [], description: '', script: '' }
      const script = Array.from(action.getElementsByTagName('ActionScript'))
        .map((s) => s.textContent)
        .join('\n')
      const description = ((action.getElementsByTagName('Description')[0] || {}).textContent || '').replace(/\s+/g, ' ').trim()
      const parameters = Array.from(new Set(Array.from(script.matchAll(/\{\s*parameter\s+"([^"]+)"(?:\s+of\s+action)?\s*\}/gi), (m) => m[1])))
      return { parameters, description, script }
    } catch (e) {
      return { parameters: [], description: '', script: '' }
    }
  }

  const xmlEscape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

  // The console's Take Action dialog, simplified: targets (applicable computers, or custom relevance), parameters,
  // secure parameters, a title. Deploy creates a SourcedFixletAction with the REST API (POST /api/actions) and
  // resolves with the new action id; Cancel resolves with null.
  function takeAction(req) {
    return new Promise(async (resolve) => {
      if (dialogOpen) {
        log('WARN', req.kind + ': another dialog is open')
        resolve(null)
        return
      }
      const fixlet = await findFixlet(req.fixletID, req.siteID)
      if (!fixlet) {
        reportAlert(req.kind + ': no fixlet or task ' + req.fixletID + ' in site ' + req.siteID)
        resolve(null)
        return
      }
      const details = await actionDetails(req.fixletID, fixlet, req.contentID)
      const applicable = await first('(id of it, name of it) of applicable computers of bes fixlets whose (id of it = ' + req.fixletID + ' and ' + fixlet.where + ')')
      let computers = applicable.map((r) => ({ id: Number(r[0]), name: r[1] }))
      if (req.computerIDs) computers = computers.filter((c) => req.computerIDs.includes(c.id)) // the console shows the given computers that are also relevant
      const paramNames = Array.from(new Set(Object.keys(req.parameters).concat(details.parameters)))
      const secureNames = req.secureParameters ? Object.keys(req.secureParameters) : []
      const inputs = {}
      const secureInputs = {}
      const checks = []
      let titleInput
      let relevanceInput
      let mode = 'computers'
      openDialog(
        'Take Action: ' + fixlet.name,
        (body) => {
          body.append(el('p', { className: 'wrr-small', textContent: 'Site "' + fixlet.site + '", ' + fixlet.type + ' ' + req.fixletID + ', action ' + req.contentID + (details.description ? ': ' + details.description : '') + '. Deploying creates a real BigFix action, as the console would.' }))
          if (details.missing) body.append(el('p', { className: 'wrr-error-text', textContent: 'The ' + fixlet.type + ' has no action with id "' + req.contentID + '".' }))
          titleInput = el('input', { type: 'text', className: 'cd-input', value: fixlet.name })
          body.append(el('label', { className: 'cd-field' }, ['Action title', titleInput]))
          if (paramNames.length || secureNames.length) {
            const box = el('fieldset', { className: 'cd-fieldset' }, [el('legend', { textContent: 'Parameters' })])
            paramNames.forEach((n) => {
              inputs[n] = el('input', { type: 'text', className: 'cd-input', value: req.parameters[n] !== undefined ? String(req.parameters[n]) : '' })
              box.append(el('label', { className: 'cd-field' }, [n, inputs[n]]))
            })
            secureNames.forEach((n) => {
              secureInputs[n] = el('input', { type: 'password', className: 'cd-input', value: String(req.secureParameters[n]) })
              box.append(el('label', { className: 'cd-field' }, [n + ' (secure)', secureInputs[n]]))
            })
            body.append(box)
          }
          const targets = el('fieldset', { className: 'cd-fieldset' }, [el('legend', { textContent: 'Targets' })])
          const radio = (value, label) => {
            const r = el('input', { type: 'radio', name: 'cd-target', value, checked: value === mode })
            r.addEventListener('change', () => (mode = value))
            return el('label', { className: 'cd-inline' }, [r, ' ' + label])
          }
          targets.append(radio('computers', 'Specific computers (' + computers.length + ' applicable' + (req.computerIDs ? ' of the ' + req.computerIDs.length + ' given' : '') + ')'))
          const list = el('div', { className: 'cd-list' })
          computers.slice(0, 1000).forEach((c) => {
            const box = el('input', { type: 'checkbox', checked: !!req.computerIDs })
            box.value = String(c.id)
            checks.push(box)
            list.append(el('label', { className: 'cd-list-item' }, [box, ' ' + c.name + ' (' + c.id + ')']))
          })
          if (!computers.length) list.append(el('p', { className: 'wrr-small', textContent: 'No applicable computers.' }))
          targets.append(list)
          targets.append(radio('relevance', 'Computers that match this relevance'))
          relevanceInput = el('input', { type: 'text', className: 'cd-input', value: '' })
          relevanceInput.placeholder = 'for example: false'
          targets.append(relevanceInput)
          body.append(targets)
        },
        [
          {
            label: 'Cancel',
            onClick: () => {
              closeDialog()
              log('CONSOLE', req.kind + ' cancelled')
              resolve(null)
            }
          },
          {
            label: 'Deploy',
            primary: true,
            id: 'cd-deploy',
            onClick: async () => {
              const ids = checks.filter((c) => c.checked).map((c) => c.value)
              const relevance = relevanceInput.value.trim()
              if (mode === 'computers' && !ids.length) return dialogError('Choose at least one computer.')
              if (mode === 'relevance' && !relevance) return dialogError('Enter the relevance that selects the targets.')
              const target = mode === 'computers' ? ids.map((id) => '<ComputerID>' + id + '</ComputerID>').join('') : '<CustomRelevance>' + xmlEscape(relevance) + '</CustomRelevance>'
              const params = Object.keys(inputs)
                .map((n) => '<Parameter Name="' + xmlEscape(n) + '">' + xmlEscape(inputs[n].value) + '</Parameter>')
                .join('')
              const secure = Object.keys(secureInputs)
                .map((n) => '<SecureParameter Name="' + xmlEscape(n) + '">' + xmlEscape(secureInputs[n].value) + '</SecureParameter>')
                .join('')
              const xml =
                '<?xml version="1.0" encoding="UTF-8"?><BES xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="BES.xsd"><SourcedFixletAction><SourceFixlet><Sitename>' +
                xmlEscape(fixlet.site) + '</Sitename><FixletID>' + req.fixletID + '</FixletID><Action>' + xmlEscape(req.contentID) + '</Action></SourceFixlet><Target>' + target + '</Target>' + params + secure +
                '<Title>' + xmlEscape(titleInput.value || fixlet.name) + '</Title></SourcedFixletAction></BES>'
              $('cd-deploy').disabled = true
              dialogError('')
              try {
                const response = await fetch('/api/sdk/passthrough/api/actions', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/xml', Accept: 'application/xml', 'X-XSRF-TOKEN': xsrf() }, body: xml })
                const text = await response.text()
                const id = (/<ID>(\d+)<\/ID>/.exec(text) || [])[1]
                if (!response.ok || !id) {
                  let msg = text
                  try {
                    msg = JSON.parse(text).message || text
                  } catch (e) {
                    // XML or text
                  }
                  log('CONSOLE', req.kind + ' failed: HTTP ' + response.status + ' ' + String(msg).replace(/\s+/g, ' ').slice(0, 300))
                  dialogError('BigFix refused the action: ' + String(msg).replace(/\s+/g, ' ').slice(0, 400))
                  $('cd-deploy').disabled = false
                  return
                }
                closeDialog()
                log('CONSOLE', req.kind + ': created action ' + id + ' (' + (mode === 'computers' ? ids.length + ' computers' : 'custom relevance') + ', ' + Object.keys(inputs).length + ' parameters' + (secure ? ', ' + Object.keys(secureInputs).length + ' secure' : '') + ')')
                resolve(Number(id))
              } catch (err) {
                dialogError(String(err))
                $('cd-deploy').disabled = false
              }
            }
          }
        ]
      )
    })
  }

  async function showComputerGroup(ids, title) {
    if (dialogOpen) closeDialog()
    const rows = ids.length ? await first('(id of it, name of it, (operating system of it | ""), (last report time of it as string | "")) of bes computers whose (set of (' + ids.join('; ') + ') contains id of it)') : []
    openDialog(
      title,
      (body) => {
        body.append(el('p', { className: 'wrr-small', textContent: ids.length + ' computer id(s), ' + rows.length + ' found. WebUI has no ad hoc computer group page; each name opens the computer in WebUI.' }))
        const table = el('table', { className: 'cd-table' })
        table.append(el('tr', {}, ['Computer', 'ID', 'OS', 'Last report'].map((h) => el('th', { textContent: h }))))
        rows.forEach((r) => {
          const link = el('a', { href: '/framework/devices/' + r[0], target: '_blank', rel: 'noopener', textContent: r[1] })
          table.append(el('tr', {}, [el('td', {}, [link]), el('td', { textContent: r[0] }), el('td', { textContent: r[2] }), el('td', { textContent: r[3] })]))
        })
        body.append(table)
      },
      [{ label: 'Close', primary: true, onClick: closeDialog }]
    )
  }

  // ImportXML(..., openDocuments): open the new items in WebUI (the console opens their documents)
  async function openDocuments(ids, kind) {
    for (const id of ids.slice(0, 3)) {
      if (kind === 'action') window.open('/framework/deployments/' + id, '_blank', 'noopener')
      else {
        const win = window.open('', '_blank')
        const name = (await first('names of bes fixlets whose (id of it = ' + id + ')'))[0] || ''
        if (win) win.location.href = '/custom/tasks?search=' + encodeURIComponent(JSON.stringify({ query: name }))
      }
    }
  }

  // external.OpenWizard(siteID, dashboardID): this app, in a new tab, showing that dashboard
  function openWizard(siteID, dashboardID) {
    const url = location.pathname + '#dashboard=' + encodeURIComponent(dashboardID) + (siteID && String(siteID) !== 'null' ? '&siteid=' + encodeURIComponent(siteID) : '')
    log('CONSOLE', 'OpenWizard(' + siteID + ', ' + dashboardID + ') -> new tab')
    return window.open(url, '_blank')
  }

  // ---- "current wizard" ------------------------------------------------------------------------------------
  // relevance.js rewrites "current wizard" to (bes wizard whose (dashboard id of it = "<id>")). Through WebUI (BES
  // Explorer answering, 11.0.7) that wizard only exists for a dashboard in a site; an id that only has dashboard
  // variables is not a "bes wizard", and its variables can't be read with relevance. So the forms dashboards use are
  // answered here first, from the SDK's dashboard-variable API (which also knows the operator's private variables):
  //   private / shared variable(s) "X" of current wizard  -> the value as a string literal, or a nonexistent string
  //   dashboard id / name / link of current wizard, exists current wizard
  const relString = (s) => '"' + String(s).replace(/%/g, '%25').replace(/"/g, '%22') + '"'
  function variablesSync(id) {
    const xhr = new XMLHttpRequest()
    xhr.open('GET', '/api/sdk/dashboardvariable/' + encodeURIComponent(id), false)
    xhr.setRequestHeader('Accept', 'application/json')
    xhr.setRequestHeader('X-XSRF-TOKEN', xsrf())
    try {
      xhr.send()
    } catch (e) {
      return []
    }
    if (xhr.status !== 200) return [] // 404: no variables
    try {
      const value = JSON.parse(xhr.responseText).value
      return Array.isArray(value) ? value : value ? [value] : []
    } catch (e) {
      return []
    }
  }
  function rewriteCurrentWizard(expr) {
    if (!currentDashboardId || !/\bcurrent\s+wizard\b/i.test(expr)) return expr
    let vars = null
    let r = expr.replace(/\b(private|shared)\s+variables?\s+"([^"]*)"\s+of\s+current\s+wizard\b/gi, (m, kind, name) => {
      if (vars === null) vars = variablesSync(currentDashboardId)
      const wantPrivate = kind.toLowerCase() === 'private'
      const hit = vars.find((v) => v.Name === name && (String(v.IsPrivate) === 'true') === wantPrivate)
      // a missing variable is a nonexistent string: "exists" gives False, and using it gives the console's
      // "Singular expression refers to nonexistent object" (the wizard itself may not exist as a "bes wizard")
      return hit ? relString(hit.Value === undefined ? '' : hit.Value) : '(substring after "a" of "b")'
    })
    const name = wizard ? wizard.name : currentDashboardId
    r = r
      .replace(/\bdashboard\s+id\s+of\s+current\s+wizard\b/gi, relString(currentDashboardId))
      .replace(/\bname\s+of\s+current\s+wizard\b/gi, relString(name))
      .replace(/\bexists\s+current\s+wizard\b/gi, 'true')
      .replace(/\blink\s+of\s+current\s+wizard\b/gi, 'html ' + relString('<a href="linkid:openwizard(null,' + currentDashboardId + ')">' + escapeHtml(name) + '</a>'))
    return r
  }

  // What console-shim.js in the dashboard frame calls
  window.WRR = {
    log,
    alert: reportAlert,
    get options() {
      return { webReportsContext: $('opt-wrcontext').checked, dashboardId: currentDashboardId, rewrite: rewriteCurrentWizard }
    },
    console: {
      options,
      wantsActiveX: () => wantsActiveX,
      userName: () => userName,
      scratch,
      takeAction,
      showComputerGroup,
      openDocuments,
      openWizard,
      goToPage: (name) => goToPage(name),
      refreshSection: (id) => {
        const matches = sections.map((s, n) => (id === null || s.id === id ? n : -1)).filter((n) => n >= 0)
        if (!matches.length) log('WARN', 'ManualRefresh("' + id + '"): no <?BeginRefreshRelevance?> section with that id')
        matches.forEach((n) => refreshOne(n))
      },
      signal: sendSignal
    }
  }

  // ---- choosing a dashboard ---------------------------------------------------------------------------------

  function chooseFile(file) {
    if (!file) return
    current = { name: file.name, id: file.name, from: 'uploaded file', getText: () => file.text(), source: null, site: null }
    $('cd-dashboard').value = ''
    $('wrr-file-name').textContent = 'from ' + file.name + ' (' + file.size.toLocaleString() + ' bytes)'
    $('wrr-rerender').disabled = false
    history.replaceState(null, '', location.pathname)
    load()
  }

  let dashboards = []
  const keyOf = (d) => d.site + '\n' + d.id
  function showDashboards() {
    const select = $('cd-dashboard')
    const selected = select.value
    const external = $('opt-external').checked
    select.textContent = ''
    const empty = document.createElement('option')
    empty.value = ''
    select.appendChild(empty)
    const bySite = new Map()
    dashboards
      .filter((d) => external || d.siteType !== 'external')
      .forEach((d) => bySite.set(d.site, (bySite.get(d.site) || []).concat(d)))
    let shown = 0
    Array.from(bySite.keys())
      .sort((a, b) => a.localeCompare(b))
      .forEach((site) => {
        const group = document.createElement('optgroup')
        group.label = site
        bySite
          .get(site)
          .sort((a, b) => a.name.localeCompare(b.name))
          .forEach((d) => {
            const o = document.createElement('option')
            o.value = keyOf(d)
            o.textContent = d.name
            o.title = d.id
            group.appendChild(o)
            shown++
          })
        select.appendChild(group)
      })
    const hidden = dashboards.length - shown
    empty.textContent = shown ? 'Choose one of ' + shown + ' dashboard' + (shown === 1 ? '' : 's') + '...' : 'No dashboards in custom sites (see External sites)'
    if (selected && Array.from(select.options).some((o) => o.value === selected)) select.value = selected
    select.disabled = !dashboards.length
    $('wrr-site-status').textContent = dashboards.length + ' dashboards in sites' + (hidden ? ', ' + hidden + ' in external sites hidden' : '') + '.'
  }

  function chooseDashboard(d) {
    current = {
      name: d.id,
      id: d.id,
      from: 'site "' + d.site + '"',
      site: d.site,
      source: null,
      getText: async () => {
        const opened = await window.CDDASH.open(d)
        current.source = opened.source
        return opened.text
      }
    }
    $('wrr-file').value = ''
    $('wrr-file-name').textContent = 'from site ' + d.site
    $('wrr-rerender').disabled = false
    history.replaceState(null, '', location.pathname + '#dashboard=' + encodeURIComponent(d.id) + '&site=' + encodeURIComponent(d.site))
    load()
  }

  async function loadDashboards() {
    $('cd-reload').disabled = true
    try {
      const started = performance.now()
      dashboards = await window.CDDASH.listDashboards()
      log('INFO', 'bes wizards: ' + dashboards.length + ' dashboards in ' + new Set(dashboards.map((d) => d.site)).size + ' sites (' + Math.round(performance.now() - started) + 'ms)')
      showDashboards()
    } catch (err) {
      log('WARN', 'dashboard list failed: ' + err.message)
      $('wrr-site-status').textContent = 'The dashboard list could not be read: ' + err.message
    }
    $('cd-reload').disabled = false
  }

  // #dashboard=<file>&site=<site name> or &siteid=<id> (OpenWizard, links to this app)
  async function fromHash() {
    const params = new URLSearchParams(location.hash.slice(1))
    const id = params.get('dashboard')
    if (!id) return
    let site = params.get('site')
    const siteId = params.get('siteid')
    if (!site && siteId && /^\d+$/.test(siteId)) site = (await first('names of bes sites whose (exists (id of it) whose (it = ' + siteId + '))'))[0]
    const match = dashboards.find((d) => d.id.toLowerCase() === id.toLowerCase() && (!site || d.site === site)) || dashboards.find((d) => d.id.toLowerCase() === id.toLowerCase())
    if (!match) {
      setStatus('No dashboard "' + id + '"' + (site ? ' in site "' + site + '"' : '') + ' was found in the sites you can see.', true)
      return
    }
    if (match.siteType === 'external') $('opt-external').checked = true
    showDashboards()
    $('cd-dashboard').value = keyOf(match)
    chooseDashboard(match)
  }

  // ---- wiring ---------------------------------------------------------------------------------------------

  $('wrr-file').addEventListener('change', (e) => chooseFile(e.target.files[0]))
  $('wrr-rerender').addEventListener('click', () => (wizard && pageName ? renderPage(pageName) : load()))
  $('cd-dashboard').addEventListener('change', (e) => {
    const d = dashboards.find((x) => keyOf(x) === e.target.value)
    if (d) chooseDashboard(d)
  })
  $('cd-reload').addEventListener('click', loadDashboards)
  $('opt-external').addEventListener('change', showDashboards)
  $('cd-page').addEventListener('change', (e) => goToPage(e.target.value))
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

  const stage = $('wrr-stage')
  const isFull = () => document.fullscreenElement === stage || stage.classList.contains('wrr-maximized')
  async function enterFullScreen() {
    try {
      await stage.requestFullscreen()
    } catch (err) {
      stage.classList.add('wrr-maximized')
      log('INFO', 'the browser refused full screen (' + err.message + '); the dashboard covers the window instead (Exit or Esc leaves)')
    }
    $('wrr-exit-fullscreen').focus()
  }
  function exitFullScreen() {
    if (document.fullscreenElement === stage) document.exitFullscreen().catch(() => {})
    stage.classList.remove('wrr-maximized')
  }
  $('wrr-fullscreen').addEventListener('click', () => (isFull() ? exitFullScreen() : enterFullScreen()))
  $('wrr-exit-fullscreen').addEventListener('click', exitFullScreen)
  const onKey = (e) => {
    if (e.key !== 'Escape') return
    if (stage.classList.contains('wrr-maximized')) exitFullScreen()
  }
  document.addEventListener('keydown', onKey)
  $('btn-copy-report').addEventListener('click', () => copy(buildReport(), 'Report'))
  $('btn-copy-log').addEventListener('click', () => copy(redact(lines.join('\n')), 'Log'))
  $('btn-clear-log').addEventListener('click', () => {
    lines.length = 0
    $('log-text').value = ''
    $('log-count').textContent = '0'
  })
  window.addEventListener('error', (e) => log('JSERR', 'page: ' + e.message))

  // Dashboards restyle their page; a style a dashboard sets on this page's <html> or <body> through window.parent is
  // undone (as in the Web Reports Renderer)
  function keepStyle(node) {
    const original = node.getAttribute('style')
    new MutationObserver(() => {
      const now = node.getAttribute('style')
      if (now === original) return
      log('INFO', 'the dashboard set style="' + (now || '').slice(0, 120) + '" on this page\'s <' + node.tagName.toLowerCase() + '>; undone')
      if (original === null) node.removeAttribute('style')
      else node.setAttribute('style', original)
    }).observe(node, { attributes: true, attributeFilter: ['style'] })
  }
  keepStyle(document.documentElement)
  keepStyle(document.body)

  log('INFO', 'Console Dashboards ' + VERSION + ' loaded')
  window.WebUIRelevance.onChange((api, s) =>
    log(s.webReports ? 'WARN' : 'INFO', 'relevance through the ' + (api === 'sdk' ? 'SDK' : 'REST') + ' API is now answered by ' + window.WebUIRelevance.sourceName(api) + (s.decodes ? '; it decodes %xx once more, so % is sent as %25' : '') + (s.webReports ? ' (bes wizards and site files may be missing there)' : ''))
  )
  startShell()
  showScratch()
  librariesReady = loadLibraries()
  loadDashboards().then(fromHash)
  window.addEventListener('hashchange', fromHash)
})()
