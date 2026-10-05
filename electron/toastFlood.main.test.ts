import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'

/**
 * Main-process half of the toast-flood fix.
 *
 * The user report was "generate a doc manually, 10+ failure toast
 * notifications popup". Everything on this side is measured against the
 * real `uncaughtException` handler registered by `electron/main.ts` and
 * the real queue processor, not against a stand-in for either.
 *
 * What this file establishes, and what it does not:
 *
 *   - `aiQueue` is SILENT. A row that fails, is revived, and fails again
 *     emits nothing on any channel; its `lastError` is the record and the
 *     Queue panel renders it. This is asserted directly against
 *     `processQueue` below, because "the automated retries don't toast"
 *     is a property worth pinning rather than assuming.
 *   - A rejected `ipcMain.handle` promise is NOT an `uncaughtException`.
 *     Electron writes "Error occurred in handler for …" to stderr (which
 *     is what `stderrFilter.ts` exists to swallow) and rejects the
 *     renderer's promise, which the renderer already catches and reports
 *     once. Asserted below so the flood is not attributed here again.
 *   - The one amplifier on this side was the broadcast: one exception
 *     used to cost one toast per open window. It now costs one toast, in
 *     the window that can act on it.
 *   - That window can still be one that CANNOT act on it: quick-add mounts
 *     neither the toast host nor `useMainErrorToasts`, and it is focused
 *     by design. So the crash is written to the notification store from the
 *     main process, where no window routing applies, and the last block
 *     below pins that.
 */

const { STORE_DIR, handlers, windows } = vi.hoisted(() => ({
  STORE_DIR: `/tmp/flow_job-test-toastflood-main-${process.env.FLOW_JOB_TEST_RUN_ID ?? `pid${process.pid}`}`,
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  windows: [] as {
    name: string
    focused: boolean
    sent: [string, unknown][]
    isDestroyed: () => boolean
    isFocused: () => boolean
    webContents: {
      isDestroyed: () => boolean
      send: (channel: string, message: unknown) => void
    }
  }[]
}))

/** A stand-in BrowserWindow that records what it was sent. */
function mkWindow(name: string, opts: { focused?: boolean; destroyed?: boolean; webContentsDestroyed?: boolean } = {}) {
  const w = {
    name,
    focused: opts.focused ?? false,
    sent: [] as [string, unknown][],
    isDestroyed: () => opts.destroyed ?? false,
    isFocused: () => opts.focused ?? false,
    webContents: {
      isDestroyed: () => opts.webContentsDestroyed ?? false,
      send: (channel: string, message: unknown) => {
        if (opts.webContentsDestroyed) throw new Error('Object has been destroyed')
        w.sent.push([channel, message])
      }
    }
  }
  return w
}

/**
 * What `tailorDocument` throws, and how many times it has been called.
 * Mutable so each test can put the provider in a different state.
 */
