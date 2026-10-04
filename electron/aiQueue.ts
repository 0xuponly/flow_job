import { getAIQueue, updateAIQueueItem, removeAIQueueItem, addAIQueueItem, clearAIQueue, getDocument, getJob, getSettings, listJobDocuments, getDocumentAutoRegenAttempts, bumpDocumentAutoRegenAttempts, setDocumentContent, writeTailorTimingFields, recomputeJobStatusFromDocs } from './database'
import { log } from './logger'
import { withAiOperation } from './ai'
// ONE import from './ai', deliberately: the two "don't charge an attempt for
// a condition that made no request" mechanisms are siblings, so the module
// that has to tell them apart needs both of their types and both of their
// clocks in the same scope.
import { tailorDocument, regenerateSection, verifyDocumentContent, nextProviderCapFreeAt, ProviderCapError, ProviderCooldownError, providerAvailability, RateLimitError, type AiCallOptions } from './ai'
import { PROVIDERS_COOLING_DOWN_MESSAGE } from './cooldownBlock'
import type { AIQueueItem, Job, QueueItemView } from './types'
import { AUTO_REGEN_MAX, AUTO_REVIVE_COOLDOWN_MS, AUTO_REVIVE_MAX, PASSING_REVIEW_SCORE } from './types'

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
 */
export interface AIQueueBlockedState {
  blocked: boolean
  /** Epoch ms the first eligible provider frees up, uncapped. */
  providerFreeAt: number | null
  /** Epoch ms the queue will actually wake, i.e. providerFreeAt clamped. */
  retryAt: number | null
  /** Rows parked on the provider clock right now. */
  waitingRows: number
  /** Their ids, so the panel can mark them apart from ordinary pending rows. */
  blockedRowIds: number[]
}

