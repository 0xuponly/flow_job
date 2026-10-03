import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import QueuePanel from './QueuePanel'
import type { QueueItemView } from '../types'

/**
 * The Queue panel's escape hatch for a row the app will not start on its
 * own.
 *
 * A crash leaves its row `processing` with nothing running, and the
 * startup reclaim deliberately refuses to resume an automatic row while
 * its Auto-queue switch is off — correctly, because that is unattended
 * spend the user bought out of. Rendered as `Processing…` with no button,
 * though, the row is a dead end: the app is telling the user it is
 * running, it is not, and nothing they can do in the panel changes that.
 *
 * These are the panel-level rules for that state. The main-process half
 * — which rows are stranded at all, and that Retry on one is ungated and
 * actually requeues it — is in electron/strandedRowRetry.test.ts.
 */

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

/** A row as the backend sends it: a crash left it `processing`. */
function stranded(overrides: Partial<QueueItemView> = {}): QueueItemView {
  return item({ status: 'processing', stranded: true, ...overrides })
}

/** A row the processor is working on right now. */
function inFlight(overrides: Partial<QueueItemView> = {}): QueueItemView {
  return item({ status: 'processing', stranded: false, ...overrides })
}

function renderPanel(rows: QueueItemView[], onRetry = vi.fn()) {
  const utils = render(
    <QueuePanel items={rows} busyId={null} onRetry={onRetry} onRemove={vi.fn()} />
  )
  return { ...utils, onRetry }
}

/** The Retry button in the first row, if the row has one. */
function retryButton(): HTMLButtonElement | null {
  const row = screen.getByTestId('queue-task')
  return row.querySelector('button.btn-primary')
}

describe('Retry on a row the app left stranded', () => {
  it('offers Retry on a `processing` row the main process calls stranded', () => {
    // The dead end. `stranded` is the main process saying the row says
    // `processing` but no run in this session owns it.
    renderPanel([stranded()])
    expect(retryButton()).not.toBeNull()
    expect(retryButton()!.textContent).toBe('Retry')
  })

  it('does NOT offer Retry on a row that is legitimately running', () => {
    // The control, and the reason the button cannot simply be
    // "status is processing". Retrying a live run would put the same
    // generation in the queue a second time while the first is still
    // being paid for.
    renderPanel([inFlight()])
    expect(retryButton()).toBeNull()
  })

  it('still offers Retry on a failed row', () => {
    // The behaviour that was already there, unchanged. A row with no
    // `stranded` field is a row the main process never flagged.
    renderPanel([item({ status: 'failed', attempts: 5 })])
    expect(retryButton()).not.toBeNull()
  })

  it('offers nothing on a row waiting its turn', () => {
    renderPanel([item({ status: 'pending' })])
    expect(retryButton()).toBeNull()
  })

  it('decides per row, not per queue', () => {
    // A queue with a mix — one crash leftover, one live run, one failure,
    // one waiting — has to get exactly one button.
    renderPanel([
      stranded({ id: 1 }),
      inFlight({ id: 2 }),
      item({ id: 3, status: 'failed' }),
      item({ id: 4, status: 'pending' })
    ])
    const rows = screen.getAllByTestId('queue-task')
    const hasRetry = rows.map((r) => r.querySelector('button.btn-primary') !== null)
    expect(hasRetry).toEqual([true, false, true, false])
  })

  it('hands the row to the caller, which is what calls retryAIQueueItem', () => {
    // The button is only worth anything if the click reaches the retry
    // path, and the panel's whole job is to hand the row over: the
    // handler behind it is what requeues the row, ungated.
    const row = stranded({ id: 7 })
    const { onRetry } = renderPanel([row], vi.fn())

    fireEvent.click(retryButton()!)

    expect(onRetry).toHaveBeenCalledTimes(1)
    expect(onRetry).toHaveBeenCalledWith(expect.objectContaining({ id: 7, status: 'processing' }))
  })

  it('suppresses the button while that row has a request in flight', () => {
    // Same as every other row action: a double click would queue the
    // work twice.
    render(
      <QueuePanel items={[stranded()]} busyId={1} onRetry={vi.fn()} onRemove={vi.fn()} />
    )
    expect(retryButton()).toBeDisabled()
  })
})
