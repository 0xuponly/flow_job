import { getAIQueue, updateAIQueueItem, removeAIQueueItem, addAIQueueItem, clearAIQueue, getDocument, getJob, getSettings, listJobDocuments, getDocumentAutoRegenAttempts, bumpDocumentAutoRegenAttempts } from './database'
import { log } from './logger'
import { withAiOperation } from './ai'
import { tailorDocument, regenerateSection, verifyDocumentContent, RateLimitError } from './ai'
import type { AIQueueItem, Job, QueueItemView } from './types'
import { AUTO_REGEN_MAX, AUTO_REVIVE_COOLDOWN_MS, AUTO_REVIVE_MAX, PASSING_REVIEW_SCORE } from './types'

function backoffMs(item: AIQueueItem): number {
  // exponential backoff: 30s, 60s, 2m, 4m, 8m, 16s, 30m cap
  const base = 30000
  const max = 1800000
  return Math.min(base * Math.pow(2, item.attempts), max)
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
    return { ...item, jobTitle: job?.title ?? null, jobCompany: job?.company ?? null }
  })
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
    if (!updateAIQueueItem(item.id, { status: 'processing', promotedAt: undefined })) return

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
        const result = await tailorDocument({
          job_id: item.jobId,
          document_type: docType,
          document_id: item.documentId
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
        await regenerateSection(item.documentId, item.sectionName, item.jobId, item.extraContext)
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
        const result = await verifyDocumentContent(item.jobId, item.documentId, doc.type)
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
          () => epoch !== clearEpoch
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
        await tailorJobDocsForJob(item.jobId)
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
    const isRateLimit = err instanceof RateLimitError

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

    const attempts = item.attempts + 1
    if (isRateLimit && attempts < 10) {
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
      const autoRevives = item.autoRevives ?? 0
      if (autoRevives < AUTO_REVIVE_MAX) {
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
 */
export function reclaimInterruptedItems(): void {
  for (const item of getAIQueue()) {
    if (item.status !== 'processing') continue
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
  if (processorTimer) {
    clearInterval(processorTimer)
    processorTimer = null
  }
}

export { RateLimitError }

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

  // An item parked by the auto-revival loop is already `pending` with a
  // future nextRetryAt, so the first clause picks it up once its
  // cooldown elapses. The second clause covers rows that reached
  // `failed` some other way (before auto-revival shipped, or via the
  // retry path) and have no revival scheduled — those are revived here
  // rather than left stranded.
  const due: AIQueueItem[] = []
  for (const q of queue) {
    if (q.nextRetryAt > now) continue
    if (q.status === 'pending') {
      due.push(q)
    } else if (q.status === 'failed' && revive(q)) {
      // Reviving writes the fresh counters to the row, then processes
      // the same shape in memory. Without the in-memory half the item
      // would be processed with its exhausted `attempts` and fail
      // straight back to `failed` on its very first attempt.
      updateAIQueueItem(q.id, {
        status: 'pending',
        attempts: 0,
        autoRevives: (q.autoRevives ?? 0) + 1
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
    autoRevives: (item.autoRevives ?? 0) + 1
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
    lastError: undefined
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
 */
export function retryQueueItem(id: number): QueueItemView[] {
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
 * triggers (fit lands, then a re-scan, then the 4h autoscore tick), the
 * startup backlog, and a manual re-add all resolve to the same single
 * row.
 *
 * On a hit the row is brought back to life rather than left alone:
 * a `failed` row is revived in place (`revivePatch` — the same write
 * the Retry button makes, so the two cannot drift), and a `manual`
 * enqueue additionally promotes it. Both are only reachable when the
 * work already has a row, so neither can invent one.
 *
 * `manual: true` is the caller's claim that a person asked for this
 * (the direct Verify / Regenerate / Tailor / Quick Apply actions). It
 * is what earns the promotion; automatic re-adds — the fit-landing
 * trigger, the scan-time auto-tailor, the 4h re-seeder, the processor's
 * own follow-up chaining — deliberately do not promote, or every
 * background tick would reshuffle the queue under the user.
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
 *  1. It cannot be bypassed. There are five automatic producers of
 *     work today (the fit-landing trigger in fitScorer, the scan-time
 *     auto-tailor in jobSearch, the processor's own generation→review
 *     chaining and its review→regenerate loop in this file, and the two
 *     fit re-seeders in fitAutoScore) and more arrive with every feature
 *     that queues work. A per-call-site check is a rule that only holds
 *     for the callers that remembered it.
 *  2. A refusal has to be uniform. If two callers disagreed about
 *     whether a type was gated, "is this queued?" would have two
 *     answers and no test could pin it down.
 *
 * What the settings do NOT do is stop the user. Every entry point a
 * person triggers passes `{ manual: true }`, and that flag short-circuits
 * this function before a single setting is read. The full inventory,
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

export function enqueue(
  item: Omit<AIQueueItem, 'id' | 'createdAt' | 'nextRetryAt' | 'attempts' | 'status' | 'promotedAt'>,
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
    if (existing.status === 'failed') Object.assign(patch, revivePatch())
    if (opts?.manual) patch.promotedAt = Date.now()
    if (Object.keys(patch).length > 0) updateAIQueueItem(existing.id, patch)
    return null
  }
  return addAIQueueItem(item)
}
