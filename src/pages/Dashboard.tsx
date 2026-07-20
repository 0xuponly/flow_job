import { useEffect, useState } from 'react'
import { api } from '../api'
import type { DashboardStats, FollowUp, Interview, Job } from '../types'
import { computeQueueFunnel } from '../queueStats'

export default function Dashboard() {
  const [stats, setStats] = useState<DashboardStats | null>(null)
  const [followUps, setFollowUps] = useState<(FollowUp & { job_title: string; company: string })[]>([])
  const [interviews, setInterviews] = useState<(Interview & { job_title: string; company: string })[]>([])
  const [jobs, setJobs] = useState<Job[]>([])

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
    const [s, fu, int, j] = await Promise.all([
      api.getDashboardStats(),
      api.listFollowUps(),
      api.listInterviews(true),
      api.listJobs()
    ])
    setStats(s)
    setFollowUps(fu.slice(0, 5))
    setInterviews(int.slice(0, 5))
    setJobs(j)
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

      {jobs.length > 0 && <MatchQualityTrendWidget jobs={jobs} />}
      {jobs.length > 0 && <TimeSavedWidget jobs={jobs} />}
      <QueueFunnelWidget jobs={jobs} />

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

// Daily average fit score over the last 7 days. Renders a 7-point
// line; bails to an empty state until at least 3 days of data exist
// (per the brief — a 1- or 2-day sample is noise, not a trend). Per
// the project's "terse result headers" rule, the headline carries the
// latest-day average and the label "Match quality"; no secondary
// stats.
function MatchQualityTrendWidget({ jobs }: { jobs: Job[] }) {
  // Build the 7-day window (today and 6 days back, local-time buckets).
  const dayKeys: string[] = []
  const dayLabels: string[] = []
  for (let i = 6; i >= 0; i--) {
    const d = new Date()
    d.setHours(0, 0, 0, 0)
    d.setDate(d.getDate() - i)
    dayKeys.push(toDayKey(d))
    dayLabels.push(d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }))
  }
  const bucketScores: Record<string, number[]> = {}
  for (const k of dayKeys) bucketScores[k] = []
  for (const j of jobs) {
    if (j.score == null) continue
    const day = jobDayKey(j)
    if (day in bucketScores) bucketScores[day].push(j.score)
  }
  const daysWithData = dayKeys.filter((k) => bucketScores[k].length > 0)
  if (daysWithData.length < 3) {
    return (
      <div className="card">
        <div className="section-title" style={{ marginBottom: 4 }}>Match quality</div>
        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Need 3+ days of data</div>
      </div>
    )
  }
  const averages: (number | null)[] = dayKeys.map((k) => {
    const arr = bucketScores[k]
    if (arr.length === 0) return null
    return arr.reduce((a, b) => a + b, 0) / arr.length
  })
  // Lead with the latest day's average. If today has no scored jobs,
  // fall back to the most recent day that does.
  const latestAvg = (() => {
    for (let i = averages.length - 1; i >= 0; i--) {
      if (averages[i] != null) return averages[i]
    }
    return null
  })()
  const headline = latestAvg != null ? `${Math.round(latestAvg * 100)}%` : '—'
  return (
    <div className="card">
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 8 }}>
        <div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Match quality</div>
          <div style={{ fontSize: 22, fontWeight: 600 }}>{headline}</div>
        </div>
      </div>
      <Sparkline points={averages} labels={dayLabels} />
    </div>
  )
}

function toDayKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
}

function jobDayKey(j: Job): string {
  // Prefer date_posted; fall back to created_at; both are ISO strings.
  const raw = j.date_posted || j.created_at
  if (!raw) return ''
  const d = new Date(raw)
  if (isNaN(d.getTime())) return ''
  return toDayKey(d)
}

