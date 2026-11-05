// Destructive Device Actions: send one destructive action (actions.js) to one device picked from a searchable list.
//   1. list every computer with session relevance (name, ID, last report time, OS, agent type); devices the chosen
//      action doesn't apply to are hidden or shown greyed out
//   2. on a device's button, reload the list and check the device still has the same name, then open a confirmation
//      with its details; the action is only sent after a ticket number or reason is entered
//   3. build the action from its template for exactly that computer ID, post it through the REST passthrough
//      (POST api/actions), and show its ID, a link to it in WebUI, and its status on request
'use strict'
;(function () {
  const VERSION = '0.1.0'
  const MAX_ROWS = 200
  const STALE_DAYS = 7
  const DAY_MS = 24 * 60 * 60 * 1000

  const api = window.WebUIApi
  const DDA = window.DDA
  const $ = (id) => document.getElementById(id)

  // ID first: the only value that can't be missing. Values come back as strings.
  const DEVICE_RELEVANCE =
    '(id of it, (name of it | ""), ((it as string) of last report time of it | ""), (operating system of it | ""), (agent type of it | "")) of bes computers'

  let devices = []
  let nameCounts = new Map()
  let loadedAt = null
  let sent = [] // { actionId, device, action } for the report
  let confirming = null // { action, device }

  const log = window.WebUILog.create({
    title: 'BigFix Destructive Device Actions',
    version: VERSION,
    header: () => [
      'Devices loaded: ' + devices.length + (loadedAt ? ' at ' + loadedAt.toISOString() : ''),
      'Actions sent: ' + (sent.map((s) => s.action.id + ' ' + s.actionId + ' -> computer ' + s.device.id).join(', ') || 'none')
    ]
  })

  const currentAction = () => DDA.ACTIONS.find((a) => a.id === $('action-select').value) || DDA.ACTIONS[0]
  const nameKey = (name) => String(name).toLowerCase()

  function el(tag, props, children) {
    const node = document.createElement(tag)
    Object.assign(node, props || {})
    ;(children || []).forEach((c) => node.append(c))
    return node
  }

  // ---- device list ----------------------------------------------------------------------------------

  async function loadDevices() {
    $('list-status').textContent = 'Loading devices...'
    $('btn-refresh').disabled = true
    const res = await api.evaluate(DEVICE_RELEVANCE)
    $('btn-refresh').disabled = false
    if (!res.ok) {
      $('list-status').textContent = 'Could not load devices: ' + res.message
      log.log('ERROR', 'Device list failed: ' + res.message)
      return false
    }
    devices = res.rows
      .filter((row) => Array.isArray(row) && row.length === 5)
      .map(([id, name, lastReport, os, agentType]) => ({ id: String(id), name, lastReport, lastReportMs: Date.parse(lastReport) || 0, os, agentType }))
    nameCounts = new Map()
    devices.forEach((d) => nameCounts.set(nameKey(d.name), (nameCounts.get(nameKey(d.name)) || 0) + 1))
    loadedAt = new Date()

    const agentTypes = {}
    devices.forEach((d) => (agentTypes[d.agentType || '(none)'] = (agentTypes[d.agentType || '(none)'] || 0) + 1))
    log.log('INFO', 'Loaded ' + devices.length + ' devices in ' + res.ms + 'ms; agent types: ' + Object.keys(agentTypes).map((k) => k + ' ' + agentTypes[k]).join(', '))
    render()
    return true
  }

  function lastReportText(device) {
    if (!device.lastReportMs) return device.lastReport || 'never'
    const days = Math.floor((Date.now() - device.lastReportMs) / DAY_MS)
    return device.lastReport + (days >= 1 ? ' (' + days + ' day' + (days === 1 ? '' : 's') + ' ago)' : '')
  }

  function render() {
    const action = currentAction()
    const term = $('device-search').value.trim().toLowerCase()
    const showNa = $('show-na').checked
    const matches = devices
      .filter((d) => !term || d.name.toLowerCase().includes(term) || d.id.includes(term))
      .map((d) => ({ device: d, why: action.notApplicable(d) }))
    const shown = matches
      .filter((m) => showNa || !m.why)
      .sort((a, b) => a.device.name.localeCompare(b.device.name, undefined, { sensitivity: 'base' }) || b.device.lastReportMs - a.device.lastReportMs)
    const applicable = matches.filter((m) => !m.why).length

    const body = $('device-rows')
    body.textContent = ''
    shown.slice(0, MAX_ROWS).forEach(({ device, why }) => {
      const nameCell = el('td', {}, [device.name || '(no name)'])
      const duplicates = nameCounts.get(nameKey(device.name)) || 0
      if (duplicates > 1) nameCell.append(' ', el('span', { className: 'dda-badge', textContent: duplicates + ' devices have this name' }))
      const last = el('td', { textContent: lastReportText(device) })
      if (device.lastReportMs && Date.now() - device.lastReportMs > STALE_DAYS * DAY_MS) last.className = 'dda-stale'
      const actionCell = el('td')
      if (why) {
        actionCell.append(el('span', { className: 'dda-muted', textContent: 'Not applicable: ' + why }))
      } else {
        const button = el('button', { type: 'button', className: 'dda-button dda-button-danger', textContent: action.verb + '...' })
        button.addEventListener('click', () => openConfirm(action, device.id))
        actionCell.append(button)
      }
      const row = el('tr', { className: why ? 'dda-na' : '' }, [nameCell, el('td', { textContent: device.id }), last, el('td', { textContent: device.os }), el('td', { textContent: device.agentType }), actionCell])
      body.append(row)
    })

    $('list-status').textContent =
      devices.length + ' devices' + (term ? ', ' + matches.length + ' match the search' : '') + '; "' + action.label + '" applies to ' + applicable + (term ? ' of them' : '') + (loadedAt ? '. Loaded ' + loadedAt.toLocaleTimeString() : '')
    const more = $('list-more')
    more.hidden = shown.length <= MAX_ROWS && shown.length > 0
    more.textContent = shown.length ? 'Showing ' + MAX_ROWS + ' of ' + shown.length + '. Search to narrow the list.' : 'No devices match.'
  }

  // ---- confirmation ---------------------------------------------------------------------------------

  async function openConfirm(action, deviceId) {
    const before = devices.find((d) => d.id === deviceId)
    // the list may be minutes old: reload it so the details, the name check and the duplicate count are current
    if (!(await loadDevices())) return
    const device = devices.find((d) => d.id === deviceId)
    if (!device) {
      showResult('error', 'Computer ' + deviceId + ' is no longer in the list. Nothing was sent.')
      return
    }
    if (before && before.name !== device.name) {
      showResult('error', 'Computer ' + deviceId + ' is now named "' + device.name + '", not "' + before.name + '". Nothing was sent; check the device and pick it again.')
      return
    }
    const why = action.notApplicable(device)
    if (why) {
      showResult('error', action.label + ' no longer applies to ' + device.name + ': ' + why + '. Nothing was sent.')
      return
    }

    confirming = { action, device }
    $('confirm-title').textContent = action.verb + ' ' + (device.name || 'computer ' + device.id) + '?'
    $('confirm-warning').textContent = action.warning
    const facts = $('confirm-facts')
    facts.textContent = ''
    ;[
      ['Action', action.label],
      ['Computer name', device.name],
      ['Computer ID', device.id],
      ['Last report', lastReportText(device)],
      ['OS', device.os],
      ['Agent type', device.agentType]
    ].forEach(([k, v]) => facts.append(el('dt', { textContent: k }), el('dd', { textContent: v || 'unknown' })))

    const cautions = []
    const duplicates = nameCounts.get(nameKey(device.name)) || 0
    if (duplicates > 1) cautions.push(duplicates + ' devices are named "' + device.name + '". Only computer ID ' + device.id + ' gets the action; check it is the right one.')
    if (!device.lastReportMs) cautions.push('This device has never reported, so it may never get the action.')
    else if (Date.now() - device.lastReportMs > STALE_DAYS * DAY_MS) cautions.push('This device last reported more than ' + STALE_DAYS + ' days ago. The action waits until it checks in, and runs then.')
    $('confirm-cautions').hidden = !cautions.length
    $('confirm-cautions').textContent = cautions.join(' ')

    $('confirm-reason').value = ''
    $('confirm-error').hidden = true
    $('confirm-send').textContent = action.verb + ' ' + (device.name || device.id)
    updateConfirm()
    log.log('INFO', 'Confirming ' + action.id + ' for computer ' + device.id)
    $('confirm').showModal()
    $('confirm-cancel').focus()
  }

  let previewToken = 0
  async function updateConfirm() {
    if (!confirming) return
    const reason = $('confirm-reason').value
    const ok = DDA.reasonOk(reason)
    $('confirm-send').disabled = !ok
    $('confirm-reason-hint').classList.toggle('dda-error-text', !ok && reason.length > 0)
    const token = ++previewToken
    if (!ok) {
      $('confirm-xml').textContent = '(enter a ticket number or reason to see the action)'
      return
    }
    try {
      const xml = await DDA.build(confirming.action, confirming.device, reason)
      if (token === previewToken) $('confirm-xml').textContent = xml
    } catch (err) {
      if (token === previewToken) $('confirm-xml').textContent = 'Cannot build the action: ' + err.message
    }
  }

  async function send() {
    if (!confirming || !DDA.reasonOk($('confirm-reason').value)) return
    const { action, device } = confirming
    const reason = DDA.cleanReason($('confirm-reason').value)
    const button = $('confirm-send')
    button.disabled = true
    button.textContent = 'Sending...'
    $('confirm-error').hidden = true

    let xml
    try {
      xml = await DDA.build(action, device, reason)
    } catch (err) {
      return confirmFailed(err.message)
    }
    log.log('INFO', 'Sending ' + action.id + ' to computer ' + device.id + ', reason: ' + reason)
    const res = await api.passthrough('POST', 'api/actions', { body: xml, contentType: 'application/xml' })
    const actionId = res.ok ? api.xmlField(res.text, 'ID') : ''
    if (!res.ok) return confirmFailed('The server did not create the action: ' + res.message)
    if (!/^\d+$/.test(actionId)) {
      // created or not, the answer has no action ID: say so rather than guess
      log.log('WARN', 'Action posted, but the response has no action ID: ' + api.snippet(res.text, 300))
    }

    confirming = null
    $('confirm').close()
    sent.push({ actionId: actionId || '?', device, action })
    log.log('INFO', 'Action ' + (actionId || '(no ID in response)') + ' created for computer ' + device.id)
    showSent(action, device, actionId)
  }

  function confirmFailed(message) {
    log.log('ERROR', message)
    $('confirm-error').textContent = message + (/[.!?]$/.test(message) ? ' ' : '. ') + 'Check Deployments in WebUI before you retry.'
    $('confirm-error').hidden = false
    $('confirm-send').textContent = 'Retry'
    $('confirm-send').disabled = !DDA.reasonOk($('confirm-reason').value)
  }

  // ---- results --------------------------------------------------------------------------------------

  function showResult(kind, message, extra) {
    const box = $('result')
    box.className = 'dda-result dda-result-' + kind
    box.textContent = ''
    box.append(el('p', { textContent: message }), ...(extra || []))
    box.hidden = false
    if (kind === 'error') log.log('WARN', message)
  }

  function showSent(action, device, actionId) {
    const extra = []
    if (/^\d+$/.test(actionId)) {
      const status = el('p', { className: 'dda-muted', textContent: '' })
      const check = el('button', { type: 'button', className: 'dda-button', textContent: 'Check status' })
      check.addEventListener('click', () => checkStatus(actionId, status))
      extra.push(el('div', { className: 'dda-row' }, [el('a', { href: '/framework/deployments/' + actionId, textContent: 'Open action ' + actionId + ' in WebUI' }), check]), status)
    } else {
      extra.push(el('p', { textContent: 'The response had no action ID; look for the action in WebUI before trying again.' }))
    }
    showResult('sent', action.label + ' sent to ' + device.name + ' (computer ' + device.id + ')' + (actionId ? ' as action ' + actionId : '') + '.', extra)
  }

  // GET api/action/<id>/status: <ActionResults> with the action's <Status> and one <Computer> per target, which has
  // its own <Status>.
  async function checkStatus(actionId, target) {
    target.textContent = 'Checking...'
    const res = await api.passthrough('GET', 'api/action/' + actionId + '/status')
    if (!res.ok) {
      target.textContent = 'Could not read the status: ' + res.message
      return
    }
    const doc = new DOMParser().parseFromString(res.text, 'application/xml')
    const results = doc.getElementsByTagName('ActionResults')[0]
    const overall = results && Array.from(results.children).find((c) => c.tagName === 'Status')
    const computers = Array.from(doc.getElementsByTagName('Computer')).map((c) => {
      const status = Array.from(c.children).find((x) => x.tagName === 'Status')
      return (c.getAttribute('Name') || c.getAttribute('ID') || 'computer') + ': ' + (status ? status.textContent : 'no status yet')
    })
    target.textContent = 'Action ' + (overall ? overall.textContent : 'status unknown') + '. ' + (computers.join('; ') || 'No computer has reported on it yet.') + ' (checked ' + new Date().toLocaleTimeString() + ')'
    log.log('INFO', 'Status of action ' + actionId + ': ' + target.textContent)
  }

  // ---- start ----------------------------------------------------------------------------------------

  function start() {
    DDA.ACTIONS.forEach((a) => $('action-select').append(el('option', { value: a.id, textContent: a.label })))
    $('action-select').addEventListener('change', render)
    $('device-search').addEventListener('input', render)
    $('show-na').addEventListener('change', render)
    $('btn-refresh').addEventListener('click', loadDevices)
    $('confirm-reason').addEventListener('input', updateConfirm)
    $('confirm-reason').addEventListener('keydown', (e) => {
      // Enter must never send a destructive action
      if (e.key === 'Enter') e.preventDefault()
    })
    $('confirm-send').addEventListener('click', send)
    $('confirm').addEventListener('close', () => (confirming = null))
    $('btn-copy-report').addEventListener('click', log.copyReport)
    $('btn-copy-log').addEventListener('click', log.copyLog)
    $('btn-clear-log').addEventListener('click', log.clear)

    api.startSession((user) => {
      $('shell-user').textContent = user
      log.addSensitive(user)
    })
    log.log('INFO', 'Destructive Device Actions ' + VERSION)
    loadDevices()
  }

  start()
})()
