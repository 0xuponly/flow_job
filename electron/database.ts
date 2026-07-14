import { app, safeStorage } from 'electron'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { cleanDescription, scrapePostingDateFromUrl } from './jobScraper'
import { getOrCreateDek, encryptJson, decryptJson, deleteDek, encryptionMode } from './secureStore'
import { formatLocation } from './utils'
import type {
  ApiModelConfig,
  AIQueueItem,
  Application,
  CreateJobInput,
  DashboardStats,
  DeletedJobRecord,
  Document,
  FollowUp,
  Interview,
  Job,
  JobStatus,
  Settings
} from './types'

const ENCRYPTED_PREFIX = '$enc$'

function dedupKey(url: string): string {
  try {
    const u = new URL(url)
    u.hash = ''
    const trackingParams = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'ref', 'source', 'src', 'tracking', 'spm', 'ta', 'trk']
    trackingParams.forEach(p => u.searchParams.delete(p))
    return u.origin + u.pathname.replace(/\/$/, '').toLowerCase() + u.search
  } catch {
    return url.toLowerCase().replace(/\/$/, '')
  }
}
export function isEncryptionAvailable(): boolean {
  return safeStorage.isEncryptionAvailable()
}

export function encryptionStatus(): { mode: 'sealed' | 'plaintext-fallback' | 'uninitialized' } {
  return { mode: encryptionMode() }
}

interface Store {
  jobs: Job[]
  documents: Document[]
  applications: Application[]
  follow_ups: FollowUp[]
  interviews: Interview[]
  settings: Record<string, string>
  api_models: ApiModelConfig[]
  nextId: number
  seen_urls: string[]
  ai_queue: AIQueueItem[]
  board_health: Record<string, number[]>
  deleted_jobs: DeletedJobRecord[]
}

let store: Store | null = null
let storePath = ''

function getStorePath(): string {
  if (!storePath) {
    storePath = join(app.getPath('userData'), 'apply-assistant-data.json')
  }
  return storePath
}

function defaultStore(): Store {
  return {
    jobs: [],
    documents: [],
    applications: [],
    follow_ups: [],
    interviews: [],
    settings: {
      openai_api_key: '',
      openai_base_url: 'https://api.deepseek.com',
      openai_model: 'deepseek-chat',
      user_name: '',
      user_email: '',
      user_phone: '',
      user_country: '',
      base_cv: '',
      job_search_keywords: '',
      job_search_location: '',
      deleted_jobs_cap: 50000,
      auto_scan_enabled: true,
      auto_scan_interval_minutes: 120,
      locations_normalized: ''
    },
    api_models: [],
    nextId: 1,
    seen_urls: [],
    ai_queue: [],
    board_health: {},
    deleted_jobs: []
  }
}

function stripLegacyEncryptedFields(s: Store): boolean {
  let changed = false
  if (s.settings) {
    for (const k of Object.keys(s.settings)) {
      const v = s.settings[k]
      if (typeof v === 'string' && v.startsWith('$enc$')) {
        try {
          s.settings[k] = safeStorage.decryptString(Buffer.from(v.slice('$enc$'.length), 'hex'))
          changed = true
        } catch {
          s.settings[k] = ''
          changed = true
        }
      }
    }
  }
  if (s.api_models) {
    s.api_models = s.api_models.map((m) => {
      if (typeof m.api_key === 'string' && m.api_key.startsWith('$enc$')) {
        try {
          return { ...m, api_key: safeStorage.decryptString(Buffer.from(m.api_key.slice('$enc$'.length), 'hex')) }
        } catch {
          return { ...m, api_key: '' }
        }
      }
      return m
    })
  }
  return changed
}

