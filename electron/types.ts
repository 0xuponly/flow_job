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

export interface VerificationResult {
  score: number
  passed: boolean
  feedback: string
}

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
  location?: string
  url?: string
  description?: string
  salary_range?: string
  requirements?: string
  application_requirements?: string
  hiring_manager?: string
  employment_type?: string
  work_mode?: string
  source?: string
  score?: number | null
  notes?: string
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
}

export interface ScanBoardResult {
  board: string
  found: number
  added: number
  skipped: number
  error?: string
}

export interface ScanResult {
  totalFound: number
  totalAdded: number
  totalSkipped: number
  boards: ScanBoardResult[]
  errors: string[]
}

export interface ScanStatus {
  scanning: boolean
  progress: string[]
  result: ScanResult | null
  startedAt: number | null
}
