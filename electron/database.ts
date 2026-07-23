import { app, safeStorage } from 'electron'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { cleanDescription, isLinkedInStubDescription, scrapePostingDateFromUrl } from './jobScraper'
import { getOrCreateDek, encryptJson, decryptJson, deleteDek, encryptionMode } from './secureStore'
import { formatLocation, decodeEntities, normalizeTitle, normalizeCompany, normalizeSalary } from './utils'
import { normalizeEmploymentType, normalizeWorkMode } from './employmentType'
import { matchGradeFor } from './matchGrade'
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
    const trackingParams = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'ref', 'source', 'src', 'tracking', 'trackingId', 'trk', 'spm', 'ta', 'refId']
    trackingParams.forEach(p => u.searchParams.delete(p))
    // Most sites use the hash only for in-page anchors ("#apply",
    // "#section-2") — those aren't job identities, so we strip them.
    // But hash-routed SPAs (e.g. WorkBC stores the jobId in
    // `#/job-details/{id}`) put the job identity IN the hash, so two
    // different jobs share the same path+query and only differ by
    // fragment. Keep the hash when it looks like a path
    // (`#/foo/bar/...` or starts with `/` after the `#`).
    const hashLooksLikePath = u.hash.startsWith('#/') || u.hash.startsWith('/')
    const hashPart = hashLooksLikePath ? u.hash.toLowerCase() : ''
    return u.origin + u.pathname.replace(/\/$/, '').toLowerCase() + u.search + hashPart
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
  blacklisted_companies?: string[]
}

let store: Store | null = null
let storePath = ''

