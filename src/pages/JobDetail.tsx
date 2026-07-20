import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { api } from '../api'
import Modal from '../components/Modal'
import { LocationAutocomplete } from '../components/LocationAutocomplete'
import { KeywordGapsPanel } from '../components/KeywordGapsPanel'
import RuleCheckList from '../components/RuleCheckList'
import { extractJobKeywords, extractRulesFromFeedback } from '../documentRules'
import { notify } from '../components/Notifications'
import type { Application, Document, Job, JobStatus, KeywordCategory, KeywordResult } from '../types'
import { STATUS_COLORS, STATUS_LABELS } from '../types'
import { EMPLOYMENT_TYPES, EMPLOYMENT_TYPE_LABELS, WORK_MODES, formatEmploymentType } from '../employmentType'
import { enqueueFitRecompute, isJobInFitQueue } from '../fitQueue'

interface Props {
  job: Job
  onBack: () => void
  onUpdate: (job: Job) => void
  onDelete: (id: number) => void
  // Sibling navigation: step through the jobs in the My Jobs
  // filtered list. JobsPage owns the list and the fetch; this page
  // just decides which ids are prev/next relative to the open job.
  filteredJobIds: number[]
  onNavigateSibling: (id: number) => void
}

// Format an ISO date string as MM/DD/YY for the Application deadline
// card. Mirrors formatJobDate in JobsPage.tsx — kept local until a
// third caller shows up, at which point a shared util is justified.
function formatJobDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (isNaN(d.getTime())) return '—'
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${String(d.getFullYear()).slice(-2)}`
}

// Display labels for the four keyword categories. Mirrors the map in
// KeywordGapsPanel.tsx — kept local so JobDetail can render the
// "all keywords" grouped chip block without forcing that component to
// export its internal label table.
const CATEGORY_LABELS: Record<KeywordCategory, string> = {
  hard: 'Hard Skills',
  soft: 'Soft Skills',
  cert: 'Certifications',
  seniority: 'Seniority Cues'
}

export default function JobDetail({ job, onBack, onUpdate, onDelete, filteredJobIds, onNavigateSibling }: Props) {
  const [application, setApplication] = useState<Application | null>(null)
  const [documents, setDocuments] = useState<Document[]>([])
  const [tailoring, setTailoring] = useState<'cv' | 'cover_letter' | null>(null)
  // Re-render trigger: the fit queue is module-scope, so we subscribe
  // to its `app:fit-pending-jobs` event to refresh the per-button
  // "in queue for this job" state. isJobInFitQueue is a Set lookup;
  // we just need a counter to make React notice the change.
  const [, setFitQueueTick] = useState(0)
  const [companyBlacklisted, setCompanyBlacklisted] = useState(false)
  const [blacklistBusy, setBlacklistBusy] = useState(false)
  const [showApply, setShowApply] = useState(false)
  const [applyMethod, setApplyMethod] = useState('Email')
  const [contactEmail, setContactEmail] = useState('')
  const [contactName, setContactName] = useState('')
  const [editing, setEditing] = useState(false)
  const [editTitle, setEditTitle] = useState(job.title)
  const [editCompany, setEditCompany] = useState(job.company)
  const [editLocation, setEditLocation] = useState(job.location ?? '')
  const [editDesc, setEditDesc] = useState(job.description ?? '')
  const [editNotes, setEditNotes] = useState(job.notes ?? '')
  const [editSalaryRange, setEditSalaryRange] = useState(job.salary_range ?? '')
  const [editRequirements, setEditRequirements] = useState(job.requirements ?? '')
  const [editApplicationRequirements, setEditApplicationRequirements] = useState(job.application_requirements ?? '')
  const [editHiringManager, setEditHiringManager] = useState(job.hiring_manager ?? '')
  const [editEmploymentType, setEditEmploymentType] = useState(job.employment_type ?? '')
  const [editWorkMode, setEditWorkMode] = useState(job.work_mode ?? '')
  const [editSource, setEditSource] = useState(job.source ?? '')
  const [editApplicationDeadline, setEditApplicationDeadline] = useState(
    job.application_deadline ? job.application_deadline.slice(0, 10) : ''
  )
  const [editUrl, setEditUrl] = useState(job.url ?? '')
  const [viewDoc, setViewDoc] = useState<Document | null>(null)
  const [docTitle, setDocTitle] = useState('')
  const [docContent, setDocContent] = useState('')
  const [savingDoc, setSavingDoc] = useState(false)
  const [exportingDoc, setExportingDoc] = useState(false)
  const [regeneratingSection, setRegeneratingSection] = useState<string | null>(null)
  // Subscribe to the fit queue's per-job pending events so the
  // recompute-fit button shows its own spinner when this job is in
  // the queue (queued or actively running). Multiple JobDetail tabs
  // each get their own subscription; cleanup runs on unmount.
  useEffect(() => {
    const onPending = () => setFitQueueTick((n) => n + 1)
    window.addEventListener('app:fit-pending-jobs', onPending)
    return () => window.removeEventListener('app:fit-pending-jobs', onPending)
  }, [])
  const fitInQueue = isJobInFitQueue(job.id)

  // Announce "the user is currently viewing this job" so the fit
  // queue can suppress its "fit computed" toast while the user is
  // already on the detail page. Emit on mount and whenever the
  // viewed job changes; clear on unmount. Other components (the
  // queue) listen for app:viewedJob to decide whether to show the
  // "click to open" toast or skip it entirely.
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('app:viewedJob', { detail: { jobId: job.id } }))
    return () => {
      window.dispatchEvent(new CustomEvent('app:viewedJob', { detail: { jobId: null } }))
    }
  }, [job.id])
  const [reviewing, setReviewing] = useState<'cv' | 'cover_letter' | null>(null)
  const [selectedSection, setSelectedSection] = useState('')
  const [regenContext, setRegenContext] = useState('')
  const [descriptionExpanded, setDescriptionExpanded] = useState(false)
  // Measured line-height (px) for the description card. The child
  // DescriptionCard measures the actual rendered line-height from a
  // hidden sentinel that mirrors the card's text styles, then calls
  // onLineHeightMeasured. We mirror it into a CSS custom property so
  // the child can reference it via var(--desc-line-height) in its
  // max-height / fade-out gradient without prop-drilling.
  const handleLineHeightMeasured = useCallback((px: number) => {
    document.documentElement.style.setProperty('--desc-line-height', `${px}px`)
  }, [])

  useEffect(() => {
    load()
  }, [job.id])

  // Sidebar refresh button: re-run load() to pick up latest job,
  // application, and documents from the store. Same pattern as
  // JobsPage's app:refresh handler.
  useEffect(() => {
    const onRefresh = () => { load() }
    window.addEventListener('app:refresh', onRefresh)
    return () => window.removeEventListener('app:refresh', onRefresh)
  }, [])

  // Local mirror of the job prop. The parent owns navigation (it decides
  // whether JobDetail is shown at all), but it intentionally does NOT push
  // in-place mutations back into the `job` prop on the next render — that
  // would race with the user's Back button. Instead, the parent propagates
  // list-state changes only. We mirror the latest job locally so that an
  // action like Save Edits or Recompute Fit updates the page immediately
  // (title, description, score, etc.) without waiting for the user to
  // navigate away and back.
  const [currentJob, setCurrentJob] = useState<Job>(job)
  useEffect(() => {
    setCurrentJob(job)
    // Keep the edit form in sync with the latest saved values so that if
    // the user re-enters edit mode after a save, the fields show what was
    // just persisted (not the values they had typed before saving).
    if (!editing) {
      setEditTitle(job.title)
      setEditCompany(job.company)
      setEditLocation(job.location ?? '')
      setEditDesc(job.description ?? '')
      setEditNotes(job.notes ?? '')
      setEditSalaryRange(job.salary_range ?? '')
      setEditRequirements(job.requirements ?? '')
      setEditApplicationRequirements(job.application_requirements ?? '')
      setEditHiringManager(job.hiring_manager ?? '')
      setEditEmploymentType(job.employment_type ?? '')
      setEditWorkMode(job.work_mode ?? '')
      setEditSource(job.source ?? '')
      setEditApplicationDeadline(job.application_deadline ? job.application_deadline.slice(0, 10) : '')
      setEditUrl(job.url ?? '')
    }
  }, [job, editing])

  // Structured keyword extraction result for the "all keywords by
  // category" grouped chip block and the KeywordGapsPanel. Re-fetches
  // whenever the underlying job description changes (description edit
  // is the only path that can shift category/weight). The IPC is a
  // pure function (no LLM) so this is cheap to recompute; we still
  // gate it on [job.id, currentJob.description] to avoid refetching
  // on unrelated re-renders.
  const [structuredResult, setStructuredResult] = useState<KeywordResult | null>(null)
  useEffect(() => {
    let cancelled = false
    api.extractJobKeywords(job.id).then((r) => {
      if (cancelled) return
      setStructuredResult(r)
    }).catch((err) => {
      if (cancelled) return
      // Non-fatal: the page still renders without the chip block +
      // gaps panel. Surface as a toast so the user knows the UI is
      // missing one of its affordances rather than failing silently.
      notify(`Keyword extraction failed: ${err instanceof Error ? err.message : 'Unknown error'}`, 'error')
    })
    return () => { cancelled = true }
  }, [job.id, currentJob.description])

  // Surface the fit-scorer failure as a toast when the page opens with one
  // already set AND there's no prior score to fall back on. If a prior
  // score/rationale/breakdown are present, the card is the source of truth
  // and we don't add a toast on top.
  const fitErrorToasted = useRef(false)
  useEffect(() => {
    if (fitErrorToasted.current) return
    if (job.fit_last_error && job.score == null) {
      notify(`Fit score unavailable: ${currentJob.fit_last_error}`, 'error', 12000)
      fitErrorToasted.current = true
    }
  }, [job.id, job.fit_last_error, job.score])

  // Reflect the current blacklist status of this job's company.
  useEffect(() => {
    let cancelled = false
    if (!job.company) {
      setCompanyBlacklisted(false)
      return
    }
    api.listBlacklistedCompanies().then((list) => {
      if (cancelled) return
      const lc = job.company!.toLowerCase()
      setCompanyBlacklisted(list.some((c) => c.toLowerCase() === lc))
    })
    return () => { cancelled = true }
  }, [job.id, job.company])

  async function handleToggleBlacklist() {
    if (!job.company || blacklistBusy) return
    setBlacklistBusy(true)
    try {
      if (companyBlacklisted) {
        await api.removeBlacklistedCompany(job.company)
        setCompanyBlacklisted(false)
        notify(`${currentJob.company} removed from blacklist.`, 'info')
      } else {
        if (!confirm(`Stop sourcing new jobs from ${currentJob.company}?`)) return
        await api.addBlacklistedCompany(job.company)
        setCompanyBlacklisted(true)
        notify(`${currentJob.company} blacklisted — future scans will skip them.`, 'info')
      }
    } catch (err) {
      notify(`Blacklist update failed: ${err instanceof Error ? err.message : 'Unknown error'}`, 'error')
    } finally {
      setBlacklistBusy(false)
    }
  }

  async function load() {
    let [app, docs] = await Promise.all([
      api.getOrCreateApplication(job.id),
      api.listDocuments(job.id)
    ])
    docs = docs.filter((d) => d.job_id === job.id)
    setApplication(app)
    setDocuments(docs)

    // Step 1: verify any documents still missing a verification score (retry on low score)
    for (const doc of docs) {
      if (doc.verification_score == null) {
        try {
          const newDoc = await ensureDocVerified(doc)
          if (newDoc) {
            docs = docs.map((d) => (d.type === doc.type ? newDoc : d))
            setDocuments(docs)
          }
        } catch (err) {
          notify(`Content review failed: ${err instanceof Error ? err.message : 'Unknown error'}`, 'error')
        }
      }
    }

    // Note: status transitions off document changes are owned by the backend
    // (recomputeJobStatusFromDocs in electron/database.ts). The frontend
    // re-fetches the job below to pick up the new status.
    const refreshed = await api.getJob(job.id)
    if (refreshed) {
      setCurrentJob(refreshed)
      onUpdate(refreshed)
    }
  }

  async function ensureDocVerified(doc: Document): Promise<Document | null> {
    const topKeywords = extractJobKeywords(job.description ?? '').slice(0, 10)
    const v = await api.verifyDocument(job.id, doc.id, doc.type)
    if ('queued' in v) {
      notify('AI is rate-limited — verification added to queue. Will retry automatically.', 'info')
      return null
    }
    if (v.kind === 'skip') {
      // Don't carry over a stale verification_score into a skip state — clear
      // it on the local doc so the render code falls back to "Pending review…"
      // and doesn't keep showing a misleading 100/100 ✓.
      return { ...doc, verification_score: null, verification_feedback: v.feedback }
    }
    if (v.score >= 70) {
      return { ...doc, verification_score: v.score, verification_feedback: v.feedback }
    }
    let prevContent = doc.content
    let prevFeedback = v.feedback
    let bestId = doc.id
    let bestScore = v.score
    let attempts = 0
    const MAX_ATTEMPTS = 5
    while (attempts < MAX_ATTEMPTS) {
      attempts++
      const r = await api.tailorDocument({
        job_id: job.id,
        document_type: doc.type,
        base_content: `Previous version had these issues: ${prevFeedback}\n\n---\n${prevContent}`,
        topKeywords
      })
      if ('queued' in r) {
        // AI is rate-limited; bail with the best score we've seen so far.
        // The previous document keeps whatever score was last persisted.
        notify('AI is rate-limited — regeneration added to queue. Will retry automatically.', 'info')
        break
      }
      prevContent = r.content
      bestId = r.document_id
      const app = await api.getOrCreateApplication(job.id)
      await api.updateApplication(app.id, {
        [doc.type === 'cv' ? 'cv_document_id' : 'cover_letter_document_id']: bestId
      })
      const v2 = await api.verifyDocument(job.id, bestId, doc.type)
      if ('queued' in v2) {
        notify('AI is rate-limited — verification added to queue. Will retry automatically.', 'info')
        break
      }
      if (v2.kind === 'skip') {
        // Bail with the best score we've seen so far; the doc row keeps
        // whatever score was last persisted on it.
        break
      }
      bestScore = v2.score
      prevFeedback = v2.feedback
      if (v2.passed) break
    }
    const final = await api.listDocuments(job.id).then((ds) => ds.find((d) => d.id === bestId))
    return final || { ...doc, id: bestId, verification_score: bestScore, verification_feedback: prevFeedback }
  }

  async function handleTailor(type: 'cv' | 'cover_letter') {
    setTailoring(type)
    const topKeywords = extractJobKeywords(job.description ?? '').slice(0, 10)
    try {
      const result = await api.tailorDocument({ job_id: job.id, document_type: type, topKeywords })
      if (result && typeof result === 'object' && 'queued' in result) {
        notify('AI is rate-limited — generation added to queue. Will retry automatically.', 'info')
        return
      }
      await api.updateApplication(application!.id, {
        [type === 'cv' ? 'cv_document_id' : 'cover_letter_document_id']: result.document_id
      })
      const updated = await api.updateJob(job.id, { status: 'tailoring' })
      setCurrentJob(updated)
      onUpdate(updated)
      await load()
    } catch (err) {
      notify(`Generation failed: ${err instanceof Error ? err.message : 'Unknown error'}`, 'error')
    } finally {
      setTailoring(null)
    }
  }

  async function handleApply() {
    if (!application) return
    await api.markApplied(application.id, applyMethod, contactEmail || undefined, contactName || undefined)
    const updated = await api.updateJob(job.id, { status: 'applied' })
    setCurrentJob(updated)
    onUpdate(updated)
    setShowApply(false)
    await load()
  }

  const [statusBusy, setStatusBusy] = useState(false)
  const statusMeasureRef = useRef<HTMLSpanElement | null>(null)
  const [statusWidth, setStatusWidth] = useState<number | null>(null)
  useLayoutEffect(() => {
    // Width-fit the status <select> to the widest option label. A
    // native <select> can't auto-size to its current value, so we
    // measure a hidden span of the same typography and pin the
    // visible <select> to that width. Re-measures on font load and
    // window resize so the pill never clips when the user picks a
    // longer status.
    const measure = () => {
      const el = statusMeasureRef.current
      if (!el) return
      setStatusWidth(el.getBoundingClientRect().width)
    }
    measure()
    window.addEventListener('resize', measure)
    if (document.fonts && typeof document.fonts.ready?.then === 'function') {
      document.fonts.ready.then(measure).catch(() => { /* ignore */ })
    }
    return () => window.removeEventListener('resize', measure)
  }, [job.status])
  async function handleStatusChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const next = e.target.value as JobStatus
    if (next === job.status || statusBusy) return
    setStatusBusy(true)
    try {
      const updated = await api.updateJob(job.id, { status: next })
      setCurrentJob(updated)
      onUpdate(updated)
      await load()
    } catch (err) {
      notify(`Status change failed: ${err instanceof Error ? err.message : 'Unknown error'}`, 'error')
    } finally {
      setStatusBusy(false)
    }
  }

  function handleViewDoc(doc: Document) {
    setViewDoc(doc)
    setDocTitle(doc.title)
    setDocContent(doc.content)
  }

  async function handleReview(type: 'cv' | 'cover_letter') {
    setReviewing(type)
    try {
      const target = type === 'cv' ? cv : coverLetter
      if (!target) return
      const result = await api.verifyDocument(job.id, target.id, type)
      if ('queued' in result) {
        notify('AI is rate-limited — review added to queue. Will retry automatically.', 'info')
        return
      }
      if (result.kind === 'skip') {
        // Clear any stale score so the UI doesn't keep showing "100/100 ✓"
        // for a doc that was just deleted, and surface the skip reason.
        setDocuments((prev) => prev.map((d) => (d.id === target.id
          ? { ...d, verification_score: null, verification_feedback: result.feedback }
          : d)))
        notify(result.feedback, 'info')
        return
      }
      const updated = { ...target, verification_score: result.score, verification_feedback: result.feedback }
      setDocuments((prev) => prev.map((d) => (d.id === target.id ? updated : d)))
      notify(
        result.passed
          ? `${type === 'cv' ? 'CV' : 'Cover letter'} passed (${result.score}/100).`
          : `${type === 'cv' ? 'CV' : 'Cover letter'} scored ${result.score}/100 — see feedback below.`,
        result.passed ? 'success' : 'info'
      )
    } catch (err) {
      notify(`Content review failed: ${err instanceof Error ? err.message : 'Unknown error'}`, 'error')
    } finally {
      setReviewing(null)
    }
  }

  async function handleSaveDoc() {
    if (!viewDoc) return
    setSavingDoc(true)
    try {
      const updated = await api.updateDocument(viewDoc.id, docTitle, docContent)
      setDocuments((prev) => prev.map((d) => (d.id === updated.id ? updated : d)))
      setViewDoc(updated)
    } finally {
      setSavingDoc(false)
    }
  }

  const SECTION_HEADERS = new Set([
    'professional summary', 'summary', 'profile',
    'core competencies', 'competencies', 'skills', 'qualifications', 'technical skills',
    'professional experience', 'experience', 'work history', 'work experience',
    'education',
    'certifications', 'languages', 'interests', 'skills & interests', 'skills and interests',
    'projects', 'project experience',
    'leadership & activities', 'leadership and activities', 'activities', 'leadership',
    'publications', 'honors & awards', 'honors and awards', 'awards',
    'additional information', 'additional'
  ])

  function findSections(content: string): string[] {
    const lines = content.split('\n')
    const sections: string[] = []
    for (const line of lines) {
      const cleaned = line.toLowerCase().trim().replace(/[*_]/g, '')
      if (SECTION_HEADERS.has(cleaned)) sections.push(cleaned)
    }
    return sections.filter((s) => s !== 'education')
  }

  async function handleRegenSection() {
    if (!viewDoc || !selectedSection || !job) return
    setRegeneratingSection(selectedSection)
    try {
      const result = await api.regenerateSection(viewDoc.id, selectedSection, job.id, regenContext.trim() || undefined)
      if (result && typeof result === 'object' && 'queued' in result) {
        notify('Request rate-limited — added to queue. Will retry automatically.', 'info')
        return
      }
      const updatedContent = result as string
      setDocContent(updatedContent)
      setViewDoc({ ...viewDoc, content: updatedContent })
    } catch (err) {
      notify(`Section regeneration failed: ${err instanceof Error ? err.message : 'Unknown error'}`, 'error')
    } finally {
      setRegeneratingSection(null)
    }
  }

  async function handleSaveEdits() {
    try {
      const updated = await api.updateJob(job.id, {
        title: editTitle,
        company: editCompany,
        location: editLocation || null,
        description: editDesc,
        notes: editNotes,
        salary_range: editSalaryRange || null,
        requirements: editRequirements || null,
        application_requirements: editApplicationRequirements || null,
        hiring_manager: editHiringManager || null,
        employment_type: editEmploymentType || null,
        work_mode: editWorkMode || null,
        source: editSource || null,
        application_deadline: editApplicationDeadline || null,
        url: editUrl || null
      })
      setCurrentJob(updated)
      onUpdate(updated)
      setEditing(false)
    } catch (err) {
      notify(`Save failed: ${err instanceof Error ? err.message : 'Unknown error'}`, 'error')
    }
  }

  const cv = documents.find((d) => d.type === 'cv')
  const coverLetter = documents.find((d) => d.type === 'cover_letter')

  // Index of the currently-open job in the My Jobs filtered list.
  // -1 means the current job isn't in the list (e.g. status changed
  // mid-view, or the filter now excludes it). In that case both
  // buttons are disabled — we don't try to auto-heal the view.
  const currentIndex = filteredJobIds.indexOf(job.id)
  const prevId = currentIndex > 0 ? filteredJobIds[currentIndex - 1] : null
  const nextId =
    currentIndex >= 0 && currentIndex < filteredJobIds.length - 1
      ? filteredJobIds[currentIndex + 1]
      : null
  const positionLabel =
    currentIndex >= 0
      ? ` (${currentIndex + 1} of ${filteredJobIds.length})`
      : ''

  // Step to a sibling job. If the user is in edit mode, confirm
  // before discarding their unsaved changes — matches the keyboard
  // path below. The existing Back button discards silently because
  // it's a one-click explicit exit; prev/next are an extra hop away
  // from the table, so the surprise of losing edits is higher.
  const handleNavigate = (id: number | null) => {
    if (id == null) return
    if (editing && !confirm('Discard unsaved edits?')) return
    onNavigateSibling(id)
  }

  // Arrow-key navigation. Bound at the document level because the
  // page-level focus is rarely on the buttons themselves. Skip when
  // an editable element has focus so users can use ←/→ inside text
  // inputs (date pickers, the URL/title fields, etc.) as normal.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
      const target = e.target as HTMLElement | null
      if (target) {
        const tag = target.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
        if (target.isContentEditable) return
      }
      // Don't hijack keys when a modifier is held — let the user
      // use ⌘← / ⌘→ (jump to start/end of line in inputs that
      // somehow got past the focus check above) and browser
      // shortcuts untouched.
      if (e.metaKey || e.ctrlKey || e.altKey) return
      e.preventDefault()
      handleNavigate(e.key === 'ArrowLeft' ? prevId : nextId)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [prevId, nextId, editing])

  return (
    <div className="page">
      <div className="toolbar">
        <button className="btn btn-secondary" onClick={onBack}>← Back</button>
        <span
          title={statusBusy ? 'Saving status…' : `Status: ${STATUS_LABELS[job.status]} — click to change`}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            padding: 0,
            borderRadius: 8,
            fontWeight: 500,
            fontSize: 13,
            background: `${STATUS_COLORS[job.status]}22`,
            color: STATUS_COLORS[job.status],
            border: `1px solid ${STATUS_COLORS[job.status]}55`,
            opacity: statusBusy ? 0.6 : 1
          }}
        >
          <select
            value={job.status}
            onChange={handleStatusChange}
            disabled={statusBusy}
            aria-label="Change job status"
            style={{
              appearance: 'none',
              WebkitAppearance: 'none',
              MozAppearance: 'none',
              background: 'transparent',
              color: 'inherit',
              border: 'none',
              font: 'inherit',
              fontWeight: 500,
              fontSize: 13,
              textTransform: 'uppercase',
              letterSpacing: '0.04em',
              padding: '8px 16px',
              cursor: statusBusy ? 'wait' : 'pointer',
              outline: 'none',
              textAlign: 'center',
              textAlignLast: 'center',
              width: statusWidth != null ? `${statusWidth}px` : undefined
            }}
          >
            {(Object.keys(STATUS_LABELS) as JobStatus[])
              .filter((s) => s !== 'tailoring' && s !== 'follow_up' && s !== 'withdrawn')
              .map((s) => (
                <option key={s} value={s} style={{ color: 'var(--text)', background: 'var(--bg)' }}>
                  {STATUS_LABELS[s]}
                </option>
              ))}
          </select>
          {/* Hidden measure node: same typography as the <select>, so
              getBoundingClientRect reports the exact pixel width needed
              to fit the currently selected label without padding tricks
              or width:max-content guessing. Absolutely positioned
              off-screen so it never affects layout. */}
          <span
            ref={statusMeasureRef}
            aria-hidden="true"
            style={{
              position: 'absolute',
              visibility: 'hidden',
              whiteSpace: 'nowrap',
              pointerEvents: 'none',
              fontWeight: 500,
              fontSize: 13,
              textTransform: 'uppercase',
              letterSpacing: '0.04em',
              padding: '8px 16px',
              left: -9999,
              top: -9999
            }}
          >
            {STATUS_LABELS[job.status]}
          </span>
        </span>
        <div className="spacer" />
        <button
          className={companyBlacklisted ? 'btn btn-secondary' : 'btn btn-secondary'}
          onClick={handleToggleBlacklist}
          disabled={blacklistBusy || !job.company}
          title={companyBlacklisted ? 'Remove this company from the blacklist' : 'Stop sourcing jobs from this company'}
          style={companyBlacklisted ? { borderColor: 'var(--danger)', color: 'var(--danger)' } : undefined}
        >
          {companyBlacklisted ? 'Unblacklist company' : 'Blacklist company'}
        </button>
        <button className={editing ? 'btn btn-primary' : 'btn btn-secondary'} onClick={editing ? handleSaveEdits : () => setEditing(true)}>
          {editing ? 'Save' : 'Edit'}
        </button>
        <button
          className="btn btn-danger"
          onClick={async () => {
            if (!confirm('Delete this job and all related data?')) return
            try {
              await api.deleteJob(job.id)
              onDelete(job.id)
            } catch (err) {
              alert(`Delete failed: ${err instanceof Error ? err.message : 'Unknown error'}`)
            }
          }}
        >
          Delete
        </button>
        {currentJob.url && (
          <button className="btn btn-secondary" onClick={() => api.openExternal(job.url!)}>
            Open posting
          </button>
        )}
        <button
          className="btn btn-secondary"
          onClick={() => handleNavigate(prevId)}
          disabled={prevId == null}
          title={prevId != null ? `Previous job${positionLabel}` : 'No previous job in filter'}
          aria-label="Previous job"
        >
          ‹
        </button>
        <button
          className="btn btn-secondary"
          onClick={() => handleNavigate(nextId)}
          disabled={nextId == null}
          title={nextId != null ? `Next job${positionLabel}` : 'No next job in filter'}
          aria-label="Next job"
        >
          ›
        </button>
      </div>

      <div className="page-header" style={{ marginBottom: 8 }}>
        {editing ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%' }}>
            <input value={editTitle} onChange={(e) => setEditTitle(e.target.value)} placeholder="Job title" style={{ fontSize: 24, fontWeight: 700 }} />
            <div style={{ display: 'flex', gap: 8 }}>
              <input value={editCompany} onChange={(e) => setEditCompany(e.target.value)} placeholder="Company" style={{ flex: 1, fontSize: 16 }} />
              <div style={{ flex: 1 }}>
                <LocationAutocomplete
                  value={editLocation}
                  onChange={setEditLocation}
                  placeholder="Location"
                />
              </div>
            </div>
            <input value={editUrl} onChange={(e) => setEditUrl(e.target.value)} placeholder="Posting link (https://...)" style={{ fontSize: 14 }} />
          </div>
        ) : (
          <>
            <h1>{currentJob.title}</h1>
            <p>
              {currentJob.company}{currentJob.location ? ` · ${currentJob.location}` : ''}
              {(job.date_posted || job.last_updated) && (
                <>
                  {job.date_posted && (
                    <span style={{ display: 'block', fontSize: 13, color: 'var(--text-muted)', marginTop: 4 }}>
                      Posted {new Date(job.date_posted).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
                    </span>
                  )}
                  {job.last_updated && (
                    <span style={{ display: 'block', fontSize: 13, color: 'var(--text-muted)', marginTop: 4 }}>
                      Last updated {new Date(job.last_updated).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
                    </span>
                  )}
                </>
              )}
            </p>
          </>
        )}
      </div>

      <div className="job-detail-grid">
        <div>
          <div className="section-title" style={{ marginTop: 8 }}>Description</div>
          {editing ? (
            <>
              <textarea rows={12} value={editDesc} onChange={(e) => setEditDesc(e.target.value)} style={{ width: '100%' }} />
              <textarea rows={3} value={editNotes} onChange={(e) => setEditNotes(e.target.value)} placeholder="Notes..." style={{ width: '100%', marginTop: 8 }} />
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <input value={editSalaryRange} onChange={(e) => setEditSalaryRange(e.target.value)} placeholder="Salary" style={{ flex: 1 }} />
                <select value={editEmploymentType} onChange={(e) => setEditEmploymentType(e.target.value)} style={{ flex: 1, appearance: 'none', WebkitAppearance: 'none', MozAppearance: 'none', backgroundImage: `url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12'><path d='M2 4 L6 8 L10 4' fill='none' stroke='%238b93a7' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/></svg>")`, backgroundRepeat: 'no-repeat', backgroundPosition: 'right 12px center', backgroundSize: '10px 10px', paddingRight: 32 }}>
                  <option value="">—</option>
                  {EMPLOYMENT_TYPES.map((t) => (
                    <option key={t} value={t}>{EMPLOYMENT_TYPE_LABELS[t]}</option>
                  ))}
                </select>
                <select value={editWorkMode} onChange={(e) => setEditWorkMode(e.target.value)} style={{ flex: 1, appearance: 'none', WebkitAppearance: 'none', MozAppearance: 'none', backgroundImage: `url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12'><path d='M2 4 L6 8 L10 4' fill='none' stroke='%238b93a7' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/></svg>")`, backgroundRepeat: 'no-repeat', backgroundPosition: 'right 12px center', backgroundSize: '10px 10px', paddingRight: 32 }}>
                  <option value="">—</option>
                  {WORK_MODES.map((m) => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <input value={editHiringManager} onChange={(e) => setEditHiringManager(e.target.value)} placeholder="Hiring manager" style={{ flex: 1 }} />
                <input value={editSource} onChange={(e) => setEditSource(e.target.value)} placeholder="Source (e.g. LinkedIn, Indeed)" style={{ flex: 1 }} />
                <input value={editApplicationRequirements} onChange={(e) => setEditApplicationRequirements(e.target.value)} placeholder="Resume only / Resume + cover letter / etc." style={{ flex: 2 }} />
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center' }}>
                <label style={{ fontSize: 12, color: 'var(--text-muted)', minWidth: 140 }}>Application deadline</label>
                <input
                  type="date"
                  value={editApplicationDeadline}
                  onChange={(e) => setEditApplicationDeadline(e.target.value)}
                  style={{ flex: 1 }}
                />
                {editApplicationDeadline && (
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => setEditApplicationDeadline('')}
                  >
                    Clear
                  </button>
                )}
              </div>
              <textarea rows={4} value={editRequirements} onChange={(e) => setEditRequirements(e.target.value)} placeholder="Requirements (skills, experience, education needed)..." style={{ width: '100%', marginTop: 8 }} />
              <div className="actions-row">
                <button className="btn btn-primary btn-sm" onClick={handleSaveEdits}>Save</button>
                <button className="btn btn-secondary btn-sm" onClick={() => setEditing(false)}>Cancel</button>
              </div>
            </>
          ) : (
            <DescriptionCard
              text={currentJob.description || 'No description.'}
              notes={currentJob.notes}
              expanded={descriptionExpanded}
              onToggle={() => setDescriptionExpanded((v) => !v)}
              onLineHeightMeasured={handleLineHeightMeasured}
            />
          )}

          <div style={{ marginTop: 16 }}>
            <div className="card" style={{ padding: '8px 12px', minHeight: 56 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 2 }}>
                <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5, color: 'var(--text-muted)' }}>Fit</div>
                <button
                  type="button"
                  title="Recompute Fit"
                  aria-label="Recompute Fit"
                  onClick={async () => {
                    // Enqueue rather than run inline. Multiple clicks
                    // (same job or different jobs) are serialized FIFO
                    // with a hard cap of 10 queued — the 11th is
                    // dropped with a notify. The "Calculating Fit…"
                    // sidebar indicator ticks up on enqueue and down
                    // on each call's resolution.
                    const accepted = enqueueFitRecompute(job.id, (result) => {
                      if (result.ok) {
                        setCurrentJob(result.job)
                        onUpdate(result.job)
                        if (result.job.fit_last_error) {
                          // Backend kept the prior score/rationale/breakdown
                          // and only set fit_last_error. The toast surfaces
                          // the reason; the card continues to show the
                          // previously generated explanation.
                          notify(`Recompute failed: ${result.job.fit_last_error}`, 'error', 12000)
                        }
                      } else {
                        notify(`Recompute failed: ${result.error}`, 'error', 12000)
                      }
                    })
                    if (!accepted) {
                      notify('Fit recompute queue is full (10 pending). Try again in a moment.', 'warning')
                    }
                  }}
                  disabled={fitInQueue}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    cursor: fitInQueue ? 'wait' : 'pointer',
                    color: 'var(--text-muted)',
                    fontSize: 12,
                    padding: 0,
                    lineHeight: 1
                  }}
                >
                  {fitInQueue ? '…' : '↻'}
                </button>
              </div>
              <div style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 6 }}>
                {(() => {
                  const score = currentJob.score
                  if (score == null) {
                    return <span>—</span>
                  }
                  return (
                    <>
                      <span
                        className="fit-dot"
                        style={{
                          background:
                            score >= 0.9 ? '#3b82f6' :
                            score >= 0.6 ? 'var(--success)' :
                            score >= 0.3 ? 'var(--warning)' :
                            'var(--danger)',
                        }}
                      />
                      <span>{Math.round(score * 100)}%</span>
                      <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>
                        ({score >= 0.9 ? 'Excellent' : score >= 0.6 ? 'High' : score >= 0.3 ? 'Medium' : 'Low'})
                      </span>
                    </>
                  )
                })()}
              </div>
              {currentJob.fit_last_error && job.score == null && (
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                  Fit score unavailable.
                </div>
              )}
              {currentJob.fit_rationale && (
                <div className="fit-card-body" style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4, lineHeight: 1.4 }}>
                  {currentJob.fit_rationale}
                </div>
              )}
              {currentJob.fit_breakdown && (currentJob.fit_breakdown.matched_skills.length > 0 || currentJob.fit_breakdown.missing_skills.length > 0 || currentJob.fit_breakdown.experience_years_match != null) && (
                <div className="fit-card-body" style={{ fontSize: 10, marginTop: 6, lineHeight: 1.4, color: 'var(--text-muted)' }}>
                  {currentJob.fit_breakdown.matched_skills.length > 0 && (
                    <div>
                      <span style={{ color: 'var(--success)' }}>✓</span> {currentJob.fit_breakdown.matched_skills.slice(0, 5).join(', ')}
                    </div>
                  )}
                  {currentJob.fit_breakdown.missing_skills.length > 0 && (
                    <div>
                      <span style={{ color: 'var(--danger)' }}>✗</span> {currentJob.fit_breakdown.missing_skills.slice(0, 5).join(', ')}
                    </div>
                  )}
                  {currentJob.fit_breakdown.experience_years_match === false && (
                    <div style={{ color: 'var(--warning)' }}>Years experience below posting's stated requirement</div>
                  )}
                </div>
              )}
            </div>
          </div>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
            <div className="card" style={{ flex: '1 0 100px', padding: '8px 12px', height: 56, display: 'flex', flexDirection: 'column', justifyContent: 'flex-start' }}>
              <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5, color: 'var(--text-muted)', marginBottom: 2 }}>Salary</div>
              <div style={{ fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{currentJob.salary_range || '—'}</div>
            </div>
            <div className="card" style={{ flex: '1 0 100px', padding: '8px 12px', height: 56, display: 'flex', flexDirection: 'column', justifyContent: 'flex-start', marginTop: 0 }}>
              <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5, color: 'var(--text-muted)', marginBottom: 2 }}>Type</div>
              <div style={{ fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={currentJob.employment_type ?? undefined}>{formatEmploymentType(currentJob.employment_type)}</div>
            </div>
            <div className="card" style={{ flex: '1 0 100px', padding: '8px 12px', height: 56, display: 'flex', flexDirection: 'column', justifyContent: 'flex-start', marginTop: 0 }}>
              <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5, color: 'var(--text-muted)', marginBottom: 2 }}>Work mode</div>
              <div style={{ fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={currentJob.work_mode ?? undefined}>{currentJob.work_mode || '—'}</div>
            </div>
            <div className="card" style={{ flex: '1 0 140px', padding: '8px 12px', height: 56, display: 'flex', flexDirection: 'column', justifyContent: 'flex-start', marginTop: 0 }}>
              <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5, color: 'var(--text-muted)', marginBottom: 2 }}>Hiring manager</div>
              <div style={{ fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{currentJob.hiring_manager || '—'}</div>
            </div>
            <div className="card" style={{ flex: '1 0 120px', padding: '8px 12px', height: 56, display: 'flex', flexDirection: 'column', justifyContent: 'flex-start', marginTop: 0 }}>
              <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5, color: 'var(--text-muted)', marginBottom: 2 }}>Source</div>
              <div style={{ fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={currentJob.source ?? undefined}>{currentJob.source || '—'}</div>
            </div>
            <div className="card" style={{ flex: '1 0 140px', padding: '8px 12px', height: 56, display: 'flex', flexDirection: 'column', justifyContent: 'flex-start', marginTop: 0 }}>
              <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5, color: 'var(--text-muted)', marginBottom: 2 }}>Application deadline</div>
              <div style={{ fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{formatJobDate(currentJob.application_deadline)}</div>
            </div>
          </div>

          <div className="section-title">Requirements</div>
          <div className="card" style={{ whiteSpace: 'pre-wrap', fontSize: 13, lineHeight: 1.6 }}>
            {currentJob.requirements || 'No requirements specified.'}
          </div>

          <div className="section-title">Application requirements</div>
          <div className="card" style={{ whiteSpace: 'pre-wrap', fontSize: 13, lineHeight: 1.6 }}>
            {currentJob.application_requirements || 'Not specified.'}
          </div>

          {structuredResult && (
            <>
              <div className="section-title">Keywords</div>
              <div className="card">
                {(['hard', 'soft', 'cert', 'seniority'] as const).map((cat) => {
                  const entries = structuredResult.keywords
                    .filter((k) => k.category === cat)
                    .sort((a, b) => b.weight - a.weight)
                    .slice(0, 5)
                  if (entries.length === 0) return null
                  return (
                    <section key={cat} style={{ marginBottom: 12 }}>
                      <h4 style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5, color: 'var(--text-muted)', marginBottom: 6 }}>{CATEGORY_LABELS[cat]}</h4>
                      <div className="chip-row" style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                        {entries.map((e) => (
                          <span
                            key={`${e.phrase}-${e.source}`}
                            className="chip"
                            style={{
                              display: 'inline-block',
                              padding: '2px 8px',
                              borderRadius: 10,
                              background: 'var(--bg-secondary)',
                              fontSize: 11,
                              color: 'var(--text-muted)'
                            }}
                          >
                            {e.phrase}
                          </span>
                        ))}
                      </div>
                    </section>
                  )
                })}
              </div>
              <div className="section-title">Keyword gaps</div>
              <div className="card">
                <KeywordGapsPanel
                  result={structuredResult}
                  documentText={cv?.content ?? coverLetter?.content ?? docContent}
                />
              </div>
            </>
          )}
        </div>

        <div>
          <div className="section-title">Application workflow</div>

          <div className="card">
            <h4 style={{ marginBottom: 8 }}>1. Tailor documents</h4>
            <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
              Generate a job-specific CV and cover letter using AI.
            </p>
            <div className="actions-row">
              <button
                className="btn btn-primary btn-sm"
                onClick={() => handleTailor('cv')}
                disabled={!!tailoring}
              >
                {tailoring === 'cv' ? 'Generating...' : cv ? 'Regenerate CV' : 'Tailor CV'}
              </button>
              <button
                className="btn btn-primary btn-sm"
                onClick={() => handleTailor('cover_letter')}
                disabled={!!tailoring}
              >
                {tailoring === 'cover_letter' ? 'Generating...' : coverLetter ? 'Regenerate letter' : 'Tailor cover letter'}
              </button>
            </div>
            {(cv || coverLetter) && (
              <div style={{ marginTop: 12, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {cv && (
                  <button className="btn btn-secondary btn-sm" onClick={() => handleViewDoc(cv)}>
                    View CV{cv.model_used ? ` (${cv.model_used})` : ''}
                  </button>
                )}
                {coverLetter && (
                  <button className="btn btn-secondary btn-sm" onClick={() => handleViewDoc(coverLetter)}>
                    View cover letter{coverLetter.model_used ? ` (${coverLetter.model_used})` : ''}
                  </button>
                )}
              </div>
            )}
          </div>

          <div className="card">
            <h4 style={{ marginBottom: 8 }}>2. AI content verification</h4>
            <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
              Documents are automatically reviewed against the job description for quality and relevance.
            </p>
            {cv && (
              <div style={{ marginBottom: 8, padding: 8, background: 'var(--bg)', borderRadius: 6, fontSize: 13 }}>
                <strong>CV</strong>
                {cv.verification_score != null ? (
                  <div style={{ marginTop: 4 }}>
                    <span style={{ color: cv.verification_score >= 70 ? '#22c55e' : '#f59e0b', fontWeight: 600 }}>
                      {cv.verification_score}/100 {cv.verification_score >= 70 ? '✓' : '⚠'}
                    </span>
                    {cv.verification_feedback && (() => {
                      const { cleanFeedback } = extractRulesFromFeedback(cv.verification_feedback)
                      if (!cleanFeedback) return null
                      return (
                        <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4, whiteSpace: 'pre-wrap' }}>
                          {cleanFeedback}
                        </p>
                      )
                    })()}
                    <RuleCheckList
                      rules={extractRulesFromFeedback(cv.verification_feedback ?? '').rules}
                    />
                  </div>
                ) : (
                  <div style={{ marginTop: 4, display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Pending review…</span>
                    <button
                      className="btn btn-secondary btn-sm"
                      onClick={() => handleReview('cv')}
                      disabled={reviewing !== null}
                    >
                      {reviewing === 'cv' ? 'Reviewing…' : 'Review'}
                    </button>
                  </div>
                )}
              </div>
            )}
            {coverLetter && (
              <div style={{ marginBottom: 8, padding: 8, background: 'var(--bg)', borderRadius: 6, fontSize: 13 }}>
                <strong>Cover letter</strong>
                {coverLetter.verification_score != null ? (
                  <div style={{ marginTop: 4 }}>
                    <span style={{ color: coverLetter.verification_score >= 70 ? '#22c55e' : '#f59e0b', fontWeight: 600 }}>
                      {coverLetter.verification_score}/100 {coverLetter.verification_score >= 70 ? '✓' : '⚠'}
                    </span>
                    {coverLetter.verification_feedback && (
                      <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4, whiteSpace: 'pre-wrap' }}>
                        {coverLetter.verification_feedback}
                      </p>
                    )}
                    <RuleCheckList
                      rules={extractRulesFromFeedback(coverLetter.verification_feedback ?? '').rules}
                    />
                  </div>
                ) : (
                  <div style={{ marginTop: 4, display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Pending review…</span>
                    <button
                      className="btn btn-secondary btn-sm"
                      onClick={() => handleReview('cover_letter')}
                      disabled={reviewing !== null}
                    >
                      {reviewing === 'cover_letter' ? 'Reviewing…' : 'Review'}
                    </button>
                  </div>
                )}
              </div>
            )}
            {(!cv && !coverLetter) && (
              <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                Generate a CV and cover letter above first.
              </p>
            )}
            {(cv?.verification_score ?? 0) >= 70 && (coverLetter?.verification_score ?? 0) >= 70 && (
              <p style={{ fontSize: 13, color: '#22c55e', marginTop: 8 }}>✓ Verified and ready to apply</p>
            )}
          </div>

          <div className="card">
            <h4 style={{ marginBottom: 8 }}>3. Submit application</h4>
            {application?.applied_at ? (
              <p style={{ fontSize: 13 }}>
                Applied on {new Date(application.applied_at).toLocaleDateString()} via {application.method}
              </p>
            ) : (
              <>
                <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
                  Record when you've submitted your application.
                </p>
                <button className="btn btn-primary btn-sm" onClick={() => setShowApply(true)}>
                  Mark as applied
                </button>
              </>
            )}
          </div>

          <div className="card">
            <h4 style={{ marginBottom: 8 }}>4. Next steps</h4>
            <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              After applying, follow-ups are auto-scheduled. Schedule interviews from the Interviews page.
            </p>
          </div>
        </div>
      </div>

      <Modal
        open={showApply}
        title="Record application"
        onClose={() => setShowApply(false)}
        actions={
          <>
            <button className="btn btn-secondary" onClick={() => setShowApply(false)}>Cancel</button>
            <button className="btn btn-primary" onClick={handleApply}>Confirm</button>
          </>
        }
      >
        <div className="form-group">
          <label>Application method</label>
          <select value={applyMethod} onChange={(e) => setApplyMethod(e.target.value)}>
            <option>Email</option>
            <option>Company portal</option>
            <option>LinkedIn</option>
            <option>Recruiter</option>
            <option>Other</option>
          </select>
        </div>
        <div className="form-group">
          <label>Contact email</label>
          <input value={contactEmail} onChange={(e) => setContactEmail(e.target.value)} />
        </div>
        <div className="form-group">
          <label>Contact name</label>
          <input value={contactName} onChange={(e) => setContactName(e.target.value)} />
        </div>
      </Modal>

      <Modal
        open={!!viewDoc}
        title={viewDoc?.type === 'cv' ? 'CV' : 'Cover Letter'}
        onClose={() => setViewDoc(null)}
        actions={
          viewDoc && (
            <>
              <button className="btn btn-secondary" onClick={() => setViewDoc(null)}>Close</button>
              <button className="btn btn-danger" onClick={async () => {
                if (!viewDoc || !confirm('Delete this document?')) return
                const docId = viewDoc.id
                try {
                  await api.deleteDocument(docId)
                  // Re-fetch from DB to ensure UI reflects actual state
                  const fresh = (await api.listDocuments(job.id)).filter((d) => d.job_id === job.id)
                  setDocuments(fresh)
                  setViewDoc(null)
                } catch (err) {
                  notify(`Failed to delete document: ${err instanceof Error ? err.message : 'Unknown error'}`, 'error')
                }
              }}>Delete</button>
              <button className="btn btn-secondary" onClick={async () => {
                if (!viewDoc) return
                setExportingDoc(true)
                try {
                  const typeLabel = viewDoc?.type === 'cv' ? 'CV' : 'Cover Letter'
                  const path = await api.exportDocumentPdf(docTitle, docContent, typeLabel, viewDoc.id, job.company, job.title)
                  if (path) alert(`PDF saved to: ${path}`)
                } finally {
                  setExportingDoc(false)
                }
              }} disabled={exportingDoc}>
                {exportingDoc ? 'Exporting...' : 'Download PDF'}
              </button>
              <button className="btn btn-primary" onClick={handleSaveDoc} disabled={savingDoc}>
                {savingDoc ? 'Saving...' : 'Save changes'}
              </button>
            </>
          )
        }
      >
        <div className="form-group">
          <label>Title</label>
          <input value={docTitle} onChange={(e) => setDocTitle(e.target.value)} />
        </div>
        {viewDoc && (
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8 }}>
            Generated {new Date(viewDoc.created_at).toLocaleString()}
            {viewDoc.model_used && ` by ${viewDoc.model_used}`}
          </div>
        )}
        {viewDoc?.type === 'cv' && (
          <div style={{ marginBottom: 12, padding: 12, background: 'var(--bg-secondary)', borderRadius: 8 }}>
            <label style={{ fontWeight: 600, fontSize: 13, display: 'block', marginBottom: 6 }}>Regenerate section</label>
            <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
              <select
                value={selectedSection}
                onChange={(e) => setSelectedSection(e.target.value)}
                style={{ flex: 1 }}
              >
                <option value="">Select section…</option>
                {findSections(docContent).map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
              <button
                className="btn btn-primary btn-sm"
                onClick={handleRegenSection}
                disabled={!selectedSection || !!regeneratingSection}
              >
                {regeneratingSection ? 'Regenerating…' : 'Regenerate'}
              </button>
            </div>
            <textarea
              rows={2}
              value={regenContext}
              onChange={(e) => setRegenContext(e.target.value)}
              placeholder="Add context/instructions for regeneration (optional)…"
              style={{ width: '100%', fontSize: 12, resize: 'vertical' }}
            />
          </div>
        )}
        <div className="form-group">
          <label>Content</label>
          <textarea
            rows={20}
            value={docContent}
            onChange={(e) => setDocContent(e.target.value)}
            style={{ width: '100%', fontFamily: 'monospace', fontSize: 13, lineHeight: 1.6 }}
          />
        </div>
      </Modal>
    </div>
  )
}

