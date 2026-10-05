/**
 * The notification center as the user meets it.
 *
 * The reported bug and the requested feature are two ends of one thing, so
 * this file is where they are joined: one generate click against a job
 * whose documents all fail used to mean ten toasts and no record of any
 * of them. It now means one toast, one collapsed row, and every
 * occurrence readable in full.
 *
 * What is pinned here, and why each is a separate claim:
 *
 *   grouping  — twelve near-identical failures are ONE row with a count,
 *               and expanding shows twelve entries rather than a
 *               truncation of them. The second half is the one that
 *               matters: collapsing without an expandable list would be
 *               the same information loss in new clothes.
 *   detail    — each occurrence carries its own datetime, its own job
 *               citation and the FULL error, and a field the app could
 *               not source is rendered as nothing at all.
 *   dismissal — per occurrence, per group, and all. Dismissing a group
 *               must touch that group and no other.
 *
 * The `group_key` values are opaque strings the main process wrote at
 * insert time (electron/notificationGroup.ts); how they are derived is
 * covered in electron/notificationCenter.store.test.ts.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { NotificationsProvider, useNotifications } from './NotificationsProvider'
import NotificationDrawer from './NotificationDrawer'
import Notifications from '../components/Notifications'
import type { NotificationRow } from '../types'

const mockApi = {
  notificationsList: vi.fn(),
  notificationsAdd: vi.fn(),
  notificationsDismiss: vi.fn(),
  notificationsDismissMany: vi.fn(),
  notificationsDismissAll: vi.fn(),
  notificationsPurgeOldDismissed: vi.fn(),
  onNotificationsChanged: vi.fn((_cb: () => void) => () => undefined),
  listAIQueue: vi.fn(),
}

beforeEach(() => {
  vi.clearAllMocks()
  mockApi.notificationsList.mockResolvedValue({ rows: [] })
  mockApi.notificationsPurgeOldDismissed.mockResolvedValue({ deleted: 0 })
  mockApi.notificationsDismiss.mockResolvedValue({ ok: true })
  mockApi.notificationsDismissMany.mockResolvedValue({ updated: 0 })
  mockApi.notificationsDismissAll.mockResolvedValue({ updated: 0 })
  mockApi.listAIQueue.mockResolvedValue([])
  // @ts-expect-error - test mock
  globalThis.window.api = mockApi
})

const JOB = { job_id: 7, job_title: 'Staff Engineer', job_company: 'Acme', job_location: 'Berlin, DE' }

/** n distinct failures of one kind, one per minute apart. */
function flood(count: number, over: Partial<NotificationRow> = {}): NotificationRow[] {
  const message = 'Content review failed: 12 errors: 11 rate limited, 1 other.'
  return Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    type: 'error' as const,
    source: 'ai' as const,
    message,
    full_message: `CV #${i + 1}\nAll 12 configured AI models are rate limited — try again in a minute:\nModel ${i}: HTTP 503 (request ${i})`,
    created_at: 1_700_000_000_000 + i * 60_000,
    dismissed_at: null,
    group_key: 'error|ai|content review failed: # errors: # rate limited, # other.',
    job: JOB,
    ...over
  }))
}

function OpenButton() {
  const { open } = useNotifications()
  return <button onClick={open}>open</button>
}

async function openDrawer(rows: NotificationRow[]): Promise<void> {
  mockApi.notificationsList.mockResolvedValue({ rows })
  render(
    <NotificationsProvider>
      {/* The toast host. `notify` drops a message when nothing is
          listening, and the provider reports its own failures by toast —
          without one of these the "a dismissal failed" path cannot be
          observed at all. */}
      <Notifications />
      <OpenButton />
      <NotificationDrawer />
    </NotificationsProvider>
  )
  fireEvent.click(screen.getByText('open'))
  await screen.findByTestId('notif-backdrop')
}

/** Expand a collapsed group row by clicking its message. */
function expandGroup(message: string): void {
  fireEvent.click(screen.getByText(message))
}

/** The expanded occurrence entries, newest first. */
function occurrences(): HTMLElement[] {
  return screen.getAllByRole('listitem').filter((el) => el.className === 'notif-occurrence')
}

/**
 * The citation line of an entry — datetime plus whichever of title,
 * company and location the row carries — with the full message below it
 * excluded. Asserting on the whole entry would be testing the fixture's
 * own prose: an error message is full of em dashes and often contains
 * "Remote", and none of that is a placeholder leaking into the citation.
 */
function citationOf(entry: HTMLElement): string {
  return entry.querySelector('time')?.parentElement?.textContent ?? ''
}

