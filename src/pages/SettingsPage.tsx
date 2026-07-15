import { useEffect, useState } from 'react'
import { api } from '../api'
import type { ApiModelConfig, Settings } from '../types'
import { notify } from '../components/Notifications'
import Modal from '../components/Modal'

const PRESETS: { name: string; desc: string; model: Omit<ApiModelConfig, 'id'> }[] = [
  { name: 'Big Pickle', desc: 'Free, no API key needed', model: { name: 'Big Pickle', base_url: 'https://opencode.ai/zen/v1', api_key: '', model: 'big-pickle' } },
  { name: 'DeepSeek V4 Flash Free', desc: 'via OpenRouter (needs API key)', model: { name: 'DeepSeek V4 Flash', base_url: 'https://openrouter.ai/api/v1', api_key: '', model: 'deepseek/deepseek-v4-flash:free' } },
  { name: 'MiMo V2.5 Free', desc: 'Free, no API key needed', model: { name: 'MiMo V2.5', base_url: 'https://opencode.ai/zen/v1', api_key: '', model: 'mimo-v2.5-free' } },
  { name: 'Nemotron 3 Ultra Free', desc: 'via OpenRouter (needs API key)', model: { name: 'Nemotron 3 Ultra', base_url: 'https://openrouter.ai/api/v1', api_key: '', model: 'nvidia/nemotron-3-ultra-550b-a55b:free' } },
  { name: 'North Mini Code Free', desc: 'Free, no API key needed', model: { name: 'North Mini Code', base_url: 'https://opencode.ai/zen/v1', api_key: '', model: 'north-mini-code-free' } }
]

type Tab = 'profile' | 'models' | 'companies' | 'scan' | 'data'

