// In-app log and troubleshooting report, shared by the plain HTML/JS apps in webui_apps/. Each app's pack.py copies
// this file into its package as static/js/webui-log.js; load it after webui-api.js.
//
// The page provides the elements (ids are the defaults; pass others in opts.ids):
//   <details id="log-details"><summary>Log (<span id="log-count">0</span>)</summary>
//     <textarea id="log-text" readonly></textarea>
//     <label><input type="checkbox" id="log-redact" checked> Redact</label> ... </details>
//
// window.WebUILog.create(opts) returns a log:
//   opts: title ("BigFix <App>"), version, ids, header() (extra report lines), logRequests (default true: one HTTP
//         line per WebUIApi request, plus the start of the body when it failed), maxLines (default 5000)
//   log(level, msg)        a "hh:mm:ss.mmm [LEVEL] msg" line
//   lines                  the lines so far
//   clear()
//   addSensitive(text)     text that Redact replaces with <REDACTED_n> (the server host is already in the list)
//   redact(text)           applies Redact when its checkbox is checked (or when there is no checkbox)
//   report()               the report: title, version, time, user agent, relevance source, header(), level counts, log
//   copy(text, label)      to the clipboard; when that is blocked, shows the text selected in the log box
//   copyLog(), copyReport()
'use strict'
;(function () {
  const pad = (n, w) => String(n).padStart(w, '0')
  const timestamp = (d) => pad(d.getHours(), 2) + ':' + pad(d.getMinutes(), 2) + ':' + pad(d.getSeconds(), 2) + '.' + pad(d.getMilliseconds(), 3)
  const COUNTED = ['ERROR', 'WARN', 'HTTP']

  function create(opts = {}) {
    const ids = Object.assign({ text: 'log-text', count: 'log-count', details: 'log-details', redact: 'log-redact' }, opts.ids)
    const el = (key) => document.getElementById(ids[key])
    const maxLines = opts.maxLines || 5000
    const lines = []
    const sensitive = new Set([location.host, location.hostname])

    function log(level, msg) {
      const line = timestamp(new Date()) + ' [' + level + '] ' + msg
      lines.push(line)
      if (lines.length > maxLines) lines.shift()
      const area = el('text')
      if (area) {
        area.value += line + '\n'
        area.scrollTop = area.scrollHeight
      }
      const count = el('count')
      if (count) count.textContent = String(lines.length)
    }

    function clear() {
      lines.length = 0
      if (el('text')) el('text').value = ''
      if (el('count')) el('count').textContent = '0'
    }

    // Masks this server's host name (an IP when WebUI is browsed by address), the user name and other added text so
    // a report can be pasted elsewhere. No generic IPv4 rule: it would also mangle version numbers like 11.0.7.61.
    function redact(text) {
      const box = el('redact')
      if (box && !box.checked) return text
      Array.from(sensitive)
        .filter((s) => s && s.length > 1)
        .sort((a, b) => b.length - a.length)
        .forEach((s, i) => (text = text.split(s).join('<REDACTED_' + (i + 1) + '>')))
      text = text.replace(/([A-Za-z]:[\\/]+Users[\\/]+)[^\\/\s,)"']+/gi, '$1<USER>')
      return text.replace(/(https?:\/\/)([^/:\s"'<>]+)(:\d+)/gi, '$1<SERVER>$3')
    }

    function report() {
      const out = ['===== ' + (opts.title || document.title) + ' report =====', 'Version: ' + (opts.version || '?'), 'Generated: ' + new Date().toString(), 'User agent: ' + navigator.userAgent]
      const rel = window.WebUIRelevance
      if (rel) out.push('Session relevance answered by: ' + rel.sourceName('sdk') + ' (SDK), ' + rel.sourceName('rest') + ' (REST)')
      if (opts.header) {
        try {
          out.push(...opts.header())
        } catch (e) {
          out.push('(report header failed: ' + e + ')')
        }
      }
      const counts = {}
      lines.forEach((l) => {
        const m = /\[([A-Z]+)\]/.exec(l)
        if (m && COUNTED.includes(m[1])) counts[m[1]] = (counts[m[1]] || 0) + 1
      })
      out.push('Log line counts: ' + (COUNTED.map((k) => k + ' ' + (counts[k] || 0)).join(', ')))
      out.push('', '----- Log (' + lines.length + ' lines) -----', lines.join('\n'), '===== end of report =====')
      return redact(out.join('\n'))
    }

    async function copy(text, label) {
      try {
        await navigator.clipboard.writeText(text)
        log('INFO', label + ' copied to clipboard (' + text.length + ' chars)')
      } catch (err) {
        // clipboard can be blocked (permissions, non-secure context); fall back to selecting the text
        log('WARN', 'Clipboard copy failed (' + err + '); the text is selected in the log box, press Ctrl+C / Cmd+C')
        if (el('details')) el('details').open = true
        const area = el('text')
        if (area) {
          area.value = text
          area.focus()
          area.select()
        }
      }
    }

    if (opts.logRequests !== false && window.WebUIApi) {
      window.WebUIApi.onRequest((method, url, res) => {
        log('HTTP', method + ' ' + url + ' -> ' + (res.status || 'network error') + ' (' + res.ms + 'ms, ' + res.text.length + ' bytes)')
        if (!res.ok) log('BODY', res.message)
      })
    }

    return {
      log,
      lines,
      clear,
      addSensitive: (text) => sensitive.add(text),
      redact,
      report,
      copy,
      copyLog: () => copy(redact(lines.join('\n')), 'Log'),
      copyReport: () => copy(report(), 'Report')
    }
  }

  window.WebUILog = { create }
})()
