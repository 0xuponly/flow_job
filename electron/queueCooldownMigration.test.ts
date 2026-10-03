/**
 * The one-shot repair for queue rows poisoned by the 2026-10-02 bug.
 *
 * The bug is fixed for anything that fails from now on. A store written
 * by the old build still holds its damage: rows that burned all ten
 * attempts on failures that never reached the provider, sitting `failed`,
 * and rows parked `pending` on the four-hour auto-revive cooldown with an
 * exhausted budget and nothing to show for it. The work is not lost — it
 * is stalled, with a budget nobody can spend.
 *
 * So this file is mostly about what the repair must NOT do. It runs
 * against a real store, because the whole claim is about rows in one:
 *
 *   - it resets only what a no-request block actually cost
 *   - it leaves a row that failed for any other reason alone
 *   - it never resurrects work the user cleared, which is what the
 *     clear's tombstone exists to prevent
 *   - it runs once, and re-running it touches nothing
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { STORE_DIR } = vi.hoisted(() => ({
  STORE_DIR: `/tmp/flow_job-test-qunpoison-${process.env.FLOW_JOB_TEST_RUN_ID ?? `pid${process.pid}`}`
}))

vi.mock('electron', () => ({
  app: {
    getPath: (_key: string) => STORE_DIR,
    getAppPath: () => `${STORE_DIR}/app`,
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

import { PROVIDERS_COOLING_DOWN_MESSAGE } from './cooldownBlock'
import {
  addAIQueueItem,
  clearAIQueue,
  createJob,
  getAIQueue,
  getQueueClearedAt,
  reloadStore,
  removeAIQueueItem,
  unpoisonCooldownFailedAIQueueItems,
  updateAIQueueItem,
  updateSettings
} from './database'
import type { AIQueueItem } from './types'

/** A genuinely rate-limited rotation's message: real requests, real spend. */
const GENUINE_429_MESSAGE =
  'All 3 configured AI models are rate limited — try again in a minute:\nm0: rate limited (429)\nm1: rate limited (429)'

let seq = 0

/**
 * A queue row in a chosen state.
 *
 * `addAIQueueItem` always stamps `status: 'pending'`, `attempts: 0` and
 * `nextRetryAt: now`, so a row that looks like the old build left it is
 * written by patching that row afterwards — which is also how those rows
 * got that way.
 */
function rowWith(overrides: Partial<AIQueueItem>, jobId?: number): number {
  const job = jobId ?? createJob({ title: `T ${seq}`, company: `C ${seq++}` }).job.id
  const created = addAIQueueItem({ type: 'verify', jobId: job, documentId: 1 } as never)
  updateAIQueueItem(created.id, overrides)
  return created.id
}

function row(id: number): AIQueueItem {
  const found = getAIQueue().find((q) => q.id === id)
  if (!found) throw new Error(`no queue row ${id}`)
  return found
}

function emptyQueue(): void {
  for (const row of getAIQueue()) removeAIQueueItem(row.id)
}

beforeEach(() => {
  reloadStore()
  emptyQueue()
  updateSettings({ queue_cooldown_reset_v1: '' })
})

afterEach(() => {
  emptyQueue()
})