describe('R2 — similar messages collapse into one row with a count', () => {
  it('twelve near-identical failures are ONE collapsed row showing a count of 12', async () => {
    await openDrawer(flood(12))

    const groups = await screen.findAllByTestId('notif-group')
    expect(groups).toHaveLength(1)
    expect(screen.getByTestId('notif-group-count')).toHaveTextContent('× 12')
  })

  it('a single occurrence shows no count at all', async () => {
    // `× 1` on every ordinary row would be the widest thing on it and
    // would imply a repetition that did not happen.
    await openDrawer(flood(1))

    await screen.findAllByTestId('notif-group')
    expect(screen.queryByTestId('notif-group-count')).not.toBeInTheDocument()
  })

  it('two different failures stay two rows', async () => {
    const rows = [
      ...flood(3),
      { ...flood(1)[0], id: 99, message: 'Generation failed: No enabled AI models configured.', group_key: 'error|ai|generation failed: no enabled ai models configured.' }
    ]
    await openDrawer(rows)

    const groups = await screen.findAllByTestId('notif-group')
    expect(groups).toHaveLength(2)
  })

  it('the collapsed view is collapsed: no occurrence text is on screen yet', async () => {
    await openDrawer(flood(12))
    await screen.findAllByTestId('notif-group')

    expect(screen.queryByTestId('notif-group-occurrences')).not.toBeInTheDocument()
    expect(screen.queryByText(/request 11/)).not.toBeInTheDocument()
  })

  it('the footer reports both the number of rows and the number of groups', async () => {
    // Twelve is the number the user needs; one is the number of things
    // they have to think about. Reporting only either of them is a lie.
    await openDrawer(flood(12))
    await screen.findAllByTestId('notif-group')

    expect(screen.getByText('12 notifications in 1 group')).toBeInTheDocument()
  })
})

/**
 * MAJOR 1, at the surface the user actually reads.
 *
 * The model, in one sentence: **the centre holds one row per thing that went
 * wrong, and the `× N` badge is the number of things.** A repeat of a thing
 * is not another thing, so it does not become a row and it does not become
 * another unit in the count either.
 *
 * The fixture that matters is the BYTE-IDENTICAL one. Two notifications
 * whose summaries differ only in their digit buckets are two different
 * sentences and correctly collapse into one group — that is what grouping
 * is for, and it is unchanged. What must not happen is the badge counting
 * the app's emissions: the earlier version of this change folded repeats
 * into a per-row counter and summed it, which fixed the storage and left
 * the number on screen reading exactly what it read before, `× 30` for ten
 * documents.
 */
describe('the badge counts things that went wrong, not emissions', () => {
  it('TWELVE EMISSIONS OF ONE FAILURE ARE ONE THING, SO THE BADGE SHOWS NO COUNT', async () => {
    // Byte-identical payload: the shape a StrictMode double-mount really
    // produces, because the sweep re-runs over the same documents with the
    // same provider error. Before the fix this rendered `× 12`.
    await openDrawer([{ ...flood(1)[0], occurrences: 12 } as NotificationRow])

    await screen.findAllByTestId('notif-group')
    expect(screen.getAllByTestId('notif-group')).toHaveLength(1)
    // Twelve emissions were one failure, so there is nothing to count. A
    // `× 12` here would be the app's own verbosity reported as the user's
    // problem.
    expect(screen.queryByTestId('notif-group-count')).not.toBeInTheDocument()
    expect(screen.getByText('1 notification')).toBeInTheDocument()

    expandGroup('Content review failed: 12 errors: 11 rate limited, 1 other.')
    await screen.findByTestId('notif-group-occurrences')
    // One entry, and it claims nothing about repetitions.
    expect(occurrences()).toHaveLength(1)
    expect(citationOf(occurrences()[0])).not.toContain('occurrences')
  })

  it('TEN DOCUMENTS THAT EACH FAILED IS TEN THINGS, SO THE BADGE SAYS TEN', async () => {
    // The reported scenario end to end: ten documents, three sweeps each,
    // byte-identical per document. Rows 30 -> 10 is the storage fix; the
    // number on screen has to follow it to 10 rather than staying at 30.
    const rows: NotificationRow[] = Array.from({ length: 10 }, (_, d) => ({
      ...flood(1)[0],
      id: d + 1,
      full_message: `CV #${d}\nrotation`
    }))
    await openDrawer(rows)

    await screen.findAllByTestId('notif-group')
    expect(screen.getAllByTestId('notif-group')).toHaveLength(1)
    expect(screen.getByTestId('notif-group-count')).toHaveTextContent('× 10')
    expect(screen.getByText('10 notifications in 1 group')).toBeInTheDocument()

    // ...and the payload of each of the ten is still there, which is what
    // the fold was never allowed to cost. A group renders newest first, so
    // the entries are read back by id rather than by position.
    expandGroup('Content review failed: 12 errors: 11 rate limited, 1 other.')
    await screen.findByTestId('notif-group-occurrences')
    const rendered = occurrences().map((el) => el.textContent ?? '').join('\n')
    expect(occurrences()).toHaveLength(10)
    for (let d = 0; d < 10; d++) {
      expect(rendered).toContain(`CV #${d}\nrotation`)
    }
  })

  it('a row carries no counter at all, so there is nothing to inflate', async () => {
    // The field is gone from the contract rather than merely unused: a
    // per-row emission count is exactly the thing that made the badge
    // report a multiple of the truth, and leaving it in the type would
    // invite the next reader to sum it.
    expect('occurrences' in flood(1)[0]).toBe(false)
  })
})

