import { useEffect, useRef, useState } from 'react'

interface Props {
  onSubmit: (url: string) => Promise<{ company: string; title: string }>
}

type Status = { type: 'idle' } | { type: 'importing' } | { type: 'success'; message: string } | { type: 'error'; message: string }

export default function QuickAddUrlWindow({ onSubmit }: Props) {
  const [url, setUrl] = useState('')
  const [status, setStatus] = useState<Status>({ type: 'idle' })
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    // Defer focus so the window-manager focus settle doesn't steal it.
    const timer = setTimeout(() => inputRef.current?.focus(), 50)
    return () => clearTimeout(timer)
  }, [])

  async function handleSubmit() {
    const trimmed = url.trim()
    if (!trimmed) return
    setStatus({ type: 'importing' })
    try {
      const { company, title } = await onSubmit(trimmed)
      setStatus({ type: 'success', message: `Added ${company} — ${title}` })
      setUrl('')
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Import failed'
      setStatus({ type: 'error', message })
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault()
      void handleSubmit()
    }
  }

  function statusClassFor(s: Status): string {
    if (s.type === 'success') return 'quickadd-status quickadd-status--success'
    if (s.type === 'error') return 'quickadd-status quickadd-status--error'
    return 'quickadd-status'
  }

  function statusTextFor(s: Status): string {
    if (s.type === 'idle') return ''
    if (s.type === 'importing') return 'Importing…'
    return s.message
  }

  return (
    <div className="quickadd-window">
      <input
        ref={inputRef}
        type="url"
        className="quickadd-input"
        placeholder="Paste a job URL…"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        onKeyDown={handleKeyDown}
        aria-label="Job URL"
      />
      <div className={statusClassFor(status)} aria-live="polite">
        {statusTextFor(status)}
      </div>
    </div>
  )
}
