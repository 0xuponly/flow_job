import { app, BrowserWindow, dialog, ipcMain, screen, shell } from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'fs'
import * as db from './database'
import * as secureStore from './secureStore'
import {
  appendAudit,
  detectSyncedFolder,
  signManifest,
  unwrapDekWithPassphrase,
  verifyManifest,
  wrapDekWithPassphrase
} from './backupCrypto'
import { tailorDocument, generateFollowUpMessage, regenerateSection, verifyDocumentContent, scoreJobFit, RateLimitError } from './ai'
import { scrapeJobFromUrl } from './jobScraper'
import { scanAllBoards, BOARDS } from './jobSearch'
import { createLogger } from './logger'

// Filter known-harmless Chromium internal noise out of stderr.
//
// We capture a small, well-known set of patterns into a file-backed
// category log and pass everything else through unchanged so real
// errors are still visible. Each pattern is annotated with why it's
// safe to drop from the terminal.
//
//  1. "Hit debug scenario: N" — content/common/debug_utils.cc.
//     Scenario 4 = a transient browser-vs-renderer origin mismatch
//     during the initial about:blank load of a new BrowserWindow.
//     Electron issue #44368 closed NOT_PLANNED; no upstream fix.
//     Fires one per hidden scraper BrowserWindow during scans.
//  2. "Failed to resolve address for stun.*" — content/renderer/
//     media/webrtc/socket_manager.cc. Chromium's WebRTC stack tries
//     to resolve a default list of STUN servers for ICE candidate
//     gathering even when the app doesn't use WebRTC. Safe to
//     ignore; the app has no peer-to-peer connections.
const _stderrNoiseLog = createLogger('stderr')
const STDERR_NOISE_PATTERNS: readonly RegExp[] = [
  /Hit debug scenario: \d+/,
  /Failed to resolve address for stun\.[^\s,]+\.?, errorcode: -?\d+/
]
const _origStderrWrite = process.stderr.write.bind(process.stderr)
;(process.stderr as NodeJS.WriteStream).write = ((chunk: string | Buffer, ...rest: unknown[]) => {
  const s = typeof chunk === 'string' ? chunk : chunk.toString('utf-8')
  for (const re of STDERR_NOISE_PATTERNS) {
    if (re.test(s)) {
      // Trim trailing newline so each captured chunk is one log line.
      _stderrNoiseLog.info(s.replace(/\r?\n$/, ''))
      return true
    }
  }
  return (_origStderrWrite as (c: string | Buffer, ...a: unknown[]) => boolean)(chunk, ...(rest as []))
}) as typeof process.stderr.write

// Small helpers used by the backup flow. Defined at module scope
// (not inside registerIpc) so the audit logger can call them.
function basename(p: string): string {
  const parts = p.split(/[\\/]/)
  return parts[parts.length - 1] || p
}

function stripHmac(manifest: Record<string, unknown>): Record<string, unknown> {
  // Deep-clone without the hmac field. The HMAC is computed over
  // every other field so the verifier can re-derive it from the
  // manifest-on-disk minus the stored signature.
  if (Array.isArray(manifest)) return manifest.map(stripHmac) as unknown as Record<string, unknown>
  if (manifest && typeof manifest === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(manifest)) {
      if (k === 'hmac') continue
      out[k] = stripHmac(v as Record<string, unknown>)
    }
    return out
  }
  return manifest
}
import { formatLocation } from './utils'
import { startQueueProcessor, stopQueueProcessor, enqueue } from './aiQueue'
import { scheduleNextAutoScan, cancelAutoScan, markScanStarted, markScanCompleted, restartAutoScanTimer } from './autoScan'

// Pin the userData directory to the original "apply-assistant" location so
// existing users' data (jobs, documents, settings) is found after the rename.
// electron-builder's productName (now "FlowJob") would otherwise redirect
// app.getPath('userData') to ~/Library/Application Support/FlowJob/, which
// is empty. Called before app.whenReady() so the path resolves correctly
// the first time anything reads it. Must run before any code that calls
// app.getPath('userData') (database.ts::getStorePath, etc.).
app.setName('apply-assistant')

// File-backed category loggers. Each category writes to
// <userData>/logs/<category>.log so the per-import scraper trace
// and other category logs don't spam the dev terminal. The default
// log dir is resolved by logger.createLogger on first use.
export const log = {
  scraper: createLogger('scraper'),
  scanner: createLogger('scanner'),
  fit: createLogger('fit'),
  startup: createLogger('startup'),
  backup: createLogger('backup')
}

import type {
  ApiModelConfig,
  Application,
  CreateJobInput,
  FollowUp,
  Interview,
  Job,
  JobStatus,
  ScanFilters,
  ScanResult,
  Settings,
  TailorRequest
} from './types'

// Module-level scan state — survives tab switches in the renderer
const _scanState: { scanning: boolean; progress: string[]; result: ScanResult | null; startedAt: number | null } = {
  scanning: false,
  progress: [],
  result: null,
  startedAt: null
}
// Active scan's AbortController — created when a scan starts, aborted on
// user cancel. Replaces itself on the next scan.
let _scanAbortController: AbortController | null = null
// Active import-from-link's AbortController. Same pattern as the scan one;
// created per import, replaced on the next import, aborted on user cancel.
let _importAbortController: AbortController | null = null