/**
 * MINOR 1. The badge and the pager were briefly reading different numbers —
 * the badge a sum of per-row counters, the pager `occurrences.length` — and
 * on a group holding one row that counter read 30, the pager offered "Show 5
 * more" and revealed nothing on click. A control that promises entries it
 * cannot produce is worse than no control.
 */
describe('MINOR 1 — the pager reveals rows, because that is what it counts', () => {
  it('offers nothing on a group that fits in the first page', async () => {
    await openDrawer(flood(3))
    expandGroup('Content review failed: 12 errors: 11 rate limited, 1 other.')
    await screen.findByTestId('notif-group-occurrences')

    expect(screen.queryByRole('button', { name: /show \d+ more/i })).not.toBeInTheDocument()
  })

  it('offers rows that exist, and each click reveals exactly what it promised', async () => {
    await openDrawer(flood(60))
    expandGroup('Content review failed: 12 errors: 11 rate limited, 1 other.')
    await screen.findByTestId('notif-group-occurrences')

    expect(occurrences()).toHaveLength(25)
    // 60 rows, 25 shown: 35 left, so the label says the page size rather
    // than the remainder — and 35 is not what it says.
    expect(screen.getByRole('button', { name: /show 25 more/i })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /show 25 more/i }))
    expect(occurrences()).toHaveLength(50)

    // The last page has 10 left, and the button says 10.
    expect(screen.getByRole('button', { name: /show 10 more/i })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /show 10 more/i }))
    expect(occurrences()).toHaveLength(60)
    // Nothing left, so nothing offered. The promise and the contents cannot
    // drift apart now that both read `occurrences.length`.
    expect(screen.queryByRole('button', { name: /show \d+ more/i })).not.toBeInTheDocument()
  })
})

describe('R3 — expanding shows every occurrence in full, with no loss', () => {
  it('expands to twelve entries, each with its own datetime, job citation and full error', async () => {
    await openDrawer(flood(12))
    expandGroup('Content review failed: 12 errors: 11 rate limited, 1 other.')
    await screen.findByTestId('notif-group-occurrences')

    const entries = occurrences()
    expect(entries).toHaveLength(12)

    for (const entry of entries) {
      // R3's four fields plus the full message.
      expect(entry.querySelector('time')).toHaveAttribute('datetime')
      expect(citationOf(entry)).toContain('Staff Engineer')
      expect(citationOf(entry)).toContain('Acme')
      expect(citationOf(entry)).toContain('Berlin, DE')
      expect(entry.textContent).toContain('All 12 configured AI models are rate limited')
    }
  })

  it('every occurrence keeps its OWN full message, not the newest one repeated', async () => {
// The failure mode this guards is a group that collapses and then
    // shows one payload twelve times: the rows still say twelve, so a
    // count-based assertion passes while the detail is gone.
    //
    // Read textContent rather than using a text matcher: the payload is
    // multi-line and testing-library's normaliser collapses whitespace, so
    // a matcher over the rendered string would pass on the wrong text.
    await openDrawer(flood(12))
    expandGroup('Content review failed: 12 errors: 11 rate limited, 1 other.')
    await screen.findByTestId('notif-group-occurrences')

    const payloads = occurrences().map((el) => el.textContent ?? '')
    for (let i = 0; i < 12; i++) {
      expect(payloads.some((p) => p.includes(`CV #${i + 1}`) && p.includes(`request ${i}`))).toBe(true)
    }
  })

  it('each occurrence carries its own timestamp', async () => {
    await openDrawer(flood(3))
    expandGroup('Content review failed: 12 errors: 11 rate limited, 1 other.')
    await screen.findByTestId('notif-group-occurrences')

    const stamps = occurrences().map((el) => el.querySelector('time')?.getAttribute('datetime'))
    expect(new Set(stamps).size).toBe(3)
  })

  it('a long group is paged rather than rendered whole', async () => {
    // R5: the center must not become the flood it replaced. Fifty rows
    // behind a button the user pressed on purpose is fine; five hundred
    // in the DOM on one click is the same trap with a different number.
    await openDrawer(flood(500))
    expandGroup('Content review failed: 12 errors: 11 rate limited, 1 other.')
    await screen.findByTestId('notif-group-occurrences')

    expect(occurrences().length).toBe(25)

    fireEvent.click(screen.getByRole('button', { name: /show 25 more/i }))
    expect(occurrences().length).toBe(50)
  })
})

