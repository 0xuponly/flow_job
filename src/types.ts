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
  hiring_manager: string | null
  employment_type: string | null
  work_mode: string | null
  source: string | null
  status: JobStatus
  score: number | null
  fit_rationale: string | null
  fit_breakdown: FitBreakdown | null
  fit_score_version: number | null
  fit_last_error: string | null
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
  backup_path: string
  backup_last_success_at: string
  backup_last_error: string
  passphrase: string
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
  notes?: string | null
  date_posted?: string | null
}

export type Page =
  | 'dashboard'
  | 'scanjobs'
  | 'jobs'
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
  location?: string
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
  boards: ScanBoardResult[]
  errors: string[]
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

export interface TailorRequest {
  job_id: number
  document_type: 'cv' | 'cover_letter'
  base_content?: string
}

export interface TailorResult {
  content: string
  document_id: number
}
