import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

// The bug this suite pins down lived in the IPC layer, not the panel:
// `aiQueue:remove` answered with `db.getAIQueue()` (raw store rows, no
// jobTitle / jobCompany) while `aiQueue:list` and `aiQueue:retry`
// answered with the enriched view. The renderer swaps its ENTIRE list
// for whatever a call returns, and `jobLine()` falls back to `Job <id>`
// for a row missing the display fields — so deleting ONE task silently
// renamed EVERY other row to `Job <id>`.
//
// So a test that only renders the panel cannot catch it: the panel
// faithfully renders whatever it is handed. These tests drive the REAL
// registered handlers from electron/main.ts against an in-memory store
// and assert on what the panel ends up showing. Against the old
// handler they fail; against the fixed one they pass.
//
// The electron mock captures `ipcMain.handle` registrations instead of
// stubbing them out, which is what makes this an integration test of
// the handler wiring rather than another mock of it.
const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>()
}))

vi.mock('electron', () => {
  const app = {
    getPath: () => '/tmp/flow_job-test-queue-labels',
    getAppPath: () => '/tmp/flow_job-test-queue-labels/app',
    getName: () => 'flow_job',
    getVersion: () => '0.0.0-test',
    setName: () => undefined,
    on: () => undefined,
    whenReady: () => Promise.resolve(),
    isReady: () => true,
    quit: () => undefined,
    setLoginItemSettings: () => undefined,
    disableHardwareAcceleration: () => undefined,
    commandLine: { appendSwitch: () => undefined },
    requestSingleInstanceLock: () => true
  }
  class BrowserWindow {
    static getAllWindows() { return [] }
    webContents = {
      send: () => undefined,
      setWindowOpenHandler: () => undefined,
      on: () => undefined,
      openDevTools: () => undefined
    }
    on() { return undefined }
    once() { return undefined }
    loadURL() { return Promise.resolve() }
    loadFile() { return Promise.resolve() }
    show() { return undefined }
    focus() { return undefined }
    destroy() { return undefined }
  }
  return {
    app,
    ipcMain: {
      handle: (channel: string, fn: (...a: unknown[]) => unknown) => handlers.set(channel, fn),
      on: () => undefined,
      removeHandler: () => undefined
    },
    BrowserWindow,
    dialog: {
      showMessageBox: () => Promise.resolve({ response: 0 }),
      showOpenDialog: () => Promise.resolve({ canceled: true, filePaths: [] }),
      showSaveDialog: () => Promise.resolve({ canceled: true })
    },
    screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1920, height: 1080 } }) },
    session: {
      defaultSession: {
        webRequest: {
          onHeadersReceived: () => undefined,
          onBeforeRequest: () => undefined
        }
      }
    },
    shell: { openExternal: () => Promise.resolve() },
    safeStorage: {
      isEncryptionAvailable: () => false,
      encryptString: (s: string) => Buffer.from(s, 'utf8'),
      decryptString: (b: Buffer) => b.toString('utf8')
    }
  }
})

/** Rows and jobs the fake store serves. Reset per test. */
const store = vi.hoisted(() => ({
  queue: [] as Record<string, unknown>[],
  jobs: new Map<number, { title: string; company: string; score: number }>(),
  /**
   * Rows the store keeps through a clear, standing in for work that
   * arrived after the clear's tombstone was written. `null` (the
   * default) clears everything, which is the ordinary case.
   */
  clearKeeps: null as number[] | null
}))

vi.mock('./database', () => ({
  getAIQueue: () => store.queue,
  removeAIQueueItem: (id: number) => {
    store.queue = store.queue.filter((q) => q.id !== id)
  },
  clearAIQueue: () => {
    const removed = store.queue.length
    store.queue = store.clearKeeps === null ? [] : store.queue.filter((q) => store.clearKeeps!.includes(q.id as number))
    return removed
  },
  addAIQueueItem: vi.fn(),
  updateAIQueueItem: vi.fn(() => true),
  getJob: (id: number) => store.jobs.get(id),
  getSettings: () => ({ disabled_boards: [] }),
  encryptionStatus: () => ({ mode: 'plaintext-fallback' })
}))

