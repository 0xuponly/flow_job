import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AIQueueItem, AIQueueItemStatus, AIQueueItemType, Job } from './types'

// One row per piece of work, and a manual re-add that promotes rather
// than duplicates.
//
// The store here is a LIVE one, not a spy: the bug being pinned is
// "how many rows does this queue end up holding", which a mocked
// getAIQueue cannot answer. aiQueue.test.ts answers the same question
// with a fixed return value per test, so it can only assert on the
// writes; this file lets a test read the queue back after an enqueue,
// after a revive, and after a whole processing pass.

const store = vi.hoisted(() => ({
  rows: [] as AIQueueItem[],
  nextId: 1,
  // jobId -> fit score, the input pickOrder reads at pick time.
  fit: new Map<number, number>(),
  writes: [] as { id: number; patch: Partial<AIQueueItem> }[]
}))

vi.mock('./database', () => ({
  // The processor's provider-health gate reads this before it claims a
  // row; an empty pool answers "not blocked" so these cases exercise the
  // pass itself. See queueCooldown.test.ts for the blocked half.
  listApiModels: () => [],
  // The auto-queue gate in enqueue() reads these; all true = every
  // automatic enqueue allowed, which is the shipped default. The
  // switches themselves are covered against the real store in
  // aiQueue.autoQueue.test.ts.
  getSettings: () => ({
    // Read by the `score_fit` case to ask whether a verdict was computed
    // against the CV in force; 1 matches the stubbed scorer above.
    cv_version: 1,
    auto_queue_fit: true,
    auto_queue_cv: true,
    auto_queue_cover_letter: true,
    auto_queue_verify_cv: true,
    auto_queue_verify_cover_letter: true
  }),
  getAIQueue: () => store.rows,
  addAIQueueItem: (item: Partial<AIQueueItem>) => {
    const row: AIQueueItem = {
      ...(item as object),
      id: store.nextId++,
      status: 'pending',
      attempts: 0,
      createdAt: Date.now(),
      nextRetryAt: Date.now()
    } as AIQueueItem
    store.rows.push(row)
    return row
  },
  updateAIQueueItem: (id: number, patch: Partial<AIQueueItem>) => {
    const idx = store.rows.findIndex((r) => r.id === id)
    if (idx === -1) return false
    store.writes.push({ id, patch })
    store.rows[idx] = { ...store.rows[idx], ...patch }
    return true
  },
  removeAIQueueItem: (id: number) => {
    store.rows = store.rows.filter((r) => r.id !== id)
  },
  clearAIQueue: () => {
    const n = store.rows.length
    store.rows = []
    return n
  },
  getJob: (id: number) => ({ id, score: store.fit.get(id) ?? null }) as Job,
  getDocument: (id: number) => ({ id, job_id: 1, type: 'cv' }) as never,
  listJobDocuments: () => [],
  getDocumentAutoRegenAttempts: () => 0,
  bumpDocumentAutoRegenAttempts: () => 1,
  recomputeJobStatusFromDocs: () => undefined,
  // Per-provider spend ledger + the cap constants that ai.ts imports at
  // module scope. A partial ./database mock that omits them makes the
  // import fail outright, which surfaces as every assertion in the file
  // failing for a reason that has nothing to do with this file.
  DEFAULT_PROVIDER_CALL_CAP: 50,
  MIN_PROVIDER_CALL_CAP: 1,
  MAX_PROVIDER_CALL_CAP: 100000,
  PROVIDER_SPEND_WINDOW_MS: 86400000,
  recordProviderCall: vi.fn(),
  getProviderSpend: vi.fn(() => ({})),
  clearProviderSpend: vi.fn(),

}))