// Minimal SVG sparkline. Inputs: parallel arrays of (value | null)
// and labels. Renders dots + a polyline; null points are gaps.
function Sparkline({ points, labels }: { points: (number | null)[]; labels: string[] }) {
  const W = 320
  const H = 60
  const PAD_X = 4
  const PAD_Y = 6
  const n = points.length
  if (n === 0) return null
  const x = (i: number) => PAD_X + (i * (W - PAD_X * 2)) / (n - 1)
  const y = (v: number) => PAD_Y + (1 - v) * (H - PAD_Y * 2)
  const present = points.map((p, i) => (p == null ? null : { i, v: p, x: x(i), y: y(p) }))
  const pathD = (() => {
    let d = ''
    let started = false
    for (const p of present) {
      if (!p) { started = false; continue }
      d += `${started ? ' L' : 'M'} ${p.x} ${p.y}`
      started = true
    }
    return d
  })()
  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-label="Match quality trend, last 7 days">
      {pathD && <path d={pathD} fill="none" stroke="var(--accent, #3b82f6)" strokeWidth={1.5} />}
      {present.map((p) => p && (
        <g key={p.i}>
          <circle cx={p.x} cy={p.y} r={2.5} fill="var(--accent, #3b82f6)" />
          <title>{labels[p.i]}: {Math.round(p.v * 100)}%</title>
        </g>
      ))}
    </svg>
  )
}

// TimeSavedWidget (Task 3). Sums the wall-clock ms the auto-tailor
// spent on CV + cover letter for jobs added in the last 7 days. The
// headline is the rounded minute count (rounded to the nearest 5 so
// the number doesn't read as "jittery"). Per `feedback-score-formatting`
// the headline leads with the number, no redundant label, and per
// `feedback-terse-result-headers` there's no secondary stat below it.
// Hides entirely when the saved time is zero so the card doesn't take
// up space for users who haven't used auto-tailor yet.
function TimeSavedWidget({ jobs }: { jobs: Job[] }) {
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000
  let totalMs = 0
  for (const j of jobs) {
    // Jobs without a tailor_generated_at were never auto-tailored
    // (or the tailor failed); skip both. Jobs added before the 7-day
    // window don't count.
    if (j.tailor_generated_at == null) continue
    if (j.tailor_generated_at < sevenDaysAgo) continue
    const ms = (j.tailor_ms_cv ?? 0) + (j.tailor_ms_cl ?? 0)
    totalMs += ms
  }
  if (totalMs <= 0) return null
  const minutes = Math.round(totalMs / 60000)
  const rounded = Math.round(minutes / 5) * 5
  return (
    <div className="card">
      <div className="section-title" style={{ marginBottom: 4 }}>Time saved</div>
      <div style={{ fontSize: 22, fontWeight: 600 }}>{rounded} minutes saved this week</div>
    </div>
  )
}

// QueueFunnelWidget (Task 4). Five-bar horizontal funnel: jobs added
// in the last 7 days → grade A → tailored → submitted → responded.
// Per `feedback-terse-result-headers` the headline leads with the
// head count (jobs added this week) and the label "Queue funnel";
// each bar carries a small conversion % as secondary text below the
// headline. Hides entirely when `added === 0` so the card doesn't
// take up space before the user has run a scan.
function QueueFunnelWidget({ jobs }: { jobs: Job[] }) {
  const stats = computeQueueFunnel(jobs, Date.now())
  if (stats.added === 0) return null
  const bars: { label: string; value: number; pct: number }[] = [
    { label: 'Added', value: stats.added, pct: 100 },
    { label: 'Grade A', value: stats.gradeA, pct: stats.added ? (stats.gradeA / stats.added) * 100 : 0 },
    { label: 'Tailored', value: stats.tailored, pct: stats.added ? (stats.tailored / stats.added) * 100 : 0 },
    { label: 'Submitted', value: stats.submitted, pct: stats.added ? (stats.submitted / stats.added) * 100 : 0 },
    { label: 'Responded', value: stats.responded, pct: stats.added ? (stats.responded / stats.added) * 100 : 0 },
  ]
  return (
    <div className="card">
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 8 }}>
        <div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Queue funnel</div>
          <div style={{ fontSize: 22, fontWeight: 600 }}>{stats.added} this week</div>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 4, alignItems: 'flex-end', height: 48 }}>
        {bars.map((b) => (
          <div key={b.label} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
            <div
              title={`${b.label}: ${b.value} (${Math.round(b.pct)}%)`}
              data-tooltip={`${b.label}: ${b.value} (${Math.round(b.pct)}%)`}
              style={{
                width: '100%',
                height: `${Math.max(4, (b.pct / 100) * 40)}px`,
                background: 'var(--accent, #3b82f6)',
                borderRadius: 2
              }}
            />
            <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 4 }}>{b.label}</div>
            <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{Math.round(b.pct)}%</div>
          </div>
        ))}
      </div>
    </div>
  )
}