const provider = vi.hoisted(() => ({
  makeError: (() => new Error('All 3 configured AI models failed — HTTP 429')) as () => Error,
  calls: 0
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
    isDestroyed() { return false }
    isFocused() { return false }
    static getAllWindows() { return windows }
    static getFocusedWindow() { return windows.find((w) => w.focused && !w.isDestroyed()) ?? null }
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

// Only the provider call is faked. `withAiOperation` and `RateLimitError`
// stay real so the handler's `instanceof` branch is the genuine one.
vi.mock('./ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./ai')>()
  return {
    ...actual,
    tailorDocument: vi.fn(async () => {
      provider.calls++
      throw provider.makeError()
    }),
    verifyDocumentContent: vi.fn(async () => { throw provider.makeError() }),
    regenerateSection: vi.fn(async () => { throw provider.makeError() })
  }
})

import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { createJob, getAIQueue, reloadStore, updateAIQueueItem } from './database'
import { addNotification, listActiveNotifications } from './notifications'
import { RateLimitError } from './ai'
import type { CreateJobInput } from './types'

const storeFile = join(STORE_DIR, 'apply-assistant-data.json')
const keyFile = join(STORE_DIR, 'apply-assistant-key')

/**
 * The handler `main.ts` registers on `process`, captured at import time.
 * Invoked directly rather than through `process.emit`: the point is to
 * drive main.ts's own listener, and going through `process.emit` would
 * also run vitest's own reporting for a deliberately thrown error.
 */
const uncaughtHandlers: ((err: Error) => void)[] = []

function raise(err: Error): void {
  for (const h of uncaughtHandlers) h(err)
}

/** Every `main:errorToast` a window received. */
function toastsFor(name: string): string[] {
  const win = windows.find((w) => w.name === name)
  return (win?.sent ?? []).filter(([c]) => c === 'main:errorToast').map(([, m]) => String(m))
}

function totalToasts(): number {
  return windows.reduce((n, w) => n + w.sent.filter(([c]) => c === 'main:errorToast').length, 0)
}

/** Every window that was told the notification store changed, by name. */
function storeChangePings(): string[] {
  return windows
    .filter((w) => w.sent.some(([c]) => c === 'notifications:changed'))
    .map((w) => w.name)
}

/**
 * Replace the store with one `loadStore` cannot read.
 *
 * The real failure, not a stubbed one: `loadStore` throws `Cannot decrypt
 * data file` on a payload carrying the modern `enc:v1:` envelope it cannot
 * open, and refuses to fall back to a fresh store so it does not silently
 * wipe the user's data. That refusal is what makes the read fail at all,
 * so stubbing `listActiveNotifications` instead would have tested the
 * handler's shape and not its reachability.
 *
 * `reloadStore()` is deliberately inside a catch: it drops the in-memory
 * copy and immediately re-reads, which throws by design. The point is that
 * the cache is EMPTY afterwards, so every later `loadStore` goes back to
 * the file and throws too — which is the condition the code under test has
 * to survive.
 */
function makeStoreUnreadable(): void {
  writeFileSync(storeFile, 'enc:v1:not-a-real-envelope')
  try {
    reloadStore()
  } catch {
    // Expected. See above.
  }
}

/** Put a working store back and drop the in-memory copy. */
function makeStoreReadable(): void {
  if (existsSync(storeFile)) unlinkSync(storeFile)
  reloadStore()
}

function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const fn = handlers.get(channel)
  if (!fn) throw new Error(`no handler registered for ${channel}`)
  return Promise.resolve(fn({}, ...args)) as Promise<unknown>
}

let nextUrl = 0
function addJob(): number {
  nextUrl++
  const input: CreateJobInput = {
    title: `Engineer ${nextUrl}`,
    company: 'Acme',
    location: 'Remote',
    url: `https://example.com/toastflood/${nextUrl}`
  }
  return createJob(input).job.id
}

/** Make every queued row due again, the way a spent backoff would. */
function makeRowsDue(): void {
  for (const row of getAIQueue()) updateAIQueueItem(row.id, { nextRetryAt: 0 })
}

beforeAll(async () => {
  const origOn = process.on.bind(process)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  process.on = ((event: string, fn: any) => {
    if (event === 'uncaughtException') uncaughtHandlers.push(fn)
    return origOn(event, fn)
  }) as typeof process.on
  await import('./main')
  process.on = origOn
  // registerIpc() runs off app.whenReady() at import time.
  await new Promise((r) => setTimeout(r, 0))
  expect(uncaughtHandlers.length).toBeGreaterThan(0)
})

beforeEach(() => {
  if (!existsSync(STORE_DIR)) mkdirSync(STORE_DIR, { recursive: true })
  for (const f of [storeFile, keyFile]) if (existsSync(f)) unlinkSync(f)
  reloadStore()
  windows.length = 0
  windows.push(mkWindow('main', { focused: true }), mkWindow('quickadd'))
  provider.calls = 0
  provider.makeError = () => new Error('All 3 configured AI models failed — HTTP 429')
})

