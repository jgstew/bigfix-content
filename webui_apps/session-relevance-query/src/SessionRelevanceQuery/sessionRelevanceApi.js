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

// Resolves to the parsed JSON body; rejects with an Error whose message is the server's message when it sends one.
// Pass an AbortSignal to cancel; the rejection is then an AbortError.
export const evaluateSessionRelevance = async (sessionRelevance, signal) => {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' }
  const xsrfToken = getCookie('XSRF-TOKEN')
  if (xsrfToken) headers['X-XSRF-TOKEN'] = xsrfToken

  const response = await fetch('/api/sdk/sessionrelevance/evaluate', {
    method: 'POST',
    credentials: 'same-origin',
    headers,
    body: JSON.stringify({ session_relevance: sessionRelevance }),
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
