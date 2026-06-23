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

export interface Job {
  id: number
  title: string
  company: string
  location: string | null
  url: string | null
  description: string | null
  salary_range: string | null
  source: string | null
  status: JobStatus
  notes: string | null
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

export interface Settings {
  openai_api_key: string
  openai_base_url: string
  openai_model: string
  user_name: string
  user_email: string
  user_phone: string
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
  source?: string
  notes?: string
}

export type Page =
  | 'dashboard'
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