function loadStore(): Store {
  if (store) return store
  const path = getStorePath()
  const dir = join(app.getPath('userData'))
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

  if (existsSync(path)) {
    const raw = readFileSync(path, 'utf-8').trim()
    const dek = getOrCreateDek()
    try {
      store = decryptJson<Store>(raw, dek)
      // Strip any leftover legacy field-level encryption wrappers that may have
      // been written by an earlier version of the app before file-level
      // encryption was introduced.
      if (stripLegacyEncryptedFields(store)) persistStore()
    } catch {
      // Either file is legacy plaintext, or DEK is wrong. Try legacy plaintext
      // parse; if that fails, start fresh.
      try {
        const parsed = JSON.parse(raw) as Store
        // Detect plaintext legacy: legacy had no `enc:v1:` prefix and used
        // $enc$ on a few fields only.
        const looksLegacy =
          !raw.startsWith('enc:') &&
          (raw.includes('"$enc$"') || Object.keys(parsed.settings || {}).length > 0)
        if (looksLegacy) {
          stripLegacyEncryptedFields(parsed)
          store = parsed
        } else {
          store = defaultStore()
        }
      } catch {
        store = defaultStore()
      }
    }

    if (!store.api_models || store.api_models.length === 0) {
      const oldKey = store.settings.openai_api_key || ''
      const oldUrl = store.settings.openai_base_url || 'https://api.deepseek.com'
      const oldModel = store.settings.openai_model || 'deepseek-chat'
      if (oldUrl !== 'https://api.deepseek.com' || oldKey) {
        store.api_models = [{
          id: 'model-1',
          name: 'Primary',
          base_url: oldUrl,
          api_key: oldKey,
          model: oldModel
        }]
      }
    }

    // Migrate existing job URLs into seen_urls (normalized for dedup)
    if (!store.seen_urls) {
      store.seen_urls = []
    }
    if (!store.ai_queue) {
      store.ai_queue = []
    }
    if (!store.board_health) {
      store.board_health = {}
    }
    if (!store.deleted_jobs) {
      store.deleted_jobs = []
    }
    if (typeof store.settings.auto_scan_enabled !== 'boolean') {
      store.settings.auto_scan_enabled = true
    }
    if (typeof store.settings.auto_scan_interval_minutes !== 'number' || store.settings.auto_scan_interval_minutes <= 0) {
      store.settings.auto_scan_interval_minutes = 120
    }
    let jobsMigrated = false
    for (const j of store.jobs) {
      if (j.url) {
        const dk = dedupKey(j.url)
        if (!store.seen_urls.some(u => dedupKey(u) === dk)) {
          store.seen_urls.push(j.url)
        }
      }
      if (j.date_posted === undefined) {
        j.date_posted = null
        jobsMigrated = true
      }
      if (j.last_updated === undefined || j.last_updated === null) {
        j.last_updated = j.created_at
        jobsMigrated = true
      }
      if (j.fit_rationale === undefined) {
        j.fit_rationale = null
        jobsMigrated = true
      }
      if (j.fit_breakdown === undefined) {
        j.fit_breakdown = null
        jobsMigrated = true
      }
      if (j.fit_score_version === undefined) {
        j.fit_score_version = null
        jobsMigrated = true
      }
      if (j.fit_last_error === undefined) {
        j.fit_last_error = null
        jobsMigrated = true
      }
    }
    if (typeof store.settings.cv_version !== 'number') {
      store.settings.cv_version = 0
      jobsMigrated = true
    }
    if (jobsMigrated) {
      persistStore()
    }
  } else {
    store = defaultStore()
    persistStore()
  }
  return store
}

function persistStore(): void {
  if (!store) return
  const dek = getOrCreateDek()
  const payload = encryptJson(store, dek)
  writeFileSync(getStorePath(), payload)
}

function nextId(): number {
  const s = loadStore()
  return s.nextId++
}

function now(): string {
  return new Date().toISOString()
}

// Jobs

export function getSeenUrls(): string[] {
  return loadStore().seen_urls
}

function applyCleanDescription(jobs: Job[]): Job[] {
  return jobs.map((j) =>
    j.description ? { ...j, description: cleanDescription(j.description) } : j
  )
}

function normalizeLocation(raw: string | null | undefined): string | null {
  const defaultCountry = (loadStore().settings.user_country as string | undefined) || ''
  return formatLocation(raw, defaultCountry)
}

export function listJobs(status?: JobStatus): Job[] {
  const s = loadStore()
  const jobs = applyCleanDescription([...s.jobs]).sort((a, b) =>
    (b.last_updated || b.updated_at).localeCompare(a.last_updated || a.updated_at)
  )
  return status ? jobs.filter((j) => j.status === status) : jobs
}

export function getJob(id: number): Job | undefined {
  const s = loadStore()
  const job = s.jobs.find((j) => j.id === id)
  if (job && job.description) job.description = cleanDescription(job.description)
  return job
}

