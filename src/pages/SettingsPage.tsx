import { useEffect, useState } from 'react'
import { api } from '../api'
import type { ApiModelConfig, Settings } from '../types'
import { notify } from '../components/Notifications'
import Modal from '../components/Modal'
import { BOARD_TYPES } from '../boardTypes'

const PRESETS: { name: string; desc: string; model: Omit<ApiModelConfig, 'id'> }[] = [
  { name: 'Big Pickle', desc: 'Free, no API key needed', model: { name: 'Big Pickle', base_url: 'https://opencode.ai/zen/v1', api_key: '', model: 'big-pickle' } },
  { name: 'DeepSeek V4 Flash Free', desc: 'via OpenRouter (needs API key)', model: { name: 'DeepSeek V4 Flash', base_url: 'https://openrouter.ai/api/v1', api_key: '', model: 'deepseek/deepseek-v4-flash:free' } },
  { name: 'MiMo V2.5 Free', desc: 'Free, no API key needed', model: { name: 'MiMo V2.5', base_url: 'https://opencode.ai/zen/v1', api_key: '', model: 'mimo-v2.5-free' } },
  { name: 'Nemotron 3 Ultra Free', desc: 'via OpenRouter (needs API key)', model: { name: 'Nemotron 3 Ultra', base_url: 'https://openrouter.ai/api/v1', api_key: '', model: 'nvidia/nemotron-3-ultra-550b-a55b:free' } },
  { name: 'North Mini Code Free', desc: 'Free, no API key needed', model: { name: 'North Mini Code', base_url: 'https://opencode.ai/zen/v1', api_key: '', model: 'north-mini-code-free' } }
]

type Tab = 'profile' | 'models' | 'boards' | 'companies' | 'scan' | 'data'

