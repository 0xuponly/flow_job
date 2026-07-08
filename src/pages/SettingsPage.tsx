import { useEffect, useState } from 'react'
import { api } from '../api'
import type { ApiModelConfig, Settings } from '../types'

const PRESETS: { name: string; desc: string; model: Omit<ApiModelConfig, 'id'> }[] = [
  { name: 'Big Pickle', desc: 'Free, no API key needed', model: { name: 'Big Pickle', base_url: 'https://opencode.ai/zen/v1', api_key: '', model: 'big-pickle' } },
  { name: 'DeepSeek V4 Flash Free', desc: 'via OpenRouter (needs API key)', model: { name: 'DeepSeek V4 Flash', base_url: 'https://openrouter.ai/api/v1', api_key: '', model: 'deepseek/deepseek-v4-flash:free' } },
  { name: 'MiMo V2.5 Free', desc: 'Free, no API key needed', model: { name: 'MiMo V2.5', base_url: 'https://opencode.ai/zen/v1', api_key: '', model: 'mimo-v2.5-free' } },
  { name: 'Nemotron 3 Ultra Free', desc: 'via OpenRouter (needs API key)', model: { name: 'Nemotron 3 Ultra', base_url: 'https://openrouter.ai/api/v1', api_key: '', model: 'nvidia/nemotron-3-ultra-550b-a55b:free' } },
  { name: 'North Mini Code Free', desc: 'Free, no API key needed', model: { name: 'North Mini Code', base_url: 'https://opencode.ai/zen/v1', api_key: '', model: 'north-mini-code-free' } }
]

