import {
  clearProviderSpend,
  getProviderSpend,
  getSettings,
  listApiModels,
  recordProviderCall,
  getDocument,
  updateDocument,
  updateDocumentVerification,
  listApplications,
  updateApplication,
  DEFAULT_PROVIDER_CALL_CAP,
  MAX_PROVIDER_CALL_CAP,
  MIN_PROVIDER_CALL_CAP,
  PROVIDER_SPEND_WINDOW_MS
} from './database'
import type { ApiModelConfig, FitBreakdown, Job, KeywordCategory, KeywordEntry, KeywordResult, KeywordSource, RuleCheck, TailorRequest, TailorResult, VerificationResult } from './types'
import { createDocument, getJob, replaceDocumentContent } from './database'
import { readFileSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import { log } from './logger'
import { scoreCompatibilityStructured, extractEducationLevel, extractYearsExperience } from './fitHeuristic'
import { runDocumentRuleChecks } from '../src/documentRules'
import { extractJobKeywordsStructured, extractJobKeywords, mergeKeywordResults } from '../src/keywordExtractor'
import { loadKeywordAllowlists } from '../src/keywordAllowlists'
import { fingerprintKey, hostOf, redactBody } from './aiDebug'
import { looksLikeProviderNotice, describeProviderNotice } from './providerNotice'
import { PROVIDERS_COOLING_DOWN_MESSAGE } from './cooldownBlock'

export class KeywordExtractionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'KeywordExtractionError'
  }
}

const KEYWORD_CATEGORIES: ReadonlySet<KeywordCategory> = new Set(['hard', 'soft', 'cert', 'seniority'])
const KEYWORD_SOURCES: ReadonlySet<KeywordSource> = new Set(['title', 'required', 'preferred', 'body'])

export class RateLimitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RateLimitError'
  }
}

/**
 * Who asked for this call.
 *
 * The spend cap is enforced on AUTOMATED work only, and this flag is the
 * only thing that tells the two apart — the same division the queue already
 * draws with `manualQueued` on a row and `opts.manual` on `enqueue`, and
 * for the same reason: the app stopping work it started on its own is a
 * budget; the app refusing something a person pressed is a dead end.
 *
 * Absent means AUTOMATED, deliberately. Every call site that forgets to pass
 * it gets the capped, conservative behaviour rather than an unbounded one,
 * and that is the direction this failure has to fail in.
 */
export interface AiCallOptions {
  manual?: boolean
}

/**
 * A provider is out of its rolling-24h call budget.
 *
 * A `RateLimitError` subclass because that is exactly what it is, from every
 * caller's point of view: this provider will not answer us for an hour or
 * more, so the queue should park the work and try again rather than burn its
 * retry budget marking it failed. What it adds is a message that says WHICH
 * provider, how much of its budget is gone, and when it frees up — the
 * difference between a user who can wait and a user who can go add another
 * key.
 */
export class ProviderCapError extends RateLimitError {
  constructor(message: string) {
    super(message)
    this.name = 'ProviderCapError'
  }
}

/**
 * Every eligible model is inside its cooldown / circuit-break window, so
 * this call CANNOT reach the provider. No HTTP request was made and no
 * provider budget was spent.
 *
 * A subclass of `RateLimitError` on purpose: every existing
 * `instanceof RateLimitError` branch in the app is still correct about
 * it (it IS a rate-limit condition, and it still propagates), and the
 * places that must not charge an attempt for it can now say so by type
 * instead of by matching prose. The subclass IS the mechanism — nothing
 * reads its message.
 *
 * Why this distinction is worth a type rather than a cheaper special
 * case: the two paths cost wildly different amounts. A genuine rotation
 * is N real requests (measured: a 45s model times out, or a 429 storm
 * costs a round trip each), while this throw is a local map lookup that
 * fails in tens of milliseconds. Charging both the same attempt budget is
 * what drained a queue of 265 tasks to zero successes overnight
 * (2026-10-02): 4,122 of 4,143 logged failures were this throw, and rows
 * burned all 10 attempts on it before the provider had ever recovered.
 */
export class ProviderCooldownError extends RateLimitError {
  /** Stable machine-readable discriminator, for callers that must branch. */
  readonly code = 'providers_cooling_down' as const

  constructor(message: string = PROVIDERS_COOLING_DOWN_MESSAGE) {
    super(message)
    this.name = 'ProviderCooldownError'
  }
}

let cachedTemplate: string | null = null

async function loadHarvardTemplate(): Promise<string> {
  if (cachedTemplate !== null) return cachedTemplate
  try {
    const path = join(app.getAppPath(), 'docs', 'templates', '2025-template_bullet.docx')
    const buf = readFileSync(path)
    // Lazy-require: mammoth's require costs ~1.5s in Electron's main process,
    // and it's only needed when the Harvard template is loaded (user-triggered
    // document tailoring, never at boot). Loading it on demand removes that
    // from every app startup.
    const mammoth = (await import('mammoth')).default
    const result = await mammoth.extractRawText({ buffer: new Uint8Array(buf) })
    cachedTemplate = result.value.trim()
  } catch (err) {
    log.ai.error('[ai] Failed to load Harvard template:', err)
    cachedTemplate = ''
  }
  return cachedTemplate
}

function buildHarvardCvInstructions(template: string, topKeywords?: string[]): string {
  return `You are an expert career coach. Tailor the candidate's CV for the specific job posting using the EXACT Harvard format demonstrated by the template below. The template is the source of truth — preserve its structure, section order, spacing, capitalization, and TAB-based alignment exactly as shown.

=== HARVARD CV TEMPLATE (source of truth) ===
${template}
=== END TEMPLATE ===

SECTIONS IN ORDER (do not add, remove, or rename any section):
1. Name (centered, on its own line)
2. Contact line: address • city, state zip • email • phone (centered, bullets between fields)
3. Education — School Name (TAB) Location, Degree, Concentration, GPA (TAB) Graduation Date, Thesis
   Then: Relevant Coursework, Study Abroad, High School (same TAB-aligned format)
4. Experience — Organization (TAB) City, State, then Position Title (TAB) Month Year – Month Year
   Then: bullet points describing the role (no personal pronouns, action-verb-led, quantified)
5. Leadership & Activities
   - Up to 3 entries.
   - Each entry is a single line in this EXACT format: <Title> (bold), <Organization Name>, then a LITERAL TAB CHARACTER (\\t, ASCII 0x09 — NOT spaces, NOT em-dashes, NOT pipes), then the year range (Year – Year).
   - Example line 1: **President**, UBC Coding Club<TAB>2023 – 2024
   - Example line 2: **Volunteer Mentor**, Code for America<TAB>2022 – Present
   - Do NOT include sub-bullets, descriptions, or continuation lines.
   - If a role is long, shorten the title; do not wrap to a second line.
6. Skills & Interests — Technical: / Language: only.
   - Technical: 5-15 entries, ranked by job-keyword match. Drop the lowest-match entries if over 15. Drop the section if under 5 (sparse is correct).
   - Language: preserve verbatim. Spoken languages are not job-keyword matched.
   - Drop Laboratory, Interests, and any other label.

FORMATTING RULES (must follow exactly):
- Section headers on their own line, centered, bold
- Use a LITERAL TAB CHARACTER (\\t, ASCII 0x09 — NOT spaces, NOT em-dashes, NOT pipes) between the bold left text (school/org/title) and the right-aligned location/dates. Do not use multiple spaces or "—" as separators.
- Each experience entry is EXACTLY two lines, in this order:
    Line 1: <Organization>\\t<City, State>
    Line 2: <Position Title>\\t<Month Year – Month Year>
  Followed by bullet points describing the role.
- Each bullet point on its own line, starting with an action verb
- Write experience bullet points in the XYZ format: "Accomplished [X] as measured by [Y], by doing [Z]."
- Do NOT use asterisks or markdown formatting
- Do NOT use personal pronouns
- Quantify wherever possible
- Output plain text only

ONE-PAGE RULE (overrides verbosity):
- The output MUST fit on a single US-Letter page at 11pt Calibri with 0.6in/0.7in margins.
- Hard ceilings: ≤ 4 Experience entries, ≤ 4 bullet points per entry, ≤ 2 Leadership entries, ≤ 6 Skills & Interests lines, Education kept to at most 4 lines (one compressed block).
- If the candidate has more, prioritize the items most relevant to the target job and DROP the rest. Do not abbreviate, do not shrink, do not move to a second page.
- Never pad with filler to "fill" the page — sparse is correct when the background is sparse.

${topKeywords && topKeywords.length > 0
  ? `KEYWORD COVERAGE (overrides verbosity):
- Aim to mention at least 90% of the key terms from the job description.
- High-priority keywords (include where truthful): ${topKeywords.join(', ')}

`
 : `KEYWORD COVERAGE (overrides verbosity):
- Aim to mention at least 90% of the key terms from the job description.

`}
CRITICAL — TRUTHFULNESS (this overrides everything else):
- Use ONLY experience, skills, education, and projects that appear in the candidate's Base CV / Background below.
- Do NOT invent or fabricate any experience, employers, job titles, projects, technologies, degrees, courses, GPA, awards, dates, or numbers that are not in the Base CV.
- Do NOT hallucinate metrics ("increased revenue by 40%") unless that specific number is in the Base CV. If the Base CV has no metric, use a non-numeric but truthful phrasing (e.g. "Improved onboarding workflow for new hires").
- Do NOT add skills, tools, languages, or technologies the candidate did not list.
- You MAY reword, reframe, reorder, and tighten existing experience to highlight what is most relevant to the target job. The candidate's actual accomplishments stay — they just sound as strong and as role-aligned as possible.
- If the Base CV is sparse, the output should be sparse. Do not pad with generic filler.`
}

interface CallAIResult {
  content: string | null
  modelUsed: string | null
  rateLimited: boolean
  errors: string[]
  // P1.5: ordered list of model keys attempted during the rotation.
  // Empty if the model pool was already empty. Used by call sites to
  // exclude the bad model on a bounded retry after parse_failed.
  attempted: string[]
}

// Sentinel error thrown by tailorDocument when the LLM call succeeded
// (every model in the rotation returned HTTP 200) but the validator
// rejected ALL their contents (e.g., reasoning-channel / planning-meta
// text instead of a CV). Distinct from RateLimitError so the caller
// can surface it as a real failure rather than silently persisting the
// raw user-supplied base CV (the prior behavior for any non-rate-limit
// error: generateFallbackDocument → looks-tailored but isn't).
//
// Production trigger (2026-09-13, jobId 7605 family): reasoning-style
// VL models in the user's saved rotation returned planning-meta text
// like "We need to tailor the CV. We must follow the Harvard template
// exactly." The validator now catches this and refuses to persist.
export class TailoredOutputValidationError extends Error {
  constructor(public readonly docType: 'cv' | 'cover_letter', public readonly reason: string) {
    super(`Tailored ${docType} failed validation: ${reason}`)
    this.name = 'TailoredOutputValidationError'
  }
}

// Robust JSON-object extraction used by JSON-parsing call sites
// (verifyDocumentContent, scoreJobFit). Replaces the legacy regex
// /\{[\s\S]*\}/ which captured from the first `{` to the LAST `}`
// in the response — when a reasoning-channel model wraps its JSON in
// prose ("Here is my review: {"score":85} Hope this helps"), the
// legacy regex grabbed the prose + JSON, JSON.parse failed, and the
// caller silently skipped with reason 'parse_failed'.
//
// Three tiers, in order of preference:
//   1. A fenced ```json ... ``` block. Models that follow the
//      markdown-fence convention emit the JSON between fences; this
//      gives us a tightly-scoped capture with no prose.
//   2. An unfenced ``` ... ``` block. Some models wrap without the
//      `json` tag, especially smaller models following chat
//      conventions.
//   3. A balanced-brace scan from the FIRST `{` in the response,
//      walking the string and tracking quote/escape state so escaped
//      quotes inside JSON string values do not throw off the brace
//      counter. Returns the FIRST balanced object; parses it. If
//      parsing fails (malformed), continues scanning for the next
//      balanced `{...}` (some models emit an unrelated preamble
//      before the real answer). Returns null when nothing parses.
//
// Pure, deterministic, no I/O. Exported for unit tests. P1.5.a.
export function parseJsonObject(content: string): unknown | null {
  if (!content) return null

  // Tier 1+2: fenced code blocks.
  const fencedRe = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/gi
  let m: RegExpExecArray | null
  while ((m = fencedRe.exec(content)) !== null) {
    try {
      const parsed = JSON.parse(m[1])
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
    } catch {
      // Keep scanning — some fenced blocks are not valid JSON.
    }
    // Guard against zero-length matches on infinite-loop edge cases.
    if (m.index === fencedRe.lastIndex) fencedRe.lastIndex++
  }

  // Tier 3: balanced-brace scan from the FIRST `{`. We do not use a
  // regex here because the legacy /\{[\s\S]*\}/ was the bug — it does
  // not know what "balanced" means for nested braces. We walk the
  // string with explicit state.
  for (let i = 0; i < content.length; i++) {
    if (content[i] !== '{') continue
    const candidate = balancedJsonFrom(content, i)
    if (candidate === null) continue
    try {
      const parsed = JSON.parse(candidate)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
    } catch {
      // Malformed JSON at this span — keep scanning for the next `{`.
    }
  }
  return null
}

