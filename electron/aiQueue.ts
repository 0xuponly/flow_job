import { getAIQueue, updateAIQueueItem, removeAIQueueItem, addAIQueueItem, clearAIQueue, getDocument, getJob, getSettings, listJobDocuments, getDocumentAutoRegenAttempts, bumpDocumentAutoRegenAttempts, setDocumentContent, writeTailorTimingFields, recomputeJobStatusFromDocs } from './database'
import { log } from './logger'
import { withAiOperation } from './ai'
// ONE import from './ai', deliberately: the two "don't charge an attempt for
// a condition that made no request" mechanisms are siblings, so the module
// that has to tell them apart needs both of their types and both of their
// clocks in the same scope.
import { tailorDocument, regenerateSection, verifyDocumentContent, nextProviderCapFreeAt, ProviderCapError, ProviderCooldownError, providerAvailability, RateLimitError, type AiCallOptions } from './ai'
import { PROVIDERS_COOLING_DOWN_MESSAGE } from './cooldownBlock'
import { reportStalledQueue } from './queueStalls'
// The one definition of "what is holding this row", shared with the panel's
// row labels so the banner's count cannot drift from the words under it.
import { pausedOnCallCap, waitingOnAvailableProvider } from '../src/queueWaiting'
import type { AIQueueItem, Job, QueueItemView } from './types'
import {
  AUTO_REGEN_MAX,
  AUTO_REVIVE_COOLDOWN_MS,
  AUTO_REVIVE_MAX,
  PASSING_REVIEW_SCORE,
  RATE_LIMIT_ATTEMPTS,
  SCORE_FIT_ATTEMPTS
} from './types'

function backoffMs(item: AIQueueItem): number {
  // exponential backoff: 30s, 60s, 2m, 4m, 8m, 16s, 30m cap
  const base = 30000
  const max = 1800000
  return Math.min(base * Math.pow(2, item.attempts), max)
}

/**
 * Park a row whose provider is out of call budget, without spending
 * anything on it.
 *
 * A `ProviderCapError` is not a failure, it is a full stop sign: the app
 * decided this work on its own, the credential it was going to pay for has
 * no allowance left in this rolling 24h window, and the window frees on a
 * schedule `nextProviderCapFreeAt` already knows. So the row is put back at
 * the front of the queue — `pending`, with the provider's own message on it —
 * and is neither counted as an attempt nor charged a revival.
 *
 * WHY THE OLD LADDER WAS WRONG FOR IT. A rate limit clears in a minute, so
 * ten attempts over ~2h33m of backoff and three revivals four hours apart is
 * the right budget for one. A cap clears in up to 24h, and the same ladder
 * spent all of it and then declared the row terminally `failed` at 22.07h
 * into the window — with the provider still capped and ~1.9h of budget left
 * to free. Work the app had decided to do on its own was destroyed by a
 * condition that resolves on its own, and the four automated lanes all did
 * it. More retries would not have been the fix either: the finding is that
 * this is a DIFFERENT KIND of limit, so it gets its own treatment rather
 * than a bigger allowance from the wrong one.
 *
 * WHY IT RE-CHECKS SO OFTEN. `nextRetryAt` is the earlier of the ordinary
 * backoff and the moment the earliest capped provider frees, so the row never
 * sleeps past the budget and never idles for longer than one retry tick. That
 * costs a claim and a re-park every tick, which is exactly what a row in an
 * ordinary rate-limit backoff already costs, and it buys the thing the user
 * actually notices: adding a key, switching provider, or raising the cap
 * moves the queue within one tick instead of up to a day later. Nothing here
 * re-checks the cap on its own — the row simply asks again.
 *
 * `attempts` and `autoRevives` are deliberately left untouched, which is what
 * makes this free: the row can be refused a hundred times and still have its
 * whole budget when the provider finally answers.
 */
function parkOnProviderCap(item: AIQueueItem, msg: string): void {
  const freeAt = nextProviderCapFreeAt()
  const wake = Date.now() + backoffMs(item)
  // `freeAt` is null only if no provider is capped any more, which is the
  // moment this row should be running rather than waiting — so the backoff
  // stands alone. The floor keeps a freeAt in the past from parking the row
  // in a loop it can never leave.
  const nextRetryAt = freeAt === null
    ? wake
    : Math.min(wake, Math.max(freeAt, Date.now()))
  updateAIQueueItem(item.id, {
    status: 'pending',
    lastError: msg,
    nextRetryAt,
    parkedReason: 'provider_cap'
  })
}

/**
 * Ceiling on how long a row parked by a provider block waits before the
 * queue looks again.
 *
 * Ten minutes, and specifically MAX_429_BACKOFF_MS — the longest
 * cooldown the 429 ladder itself ever hands out. So for the case that
 * actually caused the outage (every model answering 429) the cap never
 * binds and the queue wakes exactly when the provider said it would.
 *
 * It exists for the cases where the provider's own clock is a poor
 * answer: a circuit-broken model stays silent for
 * CIRCUIT_BREAKER_MS (1 hour), and a health map that keeps moving
 * would otherwise let a row sleep through an hour in which the user
 * fixed their model list and the queue never noticed. Waking every 10
 * minutes instead costs nothing — a blocked pass makes ZERO provider
 * requests, writes one log line, and updates a timestamp per due row —
 * and it bounds how long the app can look idle while work is
 * available.
 */
export const PROVIDER_REPROBE_CAP_MS = 10 * 60 * 1000

/**
 * Shortest wait a parked row ever gets, and the base of its own ladder.
 *
 * One poll interval (`startQueueProcessor`'s 30s default), so a row can
 * never be re-probed faster than the queue's own tick even if the health
 * map says "free in 1ms". Doubles per block up to the cap; see
 * `providerBlockedWaitMs`.
 */
const PROVIDER_REPROBE_FLOOR_MS = 30000

/**
 * How long until this row should be tried again, given that no provider
 * is available until `providerFreeAt`.
 *
 *   wait = min( max(providerWait, ownLadder), PROVIDER_REPROBE_CAP_MS )
 *
 * Three terms, each load-bearing:
 *
 *   providerWait  — the provider's own answer. Taking the max with it
 *                   is the point of the function: the queue must never
 *                   re-probe a provider that said "not for another 15
 *                   minutes", which is what the old item ladder did by
 *                   waking on its own 30s schedule regardless.
 *   ownLadder     — 30s, 60s, 2m, 4m … capped, escalated by how many
 *                   times this row has already been blocked. This is
 *                   what "remember that you were blocked" buys: a
 *                   health map whose `nextAvailableAt` keeps moving
 *                   forward (each free failure pushes the next one
 *                   later) cannot keep the row on the shortest
 *                   possible wake-up forever. It is cleared the moment
 *                   the row is claimed for real work, so a row that
 *                   finally runs starts fresh.
 *   CAP           — see PROVIDER_REPROBE_CAP_MS. Bounded both ways:
 *                   not earlier than the provider frees up, not later
 *                   than ten minutes from now.
 */
function providerBlockedWaitMs(providerFreeAt: number, now: number, blockedCount: number): number {
  const providerWait = Math.max(0, providerFreeAt - now)
  const ladder = Math.min(
    PROVIDER_REPROBE_FLOOR_MS * 2 ** Math.max(0, blockedCount - 1),
    PROVIDER_REPROBE_CAP_MS
  )
  return Math.min(Math.max(providerWait, ladder), PROVIDER_REPROBE_CAP_MS)
}

/**
 * Park ONE row on the provider's clock. Spent nothing, so nothing is
 * charged: `attempts` is left exactly as it was.
 *
 * The write is deliberately `status: 'pending'` + a future
 * `nextRetryAt` rather than a retry-ladder bump, because no attempt
 * happened. `blockedSince` / `blockedCount` are the row's own memory of
 * the block — what the panel renders, and what escalates the re-probe
 * above — and `lastError` records the plain reason so a row that
 * outlives the process still says why it is waiting.
 *
 * `autoRevives` is NOT touched. A block costs no attempt and so spends
 * none of the recovery budget; charging it here would make a queue that
 * sat through one provider outage come back with less runway than one
 * that never had to wait.
 */
function parkBlockedRow(item: AIQueueItem, providerFreeAt: number, now: number): number {
  const blockedCount = (item.blockedCount ?? 0) + 1
  const waitMs = providerBlockedWaitMs(providerFreeAt, now, blockedCount)
  updateAIQueueItem(item.id, {
    status: 'pending',
    nextRetryAt: now + waitMs,
    blockedSince: now,
    blockedCount,
    lastError: PROVIDERS_COOLING_DOWN_MESSAGE
  })
  return waitMs
}

/**
 * The app-wide blocked state the Queue panel renders.
 *
 * One state for the whole app rather than a per-row flag: "no provider
 * is available" is a property of the model pool, and every queued task
 * is waiting on the same door. It comes from `providerAvailability()`,
 * the same query the queue parks itself on, so the panel can never say
 * "waiting" while the queue is running, or the reverse.
 *
 * Carries no model names, statuses or health internals — see the copy
 * in QueuePanel. `blockedRowIds` is only the ids of rows the queue has
 * actually parked, so a row is distinguished from one merely queued
 * behind other work without exposing why any particular model is out.
 *
 * The two counts are TWO label sets, not a partition of the queue, and
 * that is deliberate. `waitingRows` is what the panel labels "Waiting
 * for an AI provider"; `pausedCapRows` is what it labels with the cap's
 * own wording. A row carrying both marks appears in the second and not
 * the first, because one label has to win — the cap's, which is the one
 * that survives the next re-probe and the one that agrees with the
 * provider's message printed under the row. So a doubly-marked row makes
 * the two counts overlap, and a reader adding them up sees more rows
 * than exist. Adding them up is the wrong reading: each number answers
 * "how many rows say this", which is the question the banner's number is
 * allowed to be about.
 *
 * Both counts are zero unless `blocked`, because both are about what a
 * blocked app is holding and the banner does not render otherwise. That
 * is also why they cannot be trusted as a description of the queue
 * outside a block — `waitingRows` in particular reads 0 with the pool
 * free even when rows are still parked on the clock, which is sound
 * because nothing on screen is making a claim at that moment.
 */
export interface AIQueueBlockedState {
  blocked: boolean
  /** Epoch ms the first eligible provider frees up, uncapped. */
  providerFreeAt: number | null
  /** Epoch ms the queue will actually wake, i.e. providerFreeAt clamped. */
  retryAt: number | null
  /**
   * Rows parked on the provider clock and nothing else — the banner's
   * count, and exactly the rows the panel labels as waiting for a
   * provider. A row parked on a spent call cap is NOT one of these even
   * when a cooldown park is stacked on top of it: the provider would
   * answer right now in that case, so calling it waiting for a provider
   * to become available is false. See `waitingOnAvailableProvider`.
   */
  waitingRows: number
  /** Their ids, so the panel can mark them apart from ordinary pending rows. */
  blockedRowIds: number[]
  /**
   * Rows held by a spent call cap, including the ones a cooldown is also
   * holding. Reported separately rather than folded into `waitingRows`
   * because the banner has to be honest about the two kinds of wait in
   * one state: counted as one, the banner says nothing is waiting above
   * a list of rows that are visibly not running.
   */
  pausedCapRows: number
}

export function aiQueueBlockedState(now: number = Date.now()): AIQueueBlockedState {
  const availability = providerAvailability(now)
  const held = availability.blocked ? getAIQueue() : []
  const freeAt = availability.nextAvailableAt
  // ONE definition of each, shared with the panel's row labels — see
  // src/queueWaiting.ts. Deriving them here separately from
  // `queueRowStatusText` is what let the banner's number and the rows it
  // expands disagree about a doubly-marked row.
  const waiting = held.filter(waitingOnAvailableProvider)
  const capped = held.filter(pausedOnCallCap)
  return {
    blocked: availability.blocked,
    providerFreeAt: freeAt,
    retryAt: freeAt === null ? null : now + providerBlockedWaitMs(freeAt, now, 1),
    waitingRows: waiting.length,
    blockedRowIds: waiting.map((q) => q.id),
    pausedCapRows: capped.length
  }
}

