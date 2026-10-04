import { app, safeStorage } from 'electron'
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'fs'
import { join } from 'path'
import { cleanDescription, isLinkedInStubDescription, scrapePostingDateFromUrl } from './jobScraper'
import { getOrCreateDek, encryptJson, decryptJson, deleteDek, encryptionMode } from './secureStore'
import { formatLocation, canonicalizeCountry, countryNameFromCode, decodeEntities, normalizeTitle, normalizeCompany, normalizeSalary, dedupKey } from './utils'
import { normalizeEmploymentType, normalizeWorkMode } from './employmentType'
import { matchGradeFor } from './matchGrade'
import { nextStatusFromDocs } from './docStatus'
import { notificationGroupKey } from './notificationGroup'
import { DEFAULT_DISABLED_BOARDS, DEFAULT_DISABLED_BOARDS_V1, DEFAULT_DISABLED_BOARDS_V2_ADDITIONS, unionDisabledBoards } from './boards'
import { providerKey, providerKeyMoved } from './providerKey'
import { isCooldownBlockedMessage } from './cooldownBlock'
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
  NotificationRow,
  ProviderCall,
  Settings
} from './types'

const ENCRYPTED_PREFIX = '$enc$'

// -------------------------------------------------------------------------
// The per-provider spend cap.
//
// The number lives here, next to the store field and the normaliser that
// enforces it, so the default, the floor and the ceiling cannot drift apart.
//
// 50 IS the documented free-tier allowance, which is the whole argument.
// OpenRouter's limits page states that a `:free` model request is limited to
// 20/minute and 50/day while fewer than 10 credits have ever been purchased
// on the account (1000/day at 10+), and — the part that decides the design
// here — that those limits "apply to your OpenRouter account as a whole ...
// they are not per model, and pinning a specific `:free` model does not
// raise them".
//
// So the provider's own counter is per account and per calendar day, and this
// cap is per account too (see `providerKey` in ai.ts: endpoint + credential,
// never the model name). Same unit, so the app stops ITSELF at the wall the
// provider would otherwise enforce with a 429 — and a 429 on a shared
// free-tier key is how the pool dies for every model on it at once, which is
// the failure this whole thing is for. It is set at the allowance rather
// than under it so a normal day's work is not silently truncated, and it is a
// setting because the number above the free tier is the user's own call:
// buy 10 credits and raise it to 1000.
//
// https://openrouter.ai/docs/api_reference/limits
// -------------------------------------------------------------------------
export const DEFAULT_PROVIDER_CALL_CAP = 50
export const MIN_PROVIDER_CALL_CAP = 1
export const MAX_PROVIDER_CALL_CAP = 5000

/**
 * The rolling window the cap is measured over.
 *
 * Deliberately NOT a calendar day: a calendar boundary is something to wait
 * for, so it can be gamed by idling until midnight and it does not match
 * how free-tier quotas actually reset. A sliding window cannot be gamed
 * that way and needs no "which day is it" special case — the cap is simply
 * "calls in the last 24 hours".
 */
export const PROVIDER_SPEND_WINDOW_MS = 24 * 60 * 60 * 1000

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
  settings: Settings & Record<string, unknown>
  api_models: ApiModelConfig[]
  nextId: number
  seen_urls: string[]
  ai_queue: AIQueueItem[]
  board_health: Record<string, number[]>
  board_scan_times: Record<string, number[]>
  /**
   * Real outbound requests per provider key, as a rolling window of
   * timestamps. Keyed by `providerKey()` (ai.ts) — one credential, not one
   * model — because the thing that costs money and gets cut off is the
   * credential, and twenty models share one free-tier key. Pruned to the
   * window on every write, so it cannot grow without bound. See
   * `recordProviderCall` below.
   */
  provider_spend: Record<string, ProviderCall[]>
  deleted_jobs: DeletedJobRecord[]
  blacklisted_companies?: string[]
  notifications: NotificationRow[]
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
      // Minimum 0-1 match score a listing must reach for a scan to add
      // it (see resolveScanMinMatch in jobSearch.ts). Default is the
      // value the hardcoded HEURISTIC_FLOOR used before the setting
      // existed, so upgrading changes nothing until the user moves it.
      scan_min_match: 0.25,
      // Hourly. This is the value a NEW store gets, and the one the
      // normaliser below rewrites a missing/invalid value to — so both
      // have to say 60, or the fallback in fitAutoScore.ts is dead code
      // and every user silently keeps the old 4h cadence.
      fit_autoscore_interval_minutes: 60,
      locations_normalized: '',
      locations_normalized_v2: '',
      locations_normalized_v3: '',
      locations_normalized_v4: '',
      locations_normalized_v5: '',
      locations_normalized_v6: '',
      locations_array_migrated_v1: '',
      disabled_boards_migrated_v1: '',
      employment_type_normalized: '',
      work_mode_normalized: '',
      title_casing_normalized: '',
      title_casing_normalized_v2: '',
      statuses_recomputed: '',
      statuses_manual_v2: '',
      queue_dedup_v1: '',
      // Second run of the same repair, for the duplicate class the v1
      // guard could not see: `enqueue` did not match `failed` rows, so
      // a store already collapsed under v1 went on collecting a second
      // row for work it had a row for. See dedupeAIQueueItems.
      queue_dedup_v2: '',
      // One-shot gate for the cooldown-poisoning repair. See
      // unpoisonCooldownFailedAIQueueItems.
      queue_cooldown_reset_v1: '',
      // 0 = the user has never pressed "Clear queue". Any other value is
      // the epoch ms of the last clear, paired with the job-id watermark
      // that says which jobs it covered; both are the durable tombstone
      // the fit-score re-seeders consult.
      queue_cleared_at: 0,
      queue_cleared_max_job_id: 0,
      backup_path: '',      backup_last_success_at: '',
      backup_last_error: '',
      passphrase: '',
      // P1.7 (BRIEF5 §4): fit threshold for auto document generation.
      auto_doc_min_fit: 40,
      // Auto-queue switches (Settings > Auto-queue). All true: this is
      // the behaviour that shipped before the keys existed, so an
      // upgrade changes nothing until the user turns one off. They gate
      // AUTOMATIC enqueues only — a manual generate/verify/tailor still
      // queues.
      auto_queue_fit: true,
      auto_queue_cv: true,
      auto_queue_cover_letter: true,
      auto_queue_verify_cv: true,
      auto_queue_verify_cover_letter: true,
      quick_apply_shortcut: null,
      // Automated provider calls per credential per rolling 24h. Manual
      // actions bypass it (and still count) — see the setting's doc comment
      // in types.ts and `recordProviderCall` below.
      provider_call_cap: DEFAULT_PROVIDER_CALL_CAP
    },
    api_models: [],
    nextId: 1,
    seen_urls: [],
    ai_queue: [],
    board_health: {},
    board_scan_times: {},
    provider_spend: {},
    deleted_jobs: [],
    blacklisted_companies: [],
    notifications: []
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

