/**
 * The shared eligibility predicate, directly.
 *
 * The reason this module exists is that TWO callers must answer "may this
 * job have document generation queued for it?" identically, and the way
 * that goes wrong is silent: the two copies drift, or one of them is
 * simply absent and its caller queues work the other would refuse. So the
 * tests here assert on the predicate's own behaviour and on the property
 * that makes the sharing real — that both call sites are wired to it, so
 * neither can hold a private copy of the conditions.
 */
import { describe, it, expect } from 'vitest'
import { readFile } from 'fs/promises'
import { autoDocQueueEligible } from './docAutoQueue'
import { PASSING_REVIEW_SCORE } from './types'
import type { Document, Job, Settings } from './types'

function job(overrides: Partial<Job> = {}): Job {
  return { id: 1, score: 0.8, ...overrides } as Job
}

function doc(overrides: Partial<Document> = {}): Document {
  return {
    id: 1,
    job_id: 1,
    type: 'cv',
    verification_score: null,
    ...overrides
  } as Document
}

function settings(overrides: Partial<Settings> = {}): Settings {
  return { base_cv: 'MASTER', auto_doc_min_fit: 40, ...overrides } as Settings
}

describe('autoDocQueueEligible', () => {
  it('admits a scored job that clears the threshold and has no documents', () => {
    expect(autoDocQueueEligible(job(), settings(), [])).toBe(true)
  })

  it('refuses a job with no fit score', () => {
    // maybeAutoEnqueueDocs: `if (job.score === null) return false`.
    expect(autoDocQueueEligible(job({ score: null }), settings(), [])).toBe(false)
  })

  it('refuses a job below auto_doc_min_fit', () => {
    expect(autoDocQueueEligible(job({ score: 0.05 }), settings(), [])).toBe(false)
  })

  it('compares on the 0-100 scale, not the stored 0-1 score', () => {
    // The bug this guards: reading the setting against the stored scale
    // would make every job pass, since 0.5 < 40.
    expect(autoDocQueueEligible(job({ score: 0.5 }), settings({ auto_doc_min_fit: 40 }), [])).toBe(true)
    expect(autoDocQueueEligible(job({ score: 0.39 }), settings({ auto_doc_min_fit: 40 }), [])).toBe(false)
  })

  it('treats the threshold as inclusive at the boundary', () => {
    expect(autoDocQueueEligible(job({ score: 0.4 }), settings({ auto_doc_min_fit: 40 }), [])).toBe(true)
  })

  it('falls back to 40 when the setting is absent', () => {
    expect(autoDocQueueEligible(job({ score: 0.5 }), settings({ auto_doc_min_fit: undefined }), [])).toBe(true)
    expect(autoDocQueueEligible(job({ score: 0.3 }), settings({ auto_doc_min_fit: undefined }), [])).toBe(false)
  })

  it('refuses a shippable job: every document reviewed at or above the bar', () => {
    // `every` on an empty list is true, so "has any documents" has to be
    // checked explicitly or a job with no documents would read as
    // shippable and be refused for the wrong reason.
    const passing = (score: number) => doc({ verification_score: score })
    expect(
      autoDocQueueEligible(job(), settings(), [passing(PASSING_REVIEW_SCORE), passing(95)])
    ).toBe(false)
  })

  it('admits a job whose best document is below the pass bar', () => {
    expect(
      autoDocQueueEligible(job(), settings(), [
        doc({ verification_score: PASSING_REVIEW_SCORE }),
        doc({ verification_score: PASSING_REVIEW_SCORE - 1 })
      ])
    ).toBe(true)
  })

  it('admits a job with no documents rather than treating empty as shippable', () => {
    expect(autoDocQueueEligible(job(), settings(), [])).toBe(true)
  })

  describe('requireConfiguredBaseCv', () => {
    it('is off by default, so the fit-landing trigger keeps its behaviour', () => {
      // The trigger is structurally unreachable with no base CV, so asking
      // there would change a shipped function to guard a state it cannot
      // be in — and break the suite that pins it.
      const s = settings({ base_cv: '' })
      expect(autoDocQueueEligible(job(), s, [])).toBe(true)
      expect(autoDocQueueEligible(job(), s, [], { requireConfiguredBaseCv: true })).toBe(false)
    })

    it('refuses when the sweep asks for it and no base CV is configured', () => {
      expect(
        autoDocQueueEligible(job(), settings({ base_cv: '' }), [], { requireConfiguredBaseCv: true })
      ).toBe(false)
    })

    it('admits when a base CV IS configured', () => {
      expect(
        autoDocQueueEligible(job(), settings(), [], { requireConfiguredBaseCv: true })
      ).toBe(true)
    })
  })
})

// The sharing is the point of the module, so the wiring is asserted rather
// than assumed. Each check below fails if a call site stops consulting the
// shared predicate and grows a private copy of the conditions.
describe('both callers consult the shared predicate', () => {
  it('the trigger keeps its signature, so no existing caller breaks', async () => {
    const { maybeAutoEnqueueDocs } = await import('./fitScorer')
    // (jobId, isStale?) — the gate is not a new parameter, so the trigger's
    // contract is unchanged.
    expect(typeof maybeAutoEnqueueDocs).toBe('function')
    expect(maybeAutoEnqueueDocs.length).toBeLessThanOrEqual(2)
  })

  it('both docs paths pass the sweep-only base-CV requirement', async () => {
    const src = await readFile('electron/docsAutoQueue.ts', 'utf8')
    // Both exported paths, so a future edit to one of them cannot quietly
    // drop the gate and start queueing work the other refuses.
    expect(countOf(src, 'autoDocQueueEligible(job, settings, docs, { requireConfiguredBaseCv: true })')).toBe(2)
  })

  it('the trigger does not duplicate the conditions inline', async () => {
    const src = await readFile('electron/fitScorer.ts', 'utf8')
    // No re-implementation of the threshold comparison in the caller. The
    // condition lives in docAutoQueue.ts and is imported, not restated —
    // so a future change to the threshold or its scale cannot be applied
    // to one caller and forgotten in the other. Comments are excluded:
    // naming the setting in prose is fine, reading it in code is not.
    const code = src
      .split('\n')
      .filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('//'))
      .join('\n')
    expect(code).not.toContain('auto_doc_min_fit')
    expect(code).not.toContain('PASSING_REVIEW_SCORE')
    expect(code).toContain('autoDocQueueEligible')
  })
})


function countOf(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}
