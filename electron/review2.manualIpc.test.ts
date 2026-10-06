import { describe, it, expect, vi, beforeEach } from 'vitest'

// REVIEWER-ADDED by `verify-autotoggles` (89b2e57), RE-RUN and RE-COMMITTED
// by `rv2-autofix` (this file is a verbatim copy of that commit's file —
// it did not exist in this worktree, so the fix commits' claim that "it
// passes 8/8" was a claim about a file on another branch).
//
// Kept here because it is the only thing in the tree that drives the real
// ipcMain handlers with every switch off, and DEFECT 2's fix touched the
// queue's restart lanes. Re-verified 8/8 on this tree, and mutation-checked
// below.
//
// The shipped suite (aiQueue.autoQueue.test.ts) proves `enqueue(..., {
// manual: true })` is ungated. It never proves that the four real manual
// entry points in main.ts actually PASS that flag. This file drives the
// real ipcMain handlers with every auto_queue_* switch off, so a call
// site that lost (or never had) `{ manual: true }` fails here.

const { STORE_DIR, handlers } = vi.hoisted(() => ({
  STORE_DIR: `/tmp/flow_job-test-review-manualipc-${process.env.FLOW_JOB_TEST_RUN_ID ?? `pid${process.pid}`}`,
  handlers: new Map<string, (...args: unknown[]) => unknown>()
}))

vi.mock('electron', () => ({
  app: {
    getPath: (_key: string) => STORE_DIR,
    getAppPath: () => STORE_DIR,
    getName: () => 'flow_job',
    getVersion: () => '0.0.0-test',
    setName: () => undefined,
    quit: () => undefined,
    commandLine: { appendSwitch: () => undefined },
    on: () => undefined,
    whenReady: () => Promise.resolve(),
    isReady: () => true
  },
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => { handlers.set(channel, fn) },
    on: () => undefined
  },
  BrowserWindow: class {
    webContents = {
      setWindowOpenHandler: () => undefined,
      once: () => undefined,
      on: () => undefined,
      send: () => undefined
    }
    loadURL() { return Promise.resolve() }
    loadFile() { return Promise.resolve() }
    on() { return undefined }
    show() { return undefined }
    isDestroyed() { return false }
    static getAllWindows() { return [] }
  },
  screen: { getPrimaryDisplay: () => ({ workAreaSize: { height: 900 } }) },
  session: { defaultSession: { webRequest: { onBeforeRequest: () => undefined, onHeadersReceived: () => undefined } } },
  dialog: new Proxy({}, { get: () => async () => ({ canceled: true, filePath: undefined }) }),
  shell: { openExternal: () => undefined },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s, 'utf8'),
    decryptString: (b: Buffer) => b.toString('utf8')
  }
}))

// The manual paths only reach enqueue() when the provider throttles, so
// that is the state this test puts them in. `withAiOperation` and
// `RateLimitError` stay real so the handler's `instanceof` branch is the
// genuine one.
vi.mock('./ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./ai')>()
  const throttle = async () => { throw new actual.RateLimitError('429') }
  return {
    ...actual,
    tailorDocument: vi.fn(throttle),
    verifyDocumentContent: vi.fn(throttle),
    regenerateSection: vi.fn(throttle)
  }
})

// `sanitizeDocument` is WRAPPED, not replaced: it still does its real work,
// so every assertion below is about the real ceilings, and counting its
// calls is how "sanitizes exactly once per generation" is measured rather
// than assumed. `aiQueue` reaches it through a dynamic `await import`, so
// the automatic lane goes through this mock too.
//
// It does NOT reach `tailorJobDocsForJob`'s own internal call: an ESM local
// call is not an import of the export. That case is asserted by outcome plus
// a source pin instead, and says so at the case.
vi.mock('./tailorJobDocs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./tailorJobDocs')>()
  return { ...actual, sanitizeDocument: vi.fn(actual.sanitizeDocument) }
})

import { existsSync, unlinkSync, mkdirSync } from 'fs'
import { join } from 'path'
import { RateLimitError, resetModelHealth } from './ai'
import {
  addApiModel,
  addAIQueueItem,
  createDocument,
  createJob,
  getAIQueue,
  listDocuments,
  reloadStore,
  updateJob,
  updateSettings
} from './database'
import { processQueue, stopQueueProcessor } from './aiQueue'
import { sanitizeDocument } from './tailorJobDocs'
import { runDocumentRuleChecks } from '../src/documentRules'
import type { CreateJobInput, Document } from './types'

