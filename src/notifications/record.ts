import { api } from '../api'
import { notify } from '../components/Notifications'
import type {
  NotificationJobContext,
  NotificationSource,
  NotificationType
} from '../types'

/**
 * The renderer side of "a toast is also a record".
 *
 * Module-level functions rather than a `useNotifications()` hook on
 * purpose. Two reasons, both about where the calls have to work from:
 *
 *   1. Every caller is inside an `async` handler or an effect deep in a
 *      page component. A hook would have to be called at the top of each
 *      of those components and its result captured into a closure, which
 *      puts the rule ("does this toast persist?") at the top of a file
 *      instead of at the line where the failure is reported.
 *   2. `JobDetail` and its sweep have no provider above them in any of
 *      their tests, and adding one would make "does a failed generate
 *      leave a record?" unanswerable without also standing up a provider.
 *
 * So the provider is not involved in writing at all. It is involved in
 * *reading*: `recordNotification` announces the write on a window event
 * and the provider re-fetches, which is the same shape the rest of this
 * renderer already uses for `app:refresh` and `app:viewedJob`.
 */

/** Fired after a record lands, so an open provider re-reads the store. */
export const NOTIFICATION_RECORDED_EVENT = 'app:notification-recorded'

/**
 * Fired to ask for the drawer to open.
 *
 * The same window-event arrangement as `app:navigate` (App.tsx) and
 * `app:viewedJob` (fitQueue.ts): the component holding the failure is
 * somewhere below the provider and must not have to thread a context
 * through to reach `open()`. Sidebar owns the one `open` in the tree.
 *
 * It exists because the toast that replaces a flood of toasts has to be
 * actionable. A toast that says "12 documents failed, see the
 * notification center" and cannot take you there has just moved the
 * problem.
 */
export const OPEN_NOTIFICATION_CENTER_EVENT = 'app:open-notification-center'

export function openNotificationCenter(): void {
  window.dispatchEvent(new CustomEvent(OPEN_NOTIFICATION_CENTER_EVENT))
}

/**
 * The minimum a job has to expose to be citable in a notification. A
 * `Job` satisfies it, and so does the handful of view models that carry
 * only the bits they already had — which is the point: the follow-ups
 * list knows the company and the role but never resolved a job id, and
 * using this shape means it records what it knows instead of either
 * skipping the citation or inventing one.
 *
 * Every field is optional because every field can be genuinely absent.
 */
export interface JobRef {
  id?: number | null
  title?: string | null
  company?: string | null
  location?: string | null
}

/**
 * `null` for anything not actually present. Never a placeholder.
 *
 * The product rule is that a field the app cannot source is not rendered
 * at all, so this function is the only place that decides, and it decides
 * strictly: `undefined`, `null`, `''` and whitespace all collapse to
 * `null`. There is deliberately no fallback string — not `'Unknown'`, not
 * `'—'` — because a placeholder in a record is worse than a missing
 * field: the record looks complete, so nothing prompts anyone to check.
 */
function sourced(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

/**
 * Build the citable job context, or nothing at all.
 *
 * Returns `undefined` when there is nothing to cite, so a caller can pass
 * the result straight through as `job` and a row with four nulls never
 * reaches the store.
 */
export function jobContext(job: JobRef | null | undefined): NotificationJobContext | undefined {
  if (!job) return undefined
  const context: NotificationJobContext = {
    job_id: Number.isFinite(job.id as number) ? (job.id as number) : null,
    job_title: sourced(job.title),
    job_company: sourced(job.company),
    job_location: sourced(job.location),
  }
  const empty = context.job_id === null && context.job_title === null &&
    context.job_company === null && context.job_location === null
  return empty ? undefined : context
}

export interface RecordInput {
  type: NotificationType
  source: NotificationSource
  /** The one-line summary — the same sentence the toast carries. */
  message: string
  /** What actually happened. This is what R3 expands to, so it must be the
   *  unsummarised text: the per-model rotation, the stack, the raw
   *  provider body. Defaults to `message` only when there is genuinely
   *  nothing more to say. */
  fullMessage: string
  job?: NotificationJobContext
  /** Overrides the derived group key. For a caller that knows two
   *  differently-worded notifications are one recurring thing. */
  groupKey?: string
}

/**
 * Write a notification record. Never rejects and never throws.
 *
 * A failure to *record* a failure must not become a second failure the
 * user has to be told about — it would be reported from inside the error
 * handler of the thing that already went wrong, which is the worst
 * possible place for it.
 */
export async function recordNotification(input: RecordInput): Promise<void> {
  try {
    const result = await api.notificationsAdd({
      type: input.type,
      source: input.source,
      message: input.message,
      full_message: input.fullMessage,
      ...(input.groupKey ? { group_key: input.groupKey } : {}),
      ...(input.job ? { job: input.job } : {}),
    })
    if (result && 'error' in result) return
    window.dispatchEvent(new CustomEvent(NOTIFICATION_RECORDED_EVENT))
  } catch {
    // Swallowed on purpose; see the doc comment.
  }
}

export interface FailureReport {
  /** The sentence the toast shows. */
  message: string
  /** Defaults to `message`. */
  fullMessage?: string
  source: NotificationSource
  type?: NotificationType
  job?: NotificationJobContext
  groupKey?: string
  ttl?: number
}

/**
 * THE persist-vs-toast-only rule, in one function.
 *
 * A notification is persisted when it is a FACT ABOUT THE WORLD that the
 * user may still need once the toast is gone; it stays toast-only when it
 * is a TRANSIENT PROGRESS PING whose result is already visible on screen.
 * Concretely:
 *
 *   persisted — anything that failed. A failure outlives its toast by
 *     definition: the user reads "Generation failed" in the eight seconds
 *     it is on screen, and then needs to know WHICH model, or WHICH job,
 *     or the full provider body, ten minutes later when they come back to
 *     the job. That is what `full_message` and the job snapshot are for.
 *
 *   toast-only — "Saved", "Deleted 3 documents", "Job status updated:
 *     Ready", "AI is rate-limited — added to queue", "Backup complete".
 *     These describe a state the page already reflects. Recording them
 *     would turn the center into an event log of things that worked, and
 *     a log full of successes is a log nobody ever opens — which then
 *     makes the one row that mattered (the failure) easy to miss.
 *
 * The record is written independently of whether a toast survives. That is
 * deliberate: the toast overlay is allowed to collapse ten identical
 * sentences because the overlay's job is to be glanceable, and the centre
 * would not be glanceable if it did the same.
 *
 * `notify` runs FIRST here, and it is not an ordering claim about which
 * layer should collapse — it is that the toast is the transient half and
 * this is the durable one, so the transient one is allowed to finish before
 * the durable one starts. Both layers collapse a repeat; they collapse over
 * different windows, and the reason is in `DEDUPE_WINDOW_MS` in
 * electron/notifications.ts: the record's window is the SHORTER of the two,
 * so the centre never knows about fewer things than the overlay did.
 */
export function reportFailure(report: FailureReport): void {
  const type = report.type ?? 'error'
  notify(report.message, type, report.ttl)
  void recordNotification({
    type,
    source: report.source,
    message: report.message,
    fullMessage: report.fullMessage ?? report.message,
    job: report.job,
    groupKey: report.groupKey,
  })
}
