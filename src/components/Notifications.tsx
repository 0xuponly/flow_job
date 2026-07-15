import { useEffect, useState } from 'react'

interface Toast {
  id: number
  message: string
  type: 'info' | 'success' | 'error' | 'warning'
  ttl: number
  dismissing?: boolean
  copied?: boolean
  // Optional click handler. When set, clicking the toast runs this
  // callback INSTEAD of dismissing — useful for "fit computed for
  // [job]. Click to open it" toasts. If the user has a copy button
  // on the toast, the copy button still stops propagation. The toast
  // is dismissed after the callback resolves.
  onClick?: () => void
}

let nextId = 0
let listeners: ((toast: Toast) => void)[] = []

export function notify(message: string, type: Toast['type'] = 'info', ttl?: number, onClick?: () => void): void {
  const toast: Toast = {
    id: nextId++,
    message,
    type,
    ttl: ttl ?? (type === 'error' ? 8000 : 4000),
    onClick
  }
  for (const l of listeners) l(toast)
}

export default function Notifications() {
  const [toasts, setToasts] = useState<Toast[]>([])

  useEffect(() => {
    const listener = (toast: Toast) => {
      setToasts((prev) => [...prev, toast])
      setTimeout(() => startDismiss(toast.id), toast.ttl)
    }
    listeners.push(listener)
    return () => {
      listeners = listeners.filter((l) => l !== listener)
    }
  }, [])

  // Mark the toast as dismissing (CSS transition handles the visual fade),
  // then remove it from state after the transition completes.
  function startDismiss(id: number) {
    setToasts((prev) => prev.map((t) => (t.id === id ? { ...t, dismissing: true } : t)))
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id))
    }, 250)
  }

  // Copy the toast's text to the clipboard. Stop propagation so clicking
  // the icon doesn't also dismiss the toast via the parent's onClick.
  // The `copied` flag flips the icon to a checkmark for ~1.5s as feedback;
  // the toast then auto-dismisses so the user can move on.
  function handleCopy(id: number, message: string, e: React.MouseEvent) {
    e.stopPropagation()
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(message).catch(() => {
        // Fallback for environments without clipboard API: select the
        // text in a hidden textarea and execCommand. Rare in Electron,
        // but harmless to keep.
        const ta = document.createElement('textarea')
        ta.value = message
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        try { document.execCommand('copy') } catch {}
        document.body.removeChild(ta)
      })
    }
    setToasts((prev) => prev.map((t) => (t.id === id ? { ...t, copied: true } : t)))
    setTimeout(() => startDismiss(id), 1500)
  }

  if (toasts.length === 0) return null

  return (
    <div style={{
      position: 'fixed',
      bottom: 24,
      right: 24,
      zIndex: 10000,
      display: 'flex',
      flexDirection: 'column',
      gap: 8,
      pointerEvents: 'none'
    }}>
      {toasts.map((t) => {
        const borderColor = t.type === 'error' ? 'var(--danger)' : t.type === 'success' ? '#22c55e' : 'var(--accent)'
        return (
          <div
            key={t.id}
            onClick={() => startDismiss(t.id)}
            style={{
              padding: '12px 44px 12px 20px',
              borderRadius: 10,
              background: 'transparent',
              backdropFilter: 'blur(20px) saturate(180%)',
              WebkitBackdropFilter: 'blur(20px) saturate(180%)',
              color: t.type === 'error' || t.type === 'success' ? '#fff' : 'var(--text)',
              fontSize: 13,
              fontWeight: 500,
              boxShadow: '0 8px 24px rgba(0,0,0,0.25)',
              maxWidth: t.message.includes('\n') ? 480 : 360,
              border: `1px solid ${borderColor}`,
              animation: t.dismissing ? undefined : 'toast-slide-in 0.2s ease-out',
              transition: 'opacity 0.25s ease-in, transform 0.25s ease-in',
              opacity: t.dismissing ? 0 : 1,
              transform: t.dismissing ? 'translateY(10px)' : 'translateY(0)',
              whiteSpace: 'pre-line',
              pointerEvents: 'auto',
              cursor: 'pointer',
              position: 'relative'
            }}
          >
            {t.message}
            <button
              onClick={(e) => handleCopy(t.id, t.message, e)}
              title={t.copied ? 'Copied' : 'Copy to clipboard'}
              aria-label={t.copied ? 'Copied to clipboard' : 'Copy toast text to clipboard'}
              style={{
                position: 'absolute',
                top: 8,
                right: 8,
                width: 24,
                height: 24,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: 'transparent',
                border: 'none',
                color: t.copied ? '#22c55e' : 'rgba(255,255,255,0.6)',
                cursor: 'pointer',
                padding: 0,
                fontSize: 14,
                lineHeight: 1
              }}
            >
              {t.copied ? '✓' : '⧉'}
            </button>
          </div>
        )
      })}
    </div>
  )
}
