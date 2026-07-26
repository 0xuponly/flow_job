import { getSettings } from './database'
import { scanAllBoards } from './jobSearch'
import type { ScanResult } from './types'
import { timerDeadlineMs } from './utils'

let timer: NodeJS.Timeout | null = null
let timerStartedAt = 0
let timerDelayMs = 0
let lastScanCompletedAt: number | null = null
let running = false

function clearTimer() {
  if (timer) {
    clearTimeout(timer)
    timer = null
    timerStartedAt = 0
    timerDelayMs = 0
  }
}

/**
 * Schedule the next auto-scan based on the user's configured interval.
 * The interval starts counting from the last completed scan (or now if no
 * scan has ever run). Each call replaces the previous schedule.
 */
export function scheduleNextAutoScan(afterCompletedAt: number | null = lastScanCompletedAt) {
  clearTimer()
  const settings = getSettings()
  if (!settings.auto_scan_enabled) return
  const minutes = Math.max(1, settings.auto_scan_interval_minutes || 120)
  const ms = minutes * 60 * 1000
  const base = afterCompletedAt ?? Date.now()
  const delay = Math.max(0, base + ms - Date.now())
  timer = setTimeout(runAutoScan, delay)
  timerStartedAt = Date.now()
  timerDelayMs = delay
}

export function cancelAutoScan() {
  clearTimer()
}

export function markScanCompleted() {
  lastScanCompletedAt = Date.now()
  scheduleNextAutoScan()
}

export function markScanStarted() {
  lastScanCompletedAt = null
  // When a scan starts, pause the auto-scan timer until it completes
  clearTimer()
}

export function restartAutoScanTimer() {
  // Re-read settings and reschedule (used when settings change)
  scheduleNextAutoScan()
}

export function getAutoScanState(): { enabled: boolean; intervalMinutes: number; lastCompletedAt: number | null; nextRunAt: number | null } {
  const settings = getSettings()
  return {
    enabled: settings.auto_scan_enabled,
    intervalMinutes: settings.auto_scan_interval_minutes,
    lastCompletedAt: lastScanCompletedAt,
    nextRunAt: timer ? timerDeadlineMs(timerStartedAt, timerDelayMs) : null
  }
}

async function runAutoScan() {
  if (running) return
  running = true
  try {
    // Run a scan with no per-run filters — all boards, all work types, all
    // locations (the user's saved preferred locations list is the
    // implicit filter; scanAllBoards reads it from settings).
    const result: ScanResult = await scanAllBoards(
      { workType: 'any' },
      (msg) => {
        // Forward progress to renderer so they can see what's happening
        const { BrowserWindow } = require('electron') as typeof import('electron')
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed()) {
            win.webContents.send('scan:progress', `[auto-scan] ${msg}`)
          }
        }
      }
    )
    lastScanCompletedAt = Date.now()
    // Notify renderer of completion
    const { BrowserWindow } = require('electron') as typeof import('electron')
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send('scan:progress', `[auto-scan] Complete: found ${result.totalFound}, added ${result.totalAdded}, skipped ${result.totalSkipped}`)
        win.webContents.send('scan:complete', result)
      }
    }
    scheduleNextAutoScan()
  } catch (err) {
    // Even on error, schedule the next run
    scheduleNextAutoScan()
  } finally {
    running = false
  }
}
