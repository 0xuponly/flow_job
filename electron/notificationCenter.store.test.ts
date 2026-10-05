/**
 * The notification center against a REAL store.
 *
 * The claim this file exists to check is a durability claim — "a record
 * survives until the user dismisses it" — and a durability claim cannot be
 * checked against an in-memory stub, because the stub is exactly the thing
 * that never has to survive. Everything here goes through the real
 * `loadStore`/`saveStore`, so a reload is a real reload: the store file is
 * deleted from `store`'s cache and read back off disk.
 *
 * Its own userData directory, for the reason
 * electron/docsAutoQueue.store.test.ts gives: vitest runs test FILES in
 * parallel and the other real-store suites share one store.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { existsSync, unlinkSync, mkdirSync } from 'fs'
import { join } from 'path'

const { STORE_DIR } = vi.hoisted(() => ({
  STORE_DIR: `/tmp/flow_job-test-notifcenter-${process.env.FLOW_JOB_TEST_RUN_ID ?? `pid${process.pid}`}`
}))

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

import { loadStore, reloadStore } from './database'
import {
  addNotification,
  listActiveNotifications,
  dismissNotification,
  dismissNotifications,
  dismissAllNotifications,
  purgeOldDismissedNotifications
} from './notifications'
import { notificationGroupKey } from './notificationGroup'
import { writeFileSync } from 'fs'

function wipe(): void {
  if (!existsSync(STORE_DIR)) mkdirSync(STORE_DIR, { recursive: true })
  for (const f of [join(STORE_DIR, 'apply-assistant-data.json'), join(STORE_DIR, 'apply-assistant-key')]) {
    if (existsSync(f)) unlinkSync(f)
  }
  reloadStore()
}

/**
 * Quits the app and starts it again, as far as the store is concerned:
 * `reloadStore` drops the in-memory copy, so the next read has to come
 * off disk. Any durability assertion that passes without this is only
 * proving the test's own object graph still holds the row.
 *
 * The tick of waiting is not politeness. `saveStore()` hands its write to
 * a promise chain (persistStore) rather than writing inline, so a reload
 * issued in the same tick would read the file as it stood BEFORE this
 * run's writes and a genuine bug — the row never hitting disk — would
 * pass. Draining first is what makes the negative case real.
 */
async function restartApp(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0))
  reloadStore()
}

const JOB = { job_id: 7, job_title: 'Staff Engineer', job_company: 'Acme', job_location: 'Berlin, DE' }

beforeEach(() => wipe())

describe('a record outlives the app that wrote it', () => {
  it('a notification written in one run is there in the next', async () => {
    addNotification({
      type: 'error',
      source: 'ai',
      message: 'Generation failed: 12 errors: 11 rate limited, 1 other.',
      full_message: 'All 12 configured AI models are rate limited — try again in a minute:\nModel 0: rate limited (429)',
      job: JOB
    })

    await restartApp()

    const { rows } = listActiveNotifications()
    expect(rows).toHaveLength(1)
    expect(rows[0].message).toBe('Generation failed: 12 errors: 11 rate limited, 1 other.')
    // The full error, not the one-line summary the toast carried.
    expect(rows[0].full_message).toContain('Model 0: rate limited (429)')
    expect(rows[0].job).toEqual(JOB)
  })

  it('nothing expires it on its own: no TTL, and the purge only touches dismissed rows', () => {
    addNotification({ type: 'error', source: 'ai', message: 'Generation failed', full_message: 'raw' })

    // Far past any plausible notification TTL — 30 days.
    const future = Date.now() + 31 * 24 * 60 * 60 * 1000
    const realNow = Date.now
    try {
      Date.now = () => future
      // The only clock-driven prune in the store is the dismissed-row
      // purge, and it must not touch an ACTIVE row however old it is.
      purgeOldDismissedNotifications()
    } finally {
      Date.now = realNow
    }

    expect(listActiveNotifications().rows).toHaveLength(1)
  })

  it('is removed only once the user dismisses it, and stays gone after a restart', async () => {
    const { id } = addNotification({ type: 'error', source: 'ai', message: 'Generation failed', full_message: 'raw' })
    await restartApp()
    expect(listActiveNotifications().rows).toHaveLength(1)

    dismissNotification(id)

    expect(listActiveNotifications().rows).toHaveLength(0)
    await restartApp()
    expect(listActiveNotifications().rows).toHaveLength(0)
  })
})

/**
 * Writes a store file by hand in the pre-grouping shape, then loads it.
 * The point is to prove an EXISTING user's rows still load and still
 * group, not just that new ones do.
 *
 * At module scope rather than inside a describe because two describes need
 * it: the migration's own cases, and the de-duplication describe's case
 * that folds a repeat into a row an older build wrote.
 */
