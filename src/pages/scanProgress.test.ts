import { describe, it, expect } from 'vitest'
import {
  applyProgressMessage,
  applyProgressBatch,
  END_MARKER_PREFIX
} from './scanProgress'
import type { ProgressLine } from './scanProgress'

function makeIds() {
  let n = 0
  return () => n++
}

describe('applyProgressMessage — active "Scanning" lines', () => {
  it('keeps a Scanning line active until its matching end marker arrives', () => {
    const nextId = makeIds()
    let s = { entries: [] as ProgressLine[], fullLog: [] as ProgressLine[] }
    s = applyProgressMessage(s, 'Scanning Indeed (loc 1/2 — Vancouver)...', nextId)
    s = applyProgressMessage(s, '✓ Added Company — Role', nextId)
    // End marker for the board: blue line retires, green stays.
    s = applyProgressMessage(s, `${END_MARKER_PREFIX}Scanning Indeed (loc 1/2 — Vancouver)...`, nextId)
    expect(s.entries.map((e) => e.msg)).toEqual(['✓ Added Company — Role'])
    // Copy log keeps the start line and never records the marker.
    expect(s.fullLog.map((e) => e.msg)).toEqual([
      'Scanning Indeed (loc 1/2 — Vancouver)...',
      '✓ Added Company — Role'
    ])
  })

  it('retires a board line plus its page lines on the board end marker', () => {
    const nextId = makeIds()
    let s = { entries: [] as ProgressLine[], fullLog: [] as ProgressLine[] }
    s = applyProgressMessage(s, 'Scanning Indeed (loc 1/2 — Vancouver)...', nextId)
    s = applyProgressMessage(s, 'Scanning Indeed (loc 1/2 — Vancouver)... page 7', nextId)
    s = applyProgressMessage(s, 'Scanning Indeed (loc 1/2 — Vancouver)... page 12', nextId)
    s = applyProgressMessage(s, `${END_MARKER_PREFIX}Scanning Indeed (loc 1/2 — Vancouver)...`, nextId)
    expect(s.entries).toHaveLength(0)
    // Page lines are part of the copy log.
    expect(s.fullLog.map((e) => e.msg)).toEqual([
      'Scanning Indeed (loc 1/2 — Vancouver)...',
      'Scanning Indeed (loc 1/2 — Vancouver)... page 7',
      'Scanning Indeed (loc 1/2 — Vancouver)... page 12'
    ])
  })

  it('a supersede marker retires only the previous page line', () => {
    const nextId = makeIds()
    let s = { entries: [] as ProgressLine[], fullLog: [] as ProgressLine[] }
    s = applyProgressMessage(s, 'Scanning Indeed (loc 1/2 — Vancouver)...', nextId)
    s = applyProgressMessage(s, 'Scanning Indeed (loc 1/2 — Vancouver)... page 7', nextId)
    s = applyProgressMessage(s, 'Scanning Indeed (loc 1/2 — Vancouver)... page 12', nextId)
    s = applyProgressMessage(s, `${END_MARKER_PREFIX}Scanning Indeed (loc 1/2 — Vancouver)... page 7`, nextId)
    expect(s.entries.map((e) => e.msg)).toEqual([
      'Scanning Indeed (loc 1/2 — Vancouver)...',
      'Scanning Indeed (loc 1/2 — Vancouver)... page 12'
    ])
  })

  it('a board end marker for one board does not retire another board line', () => {
    const nextId = makeIds()
    let s = { entries: [] as ProgressLine[], fullLog: [] as ProgressLine[] }
    s = applyProgressMessage(s, 'Scanning Indeed (loc 1/2 — Vancouver)...', nextId)
    s = applyProgressMessage(s, 'Scanning Indeed (RSS) (loc 1/2 — Vancouver)...', nextId)
    s = applyProgressMessage(s, `${END_MARKER_PREFIX}Scanning Indeed (loc 1/2 — Vancouver)...`, nextId)
    expect(s.entries.map((e) => e.msg)).toEqual([
      'Scanning Indeed (RSS) (loc 1/2 — Vancouver)...'
    ])
  })

  it('recognizes end markers through the auto-scan prefix', () => {
    const nextId = makeIds()
    let s = { entries: [] as ProgressLine[], fullLog: [] as ProgressLine[] }
    s = applyProgressMessage(s, '[auto-scan] Scanning Indeed...', nextId)
    s = applyProgressMessage(s, `[auto-scan] ${END_MARKER_PREFIX}Scanning Indeed...`, nextId)
    expect(s.entries).toHaveLength(0)
    // The stripped start line is the copy-log entry.
    expect(s.fullLog.map((e) => e.msg)).toEqual(['[auto-scan] Scanning Indeed...'])
  })
})

describe('applyProgressBatch — mount re-attach replay', () => {
  it('replays a stream so only still-active lines remain in the display list', () => {
    const nextId = makeIds()
    const s = applyProgressBatch([
      'Scanning 2 location(s): Vancouver, Toronto',
      'Scanning CharityVillage (loc 1/2 — Vancouver)...',
      '✓ Added CharityVillage — Role',
      `${END_MARKER_PREFIX}Scanning CharityVillage (loc 1/2 — Vancouver)...`,
      'Scanning Indeed (loc 1/2 — Vancouver)...'
    ], nextId)
    expect(s.entries.map((e) => e.msg)).toEqual([
      'Scanning 2 location(s): Vancouver, Toronto',
      '✓ Added CharityVillage — Role',
      'Scanning Indeed (loc 1/2 — Vancouver)...'
    ])
    expect(s.fullLog).toHaveLength(4)
  })
})
