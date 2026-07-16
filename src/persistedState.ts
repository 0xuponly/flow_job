// Small localStorage-backed useState wrapper. Used by UI state that
// should survive tab switches and app restarts (e.g. the scan-page
// form fields, so the user doesn't lose their keywords/location/
// board selection when they navigate to another tab and back, or
// close and reopen the app).
//
// The hook is renderer-only and synchronous: writes happen on every
// set, reads happen on mount. If localStorage is unavailable
// (disabled by the user, or running outside the browser), it falls
// back to plain useState with a console warning.
import { useEffect, useRef, useState } from 'react'

const STORAGE_PREFIX = 'flow_job:'

function readFromStorage<T>(key: string, fallback: T): T {
  try {
    if (typeof localStorage === 'undefined') return fallback
    const raw = localStorage.getItem(STORAGE_PREFIX + key)
    if (raw === null) return fallback
    return JSON.parse(raw) as T
  } catch (err) {
    // JSON parse failure or storage access denied — fall through to
    // the default value rather than crashing the page.
    console.warn(`[persistedState] failed to read ${key}:`, err)
    return fallback
  }
}

function writeToStorage<T>(key: string, value: T): void {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(value))
  } catch (err) {
    // Quota exceeded, storage disabled, etc. Swallow — the in-memory
    // state still works for this session, we just won't persist.
    console.warn(`[persistedState] failed to write ${key}:`, err)
  }
}

/**
 * useState whose value is mirrored to localStorage under the given
 * key. Initial value is loaded from storage on mount; subsequent
 * updates are written through. If the key was never set, the
 * `fallback` is used and persisted on the first update.
 *
 * Pass a `version` to invalidate stale persisted values. If the
 * stored value's `__v` doesn't match the current version, the
 * `fallback` is used and the new value is written on the next
 * update. Use this when the schema of the persisted shape changes.
 */
export function usePersistedState<T>(
  key: string,
  fallback: T,
  version?: number
): [T, (next: T | ((prev: T) => T)) => void, () => void] {
  const [value, setValue] = useState<T>(() => {
    if (version === undefined) return readFromStorage<T>(key, fallback)
    const raw = (() => {
      try {
        return typeof localStorage === 'undefined' ? null : localStorage.getItem(STORAGE_PREFIX + key)
      } catch {
        return null
      }
    })()
    if (raw === null) return fallback
    try {
      const parsed = JSON.parse(raw) as { __v?: number; value?: T }
      if (parsed.__v !== version) return fallback
      return parsed.value ?? fallback
    } catch {
      return fallback
    }
  })

  // Track the latest version so writes include the right marker.
  const versionRef = useRef(version)
  useEffect(() => {
    versionRef.current = version
  }, [version])

  // Persist on every value change. The write is synchronous and
  // cheap; useEffect with `value` in deps is the canonical hook.
  useEffect(() => {
    if (version === undefined) {
      writeToStorage(key, value)
    } else {
      writeToStorage(key, { __v: version, value })
    }
  }, [key, value, version])

  const reset = () => {
    setValue(fallback)
    try {
      if (typeof localStorage !== 'undefined') localStorage.removeItem(STORAGE_PREFIX + key)
    } catch {
      // ignore
    }
  }

  return [value, setValue, reset]
}