function writeLegacyStore(rows: unknown[]): void {
  if (!existsSync(STORE_DIR)) mkdirSync(STORE_DIR, { recursive: true })
  writeFileSync(
    join(STORE_DIR, 'apply-assistant-data.json'),
    JSON.stringify({
      jobs: [], documents: [], applications: [], api_models: [],
      nextId: 900, seen_urls: [], ai_queue: [], board_health: {},
      board_scan_times: {}, provider_spend: {}, deleted_jobs: [],
      blacklisted_companies: [], settings: {}, notifications: rows
    })
  )
}

/** A row in the shape a build from before grouping and counts wrote. */
const legacyRow = {
  id: 1,
  type: 'error',
  source: 'ai',
  message: 'Content review failed: 12 errors: 11 rate limited, 1 other.',
  full_message: 'the whole rotation',
  created_at: 1_700_000_000_000,
  dismissed_at: null
}

/**
 * The shape the reported bug produced: one generate click, several
 * documents, each its own rotation over the same 12-model pool, so the
 * bucket counts differ while the failure is the same.
 *
 * Every mix here is one `toastErrorSummary` can actually emit — a non-zero
 * count for each bucket it names, because it filters empty buckets out
 * (src/aiErrorSummary.ts). A fixture with `0 rate limited` would key
 * identically today and would quietly stop keying the moment that filter
 * changed, which is a test that has stopped testing the thing it names.
 *
 * Each document also carries its OWN `full_message`, which is what makes
 * ten of these ten different facts rather than one fact said ten times.
 * See the de-duplication describe below for what that is protecting.
 */
function documentFlood(count: number): void {
  for (let i = 0; i < count; i++) {
    const other = (i % 10) + 1
    addNotification({
      type: 'error',
      source: 'ai',
      message: `Content review failed: 12 errors: ${12 - other} rate limited, ${other} other.`,
      full_message: `CV #${i}\nAll 12 configured AI models are rate limited:\nModel ${i}: HTTP 503`,
      job: JOB
    })
  }
}

/**
 * One failure, said `count` times, in the shape the renderers actually
 * produce it: same summary, same raw error, same job. This is what a
 * re-render, a StrictMode double-mount or a same-second retry looks like
 * from inside the store, and it is the case the record layer must fold.
 */
function sameFactSaidNtimes(count: number, over: Record<string, unknown> = {}): void {
  for (let i = 0; i < count; i++) {
    addNotification({
      type: 'error',
      source: 'ai',
      message: 'Content review failed: 12 errors: 11 rate limited, 1 other.',
      full_message: 'CV #9\nAll 12 configured AI models are rate limited:\nModel 0: HTTP 503',
      job: JOB,
      ...over
    })
  }
}

/**
 * Run `fn` with the clock moved forward by `ms`.
 *
 * The de-duplication window is a real number of milliseconds and the
 * alternatives to measuring it are both worse: sleeping would make the
 * suite slow and flaky, and asserting on a stored constant would pin the
 * constant rather than the behaviour. `Date.now` is the only clock the
 * store reads, so replacing it is the whole job.
 */
function withClockAt(now: number, fn: () => void): void {
  const realNow = Date.now
  try {
    Date.now = () => now
    fn()
  } finally {
    Date.now = realNow
  }
}

