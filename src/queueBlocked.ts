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
// The ONE definition of what is holding a row. The counts this file prints
// and the labels it derives are both answers to the same question, so both
// are asked here rather than in each place — see the module for the state
// that desynchronised them when each had its own copy.
import {
  canWaitForAProvider,
  queueWaitCause,
  type QueueWaitMarks
} from './queueWaiting'

export interface AIQueueBlockedState {
  /** No eligible model is available, so no request can be made at all. */
  blocked: boolean
  /** Epoch ms the first provider frees up, uncapped. */
  providerFreeAt: number | null
  /** Epoch ms the queue will actually wake, i.e. the same time clamped. */
  retryAt: number | null
  /**
   * Rows parked on the provider clock and nothing else — the banner's
   * count, and by construction exactly the rows `queueRowStatusText` labels
   * as waiting for a provider: both are the one shared predicate,
   * `waitingOnAvailableProvider`, over the same rows.
   *
   * A row parked by a spent call budget is NOT in it, even when a cooldown
   * park is stacked on top of that one (the normal case: 49 of 51 rows over
   * the measured window). The provider would answer right now in that state
   * — the budget is the only thing stopping the row — so it is counted and
   * reported under `pausedCapRows` instead.
   */
  waitingRows: number
  /** Their ids, so a parked row can be told from one merely queued. */
  blockedRowIds: number[]
  /**
   * Rows held by a spent call cap, the cap-only ones and the doubly-marked
   * ones together — exactly the rows this panel labels with the cap's own
   * wording. Reported beside `waitingRows` rather than inside it so the
   * banner can say both things in a mixed state instead of one true
   * number above a list that says another.
   */
  pausedCapRows: number
}

