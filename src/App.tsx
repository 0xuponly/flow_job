import { useState } from 'react'
import Sidebar from './components/Sidebar'
import Notifications from './components/Notifications'
import ErrorBoundary from './components/ErrorBoundary'
import NotificationDrawer from './notifications/NotificationDrawer'
import type { Page } from './types'

const pageComponents = {
  dashboard: React.lazy(() => import('./pages/Dashboard')),
  scanjobs: React.lazy(() => import('./pages/ScanJobsPage')),
  jobs: React.lazy(() => import('./pages/JobsPage')),
  queue: React.lazy(() => import('./pages/ApplyQueuePage')),
  pipeline: React.lazy(() => import('./pages/PipelinePage')),
  documents: React.lazy(() => import('./pages/DocumentsPage')),
  followups: React.lazy(() => import('./pages/FollowUpsPage')),
  interviews: React.lazy(() => import('./pages/InterviewsPage')),
  settings: React.lazy(() => import('./pages/SettingsPage')),
} as const;

export default function App() {
  const [page, setPage] = useState<Page>('dashboard')
  const CurrentPage = pageComponents[page]

  return (
    <ErrorBoundary>
      <div className="app-container">
        <Sidebar currentPage={page} onNavigate={setPage} />
        <main className="main-content">
          <React.Suspense fallback={<div>Loading...</div>}>
            <CurrentPage />
          </React.Suspense>
        </main>
        <Notifications />
        <NotificationDrawer />
      </div>
    </ErrorBoundary>
  )
}
