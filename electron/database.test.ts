import { describe, it, expect, vi, beforeEach } from 'vitest'

// Override the global electron mock to add safeStorage stubs. The
// secureStore layer calls safeStorage.isEncryptionAvailable /
// encryptString / decryptString; without these stubs the in-memory
// store can persist (writeFileSync) but the encrypted envelope would
// blow up. We force isEncryptionAvailable=false so secureStore falls
// back to its plaintext-DEK path, which still round-trips correctly
// via AES-256-GCM with the DEK itself.
vi.mock('electron', () => ({
  app: {
    getPath: (_key: string) => '/tmp/flow_job-test',
    getName: () => 'flow_job',
    getVersion: () => '0.0.0-test',
    on: () => undefined,
    whenReady: () => Promise.resolve(),
    isReady: () => true
  },
  ipcMain: { handle: () => undefined, on: () => undefined },
  BrowserWindow: class {},
  session: { defaultSession: { webRequest: { onBeforeRequest: () => undefined } } },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s, 'utf8'),
    decryptString: (b: Buffer) => b.toString('utf8')
  }
}))

// Load the database AFTER the electron override above is in place.
import { existsSync, unlinkSync, mkdirSync } from 'fs'
import { join } from 'path'
import { createJob, updateJob, getJob, listJobs, reloadStore, getSettings, updateSettings, resetSettings, addAIQueueItem, updateAIQueueItem, getAIQueue, clearAIQueue, dedupeAIQueueItems, createDocument, deleteDocument, listJobDocuments, bumpDocumentAutoRegenAttempts, getDocumentAutoRegenAttempts } from './database'
import { DEFAULT_SCAN_MIN_MATCH } from './jobSearch'
import type { CreateJobInput } from './types'

const baseInput: CreateJobInput = {
  title: 'Senior Engineer',
  company: 'Acme',
  location: 'Remote',
  url: 'https://example.com/job/1',
  description: 'JD'
}

const storeDir = '/tmp/flow_job-test'
const storeFile = join(storeDir, 'apply-assistant-data.json')
const keyFile = join(storeDir, 'apply-assistant-key')

beforeEach(() => {
  // Force a fresh in-memory store between tests. reloadStore() resets
  // the cached `store` and calls loadStore(), but loadStore() reads
  // from disk — if the previous test wrote to the store file,
  // subsequent reloadStore() picks the old data back up. Wipe the
  // persisted file (and the DEK file) so the next loadStore() falls
  // back to defaultStore() (empty jobs list).
  if (!existsSync(storeDir)) mkdirSync(storeDir, { recursive: true })
  for (const f of [storeFile, keyFile]) {
    if (existsSync(f)) unlinkSync(f)
  }
  reloadStore()
})

describe('createJob score default (regression: no 0.31 fabrication)', () => {
  it('defaults score to null when the caller omits the field', () => {
    const { job } = createJob(baseInput)
    expect(job.score).toBeNull()
    expect(job.match_grade).toBeNull()
  })

  it('keeps score null when the caller explicitly passes score: null', () => {
    const { job } = createJob({ ...baseInput, score: null })
    expect(job.score).toBeNull()
    expect(job.match_grade).toBeNull()
  })

  it('preserves a caller-supplied numeric score', () => {
    const { job } = createJob({ ...baseInput, score: 0.82 })
    expect(job.score).toBe(0.82)
    // match_grade follows the supplied score (not a fabricated 0.31).
    expect(job.match_grade).toBe('A')
  })

  it('does not backfill score from a fabricated 0.31 placeholder', () => {
    const { job } = createJob(baseInput)
    // Belt-and-braces: assert against the exact buggy value as well.
    expect(job.score).not.toBe(0.31)
  })
})

