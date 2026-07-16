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

export type ApplicationStatus = JobStatus

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
  hiring_manager: string | null
  employment_type: string | null
  work_mode: string | null
  source: string | null
  status: JobStatus
  score: number | null
  fit_rationale: string | null
  fit_breakdown: FitBreakdown | null
  fit_score_version: number | null
  // Set when the most recent fit-scorer run fell back to a heuristic (no
  // LLM response, parse failure, no models configured, etc.). NULL means
  // the row is either unscored or was scored successfully by the LLM. The
  // UI shows this in place of a numeric score so the user can tell the
  // difference between "bad fit" and "scorer is broken".
  fit_last_error: string | null
  // The fit_last_error string that was last surfaced to the user via a
  // toast. Persisted so the toast does not re-fire on every app open for
  // a still-failing job — only when the error text actually changes (or
  // is cleared and re-appears). NULL = never toasted, or error was
  // cleared since the last toast (a future re-occurrence re-arms).
  fit_error_toasted: string | null
  notes: string | null
  date_posted: string | null
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

/**
 * Result of `verifyDocumentContent`. Two shapes:
 *  - `review`: an actual LLM review with a numeric score and pass/fail.
 *  - `skip`:  no review happened (e.g. document was deleted, AI parse failed,
 *             rate-limited but not retried here). Callers MUST NOT persist a
 *             skip as a verification_score, and MUST NOT feed it into the
 *             "regenerate until passed" loop.
 */
export type VerificationResult =
  | { kind: 'review'; score: number; passed: boolean; feedback: string }
  | { kind: 'skip'; reason: 'deleted' | 'parse_failed' | 'no_ai_response'; feedback: string }

export interface Application {
  id: number
  job_id: number
  status: ApplicationStatus
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
  deleted_jobs_cap: number
  auto_scan_enabled: boolean
  auto_scan_interval_minutes: number
  locations_normalized: string
  locations_normalized_v2: string
  employment_type_normalized: string
  work_mode_normalized: string
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
  disabled_boards: string[]
}

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
  fit_rationale?: string | null
  fit_breakdown?: FitBreakdown | null
  fit_score_version?: number | null
  notes?: string | null
  date_posted?: string | null
}

export interface TailorRequest {
  job_id: number
  document_type: 'cv' | 'cover_letter'
  base_content?: string
}

export interface TailorResult {
  content: string
  document_id: number
}

export type WorkType = 'any' | 'remote' | 'hybrid' | 'in_office'

export interface ScanFilters {
  keywords?: string
  location?: string
  workType?: WorkType
  boards?: string[] // names of boards to scan; undefined = scan all
}

export interface BoardHealth {
  name: string
  // Last 5 scan results (oldest first). Each is the total found across locations
  // for that scan, or -1 if the scan errored out.
  history: number[]
}

export interface ScanBoardResult {
  board: string
  found: number
  added: number
  skipped: number
  // Listings that passed extraction but were rejected by the
  // workType/location/score filters. Surfaced in the scan results
  // table so the user can tell "0 added" apart from "0 found".
  incompatible: number
  error?: string
}

export interface ScanResult {
  totalFound: number
  totalAdded: number
  totalSkipped: number
  boards: ScanBoardResult[]
  errors: string[]
  startedAt: number | null
  durationMs: number
  cancelled: boolean
  totalIncompatible: number
  addedJobs: { id: number; title: string; company: string }[]
}

export interface ScanStatus {
  scanning: boolean
  progress: string[]
  result: ScanResult | null
  startedAt: number | null
}

export type AIQueueItemType = 'generate_cv' | 'generate_cover_letter' | 'regenerate_section' | 'verify'
export type AIQueueItemStatus = 'pending' | 'processing' | 'failed'

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
  createdAt: number
  nextRetryAt: number
}

export interface DeletedJobRecord {
  // Key fields that identify the job (enough to dedup against future scans)
  url: string | null
  title: string
  company: string
  location: string | null
  // Last known fit score (0-1). If < 0.3, the user likely deleted because it was
  // low-fit, so future scans should not re-add this job.
  score: number | null
  deletedAt: number
}