// The AI layer is stubbed rather than the real one: these tests are
// about queue bookkeeping, and `withAiOperation` is a no-op wrapper here
// so a pass is not serialised behind anything.
vi.mock('./ai', () => {
  // Declared inside the factory, not as sibling properties of the returned
  // object: a hoisted mock factory cannot close over module-level bindings,
  // and a property key is not a binding either.
  //
  // The hierarchy is the real one, because `processItem` branches on it:
  // both refusals extend `RateLimitError`, so a stub that made them
  // unrelated would let a row fall into the ten-attempt ladder for a
  // condition that is supposed to cost nothing.
  class RateLimitError extends Error {}
  class ProviderCapError extends RateLimitError {}
  class ProviderCooldownError extends RateLimitError {}
  return {
    withAiOperation: (fn: () => unknown) => fn(),
    verifyDocumentContent: vi.fn(async () => ({ kind: 'review', score: 90, passed: true, feedback: '', rules: [] })),
    tailorDocument: vi.fn(async () => ({ content: 'x', document_id: 1 })),
    regenerateSection: vi.fn(async () => 'x'),
    RateLimitError,
    // The cap lane. `aiQueue` reads the class to decide a refusal is a park
    // rather than a retry, and asks the ledger when the budget frees; a full
    // `./ai` mock has to carry both or the pass throws on an undefined export.
    ProviderCapError,
    nextProviderCapFreeAt: vi.fn(() => null),
    // The block lane, same obligation: the class the processor checks FIRST,
    // and the pre-flight gate it consults before claiming a row. "Not
    // blocked" here so these cases exercise the pass itself; the blocked half
    // needs a real health map and is in queueCooldown.test.ts.
    ProviderCooldownError,
    providerAvailability: () => ({ blocked: false, nextAvailableAt: null, eligibleCount: 1 })
  }
})

vi.mock('./fitScorer', () => ({
  // The three verdict fields travel together because the store only ever
  // writes them together, and `score_fit` retires its row only when the job
  // carries all three (see `hasCurrentFitVerdict`). `cv_version: 1` in the
  // settings stub below is the other half of that pair.
  scoreOneJobInBackground: vi.fn(async () => ({
    id: 1, score: 0.8, fit_source: 'llm', fit_score_version: 1
  }) as unknown as Job),
  // The case's own question, re-implemented rather than imported: the real
  // module drags its own database / queue imports into a file that stubs
  // both. Unit-tested against the real function in fitScorer.test.ts.
  hasCurrentFitVerdict: (job: Job, cvVersion: number): boolean =>
    job.score != null && job.fit_source === 'llm' && job.fit_score_version === cvVersion
}))

vi.mock('./tailorJobDocs', () => ({
  tailorJobDocsForJob: vi.fn(async () => ({ cvId: 1, clId: 2, ms_cv: 0, ms_cl: 0, refused: null }))
}))

vi.mock('./logger', () => ({
  log: { ai: { error: vi.fn() }, startup: { info: vi.fn(), warn: vi.fn() } }
}))

import { enqueue, listQueueInPickOrder, retryQueueItem, processQueue } from './aiQueue'
import { scoreOneJobInBackground } from './fitScorer'
import { verifyDocumentContent } from './ai'

const mockedScore = vi.mocked(scoreOneJobInBackground)

/** A row already in the store, bypassing enqueue so status is explicit. */
function seedRow(overrides: Partial<AIQueueItem> = {}): AIQueueItem {
  const row: AIQueueItem = {
    id: store.nextId++,
    type: 'verify',
    jobId: 1,
    status: 'pending',
    attempts: 0,
    createdAt: Date.now(),
    nextRetryAt: 0,
    ...overrides
  } as AIQueueItem
  store.rows.push(row)
  return row
}

/** Every row's id, in the order the processor (and the panel) will take them. */
function pickOrderIds(): number[] {
  return listQueueInPickOrder().map((i) => i.id)
}

beforeEach(() => {
  store.rows = []
  store.nextId = 1
  store.fit.clear()
  store.writes = []
  mockedScore.mockReset().mockResolvedValue({
    id: 1, score: 0.8, fit_source: 'llm', fit_score_version: 1
  } as unknown as Job)
})

