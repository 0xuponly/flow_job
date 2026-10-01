import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import SettingsPage from './SettingsPage'
import { api } from '../api'
import { notify } from '../components/Notifications'

// REVIEWER-ADDED. Not part of the reviewed commit (879e30d).
//
// The shipped SettingsPage.test.tsx "Auto-queue tab" block cannot fail
// for any of the four things the tab's correctness actually rests on:
//
//   1. INDEPENDENCE. It never toggles one switch and checks that the
//      other four kept their state, so one key driving all five — or a
//      write that clobbers a sibling — is invisible to it.
//   2. ATOMICITY. `shows the persisted state on load, not a default`
//      awaits the checkbox and reads it. A render that mounts every
//      switch `true` and corrects the off ones a tick later passes; a
//      user watching the tab sees a switch they had turned off spring
//      back on. This file records every value the panel has ever
//      committed, so a wrong value that is on screen for any length of
//      time fails.
//   3. NAME DISTINCTNESS. `gives every switch an accessible name` only
//      asserts `toHaveAccessibleName()`, a non-empty string. Five
//      controls all named "toggle" satisfies it, and five controls with
//      one name is a real screen-reader bug. The names here are derived
//      independently of jest-dom (see accName) so the claim does not
//      rest on the library the shipped assertion already uses.
//   4. THE UNSAVED-EDIT CONTRACT. This tab persists on change instead
//      of through the page Save button, so it shares one `settings`
//      state object with every batch-edited field in the file. No
//      shipped test puts an unsaved edit and a switch toggle in the
//      same session. This file does — and two of those tests fail
//      against the shipped code. See REVIEW_VERDICT.md finding 1.

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

/** The store the main process holds. Every updateSettings mock reads it. */
let store: S

/** A store whose five switches are on, OFF, on, OFF, on. */
function mixedStore(): S {
  return {
    ...baseSettings,
    auto_queue_fit: true,
    auto_queue_cv: false,
    auto_queue_cover_letter: true,
    auto_queue_verify_cv: false,
    auto_queue_verify_cover_letter: true
  }
}

const ROWS: { key: string; name: string }[] = [
  { key: 'auto_queue_fit', name: 'Auto-queue fit scoring' },
  { key: 'auto_queue_cv', name: 'Auto-queue CV generation' },
  { key: 'auto_queue_cover_letter', name: 'Auto-queue cover letter generation' },
  { key: 'auto_queue_verify_cv', name: 'Auto-review CV' },
  { key: 'auto_queue_verify_cover_letter', name: 'Auto-review cover letter' }
]

/**
 * The accessible name of a native checkbox, derived here rather than
 * taken from jest-dom: aria-label, then aria-labelledby, then the text
 * of every label that points at it or wraps it. That is the whole
 * algorithm for this markup. Hand-rolling it is what lets the
 * distinctness claim stand on its own rather than on the same library
 * the shipped assertion already leans on.
 */
function accName(input: HTMLInputElement): string {
  const aria = input.getAttribute('aria-label')
  if (aria?.trim()) return aria.trim()
  const ids = (input.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean)
  if (ids.length) {
    return ids.map((id) => document.getElementById(id)?.textContent ?? '').join(' ').trim()
  }
  // `input.labels` is the browser's own label list: `label[for]` plus any
  // wrapping label, each exactly once. Using it avoids double-counting a
  // label that both wraps the input and carries htmlFor.
  const labels = input.labels ? Array.from(input.labels) : []
  if (labels.length === 0 && input.parentElement?.tagName === 'LABEL') {
    labels.push(input.parentElement as HTMLLabelElement)
  }
  return labels
    .map((l) => l.textContent ?? '')
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function switches(): HTMLInputElement[] {
  return screen.getAllByRole('checkbox') as HTMLInputElement[]
}

function states(): Record<string, boolean> {
  return Object.fromEntries(switches().map((s) => [s.id, s.checked]))
}

async function openAutoQueue(): Promise<void> {
  render(<SettingsPage />)
  fireEvent.click(await screen.findByRole('button', { name: /^Auto-queue$/i }))
  await screen.findByLabelText(/Auto-queue fit scoring/i)
}

/**
 * The Auto-queue panel's own top-level nodes: everything from its
 * `.section-title` up to the next tab's `.section-title`. Deliberately
 * NOT the sticky header — see the shipped-diagnostics test for why that
 * distinction is the whole point.
 */
function panelNodes(): Element[] {
  const page = document.querySelector('.settings-page')
  const title = screen.getByText('Auto-queue', { selector: '.section-title' })
  const children = Array.from(page?.children ?? [])
  const start = children.indexOf(title)
  expect(start).toBeGreaterThan(-1)
  const out: Element[] = []
  for (let i = start; i < children.length; i++) {
    if (i > start && children[i].classList.contains('section-title')) break
    out.push(children[i])
  }
  return out
}

function panelText(): string {
  return panelNodes()
    .map((n) => n.textContent ?? '')
    .join('\n')
}

function panelCard(): HTMLElement {
  const card = panelNodes().find((n) => n.classList.contains('card'))
  if (!card) throw new Error('no .card in the Auto-queue panel')
  return card as HTMLElement
}

function sourceOf(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), 'utf8')
}

