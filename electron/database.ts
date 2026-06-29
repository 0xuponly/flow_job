import { app, safeStorage } from 'electron'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { cleanDescription, scrapePostingDateFromUrl } from './jobScraper'
import type {
  ApiModelConfig,
  Application,
  CreateJobInput,
  DashboardStats,
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
const SENSITIVE_FIELDS = new Set([
  'openai_api_key',
  'user_name',
  'user_email',
  'user_phone',
  'base_cv'
])

function encryptField(value: string): string {
  if (!value || !safeStorage.isEncryptionAvailable()) return value
  return ENCRYPTED_PREFIX + safeStorage.encryptString(value).toString('hex')
}

function decryptField(value: string): string {
  if (!value || !safeStorage.isEncryptionAvailable()) return value
  if (!value.startsWith(ENCRYPTED_PREFIX)) return value
  try {
    return safeStorage.decryptString(Buffer.from(value.slice(ENCRYPTED_PREFIX.length), 'hex'))
  } catch {
    return value
  }
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
      job_search_location: ''
    },
    api_models: [],
    nextId: 1,
    seen_urls: []
  }
}

function loadStore(): Store {
  if (store) return store
  const path = getStorePath()
  const dir = join(app.getPath('userData'))
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

  if (existsSync(path)) {
    store = JSON.parse(readFileSync(path, 'utf-8')) as Store
    for (const key of SENSITIVE_FIELDS) {
      if (key in store.settings) {
        store.settings[key] = decryptField(store.settings[key])
      }
    }
    if (store.api_models) {
      store.api_models = store.api_models.map((m) => ({
        ...m,
        api_key: decryptField(m.api_key)
      }))
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
  const settings = { ...store.settings }
  for (const key of SENSITIVE_FIELDS) {
    if (key in settings) {
      settings[key] = encryptField(settings[key])
    }
  }
  const api_models = store.api_models.map((m) => ({
    ...m,
    api_key: encryptField(m.api_key)
  }))
  const data = { ...store, settings, api_models }
  writeFileSync(getStorePath(), JSON.stringify(data, null, 2))
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

export function createJob(input: CreateJobInput): Job {
  const s = loadStore()
  const job: Job = {
    id: nextId(),
    title: input.title,
    company: input.company,
    location: input.location ?? null,
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
    location: fields.location !== undefined ? (fields.location ?? null) : existing.location,
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