/**
 * P1.7 (BRIEF5 §3): pick-time priority key.
 *
 * Two tiers, management-specified:
 *   tier 0 — every `score_fit` item. Fit scoring has absolute
 *            priority: nothing is generated or reviewed until the
 *            scores the ordering depends on have landed.
 *   tier 1 — generation / review / regeneration items, ordered by the
 *            job's fit score DESC (a 95-fit job ships before a 60-fit
 *            job).
 *
 * The fit score is re-read from the job row on EVERY pick, never taken
 * from a frozen enqueue-time snapshot. That is what makes the ordering
 * live: if a job's fit rises from 60 to 95 after its item was queued,
 * the very next `processQueue()` sorts it ahead of the queued 60-item
 * with no re-enqueue and no priority field mutation.
 *
 * `fitScoreSnapshot` on the queue item is a display hint only — the
 * sort deliberately ignores it.
 *
 * Tie-break: ascending `id` (enqueue order), so a queue with equal fit
 * scores is processed deterministically across runs.
 *
 * A manual re-add promotes a row WITHIN its tier, never across it (see
 * `promotedAt` on AIQueueItem and the boost comparison in pickOrder).
 */
function priorityTier(type: AIQueueItem['type']): number {
  return type === 'score_fit' ? 0 : 1
}

/**
 * The full queue in the order the processor will actually pick it,
 * with each row carrying the job's title and company for display.
 *
 * `jobTitle` / `jobCompany` are a read-time view, not stored state: a
 * job can be renamed or deleted at any time, so persisting them onto
 * the queue row would leave the panel showing stale text forever. They
 * are resolved here, on every list, and are null for a deleted job.
 *
 * Returns pick order (score_fit first, then fit DESC) so the renderer's
 * Queue panel shows the true upcoming order rather than raw store
 * order — a high-fit generation item is picked ahead of a lower-fit
 * one, and in store order it would sit wherever it was enqueued.
 * Reuses `pickOrder` rather than re-deriving the sort in the renderer,
 * so the displayed order cannot drift from the executed order.
 *
 * Unlike `processQueue` this does not mutate any item's status: it is
 * a read-only view for display. Ordering re-reads `job.score` on each
 * call, so a fit that lands between polls is reflected on the next one.
 *
 * `stranded` is the third read-time field, and the only one that is not
 * a property of the job: it says the row is `processing` but no run in
 * THIS process owns it (see `isStranded`). The Queue panel offers Retry
 * for those, because the startup reclaim deliberately leaves a gated
 * automatic row exactly as the crash left it and nothing else in the
 * app would ever move it again.
 */
export function listQueueInPickOrder(): QueueItemView[] {
  const rows = pickOrder(getAIQueue())
  // One job lookup per distinct job, shared across the rows that
  // reference it (a generation item and its review items routinely do).
  const jobs = new Map<number, Job | null>()
  const jobFor = (jobId: number): Job | null => {
    if (!jobs.has(jobId)) jobs.set(jobId, getJob(jobId))
    return jobs.get(jobId) ?? null
  }
  return rows.map((item) => {
    const job = jobFor(item.jobId)
    return {
      ...item,
      jobTitle: job?.title ?? null,
      jobCompany: job?.company ?? null,
      stranded: isStranded(item)
    }
  })
}

/**
 * Is this `processing` row a crash leftover rather than a live run?
 *
 * `status: 'processing'` alone cannot tell the two apart. The processor
 * writes exactly one thing when it claims a row (`status`, alongside
 * `promotedAt`), and this item carries no `startedAt`, no heartbeat and
 * no lease — so at list time a row this process is working on and a row
 * a killed app left mid-generation are the same fields. The only
 * honest discriminator is memory: which rows were already `processing`
 * in the store before this process started.
 *
 * `strandedRowIds` is that answer, and it is deliberately not persisted.
 * It is a statement about THIS process rather than about the row, and it
 * dies with the process — which is what makes it safe: a row it names
 * can only be one this process has never claimed, so it cannot be a run
 * the user is watching right now.
 *
 * The set is keyed by id, and ids come from a monotonic `nextId` that
 * `clearAIQueue` deliberately does not rewind, so an id here can never
 * be handed out again to an unrelated row. (`clearAllData` DOES rewind
 * it — it replaces the store, empty queue and `nextId: 1` — and it cannot
 * reach into this set, which is memory. See `clearStranded`.)
 *
 * The last clause is the one that does not lean on any of that.
 * `strandedRowIds` is a claim about the past — "this id was already
 * `processing` when we looked" — and it is only as good as every path
 * that can add to it. `ownedByThisProcess` is a claim about the present:
 * this id is inside a `processItem` right now. So a row this process is
 * actively paying for cannot read `stranded: true` even if a future edit
 * gets its id into the set. A Retry button on a live row is the one
 * output of this whole mechanism that must never happen, so the flag is
 * the refusal of both stories rather than the acceptance of one.
 */
function isStranded(item: AIQueueItem): boolean {
  return item.status === 'processing' && strandedRowIds.has(item.id) && !ownedByThisProcess(item.id)
}

/**
 * Rows `processing` when this process started, i.e. the ones a crash
 * left behind. Populated once, by the startup reclaim, and pruned the
 * moment this process takes a row for itself.
 */
const strandedRowIds = new Set<number>()

/**
 * Rows this process is working on RIGHT NOW: added at the claim in
 * `processItem`, removed when that `processItem` settles.
 *
 * This is the other half of `strandedRowIds` and it is what makes the
 * stranded flag safe rather than merely plausible. `strandedRowIds` is a
 * record of something observed once, and every function that can write to
 * it is a place where a live run could get in. `runningRowIds` is the
 * direct answer to the question the panel is really asking — "is anyone
 * working on this row?" — and it is true by construction while the answer
 * is yes, whatever else has happened to the snapshot.
 *
 * Not persisted, same reasoning: it is a fact about this process's own
 * stack frames, and it is meaningful only while they are on the stack.
 * `stopQueueProcessor` deliberately does NOT clear it — stopping the
 * processor stops the polling, not the LLM call already in flight.
 */
const runningRowIds = new Set<number>()

/**
 * Is this process the one running the row, at this instant?
 *
 * The single predicate every caller asks, so "a row this process owns"
 * cannot mean one thing where the row is branded stranded and another
 * where it is requeued or retried. Consulted by `isStranded`, by the
 * startup snapshot, by the reclaim, and by `retryQueueItem`.
 */
function ownedByThisProcess(id: number): boolean {
  return runningRowIds.has(id)
}

/** Whether the startup snapshot has been taken yet. */
let startupStrandedNoted = false

/**
 * Record the rows that were `processing` before this process began.
 *
 * Runs on the FIRST `reclaimInterruptedItems` call — which is the one
 * `startQueueProcessor` makes, before the first pass — and only on that
 * one. That "once" is load-bearing: `reclaimInterruptedItems` scans for
 * rows left `processing`, and a row this process is actively working on
 * looks identical to one from a previous process. Snapshotting on every
 * call would eventually record a live run as stranded and put a Retry
 * button on a row the user is watching work; snapshotting at startup
 * cannot, because nothing in this process has claimed anything yet at
 * that moment.
 *
 * "Once" is not enough on its own, though, because `stopQueueProcessor`
 * deliberately forgets the snapshot — that is what lets a restarted
 * processor take a fresh one — and the pass that was mid-run when it was
 * stopped is still running. A restart with a pass in flight therefore
 * reaches this function with a live row in the store and no snapshot
 * taken, and the un-guarded version branded it stranded: the panel then
 * offered Retry on a task this process was still paying for, and pressing
 * it deleted the row (`retryQueueItem` refused nothing, and the in-flight
 * `processItem` removed the row on completion). The app never does that
 * today — `stopQueueProcessor` has one caller, immediately followed by
 * `app.quit()` — which is exactly why it survived review: unreachable
 * by call-graph luck is not unreachable.
 *
 * So the snapshot excludes rows this process owns, by name, and is not
 * refused wholesale while a pass is in flight. A blanket refusal would
 * also stop the real crash leftovers that are sitting in the same store
 * from ever being recorded, which trades a false positive for a false
 * negative: rows the app genuinely abandoned would lose the Retry button
 * and be dead ends again. The narrow question is the right one.
 *
 * It records EVERY other `processing` row, including the ones the reclaim
 * is about to requeue — those become `pending` in the same pass and
 * `isStranded` re-reads their status, so they never qualify.
 */
function noteStrandedRows(items: AIQueueItem[]): void {
  if (startupStrandedNoted) return
  startupStrandedNoted = true
  for (const item of items) {
    if (item.status === 'processing' && !ownedByThisProcess(item.id)) strandedRowIds.add(item.id)
  }
}

/**
 * Forget a row the processor has just taken: it is no longer a crash
 * leftover, it is a live run this process owns. Called at the claim.
 *
 * The invariant this maintains is "an id in `strandedRowIds` names a row
 * this process has never claimed", and the id is the one way that can go
 * stale on its own. `clearAllData` (Reset all data) replaces the store:
 * the queue is emptied and the shared `nextId` rewinds to 1, so an id the
 * set is still holding — it is memory, and a data reset cannot reach into
 * it — can be handed straight back out to an unrelated row. Claiming that
 * row drops the id again.
 *
 * The panel no longer rests on this alone (`isStranded` also refuses any
 * row this process owns), which is the point of having two: the flag that
 * decides whether a Retry button appears on a running task is not resting
 * on a bookkeeping detail elsewhere in the file.
 */
function clearStranded(id: number): void {
  strandedRowIds.delete(id)
}

function pickOrder(items: AIQueueItem[]): AIQueueItem[] {
  // Cache job lookups: several items can reference the same job (a
  // generation item and its review item), and getJob() re-reads the
  // decrypted store.
  const scoreCache = new Map<number, number | null>()
  const fitOf = (jobId: number): number | null => {
    if (scoreCache.has(jobId)) return scoreCache.get(jobId) ?? null
    const job = getJob(jobId)
    const score = job?.score ?? null
    scoreCache.set(jobId, score)
    return score
  }
  return [...items].sort((a, b) => {
    const tier = priorityTier(a.type) - priorityTier(b.type)
    if (tier !== 0) return tier
    // Inside a tier, a manual re-add wins. This is the "bump it to the
    // top" the user asked for, and it is deliberately scoped to the
    // tier: `score_fit` is tier 0 and the project rule is that fit
    // scoring outranks everything, so promoting a `verify` must not lift
    // it past a queued `score_fit`. Within the tier the boost also beats
    // the fit-score comparison below, because a user who just asked for
    // this item is a stronger signal than a heuristic that was sampled
    // when the item happened to be enqueued.
    //
    // Most recent promotion first: the newest request is the one the
    // user is waiting on. Equal timestamps (two re-adds inside the same
    // millisecond) fall through to the id tie-break, so the order stays
    // deterministic rather than depending on sort stability.
    const boostA = a.promotedAt ?? 0
    const boostB = b.promotedAt ?? 0
    if (boostA !== boostB) return boostB - boostA
    // Within a tier, higher fit first. A null score sorts last (the
    // job has not been scored yet, so it cannot be prioritised).
    const scoreA = fitOf(a.jobId)
    const scoreB = fitOf(b.jobId)
    if (scoreA === null && scoreB !== null) return 1
    if (scoreA !== null && scoreB === null) return -1
    if (scoreA !== null && scoreB !== null && scoreA !== scoreB) return scoreB - scoreA
    return a.id - b.id
  })
}