describe('the record layer refuses to multiply a fact it has already recorded', () => {
  /**
   * The bug this closes, in one assertion. The toast overlay collapses
   * identical text inside a TTL; the RECORD had no such guard, so the same
   * double-emission that used to produce ten toasts produced ten permanent
   * rows — and the durable count was a multiple of the real number.
   *
   * The model the fix settles on: the centre holds ONE ROW PER THING THAT
   * WENT WRONG. There is no counter anywhere — not on the row, not in the
   * drawer's badge — because a row already is one occurrence. These tests
   * are therefore all about row counts.
   */
  it('the same failure emitted twelve times is ONE row, and the store says one', () => {
    sameFactSaidNtimes(12)

    const { rows } = listActiveNotifications()
    // The count the drawer renders is this length, so this IS the number
    // the user reads: one thing went wrong, however many times the app
    // noticed.
    expect(rows).toHaveLength(1)
  })

  it('the store writes nothing and burns no id for a folded repeat', () => {
    // A repeat is not a row, so it must not cost one — and `nextId` is the
    // proof that the write path really returned early rather than inserting
    // and hiding it.
    const first = addNotification({
      type: 'error', source: 'ai',
      message: 'Content review failed: 12 errors: 11 rate limited, 1 other.',
      full_message: 'CV #9\nrotation', job: JOB
    })
    const second = addNotification({
      type: 'error', source: 'ai',
      message: 'Content review failed: 12 errors: 11 rate limited, 1 other.',
      full_message: 'CV #9\nrotation', job: JOB
    })

    expect(second.id).toBe(first.id)
    const store = loadStore()
    expect(store.nextId).toBe(first.id + 1)
  })

  it('keeps the row it folded into, rather than restating it in the newer words', () => {
    // Two sentences that share a group key — the digit normalisation
    // exists precisely so these are one group — carrying the SAME payload.
    // So they fold. The fold must not overwrite the message: "11 rate
    // limited, 1 other" and "10 rate limited, 2 other" are different facts
    // that the GROUP deliberately keeps apart, and a row that restated
    // itself in whichever sentence arrived last would be claiming the last
    // mix happened and not the first. The group's collapsed header takes
    // the newest member's message; within one row there is only the first.
    addNotification({
      type: 'error', source: 'ai',
      message: 'Content review failed: 12 errors: 11 rate limited, 1 other.',
      full_message: 'CV #9\nrotation', job: JOB
    })
    addNotification({
      type: 'error', source: 'ai',
      message: 'Content review failed: 12 errors: 10 rate limited, 2 other.',
      full_message: 'CV #9\nrotation', job: JOB
    })

    const { rows } = listActiveNotifications()
    expect(rows).toHaveLength(1)
    expect(rows[0].message).toBe('Content review failed: 12 errors: 11 rate limited, 1 other.')
    expect(rows[0].full_message).toBe('CV #9\nrotation')
  })

  it('two DIFFERENT failures on two different jobs are not merged', () => {
    // The boundary that matters. `notificationGroupKey` deliberately drops
    // the job so twelve throttled jobs read as one thing to think about —
    // which is safe for collapsing and catastrophic for erasing, because
    // merging these would lose one job's row entirely.
    const other = { job_id: 8, job_title: 'Staff Engineer', job_company: 'Globex', job_location: 'Remote' }
    addNotification({
      type: 'error', source: 'ai',
      message: 'Content review failed: 12 errors: 11 rate limited, 1 other.',
      full_message: 'CV #9\nrotation', job: JOB
    })
    addNotification({
      type: 'error', source: 'ai',
      message: 'Content review failed: 12 errors: 11 rate limited, 1 other.',
      full_message: 'CV #9\nrotation', job: other
    })

    const rows = listActiveNotifications().rows
    expect(rows).toHaveLength(2)
    // One group for the drawer to collapse, two things inside it.
    expect(new Set(rows.map((r) => r.group_key)).size).toBe(1)
    expect(new Set(rows.map((r) => r.job?.job_id)).size).toBe(2)
  })

  it('the same failure with no job at all is still folded', () => {
    // The crash path: no job citation at all, so the key is the grouping
    // key plus four empties, and the fold has to work without a job.
    const crash = {
      type: 'error', source: 'app',
      message: 'Internal error: boom',
      full_message: 'Error: boom\n    at tick (app.js:1:1)',
      group_key: 'error|app|internal error: Error'
    }
    addNotification(crash)
    addNotification(crash)

    expect(listActiveNotifications().rows).toHaveLength(1)
  })

  it('six documents failing in one sweep stay six rows with six payloads', () => {
    // The other boundary, and the reason `full_message` is in the key.
    // Ten documents failing with the same one-line summary and ten
    // different raw rotations is TEN things that went wrong; collapsing
    // them into whichever was written first would destroy nine rotations,
    // which is the whole reason the centre exists.
    documentFlood(6)

    const rows = listActiveNotifications().rows
    expect(rows).toHaveLength(6)
    expect(new Set(rows.map((r) => r.full_message)).size).toBe(6)
  })

  it('ten documents swept three times in one tick is TEN rows', () => {
    // N=10 documents, K=3 sweeps, byte-identical payloads per document, all
    // in the same tick. This is the scenario the badge was measured on, and
    // it is what a StrictMode double-mount really produces: the effect runs
    // twice, immediately, over the same documents with the same provider
    // error. Thirty writes, ten rows, and a badge that must say 10.
    const t0 = 1_700_000_000_000
    withClockAt(t0, () => {
      for (let sweep = 0; sweep < 3; sweep++) {
        for (let d = 0; d < 10; d++) {
          addNotification({
            type: 'error', source: 'ai',
            message: 'Content review failed: 12 errors: 11 rate limited, 1 other.',
            full_message: `CV #${d}\nrotation`,
            job: JOB
          })
        }
      }
    })

    const rows = listActiveNotifications().rows
    expect(rows).toHaveLength(10)
    expect(new Set(rows.map((r) => r.full_message)).size).toBe(10)
    // One group — the drawer collapses all ten onto one line and reports
    // ten, which is the number of things that went wrong.
    expect(new Set(rows.map((r) => r.group_key)).size).toBe(1)
  })

  it('the same three sweeps five seconds apart ARE thirty things, and are kept', () => {
    // The boundary the fold must NOT cross, and the reason the window is
    // two seconds rather than thirty. A sweep the user triggered five
    // seconds after the last is a new attempt, on a provider that may since
    // have changed, and thirty rows is the truth about what happened. A
    // window long enough to fold these would tell the user their CV failed
    // once when it failed thirty times.
    const t0 = 1_700_000_000_000
    for (let sweep = 0; sweep < 3; sweep++) {
      withClockAt(t0 + sweep * 5000, () => {
        for (let d = 0; d < 10; d++) {
          addNotification({
            type: 'error', source: 'ai',
            message: 'Content review failed: 12 errors: 11 rate limited, 1 other.',
            full_message: `CV #${d}\nrotation`,
            job: JOB
          })
        }
      })
    }

    expect(listActiveNotifications().rows).toHaveLength(30)
  })

  it('the same failure at a different time is a separate row, not a bigger count', () => {
    // The user's history. Two occurrences minutes apart are two things that
    // happened, and only the second of them is news — the user wants to
    // know the CV failed at 09:14 AND again at 11:02, because something
    // changed in between.
    const t0 = 1_700_000_000_000
    withClockAt(t0, () => sameFactSaidNtimes(2))
    withClockAt(t0 + 60_000, () => sameFactSaidNtimes(2))

    // Two rows, so a badge of two. Two minutes apart is two failures.
    expect(listActiveNotifications().rows).toHaveLength(2)
  })

  it('a repeat lands on the most recent matching row, so the newest survives', () => {
    // Two rows inside the window with the same key — which is what a repeat
    // straddling the boundary of an earlier burst looks like.
    const t0 = 1_700_000_000_000
    const payload = {
      type: 'error', source: 'ai',
      message: 'Content review failed: 12 errors: 11 rate limited, 1 other.',
      full_message: 'CV #9\nrotation', job: JOB
    }
    withClockAt(t0, () => { addNotification(payload) })
    withClockAt(t0 + 60_000, () => { addNotification(payload) })
    withClockAt(t0 + 61_000, () => { addNotification(payload) })

    const rows = listActiveNotifications().rows
    expect(rows).toHaveLength(2)
    // The third went to the newest row rather than starting a third one.
    expect(rows[0].id).toBe(2)
  })

  it('a repeat does not revive a row the user dismissed', () => {
    // The user removed that message on purpose. Putting it back — silently,
    // because a fold looks identical to a write — would undo a decision
    // they made, and they would have no way to tell it happened.
    const { id } = addNotification({
      type: 'error', source: 'ai',
      message: 'Content review failed: 12 errors: 11 rate limited, 1 other.',
      full_message: 'CV #9\nrotation', job: JOB
    })
    dismissNotification(id)

    sameFactSaidNtimes(1)

    const { rows } = listActiveNotifications()
    expect(rows).toHaveLength(1)
    expect(rows[0].id).not.toBe(id)
  })

  it('a fold is still a fold after a restart', () => {
    const t0 = 1_700_000_000_000
    withClockAt(t0, () => sameFactSaidNtimes(5))

    return restartApp().then(() => {
      expect(listActiveNotifications().rows).toHaveLength(1)
    })
  })
})