export function findDuplicateJob(input: CreateJobInput): Job | undefined {
  const s = loadStore()
  const urlDk = input.url ? dedupKey(input.url) : null
  const title = input.title?.trim().toLowerCase()
  const company = input.company?.trim().toLowerCase()
  const location = input.location?.trim().toLowerCase() || null
  return s.jobs.find((j) => {
    if (urlDk && j.url && dedupKey(j.url) === urlDk) return true
    if (title && company && j.title.toLowerCase() === title && j.company.toLowerCase() === company) {
      const jLoc = j.location?.toLowerCase().trim() || null
      if ((location === null && jLoc === null) || (location !== null && jLoc !== null && (jLoc.includes(location) || location.includes(jLoc)))) {
        return true
      }
    }
    return false
  })
}

export function isBlacklisted(input: { url?: string | null; title: string; company: string; location?: string | null }): boolean {
  // A job is blacklisted (do not re-add) if the user deleted it AND its last
  // known fit score was low (< 0.3). Medium/high-fit deletions are still
  // re-added on future scans since the user might want them back.
  const s = loadStore()
  if (!s.deleted_jobs || s.deleted_jobs.length === 0) return false
  const urlDk = input.url ? dedupKey(input.url) : null
  const title = input.title?.trim().toLowerCase()
  const company = input.company?.trim().toLowerCase()
  const location = input.location?.trim().toLowerCase() || null
  for (const d of s.deleted_jobs) {
    if (d.score == null || d.score >= 0.3) continue
    if (urlDk && d.url && dedupKey(d.url) === urlDk) return true
    if (title && company && d.title.toLowerCase() === title && d.company.toLowerCase() === company) {
      const dLoc = d.location?.toLowerCase().trim() || null
      if ((location === null && dLoc === null) || (location !== null && dLoc !== null && (dLoc.includes(location) || location.includes(dLoc)))) {
        return true
      }
    }
  }
  return false
}

export class JobBlacklistedError extends Error {
  constructor() {
    super('Job was previously deleted with low fit; not re-adding.')
    this.name = 'JobBlacklistedError'
  }
}

export function createJob(input: CreateJobInput): Job {
  if (isBlacklisted(input)) throw new JobBlacklistedError()
  const s = loadStore()
  const job: Job = {
    id: nextId(),
    title: input.title,
    company: input.company,
    location: normalizeLocation(input.location ?? null),
    url: input.url ?? null,
    description: input.description ? cleanDescription(input.description) : null,
    salary_range: input.salary_range ?? null,
    requirements: input.requirements ?? null,
    application_requirements: input.application_requirements ?? null,
    hiring_manager: input.hiring_manager ?? null,
    employment_type: input.employment_type ?? null,
    work_mode: input.work_mode ?? null,
    source: input.source ?? null,
    status: 'sourced',
    score: input.score !== undefined ? (input.score ?? null) : 0.5,
    fit_rationale: input.fit_rationale ?? null,
    fit_breakdown: input.fit_breakdown ?? null,
    fit_score_version: input.fit_score_version ?? null,
    fit_last_error: input.fit_last_error ?? null,
    notes: input.notes ?? null,
    date_posted: input.date_posted ?? null,
    last_updated: now(),
    created_at: now(),
    updated_at: now()
  }
  if (job.url) {
    const dk = dedupKey(job.url)
    if (!s.seen_urls.some(u => dedupKey(u) === dk)) {
      s.seen_urls.push(job.url)
    }
  }
  s.jobs.push(job)
  persistStore()
  return job
}