async function processItem(item: AIQueueItem, epoch: number): Promise<void> {
  // Every request this function makes is the app's own — with one exception,
  // and the exception is the entire subject of this block.
  //
  // THE ROW CARRIES TWO DIFFERENT FACTS ABOUT A PERSON.
  //
  //   `manualQueued`   PROVENANCE — "a person asked for this once". True for
  //                    the life of the row and correct to keep: revived
  //                    unattended, ungated by the `auto_queue_*` switches,
  //                    promoted, inherited by the children that finish it.
  //
  //   `userPresentAt`  PRESENCE — "a person's request is outstanding and
  //                    nobody has been handed an answer yet". Read HERE, and
  //                    only here.
  //
  // Presence is the only thing the cap's manual exemption is ever for:
  // refusing work a person pressed a button for and is watching is a dead
  // end, and that is worth any cost. Provenance is not, because a person is
  // not watching a row that has been queued for six hours.
  //
  // WHY THEY WERE EVER THE SAME FIELD. `processItem` used to read
  // `item.manualQueued` for this, and on 2026-10-05 that cost 12.6x the
  // user's budget: 369 requests in 6h44m, every one logged `origin=manual`,
  // in 37 bursts of 10 whose inter-burst gap was 629-630s — this file's
  // `PROVIDER_REPROBE_CAP_MS` plus the poll interval — while the automated
  // ledger sat pinned at exactly the cap of 50 and every automatic row was
  // refused 8,061 times. One click had bought a row the machine then drove
  // on its own schedule for a sixth of a day, spending into a rate-limited
  // wall. The bug was never the reading; it was that provenance is a STATE
  // and the cap needs a GRANT.
  //
  // SO `userPresentAt` IS SPENT HERE, IN THE CLAIM WRITE BELOW, AND NOWHERE
  // ELSE. One grant buys exactly ONE CLAIM. What that claim then spends is
  // the unit's own work, and a unit is not one provider request — an earlier
  // version of this comment said it was ("at most one `callAI` the cap cannot
  // refuse") and that was wrong by 2-3x on the floor:
  //
  //   · `tailorDocument` calls `extractJobKeywordsV3` and THEN `callAI`
  //     (ai.ts:1722, :1795), so one generate_* unit is two uncapped requests.
  //   · `tailorJobDocsForJob` runs `Promise.all` over the CV and the cover
  //     letter, so a `tailor_job_docs` unit is two of those.
  //   · `verifyDocumentContent` wraps `callAI` in a `MAX_RETRIES = 2`
  //     parse-failure ladder (ai.ts:2044), so a `verify` unit can be three.
  //   · and every one of those calls walks `tryModels` over the user's own
  //     enabled pool, so N models multiply the whole product.
  //
  // THE BOUND IS THEREFORE A PRODUCT, AND THE PRODUCT IS THE SAME ONE THE
  // BUTTON SPENDS ANYWAY:
  //
  //     lanes in the unit x callAI per lane x models in the rotation
  //                       x the lane's own bounded parse ladder
  //
  // Measured on the pinned fixture in queuePresenceGrant.test.ts, which is
  // where the numbers are asserted rather than promised: with ONE healthy
  // model, one grant buys 1 request for `verify`, 2 for `generate_cv` and 3
  // for `tailor_job_docs` (the second lane's keyword call coalesces onto the
  // first's in-flight promise). With three dead models a `regenerate_section`
  // buys 3; with a three-model pool Quick Apply buys 4-5.
  //
  // That is bounded, and it is bounded by things the user chose: the shape of
  // the unit, and the model list in Settings. It is ALSO the same product the
  // direct button spends, because `MANUAL` lifts the cap for the whole
  // rotation there too — pressing Generate has always walked the pool on a
  // spent budget. So the grant replaces the CAP and nothing else: it does not
  // replace the rotation, it does not outlive the claim, and it does not reach
  // any row this claim did not run. Everything after that one claim — the row's
  // own follow-up work, its retries, its revivals, its restarts — is the app's
  // own again and is capped like any other. That is what "cannot leak" means
  // here, and it is a consequence of WHERE the field is cleared:
  //
  //   1. Only a PRESS arms it. It is written by `enqueue`'s `present` option
  //      and by `retryQueueItem` (the Queue panel's Retry), and `present` is
  //      passed at exactly five places: the four `ipcMain` handlers a person
  //      reaches (`documents:verify`, `documents:regenerateSection`,
  //      `ai:tailor`, `tailor:quickApply`) and the Retry button.
  //
  //      Which was NOT the same as "only a click", and the difference was the
  //      whole of MAJOR 1. Two of those four handlers were also reached by the
  //      job page's automatic verification sweep — `useEffect(() => load(),
  //      [job.id])` on mount, the sidebar's Refresh, and every Generate /
  //      Apply / status change after it — so opening a page armed a grant
  //      nobody asked for, and the reviewer's probe bought five uncapped
  //      requests from five page opens on a ledger already 7 calls into a cap
  //      of 1. A row the APP chose could buy itself exemption, because the
  //      app had dressed itself as a person.
  //
  //      So the sweep no longer reaches those handlers. It has its own
  //      channels (`documents:autoVerify`, `ai:autoTailor`) whose fallback
  //      rows carry neither `manual` nor `present`, and it is the CHANNEL, not
  //      a flag a caller passes about itself, that says whether a person is
  //      waiting. The claim "these four are reached only by a button" is now
  //      derived from the tree by review.enqueueCallSites.test.ts — the
  //      renderer call sites of all six channels, with the enclosing function
  //      checked for reachability from a mount effect, a timer or the
  //      refresh listener — instead of asserted about `enqueue(` call sites
  //      in `electron/`, which is a statement about a file rather than about
  //      clicks. The processor, the backlog sweeps, the re-seeders and the
  //      revival lanes can reach the flag through none of the five, so a row
  //      the APP chose still cannot buy itself exemption.
  //   2. It cannot be inherited. That is structural, not conventional: the
  //      claim write spends the grant BEFORE the work runs, so every row
  //      this one fans out to — the review chain, the regeneration loop, the
  //      refused-lane handoff below — is born without one. That handoff
  //      still carries the parent's `manualQueued`, which is provenance and
  //      is exactly what it should carry.
  //   3. It cannot accumulate. Re-arming is an overwrite from a fresh
  //      gesture, so N presses before the next pass buy one claim, not N,
  //      and N presses spread across N passes buy N claims — which is what
  //      N presses of the direct Generate button already spend, against the
  //      same counted ledger.
  //   4. A press that lands while this pass is mid-flight is the one this
  //      claim honours and the one it spends. `item` is a snapshot row —
  //      `updateAIQueueItem` REPLACES the element, so `item.userPresentAt` is
  //      whatever the row held when the pass started — so the grant is
  //      re-read from the store here. Read, `opts` and the clearing write
  //      are then three adjacent SYNCHRONOUS statements with no `await`
  //      between them, so nothing can arm a grant in the gap: the grant
  //      consumed and the grant cleared are the same grant, always. The
  //      previous version did not have that. It asked the SNAPSHOT whether
  //      to clear and then cleared whatever was on the row, so a press that
  //      arrived in the gap was destroyed by a claim that had already
  //      authorised its work on an older press, and the press the user was
  //      actually waiting on became capped work — parked on the budget for up
  //      to 24h, disclosed only in the drawer.
  //   5. There is no expiry, deliberately. A grant waits for a claim however
  //      long the row is not claimed — behind a deep backlog, or through a
  //      provider cooldown, which is exactly the state the reviewer's probe
  //      was taken in. Expiring it would put the 24-hour park straight back
  //      for a press nobody has cancelled.
  //
  // The invariant, stated once: A USER-INITIATED ACTION IS NEVER REFUSED BY
  // THE DAILY BUDGET AND NEVER PARKED ON IT. Its row gets one attempt the
  // budget cannot turn away, and every attempt after that one is the app's
  // own and is capped like any other. A refusal then parks without spending
  // an attempt or a revival, and the row runs the moment the budget is
  // back — which is what the user asked for and what the row is for.
  //
  // A ROW GONE FROM THE STORE is also a `return`, before anything is claimed,
  // for the reason the `updateAIQueueItem` false return inside the try gives.
  // Reading it off the store is how the grant is read at all (point 4), so
  // the existence check is free and it is asked FIRST, which is also what
  // lets the clear below be keyed on the grant rather than on the snapshot.
  const stored = getAIQueue().find((q) => q.id === item.id)
  if (!stored) return
  const grant = stored.userPresentAt
  const opts: AiCallOptions = { manual: grant !== undefined }
  try {
    // Inside the try: if this write throws there is nothing useful to
    // record for the item, and letting it escape would abort the whole
    // pass for every other item in it.
    //
    // A false return means the row is gone — the user cleared the queue
    // after this pass snapshotted it. Doing the LLM work anyway would
    // spend a request on a job the user just cancelled, and would let
    // the item enqueue its follow-up work back into the cleared queue.
    //
    // `promotedAt: undefined` SPENDS a manual boost: this is the row
    // being taken, so the "run this now" signal has been acted on. Left
    // on the row it would pin the item above its tier siblings for good
    // — including across the failures and auto-revivals that follow,
    // which is not a thing the user asked for and is not one they could
    // undo. Every pass goes through this write, so a boost cannot
    // outlive the run that was meant to consume it.
    //
    // `parkedReason: undefined` spends the park the same way: the row is
    // being run again, so it is not parked on a spent budget any more, and
    // whatever happens next it should read as what it is — an ordinary
    // failure, an ordinary success — rather than as a provider budget that
    // has already cleared.
    //
    // `blockedSince` / `blockedCount` are spent the same way. The row is
    // being handed to the provider now, so whatever it was waiting out
    // is over: leaving the block on it would keep the panel rendering a
    // "waiting for an AI provider" marker on a row that is running, and
    // would carry the escalated re-probe ladder into the next block
    // instead of starting it fresh.
    //
    // BOTH in the one write, deliberately. A row can only ever be parked by
    // one of the two mechanisms at a time — they refuse for different
    // reasons — but they share this claim transition, so clearing them in
    // two writes would mean a panel that could observe a row which is
    // running and still claims to be parked.
    //
    // `userPresentAt` is spent here too, and this is the ONLY place it is
    // ever spent. `opts` above is already built from it, so by the time this
    // write lands the request it paid for has been authorised — and the row
    // is automated again from this line on, for the rest of this run and
    // every one after it.
    //
    // UNCONDITIONAL ON THE SNAPSHOT, and keyed on the grant we just read.
    // `undefined` in a patch means "delete this key" (see
    // `updateAIQueueItem`), so this deletes whatever `userPresentAt` the row
    // holds — which is the grant `opts` was built from, because the read and
    // this write are adjacent and synchronous and nothing can arm a grant
    // between them. The previous version asked the WRONG question, and got
    // the right answer for the wrong reason: it cleared only when the
    // SNAPSHOT held a grant, and then cleared whatever was actually on the
    // row. A press landing in that gap lost its grant to a claim that had
    // already spent an older one and became capped work, parked on the budget
    // for up to 24h. Conditioned on `grant` — the value from the row as it
    // is NOW — the clear is identity-bearing: the grant consumed and the
    // grant cleared are the same grant, always.
    //
    // The `grant === undefined` half is tidiness, not safety: it keeps a row
    // that had no grant from acquiring the key with an `undefined` value it
    // never had.
    if (!updateAIQueueItem(item.id, {
      status: 'processing',
      promotedAt: undefined,
      parkedReason: undefined,
      blockedSince: undefined,
      blockedCount: undefined,
      ...(grant === undefined ? {} : { userPresentAt: undefined })
    })) return

    // The row is ours from here, and every other function in this file
    // now answers to that. `runningRowIds` is what the panel's Retry
    // button and `retryQueueItem`'s guard read, and it is set on the same
    // tick as the `processing` write above — adjacent synchronous lines,
    // so no list can observe the gap between "claimed" and "recorded".
    runningRowIds.add(item.id)

    // ...and it stops being a crash leftover. A row the startup reclaim
    // skipped is still in `strandedRowIds` until somebody claims it, and
    // that somebody is the user: the row is revived by Retry (the panel's
    // button) or by a manual Generate on the job, both of which put it
    // back in line so the next pass can pick it up. Flipping an
    // Auto-queue switch back on does NOT, and nothing in this file ever
    // did that for a `processing` row — `runPass` only picks `pending` and
    // revives `failed`, and `enqueue`'s duplicate path revived only
    // `failed` until it learned about `stranded`. So the reason this line
    // exists is the id, not the panel: `clearAllData` rewinds the shared
    // `nextId` without touching this set, so a row created after a reset
    // can be handed an id still in it, and dropping the id here is what
    // keeps a fresh, live row from inheriting the brand.
    clearStranded(item.id)

    // One queue item is one operation and holds the AI slot for its
    // whole duration, so it cannot interleave with a direct renderer
    // action (Recompute Fit / Tailor / Verify) part-way through. The
    // `switch` body is left ungated deliberately: processItem calls the
    // AI functions that the IPC handlers also call, and wrapping both
    // layers would deadlock on a re-entrant acquire.
    await withAiOperation(async () => {
      switch (item.type) {
      case 'generate_cv':
      case 'generate_cover_letter': {
        const docType = item.type === 'generate_cv' ? 'cv' : 'cover_letter'
        // `documentId` is set only on an auto-regeneration (a rebuild of
        // a document that failed its review). It is handed to
        // tailorDocument so the rebuild REPLACES that row instead of
        // inserting a new one: a new row would carry no
        // auto_regen_attempts, so the loop's budget would reset every
        // round and AUTO_REGEN_MAX could never be reached.
        const startedAt = Date.now()
        const result = await tailorDocument({
          job_id: item.jobId,
          document_type: docType,
          document_id: item.documentId
        }, opts)
        const ms = Date.now() - startedAt

        // What `tailorJobDocsForJob` does after its own `tailorDocument`
        // call, and what this case did not do while the fit-landing trigger
        // was the only producer of the both-documents unit.
        //
        // SANITIZATION. `tailorDocument` stores the RAW provider output,
        // because the ceilings and the rule checks can only run once the
        // model has returned. `sanitizeDocument` is the one implementation of
        // both, imported from the tailoring module rather than restated here,
        // so the two lanes cannot drift. It performs no I/O; storing its
        // output is this caller's job, and `setDocumentContent` is an UPDATE
        // of the row `tailorDocument` already created — one generation, one
        // row, one write, which is Finding 2's fix preserved. A `null` return
        // means the user deleted the document in the gap and is left as-is:
        // inserting a replacement would resurrect it behind their back.
        const { sanitizeDocument } = await import('./tailorJobDocs')
        const sanitized = sanitizeDocument(
          result.content,
          docType,
          getJob(item.jobId)?.description ?? ''
        )
        setDocumentContent(result.document_id, sanitized.content)

        // DOC-DERIVED STATUS. `recomputeJobStatusFromDocs` is the only thing
        // that moves a job out of Sourced, and until now the per-unit cases
        // never called it — so every fit-landing-triggered and
        // sweep-triggered job was stranded in the Sourced column forever
        // with both documents already generated. Same call, same rule, same
        // place in the sequence as the `tailor_job_docs` case below: after
        // the document is stored, before the queue row is retired. The rule
        // itself is unchanged and still user-owned: documents drive
        // sourced <-> reviewing only, and 'ready' is the user's decision.
        recomputeJobStatusFromDocs(item.jobId)

        // TIMING. `writeTailorTimingFields` is the user's only "documents
        // built at" stamp. `ms_cv` / `ms_cl` are both written by the
        // signature, so the unit this call did NOT just generate carries its
        // existing measurement forward instead of having it overwritten with
        // a fabricated 0 — otherwise the CV's timing was destroyed by the
        // cover letter that landed a second later, which is exactly what
        // happened when one lane measured both documents at once.
        const job = getJob(item.jobId)
        writeTailorTimingFields({
          jobId: item.jobId,
          ms_cv: docType === 'cv' ? ms : (job?.tailor_ms_cv ?? 0),
          ms_cl: docType === 'cover_letter' ? ms : (job?.tailor_ms_cl ?? 0),
          generatedAt: Date.now(),
          lastError: null
        })
        removeAIQueueItem(item.id)
        // P1.7 §2: chain the review, exactly as the `tailor_job_docs`
        // case does. Without this the cycle was verify -> regenerate ->
        // STOP: the rebuilt document was never reviewed again, so the
        // user was left looking at an unreviewed document presented as
        // the job's regenerated CV, and the loop could never advance
        // past a single round.
        //
        // A first generation (no documentId) creates its document here
        // rather than through `tailor_job_docs`, so it gets the same
        // review chain — otherwise a directly queued generate_* would
        // land an unreviewed document too.
        if (epoch !== clearEpoch) return
        enqueue({ type: 'verify', jobId: item.jobId, documentId: result.document_id })
        break
      }
      case 'regenerate_section': {
        if (!item.documentId || !item.sectionName) {
          removeAIQueueItem(item.id)
          return
        }
        await regenerateSection(item.documentId, item.sectionName, item.jobId, item.extraContext, undefined, opts)
        removeAIQueueItem(item.id)
        break
      }
      case 'verify': {
        if (!item.documentId) {
          removeAIQueueItem(item.id)
          return
        }
        const doc = getDocument(item.documentId)
        if (!doc) {
          removeAIQueueItem(item.id)
          return
        }
        const result = await verifyDocumentContent(item.jobId, item.documentId, doc.type, opts)
        removeAIQueueItem(item.id)
        // P1.7 §2: review < PASSING_REVIEW_SCORE triggers one
        // auto-regeneration of the SAME doc type, bounded by
        // AUTO_REGEN_MAX attempts. A `skip` result (deleted document,
        // parse failure, rate-limited) is NOT a failing review and
        // must not feed the loop — callers already treat skip as
        // "no review happened".
        if (result.kind === 'review' && result.score < PASSING_REVIEW_SCORE) {
          // The counter is read and bumped on the document the
          // review just ran against. That is also the document the
          // regeneration below REPLACES IN PLACE, so the budget
          // carries across rounds: read 0 -> bump 1 -> rebuild the
          // same row -> re-queue the review of that same row, until
          // the counter reaches AUTO_REGEN_MAX. Pointing the
          // regeneration at a new row instead (which is what
          // happened while this item carried only a jobId) reset the
          // counter every round and made the cap unreachable.
          const attemptsSoFar = getDocumentAutoRegenAttempts(item.documentId)
          if (attemptsSoFar >= AUTO_REGEN_MAX) {
            // Cap reached: stop auto-looping. The document keeps its
            // sub-80 verification_score, which is already what the
            // user sees, so it is flagged for manual attention
            // without needing a separate flag column.
            return
          }
          const next = bumpDocumentAutoRegenAttempts(item.documentId)
          // null, not 0: the document was deleted while the reviewer's
          // LLM call was in flight. There is no budget to think about —
          // there is no document left to rebuild — so the loop ends
          // here. Reading that as 0 (fresh budget) queued a generation
          // item for a deleted row, which then re-reviewed it.
          if (next === null) return
          if (next > AUTO_REGEN_MAX) return
          if (epoch !== clearEpoch) return
          enqueue({
            type: doc.type === 'cv' ? 'generate_cv' : 'generate_cover_letter',
            jobId: item.jobId,
            // The document to rebuild, not just the job: the
            // replacement has to BE this document for the loop to
            // re-enter (and for the user's job to keep pointing at
            // the reviewed, regenerated one).
            documentId: item.documentId
          })
        }
        break
      }
      case 'score_fit': {
        // Lazy import of fitScorer keeps aiQueue.ts free of the heavier
        // main-process module graph (which transitively pulls in
        // jobSearch.ts, jobScraper.ts, browserScraper.ts, pdfTemplate,
        // etc.) until the case actually fires. fitScorer also gives the
        // function a stable home — main.ts's heavy import-time side
        // effects make it hard to test scoreOneJobInBackground directly.
        // scoreOneJobInBackground returns the updated job, or null when
        // the job was deleted mid-run.
        const { scoreOneJobInBackground, hasCurrentFitVerdict } = await import('./fitScorer')
        // `maybeAutoEnqueueDocs` runs *inside* the call below, so a
        // check after the await would be too late to stop it queueing
        // document generation into a queue the user just cleared.
        const updated = await scoreOneJobInBackground(
          item.jobId,
          () => epoch !== clearEpoch,
          opts
        )
        if (!updated) {
          removeAIQueueItem(item.id)
          return
        }
        // "Did this row leave the job with a real score for the CV in
        // force", asked of the row's own verdict fields and NOT of
        // `score == null`.
        //
        // The difference is a laundering channel. `score` is a property of
        // the JOB, so on any job that had already been scored once, every
        // pass that produced nothing read back non-null — a genuine 429
        // among them, which `scoreJobFit` deliberately answers with its
        // heuristic fallback (a real verdict is still derivable) and which
        // `scoreOneJobInBackground` therefore records as `fit_source:
        // 'heuristic'` rather than throwing. The row was then deleted as
        // though the scoring had happened, the score on the job was left at
        // whatever the earlier pass wrote, and the bounded score_fit ladder
        // — the mechanism that exists to retry exactly this — was never
        // given the chance. It is the same defect the two rethrows above
        // were added for, reached through the job row instead of through a
        // thrown type.
        //
        // Throwing is what puts the row back on that ladder: the
        // `score_fit` branch of the catch below gives it an attempt and a
        // backoff, and `SCORE_FIT_ATTEMPTS` of those retire the row rather
        // than loop.
        //
        // The cast is the pre-existing hole in `Settings`, which has never
        // declared `cv_version` although the store has always carried it
        // and four other call sites read it the same way
        // (`fitAutoScore.ts:89`, `fitScorer.ts:190`, `jobSearch.ts:744`).
        const cvVersion = (getSettings() as { cv_version?: number }).cv_version ?? 0
        if (!hasCurrentFitVerdict(updated, cvVersion)) {
          throw new Error(
            updated.fit_last_error || 'LLM scorer fell back to heuristic (no score).'
          )
        }
        removeAIQueueItem(item.id)
        break
      }
      case 'tailor_job_docs': {
        // Dynamic import keeps the processor free of the heavier
        // tailorJobDocs dependency (which in turn pulls in ai.ts's LLM
        // call path) until the case actually fires. Mirrors the
        // lazy-load pattern other optional call sites already use.
        const { tailorJobDocsForJob } = await import('./tailorJobDocs')
        const { refused } = await tailorJobDocsForJob(item.jobId, opts)
        // Generation no longer sets status itself; refresh the
        // doc-derived status (sourced <-> reviewing) after both docs land.
        const { recomputeJobStatusFromDocs } = await import('./database')
        recomputeJobStatusFromDocs(item.jobId)
        removeAIQueueItem(item.id)
        // P1.7 §1: enqueue the AI review for the documents we just
        // generated. Doing it HERE (not at auto-enqueue time) is what
        // makes generation and review sequential per job: the review
        // item does not exist until generation has finished, so the
        // queue cannot start reviewing a document that is still being
        // written. Different jobs' items may still interleave.
        //
        // `listJobDocuments`, not `listDocuments`: the latter unions
        // in the base CV, so this fan-out used to hand the user's
        // master document to the LLM reviewer on every job's
        // generation pass — uploading it to the provider, stamping it
        // a verification_score it never asked for, and pushing it
        // through the auto-regeneration counter (where a failing review
        // regenerated a job's CV that was never derived from it).
        // Reviewing the base CV is an explicit user action, not a side
        // effect of generating documents for another job.
        if (epoch !== clearEpoch) return
        for (const doc of listJobDocuments(item.jobId)) {
          enqueue({ type: 'verify', jobId: item.jobId, documentId: doc.id })
        }

        // A lane the PROVIDER refused, when its sibling built. The row is
        // retired either way — this one is the BOTH-documents unit and the
        // document that landed is stored and, above, reviewed — so the
        // refused lane is handed to the row that owns that single document.
        // `generate_cv` / `generate_cover_letter` is what `ai:tailor` does
        // with the same refusal from the renderer's Generate button, and
        // the child's budget is its own (`RATE_LIMIT_ATTEMPTS` plus the
        // `AUTO_REVIVE_MAX` revivals in `planDocUnit`), so this cannot
        // become the unbounded lane the old swallowing was.
        //
        // `manual` is inherited, never invented: this row is a person's
        // Quick Apply, and the child finishes the request they made, so it
        // must keep every restart right that row had — including being
        // ungated by `auto_queue_cv` / `auto_queue_cover_letter`, which is
        // the whole meaning of `manual` in `enqueue`.
        //
        // `present` is NOT inherited, and it could not be: the parent spent
        // its grant in the claim write above, before it ever reached this
        // line, so there is nothing here to pass on. That is the property
        // that makes presence safe to hold at all — every row a present row
        // produces is born with no grant, so a single gesture cannot cascade
        // into a chain of uncapped work. The child is a new piece of work
        // with its own bounded ladder, and it waits on the budget like any
        // other queued row.
        //
        // Only a REFUSAL is handed on. An ordinary failure is not owed
        // anything here: it gets the ladder this row's own removal would
        // have given it, and re-queueing it would spend on a posting the
        // model has already refused.
        if (refused === 'cv') {
          enqueue({ type: 'generate_cv', jobId: item.jobId }, { manual: item.manualQueued === true })
        } else if (refused === 'cover_letter') {
          enqueue(
            { type: 'generate_cover_letter', jobId: item.jobId },
            { manual: item.manualQueued === true }
          )
        }
        break
      }
      }
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error'

    // A block, not a failure. `callAI` throws this when every eligible
    // model is inside its cooldown window, which means it never reached
    // the provider: no request, no tokens, no quota. Charging it an
    // attempt is charging a ~70ms map lookup the price of a 45s call,
    // and that mismatch is the whole bug — measured on 2026-10-02, 4,122
    // of 4,143 logged failures were this throw, and rows burned all 10
    // attempts on it before the provider ever recovered.
    //
    // So this branch is FIRST and it spends nothing: `attempts` is left
    // untouched, no autoRevive is charged, and the row wakes on the
    // provider's own clock. `runPass` normally catches a blocked pool
    // before any row is claimed; this branch is the race (a rotation
    // part-way through a pass marked the last model cooling) and the
    // direct-to-AI entry points that never go through a pass at all.
    if (err instanceof ProviderCooldownError) {
      const now = Date.now()
      // Re-read rather than trust the throw site: another rotation can
      // clear the last health entry in between, and if it did the
      // provider is free NOW — which `?? now` says, leaving the row on
      // its own 30s floor instead of waiting on a stale hour.
      const freeAt = providerAvailability(now).nextAvailableAt ?? now
      const waitMs = parkBlockedRow(item, freeAt, now)
      try {
        log.ai.warn(
          `aiQueue item ${item.id} (${item.type}, job ${item.jobId}) is waiting: no AI provider is available. ` +
          `No attempt spent (${item.attempts} unchanged); next try in ${Math.round(waitMs / 1000)}s.`
        )
      } catch {
        /* logging must never break the queue */
      }
      return
    }

    const isRateLimit = err instanceof RateLimitError
    // `instanceof ProviderCapError` first, and it has to come before the
    // rate-limit ladder below: ProviderCapError EXTENDS RateLimitError, so
    // the ordinary branch would catch it and spend ten attempts plus three
    // revivals on a budget that frees in a day.
    const isCap = err instanceof ProviderCapError

    // Log every failure, not just the terminal one. The queue's own
    // `lastError` is the only other record of this, and it is a single
    // string with no stack: a bug like "X is not a function" reaching
    // the UI with nothing in <userData>/logs made it undiagnosable
    // after the fact. `error` keeps the stack so the next occurrence is
    // traceable. This must not throw — logging is best-effort and the
    // retry bookkeeping below has to proceed either way.
    try {
      log.ai.error(
        `aiQueue item ${item.id} (${item.type}, job ${item.jobId}) failed on attempt ${item.attempts + 1}: ${msg}`,
        err instanceof Error ? err.stack : undefined
      )
    } catch {
      /* logging must never break the queue */
    }

    // The per-unit generation lanes are the ones the fit-landing trigger and
    // the document backlog sweep use, so their failures need the same
    // user-visible surface the `tailor_job_docs` lane had. Without this the
    // only record of a failed trigger generation was the queue row's
    // `lastError`, which the user never sees — the job kept a null
    // `tailor_last_error` and no "documents built at" stamp to contradict it.
    //
    // Guarded on the two generation types: a failing `verify` or `score_fit`
    // is not a tailoring failure and must not overwrite `tailor_last_error`.
    // `generatedAt: null` matches the tailor lane, which also treats a failed
    // build as no build. The millisecond fields are carried forward for the
    // same reason as on the success path: this attempt measured nothing that
    // belongs in either slot.
    //
    // NOT for a cap refusal, and that exclusion is the point. The document
    // was never opened: nothing was built, nothing was measured, and nothing
    // went wrong with a document the user already has. Writing
    // `generatedAt: null` here erased the real "documents built at" stamp of
    // a CV that was perfectly fine, and `tailor_last_error` then showed the
    // user a hard failure for a condition that clears itself when the budget
    // does — under two hours, on the reviewer's measurement. The row's own
    // `lastError` is where that story belongs, and the job surface is left
    // describing the document that is actually there.
    try {
      if (!isCap && (item.type === 'generate_cv' || item.type === 'generate_cover_letter')) {
        const job = getJob(item.jobId)
        writeTailorTimingFields({
          jobId: item.jobId,
          ms_cv: job?.tailor_ms_cv ?? 0,
          ms_cl: job?.tailor_ms_cl ?? 0,
          generatedAt: null,
          lastError: msg
        })
      }
    } catch {
      /* the error surface must never break the retry bookkeeping below */
    }

    const attempts = item.attempts + 1
    // From here on `attempts` is NOT spent by a provider-free failure: the
    // cooldown block above returned, and the cap branch below returns too.
    //
    // `isCap` before every other branch, and it returns: this row's next
    // step is decided by the budget, not by the retry ladder.
    if (isCap) {
      parkOnProviderCap(item, msg)
    } else if (isRateLimit && attempts < RATE_LIMIT_ATTEMPTS) {
      updateAIQueueItem(item.id, {
        status: 'pending',
        attempts,
        lastError: msg,
        nextRetryAt: Date.now() + backoffMs({ ...item, attempts })
      })
    } else if (item.type === 'score_fit' && !isRateLimit && attempts < SCORE_FIT_ATTEMPTS) {
      // A score_fit miss (LLM error / heuristic fallback) is usually
      // transient — network hiccup, per-request 429 vs rate-limiter,
      // provider blip. Retry a bounded number of times instead of
      // abandoning the job's score forever.
      updateAIQueueItem(item.id, {
        status: 'pending',
        attempts,
        lastError: msg,
        nextRetryAt: Date.now() + backoffMs({ ...item, attempts })
      })
    } else {
      // The item has burned its whole retry budget. Rather than leave
      // it terminally failed — which is how a quota-exhausted job
      // silently lost its fit score until a human noticed — park it
      // `pending` on a long cooldown with a fresh attempt count, so it
      // rejoins the queue on its own once the provider recovers.
      // Bounded by autoRevives so a genuinely unsatisfiable task
      // eventually stays failed instead of looping forever.
      //
      // Parked here means "rejoin the queue on its own later", so it takes the
      // restart gate rather than the enqueue one: a MANUAL row is parked
      // as it always was (the user asked for it), and an automatic row is
      // parked only while its switch allows it. Otherwise the row goes
      // straight to terminal `failed` and the user sees a failure they
      // can Retry, rather than one that keeps reappearing as new
      // generations they did not ask for.
      const autoRevives = item.autoRevives ?? 0
      if (autoRevives < AUTO_REVIVE_MAX && mayReviveUnattended(item)) {
        updateAIQueueItem(item.id, {
          status: 'pending',
          attempts: 0,
          autoRevives: autoRevives + 1,
          lastError: msg,
          nextRetryAt: Date.now() + AUTO_REVIVE_COOLDOWN_MS
        })
      } else {
        updateAIQueueItem(item.id, {
          status: 'failed',
          attempts,
          autoRevives,
          lastError: msg
        })
      }
    }
  } finally {
    // On every exit, including the early `return` for a row the user
    // cleared out from under the pass and any throw that escaped the
    // catch's own bookkeeping. Leaking an id here would make the row
    // permanently un-retryable and permanently un-reclaimable — a
    // `processItem` that has already stopped running is not a run in
    // progress, so keeping the claim would be a lie of the same kind the
    // stranded flag is careful not to tell.
    runningRowIds.delete(item.id)
  }
}

let processorTimer: ReturnType<typeof setInterval> | null = null

/**
 * Guards against overlapping passes.
 *
 * A pass is a serial `await` loop over every due item, so with a real
 * backlog one pass runs far longer than the 30s poll. Without this,
 * setInterval would start a second pass over the same store while the
 * first was mid-flight: two items in flight at once, which is exactly
 * what the serial design and the rate-limit backoff exist to prevent.
 *
 * The suppressed pass is a no-op, not a dropped pass — the next tick
 * picks up whatever the running pass has not reached yet.
 */
let passInFlight = false

/**
 * Bumped every time the user clears the queue.
 *
 * A pass reads the queue once and then works through a snapshot, so a
 * clear landing mid-pass is invisible to it: the in-flight item finishes
 * and would otherwise enqueue its follow-up work (verify, regeneration,
 * tailor_job_docs) straight back into the queue the user just emptied,
 * rebuilding the whole chain. The epoch is the invalidation signal for
 * that: a pass captures it on entry and abandons its work the moment it
 * moves.
 */
let clearEpoch = 0

/**
 * Return rows abandoned mid-run by a previous process to the queue.
 *
 * `processItem` marks an item `processing` before doing its work, so a
 * quit, crash or force-kill during an LLM call leaves the row
 * `processing` in the store. The processor only ever picked `pending`,
 * so those items were stranded permanently — no amount of leaving the
 * app running would finish them, and nothing in the UI explained why.
 * Over a long queue at least one interruption is close to certain, so
 * this runs once at startup, before the first pass.
 *
 * `attempts` is deliberately preserved: the interrupted attempt was
 * still spent, and resetting it would hand a repeatedly-crashing task
 * an unlimited budget.
 *
 * Requeueing is starting the work again, so it takes the restart gate:
 * a MANUAL row is reclaimed exactly as it always was, because a person
 * asked for that work and this finishes it. An automatic row is left as
 * the crash left it, `processing`, when its switch is off — that is the
 * unattended spend the switch says the user bought out of. Either way
 * the row is not lost: it is visible in the panel, and Retry resumes it
 * ungated.
 *
 * Not requeueing a row is what makes the panel's job non-trivial, and
 * the note above is only true now that the panel can see one. The rows
 * skipped here stay `processing` with nobody working on them, so this
 * function first records them (`noteStrandedRows`) and `listQueueInPickOrder`
 * reports them as `stranded`, which is what puts a Retry button on them.
 * That is the whole escape hatch for a gated automatic row: the app
 * refuses to spend on it, and the user can always ask.
 *
 * A row THIS process is running is not interrupted by anyone and is never
 * touched here — not requeued and not recorded. The store cannot tell the
 * two apart, so the only thing that can is `ownedByThisProcess`, and it
 * is asked before the gate rather than after it: a gated live row must
 * come out of this loop untouched, and an allowed live row must not be
 * handed a second run while its first one is still being paid for.
 */
export function reclaimInterruptedItems(): void {
  const rows = getAIQueue()
  // First, and before anything is written, so the snapshot describes the
  // store as this process found it rather than as this pass left it.
  noteStrandedRows(rows)
  for (const item of rows) {
    if (item.status !== 'processing') continue
    // Ours, not abandoned. See above.
    if (ownedByThisProcess(item.id)) continue
    if (!mayReviveUnattended(item)) continue
    updateAIQueueItem(item.id, {
      status: 'pending',
      nextRetryAt: Date.now(),
      lastError: 'Interrupted before completion; requeued at startup.'
    })
  }
}

export function startQueueProcessor(intervalMs = 30000): void {
  if (processorTimer) return
  // Before the first pass, so a row stranded by a crash is requeued
  // rather than sitting invisible for the life of this process.
  reclaimInterruptedItems()
  processQueue()
  processorTimer = setInterval(processQueue, intervalMs)
}

export function stopQueueProcessor(): void {
  // The stranded set describes the rows THIS process found interrupted.
  // Once the processor is stopped nothing is claiming anything, so the
  // record is stale: dropped here, which also means the next
  // `startQueueProcessor` takes a fresh snapshot through its own startup
  // reclaim rather than inheriting this one's.
  //
  // Which makes this the one place that could brand a live row stranded:
  // the pass that was mid-run is still running, and the fresh snapshot its
  // reclaim takes would otherwise find that row `processing` and record
  // it. `noteStrandedRows` excludes rows this process owns for exactly
  // this reason, and the reclaim requeue loop skips them too, so a
  // stop/start straddling a run is safe.
  //
  // `runningRowIds` is deliberately NOT cleared. Stopping the processor
  // stops the polling; it does not un-send an LLM call, and that call is
  // still this process's to finish. Forgetting the claim here would put
  // the row back in play while its `processItem` is on the stack, which is
  // the double-spend the claim exists to prevent.
  strandedRowIds.clear()
  startupStrandedNoted = false
  if (processorTimer) {
    clearInterval(processorTimer)
    processorTimer = null
  }
}

export { RateLimitError, ProviderCooldownError }

export async function processQueue(): Promise<void> {
  // A pass already running owns the store for this tick; a second
  // concurrent pass would double LLM concurrency and race the
  // first pass's status writes.
  if (passInFlight) return
  passInFlight = true
  try {
    await runPass()
  } finally {
    // Released even on throw, or one bad pass would wedge the queue
    // for the rest of the process's life.
    passInFlight = false
  }
}

async function runPass(): Promise<void> {
  const queue = getAIQueue()
  const now = Date.now()
  try {
    await runPassBody(queue, now)
  } finally {
    // Every exit, including the two early returns below and a throw from a
    // row, gets its outcome recorded — and the outcome is read fresh from
    // the store rather than off `queue`, which was snapshotted before any of
    // it ran.
    //
    // `PROVIDER_REPROBE_CAP_MS` is the argument, not a number chosen here:
    // it is the ceiling of the ladder `parkBlockedRow` parks on, so it is the
    // point past which this queue is no longer trying harder — see
    // `queueStalls.ts` for the rule that turns a refusal into a record.
    reportStalledQueue(Date.now(), PROVIDER_REPROBE_CAP_MS)
  }
}

async function runPassBody(queue: AIQueueItem[], now: number): Promise<void> {
  // Every eligible model is cooling down: there is nothing this pass can
  // accomplish, so it does not claim a row.
  //
  // Claiming one is what turned an outage into an outage with collateral
  // damage. Each claimed row was handed to `callAI`, threw immediately,
  // was charged an attempt and rescheduled — so a queue of 265 drained
  // its entire retry budget into a provider that was never asked, and by
  // the time the provider came back every row had nothing left to retry
  // with (2026-10-02: 0 successes in 20 hours, 4,122 of 4,143 failures
  // were this throw, at a median of 370 minutes per row).
  //
  // So the whole pass is a no-op except for parking the due rows on the
  // provider's clock. Zero requests, zero attempts, zero autoRevives, and
  // one log line however many rows are queued — which is also the app-wide
  // signal that was missing entirely: before this, 265 rows sat in the
  // panel indistinguishable from ordinary backlog for 20 hours and the
  // only trace was a per-row `lastError` string.
  //
  // `failed` rows are deliberately left alone. Reviving one spends an
  // autoRevive, and there is no point spending recovery budget while the
  // provider that caused the failure is still refusing: the revival
  // happens on the first unblocked pass instead, with its budget intact.
  const availability = providerAvailability(now)
  if (availability.blocked && availability.nextAvailableAt !== null) {
    let parked = 0
    let shortestWaitMs = Number.POSITIVE_INFINITY
    for (const q of queue) {
      if (q.status !== 'pending' || q.nextRetryAt > now) continue
      const waitMs = parkBlockedRow(q, availability.nextAvailableAt, now)
      parked++
      if (waitMs < shortestWaitMs) shortestWaitMs = waitMs
    }
    if (parked > 0) {
      try {
        log.ai.warn(
          `aiQueue: ${parked} queued task(s) are waiting — no AI provider is available. ` +
          `No attempts spent, no provider requests made. Next check in ` +
          `${Math.round(shortestWaitMs / 1000)}s.`
        )
      } catch {
        /* logging must never break the queue */
      }
    }
    return
  }

  // An item parked by the auto-revival loop is already `pending` with a
  // future nextRetryAt, so the first clause picks it up once its
  // cooldown elapses. The second clause covers rows that reached
  // `failed` some other way (before auto-revival shipped, or via the
  // retry path) and have no revival scheduled — those are revived here
  // rather than left stranded.
  //
  // The revival lane consults the same gate `enqueue` does. `enqueue`
  // only ever decides whether to ADD a row, so a row already in the
  // store when the user flips a switch off used to be woken anyway —
  // up to AUTO_REVIVE_MAX full generations, four hours apart,
  // unattended, which is the exact leak `879e30d`'s commit message said
  // gating `enqueue` alone would leave open and which `fitAutoScore.ts`
  // already refuses for the identical 4h re-seed. Switch off now means
  // no unattended spend on this lane either.
  //
  // The row records whether a person queued it (`manualQueued`, written by
  // `enqueue`), so this gate can tell the two apart: a MANUAL row is
  // revived on the 4h cooldown exactly as it always was, because the user
  // asked for that work; an AUTOMATIC row — including any legacy row with
  // no origin field — is revived only while its switch allows it. Switch
  // off therefore means no unattended spend on this lane, without costing
  // a person their own request when the app restarts under them.
  const due: AIQueueItem[] = []
  for (const q of queue) {
    if (q.nextRetryAt > now) continue
    if (q.status === 'pending') {
      due.push(q)
    } else if (q.status === 'failed' && revive(q) && mayReviveUnattended(q)) {
      // Reviving writes the fresh counters to the row, then processes
      // the same shape in memory. Without the in-memory half the item
      // would be processed with its exhausted `attempts` and fail
      // straight back to `failed` on its very first attempt.
      updateAIQueueItem(q.id, {
        status: 'pending',
        attempts: 0,
        autoRevives: (q.autoRevives ?? 0) + 1,
        blockedSince: undefined,
        blockedCount: undefined
      })
      due.push(reviveInMemory(q))
    }
  }
  // P1.7: re-sort on every pass so the ordering reflects the live fit
  // scores, not the order items happened to be enqueued in.
  const epoch = clearEpoch
  for (const item of pickOrder(due)) {
    // A clear mid-pass invalidates everything this pass snapshotted.
    if (epoch !== clearEpoch) return
    await processItem(item, epoch)
  }
}

/**
 * Whether a `failed` item still has automatic-revival budget left.
 * Rows written before `autoRevives` existed have no counter, so
 * undefined counts as 0 and they get a chance to recover.
 */
function revive(item: AIQueueItem): boolean {
  return (item.autoRevives ?? 0) < AUTO_REVIVE_MAX
}

/** The row a revived item will be processed as, mirroring the write. */
function reviveInMemory(item: AIQueueItem): AIQueueItem {
  return {
    ...item,
    status: 'pending',
    attempts: 0,
    autoRevives: (item.autoRevives ?? 0) + 1,
    // Mirrors the write above: the in-memory shape has to agree with the
    // stored one or this pass would process a row that still looks
    // provider-blocked.
    blockedSince: undefined,
    blockedCount: undefined
  }
}

/**
 * The write that gives a row another run: `pending`, due now, a fresh
 * attempt budget, no stale error.
 *
 * The single definition of a revive. `retryQueueItem` (the Retry button)
 * and `enqueue`'s duplicate path both build their write from it, so a
 * row revived by a re-add cannot drift from a row a user retried by
 * hand — two copies of this is how they would.
 *
 * `attempts` MUST be reset alongside `status` / `nextRetryAt`. The
 * catch block in processItem gates its retry on `attempts < N`
 * (`SCORE_FIT_ATTEMPTS` / `RATE_LIMIT_ATTEMPTS`), so an item that has
 * already exhausted its budget would otherwise be re-run exactly once and
 * fail again immediately — the user's Retry would look like it worked
 * while changing nothing. Resetting the counter is what makes Retry
 * grant a full fresh budget rather than the single attempt the
 * exhausted counter still allows.
 *
 * `lastError` is cleared so the Queue panel stops showing a stale
 * failure for a task the user just asked to run again.
 *
 * `autoRevives` is deliberately NOT touched. This is the user's own
 * request for this work to run again, which is the same thing the Retry
 * button does and sits outside the automatic-revival budget the
 * processor charges itself (`AUTO_REVIVE_MAX`); charging it here would
 * make a hand-triggered recovery stop working after a few automatic
 * ones, and would diverge from what `retryQueueItem` has always done.
 *
 * `userPresentAt` is deliberately NOT cleared here either, and that is the
 * difference between reviving and answering. Reviving puts the row back in
 * line; `retryQueueItem` adds the grant on top, because a press of Retry is
 * a person asking for this work to run NOW, so the row's next claim must be
 * one the daily budget cannot refuse. Leaving a live grant alone rather than
 * clobbering it is what makes this write safe to share with the duplicate
 * path in `enqueue`, where the same gesture arms it.
 */
function revivePatch(): Partial<AIQueueItem> {
  return {
    status: 'pending',
    nextRetryAt: Date.now(),
    attempts: 0,
    lastError: undefined,
    // Same reasoning as clearing `lastError`: a row the user just asked
    // to run again is not still parked on a provider block, and the
    // escalated re-probe ladder belongs to the block that just ended.
    blockedSince: undefined,
    blockedCount: undefined
  }
}

/**
 * Put a failed (or otherwise stalled) item back in line for processing.
 *
 * Returns the queue in pick order so the caller can hand the refreshed
 * list straight back to the renderer.
 *
 * The Queue panel's Retry button, so it is a MANUAL action and is
 * deliberately not subject to the `auto_queue_*` switches — the same
 * rule that keeps Generate working with CV auto-queueing off. It also
 * never creates a row: a user cannot conjure work the app did not
 * already decide to do, they can only re-run what it decided and that
 * failed. Which is why it does not go through `enqueue` and so needs no
 * gate of its own.
 *
 * Status-agnostic on purpose, and it has to be. `revivePatch` sets the
 * row to `pending` and due now whatever it was doing, so this works on a
 * row left `processing` by a crash as well as on a `failed` one — which
 * is the only way out of the state `reclaimInterruptedItems` deliberately
 * parks a gated automatic row in. A function that answered `null` for
 * `processing` would leave the panel's button a decoration.
 *
 * Status-agnostic is not the same as unowned, and the difference is the
 * one guard here. A row this process is running has a `processItem` on the
 * stack that is holding an AI slot and holding a provider call; it reaches
 * `removeAIQueueItem(item.id)` when that call returns. Reviving it writes
 * `pending` over a run that is still going, and the run then deletes the
 * row the user was just looking at: the re-request is swallowed and the
 * task disappears from the panel. So the write is refused for a row
 * `ownedByThisProcess`, which is not a second gate on spend — nothing is
 * spent here either way — but it stops the app destroying a task it is
 * working on. The panel already declines to offer the button on such a row
 * (`stranded` is false for it), so this is the backstop under the UI and
 * under any caller that reaches `aiQueue:retry` with an id of its own
 * choosing, which the handler does not filter.
 *
 * The refusal is logged rather than thrown: it means the renderer's view
 * was stale (a row it read as stranded had already been claimed), and a
 * queue call that throws is a queue call the panel has to survive. The
 * returned list is the unchanged truth, and it is what the panel renders —
 * so the row keeps saying `Processing…`, which is correct, because it is.
 *
  * It also does not clear the stranded record: the row is no longer
  * stranded the moment it stops being `processing`, which is all
  * `isStranded` looks at, and the processor forgets the id again when it
  * claims the row.
  *
  * AND IT ARMS THE PRESENCE GRANT, which is the whole reason this function
  * is a user path at all. `revivePatch` alone returns a row the cap is free
  * to refuse, which is what `c526332` left behind: Retry is a button, the
  * user pressed it because the task did not happen, and the one thing that
  * button must not do is put the row back in line behind a full day's
  * budget. So this write carries `userPresentAt`, and the processor spends
  * it at the row's next claim — one CLAIM the cap cannot turn away, after
  * which the row is capped like anything else. Not more than one claim,
  * because the claim clears it; not only for a row the app chose on its own,
  * because a press of Retry is a gesture whatever the row's provenance is.
  * ("One claim", not "one request": what a claim then spends is the unit's
  * own work — see the full product in `processItem`.)
  *
  * Which makes Retry the second instance of the shape `tailor:quickApply`
  * is the first, and the reason both are listed in `enqueue`'s inventory:
  * a user path whose only delivery mechanism is the queue must not be a
  * path the queue can park.
  */
export function retryQueueItem(id: number): QueueItemView[] {
  if (ownedByThisProcess(id)) {
    // Best-effort, like the failure log in `processItem`: a refusal that
    // cannot be reported is a task the user cannot retry, which is the
    // one outcome this whole feature exists to prevent.
    try {
      log.ai.warn(
        `aiQueue:retry ignored for item ${id}: this process is running it. The row is not lost — ` +
          'it completes (or fails) on its own, and Retry works on the row afterwards.'
      )
    } catch {
      /* logging must never break the queue */
    }
    return listQueueInPickOrder()
  }
  updateAIQueueItem(id, { ...revivePatch(), userPresentAt: Date.now() })
  return listQueueInPickOrder()
}

/**
 * Drop one queued task by id and hand back the refreshed queue.
 *
 * Additive sibling to `retryQueueItem`: it exists so that every
 * queue-mutating entry point returns the SAME shape
 * (`listQueueInPickOrder()`, enriched and in pick order). `remove`
 * used to answer with `db.getAIQueue()` — raw rows, no `jobTitle` /
 * `jobCompany` — while `list` and `retry` answered with the enriched
 * view. The renderer stored whichever it was given, so removing one row
 * silently dropped the title off every OTHER row at the same instant:
 * `jobLine()` in the Queue panel falls through to its `Job <id>`
 * fallback for each of them. The per-row delete is not what changed the
 * other rows' labels; the response shape was.
 *
 * Returns the queue AFTER the removal, so the caller can set state from
 * it without a second round trip.
 */
export function removeQueueItem(id: number): QueueItemView[] {
  removeAIQueueItem(id)
  return listQueueInPickOrder()
}

/**
 * Drop every queued task, whatever its status.
 *
 * Returns how many were removed so the caller can report it, and the
 * (now empty) queue in pick order so the renderer can refresh from the
 * same shape `aiQueue:list` returns.
 *
 * Irreversible by design — the UI confirms with the user first. Items
 * the processor is currently working on are not interrupted; they
 * finish and then find their row already gone, which is preferable to
 * discarding an LLM call that has already been paid for.
 *
 * The `queue` field is typed `QueueItemView[]`, not `AIQueueItem[]`,
 * because that is what the body has always returned (`listQueueInPickOrder()`).
 * The narrower annotation was a lie in the one direction that mattered:
 * it declared the Clear path's response to be the raw row shape, so a
 * caller (and the compiler) could not tell it apart from the buggy
 * `aiQueue:remove`, and nothing stopped the Clear button from being
 * wired to raw rows later. Annotations are not documentation.
 */
export function clearQueue(): { removed: number; queue: QueueItemView[] } {
  clearEpoch++
  const removed = clearAIQueue()
  return { removed, queue: listQueueInPickOrder() }
}

/**
 * Enqueue a task. If an identical item is already queued — same
 * (type, jobId, documentId, sectionName) in ANY status — this never
 * adds a second row, because one piece of work is one row. Repeated
 * triggers (fit lands, then a re-scan, then the hourly autoscore tick), the
 * startup backlog, and a manual re-add all resolve to the same single
 * row.
 *
 * On a hit the row is brought back to life rather than left alone:
 * a `failed` row is revived in place (`revivePatch` — the same write
 * the Retry button makes, so the two cannot drift), a `manual` enqueue
 * additionally promotes it, and a `manual` enqueue also revives a
 * STRANDED row — one the startup reclaim left `processing` with nobody
 * on it — because the alternative was a Generate button that finds the
 * work already queued and does nothing at all. Both are only reachable
 * when the work already has a row, so neither can invent one, and
 * neither touches a row this process is running right now.
 *
 * `manual: true` is the caller's claim that a person asked for this
 * (the direct Verify / Regenerate / Tailor / Quick Apply actions). It
 * is what earns the promotion; automatic re-adds — the fit-landing
 * trigger, the documents backlog sweep, the hourly re-seeder, the
 * processor's own follow-up chaining — deliberately do not promote, or
 * every background tick would reshuffle the queue under the user.
 *
 * The return value is unchanged and load-bearing: `null` means "not
 * newly added" (it was already queued, revived, or promoted), a row
 * means this call created it. `maybeAutoEnqueueDocs` answers "did
 * generation get scheduled?" from it, so widening the guard did not
 * change what any existing caller can conclude — a revived row still
 * reports `null`, exactly as a suppressed duplicate always has.
 *
 * The five `auto_queue_*` settings (Settings > Auto-queue) are enforced
 * HERE, centrally, rather than at each call site — see
 * `autoQueueAllows`. Central is the only placement that holds: an
 * automatic enqueue with its toggle off is refused no matter which
 * module asked, so a path added later cannot quietly bypass the user's
 * choice. `opts.manual` is what keeps that from being overreach —
 * every manual entry point already passes it, so an explicit user
 * action is queued whatever the toggles say.
 *
 * `documentId` / `sectionName` are compared with a null-normalising
 * helper: rows created before those fields existed store them as
 * `null`, while a fresh `enqueue({...})` call simply omits them
 * (`undefined`). Without normalisation the two spellings of "no
 * document" would not match and the duplicate guard would silently
 * stop working.
 *
 * The guard scans the whole queue on every call, and that scan is
 * deliberately NOT indexed. Measured against a real store (300 jobs,
 * 600 documents) it costs 1.3 us with a 200-row queue and 8 us at
 * 1000 rows, while the `persistStore()` this same call goes on to
 * schedule — a full-store AES-256-GCM encrypt plus an atomic write and
 * rename — measured ~6 ms in the same run. The scan is a rounding error
 * against the write it precedes, and an index would have to be
 * invalidated by every queue mutation (add, update, remove, clear, the
 * dedupe repair, and any future path that touches `ai_queue` directly),
 * each of which is a chance to let a duplicate through — the exact
 * failure the widened guard above exists to prevent. A caller that
 * wants to know "did this get queued?" should read the null return
 * rather than pre-check the queue; see `maybeAutoEnqueueDocs`, which
 * used to do exactly that and scanned twice per call.
 */
/**
 * The `auto_queue_*` settings (Settings > Auto-queue), resolved for one
 * enqueue.
 *
 * Placement is the point. These are read HERE, inside the one function
 * every queue row goes through, rather than at the call sites, for two
 * reasons:
 *
 *  1. It cannot be bypassed. There are eight automatic producers of
 *     work today (the fit-landing trigger in fitScorer, the processor's
 *     own generation→review chaining, its review→regenerate loop and its
 *     tailor_job_docs→review fan-out in this file, the fit
 *     re-seeder in fitAutoScore, the documents backlog sweep in
 *     docsAutoQueue, and the two fallback rows the job page's mount
 *     sweep queues through `documents:autoVerify` and `ai:autoTailor`
 *     in main.ts) and more arrive with every feature
 *     that queues work. A per-call-site check is a rule that only holds
 *     for the callers that remembered it. (The processor's fifth call
 *     site — handing a REFUSED lane of a `tailor_job_docs` row to the
 *     per-unit row that owns that one document — is deliberately not one
 *     of the six: it carries the parent row's own `manualQueued`, so
 *     the manual flag arrives from a row rather than being invented at a
 *     call site.)
 *  2. A refusal has to be uniform. If two callers disagreed about
 *     whether a type was gated, "is this queued?" would have two
 *     answers and no test could pin it down.
 *
 * What the settings do NOT do is stop the user. Every entry point a
 * person triggers passes `{ manual: true }`, and that flag short-circuits
 * this function before a single setting is read — and, via
 * `mayReviveUnattended`, it carries past the enqueue so the user's own
 * rows keep their restart behaviour too.
 *
 * THE INVENTORY OF USER PATHS IS TWO LISTS, NOT ONE.
 *
 * `manual` — "a person asked for this", recorded on the row for ever. Four
 * `ipcMain` handlers pass it, plus the one processor call site that reads it
 * off the row it is finishing:
 *
 *   main.ts  documents:verify            → verify            (Verify button)
 *   main.ts  documents:regenerateSection → regenerate_section (Regenerate)
 *   main.ts  ai:tailor                   → generate_cv /     (Tailor /
 *                                          generate_cover_letter  Generate)
 *   main.ts  tailor:quickApply           → tailor_job_docs   (Quick Apply)
 *   this file  a lane a provider         → generate_cv /      (finishing a
 *              REFUSED, with the         generate_cover_letter  Quick Apply)
 *              parent row's manualQueued
 *
 * The first four are rate-limit fallbacks: three try the AI call directly
 * first and queue only when the provider is throttling, and Quick Apply has
 * no direct call at all. The fifth creates no request of its own — it
 * finishes one whose other half the provider refused — so it READS the flag
 * off the row rather than asserting it, and an automatic parent row stays
 * automatic. There are no others — `rg -n "enqueue\(" electron src` is the
 * check, and aiQueue.autoQueue.test.ts pins both halves of every row of
 * that table.
 *
 * AND THE FOUR HANDLERS ARE FOUR BUTTONS NOW, which they were not: two of
 * them were also serving the job page's automatic sweep, so every page open
 * produced a `manualQueued: true` row that no person had asked for — revived
 * ungated, promoted, and exempt from `auto_queue_verify_*` / `auto_queue_cv`
 * however the user had set them. The sweep's own channels
 * (`documents:autoVerify`, `ai:autoTailor`) queue with NEITHER flag, so the
 * provenance half of the misclassification is closed at the same time as the
 * presence half, and "auto-queue this off" is finally true of a page load.
 *
 * `present` — "and they are still waiting for it": a one-shot grant the
 * processor spends at the row's next claim so the cap cannot park the row a
 * gesture created. A much SHORTER list, because a grant is a per-request
 * exemption and a per-request exemption handed to the machine is exactly
 * the 12.6x this branch exists to undo:
 *
 *   main.ts  documents:verify            → the same fallback row
 *   main.ts  documents:regenerateSection → the same fallback row
 *   main.ts  ai:tailor                   → the same fallback row
 *   main.ts  tailor:quickApply           → tailor_job_docs
 *   this file  retryQueueItem            → whatever row Retry was pressed on
 *
 * The first FOUR rows are the four channels a BUTTON reaches, and the
 * distinction is now carried by the channel rather than by a flag a caller
 * passes about itself. The job page's automatic sweep used to reach two of
 * them (`documents:verify` and `ai:tailor`, from `runLoad` on mount, on the
 * sidebar's Refresh and after every Generate), so a page open with no button
 * pressed armed a grant and bought an uncapped request; the sweep now has its
 * own channels, `documents:autoVerify` and `ai:autoTailor`, whose fallback
 * rows carry NEITHER flag:
 *
 *   main.ts  documents:autoVerify        → verify            (the mount sweep)
 *   main.ts  ai:autoTailor               → generate_cv /     (its regeneration
 *                                          generate_cover_letter  loop)
 *
 * Two channels need no automatic twin because no automatic producer of their
 * type exists at all: `regenerate_section` (the regeneration loop that could
 * have been one is the queue's own, bounded by AUTO_REGEN_MAX) and
 * `tailor_job_docs` (its automatic producers are the fit-landing trigger and
 * the documents backlog sweep, both of which queue without either flag).
 *
 * Note what is NOT on the `present` list: the processor's own follow-up
 * chaining, the backlog sweeps, the re-seeders, the refused-lane handoff, and
 * the two automatic sweep channels above. The handoff is not an omission —
 * a parent spends its grant before it can enqueue anything, so there is
 * nothing to inherit. And `retryQueueItem` is on it while NOT being on the
 * `manual` list above, which is the cleanest statement of the whole
 * distinction: a Retry press is presence on a row that may be
 * provenance-automatic, and it buys one claim rather than a row the machine
 * then drives.
 *
 * `review.enqueueCallSites.test.ts` derives BOTH lists from the source tree
 * and fails if either drifts, so neither is a reviewer's promise. The
 * `present` half is derived from the RENDERER's call sites of those six
 * channels — each one's enclosing function checked for reachability from a
 * mount effect, a timer or the refresh listener — because that is the unit in
 * which "a person is asking" is true or false. An earlier version of that
 * test pinned the `enqueue(` call sites in `electron/`, which said nothing
 * about who could reach them: two of the four were also on an automatic
 * sweep, and a list of strings in `electron/` cannot tell you that.
 *
 * THAT INVENTORY IS NOT COMPLETE, and the gap is where a switch-off
 * leaks. `rg "enqueue\("` counts call sites, so it is blind to the
 * paths that queue or resurrect work without calling `enqueue`. SEVEN exist:
 *
 *   runPass's revival of a `failed` row   (the 4h auto-revive cooldown)
 *   processItem's failure-path reschedule (the same cooldown, parked)
 *   reclaimInterruptedItems at startup   (a row stranded `processing`)
 *   fitAutoScore.runFitAutoScoreBacklog  (adds and resurrects score_fit rows
 *                                         itself, by design, via
 *                                         addAIQueueItem)
 *   docsAutoQueue.runDocsAutoQueueBacklog (the same for documents, also via
 *                                         addAIQueueItem)
 *   fitScorer.maybeAutoEnqueueDocs       (enqueues, and also resurrects the
 *                                         rows it plans)
 *   retryQueueItem (the Queue panel's Retry)
 *
 * The count was four for a long time, and the three it missed were all
 * `addAIQueueItem` calls that bypass `enqueue` altogether — which is also
 * why "grep for `enqueue(`" was the wrong instruction to leave behind. None
 * of the seven carries presence, which is what matters, and none needs to:
 * every one is reachable only from a timer, a pass, a crash reclaim,
 * `startup`, or a person pressing Retry.
 *
 * All of them consult the same rule rather than re-deriving it, but the
 * restart lanes ask a NARROWER question than `enqueue` does, via
 * `mayReviveUnattended`: a MANUAL row — one a person queued, recorded on
 * the row as `manualQueued` — keeps every restart behaviour it always had,
 * because a revival or a crash-reclaim finishes work they asked for. Only
 * an AUTOMATIC row consults the switch, and absent means automatic, which
 * is what keeps the leak closed for rows written before the field existed.
 *
 * `retryQueueItem` is on the `present` list rather than the `manual` one. It
 * is the panel's own deliberate answer to a gated automatic row — "the app
 * will not spend on its own, the user still can" — so it revives ungated
 * whatever the switches say, and it is also a person asking for the work to
 * run NOW, so it arms the grant. Auditing the gate means grepping for the
 * revival, the resurrection AND the retry; only the last of those carries
 * presence.
 *
 * The first three above read no setting at all until this was fixed, so a
 * row already in the store when the user flipped a switch kept being woken
 * — up to AUTO_REVIVE_MAX full generations, four hours apart, unattended.
 * That is the leak `879e30d`'s own commit message warned that gating
 * `enqueue` alone would leave open. When auditing this gate, grep for the
 * revival and the resurrection, not just the enqueue.
 *
 * So turning CV auto-queueing off stops the app spending tokens on its
 * own and does not stop the user pressing Generate.
 *
 * The mapping, by `item.type`:
 *   score_fit           → auto_queue_fit
 *   generate_cv         → auto_queue_cv
 *   generate_cover_letter → auto_queue_cover_letter
 *   verify              → auto_queue_verify_cv / auto_queue_verify_cover_letter,
 *                         chosen by the document's type (a `verify` row
 *                         carries a documentId; there is no document, so
 *                         nothing is gated — the processor drops such a
 *                         row anyway)
 *   tailor_job_docs     → auto_queue_cv AND auto_queue_cover_letter.
 *                         The item generates both documents in one pass
 *                         (tailorJobDocsForJob), so it cannot honour one
 *                         toggle without silently doing the other: with
 *                         either off there is no truthful subset of it
 *                         to run, and running it anyway would quietly
 *                         generate the document the user just switched
 *                         off. An explicit Tailor / Quick Apply still
 *                         enqueues, because it is manual.
 *   regenerate_section  → ungated. There is no automatic producer of it
 *                         at all; the only path is the user's
 *                         Regenerate button.
 *
 * "The setting is true" is written `!== false` on purpose. A store
 * written before these keys existed, or a hand-edited one, must not have
 * a feature disabled by a value nobody chose, and the normalisation in
 * database.ts guarantees a boolean is there anyway — this is the
 * belt-and-braces for the window between the two.
 */
function autoQueueAllows(item: { type: AIQueueItem['type']; documentId?: number }): boolean {
  const s = getSettings()
  switch (item.type) {
    case 'score_fit':
      return s.auto_queue_fit !== false
    case 'generate_cv':
      return s.auto_queue_cv !== false
    case 'generate_cover_letter':
      return s.auto_queue_cover_letter !== false
    case 'tailor_job_docs':
      return s.auto_queue_cv !== false && s.auto_queue_cover_letter !== false
    case 'verify': {
      const doc = item.documentId != null ? getDocument(item.documentId) : null
      // No document to classify: let it through. The processor removes
      // such a row on its next pass without calling the model, so
      // nothing is spent either way — and guessing a doc type here
      // would suppress work for the wrong document.
      if (!doc) return true
      return doc.type === 'cv'
        ? s.auto_queue_verify_cv !== false
        : s.auto_queue_verify_cover_letter !== false
    }
    default:
      return true
  }
}

/**
 * May the processor wake this EXISTING row on its own?
 *
 * The narrower question `autoQueueAllows` answers, and the one the three
 * restart lanes actually need. `enqueue` already applied the switch once,
 * at the moment the row was added, so for a row sitting in the store the
 * interesting question is not "would we add this today?" but "is this
 * still the user's work, or is it ours to keep spending on?".
 *
 *   manualQueued === true  → always. A person asked for it, so a revival
 *     or a crash-reclaim finishes work they requested. This is the
 *     behaviour every version had before the revival lanes were gated,
 *     restored for exactly these rows.
 *   anything else          → `autoQueueAllows`, so an automatic row still
 *     consults its switch. Absent is AUTOMATIC (see `AIQueueItem`), which
 *     is what keeps the leak closed for rows written before the field
 *     existed.
 *
 * Deliberately NOT keyed on the switches alone. A row that a person
 * queued by hand must not need its switch on to be retried after a crash
 * or re-run after a failure — that is the promise the whole gate was
 * built to protect, and it applies to the restart lanes as much as to the
 * enqueue.
 */
function mayReviveUnattended(item: AIQueueItem): boolean {
  if (item.manualQueued === true) return true
  return autoQueueAllows(item)
}

export function enqueue(
  item: Omit<AIQueueItem, 'id' | 'createdAt' | 'nextRetryAt' | 'attempts' | 'status' | 'promotedAt' | 'manualQueued' | 'userPresentAt'>,
  opts?: { manual?: boolean; present?: boolean }
): AIQueueItem | null {
  // PROVENANCE and PRESENCE, decided once and from one place, because they
  // are different claims and the code below uses them for different things.
  //
  // `manual` — "a person asked for this". Permanent, recorded on the row as
  // `manualQueued`, and it is what earns the promotion and what the restart
  // lanes read. See `mayReviveUnattended`.
  //
  // `present` — "and they are still waiting for it". Recorded as
  // `userPresentAt`, and it is what the spend cap reads through the
  // processor. NEVER derived from `manual`: a row a person queued once and
  // that then parked for a day has provenance and no presence, which is the
  // distinction `c526332` was refused for collapsing (one click, 12.6x the
  // budget). Every call site passes `present` together with `manual`, and
  // this conjunction keeps that structurally true rather than by review: a
  // grant can never ride on a row the restart lanes would treat as
  // automatic.
  const userAsked = opts?.manual === true
  const userIsPresent = userAsked && opts?.present === true
  // The one line that makes "auto-queue off" mean "the app stops
  // queueing on its own" rather than "the user loses the button":
  // a manual enqueue is a person asking for this work and is never
  // gated. Checked before the duplicate scan so a suppressed automatic
  // enqueue cannot even revive a failed row.
  if (!userAsked && !autoQueueAllows(item)) return null
  // THE JOB HAS TO EXIST. Checked before the duplicate scan for the same
  // reason the auto-queue gate is: a refusal must not revive anything on
  // its way past.
  //
  // `deleteJob` / `deleteJobs` / `dedupeJobs` drop the job's queue rows in
  // the same store write as the job itself, which is the half that stops
  // the queue from spending on a posting the user retracted. This is the
  // other half, and it is a different problem: the row being created now
  // would be one the delete had already removed. The processor's own
  // follow-up chaining is where it happens — a `generate_cv` in flight
  // when the user deletes the job finishes its LLM call and enqueues the
  // review of the document it just built, and a `tailor_job_docs` row
  // fans out one `verify` per document the same way. Those rows describe
  // a job that no longer exists, so they are refused here rather than
  // re-inserted into a queue the user has been shown the back of.
  //
  // Deliberately NOT keyed on `opts.manual`. Every manual entry point is
  // the user naming a job that is on their board (Verify, Regenerate,
  // Tailor / Quick Apply, Generate), and an id that no longer resolves is
  // not something a person can be asking for. Refusing the manual lane
  // here would turn a stale renderer's click into a rejected action
  // rather than a silent no-op, which is a worse failure than the one
  // this prevents — and it would refuse work the user DID ask for in the
  // one race where the job is deleted between them reading the board and
  // pressing the button, on a document that is still in the store.
  if (!getJob(item.jobId)) return null
  const norm = (v: number | string | undefined | null): number | string | null => v ?? null
  // Matches PENDING, PROCESSING AND FAILED.
  //
  // `processing` is the state the processor puts an item in before its
  // LLM call, and it is a long window — a scan finishing, the startup
  // backlog pass, or the fit-auto-score timer can all land inside it.
  // Guarding on `pending` alone let every one of those add a second row
  // for work already in flight, which is how the panel came to show
  // three score_fit entries for one job.
  //
  // `failed` used to be excluded, on the reasoning that re-queueing it
  // is "the recovery path". That is what the duplicate rows were: a
  // failed row stayed AND the next enqueue for the same work added a
  // second, both visible in the panel, for the recovery to be a no-op
  // anyway — the two rows compete for the same 30s poll. Recovery is
  // what the revive below does, and it does it on the row that is
  // already there, which is the one carrying the failure history the
  // user needs to see.
  const existing = getAIQueue().find(
    (q) =>
      q.type === item.type &&
      q.jobId === item.jobId &&
      norm(q.documentId) === norm(item.documentId) &&
      norm(q.sectionName) === norm(item.sectionName)
  )
  if (existing) {
    // One write for the whole hit. A manual re-add of a failed row both
    // revives it and promotes it, and `persistStore` is a full-store
    // encrypt plus an atomic rename on every call — serialised, not
    // coalesced — so two writes here would be two of those. An automatic
    // enqueue that lands on a healthy row changes nothing at all, which
    // is why the write is conditional on there being a patch.
    const patch: Partial<AIQueueItem> = {}
    // `failed`, and `stranded` — the two states a row is in when nobody
    // is going to move it. A stranded row reads `processing`, which is
    // why the duplicate guard matches it at all, but the write it needed
    // was missing: the user pressed Generate on the job, the guard found
    // the row and reported "already queued", `promotedAt` was set, and the
    // row stayed `processing` for ever. No run, no button that moves it,
    // no toast — a button that silently does nothing, sitting next to the
    // Retry that works.
    //
    // A manual re-add revives both, in place, on the row that is already
    // there: one piece of work is one row, and reviving is what the Retry
    // button does, so the two buttons cannot drift. An automatic enqueue
    // still revives neither of these two states beyond the `failed` case
    // it always handled — it has no business interpreting "queued" as
    // "run this again" — which is why the stranded revival is keyed on
    // `opts?.manual`.
    //
    // A row this process is RUNNING is `processing` and not stranded, so
    // it falls through untouched: the guard is right to find it and wrong
    // to revive it, because the run in flight is the request. Queueing it
    // again would be the second copy of the same work the panel's
    // no-Retry-on-a-live-row rule exists to prevent.
    if (existing.status === 'failed' || (userAsked && isStranded(existing))) {
      Object.assign(patch, revivePatch())
    }
    if (userAsked) {
      patch.promotedAt = Date.now()
      // A manual re-add also makes the row MANUAL for the restart lanes.
      // The user has now asked for this work, so a later crash-reclaim or
      // revival is finishing something they requested rather than new
      // unattended spend. Only ever set, never cleared: an automatic
      // enqueue landing on a manual row must not downgrade it.
      patch.manualQueued = true
    }
    // And it makes the row PRESENT, so a press of Generate against a row
    // that is already queued still gets an answer the daily budget cannot
    // refuse. This is the duplicate-path half of the grant: the row existed,
    // so there is nothing new to create, and without this the SECOND press
    // would be the one press the cap could park.
    //
    // One grant per gesture, exactly like the direct buttons: the new
    // `userPresentAt` overwrites rather than accumulating, the processor
    // spends it at the next claim, and three presses before the next pass
    // are worth one claim and one request. A press while the row is already
    // being run by this process is the harmless case: that run IS the
    // answer, and it deletes the row, grant included.
    if (userIsPresent) patch.userPresentAt = Date.now()
    if (Object.keys(patch).length > 0) updateAIQueueItem(existing.id, patch)
    return null
  }
  // Written explicitly as `false`, not left absent: absent is the legacy
  // spelling and this is a fresh row, so recording the origin now is what
  // lets the restart lanes tell it from a pre-existing one later.
  //
  // `userPresentAt` is written only when it is real. Absent on every
  // automatic row and on every automatic re-add, which is the direction that
  // matters: the spend cap's exemption is reachable from a click and from
  // nothing else.
  return addAIQueueItem({
    ...item,
    manualQueued: userAsked,
    ...(userIsPresent ? { userPresentAt: Date.now() } : {})
  })
}
