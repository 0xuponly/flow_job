export type JobStatus =
  | 'sourced'
  | 'reviewing'
  | 'tailoring'
  | 'ready'
  | 'applied'
  | 'follow_up'
  | 'interviewing'
  | 'offer'
  | 'rejected'
  | 'withdrawn'

export type ApplicationStatus = JobStatus

export interface FitBreakdown {
  matched_skills: string[]
  missing_skills: string[]
  experience_years_match: boolean | null
}

export interface Job {
  id: number
  title: string
  company: string
  location: string | null
  url: string | null
  description: string | null
  salary_range: string | null
  requirements: string | null
  application_requirements: string | null
  // 1 = the user set this job's status explicitly (Pipeline drag,
  // JobDetail status select, mark-applied flow). Doc-driven recompute
  // skips these jobs entirely so their status is never overwritten.
  manual_status?: 0 | 1
  hiring_manager: string | null
  employment_type: string | null
  work_mode: string | null
  source: string | null
  status: JobStatus
  score: number | null
  fit_rationale: string | null
  fit_breakdown: FitBreakdown | null
  fit_score_version: number | null
  // Tracks where the persisted fit score came from: 'llm' for a real
  // LLM score, 'heuristic' for the deterministic fallback, null when
  // the row has never been scored.
  fit_source: FitSource
  // Set when the most recent fit-scorer run fell back to a heuristic (no
  // LLM response, parse failure, no models configured, etc.). NULL means
  // the row is either unscored or was scored successfully by the LLM. The
  // UI shows this in place of a numeric score so the user can tell the
  // difference between "bad fit" and "scorer is broken".
  fit_last_error: string | null
  // The fit_last_error string that was last surfaced to the user via a
  // toast. Persisted so the toast does not re-fire on every app open for
  // a still-failing job — only when the error text actually changes (or
  // is cleared and re-appears). NULL = never toasted, or error was
  // cleared since the last toast (a future re-occurrence re-arms).
  fit_error_toasted: string | null
  match_grade: MatchGrade
  tailor_ms_cv: number | null
  tailor_ms_cl: number | null
  tailor_generated_at: number | null
  tailor_last_error: string | null
  tailor_error_toasted: string | null
  submitted_at: number | null
  response_at: number | null
  notes: string | null
  date_posted: string | null
  application_deadline: string | null
  last_updated: string | null
  created_at: string
  updated_at: string
}

export interface Document {
  id: number
  job_id: number | null
  type: 'cv' | 'cover_letter'
  title: string
  content: string
  is_base: number
  model_used: string | null
  verification_score: number | null
  verification_feedback: string | null
  // P1.7 (BRIEF5 §2): how many times the auto review→regenerate loop
  // has rebuilt this document. Capped at AUTO_REGEN_MAX (5); once the
  // cap is hit the document is flagged for manual attention — its
  // verification_score stays < 80 and no further regeneration is
  // auto-queued. Optional because legacy rows (and the
  // createDocument construction sites) predate the
  // field; readers must treat undefined as 0.
  auto_regen_attempts?: number
  created_at: string
  updated_at: string
}

/**
 * Result of `verifyDocumentContent`. Two shapes:
 *  - `review`: an actual LLM review with a numeric score and pass/fail.
 *  - `skip`:  no review happened (e.g. document was deleted, AI parse failed,
 *             rate-limited but not retried here). Callers MUST NOT persist a
 *             skip as a verification_score, and MUST NOT feed it into the
 *             "regenerate until passed" loop.
 */
export type RuleName = 'one_page' | 'paragraph_count' | 'skills_count' | 'keyword_coverage' | 'leadership_one_line'

export interface RuleCheck {
  rule: RuleName
  passed: boolean
  detail: string
}

export type VerificationResult =
  | {
      kind: 'review'
      score: number
      passed: boolean
      feedback: string
      // Per-rule summary from runDocumentRuleChecks. Persisted as a JSON
      // suffix inside the existing `feedback` text column so no schema
      // change is needed; a follow-up can promote this to a dedicated
      // column. Present on 'review' kind only.
      rules: RuleCheck[]
    }
  | { kind: 'skip'; reason: 'deleted' | 'parse_failed' | 'no_ai_response'; feedback: string }

