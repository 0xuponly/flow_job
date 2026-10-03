import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, act, cleanup } from '@testing-library/react'
import React from 'react'
import Notifications, { notify } from '../src/components/Notifications'
import JobDetail from '../src/pages/JobDetail'

/**
 * Is the "10+ toasts" one toast with a 10-line body, or ten toasts?
 *
 * The user pinned the timing: the toasts "appear ALL AT ONCE on the job
 * detail page", and the count tracks the size of the model pool. That
 * fits `ai.ts`'s aggregate error — `tryModels` walks the whole rotation
 * and throws ONE error whose message embeds every model's failure,
 * newline-joined at ai.ts:725 and `' | '`-joined at ai.ts:739.
 *
 * This file measures that against the real rotation rather than a
 * hand-written string, and then feeds the real thrown message through
 * the real toast funnel. Nothing in `electron/ai.ts` is modified: the
 * aggregate message is what it is, and the question here is only how
 * many toast objects it produces.
 */

vi.mock('./database', () => ({
  getSettings: vi.fn(() => ({})),
  listApiModels: vi.fn(() => []),
  getDocument: vi.fn(),
  updateDocument: vi.fn(),
  updateDocumentVerification: vi.fn(),
  listApplications: vi.fn(() => []),
  updateApplication: vi.fn(),
  createDocument: vi.fn(),
  replaceDocumentContent: vi.fn(),
  getJob: vi.fn()
}))

import * as database from './database'
import { callAI, resetModelHealth } from './ai'
import type { ApiModelConfig } from './types'

const POOL_SIZE = 12

function modelConfig(i: number): ApiModelConfig {
  return {
    id: `m${i}`,
    name: `Model ${i}`,
    enabled: true,
    base_url: `https://provider-${i}.invalid`,
    model: `model-${i}`,
    api_key: 'k'
  }
}

/** A toast host, and a count of the toast objects it is actually showing. */
function visibleToasts(): string[] {
  return Array.from(document.body.querySelectorAll('div[style*="pre-line"]')).map(
    (el) => (el.textContent ?? '').replace(/[⧉✓]$/, '')
  )
}

function renderHost(): void {
  render(React.createElement(Notifications))
}

beforeEach(() => {
  resetModelHealth()
  vi.stubGlobal('fetch', vi.fn())
  cleanup()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  resetModelHealth()
  cleanup()
})

describe('the aggregate rotation error is ONE message', () => {
  it('a fully rate-limited 12-model pool throws one error naming every model', async () => {
    vi.mocked(database.listApiModels).mockReturnValue(Array.from({ length: POOL_SIZE }, (_, i) => modelConfig(i)))
    vi.stubGlobal('fetch', vi.fn(async () => new Response('rate limited', { status: 429 })))

    const err = await callAI('sys', 'write me a CV').then(() => null, (e: unknown) => e)

    expect(err).toBeInstanceOf(Error)
    const message = (err as Error).message
    // One message. The header, then one line per model in the rotation.
    const lines = message.split('\n')
    expect(lines).toHaveLength(POOL_SIZE + 1)
    expect(lines[0]).toContain(`All ${POOL_SIZE} configured AI models are rate limited`)
    for (let i = 0; i < POOL_SIZE; i++) {
      expect(message).toContain(`Model ${i}: rate limited (429)`)
    }
  })

  it('a fully failing 12-model pool throws one error whose detail is one joined line', async () => {
    vi.mocked(database.listApiModels).mockReturnValue(Array.from({ length: POOL_SIZE }, (_, i) => modelConfig(i)))
    vi.stubGlobal('fetch', vi.fn(async () => new Response('upstream exploded', { status: 500 })))

    const err = await callAI('sys', 'write me a CV').then(() => null, (e: unknown) => e)

    expect(err).toBeInstanceOf(Error)
    const lines = (err as Error).message.split('\n')
    // ai.ts:739 joins with ' | ', so even the "all failed" branch is a
    // single line — no newline-joined block on this path.
    expect(lines).toHaveLength(1)
    for (let i = 0; i < POOL_SIZE; i++) {
      expect((err as Error).message).toContain(`Model ${i}: HTTP 500`)
    }
  })
})

