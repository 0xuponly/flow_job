/**
 * The Queue panel's view of "no AI provider is available".
 *
 * The shape here mirrors `AIQueueBlockedState` in electron/aiQueue.ts,
 * which is where the answer is computed. It is declared separately rather
 * than imported because that is a main-process module: the renderer gets
 * the state over IPC and cannot reach the model-health map behind it.
 *
 * Nothing in this file may name a model, a provider, an HTTP status or a
 * cooldown. The app's rule is that internal diagnostics stay in the logs
 * and the user is shown a plain outcome — the whole point of this state
 * is that somebody could tell, at a glance, that nothing was going to run
 * and why, without the panel becoming a second log viewer. The logs keep
 * the detail (`ai.log`: which model, which status, how long).
 */
export interface AIQueueBlockedState {
  /** No eligible model is available, so no request can be made at all. */
  blocked: boolean
  /** Epoch ms the first provider frees up, uncapped. */
  providerFreeAt: number | null
  /** Epoch ms the queue will actually wake, i.e. the same time clamped. */
  retryAt: number | null
  /** Rows parked on the provider clock right now. */
  waitingRows: number
  /** Their ids, so a parked row can be told from one merely queued. */
  blockedRowIds: number[]
}

/** The blocked state with everything optional, for a panel with no data yet. */
export const NOT_BLOCKED: AIQueueBlockedState = {
  blocked: false,
  providerFreeAt: null,
  retryAt: null,
  waitingRows: 0,
  blockedRowIds: []
}

/** Seconds → "45s" / "12m" / "3h", matching the queue row's own wording. */
function formatWait(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.ceil(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  return `${Math.ceil(minutes / 60)}h`
}

/**
 * The banner copy, or null when there is nothing to say.
 *
 * "best effort" is deliberate and matches the queue rows' existing
 * wording: the app re-checks on this schedule, but only while it is
 * running and only for rows still in the store. A promise ("it will run
 * at 14:05") reads as a lie the first time a user clears the queue in
 * between, and the schedule is the useful part.
 */
export function blockedBannerLines(
  state: AIQueueBlockedState | null | undefined,
  queuedCount: number,
  now: number = Date.now()
): { headline: string; detail: string } | null {
  if (!state?.blocked) return null
  const tasks = queuedCount === 1 ? '1 queued task is' : `${queuedCount} queued tasks are`
  const retryAt = state.retryAt
  const wait = retryAt !== null && retryAt > now ? ` Checking again in ${formatWait(retryAt - now)} (best effort).` : ''
  return {
    headline: 'No AI provider is available right now, so the queue is waiting.',
    detail: queuedCount === 0
      ? `Tasks will run once a provider is available.${wait}`
      : `${tasks} waiting.${wait}`
  }
}

/** The status text for a row parked on the provider clock. */
export const BLOCKED_ROW_STATUS = 'Waiting for an AI provider'

/**
 * The status text for one row: its own state, unless it is parked on the
 * provider clock.
 *
 * The distinction is the point. A row waiting its turn behind other work
 * and a row that cannot run at all are both `pending` with a future
 * `nextRetryAt`, and the panel used to render them identically — which is
 * how a queue that could not run a single task in 20 hours looked like an
 * ordinary backlog (2026-10-02).
 */
export function queueRowStatusText(
  item: { id: number },
  state: AIQueueBlockedState | null | undefined,
  fallback: () => string
): string {
  if (state?.blocked && state.blockedRowIds.includes(item.id)) return BLOCKED_ROW_STATUS
  return fallback()
}