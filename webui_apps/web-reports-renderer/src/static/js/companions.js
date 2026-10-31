// Web Reports Renderer - companion files: the scripts, stylesheets and other files a report loads by relative name.
// In Web Reports a site report renders with <base href="/SiteData/<server>/Sites/<site>/">, so src="x.js" loads the
// site's file x.js (confirmed on 11.0.7). Here the report runs in a srcdoc iframe under WebUI's extension CSP:
//   - scripts: script-src allows 'self' and inline, but the files come back as application/octet-stream with
//     nosniff, and blob: is not allowed, so each one is INLINED as <script>...</script>
//   - stylesheets: the same, INLINED as <style>, with relative url() values inside resolved from the same source
//   - images: img-src allows blob:, so they become blob: URLs, but only when the source has the real bytes (SVG,
//     which is text, survives the passthrough)
//   - fonts: default-src 'self' allows neither blob: nor data:, so only the renderer's bundled copies can load
// A file the report's source lacks, or has only as corrupted bytes, is looked up by name in a pool (makePool):
// the renderer's bundled library copies and the text files of the other report sites, newest version first.
// A "file source" is where the files come from. Any object with this shape works:
//   { label, has(name) -> bool, getText(name) -> Promise<string>, getBlob(name) -> Promise<Blob> | null }
// fromSite() builds one for a BigFix site (REST through the SDK passthrough). The WebUI passthrough decodes every
// file as UTF-8, which corrupts binary files (a PNG starts ef bf bd 50 4e 47), so a site source has no getBlob.
// A site source's getBlob only answers for SVG. A source built from uploaded files could return real blobs;
// resolve() does not change for it.
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

  // ---- name matching across sources ----------------------------------------------------------------------------
  // When a file is not in the report's own source (or is there but cannot be used, like a corrupted PNG), the
  // "pool" is searched: the renderer's bundled library copies (static/libs, served by WebUI as real files, so
  // images and fonts work) and the text files of every listed report site.
  //   1. the same file name, newest version first
  //   2. otherwise the same "logical" name - version numbers, ".min", jQuery UI colors (_444444) and sizes
  //      (_256x240) removed, - and _ treated alike, and png/gif/jpg/svg treated as one image kind - newest first
  // Case 2 is not the file the report asked for, so it is reported as a substitution (the log warns).

  const IMAGE_EXT = /\.(png|gif|jpe?g|bmp|ico|svg|webp)$/i
  const FONT_EXT = /\.(woff2?|ttf|eot|otf)$/i
  const TEXT_EXT = /\.(js|css|json|html?|txt|xml|svg)$/i
  const kindOf = (key) => (IMAGE_EXT.test(key) ? 'image' : FONT_EXT.test(key) ? 'font' : ((/\.([a-z0-9]+)$/i.exec(key) || [])[1] || '').toLowerCase())

  function logicalKey(ref) {
    const key = fileKey(ref)
    const base = key
      .replace(/\.[a-z0-9]+$/i, '')
      .replace(/[._-]min$/, '')
      .replace(/[-_.]?v?\d+(?:\.\d+)+/g, '') // versions: -3.7.1, _2.2.3
      .replace(/[-_][0-9a-f]{6}(?=[-_.]|$)/g, '') // jQuery UI icon colors: _444444
      .replace(/[-_]\d+x\d+/g, '') // sizes: _256x240
      .replace(/[-_]+/g, '-')
      .replace(/^-|-$/g, '')
    return kindOf(key) + ':' + base
  }

  // "3.7.1" -> [3, 7, 1]; compares newest first
  const versionOf = (text) => ((/(\d+(?:\.\d+)+)/.exec(text) || [])[1] || '').split('.').filter(Boolean).map(Number)
  function newer(a, b) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if ((a[i] || 0) !== (b[i] || 0)) return (b[i] || 0) - (a[i] || 0)
    }
    return 0
  }

  const SVG_TYPE = 'image/svg+xml'

  // libs: [{ path: "jqueryui/1.12.1/images/ui-icons_444444_256x240.png", url }]  (bundled, binary-safe)
  // sites: [{ name, path, files: { name: id } }]  (text files only: the passthrough corrupts binary ones)
  function makePool({ libs = [], sites = [] } = {}) {
    const entries = []
    libs.forEach((l) => {
      const name = l.path.split('/').pop()
      entries.push({ key: fileKey(name), logical: logicalKey(name), version: versionOf(l.path.split('/')[1] || ''), name, from: 'the renderer\'s bundled ' + l.path.split('/')[0] + ' ' + (l.path.split('/')[1] || ''), url: l.url })
    })
    sites.forEach((site) =>
      Object.entries(site.files || {}).forEach(([name, id]) => {
        if (!TEXT_EXT.test(name)) return
        entries.push({ key: fileKey(name), logical: logicalKey(name), version: versionOf(name), name, from: 'site "' + site.name + '"', site: site.name, sitePath: site.path, id })
      })
    )
    const byKey = new Map()
    const byLogical = new Map()
    entries.forEach((e) => {
      byKey.set(e.key, (byKey.get(e.key) || []).concat(e))
      byLogical.set(e.logical, (byLogical.get(e.logical) || []).concat(e))
    })
    // want "text": anything readable as text; "asset": bundled files (real bytes) and SVG text from sites. Fonts
    // are therefore bundled copies only, which is also all the CSP allows (blob: and data: are blocked for fonts).
    const usable = (e, want) => (want === 'text' ? !!e.url || TEXT_EXT.test(e.key) : !!e.url || /\.svg$/i.test(e.key))
    const rank = (ownSite) => (a, b) => newer(a.version, b.version) || (a.site === ownSite ? -1 : 0) - (b.site === ownSite ? -1 : 0) || (a.url ? -1 : 0) - (b.url ? -1 : 0)
    return {
      size: entries.length,
      // An exact name wins outright only when it carries a version (jquery-1.7.2.min.js is that version). A name
      // without one (jquery.min.js) says nothing about the version, so the newest of all matching names wins.
      find(ref, want, ownSite) {
        const key = fileKey(ref)
        const exact = (byKey.get(key) || []).filter((e) => usable(e, want)).sort(rank(ownSite))
        if (exact.length && versionOf(key).length) return Object.assign({ exact: true }, exact[0])
        const logical = (byLogical.get(logicalKey(ref)) || []).filter((e) => usable(e, want)).sort(rank(ownSite))
        if (exact.length && (!logical.length || newer(exact[0].version, logical[0].version) <= 0)) return Object.assign({ exact: true }, exact[0])
        if (!logical.length) return null
        return Object.assign({ exact: logical[0].key === key }, logical[0])
      }
    }
  }

  // Rewrites relative url() values in CSS. baseUrl: the CSS came from that URL (a bundled file), so its relative
  // references are made absolute against it and need no lookup; otherwise each is looked up with assetFor().
  async function resolveCss(css, assetFor, baseUrl) {
    const refs = new Set()
    css.replace(CSS_URL_RE, (m, q, ref) => {
      if (isRelative(ref.trim())) refs.add(ref.trim())
      return m
    })
    const urls = new Map()
    const missing = []
    for (const ref of refs) {
      const url = baseUrl ? new URL(ref, baseUrl).href : await assetFor(ref)
      if (url) urls.set(ref, url)
      else missing.push(ref)
    }
    return { css: css.replace(CSS_URL_RE, (m, q, ref) => (urls.has(ref.trim()) ? 'url("' + urls.get(ref.trim()) + '")' : m)), missing }
  }

  const NO_SOURCE = { label: 'no source', has: () => false, getText: () => Promise.reject(new Error('no source')), getBlob: null }

  // Resolves the report's relative scripts, stylesheets, images and fonts from `source` (the report's site, or
  // null for an uploaded report), then from `pool` (makePool()). Returns
  //   { html, inlined: [names], images: [names], missing: [refs], binary: [refs], substituted: [{ref, name, from, exact}] }
  // binary lists files the source has but cannot provide as bytes and the pool could not replace.
  async function resolve(html, source, pool, ownSite) {
    source = source || NO_SOURCE
    const result = { inlined: [], images: [], missing: [], binary: [], substituted: [] }
    const noteSubstitute = (ref, hit) => result.substituted.push({ ref, name: hit.name, from: hit.from, exact: hit.exact })

    // Text of a script or stylesheet: { text } from the source or a site in the pool, { url } for a bundled copy
    // (same-origin, served with the right type, so it can be referenced instead of inlined), or null.
    const textCache = new Map()
    function textFor(ref) {
      const key = fileKey(ref)
      if (!textCache.has(key)) {
        textCache.set(
          key,
          (async () => {
            if (source.has(key)) {
              try {
                return { text: await source.getText(key) }
              } catch (err) {
                result.missing.push(ref + ' (' + err.message + ')')
              }
            }
            const hit = pool && pool.find(ref, 'text', ownSite)
            if (!hit) return null
            noteSubstitute(ref, hit)
            if (hit.url) return { url: hit.url }
            return { text: await getSiteFile(hit.sitePath, hit.id) }
          })().catch((err) => {
            result.missing.push(ref + ' (' + err.message + ')')
            return null
          })
        )
      }
      return textCache.get(key)
    }

    // URL of an image or font: a blob: URL (SVG text, or bytes from a source that has them), a bundled file's URL,
    // or null
    const assetCache = new Map()
    function assetFor(ref) {
      const key = fileKey(ref)
      if (!assetCache.has(key)) {
        assetCache.set(
          key,
          (async () => {
            const inSource = source.has(key)
            if (inSource && typeof source.getBlob === 'function') {
              const blob = await source.getBlob(key)
              if (blob) return URL.createObjectURL(blob)
            }
            const hit = pool && pool.find(ref, 'asset', ownSite)
            if (hit) {
              noteSubstitute(ref, hit)
              if (hit.url) return hit.url
              return URL.createObjectURL(new Blob([await getSiteFile(hit.sitePath, hit.id)], { type: SVG_TYPE }))
            }
            result[inSource ? 'binary' : 'missing'].push(ref)
            return null
          })().catch((err) => {
            result.missing.push(ref + ' (' + err.message + ')')
            return null
          })
        )
      }
      return assetCache.get(key)
    }

    // 1. set every <script> element aside behind a placeholder, so the stylesheet and image passes never edit
    //    JavaScript: jquery.jqplot.js, for one, has <link rel="stylesheet" href="jquery.jqplot.css"> in a comment,
    //    and reports build <link> and <img> tags in strings
    const scriptElements = []
    html = html.replace(SCRIPT_RE, (m, attrs) => {
      scriptElements.push({ m, attrs, src: attr(attrs, 'src') })
      return '\u0000wrr-script-' + (scriptElements.length - 1) + '\u0000'
    })

    // 2. scripts: inline the text, or point at the bundled copy. integrity no longer matches a substitute, and an
    //    inline script ignores it, so it is dropped with the other loading attributes.
    const scriptHtml = await mapLimit(scriptElements, CONCURRENCY, async ({ m, attrs, src }) => {
      if (!src || !isRelative(src)) return m
      const got = await textFor(src)
      const key = fileKey(src)
      if (!got) {
        if (!source.has(key)) result.missing.push(src)
        return m
      }
      result.inlined.push(key)
      if (got.url) return '<script' + dropAttrs(attrs, ['src', 'integrity', 'crossorigin', 'async']) + ' src="' + escapeHtml(got.url) + '" data-wrr-file="' + escapeHtml(key) + '"></scr' + 'ipt>'
      const kept = dropAttrs(attrs, ['src', 'integrity', 'crossorigin', 'async', 'defer'])
      return '<script' + kept + ' data-wrr-file="' + escapeHtml(key) + '">' + inlineSafe(got.text, 'script') + '\n</scr' + 'ipt>'
    })

    // 3. stylesheets: inline as <style> (url() inside resolved too), or point at the bundled copy
    const sheets = []
    html.replace(LINK_RE, (m, attrs) => {
      const href = attr(attrs, 'href')
      if (href && isRelative(href) && /stylesheet/i.test(attr(attrs, 'rel') || '')) sheets.push(href)
      return m
    })
    const styles = new Map()
    for (const href of sheets) {
      const key = fileKey(href)
      if (styles.has(key)) continue
      const got = await textFor(href)
      if (!got) continue
      if (got.url) {
        styles.set(key, { url: got.url })
        continue
      }
      const css = await resolveCss(got.text, assetFor)
      css.missing.forEach((ref) => result.missing.includes(ref) || result.missing.push(ref + ' (in ' + key + ')'))
      styles.set(key, { css: css.css })
    }
    html = html.replace(LINK_RE, (m, attrs) => {
      const href = attr(attrs, 'href')
      if (!href || !isRelative(href) || !/stylesheet/i.test(attr(attrs, 'rel') || '')) return m
      const key = fileKey(href)
      const style = styles.get(key)
      if (!style) {
        if (!source.has(key)) result.missing.push(href)
        return m
      }
      result.inlined.push(key)
      if (style.url) return '<link' + dropAttrs(attrs, ['href', 'integrity', 'crossorigin']) + ' href="' + escapeHtml(style.url) + '" data-wrr-file="' + escapeHtml(key) + '">'
      const media = attr(attrs, 'media')
      return '<style data-wrr-file="' + escapeHtml(key) + '"' + (media ? ' media="' + escapeHtml(media) + '"' : '') + '>' + inlineSafe(style.css, 'style') + '\n</style>'
    })

    // 4. images, and url() in inline style attributes
    const assetRefs = new Set()
    html.replace(IMG_RE, (m, before, q, ref) => {
      if (isRelative(ref)) assetRefs.add(ref)
      return m
    })
    html.replace(/\bstyle\s*=\s*(["'])([^"']*url\([^"']*)\1/gi, (m, q, css) => {
      css.replace(CSS_URL_RE, (u, uq, ref) => (isRelative(ref.trim()) && assetRefs.add(ref.trim()), u))
      return m
    })
    const assetUrls = new Map()
    for (const ref of assetRefs) assetUrls.set(ref, await assetFor(ref))
    html = html.replace(IMG_RE, (m, before, q, ref) => {
      const url = assetUrls.get(ref)
      if (!url) return m
      result.images.push(fileKey(ref))
      return before + q + url + q
    })
    html = html.replace(/(\bstyle\s*=\s*)(["'])([^"']*url\([^"']*)\2/gi, (m, before, q, css) => before + q + css.replace(CSS_URL_RE, (u, uq, ref) => (assetUrls.get(ref.trim()) ? 'url(' + assetUrls.get(ref.trim()) + ')' : u)) + q)

    // 5. put the script elements back
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
      // the passthrough corrupts binary files, but SVG is text and survives
      async getBlob(name) {
        const key = fileKey(name)
        if (!/\.svg$/i.test(key) || !ids.has(key)) return null
        return new Blob([await this.getText(key)], { type: SVG_TYPE })
      }
    }
  }

  window.WRRFILES = { resolve, fromSite, makePool, fileKey, logicalKey, isRelative, passthrough, getSiteFile }
})()