describe('the grouping key collapses the flood and separates the rest', () => {

  it('ten documents whose failure mixes differ share one key', () => {
    documentFlood(10)
    const { rows } = listActiveNotifications()
    const keys = new Set(rows.map((r) => r.group_key))
    // This is the assertion the whole digit-normalisation exists for: with
    // the raw message as the key this is 10.
    expect(keys.size).toBe(1)
    // ...and no information was lost to get there.
    expect(rows).toHaveLength(10)
    expect(new Set(rows.map((r) => r.full_message)).size).toBe(10)
  })

  it('a flood that includes a single-bucket rotation splits, and that is the right answer', () => {
    // The honest limit of the rule, pinned rather than papered over. A
    // rotation that landed entirely in one bucket summarises to
    // `12 errors: 12 rate limited.`, a different sentence from a mixture
    // and therefore a different fact: "everything was throttled" and
    // "some were throttled and some 503'd" call for different responses.
    // Merging them would buy one tidier row at the price of a row that
    // misstates what happened.
    documentFlood(2)
    addNotification({
      type: 'error',
      source: 'ai',
      message: 'Content review failed: 12 errors: 12 rate limited.',
      full_message: 'CV #99\nall twelve throttled',
      job: JOB
    })

    const rows = listActiveNotifications().rows
    expect(new Set(rows.map((r) => r.group_key)).size).toBe(2)
    // What IS guaranteed is that no occurrence is dropped: all three rows
    // survive, each with its own payload, and one whole-group dismissal
    // still reaches every one of them.
    expect(rows).toHaveLength(3)
    expect(new Set(rows.map((r) => r.full_message)).size).toBe(3)
  })

  it('casing and wrapping cannot split a group', () => {
    addNotification({ type: 'error', source: 'ai', message: 'Content review failed: 1 other.', full_message: 'a' })
    addNotification({ type: 'error', source: 'ai', message: 'content review   failed:  1 other.', full_message: 'b' })
    expect(new Set(listActiveNotifications().rows.map((r) => r.group_key)).size).toBe(1)
  })

  it('a failure and a success are never one group, however alike the text', () => {
    addNotification({ type: 'error', source: 'ai', message: 'Review done.', full_message: 'a' })
    addNotification({ type: 'success', source: 'ai', message: 'Review done.', full_message: 'b' })
    expect(new Set(listActiveNotifications().rows.map((r) => r.group_key)).size).toBe(2)
  })

  it('the job is NOT part of the key, so the same failure across jobs is one thing to think about', () => {
    addNotification({ type: 'error', source: 'ai', message: 'Fit assessment failed for 3 jobs. HTTP 502.', full_message: 'a', job: JOB })
    addNotification({
      type: 'error',
      source: 'ai',
      message: 'Fit assessment failed for 3 jobs. HTTP 502.',
      full_message: 'b',
      job: { ...JOB, job_id: 8, job_title: 'Product Designer', job_company: 'Globex', job_location: null }
    })
    expect(new Set(listActiveNotifications().rows.map((r) => r.group_key)).size).toBe(1)
  })

  it('an explicit key overrides the derived one', () => {
    // What electron/main.ts does for a crash: every `TypeError: message`
    // is one recurring defect however differently it was phrased.
    addNotification({ type: 'error', source: 'app', message: 'Internal error: a', full_message: 'x', group_key: 'error|app|internal error: TypeError' })
    addNotification({ type: 'error', source: 'app', message: 'Internal error: b', full_message: 'y', group_key: 'error|app|internal error: TypeError' })
    expect(new Set(listActiveNotifications().rows.map((r) => r.group_key)).size).toBe(1)
  })

  it('the key is bounded even when the message is a provider error page', () => {
    const huge = `Model 0: ${'x'.repeat(20_000)}`
    addNotification({ type: 'error', source: 'ai', message: huge, full_message: huge })
    const [row] = listActiveNotifications().rows
    expect(row.group_key.length).toBeLessThan(1024)
  })

  it('a notification with nothing to cite stores no job context at all', () => {
    addNotification({ type: 'error', source: 'app', message: 'Backup failed', full_message: 'raw' })
    expect(listActiveNotifications().rows[0].job).toBeUndefined()
  })

  it('a job with no location stores null, not a guess', () => {
    addNotification({
      type: 'error',
      source: 'ai',
      message: 'Generation failed',
      full_message: 'raw',
      job: { job_id: 7, job_title: 'Staff Engineer', job_company: 'Acme', job_location: null }
    })
    const [row] = listActiveNotifications().rows
    expect(row.job?.job_location).toBeNull()
    expect(row.job?.job_title).toBe('Staff Engineer')
  })

  it('blank and whitespace job fields are treated as absent, not as a value', () => {
    addNotification({
      type: 'error',
      source: 'ai',
      message: 'Generation failed',
      full_message: 'raw',
      // What a caller sending `job.location ?? ''` would produce.
      job: { job_id: 7, job_title: '   ', job_company: 'Acme', job_location: '' }
    })
    const [row] = listActiveNotifications().rows
    expect(row.job?.job_title).toBeNull()
    expect(row.job?.job_location).toBeNull()
  })

  it('a company and role with no job id are still citable', () => {
    // The follow-up queue knows these two and has no job id. Storing null
    // beats inventing a number that resolves to nothing.
    addNotification({
      type: 'error',
      source: 'ai',
      message: 'Generation failed',
      full_message: 'raw',
      job: { job_id: null, job_title: 'Recruiter', job_company: 'Acme', job_location: null }
    })
    const [row] = listActiveNotifications().rows
    expect(row.job).toEqual({ job_id: null, job_title: 'Recruiter', job_company: 'Acme', job_location: null })
  })
})