export function updateJob(
  id: number,
  fields: Partial<CreateJobInput & { status: JobStatus; last_updated?: string | null }>
): Job {
  const s = loadStore()
  const idx = s.jobs.findIndex((j) => j.id === id)
  if (idx === -1) throw new Error('Job not found')
  const existing = s.jobs[idx]
  s.jobs[idx] = {
    ...existing,
    title: fields.title ?? existing.title,
    company: fields.company ?? existing.company,
    location: fields.location !== undefined ? normalizeLocation(fields.location ?? null) : existing.location,
    url: fields.url !== undefined ? (fields.url ?? null) : existing.url,
    description: fields.description !== undefined ? (fields.description ? cleanDescription(fields.description) : null) : existing.description,
    salary_range: fields.salary_range !== undefined ? (fields.salary_range ?? null) : existing.salary_range,
    requirements: fields.requirements !== undefined ? (fields.requirements ?? null) : existing.requirements,
    application_requirements: fields.application_requirements !== undefined ? (fields.application_requirements ?? null) : existing.application_requirements,
    hiring_manager: fields.hiring_manager !== undefined ? (fields.hiring_manager ?? null) : existing.hiring_manager,
    employment_type: fields.employment_type !== undefined ? (fields.employment_type ?? null) : existing.employment_type,
    work_mode: fields.work_mode !== undefined ? (fields.work_mode ?? null) : existing.work_mode,
    source: fields.source !== undefined ? (fields.source ?? null) : existing.source,
    status: fields.status ?? existing.status,
    score: fields.score !== undefined ? (fields.score ?? null) : existing.score,
    fit_rationale: fields.fit_rationale !== undefined ? (fields.fit_rationale ?? null) : existing.fit_rationale,
    fit_breakdown: fields.fit_breakdown !== undefined ? (fields.fit_breakdown ?? null) : existing.fit_breakdown,
    fit_score_version: fields.fit_score_version !== undefined ? (fields.fit_score_version ?? null) : existing.fit_score_version,
    fit_last_error: fields.fit_last_error !== undefined ? (fields.fit_last_error ?? null) : existing.fit_last_error,
    notes: fields.notes !== undefined ? (fields.notes ?? null) : existing.notes,
    date_posted: fields.date_posted !== undefined ? (fields.date_posted ?? null) : existing.date_posted,
    last_updated: fields.last_updated !== undefined ? (fields.last_updated ?? null) : existing.last_updated,
    updated_at: now()
  }
  // Track new URL for dedup if it changed
  const newUrl = s.jobs[idx].url
  if (newUrl && newUrl !== existing.url) {
    const dk = dedupKey(newUrl)
    if (!s.seen_urls.some(u => dedupKey(u) === dk)) {
      s.seen_urls.push(newUrl)
    }
  }
  persistStore()
  return s.jobs[idx]
}

export function deleteJob(id: number): void {
  const s = loadStore()
  const job = s.jobs.find((j) => j.id === id)
  if (job) {
    if (!s.deleted_jobs) s.deleted_jobs = []
    s.deleted_jobs.push({
      url: job.url,
      title: job.title,
      company: job.company,
      location: job.location,
      score: job.score,
      deletedAt: Date.now()
    })
    // Cap the deleted list to the most recent N entries (configurable in settings)
    const cap = typeof s.settings.deleted_jobs_cap === 'number' && s.settings.deleted_jobs_cap > 0
      ? s.settings.deleted_jobs_cap
      : 50000
    if (s.deleted_jobs.length > cap) s.deleted_jobs.splice(0, s.deleted_jobs.length - cap)
  }
  s.jobs = s.jobs.filter((j) => j.id !== id)
  s.documents = s.documents.filter((d) => d.job_id !== id)
  const appIds = s.applications.filter((a) => a.job_id === id).map((a) => a.id)
  s.applications = s.applications.filter((a) => a.job_id !== id)
  s.follow_ups = s.follow_ups.filter((f) => !appIds.includes(f.application_id))
  s.interviews = s.interviews.filter((i) => !appIds.includes(i.application_id))
  persistStore()
}

// Documents

export function getDocument(id: number): Document | undefined {
  return loadStore().documents.find((d) => d.id === id)
}

export function listDocuments(jobId?: number): Document[] {
  const s = loadStore()
  const docs = [...s.documents].sort((a, b) => b.updated_at.localeCompare(a.updated_at))
  if (jobId !== undefined) {
    return docs.filter((d) => d.job_id === jobId || d.is_base === 1)
  }
  return docs
}

export function createDocument(
  type: 'cv' | 'cover_letter',
  title: string,
  content: string,
  jobId?: number,
  isBase = false,
  modelUsed?: string | null
): Document {
  const s = loadStore()
  const doc: Document = {
    id: nextId(),
    job_id: jobId ?? null,
    type,
    title,
    content,
    is_base: isBase ? 1 : 0,
    model_used: modelUsed ?? null,
    created_at: now(),
    updated_at: now()
  }
  s.documents.push(doc)
  persistStore()
  return doc
}

export function deleteDocument(id: number): void {
  const s = loadStore()
  s.documents = s.documents.filter((d) => d.id !== id)
  // Clear any application references to the deleted document
  for (const a of s.applications) {
    if (a.cv_document_id === id) a.cv_document_id = null
    if (a.cover_letter_document_id === id) a.cover_letter_document_id = null
  }
  persistStore()
}

