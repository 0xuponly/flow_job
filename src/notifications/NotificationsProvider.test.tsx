import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, act, renderHook } from '@testing-library/react'
import { NotificationsProvider, useNotifications } from './NotificationsProvider'

const mockApi = {
  notificationsList: vi.fn(),
  notificationsAdd: vi.fn(),
  notificationsDismiss: vi.fn(),
  notificationsDismissAll: vi.fn(),
  notificationsPurgeOldDismissed: vi.fn(),
  onNotificationsChanged: vi.fn(() => () => undefined),
}

beforeEach(() => {
  vi.clearAllMocks()
  mockApi.notificationsList.mockResolvedValue({ rows: [] })
  mockApi.notificationsPurgeOldDismissed.mockResolvedValue({ deleted: 0 })
  mockApi.notificationsAdd.mockResolvedValue({ id: 1 })
  mockApi.notificationsDismiss.mockResolvedValue({ ok: true })
  mockApi.notificationsDismissAll.mockResolvedValue({ updated: 0 })
  // @ts-expect-error - test mock: attach `api` to the existing jsdom window
  // (replacing globalThis.window entirely breaks React's getActiveElementDeep
  // because win.HTMLIFrameElement becomes undefined on the new window).
  globalThis.window.api = mockApi
})

describe('NotificationsProvider', () => {
  it('fetches the list and runs the purge on mount', async () => {
    render(<NotificationsProvider><div /></NotificationsProvider>)
    await act(async () => { /* microtask drain */ })
    expect(mockApi.notificationsList).toHaveBeenCalled()
    expect(mockApi.notificationsPurgeOldDismissed).toHaveBeenCalled()
  })

  it('hasUnread is true when the list is non-empty', async () => {
    mockApi.notificationsList.mockResolvedValue({ rows: [{ id: 1, type: 'info', source: 'app', message: 'm', full_message: 'm', created_at: 1, dismissed_at: null }] })
    const { result } = renderHook(() => useNotifications(), { wrapper: NotificationsProvider })
    await act(async () => { await Promise.resolve() })
    expect(result.current.hasUnread).toBe(true)
  })

  it('persistentNotify calls add then refreshes the list', async () => {
    const { result } = renderHook(() => useNotifications(), { wrapper: NotificationsProvider })
    await act(async () => { await Promise.resolve() })
    await act(async () => {
      await result.current.persistentNotify({ type: 'info', message: 'm', full_message: 'm' })
    })
    expect(mockApi.notificationsAdd).toHaveBeenCalledWith({ type: 'info', message: 'm', full_message: 'm' })
    // list called at least twice: mount + after add
    expect(mockApi.notificationsList.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('dismiss optimistically removes the row, restores on failure', async () => {
    mockApi.notificationsList.mockResolvedValue({ rows: [
      { id: 1, type: 'info', source: 'app', message: 'a', full_message: 'a', created_at: 1, dismissed_at: null },
      { id: 2, type: 'info', source: 'app', message: 'b', full_message: 'b', created_at: 2, dismissed_at: null },
    ]})
    mockApi.notificationsDismiss.mockResolvedValueOnce({ error: 'INTERNAL' })
    const { result } = renderHook(() => useNotifications(), { wrapper: NotificationsProvider })
    await act(async () => { await Promise.resolve() })
    expect(result.current.list).toHaveLength(2)
    await act(async () => { await result.current.dismiss(1) })
    // rollback: list restored to 2
    expect(result.current.list).toHaveLength(2)
  })

  it('dismissAll optimistically clears, reloads on failure', async () => {
    mockApi.notificationsList.mockResolvedValue({ rows: [
      { id: 1, type: 'info', source: 'app', message: 'a', full_message: 'a', created_at: 1, dismissed_at: null },
    ]})
    mockApi.notificationsDismissAll.mockResolvedValueOnce({ error: 'INTERNAL' })
    const { result } = renderHook(() => useNotifications(), { wrapper: NotificationsProvider })
    await act(async () => { await Promise.resolve() })
    expect(result.current.list).toHaveLength(1)
    await act(async () => { await result.current.dismissAll() })
    // rollback: list reloaded
    expect(result.current.list).toHaveLength(1)
  })
})

/**
 * A read that failed is not a centre with nothing in it.
 *
 * `loadStore` genuinely throws — on a store whose encryption key was
 * regenerated, for instance, and it refuses to fall back to an empty store
 * so it does not silently wipe the user's data. So the list channel is
 * reachable in a state where it cannot answer, and before this the provider
 * swallowed that quietly: `list` stayed at whatever it was, which at mount
 * is `[]`, and the drawer rendered its empty state over records that were
 * on disk. A crash recorded by the main process while no renderer was
 * listening is exactly the record that went missing that way.
 */
describe('a failed read is reported, not rendered as an empty centre', () => {
  it('exposes the failure when the channel answers with an error envelope', async () => {
    mockApi.notificationsList.mockResolvedValue({ error: 'INTERNAL' })
    const { result } = renderHook(() => useNotifications(), { wrapper: NotificationsProvider })
    await act(async () => { await Promise.resolve() })

    expect(result.current.loadError).toBeTruthy()
    expect(result.current.hasUnread).toBe(false)
  })

  it('exposes the failure when the channel rejects outright', async () => {
    mockApi.notificationsList.mockRejectedValue(new Error('ipc channel closed'))
    const { result } = renderHook(() => useNotifications(), { wrapper: NotificationsProvider })
    await act(async () => { await Promise.resolve() })

    expect(result.current.loadError).toBeTruthy()
  })

  it('keeps the rows it last managed to read', async () => {
    mockApi.notificationsList.mockResolvedValue({ rows: [
      { id: 1, type: 'info', source: 'app', message: 'a', full_message: 'a', created_at: 1, dismissed_at: null },
    ]})
    const { result } = renderHook(() => useNotifications(), { wrapper: NotificationsProvider })
    await act(async () => { await Promise.resolve() })
    expect(result.current.loadError).toBeNull()

    mockApi.notificationsList.mockResolvedValue({ error: 'INTERNAL' })
    await act(async () => { await result.current.refresh() })

    // Blanking the list would replace one lie — "there is nothing" — with
    // another on a screen holding rows the user had already read.
    expect(result.current.list).toHaveLength(1)
    expect(result.current.loadError).toBeTruthy()
  })

  it('clears the failure once a read succeeds again', async () => {
    mockApi.notificationsList.mockResolvedValue({ error: 'INTERNAL' })
    const { result } = renderHook(() => useNotifications(), { wrapper: NotificationsProvider })
    await act(async () => { await Promise.resolve() })
    expect(result.current.loadError).toBeTruthy()

    mockApi.notificationsList.mockResolvedValue({ rows: [] })
    await act(async () => { await result.current.refresh() })

    // An empty list that was actually read is a different answer from a
    // failed read, and the banner has to go away.
    expect(result.current.loadError).toBeNull()
  })
})