describe('unpoisonCooldownFailedAIQueueItems', () => {
  it('gives a failed row its budget back and makes it due now', () => {
    const id = rowWith({
      status: 'failed',
      attempts: 10,
      lastError: PROVIDERS_COOLING_DOWN_MESSAGE
    })

    const result = unpoisonCooldownFailedAIQueueItems()

    expect(result).toMatchObject({ reset: 1, unstuck: 0, alreadyMigrated: false })
    const fixed = row(id)
    expect(fixed.status).toBe('pending')
    expect(fixed.attempts).toBe(0)
    expect(fixed.nextRetryAt).toBeLessThanOrEqual(Date.now())
  })

  it('unsticks a row parked on the four-hour cooldown', () => {
    const id = rowWith({
      status: 'pending',
      attempts: 0,
      autoRevives: 1,
      nextRetryAt: Date.now() + 4 * 60 * 60 * 1000,
      lastError: PROVIDERS_COOLING_DOWN_MESSAGE
    })

    const result = unpoisonCooldownFailedAIQueueItems()

    expect(result).toMatchObject({ reset: 0, unstuck: 1 })
    expect(row(id).nextRetryAt).toBeLessThanOrEqual(Date.now())
  })

  it('clears the block marker so a repaired row does not render as waiting', () => {
    const id = rowWith({
      status: 'failed',
      attempts: 10,
      blockedSince: Date.now(),
      blockedCount: 7,
      lastError: PROVIDERS_COOLING_DOWN_MESSAGE
    })

    unpoisonCooldownFailedAIQueueItems()

    // The cooldown that produced this error has been dealt with; the row
    // must not still be presented as parked on the provider clock.
    expect(row(id).blockedSince).toBeUndefined()
    expect(row(id).blockedCount).toBeUndefined()
  })

  it('leaves a row that failed for a real reason exactly as it was', () => {
    // These DID cost provider requests, so their budget was honestly
    // spent and resetting it would be handing out free retries.
    const genuine429 = rowWith({
      status: 'failed',
      attempts: 10,
      lastError: GENUINE_429_MESSAGE
    })
    const timeout = rowWith({
      status: 'failed',
      attempts: 10,
      lastError: 'm0: timeout'
    })
    const noRecord = rowWith({ status: 'failed', attempts: 10 })

    const result = unpoisonCooldownFailedAIQueueItems()

    expect(result).toMatchObject({ reset: 0, unstuck: 0 })
    for (const id of [genuine429, timeout, noRecord]) {
      expect(row(id).attempts).toBe(10)
      expect(row(id).status).toBe('failed')
    }
  })

  it('leaves a `processing` row alone: its status is not evidence of anything', () => {
    const id = rowWith({
      status: 'processing',
      attempts: 3,
      lastError: PROVIDERS_COOLING_DOWN_MESSAGE
    })

    unpoisonCooldownFailedAIQueueItems()

    // `processing` means "claimed, in flight" — that row is reclaimed at
    // startup, and its `lastError` is left over from the previous round.
    const untouched = row(id)
    expect(untouched.status).toBe('processing')
    expect(untouched.attempts).toBe(3)
  })

  it('does not resurrect a row the user cleared', () => {
    // The clear is durable: it deletes the rows AND writes a tombstone,
    // because two re-seeders rebuild queue rows from the jobs table and
    // would otherwise put the cancelled work straight back. A row for a
    // job at or below the watermark is that work, whatever put it there.
    seq++
    const clearedJobId = createJob({ title: 'Cleared', company: `Old ${seq++}` }).job.id
    expect(getQueueClearedAt()).toBe(0)

    clearAIQueue()
    expect(getQueueClearedAt()).toBeGreaterThan(0)

    // A lane that gets the tombstone wrong puts the cleared work back…
    const resurrected = rowWith({
      status: 'failed', attempts: 10, lastError: PROVIDERS_COOLING_DOWN_MESSAGE
    }, clearedJobId)
    // …while work that arrived after the clear is not cancelled.
    const freshJobId = createJob({ title: 'Fresh', company: `New ${seq++}` }).job.id
    const later = rowWith({
      status: 'failed', attempts: 10, lastError: PROVIDERS_COOLING_DOWN_MESSAGE
    }, freshJobId)

    const result = unpoisonCooldownFailedAIQueueItems()

    // Counted and skipped, not reset: this is work the user cancelled.
    expect(result.clearedWorkSkipped).toBe(1)
    const skipped = row(resurrected)
    expect(skipped.status).toBe('failed')
    expect(skipped.attempts).toBe(10)
    // Work that arrived after the clear is repaired normally.
    expect(row(later).status).toBe('pending')
  })

  it('never adds a row, so a cleared queue stays empty', () => {
    const stale = rowWith({ status: 'failed', attempts: 10, lastError: PROVIDERS_COOLING_DOWN_MESSAGE })
    clearAIQueue()
    expect(getAIQueue()).toHaveLength(0)

    unpoisonCooldownFailedAIQueueItems()

    // The poisoned row is gone from the store entirely — that is what the
    // clear did — and nothing in this repair can bring it back, because it
    // only ever rewrites rows that are already present.
    expect(getAIQueue()).toHaveLength(0)
    expect(getAIQueue().some((q) => q.id === stale)).toBe(false)
  })

  it('runs once: a second pass is a no-op', () => {
    const id = rowWith({ status: 'failed', attempts: 10, lastError: PROVIDERS_COOLING_DOWN_MESSAGE })
    unpoisonCooldownFailedAIQueueItems()

    // A row that fails on the cooldown again afterwards is left to the
    // live fix, not to a migration that has already run.
    updateAIQueueItem(id, { status: 'failed', attempts: 10, lastError: PROVIDERS_COOLING_DOWN_MESSAGE })
    const second = unpoisonCooldownFailedAIQueueItems()

    expect(second).toEqual({ reset: 0, unstuck: 0, clearedWorkSkipped: 0, alreadyMigrated: true })
    expect(row(id).attempts).toBe(10)
    expect(row(id).status).toBe('failed')
  })

  it('preserves the record of what happened, and invents no recovery budget', () => {
    const id = rowWith({
      status: 'failed',
      attempts: 10,
      autoRevives: 2,
      lastError: PROVIDERS_COOLING_DOWN_MESSAGE
    })

    unpoisonCooldownFailedAIQueueItems()

    const fixed = row(id)
    // A no-op failure may have charged one of these. Granting it back
    // would be fabricating budget; the user's Reset is how that is asked
    // for.
    expect(fixed.autoRevives).toBe(2)
    // The failure is still on the row: this repairs a budget, it does not
    // rewrite history.
    expect(fixed.lastError).toBe(PROVIDERS_COOLING_DOWN_MESSAGE)
  })

  it('repairs every matching row in one pass, not just the first', () => {
    const ids = [1, 2, 3].map(() =>
      rowWith({ status: 'failed', attempts: 10, lastError: PROVIDERS_COOLING_DOWN_MESSAGE })
    )

    const result = unpoisonCooldownFailedAIQueueItems()

    expect(result.reset).toBe(3)
    for (const id of ids) {
      expect(row(id).attempts).toBe(0)
      expect(row(id).status).toBe('pending')
    }
  })
})