# Job Application Assistant

Desktop assistant for the full job application lifecycle — track jobs, generate tailored Harvard-format CVs and cover letters via AI, scan job boards, and manage your pipeline.

## Setup

```bash
npm install
npm run dev
```

Requires Node.js 18+ and Electron.

## AI Models

The app tries models in priority order until one succeeds. Built-in presets:

| Model | Base URL | API Key |
|---|---|---|
| DeepSeek Chat | `https://api.deepseek.com` | Free (5M tokens) |
| Big Pickle | `https://opencode.ai/zen/v1` | None (free) |
| DeepSeek V4 Flash Free | `https://opencode.ai/zen/v1` | None (free) |
| MiMo V2.5 Free | `https://opencode.ai/zen/v1` | None (free) |
| Nemotron 3 Ultra Free | `https://openrouter.ai/api/v1` | OpenRouter key |
| North Mini Code Free | `https://opencode.ai/zen/v1` | None (free) |

Configure models in **Settings → AI Models**. DeepSeek is the default — sign up at api.deepseek.com for an API key.

## Features

- **Job tracking** — add jobs manually, by URL (auto-scraped), or via board scanning
- **AI document generation** — tailors your base CV to each job using the Harvard template (Contact Info → Education → Experience → Leadership & Activities → Skills & Interests)
- **Section-level regeneration** — regenerate Experience, Leadership & Activities, or Skills & Interests independently
- **Multi-model fallback** — configure a priority-ordered list of AI models; falls through on failure
- **PDF export** — Harvard-formatted PDF saved to `docs/` with naming convention `{name}_{company}_{position}_{docType}.pdf`
- **Job board scanning** — search several different job boards. Job compatibility scoring with color indicators.
- **Application pipeline** — sourced → tailoring → ready → applied → stages with follow-up and interview tracking
- **Privacy** — API keys encrypted via Electron safeStorage (macOS Keychain); no data stored in plaintext

## Workflow

1. Add a job (manual, URL, or board scan)
2. Tailor CV and cover letter (auto-generated on scan)
3. Review & verify documents
4. Mark as applied
5. Track follow-ups and interviews

## Data

Stored at `~/Library/Application Support/apply-assistant/apply-assistant-data.json` (macOS).

## Tech

Electron + React + TypeScript + Vite. No external database — flat-file JSON store.