/**
 * The product rule, checked at the only place it can be: what the centre
 * renders, and what it renders when the value is absent.
 *
 * Every field a drawer row shows has to be a real field of a real row, and
 * "we did not have this" has to render as nothing — never as a placeholder,
 * because a placeholder in a record is worse than a missing field: the row
 * looks complete, so nothing prompts anyone to check it.
 *
 * This is a write-side audit rather than a render-side one, and deliberately
 * so: `jobContext` and `cleanJobContext` in src/notifications/record.ts and
 * electron/notifications.ts already own the "no placeholders" rule for job
 * fields, and NotificationDrawer.tsx already owns "render a null as nothing".
 * What is left to pin is that the STORE never manufactures a value on the
 * way in, because a manufactured value would look like a sourced one from
 * every reader downstream.
 */
describe('provenance: every field the centre renders, and what absent looks like', () => {
  it('stores nothing at all for a job it knows no field of', () => {
    // Not four nulls: "we knew nothing" and "we knew the job but it has no
    // location" have to stay distinguishable in the row.
    addNotification({ type: 'error', source: 'app', message: 'Backup failed.', full_message: 'raw', job: { job_id: null, job_title: null, job_company: null, job_location: null } })
    expect(listActiveNotifications().rows[0].job).toBeUndefined()
  })

  it('nulls a job field the caller could not source, and keeps the rest', () => {
    addNotification({
      type: 'error', source: 'app', message: 'Backup failed.', full_message: 'raw',
      job: { job_id: 3, job_title: '   ', job_company: 'Acme', job_location: '' }
    })
    // The title and the location were not there. The company was. What the
    // row does NOT contain is 'Unknown', '—', or the company copied into a
    // field the caller left blank.
    expect(listActiveNotifications().rows[0].job).toEqual({
      job_id: 3, job_title: null, job_company: 'Acme', job_location: null
    })
  })

  it('keeps an unsourced job id null rather than borrowing one from elsewhere', () => {
    // The follow-up queue holds an application id, not a job id. Putting a
    // number in that column would resolve to nothing.
    addNotification({
      type: 'error', source: 'app', message: 'Follow-up failed.', full_message: 'raw',
      job: { job_id: null, job_title: 'Recruiter', job_company: 'Acme', job_location: null }
    })
    expect(listActiveNotifications().rows[0].job?.job_id).toBeNull()
  })

  it('coerces an unrecognised type rather than storing a value nothing can render', () => {
    // A renderer bug must not be able to write a row the drawer cannot draw.
    // 'info' is the honest floor: the app is telling the user something
    // happened, and asserting a severity it cannot justify would be worse.
    addNotification({ type: 'catastrophe', source: 'app', message: 'm', full_message: 'm' })
    expect(listActiveNotifications().rows[0].type).toBe('info')
  })

  it('stores a blank message as blank, and invents no summary for it', () => {
    // No current caller can produce one, but the store is a file on disk
    // that a build wrote, and the drawer's rule is "a field we could not
    // source renders as nothing" — which for the summary means an empty
    // header, not a fabricated one. The row is still identifiable by its
    // type, source, timestamp and full payload.
    addNotification({ type: 'error', source: 'app', message: '   ', full_message: 'the provider body' })
    const [row] = listActiveNotifications().rows
    expect(row.message).toBe('   ')
    expect(row.full_message).toBe('the provider body')
    expect(row.created_at).toBeGreaterThan(0)
  })

  it('gives a blank summary a key that is still a real key', () => {
    // So it groups with other blank summaries rather than landing in a
    // group of its own by accident.
    addNotification({ type: 'error', source: 'app', message: '', full_message: 'a' })
    addNotification({ type: 'error', source: 'app', message: '', full_message: 'b' })
    addNotification({ type: 'info', source: 'app', message: '', full_message: 'c' })
    const rows = listActiveNotifications().rows
    expect(new Set(rows.map((r) => r.group_key)).size).toBe(2)
    // A different type is still a different fact.
    expect(rows.filter((r) => r.type === 'error')).toHaveLength(2)
  })

  it('bounds a provider error body instead of letting it become the whole store', () => {
    // `electron/ai.ts` splices up to 200 chars of a provider's own body into
    // a message; a body carrying request ids and timestamps must not be able
    // to grow the store without limit.
    const huge = 'x'.repeat(40_000)
    addNotification({ type: 'error', source: 'ai', message: huge, full_message: huge })
    const [row] = listActiveNotifications().rows
    expect(row.message.length).toBeLessThanOrEqual(4096)
    expect(row.full_message.length).toBeLessThanOrEqual(4096)
    expect(row.group_key.length).toBeLessThanOrEqual(4096)
  })

  it('reports how many things it recorded, and invents no per-row count', () => {
    // The drawer's number is `listActiveNotifications().rows.length`, so the
    // length is the whole of the badge's provenance. A row must not also
    // carry an emission counter: nothing reads it, and the next person to
    // sum one would put a multiple of the truth back on screen.
    sameFactSaidNtimes(3)
    const { rows } = listActiveNotifications()
    expect(rows).toHaveLength(1)
    expect(Object.keys(rows[0]).sort()).toEqual([
      'created_at', 'dismissed_at', 'full_message', 'group_key', 'id',
      'job', 'message', 'source', 'type'
    ])
  })
})

