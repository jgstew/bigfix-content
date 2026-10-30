// SDK API Tester - page wiring: shell header, results table, manual-test buttons, and input helpers.
'use strict'
;(function (SAT) {
  const KEEPALIVE_MS = 30000

  // Errors outside tests still end up in the copied report
  window.addEventListener('error', (e) => SAT.log('JSERR', e.message + ' at ' + (e.filename || '?') + ':' + e.lineno + ':' + e.colno))
  window.addEventListener('unhandledrejection', (e) => SAT.log('JSERR', 'unhandled rejection: ' + SAT.errText(e.reason)))

  const $ = (id) => document.getElementById(id)
  const el = (tag, text, className) => {
    const node = document.createElement(tag)
    if (text !== undefined) node.textContent = text
    if (className) node.className = className
    return node
  }

  // ---- shell: user name and keep-alive, same as session-relevance-query-html ----------------------

  async function startShell() {
    SAT.sensitive.add(location.host)
    SAT.sensitive.add(location.hostname)
    const me = await SAT.api('GET', '/me')
    if (me.ok && me.json && me.json.userName) {
      SAT.sensitive.add(me.json.userName)
      $('shell-user').textContent = me.json.userName
    }
    setInterval(() => fetch('/loggedin', { credentials: 'same-origin' }).catch(() => {}), KEEPALIVE_MS)
  }

  // ---- results table ----------------------------------------------------------------------------

  function renderResults() {
    const body = document.createDocumentFragment()
    let group = null
    SAT.tests.forEach((test) => {
      if (test.group !== group) {
        group = test.group
        const tr = el('tr', undefined, 'sat-group')
        const td = el('td', group)
        td.colSpan = 6
        tr.appendChild(td)
        body.appendChild(tr)
      }
      const tr = el('tr')
      tr.id = 'row-' + test.id
      tr.appendChild(el('td', '-', 'sat-badge sat-NONE'))
      const name = el('td')
      name.appendChild(el('div', test.title))
      name.appendChild(el('code', test.id, 'sat-id'))
      tr.appendChild(name)
      tr.appendChild(el('td', test.api || '(WebUI)', 'sat-api'))
      tr.appendChild(el('td', test.safe ? '' : 'manual: use the card below', 'sat-msg'))
      tr.appendChild(el('td', ''))
      const action = el('td')
      if (test.safe) {
        const button = el('button', 'Run', 'sat-button sat-button-small')
        button.type = 'button'
        button.addEventListener('click', () => SAT.runIds([test.id], test.id))
        action.appendChild(button)
      }
      tr.appendChild(action)
      body.appendChild(tr)
    })
    $('results-body').replaceChildren(body)
  }

  SAT.onResult = function (result) {
    const tr = $('row-' + result.id)
    if (!tr) return
    const cells = tr.children
    cells[0].textContent = result.status
    cells[0].className = 'sat-badge sat-' + result.status
    cells[3].textContent = result.msg
    cells[4].textContent = String(result.ms)
  }

  SAT.onProgress = (text) => ($('run-status').textContent = text)

  // ---- input helpers ----------------------------------------------------------------------------

  async function loadCustomSites() {
    const select = $('in-site-select')
    const res = await SAT.evaluate('names of bes custom sites')
    const names = res.ok && res.json && Array.isArray(res.json.value) ? res.json.value : []
    const options = [el('option', names.length ? 'choose a custom site' : 'no custom sites found')]
    options[0].value = ''
    names.sort((a, b) => a.localeCompare(b)).forEach((n) => {
      const o = el('option', n)
      o.value = n
      options.push(o)
    })
    select.replaceChildren(...options)
  }

  // Picks a computer that reported in the last hour: a BigFix Query sent to an offline computer never gets an answer
  // (the lowest id is often a long-dead machine). Falls back to any computer if none reported recently.
  async function fillComputerId(targetId) {
    let id = await SAT.evaluateFirst('minimum of ids of bes computers whose (now - last report time of it < 1 * hour)')
    let how = 'a computer that reported in the last hour'
    if (!id) {
      id = await SAT.evaluateFirst('minimum of ids of bes computers')
      how = 'the lowest computer id (none reported in the last hour, so a BigFix Query may get no answer)'
    }
    if (id) $(targetId).value = id
    SAT.log('INFO', id ? 'Filled ' + targetId + ' with ' + how : 'No computers found')
  }

  async function fillAnalysis() {
    const local = '(custom site flag of it or master site flag of it or operator site flag of it)'
    const analysisId = await SAT.evaluateFirst('minimum of ids of bes fixlets whose (analysis flag of it and ' + local + ' of site of it)')
    // custom and operator sites have no site id; the console's wizard API took the master action site id for them
    const siteId = await SAT.evaluateFirst('ids of bes sites whose (master site flag of it)')
    if (analysisId) $('in-ana-id').value = analysisId
    if (siteId) $('in-ana-site').value = siteId
    SAT.log('INFO', 'Analysis lookup: analysis ' + (analysisId || 'none found') + ', master action site id ' + (siteId || 'none found'))
  }

  // ---- wiring -----------------------------------------------------------------------------------

  function wire() {
    $('btn-run-safe').addEventListener('click', () => SAT.runSafe())
    $('btn-copy-report-top').addEventListener('click', () => SAT.copyReport())
    $('btn-copy-report').addEventListener('click', () => SAT.copyReport())
    $('btn-copy-log').addEventListener('click', () => SAT.copyLog())
    $('btn-clear-log').addEventListener('click', () => SAT.clearLog())
    $('btn-content').addEventListener('click', () => SAT.runContentLifecycle())
    $('btn-opimport').addEventListener('click', () => SAT.runOperatorImport())
    $('btn-cq').addEventListener('click', () => SAT.runClientQuery())
    $('btn-fill-analysis').addEventListener('click', () => fillAnalysis())
    document.querySelectorAll('[data-run]').forEach((button) => button.addEventListener('click', () => SAT.runIds([button.dataset.run], button.dataset.run)))
    document.querySelectorAll('[data-fill="computer"]').forEach((button) => button.addEventListener('click', () => fillComputerId(button.dataset.target)))
  }

  renderResults()
  wire()
  SAT.log('INFO', 'SDK API Tester ' + SAT.VERSION + ' loaded: ' + SAT.tests.length + ' tests (' + SAT.tests.filter((t) => t.safe).length + ' safe) covering ' + SAT.API_OPERATIONS.length + ' SDK operations')
  startShell()
  loadCustomSites()
})(window.SAT)
