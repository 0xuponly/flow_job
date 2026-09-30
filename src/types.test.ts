import { describe, it, expect } from 'vitest'
import * as renderer from './types'
import * as main from '../electron/types'

// src/types.ts duplicates a few main-process constants instead of
// fetching them over IPC — one round trip per Settings render is not
// worth it. The cost of that choice is that a duplicate can drift, and
// when the drifted constant is one the user reads, the drift is a lie
// told in the UI rather than an internal detail: the Settings page
// promised "auto-regenerates up to 5x" while the queue regenerated
// exactly once, and nothing failed.
//
// These assertions are the guard that makes the duplication safe. If
// AUTO_REGEN_MAX moves in electron/types.ts, the renderer copy has to
// move with it or this fails.
describe('renderer/main constant mirrors', () => {
  it('mirrors the auto-regeneration budget the queue actually spends', () => {
    expect(renderer.AUTO_REGEN_MAX).toBe(main.AUTO_REGEN_MAX)
  })

  it('mirrors the review pass bar the loop gates on', () => {
    expect(renderer.PASSING_REVIEW_SCORE).toBe(main.PASSING_REVIEW_SCORE)
  })

  it('mirrors the auto-revive budget', () => {
    expect(renderer.AUTO_REVIVE_MAX).toBe(main.AUTO_REVIVE_MAX)
  })
})
