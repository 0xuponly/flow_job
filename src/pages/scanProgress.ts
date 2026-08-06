// Lifecycle management for the scan-in-progress card's log lines.
//
// The main process streams plain-text progress messages over
// `scan:progress`. Most are log lines: blue "Scanning X..." lines,
// green "✓ Added..." lines, grey status lines. To let the card show
// all blue lines while they're true — i.e. while that board/location
// is actually being scanned — the main process also emits an explicit
// end marker when a board stops being scanned: the exact text of the
// board's "Scanning X..." start line, prefixed with \u0000end:.
//
// This module turns the raw stream into the two lists the card uses:
//   - entries: the live display list. "Scanning" lines (including
//     per-page variants of the same board) stay until their matching
//     end marker arrives, then drop off. Grey lines age out via the
//     caller's cleanup timer. Green lines stay for the whole scan.
//   - fullLog: the unmutated copy-log source, every line in arrival
//     order (end markers never recorded).

export const END_MARKER_PREFIX = '\u0000end:'

// Auto-scan forwards the same main-process stream with a "[auto-scan] "
// prefix; its start/end markers must pair the same way, so the prefix
// is stripped before interpreting a message.
const AUTO_SCAN_PREFIX = '[auto-scan] '

export interface ProgressLine {
  id: number
  msg: string
  timestamp: number
}

export interface ProgressStream {
  entries: ProgressLine[]
  fullLog: ProgressLine[]
}

// The identity key of a "Scanning X..." line: its text minus the
// trailing ellipsis. Page variants ("Scanning X... page N") extend the
// same key with "... page N", so a board's end marker retires them all.
function keyOf(startText: string): string {
  return startText.endsWith('...') ? startText.slice(0, -3) : startText
}

export function applyProgressMessage(
  stream: ProgressStream,
  rawMsg: string,
  nextId: () => number
): ProgressStream {
  // Interpret against a copy with any auto-scan prefix stripped, but
  // store the original text so the card renders exactly what was sent.
  const msg = rawMsg.startsWith(AUTO_SCAN_PREFIX) ? rawMsg.slice(AUTO_SCAN_PREFIX.length) : rawMsg

  if (msg.startsWith(END_MARKER_PREFIX)) {
    const inner = msg.slice(END_MARKER_PREFIX.length)
    // Restore the auto-scan prefix so the marker pairs with the
    // original stored text.
    const startText = rawMsg.startsWith(AUTO_SCAN_PREFIX) ? `${AUTO_SCAN_PREFIX}${inner}` : inner
    const key = keyOf(startText)
    const entries = stream.entries.filter((e) => {
      if (e.msg === startText) return false
      // Retire per-page variants of the same board too.
      if (key && e.msg.startsWith(`${key}...`)) return false
      return true
    })
    return { ...stream, entries }
  }

  const line: ProgressLine = { id: nextId(), msg: rawMsg, timestamp: Date.now() }
  return {
    entries: [...stream.entries, line],
    fullLog: [...stream.fullLog, line]
  }
}

// Reduce a whole replayed progress array (mount re-attach / getScanStatus)
// into the current stream state. End markers retroactively retire their
// start lines, so the display list reflects only what's actively scanning.
export function applyProgressBatch(
  msgs: string[],
  nextId: () => number
): ProgressStream {
  return msgs.reduce<ProgressStream>(
    (acc, m) => applyProgressMessage(acc, m, nextId),
    { entries: [], fullLog: [] }
  )
}
