import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react'
import SettingsPage from './SettingsPage'
import { api } from '../api'
import { notify } from '../components/Notifications'

// REVIEWER-ADDED (rv2-autofix). Attacking the DEFECT 1 FIX, not the feature.
//
// a36a43c changed `toggleAutoQueue` from
//     setSettings(updated)                                        // whole object
// to
//     setSettings(prev => prev ? { ...prev, [key]: updated[key] } : updated)  // one key
//
// The reviewer's open question — which the brief says is mine to answer —
// is what that choice COSTS. This file attacks the merge on the four axes
// where a merge can be worse than a replace:
//
//   1. a FAILED write: does the rollback restore the pre-optimistic state
//      AND leave the other tab's unsaved edit alone?
//   2. two toggles in flight: the same switch twice, and two switches at
//      once (jsdom dispatches change on a disabled checkbox, which is how
//      the race becomes reachable at all).
//   3. a response MISSING the tapped key — `updated[key]` reads
//      `undefined` and `{...prev, [key]: undefined}` writes `undefined`
//      over a good boolean. Then `settings[key] !== false` is TRUE, so
//      the switch renders ON for a feature the store has off.
//   4. a response that is missing keys the USER's unsaved edit depends
//      on — the shape a partial/stale IPC would return.

const baseSettings: Record<string, unknown> = {
  openai_api_key: '',
  openai_base_url: '',
  openai_model: '',
  user_name: 'Sam Rivera',
  user_email: '',
  user_phone: '',
  user_country: '',
  base_cv: 'CV TEXT',
  job_search_keywords: '',
  job_search_location: '',
  job_search_locations: '[]',
  deleted_jobs_cap: 50000,
  auto_scan_enabled: true,
  auto_scan_interval_minutes: 120,
  scan_min_match: 0.25,
  backup_path: '',
  backup_last_success_at: '',
  backup_last_error: '',
  passphrase: '',
  adzuna_app_id: '',
  adzuna_app_key: '',
  aggregator_remotive_enabled: true,
  aggregator_arbeitnow_enabled: true,
  aggregator_jobicy_enabled: true,
  aggregator_himalayas_enabled: true,
  ats_boards: [],
  disabled_boards: [],
  auto_tailor_on_scan: false,
  auto_tailor_min_fit: 0,
  auto_doc_min_fit: 40,
  auto_queue_fit: true,
  auto_queue_cv: true,
  auto_queue_cover_letter: true,
  auto_queue_verify_cv: true,
  auto_queue_verify_cover_letter: true,
  quick_apply_shortcut: null,
  scraper_proxy: ''
}

vi.mock('../api', () => ({
  api: {
    getSettings: vi.fn(),
    listApiModels: vi.fn(async () => []),
    getSecurityStatus: vi.fn(async () => ({ mode: 'sealed' })),
    listBlacklistedCompanies: vi.fn(async () => []),
    getBackupStatus: vi.fn(async () => ({ lastSuccessAt: '', lastError: '' })),
    listBoards: vi.fn(async () => []),
    addBlacklistedCompany: vi.fn(async (n: string) => [n]),
    removeBlacklistedCompany: vi.fn(async () => []),
    updateSettings: vi.fn(),
    saveApiModels: vi.fn(async (models: unknown[]) => models)
  }
}))

vi.mock('../components/Notifications', () => ({ notify: vi.fn() }))

type S = Record<string, unknown>

let store: S

/** The store the main process holds; updateSettings mocks read and write it. */
function asStore(s: S): never {
  return s as never
}

function sw(id: string): HTMLInputElement {
  return document.getElementById(id) as HTMLInputElement
}

const ROWS = [
  'auto_queue_fit',
  'auto_queue_cv',
  'auto_queue_cover_letter',
  'auto_queue_verify_cv',
  'auto_queue_verify_cover_letter'
]

