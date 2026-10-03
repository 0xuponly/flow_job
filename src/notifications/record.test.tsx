/**
 * The recorder, and the rule that decides whether a toast is recorded.
 *
 * The claim under test is the one the whole change rests on: a record is
 * written independently of the toast, so the toast overlay's duplicate
 * suppression cannot cost the center an entry. `notify` collapses a
 * repeated sentence while the previous copy is on screen — that is
 * correct for an overlay, and if the record went through it the second
 * failure would be gone from every user-visible surface.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import Notifications from '../components/Notifications'
import { notify } from '../components/Notifications'
import { recordNotification, reportFailure, jobContext, NOTIFICATION_RECORDED_EVENT, OPEN_NOTIFICATION_CENTER_EVENT, openNotificationCenter } from './record'
import { render, act } from '@testing-library/react'

const mockApi = { notificationsAdd: vi.fn(), notificationsList: vi.fn() }

beforeEach(() => {
  vi.clearAllMocks()
  mockApi.notificationsAdd.mockResolvedValue({ id: 1 })
  // @ts-expect-error - test mock
  globalThis.window.api = mockApi
})

/** Every row handed to the store, in order. */
function added(): Record<string, unknown>[] {
  return mockApi.notificationsAdd.mock.calls.map((c) => c[0] as Record<string, unknown>)
}

function visibleToasts(): string[] {
  return Array.from(document.body.querySelectorAll('[data-testid="toast-message"]')).map(
    (el) => el.textContent ?? ''
  )
}

describe('the record does not depend on the toast surviving', () => {
  it('records every failure even when the toast overlay drops it as a duplicate', async () => {
    render(<Notifications />)

    // Same sentence three times, inside the first toast's TTL. The overlay
    // is right to show one of them; the center has to have three.
    for (let i = 0; i < 3; i++) {
      reportFailure({ source: 'ai', message: 'Generation failed: 12 errors: 12 rate limited.', fullMessage: `rotation ${i}` })
      await act(async () => { await Promise.resolve() })
    }

    expect(visibleToasts()).toHaveLength(1)
    expect(added()).toHaveLength(3)
    expect(added().map((r) => r.full_message)).toEqual(['rotation 0', 'rotation 1', 'rotation 2'])
  })

  it('records even when nothing is mounted to show a toast at all', async () => {
    // The quick-add window and any pre-provider page have no toast host,
    // and `notify` drops the message entirely when nothing is listening.
    // Recording must not share that fate.
    reportFailure({ source: 'ai', message: 'Generation failed', fullMessage: 'raw' })
    await act(async () => { await Promise.resolve() })

    expect(visibleToasts()).toHaveLength(0)
    expect(added()).toHaveLength(1)
  })
})

describe('reportFailure', () => {
  it('defaults the full message to the summary when there is nothing more to say', async () => {
    reportFailure({ source: 'app', message: 'Backup complete.' })
    await act(async () => { await Promise.resolve() })

    expect(added()[0]).toMatchObject({
      type: 'error',
      source: 'app',
      message: 'Backup complete.',
      full_message: 'Backup complete.'
    })
  })

  it('carries a type through when the caller has one', async () => {
    reportFailure({ source: 'app', message: 'Deleted 3 of 5 jobs.', type: 'warning' })
    await act(async () => { await Promise.resolve() })

    expect(added()[0].type).toBe('warning')
  })

  it('omits the group key and the job when there is nothing to say about them', async () => {
    reportFailure({ source: 'app', message: 'Backup complete.' })
    await act(async () => { await Promise.resolve() })

    // Sent as absent rather than as empty values, so a row is never
    // written with a blank key that would group with other blank keys.
    expect(added()[0]).not.toHaveProperty('group_key')
    expect(added()[0]).not.toHaveProperty('job')
  })
})

