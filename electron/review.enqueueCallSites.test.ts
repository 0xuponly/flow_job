import { describe, it, expect, vi, beforeEach } from 'vitest'
import { existsSync, unlinkSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'

// REVIEWER-ADDED. Not part of the reviewed commit (879e30d).
//
// GAP 3: the manual/automatic flag polarity, audited against the source
// rather than against `enqueue` itself.
//
// The shipped suite cannot see a misclassified call site. Every case in
// aiQueue.autoQueue.test.ts calls `enqueue(item, { manual: true })` or
// `enqueue(item)` with the flag written by the TEST, so:
//
//   * delete `{ manual: true }` from electron/main.ts:388 and all 24
//     shipped tests still pass, while the Verify button stops queueing
//     with the switches off — the exact failure the feature promises
//     cannot happen;
//   * add `{ manual: true }` to electron/jobSearch.ts:1513 and all 24
//     still pass, while the scan-time auto-tailor becomes completely
//     ungated and auto_queue_cv stops meaning anything at scan time.
//
// The prior reviewer's review.manualIpc.test.ts closed the first hole
// (it drives the real handlers). This file closes it permanently, by
// pinning the flag at every call site in the tree, and it widens the
// audit past `enqueue(` to every other path that can make the processor
// pick work up — the two the `rg "enqueue\("` inventory misses.

// ---------------------------------------------------------------------------
// Part 1 — a source-level scan of every `enqueue(` call site.
// ---------------------------------------------------------------------------

interface CallSite { where: string; line: number; manual: boolean; types: string[] }

/** Every source file the audit covers. Tests are excluded: they are the
 *  callers that gave the flag themselves, which is the whole problem. */
function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) sourceFiles(full, acc)
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) acc.push(full)
  }
  return acc
}

/** Line `n` of `src` with block and line comments blanked out. */
function codeLines(src: string): string[] {
  const noBlock = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  return noBlock
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, ''))
}

/** The text between the parens of the `(` at `open`, matching nesting. */
function balanced(src: string, open: number): string {
  let depth = 0
  for (let i = open; i < src.length; i++) {
    const ch = src[i]
    if (ch === '(') depth++
    else if (ch === ')') {
      depth--
      if (depth === 0) return src.slice(open + 1, i)
    }
  }
  throw new Error('unbalanced call')
}

function callSites(): CallSite[] {
  const out: CallSite[] = []
  for (const file of [...sourceFiles('electron'), ...sourceFiles('src')]) {
    const src = readFileSync(file, 'utf8')
    const lines = codeLines(src)
    // Offsets of each line's first character, so a match index maps back
    // to a line number.
    const starts: number[] = []
    let at = 0
    for (const l of lines) {
      starts.push(at)
      at += l.length + 1
    }
    const lineOf = (index: number): number => {
      let lo = 0
      let hi = starts.length - 1
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1
        if (starts[mid] <= index) lo = mid
        else hi = mid - 1
      }
      return lo + 1
    }
    const stripped = lines.join('\n')
    for (const m of stripped.matchAll(/(?<![\w$.])enqueue\s*\(/g)) {
      const line = lineOf(m.index)
      const text = m[0]
      // `export function enqueue(` is the declaration, not a call site.
      if (lines[line - 1].includes('function enqueue')) continue
      // A member read (`x.enqueue(`) is a different function; the
      // negative lookbehind above already excludes those.
      void text
      const args = balanced(stripped, m.index + text.length - 1)
      out.push({
        where: relative(process.cwd(), file),
        line,
        manual: /\{\s*manual\s*:\s*true\s*\}/.test(args),
        types: [...args.matchAll(/type:\s*'([a-z_]+)'/g)].map((t) => t[1])
      })
    }
  }
  return out
}

