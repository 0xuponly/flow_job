# FlowJob

Desktop assistant for the full job application lifecycle — track jobs, scan
multiple job boards, generate tailored CVs and cover letters, manage the
application pipeline, and track follow-ups and interviews. Built as an
Electron + React + TypeScript app with a flat-file JSON store encrypted at
rest.

## Setup

```bash
npm install
npm run dev
```

Requires Node.js 18+ and a working Electron environment. First launch will
create a sealed data-encryption key in the OS keyring (macOS Keychain, Linux
libsecret, or Windows DPAPI) and an encrypted `apply-assistant-data.json`
store under the app's `userData` directory.

### Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Start the Electron + Vite dev server with HMR. |
| `npm run build` | Production build of main, preload, and renderer bundles. |
| `npm run preview` | Build and run the packaged preview. |
| `npm run start` | Same as `preview`. |
| `npm run lint` | ESLint over the whole repo. |
| `npm run lint:fix` | ESLint with `--fix`. |
| `npm run typecheck` | `tsc --noEmit` over the test tsconfig. |
| `npm run test` | Vitest run. |
| `npm run test:watch` | Vitest watch mode. |

## Navigation

The sidebar exposes 8 pages, in this order: **Dashboard**, **Scan Jobs**,
**My Jobs**, **Pipeline**, **Documents**, **Follow-ups**, **Interviews**,
**Settings**. A sidebar refresh button re-fetches the current page; a
status pill at the bottom shows when an auto-scan is in flight.

## Features

### Dashboard
At-a-glance counts (jobs tracked, applied, interviewing, offers, pending
follow-ups, upcoming interviews) plus the next 5 due follow-ups and 5
upcoming interviews. Overdue follow-ups are highlighted in red.

### Scan Jobs
Run a one-shot scan across any subset of the built-in boards. Filter by
keywords, location, and work-type (any / remote / hybrid / in-office). A
live progress stream is rendered in the page; on completion the result card
shows a per-board breakdown of:

- **Board** — name of the source.
- **Scraped** — derived as `Found - Skipped - Errors`. This is the number
  of *new* jobs surfaced from that board.
- **Added** — jobs successfully added to your store.
- **Found / Skipped / Errors** — hidden by default; click `+` in the card
  header to expand. Boards where Scraped, Added, and Errors are all `0`
  are dropped from the table to keep the result view focused.

A copy-log button in the same card header dumps the full scan log to the
clipboard. A "Scan in progress" pill in the sidebar shows when a scan is
running; cancelling the page stops all in-flight fetches.

### Auto-scan
A background scanner runs every `auto_scan_interval_minutes` (default
`120`) when `auto_scan_enabled` is on (default `on`). The next run is
scheduled from the last completed scan; manual scans pause the auto-timer
until they finish. Configure both in **Settings**.

### My Jobs
A sortable, filterable, deduplicated table of every job in the store. Add
jobs three ways:

1. **Manual** — fill in the modal form.
2. **By URL** — paste a posting URL; the app scrapes and parses it
   (with optional browser fallback for JS-rendered pages).
3. **By scan** — anything new from a board scan is added automatically.

Each row shows a fit dot (green ≥ 0.6, amber ≥ 0.3, red < 0.3) — jobs
newly created from a scan start at the neutral default of 0.31, above the
red cutoff. The dot is hidden until the job has a real score.
the salary, the job title, and a quick status badge. Filters at the top
let you narrow by status, source, work mode, employment type, location,
and salary range; a free-text search box queries title + company. Column
headers (Status, Source, Fit) are click-to-sort. A bulk-select toolbar
lets you change status, delete, or trigger a batch re-score across the
checked rows.

Clicking a row opens the **Job Detail** page (also reachable from a deep
link / direct selection). The detail view shows full description, fit
breakdown (matched / missing skills, experience-years match), score,
rationale, salary, hiring-manager info, location, status timeline, and the
per-job document list. Inline edits update the row without leaving the
page. Score and rationale regenerate from the Job Detail toolbar.

