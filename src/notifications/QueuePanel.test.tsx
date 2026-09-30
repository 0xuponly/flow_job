import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import QueuePanel from './QueuePanel'
import type { AIQueueItem } from '../types'

function item(overrides: Partial<AIQueueItem> = {}): AIQueueItem {
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

function items(n: number): AIQueueItem[] {
  return Array.from({ length: n }, (_, i) => item({ id: i + 1, jobId: i + 1 }))
}

function renderPanel(rows: AIQueueItem[]) {
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
