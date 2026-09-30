import { describe, it, expect, vi } from 'vitest'
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
  it('keeps 5-7 presets so the UI stays compact', () => {
    expect(PRESETS.length).toBeGreaterThanOrEqual(5)
    expect(PRESETS.length).toBeLessThanOrEqual(7)
  })

  it('uses only OpenRouter free models that are currently listed', () => {
    for (const preset of PRESETS) {
      expect(preset.model.base_url).toBe('https://openrouter.ai/api/v1')
      expect(preset.model.model).toMatch(/:free$/)
      expect(preset.model.api_key).toBe('')
    }
  })

  it('describes every preset accurately as key-required', () => {
    for (const preset of PRESETS) {
      expect(preset.desc).toBe('via OpenRouter (needs API key)')
    }
  })

  it('drops known-dead models from production logs', () => {
    const ids = PRESETS.map((p) => p.model.model)
    expect(ids).not.toContain('google/gemma-4-31b-it:free')
    expect(ids).not.toContain('nvidia/nemotron-3-super-120b-a12b:free')
    expect(ids).not.toContain('nvidia/nemotron-3-ultra-550b-a55b:free')
    expect(ids).not.toContain('poolside/laguna-s-2.1:free')
    expect(ids).not.toContain('big-pickle')
    expect(ids).not.toContain('mimo-v2.5-free')
    expect(ids).not.toContain('north-mini-code-free')
  })

  it('drops free models that have since left the OpenRouter free tier', () => {
    const ids = PRESETS.map((p) => p.model.model)
    expect(ids).not.toContain('nex-agi/nex-n2.5-mini:free')
    expect(ids).not.toContain('inclusionai/ling-3.0-flash-fin:free')
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
