import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import SettingsPage, { PRESETS } from './SettingsPage'

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
  it('keeps 5-7 presets so the UI stays compact', () => {
    expect(PRESETS.length).toBeGreaterThanOrEqual(5)
    expect(PRESETS.length).toBeLessThanOrEqual(7)
  })

  it('uses only OpenRouter free models that are listed as of 2026-09-09', () => {
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

  it('renders the Models tab without throwing', async () => {
    render(<SettingsPage />)
    fireEvent.click(await screen.findByRole('button', { name: /Models/i }))
    expect(await screen.findByText(/Presets — click to add/i)).toBeInTheDocument()
    const presetButtons = await screen.findAllByTitle(/via OpenRouter \(needs API key\)/i)
    expect(presetButtons.length).toBe(PRESETS.length)
  })
})