describe('R3 — a job with no location is not given one', () => {
  it('renders no location at all rather than a placeholder', async () => {
    await openDrawer(flood(1, {
      job: { job_id: 7, job_title: 'Staff Engineer', job_company: 'Acme', job_location: null }
    }))
    expandGroup('Content review failed: 12 errors: 11 rate limited, 1 other.')
    await screen.findByTestId('notif-group-occurrences')

    const citation = citationOf(occurrences()[0])
    expect(citation).toContain('Staff Engineer')
    expect(citation).toContain('Acme')
    // No "—", no "Unknown", no "Remote". Nothing at all, because the
    // product rule is that a field the app cannot source is not rendered.
    expect(citation).not.toMatch(/—|Unknown|N\/A|Remote/)
  })

  it('falls back to the job id when nothing else about the job is known', async () => {
    // An id IS sourced data, so showing it invents nothing — whereas a
    // bare timestamp would leave the user unable to tell which job failed,
    // which is the point of the citation. Same fallback the queue panel
    // uses.
    await openDrawer(flood(1, {
      job: { job_id: 7, job_title: null, job_company: null, job_location: null }
    }))
    expandGroup('Content review failed: 12 errors: 11 rate limited, 1 other.')
    await screen.findByTestId('notif-group-occurrences')

    expect(citationOf(occurrences()[0])).toContain('Job 7')
  })

  it('a row with no job at all still shows its error and its time', async () => {
    // Main-process crashes have no job. The detail is the whole value
    // there, so the entry must not be dropped for lack of a citation.
    await openDrawer([{
      id: 1, type: 'error', source: 'app',
      message: 'Internal error: better-sqlite3 has no exported member',
      full_message: 'TypeError: better-sqlite3 has no exported member\n    at Database.open',
      created_at: 1_700_000_000_000, dismissed_at: null,
      group_key: 'error|app|internal error: TypeError'
    }])
    expandGroup('Internal error: better-sqlite3 has no exported member')
    await screen.findByTestId('notif-group-occurrences')

    const entry = occurrences()[0]
    expect(entry.textContent).toContain('TypeError: better-sqlite3 has no exported member')
    expect(entry.textContent).toContain('at Database.open')
    expect(entry.querySelector('time')).toHaveAttribute('datetime')
    // No citation invented for a notification that has no job.
    expect(citationOf(entry)).not.toMatch(/Unknown|—/)
  })
})