describe('one row per piece of work, whatever status the existing row is in', () => {
  const statuses: AIQueueItemStatus[] = ['pending', 'processing', 'failed']

  for (const status of statuses) {
    it(`leaves exactly one ${status} row after repeated enqueues of the same work`, () => {
      seedRow({ type: 'regenerate_section', jobId: 4, documentId: 9, sectionName: 'Summary', status })
      // Three more triggers for the same work: a fit landing, a re-scan,
      // the hourly autoscore tick.
      for (let i = 0; i < 3; i++) {
        expect(enqueue({ type: 'regenerate_section', jobId: 4, documentId: 9, sectionName: 'Summary' })).toBeNull()
      }
      expect(store.rows).toHaveLength(1)
      expect(store.rows[0].id).toBe(1)
    })
  }

  it('leaves one row when the same work is enqueued under every status in turn', () => {
    seedRow({ type: 'score_fit', jobId: 42, status: 'pending' })
    for (const status of statuses) {
      store.rows[0].status = status
      enqueue({ type: 'score_fit', jobId: 42 })
    }
    expect(store.rows).toHaveLength(1)
  })

  it('applies the same rule to every queue type', () => {
    const types: AIQueueItemType[] = [
      'generate_cv', 'generate_cover_letter', 'regenerate_section', 'verify', 'tailor_job_docs', 'score_fit'
    ]
    types.forEach((type, i) => {
      store.rows = []
      store.nextId = 1
      // Half seeded `processing`, half `failed`: the guard is the same
      // rule for all of them, and the status is not what makes the work
      // the same.
      seedRow({ type, jobId: 7, status: i % 2 === 0 ? 'processing' : 'failed' })
      enqueue({ type, jobId: 7 })
      enqueue({ type, jobId: 7 }, { manual: true })
      expect(store.rows, type).toHaveLength(1)
      expect(store.rows[0].id, type).toBe(1)
    })
  })

  it('still queues work that is genuinely different', () => {
    // Same job, different work: a review of one document, a rebuild of
    // another, and whole-job generation are three rows, not one.
    enqueue({ type: 'verify', jobId: 7, documentId: 11 })
    enqueue({ type: 'verify', jobId: 7, documentId: 12 })
    enqueue({ type: 'generate_cv', jobId: 7, documentId: 11 })
    enqueue({ type: 'regenerate_section', jobId: 7, documentId: 11, sectionName: 'Summary' })
    enqueue({ type: 'tailor_job_docs', jobId: 7 })
    enqueue({ type: 'score_fit', jobId: 7 })
    expect(store.rows).toHaveLength(6)
  })

  it('matches a legacy row that spells "no document" as null against a call that omits it', () => {
    // Rows written before documentId existed store null; a fresh call
    // omits the field. Without the norm() helper those are different
    // work and the guard silently stops working.
    seedRow({ type: 'verify', jobId: 7, documentId: null as unknown as number, sectionName: null as unknown as string })
    expect(enqueue({ type: 'verify', jobId: 7 })).toBeNull()
    expect(store.rows).toHaveLength(1)
  })

  it('reports the created row for new work and null for a duplicate', () => {
    // The contract every caller reads: null means "not newly added".
    const created = enqueue({ type: 'score_fit', jobId: 42 })
    expect(created).not.toBeNull()
    expect(created?.id).toBe(1)
    expect(enqueue({ type: 'score_fit', jobId: 42 })).toBeNull()
  })
})