### Pipeline
A 5-column Kanban (sourced → reviewing → ready → applied → follow-up →
interviewing) for a visual overview. Each card is a job; click to open
the detail view.

### Documents
A two-pane editor: a list of base documents (CV / cover letter) on the
left, a markdown editor on the right. Each document can be flagged as
"base" (used as the source for tailoring). Per-job generated documents
are listed under the base, organised by job. The "Verify" button runs
the document through the AI for a review pass; the "Regenerate" toolbar
on individual sections (Experience, Leadership & Activities, Skills &
Interests) rewrites only the targeted section. A "Re-verify until passed"
loop is available for documents that don't meet the bar.

### Follow-ups
A list of follow-ups tied to applications (email / call / linkedin /
other), with a due date and a generated message draft. Overdue rows are
red. Completing a follow-up records the date and hides it from the
default view.

### Interviews
Scheduled interviews with type, duration, location, interviewer, and
notes. The list defaults to upcoming only; toggle to show past.

### Settings
- **User profile** — name, email, phone, country.
- **Base CV** — paste your master CV here; this is the source for all
  tailoring.
- **Job search defaults** — keywords and preferred location (used by
  auto-scan when no overrides are set).
- **AI Models** — add / remove / reorder LLM providers. The app tries
  them in priority order; a model failure (rate limit, network, parse)
  transparently falls through to the next. Built-in fallback heuristics
  (skills overlap, years-of-experience match, education-level match)
  run when every model fails. Each call has a default 0.5-second
  timeout and a single retry.
- **Encryption status** — current `sealed` (keyring) / `plaintext-fallback`
  / `uninitialized` mode.
- **Auto-scan** — enable / disable and interval in minutes.
- **Data** — export to JSON, clear all data, clear the dedup history
  (re-add a job that was previously skipped).

## AI / LLM integration

The AI layer lives in `electron/ai.ts`. The contract is OpenAI-compatible
`/v1/chat/completions`. Configure one or more providers in
**Settings → AI Models**; each row is a `base_url`, `model`, optional
`api_key`, and a friendly name. On call, the app tries each enabled model
in order; only after all models fail (or hit a `RateLimitError`) does it
fall through. Rate-limited calls enqueue an AI-queue item with exponential
backoff (30s → 30m cap, up to 10 attempts) and surface a "queued" result
to the UI.

When every model fails the scorer returns a heuristic fallback
(`source: 'heuristic'`) and persists the error to the job's
`fit_last_error` column — the numeric score is **not** overwritten. The
UI shows the error in place of a score so the user can tell "bad fit"
from "scorer is broken". The "Fit assessment failed for N jobs" toast
fires once per error per app session (tracked by `fit_error_toasted` on
the job row) — restarting the app does not re-fire the same toast.

The CV / cover-letter generator, document verifier, section regenerator,
and follow-up message generator all share the same multi-model + queue
plumbing.

## Job board scanning

`electron/jobSearch.ts` ships with a hard-coded list of ~40 boards across
four buckets: general (LinkedIn, Indeed, Monster, ZipRecruiter, SimplyHired,
Adzuna, Talent.com, Jora), remote (Remote OK, We Work Remotely, Remotive,
Remote.co, Working Nomads, JustRemote), Canadian (Job Bank, Eluta.ca,
Workopolis, Jobboom, WorkBC, CareerBeacon, Vancouver Jobs, Built In
Vancouver/Toronto, UToronto), and startup / crypto / niche (Wellfound, Y
Combinator, Built In, Selby Jennings, Braintrust, Google Careers, CareerHound,
Idealist, CharityVillage, CVCA, Top Startups, Rocketships, plus a Crypto
section: Crypto Careers, Cryptorecruit, Remote3, Cryptocurrency Jobs,
CryptoJobsList, cryptojobs.com, Crypto.jobs, Web3.career, Startup.jobs).

Each board has a per-board scraper (`scrapeBoard`) that knows the URL
shape, the listing-card selector, and any hash-routing quirks
(WorkBC's `#/job-details/{id}`, for example, is included in the dedup
key so the same job across two paths still collapses). Listings are
deduplicated by a normalized URL (`origin + pathname + query`, with
tracking parameters stripped); the same URL is never added twice.