export function updateDocument(id: number, title: string, content: string): Document {
  const s = loadStore()
  const idx = s.documents.findIndex((d) => d.id === id)
  if (idx === -1) throw new Error('Document not found')
  s.documents[idx] = { ...s.documents[idx], title, content, updated_at: now() }
  persistStore()
  return s.documents[idx]
}

export function updateDocumentVerification(
  id: number,
  score: number | null,
  feedback: string | null
): Document {
  const s = loadStore()
  const idx = s.documents.findIndex((d) => d.id === id)
  if (idx === -1) throw new Error('Document not found')
  s.documents[idx] = {
    ...s.documents[idx],
    verification_score: score,
    verification_feedback: feedback,
    updated_at: now()
  }
  persistStore()
  return s.documents[idx]
}

// Recompute a job's status from its current documents. Called whenever
// documents are added, updated, deleted, or their verification score
// changes. Single source of truth for the doc-derived status transitions.
//
// Rule:
//   - Never overwrite a status the user has moved past the doc pipeline
//     (applied, interviewing, offer, rejected, withdrawn).
//   - Otherwise, if the job has both a CV and a cover letter with
//     verification_score >= 70, status = 'ready'.
//   - Otherwise (has docs but not both passing, or only one type),
//     status = 'reviewing'.
//   - With no docs, status = 'sourced'.
const DOC_PROTECTED_STATUSES: JobStatus[] = ['applied', 'interviewing', 'offer', 'rejected', 'withdrawn']

export function recomputeJobStatusFromDocs(jobId: number): JobStatus | null {
  const s = loadStore()
  const jobIdx = s.jobs.findIndex((j) => j.id === jobId)
  if (jobIdx === -1) return null
  const current = s.jobs[jobIdx].status
  if (DOC_PROTECTED_STATUSES.includes(current)) return current

  const docs = s.documents.filter((d) => d.job_id === jobId)
  const cv = docs.find((d) => d.type === 'cv')
  const cl = docs.find((d) => d.type === 'cover_letter')

  let next: JobStatus
  if (docs.length === 0) {
    next = 'sourced'
  } else if (
    cv && cl &&
    (cv.verification_score ?? 0) >= 70 &&
    (cl.verification_score ?? 0) >= 70
  ) {
    next = 'ready'
  } else {
    next = 'reviewing'
  }

  if (next === current) return current
  s.jobs[jobIdx] = { ...s.jobs[jobIdx], status: next, updated_at: now() }
  persistStore()
  return next
}

// Applications

export function listApplications(): (Application & { job_title: string; company: string })[] {
  const s = loadStore()
  return s.applications
    .map((a) => {
      const job = s.jobs.find((j) => j.id === a.job_id)
      return { ...a, job_title: job?.title ?? '', company: job?.company ?? '' }
    })
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
}

export function getOrCreateApplication(jobId: number): Application {
  const s = loadStore()
  let app = s.applications.find((a) => a.job_id === jobId)
  if (!app) {
    app = {
      id: nextId(),
      job_id: jobId,
      status: 'ready',
      applied_at: null,
      method: null,
      contact_email: null,
      contact_name: null,
      notes: null,
      cv_document_id: null,
      cover_letter_document_id: null,
      created_at: now(),
      updated_at: now()
    }
    s.applications.push(app)
    persistStore()
  }
  return app
}

export function updateApplication(id: number, fields: Partial<Application>): Application {
  const s = loadStore()
  const idx = s.applications.findIndex((a) => a.id === id)
  if (idx === -1) throw new Error('Application not found')
  const existing = s.applications[idx]
  s.applications[idx] = {
    ...existing,
    status: fields.status ?? existing.status,
    applied_at: fields.applied_at !== undefined ? fields.applied_at : existing.applied_at,
    method: fields.method !== undefined ? fields.method : existing.method,
    contact_email: fields.contact_email !== undefined ? fields.contact_email : existing.contact_email,
    contact_name: fields.contact_name !== undefined ? fields.contact_name : existing.contact_name,
    notes: fields.notes !== undefined ? fields.notes : existing.notes,
    cv_document_id: fields.cv_document_id !== undefined ? fields.cv_document_id : existing.cv_document_id,
    cover_letter_document_id:
      fields.cover_letter_document_id !== undefined
        ? fields.cover_letter_document_id
        : existing.cover_letter_document_id,
    updated_at: now()
  }
  if (fields.status) {
    const jobIdx = s.jobs.findIndex((j) => j.id === existing.job_id)
    if (jobIdx !== -1) {
      s.jobs[jobIdx] = { ...s.jobs[jobIdx], status: fields.status, updated_at: now() }
    }
  }
  persistStore()
  return s.applications[idx]
}

