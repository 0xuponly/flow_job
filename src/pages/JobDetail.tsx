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
  const [editTitle, setEditTitle] = useState(job.title)
  const [editCompany, setEditCompany] = useState(job.company)
  const [editLocation, setEditLocation] = useState(job.location ?? '')
  const [editDesc, setEditDesc] = useState(job.description ?? '')
  const [editNotes, setEditNotes] = useState(job.notes ?? '')
  const [editSalaryRange, setEditSalaryRange] = useState(job.salary_range ?? '')
  const [editRequirements, setEditRequirements] = useState(job.requirements ?? '')
  const [editApplicationRequirements, setEditApplicationRequirements] = useState(job.application_requirements ?? '')
  const [editHiringManager, setEditHiringManager] = useState(job.hiring_manager ?? '')
  const [editEmploymentType, setEditEmploymentType] = useState(job.employment_type ?? '')
  const [editWorkMode, setEditWorkMode] = useState(job.work_mode ?? '')
  const [viewDoc, setViewDoc] = useState<Document | null>(null)
  const [docTitle, setDocTitle] = useState('')
  const [docContent, setDocContent] = useState('')
  const [savingDoc, setSavingDoc] = useState(false)
  const [exportingDoc, setExportingDoc] = useState(false)
  const [regeneratingSection, setRegeneratingSection] = useState<string | null>(null)
  const [selectedSection, setSelectedSection] = useState('')

  useEffect(() => {
    load()
  }, [job.id])

  async function load() {
    let [app, docs] = await Promise.all([
      api.getOrCreateApplication(job.id),
      api.listDocuments(job.id)
    ])
    docs = docs.filter((d) => d.job_id === job.id)
    setApplication(app)
    setDocuments(docs)

    // Step 1: auto-generate missing documents
    const cv = docs.find((d) => d.type === 'cv')
    const coverLetter = docs.find((d) => d.type === 'cover_letter')
    if (!cv || !coverLetter) {
      if (!cv) {
        const r = await api.tailorDocument({ job_id: job.id, document_type: 'cv' })
        app = await api.getOrCreateApplication(job.id)
        await api.updateApplication(app.id, { cv_document_id: r.document_id })
      }
      if (!coverLetter) {
        const r = await api.tailorDocument({ job_id: job.id, document_type: 'cover_letter' })
        app = await api.getOrCreateApplication(job.id)
        await api.updateApplication(app.id, { cover_letter_document_id: r.document_id })
      }
      ;[app, docs] = await Promise.all([
        api.getOrCreateApplication(job.id),
        api.listDocuments(job.id)
      ])
      docs = docs.filter((d) => d.job_id === job.id)
      setApplication(app)
      setDocuments(docs)
    }

    // Step 2: auto-set status to ready when both docs exist
    let status = job.status
    const hasCv = docs.find((d) => d.type === 'cv')
    const hasCl = docs.find((d) => d.type === 'cover_letter')
    if (hasCv && hasCl && status !== 'ready' && status !== 'applied') {
      await api.updateJob(job.id, { status: 'ready' })
      status = 'ready'
      onUpdate({ ...job, status: 'ready' })
    }


  }

  async function handleTailor(type: 'cv' | 'cover_letter') {
    setTailoring(type)
    try {
      const result = await api.tailorDocument({ job_id: job.id, document_type: type })
      await api.updateApplication(application!.id, {
        [type === 'cv' ? 'cv_document_id' : 'cover_letter_document_id']: result.document_id
      })
      const updated = await api.updateJob(job.id, { status: 'tailoring' })
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

  const SECTION_HEADERS = new Set([
    'professional summary', 'summary', 'profile',
    'core competencies', 'competencies', 'skills', 'qualifications', 'technical skills',
    'professional experience', 'experience', 'work history', 'work experience',
    'education',
    'certifications', 'languages', 'interests', 'skills & interests', 'skills and interests',
    'projects', 'project experience',
    'leadership & activities', 'leadership and activities', 'activities', 'leadership',
    'publications', 'honors & awards', 'honors and awards', 'awards',
    'additional information', 'additional'
  ])

  function findSections(content: string): string[] {
    const lines = content.split('\n')
    const sections: string[] = []
    for (const line of lines) {
      const cleaned = line.toLowerCase().trim().replace(/[*_]/g, '')
      if (SECTION_HEADERS.has(cleaned)) sections.push(cleaned)
    }
    return sections.filter((s) => s !== 'education')
  }

  async function handleRegenSection() {
    if (!viewDoc || !selectedSection || !job) return
    setRegeneratingSection(selectedSection)
    try {
      const updatedContent = await api.regenerateSection(viewDoc.id, selectedSection, job.id)
      setDocContent(updatedContent)
      setViewDoc({ ...viewDoc, content: updatedContent })
    } catch (err) {
      alert(`Failed to regenerate section: ${err instanceof Error ? err.message : 'Unknown error'}`)
    } finally {
      setRegeneratingSection(null)
    }
  }

  async function handleSaveEdits() {
    const updated = await api.updateJob(job.id, {
      title: editTitle,
      company: editCompany,
      location: editLocation || null,
      description: editDesc,
      notes: editNotes,
      salary_range: editSalaryRange || null,
      requirements: editRequirements || null,
      application_requirements: editApplicationRequirements || null,
      hiring_manager: editHiringManager || null,
      employment_type: editEmploymentType || null,
      work_mode: editWorkMode || null
    })
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
        <button className={editing ? 'btn btn-primary' : 'btn btn-secondary'} onClick={editing ? handleSaveEdits : () => setEditing(true)}>
          {editing ? 'Save' : 'Edit'}
        </button>
        {job.url && (
          <button className="btn btn-secondary" onClick={() => api.openExternal(job.url!)}>
            Open posting
          </button>
        )}
      </div>

      <div className="page-header">
        {editing ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%' }}>
            <input value={editTitle} onChange={(e) => setEditTitle(e.target.value)} placeholder="Job title" style={{ fontSize: 24, fontWeight: 700 }} />
            <div style={{ display: 'flex', gap: 8 }}>
              <input value={editCompany} onChange={(e) => setEditCompany(e.target.value)} placeholder="Company" style={{ flex: 1, fontSize: 16 }} />
              <input value={editLocation} onChange={(e) => setEditLocation(e.target.value)} placeholder="Location" style={{ flex: 1, fontSize: 16 }} />
            </div>
          </div>
        ) : (
          <>
            <h1>{job.title}</h1>
            <p>{job.company}{job.location ? ` · ${job.location}` : ''}</p>
          </>
        )}
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
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <input value={editSalaryRange} onChange={(e) => setEditSalaryRange(e.target.value)} placeholder="Salary" style={{ flex: 1 }} />
                <input value={editEmploymentType} onChange={(e) => setEditEmploymentType(e.target.value)} placeholder="Full-time / Part-time / Contract" style={{ flex: 1 }} />
                <input value={editWorkMode} onChange={(e) => setEditWorkMode(e.target.value)} placeholder="On-site / Hybrid / Remote" style={{ flex: 1 }} />
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <input value={editHiringManager} onChange={(e) => setEditHiringManager(e.target.value)} placeholder="Hiring manager" style={{ flex: 1 }} />
                <input value={editApplicationRequirements} onChange={(e) => setEditApplicationRequirements(e.target.value)} placeholder="Resume only / Resume + cover letter / etc." style={{ flex: 2 }} />
              </div>
              <textarea rows={4} value={editRequirements} onChange={(e) => setEditRequirements(e.target.value)} placeholder="Requirements (skills, experience, education needed)..." style={{ width: '100%', marginTop: 8 }} />
              <div className="actions-row">
                <button className="btn btn-primary btn-sm" onClick={handleSaveEdits}>Save</button>
                <button className="btn btn-secondary btn-sm" onClick={() => setEditing(false)}>Cancel</button>
              </div>
            </>
          ) : (
            <div className="card" style={{ whiteSpace: 'pre-wrap', fontSize: 13, lineHeight: 1.6 }}>
              {job.description || 'No description.'}
              {job.notes && (
                <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border)', color: 'var(--text-muted)' }}>
                  <strong>Notes:</strong> {job.notes}
                </div>
              )}
            </div>
          )}

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 16 }}>
            <div className="card" style={{ flex: '1 0 160px', padding: '8px 12px' }}>
              <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5, color: 'var(--text-muted)', marginBottom: 2 }}>Salary</div>
              <div style={{ fontSize: 13 }}>{job.salary_range || '—'}</div>
            </div>
            <div className="card" style={{ flex: '1 0 120px', padding: '8px 12px' }}>
              <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5, color: 'var(--text-muted)', marginBottom: 2 }}>Type</div>
              <div style={{ fontSize: 13 }}>{job.employment_type || '—'}</div>
            </div>
            <div className="card" style={{ flex: '1 0 120px', padding: '8px 12px' }}>
              <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5, color: 'var(--text-muted)', marginBottom: 2 }}>Work mode</div>
              <div style={{ fontSize: 13 }}>{job.work_mode || '—'}</div>
            </div>
            <div className="card" style={{ flex: '1 0 200px', padding: '8px 12px' }}>
              <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5, color: 'var(--text-muted)', marginBottom: 2 }}>Hiring manager</div>
              <div style={{ fontSize: 13 }}>{job.hiring_manager || '—'}</div>
            </div>
          </div>

          <div className="section-title">Requirements</div>
          <div className="card" style={{ whiteSpace: 'pre-wrap', fontSize: 13, lineHeight: 1.6 }}>
            {job.requirements || 'No requirements specified.'}
          </div>

          <div className="section-title">Application requirements</div>
          <div className="card" style={{ whiteSpace: 'pre-wrap', fontSize: 13, lineHeight: 1.6 }}>
            {job.application_requirements || 'Not specified.'}
          </div>
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
            <h4 style={{ marginBottom: 8 }}>2. AI content verification</h4>
            <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
              Documents are automatically reviewed against the job description for quality and relevance.
            </p>
            {cv && (
              <div style={{ marginBottom: 8, padding: 8, background: 'var(--bg)', borderRadius: 6, fontSize: 13 }}>
                <strong>CV</strong>
                {cv.verification_score != null ? (
                  <div style={{ marginTop: 4 }}>
                    <span style={{ color: cv.verification_score >= 70 ? '#22c55e' : '#f59e0b', fontWeight: 600 }}>
                      {cv.verification_score}/100 {cv.verification_score >= 70 ? '✓' : '⚠'}
                    </span>
                    {cv.verification_feedback && (
                      <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4, whiteSpace: 'pre-wrap' }}>
                        {cv.verification_feedback}
                      </p>
                    )}
                  </div>
                ) : (
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Pending review…</span>
                )}
              </div>
            )}
            {coverLetter && (
              <div style={{ marginBottom: 8, padding: 8, background: 'var(--bg)', borderRadius: 6, fontSize: 13 }}>
                <strong>Cover letter</strong>
                {coverLetter.verification_score != null ? (
                  <div style={{ marginTop: 4 }}>
                    <span style={{ color: coverLetter.verification_score >= 70 ? '#22c55e' : '#f59e0b', fontWeight: 600 }}>
                      {coverLetter.verification_score}/100 {coverLetter.verification_score >= 70 ? '✓' : '⚠'}
                    </span>
                    {coverLetter.verification_feedback && (
                      <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4, whiteSpace: 'pre-wrap' }}>
                        {coverLetter.verification_feedback}
                      </p>
                    )}
                  </div>
                ) : (
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Pending review…</span>
                )}
              </div>
            )}
            {(!cv && !coverLetter) && (
              <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                Generate a CV and cover letter above first.
              </p>
            )}
            {job.status === 'ready' && (
              <p style={{ fontSize: 13, color: '#22c55e', marginTop: 8 }}>✓ Verified and ready to apply</p>
            )}
          </div>

          <div className="card">
            <h4 style={{ marginBottom: 8 }}>3. Submit application</h4>
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
            <h4 style={{ marginBottom: 8 }}>4. Next steps</h4>
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
        {viewDoc?.type === 'cv' && (
          <div style={{ marginBottom: 12, padding: 12, background: 'var(--bg-secondary)', borderRadius: 8 }}>
            <label style={{ fontWeight: 600, fontSize: 13, display: 'block', marginBottom: 6 }}>Regenerate section</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <select
                value={selectedSection}
                onChange={(e) => setSelectedSection(e.target.value)}
                style={{ flex: 1 }}
              >
                <option value="">Select section…</option>
                {findSections(docContent).map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
              <button
                className="btn btn-primary btn-sm"
                onClick={handleRegenSection}
                disabled={!selectedSection || !!regeneratingSection}
              >
                {regeneratingSection ? 'Regenerating…' : 'Regenerate'}
              </button>
            </div>
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