function createWindow(): void {
  const { height: displayHeight } = screen.getPrimaryDisplay().workAreaSize
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: displayHeight,
    minWidth: 960,
    minHeight: 640,
    show: false,
    title: 'FlowJob',
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0f1117',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function registerIpc(): void {
  ipcMain.handle('dashboard:stats', () => db.getDashboardStats())

  // Score a single job against the current base CV. Shared by the manual
  // background scorer (fired after createJob) and the explicit
  // recomputeFit handler. Emits 'job:scoreUpdated' on success so the
  // renderer can refresh the affected row without a full re-list.
  // Returns the post-update row, or null if the job was deleted
  // between the call and the read.
  async function scoreOneJobInBackground(jobId: number): Promise<Job | null> {
    const job = db.getJob(jobId)
    if (!job) return null
    const settings = db.getSettings()
    const baseCv = settings.base_cv || ''
    const currentVersion = settings.cv_version ?? 0
    if (!baseCv) {
      // No CV configured — leave the row at the neutral 0.31 default
      // (matches the createJob placeholder) and stamp the CV version so
      // we don't retry on every subsequent add.
      const updated = db.updateJob(jobId, {
        score: 0.31,
        fit_rationale: 'No base CV configured.',
        fit_breakdown: { matched_skills: [], missing_skills: [], experience_years_match: null },
        fit_score_version: currentVersion
      })
      emitJobScoreUpdated(jobId)
      return updated
    }
    try {
      const fit = await scoreJobFit({
        title: job.title,
        description: job.description,
        requirements: job.requirements,
        baseCv
      })
      if (fit.source === 'heuristic') {
        // Don't pretend a heuristic fallback is a real fit score.
        const updated = db.updateJob(jobId, { fit_last_error: fit.error || 'LLM scorer fell back to heuristic.' })
        emitJobScoreUpdated(jobId)
        return updated
      }
      const updated = db.updateJob(jobId, {
        score: fit.score,
        fit_rationale: fit.rationale,
        fit_breakdown: fit.breakdown,
        fit_score_version: currentVersion,
        fit_last_error: null
      })
      emitJobScoreUpdated(jobId)
      return updated
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error'
      log.fit.warn(`job ${jobId} (${job.company} — ${job.title}): ${msg}`)
      const updated = db.updateJob(jobId, { fit_last_error: msg })
      emitJobScoreUpdated(jobId)
      return updated
    }
  }

  function emitJobScoreUpdated(jobId: number): void {
    const job = db.getJob(jobId)
    if (!job) return
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('job:scoreUpdated', job)
    }
  }

  ipcMain.handle('jobs:list', (_e, status?: JobStatus) => db.listJobs(status))
  ipcMain.handle('jobs:get', (_e, id: number) => db.getJob(id))
  ipcMain.handle('jobs:create', (_e, input: CreateJobInput) => {
    const dup = db.findDuplicateJob(input)
    if (dup) throw new Error(`Job already exists: ${dup.company} — ${dup.title}`)
    // `force: true` lets the user re-add a previously-deleted job
    // from the manual-add form. The deleted-jobs blacklist entry is
    // preserved (so the scanner won't auto-re-add it) and
    // `wasBlacklisted` is returned so the renderer can prompt the
    // user to confirm.
    const { job, wasBlacklisted } = db.createJob(input, { skipDuplicateCheck: true, force: true })
    // Fire-and-forget background fit scoring. The job is created with a
    // neutral placeholder (0.31) and the score is replaced in place when
    // the LLM call resolves. Errors surface as fit_last_error in the row.
    void scoreOneJobInBackground(job.id)
    return { job, wasBlacklisted }
  })
  ipcMain.handle('jobs:update', (_e, id: number, fields: Partial<CreateJobInput & { status: JobStatus }>) =>
    db.updateJob(id, fields)
  )
  ipcMain.handle('jobs:delete', (_e, id: number) => db.deleteJob(id))
  ipcMain.handle('jobs:deleteMany', (_e, ids: number[]) => db.deleteJobs(ids))
  ipcMain.handle('jobs:dedupe', () => db.dedupeJobs())
  ipcMain.handle('jobs:search', (_e, query: string) => db.searchJobs(query))
  ipcMain.handle('jobs:importFromUrl', async (_e, url: string) => {
    _importAbortController = new AbortController()
    try {
      const input = await scrapeJobFromUrl(url, _importAbortController.signal)
      const dup = db.findDuplicateJob(input)
      if (dup) throw new Error(`Job already exists: ${dup.company} — ${dup.title}`)
      // `force: true` lets the user re-add a previously-deleted job
      // from a link. The deleted-jobs blacklist entry is preserved
      // (so the scanner won't auto-re-add it) and `wasBlacklisted` is
      // returned so the renderer can prompt the user to confirm.
      const { job, wasBlacklisted } = db.createJob(input, { skipDuplicateCheck: true, force: true })
      // Fire-and-forget background fit scoring for the imported job.
      void scoreOneJobInBackground(job.id)
      return { job, wasBlacklisted }
    } finally {
      _importAbortController = null
    }
  })

  ipcMain.handle('import:cancel', () => {
    if (_importAbortController) {
      _importAbortController.abort()
    }
  })

  ipcMain.handle('jobs:batchScore', async () => {
    const settings = db.getSettings()
    const baseCv = settings.base_cv || ''
    const currentVersion = settings.cv_version ?? 0
    const jobs = db.listJobs()
    let updated = 0
    for (const job of jobs) {
      // Only re-score jobs that have never been scored, or whose score was
      // computed against a previous version of the base CV.
      const needsScore = job.score == null || job.fit_score_version !== currentVersion
      if (!needsScore) continue
      if (!baseCv) {
        // No CV configured; keep the row at neutral but mark it as scored
        // against the current CV version so we don't retry every load.
        db.updateJob(job.id, {
          score: 0.5,
          fit_rationale: 'No base CV configured.',
          fit_breakdown: { matched_skills: [], missing_skills: [], experience_years_match: null },
          fit_score_version: currentVersion
        })
        updated++
        continue
      }
      try {
        const fit = await scoreJobFit({
          title: job.title,
          description: job.description,
          requirements: job.requirements,
          baseCv
        })
        if (fit.source === 'heuristic') {
          // LLM call failed. Do NOT overwrite any existing real fit score with
          // a heuristic fallback. Persist only the error so the user can see
          // why the scorer is broken.
          db.updateJob(job.id, {
            fit_last_error: fit.error || 'LLM scorer fell back to heuristic.'
          })
          log.fit.warn(`job ${job.id} (${job.company} — ${job.title}): ${fit.error || 'heuristic fallback'}`)
        } else {
          db.updateJob(job.id, {
            score: fit.score,
            fit_rationale: fit.rationale,
            fit_breakdown: fit.breakdown,
            fit_score_version: currentVersion,
            fit_last_error: null
          })
          updated++
        }
      } catch (err) {
        // Don't silently swallow — surface the error and leave the row alone.
        const msg = err instanceof Error ? err.message : 'Unknown error'
        log.fit.warn(`job ${job.id} (${job.company} — ${job.title}): ${msg}`)
        db.updateJob(job.id, { fit_last_error: msg })
      }
    }
    return { updated }
  })

  ipcMain.handle('jobs:recomputeFit', async (_e, id: number) => {
    // The shared background scorer handles the no-CV fallback, the
    // heuristic-fallback (don't overwrite), the error path, and emits
    // job:scoreUpdated. The handler returns the post-update row so
    // the renderer doesn't have to re-read the store.
    const updated = await scoreOneJobInBackground(id)
    if (!updated) {
      throw new Error(`Job ${id} not found`)
    }
    return updated
  })

  ipcMain.handle('jobs:backfillDates', () => db.backfillJobPostingDates())

  ipcMain.handle('jobs:scanBoards', async (e, filters?: ScanFilters) => {
    _scanState.scanning = true
    _scanState.progress = []
    _scanState.result = null
    _scanState.startedAt = Date.now()
    _scanAbortController = new AbortController()
    markScanStarted()
    try {
      const result = await scanAllBoards(filters, (msg) => {
        // Drop progress messages that arrive after cancel — the in-flight
        // scrapes that were racing the abort signal may still resolve and
        // try to report, but the user has already moved on.
        if (_scanAbortController?.signal.aborted) return
        _scanState.progress.push(msg)
        e.sender.send('scan:progress', msg)
      }, _scanAbortController.signal, (counters) => {
        // Live counter snapshot, pushed per-listing. Drop after cancel
        // for the same reason as progress — a stale snapshot that ticks
        // up after the user cancelled is more confusing than a freeze.
        if (_scanAbortController?.signal.aborted) return
        e.sender.send('scan:counters', counters)
      })
      _scanState.result = result
      markScanCompleted()
      // Notify all renderers that the scan has completed (success or cancelled)
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send('scan:complete', result)
      }
      return result
    } finally {
      _scanState.scanning = false
      _scanState.startedAt = null
      _scanAbortController = null
    }
  })

  ipcMain.handle('scan:cancel', () => {
    if (_scanAbortController) {
      _scanAbortController.abort()
    }
  })

  ipcMain.handle('scan:status', () => ({
    scanning: _scanState.scanning,
    progress: [..._scanState.progress],
    result: _scanState.result,
    startedAt: _scanState.startedAt
  }))

  ipcMain.handle('scan:clearResult', () => {
    _scanState.result = null
    _scanState.progress = []
  })

  ipcMain.handle('documents:list', (_e, jobId?: number) => db.listDocuments(jobId))
  ipcMain.handle('documents:create', (_e, type: 'cv' | 'cover_letter', title: string, content: string, jobId?: number) => {
    const doc = db.createDocument(type, title, content, jobId)
    if (jobId) db.recomputeJobStatusFromDocs(jobId)
    return doc
  })
  ipcMain.handle('documents:update', (_e, id: number, title: string, content: string) => {
    const doc = db.updateDocument(id, title, content)
    if (doc.job_id) db.recomputeJobStatusFromDocs(doc.job_id)
    return doc
  })
  ipcMain.handle('documents:delete', (_e, id: number) => {
    // Capture the doc's job_id before deletion so we can recompute after.
    const docs = db.listDocuments()
    const target = docs.find((d) => d.id === id)
    db.deleteDocument(id)
    if (target?.job_id) db.recomputeJobStatusFromDocs(target.job_id)
  })
  ipcMain.handle('documents:verify', async (_e, jobId: number, documentId: number, docType: 'cv' | 'cover_letter') => {
    try {
      const result = await verifyDocumentContent(jobId, documentId, docType)
      db.recomputeJobStatusFromDocs(jobId)
      return result
    } catch (err) {
      if (err instanceof RateLimitError) {
        enqueue({ type: 'verify', jobId, documentId })
        return { queued: true } as any
      }
      throw err
    }
  })
  ipcMain.handle('documents:regenerateSection', async (_e, documentId: number, sectionName: string, jobId: number, extraContext?: string) => {
    try {
      return await regenerateSection(documentId, sectionName, jobId, extraContext)
    } catch (err) {
      if (err instanceof RateLimitError) {
        enqueue({ type: 'regenerate_section', jobId, documentId, sectionName, extraContext })
        return { queued: true }
      }
      throw err
    }
  })
  ipcMain.handle('documents:exportPdf', async (_e, title: string, content: string, docType?: string, company?: string, position?: string) => {
    const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false } })

    function stripMarkdown(s: string): string {
      return s.replace(/\*\*(.+?)\*\*/g, '$1').replace(/\*(.+?)\*/g, '$1').replace(/__(.+?)__/g, '$1').replace(/_(.+?)_/g, '$1')
    }

    const sectionHeaders = new Set([
      'professional summary', 'summary', 'profile',
      'core competencies', 'competencies', 'skills', 'qualifications', 'technical skills',
      'professional experience', 'experience', 'work history', 'work experience',
      'education',
      'certifications', 'languages', 'interests', 'skills & interests', 'skills and interests',
      'projects', 'project experience',
      'leadership & activities', 'leadership and activities', 'activities', 'leadership',
      'publications', 'honors & awards', 'honors and awards', 'awards',
      'additional information', 'additional'
    ])

    function isHeader(s: string): boolean {
      const cleaned = stripMarkdown(s).toLowerCase().trim()
      return sectionHeaders.has(cleaned) || /^[a-z\s&]+$/.test(cleaned) && sectionHeaders.has(cleaned.replace(/[^a-z\s&]/g, '').trim())
    }

    const lines = content.split('\n')
    let htmlBody = ''
    let headerCollected = false
    const headerLines: string[] = []
    let noBulletSection = false

    function esc(s: string) {
      return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    }

    const bulletVerbs = /^(accomplished|achieved|led|managed|developed|created|implemented|designed|built|launched|delivered|improved|reduced|increased|generated|established|negotiated|coordinated|directed|spearheaded|introduced|optimized|transformed|piloted|engineered|produced|executed|authored|published|presented|mentored|trained|recruited|hired|fostered|cultivated|prepared|conducted|analyzed|analysed|evaluated|assessed|facilitated|collaborated|organized|supervised|overhauled|streamlined|consolidated|architected|championed|drove|drafted|formulated|identified|integrated|maintained|monitored|performed|pioneered|promoted|recommended|scheduled|secured|solved|standardized|strengthened|taught|wrote)/i
    const noBulletSections = new Set(['skills & interests', 'skills and interests', 'skills', 'interests', 'certifications', 'languages', 'additional information', 'additional'])

    function splitTab(label: string, rest: string): [string, string] {
      return [label.replace(/^\*+|\*+$/g, '').trim(), rest.trim()]
    }

    // Detect right-aligned suffix separated by 3+ spaces:
    //   "Title    Month Year – Month Year"   (date range)
    //   "Org      City, State"               (location)
    // Location side: "City, ST" or "City, ST Zip" or "City, Country"
    const dateRangeRe = /\s{3,}\b([A-Z][a-z]+\.?\s+\d{4}\s*[–\-—]+\s*(?:[A-Z][a-z]+\.?\s+\d{4}|Present)|[A-Z][a-z]+\.?\s+\d{4})\b$/
    const locationSuffixRe = /\s{3,}\b([A-Z][^,]{2,30},\s*(?:[A-Z]{2}|[A-Z][a-z]+)(?:\s+\d{5})?)$/

    // Looser date-range check (any whitespace run) used for next-line lookahead.
    const dateRangeAnyRe = /\b([A-Z][a-z]+\.?\s+\d{4}\s*[–\-—]+\s*(?:[A-Z][a-z]+\.?\s+\d{4}|Present)|[A-Z][a-z]+\.?\s+\d{4})\b\s*$/
    // Loose location suffix on an org line (single space ok): "Org City, ST" / "Org City, Country"
    const orgLocationLooseRe = /,\s*(?:[A-Z]{2}|[A-Z][a-z]+)(?:\s+\d{5})?$/

    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i]
      const trimmed = raw.trim()
      const cleaned = stripMarkdown(trimmed).trim()
      if (!cleaned) { htmlBody += '<div class="spacer"></div>\n'; continue }

      const sect = isHeader(trimmed)
      const hasTab = cleaned.includes('\t')
      const hasMultiSpace = dateRangeRe.test(cleaned) || locationSuffixRe.test(cleaned)
      const isBullet = /^[•\-*\d+.)\]\s]/.test(cleaned) || bulletVerbs.test(cleaned)

      // Look-ahead: next non-empty line looks like a date range? Then current is an org line.
      let nextClean = ''
      for (let j = i + 1; j < lines.length && j < i + 4; j++) {
        const nc = stripMarkdown(lines[j].trim()).trim()
        if (!nc) continue
        nextClean = nc
        break
      }
      const nextIsDateLine = nextClean && (dateRangeRe.test(nextClean) || dateRangeAnyRe.test(nextClean))
      const looksLikeOrgLine = !hasTab && !hasMultiSpace && !isBullet && !!nextIsDateLine && orgLocationLooseRe.test(cleaned)
      const looksLikeTitleLine = !hasTab && !hasMultiSpace && !isBullet && dateRangeAnyRe.test(cleaned) && cleaned !== nextClean

      if (sect) {
        const lower = stripMarkdown(trimmed).toLowerCase().trim()
        noBulletSection = noBulletSections.has(lower)
        if (!headerCollected) headerCollected = true
        htmlBody += `<div class="section-header">${esc(cleaned)}</div>\n`
        continue
      }

      if (!headerCollected) {
        if (isBullet) {
          headerCollected = true
        } else if (headerLines.length < 3) { headerLines.push(cleaned); continue }
          else { headerCollected = true }
      }

      if (isBullet) { htmlBody += `<div class="bullet">${esc(cleaned.replace(/^[•\-\*\d+.)\]\s]+/, ''))}</div>\n`; continue }

      if (hasTab) {
        const parts = cleaned.split('\t')
        const [label, rest] = splitTab(parts[0], parts.slice(1).join(' '))
        htmlBody += `<div class="split-line"><span class="left">${esc(label)}</span><span class="right">${esc(rest)}</span></div>\n`
      } else if (hasMultiSpace) {
        const m = cleaned.match(dateRangeRe) || cleaned.match(locationSuffixRe)!
        const label = cleaned.slice(0, m.index).replace(/^\*+|\*+$/g, '').trim()
        const rest = cleaned.slice(m.index).replace(/^\s+/, '').trim()
        htmlBody += `<div class="split-line"><span class="left">${esc(label)}</span><span class="right">${esc(rest)}</span></div>\n`
      } else if (looksLikeOrgLine) {
        // Split off location suffix (last ", XX" chunk) as the right-aligned side.
        const m = cleaned.match(orgLocationLooseRe)!
        const label = cleaned.slice(0, m.index).replace(/,\s*$/, '').trim()
        const rest = cleaned.slice(m.index).replace(/^,\s*/, '').trim()
        htmlBody += `<div class="split-line"><span class="left">${esc(label)}</span><span class="right">${esc(rest)}</span></div>\n`
      } else if (looksLikeTitleLine) {
        // Title line with embedded date range (no wide gap, no tab). Split at date start.
        const m = cleaned.match(dateRangeAnyRe)!
        const label = cleaned.slice(0, m.index).replace(/,\s*$/, '').trim()
        const rest = cleaned.slice(m.index).trim()
        htmlBody += `<div class="split-line"><span class="left">${esc(label)}</span><span class="right">${esc(rest)}</span></div>\n`
      } else if (cleaned.includes('|') && cleaned.length < 120) {
        const parts = cleaned.split('|').map(s => s.replace(/^\*+|\*+$/g, '').trim())
        htmlBody += `<div class="split-line"><span class="left">${esc(parts[0])}</span><span class="right">${esc(parts.slice(1).join(' | '))}</span></div>\n`
      } else if (noBulletSection) {
        htmlBody += `<div class="body-line">${esc(cleaned)}</div>\n`
      } else {
        htmlBody += `<div class="bullet">${esc(cleaned)}</div>\n`
      }
    }

    const headerHtml = headerLines.length > 0
      ? `<div class="header">${headerLines.map((l, j) => j === 0 ? `<div class="name">${esc(l)}</div>` : `<div class="contact">${esc(l)}</div>`).join('\n')}</div>`
      : ''

    const fullHtml = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><style>
  @page { margin: 0.6in 0.7in; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: Calibri, 'Helvetica Neue', Helvetica, Arial, sans-serif; font-size: 11pt; line-height: 1.2; color: #000; }
  .header { text-align: center; margin-bottom: 10px; }
  .name { font-size: 12pt; font-weight: bold; }
  .contact { font-size: 10pt; color: #222; }
  .section-header { text-align: center; font-weight: bold; font-size: 11pt; margin-top: 12px; margin-bottom: 3px; }
  .split-line { margin-bottom: 1px; }
  .split-line .left { font-weight: bold; }
  .split-line .right { float: right; }
  .bullet { margin-bottom: 1px; padding-left: 20px; text-indent: -10px; }
  .bullet::before { content: "• "; }
  .body-line { margin-bottom: 1px; }
  .spacer { height: 6px; }
</style></head>
<body>
${headerHtml}
${htmlBody}
</body>
</html>`
    await win.loadURL(`data:text/html;charset=utf-8,${  encodeURIComponent(fullHtml)}`)
    const pdf = await win.webContents.printToPDF({})
    win.close()
    const settings = db.getSettings()
    const userName = (settings.user_name || '').replace(/[^a-zA-Z0-9]/g, '')
    const safe = (s: string) => s.replace(/[^a-zA-Z0-9]/g, '')
    const nameParts = [userName, company ? safe(company) : '', position ? safe(position) : '', docType || title.replace(/ .*/, '')].filter(Boolean)
    const fileName = `${nameParts.length > 1 ? nameParts.join('_') : `${title.replace(/[^a-z0-9]/gi, '_')}`  }.pdf`
    const docsDir = join(app.getAppPath(), 'docs')
    if (!existsSync(docsDir)) mkdirSync(docsDir, { recursive: true })
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: 'Save PDF',
      defaultPath: join(docsDir, fileName),
      filters: [{ name: 'PDF', extensions: ['pdf'] }]
    })
    if (canceled || !filePath) return null
    writeFileSync(filePath, pdf)
    return filePath
  })

  ipcMain.handle('applications:list', () => db.listApplications())
  ipcMain.handle('applications:getOrCreate', (_e, jobId: number) => db.getOrCreateApplication(jobId))
  ipcMain.handle('applications:update', (_e, id: number, fields: Partial<Application>) =>
    db.updateApplication(id, fields)
  )
  ipcMain.handle(
    'applications:markApplied',
    (_e, id: number, method: string, email?: string, name?: string) =>
      db.markApplied(id, method, email, name)
  )

  ipcMain.handle('followUps:list', (_e, includeCompleted?: boolean) =>
    db.listFollowUps(includeCompleted)
  )
  ipcMain.handle('followUps:create', (_e, appId: number, dueDate: string, type: FollowUp['type'], message?: string) =>
    db.createFollowUp(appId, dueDate, type, message)
  )
  ipcMain.handle('followUps:complete', (_e, id: number) => db.completeFollowUp(id))
  ipcMain.handle('followUps:generateMessage', async (_e, company: string, title: string, days: number) =>
    generateFollowUpMessage(company, title, days)
  )

  ipcMain.handle('interviews:list', (_e, upcomingOnly?: boolean) => db.listInterviews(upcomingOnly))
  ipcMain.handle(
    'interviews:create',
    (
      _e,
      appId: number,
      scheduledAt: string,
      type: Interview['type'],
      duration?: number,
      location?: string,
      interviewer?: string,
      notes?: string
    ) => db.createInterview(appId, scheduledAt, type, duration, location, interviewer, notes)
  )
  ipcMain.handle('interviews:update', (_e, id: number, fields: Partial<Interview>) =>
    db.updateInterview(id, fields)
  )

  ipcMain.handle('settings:get', () => db.getSettings())
  ipcMain.handle('settings:update', (_e, partial: Partial<Settings>) => {
    const result = db.updateSettings(partial)
    // Re-schedule auto-scan if the relevant settings changed
    if ('auto_scan_enabled' in partial || 'auto_scan_interval_minutes' in partial) {
      restartAutoScanTimer()
    }
    return result
  })
  ipcMain.handle('settings:reset', () => db.resetSettings())

  ipcMain.handle('models:list', () => db.listApiModels())
  ipcMain.handle('models:save', (_e, models: ApiModelConfig[]) => db.saveApiModels(models))
  ipcMain.handle('models:add', (_e, model: Omit<ApiModelConfig, 'id'>) => db.addApiModel(model))
  ipcMain.handle('models:delete', (_e, id: string) => db.deleteApiModel(id))

  ipcMain.handle('ai:tailor', async (_e, request: TailorRequest) => {
    try {
      return await tailorDocument(request)
    } catch (err) {
      if (err instanceof RateLimitError) {
        enqueue({ type: request.document_type === 'cv' ? 'generate_cv' : 'generate_cover_letter', jobId: request.job_id })
        return { queued: true }
      }
      throw err
    }
  })

  ipcMain.handle('db:clearSeenUrls', () => db.clearSeenUrls())
  ipcMain.handle('db:clearAllData', () => db.clearAllData())

  ipcMain.handle('db:retrofitLocations', () => {
    const result = db.retrofitLocations()
    return result
  })

  // Company blacklist
  ipcMain.handle('blacklist:list', () => db.listBlacklistedCompanies())
  ipcMain.handle('blacklist:add', (_e, name: string) => db.addBlacklistedCompany(name))
  ipcMain.handle('blacklist:remove', (_e, name: string) => db.removeBlacklistedCompany(name))

  // --- Data backup ----------------------------------------------------
  // Writes a timestamped folder containing the data file, encryption
  // key, and a manifest into a `flow_job_backups` subdirectory under
  // the user's chosen backup path. Returns { ok, path, error }.
  function backupTimestamp(): string {
    const d = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    return (
      d.getFullYear().toString() +
      pad(d.getMonth() + 1) +
      pad(d.getDate()) +
      '-' +
      pad(d.getHours()) +
      pad(d.getMinutes()) +
      pad(d.getSeconds())
    )
  }

  // Reverse of backupTimestamp: parses `YYYYMMDD-HHmmss` into an ISO
  // string. Returns '' on any parse failure so the caller can fall
  // back to the folder mtime.
  function parseBackupTimestamp(ts: string): string {
    const m = ts.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/)
    if (!m) return ''
    const [, y, mo, d, h, mi, s] = m
    const dt = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}`)
    if (isNaN(dt.getTime())) return ''
    return dt.toISOString()
  }

  function runBackup(
    dir: string,
    passphrase?: string
  ): Promise<{ ok: boolean; path?: string; error?: string }> {
    return new Promise((resolve) => {
      const parentDir = join(dir, 'flow_job_backups')
      let backupDir = ''
      try {
        if (!dir) {
          resolve({ ok: false, error: 'No backup path set' })
          return
        }
        if (!existsSync(dir)) {
          resolve({ ok: false, error: `Backup path does not exist: ${dir}` })
          return
        }
        if (!existsSync(parentDir)) {
          mkdirSync(parentDir, { recursive: true })
        }
        backupDir = join(parentDir, `flow_job_backup_${backupTimestamp()}`)
        if (existsSync(backupDir)) {
          // Same-second collision (shouldn't happen in practice —
          // the timestamp has 1s resolution and quit can only fire
          // once per second). Refuse rather than overwriting.
          resolve({ ok: false, error: `Backup folder already exists: ${backupDir}` })
          return
        }
        mkdirSync(backupDir, { recursive: true })
        appendAudit(parentDir, { event: 'backup.start', folder: basename(backupDir), outcome: '' })

        const wrapped = passphrase
          ? wrapDekWithPassphrase(secureStore.getOrCreateDek(), passphrase)
          : null

        const manifest: Record<string, unknown> = {
          appVersion: app.getVersion(),
          createdAt: new Date().toISOString(),
          schema: 2,
          encryptionMode: secureStore.encryptionMode(),
          wrapped: !!wrapped,
          files: wrapped
            ? ['apply-assistant-data.json', 'apply-assistant-key.wrapped', 'kdf.json']
            : ['apply-assistant-data.json', 'apply-assistant-key']
        }

        if (wrapped) {
          manifest.kdf = wrapped.kdf
          // HMAC over the manifest EXCLUDING the hmac field itself.
          // canonicalJson() inside signManifest sorts keys so the
          // signature is stable across re-serialization.
          manifest.hmac = {
            alg: 'hmac-sha256',
            value: signManifest(stripHmac(manifest), passphrase, wrapped.kdf)
          }
        }

        writeFileSync(
          join(backupDir, 'manifest.json'),
          JSON.stringify(manifest, null, 2)
        )

        const dataFile = db.getStorePath()
        if (existsSync(dataFile)) {
          writeFileSync(join(backupDir, 'apply-assistant-data.json'), readFileSync(dataFile))
        }

        if (wrapped) {
          writeFileSync(
            join(backupDir, 'apply-assistant-key.wrapped'),
            wrapped.wrapped
          )
          writeFileSync(
            join(backupDir, 'kdf.json'),
            JSON.stringify(wrapped.kdf, null, 2)
          )
        } else {
          const keyFile = join(app.getPath('userData'), 'apply-assistant-key')
          if (existsSync(keyFile)) {
            writeFileSync(join(backupDir, 'apply-assistant-key'), readFileSync(keyFile))
          }
        }

        db.updateSettings({ backup_last_success_at: new Date().toISOString() })
        db.updateSettings({ backup_last_error: '' })
        appendAudit(parentDir, {
          event: 'backup.success',
          folder: basename(backupDir),
          outcome: wrapped ? 'wrapped' : 'legacy'
        })
        resolve({ ok: true, path: backupDir })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        try { db.updateSettings({ backup_last_error: msg }) } catch { /* ignore */ }
        if (parentDir) {
          appendAudit(parentDir, {
            event: 'backup.failed',
            folder: basename(backupDir) || '<uncreated>',
            outcome: msg
          })
        }
        resolve({ ok: false, error: msg })
      }
    })
  }

  ipcMain.handle('backup:pickFolder', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: 'Choose backup folder',
      properties: ['openDirectory', 'createDirectory']
    })
    if (canceled || !filePaths || !filePaths[0]) return null
    // Detect synced/cloud folders. The renderer must surface a
    // confirmation step before committing the path to settings, so
    // the user has an explicit choice to proceed or pick again.
    const info = detectSyncedFolder(filePaths[0])
    return {
      path: filePaths[0],
      warning: info.synced
        ? `This folder is inside a synced cloud drive (${info.providers.join(', ')}). Backups may be locked or partially synced mid-write, and copies of the data may be stored on the cloud provider's servers. Continue anyway?`
        : null
    }
  })

  ipcMain.handle('backup:preview', async (_e, folderPath: string) => {
    // Manifest-only metadata for the restore preview. We do NOT
    // decrypt the data file here — counts are deliberately omitted
    // to keep the preview privacy-preserving. The user gets the
    // format details (date, schema, encryption mode, signature
    // status) and can decide whether to proceed with the actual
    // restore.
    if (!folderPath) return null
    if (!existsSync(folderPath)) return { error: 'Backup folder does not exist' }

    const manifestPath = join(folderPath, 'manifest.json')
    let manifest: Record<string, unknown> | null = null
    let manifestError = ''
    if (existsSync(manifestPath)) {
      try { manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) } catch (err) {
        manifestError = err instanceof Error ? err.message : String(err)
      }
    }

    const hasWrappedKey = existsSync(join(folderPath, 'apply-assistant-key.wrapped'))
    const hasKdf = existsSync(join(folderPath, 'kdf.json'))
    const hasLegacyKey = existsSync(join(folderPath, 'apply-assistant-key'))

    const result: {
      error?: string
      manifestError?: string
      createdAt?: string
      schema?: number
      encryptionMode?: string
      wrapped?: boolean
      signed?: boolean
      hasKdf?: boolean
      hasWrappedKey?: boolean
      hasLegacyKey?: boolean
      requiresPassphrase?: boolean
      fileCount?: number
    } = {
      hasKdf,
      hasWrappedKey,
      hasLegacyKey,
      requiresPassphrase: hasWrappedKey
    }

    if (manifest) {
      result.createdAt = typeof manifest.createdAt === 'string' ? manifest.createdAt : undefined
      result.schema = typeof manifest.schema === 'number' ? manifest.schema : undefined
      result.encryptionMode =
        typeof manifest.encryptionMode === 'string' ? manifest.encryptionMode : undefined
      result.wrapped = !!manifest.wrapped
      result.signed = !!manifest.hmac
    }
    if (manifestError) result.manifestError = manifestError

    // Count files in the backup folder for a quick "is this even a
    // complete backup" sanity check.
    let fileCount = 0
    try {
      const { readdirSync: rds } = require('fs') as typeof import('fs')
      fileCount = rds(folderPath).length
    } catch { /* ignore */ }
    result.fileCount = fileCount

    return result
  })

  ipcMain.handle('backup:run', async (_e, dir: string, passphrase?: string) => {
    if (!dir) return { ok: false, error: 'No backup path set' }
    return runBackup(dir, passphrase)
  })

  ipcMain.handle('backup:status', () => {
    const s = db.getSettings()
    return {
      path: s.backup_path || '',
      lastSuccessAt: s.backup_last_success_at || '',
      lastError: s.backup_last_error || ''
    }
  })

  ipcMain.handle('backup:list', () => {
    // Scan the configured backup parent folder for `flow_job_backup_*`
    // subfolders. Returns newest-first. The path comes from settings so
    // a stale or removed path simply yields an empty list — the UI
    // surfaces "no backups" rather than a crash.
    const s = db.getSettings()
    const parentDir = s.backup_path ? join(s.backup_path, 'flow_job_backups') : ''
    if (!parentDir || !existsSync(parentDir)) return []
    let entries: string[]
    try {
      entries = readdirSync(parentDir)
    } catch {
      return []
    }
    const backups: { name: string; path: string; createdAt: string }[] = []
    for (const name of entries) {
      if (!name.startsWith('flow_job_backup_')) continue
      const full = join(parentDir, name)
      let stat
      try { stat = statSync(full) } catch { continue }
      if (!stat.isDirectory()) continue
      // Folder name encodes the timestamp: flow_job_backup_YYYYMMDD-HHmmss
      const ts = name.replace('flow_job_backup_', '')
      const iso = parseBackupTimestamp(ts)
      backups.push({ name, path: full, createdAt: iso || stat.mtime.toISOString() })
    }
    backups.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    return backups
  })

  ipcMain.handle('backup:restore', async (_e, folderPath: string, passphrase?: string) => {
    // Destructive. Overwrites the live data file and encryption key
    // with the contents of the chosen backup folder, then reloads
    // the in-memory store. Caller is expected to have confirmed with
    // the user.
    const parentDir = folderPath ? join(folderPath, '..') : ''
    const folderName = folderPath ? basename(folderPath) : '<none>'
    const logFailure = (code: string) => {
      if (parentDir) appendAudit(parentDir, { event: 'restore.failed', folder: folderName, outcome: code })
    }
    const logRefused = (code: string) => {
      if (parentDir) appendAudit(parentDir, { event: 'restore.refused', folder: folderName, outcome: code })
    }

    if (!folderPath) return { ok: false, error: 'No backup folder specified' }
    if (!existsSync(folderPath)) {
      logRefused('missing-folder')
      return { ok: false, error: `Backup folder does not exist: ${folderPath}` }
    }
    const srcData = join(folderPath, 'apply-assistant-data.json')
    if (!existsSync(srcData)) {
      logRefused('missing-data')
      return { ok: false, error: 'Backup is missing apply-assistant-data.json' }
    }

    // Read the manifest for HMAC verification + format detection.
    const manifestPath = join(folderPath, 'manifest.json')
    let manifest: Record<string, unknown> | null = null
    if (existsSync(manifestPath)) {
      try { manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) } catch { /* tolerate */ }
    }

    // Detect the DEK format. Precedence:
    //   1. apply-assistant-key.wrapped + kdf.json (passphrase-wrapped)
    //   2. apply-assistant-key (legacy un-wrapped)
    const wrappedKeyPath = join(folderPath, 'apply-assistant-key.wrapped')
    const kdfPath = join(folderPath, 'kdf.json')
    const legacyKeyPath = join(folderPath, 'apply-assistant-key')
    const isWrapped = existsSync(wrappedKeyPath) && existsSync(kdfPath)
    const isLegacy = !isWrapped && existsSync(legacyKeyPath)

    if (!isWrapped && !isLegacy) {
      logRefused('missing-key')
      return { ok: false, error: 'Backup is missing apply-assistant-key (wrapped or legacy)' }
    }

    const warnings: string[] = []
    let verified = true

    if (isWrapped) {
      if (!passphrase) {
        logRefused('passphrase-required')
        return { ok: false, error: 'This backup is passphrase-protected. Enter the passphrase to restore.' }
      }
      // HMAC verify (if present in manifest) before any decrypt or write.
      const kdf = JSON.parse(readFileSync(kdfPath, 'utf-8'))
      if (manifest && manifest.hmac) {
        const expected = (manifest.hmac as { value: string }).value
        const recomputed = verifyManifest(stripHmac(manifest), expected, passphrase, kdf)
        if (!recomputed) {
          logRefused('hmac-fail')
          return { ok: false, error: 'Wrong passphrase or tampered backup (HMAC verification failed).' }
        }
      } else {
        warnings.push('This backup is not signed. Authenticity cannot be verified.')
      }
      try {
        const wrappedB64 = readFileSync(wrappedKeyPath, 'utf-8')
        unwrapDekWithPassphrase({ wrapped: wrappedB64, kdf }, passphrase)
        // We only need the unwrap to succeed (proves the passphrase is
        // correct); the live DEK is not yet replaced. The data file
        // itself is what gets restored, and decryption happens lazily
        // on the next load.
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        logRefused('unwrap-fail')
        return { ok: false, error: msg }
      }
    } else {
      // Legacy un-wrapped backup — no passphrase was used. Surface a
      // warning so the renderer can prompt for confirmation. We do
      // NOT silently restore because that's exactly the security
      // hole we're closing.
      warnings.push('This backup is not passphrase-protected (legacy format). Continuing restores the encryption key as-is.')
    }

    const dataDest = db.getStorePath()
    const keyDest = join(app.getPath('userData'), 'apply-assistant-key')
    // Snapshot the existing data file so we can roll back if the
    // reload fails (e.g. the live DEK no longer matches the backup's
    // DEK, which would cause loadStore to throw). Without rollback,
    // the user would be left with a data file they can't decrypt.
    const previousData = existsSync(dataDest) ? readFileSync(dataDest) : null
    const previousKey = existsSync(keyDest) ? readFileSync(keyDest) : null

    try {
      writeFileSync(dataDest, readFileSync(srcData))
      if (isWrapped) {
        // For passphrase-wrapped backups, we DO NOT write the live
        // DEK file from the backup (it isn't there). The user keeps
        // their current DEK, and the new data file is encrypted
        // under it. The data file's contents already contain the
        // ciphertext keyed to the DEK from the backup's environment;
        // but since the data file is encrypted with the DEK, this
        // only works if the user's current DEK matches the backup's.
        // In practice the user is restoring on the same machine
        // where the backup was made, so the DEK is identical.
        // If they migrated to a new machine, restore would require
        // also restoring the DEK — which is exactly the scenario
        // where the wrapped format protects them. We document this
        // trade-off in the renderer.
        //
        // Concretely: for a wrapped backup, do nothing for the key
        // file. The caller is expected to re-set the passphrase in
        // settings if it changed.
      } else {
        writeFileSync(keyDest, readFileSync(legacyKeyPath))
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logFailure('write-fail')
      return { ok: false, error: msg }
    }

    // Discard the in-memory store and re-read the data file from
    // disk. The encryption-key file is re-read fresh on the next
    // load (secureStore.getOrCreateDek does not cache). If the
    // reload throws (e.g. DEK mismatch — the live key no longer
    // matches the backup's key), roll back the data file so the
    // user's previous state is preserved and surface a clear error.
    try {
      db.reloadStore()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (previousData !== null) writeFileSync(dataDest, previousData)
      else {
        try { unlinkSync(dataDest) } catch { /* ignore */ }
      }
      if (isWrapped && previousKey !== null) {
        // Wrapped backups never overwrite the key, so prior key
        // is still on disk — nothing to restore.
      } else if (!isWrapped && previousKey !== null) {
        writeFileSync(keyDest, previousKey)
      }
      logFailure('reload-fail')
      return { ok: false, error: msg }
    }

    if (parentDir) {
      appendAudit(parentDir, {
        event: 'restore.success',
        folder: folderName,
        outcome: isWrapped ? 'wrapped' : 'legacy'
      })
    }
    return { ok: true, warning: warnings[0] || undefined }
  })

  // Fire-and-forget backup on quit. Best-effort, never blocks quit —
  // a slow or failing backup should never prevent the user from
  // closing the app. We only attempt it if a backup_path is set, and
  // we re-check it inside runBackup so a stale or removed path
  // surfaces as a stored backup_last_error rather than a crash.
  //
  // Per product decision: if the user has NOT set a passphrase, we
  // skip the close-time auto-backup entirely. Un-wrapped backups
  // are the security failure mode we're trying to avoid.
  let lastAutoBackupAttempt = 0
  app.on('before-quit', () => {
    const s = db.getSettings()
    if (!s.passphrase) return
    const now = Date.now()
    // Debounce: if multiple before-quit events fire in quick
    // succession (e.g. user hits Cmd+Q then confirms a dialog),
    // only run the backup once.
    if (now - lastAutoBackupAttempt < 5000) return
    lastAutoBackupAttempt = now
    if (!s.backup_path) return
    runBackup(s.backup_path, s.passphrase).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err)
      log.backup.error('close-time backup failed:', msg)
    })
  })

  ipcMain.handle('security:status', () => db.encryptionStatus())

  // AI Queue
  ipcMain.handle('aiQueue:list', () => db.getAIQueue())

  ipcMain.handle('boards:list', () => {
    // Per-board enabled flag, sourced from settings.disabled_boards.
    // The Settings > Boards tab maintains that list; the scan page
    // reads `enabled` to decide which boards to render in the picker
    // and the main-process scan loop applies the same filter as a
    // defence-in-depth check (the renderer's filter alone is a UX
    // concern; this is the actual enforcement).
    const disabled = new Set(db.getSettings().disabled_boards || [])
    return BOARDS.map((b) => ({ name: b.name, useBrowser: b.useBrowser, enabled: !disabled.has(b.name) }))
  })
  ipcMain.handle('boards:health', () => db.getBoardHealth())
  ipcMain.handle('aiQueue:retry', (_e, id: number) => {
    db.updateAIQueueItem(id, { status: 'pending', nextRetryAt: Date.now(), lastError: undefined })
    return db.getAIQueue()
  })
  ipcMain.handle('aiQueue:remove', (_e, id: number) => {
    db.removeAIQueueItem(id)
    return db.getAIQueue()
  })

  ipcMain.handle('shell:openExternal', (_e, url: string) => {
    if (typeof url !== 'string') return
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return
    return shell.openExternal(url)
  })
}

