import { useEffect, useState } from 'react'
import { api } from '../api'
import type { Page } from '../types'

interface Props {
  current: Page
  onNavigate: (page: Page) => void
}

const NAV_ITEMS: { id: Page; label: string; icon: string }[] = [
  { id: 'dashboard', label: 'Dashboard', icon: '◉' },
  { id: 'scanjobs', label: 'Scan Jobs', icon: '⟐' },
  { id: 'jobs', label: 'Job Board', icon: '◎' },
  { id: 'pipeline', label: 'Pipeline', icon: '▤' },
  { id: 'documents', label: 'Documents', icon: '▣' },
  { id: 'followups', label: 'Follow-ups', icon: '↻' },
  { id: 'interviews', label: 'Interviews', icon: '◷' },
  { id: 'settings', label: 'Settings', icon: '⚙' }
]

export default function Sidebar({ current, onNavigate }: Props) {
  const [scanning, setScanning] = useState(false)

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

  return (
    <aside className="sidebar">
      <div className="sidebar-logo">
        Apply<span>Assistant</span>
      </div>
      <nav>
        {NAV_ITEMS.map((item) => (
          <button
            key={item.id}
            className={`nav-item ${current === item.id ? 'active' : ''}`}
            onClick={() => onNavigate(item.id)}
          >
            <span>{item.icon}</span>
            {item.label}
          </button>
        ))}
      </nav>
      {scanning && (
        <div
          className="sidebar-scan-indicator"
          title="A job scan is currently running"
          onClick={() => onNavigate('scanjobs')}
        >
          <span className="scan-pulse" />
          Scanning…
        </div>
      )}
    </aside>
  )
}