describe('and it renders as ONE toast, not twelve', () => {
  it('the real 12-model rate-limit message is a single toast object', async () => {
    vi.mocked(database.listApiModels).mockReturnValue(Array.from({ length: POOL_SIZE }, (_, i) => modelConfig(i)))
    vi.stubGlobal('fetch', vi.fn(async () => new Response('rate limited', { status: 429 })))

    const err = await callAI('sys', 'write me a CV').then(() => null, (e: unknown) => e)
    const message = (err as Error).message
    expect(message.split('\n')).toHaveLength(POOL_SIZE + 1)

    renderHost()
    act(() => { notify(`Generation failed: ${message}`, 'error') })

    // ONE element. The per-model detail is inside it as line breaks
    // (`white-space: pre-line`), which is what makes it read as a wall
    // of separate errors on the page.
    expect(visibleToasts()).toHaveLength(1)
    const [body] = visibleToasts()
    expect(body.startsWith('Generation failed: All 12 configured AI models are rate limited')).toBe(true)
    for (let i = 0; i < POOL_SIZE; i++) {
      expect(body).toContain(`Model ${i}: rate limited (429)`)
    }
  })

  it('a body of N lines is N lines in one toast, never N toasts', () => {
    const manyLines = Array.from({ length: 12 }, (_, i) => `Model ${i}: rate limited (429)`).join('\n')
    renderHost()
    act(() => { notify(`Generation failed: All 12 configured AI models are rate limited — try again in a minute:\n${manyLines}`, 'error') })

    expect(visibleToasts()).toHaveLength(1)
    // The lines are preserved verbatim inside that one toast.
    expect(visibleToasts()[0].split('\n')).toHaveLength(13)
  })
})

/**
 * End to end: the button, the real rotation, the real toast. The bridge's
 * `tailorDocument` is the only seam — it calls the real `callAI`, so the
 * error the renderer catches is the one `tryModels` actually threw, at
 * whatever size the pool is.
 */
describe('one click against a 12-model pool is one short toast', () => {
  const job = {
    id: 1,
    title: 'Engineer',
    company: 'Acme',
    location: 'Remote',
    status: 'applied',
    description: 'React and TypeScript, node, some SQL.',
    created_at: new Date().toISOString(),
    url: 'https://example.com/rotation/1'
  }

  beforeEach(() => {
    ;(globalThis as unknown as { ResizeObserver: typeof ResizeObserver }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver

    vi.mocked(database.listApiModels).mockReturnValue(Array.from({ length: POOL_SIZE }, (_, i) => modelConfig(i)))
    ;(window as unknown as { api: unknown }).api = {
      // The seam: a real AI call, so the failure text is the real one.
      tailorDocument: () => callAI('sys', 'write me a CV'),
      getOrCreateApplication: vi.fn(async () => ({ id: 1, job_id: 1 })),
      listDocuments: vi.fn(async () => []),
      getJob: vi.fn(async () => job),
      updateApplication: vi.fn(async () => ({ id: 1 })),
      updateJob: vi.fn(async () => job),
      verifyDocument: vi.fn(async () => ({ kind: 'review', score: 90, passed: true, feedback: 'good' })),
      extractJobKeywords: vi.fn(async () => ({ keywords: [], refinedByLlm: false, unknownPhrases: [] })),
      refineJobKeywords: vi.fn(async () => ({ keywords: [], refinedByLlm: false, unknownPhrases: [] })),
      listBlacklistedCompanies: vi.fn(async () => [])
    }
  })

  function renderJobDetail(): void {
    render(
      React.createElement(
        React.Fragment,
        null,
        React.createElement(Notifications),
        React.createElement(JobDetail, {
          job: job as never,
          onBack: () => {},
          onUpdate: () => {},
          onDelete: () => {},
          filteredJobIds: [1],
          onNavigateSibling: () => {}
        })
      )
    )
  }

  it('reports the whole rotation as one line, having walked all 12 models', async () => {
    const fetchMock = vi.fn(async () => new Response('rate limited', { status: 429 }))
    vi.stubGlobal('fetch', fetchMock)
    renderJobDetail()

    const { screen } = await import('@testing-library/react')
    const button = screen.getByRole('button', { name: /Tailor CV/i })
    await act(async () => {
      button.click()
      await new Promise((r) => setTimeout(r, 60))
    })

    // Every model in the pool was really tried...
    expect(fetchMock).toHaveBeenCalledTimes(POOL_SIZE)

    // ...and the user got ONE toast, one line, no model names.
    expect(visibleToasts()).toHaveLength(1)
    expect(visibleToasts()[0]).toBe('Generation failed: 12 errors: 12 rate limited.')
  })
})