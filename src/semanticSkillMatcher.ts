// Local embedding-based skill matcher. Lazy-loads all-MiniLM-L6-v2
// (quantized ONNX) via @xenova/transformers. The plan §P1.1
// motivation:
//   - "exact/alias matching misses variants and near-synonyms
//     (analytics vs data analysis, cloud vs aws/gcp/azure, m&a
//     vs mergers and acquisitions)"
//   - "use only for allowlist-gap bridging": for each extracted
//     candidate not in the allowlist, compute cosine similarity
//     to allowlist entries; above threshold canonicalize to the
//     allowlist phrase; also detect multi-word variants
//     (mergers and acquisitions -> m&a).
//
// The matcher is lazy-loaded and exposes a sync wrapper so
// extractPhases()'s synchronous extraction path stays green
// (the perf-guard test asserts <2000ms for 50 small extractions).
// The first call to initSemanticMatcher() downloads the quantized
// model (~23MB) into the cache dir; subsequent calls are in-process.
//
// Cache location: $TRANSFORMERS_CACHE (or ~/.cache/flow_job/
// transformers if unset). The model files are NOT committed; they
// download on first use. To pre-warm in dev:
//   TRANSFORMERS_CACHE=~/.cache/flow_job/transformers \
//     node -e "import('./src/semanticSkillMatcher.js').then(m => m.initSemanticMatcher())"
//
// Threshold: 0.78 (MATCHER_THRESHOLD). The model computes
// similarity above this for true semantic equivalents;
// acronym/expansion pairs the model underweights
// (m&a <-> mergers and acquisitions = 0.29) are handled via
// SYNONYM_BONUS, a curated map of known abbreviation/expansion
// pairs that the model misses.

import type { KeywordAllowlists } from './keywordAllowlists'

export const MATCHER_THRESHOLD = 0.78

// Curated synonym bonus for known acronym/expansion pairs that
// the all-MiniLM-L6-v2 model doesn't have strong similarity for.
// Without this, 'mergers and acquisitions' -> 'm&a' would fail
// the 0.78 threshold (similarity 0.29 in our measurement). The
// bonus is keyed on the lowercased input phrase.
export const SYNONYM_BONUS: ReadonlyMap<string, string> = new Map([
  ['mergers and acquisitions', 'm&a'],
  ['m&a', 'mergers and acquisitions'],
  ['mergers & acquisitions', 'mergers and acquisitions'],
  // Other known acronyms whose expansion the model also underweights
  ['gtm strategy', 'go-to-market'],
  ['go-to-market strategy', 'go-to-market'],
  ['sla management', 'service level objectives'],
  ['slo management', 'service level objectives']
])

export interface CanonicalizationResult {
  /** The allowlist canonical phrase the input resolved to. */
  canonical: string
  /** Cosine similarity (or 1.0 for the synonym-bonus path). */
  similarity: number
  /** Where the canonicalization came from. */
  source: 'allowlist' | 'synonym_bonus'
}

interface MatcherState {
  initError: string | null
  extractor: ((text: string, opts: unknown) => Promise<{ data: Float32Array }>) | null
  allowlistEmbeddings: Map<string, Float32Array> | null
  // Abbreviation canonicals (m&a, gtm, etc.) the matcher can
  // produce even though they're not in the extractor allowlist
  // (the alias table handles them at extraction time).
  abbreviationCanonicals: string[]
}

// Mutable singleton state. We reassign fields (not the binding) as
// the matcher initializes, so `let` is required. Eslint flags
// prefer-const because the binding is never reassigned at the top
// level — that's correct; only fields change.
const state: MatcherState = {
  initError: null,
  extractor: null,
  allowlistEmbeddings: null,
  abbreviationCanonicals: ['m&a', 'gtm', 'sla', 'slo']
}

let initPromise: Promise<void> | null = null

function defaultCacheDir(): string {
  if (typeof process !== 'undefined' && process.env?.TRANSFORMERS_CACHE) {
    return process.env.TRANSFORMERS_CACHE
  }
  const home = (typeof process !== 'undefined' && process.env?.HOME) || ''
  return home ? `${home}/.cache/flow_job/transformers` : '/tmp/flow_job-transformers'
}

/**
 * Initialize the matcher: load the ONNX model and pre-compute
 * allowlist embeddings. Idempotent. Logs a single info line on
 * success or error. Safe to call from app startup; safe to call
 * from tests (with a custom TRANSFORMERS_CACHE).
 */
export async function initSemanticMatcher(): Promise<void> {
  if (state.extractor || state.initError) return
  if (initPromise) return initPromise
  initPromise = (async () => {
    try {
      // Dynamic import keeps @xenova/transformers out of the
      // module-init path; the sync extraction perf test asserts
      // <2000ms for 50 small extractions, and a static import
      // would pay the model-load cost every time.
      const mod = (await import('@xenova/transformers')) as {
        pipeline: (
          task: 'feature-extraction',
          model: string,
          opts?: Record<string, unknown>
        ) => Promise<(text: string, opts: unknown) => Promise<{ data: Float32Array }>>
        env: {
          cacheDir: string
          allowRemoteModels: boolean
          allowLocalModels: boolean
        }
      }
      const { pipeline, env } = mod
      env.cacheDir = defaultCacheDir()
      env.allowRemoteModels = true
      env.allowLocalModels = true
      const started = Date.now()
      const extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
        quantized: true
      })
      const loadMs = Date.now() - started
      state.extractor = extractor
      // Single info log on success; downstream code can probe
      // isMatcherReady() to check.
      console.info(`[semantic-matcher] model loaded in ${loadMs}ms (cache: ${env.cacheDir})`)
    } catch (e) {
      state.initError = (e as Error).message
      console.warn(
        `[semantic-matcher] init failed; matcher will be a no-op: ${state.initError}`
      )
    }
  })()
  return initPromise
}

