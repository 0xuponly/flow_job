import type { Page } from '../types'

interface Props {
  current: Page
  onNavigate: (page: Page) => void
}

const NAV_ITEMS: { id: Page; label: string; icon: string }[] = [
  { id: 'dashboard', label: 'Dashboard', icon: '◉' },
  { id: 'jobs', label: 'Job Board', icon: '◎' },
  { id: 'pipeline', label: 'Pipeline', icon: '▤' },
  { id: 'documents', label: 'Documents', icon: '▣' },
  { id: 'followups', label: 'Follow-ups', icon: '↻' },
  { id: 'interviews', label: 'Interviews', icon: '◷' },
  { id: 'settings', label: 'Settings', icon: '⚙' }
]

export default function Sidebar({ current, onNavigate }: Props) {
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
    </aside>
  )
}
