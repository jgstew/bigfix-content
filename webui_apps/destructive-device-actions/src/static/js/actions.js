// Destructive Device Actions - the actions this app can send, and how one is built from its template.
// Each action targets exactly one computer ID. Templates are Mustache-style files from the repo's actions/ folder
// (pack.py copies them to static/templates/); only {{Name}} placeholders are supported, and every placeholder must
// get a value. PLACEHOLDERS gives each value, and build() escapes it for where it appears: inside a CDATA section
// (the template wraps fields that hold free text in one) "]]>" is split across two sections, elsewhere it is
// XML-escaped.
'use strict'
window.DDA = window.DDA || {}
;(function (DDA) {
  const api = window.WebUIApi

  // MDM wipe commands only run on devices managed through BigFix MDM. Which "agent type of <bes computer>" values
  // those devices have is NOT confirmed yet; until it is, a device counts as MDM-managed when its agent type contains
  // "MDM". The app logs the agent types it sees, so the first run on a server shows the real values.
  const isMdm = (device) => /mdm/i.test(device.agentType)

  // The operating systems the wipe template has a branch for (its if-blocks); on anything else it would do nothing.
  const WIPE_OS = [/^win/i, /^chromeos/i, /^android/i, /^ios/i, /^ipados/i, /^mac/i]

  DDA.ACTIONS = [
    {
      id: 'mdm-wipe',
      label: 'Wipe device (MDM)',
      verb: 'Wipe',
      template: 'static/templates/Wipe_MDM_device_from_WebUI.bes.mustache',
      warning: 'This erases the device and returns it to factory settings. It cannot be undone.',
      // '' when the action applies to the device, else why not
      notApplicable(device) {
        // the action's relevance checks the computer name, so with no name it could never run
        if (!device.name.trim()) return 'no computer name, so the action could never pass its name check'
        if (!isMdm(device)) return 'not managed through MDM (agent type: ' + (device.agentType || 'unknown') + ')'
        if (!WIPE_OS.some((re) => re.test(device.os))) return 'no wipe command for this OS (' + (device.os || 'unknown') + ')'
        return ''
      }
    }
  ]

  // Each placeholder's value, before the XML escaping that build() adds. Hostname appears inside a relevance string
  // literal (in <Relevance>) and in the title, so it gets relevance-string escaping (% and " encoded) everywhere; a
  // name with % or " shows encoded in the title, which only happens for names that hostnames can't have.
  const PLACEHOLDERS = {
    ComputerID: (device) => {
      if (!/^\d+$/.test(device.id)) throw new Error('Computer ID "' + device.id + '" is not a number')
      return device.id
    },
    Hostname: (device) => api.relevanceString(device.name).slice(1, -1),
    Reason: (device, reason) => reason
  }

  // Whether position `at` of the template is inside a <![CDATA[ ... ]]> section
  function inCdata(template, at) {
    const before = template.slice(0, at)
    return before.lastIndexOf('<![CDATA[') > before.lastIndexOf(']]>')
  }
  const cdataSafe = (s) => String(s).split(']]>').join(']]]]><![CDATA[>')

  const templates = {}
  async function loadTemplate(action) {
    if (!templates[action.id]) {
      const res = await api.request('GET', action.template, { accept: 'text/plain, */*' })
      if (!res.ok) throw new Error('Cannot load the action template ' + action.template + ': ' + res.message)
      templates[action.id] = res.text
    }
    return templates[action.id]
  }

  // The reason as it is sent: one line, no control characters, at most MAX_REASON characters.
  DDA.MAX_REASON = 200
  DDA.MIN_REASON_CHARS = 4
  DDA.cleanReason = (text) =>
    String(text || '')
      .replace(/[\u0000-\u001f\u007f]+/g, ' ')
      .trim()
      .slice(0, DDA.MAX_REASON)
  // At least MIN_REASON_CHARS characters that are not whitespace
  DDA.reasonOk = (text) => DDA.cleanReason(text).replace(/\s+/g, '').length >= DDA.MIN_REASON_CHARS

  // The action's BES XML for one device. Throws when the template has a placeholder without a value, or when the
  // result doesn't parse or doesn't target exactly this device.
  DDA.build = async function (action, device, reason) {
    if (!DDA.reasonOk(reason)) throw new Error('A ticket number or reason of at least ' + DDA.MIN_REASON_CHARS + ' characters is required')
    const template = await loadTemplate(action)
    const cleaned = DDA.cleanReason(reason)
    const xml = template.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, name, at) => {
      if (!PLACEHOLDERS[name]) throw new Error('The template ' + action.template + ' has a placeholder {{' + name + '}} this app has no value for')
      const value = PLACEHOLDERS[name](device, cleaned)
      return inCdata(template, at) ? cdataSafe(value) : api.escapeXml(value)
    })
    const doc = new DOMParser().parseFromString(xml, 'application/xml')
    if (doc.getElementsByTagName('parsererror').length) throw new Error('The action XML does not parse')
    // exactly one SingleAction with one Target, whose only child is <ComputerID> with this device's ID
    const actions = doc.getElementsByTagName('SingleAction')
    const targets = doc.getElementsByTagName('Target')
    const children = targets.length === 1 ? Array.from(targets[0].children) : []
    const ok = actions.length === 1 && doc.documentElement.children.length === 1 && targets.length === 1 && children.length === 1 && children[0].tagName === 'ComputerID' && children[0].textContent.trim() === device.id
    if (!ok) {
      const ids = Array.from(doc.getElementsByTagName('ComputerID')).map((el) => el.textContent.trim())
      throw new Error('The action XML must be one action with one target, computer ' + device.id + ' alone; it has ' + actions.length + ' action(s), ' + targets.length + ' target(s), computer IDs: ' + (ids.join(', ') || 'none'))
    }
    return xml
  }
})(window.DDA)
