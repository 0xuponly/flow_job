import type {
  NotificationRow,
  NotificationType,
  NotificationSource,
  NotificationJobContext
} from './types'
import { notificationGroupKey } from './notificationGroup'
import { loadStore, saveStore } from './database'

const MAX_FIELD_BYTES = 4096
const ACTIVE_CAP = 500
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000
const PURGE_INTERVAL_MS = 24 * 60 * 60 * 1000

const VALID_TYPES: readonly NotificationType[] = ['info', 'success', 'error', 'warning']

// Clamp by byte length, not char length. If exceeded, truncate to
// MAX_FIELD_BYTES bytes (re-decode to avoid splitting a multi-byte
// char). Used for both `message` and `full_message`.
function clampBytes(s: string): string {
  if (Buffer.byteLength(s, 'utf-8') <= MAX_FIELD_BYTES) return s
  return Buffer.from(s, 'utf-8').subarray(0, MAX_FIELD_BYTES).toString('utf-8')
}

// Coerce an unknown type string to a known NotificationType. An
// unknown / misspelled value falls back to 'info' so a renderer bug
// can never put a row in an unrenderable state.
function coerceType(t: string): NotificationType {
  return (VALID_TYPES as readonly string[]).includes(t) ? (t as NotificationType) : 'info'
}

// A job field the caller could not source stays null and is rendered as
// nothing at all. This is the one place that decides it, so a caller
// cannot smuggle a placeholder past it by sending the string 'Unknown' or
// '' — an empty or whitespace-only value is not a value.
function cleanJobField(v: string | null | undefined): string | null {
  if (typeof v !== 'string') return null
  const trimmed = v.trim()
  return trimmed === '' ? null : clampBytes(trimmed)
}

function cleanJobContext(job: NotificationJobContext | undefined): NotificationJobContext | undefined {
  if (!job) return undefined
  const jobId = Number.isFinite(job.job_id) ? job.job_id : null
  const title = cleanJobField(job.job_title)
  const company = cleanJobField(job.job_company)
  const location = cleanJobField(job.job_location)
  // A context with nothing in it is not context. Dropping it here rather
  // than storing four nulls means "we knew nothing" and "we knew the job
  // but it has no location" stay distinguishable in the row.
  if (jobId === null && title === null && company === null && location === null) return undefined
  return { job_id: jobId, job_title: title, job_company: company, job_location: location }
}

export function addNotification(input: {
  type: string
  source?: NotificationSource
  message: string
  full_message: string
  /** Overrides the derived key. Only for a caller that genuinely knows
   *  that two differently-worded notifications are one thing. Empty is
   *  treated as absent, which is what the store migration's backfill
   *  guard also assumes — the two must agree or a row would be written
   *  with a blank key and then silently rewritten on the next load. */
  group_key?: string
  job?: NotificationJobContext
}): { id: number } {
  const store = loadStore()
  const id = store.nextId++
  const type = coerceType(input.type)
  const source = input.source ?? 'app'
  const row: NotificationRow = {
    id,
    type,
    source,
    message: clampBytes(input.message),
    full_message: clampBytes(input.full_message),
    created_at: Date.now(),
    dismissed_at: null,
    group_key: clampBytes(input.group_key || notificationGroupKey(type, source, input.message)),
  }
  const job = cleanJobContext(input.job)
  if (job) row.job = job
  store.notifications.push(row)
  saveStore(store)
  return { id }
}

export function listActiveNotifications(): { rows: NotificationRow[] } {
  const store = loadStore()
  const rows = store.notifications
    .filter((r) => r.dismissed_at === null)
    .sort((a, b) => b.created_at - a.created_at)
    .slice(0, ACTIVE_CAP)
  return { rows }
}

export function dismissNotification(id: number): { ok: true } {
  dismissNotifications([id])
  return { ok: true }
}

/**
 * Dismiss a set of rows in one store write.
 *
 * This exists because the notification center now collapses rows into
 * groups, and "dismiss this group" is the action a group row's × performs.
 * Looping `dismissNotification` would mean one IPC round-trip and one
 * whole-store serialize per occurrence — twelve for a group of twelve,
 * and each write re-encrypts the entire store.
 *
 * Unknown and already-dismissed ids are ignored rather than an error: the
 * renderer's list can be a tick stale, and a dismissal that reports back
 * "no such row" for something the user just clicked would be a lie about
 * something that in fact worked.
 */
export function dismissNotifications(ids: number[]): { updated: number } {
  if (ids.length === 0) return { updated: 0 }
  const store = loadStore()
  const wanted = new Set(ids.filter((id) => Number.isFinite(id)))
  if (wanted.size === 0) return { updated: 0 }
  const now = Date.now()
  let updated = 0
  for (const r of store.notifications) {
    if (r.dismissed_at === null && wanted.has(r.id)) {
      r.dismissed_at = now
      updated++
    }
  }
  if (updated > 0) saveStore(store)
  return { updated }
}

export function dismissAllNotifications(): { updated: number } {
  const store = loadStore()
  let updated = 0
  const now = Date.now()
  for (const r of store.notifications) {
    if (r.dismissed_at === null) {
      r.dismissed_at = now
      updated++
    }
  }
  if (updated > 0) saveStore(store)
  return { updated }
}

export function purgeOldDismissedNotifications(): { deleted: number } {
  const store = loadStore()
  const cutoff = Date.now() - THIRTY_DAYS_MS
  const before = store.notifications.length
  store.notifications = store.notifications.filter(
    (r) => r.dismissed_at === null || r.dismissed_at >= cutoff
  )
  const deleted = before - store.notifications.length
  if (deleted > 0) saveStore(store)
  return { deleted }
}

// Module-level handle so calling startNotificationsPurgeInterval
// twice does not double-register. The single timer ticks every 24h
// and prunes rows dismissed more than 30 days ago.
let purgeTimer: ReturnType<typeof setInterval> | null = null

export function startNotificationsPurgeInterval(): { stop: () => void } {
  if (purgeTimer) {
    return { stop: () => { /* no-op: timer is already cleared */ } }
  }
  purgeTimer = setInterval(() => {
    try {
      purgeOldDismissedNotifications()
    } catch {
      // Swallow: the renderer's notification center is the source of
      // truth for what the user sees; a failed purge just means old
      // rows stick around until the next tick.
    }
  }, PURGE_INTERVAL_MS)
  return {
    stop: () => {
      if (purgeTimer) {
        clearInterval(purgeTimer)
        purgeTimer = null
      }
    },
  }
}