export default function SettingsPage() {
  const [tab, setTab] = useState<Tab>('profile')
  const [settings, setSettings] = useState<Settings | null>(null)
  const [models, setModels] = useState<ApiModelConfig[]>([])
  const [dragging, setDragging] = useState<number | null>(null)
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
  const [restorePreview, setRestorePreview] = useState<null | {
    wrapped?: boolean
    signed?: boolean
    hasKdf?: boolean
    hasWrappedKey?: boolean
    hasLegacyKey?: boolean
    requiresPassphrase?: boolean
    schema?: number
    encryptionMode?: string
    createdAt?: string
    fileCount?: number
    manifestError?: string
  }>(null)
  const [restorePassphrase, setRestorePassphrase] = useState('')
  const [passphraseModalOpen, setPassphraseModalOpen] = useState(false)
  const [passphraseInput, setPassphraseInput] = useState('')
  const [passphraseConfirm, setPassphraseConfirm] = useState('')
  // Boards tab state. `boards` is the full list from main; `disabled`
  // is the set mirror of settings.disabled_boards. Kept as Set for
  // O(1) membership checks during render of the toggle grid.
  const [boards, setBoards] = useState<{ name: string; useBrowser: boolean; enabled: boolean }[]>([])
  const [disabled, setDisabled] = useState<Set<string>>(new Set())
  const [boardsSaving, setBoardsSaving] = useState(false)

  // Lazy-load the boards list the first time the user opens the
  // Boards tab. Cheaper than loading on every Settings mount, and
  // the data is only needed when the user is on that tab. Re-runs
  // when the user toggles a board and hits the sidebar refresh, via
  // the app:refresh event handler below.
  useEffect(() => {
    if (tab !== 'boards') return
    let cancelled = false
    api.listBoards().then((list) => {
      if (cancelled) return
      setBoards(list)
      // Initialize the disabled set from settings on first load.
      // The settings list may have stale names (board renamed/removed
      // in a future version) — keep only the ones that match a real
      // board so the disabled set stays authoritative.
      api.getSettings().then((settings) => {
        if (cancelled) return
        const realNames = new Set(list.map((b) => b.name))
        setDisabled(new Set((settings.disabled_boards || []).filter((n) => realNames.has(n))))
      }).catch(() => { /* settings load failed; user will see empty list */ })
    }).catch(() => { /* list load failed; user will see empty list */ })
    return () => { cancelled = true }
  }, [tab])

  // Listen for sidebar refresh while the Boards tab is mounted —
  // re-pull the list so toggles the user made in another tab surface.
  useEffect(() => {
    const onRefresh = () => {
      if (tab !== 'boards') return
      api.listBoards().then((list) => {
        setBoards(list)
        const realNames = new Set(list.map((b) => b.name))
        setDisabled((prev) => new Set([...prev].filter((n) => realNames.has(n))))
      }).catch(() => { /* ignore */ })
    }
    window.addEventListener('app:refresh', onRefresh)
    return () => window.removeEventListener('app:refresh', onRefresh)
  }, [tab])

  // Toggle a single board on/off. Persists the full disabled_boards
  // list via the existing settings:update IPC. Optimistic update
  // (state flips immediately, revert on error).
  async function toggleBoard(name: string, on: boolean) {
    setBoardsSaving(true)
    const next = new Set(disabled)
    if (on) next.delete(name); else next.add(name)
    setDisabled(next)
    try {
      await api.updateSettings({ disabled_boards: Array.from(next) })
    } catch (err) {
      notify(`Failed to save board toggle: ${err instanceof Error ? err.message : 'Unknown error'}`, 'error')
      // Revert.
      setDisabled(disabled)
    } finally {
      setBoardsSaving(false)
    }
  }

  // Toggle every board in a BOARD_TYPES category at once. If all
  // are currently enabled, disabling sets the full list; if any
  // are disabled, enabling turns them all back on. Two states only
  // per the toggle-button-hide-empty-2state convention.
  async function toggleCategory(boardsInCategory: string[], allOn: boolean) {
    setBoardsSaving(true)
    const next = new Set(disabled)
    for (const n of boardsInCategory) {
      if (allOn) next.add(n); else next.delete(n)
    }
    setDisabled(next)
    try {
      await api.updateSettings({ disabled_boards: Array.from(next) })
    } catch (err) {
      notify(`Failed to save category toggle: ${err instanceof Error ? err.message : 'Unknown error'}`, 'error')
      setDisabled(disabled)
    } finally {
      setBoardsSaving(false)
    }
  }

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
      // Free public job APIs default to enabled for first-time users.
      // Existing users with `false` (explicitly disabled) keep their choice.
      if (typeof s.aggregator_remotive_enabled !== 'boolean') s.aggregator_remotive_enabled = true
      if (typeof s.aggregator_arbeitnow_enabled !== 'boolean') s.aggregator_arbeitnow_enabled = true
      if (typeof s.aggregator_jobicy_enabled !== 'boolean') s.aggregator_jobicy_enabled = true
      if (typeof s.aggregator_himalayas_enabled !== 'boolean') s.aggregator_himalayas_enabled = true
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
    // If the chosen folder is on a synced/cloud drive, the main
    // process flags it. Require explicit confirmation before saving.
    if (picked.warning) {
      const ok = window.confirm(`${picked.warning}\n\nContinue with this folder?`)
      if (!ok) return
    }
    const updated = await api.updateSettings({ backup_path: picked.path })
    setSettings(updated)
    setBackupError('')
  }

  async function handleClearBackupFolder() {
    const updated = await api.updateSettings({ backup_path: '' })
    setSettings(updated)
  }

  function handleBackupNow() {
    if (!settings?.backup_path) return
    // If a passphrase is already configured, run the backup
    // immediately with it — no prompt. The user can change the
    // passphrase via the auto-backup banner's "Disable" + a new
    // "Backup now" flow, or by clearing settings.
    if (settings.passphrase) {
      void runBackupWithPassphrase(settings.passphrase)
      return
    }
    setPassphraseInput('')
    setPassphraseConfirm('')
    setPassphraseModalOpen(true)
  }

  async function runBackupWithPassphrase(passphrase: string) {
    if (!settings?.backup_path) return
    setBackupBusy(true)
    setBackupError('')
    try {
      const result = await api.runBackup(settings.backup_path, passphrase)
      if (result.ok) {
        setBackupLastSuccessAt(new Date().toISOString())
        setBackupLastError('')
        notify('Backup complete.', 'success', 2500)
      } else {
        setBackupError(result.error || 'Backup failed')
      }
    } catch (err) {
      setBackupError(err instanceof Error ? err.message : String(err))
    } finally {
      setBackupBusy(false)
    }
  }

  async function handleConfirmBackup() {
    if (!settings?.backup_path) return
    if (passphraseInput.length < 8) {
      notify('Passphrase must be at least 8 characters.', 'warning')
      return
    }
    if (passphraseInput !== passphraseConfirm) {
      notify('Passphrases do not match.', 'warning')
      return
    }
    setPassphraseModalOpen(false)
    setBackupBusy(true)
    setBackupError('')
    try {
      const result = await api.runBackup(settings.backup_path, passphraseInput)
      if (result.ok) {
        // Persist the passphrase for close-time auto-backup. It
        // lives in the encrypted store file under the same DEK
        // that protects the rest of the data, so storing it
        // alongside other settings is acceptable: the on-disk
        // threat model is "attacker who can read the data file
        // can also read the passphrase", which they could
        // already do via an un-wrapped backup. The protection
        // we offer is against a stolen backup file on its own.
        await api.updateSettings({ passphrase: passphraseInput })
        const refreshed = await api.getSettings()
        setSettings(refreshed)
        setBackupLastSuccessAt(new Date().toISOString())
        setBackupLastError('')
        setPassphraseInput('')
        setPassphraseConfirm('')
        notify('Backup complete. Close-time auto-backup is now enabled.', 'success', 4000)
      } else {
        setBackupError(result.error || 'Backup failed')
      }
    } catch (err) {
      setBackupError(err instanceof Error ? err.message : String(err))
    } finally {
      setBackupBusy(false)
    }
  }

  function handleCancelPassphrase() {
    setPassphraseModalOpen(false)
    setPassphraseInput('')
    setPassphraseConfirm('')
  }

  async function handleClearPassphrase() {
    if (!window.confirm('Disable close-time auto-backup? Manual backups will still work but you will be asked for a passphrase each time.')) return
    const updated = await api.updateSettings({ passphrase: '' })
    setSettings(updated)
  }

  async function handleOpenRestore() {
    setRestoreOpen(true)
    setRestoreSelected(null)
    setRestorePreview(null)
    setRestorePassphrase('')
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

  async function handleSelectBackup(b: { name: string; path: string; createdAt: string }) {
    setRestoreSelected(b)
    setRestorePreview(null)
    setRestoreError('')
    try {
      const preview = await api.previewBackup(b.path)
      setRestorePreview(preview)
    } catch (err) {
      setRestoreError(err instanceof Error ? err.message : String(err))
    }
  }

  function handleCloseRestore() {
    if (restoreBusy) return
    setRestoreOpen(false)
    setRestoreSelected(null)
    setRestorePreview(null)
    setRestorePassphrase('')
    setRestoreError('')
  }

  async function handleConfirmRestore() {
    if (!restoreSelected) return
    const preview = restorePreview
    if (preview?.requiresPassphrase && !restorePassphrase) {
      setRestoreError('Enter the passphrase for this backup.')
      return
    }
    if (preview?.hasLegacyKey && !preview.requiresPassphrase) {
      const ok = window.confirm(
        'This backup is in the legacy (un-wrapped) format. The encryption key will be restored as-is, meaning the backup file alone is enough to decrypt your data. Continue?'
      )
      if (!ok) return
    }
    setRestoreBusy(true)
    setRestoreError('')
    try {
      const result = await api.restoreBackup(
        restoreSelected.path,
        restorePassphrase || undefined
      )
      if (!result.ok) {
        setRestoreError(result.error || 'Restore failed')
        setRestoreBusy(false)
        return
      }
      if (result.warning) {
        notify(result.warning, 'warning', 8000)
      } else {
        notify('Backup restored. Reloading…', 'success', 3000)
      }
      // The main process has re-read the data file from disk and
      // discarded its in-memory cache. Force the renderer to
      // re-mount from scratch so every component picks up the
      // restored data.
      setTimeout(() => {
        window.location.reload()
      }, 600)
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

  function moveModel(from: number, to: number) {
    if (from === to) return
    setModels((prev) => {
      const next = [...prev]
      const [m] = next.splice(from, 1)
      next.splice(to, 0, m)
      // Auto-save on drop / arrow click. Catch and roll back on failure
      // so the on-screen order matches the persisted order.
      api.saveApiModels(next).catch((err) => {
        notify(`Failed to save model order: ${err.message}`, 'error')
        setModels(prev)
      })
      return next
    })
  }

  function handleDeleteModel(i: number) {
    const m = models[i]
    if (!m) return
    const label = m.name || `Model ${i + 1}`
    if (!confirm(`Delete ${label}? This cannot be undone.`)) return
    const next = models.filter((_, idx) => idx !== i)
    setModels(next)
    api.saveApiModels(next).catch((err) => {
      notify(`Failed to save model changes: ${err.message}`, 'error')
    })
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
    <div className="page settings-page">
      <div className="settings-page-sticky">
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

        <div style={{ display: 'flex', gap: 4, marginTop: 16 }}>
          {([
            { id: 'profile', label: 'My Profile' },
            { id: 'models', label: 'Models' },
            { id: 'boards', label: 'Boards' },
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
      </div>

      {encryptionMode === 'plaintext-fallback' && (
        <div className="alert alert-warning">
          <strong>Encryption unavailable.</strong> Your OS keyring is not accessible, so your data (CV, contacts, applications) is being stored <strong>encrypted with a key sitting in plaintext next to it</strong>. This is better than nothing, but treat this machine as untrusted.
        </div>
      )}

      {/* tab content follows below; unchanged from before */}

      {tab === 'profile' && (
        <>
          <div className="section-title">Your Profile</div>
          <div className="card">
            {/* All 4 fields on a single row, wrapping on narrow screens.
                The .form-row-wrap utility (see global.css) uses flex+wrap
                with min-width: 180px per child so a narrow window
                reflows cleanly without input fields being crushed. */}
            <div className="form-row-wrap">
              <div className="form-group">
                <label>Full name</label>
                <input value={settings.user_name} onChange={(e) => update('user_name', e.target.value)} />
              </div>
              <div className="form-group">
                <label>Email</label>
                <input value={settings.user_email} onChange={(e) => update('user_email', e.target.value)} />
              </div>
              <div className="form-group">
                <label>Default scan keywords</label>
                <input
                  value={settings.job_search_keywords ?? ''}
                  onChange={(e) => update('job_search_keywords', e.target.value)}
                  placeholder="e.g. senior analyst, data engineer"
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

          <div className="section-title">Base CV</div>
          <div className="card">
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
          <div className="section-title">Job Scan</div>
          <div className="card">
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
          <div className="section-title">Models</div>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
            Add one or more AI providers. The app tries each <strong>enabled</strong> model in order until one succeeds. Toggle a model off to temporarily disable it without losing its config.
          </p>

          {models.every((m) => m.enabled === false) && (
            <div className="alert alert-warning" style={{ marginBottom: 12 }}>
              All models are disabled — AI features (generation, verification, fit scoring) will fail.
            </div>
          )}

          {models.map((model, i) => (
            <div
              className={`card ${dragging === i ? 'model-card-dragging' : ''}`}
              style={{ marginBottom: 12, opacity: dragging === i ? 0.5 : (model.enabled === false ? 0.55 : 1) }}
              key={i}
            >
              <div
                style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, gap: 12 }}
                onDragOver={(e) => {
                  if (dragging === null) return
                  e.preventDefault()
                  e.currentTarget.classList.add('model-card-drop-target')
                }}
                onDragLeave={(e) => {
                  e.currentTarget.classList.remove('model-card-drop-target')
                }}
                onDrop={(e) => {
                  e.currentTarget.classList.remove('model-card-drop-target')
                  if (dragging === null || dragging === i) return
                  moveModel(dragging, i)
                  setDragging(null)
                }}
              >
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
                <div className="model-actions" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <span
                    className="model-drag-handle"
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData('text/plain', String(i))
                      e.dataTransfer.effectAllowed = 'move'
                      setDragging(i)
                    }}
                    onDragEnd={() => {
                      setDragging(null)
                      // Clear any lingering drop-target highlights (defensive —
                      // onDragLeave on the target usually fires first).
                      document.querySelectorAll('.model-card-drop-target').forEach((el) => el.classList.remove('model-card-drop-target'))
                    }}
                    title="Drag to reorder"
                    aria-label="Drag to reorder"
                    role="button"
                  >
                    <svg width="10" height="16" viewBox="0 0 10 16" aria-hidden="true">
                      <circle cx="2" cy="3" r="1.2" fill="currentColor" />
                      <circle cx="8" cy="3" r="1.2" fill="currentColor" />
                      <circle cx="2" cy="8" r="1.2" fill="currentColor" />
                      <circle cx="8" cy="8" r="1.2" fill="currentColor" />
                      <circle cx="2" cy="13" r="1.2" fill="currentColor" />
                      <circle cx="8" cy="13" r="1.2" fill="currentColor" />
                    </svg>
                  </span>
                  <button
                    className="icon-btn"
                    onClick={() => moveModel(i, i - 1)}
                    disabled={i === 0}
                    title="Move model up"
                    aria-label="Move model up"
                  >
                    ↑
                  </button>
                  <button
                    className="icon-btn"
                    onClick={() => moveModel(i, i + 1)}
                    disabled={i === models.length - 1}
                    title="Move model down"
                    aria-label="Move model down"
                  >
                    ↓
                  </button>
                  <button
                    className="icon-btn icon-btn-danger"
                    onClick={() => handleDeleteModel(i)}
                    title="Delete model"
                    aria-label="Delete model"
                  >
                    <span aria-hidden="true">✕</span>
                  </button>
                </div>
              </div>
              <div className="form-row-wrap">
                <div className="form-group">
                  <label>Name</label>
                  <input value={model.name} onChange={(e) => updateModel(i, 'name', e.target.value)} placeholder="e.g. DeepSeek, Groq" />
                </div>
                <div className="form-group">
                  <label>Model</label>
                  <input value={model.model} onChange={(e) => updateModel(i, 'model', e.target.value)} placeholder="deepseek-chat" />
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

      {tab === 'boards' && (
        <>
          <div className="section-title">Job Boards</div>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
            Toggle individual boards or entire categories on or off. Disabled boards won't appear in the scan page picker and won't be scraped, even if they're in your saved selection.
          </p>

          {boards.length === 0 ? (
            <div className="card" style={{ padding: 16, fontSize: 13, color: 'var(--text-muted)', textAlign: 'center', fontStyle: 'italic' }}>
              {boardsSaving ? 'Saving…' : 'Loading boards…'}
            </div>
          ) : (
            <>
              {BOARD_TYPES.map((t) => {
                // Filter to boards the user can actually toggle —
                // boards in the category that exist in the loaded
                // list. A category that ends up empty (every board
                // renamed/removed) is hidden entirely.
                const inCategory = t.boards.filter((n) => boards.some((b) => b.name === n))
                if (inCategory.length === 0) return null
                const allEnabled = inCategory.every((n) => !disabled.has(n))
                const anyEnabled = inCategory.some((n) => !disabled.has(n))
                // Two-state label per project convention: "+" adds,
                // "−" removes. When everything in the category is
                // already on, the button flips to "− All <Category>".
                const categoryLabel = allEnabled
                  ? `− ${t.label}`
                  : `+ ${t.label}`
                const enabledCount = inCategory.length - inCategory.filter((n) => disabled.has(n)).length
                return (
                  <div key={t.label} className="card" style={{ marginBottom: 12, padding: 0 }}>
                    <div style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      padding: '10px 16px',
                      borderBottom: '1px solid var(--border)'
                    }}>
                      <div>
                        <strong style={{ fontSize: 14 }}>{t.label}</strong>
                        <span style={{ marginLeft: 8, fontSize: 12, color: 'var(--text-muted)' }}>
                          {anyEnabled ? `${enabledCount} of ${inCategory.length} enabled` : 'all disabled'}
                        </span>
                      </div>
                      <button
                        className="btn btn-secondary btn-sm"
                        disabled={boardsSaving}
                        onClick={() => toggleCategory(inCategory, allEnabled)}
                      >
                        {categoryLabel}
                      </button>
                    </div>
                    {/*
                      Compact multi-column checkbox grid, mirroring the
                      scan page board picker. Each board is a single
                      label in the grid; the checkbox state is the
                      only on/off indicator (no "Enabled/Disabled" text,
                      no per-row border). Disabled boards fade to ~55%
                      opacity so the user can see them but they're
                      visually de-emphasized.
                    */}
                    <div style={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
                      gap: 4,
                      padding: 8
                    }}>
                      {[...boards]
                        .filter((b) => inCategory.includes(b.name))
                        .sort((a, b) => a.name.localeCompare(b.name))
                        .map((b) => {
                          const isOn = !disabled.has(b.name)
                          return (
                            <label
                              key={b.name}
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 6,
                                fontSize: 13,
                                cursor: 'pointer',
                                minWidth: 0,
                                opacity: isOn ? 1 : 0.55
                              }}
                            >
                              <input
                                type="checkbox"
                                checked={isOn}
                                disabled={boardsSaving}
                                onChange={(e) => toggleBoard(b.name, e.target.checked)}
                              />
                              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flexShrink: 1 }}>
                                {b.name}
                              </span>
                              <span style={{
                                fontSize: 10,
                                color: 'var(--text-muted)',
                                textTransform: 'uppercase',
                                letterSpacing: 0.5,
                                border: '1px solid var(--border)',
                                borderRadius: 3,
                                padding: '1px 5px',
                                flexShrink: 0
                              }} title={b.useBrowser ? 'Uses a browser session to scrape' : 'HTTP-only'}>
                                {b.useBrowser ? 'browser' : 'http'}
                              </span>
                            </label>
                          )
                        })}
                    </div>
                  </div>
                )
              })}

              {(() => {
                // Boards not classified under any BOARD_TYPES category.
                // These still need toggles — they appear in the scan
                // picker too, just without a category header.
                const classified = new Set(BOARD_TYPES.flatMap((t) => t.boards))
                const uncategorized = boards.filter((b) => !classified.has(b.name))
                if (uncategorized.length === 0) return null
                return (
                  <div className="card" style={{ padding: 0 }}>
                    <div style={{
                      padding: '10px 16px',
                      borderBottom: '1px solid var(--border)'
                    }}>
                      <strong style={{ fontSize: 14 }}>Other</strong>
                    </div>
                    <div style={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
                      gap: 4,
                      padding: 8
                    }}>
                      {uncategorized
                        .sort((a, b) => a.name.localeCompare(b.name))
                        .map((b) => {
                          const isOn = !disabled.has(b.name)
                          return (
                            <label
                              key={b.name}
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 6,
                                fontSize: 13,
                                cursor: 'pointer',
                                minWidth: 0,
                                opacity: isOn ? 1 : 0.55
                              }}
                            >
                              <input
                                type="checkbox"
                                checked={isOn}
                                disabled={boardsSaving}
                                onChange={(e) => toggleBoard(b.name, e.target.checked)}
                              />
                              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flexShrink: 1 }}>
                                {b.name}
                              </span>
                              <span style={{
                                fontSize: 10,
                                color: 'var(--text-muted)',
                                textTransform: 'uppercase',
                                letterSpacing: 0.5,
                                border: '1px solid var(--border)',
                                borderRadius: 3,
                                padding: '1px 5px',
                                flexShrink: 0
                              }} title={b.useBrowser ? 'Uses a browser session to scrape' : 'HTTP-only'}>
                                {b.useBrowser ? 'browser' : 'http'}
                              </span>
                            </label>
                          )
                        })}
                    </div>
                  </div>
                )
              })()}
            </>
          )}
        </>
      )}

      {tab === 'companies' && (
        <>
          <div className="section-title">Blacklisted Companies</div>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
            Jobs from these companies are never added by the scanner, and won't be re-added on future scans. You can also blacklist a company directly from any job's page.
          </p>

          <div className="card" style={{ marginBottom: 16 }}>
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
            <div className="card" style={{ padding: 16, fontSize: 13, color: 'var(--text-muted)', textAlign: 'center', fontStyle: 'italic' }}>
              No blacklisted companies yet.
            </div>
          ) : (
            <div className="card" style={{ padding: 0 }}>
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
          <div className="section-title">Data Backup</div>

          <div className="card" style={{ marginBottom: 12 }}>
            <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
              Choose a folder where backups of your data and encryption key are saved. Backups are passphrase-protected; the passphrase is required to restore.
            </p>
            {settings?.backup_path && !settings.passphrase && (
              <div
                style={{
                  fontSize: 12,
                  color: 'var(--text)',
                  background: 'rgba(234, 179, 8, 0.1)',
                  border: '1px solid rgba(234, 179, 8, 0.4)',
                  borderRadius: 6,
                  padding: '8px 10px',
                  marginBottom: 10
                }}
              >
                Close-time auto-backup is <strong>disabled</strong> because no passphrase is set. Click "Backup now" to create a passphrase-protected backup and enable auto-backup.
              </div>
            )}
            {settings?.passphrase && (
              <div
                style={{
                  fontSize: 12,
                  color: 'var(--text-muted)',
                  background: 'var(--bg)',
                  border: '1px solid var(--border)',
                  borderRadius: 6,
                  padding: '8px 10px',
                  marginBottom: 10,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 8
                }}
              >
                <span>Close-time auto-backup is enabled.</span>
                <span style={{ display: 'flex', gap: 6 }}>
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={() => {
                      setPassphraseInput('')
                      setPassphraseConfirm('')
                      setPassphraseModalOpen(true)
                    }}
                  >
                    Change passphrase
                  </button>
                  <button className="btn btn-secondary btn-sm" onClick={handleClearPassphrase}>
                    Disable
                  </button>
                </span>
              </div>
            )}
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
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <button
                className="btn btn-primary"
                onClick={handleBackupNow}
                disabled={!settings?.backup_path || backupBusy}
              >
                {backupBusy ? 'Backing up…' : 'Backup now'}
              </button>
              <button
                className="btn btn-secondary"
                onClick={handleOpenRestore}
                disabled={!settings?.backup_path}
                title={settings?.backup_path ? 'Restore from a previous backup' : 'Set a backup folder first'}
              >
                Restore Backup…
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
          </div>

          <Modal
            open={passphraseModalOpen}
            title="Passphrase for backup"
            onClose={handleCancelPassphrase}
            actions={
              <>
                <button className="btn btn-secondary" onClick={handleCancelPassphrase} disabled={backupBusy}>
                  Cancel
                </button>
                <button className="btn btn-primary" onClick={handleConfirmBackup} disabled={backupBusy}>
                  Backup
                </button>
              </>
            }
          >
            <p style={{ fontSize: 13, marginTop: 0 }}>
              The backup will be encrypted with this passphrase. You will need it to restore.
            </p>
            <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
              The passphrase is stored in your local settings (encrypted with the OS keychain) so the app can auto-back up on close. Use a strong passphrase you can remember — if you lose it, the backups cannot be recovered.
            </p>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 500, marginBottom: 4 }}>
              Passphrase (min 8 characters)
            </label>
            <input
              type="password"
              value={passphraseInput}
              onChange={(e) => setPassphraseInput(e.target.value)}
              autoFocus
              style={{ width: '100%', marginBottom: 12 }}
            />
            <label style={{ display: 'block', fontSize: 12, fontWeight: 500, marginBottom: 4 }}>
              Confirm passphrase
            </label>
            <input
              type="password"
              value={passphraseConfirm}
              onChange={(e) => setPassphraseConfirm(e.target.value)}
              style={{ width: '100%' }}
            />
          </Modal>

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
                      onClick={() => handleSelectBackup(b)}
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
                  This will <strong>overwrite your current data file</strong> with the contents of this backup. Anything created after the backup will be lost. The app will reload automatically.
                </p>
                <p style={{ color: 'var(--text-muted)', fontSize: 12 }}>
                  Backup from {new Date(restoreSelected.createdAt).toLocaleString()}
                </p>
                {restorePreview ? (
                  <div
                    style={{
                      fontSize: 12,
                      background: 'var(--bg)',
                      border: '1px solid var(--border)',
                      borderRadius: 6,
                      padding: '8px 10px',
                      marginTop: 12,
                      marginBottom: 12
                    }}
                  >
                    {restorePreview.manifestError ? (
                      <p style={{ margin: 0, color: 'var(--danger)' }}>
                        Could not read manifest: {restorePreview.manifestError}
                      </p>
                    ) : (
                      <>
                        <div><strong>Format:</strong> {restorePreview.wrapped ? 'Passphrase-wrapped' : 'Legacy (un-wrapped)'}</div>
                        <div><strong>Signature:</strong> {restorePreview.signed ? 'HMAC-SHA256 (verified on restore)' : 'Not signed'}</div>
                        <div><strong>Encryption:</strong> {restorePreview.encryptionMode || 'unknown'}</div>
                        <div><strong>Schema:</strong> {restorePreview.schema ?? 'unknown'}</div>
                        <div><strong>Files in backup:</strong> {restorePreview.fileCount ?? '?'}</div>
                      </>
                    )}
                  </div>
                ) : (
                  <p style={{ color: 'var(--text-muted)', fontSize: 12 }}>Loading backup details…</p>
                )}
                {restorePreview?.hasLegacyKey && !restorePreview.requiresPassphrase && (
                  <p style={{ color: 'var(--warning, #eab308)', fontSize: 12, marginTop: 0 }}>
                    Warning: this is a legacy (un-wrapped) backup. Continuing will restore the encryption key as-is.
                  </p>
                )}
                {restorePreview?.requiresPassphrase && (
                  <>
                    <label style={{ display: 'block', fontSize: 12, fontWeight: 500, marginTop: 12, marginBottom: 4 }}>
                      Passphrase
                    </label>
                    <input
                      type="password"
                      value={restorePassphrase}
                      onChange={(e) => setRestorePassphrase(e.target.value)}
                      autoFocus
                      style={{ width: '100%' }}
                    />
                  </>
                )}
              </div>
            )}
          </Modal>

          <div className="section-title">Scan Memory</div>

          <div className="card" style={{ marginBottom: 12 }}>
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

          <div className="card" style={{ marginBottom: 12 }}>
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

          <div className="card">
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