describe('the automated retry path emits no toast', () => {
  it('a rate-limited generate that is queued, then fails 12 times over, toasts nothing', async () => {
    const jobId = addJob()
    provider.makeError = () => new RateLimitError('429: all models cooling down')

    // The click itself: the handler enqueues and answers { queued: true }.
    // This is the ONE user-initiated outcome, and it is reported by the
    // renderer's own toast, not from here.
    expect(await invoke('ai:tailor', { job_id: jobId, document_type: 'cv' })).toEqual({ queued: true })
    expect(getAIQueue().filter((r) => r.type === 'generate_cv')).toHaveLength(1)

    // Everything after that is the app working on its own.
    const { processQueue } = await import('./aiQueue')
    for (let i = 0; i < 12; i++) {
      makeRowsDue()
      await processQueue()
    }

    expect(provider.calls).toBeGreaterThanOrEqual(12)
    expect(totalToasts()).toBe(0)
  })

  it('keeps the full detail on the row even though it toasts nothing', async () => {
    const jobId = addJob()
    provider.makeError = () => new RateLimitError('429: all models cooling down')
    await invoke('ai:tailor', { job_id: jobId, document_type: 'cv' })
    const { processQueue } = await import('./aiQueue')
    makeRowsDue()
    await processQueue()

    const row = getAIQueue().find((r) => r.type === 'generate_cv')!
    // Not silenced — recorded, revivable, and renderable in the Queue panel.
    expect(row.lastError).toBe('429: all models cooling down')
    expect(row.status).not.toBe('processing')
    expect(totalToasts()).toBe(0)
  })

  it('a revived row that fails again still toasts nothing', async () => {
    const jobId = addJob()
    provider.makeError = () => new RateLimitError('429')
    await invoke('ai:tailor', { job_id: jobId, document_type: 'cv' })
    const { processQueue } = await import('./aiQueue')
    // Burn the attempt budget so the row reaches `failed` and the
    // revival lane has to pick it up.
    for (let i = 0; i < 12; i++) {
      makeRowsDue()
      await processQueue()
    }
    const revived = getAIQueue().find((r) => r.type === 'generate_cv')!
    expect(revived.autoRevives ?? 0).toBeGreaterThan(0)

    makeRowsDue()
    await processQueue()
    expect(totalToasts()).toBe(0)
  })
})

describe('a rejected IPC handler is not a crash', () => {
  it('a hard generation failure rejects the handler without reaching uncaughtException', async () => {
    const jobId = addJob()
    provider.makeError = () => new Error('All 3 configured AI models failed — HTTP 429')
    await expect(invoke('ai:tailor', { job_id: jobId, document_type: 'cv' })).rejects.toThrow(/HTTP 429/)
    // Nothing was raised at the process level, so there is nothing here
    // to toast — the renderer's catch already reported it, once.
    expect(totalToasts()).toBe(0)
  })
})

describe('the crash toast reaches one window, not all of them', () => {
  it('a genuine single crash still reaches the focused window', () => {
    raise(new Error('provider socket exploded'))
    expect(toastsFor('main')).toEqual(['Internal error: provider socket exploded'])
    expect(toastsFor('quickadd')).toEqual([])
  })

  it('a crash while the quick-add window is in front does not also toast the main window', () => {
    windows[0].focused = false
    windows[1].focused = true
    raise(new Error('quick-add import failed'))

    expect(toastsFor('quickadd')).toEqual(['Internal error: quick-add import failed'])
    expect(toastsFor('main')).toEqual([])
    expect(totalToasts()).toBe(1)
  })

  it('one crash with four windows open is one toast, not four', () => {
    windows.length = 0
    windows.push(mkWindow('main', { focused: true }), mkWindow('quickadd'), mkWindow('pdf'), mkWindow('devtools'))
    raise(new Error('boom'))
    expect(totalToasts()).toBe(1)
  })

  it('a destroyed window is skipped rather than taking the toast down with it', () => {
    windows.length = 0
    windows.push(mkWindow('dead', { focused: true, destroyed: true }), mkWindow('main'))
    raise(new Error('boom'))
    // Nothing focused, so the first LIVE window is the fallback — not the
    // destroyed one, which used to throw out of the handler itself.
    expect(toastsFor('main')).toEqual(['Internal error: boom'])
    expect(totalToasts()).toBe(1)
  })

  it('a window whose renderer is gone does not turn one crash into a second one', () => {
    windows.length = 0
    windows.push(mkWindow('crashed-renderer', { focused: true, webContentsDestroyed: true }))
    expect(() => raise(new Error('boom'))).not.toThrow()
    expect(totalToasts()).toBe(0)
  })
})

