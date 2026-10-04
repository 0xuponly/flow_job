import type { LocationPick } from './locations'

export type JobStatus =
  | 'sourced'
  | 'reviewing'
  | 'tailoring'
  | 'ready'
  | 'applied'
  | 'follow_up'
  | 'interviewing'
  | 'offer'
  | 'rejected'
  | 'withdrawn'

export interface FitBreakdown {
  matched_skills: string[]
  missing_skills: string[]
  experience_years_match: boolean | null
}

export interface Job {
  id: number
  title: string
  company: string
  location: string | null
  url: string | null
  description: string | null
  salary_range: string | null
  requirements: string | null
  application_requirements: string | null
  // 1 = user set this status explicitly; doc recompute must skip it.
  manual_status?: 0 | 1
  hiring_manager: string | null
  employment_type: string | null
  work_mode: string | null
  source: string | null
  status: JobStatus
  score: number | null
  fit_rationale: string | null
  fit_breakdown: FitBreakdown | null
  fit_score_version: number | null
  fit_source: FitSource
  fit_last_error: string | null
  fit_error_toasted: string | null
  match_grade: MatchGrade
  tailor_ms_cv: number | null
  tailor_ms_cl: number | null
  tailor_generated_at: number | null
  tailor_last_error: string | null
  tailor_error_toasted: string | null
  submitted_at: number | null
  response_at: number | null
  notes: string | null
  date_posted: string | null
  application_deadline: string | null
  last_updated: string | null
  created_at: string
  updated_at: string
}

export interface Document {
  id: number
  job_id: number | null
  type: 'cv' | 'cover_letter'
  title: string
  content: string
  is_base: number
  model_used: string | null
  verification_score: number | null
  verification_feedback: string | null
  created_at: string
  updated_at: string
}

export interface Application {
  id: number
  job_id: number
  status: JobStatus
  applied_at: string | null
  method: string | null
  contact_email: string | null
  contact_name: string | null
  notes: string | null
  cv_document_id: number | null
  cover_letter_document_id: number | null
  created_at: string
  updated_at: string
}

export interface FollowUp {
  id: number
  application_id: number
  due_date: string
  completed_at: string | null
  type: 'email' | 'call' | 'linkedin' | 'other'
  message: string | null
  notes: string | null
  created_at: string
}

export interface Interview {
  id: number
  application_id: number
  scheduled_at: string
  duration_minutes: number
  type: 'phone' | 'video' | 'onsite' | 'technical' | 'other'
  location: string | null
  interviewer: string | null
  notes: string | null
  outcome: 'scheduled' | 'completed' | 'cancelled' | 'no_show' | null
  created_at: string
}

export interface ApiModelConfig {
  id: string
  name: string
  base_url: string
  api_key: string
  model: string
  enabled?: boolean
  // Per-model per-attempt HTTP timeout in ms; unset means the main-process
  // default (45000). Mirrors electron/types.ts. Not surfaced in the UI.
  timeout_ms?: number
}

