import { useEffect, useState } from 'react'
import { api } from '../api'
import type { Job } from '../types'

// Apply Queue (Task 4).
//
// Surfaces every job in `ready` status as a one-row table the user
// can scan top-to-bottom. Each row exposes three actions: open the
// posting in the OS browser, mark submitted (which flips status to
// `applied` and stamps `submitted_at` via db.markSubmitted), and
// later the per-application response timestamp will be set by the
// follow-ups:create hook on the main side.
//
// Layout follows the project's "sticky page header" pattern: a
// sticky header at the top of `.page` (the scroll container), a
// table body, and a no-base-CV / no-jobs empty state per the brief.
//
// Per `feedback-sticky-page-header-pattern`: the header wrapper uses
// `margin: 0 -32px` to bleed to the page edges, and the page itself
// is the scroll container.
//
// Filter state (currently just the "ready only" server filter) is
// intentionally minimal in this first cut — the brief lists the
// columns and the only action as a per-row "Mark submitted" button.
// A persisted multi-select filter set can land in a follow-up.
export function ApplyQueuePage() {
  const [jobs, setJobs] = useState<Job[]>([])
  const [baseCv, setBaseCv] = useState<string>('')

  useEffect(() => {
    let mounted = true
    Promise.all([api.getSettings(), api.queueList()]).then(([settings, queue]) => {
      if (!mounted) return
      setBaseCv(settings.base_cv ?? '')
      setJobs(queue)
    })
    return () => { mounted = false }
  }, [])

  // Sidebar refresh button: re-fetch both the settings and the queue.
  useEffect(() => {
    const onRefresh = () => {
      Promise.all([api.getSettings(), api.queueList()]).then(([settings, queue]) => {
        setBaseCv(settings.base_cv ?? '')
        setJobs(queue)
      })
    }
    window.addEventListener('app:refresh', onRefresh)
    return () => window.removeEventListener('app:refresh', onRefresh)
  }, [])

  if (!baseCv) {
    return (
      <div className="page">
        <header className="page-header page-header--sticky"><h1>Apply Queue</h1></header>
        <div className="empty-state">Set your base CV in Settings to start tailoring applications.</div>
      </div>
    )
  }

  if (jobs.length === 0) {
    return (
      <div className="page">
        <header className="page-header page-header--sticky"><h1>Apply Queue</h1></header>
        <div className="empty-state">No ready applications. Run a scan or click Quick Apply on a job to populate this list.</div>
      </div>
    )
  }

  async function markSubmitted(jobId: number) {
    await api.queueMarkSubmitted(jobId)
    // Re-fetch the queue: the server now excludes the just-submitted
    // job (status flipped to `applied`, no longer in `ready`).
    setJobs(await api.queueList())
  }

  return (
    <div className="page">
      <header className="page-header page-header--sticky">
        <h1>Apply Queue</h1>
        <p>{jobs.length} ready application{jobs.length === 1 ? '' : 's'}</p>
      </header>
      <table className="job-table">
        <thead>
          <tr>
            <th>Title</th>
            <th>Company</th>
            <th>Grade</th>
            <th>Fit</th>
            <th>Tailored</th>
            <th>Open</th>
            <th>Mark submitted</th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((j) => (
            <tr key={j.id} data-testid={`queue-row-${j.id}`}>
              <td>{j.title}</td>
              <td>{j.company}</td>
              <td>{j.match_grade ?? '—'}</td>
              <td>{j.score != null ? `${Math.round(j.score * 100)}%` : '—'}</td>
              <td>{j.tailor_generated_at ? new Date(j.tailor_generated_at).toLocaleString() : '—'}</td>
              <td>
                {j.url && (
                  <button onClick={() => api.openExternal(j.url!)}>Open</button>
                )}
              </td>
              <td>
                <button onClick={() => markSubmitted(j.id)}>Mark submitted</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