/**
 * A crash is the one notification that must not depend on the window
 * routing above, because the routing has a hole: with quick-add in front
 * — its normal state while the user is doing the thing that crashed — the
 * toast goes to a renderer that mounts neither the toast host nor
 * `useMainErrorToasts`, and drops it. So `main.ts` writes the crash to the
 * store itself, which is shared by every window, and the drawer re-reads it
 * when it is next opened.
 */
describe('the crash is recorded in the store, whichever window it went to', () => {
  it('a crash routed to a window that cannot render a toast is still recorded', () => {
    windows[0].focused = false
    windows[1].focused = true

    raise(new TypeError('better-sqlite3 has no exported member'))

    expect(toastsFor('main')).toEqual([])
    const rows = listActiveNotifications().rows
    expect(rows).toHaveLength(1)
    expect(rows[0].message).toBe('Internal error: better-sqlite3 has no exported member')
    expect(rows[0].type).toBe('error')
  })

  it('the record carries the stack, which the toast could never hold', () => {
    raise(new TypeError('cannot read properties of null'))
    const [row] = listActiveNotifications().rows
    expect(row.full_message).toContain('TypeError: cannot read properties of null')
    expect(row.full_message.length).toBeGreaterThan(row.message.length)
  })

  it('recurring crashes of one kind group into a single row rather than many', () => {
    // An exception thrown from a timer recurs for as long as the condition
    // holds; the key is per error TYPE, so the recurring case is one row.
    raise(new TypeError('a'))
    raise(new TypeError('b'))
    raise(new RangeError('c'))

    const rows = listActiveNotifications().rows
    expect(rows).toHaveLength(3)
    expect(new Set(rows.map((r) => r.group_key)).size).toBe(2)
  })

  it('a crash is recorded once, not once per window', () => {
    windows.length = 0
    windows.push(mkWindow('main', { focused: true }), mkWindow('quickadd'), mkWindow('pdf'))
    raise(new Error('boom'))
    expect(totalToasts()).toBe(1)
    expect(listActiveNotifications().rows).toHaveLength(1)
  })
})

/**
 * MAJOR 3, the visible half. Recording the crash was the previous fix and it
 * was necessary but not sufficient: a record in a file that nothing tells
 * the app about is not a notification. The user only found it by opening the
 * center and looking, and the badge — the one thing on screen that says
 * "there is something you have not seen" — stayed dark.
 *
 * So the answer is BOTH surfaces, because each covers the other's blind
 * spot:
 *
 *   a toast, where a window that can render one has focus, which is the
 *     existing `main:errorToast` path; and
 *   the centre on next open, plus the badge lighting now, via
 *     `notifications:changed` — sent to EVERY window, because unlike the
 *     toast this carries no claim for anyone to act on and it lights a dot
 *     in each window's own sidebar.
 */
