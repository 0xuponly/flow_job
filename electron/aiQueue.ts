import { getAIQueue, updateAIQueueItem, removeAIQueueItem, addAIQueueItem, getDocument } from './database'
import { tailorDocument, regenerateSection, verifyDocumentContent, RateLimitError } from './ai'
import type { AIQueueItem } from './types'

function backoffMs(item: AIQueueItem): number {
  // exponential backoff: 30s, 60s, 2m, 4m, 8m, 16m, 30m cap
  const base = 30000
  const max = 1800000
  return Math.min(base * Math.pow(2, item.attempts), max)
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
        await verifyDocumentContent(item.jobId, item.documentId, doc.type)
        removeAIQueueItem(item.id)
        break
      }
      case 'score_fit': {
        // Lazy import breaks the main.ts <-> aiQueue.ts static cycle.
        // scoreOneJobInBackground returns the updated job, or null when
        // the job was deleted mid-run. score === null means the LLM
        // scorer failed and the heuristic fallback stamped no score —
        // throw so the caller's backoff path retries it later.
        const { scoreOneJobInBackground } = await import('./main')
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
        removeAIQueueItem(item.id)
        break
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    const isRateLimit = err instanceof RateLimitError

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
      updateAIQueueItem(item.id, {
        status: 'failed',
        attempts,
        lastError: msg
      })
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
  const pending = queue.filter(
    (q) => q.status === 'pending' && q.nextRetryAt <= now
  )
  for (const item of pending) {
    await processItem(item)
  }
}

/**
 * Enqueue a task. If a duplicate is already pending (same type + jobId + documentId + sectionName),
 * skip to avoid piling up identical retries.
 */
export function enqueue(item: Omit<AIQueueItem, 'id' | 'createdAt' | 'nextRetryAt' | 'attempts' | 'status'>): AIQueueItem | null {
  const existing = getAIQueue().find(
    (q) =>
      q.status === 'pending' &&
      q.type === item.type &&
      q.jobId === item.jobId &&
      q.documentId === item.documentId &&
      q.sectionName === item.sectionName
  )
  if (existing) return null
  return addAIQueueItem(item)
}