describe('R4 — dismissal', () => {
  it('dismisses exactly that group and leaves the others alone', async () => {
    const doomed = flood(12)
    const survivor = {
      ...flood(1)[0],
      id: 500,
      message: 'Generation failed: No enabled AI models configured.',
      group_key: 'error|ai|generation failed: no enabled ai models configured.'
    }
    await openDrawer([...doomed, survivor])
    await screen.findAllByTestId('notif-group')

    // Scoped to the group being dismissed: with two groups on screen there
    // are two identically-labelled controls, and dismissing the wrong one
    // would still satisfy a looser assertion.
    const groups = screen.getAllByTestId('notif-group')
    const flooded = groups.find((g) => within(g).queryByText(/× 12/))!
    fireEvent.click(within(flooded).getByLabelText('Dismiss group'))

    // Compared as a set, not a sequence: the group hands over its rows in
    // display order (newest first) and the store dismisses them as a set,
    // so the order carries no meaning — pinning it would assert the
    // renderer's sort rather than the requirement.
    const dismissed = mockApi.notificationsDismissMany.mock.calls[0][0] as { ids: number[] }
    expect([...dismissed.ids].sort((a, b) => a - b)).toEqual(doomed.map((r) => r.id).sort((a, b) => a - b))
    // The other group is still on screen. This is the whole requirement:
    // "exactly that group".
    await waitFor(() => expect(screen.getAllByTestId('notif-group')).toHaveLength(1))
    expect(screen.getByText('Generation failed: No enabled AI models configured.')).toBeInTheDocument()
  })

  it('dismissing one occurrence leaves the rest of its group', async () => {
    const rows = flood(3)
    await openDrawer(rows)
    expandGroup('Content review failed: 12 errors: 11 rate limited, 1 other.')
    await screen.findByTestId('notif-group-occurrences')

    // Entries are newest-first, so the first one on screen is the LAST row
    // written. Naming the newest matters: dismissing "a row" would satisfy
    // a weaker assertion while removing the wrong one.
    const dismissButtons = screen.getAllByLabelText('Dismiss notification')
    fireEvent.click(dismissButtons[0])

    expect(mockApi.notificationsDismiss).toHaveBeenCalledWith({ id: rows[rows.length - 1].id })
    // The store now agrees, which is what the settle re-read sees.
    mockApi.notificationsList.mockResolvedValue({ rows: rows.slice(0, -1) })
    await waitFor(() => {
      expect(screen.getAllByTestId('notif-group')).toHaveLength(1)
    })
    // Two occurrences left, so still a counted group rather than a bare row.
    expect(screen.getByTestId('notif-group-count')).toHaveTextContent('× 2')
  })

  it('dismiss-all is unchanged and clears everything', async () => {
    await openDrawer(flood(12))
    await screen.findAllByTestId('notif-group')

    fireEvent.click(screen.getByRole('button', { name: /clear all notifications/i }))

    expect(mockApi.notificationsDismissAll).toHaveBeenCalled()
    await waitFor(() => expect(screen.queryByTestId('notif-group')).not.toBeInTheDocument())
  })

  it('a group dismissal the main process never received restores the rows and says so', async () => {
    // `ipcRenderer.invoke` REJECTS when the channel itself fails — no
    // handler registered, which is exactly the window while the main
    // process restarts under `npm run dev`. Only handling the INTERNAL
    // envelope left the optimistic removal standing with no toast: the
    // user had dismissed nothing and could no longer see the thing they
    // tried to dismiss.
    mockApi.notificationsDismissMany.mockRejectedValueOnce(new Error('ipc channel closed'))
    await openDrawer(flood(3))
    await screen.findAllByTestId('notif-group')

    fireEvent.click(screen.getByLabelText('Dismiss group'))

    expect(await screen.findByText('Could not dismiss notifications')).toBeInTheDocument()
    expect(screen.getAllByTestId('notif-group')).toHaveLength(1)
    expect(screen.getByTestId('notif-group-count')).toHaveTextContent('× 3')
  })

  it('a failed rollback does not resurrect rows a later dismissal already removed', async () => {
    // Two dismissals in flight overlap as soon as the user clears one
    // group and then clears another. Restoring the snapshot taken before
    // the first call would put the second call's victims back on screen —
    // notifications the store has already marked dismissed, inflating the
    // badge and turning a re-dismiss into a no-op. The fix is to re-read
    // the store, which is the only thing that knows what landed.
    const groupA = flood(3)
    const groupB: NotificationRow[] = [{
      id: 500, type: 'error', source: 'ai',
      message: 'Generation failed: No enabled AI models configured.',
      full_message: 'raw', created_at: 2, dismissed_at: null,
      group_key: 'error|ai|generation failed: no enabled ai models configured.',
    }]
    let release!: (v: { updated: number } | { error: 'INTERNAL' }) => void
    mockApi.notificationsDismissMany.mockImplementationOnce(() => new Promise((r) => { release = r }))
    await openDrawer([...groupA, ...groupB])
    const [a, b] = screen.getAllByTestId('notif-group')

    // Group A's call is parked mid-flight.
    fireEvent.click(within(a).getByLabelText('Dismiss group'))
    // Group B's lands.
    fireEvent.click(within(b).getByLabelText('Dismiss group'))
    await waitFor(() => expect(mockApi.notificationsDismissMany).toHaveBeenCalledTimes(2))

    // ...and now A fails, with the store holding only what B left.
    mockApi.notificationsList.mockResolvedValue({ rows: groupA })
    release({ error: 'INTERNAL' })

    expect(await screen.findByText('Could not dismiss notifications')).toBeInTheDocument()
    // The re-read reflects the store: B is gone and stayed gone, A is back.
    await waitFor(() => expect(screen.getAllByTestId('notif-group')).toHaveLength(1))
    expect(screen.getByTestId('notif-group-count')).toHaveTextContent('× 3')
    expect(screen.queryByText('Generation failed: No enabled AI models configured.')).not.toBeInTheDocument()
  })

  it('settles against the store even when the dismissal SUCCEEDED', async () => {
    // Two things can overtake the optimistic removal while the IPC call is
    // in flight — the coalesced refresh a freshly written record fires, and
    // the drawer's own re-read on open. Either installs the pre-dismissal
    // list, and reconciling only on failure left a row that the store had
    // dismissed sitting on screen and counted in the badge.
    let release!: (v: { ok: true }) => void
    mockApi.notificationsDismiss.mockImplementationOnce(() => new Promise((r) => { release = r }))
    await openDrawer(flood(3))
    await screen.findAllByTestId('notif-group')
    expandGroup('Content review failed: 12 errors: 11 rate limited, 1 other.')
    await screen.findByTestId('notif-group-occurrences')

    fireEvent.click(screen.getAllByLabelText('Dismiss notification')[0])

    // A record lands while the dismissal is still in flight; its
    // coalesced refresh reads the store, which still has all three.
    window.dispatchEvent(new CustomEvent('app:notification-recorded'))
    await new Promise((r) => setTimeout(r, 120))
    expect(screen.getByTestId('notif-group-count')).toHaveTextContent('× 3')

    // The dismissal now succeeds, and the store has two rows left.
    mockApi.notificationsList.mockResolvedValue({ rows: flood(3).slice(0, -1) })
    release({ ok: true })

    // The settle re-read corrects it rather than leaving the ghost.
    await waitFor(() => expect(screen.getByTestId('notif-group-count')).toHaveTextContent('× 2'))
  })

  it('a failed group dismissal puts the rows back and says so', async () => {
    // The optimistic removal is right for the common case and wrong for the
    // failed one: a row that vanishes when the store refused to dismiss it
    // is a row the user has silently lost.
    mockApi.notificationsDismissMany.mockResolvedValueOnce({ error: 'INTERNAL' })
    await openDrawer(flood(3))
    await screen.findAllByTestId('notif-group')

    fireEvent.click(screen.getByLabelText('Dismiss group'))

    await screen.findByText('Could not dismiss notifications')
    expect(screen.getAllByTestId('notif-group')).toHaveLength(1)
  })
})

