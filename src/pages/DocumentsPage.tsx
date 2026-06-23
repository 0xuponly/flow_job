import { useEffect, useState } from 'react'
import { api } from '../api'
import type { Document } from '../types'

export default function DocumentsPage() {
  const [documents, setDocuments] = useState<Document[]>([])
  const [selected, setSelected] = useState<Document | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [editContent, setEditContent] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    load()
  }, [])

  async function load() {
    const docs = await api.listDocuments()
    setDocuments(docs)
    if (docs.length > 0 && !selected) {
      selectDoc(docs[0])
    }
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

  return (
    <div className="page">
      <div className="page-header">
        <h1>Documents</h1>
        <p>View and edit tailored CVs and cover letters</p>
      </div>

      {documents.length === 0 ? (
        <div className="empty-state">
          <h3>No documents yet</h3>
          <p>Tailor a CV or cover letter from a job's detail page.</p>
        </div>
      ) : (
        <div className="doc-editor">
          <div className="doc-list">
            {documents.map((doc) => (
              <div
                key={doc.id}
                className={`doc-list-item ${selected?.id === doc.id ? 'active' : ''}`}
                onClick={() => selectDoc(doc)}
              >
                <div className="type">{doc.type === 'cv' ? 'CV' : 'Cover Letter'}</div>
                <div style={{ fontSize: 13, fontWeight: 500 }}>{doc.title}</div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                  {new Date(doc.updated_at).toLocaleDateString()}
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
              </div>
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
