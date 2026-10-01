import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import SettingsPage, { PRESETS } from './SettingsPage'
import { api } from '../api'

const baseSettings = {
  openai_api_key: '',
  openai_base_url: '',
  openai_model: '',
  user_name: '',
  user_email: '',
  user_phone: '',
  user_country: '',
  base_cv: '',
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
  auto_queue_fit: true,
  auto_queue_cv: true,
  auto_queue_cover_letter: true,
  auto_queue_verify_cv: true,
  auto_queue_verify_cover_letter: true,
  quick_apply_shortcut: null,
  scraper_proxy: ''
} as const

vi.mock('../api', () => ({
  api: {
    getSettings: vi.fn(async () => ({ ...baseSettings })),
    listApiModels: vi.fn(async () => []),
    getSecurityStatus: vi.fn(async () => ({ mode: 'sealed' })),
    listBlacklistedCompanies: vi.fn(async () => []),
    getBackupStatus: vi.fn(async () => ({ lastSuccessAt: '', lastError: '' })),
    listBoards: vi.fn(async () => []),
    updateSettings: vi.fn(async (partial: Record<string, unknown>) => ({ ...baseSettings, ...partial })),
    saveApiModels: vi.fn(async (models: unknown[]) => models)
  }
}))

describe('SettingsPage PRESETS', () => {
  // These assert SHAPE and COVERAGE invariants, never specific model names.
  // Earlier rounds of this file asserted exact slugs, which went stale within
  // a week and — worse — actively blocked good models, because a slug that
  // had been dropped for being dead later came back to the free tier healthy.
  // Names rot; the invariants below do not.

  const slugs = PRESETS.map((p) => p.model.model)
  const vendors = new Set(slugs.map((s) => s.split('/')[0]))

  it('offers enough presets that one provider outage cannot starve the rotation', () => {
    // The user's pool collapsed to near-total failure because it was both
    // small and concentrated. Floor guards the size, ceiling keeps the
    // quick-add row usable.
    expect(PRESETS.length).toBeGreaterThanOrEqual(8)
    expect(PRESETS.length).toBeLessThanOrEqual(14)
  })

  it('spreads presets across several vendors so no single 429 storm is fatal', () => {
    // 10 presets over 7 vendor namespaces today. A floor of 5 means the list
    // can never quietly regress to "nearly all one vendor" again.
    expect(vendors.size).toBeGreaterThanOrEqual(5)
  })

  it('points every preset at OpenRouter with a blank key to inherit', () => {
    for (const preset of PRESETS) {
      expect(preset.model.base_url).toBe('https://openrouter.ai/api/v1')
      expect(preset.model.api_key).toBe('')
    }
  })

  it('only offers free-tier slugs', () => {
    // Anything without the :free suffix bills real money on every CV tail.
    for (const slug of slugs) {
      expect(slug).toMatch(/:free$/)
    }
  })

  it('never lists the same model twice', () => {
    // A duplicate quick-add button silently doubles that model's weight in
    // the rotation, which is how one vendor ends up dominating anyway.
    expect(new Set(slugs).size).toBe(slugs.length)
  })

  it('never offers a rerank or embedding model', () => {
    // These only serve /api/v1/rerank and /embeddings; sent to
    // /chat/completions they 400. Mirrors RERANK_MODEL_PATTERNS in
    // electron/ai.ts, which keeps them out of rotation but does not stop
    // them being offered as a preset.
    const nonChat = [/rerank/i, /embed/i, /(^|-)clip(-|$)/i, /bge-/i]
    for (const slug of slugs) {
      for (const pattern of nonChat) {
        expect(slug).not.toMatch(pattern)
      }
    }
  })

  it('gives every preset a unique, non-empty label for its button and card', () => {
    const names = PRESETS.map((p) => p.name)
    const cardNames = PRESETS.map((p) => p.model.name)
    for (const name of [...names, ...cardNames]) {
      expect(name.trim().length).toBeGreaterThan(0)
    }
    expect(new Set(names).size).toBe(names.length)
    expect(new Set(cardNames).size).toBe(cardNames.length)
  })

  it('describes every preset accurately as key-required', () => {
    for (const preset of PRESETS) {
      expect(preset.desc).toBe('via OpenRouter (needs API key)')
    }
  })

  it('renders the Models tab without throwing', async () => {
    render(<SettingsPage />)
    fireEvent.click(await screen.findByRole('button', { name: /Models/i }))
    expect(await screen.findByText(/Presets — click to add/i)).toBeInTheDocument()
    const presetButtons = await screen.findAllByTitle(/via OpenRouter \(needs API key\)/i)
    expect(presetButtons.length).toBe(PRESETS.length)
  })
})