export type KeywordCategory = 'hard' | 'soft' | 'cert' | 'seniority'
export type KeywordSource = 'title' | 'required' | 'preferred' | 'body'

export interface KeywordEntry {
  phrase: string
  weight: number
  category: KeywordCategory
  source: KeywordSource
}

// P1.3 — structured years-of-experience signal (kept in sync with
// src/types.ts:YearsOfExperience so renderer and main agree on the
// shape).
export interface YearsOfExperience {
  phrase: string
  minYears: number
}

export interface KeywordResult {
  keywords: KeywordEntry[]
  refinedByLlm: boolean
  unknownPhrases: string[]
  // P1.3 (additive, optional). See src/types.ts:YearsOfExperience.
  // Present on results from extractJobKeywordsStructured /
  // extractJobKeywordsV3, absent on results from mergeKeywordResults
  // until the orchestrator wires it through in a follow-up.
  yearsOfExperience?: YearsOfExperience[]
}

export interface Application {
  id: number
  job_id: number
  status: ApplicationStatus
  applied_at: string | null
  method: string | null
  contact_email: string | null
  contact_name: string | null
  notes: string | null
  cv_document_id: number | null
  cover_letter_document_id: number | null
  created_at: string
  updated_at: string
}

export interface FollowUp {
  id: number
  application_id: number
  due_date: string
  completed_at: string | null
  type: 'email' | 'call' | 'linkedin' | 'other'
  message: string | null
  notes: string | null
  created_at: string
}

export interface Interview {
  id: number
  application_id: number
  scheduled_at: string
  duration_minutes: number
  type: 'phone' | 'video' | 'onsite' | 'technical' | 'other'
  location: string | null
  interviewer: string | null
  notes: string | null
  outcome: 'scheduled' | 'completed' | 'cancelled' | 'no_show' | null
  created_at: string
}

export interface ApiModelConfig {
  id: string
  name: string
  base_url: string
  api_key: string
  model: string
  enabled?: boolean
  // Per-model token budget override. Falls back to FLOW_JOB_MAX_TOKENS env,
  // then DEFAULT_MAX_TOKENS (2048) in ai.ts.
  max_tokens?: number
  // Per-model per-attempt HTTP timeout in ms. Falls back to
  // DEFAULT_CALL_TIMEOUT_MS (45000) in ai.ts. Optional and additive: no
  // settings UI, and a model without it behaves exactly as before.
  // Nonsense (0, negative, NaN, Infinity) falls back to the default;
  // a finite value above 10 minutes is clamped to that ceiling.
  timeout_ms?: number
}

export interface LocationPick {
  // LocationNode.id when picked from the autocomplete; undefined for
  // free-text entries like "Remote" that don't correspond to a node.
  id?: string
  // Canonical display() for picks; raw text for free-text entries.
  display: string
}

