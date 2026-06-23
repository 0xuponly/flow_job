import { useState } from 'react'
import Sidebar from './components/Sidebar'
import Dashboard from './pages/Dashboard'
import JobsPage from './pages/JobsPage'
import PipelinePage from './pages/PipelinePage'
import DocumentsPage from './pages/DocumentsPage'
import FollowUpsPage from './pages/FollowUpsPage'
import InterviewsPage from './pages/InterviewsPage'
import SettingsPage from './pages/SettingsPage'
import type { Page } from './types'

export default function App() {
  const [page, setPage] = useState<Page>('dashboard')

  function renderPage() {
    switch (page) {
      case 'dashboard':
        return <Dashboard onNavigate={(p) => setPage(p as Page)} />
      case 'jobs':
        return <JobsPage />
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
    <div className="app">
      <Sidebar current={page} onNavigate={setPage} />
      <main className="main">{renderPage()}</main>
    </div>
  )
}
