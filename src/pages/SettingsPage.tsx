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
  const [importing, setImporting] = useState(false)

  const emptyModel = { name: '', base_url: 'https://api.deepseek.com', api_key: '', model: 'deepseek-chat' }

  useEffect(() => {
    Promise.all([api.getSettings(), api.listApiModels()]).then(([s, m]) => {
      setSettings(s)
      setModels(m.length > 0 ? m : PRESETS.map((p, i) => ({ id: `model-${i + 1}`, ...p.model })))
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

  function update(field: keyof Settings, value: string) {
    setSettings((prev) => (prev ? { ...prev, [field]: value } : prev))
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
          Paste your master CV here, or import from a PDF or DOCX file. It will be used as the source material when tailoring for specific jobs.
        </p>
        <textarea
          rows={12}
          value={settings.base_cv}
          onChange={(e) => update('base_cv', e.target.value)}
          style={{ width: '100%', fontFamily: 'monospace', fontSize: 13 }}
          placeholder="Paste your full CV text here..."
        />
        <div style={{ marginTop: 8 }}>
          <button
            className="btn btn-secondary btn-sm"
            onClick={async () => {
              setImporting(true)
              try {
                const text = await api.importResume()
                if (text) update('base_cv', text)
              } finally {
                setImporting(false)
              }
            }}
            disabled={importing}
          >
            {importing ? 'Importing...' : 'Import from PDF/DOCX'}
          </button>
        </div>
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
          {PRESETS.map((p) => (
            <button key={p.name} className="btn btn-secondary btn-sm" onClick={() => addPreset(p)} title={p.desc}>
              {p.name}
            </button>
          ))}
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