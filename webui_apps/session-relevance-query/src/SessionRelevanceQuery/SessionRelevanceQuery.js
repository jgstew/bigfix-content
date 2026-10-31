// Example BigFix WebUI extension: evaluate session relevance and show results as a table.
// Uses only the SDK endpoint POST /api/sdk/sessionrelevance/evaluate (see sessionRelevanceApi.js),
// which needs "Can use WebUI" (not "Can use REST API") and requires BigFix Web Reports.
import React, { useState, useCallback, useEffect, useRef } from 'react'
import { evaluateSessionRelevance, relevanceSourceName } from './sessionRelevanceApi'
import './SessionRelevanceQuery.css'

// rendering very large results freezes the browser; limit the relevance itself for big queries
const MAX_ROWS_RENDERED = 1000

const EXAMPLE_QUERIES = [
  'number of bes computers',
  '(id of it, name of it, operating system of it, last report time of it) of bes computers',
  '(name of it, number of fixlets of it) of bes sites',
  '(name of it, id of it) of bes computer groups',
  '(name of it, master flag of it) of bes users'
]

// the API returns an array of results; a tuple query returns each row as an array of columns
const normalizeRows = (response) => {
  const rows = Array.isArray(response) ? response : response?.value
  if (!Array.isArray(rows)) return []
  return rows.map((row) => (Array.isArray(row) ? row : [row]))
}

const toTsv = (rows) => rows.map((row) => row.map((cell) => String(cell)).join('\t')).join('\n')

const SessionRelevanceQuery = ({ relevance = EXAMPLE_QUERIES[1] }) => {
  const [query, setQuery] = useState(relevance)
  const [rows, setRows] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(false)
  const [elapsedMs, setElapsedMs] = useState(null)
  const [lastQuery, setLastQuery] = useState('')
  const abortRef = useRef(null)

  // cancel any in-flight request when the component unmounts
  useEffect(() => () => abortRef.current?.abort(), [])

  const evaluate = useCallback(async () => {
    const trimmed = query.trim()
    if (!trimmed) return

    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller

    setLoading(true)
    setError(null)
    setLastQuery(trimmed)
    const started = Date.now()

    try {
      const response = await evaluateSessionRelevance(trimmed, controller.signal)
      setRows(normalizeRows(response))
    } catch (err) {
      // a newer query or unmount cancelled this one; leave state to whoever replaced it
      if (err.name === 'AbortError') return
      setRows(null)
      setError(err.message || 'Unknown error evaluating session relevance')
    }
    setElapsedMs(Date.now() - started)
    setLoading(false)
  }, [query])

  const onChange = useCallback((e) => setQuery(e.currentTarget.value), [])

  // Ctrl+Enter / Cmd+Enter evaluates without leaving the keyboard
  const onKeyDown = useCallback(
    (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        evaluate()
      }
    },
    [evaluate]
  )

  const copyResults = useCallback(() => {
    if (rows && navigator.clipboard) navigator.clipboard.writeText(toTsv(rows))
  }, [rows])

  // reduce instead of Math.max(...spread) so very large results don't exceed the argument limit
  const columnCount = rows ? rows.reduce((max, row) => Math.max(max, row.length), 1) : 0
  const shownRows = rows ? rows.slice(0, MAX_ROWS_RENDERED) : []

  return (
    <div className='bf-srq'>
      <div className='bf-srq-examples'>
        <span className='bf-srq-label'>Examples:</span>
        {EXAMPLE_QUERIES.map((example) => (
          <button type='button' key={example} className='bf-srq-example' onClick={() => setQuery(example)} title={example}>
            {example}
          </button>
        ))}
      </div>

      <label htmlFor='bf-srq-input' className='bf-srq-label'>
        Session relevance
      </label>
      <textarea
        id='bf-srq-input'
        className='bf-srq-input'
        value={query}
        onChange={onChange}
        onKeyDown={onKeyDown}
        placeholder='e.g. names of bes computers'
        spellCheck={false}
      />

      <div className='bf-srq-actions'>
        <button type='button' className='bf-srq-button bf-srq-button-primary' onClick={evaluate} disabled={loading || query.trim() === ''}>
          Evaluate
        </button>
        <button type='button' className='bf-srq-button' onClick={copyResults} disabled={!rows || rows.length === 0}>
          Copy as TSV
        </button>
        <span className='bf-srq-hint'>Ctrl+Enter to evaluate</span>
      </div>

      {loading && <div className='bf-srq-spinner' role='status' aria-label='Evaluating' />}

      {!loading && error && (
        <div className='bf-srq-error' role='alert'>
          <div className='bf-srq-label'>Error</div>
          <pre>{error}</pre>
        </div>
      )}

      {!loading && rows && (
        <div className='bf-srq-result'>
          <div className='bf-srq-summary'>
            {rows.length} result{rows.length === 1 ? '' : 's'} in {elapsedMs} ms, answered by {relevanceSourceName()}
            {rows.length > MAX_ROWS_RENDERED && ` (showing first ${MAX_ROWS_RENDERED})`}
          </div>
          <div className='bf-srq-table-wrap'>
            <table className='bf-srq-table'>
              <caption>{lastQuery}</caption>
              <thead>
                <tr>
                  <th>#</th>
                  {Array.from({ length: columnCount }, (_, i) => (
                    <th key={i}>item {i}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {shownRows.map((row, rowIndex) => (
                  <tr key={rowIndex}>
                    <td>{rowIndex + 1}</td>
                    {Array.from({ length: columnCount }, (_, i) => (
                      <td key={i}>{i < row.length ? String(row[i]) : ''}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

export default SessionRelevanceQuery