export interface Settings {
  openai_api_key: string
  openai_base_url: string
  openai_model: string
  user_name: string
  user_email: string
  user_phone: string
  user_country: string
  base_cv: string
  job_search_keywords: string
  job_search_location: string
  // JSON-encoded LocationPick[]; '' or '[]' = no saved locations.
  job_search_locations: string
  deleted_jobs_cap: number
  auto_scan_enabled: boolean
  auto_scan_interval_minutes: number
  /**
   * Minimum 0-1 match score a listing must reach against the base CV
   * for a scan to add it. Below the threshold the listing is skipped
   * (not stored) and counted in the scan result's Skipped column.
   *
   * Only applies when `base_cv` is set: with no CV there is nothing to
   * compare against, so nothing is filtered and the scan result says so.
   * 0 disables the floor; 1 admits only a perfect match. The value is
   * read through resolveScanMinMatch (jobSearch.ts), which clamps it and
   * falls back to 0.25 for anything unusable.
   */
  scan_min_match: number
  fit_autoscore_interval_minutes: number
  locations_normalized: string
  locations_normalized_v2: string
  locations_normalized_v3: string
  locations_normalized_v4: string
  locations_normalized_v5: string
  locations_normalized_v6: string
  employment_type_normalized: string
  work_mode_normalized: string
  backup_path: string
  backup_last_success_at: string
  backup_last_error: string
  passphrase: string
  adzuna_app_id: string
  adzuna_app_key: string
  aggregator_remotive_enabled: boolean
  aggregator_arbeitnow_enabled: boolean
  aggregator_jobicy_enabled: boolean
  aggregator_himalayas_enabled: boolean
  ats_boards: AtsBoard[]
  disabled_boards: string[]
  /**
   * Fit-score threshold (0-100) at or above which a job auto-enqueues
   * document generation + AI review, read by the one shared eligibility
   * predicate (`autoDocQueueEligible`, electron/docAutoQueue.ts) that
   * both the fit-landing trigger and the documents backlog sweep ask.
   *
   * No UI writes this key any more: it lived in the Scan tab's "Auto-Queue"
   * section, retired with that section, and the Auto-queue tab holds only
   * the five switches below. A store that already has a value keeps it —
   * 40 is the fallback when the key is absent, and normalisation still
   * rescales a 0-1 value.
   */
  auto_doc_min_fit: number
  /**
   * Per-kind auto-queue switches (Settings > Auto-queue).
   *
   * Every one of these gates AUTOMATIC enqueues only. A manual user
   * action — generate, regenerate a section, verify, tailor, quick
   * apply — is never suppressed by them: turning auto-queueing off
   * stops the app spending tokens on its own, and never stops the
   * user asking for work explicitly. See the `manual` flag on
   * `enqueue` (aiQueue.ts), which is what tells the central gate the
   * two apart.
   *
   * All five default TRUE, because auto-queueing is the behaviour that
   * shipped before these keys existed. A store written before them (or
   * one hand-edited to a non-boolean) normalises back to `true`, so a
   * missing key can never silently disable a feature.
   */
  auto_queue_fit: boolean
  auto_queue_cv: boolean
  auto_queue_cover_letter: boolean
  auto_queue_verify_cv: boolean
  auto_queue_verify_cover_letter: boolean
  quick_apply_shortcut: string | null
  // One-shot gates for status migrations. 'statuses_recomputed' backfilled
  // the original doc-derived rule; 'statuses_manual_v2' demotes jobs that
  // the old rule auto-promoted to 'ready' on verification (now a
  // user-only status).
  statuses_recomputed: string
  statuses_manual_v2: string
  // Gating flag for the queue-duplicate repair (see dedupeAIQueueItems).
  queue_dedup_v1: string
  /**
   * Second one-shot gate for the same repair, for the duplicate class
   * the v1 guard could not see: `failed` rows were outside v1-era
   * `enqueue()`'s duplicate check, so a store that had already been
   * repaired once went on collecting a second row per piece of work.
   *
   * A separate flag rather than a reset of v1 so the repair stays
   * one-shot: `queue_dedup_v1` is the record that a given store was
   * collapsed, and clearing it would re-run a pass that has already
   * done its job on every subsequent startup.
   */
  queue_dedup_v2: string
  /**
   * One-shot gate for `unpoisonCooldownFailedAIQueueItems`: the repair
   * for queue rows that burned their whole attempt budget on failures
   * that never reached the provider (2026-10-02).
   *
   * A NEW flag rather than a reset of `queue_dedup_v1`/`_v2`, for the
   * same reason those were separate: each is the record that a given
   * store went through that repair, and re-arming one would re-run a
   * pass forever. A store carrying this flag has been repaired.
   */
  queue_cooldown_reset_v1: string
  /**
   * Epoch ms of the user's last "Clear queue", 0 when never cleared.
   *
   * The durable half of the clear: the queue rows it deleted can be
   * rebuilt from the JOBS table by the startup / post-scan backlog and by
   * the hourly fit-auto-score timer, so deleting the rows alone does not stop
   * the work. Anything the user had already accumulated when they
   * cancelled is refused by the re-seeders until this moves. Paired with
   * `queue_cleared_max_job_id`, which says WHICH jobs that was. See
   * `isScoreFitSuppressed` in database.ts.
   */
  queue_cleared_at: number
  /**
   * The highest job id that existed at the moment of the last clear — the
   * watermark separating the work the user cancelled from jobs that turned
   * up afterwards. Ids are monotonic and never reused, so this needs no
   * clock and no timestamp parsing to compare against.
   */
  queue_cleared_max_job_id: number
  /**
   * How many real outbound requests ONE provider (one credential, see
   * `providerKey()` in ai.ts) may be asked for in a rolling 24 hours by
   * AUTOMATED work — the queue, the backlog sweeps, the fit re-seeder, doc
   * generation. Manual actions (Generate / Regenerate / Verify / Tailor /
   * Quick Apply) are not capped by it, so the user is never left at a dead
   * end, but they DO count, so repeated clicking cannot spend without bound.
   *
   * Per provider, not per model, because the failure this bounds is a
   * credential being cut off: twenty free models sharing one OpenRouter key
   * each have their own cooldown, so a per-model limit still lets the
   * provider be called twenty times the moment those cooldowns lapse.
   * OpenRouter's own free-model allowance is likewise counted per account
   * and explicitly not per model, so this is deliberately the same unit.
   *
   * 50 is the documented free-tier daily allowance for an account that has
   * bought no credits (1000/day once it has bought 10) — the point at which
   * a shared key starts answering 429. The rolling window (not a calendar
   * day) is deliberate on two counts: midnight cannot be used to reset it,
   * and free-tier quotas do not all reset on a boundary. Clamped to
   * [1, 5000] on load; anything unreadable normalises back to 50.
   */
  provider_call_cap: number
}

