import { useEffect, useState } from 'react'
import { api } from '../api'
import type { FollowUp } from '../types'

export default function FollowUpsPage() {
  const [followUps, setFollowUps] = useState<(FollowUp & { job_title: string; company: string })[]>([])
  const [showCompleted, setShowCompleted] = useState(false)
  const [generating, setGenerating] = useState<number | null>(null)

  useEffect(() => {
    load()
  }, [showCompleted])

  async function load() {
    const data = await api.listFollowUps(showCompleted)
    setFollowUps(data)
  }

  async function handleComplete(id: number) {
    await api.completeFollowUp(id)
    await load()
  }

  async function handleGenerate(fu: FollowUp & { job_title: string; company: string }) {
    setGenerating(fu.id)
    try {
      const appliedDate = new Date(fu.created_at)
      const days = Math.floor((Date.now() - appliedDate.getTime()) / (1000 * 60 * 60 * 24))
      const message = await api.generateFollowUpMessage(fu.company, fu.job_title, days)
      navigator.clipboard.writeText(message)
      alert('Follow-up message copied to clipboard!')
    } catch (err) {
      alert(`Failed to generate: ${err instanceof Error ? err.message : 'Unknown error'}`)
    } finally {
      setGenerating(null)
    }
  }

  const today = new Date().toISOString().split('T')[0]

  return (
    <div className="page">
      <div className="page-header">
        <h1>Follow-ups</h1>
        <p>Stay on top of application follow-ups</p>
      </div>

      <div className="toolbar">
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-muted)' }}>
          <input
            type="checkbox"
            checked={showCompleted}
            onChange={(e) => setShowCompleted(e.target.checked)}
          />
          Show completed
        </label>
      </div>

      {followUps.length === 0 ? (
        <div className="empty-state">
          <h3>No follow-ups</h3>
          <p>Follow-ups are automatically created when you mark an application as submitted.</p>
        </div>
      ) : (
        followUps.map((fu) => (
          <div key={fu.id} className="card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <strong>{fu.company}</strong> — {fu.job_title}
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
                  {fu.type} · Due {fu.due_date}
                  {fu.due_date < today && !fu.completed_at && (
                    <span className="overdue"> (overdue)</span>
                  )}
                </div>
                {fu.message && (
                  <p style={{ fontSize: 13, marginTop: 8, color: 'var(--text-muted)' }}>{fu.message}</p>
                )}
              </div>
              {!fu.completed_at && (
                <div style={{ display: 'flex', gap: 6 }}>
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={() => handleGenerate(fu)}
                    disabled={generating === fu.id}
                  >
                    {generating === fu.id ? 'Generating...' : 'Generate email'}
                  </button>
                  <button className="btn btn-primary btn-sm" onClick={() => handleComplete(fu.id)}>
                    Done
                  </button>
                </div>
              )}
              {fu.completed_at && (
                <span style={{ fontSize: 12, color: 'var(--success)' }}>
                  Completed {new Date(fu.completed_at).toLocaleDateString()}
                </span>
              )}
            </div>
          </div>
        ))
      )}
    </div>
  )
}
