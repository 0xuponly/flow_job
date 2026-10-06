/**
 * THE SPEND, SHIPPED.
 *
 * The defect this pins down was never a wrong number. `providerBudget`
 * (`ai.ts`) computed the real spend for a real 6h44m window — 629 provider
 * requests issued, every one of them logged `origin=manual` — and Settings →
 * Auto-queue → AI provider budget showed the user the 50 they had typed,
 * because nothing carried the computed number across the process boundary.
 * `grep -n "ipcMain.handle('ai" electron/main.ts` found no budget handle at
 * all: the value existed, was correct, and was dead to the renderer.
 *
 * So the assertions here are about what CROSSES that boundary, driven through
 * the REAL handler `main.ts` registers rather than against the module that
 * computes it — a test of `providerSpendRows()` alone would pass just as
 * happily with no handler registered at all, which is the defect.
 *
 * Instrument: a real store, the real `ai.ts`, the real `providerKey`, and the
 * real `recordProviderCall` the wire path uses. Nothing about the ledger is
 * stubbed, so every count asserted is the count the cap compares against.
 * Only `electron` is mocked, to capture the handler registrations.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, unlinkSync } from 'fs'
import { join } from 'path'

const { STORE_DIR, handlers } = vi.hoisted(() => ({
  STORE_DIR: `/tmp/flow_job-test-providerspend-${process.env.FLOW_JOB_TEST_RUN_ID ?? `pid${process.pid}`}`,
  handlers: new Map<string, (...args: unknown[]) => unknown>()
}))

vi.mock('electron', () => {
  const app = {
    getPath: () => STORE_DIR,
    getAppPath: () => `${STORE_DIR}/app`,
    getName: () => 'flow_job',
    getVersion: () => '0.0.0-test',
    setName: () => undefined,
    on: () => undefined,
    whenReady: () => Promise.resolve(),
    isReady: () => true,
    quit: () => undefined,
    setLoginItemSettings: () => undefined,
    disableHardwareAcceleration: () => undefined,
    commandLine: { appendSwitch: () => undefined },
    requestSingleInstanceLock: () => true
  }
  class BrowserWindow {
    static getAllWindows() { return [] }
    webContents = {
      send: () => undefined,
      setWindowOpenHandler: () => undefined,
      on: () => undefined,
      openDevTools: () => undefined
    }
    on() { return undefined }
    once() { return undefined }
    loadURL() { return Promise.resolve() }
    loadFile() { return Promise.resolve() }
    show() { return undefined }
    focus() { return undefined }
    destroy() { return undefined }
  }
  return {
    app,
    ipcMain: {
      handle: (channel: string, fn: (...a: unknown[]) => unknown) => { handlers.set(channel, fn) },
      on: () => undefined,
      removeHandler: () => undefined
    },
    BrowserWindow,
    dialog: {
      showMessageBox: () => Promise.resolve({ response: 0 }),
      showOpenDialog: () => Promise.resolve({ canceled: true, filePaths: [] }),
      showSaveDialog: () => Promise.resolve({ canceled: true })
    },
    screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1920, height: 1080 } }) },
    session: {
      defaultSession: {
        webRequest: {
          onHeadersReceived: () => undefined,
          onBeforeRequest: () => undefined
        }
      }
    },
    shell: { openExternal: () => Promise.resolve() },
    safeStorage: {
      isEncryptionAvailable: () => false,
      encryptString: (s: string) => Buffer.from(s, 'utf8'),
      decryptString: (b: Buffer) => b.toString('utf8')
    }
  }
})

import {
  addApiModel,
  deleteApiModel,
  listApiModels,
  recordProviderCall,
  reloadStore,
  updateSettings
} from './database'
import { providerKey } from './ai'

// Importing the main process module is what runs `registerIpc()`, so the
// handler this file drives is the one the renderer would reach.
await import('./main')

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

const OPENROUTER = 'https://openrouter.ai/api/v1'
const ZEN = 'https://opencode.ai/zen/v1'
const KEY_A = 'sk-or-key-aaaaaaaaaaaaaaaa'
const KEY_B = 'sk-zen-key-bbbbbbbbbbbbbbb'

/** One IPC call, through the handler `main.ts` actually registered. */
function readSpend(): Record<string, unknown>[] {
  const handler = handlers.get('ai:providerSpend')
  if (!handler) throw new Error('no handler registered for ai:providerSpend')
  return handler({}) as Record<string, unknown>[]
}