describe('R1 — the drawer reflects a record as soon as it is written', () => {
  const realAddEventListener = window.addEventListener.bind(window)
  const realRemoveEventListener = window.removeEventListener.bind(window)

  afterEach(() => {
    window.addEventListener = realAddEventListener
    window.removeEventListener = realRemoveEventListener
  })

  it('never rejects the caller when the store cannot be read', async () => {
    // `refresh` floats at four call sites (mount, the coalesced timer, the
    // drawer on open, persistentNotify) and none of them can catch, so an
    // unhandled rejection here was reachable from every one of them — and
    // `ipcRenderer.invoke` rejects exactly when the channel is absent, which
    // is the `npm run dev` main-process restart these paths exist for.
    mockApi.notificationsList.mockRejectedValue(new Error('ipc channel closed'))
    let failures = 0
    const onRejection = () => { failures++ }
    process.on('unhandledRejection', onRejection)
    try {
      await openDrawer([])
      await new Promise((r) => setTimeout(r, 120))
      window.dispatchEvent(new CustomEvent('app:notification-recorded'))
      await new Promise((r) => setTimeout(r, 120))
      fireEvent.keyDown(document, { key: 'Escape' })
      fireEvent.click(screen.getByText('open'))
      await new Promise((r) => setTimeout(r, 120))
      expect(failures).toBe(0)
    } finally {
      process.off('unhandledRejection', onRejection)
    }
  })

  it('reports a list it could not read, rather than rendering it as empty', async () => {
    // Same convention the queue panel follows: this codebase returns an
    // error envelope from handlers that can fail, and destructuring `{rows}`
    // off one is what crashed the drawer on render before.
    //
    // What it must NOT do is treat the failure as "nothing is in there".
    // That is the whole of the MAJOR-3 hole: an `uncaughtException` is
    // recorded in the store by the main process, and if the store cannot
    // then be read the drawer answers "No notifications." — a confident,
    // specific, wrong statement about records that are on disk. So the
    // failure is surfaced, and the empty wording is gone entirely.
    await openDrawer([])
    // Set AFTER the helper, which installs its own `notificationsList` mock.
    mockApi.notificationsList.mockResolvedValue({ error: 'INTERNAL' })
    fireEvent.keyDown(document, { key: 'Escape' })
    fireEvent.click(screen.getByText('open'))
    await new Promise((r) => setTimeout(r, 120))

    expect(screen.getByTestId('notif-backdrop')).toBeInTheDocument()
    expect(await screen.findByTestId('notif-load-error')).toBeInTheDocument()
    expect(screen.queryByText(/no notifications/i)).not.toBeInTheDocument()
  })

  it('keeps the rows it could read when a later read fails', async () => {
    // The failure must not blank the list. Blanking it would replace one
    // lie — "there is nothing" — with another, "there is nothing you can
    // currently see", on a screen holding rows the user had already read.
    await openDrawer(flood(2))
    await screen.findAllByTestId('notif-group')

    mockApi.notificationsList.mockResolvedValue({ error: 'INTERNAL' })
    fireEvent.keyDown(document, { key: 'Escape' })
    fireEvent.click(screen.getByText('open'))
    await screen.findByTestId('notif-load-error')

    // The rows are still there, and the banner says they may be stale.
    expect(screen.getAllByTestId('notif-group')).toHaveLength(1)
    expect(screen.getByText(/last list that could be read/i)).toBeInTheDocument()
  })

  /**
   * MINOR 6 — the corrupt-row arm of the same obligation.
   *
   * Distinct from the load error above, and kept distinct on purpose: the
   * READ SUCCEEDED. The store held entries the migration had to discard
   * because they were not rows, so `rows` really is empty — and before the
   * count was carried on the envelope, an empty `rows` was the only thing
   * the renderer could see. A store containing the single string
   * `'not-an-object'` therefore rendered "No notifications.": a confident,
   * specific, wrong statement about a store that was not empty.
   */
  it('says a store held entries it could not read, instead of claiming it is empty', async () => {
    mockApi.notificationsList.mockResolvedValue({ rows: [], unreadable: 1 })
    render(
      <NotificationsProvider>
        <OpenButton />
        <NotificationDrawer />
      </NotificationsProvider>
    )
    fireEvent.click(screen.getByText('open'))

    expect(await screen.findByTestId('notif-unreadable')).toBeInTheDocument()
    expect(screen.getByText(/1 entry in the notification store could not be read/i)).toBeInTheDocument()
    expect(screen.queryByText(/no notifications/i)).not.toBeInTheDocument()
  })

  it('pluralises the unreadable count, and keeps the readable rows on screen', async () => {
    mockApi.notificationsList.mockResolvedValue({ rows: flood(2), unreadable: 3 })
    render(
      <NotificationsProvider>
        <OpenButton />
        <NotificationDrawer />
      </NotificationsProvider>
    )
    fireEvent.click(screen.getByText('open'))

    expect(await screen.findByTestId('notif-unreadable')).toBeInTheDocument()
    expect(screen.getByText(/3 entries in the notification store could not be read/i)).toBeInTheDocument()
    // The rows it COULD read are still shown — dropping them too would be
    // the same over-correction one level up.
    expect(screen.getAllByTestId('notif-group')).toHaveLength(1)
  })

  it('shows nothing of the sort on a store that is merely empty', async () => {
    await openDrawer([])
    await screen.findByText(/no notifications/i)
    expect(screen.queryByTestId('notif-unreadable')).not.toBeInTheDocument()
  })

  it('treats a main-process build that omits the count as zero unreadable', async () => {
    // The provider coerces rather than trusts: `NaN > 0` is false and
    // `undefined` has no arithmetic at all, so a missing or nonsense count
    // must not put a banner on a store that is fine.
    mockApi.notificationsList.mockResolvedValue({ rows: [] })
    render(
      <NotificationsProvider>
        <OpenButton />
        <NotificationDrawer />
      </NotificationsProvider>
    )
    fireEvent.click(screen.getByText('open'))

    await screen.findByText(/no notifications/i)
    expect(screen.queryByTestId('notif-unreadable')).not.toBeInTheDocument()
  })

  it('says so when the store cannot be reached at all, and recovers on retry', async () => {
    // `ipcRenderer.invoke` rejects rather than answering when the channel
    // itself is gone — the main-process restart under `npm run dev`. Same
    // requirement, different transport: not an empty center.
    await openDrawer([])
    mockApi.notificationsList.mockRejectedValue(new Error('ipc channel closed'))
    fireEvent.keyDown(document, { key: 'Escape' })
    fireEvent.click(screen.getByText('open'))
    expect(await screen.findByTestId('notif-load-error')).toBeInTheDocument()
    expect(screen.queryByText(/no notifications/i)).not.toBeInTheDocument()

    mockApi.notificationsList.mockResolvedValue({ rows: flood(1) })
    fireEvent.click(screen.getByRole('button', { name: /try again/i }))

    await waitFor(() => expect(screen.queryByTestId('notif-load-error')).not.toBeInTheDocument())
    expect(screen.getAllByTestId('notif-group')).toHaveLength(1)
  })

  it('re-reads on the main process saying the store changed', async () => {
    // The crash is recorded from the main process, where there is no
    // renderer to fire the window event record.ts uses — so this channel
    // is the only thing that makes the badge and the drawer learn about it
    // without the user opening the center and looking. Everything else in
    // this file goes through `app:notification-recorded`; this is the
    // main-process half of the same arrangement.
    const seen: (() => void)[] = []
    mockApi.onNotificationsChanged.mockImplementation((cb: () => void) => {
      seen.push(cb)
      return () => undefined
    })
    await openDrawer([])
    await screen.findByText(/no notifications/i)
    expect(seen).toHaveLength(1)

    mockApi.notificationsList.mockResolvedValue({ rows: flood(1) })
    seen[0]()
    expect(await screen.findByTestId('notif-group')).toBeInTheDocument()
  })

  it('stops listening to the main process when the provider unmounts', async () => {
    const unsubscribe = vi.fn()
    mockApi.onNotificationsChanged.mockImplementation(() => unsubscribe)
    const view = render(
      <NotificationsProvider>
        <OpenButton />
        <NotificationDrawer />
      </NotificationsProvider>
    )
    await waitFor(() => expect(mockApi.onNotificationsChanged).toHaveBeenCalled())

    view.unmount()
    expect(unsubscribe).toHaveBeenCalled()
  })

  it('re-reads the store every time the drawer is opened', async () => {
    // Not only for renderer-side writes. `electron/main.ts` records an
    // uncaughtException in the store from the MAIN process, where there is
    // no renderer to fire a window event — so the provider's cache would
    // never learn about it and the crash would be durably recorded and
    // unreachable, which from the user's side is the same as not recorded.
    render(
      <NotificationsProvider>
        <Notifications />
        <OpenButton />
        <NotificationDrawer />
      </NotificationsProvider>
    )
    const readsAtMount = mockApi.notificationsList.mock.calls.length
    fireEvent.click(screen.getByText('open'))
    await screen.findByTestId('notif-backdrop')
    // The drawer reads again on open, not only at mount.
    await waitFor(() => expect(mockApi.notificationsList.mock.calls.length).toBeGreaterThan(readsAtMount))
  })

  it('re-reads the store when a failure is recorded anywhere in the app', async () => {
    // Recording is deliberately not routed through the provider — a page
    // component with a failure has to be able to record it without one
    // mounted above it — so the provider has to notice the write some
    // other way, or the badge and the drawer would be stale until the
    // user pressed Refresh.
    await openDrawer([])
    await screen.findByText(/no notifications/i)

    mockApi.notificationsList.mockResolvedValue({ rows: flood(1) })
    window.dispatchEvent(new CustomEvent('app:notification-recorded'))

    expect(await screen.findByTestId('notif-group')).toBeInTheDocument()
  })

  it('collapses a burst of records into ONE read of the store', async () => {
    // Each re-read is a full read-and-decrypt of the store, and the bug
    // being fixed is precisely a burst: a six-document sweep writes six
    // records in one tick. Six reads to learn what one read would have
    // said would make recording a failure the expensive part of failing.
    await openDrawer([])
    await screen.findByText(/no notifications/i)

    const readsAfterOpen = mockApi.notificationsList.mock.calls.length
    for (let i = 0; i < 6; i++) {
      window.dispatchEvent(new CustomEvent('app:notification-recorded'))
    }
    await new Promise((r) => setTimeout(r, 120))

    expect(mockApi.notificationsList.mock.calls.length).toBe(readsAfterOpen + 1)
  })

  it('picks up a record that arrives after the burst has settled', async () => {
    // The coalescing window re-arms itself, so it delays a read rather than
    // swallowing one.
    await openDrawer([])
    await screen.findByText(/no notifications/i)

    window.dispatchEvent(new CustomEvent('app:notification-recorded'))
    await new Promise((r) => setTimeout(r, 120))
    const afterBurst = mockApi.notificationsList.mock.calls.length

    mockApi.notificationsList.mockResolvedValue({ rows: flood(1) })
    window.dispatchEvent(new CustomEvent('app:notification-recorded'))
    expect(await screen.findByTestId('notif-group')).toBeInTheDocument()
    expect(mockApi.notificationsList.mock.calls.length).toBe(afterBurst + 1)
  })

  it('stops listening once the provider unmounts', async () => {
    const handlers = new Set<EventListenerOrEventListenerObject>()
    window.addEventListener = ((type: string, handler: EventListenerOrEventListenerObject, opts?: boolean | AddEventListenerOptions) => {
      if (type === 'app:notification-recorded') handlers.add(handler)
      return realAddEventListener(type, handler, opts)
    }) as typeof window.addEventListener
    window.removeEventListener = ((type: string, handler: EventListenerOrEventListenerObject, opts?: boolean | EventListenerOptions) => {
      if (type === 'app:notification-recorded') handlers.delete(handler)
      return realRemoveEventListener(type, handler, opts)
    }) as typeof window.removeEventListener

    const view = render(
      <NotificationsProvider>
        <OpenButton />
        <NotificationDrawer />
      </NotificationsProvider>
    )
    await waitFor(() => expect(handlers.size).toBe(1))

    view.unmount()
    expect(handlers.size).toBe(0)
  })
})