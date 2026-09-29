import { getAIQueue, updateAIQueueItem, removeAIQueueItem, addAIQueueItem, getDocument, getJob, listDocuments, getDocumentAutoRegenAttempts, bumpDocumentAutoRegenAttempts } from './database'
import { log } from './logger'
import { tailorDocument, regenerateSection, verifyDocumentContent, RateLimitError } from './ai'
import type { AIQueueItem } from './types'
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
 */
function priorityTier(type: AIQueueItem['type']): number {
  return type === 'score_fit' ? 0 : 1
}

/**
 * The full queue in the order the processor will actually pick it.
 *
 * The renderer's Queue panel displays this so the user sees the true
 * upcoming order rather than raw store order — a high-fit generation
 * item is picked ahead of a lower-fit one, and every `score_fit` item
 * is picked first. Reuses `pickOrder` instead of re-deriving the sort
 * in the renderer, so the displayed order cannot drift from the
 * executed order.
 *
 * Unlike `processQueue` this does not mutate any item's status: it is
 * a read-only view for display. Ordering re-reads `job.score` on each
 * call, so a fit that lands between polls is reflected on the next one.
 */
export function listQueueInPickOrder(): AIQueueItem[] {
  return pickOrder(getAIQueue())
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

async function processItem(item: AIQueueItem): Promise<void> {
  updateAIQueueItem(item.id, { status: 'processing' })

  try {
    switch (item.type) {
      case 'generate_cv':
      case 'generate_cover_letter': {
        const docType = item.type === 'generate_cv' ? 'cv' : 'cover_letter'
        await tailorDocument({ job_id: item.jobId, document_type: docType })
        removeAIQueueItem(item.id)
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
          const attemptsSoFar = getDocumentAutoRegenAttempts(item.documentId)
          if (attemptsSoFar >= AUTO_REGEN_MAX) {
            // Cap reached: stop auto-looping. The document keeps its
            // sub-80 verification_score, which is already what the
            // user sees, so it is flagged for manual attention
            // without needing a separate flag column.
            return
          }
          const next = bumpDocumentAutoRegenAttempts(item.documentId)
          if (next > AUTO_REGEN_MAX) return
          enqueue({
            type: doc.type === 'cv' ? 'generate_cv' : 'generate_cover_letter',
            jobId: item.jobId
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
        const updated = await scoreOneJobInBackground(item.jobId)
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
        for (const doc of listDocuments(item.jobId)) {
          enqueue({ type: 'verify', jobId: item.jobId, documentId: doc.id })
        }
        break
      }
    }
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

export function startQueueProcessor(intervalMs = 30000): void {
  if (processorTimer) return
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
  for (const item of pickOrder(due)) {
    await processItem(item)
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
 * Put a failed (or otherwise stalled) item back in line for processing.
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
 * Returns the queue in pick order so the caller can hand the refreshed
 * list straight back to the renderer.
 */
export function retryQueueItem(id: number): AIQueueItem[] {
  updateAIQueueItem(id, {
    status: 'pending',
    nextRetryAt: Date.now(),
    attempts: 0,
    lastError: undefined
  })
  return listQueueInPickOrder()
}

/**
 * Enqueue a task. If an identical item is already pending (same type +
 * jobId + documentId + sectionName), skip so repeated triggers (fit
 * lands, then a re-scan, then the 4h autoscore tick) do not stack
 * duplicate work.
 *
 * `documentId` / `sectionName` are compared with a null-normalising
 * helper: rows created before those fields existed store them as
 * `null`, while a fresh `enqueue({...})` call simply omits them
 * (`undefined`). Without normalisation the two spellings of "no
 * document" would not match and the duplicate guard would silently
 * stop working.
 */
export function enqueue(item: Omit<AIQueueItem, 'id' | 'createdAt' | 'nextRetryAt' | 'attempts' | 'status'>): AIQueueItem | null {
  const norm = (v: number | string | undefined | null): number | string | null => v ?? null
  const existing = getAIQueue().find(
    (q) =>
      q.status === 'pending' &&
      q.type === item.type &&
      q.jobId === item.jobId &&
      norm(q.documentId) === norm(item.documentId) &&
      norm(q.sectionName) === norm(item.sectionName)
  )
  if (existing) return null
  return addAIQueueItem(item)
}