function wipe(): void {
  if (!existsSync(STORE_DIR)) mkdirSync(STORE_DIR, { recursive: true })
  for (const f of [join(STORE_DIR, 'apply-assistant-data.json'), join(STORE_DIR, 'apply-assistant-key')]) {
    if (existsSync(f)) unlinkSync(f)
  }
  reloadStore()
}

function addModel(baseUrl: string, apiKey: string, name: string): string {
  const models = addApiModel({ name, base_url: baseUrl, api_key: apiKey, model: `${name}:free` } as never)
  return models[models.length - 1].id
}

function bucketOf(baseUrl: string, apiKey: string): string {
  return providerKey({ base_url: baseUrl, api_key: apiKey } as never)
}

/**
 * The ledger the assessment measured: 629 real requests against a cap of 50,
 * the first 50 automated and the rest manual, written through the one
 * function the wire path calls.
 */
function ledgerOf629(t0: number, baseUrl = OPENROUTER, apiKey = KEY_A): string {
  const key = bucketOf(baseUrl, apiKey)
  for (let i = 0; i < 629; i++) recordProviderCall(key, i >= 50, t0 + i * 1000)
  return key
}

beforeEach(() => {
  wipe()
  updateSettings({ base_cv: 'MASTER CV', provider_call_cap: 50 })
  vi.useFakeTimers({ toFake: ['Date'] })
})

afterEach(() => {
  vi.useRealTimers()
})

// ---------------------------------------------------------------------------
// 1. THE HANDLE EXISTS AND CARRIES THE REAL LEDGER.
// ---------------------------------------------------------------------------