describe('a failed row is revived in place rather than re-added', () => {
  it('revives the SAME row: same id, pending, attempts reset, error cleared', () => {
    const failed = seedRow({
      type: 'score_fit', jobId: 42, status: 'failed', attempts: 5, lastError: 'provider down'
    })
    expect(enqueue({ type: 'score_fit', jobId: 42 })).toBeNull()
    expect(store.rows).toHaveLength(1)
    const row = store.rows[0]
    expect(row.id).toBe(failed.id)
    expect(row.status).toBe('pending')
    expect(row.attempts).toBe(0)
    expect(row.lastError).toBeUndefined()
  })

  it('makes the revived row due immediately, not on the old backoff', () => {
    seedRow({ type: 'score_fit', jobId: 42, status: 'failed', attempts: 5, nextRetryAt: Date.now() + 3_600_000 })
    // The upper bound is read *after* the enqueue. `revivePatch()` stamps
    // `nextRetryAt: Date.now()`, so a clock reading taken beforehand is by
    // construction earlier than the stamp and the two only agree when the
    // whole call lands inside one millisecond. Burning ~3ms of wall clock
    // between the two reads makes the old form of this assertion fail every
    // time; the contract the queue implements is that the row is due now,
    // which is `nextRetryAt <= now` at aiQueue.ts:515.
    const before = Date.now()
    enqueue({ type: 'score_fit', jobId: 42 })
    expect(store.rows[0].nextRetryAt).toBeLessThanOrEqual(Date.now())
    expect(store.rows[0].nextRetryAt).toBeGreaterThanOrEqual(before)
  })

  it('leaves the auto-revive counter alone', () => {
    // `autoRevives` is the processor's own budget for recovering on its
    // own. A human asking for the work to run again is outside it — the
    // same contract the Retry button has always had — so a revive must
    // not quietly spend a unit of it, or a job that failed a few times
    // would stop responding to being re-added.
    seedRow({ type: 'score_fit', jobId: 42, status: 'failed', attempts: 5, autoRevives: 3 })
    enqueue({ type: 'score_fit', jobId: 42 })
    expect(store.rows[0].autoRevives).toBe(3)
  })

  it('writes the revive patch, and the presence grant the re-add cannot', () => {
    // One definition of "give this row another run" — but ONE DIFFERENCE, and
    // it is the whole point of the two flags being separate.
    //
    // `revivePatch()` is shared, so the revive itself cannot drift. What a
    // press of RETRY adds on top is `userPresentAt`: the row's provenance is
    // untouched (it keeps whatever origin it had — Retry does not make an
    // automatic row manual, which would change the restart lanes), but the
    // row is now owed an answer by a person, so its next claim must be one
    // the daily spend cap cannot refuse. An AUTOMATIC re-add has no person
    // waiting, so it gets no grant — and if it did, the fit-landing trigger
    // or the backlog sweep could buy itself an uncapped request, which is the
    // 12.6x measured on 2026-10-05.
    seedRow({ type: 'score_fit', jobId: 42, status: 'failed' })
    const before = Date.now()
    enqueue({ type: 'score_fit', jobId: 42 })
    const viaEnqueue = store.writes[0].patch
    store.writes = []
    seedRow({ id: 2, type: 'score_fit', jobId: 43, status: 'failed' })
    retryQueueItem(2)
    const viaRetry = store.writes[0].patch

    // Every field except the deadline has to match exactly. `nextRetryAt` is
    // `Date.now()` read independently by each call, so a whole-patch
    // `toEqual` fails whenever the millisecond ticks between the two writes --
    // which is what a descheduled worker makes happen, and it did: this was
    // the one remaining intermittent failure in a 16-spinner run. The
    // deadline is checked separately, against the clock, below.
    const { nextRetryAt: enqueueAt, ...enqueueRest } = viaEnqueue
    const { nextRetryAt: retryAt, userPresentAt: retryGrant, ...retryRest } = viaRetry
    expect(retryRest).toEqual(enqueueRest)
    // The one difference, named: presence, and it is a real timestamp rather
    // than a placeholder.
    expect(typeof retryGrant).toBe('number')
    expect(retryGrant).toBeGreaterThanOrEqual(before)
    // ...and it is ABSENT from the automatic re-add, so "absent means nobody
    // is waiting" is not merely a convention this file happens to follow.
    expect('userPresentAt' in viaEnqueue).toBe(false)
    // Both deadlines are "now" rather than a backoff or the old nextRetryAt,
    // which is the property the deadline is there to carry. Read the clock
    // after both calls so the comparison cannot lose a millisecond to a tick,
    // and bound the other end so a deadline from before this test cannot pass
    // as "now" either.
    const after = Date.now()
    expect(before).toBeLessThanOrEqual(Number(enqueueAt))
    expect(before).toBeLessThanOrEqual(Number(retryAt))
    expect(Number(enqueueAt)).toBeLessThanOrEqual(after)
    expect(Number(retryAt)).toBeLessThanOrEqual(after)
    // And the two paths stamp the same instant, not merely a plausible one.
    // "Both are now" was strictly weaker than comparing the whole patch: a path
    // that stamped `Date.now() - 60_000`, a minute-old deadline the checks above
    // cannot see, passed that and fails this. 1s is three orders of magnitude
    // above the millisecond tick that made the original flake, and both reads
    // happen inside one synchronous test body, so only a stall longer than a
    // second separates them.
    expect(Number(enqueueAt)).toBeGreaterThanOrEqual(after - 1_000)
    expect(Math.abs(Number(enqueueAt) - Number(retryAt))).toBeLessThan(1_000)
  })

  it('does not write at all when an automatic enqueue lands on a healthy row', () => {
    // The common case — a background tick hitting work already queued.
    // Every store write is a full-store encrypt plus an atomic rename,
    // so a hit that changes nothing must not cause one.
    seedRow({ type: 'score_fit', jobId: 42, status: 'pending' })
    enqueue({ type: 'score_fit', jobId: 42 })
    expect(store.writes).toEqual([])
    store.rows[0].status = 'processing'
    enqueue({ type: 'score_fit', jobId: 42 })
    expect(store.writes).toEqual([])
  })

  it('revives and promotes a failed row in a single write', () => {
    seedRow({ type: 'verify', jobId: 7, documentId: 11, status: 'failed', attempts: 2 })
    enqueue({ type: 'verify', jobId: 7, documentId: 11 }, { manual: true })
    expect(store.writes).toHaveLength(1)
    expect(store.writes[0].patch).toMatchObject({
      status: 'pending', attempts: 0, lastError: undefined
    })
    expect(store.writes[0].patch.promotedAt).toBeGreaterThan(0)
  })

  it('revives on a manual re-add too, and promotes it', () => {
    seedRow({ type: 'verify', jobId: 7, documentId: 11, status: 'failed', attempts: 2, lastError: 'x' })
    expect(enqueue({ type: 'verify', jobId: 7, documentId: 11 }, { manual: true })).toBeNull()
    expect(store.rows).toHaveLength(1)
    expect(store.rows[0].status).toBe('pending')
    expect(store.rows[0].attempts).toBe(0)
    expect(store.rows[0].promotedAt).toBeGreaterThan(0)
  })
})

