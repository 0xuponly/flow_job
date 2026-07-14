import { contextBridge, ipcRenderer } from 'electron'
import type {
  AIQueueItem,
  ApiModelConfig,
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
  deleteJobs: (ids: number[]) => Promise<void>
  searchJobs: (query: string) => Promise<Job[]>
  importJobFromUrl: (url: string) => Promise<Job>
  scanBoards: (filters?: ScanFilters) => Promise<ScanResult>
  batchScore: () => Promise<{ updated: number }>
  recomputeFit: (id: number) => Promise<Job>
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
  cancelScan: () => Promise<void>
  cancelImport: () => Promise<void>
  onScanProgress: (cb: (msg: string) => void) => () => void
  onScanComplete: (cb: (result: ScanResult) => void) => () => void
  clearSeenUrls: () => Promise<void>
  clearAllData: () => Promise<void>
  exportAllData: () => Promise<string | null>
  retrofitLocations: () => Promise<{ updated: number; total: number }>
  listAIQueue: () => Promise<AIQueueItem[]>
  listBoards: () => Promise<{ name: string; useBrowser: boolean }[]>
  getBoardHealth: () => Promise<Record<string, number[]>>
  retryAIQueueItem: (id: number) => Promise<AIQueueItem[]>
  removeAIQueueItem: (id: number) => Promise<AIQueueItem[]>
  openExternal: (url: string) => Promise<void>
  getSecurityStatus: () => Promise<{ mode: 'sealed' | 'plaintext-fallback' | 'uninitialized' }>
  listBlacklistedCompanies: () => Promise<string[]>
  addBlacklistedCompany: (name: string) => Promise<string[]>
  removeBlacklistedCompany: (name: string) => Promise<string[]>
}

const api: Api = {
  getDashboardStats: () => ipcRenderer.invoke('dashboard:stats'),
  listJobs: (status) => ipcRenderer.invoke('jobs:list', status),
  getJob: (id) => ipcRenderer.invoke('jobs:get', id),
  createJob: (input) => ipcRenderer.invoke('jobs:create', input),
  updateJob: (id, fields) => ipcRenderer.invoke('jobs:update', id, fields),
  deleteJob: (id) => ipcRenderer.invoke('jobs:delete', id),
  deleteJobs: (ids) => ipcRenderer.invoke('jobs:deleteMany', ids),
  searchJobs: (query) => ipcRenderer.invoke('jobs:search', query),
  importJobFromUrl: (url) => ipcRenderer.invoke('jobs:importFromUrl', url),
  scanBoards: (filters) => ipcRenderer.invoke('jobs:scanBoards', filters),
  batchScore: () => ipcRenderer.invoke('jobs:batchScore'),
  recomputeFit: (id) => ipcRenderer.invoke('jobs:recomputeFit', id),
  backfillJobDates: () => ipcRenderer.invoke('jobs:backfillDates'),
  getScanStatus: () => ipcRenderer.invoke('scan:status'),
  clearScanResult: () => ipcRenderer.invoke('scan:clearResult'),
  cancelScan: () => ipcRenderer.invoke('scan:cancel'),
  cancelImport: () => ipcRenderer.invoke('import:cancel'),
  onScanProgress: (cb: (msg: string) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, msg: string) => cb(msg)
    ipcRenderer.on('scan:progress', handler)
    return () => ipcRenderer.removeListener('scan:progress', handler)
  },
  onScanComplete: (cb: (result: ScanResult) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, result: ScanResult) => cb(result)
    ipcRenderer.on('scan:complete', handler)
    return () => ipcRenderer.removeListener('scan:complete', handler)
  },
  listDocuments: (jobId) => ipcRenderer.invoke('documents:list', jobId),
  createDocument: (type, title, content, jobId) =>
    ipcRenderer.invoke('documents:create', type, title, content, jobId),
  updateDocument: (id, title, content) => ipcRenderer.invoke('documents:update', id, title, content),
  deleteDocument: (id) => ipcRenderer.invoke('documents:delete', id),
  exportDocumentPdf: (title, content, docType, company, position) => ipcRenderer.invoke('documents:exportPdf', title, content, docType, company, position),
  listApplications: () => ipcRenderer.invoke('applications:list'),
  getOrCreateApplication: (jobId) => ipcRenderer.invoke('applications:getOrCreate', jobId),
  updateApplication: (id, fields) => ipcRenderer.invoke('applications:update', id, fields),
  markApplied: (id, method, email, name) =>
    ipcRenderer.invoke('applications:markApplied', id, method, email, name),
  listFollowUps: (includeCompleted) => ipcRenderer.invoke('followUps:list', includeCompleted),
  createFollowUp: (appId, dueDate, type, message) =>
    ipcRenderer.invoke('followUps:create', appId, dueDate, type, message),
  completeFollowUp: (id) => ipcRenderer.invoke('followUps:complete', id),
  generateFollowUpMessage: (company, title, days) =>
    ipcRenderer.invoke('followUps:generateMessage', company, title, days),
  listInterviews: (upcomingOnly) => ipcRenderer.invoke('interviews:list', upcomingOnly),
  createInterview: (appId, scheduledAt, type, duration, location, interviewer, notes) =>
    ipcRenderer.invoke('interviews:create', appId, scheduledAt, type, duration, location, interviewer, notes),
  updateInterview: (id, fields) => ipcRenderer.invoke('interviews:update', id, fields),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateSettings: (partial) => ipcRenderer.invoke('settings:update', partial),
  resetSettings: () => ipcRenderer.invoke('settings:reset'),
  listApiModels: () => ipcRenderer.invoke('models:list'),
  saveApiModels: (models) => ipcRenderer.invoke('models:save', models),
  addApiModel: (model) => ipcRenderer.invoke('models:add', model),
  deleteApiModel: (id) => ipcRenderer.invoke('models:delete', id),
  tailorDocument: (request) => ipcRenderer.invoke('ai:tailor', request),
  verifyDocument: (jobId, documentId, docType) => ipcRenderer.invoke('documents:verify', jobId, documentId, docType),
  regenerateSection: (documentId, sectionName, jobId, extraContext) =>
    ipcRenderer.invoke('documents:regenerateSection', documentId, sectionName, jobId, extraContext),
  clearSeenUrls: () => ipcRenderer.invoke('db:clearSeenUrls'),
  clearAllData: () => ipcRenderer.invoke('db:clearAllData'),
  exportAllData: () => ipcRenderer.invoke('db:exportAll'),
  retrofitLocations: () => ipcRenderer.invoke('db:retrofitLocations'),
  listAIQueue: () => ipcRenderer.invoke('aiQueue:list'),
  listBoards: () => ipcRenderer.invoke('boards:list'),
  getBoardHealth: () => ipcRenderer.invoke('boards:health'),
  retryAIQueueItem: (id) => ipcRenderer.invoke('aiQueue:retry', id),
  removeAIQueueItem: (id) => ipcRenderer.invoke('aiQueue:remove', id),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  getSecurityStatus: () => ipcRenderer.invoke('security:status'),
  listBlacklistedCompanies: () => ipcRenderer.invoke('blacklist:list'),
  addBlacklistedCompany: (name) => ipcRenderer.invoke('blacklist:add', name),
  removeBlacklistedCompany: (name) => ipcRenderer.invoke('blacklist:remove', name)
}

contextBridge.exposeInMainWorld('api', api)