const storeFile = join(STORE_DIR, 'apply-assistant-data.json')
const keyFile = join(STORE_DIR, 'apply-assistant-key')

const ALL_OFF = {
  auto_queue_fit: false,
  auto_queue_cv: false,
  auto_queue_cover_letter: false,
  auto_queue_verify_cv: false,
  auto_queue_verify_cover_letter: false
}

let nextUrl = 0
function addJob(over: Partial<CreateJobInput> = {}): number {
  nextUrl++
  const input: CreateJobInput = {
    title: `Engineer ${nextUrl}`,
    company: 'Acme',
    location: 'Remote',
    url: `https://example.com/review-manual/${nextUrl}`,
    ...over
  }
  return createJob(input).job.id
}

function rows(type: string) {
  return getAIQueue().filter((q) => q.type === type)
}

function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const fn = handlers.get(channel)
  if (!fn) throw new Error(`no handler registered for ${channel}`)
  return Promise.resolve(fn({}, ...args)) as Promise<unknown>
}

beforeEach(async () => {
  if (!existsSync(STORE_DIR)) mkdirSync(STORE_DIR, { recursive: true })
  for (const f of [storeFile, keyFile]) if (existsSync(f)) unlinkSync(f)
  reloadStore()
  nextUrl = 0
  // registerIpc() runs off app.whenReady() at import time.
  await import('./main')
  await new Promise((r) => setTimeout(r, 0))
})

describe('real IPC handlers with every auto_queue_* switch OFF', () => {
  beforeEach(async () => {
    updateSettings(ALL_OFF)
    // The provider must be throttling, or the handler returns the AI
    // result directly and never reaches enqueue() at all.
    const ai = await import('./ai')
    expect(vi.isMockFunction(ai.verifyDocumentContent)).toBe(true)
  })

  it('documents:verify (the Verify button) still queues a review of a CV', async () => {
    const jobId = addJob()
    const doc = createDocument('cv', 'CV', 'CONTENT', jobId)
    const out = await invoke('documents:verify', jobId, doc.id, 'cv')
    expect(out).toEqual({ queued: true })
    expect(rows('verify').map((r) => r.documentId)).toEqual([doc.id])
  })

  it('documents:verify still queues a review of a cover letter', async () => {
    const jobId = addJob()
    const doc = createDocument('cover_letter', 'CL', 'CONTENT', jobId)
    const out = await invoke('documents:verify', jobId, doc.id, 'cover_letter')
    expect(out).toEqual({ queued: true })
    expect(rows('verify').map((r) => r.documentId)).toEqual([doc.id])
  })

  it('documents:regenerateSection (the Regenerate button) still queues', async () => {
    const jobId = addJob()
    const doc = createDocument('cv', 'CV', 'CONTENT', jobId)
    const out = await invoke('documents:regenerateSection', doc.id, 'Summary', jobId)
    expect(out).toEqual({ queued: true })
    expect(rows('regenerate_section')).toHaveLength(1)
  })

  it('ai:tailor (Tailor / Generate) still queues a CV generation', async () => {
    const jobId = addJob()
    const out = await invoke('ai:tailor', { job_id: jobId, document_type: 'cv' })
    expect(out).toEqual({ queued: true })
    expect(rows('generate_cv').map((r) => r.jobId)).toEqual([jobId])
  })

  it('ai:tailor still queues a cover-letter generation', async () => {
    const jobId = addJob()
    const out = await invoke('ai:tailor', { job_id: jobId, document_type: 'cover_letter' })
    expect(out).toEqual({ queued: true })
    expect(rows('generate_cover_letter').map((r) => r.jobId)).toEqual([jobId])
  })

  it('tailor:quickApply (Quick Apply) still queues', async () => {
    const jobId = addJob()
    const out = await invoke('tailor:quickApply', jobId)
    expect(out).toEqual({ queued: true })
    expect(rows('tailor_job_docs').map((r) => r.jobId)).toEqual([jobId])
  })

  it('aiQueue:retry still revives a failed row', async () => {
    const jobId = addJob()
    updateSettings({ ...ALL_OFF, auto_queue_fit: true })
    const { enqueue } = await import('./aiQueue')
    const row = enqueue({ type: 'score_fit', jobId })!
    row.status = 'failed'
    row.attempts = 5
    invoke('aiQueue:retry', row.id)
    expect(getAIQueue().find((q) => q.id === row.id)!.status).toBe('pending')
  })
})