describe('a manual re-add promotes to the top of its tier', () => {
  it('moves a re-added pending item above its tier siblings', () => {
    for (const jobId of [1, 2, 3]) store.fit.set(jobId, 0.5)
    seedRow({ type: 'verify', jobId: 1 })
    seedRow({ type: 'verify', jobId: 2 })
    seedRow({ type: 'verify', jobId: 3 })
    expect(pickOrderIds()).toEqual([1, 2, 3])

    enqueue({ type: 'verify', jobId: 3 }, { manual: true })

    expect(pickOrderIds()).toEqual([3, 1, 2])
  })

  it('picks the most recently promoted item first', () => {
    for (const jobId of [1, 2, 3]) store.fit.set(jobId, 0.5)
    seedRow({ type: 'verify', jobId: 1 })
    seedRow({ type: 'verify', jobId: 2 })
    seedRow({ type: 'verify', jobId: 3 })
    // The boost is a timestamp, so the two re-adds have to land in
    // different milliseconds for "most recent" to mean anything — hence
    // the faked clock rather than a real sleep.
    vi.useFakeTimers()
    try {
      enqueue({ type: 'verify', jobId: 1 }, { manual: true })
      vi.advanceTimersByTime(5)
      enqueue({ type: 'verify', jobId: 3 }, { manual: true })
      // 3 was asked for last, so 3 is the one the user is waiting on.
      expect(pickOrderIds()).toEqual([3, 1, 2])
    } finally {
      vi.useRealTimers()
    }
  })

  it('falls back to enqueue order when two re-adds land in the same millisecond', () => {
    // The tie-break is documented rather than left to sort stability, so
    // the order cannot depend on the engine.
    for (const jobId of [1, 2]) store.fit.set(jobId, 0.5)
    seedRow({ type: 'verify', jobId: 1 })
    seedRow({ type: 'verify', jobId: 2 })
    vi.useFakeTimers()
    try {
      enqueue({ type: 'verify', jobId: 1 }, { manual: true })
      enqueue({ type: 'verify', jobId: 2 }, { manual: true })
      expect(store.rows[0].promotedAt).toBe(store.rows[1].promotedAt)
      expect(pickOrderIds()).toEqual([1, 2])
    } finally {
      vi.useRealTimers()
    }
  })

  it('beats a higher-fit sibling in the same tier', () => {
    // Inside a tier the boost outranks the fit heuristic: a user who
    // just asked for this item is a stronger signal than a score sampled
    // when the item happened to be enqueued.
    store.fit.set(1, 0.95)
    store.fit.set(2, 0.20)
    seedRow({ type: 'tailor_job_docs', jobId: 1 })
    seedRow({ type: 'tailor_job_docs', jobId: 2 })
    enqueue({ type: 'tailor_job_docs', jobId: 2 }, { manual: true })
    expect(pickOrderIds()).toEqual([2, 1])
  })

  it('does NOT let a promoted item outrank a queued score_fit', () => {
    // The project rule is that fit scoring is always tier 0 and
    // outranks everything, so "bump to the top" can only ever mean the
    // top of the item's OWN tier. A promoted verify against a queued
    // score_fit must not win, however good its job's fit is.
    store.fit.set(1, 0.99)
    store.fit.set(2, 0.01)
    seedRow({ type: 'score_fit', jobId: 2 })
    seedRow({ type: 'verify', jobId: 1 })
    enqueue({ type: 'verify', jobId: 1 }, { manual: true })
    expect(pickOrderIds()).toEqual([store.rows[0].id, store.rows[1].id])
    expect(listQueueInPickOrder()[0].type).toBe('score_fit')
  })

  it('does NOT let a promoted generation item outrank a queued score_fit', () => {
    store.fit.set(1, 0.99)
    seedRow({ type: 'score_fit', jobId: 2 })
    seedRow({ type: 'generate_cv', jobId: 1 })
    enqueue({ type: 'generate_cv', jobId: 1 }, { manual: true })
    expect(listQueueInPickOrder().map((i) => i.type)).toEqual(['score_fit', 'generate_cv'])
  })

  it('promotes within the score_fit tier too', () => {
    store.fit.set(1, 0.9)
    store.fit.set(2, 0.1)
    seedRow({ type: 'score_fit', jobId: 1 })
    seedRow({ type: 'score_fit', jobId: 2 })
    enqueue({ type: 'score_fit', jobId: 2 }, { manual: true })
    expect(pickOrderIds()).toEqual([2, 1])
  })

  it('leaves the order alone for an automatic re-add', () => {
    // The background triggers (fit landing, re-scan, hourly re-seeder,
    // follow-up chaining) must not reshuffle the queue under the user:
    // only a manual add earns a boost.
    for (const jobId of [1, 2, 3]) store.fit.set(jobId, 0.5)
    seedRow({ type: 'verify', jobId: 1 })
    seedRow({ type: 'verify', jobId: 2 })
    seedRow({ type: 'verify', jobId: 3 })
    enqueue({ type: 'verify', jobId: 3 })
    enqueue({ type: 'verify', jobId: 3 })
    expect(pickOrderIds()).toEqual([1, 2, 3])
    expect(store.rows[2].promotedAt).toBeUndefined()
  })

  it('does not mark a newly created row as promoted', () => {
    // There was nothing to bump. A fresh row is picked on its own merits.
    store.fit.set(1, 0.5)
    const created = enqueue({ type: 'verify', jobId: 1 }, { manual: true })
    expect(created?.promotedAt).toBeUndefined()
  })

  it('leaves rows that were never promoted in enqueue order', () => {
    for (const jobId of [1, 2, 3]) store.fit.set(jobId, 0.5)
    seedRow({ type: 'verify', jobId: 1 })
    seedRow({ type: 'verify', jobId: 2 })
    seedRow({ type: 'verify', jobId: 3 })
    expect(pickOrderIds()).toEqual([1, 2, 3])
  })
})