describe('updateJob preserves null score (regression: no 0.31 fallback)', () => {
  it('leaves score null when the caller omits the field on update', () => {
    const { job: created } = createJob(baseInput)
    expect(created.score).toBeNull()

    // Simulate the no-CV path of scoreOneJobInBackground: stamp
    // fit_score_version + explanation, but do NOT pass score. The row
    // must keep score null.
    const updated = updateJob(created.id, {
      fit_rationale: 'No base CV configured.',
      fit_score_version: 0,
      fit_source: 'heuristic',
      fit_last_error: 'No base CV configured.'
    })
    expect(updated.score).toBeNull()
    expect(updated.fit_source).toBe('heuristic')
    expect(updated.fit_rationale).toBe('No base CV configured.')
    expect(updated.fit_score_version).toBe(0)
    expect(updated.fit_last_error).toBe('No base CV configured.')
  })

  it('still lets updateJob set a real score when the caller wants one', () => {
    const { job: created } = createJob(baseInput)
    const updated = updateJob(created.id, { score: 0.5 })
    expect(updated.score).toBe(0.5)
    expect(updated.match_grade).toBe('C')
  })
})

describe('scan-created job stays unscored until real scoring lands', () => {
  // Mirrors jobSearch.ts's call site: the scan persists with score=null
  // (pre-filter path) and a later scoring pass updates the row. We
  // assert that no createJob invocation can lock in a 0.31 between
  // those two steps.
  it('scan-style createJob persists score=null; a follow-up LLM result can update it', () => {
    const { job: created } = createJob({
      ...baseInput,
      score: null,
      fit_rationale: 'Pre-filtered by heuristic (low keyword overlap)',
      fit_breakdown: null,
      fit_score_version: null,
      fit_source: 'heuristic',
      fit_last_error: null
    })
    expect(created.score).toBeNull()
    expect(created.fit_source).toBe('heuristic')

    // Simulate the queue scorer resolving later with a real LLM score.
    const rescored = updateJob(created.id, {
      score: 0.74,
      fit_rationale: 'Strong match on most requirements.',
      fit_breakdown: { matched_skills: ['typescript'], missing_skills: [], experience_years_match: true },
      fit_score_version: 3,
      fit_source: 'llm',
      fit_last_error: null
    })
    expect(rescored.score).toBe(0.74)
    expect(rescored.fit_source).toBe('llm')
    expect(rescored.match_grade).toBe('B')
  })

  it('lists unscored jobs correctly after multiple createJob calls', () => {
    createJob({ ...baseInput, title: 'Role A', url: 'https://example.com/job/2' })
    createJob({ ...baseInput, title: 'Role B', url: 'https://example.com/job/3' })
    const all = listJobs()
    expect(all).toHaveLength(2)
    for (const j of all) {
      expect(j.score).toBeNull()
    }
  })

  it('returns the just-created job with score=null when fetched by id', () => {
    const { job } = createJob(baseInput)
    const fetched = getJob(job.id)
    expect(fetched?.score).toBeNull()
  })
})
// The queue is wiped by the Clear Queue button, and the count it
// returns is what the success toast tells the user. Nothing else
// exercises the real delete — aiQueue.test.ts mocks ./database
// wholesale — so without this a `clearAIQueue` that returned 0 without
// emptying anything would pass the entire suite.
describe('clearAIQueue (real store)', () => {
  function seed() {
    const pending = addAIQueueItem({ type: 'score_fit', jobId: 1 })
    addAIQueueItem({ type: 'verify', jobId: 2 })
    const failed = addAIQueueItem({ type: 'tailor_job_docs', jobId: 3 })
    updateAIQueueItem(failed.id, { status: 'failed', attempts: 3 })
    const running = addAIQueueItem({ type: 'verify', jobId: 4 })
    updateAIQueueItem(running.id, { status: 'processing' })
    return { pending, failed, running }
  }

  it('removes rows in every status, not just pending ones', () => {
    seed()
    expect(getAIQueue()).toHaveLength(4)
    clearAIQueue()
    // "Whatever its status" is the documented contract; a
    // pending-only clear would leave the other three behind.
    expect(getAIQueue()).toEqual([])
  })

  it('reports the number of rows it removed', () => {
    seed()
    expect(clearAIQueue()).toBe(4)
  })

  it('reports zero and does not throw on an already-empty queue', () => {
    expect(clearAIQueue()).toBe(0)
    expect(getAIQueue()).toEqual([])
  })

  it('leaves a queue that is repopulated afterwards intact', () => {
    seed()
    clearAIQueue()
    addAIQueueItem({ type: 'score_fit', jobId: 9 })
    expect(getAIQueue()).toHaveLength(1)
  })
})