/**
 * One REAL outbound provider request, as persisted in `provider_spend`.
 *
 * `at` is epoch ms of the moment the request was issued (not of its
 * outcome — a 429, a timeout and a billing notice all cost the same and
 * all count). `manual` records whether a person asked for it, so the two
 * kinds stay legible in the number rather than blending into one total.
 */
export interface ProviderCall {
  at: number
  manual: boolean
}

export type MatchGrade = 'S' | 'A' | 'B' | 'C' | 'D' | 'F' | null

export type FitSource = 'llm' | 'heuristic' | null

export type AtsPlatform = 'greenhouse' | 'lever' | 'ashby' | 'workday' | 'smartrecruiters'

export interface AtsBoard {
  id: string
  name: string
  platform: AtsPlatform
  token: string
  enabled: boolean
}

export interface DashboardStats {
  total_jobs: number
  applied: number
  interviewing: number
  offers: number
  pending_follow_ups: number
  upcoming_interviews: number
}

export interface CreateJobInput {
  title: string
  company: string
  location?: string | null
  url?: string | null
  description?: string | null
  salary_range?: string | null
  requirements?: string | null
  application_requirements?: string | null
  hiring_manager?: string | null
  employment_type?: string | null
  work_mode?: string | null
  source?: string | null
  score?: number | null
  fit_rationale?: string | null
  fit_breakdown?: FitBreakdown | null
  fit_score_version?: number | null
  fit_source?: FitSource
  notes?: string | null
  date_posted?: string | null
  application_deadline?: string | null
}

export interface TailorRequest {
  job_id: number
  document_type: 'cv' | 'cover_letter'
  base_content?: string
  topKeywords?: string[]
  /**
   * P1.7 §2 auto-regeneration: rebuild THIS document in place instead
   * of inserting a new one. Set by the queue's regeneration item so
   * the rebuilt content keeps the document's identity and its
   * `auto_regen_attempts` budget across rounds. Absent for a first
   * generation, which always creates a new document.
   */
  document_id?: number
}

export interface TailorResult {
  content: string
  document_id: number
}

export type WorkType = 'any' | 'remote' | 'hybrid' | 'in_office'

