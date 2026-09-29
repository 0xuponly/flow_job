import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { NotificationsProvider, useNotifications } from './NotificationsProvider'
import Notifications from '../components/Notifications'
import NotificationDrawer from './NotificationDrawer'
import { queueItemLabel, queueItemStatusText } from '../fitQueue'
import type { AIQueueItem } from '../types'

const mockApi = {
  notificationsList: vi.fn(),
  notificationsAdd: vi.fn(),
  notificationsDismiss: vi.fn(),
  notificationsDismissAll: vi.fn(),
  notificationsPurgeOldDismissed: vi.fn(),
  listAIQueue: vi.fn(),
  clearAIQueue: vi.fn(),
  retryAIQueueItem: vi.fn(),
  removeAIQueueItem: vi.fn(),
}

beforeEach(() => {
  vi.clearAllMocks()
  mockApi.notificationsList.mockResolvedValue({ rows: [] })
  mockApi.notificationsPurgeOldDismissed.mockResolvedValue({ deleted: 0 })
  mockApi.listAIQueue.mockResolvedValue([])
  // @ts-expect-error - test mock
  globalThis.window.api = mockApi
})

function item(overrides: Partial<AIQueueItem> = {}): AIQueueItem {
  return {
    id: 1,
    type: 'verify',
    jobId: 7,
    status: 'pending',
    attempts: 0,
    createdAt: 1,
    nextRetryAt: 0,
    ...overrides,
  }
}

function OpenButton() {
  const { open } = useNotifications()
  return <button onClick={open}>open</button>
}

async function openDrawer() {
  render(<NotificationsProvider><OpenButton /><NotificationDrawer /></NotificationsProvider>)
  fireEvent.click(screen.getByText('open'))
  return screen.findByTestId('notif-backdrop')
}

async function showQueueTab() {
  fireEvent.click(await screen.findByRole('tab', { name: /queue/i }))
}

describe('NotificationDrawer', () => {
  it('renders the empty state when the list is empty', async () => {
    await openDrawer()
    expect(await screen.findByText(/no notifications/i)).toBeInTheDocument()
  })

  it('renders one row per item in the list', async () => {
    mockApi.notificationsList.mockResolvedValue({ rows: [
      { id: 1, type: 'info', source: 'app', message: 'alpha', full_message: 'alpha long', created_at: 1, dismissed_at: null },
      { id: 2, type: 'error', source: 'ai', message: 'beta', full_message: 'beta long', created_at: 2, dismissed_at: null },
    ]})
    await openDrawer()
    expect(await screen.findByText('alpha')).toBeInTheDocument()
    expect(await screen.findByText('beta')).toBeInTheDocument()
  })

  it('clicking the body toggles expanded and shows the full message', async () => {
    mockApi.notificationsList.mockResolvedValue({ rows: [
      { id: 1, type: 'info', source: 'app', message: 'short', full_message: 'this is the long version', created_at: 1, dismissed_at: null },
    ]})
    await openDrawer()
    const body = await screen.findByText('short')
    expect(screen.queryByText('this is the long version')).not.toBeInTheDocument()
    fireEvent.click(body)
    expect(screen.getByText('this is the long version')).toBeInTheDocument()
  })

  it('clicking X calls dismiss', async () => {
    mockApi.notificationsList.mockResolvedValue({ rows: [
      { id: 42, type: 'info', source: 'app', message: 'a', full_message: 'a', created_at: 1, dismissed_at: null },
    ]})
    mockApi.notificationsDismiss.mockResolvedValue({ ok: true })
    await openDrawer()
    fireEvent.click(await screen.findByRole('button', { name: /dismiss/i }))
    expect(mockApi.notificationsDismiss).toHaveBeenCalledWith({ id: 42 })
  })

  it('clicking the backdrop calls close', async () => {
    await openDrawer()
    fireEvent.click(await screen.findByTestId('notif-backdrop'))
    expect(screen.queryByTestId('notif-backdrop')).not.toBeInTheDocument()
  })

  it('pressing Esc calls close', async () => {
    await openDrawer()
    expect(await screen.findByTestId('notif-backdrop')).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByTestId('notif-backdrop')).not.toBeInTheDocument()
  })
})