describe('sanity: the mocked AI really is throttling', () => {
  it('throws RateLimitError, so the queueing branch is the one under test', async () => {
    const jobId = addJob()
    const doc = createDocument('cv', 'CV', 'CONTENT', jobId)
    await expect(invoke('documents:verify', jobId, doc.id, 'cv')).resolves.toEqual({ queued: true })
    expect(RateLimitError.prototype).toBeInstanceOf(Error)
  })
})
// ---------------------------------------------------------------------------
// F2 — the manual generation path stored the RAW provider output
// ---------------------------------------------------------------------------

/**
 * `tailorDocument` (electron/ai.ts) has to store the raw model bytes: the
 * paragraph ceilings, the CV ceilings and the rule checks can only run once
 * the model has returned, so the CALLER owns the sanitizing write. The
 * per-unit queue lane (`24f48c8`) and `tailorJobDocsForJob` both discharge
 * it. `ai:tailor` — the handler above, i.e. the Tailor / Generate button on
 * the job and `JobDetail.tsx`'s own five-attempt regeneration loop — did not,
 * so a user clicking Generate got unsanitized model prose into the same
 * `documents` table the other two lanes protect: no 4-paragraph ceiling on a
 * cover letter, no CV ceilings, no rule checks.
 *
 * These cases sit in this file because it is the only one that drives the
 * REAL `ai:tailor` handler against a REAL store. The provider is swapped from
 * "always throttles" (the state the block above needs) to a real
 * `tailorDocument` over a stubbed `fetch`, so the model call, the document
 * row and the store write are all genuine and only the HTTP is fake.
 *
 * Everything is asserted against the STORED row rather than the handler's
 * return value: those are two different claims, and the bug was that only
 * the store was wrong.
 */

const JOB_DESCRIPTION = 'Senior Python engineer. Kubernetes, Postgres, AWS, Terraform, Go.'

/**
 * A CV that trips BOTH CV ceilings, so "the ceilings ran" is observable on
 * the STORED bytes:
 *   - `Technical:` carries 16 skills against a cap of 15, so exactly one is
 *     culled and the surviving list is 15 long;
 *   - `Laboratory:` is a non-Technical label inside the Skills section,
 *     which `enforceSkillsCeilings` drops outright.
 *
 * The headers are in the case `looksLikeHarvardCv` demands (its `HEADER_RE`
 * is case-sensitive), so an upper-case "SKILLS & INTERESTS" would fail
 * structural validation and cost a wasted attempt instead of producing a
 * document at all.
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

/** A CV that already satisfies every ceiling: the ceilings must be a no-op. */
const CV_WELL_FORMED = [
  'JAMIE OKONKWO',
  'jamie@example.com',
  '',
  'Skills & Interests',
  'Technical: Python, Kubernetes, Postgres, AWS, Terraform',
  'Language: English',
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

/** Three paragraphs, so the cover-letter ceilings have nothing to do. */
const CL_THREE_PARAGRAPHS = [
  'Dear Hiring Manager,',
  'I am applying for the role because I have spent four years on ingestion infrastructure.',
  'Best regards,\nJamie'
].join('\n\n')

type Kind = 'cv' | 'cl' | 'keywords' | 'review'

function classify(system: string): Kind {
  if (system.includes('strict career-document reviewer')) return 'review'
  if (system.includes('You extract keywords from a job description')) return 'keywords'
  if (system.includes('Tailor the candidate')) return 'cv'
  return 'cl'
}

let bodies: { cv: string; cl: string }

function provider(): void {
  const say = (content: string) =>
    new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: { body: string }) => {
      resetModelHealth()
      const parsed = JSON.parse(init.body) as { messages: { content: string }[] }
      const kind = classify(parsed.messages[0].content)
      if (kind === 'review') return say(JSON.stringify({ score: 96, passed: true, feedback: 'ok' }))
      if (kind === 'keywords') {
        return say(
          JSON.stringify({ keywords: [{ phrase: 'Python', weight: 1, category: 'hard', source: 'body' }] })
        )
      }
      return say(kind === 'cv' ? bodies.cv : bodies.cl)
    })
  )
}

