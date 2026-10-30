// Relevance Query: a BigFix WebUI extension in plain HTML/JS (no framework, no build step).
// Session relevance runs through POST /api/sdk/sessionrelevance/evaluate (needs "Can use WebUI" and Web Reports).
// Client relevance runs as a BigFix Query: POST /api/sdk/clientquery, then GET /api/sdk/clientqueryresults/{id}.
// bigfix-relevance-analyzer (analyzer.js) loads in the background. Until it is up, or if it fails, every query runs
// as session relevance from the plain text box. Once it is up, the editor replaces the text box and "Auto" mode runs
// client relevance, session relevance, or both, based on the dialect the analyzer detects.
// Results are written with textContent only, never innerHTML, because relevance results can contain HTML.
'use strict'
;(function (SRQ) {
  // rendering very large results freezes the browser; limit the relevance itself for big queries
  const MAX_ROWS_RENDERED = 1000
  const KEEPALIVE_MS = 30000
  const CLIENT_POLL_MS = 3000
  const CLIENT_POLL_LIMIT_MS = 60000

  // ---- WebUI request helpers ----------------------------------------------------------------
  // Same behavior as the template's BfHttpClient: session cookies, XSRF header, redirect when the session expires.

  function getCookie(name) {
    const match = document.cookie.split('; ').find((cookie) => cookie.startsWith(name + '='))
    return match ? decodeURIComponent(match.slice(name.length + 1)) : undefined
  }

  function redirectToLogin() {
    window.location.href = '/timeout?nextpage=' + encodeURIComponent(window.location.pathname + window.location.search)
  }

  // Resolves to the parsed JSON (or text) body; rejects with an Error carrying the server's message.
  async function webuiFetch(url, { method = 'GET', json, signal } = {}) {
    const headers = { Accept: 'application/json' }
    const xsrfToken = getCookie('XSRF-TOKEN')
    if (xsrfToken) headers['X-XSRF-TOKEN'] = xsrfToken
    if (json !== undefined) headers['Content-Type'] = 'application/json'

    const response = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers,
      body: json !== undefined ? JSON.stringify(json) : undefined,
      signal
    })

    if (response.status === 401 || response.headers.get('iem-login-required')) {
      redirectToLogin()
      throw new Error('Session expired, redirecting to login')
    }

    const text = await response.text()
    let body
    try {
      body = text ? JSON.parse(text) : null
    } catch (e) {
      body = text
    }

    if (!response.ok) {
      throw new Error((body && body.message) || (typeof body === 'string' && body) || response.status + ' ' + response.statusText)
    }
    return body
  }

  const evaluateSession = (relevance, signal) =>
    webuiFetch('/api/sdk/sessionrelevance/evaluate', { method: 'POST', json: { session_relevance: relevance }, signal })

  // ---- Shell: user name and session keep-alive (what BfApp does, minus the WebUI nav) --------

  function startShell() {
    webuiFetch('/me')
      .then((me) => {
        if (me && me.userName) document.getElementById('shell-user').textContent = me.userName
      })
      .catch(() => {
        // the user name is cosmetic; the page still works without it
      })

    // WebUI sessions time out when idle; WebUI's own pages ping /loggedin every 30 seconds
    setInterval(() => webuiFetch('/loggedin').catch(() => {}), KEEPALIVE_MS)
  }

  // ---- small DOM helpers --------------------------------------------------------------------

  const $ = (id) => document.getElementById(id)

  function el(tag, text, className) {
    const node = document.createElement(tag)
    if (text !== undefined && text !== null) node.textContent = text
    if (className) node.className = className
    return node
  }

  function table(headers, rows, rowClass) {
    const t = el('table', null, 'srq-table')
    const headRow = el('tr')
    headers.forEach((h) => headRow.appendChild(el('th', h)))
    const thead = el('thead')
    thead.appendChild(headRow)
    t.appendChild(thead)
    // build off-DOM, then attach once, so large results don't trigger a reflow per row
    const body = document.createDocumentFragment()
    rows.forEach((row, i) => {
      const tr = el('tr', null, rowClass ? rowClass(i) : '')
      row.forEach((cell) => tr.appendChild(el('td', String(cell))))
      body.appendChild(tr)
    })
    const tbody = el('tbody')
    tbody.appendChild(body)
    t.appendChild(tbody)
    const wrap = el('div', null, 'srq-table-wrap')
    wrap.appendChild(t)
    return wrap
  }

  // the session API returns an array of results; a tuple query returns each row as an array of columns
  function normalizeRows(response) {
    const rows = Array.isArray(response) ? response : response && response.value
    if (!Array.isArray(rows)) return []
    return rows.map((row) => (Array.isArray(row) ? row : [row]))
  }

  const toTsv = (rows) => rows.map((row) => row.map((cell) => String(cell)).join('\t')).join('\n')
  const idList = (text) =>
    String(text || '')
      .split(/[\s,;]+/)
      .filter((s) => /^\d+$/.test(s))
      .map(Number)

  // ---- Query UI -----------------------------------------------------------------------------

  function startQueryUi() {
    const input = $('srq-input')
    const evaluateButton = $('srq-evaluate')
    const copyButton = $('srq-copy')
    const mode = $('srq-mode')
    const targets = $('srq-targets')

    let analyzer = null // set when analyzer.js finishes loading
    let editor = null // the analyzer's CodeMirror editor, mounted over the text box
    let runToken = 0 // bumped on every run; older runs stop updating the page
    let sessionAbort = null
    let copyRows = null // the most recent result rows, for Copy as TSV
    let running = 0

    const getQuery = () => (editor ? editor.getText() : input.value)
    const setQuery = (text) => {
      if (editor) editor.setText(text)
      else input.value = text
      updateButtons()
    }

    function updateButtons() {
      evaluateButton.disabled = running > 0 || getQuery().trim() === ''
      copyButton.disabled = !copyRows || copyRows.length === 0
    }

    function section(id, title) {
      const box = $(id)
      box.replaceChildren(el('h2', title, 'srq-section-title'))
      box.hidden = false
      return box
    }

    function note(box, text, className) {
      box.appendChild(el('p', text, className || 'srq-note'))
    }

    // ---- analysis panel ----

    function dialectOf(payload) {
      const d = payload && payload.dialect
      return (d && (d.resolved || d.classified)) || null
    }

    function renderAnalysis(payload) {
      const box = section('srq-analysis', 'Analysis')
      const badges = el('div', null, 'srq-badges')
      const badge = (text, ok) => badges.appendChild(el('span', text, 'srq-badge ' + (ok === true ? 'srq-ok' : ok === false ? 'srq-bad' : '')))
      const dialect = dialectOf(payload)
      badge('dialect: ' + (dialect || 'undetermined'), dialect === 'uncertain' ? false : dialect ? true : null)
      badge('parse: ' + (payload.parse.ok ? 'ok' : 'error'), payload.parse.ok)
      badge('types: ' + (payload.types ? (payload.types.ok ? 'ok' : 'error') : 'n/a'), payload.types ? payload.types.ok : null)
      if (payload.complexity) badge('complexity ' + payload.complexity.score + ', cost ' + payload.complexity.evaluation_cost)
      box.appendChild(badges)

      if (!payload.parse.ok && payload.parse.error) {
        const e = payload.parse.error
        note(box, 'Parse error at line ' + e.line + ', column ' + e.column + ': ' + e.message, 'srq-note srq-error-text')
      }
      const diagnostics = (payload.types && payload.types.diagnostics) || []
      if (diagnostics.length) {
        box.appendChild(table(['at', 'code', 'message'], diagnostics.map((d) => [d.line + ':' + d.column, d.code, d.message])))
      }
      if (payload.unknown_references && payload.unknown_references.length) {
        note(box, 'Unknown inspectors: ' + payload.unknown_references.join(', '))
      }
      if (payload.autofix && payload.autofix.fixed) {
        const row = el('div', null, 'srq-fix')
        row.appendChild(el('span', 'Suggested fix: '))
        row.appendChild(el('code', payload.autofix.fixed))
        const apply = el('button', 'Apply fix', 'srq-button')
        apply.type = 'button'
        apply.addEventListener('click', () => setQuery(payload.autofix.fixed))
        row.appendChild(apply)
        box.appendChild(row)
      }
    }

    // ---- session relevance ----

    async function runSession(query, token) {
      const box = section('srq-session', 'Session relevance')
      const spinner = el('div', null, 'srq-spinner')
      box.appendChild(spinner)
      if (sessionAbort) sessionAbort.abort()
      const controller = new AbortController()
      sessionAbort = controller
      const started = Date.now()
      try {
        const rows = normalizeRows(await evaluateSession(query, controller.signal))
        if (token !== runToken) return
        spinner.remove()
        const columns = rows.reduce((max, row) => Math.max(max, row.length), 1)
        const shown = rows.slice(0, MAX_ROWS_RENDERED)
        note(box, rows.length + ' result' + (rows.length === 1 ? '' : 's') + ' in ' + (Date.now() - started) + ' ms' + (rows.length > MAX_ROWS_RENDERED ? ' (showing first ' + MAX_ROWS_RENDERED + ')' : ''))
        const headers = ['#'].concat(Array.from({ length: columns }, (_, i) => 'item ' + i))
        box.appendChild(table(headers, shown.map((row, i) => [i + 1].concat(Array.from({ length: columns }, (_, c) => (c < row.length ? row[c] : ''))))))
        copyRows = rows
      } catch (err) {
        if (err.name === 'AbortError' || token !== runToken) return
        spinner.remove()
        note(box, err.message || 'Unknown error evaluating session relevance', 'srq-note srq-error-text')
      }
    }

    // ---- client relevance (BigFix Query) ----

    async function runClient(query, token) {
      const box = section('srq-client', 'Client relevance (BigFix Query)')
      const ids = idList(targets.value)
      if (!ids.length) {
        note(box, 'Enter one or more target computer ids above, or use "Use the 5 most recently reporting computers".', 'srq-note srq-error-text')
        return
      }
      const status = el('p', 'Sending to ' + ids.length + ' computer' + (ids.length === 1 ? '' : 's') + '...', 'srq-note')
      box.appendChild(status)
      const spinner = el('div', null, 'srq-spinner')
      box.appendChild(spinner)
      let results = null
      const started = Date.now()
      try {
        const submitted = await webuiFetch('/api/sdk/clientquery', {
          method: 'POST',
          json: { ClientQuery: { ApplicabilityRelevance: 'true', QueryText: query, Target: { ComputerID: ids } } }
        })
        const queryId = submitted && submitted.id
        if (!queryId) throw new Error('the server did not return a query id')

        // poll until every target answered or the time limit passes; render whatever has arrived each time
        while (token === runToken) {
          const reply = await webuiFetch('/api/sdk/clientqueryresults/' + queryId + '?stats=1')
          if (token !== runToken) return
          const value = (reply && reply.value) || {}
          const rows = Array.isArray(value.results) ? value.results : []
          const answered = Number(value.reportingAgents) || 0
          const seconds = Math.round((Date.now() - started) / 1000)
          status.textContent = answered + ' of ' + ids.length + ' computer' + (ids.length === 1 ? '' : 's') + ' answered, ' + rows.length + ' result' + (rows.length === 1 ? '' : 's') + ' after ' + seconds + 's (query id ' + queryId + ')'
          if (results) results.remove()
          results = table(
            ['Computer', 'Computer ID', 'Result', 'Error', 'Response ms'],
            rows.map((r) => [r.computerName, r.computerID, r.result, r.isFailure ? 'yes' : '', r.ResponseTime]),
            (i) => (rows[i].isFailure ? 'srq-failure' : '')
          )
          box.appendChild(results)
          copyRows = rows.map((r) => [r.computerName, r.computerID, r.result, r.isFailure])
          updateButtons()
          if (answered >= ids.length || Date.now() - started > CLIENT_POLL_LIMIT_MS) break
          await new Promise((resolve) => setTimeout(resolve, CLIENT_POLL_MS))
        }
        if (token !== runToken) return
        spinner.remove()
        if (Date.now() - started > CLIENT_POLL_LIMIT_MS) note(box, 'Stopped waiting after ' + CLIENT_POLL_LIMIT_MS / 1000 + 's. Computers that are offline or slow to report do not answer BigFix Queries.')
      } catch (err) {
        if (token !== runToken) return
        spinner.remove()
        note(box, err.message || 'Unknown error running the BigFix Query', 'srq-note srq-error-text')
      }
    }

    // ---- choose what to run ----

    async function evaluate() {
      const query = getQuery().trim()
      if (!query) return
      const token = ++runToken
      copyRows = null
      ;['srq-analysis', 'srq-session', 'srq-client', 'srq-route'].forEach((id) => ($(id).hidden = true))

      let routes
      const routeBox = $('srq-route')
      const say = (text, isError) => {
        routeBox.textContent = text
        routeBox.className = 'srq-route' + (isError ? ' srq-error-text' : '')
        routeBox.hidden = false
      }

      const payload = analyzer ? analyzer.analyze(query) : null
      if (payload) renderAnalysis(payload)

      if (mode.value === 'session') routes = ['session']
      else if (mode.value === 'client') routes = ['client']
      else if (!payload) {
        routes = ['session']
        say('The analyzer is not loaded yet, so this ran as session relevance.')
      } else if (!payload.parse.ok) {
        routes = []
        say('Not run: the statement does not parse. Fix it, or choose Session or Client under Mode to run it anyway.', true)
      } else {
        const dialect = dialectOf(payload)
        routes = { session: ['session'], client: ['client'], both: ['session', 'client'] }[dialect] || []
        if (!routes.length) say('Not run: the analyzer could not tell whether this is client or session relevance (' + (dialect || 'undetermined') + '). Choose Session or Client under Mode.', true)
        else say('Auto: the analyzer says this is ' + (dialect === 'both' ? 'valid as both client and session' : dialect) + ' relevance.')
      }

      running++
      updateButtons()
      try {
        await Promise.all(routes.map((route) => (route === 'session' ? runSession(query, token) : runClient(query, token))))
      } finally {
        running--
        updateButtons()
      }
    }

    // ---- analyzer: load in the background, then swap in the editor ----

    function analyzerStatus(text, className) {
      const s = $('srq-analyzer-status')
      s.textContent = text
      s.className = 'srq-analyzer-status ' + (className || '')
    }

    function startAnalyzer() {
      if (typeof SRQ.loadAnalyzer !== 'function') {
        analyzerStatus('Analyzer not included in this build: running session relevance only.', 'srq-muted')
        return
      }
      analyzerStatus('Analyzer: loading in the background. Queries run as session relevance until it is ready.', 'srq-muted')
      SRQ.loadAnalyzer((progress) => analyzerStatus('Analyzer: ' + progress + '... (queries run as session relevance until it is ready)', 'srq-muted'))
        .then((loaded) => {
          analyzer = loaded
          const host = $('srq-editor')
          editor = loaded.mountEditor(host, { doc: input.value, onRun: () => evaluateButton.disabled || evaluate() })
          editor.connect(loaded.handle)
          editor.view.dom.addEventListener('keyup', updateButtons)
          input.hidden = true
          host.hidden = false
          mode.disabled = false
          analyzerStatus('Analyzer ' + loaded.version + ' ready (' + (loaded.loadMs / 1000).toFixed(1) + 's). Auto picks client or session relevance; the editor checks as you type.', 'srq-ready')
        })
        .catch((err) => {
          mode.value = 'session'
          mode.disabled = false
          analyzerStatus('Analyzer unavailable (' + err.message + '): running session relevance only. Choose Client under Mode for a BigFix Query.', 'srq-error-text')
        })
    }

    // Fills the BigFix Query targets with the computers that reported most recently: offline computers never answer.
    // Session relevance cannot sort, so fetch (id, seconds since last report) and sort here. The window starts at an
    // hour to keep the result small on big deployments, and widens to a day if fewer than TARGET_COUNT reported.
    const TARGET_COUNT = 5
    async function fillTarget() {
      try {
        let rows = []
        for (const window of ['1 * hour', '1 * day']) {
          const res = await evaluateSession('(id of it, (now - last report time of it) / second) of bes computers whose (now - last report time of it < ' + window + ')')
          rows = normalizeRows(res)
          if (rows.length >= TARGET_COUNT) break
        }
        const ids = rows
          .map((r) => ({ id: r[0], age: Number(r[1]) }))
          .sort((a, b) => a.age - b.age)
          .slice(0, TARGET_COUNT)
          .map((r) => r.id)
        if (ids.length && !targets.value.trim()) targets.value = ids.join(', ')
      } catch (e) {
        // optional convenience; the user can type ids
      }
    }

    evaluateButton.addEventListener('click', evaluate)
    input.addEventListener('input', updateButtons)
    // Ctrl+Enter / Cmd+Enter evaluates without leaving the keyboard (the editor has its own binding)
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        if (!evaluateButton.disabled) evaluate()
      }
    })
    copyButton.addEventListener('click', () => {
      if (copyRows && navigator.clipboard) navigator.clipboard.writeText(toTsv(copyRows))
    })
    $('srq-fill-target').addEventListener('click', () => {
      targets.value = ''
      fillTarget()
    })

    updateButtons()
    fillTarget()
    startAnalyzer()
  }

  startShell()
  startQueryUi()
})(window.SRQ || (window.SRQ = {}))
