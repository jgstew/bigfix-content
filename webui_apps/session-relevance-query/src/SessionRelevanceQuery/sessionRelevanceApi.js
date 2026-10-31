// Minimal client for the WebUI SDK session relevance API using plain fetch.
// Does what bfcore-react's BfHttpClient does for this one call:
// same-origin session cookies, XSRF token header, and redirect to /timeout when the session expires.

const getCookie = (name) => {
  const match = document.cookie.split('; ').find((cookie) => cookie.startsWith(name + '='))
  return match ? decodeURIComponent(match.slice(name.length + 1)) : undefined
}

const redirectToLogin = () => {
  window.location.href = '/timeout?nextpage=' + encodeURIComponent(window.location.pathname + window.location.search)
}

const jsonHeaders = () => {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' }
  const xsrfToken = getCookie('XSRF-TOKEN')
  if (xsrfToken) headers['X-XSRF-TOKEN'] = xsrfToken
  return headers
}

// WebUI answers session relevance from BES Explorer when one is running and falls back to Web Reports otherwise.
// Web Reports decodes %xx once more before the relevance parser ("%2541" -> "A"), so a valid "100%25" fails with
// "improper %-sequence". The same probe as the plain-HTML apps' shared helper (../../../shared/webui-relevance.js),
// which this React build can't load: (in web reports context, "%2541"), re-checked every 5 minutes.
const PROBE = '(in web reports context, "%2541")'
const RECHECK_MS = 5 * 60 * 1000
export const relevanceSource = { known: false, webReports: null, decodes: false, at: 0 }
let probing = null

const probe = () => {
  if (!probing) {
    probing = fetch('/api/sdk/sessionrelevance/evaluate', { method: 'POST', credentials: 'same-origin', headers: jsonHeaders(), body: JSON.stringify({ session_relevance: PROBE }) })
      .then((response) => (response.ok ? response.json() : null))
      .then((body) => {
        const row = body && [].concat(body.value)[0]
        if (Array.isArray(row)) {
          relevanceSource.known = true
          relevanceSource.webReports = String(row[0]).toLowerCase() === 'true'
          relevanceSource.decodes = row[1] === 'A'
        }
      })
      .catch(() => {})
      .finally(() => {
        relevanceSource.at = Date.now()
        probing = null
      })
  }
  return probing
}

// "BES Explorer", "Web Reports", or "unknown": who answered the last probe
export const relevanceSourceName = () => (!relevanceSource.known ? 'unknown' : relevanceSource.webReports ? 'Web Reports' : 'BES Explorer')

// Resolves to the parsed JSON body; rejects with an Error whose message is the server's message when it sends one.
// Pass an AbortSignal to cancel; the rejection is then an AbortError.
export const evaluateSessionRelevance = async (sessionRelevance, signal) => {
  if (!relevanceSource.at || Date.now() - relevanceSource.at > RECHECK_MS) await probe()
  // "(relevance)": WebUI answers 400 "Bad Request" when the whole relevance text is also valid JSON (true, false,
  // "x", numbers). The parentheses evaluate the same and are never valid JSON. % as %25 when Web Reports answers.
  const relevance = '(' + sessionRelevance.trim() + ')'

  const response = await fetch('/api/sdk/sessionrelevance/evaluate', {
    method: 'POST',
    credentials: 'same-origin',
    headers: jsonHeaders(),
    body: JSON.stringify({ session_relevance: relevanceSource.decodes ? relevance.replace(/%/g, '%25') : relevance }),
    signal
  })

  if (response.status === 401 || response.headers.get('iem-login-required')) {
    redirectToLogin()
    throw new Error('Session expired, redirecting to login')
  }

  const text = await response.text()
  let body
  try {
    body = text ? JSON.parse(text) : null
  } catch (e) {
    body = text
  }

  if (!response.ok) {
    throw new Error(body?.message || (typeof body === 'string' && body) || `${response.status} ${response.statusText}`)
  }
  return body
}
