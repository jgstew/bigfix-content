// Session Relevance Query: a BigFix WebUI extension in plain HTML/JS (no framework, no build step).
// Calls only POST /api/sdk/sessionrelevance/evaluate, which needs "Can use WebUI" and BigFix Web Reports.
// Results are written with textContent only, never innerHTML, because relevance results can contain HTML.
'use strict'
;(function () {
  // rendering very large results freezes the browser; limit the relevance itself for big queries
  const MAX_ROWS_RENDERED = 1000
  const KEEPALIVE_MS = 30000

  const EXAMPLE_QUERIES = [
    'number of bes computers',
    '(id of it, name of it, operating system of it, last report time of it) of bes computers',
    '(name of it, number of fixlets of it) of bes sites',
    '(name of it, id of it) of bes computer groups',
    '(name of it, master flag of it) of bes users'
  ]

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

  // ---- Session relevance query UI -----------------------------------------------------------

  // the API returns an array of results; a tuple query returns each row as an array of columns
  function normalizeRows(response) {
    const rows = Array.isArray(response) ? response : response && response.value
    if (!Array.isArray(rows)) return []
    return rows.map((row) => (Array.isArray(row) ? row : [row]))
  }

  function toTsv(rows) {
    return rows.map((row) => row.map((cell) => String(cell)).join('\t')).join('\n')
  }

  function el(tag, text) {
    const node = document.createElement(tag)
    if (text !== undefined) node.textContent = text
    return node
  }

  function startQueryUi() {
    const input = document.getElementById('srq-input')
    const evaluateButton = document.getElementById('srq-evaluate')
    const copyButton = document.getElementById('srq-copy')
    const spinner = document.getElementById('srq-spinner')
    const errorBox = document.getElementById('srq-error')
    const errorText = document.getElementById('srq-error-text')
    const resultBox = document.getElementById('srq-result')
    const summary = document.getElementById('srq-summary')
    const caption = document.getElementById('srq-caption')
    const thead = document.getElementById('srq-thead')
    const tbody = document.getElementById('srq-tbody')
    const examples = document.getElementById('srq-examples')

    let currentRows = null
    let inFlight = null

    EXAMPLE_QUERIES.forEach((query) => {
      const button = el('button', query)
      button.type = 'button'
      button.className = 'srq-example'
      button.title = query
      button.addEventListener('click', () => {
        input.value = query
        updateButtons()
        input.focus()
      })
      examples.appendChild(button)
    })

    function updateButtons() {
      evaluateButton.disabled = inFlight !== null || input.value.trim() === ''
      copyButton.disabled = !currentRows || currentRows.length === 0
    }

    function showError(message) {
      errorText.textContent = message
      errorBox.hidden = false
      resultBox.hidden = true
    }

    function showRows(rows, query, elapsedMs) {
      const columnCount = rows.reduce((max, row) => Math.max(max, row.length), 1)
      const shown = rows.slice(0, MAX_ROWS_RENDERED)

      summary.textContent =
        rows.length + ' result' + (rows.length === 1 ? '' : 's') + ' in ' + elapsedMs + ' ms' +
        (rows.length > MAX_ROWS_RENDERED ? ' (showing first ' + MAX_ROWS_RENDERED + ')' : '')
      caption.textContent = query

      const headRow = el('tr')
      headRow.appendChild(el('th', '#'))
      for (let i = 0; i < columnCount; i++) headRow.appendChild(el('th', 'item ' + i))
      thead.replaceChildren(headRow)

      // build off-DOM, then swap in once, so large results don't trigger a reflow per row
      const body = document.createDocumentFragment()
      shown.forEach((row, rowIndex) => {
        const tr = el('tr')
        tr.appendChild(el('td', String(rowIndex + 1)))
        for (let i = 0; i < columnCount; i++) tr.appendChild(el('td', i < row.length ? String(row[i]) : ''))
        body.appendChild(tr)
      })
      tbody.replaceChildren(body)

      errorBox.hidden = true
      resultBox.hidden = false
    }

    async function evaluate() {
      const query = input.value.trim()
      if (!query) return

      if (inFlight) inFlight.abort()
      const controller = new AbortController()
      inFlight = controller
      spinner.hidden = false
      updateButtons()
      const started = Date.now()

      try {
        const response = await webuiFetch('/api/sdk/sessionrelevance/evaluate', {
          method: 'POST',
          json: { session_relevance: query },
          signal: controller.signal
        })
        currentRows = normalizeRows(response)
        showRows(currentRows, query, Date.now() - started)
      } catch (err) {
        // a newer query replaced this one; it owns the UI now
        if (err.name === 'AbortError') return
        currentRows = null
        showError(err.message || 'Unknown error evaluating session relevance')
      }

      if (inFlight === controller) inFlight = null
      spinner.hidden = true
      updateButtons()
    }

    evaluateButton.addEventListener('click', evaluate)
    input.addEventListener('input', updateButtons)
    // Ctrl+Enter / Cmd+Enter evaluates without leaving the keyboard
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        evaluate()
      }
    })
    copyButton.addEventListener('click', () => {
      if (currentRows && navigator.clipboard) navigator.clipboard.writeText(toTsv(currentRows))
    })

    updateButtons()
  }

  startShell()
  startQueryUi()
})()