export function markApplied(
  applicationId: number,
  method: string,
  contactEmail?: string,
  contactName?: string
): Application {
  const appliedAt = now()
  const app = updateApplication(applicationId, {
    status: 'applied',
    applied_at: appliedAt,
    method,
    contact_email: contactEmail ?? null,
    contact_name: contactName ?? null
  })

  const dueDate = new Date()
  dueDate.setDate(dueDate.getDate() + 7)
  const job = getJob(app.job_id)
  createFollowUp(
    applicationId,
    dueDate.toISOString().split('T')[0],
    'email',
    `Follow up on your application to ${job?.company ?? 'the company'}.`
  )

  return app
}

// Follow-ups

export function listFollowUps(includeCompleted = false): (FollowUp & {
  job_title: string
  company: string
})[] {
  const s = loadStore()
  return s.follow_ups
    .filter((f) => includeCompleted || !f.completed_at)
    .map((f) => {
      const app = s.applications.find((a) => a.id === f.application_id)
      const job = app ? s.jobs.find((j) => j.id === app.job_id) : undefined
      return { ...f, job_title: job?.title ?? '', company: job?.company ?? '' }
    })
    .sort((a, b) => a.due_date.localeCompare(b.due_date))
}

export function createFollowUp(
  applicationId: number,
  dueDate: string,
  type: FollowUp['type'],
  message?: string
): FollowUp {
  const s = loadStore()
  const fu: FollowUp = {
    id: nextId(),
    application_id: applicationId,
    due_date: dueDate,
    completed_at: null,
    type,
    message: message ?? null,
    notes: null,
    created_at: now()
  }
  s.follow_ups.push(fu)
  persistStore()
  return fu
}

export function completeFollowUp(id: number): FollowUp {
  const s = loadStore()
  const idx = s.follow_ups.findIndex((f) => f.id === id)
  if (idx === -1) throw new Error('Follow-up not found')
  s.follow_ups[idx] = { ...s.follow_ups[idx], completed_at: now() }
  persistStore()
  return s.follow_ups[idx]
}

// Interviews

export function listInterviews(upcomingOnly = false): (Interview & {
  job_title: string
  company: string
})[] {
  const s = loadStore()
  const nowStr = now()
  return s.interviews
    .filter((i) => !upcomingOnly || (i.outcome === 'scheduled' && i.scheduled_at >= nowStr))
    .map((i) => {
      const app = s.applications.find((a) => a.id === i.application_id)
      const job = app ? s.jobs.find((j) => j.id === app.job_id) : undefined
      return { ...i, job_title: job?.title ?? '', company: job?.company ?? '' }
    })
    .sort((a, b) =>
      upcomingOnly
        ? a.scheduled_at.localeCompare(b.scheduled_at)
        : b.scheduled_at.localeCompare(a.scheduled_at)
    )
}

export function createInterview(
  applicationId: number,
  scheduledAt: string,
  type: Interview['type'],
  durationMinutes = 60,
  location?: string,
  interviewer?: string,
  notes?: string
): Interview {
  const s = loadStore()
  const interview: Interview = {
    id: nextId(),
    application_id: applicationId,
    scheduled_at: scheduledAt,
    duration_minutes: durationMinutes,
    type,
    location: location ?? null,
    interviewer: interviewer ?? null,
    notes: notes ?? null,
    outcome: 'scheduled',
    created_at: now()
  }
  s.interviews.push(interview)
  updateApplication(applicationId, { status: 'interviewing' })
  persistStore()
  return interview
}

export function updateInterview(id: number, fields: Partial<Interview>): Interview {
  const s = loadStore()
  const idx = s.interviews.findIndex((i) => i.id === id)
  if (idx === -1) throw new Error('Interview not found')
  const existing = s.interviews[idx]
  s.interviews[idx] = {
    ...existing,
    scheduled_at: fields.scheduled_at ?? existing.scheduled_at,
    duration_minutes: fields.duration_minutes ?? existing.duration_minutes,
    type: fields.type ?? existing.type,
    location: fields.location !== undefined ? fields.location : existing.location,
    interviewer: fields.interviewer !== undefined ? fields.interviewer : existing.interviewer,
    notes: fields.notes !== undefined ? fields.notes : existing.notes,
    outcome: fields.outcome !== undefined ? fields.outcome : existing.outcome
  }
  persistStore()
  return s.interviews[idx]
}

