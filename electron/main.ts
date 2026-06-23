import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { join } from 'path'
import * as db from './database'
import { tailorDocument, generateFollowUpMessage } from './ai'
import { scrapeJobFromUrl } from './jobScraper'
import type {
  Application,
  CreateJobInput,
  FollowUp,
  Interview,
  JobStatus,
  Settings,
  TailorRequest
} from './types'

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    show: false,
    title: 'Apply Assistant',
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0f1117',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
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

  ipcMain.handle('jobs:list', (_e, status?: JobStatus) => db.listJobs(status))
  ipcMain.handle('jobs:get', (_e, id: number) => db.getJob(id))
  ipcMain.handle('jobs:create', (_e, input: CreateJobInput) => db.createJob(input))
  ipcMain.handle('jobs:update', (_e, id: number, fields: Partial<CreateJobInput & { status: JobStatus }>) =>
    db.updateJob(id, fields)
  )
  ipcMain.handle('jobs:delete', (_e, id: number) => db.deleteJob(id))
  ipcMain.handle('jobs:search', (_e, query: string) => db.searchJobs(query))
  ipcMain.handle('jobs:importFromUrl', async (_e, url: string) => {
    const input = await scrapeJobFromUrl(url)
    return db.createJob(input)
  })

  ipcMain.handle('documents:list', (_e, jobId?: number) => db.listDocuments(jobId))
  ipcMain.handle('documents:create', (_e, type: 'cv' | 'cover_letter', title: string, content: string, jobId?: number) =>
    db.createDocument(type, title, content, jobId)
  )
  ipcMain.handle('documents:update', (_e, id: number, title: string, content: string) =>
    db.updateDocument(id, title, content)
  )

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
  ipcMain.handle('settings:update', (_e, partial: Partial<Settings>) => db.updateSettings(partial))
  ipcMain.handle('settings:reset', () => db.resetSettings())

  ipcMain.handle('ai:tailor', async (_e, request: TailorRequest) => tailorDocument(request))

  ipcMain.handle('shell:openExternal', (_e, url: string) => shell.openExternal(url))
}

app.whenReady().then(() => {
  registerIpc()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
