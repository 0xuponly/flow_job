import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import type { ApiModelConfig, Settings } from '../types'
import {
  PROVIDER_SPEND_POLL_MS,
  providerSpendAsOf,
  providerSpendLines,
  type ProviderSpend
} from '../providerSpend'
import { notify } from '../components/Notifications'
import { LocationPicker } from '../components/LocationPicker'
import { parseLocationPicks } from '../utils'
import { inheritProviderApiKey } from '../apiModels'
import Modal from '../components/Modal'
import { BOARD_TYPES } from '../boardTypes'
import { errorText } from '../aiErrorSummary'
import { reportFailure } from '../notifications/record'

// Quick-add buttons for OpenRouter's `:free` tier. Every entry was checked
// against the live catalog (GET /api/v1/models + /endpoints) for: pricing 0,
// `temperature` AND `max_tokens` in supported_parameters (the only two
// params the rotation sends, see electron/ai.ts), a live endpoint, and a
// provider that does NOT restrict the free tier to agentic harnesses.
//
// Deliberate exclusions, so the next person does not re-add them:
// - Anything harness-gated. OpenRouter does not expose `allowed_harnesses`
//   in the JSON API; the restriction shows up as a `warning_message` on the
//   model page ("only available for use with agentic harnesses"), which
//   surfaces as a 403 from a plain API call. That killed the whole
//   Thinking Machines line.
// - `endpoint.status != 0`. -5 is "Down" (the Nemotron omni model, the
//   "fetch failed" entry in the log); -2 is degraded.
// - Rerank/embedding endpoints, which 400 on /chat/completions.
//
// Kept deliberately spread across ~7 distinct endpoint providers. One
// provider's 429 storm should not be able to starve the whole rotation,
// which is what happened when the pool was nearly all one vendor.
export const PRESETS: { name: string; desc: string; model: Omit<ApiModelConfig, 'id'> }[] = [
  { name: 'Gemma 4 26B A4B Free', desc: 'via OpenRouter (needs API key)', model: { name: 'Gemma 4 26B A4B', base_url: 'https://openrouter.ai/api/v1', api_key: '', model: 'google/gemma-4-26b-a4b-it:free' } },
  { name: 'Gemma 4 31B IT Free', desc: 'via OpenRouter (needs API key)', model: { name: 'Gemma 4 31B IT', base_url: 'https://openrouter.ai/api/v1', api_key: '', model: 'google/gemma-4-31b-it:free' } },
  { name: 'Nemotron 3 Super Free', desc: 'via OpenRouter (needs API key)', model: { name: 'Nemotron 3 Super', base_url: 'https://openrouter.ai/api/v1', api_key: '', model: 'nvidia/nemotron-3-super-120b-a12b:free' } },
  { name: 'Nemotron 3 Ultra Free', desc: 'via OpenRouter (needs API key)', model: { name: 'Nemotron 3 Ultra', base_url: 'https://openrouter.ai/api/v1', api_key: '', model: 'nvidia/nemotron-3-ultra-550b-a55b:free' } },
  { name: 'Laguna XS 2.1 Free', desc: 'via OpenRouter (needs API key)', model: { name: 'Laguna XS 2.1', base_url: 'https://openrouter.ai/api/v1', api_key: '', model: 'poolside/laguna-xs-2.1:free' } },
  { name: 'Laguna S 2.1 Free', desc: 'via OpenRouter (needs API key)', model: { name: 'Laguna S 2.1', base_url: 'https://openrouter.ai/api/v1', api_key: '', model: 'poolside/laguna-s-2.1:free' } },
  { name: 'North Mini Code Free', desc: 'via OpenRouter (needs API key)', model: { name: 'North Mini Code', base_url: 'https://openrouter.ai/api/v1', api_key: '', model: 'cohere/north-mini-code:free' } },
  { name: 'Qwen3.8 27B Free', desc: 'via OpenRouter (needs API key)', model: { name: 'Qwen3.8 27B', base_url: 'https://openrouter.ai/api/v1', api_key: '', model: 'qwen/qwen3.8-27b:free' } },
  { name: 'LFM2.5 2.6B Free', desc: 'via OpenRouter (needs API key)', model: { name: 'LFM2.5 2.6B', base_url: 'https://openrouter.ai/api/v1', api_key: '', model: 'liquid/lfm-2.5-2.6b:free' } },
  { name: 'Dots 3 Note Free', desc: 'via OpenRouter (needs API key)', model: { name: 'Dots 3 Note', base_url: 'https://openrouter.ai/api/v1', api_key: '', model: 'dots-studio/dots-3-note-preview:free' } }
]