describe('updateAIQueueItem reports whether the row existed', () => {
  it('returns true when the row was patched', () => {
    const row = addAIQueueItem({ type: 'score_fit', jobId: 1 })
    expect(updateAIQueueItem(row.id, { status: 'processing' })).toBe(true)
  })

  it('returns false for a row that no longer exists', () => {
    // This is the signal the processor uses to detect work that was
    // cleared out from under a mid-flight pass.
    const row = addAIQueueItem({ type: 'score_fit', jobId: 1 })
    clearAIQueue()
    expect(updateAIQueueItem(row.id, { status: 'processing' })).toBe(false)
  })
})

// The Queue panel showed three score_fit rows for one job: enqueue()'s
// guard only matched `pending`, so an enqueue landing while an identical
// item was `processing` added another row. The guard is now widened, but
// rows already written stay written — this is the one-shot repair.
describe('dedupeAIQueueItems (real store)', () => {
  function seed() {
    const a = addAIQueueItem({ type: 'score_fit', jobId: 1 })
    const b = addAIQueueItem({ type: 'score_fit', jobId: 1 })
    const c = addAIQueueItem({ type: 'score_fit', jobId: 1 })
    addAIQueueItem({ type: 'score_fit', jobId: 2 })
    addAIQueueItem({ type: 'verify', jobId: 1, documentId: 9 })
    return { a, b, c }
  }

  it('collapses three rows of the same work down to one', () => {
    seed()
    expect(getAIQueue()).toHaveLength(5)
    dedupeAIQueueItems()
    expect(getAIQueue()).toHaveLength(3)
  })

  it('removes exactly the redundant count', () => {
    seed()
    expect(dedupeAIQueueItems().removed).toBe(2)
  })

  it('leaves distinct work alone', () => {
    seed()
    dedupeAIQueueItems()
    const remaining = getAIQueue()
    // job 2's score_fit, and the verify for a document.
    expect(remaining.some((q) => q.type === 'score_fit' && q.jobId === 2)).toBe(true)
    expect(remaining.some((q) => q.type === 'verify' && q.jobId === 1)).toBe(true)
  })

  it('keeps the in-flight row rather than a failed one', () => {
    const { a, b } = seed()
    updateAIQueueItem(b.id, { status: 'processing' })
    updateAIQueueItem(a.id, { status: 'failed' })
    dedupeAIQueueItems()
    const kept = getAIQueue().filter((q) => q.type === 'score_fit' && q.jobId === 1)
    expect(kept).toHaveLength(1)
    // Throwing away the in-flight request would waste work already paid for.
    expect(kept[0].status).toBe('processing')
  })

  it('keeps the row with the most attempts when statuses tie', () => {
    const { a, b } = seed()
    updateAIQueueItem(a.id, { attempts: 4 })
    updateAIQueueItem(b.id, { attempts: 1 })
    dedupeAIQueueItems()
    const kept = getAIQueue().filter((q) => q.type === 'score_fit' && q.jobId === 1)
    expect(kept).toHaveLength(1)
    expect(kept[0].attempts).toBe(4)
  })

  it('treats different jobIds as different work', () => {
    addAIQueueItem({ type: 'score_fit', jobId: 1 })
    addAIQueueItem({ type: 'score_fit', jobId: 2 })
    expect(dedupeAIQueueItems().removed).toBe(0)
  })

  it('runs only once, so later legitimate rows are never collapsed', () => {
    seed()
    dedupeAIQueueItems()
    // A fresh duplicate created afterwards must survive a second call.
    addAIQueueItem({ type: 'score_fit', jobId: 3 })
    addAIQueueItem({ type: 'score_fit', jobId: 3 })
    expect(dedupeAIQueueItems().removed).toBe(0)
  })

  it('does not throw on an empty queue', () => {
    expect(dedupeAIQueueItems().removed).toBe(0)
    expect(getAIQueue()).toEqual([])
  })

  it('keeps the pending row over a failed one', () => {
    // The duplicate class the v1 pass could not see: `enqueue` matched
    // pending and processing only, so a failed row stayed put and the
    // next enqueue for the same work added a second, visible, row. The
    // one that can still run wins.
    const a = addAIQueueItem({ type: 'verify', jobId: 1, documentId: 9 })
    const b = addAIQueueItem({ type: 'verify', jobId: 1, documentId: 9 })
    updateAIQueueItem(a.id, { status: 'failed', attempts: 5 })
    expect(b.status).toBe('pending')
    dedupeAIQueueItems()
    const kept = getAIQueue().filter((q) => q.documentId === 9)
    expect(kept).toHaveLength(1)
    expect(kept[0].status).toBe('pending')
  })

  it('breaks a full tie on the lowest id, so the choice is deterministic', () => {
    // The third key of the survivor rule, and the only one that was not
    // pinned: without it the winner of an otherwise identical pair
    // depended on sort stability.
    const a = addAIQueueItem({ type: 'score_fit', jobId: 1 })
    const b = addAIQueueItem({ type: 'score_fit', jobId: 1 })
    updateAIQueueItem(b.id, { attempts: 2 })
    updateAIQueueItem(b.id, { attempts: 0 })
    dedupeAIQueueItems()
    expect(getAIQueue().map((q) => q.id)).toEqual([a.id])
  })

  it('reconciles duplicates in a store the v1 pass already collapsed', () => {
    // The user-visible duplicate: a store that has been running long
    // enough to have been through the pending/processing repair went on
    // collecting duplicates, because `failed` was still outside the
    // guard. A v1 flag alone would skip this store forever, which is
    // exactly why the second pass has its own gate.
    updateSettings({ queue_dedup_v1: '1' })
    addAIQueueItem({ type: 'verify', jobId: 1, documentId: 9 })
    addAIQueueItem({ type: 'verify', jobId: 1, documentId: 9 })
    addAIQueueItem({ type: 'score_fit', jobId: 1 })
    addAIQueueItem({ type: 'score_fit', jobId: 1 })
    expect(getAIQueue()).toHaveLength(4)

    expect(dedupeAIQueueItems().removed).toBe(2)
    expect(getAIQueue()).toHaveLength(2)
    expect(getSettings().queue_dedup_v2).toBe('1')
  })

  it('runs only once under the second gate, so later legitimate rows survive', () => {
    // The repair is one-shot in both runs: a duplicate that appears
    // after it has run (only reachable by writing `ai_queue` directly)
    // must not be collapsed out from under a running session.
    addAIQueueItem({ type: 'score_fit', jobId: 1 })
    dedupeAIQueueItems()
    addAIQueueItem({ type: 'score_fit', jobId: 3 })
    addAIQueueItem({ type: 'score_fit', jobId: 3 })
    expect(dedupeAIQueueItems().removed).toBe(0)
    // Both job-3 rows are still there: the gate held.
    expect(getAIQueue()).toHaveLength(3)
  })

  it('records the first pass on a store that has never been through either', () => {
    // A store written before either flag existed carries neither, so
    // running the v2 pass records both — otherwise a future pass keyed
    // on v1 would re-run on every startup for no reason.
    expect(getSettings().queue_dedup_v1).toBe('')
    dedupeAIQueueItems()
    expect(getSettings().queue_dedup_v1).toBe('1')
    expect(getSettings().queue_dedup_v2).toBe('1')
  })
})

