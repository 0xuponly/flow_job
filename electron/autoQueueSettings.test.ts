import { describe, it, expect, vi, beforeEach } from 'vitest'

// The five auto-queue switches, against the REAL store.
//
// These are the store half of the feature: what a fresh install gets, what
// an older store is normalised to, and that a turn-off survives a
// restart. The queue half — a switch actually stopping work — lives in
// aiQueue.autoQueue.test.ts, because a store test cannot tell "the
// setting was read" from "the setting was obeyed".

// Own userData directory: vitest runs test FILES in parallel and several
// suites drive the real store, so sharing database.test.ts's path would
// have them wiping each other's data mid-run. hoisted because the
// electron mock factory runs before module-level consts.
const { STORE_DIR } = vi.hoisted(() => ({ STORE_DIR: `/tmp/flow_job-test-autoqueue-settings-${process.env.FLOW_JOB_TEST_RUN_ID ?? `pid${process.pid}`}` }))

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

import { existsSync, unlinkSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { getSettings, reloadStore, updateSettings } from './database'

const storeFile = join(STORE_DIR, 'apply-assistant-data.json')
const keyFile = join(STORE_DIR, 'apply-assistant-key')

const AUTO_QUEUE_KEYS = [
  'auto_queue_fit',
  'auto_queue_cv',
  'auto_queue_cover_letter',
  'auto_queue_verify_cv',
  'auto_queue_verify_cover_letter'
] as const

function wipe() {
  if (!existsSync(STORE_DIR)) mkdirSync(STORE_DIR, { recursive: true })
  for (const f of [storeFile, keyFile]) {
    if (existsSync(f)) unlinkSync(f)
  }
}

/**
 * Force the next read to come off disk, the way a fresh process would.
 *
 * persistStore chains its write onto a promise, so a reload in the same
 * tick would read the file as it stood BEFORE the write. Yielding to a
 * macrotask first is what a real process restart gives us for free.
 */
async function simulateRestart(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
  reloadStore()
}

/**
 * Write a store file as an older build would have: the settings object
 * as it was, with the auto-queue keys absent or corrupt.
 *
 * Plaintext JSON, no `enc:` envelope — loadStore's legacy branch accepts
 * it (it reads as legacy because the settings object has keys), which is
 * exactly how a store from before file-level encryption loads. That is
 * the realistic shape of the store this normalisation exists for.
 */
function writeLegacyStore(settings: Record<string, unknown>): void {
  writeFileSync(
    storeFile,
    JSON.stringify({
      jobs: [],
      documents: [],
      applications: [],
      follow_ups: [],
      interviews: [],
      settings,
      api_models: [],
      nextId: 1,
      seen_urls: [],
      ai_queue: [],
      board_health: {},
      board_scan_times: {},
      deleted_jobs: [],
      blacklisted_companies: [],
      notifications: []
    })
  )
}

beforeEach(() => {
  wipe()
  reloadStore()
})

describe('auto-queue defaults', () => {
  it('turns all five on in a fresh store', () => {
    // The pre-feature behaviour was "the app queues this", so `true` is
    // the only default that changes nothing on upgrade. A single `false`
    // here would silently switch off work for every existing user.
    const s = getSettings()
    for (const key of AUTO_QUEUE_KEYS) {
      expect(s[key], key).toBe(true)
    }
  })
})

describe('auto-queue normalisation', () => {
  it('backfills a key an older store never had', () => {
    // The store that motivates the whole rule: written before the
    // settings existed, with no key at all.
    writeLegacyStore({ base_cv: 'CV', user_name: 'Sam' })
    reloadStore()
    for (const key of AUTO_QUEUE_KEYS) {
      expect(getSettings()[key], key).toBe(true)
    }
  })

  it('coerces a non-boolean value to true rather than reading it as off', async () => {
    // A hand-edited store can hold anything. "false" as a STRING is the
    // dangerous case: a truthiness check would call that off and quietly
    // stop a feature nobody turned off.
    writeLegacyStore({
      base_cv: 'CV',
      auto_queue_fit: 'false',
      auto_queue_cv: 0,
      auto_queue_cover_letter: null,
      auto_queue_verify_cv: '',
      auto_queue_verify_cover_letter: 'no'
    })
    reloadStore()
    for (const key of AUTO_QUEUE_KEYS) {
      expect(getSettings()[key], key).toBe(true)
    }
    await simulateRestart()
    for (const key of AUTO_QUEUE_KEYS) {
      expect(getSettings()[key], key).toBe(true)
    }
  })

  it('leaves an explicit false alone', () => {
    // The whole feature is that `false` survives normalisation. If this
    // broke, the user's switch would spring back on every launch.
    writeLegacyStore({ base_cv: 'CV', auto_queue_cv: false })
    reloadStore()
    expect(getSettings().auto_queue_cv).toBe(false)
  })

  it('normalises only the auto-queue keys and nothing else in the store', () => {
    // Regression guard on the loop's scope: it must not be a general
    // "fix the settings" pass.
    writeLegacyStore({ base_cv: 'CV', user_name: 'Sam', auto_scan_enabled: 'yes' })
    reloadStore()
    expect(getSettings().user_name).toBe('Sam')
    expect(getSettings().auto_scan_enabled).toBe(true)
  })
})

describe('updateSettings round-trips the auto-queue keys', () => {
  it('reads back what was written, one key at a time', () => {
    for (const key of AUTO_QUEUE_KEYS) {
      updateSettings({ [key]: false })
      expect(getSettings()[key], key).toBe(false)
      updateSettings({ [key]: true })
      expect(getSettings()[key], key).toBe(true)
    }
  })

  it('leaves the other switches untouched when one changes', () => {
    updateSettings({ auto_queue_cv: false })
    const s = getSettings()
    expect(s.auto_queue_fit).toBe(true)
    expect(s.auto_queue_cover_letter).toBe(true)
    expect(s.auto_queue_verify_cv).toBe(true)
    expect(s.auto_queue_verify_cover_letter).toBe(true)
  })

  it('survives a restart', async () => {
    // The renderer reads these back on launch and shows them as the
    // persisted state. A write that did not reach disk would show the
    // user a switch that silently springs back on.
    updateSettings({
      auto_queue_fit: false,
      auto_queue_cv: false,
      auto_queue_cover_letter: true,
      auto_queue_verify_cv: false,
      auto_queue_verify_cover_letter: true
    })
    await simulateRestart()
    const s = getSettings()
    expect(s.auto_queue_fit).toBe(false)
    expect(s.auto_queue_cv).toBe(false)
    expect(s.auto_queue_cover_letter).toBe(true)
    expect(s.auto_queue_verify_cv).toBe(false)
    expect(s.auto_queue_verify_cover_letter).toBe(true)
  })
})