export interface Settings {
  openai_api_key: string
  openai_base_url: string
  openai_model: string
  user_name: string
  user_email: string
  user_phone: string
  user_country: string
  base_cv: string
  job_search_keywords: string
  job_search_location: string
  job_search_locations: string
  deleted_jobs_cap: number
  auto_scan_enabled: boolean
  auto_scan_interval_minutes: number
  // Minimum 0-1 match score a listing must reach against the base CV
  // for a scan to add it; below it the listing is skipped, not stored.
  // 0 disables the floor. Only applies when base_cv is set. Mirrors the
  // main-process default (0.25), the value the hardcoded floor used
  // before this setting existed.
  scan_min_match: number
  backup_path: string
  backup_last_success_at: string
  backup_last_error: string
  passphrase: string
  adzuna_app_id: string
  adzuna_app_key: string
  aggregator_remotive_enabled: boolean
  aggregator_arbeitnow_enabled: boolean
  aggregator_jobicy_enabled: boolean
  aggregator_himalayas_enabled: boolean
  ats_boards: AtsBoard[]
  // Names of job boards the user has disabled. Boards in this list
  // are hidden from the scan page picker AND skipped by the main-
  // process scan loop. Empty array = all boards enabled.
  disabled_boards: string[]
  // Fit-score threshold (0-100) at or above which a job auto-enqueues
  // document generation + AI review once its fit score lands. No UI
  // writes it: it lived in the retired Scan tab "Auto-Queue" section.
  auto_doc_min_fit: number
  // Per-kind auto-queue switches (Settings > Auto-queue). Each gates
  // AUTOMATIC queueing only — an explicit generate / verify / tailor
  // still queues with these off. Default true; see the main-process
  // Settings type for the full contract.
  auto_queue_fit: boolean
  auto_queue_cv: boolean
  auto_queue_cover_letter: boolean
  auto_queue_verify_cv: boolean
  auto_queue_verify_cover_letter: boolean
  quick_apply_shortcut: string | null
  /**
   * How many real requests ONE AI provider (one account / credential, not
   * one model) may be asked for in a rolling 24 hours by AUTOMATED work.
   * At the cap the app stops calling that provider on its own and picks the
   * work up when the window slides; anything the user asks for directly
   * still runs and still counts.
   *
   * The renderer copy of the main-process contract — see the main-process
   * `Settings` type for why the number is 50.
   */
  provider_call_cap: number
  // Optional proxy URL for the browser scraper. Format: "http://user:pass@host:port"
  // or "socks5://host:port". When empty, no proxy is used.
  scraper_proxy: string
}

export type MatchGrade = 'S' | 'A' | 'B' | 'C' | 'D' | 'F' | null

export type FitSource = 'llm' | 'heuristic' | null

export type AtsPlatform = 'greenhouse' | 'lever' | 'ashby' | 'workday' | 'smartrecruiters'

export interface AtsBoard {
  id: string
  name: string
  platform: AtsPlatform
  token: string
  enabled: boolean
}

export interface DashboardStats {
  total_jobs: number
  applied: number
  interviewing: number
  offers: number
  pending_follow_ups: number
  upcoming_interviews: number
}

export interface CreateJobInput {
  title: string
  company: string
  location?: string | null
  url?: string | null
  description?: string | null
  salary_range?: string | null
  requirements?: string | null
  application_requirements?: string | null
  hiring_manager?: string | null
  employment_type?: string | null
  work_mode?: string | null
  source?: string | null
  score?: number | null
  fit_source?: FitSource
  notes?: string | null
  date_posted?: string | null
  application_deadline?: string | null
}

export type Page =
  | 'dashboard'
  | 'scanjobs'
  | 'jobs'
  | 'queue'
  | 'pipeline'
  | 'documents'
  | 'followups'
  | 'interviews'
  | 'settings'

export const STATUS_LABELS: Record<JobStatus, string> = {
  sourced: 'Sourced',
  reviewing: 'Reviewing',
  tailoring: 'Tailoring',
  ready: 'Ready to Apply',
  applied: 'Applied',
  follow_up: 'Follow Up',
  interviewing: 'Interviewing',
  offer: 'Offer',
  rejected: 'Rejected',
  withdrawn: 'Withdrawn'
}

export type WorkType = 'any' | 'remote' | 'hybrid' | 'in_office'

export interface ScanFilters {
  keywords?: string
  locations?: LocationPick[]
  workType?: WorkType
  boards?: string[]
}

export interface ScanBoardResult {
  board: string
  found: number
  added: number
  skipped: number
  errors: number
  // Listings that passed extraction but were rejected by the
  // workType/location/score filters.
  incompatible: number
  error?: string
}

export interface ScanResult {
  totalFound: number
  totalAdded: number
  totalSkipped: number
  totalErrors: number
  totalIncompatible: number
  boards: ScanBoardResult[]
  errors: string[]
  // Plain-language caveats about how the run was filtered (e.g. the
  // match floor dropped N listings, or no base CV was configured so
  // nothing could be filtered). Optional because a result cached by an
  // older build can reach the renderer without it.
  notes?: string[]
  startedAt: number | null
  durationMs: number
  cancelled: boolean
  addedJobs: { id: number; title: string; company: string }[]
}

export interface ScanStatus {
  scanning: boolean
  progress: string[]
  result: ScanResult | null
  startedAt: number | null
}