export function loadStore(): Store {
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
    if (!store.board_scan_times) {
      store.board_scan_times = {}
    }
    if (!store.provider_spend) {
      store.provider_spend = {}
    }
    if (!store.deleted_jobs) {
      store.deleted_jobs = []
    }
    if (!store.blacklisted_companies) {
      store.blacklisted_companies = []
    }
    if (!Array.isArray(store.notifications)) {
      // `Array.isArray`, not the truthiness check the guarded defaults
      // above use: these fields are arrays in practice, but this one
      // arrives from a file a user's build wrote, and `for..of` over a
      // non-array below would throw out of `loadStore` — which is the
      // accessor for the WHOLE store, so the damage would be every job,
      // document and setting rather than the notification list.
      store.notifications = []
    }
    // Rows written before the notification center learned to group, and
    // before the record layer learned to fold a repeat into the row it
    // already had. They carry neither `group_key` nor `occurrences`, and
    // both are required on NotificationRow (see electron/types.ts), so
    // without this a pre-existing store would hand the drawer rows it
    // cannot collapse — every old notification reading as its own group of
    // one — and a count it has nothing to add up. Backfilled here rather
    // than defaulted at render time for the reason the fields are required:
    // the derivation must exist in exactly one place, and the renderer
    // reads both stored values verbatim.
    //
    // The per-row guard rather than a wholesale reset is the same shape as
    // the guarded defaults above it: an upgrade adds the missing field and
    // leaves every other field on the row exactly as the user left it.
    //
    // The element guard is load-bearing for the same reason the array
    // guard is. This is the only place in the store that reads a stored
    // row's SHAPE rather than sanitising it on the way in, and it runs
    // inside `loadStore` — the accessor for the whole Store. A `null` or a
    // number in that array would throw here and take jobs, documents and
    // settings down with it, for a notification list the user may not even
    // have opened.
    store.notifications = store.notifications.filter(
      (row): row is NotificationRow => !!row && typeof row === 'object'
    )
    for (const row of store.notifications) {
      if (typeof row.group_key !== 'string' || row.group_key === '') {
        row.group_key = notificationGroupKey(row.type, row.source, row.message)
      }
      // Same story, same loop: `occurrences` is required on NotificationRow
      // and was not on disk before the record layer learned to fold a
      // repeat into the row it already had. A pre-existing store has no
      // repeats in it — every row there is its own occurrence — so 1 is
      // the truthful value, not a default that hides a count. Anything
      // that is not a finite number >= 1 is treated as 1 rather than
      // trusted: `occurrences` feeds the badge the user reads, and a
      // NaN or a 0 there is worse than an honest one.
      if (!Number.isFinite(row.occurrences) || row.occurrences < 1) {
        row.occurrences = 1
      }
    }
    if (typeof store.settings.auto_scan_enabled !== 'boolean') {
      store.settings.auto_scan_enabled = true
    }
    if (typeof store.settings.auto_scan_interval_minutes !== 'number' || store.settings.auto_scan_interval_minutes <= 0) {
      store.settings.auto_scan_interval_minutes = 120
    }
    if (typeof store.settings.scan_min_match !== 'number' || !Number.isFinite(store.settings.scan_min_match)) {
      // Backfill for stores written before scan_min_match existed. The
      // old hardcoded floor was 0.25, so that is the value an upgrade
      // gets. Values outside [0, 1] are clamped rather than reset: 0 is
      // a legitimate "add everything" setting, and anything above 1
      // would silently reject every listing.
      store.settings.scan_min_match = 0.25
    } else if (store.settings.scan_min_match < 0 || store.settings.scan_min_match > 1) {
      store.settings.scan_min_match = Math.min(1, Math.max(0, store.settings.scan_min_match))
    }
    if (typeof store.settings.fit_autoscore_interval_minutes !== 'number' || store.settings.fit_autoscore_interval_minutes <= 0) {
      store.settings.fit_autoscore_interval_minutes = 60
    }
    // P1.7 (BRIEF5 §4): backfill the auto-doc generation threshold.
    // The 0-1 → 0-100 normalization is here for a store that predates the
    // 0-100 scale, so a hand-edited fractional value still works.
    if (typeof store.settings.auto_doc_min_fit !== 'number') {
      store.settings.auto_doc_min_fit = 40
    } else if (store.settings.auto_doc_min_fit > 0 && store.settings.auto_doc_min_fit <= 1) {
      store.settings.auto_doc_min_fit = Math.round(store.settings.auto_doc_min_fit * 100)
    }
    // Backfill the auto-queue switches: anything that is not already a
    // boolean becomes `true`.
    //
    // The direction matters more here than it does for the scan
    // settings above. These keys gate automatic work, so "unreadable"
    // has to mean ON: a store written before they existed, or one
    // hand-edited to a string, must not come back up with a feature
    // silently disabled. Only an explicit `false` turns one off.
    for (const key of [
      'auto_queue_fit',
      'auto_queue_cv',
      'auto_queue_cover_letter',
      'auto_queue_verify_cv',
      'auto_queue_verify_cover_letter'
    ] as const) {
      if (typeof store.settings[key] !== 'boolean') {
        store.settings[key] = true
      }
    }
    if (typeof store.settings.quick_apply_shortcut !== 'string' && store.settings.quick_apply_shortcut !== null) {
      store.settings.quick_apply_shortcut = null
    }
    // The per-provider automated-call cap. A store written before the key
    // existed — or one hand-edited to something unusable — resolves to the
    // documented free-tier allowance rather than to "no cap", because
    // "unreadable" must never mean "unbounded" for the one setting whose
    // whole job is to bound spend. Finite values are clamped rather than
    // discarded: 0 or a negative number would silence every automated
    // request forever, and a huge one is the user's own choice to make.
    if (typeof store.settings.provider_call_cap !== 'number' || !Number.isFinite(store.settings.provider_call_cap)) {
      store.settings.provider_call_cap = DEFAULT_PROVIDER_CALL_CAP
    } else {
      store.settings.provider_call_cap = Math.min(
        MAX_PROVIDER_CALL_CAP,
        Math.max(MIN_PROVIDER_CALL_CAP, Math.round(store.settings.provider_call_cap))
      )
    }
    // `auto_tailor_on_scan` and `auto_tailor_min_fit` are RETIRED (the Scan
    // tab's "Auto-Queue" section and its scan-time producer are gone) and
    // are deliberately NOT deleted from a store that still carries them.
    // Nothing reads them — an unknown key in `settings` is inert, it is
    // carried through the load and written back untouched — whereas
    // stripping them means rewriting every user's settings file, which
    // touches every other key's persisted value as collateral and buys
    // nothing. Leave them until something else decides otherwise.
    if (!Array.isArray(store.settings.disabled_boards)) {
      // Per-board on/off list, populated by the Settings > Boards tab.
      // Strings are board names matching `BOARDS[].name` in
      // `electron/boards.ts`. New default: the boards that were
      // Cloudflare-walled in every scan ship disabled — their scraper
      // logic stays intact for add-by-URL imports, but they no longer
      // stall scans with per-listing 403s. Users can re-enable any of
      // them in Settings > Boards.
      store.settings.disabled_boards = [...DEFAULT_DISABLED_BOARDS]
    }
    let jobsMigrated = false
    // Build a Set of dedup keys up front so the per-job dedup check is
    // O(1) instead of re-scanning seen_urls for every job (which made
    // startup quadratic as the scan pipeline grew seen_urls).
    const seenKeys = new Set(store.seen_urls.map(u => dedupKey(u)))
    for (const j of store.jobs) {
      if (j.url) {
        const dk = dedupKey(j.url)
        if (!seenKeys.has(dk)) {
          seenKeys.add(dk)
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
      if (j.fit_source === undefined) {
        j.fit_source = null
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
    // A store written before the durable clear existed has no tombstone.
    // Normalising it to 0 ("never cleared") is the correct reading — the
    // user's older clears are long gone — and the accessors treat a
    // missing value the same way, so this is belt and braces.
    if (typeof store.settings.queue_cleared_at !== 'number') {
      store.settings.queue_cleared_at = 0
      jobsMigrated = true
    }
    if (typeof store.settings.queue_cleared_max_job_id !== 'number') {
      store.settings.queue_cleared_max_job_id = 0
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

export function saveStore(): void {
  persistStore()
}

// Serialize concurrent persistStore() calls through a promise queue.
// Node.js is single-threaded so in-memory mutations already cannot
// interleave; this guard ensures the on-disk writes are also ordered,
// preventing last-writer-wins races from concurrent IPC handlers.
let _writeQueue: Promise<void> = Promise.resolve()

function persistStore(): void {
  _writeQueue = _writeQueue.then(() => {
    if (!store) return
    const dek = getOrCreateDek()
    const payload = encryptJson(store, dek)
    const filePath = getStorePath()
    const tmpPath = `${filePath}.tmp`
    // Write to a temp file first, then atomically rename over the
    // real file. On POSIX (macOS), rename(2) is atomic — the live
    // file is never partially overwritten, so a crash mid-write
    // cannot corrupt it.
    writeFileSync(tmpPath, payload, 'utf8')
    renameSync(tmpPath, filePath)
  }).catch((err) => {
    // Log but never throw — a failed persist should not crash the
    // app. The in-memory store is still valid; next mutation will
    // retry the write.
    try { require('./logger').createLogger('database').error('persistStore failed:', err) } catch { /* logger unavailable */ }
  })
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
    manual_status: 0,
    score: input.score !== undefined ? (input.score ?? null) : null,
    fit_rationale: input.fit_rationale ?? null,
    fit_breakdown: input.fit_breakdown ?? null,
    fit_score_version: input.fit_score_version ?? null,
    fit_source: input.fit_source ?? null,
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
    // An explicitly-set status is user-owned. Programmatic flows reach
    // for the same IPC: 'tailoring' is the transient JobDetail working
    // state and the fit scorers never pass status, so only genuinely
    // user-driven transitions (Pipeline drag/select, mark applied,
    // manual review states) get the sticky flag. recompute skips
    // manual_status jobs so documents can never override the choice.
    manual_status:
      fields.status !== undefined && fields.status !== existing.status && fields.status !== 'tailoring'
        ? 1
        : existing.manual_status,
    score: fields.score !== undefined ? (fields.score ?? null) : existing.score,
    match_grade: fields.score !== undefined ? matchGradeFor(fields.score ?? null) : existing.match_grade,
    fit_rationale: fields.fit_rationale !== undefined ? (fields.fit_rationale ?? null) : existing.fit_rationale,
    fit_breakdown: fields.fit_breakdown !== undefined ? (fields.fit_breakdown ?? null) : existing.fit_breakdown,
    fit_score_version: fields.fit_score_version !== undefined ? (fields.fit_score_version ?? null) : existing.fit_score_version,
    fit_source: fields.fit_source !== undefined ? (fields.fit_source ?? null) : existing.fit_source,
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
// the per-job timing fields in a single store read+write. The store is an
// in-memory JSON file mutated under Node's single-threaded loop, so
// "atomic" here means: load once, mutate in place, persist once. The
// existing `deleteJobs` (above) is the canonical reference for this
// pattern.
//
// The DOCUMENTS themselves are not written here. `writeDocuments` used to
// be, and it was the second half of a double write: `tailorDocument`
// already creates each document row (ai.ts, `createDocument`), so calling
// it left one tailoring call producing TWO `cv` rows and TWO
// `cover_letter` rows — one of each orphaned, never reviewed, never
// deleted, and never seen by the review chain. It is gone rather than left
// beside `createDocument`, so the next author cannot reintroduce it;
// `setDocumentContent` is the single supported way to store the sanitized
// version of content whose row `tailorDocument` already created.
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

/**
 * The documents belonging to ONE job, and only those.
 *
 * `listDocuments(jobId)` deliberately unions in the base CV
 * (`is_base = 1`, `job_id` null): the Documents / JobDetail views want
 * the user's master CV shown alongside every job. That is right for
 * DISPLAY and wrong for anything that acts on a job.
 *
 * The AI reviewer is the case that matters. Unioning the base CV in
 * meant every job's generation pass uploaded the user's master
 * document to the LLM provider, wrote it a `verification_score` it was
 * never meant to carry, and pushed it through the auto-regeneration
 * counter — and because a failing review of it enqueues a
 * regeneration for THAT job, one job's documents could be rebuilt
 * from a base CV that job was never derived from. Reviewing the base
 * CV is an explicit user action; it must not be a side effect of
 * generating a document for some other job.
 *
 * Deliberately reuses `listDocuments` so the ordering stays identical
 * to what the UI shows.
 */
export function listJobDocuments(jobId: number): Document[] {
  return listDocuments(jobId).filter((d) => d.job_id === jobId && d.is_base !== 1)
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

/**
 * Replace ONLY the content of a document row that already exists.
 *
 * The counterpart to `createDocument` for the case where the row was
 * already written by the call that produced the content. `tailorDocument`
 * (ai.ts) creates the document row as the last step of a FIRST generation
 * and returns its id, and `tailorJobDocsForJob` then needs to store the
 * SANITIZED version of that same content (paragraph ceilings, rule
 * checks). It used to call `writeDocuments`, which pushed a second row —
 * so one tailoring call left two `cv` rows and two `cover_letter` rows for
 * the job, one of each unreviewed and orphaned, and the review chain only
 * ever saw one of them.
 *
 * Deliberately does NOT clear `verification_score` /
 * `verification_feedback` the way `replaceDocumentContent` does: the row
 * was created moments ago by the same call, so it cannot carry a review
 * that described different content. Returns the updated row, or null when
 * the document no longer exists (deleted by the user while the LLM call
 * was in flight) — the caller must not fall back to inserting.
 */
export function setDocumentContent(id: number, content: string): Document | null {
  const s = loadStore()
  const idx = s.documents.findIndex((d) => d.id === id)
  if (idx === -1) return null
  s.documents[idx] = { ...s.documents[idx], content, updated_at: now() }
  persistStore()
  return s.documents[idx]
}

/**
 * Rebuild a document's content IN PLACE, keeping the same row.
 *
 * The auto review->regenerate loop (P1.7 §2) has to replace the
 * document that failed rather than insert a new one. `createDocument`
 * always mints a fresh id, so a regeneration routed through it would
 * leave the user looking at a brand-new row that (a) has no
 * `auto_regen_attempts` counter, so the loop's budget is reset on
 * every round and AUTO_REGEN_MAX is unreachable, and (b) is a
 * different row from the one the application, the reviewer and the
 * queue item all point at. Inheriting the row is what lets the loop
 * advance round after round and what keeps the surviving document
 * carrying its own review history.
 *
 * The `verification_score` / `verification_feedback` are cleared:
 * they described the content that was just replaced, and leaving them
 * would present an unreviewed document as reviewed — the exact state
 * this function exists to prevent. `createDocument` likewise leaves
 * them empty, so the regenerated row looks like a freshly written one
 * until the queued review lands.
 *
 * `modelUsed` updates the provenance of the content; omitted, the
 * previous value is kept.
 *
 * Returns the updated row, or null when the document no longer exists
 * (deleted by the user while the LLM call was in flight) — the caller
 * must not fall back to inserting, or a deleted document would come
 * back from the dead.
 */
export function replaceDocumentContent(
  id: number,
  title: string,
  content: string,
  modelUsed?: string | null
): Document | null {
  const s = loadStore()
  const idx = s.documents.findIndex((d) => d.id === id)
  if (idx === -1) return null
  s.documents[idx] = {
    ...s.documents[idx],
    title,
    content,
    model_used: modelUsed === undefined ? s.documents[idx].model_used : modelUsed,
    verification_score: null,
    verification_feedback: null,
    updated_at: now()
  }
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

// P1.7 (BRIEF5 §2): auto review→regenerate loop bookkeeping.
// `getDocumentAutoRegenAttempts` reads the current count for a document
// (legacy rows without the field read as 0). `bumpDocumentAutoRegenAttempts`
// increments it and returns the new value, so the caller can compare
// against AUTO_REGEN_MAX to decide whether to keep looping or stop and
// flag the document for manual attention.
//
// The counter lives on the document (not the queue item) because the
// loop spans multiple queue items: generation -> verify -> regeneration
// -> verify -> ... Each verify item is created and destroyed inside one
// pass, so a queue-item-local counter would reset every cycle.
//
// `bumpDocumentAutoRegenAttempts` returns null, NOT 0, for a document
// that no longer exists. The two are different facts and the caller
// acts on the difference: 0 means "this document has regenerated zero
// times, so it has budget left", while null means "there is no
// document to regenerate". A delete can land while the reviewer's LLM
// call is in flight, and a caller reading that as 0 sees a fresh budget
// for a row that has been deleted — restarting a loop that has nothing
// left to rebuild and re-reviewing a document the user removed.
// `getDocumentAutoRegenAttempts` cannot report that distinction (it
// reads one row and has no second place to signal it), which is why the
// bump — the write that would have been made to a missing row — is the
// authority on whether the document is still there.
export function getDocumentAutoRegenAttempts(id: number): number {
  const s = loadStore()
  const doc = s.documents.find((d) => d.id === id)
  return doc?.auto_regen_attempts ?? 0
}

export function bumpDocumentAutoRegenAttempts(id: number): number | null {
  const s = loadStore()
  const idx = s.documents.findIndex((d) => d.id === id)
  if (idx === -1) return null
  const next = (s.documents[idx].auto_regen_attempts ?? 0) + 1
  s.documents[idx] = { ...s.documents[idx], auto_regen_attempts: next }
  persistStore()
  return next
}

// Recompute a job's status from its current documents. Called whenever
// documents are added, updated, deleted, or their verification score
// changes. Single source of truth for the doc-derived status transitions.
//
// Rule (manual-status model):
//   - Doc verification never sets 'ready'. 'ready' is a USER decision:
//     the user reviewed the generated documents and moved the job
//     forward (Pipeline drag / JobDetail status select). Documents only
//     ever drive 'sourced' (no/partial docs) or 'reviewing' (both docs
//     exist, however they scored).
//   - Never overwrite a status the user has moved past the doc pipeline
//     (applied, interviewing, offer, rejected, withdrawn) — and never
//     overwrite 'ready' either: once the user promoted the job there,
//     regenerating or re-verifying documents must not yank it back.
//   - Jobs whose status was set explicitly by the user carry
//     manual_status=1 and are skipped by recompute entirely, so even
//     sourced/reviewing stick once the user chose them.
//   - "Has a CV" / "has a cover letter" means GENERATED for this job. The
//     base CV row (is_base = 1) is the user's master document and does not
//     count; without that filter a job could reach 'reviewing' having had
//     nothing generated for it. Same predicate the docs backlog sweep
//     (electron/docsAutoQueue.ts) uses to decide what is still missing.
export function recomputeJobStatusFromDocs(jobId: number): JobStatus | null {
  const s = loadStore()
  const jobIdx = s.jobs.findIndex((j) => j.id === jobId)
  if (jobIdx === -1) return null
  const current = s.jobs[jobIdx].status
  if (s.jobs[jobIdx].manual_status === 1) return current

  // `is_base` is excluded here for the same reason `listJobDocuments`
  // excludes it: a row with is_base = 1 is the user's master CV, not
  // anything generated for this job, and counting it let a job reach
  // 'reviewing' with no generated CV at all. `job_id === jobId` alone is
  // NOT sufficient — the master CV is stored with a null job_id but the
  // column is the actual marker, and the store may hold a base row that
  // predates the null-job_id convention.
  const docs = s.documents.filter((d) => d.job_id === jobId && d.is_base !== 1)
  const next = nextStatusFromDocs(current, {
    hasCv: docs.some((d) => d.type === 'cv'),
    hasCl: docs.some((d) => d.type === 'cover_letter'),
    // Verification scores no longer drive status; passed for shape only.
    cvVerified: (docs.find((d) => d.type === 'cv')?.verification_score ?? 0) >= 70,
    clVerified: (docs.find((d) => d.type === 'cover_letter')?.verification_score ?? 0) >= 70
  })
  if (next === null) return current

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
  return loadStore().settings
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
  return `model-${  Date.now()  }-${  Math.random().toString(36).slice(2, 6)}`
}

export function listApiModels(): ApiModelConfig[] {
  return loadStore().api_models
}

/**
 * Spend recorded against a bucket that a model edit is about to rename.
 *
 * The bucket is `(endpoint, credential hash)`, and the Settings page writes
 * the WHOLE model list back on any edit to any model row. So pasting a
 * reissued key for an account the app has already been spending through
 * changed the bucket identity, and the same account started again at a full
 * allowance — the very next automated call went out on top of an existing
 * cap-1 spend. A key rotation was a spend-cap reset, which made the bound
 * weaker than advertised in the only direction an attacker or an accident
 * needs.
 *
 * Two things are deliberately NOT the fix. The bucket is not re-keyed to the
 * endpoint alone: two keys configured at the same time are two independent
 * allowances, deliberately (see providerKey.ts), and conflating them would
 * silently cap an unrelated credential. And the spend is COPIED rather than
 * moved — a bucket another configured model still shares is untouched, so no
 * bucket can end up under-counted. Where one old bucket fans out to several
 * new ones the sum across them over-counts, which is the direction this
 * design already accepts everywhere else: over-counting ages out, and
 * under-counting is the hole the cap exists to close.
 *
 * Only an UNCHANGED endpoint counts as the same account. A model moved to a
 * different base URL is a different provider with a different allowance, and
 * carrying spend into it would refuse work the new provider could do.
 */
function carryProviderSpendOnKeyEdit(before: ApiModelConfig[], after: ApiModelConfig[]): void {
  if (before.length === 0 || after.length === 0) return
  // Old model -> new model, by store id, so an edit to one row is visible as
  // an edit to that row and not as the whole list being replaced.
  const byId = new Map(before.map((m) => [m.id, m]))
  const moves = new Map<string, Set<string>>()
  for (const model of after) {
    const was = byId.get(model.id)
    if (!was || !providerKeyMoved(was, model)) continue
    const from = providerKey(was)
    const to = providerKey(model)
    if (from === to) continue
    const targets = moves.get(from) ?? new Set<string>()
    targets.add(to)
    moves.set(from, targets)
  }
  if (moves.size === 0) return
  const spend = getProviderSpend()
  let carried = 0
  for (const [from, targets] of moves) {
    const history = spend[from]
    if (!Array.isArray(history) || history.length === 0) continue
    for (const to of targets) {
      const target = spend[to] ?? []
      // Deduplicated: two models that rotated into the same new credential
      // are one account, so the same window must not be counted twice.
      if (target.some((c) => c && history.some((h) => h.at === c.at))) continue
      spend[to] = [...target, ...history.map((c) => ({ ...c }))]
      carried++
    }
  }
  if (carried > 0) persistStore()
}

/**
 * Replace the whole model list.
 *
 * Also the seam where a credential edit is noticed, because it is the one
 * writer that sees both the old list and the new one — see
 * `carryProviderSpendOnKeyEdit` for why the spend has to move with the key
 * rather than being orphaned by it.
 */
export function saveApiModels(models: ApiModelConfig[]): ApiModelConfig[] {
  const s = loadStore()
  carryProviderSpendOnKeyEdit(s.api_models, models)
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
//
// v5 gate: 2026-07-23 follow-up. The v4 retrofit's nameAsCC check
// had a bug — it only matched when the leading token was 2 letters
// (the canonicalizeCountry shortcut), not when it was a full
// country name like "Canada" that the COUNTRIES map would resolve.
// So on the first v4 run the gate set v4='1' with no rows changed,
// and subsequent restarts skipped the work. v5 re-runs the collapse
// with the fixed lookup so pre-existing rows actually get rewritten.
export function hasLocationsNormalizedV4(): boolean {
  return loadStore().settings.locations_normalized_v4 === '1'
}

export function markLocationsNormalizedV4(): void {
  const s = loadStore()
  s.settings.locations_normalized_v4 = '1'
  persistStore()
}

export function hasLocationsNormalizedV5(): boolean {
  return loadStore().settings.locations_normalized_v5 === '1'
}

export function markLocationsNormalizedV5(): void {
  const s = loadStore()
  s.settings.locations_normalized_v5 = '1'
  persistStore()
}

// v6 gate: 2026-07-23. The writer's 1-part branch now expands a
// bare 2-letter country code (e.g. "CA") to the full name
// ("Canada") so the Location column shows a human-readable
// country. Pre-existing rows that the user stored as just "CA" /
// "US" / "GB" need the same expansion. Idempotent — gated on a
// distinct flag so it runs once per store.
export function hasLocationsNormalizedV6(): boolean {
  return loadStore().settings.locations_normalized_v6 === '1'
}

export function markLocationsNormalizedV6(): void {
  const s = loadStore()
  s.settings.locations_normalized_v6 = '1'
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
  // Editing the CV is the user asking for every job to be scored again
  // against it, so it retires the "Clear queue" tombstone: the earlier
  // cancellation was about a body of work defined by the OLD CV, and
  // holding it against the new one would mean the backlog can never drain
  // again. Without this, one Clear press would permanently disable
  // automatic fit scoring for every job in the store.
  s.settings.queue_cleared_at = 0
  s.settings.queue_cleared_max_job_id = 0
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
 * v5 retrofit (2026-07-23): re-runs the v4 collapse with the fixed
 * `canonicalizeCountry` lookup. The v4 retrofit's nameAsCC check
 * only matched when the leading token was 2 letters (the
 * canonicalizeCountry shortcut), so full country names like
 * "Canada" were skipped and v4 set the gate with no rows
 * rewritten. v5 calls the same `stripRedundantCountrySuffix` (now
 * using the full lookup) and is gated on a distinct flag so it
 * runs exactly once.
 */
export function retrofitLocationsV5(): { updated: number; total: number } {
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
  s.settings.locations_normalized_v5 = '1'
  persistStore()
  return { updated, total: s.jobs.length }
}

/**
 * v6 retrofit (2026-07-23): the writer's 1-part branch now expands
 * a bare 2-letter country code (e.g. "CA") to the full name
 * ("Canada") via the new `countryNameFromCode` helper. Pre-existing
 * rows that the user stored as just "CA" / "US" / "GB" need the
 * same expansion. Gated on a distinct v6 flag so it runs once per
 * store; the helper is called through the same `expandBareCountryCode`
 * path the writer uses, so the v6 work matches what new rows get.
 */
export function retrofitLocationsV6(): { updated: number; total: number } {
  const s = loadStore()
  let updated = 0
  for (const j of s.jobs) {
    const expanded = expandBareCountryCode(j.location)
    if (expanded !== j.location) {
      j.location = expanded
      j.updated_at = now()
      updated++
    }
  }
  s.settings.locations_normalized_v6 = '1'
  persistStore()
  return { updated, total: s.jobs.length }
}

/**
 * Expand a 1-part 2-letter country code to the full country name.
 * "CA" → "Canada", "US" → "United States", "GB" → "United Kingdom",
 * etc. Anything that's not a 1-part 2-letter known country code
 * (3-part "City, REGION, CC", 2-part "Vancouver, CA", bare "Canada",
 * unknown 2-letter codes) is returned as-is. Mirrors the writer's
 * 1-part branch — the same expansion applies to new writes and to
 * retrofit-replayed rows.
 */
function expandBareCountryCode(location: string | null | undefined): string | null {
  if (!location) return location
  const parts = location.split(',').map((p) => p.trim())
  if (parts.length !== 1) return location
  const token = parts[0]
  if (token.length !== 2) return location
  return countryNameFromCode(token) ?? location
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
  // Resolve the leading name via the writer's full-name → 2-letter
  // map (handles "Canada" → "CA", "United States" → "US", etc.).
  // Match the resolved code against the trailing 2-letter token;
  // when they agree, the shape is redundant and we strip the
  // suffix. The 2-letter shortcut in canonicalizeCountry also
  // catches bare 2-letter codes like "USA" → "US".
  const nameAsCC = canonicalizeCountry(name)
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
 * One-shot: union the original 5 default-disabled walled boards (see
 * DEFAULT_DISABLED_BOARDS_V1 in boards.ts) into the saved disabled_boards
 * list. 1ca07d9 shipped the list as a fresh-install default only, so
 * existing installs with a saved empty array kept scanning the 5
 * Cloudflare-walled boards. Flag-gated so it runs once per install and
 * later user edits (re-enables, extra disables) are never overwritten.
 */
export function migrateDefaultDisabledBoardsV1(): { updated: boolean } {
  const s = loadStore()
  if (s.settings.disabled_boards_migrated_v1 === '1') return { updated: false }
  const current = Array.isArray(s.settings.disabled_boards)
    ? s.settings.disabled_boards
    : []
  const next = unionDisabledBoards(current, DEFAULT_DISABLED_BOARDS_V1)
  s.settings.disabled_boards = next
  s.settings.disabled_boards_migrated_v1 = '1'
  persistStore()
  return { updated: next.length !== current.length }
}

/**
 * One-shot: union the 6 additional default-disabled walled boards
 * (CharityVillage, DailyRemote, NoDesk, Work At A Startup, Crossover,
 * Hiring Cafe) into the saved disabled_boards list. These were added to
 * DEFAULT_DISABLED_BOARDS on 2026-09-07; existing installs that already
 * ran v1 need this follow-up migration to disable them. Flag-gated so
 * it runs once per install and later user edits survive.
 */
export function migrateDefaultDisabledBoardsV2(): { updated: boolean } {
  const s = loadStore()
  if (s.settings.disabled_boards_migrated_v2 === '1') return { updated: false }
  const current = Array.isArray(s.settings.disabled_boards)
    ? s.settings.disabled_boards
    : []
  const next = unionDisabledBoards(current, DEFAULT_DISABLED_BOARDS_V2_ADDITIONS)
  s.settings.disabled_boards = next
  s.settings.disabled_boards_migrated_v2 = '1'
  persistStore()
  return { updated: next.length !== current.length }
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

/**
 * One-shot migration for the manual-status rule change: the OLD doc rule
 * auto-promoted jobs to 'ready' whenever both documents verified >= 70.
 * 'ready' is now user-only, so demote every auto-promoted 'ready' job
 * back to 'reviewing' (both docs exist there by definition). Jobs a user
 * genuinely promoted are indistinguishable from auto-promoted ones — the
 * old rule never set manual_status — so all 'ready' jobs are demoted;
 * the user re-promotes the ones they actually reviewed. Protected
 * statuses (applied and beyond) are left untouched: those transitions
 * were always user- or application-driven.
 */
export function demoteAutoReadyJobs(): { updated: number; total: number } {
  const s = loadStore()
  let updated = 0
  for (const j of s.jobs) {
    if (j.status === 'ready') {
      j.status = 'reviewing'
      j.updated_at = now()
      updated++
    }
  }
  s.settings.statuses_manual_v2 = '1'
  persistStore()
  return { updated, total: s.jobs.length }
}

export function hasStatusesManualV2(): boolean {
  return loadStore().settings.statuses_manual_v2 === '1'
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

export function getBoardScanTimes(): Record<string, number[]> {
  return loadStore().board_scan_times
}

export function recordBoardScanTime(name: string, durationMs: number): void {
  const s = loadStore()
  if (!s.board_scan_times) s.board_scan_times = {}
  const history = s.board_scan_times[name] || []
  history.push(durationMs)
  // Keep only the last 20 scan times
  if (history.length > 20) history.splice(0, history.length - 20)
  s.board_scan_times[name] = history
  persistStore()
}

// Provider spend tracking
//
// The same shape as board health above — a keyed list of timestamps, pruned
// on write — because it is the same problem (a rolling record that must not
// grow forever) and it belongs in the same store, so a restart cannot reset
// it. Unlike a board's scan history this one is load-bearing: it is the
// input to the cap in ai.ts, and a reset of it would be a hole in the very
// bound it exists to hold.

export function getProviderSpend(): Record<string, ProviderCall[]> {
  const s = loadStore()
  const spend = s.provider_spend ?? (s.provider_spend = {})
  // Prune on READ as well as on write, because the write prunes one bucket
  // at a time: a bucket nobody writes to again — a key the user replaced, a
  // provider they deleted — is never rewritten, so a write-time-only prune
  // left it in the persisted map for ever. The MAP therefore only ever grew,
  // by one leaked key per credential the user had ever typed. Bounding each
  // array is not bounding the record.
  //
  // One-sided, like the window in ai.ts: a stamp dated in the future stays —
  // it is the record of a clock anomaly, and deleting it would hide the
  // anomaly rather than fix it (see `ProviderBudget.clockSkewed`). Only what
  // has aged out of the window goes.
  //
  // Pruned in place on the loaded store, so the next persist drops it from
  // disk too rather than this being a read-time fiction.
  const cutoff = Date.now() - PROVIDER_SPEND_WINDOW_MS
  for (const [key, history] of Object.entries(spend)) {
    if (!Array.isArray(history)) {
      delete spend[key]
      continue
    }
    const live = history.filter(
      (c) => !!c && typeof c.at === 'number' && Number.isFinite(c.at) && c.at > cutoff
    )
    // A bucket with nothing left in the window is not a provider with a
    // budget of zero, it is a provider this app has no record of. Deleting
    // the key is what makes the record bounded; keeping it as an empty array
    // would satisfy nothing.
    if (live.length === 0) delete spend[key]
    else if (live.length !== history.length) spend[key] = live
  }
  return spend
}

/**
 * Record ONE real outbound request against a provider key.
 *
 * Called from the single point in ai.ts where the request is issued, so the
 * count is a property of the wire rather than of the queue's own bookkeeping
 * — a request that is made and then fails (429, timeout, HTTP 200 carrying
 * a billing notice) is spend and is counted, and nothing is counted for a
 * request that was never issued.
 *
 * `at` is a parameter so a caller can state the instant it was counted at
 * when that is not quite `Date.now()`; it defaults to now.
 *
 * Pruning is to the rolling window, which is what keeps the record bounded:
 * a timestamp that has aged out of the 24h window can no longer count
 * against the cap, so keeping it would only grow the store.
 */
export function recordProviderCall(key: string, manual: boolean, at?: number): void {
  const s = loadStore()
  if (!s.provider_spend) s.provider_spend = {}
  const now = at ?? Date.now()
  const history = s.provider_spend[key] || []
  history.push({ at: now, manual })
  // In-window calls only. A FILTER rather than the old prefix drop, which
  // only ever removed from the front: the array is not sorted when the clock
  // moves backwards, so a corrected clock left the entries behind the new
  // one pruned-in-place and the aged-out calls they were hiding counted
  // against the cap for ever.
  const cutoff = now - PROVIDER_SPEND_WINDOW_MS
  s.provider_spend[key] = history.filter(
    (c) => !!c && typeof c.at === 'number' && Number.isFinite(c.at) && c.at > cutoff
  )
  persistStore()
}

/**
 * Forget every provider's record. Tests only — the same contract as
 * `resetModelHealth()` in ai.ts, and deliberately NOT reachable from the UI:
 * a button that clears the budget would make the cap a suggestion. A real
 * app restart does NOT call this, which is the whole point — the budget has
 * to outlive the process.
 *
 * No write when there is nothing to clear, so a test that resets before every
 * step does not pay a full-store encrypt per step for a no-op.
 */
export function clearProviderSpend(): void {
  const s = loadStore()
  if (Object.keys(s.provider_spend ?? {}).length === 0) return
  s.provider_spend = {}
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

/**
 * Apply a patch to one queue row.
 *
 * Returns whether the row was found and updated. A `false` means the
 * item no longer exists — which the queue processor treats as "this
 * work was cleared out from under us, stop". The return value is what
 * makes that detectable: the write was previously a silent no-op, so a
 * pass holding a stale snapshot would carry on issuing LLM calls for
 * rows that were already gone.
 */
export function updateAIQueueItem(id: number, updates: Partial<AIQueueItem>): boolean {
  const s = loadStore()
  const idx = s.ai_queue.findIndex((q) => q.id === id)
  if (idx === -1) return false
  s.ai_queue[idx] = { ...s.ai_queue[idx], ...updates }
  persistStore()
  return true
}

/**
 * Collapse queue rows that describe the same piece of work.
 *
 * `enqueue()`'s duplicate guard used to match `pending` only, so an
 * enqueue landing while an identical item was mid-`processing` created
 * a second row. Two creation paths (the startup backlog and the
 * fit-auto-score timer) plus the processor's own retry cycle produced
 * three `score_fit` rows for one job, which the Queue panel then showed
 * verbatim. Widening the guard to `processing` closed that one; a
 * `failed` row was still outside it, because re-queueing failed work
 * "is the recovery path" — so a failed row persisted AND the next
 * enqueue for the same work added a second, and both were visible. That
 * is the duplicate the user reported.
 *
 * The guard is now widened to every status, so neither can recur — but
 * rows already written stay written. This is the one-shot repair for
 * them, and it runs under `queue_dedup_v2` (the v1 flag, and the run it
 * gated, were both about the `pending`/`processing` class alone).
 *
 * A NEW flag rather than a re-armed v1, for two reasons. It keeps the
 * repair one-shot: v1 is the record that this store was collapsed, and
 * resetting it would re-run a pass that has already done its job on
 * every subsequent startup, forever. And it keeps the two runs
 * distinguishable — a store that carries v2 has been through both, and
 * the v2 pass is the one that had to deal with `failed` rows among the
 * duplicates.
 *
 * The survivor is chosen to preserve the most work: the item furthest
 * along its retry budget wins, and `processing` beats `pending` beats
 * `failed` at equal attempts, so a duplicate pair does not throw away an
 * in-flight request. Nothing is merged — a single row is kept as-is and
 * the rest are dropped, because inventing an attempt count or status
 * for the survivor would be a guess.
 *
 * "Same work" is decided field-wise (`sameWork` below): same type, same
 * job, same document, same section, with absent fields read as null. It
 * is deliberately NOT a concatenated string key, because this pass
 * deletes rows it thinks are duplicates and a key quietly widens that
 * judgement to every pair of rows that merely print the same.
 */
export function dedupeAIQueueItems(): { removed: number } {
  const s = loadStore()
  if (s.settings.queue_dedup_v2 === '1') return { removed: 0 }

  const rank = (q: AIQueueItem): number =>
    q.status === 'processing' ? 2 : q.status === 'pending' ? 1 : 0
  const sameWork = (a: AIQueueItem, b: AIQueueItem): boolean =>
    a.type === b.type &&
    a.jobId === b.jobId &&
    (a.documentId ?? null) === (b.documentId ?? null) &&
    (a.sectionName ?? null) === (b.sectionName ?? null)

  // `sameWork` is the ONLY thing that decides equality here. It used to
  // sit above this loop unused while grouping went through a
  // `|`-delimited string key
  // (`${type}|${jobId}|${documentId ?? ''}|${sectionName ?? ''}`), and a
  // key silently equates every pair of rows that stringify alike — the
  // repair then deletes one of them without asking. It is not a
  // hypothetical: `sectionName: ''` and an absent `sectionName` both
  // render as the empty tail of the key, so a blank-headed section and
  // a section-less one were merged and one row was dropped.
  //
  // Bucketing is a linear walk over the buckets found so far, comparing
  // against each bucket's first member. One representative per bucket is
  // enough because `sameWork` compares fields, so it is an equivalence
  // relation: everything in a bucket is sameWork-equal to its first
  // member, and anything sameWork-equal to a bucket member is
  // sameWork-equal to the representative. That is slower than a hash on
  // the queue's size, and deliberately so — this runs once per store, on
  // a queue measured in hundreds of rows, and a key that has to be
  // correct for every possible field value is the thing that was wrong
  // here.
  const buckets: AIQueueItem[][] = []
  for (const q of s.ai_queue) {
    const bucket = buckets.find((b) => sameWork(b[0], q))
    if (bucket) bucket.push(q)
    else buckets.push([q])
  }

  let removed = 0
  const keep: AIQueueItem[] = []
  for (const bucket of buckets) {
    if (bucket.length === 1) {
      keep.push(bucket[0])
      continue
    }
    const winner = [...bucket].sort(
      (a, b) => rank(b) - rank(a) || b.attempts - a.attempts || a.id - b.id
    )[0]
    keep.push(winner)
    removed += bucket.length - 1
  }

  s.ai_queue = keep
  // Both flags, so a store that reaches this pass having never run it
  // (a fresh install, or one written before either flag existed) records
  // both runs having happened. v1 is otherwise superseded by v2.
  s.settings.queue_dedup_v1 = '1'
  s.settings.queue_dedup_v2 = '1'
  persistStore()
  return { removed }
}

export function removeAIQueueItem(id: number): void {
  const s = loadStore()
  s.ai_queue = s.ai_queue.filter((q) => q.id !== id)
  persistStore()
}

/**
 * Hand back the retry budget that a provider outage spent for free.
 *
 * The 2026-10-02 overnight run: 265 queued tasks, 0 processed, ~20 hours.
 * Every provider call was HTTP 429, so `callAI` spent most of its time
 * throwing `ProviderCooldownError` — before any request — and the queue
 * charged that throw an attempt anyway. Rows therefore burned all 10
 * attempts while the provider was still refusing, and by the time it
 * recovered every one of them had nothing left to retry with. Some sat
 * `failed`; others were parked `pending` on the 4h auto-revive cooldown
 * carrying the same message in `lastError`.
 *
 * The bug is fixed for new failures, but a store written by the old
 * build still holds those rows, and their work is not lost — it is
 * stalled, with an exhausted budget and nothing to show for it. This is
 * the one-shot repair for them.
 *
 * WHAT IT MATCHES, precisely:
 *
 *   status `failed` — reset `attempts` to 0 and make the row due now.
 *     Its budget was spent on requests that never happened.
 *   status `pending` — leave `attempts` alone (a parked row was already
 *     reset to 0 by the auto-revive path) and pull `nextRetryAt` forward
 *     to now, so it stops sitting out a 4h cooldown for a provider that
 *     may have recovered an hour ago.
 *
 *   and in both cases only when `lastError` is the cooldown throw's
 *   message (`isCooldownBlockedMessage`, anchored on its fixed prefix).
 *   A row that failed for any other reason — a parse failure, a
 *   timeout, a validation rejection, a 402 — keeps its budget, because
 *   those DID cost a provider request and its budget was honestly
 *   spent. Matching the message is the only option here: these rows have
 *   no other record. Control flow at runtime branches on the error type
 *   instead; this is data repair over what an older build wrote.
 *
 *   `processing` rows are NOT matched and NOT touched. That state means
 *   "claimed, in flight", it is reclaimed at startup by
 *   `reclaimInterruptedItems`, and its `lastError` is whatever the
 *   PREVIOUS round happened to record — not evidence about this one.
 *
 * WHAT IT NEVER DOES:
 *
 *   It adds no row. Only rows already in `ai_queue` are rewritten, so a
 *   user who pressed "Clear queue" cannot have that work come back
 *   through this door — `clearAIQueue` deletes the rows, and there is
 *   nothing here that re-seeds from the jobs table.
 *
 *   It does not resurrect a row the user cleared even when one is still
 *   present. The clear's tombstone (`queue_cleared_at` +
 *   `queue_cleared_max_job_id`) is honoured per row: a row whose job id
 *   is at or below the watermark is work the user cancelled, and
 *   re-running it here would be exactly the leak the tombstone exists
 *   to close — so those rows are counted as skipped and left alone, with
 *   their attempts and status untouched. Rows above the watermark are
 *   work that arrived after the clear and are repaired normally.
 *
 *   It invents nothing. `autoRevives` is left as found even though a
 *   no-op failure may have charged one: handing a row recovery budget it
 *   has not earned is the same fabrication as inventing an attempt
 *   count, and the Reset button is the user's way to grant it.
 *
 * One-shot under `queue_cooldown_reset_v1`, so re-running is a no-op and
 * a user's later rows are never touched by it.
 */
export function unpoisonCooldownFailedAIQueueItems(): {
  reset: number
  unstuck: number
  clearedWorkSkipped: number
  alreadyMigrated: boolean
} {
  const s = loadStore()
  if (s.settings.queue_cooldown_reset_v1 === '1') {
    return { reset: 0, unstuck: 0, clearedWorkSkipped: 0, alreadyMigrated: true }
  }

  const maxClearedJobId = getQueueClearedMaxJobId()
  const isClearedWork = (jobId: number): boolean => maxClearedJobId > 0 && jobId <= maxClearedJobId

  const now = Date.now()
  let reset = 0
  let unstuck = 0
  let clearedWorkSkipped = 0
  for (const q of s.ai_queue) {
    if (q.status !== 'failed' && q.status !== 'pending') continue
    if (!isCooldownBlockedMessage(q.lastError)) continue
    if (isClearedWork(q.jobId)) {
      clearedWorkSkipped++
      continue
    }
    if (q.status === 'failed') {
      // The row is re-queued rather than deleted: the user still wants
      // this document / score, and `failed` is what the Queue panel's
      // Retry button acts on. Nothing is spent here — the next pass
      // decides whether a provider is available at all.
      q.status = 'pending'
      q.attempts = 0
      q.nextRetryAt = now
      // The block is over: the cooldown that produced this error has
      // been repaired, so the row must not keep rendering (or waiting
      // on) the provider clock.
      q.blockedSince = undefined
      q.blockedCount = undefined
      reset++
    } else {
      // A parked row already carries a fresh attempt count; all it needs
      // is to stop waiting out a cooldown it is not blocked by.
      q.nextRetryAt = now
      q.blockedSince = undefined
      q.blockedCount = undefined
      unstuck++
    }
  }

  s.settings.queue_cooldown_reset_v1 = '1'
  persistStore()
  return { reset, unstuck, clearedWorkSkipped, alreadyMigrated: false }
}

/**
 * Drop every queued task, whatever its status.
 *
 * Deliberately unconditional: the caller is responsible for confirming
 * with the user first, because there is no undo and a queue can hold
 * hundreds of pending fit scores and document generations.
 *
 * A task that is mid-flight is not cancelled — the LLM call already in
 * progress runs to completion, and its `removeAIQueueItem` afterwards is
 * a no-op on a row that is no longer there. That is the safe direction
 * to err: work already paid for still completes rather than being
 * thrown away mid-request.
 */
export function clearAIQueue(): number {
  const s = loadStore()
  const removed = (s.ai_queue ?? []).length
  s.ai_queue = []
  // The durable half of the clear (see isScoreFitSuppressed). Written
  // HERE rather than in aiQueue's clearQueue so the tombstone cannot be
  // bypassed by a caller that empties the queue by any other route —
  // clearQueue is the only production caller today, but the store is the
  // one place that knows the rows are gone for good.
  s.settings.queue_cleared_at = Date.now()
  // `nextId` is the id the NEXT job will get, so the highest id that
  // exists right now is the watermark between "was in the store when the
  // user cancelled" and "arrived afterwards". See isScoreFitSuppressed.
  s.settings.queue_cleared_max_job_id = Math.max(0, s.nextId - 1)
  persistStore()
  return removed
}

/**
 * When the user last pressed "Clear queue", as epoch ms. 0 when they
 * never have.
 *
 * The tombstone the re-seeders consult, read straight out of the store,
 * so it is the same value in every process and every pass: an app restart,
 * the hourly fit-auto-score timer and the post-scan backlog all see it.
 */
export function getQueueClearedAt(): number {
  const at = loadStore().settings.queue_cleared_at
  return typeof at === 'number' && Number.isFinite(at) && at > 0 ? at : 0
}

/**
 * The highest job id that existed at the moment of the last clear. 0 when
 * the store was empty, or when there has never been a clear.
 */
function getQueueClearedMaxJobId(): number {
  if (getQueueClearedAt() <= 0) return 0
  const id = loadStore().settings.queue_cleared_max_job_id
  return typeof id === 'number' && Number.isFinite(id) && id > 0 ? id : 0
}

/**
 * Whether automatic fit scoring has been cancelled for this job.
 *
 * Deleting the queue rows is not enough on its own: two re-seeders walk
 * the JOBS table rather than the queue — `enqueueScoreFitBacklog` at
 * startup and after every scan, and `runFitAutoScoreBacklog` on the
 * hourly timer — and both rebuild exactly the `score_fit` rows a clear just
 * removed. The confirm dialog promises "Pending fit scores and document
 * generation will be cancelled", and a user trying to stop spend cannot
 * be told that and have the same work return on the next hourly tick.
 *
 * So the clear is persisted, and everything already in the store when the
 * user pressed the button is off-limits to the automatic paths:
 *
 *   - id <= the watermark  -> suppressed. This is the work the user
 *     cancelled. It covers rows that were mid-flight and rows sitting
 *     `failed` at the time, neither of which the queue wipe could express
 *     on its own.
 *   - id >  the watermark  -> not suppressed. A job the user imported or
 *     a scan found afterwards is new work; refusing to score it would
 *     leave the app silently doing nothing for the rest of time.
 *
 * The watermark is a job ID rather than a comparison against
 * `created_at` on purpose. Both ends of that comparison land inside the
 * same millisecond as the clear often enough to matter (a scan finishing
 * as the user clears, or two actions in one event-loop turn), and
 * whichever way the boundary is drawn, one of "the cleared work came
 * back" or "a new job was never scored" becomes a coin flip. Ids are
 * handed out monotonically by `nextId` and never reused, so the
 * watermark answers the same question with no clock and no parsing.
 *
 * Suppression gates the AUTOMATIC paths only. Every explicit user action
 * (Recompute fit, Tailor, Generate) calls the scorer directly and is
 * unaffected, and `bumpCvVersion` retires the tombstone because a new CV
 * redefines which jobs need scoring at all.
 */
export function isScoreFitSuppressed(jobId: number): boolean {
  const maxId = getQueueClearedMaxJobId()
  return maxId > 0 && jobId <= maxId
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