/** Drop every balanced `{...}` expression, so only the shipped copy is left. */
function stripBraces(src: string): string {
  let out = ''
  let depth = 0
  for (const ch of src) {
    if (ch === '{') depth++
    else if (ch === '}') depth = Math.max(0, depth - 1)
    else if (depth === 0) out += ch
  }
  return out
}

beforeEach(() => {
  store = mixedStore()
  vi.mocked(api.getSettings).mockImplementation(async () => ({ ...store }) as never)
  // The real main process returns the WHOLE settings object after a
  // partial write. Modelling that is the point: the tab's contract is
  // "show what the store holds", and a mock returning only the toggled
  // key would hide the defect this file is here to find.
  vi.mocked(api.updateSettings).mockImplementation((async (partial: Record<string, unknown>) => {
    store = { ...store, ...partial }
    return { ...store }
  }) as never)
  vi.mocked(api.updateSettings).mockClear()
  vi.mocked(notify).mockClear()
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// 1. All five render, and each is controlled by its own key.
// ---------------------------------------------------------------------------

describe('the five switches render', () => {
  it('renders one native checkbox per kind of work, with its own id', async () => {
    await openAutoQueue()
    expect(switches()).toHaveLength(5)
    for (const row of ROWS) {
      const el = document.getElementById(row.key)
      expect(el, row.key).toBeInstanceOf(HTMLInputElement)
      expect((el as HTMLInputElement).type).toBe('checkbox')
    }
  })

  it('shows the persisted value for a mixed store, one key at a time', async () => {
    await openAutoQueue()
    expect(states()).toEqual({
      auto_queue_fit: true,
      auto_queue_cv: false,
      auto_queue_cover_letter: true,
      auto_queue_verify_cv: false,
      auto_queue_verify_cover_letter: true
    })
  })

  it('shows a store with no such key as all on', async () => {
    for (const row of ROWS) delete store[row.key]
    await openAutoQueue()
    expect(states()).toEqual(Object.fromEntries(ROWS.map((r) => [r.key, true])))
  })
})

// ---------------------------------------------------------------------------
// 2. No flash. Every value the panel has ever committed, from first paint.
// ---------------------------------------------------------------------------

describe('the panel never paints a switch the store does not hold', () => {
  it('never shows an off switch as on, not even for one commit', async () => {
    // Records every value the panel has EVER committed for every switch,
    // by reading the live DOM inside a MutationObserver callback. A
    // render that mounts all five as `true` and corrects the two off
    // ones on a later commit leaves two values in the log and fails; a
    // user watching the tab would see the switch they had turned off
    // spring back on.
    const seen: Record<string, boolean[]> = {}
    const record = (): void => {
      for (const input of document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) {
        const log = (seen[input.id] ??= [])
        if (log[log.length - 1] !== input.checked) log.push(input.checked)
      }
    }
    // childList + subtree: a React commit that re-renders the panel
    // patches the input nodes and the callback runs as a microtask after
    // that commit, so it sees the committed value.
    const observer = new MutationObserver(record)
    observer.observe(document.body, { childList: true, subtree: true })

    try {
      await openAutoQueue()
      await act(async () => {
        await new Promise((r) => setTimeout(r, 20))
      })
      record()
    } finally {
      observer.disconnect()
    }

    expect(Object.keys(seen).sort()).toEqual(ROWS.map((r) => r.key).sort())
    for (const row of ROWS) {
      expect(seen[row.key], row.key).toEqual([store[row.key] as boolean])
    }
  })

  it('renders nothing at all until the settings have loaded', async () => {
    // The structural half of the same guarantee. `if (!settings) return
    // null` means there is no window in which a switch exists but has
    // no persisted value to show — not even a brief one on a page that
    // is still loading.
    let release: (s: S) => void = () => undefined
    vi.mocked(api.getSettings).mockImplementation(
      () => new Promise<S>((r) => { release = r }) as never
    )
    const { container } = render(<SettingsPage />)
    await act(async () => { await Promise.resolve() })
    expect(container.innerHTML).toBe('')
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0)
    await act(async () => { release({ ...store }) })
    expect(await screen.findByRole('button', { name: /^Auto-queue$/i })).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// 3. Independence.
// ---------------------------------------------------------------------------

describe('the switches are independently controlled', () => {
  it('changing one does not change any other, in either direction', async () => {
    await openAutoQueue()
    const before = states()

    // An OFF switch turned ON.
    fireEvent.click(document.getElementById('auto_queue_cv') as HTMLInputElement)
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledWith({ auto_queue_cv: true }))
    const afterOn = states()
    expect(afterOn.auto_queue_cv).toBe(true)
    for (const key of Object.keys(before).filter((k) => k !== 'auto_queue_cv')) {
      expect(afterOn[key], key).toBe(before[key])
    }

    // An ON switch turned OFF.
    fireEvent.click(document.getElementById('auto_queue_fit') as HTMLInputElement)
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledWith({ auto_queue_fit: false }))
    const afterOff = states()
    expect(afterOff.auto_queue_fit).toBe(false)
    for (const key of Object.keys(afterOn).filter((k) => k !== 'auto_queue_fit')) {
      expect(afterOff[key], key).toBe(afterOn[key])
    }
  })

  it('writes one key per change and never the whole object', async () => {
    await openAutoQueue()
    for (const key of ['auto_queue_cover_letter', 'auto_queue_verify_cv', 'auto_queue_fit']) {
      vi.mocked(api.updateSettings).mockClear()
      fireEvent.click(document.getElementById(key) as HTMLInputElement)
      await waitFor(() => expect(api.updateSettings).toHaveBeenCalledTimes(1))
      // A whole-settings write would stamp every unsaved field the user
      // has typed on another tab. One key per change is the contract.
      expect(vi.mocked(api.updateSettings).mock.calls[0][0]).toEqual({ [key]: expect.any(Boolean) })
    }
  })

  it('turning one off leaves the other four operable and unchanged', async () => {
    await openAutoQueue()
    const others = ROWS.map((r) => r.key).filter((k) => k !== 'auto_queue_fit')
    fireEvent.click(document.getElementById('auto_queue_fit') as HTMLInputElement)
    await waitFor(() => expect(states().auto_queue_fit).toBe(false))
    for (const key of others) {
      const el = document.getElementById(key) as HTMLInputElement
      expect(el, key).toBeEnabled()
      expect(el.checked, key).toBe(store[key] as boolean)
    }
  })

  it('puts a switch back when its own write fails', async () => {
    // Optimistic UI with no rollback leaves the tab lying about the
    // store after any failed write: the switch reads off and the app
    // keeps queueing.
    await openAutoQueue()
    vi.mocked(api.updateSettings).mockRejectedValueOnce(new Error('disk full'))
    fireEvent.click(document.getElementById('auto_queue_fit') as HTMLInputElement)
    await waitFor(() => expect(notify).toHaveBeenCalled())
    expect(vi.mocked(notify).mock.calls[0][0]).toMatch(/Failed to save auto-queue switch/i)
    await waitFor(() =>
      expect((document.getElementById('auto_queue_fit') as HTMLInputElement).checked).toBe(true)
    )
  })

  it('shows what the main process persisted, not what was tapped', async () => {
    // The store is authoritative: it normalises what it stores and the
    // response carries the result. Trusting the tap would let the
    // switch show something the store does not hold.
    await openAutoQueue()
    vi.mocked(api.updateSettings).mockResolvedValueOnce({ ...store, auto_queue_fit: true } as never)
    fireEvent.click(document.getElementById('auto_queue_fit') as HTMLInputElement)
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalled())
    await waitFor(() =>
      expect((document.getElementById('auto_queue_fit') as HTMLInputElement).checked).toBe(true)
    )
  })

  it('disables the switches while a write is in flight', async () => {
    // Documented, not a defect: the guard is what stops a double-click
    // racing two writes of different keys. A disabled form control is
    // inert in a browser, so the second click is dropped rather than
    // applied — the switch then shows the store's value once the write
    // lands, which is the honest answer.
    await openAutoQueue()
    let release: (s: S) => void = () => undefined
    vi.mocked(api.updateSettings).mockImplementationOnce(
      ((partial: Record<string, unknown>) =>
        new Promise<S>((r) => { release = () => r({ ...store, ...partial }) })) as never
    )
    fireEvent.click(document.getElementById('auto_queue_fit') as HTMLInputElement)
    for (const row of ROWS) {
      expect(document.getElementById(row.key), row.key).toBeDisabled()
    }
    await act(async () => { release({ ...store }) })
    await waitFor(() =>
      expect((document.getElementById('auto_queue_fit') as HTMLInputElement).checked).toBe(false)
    )
    for (const row of ROWS) {
      expect(document.getElementById(row.key), row.key).toBeEnabled()
    }
  })
})

// ---------------------------------------------------------------------------
// 4. Accessible names must be DISTINCT, not merely present.
// ---------------------------------------------------------------------------

describe('accessible names', () => {
  it('gives every switch a different accessible name', async () => {
    await openAutoQueue()
    const names = switches().map(accName)
    expect(names.every((n) => n.length > 0)).toBe(true)
    // Five controls all named "toggle" is a real screen-reader bug: a
    // user tabbing through hears the same word five times and cannot
    // tell which kind of work they are changing.
    expect(new Set(names).size).toBe(5)
  })

  it('names each switch after the work it governs', async () => {
    await openAutoQueue()
    const names = switches().map(accName)
    for (const row of ROWS) {
      expect(names, row.key).toContain(row.name)
    }
  })

  it('cross-checks the same names through jest-dom', async () => {
    // Same claim, second implementation: if the hand-rolled accName
    // above mis-derived what a screen reader announces, this catches it.
    await openAutoQueue()
    for (const input of switches()) {
      expect(input).toHaveAccessibleName(accName(input))
    }
  })
})

// ---------------------------------------------------------------------------
// 5. The unsaved-edit contract: this tab persists on change and shares
//    one `settings` state object with every batch-edited field.
// ---------------------------------------------------------------------------

describe('unsaved edits made on another tab', () => {
  async function typeScanMinMatch(value: number): Promise<HTMLInputElement> {
    render(<SettingsPage />)
    fireEvent.click(await screen.findByRole('button', { name: /^Scan$/i }))
    const input = (await screen.findByLabelText(/Skip listings matching less than/i)) as HTMLInputElement
    fireEvent.change(input, { target: { value: String(value) } })
    // The Scan tab batches: the value is in component state and the Save
    // button is what writes it. Nothing has reached the store yet.
    expect(input).toHaveValue(value)
    expect(store.scan_min_match).toBe(0.25)
    return input
  }

  it('loses an unsaved scan_min_match when a switch is toggled', async () => {
    // FIXED — toggleAutoQueue merges only the key it wrote
    //
    // The user raises the match floor on the Scan tab, does not press
    // Save, visits Auto-queue, turns one switch off, and comes back to a
    // match floor that has silently reverted to the stored value. The
    // Save button is still enabled — `scanDirty` was never cleared — so
    // pressing it persists the OLD value. The edit is gone and Save
    // looks like it worked.
    //
    // Cause: toggleAutoQueue does `setSettings(updated)` with the whole
    // object the main process returns (src/pages/SettingsPage.tsx:228),
    // which is the STORE's copy, so it overwrites every unsaved field
    // on the shared settings state.
    await typeScanMinMatch(0.9)

    fireEvent.click(await screen.findByRole('button', { name: /^Auto-queue$/i }))
    fireEvent.click(await screen.findByLabelText(/Auto-queue fit scoring/i))
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledWith({ auto_queue_fit: false }))

    fireEvent.click(await screen.findByRole('button', { name: /^Scan$/i }))
    expect(await screen.findByLabelText(/Skip listings matching less than/i)).toHaveValue(0.9)
  })

  it('loses an unsaved profile field the same way', async () => {
    // FIXED — same merge, on a field with real consequences: a name typed
    // on My Profile no longer reverts because of a switch on another tab.
    //
    // (Reached by display value, not by label: the Profile tab's labels
    // carry no `htmlFor` and do not wrap their inputs
    // (SettingsPage.tsx:657), so those four fields have no accessible
    // name at all. Pre-existing, out of scope for this review, recorded
    // in REVIEW_VERDICT.md under "could not verify".)
    render(<SettingsPage />)
    const name = (await screen.findByDisplayValue('Sam Rivera')) as HTMLInputElement
    fireEvent.change(name, { target: { value: 'Sam Rivera-Lee' } })
    expect(store.user_name).toBe('Sam Rivera')

    fireEvent.click(await screen.findByRole('button', { name: /^Auto-queue$/i }))
    fireEvent.click(await screen.findByLabelText(/Auto-review CV/i))
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalled())

    fireEvent.click(await screen.findByRole('button', { name: /^My Profile$/i }))
    expect(await screen.findByDisplayValue('Sam Rivera-Lee')).toBeInTheDocument()
  })

  it('does NOT lose an unsaved model, which lives in its own state', async () => {
    // The control the tab has to match, and does: `addPreset` only
    // touches the separate `models` state, so adding a preset and then
    // toggling a switch keeps it. Proves the defect above is about the
    // SHARED settings object, not about persisting immediately.
    // A custom model list so the preset buttons are not born disabled.
    vi.mocked(api.listApiModels).mockResolvedValue([
      { id: 'm1', name: 'Mine', base_url: 'https://api.example.com', api_key: 'k', model: 'mine-1' }
    ] as never)
    render(<SettingsPage />)
    fireEvent.click(await screen.findByRole('button', { name: /^Models$/i }))
    const nameInputs = () => screen.getAllByPlaceholderText('e.g. DeepSeek, Groq')
    const before = nameInputs().length
    fireEvent.click(screen.getAllByRole('button', { name: /Presets|Dots|Gemma|Phi/i })[0])
    await waitFor(() => expect(nameInputs().length).toBe(before + 1))

    fireEvent.click(await screen.findByRole('button', { name: /^Auto-queue$/i }))
    fireEvent.click(await screen.findByLabelText(/Auto-queue CV generation/i))
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalled())

    fireEvent.click(await screen.findByRole('button', { name: /^Models$/i }))
    await waitFor(() => expect(nameInputs().length).toBe(before + 1))
  })

  it('leaves the unsaved edit intact when the toggle FAILS', async () => {
    // The rollback path captures `settings` BEFORE the optimistic write
    // and restores the whole object, so the unsaved field survives. This
    // is the ordering the success path should have used too.
    await typeScanMinMatch(0.9)
    vi.mocked(api.updateSettings).mockRejectedValueOnce(new Error('disk full'))

    fireEvent.click(await screen.findByRole('button', { name: /^Auto-queue$/i }))
    fireEvent.click(await screen.findByLabelText(/Auto-queue fit scoring/i))
    await waitFor(() => expect(notify).toHaveBeenCalled())
    fireEvent.click(await screen.findByRole('button', { name: /^Scan$/i }))
    expect(await screen.findByLabelText(/Skip listings matching less than/i)).toHaveValue(0.9)
  })
})