// Returns the first balanced `{...}` slice starting at `start` (which
// MUST be the index of `{`). Tracks string-quote/escape state so a
// literal `{` inside a JSON string value does not throw off the
// brace counter. Returns null when the `{` has no matching `}` ahead
// of it (i.e., the response was cut off or contains a stray brace).
function balancedJsonFrom(content: string, start: number): string | null {
  let depth = 0
  let inString = false
  let escape = false
  for (let i = start; i < content.length; i++) {
    const c = content[i]
    if (inString) {
      if (escape) {
        escape = false
        continue
      }
      if (c === '\\') {
        escape = true
        continue
      }
      if (c === '"') {
        inString = false
      }
      continue
    }
    // Not in a string.
    if (c === '"') {
      inString = true
      continue
    }
    if (c === '{') {
      depth++
    } else if (c === '}') {
      depth--
      if (depth === 0) {
        return content.slice(start, i + 1)
      }
    }
  }
  return null
}

// Structural validator for a tailored-CV response. A well-formed
// Harvard-format CV must contain at least one canonical section header
// as a bare line ("Education", "Experience",
// "Leadership & Activities", "Skills & Interests"), at least one TAB
// character (TAB alignment is mandatory in the spec for org/title/date
// separators), and a name-style first line (short, no sentence
// punctuation, no first-person-plural planning markers).
//
// Defensive anti-reasoning gate: a model that emits "We need to…",
// "Better to follow exactly…", "Wait — actually…", or similar
// planning-meta text fails this check, even if the output also
// happens to contain a few real section headers as quoted echoes of
// the prompt. Reasoning-channel style output is rejected on the
// planning-line count: 0-2 lines of first-person-plural planning is
// tolerable (a model may legitimately say "we should" inside a real
// CV bullet); ≥3 is a deliberation pass, not a CV.
//
// Pure, deterministic, no I/O. Exported for unit tests.
export function looksLikeHarvardCv(content: string): boolean {
  if (!content || content.trim().length < 50) return false
  const lines = content.split('\n').map((l) => l.trim()).filter(Boolean)
  if (lines.length === 0) return false

  // 1. At least one canonical section header as a bare line.
  const HEADER_RE = /^(Education|Experience|Leadership(?: & Activities| and Activities)?|Skills(?: & Interests| and Interests)?)$/
  const headerCount = lines.filter((l) => HEADER_RE.test(l)).length
  if (headerCount < 1) return false

  // 2. TAB alignment is mandatory in the spec (the Harvard template
  // uses literal \t separators between bold left text and right-aligned
  // location/dates). Comma-only outputs are not Harvard format — the
  // validator rejects them and forces a retry.
  if (!/\t/.test(content)) return false

  // 3. First non-blank line must be a name-style line, not a
  // planning sentence. Real name lines are short and have no
  // sentence-ending punctuation. Reasoning-channel preambles
  // ("We need to tailor the CV…") are caught here.
  const firstNonBlank = lines[0] ?? ''
  if (firstNonBlank.length > 60) return false
  if (/[.!?]$/.test(firstNonBlank)) return false
  if (/^(we|we need to|we must|we have to|we should|let me|but we|wait)/i.test(firstNonBlank)) return false

  // 4. Anti-deliberation gate: ≤2 lines that look like first-person
  // planning monologue. Reasoning models paraphrase the system prompt
  // as "Better to follow exactly: …", "Wait — actually …", etc.
  // A real CV rarely contains these patterns.
  const PLANNING_RE = /\b(we (?:need|must|have|should) to|let me|wait\b|but (?:we|the)\b|better to)\b/i
  const planningLineCount = lines.filter((l) => PLANNING_RE.test(l)).length
  if (planningLineCount > 2) return false

  return true
}

const DEFAULT_MAX_TOKENS = 2048

// Per-attempt HTTP timeout for one model's chat/completions request.
// 45s covers a full 2048-token generation (DEFAULT_MAX_TOKENS) on a slow
// free-tier model, so a healthy-but-slow model is never cut off mid-answer
// and then misreported to the user as an empty response.
//
// The previous 20s was picked before DEFAULT_MAX_TOKENS was capped at
// 2048, and it was never what made a failing model cheap: measured
// billing-error (402) responses come back in ~3.5s and rate limits (429)
// in well under a second, both far inside any timeout. The timeout only
// ever bounded genuinely slow generation.
//
// Applies PER MODEL per attempt, so a rotation of N models that all hang
// costs up to N * this. At 11 models that is 8m15s per attempt, up from
// 3m40s at 20s — accepted deliberately, because a generation cut off at
// 20s is indistinguishable from an empty one by the time the user sees
// the error.
const DEFAULT_CALL_TIMEOUT_MS = 45_000

// Ceiling for a model-configured `timeout_ms`. 10 minutes is far past any
// real generation; it exists so a fat-fingered or hostile config cannot
// wedge the serial queue for an hour. Values above it are clamped, not
// rejected — a model that genuinely needs longer than the default is
// still allowed to have it.
const MAX_CALL_TIMEOUT_MS = 10 * 60 * 1000

// Slug patterns that identify rerank/embeddings models that do not belong in
// the chat/completions rotation. OpenRouter returns 400 when these are sent to
// the chat endpoint.
const RERANK_MODEL_PATTERNS = [/rerank/i]

function isRerankModel(slug: string): boolean {
  return RERANK_MODEL_PATTERNS.some((p) => p.test(slug))
}

function getMaxTokens(model?: ApiModelConfig): number {
  const env = Number(process.env.FLOW_JOB_MAX_TOKENS)
  if (Number.isFinite(env) && env > 0) return env
  if (model?.max_tokens && Number.isFinite(model.max_tokens) && model.max_tokens > 0) {
    return model.max_tokens
  }
  return DEFAULT_MAX_TOKENS
}

// Per-model timeout for one attempt. An optional `timeout_ms` on the model
// wins over the rotation-wide `fallbackMs`; there is deliberately no
// settings UI for it, so the default has to be right on its own.
//
// A nonsense value is not trusted, it falls back. `timeout_ms: 0` would
// abort every request on the next tick — the model looks permanently
// broken — and an hour-long timeout would wedge the serial queue behind a
// single dead host, which is strictly worse than the default. That covers
// 0, negatives, NaN, ±Infinity and non-numbers. A finite value above
// MAX_CALL_TIMEOUT_MS is clamped rather than discarded, so the field still
// means "give this model longer" for any sane request.
function getCallTimeoutMs(model: ApiModelConfig, fallbackMs: number): number {
  const raw = model.timeout_ms
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return fallbackMs
  return Math.min(raw, MAX_CALL_TIMEOUT_MS)
}

function eligibleModels(): ApiModelConfig[] {
  const models = listApiModels().filter((m) => m.enabled !== false && !isRerankModel(m.model))
  if (models.length === 0) {
    const all = listApiModels().filter((m) => m.enabled !== false)
    if (all.length > 0) {
      log.ai.warn('[ai] All enabled models are rerank/embeddings models; chat rotation is empty.')
    }
  }
  return models
}

// Per-model health: cooldown after 429 and circuit-breaker after persistent
// client errors (401/402/404). Exported reset is for tests only.
interface ModelHealth {
  nextAvailableAt: number
  consecutiveFailures: number
  circuitOpenUntil: number
}

const modelHealth = new Map<string, ModelHealth>()

export function resetModelHealth(): void {
  modelHealth.clear()
}

/**
 * P1.6: scoped health reset. The `modelHealth` map persists for the
 * lifetime of the main process; disabling a model does NOT delete its
 * entry, and re-enabling inherits the prior cooldown / circuit-break.
 * The IPC layer for Settings → Models (models:save / add / delete)
 * calls this after persisting model edits so a re-enabled model is
 * genuinely tried on the next callAI.
 *
 * The map itself is NOT exported — callers cannot iterate it or
 * hand-clear arbitrary entries. The BRIEF: "do NOT export the map".
 * Only this targeted reset, scoped to specific ids, is the supported
 * surface.
 *
 * Matching uses the same canonical key as the rotation
 * (`modelKey()` — model.id or `base_url::model`), so callers can
 * pass either a stable model.id from the DB or a synthetic key.
 * Unknown ids are a no-op (delete + re-add with the same id scheme:
 * the id may or may not already be in the map; we always handle
 * both cases).
 */
export function resetModelHealthByIds(ids: Iterable<string>): void {
  const target = new Set<string>()
  for (const id of ids) {
    if (typeof id === 'string' && id.length > 0) target.add(id)
  }
  if (target.size === 0) return
  for (const key of Array.from(modelHealth.keys())) {
    if (target.has(key)) modelHealth.delete(key)
  }
}

// `providerKey` (the bucket identity), `modelKey` (the health key) and the
// fingerprint helper all live in their own module now, because `database.ts`
// has to derive the same bucket when a model row is edited — see the note at
// the top of providerKey.ts. Re-exported here because every importer of the
// cap's public surface has always reached for them through ai.ts, and a
// money-path refactor is not the moment to make eleven call sites learn a
// new module path.
export { providerKey, providerKeyMoved } from './providerKey'
import { hashString, modelKey, providerKey, resetProviderKeyWarnings } from './providerKey'

/**
 * A provider's spend in the current rolling window.
 *
 * Derived from the persisted ledger rather than from a separate counter,
 * deliberately: two counters is two truths, and a bound that can disagree
 * with the record it is bounding is the `spendBound.test.ts` problem all
 * over again.
 */
export interface ProviderBudget {
  key: string
  /** Host, for logs and the cap message. Never a path, a key or an id. */
  label: string
  /** Total real calls inside the window, automated and manual. */
  used: number
  automated: number
  manual: number
  cap: number
  /** When the oldest in-window call ages out — null while under the cap. */
  freeAt: number | null
  /**
   * A recorded call is dated more than a whole window AHEAD of now, so the
   * machine's clock was wrong when it was written and every timestamp in
   * this ledger — including the ones that look fine — is suspect.
   *
   * The cap does not apply while this is true (`providerOverCap`), because
   * the alternative is what this flag exists to prevent: a clock once set to
   * the wrong year left every entry permanently inside the window, so the
   * provider read as capped until that imaginary year was over, with the only
   * clearing path being a test-only export behind no IPC. A bound that cannot
   * be evaluated must not be enforced — the spend is what it is, the user
   * still gets their work done, and `used` below still reports what was
   * recorded so the anomaly is visible rather than silently corrected.
   */
  clockSkewed: boolean
}

function providerLabel(key: string): string {
  if (key.startsWith('unclassified:')) return '<unclassifiable base URL>'
  const hashAt = key.indexOf('#')
  if (hashAt === -1) return key
  const endpoint = key.slice(0, hashAt)
  const slash = endpoint.indexOf('//')
  return slash === -1 ? endpoint : endpoint.slice(slash + 2)
}