describe('NotificationDrawer panel tabs', () => {
  it('opens on the notifications panel', async () => {
    await openDrawer()
    expect(screen.getByRole('tab', { name: /notifications/i })).toHaveAttribute('aria-selected', 'true')
  })

  it('shows the queue panel only after clicking the Queue tab', async () => {
    mockApi.listAIQueue.mockResolvedValue([item({ id: 1, type: 'score_fit', jobId: 7 })])
    await openDrawer()
    // Notifications is the default view; the queue is not rendered yet.
    expect(screen.queryByText('Score fit')).not.toBeInTheDocument()
    expect(mockApi.listAIQueue).not.toHaveBeenCalled()

    await showQueueTab()
    expect(await screen.findByText('Score fit')).toBeInTheDocument()
    expect(mockApi.listAIQueue).toHaveBeenCalled()
  })

  it('switches back to the notifications panel', async () => {
    mockApi.notificationsList.mockResolvedValue({ rows: [
      { id: 1, type: 'info', source: 'app', message: 'a notification', full_message: 'a notification', created_at: 1, dismissed_at: null },
    ]})
    await openDrawer()
    await showQueueTab()
    await screen.findByText(/no queued tasks/i)

    fireEvent.click(screen.getByRole('tab', { name: /notifications/i }))
    expect(await screen.findByText('a notification')).toBeInTheDocument()
  })

  it('renders queued tasks in the order returned by the main process', async () => {
    // The main process already applies pick order (score_fit first,
    // then fit DESC). The panel must not re-sort — doing so in the
    // renderer is exactly the drift this design avoids.
    mockApi.listAIQueue.mockResolvedValue([
      item({ id: 1, type: 'score_fit', jobId: 7 }),
      item({ id: 2, type: 'verify', jobId: 8 }),
      item({ id: 3, type: 'tailor_job_docs', jobId: 9 }),
    ])
    await openDrawer()
    await showQueueTab()
    const labels = await screen.findAllByTestId('queue-task-label')
    expect(labels.map((el) => el.textContent)).toEqual([
      'Score fit',
      'Verify document',
      'Generate CV + cover letter',
    ])
  })

  it('shows the job id so a task can be traced back to its job', async () => {
    mockApi.listAIQueue.mockResolvedValue([item({ id: 1, type: 'verify', jobId: 42 })])
    await openDrawer()
    await showQueueTab()
    expect(await screen.findByText(/job 42/i)).toBeInTheDocument()
  })

  it('shows the empty state when nothing is queued', async () => {
    mockApi.listAIQueue.mockResolvedValue([])
    await openDrawer()
    await showQueueTab()
    expect(await screen.findByText(/no queued tasks/i)).toBeInTheDocument()
  })

  it('shows a queued task count in the Queue tab', async () => {
    mockApi.listAIQueue.mockResolvedValue([
      item({ id: 1, type: 'score_fit', jobId: 7 }),
      item({ id: 2, type: 'verify', jobId: 8 }),
    ])
    await openDrawer()
    await showQueueTab()
    await screen.findByText('Score fit')
    expect(screen.getByRole('tab', { name: /queue/i })).toHaveTextContent('2')
  })

  it('shows the status line for a processing task', async () => {
    mockApi.listAIQueue.mockResolvedValue([item({ id: 1, status: 'processing' })])
    await openDrawer()
    await showQueueTab()
    expect(await screen.findByText(/processing/i)).toBeInTheDocument()
  })

  it('shows the failure reason for a failed task', async () => {
    mockApi.listAIQueue.mockResolvedValue([
      item({ id: 1, status: 'failed', attempts: 3, autoRevives: 3, lastError: 'rate limited' })
    ])
    await openDrawer()
    await showQueueTab()
    expect(await screen.findByText(/failed \(3 attempts\)/i)).toBeInTheDocument()
    expect(screen.getByText(/rate limited/i)).toBeInTheDocument()
  })

  it('only offers Retry for a failed task', async () => {
    mockApi.listAIQueue.mockResolvedValue([
      item({ id: 1, type: 'verify', jobId: 1, status: 'failed', autoRevives: 3 }),
      item({ id: 2, type: 'verify', jobId: 2, status: 'pending' }),
    ])
    await openDrawer()
    await showQueueTab()
    await screen.findByText(/failed/i)
    expect(screen.getAllByRole('button', { name: /retry/i })).toHaveLength(1)
  })

  it('retrying a failed task calls the retry API and refreshes the list', async () => {
    const retried = [item({ id: 1, type: 'verify', jobId: 1, status: 'pending' })]
    mockApi.listAIQueue.mockResolvedValue([item({ id: 1, type: 'verify', jobId: 1, status: 'failed' })])
    mockApi.retryAIQueueItem.mockResolvedValue(retried)
    await openDrawer()
    await showQueueTab()
    fireEvent.click(await screen.findByRole('button', { name: /retry/i }))
    expect(mockApi.retryAIQueueItem).toHaveBeenCalledWith(1)
    // The response replaces the list — the task is no longer failed.
    await waitFor(() => {
      expect(screen.queryByText(/failed/i)).not.toBeInTheDocument()
    })
  })

  it('removing a task calls the remove API', async () => {
    mockApi.listAIQueue.mockResolvedValue([item({ id: 5, type: 'verify', jobId: 1 })])
    mockApi.removeAIQueueItem.mockResolvedValue([])
    await openDrawer()
    await showQueueTab()
    fireEvent.click(await screen.findByRole('button', { name: /remove/i }))
    expect(mockApi.removeAIQueueItem).toHaveBeenCalledWith(5)
    await waitFor(() => {
      expect(screen.getByText(/no queued tasks/i)).toBeInTheDocument()
    })
  })

  it('surfaces an error when a queue call fails', async () => {
    mockApi.listAIQueue.mockResolvedValue([item({ id: 1, type: 'verify', jobId: 1, status: 'failed', autoRevives: 3 })])
    mockApi.retryAIQueueItem.mockResolvedValue({ error: 'boom' })
    await openDrawer()
    await showQueueTab()
    fireEvent.click(await screen.findByRole('button', { name: /retry/i }))
    // The failed row survives the rejected call rather than vanishing.
    expect(await screen.findByText(/failed/i)).toBeInTheDocument()
  })

  it('hides the notifications-only Dismiss all control on the Queue tab', async () => {
    await openDrawer()
    expect(screen.getByRole('button', { name: /clear all notifications/i })).toBeInTheDocument()
    await showQueueTab()
    expect(screen.queryByRole('button', { name: /clear all notifications/i })).not.toBeInTheDocument()
  })

  it('closes on Escape from the Queue tab', async () => {
    mockApi.listAIQueue.mockResolvedValue([item({ id: 1, type: 'verify', jobId: 1 })])
    await openDrawer()
    await showQueueTab()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByTestId('notif-backdrop')).not.toBeInTheDocument()
  })
})