describe('the AI provider budget the Settings page reads', () => {
  it('reports the spend that actually happened, not the cap the user typed', () => {
    // 629 requests issued against a cap of 50, and the whole point of this
    // handler: the 50 is in the payload TOO, as the cap, and the 629 is in it
    // as the spend. Before the handler existed the renderer had the first
    // number only, which is the defect this file exists for.
    const t0 = new Date(2026, 9, 5, 12, 0, 0).getTime()
    vi.setSystemTime(t0)
    ledgerOf629(t0)
    addModel(OPENROUTER, KEY_A, 'or')

    const rows = readSpend()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      label: 'openrouter.ai',
      used: 629,
      automated: 50,
      manual: 579,
      cap: 50
    })
    // The free time is the real one — the instant `used` drops below the cap
    // — and not the oldest call plus a window, which on this ledger is ~24h
    // early and would tell the user to come back while the provider is still
    // refusing them. See `windowFreesAt`.
    const stamps = Array.from({ length: 629 }, (_, i) => t0 + i * 1000)
    expect(rows[0].freeAt).toBe(stamps[629 - 50] + DAY)
  })

  it('gives each configured key its own row and its own count', () => {
    // The cap is per provider because the budget is per CREDENTIAL
    // (`providerKey`), so two keys are two ledgers. One number for the pair
    // would be the same class of defect as showing the cap for both.
    const t0 = new Date(2026, 9, 5, 12, 0, 0).getTime()
    vi.setSystemTime(t0)
    ledgerOf629(t0, OPENROUTER, KEY_A)
    for (let i = 0; i < 7; i++) recordProviderCall(bucketOf(ZEN, KEY_B), true, t0 + i * 1000)
    addModel(OPENROUTER, KEY_A, 'or')
    addModel(ZEN, KEY_B, 'zen')

    const rows = readSpend()
    expect(rows.map((r) => [r.label, r.used])).toEqual([
      ['openrouter.ai', 629],
      ['opencode.ai', 7]
    ])
    // ...and both are measured against the one cap the user set, because the
    // cap is a single setting applied per provider.
    expect(rows.map((r) => r.cap)).toEqual([50, 50])
  })

  it('one row per provider, not one per model on it', () => {
    // Twenty free models on one key are twenty models and ONE budget, which
    // is why a pool of free models runs out sooner than the model count
    // suggests. A row per model would show the user twenty numbers and hide
    // the one that matters.
    const t0 = new Date(2026, 9, 5, 12, 0, 0).getTime()
    vi.setSystemTime(t0)
    ledgerOf629(t0)
    for (let i = 0; i < 20; i++) addModel(OPENROUTER, KEY_A, `or${i}`)

    expect(readSpend()).toHaveLength(1)
  })

  it('counts a provider configured without an API key against the same cap', () => {
    // A blank key is a real configuration, not an absent one: the shipped
    // OpenRouter presets are all blank until the user pastes their key, and a
    // local endpoint needs no key at all. `credentialFingerprint('')` is
    // 'anonymous', so it buckets as its own provider rather than merging into
    // the keyed one — and a real zero is what it reports, because nothing has
    // been spent through it. Inventing a row for a provider that does not
    // exist would be the opposite claim, and is pinned below.
    const t0 = new Date(2026, 9, 5, 12, 0, 0).getTime()
    vi.setSystemTime(t0)
    ledgerOf629(t0)
    addModel(OPENROUTER, KEY_A, 'or')
    addModel('http://localhost:11434/v1', '', 'ollama')

    const rows = readSpend()
    expect(rows).toHaveLength(2)
    const local = rows.find((r) => r.label === 'localhost:11434')
    expect(local).toMatchObject({ used: 0, cap: 50, freeAt: null })
    // The port is part of the host and is what tells two local services on one
    // machine apart, so it survives the trim the path gets.
    expect(JSON.stringify(rows)).not.toContain('11434/v1')
  })

  it('has no row at all for a provider that does not exist', () => {
    // Nothing configured and nothing spent: an empty list, and specifically
    // not a row carrying a zero. A zero here would be indistinguishable, on
    // screen, from "this provider has spent nothing" — a claim about a
    // provider the user never configured.
    const t0 = new Date(2026, 9, 5, 12, 0, 0).getTime()
    vi.setSystemTime(t0)

    expect(readSpend()).toEqual([])
  })

  it('still shows spend on a provider whose model the user has since deleted', () => {
    // The other half of "which providers exist", and the reason the row list
    // is the union of the configured models and the ledger rather than the
    // configured models alone: deleting a model does not un-spend the money,
    // and `getProviderSpend` only prunes a bucket once every stamp in it has
    // aged out of the window. A ledger that says 629 and a Settings page that
    // says nothing is the same defect as the one this handler was added for.
    const t0 = new Date(2026, 9, 5, 12, 0, 0).getTime()
    vi.setSystemTime(t0)
    ledgerOf629(t0)
    const id = addModel(OPENROUTER, KEY_A, 'or')
    expect(readSpend()[0]).toMatchObject({ used: 629 })

    deleteApiModel(id)
    const rows = readSpend()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ label: 'openrouter.ai', used: 629, cap: 50 })
  })

  it('reports the cap the app is enforcing, not the one still in the input', () => {
    // The page shows the spend NEXT TO the input the user edits, so the two
    // numbers have to be the same cap or the row lies about the comparison.
    // A store whose cap is nonsense is clamped by `resolveProviderCap`, and
    // the page renders the effective value from the store's own backfill —
    // what matters here is that this handle does not invent its own.
    const t0 = new Date(2026, 9, 5, 12, 0, 0).getTime()
    vi.setSystemTime(t0)
    updateSettings({ provider_call_cap: 120 })
    addModel(ZEN, KEY_B, 'zen')

    expect(readSpend()[0]).toMatchObject({ cap: 120, used: 0 })
  })
})

// ---------------------------------------------------------------------------
// 2. NOTHING THE RENDERER MUST NOT SHOW CROSSES THE BOUNDARY.
// ---------------------------------------------------------------------------