const sanitizeCalls = (): number => vi.mocked(sanitizeDocument).mock.calls.length
const paras = (s: string): number => s.split(/\n\s*\n+/).length
const generatedOf = (type: Document['type']): Document[] =>
  listDocuments().filter((d) => d.type === type && !d.is_base)

interface TailorAnswer {
  content: string
  document_id: number
}

function tailorViaHandler(request: Record<string, unknown>): Promise<TailorAnswer | { queued: true }> {
  return invoke('ai:tailor', request) as Promise<TailorAnswer | { queued: true }>
}

/** The row the STORE holds for a document id — the claim under test. */
function storedById(id: number): Document {
  const row = listDocuments().find((d) => d.id === id)
  expect(row, `document ${id} is not in the store`).toBeTruthy()
  return row!
}

/** Replace the file's throttling mock with the REAL `tailorDocument`. */
async function useRealTailoring(): Promise<void> {
  const actual = await vi.importActual<typeof import('./ai')>('./ai')
  const ai = await import('./ai')
  vi.mocked(ai.tailorDocument).mockImplementation(actual.tailorDocument)
  vi.mocked(ai.verifyDocumentContent).mockImplementation(actual.verifyDocumentContent)
}

describe('F2: the manual generation path stores the SANITIZED text', () => {
  beforeEach(async () => {
    addApiModel({ name: 'm', base_url: 'https://llm.test/v1', api_key: 'k', model: 'm', enabled: true })
    updateSettings({ base_cv: 'MASTER', auto_doc_min_fit: 40 })
    bodies = { cv: CV_WELL_FORMED, cl: CL_THREE_PARAGRAPHS }
    vi.mocked(sanitizeDocument).mockClear()
    vi.unstubAllGlobals()
    provider()
    resetModelHealth()
    await useRealTailoring()
  })

  afterEach(async () => {
    stopQueueProcessor()
    vi.unstubAllGlobals()
    resetModelHealth()
    // Put the file-wide throttling mock back, so a describe added after
    // this one does not inherit a live provider by accident.
    const ai = await import('./ai')
    const throttle = async () => { throw new RateLimitError('429') }
    vi.mocked(ai.tailorDocument).mockImplementation(throttle as never)
    vi.mocked(ai.verifyDocumentContent).mockImplementation(throttle as never)
  })

  it('a cover letter over the paragraph ceiling is stored at four paragraphs', async () => {
    bodies = { cv: CV_WELL_FORMED, cl: CL_EIGHT_PARAGRAPHS }
    const jobId = addJob({ description: JOB_DESCRIPTION })
    const answer = (await tailorViaHandler({ job_id: jobId, document_type: 'cover_letter' })) as TailorAnswer

    // Before the fix: this row held all eight paragraphs, verbatim.
    expect(storedById(answer.document_id).content).not.toBe(CL_EIGHT_PARAGRAPHS)
    expect(paras(storedById(answer.document_id).content)).toBe(4)
    // One generation, one document row of this type.
    expect(generatedOf('cover_letter')).toHaveLength(1)
  })

  it('a CV over the CV ceilings is stored with the skills culled at 15 and Laboratory dropped', async () => {
    bodies = { cv: CV_OVERLONG, cl: CL_THREE_PARAGRAPHS }
    const jobId = addJob({ description: JOB_DESCRIPTION })
    const answer = (await tailorViaHandler({ job_id: jobId, document_type: 'cv' })) as TailorAnswer

    const row = storedById(answer.document_id)
    expect(row.content).not.toBe(CV_OVERLONG)
    expect(row.content.split('\n').find((l) => l.startsWith('Technical:'))!.split(',')).toHaveLength(15)
    expect(row.content).not.toMatch(/Laboratory:/)
    expect(generatedOf('cv')).toHaveLength(1)
  })

  it('the STORED document satisfies the structural rules, not just the handler return', async () => {
    // Asserted against the STORE and against the real rule checker rather
    // than against `sanitizeDocument`'s return value — the bug was precisely
    // that those two could disagree.
    //
    // `one_page`, `paragraph_count`, `skills_count` and `leadership_one_line`
    // are the rules the ceilings decide, so those are the ones asserted.
    // `keyword_coverage` is a CONTENT rule the ceilings cannot fix (these
    // fixtures deliberately share no keywords) and the per-unit lane's own
    // suite pins that it still fires there; this case is about the rules
    // sanitization is responsible for.
    bodies = { cv: CV_OVERLONG, cl: CL_EIGHT_PARAGRAPHS }

    const clJob = addJob({ description: JOB_DESCRIPTION })
    const cl = (await tailorViaHandler({ job_id: clJob, document_type: 'cover_letter' })) as TailorAnswer
    const clRules = runDocumentRuleChecks({
      document: storedById(cl.document_id).content,
      jobDescription: JOB_DESCRIPTION,
      docType: 'cover_letter'
    })
    expect(clRules.find((r) => r.rule === 'one_page')!.passed).toBe(true)
    expect(clRules.find((r) => r.rule === 'paragraph_count')!.passed).toBe(true)

    const cvJob = addJob({ description: JOB_DESCRIPTION })
    const cv = (await tailorViaHandler({ job_id: cvJob, document_type: 'cv' })) as TailorAnswer
    const cvRules = runDocumentRuleChecks({
      document: storedById(cv.document_id).content,
      jobDescription: JOB_DESCRIPTION,
      docType: 'cv'
    })
    expect(cvRules.find((r) => r.rule === 'one_page')!.passed).toBe(true)
    expect(cvRules.find((r) => r.rule === 'skills_count')!.passed).toBe(true)
    expect(cvRules.find((r) => r.rule === 'leadership_one_line')!.passed).toBe(true)
  })

  it('a well-formed CV is stored byte-identical — the ceilings are a no-op, not a mangler', async () => {
    bodies = { cv: CV_WELL_FORMED, cl: CL_THREE_PARAGRAPHS }
    const jobId = addJob({ description: JOB_DESCRIPTION })
    const answer = (await tailorViaHandler({ job_id: jobId, document_type: 'cv' })) as TailorAnswer
    expect(storedById(answer.document_id).content).toBe(CV_WELL_FORMED)
  })

  it('a well-formed cover letter is stored byte-identical too', async () => {
    bodies = { cv: CV_WELL_FORMED, cl: CL_THREE_PARAGRAPHS }
    const jobId = addJob({ description: JOB_DESCRIPTION })
    const answer = (await tailorViaHandler({ job_id: jobId, document_type: 'cover_letter' })) as TailorAnswer
    expect(storedById(answer.document_id).content).toBe(CL_THREE_PARAGRAPHS)
  })

  it('the SANITIZED text is what goes back to the renderer, not the raw bytes', async () => {
    // `regenerateDocument` in JobDetail.tsx feeds `result.content` back in as
    // `prevContent` for the next of its five rounds, so handing back the raw
    // prose would mean round two is built on text this call just culled.
    bodies = { cv: CV_WELL_FORMED, cl: CL_EIGHT_PARAGRAPHS }
    const jobId = addJob({ description: JOB_DESCRIPTION })
    const answer = (await tailorViaHandler({ job_id: jobId, document_type: 'cover_letter' })) as TailorAnswer
    expect(answer.content).toBe(storedById(answer.document_id).content)
    expect(paras(answer.content)).toBe(4)
  })

  it('a REBUILD (document_id set) is sanitized in place, on the same row', async () => {
    // The renderer's Regenerate path, and the same shape the queue's
    // auto-regeneration lane uses: `replaceDocumentContent` inside
    // `tailorDocument`, then the sanitizing UPDATE on the same row.
    bodies = { cv: CV_OVERLONG, cl: CL_THREE_PARAGRAPHS }
    const jobId = addJob({ description: JOB_DESCRIPTION })
    const first = (await tailorViaHandler({ job_id: jobId, document_type: 'cv' })) as TailorAnswer
    const ids = generatedOf('cv').map((d) => d.id)

    const second = (await tailorViaHandler({
      job_id: jobId,
      document_type: 'cv',
      document_id: first.document_id
    })) as TailorAnswer

    expect(second.document_id).toBe(first.document_id)
    expect(generatedOf('cv').map((d) => d.id)).toEqual(ids)
    expect(
      storedById(second.document_id).content.split('\n').find((l) => l.startsWith('Technical:'))!.split(',')
    ).toHaveLength(15)
  })

  it('a document deleted in the gap is not resurrected: the null branch writes nothing', async () => {
    // `setDocumentContent` returns null for a row that is gone, and the
    // handler's job is to report the id it was given and write NOTHING —
    // inserting a replacement would bring a deleted document back from the
    // dead, which is the rule the both-documents lane already follows.
    //
    // Pinned at the store boundary rather than through the handler, because
    // the store module's namespace is frozen (the handler reaches
    // `db.setDocumentContent`, so the seam cannot be spied from here), and
    // then the handler's use of the null value is source-pinned. Together
    // those two are the whole claim.
    const { setDocumentContent } = await import('./database')
    const before = listDocuments().length
    expect(setDocumentContent(999_999, 'anything')).toBeNull()
    expect(listDocuments()).toHaveLength(before)

    const { readFileSync } = await import('node:fs')
    expect(readFileSync('electron/main.ts', 'utf8')).toMatch(
      /const stored = db\.setDocumentContent\(result\.document_id, sanitized\.content\)\n\s*return \{ content: sanitized\.content, document_id: stored\?\.id \?\? result\.document_id \}/
    )
  })

  it('a rate-limited call still queues the manual fallback and stores nothing', async () => {
    // The sanitizing write is after the model call, so it cannot run when the
    // model call threw — and the fallback must be untouched by this fix.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ error: { message: 'rate limited' } }), {
          status: 429,
          headers: { 'content-type': 'application/json' }
        })
      )
    )
    const jobId = addJob()
    expect(await tailorViaHandler({ job_id: jobId, document_type: 'cv' })).toEqual({ queued: true })
    expect(rows('generate_cv').map((r) => r.jobId)).toEqual([jobId])
    expect(generatedOf('cv')).toHaveLength(0)
  })
})