describe('NotificationDrawer queue polling', () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }))
  afterEach(() => vi.useRealTimers())

  it('refreshes the queue periodically while the panel is open', async () => {
    mockApi.listAIQueue.mockResolvedValue([item({ id: 1, type: 'score_fit', jobId: 7 })])
    await openDrawer()
    await showQueueTab()
    await screen.findByText('Score fit')
    const callsAfterOpen = mockApi.listAIQueue.mock.calls.length

    await vi.advanceTimersByTimeAsync(10000)
    expect(mockApi.listAIQueue.mock.calls.length).toBeGreaterThan(callsAfterOpen)
  })

  it('does not poll before the Queue tab is opened', async () => {
    mockApi.listAIQueue.mockResolvedValue([item({ id: 1, type: 'score_fit', jobId: 7 })])
    await openDrawer()
    await vi.advanceTimersByTimeAsync(30000)
    expect(mockApi.listAIQueue).not.toHaveBeenCalled()
  })

  it('stops polling once the drawer is closed', async () => {
    mockApi.listAIQueue.mockResolvedValue([item({ id: 1, type: 'score_fit', jobId: 7 })])
    await openDrawer()
    await showQueueTab()
    await screen.findByText('Score fit')
    const calls = mockApi.listAIQueue.mock.calls.length

    fireEvent.keyDown(document, { key: 'Escape' })
    await vi.advanceTimersByTimeAsync(30000)
    expect(mockApi.listAIQueue.mock.calls.length).toBe(calls)
  })
})

