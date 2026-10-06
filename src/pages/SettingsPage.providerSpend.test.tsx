/**
 * WHAT THE AI PROVIDER BUDGET SECTION SHOWS.
 *
 * The defect was that this section showed one number — the cap the user
 * typed — beside no other number at all, on a real 6h44m window in which 629
 * provider requests had been issued against a cap of 50. The 629 existed,
 * computed correctly by `providerBudget` in the main process, and had no
 * route to the screen; nothing in the renderer knew it.
 *
 * So these tests drive the real page and assert on what a reader would see,
 * with the api mocked at the bridge — the seam where the number was being
 * lost. Three of them are about states that are easy to render wrongly and
 * hard to notice:
 *
 *   * a read that FAILED must not render as `0` against the cap, which is a
 *     claim nothing knows to be true and is indistinguishable from the truth;
 *   * a `freeAt` at or before the reading's own `now` must not be named,
 *     which is the bug that shipped 2,315 copies of a moment 3.4 to 9.7 hours
 *     in the past;
 *   * the cap input and the spend must be the same cap, so raising one
 *     re-reads the ledger rather than leaving the old cap's numbers on
 *     screen beside the new value.
 *
 * Each test builds its `now` explicitly and every row's `freeAt` relative to
 * it, so nothing here reads a clock to decide what it expects.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import SettingsPage from './SettingsPage'
import { api } from '../api'
import type { ProviderSpend } from '../providerSpend'

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

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
  auto_tailor_fit: false,
  auto_tailor_min_fit: 0,
  auto_queue_fit: true,
  auto_queue_cv: true,
  auto_queue_cover_letter: true,
  auto_queue_verify_cv: true,
  auto_queue_verify_cover_letter: true,
  quick_apply_shortcut: null,
  scraper_proxy: '',
  provider_call_cap: 50
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
    saveApiModels: vi.fn(async (models: unknown[]) => models),
    providerSpend: vi.fn(async () => [])
  }
}))

/** The ledger as the main process would report it for one provider. */
function row(over: Partial<ProviderSpend> = {}): ProviderSpend {
  return {
    label: 'openrouter.ai',
    used: 0,
    automated: 0,
    manual: 0,
    cap: 50,
    freeAt: null,
    clockSkewed: false,
    ...over
  }
}

async function openAutoQueueTab(): Promise<HTMLElement> {
  render(<SettingsPage />)
  fireEvent.click(await screen.findByRole('button', { name: /^Auto-queue$/i }))
  return screen.findByLabelText(/Let each AI provider answer this many requests a day/i)
}

beforeEach(() => {
  // The mocks are module-level, so their call history is shared by every test
  // in this file unless it is cleared here — and two of these tests assert on
  // how many times the ledger was read.
  vi.mocked(api.providerSpend).mockReset()
  vi.mocked(api.updateSettings).mockReset()
  vi.mocked(api.getSettings).mockResolvedValue({ ...baseSettings } as never)
  vi.mocked(api.providerSpend).mockResolvedValue([])
  vi.mocked(api.updateSettings).mockResolvedValue({ ...baseSettings } as never)
})

