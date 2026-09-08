import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import QuickAddUrlWindow from './components/QuickAddUrlWindow'
import { api } from './api'
import './styles/global.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QuickAddUrlWindow
      onSubmit={async (url) => {
        const { job } = await api.importJobFromUrl(url)
        return { company: job.company, title: job.title }
      }}
      onClose={() => window.close()}
    />
  </StrictMode>
)
