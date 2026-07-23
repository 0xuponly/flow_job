import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { ThemeProvider } from '../theme/ThemeProvider'
import { NotificationsProvider } from '../notifications/NotificationsProvider'
import Sidebar from './Sidebar'

const mockApi = {
  notificationsList: vi.fn(),
  notificationsAdd: vi.fn(),
  notificationsDismiss: vi.fn(),
  notificationsDismissAll: vi.fn(),
  notificationsPurgeOldDismissed: vi.fn(),
  getScanStatus: vi.fn(),
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
  mockApi.getScanStatus.mockResolvedValue({ scanning: false })
  // @ts-expect-error - test mock
  globalThis.window.api = mockApi
  localStorage.clear()
  document.documentElement.removeAttribute('data-theme')
})

describe('Sidebar bottom-actions order', () => {
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
        { id: 1, type: 'info', source: 'app', message: 'm', full_message: 'm', created_at: 1, dismissed_at: null },
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