describe('the cap input shows the spend it is being compared against', () => {
  it('says how many requests went out against the cap, not the cap twice', async () => {
    const now = Date.now()
    vi.mocked(api.providerSpend).mockResolvedValue([
      row({ used: 629, automated: 50, manual: 579, cap: 50, freeAt: now + 6 * HOUR })
    ])

    const capInput = await openAutoQueueTab()

    // The number the defect was about: 629 against a cap of 50, in the UI.
    expect(await screen.findByText(/629 calls in the last 24h against a cap of 50/)).toBeInTheDocument()
    // ...in the same section as the input it is compared against, which is the
    // whole placement claim: not on another tab, not in a corner of Settings.
    const section = (await screen.findByText('AI provider budget', { selector: '.section-title' }))
      .parentElement as HTMLElement
    expect(section).toContainElement(capInput)
    expect(section).toContainElement(screen.getByTestId('provider-spend-count'))
  })

  it('renders one row per provider, each with its own count and cap', async () => {
    const now = Date.now()
    vi.mocked(api.providerSpend).mockResolvedValue([
      row({ label: 'openrouter.ai', used: 629, automated: 50, manual: 579, cap: 50, freeAt: now + 6 * HOUR }),
      row({ label: 'opencode.ai', used: 3, automated: 3, manual: 0, cap: 50, freeAt: null })
    ])

    await openAutoQueueTab()

    const rows = await screen.findAllByTestId('provider-spend-row')
    expect(rows).toHaveLength(2)
    expect(rows[0]).toHaveTextContent('openrouter.ai')
    expect(rows[0]).toHaveTextContent('629 calls in the last 24h against a cap of 50')
    expect(rows[1]).toHaveTextContent('opencode.ai')
    expect(rows[1]).toHaveTextContent('3 calls in the last 24h against a cap of 50')
  })

  it('names the day the budget frees on, so the moment cannot be read as one already past', async () => {
    const now = Date.now()
    vi.mocked(api.providerSpend).mockResolvedValue([row({ used: 629, freeAt: now + 6 * HOUR })])
    const freeAt = now + 6 * HOUR

    await openAutoQueueTab()

    const said = await screen.findByTestId('provider-spend-free')
    expect(said.textContent).toMatch(/Budget frees at \d{1,2}[:.]\d{2}.* on /)
    expect(said).toHaveTextContent(
      new Date(freeAt).toLocaleDateString([], { day: 'numeric', month: 'short' })
    )
  })

  it('says the budget is available instead of naming a moment for a wait that does not exist', async () => {
    vi.mocked(api.providerSpend).mockResolvedValue([row({ used: 12, freeAt: null })])

    await openAutoQueueTab()

    expect(await screen.findByTestId('provider-spend-free')).toHaveTextContent('Budget is available now.')
    expect(screen.queryByText(/Budget frees at/)).toBeNull()
  })

  it('qualifies a ledger the clock has made untrustworthy instead of presenting it as sound', async () => {
    vi.mocked(api.providerSpend).mockResolvedValue([row({ used: 4, clockSkewed: true })])
    await openAutoQueueTab()

    // The count is still there — hiding it would hide the anomaly rather than
    // fix it — but it is not presented as a number to act on.
    expect(await screen.findByTestId('provider-spend-count')).toHaveTextContent('4 calls in the last 24h')
    expect(screen.getByTestId('provider-spend-skew')).toHaveTextContent(/clock was wrong/i)
  })
})

describe('a read that did not happen is not a provider that spent nothing', () => {
  it('says it could not read the spend and renders no numbers', async () => {
    vi.mocked(api.providerSpend).mockRejectedValue(new Error('ledger unreadable'))

    await openAutoQueueTab()

    expect(await screen.findByTestId('provider-spend-failed')).toHaveTextContent(/could not read/i)
    // The load-bearing half: no row, and specifically no `0` standing in for
    // an unknown. A zero here would read as a measurement.
    expect(screen.queryByTestId('provider-spend-row')).toBeNull()
    expect(screen.queryByTestId('provider-spend-count')).toBeNull()
    expect(screen.queryByText(/0 calls in the last 24h/)).toBeNull()
  })

  it('shows nothing at all while the read is still in flight', async () => {
    // A loading state that renders a placeholder zero has told the user the
    // provider has spent nothing, and `findBy` on the failure text must not
    // race it.
    let release: (rows: ProviderSpend[]) => void = () => undefined
    vi.mocked(api.providerSpend).mockReturnValue(
      new Promise<ProviderSpend[]>((resolve) => { release = resolve })
    )

    await openAutoQueueTab()

    expect(screen.getByTestId('provider-spend-loading')).toBeInTheDocument()
    expect(screen.queryByTestId('provider-spend-count')).toBeNull()

    release([row({ used: 9 })])
    expect(await screen.findByText(/9 calls in the last 24h/)).toBeInTheDocument()
    expect(screen.queryByTestId('provider-spend-loading')).toBeNull()
  })

  it('reports an empty ledger as an absent provider, not as a measured zero', async () => {
    // Nothing configured and nothing recorded: the honest answer names the
    // absence. A row reading `0 calls against a cap of 50` would be a claim
    // about a provider the user never configured.
    vi.mocked(api.providerSpend).mockResolvedValue([])

    await openAutoQueueTab()

    expect(await screen.findByTestId('provider-spend-empty')).toHaveTextContent(/no ai provider is configured/i)
    expect(screen.queryByTestId('provider-spend-count')).toBeNull()
    expect(screen.queryByText(/0 calls/)).toBeNull()
  })

  it('survives a bridge with no providerSpend method on it', async () => {
    // An older preload, or a renderer test that predates the method. The page
    // must not throw on a missing method and must not invent numbers to cover
    // the gap — it lands in the same "could not read" state, for the same
    // reason.
    vi.mocked(api.providerSpend).mockImplementation(() => {
      throw new Error('API method "providerSpend" is unavailable.')
    })

    await openAutoQueueTab()

    expect(await screen.findByTestId('provider-spend-failed')).toBeInTheDocument()
    expect(screen.queryByText(/calls in the last 24h/)).toBeNull()
  })
})