describe('the store migration', () => {
  it('backfills group_key onto rows written before grouping existed', () => {
    writeLegacyStore([legacyRow])
    reloadStore()

    const { rows } = listActiveNotifications()
    expect(rows).toHaveLength(1)
    expect(rows[0].group_key).toBe(
      notificationGroupKey('error', 'ai', 'Content review failed: 12 errors: 11 rate limited, 1 other.')
    )
  })

  it('backfills consistently, so a pre-existing flood groups exactly like a new one', () => {
    writeLegacyStore([
      legacyRow,
      { ...legacyRow, id: 2, message: 'Content review failed: 12 errors: 10 rate limited, 2 other.' }
    ])
    reloadStore()

    const { rows } = listActiveNotifications()
    expect(rows).toHaveLength(2)
    expect(new Set(rows.map((r) => r.group_key)).size).toBe(1)
  })

  it('leaves every other field on an old row exactly as it was', () => {
    writeLegacyStore([legacyRow])
    reloadStore()
    const [row] = listActiveNotifications().rows
    expect(row.message).toBe(legacyRow.message)
    expect(row.full_message).toBe(legacyRow.full_message)
    expect(row.created_at).toBe(legacyRow.created_at)
    expect(row.dismissed_at).toBeNull()
  })

  it('a store with no notifications key still loads', () => {
    writeLegacyStore([legacyRow])
    writeFileSync(
      join(STORE_DIR, 'apply-assistant-data.json'),
      JSON.stringify({
        jobs: [], documents: [], applications: [], api_models: [],
        nextId: 900, seen_urls: [], ai_queue: [], board_health: {},
        board_scan_times: {}, provider_spend: {}, deleted_jobs: [], settings: {}
      })
    )
    reloadStore()
    expect(listActiveNotifications().rows).toEqual([])
  })

  /**
   * The migration is the only place in the store that trusts a row's
   * SHAPE rather than sanitising it first, and it runs inside `loadStore` —
   * the accessor for the whole Store. A TypeError here does not cost the
   * user their notification list; it costs them their jobs, documents and
   * settings, because every exported helper in database.ts goes through
   * the same load.
   */
  it('a legacy row with no message does not take the whole store down', () => {
    const withoutMessage: Record<string, unknown> = { ...legacyRow }
    delete withoutMessage.message
    writeLegacyStore([withoutMessage])
    expect(() => reloadStore()).not.toThrow()
    expect(listActiveNotifications().rows[0].group_key).toContain('error|ai|')
  })

  it('a legacy row with a null or non-string message does not take the store down', () => {
    writeLegacyStore([
      { ...legacyRow, message: null },
      { ...legacyRow, id: 2, message: 42 },
      { ...legacyRow, id: 3, message: { nested: true } }
    ])
    expect(() => reloadStore()).not.toThrow()
    // Every row still loads and still has a usable key.
    const { rows } = listActiveNotifications()
    expect(rows).toHaveLength(3)
    for (const row of rows) expect(typeof row.group_key).toBe('string')
  })

  it('a notifications value that is not an array is replaced rather than iterated', () => {
    // `if (!store.notifications)` does not catch `{}`, and `for..of` over
    // it throws out of loadStore.
    writeLegacyStore([])
    writeFileSync(
      join(STORE_DIR, 'apply-assistant-data.json'),
      JSON.stringify({
        jobs: [], documents: [], applications: [], api_models: [],
        nextId: 900, seen_urls: [], ai_queue: [], board_health: {},
        board_scan_times: {}, provider_spend: {}, deleted_jobs: [], settings: {},
        notifications: { not: 'an array' }
      })
    )
    expect(() => reloadStore()).not.toThrow()
    expect(listActiveNotifications().rows).toEqual([])
  })

  it('a row that is not an object at all is dropped rather than crashing the load', () => {
    // Same reasoning as the array guard: `for..of` handing this loop a
    // `null` or a number would throw out of loadStore, which is the
    // accessor for the whole Store — jobs, documents and settings included.
    writeLegacyStore([legacyRow, null as never, 42 as never, 'x' as never])
    expect(() => reloadStore()).not.toThrow()
    expect(listActiveNotifications().rows).toHaveLength(1)
  })

  /**
   * MINOR 6 — the corrupt-row arm.
   *
   * Dropping the entry is right: it is the only way to keep a string out of
   * a list that ten screens iterate. Dropping it SILENTLY is what made this
   * a defect, because the renderer had one shape to read and it was the
   * shape that means "there is nothing here". A store whose only entry is
   * `'not-an-object'` used to load to `rows: []`, and the drawer answered
   * "No notifications." about a store that was not empty.
   */
  it('REPORTS the entries it had to drop, rather than reporting an empty store', () => {
    writeLegacyStore(['not-an-object'])
    reloadStore()

    const { rows, unreadable } = listActiveNotifications()
    expect(rows).toHaveLength(0)
    // One thing could not be read. That is what the drawer needs to say
    // instead of "there is nothing in here".
    expect(unreadable).toBe(1)
  })

  it('counts only the entries it dropped, not the ones it could read', () => {
    writeLegacyStore([legacyRow, { ...legacyRow, id: 2 }, null as never, 'x' as never, 7 as never])
    reloadStore()

    const { rows, unreadable } = listActiveNotifications()
    expect(rows).toHaveLength(2)
    expect(unreadable).toBe(3)
  })

  it('reports a list that was not an array at all, as one unreadable thing', () => {
    // `{}` in `notifications` is the same lie from the other direction: the
    // store holds something the app cannot read, and replacing it with `[]`
    // turns that into "empty".
    writeLegacyStore([])
    writeFileSync(
      join(STORE_DIR, 'apply-assistant-data.json'),
      JSON.stringify({
        jobs: [], documents: [], applications: [], api_models: [],
        nextId: 900, seen_urls: [], ai_queue: [], board_health: {},
        board_scan_times: {}, provider_spend: {}, deleted_jobs: [],
        blacklisted_companies: [], settings: {},
        notifications: { not: 'an array' }
      })
    )
    reloadStore()

    const { rows, unreadable } = listActiveNotifications()
    expect(rows).toHaveLength(0)
    expect(unreadable).toBe(1)
  })

  it('a store with no notifications key at all reports nothing unreadable', () => {
    // The upgrade case, and the one that must stay silent: a store written
    // before the centre existed has no list to have failed to read. Counting
    // that would put a permanent banner on every upgraded install.
    writeLegacyStore([legacyRow])
    writeFileSync(
      join(STORE_DIR, 'apply-assistant-data.json'),
      JSON.stringify({
        jobs: [], documents: [], applications: [], api_models: [],
        nextId: 900, seen_urls: [], ai_queue: [], board_health: {},
        board_scan_times: {}, provider_spend: {}, deleted_jobs: [],
        blacklisted_companies: [], settings: {}
      })
    )
    reloadStore()

    expect(listActiveNotifications().unreadable).toBe(0)
  })

  it('stops reporting once the store is written, because the file is clean', () => {
    // The count describes the FILE, not the in-memory object: the dropped
    // entries are gone from the object already but still in the file until
    // something writes it. A banner that outlives the condition it
    // describes is its own kind of lie.
    writeLegacyStore(['not-an-object'])
    reloadStore()
    expect(listActiveNotifications().unreadable).toBe(1)

    addNotification({ type: 'error', source: 'app', message: 'm', full_message: 'm' })

    expect(listActiveNotifications().unreadable).toBe(0)
    // ...and it stays clean across a reload, because the file no longer
    // has the entry in it.
    return restartApp().then(() => {
      expect(listActiveNotifications().unreadable).toBe(0)
    })
  })

  it('re-reports on a reload only while the file still holds the entry', () => {
    // The count describes the FILE. On first load the migration also
    // persists the store — it has to, it just filled in `group_key` on
    // every row — and that write replaces the list with the filtered one,
    // so the entry is gone from disk before anyone reads the list. The
    // report therefore survives the rest of this session, where the cached
    // store keeps saying it, and does not survive a restart, because by
    // then the file genuinely no longer holds anything unreadable.
    writeLegacyStore(['not-an-object'])
    reloadStore()
    expect(listActiveNotifications().unreadable).toBe(1)

    // Still 1 on a second read with no reload: the store is cached and the
    // condition the user needs to hear about has not changed.
    expect(listActiveNotifications().unreadable).toBe(1)

    return restartApp().then(() => {
      expect(listActiveNotifications().unreadable).toBe(0)
      // ...and the repaired list is what is left: empty, and no longer
      // claiming to be complete about a file that is now clean.
      expect(listActiveNotifications().rows).toHaveLength(0)
    })
  })

  it('a row with no type or source still gets a well-formed key', () => {
    writeLegacyStore([{ ...legacyRow, type: undefined, source: undefined }])
    expect(() => reloadStore()).not.toThrow()
    expect(listActiveNotifications().rows[0].group_key).toBe('||content review failed: # errors: # rate limited, # other.')
  })
})

