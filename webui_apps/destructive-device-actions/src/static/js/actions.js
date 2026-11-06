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

  // MDM wipe commands only run on devices managed through BigFix MDM, so a device qualifies when its
  // "agent type of <bes computer>" is anything but "Native" (the BigFix agent). An empty agent type (the property
  // didn't evaluate) is unknown, so it doesn't qualify. The app logs the agent types it sees on each load.
  const isMdm = (device) => !!device.agentType.trim() && device.agentType.trim().toLowerCase() !== 'native'

  // The operating systems the wipe template has a branch for (its if-blocks); on anything else it would do nothing.
  const WIPE_OS = [/^win/i, /^chromeos/i, /^android/i, /^ios/i, /^ipados/i, /^mac/i]

  // Every action's relevance checks the computer name, so with no name it could never run.
  const noName = (device) => (device.name.trim() ? '' : 'no computer name, so the action could never pass its name check')

  // The Windows actions run the RemoteWipe CSP through the MDM Bridge WMI provider with PowerShell, through the BigFix
  // agent, so they need the Native agent on a Windows 10 or 11 client (the CSP is only on Pro, Enterprise and Education;
  // the device checks that the provider exists). "operating system of <bes computer>" reads like "Win10 10.0.19045.xxxx";
  // when the build can't be read from it, the action is offered and the device's own check decides.
  const isNative = (device) => device.agentType.trim().toLowerCase() === 'native'
  const WINDOWS_CLIENT = /^Win1[01]\b/i
  const windowsBuild = (os) => {
    const match = /\b10\.0\.(\d+)/.exec(os)
    return match ? Number(match[1]) : null
  }
  // the BitLocker action also runs on Windows Server 2016 and later
  const WINDOWS_CLIENT_OR_SERVER = /^Win(1[01]|20(1[6-9]|[2-9]\d))\b/i
  const windowsNotApplicable = (minBuild, minVersion, os = WINDOWS_CLIENT, osName = 'a Windows 10 or 11 client') => (device) => {
    const why = noName(device)
    if (why) return why
    if (!isNative(device)) return 'needs the BigFix agent (agent type: ' + (device.agentType || 'unknown') + ')'
    if (!os.test(device.os)) return 'not ' + osName + ' (' + (device.os || 'unknown') + ')'
    const build = windowsBuild(device.os)
    if (build !== null && build < minBuild) return 'needs Windows 10 version ' + minVersion + ' or later (' + device.os + ')'
    return ''
  }
  const WINDOWS_RUNS = 'The BigFix agent, with PowerShell as SYSTEM. The device checks it has the MDM Bridge WMI provider; without it the action does nothing.'

  // Each action: id, label (the Action menu), verb (buttons), template, warning, and the dialog's facts: removes,
  // keeps, runs. notApplicable(device) is '' when the action applies to the device, else why not.
  DDA.ACTIONS = [
    {
      id: 'mdm-wipe',
      label: 'Wipe device (MDM)',
      verb: 'Wipe',
      template: 'static/templates/Wipe_MDM_device_from_WebUI.bes.mustache',
      warning: 'This erases the device and returns it to factory settings. It cannot be undone.',
      removes: 'Everything',
      keeps: 'Nothing',
      runs: 'BigFix MDM, with the wipe command for the device\'s OS',
      notApplicable(device) {
        const why = noName(device)
        if (why) return why
        if (!isMdm(device)) return 'not managed through MDM (agent type: ' + (device.agentType || 'unknown') + ')'
        if (!WIPE_OS.some((re) => re.test(device.os))) return 'no wipe command for this OS (' + (device.os || 'unknown') + ')'
        return ''
      }
    },
    {
      id: 'windows-wipe',
      label: 'Wipe Windows: erase everything (lost, stolen, decommission)',
      verb: 'Wipe',
      template: 'static/templates/Wipe_Windows_erase_everything_from_WebUI.bes.mustache',
      warning: 'This erases the device and restarts it into Windows setup. It cannot be undone, and on some devices it can leave Windows unable to start.',
      removes: 'All user accounts, files, apps and settings',
      keeps: 'Nothing',
      runs: WINDOWS_RUNS + ' It tries doWipeProtected, which keeps retrying even if the device is turned off, then doWipe.',
      // doWipe, the fallback, is in 1511; doWipeProtected is in 1703
      notApplicable: windowsNotApplicable(10586, '1511')
    },
    {
      id: 'windows-wipe-keep-provisioning',
      label: 'Wipe Windows: keep provisioning (repurpose)',
      verb: 'Wipe',
      template: 'static/templates/Wipe_Windows_keep_provisioning_from_WebUI.bes.mustache',
      warning: 'This erases every user and their data and restarts the device into Windows setup. It cannot be undone.',
      removes: 'All user accounts, files, apps and settings',
      keeps: 'Provisioning packages (for example Wi-Fi, certificates, enrollment), applied again after the reset. Without any, this is the same as erasing everything.',
      runs: WINDOWS_RUNS + ' It calls doWipePersistProvisionedData.',
      notApplicable: windowsNotApplicable(10586, '1511')
    },
    {
      id: 'windows-reset-keep-files',
      label: 'Reset Windows: keep user files (repair)',
      verb: 'Reset',
      template: 'static/templates/Reset_Windows_keep_user_files_from_WebUI.bes.mustache',
      warning: 'This reinstalls Windows and removes installed apps and settings, which cannot be restored. User files stay on the device, so don\'t use it for a lost or stolen device.',
      removes: 'Installed apps and settings',
      keeps: 'User accounts and their files',
      runs: WINDOWS_RUNS + ' It calls doWipePersistUserData.',
      notApplicable: windowsNotApplicable(16299, '1709')
    },
    {
      id: 'windows-bitlocker-recovery',
      label: 'BitLocker: force recovery and remove all keys (lost, stolen)',
      verb: 'Lock',
      template: 'static/templates/BitLocker_force_recovery_from_WebUI.bes.mustache',
      warning: 'This removes every way to unlock drive C:, including recovery keys backed up elsewhere, and restarts the device into BitLocker recovery. The data on C: cannot be recovered.',
      removes: 'Every key protector on drive C:, so recovery passwords backed up to AD, Entra ID or MBAM stop working. It also clears the TPM.',
      keeps: 'The encrypted data on C:, which can no longer be unlocked',
      runs: 'The BigFix agent, with PowerShell as SYSTEM. The device checks that a BitLocker volume is protected; it restarts as soon as the script finishes.',
      // the BitLocker PowerShell cmdlets are on Windows 8 and Server 2012 and later; the app offers it on 10, 11 and Server 2016+
      notApplicable: windowsNotApplicable(0, '', WINDOWS_CLIENT_OR_SERVER, 'Windows 10, 11 or Server 2016 or later')
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
