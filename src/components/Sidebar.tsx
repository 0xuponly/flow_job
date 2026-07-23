import { useEffect, useState } from 'react'
import { api } from '../api'
import type { Page } from '../types'
import { usePersistedState } from '../persistedState'
import RefreshIcon from './RefreshIcon'
import ThemeToggle from '../theme/ThemeToggle'
import Tooltip from './Tooltip'
import { useNotifications } from '../notifications/NotificationsProvider'
import BellIcon from '../notifications/BellIcon'

interface Props {
  current: Page
  onNavigate: (page: Page) => void
}

const NAV_ITEMS: { id: Page; label: string; icon: string }[] = [
  { id: 'dashboard', label: 'Dashboard', icon: '◉' },
  { id: 'scanjobs', label: 'Scan Jobs', icon: '⟐' },
  { id: 'jobs', label: 'My Jobs', icon: '◎' },
  { id: 'queue', label: 'Apply Queue', icon: '✉' },
  { id: 'pipeline', label: 'Pipeline', icon: '▤' },
  { id: 'documents', label: 'Documents', icon: '▣' },
  { id: 'followups', label: 'Follow-ups', icon: '↻' },
  { id: 'interviews', label: 'Interviews', icon: '◷' },
  { id: 'settings', label: 'Settings', icon: '⚙' }
]

export default function Sidebar({ current, onNavigate }: Props) {
  const [scanning, setScanning] = useState(false)
  // Module-scope count of in-flight recomputeFit calls. The JobDetail
  // page dispatches `app:fit-progress` events with delta ±1 on click /
  // resolution. Multiple concurrent clicks stack — the indicator stays
  // visible until the count returns to zero.
  const [fitPending, setFitPending] = useState(0)
  const { open, hasUnread } = useNotifications()
  const [collapsed, setCollapsed] = usePersistedState<boolean>('sidebarCollapsed', false)

  useEffect(() => {
    let mounted = true
    const check = () => {
      api.getScanStatus().then((s) => {
        if (mounted) setScanning(!!s.scanning)
      }).catch(() => {})
    }
    check()
    const interval = setInterval(check, 3000)
    return () => {
      mounted = false
      clearInterval(interval)
    }
  }, [])

  useEffect(() => {
    const onFitProgress = (e: Event) => {
      const detail = (e as CustomEvent<{ delta: number }>).detail
      if (!detail || typeof detail.delta !== 'number') return
      setFitPending((n) => Math.max(0, n + detail.delta))
    }
    window.addEventListener('app:fit-progress', onFitProgress)
    return () => window.removeEventListener('app:fit-progress', onFitProgress)
  }, [])

  return (
    <aside className={`sidebar${collapsed ? ' sidebar--collapsed' : ''}`}>
      <div className="sidebar-logo">
        {collapsed ? (
          <>
            F<span>J</span>
          </>
        ) : (
          <>
            Flow<span>Job</span>
          </>
        )}
      </div>
      <nav>
        {NAV_ITEMS.map((item) => (
          <Tooltip key={item.id} label={item.label} disabled={!collapsed}>
            <button
              className={`nav-item ${current === item.id ? 'active' : ''}`}
              onClick={() => onNavigate(item.id)}
            >
              <span>{item.icon}</span>
              <span className="nav-label">{item.label}</span>
            </button>
          </Tooltip>
        ))}
      </nav>
      {scanning && (
        <Tooltip label="A job scan is currently running" disabled={!collapsed}>
          <div
            className="sidebar-scan-indicator"
            onClick={() => onNavigate('scanjobs')}
          >
            <span className="scan-pulse" />
            Scanning…
          </div>
        </Tooltip>
      )}
      {fitPending > 0 && (
        <Tooltip label={`${fitPending} fit recompute${fitPending === 1 ? '' : 's'} in progress`} disabled={!collapsed}>
          <div
            className="sidebar-scan-indicator"
            onClick={() => onNavigate('jobs')}
          >
            <span className="scan-pulse" />
            Calculating Fit…
          </div>
        </Tooltip>
      )}
      <div className="sidebar-bottom-actions">
        <Tooltip label="Notification center">
          <button
            type="button"
            className="sidebar-action"
            aria-label="Open notification center"
            onClick={open}
          >
            <BellIcon size={16} badge={hasUnread} />
          </button>
        </Tooltip>
        <ThemeToggle className="sidebar-action" />
        <Tooltip label="Refresh current page">
          <button
            className="sidebar-action"
            aria-label="Refresh current page"
            onClick={() => window.dispatchEvent(new CustomEvent('app:refresh'))}
          >
            <RefreshIcon size={16} />
          </button>
        </Tooltip>
        <Tooltip label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
          <button
            className="sidebar-action"
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            onClick={() => setCollapsed((v) => !v)}
          >
            {collapsed ? (
              <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M9 6l6 6-6 6" />
              </svg>
            ) : (
              <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M15 6l-6 6 6 6" />
              </svg>
            )}
          </button>
        </Tooltip>
      </div>
    </aside>
  )
}
