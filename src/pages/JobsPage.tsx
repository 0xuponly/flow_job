import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import Modal from '../components/Modal'
import type { CreateJobInput, Job } from '../types'
import { STATUS_COLORS, STATUS_LABELS } from '../types'
import JobDetail from './JobDetail'

const EMPTY_FORM: CreateJobInput = {
  title: '',
  company: '',
  location: '',
  url: '',
  description: '',
  salary_range: '',
  source: '',
  notes: ''
}

export default function JobsPage() {
  const [jobs, setJobs] = useState<Job[]>([])
  const [search, setSearch] = useState('')
  const [showAddLink, setShowAddLink] = useState(false)
  const [showAddManual, setShowAddManual] = useState(false)
  const [linkUrl, setLinkUrl] = useState('')
  const [linkError, setLinkError] = useState('')
  const [importing, setImporting] = useState(false)
  const [form, setForm] = useState<CreateJobInput>(EMPTY_FORM)
  const [selectedJob, setSelectedJob] = useState<Job | null>(null)
  const [saving, setSaving] = useState(false)
  const linkInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    loadJobs()
  }, [])

  useEffect(() => {
    if (showAddLink) {
      setLinkUrl('')
      setLinkError('')
      setTimeout(() => linkInputRef.current?.focus(), 50)
    }
  }, [showAddLink])

  async function loadJobs() {
    const data = search ? await api.searchJobs(search) : await api.listJobs()
    setJobs(data)
  }

  useEffect(() => {
    const timer = setTimeout(loadJobs, 300)
    return () => clearTimeout(timer)
  }, [search])

  async function handleImportFromLink() {
    if (!linkUrl.trim()) {
      setLinkError('Paste a job posting URL.')
      return
    }
    setImporting(true)
    setLinkError('')
    try {
      const job = await api.importJobFromUrl(linkUrl)
      setJobs((prev) => [job, ...prev])
      setShowAddLink(false)
      setLinkUrl('')
      setSelectedJob(job)
    } catch (err) {
      setLinkError(err instanceof Error ? err.message : 'Failed to import job.')
    } finally {
      setImporting(false)
    }
  }

  function handleLinkKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !importing) {
      e.preventDefault()
      handleImportFromLink()
    }
  }

  async function handleCreateManual() {
    if (!form.title || !form.company) return
    setSaving(true)
    try {
      const job = await api.createJob(form)
      setJobs((prev) => [job, ...prev])
      setShowAddManual(false)
      setForm(EMPTY_FORM)
      setSelectedJob(job)
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(id: number) {
    if (!confirm('Delete this job and all related data?')) return
    await api.deleteJob(id)
    setJobs((prev) => prev.filter((j) => j.id !== id))
    if (selectedJob?.id === id) setSelectedJob(null)
  }

  function updateField(field: keyof CreateJobInput, value: string) {
    setForm((prev) => ({ ...prev, [field]: value }))
  }

  if (selectedJob) {
    return (
      <JobDetail
        job={selectedJob}
        onBack={() => {
          setSelectedJob(null)
          loadJobs()
        }}
        onUpdate={(updated) => {
          setSelectedJob(updated)
          setJobs((prev) => prev.map((j) => (j.id === updated.id ? updated : j)))
        }}
      />
    )
  }

  return (
    <div className="page">
      <div className="page-header">
        <h1>Job Board</h1>
        <p>Source and manage job postings</p>
      </div>

      <div className="toolbar">
        <input
          className="search-input"
          placeholder="Search jobs..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="spacer" />
        <button className="btn btn-primary" onClick={() => setShowAddLink(true)}>
          + Add from link
        </button>
      </div>

      <div className="alert alert-info">
        Paste a job posting URL from supported crypto job boards (LinkedIn, Indeed, Greenhouse, Lever, Glassdoor, Cryptocurrency Jobs, CryptoJobsList, cryptojobs.com, Crypto.jobs, Web3.career, and more). We'll only add the job if we can source the title, company, and description.
      </div>

      {jobs.length === 0 ? (
        <div className="empty-state">
          <h3>No jobs yet</h3>
          <p>Paste a link to a job posting to get started.</p>
          <button className="btn btn-primary" style={{ marginTop: 12 }} onClick={() => setShowAddLink(true)}>
            + Add from link
          </button>
        </div>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Company</th>
              <th>Title</th>
              <th>Location</th>
              <th>Status</th>
              <th>Source</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((job) => (
              <tr key={job.id} style={{ cursor: 'pointer' }} onClick={() => setSelectedJob(job)}>
                <td><strong>{job.company}</strong></td>
                <td>{job.title}</td>
                <td>{job.location ?? '—'}</td>
                <td>
                  <span
                    className="badge"
                    style={{ background: `${STATUS_COLORS[job.status]}22`, color: STATUS_COLORS[job.status] }}
                  >
                    {STATUS_LABELS[job.status]}
                  </span>
                </td>
                <td>{job.source ?? '—'}</td>
                <td>
                  <button
                    className="btn btn-danger btn-sm"
                    onClick={(e) => {
                      e.stopPropagation()
                      handleDelete(job.id)
                    }}
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <Modal
        open={showAddLink}
        title="Add job from link"
        onClose={() => !importing && setShowAddLink(false)}
        actions={
          <>
            <button className="btn btn-secondary" onClick={() => setShowAddLink(false)} disabled={importing}>
              Cancel
            </button>
            <button
              className="btn btn-primary"
              onClick={handleImportFromLink}
              disabled={importing || !linkUrl.trim()}
            >
              {importing ? 'Fetching...' : 'Add job'}
            </button>
          </>
        }
      >
        <div className="form-group">
          <label>Job posting URL</label>
          <input
            ref={linkInputRef}
            value={linkUrl}
            onChange={(e) => {
              setLinkUrl(e.target.value)
              setLinkError('')
            }}
            onKeyDown={handleLinkKeyDown}
            onPaste={() => setLinkError('')}
            placeholder="https://linkedin.com/jobs/view/... or https://boards.greenhouse.io/..."
            disabled={importing}
            autoFocus
          />
        </div>

        {importing && (
          <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 8 }}>
            Fetching job details...
          </p>
        )}

        {linkError && (
          <div className="alert alert-warning" style={{ marginTop: 12 }}>
            {linkError}
          </div>
        )}

        <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 16 }}>
          Supported boards include CryptoJobsList, cryptojobs.com, Crypto.jobs, Web3.career, and others. If details can't be sourced, you'll see an error and no job will be added.{' '}
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            style={{ display: 'inline', padding: '2px 6px', marginLeft: 4 }}
            onClick={() => {
              setShowAddLink(false)
              setShowAddManual(true)
            }}
          >
            Add manually instead
          </button>
        </p>
      </Modal>

      <Modal
        open={showAddManual}
        title="Add job manually"
        onClose={() => setShowAddManual(false)}
        actions={
          <>
            <button className="btn btn-secondary" onClick={() => setShowAddManual(false)}>Cancel</button>
            <button className="btn btn-primary" onClick={handleCreateManual} disabled={saving || !form.title || !form.company}>
              {saving ? 'Saving...' : 'Add job'}
            </button>
          </>
        }
      >
        <div className="form-row">
          <div className="form-group">
            <label>Company *</label>
            <input value={form.company} onChange={(e) => updateField('company', e.target.value)} />
          </div>
          <div className="form-group">
            <label>Job title *</label>
            <input value={form.title} onChange={(e) => updateField('title', e.target.value)} />
          </div>
        </div>
        <div className="form-row">
          <div className="form-group">
            <label>Location</label>
            <input value={form.location} onChange={(e) => updateField('location', e.target.value)} />
          </div>
          <div className="form-group">
            <label>Salary range</label>
            <input value={form.salary_range} onChange={(e) => updateField('salary_range', e.target.value)} />
          </div>
        </div>
        <div className="form-group">
          <label>URL</label>
          <input value={form.url} onChange={(e) => updateField('url', e.target.value)} placeholder="https://..." />
        </div>
        <div className="form-group">
          <label>Source</label>
          <input value={form.source} onChange={(e) => updateField('source', e.target.value)} placeholder="LinkedIn, Indeed, etc." />
        </div>
        <div className="form-group">
          <label>Description</label>
          <textarea
            rows={6}
            value={form.description}
            onChange={(e) => updateField('description', e.target.value)}
            placeholder="Paste the full job description here..."
          />
        </div>
        <div className="form-group">
          <label>Notes</label>
          <textarea rows={2} value={form.notes} onChange={(e) => updateField('notes', e.target.value)} />
        </div>
      </Modal>
    </div>
  )
}