describe('a recorded crash announces itself to the windows that can show it', () => {
  it('tells every live window the store changed, focused or not', () => {
    windows[0].focused = false
    windows[1].focused = true

    raise(new Error('provider socket exploded'))

    // quickadd is the window that CANNOT render a toast, so the main window
    // is the only place this is visible — and it is told, precisely because
    // it was not the focused one.
    expect(toastsFor('main')).toEqual([])
    expect(storeChangePings().sort()).toEqual(['main', 'quickadd'])
  })

  it('a crash routed to a window that cannot render a toast still reaches the main window', () => {
    // The combination that was actually invisible: the record is written,
    // the toast is dropped by the renderer that was chosen, and nothing
    // else happens. This is the case the reviewer called a record the user
    // never sees.
    windows[0].focused = false
    windows[1].focused = true

    raise(new TypeError('better-sqlite3 has no exported member'))

    expect(toastsFor('quickadd')).toEqual(['Internal error: better-sqlite3 has no exported member'])
    expect(toastsFor('main')).toEqual([])
    expect(storeChangePings()).toContain('main')
    expect(listActiveNotifications().rows).toHaveLength(1)
  })

  it('does not ping a window whose renderer is gone, and does not turn one crash into a second', () => {
    windows.length = 0
    windows.push(mkWindow('dead', { destroyed: true }), mkWindow('gone', { webContentsDestroyed: true }), mkWindow('main'))
    expect(() => raise(new Error('boom'))).not.toThrow()
    // Only the one window that can actually receive it.
    expect(storeChangePings()).toEqual(['main'])
    expect(listActiveNotifications().rows).toHaveLength(1)
  })

  it('pings once per crash, not once per window', () => {
    windows.length = 0
    windows.push(mkWindow('main', { focused: true }), mkWindow('quickadd'), mkWindow('pdf'))
    raise(new Error('boom'))
    for (const w of windows) {
      expect(w.sent.filter(([c]) => c === 'notifications:changed')).toHaveLength(1)
    }
  })

  it('an unreadable store neither records nor pings, and does not throw out of the handler', () => {
    // Nothing was written, so announcing it would light a badge that finds
    // an empty list — a claim of "there is something" with nothing behind
    // it. The crash is in crash.log either way, and the handler must come
    // back clean: it is running from inside `uncaughtException`, where a
    // second throw replaces the crash the user is being told about.
    makeStoreUnreadable()
    try {
      expect(() => raise(new Error('boom'))).not.toThrow()
      expect(storeChangePings()).toEqual([])
    } finally {
      makeStoreReadable()
    }
  })
})

/**
 * A failed read must not be reported as an empty centre. `loadStore` throws
 * on a store it cannot decrypt, so this handler's catch is reachable, and
 * the answer it used to give — `{ rows: [] }` — is indistinguishable from
 * "there is nothing in here". That is what let a crash record sit in the
 * file, in plain sight, with the drawer reporting nothing to see.
 */
describe('the list channel reports a read it could not do', () => {
  it('answers with an error envelope rather than an empty list', async () => {
    makeStoreUnreadable()
    try {
      expect(await invoke('notifications:notificationsList')).toEqual({ error: 'INTERNAL' })
    } finally {
      makeStoreReadable()
    }
  })

  it('still answers with rows when the read works', async () => {
    addNotification({ type: 'error', source: 'app', message: 'Internal error: boom', full_message: 'boom' })
    const result = await invoke('notifications:notificationsList') as { rows?: unknown[]; unreadable?: number }
    expect(Array.isArray(result.rows)).toBe(true)
    expect((result.rows ?? []).length).toBeGreaterThan(0)
    // A clean store reports zero, so the drawer has a number to compare
    // against rather than an absence it has to interpret.
    expect(result.unreadable).toBe(0)
  })

  /**
   * MINOR 6, end to end through the real handler. The store migration
   * discards entries of `notifications` that are not rows — it has to, this
   * is `loadStore` and a string in that array would take jobs and documents
   * down with it — and the count is what stops the discard from reading as
   * "there is nothing here".
   */
  it('carries the count of entries it could not read', async () => {
    writeFileSync(storeFile, JSON.stringify({
      jobs: [], documents: [], applications: [], api_models: [],
      nextId: 900, seen_urls: [], ai_queue: [], board_health: {},
      board_scan_times: {}, provider_spend: {}, deleted_jobs: [],
      blacklisted_companies: [], settings: {},
      notifications: ['not-an-object']
    }))
    reloadStore()

    const result = await invoke('notifications:notificationsList') as { rows?: unknown[]; unreadable?: number }
    expect(result.rows).toEqual([])
    // Without this number the renderer sees an empty list and reports an
    // empty notification center over a store that was not empty.
    expect(result.unreadable).toBe(1)
  })
})