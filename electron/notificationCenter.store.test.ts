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

import { reloadStore } from './database'
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

describe('the grouping key collapses the flood and separates the rest', () => {
  /**
   * The shape the reported bug produced: one generate click, several
   * documents, each its own rotation over the same 12-model pool, so the
   * bucket counts differ while the failure is the same.
   *
   * Every mix here is one `toastErrorSummary` can actually emit — a
   * non-zero count for each bucket it names, because it filters empty
   * buckets out (src/aiErrorSummary.ts). A fixture with `0 rate limited`
   * would key identically today and would quietly stop keying the moment
   * that filter changed, which is a test that has stopped testing the
   * thing it names.
   */
  function flood(count: number): void {
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

  it('ten documents whose failure mixes differ share one key', () => {
    flood(10)
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
    flood(2)
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

describe('the store migration', () => {
  /**
   * Writes a store file by hand in the pre-grouping shape, then loads it.
   * The point is to prove an EXISTING user's rows still load and still
   * group, not just that new ones do.
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

  const legacyRow = {
    id: 1,
    type: 'error',
    source: 'ai',
    message: 'Content review failed: 12 errors: 11 rate limited, 1 other.',
    full_message: 'the whole rotation',
    created_at: 1_700_000_000_000,
    dismissed_at: null
  }

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