// The grouping key was a `|`-delimited concatenation
// (`${type}|${jobId}|${documentId ?? ''}|${sectionName ?? ''}`) while a
// field-wise comparator sat right above it, unused. Two rows that
// stringify identically are not the same work, and the repair pass
// deletes the loser of such a pair without asking.
describe('dedupeAIQueueItems groups by field-wise equality, not a string key', () => {
  it('keeps an empty sectionName distinct from an absent one', () => {
    // Both render as `...|4|` in the old key, so the repair pass treated
    // them as one piece of work and dropped a row. `sameWork` — the
    // comparator the key was supposed to be — says '' is not null.
    addAIQueueItem({ type: 'regenerate_section', jobId: 1, documentId: 4, sectionName: '' })
    addAIQueueItem({ type: 'regenerate_section', jobId: 1, documentId: 4 })
    expect(getAIQueue()).toHaveLength(2)
    expect(dedupeAIQueueItems().removed).toBe(0)
    expect(getAIQueue()).toHaveLength(2)
  })

  it('still collapses a true duplicate of an empty sectionName', () => {
    // The counterpart to the test above: the empty/absent distinction
    // must not weaken the dedupe itself. Two rows naming the same work
    // are one piece of work whatever the spelling.
    addAIQueueItem({ type: 'regenerate_section', jobId: 1, documentId: 4, sectionName: '' })
    addAIQueueItem({ type: 'regenerate_section', jobId: 1, documentId: 4, sectionName: '' })
    expect(dedupeAIQueueItems().removed).toBe(1)
  })

  it('keeps distinct section names that contain the field separator', () => {
    // Section names come from the model's document outline, where a
    // heading like "Experience | Education" is entirely plausible. A key
    // that concatenates fields with '|' has to survive that spelling.
    addAIQueueItem({ type: 'regenerate_section', jobId: 1, documentId: 4, sectionName: 'Experience | Education' })
    addAIQueueItem({ type: 'regenerate_section', jobId: 1, documentId: 4, sectionName: 'Experience' })
    addAIQueueItem({ type: 'regenerate_section', jobId: 1, documentId: 4, sectionName: 'Education' })
    expect(dedupeAIQueueItems().removed).toBe(0)
    expect(getAIQueue()).toHaveLength(3)
  })

  it('collapses rows whose pipe-bearing section name is genuinely identical', () => {
    const a = addAIQueueItem({ type: 'regenerate_section', jobId: 1, documentId: 4, sectionName: 'Experience | Education' })
    addAIQueueItem({ type: 'regenerate_section', jobId: 1, documentId: 4, sectionName: 'Experience | Education' })
    addAIQueueItem({ type: 'regenerate_section', jobId: 1, documentId: 4, sectionName: 'Experience' })
    expect(dedupeAIQueueItems().removed).toBe(1)
    const kept = getAIQueue().filter((q) => q.sectionName === 'Experience | Education')
    expect(kept.map((q) => q.id)).toEqual([a.id])
  })

  it('treats a pipe-bearing section name on a different document as different work', () => {
    addAIQueueItem({ type: 'regenerate_section', jobId: 1, documentId: 4, sectionName: '4|Summary' })
    addAIQueueItem({ type: 'regenerate_section', jobId: 1, documentId: 44, sectionName: 'Summary' })
    expect(dedupeAIQueueItems().removed).toBe(0)
  })

  it('collapses a three-row bucket of one work item down to the single winner', () => {
    // A bucket is formed by comparing each row against the bucket's
    // first member, so this is the transitive case: three rows of one
    // work item must end up as one bucket, not three singletons.
    const a = addAIQueueItem({ type: 'regenerate_section', jobId: 1, documentId: 4, sectionName: '' })
    addAIQueueItem({ type: 'regenerate_section', jobId: 1, documentId: 4, sectionName: '' })
    addAIQueueItem({ type: 'regenerate_section', jobId: 1, documentId: 4, sectionName: '' })
    expect(dedupeAIQueueItems().removed).toBe(2)
    expect(getAIQueue().map((q) => q.id)).toEqual([a.id])
  })

  it('keeps the blank-headed and section-less rows as two work items', () => {
    // ...while the two spellings stay apart even inside the same job:
    // they are two rows, and the winner pick runs once per bucket.
    const a = addAIQueueItem({ type: 'regenerate_section', jobId: 1, documentId: 4, sectionName: '' })
    const b = addAIQueueItem({ type: 'regenerate_section', jobId: 1, documentId: 4 })
    addAIQueueItem({ type: 'regenerate_section', jobId: 1, documentId: 4 })
    expect(dedupeAIQueueItems().removed).toBe(1)
    expect(getAIQueue().map((q) => q.id)).toEqual([a.id, b.id])
  })
})

