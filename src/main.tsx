import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ThemeProvider } from './theme/ThemeProvider'
import { NotificationsProvider } from './notifications/NotificationsProvider'
import App from './App'
import './styles/global.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <NotificationsProvider>
      <ThemeProvider>
        <App />
      </ThemeProvider>
    </NotificationsProvider>
  </StrictMode>
)

// Remove the static splash only after the app has painted; double-rAF
// guarantees we wait for the first committed frame, so there is no
// blank flash between splash removal and app paint.
requestAnimationFrame(() => {
  requestAnimationFrame(() => {
    document.getElementById('app-splash')?.remove()
  })
})
