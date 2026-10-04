import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, within, fireEvent } from '@testing-library/react'
import { ThemeProvider } from '../theme/ThemeProvider'
import { NotificationsProvider } from '../notifications/NotificationsProvider'
import { OPEN_NOTIFICATION_CENTER_EVENT } from '../notifications/record'
import NotificationDrawer from '../notifications/NotificationDrawer'
import Sidebar from './Sidebar'

const mockApi = {
  notificationsList: vi.fn(),
  notificationsAdd: vi.fn(),
  notificationsDismiss: vi.fn(),
  notificationsDismissMany: vi.fn(),
  notificationsDismissAll: vi.fn(),
  notificationsPurgeOldDismissed: vi.fn(),
  onNotificationsChanged: vi.fn(() => () => undefined),
  getScanStatus: vi.fn(),
  openQuickAddWindow: vi.fn(),
}

function renderSidebar(props: Partial<React.ComponentProps<typeof Sidebar>> = {}) {
  return render(
    <ThemeProvider>
      <NotificationsProvider>
        <Sidebar
          current="dashboard"
          onNavigate={() => {}}
          {...props}
        />
      </NotificationsProvider>
    </ThemeProvider>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mockApi.notificationsList.mockResolvedValue({ rows: [] })
  mockApi.notificationsPurgeOldDismissed.mockResolvedValue({ deleted: 0 })
  mockApi.notificationsDismissMany.mockResolvedValue({ updated: 0 })
  mockApi.getScanStatus.mockResolvedValue({ scanning: false })
  // @ts-expect-error - test mock
  globalThis.window.api = mockApi
  localStorage.clear()
  document.documentElement.removeAttribute('data-theme')
})

describe('Sidebar bottom-actions order', () => {
  it('renders the quick-add URL button directly above the notification button', () => {
    renderSidebar()
    const bottom = document.querySelector('.sidebar-bottom-actions')
    expect(bottom).toBeTruthy()
    const buttons = within(bottom as HTMLElement).getAllByRole('button')
    const labels = buttons.map((b) => b.getAttribute('aria-label') || b.getAttribute('title') || '')
    const quickIdx = labels.findIndex((l) => /add job by url/i.test(l))
    const bellIdx = labels.findIndex((l) => /notification center/i.test(l))
    expect(quickIdx).toBeGreaterThanOrEqual(0)
    expect(bellIdx).toBeGreaterThanOrEqual(0)
    expect(quickIdx).toBeLessThan(bellIdx)
  })

  it('clicking the quick-add URL button calls openQuickAddWindow', () => {
    renderSidebar()
    const btn = screen.getByRole('button', { name: /add job by url/i })
    fireEvent.click(btn)
    expect(mockApi.openQuickAddWindow).toHaveBeenCalled()
  })

  it('renders the bell button above the theme toggle', () => {
    renderSidebar()
    const bottom = document.querySelector('.sidebar-bottom-actions')
    expect(bottom).toBeTruthy()
    const buttons = within(bottom as HTMLElement).getAllByRole('button')
    const labels = buttons.map((b) => b.getAttribute('aria-label') || b.getAttribute('title') || '')
    const bellIdx = labels.findIndex((l) => /notification center/i.test(l))
    const themeIdx = labels.findIndex((l) => /switch to .* theme/i.test(l))
    expect(bellIdx).toBeGreaterThanOrEqual(0)
    expect(themeIdx).toBeGreaterThanOrEqual(0)
    expect(bellIdx).toBeLessThan(themeIdx)
  })

  it('renders the theme toggle above the refresh button', () => {
    // Regression for c939a4d: theme toggle must stay above the refresh button.
    renderSidebar()
    const bottom = document.querySelector('.sidebar-bottom-actions')
    expect(bottom).toBeTruthy()
    const buttons = within(bottom as HTMLElement).getAllByRole('button')
    const labels = buttons.map((b) => b.getAttribute('aria-label') || b.getAttribute('title') || '')
    const themeIdx = labels.findIndex((l) => /switch to .* theme/i.test(l))
    const refreshIdx = labels.findIndex((l) => /refresh current page/i.test(l))
    expect(themeIdx).toBeGreaterThanOrEqual(0)
    expect(refreshIdx).toBeGreaterThanOrEqual(0)
    expect(themeIdx).toBeLessThan(refreshIdx)
  })

  it('bell shows the red-dot badge when hasUnread is true', async () => {
    mockApi.notificationsList.mockResolvedValue({
      rows: [
        {
          id: 1, type: 'info', source: 'app', message: 'm', full_message: 'm',
          created_at: 1, dismissed_at: null, group_key: 'info|app|m',
        },
      ],
    })
    renderSidebar()
    // After mount the provider's list has 1 row → hasUnread = true → BellIcon's
    // dot span is in the DOM (it's the only aria-hidden child positioned
    // absolutely inside the bell button's span).
    const bellBtn = await screen.findByRole('button', { name: /notification center/i })
    const dot = bellBtn.querySelector('span > span[aria-hidden="true"]')
    expect(dot).toBeTruthy()
  })
})

/**
 * The drawer opens from a toast's "View" button, and the toast is raised
 * deep inside a page with no route to `open()` — so Sidebar, which owns
 * the only `open` in the tree, listens for a request on the window. This
 * is the other half of that path; the half that raises the toast is
 * src/toastFlood.test.tsx.
 */
describe('the sidebar honours a request to open the notification center', () => {
  it('opens the drawer when a toast asks it to', async () => {
    mockApi.notificationsList.mockResolvedValue({
      rows: [{
        id: 1, type: 'error', source: 'ai',
        message: 'Content review failed on 3 of 3 documents.',
        full_message: 'raw', created_at: 1, dismissed_at: null,
        group_key: 'error|ai|content review failed on # of # documents.',
      }],
    })
    const { unmount } = render(
      <ThemeProvider>
        <NotificationsProvider>
          <Sidebar current="dashboard" onNavigate={() => {}} />
          <NotificationDrawer />
        </NotificationsProvider>
      </ThemeProvider>
    )

    // Not open yet: nothing has asked.
    expect(screen.queryByTestId('notif-backdrop')).not.toBeInTheDocument()

    window.dispatchEvent(new CustomEvent(OPEN_NOTIFICATION_CENTER_EVENT))

    expect(await screen.findByTestId('notif-backdrop')).toBeInTheDocument()
    unmount()
  })

  it('stops listening when the sidebar unmounts', async () => {
    const handlers = new Set<EventListenerOrEventListenerObject>()
    const realAdd = window.addEventListener.bind(window)
    const realRemove = window.removeEventListener.bind(window)
    vi.spyOn(window, 'addEventListener').mockImplementation((type, handler, opts) => {
      if (type === OPEN_NOTIFICATION_CENTER_EVENT) handlers.add(handler)
      return realAdd(type, handler, opts)
    })
    vi.spyOn(window, 'removeEventListener').mockImplementation((type, handler, opts) => {
      if (type === OPEN_NOTIFICATION_CENTER_EVENT) handlers.delete(handler)
      return realRemove(type, handler, opts)
    })
    try {
      const { unmount } = renderSidebar()
      await screen.findByRole('button', { name: /notification center/i })
      expect(handlers.size).toBe(1)

      unmount()
      expect(handlers.size).toBe(0)
    } finally {
      vi.restoreAllMocks()
    }
  })
})
