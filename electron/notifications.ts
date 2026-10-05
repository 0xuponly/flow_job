import type {
  NotificationRow,
  NotificationType,
  NotificationSource,
  NotificationJobContext
} from './types'
import { notificationDedupeKey, notificationGroupKey } from './notificationGroup'
import { loadStore, saveStore, unreadableNotificationEntries } from './database'

const MAX_FIELD_BYTES = 4096
const ACTIVE_CAP = 500
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000
const PURGE_INTERVAL_MS = 24 * 60 * 60 * 1000

/**
 * How long a repeat of the same fact is folded into the row that already
 * records it, rather than written as a second row.
 *
 * THE MODEL, in one sentence: **the notification centre holds one row per
 * thing that went wrong.** A repeat of a thing is not another thing, so it
 * does not become another row, and — this is the half that was wrong — it
 * does not become another unit in the count either. The `× N` badge on a
 * collapsed row is the number of things inside it, which is why the drawer
 * counts rows and nothing else.
 *
 * That is the answer to "which number does the user read": the number of
 * failures, not the number of times the app said something. The reported
 * bug was one click producing ten toasts; the durable half of it was ten
 * permanent rows and a `× 12` badge that reported a multiple of what
 * actually went wrong. Folding the rows fixes the storage; counting rows
 * fixes the number. Keeping a counter and displaying it would have left the
 * badge reading exactly what it read before, with better code behind it.
 *
 * Two seconds is a judgement, not a default:
 *
 *   - Long enough to cover every duplicate this app actually produces.
 *     Every one of them is either same-tick — a re-render, and the
 *     StrictMode double-mount that `src/main.tsx` causes on every mount in
 *     `npm run dev`, which is exactly where the reported ten came from —
 *     or the immediate retry after it. A second attempt at the same
 *     document with the same error is the same thing going wrong again.
 *
 *   - Short enough that it cannot eat the user's history. Two occurrences
 *     of one failure minutes apart are two things that happened, and only
 *     the second of them is news: the user wants to know their CV failed
 *     at 09:14 AND again at 11:02, because something changed in between.
 *     Any window long enough to swallow that would be inventing an
 *     "it keeps failing" that the store cannot actually support.
 *
 * RELATION TO THE TOAST LAYER, which is the other half of the model and the
 * reason 2000 is not 8000.
 *
 * `notify` refuses to stack the same sentence on itself for the length of
 * the toast's TTL — 8000 ms for an error (src/components/Notifications.tsx).
 * So the overlay and the record agree about a burst and disagree about a
 * spaced repeat:
 *
 *   10 emissions inside 2 s  ->  overlay: one sentence, no count.
 *                              centre:  one row, no badge.
 *                              AGREE, and that is the reported bug fixed
 *                              end to end rather than in storage only.
 *
 *   2 emissions 5 s apart    ->  overlay: one sentence (its 8 s window is
 *                              still open), centre: two rows and `× 2`.
 *                              The centre reports more.
 *
 * That asymmetry is the point, and it is only sound in one direction: the
 * durable layer must never know about FEWER things than the transient one,
 * or the user would be shown a permanent record of something the app had
 * already decided not to bother them about. So the record window has to be
 * the SHORTER of the two, which is what makes `DEDUPE_WINDOW_MS < 8000` a
 * correctness property rather than a tuning choice. A window longer than the
 * toast's would invert it: the overlay would report one failure and the
 * centre would claim there was nothing at all.
 */
const DEDUPE_WINDOW_MS = 2000

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

/**
 * The newest active row this write is a repeat of, or null.
 *
 * Scanned backwards and time-filtered before the key is derived, so the
 * cost is one integer comparison for every row outside the window — which
 * is all of them but the last couple of seconds' worth, since `created_at`
 * is the insert clock and rows are appended in insert order.
 *
 * `dismissed_at === null` is part of the match and not an optimisation.
 * A user who dismissed a failure and then hit the same failure again is
 * seeing something new: reviving the dismissed row would put back a
 * message they chose to remove, and it would do it silently.
 *
 * A match means "this thing already went wrong and is already on record",
 * and that is ALL it means. Nothing is incremented, because the number the
 * centre shows is the number of things that went wrong — see
 * `DEDUPE_WINDOW_MS` — and a repeat is not another thing that went wrong.
 * That is the whole model in one function: inside the window it is the
 * same fact, so it is one row, and the drawer reports one.
 */
function findRepeatable(
  rows: NotificationRow[],
  dedupeKey: string,
  now: number
): NotificationRow | null {
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]
    if (row.dismissed_at !== null) continue
    const age = now - row.created_at
    // `age < 0` is a clock that went backwards (or a row written by a
    // machine ahead of this one). Treated as inside the window: the
    // conservative direction is to collapse, never to lose a payload.
    if (age > DEDUPE_WINDOW_MS || age < 0) continue
    if (
      notificationDedupeKey(row.type, row.source, row.group_key, row.job, row.full_message) === dedupeKey
    ) return row
  }
  return null
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
  const type = coerceType(input.type)
  const source = input.source ?? 'app'
  const message = clampBytes(input.message)
  const fullMessage = clampBytes(input.full_message)
  const groupKey = clampBytes(input.group_key || notificationGroupKey(type, source, message))
  const job = cleanJobContext(input.job)
  const now = Date.now()

  // The repeat check happens BEFORE `nextId++`, so a folded repeat does not
  // burn an id either. Nothing is written and nothing changes: the row that
  // already records this thing is the record.
  const repeat = findRepeatable(
    store.notifications,
    notificationDedupeKey(type, source, groupKey, job, fullMessage),
    now
  )
  if (repeat) return { id: repeat.id }

  const id = store.nextId++
  const row: NotificationRow = {
    id,
    type,
    source,
    message,
    full_message: fullMessage,
    created_at: now,
    dismissed_at: null,
    group_key: groupKey
  }
  if (job) row.job = job
  store.notifications.push(row)
  saveStore(store)
  return { id }
}

/**
 * The active rows, plus how many entries of the store's notification list
 * could not be read at all.
 *
 * The second number is not decoration. The store migration drops anything
 * in `notifications` that is not an object, because `loadStore` is the
 * accessor for the WHOLE store and a `null` or a number in that array
 * would throw out of it and take jobs, documents and settings down with
 * it — for a notification list the user may not even have opened. Dropping
 * them is the right call; dropping them SILENTLY is not, because the list
 * then reads as empty. A store whose only entry is `'not-an-object'` loaded
 * to `rows: []`, the renderer had no way to tell that from a genuinely
 * empty centre, and the drawer said "No notifications." — the drawer
 * asserting, confidently and wrongly, that there was nothing to see.
 *
 * So the count rides along with every read and the drawer can say what it
 * could not show. It is a property of the store FILE, so it clears itself
 * once the file no longer contains those entries: see the reset in
 * `saveStore`.
 */
export function listActiveNotifications(): { rows: NotificationRow[]; unreadable: number } {
  const store = loadStore()
  const rows = store.notifications
    .filter((r) => r.dismissed_at === null)
    .sort((a, b) => b.created_at - a.created_at)
    .slice(0, ACTIVE_CAP)
  return { rows, unreadable: unreadableNotificationEntries() }
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
