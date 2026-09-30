import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
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