describe('a failed write is not a second failure', () => {
  it('swallows a rejected add', async () => {
    mockApi.notificationsAdd.mockRejectedValue(new Error('ipc down'))
    await expect(
      recordNotification({ type: 'error', source: 'ai', message: 'm', fullMessage: 'f' })
    ).resolves.toBeUndefined()
  })

  it('swallows the INTERNAL sentinel, and announces nothing', async () => {
    mockApi.notificationsAdd.mockResolvedValue({ error: 'INTERNAL' })
    let announced = 0
    const onRecorded = () => { announced++ }
    window.addEventListener(NOTIFICATION_RECORDED_EVENT, onRecorded)
    try {
      await recordNotification({ type: 'error', source: 'ai', message: 'm', fullMessage: 'f' })
      // Nothing was written, so nothing may claim to have been.
      expect(announced).toBe(0)
    } finally {
      window.removeEventListener(NOTIFICATION_RECORDED_EVENT, onRecorded)
    }
  })

  it('announces the write so an open provider can re-read', async () => {
    let announced = 0
    const onRecorded = () => { announced++ }
    window.addEventListener(NOTIFICATION_RECORDED_EVENT, onRecorded)
    try {
      await recordNotification({ type: 'error', source: 'ai', message: 'm', fullMessage: 'f' })
      expect(announced).toBe(1)
    } finally {
      window.removeEventListener(NOTIFICATION_RECORDED_EVENT, onRecorded)
    }
  })
})

describe('jobContext', () => {
  it('keeps what it has and nulls what it does not', () => {
    expect(jobContext({ id: 7, title: 'Staff Engineer', company: 'Acme', location: null })).toEqual({
      job_id: 7,
      job_title: 'Staff Engineer',
      job_company: 'Acme',
      job_location: null
    })
  })

  it('treats blank and whitespace as absent rather than as a value', () => {
    // What `job.location ?? ''` produces for a job with no location.
    expect(jobContext({ id: 7, title: '  ', company: 'Acme', location: '' })).toEqual({
      job_id: 7,
      job_title: null,
      job_company: 'Acme',
      job_location: null
    })
  })

  it('returns nothing at all when there is nothing to cite', () => {
    // A bare id IS citable — the drawer falls back to `Job <id>` — so the
    // only way to get nothing is to have nothing.
    expect(jobContext({ id: undefined, title: '', company: '  ', location: null })).toBeUndefined()
    expect(jobContext({})).toBeUndefined()
    expect(jobContext(undefined)).toBeUndefined()
    expect(jobContext(null)).toBeUndefined()
  })

  it('accepts a company and a role with no id at all', () => {
    expect(jobContext({ title: 'Recruiter', company: 'Acme' })).toEqual({
      job_id: null,
      job_title: 'Recruiter',
      job_company: 'Acme',
      job_location: null
    })
  })

  it('treats a non-numeric id as no id rather than storing it', () => {
    expect(jobContext({ id: Number.NaN, title: 'Recruiter' })?.job_id).toBeNull()
  })
})

describe('openNotificationCenter', () => {
  it('asks the tree to open the drawer', () => {
    let opened = 0
    const onOpen = () => { opened++ }
    window.addEventListener(OPEN_NOTIFICATION_CENTER_EVENT, onOpen)
    try {
      openNotificationCenter()
      expect(opened).toBe(1)
    } finally {
      window.removeEventListener(OPEN_NOTIFICATION_CENTER_EVENT, onOpen)
    }
  })
})

describe('the toast dedupe itself is left alone', () => {
  it('still collapses a repeated sentence for the overlay', () => {
    // The brief's constraint: do not weaken the existing suppression. It
    // is correct for a glanceable overlay, and the recorder is what keeps
    // it from costing information.
    render(<Notifications />)
    act(() => { notify('Could not update the queue', 'error') })
    act(() => { notify('Could not update the queue', 'error') })
    expect(visibleToasts()).toEqual(['Could not update the queue'])
  })
})