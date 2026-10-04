/**
 * R2 / R3 / R4 — the three regressions that moving the fit-landing trigger
 * off `tailor_job_docs` and onto the per-unit `generate_cv` /
 * `generate_cover_letter` rows introduced in 497e1e3.
 *
 * `tailor_job_docs` was the both-documents unit, and it did three things
 * past "call the model and store the answer" that the per-unit processor
 * cases did not inherit:
 *
 *   R2  it recomputed the job's doc-derived status, which is the ONLY thing
 *       that moves a job out of Sourced. Without it a fit-landing-triggered
 *       job is stranded in Sourced with both documents already written.
 *   R3  it sanitized the model output — paragraph ceilings for a cover
 *       letter, `enforceAllCvCeilings` for a CV, and `runDocumentRuleChecks`
 *       — and stored the SANITIZED bytes. The per-unit path stored the raw
 *       provider prose, so unsanitized content reached the Documents view.
 *   R4  it recorded `tailor_generated_at` / `tailor_ms_cv` / `tailor_ms_cl`
 *       on success and `tailor_last_error` on failure, which is the user's
 *       only visible "documents built at" stamp and tailoring error
 *       surface. The per-unit path recorded neither.
 *
 * Each regression is asserted the only way that can fail before the fix and
 * pass after it: by driving the REAL store and the REAL processor, and
 * comparing the trigger's per-unit lane against the `tailor_job_docs` lane
 * in the SAME store, so "the two lanes now agree" is a measurement rather
 * than a reading of the source. Only `fetch` is stubbed.
 *
 * The closing block re-asserts what 497e1e3 established, because the fix
 * for R3 writes onto a document row the per-unit path created and that is
 * exactly where a second row could reappear.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, unlinkSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

// Own userData directory: vitest runs FILES in parallel and the other
// real-store suites drive their own stores, so a shared path would have
// them wiping each other's data mid-run. Hoisted because the electron mock
// factory runs before module-level consts.
const { STORE_DIR } = vi.hoisted(() => ({ STORE_DIR: `/tmp/flow_job-test-triggerlane-parity-${process.env.FLOW_JOB_TEST_RUN_ID ?? `pid${process.pid}`}` }))

vi.mock('electron', () => ({
  app: {
    getPath: (_k: string) => STORE_DIR,
    getAppPath: () => STORE_DIR,
    getName: () => 'flow_job',
    getVersion: () => '0.0.0-parity',
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

import {
  addApiModel,
  addAIQueueItem,
  createDocument,
  createJob,
  getAIQueue,
  getJob,
  listJobDocuments,
  reloadStore,
  updateJob,
  updateSettings
} from './database'
import { maybeAutoEnqueueDocs } from './fitScorer'
import { AUTO_REVIVE_MAX } from './types'
import type { AIQueueItem, CreateJobInput, Document } from './types'

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function wipe(): void {
  if (!existsSync(STORE_DIR)) mkdirSync(STORE_DIR, { recursive: true })
  for (const f of ['apply-assistant-data.json', 'apply-assistant-key']) {
    const p = join(STORE_DIR, f)
    if (existsSync(p)) unlinkSync(p)
  }
  reloadStore()
}

let seq = 0

/** A job the shared eligibility gate ACCEPTS: base CV set, score over the bar. */
function eligibleJob(over: Partial<CreateJobInput> = {}) {
  seq += 1
  const { job } = createJob({
    title: `Staff Engineer ${seq}`,
    company: 'Acme',
    location: 'Remote',
    url: `https://example.com/parity/${seq}`,
    description: 'Senior Python engineer. Kubernetes, Postgres, AWS.',
    ...over
  })
  updateJob(job.id, { score: 0.9 })
  return getJob(job.id)!
}

const rowsOf = (jobId: number): AIQueueItem[] => getAIQueue().filter((q) => q.jobId === jobId)
const typeList = (jobId: number): string[] => rowsOf(jobId).map((q) => q.type).sort()
const docsOf = (jobId: number, type: Document['type']): Document[] =>
  listJobDocuments(jobId).filter((d) => d.type === type)

