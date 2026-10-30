// SDK API Tester - test runner and test definitions.
// "Safe" tests are read-only, or only create and then delete a private dashboard variable owned by this app.
// Everything that changes BigFix (actions, analyses, sites, content, files, client queries) is "manual":
// it runs only from its own button, reads its inputs from the page, and asks for confirmation first.
'use strict'
;(function (SAT) {
  // Every operation in the server's /api/openapi.json ("WebUI SDK APIs"), used for the coverage section of the report.
  SAT.API_OPERATIONS = [
    'POST /api/sdk/sessionrelevance/evaluate',
    'GET /api/sdk/resources/{resourceType}/{resourceId}',
    'GET /api/sdk/resources/{resourceType}/external/{siteName}/{resourceId}',
    'PUT /api/sdk/resources/{resourceType}/{resourceId}/edit',
    'POST /api/sdk/resources/{resourceType}/delete',
    'GET /api/sdk/dashboardvariables',
    'GET /api/sdk/dashboardvariable/{dashboardId}',
    'GET /api/sdk/dashboardvariable/{dashboardId}/{variableName}',
    'POST /api/sdk/dashboardvariable/{dashboardId}/{variableName}',
    'PUT /api/sdk/dashboardvariable/{dashboardId}/{variableName}',
    'DELETE /api/sdk/dashboardvariable/{dashboardId}/{variableName}',
    'GET /api/sdk/passthrough/{uri}',
    'POST /api/sdk/passthrough/{uri}',
    'PUT /api/sdk/passthrough/{uri}',
    'DELETE /api/sdk/passthrough/{uri}',
    'POST /api/sdk/actions/stop',
    'POST /api/sdk/analyses/activate',
    'POST /api/sdk/analyses/deactivate',
    'POST /api/sdk/site/custom',
    'POST /api/sdk/site/custom/{siteName}/import',
    'POST /api/sdk/site/operator/import',
    'POST /api/sdk/site/custom/{siteName}/file',
    'POST /api/sdk/site/operator/file',
    'POST /api/sdk/mailbox/{computerId}',
    'POST /api/sdk/clientquery',
    'GET /api/sdk/clientqueryresults/{queryId}'
  ]

  SAT.tests = []
  SAT.latest = {} // id -> most recent result, across runs
  SAT.running = false
  SAT.onResult = null // set by app.js to repaint the results table

  // def: { id, group, title, api, safe, timeout, run(t) }; run must call one of t.pass/fail/warn/skip/info
  SAT.test = (def) => SAT.tests.push(Object.assign({ timeout: 30000, safe: false }, def))

  SAT.latestResults = () => SAT.tests.filter((t) => SAT.latest[t.id]).map((t) => SAT.latest[t.id])

  SAT.countResults = function (list) {
    const c = { PASS: 0, FAIL: 0, WARN: 0, SKIP: 0, INFO: 0 }
    list.forEach((r) => c[r.status]++)
    return c
  }

  SAT.formatCounts = (c) => 'PASS ' + c.PASS + ', FAIL ' + c.FAIL + ', WARN ' + c.WARN + ', SKIP ' + c.SKIP + ', INFO ' + c.INFO

  SAT.confirm = function (msg) {
    const ok = window.confirm(msg)
    if (!ok) SAT.log('INFO', 'Cancelled by user: ' + msg.split('\n')[0])
    return ok
  }

  async function runOne(test) {
    const started = performance.now()
    let result = null
    const record = (status) => (msg) => {
      if (result) {
        SAT.log('DEBUG', test.id + ' reported again after finishing: ' + status + ' ' + msg)
        return
      }
      result = { id: test.id, group: test.group, title: test.title, status, msg: String(msg === undefined ? '' : msg) }
    }
    const t = {
      pass: record('PASS'),
      fail: record('FAIL'),
      warn: record('WARN'),
      skip: record('SKIP'),
      info: record('INFO'),
      log: (m) => SAT.log('DEBUG', test.id + ': ' + m)
    }
    let timer
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => {
        t.fail('timed out after ' + test.timeout + 'ms')
        resolve()
      }, test.timeout)
    })
    try {
      await Promise.race([test.run(t), timeout])
    } catch (err) {
      t.fail('threw ' + SAT.errText(err))
    }
    clearTimeout(timer)
    if (!result) t.fail('test finished without reporting a result')

    result.ms = Math.round(performance.now() - started)
    result.at = new Date().toTimeString().slice(0, 8)
    SAT.latest[test.id] = result
    SAT.log(result.status, test.id + ' - ' + result.msg + ' (' + result.ms + 'ms)')
    if (SAT.onResult) SAT.onResult(result)
    return result
  }

  SAT.runTests = async function (list, label) {
    if (SAT.running) {
      SAT.log('WARN', 'A test run is already in progress')
      return
    }
    SAT.running = true
    const started = performance.now()
    SAT.log('INFO', '===== ' + label + ': ' + list.length + ' tests =====')
    const results = []
    try {
      for (let i = 0; i < list.length; i++) {
        if (SAT.onProgress) SAT.onProgress(label + ': ' + (i + 1) + '/' + list.length + ' ' + list[i].id)
        results.push(await runOne(list[i]))
      }
    } finally {
      SAT.running = false
    }
    const summary = SAT.formatCounts(SAT.countResults(results)) + ' in ' + Math.round(performance.now() - started) + 'ms'
    SAT.log('INFO', '===== ' + label + ' finished: ' + summary + ' =====')
    if (SAT.onProgress) SAT.onProgress(label + ' finished: ' + summary + '. Use Copy report to share the results.')
  }

  SAT.runSafe = () => SAT.runTests(SAT.tests.filter((t) => t.safe), 'Run all safe tests')
  SAT.runIds = (ids, label) => SAT.runTests(ids.map((id) => SAT.tests.find((t) => t.id === id)), label)

  // ---- helpers used by tests --------------------------------------------------------------------

  const input = (id) => {
    const el = document.getElementById(id)
    return el ? el.value.trim() : ''
  }
  const fileInput = (id) => {
    const el = document.getElementById(id)
    return el && el.files && el.files[0]
  }
  const idList = (text) =>
    String(text || '')
      .split(/[\s,;]+/)
      .filter((s) => /^\d+$/.test(s))
      .map(Number)
  const bodyValue = (res) => (res.json && res.json.value !== undefined ? res.json.value : undefined)
  // first element inside <BES>, e.g. "Fixlet", "Task", "ComputerGroup"
  const besRoot = (xml) => {
    const m = /<BES\b[^>]*>\s*<([A-Za-z]+)/.exec(xml || '')
    return m ? m[1] : null
  }
  // the new content id from an import response (BESAPI XML, possibly wrapped in the SDK's { value } JSON)
  const importedId = (res) => {
    const m = /<ID>(\d+)<\/ID>/.exec(res.text) || /"ID"\s*:\s*"?(\d+)/.exec(res.text)
    return m ? m[1] : null
  }
  // the query id from a client query submit response: { id } per the OpenAPI doc, with fallbacks
  const queryIdFrom = (res) => {
    if (res.json && /^\d+$/.test(String(res.json.id))) return String(res.json.id)
    const m = /"(?:ID|id|queryId|QueryID)"\s*:\s*"?(\d+)/.exec(res.text) || /<ID>(\d+)<\/ID>/.exec(res.text)
    return m ? m[1] : null
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  const LOCAL_SITE = '(custom site flag of it or master site flag of it or operator site flag of it)'
  const DASHBOARD_ID = 'SdkApiTester.ojo'

  // ---- Environment (safe) -----------------------------------------------------------------------

  SAT.test({
    id: 'env.me',
    group: 'Environment',
    title: 'Current user (GET /me, used by the header)',
    safe: true,
    async run(t) {
      const res = await SAT.api('GET', '/me')
      if (!res.ok || !res.json || !res.json.userName) return t.fail(SAT.message(res))
      SAT.sensitive.add(res.json.userName)
      SAT.state.isMaster = res.json.userPermission ? String(res.json.userPermission.IsMaster) : '?'
      t.pass('userName present, IsMaster=' + SAT.state.isMaster)
    }
  })

  SAT.test({
    id: 'env.loggedin',
    group: 'Environment',
    title: 'Session keep-alive (GET /loggedin)',
    safe: true,
    async run(t) {
      const res = await SAT.api('GET', '/loggedin')
      res.ok ? t.pass('200, body ' + SAT.snippet(res.text, 40)) : t.fail(SAT.message(res))
    }
  })

  // ---- Session relevance (safe) -----------------------------------------------------------------

  SAT.test({
    id: 'sr.singular',
    group: 'Session relevance',
    title: 'Singular result and response shape',
    api: 'POST /api/sdk/sessionrelevance/evaluate',
    safe: true,
    async run(t) {
      const res = await SAT.evaluate('number of bes computers')
      if (!res.ok) return t.fail(SAT.message(res))
      const keys = res.json ? Object.keys(res.json).sort().join(',') : 'not JSON'
      const value = bodyValue(res)
      if (!Array.isArray(value) || value.length !== 1) return t.fail('expected value: [n], got keys ' + keys)
      t.pass('keys {' + keys + '}, done=' + res.json.done + ', value[0] is a ' + typeof value[0])
    }
  })

  SAT.test({
    id: 'sr.tuple',
    group: 'Session relevance',
    title: 'Tuple result (rows are arrays)',
    api: 'POST /api/sdk/sessionrelevance/evaluate',
    safe: true,
    async run(t) {
      const res = await SAT.evaluate('(id of it, name of it) of bes computer groups')
      if (!res.ok) return t.fail(SAT.message(res))
      const rows = bodyValue(res) || []
      if (!rows.length) return t.warn('no computer groups to check the tuple shape with')
      const first = rows[0]
      Array.isArray(first) && first.length === 2
        ? t.pass(rows.length + ' rows, each an array of ' + first.map((v) => typeof v).join('/'))
        : t.fail('expected rows of [id, name], got ' + SAT.snippet(JSON.stringify(first), 100))
    }
  })

  SAT.test({
    id: 'sr.error',
    group: 'Session relevance',
    title: 'Relevance error returns a message',
    api: 'POST /api/sdk/sessionrelevance/evaluate',
    safe: true,
    async run(t) {
      const res = await SAT.evaluate('names of error')
      if (res.ok) return t.fail('expected an error status, got ' + res.status)
      res.json && res.json.message ? t.pass(res.status + ' with message: ' + res.json.message) : t.warn(res.status + ' without a JSON message')
    }
  })

  SAT.test({
    id: 'sr.noxsrf',
    group: 'Session relevance',
    title: 'Request without X-XSRF-TOKEN is rejected',
    api: 'POST /api/sdk/sessionrelevance/evaluate',
    safe: true,
    async run(t) {
      const res = await SAT.evaluate('number of bes computers', { xsrf: false })
      if (res.status === 403) return t.pass('403: ' + SAT.message(res))
      res.ok ? t.warn('accepted without the XSRF header') : t.info(res.status + ': ' + SAT.message(res))
    }
  })

  // ---- Resources (safe) -------------------------------------------------------------------------

  const RESOURCE_TYPES = [
    { type: 'fixlet', root: 'Fixlet', lookup: 'minimum of ids of bes fixlets whose (fixlet flag of it and ' + LOCAL_SITE + ' of site of it)' },
    { type: 'task', root: 'Task', lookup: 'minimum of ids of bes fixlets whose (task flag of it and ' + LOCAL_SITE + ' of site of it)' },
    { type: 'analysis', root: 'Analysis', lookup: 'minimum of ids of bes fixlets whose (analysis flag of it and ' + LOCAL_SITE + ' of site of it)' },
    { type: 'baseline', root: 'Baseline', lookup: 'minimum of ids of bes fixlets whose (baseline flag of it and ' + LOCAL_SITE + ' of site of it)' },
    { type: 'computergroup', root: 'ComputerGroup', lookup: 'minimum of ids of bes computer groups whose (' + LOCAL_SITE + ' of site of it)' }
  ]

  RESOURCE_TYPES.forEach((r) =>
    SAT.test({
      id: 'res.get.' + r.type,
      group: 'Resources',
      title: 'Get a ' + r.type + ' from a custom, master or operator site',
      api: 'GET /api/sdk/resources/{resourceType}/{resourceId}',
      safe: true,
      async run(t) {
        const id = await SAT.evaluateFirst(r.lookup)
        if (!id) return t.skip('no ' + r.type + ' found in a custom, master or operator site')
        SAT.state[r.type + 'Id'] = id
        const res = await SAT.api('GET', '/api/sdk/resources/' + r.type + '/' + id)
        if (!res.ok) return t.fail(SAT.message(res))
        const root = besRoot(res.text)
        root === r.root ? t.pass('id ' + id + ': BES XML <' + root + '>, ' + res.text.length + ' bytes') : t.warn('id ' + id + ': expected <' + r.root + '>, got <' + root + '>')
      }
    })
  )

  SAT.test({
    id: 'res.get.external',
    group: 'Resources',
    title: 'Get a fixlet from an external site (BES Support)',
    api: 'GET /api/sdk/resources/{resourceType}/external/{siteName}/{resourceId}',
    safe: true,
    async run(t) {
      const site = 'BES Support'
      const id = await SAT.evaluateFirst('minimum of ids of fixlets whose (fixlet flag of it) of bes sites whose (name of it = "' + site + '")')
      if (!id) return t.skip('no fixlets found in ' + site)
      const res = await SAT.api('GET', '/api/sdk/resources/fixlet/external/' + SAT.enc(site) + '/' + id)
      if (!res.ok) return t.fail(SAT.message(res))
      t.pass(site + ' fixlet ' + id + ': BES XML <' + besRoot(res.text) + '>, ' + res.text.length + ' bytes')
    }
  })

  SAT.test({
    id: 'res.get.badtype',
    group: 'Resources',
    title: 'Unknown resourceType is rejected',
    api: 'GET /api/sdk/resources/{resourceType}/{resourceId}',
    safe: true,
    async run(t) {
      const res = await SAT.api('GET', '/api/sdk/resources/notatype/1')
      res.status === 400 ? t.pass('400: ' + SAT.message(res)) : t.fail('expected 400, got ' + res.status + ': ' + SAT.message(res))
    }
  })

  SAT.test({
    id: 'res.get.missing',
    group: 'Resources',
    title: 'Non-existent id returns an error',
    api: 'GET /api/sdk/resources/{resourceType}/{resourceId}',
    safe: true,
    async run(t) {
      const res = await SAT.api('GET', '/api/sdk/resources/fixlet/2147483000')
      res.ok ? t.fail('expected an error, got ' + res.status) : t.pass(res.status + ': ' + SAT.message(res))
    }
  })

  // ---- Dashboard variables (safe: one private variable, created and deleted) -----------------------

  SAT.test({
    id: 'ds.all',
    group: 'Dashboard variables',
    title: 'List all dashboard variables (count only; the body can be large)',
    api: 'GET /api/sdk/dashboardvariables',
    safe: true,
    async run(t) {
      const res = await SAT.api('GET', '/api/sdk/dashboardvariables')
      if (!res.ok) return t.fail(SAT.message(res))
      const value = bodyValue(res)
      Array.isArray(value) ? t.pass(value.length + ' variables, ' + res.text.length + ' bytes, item keys: ' + Object.keys(value[0] || {}).join(',')) : t.warn('value is not an array')
    }
  })

  const dsUrl = () => '/api/sdk/dashboardvariable/' + SAT.enc(DASHBOARD_ID) + '/' + SAT.enc(SAT.state.dsName)

  SAT.test({
    id: 'ds.create',
    group: 'Dashboard variables',
    title: 'Create a private variable for ' + DASHBOARD_ID,
    api: 'POST /api/sdk/dashboardvariable/{dashboardId}/{variableName}',
    safe: true,
    async run(t) {
      SAT.state.dsName = 'sat_' + Date.now()
      SAT.state.dsCreated = false
      const res = await SAT.api('POST', dsUrl(), { json: { value: 'created by SDK API Tester', private: true } })
      if (!res.ok) return t.fail(SAT.message(res))
      SAT.state.dsCreated = true
      t.pass('created ' + SAT.state.dsName + ': ' + SAT.snippet(res.text, 120))
    }
  })

  SAT.test({
    id: 'ds.get',
    group: 'Dashboard variables',
    title: 'Read the variable back',
    api: 'GET /api/sdk/dashboardvariable/{dashboardId}/{variableName}',
    safe: true,
    async run(t) {
      if (!SAT.state.dsCreated) return t.skip('ds.create did not succeed')
      const res = await SAT.api('GET', dsUrl())
      if (!res.ok) return t.fail(SAT.message(res))
      res.text.includes('created by SDK API Tester') ? t.pass('value matches: ' + SAT.snippet(res.text, 160)) : t.fail('value not found in ' + SAT.snippet(res.text, 160))
    }
  })

  SAT.test({
    id: 'ds.update',
    group: 'Dashboard variables',
    title: 'Update the variable with PUT',
    api: 'PUT /api/sdk/dashboardvariable/{dashboardId}/{variableName}',
    safe: true,
    async run(t) {
      if (!SAT.state.dsCreated) return t.skip('ds.create did not succeed')
      const res = await SAT.api('PUT', dsUrl(), { json: { value: 'updated by SDK API Tester', private: true } })
      if (!res.ok) return t.fail(SAT.message(res))
      const check = await SAT.api('GET', dsUrl())
      check.text.includes('updated by SDK API Tester') ? t.pass('updated value read back') : t.fail('PUT returned ' + res.status + ' but the read-back shows ' + SAT.snippet(check.text, 160))
    }
  })

  SAT.test({
    id: 'ds.list',
    group: 'Dashboard variables',
    title: 'List the variables of ' + DASHBOARD_ID,
    api: 'GET /api/sdk/dashboardvariable/{dashboardId}',
    safe: true,
    async run(t) {
      if (!SAT.state.dsCreated) return t.skip('ds.create did not succeed')
      const res = await SAT.api('GET', '/api/sdk/dashboardvariable/' + SAT.enc(DASHBOARD_ID))
      if (!res.ok) return t.fail(SAT.message(res))
      res.text.includes(SAT.state.dsName) ? t.pass('contains ' + SAT.state.dsName) : t.fail(SAT.state.dsName + ' not in ' + SAT.snippet(res.text, 160))
    }
  })

  SAT.test({
    id: 'ds.delete',
    group: 'Dashboard variables',
    title: 'Delete the variable, then confirm it is gone',
    api: 'DELETE /api/sdk/dashboardvariable/{dashboardId}/{variableName}',
    safe: true,
    async run(t) {
      if (!SAT.state.dsCreated) return t.skip('ds.create did not succeed')
      const res = await SAT.api('DELETE', dsUrl())
      if (!res.ok) return t.fail(SAT.message(res) + ' - delete ' + SAT.state.dsName + ' by hand if it stays')
      SAT.state.dsCreated = false
      const check = await SAT.api('GET', dsUrl())
      check.status === 404 ? t.pass('deleted; read-back is 404') : t.warn('DELETE returned ' + res.status + ' but read-back is ' + check.status)
    }
  })

  // ---- Platform REST passthrough (safe GETs) ----------------------------------------------------

  SAT.test({
    id: 'pt.get.serverinfo',
    group: 'Passthrough',
    title: 'GET api/serverinfo through the passthrough (needs "Can use REST API")',
    api: 'GET /api/sdk/passthrough/{uri}',
    safe: true,
    async run(t) {
      const res = await SAT.api('GET', '/api/sdk/passthrough/api/serverinfo')
      if (res.status === 403) return t.warn('403: operator probably lacks "Can use REST API": ' + SAT.message(res))
      if (!res.ok) return t.fail(SAT.message(res))
      SAT.state.serverVersion = res.json && res.json.version
      t.pass('BigFix server version ' + (SAT.state.serverVersion || '?'))
    }
  })

  SAT.test({
    id: 'pt.get.sites',
    group: 'Passthrough',
    title: 'GET api/sites through the passthrough',
    api: 'GET /api/sdk/passthrough/{uri}',
    safe: true,
    async run(t) {
      const res = await SAT.api('GET', '/api/sdk/passthrough/api/sites')
      if (res.status === 403) return t.warn('403: operator probably lacks "Can use REST API"')
      if (!res.ok) return t.fail(SAT.message(res))
      const count = (res.text.match(/<(?:External|Custom|Operator|ActionSite)Site\b|<ActionSite\b/g) || []).length
      t.pass('BESAPI XML, ' + count + ' site elements, ' + res.text.length + ' bytes')
    }
  })

  SAT.test({
    id: 'pt.get.noprefix',
    group: 'Passthrough',
    title: 'URI without the "api/" prefix is not found (documents the URI format)',
    api: 'GET /api/sdk/passthrough/{uri}',
    safe: true,
    async run(t) {
      const res = await SAT.api('GET', '/api/sdk/passthrough/sites')
      res.status === 404 ? t.pass('404 as expected: the uri must include "api/", e.g. passthrough/api/sites') : t.info(res.status + ': ' + SAT.message(res))
    }
  })

  // ---- Manual: actions and analyses -------------------------------------------------------------

  SAT.test({
    id: 'act.stop',
    group: 'Actions',
    title: 'Stop actions',
    api: 'POST /api/sdk/actions/stop',
    async run(t) {
      const ids = idList(input('in-stop-ids'))
      if (!ids.length) return t.skip('enter one or more action ids')
      if (!SAT.confirm('Stop action(s) ' + ids.join(', ') + '?\nThis cannot be undone.')) return t.skip('cancelled')
      const res = await SAT.api('POST', '/api/sdk/actions/stop', { json: { ids } })
      res.ok ? t.pass(SAT.snippet(res.text, 300)) : t.fail(SAT.message(res))
    }
  })

  const analysisTest = (verb) =>
    SAT.test({
      id: 'ana.' + verb,
      group: 'Analyses',
      title: verb.charAt(0).toUpperCase() + verb.slice(1) + ' an analysis',
      api: 'POST /api/sdk/analyses/' + verb,
      async run(t) {
        const siteID = input('in-ana-site')
        const analysisID = Number(input('in-ana-id'))
        if (!/^[1-9]\d*$/.test(siteID) || !analysisID) return t.skip('enter a numeric site id and analysis id')
        if (!SAT.confirm(verb + ' analysis ' + analysisID + ' (site id ' + siteID + ')?')) return t.skip('cancelled')
        const res = await SAT.api('POST', '/api/sdk/analyses/' + verb, { json: { analyses: [{ siteID, analysisID }] } })
        res.ok ? t.pass(SAT.snippet(res.text, 300)) : t.fail(SAT.message(res))
      }
    })
  analysisTest('activate')
  analysisTest('deactivate')

  // ---- Manual: custom site ----------------------------------------------------------------------

  SAT.test({
    id: 'site.create',
    group: 'Sites',
    title: 'Create a custom site',
    api: 'POST /api/sdk/site/custom',
    async run(t) {
      const siteName = input('in-site-name')
      if (!siteName) return t.skip('enter a site name')
      if (!SAT.confirm('Create custom site "' + siteName + '"?\nThere is no SDK delete; remove it with passthrough DELETE api/site/custom/' + siteName + ' or the console.')) return t.skip('cancelled')
      const res = await SAT.api('POST', '/api/sdk/site/custom', { json: { siteName } })
      res.ok ? t.pass(SAT.snippet(res.text, 300)) : t.fail(SAT.message(res))
    }
  })

  // ---- Manual: content lifecycle (import -> get -> edit -> delete) -------------------------------

  const taskXml = (title) =>
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<BES xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="BES.xsd">',
      '  <Task>',
      '    <Title>' + title + '</Title>',
      '    <Description>Created by the WebUI SDK API Tester. Never relevant. Safe to delete.</Description>',
      '    <Relevance>false</Relevance>',
      '    <Category></Category>',
      '    <Source>SDK API Tester</Source>',
      '    <SourceID></SourceID>',
      '    <SourceReleaseDate>' + new Date().toISOString().slice(0, 10) + '</SourceReleaseDate>',
      '    <SourceSeverity></SourceSeverity>',
      '    <CVENames></CVENames>',
      '    <SANSID></SANSID>',
      '    <Domain>BESC</Domain>',
      '  </Task>',
      '</BES>'
    ].join('\n')

  SAT.test({
    id: 'content.import',
    group: 'Content lifecycle',
    title: 'Import a never-relevant test task into the custom site',
    api: 'POST /api/sdk/site/custom/{siteName}/import',
    async run(t) {
      SAT.state.taskId = null
      const site = input('in-site-select')
      if (!site) return t.skip('choose a custom site')
      const res = await SAT.api('POST', '/api/sdk/site/custom/' + SAT.enc(site) + '/import', { body: taskXml('SDK API Tester - safe to delete'), contentType: 'application/xml' })
      if (!res.ok) return t.fail(SAT.message(res))
      SAT.state.taskId = importedId(res)
      SAT.state.taskId ? t.pass('imported into ' + site + ' as task ' + SAT.state.taskId) : t.warn('imported, but no <ID> found in: ' + SAT.snippet(res.text, 300))
    }
  })

  SAT.test({
    id: 'content.get',
    group: 'Content lifecycle',
    title: 'Get the imported task',
    api: 'GET /api/sdk/resources/{resourceType}/{resourceId}',
    async run(t) {
      if (!SAT.state.taskId) return t.skip('content.import did not return an id')
      const res = await SAT.api('GET', '/api/sdk/resources/task/' + SAT.state.taskId)
      if (!res.ok) return t.fail(SAT.message(res))
      res.text.includes('SDK API Tester - safe to delete') ? t.pass('title matches') : t.warn('title not found in ' + SAT.snippet(res.text, 200))
    }
  })

  SAT.test({
    id: 'content.edit',
    group: 'Content lifecycle',
    title: 'Edit the task title, then read it back',
    api: 'PUT /api/sdk/resources/{resourceType}/{resourceId}/edit',
    async run(t) {
      if (!SAT.state.taskId) return t.skip('content.import did not return an id')
      const res = await SAT.api('PUT', '/api/sdk/resources/task/' + SAT.state.taskId + '/edit', { body: taskXml('SDK API Tester - edited - safe to delete'), contentType: 'application/xml' })
      if (!res.ok) return t.fail(SAT.message(res))
      const check = await SAT.api('GET', '/api/sdk/resources/task/' + SAT.state.taskId)
      check.text.includes('SDK API Tester - edited') ? t.pass('edited title read back') : t.fail('PUT returned ' + res.status + ' but the title did not change')
    }
  })

  SAT.test({
    id: 'content.delete',
    group: 'Content lifecycle',
    title: 'Delete the task, then confirm it is gone',
    api: 'POST /api/sdk/resources/{resourceType}/delete',
    async run(t) {
      if (!SAT.state.taskId) return t.skip('content.import did not return an id')
      const id = SAT.state.taskId
      const res = await SAT.api('POST', '/api/sdk/resources/task/delete', { json: { ids: [Number(id)] } })
      if (!res.ok) return t.fail(SAT.message(res) + ' - delete task ' + id + ' by hand')
      SAT.state.taskId = null
      const check = await SAT.api('GET', '/api/sdk/resources/task/' + id)
      check.ok ? t.warn('delete returned ' + res.status + ' but task ' + id + ' can still be read') : t.pass('deleted; read-back is ' + check.status)
    }
  })

  SAT.test({
    id: 'content.opimport',
    group: 'Content lifecycle',
    title: "Import a test task into the operator's own site, then delete it",
    api: 'POST /api/sdk/site/operator/import',
    async run(t) {
      const res = await SAT.api('POST', '/api/sdk/site/operator/import', { body: taskXml('SDK API Tester (operator site) - safe to delete'), contentType: 'application/xml' })
      if (!res.ok) return t.fail(SAT.message(res))
      const id = importedId(res)
      if (!id) return t.warn('imported, but no <ID> found to delete: ' + SAT.snippet(res.text, 300))
      const del = await SAT.api('POST', '/api/sdk/resources/task/delete', { json: { ids: [Number(id)] } })
      del.ok ? t.pass('imported as task ' + id + ' and deleted it') : t.warn('imported as task ' + id + ' but delete failed: ' + SAT.message(del))
    }
  })

  SAT.runContentLifecycle = function () {
    const site = input('in-site-select')
    if (!site) {
      SAT.log('WARN', 'Choose a custom site for the content lifecycle test')
      return
    }
    if (!SAT.confirm('Import a never-relevant test task into "' + site + '", edit it, then delete it?')) return
    SAT.runIds(['content.import', 'content.get', 'content.edit', 'content.delete'], 'Content lifecycle')
  }

  SAT.runOperatorImport = function () {
    if (!SAT.confirm("Import a never-relevant test task into your operator site (the master action site for a master operator), then delete it?")) return
    SAT.runIds(['content.opimport'], 'Operator site import')
  }

  // ---- Manual: files ----------------------------------------------------------------------------

  const uploadQuery = () => '?force=' + SAT.checked('in-file-force') + '&isClientFile=' + (SAT.checked('in-file-client') ? 1 : 0)

  // verifyFailure(file) may return a WARN message when the upload landed despite an error response
  const uploadTest = (id, title, api, target, urlFor, verifyFailure) =>
    SAT.test({
      id,
      group: 'Files',
      title,
      api,
      async run(t) {
        const file = fileInput('in-file')
        if (!file) return t.skip('choose a file')
        const where = target()
        if (!where) return t.skip('fill in the target first')
        if (!SAT.confirm('Upload "' + file.name + '" (' + file.size + ' bytes) to ' + where + '?\nThere is no SDK delete for uploaded files.')) return t.skip('cancelled')
        const form = new FormData()
        form.append('file', file)
        const res = await SAT.api('POST', urlFor(), { body: form })
        if (res.ok) return t.pass(SAT.snippet(res.text, 300))
        const landed = verifyFailure && (await verifyFailure(file))
        landed ? t.warn(landed + ' Server said: ' + SAT.message(res)) : t.fail(SAT.message(res))
      }
    })

  uploadTest(
    'file.custom',
    'Upload a file to the custom site',
    'POST /api/sdk/site/custom/{siteName}/file',
    () => input('in-site-select') && 'custom site "' + input('in-site-select') + '"',
    () => '/api/sdk/site/custom/' + SAT.enc(input('in-site-select')) + '/file' + uploadQuery()
  )
  uploadTest('file.operator', "Upload a file to the operator's site", 'POST /api/sdk/site/operator/file', () => 'your operator site', () => '/api/sdk/site/operator/file' + uploadQuery())
  uploadTest(
    'file.mailbox',
    "Add a file to a computer's mailbox",
    'POST /api/sdk/mailbox/{computerId}',
    () => /^\d+$/.test(input('in-mailbox-id')) && 'the mailbox of computer ' + input('in-mailbox-id'),
    () => '/api/sdk/mailbox/' + input('in-mailbox-id'),
    // Seen on WebUI with BigFix 11.0.7: the file is stored, but the SDK handler fails to parse the platform's
    // <ComputerMailboxFile> reply and returns 500 "Cannot read properties of undefined (reading 'ID')".
    // Listing the mailbox through the passthrough (needs "Can use REST API") shows whether the file landed.
    async (file) => {
      const list = await SAT.api('GET', '/api/sdk/passthrough/api/mailbox/' + input('in-mailbox-id'))
      if (!list.ok) return null
      const m = new RegExp('<Name>' + file.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '</Name>\\s*<ID>(\\d+)</ID>').exec(list.text)
      return m ? 'Uploaded as mailbox file ' + m[1] + ' (confirmed with passthrough GET api/mailbox), but the SDK call returned an error (WebUI bug).' : null
    }
  )

  // ---- Manual: BigFix Query ---------------------------------------------------------------------

  SAT.test({
    id: 'cq.submit',
    group: 'BigFix Query',
    title: 'Submit a client query to the given computers',
    api: 'POST /api/sdk/clientquery',
    async run(t) {
      SAT.state.queryId = null
      const ids = idList(input('in-cq-ids'))
      if (!ids.length) return t.skip('enter one or more computer ids')
      const body = { ClientQuery: { ApplicabilityRelevance: input('in-cq-applicability') || 'true', QueryText: input('in-cq-query') || 'computer name', Target: { ComputerID: ids } } }
      const res = await SAT.api('POST', '/api/sdk/clientquery', { json: body })
      if (!res.ok) return t.fail(SAT.message(res))
      SAT.state.queryId = queryIdFrom(res)
      SAT.state.queryTargets = ids.length
      SAT.state.queryId ? t.pass('query id ' + SAT.state.queryId) : t.warn('submitted, but no query id found in ' + SAT.snippet(res.text, 300))
    }
  })

  SAT.test({
    id: 'cq.results',
    group: 'BigFix Query',
    title: 'Poll the query results (up to 60 seconds)',
    api: 'GET /api/sdk/clientqueryresults/{queryId}',
    timeout: 75000,
    async run(t) {
      if (!SAT.state.queryId) return t.skip('cq.submit did not return a query id')
      let last = null
      for (let i = 0; i < 12; i++) {
        if (i) await sleep(5000)
        last = await SAT.api('GET', '/api/sdk/clientqueryresults/' + SAT.state.queryId + '?stats=1')
        if (!last.ok) return t.fail(SAT.message(last))
        const value = bodyValue(last)
        const rows = (value && (value.results || value.result || value.Results)) || (Array.isArray(value) ? value : null)
        if (rows && rows.length) return t.pass(rows.length + ' result(s): ' + SAT.snippet(JSON.stringify(rows[0]), 200))
      }
      t.warn('no agent answered within 60s (API worked). Last response: ' + SAT.snippet(last && last.text, 300))
    }
  })

  SAT.runClientQuery = function () {
    const ids = idList(input('in-cq-ids'))
    if (!ids.length) {
      SAT.log('WARN', 'Enter one or more computer ids for the BigFix Query test')
      return
    }
    if (!SAT.confirm('Send BigFix Query "' + (input('in-cq-query') || 'computer name') + '" to computer(s) ' + ids.join(', ') + '?\nQueries are read-only on the client.')) return
    SAT.runIds(['cq.submit', 'cq.results'], 'BigFix Query')
  }

  // ---- Manual: passthrough with any method ------------------------------------------------------

  ;['POST', 'PUT', 'DELETE'].forEach((method) =>
    SAT.test({
      id: 'pt.' + method.toLowerCase(),
      group: 'Passthrough',
      title: method + ' through the passthrough (uses the uri and body fields)',
      api: method + ' /api/sdk/passthrough/{uri}',
      async run(t) {
        const uri = input('in-pt-uri').replace(/^\/+/, '')
        if (!uri) return t.skip('enter a uri such as api/site/custom/MySite')
        const body = document.getElementById('in-pt-body').value
        if (!SAT.confirm(method + ' ' + uri + ' on the BigFix server?\n' + (body ? body.length + ' character body' : 'no body'))) return t.skip('cancelled')
        const res = await SAT.api(method, '/api/sdk/passthrough/' + uri, method === 'DELETE' ? {} : { body, contentType: input('in-pt-type') || 'application/xml' })
        res.ok ? t.pass(res.status + ': ' + SAT.snippet(res.text, 300)) : t.fail(SAT.message(res))
      }
    })
  )

  SAT.test({
    id: 'pt.get.custom',
    group: 'Passthrough',
    title: 'GET any uri through the passthrough (uses the uri field)',
    api: 'GET /api/sdk/passthrough/{uri}',
    async run(t) {
      const uri = input('in-pt-uri').replace(/^\/+/, '')
      if (!uri) return t.skip('enter a uri such as api/serverinfo')
      const res = await SAT.api('GET', '/api/sdk/passthrough/' + uri)
      res.ok ? t.pass(res.status + ', ' + res.text.length + ' bytes: ' + SAT.snippet(res.text, 300)) : t.fail(SAT.message(res))
    }
  })
})(window.SAT)