export interface ScanFilters {
  keywords?: string
  locations?: LocationPick[]
  workType?: WorkType
  boards?: string[] // names of boards to scan; undefined = scan all
}

export interface BoardHealth {
  name: string
  // Last 5 scan results (oldest first). Each is the total found across locations
  // for that scan, or -1 if the scan errored out.
  history: number[]
}

export interface ScanBoardResult {
  board: string
  found: number
  added: number
  skipped: number
  // Listings that passed extraction but were rejected by the
  // workType/location/score filters. Surfaced in the scan results
  // table so the user can tell "0 added" apart from "0 found".
  incompatible: number
  error?: string
}

export interface ScanResult {
  totalFound: number
  totalAdded: number
  totalSkipped: number
  boards: ScanBoardResult[]
  errors: string[]
  startedAt: number | null
  durationMs: number
  cancelled: boolean
  totalIncompatible: number
  addedJobs: { id: number; title: string; company: string }[]
}

export interface ScanStatus {
  scanning: boolean
  progress: string[]
  result: ScanResult | null
  startedAt: number | null
}

export type AIQueueItemType = 'generate_cv' | 'generate_cover_letter' | 'regenerate_section' | 'verify' | 'tailor_job_docs' | 'score_fit'
export type AIQueueItemStatus = 'pending' | 'processing' | 'failed'

/**
 * P1.7 (BRIEF5 §2): auto review→regenerate loop bounds.
 * A document whose AI review scores below PASSING_REVIEW_SCORE is
 * rebuilt up to AUTO_REGEN_MAX times. After the cap, the document is
 * flagged for manual attention (its verification_score stays below the
 * pass bar and the user regenerates by hand).
 */
export const PASSING_REVIEW_SCORE = 80
export const AUTO_REGEN_MAX = 5

/**
 * P1.8: self-healing for capped queue items.
 *
 * A task that exhausts its retry budget used to become permanently
 * `failed` — the processor only ever picks `status === 'pending'`, so
 * nothing revived it and the job silently lost its fit score or its
 * documents until the user noticed and clicked Retry by hand. That is
 * the wrong default for failures whose cause is almost always
 * external (quota exhausted, provider down, network blip): the right
 * behaviour is to wait and try again on our own.
 *
 * `AUTO_REVIVE_COOLDOWN_MS` (4h) is deliberately far longer than the
 * per-attempt backoff cap (30m). Backoff is for a request that might
 * succeed on the next poll; revival is for a task that already failed
 * its whole budget, so it waits out a real quota window rather than
 * just the next tick. 4h covers the reset schedules the providers
 * actually use — daily caps on Claude Pro and the per-window limits on
 * API tiers commonly reset on a multi-hour cycle — so a task usually
 * wakes up to a budget that has genuinely replenished rather than
 * waking to the same exhausted quota and burning another full attempt
 * budget against it.
 *
 * `AUTO_REVIVE_MAX` bounds the loop. Without it, a task that can never
 * succeed (malformed job, permanently rejected prompt) would cycle
 * forever and keep spending LLM calls. After this many revivals the
 * item stays `failed` and is left for the user, which is the correct
 * outcome for something genuinely broken. Note the interaction with the
 * cooldown: 3 revivals at 4h apart means a task that is failing for
 * real reasons takes up to 12h to reach its final failed state.
 */
export const AUTO_REVIVE_COOLDOWN_MS = 4 * 60 * 60 * 1000
export const AUTO_REVIVE_MAX = 3

/**
 * A queue row as the Queue panel consumes it: the stored item plus the
 * job's title and company, resolved at list time.
 *
 * Deliberately NOT persisted. A job can be renamed or deleted at any
 * moment, so writing these onto the queue row would leave the panel
 * showing stale text indefinitely. Both are null when the job is gone,
 * and the panel falls back to the job id in that case.
 */
