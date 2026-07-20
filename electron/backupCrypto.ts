import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual
} from 'crypto'
import { appendFileSync, existsSync, renameSync, statSync } from 'fs'
import { join, sep } from 'path'

// KDF parameters. N=2^15 with r=8, p=1 is the OWASP recommendation
// for interactive scrypt use as of 2024; maxmem is set explicitly to
// avoid ERR_CRYPTO_SCRYPT_INVALID_PARAMS on memory-constrained hosts.
const SCRYPT_N = 1 << 15
const SCRYPT_R = 8
const SCRYPT_P = 1
const SCRYPT_KEYLEN = 64 // 32 for wrap + 32 for HMAC
const SCRYPT_MAXMEM = 64 * 1024 * 1024
const SALT_LEN = 16
const IV_LEN = 12
const GCM_TAG_LEN = 16

// Audit log rotates when it exceeds 1 MiB.
const AUDIT_MAX_BYTES = 1024 * 1024

export interface KdfParams {
  alg: 'scrypt'
  N: number
  r: number
  p: number
  salt: string // base64
  iv: string // base64
  wrapIv: string // base64 — separate IV for DEK wrap so the wrap and
                 // data-encryption IVs never overlap
}

export interface WrappedDek {
  /** base64 of iv(12) || tag(16) || ciphertext(32) */
  wrapped: string
  kdf: KdfParams
}

export interface AuditEvent {
  event:
    | 'backup.start'
    | 'backup.success'
    | 'backup.failed'
    | 'restore.success'
    | 'restore.failed'
    | 'restore.refused'
  folder: string
  outcome: string
}

// --- Passphrase -> keys ------------------------------------------------

function deriveKeys(passphrase: string, salt: Buffer): { wrap: Buffer; hmac: Buffer } {
  // 64 bytes: first 32 for DEK wrap (AES-256-GCM), second 32 for
  // manifest HMAC (SHA-256). Domain separation by halving the
  // output is sufficient because both halves are independently
  // uniformly random.
  const combined = scryptSync(Buffer.from(passphrase, 'utf-8'), salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM
  })
  return {
    wrap: combined.subarray(0, 32),
    hmac: combined.subarray(32, 64)
  }
}

// --- DEK wrap / unwrap -------------------------------------------------

export function wrapDekWithPassphrase(dek: Buffer, passphrase: string): WrappedDek {
  if (dek.length !== 32) {
    throw new Error('DEK must be 32 bytes')
  }
  const salt = randomBytes(SALT_LEN)
  const { wrap } = deriveKeys(passphrase, salt)
  const iv = randomBytes(IV_LEN)
  const cipher = createCipheriv('aes-256-gcm', wrap, iv)
  const ct = Buffer.concat([cipher.update(dek), cipher.final()])
  const tag = cipher.getAuthTag()
  return {
    wrapped: Buffer.concat([iv, tag, ct]).toString('base64'),
    kdf: {
      alg: 'scrypt',
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
      salt: salt.toString('base64'),
      iv: iv.toString('base64'),
      wrapIv: iv.toString('base64')
    }
  }
}

export function unwrapDekWithPassphrase(wrapped: WrappedDek, passphrase: string): Buffer {
  const buf = Buffer.from(wrapped.wrapped, 'base64')
  if (buf.length !== IV_LEN + GCM_TAG_LEN + 32) {
    throw new Error('Wrapped DEK has unexpected length')
  }
  const iv = buf.subarray(0, IV_LEN)
  const tag = buf.subarray(IV_LEN, IV_LEN + GCM_TAG_LEN)
  const ct = buf.subarray(IV_LEN + GCM_TAG_LEN)
  const salt = Buffer.from(wrapped.kdf.salt, 'base64')
  const { wrap } = deriveKeys(passphrase, salt)
  const decipher = createDecipheriv('aes-256-gcm', wrap, iv)
  decipher.setAuthTag(tag)
  try {
    const dek = Buffer.concat([decipher.update(ct), decipher.final()])
    if (dek.length !== 32) throw new Error('Unwrapped DEK has unexpected length')
    return dek
  } catch {
    // GCM auth failure: wrong passphrase or tampered ciphertext.
    throw new Error('Wrong passphrase or tampered backup')
  }
}