/**
 * A CV that trips both CV ceilings, so "the ceilings ran" is observable on
 * the STORED bytes:
 *   - `Technical:` carries 16 skills against a cap of 15, so exactly one is
 *     culled and the surviving list is 15 long;
 *   - `Laboratory:` is a non-Technical label inside the Skills section, which
 *     `enforceSkillsCeilings` drops outright.
 * The skills that survive are chosen by keyword score against the job
 * description, so the cull is deterministic rather than incidental.
 *
 * The section headers are in the exact case `looksLikeHarvardCv` demands:
 * its `HEADER_RE` is case-sensitive, so an upper-case "SKILLS & INTERESTS"
 * would fail structural validation and the provider would be retried into a
 * `TailoredOutputValidationError` instead of producing a document at all.
 */
const SIXTEEN_SKILLS = [
  'Python', 'Kubernetes', 'Postgres', 'AWS', 'Terraform', 'Go', 'Rust', 'Java',
  'Scala', 'Elixir', 'Haskell', 'Clojure', 'Erlang', 'Ruby', 'PHP', 'Perl'
]

const CV_OVERLONG = [
  'JAMIE OKONKWO',
  'jamie@example.com',
  '',
  'Skills & Interests',
  `Technical: ${SIXTEEN_SKILLS.join(', ')}`,
  'Language: English',
  'Laboratory: pcr, western blot',
  '',
  'Experience',
  'Globex\tRemote',
  'Staff Engineer\tMar 2020 - Present',
  '- Built the ingestion tier for 40M events a day',
  '',
  'Education',
  'Rutgers\tNew Brunswick, NJ',
  'B.S. Computer Science\tJun 2019'
].join('\n')

/** Eight paragraphs against the cover letter's ceiling of four. */
const CL_EIGHT_PARAGRAPHS = Array.from(
  { length: 8 },
  (_, i) => `Paragraph ${i + 1}: further prose about the role.`
).join('\n\n')

/** A CV that passes `looksLikeHarvardCv`, or it costs a wasted attempt. */
const CV_BODY = [
  'JAMIE OKONKWO',
  'jamie@example.com',
  '',
  'Experience',
  'Globex\tRemote',
  'Staff Engineer\tMar 2020 - Present',
  '- Built the ingestion tier for 40M events a day',
  '',
  'Education',
  'Rutgers\tNew Brunswick, NJ',
  'B.S. Computer Science\tJun 2019'
].join('\n')

type Kind = 'cv' | 'cl' | 'keywords' | 'review'

function classify(system: string): Kind {
  if (system.includes('strict career-document reviewer')) return 'review'
  if (system.includes('You extract keywords from a job description')) return 'keywords'
  if (system.includes('Tailor the candidate')) return 'cv'
  return 'cl'
}

interface Counters {
  cv: number
  cl: number
  keywords: number
  review: number
}

interface ProviderOpts {
  kill?: readonly Kind[]
  reviewScore?: number
  cvBody?: string
  clBody?: string
  /**
   * How far the FAKE clock is advanced inside the provider call for each
   * document kind. `tailorDocument` measures with `Date.now()` on both sides
   * of the call, so a stub that moves the clock makes the recorded
   * millisecond figure exact and the test cannot be flaky.
   */
  clock?: Partial<Record<Kind, number>>
}

let clearModelHealth: () => void = () => undefined

function provider(opts: ProviderOpts = {}): Counters {
  const kill = opts.kill ?? []
  const reviewScore = opts.reviewScore ?? 96
  const cvBody = opts.cvBody ?? CV_BODY
  const clBody = opts.clBody ?? 'Dear Hiring Manager,\n\nI am applying.\n\nRegards,\nJamie'
  const clock = opts.clock ?? {}
  const c: Counters = { cv: 0, cl: 0, keywords: 0, review: 0 }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: { body: string }) => {
      clearModelHealth()
      const body = JSON.parse(init.body) as { messages: { content: string }[] }
      const kind = classify(body.messages[0].content)
      c[kind] += 1
      const advance = clock[kind]
      if (advance) vi.setSystemTime(Date.now() + advance)
      if (kill.includes(kind)) {
        return new Response(JSON.stringify({ error: { message: 'rate limited' } }), {
          status: 429,
          headers: { 'content-type': 'application/json' }
        })
      }
      const say = (content: string) =>
        new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 })
      if (kind === 'review') {
        return say(JSON.stringify({ score: reviewScore, passed: reviewScore >= 70, feedback: 'ok' }))
      }
      if (kind === 'keywords') {
        return say(
          JSON.stringify({ keywords: [{ phrase: 'Python', weight: 1, category: 'hard', source: 'body' }] })
        )
      }
      if (kind === 'cv') return say(cvBody)
      return say(clBody)
    })
  )
  return c
}

