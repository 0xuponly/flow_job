import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import QueuePanel from './QueuePanel'
import type { QueueItemView } from '../types'

/**
 * A row as the backend now sends it: the enriched view, with both
 * display fields present. Building these through `QueueItemView` is
 * deliberate — the panel accepts only the view, so a fixture that
 * quietly dropped `jobTitle` would not compile.
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

function items(n: number): QueueItemView[] {
  return Array.from({ length: n }, (_, i) => item({ id: i + 1, jobId: i + 1 }))
}

function renderPanel(rows: QueueItemView[]) {
  return render(
    <QueuePanel
      items={rows}
      busyId={null}
      onRetry={vi.fn()}
      onRemove={vi.fn()}
    />
  )
}

function pageToEnd(): void {
  // "Show N more" disappears once everything is on screen, so clicking
  // until it does is how the user pages out.
  for (let i = 0; i < 10; i++) {
    const btn = screen.queryByRole('button', { name: /show \d+ more/i })
    if (!btn) break
    fireEvent.click(btn)
  }
}

/**
 * The panel mounts PAGE_SIZE rows and pages on demand. Its window was
 * reset only when the queue SHRANK, which left it keyed to the wrong
 * thing: a 10s poll can hand the panel a list that is a completely
 * different shape from the one it last rendered, and a length
 * comparison can only ever see the net change.
 */
describe('QueuePanel window', () => {
  it('starts with one page mounted', () => {
    renderPanel(items(150))
    expect(screen.getAllByTestId('queue-task')).toHaveLength(60)
  })

  it('pages in more on request', () => {
    renderPanel(items(150))
    pageToEnd()
    expect(screen.getAllByTestId('queue-task')).toHaveLength(150)
  })

  it('keeps the window the user paged to when a poll returns the same count', () => {
    // A poll that changes nothing must not throw away the user's
    // position, or paging would be impossible in a queue that is not
    // moving.
    const { rerender } = renderPanel(items(150))
    pageToEnd()
    rerender(
      <QueuePanel items={items(150)} busyId={null} onRetry={vi.fn()} onRemove={vi.fn()} />
    )
    expect(screen.getAllByTestId('queue-task')).toHaveLength(150)
  })

  it('resets the window when the queue grows', () => {
    // The case the shrink-only comparison missed. The window no longer
    // describes this list, and the count the effect compares against is
    // whatever the last render saw -- an intermediate clear and re-seed
    // between two polls is not observable here at all.
    const { rerender } = renderPanel(items(150))
    pageToEnd()
    rerender(
      <QueuePanel items={items(151)} busyId={null} onRetry={vi.fn()} onRemove={vi.fn()} />
    )
    expect(screen.getAllByTestId('queue-task')).toHaveLength(60)
  })

  it('resets the window when the queue shrinks', () => {
    const { rerender } = renderPanel(items(150))
    pageToEnd()
    rerender(
      <QueuePanel items={items(3)} busyId={null} onRetry={vi.fn()} onRemove={vi.fn()} />
    )
    expect(screen.getAllByTestId('queue-task')).toHaveLength(3)
  })

  it('lets a short queue be paged again after it grows back', () => {
    // 3 -> 150: the count changed, so the window is back to one page and
    // the paging control is reachable again.
    const { rerender } = renderPanel(items(3))
    expect(screen.queryByRole('button', { name: /show \d+ more/i })).toBeNull()
    rerender(
      <QueuePanel items={items(150)} busyId={null} onRetry={vi.fn()} onRemove={vi.fn()} />
    )
    expect(screen.getAllByTestId('queue-task')).toHaveLength(60)
    fireEvent.click(screen.getByRole('button', { name: /show \d+ more/i }))
    expect(screen.getAllByTestId('queue-task')).toHaveLength(120)
  })
})

function clickShowFewer(): void {
  fireEvent.click(screen.getByRole('button', { name: /show fewer/i }))
}

/**
 * Paging was one-way. A user who opened a 150-row queue and paged to the
 * end was left with 150 mounted rows, one Retry/Remove pair per row, and
 * no control that could get them back: the reset effect only fires on a
 * change in queue length, and a queue that is not moving is exactly the
 * case where the user wants to collapse it. Recovering needed a remount
 * (reopen the drawer) or another poll that happened to change the count.
 */