describe('dismissing a group', () => {
  function flood(count: number, message: string): number[] {
    const ids: number[] = []
    for (let i = 0; i < count; i++) {
      ids.push(addNotification({ type: 'error', source: 'ai', message, full_message: `attempt ${i}`, job: JOB }).id)
    }
    return ids
  }

  it('removes exactly the ids it was given', () => {
    const doomed = flood(3, 'Content review failed: 12 errors: 11 rate limited, 1 other.')
    flood(1, 'Generation failed: all 12 configured AI models failed.')

    const result = dismissNotifications(doomed)

    expect(result.updated).toBe(3)
    const { rows } = listActiveNotifications()
    expect(rows.map((r) => r.message)).toEqual(['Generation failed: all 12 configured AI models failed.'])
  })

  it('an id that is already dismissed or unknown is not an error', () => {
    const ids = flood(2, 'Content review failed.')
    dismissNotification(ids[0])
    // One of the three ids is already gone and one was never there. The
    // call still does its job and reports what it actually changed,
    // because the renderer's list can be a tick stale and answering "no
    // such row" for something the user just clicked would be a lie.
    expect(dismissNotifications([...ids, 9999]).updated).toBe(1)
    expect(listActiveNotifications().rows).toHaveLength(0)
  })

  it('an empty list writes nothing at all', () => {
    flood(1, 'Content review failed.')
    expect(dismissNotifications([]).updated).toBe(0)
    expect(listActiveNotifications().rows).toHaveLength(1)
  })

  it('dismissAll still clears everything, groups included', () => {
    flood(3, 'Content review failed.')
    flood(2, 'Generation failed.')
    expect(dismissAllNotifications().updated).toBe(5)
    expect(listActiveNotifications().rows).toEqual([])
  })
})