describe('queue task formatting', () => {
  it('labels every queue type the main process can emit', () => {
    const types: AIQueueItem['type'][] = [
      'generate_cv', 'generate_cover_letter', 'regenerate_section',
      'verify', 'tailor_job_docs', 'score_fit',
    ]
    for (const type of types) {
      const label = queueItemLabel(item({ type, sectionName: 'summary' }))
      expect(label, `type ${type} needs a label`).toBeTruthy()
      expect(label).not.toMatch(/undefined/)
    }
  })

  it('includes the section name for a section regeneration', () => {
    expect(queueItemLabel(item({ type: 'regenerate_section', sectionName: 'summary' })))
      .toContain('summary')
  })

  it('describes a pending task as pending', () => {
    expect(queueItemStatusText(item())).toBe('Pending')
  })

  it('describes an in-flight task as processing', () => {
    expect(queueItemStatusText(item({ status: 'processing' }))).toMatch(/processing/i)
  })

  it('reports the attempt count for a task with no recovery budget left', () => {
    expect(queueItemStatusText(item({ status: 'failed', attempts: 4, autoRevives: 3 })))
      .toContain('Failed (4 attempts)')
  })

  it('counts down to the next retry for a backing-off task', () => {
    const now = 1_000_000
    const text = queueItemStatusText(item({ attempts: 2, nextRetryAt: now + 30_000 }), now)
    expect(text).toBe('Retry in 30s (attempt 2)')
  })

  it('never reports a negative wait for a task whose retry time has passed', () => {
    const now = 1_000_000
    const text = queueItemStatusText(item({ attempts: 1, nextRetryAt: now - 5_000 }), now)
    expect(text).toBe('Retry in 0s (attempt 1)')
  })
})

describe('queue task automatic recovery', () => {
  const now = 1_700_000_000_000

  it('says a failed task with budget left is retrying automatically', () => {
    const text = queueItemStatusText(
      item({ status: 'failed', attempts: 5, autoRevives: 0, nextRetryAt: now + 1_800_000 }), now
    )
    expect(text).toMatch(/retrying automatically/i)
    expect(text).toMatch(/30m/)
  })

  it('flags a task that has spent its revive budget as needing attention', () => {
    const text = queueItemStatusText(
      item({ status: 'failed', attempts: 5, autoRevives: 3, nextRetryAt: 0 }), now
    )
    expect(text).toMatch(/needs attention/i)
    expect(text).not.toMatch(/retrying automatically/i)
  })

  it('shows a revived task as recovered rather than plain pending', () => {
    const text = queueItemStatusText(item({ attempts: 0, autoRevives: 1 }), now)
    expect(text).toMatch(/recovered/i)
    expect(text).toMatch(/round 2/i)
  })

  it('keeps a fresh task reading as simply pending', () => {
    expect(queueItemStatusText(item({ attempts: 0 }), now)).toBe('Pending')
  })

  it('renders an hours-long wait in hours', () => {
    const text = queueItemStatusText(
      item({ status: 'failed', attempts: 5, autoRevives: 1, nextRetryAt: now + 7_200_000 }), now
    )
    expect(text).toMatch(/2h/)
  })

  it('renders a due task as retrying imminently', () => {
    const text = queueItemStatusText(
      item({ status: 'failed', attempts: 5, autoRevives: 1, nextRetryAt: now - 1 }), now
    )
    expect(text).toMatch(/retrying automatically…/i)
  })
})

