// Loads the bigfix-relevance-analyzer WebAssembly build (static/analyzer/, from fetch_analyzer.py) in the background.
// Follows the analyzer's consumer contract (tools/playground-wasm/SPLIT_ANALYZER.md in that repo):
//   1. fetch manifest.json and every file with cache: "no-cache"
//   2. verify each file's size and sha256 before using it (a .gz core may arrive inflated: check raw_* instead)
//   3. answer the glue's fetch of each "analyzer.coreN.wasm" from the verified bytes, inflated, as application/wasm
//   4. run the glue as an inline module script, then await __component.$init and compare version() to the manifest
// WebUI's extension CSP allows this: 'unsafe-inline' (the inline scripts) and 'unsafe-eval' (compiling WebAssembly).
// Nothing here blocks the page: app.js runs session relevance with a plain text box until this resolves.
'use strict'
window.SRQ = window.SRQ || {}
;(function (SRQ) {
  const GLUE_TIMEOUT_MS = 60000

  const hex = (buffer) => Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, '0')).join('')
  const sha256 = async (bytes) => hex(await crypto.subtle.digest('SHA-256', bytes))
  const isGzip = (b) => b.length > 2 && b[0] === 0x1f && b[1] === 0x8b
  const isWasm = (b) => b.length > 4 && b[0] === 0x00 && b[1] === 0x61 && b[2] === 0x73 && b[3] === 0x6d

  async function fetchBytes(url) {
    const response = await fetch(url, { cache: 'no-cache', credentials: 'same-origin' })
    if (!response.ok) throw new Error(url + ': HTTP ' + response.status)
    return new Uint8Array(await response.arrayBuffer())
  }

  // Returns { bytes, gzip } after checking the bytes against the manifest entry.
  async function fetchVerified(base, entry, isCore) {
    const bytes = await fetchBytes(new URL(entry.path, base))
    // a server may have decompressed a .gz in transit; tell the two apart by magic bytes
    const gzip = isCore ? isGzip(bytes) : false
    if (isCore && !gzip && !isWasm(bytes)) throw new Error(entry.path + ' is neither gzip nor wasm')
    const size = isCore && !gzip ? entry.raw_size : entry.size
    const digest = isCore && !gzip ? entry.raw_sha256 : entry.sha256
    if (bytes.length !== size) throw new Error(entry.path + ': size ' + bytes.length + ', manifest says ' + size)
    if ((await sha256(bytes)) !== digest) throw new Error(entry.path + ': sha256 does not match manifest.json')
    return { bytes, gzip }
  }

  // Serves the glue's core fetches (keyed on the last path segment) from verified bytes; everything else passes through.
  function installCoreIntercept(cores) {
    const original = window.fetch.bind(window)
    window.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const name = String(url).split(/[?#]/)[0].split('/').pop()
      const core = cores.get(name)
      if (!core) return original(input, init)
      const body = core.gzip ? new Blob([core.bytes]).stream().pipeThrough(new DecompressionStream('gzip')) : core.bytes
      return Promise.resolve(new Response(body, { status: 200, headers: { 'Content-Type': 'application/wasm' } }))
    }
  }

  function runClassicScript(text) {
    const script = document.createElement('script')
    script.textContent = text
    document.head.appendChild(script)
  }

  // Runs the glue as an inline module (import.meta.url is then the document URL; the intercept keys on the core
  // name, so the folder it resolves to does not matter) and waits for it to publish globalThis.__component.
  function runGlue(text) {
    return new Promise((resolve, reject) => {
      const started = Date.now()
      const onError = (e) => {
        clearInterval(timer)
        reject(new Error('analyzer glue failed: ' + e.message))
      }
      window.addEventListener('error', onError, { once: true })
      const timer = setInterval(() => {
        if (globalThis.__component) {
          clearInterval(timer)
          window.removeEventListener('error', onError)
          resolve(globalThis.__component)
        } else if (Date.now() - started > GLUE_TIMEOUT_MS) {
          clearInterval(timer)
          window.removeEventListener('error', onError)
          reject(new Error('analyzer glue did not start within ' + GLUE_TIMEOUT_MS / 1000 + 's'))
        }
      }, 50)
      const script = document.createElement('script')
      script.type = 'module'
      script.textContent = text
      document.head.appendChild(script)
    })
  }

  // Resolves to { version, analyze(text) -> payload object, handle, mountEditor(el, opts) }.
  // onStatus(text) reports progress for the page's status line.
  SRQ.loadAnalyzer = async function (onStatus = () => {}) {
    if (typeof DecompressionStream !== 'function') throw new Error('this browser has no DecompressionStream')
    if (!window.crypto || !crypto.subtle) throw new Error('crypto.subtle is unavailable (the page must be served over https)')
    const started = performance.now()
    const base = new URL('static/analyzer/', document.baseURI)

    onStatus('loading analyzer manifest')
    const manifestText = new TextDecoder().decode(await fetchBytes(new URL('manifest.json', base)))
    const manifest = JSON.parse(manifestText)
    if (manifest.format !== 1 || manifest.package !== 'bigfix-relevance-analyzer') throw new Error('unknown analyzer manifest format')

    onStatus('downloading analyzer ' + manifest.version + ' (' + manifest.cores.length + ' modules)')
    const [editor, glue, ...coreFiles] = await Promise.all([
      fetchVerified(base, manifest.editor, false),
      fetchVerified(base, manifest.glue, false),
      ...manifest.cores.map((entry) => fetchVerified(base, entry, true))
    ])
    const cores = new Map(manifest.cores.map((entry, i) => [entry.name, coreFiles[i]]))

    onStatus('starting analyzer ' + manifest.version)
    installCoreIntercept(cores)
    runClassicScript(new TextDecoder().decode(editor.bytes))
    if (!window.playgroundEditor || typeof window.playgroundEditor.mount !== 'function') throw new Error('analyzer editor did not load')
    const component = await runGlue(new TextDecoder().decode(glue.bytes))
    await component.$init
    const version = component.version()
    if (version !== manifest.version) throw new Error('manifest says ' + manifest.version + ' but the component reports ' + version)

    return {
      version,
      loadMs: Math.round(performance.now() - started),
      analyze: (text) => JSON.parse(component.analyze(text)),
      handle: component.handle,
      mountEditor: (el, opts) => window.playgroundEditor.mount(el, opts)
    }
  }
})(window.SRQ)
