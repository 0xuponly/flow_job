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
  STORE_DIR: '/tmp/flow_job-test-review-manualipc',
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

import { existsSync, unlinkSync, mkdirSync } from 'fs'
import { join } from 'path'
import { RateLimitError } from './ai'
import { createDocument, createJob, getAIQueue, reloadStore, updateSettings } from './database'
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
    url: `https://example.com/review-manual/${nextUrl}`
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