describe('SettingsPage scan_min_match (the scan match floor)', () => {
  // The floor used to be a hardcoded 0.25, and it never actually
  // filtered anything. It is now user-tunable, and the copy has to state
  // the two things a user cannot see: that it only works with a base CV,
  // and which direction raises/lowers the bar.
  async function openScanTab() {
    render(<SettingsPage />)
    fireEvent.click(await screen.findByRole('button', { name: /^Scan$/i }))
    return screen.findByLabelText(/Skip listings matching less than/i)
  }

  it('shows the saved threshold on the Scan tab', async () => {
    const input = await openScanTab()
    expect(input).toHaveValue(0.25)
  })

  it('explains what it does, and the no-base-CV case, in one line', async () => {
    await openScanTab()
    const copy = screen.getByText(/compares each listing against your base CV/i)
    expect(copy).toHaveTextContent(/skips anything scoring under this/i)
    expect(copy).toHaveTextContent(/raise it to keep only strong matches/i)
    expect(copy).toHaveTextContent(/lower it \(or set 0\) to catch more/i)
    expect(copy).toHaveTextContent(/with none configured there is nothing to compare against/i)
  })

  it('persists a raised threshold through the Scan tab Save button', async () => {
    const input = await openScanTab()
    vi.mocked(api.updateSettings).mockClear()
    fireEvent.change(input, { target: { value: '0.6' } })
    fireEvent.click(screen.getByRole('button', { name: /Save settings/i }))
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalled())
    expect(vi.mocked(api.updateSettings).mock.calls[0][0]).toMatchObject({ scan_min_match: 0.6 })
  })

  it('rejects a value outside 0-1 rather than writing it', async () => {
    // A NaN or out-of-range threshold in the store makes the floor
    // either a no-op or a wall; the main process clamps, and the control
    // refuses to produce the value in the first place.
    const input = await openScanTab()
    vi.mocked(api.updateSettings).mockClear()
    fireEvent.change(input, { target: { value: '4' } })
    expect(input).toHaveValue(0.25)
    fireEvent.change(input, { target: { value: '' } })
    expect(input).toHaveValue(0.25)
  })
})

describe('SettingsPage API key inheritance', () => {
  // The model cards render one password input per configured model, in
  // list order, so index N is the Nth model's key.
  function keyInputs(): HTMLInputElement[] {
    return Array.from(document.querySelectorAll('input[type="password"]'))
  }

  async function openModelsTab() {
    render(<SettingsPage />)
    fireEvent.click(await screen.findByRole('button', { name: /Models/i }))
    await screen.findByText(/Presets — click to add/i)
  }

  it("fills a new preset with the key already saved for that provider", async () => {
    vi.mocked(api.listApiModels).mockResolvedValue([
      { id: '1', name: 'My Router Model', base_url: 'https://openrouter.ai/api/v1', api_key: 'sk-or-secret', model: 'some/other:free' }
    ])
    await openModelsTab()

    // Click the last preset, which is not yet in the list.
    const preset = PRESETS[PRESETS.length - 1]
    fireEvent.click(await screen.findByText(preset.name))

    const inputs = keyInputs()
    expect(inputs).toHaveLength(2)
    expect(inputs[1]).toHaveValue('sk-or-secret')
  })

  it('fills a new blank model with the key already saved for that provider', async () => {
    vi.mocked(api.listApiModels).mockResolvedValue([
      { id: '1', name: 'DeepSeek', base_url: 'https://api.deepseek.com', api_key: 'sk-ds-secret', model: 'deepseek-chat' }
    ])
    await openModelsTab()

    fireEvent.click(screen.getByRole('button', { name: /Add blank model/i }))

    const inputs = keyInputs()
    expect(inputs).toHaveLength(2)
    expect(inputs[1]).toHaveValue('sk-ds-secret')
  })

  it('leaves the key blank when no model for that provider exists yet', async () => {
    vi.mocked(api.listApiModels).mockResolvedValue([
      { id: '1', name: 'DeepSeek', base_url: 'https://api.deepseek.com', api_key: 'sk-ds-secret', model: 'deepseek-chat' }
    ])
    await openModelsTab()

    const preset = PRESETS[PRESETS.length - 1]
    fireEvent.click(await screen.findByText(preset.name))

    const inputs = keyInputs()
    expect(inputs).toHaveLength(2)
    expect(inputs[1]).toHaveValue('')
  })

  it('fills the key when the saved model uses a different spelling of the same provider URL', async () => {
    // Regression: the user's own config typed the OpenRouter path without
    // `/v1`, so exact-string matching never found the sibling key.
    vi.mocked(api.listApiModels).mockResolvedValue([
      { id: '1', name: 'My Router Model', base_url: 'https://openrouter.ai/api', api_key: 'sk-or-secret', model: 'some/other:free' }
    ])
    await openModelsTab()

    const preset = PRESETS[PRESETS.length - 1]
    fireEvent.click(await screen.findByText(preset.name))

    const inputs = keyInputs()
    expect(inputs).toHaveLength(2)
    expect(inputs[1]).toHaveValue('sk-or-secret')
  })
})

