// File-backed category logger. Each category writes to its own
// <logDir>/<category>.log file, with size-based rotation (1 MiB max,
// single generation rotated to <category>.log.1). Mirrors the
// append-only pattern from backupCrypto.appendAudit so audit logs
// and category logs are consistent.
//
// Used in place of console.log / console.warn / console.error for
// the [scraper], [scanner], [fit], [startup], and [backup]
// categories — those were the source of noisy terminal output in
// dev mode. The terminal stays clean; the user can inspect logs
// under <userData>/logs/ when something goes wrong.

import { app } from 'electron'
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'fs'
import { join } from 'path'

const LOG_MAX_BYTES = 1 * 1024 * 1024 // 1 MiB per file

export type LogLevel = 'info' | 'warn' | 'error'

const LEVEL_PREFIX: Record<LogLevel, string> = {
  info: 'INFO ',
  warn: 'WARN ',
  error: 'ERROR'
}

export interface CategoryLogger {
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
  /** Where this logger writes to. Exposed for the Settings UI to
   * show the log file path so the user can find it. */
  readonly filePath: string
}

function getDefaultLogDir(): string {
  // app.getPath('userData') only resolves after app.setName has been
  // called; main.ts does that at module load. By the time any
  // logger.writeLog call actually happens, the userData path is
  // stable, so this is safe to call lazily here.
  return join(app.getPath('userData'), 'logs')
}

function formatArgs(args: unknown[]): string {
  return args
    .map((a) => {
      if (a instanceof Error) return a.stack || `${a.name}: ${a.message}`
      if (typeof a === 'string') return a
      try {
        return JSON.stringify(a)
      } catch {
        return String(a)
      }
    })
    .join(' ')
}

function writeLog(category: string, logDir: string, level: LogLevel, args: unknown[]): void {
  try {
    // Lazily create the logs directory on first write. Doing it in
    // the constructor (at app startup) would fail in environments
    // where userData is not yet available, so we defer.
    if (!existsSync(logDir)) {
      mkdirSync(logDir, { recursive: true })
    }
    const logPath = join(logDir, `${category}.log`)
    if (existsSync(logPath) && statSync(logPath).size > LOG_MAX_BYTES) {
      try {
        renameSync(logPath, logPath + '.1')
      } catch {
        // ignore — try the append anyway
      }
    }
    const ts = new Date().toISOString()
    const line = `${ts} ${LEVEL_PREFIX[level]} ${formatArgs(args)}\n`
    appendFileSync(logPath, line, { encoding: 'utf-8' })
  } catch (err) {
    // Logging must never break the caller. If the file write itself
    // fails (disk full, permission denied), fall through silently.
    // We intentionally do NOT console.error here — that would defeat
    // the purpose of moving logs out of the terminal.
  }
}

/**
 * Create a logger for the given category. If `logDir` is omitted,
 * the logger writes to `<userData>/logs/<category>.log` (the
 * default). Pass an explicit `logDir` only for tests or for
 * directing a specific category to a non-standard location.
 */
export function createLogger(category: string, logDir?: string): CategoryLogger {
  const dir = logDir ?? getDefaultLogDir()
  return {
    filePath: join(dir, `${category}.log`),
    info: (...args) => writeLog(category, dir, 'info', args),
    warn: (...args) => writeLog(category, dir, 'warn', args),
    error: (...args) => writeLog(category, dir, 'error', args)
  }
}