export type QueueItemView = AIQueueItem & {
  jobTitle: string | null
  jobCompany: string | null
  /**
   * This row says `processing`, but no run in the current app session
   * owns it: it was left that way by a crash and the startup reclaim
   * deliberately did not resume it (the Auto-queue switch for its type
   * is off). The panel offers Retry for these, because it is the user's
   * own request and is never gated.
   *
   * Read-time state about the PROCESS, not the row, and never
   * persisted — like `jobTitle` / `jobCompany` it is resolved per list
   * from something the main process knows and the store does not. False
   * (the field is always sent) for every other row, so the renderer can
   * treat a missing one as false too.
   */
  stranded?: boolean
}

export interface AIQueueItem {
  id: number
  type: AIQueueItemType
  jobId: number
  documentId?: number
  sectionName?: string
  extraContext?: string
  status: AIQueueItemStatus
  attempts: number
  lastError?: string
  /**
   * Whether a person asked for this row, as opposed to the app deciding
   * to on its own. Written by `enqueue` from the same `manual` flag that
   * short-circuits the auto-queue gate, so it is the row's own record of
   * its origin rather than something a caller has to remember to pass.
   *
   * It exists for the RESTART lanes, not for enqueue. `enqueue` already
   * refuses to add an automatic row when its switch is off, so by the
   * time a row exists the gate has already been applied once. But a row
   * that was queued while the switch was ON, or queued by hand, outlives
   * that decision: the processor can still wake it later (a `failed`
   * row revived on the 4h cooldown, a row stranded `processing` by a
   * crash and reclaimed at startup), and those wake-ups are new provider
   * calls the user is not watching. This field is what lets those lanes
   * ask "was this one the user's?" — a manual row keeps every
   * restart behaviour it always had; an automatic one still consults the
   * switch.
   *
   * ABSENT means AUTOMATIC, deliberately. Rows written by every version
   * before this field existed carry no origin, and the conservative
   * reading is the one that closes the spend leak: treating them as
   * manual would hand every pre-existing row a free pass and undo the
   * gate for the rows it was written to protect. The cost is real and
   * intended — a row a user hand-queued before this field shipped stops
   * auto-reviving once its switch is off. It stays visible in the Queue
   * panel, and the ungated Retry button re-asks for it.
   */
  manualQueued?: boolean
  /**
   * How many times this item has been revived from `failed` back to
   * `pending` by the automatic recovery loop. Absent on rows written
   * before auto-revival existed; treat undefined as 0 so legacy rows
   * still get a chance to recover.
   */
  autoRevives?: number
  /**
   * Set while this row is parked on a provider whose call budget is spent,
   * and cleared the moment the processor takes it again.
   *
   * It records WHY a `pending` row is not running, which is the one thing
   * `status` and `nextRetryAt` cannot express: a row in a rate-limit backoff
   * and a row waiting for a 24-hour budget are both `pending` with a future
   * `nextRetryAt`, and only the second is free of charge — no attempt spent,
   * no revival charged, and it will still be here when the budget returns.
   * The Queue panel reads it to say so instead of counting down a retry the
   * row is not spending.
   *
   * Absent means the row is not parked on a cap. It is a reason, not a
   * state: `status` stays `pending`, so every lane that already handles a
   * parked row (the pick, the dedupe guard, the stranded check) handles this
   * one without knowing this field exists.
   */
  parkedReason?: 'provider_cap'
  /**
   * Epoch ms when this row was last parked because no AI provider was
   * available, or absent when it was not.
   *
   * The row's own record of a block that cost nothing — `callAI` threw
   * before making a request (see ProviderCooldownError), so `attempts`
   * was not incremented. Without a marker the row is
   * indistinguishable from one that is merely queued behind other work:
   * both are `pending` with a future `nextRetryAt`, which is exactly how
   * 265 tasks looked like ordinary backlog while the app was unable to
   * run any of them for 20 hours (2026-10-02). It is what the Queue
   * panel renders as a distinct state, and what `aiQueueBlockedState`
   * counts.
   *
   * Cleared when the row is claimed for real work, when the user hits
   * Retry, and when the revival lanes revive it — the block is over in
   * all three cases.
   */
  blockedSince?: number
  /**
   * How many times this row has been parked on a provider block without
   * spending an attempt. Escalates that row's re-probe interval
   * (30s, 60s, 2m … capped) so a health map that keeps pushing the
   * provider's own clock forward cannot hold the row on the shortest
   * possible wake-up. Reset to absent with `blockedSince`.
   */
  blockedCount?: number
  createdAt: number
  nextRetryAt: number
  /**
   * Epoch ms of the last MANUAL re-add of this row ("run this now"),
   * or absent when the item carries no boost.
   *
   * The durable half of "bump it to the top": management's rule is that
   * re-adding something already queued must not be refused and must not
   * make a second row, so the only thing left to give the user is
   * ordering. A timestamp rather than a counter because it needs no
   * schema migration and no new store-level sequence (the store is a
   * JSON document, so an absent field on a legacy row already means
   * "not promoted"), and because it is a field the UI could read back if
   * a promotion indicator is ever wanted.
   *
   * Honoured by `pickOrder` WITHIN a tier only. `score_fit` is tier 0
   * and outranks everything, so promoting a `verify` cannot lift it past
   * a queued `score_fit` — the boost is "ahead of my tier siblings",
   * which is the honest reading of "to the top" once the project rule
   * about fit scoring is respected.
   *
   * One-shot: the processor clears it when it claims the item, so a
   * boost is spent on the next run rather than pinning the row above
   * its peers for the life of the queue.
   */
  promotedAt?: number
  // P1.7 (BRIEF5 §3): fit-score snapshot at enqueue time. This is a
  // HINT for ordering only and is intentionally NOT the source of
  // truth — the pick-time sort re-reads job.score so a score that
  // lands (or changes) after this item was enqueued is reflected
  // immediately. Storing the snapshot lets the renderer show a
  // stable "queued at fit N" label without a second job lookup.
  fitScoreSnapshot?: number | null
}