function providerCalls(key: string, now: number): { calls: { at: number; manual: boolean }[]; clockSkewed: boolean } {
  const history = getProviderSpend()[key]
  if (!Array.isArray(history)) return { calls: [], clockSkewed: false }
  const cutoff = now - PROVIDER_SPEND_WINDOW_MS
  // Filtered rather than sliced: a store written by an older build, or a
  // clock that moved backwards, must not make the count wrong in the
  // direction that spends money. Over-counting is recoverable; under-counting
  // is the hole this whole thing exists to close.
  //
  // The window is one-sided ON PURPOSE. `c.at` is written with `Date.now()`,
  // so a stamp in the future can only mean the clock was wrong when it was
  // written — and a two-sided window would simply delete it, taking the only
  // record of what the app did with the anomaly along with it. So the
  // impossible stamp is counted, not corrected, and `clockSkewed` says so.
  const calls = history.filter(
    (c): c is { at: number; manual: boolean } =>
      !!c && typeof c.at === 'number' && Number.isFinite(c.at) && c.at > cutoff
  )
  // A whole window of forward slack, not zero: a machine a few minutes fast
  // is an ordinary thing and its entries are real spend that must keep
  // counting, and the tolerance costs nothing because a correctly-clocked
  // machine never reaches it.
  const horizon = now + PROVIDER_SPEND_WINDOW_MS
  return { calls, clockSkewed: calls.some((c) => c.at > horizon) }
}

export function providerBudget(key: string, now = Date.now()): ProviderBudget {
  const { calls, clockSkewed } = providerCalls(key, now)
  let automated = 0
  let manual = 0
  for (const c of calls) {
    if (c.manual) manual++
    else automated++
  }
  return {
    key,
    label: providerLabel(key),
    used: calls.length,
    automated,
    manual,
    cap: resolveProviderCap(),
    // The oldest call in the window is the one that frees first: the budget
    // is available again one full window after it was spent.
    freeAt: calls.length === 0 ? null : Math.min(...calls.map((c) => c.at)) + PROVIDER_SPEND_WINDOW_MS,
    clockSkewed
  }
}

function resolveProviderCap(): number {
  const raw = getSettings().provider_call_cap
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_PROVIDER_CALL_CAP
  return Math.min(MAX_PROVIDER_CALL_CAP, Math.max(MIN_PROVIDER_CALL_CAP, Math.round(raw)))
}

/**
 * This provider's budget for automated work, or null while there is room.
 *
 * The comparison counts BOTH kinds of call, which is the whole point of
 * recording manual ones separately rather than exempting them: a manual
 * request is a request the credential paid for, so it has to occupy budget,
 * and a user who clicks Generate fifty times must not walk straight past a
 * cap that exists to protect the key they are clicking with. What manual
 * buys is not extra room — it is that the request is not REFUSED.
 */
function providerOverCap(key: string, now = Date.now()): ProviderBudget | null {
  const budget = providerBudget(key, now)
  // A ledger the clock has invalidated is not a budget the app can evaluate,
  // and enforcing it anyway is the dead end: over-counting that never ages
  // out is not recoverable, so a wrong clock would cost the user their
  // automated work for as long as the wrong clock implied. See
  // `ProviderBudget.clockSkewed`.
  if (budget.clockSkewed) return null
  return budget.used >= budget.cap ? budget : null
}

/**
 * When does the EARLIEST capped provider get its budget back?
 *
 * The queue's answer to "how long does a refused row have to wait", and the
 * reason a cap refusal can be parked rather than counted as a failure: the
 * budget frees on a schedule this code already knows — `providerBudget`
 * computes it from the ledger, every time, from real records. So there is
 * nothing to guess and no new constant to invent; the only question was
 * which providers to consider.
 *
 * Every ENABLED model, and only capped ones: the point of the number is "the
 * earliest moment some provider could serve this row", so a disabled model
 * (which the rotation would never reach) must not push it later, and an
 * unfunded one must not pull it earlier. Null when nothing is capped, which
 * is the honest reading and the one the queue treats as "no reason to wait".
 */
export function nextProviderCapFreeAt(now = Date.now()): number | null {
  let soonest: number | null = null
  const seen = new Set<string>()
  for (const model of eligibleModels()) {
    const key = providerKey(model)
    if (seen.has(key)) continue
    seen.add(key)
    const over = providerOverCap(key, now)
    if (!over || over.freeAt === null) continue
    if (soonest === null || over.freeAt < soonest) soonest = over.freeAt
  }
  return soonest
}