export function getStorePath(): string {
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
      job_search_locations: '',
      deleted_jobs_cap: 50000,
      auto_scan_enabled: true,
      auto_scan_interval_minutes: 120,
      locations_normalized: '',
      locations_normalized_v2: '',
      locations_normalized_v3: '',
      locations_normalized_v4: '',
      locations_array_migrated_v1: '',
      employment_type_normalized: '',
      work_mode_normalized: '',
      title_casing_normalized: '',
      title_casing_normalized_v2: '',
      statuses_recomputed: '',
      backup_path: '',      backup_last_success_at: '',
      backup_last_error: '',
      passphrase: '',
      auto_tailor_on_scan: false,
      auto_tailor_min_fit: 90,
      quick_apply_shortcut: null
    },
    api_models: [],
    nextId: 1,
    seen_urls: [],
    ai_queue: [],
    board_health: {},
    deleted_jobs: [],
    blacklisted_companies: []
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
    } catch (err) {
      // Distinguish three failure modes:
      //
      //   1. Modern encrypted payload (`enc:v1:` prefix) but decryption
      //      failed. The most likely cause is a DEK mismatch — the live
      //      encryption key no longer matches the one that encrypted this
      //      file. This can happen after `clearAllData()` (which deletes
      //      the key file and regenerates a DEK), a safeStorage / OS
      //      keychain hiccup that caused `getOrCreateDek` to silently
      //      regenerate, or restoring a backup made on a different
      //      machine. In all of these cases, falling back to a fresh
      //      store would silently wipe the user's data — exactly the
      //      failure mode this code path was producing before this fix.
      //      Throw a typed error instead so the caller can surface it
      //      to the user (e.g. "Cannot decrypt data file — your
      //      encryption key has been regenerated. Restore from a
      //      passphrase-wrapped backup to recover.").
      //
      //   2. Legacy plaintext payload (no `enc:` prefix). Try parsing
      //      as JSON; if it has the legacy markers, load it. This path
      //      is preserved for users upgrading from pre-encryption
      //      builds.
      //
      //   3. Corrupt JSON, empty file, or otherwise unparseable. Start
      //      fresh (the only case where defaulting is safe).
      if (raw.startsWith('enc:')) {
        const reason = err instanceof Error ? err.message : String(err)
        throw new Error(
          `Cannot decrypt data file (${reason}). The encryption key may have been ` +
          `regenerated. If you have a passphrase-protected backup, restore it now ` +
          `to recover your data.`
        )
      }
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
    if (!store.blacklisted_companies) {
      store.blacklisted_companies = []
    }
    if (typeof store.settings.auto_scan_enabled !== 'boolean') {
      store.settings.auto_scan_enabled = true
    }
    if (typeof store.settings.auto_scan_interval_minutes !== 'number' || store.settings.auto_scan_interval_minutes <= 0) {
      store.settings.auto_scan_interval_minutes = 120
    }
    if (typeof store.settings.auto_tailor_on_scan !== 'boolean') {
      store.settings.auto_tailor_on_scan = false
    }
    if (typeof store.settings.auto_tailor_min_fit !== 'number') {
      store.settings.auto_tailor_min_fit = 90
    } else if (store.settings.auto_tailor_min_fit > 0 && store.settings.auto_tailor_min_fit <= 1) {
      // Migrate from the pre-2026-07-22 0-1 scale to the 0-100 percent
      // scale. The threshold is "<= 1" so the new defaults (90) and any
      // user-set value in 0-100 are untouched.
      store.settings.auto_tailor_min_fit = Math.round(store.settings.auto_tailor_min_fit * 100)
    }
    if (typeof store.settings.quick_apply_shortcut !== 'string' && store.settings.quick_apply_shortcut !== null) {
      store.settings.quick_apply_shortcut = null
    }
    if (!Array.isArray(store.settings.disabled_boards)) {
      // Per-board on/off list, populated by the Settings > Boards tab.
      // Empty array = all boards enabled (current default for users
      // upgrading to this version). Strings are board names matching
      // `BOARDS[].name` in `electron/jobSearch.ts`.
      store.settings.disabled_boards = []
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
      if (j.application_deadline === undefined) {
        j.application_deadline = null
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
      if (j.fit_error_toasted === undefined) {
        j.fit_error_toasted = null
        jobsMigrated = true
      }
      if (j.match_grade === undefined) {
        j.match_grade = matchGradeFor(j.score ?? null)
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
  // Use the sync write AND explicitly sync to disk before returning.
  // Without fsync, writeFileSync returns once the data is in the OS
  // write cache; a crash or rapid subsequent read could see a stale
  // file. fsync guarantees the bytes are on stable storage.
  const fd = require('fs').openSync(getStorePath(), 'w')
  try {
    require('fs').writeSync(fd, payload)
    require('fs').fsyncSync(fd)
  } finally {
    require('fs').closeSync(fd)
  }
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

// Returns the subset of `jobs` that would survive the renderer's
// `dedupeJobs`: first occurrence of each URL (protocol+host+pathname)
// or company+title+location triple wins; later duplicates are dropped.
// The order in the input is preserved, so callers that pass `s.jobs`
// keep insertion order, and callers that pass a sorted list keep their
// sort. Shared by `getDashboardStats` (so the dashboard's "Jobs
// tracked" matches what the Job Board actually shows) and by
// `dedupeJobs` (so DB-side and renderer-side agree on what counts).
function uniqueJobsByDedupeKey(jobs: Job[]): Job[] {
  const seenUrl = new Set<string>()
  const seenKey = new Set<string>()
  return jobs.filter((j) => {
    if (j.url) {
      try {
        const u = new URL(j.url)
        // Hash-routed SPAs (e.g. WorkBC's `#/job-details/{id}`) put the
        // job identity in the fragment. Keep the hash when it looks
        // like a path (`#/foo/bar/...` or starts with `/`); strip
        // in-page anchors like `#apply`.
        const hashLooksLikePath = u.hash.startsWith('#/') || u.hash.startsWith('/')
        const hashPart = hashLooksLikePath ? u.hash.toLowerCase() : ''
        const k = `${u.protocol}//${u.host}${u.pathname.replace(/\/$/, '')}${u.search}${hashPart}`.toLowerCase()
        if (seenUrl.has(k)) return false
        seenUrl.add(k)
      } catch {
        // fall through to company+title+location
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

export function getJob(id: number): Job | undefined {
  const s = loadStore()
  const job = s.jobs.find((j) => j.id === id)
  if (job && job.description) job.description = cleanDescription(job.description)
  return job
}

export function getApplication(id: number): Application | undefined {
  return loadStore().applications.find((a) => a.id === id)
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
  // A job is blacklisted (do not re-add) if the user deleted it. All
  // deletions are now permanent regardless of fit score — the previous
  // "only low-fit deletions stick" rule caused deleted medium/high-fit
  // jobs to silently come back on the next scan, which surprised
  // users. If you want a job back, re-add it via the Add-from-link
  // flow or manual import.
  //
  // Matching is intentionally fuzzy on location: the scanner can
  // produce a re-scan of the same job with a different (or null)
  // location field, and an exact location match would let the scan
  // slip a "deleted" job back in. The match requires title + company
  // to agree (those are stable across scans); location is a tiebreaker
  // when both sides have one.
  const s = loadStore()
  if (s.deleted_jobs && s.deleted_jobs.length > 0) {
    const urlDk = input.url ? dedupKey(input.url) : null
    const title = input.title?.trim().toLowerCase()
    const company = input.company?.trim().toLowerCase()
    const location = input.location?.trim().toLowerCase() || null
    for (const d of s.deleted_jobs) {
      // URL match (after tracking-param stripping via dedupKey). This
      // catches the common case where the scanner finds the same job
      // via a slightly different URL.
      if (urlDk && d.url && dedupKey(d.url) === urlDk) return true
      // Title + company match is the canonical "same job" check.
      // If both agree, this is the same job regardless of location
      // differences (scanner may have parsed the location differently
      // this time, or the job posting no longer exposes a location).
      if (title && company && d.title && d.company &&
          d.title.toLowerCase() === title && d.company.toLowerCase() === company) {
        return true
      }
    }
  }
  // Explicit company blacklist maintained by the user.
  if (isCompanyBlacklisted(input.company)) return true
  return false
}

// User-managed company blacklist. Companies in this list are never
// re-sourced via Job Scan. Case-insensitive; matching ignores surrounding
// whitespace. Stored as the user typed it (preserving original casing for
// display), but lookup is lowercased.
export function isCompanyBlacklisted(name: string | null | undefined): boolean {
  if (!name) return false
  const lc = name.trim().toLowerCase()
  if (!lc) return false
  const s = loadStore()
  if (!s.blacklisted_companies) return false
  return s.blacklisted_companies.some((c) => c.toLowerCase() === lc)
}

export function listBlacklistedCompanies(): string[] {
  const s = loadStore()
  if (!s.blacklisted_companies) return []
  // Sort alphabetically (case-insensitive) for stable UI.
  return [...s.blacklisted_companies].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
}

export function addBlacklistedCompany(name: string): string[] {
  const trimmed = name.trim()
  if (!trimmed) return listBlacklistedCompanies()
  const s = loadStore()
  if (!s.blacklisted_companies) s.blacklisted_companies = []
  const lc = trimmed.toLowerCase()
  if (!s.blacklisted_companies.some((c) => c.toLowerCase() === lc)) {
    s.blacklisted_companies.push(trimmed)
    persistStore()
  }
  return listBlacklistedCompanies()
}

export function removeBlacklistedCompany(name: string): string[] {
  const s = loadStore()
  if (!s.blacklisted_companies) return []
  const lc = name.trim().toLowerCase()
  s.blacklisted_companies = s.blacklisted_companies.filter((c) => c.toLowerCase() !== lc)
  persistStore()
  return listBlacklistedCompanies()
}

export class JobBlacklistedError extends Error {
  constructor() {
    super('Job was previously deleted with low fit; not re-adding.')
    this.name = 'JobBlacklistedError'
  }
}

export class JobDuplicateError extends Error {
  constructor() {
    super('Job with this URL or company+title+location already exists.')
    this.name = 'JobDuplicateError'
  }
}

export function createJob(
  input: CreateJobInput,
  opts: { skipDuplicateCheck?: boolean; force?: boolean } = {}
): { job: Job; wasBlacklisted: boolean } {
  // `force: true` is used by manual-add and import-from-link flows to
  // bypass the deleted-jobs blacklist so the user can re-add a job
  // they previously deleted. The scanner never sets this; it respects
  // the blacklist. The deleted-jobs entry is NOT removed — keeping
  // it means the scanner won't re-add the job automatically on a
  // future scan, matching the user's choice ("Allow re-add, keep
  // blacklist entry"). `wasBlacklisted` is returned alongside the
  // job so the IPC layer can prompt the user to confirm.
  const wasBlacklisted = isBlacklisted(input)
  if (wasBlacklisted && !opts.force) throw new JobBlacklistedError()
  // Defense in depth: even when the caller pre-checked, a concurrent scan
  // can race past the in-memory dedupe and try to insert the same job twice.
  // The DB check here is the last line of defense. Callers that intentionally
  // want to re-add (manual add from link) can opt out via skipDuplicateCheck.
  if (!opts.skipDuplicateCheck && findDuplicateJob(input)) throw new JobDuplicateError()
  const s = loadStore()
  // Strip HTML entities from all text fields at the persistence boundary.
  // Scrapers should already have decoded, but a defense-in-depth pass here
  // ensures stray entities (&ldquo;, &amp;, &#NNN;, etc.) never land in
  // the database, regardless of which scraper produced the input.
  const de = (v: string | null | undefined): string | null =>
    v == null ? null : decodeEntities(v)
  const description = input.description ? cleanDescription(decodeEntities(input.description)) : null
  // Normalize salary to its annual equivalent. The description is
  // passed in so hourly postings can pick up the posting's stated
  // hours-per-week (e.g. "37.5 hours per week"); if the posting
  // doesn't state hours, normalizeSalary falls back to 40/week.
  const salaryNormalized = normalizeSalary(de(input.salary_range), description)
  // Canonicalize employment_type to one of 8 UPPER_SNAKE tokens so
  // the Edit dropdown is the single source of truth and downstream
  // consumers (filters, scoring, exports) only see the enum values.
  const employmentTypeNormalized = normalizeEmploymentType(input.employment_type)
  // Same shape for work_mode: 3 tokens (ON_SITE, HYBRID, REMOTE).
  const workModeNormalized = normalizeWorkMode(input.work_mode)
  const job: Job = {
    id: nextId(),
    title: normalizeTitle(de(input.title)) ?? de(input.title)!,
    company: normalizeCompany(de(input.company)) ?? de(input.company)!,
    location: normalizeLocation(input.location ?? null),
    url: input.url ?? null,
    description,
    salary_range: salaryNormalized ?? de(input.salary_range ?? null),
    requirements: de(input.requirements ?? null),
    application_requirements: de(input.application_requirements ?? null),
    hiring_manager: de(input.hiring_manager ?? null),
    employment_type: employmentTypeNormalized,
    work_mode: workModeNormalized,
    source: input.source ?? null,
    status: 'sourced',
    score: input.score !== undefined ? (input.score ?? null) : 0.31,
    fit_rationale: input.fit_rationale ?? null,
    fit_breakdown: input.fit_breakdown ?? null,
    fit_score_version: input.fit_score_version ?? null,
    fit_last_error: input.fit_last_error ?? null,
    fit_error_toasted: null,
    match_grade: matchGradeFor(input.score ?? null),
    notes: de(input.notes ?? null),
    date_posted: input.date_posted ?? null,
    application_deadline: input.application_deadline ?? null,
    last_updated: now(),
    created_at: now(),
    updated_at: now()
  }
  if (job.url) {
    const dk = dedupKey(job.url)
    // Final, atomic dedup at the commit point. The earlier
    // `findDuplicateJob` check (line ~533) runs against a store
    // snapshot that may predate a concurrent `createJob` call. Two
    // concurrent scanners can both pass the pre-check, both call
    // `createJob`, and both commit before either has persisted — the
    // first to commit doesn't tell the second. Re-check the URL
    // against the *freshly* loaded store synchronously, immediately
    // before the push. From here through `persistStore()` is a
    // synchronous block on the Node event loop, so no other
    // `createJob` can interleave. Manual-add callers opt out via
    // `skipDuplicateCheck`; for those, skip the atomic recheck too
    // (they've already been told they're forcing).
    if (!opts.skipDuplicateCheck && s.jobs.some((j) => j.url && dedupKey(j.url) === dk)) {
      throw new JobDuplicateError()
    }
    if (!s.seen_urls.some(u => dedupKey(u) === dk)) {
      s.seen_urls.push(job.url)
    }
  }
  s.jobs.push(job)
  persistStore()
  return { job, wasBlacklisted }
}

export function updateJob(
  id: number,
  fields: Partial<CreateJobInput & { status: JobStatus; last_updated?: string | null }>
): Job {
  const s = loadStore()
  const idx = s.jobs.findIndex((j) => j.id === id)
  if (idx === -1) throw new Error('Job not found')
  const existing = s.jobs[idx]
  const de = (v: string | null | undefined): string | null =>
    v == null ? null : decodeEntities(v)
  // Resolve the new description first so the salary normalizer can
  // pick up hours-per-week from the posting body when present.
  const nextDescription = fields.description !== undefined
    ? (fields.description ? cleanDescription(decodeEntities(fields.description)) : null)
    : existing.description
  s.jobs[idx] = {
    ...existing,
    // Title and company are normalized on add (createJob) only.
    // Edits via updateJob write the user's exact text so they can
    // adjust the casing / wording without the boundary silently
    // re-canonicalizing it.
    title: fields.title !== undefined ? de(fields.title) ?? existing.title : existing.title,
    company: fields.company !== undefined ? de(fields.company) ?? existing.company : existing.company,
    location: fields.location !== undefined ? (fields.location ? de(fields.location) : null) : existing.location,
    url: fields.url !== undefined ? (fields.url ?? null) : existing.url,
    description: nextDescription,
    // Blank / null salary should clear the field, not preserve the prior
    // value. If the user explicitly submitted null/empty, return null
    // (not the existing value). If they submitted a non-empty string,
    // run it through the normalizer; if the normalizer can't parse it,
    // fall back to the entity-decoded raw input so we never silently
    // overwrite their typed text with the prior $0.
    salary_range: fields.salary_range !== undefined
      ? (fields.salary_range == null || fields.salary_range === ''
          ? null
          : (normalizeSalary(de(fields.salary_range), nextDescription) ?? de(fields.salary_range)))
      : existing.salary_range,
    requirements: fields.requirements !== undefined ? de(fields.requirements ?? null) : existing.requirements,
    application_requirements: fields.application_requirements !== undefined ? de(fields.application_requirements ?? null) : existing.application_requirements,
    hiring_manager: fields.hiring_manager !== undefined ? de(fields.hiring_manager ?? null) : existing.hiring_manager,
    employment_type: fields.employment_type !== undefined
      ? (normalizeEmploymentType(fields.employment_type))
      : existing.employment_type,
    work_mode: fields.work_mode !== undefined
      ? (normalizeWorkMode(fields.work_mode))
      : existing.work_mode,
    source: fields.source !== undefined ? (fields.source ?? null) : existing.source,
    status: fields.status ?? existing.status,
    score: fields.score !== undefined ? (fields.score ?? null) : existing.score,
    match_grade: fields.score !== undefined ? matchGradeFor(fields.score ?? null) : existing.match_grade,
    fit_rationale: fields.fit_rationale !== undefined ? (fields.fit_rationale ?? null) : existing.fit_rationale,
    fit_breakdown: fields.fit_breakdown !== undefined ? (fields.fit_breakdown ?? null) : existing.fit_breakdown,
    fit_score_version: fields.fit_score_version !== undefined ? (fields.fit_score_version ?? null) : existing.fit_score_version,
    fit_last_error: fields.fit_last_error !== undefined ? (fields.fit_last_error ?? null) : existing.fit_last_error,
    fit_error_toasted: fields.fit_error_toasted !== undefined ? (fields.fit_error_toasted ?? null) : existing.fit_error_toasted,
    notes: fields.notes !== undefined ? de(fields.notes ?? null) : existing.notes,
    date_posted: fields.date_posted !== undefined ? (fields.date_posted ?? null) : existing.date_posted,
    application_deadline: fields.application_deadline !== undefined ? (fields.application_deadline ?? null) : existing.application_deadline,
    last_updated: fields.last_updated !== undefined ? (fields.last_updated ?? null) : existing.last_updated,
    updated_at: now()
  }
  // Bump last_updated on real content edits (title, company, location,
  // description, salary, type, work mode, hiring manager, requirements,
  // application requirements, url, source). Status / fit / notes
  // changes are intentionally NOT tracked here — those are bookkeeping
  // moves, not content edits. Skip if the caller already passed an
  // explicit last_updated (backfill, createJob) so we don't overwrite
  // the authoritative value.
  if (fields.last_updated === undefined) {
    const CONTENT_FIELDS = [
      'title', 'company', 'location', 'description', 'salary_range',
      'employment_type', 'work_mode', 'hiring_manager', 'requirements',
      'application_requirements', 'url', 'source', 'application_deadline'
    ] as const
    const changed = CONTENT_FIELDS.some(
      (k) => s.jobs[idx][k] !== existing[k]
    )
    if (changed) s.jobs[idx].last_updated = now()
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

// Batch variant used by the Job Board's checkbox delete. Loads the store
// once, applies all deletions to that single in-memory copy, and writes
// the result back exactly once. The per-job loop in the renderer (one
// IPC call per id) was both slow for large selections and racy: each
// per-call loadStore() + persistStore() round-trip could interleave with
// other writers (background scan, auto-scan, fit scorer), and any
// intermediate failure would leave the store half-deleted with no
// transactional guarantee that the next call's read sees the previous
// call's write. This atomic version is the source of truth.
export function deleteJobs(ids: number[]): { requested: number; deleted: number; missingFromStore: number[]; stillPresentAfterFilter: number[] } {
  if (ids.length === 0) return { requested: 0, deleted: 0, missingFromStore: [], stillPresentAfterFilter: [] }
  const idSet = new Set(ids)
  const s = loadStore()
  const beforeCount = s.jobs.length
  const idsMissing = [...idSet].filter((id) => !s.jobs.find((j) => j.id === id))
  // Move each deleted job into the deleted-jobs blacklist (used by the
  // scanner to avoid re-adding the same URL). The blacklist is capped
  // to settings.deleted_jobs_cap to keep the store from growing
  // unbounded over time.
  if (!s.deleted_jobs) s.deleted_jobs = []
  let deleted = 0
  for (const id of idSet) {
    const job = s.jobs.find((j) => j.id === id)
    if (!job) continue
    s.deleted_jobs.push({
      url: job.url,
      title: job.title,
      company: job.company,
      location: job.location,
      score: job.score,
      deletedAt: Date.now()
    })
    deleted++
  }
  const cap = typeof s.settings.deleted_jobs_cap === 'number' && s.settings.deleted_jobs_cap > 0
    ? s.settings.deleted_jobs_cap
    : 50000
  if (s.deleted_jobs.length > cap) s.deleted_jobs.splice(0, s.deleted_jobs.length - cap)
  // Cascade: drop documents, applications, follow-ups, interviews for
  // the deleted jobs in one pass each.
  const appIds = s.applications.filter((a) => idSet.has(a.job_id)).map((a) => a.id)
  s.jobs = s.jobs.filter((j) => !idSet.has(j.id))
  s.documents = s.documents.filter((d) => d.job_id == null || !idSet.has(d.job_id))
  s.applications = s.applications.filter((a) => !idSet.has(a.job_id))
  s.follow_ups = s.follow_ups.filter((f) => !appIds.includes(f.application_id))
  s.interviews = s.interviews.filter((i) => !appIds.includes(i.application_id))
  persistStore()
  // Verify: which of the requested IDs are still in s.jobs after the
  // filter? If any are still present, the filter didn't catch them
  // (Set membership bug, ID type mismatch, etc.).
  const stillPresent = [...idSet].filter((id) => s.jobs.find((j) => j.id === id))
  return { requested: ids.length, deleted, missingFromStore: idsMissing, stillPresentAfterFilter: stillPresent }
}

// Removes duplicate jobs from the store using the same key the
// renderer's `dedupeJobs` uses: URL first (protocol + host + pathname),
// then company+title+location. The lowest id wins (it was created
// first); all later duplicates are deleted, with documents/applications/
// follow-ups/interviews cascaded. Returns the deleted ids so the
// renderer can update its local list state.
export function dedupeJobs(): { removedIds: number[]; remaining: number } {
  const s = loadStore()
  const beforeCount = s.jobs.length
  const kept = uniqueJobsByDedupeKey(s.jobs)
  const keptIds = new Set(kept.map((j) => j.id))
  const idsToDelete = s.jobs.filter((j) => !keptIds.has(j.id)).map((j) => j.id)
  if (idsToDelete.length === 0) {
    return { removedIds: [], remaining: beforeCount }
  }
  const idSet = new Set(idsToDelete)
  // Cascade: drop documents, applications, follow-ups, interviews for
  // the deleted jobs in one pass each. Skip the deleted-jobs blacklist —
  // these are noise, not user-initiated removals, so they shouldn't
  // suppress re-imports the user might want.
  const appIds = s.applications.filter((a) => idSet.has(a.job_id)).map((a) => a.id)
  s.jobs = s.jobs.filter((j) => !idSet.has(j.id))
  s.documents = s.documents.filter((d) => d.job_id == null || !idSet.has(d.job_id))
  s.applications = s.applications.filter((a) => !idSet.has(a.job_id))
  s.follow_ups = s.follow_ups.filter((f) => !appIds.includes(f.application_id))
  s.interviews = s.interviews.filter((i) => !appIds.includes(i.application_id))
  persistStore()
  return { removedIds: idsToDelete, remaining: s.jobs.length }
}

// Apply queue (Task 4 — real implementations).
//
// getReadyQueue returns jobs in the `ready` status sorted by
// match_grade asc (nulls last), score desc, tailor_generated_at desc.
// This mirrors what the renderer wants on the Apply Queue page: best
// matches first, with the most recently tailored on top within each
// grade. We use listJobs() (which already supports a status filter)
// rather than reaching into the store directly so the sort helper
// stays single-sourced.
export function getReadyQueue(): Job[] {
  return listJobs('ready').slice().sort((a, b) => {
    // match_grade asc with nulls last: 'A' < 'B' < 'C' < null
    const ag = a.match_grade ?? '\uFFFF'
    const bg = b.match_grade ?? '\uFFFF'
    if (ag !== bg) return ag.localeCompare(bg)
    // score desc (nulls last)
    const as = a.score ?? -Infinity
    const bs = b.score ?? -Infinity
    if (as !== bs) return bs - as
    // tailor_generated_at desc (nulls last)
    const at = a.tailor_generated_at ?? -Infinity
    const bt = b.tailor_generated_at ?? -Infinity
    return bt - at
  })
}

export function markSubmitted(jobId: number, submittedAt?: number): void {
  const ts = submittedAt ?? Date.now()
  const s = loadStore()
  const idx = s.jobs.findIndex((j) => j.id === jobId)
  if (idx === -1) return
  const existing = s.jobs[idx]
  s.jobs[idx] = {
    ...existing,
    status: 'applied',
    submitted_at: ts,
    updated_at: now()
  }
  persistStore()
}

export function markResponse(jobId: number, responseAt?: number): void {
  const ts = responseAt ?? Date.now()
  const s = loadStore()
  const idx = s.jobs.findIndex((j) => j.id === jobId)
  if (idx === -1) return
  const existing = s.jobs[idx]
  s.jobs[idx] = { ...existing, response_at: ts, updated_at: now() }
  persistStore()
}

// Tailor queue helpers (Task 3). Used by electron/tailorJobDocs.ts to land
// both the CV and cover letter plus the per-job timing fields in a single
// store read+write. The store is an in-memory JSON file mutated under
// Node's single-threaded loop, so "atomic" here means: load once, mutate
// in place, persist once. The existing `deleteJobs` (above) is the
// canonical reference for this pattern.
export function writeDocuments(input: {
  jobId: number
  cvContent: string | null
  clContent: string | null
}): { cvId: number; clId: number } {
  const s = loadStore()
  let cvId = 0
  let clId = 0
  if (input.cvContent != null) {
    const doc: Document = {
      id: s.nextId++,
      job_id: input.jobId,
      type: 'cv',
      title: `Tailored CV — job ${input.jobId}`,
      content: input.cvContent,
      is_base: 0,
      model_used: null,
      created_at: now(),
      updated_at: now()
    }
    s.documents.push(doc)
    cvId = doc.id
  }
  if (input.clContent != null) {
    const doc: Document = {
      id: s.nextId++,
      job_id: input.jobId,
      type: 'cover_letter',
      title: `Tailored cover letter — job ${input.jobId}`,
      content: input.clContent,
      is_base: 0,
      model_used: null,
      created_at: now(),
      updated_at: now()
    }
    s.documents.push(doc)
    clId = doc.id
  }
  if (cvId !== 0 || clId !== 0) persistStore()
  return { cvId, clId }
}

export function writeTailorTimingFields(input: {
  jobId: number
  ms_cv: number
  ms_cl: number
  generatedAt: number | null
  lastError: string | null
}): void {
  const s = loadStore()
  const idx = s.jobs.findIndex((j) => j.id === input.jobId)
  if (idx === -1) return
  const existing = s.jobs[idx]
  // tailor_error_toasted stores the most recent error text that was
  // surfaced to the user via a toast, mirroring fit_error_toasted
  // (see the doc-comment on Job.fit_error_toasted in electron/types.ts).
  // On success: clear to null. On a new error text: set to input.lastError
  // so the renderer can detect a new error and fire a toast. On the
  // same error text as the last toast: leave the field as-is so the
  // toast does not re-fire.
  const newToasted = input.lastError
    ? (existing.tailor_error_toasted === input.lastError
        ? existing.tailor_error_toasted
        : input.lastError)
    : null
  s.jobs[idx] = {
    ...existing,
    tailor_ms_cv: input.ms_cv,
    tailor_ms_cl: input.ms_cl,
    tailor_generated_at: input.generatedAt,
    tailor_last_error: input.lastError,
    tailor_error_toasted: newToasted,
    updated_at: now()
  }
  persistStore()
}

export function setJobStatus(jobId: number, status: JobStatus): void {
  const s = loadStore()
  const idx = s.jobs.findIndex((j) => j.id === jobId)
  if (idx === -1) return
  s.jobs[idx] = { ...s.jobs[idx], status, updated_at: now() }
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
//   - Otherwise, if the job has BOTH a CV and a cover letter (regardless
//     of verification), status = 'reviewing'. Generating only one of the
//     two keeps the job in 'sourced'.
//   - With no docs (or only one type), status = 'sourced'.
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
  if (docs.length === 0 || !cv || !cl) {
    // No docs yet, or only one of CV/cover letter exists. Stay in
    // Sourced — Reviewing should only kick in once BOTH documents
    // have been generated, even before verification passes.
    next = 'sourced'
  } else if (
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
  return `model-${  Date.now()  }-${  Math.random().toString(36).slice(2, 6)}`
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
  // Count jobs the same way the Job Board does: dedupe by URL or by
  // company+title+location. Otherwise the dashboard's "Jobs tracked"
  // will diverge from the row count the user sees on the Job Board
  // (which strips pre-DB-dedup duplicates at the render boundary).
  const uniqueJobs = uniqueJobsByDedupeKey(s.jobs)
  return {
    total_jobs: uniqueJobs.length,
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
  return loadStore().settings.locations_normalized_v2 === '1'
}

export function markLocationsNormalized(): void {
  const s = loadStore()
  s.settings.locations_normalized_v2 = '1'
  persistStore()
}

// v3 gate: introduced 2026-07-20 after the country-last contract was
// tightened in formatSingleLocation. The v2 retrofit ran the previous
// (more permissive) writer; rows that survived it may still be in a
// pre-contract shape (e.g. full country name in the last segment) that
// the new decider cannot read. Re-running the retrofit against the
// current writer canonicalizes those rows. Idempotent — gated on a
// distinct flag so it runs once per store.
export function hasLocationsNormalizedV3(): boolean {
  return loadStore().settings.locations_normalized_v3 === '1'
}

export function markLocationsNormalizedV3(): void {
  const s = loadStore()
  s.settings.locations_normalized_v3 = '1'
  persistStore()
}

// v4 gate: introduced 2026-07-23. The writer's 1-part branch was
// hardened to NOT append the defaultCountry when the input is
// already a known full country name (so "Canada" + user_country
// "CA" no longer round-trips to "Canada, CA"). The v4 retrofit
// collapses pre-existing rows that have the redundant trailing
// 2-letter code back to the bare country name. Idempotent — gated
// on a distinct flag so it runs once per store.
export function hasLocationsNormalizedV4(): boolean {
  return loadStore().settings.locations_normalized_v4 === '1'
}

export function markLocationsNormalizedV4(): void {
  const s = loadStore()
  s.settings.locations_normalized_v4 = '1'
  persistStore()
}

export function hasSalaryNormalized(): boolean {
  return loadStore().settings.salary_normalized === '1'
}

export function markSalaryNormalized(): void {
  const s = loadStore()
  s.settings.salary_normalized = '1'
  persistStore()
}

export function hasEmploymentTypeNormalized(): boolean {
  return loadStore().settings.employment_type_normalized === '1'
}

export function markEmploymentTypeNormalized(): void {
  const s = loadStore()
  s.settings.employment_type_normalized = '1'
  persistStore()
}

// ---------------------------------------------------------------------------
// Title & company casing migration
// ---------------------------------------------------------------------------
// normalizeTitle / normalizeCompany were extended to preserve trailing
// Roman numerals ("Recreation Assistant II") and a curated set of
// all-caps acronyms ("IT Director", "Senior AI"). Existing rows
// captured the old (degraded) casing because they were normalized
// before the new rules shipped. This migration re-runs the normalizer
// over every stored title and company once, so the persisted form
// matches the new contract. Gated by a flag so it runs at most once
// per install; idempotent — re-running finds no diffs and does
// nothing.

export function hasTitleCasingNormalized(): boolean {
  return loadStore().settings.title_casing_normalized === '1'
}

export function markTitleCasingNormalized(): void {
  const s = loadStore()
  s.settings.title_casing_normalized = '1'
  persistStore()
}

// v2: extends the Roman-numeral rule to fire on any token whose upper
// form is in ROMAN_NUMERALS (not just the last), and adds CSE to the
// curated acronym set. The v1 retrofit ran with the old narrow Roman
// rule, so existing rows with mid-title "Ii" or "Cse" still need
// re-normalization. Re-runs the normalizer over every stored title
// and company once. Idempotent.
export function hasTitleCasingNormalizedV2(): boolean {
  return loadStore().settings.title_casing_normalized_v2 === '1'
}

export function retrofitTitleCasingV2(): { updated: number; total: number } {
  const s = loadStore()
  let updated = 0
  for (const j of s.jobs) {
    const newTitle = normalizeTitle(j.title)
    const newCompany = normalizeCompany(j.company)
    let changed = false
    if (newTitle !== null && newTitle !== j.title) {
      j.title = newTitle
      changed = true
    }
    if (newCompany !== null && newCompany !== j.company) {
      j.company = newCompany
      changed = true
    }
    if (changed) {
      j.updated_at = now()
      updated++
    }
  }
  s.settings.title_casing_normalized_v2 = '1'
  persistStore()
  return { updated, total: s.jobs.length }
}

export function retrofitTitleCasing(): { updated: number; total: number } {
  const s = loadStore()
  let updated = 0
  for (const j of s.jobs) {
    const newTitle = normalizeTitle(j.title)
    const newCompany = normalizeCompany(j.company)
    let changed = false
    if (newTitle !== null && newTitle !== j.title) {
      j.title = newTitle
      changed = true
    }
    if (newCompany !== null && newCompany !== j.company) {
      j.company = newCompany
      changed = true
    }
    if (changed) {
      j.updated_at = now()
      updated++
    }
  }
  // Set the flag whether or not anything changed, so we don't re-scan
  // every launch. Mirrors the retrofitLocations pattern.
  s.settings.title_casing_normalized = '1'
  persistStore()
  return { updated, total: s.jobs.length }
}

export function hasWorkModeNormalized(): boolean {
  return loadStore().settings.work_mode_normalized === '1'
}

export function markWorkModeNormalized(): void {
  const s = loadStore()
  s.settings.work_mode_normalized = '1'
  persistStore()
}

/**
 * One-shot retrofit: re-run normalizeWorkMode on every existing job's
 * work_mode so pre-existing rows that landed in mixed free-form
 * strings ("Remote", "On-site", "Work from home", "Hybrid (2 days
 * in office)", etc.) collapse to the 3 canonical tokens. Unmappable
 * values are nulled so the user can pick the right token in Edit.
 * Gated by `work_mode_normalized` so it only runs once per store,
 * mirroring the `employment_type_normalized` and `salary_normalized`
 * patterns.
 */
export function retrofitWorkModeNormalization(): { updated: number; nulled: number; total: number } {
  const s = loadStore()
  let updated = 0
  let nulled = 0
  for (const j of s.jobs) {
    if (j.work_mode == null) continue
    const normalized = normalizeWorkMode(j.work_mode)
    if (normalized === j.work_mode) continue
    if (normalized == null) {
      j.work_mode = null
      nulled++
    } else {
      j.work_mode = normalized
      updated++
    }
    j.updated_at = now()
  }
  if (updated > 0 || nulled > 0) persistStore()
  return { updated, nulled, total: s.jobs.length }
}

/**
 * One-shot retrofit: re-run normalizeEmploymentType on every existing
 * job's employment_type so pre-existing rows that landed in mixed
 * free-form strings ("Full-time", "Part-Time Job", "Contract Position",
 * "Permanent, Full Time", etc.) collapse to the 8 canonical tokens that
 * the Edit dropdown is constrained to. New jobs added after this point
 * are normalized at the persistence boundary (createJob / updateJob) so
 * the retrofit only touches pre-existing rows.
 *
 * Unmappable values (e.g. "Casual", "On-Call", "Apprenticeship") are
 * nulled so the user can pick the right token in Edit. Idempotent:
 * re-running on already-canonical rows is a no-op. Gated by
 * `employment_type_normalized` so it only runs once per store, mirroring
 * the `locations_normalized_v2` and `salary_normalized` patterns.
 */
export function retrofitEmploymentTypeNormalization(): { updated: number; nulled: number; total: number } {
  const s = loadStore()
  let updated = 0
  let nulled = 0
  for (const j of s.jobs) {
    if (j.employment_type == null) continue
    const normalized = normalizeEmploymentType(j.employment_type)
    if (normalized === j.employment_type) continue
    if (normalized == null) {
      // No token match — null it so the user picks the right one in Edit
      // instead of the UI showing a free-form string the dropdown doesn't cover.
      j.employment_type = null
      nulled++
    } else {
      j.employment_type = normalized
      updated++
    }
    j.updated_at = now()
  }
  if (updated > 0 || nulled > 0) persistStore()
  return { updated, nulled, total: s.jobs.length }
}

/**
 * One-shot retrofit: re-run normalizeSalary on every existing job's
 * salary_range so pre-existing rows that landed in mixed formats
 * ("$43/hour", "CAD Monthly", "100k/year", etc.) get the same
 * annualization as new rows going forward. Idempotent: re-running on
 * already-normalized rows is a no-op (normalizeSalary is stable).
 * Gated by `salary_normalized` setting so it only runs once per
 * store, mirroring the `locations_normalized_v2` pattern.
 */
export function retrofitSalaryNormalization(): { updated: number; total: number } {
  const s = loadStore()
  let updated = 0
  for (const j of s.jobs) {
    if (!j.salary_range) continue
    const normalized = normalizeSalary(j.salary_range, j.description)
    if (normalized && normalized !== j.salary_range) {
      j.salary_range = normalized
      j.updated_at = now()
      updated++
    }
  }
  if (updated > 0) persistStore()
  return { updated, total: s.jobs.length }
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
  // Set the v3 flag whether or not anything changed, so we don't re-scan
  // every launch. (The v2 gate covers an earlier, looser writer; v3
  // covers the country-last contract.)
  s.settings.locations_normalized_v3 = '1'
  persistStore()
  return { updated, total: s.jobs.length }
}

/**
 * v4 retrofit (2026-07-23): the writer's 1-part branch was hardened
 * to NOT append the defaultCountry when the input is already a known
 * full country name. Rows persisted before this fix (when the writer
 * would write "Canada, CA" for a 1-part "Canada" input with
 * user_country=CA) survive in the store as the redundant shape. The
 * renderer's condenseLocation would collapse them back to "Canada"
 * for display, but the underlying stored value still has the trailing
 * 2-letter code that downstream consumers (multi-location scan,
 * location filter) interpret as a country — so the redundancy bleeds
 * into those paths too. Strip the trailing code when the leading
 * part is a known country name. Idempotent — gated on a distinct
 * v4 flag so it runs once per store.
 */
export function retrofitLocationsV4(): { updated: number; total: number } {
  const s = loadStore()
  let updated = 0
  for (const j of s.jobs) {
    const collapsed = stripRedundantCountrySuffix(j.location)
    if (collapsed !== j.location) {
      j.location = collapsed
      j.updated_at = now()
      updated++
    }
  }
  s.settings.locations_normalized_v4 = '1'
  persistStore()
  return { updated, total: s.jobs.length }
}

/**
 * Collapse "Canada, CA" / "United States, US" / "Germany, DE" to the
 * bare country name when the trailing 2-letter code matches what the
 * writer's `canonicalizeCountry` would resolve the leading name to.
 * Mirrors the writer's 2-letter shortcut: a 2-letter token is treated
 * as the country code directly; a longer name is matched against the
 * writer's COUNTRIES map (case-insensitive). Anything that doesn't
 * fit the "<Name>, <CC>" pattern (3-part "City, REGION, CC", bare
 * "Canada" without a suffix, unresolvable trailing codes) is
 * returned as-is.
 */
function stripRedundantCountrySuffix(location: string | null | undefined): string | null {
  if (!location) return location
  const parts = location.split(',').map((p) => p.trim())
  if (parts.length !== 2) return location
  const [name, suffix] = parts
  if (suffix.length !== 2) return location
  // 2-letter name → treat as the country code itself. Otherwise,
  // lower-case and check against the writer's country map. (This
  // is the same shortcut canonicalizeCountry in utils.ts uses; we
  // re-implement the lookup inline so database.ts doesn't need to
  // import a non-exported helper.)
  const nameAsCC = name.length === 2 ? name.toUpperCase() : null
  if (nameAsCC && nameAsCC === suffix.toUpperCase()) return name
  return location
}

/**
 * One-shot: copy the legacy job_search_location string into
 * job_search_locations (a JSON-encoded LocationPick[]) and clear the
 * old field. Introduced 2026-07-20 when the scan location filter moved
 * from a single string to a structured array (see jobSearch.ts and
 * the multi-location scan spec). Gated by the v1 flag so it runs at
 * most once per store. Idempotent: re-running with the flag set is a
 * no-op. Treats corrupt job_search_locations as `[]` so a future
 * installer that ships with a broken value self-heals.
 */
export function migrateJobSearchLocationsV1(): { updated: boolean; reason: string } {
  const s = loadStore()
  if (s.settings.locations_array_migrated_v1 === '1') {
    return { updated: false, reason: 'already-migrated' }
  }
  const oldStr = (s.settings.job_search_location || '').trim()
  // Parse whatever's in job_search_locations; on any failure treat it
  // as empty so a future installer with a broken value self-heals.
  let existing: unknown[] = []
  if (s.settings.job_search_locations) {
    try {
      const parsed = JSON.parse(s.settings.job_search_locations)
      if (Array.isArray(parsed)) existing = parsed
    } catch {
      // fall through with existing = []
    }
  }
  // Per the spec: only copy the legacy string when the new field is
  // empty or invalid. If the user already has a valid array, leave it
  // alone — the legacy string is leftover state we just clear.
  const copyLegacy = oldStr !== '' && existing.length === 0
  const nextArray = copyLegacy
    ? JSON.stringify([{ display: oldStr }])
    : JSON.stringify(existing)
  s.settings.job_search_location = ''
  s.settings.job_search_locations = nextArray
  s.settings.locations_array_migrated_v1 = '1'
  persistStore()
  return {
    updated: true,
    reason: copyLegacy ? 'copied' : (oldStr ? 'cleared-legacy-only' : 'cleared'),
  }
}

/**
 * One-shot: recompute every job's status from its current documents
 * using the same doc-derived rule as the live IPC handlers. Idempotent
 * and gated by a flag so it runs at most once per install. Use this
 * after changing the status rule to backfill existing data.
 */
export function recomputeAllJobStatuses(): { updated: number; total: number } {
  const s = loadStore()
  let updated = 0
  for (const j of s.jobs) {
    const prev = j.status
    const next = recomputeJobStatusFromDocs(j.id)
    if (next && next !== prev) updated++
  }
  s.settings.statuses_recomputed = '1'
  persistStore()
  return { updated, total: s.jobs.length }
}

export function hasStatusesRecomputed(): boolean {
  return loadStore().settings.statuses_recomputed === '1'
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

/**
 * Discard the in-memory store and re-read the data file from disk.
 * Used after a backup restore so the renderer sees the restored
 * data without requiring a full process restart (which is fragile
 * in dev mode where app.relaunch can fail silently).
 */
export function reloadStore(): void {
  store = null
  loadStore()
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

/**
 * One-shot gated migration: re-scrape LinkedIn rows whose description
 * still holds the paywall stub ("Posted … See this and similar jobs
 * on LinkedIn.") because they were imported before the importer
 * learned to refuse the stub (ba2de25 / a8509b3). For each match the
 * fetcher is called on the row's URL and, if it returns a real
 * description, updateJob writes it.
 *
 * User-initiated from Settings → Scan Memory ("Rescan LinkedIn
 * descriptions"). We don't auto-run on launch because every match
 * triggers a network call and we'd rather the user explicitly accept
 * the rate-limit / latency cost. Gated by the linkedin_stub_rescraped
 * setting so a second click is a no-op.
 *
 * The fetcher is injected so the test in jobScraper.test can supply
 * a stub. In production main.ts wires scrapeJobFromUrl in. Failures
 * (network error, scrape still returns a stub, etc.) are caught per
 * row so one bad URL doesn't abort the batch.
 */
export function relinkLinkedInStubDescriptions(
  fetcher: (url: string) => Promise<{ description?: string }>
): Promise<{ scanned: number; updated: number; skipped: number; errors: number; alreadyMigrated: boolean }> {
  const s = loadStore()
  if (s.settings.linkedin_stub_rescraped === '1') {
    return Promise.resolve({ scanned: 0, updated: 0, skipped: 0, errors: 0, alreadyMigrated: true })
  }
  // Collect candidate ids first so we can persist the gate at the
  // start — even if every fetch fails, we don't want the user
  // clicking "Rescan" three times in a row and re-firing the entire
  // batch. A failed re-scrape is recoverable: the user can clear the
  // flag and try again.
  const candidates = s.jobs.filter(
    (j) => j.url && j.url.includes('linkedin.com') && j.description && isLinkedInStubDescription(j.description)
  )
  s.settings.linkedin_stub_rescraped = '1'
  persistStore()
  return runRelink(candidates, fetcher)
}

async function runRelink(
  candidates: Job[],
  fetcher: (url: string) => Promise<{ description?: string }>
): Promise<{ scanned: number; updated: number; skipped: number; errors: number; alreadyMigrated: boolean }> {
  let updated = 0
  let skipped = 0
  let errors = 0
  for (const j of candidates) {
    if (!j.url) continue
    try {
      const fresh = await fetcher(j.url)
      const newDesc = fresh.description
      if (newDesc && !isLinkedInStubDescription(newDesc)) {
        updateJob(j.id, { description: newDesc })
        updated++
      } else {
        skipped++
      }
    } catch {
      errors++
    }
  }
  return { scanned: candidates.length, updated, skipped, errors, alreadyMigrated: false }
}
