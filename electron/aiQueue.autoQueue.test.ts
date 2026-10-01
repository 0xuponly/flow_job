import { describe, it, expect, vi, beforeEach } from 'vitest'

// The enforcement half of the Auto-queue switches, against the REAL
// store and the REAL enqueue().
//
// The whole point of gating centrally is that no caller can bypass it,
// and the other queue suites mock ./database — so a gate implemented in
// the wrong place, or implemented at the call sites only, would pass
// every test that exists today. These tests therefore drive `enqueue`
// itself with the settings turned off, and drive it the way each caller
// does: automatic without `{ manual: true }`, manual with it.
//
// The requirement they exist to protect, stated once: a switch turned
// OFF must stop the app queueing work on its own and must NOT stop the
// user getting work they explicitly asked for. Every "manual" case below
// is the user pressing a button.

const { STORE_DIR } = vi.hoisted(() => ({ STORE_DIR: '/tmp/flow_job-test-autoqueue' }))

vi.mock('electron', () => ({
  app: {
    getPath: (_key: string) => STORE_DIR,
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

import { existsSync, unlinkSync, mkdirSync } from 'fs'
import { join } from 'path'
import {
  addAIQueueItem,
  createDocument,
  createJob,
  getAIQueue,
  reloadStore,
  updateJob,
  updateSettings
} from './database'
import { enqueue, retryQueueItem } from './aiQueue'
import { maybeAutoEnqueueDocs } from './fitScorer'
import { enqueueScoreFitBacklog, runFitAutoScoreBacklog } from './fitAutoScore'
import type { CreateJobInput } from './types'

const storeFile = join(STORE_DIR, 'apply-assistant-data.json')
const keyFile = join(STORE_DIR, 'apply-assistant-key')

const AUTO_QUEUE_KEYS = [
  'auto_queue_fit',
  'auto_queue_cv',
  'auto_queue_cover_letter',
  'auto_queue_verify_cv',
  'auto_queue_verify_cover_letter'
] as const

let nextUrl = 0

/** A job that has never been scored, which is what both fit re-seeders look for. */
function addUnscoredJob(): number {
  nextUrl++
  const input: CreateJobInput = {
    title: `Senior Engineer ${nextUrl}`,
    company: 'Acme',
    location: 'Remote',
    url: `https://example.com/autoqueue/${nextUrl}`
  }
  return createJob(input).job.id
}

/**
 * A job scored above `auto_doc_min_fit`, which is what makes the
 * fit-landing trigger fire.
 *
 * Written straight through `updateJob` rather than by calling the
 * scorer: scoreOneJobInBackground would run an LLM call, and what is
 * under test here is the gate, not the scoring.
 */
function addScoredJob(): number {
  const jobId = addUnscoredJob()
  updateJob(jobId, { score: 0.9, fit_score_version: 0 })
  return jobId
}

function rows(type: string): number[] {
  return getAIQueue().filter((q) => q.type === type).map((q) => q.jobId)
}

beforeEach(() => {
  nextUrl = 0
  if (!existsSync(STORE_DIR)) mkdirSync(STORE_DIR, { recursive: true })
  for (const f of [storeFile, keyFile]) if (existsSync(f)) unlinkSync(f)
  reloadStore()
})

describe('auto_queue_cv off', () => {
  it('refuses an automatic generate_cv', () => {
    updateSettings({ auto_queue_cv: false })
    const jobId = addUnscoredJob()
    expect(enqueue({ type: 'generate_cv', jobId })).toBeNull()
    expect(rows('generate_cv')).toEqual([])
  })

  it('still queues a MANUAL generate', () => {
    // The user's Generate button. This is the case the feature must not
    // break: the switch governs the app's own queueing, not the user's.
    updateSettings({ auto_queue_cv: false })
    const jobId = addUnscoredJob()
    expect(enqueue({ type: 'generate_cv', jobId }, { manual: true })).not.toBeNull()
    expect(rows('generate_cv')).toEqual([jobId])
  })

  it('refuses the automatic tailor_job_docs trigger that generates the CV', () => {
    // One item generates both documents, so it cannot honour "CV off"
    // without also quietly writing the CV.
    updateSettings({ auto_queue_cv: false })
    const jobId = addUnscoredJob()
    expect(enqueue({ type: 'tailor_job_docs', jobId })).toBeNull()
    expect(rows('tailor_job_docs')).toEqual([])
  })

  it('still queues a MANUAL tailor / Quick Apply', () => {
    updateSettings({ auto_queue_cv: false, auto_queue_cover_letter: false })
    const jobId = addUnscoredJob()
    expect(enqueue({ type: 'tailor_job_docs', jobId }, { manual: true })).not.toBeNull()
    expect(rows('tailor_job_docs')).toEqual([jobId])
  })

  it('stops the fit-landing trigger from queueing generation', () => {
    // maybeAutoEnqueueDocs is the fit-scoring path that reaches for
    // document generation on its own.
    updateSettings({ auto_queue_cv: false })
    const jobId = addScoredJob()
    expect(maybeAutoEnqueueDocs(jobId)).toBe(false)
    expect(rows('tailor_job_docs')).toEqual([])
  })

  it('leaves automatic cover-letter generation alone', () => {
    // The switches are independent: turning CV off must not reach across
    // and disable the cover letter too.
    updateSettings({ auto_queue_cv: false })
    const jobId = addUnscoredJob()
    expect(enqueue({ type: 'generate_cover_letter', jobId })).not.toBeNull()
    expect(rows('generate_cover_letter')).toEqual([jobId])
  })
})

describe('auto_queue_cover_letter off', () => {
  it('refuses an automatic generate_cover_letter', () => {
    updateSettings({ auto_queue_cover_letter: false })
    const jobId = addUnscoredJob()
    expect(enqueue({ type: 'generate_cover_letter', jobId })).toBeNull()
    expect(rows('generate_cover_letter')).toEqual([])
  })

  it('still queues a MANUAL cover letter generate', () => {
    updateSettings({ auto_queue_cover_letter: false })
    const jobId = addUnscoredJob()
    expect(enqueue({ type: 'generate_cover_letter', jobId }, { manual: true })).not.toBeNull()
    expect(rows('generate_cover_letter')).toEqual([jobId])
  })

  it('refuses the automatic tailor_job_docs trigger that generates the cover letter', () => {
    updateSettings({ auto_queue_cover_letter: false })
    const jobId = addUnscoredJob()
    expect(enqueue({ type: 'tailor_job_docs', jobId })).toBeNull()
  })

  it('leaves automatic CV generation alone', () => {
    updateSettings({ auto_queue_cover_letter: false })
    const jobId = addUnscoredJob()
    expect(enqueue({ type: 'generate_cv', jobId })).not.toBeNull()
  })
})

describe('auto_queue_verify_cv off', () => {
  it('refuses an automatic review of a CV', () => {
    // The processor chains generation -> review on its own; that chain is
    // an automatic enqueue and is gated like any other.
    updateSettings({ auto_queue_verify_cv: false })
    const jobId = addUnscoredJob()
    const doc = createDocument('cv', 'CV', 'CONTENT', jobId)
    expect(enqueue({ type: 'verify', jobId, documentId: doc.id })).toBeNull()
    expect(rows('verify')).toEqual([])
  })

  it('still queues a MANUAL Verify of the same CV', () => {
    // The user's Verify button on the very same document.
    updateSettings({ auto_queue_verify_cv: false })
    const jobId = addUnscoredJob()
    const doc = createDocument('cv', 'CV', 'CONTENT', jobId)
    expect(enqueue({ type: 'verify', jobId, documentId: doc.id }, { manual: true })).not.toBeNull()
    expect(rows('verify')).toEqual([jobId])
  })

  it('leaves automatic review of a cover letter alone', () => {
    updateSettings({ auto_queue_verify_cv: false })
    const jobId = addUnscoredJob()
    const doc = createDocument('cover_letter', 'CL', 'CONTENT', jobId)
    expect(enqueue({ type: 'verify', jobId, documentId: doc.id })).not.toBeNull()
  })

  it('routes a review of a deleted document by nothing and lets it through', () => {
    // There is no document to classify, so no switch is consulted. The
    // processor drops such a row on its next pass without calling the
    // model, so nothing is spent either way — and guessing a document
    // type here would suppress the wrong one.
    updateSettings({ auto_queue_verify_cv: false, auto_queue_verify_cover_letter: false })
    const jobId = addUnscoredJob()
    expect(enqueue({ type: 'verify', jobId, documentId: 999999 })).not.toBeNull()
  })
})

describe('auto_queue_verify_cover_letter off', () => {
  it('refuses an automatic review of a cover letter', () => {
    updateSettings({ auto_queue_verify_cover_letter: false })
    const jobId = addUnscoredJob()
    const doc = createDocument('cover_letter', 'CL', 'CONTENT', jobId)
    expect(enqueue({ type: 'verify', jobId, documentId: doc.id })).toBeNull()
    expect(rows('verify')).toEqual([])
  })

  it('still queues a MANUAL Verify of the same cover letter', () => {
    updateSettings({ auto_queue_verify_cover_letter: false })
    const jobId = addUnscoredJob()
    const doc = createDocument('cover_letter', 'CL', 'CONTENT', jobId)
    expect(enqueue({ type: 'verify', jobId, documentId: doc.id }, { manual: true })).not.toBeNull()
    expect(rows('verify')).toEqual([jobId])
  })

  it('leaves automatic review of a CV alone', () => {
    updateSettings({ auto_queue_verify_cover_letter: false })
    const jobId = addUnscoredJob()
    const doc = createDocument('cv', 'CV', 'CONTENT', jobId)
    expect(enqueue({ type: 'verify', jobId, documentId: doc.id })).not.toBeNull()
  })
})

describe('auto_queue_fit off', () => {
  it('stops the 4h fit-score backlog', () => {
    // This path deliberately bypasses the shared enqueue() (it resurrects
    // failed rows the processor's way), so it needs its own check — see
    // the note in fitAutoScore.ts.
    updateSettings({ auto_queue_fit: false })
    addUnscoredJob()
    expect(runFitAutoScoreBacklog()).toBe(0)
    expect(rows('score_fit')).toEqual([])
  })

  it('stops the startup / post-scan fit-score re-seeder', () => {
    // Both main.ts call sites (session start, and after every scan) go
    // through this function, so neither needs to know the setting exists.
    updateSettings({ auto_queue_fit: false })
    addUnscoredJob()
    expect(enqueueScoreFitBacklog()).toBe(0)
    expect(rows('score_fit')).toEqual([])
  })

  it('refuses an automatic score_fit enqueue directly', () => {
    updateSettings({ auto_queue_fit: false })
    const jobId = addUnscoredJob()
    expect(enqueue({ type: 'score_fit', jobId })).toBeNull()
    expect(rows('score_fit')).toEqual([])
  })

  it('does not resurrect an exhausted score_fit row either', () => {
    // A failed row is what the backlog exists to revive. Gating only the
    // "add a new row" half would let the switch off still wake a job
    // every four hours forever.
    const jobId = addUnscoredJob()
    updateSettings({ auto_queue_fit: true })
    enqueue({ type: 'score_fit', jobId })
    const row = getAIQueue()[0]
    row.status = 'failed'
    row.attempts = 5
    updateSettings({ auto_queue_fit: false })
    expect(runFitAutoScoreBacklog()).toBe(0)
    expect(getAIQueue()[0].status).toBe('failed')
  })

  it('leaves the other four switches unaffected', () => {
    updateSettings({ auto_queue_fit: false })
    const jobId = addUnscoredJob()
    expect(enqueue({ type: 'generate_cv', jobId })).not.toBeNull()
    expect(enqueue({ type: 'generate_cover_letter', jobId })).not.toBeNull()
  })
})

describe('every switch on leaves automatic enqueues alone', () => {
  it('queues each automatic type the shipped way', () => {
    // The default is the pre-feature behaviour. If turning everything on
    // did not reproduce it, the feature would have changed what the app
    // does for every existing user.
    updateSettings({
      auto_queue_fit: true,
      auto_queue_cv: true,
      auto_queue_cover_letter: true,
      auto_queue_verify_cv: true,
      auto_queue_verify_cover_letter: true
    })
    const jobId = addUnscoredJob()
    const cv = createDocument('cv', 'CV', 'CONTENT', jobId)
    const cl = createDocument('cover_letter', 'CL', 'CONTENT', jobId)
    expect(enqueue({ type: 'score_fit', jobId })).not.toBeNull()
    expect(enqueue({ type: 'generate_cv', jobId })).not.toBeNull()
    expect(enqueue({ type: 'generate_cover_letter', jobId })).not.toBeNull()
    expect(enqueue({ type: 'verify', jobId, documentId: cv.id })).not.toBeNull()
    expect(enqueue({ type: 'verify', jobId, documentId: cl.id })).not.toBeNull()
    expect(enqueue({ type: 'tailor_job_docs', jobId })).not.toBeNull()
    expect(enqueue({ type: 'regenerate_section', jobId, documentId: cv.id, sectionName: 'Summary' })).not.toBeNull()
  })
})

describe('the Queue panel Retry button', () => {
  it('still revives a failed row with every switch off', async () => {
    // A manual action, so it is not gated: a user looking at a failed
    // row and pressing Retry must not be told "you turned this off".
    const jobId = addUnscoredJob()
    const row = enqueue({ type: 'score_fit', jobId })!
    row.status = 'failed'
    row.attempts = 5
    for (const key of AUTO_QUEUE_KEYS) updateSettings({ [key]: false })
    retryQueueItem(row.id)
    expect(getAIQueue()[0].status).toBe('pending')
  })
})

describe('regenerate_section has no switch', () => {
  it('is never gated', () => {
    // There is no automatic producer of a section regeneration — the only
    // path is the user's button — so with every switch off it still
    // enqueues. Asserted so a future switch cannot quietly take it away
    // without this test noticing.
    for (const key of AUTO_QUEUE_KEYS) updateSettings({ [key]: false })
    const jobId = addUnscoredJob()
    const doc = createDocument('cv', 'CV', 'CONTENT', jobId)
    expect(enqueue({ type: 'regenerate_section', jobId, documentId: doc.id, sectionName: 'Summary' })).not.toBeNull()
  })
})

describe('the fit-landing trigger', () => {
  it('queues generation with both generation switches on', () => {
    // The other half of the maybeAutoEnqueueDocs contract: the trigger
    // still works when the user has left auto-queueing on.
    const jobId = addScoredJob()
    expect(maybeAutoEnqueueDocs(jobId)).toBe(true)
    expect(rows('tailor_job_docs')).toEqual([jobId])
  })

  it('stops when the cover-letter switch alone is off', () => {
    // The one item writes both documents, so it needs both.
    const jobId = addScoredJob()
    updateSettings({ auto_queue_cover_letter: false })
    expect(maybeAutoEnqueueDocs(jobId)).toBe(false)
    expect(rows('tailor_job_docs')).toEqual([])
  })

  it('does not even revive a failed generation row when a switch is off', () => {
    // enqueue() is not reached, so there is no row to revive: the user
    // turned this off and nothing wakes up on their behalf.
    const jobId = addScoredJob()
    const row = addAIQueueItem({ type: 'tailor_job_docs', jobId })
    row.status = 'failed'
    updateSettings({ auto_queue_cv: false })
    expect(maybeAutoEnqueueDocs(jobId)).toBe(false)
    expect(getAIQueue().filter((q) => q.type === 'tailor_job_docs')[0].status).toBe('failed')
  })
})

// Deliberately unused: the async variant above was replaced once the
// score write proved to need to be awaited by the caller. Kept out of
// the file rather than left as dead code.
void addScoredJob