function clockTime(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/**
 * The user-facing sentence for a capped provider.
 *
 * Says which provider, what the spend was (split, so the two kinds stay
 * legible rather than blending into one number), and WHEN it frees up — and
 * that the user's own actions are untouched, because the alternative
 * reading of this message is "the app is broken".
 */
function describeProviderCap(budget: ProviderBudget): string {
  const spend = budget.manual > 0
    ? `${budget.automated} automated, ${budget.manual} manual`
    : `${budget.automated} automated`
  const frees = budget.freeAt === null ? 'shortly' : clockTime(budget.freeAt)
  return (
    `${budget.label} is at its call cap — ${spend} of ${budget.cap} in the last 24h. ` +
    `Budget frees at ${frees}. Automated work is paused; Generate, Regenerate, Verify and ` +
    `Tailor still run.`
  )
}

// Providers whose exhaustion has already been written to the log for this
// process, so a rotation that walks past twenty models on one capped
// provider says it once rather than twenty times.
const capAnnounced = new Set<string>()

function noteProviderCap(budget: ProviderBudget): void {
  if (capAnnounced.has(budget.key)) return
  capAnnounced.add(budget.key)
  log.ai.warn(
    `[ai] provider call cap reached provider=${budget.label} used=${budget.used} cap=${budget.cap} ` +
    `automated=${budget.automated} manual=${budget.manual} frees_at=${budget.freeAt ?? 'unknown'} ` +
    '— automated work paused, manual actions still run'
  )
}

/**
 * Count one real outbound request, and log it.
 *
 * Called from exactly one place: immediately before the request is issued.
 * That is what makes the ledger a fact about the wire rather than about the
 * app's own bookkeeping — a 429, a timeout and an HTTP 200 carrying a
 * billing notice are all requests that were made, so all three land here,
 * and nothing lands here for a request the cap refused.
 */
function countProviderCall(key: string, manual: boolean): void {
  recordProviderCall(key, manual)
  if (manual) {
    // Manual calls are the ones the brief calls out for legibility, and they
    // are rare enough (one per thing a person asked for) to be worth a line
    // each without becoming noise.
    const budget = providerBudget(key)
    log.ai.info(
      `[ai] provider call origin=manual provider=${budget.label} ` +
      `used=${budget.used}/${budget.cap} (${budget.manual} manual, ${budget.automated} automated)`
    )
  }
}

/**
 * Forget the persisted provider ledger. Tests only, and SEPARATE from
 * `resetModelHealth()` on purpose: model health is in-process state that a
 * restart is entitled to lose, while the ledger is the budget itself, and a
 * test that wants a clean rotation needs both cleared. Nothing in production
 * calls this, and that separation is what guarantees a relaunch cannot hand
 * the app a fresh allowance.
 */
export function resetProviderSpend(): void {
  clearProviderSpend()
  capAnnounced.clear()
  resetProviderKeyWarnings()
}

function getHealth(model: ApiModelConfig): ModelHealth {
  return modelHealth.get(modelKey(model)) ?? {
    nextAvailableAt: 0,
    consecutiveFailures: 0,
    circuitOpenUntil: 0
  }
}

function isModelAvailable(model: ApiModelConfig): boolean {
  const now = Date.now()
  const health = getHealth(model)
  return now >= health.circuitOpenUntil && now >= health.nextAvailableAt
}

function availableModels(): ApiModelConfig[] {
  return eligibleModels().filter(isModelAvailable)
}

/**
 * When one model becomes callable again, from its health entry alone.
 *
 * Both clocks are honoured because either can be the binding one. A
 * circuit break sets both (`nextAvailableAt = circuitOpenUntil`), but a
 * later transient failure re-writes `nextAvailableAt` with a much
 * shorter cooldown while the circuit is still open — reading only
 * `nextAvailableAt` would then say the model is nearly callable again
 * when it is silenced for the rest of the hour.
 */
function modelFreeAt(model: ApiModelConfig): number {
  const health = getHealth(model)
  return Math.max(health.nextAvailableAt, health.circuitOpenUntil)
}

/**
 * Is any model callable right now, and if not, when does the first one
 * free up?
 *
 * The single answer to "can this app spend a request?", derived from
 * the same `modelHealth` map `availableModels()` reads, so it can never
 * disagree with the rotation. Two consumers, one query:
 *
 *   - the queue, which parks itself on `nextAvailableAt` instead of
 *     waking on its own ladder to re-probe a provider that said no
 *   - the UI, which has to be able to say "no provider is available"
 *     without reading a log
 *
 * `blocked` is deliberately false when nothing is eligible at all
 * (every model disabled, or the pool is all rerank/embeddings models).
 * "No models configured" is a settings problem with its own copy
 * ("Add one in Settings"), not a rate-limit outage, and reporting it as
 * blocked would point the user at the wrong screen.
 *
 * `nextAvailableAt` is null whenever nothing is blocked. A blocked answer
 * is always accompanied by a real time, so a caller never has to invent a
 * fallback wake-up.
 */
export interface ProviderAvailability {
  blocked: boolean
  /** Epoch ms the first eligible model frees up, or null when not blocked. */
  nextAvailableAt: number | null
  /** How many models are eligible at all — 0 is the "no models configured" case. */
  eligibleCount: number
}

export function providerAvailability(now: number = Date.now()): ProviderAvailability {
  const models = eligibleModels()
  if (models.length === 0) return { blocked: false, nextAvailableAt: null, eligibleCount: 0 }
  let earliest = Number.POSITIVE_INFINITY
  for (const model of models) {
    const freeAt = modelFreeAt(model)
    if (freeAt <= now) return { blocked: false, nextAvailableAt: null, eligibleCount: models.length }
    if (freeAt < earliest) earliest = freeAt
  }
  return { blocked: true, nextAvailableAt: earliest, eligibleCount: models.length }
}

function recordModelSuccess(model: ApiModelConfig): void {
  modelHealth.delete(modelKey(model))
}

const MAX_429_BACKOFF_MS = 10 * 60 * 1000
const CIRCUIT_BREAKER_MS = 60 * 60 * 1000
const SERVER_ERROR_BACKOFF_MS = 15000

// Timeout (network-error) cooldown.
//
// A timeout is the one failure that costs the full per-attempt budget and
// returns nothing: the abort timer is armed per model inside the rotation
// loop, so a hung model burns DEFAULT_CALL_TIMEOUT_MS (45s, or its own
// `timeout_ms`) before the rotation moves on. The cooldown it used to be
// handed was a flat 5s — shorter than the gap between any two queue items
// — so the model was eligible again on the very next item and got re-walked,
// and re-aborted at full cost, on essentially every rotation. Every abort
// incremented `consecutiveFailures` and this branch never looked at it, so a
// model could hang forever without ever being backed off further.
//
// The cooldown is therefore proportional to the budget that was just
// burned, and escalates with the same exponential shape the 429 ladder
// already uses:
//
//   min(base x 2^(consecutiveFailures - 1), max(MAX_TIMEOUT_COOLDOWN_MS, base))
//
// where base is the timeout actually armed for that attempt — a model's own
// `timeout_ms` when it has a usable one, else DEFAULT_CALL_TIMEOUT_MS, which
// is deliberately not hardcoded here. At the 45s default that is
// 45s -> 90s -> 180s -> 300s (capped) -> 300s, so the first abort already
// outlasts any plausible gap between queue items and a permanently hung
// model settles at one re-walk per 5 minutes instead of one per item.
//
// The cap is 5 minutes, deliberately below MAX_429_BACKOFF_MS (10 min) and an
// order of magnitude below CIRCUIT_BREAKER_MS (1 h): a timeout is a
// transient "we gave up waiting", not a verdict about the model, so it must
// never silence one as hard as a 429 or a 401/402/404 does. It is floored
// at the model's own budget so a slow model is never re-walked sooner than
// the timeout it just burned.
//
// A success deletes the health entry outright (recordModelSuccess), so the
// whole ladder — cooldown and counter — is gone the moment the model works
// again. Nothing here can outlive a working model.
const TIMEOUT_COOLDOWN_BASE_FACTOR = 1
const MAX_TIMEOUT_COOLDOWN_MS = 5 * 60 * 1000

function timeoutCooldownMs(
  model: ApiModelConfig,
  attemptTimeoutMs: number | undefined,
  consecutiveFailures: number
): number {
  // The same resolution the abort timer used, so the cooldown is literally
  // "the budget that was just burned". getCallTimeoutMs already discards a
  // nonsense `timeout_ms` and clamps an absurd one to MAX_CALL_TIMEOUT_MS.
  const base = getCallTimeoutMs(model, attemptTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS)
  const ladder = base * TIMEOUT_COOLDOWN_BASE_FACTOR * 2 ** (Math.max(1, consecutiveFailures) - 1)
  return Math.min(ladder, Math.max(MAX_TIMEOUT_COOLDOWN_MS, base))
}

function recordModelFailure(
  model: ApiModelConfig,
  statusCode: number | null,
  isTimeout: boolean,
  attemptTimeoutMs?: number
): void {
  const key = modelKey(model)
  const health = getHealth(model)
  health.consecutiveFailures++

  if (statusCode === 429) {
    const backoff = Math.min(15000 * 2 ** (health.consecutiveFailures - 1), MAX_429_BACKOFF_MS)
    health.nextAvailableAt = Date.now() + backoff
  } else if (statusCode === 401 || statusCode === 402 || statusCode === 403 || statusCode === 404) {
    // Persistent client errors: open circuit breaker for 1 hour so we don't
    // burn seconds on every request retrying a dead/payment-required model.
    // 403 (forbidden) is here for the same reason: measured 61x in ai.log,
    // every one of them the same permanently-forbidden model, each earning
    // a 15s cooldown and being re-walked on the next rotation forever.
    health.circuitOpenUntil = Date.now() + CIRCUIT_BREAKER_MS
    health.nextAvailableAt = health.circuitOpenUntil
  } else if (isTimeout) {
    health.nextAvailableAt = Date.now() + timeoutCooldownMs(model, attemptTimeoutMs, health.consecutiveFailures)
  } else {
    // 5xx and other transient errors.
    health.nextAvailableAt = Date.now() + SERVER_ERROR_BACKOFF_MS
  }

  modelHealth.set(key, health)
}

function coalesceKey(systemPrompt: string, userPrompt: string, temperature: number, maxTokens: number): string {
  return `${hashString(systemPrompt)}:${hashString(userPrompt)}:${temperature}:${maxTokens}`
}

const inFlightRequests = new Map<string, Promise<CallAIResult>>()

async function tryModels(
  models: ApiModelConfig[],
  systemPrompt: string,
  userPrompt: string,
  temperature: number,
  timeoutMs: number,
  externalSignal?: AbortSignal,
  validateResponse?: (content: string) => boolean,
  excludeModelIds?: ReadonlySet<string>,
  manual = false
): Promise<CallAIResult> {
  let content: string | null = null
  let modelUsed: string | null = null
  let rateLimited = false
  const errors: string[] = []
  let validationFailures = 0
  const attempted: string[] = []
  // Cap refusals are counted separately from ordinary failures so that "every
  // model in the rotation was refused because the provider is out of budget"
  // can be reported as THAT, with the provider's numbers, rather than as
  // "all N models failed".
  const capRefusals: ProviderBudget[] = []
  // Where in `errors` the cap lines landed, so the summary below can show
  // what else was tried without repeating them.
  const capErrorIndexes = new Set<number>()

  for (const model of models) {
    // P1.5: skip models the caller asked to exclude (bounded retry on
    // parse_failed at a higher level). Comparing on the same canonical
    // key modelKey() uses — model.id (or base_url::model slug).
    const key = modelKey(model)
    if (excludeModelIds && excludeModelIds.has(key)) {
      errors.push(`${model.name}: excluded by caller's exclude set`)
      continue
    }
    attempted.push(key)

    // Resolved per model, not per call: `timeout_ms` is a property of the
    // model being tried, and the rotation below may try several with
    // different ones.
    const attemptTimeoutMs = getCallTimeoutMs(model, timeoutMs)

    // Opt-in per-request trace. Set FLOW_JOB_DEBUG_AI=1 in the shell before
    // launching the app to enable; the cost when disabled is one string
    // compare per request.
    if (process.env.FLOW_JOB_DEBUG_AI === '1') {
      // The running spend rides along on this existing line rather than
      // getting one of its own: a synchronous log write per automated
      // request is not free (measured: it dominated the cost of the
      // store-heavy queue simulations), and a trace that already fires once
      // per request is the right place for "and this is what it has cost".
      const spent = providerBudget(providerKey(model))
      log.ai.info(
        `[ai] req name="${model.name}" host=${hostOf(model.base_url)} key=${fingerprintKey(model.api_key)} modelId=${model.model} max_tokens=${getMaxTokens(model)} timeout_ms=${attemptTimeoutMs} spend=${spent.used}/${spent.cap} body=${redactBody('')}`
      )
    }
    // -----------------------------------------------------------------
    // THE SPEND GATE.
    //
    // Placed here, immediately before the request is issued and nowhere
    // else, because this is the only point at which "we are about to spend"
    // is a fact rather than an intention. Above it a model can be chosen,
    // skipped, excluded or failed over without costing anything; below it
    // the request has been made and whatever comes back is what it cost.
    //
    // So: an automated call whose provider has no budget left is refused
    // here and never reaches `fetch`, and a call that IS issued is counted
    // here — once, before the response is known, so a 429, a timeout and an
    // HTTP 200 carrying a billing notice all count alike, because they all
    // cost the same. A manual call skips the refusal but not the count.
    //
    // Refusing per model is what makes the rotation walk PAST a spent
    // provider: the loop continues to the next model, so a pool that mixes a
    // capped provider with a funded one keeps working on the funded one.
    // -----------------------------------------------------------------
    const provider = providerKey(model)
    if (!manual) {
      const over = providerOverCap(provider)
      if (over) {
        noteProviderCap(over)
        capRefusals.push(over)
        capErrorIndexes.add(errors.length)
        errors.push(`${model.name}: ${describeProviderCap(over)}`)
        // No cooldown is written to modelHealth here on purpose. That map is
        // shared with manual work — it is what `availableModels()` filters
        // on — so cooling a model down for a reason that applies only to
        // AUTOMATED spend would make the user's own Generate quietly defer
        // to a queue row instead of running. The budget is its own cooldown:
        // it is checked here and again at the top of callAI, and it survives
        // a restart because it is the persisted ledger rather than anything
        // held in memory.
        continue
      }
    }
    countProviderCall(provider, manual)

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (model.api_key) headers['Authorization'] = `Bearer ${model.api_key}`
      const abort = new AbortController()
      const timer = setTimeout(() => abort.abort(), attemptTimeoutMs)
      // Honor an external abort (e.g. scan cancel) so the in-flight
      // HTTP request tears down immediately rather than waiting the
      // full per-attempt timeout (45s by default). Without this,
      // canceling a scan leaves LLM requests running server-side until
      // the timeout.
      const onExternalAbort = () => abort.abort()
      if (externalSignal) {
        if (externalSignal.aborted) abort.abort()
        else externalSignal.addEventListener('abort', onExternalAbort, { once: true })
      }
      const response = await fetch(`${model.base_url}/chat/completions`, {
        method: 'POST',
        headers,
        signal: abort.signal,
        body: JSON.stringify({
          model: model.model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
          ],
          temperature,
          max_tokens: getMaxTokens(model)
        })
      })
      clearTimeout(timer)
      if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort)
      if (response.ok) {
        const data = (await response.json()) as {
          choices: {
            message: { content: string; reasoning_content?: unknown }
          }[]
        }
        content = data.choices[0]?.message?.content ?? null
        // A provider that is out of credit answers HTTP 200 with a
        // plaintext billing/quota notice in `content`, not a model
        // answer. Measured: 337 of 353 parse-failure log lines in
        // fit.log were one. Checked BEFORE the validator and before the
        // `if (content)` success branch below, because:
        //   - verify / fit pass NO validator, so nothing else stands
        //     between this body and `recordModelSuccess`, which DELETES
        //     the health entry — erasing the failure history of a
        //     provider that is out of credit on every single call, so
        //     it never cools down and returns to the front of the
        //     rotation (it looked healthy BECAUSE it was failing).
        //   - on the CV path the validator does reject it, but as a
        //     soft failure that explicitly declines to circuit-break.
        // Routing it here records 402 instead, so the existing 1h
        // circuit breaker engages and it is skipped for an hour.
        if (content && looksLikeProviderNotice(content)) {
          errors.push(`${model.name}: ${describeProviderNotice(content)}`)
          recordModelFailure(model, 402, false)
          content = null
          // Continue to the next model. Deliberately skipping the
          // `empty response` branch below: that would record a second,
          // soft failure on top of the circuit break.
          continue
        }
        if (content && validateResponse) {
          // Defensive validation gate. A model that returns HTTP 200
          // with reasoning-channel / planning-meta content (VL-style
          // deliberation pass) is treated as if it returned an empty
          // response — we move on to the next model in the rotation.
          // The fallback path (no validator or all-validators-fail)
          // is unchanged so non-tailored call sites behave as before.
          let valid = false
          try {
            valid = validateResponse(content)
          } catch (vErr) {
            errors.push(`${model.name}: validator threw ${vErr instanceof Error ? vErr.message : String(vErr)}`)
            valid = false
          }
          if (!valid) {
            validationFailures++
            errors.push(`${model.name}: response did not pass content validation`)
            // Record a soft failure (no HTTP error code from the
            // provider) so the per-model health tracker reflects the
            // bad output. We do NOT circuit-break on validation
            // failures — a model can improve tomorrow.
            recordModelFailure(model, null, false)
            content = null
            // continue to next model
          }
        }
        if (content) {
          modelUsed = model.name || model.model
          recordModelSuccess(model)
          break
        }
        if (!validateResponse || errors.length === 0) {
          // No validator OR no error entry yet — keep the empty-response error.
          errors.push(`${model.name}: empty response`)
          recordModelFailure(model, null, false)
        }
      } else if (response.status === 429) {
        rateLimited = true
        errors.push(`${model.name}: rate limited (429)`)
        recordModelFailure(model, 429, false)
      } else if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 425) {
        // Persistent client error — auth, payment required, not found, etc.
        // These won't fix themselves on retry, so record the failure with
        // a short, labeled reason and continue to the next model instead of
        // wasting the rest of the rotation on a known-bad config.
        const label = response.status === 401 ? 'unauthorized (401)'
          : response.status === 402 ? 'payment required (402)'
          : response.status === 403 ? 'forbidden (403)'
          : response.status === 404 ? 'not found (404)'
          : `HTTP ${response.status}`
        const errText = await response.text().catch(() => '')
        // Truncate + collapse whitespace so a chatty error page doesn't
        // blow up the toast with megabytes of HTML.
        const trimmed = errText.replace(/\s+/g, ' ').trim().slice(0, 200)
        errors.push(trimmed ? `${model.name}: ${label} — ${trimmed}` : `${model.name}: ${label}`)
        recordModelFailure(model, response.status, false)
      } else {
        // 5xx, 408 (request timeout), 425 (too early) — transient, worth
        // continuing to the next model.
        errors.push(`${model.name}: HTTP ${response.status}`)
        recordModelFailure(model, response.status, false)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error'
      const isTimeout = msg.includes('aborted')
      errors.push(`${model.name}: ${isTimeout ? 'timeout' : msg}`)
      // The resolved per-model timeout travels with the failure so the
      // timeout cooldown can scale off the budget this attempt actually
      // burned. A non-timeout throw carries isTimeout=false and lands on
      // recordModelFailure's other-transient branch, which ignores it.
      recordModelFailure(model, null, isTimeout, attemptTimeoutMs)
    }
  }

  if (!content && capRefusals.length > 0) {
    // Some model in the rotation was refused by the budget. That is a real
    // part of why this call produced nothing, and it is the part the user
    // can act on, so it leads the message rather than being buried in the
    // error list.
    //
    // Checked BEFORE the 429 report below, deliberately. A capped provider
    // produces 429s too — indeed a spent budget is usually a throttled one —
    // so "every model is rate limited, try again in a minute" is true and
    // useless: the budget frees in a day, not a minute, and the rotation
    // would keep re-walking into the cap for the whole hour it waited. And
    // as a RateLimitError (which this is) the queue parks the row until the
    // window slides instead of burning its retry budget on a limit that
    // resets on its own. Deduped per provider: twenty models on one capped
    // key is one sentence, not twenty.
    const seen = new Set<string>()
    const lines: string[] = []
    for (const budget of capRefusals) {
      if (seen.has(budget.key)) continue
      seen.add(budget.key)
      lines.push(describeProviderCap(budget))
    }
    const rest = errors.filter((_, i) => !capErrorIndexes.has(i)).join(' | ')
    // "ran out mid-rotation", not "no provider has budget": the rotation may
    // also have tried a provider that failed for an ordinary reason, and
    // those are reported alongside rather than folded in.
    throw new ProviderCapError(
      `AI provider budget exhausted during this call — ${lines.join(' ')}${rest ? ` (other attempts: ${rest})` : ''}`
    )
  }
  if (!content && rateLimited && validationFailures === 0) {
    throw new RateLimitError(`All ${models.length} configured AI models are rate limited — try again in a minute:\n${errors.join('\n')}`)
  }
  if (!content) {
    // Distinguish "all rate-limited / network errors" from "all
    // responses rejected by content validation". The latter is the
    // 2026-09-13 incident: VL models returned planning-meta text
    // instead of a CV, and the orchestrator silently persisted
    // garbage. Surfacing the validation failure lets the caller
    // (tailorDocument → tailorJobDocsForJob) raise a clear cv_failed
    // with the validator reason, and never persists base CV as a
    // "tailored" document.
    const detail = validationFailures === errors.length && errors.length > 0
      ? `all ${errors.length} response${errors.length === 1 ? '' : 's'} failed validation`
      : `errors: ${errors.join(' | ')}`
    throw new Error(`All ${models.length} configured AI models failed — ${detail}`)
  }

  return { content, modelUsed, rateLimited: false, errors: [], attempted }
}

