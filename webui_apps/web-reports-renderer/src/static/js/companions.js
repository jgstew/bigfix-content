// Web Reports Renderer - companion files: the scripts, stylesheets and other files a report loads by relative name.
// In Web Reports a site report renders with <base href="/SiteData/<server>/Sites/<site>/">, so src="x.js" loads the
// site's file x.js (confirmed on 11.0.7). Here the report runs in a srcdoc iframe under WebUI's extension CSP:
//   - scripts: script-src allows 'self' and inline, but the files come back as application/octet-stream with
//     nosniff, and blob: is not allowed, so each one is INLINED as <script>...</script>
//   - stylesheets: the same, INLINED as <style>, with relative url() values inside resolved from the same source
//   - images: img-src allows blob:, so they become blob: URLs, but only when the source has the real bytes
//   - fonts: default-src 'self' allows neither blob: nor data:, so they cannot load
// A "file source" is where the files come from. Any object with this shape works:
//   { label, has(name) -> bool, getText(name) -> Promise<string>, getBlob(name) -> Promise<Blob> | null }
// fromSite() builds one for a BigFix site (REST through the SDK passthrough). The WebUI passthrough decodes every
// file as UTF-8, which corrupts binary files (a PNG starts ef bf bd 50 4e 47), so a site source has no getBlob.
// A source built from uploaded files could return real blobs; resolve() does not change for it.
'use strict'
;(function () {
  const CONCURRENCY = 6

  // Name matching: Web Reports' site folders are flat, so only the last path segment counts. The query and
  // fragment are dropped, %xx is decoded, and case is ignored.
  function fileKey(ref) {
    let name = String(ref).split('#')[0].split('?')[0].replace(/\\/g, '/').split('/').pop()
    try {
      name = decodeURIComponent(name)
    } catch (e) {
      // keep it as written
    }
    return name.trim().toLowerCase()
  }

  // Relative references only: not a scheme (http:, data:, blob:, javascript:, linkid:, ...), not //host, not /path,
  // not #fragment, and not a template placeholder left in the file (${...}, %PUBLIC_URL%, {{...}})
  const isRelative = (ref) => !!ref && !/^([a-z][a-z0-9+.-]*:|\/|#)/i.test(ref) && !/[${}%]/.test(ref.split('?')[0].replace(/%[0-9a-f]{2}/gi, ''))

  // Runs fn over items with at most `limit` in flight.
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

  const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  // an inlined file must not end the <script>/<style> element early
  const inlineSafe = (text, tag) => text.replace(new RegExp('</(' + tag + ')', 'gi'), '<\\/$1')
  // attribute names must start after whitespace, so "src" does not match "data-src"
  const attr = (attrs, name) => {
    const m = new RegExp('(?:^|\\s)' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s"\'>]+))', 'i').exec(attrs)
    return m ? m[1] ?? m[2] ?? m[3] : null
  }
  // removes attributes with or without a value (defer, async)
  const dropAttrs = (attrs, names) => names.reduce((a, n) => a.replace(new RegExp('(^|\\s+)' + n + '(?:\\s*=\\s*(?:"[^"]*"|\'[^\']*\'|[^\\s>]+))?(?=\\s|/|$)', 'gi'), ''), attrs)

  const SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi
  const LINK_RE = /<link\b([^>]*)>/gi
  const IMG_RE = /(<(?:img|input|source)\b[^>]*?\bsrc\s*=\s*)(["'])([^"']*)\2/gi
  const CSS_URL_RE = /url\(\s*(["']?)([^"')]+)\1\s*\)/gi

  // Replaces relative url() values in CSS with blob: URLs when the source has the bytes. Returns the CSS and the
  // references it could not resolve.
  async function resolveCss(css, source, blobFor) {
    const refs = new Set()
    css.replace(CSS_URL_RE, (m, q, ref) => {
      if (isRelative(ref.trim())) refs.add(ref.trim())
      return m
    })
    const urls = new Map()
    const missing = []
    for (const ref of refs) {
      const url = source.has(fileKey(ref)) ? await blobFor(ref) : null
      if (url) urls.set(ref, url)
      else missing.push(ref)
    }
    return { css: css.replace(CSS_URL_RE, (m, q, ref) => (urls.has(ref.trim()) ? 'url("' + urls.get(ref.trim()) + '")' : m)), missing }
  }

  // Resolves the report's relative scripts, stylesheets and images from `source`. Returns
  // { html, inlined: [names], images: [names], missing: [refs], binary: [refs] } where binary lists files the
  // source has but cannot provide as bytes (images from a site).
  async function resolve(html, source) {
    const result = { inlined: [], images: [], missing: [], binary: [] }
    if (!source) return Object.assign({ html }, result)

    // 1. set every <script> element aside behind a placeholder, so the stylesheet and image passes never edit
    //    JavaScript: jquery.jqplot.js, for one, has <link rel="stylesheet" href="jquery.jqplot.css"> in a comment,
    //    and reports build <link> and <img> tags in strings
    const scriptElements = []
    const scripts = []
    html = html.replace(SCRIPT_RE, (m, attrs, body) => {
      const src = attr(attrs, 'src')
      if (src && isRelative(src)) scripts.push(src)
      scriptElements.push({ m, attrs, src })
      return '\u0000wrr-script-' + (scriptElements.length - 1) + '\u0000'
    })

    // 2. collect the relative names the other elements need, and fetch each file once
    const sheets = []
    html.replace(LINK_RE, (m, attrs) => {
      const href = attr(attrs, 'href')
      if (href && isRelative(href) && /stylesheet/i.test(attr(attrs, 'rel') || '')) sheets.push(href)
      return m
    })
    const wanted = Array.from(new Set(scripts.concat(sheets).map(fileKey))).filter((k) => source.has(k))
    const texts = new Map()
    await mapLimit(wanted, CONCURRENCY, async (key) => {
      try {
        texts.set(key, await source.getText(key))
      } catch (err) {
        result.missing.push(key + ' (' + err.message + ')')
      }
    })

    const blobUrls = new Map()
    async function blobFor(ref) {
      const key = fileKey(ref)
      if (blobUrls.has(key)) return blobUrls.get(key)
      let url = null
      if (typeof source.getBlob === 'function') {
        const blob = await source.getBlob(key)
        if (blob) url = URL.createObjectURL(blob)
      }
      if (!url) result.binary.push(ref)
      blobUrls.set(key, url)
      return url
    }

    // 3. scripts: inline the file, keeping the other attributes (type, id; defer has no effect inline)
    const scriptHtml = scriptElements.map(({ m, attrs, src }) => {
      if (!src || !isRelative(src)) return m
      const key = fileKey(src)
      if (!texts.has(key)) {
        if (!source.has(key)) result.missing.push(src)
        return m
      }
      result.inlined.push(key)
      const kept = dropAttrs(attrs, ['src', 'integrity', 'crossorigin', 'async', 'defer'])
      return '<script' + kept + ' data-wrr-file="' + escapeHtml(key) + '">' + inlineSafe(texts.get(key), 'script') + '\n</scr' + 'ipt>'
    })

    // 4. stylesheets: inline as <style>, resolving url() inside them
    const styles = new Map()
    for (const href of sheets) {
      const key = fileKey(href)
      if (!texts.has(key) || styles.has(key)) continue
      const css = await resolveCss(texts.get(key), source, blobFor)
      css.missing.forEach((ref) => source.has(fileKey(ref)) || result.missing.push(ref + ' (in ' + key + ')'))
      styles.set(key, css.css)
    }
    html = html.replace(LINK_RE, (m, attrs) => {
      const href = attr(attrs, 'href')
      if (!href || !isRelative(href) || !/stylesheet/i.test(attr(attrs, 'rel') || '')) return m
      const key = fileKey(href)
      if (!styles.has(key)) {
        if (!source.has(key)) result.missing.push(href)
        return m
      }
      result.inlined.push(key)
      const media = attr(attrs, 'media')
      return '<style data-wrr-file="' + escapeHtml(key) + '"' + (media ? ' media="' + escapeHtml(media) + '"' : '') + '>' + inlineSafe(styles.get(key), 'style') + '\n</style>'
    })

    // 5. images and inline style url() values
    const imageRefs = []
    html.replace(IMG_RE, (m, before, q, ref) => {
      if (isRelative(ref)) imageRefs.push(ref)
      return m
    })
    for (const ref of Array.from(new Set(imageRefs))) {
      if (!source.has(fileKey(ref))) result.missing.push(ref)
      else await blobFor(ref)
    }
    html = html.replace(IMG_RE, (m, before, q, ref) => {
      const url = isRelative(ref) ? blobUrls.get(fileKey(ref)) : null
      if (!url) return m
      result.images.push(fileKey(ref))
      return before + q + url + q
    })
    html = html.replace(/(\bstyle\s*=\s*)(["'])([^"']*url\([^"']*)\2/gi, (m, before, q, css) => {
      // inline style attributes: only already-fetched blobs are used here (no awaiting inside replace)
      return before + q + css.replace(CSS_URL_RE, (u, uq, ref) => (isRelative(ref.trim()) && blobUrls.get(fileKey(ref)) ? 'url(' + blobUrls.get(fileKey(ref)) + ')' : u)) + q
    })

    // 6. put the script elements back
    html = html.replace(/\u0000wrr-script-(\d+)\u0000/g, (m, i) => scriptHtml[Number(i)])

    result.missing = Array.from(new Set(result.missing))
    result.binary = Array.from(new Set(result.binary))
    return Object.assign({ html }, result)
  }

  // ---- file source: a BigFix site, through the REST API (SDK passthrough) --------------------------------------

  function xsrfToken() {
    const match = document.cookie.split('; ').find((c) => c.startsWith('XSRF-TOKEN='))
    return match ? decodeURIComponent(match.slice('XSRF-TOKEN='.length)) : ''
  }

  // REST site path ("/api/site/external/BES%20Support", from session relevance, each name part already %-encoded
  // once) -> the SDK passthrough URL for a sub-path. WebUI decodes the passthrough path once before forwarding it,
  // so every % is encoded again: BES%2520Support. A single-encoded path fails with 500 "Request path contains
  // unescaped characters" (11.0.7).
  const passthrough = (sitePath, sub) => '/api/sdk/passthrough/' + sitePath.replace(/^\/+/, '').replace(/\/files$/, '').replace(/%/g, '%25') + sub

  async function getSiteFile(sitePath, id) {
    const response = await fetch(passthrough(sitePath, '/file/' + encodeURIComponent(id)), {
      credentials: 'same-origin',
      headers: { 'X-XSRF-TOKEN': xsrfToken() }
    })
    if (!response.ok) throw new Error('HTTP ' + response.status)
    return response.text()
  }

  // site: { name, path, files: { "<file name>": id } }
  function fromSite(site) {
    const ids = new Map(Object.entries(site.files || {}).map(([name, id]) => [name.toLowerCase(), id]))
    const cache = new Map()
    return {
      label: 'site "' + site.name + '"',
      has: (name) => ids.has(fileKey(name)),
      getText(name) {
        const key = fileKey(name)
        if (!ids.has(key)) return Promise.reject(new Error('not in ' + site.name))
        if (!cache.has(key)) cache.set(key, getSiteFile(site.path, ids.get(key)))
        return cache.get(key)
      },
      getBlob: null // the passthrough corrupts binary files
    }
  }

  window.WRRFILES = { resolve, fromSite, fileKey, isRelative, passthrough, getSiteFile }
})()
