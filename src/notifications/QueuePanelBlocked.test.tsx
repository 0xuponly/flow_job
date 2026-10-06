/**
 * What the Queue panel says when the app cannot reach a provider.
 *
 * Two claims are under test. First, that the panel says it at all: for 20
 * hours on 2026-10-02 a queue of 265 tasks rendered as ordinary backlog
 * while the app could not run a single one of them, and the only trace was
 * a per-row error string. Second, that it says it in the app's own terms —
 * an outcome the user can act on, with no model names, HTTP statuses or
 * cooldown plumbing leaking into the UI. The second claim is the one with
 * teeth: it is asserted negatively, because leaking `cooling down after
 * rate limits` into a user-facing banner is the failure mode.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import QueuePanel from './QueuePanel'
import type { QueueItemView } from '../types'
import type { AIQueueBlockedState } from '../queueBlocked'
import { BLOCKED_ROW_STATUS, blockedBannerLines, queueRowStatusText } from '../queueBlocked'

function item(overrides: Partial<QueueItemView> = {}): QueueItemView {
  return {
    id: 1,
    type: 'verify',
    jobId: 1,
    jobTitle: 'Engineer',
    jobCompany: 'Acme',
    status: 'pending',
    attempts: 0,
    createdAt: 0,
    nextRetryAt: 0,
    ...overrides
  }
}

function blocked(overrides: Partial<AIQueueBlockedState> = {}): AIQueueBlockedState {
  return {
    blocked: true,
    providerFreeAt: Date.now() + 600_000,
    retryAt: Date.now() + 600_000,
    waitingRows: 1,
    blockedRowIds: [1],
    ...overrides
  }
}

function renderPanel(rows: QueueItemView[], state: AIQueueBlockedState | null = null) {
  return render(
    <QueuePanel items={rows} busyId={null} blocked={state} onRetry={vi.fn()} onRemove={vi.fn()} />
  )
}

/**
 * Every word the panel is allowed to show about a block.
 *
 * Deliberately not a snapshot: the point is that the panel is a place
 * where internal diagnostics do not go. The terms below are the ones that
 * were on screen before this feature existed (`cooling down after rate
 * limits or persistent errors`, the per-model error dump), plus the
 * provider and status vocabulary a reader could infer a key or an
 * endpoint from.
 */
const INTERNAL_TERMS = [
  'cool',
  'rate limit',
  '429',
  '402',
  'circuit',
  'openrouter',
  'api/v1',
  'http',
  'retry',
  'backoff'
]