/**
 * Try all configured AI models.
 * - Returns content + modelUsed on first success.
 * - If all fail and at least one returned 429, throws RateLimitError.
 * - If all fail for other reasons, throws Error with collected error messages.
 *
 * Implements per-model 429 cooldown (exponential backoff), circuit breaker for
 * persistent client errors (401/402/404), and request coalescing so duplicate
 * concurrent calls share a single in-flight request.
 *
 * validateResponse (optional): per-model content validator. When provided,
 * each model's `content` is checked before being accepted; rejected
 * responses are treated as if the model returned empty and the rotation
 * moves on. Used by tailorDocument to reject reasoning-channel /
 * planning-meta output (CV incident 2026-09-13). Coalescing keys do NOT
 * vary by validator — concurrent calls with different validators share
 * an in-flight request as long as prompt+temperature+max_tokens match;
 * the response is whatever the first caller observes, so callers that
 * pass a validator MUST be comfortable receiving unvalidated content in
 * that race. validateResponse-on-rejection is therefore best applied
 * per call site rather than as a global guarantee.
 *
 * excludeModelIds (optional): canonical model keys (model.id or
 * base_url::model) to skip in the rotation. Used by parse_failed retry
 * to exclude the model that produced the bad output. Cannot be used
 * with coalescing: callers that exclude models MUST not race against
 * a different exclusion set on the same prompt+temperature+max_tokens
 * — callAI documents this as a per-call-site guarantee, not a
 * process-wide one.
 */
/**
 * One LLM request at a time, app-wide.
 *
 * Callers enqueue by chaining onto `requestChain`; each waits for its
 * turn and hands the chain to the next. Two properties matter and both
 * come from chaining on the settled (not the raw) promise:
 *
 *   - FIFO, so requests go out in the order work was requested.
 *   - releases on rejection, so a failed or throwing call does not
 *     block every later call for the life of the process.
 */
let requestChain: Promise<unknown> = Promise.resolve()

function serializeRequest<T>(fn: () => Promise<T>): Promise<T> {
  const run = requestChain.then(fn, fn)
  requestChain = run.then(
    () => undefined,
    () => undefined
  )
  return run
}

/**
 * One AI *operation* at a time — a whole unit of work, not one request.
 *
 * `serializeRequest` alone was not enough. An operation that makes
 * several requests (tailoring a CV and a cover letter, or a retry loop)
 * released the gate between them, so a competing operation's request
 * landed in the middle: a document being written for one job could have
 * another job's review interleaved with it. The provider sees one
 * request either way, but the work itself was no longer one-at-a-time.
 *
 * Applied at the OUTERMOST boundary only — the queue's `processItem` and
 * the IPC handlers that call the scorers/tailorers directly. The AI
 * functions themselves are deliberately NOT wrapped, because
 * `processItem` calls them: wrapping both layers would be a re-entrant
 * acquire and would deadlock the queue on itself. Callers that are not
 * wrapped (a scan's keyword extraction, say) still get request-level
 * serialization from `serializeRequest`.
 *
 * Same chaining shape as `serializeRequest`, and for the same reason: it
 * is FIFO, and it releases on rejection so one failed operation cannot
 * wedge every later one for the life of the process.
 */
let operationChain: Promise<unknown> = Promise.resolve()

export function withAiOperation<T>(fn: () => Promise<T>): Promise<T> {
  const run = operationChain.then(fn, fn)
  operationChain = run.then(
    () => undefined,
    () => undefined
  )
  return run
}

export async function callAI(
  systemPrompt: string,
  userPrompt: string,
  temperature = 0.7,
  timeoutMs = DEFAULT_CALL_TIMEOUT_MS,
  externalSignal?: AbortSignal,
  validateResponse?: (content: string) => boolean,
  excludeModelIds?: ReadonlySet<string>,
  opts?: AiCallOptions
): Promise<CallAIResult> {
  // Absent means AUTOMATED — see `AiCallOptions`. Read once here and passed
  // down, so the rotation and the request cannot disagree about who asked.
  const manual = opts?.manual === true

  const available = availableModels()
  const allEligible = eligibleModels()

  if (allEligible.length === 0) {
    throw new Error('No enabled AI models configured. Add one in Settings.')
  }

  if (available.length === 0) {
    // Every eligible model is on cooldown or circuit-broken, so this call
    // cannot reach the provider. Typed as its own subclass because that
    // is the whole difference: a caller charging this an attempt is
    // charging a ~70ms local map lookup the price of a 45s request. See
    // ProviderCooldownError.
    //
    // `availableModels()` filters on cooldown/circuit-break ONLY — the
    // spend cap is applied below, when `models` is built. So an empty
    // `available` really is "everything is cooling down", and cap
    // exhaustion still reports itself as ProviderCapError further down.
    throw new ProviderCooldownError()
  }

  // The spend cap, as a pre-filter. This is the "cooldown" a capped provider
  // is put into: the rotation walks past it here rather than walking INTO it
  // and discovering it one refused request at a time, so a pool that mixes a
  // spent provider with a funded one keeps answering from the funded one.
  //
  // It is a filter and not a block precisely because it is not applied to
  // manual work — the user's own Generate, Regenerate, Verify and Tailor
  // find their models here exactly as they always did.
  const capped: ProviderBudget[] = []
  const models = manual
    ? available
    : available.filter((m) => {
        const over = providerOverCap(providerKey(m))
        if (!over) return true
        noteProviderCap(over)
        capped.push(over)
        return false
      })

  if (models.length === 0) {
    // Everything that is not cooling down is out of budget. Say so with the
    // provider's own numbers rather than letting the rotation fail on the
    // generic path, which would report this as N broken models.
    const seen = new Set<string>()
    const lines: string[] = []
    for (const budget of capped) {
      if (seen.has(budget.key)) continue
      seen.add(budget.key)
      lines.push(describeProviderCap(budget))
    }
    throw new ProviderCapError(`No AI provider has budget left — ${lines.join(' ')}`)
  }

  const maxTokens = getMaxTokens()
  const key = coalesceKey(systemPrompt, userPrompt, temperature, maxTokens)
  const existing = inFlightRequests.get(key)
  if (existing) {
    // Coalescing cannot honor per-call excludeModelIds — two concurrent
    // callers with different exclusion sets would receive whatever the
    // first one observed. Refuse to coalesce when the exclude set is
    // non-empty so each retry attempt is uncontended and predictable.
    if (excludeModelIds && excludeModelIds.size > 0) {
      // fall through and start a fresh request
    } else {
      if (process.env.FLOW_JOB_DEBUG_AI === '1') {
        log.ai.info('[ai] coalescing duplicate request')
      }
      return existing
    }
  }

  // Every real request passes through one gate, so exactly one is ever
  // in flight app-wide. The queue processor is already serial, but five
  // IPC handlers call the scorers/tailorers directly (Recompute Fit,
  // Tailor, Verify), and those used to run alongside a queue item — two
  // concurrent requests against the same provider, which is the last
  // thing that helps when the provider is already rate limiting.
  //
  // A promise chain, not a counter: it is FIFO by construction and it
  // releases on rejection, so one failed call cannot wedge every later
  // call for the rest of the session. Coalescing is unaffected — that
  // returns the already-in-flight promise above and never enters here.
  const promise = serializeRequest(() =>
    tryModels(models, systemPrompt, userPrompt, temperature, timeoutMs, externalSignal, validateResponse, excludeModelIds, manual)
  )
  inFlightRequests.set(key, promise)
  promise.then(
    () => inFlightRequests.delete(key),
    () => inFlightRequests.delete(key)
  )
  return promise
}

// Exported for tests (P0.3 §3.3 — negative-example prompt hardening
// regression guard). Not part of the public surface; treat as internal.
export const EXTRACTION_SYSTEM_PROMPT = `You extract keywords from a job description for ATS and recruiter screening.
Return JSON only, no markdown, no prose.

{
  "keywords": [
    {
      "phrase":   string,
      "weight":   number,
      "category": "hard" | "soft" | "cert" | "seniority",
      "source":   "title" | "required" | "preferred" | "body"
    }
  ]
}

Rules:
- Extract ONLY what the JD explicitly says. Do not infer.
- 1-3 word phrases. Never single letters. Never sentence fragments.
- Multi-word phrases beat unigrams: "machine learning" not "learning".
- source='title' if the phrase appears in the JD title line; else 'required'
  if it is in a Required/Qualifications block; else 'preferred' if it is in
  a Preferred/Nice-to-have block; else 'body'.
- weight reflects how important the phrase is for ATS + recruiter screening,
  not how many times it appears.
- Aim for 25-40 candidates. Err on the side of more.

Do NOT extract (these pollute the top-30 and crowd out real skills):
- Location, country, region, or work-authorization: "canada", "united
  states", "united kingdom", "north america", "remote", "hybrid", "on-site",
  "based in X", "located in X", city or province names, time zones, or any
  phrase whose only purpose is to constrain where the candidate lives.
- Years-of-experience boilerplate: "5+ years", "3-5 years experience",
  "1-2 years experience", "years of experience" — these describe seniority,
  not a skill.
- Degree / certification requirement boilerplate: "bachelor's degree",
  "university degree", "master's", "phd" — unless the JD explicitly treats
  the degree as a hard requirement AND the same job has no equivalent
  professional experience path (e.g., a JD-issued PE license). When in
  doubt, omit.
- Employment-type boilerplate: "full-time", "part-time", "contract",
  "permanent", "salary", "equity", "benefits".
- Generic soft-skill filler that every JD mentions: "communication",
  "teamwork", "leadership", "problem solving", "self-starter", "detail
  oriented", "time management" — unless the JD singles one out as a
  must-have and ties it to a concrete responsibility.

Output JSON only.`

/**
 * v3 LLM keyword extractor. Produces structured candidates from the JD
 * directly; the rule pipeline (extractJobKeywordsStructured) is the
 * deterministic safety net and the source of the section source field.
 *
 * Throws KeywordExtractionError on UNRECOVERABLE failures (callAI
 * failure, no content, no JSON, JSON parse error, JSON not an object,
 * JSON missing the keywords array) — the rule pipeline cannot backfill
 * these. Returns the partial valid subset (possibly empty) when the
 * LLM responded but some/all individual candidates failed validation
 * — the rule pipeline still backfills on empty, and any survivors
 * merge into the final top-30.
 */