import { NotificationsProvider, useNotifications } from '../src/notifications/NotificationsProvider'
import Notifications from '../src/components/Notifications'
import NotificationDrawer from '../src/notifications/NotificationDrawer'

// Importing the main process module is what runs `registerIpc()`, so the
// handlers above are the real ones — including the return annotations
// that make a raw-row handler a compile error.
await import('./main')

function invoke(channel: string, ...args: unknown[]): unknown {
  const handler = handlers.get(channel)
  if (!handler) throw new Error(`no handler registered for ${channel}`)
  return handler({}, ...args)
}

/** Wires window.api straight through to the main-process handlers. */
function installApi(): void {
  const bridge = {
    listAIQueue: () => invoke('aiQueue:list'),
    retryAIQueueItem: (id: number) => invoke('aiQueue:retry', id),
    removeAIQueueItem: (id: number) => invoke('aiQueue:remove', id),
    clearAIQueue: () => invoke('aiQueue:clear'),
    notificationsList: () => invoke('notifications:notificationsList'),
    notificationsPurgeOldDismissed: () => invoke('notifications:notificationsPurgeOldDismissed'),
    notificationsDismiss: (params: unknown) => invoke('notifications:notificationsDismiss', params),
    notificationsDismissAll: () => invoke('notifications:notificationsDismissAll'),
    notificationsAdd: (params: unknown) => invoke('notifications:notificationsAdd', params)
  }
  // @ts-expect-error - test mock: attach `api` to the existing jsdom window
  globalThis.window.api = bridge
}

/**
 * `queueIds` doubles as the job id of each row, so one number per queued
 * task is enough to set a scenario up. A job in `jobs` is one the store
 * can still resolve; a queued id absent from it is a deleted job, which
 * is the panel's legitimate `Job <id>` case.
 */
function seed(jobRows: { id: number; title: string; company: string }[], queueIds: number[]): void {
  store.jobs = new Map(jobRows.map((j) => [j.id, { title: j.title, company: j.company, score: 0.5 }]))
  store.queue = queueIds.map((id, i) => ({
    id,
    type: 'score_fit',
    jobId: id,
    status: 'pending',
    attempts: 0,
    createdAt: i,
    nextRetryAt: 0
  }))
}

function OpenButton() {
  const { open } = useNotifications()
  return <button onClick={open}>open</button>
}

async function openQueuePanel(): Promise<void> {
  render(
    <NotificationsProvider>
      <Notifications />
      <OpenButton />
      <NotificationDrawer />
    </NotificationsProvider>
  )
  fireEvent.click(await screen.findByText('open'))
  fireEvent.click(await screen.findByRole('tab', { name: /queue/i }))
}

/** The "{title} - {company}" label of each visible row, in order. */
function jobLabels(): string[] {
  return screen.queryAllByTestId('queue-task-job').map((el) => el.textContent ?? '')
}

function removeButtonFor(label: string): HTMLElement {
  const row = screen.getAllByTestId('queue-task').find((el) =>
    el.querySelector('[data-testid="queue-task-job"]')?.textContent === label
  )
  if (!row) throw new Error(`no row labelled ${label}`)
  const button = Array.from(row.querySelectorAll('button')).find(
    (b) => b.textContent === 'Remove'
  )
  if (!button) throw new Error(`row ${label} has no Remove button`)
  return button as HTMLElement
}

beforeEach(() => {
  store.queue = []
  store.jobs = new Map()
  store.clearKeeps = null
  installApi()
})

/**
 * The regression itself. Every row's label must survive another row's
 * removal: the labels are a function of the job, not of the queue's
 * length or of which row happened to be deleted.
 */
