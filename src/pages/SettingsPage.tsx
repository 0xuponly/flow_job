import { useEffect, useState } from 'react'
import { api } from '../api'
import type { Settings } from '../types'

export default function SettingsPage() {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    api.getSettings().then(setSettings)
  }, [])

  async function handleSave() {
    if (!settings) return
    setSaving(true)
    try {
      const updated = await api.updateSettings(settings)
      setSettings(updated)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } finally {
      setSaving(false)
    }
  }

  function update(field: keyof Settings, value: string) {
    setSettings((prev) => (prev ? { ...prev, [field]: value } : prev))
  }

  if (!settings) return null

  return (
    <div className="page">
      <div className="page-header">
        <h1>Settings</h1>
        <p>Configure your profile and AI integration</p>
      </div>

      <div className="section-title">Your profile</div>
      <div className="card" style={{ maxWidth: 600 }}>
        <div className="form-row">
          <div className="form-group">
            <label>Full name</label>
            <input value={settings.user_name} onChange={(e) => update('user_name', e.target.value)} />
          </div>
          <div className="form-group">
            <label>Email</label>
            <input value={settings.user_email} onChange={(e) => update('user_email', e.target.value)} />
          </div>
        </div>
        <div className="form-group">
          <label>Phone</label>
          <input value={settings.user_phone} onChange={(e) => update('user_phone', e.target.value)} />
        </div>
      </div>

      <div className="section-title">Base CV</div>
      <div className="card" style={{ maxWidth: 800 }}>
        <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
          Paste your master CV here. It will be used as the source material when tailoring for specific jobs.
        </p>
        <textarea
          rows={12}
          value={settings.base_cv}
          onChange={(e) => update('base_cv', e.target.value)}
          style={{ width: '100%', fontFamily: 'monospace', fontSize: 13 }}
          placeholder="Paste your full CV text here..."
        />
      </div>

      <div className="section-title">AI configuration</div>
      <div className="card" style={{ maxWidth: 600 }}>
        <div className="alert alert-info" style={{ marginBottom: 14 }}>
          Add an OpenAI API key to enable AI-powered CV tailoring and follow-up message generation.
          Without it, basic templates are used instead.
        </div>
        <div className="form-group">
          <label>API key</label>
          <input
            type="password"
            value={settings.openai_api_key}
            onChange={(e) => update('openai_api_key', e.target.value)}
            placeholder="sk-..."
          />
        </div>
        <div className="form-row">
          <div className="form-group">
            <label>Base URL</label>
            <input
              value={settings.openai_base_url}
              onChange={(e) => update('openai_base_url', e.target.value)}
            />
          </div>
          <div className="form-group">
            <label>Model</label>
            <input
              value={settings.openai_model}
              onChange={(e) => update('openai_model', e.target.value)}
            />
          </div>
        </div>
      </div>

      <div className="section-title">Job search preferences</div>
      <div className="card" style={{ maxWidth: 600 }}>
        <div className="form-row">
          <div className="form-group">
            <label>Keywords</label>
            <input
              value={settings.job_search_keywords}
              onChange={(e) => update('job_search_keywords', e.target.value)}
              placeholder="e.g. software engineer, react, remote"
            />
          </div>
          <div className="form-group">
            <label>Preferred location</label>
            <input
              value={settings.job_search_location}
              onChange={(e) => update('job_search_location', e.target.value)}
              placeholder="e.g. London, Remote"
            />
          </div>
        </div>
      </div>

      <div style={{ marginTop: 20 }}>
        <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
          {saving ? 'Saving...' : saved ? 'Saved!' : 'Save settings'}
        </button>
      </div>
    </div>
  )
}