type Tab = 'profile' | 'models' | 'boards' | 'companies' | 'scan' | 'autoqueue' | 'data'

const AUTO_QUEUE_KEYS = [
  'auto_queue_fit',
  'auto_queue_cv',
  'auto_queue_cover_letter',
  'auto_queue_verify_cv',
  'auto_queue_verify_cover_letter'
] as const

type AutoQueueKey = (typeof AUTO_QUEUE_KEYS)[number]

/**
 * The Auto-queue tab's rows, in the order they are shown.
 *
 * One source of truth for both the labels and the keys they write, so a
 * row cannot be added with a label and a mismatched setting. The keys
 * are the contract with the main process (see the Settings type), so
 * they are spelled here once and never reassembled at runtime.
 *
 * Labels say what the app does on its own, never how: no model names,
 * thresholds, or internal terms — the question a row answers is whether
 * the app spends tokens unattended, and that is all it needs to say.
 */
const AUTO_QUEUE_TOGGLES: { key: AutoQueueKey; label: string }[] = [
  { key: 'auto_queue_fit', label: 'Auto-queue fit scoring' },
  { key: 'auto_queue_cv', label: 'Auto-queue CV generation' },
  { key: 'auto_queue_cover_letter', label: 'Auto-queue cover letter generation' },
  { key: 'auto_queue_verify_cv', label: 'Auto-review CV' },
  { key: 'auto_queue_verify_cover_letter', label: 'Auto-review cover letter' }
]