/** The blocked state with everything optional, for a panel with no data yet. */
export const NOT_BLOCKED: AIQueueBlockedState = {
  blocked: false,
  providerFreeAt: null,
  retryAt: null,
  waitingRows: 0,
  blockedRowIds: [],
  pausedCapRows: 0
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
 * The banner's first line, and nothing but the app-wide fact.
 *
 * It used to end "so the queue is waiting", which is a claim about the
 * rows: it attributes the whole queue to the one cause the sentence names.
 * That is true when every stopped row is stopped by the same thing, and
 * false the moment a row is stopped by its own provider's spent budget —
 * in that state the provider would answer RIGHT NOW (see
 * `electron/queueStalls.ts`), so the outage is not why that row is
 * waiting. So the causal clause moved into the detail, which counts rows
 * by cause and says each cause out loud.
 */
const BLOCKED_HEADLINE = 'No AI provider is available right now.'

/** What a row held by an unavailable pool is waiting for. */
const WAITING_FOR_PROVIDER = 'waiting for an available AI provider'
/** What a row held by its own provider's spent budget is waiting for. */
const PAUSED_ON_CALL_CAP = "paused on a provider's daily call cap"

/** "1 queued task is" / "3 queued tasks are" — one form for both counts. */
function queuedTasks(count: number): string {
  return count === 1 ? '1 queued task is' : `${count} queued tasks are`
}

/**
 * The banner copy, or null when there is nothing to say.
 *
 * THE COUNT IS THE ONE THE STATE MEASURED, never the queue length, and
 * that is the whole point of `isEmptyQueue`.
 *
 * The panel's row count is how many rows it is showing. It is a
 * different number from the one this banner is about — "how many are
 * stuck" — and the panel used to pass it as the count anyway, so a queue
 * holding 241 tasks with one of them on the provider clock rendered "241
 * queued tasks are waiting" above a list of 240 rows that were not waiting
 * on anything. Measured over a real 6h44m window on 2026-10-05 (241 rows,
 * 36 passes, 8,061 row-level refusals) the true waiting count moved
 * between 1 and 176 while the queue length sat at 241: the two numbers
 * agreed at no point in that window. They are not two estimates of one
 * quantity, they are two quantities, and only one of them answers the
 * question the sentence asks.
 *
 * So the count comes from `state.waitingRows`, which the main process
 * computes from the rows it has actually parked and ships over IPC for
 * exactly this. It is a measured value or it is absent — nothing here
 * invents one, and the panel never shows a number this module did not
 * receive.
 *
 * AND IT IS THE NUMBER OF ROWS THE PANEL LABELS AS WAITING. That is not
 * a coincidence of two filters agreeing; it is one predicate
 * (`waitingOnAvailableProvider`, in src/queueWaiting.ts) behind both. The
 * previous version counted every `pending` row carrying `blockedSince`,
 * which includes rows also parked on a spent call cap, and then labelled
 * those same rows "Paused — provider at its call cap" directly underneath
 * — a banner that counted four rows while the list showed one. A count is
 * only a truthful claim about this panel if it is the count of the rows
 * the panel says the thing about.
 *
 * THE MIXED STATE IS SPLIT, not averaged. Rows held by an unavailable
 * pool and rows held by a spent budget are stopped for different
 * reasons, they clear on different clocks, and only one of them is fixed
 * by a provider coming back. One sentence cannot be true of both, and a
 * sentence that picked one of them would attribute rows to a cause that
 * is not holding them — which is the over-attribution that made the old
 * headline wrong. So the detail names both, with both numbers, whenever
 * both are non-zero. The two counts OVERLAP by design (a doubly-marked
 * row is counted under the cap, because that is the label it gets), so
 * they are two label sets rather than a partition: each number answers
 * "how many rows say this", never "how many rows are there".
 *
 * The cap clause names NO MOMENT. A spent daily budget frees on a rolling
 * 24h window, and the row's own provider message already carries the reset
 * time — so the banner cannot restate it without a second clock to go
 * stale. That matters most in the one case where a restated moment would
 * be actively false: a cap row that comes due while the pool is cooling
 * stacks a cooldown park on itself, and if the budget frees before the
 * provider does, anything of the form "the cap frees in 10m" is a lie the
 * moment after it was true. The only time on screen is `Checking again
 * in X`, which is the app's own re-probe — a schedule it keeps, bounded
 * by `PROVIDER_REPROBE_CAP_MS`, hedged as best effort, and printed with
 * the usual round-UP so it never under-promises.
 *
 * `isEmptyQueue` is the one thing the panel's own list is asked, and it
 * is a boolean rather than a count because that is the only use of it: the
 * state is about the provider, not about the queue, and "no provider is
 * available" is exactly what the user about to press Generate needs to
 * hear, so the banner renders above "No queued tasks." — where a count
 * would be counting nothing. Taken on the panel's own list, not on the
 * state's, so a state that arrived a moment before the list cannot put a
 * count on an empty panel. A bare number in this slot is what a future
 * caller will try to pass, and it is the mistake this function already
 * made once.
 */
export function blockedBannerLines(
  state: AIQueueBlockedState | null | undefined,
  isEmptyQueue: boolean,
  now: number = Date.now()
): { headline: string; detail: string } | null {
  if (!state?.blocked) return null
  const retryAt = state.retryAt
  const wait = retryAt !== null && retryAt > now ? ` Checking again in ${formatWait(retryAt - now)} (best effort).` : ''
  if (isEmptyQueue) {
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
  // claim about a number of rows that cannot exist. Both counts are read
  // this way: one trustworthy count is no reason to trust the other, and
  // a mixed sentence with an invented half is worse than neither.
  const held = Number.isInteger(state.waitingRows) && state.waitingRows > 0 ? state.waitingRows : 0
  const capped = Number.isInteger(state.pausedCapRows) && state.pausedCapRows > 0 ? state.pausedCapRows : 0
  // "Nothing is waiting" is a claim about the rows, so it is only made
  // when there is a cap clause to contradict it. Saying it above a list
  // of rows visibly not running on a provider is the one sentence in
  // this file the screen beneath it refutes.
  const waiting = held > 0
    ? `${queuedTasks(held)} ${WAITING_FOR_PROVIDER}`
    : `No queued task is ${WAITING_FOR_PROVIDER}`
  if (held === 0 && capped === 0) return { headline: BLOCKED_HEADLINE, detail: `${waiting}.${wait}` }
  if (held === 0) return { headline: BLOCKED_HEADLINE, detail: `${queuedTasks(capped)} ${PAUSED_ON_CALL_CAP}.${wait}` }
  if (capped === 0) return { headline: BLOCKED_HEADLINE, detail: `${waiting}.${wait}` }
  return {
    headline: BLOCKED_HEADLINE,
    detail: `${waiting}, and ${queuedTasks(capped)} ${PAUSED_ON_CALL_CAP}.${wait}`
  }
}

/** The status text for a row parked on the provider clock. */
export const BLOCKED_ROW_STATUS = 'Waiting for an AI provider'

/**
 * What a row says about itself, when a provider rather than the user's own
 * turn is what is holding it.
 *
 * The declaration of the two marks, kept here because the renderer's
 * `AIQueueItem` in src/types.ts mirrors the main-process row and does not
 * declare `blockedSince`, although the main process declares it, documents
 * it as the thing the Queue panel renders a distinct state from, and ships
 * it — `listQueueInPickOrder` spreads the whole stored row into the view the
 * panel is given, so the field arrives over IPC with `aiQueue:list`. So this
 * is a declaration the renderer is missing, not a field the renderer lacks,
 * and it is an alias of the shared predicate's shape rather than a second
 * one, because a second declaration is a second shape to keep in step.
 *
 * The cost of leaving the field undeclared in src/types.ts is that the
 * dependency is invisible: change the spread to an explicit projection and
 * every row's `blockedSince` silently becomes undefined, this function falls
 * back to the app-wide list, and the panel goes back to describing parked
 * rows as `Pending` with no test failing and nothing on screen saying so.
 * Declaring it in src/types.ts next to the mirror it belongs to is the fix,
 * and that file is not this lane's to edit.
 */
export type ProviderHeldRow = QueueWaitMarks

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
 * state is a property of the instant. The rule itself is `queueWaitCause`,
 * shared with the count the banner prints — one predicate, two readers, and
 * no way for a fourth kind of park to make them disagree.
 *
 * `blockedSince` is the row's own record of the park: written by
 * `parkBlockedRow` in the same patch that sets `status: 'pending'`, and
 * cleared by the write that claims the row for a run, by the automatic
 * revival, by `revivePatch` (Retry, and `enqueue`'s duplicate path), and by
 * the startup cooldown migration in `electron/database.ts` — four writers,
 * not one, which is why the invariant is stated as a list. So between a
 * park and the next of those, "this row is on the provider clock" is a fact
 * about the row and needs no corroboration from anywhere else.
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
 * row whose mark has gone missing. It cannot disagree about a row the count
 * included, because it is built from the same predicate — so a row this
 * function marks from the list is a row the banner counted.
 */
export function queueRowStatusText(
  item: { id: number; status?: AIQueueItem['status'] } & ProviderHeldRow,
  state: AIQueueBlockedState | null | undefined,
  fallback: () => string
): string {
  // A row that is running, that failed, or that a crash left mid-task.
  // `status: 'pending'` is what both parks leave behind, so this is the one
  // status in which either of the two marks below means anything at all.
  if (!canWaitForAProvider(item)) return fallback()
  // ONE cause per row, so the label below and the banner's count are
  // answers to the same question. `provider_cap_and_cooldown` is the
  // doubly-marked row, and the cap's wording is what it gets, for three
  // reasons that are all about which half of the story is the row's to
  // tell:
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
  //
  // Before the two places shared this predicate, the count took the
  // cooldown branch of a doubly-marked row and the label took the cap
  // branch, on one screen: the banner said four rows were waiting and the
  // list showed one. One cause cannot be both.
  const cause = queueWaitCause(item)
  if (cause === 'provider_cooldown') return BLOCKED_ROW_STATUS
  if (cause !== null) return fallback()
  // No mark of its own: the app-wide list is the only thing that can answer,
  // and it holds ids the same predicate chose.
  if (state?.blocked && state.blockedRowIds.includes(item.id)) return BLOCKED_ROW_STATUS
  return fallback()
}