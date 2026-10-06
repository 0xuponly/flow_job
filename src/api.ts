import type { AIQueueBlockedState } from './queueBlocked'
import type { ProviderSpend } from './providerSpend'
import type {
  ApiModelConfig,
  Application,
  CreateJobInput,
  DashboardStats,
  Document,
  FitSource,
  FollowUp,
  Interview,
  Job,
  JobStatus,
  KeywordResult,
  NotificationRow,
  NotificationSource,
  NotificationJobContext,
  QueueItemView,
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
  createJob: (input: CreateJobInput) => Promise<{ job: Job; wasBlacklisted: boolean }>
  updateJob: (id: number, fields: Partial<CreateJobInput & { status: JobStatus; fit_source: FitSource; fit_last_error: string | null; fit_error_toasted: string | null }>) => Promise<Job>
  deleteJob: (id: number) => Promise<void>
  deleteJobs: (ids: number[]) => Promise<{ requested: number; deleted: number; missingFromStore: number[]; stillPresentAfterFilter: number[] }>
  dedupeJobs: () => Promise<{ removedIds: number[]; remaining: number }>
  searchJobs: (query: string) => Promise<Job[]>
  importJobFromUrl: (url: string) => Promise<{ job: Job; wasBlacklisted: boolean }>
  openQuickAddWindow: () => Promise<void>
  scanBoards: (filters?: ScanFilters) => Promise<ScanResult>
  cancelScan: () => Promise<void>
  cancelImport: () => Promise<void>
  recomputeFit: (id: number) => Promise<Job>
  retrofitLocations: () => Promise<{ updated: number; total: number }>
  backfillJobDates: () => Promise<number>
  listDocuments: (jobId?: number) => Promise<Document[]>
  createDocument: (type: 'cv' | 'cover_letter', title: string, content: string, jobId?: number) => Promise<Document>
  updateDocument: (id: number, title: string, content: string) => Promise<Document>
  deleteDocument: (id: number) => Promise<void>
  exportDocumentPdf: (title: string, content: string, docType: string, documentId: number | null, company?: string, position?: string) => Promise<string | null>
  extractJobKeywords: (jobId: number) => Promise<KeywordResult>
  refineJobKeywords: (jobId: number) => Promise<KeywordResult>
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
  // The automatic twins of the two above. A button reaches `tailorDocument`
  // / `verifyDocument`; the job page's mount sweep reaches these, so they
  // spend the app's budget rather than the user's and their rows obey the
  // `auto_queue_*` switches. `queued` is a boolean here rather than the
  // literal `true` because an automatic row can be refused by its switch —
  // in which case nothing was queued, and the caller must not report that
  // it was. See electron/main.ts `reviewDocument`.
  autoTailorDocument: (request: TailorRequest) => Promise<TailorResult | { queued: boolean }>
  autoVerifyDocument: (jobId: number, documentId: number, docType: 'cv' | 'cover_letter') => Promise<VerificationResult | { queued: boolean }>
  regenerateSection: (documentId: number, sectionName: string, jobId: number, extraContext?: string) => Promise<string | { queued: true }>
  queueList: () => Promise<Job[]>
  queueMarkSubmitted: (jobId: number, submittedAt?: number) => Promise<void>
  queueMarkResponse: (jobId: number, responseAt?: number) => Promise<void>
  tailorQuickApply: (jobId: number) => Promise<{ queued: true }>
  getScanStatus: () => Promise<ScanStatus>
  getScanEstimate: (boardNames: string[]) => Promise<number | null>
  clearScanResult: () => Promise<void>
  onScanProgress: (cb: (msg: string) => void) => () => void
  onScanCounters: (cb: (counters: { totalFound: number; totalAdded: number; totalSkipped: number; totalIncompatible: number; totalErrors: number }) => void) => () => void
  onScanComplete: (cb: (result: ScanResult) => void) => () => void
  onJobScoreUpdated: (cb: (job: Job) => void) => () => void
  onJobImported: (cb: (job: Job) => void) => () => void
  clearSeenUrls: () => Promise<void>
  clearAllData: () => Promise<void>
  openExternal: (url: string) => Promise<void>
  getSecurityStatus: () => Promise<{ mode: 'sealed' | 'plaintext-fallback' | 'uninitialized' }>
// Every queue-returning call resolves to `QueueItemView[]`, the
  // enriched pick-order view. It is a view type rather than
  // `AIQueueItem[]` because the panel renders jobTitle / jobCompany from
  // every row it is handed, and because the renderer replaces its entire
  // list with each response: a handler that answered with raw store rows
  // blanked the title on all the OTHER rows. Typing the returns as the
  // view makes that shape a compile error instead.
  listAIQueue: () => Promise<QueueItemView[]>
  // One app-wide answer to "can this app spend a request at all?", not a
  // per-row flag: no provider being available is a property of the model
  // pool. See src/queueBlocked.ts for what it may and may not display.
  aiQueueBlocked: () => Promise<AIQueueBlockedState>
  // What each AI provider has spent in the rolling 24h window, against the
  // cap the user set. One row per provider credential, because the cap is
  // applied per credential; the count is the ledger the cap itself reads, and
  // it is the number the Auto-queue tab renders beside the cap input. Rejects
  // rather than answering with zeros: a read that failed must not render as a
  // provider that has spent nothing.
  providerSpend: () => Promise<ProviderSpend[]>
  listBoards: () => Promise<{ name: string; useBrowser: boolean; enabled: boolean }[]>
  getBoardHealth: () => Promise<Record<string, number[]>>
  retryAIQueueItem: (id: number) => Promise<QueueItemView[]>
  removeAIQueueItem: (id: number) => Promise<QueueItemView[]>
  clearAIQueue: () => Promise<{ removed: number; queue: QueueItemView[] }>
  listBlacklistedCompanies: () => Promise<string[]>
  addBlacklistedCompany: (name: string) => Promise<string[]>
  removeBlacklistedCompany: (name: string) => Promise<string[]>
  pickBackupFolder: () => Promise<{ path: string; warning: string | null } | null>
  runBackup: (dir: string, passphrase?: string) => Promise<{ ok: boolean; path?: string; error?: string }>
  getBackupStatus: () => Promise<{ path: string; lastSuccessAt: string; lastError: string }>
  listBackups: () => Promise<{ name: string; path: string; createdAt: string }[]>
  restoreBackup: (folderPath: string, passphrase?: string) => Promise<{ ok: boolean; path?: string; error?: string; warning?: string }>
  previewBackup: (folderPath: string) => Promise<{
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
  } | null>
  // Notification center — 6 typed wrappers. Return shapes are
  // re-strict-typed here (not loose) so the renderer can pattern-match
  // on the INTERNAL sentinel at the call site without a cast. The
  // actual implementation in preload.ts is `window.api.X(params)`
  // dispatched via the contextBridge.
  notificationsAdd: (params: { type: string; source?: NotificationSource; message: string; full_message: string; group_key?: string; job?: NotificationJobContext }) =>
    Promise<{ id: number } | { error: 'INTERNAL' }>
  // The error arm is load-bearing, not decoration. `{ rows: [] }` is the
  // answer to "the store is empty", and a read that failed has to be able
  // to say so — otherwise the drawer cannot tell an empty center from one
  // it could not load, and it renders the empty one.
  //
  // `unreadable` is the other half of the same obligation: entries the
  // store had to discard because they were not rows. Required rather than
  // optional because the provider coerces it anyway — a main-process build
  // older than this omits it, and one number the renderer has to defend
  // against is one number fewer place for the two sides to disagree.
  notificationsList: () => Promise<{ rows: NotificationRow[]; unreadable: number } | { error: 'INTERNAL' }>
  notificationsDismiss: (params: { id: number }) => Promise<{ ok: true } | { error: 'INTERNAL' }>
  // Bulk, because the center collapses rows into groups and "dismiss this
  // group" is one user action over N rows — not N actions.
  notificationsDismissMany: (params: { ids: number[] }) => Promise<{ updated: number } | { error: 'INTERNAL' }>
  notificationsDismissAll: () => Promise<{ updated: number } | { error: 'INTERNAL' }>
  notificationsPurgeOldDismissed: () => Promise<{ deleted: number }>
  // Fired when the MAIN process writes a record, which today means an
  // uncaughtException. There is no renderer at that point to fire the
  // window event record.ts uses, so without this channel a crash is in
  // the store and nothing tells the app it is there.
  onNotificationsChanged: (cb: () => void) => () => void
  onMainError: (cb: (message: string) => void) => () => void
}

declare global {
  interface Window {
    api: Api
  }
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