export default function SettingsPage() {
  const [tab, setTab] = useState<Tab>('profile')
  const [settings, setSettings] = useState<Settings | null>(null)
  const [models, setModels] = useState<ApiModelConfig[]>([])
  const [dragging, setDragging] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  // Per-tab dirty flags. Each tab's Save enablement is independent:
  // editing on Profile doesn't enable Save on Models, and vice versa.
  // Reorder/Delete on Models auto-save, so they don't flip dirty.
  // Both reset on load and on save.
  const [profileDirty, setProfileDirty] = useState(false)
  const [modelsDirty, setModelsDirty] = useState(false)
  const [scanDirty, setScanDirty] = useState(false)
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
  // Auto-queue tab. These persist on change rather than through the
  // page-wide Save button (which only renders on Profile / Models /
  // Scan): each switch is one independent decision, and a user who
  // turned one off should not have to hunt for a Save button to make it
  // take effect. `autoQueueSaving` dims the switches while a write is in
  // flight so a double-click cannot race two writes of different keys.
  const [autoQueueSaving, setAutoQueueSaving] = useState(false)
  // The provider call cap, held separately from `settings` so a half-typed
  // value ("1" on the way to "150") does not get written on every keystroke.
  // Falls back to the documented default when a store predates the key, which
  // is the same value the main process normalises it to.
  const [providerCallCap, setProviderCallCap] = useState(50)
  // What the AI providers have ACTUALLY spent in the rolling 24h window, one
  // row per provider, read from the same ledger the cap is measured against.
  //
  // This tab's cap input is the number the user SET, and for six hours and
  // forty-four minutes on 2026-10-05 it was also the only number shown — 629
  // requests issued against a cap of 50, rendered as "50", with the 629
  // nowhere in the UI. So the spend sits directly under the input it is being
  // compared against.
  //
  // The rows and the moment they were read are ONE value, not two. That is
  // the whole freshness contract: a snapshot with nothing on it saying when it
  // was taken is how "4 calls in the last 24h against a cap of 50" sat on
  // screen for hours while the ledger was at 200, and how a row naming a
  // budget that "frees at 01:20" survived past 01:20 into a sentence the app
  // would no longer agree with. Held separately they could not drift — one
  // `setProviderSpend(rows)` and one `setProviderSpendNow(now)` are two
  // chances to paint a number next to a moment that belongs to a different
  // read. There is nothing to reconcile because there is one object, and
  // `readAt` is the instant the READ was issued, never the render.
  //
  // A failed read clears it entirely: the rows AND the marker go, because a
  // timestamp with no numbers beside it is a freshness claim about nothing,
  // and a number with a timestamp from a read that worked is worse.
  const [providerSpendRead, setProviderSpendRead] = useState<{
    rows: ProviderSpend[]
    readAt: number
  } | null>(null)
  const [providerSpendState, setProviderSpendState] = useState<'loading' | 'loaded' | 'failed'>('loading')
  // Counts reads so two of them in flight at once cannot land out of order.
  // A poll that starts while an earlier read is still waiting on the main
  // process would otherwise resolve second and be overwritten by the stale
  // one — which is the refresh itself becoming the lie. A read is only
  // discarded when a LATER one has been started, so the newest read of the
  // ledger is always the one on screen and `readAt` always belongs to it.
  const providerSpendReads = useRef(0)

  /**
   * Read the provider spend for this tab.
   *
   * A read that failed renders NO numbers and says it failed. `0` against the
   * cap would be a claim — "this provider has spent nothing in the last 24
   * hours" — that nothing here knows, and it is indistinguishable on screen
   * from the truth. A bridge without this method (an older preload, or a test
   * mock that predates it) throws on the call and lands in the same branch,
   * which is the right answer for the same reason.
   */
  async function loadProviderSpend(showLoading: boolean) {
    if (showLoading) setProviderSpendState('loading')
    const readAt = Date.now()
    const read = ++providerSpendReads.current
    try {
      const rows = await api.providerSpend()
      if (read !== providerSpendReads.current) return
      setProviderSpendRead({ rows, readAt })
      setProviderSpendState('loaded')
    } catch {
      if (read !== providerSpendReads.current) return
      setProviderSpendRead(null)
      setProviderSpendState('failed')
    }
  }

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
      reportFailure({
        source: 'app',
        message: `Failed to save board toggle: ${err instanceof Error ? err.message : 'Unknown error'}`,
        fullMessage: `${name}\n${errorText(err)}`,
      })
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
      reportFailure({
        source: 'app',
        message: `Failed to save category toggle: ${err instanceof Error ? err.message : 'Unknown error'}`,
        fullMessage: `${boardsInCategory.join(', ')}\n${errorText(err)}`,
      })
      setDisabled(disabled)
    } finally {
      setBoardsSaving(false)
    }
  }

  // Flip one auto-queue switch. Optimistic, then persisted through the
  // existing settings:update IPC — the same path the Boards tab uses
  // for its toggles and the Save button uses for everything else, so
  // there is one way a setting reaches the store.
  //
  // The response is authoritative for the row that was tapped: the main
  // process normalises what it stores (a non-boolean becomes `true`),
  // and echoing that back means the switch shows what is actually
  // persisted rather than what was asked for.
  async function toggleAutoQueue(key: AutoQueueKey, on: boolean) {
    await saveAutoQueueValue(key, on, `Failed to save auto-queue switch: `)
  }

  /**
   * The one write path for the Auto-queue tab's rows.
   *
   * Shared by the five switches and the call cap because the failure mode
   * this shape exists to prevent applies to all of them: taking the whole
   * response would replace this shared state object with the STORE's copy
   * and silently discard every unsaved batch edit the user has made on
   * another tab. So the response is merged for the ONE key that was written,
   * and a failure rolls back that key alone.
   *
   * Returns whether the store took the write. The call cap needs it: that
   * input holds its own state (`providerCallCap`, so a half-typed value is not
   * written on every keystroke), and nothing rolled THAT back when the write
   * failed — the page went on showing a cap the store never accepted, which
   * is the same "shows what was asked for rather than what is stored"
   * failure the merge below exists to prevent, one field over.
   */
  async function saveAutoQueueValue<K extends keyof Settings>(
    key: K,
    value: Settings[K],
    errorPrefix: string
  ): Promise<boolean> {
    setAutoQueueSaving(true)
    const previous = settings
    setSettings((prev) => (prev ? { ...prev, [key]: value } : prev))
    try {
      const updated = await api.updateSettings({ [key]: value })
      // Merge ONLY the key that was written, and roll back only that key on
      // failure below — one rule, both directions. Taking the whole response
      // would replace this shared state object with the STORE's copy and
      // silently discard every unsaved batch edit the user has made on another
      // tab (a raised scan_min_match, a typed profile name) — while that tab's
      // dirty flag stays set, so pressing Save persists the old value and looks
      // like it worked. The response stays authoritative for the one key it
      // just wrote.
      setSettings((prev) => (prev ? { ...prev, [key]: updated[key] } : updated))
      return true
    } catch (err) {
      reportFailure({
        source: 'app',
        message: `${errorPrefix}${err instanceof Error ? err.message : 'Unknown error'}`,
        fullMessage: `${errorPrefix}\n${errorText(err)}`,
      })
      // Roll back ONLY the key this function wrote, for the same reason the
      // success path merges only that key: restoring the whole snapshot
      // captured above would discard every unsaved batch edit the user has
      // made on another tab, and would also revert anything they typed while
      // this write was in flight — only these switches are disabled during it,
      // every other tab's inputs stay live. `previous?.[key]` is read inside
      // the updater rather than outside it, so it cannot come from a stale
      // closure.
      setSettings((prev) => (prev ? { ...prev, [key]: previous?.[key] } : previous))
      return false
    } finally {
      setAutoQueueSaving(false)
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
      // Older stores have no scan_min_match. Default to the value the
      // hardcoded scan floor used, so the control shows what the app is
      // actually doing rather than a value that changes behaviour.
      if (typeof s.scan_min_match !== 'number' || !Number.isFinite(s.scan_min_match)) {
        s.scan_min_match = 0.25
      }
      // Older stores have no auto-queue keys. Default them ON, matching
      // the main-process normalisation: these gate automatic work, so
      // an absent or non-boolean value must never read as "off" here —
      // a switch shown off that is not stored off would be a lie the
      // user could act on. Only an explicit `false` shows a switch off.
      for (const key of AUTO_QUEUE_KEYS) {
        if (typeof s[key] !== 'boolean') s[key] = true
      }
      // Same reason for the provider call cap: a store written before it
      // existed must not render as 0 requests a day, which is both wrong and
      // the one value that could read as "off". The default is the provider's
      // own documented free allowance.
      if (typeof s.provider_call_cap !== 'number' || !Number.isFinite(s.provider_call_cap)) {
        s.provider_call_cap = 50
      }
      setProviderCallCap(s.provider_call_cap)
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
      setProfileDirty(false)
      setModelsDirty(false)
      setScanDirty(false)
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

  // The provider spend is read when this tab is opened, on a sidebar refresh,
  // after a cap write, and on a poll — and the poll is the one that matters.
  //
  // It used to be the first three only, and nothing else: `app:refresh` has
  // one dispatcher in the tree (Sidebar.tsx, a manual click) and the tab open
  // is a click. So an Auto-queue tab left open through a busy sweep went on
  // rendering a 09:00 snapshot of a ledger the background queue was spending
  // the whole time — which is the entire reason to have the panel open. Worse,
  // the copy went stale rather than merely old: a row naming a budget that
  // frees at 01:20 was still on screen at 00:30, describing a provider that
  // had room again.
  //
  // Polling fixes the number; the as-of marker fixes the trust in it. Polling
  // alone leaves whatever the last tick read on screen until the next one, so
  // a user who glances at the panel can be reading a row that is up to
  // PROVIDER_SPEND_POLL_MS old, and nothing on it says so. A marker alone
  // fixes nothing and only reports the staleness. Both, and the marker is the
  // instant of the read (`readAt` above), never the render — a timestamp
  // invented now would be the same defect class in a new place: a
  // fresh-looking time bolted to a number that is not fresh.
  //
  // The same cadence as the Queue panel, because it is the same question —
  // "what is the background queue doing to my budget" — and the ledger is
  // shared. Lazily: a Settings page sitting on Profile or Models must not be
  // reading a ledger, so the interval exists only while this tab is on
  // screen and is cleared when the tab is left.
  useEffect(() => {
    if (tab !== 'autoqueue') return
    void loadProviderSpend(true)
    const id = setInterval(() => { void loadProviderSpend(false) }, PROVIDER_SPEND_POLL_MS)
    const onRefresh = () => { void loadProviderSpend(false) }
    window.addEventListener('app:refresh', onRefresh)
    return () => {
      clearInterval(id)
      window.removeEventListener('app:refresh', onRefresh)
    }
  }, [tab])

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
      setProfileDirty(false)
      setModelsDirty(false)
      setScanDirty(false)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } finally {
      setSaving(false)
    }
  }

  function update(field: keyof Settings, value: string | number | boolean) {
    setSettings((prev) => (prev ? { ...prev, [field]: value as never } : prev))
    setProfileDirty(true)
    setScanDirty(true)
  }

  function updateModel(i: number, field: keyof ApiModelConfig, value: string | boolean) {
    setModels((prev) => prev.map((m, idx) => (idx === i ? { ...m, [field]: value } : m)))
    setModelsDirty(true)
  }

  function addModel() {
    // Reuse the key from a model already configured for the same provider
    // so adding a second model doesn't mean re-pasting the same secret.
    setModels((prev) => [...prev, inheritProviderApiKey({ id: '', ...emptyModel }, prev)])
    setModelsDirty(true)
  }

  function duplicateModel(i: number) {
    const source = models[i]
    if (!source) return
    const copy: ApiModelConfig = {
      ...source,
      id: '',
      name: `${source.name || `Model ${i + 1}`} (copy)`
    }
    setModels((prev) => [...prev, copy])
    setModelsDirty(true)
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
        reportFailure({
          source: 'app',
          message: `Failed to save model order: ${err.message}`,
          fullMessage: `${m.name || `Model ${from + 1}`}\n${errorText(err)}`,
        })
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
      reportFailure({
        source: 'app',
        message: `Failed to save model changes: ${err.message}`,
        fullMessage: `${label}\n${errorText(err)}`,
      })
    })
  }

  function addPreset(preset: typeof PRESETS[number]) {
    // Presets ship with an empty key; inherit the one the user already
    // saved for that provider (e.g. their OpenRouter key) so the model
    // works the moment it's added.
    setModels((prev) => [...prev, inheritProviderApiKey({ id: '', ...preset.model }, prev)])
    setModelsDirty(true)
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
          {(tab === 'profile' || tab === 'models' || tab === 'scan') && (
            <button
              className="btn btn-primary"
              onClick={handleSave}
              disabled={saving || (tab === 'profile' ? !profileDirty : tab === 'models' ? !modelsDirty : !scanDirty)}
            >
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
            { id: 'autoqueue', label: 'Auto-queue' },
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
                <label>Phone number</label>
                <input
                  value={settings.user_phone ?? ''}
                  onChange={(e) => update('user_phone', e.target.value)}
                  placeholder="e.g. +1 555 123 4567"
                />
              </div>
              <div className="form-group">
                <label>Preferred locations</label>
                <LocationPicker
                  value={parseLocationPicks(settings.job_search_locations)}
                  onChange={(picks) => update('job_search_locations', JSON.stringify(picks))}
                  placeholder="Add a location (e.g. London, Remote)"
                />
              </div>
            </div>
          </div>

          <div className="section-title">Base CV</div>
          <div className="card" style={{ display: 'flex', flexDirection: 'column', minHeight: 'calc(100vh - 420px)' }}>
            <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
              Paste your master CV here. It will be used as the source material when tailoring for specific jobs.
            </p>
            <textarea
              value={settings.base_cv}
              onChange={(e) => update('base_cv', e.target.value)}
              style={{ flex: 1, width: '100%', minHeight: 200, fontFamily: 'monospace', fontSize: 13, resize: 'vertical' }}
              placeholder="Paste your full CV text here..."
            />
          </div>
        </>
      )}

      {tab === 'scan' && (
        <>
          <div className="section-title">Auto-Scan</div>
          <div className="card">
            <div className="form-group">
              <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input
                  type="checkbox"
                  checked={settings.auto_scan_enabled}
                  onChange={(e) => {
                    update('auto_scan_enabled', e.target.checked)
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
                />
                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>minutes after the last scan completes</span>
              </div>
              <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4, marginLeft: 24 }}>
                Auto-scans use all job boards, all work types, and your saved Preferred location. The scan runs while the app is open; you'll see progress in the Scan Jobs tab.
              </p>
            </div>
          </div>
          <div className="section-title">Match Filter</div>
          <div className="card">
            <div className="form-group">
              <label htmlFor="scan-min-match" style={{ display: 'block', marginBottom: 4 }}>
                Skip listings matching less than
              </label>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input
                  id="scan-min-match"
                  type="number"
                  min={0}
                  max={1}
                  step={0.05}
                  style={{ width: 90 }}
                  value={settings.scan_min_match}
                  onChange={(e) => {
                    const n = parseFloat(e.target.value)
                    if (!isNaN(n) && n >= 0 && n <= 1) update('scan_min_match', n)
                  }}
                />
                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                  (0 adds everything, 1 only a perfect match)
                </span>
              </div>
              <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                A scan compares each listing against your base CV and skips anything scoring under this
                instead of adding it to My Jobs — raise it to keep only strong matches, lower it (or set 0)
                to catch more. Needs a base CV: with none configured there is nothing to compare against,
                so nothing is skipped.
              </p>
            </div>
          </div>
        </>
      )}

      {tab === 'autoqueue' && (
        <>
          <div className="section-title">Auto-queue</div>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
            Choose what the app queues by itself. Turning a switch off stops that work being added on its own — it never stops you: generating, verifying, tailoring and Quick Apply still queue the moment you ask for them.
          </p>

          <div className="card" style={{ padding: 0 }}>
            {AUTO_QUEUE_TOGGLES.map((row, i) => (
              <div
                key={row.key}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  gap: 12,
                  padding: '10px 16px',
                  borderBottom: i < AUTO_QUEUE_TOGGLES.length - 1 ? '1px solid var(--border)' : 'none'
                }}
              >
                <label
                  htmlFor={row.key}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    fontSize: 13,
                    cursor: 'pointer',
                    minWidth: 0
                  }}
                >
                  <input
                    id={row.key}
                    type="checkbox"
                    checked={settings[row.key] !== false}
                    disabled={autoQueueSaving}
                    onChange={(e) => void toggleAutoQueue(row.key, e.target.checked)}
                  />
                  <span>{row.label}</span>
                </label>
              </div>
            ))}
          </div>

          <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8 }}>
            Switches save as soon as you change them. Work already in the queue keeps running — clearing it is a separate action in the Queue panel.
          </p>

          <div className="section-title">AI provider budget</div>
          <div className="card">
            <div className="form-group">
              <label htmlFor="provider-call-cap" style={{ display: 'block', marginBottom: 4 }}>
                Let each AI provider answer this many requests a day
              </label>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input
                  id="provider-call-cap"
                  type="number"
                  min={1}
                  max={5000}
                  step={10}
                  style={{ width: 90 }}
                  disabled={autoQueueSaving}
                  value={providerCallCap}
                  onChange={(e) => {
                    const n = parseInt(e.target.value, 10)
                    if (!Number.isNaN(n) && n >= 1 && n <= 5000) {
                      const previous = providerCallCap
                      setProviderCallCap(n)
                      void saveAutoQueueValue('provider_call_cap', n, 'Failed to save the AI provider budget: ')
                        .then((saved) => {
                          // Put the input back when the store refused the
                          // value, so it never claims a cap the app is not
                          // enforcing — this input holds its own state, and
                          // nothing else rolls it back.
                          if (!saved) setProviderCallCap(previous)
                          // Re-read either way, because the rows below compare
                          // the spend against the cap the app is ENFORCING.
                          // Leaving yesterday's cap on screen beside a new
                          // input is the same disagreement this section
                          // exists to end.
                          return loadProviderSpend(false)
                        })
                    }
                  }}
                />
                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>requests per 24 hours</span>
              </div>

              {/* THE SPEND, NEXT TO THE CAP. Three states on purpose: a read
                  in flight, a read that failed, and a ledger with nothing in
                  it all say different things, because "0 of 50" is a claim
                  about the third and a lie about the other two. */}
              <div style={{ marginTop: 8 }}>
                {providerSpendState === 'loading' && (
                  <p data-testid="provider-spend-loading" style={{ fontSize: 11, color: 'var(--text-muted)', margin: 0 }}>
                    Reading what the AI providers have spent in the last 24 hours…
                  </p>
                )}
                {providerSpendState === 'failed' && (
                  <p data-testid="provider-spend-failed" style={{ fontSize: 11, color: 'var(--text-muted)', margin: 0 }}>
                    Could not read what the AI providers have spent in the last 24 hours, so no
                    usage is shown here.
                  </p>
                )}
                {providerSpendState === 'loaded' && providerSpendRead && providerSpendRead.rows.length === 0 && (
                  <p data-testid="provider-spend-empty" style={{ fontSize: 11, color: 'var(--text-muted)', margin: 0 }}>
                    No AI provider is configured yet, so there is no spend to show.
                  </p>
                )}
                {providerSpendState === 'loaded' && providerSpendRead && providerSpendRead.rows.length > 0 && (
                  <>
                    {/* WHEN THESE NUMBERS WERE TRUE, which is the only thing
                        that makes a row a measurement rather than a claim
                        about the present. The read's own instant — the same
                        object the rows came in — so it cannot name a fresher
                        moment than the numbers it is sitting above, and there
                        is nothing here at all until a read has succeeded. */}
                    <p
                      data-testid="provider-spend-asof"
                      style={{ fontSize: 11, color: 'var(--text-muted)', margin: '0 0 8px' }}
                    >
                      {providerSpendAsOf(providerSpendRead.readAt, Date.now())}
                    </p>
                    {providerSpendRead.rows.map((row, i) => {
                      // `now` is taken here, at render, and not from the read
                      // — deliberately, and only for the sentences' FRESHNESS
                      // test. The sentences above this one describe what was
                      // true at `readAt`, which the marker discloses; what they
                      // must never do is keep asserting something that has
                      // since stopped being true, and a clock that moves only
                      // forward can retire a claim sooner, never invent a
                      // later one. So the "never name a moment that has
                      // already gone by" guard is judged against the latest
                      // reading, and every moment this section prints is the
                      // ledger's or the read's — never this one. With a poll
                      // behind it, the gap between the two clocks is one tick
                      // at most.
                      const lines = providerSpendLines(row, Date.now())
                      return (
                        <div
                          key={`${row.label}-${i}`}
                          data-testid="provider-spend-row"
                          style={{ marginBottom: 8 }}
                        >
                          <div style={{ fontSize: 12 }}>{row.label}</div>
                          {lines.map((line) => (
                            <div
                              key={line.id}
                              data-testid={`provider-spend-${line.id}`}
                              style={{ fontSize: 11, color: 'var(--text-muted)' }}
                            >
                              {line.text}
                            </div>
                          ))}
                        </div>
                      )
                    })}
                  </>
                )}
              </div>
              <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                A provider's budget covers every model sharing one API key with it, not each model
                separately — which is why a pool of free models on one key runs out sooner than the
                model count suggests. Once a provider reaches its budget the app stops calling it on
                its own, keeps the work queued, and picks it up when the budget frees on a rolling
                24-hour count. Anything you ask for directly — Generate, Regenerate, Verify, Tailor,
                Quick Apply — always runs; it just counts against the same budget.
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
                  <button
                    className="icon-btn"
                    onClick={() => duplicateModel(i)}
                    title="Duplicate model (same base URL and API key)"
                    aria-label="Duplicate model"
                  >
                    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
                      <rect x="4.5" y="4.5" width="8" height="8" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.2" />
                      <path d="M2.5 9.5 V3.5 a1 1 0 0 1 1 -1 H9.5" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
                    </svg>
                  </button>
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
