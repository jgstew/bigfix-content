// Console Dashboards - the BigFix console's wizard / dashboard JavaScript API, inside the dashboard iframe.
// Loaded after the shared Web Reports layer (webui-relevance.js, relevance.js, shim.js), which already provides
// EvaluateRelevance, Relevance, AsyncEvaluateString, the dashboard-variable functions, WR.*, linkid: links for
// computers, actions and fixlets, and the window.onerror / CSP logging. This file adds the rest of what the console
// gives a dashboard (its wizards.js, plus window.external), mapped onto the WebUI SDK and the platform REST API
// through the SDK passthrough, or onto a stand-in in this app's page where WebUI has nothing equivalent.
//
// The console's functions are synchronous (ImportXML returns the new ids, StopAction returns true, ...), so the
// mapped calls use synchronous XMLHttpRequest, as the shared layer's EvaluateRelevance does. The few that are
// asynchronous in the console (TakeFixletAction, the callback forms) stay asynchronous.
//
// Anything that changes BigFix asks first (window.confirm) while "Ask before changes" is on in Config; that stands in
// for the console's password prompt. Cancelling returns what the console returns for a cancel (undefined / false).
//
// The page side (app.js) is parent.WRR: log(level, msg) and console: { ... } (page navigation, refresh sections,
// the scratch folder, the Take Action dialog, computer groups, opening other dashboards).
'use strict'
;(function () {
  const host = (window.parent && window.parent !== window && window.parent.WRR) || null
  const page = (host && host.console) || null
  const log = (level, msg) => {
    if (host) host.log(level, msg)
  }
  const R = window.WRREL

  // ---- requests -----------------------------------------------------------------------------------------

  const xsrf = () => window.WebUIRelevance.xsrfToken()

  // Synchronous request: { status, ok, text, json }. opts: json (object body), body (string), contentType
  function requestSync(method, url, opts = {}) {
    const xhr = new XMLHttpRequest()
    xhr.open(method, url, false)
    xhr.setRequestHeader('Accept', 'application/json, application/xml;q=0.9, text/plain;q=0.8')
    xhr.setRequestHeader('X-XSRF-TOKEN', xsrf())
    let body = opts.body
    if (opts.json !== undefined) {
      body = JSON.stringify(opts.json)
      xhr.setRequestHeader('Content-Type', 'application/json')
    } else if (opts.contentType) xhr.setRequestHeader('Content-Type', opts.contentType)
    try {
      xhr.send(body === undefined ? null : body)
    } catch (e) {
      return { status: 0, ok: false, text: String(e), json: null }
    }
    return shape(xhr.status, xhr.responseText)
  }

  async function request(method, url, opts = {}) {
    const headers = { Accept: 'application/json, application/xml;q=0.9, text/plain;q=0.8', 'X-XSRF-TOKEN': xsrf() }
    let body = opts.body
    if (opts.json !== undefined) {
      body = JSON.stringify(opts.json)
      headers['Content-Type'] = 'application/json'
    } else if (opts.contentType) headers['Content-Type'] = opts.contentType
    try {
      const response = await fetch(url, { method, credentials: 'same-origin', headers, body })
      return shape(response.status, await response.text())
    } catch (e) {
      return { status: 0, ok: false, text: String(e), json: null }
    }
  }

  function shape(status, text) {
    let json = null
    try {
      json = text ? JSON.parse(text) : null
    } catch (e) {
      // XML or plain text
    }
    return { status, ok: status >= 200 && status < 300, text, json }
  }

  const message = (res) => (res.json && res.json.message) || String(res.text || '').replace(/\s+/g, ' ').slice(0, 300) || 'HTTP ' + res.status
  const short = (s) => (String(s).length > 160 ? String(s).slice(0, 160) + '...' : String(s))

  function fail(name, res) {
    const msg = name + ' failed: ' + message(res)
    log('CONSOLE', msg)
    const err = new Error(msg)
    err.description = msg
    throw err
  }

  // The platform REST API through the SDK passthrough (needs "Can use REST API"); uri is relative to /api/
  const restUrl = (uri) => '/api/sdk/passthrough/api/' + String(uri).replace(/^\/+/, '').replace(/^api\//, '')

  // First value of a relevance result, or fallback (synchronous, through the shared layer's typed/SDK evaluation)
  function relevanceSync(expr, fallback) {
    try {
      const r = window.EvaluateRelevance(expr)
      return r
    } catch (e) {
      return fallback
    }
  }
  const asList = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : typeof v === 'object' && typeof v.length === 'number' ? Array.from(v) : [v])
  const idsFrom = (v) =>
    asList(v)
      .map((x) => (typeof x === 'object' && x && 'fixletID' in x ? x.fixletID : x))
      .map((x) => Number(String(x).trim()))
      .filter((n) => Number.isFinite(n))

  // Stands in for the console's password prompt before changes
  function approve(what) {
    const ask = page ? page.options().askBeforeChanges : true
    if (!ask) {
      log('CONSOLE', 'change (not asked; Ask before changes is off): ' + what)
      return true
    }
    const ok = window.confirm('This dashboard wants to make a change in BigFix:\n\n' + what + '\n\nAllow it? (Console Dashboards asks because WebUI has no console password prompt; turn this off under Config.)')
    log('CONSOLE', (ok ? 'allowed: ' : 'cancelled: ') + what)
    return ok
  }

  // Changes the console would signal to RegisterRefreshHandler / RegisterRelevance
  function changed(signal) {
    if (page) page.signal(signal)
    reevaluateRegistered()
  }

  // ---- utility div and predefined element ids ------------------------------------------------------------
  // InsertUtilityDiv() adds hidden elements whose ids the console's helper functions use to talk to its host (the
  // ids a dashboard must not reuse). Here the functions don't need them, but dashboards read some of them
  // (theRegisterRefreshSignalName, theScratchFileResult), so they exist, and are added on load if no one asked.
  const UTILITY_IDS = [
    'BrowseData', 'ButtonBrowse', 'theBrowseExtension', 'theBrowseFilters', 'theBrowseForFolderFlag', 'theBrowseInitialPath', 'theBrowseResultCancelFlag', 'theBrowseResultFullPath',
    'LoadPresentationData', 'ButtonLoadPresentation', 'thePresentationPath', 'thePresentationResult',
    'RegisterRefreshHandlerData', 'ButtonRegisterRefreshHandler', 'theRegisterRefreshElementID', 'theRegisterRefreshSignalName',
    'ScratchFileOpsData', 'ButtonScratchFileOps', 'theScratchFileOperation', 'theScratchFileInputPath', 'theScratchFileOutputPath', 'theScratchFileRecurseFlag', 'theScratchFileResult',
    'StopActionData', 'theStopActionIDList', 'theStopActionSuccessFlag',
    'ActivateAnalysisData', 'theActivateAnalysisIDList', 'theActivateAnalysisDeactivateFlag', 'theActivateAnalysisReactivateFlag', 'theActivateAnalysisSuccessFlag',
    'ConnectionInfoData', 'GetConnectionInfo', 'theConnectionInfoCurrentDSN', 'theConnectionInfoCurrentUser'
  ]
  window.InsertUtilityDiv = function () {
    if (document.getElementById('TheUtilityScripts')) return
    const div = document.createElement('div')
    div.id = 'TheUtilityScripts'
    div.style.display = 'none'
    UTILITY_IDS.forEach((id) => {
      const el = document.createElement('div')
      el.id = id
      div.appendChild(el)
    })
    ;(document.body || document.documentElement).appendChild(div)
  }
  document.addEventListener('DOMContentLoaded', () => window.InsertUtilityDiv())
  const setUtility = (id, value) => {
    const el = document.getElementById(id)
    if (el) el.innerHTML = String(value)
  }

  // ---- importing, editing and deleting content -------------------------------------------------------------

  const ACTION_TYPES = ['SingleAction', 'MultipleActionGroup', 'SourcedFixletAction']
  const RESOURCE_TYPES = { Fixlet: 'fixlet', Task: 'task', Analysis: 'analysis', Baseline: 'baseline', ComputerGroup: 'computergroup' }

  // The object elements under <BES>: ["Task"], ["SingleAction"], ...
  function besObjects(xml) {
    const doc = new DOMParser().parseFromString(String(xml), 'application/xml')
    if (doc.getElementsByTagName('parsererror').length) return null
    const root = doc.documentElement
    return Array.from(root.children).map((el) => el.tagName)
  }

  // New ids from an import response: the SDK answers JSON {value: {BESAPI: {Task: {Name, ID}}}} (an array when
  // several were imported); the REST API answers BESAPI XML with <ID> elements
  function importedIds(res) {
    const ids = []
    const walk = (v) => {
      if (Array.isArray(v)) v.forEach(walk)
      else if (v && typeof v === 'object') {
        if (v.ID !== undefined && /^\d+$/.test(String(v.ID))) ids.push(Number(v.ID))
        else Object.keys(v).forEach((k) => walk(v[k]))
      }
    }
    if (res.json) walk(res.json.value !== undefined ? res.json.value : res.json)
    if (!ids.length) String(res.text).replace(/<ID>(\d+)<\/ID>/g, (m, id) => ids.push(Number(id)))
    return ids
  }

  // ImportXML(xml, openDocuments, customSiteName, computerIDs): returns an array of the new ids, in order, or undefined
  // when cancelled, and throws on an error. Content goes to the custom site, or to the operator's own site (the master
  // action site for a master operator); actions (SingleAction, MultipleActionGroup, SourcedFixletAction) are created
  // through the REST API's POST /api/actions, which is what importing an action does in the console. computerIDs only
  // restricts the console's Take Action dialog, which an import here never shows; it is logged and ignored.
  window.ImportXML = function (xml, openDocuments, siteName, computerIDs) {
    const objects = besObjects(xml)
    if (!objects) fail('ImportXML', { text: 'the XML does not parse' })
    const isAction = objects.some((t) => ACTION_TYPES.includes(t))
    const where = isAction ? 'as an action' : siteName ? 'into custom site "' + siteName + '"' : 'into your operator site (the master action site for a master operator)'
    if (!approve('Import ' + (objects.join(', ') || 'BES XML') + ' ' + where)) return undefined
    if (computerIDs) log('CONSOLE', 'ImportXML computerIDs (' + asList(computerIDs).length + ') ignored: WebUI shows no Take Action dialog for an import')
    const res = isAction
      ? requestSync('POST', restUrl('actions'), { body: String(xml), contentType: 'application/xml' })
      : requestSync('POST', siteName ? '/api/sdk/site/custom/' + encodeURIComponent(siteName) + '/import' : '/api/sdk/site/operator/import', { body: String(xml), contentType: 'application/xml' })
    if (!res.ok) fail('ImportXML', res)
    const ids = importedIds(res)
    log('CONSOLE', 'ImportXML ' + where + ' -> ids ' + ids.join(', '))
    changed(isAction ? 'Actions' : 'CustomContent')
    if (openDocuments !== false && page) page.openDocuments(ids, isAction ? 'action' : 'content')
    return ids
  }

  window.ImportXMLToSite = (xml, customSiteName, openDocuments) => window.ImportXML(xml, openDocuments, customSiteName)

  // The SDK's resource type for a content id, from session relevance (custom, master action and operator sites)
  function resourceTypes(ids) {
    const types = {}
    if (!ids.length) return types
    const set = 'set of (' + ids.join('; ') + ')'
    const local = '(custom site flag of site of it or master site flag of site of it or operator site flag of site of it)'
    asList(relevanceSync('(id of it, (if task flag of it then "task" else if analysis flag of it then "analysis" else if baseline flag of it then "baseline" else "fixlet")) of bes fixlets whose (' + set + ' contains id of it and ' + local + ')', [])).forEach((row) => {
      const [id, type] = String(row).split(', ')
      types[id] = type
    })
    asList(relevanceSync('ids of bes computer groups whose (' + set + ' contains id of it and ' + local + ')', [])).forEach((id) => (types[String(id)] = 'computergroup'))
    return types
  }

  // EditFixlet(fixletID, xml): replaces a custom fixlet, task, analysis, baseline or computer group
  window.EditFixlet = function (fixletID, xml) {
    const objects = besObjects(xml) || []
    const type = RESOURCE_TYPES[objects[0]]
    if (!type) fail('EditFixlet', { text: 'the XML has no Fixlet, Task, Analysis, Baseline or ComputerGroup element' })
    if (!approve('Edit ' + type + ' ' + fixletID)) {
      const err = new Error('UserCancelled')
      err.description = 'UserCancelled' // the console throws when its password prompt is cancelled
      throw err
    }
    const res = requestSync('PUT', '/api/sdk/resources/' + type + '/' + Number(fixletID) + '/edit', { body: String(xml), contentType: 'application/xml' })
    if (!res.ok) fail('EditFixlet', res)
    log('CONSOLE', 'EditFixlet ' + type + ' ' + fixletID + ' -> ' + res.status)
    changed('CustomContent')
    return true
  }

  // DeleteFixlet(id) / DeleteFixlets([ids]): POST /api/sdk/resources/{type}/delete, grouped by type
  window.DeleteFixlets = function (fixletIDs) {
    const ids = idsFrom(fixletIDs)
    if (!ids.length) return false
    const types = resourceTypes(ids)
    const unknown = ids.filter((id) => !types[String(id)])
    if (unknown.length) log('WARN', 'DeleteFixlets: no custom content with id ' + unknown.join(', ') + ' (only custom, master action site and operator site content can be deleted)')
    const known = ids.filter((id) => types[String(id)])
    if (!known.length) return false
    if (!approve('Permanently delete ' + known.map((id) => types[String(id)] + ' ' + id).join(', '))) return false
    const byType = {}
    known.forEach((id) => (byType[types[String(id)]] = (byType[types[String(id)]] || []).concat(id)))
    Object.keys(byType).forEach((type) => {
      const res = requestSync('POST', '/api/sdk/resources/' + type + '/delete', { json: { ids: byType[type] } })
      if (!res.ok) fail('DeleteFixlets', res)
      log('CONSOLE', 'deleted ' + type + ' ' + byType[type].join(', '))
    })
    changed('CustomContent')
    return true
  }
  window.DeleteFixlet = (fixletID) => window.DeleteFixlets([fixletID])

  // DeleteProperty(id) / DeleteProperties([ids]): the REST API's DELETE /api/property/{id} (master operators only)
  window.DeleteProperties = function (propertyIDs) {
    const ids = idsFrom(propertyIDs)
    if (!ids.length || !approve('Permanently delete global propert' + (ids.length === 1 ? 'y ' : 'ies ') + ids.join(', '))) return false
    ids.forEach((id) => {
      const res = requestSync('DELETE', restUrl('property/' + id))
      if (!res.ok) fail('DeleteProperty', res)
      log('CONSOLE', 'deleted property ' + id)
    })
    changed('CustomContent')
    return true
  }
  window.DeleteProperty = (propertyID) => window.DeleteProperties([propertyID])

  // CreateCustomSite(siteName): POST /api/sdk/site/custom (the console's rules: no quote or newline, no trailing space,
  // at most 32 bytes)
  window.CreateCustomSite = function (siteName) {
    const name = String(siteName)
    if (!name || /["\n]/.test(name) || / $/.test(name) || new TextEncoder().encode(name).length > 32) fail('CreateCustomSite', { text: 'invalid custom site name "' + name + '"' })
    if (!approve('Create custom site "' + name + '"')) return false
    const res = requestSync('POST', '/api/sdk/site/custom', { json: { siteName: name } })
    if (!res.ok) fail('CreateCustomSite', res)
    log('CONSOLE', 'created custom site "' + name + '"')
    return true
  }

  // ---- taking actions ----------------------------------------------------------------------------------------
  // The console opens its Take Action dialog. WebUI has no dialog a page can open (bfcore-react's hook is internal),
  // so this app's page shows one: targets, the action's parameters, and a title. Deploying creates a
  // SourcedFixletAction through the REST API's POST /api/actions, then calls callback(actionID) like the console.
  // These return at once, as in the console (its dialog is non-modal).
  function takeAction(kind, id, siteID, contentID, parameters, secureParameters, computerIDs, callback) {
    if (!page) {
      log('WARN', kind + ': no page to show the Take Action dialog in')
      return
    }
    log('CONSOLE', kind + '(' + id + ', site ' + siteID + ', "' + contentID + '")')
    page
      .takeAction({ kind, fixletID: Number(id), siteID: String(siteID), contentID: String(contentID || 'Action1'), parameters: parameters || {}, secureParameters: secureParameters || null, computerIDs: computerIDs ? idsFrom(computerIDs) : null })
      .then((actionId) => {
        if (actionId === null || actionId === undefined) return // cancelled: the console calls nothing
        changed('Actions')
        if (typeof callback === 'function') callback(actionId)
      })
      .catch((err) => log('ERROR', kind + ': ' + err.message))
  }
  window.TakeFixletAction = (id, siteID, contentID, parameters, callback) => takeAction('TakeFixletAction', id, siteID, contentID, parameters, null, null, callback)
  window.TakeSecureFixletAction = (id, siteID, contentID, parameters, secureParameters, callback) => takeAction('TakeSecureFixletAction', id, siteID, contentID, parameters, secureParameters, null, callback)
  window.TakeFixletActionOnComputers = (id, siteID, contentID, parameters, computerIDs, callback) => takeAction('TakeFixletActionOnComputers', id, siteID, contentID, parameters, null, computerIDs, callback)
  window.TakeSecureFixletActionOnComputers = (id, siteID, contentID, parameters, secureParameters, computerIDs, callback) =>
    takeAction('TakeSecureFixletActionOnComputers', id, siteID, contentID, parameters, secureParameters, computerIDs, callback)

  // StopAction(id) / StopActions([ids]): POST /api/sdk/actions/stop; true on success (the console's return value)
  window.StopActions = function (actionIDArray, options) {
    const ids = idsFrom(actionIDArray)
    if (!ids.length) return false
    if (options !== undefined) log('CONSOLE', 'StopActions options argument ignored: ' + short(JSON.stringify(options)))
    if (!approve('Stop action' + (ids.length === 1 ? ' ' : 's ') + ids.join(', '))) return false
    const res = requestSync('POST', '/api/sdk/actions/stop', { json: { ids } })
    setUtility('theStopActionIDList', ids.join(','))
    setUtility('theStopActionSuccessFlag', res.ok ? '1' : '0')
    if (!res.ok) {
      log('CONSOLE', 'StopActions ' + ids.join(', ') + ' failed: ' + message(res))
      return false
    }
    log('CONSOLE', 'stopped action' + (ids.length === 1 ? ' ' : 's ') + ids.join(', '))
    changed('Actions')
    return true
  }
  window.StopAction = (actionID, options) => window.StopActions([actionID], options)
  window.MakeIDListFromArray = (array) => asList(array).join(',')

  // ---- analyses ----------------------------------------------------------------------------------------------
  // The console takes 'siteid:analysisid' strings (or BESFixletID objects). The SDK takes {siteID, analysisID}.
  window.BESFixletID = function (sid, fid) {
    if (!(this instanceof window.BESFixletID)) return new window.BESFixletID(sid, fid)
    this.siteID = sid
    this.fixletID = fid
  }
  window.BESFixletID.prototype.toString = function () {
    return this.siteID + ':' + this.fixletID
  }
  window.BESFixletIDToString = function (id) {
    const v = id === undefined ? this : id
    return v && v.siteID !== undefined ? v.siteID + ':' + v.fixletID : String(v)
  }

  function analysisRefs(list) {
    return asList(list).map((v) => {
      const s = v && v.siteID !== undefined ? v.siteID + ':' + v.fixletID : String(v)
      const m = /^\s*(\d+)\s*:\s*(\d+)\s*$/.exec(s)
      if (!m) fail('analysis activation', { text: 'expected "siteid:analysisid", got "' + s + '"' })
      return { siteID: m[1], analysisID: Number(m[2]) }
    })
  }

  function analyses(verb, list) {
    const refs = analysisRefs(list)
    if (!refs.length || !approve(verb + ' analys' + (refs.length === 1 ? 'is ' : 'es ') + refs.map((r) => r.siteID + ':' + r.analysisID).join(', '))) return false
    const steps = verb === 'Reactivate' ? ['deactivate', 'activate'] : [verb.toLowerCase()]
    for (const step of steps) {
      const res = requestSync('POST', '/api/sdk/analyses/' + step, { json: { analyses: refs } })
      setUtility('theActivateAnalysisSuccessFlag', res.ok ? '1' : '0')
      if (!res.ok) {
        log('CONSOLE', step + ' analyses failed: ' + message(res))
        return false
      }
    }
    log('CONSOLE', verb.toLowerCase() + 'd ' + refs.length + ' analys' + (refs.length === 1 ? 'is' : 'es'))
    changed('CustomContent')
    return true
  }
  ;['Activate', 'Deactivate', 'Reactivate'].forEach((verb) => {
    window[verb + 'Analysis'] = (id) => analyses(verb, [id])
    window[verb + 'Analyses'] = (ids) => analyses(verb, ids)
  })

  // ---- computers ---------------------------------------------------------------------------------------------
  // OpenComputerGroup(ids, title): WebUI has no ad hoc computer group page, so this app's page lists the computers,
  // each linked to its WebUI device page.
  window.OpenComputerGroup = function (cids, title) {
    const ids = idsFrom(cids)
    if (page) page.showComputerGroup(ids, title ? String(title) : 'Computer group (' + ids.length + ')')
    log('CONSOLE', 'OpenComputerGroup(' + ids.length + ' computers' + (title ? ', "' + title + '"' : '') + ')')
  }

  // Wake-on-LAN: WebUI 11.0.7 has no API for it (see the Web Reports Renderer's README). The console returns
  // "not implemented" when wake-on-LAN is turned off, so that is what is returned here.
  window.SendWakeOnLANRequest = function (cids) {
    log('WOL', 'SendWakeOnLANRequest(' + idsFrom(cids).length + ' computers) ignored: WebUI has no wake-on-LAN API')
    if (window.WR && window.WR.Notify) window.WR.Notify.warning('Wake-on-LAN does not work here: WebUI has no wake-on-LAN API. Nothing was sent.')
    return 'not implemented'
  }
  window.EnableWakeOnLAN = function (enable) {
    log('WOL', 'EnableWakeOnLAN(' + enable + ') ignored: WebUI has no wake-on-LAN setting; the deployment setting is unchanged')
  }

  // ---- filters -----------------------------------------------------------------------------------------------
  // WebUI has no console-wide named filters. OpenFindDialog returns the filter it was given (as if the user kept it).
  window.OpenFindDialog = function (type, filterID) {
    log('CONSOLE', 'OpenFindDialog("' + type + '") has no WebUI equivalent; returned ' + (filterID || 0))
    return filterID || 0
  }
  ;['AddGlobalFilter', 'ClearAllGlobalFilters', 'ClearGlobalFilterOfType'].forEach((name) => {
    window[name] = function () {
      log('CONSOLE', name + '(' + Array.from(arguments).join(', ') + ') ignored: WebUI has no global filters')
    }
  })

  // ---- refresh -----------------------------------------------------------------------------------------------
  // ManualRefresh(id) / ManualRefreshAll() re-evaluate <?BeginRefreshRelevance?> sections now. RegisterRefreshHandler
  // fires the element's onclick with theRegisterRefreshSignalName set: "RefreshCycle" on the page's refresh timer
  // (Config), and Actions / CustomContent after this shim changed them. WebUI can't tell a page when BigFix data
  // changes, so the other signals (ActionResults, FixletResults, ...) never fire.
  window.ManualRefresh = (sectionName) => page && page.refreshSection(String(sectionName))
  window.ManualRefreshAll = () => page && page.refreshSection(null)
  const refreshHandlers = []
  window.RegisterRefreshHandler = function (elementID, signalName) {
    refreshHandlers.push({ elementID: String(elementID), signal: String(signalName || '') })
    setUtility('theRegisterRefreshElementID', elementID)
    log('CONSOLE', 'RegisterRefreshHandler("' + elementID + '", "' + (signalName || 'any') + '")')
  }
  // called by the page (app.js) with a signal name
  window.__cdSignal = function (signal) {
    refreshHandlers.forEach((h) => {
      if (h.signal && h.signal !== signal) return
      const el = document.getElementById(h.elementID)
      if (!el) return
      setUtility('theRegisterRefreshSignalName', signal)
      try {
        el.click()
      } catch (e) {
        log('JSERR', 'refresh handler "' + h.elementID + '": ' + e.message)
      }
    })
  }

  // RegisterRelevance(expr, callback, id): calls callback.success(result) when the dashboard data store changes. Here:
  // once at registration (the console does that too, with the current result), after every dashboard-variable write
  // made through this page, and when a poll (every 30 s) sees a different result. expr "false" unregisters.
  const registered = new Map()
  window.RegisterRelevance = function (expr, callback, id) {
    const key = String(id)
    if (String(expr).trim().toLowerCase() === 'false') {
      registered.delete(key)
      log('CONSOLE', 'RegisterRelevance "' + key + '" unregistered')
      return
    }
    registered.set(key, { expr: String(expr), callback: callback || {}, last: undefined })
    log('CONSOLE', 'RegisterRelevance "' + key + '": ' + short(expr))
    evaluateRegistered(key, true)
  }
  function evaluateRegistered(key, always) {
    const r = registered.get(key)
    if (!r) return
    window.Relevance(r.expr, {
      success: (value) => {
        const text = JSON.stringify(value)
        const changedValue = text !== r.last
        r.last = text
        if ((always || changedValue) && registered.get(key) === r && r.callback.success) r.callback.success(value)
      },
      failure: (err) => r.callback.failure && r.callback.failure(err)
    })
  }
  function reevaluateRegistered() {
    registered.forEach((r, key) => evaluateRegistered(key, true))
  }
  setInterval(() => registered.forEach((r, key) => evaluateRegistered(key, false)), 30000)

  // Dashboard-variable writes count as data store changes: wrap the shared layer's functions
  ;['StoreVariable', 'StorePrivateVariable', 'StoreSharedVariable', 'DeleteVariable', 'DeletePrivateVariable', 'DeleteSharedVariable'].forEach((name) => {
    const original = window[name]
    if (typeof original !== 'function') return
    window[name] = function () {
      const result = original.apply(this, arguments)
      setTimeout(reevaluateRegistered, 0)
      return result
    }
  })
  // The console's StoreSharedVariable(dashID, name, value) and DeleteSharedVariable(dashID, name) are synchronous and
  // take no callback; Web Reports' take a callback object. With no callback object, use the console's behavior.
  const wrStoreShared = window.StoreSharedVariable
  const wrDeleteShared = window.DeleteSharedVariable
  window.StoreSharedVariable = function (dashboardID, name, value, callback, databaseID) {
    if (callback || databaseID) return wrStoreShared.apply(this, arguments)
    window.StoreVariable(dashboardID, name, value, false)
  }
  window.DeleteSharedVariable = function (dashboardID, name, callback, databaseID) {
    if (callback || databaseID) return wrDeleteShared.apply(this, arguments)
    window.DeleteVariable(dashboardID, name, false)
  }

  // ---- scratch files -----------------------------------------------------------------------------------------
  // The console gives each dashboard window a temporary folder. Here it is a folder in this app's page memory (shown
  // in its Scratch files panel), shared by the dashboard's pages and gone when the page is closed. Files the user adds
  // in that panel stand in for local disk files (BrowseForFile, CopyFile from a full path). Results are the console's
  // strings: "Success" or an "Error: ..." message, which also goes into theScratchFileResult.
  const fs = page ? page.scratch : null
  const result = (text) => {
    setUtility('theScratchFileResult', text)
    return text
  }
  const noFs = () => result('Error: no scratch folder (the dashboard is not running in Console Dashboards)')
  window.GetScratchRootPath = () => (fs ? fs.root : '')
  window.MakeFolder = (scratchPath) => (fs ? result(fs.makeFolder(scratchPath)) : noFs())
  // the console stores "\r\n" as "\n" (seen on 11.0.7)
  window.WriteFile = (text, scratchPath, appendFlag) => (fs ? result(fs.write(scratchPath, String(text).replace(/\r\n/g, '\n'), !!appendFlag)) : noFs())
  window.CopyFile = (inputPath, scratchPath, allowOverwriteFlag) => (fs ? result(fs.copy(inputPath, scratchPath, !!allowOverwriteFlag)) : noFs())
  window.CopyFolder = (inputPath, scratchPath, recurseFlag) => (fs ? result(fs.copyFolder(inputPath, scratchPath, !!recurseFlag)) : noFs())
  // the console's own MoveFile failed in every form on 11.0.7; this one moves the file as documented
  window.MoveFile = (src, dest, allowOverwriteFlag) => (fs ? result(fs.move(src, dest, !!allowOverwriteFlag)) : noFs())
  window.DeleteFile = (scratchPath) => (fs ? result(fs.remove(scratchPath)) : noFs())
  window.DeleteAllFiles = (scratchPath, recurseFlag) => (fs ? result(fs.removeAll(scratchPath, !!recurseFlag)) : noFs())
  window.DeleteFolder = (scratchPath) => (fs ? result(fs.removeFolder(scratchPath)) : noFs())
  window.DeleteTree = (scratchPath) => (fs ? result(fs.removeTree(scratchPath)) : noFs())
  window.MakeArchive = () => result('Error: MakeArchive is not available in WebUI (the BigFix archive format is written by the console only)')
  window.GetFileSize = (inputPath) => {
    const bytes = fs && fs.bytes(inputPath)
    if (!bytes) {
      result('Error: File does not exist.')
      return -1
    }
    return bytes.length
  }
  window.GetFileSHA1 = (inputPath) => {
    const bytes = fs && fs.bytes(inputPath)
    return bytes ? hex(sha1(bytes)) : result('Error: File does not exist.')
  }
  function fileInfo(inputPath) {
    const bytes = fs && fs.bytes(inputPath)
    return bytes ? { size: bytes.length, sha1: hex(sha1(bytes)), sha256: hex(sha256(bytes)) } : null
  }
  window.CalculateFileInfo = function (inputPath, callback) {
    if (!callback) return fileInfo(inputPath)
    setTimeout(() => {
      const info = fileInfo(inputPath)
      if (info) callback.success && callback.success(info)
      else callback.failure && callback.failure({ error: 'File does not exist.' })
    }, 0)
  }
  // LoadPresentation(path): loads an html file from the scratch folder and evaluates its <?Relevance ?> instructions
  // (the console's own one returned the file without evaluating them on 11.0.7)
  window.LoadPresentation = function (path) {
    const text = fs && fs.text(path)
    if (text === null || text === undefined) return result('Error: File does not exist.')
    const html = String(text).replace(/<\?relevance\b([\s\S]*?)\?>/gi, (m, expr) => {
      const relevance = R.prepare(expr.trim())
      const typed = R.evaluateTypedSync(relevance)
      if (typed.ok) return R.typedToHtml(typed.typed)
      try {
        const answers = asList(window.EvaluateRelevance(expr.trim()))
        return answers.map(R.escapeHtml).join('<br />')
      } catch (e) {
        return '<span class="wrr-relevance-error">[relevance error: ' + R.escapeHtml(e.message) + ']</span>'
      }
    })
    setUtility('thePresentationResult', '')
    return html
  }

  // File dialogs can't be shown synchronously in a browser. These list the files added in the Scratch files panel
  // (window.prompt is synchronous) and return the chosen path, or "" (the console's Cancel) when there are none.
  function browse(kind, multi) {
    const files = fs ? fs.localFiles() : []
    if (!files.length) {
      window.alert(kind + ': WebUI cannot open a file dialog for a dashboard. Add files under "Scratch files" in Console Dashboards first; they can then be picked here.')
      log('CONSOLE', kind + ' returned "" (no files added under Scratch files)')
      return ''
    }
    if (kind === 'BrowseForFolder') return fs.localRoot.replace(/\\$/, '')
    const list = files.map((f, i) => i + 1 + ': ' + f.name).join('\n')
    const answer = window.prompt(kind + ' (WebUI has no file dialog). Files added under Scratch files:\n' + list + '\n\nNumber' + (multi ? 's, separated by commas' : '') + ' of the file to use (empty = Cancel):', '1')
    if (!answer) return ''
    const picked = answer
      .split(/[\s,;]+/)
      .map((n) => files[Number(n) - 1])
      .filter(Boolean)
    if (!picked.length) return ''
    log('CONSOLE', kind + ' -> ' + picked.map((f) => f.name).join(', '))
    return multi && picked.length > 1 ? picked.map((f) => f.path).join('\n') : picked[0].path
  }
  window.BrowseForFile = () => browse('BrowseForFile', false)
  window.BrowseForFolder = () => browse('BrowseForFolder', false)
  window.DoBrowseDialogWithFlags = function (extension, filters, forFolderFlag, initialPath, a, b, c, d, e, f, g, h, allowMultiSelectFlag) {
    return browse(forFolderFlag ? 'BrowseForFolder' : 'DoBrowseDialogWithFlags', !!allowMultiSelectFlag)
  }

  // Downloads: the extension's security policy only lets the page reach the WebUI server itself
  function download(url, outputPath) {
    let target
    try {
      target = new URL(String(url), location.href)
    } catch (e) {
      return { error: 'Error: invalid URL ' + url }
    }
    if (target.origin !== location.origin) return { error: 'Error: WebUI only allows a dashboard to download from its own server (' + target.origin + ' is blocked by the extension security policy)' }
    const xhr = new XMLHttpRequest()
    xhr.open('GET', target.href, false)
    xhr.overrideMimeType('text/plain; charset=x-user-defined') // raw bytes
    try {
      xhr.send()
    } catch (e) {
      return { error: 'Error: ' + e.message }
    }
    if (xhr.status !== 200) return { error: 'Error: HTTP ' + xhr.status }
    const text = xhr.responseText
    const bytes = new Uint8Array(text.length)
    for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff
    const written = fs.writeBytes(outputPath, bytes)
    return written === 'Success' ? { bytes, path: fs.full(outputPath) } : { error: written }
  }
  window.DownloadFile = function (url, outputPath, callback) {
    if (!fs) return noFs()
    if (!callback) {
      const r = download(url, outputPath)
      log('CONSOLE', 'DownloadFile ' + short(url) + ' -> ' + (r.error || 'Success'))
      return result(r.error || 'Success')
    }
    setTimeout(() => {
      const r = download(url, outputPath)
      if (r.error) callback.failure && callback.failure({ error: r.error })
      else callback.success && callback.success({ path: r.path, size: r.bytes.length, sha1: hex(sha1(r.bytes)), sha256: hex(sha256(r.bytes)), error: null })
    }, 0)
  }
  window.DownloadFileWithSHA1 = function (url, outputPath) {
    if (!fs) return noFs()
    const r = download(url, outputPath)
    return r.error ? result(r.error) : hex(sha1(r.bytes))
  }
  // undocumented 11.x variant: returns a JSON string {path, size, <hashAlgorithm>}
  window.DownloadFileEx = function (url, filePath, hashAlgorithm) {
    if (!fs) return noFs()
    const r = download(url, filePath)
    if (r.error) return result(r.error)
    const out = { path: r.path, size: r.bytes.length }
    out[String(hashAlgorithm || 'sha256').toLowerCase()] = String(hashAlgorithm).toLowerCase() === 'sha1' ? hex(sha1(r.bytes)) : hex(sha256(r.bytes))
    return JSON.stringify(out)
  }

  // Uploads to the server's Uploads folder: WebUI 11.0.7's passthrough cannot forward a file body (multipart to
  // api/upload fails with 500 'The "string" argument must be of type string...'), and the SDK has no upload API for
  // it. AddFileToSite and AddFileToMailbox below do work (they use SDK upload APIs).
  const NO_UPLOAD = 'Error: uploading to the BigFix server\'s Uploads folder is not available in WebUI (its REST passthrough cannot forward a file body). AddFileToSite works instead.'
  ;['UploadFile', 'ArchiveAndUploadFile', 'ArchiveAndUploadFile2', 'UploadFileEx', 'UploadFileWithName', 'ArchiveAndUploadFileEx'].forEach((name) => {
    window[name] = function () {
      const callback = Array.from(arguments).find((a) => a && typeof a === 'object' && (a.success || a.failure))
      log('CONSOLE', name + ' not available: ' + NO_UPLOAD)
      if (callback) {
        setTimeout(() => callback.failure && callback.failure({ error: NO_UPLOAD }), 0)
        return undefined
      }
      return name === 'ArchiveAndUploadFile2' ? null : NO_UPLOAD
    }
  })

  function multipart(path, fileName) {
    const bytes = fs && fs.bytes(path)
    if (!bytes) return null
    const form = new FormData()
    form.append('file', new Blob([bytes]), fileName || fs.baseName(path))
    return form
  }

  // AddFileToSite(siteName, filePath, clientFile): the SDK's site file upload (custom site, or the operator's own
  // site when siteName is empty: the master action site for a master operator)
  window.AddFileToSite = function (siteNameStr, filePath, clientFile) {
    const form = multipart(filePath)
    if (!form) return result('Error: File does not exist.')
    const site = String(siteNameStr || '')
    if (!approve('Add file "' + fs.baseName(filePath) + '" to ' + (site ? 'custom site "' + site + '"' : 'your operator site') + (clientFile ? ' (clients download it)' : ''))) return false
    const query = '?force=true&isClientFile=' + (clientFile ? 1 : 0)
    const res = requestSync('POST', (site ? '/api/sdk/site/custom/' + encodeURIComponent(site) : '/api/sdk/site/operator') + '/file' + query, { body: form })
    if (!res.ok) fail('AddFileToSite', res)
    log('CONSOLE', 'AddFileToSite: ' + short(message(res)))
    changed('CustomContent')
    return true
  }

  // AddFileToMailbox(computerID, filePath, fileName): the SDK's mailbox upload. On 11.0.7 it stores the file but
  // answers 500 "Cannot read properties of undefined (reading 'ID')", so the mailbox is checked before failing.
  window.AddFileToMailbox = function (computerID, filePath, fileName) {
    const name = fileName || (fs && fs.baseName(filePath))
    const form = multipart(filePath, name)
    if (!form) return result('Error: File does not exist.')
    if (!approve('Send file "' + name + '" to the mailbox of computer ' + computerID)) return false
    const res = requestSync('POST', '/api/sdk/mailbox/' + Number(computerID), { body: form })
    if (res.ok) return true
    const list = requestSync('GET', restUrl('mailbox/' + Number(computerID)))
    if (list.ok && list.text.includes('<Name>' + name + '</Name>')) {
      log('WARN', 'AddFileToMailbox: the file arrived although the SDK answered ' + res.status + ' (a WebUI 11.0.7 bug)')
      return true
    }
    fail('AddFileToMailbox', res)
  }

  window.CompleteHashSet = function (hashAlgorithm, hashValue, callback) {
    if (callback && callback.failure) setTimeout(() => callback.failure({ errorCode: -1, errorMessage: 'CompleteHashSet is not available in WebUI' }), 0)
  }

  // ---- connection info, other dashboards, links ------------------------------------------------------------
  window.GetCurrentDSN = () => '' // WebUI has no database connection of its own (seen empty on an 11.x console too)
  window.GetCurrentUser = () => (page ? page.userName() : '')

  // external.OpenWizard(siteID, dashboardID): opens that dashboard in a new tab of this app; returns its window
  window.OpenWizard = function (siteID, dashboardID) {
    if (!page) return null
    return page.openWizard(siteID, String(dashboardID))
  }

  // window.navigate (IE) and links to other pages of the same wizard: linkpage:<PageName>
  window.navigate = function (url) {
    const m = /^linkpage:(.+)$/i.exec(String(url))
    if (m && page) return page.goToPage(m[1])
    window.location.href = url
  }

  // Console links WebUI has a page for (the shared layer handles computers, actions and fixlets)
  const LINKS = [
    [/^linkid:openwizard\(\s*([^,]*)\s*,\s*([^)]+?)\s*\)$/i, (m) => page && page.openWizard(m[1], m[2])],
    [/^linkid:(allComputers)$/i, () => window.open('/framework/devices', '_blank', 'noopener')],
    [/^linkid:(fixletActions|taskActions)$/i, () => window.open('/framework/deployments', '_blank', 'noopener')],
    [/^linkid:(customTask|customFixlets|customBaseline|customAnalyses)$/i, () => window.open('/custom/tasks', '_blank', 'noopener')],
    [/^linkid:(fixletMessages|viewTasks|viewAnalyses)$/i, () => window.open('/content/tasks', '_blank', 'noopener')]
  ]
  // window-level capture runs before the shared layer's document-level listener
  window.addEventListener(
    'click',
    (e) => {
      const a = e.target && e.target.closest ? e.target.closest('a[href]') : null
      if (!a) return
      const href = a.getAttribute('href')
      const page_ = /^linkpage:(.+)$/i.exec(href)
      if (page_) {
        e.preventDefault()
        e.stopImmediatePropagation()
        if (page) page.goToPage(page_[1])
        return
      }
      for (const [re, go] of LINKS) {
        const m = re.exec(href)
        if (m) {
          e.preventDefault()
          e.stopImmediatePropagation()
          go(m)
          log('INFO', 'opened ' + href)
          return
        }
      }
    },
    true
  )

  // ---- the console's REST API object (API.Get / Post / Put / Delete / DoRestAPIRequest) -----------------------
  // uri is relative to the server's /api/ ("action/123/stop"); callback(error, status, body). Mapped to the SDK
  // passthrough, which needs "Can use REST API". Requests that change something ask first.
  function restCall(method, uri, options, callback) {
    if (typeof options === 'function') {
      callback = options
      options = {}
    }
    options = options || {}
    const done = typeof callback === 'function' ? callback : () => {}
    if (options.data instanceof FormData) {
      log('CONSOLE', 'API.' + method + ' ' + uri + ': file bodies cannot go through the WebUI passthrough')
      setTimeout(() => done('FormData bodies are not supported in WebUI', 0, ''), 0)
      return
    }
    if (method !== 'GET' && !approve('REST API ' + method + ' ' + uri)) {
      setTimeout(() => done('cancelled', 0, ''), 0)
      return
    }
    const body = options.data === undefined ? undefined : typeof options.data === 'string' ? options.data : JSON.stringify(options.data)
    const type = (options.customHeaders && (options.customHeaders['Content-Type'] || options.customHeaders['content-type'])) || (body && /^\s*</.test(body) ? 'application/xml' : 'text/plain')
    request(method, restUrl(uri), body === undefined ? {} : { body, contentType: type }).then((res) => {
      log('CONSOLE', 'API.' + method + ' ' + uri + ' -> ' + res.status)
      if (method !== 'GET' && res.ok) changed(/action/i.test(uri) ? 'Actions' : 'CustomContent')
      done(res.ok ? null : message(res), res.status, res.text)
    })
  }
  window.API = {
    DoRestAPIRequest: (method, uri, options, callback) => restCall(String(method).toUpperCase(), uri, options, callback),
    Get: (uri, options, callback) => restCall('GET', uri, options, callback),
    Post: (uri, options, callback) => restCall('POST', uri, options, callback),
    Put: (uri, options, callback) => restCall('PUT', uri, options, callback),
    Delete: (uri, options, callback) => restCall('DELETE', uri, options, callback)
  }

  // ---- small helpers from the console's wizards.js / common.js ---------------------------------------------
  window.BooleanToText = (flag) => (flag ? '1' : '0') // what an 11.x console returned
  window.hasClass = (node, name) => !!(node && node.classList && node.classList.contains(name))
  window.ToggleVisibility = function (id) {
    const el = document.getElementById(id)
    if (el) el.style.display = el.style.display === 'none' ? '' : 'none'
  }
  // The console has no relevance colorizer outside its own pages here: return the text escaped, like a plain view
  window.ColorizeRelevance = (relevance, indent) => (indent ? '<pre>' + R.escapeHtml(relevance) + '</pre>' : R.escapeHtml(relevance))

  // Collapsible sections, in the console's markup: div.section > .sectionHeader (img.collapse / img.expand) +
  // .sectionBody. ToggleSectionVisibility() is called from the header's onclick, so it finds its section from the event.
  function setSection(section, open) {
    const body = section.querySelector('.sectionBody') || section.querySelector('.sectionContents')
    if (body) body.style.display = open ? '' : 'none'
    section.querySelectorAll('.sectionHeader img').forEach((img) => {
      img.classList.toggle('collapse', open)
      img.classList.toggle('expand', !open)
      if (/collapse\.|expand\./i.test(img.getAttribute('src') || '')) img.setAttribute('src', img.getAttribute('src').replace(open ? /expand\./i : /collapse\./i, open ? 'collapse.' : 'expand.'))
    })
  }
  const isOpen = (section) => {
    const body = section.querySelector('.sectionBody') || section.querySelector('.sectionContents')
    return !body || body.style.display !== 'none'
  }
  window.ToggleSectionVisibility = function (el) {
    const target = (el && el.nodeType ? el : null) || (window.event && (window.event.target || window.event.srcElement))
    const section = target && target.closest ? target.closest('.section') : null
    if (section) setSection(section, !isOpen(section))
  }
  window.ToggleSectionVisibilityOfImage = (el) => window.ToggleSectionVisibility(el)
  window.ExpandAll = () => document.querySelectorAll('.section').forEach((s) => setSection(s, true))
  window.CollapseAll = () => document.querySelectorAll('.section').forEach((s) => setSection(s, false))
  window.ToggleAll = () => {
    const sections = Array.from(document.querySelectorAll('.section'))
    const open = !sections.every(isOpen)
    sections.forEach((s) => setSection(s, open))
  }

  // ---- ActiveXObject: IE-only, but the console's IE engine has it ------------------------------------------
  // Microsoft.XMLDOM / MSXML2.DOMDocument work (DOMParser + XPath), as the console's CopyFixlets pattern uses them.
  // WScript.Shell and Scripting.FileSystemObject are created as stubs whose methods throw when called, so a dashboard
  // that creates one at load time keeps running until it actually needs it. Any other ProgID throws, as IE does for a
  // control that isn't installed: plugin detection (Modernizr, Detectizr) probes QuickTime, Flash, PDF and so on.
  // Only defined when the dashboard's own source mentions ActiveXObject: libraries that see window.ActiveXObject
  // take IE-only code paths.
  function XmlDom() {
    this.async = false
    this.doc = document.implementation.createDocument(null, null, null)
  }
  XmlDom.prototype.loadXML = function (text) {
    const doc = new DOMParser().parseFromString(String(text), 'application/xml')
    if (doc.getElementsByTagName('parsererror').length) return false
    this.doc = doc
    return true
  }
  XmlDom.prototype.selectNodes = function (xpath, context) {
    const out = []
    const it = this.doc.evaluate(xpath, context || this.doc, null, XPathResult.ORDERED_NODE_ITERATOR_TYPE, null)
    for (let n = it.iterateNext(); n; n = it.iterateNext()) out.push(n)
    return out
  }
  XmlDom.prototype.selectSingleNode = function (xpath, context) {
    return this.selectNodes(xpath, context)[0] || null
  }
  Object.defineProperties(XmlDom.prototype, {
    xml: { get: function () { return this.doc.documentElement ? new XMLSerializer().serializeToString(this.doc) : '' } },
    documentElement: { get: function () { return this.doc.documentElement } },
    childNodes: { get: function () { return this.doc.childNodes } }
  })
  function stubObject(progId) {
    return new Proxy(
      {},
      {
        get: (t, prop) => {
          if (prop === 'then' || typeof prop === 'symbol') return undefined
          return function () {
            const msg = 'ActiveXObject("' + progId + '").' + String(prop) + ' is not available in WebUI'
            log('CONSOLE', msg)
            const err = new Error(msg)
            err.description = msg
            throw err
          }
        }
      }
    )
  }
  if (typeof window.ActiveXObject === 'undefined' && page && page.wantsActiveX()) {
    window.ActiveXObject = function (progId) {
      const id = String(progId)
      if (/xmldom|domdocument/i.test(id)) return new XmlDom()
      if (/^(wscript\.shell|scripting\.filesystemobject)$/i.test(id)) {
        log('CONSOLE', 'new ActiveXObject("' + id + '"): a stub, its methods throw')
        return stubObject(id)
      }
      const err = new Error("Automation server can't create object")
      err.description = err.message
      err.number = -2146827859
      throw err
    }
  }

  // ---- data: images ----------------------------------------------------------------------------------------
  // WebUI's extension policy allows images only from the server and blob: (img-src 'self' blob:), so a data: image
  // URL is blocked. Dashboards build them (Screenshots shows base64 PNGs from a property), so every <img> with a
  // data: src, now or later, is switched to a blob: URL with the same bytes.
  function dataToBlobUrl(url) {
    const m = /^data:([^;,]*)(;base64)?,([\s\S]*)$/i.exec(url)
    if (!m) return null
    try {
      let bytes
      if (m[2]) {
        const bin = atob(m[3].replace(/\s+/g, ''))
        bytes = new Uint8Array(bin.length)
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
      } else bytes = new TextEncoder().encode(decodeURIComponent(m[3]))
      return URL.createObjectURL(new Blob([bytes], { type: m[1] || 'application/octet-stream' }))
    } catch (e) {
      return null
    }
  }
  let dataImages = 0
  function fixImage(img) {
    const src = img.getAttribute('src')
    if (!src || !/^data:/i.test(src)) return
    const url = dataToBlobUrl(src)
    if (!url) return
    img.setAttribute('src', url)
    if (++dataImages === 1) log('INFO', 'data: image URLs are shown as blob: URLs (WebUI blocks data: images)')
  }
  new MutationObserver((records) => {
    records.forEach((r) => {
      if (r.type === 'attributes') fixImage(r.target)
      else r.addedNodes.forEach((n) => {
        if (n.nodeType !== 1) return
        if (n.tagName === 'IMG') fixImage(n)
        n.querySelectorAll && n.querySelectorAll('img[src^="data:" i]').forEach(fixImage)
      })
    })
  }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['src'] })

  // ---- window.external: dashboards call many of these as external.X(...) ------------------------------------
  const EXTERNAL = [
    'OpenWizard', 'OpenFindDialog', 'AddGlobalFilter', 'ClearAllGlobalFilters', 'ClearGlobalFilterOfType',
    'StoreVariable', 'StorePrivateVariable', 'StoreSharedVariable', 'DeleteVariable', 'DeletePrivateVariable', 'DeleteSharedVariable'
  ]
  try {
    EXTERNAL.forEach((n) => {
      if (window.external) window.external[n] = window[n]
    })
    // the console's ColorizeRelevance wrapper calls external.ColorizeRelevance(rel, indent, cssOnly)
    if (window.external) window.external.ColorizeRelevance = (relevance, indent, cssOnly) => (cssOnly ? '' : window.ColorizeRelevance(relevance, indent))
  } catch (e) {
    log('INFO', 'window.external.* not available in this browser: ' + e.message)
  }

  // ---- hashes (synchronous: GetFileSHA1 and CalculateFileInfo return at once in the console) -------------------
  const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  function padded(bytes) {
    const len = bytes.length
    const total = (((len + 9 + 63) >> 6) << 6)
    const out = new Uint8Array(total)
    out.set(bytes)
    out[len] = 0x80
    const bits = len * 8
    const view = new DataView(out.buffer)
    view.setUint32(total - 8, Math.floor(bits / 0x100000000))
    view.setUint32(total - 4, bits >>> 0)
    return view
  }
  function sha1(bytes) {
    const view = padded(bytes)
    let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0
    const w = new Uint32Array(80)
    for (let off = 0; off < view.byteLength; off += 64) {
      for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4)
      for (let i = 16; i < 80; i++) {
        const x = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]
        w[i] = (x << 1) | (x >>> 31)
      }
      let a = h0, b = h1, c = h2, d = h3, e = h4
      for (let i = 0; i < 80; i++) {
        const f = i < 20 ? (b & c) | (~b & d) : i < 40 ? b ^ c ^ d : i < 60 ? (b & c) | (b & d) | (c & d) : b ^ c ^ d
        const k = i < 20 ? 0x5a827999 : i < 40 ? 0x6ed9eba1 : i < 60 ? 0x8f1bbcdc : 0xca62c1d6
        const t = (((a << 5) | (a >>> 27)) + f + e + k + w[i]) >>> 0
        e = d
        d = c
        c = (b << 30) | (b >>> 2)
        b = a
        a = t
      }
      h0 = (h0 + a) >>> 0
      h1 = (h1 + b) >>> 0
      h2 = (h2 + c) >>> 0
      h3 = (h3 + d) >>> 0
      h4 = (h4 + e) >>> 0
    }
    const out = new Uint8Array(20)
    const ov = new DataView(out.buffer)
    ;[h0, h1, h2, h3, h4].forEach((h, i) => ov.setUint32(i * 4, h))
    return out
  }
  const K256 = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ])
  function sha256(bytes) {
    const view = padded(bytes)
    const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19])
    const w = new Uint32Array(64)
    const rot = (x, n) => (x >>> n) | (x << (32 - n))
    for (let off = 0; off < view.byteLength; off += 64) {
      for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4)
      for (let i = 16; i < 64; i++) {
        const s0 = rot(w[i - 15], 7) ^ rot(w[i - 15], 18) ^ (w[i - 15] >>> 3)
        const s1 = rot(w[i - 2], 17) ^ rot(w[i - 2], 19) ^ (w[i - 2] >>> 10)
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0
      }
      let [a, b, c, d, e, f, g, hh] = h
      for (let i = 0; i < 64; i++) {
        const S1 = rot(e, 6) ^ rot(e, 11) ^ rot(e, 25)
        const ch = (e & f) ^ (~e & g)
        const t1 = (hh + S1 + ch + K256[i] + w[i]) >>> 0
        const S0 = rot(a, 2) ^ rot(a, 13) ^ rot(a, 22)
        const maj = (a & b) ^ (a & c) ^ (b & c)
        const t2 = (S0 + maj) >>> 0
        hh = g
        g = f
        f = e
        e = (d + t1) >>> 0
        d = c
        c = b
        b = a
        a = (t1 + t2) >>> 0
      }
      h[0] += a
      h[1] += b
      h[2] += c
      h[3] += d
      h[4] += e
      h[5] += f
      h[6] += g
      h[7] += hh
    }
    const out = new Uint8Array(32)
    const ov = new DataView(out.buffer)
    h.forEach((v, i) => ov.setUint32(i * 4, v))
    return out
  }
  window.__cdHash = { sha1: (b) => hex(sha1(b)), sha256: (b) => hex(sha256(b)) } // for the page's Scratch files panel

  // The console's IE engine reports documentMode 11; some dashboards print it. Not set here: code that sees it may
  // take an IE-only path.
  log('INFO', 'console dashboard API ready (' + Object.keys(window.API).length + ' API methods, ' + UTILITY_IDS.length + ' utility ids)')
})()