// Fit scoring

export function updateJobFit(
  id: number,
  fit: {
    score: number
    rationale: string
    breakdown: { matched_skills: string[]; missing_skills: string[]; experience_years_match: boolean | null }
    scoreVersion: number
  }
): Job {
  return updateJob(id, {
    score: fit.score,
    fit_rationale: fit.rationale,
    fit_breakdown: fit.breakdown,
    fit_score_version: fit.scoreVersion
  })
}

// Settings

export function getSettings(): Settings {
  const settings = loadStore().settings
  return settings as unknown as Settings
}

export function updateSettings(partial: Partial<Settings>): Settings {
  if (partial.openai_base_url !== undefined) {
    const url = partial.openai_base_url.trim()
    if (url && !/^https:\/\//.test(url) && !/^http:\/\/(localhost|127\.0\.0\.1)/.test(url)) {
      throw new Error('OpenAI base URL must use HTTPS (or http://localhost for local models).')
    }
  }
  const s = loadStore()
  for (const [key, value] of Object.entries(partial)) {
    if (value !== undefined) {
      s.settings[key] = value
    }
  }
  // If the base CV changed, bump cv_version so any cached fit scores can be invalidated.
  if (partial.base_cv !== undefined) {
    s.settings.cv_version = (typeof s.settings.cv_version === 'number' ? s.settings.cv_version : 0) + 1
  }
  persistStore()
  return getSettings()
}

export function resetSettings(): Settings {
  const s = loadStore()
  s.settings = defaultStore().settings
  persistStore()
  return getSettings()
}

// API Models

function nextModelId(): string {
  return 'model-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6)
}

export function listApiModels(): ApiModelConfig[] {
  return loadStore().api_models
}

export function saveApiModels(models: ApiModelConfig[]): ApiModelConfig[] {
  const s = loadStore()
  s.api_models = models.map((m) => ({
    ...m,
    id: m.id || nextModelId()
  }))
  persistStore()
  return s.api_models
}

export function addApiModel(model: Omit<ApiModelConfig, 'id'>): ApiModelConfig[] {
  const s = loadStore()
  s.api_models.push({ ...model, id: nextModelId() })
  persistStore()
  return s.api_models
}

export function deleteApiModel(id: string): ApiModelConfig[] {
  const s = loadStore()
  s.api_models = s.api_models.filter((m) => m.id !== id)
  persistStore()
  return s.api_models
}

// Dashboard

export function getDashboardStats(): DashboardStats {
  const s = loadStore()
  return {
    total_jobs: s.jobs.length,
    applied: s.applications.filter((a) => ['applied', 'follow_up'].includes(a.status)).length,
    interviewing: s.applications.filter((a) => a.status === 'interviewing').length,
    offers: s.applications.filter((a) => a.status === 'offer').length,
    pending_follow_ups: s.follow_ups.filter((f) => !f.completed_at).length,
    upcoming_interviews: s.interviews.filter(
      (i) => i.outcome === 'scheduled' && i.scheduled_at >= now()
    ).length
  }
}

export function searchJobs(query: string): Job[] {
  const q = query.toLowerCase()
  return listJobs().filter(
    (j) =>
      j.title.toLowerCase().includes(q) ||
      j.company.toLowerCase().includes(q) ||
      (j.description?.toLowerCase().includes(q) ?? false) ||
      (j.location?.toLowerCase().includes(q) ?? false)
  )
}

export function clearSeenUrls(): void {
  const s = loadStore()
  s.seen_urls = []
  persistStore()
}

export function hasLocationsNormalized(): boolean {
  return loadStore().settings.locations_normalized === '1'
}

export function markLocationsNormalized(): void {
  const s = loadStore()
  s.settings.locations_normalized = '1'
  persistStore()
}

/**
 * Increment the global CV version. The next time the bootstrap score pass
 * runs, it will re-score every job whose `fit_score_version` doesn't match
 * the new value — i.e. every job that's currently holding a stale (or
 * heuristic-only) fit score. The user can also call this from the UI by
 * editing the base CV in Settings, which already does the same thing.
 */
export function bumpCvVersion(): number {
  const s = loadStore()
  s.settings.cv_version = (typeof s.settings.cv_version === 'number' ? s.settings.cv_version : 0) + 1
  persistStore()
  return s.settings.cv_version
}

