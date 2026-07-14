import { useEffect, useState } from 'react'
import { api } from '../api'
import type { DashboardStats, FollowUp, Interview } from '../types'

export default function Dashboard() {
  const [stats, setStats] = useState<DashboardStats | null>(null)
  const [followUps, setFollowUps] = useState<(FollowUp & { job_title: string; company: string })[]>([])
  const [interviews, setInterviews] = useState<(Interview & { job_title: string; company: string })[]>([])

  useEffect(() => {
    load()
  }, [])

  // Sidebar refresh button: re-fetch dashboard data
  useEffect(() => {
    const onRefresh = () => { load() }
    window.addEventListener('app:refresh', onRefresh)
    return () => window.removeEventListener('app:refresh', onRefresh)
  }, [])

  async function load() {
    const [s, fu, int] = await Promise.all([
      api.getDashboardStats(),
      api.listFollowUps(),
      api.listInterviews(true)
    ])
    setStats(s)
    setFollowUps(fu.slice(0, 5))
    setInterviews(int.slice(0, 5))
  }

  const today = new Date().toISOString().split('T')[0]

  return (
    <div className="page">
      <div className="page-header">
        <h1>Dashboard</h1>
        <p>Your job search at a glance</p>
      </div>

      {stats && (
        <div className="stats-grid">
          <div className="stat-card">
            <div className="value">{stats.total_jobs}</div>
            <div className="label">Jobs tracked</div>
          </div>
          <div className="stat-card">
            <div className="value">{stats.applied}</div>
            <div className="label">Applied</div>
          </div>
          <div className="stat-card">
            <div className="value">{stats.interviewing}</div>
            <div className="label">Interviewing</div>
          </div>
          <div className="stat-card">
            <div className="value">{stats.offers}</div>
            <div className="label">Offers</div>
          </div>
          <div className="stat-card">
            <div className="value">{stats.pending_follow_ups}</div>
            <div className="label">Pending follow-ups</div>
          </div>
          <div className="stat-card">
            <div className="value">{stats.upcoming_interviews}</div>
            <div className="label">Upcoming interviews</div>
          </div>
        </div>
      )}

      <div className="section-title">Action items</div>
      {followUps.length === 0 && interviews.length === 0 ? (
        <div className="card empty-state">
          <p>Nothing urgent right now.</p>
        </div>
      ) : (
        <>
          {followUps.map((fu) => (
            <div key={`fu-${fu.id}`} className="card">
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Follow-up</div>
              <strong>{fu.company}</strong> — {fu.job_title}
              <div className={fu.due_date < today ? 'overdue' : ''} style={{ fontSize: 12, marginTop: 4 }}>
                Due {fu.due_date}
              </div>
            </div>
          ))}
          {interviews.map((int) => (
            <div key={`int-${int.id}`} className="card">
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Interview</div>
              <strong>{int.company}</strong> — {int.job_title}
              <div style={{ fontSize: 12, marginTop: 4 }}>
                {new Date(int.scheduled_at).toLocaleString()}
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  )
}