// Mirrors electron/types.ts. `tailor_job_docs` and `score_fit` were
// missing here even though the main process has emitted them since
// P1.7, which made this union a lie the queue UI could not render.
export type AIQueueItemType = 'generate_cv' | 'generate_cover_letter' | 'regenerate_section' | 'verify' | 'tailor_job_docs' | 'score_fit'

/**
 * Mirrors AUTO_REVIVE_MAX in electron/types.ts. The renderer needs it
 * only to decide whether a failed task still has automatic recovery
 * left, so it can offer a retry instead of calling it abandoned.
 *
 * Kept as a literal rather than imported: the renderer must not depend
 * on a main-process module, and electron/types.ts is a type surface
 * today rather than a contract that will stay one. The cost of the copy
 * is drift, so src/fitQueue.test.ts pins the two to each other and fails
 * the build if either moves without the other.
 */
export const AUTO_REVIVE_MAX = 3

/**
 * Mirrors PASSING_REVIEW_SCORE / AUTO_REGEN_MAX in electron/types.ts.
 *
 * The Settings copy has to state what the main process will actually
 * do — "auto-regenerates up to 5x if the review scores below 80" is a
 * promise about the queue, and while the numbers were hardcoded
 * literals in the JSX they were free to drift from the behaviour they
 * describe (they did: the loop could only ever run once, so the page
 * was promising five). Rendering them from the constants means the
 * copy is a consequence of the behaviour rather than a copy of it.
 *
 * Kept as literals rather than shared over IPC for the same reason as
 * AUTO_REVIVE_MAX: duplicating two integers is cheaper than a round
 * trip on every Settings render. types.test.ts asserts they still
 * equal the main-process constants, so the duplication cannot rot
 * quietly.
 */
export const PASSING_REVIEW_SCORE = 80
export const AUTO_REGEN_MAX = 5

export type AIQueueItemStatus = 'pending' | 'processing' | 'failed'

/**
 * A stored AI queue row, exactly as the main process persists it.
 *
 * Deliberately does NOT carry `jobTitle` / `jobCompany`. It used to
 * declare them optional, which made a raw row satisfy the renderer's
 * contract for a queue row and let a handler answer with store rows
 * while the types still agreed: the panel's `jobLine()` falls through to
 * its `Job <id>` fallback for a row without them, so the moment ONE
 * queue-returning IPC returned raw rows, every row's label became
 * `Job <id>` at once. The display fields are a view, not state — a job
 * can be renamed or deleted at any moment, so they are resolved per
 * list. Use `QueueItemView` for anything the UI renders.
 */
export interface AIQueueItem {
  id: number
  type: AIQueueItemType
  jobId: number
  documentId?: number
  sectionName?: string
  extraContext?: string
  status: AIQueueItemStatus
  attempts: number
  lastError?: string
  /** Times this item has been revived from `failed` by the auto-recovery loop. */
  autoRevives?: number
  /**
   * Epoch ms of the last manual re-add, or absent when unpromoted. The
   * main process resolves the order the panel renders, so the panel
   * never has to sort on this — it is mirrored only so the field
   * survives the trip across IPC without the renderer type claiming a
   * shape the main process does not send.
   */
  promotedAt?: number
  /**
   * Why this `pending` row is not running: `provider_cap` while a provider's
   * call budget is spent. Mirrors the main-process field, which writes it on
   * the way in and clears it on the way out; the renderer only reads it, to
   * tell a free-to-retry row apart from one waiting out a real budget.
   */
  parkedReason?: 'provider_cap'
  createdAt: number
  nextRetryAt: number
}

/**
 * A queue row as the Queue panel consumes it: the stored row plus the
 * job's title and company, resolved by the main process at list time.
 *
 * Mirrors `QueueItemView` in electron/types.ts. The two fields are
 * REQUIRED (and nullable) rather than optional, which is the whole
 * point: `AIQueueItem` is not assignable to this, so an IPC handler
 * that returns raw store rows no longer type-checks and cannot be
 * shipped as a silent one-row-rename-everything bug. Every
 * queue-returning IPC (`aiQueue:list`, `retry`, `remove`, `clear`) is
 * annotated to return this view.
 *
 * Null in both positions means the job is gone; that is the only case
 * the panel's `Job <id>` fallback is for.
 */