export default function SettingsPage() {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [models, setModels] = useState<ApiModelConfig[]>([])
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [encryptionMode, setEncryptionMode] = useState<'sealed' | 'plaintext-fallback' | 'uninitialized' | null>(null)

  const emptyModel = { name: '', base_url: 'https://api.deepseek.com', api_key: '', model: 'deepseek-chat' }

  useEffect(() => {
    Promise.all([api.getSettings(), api.listApiModels(), api.getSecurityStatus()]).then(([s, m, sec]) => {
      // Ensure new settings fields default sensibly for users on older stores
      if (typeof s.deleted_jobs_cap !== 'number' || s.deleted_jobs_cap <= 0) {
        s.deleted_jobs_cap = 50000
      }
      if (typeof s.auto_scan_enabled !== 'boolean') {
        s.auto_scan_enabled = true
      }
      if (typeof s.auto_scan_interval_minutes !== 'number' || s.auto_scan_interval_minutes <= 0) {
        s.auto_scan_interval_minutes = 120
      }
      setSettings(s)
      setModels(m.length > 0 ? m : PRESETS.map((p, i) => ({ id: `model-${i + 1}`, ...p.model })))
      setEncryptionMode(sec.mode)
    })
  }, [])

  async function handleSave() {
    if (!settings) return
    setSaving(true)
    try {
      await api.updateSettings(settings)
      await api.saveApiModels(models)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } finally {
      setSaving(false)
    }
  }

  function update(field: keyof Settings, value: string | number | boolean) {
    setSettings((prev) => (prev ? { ...prev, [field]: value as never } : prev))
  }

  function updateModel(i: number, field: keyof ApiModelConfig, value: string) {
    setModels((prev) => prev.map((m, idx) => (idx === i ? { ...m, [field]: value } : m)))
  }

  function addModel() {
    setModels((prev) => [...prev, { id: '', ...emptyModel }])
  }

  function removeModel(i: number) {
    setModels((prev) => prev.filter((_, idx) => idx !== i))
  }

  function addPreset(preset: typeof PRESETS[number]) {
    setModels((prev) => [...prev, { id: '', ...preset.model }])
  }

  if (!settings) return null

  return (
    <div className="page">
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1>Settings</h1>
          <p>Configure your profile and AI integration</p>
        </div>
        <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
          {saving ? 'Saving...' : saved ? 'Saved!' : 'Save settings'}
        </button>
      </div>

      {encryptionMode === 'plaintext-fallback' && (
        <div className="alert alert-warning" style={{ maxWidth: 800 }}>
          <strong>Encryption unavailable.</strong> Your OS keyring is not accessible, so your data (CV, contacts, applications) is being stored <strong>encrypted with a key sitting in plaintext next to it</strong>. This is better than nothing, but treat this machine as untrusted.
        </div>
      )}

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
        <div className="form-group" style={{ marginTop: 4 }}>
          <label>Deleted-jobs blacklist cap</label>
          <input
            type="number"
            min={100}
            step={1000}
            value={settings.deleted_jobs_cap}
            onChange={(e) => {
              const n = parseInt(e.target.value, 10)
              if (!isNaN(n) && n > 0) update('deleted_jobs_cap', n)
            }}
          />
          <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
            How many manually-deleted low-fit jobs to remember so the scanner doesn't re-add them. Older entries are dropped when this cap is exceeded.
          </p>
        </div>
        <div className="form-group" style={{ marginTop: 4 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              type="checkbox"
              checked={settings.auto_scan_enabled}
              onChange={(e) => update('auto_scan_enabled', e.target.checked)}
            />
            Run job scan automatically in the background
          </label>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4, marginLeft: 24 }}>
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Every</span>
            <input
              type="number"
              min={5}
              step={5}
              style={{ width: 80 }}
              value={settings.auto_scan_interval_minutes}
              onChange={(e) => {
                const n = parseInt(e.target.value, 10)
                if (!isNaN(n) && n > 0) update('auto_scan_interval_minutes', n)
              }}
            />
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>minutes after the last scan completes</span>
          </div>
          <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4, marginLeft: 24 }}>
            Auto-scans use all job boards, all work types, and your saved Preferred location. The scan runs while the app is open; you'll see progress in the Scan Jobs tab.
          </p>
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

      <div className="section-title">AI models</div>
      <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
        Add one or more AI providers. The app tries each model in order until one succeeds.
      </p>

      {models.map((model, i) => (
        <div className="card" style={{ maxWidth: 800, marginBottom: 12 }} key={i}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <strong style={{ fontSize: 13 }}>Model {i + 1}{i === 0 ? ' (default)' : ''}</strong>
            {models.length > 1 && (
              <button className="btn btn-secondary btn-sm" onClick={() => removeModel(i)}>Remove</button>
            )}
          </div>
          <div className="form-row">
            <div className="form-group">
              <label>Name</label>
              <input value={model.name} onChange={(e) => updateModel(i, 'name', e.target.value)} placeholder="e.g. DeepSeek, Groq" />
            </div>
            <div className="form-group">
              <label>Model</label>
              <input value={model.model} onChange={(e) => updateModel(i, 'model', e.target.value)} placeholder="deepseek-chat" />
            </div>
          </div>
          <div className="form-group">
            <label>Base URL</label>
            <input value={model.base_url} onChange={(e) => updateModel(i, 'base_url', e.target.value)} placeholder="https://api.deepseek.com" />
          </div>
          <div className="form-group">
            <label>API key</label>
            <input
              type="password"
              value={model.api_key}
              onChange={(e) => updateModel(i, 'api_key', e.target.value)}
              placeholder={i === 0 ? 'sk-... (free at platform.deepseek.com)' : 'sk-... (optional)'}
            />
          </div>
        </div>
      ))}

      <button className="btn btn-secondary btn-sm" onClick={addModel} style={{ marginBottom: 16 }}>
        + Add blank model
      </button>

      <div style={{ marginBottom: 20 }}>
        <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8, fontWeight: 600 }}>Presets — click to add</p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {PRESETS.map((p) => {
            const isAdded = models.some(
              (m) => m.base_url === p.model.base_url && m.model === p.model.model
            )
            return (
              <button
                key={p.name}
                className="btn btn-secondary btn-sm"
                onClick={() => addPreset(p)}
                title={isAdded ? `${p.desc} (already added)` : p.desc}
                disabled={isAdded}
                style={isAdded ? { opacity: 0.4, cursor: 'not-allowed' } : undefined}
              >
                {isAdded ? `✓ ${p.name}` : p.name}
              </button>
            )
          })}
        </div>
      </div>

      <hr style={{ border: 'none', borderTop: '1px solid var(--border)', margin: '32px 0' }} />

      <div className="section-title">Data export</div>

      <div className="card" style={{ maxWidth: 600, marginBottom: 12 }}>
        <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
          Export all your data (jobs, documents, applications, follow-ups, interviews) to a JSON file. API keys and password fields are not included.
        </p>
        <button
          className="btn btn-secondary"
          onClick={async () => {
            const path = await api.exportAllData()
            if (path) {
              window.alert(`Exported to:\n${path}`)
            }
          }}
        >
          Export all data
        </button>
      </div>

      <div className="section-title" style={{ color: 'var(--danger)' }}>Danger zone</div>

      <div className="card" style={{ maxWidth: 600, marginBottom: 12 }}>
        <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
          Clears the scan memory so previously seen job URLs will be re-scraped on the next scan. All existing jobs, documents, applications, follow-ups, and interviews are preserved.
        </p>
        <button
          className="btn btn-danger"
          onClick={async () => {
            if (!window.confirm('Clear scan memory? URLs already in your job board will be re-scraped next time you scan.')) return
            await api.clearSeenUrls()
          }}
        >
          Delete scan memory
        </button>
      </div>

      <div className="card" style={{ maxWidth: 600 }}>
        <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
          This will permanently delete all jobs, documents, applications, follow-ups, and interviews. Your settings and AI model configs will be preserved.
        </p>
        <button
          className="btn btn-danger"
          onClick={async () => {
            if (!window.confirm('Are you sure? This will delete ALL jobs, documents, applications, follow-ups, and interviews. This cannot be undone.')) return
            if (!window.confirm('Really? There is no undo. All your job data will be gone.')) return
            await api.clearAllData()
            window.location.reload()
          }}
        >
          Clear all data
        </button>
      </div>
    </div>
  )
}