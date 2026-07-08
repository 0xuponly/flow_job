import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import type { ScanResult, WorkType } from '../types'

function formatDuration(s: number): string {
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const parts: string[] = []
  if (h) parts.push(`${h}h`)
  if (m) parts.push(`${m}m`)
  parts.push(`${sec}s`)
  return parts.join(' ')
}

interface ProgressEntry {
  id: number
  msg: string
  timestamp: number
}

let _nextId = 0

export default function ScanJobsPage() {
  const [keywords, setKeywords] = useState('')
  const [location, setLocation] = useState('')
  const [workType, setWorkType] = useState<WorkType>('any')
  const [scanning, setScanning] = useState(false)
  const [result, setResult] = useState<ScanResult | null>(null)
  const [entries, setEntries] = useState<ProgressEntry[]>([])
  const [elapsed, setElapsed] = useState(0)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const entriesRef = useRef<ProgressEntry[]>([])
  const unsubRef = useRef<(() => void) | null>(null)
  const mountedRef = useRef(true)
  const scanActiveRef = useRef(false)

  // On mount, re-attach to an in-progress or completed scan
  useEffect(() => {
    let cancelled = false
    mountedRef.current = true
    api.getScanStatus().then((status) => {
      if (cancelled || !mountedRef.current) return
      // If handleScan already started, skip re-attach to avoid double listener
      if (scanActiveRef.current) return
      if (status.scanning) {
        setScanning(true)
        const initialEntries = status.progress.map((msg) => ({ id: _nextId++, msg, timestamp: Date.now() }))
        setEntries(initialEntries)
        entriesRef.current = initialEntries
        if (status.startedAt) {
          setElapsed(Math.floor((Date.now() - status.startedAt) / 1000))
          timerRef.current = setInterval(() => {
            setElapsed(Math.floor((Date.now() - status.startedAt!) / 1000))
          }, 1000)
        }
        const seenAtMount = new Set<string>()
        const unsub = api.onScanProgress((msg: string) => {
          if (cancelled || !mountedRef.current) return
          if (seenAtMount.has(msg)) return
          seenAtMount.add(msg)
          const entry = { id: _nextId++, msg, timestamp: Date.now() }
          entriesRef.current = [...entriesRef.current, entry]
          setEntries(entriesRef.current)
        })
        unsubRef.current = unsub
      } else if (status.result) {
        setResult(status.result)
        const initialEntries = status.progress.map((msg) => ({ id: _nextId++, msg, timestamp: Date.now() }))
        setEntries(initialEntries)
        entriesRef.current = initialEntries
        if (status.startedAt) {
          setElapsed(Math.floor((Date.now() - status.startedAt) / 1000))
        }
      }
    })
    return () => {
      cancelled = true
      mountedRef.current = false
      scanActiveRef.current = false
      unsubRef.current?.()
      unsubRef.current = null
      if (timerRef.current) clearInterval(timerRef.current)
      timerRef.current = null
    }
  }, [])

  // Default the location to the user's preferred location from settings
  useEffect(() => {
    let cancelled = false
    api.getSettings().then((s) => {
      if (cancelled) return
      if (s.job_search_location && !location) {
        setLocation(s.job_search_location)
      }
    })
    return () => { cancelled = true }
  }, [])

  // Periodic cleanup: remove faded entries (grey + outdated blue) after 5s
  useEffect(() => {
    const interval = setInterval(() => {
      const entries = entriesRef.current
      const cutoff = Date.now() - 5000
      const latestBlueId = entries.filter(e => e.msg.startsWith('Scanning')).at(-1)?.id ?? -1
      const remaining = entries.filter((e) => {
        if (e.msg.startsWith('✓')) return true
        if (e.msg.startsWith('Scanning')) {
          // Keep latest blue; delete outdated blue after fade
          return e.id === latestBlueId || e.timestamp > cutoff
        }
        // Grey: delete after 5s
        return e.timestamp > cutoff
      })
      if (remaining.length !== entries.length) {
        entriesRef.current = remaining
        setEntries(remaining)
      }
    }, 1000)
    return () => clearInterval(interval)
  }, [])

  async function handleScan() {
    scanActiveRef.current = true
    setScanning(true)
    setResult(null)
    setEntries([])
    setElapsed(0)
    entriesRef.current = []
    await api.clearScanResult()
    // Remove any stale listener before creating a new one
    unsubRef.current?.()
    unsubRef.current = null

    const start = Date.now()
    timerRef.current = setInterval(() => {
      setElapsed(Math.floor((Date.now() - start) / 1000))
    }, 1000)

    const seenMsgs = new Set<string>()
    const unsub = api.onScanProgress((msg: string) => {
      if (!mountedRef.current) return
      if (seenMsgs.has(msg)) return
      seenMsgs.add(msg)
      const entry = { id: _nextId++, msg, timestamp: Date.now() }
      entriesRef.current = [...entriesRef.current, entry]
      setEntries(entriesRef.current)
    })
    unsubRef.current = unsub

    try {
      const r = await api.scanBoards({
        keywords: keywords || undefined,
        location: location || undefined,
        workType
      })
      if (mountedRef.current) setResult(r)
    } catch (err) {
      if (mountedRef.current) {
        alert(`Scan failed: ${err instanceof Error ? err.message : 'Unknown error'}`)
      }
    } finally {
      if (timerRef.current) clearInterval(timerRef.current)
      timerRef.current = null
      unsubRef.current?.()
      unsubRef.current = null
      scanActiveRef.current = false
      if (mountedRef.current) setScanning(false)
    }
  }

  return (
    <div className="page">
      <div className="page-header">
        <h1>Scan Jobs</h1>
        <p>Search job boards for postings matching your profile</p>
      </div>

      <div className="card" style={{ maxWidth: 800 }}>
        <div className="form-row">
          <div className="form-group">
            <label>Keywords</label>
            <input
              value={keywords}
              onChange={(e) => setKeywords(e.target.value)}
              placeholder="e.g. software engineer, react (leave blank to use saved preferences)"
            />
          </div>
          <div className="form-group">
            <label>Location</label>
            <input
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              placeholder="e.g. London, Paris, Remote (separate with commas)"
            />
          </div>
        </div>
        <div className="form-group">
          <label>Work type</label>
          <div style={{ display: 'flex', gap: 8 }}>
            {(['any', 'remote', 'hybrid', 'in_office'] as WorkType[]).map((wt) => (
              <button
                key={wt}
                className={`btn btn-sm ${workType === wt ? 'btn-primary' : 'btn-secondary'}`}
                onClick={() => setWorkType(wt)}
              >
                {wt === 'any' ? 'Any' : wt === 'in_office' ? 'In-office' : wt.charAt(0).toUpperCase() + wt.slice(1)}
              </button>
            ))}
          </div>
        </div>
        <div style={{ marginTop: 12 }}>
          <button className="btn btn-primary" onClick={handleScan} disabled={scanning}>
            {scanning ? 'Scanning boards...' : 'Scan all boards'}
          </button>
        </div>
      </div>

      <style>{`
        @keyframes fade-grey-line {
          from { opacity: 1; }
          to { opacity: 0; }
        }
      `}</style>

      {scanning && (
        <div className="card" style={{ maxWidth: 800, marginTop: 16 }}>
          <p style={{ marginBottom: 8 }}>
            {scanning ? `Fetching job listings from job boards... ${formatDuration(elapsed)} elapsed` : `Scan completed in ${formatDuration(elapsed)}`}
          </p>
          <div style={{ fontSize: 12, lineHeight: 1.7, maxHeight: 320, overflowY: 'auto' }}>
            {(() => {
              const latestBlueId = entries.filter(e => e.msg.startsWith('Scanning')).at(-1)?.id ?? -1
              return entries.slice(-20).map((e) => {
                const isBlue = e.msg.startsWith('Scanning')
                const isCurrentBlue = isBlue && e.id === latestBlueId
                const shouldFade = !e.msg.startsWith('✓') && !isCurrentBlue
                return (
                  <div
                    key={e.id}
                    style={{
                      color: e.msg.startsWith('✓') ? '#22c55e' : isBlue ? '#3b82f6' : 'var(--text-muted)',
                      animation: shouldFade ? 'fade-grey-line 5s linear forwards' : undefined
                    }}
                  >
                    {e.msg}
                  </div>
                )
              })
            })()}
          </div>
        </div>
      )}

      {result && (
        <div className="card" style={{ maxWidth: 800, marginTop: 16 }}>
          <h3 style={{ marginBottom: 12 }}>
            Found {result.totalFound} postings — added {result.totalAdded}, skipped {result.totalSkipped}
          </h3>
          <table className="table">
            <thead>
              <tr>
                <th>Board</th>
                <th>Found</th>
                <th>Added</th>
                <th>Skipped</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {(() => {
                // Merge duplicates from multi-location scans: sum counts per board
                const merged = new Map<string, { board: string; found: number; added: number; skipped: number; error?: string }>()
                for (const b of result.boards) {
                  const existing = merged.get(b.board)
                  if (existing) {
                    existing.found += b.found
                    existing.added += b.added
                    existing.skipped += b.skipped
                    if (b.error && !existing.error) existing.error = b.error
                  } else {
                    merged.set(b.board, { ...b })
                  }
                }
                return Array.from(merged.values())
                  .filter((b) => b.found > 0 || b.added > 0 || b.skipped > 0 || !!b.error)
                  .map((b) => (
                  <tr key={b.board}>
                    <td><strong>{b.board}</strong></td>
                    <td>{b.found}</td>
                    <td style={{ color: '#22c55e', fontWeight: 600 }}>{b.added}</td>
                    <td>{b.skipped}</td>
                    <td>
                      {b.error && <span style={{ color: '#ef4444', fontSize: 12 }}>{b.error}</span>}
                    </td>
                  </tr>
                ))
              })()}
            </tbody>
          </table>
          {result.errors.length > 0 && (
            <div style={{ marginTop: 8, fontSize: 12, color: '#ef4444' }}>
              {result.errors.map((e, i) => <div key={i}>{e}</div>)}
            </div>
          )}
          {result.totalAdded > 0 && (
            <p style={{ marginTop: 12, fontSize: 13, color: 'var(--text-muted)' }}>
              New jobs added. Go to <strong>Job Board</strong> to view and manage them.
            </p>
          )}
        </div>
      )}
    </div>
  )
}