export type QueueItemView = AIQueueItem & {
  jobTitle: string | null
  jobCompany: string | null
  /**
   * The row claims to be `processing` but no run in this app session
   * owns it — a crash left it that way and the app did not resume it on
   * its own. Mirrors the main-process view field, which resolves it per
   * list rather than storing it; optional here because a row built by a
   * test or by hand simply has no opinion, and absent reads as false.
   */
  stranded?: boolean
}

export const STATUS_COLORS: Record<JobStatus, string> = {
  sourced: '#6366f1',
  reviewing: '#8b5cf6',
  tailoring: '#a855f7',
  ready: '#22c55e',
  applied: '#3b82f6',
  follow_up: '#f59e0b',
  interviewing: '#06b6d4',
  offer: '#10b981',
  rejected: '#ef4444',
  withdrawn: '#6b7280'
}

export type VerificationResult =
  | { kind: 'review'; score: number; passed: boolean; feedback: string }
  | { kind: 'skip'; reason: 'deleted' | 'parse_failed' | 'no_ai_response'; feedback: string }

export type KeywordCategory = 'hard' | 'soft' | 'cert' | 'seniority'
export type KeywordSource = 'title' | 'required' | 'preferred' | 'body'

export interface KeywordEntry {
  phrase: string
  weight: number
  category: KeywordCategory
  source: KeywordSource
}

// P1.3 — structured years-of-experience signal for fit scoring and
// tailor prompts. Additive; consumers can read it when ready, ignore
// it otherwise. Each entry pairs a canonical skill phrase (the form
// emitted by extractPhases / allowlist) with a minYears value parsed
// from the JD ("5+ years of Python" → 5, "3-5 years experience with
// Kubernetes" → 3, the lower bound of a range). Negated years
// mentions ("5+ years of Python not required") are dropped from
// this list, mirroring the keyword-suppression rule.
export interface YearsOfExperience {
  phrase: string
  minYears: number
}

export interface KeywordResult {
  keywords: KeywordEntry[]
  refinedByLlm: boolean
  // LLM-accepted phrases not in any allowlist. Surfaced in JobDetail so the
  // user can review them and decide whether to add to keywordAllowlists.json
  // in a follow-up PR. Populated only when refinedByLlm is true.
  unknownPhrases: string[]
  // P1.3 (additive, optional — present on results from
  // extractJobKeywordsStructured / extractJobKeywordsV3, absent on
  // results from mergeKeywordResults until the orchestrator wires
  // it through in a follow-up). See YearsOfExperience above.
  yearsOfExperience?: YearsOfExperience[]
}

export interface TailorRequest {
  job_id: number
  document_type: 'cv' | 'cover_letter'
  base_content?: string
  topKeywords?: string[]
}

export interface TailorResult {
  content: string
  document_id: number
}

// Notification center — mirror of electron/types.ts NotificationRow + the
// narrow literal unions for `type` and `source`. Defined here (not
// imported from electron/types.ts) because the two files drift: the
// renderer-side `src/types.ts` is a stable renderer contract, while
// electron/types.ts is the live main-process contract and grows over
// time. Importing from electron/types into src/ has caused cross-file
// type incompatibilities (different AIQueueItemType unions), so the
// renderer duplicates only the narrow bits it actually consumes.
export type NotificationType = 'info' | 'success' | 'error' | 'warning'
export type NotificationSource = 'app' | 'ai' | 'scanner' | 'tailor' | 'scraper'

// Which job an occurrence happened on, snapshotted when it was recorded.
// The fields are nullable because the data is genuinely missing sometimes;
// null means "we did not have this" and never "we guessed". See the same
// interface in electron/types.ts for why this is a snapshot and not a
// foreign key.
export interface NotificationJobContext {
  // Nullable on purpose: see the same field in electron/types.ts. The
  // drawer renders whichever of title/company/location are present and
  // nothing for the rest.
  job_id: number | null
  job_title: string | null
  job_company: string | null
  job_location: string | null
}

export interface NotificationRow {
  id: number
  type: NotificationType
  source: NotificationSource
  message: string
  full_message: string
  created_at: number
  dismissed_at: number | null
  group_key: string
  job?: NotificationJobContext
}
