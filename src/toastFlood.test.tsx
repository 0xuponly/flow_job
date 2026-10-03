import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, act, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import Notifications, { notify } from './components/Notifications'
import { useMainErrorToasts } from './useMainErrorToasts'
import { toastErrorSummary } from './aiErrorSummary'
import JobDetail from './pages/JobDetail'
import type { Job } from './types'

/**
 * The user report: "when I try to generate a doc manually, 10+ failure
 * toast notifications popup … only one should appear."
 *
 * Every assertion here drives the real handler — JobDetail's own click
 * handler, the real `notify` funnel, the real toast host, the real
 * `useMainErrorToasts` subscription — so the counts are the ones the
 * user saw rather than a count of calls to a stand-in.
 *
 * What the flood actually was, measured (see the report):
 *
 *   `JobDetail.load()` re-verifies every document that has no
 *   verification score, and reports each failure with its own
 *   `Content review failed: …` toast (JobDetail.tsx:280). One generate
 *   click runs that sweep — on mount, again after the generation, and
 *   again on every sidebar refresh — and each sweep says the same
 *   sentence once per document. Nothing anywhere compared two toasts, so
 *   ten identical toasts accumulated from one failed generation.
 *
 *   Measured on this file's scenario (a CV and a cover letter, neither
 *   reviewed, the review hard-failing), before the fix:
 *
 *       mount                                     2 toasts (4 in StrictMode)
 *       mount + one failed Generate click        3 toasts (5 in StrictMode)
 *       + three sidebar refreshes                9 toasts (11 in StrictMode)
 *
 *   `<StrictMode>` is not a curiosity here: `src/main.tsx` renders the
 *   app inside it, and `npm run dev` is how a bug report like this
 *   arrives. It double-invokes the mount effect, which is why the dev
 *   build showed twice as many.
 *
 * The queue was never part of this. `electron/toastFlood.main.test.ts`
 * drives the real processor and pins that it is silent.
 */

/**
 * The toast host renders each message in the one element in the renderer
 * with `white-space: pre-line`, which makes this a count of visible
 * toasts rather than a count of emitter calls.
 */
function noop(): void {}

function visibleToasts(): string[] {
  return Array.from(document.body.querySelectorAll('div[style*="pre-line"]')).map(
    (el) => (el.textContent ?? '').replace(/[⧉✓]$/, '')
  )
}

const job: Job = {
  id: 1,
  title: 'Engineer',
  company: 'Acme',
  location: 'Remote',
  status: 'applied',
  description: 'We need a React engineer with TypeScript experience and node skills.',
  created_at: new Date().toISOString(),
  url: 'https://example.com/toastflood/1'
} as Job

function doc(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 9,
    job_id: 1,
    type: 'cv',
    title: 'CV',
    content: 'CV',
    verification_score: null,
    created_at: new Date().toISOString(),
    ...over
  }
}

/** A CV and a cover letter, neither reviewed — the state that floods. */
const TWO_UNREVIEWED = [doc(), doc({ id: 10, type: 'cover_letter', title: 'CL', content: 'CL' })]

function installApi(overrides: Record<string, unknown>): void {
  ;(window as unknown as { api: unknown }).api = {
    getOrCreateApplication: vi.fn(async () => ({ id: 1, job_id: 1, cv_document_id: 9, cover_letter_document_id: 10 })),
    listDocuments: vi.fn(async () => []),
    getJob: vi.fn(async () => job),
    updateApplication: vi.fn(async () => ({ id: 1 })),
    updateJob: vi.fn(async () => job),
    verifyDocument: vi.fn(async () => ({ kind: 'review', score: 90, passed: true, feedback: 'good' })),
    tailorDocument: vi.fn(async () => ({ document_id: 9, content: 'CV' })),
    extractJobKeywords: vi.fn(async () => ({ keywords: [], refinedByLlm: false, unknownPhrases: [] })),
    refineJobKeywords: vi.fn(async () => ({ keywords: [], refinedByLlm: false, unknownPhrases: [] })),
    listBlacklistedCompanies: vi.fn(async () => []),
    ...overrides
  }
}

function renderDetail(strict = false) {
  const tree = (
    <>
      <Notifications />
      <JobDetail
        job={job}
        onBack={noop}
        onUpdate={noop}
        onDelete={noop}
        filteredJobIds={[1]}
        onNavigateSibling={noop}
      />
    </>
  )
  return render(strict ? <StrictMode>{tree}</StrictMode> : tree)
}

