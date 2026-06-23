import { useEffect, useState } from 'react'
import { api } from '../api'
import type { DashboardStats, Job, FollowUp, Interview } from '../types'
import { STATUS_LABELS, STATUS_COLORS } from '../types'

interface Props {
  onNavigate: (page: string) => void
}

export default function Dashboard({ onNavigate }: Props) {
  const [stats, setStats] = useState<DashboardStats | null>(null)
  const [recentJobs, setRecentJobs] = useState<Job[]>([])
  const [followUps, setFollowUps] = useState<(FollowUp & { job_title: string; company: string })[]>([])
  const [interviews, setInterviews] = useState<(Interview & { job_title: string; company: string })[]>([])

  useEffect(() => {
    load()
  }, [])

  async function load() {
    const [s, jobs, fu, int] = await Promise.all([
      api.getDashboardStats(),
      api.listJobs(),
      api.listFollowUps(),
      api.listInterviews(true)
    ])
    setStats(s)
    setRecentJobs(jobs.slice(0, 5))
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

      <div className="job-detail-grid">
        <div>
          <div className="section-title">Recent jobs</div>
          {recentJobs.length === 0 ? (
            <div className="empty-state card">
              <h3>No jobs yet</h3>
              <p>Start by adding a job posting to track.</p>
              <button className="btn btn-primary" style={{ marginTop: 12 }} onClick={() => onNavigate('jobs')}>
                Add from link
              </button>
            </div>
          ) : (
            recentJobs.map((job) => (
              <div key={job.id} className="card">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <strong>{job.company}</strong>
                    <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>{job.title}</div>
                  </div>
                  <span
                    className="badge"
                    style={{ background: `${STATUS_COLORS[job.status]}22`, color: STATUS_COLORS[job.status] }}
                  >
                    {STATUS_LABELS[job.status]}
                  </span>
                </div>
              </div>
            ))
          )}
        </div>

        <div>
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
      </div>
    </div>
  )
}
