import { useEffect, useState } from 'react'
import { api } from '../api'
import type { Job, JobStatus } from '../types'

const COLUMNS: { status: JobStatus; label: string }[] = [
  { status: 'sourced', label: 'Sourced' },
  { status: 'reviewing', label: 'Reviewing' },
  { status: 'ready', label: 'Ready' },
  { status: 'applied', label: 'Applied' },
  { status: 'interviewing', label: 'Interviewing' }
]

export default function PipelinePage() {
  const [jobs, setJobs] = useState<Job[]>([])

  useEffect(() => {
    api.listJobs().then(setJobs)
  }, [])

  async function moveJob(jobId: number, status: JobStatus) {
    const updated = await api.updateJob(jobId, { status })
    setJobs((prev) => prev.map((j) => (j.id === jobId ? updated : j)))
  }

  return (
    <div className="page">
      <div className="page-header">
        <h1>Pipeline</h1>
        <p>Track jobs through each stage of your search</p>
      </div>

      <div className="pipeline">
        {COLUMNS.map((col) => {
          const colJobs = jobs.filter((j) => j.status === col.status)
          return (
            <div key={col.status} className="pipeline-column">
              <h3>{col.label} ({colJobs.length})</h3>
              {colJobs.map((job) => (
                <div key={job.id} className="pipeline-card">
                  <div className="company">{job.company}</div>
                  <div className="title">{job.title}</div>
                  <select
                    style={{ marginTop: 8, width: '100%', fontSize: 11 }}
                    value={job.status}
                    onChange={(e) => moveJob(job.id, e.target.value as JobStatus)}
                  >
                    {COLUMNS.map((c) => (
                      <option key={c.status} value={c.status}>{c.label}</option>
                    ))}
                    <option value="offer">Offer</option>
                    <option value="rejected">Rejected</option>
                    <option value="withdrawn">Withdrawn</option>
                  </select>
                </div>
              ))}
            </div>
          )
        })}
      </div>
    </div>
  )
}
