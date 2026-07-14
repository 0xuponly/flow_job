import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api'
import Modal from '../components/Modal'
import { notify } from '../components/Notifications'
import type { CreateJobInput, Document, Job } from '../types'

// Lives at module scope so a single ResizeObserver can measure the
// sticky wrapper height across the page's lifetime without re-binding.
let jobsStickyObserver: ResizeObserver | null = null

// Module-scope "have we already toasted this job's fit failure?" record.
// Lives for the lifetime of the renderer process, not the page instance —
// so navigating away from the Job Board and back doesn't re-fire the
// toast for the same failure. A job is re-armed only when its error text
// changes or its error is cleared and then re-appears (handled in loadJobs).
// Same for the last toast timestamp, which is checked in the debounce path.
const toastedFitErrors = new Map<number, string | null>()
let lastFitToastAt = 0
import { STATUS_COLORS, STATUS_LABELS } from '../types'
import JobDetail from './JobDetail'

function FilterSelect({ options, selected, onChange, displayMap }: {
  options: string[]
  selected: string[]
  onChange: (v: string[]) => void
  displayMap?: Record<string, string>
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    if (open) document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [open])

  const selSet = useMemo(() => new Set(selected), [selected])
  const label = selected.length === 0 ? 'Any' : `${selected.length} selected`

  return (
    <div className="filter-dropdown" ref={ref}>
      <button className="filter-dropdown-btn" onClick={() => setOpen(!open)}>
        {label}
        <span className="filter-arrow">{open ? '▲' : '▼'}</span>
        {selected.length > 0 && (
          <span className="filter-clear" onClick={(e) => { e.stopPropagation(); onChange([]) }}>✕</span>
        )}
      </button>
      {open && (
        <div className="filter-menu">
          {options.map((opt) => {
            const checked = selSet.has(opt)
            return (
              <label key={opt} className="filter-option">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => {
                    const next = new Set(selSet)
                    if (checked) { next.delete(opt) } else { next.add(opt) }
                    onChange([...next])
                  }}
                />
                <span>{displayMap?.[opt] ?? opt}</span>
              </label>
            )
          })}
        </div>
      )}
    </div>
  )
}

export interface DateFilter {
  buckets: string[]
  from: string
  to: string
}

const DATE_BUCKETS = ['Today', 'This Week', 'This Month', 'Last 3 Months', 'Older']
export const EMPTY_DATE_FILTER: DateFilter = { buckets: [], from: '', to: '' }

function isDateFilterActive(f: DateFilter): boolean {
  return f.buckets.length > 0 || !!f.from || !!f.to
}

// Match a job's date against a filter. Null/invalid dates match only when
// no filter is active; otherwise they fall through (treated as "not in any
// bucket" so they don't show up when the user is filtering to a specific
// range). This matches the categorical-filter semantics in this page.
export function matchesDateFilter(iso: string | null | undefined, f: DateFilter): boolean {
  if (!isDateFilterActive(f)) return true
  if (!iso) return false
  const d = new Date(iso)
  if (isNaN(d.getTime())) return false
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const inBucket =
    f.buckets.length === 0 ||
    f.buckets.some((b) => {
      if (b === 'Today') return d >= startOfToday
      if (b === 'This Week') {
        const day = startOfToday.getDay() // 0 = Sun
        const start = new Date(startOfToday)
        start.setDate(start.getDate() - day)
        return d >= start
      }
      if (b === 'This Month') {
        const start = new Date(now.getFullYear(), now.getMonth(), 1)
        return d >= start
      }
      if (b === 'Last 3 Months') {
        const start = new Date(now.getFullYear(), now.getMonth() - 3, 1)
        return d >= start
      }
      if (b === 'Older') {
        const start = new Date(now.getFullYear(), now.getMonth() - 3, 1)
        return d < start
      }
      return false
    })
  if (!inBucket) return false
  if (f.from) {
    const from = new Date(f.from)
    if (!isNaN(from.getTime()) && d < from) return false
  }
  if (f.to) {
    // Inclusive of the whole "to" day: bump to the end of the day.
    const to = new Date(f.to)
    if (!isNaN(to.getTime())) {
      to.setHours(23, 59, 59, 999)
      if (d > to) return false
    }
  }
  return true
}

function DateFilterSelect({ filter, onChange }: {
  filter: DateFilter
  onChange: (v: DateFilter) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    if (open) document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [open])

  const bucketSet = useMemo(() => new Set(filter.buckets), [filter.buckets])
  const active = isDateFilterActive(filter)
  const label = !active
    ? 'Any'
    : filter.buckets.length > 0 && (filter.from || filter.to)
      ? 'Custom'
      : filter.buckets.length > 0
        ? filter.buckets.join(', ')
        : 'Custom'

  function toggleBucket(b: string) {
    const next = new Set(bucketSet)
    if (next.has(b)) next.delete(b)
    else next.add(b)
    onChange({ ...filter, buckets: [...next] })
  }

  return (
    <div className="filter-dropdown" ref={ref}>
      <button className="filter-dropdown-btn" onClick={() => setOpen(!open)}>
        {label}
        <span className="filter-arrow">{open ? '▲' : '▼'}</span>
        {active && (
          <span
            className="filter-clear"
            onClick={(e) => { e.stopPropagation(); onChange(EMPTY_DATE_FILTER) }}
          >
            ✕
          </span>
        )}
      </button>
      {open && (
        <div className="filter-menu" style={{ minWidth: 220 }}>
          {DATE_BUCKETS.map((b) => {
            const checked = bucketSet.has(b)
            return (
              <label key={b} className="filter-option">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggleBucket(b)}
                />
                <span>{b}</span>
              </label>
            )
          })}
          <div style={{ borderTop: '1px solid var(--border)', marginTop: 4, paddingTop: 6 }}>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>Custom range</div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, marginBottom: 4 }}>
              From
              <input
                type="date"
                value={filter.from}
                onChange={(e) => onChange({ ...filter, from: e.target.value })}
                style={{ flex: 1 }}
              />
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
              To
              <input
                type="date"
                value={filter.to}
                onChange={(e) => onChange({ ...filter, to: e.target.value })}
                style={{ flex: 1 }}
              />
            </label>
          </div>
        </div>
      )}
    </div>
  )
}

