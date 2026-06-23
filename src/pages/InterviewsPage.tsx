import { useEffect, useState } from 'react'
import { api } from '../api'
import Modal from '../components/Modal'
import type { Application, Interview } from '../types'

export default function InterviewsPage() {
  const [interviews, setInterviews] = useState<(Interview & { job_title: string; company: string })[]>([])
  const [applications, setApplications] = useState<(Application & { job_title: string; company: string })[]>([])
  const [showAdd, setShowAdd] = useState(false)
  const [form, setForm] = useState({
    application_id: 0,
    scheduled_at: '',
    type: 'video' as Interview['type'],
    duration_minutes: 60,
    location: '',
    interviewer: '',
    notes: ''
  })

  useEffect(() => {
    load()
  }, [])

  async function load() {
    const [ints, apps] = await Promise.all([api.listInterviews(), api.listApplications()])
    setInterviews(ints)
    setApplications(apps.filter((a) => ['applied', 'follow_up', 'interviewing'].includes(a.status)))
  }

  async function handleCreate() {
    if (!form.application_id || !form.scheduled_at) return
    await api.createInterview(
      form.application_id,
      form.scheduled_at,
      form.type,
      form.duration_minutes,
      form.location || undefined,
      form.interviewer || undefined,
      form.notes || undefined
    )
    setShowAdd(false)
    setForm({
      application_id: 0,
      scheduled_at: '',
      type: 'video',
      duration_minutes: 60,
      location: '',
      interviewer: '',
      notes: ''
    })
    await load()
  }

  async function handleOutcome(id: number, outcome: Interview['outcome']) {
    await api.updateInterview(id, { outcome })
    await load()
  }

  const upcoming = interviews.filter((i) => i.outcome === 'scheduled')
  const past = interviews.filter((i) => i.outcome !== 'scheduled')

  return (
    <div className="page">
      <div className="page-header">
        <h1>Interviews</h1>
        <p>Schedule and track your interviews</p>
      </div>

      <div className="toolbar">
        <div className="spacer" />
        <button className="btn btn-primary" onClick={() => setShowAdd(true)}>
          + Schedule interview
        </button>
      </div>

      {interviews.length === 0 ? (
        <div className="empty-state">
          <h3>No interviews scheduled</h3>
          <p>Schedule an interview for one of your active applications.</p>
        </div>
      ) : (
        <>
          {upcoming.length > 0 && (
            <>
              <div className="section-title">Upcoming</div>
              {upcoming.map((int) => (
                <InterviewCard key={int.id} interview={int} onOutcome={handleOutcome} />
              ))}
            </>
          )}
          {past.length > 0 && (
            <>
              <div className="section-title">Past</div>
              {past.map((int) => (
                <InterviewCard key={int.id} interview={int} onOutcome={handleOutcome} />
              ))}
            </>
          )}
        </>
      )}

      <Modal
        open={showAdd}
        title="Schedule interview"
        onClose={() => setShowAdd(false)}
        actions={
          <>
            <button className="btn btn-secondary" onClick={() => setShowAdd(false)}>Cancel</button>
            <button
              className="btn btn-primary"
              onClick={handleCreate}
              disabled={!form.application_id || !form.scheduled_at}
            >
              Schedule
            </button>
          </>
        }
      >
        <div className="form-group">
          <label>Application</label>
          <select
            value={form.application_id}
            onChange={(e) => setForm((f) => ({ ...f, application_id: Number(e.target.value) }))}
          >
            <option value={0}>Select...</option>
            {applications.map((a) => (
              <option key={a.id} value={a.id}>
                {a.company} — {a.job_title}
              </option>
            ))}
          </select>
        </div>
        <div className="form-row">
          <div className="form-group">
            <label>Date & time</label>
            <input
              type="datetime-local"
              value={form.scheduled_at}
              onChange={(e) => setForm((f) => ({ ...f, scheduled_at: e.target.value }))}
            />
          </div>
          <div className="form-group">
            <label>Type</label>
            <select
              value={form.type}
              onChange={(e) => setForm((f) => ({ ...f, type: e.target.value as Interview['type'] }))}
            >
              <option value="phone">Phone</option>
              <option value="video">Video</option>
              <option value="onsite">On-site</option>
              <option value="technical">Technical</option>
              <option value="other">Other</option>
            </select>
          </div>
        </div>
        <div className="form-row">
          <div className="form-group">
            <label>Duration (minutes)</label>
            <input
              type="number"
              value={form.duration_minutes}
              onChange={(e) => setForm((f) => ({ ...f, duration_minutes: Number(e.target.value) }))}
            />
          </div>
          <div className="form-group">
            <label>Interviewer</label>
            <input
              value={form.interviewer}
              onChange={(e) => setForm((f) => ({ ...f, interviewer: e.target.value }))}
            />
          </div>
        </div>
        <div className="form-group">
          <label>Location / Link</label>
          <input
            value={form.location}
            onChange={(e) => setForm((f) => ({ ...f, location: e.target.value }))}
            placeholder="Zoom link, office address, etc."
          />
        </div>
        <div className="form-group">
          <label>Notes</label>
          <textarea
            rows={3}
            value={form.notes}
            onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
          />
        </div>
      </Modal>
    </div>
  )
}

function InterviewCard({
  interview,
  onOutcome
}: {
  interview: Interview & { job_title: string; company: string }
  onOutcome: (id: number, outcome: Interview['outcome']) => void
}) {
  const isUpcoming = interview.outcome === 'scheduled'
  const dt = new Date(interview.scheduled_at)

  return (
    <div className="card">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <strong>{interview.company}</strong> — {interview.job_title}
          <div style={{ fontSize: 13, marginTop: 4 }}>
            {dt.toLocaleString()} · {interview.duration_minutes}min · {interview.type}
          </div>
          {interview.interviewer && (
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>With {interview.interviewer}</div>
          )}
          {interview.location && (
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>{interview.location}</div>
          )}
          {interview.notes && (
            <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 8 }}>{interview.notes}</p>
          )}
        </div>
        {isUpcoming ? (
          <div style={{ display: 'flex', gap: 6 }}>
            <button className="btn btn-primary btn-sm" onClick={() => onOutcome(interview.id, 'completed')}>
              Completed
            </button>
            <button className="btn btn-secondary btn-sm" onClick={() => onOutcome(interview.id, 'cancelled')}>
              Cancelled
            </button>
          </div>
        ) : (
          <span className="badge" style={{ background: 'var(--bg-hover)', color: 'var(--text-muted)' }}>
            {interview.outcome}
          </span>
        )}
      </div>
    </div>
  )
}