describe('a free time that has already gone by is not named', () => {
  it('falls back to saying the wait is unknown rather than naming a past moment', async () => {
    // The same trap as the queue's cap message, on this surface: a moment at
    // or before the reading's own `now`. This page reads the ledger and
    // renders it a moment later, so the two are genuinely different instants,
    // and the page cannot tell the user to come back for a moment that has
    // already passed.
    vi.mocked(api.providerSpend).mockResolvedValue([
      row({ used: 629, freeAt: Date.now() - 4 * HOUR })
    ])

    await openAutoQueueTab()

    const free = await screen.findByTestId('provider-spend-free')
    expect(free).toHaveTextContent(/not known yet/i)
    expect(free.textContent).not.toMatch(/Budget frees at/)
    expect(free.textContent).not.toMatch(/\d{1,2}[:.]\d{2}/)
    // The spend itself is still reported.
    expect(screen.getByTestId('provider-spend-count')).toHaveTextContent('629 calls in the last 24h')
  })
})

describe('the input and the numbers beside it cannot disagree', () => {
  it('re-reads the ledger after the cap is written, so the row shows the cap being enforced', async () => {
    vi.mocked(api.providerSpend).mockResolvedValue([row({ used: 629, cap: 50, freeAt: null })])
    const capInput = await openAutoQueueTab()
    await screen.findByText(/629 calls in the last 24h against a cap of 50/)
    expect(api.providerSpend).toHaveBeenCalledTimes(1)

    // The ledger now reports the raised cap — which is what `resolveProviderCap`
    // would enforce.
    vi.mocked(api.updateSettings).mockResolvedValue({ ...baseSettings, provider_call_cap: 200 } as never)
    vi.mocked(api.providerSpend).mockResolvedValue([row({ used: 629, cap: 200, freeAt: null })])

    fireEvent.change(capInput, { target: { value: '200' } })

    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledWith({ provider_call_cap: 200 }))
    expect(await screen.findByText(/629 calls in the last 24h against a cap of 200/)).toBeInTheDocument()
    // The old cap's sentence is gone, not merely covered by a newer one.
    expect(screen.queryByText(/against a cap of 50/)).toBeNull()
    expect(capInput).toHaveValue(200)
  })

  it('does not re-read the ledger while the tab is closed', async () => {
    // The spend belongs to this section; a tab that is not open should not be
    // reading a ledger.
    vi.mocked(api.providerSpend).mockResolvedValue([])
    await openAutoQueueTab()
    await screen.findByTestId('provider-spend-empty')
    expect(api.providerSpend).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: /^Scan$/i }))
    await screen.findByLabelText(/Skip listings matching less than/i)
    expect(api.providerSpend).toHaveBeenCalledTimes(1)

    // ...and re-reads when it is opened again, since the ledger moves.
    fireEvent.click(screen.getByRole('button', { name: /^Auto-queue$/i }))
    await screen.findByTestId('provider-spend-empty')
    expect(api.providerSpend).toHaveBeenCalledTimes(2)
  })

  it('leaves the spend visible on the tab when the cap write fails', async () => {
    // A failed write rolls the input back; the numbers next to it are still
    // the ledger's, and hiding them would make a save error look like a
    // missing provider.
    vi.mocked(api.providerSpend).mockResolvedValue([row({ used: 629, cap: 50, freeAt: null })])
    const capInput = await openAutoQueueTab()
    await screen.findByText(/629 calls in the last 24h against a cap of 50/)

    vi.mocked(api.updateSettings).mockRejectedValue(new Error('disk full'))
    fireEvent.change(capInput, { target: { value: '200' } })

    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledWith({ provider_call_cap: 200 }))
    await waitFor(() => expect(capInput).toHaveValue(50))
    expect(screen.getByTestId('provider-spend-count')).toHaveTextContent('629 calls in the last 24h against a cap of 50')
  })

  it('re-reads the ledger on a refresh instead of keeping a copy that has gone stale', async () => {
    // Nothing on this page ticks. The free time is a moment, not a countdown,
    // so the only way it can stay honest is to be re-read — which is why the
    // tab reads on open, on refresh, and after a cap write, and holds a
    // `now` from the read rather than one taken at render time.
    vi.mocked(api.providerSpend).mockResolvedValue([row({ used: 629, freeAt: null })])
    await openAutoQueueTab()
    expect(await screen.findByText(/629 calls in the last 24h/)).toBeInTheDocument()

    vi.mocked(api.providerSpend).mockResolvedValue([row({ used: 631, freeAt: null })])
    window.dispatchEvent(new Event('app:refresh'))

    expect(await screen.findByText(/631 calls in the last 24h/)).toBeInTheDocument()
    expect(screen.queryByText(/629 calls in the last 24h/)).toBeNull()
  })
})