function SortableLabel<K extends string>({
  columnKey,
  label,
  sortColumn,
  sortDir,
  onCycle
}: {
  columnKey: K
  label: string
  sortColumn: string | null
  sortDir: 'asc' | 'desc' | null
  onCycle: (key: K) => void
}) {
  const isActive = sortColumn === columnKey
  const icon = isActive ? (sortDir === 'asc' ? '▲' : '▼') : '↕'
  return (
    <span
      onClick={() => onCycle(columnKey)}
      title="Click to sort"
      style={{
        cursor: 'pointer',
        userSelect: 'none',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        color: isActive ? 'var(--text)' : 'var(--text-muted)'
      }}
    >
      {label}
      <span style={{ fontSize: 10, opacity: isActive ? 1 : 0.5 }}>{icon}</span>
    </span>
  )
}

const EMPTY_FORM: CreateJobInput = {
  title: '',
  company: '',
  location: '',
  url: '',
  description: '',
  salary_range: '',
  source: '',
  notes: ''
}

function formatJobDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (isNaN(d.getTime())) return '—'
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${String(d.getFullYear()).slice(-2)} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

// Deduplicate jobs that share the same URL (normalized) or the same
// company+title+location triple. Defends against rows that slipped past
// the DB-level dedupe (e.g. before the scan-path fix landed, or rows
// imported via manual add). Keeps the first occurrence.
function dedupeJobs(jobs: Job[]): Job[] {
  const seenUrl = new Set<string>()
  const seenKey = new Set<string>()
  return jobs.filter((j) => {
    if (j.url) {
      try {
        const u = new URL(j.url)
        // Most sites use the hash only for in-page anchors ("#apply",
        // "#section-2") — those aren't job identities, so we strip them.
        // But hash-routed SPAs (e.g. WorkBC stores the jobId in
        // `#/job-details/{id}`) put the job identity IN the hash, so two
        // different jobs share the same path and only differ by fragment.
        // Keep the hash when it looks like a path (`#/foo/bar/...` or
        // starts with `/` after the `#`).
        const hashLooksLikePath = u.hash.startsWith('#/') || u.hash.startsWith('/')
        const hashPart = hashLooksLikePath ? u.hash.toLowerCase() : ''
        const k = `${u.protocol}//${u.host}${u.pathname.replace(/\/$/, '')}${u.search}${hashPart}`.toLowerCase()
        if (seenUrl.has(k)) return false
        seenUrl.add(k)
      } catch {
        // fall through to company+title match
      }
    }
    const c = j.company?.trim().toLowerCase() ?? ''
    const t = j.title?.trim().toLowerCase() ?? ''
    const l = j.location?.trim().toLowerCase() ?? ''
    const ck = `${c}::${t}::${l}`
    if (seenKey.has(ck)) return false
    seenKey.add(ck)
    return true
  })
}