/** The button whose label depends on whether the document already exists. */
function generateButton(): HTMLElement {
  return screen.getByRole('button', { name: /(Tailor|Regenerate) CV/i })
}

async function refresh(): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new CustomEvent('app:refresh'))
    await new Promise((r) => setTimeout(r, 60))
  })
}

beforeAll(() => {
  // jsdom has no ResizeObserver; JobDetail's description card builds one.
  ;(globalThis as unknown as { ResizeObserver: typeof ResizeObserver }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
})

beforeEach(() => cleanup())
afterEach(() => cleanup())

describe('one manual generate, one toast', () => {
  it('a generate that hard-fails says so exactly once', async () => {
    // No documents on the job yet, so the page's document sweep has
    // nothing to say and the only toast can be the click's own outcome.
    installApi({
      tailorDocument: vi.fn(async () => { throw new Error('All 3 configured AI models failed') })
    })
    renderDetail()
    await waitFor(() => expect((window.api as { getJob: unknown }).getJob).toBeDefined())

    fireEvent.click(generateButton())
    await waitFor(() => expect(visibleToasts()).toHaveLength(1))

    expect(visibleToasts()[0]).toBe('Generation failed: All 3 configured AI models failed.')
  })

  it('a generate that is rate-limited says "queued" exactly once', async () => {
    installApi({ tailorDocument: vi.fn(async () => ({ queued: true })) })
    renderDetail()
    await waitFor(() => expect((window.api as { getJob: unknown }).getJob).toBeDefined())

    fireEvent.click(generateButton())
    await waitFor(() => expect(visibleToasts()).toHaveLength(1))

    expect(visibleToasts()[0]).toMatch(/^AI is rate-limited — generation added to queue/)
  })

  it('a generate that succeeds is silent, which is the established pattern', async () => {
    // Generation has never announced itself on success — the document
    // appearing on the page is the feedback. Pinned so that stays a
    // decision rather than drifting into an accident.
    installApi({
      tailorDocument: vi.fn(async () => ({ document_id: 9, content: 'CV' })),
      listDocuments: vi.fn(async () => [doc({ verification_score: 88 })])
    })
    renderDetail()
    await waitFor(() => expect((window.api as { getJob: unknown }).getJob).toBeDefined())

    fireEvent.click(generateButton())
    await act(async () => { await new Promise((r) => setTimeout(r, 120)) })

    expect(visibleToasts()).toEqual([])
  })
})

describe('the document sweep does not turn one failure into a stack of them', () => {
  it('two unreviewed documents failing identically produce one toast, not two', async () => {
    installApi({
      tailorDocument: vi.fn(async () => ({ queued: true })),
      listDocuments: vi.fn(async () => TWO_UNREVIEWED),
      verifyDocument: vi.fn(async () => { throw new Error('review call failed: socket hang up') })
    })
    renderDetail()
    await waitFor(() => expect(visibleToasts().length).toBeGreaterThan(0))

    expect(visibleToasts()).toEqual(['Content review failed: review call failed: socket hang up.'])
  })

  it('re-running the sweep (mount, refresh) does not repeat the failure', async () => {
    installApi({
      tailorDocument: vi.fn(async () => ({ queued: true })),
      listDocuments: vi.fn(async () => TWO_UNREVIEWED),
      verifyDocument: vi.fn(async () => { throw new Error('review call failed: socket hang up') })
    })
    // StrictMode, because that is `npm run dev`: it invokes the mount
    // effect twice, which is half of the original flood.
    renderDetail(true)
    await waitFor(() => expect(visibleToasts().length).toBeGreaterThan(0))
    expect(visibleToasts()).toHaveLength(1)

    fireEvent.click(generateButton())
    await act(async () => { await new Promise((r) => setTimeout(r, 120)) })
    await refresh()
    await refresh()
    await refresh()

    // The sweep said its piece once. The click's own outcome is a
    // different sentence and is still there.
    expect(visibleToasts()).toEqual([
      'Content review failed: review call failed: socket hang up.',
      'AI is rate-limited — generation added to queue. Will retry automatically.'
    ])
  })

  it('two DIFFERENT failures are both reported', async () => {
    installApi({
      tailorDocument: vi.fn(async () => { throw new Error('All 3 configured AI models failed') }),
      listDocuments: vi.fn(async () => TWO_UNREVIEWED),
      verifyDocument: vi.fn(async () => { throw new Error('review call failed: socket hang up') })
    })
    renderDetail()
    await waitFor(() => expect(visibleToasts().length).toBeGreaterThan(0))

    fireEvent.click(generateButton())
    await waitFor(() => expect(visibleToasts()).toHaveLength(2))

    expect(visibleToasts().sort()).toEqual([
      'Content review failed: review call failed: socket hang up.',
      'Generation failed: All 3 configured AI models failed.'
    ])
  })
})

/**
 * The other half of the report. `ai.ts`'s rotation throws ONE error whose
 * message embeds every model's failure, newline-joined — with a 12-model
 * pool that is a 13-line block, rendered by the toast host as one tall
 * toast of line breaks. It is one toast object, but on the job detail
 * page it reads as a wall of separate errors, which is very likely where
 * the user's "10+" came from.
 *
 * So the toast says what happened and where to look; the per-model detail
 * stays where it already lives — `logs/ai.log`, and the queue row's
 * `lastError` for anything the queue picks up.
 */
describe('a whole failed rotation is summarised, not dumped', () => {
  function rotationDump(models: { name: string; reason: string }[]): string {
    return [
      `All ${models.length} configured AI models are rate limited — try again in a minute:`,
      ...models.map((m) => `${m.name}: ${m.reason}`)
    ].join('\n')
  }

  const TWELVE_RATE_LIMITED = rotationDump(
    Array.from({ length: 12 }, (_, i) => ({ name: `Model ${i}`, reason: 'rate limited (429)' }))
  )

  it('a 13-line rotation error reaches the user as one short toast', async () => {
    installApi({
      tailorDocument: vi.fn(async () => { throw new Error(TWELVE_RATE_LIMITED) })
    })
    renderDetail()
    await waitFor(() => expect((window.api as { getJob: unknown }).getJob).toBeDefined())

    fireEvent.click(generateButton())
    await waitFor(() => expect(visibleToasts()).toHaveLength(1))

    const [toast] = visibleToasts()
    expect(toast).toBe('Generation failed: 12 errors: 12 rate limited.')
    // One line, naming the cause and how many models it hit. No model
    // names, no per-model reasons.
    expect(toast.split('\n')).toHaveLength(1)
    expect(toast).not.toContain('Model 0')
  })

  it("ai.ts's ' | '-joined branch is counted per model, not per line", () => {
    // The all-failed branch joins the whole rotation onto ONE physical
    // line. Counted per line it would summarise to "1 errors", which is
    // exactly the number the user is trying to get away from.
    const joined = [
      'All 12 configured AI models failed — errors:',
      ...Array.from({ length: 12 }, (_, i) => `Model ${i}: ${i < 3 ? 'rate limited (429)' : i === 3 ? 'payment required (402)' : 'unauthorized (401)'}`)
    ].join(' | ')

    render(<Notifications />)
    act(() => { notify(`Generation failed: ${toastErrorSummary(joined)}`, 'error') })

    expect(visibleToasts()).toHaveLength(1)
    expect(visibleToasts()[0]).toBe('Generation failed: 12 errors: 3 rate limited, 1 out of credits, 8 auth-failed.')
  })

  it('still reports the failure when there is nothing to summarise', async () => {
    // Not an AI rotation dump: the summary falls back to the first line
    // rather than swallowing the message.
    installApi({
      tailorDocument: vi.fn(async () => { throw new Error('No enabled AI models configured.') })
    })
    renderDetail()
    await waitFor(() => expect((window.api as { getJob: unknown }).getJob).toBeDefined())

    fireEvent.click(generateButton())
    await waitFor(() => expect(visibleToasts()).toHaveLength(1))
    expect(visibleToasts()[0]).toBe('Generation failed: No enabled AI models configured.')
  })
})

describe('listeners are not registered twice', () => {
  it('mounting, unmounting and remounting JobDetail leaves one app:refresh subscription', async () => {
    installApi({ tailorDocument: vi.fn(async () => ({ queued: true })), listDocuments: vi.fn(async () => []) })

    const listeners = new Set<EventListenerOrEventListenerObject>()
    const realAdd = window.addEventListener.bind(window)
    const realRemove = window.removeEventListener.bind(window)
    const spy = vi.spyOn(window, 'addEventListener').mockImplementation((type, handler, opts) => {
      listeners.add(handler)
      return realAdd(type, handler, opts)
    })
    vi.spyOn(window, 'removeEventListener').mockImplementation((type, handler, opts) => {
      listeners.delete(handler)
      return realRemove(type, handler, opts)
    })

    try {
      for (let i = 0; i < 4; i++) {
        const { unmount } = renderDetail()
        await act(async () => { await new Promise((r) => setTimeout(r, 30)) })
        unmount()
      }

      // Every `app:refresh` listener JobDetail registered is gone again.
      // A missing cleanup — or an effect whose deps churn on every
      // `load()` — would leave one behind per mount, and each one runs
      // the document sweep, so the sweep's toasts would multiply by the
      // number of times the user opened the page.
      const refreshHandlers = listeners.size
      expect(refreshHandlers).toBe(0)
    } finally {
      spy.mockRestore()
      vi.restoreAllMocks()
    }
  })

  it('one mounted JobDetail runs the sweep once per refresh, not once per registration', async () => {
    const verifyDocument = vi.fn(async () => { throw new Error('review call failed: socket hang up') })
    installApi({
      tailorDocument: vi.fn(async () => ({ queued: true })),
      listDocuments: vi.fn(async () => [doc()]),
      verifyDocument
    })
    renderDetail()
    await waitFor(() => expect(verifyDocument).toHaveBeenCalledTimes(1))

    await refresh()
    expect(verifyDocument).toHaveBeenCalledTimes(2)

    await refresh()
    expect(verifyDocument).toHaveBeenCalledTimes(3)
  })
})

describe('the toast funnel itself', () => {
  it('the same sentence twice in a row is one toast', () => {
    render(<Notifications />)
    act(() => { notify('Could not update the queue', 'error') })
    act(() => { notify('Could not update the queue', 'error') })
    expect(visibleToasts()).toEqual(['Could not update the queue'])
  })

  it('different sentences are never collapsed', () => {
    render(<Notifications />)
    act(() => { notify('Cleared 3 queued tasks.', 'info') })
    act(() => { notify('Could not update the queue', 'error') })
    expect(visibleToasts()).toEqual(['Cleared 3 queued tasks.', 'Could not update the queue'])
  })

  it('the same sentence is reported again once the first has gone', () => {
    vi.useFakeTimers()
    try {
      render(<Notifications />)
      act(() => { notify('Cleared 3 queued tasks.', 'info') })
      act(() => { notify('Cleared 3 queued tasks.', 'info') })
      expect(visibleToasts()).toHaveLength(1)
      // 4000ms TTL + the 250ms fade.
      act(() => { vi.advanceTimersByTime(4400) })
      expect(visibleToasts()).toHaveLength(0)

      // A fresh failure after the user watched the first one expire is
      // new information, not a duplicate.
      act(() => { notify('Cleared 3 queued tasks.', 'info') })
      expect(visibleToasts()).toEqual(['Cleared 3 queued tasks.'])
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('main:errorToast (uncaughtException)', () => {
  // The preload bridge's callback, captured so a test can play the part
  // of the main process pushing a crash down `main:errorToast`.
  let deliver: (message: string) => void = noop

  function Harness() {
    useMainErrorToasts()
    return null
  }

  beforeEach(() => {
    ;(window as unknown as { api: unknown }).api = {
      onMainError: (cb: (message: string) => void) => {
        deliver = cb
        return () => { deliver = noop }
      }
    }
  })

  it('a genuine crash reaches the user once', () => {
    render(<><Harness /><Notifications /></>)
    act(() => { deliver('Internal error: provider socket exploded') })
    expect(visibleToasts()).toEqual(['Internal error: provider socket exploded'])
  })

  it('the same crash reported over and over is one toast', () => {
    render(<><Harness /><Notifications /></>)
    for (let i = 0; i < 10; i++) act(() => { deliver('Internal error: provider socket exploded') })
    expect(visibleToasts()).toEqual(['Internal error: provider socket exploded'])
  })

  it('still reports the same crash after the dedupe window has passed', () => {
    vi.useFakeTimers()
    try {
      render(<><Harness /><Notifications /></>)
      act(() => { deliver('Internal error: provider socket exploded') })
      // Long past both the toast TTL and the crash window: the first
      // copy is gone, so a recurrence is news.
      act(() => { vi.advanceTimersByTime(60_000) })
      act(() => { deliver('Internal error: provider socket exploded') })
      expect(visibleToasts()).toEqual(['Internal error: provider socket exploded'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('two DIFFERENT crashes are both reported', () => {
    render(<><Harness /><Notifications /></>)
    act(() => { deliver('Internal error: provider socket exploded') })
    act(() => { deliver('Internal error: Cannot read properties of null') })
    expect(visibleToasts()).toHaveLength(2)
  })
})