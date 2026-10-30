// Example BigFix WebUI extension: evaluate session relevance and show results as a table.
// Uses only the SDK endpoint POST /api/sdk/sessionrelevance/evaluate via BfHttpClient,
// which needs "Can use WebUI" (not "Can use REST API") and requires BigFix Web Reports.
import React, { useState, useCallback, useEffect, useRef } from 'react'
import { BfHttpClient } from 'bfcore-react'
import { Button } from '@patron/patron-react/button'
import { CircleProgressIndicator } from '@patron/patron-react/progressindicator'
import { TextArea } from '@patron/patron-react/textarea'
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
  const subscriptionRef = useRef(null)

  // drop any in-flight request when the component unmounts
  useEffect(() => () => subscriptionRef.current?.unsubscribe(), [])

  const evaluate = useCallback(() => {
    const trimmed = query.trim()
    if (!trimmed) return

    subscriptionRef.current?.unsubscribe()
    setLoading(true)
    setError(null)
    setLastQuery(trimmed)
    const started = Date.now()

    const bfHttpClient = new BfHttpClient()
    subscriptionRef.current = bfHttpClient.post('/api/sdk/sessionrelevance/evaluate', { session_relevance: trimmed }).subscribe({
      next: (response) => {
        setRows(normalizeRows(response))
        setElapsedMs(Date.now() - started)
        setLoading(false)
      },
      error: (err) => {
        setRows(null)
        setError(err?.data?.message || err?.statusText || 'Unknown error evaluating session relevance')
        setElapsedMs(Date.now() - started)
        setLoading(false)
      }
    })
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
        <span className='hcl-font-semibold'>Examples:</span>
        {EXAMPLE_QUERIES.map((example) => (
          <button type='button' key={example} className='bf-srq-example' onClick={() => setQuery(example)} title={example}>
            {example}
          </button>
        ))}
      </div>

      <div onKeyDown={onKeyDown}>
        <TextArea value={query} onChange={onChange} className='bf-srq-input' placeholder='Session relevance, e.g. names of bes computers' />
      </div>

      <div className='bf-srq-actions'>
        <Button onClick={evaluate} disabled={loading || query.trim() === ''}>
          Evaluate
        </Button>
        <Button onClick={copyResults} disabled={!rows || rows.length === 0}>
          Copy as TSV
        </Button>
        <span className='bf-srq-hint'>Ctrl+Enter to evaluate</span>
      </div>

      {loading && <CircleProgressIndicator type='indeterminate' />}

      {!loading && error && (
        <div className='bf-srq-error' role='alert'>
          <div className='hcl-font-semibold'>Error</div>
          <pre>{error}</pre>
        </div>
      )}

      {!loading && rows && (
        <div className='bf-srq-result'>
          <div className='bf-srq-summary'>
            {rows.length} result{rows.length === 1 ? '' : 's'} in {elapsedMs} ms
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
