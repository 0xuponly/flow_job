import { StrictMode, Suspense, lazy } from 'react'
import { createRoot } from 'react-dom/client'
import { ThemeProvider } from './theme/ThemeProvider'
import { NotificationsProvider } from './notifications/NotificationsProvider'

const App = lazy(() => import('./App'))

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      <NotificationsProvider>
        <Suspense fallback="Loading...">
          <App />
        </Suspense>
      </NotificationsProvider>
    </ThemeProvider>
  </StrictMode>
)