describe('the payload carries nothing the user should not read', () => {
  it('has no provider key, no credential fingerprint and no path in it', () => {
    // `ProviderBudget.label` is documented as "Host, for logs and the cap
    // message. Never a path, a key or an id", and `ProviderBudget.key` is the
    // bucket identity — `endpoint#credential hash`. Shipping the budget
    // struct itself would put both in the renderer, where the app's rule is
    // that internal diagnostics stay in the logs. So the payload is built
    // field by field, and this asserts the omission rather than trusting it.
    const t0 = new Date(2026, 9, 5, 12, 0, 0).getTime()
    vi.setSystemTime(t0)
    ledgerOf629(t0)
    addModel(OPENROUTER, KEY_A, 'or')

    const rows = readSpend()
    expect(Object.keys(rows[0]).sort()).toEqual([
      'automated',
      'cap',
      'clockSkewed',
      'freeAt',
      'label',
      'manual',
      'used'
    ])

    const serialised = JSON.stringify(rows)
    expect(serialised).not.toContain(bucketOf(OPENROUTER, KEY_A))
    expect(serialised).not.toContain(KEY_A)
    // A base URL path is not a label either: the row says the host.
    expect(rows[0].label).toBe('openrouter.ai')
    expect(rows[0].label).not.toContain('/')
  })

  it('keeps the unclassifiable case a description rather than a raw key', () => {
    // A base URL the app cannot parse buckets per model with a key that
    // embeds a credential hash. Its label must stay the sentence the rest of
    // the app uses, because the alternative is that key on screen.
    const t0 = new Date(2026, 9, 5, 12, 0, 0).getTime()
    vi.setSystemTime(t0)
    addModel('not a url', KEY_A, 'odd')

    const rows = readSpend()
    expect(rows).toHaveLength(1)
    expect(rows[0].label).toBe('<unclassifiable base URL>')
    expect(JSON.stringify(rows)).not.toContain(KEY_A)
  })

  it('carries the clock anomaly through, because the spend cannot be trusted without it', () => {
    // `ProviderBudget.clockSkewed` is why the cap is not enforced at all when
    // a stamp is dated more than a window ahead. A page that showed the
    // count without it would present a number the app itself will not act on.
    const t0 = new Date(2026, 9, 5, 12, 0, 0).getTime()
    vi.setSystemTime(t0)
    addModel(ZEN, KEY_B, 'zen')
    expect(readSpend()[0].clockSkewed).toBe(false)

    recordProviderCall(bucketOf(ZEN, KEY_B), true, t0 + 2 * DAY)
    expect(readSpend()[0]).toMatchObject({ clockSkewed: true, used: 1 })
  })

  it('counts every provider of the pool, disabled ones included', () => {
    // A disabled model cannot spend anything more, but the calls it already
    // made were real and are still inside the window. Hiding its row would
    // hide money the user spent, which is the whole failure mode here — and
    // the cap input is a single global number, so a disabled provider is not
    // an exception the reader has to be told about.
    const t0 = new Date(2026, 9, 5, 12, 0, 0).getTime()
    vi.setSystemTime(t0)
    const key = bucketOf(ZEN, KEY_B)
    for (let i = 0; i < 3; i++) recordProviderCall(key, true, t0 + i * 1000)
    addApiModel({ name: 'off', base_url: ZEN, api_key: KEY_B, model: 'off:free', enabled: false } as never)

    expect(readSpend()).toHaveLength(1)
    expect(readSpend()[0]).toMatchObject({ label: 'opencode.ai', used: 3 })
  })

  it('keeps the model list it reads and the ledger it counts in step', () => {
    // Guards the fixture itself: a store whose models did not land would make
    // every "no row" assertion above pass for the wrong reason.
    const id = addModel(OPENROUTER, KEY_A, 'or')
    expect(listApiModels().map((m) => m.id)).toContain(id)
  })
})

describe('the window is 24 hours', () => {
  it('reports a real zero once the calls age out, and drops the row entirely once nothing is configured', () => {
    const t0 = new Date(2026, 9, 5, 12, 0, 0).getTime()
    vi.setSystemTime(t0)
    ledgerOf629(t0)
    const id = addModel(OPENROUTER, KEY_A, 'or')
    expect(readSpend()[0]).toMatchObject({ used: 629 })

    // A day and an hour on, every stamp has left the window, so the provider
    // is a real provider with a real count of ZERO — which is a different
    // claim from the one the ledger made yesterday, and the page must be able
    // to make it.
    vi.setSystemTime(t0 + 25 * HOUR)
    expect(readSpend()).toHaveLength(1)
    expect(readSpend()[0]).toMatchObject({ used: 0, automated: 0, manual: 0, freeAt: null })

    // With the model gone too, `getProviderSpend` has dropped the bucket
    // (a bucket with nothing left in the window is not a provider with a
    // budget of zero, it is a provider this app has no record of) and there
    // is nothing configured either — so there is no row at all. This is the
    // line between the two, and it is the difference between "measured zero"
    // and "no such provider", which a reader cannot otherwise tell apart.
    deleteApiModel(id)
    expect(readSpend()).toEqual([])
  })
})