export function hasFitRescoreFlag(): boolean {
  return loadStore().settings.fit_rescored_v2 === '1'
}

export function markFitRescored(): void {
  const s = loadStore()
  s.settings.fit_rescored_v2 = '1'
  persistStore()
}

export function retrofitLocations(): { updated: number; total: number } {
  const s = loadStore()
  const defaultCountry = (s.settings.user_country as string | undefined) || ''
  let updated = 0
  for (const j of s.jobs) {
    const normalized = formatLocation(j.location, defaultCountry)
    if (normalized !== j.location) {
      j.location = normalized
      j.updated_at = now()
      updated++
    }
  }
  // Set the flag whether or not anything changed, so we don't re-scan every launch.
  s.settings.locations_normalized = '1'
  persistStore()
  return { updated, total: s.jobs.length }
}

export async function backfillJobPostingDates(): Promise<number> {
  const s = loadStore()
  if (s.settings.job_dates_backfilled === '1') return 0

  const targets = s.jobs.filter((j) => j.url && !j.date_posted)
  let updated = 0
  for (const job of targets) {
    try {
      const datePosted = await scrapePostingDateFromUrl(job.url!)
      updateJob(job.id, {
        ...(datePosted ? { date_posted: datePosted } : {}),
        last_updated: now()
      })
      updated++
      await new Promise((r) => setTimeout(r, 500 + Math.random() * 1000))
    } catch {
      updateJob(job.id, { last_updated: now() })
    }
  }

  s.settings.job_dates_backfilled = '1'
  persistStore()
  return updated
}

export function clearAllData(): void {
  // Wipe the data file and the DEK so any previously-encrypted backups become
  // unreadable, then re-initialize a fresh empty store.
  const path = getStorePath()
  if (existsSync(path)) {
    try { require('fs').unlinkSync(path) } catch { /* ignore */ }
  }
  deleteDek()
  store = null
  const s = loadStore()
  s.jobs = []
  s.documents = []
  s.applications = []
  s.follow_ups = []
  s.interviews = []
  s.seen_urls = []
  s.nextId = 1
  delete s.settings.job_dates_backfilled
  persistStore()
}

export function exportAllData(): unknown {
  const s = loadStore()
  return {
    exportedAt: new Date().toISOString(),
    app: 'Apply Assistant',
    version: 2,
    data: {
      jobs: s.jobs,
      documents: s.documents,
      applications: s.applications,
      followUps: s.follow_ups,
      interviews: s.interviews,
      seenUrls: s.seen_urls,
      aiQueue: s.ai_queue,
      boardHealth: s.board_health,
      deletedJobs: s.deleted_jobs,
      settings: { ...s.settings, openai_api_key: '' }, // never export API keys
      apiModels: s.api_models.map((m) => ({ ...m, api_key: '' }))
    }
  }
}

// Board health tracking

export function getBoardHealth(): Record<string, number[]> {
  return loadStore().board_health
}

export function recordBoardResults(name: string, totalFound: number): void {
  const s = loadStore()
  if (!s.board_health) s.board_health = {}
  const history = s.board_health[name] || []
  history.push(totalFound)
  // Keep only the last 5 results
  if (history.length > 5) history.splice(0, history.length - 5)
  s.board_health[name] = history
  persistStore()
}

// AI Queue

export function addAIQueueItem(item: Omit<AIQueueItem, 'id' | 'createdAt' | 'nextRetryAt' | 'attempts' | 'status'>): AIQueueItem {
  const s = loadStore()
  const queued: AIQueueItem = {
    ...item,
    id: s.nextId++,
    status: 'pending',
    attempts: 0,
    createdAt: Date.now(),
    nextRetryAt: Date.now()
  }
  s.ai_queue.push(queued)
  persistStore()
  return queued
}

export function getAIQueue(): AIQueueItem[] {
  return loadStore().ai_queue ?? []
}

export function updateAIQueueItem(id: number, updates: Partial<AIQueueItem>): void {
  const s = loadStore()
  const idx = s.ai_queue.findIndex((q) => q.id === id)
  if (idx === -1) return
  s.ai_queue[idx] = { ...s.ai_queue[idx], ...updates }
  persistStore()
}

export function removeAIQueueItem(id: number): void {
  const s = loadStore()
  s.ai_queue = s.ai_queue.filter((q) => q.id !== id)
  persistStore()
}