// ---------------------------------------------------------------------------
// 6. Project rule: no internal diagnostics, rule JSON, model ids, queue
//    types or thresholds in the panel.
// ---------------------------------------------------------------------------

describe('the panel keeps internal detail out of the UI', () => {
  it('shows no queue types, setting keys, model ids, thresholds or URLs', async () => {
    await openAutoQueue()
    const text = panelText()
    expect(text).toBeTruthy()
    // The project's rule is that the UI states what the app does, never
    // how: no internal identifiers, no provider names, no numbers that
    // gate behaviour.
    expect(text).not.toMatch(
      /auto_queue_|score_fit|generate_cv|generate_cover_letter|verify_cv|regenerate_section|tailor_job_docs/i
    )
    expect(text).not.toMatch(/deepseek|openrouter|anthropic|openai|gpt-|claude|gemini|:free/i)
    expect(text).not.toMatch(/\b0\.\d+\b|\b\d{2,}\s*%|\bPASSING_REVIEW|AUTO_REGEN|\bmin[_ ]?fit\b/i)
    expect(text).not.toMatch(/https?:\/\//)
    expect(text).not.toMatch(/[{}[\]]/)
  })

  it('the shipped diagnostics check asserts on the header, not the panel', async () => {
    // SettingsPage.test.tsx reads
    //   getByRole('button', { name: /^Auto-queue$/i }).parentElement.parentElement
    // which is `.settings-page-sticky` — the page header plus the tab
    // bar. The Auto-queue panel is a SIBLING of that element, so every
    // string the check forbids could be pasted into the panel and the
    // check would still pass. It is the only thing standing between the
    // project rule and a future edit, so the gap is pinned here.
    await openAutoQueue()
    const sticky = screen.getByRole('button', { name: /^Auto-queue$/i }).parentElement!.parentElement!
    expect(sticky.className).toBe('settings-page-sticky')
    expect(sticky.textContent).not.toContain('Turning a switch off')
    // ...and the copy the shipped check never looks at is real copy that
    // does carry the words it is supposed to be policing.
    expect(panelText()).toContain('Turning a switch off')
  })

  it('the source of the tab block carries no internal detail either', async () => {
    // A DOM check only sees rendered text. This reads the block's source
    // so a diagnostic string hidden in a title attribute, an aria-label
    // or a constant is caught too.
    const src = sourceOf('src/pages/SettingsPage.tsx')
    const start = src.indexOf("{tab === 'autoqueue' && (")
    expect(start).toBeGreaterThan(-1)
    const end = src.indexOf("{tab === 'models' && (", start)
    expect(end).toBeGreaterThan(start)
    // Comments do not ship. `{...}` expressions are dropped too: they
    // hold the indirections into the key table above the component
    // (`row.key`, `row.label`), which is the contract with the main
    // process and legitimately spells the internal keys. What is left
    // is the block's own copy — JSX text and string literals — which is
    // exactly what ships to the screen.
    const block = src
      .slice(start, end)
      .replace(/^\{tab === 'autoqueue' && \(/, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '')
    const copy = stripBraces(block)
    expect(copy.length).toBeGreaterThan(80)
    expect(copy).not.toMatch(
      /auto_queue_|score_fit|generate_cv|generate_cover_letter|verify_cv|regenerate_section|tailor_job_docs/i
    )
    expect(copy).not.toMatch(/deepseek|openrouter|anthropic|openai|gpt-|claude|gemini|:free/i)
    expect(copy).not.toMatch(/\b0\.\d+\b|\b\d{2,}\s*%|\bPASSING_REVIEW|AUTO_REGEN|\bmin[_ ]?fit\b/i)
    expect(copy).not.toMatch(/https?:\/\//)
    // The copy it does ship, so the check above is not passing on an
    // empty string.
    expect(copy).toContain('Turning a switch off')
  })

  it('states in words that the switches never stop the user', async () => {
    // The whole feature turns on this being true. A user who reads a
    // switch as killing the Generate button has been told something
    // false, so the panel says it rather than leaving it to be inferred.
    await openAutoQueue()
    expect(panelText()).toMatch(/never stops you/i)
  })
})

// ---------------------------------------------------------------------------
// 7. Visual language: the app's own controls, not an invented one.
// ---------------------------------------------------------------------------

describe('the tab matches the controls already in this file', () => {
  it('uses the app card-and-divider row the Companies / blacklist list uses', async () => {
    await openAutoQueue()
    // Verbatim from the blacklist list at SettingsPage.tsx:1258-1268:
    // `.card` with `padding: 0`, rows at `10px 16px`, a
    // `1px solid var(--border)` divider between rows and none after the
    // last. The commit message claims this layout; here it is checked.
    const card = panelCard()
    expect(card.style.padding).toBe('0px')
    const rows = Array.from(card.children) as HTMLElement[]
    expect(rows).toHaveLength(5)
    rows.forEach((row, i) => {
      expect(row.style.padding, `row ${i}`).toBe('10px 16px')
      expect(row.style.display, `row ${i}`).toBe('flex')
      expect(row.style.alignItems, `row ${i}`).toBe('center')
      if (i < 4) {
        expect(row.style.borderBottom, `row ${i}`).toBe('1px solid var(--border)')
      } else {
        // jsdom's CSSOM serialises a `none` border-style back to its
        // initial value; a browser reports `none`. Both mean no divider.
        expect(['none', 'medium'], `row ${i}`).toContain(row.style.borderBottom)
      }
    })
  })

  it('uses a native checkbox under the app stylesheet, not a styled div', async () => {
    // A div with an onClick is not focusable, cannot be activated with
    // Space, and is invisible to a screen reader's form navigation. The
    // app styles `input[type="checkbox"]` globally
    // (src/styles/global.css:510), so a native input inherits the right
    // look for free and the two cannot drift.
    await openAutoQueue()
    for (const input of switches()) {
      expect(input.tagName).toBe('INPUT')
      expect(input.getAttribute('type')).toBe('checkbox')
      expect(input.id).toBeTruthy()
      expect(input.labels?.length, input.id).toBeGreaterThan(0)
    }
    expect(sourceOf('src/styles/global.css')).toMatch(/input\[type="checkbox"\]/)
  })

  it('invents no CSS class the rest of the app does not already use', async () => {
    await openAutoQueue()
    const used = new Set<string>()
    for (const el of document.querySelectorAll('.settings-page [class]')) {
      for (const c of el.className.split(/\s+/)) if (c) used.add(c)
    }
    expect(used.size).toBeGreaterThan(0)
    for (const c of used) {
      expect(c, `class "${c}"`).toMatch(
        /^(page|settings-page|settings-page-sticky|page-header|section-title|card|form-group|form-row-wrap|alert|alert-warning|btn|btn-primary|btn-secondary|btn-sm|filter-option)$/
      )
    }
  })
})

// ---------------------------------------------------------------------------
// 8. The second, unlinked "Auto-Queue" the Scan tab still shows.
// ---------------------------------------------------------------------------

describe('the Scan tab still has its own "Auto-Queue" control', () => {
  it('the scan-time auto-tailor switch is not one of the five, and the new tab cannot see it', async () => {
    // Two places in Settings now say "Auto-Queue" and disagree. The Scan
    // tab's own Auto-Queue section still owns `auto_tailor_on_scan`,
    // which is not one of the five switches and is not listed on the new
    // tab. A user who turns off "Auto-queue CV generation" and then
    // reads the Scan tab is told, in the app's own words, that the app
    // will "Queue CV + cover letter tailoring when a new job is added" —
    // a promise the gate silently breaks (proved at the queue level in
    // electron/review.enqueueCallSites.test.ts). Reported, not fixed:
    // whether the two controls should merge is a design decision.
    render(<SettingsPage />)
    fireEvent.click(await screen.findByRole('button', { name: /^Scan$/i }))
    const scanAutoQueue = (await screen.findByRole('checkbox', {
      name: /Queue CV \+ cover letter tailoring when a new job is added/i
    })) as HTMLInputElement
    // It is still its own control, saved by the Scan tab's Save button
    // rather than immediately.
    expect(store.auto_tailor_on_scan).toBe(false)
    fireEvent.click(scanAutoQueue)
    expect(scanAutoQueue).toBeChecked()
    expect(vi.mocked(api.updateSettings)).not.toHaveBeenCalled()

    // The new tab has no row for it, so there is no way to see or change
    // it from there.
    fireEvent.click(await screen.findByRole('button', { name: /^Auto-queue$/i }))
    await screen.findByLabelText(/Auto-queue fit scoring/i)
    expect(switches()).toHaveLength(5)
    expect(
      screen.queryByRole('checkbox', { name: /Queue CV \+ cover letter tailoring/i })
    ).toBeNull()
  })
})