beforeEach(() => {
  store = { ...baseSettings }
  vi.mocked(api.getSettings).mockImplementation(async () => asStore({ ...store }))
  vi.mocked(api.updateSettings).mockImplementation((async (partial: S) => {
    store = { ...store, ...partial }
    return asStore({ ...store })
  }) as never)
  vi.mocked(api.updateSettings).mockClear()
  vi.mocked(notify).mockClear()
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

async function openAutoQueue(): Promise<void> {
  render(<SettingsPage />)
  fireEvent.click(await screen.findByRole('button', { name: /^Auto-queue$/i }))
  await screen.findByLabelText(/Auto-queue fit scoring/i)
}

/** Raise scan_min_match on the Scan tab and do NOT press Save. */
async function unsavedScanEdit(value = 0.9): Promise<void> {
  render(<SettingsPage />)
  fireEvent.click(await screen.findByRole('button', { name: /^Scan$/i }))
  const input = (await screen.findByLabelText(/Skip listings matching less than/i)) as HTMLInputElement
  fireEvent.change(input, { target: { value: String(value) } })
  expect(store.scan_min_match).toBe(0.25)
  fireEvent.click(await screen.findByRole('button', { name: /^Auto-queue$/i }))
  await screen.findByLabelText(/Auto-queue fit scoring/i)
}

async function backToScan(): Promise<HTMLInputElement> {
  fireEvent.click(await screen.findByRole('button', { name: /^Scan$/i }))
  return (await screen.findByLabelText(/Skip listings matching less than/i)) as HTMLInputElement
}

// ---------------------------------------------------------------------------
// 1. The failed-write rollback.
// ---------------------------------------------------------------------------

describe('a FAILED auto-queue write', () => {
  it('restores the pre-optimistic switch value', async () => {
    await openAutoQueue()
    expect(sw('auto_queue_cv').checked).toBe(true)
    vi.mocked(api.updateSettings).mockRejectedValueOnce(new Error('disk full'))
    fireEvent.click(sw('auto_queue_cv'))
    await waitFor(() => expect(notify).toHaveBeenCalled())
    await waitFor(() => expect(sw('auto_queue_cv').checked).toBe(true))
    expect(store.auto_queue_cv).toBe(true)
  })

  it("leaves the other tab's UNSAVED edit intact", async () => {
    await unsavedScanEdit(0.9)
    vi.mocked(api.updateSettings).mockRejectedValueOnce(new Error('disk full'))
    fireEvent.click(sw('auto_queue_fit'))
    await waitFor(() => expect(notify).toHaveBeenCalled())
    expect(await backToScan()).toHaveValue(0.9)
  })

  it('restores BOTH — the switch and the unsaved edit — in one failure', async () => {
    await unsavedScanEdit(0.9)
    expect(sw('auto_queue_fit').checked).toBe(true)
    vi.mocked(api.updateSettings).mockRejectedValueOnce(new Error('disk full'))
    fireEvent.click(sw('auto_queue_fit'))
    await waitFor(() => expect(notify).toHaveBeenCalled())
    await waitFor(() => expect(sw('auto_queue_fit').checked).toBe(true))
    expect(await backToScan()).toHaveValue(0.9)
  })

  it('an edit made DURING the in-flight write survives the rollback', async () => {
    // `const previous = settings` is captured BEFORE the optimistic write,
    // and the catch restores that whole snapshot. So an edit the user
    // makes while the write is in flight is reverted along with the
    // switch. Reachable: only the five switches are disabled during the
    // write, every other tab's inputs stay live.
    await unsavedScanEdit(0.5)
    let release: (() => void) | null = null
    vi.mocked(api.updateSettings).mockImplementationOnce(
      (() => new Promise<S>((_r, reject) => { release = () => reject(new Error('disk full')) })) as never
    )
    fireEvent.click(sw('auto_queue_fit'))

    // The user keeps typing on the Scan tab while the write is out.
    fireEvent.click(await screen.findByRole('button', { name: /^Scan$/i }))
    const input = (await screen.findByLabelText(/Skip listings matching less than/i)) as HTMLInputElement
    fireEvent.change(input, { target: { value: '0.77' } })
    expect(input).toHaveValue(0.77)

    await act(async () => { release?.() })
    await waitFor(() => expect(notify).toHaveBeenCalled())

    expect(
      await screen.findByLabelText(/Skip listings matching less than/i),
      'an edit typed during the in-flight write must not be reverted by the rollback'
    ).toHaveValue(0.77)
  })
})

// ---------------------------------------------------------------------------
// 2. Concurrent / repeated toggles.
//
// `autoQueueSaving` disables every switch for the duration of a write. In
// a real browser a disabled control delivers no click, so the second
// toggle is unreachable; jsdom dispatches `change` on a disabled
// checkbox regardless, so these cases construct the race deliberately.
// They are about the MERGE, not about the disable window.
// ---------------------------------------------------------------------------

describe('overlapping toggles', () => {
  it('two switches toggled while the first write is in flight both land', async () => {
    // Deliberately bypasses the disable window. `fireEvent.click` on a
    // DISABLED checkbox still reaches React's onChange under jsdom (proved
    // separately), which is the only way to construct this race at all —
    // in a real browser a disabled control delivers no click, so this
    // case is about the MERGE, not about the disable window.
    //
    // Two writes race; if the merge is per-key both survive regardless of
    // the order the responses settle in.
    render(<SettingsPage />)
    fireEvent.click(await screen.findByRole('button', { name: /^Auto-queue$/i }))
    await screen.findByLabelText(/Auto-queue fit scoring/i)

    const releases: (() => void)[] = []
    vi.mocked(api.updateSettings).mockImplementation((async (partial: S) =>
      await new Promise<S>((r) => {
        releases.push(() => r(asStore({ ...store, ...partial }) as unknown as S))
      })) as never)

    fireEvent.click(sw('auto_queue_cv'))
    fireEvent.click(sw('auto_queue_fit'))
    await waitFor(() => expect(releases).toHaveLength(2))

    // Settle them in REVERSE order, so the last-resolved response is the
    // FIRST write — the worst case for a whole-object set.
    await act(async () => { releases[1]() })
    await act(async () => { releases[0]() })

    await waitFor(() => {
      expect(sw('auto_queue_cv').checked).toBe(false)
      expect(sw('auto_queue_fit').checked).toBe(false)
    })
  })

  it('the SAME switch toggled twice: the last write wins, and the switch shows it', async () => {
    await openAutoQueue()
    expect(sw('auto_queue_cv').checked).toBe(true)

    fireEvent.click(sw('auto_queue_cv'))
    await waitFor(() => expect(store.auto_queue_cv).toBe(false))
    expect(sw('auto_queue_cv').checked).toBe(false)

    fireEvent.click(sw('auto_queue_cv'))
    await waitFor(() => expect(store.auto_queue_cv).toBe(true))
    expect(sw('auto_queue_cv').checked).toBe(true)
  })

  it('an interleaved toggle does not resurrect the other switch', async () => {
    // off A, then off B, then A back on. The middle write's response must
    // not drag A back to whatever the store held before it.
    await openAutoQueue()
    fireEvent.click(sw('auto_queue_cv'))
    await waitFor(() => expect(store.auto_queue_cv).toBe(false))
    fireEvent.click(sw('auto_queue_verify_cv'))
    await waitFor(() => expect(store.auto_queue_verify_cv).toBe(false))
    fireEvent.click(sw('auto_queue_cv'))
    await waitFor(() => expect(store.auto_queue_cv).toBe(true))
    expect(sw('auto_queue_cv').checked).toBe(true)
    expect(sw('auto_queue_verify_cv').checked).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 3. The response MISSING the tapped key.
//
// This is the one the merge makes WORSE than the whole-object set, and
// it is the finding this file exists for.
//
//   { ...prev, [key]: updated[key] }
//
// If `updated` has no such key, `updated[key]` is `undefined`, so the
// merged state carries `auto_queue_cv: undefined`. The render is
// `checked={settings[row.key] !== false}`, and `undefined !== false` is
// TRUE — so the switch renders ON. The store still holds whatever it
// holds; the tab is simply now showing the wrong thing for a control the
// user just touched, and the wrong thing is "on".
//
// The whole-object set did not have this hole: if the response was
// missing the key, `updated.auto_queue_cv` was equally undefined and the
// render was equally wrong, but `settings` had been replaced wholesale so
// at least no other key was half-merged. The honest statement is that
// BOTH spellings mis-render a response missing the tapped key; the merge
// additionally drops the optimistic value that would otherwise have been
// right.
// ---------------------------------------------------------------------------

describe('a response MISSING the tapped key', () => {
  it.fails('does NOT write undefined over the tapped key', async () => {
    await openAutoQueue()
    // The store genuinely turned it off; the response just does not carry
    // it. `db.updateSettings` always returns the whole normalised
    // settings object, so this shape should be unreachable — but the
    // merge should not depend on that.
    vi.mocked(api.updateSettings).mockResolvedValueOnce((() => {
      const copy: S = { ...store, auto_queue_cv: false }
      delete copy.auto_queue_cv
      return copy
    })() as never)
    fireEvent.click(sw('auto_queue_cv'))
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalled())
    await act(async () => { await Promise.resolve() })

    // The optimistic write put `false` there. A merge that read
    // `undefined` throws it away and the switch — rendered
    // `settings[key] !== false` — springs back ON.
    expect(sw('auto_queue_cv').checked, 'a switch the user turned off must not render back on').toBe(false)
  })

  it.fails('does NOT write undefined when the response is an empty object', async () => {
    await openAutoQueue()
    vi.mocked(api.updateSettings).mockResolvedValueOnce({} as never)
    fireEvent.click(sw('auto_queue_cv'))
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalled())
    await act(async () => { await Promise.resolve() })
    expect(sw('auto_queue_cv').checked).toBe(false)
  })

  it('and the other four switches are untouched by that response', async () => {
    // The response missing the tapped key must not cascade into the
    // others. Read all five before and after; only the tapped one may
    // move. (It does move — wrongly, back to `true` — which is the bug
    // the first two cases pin; this case scopes it.)
    await openAutoQueue()
    const before = ROWS.map((k) => sw(k).checked)
    vi.mocked(api.updateSettings).mockResolvedValueOnce((() => {
      const copy: S = { ...store, auto_queue_cv: false }
      delete copy.auto_queue_cv
      return copy
    })() as never)
    fireEvent.click(sw('auto_queue_cv'))
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalled())
    await act(async () => { await Promise.resolve() })
    const after = ROWS.map((k) => sw(k).checked)
    expect(
      after.filter((_, i) => ROWS[i] !== 'auto_queue_cv'),
      'a partial response must not disturb the other four switches'
    ).toEqual(before.filter((_, i) => ROWS[i] !== 'auto_queue_cv'))
  })
})

// ---------------------------------------------------------------------------
// 4. What merge-the-key costs against refresh-the-whole-object.
// ---------------------------------------------------------------------------

describe('the cost of merging one key', () => {
  it('a key the STORE changed meanwhile is NOT picked up by the merge', async () => {
    // The trade, stated as a test. `api.updateSettings` returns the whole
    // store; the merge reads one key of it, so any OTHER key that
    // changed in the same window stays stale in the page until a reload.
    // With `setSettings(updated)` this would have been picked up.
    //
    // `deleted_jobs_cap` is the probe: the Data tab has a live `onBlur`
    // write of its own (SettingsPage.tsx:1592), so a real second writer
    // to the same store is not hypothetical.
    render(<SettingsPage />)
    fireEvent.click(await screen.findByRole('button', { name: /^Auto-queue$/i }))
    await screen.findByLabelText(/Auto-queue fit scoring/i)

    // The store's own normalisation would have rewritten this cap in the
    // response (db.updateSettings returns getSettings() after a reload
    // path, and clampX exists for exactly this). Model a response that
    // carries the store's newer value for a key the merge ignores.
    vi.mocked(api.updateSettings).mockImplementation((async (partial: S) => {
      // The store now holds 12345 (a second writer changed it), and the
      // response carries it — the merge just does not read it.
      store = { ...store, ...partial, deleted_jobs_cap: 12345 }
      return asStore({ ...store })
    }) as never)

    fireEvent.click(sw('auto_queue_fit'))
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalled())
    await act(async () => { await Promise.resolve() })

    // Read the page's copy back off the Data tab, which renders the cap.
    fireEvent.click(screen.getByRole('button', { name: /^(Data|Backup)$/i }))
    const cap = (await screen.findByDisplayValue(/50000|12345/)) as HTMLInputElement
    expect(
      cap.value,
      'documented cost of merge-the-key: a concurrently-changed key stays stale in the page'
    ).toBe('50000')
    // ...and the store really does hold the newer value, so the page and
    // the store now disagree. That disagreement is the hazard: the Scan
    // and Profile Save buttons write the WHOLE page object, so a Save
    // from another tab is what turns this staleness into a revert.
    expect(store.deleted_jobs_cap).toBe(12345)
  })

  it('the merge still persists each switch under its own key, never a whole object', async () => {
    // The shipped contract, re-asserted against the fixed code.
    await openAutoQueue()
    for (const key of ['auto_queue_fit', 'auto_queue_cv', 'auto_queue_cover_letter', 'auto_queue_verify_cv']) {
      vi.mocked(api.updateSettings).mockClear()
      fireEvent.click(sw(key))
      await waitFor(() => expect(api.updateSettings).toHaveBeenCalledTimes(1))
      expect(vi.mocked(api.updateSettings).mock.calls[0][0]).toEqual({ [key]: expect.any(Boolean) })
    }
  })

  it('a Save from another tab writes the merged value, not a stale one', async () => {
    // The merge's one real user-visible hazard, and the reason it is not
    // harmless: `handleSave` sends the WHOLE `settings` object. If the
    // merge had left a switch stale, pressing Save on Scan would write
    // the stale switch value over the store. This asserts the fixed
    // code does not have that hole for the TAPPED key.
    await openAutoQueue()
    fireEvent.click(sw('auto_queue_cv'))
    await waitFor(() => expect(store.auto_queue_cv).toBe(false))
    vi.mocked(api.updateSettings).mockClear()

    await backToScan()
    fireEvent.change(
      (await screen.findByLabelText(/Skip listings matching less than/i)),
      { target: { value: '0.5' } }
    )
    const save = screen.getByRole('button', { name: /save/i })
    fireEvent.click(save)
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalled())
    const sent = vi.mocked(api.updateSettings).mock.calls[0][0] as S
    expect(sent.auto_queue_cv, 'Save must not write a stale switch back over the store').toBe(false)
  })
})