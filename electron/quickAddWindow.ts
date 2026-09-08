import { BrowserWindow } from 'electron'
import { join } from 'path'

let quickAddWindow: BrowserWindow | null = null

export function openQuickAddWindow(): void {
  if (quickAddWindow && !quickAddWindow.isDestroyed()) {
    if (quickAddWindow.isMinimized()) quickAddWindow.restore()
    quickAddWindow.focus()
    return
  }

  quickAddWindow = new BrowserWindow({
    width: 420,
    height: 140,
    minWidth: 320,
    minHeight: 120,
    alwaysOnTop: true,
    title: 'Add job by URL',
    backgroundColor: '#0f1117',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  quickAddWindow.on('closed', () => {
    quickAddWindow = null
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    quickAddWindow.loadURL(`${process.env.ELECTRON_RENDERER_URL}/quickadd.html`)
  } else {
    quickAddWindow.loadFile(join(__dirname, '../renderer/quickadd.html'))
  }
}