export function isMatcherReady(): boolean {
  return state.extractor !== null
}

export function getMatcherInitError(): string | null {
  return state.initError
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb)
  if (denom === 0) return 0
  return dot / denom
}

async function getAllowlistEmbeddings(
  lists: KeywordAllowlists
): Promise<Map<string, Float32Array>> {
  if (state.allowlistEmbeddings) return state.allowlistEmbeddings
  if (!state.extractor) return new Map()
  const out = new Map<string, Float32Array>()
  const phrases = new Set<string>()
  for (const p of lists.hard) phrases.add(p)
  for (const p of lists.soft) phrases.add(p)
  for (const p of lists.cert) phrases.add(p)
  for (const p of lists.seniority) phrases.add(p)
  for (const p of lists.phraseBoost) phrases.add(p)
  for (const abbr of state.abbreviationCanonicals) phrases.add(abbr)
  // Sequential encoding. The onnxruntime-web session used by
  // @xenova/transformers doesn't tolerate concurrent calls on
  // Node 26 — the second call returns a Tensor whose data is
  // BigInt64Array instead of Float32Array and the session
  // throws on the next inference. Serializing is the safe path;
  // the allowlist is ~470 entries, so ~470 * ~5ms = ~2.5s of one-
  // time work amortized across the whole app session.
  const unique = [...phrases]
  for (const phrase of unique) {
    const t = await serializedEncode(() =>
      state.extractor!(phrase, { pooling: 'mean', normalize: true })
    )
    // Defensive copy: the tensor's underlying buffer is reused
    // by the model for the next call.
    const copy = new Float32Array(t.data.length)
    copy.set(t.data)
    out.set(phrase, copy)
  }
  state.allowlistEmbeddings = out
  return out
}

/**
 * Canonicalize a single unknown phrase against the allowlist via
 * the model (and the SYNONYM_BONUS for known-acronym cases). Returns
 * null if the matcher isn't ready or no canonical is above threshold.
 */
export async function canonicalizeUnknownPhrase(
  phrase: string,
  lists: KeywordAllowlists
): Promise<CanonicalizationResult | null> {
  const normalized = phrase.toLowerCase().trim()
  // Fast path: synonym bonus.
  const bonus = SYNONYM_BONUS.get(normalized)
  if (bonus !== undefined) {
    return { canonical: bonus, similarity: 1.0, source: 'synonym_bonus' }
  }
  if (!state.extractor) return null
  const phraseEmb = await serializedEncode(() =>
    state.extractor!(normalized, { pooling: 'mean', normalize: true })
  )
  // Defensive copy of the candidate embedding for the same reason
  // as in getAllowlistEmbeddings.
  const phraseCopy = new Float32Array(phraseEmb.data.length)
  phraseCopy.set(phraseEmb.data)
  const allowlist = await getAllowlistEmbeddings(lists)
  let best: { canonical: string; sim: number } | null = null
  for (const [candidate, emb] of allowlist) {
    const sim = cosineSimilarity(phraseEmb.data, emb)
    if (best === null || sim > best.sim) {
      best = { canonical: candidate, sim }
    }
  }
  if (best && best.sim >= MATCHER_THRESHOLD) {
    return { canonical: best.canonical, similarity: best.sim, source: 'allowlist' }
  }
  return null
}

// Serialize calls to the underlying model. The onnxruntime-web
// session used by @xenova/transformers doesn't tolerate
// concurrent model.run() invocations on Node 26: the second
// concurrent call returns a Tensor with BigInt64Array data and
// the next call throws. This mutex guards both the per-phrase
// encoding and the per-allowlist precompute loop.
let encodeQueue: Promise<unknown> = Promise.resolve()
function serializedEncode<T>(fn: () => Promise<T>): Promise<T> {
  const next = encodeQueue.then(fn, fn)
  encodeQueue = next.catch(() => undefined)
  return next
}

/**
 * Build a canonicalization map for a batch of phrases. Map keys are
 * the original input strings (preserving case) so the caller can
 * use them as direct lookups against extracted-phrase lists.
 */
export async function buildCanonicalizationMap(
  phrases: string[],
  lists: KeywordAllowlists
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  for (const phrase of phrases) {
    const result = await canonicalizeUnknownPhrase(phrase, lists)
    if (result) out.set(phrase, result.canonical)
  }
  return out
}

/**
 * Pure helper: replace each input phrase with its canonical where
 * the map has an entry. Sync, deterministic; safe to call from the
 * sync extraction path. Unmapped phrases pass through unchanged.
 */
export function applyCanonicalizationMap(
  phrases: string[],
  map: ReadonlyMap<string, string>
): string[] {
  return phrases.map((p) => map.get(p) ?? p)
}
