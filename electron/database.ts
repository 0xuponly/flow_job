import { app, safeStorage } from 'electron'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import type {
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
  nextId: number
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
      openai_base_url: 'https://api.openai.com/v1',
      openai_model: 'gpt-4o-mini',
      user_name: '',
      user_email: '',
      user_phone: '',
      base_cv: '',
      job_search_keywords: '',
      job_search_location: ''
    },
    nextId: 1
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
  const data = { ...store, settings }
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

export function listJobs(status?: JobStatus): Job[] {
  const s = loadStore()
  const jobs = [...s.jobs].sort((a, b) => b.updated_at.localeCompare(a.updated_at))
  return status ? jobs.filter((j) => j.status === status) : jobs
}

export function getJob(id: number): Job | undefined {
  return loadStore().jobs.find((j) => j.id === id)
}

export function createJob(input: CreateJobInput): Job {
  const s = loadStore()
  const job: Job = {
    id: nextId(),
    title: input.title,
    company: input.company,
    location: input.location ?? null,
    url: input.url ?? null,
    description: input.description ?? null,
    salary_range: input.salary_range ?? null,
    source: input.source ?? null,
    status: 'sourced',
    notes: input.notes ?? null,
    created_at: now(),
    updated_at: now()
  }
  s.jobs.push(job)
  persistStore()
  return job
}

export function updateJob(
  id: number,
  fields: Partial<CreateJobInput & { status: JobStatus }>
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
    description: fields.description !== undefined ? (fields.description ?? null) : existing.description,
    salary_range: fields.salary_range !== undefined ? (fields.salary_range ?? null) : existing.salary_range,
    source: fields.source !== undefined ? (fields.source ?? null) : existing.source,
    status: fields.status ?? existing.status,
    notes: fields.notes !== undefined ? (fields.notes ?? null) : existing.notes,
    updated_at: now()
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
  isBase = false
): Document {
  const s = loadStore()
  const doc: Document = {
    id: nextId(),
    job_id: jobId ?? null,
    type,
    title,
    content,
    is_base: isBase ? 1 : 0,
    created_at: now(),
    updated_at: now()
  }
  s.documents.push(doc)
  persistStore()
  return doc
}

export function updateDocument(id: number, title: string, content: string): Document {
  const s = loadStore()
  const idx = s.documents.findIndex((d) => d.id === id)
  if (idx === -1) throw new Error('Document not found')
  s.documents[idx] = { ...s.documents[idx], title, content, updated_at: now() }
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
    if (url && !/^https:\/\/.+/.test(url)) {
      throw new Error('OpenAI base URL must use HTTPS.')
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
