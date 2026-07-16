import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import type { ScanResult, WorkType } from '../types'
import { BOARD_TYPES } from '../boardTypes'
import { usePersistedState } from '../persistedState'

// Backfill fields that may be missing on results cached from older
// app versions. _scanState.result is in-memory across renderer
// reloads, so a result captured before `addedJobs` existed can re-
// surface after a hot reload and crash the render. Defensively default
// to [] so the UI degrades to the old behavior (no per-job list).
function normalizeScanResult(r: ScanResult): ScanResult {
  if (r && !r.addedJobs) {
    return { ...r, addedJobs: [] }
  }
  return r
}

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

// A board is a "Frequent Error" if its last 5+ health entries are all
// `<= 0` (i.e. it consistently returns no jobs or errors). Used both
// to (a) deselect these boards by default in the picker, and
// (b) render the "+/- Frequent Errors" toggle button.
function findFrequentErrorBoards(
  boards: { name: string }[],
  boardHealth: Record<string, number[]>
): string[] {
  return boards
    .filter((b) => {
      const history = boardHealth[b.name] || []
      return history.length >= 5 && history.every((h) => h <= 0)
    })
    .map((b) => b.name)
}

interface ProgressEntry {
  id: number
  msg: string
  timestamp: number
}

let _nextId = 0

// Module-scope so the toggle survives the result being reset on the next scan.
let _showAllScanColumns = false