describe('removing one queue item does not rename the others', () => {
  it('keeps every remaining row labelled after a remove', async () => {
    seed(
      [
        { id: 2657, title: 'Junior Trader', company: 'Kairon Labs' },
        { id: 2658, title: 'Data Engineer', company: 'Globex' },
        { id: 2659, title: 'Quant Dev', company: 'Jane Street' }
      ],
      [2657, 2658, 2659]
    )
    await openQueuePanel()
    await screen.findByText('Junior Trader - Kairon Labs')
    expect(jobLabels()).toEqual([
      'Junior Trader - Kairon Labs',
      'Data Engineer - Globex',
      'Quant Dev - Jane Street'
    ])

    fireEvent.click(removeButtonFor('Quant Dev - Jane Street'))

    await waitFor(() => expect(screen.queryAllByTestId('queue-task')).toHaveLength(2))
    // The point of the test: the two rows that were NOT touched keep the
    // exact text they had before the remove.
    expect(jobLabels()).toEqual(['Junior Trader - Kairon Labs', 'Data Engineer - Globex'])
  })

  it('keeps labels through a retry of an unrelated row', async () => {
    // Same shape of bug on a different path: retry used to be safe only
    // by accident of its implementation, so it is pinned here too.
    seed(
      [
        { id: 1, title: 'Junior Trader', company: 'Kairon Labs' },
        { id: 2, title: 'Data Engineer', company: 'Globex' }
      ],
      [1, 2]
    )
    await openQueuePanel()
    await screen.findByText('Junior Trader - Kairon Labs')

    const result = invoke('aiQueue:retry', 2) as { jobTitle: string | null }[]
    expect(result.map((r) => r.jobTitle)).toEqual(['Junior Trader', 'Data Engineer'])
  })

  it('confines a deleted job\'s fallback to that job\'s own row', async () => {
    // A deleted job legitimately renders `Job <id>`. That is a property
    // of THAT row, and removing it must not spread the fallback to the
    // rows whose jobs are still there.
    seed(
      [
        { id: 1, title: 'Junior Trader', company: 'Kairon Labs' },
        { id: 42, title: 'Data Engineer', company: 'Globex' }
      ],
      [1, 42]
    )
    // The job is deleted from the store, not from the queue: its row
    // stays queued and legitimately loses its label.
    store.jobs.delete(42)
    await openQueuePanel()
    await screen.findByText('Junior Trader - Kairon Labs')
    expect(jobLabels()).toEqual(['Junior Trader - Kairon Labs', 'Job 42'])

    fireEvent.click(removeButtonFor('Job 42'))

    await waitFor(() => expect(screen.queryAllByTestId('queue-task')).toHaveLength(1))
    expect(jobLabels()).toEqual(['Junior Trader - Kairon Labs'])
  })
})

/**
 * The legitimate fallback: a job that no longer exists has no title, and
 * the panel says so with the id rather than rendering "null - null".
 * This is the ONLY case `Job <id>` is for, which is why the remove-path
 * tests above assert the opposite for every surviving row.
 */
describe('a genuinely deleted job still shows the Job <id> fallback', () => {
  it('renders the id when the job row is gone', async () => {
    seed([{ id: 1, title: 'Junior Trader', company: 'Kairon Labs' }], [1])
    // The job is not in the store: getJob returns undefined for it.
    store.jobs = new Map()
    await openQueuePanel()
    expect(await screen.findByTestId('queue-task-job')).toHaveTextContent('Job 1')
  })

})

/**
 * Clear is the same trap one button over. `clearQueue()` returns
 * `{ removed, queue }`, and the renderer sets its whole list from
 * `queue` — so if that `queue` were the raw shape, clicking Clear would
 * blank every label in the panel exactly as a remove did. It returns
 * the enriched view, and these assertions keep it that way.
 */