export async function extractJobKeywordsLLM(
  description: string,
  signal?: AbortSignal,
  opts?: AiCallOptions
): Promise<KeywordEntry[]> {
  const userPrompt = `JD:\n${description}`

  let result: Awaited<ReturnType<typeof callAI>>
  try {
    result = await callAI(EXTRACTION_SYSTEM_PROMPT, userPrompt, 0.3, DEFAULT_CALL_TIMEOUT_MS, signal, undefined, undefined, opts)
  } catch (err) {
    throw new KeywordExtractionError(
      `callAI failed: ${err instanceof Error ? err.message : String(err)}`
    )
  }

  if (!result.content) {
    throw new KeywordExtractionError('callAI returned no content')
  }

  const match = result.content.match(/\{[\s\S]*\}/)
  if (!match) {
    throw new KeywordExtractionError('No JSON object found in LLM response')
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(match[0])
  } catch {
    throw new KeywordExtractionError('Failed to parse JSON from LLM response')
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new KeywordExtractionError('LLM JSON is not an object')
  }
  const obj = parsed as Record<string, unknown>
  if (!Array.isArray(obj.keywords)) {
    throw new KeywordExtractionError('LLM JSON missing "keywords" array')
  }

  const entries: KeywordEntry[] = []
  for (const item of obj.keywords) {
    if (typeof item !== 'object' || item === null) continue
    const it = item as Record<string, unknown>
    if (typeof it.phrase !== 'string' || it.phrase.trim() === '') continue
    if (typeof it.weight !== 'number' || it.weight < 0 || it.weight > 1) continue
    if (typeof it.category !== 'string' || !KEYWORD_CATEGORIES.has(it.category as KeywordCategory)) continue
    if (typeof it.source !== 'string' || !KEYWORD_SOURCES.has(it.source as KeywordSource)) continue
    entries.push({
      phrase: it.phrase.toLowerCase().trim(),
      weight: it.weight,
      category: it.category as KeywordCategory,
      source: it.source as KeywordSource
    })
  }

  // P0.3 §3.4: return the partial valid subset (possibly empty) instead
  // of throwing. The orchestrator's catch path only fires for
  // unrecoverable failures (callAI / parse); an LLM response that
  // survived JSON parsing but yielded zero valid candidates is no
  // worse than the LLM returning [] directly, and the rule pipeline
  // backfills either way. Crucially, when SOME candidates validate,
  // we no longer throw the good ones away with the bad.
  return entries
}

/**
 * v3 orchestrator. Runs the rule pipeline (sync) and the LLM extractor
 * (async) in parallel-ish: rule finishes first (CPU-only, ~5ms), then LLM
 * runs. If LLM fails for any reason, returns the rule-only result with
 * refinedByLlm=false. The LLM and rule candidates are merged by
 * mergeKeywordResults: LLM wins category+weight, rule wins section source,
 * and LLM-only-not-in-allowlist phrases are downweighted 0.8x and surfaced
 * in unknownPhrases for allowlist review.
 */
export async function extractJobKeywordsV3(
  description: string,
  signal?: AbortSignal,
  opts?: AiCallOptions
): Promise<KeywordResult> {
  const ruleResult = extractJobKeywordsStructured(description)
  const ruleCandidates = ruleResult.keywords

  let llmCandidates: KeywordEntry[] = []
  try {
    llmCandidates = await extractJobKeywordsLLM(description, signal, opts)
  } catch (err) {
    log.ai.warn(
      '[ai] v3 LLM extraction failed, falling back to rule-only:',
      err instanceof Error ? err.message : String(err)
    )
    return {
      keywords: ruleCandidates,
      refinedByLlm: false,
      unknownPhrases: []
    }
  }

  const merged = mergeKeywordResults(llmCandidates, ruleCandidates, loadKeywordAllowlists())
  if (merged.unknownPhrases.length > 0) {
    log.ai.info('[ai] v3 unknown phrases:', merged.unknownPhrases)
  }
  return merged
}

export async function tailorDocument(request: TailorRequest, opts?: AiCallOptions): Promise<TailorResult> {
  const settings = getSettings()
  const job = getJob(request.job_id)
  if (!job) throw new Error('Job not found')

  const baseContent =
    request.base_content ||
    settings.base_cv ||
    'No base CV provided. Add your base CV in Settings.'

  // Derive structured keywords from the job description via the v3
  // orchestrator (LLM-first with rule-pipeline safety net). The orchestrator
  // returns the refined topKeywords + unknownPhrases. If the LLM is
  // unavailable, the orchestrator falls back to the rule-only result; the
  // prompt still gets keyword coverage hints rather than nothing.
  let refinedTopKeywords: string[] | undefined = request.topKeywords
  let keywordRefinedByLlm = false
  if (!refinedTopKeywords || refinedTopKeywords.length === 0) {
    if (job.description) {
      try {
        const result = await extractJobKeywordsV3(job.description, undefined, opts)
        refinedTopKeywords = result.keywords.map((k) => k.phrase)
        keywordRefinedByLlm = result.refinedByLlm
      } catch (err) {
        log.ai.warn('[ai] tailor keyword derivation failed, falling back to flat extract:', err instanceof Error ? err.message : String(err))
        refinedTopKeywords = extractJobKeywords(job.description)
      }
    }
  }

  const systemPrompt =
    request.document_type === 'cv'
      ? buildHarvardCvInstructions(await loadHarvardTemplate(), refinedTopKeywords)
      : (() => {
          const keywordLine =
            refinedTopKeywords && refinedTopKeywords.length > 0
              ? `\nKEYWORD COVERAGE (overrides verbosity):\n- Aim to mention at least 72% of the key terms from the job description.\n- High-priority keywords (include where truthful): ${refinedTopKeywords.join(', ')}\n`
              : `\nKEYWORD COVERAGE (overrides verbosity):\n- Aim to mention at least 72% of the key terms from the job description.\n`
          return `You are an expert career coach. Write a compelling, personalized cover letter for this job.
Keep it concise (3-4 paragraphs), professional, and specific to the role. Output plain text only.

ONE-PAGE RULE (overrides verbosity):
- The output MUST fit on a single US-Letter page at 11pt Calibri with 0.6in/0.7in margins.
- Hard ceiling: 3-4 paragraphs. If the role has more to say, prioritize the points most relevant to the job and CUT the rest. Do not abbreviate, do not shrink, do not move to a second page.
- Never pad with filler to "fill" the page — sparse is correct when the background is sparse.
${keywordLine}
CRITICAL — TRUTHFULNESS: reference ONLY the candidate's actual experience, skills, and projects from the Base CV / Background below. Do NOT fabricate employers, job titles, technologies, achievements, or metrics. You may reword and reframe the candidate's real experience to align with the role, but you must not invent anything that is not in the Base CV.`
        })()

  const userPrompt = `Job Title: ${job.title}
Company: ${job.company}
Location: ${job.location ?? 'Not specified'}

Job Description:
${job.description ?? 'No description provided.'}

Candidate Name: ${settings.user_name || 'Candidate'}
Candidate Email: ${settings.user_email || ''}

Base CV / Background:
${baseContent}

${request.document_type === 'cover_letter' ? 'Write a tailored cover letter.' : 'Tailor this CV for the role.'}`

  let content: string
  let modelUsed: string | null = null
  // P1.4: structural content validator. tailors the rotation to skip
  // models that emit reasoning-channel / planning-meta text instead of
  // a real CV / cover letter. See looksLikeHarvardCv above for the
  // signature coverage; CVs have TAB-aligned structural markers that
  // cover letters do not, so we use the dedicated validator for CVs and
  // skip validation for cover letters (the paragraph-cap enforcement in
  // sanitizeDocument covers those).
  //
  // WHAT THIS FUNCTION DOES NOT DO, and what every caller therefore owes
  // it: it STORES the raw provider output, because the ceilings and the
  // rule checks can only run once the model has returned. "Downstream"
  // used to read as if that were automatic. It is not — it is a duty, and
  // there are exactly three callers:
  //
  //   aiQueue.ts            the per-unit generate_cv / generate_cover_letter
  //                         case  -> sanitizes, stores via setDocumentContent
  //   tailorJobDocs.ts      tailorJobDocsForJob (both documents at once)
  //                         -> sanitizes, stores via setDocumentContent
  //   main.ts               the `ai:tailor` handler, i.e. the Tailor /
  //                         Generate button -> sanitizes, stores via
  //                         setDocumentContent
  //
  // All three call the ONE `sanitizeDocument` (electron/tailorJobDocs.ts),
  // and a fourth store path must not be added without it. The `ai:tailor`
  // handler did not, for as long as this comment implied it did.
  const validator = request.document_type === 'cv' ? looksLikeHarvardCv : undefined
  try {
    const result = await callAI(systemPrompt, userPrompt, 0.7, DEFAULT_CALL_TIMEOUT_MS, undefined, validator, undefined, opts)
    content = result.content!
    modelUsed = result.modelUsed
  } catch (err) {
    if (err instanceof RateLimitError) throw err
    // ProviderCooldownError included: it is a RateLimitError, and the
    // queue is what turns it into a wait rather than a spent attempt. It
    // must reach processItem's catch as itself — a heuristic CV written
    // here instead would look like a finished job.
    // P1.4: validation failure (every model in the rotation returned
    // content the validator rejected — typically reasoning-channel /
    // planning-meta text) is a real tailoring failure, not a network
    // / rate-limit blip. Do NOT fall back to the un-tailored base CV
    // (the prior behavior was to persist baseCv as a "tailored" CV,
    // which is worse than failing cleanly). Surface the error so
    // tailorJobDocsForJob can record cv_failed with the validator
    // reason and the user can retry once a healthier model is added
    // or the bad ones are pruned via Settings → Models.
    if (err instanceof Error && /failed validation|did not pass/i.test(err.message)) {
      throw new TailoredOutputValidationError(
        request.document_type,
        err.message
      )
    }
    // Non-rate-limit, non-validation failure: a real network/parser
    // error, etc. Fall back to base CV / template (legacy safety net).
    content = generateFallbackDocument(job, request.document_type, baseContent, settings)
  }

  const title =
    `${request.document_type === 'cv' ? 'CV' : 'Cover Letter'} — ${job.company}`

  // P1.7 §2 auto-regeneration: `document_id` is set when this call is
  // a REBUILD of a document that already exists (it just failed its AI
  // review). The rebuild must overwrite that row in place, not mint a
  // new one: a fresh row would start the auto-regen counter from zero,
  // so the loop could never reach AUTO_REGEN_MAX, and the document the
  // user is left looking at would be a different row from the one the
  // job, the application and the queue item point at.
  if (request.document_id !== undefined) {
    const rebuilt = replaceDocumentContent(
      request.document_id,
      title,
      content,
      modelUsed || undefined
    )
    if (rebuilt) return { content, document_id: rebuilt.id }
    // The document was deleted while the LLM call was in flight.
    // Writing a replacement would resurrect it behind the user's back,
    // so this is a no-op the caller can treat as "nothing to store".
    return { content, document_id: request.document_id }
  }

  const doc = createDocument(
    request.document_type,
    title,
    content,
    job.id,
    false,
    modelUsed || undefined
  )

  return { content, document_id: doc.id }
}

function generateFallbackDocument(
  job: Job,
  type: 'cv' | 'cover_letter',
  baseCv: string,
  settings: { user_name: string; user_email: string }
): string {
  if (type === 'cover_letter') {
    return `Dear Hiring Manager,

I am writing to express my strong interest in the ${job.title} position at ${job.company}.

Based on my background and the requirements outlined in your posting, I believe I would be a strong fit for this role. My experience aligns well with what you're looking for, and I'm excited about the opportunity to contribute to your team.

${job.description ? `I was particularly drawn to this role because of: ${job.description.slice(0, 200)}...` : ''}

I would welcome the opportunity to discuss how my skills and experience can benefit ${job.company}. Thank you for considering my application.

Best regards,
${settings.user_name || 'Your Name'}
${settings.user_email || ''}`
  }

  return baseCv
}