describe('the blocked banner', () => {
  it('says plainly that no provider is available and the queue is waiting', () => {
    const now = 1_700_000_000_000
    // A fixture where the two numbers AGREE, on purpose: this test is
    // about the wording, so its numbers cannot distinguish a banner that
    // counts the held rows from one that counts the queue. The tests below
    // are where the count is pinned.
    const lines = blockedBannerLines(
      blocked({ providerFreeAt: now + 600_000, retryAt: now + 600_000, waitingRows: 265 }),
      265,
      now
    )
    expect(lines).not.toBeNull()
    expect(lines!.headline).toBe('No AI provider is available right now, so the queue is waiting.')
    expect(lines!.detail).toBe('265 queued tasks are waiting. Checking again in 10m (best effort).')
  })

  /**
   * The count is the one the main process measured, over a real window.
   *
   * 2026-10-05, 6h44m, 241 rows in the queue and 36 passes: the banner read
   * "241 queued tasks are waiting" for the whole of it while the sweep log's
   * own waiting count moved 1 → 176. So the fixture below is the shape that
   * actually happened — a long queue, a handful of rows the provider is
   * holding — and the assertion has to reject the queue length, not merely
   * accept the new number. Asserting that "1 queued task is waiting" appears
   * would also pass against a banner that printed both.
   */
  it('counts the rows the provider is holding, not every row in the queue', () => {
    const now = 1_700_000_000_000
    const state = blocked({ retryAt: now + 600_000, waitingRows: 1, blockedRowIds: [7] })
    const lines = blockedBannerLines(state, 241, now)
    expect(lines!.detail).toBe('1 queued task is waiting. Checking again in 10m (best effort).')
    // The queue length is nowhere in the banner: not in the detail, not in
    // the headline, not anywhere a reader could take it for the count.
    expect(`${lines!.headline} ${lines!.detail}`).not.toContain('241')
  })

  it('counts what the sweep measured, not what the queue holds', () => {
    // The other end of the same window. A fixture where the count is large
    // proves the number is read rather than defaulted, and the queue length
    // is still the wrong one to print.
    const now = 1_700_000_000_000
    const lines = blockedBannerLines(
      blocked({ retryAt: now + 600_000, waitingRows: 176 }),
      241,
      now
    )
    expect(lines!.detail).toBe('176 queued tasks are waiting. Checking again in 10m (best effort).')
    expect(lines!.detail).not.toContain('241')
  })

  it('does not answer a count of nothing with a number', () => {
    // Blocked, tasks queued, and none of them parked on the provider clock
    // yet. "0 queued tasks are waiting" is a measurement of nothing and
    // reads as a bug; the sentence below is the answer to the question the
    // banner actually raises.
    const now = 1_700_000_000_000
    const lines = blockedBannerLines(
      blocked({ retryAt: now + 600_000, waitingRows: 0, blockedRowIds: [] }),
      241,
      now
    )
    expect(lines!.detail).toBe('No queued task is waiting for an AI provider right now. Checking again in 10m (best effort).')
    expect(lines!.detail).not.toContain('0 queued tasks')
  })

  it('has no count to print when it cannot trust the one it was given', () => {
    // Not reachable from a real state: `aiQueueBlockedState` counts rows.
    // It is reachable from a caller holding the wrong shape, and a negative
    // or fractional count is the one thing this function must never put on
    // screen — it would be the clearest possible statement that the number
    // was never measured.
    const now = 1_700_000_000_000
    for (const waitingRows of [-1, 1.5, Number.NaN]) {
      const lines = blockedBannerLines(
        blocked({ retryAt: now + 600_000, waitingRows }),
        241,
        now
      )
      expect(lines!.detail, `waitingRows: ${waitingRows}`).toBe(
        'No queued task is waiting for an AI provider right now. Checking again in 10m (best effort).'
      )
    }
  })

  it('counts the queue it was given, and says so when there is nothing queued', () => {
    const now = 1_700_000_000_000
    // 90s reads as 2m: the wait is rounded up, never down, so the time
    // shown is never earlier than the time promised.
    expect(blockedBannerLines(blocked({ retryAt: now + 90_000, waitingRows: 1 }), 1, now)!.detail)
      .toBe('1 queued task is waiting. Checking again in 2m (best effort).')
    expect(blockedBannerLines(blocked({ retryAt: now + 45_000, waitingRows: 0, blockedRowIds: [] }), 0, now)!.detail)
      .toBe('Tasks will run once a provider is available. Checking again in 45s (best effort).')
  })

  /**
   * An empty panel with a state that says rows are parked.
   *
   * The two arrive over separate IPC calls, so they can disagree, and this
   * is the disagreement the panel can resolve on its own: it is showing
   * "No queued tasks." underneath, so a count would be counting rows the
   * user cannot see. The panel's own list wins for this branch.
   *
   * No teeth against the old code — that also branched on the queue length —
   * so this is a guard on the new ordering, not a proof of it.
   */
  it('counts nothing above an empty panel, whatever the state says', () => {
    const now = 1_700_000_000_000
    const lines = blockedBannerLines(
      blocked({ retryAt: now + 600_000, waitingRows: 3, blockedRowIds: [1, 2, 3] }),
      0,
      now
    )
    expect(lines!.detail).toBe('Tasks will run once a provider is available. Checking again in 10m (best effort).')
    expect(lines!.detail).not.toMatch(/\d+ queued task/)
  })

  it('omits the schedule when the wake time is already due', () => {
    // Better no promise than a wrong one: the queue's own wake time can
    // pass between the fetch and the render.
    const now = 1_700_000_000_000
    expect(blockedBannerLines(blocked({ retryAt: now - 1, waitingRows: 3 }), 3, now)!.detail)
      .toBe('3 queued tasks are waiting.')
  })

  it('has nothing to say when the app is not blocked', () => {
    expect(blockedBannerLines(null, 265)).toBeNull()
    expect(blockedBannerLines(blocked({ blocked: false }), 265)).toBeNull()
  })
})

describe('a blocked row reads differently from a queued one', () => {
  it('marks only the rows parked on the provider clock', () => {
    const state = blocked({ blockedRowIds: [2] })
    expect(queueRowStatusText({ id: 2 }, state, () => 'Pending')).toBe(BLOCKED_ROW_STATUS)
    // A row merely queued behind other work keeps its own wording: the
    // distinction is the whole point, so it cannot be blurred by marking
    // everything.
    expect(queueRowStatusText({ id: 1 }, state, () => 'Pending')).toBe('Pending')
  })

  it('marks nothing when the app is not blocked', () => {
    expect(queueRowStatusText({ id: 2 }, null, () => 'Pending')).toBe('Pending')
    expect(queueRowStatusText({ id: 2 }, blocked({ blocked: false }), () => 'Pending')).toBe('Pending')
  })
})