/** Run the REAL processor until nothing is runnable. */
async function pump(maxSteps = 400, maxSimDays = 60): Promise<void> {
  const { processQueue } = await import('./aiQueue')
  const { resetModelHealth } = await import('./ai')
  const t0 = Date.now()
  for (let i = 0; i < maxSteps; i++) {
    resetModelHealth()
    const runnable = getAIQueue().filter(
      (q) =>
        q.status === 'pending' ||
        (q.status === 'failed' && (q.autoRevives ?? 0) < AUTO_REVIVE_MAX)
    )
    if (runnable.length === 0) return
    const next = Math.min(...runnable.map((q) => q.nextRetryAt))
    if (next > Date.now()) {
      if (next > t0 + maxSimDays * 86_400_000) return
      vi.setSystemTime(next)
    }
    await processQueue()
  }
}

beforeEach(async () => {
  wipe()
  addApiModel({
    name: 'm',
    base_url: 'https://llm.test/v1',
    api_key: 'k',
    model: 'm',
    enabled: true
  })
  updateSettings({ base_cv: 'MASTER', auto_doc_min_fit: 40 })
  vi.unstubAllGlobals()
  const { resetModelHealth } = await import('./ai')
  clearModelHealth = resetModelHealth
  resetModelHealth()
  // Only Date is faked, so a provider stub can move the clock to make a
  // measured duration exact while every real `await` still resolves.
  vi.useFakeTimers({ toFake: ['Date'] })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  delete process.env.FLOW_JOB_VERBOSE
})

// ---------------------------------------------------------------------------
// R2 — no doc-derived status recompute
// ---------------------------------------------------------------------------

describe('R2: a trigger-generated document recomputes the job doc-derived status', () => {
  it('a trigger lane that lands both documents moves the job out of Sourced', async () => {
    // The regression: `recomputeJobStatusFromDocs` was called from the
    // `tailor_job_docs` case and from nowhere else in the queue, so every
    // fit-landing-triggered and sweep-triggered job stayed in the Sourced
    // column FOREVER with both documents already written.
    provider()
    const job = eligibleJob()
    expect(getJob(job.id)!.status).toBe('sourced')

    expect(maybeAutoEnqueueDocs(job.id)).toBe(true)
    await pump()

    expect(docsOf(job.id, 'cv')).toHaveLength(1)
    expect(docsOf(job.id, 'cover_letter')).toHaveLength(1)
    expect(getJob(job.id)!.status).toBe('reviewing')
  })

  it('the per-unit recompute is correct at ONE document: a CV alone stays Sourced', async () => {
    // The recompute is not "promote when a generation happened" — it is the
    // shared doc-derived rule, so it must also decline. Without the
    // recompute at all this test passes for the wrong reason, which is why
    // the next test drives the same lane with the documents that DO make it
    // a promotion.
    provider()
    const job = eligibleJob()
    addAIQueueItem({ type: 'generate_cv', jobId: job.id })
    await pump()

    expect(docsOf(job.id, 'cv')).toHaveLength(1)
    expect(docsOf(job.id, 'cover_letter')).toHaveLength(0)
    expect(getJob(job.id)!.status).toBe('sourced')
  })

  it('a job whose CV already exists is promoted by the trigger-generated COVER LETTER', async () => {
    // The mirror of the case above, and the one the truth table produces: the
    // trigger queues only the missing unit, so the promotion has to come out
    // of the per-unit case rather than out of a both-documents unit.
    provider()
    const job = eligibleJob()
    createDocument('cv', 'CV', CV_BODY, job.id)
    expect(getJob(job.id)!.status).toBe('sourced')

    expect(maybeAutoEnqueueDocs(job.id)).toBe(true)
    expect(typeList(job.id)).toEqual(['generate_cover_letter'])
    await pump()

    expect(docsOf(job.id, 'cover_letter')).toHaveLength(1)
    expect(getJob(job.id)!.status).toBe('reviewing')
  })

  it('the lane reaches Reviewing, never Ready — and the user’s own Ready survives a rebuild', async () => {
    // The project rule the recompute has to keep: documents drive
    // sourced <-> reviewing only. 'ready' is the user's decision, so a
    // regeneration must not yank it back down — which is the one way a new
    // recompute call could regress this.
    provider()
    const job = eligibleJob()
    maybeAutoEnqueueDocs(job.id)
    await pump()
    expect(getJob(job.id)!.status).toBe('reviewing')
    expect(getJob(job.id)!.status).not.toBe('ready')

    // The user promotes it, which is the only way a job becomes Ready.
    updateJob(job.id, { status: 'ready' })
    expect(getJob(job.id)!.status).toBe('ready')

    // A rebuild of one of its documents runs the per-unit case again, so the
    // new recompute call fires against a Ready job.
    const cv = docsOf(job.id, 'cv')[0]
    addAIQueueItem({ type: 'generate_cv', jobId: job.id, documentId: cv.id })
    await pump()

    expect(docsOf(job.id, 'cv')).toHaveLength(1)
    expect(getJob(job.id)!.status).toBe('ready')
  })
})