describe('a promoted item spends its boost when the processor picks it up', () => {
  it('clears the boost on the claim, so it is not pinned above its siblings forever', async () => {
    for (const jobId of [1, 2]) store.fit.set(jobId, 0.5)
    seedRow({ type: 'score_fit', jobId: 1 })
    seedRow({ type: 'score_fit', jobId: 2 })
    enqueue({ type: 'score_fit', jobId: 2 }, { manual: true })
    expect(pickOrderIds()).toEqual([2, 1])

    // The provider is still down, so the row survives the pass instead of
    // being consumed — which is what lets the cleared boost be observed.
    mockedScore.mockRejectedValue(new Error('provider down'))
    await processQueue()

    const survivor = store.rows.find((r) => r.jobId === 2)
    expect(survivor, 'the failing row is still queued').toBeDefined()
    expect(survivor!.promotedAt).toBeUndefined()
    // ...and it is back to plain oldest-first among its siblings: ids 1
    // and 2, in that order, with no boost left to separate them.
    expect(pickOrderIds()).toEqual([1, 2])
  })

  it('keeps the boost while the item has not been picked', () => {
    for (const jobId of [1, 2]) store.fit.set(jobId, 0.5)
    seedRow({ type: 'score_fit', jobId: 1 })
    seedRow({ type: 'score_fit', jobId: 2 })
    enqueue({ type: 'score_fit', jobId: 2 }, { manual: true })
    // No pass: the row is parked on its backoff, so the user's request
    // is still outstanding and must still be honoured.
    store.rows[1].nextRetryAt = Date.now() + 60_000
    expect(pickOrderIds()).toEqual([2, 1])
  })
})