export async function generateFollowUpMessage(
  company: string,
  jobTitle: string,
  daysSinceApplied: number,
  opts?: AiCallOptions
): Promise<string> {
  const settings = getSettings()

  const systemPrompt =
    'Write a brief, professional follow-up email for a job application. Plain text only, no subject line.'
  const userPrompt = `Company: ${company}\nRole: ${jobTitle}\nDays since applied: ${daysSinceApplied}\nCandidate: ${settings.user_name}`

  let content: string | null = null
  try {
    const result = await callAI(systemPrompt, userPrompt, 0.7, DEFAULT_CALL_TIMEOUT_MS, undefined, undefined, undefined, opts)
    content = result.content
  } catch {
    // No enabled models, or all failed — fall through to the plain-text fallback.
    content = null
  }

  if (content) return content

  return `Hi,

I wanted to follow up on my application for the ${jobTitle} position at ${company}, which I submitted ${daysSinceApplied} days ago. I remain very interested in this opportunity and would appreciate any update on the hiring process.

Thank you for your time.

Best regards,
${settings.user_name || 'Your Name'}`
}

const SECTION_HEADERS = new Set([
  'professional summary', 'summary', 'profile',
  'core competencies', 'competencies', 'skills', 'qualifications', 'technical skills',
  'professional experience', 'experience', 'work history', 'work experience',
  'education',
  'certifications', 'languages', 'interests', 'skills & interests', 'skills and interests',
  'projects', 'project experience',
  'leadership & activities', 'leadership and activities', 'activities', 'leadership',
  'publications', 'honors & awards', 'honors and awards', 'awards',
  'additional information', 'additional'
])

function isSectionHeader(line: string): string | null {
  const cleaned = line.toLowerCase().trim().replace(/[*_]/g, '')
  if (SECTION_HEADERS.has(cleaned)) return cleaned
  if (/^[a-z\s&]+$/.test(cleaned)) {
    const stripped = cleaned.replace(/[^a-z\s&]/g, '').trim()
    if (SECTION_HEADERS.has(stripped)) return stripped
  }
  return null
}

const NO_REGENERATE = new Set(['education'])
const NO_BULLET_SECTIONS = new Set(['skills & interests', 'skills and interests', 'skills', 'interests', 'certifications', 'languages', 'additional information', 'additional'])

interface Section {
  header: string
  name: string
  bodyLines: string[]
  startIdx: number
  endIdx: number
}

function parseSections(content: string): Section[] {
  const lines = content.split('\n')
  const sections: Section[] = []
  let currentHeader: string | null = null
  let currentName: string | null = null
  let currentStart = 0

  for (let i = 0; i < lines.length; i++) {
    const name = isSectionHeader(lines[i])
    if (name) {
      if (currentName !== null) {
        sections.push({
          header: lines[currentStart],
          name: currentName,
          bodyLines: lines.slice(currentStart + 1, i),
          startIdx: currentStart,
          endIdx: i
        })
      }
      currentHeader = lines[i]
      currentName = name
      currentStart = i
    }
  }

  if (currentName !== null) {
    sections.push({
      header: lines[currentStart],
      name: currentName,
      bodyLines: lines.slice(currentStart + 1),
      startIdx: currentStart,
      endIdx: lines.length
    })
  }

  return sections
}

export async function verifyDocumentContent(
  jobId: number,
  documentId: number,
  docType: 'cv' | 'cover_letter',
  opts?: AiCallOptions
): Promise<VerificationResult> {
  const job = getJob(jobId)
  if (!job) throw new Error('Job not found')
  const doc = getDocument(documentId)
  if (!doc) {
    // Document was deleted (or never existed) — return a SKIP rather than a
    // fake 100/100. Callers must treat this as "no review happened": they
    // MUST NOT persist a verification_score and MUST NOT trigger a regenerate
    // loop. We do still want to clean up the stale application pointer so
    // the next load() doesn't see a dangling reference.
    const apps = listApplications().filter((a) => a.job_id === jobId)
    for (const a of apps) {
      const update: Partial<typeof a> = {}
      if (docType === 'cv' && a.cv_document_id === documentId) update.cv_document_id = null
      if (docType === 'cover_letter' && a.cover_letter_document_id === documentId) update.cover_letter_document_id = null
      if (Object.keys(update).length > 0) updateApplication(a.id, update)
    }
    return { kind: 'skip', reason: 'deleted', feedback: 'Document was deleted; skipping verification.' }
  }

  const systemPrompt = `You are a strict career-document reviewer. Evaluate the ${docType === 'cv' ? 'CV/resume' : 'cover letter'} against the target job posting.

Rate the document 0-100 on these criteria:
- Relevance: Does the content directly address the job requirements?
- Keywords: Are key terms from the job description present?
- Specificity: Is it tailored to this specific role (not generic)?
- Formatting: Is the structure clean and professional?
- Accuracy: Are there any hallucinations or claims not supported by the base CV?

Output ONLY a JSON object with no markdown:
{"score": <0-100>, "passed": <true if score >= 70>, "feedback": "<2-3 sentence critique listing specific issues and the most important improvement>"}`

  const userPrompt = `Job Title: ${job.title}
Company: ${job.company}

Job Description:
${job.description || 'No description provided.'}

${docType === 'cv' ? 'CV' : 'Cover Letter'} Content:
${doc.content}

Evaluate how well this document is tailored for this specific job.`

  // P1.5: bounded retry on parse_failed. The user's enabled-model pool
  // is largely rate-limited / 402 / 400 (per ai.log 09-12/13), so a
  // single 429-d storm can knock the entire rotation offline. When
  // parseJsonObject returns null (no balanced JSON in the response),
  // retry on a DIFFERENT model up to 2 extra times before surfacing
  // the skip. The first attempt is the regular callAI; retries
  // exclude the model that produced the bad output.
  const MAX_RETRIES = 2
  const exclude = new Set<string>()
  let lastRaw = ''
  let lastModel: string | null = null
  let lastAttempted: string[] = []
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let aiResult
    try {
      aiResult = await callAI(
        systemPrompt, userPrompt, 0.3, DEFAULT_CALL_TIMEOUT_MS, undefined,
        undefined, exclude, opts
      )
    } catch (err) {
      // Rate-limit / no-config / network: surface as skip immediately.
      // The retry budget is for parse failures, not transport
      // failures — those are already handled by callAI's own rotation.
      // ProviderCooldownError included (it is a RateLimitError): the
      // queue must see the real type so a provider block costs no
      // attempt.
      if (err instanceof RateLimitError) throw err
      return {
        kind: 'skip',
        reason: 'parse_failed',
        feedback: lastRaw
          ? 'Could not parse the reviewer response.'
          : 'Verification failed before the reviewer could respond.'
      }
    }
    if (!aiResult.content) {
      return { kind: 'skip', reason: 'no_ai_response', feedback: 'No AI model responded to the verification request.' }
    }
    lastRaw = aiResult.content
    lastModel = aiResult.modelUsed
    lastAttempted = aiResult.attempted

    const parsed = parseJsonObject(aiResult.content) as
      | { score?: unknown; passed?: unknown; feedback?: unknown }
      | null
    if (parsed && typeof parsed === 'object') {
      const rawScore = Number(parsed.score)
      if (Number.isFinite(rawScore)) {
        const score = Math.max(0, Math.min(100, rawScore))
        const llmFeedback = typeof parsed.feedback === 'string' ? parsed.feedback : ''
        // Per-rule structural checks (one_page, paragraph_count,
        // skills_count, keyword_coverage) — run after the LLM review.
        // Each rule reports pass/fail with a detail string; the
        // overall `passed` flag is the AND of the LLM's own pass and
        // every rule check, so a structural failure can veto a high
        // LLM score.
        const rules: RuleCheck[] = runDocumentRuleChecks({
          document: doc.content,
          jobDescription: job.description || '',
          docType
        })
        const allRulesPassed = rules.every((r) => r.passed)
        const ruleSuffix = `<!-- rules:${JSON.stringify(rules)} -->`
        const result: VerificationResult = {
          kind: 'review',
          score,
          passed: !!parsed.passed && allRulesPassed,
          feedback: `${llmFeedback}\n\n${ruleSuffix}`,
          rules
        }
        updateDocumentVerification(documentId, result.score, result.feedback)
        return result
      }
      // parsed.score missing/non-numeric — treat as a parse failure
      // and fall through to the per-attempt model-skip block below.
    }

    // parseJsonObject returned null (no JSON object found) OR the
    // JSON lacked a numeric score. Either way: warn-log model + a
    // 240-char snippet (P1.5.b) so the next incident is
    // diagnosable, then retry on a different model if budget
    // allows.
    const snippet = (aiResult.content || '')
      .replace(/\s+/g, ' ')
      .slice(0, 240)
    log.fit.warn(
      `[verify] ${aiResult.modelUsed ?? 'unknown model'} returned a non-parseable review response ` +
      `(attempt ${attempt + 1} of ${MAX_RETRIES + 1}): ${snippet}`
    )
    if (attempt >= MAX_RETRIES) break
    if (aiResult.attempted.length > 0) {
      // Add every model that produced the bad response to the exclude
      // set so the retry does not try them again. (In practice only
      // one model produced this attempt's content, but guarding
      // against future rotation changes.)
      for (const k of aiResult.attempted) exclude.add(k)
    }
  }

  // Bounded retries exhausted. Surface the skip. Include the last
  // attempted model so the user can prune it.
  const attemptedList = lastAttempted.length > 0
    ? ` (attempted: ${lastAttempted.join(', ')})`
    : ''
  return {
    kind: 'skip',
    reason: 'parse_failed',
    feedback: `Reviewer returned no parseable JSON after ${MAX_RETRIES + 1} attempts on ${lastModel ?? 'unknown model'}${attemptedList}.`
  }
}

export async function regenerateSection(
  documentId: number,
  sectionName: string,
  jobId: number,
  extraContext?: string,
  topKeywords?: string[],
  opts?: AiCallOptions
): Promise<string> {
  const job = getJob(jobId)
  if (!job) throw new Error('Job not found')

  const doc = getDocument(documentId)
  if (!doc) throw new Error('Document not found')

  const sectionNameLower = sectionName.toLowerCase().trim()
  if (NO_REGENERATE.has(sectionNameLower)) {
    throw new Error(`Cannot regenerate the "${sectionName}" section.`)
  }

  const sections = parseSections(doc.content)
  const section = sections.find((s) => s.name === sectionNameLower)
  if (!section) throw new Error(`Section "${sectionName}" not found in the document.`)

  const sectionContent = section.bodyLines.join('\n').trim()
  if (!sectionContent) throw new Error(`Section "${sectionName}" is empty.`)

  const systemPrompt = `You are an expert career coach regenerating a single section of a Harvard-format CV.

The section header is "${section.header}". Preserve the exact same header — do not output it.

=== HARVARD CV TEMPLATE (source of truth) ===
${await loadHarvardTemplate()}
=== END TEMPLATE ===

Formatting rules:
${NO_BULLET_SECTIONS.has(sectionNameLower)
  ? `- Each line is a label: comma-separated values (no bullets)
- Output Technical and Language labels only
- Technical: 5-15 entries, ranked by job-keyword match. Drop the lowest-match entries if over 15. Drop the section if under 5 (sparse is correct).
- Language: preserve verbatim. Spoken languages are not job-keyword matched.
- Drop Laboratory, Interests, and any other label`
  : `- Entries use TAB between organization/school name (left) and location (right)
- Role/Title on next line with TAB between title (left) and dates (right)
- Bullet points in XYZ format: "Accomplished [X] as measured by [Y], by doing [Z]."
- Each bullet starts with an action verb
- Do NOT use personal pronouns; each bullet is a phrase, not a full sentence`
}

CRITICAL — TRUTHFULNESS (this overrides everything else):
- Use ONLY experience, skills, education, and projects that appear in the Full CV below.
- Do NOT invent or fabricate any experience, employers, job titles, projects, technologies, degrees, courses, GPA, awards, dates, or numbers that are not in the Full CV.
- Do NOT hallucinate metrics ("increased revenue by 40%") unless that specific number is in the Full CV. If no metric exists, use a non-numeric but truthful phrasing.
- Do NOT add skills, tools, languages, or technologies the candidate did not list.
- You MAY reword, reframe, reorder, and tighten existing entries to highlight what is most relevant to the target job. The candidate's actual accomplishments stay — they just sound as strong and as role-aligned as possible.
- If the section content is sparse, the output should be sparse. Do not pad with generic filler.

ONE-PAGE RULE (overrides verbosity):
- The output MUST fit on a single US-Letter page at 11pt Calibri with 0.6in/0.7in margins.
- Hard ceilings: ≤ 4 Experience entries, ≤ 4 bullet points per entry, ≤ 2 Leadership entries, ≤ 6 Skills & Interests lines, Education kept to at most 4 lines (one compressed block).
- If the candidate has more, prioritize the items most relevant to the target job and DROP the rest. Do not abbreviate, do not shrink, do not move to a second page.
- Never pad with filler to "fill" the page — sparse is correct when the background is sparse.

${topKeywords && topKeywords.length > 0
  ? `KEYWORD COVERAGE (overrides verbosity):
- Aim to mention at least 90% of the key terms from the job description.
- High-priority keywords (include where truthful): ${topKeywords.join(', ')}

`
 : `KEYWORD COVERAGE (overrides verbosity):
- Aim to mention at least 90% of the key terms from the job description.

`}
Rewrite the section content to better match the target job. Keep only relevant entries. Output ONLY the section body — no header line, no markdown.`

  const userPrompt = `Job Title: ${job.title}
Company: ${job.company}
Job Description:
${job.description || 'No description provided.'}

Full CV:
${doc.content}

Current "${sectionName}" section content:
${sectionContent}
${extraContext && extraContext.trim() ? `\nAdditional context from the user (follow these instructions when rewriting):\n${extraContext.trim()}\n` : ''}
Rewrite only this section's body.`

  const result = await callAI(systemPrompt, userPrompt, 0.7, DEFAULT_CALL_TIMEOUT_MS, undefined, undefined, undefined, opts)
  const newBody = result.content!

  const resultLines = [...doc.content.split('\n')]
  resultLines.splice(section.startIdx + 1, section.endIdx - section.startIdx - 1, ...newBody.trim().split('\n'))
  const updatedContent = resultLines.join('\n')

  updateDocument(documentId, doc.title, updatedContent)

  return updatedContent
}