describe('the clear path returns the same enriched shape', () => {
  it('reports the count and hands back an empty queue on a full clear', () => {
    seed([{ id: 1, title: 'Junior Trader', company: 'Kairon Labs' }], [1])
    const result = invoke('aiQueue:clear') as { removed: number; queue: unknown[] }
    expect(result.removed).toBe(1)
    expect(result.queue).toEqual([])
  })

  it('resolves jobTitle and jobCompany for rows the clear left behind', () => {
    // The clear empties the queue, so the interesting case is a row that
    // is still there afterwards: work that landed after the clear's
    // tombstone, or an item the processor had in flight. Whatever the
    // reason, the renderer replaces its whole list from this `queue`, so
    // a raw row here blanks every label in the panel exactly as a remove
    // did — with the added insult of the user having asked to clear.
    seed(
      [
        { id: 1, title: 'Junior Trader', company: 'Kairon Labs' },
        { id: 2, title: 'Data Engineer', company: 'Globex' }
      ],
      [1, 2]
    )
    store.clearKeeps = [2]
    const result = invoke('aiQueue:clear') as {
      removed: number
      queue: { id: number; jobTitle: string | null; jobCompany: string | null }[]
    }
    expect(result.removed).toBe(2)
    expect(result.queue).toHaveLength(1)
    expect(result.queue[0].jobTitle).toBe('Data Engineer')
    expect(result.queue[0].jobCompany).toBe('Globex')
  })

  it('leaves the fields null for a row whose job is gone', () => {
    seed([{ id: 1, title: 'Junior Trader', company: 'Kairon Labs' }], [1])
    store.clearKeeps = [1]
    store.jobs = new Map()
    const result = invoke('aiQueue:clear') as {
      queue: { jobTitle: string | null; jobCompany: string | null }[]
    }
    expect(result.queue[0].jobTitle).toBeNull()
    expect(result.queue[0].jobCompany).toBeNull()
  })

  it('empties the panel without a label regression', async () => {
    seed(
      [
        { id: 1, title: 'Junior Trader', company: 'Kairon Labs' },
        { id: 2, title: 'Data Engineer', company: 'Globex' }
      ],
      [1, 2]
    )
    await openQueuePanel()
    await screen.findByText('Junior Trader - Kairon Labs')

    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    fireEvent.click(screen.getByRole('button', { name: /clear queue/i }))

    await waitFor(() => expect(screen.getByText('No queued tasks.')).toBeInTheDocument())
    confirmSpy.mockRestore()
  })
})

/**
 * Every queue-returning channel answers with the same keys, so no path
 * can quietly hand the panel a different shape again. This is the
 * runtime counterpart to the `QueueItemView` return annotations.
 */
describe('every queue-returning channel returns one shape', () => {
  it('gives list, retry and remove the same row keys', () => {
    seed(
      [
        { id: 1, title: 'Junior Trader', company: 'Kairon Labs' },
        { id: 2, title: 'Data Engineer', company: 'Globex' },
        { id: 3, title: 'Quant Dev', company: 'Jane Street' }
      ],
      [1, 2, 3]
    )

    const list = invoke('aiQueue:list') as Record<string, unknown>[]
    const retried = invoke('aiQueue:retry', 2) as Record<string, unknown>[]
    const removed = invoke('aiQueue:remove', 3) as Record<string, unknown>[]
    const cleared = invoke('aiQueue:clear') as { removed: number; queue: unknown[] }

    const keys = (rows: Record<string, unknown>[]) => Object.keys(rows[0]).sort()
    expect(removed).toHaveLength(2)
    expect(keys(removed)).toEqual(keys(list))
    expect(keys(retried)).toEqual(keys(list))
    // Clear leaves nothing behind, so there are no rows to compare keys
    // on — only the count, which is what its contract promises.
    expect(cleared.queue).toEqual([])

    // Every path that still has rows resolved the job's display fields.
    for (const row of [list[0], retried[0], removed[0]]) {
      expect(Object.keys(row)).toContain('jobTitle')
      expect(Object.keys(row)).toContain('jobCompany')
      expect(row.jobTitle).toBe('Junior Trader')
      expect(row.jobCompany).toBe('Kairon Labs')
    }
  })
})
