/**
 * What a queue row's own marks say is holding it. One definition.
 *
 * This module exists because two places used to answer "is this row
 * waiting?" independently, and they disagreed. `aiQueueBlockedState` in
 * the main process counted `status === 'pending' && blockedSince !==
 * undefined`; `queueRowStatusText` in the renderer checked `parkedReason
 * === 'provider_cap'` FIRST and handed those same rows to the cap's own
 * wording. A row can carry both marks — the cap park writes
 * `parkedReason` and the blocked-branch park writes `blockedSince`
 * without clearing it, so a cap row that comes due while every model is
 * cooling ends up with both — and in that state the banner printed "4
 * queued tasks are waiting" directly above a list holding one "Waiting
 * for an AI provider" and three "Paused — provider at its call cap".
 *
 * That is the qt-r3 rule, "the badge must agree with the entries it
 * expands", broken numerically (4 against 1) and semantically (three of
 * the four were attributed to a provider being unavailable, which is the
 * opposite of what a spent budget means). It survived 2,189 green tests
 * because the fixture that compared a count to a label set had no
 * doubly-marked row in it.
 *
 * So the count and the label now both call these three functions and
 * neither re-derives the rule. A third reader that needs the same
 * answer — `queueStalls.ts`'s stall record — calls them as well, so
 * there is one place to change when a fourth kind of park arrives.
 *
 * What is deliberately NOT here: a clock, a model, a provider, or
 * anything read off the network. Every answer below comes off the row,
 * so a label derived from it cannot go stale between a render and a
 * click, cannot be aged out by a lapsing cooldown, and a count derived
 * from it is a measurement of rows rather than of an instant.
 */

/**
 * Why a row is not running, when a provider rather than the user's own
 * turn is what is holding it.
 *
 * - `provider_cooldown` — parked because no provider could be reached.
 *   The one thing a banner may call "waiting".
 * - `provider_cap` — parked because a provider's budget was spent.
 *   Not an outage, and not the same failure to a reader.
 * - `provider_cap_and_cooldown` — a cap park with a cooldown park
 *   stacked on top of it. The overlap is the normal case rather than an
 *   edge case: over the 6h44m window measured on 2026-10-05, 49 of the
 *   51 rows the cap refused were also in the cooldown-park log.
 */
export type QueueWaitCause =
  | 'provider_cooldown'
  | 'provider_cap'
  | 'provider_cap_and_cooldown'

/**
 * The fields of a queue row that say a provider is holding it, and the
 * `status` that decides whether they can mean anything.
 *
 * Declared structurally rather than imported so this module has no
 * dependencies at all — it is read by the main process (which has
 * `AIQueueItem`), by the renderer (whose `QueueItemView` mirror does NOT
 * declare `blockedSince`, see `ProviderHeldRow` in src/queueBlocked.ts)
 * and by the stall record. A structural shape is what lets all three
 * pass their own row type without a cast.
 */
export interface QueueWaitMarks {
  /**
   * `pending` is the only status either park leaves behind, so it is the
   * only one a park mark can mean anything about.
   *
   * Undefined is treated as `pending`: a caller holding a bare `{ id }`
   * has said nothing about the row beyond its id, and second-guessing it
   * would invent a status the caller never claimed.
   */
  status?: string
  /**
   * Epoch ms this row was parked because no provider was available,
   * absent when it was not.
   *
   * Written with `status: 'pending'` by `parkBlockedRow`, and cleared by
   * the write that claims the row for a run, by the automatic revival,
   * by `revivePatch` (Retry, and `enqueue`'s duplicate path), and by the
   * startup cooldown migration in `electron/database.ts`. So it means
   * "the provider clock, and nobody has taken this row since" — and NOT
   * "nothing clears the mark but a claim", which is the version that
   * overstated the set of clearers by one.
   */
  blockedSince?: number
  /**
   * Why a `pending` row is not running, when the reason is a provider's
   * spent call budget rather than the provider being unavailable.
   *
   * The mark's lifetime is NOT the mirror image of `blockedSince`'s, and the
   * difference is load-bearing here. The claim clears it (deliberately: the
   * row is being run again, so it is not on a spent budget any more), and
   * `revivePatch` does not — Retry hands the row back to the queue without
   * touching `parkedReason`. So a row a person retried can come back marked
   * as cap-parked while it is due to run immediately, and this predicate
   * will call that row cap-held. The panel shows the consequence as
   * "Paused — provider at its call cap, due now" on a row that is due now.
   *
   * It is latent rather than live: `canRetry` is `failed || stranded`, so a
   * `pending` cap row has no Retry button, and every path to `failed` goes
   * through the claim, which clears the mark. Clearing it in `revivePatch`
   * as well is the one-line fix, and it belongs to a lane that changes queue
   * writes rather than to this one.
   */
  parkedReason?: 'provider_cap'
}

/**
 * Is this row a shape a park mark can mean anything about at all?
 *
 * A row the app is working on, a row that failed, and a row a crash
 * left mid-task each keep their own wording, and none of them is
 * "waiting for an AI provider". The store cannot produce a `processing`
 * row carrying `blockedSince` — the claim writes `status: 'processing'`
 * and clears the mark in one patch — so this is not papering over a
 * reachable state; it is what makes the rule total over the item shape,
 * so that no caller has to remember this clause for itself.
 */
export function canWaitForAProvider(row: QueueWaitMarks): boolean {
  return row.status === undefined || row.status === 'pending'
}

/**
 * What is holding this row, read off the row alone. Null when a provider
 * is not.
 *
 * Total over the row shape: every mark combination has one answer, so a
 * caller cannot pick up a half of the rule and leave the other half out.
 */
export function queueWaitCause(row: QueueWaitMarks): QueueWaitCause | null {
  if (!canWaitForAProvider(row)) return null
  const capped = row.parkedReason === 'provider_cap'
  const cooling = row.blockedSince !== undefined
  if (capped && cooling) return 'provider_cap_and_cooldown'
  if (capped) return 'provider_cap'
  if (cooling) return 'provider_cooldown'
  return null
}

/**
 * Is this row waiting on a provider BECOMING AVAILABLE — the only kind
 * of wait a banner may attribute to an outage?
 *
 * Deliberately narrow. A row the provider refused for its own reasons is
 * held by its own budget, and per `electron/queueStalls.ts` the provider
 * would answer RIGHT NOW in that case, because the budget is the only
 * thing stopping the row. Counting one as waiting-for-a-provider spends
 * the sentence's truth to make the number bigger, which is the trade
 * this predicate exists to refuse.
 *
 * This is what `aiQueueBlockedState` counts, and it is exactly the set
 * `queueRowStatusText` labels "Waiting for an AI provider" — which is
 * the property the banner's number rests on.
 */
export function waitingOnAvailableProvider(row: QueueWaitMarks): boolean {
  return queueWaitCause(row) === 'provider_cooldown'
}

/**
 * Is this row held by a spent call budget, whether or not a cooldown is
 * stacked on top of it?
 *
 * The second half is the whole point. A doubly-marked row's label is the
 * cap's (`dcde88b`: the cap wins, so the wording stops alternating and
 * stops contradicting the provider's own message printed under it), so a
 * count that only matched the single-mark shape would put those rows in
 * no bucket at all — which is how a banner ends up saying nothing is
 * waiting directly above five rows that are visibly not running.
 */
export function pausedOnCallCap(row: QueueWaitMarks): boolean {
  const cause = queueWaitCause(row)
  return cause === 'provider_cap' || cause === 'provider_cap_and_cooldown'
}