// The widened guard must not have cost the processing case: `processing`
// is the state the processor puts an item in BEFORE its LLM call, and
// that window is long. A scan finishing, the startup backlog, or the
// hourly re-seeder landing inside it must still add nothing.
describe('the processing guard still prevents a double-add during an in-flight call', () => {
  it('an automatic enqueue landing inside a long LLM call adds nothing', async () => {
    seedRow({ type: 'score_fit', jobId: 42 })
    let rowsDuringCall = -1
    let resultDuringCall: AIQueueItem | null = null
    mockedScore.mockImplementation(async () => {
      // The row is `processing` here — that is the window.
      expect(store.rows[0].status).toBe('processing')
      // The startup backlog pass, firing mid-call.
      resultDuringCall = enqueue({ type: 'score_fit', jobId: 42 })
      rowsDuringCall = store.rows.length
      await new Promise((r) => setTimeout(r, 5))
      return { id: 42, score: 0.8, fit_source: 'llm', fit_score_version: 1 } as unknown as Job
    })

    await processQueue()

    expect(rowsDuringCall).toBe(1)
    expect(resultDuringCall).toBeNull()
    // And the item completed rather than being duplicated into a pair.
    expect(store.rows).toHaveLength(0)
  })

  it('a manual re-add landing inside a long LLM call adds nothing either', async () => {
    seedRow({ type: 'verify', jobId: 7, documentId: 11 })
    let rowsDuringCall = -1
    vi.mocked(verifyDocumentContent).mockImplementation(async () => {
      enqueue({ type: 'verify', jobId: 7, documentId: 11 }, { manual: true })
      rowsDuringCall = store.rows.length
      // A skip, not a failing review: the item is consumed without
      // feeding the regeneration loop, so this test is only about the row
      // count.
      return { kind: 'skip', reason: 'parse_failed', feedback: '' } as never
    })

    await processQueue()

    expect(rowsDuringCall).toBe(1)
    expect(store.rows).toHaveLength(0)
  })
})

// retryQueueItem is the Retry button, and it is the one queue entry point
// this change must not alter: it is not an "add", so it revives without
// promoting, and its public shape (write + the queue in pick order) is
// unchanged.
describe('retryQueueItem is unchanged', () => {
  it('writes the revive patch, plus a presence grant and no promotion', () => {
    seedRow({ id: 5, type: 'verify', jobId: 7, documentId: 11, status: 'failed', attempts: 3 })
    const before = Date.now()
    retryQueueItem(5)
    // Exact object, not objectContaining: a `promotedAt` key here would
    // mean Retry had started promoting, which it must not. The grant IS
    // expected — Retry is a press, so the row it re-arms is owed an answer.
    expect(store.writes).toHaveLength(1)
    expect(store.writes[0].patch).toEqual({
      status: 'pending',
      nextRetryAt: store.writes[0].patch.nextRetryAt,
      attempts: 0,
      lastError: undefined,
      userPresentAt: store.writes[0].patch.userPresentAt
    })
    expect(store.writes[0].patch.nextRetryAt).toBeGreaterThanOrEqual(before)
    expect(store.writes[0].patch.userPresentAt).toBeGreaterThanOrEqual(before)
    expect(store.rows[0].promotedAt).toBeUndefined()
  })

  it('returns the queue in pick order', () => {
    seedRow({ id: 1, type: 'verify', jobId: 1 })
    seedRow({ id: 2, type: 'score_fit', jobId: 2 })
    expect(retryQueueItem(1).map((i) => i.id)).toEqual([2, 1])
  })

  it('revives a row that a manual re-add had promoted, without re-promoting it', () => {
    seedRow({ id: 3, type: 'verify', jobId: 7, documentId: 11, status: 'failed', promotedAt: 1000 })
    retryQueueItem(3)
    expect(store.rows[0].status).toBe('pending')
    expect(store.rows[0].promotedAt).toBe(1000)
  })
})