describe('QueuePanel shrink control', () => {
  it('offers a way back to the first page once paged past it', () => {
    renderPanel(items(150))
    pageToEnd()
    expect(screen.getAllByTestId('queue-task')).toHaveLength(150)

    clickShowFewer()
    expect(screen.getAllByTestId('queue-task')).toHaveLength(120)

    clickShowFewer()
    expect(screen.getAllByTestId('queue-task')).toHaveLength(60)
  })

  it('keeps the more control reachable while shrinking', () => {
    // The two controls are alternative directions through the same
    // window: collapsing must not strand the user on the last page with
    // no way to grow it again.
    renderPanel(items(150))
    pageToEnd()
    expect(screen.queryByRole('button', { name: /show \d+ more/i })).toBeNull()

    clickShowFewer()
    const more = screen.getByRole('button', { name: /show \d+ more/i })
    expect(more).toHaveTextContent('Show 30 more')
    fireEvent.click(more)
    expect(screen.getAllByTestId('queue-task')).toHaveLength(150)
  })

  it('never shrinks below one page', () => {
    renderPanel(items(150))
    pageToEnd()
    for (let i = 0; i < 6; i++) {
      const btn = screen.queryByRole('button', { name: /show fewer/i })
      if (!btn) break
      fireEvent.click(btn)
    }
    expect(screen.getAllByTestId('queue-task')).toHaveLength(60)
  })

  it('hides the shrink control on the first page', () => {
    renderPanel(items(150))
    expect(screen.queryByRole('button', { name: /show fewer/i })).toBeNull()
  })

  it('renders no phantom rows when the window outruns the queue', () => {
    // Paged to a window wider than the queue that then returns as an
    // equally long but entirely different list: the length is unchanged
    // so the reset effect does not fire, and a window that renders by
    // position rather than by count would show rows 151+ of nothing.
    const { rerender } = renderPanel(items(150))
    pageToEnd()

    rerender(
      <QueuePanel items={items(150)} busyId={null} onRetry={vi.fn()} onRemove={vi.fn()} />
    )
    expect(screen.getAllByTestId('queue-task')).toHaveLength(150)
    expect(screen.getByText('150.')).toBeInTheDocument()
  })
})

/**
 * `jobLine()` renders one of three shapes, and the distinction between
 * them is the whole reason the backend has to send the enriched view:
 * "Title - Company" for a complete job, the surviving half plus the id
 * for a partially populated one, and `Job <id>` for a job that is gone.
 *
 * The middle case used to collapse into the last one, so a job with a
 * title but no company read as if the job did not exist — the same
 * visible loss as the raw-row bug, one level down. These are the
 * panel-level cases; electron/queueHandlerShape.test.tsx covers the
 * end-to-end path where a remove handed the panel raw rows.
 */
describe('QueuePanel job labelling', () => {
  function labelFor(overrides: Partial<QueueItemView>): string {
    // `cleanup` explicitly: several cases assert more than one label, and
    // RTL only auto-cleans between tests, so the second render would find
    // the first render's rows still mounted.
    const { unmount } = renderPanel([item(overrides)])
    const text = screen.getByTestId('queue-task-job').textContent ?? ''
    unmount()
    return text
  }

  it('joins a complete job as "Title - Company"', () => {
    expect(labelFor({ jobTitle: 'Junior Trader', jobCompany: 'Kairon Labs' }))
      .toBe('Junior Trader - Kairon Labs')
  })

  it('falls back to the id when the job has been deleted', () => {
    expect(labelFor({ jobTitle: null, jobCompany: null })).toBe('Job 1')
  })

  it('treats blank strings as absent, like null', () => {
    // A scraped posting can carry an empty company rather than a null
    // one. Rendering `Junior Trader - ` or ` - Kairon Labs` would be
    // worse than naming the id.
    expect(labelFor({ jobTitle: 'Junior Trader', jobCompany: '' }))
      .toBe('Junior Trader - Job 1')
    expect(labelFor({ jobTitle: '', jobCompany: 'Kairon Labs' }))
      .toBe('Kairon Labs - Job 1')
    expect(labelFor({ jobTitle: '', jobCompany: '' })).toBe('Job 1')
  })

  it('trims whitespace-only fields instead of rendering a dangling separator', () => {
    expect(labelFor({ jobTitle: 'Junior Trader', jobCompany: '   ' }))
      .toBe('Junior Trader - Job 1')
    expect(labelFor({ jobTitle: '  ', jobCompany: 'Kairon Labs' }))
      .toBe('Kairon Labs - Job 1')
  })

  it('keeps the half it has alongside the id, so the row stays identifiable', () => {
    // Two queued jobs can easily share a title; the id is what tells the
    // rows apart when the label can only be half-resolved.
    expect(labelFor({ jobTitle: 'Junior Trader', jobCompany: null }))
      .toBe('Junior Trader - Job 1')
  })
})