describe('the section keeps diagnostics out of the UI', () => {
  it('names no key, no model and no store field', async () => {
    // The app's rule: the UI shows outcomes, not internals. The spend rows are
    // inside the Auto-queue panel the existing copy test already scopes, so
    // this is the same rule applied to the new numbers — and a provider label
    // is a HOST, which is why `ai:providerSpend` trims the path off it.
    vi.mocked(api.providerSpend).mockResolvedValue([
      row({ label: 'openrouter.ai', used: 629, automated: 50, manual: 579, cap: 50, freeAt: Date.now() + DAY })
    ])
    await openAutoQueueTab()

    const section = await screen.findByText('AI provider budget', { selector: '.section-title' })
    const panel = (section.parentElement as HTMLElement).textContent ?? ''
    expect(panel).toMatch(/629 calls in the last 24h against a cap of 50/)
    expect(panel).not.toMatch(/api_key|provider_call_cap|provider_spend|#|deepseek|sk-/i)
  })

  it('gives each provider row no control, because the section reports and does not decide', async () => {
    // The project's rule is that automation never makes a user-review
    // decision. A spend row that could be clicked, ranked or filtered is the
    // first step towards a page that tells the user which provider to use —
    // which is their call to make, with the numbers this section now shows
    // them. So a row is text, and only text.
    vi.mocked(api.providerSpend).mockResolvedValue([
      row({ used: 629, freeAt: Date.now() + HOUR }),
      row({ label: 'opencode.ai', used: 0, freeAt: null })
    ])
    await openAutoQueueTab()

    const rows = await screen.findAllByTestId('provider-spend-row')
    expect(rows).toHaveLength(2)
    for (const row of rows) {
      expect(row.querySelector('button, input, select, a')).toBeNull()
    }
  })
})
