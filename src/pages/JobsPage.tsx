import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api'
import Modal from '../components/Modal'
import { notify } from '../components/Notifications'
import type { CreateJobInput, Document, Job } from '../types'
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
        const k = `${u.protocol}//${u.host}${u.pathname.replace(/\/$/, '')}`.toLowerCase()
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
  const [saving, setSaving] = useState(false)
  const [filterCompany, setFilterCompany] = useState<string[]>([])
  const [filterTitle, setFilterTitle] = useState<string[]>([])
  const [filterLocation, setFilterLocation] = useState<string[]>([])
  const [filterStatus, setFilterStatus] = useState<string[]>([])
  const [filterSource, setFilterSource] = useState<string[]>([])
  const [filterFit, setFilterFit] = useState<string[]>([])
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

  const filteredJobs = useMemo(() => jobs.filter((j) => {
      if (filterCompany.length && !filterCompany.includes(j.company)) return false
      if (filterTitle.length && !filterTitle.includes(j.title)) return false
      if (filterLocation.length && !filterLocation.includes(j.location || '—')) return false
      if (filterStatus.length && !filterStatus.includes(j.status)) return false
      if (filterSource.length && !filterSource.includes(j.source || '—')) return false
      if (filterFit.length && !filterFit.includes(fitLabel(j.score))) return false
      return true
    }).sort((a, b) => (b.score ?? -1) - (a.score ?? -1)), [jobs, filterCompany, filterTitle, filterLocation, filterStatus, filterSource, filterFit])

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
    for (const id of selectedIds) {
      await api.deleteJob(id)
    }
    setJobs((prev) => prev.filter((j) => !selectedIds.has(j.id)))
    if (selectedJob && selectedIds.has(selectedJob.id)) setSelectedJob(null)
    setSelectedIds(new Set())
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
  // Session-scoped "have we already toasted this job's fit failure?"
  // record. Independent of the snapshot above so it survives snapshot
  // rebuilds. A job is re-armed only when its error text changes or its
  // error is cleared and then re-appears — not when the same failure
  // simply persists across loads, polls, or remounts.
  const toastedFitErrors = useRef<Map<number, string | null>>(new Map())
  // Debounce: collapse multiple loadJobs() invocations that complete within
  // a short window into a single toast. Concurrent mounts + the search
  // debounce + the batchScore refetch can all resolve in the same tick.
  const lastFitToastAt = useRef<number>(0)
  const FIT_TOAST_DEBOUNCE_MS = 5000

  async function loadJobs() {
    const before = lastSeenFitErrors.current
    const toasted = toastedFitErrors.current
    const data = search ? await api.searchJobs(search) : await api.listJobs()
    setJobs(dedupeJobs(data.map(cleanJob)))
    // Surface fit-level assessment failures that appeared since last load.
    // "New" = currently failing AND (never toasted this session, OR the
    // error text differs from what we last toasted, OR the error was
    // cleared since we toasted it and has now re-appeared). The same
    // failure persisting across loads/polls/remounts does NOT re-fire.
    const newlyFailing = data.filter((j) => {
      if (!j.fit_last_error) return false
      const prev = before.get(j.id)
      if (prev === j.fit_last_error) return false
      const lastToasted = toasted.get(j.id)
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
      const myReason = cleanedReason
      const now = Date.now()
      const wait = Math.max(0, FIT_TOAST_DEBOUNCE_MS - (now - lastFitToastAt.current))
      setTimeout(() => {
        // If a newer loadJobs has already fired the toast in the meantime,
        // skip — its failing set subsumes ours or matches.
        if (lastFitToastAt.current > now) return
        // Re-check the live snapshot: if my failing jobs no longer match
        // what's currently failing, a later call will handle it (or has
        // already done so).
        const current = lastSeenFitErrors.current
        const stillFailingSame = [...myFailingIds].every((id) => current.get(id) != null)
        if (!stillFailingSame) return
        // Re-check session toast record: a toast that fired in the debounce
        // window for an overlapping failing set should not double-fire.
        const toastedNow = toastedFitErrors.current
        const anyAlreadyToasted = [...myFailingIds].some((id) => {
          const t = toastedNow.get(id)
          return t != null && t === current.get(id)
        })
        if (anyAlreadyToasted) return
        lastFitToastAt.current = Date.now()
        // Mark each job we toasted with the error text that was shown, so
        // future loads of the same failure do not re-fire. If the error
        // later clears, we update the entry to null (a re-occurrence of a
        // non-null error will then re-arm via the text-change path).
        for (const j of data) {
          if (myFailingIds.has(j.id)) toastedNow.set(j.id, j.fit_last_error ?? null)
        }
        notify(message, 'error', 12000)
      }, wait)
    } else {
      // No new failures this load — clear the debounce so the next time
      // failures appear we fire immediately rather than waiting out a stale
      // window.
      lastFitToastAt.current = 0
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
      if (!j.fit_last_error && toasted.has(j.id)) {
        toasted.set(j.id, null)
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
      const job = cleanJob(await api.importJobFromUrl(linkUrl))
      if (cancelled.current) return
      setJobs((prev) => dedupeJobs([job, ...prev]))
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
      const job = cleanJob(await api.createJob(form))
      setJobs((prev) => dedupeJobs([job, ...prev]))
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
        }}
        onDelete={(id) => {
          setSelectedJob(null)
          setJobs((prev) => prev.filter((j) => j.id !== id))
        }}
      />
    )
  }

  return (
    <div className="page">
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
                  <span>Fit</span>
                  <FilterSelect options={filterOptions.fits} selected={filterFit} onChange={setFilterFit} />
                </div>
              </th>
              <th>
                <div className="filter-header">
                  <span>Company</span>
                  <FilterSelect options={filterOptions.companies} selected={filterCompany} onChange={setFilterCompany} />
                </div>
              </th>
              <th>
                <div className="filter-header">
                  <span>Title</span>
                  <FilterSelect options={filterOptions.titles} selected={filterTitle} onChange={setFilterTitle} />
                </div>
              </th>
              <th>
                <div className="filter-header">
                  <span>Location</span>
                  <FilterSelect options={filterOptions.locations} selected={filterLocation} onChange={setFilterLocation} />
                </div>
              </th>
              <th>
                <div className="filter-header">
                  <span>Status</span>
                  <FilterSelect options={filterOptions.statuses} selected={filterStatus} onChange={setFilterStatus} displayMap={STATUS_LABELS} />
                </div>
              </th>
              <th>
                <div className="filter-header">
                  <span>Source</span>
                  <FilterSelect options={filterOptions.sources} selected={filterSource} onChange={setFilterSource} />
                </div>
              </th>
              <th>Date Posted</th>
              <th>Last Updated</th>
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
                <td>{job.source ?? '—'}</td>
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
          Supported boards: LinkedIn, Indeed, Indeed Canada, Monster, ZipRecruiter, SimplyHired, Adzuna, Talent.com, Jora, Remote OK, We Work Remotely, Remotive, Remote.co, Working Nomads, JustRemote, Job Bank (GC), Eluta.ca, Workopolis, Jobboom, WorkBC, CareerBeacon, CharityVillage, Crypto Careers, Cryptorecruit, Remote3, Cryptocurrency Jobs, CryptoJobsList, cryptojobs.com, Crypto.jobs, Web3.career, Startup.jobs, Selby Jennings, Idealist, Built In, Vancouver Jobs, Built In Toronto, Wellfound, UToronto, Y Combinator, CVCA, Top Startups, Rocketships. If details can't be sourced, you'll see an error and no job will be added.{' '}
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
