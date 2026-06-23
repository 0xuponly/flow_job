import { useEffect, useState } from 'react'
import { api } from '../api'
import Modal from '../components/Modal'
import type { Application, Document, Job } from '../types'
import { STATUS_COLORS, STATUS_LABELS } from '../types'

interface Props {
  job: Job
  onBack: () => void
  onUpdate: (job: Job) => void
}

export default function JobDetail({ job, onBack, onUpdate }: Props) {
  const [application, setApplication] = useState<Application | null>(null)
  const [documents, setDocuments] = useState<Document[]>([])
  const [tailoring, setTailoring] = useState<'cv' | 'cover_letter' | null>(null)
  const [showApply, setShowApply] = useState(false)
  const [applyMethod, setApplyMethod] = useState('Email')
  const [contactEmail, setContactEmail] = useState('')
  const [contactName, setContactName] = useState('')
  const [editing, setEditing] = useState(false)
  const [editDesc, setEditDesc] = useState(job.description ?? '')
  const [editNotes, setEditNotes] = useState(job.notes ?? '')
  const [viewDoc, setViewDoc] = useState<Document | null>(null)
  const [docTitle, setDocTitle] = useState('')
  const [docContent, setDocContent] = useState('')
  const [savingDoc, setSavingDoc] = useState(false)
  const [exportingDoc, setExportingDoc] = useState(false)

  useEffect(() => {
    load()
  }, [job.id])

  async function load() {
    const [app, docs] = await Promise.all([
      api.getOrCreateApplication(job.id),
      api.listDocuments(job.id)
    ])
    setApplication(app)
    setDocuments(docs.filter((d) => d.job_id === job.id))
  }

  async function handleTailor(type: 'cv' | 'cover_letter') {
    setTailoring(type)
    try {
      const result = await api.tailorDocument({ job_id: job.id, document_type: type })
      await api.updateApplication(application!.id, {
        [type === 'cv' ? 'cv_document_id' : 'cover_letter_document_id']: result.document_id
      })
      const updated = await api.updateJob(job.id, { status: 'ready' })
      onUpdate(updated)
      await load()
    } catch (err) {
      alert(`Tailoring failed: ${err instanceof Error ? err.message : 'Unknown error'}`)
    } finally {
      setTailoring(null)
    }
  }

  async function handleApply() {
    if (!application) return
    await api.markApplied(application.id, applyMethod, contactEmail || undefined, contactName || undefined)
    const updated = await api.updateJob(job.id, { status: 'applied' })
    onUpdate(updated)
    setShowApply(false)
    await load()
  }

  function handleViewDoc(doc: Document) {
    setViewDoc(doc)
    setDocTitle(doc.title)
    setDocContent(doc.content)
  }

  async function handleSaveDoc() {
    if (!viewDoc) return
    setSavingDoc(true)
    try {
      const updated = await api.updateDocument(viewDoc.id, docTitle, docContent)
      setDocuments((prev) => prev.map((d) => (d.id === updated.id ? updated : d)))
      setViewDoc(updated)
    } finally {
      setSavingDoc(false)
    }
  }

  async function handleSaveEdits() {
    const updated = await api.updateJob(job.id, { description: editDesc, notes: editNotes })
    onUpdate(updated)
    setEditing(false)
  }

  const cv = documents.find((d) => d.type === 'cv')
  const coverLetter = documents.find((d) => d.type === 'cover_letter')

  return (
    <div className="page">
      <div className="toolbar">
        <button className="btn btn-secondary" onClick={onBack}>← Back</button>
        <div className="spacer" />
        {job.url && (
          <button className="btn btn-secondary" onClick={() => api.openExternal(job.url!)}>
            Open posting
          </button>
        )}
      </div>

      <div className="page-header">
        <h1>{job.title}</h1>
        <p>{job.company}{job.location ? ` · ${job.location}` : ''}</p>
      </div>

      <span
        className="badge"
        style={{
          background: `${STATUS_COLORS[job.status]}22`,
          color: STATUS_COLORS[job.status],
          marginBottom: 16,
          display: 'inline-block'
        }}
      >
        {STATUS_LABELS[job.status]}
      </span>

      <div className="job-detail-grid">
        <div>
          <div className="section-title">Description</div>
          {editing ? (
            <>
              <textarea rows={12} value={editDesc} onChange={(e) => setEditDesc(e.target.value)} style={{ width: '100%' }} />
              <textarea rows={3} value={editNotes} onChange={(e) => setEditNotes(e.target.value)} placeholder="Notes..." style={{ width: '100%', marginTop: 8 }} />
              <div className="actions-row">
                <button className="btn btn-primary btn-sm" onClick={handleSaveEdits}>Save</button>
                <button className="btn btn-secondary btn-sm" onClick={() => setEditing(false)}>Cancel</button>
              </div>
            </>
          ) : (
            <div className="card" style={{ whiteSpace: 'pre-wrap', fontSize: 13, lineHeight: 1.6 }}>
              {job.description || 'No description. Click Edit to add one.'}
              {job.notes && (
                <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border)', color: 'var(--text-muted)' }}>
                  <strong>Notes:</strong> {job.notes}
                </div>
              )}
              <button className="btn btn-secondary btn-sm" style={{ marginTop: 12 }} onClick={() => setEditing(true)}>
                Edit
              </button>
            </div>
          )}

          {job.salary_range && (
            <>
              <div className="section-title">Salary</div>
              <div className="card">{job.salary_range}</div>
            </>
          )}
        </div>

        <div>
          <div className="section-title">Application workflow</div>

          <div className="card">
            <h4 style={{ marginBottom: 8 }}>1. Tailor documents</h4>
            <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
              Generate a job-specific CV and cover letter using AI.
            </p>
            <div className="actions-row">
              <button
                className="btn btn-primary btn-sm"
                onClick={() => handleTailor('cv')}
                disabled={!!tailoring}
              >
                {tailoring === 'cv' ? 'Generating...' : cv ? 'Regenerate CV' : 'Tailor CV'}
              </button>
              <button
                className="btn btn-primary btn-sm"
                onClick={() => handleTailor('cover_letter')}
                disabled={!!tailoring}
              >
                {tailoring === 'cover_letter' ? 'Generating...' : coverLetter ? 'Regenerate letter' : 'Tailor cover letter'}
              </button>
            </div>
            {(cv || coverLetter) && (
              <div style={{ marginTop: 12, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {cv && (
                  <button className="btn btn-secondary btn-sm" onClick={() => handleViewDoc(cv)}>
                    View CV{cv.model_used ? ` (${cv.model_used})` : ''}
                  </button>
                )}
                {coverLetter && (
                  <button className="btn btn-secondary btn-sm" onClick={() => handleViewDoc(coverLetter)}>
                    View cover letter{coverLetter.model_used ? ` (${coverLetter.model_used})` : ''}
                  </button>
                )}
              </div>
            )}
          </div>

          <div className="card">
            <h4 style={{ marginBottom: 8 }}>2. Submit application</h4>
            {application?.applied_at ? (
              <p style={{ fontSize: 13 }}>
                Applied on {new Date(application.applied_at).toLocaleDateString()} via {application.method}
              </p>
            ) : (
              <>
                <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
                  Record when you've submitted your application.
                </p>
                <button className="btn btn-primary btn-sm" onClick={() => setShowApply(true)}>
                  Mark as applied
                </button>
              </>
            )}
          </div>

          <div className="card">
            <h4 style={{ marginBottom: 8 }}>3. Next steps</h4>
            <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              After applying, follow-ups are auto-scheduled. Schedule interviews from the Interviews page.
            </p>
          </div>
        </div>
      </div>

      <Modal
        open={showApply}
        title="Record application"
        onClose={() => setShowApply(false)}
        actions={
          <>
            <button className="btn btn-secondary" onClick={() => setShowApply(false)}>Cancel</button>
            <button className="btn btn-primary" onClick={handleApply}>Confirm</button>
          </>
        }
      >
        <div className="form-group">
          <label>Application method</label>
          <select value={applyMethod} onChange={(e) => setApplyMethod(e.target.value)}>
            <option>Email</option>
            <option>Company portal</option>
            <option>LinkedIn</option>
            <option>Recruiter</option>
            <option>Other</option>
          </select>
        </div>
        <div className="form-group">
          <label>Contact email</label>
          <input value={contactEmail} onChange={(e) => setContactEmail(e.target.value)} />
        </div>
        <div className="form-group">
          <label>Contact name</label>
          <input value={contactName} onChange={(e) => setContactName(e.target.value)} />
        </div>
      </Modal>

      <Modal
        open={!!viewDoc}
        title={viewDoc?.type === 'cv' ? 'CV' : 'Cover Letter'}
        onClose={() => setViewDoc(null)}
        actions={
          viewDoc && (
            <>
              <button className="btn btn-secondary" onClick={() => setViewDoc(null)}>Close</button>
              <button className="btn btn-danger" onClick={async () => {
                if (!viewDoc || !confirm('Delete this document?')) return
                await api.deleteDocument(viewDoc.id)
                setDocuments((prev) => prev.filter((d) => d.id !== viewDoc.id))
                setViewDoc(null)
              }}>Delete</button>
              <button className="btn btn-secondary" onClick={async () => {
                if (!viewDoc) return
                setExportingDoc(true)
                try {
                  const typeLabel = viewDoc?.type === 'cv' ? 'CV' : 'Cover Letter'
                  const path = await api.exportDocumentPdf(docTitle, docContent, typeLabel, job.company, job.title)
                  if (path) alert(`PDF saved to: ${path}`)
                } finally {
                  setExportingDoc(false)
                }
              }} disabled={exportingDoc}>
                {exportingDoc ? 'Exporting...' : 'Download PDF'}
              </button>
              <button className="btn btn-primary" onClick={handleSaveDoc} disabled={savingDoc}>
                {savingDoc ? 'Saving...' : 'Save changes'}
              </button>
            </>
          )
        }
      >
        <div className="form-group">
          <label>Title</label>
          <input value={docTitle} onChange={(e) => setDocTitle(e.target.value)} />
        </div>
        {viewDoc && (
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8 }}>
            Generated {new Date(viewDoc.created_at).toLocaleString()}
            {viewDoc.model_used && ` by ${viewDoc.model_used}`}
          </div>
        )}
        <div className="form-group">
          <label>Content</label>
          <textarea
            rows={20}
            value={docContent}
            onChange={(e) => setDocContent(e.target.value)}
            style={{ width: '100%', fontFamily: 'monospace', fontSize: 13, lineHeight: 1.6 }}
          />
        </div>
      </Modal>
    </div>
  )
}
