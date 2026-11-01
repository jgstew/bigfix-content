// Console Dashboards - the dashboards stored in BigFix sites, the way the console lists them.
//   1. Session relevance's "bes wizards" lists every dashboard in a site the operator can see: name, dashboard id
//      (the .ojo file name), site, and the site's REST path (seen on 11.0.7 with BES Explorer answering: 164 wizards in
//      24 sites). The console's "url of <wizard>" is "siteid:<id>,<file>" for external sites but BES Explorer's own
//      file path for custom sites, so the file is found by name in the site's file list instead.
//   2. When one is chosen, the site's files are listed through the REST API (GET /api/site/<type>/<name>/files via
//      the SDK passthrough, "Can use REST API") and the .ojo file is downloaded. The same listing is the source for its
//      relative scripts and stylesheets (companions.js), the way the console loads them from the site's folder.
// No cache is kept: the relevance answers in well under a second, and file lists are read only for chosen sites.
'use strict'
;(function () {
  // Each site's REST path, %-encoded once in relevance ("%2520" in a relevance string is "%20"), like the Web Reports
  // Renderer's site query; companions.js encodes it once more for the WebUI passthrough
  const SITE_PATH =
    '"/api/site/" & (if (master site flag of site of it) then "master" else ((if (external site flag of site of it) then "external" else if (custom site flag of site of it) then "custom" else if (operator site flag of site of it) then "operator" else "<unknown>") & "/" & (concatenation "%2526" of substrings separated by "&" of concatenation "%253F" of substrings separated by "?" of concatenation "%2523" of substrings separated by "#" of concatenation "%2520" of substrings separated by " " of concatenation "%252F" of substrings separated by "/" of concatenation "%2525" of substrings separated by "%25" of name of site of it)))'
  const WIZARDS_QUERY = '(name of it, dashboard id of it, name of site of it, ' + SITE_PATH + ', (if custom site flag of site of it then "custom" else if external site flag of site of it then "external" else if master site flag of site of it then "master" else "operator")) of bes wizards whose (exists site of it and exists dashboard id of it)'
  // files a dashboard can load by relative name
  const LOADABLE_RE = /\.(js|json|css|html?|txt|xml|svg|png|gif|jpe?g|bmp|ico|ojo)$/i

  const xsrf = () => window.WebUIRelevance.xsrfToken()

  // -> [{ name, id, site, path, siteType }]
  async function listDashboards() {
    const response = await fetch(window.WebUIRelevance.SDK_URL, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-XSRF-TOKEN': xsrf() },
      body: JSON.stringify({ session_relevance: window.WebUIRelevance.prepare('sdk', WIZARDS_QUERY) })
    })
    const text = await response.text()
    let body = null
    try {
      body = JSON.parse(text)
    } catch (e) {
      // not JSON
    }
    if (!response.ok) throw new Error((body && body.message) || 'HTTP ' + response.status)
    const rows = (body && body.value) || []
    return (Array.isArray(rows) ? rows : [rows]).filter(Array.isArray).map((r) => ({ name: r[0], id: r[1], site: r[2], path: r[3], siteType: r[4] }))
  }

  // Site file lists, read once per site per page: { name, path, files: { "<file name>": id } }
  const sites = new Map()
  async function siteFiles(dashboard) {
    if (sites.has(dashboard.site)) return sites.get(dashboard.site)
    const promise = (async () => {
      const response = await fetch(window.WRRFILES.passthrough(dashboard.path, '/files'), { credentials: 'same-origin', headers: { 'X-XSRF-TOKEN': xsrf() } })
      if (!response.ok) {
        const err = new Error(response.status === 403 ? 'listing site files needs the "Can use REST API" permission' : 'HTTP ' + response.status)
        err.status = response.status
        throw err
      }
      const doc = new DOMParser().parseFromString(await response.text(), 'application/xml')
      const text = (el, tag) => ((el.getElementsByTagName(tag)[0] || {}).textContent || '').trim()
      const files = {}
      Array.from(doc.getElementsByTagName('SiteFile')).forEach((f) => {
        const name = text(f, 'Name')
        if (LOADABLE_RE.test(name) && text(f, 'IsClientFile') !== '1') files[name] = Number(text(f, 'ID'))
      })
      return { name: dashboard.site, path: dashboard.path, files }
    })()
    sites.set(dashboard.site, promise)
    promise.catch(() => sites.delete(dashboard.site))
    return promise
  }

  // The dashboard's file text and a companions.js file source for its site
  async function open(dashboard) {
    const site = await siteFiles(dashboard)
    const key = Object.keys(site.files).find((n) => n.toLowerCase() === String(dashboard.id).toLowerCase())
    if (!key) throw new Error(dashboard.id + ' is not among the files of site "' + dashboard.site + '"')
    const text = await window.WRRFILES.getSiteFile(site.path, site.files[key])
    return { text, site, source: window.WRRFILES.fromSite(site) }
  }

  window.CDDASH = { listDashboards, siteFiles, open, WIZARDS_QUERY }
})()