// --- Manifest HMAC ----------------------------------------------------

/**
 * Canonical JSON: sort keys at every level so the HMAC is stable
 * regardless of property insertion order.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']'
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(obj[k])).join(',') + '}'
}

export function signManifest(manifest: Record<string, unknown>, passphrase: string, kdf: KdfParams): string {
  const salt = Buffer.from(kdf.salt, 'base64')
  const { hmac } = deriveKeys(passphrase, salt)
  return createHmac('sha256', hmac).update(canonicalJson(manifest)).digest('base64')
}

export function verifyManifest(
  manifest: Record<string, unknown>,
  expectedHmac: string,
  passphrase: string,
  kdf: KdfParams
): boolean {
  const salt = Buffer.from(kdf.salt, 'base64')
  const { hmac } = deriveKeys(passphrase, salt)
  const computed = createHmac('sha256', hmac).update(canonicalJson(manifest)).digest('base64')
  const a = Buffer.from(computed, 'base64')
  const b = Buffer.from(expectedHmac, 'base64')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

// --- Synced-folder detection -----------------------------------------

const SYNC_PROVIDERS = [
  'iCloud Drive',
  'iCloud Drive (Archive)',
  'Dropbox',
  'Google Drive',
  'OneDrive',
  'Box',
  'pCloud',
  'Sync.com',
  'Mega'
]

/**
 * Splits a path into its segments using both / and \ so the check
 * works on POSIX and Windows paths.
 */
function splitSegments(p: string): string[] {
  return p.split(/[\\/]+/).filter(Boolean)
}

export interface SyncedFolderInfo {
  synced: boolean
  providers: string[]
}

export function detectSyncedFolder(folderPath: string): SyncedFolderInfo {
  const segments = new Set(splitSegments(folderPath))
  const providers: string[] = []
  for (const provider of SYNC_PROVIDERS) {
    if (segments.has(provider)) providers.push(provider)
  }
  return { synced: providers.length > 0, providers }
}

// --- Append-only audit log --------------------------------------------

// Lazy backup logger. Lives here (not imported at module top) so the
// electron `app` import is only resolved if audit fails — the happy
// path of a successful backup never touches it.
let _backupLog: ReturnType<typeof createLogger> | undefined
function writeBackupLog(level: 'info' | 'warn' | 'error', msg: string): void {
  try {
    if (!_backupLog) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { createLogger } = require('./logger') as typeof import('./logger')
      _backupLog = createLogger('backup')
    }
    _backupLog[level](msg)
  } catch {
    // Last-resort: silently swallow. We must not throw from audit.
  }
}

/**
 * Append a single line to <parentDir>/backup.log. If the file is
 * bigger than 1 MiB before the write, rotate to backup.log.1 (single
 * generation — adequate for the volume this app produces). Never
 * throws: audit failures must not break the user's backup/restore.
 */
export function appendAudit(parentDir: string, evt: AuditEvent): void {
  try {
    const logPath = join(parentDir, 'backup.log')
    // Rotation precheck. existsSync/statSync can fail with EPERM on
    // macOS when the parent dir is TCC-restricted for reads even
    // though writes are allowed (which is exactly the case for
    // ~/Documents in a default install). When that happens, the
    // append would still succeed — so on any precheck error, just
    // skip the rotation and let appendFileSync try.
    let shouldRotate = false
    try {
      shouldRotate =
        existsSync(logPath) && statSync(logPath).size > AUDIT_MAX_BYTES
    } catch {
      shouldRotate = false
    }
    if (shouldRotate) {
      try {
        renameSync(logPath, logPath + '.1')
      } catch {
        // ignore — try the append anyway
      }
    }
    const ts = new Date().toISOString()
    const line = `${ts} ${evt.event} ${evt.folder} ${evt.outcome}\n`
    appendFileSync(logPath, line, { encoding: 'utf-8' })
  } catch (err) {
    // Audit must never break the backup/restore. The append itself
    // is the source of truth; if it failed, surface to <userData>/logs
    // via the backup logger rather than the terminal, which the
    // user has explicitly asked us to keep clean.
    const msg = err instanceof Error ? err.message : String(err)
    writeBackupLog('error', `audit log write failed: ${msg}`)
  }
}