export function aiQueueBlockedState(now: number = Date.now()): AIQueueBlockedState {
  const availability = providerAvailability(now)
  const parked = availability.blocked
    ? getAIQueue().filter((q) => q.status === 'pending' && q.blockedSince !== undefined)
    : []
  const freeAt = availability.nextAvailableAt
  return {
    blocked: availability.blocked,
    providerFreeAt: freeAt,
    retryAt: freeAt === null ? null : now + providerBlockedWaitMs(freeAt, now, 1),
    waitingRows: parked.length,
    blockedRowIds: parked.map((q) => q.id)
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
  // Who asked for this item. The row already records it (`manualQueued`,
  // written by `enqueue({ manual: true })` from the five user entry points
  // in main.ts), and it is the SAME division the auto-queue switches draw:
  // the app may stop spending on its own, and never stops the user.
  //
  // Read once, here, and handed to every AI call this item makes, because
  // the spend cap (ai.ts) is enforced on automated work only — a cap that
  // also refused the user's own Regenerate would be the dead end the whole
  // manual/automated split exists to avoid. Absent means automated, which is
  // the safe direction: an item from before the field existed is treated as
  // the app's own work and therefore capped.
  const opts: AiCallOptions = { manual: item.manualQueued === true }
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
    if (!updateAIQueueItem(item.id, {
      status: 'processing',
      promotedAt: undefined,
      parkedReason: undefined,
      blockedSince: undefined,
      blockedCount: undefined
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
        // the job was deleted mid-run. score === null means the LLM
        // scorer failed and the heuristic fallback stamped no score —
        // throw so the caller's backoff path retries it later.
        const { scoreOneJobInBackground } = await import('./fitScorer')
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
        if (updated.score == null) {
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
        await tailorJobDocsForJob(item.jobId, opts)
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
    } else if (isRateLimit && attempts < 10) {
      updateAIQueueItem(item.id, {
        status: 'pending',
        attempts,
        lastError: msg,
        nextRetryAt: Date.now() + backoffMs({ ...item, attempts })
      })
    } else if (item.type === 'score_fit' && !isRateLimit && attempts < 5) {
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
 * (5 for score_fit, 10 for rate limits), so an item that has already
 * exhausted its budget would otherwise be re-run exactly once and then
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
  updateAIQueueItem(id, revivePatch())
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
 *  1. It cannot be bypassed. There are six automatic producers of
 *     work today (the fit-landing trigger in fitScorer, the processor's
 *     own generation→review chaining, its review→regenerate loop and its
 *     tailor_job_docs→review fan-out in this file, the fit
 *     re-seeder in fitAutoScore, and the documents backlog sweep in
 *     docsAutoQueue) and more arrive with every feature
 *     that queues work. A per-call-site check is a rule that only holds
 *     for the callers that remembered it.
 *  2. A refusal has to be uniform. If two callers disagreed about
 *     whether a type was gated, "is this queued?" would have two
 *     answers and no test could pin it down.
 *
 * What the settings do NOT do is stop the user. Every entry point a
 * person triggers passes `{ manual: true }`, and that flag short-circuits
 * this function before a single setting is read — and, via
 * `mayReviveUnattended`, it carries past the enqueue so the user's own
 * rows keep their restart behaviour too. The full inventory,
 * which is what makes "manual" trustworthy rather than a convention:
 *
 *   main.ts  documents:verify            → verify            (Verify button)
 *   main.ts  documents:regenerateSection → regenerate_section (Regenerate)
 *   main.ts  ai:tailor                   → generate_cv /     (Tailor /
 *                                          generate_cover_letter  Generate)
 *   main.ts  tailor:quickApply           → tailor_job_docs   (Quick Apply)
 *
 * All four are rate-limit fallbacks: the handler tries the AI call
 * directly first and only queues when the provider is throttling, at
 * which point "a person asked for this" is the whole truth of the
 * matter. There are no others — `rg -n "enqueue\(" electron src` is the
 * check, and aiQueue.autoQueue.test.ts pins both halves of every row of
 * that table.
 *
 * THAT INVENTORY IS NOT COMPLETE, and the gap is where a switch-off
 * leaks. `rg "enqueue\("` counts call sites, so it is blind to the
 * paths that queue work without calling `enqueue`. Four exist:
 *
 *   runPass's revival of a `failed` row   (the 4h auto-revive cooldown)
 *   processItem's failure-path reschedule (the same cooldown, parked)
 *   reclaimInterruptedItems at startup   (a row stranded `processing`)
 *   fitAutoScore.runFitAutoScoreBacklog  (resurrects failed score_fit
 *                                         rows itself, by design)
 *
 * All four consult the same rule rather than re-deriving it, but the
 * restart lanes ask a NARROWER question than `enqueue` does, via
 * `mayReviveUnattended`: a MANUAL row — one a person queued, recorded on
 * the row as `manualQueued` — keeps every restart behaviour it always had,
 * because a revival or a crash-reclaim finishes work they asked for. Only
 * an AUTOMATIC row consults the switch, and absent means automatic, which
 * is what keeps the leak closed for rows written before the field existed.
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
  item: Omit<AIQueueItem, 'id' | 'createdAt' | 'nextRetryAt' | 'attempts' | 'status' | 'promotedAt' | 'manualQueued'>,
  opts?: { manual?: boolean }
): AIQueueItem | null {
  // The one line that makes "auto-queue off" mean "the app stops
  // queueing on its own" rather than "the user loses the button":
  // a manual enqueue is a person asking for this work and is never
  // gated. Checked before the duplicate scan so a suppressed automatic
  // enqueue cannot even revive a failed row.
  if (!opts?.manual && !autoQueueAllows(item)) return null
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
    if (existing.status === 'failed' || (opts?.manual && isStranded(existing))) {
      Object.assign(patch, revivePatch())
    }
    if (opts?.manual) {
      patch.promotedAt = Date.now()
      // A manual re-add also makes the row MANUAL for the restart lanes.
      // The user has now asked for this work, so a later crash-reclaim or
      // revival is finishing something they requested rather than new
      // unattended spend. Only ever set, never cleared: an automatic
      // enqueue landing on a manual row must not downgrade it.
      patch.manualQueued = true
    }
    if (Object.keys(patch).length > 0) updateAIQueueItem(existing.id, patch)
    return null
  }
  // Written explicitly as `false`, not left absent: absent is the legacy
  // spelling and this is a fresh row, so recording the origin now is what
  // lets the restart lanes tell it from a pre-existing one later.
  return addAIQueueItem({ ...item, manualQueued: opts?.manual === true })
}
