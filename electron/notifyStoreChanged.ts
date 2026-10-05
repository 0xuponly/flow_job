import { BrowserWindow } from 'electron'
import { log } from './logger'

/**
 * Tell every live window that the store's notification list changed.
 *
 * All windows, not the focused one. This carries no content at all — "go and
 * look" — and what it lights up is each window's own unread badge, which is
 * correct in every window regardless of which one is focused. Sending it to
 * only the focused window would mean a record written while quick-add is in
 * front left the main window's badge dark, which is the original hole: the
 * main window is the one that can show it.
 *
 * It lives in its own module, and not in `main.ts`, for the one reason that
 * matters here: a record written by the main process is invisible until a
 * window is told, so every main-process writer needs this, and `main.ts`
 * already imports `aiQueue.ts`. Keeping it here lets the queue ping for its
 * own records without the two modules importing each other.
 *
 * Never throws. `send` on a window whose renderer has gone raises, and this
 * is called from inside `uncaughtException` — where a second throw replaces
 * the crash the user is being told about with a crash they are not — and
 * from the queue, where a throw would abort a pass. So the whole body is
 * guarded, including `getAllWindows` itself: this is also reached under test,
 * where `electron` is a hand-written mock and may not carry `BrowserWindow`
 * at all.
 */
export function notifyStoreChanged(): void {
  try {
    for (const w of BrowserWindow?.getAllWindows?.() ?? []) {
      try {
        if (!w.isDestroyed() && !w.webContents.isDestroyed()) {
          w.webContents.send('notifications:changed')
        }
      } catch (err) {
        log.crash.error(`could not announce a new notification record: ${String(err)}`)
      }
    }
  } catch (err) {
    log.crash.error(`could not announce a new notification record: ${String(err)}`)
  }
}