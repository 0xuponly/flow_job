/**
 * Which job a durable notification record cites.
 *
 * The notification center is the row a user comes back to, so a record
 * that names the wrong job is worse than no record: it looks authoritative
 * and is not. These are the paths where the job attribution can go wrong,
 * and all of them are invisible to a test that only ever opens one job.
 *
 * The one that actually bites is ordinary navigation. `JobsPage` swaps
 * `selectedJob` without remounting `JobDetail` (sibling prev/next, and
 * `handleNavigateSibling`), so the component's `useEffect([job.id])` is
 * what re-runs the sweep — and the `load` that effect calls closes over
 * the render that PRODUCED it, whose `currentJob` is still the job the
 * user just left. Reading the job back from the store after the sweep, and
 * citing that, is what makes the row truthful.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, act, waitFor } from '@testing-library/react'
import JobDetail from './JobDetail'
import type { Job } from '../types'

function noop(): void {}

function job(over: Partial<Job>): Job {
  return {
    id: 1,
    title: 'Alpha Engineer',
    company: 'AlphaCo',
    location: 'Berlin',
    status: 'applied',
    description: 'React and TypeScript.',
    created_at: new Date().toISOString(),
    url: 'https://example.com/job/1',
    ...over
  } as Job
}

const ALPHA = job({ id: 1 })
const BETA = job({ id: 2, title: 'Beta Designer', company: 'BetaCo', location: null })

function doc(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 71,
    job_id: 1,
    type: 'cv',
    title: 'CV',
    content: 'CV',
    verification_score: null,
    created_at: new Date().toISOString(),
    ...over
  }
}

function installApi(overrides: Record<string, unknown>): void {
  ;(window as unknown as { api: unknown }).api = {
    getOrCreateApplication: vi.fn(async () => ({ id: 1, job_id: 1 })),
    listDocuments: vi.fn(async () => []),
    getJob: vi.fn(async () => ALPHA),
    updateApplication: vi.fn(async () => ({ id: 1 })),
    updateJob: vi.fn(async () => ALPHA),
    verifyDocument: vi.fn(async () => ({ kind: 'review', score: 90, passed: true, feedback: 'ok' })),
    tailorDocument: vi.fn(async () => ({ queued: true })),
    extractJobKeywords: vi.fn(async () => ({ keywords: [], refinedByLlm: false, unknownPhrases: [] })),
    refineJobKeywords: vi.fn(async () => ({ keywords: [], refinedByLlm: false, unknownPhrases: [] })),
    listBlacklistedCompanies: vi.fn(async () => []),
    notificationsAdd: vi.fn(async () => ({ id: 1 })),
    notificationsList: vi.fn(async () => ({ rows: [] })),
    ...overrides
  }
}

/** The job citation on every record written so far. */
function citations(): unknown[] {
  const api = (window as unknown as { api: { notificationsAdd: { mock: { calls: unknown[][] } } } }).api
  return api.notificationsAdd.mock.calls.map((c) => (c[0] as { job?: unknown }).job)
}

function addCalls(): Record<string, unknown>[] {
  const api = (window as unknown as { api: { notificationsAdd: { mock: { calls: unknown[][] } } } }).api
  return api.notificationsAdd.mock.calls.map((c) => c[0] as Record<string, unknown>)
}

function renderDetail(current: Job) {
  return render(
    <JobDetail
      job={current}
      onBack={noop}
      onUpdate={noop}
      onDelete={noop}
      filteredJobIds={[1, 2]}
      onNavigateSibling={noop}
    />
  )
}

