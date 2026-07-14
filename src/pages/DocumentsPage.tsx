import { useEffect, useState } from 'react'
import { api } from '../api'
import type { AIQueueItem, Document } from '../types'
import { STATUS_LABELS } from '../types'
import { notify } from '../components/Notifications'
import Modal from '../components/Modal'

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

export default function DocumentsPage() {
  const [documents, setDocuments] = useState<Document[]>([])
  const [selected, setSelected] = useState<Document | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [editContent, setEditContent] = useState('')
  const [saving, setSaving] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [selectedSection, setSelectedSection] = useState('')
  const [regeneratingSection, setRegeneratingSection] = useState<string | null>(null)
  const [regenContext, setRegenContext] = useState('')
  const [queue, setQueue] = useState<AIQueueItem[]>([])
  const [showQueue, setShowQueue] = useState(false)
  const [bulkSelected, setBulkSelected] = useState<Set<number>>(new Set())
  const [bulkDeleting, setBulkDeleting] = useState(false)

  useEffect(() => {
    load()
    loadQueue()
    const interval = setInterval(loadQueue, 10000)
    return () => clearInterval(interval)
  }, [])

  async function load() {
    const docs = await api.listDocuments()
    setDocuments(docs)
    if (docs.length > 0 && !selected) {
      selectDoc(docs[0])
    }
  }

  async function loadQueue() {
    setQueue(await api.listAIQueue())
  }

  async function handleRetry(id: number) {
    setQueue(await api.retryAIQueueItem(id))
    notify('Queued task retried.', 'info')
  }

  async function handleRemoveQueue(id: number) {
    setQueue(await api.removeAIQueueItem(id))
  }

  function queueLabel(item: AIQueueItem): string {
    switch (item.type) {
      case 'generate_cv': return 'Generate CV'
      case 'generate_cover_letter': return 'Generate Cover Letter'
      case 'regenerate_section': return `Regenerate section: ${item.sectionName}`
      case 'verify': return 'Verify document'
    }
  }

  function queueStatusText(item: AIQueueItem): string {
    if (item.status === 'processing') return 'Processing…'
    if (item.status === 'failed') return `Failed (${item.attempts} attempts)`
    if (item.attempts > 0) {
      const wait = Math.max(0, Math.ceil((item.nextRetryAt - Date.now()) / 1000))
      return `Retry in ${wait}s (attempt ${item.attempts})`
    }
    return 'Pending'
  }

  function selectDoc(doc: Document) {
    setSelected(doc)
    setEditTitle(doc.title)
    setEditContent(doc.content)
  }

  async function handleSave() {
    if (!selected) return
    setSaving(true)
    try {
      const updated = await api.updateDocument(selected.id, editTitle, editContent)
      setDocuments((prev) => prev.map((d) => (d.id === updated.id ? updated : d)))
      setSelected(updated)
    } finally {
      setSaving(false)
    }
  }

  async function handleRegenSection() {
    if (!selected || !selectedSection || !selected.job_id) return
    setRegeneratingSection(selectedSection)
    try {
      const result = await api.regenerateSection(selected.id, selectedSection, selected.job_id, regenContext.trim() || undefined)
      if (result && typeof result === 'object' && 'queued' in result) {
        notify('Request rate-limited — added to queue. Will retry automatically.', 'info')
        return
      }
      const updatedContent = result as string
      setEditContent(updatedContent)
      setSelected({ ...selected, content: updatedContent })
    } catch (err) {
      alert(`Failed to regenerate section: ${err instanceof Error ? err.message : 'Unknown error'}`)
    } finally {
      setRegeneratingSection(null)
    }
  }

  async function handleDelete(id: number) {
    if (!confirm('Delete this document?')) return
    const target = documents.find((d) => d.id === id)
    await api.deleteDocument(id)
    setDocuments((prev) => prev.filter((d) => d.id !== id))
    if (selected?.id === id) {
      setSelected(null)
    }
    await maybeNotifyStatusChange(target)
  }

  async function maybeNotifyStatusChange(doc: Document | undefined) {
    if (!doc?.job_id) return
    const job = await api.getJob(doc.job_id)
    if (!job) return
    // We don't know the prior status without a pre-snapshot; the backend's
    // recompute is idempotent for protected statuses. Compare against
    // doc type: if user just deleted a CV or cover letter, status may have
    // dropped from 'ready' to 'reviewing'.
    const stillHasCV = documents.some((d) => d.job_id === doc.job_id && d.type === 'cv' && d.id !== doc.id)
    const stillHasCL = documents.some((d) => d.job_id === doc.job_id && d.type === 'cover_letter' && d.id !== doc.id)
    if (!stillHasCV || !stillHasCL) {
      notify(`Job status updated: ${STATUS_LABELS[job.status]}`, 'info')
    }
  }

  function toggleBulkSelect(id: number) {
    setBulkSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleSelectAll() {
    if (bulkSelected.size === documents.length) {
      setBulkSelected(new Set())
    } else {
      setBulkSelected(new Set(documents.map((d) => d.id)))
    }
  }

  useEffect(() => {
    // Drop selections for documents that no longer exist
    if (bulkSelected.size === 0) return
    const valid = new Set(documents.map((d) => d.id))
    setBulkSelected((prev) => {
      const next = new Set([...prev].filter((id) => valid.has(id)))
      return next.size === prev.size ? prev : next
    })
  }, [documents])

  async function handleBulkDelete() {
    const ids = [...bulkSelected]
    if (ids.length === 0) return
    if (!confirm(`Delete ${ids.length} document${ids.length > 1 ? 's' : ''}?`)) return
    setBulkDeleting(true)
    try {
      const results = await Promise.allSettled(ids.map((id) => api.deleteDocument(id)))
      const deleted = new Set<number>()
      const failed: string[] = []
      results.forEach((r, i) => {
        if (r.status === 'fulfilled') deleted.add(ids[i])
        else failed.push(`#${ids[i]}: ${r.reason instanceof Error ? r.reason.message : 'Unknown error'}`)
      })
      setDocuments((prev) => prev.filter((d) => !deleted.has(d.id)))
      setBulkSelected(new Set())
      if (selected && deleted.has(selected.id)) setSelected(null)
      if (failed.length > 0) {
        alert(`Deleted ${deleted.size}, failed ${failed.length}:\n${failed.join('\n')}`)
      } else {
        notify(`Deleted ${deleted.size} document${deleted.size > 1 ? 's' : ''}.`, 'info')
      }
      // Notify once per affected job whose status may have changed.
      const affectedJobIds = new Set<number>()
      for (const id of ids) {
        if (!deleted.has(id)) continue
        const doc = documents.find((d) => d.id === id)
        if (doc?.job_id) affectedJobIds.add(doc.job_id)
      }
      for (const jobId of affectedJobIds) {
        const job = await api.getJob(jobId)
        if (job) notify(`Job "${job.title}" status: ${STATUS_LABELS[job.status]}`, 'info')
      }
    } finally {
      setBulkDeleting(false)
    }
  }

  async function handleExportPdf() {
    if (!selected) return
    setExporting(true)
    try {
      const typeLabel = selected?.type === 'cv' ? 'CV' : 'Cover Letter'
      const path = await api.exportDocumentPdf(editTitle, editContent, typeLabel)
      if (path) {
        alert(`PDF saved to: ${path}`)
      }
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="page">
      <div className="page-header">
        <h1>Documents</h1>
        <p>View and edit tailored CVs and cover letters</p>
      </div>

      {queue.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '6px 16px', maxWidth: 800, marginBottom: 16, background: 'var(--bg-secondary)', borderRadius: 8, fontSize: 13 }}>
          <span style={{ color: 'var(--text-muted)' }}>
            {queue.length} task{queue.length > 1 ? 's' : ''} queued
          </span>
          <button className="btn btn-secondary btn-sm" onClick={() => setShowQueue(true)}>View queue</button>
        </div>
      )}

      <Modal open={showQueue} title="AI Queue" onClose={() => setShowQueue(false)}>
        <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
          Rate-limited requests are automatically retried with backoff. Tasks persist across app restarts.
        </p>
        {queue.length === 0 ? (
          <p style={{ fontSize: 13, color: 'var(--text-muted)', fontStyle: 'italic' }}>No tasks queued.</p>
        ) : (
          queue.map((item) => (
            <div key={item.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 500 }}>{queueLabel(item)}</div>
                <div style={{ fontSize: 11, color: item.status === 'failed' ? 'var(--danger)' : 'var(--text-muted)' }}>
                  {queueStatusText(item)}
                  {item.lastError && item.status === 'failed' && ` — ${item.lastError.slice(0, 80)}`}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                {item.status === 'failed' && (
                  <button className="btn btn-primary btn-sm" onClick={() => handleRetry(item.id)}>Retry</button>
                )}
                <button className="btn btn-secondary btn-sm" onClick={() => handleRemoveQueue(item.id)}>Remove</button>
              </div>
            </div>
          ))
        )}
      </Modal>

      {documents.length === 0 ? (
        <div className="empty-state">
          <h3>No documents yet</h3>
          <p>Tailor a CV or cover letter from a job's detail page.</p>
        </div>
      ) : (
        <div className="doc-editor">
          <div className="doc-list">
            <div className="doc-list-header">
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={documents.length > 0 && bulkSelected.size === documents.length}
                  ref={(el) => {
                    if (el) el.indeterminate = bulkSelected.size > 0 && bulkSelected.size < documents.length
                  }}
                  onChange={toggleSelectAll}
                />
                <span>Select All</span>
              </label>
              {bulkSelected.size > 0 && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                    {bulkSelected.size} selected
                  </span>
                  <button
                    className="btn btn-danger btn-sm"
                    onClick={handleBulkDelete}
                    disabled={bulkDeleting}
                  >
                    {bulkDeleting ? 'Deleting…' : 'Delete selected'}
                  </button>
                </div>
              )}
            </div>
            {documents.map((doc) => (
              <div
                key={doc.id}
                className={`doc-list-item ${selected?.id === doc.id ? 'active' : ''}`}
                onClick={() => selectDoc(doc)}
              >
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                  <input
                    type="checkbox"
                    checked={bulkSelected.has(doc.id)}
                    onChange={() => toggleBulkSelect(doc.id)}
                    onClick={(e) => e.stopPropagation()}
                    style={{ marginTop: 2 }}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="type">{doc.type === 'cv' ? 'CV' : 'Cover Letter'}</div>
                    <div style={{ fontSize: 13, fontWeight: 500 }}>{doc.title}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                      {new Date(doc.updated_at).toLocaleDateString()}
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>

          {selected && (
            <div className="doc-content">
              <div className="toolbar">
                <input
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  style={{ flex: 1 }}
                />
                <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
                  {saving ? 'Saving...' : 'Save'}
                </button>
                <button className="btn btn-secondary" onClick={handleExportPdf} disabled={exporting}>
                  {exporting ? 'Exporting...' : 'Download PDF'}
                </button>
                <button className="btn btn-danger btn-sm" onClick={() => handleDelete(selected.id)}>
                  Delete
                </button>
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8 }}>
                Generated {new Date(selected.created_at).toLocaleString()}
                {selected.model_used && ` by ${selected.model_used}`}
              </div>
              {selected?.type === 'cv' && selected.job_id && (
                <div style={{ marginBottom: 8 }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
                    <select
                      value={selectedSection}
                      onChange={(e) => setSelectedSection(e.target.value)}
                      style={{ flex: 1 }}
                    >
                      <option value="">Regenerate section…</option>
                      {findSections(editContent).map((s) => (
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
                  <textarea
                    rows={2}
                    value={regenContext}
                    onChange={(e) => setRegenContext(e.target.value)}
                    placeholder="Add context/instructions for regeneration (optional)…"
                    style={{ width: '100%', fontSize: 12, resize: 'vertical' }}
                  />
                </div>
              )}
              <textarea
                value={editContent}
                onChange={(e) => setEditContent(e.target.value)}
              />
            </div>
          )}
        </div>
      )}
    </div>
  )
}