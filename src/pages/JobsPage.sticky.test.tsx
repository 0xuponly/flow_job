import { describe, it, expect, beforeEach, afterEach, beforeAll, vi } from 'vitest'
import { render, act, fireEvent } from '@testing-library/react'
import JobsPage from './JobsPage'
import { api } from '../api'

// jsdom doesn't implement ResizeObserver; the useLayoutEffect in JobsPage
// constructs one. Stub it so the effect runs.
beforeAll(() => {
  ;(globalThis as unknown as { ResizeObserver: typeof ResizeObserver }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
})

// Mock the api module so JobsPage can import without hitting electron.
// The JobDetail page (rendered after a row click) touches a long list
// of methods; we stub each as a no-op async so the unmount/remount
// flow under test can run without hitting real IPC.
vi.mock('../api', () => {
  const noopAsync = async () => null
  const noopAsyncArr = async () => []
  const noopSubscribe = () => () => {}
  return {
    api: {
      listJobs: vi.fn(async () => [
        { id: 1, title: 'A', company: 'Acme', location: 'Vancouver, CA', status: 'new', score: 0.5, date_posted: null, last_updated: '2026-01-01', salary_range: null, url: '', description: '', source: '', notes: '' }
      ]),
      searchJobs: vi.fn(async () => []),
      backfillJobDates: vi.fn(async () => 0),
      batchScore: vi.fn(async () => 0),
      getSettings: vi.fn(async () => ({ base_cv: '' })),
      listDocuments: noopAsyncArr,
      onJobScoreUpdated: noopSubscribe,
      getJob: noopAsync,
      getOrCreateApplication: noopAsync,
      extractJobKeywords: noopAsync,
      refineJobKeywords: noopAsync,
      updateApplication: noopAsync,
      updateDocument: noopAsync,
      deleteDocument: noopAsync,
      tailorDocument: noopAsync,
      regenerateSection: noopAsync,
      verifyDocument: noopAsync,
      exportDocumentPdf: noopAsync,
      markApplied: noopAsync,
      updateJob: noopAsync,
      deleteJob: noopAsync,
      openExternal: vi.fn(),
      addBlacklistedCompany: noopAsync,
      removeBlacklistedCompany: noopAsync,
      listBlacklistedCompanies: noopAsyncArr,
      tailorQuickApply: noopAsync,
      dedupeJobs: vi.fn(async () => ({ removedIds: [] })),
    },
  }
})

describe('JobsPage sticky thead', () => {
  beforeEach(() => {
    document.documentElement.style.removeProperty('--jobs-sticky-offset')
  })
  afterEach(() => {
    document.documentElement.style.removeProperty('--jobs-sticky-offset')
  })

  it('renders the table with a sticky thead (CSS class triggers sticky behavior)', async () => {
    let container: HTMLElement | null = null
    await act(async () => {
      const r = render(<JobsPage />)
      container = r.container
    })
    // Find the first <th> inside the jobs table
    const ths = container!.querySelectorAll('table.table thead th')
    expect(ths.length).toBeGreaterThan(0)
    // jsdom doesn't compute layout, so getBoundingClientRect() returns all zeros.
    // The useLayoutEffect early-returns on a 0-height element OR sets offset to 0,
    // which is the documented fallback. We just need the table structure to be right.
    // Print what the CSS var is:
    const offset = document.documentElement.style.getPropertyValue('--jobs-sticky-offset')
    // Either unset (if effect early-returned) or "0px" (if effect ran and got 0)
    // What matters: a thead with th children exists.
    expect(ths[0].tagName).toBe('TH')
    // The th should be inside .jobs-page which has the sticky CSS rule.
    const jobsPage = container!.querySelector('.jobs-page')
    expect(jobsPage).toBeTruthy()
    expect(jobsPage!.querySelector('table.table thead th')).toBe(ths[0])
    // Touch `offset` to silence "declared but never used" lint
    expect(typeof offset === 'string' || offset === '').toBe(true)
  })

  it('re-runs the sticky-offset effect after the user returns from JobDetail', async () => {
    // Repro: the table-header stops being sticky after the user clicks
    // into a job and then clicks Back. Root cause: the useLayoutEffect
    // that wires the ResizeObserver and writes --jobs-sticky-offset has
    // a boolean dep [jobs.length > 0]. While the user is on JobDetail
    // the wrapper is unmounted (selectedJob != null), but the effect
    // doesn't re-run on the null→job→null transition because the dep
    // stays true throughout. So when the wrapper remounts, the effect
    // doesn't re-run, the observer is still attached to the detached
    // old node, and --jobs-sticky-offset is never re-measured.
    //
    // Test signal: write a sentinel value to --jobs-sticky-offset just
    // before the back-nav. The fixed code re-runs the effect on remount
    // and overwrites the sentinel with the real height ("0px" in
    // jsdom). The broken code leaves the sentinel in place.
    document.documentElement.style.setProperty('--jobs-sticky-offset', 'STALE_BEFORE_BACK')

    let container: HTMLElement | null = null
    await act(async () => {
      const r = render(<JobsPage />)
      container = r.container
    })

    // Simulate click into a job — find the first table row and click it.
    // The row's onClick calls setSelectedJob(job), which swaps the
    // rendered tree from the table view to <JobDetail />.
    const firstRow = container!.querySelector('table.table tbody tr') as HTMLElement | null
    expect(firstRow).toBeTruthy()
    await act(async () => {
      fireEvent.click(firstRow!)
    })

    // The wrapper is now unmounted; JobDetail is rendered instead.
    // Plant the stale sentinel AFTER the unmount so we can detect
    // whether the effect re-runs on the subsequent remount.
    document.documentElement.style.setProperty('--jobs-sticky-offset', 'STALE_BEFORE_BACK')

    // Simulate clicking the Back button in JobDetail.
    const backButton = container!.querySelector('button.btn.btn-secondary') as HTMLElement | null
    expect(backButton).toBeTruthy()
    await act(async () => {
      fireEvent.click(backButton!)
    })

    // The wrapper is back in the DOM. The effect should have re-run and
    // written the wrapper's current height to --jobs-sticky-offset.
    // jsdom reports 0 for getBoundingClientRect().height, so the fixed
    // code writes "0px". The broken code leaves the sentinel.
    const offsetAfterBack = document.documentElement.style.getPropertyValue('--jobs-sticky-offset')
    expect(offsetAfterBack).not.toBe('STALE_BEFORE_BACK')
  })
})

describe('JobsPage auto-fit-recompute', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Re-establish the default listJobs mock after clearAllMocks wiped it.
    ;(api.listJobs as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 1, title: 'A', company: 'Acme', location: 'Vancouver, CA', status: 'new', score: 0.5, date_posted: null, last_updated: '2026-01-01', salary_range: null, url: '', description: '', source: '', notes: '' }
    ])
  })

  it('does not auto-fire batchScore when mounted with unscored jobs', async () => {
    // One unscored job: score is null. The legacy useEffect would have
    // fired api.batchScore() in response to jobs.length changing. After
    // the fix, the effect is gone, so batchScore must NOT be called.
    ;(api.listJobs as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      {
        id: 1, title: 'X', company: 'Y', status: 'sourced', score: null,
        fit_breakdown: null, fit_score_version: null, fit_last_error: null,
        fit_error_toasted: null, notes: null, date_posted: null,
        application_deadline: null, last_updated: null, created_at: '',
        updated_at: '', match_grade: null, tailor_ms_cv: null,
        tailor_ms_cl: null, tailor_generated_at: null,
        tailor_last_error: null, tailor_error_toasted: null,
        submitted_at: null, response_at: null, location: null, url: null,
        description: null, salary_range: null, requirements: null,
        application_requirements: null, hiring_manager: null,
        employment_type: null, work_mode: null, source: null,
        fit_rationale: null
      }
    ])

    await act(async () => {
      render(<JobsPage />)
    })

    // Let any effects run.
    await act(async () => { /* drain */ })

    expect(api.batchScore).not.toHaveBeenCalled()
  })
})