beforeAll(() => {
  ;(globalThis as unknown as { ResizeObserver: typeof ResizeObserver }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
})

beforeEach(() => cleanup())
afterEach(() => cleanup())

describe('a record cites the job it was raised for', () => {
  it('cites the open job on a plain mount', async () => {
    installApi({
      listDocuments: vi.fn(async () => [doc()]),
      verifyDocument: vi.fn(async () => { throw new Error('review call failed: socket hang up') })
    })
    renderDetail(ALPHA)
    await waitFor(() => expect(citations()).toHaveLength(1))

    expect(citations()[0]).toEqual({
      job_id: 1,
      job_title: 'Alpha Engineer',
      job_company: 'AlphaCo',
      job_location: 'Berlin'
    })
  })

  it('still cites it after the job was edited, using the store not the old render', async () => {
    // The row should describe the job as it is NOW, which is also what a
    // user comparing the notification to the job board will check against.
    const renamed = job({ id: 1, title: 'Staff Engineer', company: 'AlphaCo', location: 'Berlin' })
    installApi({
      listDocuments: vi.fn(async () => [doc()]),
      getJob: vi.fn(async () => renamed),
      verifyDocument: vi.fn(async () => { throw new Error('review call failed: socket hang up') })
    })
    renderDetail(ALPHA)
    await waitFor(() => expect(citations()).toHaveLength(1))

    expect(citations()[0]).toMatchObject({ job_id: 1, job_title: 'Staff Engineer' })
  })

  it('follows a sibling navigation instead of citing the job left behind', async () => {
    // The regression: `load` is invoked BY the effect that reacts to the new
    // `job.id`, so its closure is the previous render's — whose `currentJob`
    // is still ALPHA. The payload names BETA's document (`CV #71`,
    // `job_id: 2`); a citation saying Alpha would be a fabricated field on a
    // row whose whole purpose is to be trusted later.
    const { rerender } = renderDetail(ALPHA)
    await waitFor(() => expect((window.api as { getJob: unknown }).getJob).toBeDefined())

    installApi({
      listDocuments: vi.fn(async (jobId: number) => [doc({ job_id: jobId, id: jobId === 2 ? 72 : 71 })]),
      getJob: vi.fn(async (id: number) => (id === 2 ? BETA : ALPHA)),
      verifyDocument: vi.fn(async () => { throw new Error('review call failed: socket hang up') })
    })
    rerender(
      <JobDetail
        job={BETA}
        onBack={noop}
        onUpdate={noop}
        onDelete={noop}
        filteredJobIds={[1, 2]}
        onNavigateSibling={noop}
      />
    )

    await waitFor(() => expect(citations()).toHaveLength(1))
    expect(citations()[0]).toEqual({
      job_id: 2,
      job_title: 'Beta Designer',
      job_company: 'BetaCo',
      // BETA has no location, so the citation has none either. No
      // placeholder, and nothing carried over from Alpha.
      job_location: null
    })
    expect(addCalls()[0].full_message).toContain('CV #72')
  })

  it('a refresh after navigating sweeps the NEW job, not the one it mounted on', async () => {
    const listDocuments = vi.fn(async () => [] as unknown[])
    installApi({ listDocuments })
    const { rerender } = renderDetail(ALPHA)
    // Let the mount sweep finish before swapping the API out from under it.
    // `api` resolves `window.api` per call, so a swap mid-flight would have
    // the mount's own awaits run against the next test's mocks and show up
    // as a stray call for the wrong job.
    await waitFor(() => expect(listDocuments).toHaveBeenCalledWith(1))
    await act(async () => { await new Promise((r) => setTimeout(r, 30)) })

    const verifyDocument = vi.fn(
      async (_jobId: number, _docId: number, _type: string) =>
        ({ kind: 'review' as const, score: 90, passed: true, feedback: 'ok' })
    )
    installApi({
      listDocuments: vi.fn(async (jobId: number) => [doc({ job_id: jobId, id: jobId === 2 ? 72 : 71 })]),
      getJob: vi.fn(async (id: number) => (id === 2 ? BETA : ALPHA)),
      verifyDocument
    })
    rerender(
      <JobDetail
        job={BETA}
        onBack={noop}
        onUpdate={noop}
        onDelete={noop}
        filteredJobIds={[1, 2]}
        onNavigateSibling={noop}
      />
    )
    await waitFor(() => expect(verifyDocument).toHaveBeenCalledTimes(1))

    // The Sidebar refresh button. The listener is registered once with an
    // empty dep array, so it can only be right about the second job if it
    // reads the CURRENT load rather than the one captured at mount.
    await act(async () => {
      window.dispatchEvent(new CustomEvent('app:refresh'))
      await new Promise((r) => setTimeout(r, 60))
    })

    expect(verifyDocument).toHaveBeenCalledTimes(2)
    for (const call of verifyDocument.mock.calls) {
      expect(call[0]).toBe(2)
    }
  })

  it('falls back to the swept id when the job was deleted mid-sweep', async () => {
    // `getJob` returning nothing must not cost the row its citation: the id
    // the sweep actually ran under is still the truth, and the title and
    // company are simply not available.
    installApi({
      listDocuments: vi.fn(async () => [doc()]),
      getJob: vi.fn(async () => undefined),
      verifyDocument: vi.fn(async () => { throw new Error('review call failed: socket hang up') })
    })
    renderDetail(ALPHA)
    await waitFor(() => expect(citations()).toHaveLength(1))

    expect(citations()[0]).toEqual({
      job_id: 1,
      job_title: 'Alpha Engineer',
      job_company: 'AlphaCo',
      job_location: 'Berlin'
    })
  })

  it('cites nothing at all for a failure with no job to cite', async () => {
    // The sweep always has a job; this is the general shape, and a record
    // with four nulls is not what `jobContext` produces.
    installApi({
      listDocuments: vi.fn(async () => [doc()]),
      verifyDocument: vi.fn(async () => { throw new Error('review call failed: socket hang up') })
    })
    renderDetail(ALPHA)
    await waitFor(() => expect(addCalls()).toHaveLength(1))
    for (const record of addCalls()) {
      expect(record.job).not.toMatchObject({ job_title: 'Remote' })
    }
    expect(screen.queryByRole('button', { name: /Reviewing/i })).not.toBeInTheDocument()
  })
})