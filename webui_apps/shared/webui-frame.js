// WebUI frame for the plain HTML/JS apps in webui_apps/: draws WebUI's top navigation bar (BigFix, Devices, Apps,
// Deployments, Reports, Extensions, the gear menu, and log out) from the same JSON the WebUI server gives its own
// pages, with this file's own markup and CSS. No HCL code is copied or bundled: WebUI has no shared frame to load
// (each WebUI app bundles its own nav bar), but its menus are data (seen on BigFix 11.0.7.61):
//   GET /apps                          {data: [{route, client: {tabs: [{label, route, id}]}}]}
//       the "/" entry's tabs are the top items (Devices, Deployments, Reports); every other tab except appAdmin is
//       an Apps menu item, sorted by label (that is the list WebUI shows)
//   GET /getGearApps                   {showX: {appName, route, enabled?}}: the gear menu, sorted by appName; entries
//       with enabled: false or no route are left out
//   GET /ui_extensions/get_extensions  [{name, displayName, siteDisplayName, url, status}]: the Extensions menu
// Each app's pack.py copies this file into the package as static/js/webui-frame.js; load it with <script defer>.
// It hides the page's own header (.shell-header) and puts the bar at the top of <body>. The bar is drawn at once
// with WebUI's usual items and filled in when the data arrives; when a request fails, the usual items stay.
'use strict'
;(function () {
  if (window.top !== window.self || window.WebUIFrame) return // not inside frames (the renderer's report iframe)

  const BLUE = '#0066b0' // WebUI's nav bar and link blue
  const DEFAULT_TOP = [
    { label: 'Devices', route: '/framework/next/devices' },
    { label: 'Deployments', route: '/framework/next/deployments' },
    { label: 'Reports', route: '/reports/next' }
  ]
  // the gear menu's labels; WebUI's bundle maps these appName values to text
  const GEAR_LABELS = {
    agentInstallation: 'Agent Installation',
    appadmin: 'Application Updates',
    extensionsManagement: 'Extensions Management',
    insights: 'Insights',
    ivr: 'Access IVR Data',
    pluginConfig: 'Plugin Management',
    pps: 'Permissions',
    ssaConfig: 'Self-Service Application'
  }

  const CSS = `
.wuf-bar { flex: none; display: flex; align-items: stretch; height: 50px; padding: 0 15px; background: ${BLUE}; color: #fff;
  font-family: Roboto, -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Helvetica Neue', Arial, sans-serif; font-size: 14px;
  font-weight: 500; letter-spacing: 0.15px; position: relative; z-index: 900; }
.wuf-bar * { box-sizing: border-box; }
.wuf-left, .wuf-right { display: flex; align-items: stretch; }
.wuf-left { flex: 1 1 auto; min-width: 0; }
.wuf-logo { display: flex; align-items: center; padding: 0; color: #fff; text-decoration: none;
  font-size: 18px; font-weight: 600; letter-spacing: 0; }
.wuf-logo svg { flex: none; }
.wuf-items { display: flex; align-items: stretch; padding-left: 20px; }
.wuf-item, .wuf-toggle { display: flex; align-items: center; gap: 6px; padding: 8px 16px; color: #fff; text-decoration: none;
  background: none; border: 0; font: inherit; letter-spacing: inherit; white-space: nowrap; cursor: pointer; }
.wuf-item:hover, .wuf-toggle:hover, .wuf-toggle[aria-expanded='true'], .wuf-item:focus-visible, .wuf-toggle:focus-visible {
  background: rgba(0, 0, 0, 0.18); outline: none; }
.wuf-caret { width: 10px; height: 10px; opacity: 0.9; }
.wuf-menu-wrap { position: relative; display: flex; }
.wuf-menu { position: absolute; top: 100%; left: 0; min-width: 12rem; max-height: 70vh; overflow-y: auto; padding: 4px 0;
  background: #fff; color: #161616; border: 1px solid #e0e0e0; box-shadow: 0 2px 6px rgba(0, 0, 0, 0.3); font-weight: 400;
  letter-spacing: 0; }
.wuf-right .wuf-menu { left: auto; right: 0; }
.wuf-menu a { display: block; padding: 7px 16px; color: #161616; text-decoration: none; white-space: nowrap; }
.wuf-menu a:hover, .wuf-menu a:focus-visible { background: #e5f0f9; outline: none; }
.wuf-menu a[aria-current='page'] { font-weight: 600; }
.wuf-menu .wuf-muted { color: #6f6f6f; }
.wuf-menu .wuf-empty { padding: 7px 16px; color: #6f6f6f; white-space: nowrap; }
`

  const el = (tag, attrs, children) => {
    const node = document.createElement(tag)
    Object.entries(attrs || {}).forEach(([k, v]) => {
      if (k === 'text') node.textContent = v
      else if (k === 'html') node.innerHTML = v // only for the fixed icons below
      else node.setAttribute(k, v)
    })
    ;(children || []).forEach((c) => c && node.appendChild(c))
    return node
  }
  const icon = (svg) => el('span', { html: svg, 'aria-hidden': 'true', style: 'display:inline-flex' })
  const CARET = '<svg class="wuf-caret" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M2 3.5l3 3 3-3"/></svg>'
  // the BigFix logo as WebUI's bar shows it: 100 x 27.6 px, white, with a transparent background
  const LOGO =
    '<svg width="100" height="27.6" viewBox="0 0 1450 400" role="img" aria-label="BigFix">' +
    '<path fill="none" d="M-24.2-15.3h1357.6v420.9H-24.2z"/>' +
    '<path fill="#fff" d="M502.8 107.4h83.9c21.4 0 38.2 5.9 48.9 16.6 8.3 8.3 12.6 18.4 12.6 31v.5c0 22.4-12.8 34.5-26.7 41.7 21.9 7.5 37.1 20 37.1 45.4v.5c0 33.4-27.5 51.3-69.2 51.3h-86.6v-187zm112.5 52.9c0-14.7-11.8-23.8-32.9-23.8h-47.3v49.7H580c21.1 0 35.3-8.3 35.3-25.4v-.5zM587.2 214h-52.1v51.3h54.5c22.4 0 36.1-8.8 36.1-25.7v-.5c0-15.8-12.6-25.1-38.5-25.1zM692.5 100.9h34.7v30.8h-34.7v-30.8zm1.3 52.4h32.3v141.1h-32.3V153.3zM768.1 320.8l12-24.3c15.2 9.4 31 15 50.3 15 28.9 0 44.6-15 44.6-43.3v-10.9c-11.8 15.2-26.5 25.9-49.7 25.9-33.1 0-64.1-24.6-64.1-66v-.5c0-41.7 31.3-66.3 64.1-66.3 23.8 0 38.5 11 49.4 24v-21.1H907v112.2c0 23.8-6.2 41.4-17.9 53.2-12.8 12.8-32.6 19-58 19-23.1 0-44.8-5.9-63-16.9zm107.2-103.9v-.5c0-23-19-38.7-41.4-38.7s-40.1 15.5-40.1 38.7v.5c0 23 17.9 38.7 40.1 38.7 22.4 0 41.4-15.7 41.4-38.7zM951.4 107.4h139.2v29.9H984.3v51h94.4v29.9h-94.4v76.2h-32.9v-187zM1123.5 100.9h34.7v30.8h-34.7v-30.8zm1.4 52.4h32.3v141.1h-32.3V153.3zM1256.8 200.6l32.6-47.3h34.5l-49.7 68.9 51.8 72.1h-35.3l-34.7-50.2-34.5 50.2H1187l51.6-71.9-49.7-69.2h35.3l32.6 47.4zM209.7 7.6c-13.2-.1-26.4 1.3-39.3 4.3v86.6c12.5-4.7 25.9-7.1 39.3-7 61.1.1 110.5 49.7 110.4 110.8s-49.7 110.5-110.8 110.4c-58.4-.1-106.7-45.6-110.2-104l1-167C12.4 102.2-9.6 222.3 50.9 310s180.6 109.6 268.3 49.1 109.6-180.6 49.1-268.3C332.3 38.7 273 7.6 209.7 7.6z"/>' +
    '<circle fill="#fff" cx="210.1" cy="201.5" r="51"/></svg>'
  const GEAR =
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="#fff"><path d="M19.4 13a7.6 7.6 0 0 0 0-2l2.1-1.6-2-3.5-2.5 1a7.3 7.3 0 0 0-1.7-1L15 3.3h-4l-.4 2.6a7.3 7.3 0 0 0-1.7 1l-2.5-1-2 3.5L6.5 11a7.6 7.6 0 0 0 0 2l-2.1 1.6 2 3.5 2.5-1a7.3 7.3 0 0 0 1.7 1l.4 2.6h4l.4-2.6a7.3 7.3 0 0 0 1.7-1l2.5 1 2-3.5zM13 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z"/></svg>'
  const POWER =
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round"><path d="M12 3v8"/><path d="M6.3 6.3a8 8 0 1 0 11.4 0"/></svg>'

  async function getJson(url) {
    const response = await fetch(url, { credentials: 'same-origin', headers: { Accept: 'application/json' } })
    if (!response.ok) throw new Error(url + ' ' + response.status)
    return response.json()
  }

  // ---- drop-down menus: one open at a time; click outside or Esc closes it ----

  const menus = []
  function closeAll(except) {
    menus.forEach((m) => {
      if (m !== except) {
        m.menu.hidden = true
        m.toggle.setAttribute('aria-expanded', 'false')
      }
    })
  }
  function dropdown(label, content, extraClass) {
    const toggle = el('button', { type: 'button', class: 'wuf-toggle' + (extraClass ? ' ' + extraClass : ''), 'aria-haspopup': 'true', 'aria-expanded': 'false' })
    if (typeof label === 'string') toggle.appendChild(document.createTextNode(label))
    else toggle.appendChild(label)
    toggle.appendChild(icon(CARET))
    const menu = el('div', { class: 'wuf-menu', role: 'menu' })
    menu.hidden = true
    const m = { toggle, menu }
    menus.push(m)
    toggle.addEventListener('click', (e) => {
      e.stopPropagation()
      const open = menu.hidden
      closeAll(m)
      menu.hidden = !open
      toggle.setAttribute('aria-expanded', String(open))
      if (open) {
        const first = menu.querySelector('a')
        if (first) first.focus()
      }
    })
    const wrap = el('div', { class: 'wuf-menu-wrap' }, [toggle, menu])
    m.fill = (items, emptyText) => {
      menu.replaceChildren()
      if (!items.length) menu.appendChild(el('div', { class: 'wuf-empty', text: emptyText || 'None' }))
      items.forEach((item) => {
        const a = el('a', { href: item.href, role: 'menuitem' })
        a.appendChild(document.createTextNode(item.label))
        if (item.note) a.appendChild(el('span', { class: 'wuf-muted', text: ' (' + item.note + ')' }))
        if (item.current) a.setAttribute('aria-current', 'page')
        if (item.title) a.title = item.title
        menu.appendChild(a)
      })
    }
    m.fill([], 'Loading...')
    return Object.assign(wrap, { menu: m })
  }
  document.addEventListener('click', () => closeAll())
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const open = menus.find((m) => !m.menu.hidden)
      closeAll()
      if (open) open.toggle.focus()
    }
  })

  // ---- the bar ----

  function mount() {
    if (document.querySelector('.wuf-bar')) return
    document.head.appendChild(el('style', { text: CSS }))
    // WebUI's own Roboto, from the WebUI server; without it the system font is used
    document.head.appendChild(el('link', { rel: 'stylesheet', href: '/fonts/fonts.css' }))

    const items = el('div', { class: 'wuf-items' })
    const apps = dropdown('Apps')
    const extensions = dropdown('Extensions')
    const gear = dropdown(icon(GEAR))
    gear.menu.toggle.title = 'Settings'
    gear.menu.toggle.setAttribute('aria-label', 'Settings')
    const logout = el('a', { class: 'wuf-item', href: '/logout', title: 'Log out', 'aria-label': 'Log out' }, [icon(POWER)])
    const bar = el('nav', { class: 'wuf-bar', 'aria-label': 'BigFix WebUI' }, [
      el('div', { class: 'wuf-left' }, [el('a', { class: 'wuf-logo', href: '/', title: 'BigFix WebUI home', 'aria-label': 'BigFix WebUI home' }, [icon(LOGO)]), items]),
      el('div', { class: 'wuf-right' }, [gear, logout])
    ])

    // Devices, Apps, Deployments, Reports, Extensions, in WebUI's order
    function drawTop(top) {
      items.replaceChildren()
      top.forEach((t, i) => {
        items.appendChild(el('a', { class: 'wuf-item', href: t.route, text: t.label }))
        if (i === 0) items.appendChild(apps)
      })
      if (!top.length) items.appendChild(apps)
      items.appendChild(extensions)
    }
    drawTop(DEFAULT_TOP)

    const header = document.querySelector('.shell-header')
    if (header) header.hidden = true
    document.body.insertBefore(bar, document.body.firstChild)

    getJson('/apps')
      .then((body) => {
        const entries = (body && body.data) || []
        const root = entries.find((a) => a.route === '/')
        const rootTabs = (root && root.client && root.client.tabs) || []
        if (rootTabs.length) drawTop(rootTabs.map((t) => ({ label: t.label, route: t.route })))
        const appTabs = entries
          .filter((a) => a.route !== '/' && a.client && Array.isArray(a.client.tabs))
          .flatMap((a) => a.client.tabs)
          .filter((t) => t && t.label && t.route && String(t.id).toLowerCase() !== 'appadmin')
          .sort((a, b) => a.label.localeCompare(b.label))
        apps.menu.fill(appTabs.map((t) => ({ label: t.label, href: t.route })), 'No apps')
      })
      .catch(() => apps.menu.fill([], 'Apps are not available'))

    getJson('/ui_extensions/get_extensions')
      .then((list) => {
        const here = location.pathname.replace(/\/+$/, '')
        const installed = (Array.isArray(list) ? list : [])
          .filter((x) => x && x.url && (!x.status || /installed/i.test(x.status)))
          .sort((a, b) => String(a.displayName || a.name).localeCompare(String(b.displayName || b.name)))
        extensions.menu.fill(
          installed.map((x) => ({
            label: x.displayName || x.name,
            note: x.siteDisplayName || x.siteName,
            href: x.url,
            title: x.description || '',
            current: String(x.url).replace(/\/+$/, '') === here
          })),
          'No extensions'
        )
      })
      .catch(() => extensions.menu.fill([{ label: 'Extensions Management', href: '/ui_extensions/next' }]))

    getJson('/getGearApps')
      .then((gearApps) => {
        const entries = Object.values(gearApps || {})
          .filter((g) => g && g.route && g.enabled !== false)
          .sort((a, b) => String(a.appName).toLowerCase().localeCompare(String(b.appName).toLowerCase()))
        gear.menu.fill(entries.map((g) => ({ label: GEAR_LABELS[g.appName] || g.appName, href: g.route })), 'No settings')
      })
      .catch(() => gear.menu.fill([{ label: 'Extensions Management', href: '/ui_extensions/next' }]))
  }

  window.WebUIFrame = { mount }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount)
  else mount()
})()