export interface JobFitResult {
  score: number
  rationale: string
  breakdown: FitBreakdown
  source: 'llm' | 'heuristic'
  // Populated when source === 'heuristic' AND the fallback was reached because
  // the LLM call failed (no models, all rate-limited, parse error, etc.).
  // Empty string for the no-base-CV case and for legitimate keyword fallback.
  error?: string
}

function emptyBreakdown(): FitBreakdown {
  return { matched_skills: [], missing_skills: [], experience_years_match: null }
}

function heuristicFit(input: {
  title: string
  description: string | null
  requirements: string | null
  location: string | null
  baseCv: string
  cvEduLevel: number
  cvYears: number
  error?: string
}): JobFitResult {
  const score = scoreCompatibilityStructured({
    title: input.title,
    description: input.description,
    requirements: input.requirements,
    location: input.location,
    baseCv: input.baseCv
  })
  return {
    score,
    rationale: `Heuristic score based on keyword overlap. CV education level: ${input.cvEduLevel || 'unspecified'}, years experience: ${input.cvYears || 'unspecified'}.`,
    breakdown: emptyBreakdown(),
    source: 'heuristic',
    error: input.error
  }
}

/**
 * Score how well a job matches the candidate's base CV.
 *
 * Calls the configured LLM to perform a semantic comparison of the candidate's
 * actual experience against the job's requirements. On rate-limit or other
 * failure, falls back to a deterministic keyword heuristic so the user always
 * gets a number.
 */
export async function scoreJobFit(input: {
  title: string
  description: string | null
  requirements: string | null
  location?: string | null
  baseCv: string
}, signal?: AbortSignal, opts?: AiCallOptions): Promise<JobFitResult> {
  const cvEduLevel = extractEducationLevel(input.baseCv)
  const cvYears = extractYearsExperience(input.baseCv)

  // The fallback returned when the LLM call fails. The error message is
  // captured so callers can surface it on the job row and the user can tell
  // the difference between "bad fit" and "scorer is broken".
  const fallbackWithError = (error: string): JobFitResult =>
    heuristicFit({ ...input, cvEduLevel, cvYears, error })

  if (!input.baseCv) {
    return {
      score: 0.5,
      rationale: 'No base CV configured; returning neutral score.',
      breakdown: emptyBreakdown(),
      source: 'heuristic'
    }
  }

  const systemPrompt = `You are an expert technical recruiter scoring how well a candidate's CV matches a specific job posting.

You will receive:
- The candidate's BASE CV (their full background — work history, education, skills, projects).
- The job title, description, and explicit requirements.
- Optional parsed context: the candidate's detected education level (0-5, higher=more advanced) and years of experience extracted from the CV. Treat these as hints, not ground truth.

Your job: return a fit score between 0.0 and 1.0, where:
- 1.0 = exceptional match, candidate clearly meets or exceeds all must-have requirements.
- 0.6-0.8 = strong match on most requirements, minor gaps.
- 0.3-0.5 = partial match, several important requirements unmet.
- 0.0-0.2 = poor match, candidate's experience is largely unrelated.

RULES (these override anything else):
- Only credit the candidate for skills and experience that are EVIDENT in the base CV. Do not invent.
- Required years of experience, education level, and must-have skills are weighted heavily. Nice-to-haves are weighted lightly.
- Do NOT penalize a candidate for not having a specific technology if they have an adjacent/equivalent one AND the posting does not strictly require that exact tool.
- Do NOT penalize a candidate for not meeting an exact degree requirement if their equivalent professional experience clearly compensates.
- A job with a "5+ years" requirement does not automatically disqualify a candidate with 3 years of directly relevant, senior-level experience.
- Be honest. If the job is senior/staff level and the candidate is junior, the score should reflect that.

OUTPUT: a single JSON object, no markdown, no commentary:
{"score": <0.0-1.0>, "rationale": "<one short sentence, <= 30 words, explaining the score>", "matched_skills": ["<short skill>", ...], "missing_skills": ["<short skill>", ...], "experience_years_match": <true | false | null>}

- matched_skills / missing_skills: list up to 8 each, focused on the most decision-relevant skills mentioned in the posting. Empty arrays if not applicable.
- experience_years_match: true if the candidate's years of relevant experience plausibly meet the posting's requirement, false if clearly short, null if the posting does not specify a years requirement.`

  const userPrompt = `JOB TITLE: ${input.title}

JOB DESCRIPTION:
${input.description || '(none)'}

JOB REQUIREMENTS:
${input.requirements || '(none)'}

CANDIDATE BASE CV:
${input.baseCv}

PARSED CONTEXT (hints only — verify against the CV above):
- Detected CV education level: ${cvEduLevel > 0 ? cvEduLevel : 'unspecified'}
- Detected CV years of experience: ${cvYears > 0 ? cvYears : 'unspecified'}

Return the JSON object now.`

  // P1.5: bounded retry on parse_failed (mirrors verifyDocumentContent).
  // The user's enabled-model pool is largely rate-limited / 402 / 400
  // (per ai.log 09-12/13); rotating to the next model on a parse
  // failure gives a better chance of receiving a valid JSON review.
  const MAX_RETRIES = 2
  const exclude = new Set<string>()
  let lastModel: string | null = null
  let lastAttempted: string[] = []
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let result
    try {
      result = await callAI(
        systemPrompt, userPrompt, 0.2, DEFAULT_CALL_TIMEOUT_MS, signal,
        undefined, exclude, opts
      )
    } catch (err) {
      // Two refusals get out, and neither is a verdict that could have been
      // produced: nothing was requested, so there is nothing to fall back
      // from. Together they are the whole of "this call could not have
      // answered". Everything else still falls through to the heuristic
      // fallback, which is the honest answer to "the model answered and the
      // answer was unusable" and to an ordinary failure — a 429 storm
      // included, which is the scorer being temporarily unavailable while a
      // real verdict is still derivable: the job row records the reason and
      // `fit_source` says `heuristic`, and the queue's bounded score_fit
      // ladder retries it.
      //
      // EVERY MODEL COOLING DOWN is the cheaper refusal of the two:
      // `callAI` never reached a provider, so stamping a heuristic fit score
      // for it would tell the user their fit was computed when no model was
      // ever asked. Propagate instead: the queue parks the row on the
      // provider's clock without spending an attempt, and the manual
      // Recompute path reports "no provider available" instead of a number it
      // invented.
      //
      // A SPENT BUDGET is not the scorer being broken, and folding it into the
      // heuristic fallback makes it indistinguishable from one. A cap is
      // different in kind: it is not an error to recover from, it is a
      // decision the app already made — stop spending on this account for
      // the rest of this window — and there is no verdict to fall back to
      // *now*: the spend happens again in an hour, when the budget is back, so
      // anything stamped in the meantime is a guess the user would have to
      // notice was one. So the refusal is allowed out, and the lane that owns
      // refusals parks the row and comes back.
      //
      // `ProviderCapError` and not `RateLimitError`, and that narrowness is
      // load-bearing in both directions: widening it to every rate limit moves
      // `score_fit` off its own 5-attempt ladder onto the 10-attempt one that
      // the generation lanes use, which doubles the worst-case spend on a 429
      // storm (moneyleaks.store.test.ts measures exactly that bound). A cap
      // spends nothing at all, so it needs no ladder.
      if (err instanceof ProviderCooldownError) throw err
      if (err instanceof ProviderCapError) throw err
      const msg = err instanceof Error ? err.message : 'Unknown error'
      return fallbackWithError(msg)
    }
    const content = result.content || ''
    lastModel = result.modelUsed
    lastAttempted = result.attempted

    // Robust JSON extraction (P1.5.a): fenced ```json first, then a
    // balanced-brace scan that respects quote/escape state. The
    // legacy regex /\{[\s\S]*\}/ would have grabbed prose + JSON
    // and broken the parse.
    const parsed = parseJsonObject(content) as null | {
      score?: number
      rationale?: string
      matched_skills?: unknown
      missing_skills?: unknown
      experience_years_match?: unknown
    }
    if (parsed && typeof parsed === 'object') {
      const rawScore = Number(parsed.score)
      if (Number.isFinite(rawScore)) {
        const score = Math.max(0, Math.min(1, rawScore))
        const matched = Array.isArray(parsed.matched_skills)
          ? parsed.matched_skills.filter((s): s is string => typeof s === 'string').slice(0, 8)
          : []
        const missing = Array.isArray(parsed.missing_skills)
          ? parsed.missing_skills.filter((s): s is string => typeof s === 'string').slice(0, 8)
          : []
        const expMatch =
          typeof parsed.experience_years_match === 'boolean'
            ? parsed.experience_years_match
            : null
        const rationale =
          typeof parsed.rationale === 'string' && parsed.rationale.trim().length > 0
            ? parsed.rationale.trim().slice(0, 300)
            : `LLM score ${score.toFixed(2)}.`
        return {
          score,
          rationale,
          breakdown: {
            matched_skills: matched,
            missing_skills: missing,
            experience_years_match: expMatch
          },
          source: 'llm'
        }
      }
    }

    // No JSON / bad JSON / no score — warn-log model + snippet
    // (P1.5.b) and retry on a different model.
    const snippet = (content || '').replace(/\s+/g, ' ').slice(0, 240)
    log.fit.warn(
      `[fitScorer] ${result.modelUsed ?? 'unknown model'} returned a non-parseable fit response ` +
      `(attempt ${attempt + 1} of ${MAX_RETRIES + 1}): ${snippet}`
    )
    if (attempt >= MAX_RETRIES) break
    if (result.attempted.length > 0) {
      for (const k of result.attempted) exclude.add(k)
    }
  }

  // Bounded retries exhausted.
  const attemptedList = lastAttempted.length > 0
    ? ` (attempted: ${lastAttempted.join(', ')})`
    : ''
  return fallbackWithError(
    `Reviewer returned no parseable JSON after ${MAX_RETRIES + 1} attempts on ${lastModel ?? 'unknown model'}${attemptedList}.`
  )
}