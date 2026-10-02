// @vitest-environment node
// P1.1 — local semantic skill matcher (embedding similarity, see
// docs/keyword-detection-improvement-plan.md §P1.1). Lazy-loaded via
// @xenova/transformers (all-MiniLM-L6-v2). The model lives on disk
// after first load (~23MB quantized); model-dependent tests are gated
// on the matcher being loadable so CI without the model cache can
// still pass.
//
// We override the vitest environment to `node` here because
// onnxruntime-web's Tensor type checks fail under jsdom (the default
// for this repo's vitest config) — the runtime tries to instantiate
// a float32 tensor with BigInt64Array data and throws. Running the
// matcher tests in plain node sidesteps the jsdom interference.

import { describe, it, expect, beforeAll } from 'vitest'
import {
  initSemanticMatcher,
  isMatcherReady,
  canonicalizeUnknownPhrase,
  buildCanonicalizationMap,
  applyCanonicalizationMap,
  MATCHER_THRESHOLD
} from './semanticSkillMatcher'
import { loadKeywordAllowlists } from './keywordAllowlists'
import { extractPhases } from './keywordExtractor'

process.env.TRANSFORMERS_CACHE = '/tmp/keywords_audit/xenova-cache'

/**
 * Budget for the one-time ONNX warm-up. 422ms idle and 2.5-2.9s under CPU
 * load; 60s leaves room for a cold model download on a machine with no cache
 * while still failing a genuine hang.
 */
const WARM_UP_TIMEOUT_MS = 60_000

async function matcherReadyForTest(): Promise<boolean> {
  try {
    await initSemanticMatcher()
    return isMatcherReady()
  } catch {
    return false
  }
}

const matcherReady = await matcherReadyForTest()

describe('P1.1 semantic skill matcher (always-on contract)', () => {
  it('exports the configurable threshold constant', () => {
    expect(typeof MATCHER_THRESHOLD).toBe('number')
    expect(MATCHER_THRESHOLD).toBeGreaterThan(0)
    expect(MATCHER_THRESHOLD).toBeLessThanOrEqual(1)
  })

  it('graceful no-op when canonicalization map is empty (sync path safe)', () => {
    const seed = ['mergers and acquisitions', 'data analytics']
    const out = applyCanonicalizationMap(seed, new Map())
    expect(out).toEqual(seed)
  })

  it('extractPhases accepts an optional canonicalization map (no-op when empty)', () => {
    const phrases = extractPhases(
      'python and kubernetes required',
      'required',
      new Set(),
      new Map()
    )
    const map = new Map<string, string>()
    const phrases2 = extractPhases(
      'python and kubernetes required',
      'required',
      new Set(),
      map
    )
    expect(phrases2.map((k) => k.phrase).sort()).toEqual(phrases.map((k) => k.phrase).sort())
  })

  it('applyCanonicalizationMap replaces only the listed phrases', () => {
    const original = ['mergers and acquisitions', 'data analytics', 'python']
    const map = new Map([
      ['mergers and acquisitions', 'm&a'],
      ['data analytics', 'analytics']
    ])
    const out = applyCanonicalizationMap(original, map)
    expect(out).toEqual(['m&a', 'analytics', 'python'])
  })

  it('extractPhases applies a non-empty canonicalization map to matched entries', () => {
    const out = extractPhases(
      'mergers and acquisitions deal team',
      'required',
      new Set(),
      new Map([['mergers and acquisitions', 'm&a']])
    )
    expect(out.length).toBeGreaterThan(0)
  })
})

// describe.skipIf-style gate: skip the model-dependent describe
// entirely if the matcher can't load (vitest's standard pattern).
const describeIf = matcherReady ? describe : describe.skip