describe('SettingsPage Auto-queue tab', () => {
  // The tab's job is to show what is persisted and write back what the
  // user changes. Two failure modes matter and both are invisible to a
  // type check: a switch rendered ON when the store says off (the user
  // reads the tab, believes generation is still automatic, and it isn't
  // — or worse, the reverse, and they think they turned something off
  // that is still running), and a change that never reaches the store.
  //
  // The stored state is read through the same api mock every other suite
  // here uses, so these tests exercise the real load path, including the
  // "older store has no such key" backfill.

  // A mixed on/off store: two switches on, two off. A tab that showed all
  // five the same way would be reading a constant, not the settings.
  const persisted = {
    ...baseSettings,
    auto_queue_fit: true,
    auto_queue_cv: false,
    auto_queue_cover_letter: true,
    auto_queue_verify_cv: false,
    auto_queue_verify_cover_letter: true
  }

  async function openAutoQueueTab() {
    render(<SettingsPage />)
    fireEvent.click(await screen.findByRole('button', { name: /^Auto-queue$/i }))
    return screen.findByLabelText(/Auto-queue fit scoring/i)
  }

  beforeEach(() => {
    vi.mocked(api.getSettings).mockResolvedValue({ ...persisted } as never)
  })

  it('offers a switch for each kind of work', async () => {
    await openAutoQueueTab()
    for (const label of [
      /Auto-queue fit scoring/i,
      /Auto-queue CV generation/i,
      /Auto-queue cover letter generation/i,
      /Auto-review CV/i,
      /Auto-review cover letter/i
    ]) {
      expect(await screen.findByLabelText(label)).toBeInTheDocument()
    }
  })

  it('shows the persisted state on load, not a default', async () => {
    const fit = await openAutoQueueTab()
    expect(fit).toBeChecked()
    expect(screen.getByLabelText(/Auto-queue CV generation/i)).not.toBeChecked()
    expect(screen.getByLabelText(/Auto-queue cover letter generation/i)).toBeChecked()
    expect(screen.getByLabelText(/Auto-review CV/i)).not.toBeChecked()
    expect(screen.getByLabelText(/Auto-review cover letter/i)).toBeChecked()
  })

  it('shows an older store with no such key as on, not off', async () => {
    // A store written before these keys existed has none of them, and the
    // value that will actually be enforced is on. Showing a switch off
    // here would tell the user a feature is off that is still running.
    const { auto_queue_fit, ...withoutKeys } = persisted
    void auto_queue_fit
    vi.mocked(api.getSettings).mockResolvedValue(withoutKeys as never)
    const fit = await openAutoQueueTab()
    expect(fit).toBeChecked()
  })

  it('writes the changed key back through the settings save path', async () => {
    const fit = await openAutoQueueTab()
    vi.mocked(api.updateSettings).mockClear()
    fireEvent.click(fit)
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledWith({ auto_queue_fit: false }))
  })

  it('turns a switch on again just as it turns one off', async () => {
    // One direction only would be a tab that can stop work but never
    // restart it — the user would have no way back to the app behaving
    // as it shipped.
    await openAutoQueueTab()
    const cv = screen.getByLabelText(/Auto-queue CV generation/i)
    vi.mocked(api.updateSettings).mockClear()
    expect(cv).not.toBeChecked()
    fireEvent.click(cv)
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledWith({ auto_queue_cv: true }))
  })

  it('persists each switch under its own key, never a whole object', async () => {
    // A whole-settings write would stamp every other field the user has
    // unsaved on another tab. One key per change is what the main
    // process's updateSettings expects.
    await openAutoQueueTab()
    vi.mocked(api.updateSettings).mockClear()
    fireEvent.click(screen.getByLabelText(/Auto-review cover letter/i))
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledWith({ auto_queue_verify_cover_letter: false }))
    expect(vi.mocked(api.updateSettings).mock.calls[0][0]).toEqual({ auto_queue_verify_cover_letter: false })
  })

  it('shows the value the main process persisted, not the one tapped', async () => {
    // The store is authoritative: it normalises what it stores, and the
    // response carries the result. Trusting the tap instead would let the
    // switch show something the store does not hold.
    const fit = await openAutoQueueTab()
    vi.mocked(api.updateSettings).mockResolvedValue({ ...persisted, auto_queue_fit: true } as never)
    fireEvent.click(fit)
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalled())
    await waitFor(() => expect(screen.getByLabelText(/Auto-queue fit scoring/i)).toBeChecked())
  })

  it('puts the switch back when the save fails', async () => {
    // Optimistic UI that never rolls back leaves the tab lying about the
    // store after any failed write — the user sees "off" and the app
    // keeps queueing.
    const fit = await openAutoQueueTab()
    vi.mocked(api.updateSettings).mockRejectedValueOnce(new Error('disk full'))
    fireEvent.click(fit)
    await waitFor(() => expect(screen.getByLabelText(/Auto-queue fit scoring/i)).toBeChecked())
  })

  it('gives every switch an accessible name', async () => {
    // The label is the accessible name, so a screen-reader user hears
    // which of the five they are changing rather than "checkbox".
    await openAutoQueueTab()
    for (const input of screen.getAllByRole('checkbox')) {
      expect(input).toHaveAccessibleName()
    }
  })

  it('reaches every switch from the keyboard', async () => {
    await openAutoQueueTab()
    // Each switch is a real focusable form control, not a styled div with
    // a click handler: tabbing reaches it and the browser activates it.
    // That is what preserves keyboard operation through the custom
    // checkbox appearance, and it is why the styling lives in CSS on the
    // native element instead of being reimplemented.
    const switches = screen.getAllByRole('checkbox')
    expect(switches).toHaveLength(5)
    for (const input of switches) {
      expect(input.tagName).toBe('INPUT')
      input.focus()
      expect(input).toHaveFocus()
    }
  })

  it('says the switches do not affect work the user asks for', async () => {
    // The whole feature turns on this being true. A user who thinks a
    // switch kills the Generate button has been told something false, so
    // the page states it in words rather than leaving it to be inferred.
    await openAutoQueueTab()
    expect(screen.getByText(/never stops you/i)).toBeInTheDocument()
  })

  it('keeps diagnostics out of the tab', async () => {
    // Project rule: the UI abstracts internal diagnostics. Nothing about
    // queue types, thresholds, or models belongs on this page.
    //
    // Scoped to the PANEL, deliberately. This used to read the Auto-queue
    // tab button's `.parentElement.parentElement`, which is
    // `.settings-page-sticky` — the page header plus the tab bar. The
    // panel is a SIBLING of that element, so every string forbidden
    // below could be pasted into the tab's own copy and this check would
    // still pass; it was standing between the rule and the panel without
    // ever seeing the panel. Each tab renders as a direct child of
    // `.settings-page` opening with a `.section-title`, so the panel is
    // the title node and its following siblings, up to the next title.
    await openAutoQueueTab()
    const page = document.querySelector('.settings-page')
    const children = Array.from(page?.children ?? [])
    const start = children.indexOf(screen.getByText('Auto-queue', { selector: '.section-title' }))
    expect(start).toBeGreaterThan(-1)
    const panel: Element[] = []
    for (let i = start; i < children.length; i++) {
      if (i > start && children[i].classList.contains('section-title')) break
      panel.push(children[i])
    }
    const text = panel
      .map((n) => n.textContent ?? '')
      .join('\n')
    // Not vacuous: the text just read is the panel's own real copy. A
    // wrong subtree or an empty read would fail this line rather than
    // pass the rule below by asserting nothing.
    expect(text).toMatch(/never stops you/i)
    expect(text).not.toMatch(/auto_queue_|score_fit|generate_cv|verify_cv|deepseek/i)
  })
})
