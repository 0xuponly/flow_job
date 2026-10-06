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
import type { AIQueueItem } from './types'

export interface AIQueueBlockedState {
  /** No eligible model is available, so no request can be made at all. */
  blocked: boolean
  /** Epoch ms the first provider frees up, uncapped. */
  providerFreeAt: number | null
  /** Epoch ms the queue will actually wake, i.e. the same time clamped. */
  retryAt: number | null
  /**
   * Rows parked on the provider clock right now — the banner's count.
   *
   * Computed by the main process from the rows it has parked, so it is
   * the number of rows that cannot run, and not the number of rows in
   * the queue. `blockedRowIds` is the same set by id; this is its length.
   *
   * One limit worth stating rather than discovering: it counts COOLDOWN
   * parks, which is what `aiQueueBlockedState` filters on. A row parked
   * by a provider's spent daily call cap carries `parkedReason` and not
   * `blockedSince`, so it is in neither list until a pass parks it on the
   * provider clock too. Both are real held rows; this field does not
   * claim to be every one of them.
   */
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

/** The banner's first line. It says the app-wide fact, not the count. */
const BLOCKED_HEADLINE = 'No AI provider is available right now, so the queue is waiting.'

/**
 * The banner copy, or null when there is nothing to say.
 *
 * THE COUNT IS THE ONE THE STATE MEASURED, never the queue length, and
 * that is the whole point of this function's second clause.
 *
 * `queuedRows` is how many rows the panel is showing. It is a different
 * number from the one this banner is about — "how many are stuck" — and
 * the panel used to pass it as the count anyway, so a queue holding 241
 * tasks with one of them on the provider clock rendered "241 queued
 * tasks are waiting" above a list of 240 rows that were not waiting on
 * anything. Measured over a real 6h44m window on 2026-10-05 (241 rows,
 * 36 passes, 8,061 row-level refusals) the true waiting count moved
 * between 1 and 176 while the queue length sat at 241: the two numbers
 * agreed at no point in that window. They are not two estimates of one
 * quantity, they are two quantities, and only one of them answers the
 * question the sentence asks.
 *
 * So the count comes from `state.waitingRows`, which the main process
 * computes from the rows it has actually parked (`parkBlockedRow` writes
 * `blockedSince`; `aiQueueBlockedState` counts the pending rows that
 * carry it) and ships over IPC for exactly this. It is a measured value
 * or it is absent — nothing here invents one, and the panel never shows
 * a number this module did not receive.
 *
 * `queuedRows` still earns its place, for the case it is the only honest
 * answer to: a queue with nothing in it. The state is about the provider,
 * not about the queue, and "no provider is available" is exactly what the
 * user about to press Generate needs to hear, so the banner renders above
 * "No queued tasks." — where a count would be counting nothing. That
 * branch is taken on the panel's own list, not on the state's, so a state
 * that arrived a moment before the list cannot put a count on an empty
 * panel.
 *
 * "best effort" is deliberate and matches the queue rows' existing
 * wording: the app re-checks on this schedule, but only while it is
 * running and only for rows still in the store. A promise ("it will run
 * at 14:05") reads as a lie the first time a user clears the queue in
 * between, and the schedule is the useful part.
 */
export function blockedBannerLines(
  state: AIQueueBlockedState | null | undefined,
  queuedRows: number,
  now: number = Date.now()
): { headline: string; detail: string } | null {
  if (!state?.blocked) return null
  const retryAt = state.retryAt
  const wait = retryAt !== null && retryAt > now ? ` Checking again in ${formatWait(retryAt - now)} (best effort).` : ''
  if (queuedRows === 0) {
    return {
      headline: BLOCKED_HEADLINE,
      detail: `Tasks will run once a provider is available.${wait}`
    }
  }
  // A count is only printed when it is one. `aiQueueBlockedState` counts
  // rows, so a whole number is the only shape a real count has; anything
  // else — negative, fractional, NaN — means the caller is holding
  // something that is not a measurement, and there is no number this
  // function is entitled to derive from it. Rounding 1.5 down to 1 would
  // be the worst of the three: it would look measured, and it would be a
  // claim about a number of rows that cannot exist.
  const held = Number.isInteger(state.waitingRows) && state.waitingRows > 0 ? state.waitingRows : 0
  if (held === 0) {
    // Not a branch on the app being blocked — the headline already says
    // that — but on the count. It is a real state: every eligible model
    // is cooling, and no row has been parked on it yet, because the
    // rows that are due have not come due or were not claimed. The
    // alternative was "0 queued tasks are waiting", which reads as a
    // measurement of nothing rather than as an answer.
    //
    // The words are the row label's (`BLOCKED_ROW_STATUS`), because this
    // is the same fact at a different scale: the banner and the rows say
    // one thing about a provider, in one vocabulary.
    return {
      headline: BLOCKED_HEADLINE,
      detail: `No queued task is waiting for an AI provider right now.${wait}`
    }
  }
  const tasks = held === 1 ? '1 queued task is' : `${held} queued tasks are`
  return {
    headline: BLOCKED_HEADLINE,
    detail: `${tasks} waiting.${wait}`
  }
}

/** The status text for a row parked on the provider clock. */
export const BLOCKED_ROW_STATUS = 'Waiting for an AI provider'

/**
 * What a row says about itself, when a provider rather than the user's own
 * turn is what is holding it.
 *
 * Declared here rather than imported, and the reason is worth stating
 * because it is a gap rather than a convention: the renderer's `AIQueueItem`
 * in src/types.ts mirrors the main-process row and does not declare
 * `blockedSince`, although the main process declares it, documents it as the
 * thing the Queue panel renders a distinct state from, and ships it —
 * `listQueueInPickOrder` spreads the whole stored row into the view the
 * panel is given, so the field arrives over IPC with `aiQueue:list`. So this
 * is a declaration the renderer is missing, not a field the renderer lacks,
 * and both halves are optional so any `QueueItemView` still satisfies this
 * shape without a cast.
 *
 * The cost of leaving it undeclared there is that the dependency is
 * invisible: change the spread to an explicit projection and every row's
 * `blockedSince` silently becomes undefined, this function falls back to the
 * app-wide list, and the panel goes back to describing parked rows as
 * `Pending` with no test failing and nothing on screen saying so. Declaring
 * it in src/types.ts next to the mirror it belongs to is the fix, and that
 * file is not this lane's to edit.
 */
export interface ProviderHeldRow {
  /**
   * Epoch ms this row was parked because no provider was available, absent
   * when it was not.
   *
   * Written with `status: 'pending'` by the same patch, and cleared by the
   * writes that claim the row for a run, that revive it, and that hand it
   * back to the user on Retry — so it means "the provider clock, and nobody
   * has taken this row since".
   */
  blockedSince?: number
  /**
   * Why a `pending` row is not running, when the reason is a provider's
   * spent call budget rather than the provider being unavailable.
   */
  parkedReason?: 'provider_cap'
}

/**
 * The status text for one row: its own state, unless a provider is holding
 * it.
 *
 * The distinction is the point. A row waiting its turn behind other work
 * and a row that cannot run at all are both `pending` with a future
 * `nextRetryAt`, and the panel used to render them identically — which is
 * how a queue that could not run a single task in 20 hours looked like an
 * ordinary backlog (2026-10-02).
 *
 * KEYED ON THE ROW FIRST, because the label is a property of the row and the
 * state is a property of the instant.
 *
 * `blockedSince` is the row's own record of the park: written by
 * `parkBlockedRow` in the same patch that sets `status: 'pending'`, and
 * cleared by the writes that claim the row, revive it, or hand it back to
 * the user on Retry. So between a park and the next claim, "this row is on
 * the provider clock" is a fact about the row and needs no corroboration
 * from anywhere else.
 *
 * The app-wide list was the only source before, and it is momentary by
 * construction: `aiQueueBlockedState` fills `blockedRowIds` only while
 * `providerAvailability()` is blocked, i.e. while every eligible model
 * happens to be cooling at this instant. A cooldown lapses, the app-wide
 * flag clears, the row's park does not — and the row fell through to
 * whatever a never-attempted `pending` row renders, which is `Pending`. So
 * the exact word a row waiting its turn renders was also what a row that
 * could not run rendered, and it took one lapsing cooldown to swap them. The
 * banner's count has the same lifetime by construction, which is why
 * `waitingRows` can read low against rows this function still knows are
 * held: the count is what is held RIGHT NOW, these labels are what the row
 * carries until somebody claims it.
 *
 * `status` is the row's own past rather than its future, and it gets the
 * first refusal: a row the app is working on right now, a row that failed,
 * and a row a crash left mid-task each have their own wording in
 * `queueItemStatusText`, and none of them is "waiting for an AI provider".
 * The store cannot produce a `processing` row carrying `blockedSince` — the
 * claim writes `status: 'processing'` and clears the mark in one patch — so
 * this is not papering over a reachable state. It is what makes the rule
 * total over the item shape: a row that is being worked on, or that failed,
 * keeps its own account of itself whatever any list says about it, and the
 * previous version would have let an id list talk it out of both. A row with
 * no `status` at all is not second-guessed, because a caller that hands over
 * a bare `{ id }` has told this function nothing about the row beyond its
 * id — which is what the app-wide list is for.
 *
 * The app-wide list is still consulted, second. It is the shipped answer and
 * the only one available to a caller holding a row with no `blockedSince` of
 * its own, so removing it would take the panel's coverage away from rows the
 * row-level rule cannot see, for no gain: the two can only disagree about a
 * row whose mark has gone missing.
 */
export function queueRowStatusText(
  item: { id: number; status?: AIQueueItem['status'] } & ProviderHeldRow,
  state: AIQueueBlockedState | null | undefined,
  fallback: () => string
): string {
  // A row that is running, that failed, or that a crash left mid-task.
  // `status: 'pending'` is what both parks leave behind, so this is the one
  // status in which either of the two marks below means anything at all.
  if (item.status !== undefined && item.status !== 'pending') return fallback()
  // A spent call cap keeps its own wording, and this is the clause that
  // stops the label alternating.
  //
  // The two parks are different refusals and they do not exclude each other.
  // `parkOnProviderCap` writes `parkedReason` and no `blockedSince`;
  // `parkBlockedRow` writes `blockedSince` and leaves `parkedReason` alone;
  // the claim clears both in one patch. So a row parked on a spent budget
  // that comes due while every model is cooling ends up carrying BOTH, and
  // which one the panel showed depended on which field the renderer checked
  // first — the same row read as "Paused — provider at its call cap, checks
  // again in 10m" on one pass and "Waiting for an AI provider" on the next.
  // The overlap is the normal case rather than an edge case: over the 6h44m
  // window measured on 2026-10-05, 49 of the 51 rows the cap refused were
  // also in the cooldown-park log.
  //
  // The cap wins, for three reasons that are all about which half of the
  // story is the row's to tell:
  //
  // - it is the condition that outlasts a re-probe tick. The cooldown clears
  //   in minutes; a spent daily budget clears when the window slides, hours
  //   from now. Ten minutes after a cap row is re-probed it is still on the
  //   cap, so that is the label that will still be true.
  // - the panel already prints the provider's own message about the cap on
  //   the line under this one (`lastError`, for `parkedReason` rows), so
  //   labelling it "waiting for an AI provider" contradicted the text
  //   directly beneath it.
  // - the app-wide cooldown is stated once, above the rows, which is the
  //   whole reason the banner exists. Repeating it per row is what it was
  //   built to stop.
  if (item.parkedReason === 'provider_cap') return fallback()
  // The row's own park, which is the same condition `aiQueueBlockedState`
  // filters on to build `blockedRowIds` — read here off the row rather than
  // off the state, because it survives the flag.
  if (item.blockedSince !== undefined) return BLOCKED_ROW_STATUS
  if (state?.blocked && state.blockedRowIds.includes(item.id)) return BLOCKED_ROW_STATUS
  return fallback()
}