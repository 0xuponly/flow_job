import { contextBridge, ipcRenderer } from 'electron'
import type {
  Application,
  CreateJobInput,
  DashboardStats,
  Document,
  FollowUp,
  Interview,
  Job,
  JobStatus,
  Settings,
  TailorRequest,
  TailorResult
} from './types'

export interface Api {
  getDashboardStats: () => Promise<DashboardStats>
  listJobs: (status?: JobStatus) => Promise<Job[]>
  getJob: (id: number) => Promise<Job | undefined>
  createJob: (input: CreateJobInput) => Promise<Job>
  updateJob: (id: number, fields: Partial<CreateJobInput & { status: JobStatus }>) => Promise<Job>
  deleteJob: (id: number) => Promise<void>
  searchJobs: (query: string) => Promise<Job[]>
  importJobFromUrl: (url: string) => Promise<Job>
  listDocuments: (jobId?: number) => Promise<Document[]>
  createDocument: (type: 'cv' | 'cover_letter', title: string, content: string, jobId?: number) => Promise<Document>
  updateDocument: (id: number, title: string, content: string) => Promise<Document>
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
  tailorDocument: (request: TailorRequest) => Promise<TailorResult>
  openExternal: (url: string) => Promise<void>
}

const api: Api = {
  getDashboardStats: () => ipcRenderer.invoke('dashboard:stats'),
  listJobs: (status) => ipcRenderer.invoke('jobs:list', status),
  getJob: (id) => ipcRenderer.invoke('jobs:get', id),
  createJob: (input) => ipcRenderer.invoke('jobs:create', input),
  updateJob: (id, fields) => ipcRenderer.invoke('jobs:update', id, fields),
  deleteJob: (id) => ipcRenderer.invoke('jobs:delete', id),
  searchJobs: (query) => ipcRenderer.invoke('jobs:search', query),
  importJobFromUrl: (url) => ipcRenderer.invoke('jobs:importFromUrl', url),
  listDocuments: (jobId) => ipcRenderer.invoke('documents:list', jobId),
  createDocument: (type, title, content, jobId) =>
    ipcRenderer.invoke('documents:create', type, title, content, jobId),
  updateDocument: (id, title, content) => ipcRenderer.invoke('documents:update', id, title, content),
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
  tailorDocument: (request) => ipcRenderer.invoke('ai:tailor', request),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url)
}

contextBridge.exposeInMainWorld('api', api)