describe('queue task wait formatting at real cooldowns', () => {
  const now = 1_700_000_000_000
  const failed = (extra: Partial<AIQueueItem>) =>
    item({ status: 'failed', attempts: 5, autoRevives: 0, nextRetryAt: now, ...extra })

  it('shows a four-hour cooldown in hours, not seconds', () => {
    // 4h as "14400s" was the failure mode when the cooldown was tuned;
    // formatWait has to scale with whatever the constant becomes.
    const text = queueItemStatusText(failed({ nextRetryAt: now + 4 * 60 * 60 * 1000 }), now)
    expect(text).toBe('Retrying automatically in 4h')
  })

  it('shows a one-hour cooldown in hours', () => {
    expect(queueItemStatusText(failed({ nextRetryAt: now + 60 * 60 * 1000 }), now))
      .toBe('Retrying automatically in 1h')
  })

  it('rounds a partial hour up so it never reads as already due', () => {
    expect(queueItemStatusText(failed({ nextRetryAt: now + 90 * 60 * 1000 }), now))
      .toBe('Retrying automatically in 2h')
  })
})

describe('Clear queue', () => {
  const threeTasks = [
    item({ id: 1, type: 'score_fit', jobId: 7 }),
    item({ id: 2, type: 'verify', jobId: 8 }),
    item({ id: 3, type: 'tailor_job_docs', jobId: 9 }),
  ]

  const realConfirm = window.confirm
  afterEach(() => {
    // vi.clearAllMocks() does NOT undo a direct property assignment, so
    // without this every later test in the file inherited a stubbed
    // confirm (and the file failed under --sequence.shuffle).
    window.confirm = realConfirm
  })

  function stubConfirm(result: boolean) {
    const spy = vi.fn(() => result)
    window.confirm = spy as unknown as typeof window.confirm
    return spy
  }

  beforeEach(() => {
    mockApi.clearAIQueue = vi.fn().mockResolvedValue({ removed: 3, queue: [] })
    // @ts-expect-error - test mock
    globalThis.window.api = mockApi
  })

  it('is only offered on the Queue tab', async () => {
    mockApi.listAIQueue.mockResolvedValue(threeTasks)
    await openDrawer()
    expect(screen.queryByRole('button', { name: /clear queue/i })).not.toBeInTheDocument()
    await showQueueTab()
    expect(await screen.findByRole('button', { name: /clear queue/i })).toBeInTheDocument()
  })

  it('does nothing without asking first', async () => {
    // Stubbed explicitly: without this the test passed only because
    // jsdom's unimplemented confirm() returns undefined, and it fails
    // under --sequence.shuffle by inheriting another test's stub.
    const confirmSpy = stubConfirm(false)
    mockApi.listAIQueue.mockResolvedValue(threeTasks)
    await openDrawer()
    await showQueueTab()
    fireEvent.click(await screen.findByRole('button', { name: /clear queue/i }))
    // The dialog is what gates it, and declining is what stops it.
    expect(confirmSpy).toHaveBeenCalledTimes(1)
    expect(mockApi.clearAIQueue).not.toHaveBeenCalled()
    expect(await screen.findByText('Score fit')).toBeInTheDocument()
  })

  it('states the count so the user confirms a size, not just an action', async () => {
    mockApi.listAIQueue.mockResolvedValue(threeTasks)
    const confirmSpy = stubConfirm(false)
    await openDrawer()
    await showQueueTab()
    fireEvent.click(await screen.findByRole('button', { name: /clear queue/i }))
    expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining('3 queued tasks'))
  })

  it('clears exactly once when confirmed', async () => {
    mockApi.listAIQueue.mockResolvedValue(threeTasks)
    stubConfirm(true)
    await openDrawer()
    await showQueueTab()
    fireEvent.click(await screen.findByRole('button', { name: /clear queue/i }))
    await waitFor(() => expect(mockApi.clearAIQueue).toHaveBeenCalledTimes(1))
  })

  it('ignores a second click while the clear is in flight', async () => {
    let resolve!: (v: { removed: number; queue: AIQueueItem[] }) => void
    mockApi.clearAIQueue = vi.fn(() => new Promise((r) => { resolve = r }))
    mockApi.listAIQueue.mockResolvedValue(threeTasks)
    stubConfirm(true)
    await openDrawer()
    await showQueueTab()
    const btn = await screen.findByRole('button', { name: /clear queue/i })
    fireEvent.click(btn)
    await waitFor(() => expect(btn).toBeDisabled())
    fireEvent.click(btn)
    expect(mockApi.clearAIQueue).toHaveBeenCalledTimes(1)
    resolve({ removed: 3, queue: [] })
  })

  it('empties the panel from the response rather than guessing', async () => {
    mockApi.listAIQueue.mockResolvedValue(threeTasks)
    stubConfirm(true)
    await openDrawer()
    await showQueueTab()
    fireEvent.click(await screen.findByRole('button', { name: /clear queue/i }))
    expect(await screen.findByText(/no queued tasks/i)).toBeInTheDocument()
    expect(screen.queryByText('Score fit')).not.toBeInTheDocument()
  })

  it('is disabled when there is nothing to clear', async () => {
    mockApi.listAIQueue.mockResolvedValue([])
    await openDrawer()
    await showQueueTab()
    const btn = await screen.findByRole('button', { name: /clear queue/i })
    expect(btn).toBeDisabled()
  })

  it('keeps the queue visible when the clear call fails', async () => {
    mockApi.listAIQueue.mockResolvedValue(threeTasks)
    mockApi.clearAIQueue = vi.fn().mockRejectedValue(new Error('ipc down'))
    stubConfirm(true)
    await openDrawer()
    await showQueueTab()
    fireEvent.click(await screen.findByRole('button', { name: /clear queue/i }))
    // A failed clear must not blank the panel and imply success.
    expect(await screen.findByText('Score fit')).toBeInTheDocument()
  })

  it('tells the user how many tasks were removed, from the main process count', async () => {
    // The rendered list is polled and can be stale, so the announced
    // number has to come from the response, not queue.length.
    mockApi.listAIQueue.mockResolvedValue(threeTasks)
    mockApi.clearAIQueue = vi.fn().mockResolvedValue({ removed: 1, queue: [] })
    stubConfirm(true)
    render(
      <NotificationsProvider>
        <Notifications />
        <OpenButton />
        <NotificationDrawer />
      </NotificationsProvider>
    )
    fireEvent.click(screen.getByText('open'))
    await showQueueTab()
    fireEvent.click(await screen.findByRole('button', { name: /clear queue/i }))
    expect(await screen.findByText('Cleared 1 queued task.')).toBeInTheDocument()
  })

  it('reports the failure rather than silently doing nothing', async () => {
    mockApi.listAIQueue.mockResolvedValue(threeTasks)
    mockApi.clearAIQueue = vi.fn().mockRejectedValue(new Error('ipc down'))
    stubConfirm(true)
    render(
      <NotificationsProvider>
        <Notifications />
        <OpenButton />
        <NotificationDrawer />
      </NotificationsProvider>
    )
    fireEvent.click(screen.getByText('open'))
    await showQueueTab()
    fireEvent.click(await screen.findByRole('button', { name: /clear queue/i }))
    expect(await screen.findByText('Could not clear the queue')).toBeInTheDocument()
  })

  it('recovers the button after a failed clear', async () => {
    mockApi.listAIQueue.mockResolvedValue(threeTasks)
    mockApi.clearAIQueue = vi.fn().mockRejectedValue(new Error('ipc down'))
    stubConfirm(true)
    await openDrawer()
    await showQueueTab()
    fireEvent.click(await screen.findByRole('button', { name: /clear queue/i }))
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /clear queue/i })).not.toBeDisabled()
    })
  })
})
