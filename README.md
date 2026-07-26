1→# FlowJob
2→
3→Desktop assistant for the full job application lifecycle — track jobs, scan
4→
5→Desktop assistant for the full job application lifecycle — track jobs, scan
6→multiple job boards, generate tailored CVs and cover letters, manage the
7→application pipeline, and track follow-ups and interviews. Built as an
8→Electron + React + TypeScript app with a flat-file JSON store encrypted at
9→rest.
10→
11→## Setup
12→
13→```bash
14→npm install
15→npm run dev
16→```
17→
18→Requires Node.js 18+ and a working Electron environment. First launch will
19→create a sealed data-encryption key in the OS keyring (macOS Keychain, Linux
20→libsecret, or Windows DPAPI) and an encrypted `apply-assistant-data.json`
21→store under the app's `userData` directory.
22→
23→### Scripts
24→
25→| Command | What it does |
26→|---|---|
27→| `npm run dev` | Start the Electron + Vite dev server with HMR. |
28→| `npm run build` | Production build of main, preload, and renderer bundles. |
29→| `npm run preview` | Build and run the packaged preview. |
30→| `npm run start` | Same as `preview`. |
31→| `npm run lint` | ESLint over the whole repo. |
32→| `npm run lint:fix` | ESLint with `--fix`. |
33→| `npm run typecheck` | `tsc --noEmit` over the test tsconfig. |
34→| `npm run test` | Vitest run. |
35→| `npm run test:watch` | Vitest watch mode. |
36→
37→## Navigation
38→
39→The sidebar exposes 8 pages, in this order: **Dashboard**, **Scan Jobs**,
40→**My Jobs**, **Pipeline**, **Documents**, **Follow-ups**, **Interviews**,
41→**Settings**. A sidebar refresh button re-fetches the current page; a
42→status pill at the bottom shows when an auto-scan is in flight.
43→
44→## Features
45→
46→### Dashboard
47→At-a-glance counts (jobs tracked, applied, interviewing, offers, pending
48→follow-ups, upcoming interviews) plus the next 5 due follow-ups and 5
49→upcoming interviews. Overdue follow-ups are highlighted in red.
50→
51→### Scan Jobs
52→Run a one-shot scan across any subset of the built-in boards. Filter by
53→keywords, location, and work-type (any / remote / hybrid / in-office). A
54→live progress stream is rendered in the page; on completion the result card
55→shows a per-board breakdown of:
56→
57→- **Board** — Job board source (e.g., LinkedIn, Remote OK).
58→- **Scraped** — Derived as `Found - Skipped - Errors`. New jobs surfaced.
59→- **Added** — Jobs successfully added to your store.
60→- **Found / Skipped / Errors** — Click `+` in card header to expand.
61→
62→A copy-log button dumps the full scan log to the clipboard. A "Scan in progress"
63→pill in the sidebar appears during scans; cancelling the page stops fetches.
64→
65→### Auto-scan
66→Runs every `auto_scan_interval_minutes` (default 120) when enabled. Manual scans pause auto-timer until done.
67→
68→### My Jobs
69→Sortable, filterable table of all jobs. Add jobs via:
70→1. **Manual** — Fill form.
71→2. **By URL** — Paste URL; app scrapes/parses.
72→3. **By scan** — Auto-added from board scans.
73→
74→Each row shows a fit dot (blue ≥ 0.9, green ≥ 0.6, amber ≥ 0.3, red < 0.3).
75→New scan-added jobs start at 0.31. Click rows to open Job Detail view.
76→
77→### Pipeline
78→5-column Kanban: Sourced → Reviewing → Ready → Applied → Follow-up → Interviewing.
79→
80→### Documents
81→Two-pane editor: Base documents (CV/cover letter) on left; tailored versions on right.
82→Flag documents as "base" for tailoring. Use AI to verify/regenerate sections.
83→
84→### Follow-ups
85→Track follow-ups (email/call/LinkedIn) with due dates and AI-generated drafts.
86→
87→### Interviews
88→Manage scheduled interviews with details and notes.
89→
90→### Settings
91→- **User Profile**: Name, email, phone, country.
92→- **Base CV**: Master CV for tailoring.
93→- **AI Models**: Configure LLM providers (priority order, API keys).
94→- **Boards**: Toggle job boards (50+ supported).
95→- **Encryption**: Sealed (OS keyring) / plaintext-fallback status.
96→- **Auto-scan**: Enable/disable + interval.
97→- **Data**: Export/clear data, manage encrypted backups.
98→
99→## Job Board Scanning
100→Supports **50+ boards** across categories:
101→- **General**: LinkedIn, Indeed, Monster
102→- **Remote**: Remote OK, We Work Remotely
103→- **Canadian**: Job Bank, WorkBC
104→- **Startup/Crypto**: Wellfound, Crypto Careers
105→
106→![Board Categories](boards.png) <!-- Add diagram here -->
107→
108→Boards use search pages, sitemaps, or APIs. Disabled boards are hidden; sick boards (consecutive zero results) are toggleable.
109→
110→## Data Storage
111→
112→Single encrypted `Store` object (AES-256-GCM) at:
113→`~/Library/Application Support/apply-assistant/apply-assistant-data.json`
114→(platform-equivalent paths). Stores jobs, documents, applications, settings, and more.
115→
116→## AI Integration
117→OpenAI-compatible `/v1/chat/completions` API. Configure providers in Settings.
118→AI handles document generation, verification, and follow-up drafts with rate-limiting.
119→
120→## Project Layout
121→```
122→electron/                 # Main process (scraping, encryption, IPC)
123→  main.ts                 # App lifecycle
124→  preload.ts              # Renderer-main bridge
125→src/                      # React frontend
126→  pages/                  # Core pages
127→  components/             # UI components
128→  api.ts                  # Typed IPC client
129→```
130→
131→## Privacy
132→- All data stored locally; no network calls except to configured LLMs and job boards.
133→- Encryption uses OS keyring when available.
134→- DevTools disabled in production.
135→
136→## License
137→MIT License - See [LICENSE](LICENSE) for details.
138→
139→## Support
140→Open GitHub issues or contact support@flowjob.org.