export default function SettingsPage() {
  const [tab, setTab] = useState<Tab>('profile')
  const [settings, setSettings] = useState<Settings | null>(null)
  const [models, setModels] = useState<ApiModelConfig[]>([])
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [encryptionMode, setEncryptionMode] = useState<'sealed' | 'plaintext-fallback' | 'uninitialized' | null>(null)
  const [blacklist, setBlacklist] = useState<string[]>([])
  const [newBlacklistCompany, setNewBlacklistCompany] = useState('')
  const [backupBusy, setBackupBusy] = useState(false)
  const [backupError, setBackupError] = useState('')
  const [backupLastSuccessAt, setBackupLastSuccessAt] = useState('')
  const [backupLastError, setBackupLastError] = useState('')
  const [restoreOpen, setRestoreOpen] = useState(false)
  const [restoreBackups, setRestoreBackups] = useState<{ name: string; path: string; createdAt: string }[]>([])
  const [restoreLoading, setRestoreLoading] = useState(false)
  const [restoreError, setRestoreError] = useState('')
  const [restoreSelected, setRestoreSelected] = useState<{ name: string; path: string; createdAt: string } | null>(null)
  const [restoreBusy, setRestoreBusy] = useState(false)

  const emptyModel = { name: '', base_url: 'https://api.deepseek.com', api_key: '', model: 'deepseek-chat' }

  const loadSettings = () => {
    Promise.all([
      api.getSettings(),
      api.listApiModels(),
      api.getSecurityStatus(),
      api.listBlacklistedCompanies(),
      api.getBackupStatus()
    ]).then(([s, m, sec, bl, bkp]) => {
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
      setBlacklist(bl)
      setBackupLastSuccessAt(bkp.lastSuccessAt)
      setBackupLastError(bkp.lastError)
    })
  }

  async function handleChooseBackupFolder() {
    const picked = await api.pickBackupFolder()
    if (!picked) return
    const updated = await api.updateSettings({ backup_path: picked })
    setSettings(updated)
    setBackupError('')
  }

  async function handleClearBackupFolder() {
    const updated = await api.updateSettings({ backup_path: '' })
    setSettings(updated)
  }

  async function handleBackupNow() {
    if (!settings?.backup_path) return
    setBackupBusy(true)
    setBackupError('')
    try {
      const result = await api.runBackup(settings.backup_path)
      if (result.ok) {
        setBackupLastSuccessAt(new Date().toISOString())
        setBackupLastError('')
      } else {
        setBackupError(result.error || 'Backup failed')
      }
    } catch (err) {
      setBackupError(err instanceof Error ? err.message : String(err))
    } finally {
      setBackupBusy(false)
    }
  }

  async function handleOpenRestore() {
    setRestoreOpen(true)
    setRestoreSelected(null)
    setRestoreError('')
    setRestoreLoading(true)
    try {
      const list = await api.listBackups()
      setRestoreBackups(list)
    } catch (err) {
      setRestoreError(err instanceof Error ? err.message : String(err))
      setRestoreBackups([])
    } finally {
      setRestoreLoading(false)
    }
  }

  function handleCloseRestore() {
    if (restoreBusy) return
    setRestoreOpen(false)
    setRestoreSelected(null)
    setRestoreError('')
  }

  async function handleConfirmRestore() {
    if (!restoreSelected) return
    setRestoreBusy(true)
    setRestoreError('')
    try {
      const result = await api.restoreBackup(restoreSelected.path)
      if (!result.ok) {
        setRestoreError(result.error || 'Restore failed')
        setRestoreBusy(false)
        return
      }
      if (result.warning) {
        notify(result.warning, 'warning', 8000)
      }
      // App will be relaunched by the main process. Don't reset
      // restoreBusy — the page is about to be torn down.
    } catch (err) {
      setRestoreError(err instanceof Error ? err.message : String(err))
      setRestoreBusy(false)
    }
  }

  useEffect(() => {
    loadSettings()
  }, [])

  // Sidebar refresh button
  useEffect(() => {
    const onRefresh = () => { loadSettings() }
    window.addEventListener('app:refresh', onRefresh)
    return () => window.removeEventListener('app:refresh', onRefresh)
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

  function updateModel(i: number, field: keyof ApiModelConfig, value: string | boolean) {
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

  async function handleAddBlacklist() {
    const name = newBlacklistCompany.trim()
    if (!name) return
    const updated = await api.addBlacklistedCompany(name)
    setBlacklist(updated)
    setNewBlacklistCompany('')
    notify(`${name} blacklisted.`, 'info')
  }

  async function handleRemoveBlacklist(name: string) {
    const updated = await api.removeBlacklistedCompany(name)
    setBlacklist(updated)
    notify(`${name} removed from blacklist.`, 'info')
  }

  if (!settings) return null

  return (
    <div className="page">
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1>Settings</h1>
          <p>Configure your profile, AI integration, and data</p>
        </div>
        {(tab === 'profile' || tab === 'models') && (
          <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving...' : saved ? 'Saved!' : 'Save settings'}
          </button>
        )}
      </div>

      {encryptionMode === 'plaintext-fallback' && (
        <div className="alert alert-warning" style={{ maxWidth: 800 }}>
          <strong>Encryption unavailable.</strong> Your OS keyring is not accessible, so your data (CV, contacts, applications) is being stored <strong>encrypted with a key sitting in plaintext next to it</strong>. This is better than nothing, but treat this machine as untrusted.
        </div>
      )}

      <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--border)', marginBottom: 20 }}>
        {([
          { id: 'profile', label: 'Profile & CV' },
          { id: 'models', label: 'AI Models' },
          { id: 'companies', label: 'Companies' },
          { id: 'scan', label: 'Scan' },
          { id: 'data', label: 'Data' }
        ] as { id: Tab; label: string }[]).map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className="btn btn-sm"
            style={{
              background: 'transparent',
              border: 'none',
              borderBottom: tab === t.id ? '2px solid var(--accent)' : '2px solid transparent',
              color: tab === t.id ? 'var(--text)' : 'var(--text-muted)',
              borderRadius: 0,
              padding: '8px 16px',
              fontWeight: tab === t.id ? 600 : 400,
              cursor: 'pointer'
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'profile' && (
        <>
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
            <div className="form-row">
              <div className="form-group">
                <label>Phone</label>
                <input value={settings.user_phone} onChange={(e) => update('user_phone', e.target.value)} />
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
        </>
      )}

      {tab === 'scan' && (
        <>
          <div className="section-title">Job scan</div>
          <div className="card" style={{ maxWidth: 600 }}>
            <div className="form-group">
              <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input
                  type="checkbox"
                  checked={settings.auto_scan_enabled}
                  onChange={(e) => {
                    update('auto_scan_enabled', e.target.checked)
                    api.updateSettings({ auto_scan_enabled: e.target.checked })
                  }}
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
                  onBlur={() => {
                    if (settings) api.updateSettings({ auto_scan_interval_minutes: settings.auto_scan_interval_minutes })
                  }}
                />
                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>minutes after the last scan completes</span>
              </div>
              <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4, marginLeft: 24 }}>
                Auto-scans use all job boards, all work types, and your saved Preferred location. The scan runs while the app is open; you'll see progress in the Scan Jobs tab.
              </p>
            </div>
          </div>
        </>
      )}

      {tab === 'models' && (
        <>
          <div className="section-title">AI models</div>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
            Add one or more AI providers. The app tries each <strong>enabled</strong> model in order until one succeeds. Toggle a model off to temporarily disable it without losing its config.
          </p>

          {models.every((m) => m.enabled === false) && (
            <div className="alert alert-warning" style={{ maxWidth: 800, marginBottom: 12 }}>
              All models are disabled — AI features (generation, verification, fit scoring) will fail.
            </div>
          )}

          {models.map((model, i) => (
            <div
              className="card"
              style={{ maxWidth: 800, marginBottom: 12, opacity: model.enabled === false ? 0.55 : 1 }}
              key={i}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, gap: 12 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, flex: 1, minWidth: 0 }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={model.enabled !== false}
                      onChange={(e) => updateModel(i, 'enabled', e.target.checked)}
                      title="Enable or disable this model"
                    />
                  </label>
                  <strong style={{ fontSize: 13 }}>
                    {model.name || `Model ${i + 1}`}{i === 0 ? ' (default)' : ''}
                    {model.enabled === false && <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--text-muted)', fontWeight: 400 }}>(disabled)</span>}
                  </strong>
                </div>
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
        </>
      )}

      {tab === 'companies' && (
        <>
          <div className="section-title">Blacklisted companies</div>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12, maxWidth: 700 }}>
            Jobs from these companies are never added by the scanner, and won't be re-added on future scans. You can also blacklist a company directly from any job's page.
          </p>

          <div className="card" style={{ maxWidth: 700, marginBottom: 16 }}>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                value={newBlacklistCompany}
                onChange={(e) => setNewBlacklistCompany(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleAddBlacklist() }}
                placeholder="Company name (e.g. Acme Corp)"
                style={{ flex: 1 }}
              />
              <button
                className="btn btn-primary"
                onClick={handleAddBlacklist}
                disabled={!newBlacklistCompany.trim()}
              >
                Add to blacklist
              </button>
            </div>
          </div>

          {blacklist.length === 0 ? (
            <div className="card" style={{ maxWidth: 700, padding: 16, fontSize: 13, color: 'var(--text-muted)', textAlign: 'center', fontStyle: 'italic' }}>
              No blacklisted companies yet.
            </div>
          ) : (
            <div className="card" style={{ maxWidth: 700, padding: 0 }}>
              {blacklist.map((name, i) => (
                <div
                  key={name}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    padding: '10px 16px',
                    borderBottom: i < blacklist.length - 1 ? '1px solid var(--border)' : 'none'
                  }}
                >
                  <span style={{ fontSize: 13 }}>{name}</span>
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={() => handleRemoveBlacklist(name)}
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {tab === 'data' && (
        <>
          <div className="section-title">Data backup</div>

          <div className="card" style={{ maxWidth: 600, marginBottom: 12 }}>
            <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
              Choose a folder where backups of your data and encryption key are saved. A new backup zip is created automatically every time the app closes.
            </p>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
              <input
                type="text"
                readOnly
                value={settings?.backup_path || ''}
                placeholder="No backup folder set"
                style={{
                  flex: 1,
                  minWidth: 0,
                  fontFamily: 'ui-monospace, SFMono-Regular, monospace',
                  fontSize: 12,
                  color: settings?.backup_path ? 'var(--text)' : 'var(--text-muted)'
                }}
              />
              <button className="btn btn-secondary" onClick={handleChooseBackupFolder}>
                Choose folder…
              </button>
              {settings?.backup_path && (
                <button className="btn btn-secondary" onClick={handleClearBackupFolder}>
                  Clear
                </button>
              )}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <button
                className="btn btn-primary"
                onClick={handleBackupNow}
                disabled={!settings?.backup_path || backupBusy}
              >
                {backupBusy ? 'Backing up…' : 'Backup now'}
              </button>
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                {backupBusy
                  ? 'Backing up…'
                  : backupError
                    ? `Backup failed: ${backupError}`
                    : backupLastSuccessAt
                      ? `Last backup: ${new Date(backupLastSuccessAt).toLocaleString()}`
                      : settings?.backup_path
                        ? 'No backup has been made yet.'
                        : 'Choose a folder to enable backups.'}
              </span>
            </div>
            {!backupBusy && backupLastError && !backupError && (
              <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8, marginBottom: 0 }}>
                Note: an automatic backup on a previous app close failed — {backupLastError}
              </p>
            )}
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}>
              <button
                className="btn btn-secondary"
                onClick={handleOpenRestore}
                disabled={!settings?.backup_path}
                title={settings?.backup_path ? 'Restore from a previous backup' : 'Set a backup folder first'}
              >
                Restore Backup…
              </button>
            </div>
          </div>

          <Modal
            open={restoreOpen}
            title={restoreSelected ? `Restore ${restoreSelected.name}?` : 'Restore from backup'}
            onClose={handleCloseRestore}
            actions={
              restoreSelected ? (
                <>
                  <button
                    className="btn btn-secondary"
                    onClick={() => setRestoreSelected(null)}
                    disabled={restoreBusy}
                  >
                    Back
                  </button>
                  <button
                    className="btn btn-danger"
                    onClick={handleConfirmRestore}
                    disabled={restoreBusy}
                  >
                    {restoreBusy ? 'Restoring…' : 'Restore and restart'}
                  </button>
                </>
              ) : (
                <button className="btn btn-secondary" onClick={handleCloseRestore}>
                  Close
                </button>
              )
            }
          >
            {restoreError && (
              <p style={{ color: 'var(--danger)', fontSize: 13, marginBottom: 12 }}>{restoreError}</p>
            )}
            {!restoreSelected ? (
              restoreLoading ? (
                <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>Loading backups…</p>
              ) : restoreBackups.length === 0 ? (
                <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>
                  No backups found in {settings?.backup_path ? `${settings.backup_path}/flow_job_backups` : 'the backup folder'}.
                </p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 360, overflowY: 'auto' }}>
                  {restoreBackups.map((b) => (
                    <button
                      key={b.path}
                      onClick={() => setRestoreSelected(b)}
                      style={{
                        textAlign: 'left',
                        padding: '10px 12px',
                        background: 'var(--bg-elevated)',
                        border: '1px solid var(--border)',
                        borderRadius: 6,
                        cursor: 'pointer',
                        fontFamily: 'inherit',
                        fontSize: 13,
                        color: 'var(--text)'
                      }}
                    >
                      <div style={{ fontWeight: 500 }}>{b.name}</div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                        {new Date(b.createdAt).toLocaleString()}
                      </div>
                    </button>
                  ))}
                </div>
              )
            ) : (
              <div style={{ fontSize: 13, lineHeight: 1.5 }}>
                <p style={{ marginTop: 0 }}>
                  This will <strong>overwrite your current data file and encryption key</strong> with the contents of this backup. Any jobs, documents, applications, follow-ups, and interviews created after the backup will be lost. The app will restart automatically.
                </p>
                <p style={{ color: 'var(--text-muted)', fontSize: 12, marginBottom: 0 }}>
                  Backup from {new Date(restoreSelected.createdAt).toLocaleString()}
                </p>
              </div>
            )}
          </Modal>

          <div className="section-title">Scan memory</div>

          <div className="card" style={{ maxWidth: 600, marginBottom: 12 }}>
            <label style={{ display: 'block', fontSize: 13, fontWeight: 500, marginBottom: 6 }}>
              Deleted-jobs blacklist cap
            </label>
            <input
              type="number"
              min={100}
              step={1000}
              value={settings.deleted_jobs_cap}
              onChange={(e) => {
                const n = parseInt(e.target.value, 10)
                if (!isNaN(n) && n > 0) update('deleted_jobs_cap', n)
              }}
              onBlur={async () => {
                if (!settings) return
                await api.updateSettings({ deleted_jobs_cap: settings.deleted_jobs_cap })
              }}
              style={{ maxWidth: 200 }}
            />
            <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>
              How many manually-deleted low-fit jobs to remember so the scanner doesn't re-add them. Older entries are dropped when this cap is exceeded.
            </p>
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
        </>
      )}
    </div>
  )
}
