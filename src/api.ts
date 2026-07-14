import type {
  ApiModelConfig,
  AIQueueItem,
  Application,
  CreateJobInput,
  DashboardStats,
  Document,
  FollowUp,
  Interview,
  Job,
  JobStatus,
  ScanFilters,
  ScanResult,
  ScanStatus,
  Settings,
  TailorRequest,
  TailorResult,
  VerificationResult
} from './types'

export interface Api {
  getDashboardStats: () => Promise<DashboardStats>
  listJobs: (status?: JobStatus) => Promise<Job[]>
  getJob: (id: number) => Promise<Job | undefined>
  createJob: (input: CreateJobInput) => Promise<Job>
  updateJob: (id: number, fields: Partial<CreateJobInput & { status: JobStatus }>) => Promise<Job>
  deleteJob: (id: number) => Promise<void>
  deleteJobs: (ids: number[]) => Promise<{ requested: number; deleted: number; missingFromStore: number[]; stillPresentAfterFilter: number[] }>
  searchJobs: (query: string) => Promise<Job[]>
  importJobFromUrl: (url: string) => Promise<Job>
  scanBoards: (filters?: ScanFilters) => Promise<ScanResult>
  cancelScan: () => Promise<void>
  cancelImport: () => Promise<void>
  batchScore: () => Promise<void>
  backfillJobDates: () => Promise<number>
  listDocuments: (jobId?: number) => Promise<Document[]>
  createDocument: (type: 'cv' | 'cover_letter', title: string, content: string, jobId?: number) => Promise<Document>
  updateDocument: (id: number, title: string, content: string) => Promise<Document>
  deleteDocument: (id: number) => Promise<void>
  exportDocumentPdf: (title: string, content: string, docType?: string, company?: string, position?: string) => Promise<string | null>
  listApplications: () => Promise<(Application & { job_title: string; company: string })[]>
  getOrCreateApplication: (jobId: number) => Promise<Application>
  updateApplication: (id: number, fields: Partial<Application>) => Promise<Application>
  markApplied: (id: number, method: string, email?: string, name?: string) => Promise<Application>
  listFollowUps: (includeCompleted?: boolean) => Promise<(FollowUp & { job_title: string; company: string })[]>
  createFollowUp: (appId: number, dueDate: string, type: FollowUp['type'], message?: string) => Promise<FollowUp>
  completeFollowUp: (id: number) => Promise<FollowUp>
  generateFollowUpMessage: (company: string, title: string, days: number) => Promise<string>
  listInterviews: (upcomingOnly?: boolean) => Promise<(Interview & { job_title: string; company: string })[]>
  createInterview: (
    appId: number,
    scheduledAt: string,
    type: Interview['type'],
    duration?: number,
    location?: string,
    interviewer?: string,
    notes?: string
  ) => Promise<Interview>
  updateInterview: (id: number, fields: Partial<Interview>) => Promise<Interview>
  getSettings: () => Promise<Settings>
  updateSettings: (partial: Partial<Settings>) => Promise<Settings>
  resetSettings: () => Promise<Settings>
  listApiModels: () => Promise<ApiModelConfig[]>
  saveApiModels: (models: ApiModelConfig[]) => Promise<ApiModelConfig[]>
  addApiModel: (model: Omit<ApiModelConfig, 'id'>) => Promise<ApiModelConfig[]>
  deleteApiModel: (id: string) => Promise<ApiModelConfig[]>
  tailorDocument: (request: TailorRequest) => Promise<TailorResult | { queued: true }>
  verifyDocument: (jobId: number, documentId: number, docType: 'cv' | 'cover_letter') => Promise<VerificationResult | { queued: true }>
  regenerateSection: (documentId: number, sectionName: string, jobId: number, extraContext?: string) => Promise<string | { queued: true }>
  getScanStatus: () => Promise<ScanStatus>
  clearScanResult: () => Promise<void>
  onScanProgress: (cb: (msg: string) => void) => () => void
  onScanComplete: (cb: (result: ScanResult) => void) => () => void
  clearSeenUrls: () => Promise<void>
  clearAllData: () => Promise<void>
  exportAllData: () => Promise<string | null>
  openExternal: (url: string) => Promise<void>
  getSecurityStatus: () => Promise<{ mode: 'sealed' | 'plaintext-fallback' | 'uninitialized' }>
  listAIQueue: () => Promise<AIQueueItem[]>
  listBoards: () => Promise<{ name: string; useBrowser: boolean }[]>
  getBoardHealth: () => Promise<Record<string, number[]>>
  retryAIQueueItem: (id: number) => Promise<AIQueueItem[]>
  removeAIQueueItem: (id: number) => Promise<AIQueueItem[]>
  listBlacklistedCompanies: () => Promise<string[]>
  addBlacklistedCompany: (name: string) => Promise<string[]>
  removeBlacklistedCompany: (name: string) => Promise<string[]>
}

declare global {
  interface Window {
    api: Api
  }
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

function getBridge(): Api {
  if (!window.api) {
    throw new Error('Desktop API unavailable. Run the app with npm run dev, not in a browser.')
  }
  return window.api
}

export const api: Api = new Proxy({} as Api, {
  get(_target, prop) {
    const bridge = getBridge()
    const value = bridge[prop as keyof Api]
    if (typeof value !== 'function') {
      throw new Error(
        `API method "${String(prop)}" is unavailable. Quit and restart the app (npm run dev).`
      )
    }
    return value.bind(bridge)
  }
})