export default function ScanJobsPage() {
  const [keywords, setKeywords] = usePersistedState<string>('scan:keywords', '')
  const [location, setLocation] = usePersistedState<string>('scan:location', '')
  const [workType, setWorkType] = usePersistedState<WorkType>('scan:workType', 'any')
  const [allBoards, setAllBoards] = useState<{ name: string; useBrowser: boolean }[]>([])
  // Stored as a string[] in localStorage. `null` means "no saved
  // selection yet" — the boards-load effect will compute the default
  // (all minus frequent errors) and persist it. Once the user
  // changes the selection, their value sticks across reloads.
  const [selectedBoardsRaw, setSelectedBoardsRaw] = usePersistedState<string[] | null>('scan:selected', null)
  const selectedBoards = new Set(selectedBoardsRaw ?? [])
  const setSelectedBoards = (next: Set<string> | ((prev: Set<string>) => Set<string>)) => {
    setSelectedBoardsRaw((prev) => {
      const prevSet = new Set(prev ?? [])
      const nextSet = typeof next === 'function' ? next(prevSet) : next
      return Array.from(nextSet)
    })
  }
  const [boardsExpanded, setBoardsExpanded] = useState(false)
  const [boardHealth, setBoardHealth] = useState<Record<string, number[]>>({})
  const [scanning, setScanning] = useState(false)
  const [result, setResult] = useState<ScanResult | null>(null)
  const [entries, setEntries] = useState<ProgressEntry[]>([])
  // Snapshot of the visible log lines (blue + green + latest grey) at the
  // moment the most recent scan ended, so the user can copy them after the
  // scan card collapses. Reset on every new scan.
  const [logSnapshot, setLogSnapshot] = useState<ProgressEntry[]>([])
  const [logCopied, setLogCopied] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const entriesRef = useRef<ProgressEntry[]>([])
  // Unmutated log of every entry from the current scan, in arrival order.
  // entriesRef is pruned by the 5s cleanup interval (greys fade, outdated
  // blue "Scanning" lines get dropped), so it can't be the copy source.
  // Reset on every new scan; read by fullLogText() when the user clicks
  // the Copy log button.
  const fullLogRef = useRef<ProgressEntry[]>([])
  const unsubRef = useRef<(() => void) | null>(null)
  const mountedRef = useRef(true)
  const scanActiveRef = useRef(false)

  // Listen for scan completion (works whether or not the user is on this tab)
  useEffect(() => {
    let cancelled = false
    const unsub = api.onScanComplete((result) => {
      if (cancelled || !mountedRef.current) return
      setResult(normalizeScanResult(result))
      setLogSnapshot(fullLogRef.current)
      setScanning(false)
      setElapsed(Math.round((typeof result.durationMs === 'number' && Number.isFinite(result.durationMs) ? result.durationMs : 0) / 1000))
      // Refresh health data after a completed scan
      api.getBoardHealth().then((h) => { if (mountedRef.current) setBoardHealth(h) })
    })
    return () => {
      cancelled = true
      unsub()
    }
  }, [])

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
        fullLogRef.current = initialEntries
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
          fullLogRef.current = [...fullLogRef.current, entry]
          setEntries(entriesRef.current)
        })
        unsubRef.current = unsub
      } else if (status.result) {
        setResult(normalizeScanResult(status.result))
        const initialEntries = status.progress.map((msg) => ({ id: _nextId++, msg, timestamp: Date.now() }))
        setEntries(initialEntries)
        entriesRef.current = initialEntries
        fullLogRef.current = initialEntries
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

  // Stop the elapsed timer whenever scanning becomes false (covers both manual
  // and auto-scan completion, even if the user is on this tab when it finishes).
  useEffect(() => {
    if (!scanning && timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
  }, [scanning])

  // Load available boards and health data
  useEffect(() => {
    let cancelled = false
    Promise.all([api.listBoards(), api.getBoardHealth()])
      .then(([boards, health]) => {
        if (cancelled) return
        setAllBoards(boards)
        setBoardHealth(health)
        // Default: all selected EXCEPT boards flagged as "Frequent
        // Errors" (5+ recent runs with no jobs found). Auto-scanning
        // boards that consistently return 0 listings burns time and
        // adds noise to the result; let the user opt back in via the
        // "Select Frequent Errors" button if they want to retry.
        // Only apply the default if no selection has been persisted
        // yet — once the user customizes, their choice sticks.
        if (selectedBoardsRaw === null) {
          const frequentErrors = new Set(findFrequentErrorBoards(boards, health))
          setSelectedBoardsRaw(boards.map((b) => b.name).filter((n) => !frequentErrors.has(n)))
        }
      })
      .catch((err) => {
        console.error('Failed to load boards/health:', err)
      })
    return () => { cancelled = true }
  }, [])

  // Sidebar refresh button: re-pull boards and health. Don't disturb an
  // in-flight scan; the user can still see the running indicator.
  useEffect(() => {
    const onRefresh = () => {
      if (scanning) return
      Promise.all([api.listBoards(), api.getBoardHealth()])
        .then(([boards, health]) => {
          setAllBoards(boards)
          setBoardHealth(health)
        })
        .catch((err) => {
          console.error('Failed to refresh boards/health:', err)
        })
    }
    window.addEventListener('app:refresh', onRefresh)
    return () => window.removeEventListener('app:refresh', onRefresh)
  }, [scanning])

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

  // Join the full, unmutated log (every blue, green, and grey line from
  // fullLogRef) into a single newline-separated string for the clipboard.
  function fullLogText(source: ProgressEntry[]): string {
    return source.map((e) => e.msg).join('\n')
  }

  // Copy a log text block to the clipboard with a hidden-textarea fallback
  // (mirrors the toast copy pattern in Notifications.tsx). Flips the
  // feedback flag for 1.5s, mirroring the toast's checkmark timing.
  function copyLog(text: string) {
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).catch(() => {
        const ta = document.createElement('textarea')
        ta.value = text
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        try { document.execCommand('copy') } catch {}
        document.body.removeChild(ta)
      })
    }
    setLogCopied(true)
    setTimeout(() => setLogCopied(false), 1500)
  }

  async function handleScan() {
    scanActiveRef.current = true
    setScanning(true)
    setResult(null)
    setLogSnapshot([])
    setEntries([])
    setElapsed(0)
    setBoardsExpanded(false)
    entriesRef.current = []
    fullLogRef.current = []
    await api.clearScanResult()
    // Remove any stale listener before creating a new one
    unsubRef.current?.()
    unsubRef.current = null

    const start = Date.now()
    if (timerRef.current) clearInterval(timerRef.current)
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
      fullLogRef.current = [...fullLogRef.current, entry]
      setEntries(entriesRef.current)
    })
    unsubRef.current = unsub

    try {
      const r = await api.scanBoards({
        keywords: keywords || undefined,
        location: location || undefined,
        workType,
        boards: selectedBoards.size < allBoards.length ? Array.from(selectedBoards) : undefined
      })
      if (mountedRef.current) {
        setResult(r)
        setLogSnapshot(fullLogRef.current)
        setElapsed(Math.round(r.durationMs / 1000))
      }
      // Refresh health data after scan completes
      api.getBoardHealth().then((h) => { if (mountedRef.current) setBoardHealth(h) })
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
        <div className="form-group">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
            <label>
              Job boards ({selectedBoards.size} of {allBoards.length} selected)
            </label>
            <button
              type="button"
              className="btn btn-sm btn-secondary"
              onClick={() => setBoardsExpanded((v) => !v)}
            >
              {boardsExpanded ? '−' : '+'}
            </button>
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6, alignItems: 'center' }}>
            {selectedBoards.size < allBoards.length && (
              <button
                type="button"
                className="btn btn-sm btn-secondary"
                onClick={() => {
                  setSelectedBoards(new Set(allBoards.map((b) => b.name)))
                  setBoardsExpanded(true)
                }}
              >
                + All
              </button>
            )}
            {selectedBoards.size > 0 && (
              <button
                type="button"
                className="btn btn-sm btn-secondary"
                onClick={() => {
                  setSelectedBoards(new Set())
                  setBoardsExpanded(true)
                }}
              >
                - All
              </button>
            )}
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6, alignItems: 'center' }}>
            {(() => {
              const frequentErrors = findFrequentErrorBoards(allBoards, boardHealth)
              // Hide the button entirely when no boards are flagged.
              // The flag is "5+ recent runs with no jobs found" — a
              // healthy user with no failing boards has nothing to
              // toggle, so don't clutter the picker.
              if (frequentErrors.length === 0) return null
              const allSelected = frequentErrors.every((n) => selectedBoards.has(n))
              // Label collapses the "some selected" case into the same
              // "Select Errors" as the "none selected" case. Clicking
              // either way adds the rest; clicking when all-selected
              // removes them all. Two states, not three, keeps the
              // button predictable.
              const label = allSelected ? '- Errors' : '+ Errors'
              return (
                <button
                  key="frequent-errors"
                  type="button"
                  className="btn btn-sm btn-secondary"
                  onClick={() => {
                    setBoardsExpanded(true)
                    setSelectedBoards((prev) => {
                      const next = new Set(prev)
                      if (allSelected) {
                        for (const name of frequentErrors) next.delete(name)
                      } else {
                        for (const name of frequentErrors) next.add(name)
                      }
                      return next
                    })
                  }}
                >
                  {label}
                </button>
              )
            })()}
            {BOARD_TYPES.map((t) => {
              const allSelected = t.boards.every((n) => selectedBoards.has(n))
              const anySelected = t.boards.some((n) => selectedBoards.has(n))
              const label = allSelected
                ? `- ${t.label}`
                : anySelected
                  ? `+ all ${t.label}`
                  : `+ ${t.label}`
              return (
                <button
                  key={t.label}
                  type="button"
                  className="btn btn-sm btn-secondary"
                  onClick={() => {
                    setBoardsExpanded(true)
                    setSelectedBoards((prev) => {
                      const next = new Set(prev)
                      if (allSelected) {
                        for (const name of t.boards) next.delete(name)
                      } else {
                        for (const name of t.boards) next.add(name)
                      }
                      return next
                    })
                  }}
                >
                  {label}
                </button>
              )
            })}
          </div>
          {boardsExpanded && (
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
              gap: 4,
              padding: 8,
              background: 'var(--bg)',
              borderRadius: 6,
              border: '1px solid var(--border)'
            }}>
              {[...allBoards].sort((a, b) => a.name.localeCompare(b.name)).map((b) => {
                const checked = selectedBoards.has(b.name)
                const history = boardHealth[b.name] || []
                // Red if the last 5 results were all zero/errored
                const allBad = history.length >= 5 && history.every((h) => h <= 0)
                return (
                  <label
                    key={b.name}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      fontSize: 13,
                      color: allBad ? '#ef4444' : undefined,
                      fontWeight: allBad ? 600 : undefined,
                      cursor: 'pointer',
                      minWidth: 0
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => {
                        setSelectedBoards((prev) => {
                          const next = new Set(prev)
                          if (next.has(b.name)) next.delete(b.name)
                          else next.add(b.name)
                          return next
                        })
                      }}
                    />
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{b.name}</span>
                  </label>
                )
              })}
            </div>
          )}
        </div>
        <div style={{ marginTop: 12 }}>
          <button className="btn btn-primary" onClick={handleScan} disabled={scanning || selectedBoards.size === 0}>
            {scanning ? 'Scanning boards...' : selectedBoards.size < allBoards.length
              ? `Scan ${selectedBoards.size} selected board${selectedBoards.size === 1 ? '' : 's'}`
              : 'Scan all boards'}
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
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 8 }}>
            <p style={{ margin: 0 }}>
              {`Fetching job listings from job boards... ${formatDuration(elapsed)} elapsed`}
            </p>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                className="btn btn-secondary btn-sm"
                onClick={() => copyLog(fullLogText(fullLogRef.current))}
                title="Copy log lines to clipboard"
                aria-label="Copy log lines to clipboard"
                style={{
                  minWidth: 32,
                  padding: '0 8px',
                  color: logCopied ? '#22c55e' : undefined
                }}
              >
                {logCopied ? '✓' : '⧉'}
              </button>
              <button
                className="btn btn-secondary btn-sm"
                onClick={() => { api.cancelScan() }}
              >
                Cancel
              </button>
            </div>
          </div>
          <div style={{ fontSize: 12, lineHeight: 1.7, maxHeight: 320, overflowY: 'auto' }}>
            {(() => {
              // Show all green (✓) lines + all blue (Scanning) lines, but only the
              // most recent grey line. Each new grey line replaces the previous
              // one in-place instead of stacking.
              const greens = entries.filter((e) => e.msg.startsWith('✓'))
              const blues = entries.filter((e) => e.msg.startsWith('Scanning'))
              const greys = entries.filter((e) => !e.msg.startsWith('✓') && !e.msg.startsWith('Scanning'))
              const latestGrey = greys.at(-1)
              return (
                <>
                  {[...blues, ...greens].map((e) => (
                    <div
                      key={e.id}
                      style={{
                        color: e.msg.startsWith('✓') ? '#22c55e' : '#3b82f6'
                      }}
                    >
                      {e.msg}
                    </div>
                  ))}
                  {latestGrey && (
                    <div
                      key={latestGrey.id}
                      style={{
                        color: 'var(--text-muted)',
                        animation: 'fade-grey-line 5s linear forwards'
                      }}
                    >
                      {latestGrey.msg}
                    </div>
                  )}
                </>
              )
            })()}
          </div>
        </div>
      )}

      {result && (() => {
        // Merge duplicates from multi-location scans: sum counts per board
        const merged = new Map<string, { board: string; found: number; added: number; skipped: number; errors: number; incompatible: number; error?: string }>()
        for (const b of result.boards) {
          const existing = merged.get(b.board)
          if (existing) {
            existing.found += b.found
            existing.added += b.added
            existing.skipped += b.skipped
            existing.errors += b.errors
            existing.incompatible += b.incompatible
            if (b.error && !existing.error) existing.error = b.error
          } else {
            merged.set(b.board, { ...b })
          }
        }
        const rows = Array.from(merged.values()).filter(
          (b) => b.added > 0 || b.errors > 0 || (b.found - b.skipped - b.errors) > 0 || b.incompatible > 0 || !!b.error
        )
        const totalScraped = rows.reduce((s, b) => s + (b.found - b.skipped - b.errors), 0)
        if (rows.length === 0) return null
        const ranAt = result.startedAt
          ? `${new Date(result.startedAt).toLocaleString('en-US', { timeZone: 'America/New_York', dateStyle: 'medium', timeStyle: 'medium' })  } EST`
          : 'unknown time'
        const totalMs = typeof result.durationMs === 'number' && Number.isFinite(result.durationMs) ? result.durationMs : 0
        const seconds = Math.round(totalMs / 1000)
        const minutes = Math.floor(seconds / 60)
        const remSeconds = seconds % 60
        const duration = totalMs > 0
          ? (minutes > 0 ? `${minutes}m ${remSeconds}s` : `${seconds}s`)
          : 'unknown duration'
        return (
          <div className="card" style={{ maxWidth: 800, marginTop: 16 }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 4 }}>
              <h3 style={{ margin: 0 }}>
                Scraped {totalScraped} postings - added {result.totalAdded}
                {result.cancelled && (
                  <span style={{ marginLeft: 8, fontSize: 12, color: 'var(--text-muted)', fontWeight: 400 }}>
                    (cancelled)
                  </span>
                )}
              </h3>
              {logSnapshot.length > 0 && (
                <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => { _showAllScanColumns = !_showAllScanColumns; setResult({ ...result }) }}
                    title={_showAllScanColumns ? 'Hide added/skipped/errors columns' : 'Show added/skipped/errors columns'}
                    aria-label={_showAllScanColumns ? 'Hide added/skipped/errors columns' : 'Show added/skipped/errors columns'}
                    style={{ width: 28, height: 28, minWidth: 28, padding: 0, justifyContent: 'center' }}
                  >
                    {_showAllScanColumns ? '−' : '+'}
                  </button>
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={() => copyLog(fullLogText(logSnapshot))}
                    title="Copy log lines to clipboard"
                    aria-label="Copy log lines to clipboard"
                    style={{
                      width: 28,
                      height: 28,
                      minWidth: 28,
                      padding: 0,
                      justifyContent: 'center',
                      color: logCopied ? '#22c55e' : undefined
                    }}
                  >
                    {logCopied ? '✓' : '⧉'}
                  </button>
                </div>
              )}
            </div>
            <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
              Ran at {ranAt} · Took {duration}
            </p>
            <table className="table">
              <thead>
                <tr>
                  <th>Board</th>
                  <th>Scraped</th>
                  <th>Added</th>
                  {_showAllScanColumns && <th>Found</th>}
                  {_showAllScanColumns && <th>Skipped</th>}
                  {_showAllScanColumns && <th>Errors</th>}
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((b) => (
                  <tr key={b.board}>
                    <td><strong>{b.board}</strong></td>
                    <td>{b.found - b.skipped - b.errors}</td>
                    <td style={{ color: '#22c55e', fontWeight: 600 }}>{b.added}</td>
                    {_showAllScanColumns && <td>{b.found}</td>}
                    {_showAllScanColumns && <td>{b.skipped}</td>}
                    {_showAllScanColumns && <td style={{ color: b.errors > 0 ? '#ef4444' : undefined }}>{b.errors}</td>}
                    <td>
                      {b.error && <span style={{ color: '#ef4444', fontSize: 12 }}>{b.error}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {result.errors.length > 0 && (
              <div style={{ marginTop: 8, fontSize: 12, color: '#ef4444' }}>
                {Array.from(new Set(result.errors)).map((e, i) => <div key={i}>{e}</div>)}
              </div>
            )}
            {result.totalAdded > 0 && (
              <div style={{ marginTop: 12, fontSize: 13, color: 'var(--text-muted)' }}>
                <p style={{ margin: 0 }}>
                  New jobs added. Go to <strong>My Jobs</strong> to view and manage them.
                </p>
                {result.addedJobs && result.addedJobs.length > 0 && (
                  <ul style={{ margin: '8px 0 0', paddingLeft: 20, fontSize: 12 }}>
                    {result.addedJobs.map((j) => (
                      <li key={j.id} style={{ marginBottom: 2 }}>
                        {j.title} — {j.company}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        )
      })()}
    </div>
  )
}