/**
 * The inventory, in the order the call sites appear in each file.
 *
 * This table is the audit. `879e30d` claims in its commit message and in
 * the doc comment on `autoQueueAllows` that "there are no others —
 * `rg -n "enqueue\(" electron src` is the check". That check is a
 * reviewer's eyeball, so it rots. Here it is a test: a new call site,
 * a moved call site, or a flipped flag fails until somebody says why.
 *
 * `manual: true` = a person triggered it, so it must not be gated.
 * `manual: false` = the app decided to, so the switch governs it.
 */
const INVENTORY: Record<string, { line: number; manual: boolean; why: string }[]> = {
  'electron/main.ts': [
    { line: 394, manual: true, why: 'documents:verify — the Verify button' },
    { line: 407, manual: true, why: 'documents:regenerateSection — the Regenerate button' },
    { line: 586, manual: true, why: 'ai:tailor — Tailor / Generate' },
    { line: 602, manual: true, why: 'tailor:quickApply — Quick Apply' }
  ],
  'electron/aiQueue.ts': [
    { line: 355, manual: false, why: 'processor: generation finished, chain the review' },
    { line: 412, manual: false, why: 'processor: review failed, auto-regenerate the document' },
    { line: 485, manual: false, why: 'processor: tailor_job_docs finished, review each new document' }
  ],
  'electron/fitScorer.ts': [
    { line: 133, manual: false, why: 'fit-landing trigger: a job cleared the fit threshold' }
  ],
  'electron/fitAutoScore.ts': [
    { line: 191, manual: false, why: 'session-start / post-scan fit-score re-seeder' }
  ],
  'electron/jobSearch.ts': [
    { line: 1513, manual: false, why: 'scan-time auto-tailor, gated by auto_tailor_on_scan + fit' }
  ],
  'electron/docsAutoQueue.ts': [
    { line: 363, manual: false, why: 'documents backlog sweep — the app re-seeding a cleared queue' }
  ]
}