export default function JobsPage() {
  const [jobs, setJobs] = useState<Job[]>([])
  const [search, setSearch] = useState('')
  const [showAddLink, setShowAddLink] = useState(false)
  const [showAddManual, setShowAddManual] = useState(false)
  const [linkUrl, setLinkUrl] = useState('')
  const [linkError, setLinkError] = useState('')
  const [importing, setImporting] = useState(false)
  const [form, setForm] = useState<CreateJobInput>(EMPTY_FORM)
  const [selectedJob, setSelectedJob] = useState<Job | null>(null)
  const [rawJobs, setRawJobs] = useState<Job[]>([])
  const [hiddenDupes, setHiddenDupes] = useState(0)
  const [showAll, setShowAll] = useState(false)
  const [deduping, setDeduping] = useState(false)
  const [saving, setSaving] = useState(false)
  const [filterCompany, setFilterCompany] = useState<string[]>([])
  const [filterTitle, setFilterTitle] = useState<string[]>([])
  const [filterLocation, setFilterLocation] = useState<string[]>([])
  const [filterStatus, setFilterStatus] = useState<string[]>([])
  const [filterSource, setFilterSource] = useState<string[]>([])
  const [filterFit, setFilterFit] = useState<string[]>([])
  const [filterDatePosted, setFilterDatePosted] = useState<DateFilter>(EMPTY_DATE_FILTER)
  const [filterLastUpdated, setFilterLastUpdated] = useState<DateFilter>(EMPTY_DATE_FILTER)
  // Sort: null = default behavior (score DESC, nulls last). A column click
  // cycles default → asc → desc → default. Only one column is sorted at a
  // time; clicking a different column resets the previous one to default.
  type SortColumn = 'fit' | 'company' | 'title' | 'location' | 'status' | 'source' | 'date_posted' | 'last_updated'
  const [sortColumn, setSortColumn] = useState<SortColumn | null>(null)
  const [sortDir, setSortDir] = useState<'asc' | 'desc' | null>(null)

  function cycleSort(col: SortColumn) {
    if (sortColumn !== col) {
      setSortColumn(col)
      setSortDir('asc')
      return
    }
    if (sortDir === 'asc') {
      setSortDir('desc')
    } else {
      // was 'desc' or null — return to default
      setSortColumn(null)
      setSortDir(null)
    }
  }
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [generating, setGenerating] = useState<'cv' | 'cover_letter' | null>(null)
  const [genCount, setGenCount] = useState(0)
  const [genTotal, setGenTotal] = useState(0)
  const linkInputRef = useRef<HTMLInputElement>(null)

  const fitLabel = (s: number | null) => {
    if (s == null) return '—'
    if (s >= 0.6) return 'High'
    if (s >= 0.3) return 'Medium'
    return 'Low'
  }

  const filterOptions = useMemo(() => {
    const companies = new Set<string>()
    const titles = new Set<string>()
    const locations = new Set<string>()
    const statuses = new Set<string>()
    const sources = new Set<string>()
    const fits = new Set<string>()
    for (const j of jobs) {
      companies.add(j.company)
      titles.add(j.title)
      locations.add(j.location || '—')
      statuses.add(j.status)
      sources.add(j.source || '—')
      fits.add(fitLabel(j.score))
    }
    return {
      companies: [...companies].sort(),
      titles: [...titles].sort(),
      locations: [...locations].sort(),
      statuses: [...statuses].sort(),
      sources: [...sources].sort(),
      fits: [...fits].sort()
    }
  }, [jobs])

  // When the user opts into "Show all", render the raw (pre-dedupe) list
  // so they can see what the dashboard count actually reflects. The rest
  // of the page (counts, batch ops, the existing "Delete Low Fit"
  // button) keeps reading the deduped `jobs` state — switching those
  // would change the semantics of "select all low-fit" and similar.
  const displayedJobs = showAll ? rawJobs : jobs

  const filteredJobs = useMemo(() => {
    const rows = displayedJobs.filter((j) => {
      if (filterCompany.length && !filterCompany.includes(j.company)) return false
      if (filterTitle.length && !filterTitle.includes(j.title)) return false
      if (filterLocation.length && !filterLocation.includes(j.location || '—')) return false
      if (filterStatus.length && !filterStatus.includes(j.status)) return false
      if (filterSource.length && !filterSource.includes(j.source || '—')) return false
      if (filterFit.length && !filterFit.includes(fitLabel(j.score))) return false
      if (!matchesDateFilter(j.date_posted, filterDatePosted)) return false
      if (!matchesDateFilter(j.last_updated, filterLastUpdated)) return false
      return true
    })
    // Default behavior: score DESC, with null scores at the end. When the
    // user clicks a column header we use that column instead.
    const valueFor = (j: Job): number | string | null => {
      switch (sortColumn) {
        case 'fit': return j.score ?? null
        case 'company': return j.company
        case 'title': return j.title
        case 'location': return j.location ?? null
        case 'status': return j.status
        case 'source': return j.source ?? null
        case 'date_posted': return j.date_posted ?? null
        case 'last_updated': return j.last_updated ?? null
        default: return null
      }
    }
    if (sortColumn && sortDir) {
      const dir = sortDir === 'asc' ? 1 : -1
      return [...rows].sort((a, b) => {
        const av = valueFor(a)
        const bv = valueFor(b)
        // Nulls always last regardless of direction.
        if (av == null && bv == null) return 0
        if (av == null) return 1
        if (bv == null) return -1
        if (typeof av === 'number' && typeof bv === 'number') {
          return (av - bv) * dir
        }
        return String(av).localeCompare(String(bv)) * dir
      })
    }
    return rows.sort((a, b) => (b.score ?? -1) - (a.score ?? -1))
  },
    [displayedJobs, filterCompany, filterTitle, filterLocation, filterStatus, filterSource, filterFit, filterDatePosted, filterLastUpdated, sortColumn, sortDir])

  const allFilteredSelected = useMemo(
    () => filteredJobs.length > 0 && filteredJobs.every((j) => selectedIds.has(j.id)),
    [filteredJobs, selectedIds]
  )

  function toggleSelect(id: number) {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) { next.delete(id) } else { next.add(id) }
      return next
    })
  }

  function toggleSelectAll() {
    if (allFilteredSelected) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(filteredJobs.map((j) => j.id)))
    }
  }

  async   function handleBatchDelete() {
    const count = selectedIds.size
    if (!confirm(`Delete ${count} job${count === 1 ? '' : 's'} and all related data?`)) return
    // Single IPC: deletes all selected jobs atomically in main and
    // writes the store once. The previous per-id loop was slow for
    // large selections and each per-id loadStore/persistStore round
    // could interleave with other writers, occasionally leaving the
    // store half-deleted after a restart.
    const ids = Array.from(selectedIds)
    const result = await api.deleteJobs(ids)
    // Re-fetch from the DB rather than applying an optimistic filter.
    // This guarantees the table shows the actual persisted state, so
    // any job the DB still has (e.g. if a concurrent writer re-added
    // it) is visible to the user immediately rather than hidden until
    // the next refresh.
    const data = await (search ? api.searchJobs(search) : api.listJobs())
    setJobs(applyDedupe(data))
    setSelectedIds(new Set())
    if (selectedJob && ids.includes(selectedJob.id)) setSelectedJob(null)
    // Surface what actually got deleted vs. what was requested so the
    // user can spot the partial-deletion case immediately rather than
    // wondering why some selected jobs are still in the table.
    if (result.stillPresentAfterFilter.length > 0) {
      notify(
        `Bug: ${result.stillPresentAfterFilter.length} IDs (${result.stillPresentAfterFilter.join(', ')}) survived the filter — these jobs were not removed from the store.`,
        'error',
        15000
      )
    } else if (result.missingFromStore.length > 0) {
      notify(
        `Deleted ${result.deleted} of ${result.requested} jobs. ${result.missingFromStore.length} IDs were not in the database (likely stale selection from a previous session).`,
        'warning',
        12000
      )
    } else if (result.deleted < result.requested) {
      notify(`Deleted ${result.deleted} of ${result.requested} jobs.`, 'info', 8000)
    }
  }

  async function handleDeleteLowFit() {
    const lowFit = jobs.filter((j) => j.score != null && j.score < 0.3)
    if (!lowFit.length) return
    if (!confirm(`Delete ${lowFit.length} Low Fit job${lowFit.length === 1 ? '' : 's'}?`)) return
    for (const j of lowFit) {
      await api.deleteJob(j.id)
    }
    setJobs((prev) => prev.filter((j) => j.score == null || j.score >= 0.3))
    if (selectedJob && selectedJob.score != null && selectedJob.score < 0.3) setSelectedJob(null)
  }

  useEffect(() => {
    loadJobs()
    api.backfillJobDates().then((count) => {
      if (count > 0) loadJobs()
    })
  }, [])

  useEffect(() => {
    if (jobs.length > 0 && jobs.some((j) => j.score == null)) {
      api.batchScore().then(loadJobs)
    }
  }, [jobs.length])

  useEffect(() => {
    if (showAddLink) {
      setLinkUrl('')
      setLinkError('')
      setTimeout(() => linkInputRef.current?.focus(), 50)
    }
  }, [showAddLink])

  function decodeEntities(s: string): string {
    return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  }

  // Ref + height measurement for the sticky header region. The wrapper
  // height is needed as the `top` offset for the sticky table header, so
  // the two stack correctly without overlapping. Measured via
  // ResizeObserver to handle font-size changes, toolbar button toggles,
  // window resize, etc. The value is exposed as a CSS custom property
  // on the page root so the table header cells can pick it up.
  const stickyRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!stickyRef.current) return
    const el = stickyRef.current
    const setOffset = () => {
      const h = el.getBoundingClientRect().height
      document.documentElement.style.setProperty('--jobs-sticky-offset', `${h}px`)
    }
    setOffset()
    jobsStickyObserver = new ResizeObserver(setOffset)
    jobsStickyObserver.observe(el)
    return () => {
      jobsStickyObserver?.disconnect()
      jobsStickyObserver = null
    }
  }, [])

  function cleanJob(j: Job): Job {
    return {
      ...j,
      company: decodeEntities(j.company),
      title: decodeEntities(j.title)
    }
  }

  // Tracks the last fit_last_error we toasted for each job id so we don't
  // re-fire the same toast on every remount, search change, or background
  // batch-score refresh. The Map persists across renders for the lifetime
  // of this page instance.
  const lastSeenFitErrors = useRef<Map<number, string | null>>(new Map())
  // No local `toastedFitErrors` ref or `lastFitToastAt` ref here — both
  // are module-scope above so they survive the page unmounting when the
  // user navigates to another tab and back. The dedupe state should
  // outlive the component instance: a fit failure that was already
  // toasted should not re-fire on remount, only on a real change
  // (different error text, or cleared then re-appeared).
  const FIT_TOAST_DEBOUNCE_MS = 5000

  // The full-list dedupe sites (loadJobs, handleBatchDelete) call this
  // to keep `hiddenDupes` in sync with what's currently shown. The
  // single-row additions update both `jobs` and `rawJobs` in lockstep
  // — they prepend into an already deduped list, so the hidden count
  // can't change.
  function applyDedupe(raw: Job[]): Job[] {
    const cleaned = raw.map(cleanJob)
    const deduped = dedupeJobs(cleaned)
    setRawJobs(cleaned)
    setHiddenDupes(cleaned.length - deduped.length)
    return deduped
  }

  async function loadJobs() {
    const before = lastSeenFitErrors.current
    const data = search ? await api.searchJobs(search) : await api.listJobs()

    setJobs(applyDedupe(data))
    // Surface fit-level assessment failures that appeared since last load.
    // "New" = currently failing AND (never toasted this session, OR the
    // error text differs from what we last toasted, OR the error was
    // cleared since we toasted it and has now re-appeared). The same
    // failure persisting across loads/polls/remounts does NOT re-fire.
    const newlyFailing = data.filter((j) => {
      if (!j.fit_last_error) return false
      const prev = before.get(j.id)
      if (prev === j.fit_last_error) return false
      const lastToasted = toastedFitErrors.get(j.id)
      // lastToasted === undefined → never toasted this session
      // lastToasted === j.fit_last_error → already toasted, same text
      // lastToasted === null → toasted, error was cleared since, now back
      if (lastToasted === j.fit_last_error) return false
      return true
    })
    if (newlyFailing.length > 0) {
      // Build a short one-line summary of the most common error so the user
      // knows what went wrong without staring at a wall of HTTP error text.
      const summaries = newlyFailing.map((j) => {
        const raw = (j.fit_last_error ?? '').split(/[.\n]/)[0].trim()
        return raw || 'Unknown error'
      })
      const counts = new Map<string, number>()
      for (const s of summaries) counts.set(s, (counts.get(s) ?? 0) + 1)
      const [topReason, topCount] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]
      // Strip trailing punctuation (the source error often ends in ':' or ',')
      // so we can attach a single, consistent period at the end of the toast.
      const cleanedReason = topReason.replace(/[,:;.\s]+$/, '')
      const reason = topCount === newlyFailing.length
        ? cleanedReason
        : `${cleanedReason} (and ${newlyFailing.length - topCount} similar)`
      const message = `Fit assessment failed for ${newlyFailing.length} job${newlyFailing.length > 1 ? 's' : ''}. ${reason}.`
      // Debounce: concurrent loadJobs() calls (mount + search-debounce +
      // batchScore refetch) can all see the same freshly-failed set. Only
      // the last one to fire within the window gets to toast; older queued
      // callers bail because their captured failing set is now stale
      // (covered by a later call) or their message matches a recent toast.
      const myFailingIds = new Set(newlyFailing.map((j) => j.id))
      const now = Date.now()
      const wait = Math.max(0, FIT_TOAST_DEBOUNCE_MS - (now - lastFitToastAt))
      setTimeout(() => {
        // If a newer loadJobs has already fired the toast in the meantime,
        // skip — its failing set subsumes ours or matches.
        if (lastFitToastAt > now) return
        // Re-check the live snapshot: if my failing jobs no longer match
        // what's currently failing, a later call will handle it (or has
        // already done so).
        const current = lastSeenFitErrors.current
        const stillFailingSame = [...myFailingIds].every((id) => current.get(id) != null)
        if (!stillFailingSame) return
        // Re-check session toast record: a toast that fired in the debounce
        // window for an overlapping failing set should not double-fire.
        const anyAlreadyToasted = [...myFailingIds].some((id) => {
          const t = toastedFitErrors.get(id)
          return t != null && t === current.get(id)
        })
        if (anyAlreadyToasted) return
        lastFitToastAt = Date.now()
        // Mark each job we toasted with the error text that was shown, so
        // future loads of the same failure do not re-fire. If the error
        // later clears, we update the entry to null (a re-occurrence of a
        // non-null error will then re-arm via the text-change path).
        for (const j of data) {
          if (myFailingIds.has(j.id)) toastedFitErrors.set(j.id, j.fit_last_error ?? null)
        }
        notify(message, 'error', 12000)
      }, wait)
    } else {
      // No new failures this load — clear the debounce so the next time
      // failures appear we fire immediately rather than waiting out a stale
      // window.
      lastFitToastAt = 0
    }
    // Update the snapshot so the next load only toasts on *new* failures.
    // If a job's error cleared (e.g. it fit successfully on a retry), drop it
    // from the snapshot so a future error toasts again.
    const next = new Map<number, string | null>()
    for (const j of data) next.set(j.id, j.fit_last_error ?? null)
    lastSeenFitErrors.current = next
    // Mirror the "cleared" state in the toast record: when a previously
    // failed job no longer has an error, mark its toast entry as null so
    // a later re-occurrence counts as new (text-change re-arm). Jobs that
    // are still failing keep their existing toast record untouched, so the
    // session-scoped no-re-fire rule holds.
    for (const j of data) {
      if (!j.fit_last_error && toastedFitErrors.has(j.id)) {
        toastedFitErrors.set(j.id, null)
      }
    }
  }

  useEffect(() => {
    const timer = setTimeout(loadJobs, 300)
    return () => clearTimeout(timer)
  }, [search])

  // Sidebar refresh button: re-run loadJobs
  useEffect(() => {
    const onRefresh = () => { loadJobs() }
    window.addEventListener('app:refresh', onRefresh)
    return () => window.removeEventListener('app:refresh', onRefresh)
  }, [])

  async function handleImportFromLink() {
    if (!linkUrl.trim()) {
      setLinkError('Paste a job posting URL.')
      return
    }
    setImporting(true)
    setLinkError('')
    // Track whether the user cancelled (or closed) the modal while the
    // import was in flight. If the main process eventually returns a job
    // even though we asked to cancel, we drop it instead of surfacing it
    // in the list — the user explicitly said they didn't want to wait.
    const cancelled = { current: false }
    const onCancel = () => { cancelled.current = true }
    window.addEventListener('app:import-cancelled', onCancel)
    try {
      const { job: rawJob, wasBlacklisted } = await api.importJobFromUrl(linkUrl)
      if (cancelled.current) {
        // The user cancelled mid-import. Roll back the just-created
        // job so the table stays in sync.
        await api.deleteJobs([rawJob.id])
        return
      }
      const job = cleanJob(rawJob)
      if (wasBlacklisted) {
        const ok = confirm(
          'This job was previously deleted. Are you sure you can to add it again?'
        )
        if (!ok) {
          await api.deleteJobs([job.id])
          return
        }
      }
      setJobs((prev) => dedupeJobs([job, ...prev]))
      setRawJobs((prev) => [job, ...prev])
      setShowAddLink(false)
      setLinkUrl('')
      setSelectedJob(job)
    } catch (err) {
      if (cancelled.current) return
      if (err instanceof Error && /aborted/i.test(err.message)) {
        setShowAddLink(false)
        setLinkUrl('')
        return
      }
      setLinkError(err instanceof Error ? err.message : 'Failed to import job.')
    } finally {
      window.removeEventListener('app:import-cancelled', onCancel)
      setImporting(false)
    }
  }

  function handleLinkKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !importing) {
      e.preventDefault()
      handleImportFromLink()
    }
  }

  async function handleCreateManual() {
    if (!form.title || !form.company) return
    setSaving(true)
    try {
      const { job: rawJob, wasBlacklisted } = await api.createJob(form)
      const job = cleanJob(rawJob)
      if (wasBlacklisted) {
        const ok = confirm(
          'This job was previously deleted. Are you sure you can to add it again?'
        )
        if (!ok) {
          // Roll back the just-created row so the table stays in
          // sync. The deleted-jobs blacklist entry is preserved
          // (so the scanner still won't auto-re-add the job).
          await api.deleteJobs([job.id])
          return
        }
      }
      setJobs((prev) => dedupeJobs([job, ...prev]))
      setRawJobs((prev) => [job, ...prev])
      setShowAddManual(false)
      setForm(EMPTY_FORM)
      setSelectedJob(job)
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(id: number) {
    if (!confirm('Delete this job and all related data?')) return
    await api.deleteJob(id)
    setJobs((prev) => prev.filter((j) => j.id !== id))
    if (selectedJob?.id === id) setSelectedJob(null)
  }

  async function handleBatchTailor(type: 'cv' | 'cover_letter') {
    const allDocs = await api.listDocuments()
    const existing = new Set(
      allDocs.filter((d: Document) => d.job_id !== null && d.type === type).map((d: Document) => d.job_id!)
    )
    // Only process jobs that match the current filter/search and don't yet
    // have a document of this type. Without a filter, this is just all jobs.
    const eligible = filteredJobs.filter((j) => !existing.has(j.id))
    // Never generate for low-Fit jobs (red in the first column, score <= 0.3).
    // A null score is treated as unscored-eligible, since we don't yet know
    // the fit; only explicitly low scores are skipped.
    const lowFitSkipped = eligible.filter((j) => j.score != null && j.score <= 0.3)
    const needs = eligible.filter((j) => j.score == null || j.score > 0.3)
    if (needs.length === 0) {
      if (lowFitSkipped.length > 0) {
        notify(
          `All eligible jobs are low-Fit (${lowFitSkipped.length} skipped). ` +
            `Low-Fit jobs are skipped by design — clear or delete them instead.`,
          'info'
        )
      } else {
        notify(`All visible jobs already have a ${type === 'cv' ? 'CV' : 'cover letter'}.`, 'info')
      }
      return
    }

    setGenerating(type)
    setGenCount(0)
    setGenTotal(needs.length)
    let queued = 0
    let failed = 0
    let success = 0
    const failedReasons: { job: Job; reason: string }[] = []
    try {
      const CONCURRENCY = 3
      for (let i = 0; i < needs.length; i += CONCURRENCY) {
        const batch = needs.slice(i, i + CONCURRENCY)
        await Promise.allSettled(
          batch.map(async (job) => {
            try {
              const result = await api.tailorDocument({ job_id: job.id, document_type: type })
              if (result && typeof result === 'object' && 'queued' in result) {
                queued++
                return
              }
              const app = await api.getOrCreateApplication(job.id)
              await api.updateApplication(app.id, {
                [type === 'cv' ? 'cv_document_id' : 'cover_letter_document_id']: result.document_id
              })
              success++
            } catch (err) {
              failed++
              if (failedReasons.length < 3) {
                failedReasons.push({
                  job,
                  reason: err instanceof Error ? err.message : 'Unknown error'
                })
              }
            }
            setGenCount((c) => c + 1)
          })
        )
      }
    } finally {
      setGenerating(null)
    }
    const label = type === 'cv' ? 'CVs' : 'cover letters'
    const parts: string[] = []
    if (success > 0) parts.push(`${success} ${label} generated`)
    if (queued > 0) parts.push(`${queued} rate-limited and queued`)
    if (failed > 0) parts.push(`${failed} failed`)
    if (lowFitSkipped.length > 0) parts.push(`${lowFitSkipped.length} low-Fit skipped`)
    if (parts.length > 0) {
      notify(parts.join(' · '), failed > 0 ? 'error' : queued > 0 ? 'info' : 'success')
    }
    if (failedReasons.length > 0) {
      const sample = failedReasons
        .map((f) => `• ${f.job.title} @ ${f.job.company}: ${f.reason}`)
        .join('\n')
      const more = failed - failedReasons.length > 0 ? `\n…and ${failed - failedReasons.length} more.` : ''
      notify(`Failure details (first ${failedReasons.length}):\n${sample}${more}`, 'error', 12000)
    }
  }

  function updateField(field: keyof CreateJobInput, value: string) {
    setForm((prev) => ({ ...prev, [field]: value }))
  }

  if (selectedJob) {
    return (
      <JobDetail
        job={selectedJob}
        onBack={() => {
          setSelectedJob(null)
          loadJobs()
        }}
        onUpdate={(updated) => {
          // Keep the list view in sync but do NOT reset selectedJob here.
          // Race: the user clicks Back while a JobDetail action is in flight
          // (e.g. fit recompute returning); the in-flight onUpdate would
          // otherwise re-open the detail page they just left.
          const cleaned = cleanJob(updated)
          setJobs((prev) => prev.map((j) => (j.id === cleaned.id ? cleaned : j)))
          // Also keep selectedJob in sync so JobDetail sees the fresh prop
          // immediately. Without this, JobDetail's `useEffect([job])` resets
          // its local `currentJob` to the stale reference and the user's
          // edits appear reverted (only the page refresh on navigate-back
          // makes them visible).
          if (selectedJob && selectedJob.id === cleaned.id) {
            setSelectedJob(cleaned)
          }
        }}
        onDelete={(id) => {
          setSelectedJob(null)
          setJobs((prev) => prev.filter((j) => j.id !== id))
        }}
      />
    )
  }

  return (
    <div className="page jobs-page">
      <div className="jobs-page-sticky" ref={stickyRef}>
        <div className="page-header">
          <h1>Job Board</h1>
          <p>Source and manage job postings</p>
        </div>

        <div className="toolbar">
          <input
            className="search-input"
            placeholder="Search jobs..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div className="spacer" />
          {selectedIds.size > 0 && (
            <button className="btn btn-danger btn-sm" onClick={handleBatchDelete} style={{ marginRight: 8 }}>
              Delete selected ({selectedIds.size})
            </button>
          )}
          {jobs.length > 0 && (
            <>
              <button
                className="btn btn-secondary btn-sm"
                onClick={() => handleBatchTailor('cv')}
                disabled={!!generating}
                style={{ marginRight: 4 }}
              >
                {generating === 'cv' ? `Generating CVs (${genCount}/${genTotal})...` : 'Generate CVs'}
              </button>
              <button
                className="btn btn-secondary btn-sm"
                onClick={() => handleBatchTailor('cover_letter')}
                disabled={!!generating}
                style={{ marginRight: 8 }}
              >
                {generating === 'cover_letter' ? `Generating letters (${genCount}/${genTotal})...` : 'Generate Cover Letters'}
              </button>
              {jobs.some((j) => j.score != null && j.score < 0.3) && (
                <button
                  className="btn btn-danger btn-sm"
                  onClick={handleDeleteLowFit}
                  style={{ marginRight: 8 }}
                >
                  Delete Low Fit ({jobs.filter((j) => j.score != null && j.score < 0.3).length})
                </button>
              )}
            </>
          )}
          <button className="btn btn-primary" onClick={() => setShowAddLink(true)}>
            + Add from link
          </button>
        </div>

        {jobs.length === 0 && (
          <div className="alert alert-info">
            Paste a job posting URL. We'll only add the job if we can source the title, company, and description.
          </div>
        )}
      </div>

      {hiddenDupes > 0 && !showAll && (
        <div
          className="alert"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            background: 'var(--bg-secondary)',
            border: '1px solid var(--border)',
            padding: '8px 12px',
            borderRadius: 6,
            fontSize: 13,
            marginTop: 8,
            marginBottom: 8
          }}
        >
          <span>
            {hiddenDupes} duplicate{hiddenDupes === 1 ? '' : 's'} hidden from the Job Board (store has {hiddenDupes + jobs.length}).
          </span>
          <button className="btn btn-secondary btn-sm" onClick={() => setShowAll(true)}>
            Show all
          </button>
          <button
            className="btn btn-secondary btn-sm"
            disabled={deduping}
            onClick={async () => {
              if (!confirm(`Permanently delete ${hiddenDupes} duplicate job${hiddenDupes === 1 ? '' : 's'} (and their documents, applications, follow-ups, interviews)? The kept row is the one with the lowest id (created first).`)) return
              setDeduping(true)
              try {
                const result = await api.dedupeJobs()
                notify(`Removed ${result.removedIds.length} duplicate${result.removedIds.length === 1 ? '' : 's'}. ${result.remaining} jobs remain.`, 'success')
                setShowAll(false)
                await loadJobs()
              } catch (err) {
                notify(`Dedup failed: ${err instanceof Error ? err.message : 'Unknown error'}`, 'error')
              } finally {
                setDeduping(false)
              }
            }}
          >
            {deduping ? 'Cleaning…' : 'Delete Duplicates'}
          </button>
        </div>
      )}
      {showAll && hiddenDupes > 0 && (
        <div
          className="alert"
          style={{
            background: 'var(--bg-secondary)',
            border: '1px solid var(--border)',
            padding: '8px 12px',
            borderRadius: 6,
            fontSize: 13,
            marginTop: 8,
            marginBottom: 8
          }}
        >
          Showing all {hiddenDupes + jobs.length} rows (includes duplicates).
          <button
            className="btn btn-secondary btn-sm"
            style={{ marginLeft: 12 }}
            onClick={() => setShowAll(false)}
          >
            Hide duplicates
          </button>
        </div>
      )}

      {jobs.length === 0 ? (
        <div className="empty-state">
          <h3>No jobs yet</h3>
          <p>Paste a link to a job posting to get started.</p>
          <button className="btn btn-primary" style={{ marginTop: 12 }} onClick={() => setShowAddLink(true)}>
            + Add from link
          </button>
        </div>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th className="col-check">
                <input
                  type="checkbox"
                  checked={allFilteredSelected}
                  onChange={toggleSelectAll}
                />
              </th>
              <th className="col-fit">
                <div className="filter-header">
                  <SortableLabel columnKey="fit" label="Fit" sortColumn={sortColumn} sortDir={sortDir} onCycle={cycleSort} />
                  <FilterSelect options={filterOptions.fits} selected={filterFit} onChange={setFilterFit} />
                </div>
              </th>
              <th>
                <div className="filter-header">
                  <SortableLabel columnKey="company" label="Company" sortColumn={sortColumn} sortDir={sortDir} onCycle={cycleSort} />
                  <FilterSelect options={filterOptions.companies} selected={filterCompany} onChange={setFilterCompany} />
                </div>
              </th>
              <th>
                <div className="filter-header">
                  <SortableLabel columnKey="title" label="Title" sortColumn={sortColumn} sortDir={sortDir} onCycle={cycleSort} />
                  <FilterSelect options={filterOptions.titles} selected={filterTitle} onChange={setFilterTitle} />
                </div>
              </th>
              <th>
                <div className="filter-header">
                  <SortableLabel columnKey="location" label="Location" sortColumn={sortColumn} sortDir={sortDir} onCycle={cycleSort} />
                  <FilterSelect options={filterOptions.locations} selected={filterLocation} onChange={setFilterLocation} />
                </div>
              </th>
              <th>
                <div className="filter-header">
                  <SortableLabel columnKey="status" label="Status" sortColumn={sortColumn} sortDir={sortDir} onCycle={cycleSort} />
                  <FilterSelect options={filterOptions.statuses} selected={filterStatus} onChange={setFilterStatus} displayMap={STATUS_LABELS} />
                </div>
              </th>
              <th>
                <div className="filter-header">
                  <SortableLabel columnKey="salary_range" label="Salary" sortColumn={sortColumn} sortDir={sortDir} onCycle={cycleSort} />
                </div>
              </th>
              <th>
                <div className="filter-header">
                  <SortableLabel columnKey="date_posted" label="Date Posted" sortColumn={sortColumn} sortDir={sortDir} onCycle={cycleSort} />
                  <DateFilterSelect filter={filterDatePosted} onChange={setFilterDatePosted} />
                </div>
              </th>
              <th>
                <div className="filter-header">
                  <SortableLabel columnKey="last_updated" label="Last Updated" sortColumn={sortColumn} sortDir={sortDir} onCycle={cycleSort} />
                  <DateFilterSelect filter={filterLastUpdated} onChange={setFilterLastUpdated} />
                </div>
              </th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {filteredJobs.map((job) => (
              <tr key={job.id} style={{ cursor: 'pointer' }} onClick={() => setSelectedJob(job)}>
                <td className="col-check" onClick={(e) => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    checked={selectedIds.has(job.id)}
                    onChange={() => toggleSelect(job.id)}
                  />
                </td>
                <td className="col-fit">
                  {job.score != null && (
                    <span
                      className="fit-dot"
                      style={{
                        display: 'inline-block',
                        borderRadius: '50%',
                        background: job.score >= 0.6 ? '#22c55e' : job.score >= 0.3 ? '#eab308' : '#ef4444'
                      }}
                    />
                  )}
                </td>
                <td><strong>{job.company}</strong></td>
                <td>{job.title}</td>
                <td>{job.location ?? '—'}</td>
                <td>
                  <span
                    className="badge"
                    style={{ background: `${STATUS_COLORS[job.status]}22`, color: STATUS_COLORS[job.status] }}
                  >
                    {STATUS_LABELS[job.status]}
                  </span>
                </td>
                <td>{job.salary_range ?? '—'}</td>
                <td style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{formatJobDate(job.date_posted)}</td>
                <td style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{formatJobDate(job.last_updated)}</td>
                <td>
                  <button
                    className="btn btn-danger btn-sm"
                    onClick={(e) => {
                      e.stopPropagation()
                      handleDelete(job.id)
                    }}
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <Modal
        open={showAddLink}
        title="Add job from link"
        onClose={() => {
          // Close immediately so the user isn't stuck on a modal that
          // is waiting for a slow fetch or browser scrape. If an import
          // is in flight, ask main to abort it; handleImportFromLink
          // will discard the result via the app:import-cancelled event.
          if (importing) {
            window.dispatchEvent(new CustomEvent('app:import-cancelled'))
            api.cancelImport()
          }
          setImporting(false)
          setShowAddLink(false)
        }}
        actions={
          <>
            <button
              className="btn btn-secondary"
              onClick={() => {
                if (importing) {
                  window.dispatchEvent(new CustomEvent('app:import-cancelled'))
                  api.cancelImport()
                }
                setImporting(false)
                setShowAddLink(false)
              }}
            >
              Cancel
            </button>
            <button
              className="btn btn-primary"
              onClick={handleImportFromLink}
              disabled={importing || !linkUrl.trim()}
            >
              {importing ? 'Fetching...' : 'Add job'}
            </button>
          </>
        }
      >
        <div className="form-group">
          <label>Job posting URL</label>
          <input
            ref={linkInputRef}
            value={linkUrl}
            onChange={(e) => {
              setLinkUrl(e.target.value)
              setLinkError('')
            }}
            onKeyDown={handleLinkKeyDown}
            onPaste={() => setLinkError('')}
            placeholder="https://linkedin.com/jobs/view/... or https://boards.greenhouse.io/..."
            disabled={importing}
            autoFocus
          />
        </div>

        {importing && (
          <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 8 }}>
            Fetching job details...
          </p>
        )}

        {linkError && (
          <div className="alert alert-warning" style={{ marginTop: 12 }}>
            {linkError}
          </div>
        )}

        <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 16 }}>
          Supported boards: LinkedIn, Indeed, Indeed Canada, Monster, ZipRecruiter, SimplyHired, Adzuna, Talent.com, Jora, Remote OK, We Work Remotely, Remotive, Remote.co, Working Nomads, JustRemote, Job Bank (GC), Eluta.ca, Workopolis, Jobboom, WorkBC, CareerBeacon, CharityVillage, Crypto Careers, Cryptorecruit, Remote3, Cryptocurrency Jobs, CryptoJobsList, cryptojobs.com, Crypto.jobs, Web3.career, Startup.jobs, Selby Jennings, Idealist, Built In, Vancouver Jobs, Built In Toronto, Wellfound, UToronto, Y Combinator, CVCA, Top Startups, Rocketships, Google Careers, CareerHound. If details can't be sourced, you'll see an error and no job will be added.{' '}
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            style={{ display: 'inline', padding: '2px 6px', marginLeft: 4 }}
            onClick={() => {
              setShowAddLink(false)
              setShowAddManual(true)
            }}
          >
            Add manually instead
          </button>
        </p>
      </Modal>

      <Modal
        open={showAddManual}
        title="Add job manually"
        onClose={() => setShowAddManual(false)}
        actions={
          <>
            <button className="btn btn-secondary" onClick={() => setShowAddManual(false)}>Cancel</button>
            <button className="btn btn-primary" onClick={handleCreateManual} disabled={saving || !form.title || !form.company}>
              {saving ? 'Saving...' : 'Add job'}
            </button>
          </>
        }
      >
        <div className="form-row">
          <div className="form-group">
            <label>Company *</label>
            <input value={form.company} onChange={(e) => updateField('company', e.target.value)} />
          </div>
          <div className="form-group">
            <label>Job title *</label>
            <input value={form.title} onChange={(e) => updateField('title', e.target.value)} />
          </div>
        </div>
        <div className="form-row">
          <div className="form-group">
            <label>Location</label>
            <input value={form.location} onChange={(e) => updateField('location', e.target.value)} />
          </div>
          <div className="form-group">
            <label>Salary range</label>
            <input value={form.salary_range} onChange={(e) => updateField('salary_range', e.target.value)} />
          </div>
        </div>
        <div className="form-group">
          <label>URL</label>
          <input value={form.url} onChange={(e) => updateField('url', e.target.value)} placeholder="https://..." />
        </div>
        <div className="form-group">
          <label>Source</label>
          <input value={form.source} onChange={(e) => updateField('source', e.target.value)} placeholder="LinkedIn, Indeed, etc." />
        </div>
        <div className="form-group">
          <label>Description</label>
          <textarea
            rows={6}
            value={form.description}
            onChange={(e) => updateField('description', e.target.value)}
            placeholder="Paste the full job description here..."
          />
        </div>
        <div className="form-group">
          <label>Notes</label>
          <textarea rows={2} value={form.notes} onChange={(e) => updateField('notes', e.target.value)} />
        </div>
      </Modal>
    </div>
  )
}