/**
 * Every model-dependent test below runs one or two embeddings, and an
 * embedding is the only thing in this file that costs real time. The cost is
 * almost entirely one-time: the ONNX runtime compiles its WASM and sizes its
 * arenas on the first inference and not again. Measured, per phrase:
 *
 *     init (model from disk cache)   95-355ms
 *     'mergers and acquisitions'     0ms   -- resolved by the synonym bonus,
 *                                            never reaches the model
 *     'gtm strategy'                0ms   -- likewise
 *     'data analytics'            422ms   <- FIRST real inference, pays
 *                                            the whole runtime warm-up
 *     'kitchen supplies'            1-6ms
 *     'pizza delivery'              1-4ms
 *     every later embedding          0-1ms
 *
 * So the warm-up was landing on whichever test happened to be first, and the
 * one that got it was the slowest thing in the suite: 'data analytics' is the
 * first phrase here that is not covered by a synonym bonus, which makes it the
 * first to reach the model and the first to pay. Under CPU load that single
 * call was measured at 2511-2860ms, and inside a full 7-worker suite it was
 * observed at 7592ms -- past vitest's 5000ms default, which is what failed it.
 *
 * Paying it once in a beforeAll takes it off the individual tests entirely.
 * Every test below then costs single-digit milliseconds and none of them needs
 * a raised timeout of its own.
 */
describeIf('P1.1 semantic skill matcher (model-dependent)', () => {
  beforeAll(async () => {
    // A phrase with no synonym-bonus shortcut, so this genuinely reaches the
    // model and forces the runtime to initialise.
    await canonicalizeUnknownPhrase('data analytics', loadKeywordAllowlists())
  }, WARM_UP_TIMEOUT_MS)

  it('canonicalizes "mergers and acquisitions" to "m&a" via the synonym bonus', async () => {
    const lists = loadKeywordAllowlists()
    const result = await canonicalizeUnknownPhrase('mergers and acquisitions', lists)
    expect(result).not.toBeNull()
    expect(result?.canonical.toLowerCase()).toBe('m&a')
  })

  it('"data analytics" (input) canonicalizes to "analytics"', async () => {
    const lists = loadKeywordAllowlists()
    const result = await canonicalizeUnknownPhrase('data analytics', lists)
    expect(result).not.toBeNull()
    expect(result?.canonical.toLowerCase()).toBe('analytics')
  })

  it('"gtm strategy" (input) canonicalizes to "go-to-market"', async () => {
    const lists = loadKeywordAllowlists()
    const result = await canonicalizeUnknownPhrase('gtm strategy', lists)
    expect(result).not.toBeNull()
    expect(result?.canonical.toLowerCase()).toBe('go-to-market')
  })

  it('random noise phrases do not canonicalize (FP guard)', async () => {
    const lists = loadKeywordAllowlists()
    const noise = [
      'kitchen supplies',
      'pizza delivery',
      'bar trivia',
      'underwater basket weaving',
      'professional tap dancer',
      'left-handed widget inspector',
      'astrology chart reader'
    ]
    let falsePositives = 0
    for (const phrase of noise) {
      const result = await canonicalizeUnknownPhrase(phrase, lists)
      if (result !== null && result.similarity >= MATCHER_THRESHOLD) {
        falsePositives++
      }
    }
    // The plan P1.1 §4 sets a <5% FP rate target on fixtures; for
    // this hand-picked noise set the rate must be 0.
    expect(falsePositives).toBe(0)
  })

  it('buildCanonicalizationMap returns a map with the expected canonicals', async () => {
    const lists = loadKeywordAllowlists()
    const map = await buildCanonicalizationMap(
      ['mergers and acquisitions', 'Data Analytics', 'pizza delivery'],
      lists
    )
    const lower = new Map([...map.entries()].map(([k, v]) => [k.toLowerCase(), v]))
    expect(lower.get('mergers and acquisitions')).toBe('m&a')
    expect(lower.get('data analytics')).toBe('analytics')
    expect(lower.has('pizza delivery')).toBe(false)
  })

  it('extractPhases end-to-end with a real matcher map', async () => {
    const lists = loadKeywordAllowlists()
    const map = await buildCanonicalizationMap(['mergers and acquisitions'], lists)
    const out = extractPhases(
      'mergers and acquisitions deal team',
      'required',
      new Set(),
      map
    )
    expect(out.length).toBeGreaterThan(0)
  })
})