app.whenReady().then(() => {
  registerIpc()
  createWindow()
  startQueueProcessor()
  scheduleNextAutoScan()

  // One-shot: normalize legacy locations to "City, REGION, CC" the first time
  // the app loads with a populated store. Idempotent — gated by a flag.
  if (!db.hasLocationsNormalized() && db.listJobs().length > 0) {
    try {
      const result = db.retrofitLocations()
      if (result.updated > 0) {
        log.startup.info(`Normalized ${result.updated}/${result.total} job locations.`)
      }
    } catch (err) {
      log.startup.error('Location retrofit failed:', err)
    }
  }

  // One-shot: annualize legacy salary strings ("$43/hour" → "$86,000",
  // "CAD Monthly" → annual equivalent, etc.) on first load with a
  // populated store. Idempotent — gated by a flag. New jobs added
  // after this point are normalized at the persistence boundary
  // (createJob / updateJob) so the retrofit only touches pre-existing
  // rows that landed before this feature shipped.
  if (!db.hasSalaryNormalized() && db.listJobs().length > 0) {
    try {
      const result = db.retrofitSalaryNormalization()
      if (result.updated > 0) {
        log.startup.info(`Annualized ${result.updated}/${result.total} job salaries.`)
      }
      db.markSalaryNormalized()
    } catch (err) {
      log.startup.error('Salary normalization retrofit failed:', err)
    }
  }

  // One-shot: collapse legacy employment_type strings to the 8 canonical
  // tokens that the Edit dropdown is constrained to. Unmappable values
  // are nulled so the user can pick the right token. New jobs added
  // after this point are normalized at the persistence boundary
  // (createJob / updateJob) so the retrofit only touches pre-existing
  // rows. Idempotent — gated by a flag, mirroring the salary/locations
  // pattern.
  if (!db.hasEmploymentTypeNormalized() && db.listJobs().length > 0) {
    try {
      const result = db.retrofitEmploymentTypeNormalization()
      if (result.updated > 0 || result.nulled > 0) {
        log.startup.info(
          `Standardized ${result.updated} employment_type values, ` +
          `nulled ${result.nulled} unmappable.`
        )
      }
      db.markEmploymentTypeNormalized()
    } catch (err) {
      log.startup.error('Employment type retrofit failed:', err)
    }
  }

  // One-shot: collapse legacy work_mode strings ("Remote", "On-site",
  // "Work from home", "Hybrid (2 days)", etc.) to the 3 canonical
  // tokens (ON_SITE, HYBRID, REMOTE) that the Edit dropdown is
  // constrained to. Unmappable values are nulled. New jobs added
  // after this point are normalized at the persistence boundary.
  if (!db.hasWorkModeNormalized() && db.listJobs().length > 0) {
    try {
      const result = db.retrofitWorkModeNormalization()
      if (result.updated > 0 || result.nulled > 0) {
        log.startup.info(
          `Standardized ${result.updated} work_mode values, ` +
          `nulled ${result.nulled} unmappable.`
        )
      }
      db.markWorkModeNormalized()
    } catch (err) {
      log.startup.error('Work mode retrofit failed:', err)
    }
  }

  // One-shot: recompute every job's status from its current documents the
  // first time the app loads after the doc-derived status rule landed. This
  // backfills statuses that drifted while the recompute was per-handler
  // only. Idempotent — gated by a flag.
  if (!db.hasStatusesRecomputed() && db.listJobs().length > 0) {
    try {
      const result = db.recomputeAllJobStatuses()
      if (result.updated > 0) {
        log.startup.info(`Refreshed status for ${result.updated}/${result.total} jobs.`)
      }
    } catch (err) {
      log.startup.error('Status refresh failed:', err)
    }
  }

  // One-shot: bump the global CV version so the bootstrap score pass re-scores
  // every job that's currently holding a heuristic-only fit score. This
  // self-heals the bug where the LLM scorer silently fell back to a keyword
  // overlap score and the user got a misleading number. After this runs
  // once the flag is set, so subsequent launches only re-score when the
  // user actually edits the base CV.
  if (!db.hasFitRescoreFlag() && db.listJobs().length > 0) {
    try {
      const v = db.bumpCvVersion()
      db.markFitRescored()
      log.startup.info(`Bumped cv_version to ${v} to force fit re-score of all jobs.`)
    } catch (err) {
      log.startup.error('CV version bump failed:', err)
    }
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    stopQueueProcessor()
    app.quit()
  }
})