interface DescriptionCardProps {
  text: string
  notes?: string | null
  expanded: boolean
  onToggle: () => void
  onLineHeightMeasured: (px: number) => void
}

// Description card with a "Read more..." toggle. The collapse threshold is
// 10 *displayed* lines, not source lines — long paragraphs wrap, so the
// number of source `\n`s can be far smaller than the visual line count
// (and vice versa for short line-broken text). We measure the rendered
// height of the full text against the line-height of the surrounding card
// to decide whether to show the button.
function DescriptionCard({ text, notes, expanded, onToggle, onLineHeightMeasured }: DescriptionCardProps) {
  const COLLAPSE_LINES = 10
  const measureRef = useRef<HTMLDivElement | null>(null)
  const visibleRef = useRef<HTMLDivElement | null>(null)
  const [isOverflowing, setIsOverflowing] = useState(false)

  useEffect(() => {
    // Measure line-height from the always-rendered, never-clipped sentinel.
    // The sentinel shares the card's text styles (whiteSpace: pre-wrap,
    // fontSize 13, lineHeight 1.6) so its computed line-height matches
    // the visible body exactly. We read it after layout and only update
    // when the value actually changes (rounding to a whole pixel avoids
    // re-render loops on sub-pixel jitter from antialiasing).
    const measure = () => {
      const el = measureRef.current
      if (!el) return
      const lh = parseFloat(getComputedStyle(el).lineHeight)
      if (Number.isFinite(lh) && lh > 0) onLineHeightMeasured(Math.round(lh))
    }
    measure()
  }, [onLineHeightMeasured])

  useEffect(() => {
    // Compare the un-clipped height (visibleRef, only present when
    // expanded) against COLLAPSE_LINES * measured line-height. If it
    // exceeds the budget, the card is overflowing and needs the toggle.
    const el = visibleRef.current
    if (!el) return
    const check = () => {
      const h = el.scrollHeight
      const lh = parseFloat(getComputedStyle(el).lineHeight)
      if (!Number.isFinite(lh) || lh <= 0) return
      setIsOverflowing(h > lh * COLLAPSE_LINES + 0.5)
    }
    check()
    // Re-check on resize — the card width changes with window resize, so
    // a paragraph that fits in 10 lines at 1200px might wrap to 12 at 800px.
    const ro = new ResizeObserver(check)
    ro.observe(el)
    return () => ro.disconnect()
  }, [text, expanded])

  // When collapsed, clamp the visible body to exactly COLLAPSE_LINES of
  // line-height (with a soft fade-out gradient so the truncation is
  // visually obvious). When expanded, show everything. The line-height
  // value is read from a CSS custom property that the parent sets from
  // the measured sentinel — var(--desc-line-height) with a sensible
  // fallback of 20.8px (1.6 × 13px) for the first paint before the
  // measurement lands.
  return (
    <div>
      {/* Hidden sentinel: shares the card's text styles so we can read
          the computed line-height reliably. The sentinel uses absolute
          positioning + 1×1 size + visibility:hidden (not display:none,
          which some engines return a blank computed line-height for). */}
      <div
        ref={measureRef}
        aria-hidden
        style={{
          position: 'absolute',
          visibility: 'hidden',
          pointerEvents: 'none',
          whiteSpace: 'pre-wrap',
          fontSize: 13,
          lineHeight: 1.6,
          width: 1,
          height: 1,
          overflow: 'hidden'
        }}
      >
        Ag
      </div>
      <div
        className="card"
        style={{
          position: 'relative',
          whiteSpace: 'pre-wrap',
          fontSize: 13,
          lineHeight: 1.6
        }}
      >
        <div
          ref={visibleRef}
          style={
            !expanded && isOverflowing
              ? {
                  maxHeight: `calc(var(--desc-line-height, 20.8px) * ${COLLAPSE_LINES})`,
                  overflow: 'hidden'
                }
              : undefined
          }
        >
          {text}
        </div>
        {!expanded && isOverflowing && (
          // Soft fade at the bottom edge of the clipped text so the
          // truncation reads as "there's more" instead of "weird cut".
          <div
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              bottom: 0,
              height: 'var(--desc-line-height, 20.8px)',
              background: 'linear-gradient(to bottom, transparent, var(--card-bg, var(--bg)))',
              pointerEvents: 'none'
            }}
          />
        )}
        {notes && (
          <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border)', color: 'var(--text-muted)' }}>
            <strong>Notes:</strong> {notes}
          </div>
        )}
      </div>
      {isOverflowing && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 6 }}>
          <button
            type="button"
            onClick={onToggle}
            style={{ background: 'transparent', border: 'none', padding: 0, cursor: 'pointer', fontSize: 12, color: 'var(--accent)' }}
          >
            {expanded ? 'Show less' : 'Read more...'}
          </button>
        </div>
      )}
    </div>
  )
}