// ---------------------------------------------------------------------------
// R3 — no sanitization
// ---------------------------------------------------------------------------

describe('R3: a trigger-generated document is sanitized before it is stored', () => {
  /**
   * Every test in this block drives BOTH lanes in ONE store, because the
   * point is a comparison and job ids must not collide.
   * `tailor_job_docs` is queued the way Quick Apply queues it, since it is
   * the only remaining producer of that unit and the only surviving holder
   * of the behaviour the trigger used to inherit.
   */
  it('the STORED cover letter has the paragraph ceiling applied, byte-identical to the tailor lane', async () => {
    provider({ clBody: CL_EIGHT_PARAGRAPHS })
    const viaTrigger = eligibleJob()
    const viaTailor = eligibleJob()
    maybeAutoEnqueueDocs(viaTrigger.id)
    addAIQueueItem({ type: 'tailor_job_docs', jobId: viaTailor.id })
    await pump()

    const triggerStored = docsOf(viaTrigger.id, 'cover_letter')[0]
    const tailorStored = docsOf(viaTailor.id, 'cover_letter')[0]
    expect(triggerStored).toBeDefined()
    expect(tailorStored).toBeDefined()

    // Before: the trigger lane stored the provider's eight paragraphs
    // verbatim and the tailor lane stored four.
    expect(triggerStored.content).not.toBe(CL_EIGHT_PARAGRAPHS)
    expect(triggerStored.content.split(/\n\s*\n+/)).toHaveLength(4)
    // The strong form: the two lanes now store the SAME bytes, so the
    // ceiling is applied once, by the one implementation, not approximated
    // by a second copy in the per-unit case.
    expect(triggerStored.content).toBe(tailorStored.content)
  })

  it('the STORED CV has the CV ceilings applied — the skills cull and the one-page cull', async () => {
    provider({ cvBody: CV_OVERLONG })
    const viaTrigger = eligibleJob()
    const viaTailor = eligibleJob()
    maybeAutoEnqueueDocs(viaTrigger.id)
    addAIQueueItem({ type: 'tailor_job_docs', jobId: viaTailor.id })
    await pump()

    const triggerStored = docsOf(viaTrigger.id, 'cv')[0]
    const tailorStored = docsOf(viaTailor.id, 'cv')[0]
    expect(triggerStored).toBeDefined()

    // Before: `not.toBe` failed and the raw sixteen-skill line was stored.
    expect(triggerStored.content).not.toBe(CV_OVERLONG)
    const technical = triggerStored.content.split('\n').find((l) => l.startsWith('Technical:'))!
    expect(technical.split(',')).toHaveLength(15)
    expect(triggerStored.content).not.toMatch(/Laboratory:/)
    // Same bytes as the lane that always sanitized.
    expect(triggerStored.content).toBe(tailorStored.content)
  })

  it('a REBUILD through the per-unit case is sanitized too, on the same row', async () => {
    // The per-unit case is also the auto-regeneration lane
    // (`documentId` set), so a rebuilt document is the one the user keeps
    // looking at. It must be sanitized on the row it replaced, and it must
    // not become a second row.
    provider({ cvBody: CV_OVERLONG })
    const job = eligibleJob()
    addAIQueueItem({ type: 'generate_cv', jobId: job.id })
    await pump()
    const stored = docsOf(job.id, 'cv')[0]
    expect(stored.content).not.toBe(CV_OVERLONG)

    const before = docsOf(job.id, 'cv').map((d) => d.id)
    addAIQueueItem({ type: 'generate_cv', jobId: job.id, documentId: stored.id })
    await pump()
    const after = docsOf(job.id, 'cv')
    expect(after.map((d) => d.id)).toEqual(before)
    expect(after[0].content).not.toBe(CV_OVERLONG)
    expect(after[0].content).toContain('Technical:')
  })

  it('the rule checks RUN on the per-unit path, not just the ceilings', async () => {
    // `runDocumentRuleChecks` is the third thing `sanitizeDocument` does and
    // its result is not stored anywhere, so the only observable surface it
    // has on either lane is the verbose line `sanitizeDocument` logs for a
    // failed rule. Cover letters that mention none of the job's keywords
    // fail `keyword_coverage`, which is a deterministic failure and cannot
    // be confused with the paragraph ceiling (the culled 4 paragraphs pass
    // their own check).
    process.env.FLOW_JOB_VERBOSE = '1'
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    try {
      provider({ clBody: CL_EIGHT_PARAGRAPHS })
      const viaTrigger = eligibleJob()
      const viaTailor = eligibleJob()
      maybeAutoEnqueueDocs(viaTrigger.id)
      addAIQueueItem({ type: 'tailor_job_docs', jobId: viaTailor.id })
      await pump()

      const lines = info.mock.calls.map((c) => String(c[0]))
      const ruleLine = /\[tailor\] cover_letter failed rule checks after sanitization: (.+)/
      const fromTrigger = lines.filter((l) => ruleLine.test(l))
      // Before: zero such lines from the per-unit path, so the trigger lane
      // never ran the rule checks at all.
      expect(fromTrigger.length).toBe(2)
      expect(fromTrigger.every((l) => l.includes('keyword_coverage'))).toBe(true)
    } finally {
      info.mockRestore()
    }
  })

  it('there is ONE sanitizeDocument implementation, and the per-unit case CALLS it', async () => {
    // The ceilings must not be re-implemented in the per-unit case: a second
    // copy is how the two lanes would drift again. Asserted as a CALL, and
    // as a single definition site, because an import line alone satisfies a
    // bare `toContain('sanitizeDocument')`.
    const { readFileSync, readdirSync } = await import('node:fs')
    const sources: [string, string][] = []
    for (const dir of ['electron', 'src']) {
      for (const f of readdirSync(dir)) {
        if (!/\.tsx?$/.test(f) || /\.(test|spec)\.tsx?$/.test(f)) continue
        sources.push([`${dir}/${f}`, readFileSync(join(dir, f), 'utf8')])
      }
    }
    const defined = sources.filter(([, src]) =>
      /(?:export\s+)?(?:function|const|let|class)\s+sanitizeDocument\b/.test(src)
    )
    expect(defined.map(([p]) => p)).toEqual(['electron/tailorJobDocs.ts'])

    const queue = readFileSync('electron/aiQueue.ts', 'utf8')
    // A CALL, not an import. `sanitizeDocument` reaches the per-unit case
    // through a destructured `await import`, so the import line alone would
    // satisfy a bare `toContain('sanitizeDocument')` — and a gutted
    // `const sanitized = ...` line would not satisfy this.
    expect(queue).toMatch(/=\s*sanitizeDocument\(\s*result\.content,\s*docType,/)
  })
})

// ---------------------------------------------------------------------------
// R4 — no timing or error surface
// ---------------------------------------------------------------------------

describe('R4: a trigger-generated document records the tailor_* timing and error fields', () => {
  it('records the same fields the tailor lane does, and each unit keeps its own measurement', async () => {
    // The provider stub moves the fake clock by a known amount per document
    // kind, so the recorded millisecond figures are exact: 4000 for the CV
    // and 7000 for the cover letter. That makes the carry-forward
    // observable — a write that stamped 0 for the unit it did not just
    // generate would wipe the other unit's measurement, and 4000 would be
    // gone.
    provider({ clock: { cv: 4000, cl: 7000 } })
    const job = eligibleJob()
    maybeAutoEnqueueDocs(job.id)
    await pump()

    const after = getJob(job.id)!
    expect(after.tailor_ms_cv).toBe(4000)
    expect(after.tailor_ms_cl).toBe(7000)
    expect(after.tailor_generated_at).not.toBeNull()
    expect(after.tailor_last_error).toBeNull()

    // The same shape the `tailor_job_docs` lane leaves behind.
    const viaTailor = eligibleJob()
    addAIQueueItem({ type: 'tailor_job_docs', jobId: viaTailor.id })
    await pump()
    const tailorJob = getJob(viaTailor.id)!
    expect(typeof tailorJob.tailor_generated_at).toBe('number')
    expect(typeof tailorJob.tailor_ms_cv).toBe('number')
    expect(typeof tailorJob.tailor_ms_cl).toBe('number')
  })

  it('records the "documents built at" stamp for a CV-only trigger', async () => {
    provider()
    const job = eligibleJob()
    createDocument('cover_letter', 'CL', 'Dear Hiring Manager, ...', job.id)
    expect(maybeAutoEnqueueDocs(job.id)).toBe(true)
    expect(typeList(job.id)).toEqual(['generate_cv'])
    await pump()

    const after = getJob(job.id)!
    expect(typeof after.tailor_generated_at).toBe('number')
    expect(typeof after.tailor_ms_cv).toBe('number')
    // `writeTailorTimingFields` writes both millisecond fields by
    // signature, so the cover letter's slot is a number here even though no
    // cover letter was generated. The carry-forward of a REAL prior
    // measurement is what the 4000/7000 case above pins down.
    expect(typeof after.tailor_ms_cl).toBe('number')
  })

  it('a FAILED trigger generation records the error on the job, not only on the queue row', async () => {
    // The only other record of a trigger failure was the queue row's
    // `lastError`, which the user cannot see. This is the tailoring error
    // surface the old lane maintained.
    provider({ kill: ['cv'] })
    const job = eligibleJob()
    maybeAutoEnqueueDocs(job.id)
    await pump(3, 0)

    const failed = getJob(job.id)!
    const row = rowsOf(job.id).find((q) => q.type === 'generate_cv')
    expect(row?.lastError).toBeTruthy()
    // Before: `toBeNull()` — the job carried no tailoring error at all.
    expect(failed.tailor_last_error ?? null).toBeTruthy()
    // The same text the queue recorded for the failed generation, so the
    // job's error surface and the queue row cannot tell the user different
    // stories. Which unit failed LAST is not asserted: the CV's 429 puts the
    // model on cooldown, so the cover letter that follows fails on the
    // cooldown path rather than on a wire request, and the job legitimately
    // holds the most recent of the two.
    expect(rowsOf(job.id).map((q) => q.lastError)).toContain(failed.tailor_last_error)
    expect(failed.tailor_error_toasted).toBe(failed.tailor_last_error)
  })

  it('a later success clears the tailoring error and stamps the build time', async () => {
    provider({ kill: ['cv'] })
    const job = eligibleJob()
    maybeAutoEnqueueDocs(job.id)
    await pump(3, 0)
    expect(getJob(job.id)!.tailor_last_error ?? null).toBeTruthy()
    expect(getJob(job.id)!.tailor_generated_at ?? null).toBeNull()

    // The provider recovers; the queued row's own retry budget carries the
    // rest of the way.
    provider()
    await pump()

    const after = getJob(job.id)!
    expect(after.tailor_last_error).toBeNull()
    expect(after.tailor_generated_at).not.toBeNull()
  })

  it('does not extend R6: a per-unit row that fails entirely is NOT removed as a success', async () => {
    // `tailor_job_docs` swallows a total failure and the processor removes
    // the row, so the failure is recorded as a success (R6, pre-existing and
    // deliberately NOT fixed here). The per-unit cases throw, so their row
    // must survive with its error, and the R4 write must not make the row
    // look finished.
    provider({ kill: ['cv'] })
    const job = eligibleJob()
    maybeAutoEnqueueDocs(job.id)
    await pump(3, 0)

    const row = rowsOf(job.id).find((q) => q.type === 'generate_cv')
    expect(row).toBeDefined()
    expect(row!.status).not.toBe('processing')
    expect(row!.lastError).toBeTruthy()
    expect(docsOf(job.id, 'cv')).toHaveLength(0)
  })

  it('a non-generation failure never writes a tailoring error onto the job', async () => {
    // The error write is guarded on the two generation types. A failing
    // `verify` or `score_fit` is not a tailoring failure and must not
    // overwrite `tailor_last_error`.
    provider({ reviewScore: 10, kill: ['review'] })
    const job = eligibleJob()
    maybeAutoEnqueueDocs(job.id)
    await pump(3, 0)

    const after = getJob(job.id)!
    expect(docsOf(job.id, 'cv')).toHaveLength(1)
    expect(after.tailor_generated_at).not.toBeNull()
    expect(after.tailor_last_error ?? null).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// PRESERVED — what 497e1e3 established must still hold
// ---------------------------------------------------------------------------

describe('PRESERVED: the trigger still queues only what is missing, and writes one row per type', () => {
  it('CV mid-review and no cover letter: exactly one generate_cover_letter', () => {
    const job = eligibleJob()
    createDocument('cv', 'CV', CV_BODY, job.id)
    addAIQueueItem({ type: 'verify', jobId: job.id, documentId: docsOf(job.id, 'cv')[0].id })

    expect(maybeAutoEnqueueDocs(job.id)).toBe(true)
    expect(typeList(job.id)).toEqual(['generate_cover_letter', 'verify'])
  })

  it('cover letter mid-review and no CV: exactly one generate_cv', () => {
    const job = eligibleJob()
    const cl = createDocument('cover_letter', 'CL', 'Dear Hiring Manager, ...', job.id)
    addAIQueueItem({ type: 'verify', jobId: job.id, documentId: cl.id })

    expect(maybeAutoEnqueueDocs(job.id)).toBe(true)
    expect(typeList(job.id)).toEqual(['generate_cv', 'verify'])
  })

  it('both missing: both units, and never tailor_job_docs', () => {
    const job = eligibleJob()
    expect(maybeAutoEnqueueDocs(job.id)).toBe(true)
    expect(typeList(job.id)).toEqual(['generate_cover_letter', 'generate_cv'])
  })

  it('nothing missing: nothing is queued', () => {
    const job = eligibleJob()
    createDocument('cv', 'CV', CV_BODY, job.id)
    createDocument('cover_letter', 'CL', 'Dear Hiring Manager, ...', job.id)
    expect(maybeAutoEnqueueDocs(job.id)).toBe(false)
    expect(rowsOf(job.id)).toHaveLength(0)
  })

  it('one generation writes exactly one row per type, and the queue drains', async () => {
    // Finding 2's regression guard, on the lane the trigger now uses. The R3
    // fix writes the sanitized bytes onto the row `tailorDocument` created,
    // which is precisely where a second insert would reappear.
    const calls = provider({ cvBody: CV_OVERLONG, clBody: CL_EIGHT_PARAGRAPHS })
    const job = eligibleJob()
    maybeAutoEnqueueDocs(job.id)
    await pump()

    expect(calls.cv).toBe(1)
    expect(calls.cl).toBe(1)
    expect(docsOf(job.id, 'cv')).toHaveLength(1)
    expect(docsOf(job.id, 'cover_letter')).toHaveLength(1)
    expect(getAIQueue()).toHaveLength(0)
  })
})
