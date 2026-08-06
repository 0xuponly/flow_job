// electron/stderrFilter.ts
//
// Terminal-hygiene choke point for the main process. Intercepts
// process.stderr.write and:
//   1. captures Electron's IPC-handler rejection dumps
//      ("Error occurred in handler for '<channel>': <error>" + stack,
//      written as a single chunk) into logs/ipc.log,
//   2. captures known-harmless Chromium stderr noise into
//      logs/stderr.log,
//   3. passes every other line through unchanged so real errors stay
//      visible.
//
// The IPC-rejection dump is Electron logging a rejected
// ipcMain.handle() promise. The renderer already catches those
// rejections and surfaces them as toasts; the terminal dump is pure
// noise. Set FLOW_JOB_VERBOSE=1 to bypass all capture.

import { createLogger } from './logger'

const IPC_ERROR_PREFIX = 'Error occurred in handler for '

// Pattern set grows as new harmless Chromium/Camoufox messages are
// observed. Each pattern is annotated with its source.
const NOISE_PATTERNS: readonly RegExp[] = [
  // content/common/debug_utils.cc — transient browser-vs-renderer
  // origin mismatch during the initial about:blank load of a new
  // BrowserWindow. Electron issue #44368, closed NOT_PLANNED.
  /Hit debug scenario: \d+/,
  // content/renderer/media/webrtc/socket_manager.cc — Chromium's WebRTC
  // stack resolves a default STUN list for ICE gathering even though the
  // app never uses WebRTC. Safe to ignore.
  /Failed to resolve address for stun\.[^\s,]+\.?, errorcode: -?\d+/
]

export interface StderrFilterOptions {
  /** Where ipc.log / stderr.log are written. Defaults to <userData>/logs/. */
  logDir?: string
  /** When true, capture nothing — every chunk passes through. */
  verbose?: boolean
}

export function createStderrFilter(opts: StderrFilterOptions = {}) {
  const { verbose = !!process.env.FLOW_JOB_VERBOSE, logDir } = opts
  const ipcLog = logDir ? createLogger('ipc', logDir) : createLogger('ipc')
  const stderrLog = logDir ? createLogger('stderr', logDir) : createLogger('stderr')

  return {
    handle(chunk: string | Buffer): boolean {
      if (verbose) return false
      const s = typeof chunk === 'string' ? chunk : chunk.toString('utf-8')
      if (s.includes(IPC_ERROR_PREFIX)) {
        ipcLog.info(s.replace(/\r?\n$/, ''))
        return true
      }
      for (const re of NOISE_PATTERNS) {
        if (re.test(s)) {
          stderrLog.info(s.replace(/\r?\n$/, ''))
          return true
        }
      }
      return false
    }
  }
}

/**
 * Install the filter on process.stderr.write. No-op when
 * FLOW_JOB_VERBOSE is set. Call once at main-process startup.
 */
export function installStderrFilter(): void {
  if (process.env.FLOW_JOB_VERBOSE) return
  const { handle } = createStderrFilter()
  const origWrite = process.stderr.write.bind(process.stderr)
  ;(process.stderr as NodeJS.WriteStream).write = ((chunk: string | Buffer, ...rest: unknown[]) => {
    if (!handle(chunk)) {
      return (origWrite as (c: string | Buffer, ...a: unknown[]) => boolean)(chunk, ...(rest as []))
    }
    return true
  }) as typeof process.stderr.write
}