export interface DeletedJobRecord {
  // Key fields that identify the job (enough to dedup against future scans)
  url: string | null
  title: string
  company: string
  location: string | null
  // Last known fit score (0-1). If < 0.3, the user likely deleted because it was
  // low-fit, so future scans should not re-add this job.
  score: number | null
  deletedAt: number
}

export type NotificationType = 'info' | 'success' | 'error' | 'warning'
export type NotificationSource = 'app' | 'ai' | 'scanner' | 'tailor' | 'scraper'

/**
 * Which job an occurrence happened on, snapshotted at the moment it was
 * recorded.
 *
 * A snapshot, not a foreign key, and that is the whole point. The job may
 * be renamed or deleted between the failure and the moment the user opens
 * the drawer to read it, and a centre that resolves `job_id` at render
 * time would show nothing for exactly the failures that are oldest. The
 * cost is that the snapshot goes stale; the benefit is that the record
 * never does.
 *
 * Every field except `job_id` is nullable because every field except
 * `job_id` may genuinely be unknown — `null` means "we did not have this",
 * never "we guessed". See `jobContext` in src/notifications/record.ts for
 * the rule that keeps the distinction true.
 */
export interface NotificationJobContext {
  /**
   * Null when the app knew which company and role a failure belonged to
   * but never resolved the row — the follow-up queue holds an
   * application id, not a job id, and inventing one to fill this column
   * would put a number in front of the user that resolves to nothing.
   */
  job_id: number | null
  job_title: string | null
  job_company: string | null
  job_location: string | null
}

export interface NotificationRow {
  id: number
  type: NotificationType
  source: NotificationSource
  message: string
  full_message: string
  created_at: number
  dismissed_at: number | null
  /**
   * Rows sharing a key are the same kind of thing said again, and the
   * drawer collapses them into one row with a count. Required rather than
   * optional: it is written on every insert and backfilled onto every
   * pre-existing row by the store migration in database.ts, so there is
   * no state in which a loaded row lacks one — and a required field means
   * no reader anywhere has to carry a fallback that could disagree with
   * electron/notificationGroup.ts about what belongs together.
   *
   * `job` is optional because not every notification belongs to a job (a
   * main-process crash, a failed backup).
   */
  group_key: string
  job?: NotificationJobContext
}