describe('every enqueue() call site is classified', () => {
  const sites = callSites()

  it('finds exactly the call sites the inventory claims', () => {
    // Guards the scanner itself: if this drifts, the rest of the audit
    // is auditing nothing.
    const byFile = new Map<string, CallSite[]>()
    for (const s of sites) {
      const list = byFile.get(s.where) ?? []
      list.push(s)
      byFile.set(s.where, list)
    }
    expect([...byFile.keys()].sort()).toEqual(Object.keys(INVENTORY).sort())
    for (const [file, expected] of Object.entries(INVENTORY)) {
      const found = byFile.get(file) ?? []
      expect(
        found.map((s) => s.line),
        `${file} call-site lines`
      ).toEqual(expected.map((e) => e.line))
    }
  })

  it('has the manual flag set on every manual call site and on no automatic one', () => {
    for (const site of sites) {
      const expected = INVENTORY[site.where]?.find((e) => e.line === site.line)
      expect(expected, `${site.where}:${site.line} is not in the inventory`).toBeTruthy()
      expect(
        site.manual,
        `${site.where}:${site.line} (${INVENTORY[site.where].find((e) => e.line === site.line)?.why}) ` +
          `passes ${site.manual ? 'manual: true' : 'no manual flag'}; the inventory says otherwise`
      ).toBe(expected!.manual)
    }
  })

  it('routes every manual call site through the rate-limit fallback in main.ts', () => {
    // The four manual entry points are all "try the AI call, and only
    // queue if the provider is throttling". If a future manual path
    // enqueues unconditionally it still needs the flag, so this is a
    // reminder of where the flag belongs, not a gate.
    for (const site of sites.filter((s) => s.manual)) {
      expect(site.where).toBe('electron/main.ts')
    }
  })

  it('leaves the ungated type with no automatic producer at all', () => {
    // `regenerate_section` is the one type with no switch. Nothing in
    // the tree enqueues it without `manual: true`; if an automatic
    // producer ever appears, the switch table in autoQueueAllows needs
    // a row for it.
    const regen = sites.filter((s) => s.types.includes('regenerate_section'))
    expect(regen).toHaveLength(1)
    expect(regen[0].manual).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Part 2 — the paths that make the processor pick work up WITHOUT going
// through enqueue(). `rg "enqueue\("` does not see these.
// ---------------------------------------------------------------------------

const { STORE_DIR, handlers } = vi.hoisted(() => ({
  STORE_DIR: '/tmp/flow_job-test-review-callsites',
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

// The provider is down for every call, which is the state a row that
// has failed and is out of attempts is normally in. It also means the
// count of model calls is a direct measure of "did the app spend tokens
// on this on its own".
vi.mock('./ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./ai')>()
  const down = async () => { throw new Error('provider down') }
  return {
    ...actual,
    tailorDocument: vi.fn(down),
    verifyDocumentContent: vi.fn(down),
    regenerateSection: vi.fn(down),
    scoreJobFit: vi.fn(down)
  }
})

import { addAIQueueItem, createJob, getAIQueue, reloadStore, updateAIQueueItem, updateSettings } from './database'
import { processQueue, reclaimInterruptedItems, enqueue } from './aiQueue'
import { maybeAutoEnqueueDocs } from './fitScorer'
import * as ai from './ai'
import type { CreateJobInput } from './types'

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
function addJob(): number {
  nextUrl++
  const input: CreateJobInput = {
    title: `Engineer ${nextUrl}`,
    company: 'Acme',
    location: 'Remote',
    url: `https://example.com/review-callsites/${nextUrl}`
  }
  return createJob(input).job.id
}

function calls(name: 'tailorDocument' | 'verifyDocumentContent'): number {
  return vi.mocked(ai[name]).mock.calls.length
}

beforeEach(async () => {
  if (!existsSync(STORE_DIR)) mkdirSync(STORE_DIR, { recursive: true })
  for (const f of [storeFile, keyFile]) if (existsSync(f)) unlinkSync(f)
  reloadStore()
  nextUrl = 0
  updateSettings({ base_cv: 'MASTER CV' })
  for (const m of [ai.tailorDocument, ai.verifyDocumentContent]) vi.mocked(m).mockClear()
  // registerIpc() runs off app.whenReady() at import time.
  await import('./main')
  await new Promise((r) => setTimeout(r, 0))
})

describe('a REAL automatic caller, classified from its own source', () => {
  it('the fit-landing trigger queues nothing with the generation switches off', async () => {
    // electron/fitScorer.ts:107 — `maybeAutoEnqueueDocs`, reached from
    // the processor's score_fit case. Automatic: nobody asked for these
    // documents; the job simply scored well. Confirmed by driving the
    // real function, not `enqueue` with a hand-written flag.
    const jobId = addJob()
    const { updateJob } = await import('./database')
    updateJob(jobId, { score: 0.9, fit_score_version: 0 })
    updateSettings(ALL_OFF)
    expect(maybeAutoEnqueueDocs(jobId)).toBe(false)
    expect(getAIQueue().filter((q) => q.type === 'tailor_job_docs')).toHaveLength(0)
  })

  it('and still queues with them on, so the gate is what stopped it', async () => {
    const jobId = addJob()
    const { updateJob } = await import('./database')
    updateJob(jobId, { score: 0.9, fit_score_version: 0 })
    expect(maybeAutoEnqueueDocs(jobId)).toBe(true)
    expect(getAIQueue().filter((q) => q.type === 'tailor_job_docs').map((q) => q.jobId)).toEqual([jobId])
  })
})

describe('a REAL manual caller, with every switch off', () => {
  it('Quick Apply still queues tailor_job_docs', async () => {
    // electron/main.ts:593 — the Queue panel / job row's Quick Apply.
    // The one manual path that needs no AI mock, because it queues
    // unconditionally rather than as a rate-limit fallback.
    const jobId = addJob()
    updateSettings(ALL_OFF)
    const handler = handlers.get('tailor:quickApply')
    expect(handler).toBeTruthy()
    expect(await handler!({}, jobId)).toEqual({ queued: true })
    expect(getAIQueue().filter((q) => q.type === 'tailor_job_docs').map((q) => q.jobId)).toEqual([jobId])
  })

  it('Quick Apply queues both documents the item writes, switches or not', async () => {
    // `tailor_job_docs` needs BOTH generation switches on to be
    // automatic (aiQueue.autoQueue.test.ts) and is ungated when manual.
    // So one switch off is enough to stop the app and not enough to stop
    // the user — the pairing the whole design rests on.
    const jobId = addJob()
    for (const partial of [ALL_OFF, { ...ALL_OFF, auto_queue_cv: true }]) {
      const { clearAIQueue } = await import('./database')
      clearAIQueue()
      updateSettings(partial)
      handlers.get('tailor:quickApply')!({}, jobId)
      expect(getAIQueue().filter((q) => q.type === 'tailor_job_docs'), JSON.stringify(partial)).toHaveLength(1)
    }
  })
})

describe('the processor picking work up without going through enqueue()', () => {
  it('a failed generate_cv row is NOT revived with auto_queue_cv off', async () => {
    // FIXED — runPass's revival branch consults autoQueueAllows, as does
    // the failure-path reschedule in processItem. See REVIEW_VERDICT.md
    // finding 2.
    //
    // This is the lane `rg "enqueue\("` cannot see. `runPass`
    // (electron/aiQueue.ts:484) revives any `failed` row that still has
    // revival budget, writes it back to `pending`, and hands it to
    // `processItem` — with no settings read anywhere on that path. So
    // with `auto_queue_cv` off, a generation row that failed (queued
    // while the switch was on, or queued by hand and then failed) is
    // woken by the app and re-run, up to AUTO_REVIVE_MAX times, four
    // hours apart.
    //
    // The shipped code applies the opposite rule to the identical
    // behaviour for the identical row: 879e30d's own commit message
    // says "gating only its 'add a row' half would still let a
    // switch-off wake a failed job every four hours forever", and
    // fitAutoScore.ts:88 is the check that implements it. The processor's
    // wake-up of the same row is ungated.
    const jobId = addJob()
    const row = addAIQueueItem({ type: 'generate_cv', jobId })
    updateAIQueueItem(row.id, { status: 'failed', attempts: 5, autoRevives: 0, nextRetryAt: 0 })
    updateSettings(ALL_OFF)
    expect(calls('tailorDocument')).toBe(0)

    await processQueue()

    const after = getAIQueue()[0]
    expect(after.status).toBe('failed')
    expect(after.autoRevives).toBe(0)
    // And above all: no tokens spent.
    expect(calls('tailorDocument')).toBe(0)
  })

  it('a stranded processing row is NOT requeued at startup with auto_queue_cv off', async () => {
    // FIXED — reclaimInterruptedItems takes the same gate, so a row the
    // crash left `processing` is not resumed and paid for with the
    // switch off.
    const jobId = addJob()
    const row = addAIQueueItem({ type: 'generate_cv', jobId })
    updateAIQueueItem(row.id, { status: 'processing', nextRetryAt: 0 })
    updateSettings(ALL_OFF)

    reclaimInterruptedItems()

    expect(getAIQueue()[0].status).toBe('processing')
  })

  it('a failed row IS revived with every switch on, so the two above have teeth', async () => {
    // The control. Without it, "the row stayed failed" would be
    // indistinguishable from "the revive path is broken".
    const jobId = addJob()
    const row = addAIQueueItem({ type: 'generate_cv', jobId })
    updateAIQueueItem(row.id, { status: 'failed', attempts: 5, autoRevives: 0, nextRetryAt: 0 })

    await processQueue()

    const after = getAIQueue()[0]
    // pending, not failed: `runPass` revived it (autoRevives 0 -> 1) and
    // the provider being down rescheduled it one step out (1 -> 2) on the
    // 4h cooldown. Two is a row that really ran.
    expect(after.status).toBe('pending')
    expect(after.autoRevives).toBe(2)
    expect(calls('tailorDocument')).toBe(1)
  })

  it('an exhausted row is NOT parked for a 4h re-run with its switch off', async () => {
    // The third lane, and the one that repeats. The `else` branch of
    // processItem's catch parks a row that has burned its retry budget
    // `pending` on the 4h cooldown so it rejoins the queue on its own —
    // the same unattended spend the other two lanes do, one branch away
    // in the same file. Each park resets `attempts` to 0, so ungated the
    // row fails its way back here up to AUTO_REVIVE_MAX times, four
    // hours apart, for the life of the row.
    //
    // The attempt itself still runs: the row was `pending` when the
    // pass picked it up, and this gate governs what happens AFTER a
    // failure, not whether a queued run is honoured. So the claim under
    // test is the terminal state, not the call count.
    const jobId = addJob()
    const row = addAIQueueItem({ type: 'generate_cv', jobId })
    // attempts 12 -> 13 on this run: past the `attempts < 10` rate-limit
    // retry gate, and not a score_fit row, so control reaches the else.
    updateAIQueueItem(row.id, { status: 'pending', attempts: 12, autoRevives: 0, nextRetryAt: 0 })
    updateSettings(ALL_OFF)

    await processQueue()

    const after = getAIQueue()[0]
    // Terminal, not parked: nothing will wake this row on its own.
    expect(after.status).toBe('failed')
    expect(after.autoRevives ?? 0).toBe(0)
    // ...and no 4h re-run is scheduled behind it.
    expect(after.nextRetryAt).toBeLessThanOrEqual(Date.now())
  })

  it('...and IS parked with its switch on, so the case above has teeth', async () => {
    // The control. Without it "the row stayed failed" would be
    // indistinguishable from "the park path is broken".
    const jobId = addJob()
    const row = addAIQueueItem({ type: 'generate_cv', jobId })
    updateAIQueueItem(row.id, { status: 'pending', attempts: 12, autoRevives: 0, nextRetryAt: 0 })

    await processQueue()

    const after = getAIQueue()[0]
    expect(after.status).toBe('pending')
    expect(after.autoRevives).toBe(1)
    // attempts is reset, which is why ungated this row could repeat.
    expect(after.attempts).toBe(0)
    // Parked on the 4h cooldown, not due now.
    expect(after.nextRetryAt).toBeGreaterThan(Date.now() + 60 * 60 * 1000)
  })

  it('the Queue panel Retry is a manual wake-up and stays ungated', async () => {
    // The one revival that IS the user asking. Kept in this file so the
    // two ungated revivals above are read against the one that has a
    // reason to be.
    const { retryQueueItem } = await import('./aiQueue')
    const jobId = addJob()
    const row = addAIQueueItem({ type: 'generate_cv', jobId })
    updateAIQueueItem(row.id, { status: 'failed', attempts: 5, autoRevives: 3, nextRetryAt: 0 })
    updateSettings(ALL_OFF)
    retryQueueItem(row.id)
    expect(getAIQueue()[0].status).toBe('pending')
  })
})

describe('the Scan tab auto-tailor switch, against the gate', () => {
  it('is a switch to nothing once the generation switches are off', async () => {
    // The Scan tab still has its own "Auto-Queue" section owning
    // `auto_tailor_on_scan`, with the copy "Queue CV + cover letter
    // tailoring when a new job is added". It is not one of the five and
    // it is not on the new tab. With `auto_queue_cv` off this switch can
    // only ever produce a refusal: the call at jobSearch.ts:1513 is the
    // same shape as the one proven gated above, so the enqueue is
    // refused and the Scan tab's promise is silently kept for nothing.
    // The user has two controls in the app that both say "auto-queue"
    // and one of them does not work. Reported, not fixed: merging them
    // is a design decision.
    const jobId = addJob()
    const { updateJob } = await import('./database')
    updateJob(jobId, { score: 0.9, fit_score_version: 0 })
    updateSettings({ ...ALL_OFF, auto_tailor_on_scan: true })
    // auto_tailor_on_scan is on, the job is well past auto_doc_min_fit,
    // and the scan-time auto-tailor's enqueue is refused anyway.
    expect(maybeAutoEnqueueDocs(jobId)).toBe(false)
    expect(getAIQueue().filter((q) => q.type === 'tailor_job_docs')).toHaveLength(0)
  })
})

describe('the doc comment that claims to be the inventory', () => {
it('agrees with the tree, producer for producer and fan-out included', () => {
    // This case used to pin the comment's DEFECT: it asserted the text
    // said "five automatic producers" and that it did NOT mention the
    // `tailor_job_docs` → review fan-out. Those were true of the shipped
    // comment and are false now that it is fixed, so the assertions are
    // inverted below rather than deleted: the claim is now derived from
    // the tree and required to match, so the comment cannot drift in
    // EITHER direction again. The comment is the document the next
    // reviewer trusts instead of counting — which is exactly how the two
    // ungated revival lanes stayed invisible.
    //
    // What the tree actually has: seven automatic `enqueue` call sites
    // (the four manual ones are in main.ts and pinned above).
    const automatic = callSites().filter((c) => !c.manual)
    expect(automatic.map((c) => `${c.where}:${c.line}`).sort()).toEqual([
      'electron/aiQueue.ts:355',
      'electron/aiQueue.ts:412',
      'electron/aiQueue.ts:485',
      'electron/docsAutoQueue.ts:363',
      'electron/fitAutoScore.ts:191',
      'electron/fitScorer.ts:133',
      'electron/jobSearch.ts:1513'
    ])

    const src = readFileSync('electron/aiQueue.ts', 'utf8')
    const start = src.indexOf('There are ')
    expect(start).toBeGreaterThan(-1)
    // The comment wraps, so match against a whitespace-collapsed copy.
    const claim = src.slice(start, start + 700).replace(/^\s*\*\s?/gm, '').replace(/\s+/g, ' ')
    // The count it claims is the count the tree has.
    const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten']
    expect(claim, 'the comment must claim the tree\'s own count').toMatch(
      new RegExp(`There are ${WORDS[automatic.length]} automatic producers`)
    )
    // Every producer it names, including the fan-out this comment used
    // to omit (aiQueue.ts:396 — a different producer from the
    // generation → review chaining at :266, which fires for a directly
    // queued generate_*).
    expect(claim).toMatch(/fit-landing trigger in fitScorer/)
    expect(claim).toMatch(/scan-time auto-tailor in jobSearch/)
    expect(claim).toMatch(/generation→review\s*chaining/)
    expect(claim).toMatch(/review→regenerate loop/)
    expect(claim).toMatch(/tailor_job_docs→review fan-out/)
    expect(claim).toMatch(/fit\s*re-seeder in fitAutoScore/)
  })

  it('the rg the comment names cannot see the revival lanes, which is why they were ungated', () => {
    // The comment's own check — `rg -n "enqueue\(" electron src` — is
    // blind to both, which is why they read no setting and stayed
    // ungated. Both halves still hold: neither lane is an enqueue call,
    // and neither re-derives the rule from the raw settings. What changed
    // is that each now asks the one function that owns the rule.
    const src = readFileSync('electron/aiQueue.ts', 'utf8')
    const lanes: [string, string][] = [
      ['runPass', src.slice(src.indexOf('async function runPass()'), src.indexOf('function revive('))],
      [
        'reclaimInterruptedItems',
        src.slice(
          src.indexOf('export function reclaimInterruptedItems()'),
          src.indexOf('export function startQueueProcessor(')
        )
      ]
    ]
    for (const [name, body] of lanes) {
      expect(body.length, name).toBeGreaterThan(50)
      expect(body, `${name} must not call enqueue()`).not.toContain('enqueue(')
      // No settings read on either path, so nothing there can consult
      // the switches directly or disagree with the one gate.
      expect(body, `${name} must not read the auto_queue_* settings`).not.toMatch(/auto_queue_|getSettings/)
      // ...and it does ask the gate. Without this the assertions above
      // would also be satisfied by a lane that stayed ungated. The gate
      // for a lane is `mayReviveUnattended`, the narrowed one: a manual
      // row is exempt, so the lane cannot call `autoQueueAllows`
      // directly or it would refuse the user's own work.
      expect(body, `${name} must consult the restart gate`).toContain('mayReviveUnattended(')
      expect(body, `${name} must not gate manual rows away`).not.toContain('autoQueueAllows(')
    }
    // ...and the narrowed gate really is the switch, behind a manual-row
    // exemption. Asserted here rather than in the behavioural cases below
    // so a future edit that hardcodes `true` is caught too.
    const gate = src.slice(
      src.indexOf('function mayReviveUnattended('),
      src.indexOf('export function enqueue(')
    )
    expect(gate).toContain('manualQueued === true')
    expect(gate).toContain('autoQueueAllows(item)')
  })
})

// ---------------------------------------------------------------------------
// Part 3 — the origin is persisted, and the restart lanes gate on it.
//
// The rows in Part 2 all had no recorded origin, so they could only be
// treated as AUTOMATIC. That closed the spend leak but it also refused to
// revive a row the user had queued by hand, which is the promise the whole
// gate exists to protect. `manualQueued` is the row's own record of its
// origin, so a lane can now ask the narrower question: is this the user's
// work, or is it ours to keep spending on?
// ---------------------------------------------------------------------------

describe('the restart lanes gate on the row\'s recorded origin', () => {
  /** A `failed` row with a fresh revive budget, ready to be revived. */
  function failedRow(origin?: { manualQueued?: boolean }): number {
    const jobId = addJob()
    const row = addAIQueueItem({ type: 'generate_cv', jobId, ...origin })
    updateAIQueueItem(row.id, { status: 'failed', attempts: 5, autoRevives: 0, nextRetryAt: 0 })
    return row.id
  }

  it('revives a MANUAL failed row with its switch OFF — the restored behaviour', async () => {
    // The row a person queued, with auto_queue_cv off. Every version
    // before the revival lanes were gated revived this; the gate must not
    // have cost the user their own request. Same observable result as the
    // switch-on control below, which is the point: for a manual row the
    // switch is not consulted at all.
    failedRow({ manualQueued: true })
    updateSettings(ALL_OFF)

    await processQueue()

    const after = getAIQueue()[0]
    expect(after.status).toBe('pending')
    // Revived (0 -> 1), then the provider being down rescheduled it on the
    // 4h cooldown (1 -> 2). Two is a row that really ran again.
    expect(after.autoRevives).toBe(2)
    expect(calls('tailorDocument')).toBe(1)
  })

  it('does NOT revive an AUTOMATIC failed row with its switch OFF, and spends no increment', async () => {
    // The leak. `autoRevives` is asserted as well as `status` because a
    // gate that revived and then re-parked would leave the row looking
    // dormant while still having burned a full generation.
    failedRow({ manualQueued: false })
    updateSettings(ALL_OFF)

    await processQueue()

    const after = getAIQueue()[0]
    expect(after.status).toBe('failed')
    expect(after.autoRevives ?? 0).toBe(0)
    expect(calls('tailorDocument')).toBe(0)
  })

  it('reclaims a MANUAL row stranded `processing` at a crash, switch OFF', () => {
    // The one-shot lane. A user who queued by hand and then force-quit
    // mid-generation gets that generation resumed, exactly as before.
    const jobId = addJob()
    const row = addAIQueueItem({ type: 'generate_cv', jobId, manualQueued: true })
    updateAIQueueItem(row.id, { status: 'processing', nextRetryAt: 0 })
    updateSettings(ALL_OFF)

    reclaimInterruptedItems()

    expect(getAIQueue()[0].status).toBe('pending')
  })

  it('does NOT reclaim an AUTOMATIC row stranded `processing`, switch OFF', () => {
    const jobId = addJob()
    const row = addAIQueueItem({ type: 'generate_cv', jobId, manualQueued: false })
    updateAIQueueItem(row.id, { status: 'processing', nextRetryAt: 0 })
    updateSettings(ALL_OFF)

    reclaimInterruptedItems()

    expect(getAIQueue()[0].status).toBe('processing')
  })

  it('treats a LEGACY row with no origin field as AUTOMATIC, so the leak stays closed', () => {
    // The backward-compatibility case, and the one most likely to be got
    // wrong. Rows written by every version before `manualQueued` existed
    // carry no origin. Reading absent as MANUAL would hand every
    // pre-existing row a free pass and undo the gate for exactly the rows
    // it protects, so absent is AUTOMATIC.
    //
    // Constructed by writing the literal store shape rather than by
    // omitting the field from a typed call, so this cannot silently start
    // passing because the default changed.
    const jobId = addJob()
    const row = addAIQueueItem({ type: 'generate_cv', jobId })
    expect(getAIQueue()[0].manualQueued).toBeUndefined()
    updateAIQueueItem(row.id, { status: 'failed', attempts: 5, autoRevives: 0, nextRetryAt: 0 })
    updateSettings(ALL_OFF)

    return processQueue().then(() => {
      expect(getAIQueue()[0].status).toBe('failed')
      expect(getAIQueue()[0].autoRevives ?? 0).toBe(0)
      expect(calls('tailorDocument')).toBe(0)
    })
  })

  it('persists the origin: it survives a round trip through the store', async () => {
    // Without this, every case above would pass on a flag held in memory
    // and lost on restart — which is the bug the whole change exists to
    // fix, since the reclaim lane runs at startup. Written through
    // `enqueue` (the only producer of the field) and read back after a
    // full reload from disk.
    //
    // `persistStore` chains its write onto a promise, so a reload in the
    // same tick would read the file as it stood BEFORE the write; the
    // macrotask yield is what a real process restart gives us for free
    // (same shape as autoQueueSettings.test.ts's `simulateRestart`).
    const jobId = addJob()
    enqueue({ type: 'generate_cv', jobId }, { manual: true })
    enqueue({ type: 'generate_cover_letter', jobId }, { manual: false })

    // Drop the in-memory copy and read both rows back off disk.
    await new Promise((resolve) => setTimeout(resolve, 0))
    reloadStore()

    const rows = getAIQueue()
    const manualRow = rows.find((r) => r.type === 'generate_cv')!
    const autoRow = rows.find((r) => r.type === 'generate_cover_letter')!
    expect(manualRow.manualQueued, 'a manual enqueue keeps its origin').toBe(true)
    // Written explicitly `false` rather than left absent, so a fresh
    // automatic row is distinguishable from a pre-existing one.
    expect(autoRow.manualQueued, 'an automatic row is recorded as automatic').toBe(false)
  })

  it('a MANUAL re-add of an existing automatic row makes it manual for the lanes', () => {
    // The dedupe path. An automatic row already in the store, then the
    // user asks for that same work: the existing row is revived rather
    // than a second one added, so the origin has to travel on the patch —
    // otherwise the user's request would be recorded as the app's.
    const jobId = addJob()
    const row = addAIQueueItem({ type: 'generate_cv', jobId, manualQueued: false })
    updateAIQueueItem(row.id, { status: 'failed', attempts: 5, autoRevives: 0 })

    enqueue({ type: 'generate_cv', jobId }, { manual: true })

    const after = getAIQueue()
    // Still one row: the dedupe guard is unchanged.
    expect(after).toHaveLength(1)
    expect(after[0].manualQueued).toBe(true)
  })
})