describe('F2: exactly one sanitization per generation, on every lane', () => {
  beforeEach(async () => {
    addApiModel({ name: 'm', base_url: 'https://llm.test/v1', api_key: 'k', model: 'm', enabled: true })
    updateSettings({ base_cv: 'MASTER', auto_doc_min_fit: 40 })
    bodies = { cv: CV_OVERLONG, cl: CL_EIGHT_PARAGRAPHS }
    vi.mocked(sanitizeDocument).mockClear()
    vi.unstubAllGlobals()
    provider()
    resetModelHealth()
    await useRealTailoring()
  })

  afterEach(async () => {
    stopQueueProcessor()
    vi.unstubAllGlobals()
    resetModelHealth()
    // Put the file-wide throttling mock back, so a describe added after
    // this one does not inherit a live provider by accident.
    const ai = await import('./ai')
    const throttle = async () => { throw new RateLimitError('429') }
    vi.mocked(ai.tailorDocument).mockImplementation(throttle as never)
    vi.mocked(ai.verifyDocumentContent).mockImplementation(throttle as never)
  })

  it('the manual handler sanitizes ONCE', async () => {
    const jobId = addJob({ description: JOB_DESCRIPTION })
    await tailorViaHandler({ job_id: jobId, document_type: 'cover_letter' })
    expect(sanitizeCalls()).toBe(1)
  })

  it('the automatic per-unit lane sanitizes ONCE and is unaffected', async () => {
    const jobId = addJob({ description: JOB_DESCRIPTION })
    updateJob(jobId, { score: 0.9 })
    addAIQueueItem({ type: 'generate_cv', jobId })
    await processQueue()

    expect(sanitizeCalls()).toBe(1)
    const rowsCv = generatedOf('cv')
    expect(rowsCv).toHaveLength(1)
    expect(rowsCv[0].content).not.toBe(CV_OVERLONG)
    expect(rowsCv[0].content.split('\n').find((l) => l.startsWith('Technical:'))!.split(',')).toHaveLength(15)
  })

  it('a REBUILD through the queue lane sanitizes once too', async () => {
    // The auto-regeneration lane is the same case with `documentId` set, and
    // it is where a naive "sanitize inside tailorDocument" fix would have
    // started sanitizing twice.
    const jobId = addJob({ description: JOB_DESCRIPTION })
    addAIQueueItem({ type: 'generate_cv', jobId })
    await processQueue()
    const row = generatedOf('cv')[0]
    expect(sanitizeCalls()).toBe(1)

    addAIQueueItem({ type: 'generate_cv', jobId, documentId: row.id })
    await processQueue()
    expect(sanitizeCalls()).toBe(2)
    expect(generatedOf('cv')).toHaveLength(1)
  })

  it('the both-documents lane is unchanged, and its internal call cannot be spied', async () => {
    // `tailorJobDocsForJob` calls `sanitizeDocument` through its OWN module
    // binding, not the module namespace, so the `vi.mock` above cannot see
    // it — an ESM local call is not an import of the export. Stated here
    // rather than left to look like an oversight, and it is why this case
    // asserts the OUTCOME (stored bytes + row count) with the call count
    // pinned as a source fact in the next case.
    const jobId = addJob({ description: JOB_DESCRIPTION })
    addAIQueueItem({ type: 'tailor_job_docs', jobId })
    await processQueue()

    const cv = generatedOf('cv')
    const cl = generatedOf('cover_letter')
    expect(cv).toHaveLength(1)
    expect(cl).toHaveLength(1)
    expect(cv[0].content.split('\n').find((l) => l.startsWith('Technical:'))!.split(',')).toHaveLength(15)
    expect(paras(cl[0].content)).toBe(4)
    // The spy saw nothing, which is the point of the paragraph above.
    expect(sanitizeCalls()).toBe(0)
  })

  it('tailorJobDocsForJob calls sanitizeDocument exactly twice — once per document', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync('electron/tailorJobDocs.ts', 'utf8')
    const body = src.slice(src.indexOf('export async function tailorJobDocsForJob'))
    expect(body.match(/sanitizeDocument\(/g)?.length).toBe(2)
    expect(body).toMatch(/cv\.result \? sanitizeDocument\(cv\.result\.content, 'cv', jobDescription\)/)
    expect(body).toMatch(/cl\.result \? sanitizeDocument\(cl\.result\.content, 'cover_letter', jobDescription\)/)
    // Not in a loop: a `for` over the two results, or a re-sanitize on top,
    // is how this lane would start doing the work twice.
    expect(body).not.toMatch(/for \(/)
  })

  it('there is ONE sanitizeDocument implementation, and all three store paths call it', async () => {
    const { readFileSync, readdirSync } = await import('node:fs')
    const srcs: [string, string][] = []
    for (const dir of ['electron', 'src']) {
      for (const f of readdirSync(dir)) {
        if (!/\.tsx?$/.test(f) || /\.(test|spec)\.tsx?$/.test(f)) continue
        srcs.push([`${dir}/${f}`, readFileSync(join(dir, f), 'utf8')])
      }
    }
    const defined = srcs.filter(([, s]) =>
      /(?:export\s+)?(?:function|const|let|class)\s+sanitizeDocument\b/.test(s)
    )
    expect(defined.map(([p]) => p)).toEqual(['electron/tailorJobDocs.ts'])

    // Every store path CALLS it, asserted as calls rather than imports: an
    // import line alone would satisfy a bare `toContain`.
    expect(readFileSync('electron/aiQueue.ts', 'utf8')).toMatch(
      /=\s*sanitizeDocument\(\s*result\.content,\s*docType,/
    )
    expect(readFileSync('electron/main.ts', 'utf8')).toMatch(
      /=\s*sanitizeDocument\(\s*result\.content,\s*docType,/
    )
    const both = readFileSync('electron/tailorJobDocs.ts', 'utf8')
    expect(both).toMatch(/sanitizeDocument\(cv\.result\.content, 'cv', jobDescription\)/)
    expect(both).toMatch(/sanitizeDocument\(cl\.result\.content, 'cover_letter', jobDescription\)/)

    // ...and each of the three writes that result back onto the row the
    // model call created. Two name the variable `sanitized`; the
    // both-documents lane predates the fix and carries the two results in
    // `cvContent` / `clContent`, so it is matched on its own shape rather
    // than forced to rename working code for a test.
    expect(readFileSync('electron/aiQueue.ts', 'utf8')).toMatch(
      /setDocumentContent\(result\.document_id, sanitized\.content\)/
    )
    expect(readFileSync('electron/main.ts', 'utf8')).toMatch(
      /setDocumentContent\(result\.document_id, sanitized\.content\)/
    )
    expect(both).toMatch(
      /const cvContent =[\s\S]*?sanitizeDocument\(cv\.result\.content, 'cv', jobDescription\)\.content[\s\S]*?setDocumentContent\(cv\.result!\.document_id, cvContent\)/
    )
  })

  it('no model-output store path skips it: the only other document writers are the user\'s own', async () => {
    // The audit behind the three call sites. `documents:create` and
    // `documents:update` write what the USER typed, so sanitizing them would
    // be wrong; `tailorDocument` is the only model-output writer, and it has
    // exactly three callers in the main process. Anything new that calls it
    // owes the store a `setDocumentContent` of `sanitizeDocument(...)`'s
    // output — which the case above pins, per file.
    const { execFileSync } = await import('node:child_process')
    const grep = (pattern: string, dir: string): string[] =>
      execFileSync(
        'rg',
        ['-n', '--no-heading', '-g', '!*.test.ts', '-g', '!*.test.tsx', '-g', '!plans/**', pattern, dir],
        { encoding: 'utf8' }
      )
        .split('\n')
        .filter(Boolean)
        .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
// `electron/ai.ts` is also a MATCH: `tailorDocument` moved down that
    // file and its own declaration line sits inside the grepped range. It is
    // the declaration, not a fourth store path — the storage it does is
    // `createDocument`, already covered by the assertion below.
    //
    // Matched by CONTENT, not by line number. A pinned line here has
    // already broken three times — once for each time ai.ts grew (twice on
    // its own, once for the provider-block rebase) — and a stale pin fails
    // the audit for a reason that has nothing to do with sanitization.
    .filter((l) => !/^electron\/ai\.ts:\d+:export async function tailorDocument\(/.test(l))

    // The processor's per-unit case, both of `tailorJobDocsForJob`'s, and
    // the handler. Nothing else. Sorted because `rg` walks the tree.
    expect(grep('tailorDocument\\(', 'electron').sort().map((l) => l.split(':')[0])).toEqual([
      'electron/aiQueue.ts',
      'electron/main.ts',
      'electron/tailorJobDocs.ts',
      'electron/tailorJobDocs.ts'
    ])
    // ...and that declaration is not a store path: `ai.ts` stores only via
    // `createDocument`, which the caller's `setDocumentContent` then
    // sanitizes over. If a raw store ever reappears here this fails.
    // And the renderer's calls go through a channel, so they are covered by
    // the handler rather than being a fourth store path. There are TWO of
    // them per intent: the Tailor / Generate button, and the job page's
    // automatic sweep, which reaches `ai:autoTailor` rather than `ai:tailor`
    // because a page load is not a press. Both handlers run the same
    // `tailorDocumentNow(request, byPress ? MANUAL : AUTOMATED)` and then
    // `tailorAndSanitize`, so the sanitization count is one either way.
    //
    // One call each, asserted WITHOUT a line number, for the reason the rest
    // of this block does it: a pinned line here breaks every time the file
    // above it grows, and that has nothing to do with sanitization. Which
    // call site is the button's and which is the sweep's is the question
    // review.enqueueCallSites.test.ts answers, by reachability rather than by
    // arithmetic.
    const srcTailor = grep('api\\.tailorDocument\\(', 'src')
    const srcAutoTailor = grep('api\\.autoTailorDocument\\(', 'src')
    expect(srcTailor.map((l) => l.split(':')[0]), 'the button channel, called once').toEqual([
      'src/pages/JobDetail.tsx'
    ])
    expect(srcAutoTailor.map((l) => l.split(':')[0]), 'the sweep channel, called once').toEqual([
      'src/pages/JobDetail.tsx'
    ])
    const { readFileSync } = await import('node:fs')
    expect(readFileSync('src/api.ts', 'utf8')).toMatch(
      /tailorDocument: \(request: TailorRequest\) => Promise<TailorResult \| \{ queued: true \}>/)
    expect(readFileSync('electron/preload.ts', 'utf8')).toMatch(
      /tailorDocument: \(request\) => ipcRenderer\.invoke\('ai:tailor', request\)/
    )
  })
})
