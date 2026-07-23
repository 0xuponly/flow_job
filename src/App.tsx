import { useEffect, useState } from 'react'
import Sidebar from './components/Sidebar'
import Notifications from './components/Notifications'
import ErrorBoundary from './components/ErrorBoundary'
import NotificationDrawer from './notifications/NotificationDrawer'
import Dashboard from './pages/Dashboard'
import JobsPage from './pages/JobsPage'
import { ApplyQueuePage } from './pages/ApplyQueuePage'
import PipelinePage from './pages/PipelinePage'
import DocumentsPage from './pages/DocumentsPage'
import FollowUpsPage from './pages/FollowUpsPage'
import InterviewsPage from './pages/InterviewsPage'
import SettingsPage from './pages/SettingsPage'
import ScanJobsPage from './pages/ScanJobsPage'
import type { Page } from './types'

export default function App() {
  const [page, setPage] = useState<Page>('dashboard')

  // External navigation channel: the "fit computed" toast dispatches
  // `app:navigate` before requesting a specific job detail, so the
  // toast can switch pages before JobsPage tries to open the detail.
  useEffect(() => {
    const onNavigate = (e: Event) => {
      const detail = (e as CustomEvent<{ page: Page }>).detail
      if (detail?.page) setPage(detail.page)
    }
    window.addEventListener('app:navigate', onNavigate)
    return () => window.removeEventListener('app:navigate', onNavigate)
  }, [])

  function renderPage() {
    switch (page) {
      case 'dashboard':
        return <Dashboard />
      case 'scanjobs':
        return <ScanJobsPage />
      case 'jobs':
        return <JobsPage />
      case 'queue':
        return <ApplyQueuePage />
      case 'pipeline':
        return <PipelinePage />
      case 'documents':
        return <DocumentsPage />
      case 'followups':
        return <FollowUpsPage />
      case 'interviews':
        return <InterviewsPage />
      case 'settings':
        return <SettingsPage />
    }
  }

  return (
    <>
      <div className="app">
        <Sidebar current={page} onNavigate={setPage} />
        <main className="main">
          <ErrorBoundary>{renderPage()}</ErrorBoundary>
        </main>
        <Notifications />
      </div>
      <NotificationDrawer />
    </>
  )
}