Boards that need a JS engine use `browserScraper.ts` (a hidden Electron
window); the rest go through `fetch` with a real `User-Agent` and
follow-redirect handling.

## Data model

A single `Store` object lives at
`~/Library/Application Support/apply-assistant/apply-assistant-data.json`
on macOS (or the equivalent `userData` path on other platforms). The
store holds:

- `jobs[]` — every job, with `fit_score`, `fit_rationale`, `fit_breakdown`,
  `fit_score_version`, `fit_last_error`, `fit_error_toasted`,
  `salary_range`, `hiring_manager`, `date_posted`, `last_updated`,
  `application_requirements`, `employment_type`, `work_mode`, etc.
- `documents[]` — base and per-job CV / cover letters.
- `applications[]`, `follow_ups[]`, `interviews[]` — pipeline data.
- `settings` — user profile, base CV, search defaults, auto-scan
  config.
- `api_models[]` — ordered list of LLM providers.
- `seen_urls[]` — dedup history.
- `ai_queue[]` — pending rate-limited / failed AI calls.
- `board_health[]` — last 5 results per board (for the "skip sick boards"
  filter on the Scan page).
- `deleted_jobs[]` — soft-deleted job records (capped by
  `deleted_jobs_cap`, default 50000; used to block re-add of jobs the
  user has already seen).
- `blacklisted_companies[]`.

### Encryption

`electron/secureStore.ts` derives a 32-byte data-encryption key (DEK) on
first run, seals it with `safeStorage` (Keychain / libsecret / DPAPI) and
writes it to `apply-assistant-key` in the same directory. Every store
write encrypts the whole JSON as `enc:v1:<base64(iv|tag|ct)>` with
AES-256-GCM. If the OS keyring is unavailable the DEK falls back to a
plaintext on-disk key with a `pln:` marker — the app surfaces this state
in Settings; users can opt out by clearing data. The encryption status
can be one of:

- `sealed` — DEK is sealed in the OS keyring. Recommended.
- `plaintext-fallback` — DEK is on disk in plaintext (keyring unavailable).
- `uninitialized` — no data yet, no key created.

The DEK is bound to the current user account by mixing the OS username
into the key derivation; copying the data file to another account does
not decrypt it without the destination account's key.

## Privacy

- All data lives locally; no network calls except to the configured LLM
  providers and the scraped job boards.
- API keys and the data store are encrypted at rest with the OS keyring
  when available.
- The DevTools are opened in dev mode only; production builds don't
  expose them.

## Tech

Electron 34 + React 18 + TypeScript 5 + Vite 5. State is local React;
IPC is via a `preload.ts`-exposed `api` proxy that wraps
`ipcRenderer.invoke` with a typed `Api` interface. No external database —
the store is a single encrypted JSON file written with `fsync` to
guarantee durability across crashes.

## Project layout

```
electron/                 Main process + scraping + DB
  main.ts                 App lifecycle, IPC handlers
  preload.ts              `window.api` surface
  database.ts             Store, migrations, CRUD
  secureStore.ts          DEK / AES-GCM helpers
  ai.ts                   Multi-model LLM client + queue types
  aiQueue.ts              Rate-limit retry queue
  autoScan.ts             Background scan scheduler
  jobSearch.ts            Board definitions + per-board scrapers
  jobScraper.ts           Single-posting URL scraper
  browserScraper.ts       JS-engine fallback for hard boards
  fitHeuristic.ts         Fallback scorer (skills / experience / education)
  employmentType.ts       Normalizer for the EmploymentType enum
  utils.ts                HTML cleanup, dedup-key, salary normalize
  types.ts                IPC + DB shared types

src/                      Renderer
  pages/                  One file per sidebar page
  components/             Sidebar, Modal, Notifications, ErrorBoundary
  styles/global.css       Design tokens + component classes
  api.ts                  Typed wrapper around `window.api`
  types.ts                Renderer-side mirror of electron/types.ts
```
