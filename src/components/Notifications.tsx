import { useEffect, useState } from 'react'

interface Toast {
  id: number
  message: string
  type: 'info' | 'success' | 'error' | 'warning'
  ttl: number
  dismissing?: boolean
  copied?: boolean
  // Optional action. When set, the toast renders an action button
  // (label + onClick). Clicking the button fires onClick; clicking
  // elsewhere on the toast does NOT trigger navigation — toasts are
  // passive notifications and dismissing them with a stray click must
  // not take the user somewhere. The action button dismisses the
  // toast after firing.
  action?: { label: string; onClick: () => void }
}

// Accept either a string message (the common case) or a full object
// for advanced uses (actions). The string form is the public API;
// the object form is reserved for callers that need actions.
type NotifyInput = string | {
  message: string
  type?: Toast['type']
  ttl?: number
  action?: Toast['action']
}

let nextId = 0
let listeners: ((toast: Toast) => void)[] = []

export function notify(input: NotifyInput, type: Toast['type'] = 'info', ttl?: number, onClick?: () => void): void {
  // String form: pass through with positional args.
  // Object form: build a full toast with optional action.
  let toast: Toast
  if (typeof input === 'string') {
    toast = {
      id: nextId++,
      message: input,
      type,
      ttl: ttl ?? (type === 'error' ? 8000 : 4000)
    }
    if (onClick) toast.action = { label: 'Open', onClick }
  } else {
    toast = {
      id: nextId++,
      message: input.message,
      type: input.type ?? 'info',
      ttl: input.ttl ?? ((input.type ?? 'info') === 'error' ? 8000 : 4000)
    }
    if (input.action) toast.action = input.action
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

  function handleActionClick(id: number, action: Toast['action']) {
    if (!action) return
    action.onClick()
    startDismiss(id)
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
        // Reserve space on the right for the action button when
        // present; the copy button always sits in the top-right
        // corner at 8/8/24/24.
        const hasAction = !!t.action
        return (
          <div
            key={t.id}
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
              cursor: 'default',
              position: 'relative'
            }}
          >
            <div style={{ paddingRight: hasAction ? 56 : 0 }}>{t.message}</div>
            {t.action && (
              <button
                onClick={() => handleActionClick(t.id, t.action)}
                title={t.action.label}
                style={{
                  position: 'absolute',
                  bottom: 8,
                  right: 8,
                  height: 24,
                  padding: '0 10px',
                  display: 'inline-flex',
                  alignItems: 'center',
                  background: 'rgba(255,255,255,0.1)',
                  border: '1px solid rgba(255,255,255,0.3)',
                  color: '#fff',
                  fontSize: 12,
                  fontWeight: 600,
                  borderRadius: 6,
                  cursor: 'pointer'
                }}
              >
                {t.action.label}
              </button>
            )}
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