describe('QueuePanel with a blocked app', () => {
  /**
   * The clock is frozen rather than read.
   *
   * The copy functions take `now` and these panel tests pass one, but the
   * panel itself calls `blockedBannerLines` with its own default — so
   * without this, a countdown asserting "10m" would be a claim about how
   * long the test took rather than about the state it was handed.
   */
  const FROZEN_NOW = 1_700_000_000_000
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(FROZEN_NOW)
  })
  afterEach(() => vi.useRealTimers())

  it('renders the notice above the rows, and marks only the parked row', () => {
    const now = Date.now()
    renderPanel(
      [item({ id: 1 }), item({ id: 2 })],
      blocked({ providerFreeAt: now + 600_000, retryAt: now + 600_000, waitingRows: 1, blockedRowIds: [2] })
    )

    const notice = screen.getByTestId('queue-provider-blocked')
    expect(notice).toHaveTextContent('No AI provider is available right now, so the queue is waiting.')
    // One row is waiting on a provider, one is waiting its turn.
    const statuses = screen.getAllByTestId('queue-task-status').map((el) => el.textContent)
    expect(statuses).toEqual(['Pending', BLOCKED_ROW_STATUS])
  })

  /**
   * The panel's own list, at the size it really reaches, with the count the
   * main process measured over it.
   *
   * This is the composition that produced the bug: `items.length` is what
   * the panel has in hand and `waitingRows` is what the sweep found, and
   * the banner used to print the first while claiming the second. Asserting
   * only that "1 queued task is waiting" is on screen would pass against a
   * banner that also printed 241, so the queue length is asserted absent.
   */
  it('counts the held rows over a long queue, and prints no queue length', () => {
    const now = Date.now()
    renderPanel(
      Array.from({ length: 241 }, (_, i) => item({ id: i + 1 })),
      blocked({ providerFreeAt: now + 600_000, retryAt: now + 600_000, waitingRows: 1, blockedRowIds: [7] })
    )

    const notice = screen.getByTestId('queue-provider-blocked')
    expect(notice).toHaveTextContent('1 queued task is waiting.')
    expect(notice.textContent, 'the queue length is not a measurement of anything').not.toContain('241')
    // The rows are still there underneath — the count replaced a number, not
    // the list.
    expect(screen.getAllByTestId('queue-task').length).toBeGreaterThan(1)
  })

  it('counts exactly the rows it marks as waiting', () => {
    const now = Date.now()
    renderPanel(
      [item({ id: 1 }), item({ id: 2 }), item({ id: 3 })],
      blocked({ providerFreeAt: now + 600_000, retryAt: now + 600_000, waitingRows: 2, blockedRowIds: [1, 2] })
    )

    const statuses = screen.getAllByTestId('queue-task-status').map((el) => el.textContent)
    expect(statuses).toEqual([BLOCKED_ROW_STATUS, BLOCKED_ROW_STATUS, 'Pending'])
    expect(screen.getByTestId('queue-provider-blocked')).toHaveTextContent('2 queued tasks are waiting.')
  })

  it('keeps the block\'s own plumbing out of the panel', () => {
    const now = Date.now()
    renderPanel(
      // A row parked by a block carries the provider plumbing in its
      // stored `lastError` — that string is the row's record of why, and
      // the log has the detail. It is not shown: `lastError` is rendered
      // for failed rows only, so a row that is merely WAITING does not
      // display it.
      [
        item({ id: 1, status: 'pending', attempts: 0, nextRetryAt: now + 600_000, lastError: 'All configured AI models are cooling down after rate limits or persistent errors — try again shortly.' })
      ],
      blocked({ providerFreeAt: now + 600_000, retryAt: now + 600_000, blockedRowIds: [1] })
    )

    // Nothing on screen is the raw error, and nothing is plumbing of any
    // other kind either.
    expect(screen.getByTestId('queue-task')).not.toHaveTextContent(/cooling down/i)
    const notice = screen.getByTestId('queue-provider-blocked')
    for (const term of INTERNAL_TERMS) {
      expect(notice.textContent?.toLowerCase(), `banner must not say "${term}"`).not.toContain(term)
    }
    expect(screen.getByTestId('queue-task-status')).toHaveTextContent(BLOCKED_ROW_STATUS)
  })

  it('still says so when nothing is queued', () => {
    // The state is about the provider, not about the queue, and the user
    // about to press Generate is exactly who needs to hear it.
    const now = Date.now()
    renderPanel([], blocked({ providerFreeAt: now + 600_000, retryAt: now + 600_000, waitingRows: 0, blockedRowIds: [] }))

    expect(screen.getByTestId('queue-provider-blocked')).toHaveTextContent('No AI provider is available right now')
    expect(screen.getByText('No queued tasks.')).toBeInTheDocument()
  })

  it('renders nothing extra when the app is not blocked', () => {
    renderPanel([item({ id: 1 })], null)
    expect(screen.queryByTestId('queue-provider-blocked')).toBeNull()
    expect(screen.getByTestId('queue-task-status')).toHaveTextContent('Pending')
  })
})