// The auto review→regenerate budget. `bumpDocumentAutoRegenAttempts`
// used to answer 0 for a document that is not there, which the loop read
// as a full budget and rebuilt anyway — a delete landing mid-LLM-call
// produced a regeneration item pointing at a row the user had removed.
describe('bumpDocumentAutoRegenAttempts', () => {
  function seedDoc() {
    const { job } = createJob(baseInput)
    return { job, doc: createDocument('cover_letter', 'Cover Letter', 'ORIGINAL', job.id) }
  }

  it('counts up on an existing document', () => {
    const { doc } = seedDoc()
    expect(bumpDocumentAutoRegenAttempts(doc.id)).toBe(1)
    expect(bumpDocumentAutoRegenAttempts(doc.id)).toBe(2)
    expect(getDocumentAutoRegenAttempts(doc.id)).toBe(2)
  })

  it('returns null, not 0, once the document is gone', () => {
    const { doc } = seedDoc()
    bumpDocumentAutoRegenAttempts(doc.id)
    deleteDocument(doc.id)
    // 0 would read as "no regenerations yet" — a fresh budget — for a
    // document that no longer exists.
    expect(bumpDocumentAutoRegenAttempts(doc.id)).toBeNull()
  })

  it('keeps reporting null for a document that never existed', () => {
    expect(bumpDocumentAutoRegenAttempts(987654)).toBeNull()
  })

  it('does not write a counter onto a deleted document', () => {
    const { job, doc } = seedDoc()
    expect(listJobDocuments(job.id).map((d) => d.id)).toEqual([doc.id])
    deleteDocument(doc.id)
    bumpDocumentAutoRegenAttempts(doc.id)
    // The bump is a no-op on a missing row: no counter anywhere, and
    // nothing put back.
    expect(listJobDocuments(job.id)).toEqual([])
  })
})

describe('scan_min_match default (the scan match floor)', () => {
  // The floor was a hardcoded 0.25 in jobSearch.ts until the previous
  // commit made it a filter; this commit made it a setting. The default
  // has to stay 0.25 so an upgrade does not silently change how much a
  // scan admits, and 0.25 is asserted there too so the two cannot drift.
  it('defaults to 0.25, the value the hardcoded floor used', () => {
    expect(getSettings().scan_min_match).toBe(0.25)
    expect(DEFAULT_SCAN_MIN_MATCH).toBe(0.25)
  })

  it('round-trips a user-set threshold', () => {
    const updated = updateSettings({ scan_min_match: 0.6 })
    expect(updated.scan_min_match).toBe(0.6)
    expect(getSettings().scan_min_match).toBe(0.6)
  })

  it('restores the default on reset', () => {
    updateSettings({ scan_min_match: 0.9 })
    expect(resetSettings().scan_min_match).toBe(0.25)
  })
})
