import type { NotificationJobContext, NotificationSource, NotificationType } from './types'

/**
 * The grouping key: the single definition of "these two notifications are
 * the same kind of thing, said again".
 *
 * The notification center collapses rows onto one line each. That is only
 * safe if collapsing never destroys information, and it only doesn't if
 * expanding shows every occurrence — which it does (each row keeps its own
 * `full_message`, `created_at` and job snapshot). So the key is free to be
 * deliberately generous: it groups hard, because the cost of grouping two
 * rows that a user would have wanted apart is one extra click, and the cost
 * of NOT grouping them is a center that is itself a flood.
 *
 * The rule, in full:
 *
 *   1. `type` and `source` are part of the key. A failure and a success
 *      are different facts even when their text agrees, and a scanner
 *      finding is not a manual generate however similar the two sentences
 *      read.
 *   2. The message is lowercased and whitespace-collapsed, so casing and
 *      wrapping cannot split a group.
 *   3. Every run of digits becomes `#`. THIS is the rule that does the
 *      real work: the reported bug was one generate click producing ten
 *      toasts whose only difference was `12 errors: 7 rate limited, 5
 *      other.` vs `12 errors: 6 rate limited, 6 other.` — a bucket
 *      multiset that varies per document because each document is a
 *      separate rotation over independent providers. Keyed on the raw text
 *      those are N rows; keyed on the digits they collapse.
 *
 *      Honest limit: this does not guarantee ONE group for a flood. A
 *      rotation that happened to land entirely in one bucket summarises to
 *      `12 errors: 12 rate limited.` rather than to a mixture, and that is
 *      a genuinely different sentence from a mixed one — so a flood can
 *      arrive as two or three collapsed rows rather than one. That is
 *      correct behaviour rather than a miss: "everything was throttled" and
 *      "some were throttled and some 503'd" are different facts, and the
 *      cost of merging them would be a row that lies about what happened.
 *      What is guaranteed is that no occurrence is lost: every one keeps
 *      its own row and its own `full_message`, so a split costs a click
 *      and a whole-group dismissal still reaches all of them.
 *   4. The normalized message is clamped to `MAX_GROUP_KEY_CHARS`. This is
 *      a bound on what a provider can put in the store — `electron/ai.ts`
 *      splices up to 200 chars of a provider's own error body into a
 *      message, and a body carrying request ids and timestamps makes every
 *      one of those a distinct unbounded key. Two messages that share a
 *      512-char prefix therefore share a key; benign, since expanding shows
 *      both payloads in full.
 *
 * Deliberately NOT part of the key: the job. Twelve rate-limit failures
 * across twelve different jobs are one thing the user has to think about
 * (their whole model pool is throttled), and grouping them is what makes
 * that legible. Job context is per-occurrence detail instead.
 *
 * The stored row's own `message` is the input, not `full_message`. A
 * twelve-model rotation dump differs per model in a way no normalisation
 * can erase, and the message is the field that already carries the
 * summarised, deduplicated form.
 *
 * Main-process only, and that is load-bearing rather than incidental: the
 * key is written once at insert time and migrated onto old rows at load
 * time, so the renderer groups on `row.group_key` verbatim and never has to
 * re-derive it. Two copies of this normalisation would be two chances for
 * the center to disagree with itself about what belongs together.
 */
export function notificationGroupKey(
  type: NotificationType | string,
  source: NotificationSource | string,
  // `unknown`, not `string`: the store migration runs this over rows read
  // back from a user-writable file, and `loadStore` is the accessor for the
  // whole Store — a TypeError here would take down jobs, documents and
  // settings, not just notifications. A row whose message is missing is a
  // row that has nothing to group by, not a crash.
  message: unknown
): string {
  const normalized = (typeof message === 'string' ? message : '')
    .toLowerCase()
    // \p{Nd} rather than \d: \d is ASCII-only, so `١٢ errors` (Arabic-Indic)
    // and `1000 errors` would key apart despite being the same fact.
    .replace(/\p{Nd}+/gu, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_GROUP_KEY_CHARS)
  // `|` is the separator, so a separator inside a part would make
  // ('app|ai', 'boom') and ('app', 'ai|boom') collide. Neither is
  // reachable from today's renderer — both come from literal unions — but
  // the row is a file on disk that an older or newer build wrote, and the
  // guard costs one replace.
  return `${sep(type)}|${sep(source)}|${normalized}`
}

function sep(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\|/g, ' ') : ''
}

const MAX_GROUP_KEY_CHARS = 512

/**
 * The key `addNotification` uses to decide "this is the same fact, said
 * again", which is a STRICTLY FINER question than `notificationGroupKey`.
 *
 * The two answers differ because they do different jobs, and confusing
 * them is the defect this closes:
 *
 *   grouping decides what the DRAWER may put on one line. Collapsing is
 *     reversible — expanding shows every row, with its own timestamp, its
 *     own job citation and its own payload — so it can afford to be
 *     generous. That is why `notificationGroupKey` deliberately drops the
 *     job: twelve rate-limited jobs are one thing to think about.
 *
 *   de-duplication decides what the STORE may DESTROY. A repeat inside
 *     the window is not written at all — the row that is already there is
 *     the record — so the second payload is gone. Nothing is reversible,
 *     so it has to be at least as strict as the thing it erases, and three
 *     fields earn their place here by exactly that standard:
 *
 *     the job — "generation failed" on job 1 and on job 2 are rows the
 *       user acts on separately, and merging them would leave one row
 *       citing one job while the other silently disappeared.
 *
 *     `full_message` — the per-document detail. `announceSweep` puts
 *       `docLabel(doc)` in front of every one of them, so six documents
 *       failing in one sweep are six DIFFERENT facts even when their
 *       one-line summaries share a group. Keyed on the summary alone they
 *       would collapse into whichever was written first and five raw
 *       rotations would be gone from the durable record — the centre's
 *       entire reason for existing. And it still catches the duplicate
 *       this is here for: a StrictMode double-mount re-runs the sweep over
 *       the same documents with the same provider error, so it produces
 *       byte-identical payloads.
 *
 *     the row's OWN type and source, and not merely whatever the group key
 *       happens to say. `group_key` is overridable — `addNotification`
 *       takes one, for a caller that knows two differently-worded
 *       notifications are one thing — and a caller-supplied key carries no
 *       type or source of its own. So a key passed in wholesale left the
 *       row's own `type`/`source` out of its identity, and an `error` and a
 *       `warning` sharing one explicit key would fold into a single row
 *       whose stored `type` was whichever arrived first: a payload erased,
 *       and a row now claiming a severity nobody recorded. The values used
 *       here are the ones already coerced onto the row and read back off it,
 *       so the key cannot disagree with the record it identifies.
 *
 * So "the same fact" is one message, one job and one payload inside the
 * window — which is the strongest claim available without knowing what the
 * caller's error text means, and erring towards "not a duplicate" costs a
 * row while erring the other way costs a payload.
 *
 * Length-prefixed rather than `|`-joined. Both the job fields and the
 * payload come from the user's own data — job titles, provider error
 * bodies — so they can contain anything, and `('acme|berlin', 'x')` vs
 * `('acme', 'berlin|x')` would collide under a bare separator, which is a
 * merge of two different failures. `n:value` makes the concatenation
 * injective, so two different facts cannot produce one key.
 *
 * Main-process only, for the same reason as the grouping key: the row is
 * written once and re-read verbatim, so no reader re-derives this.
 */
export function notificationDedupeKey(
  type: NotificationType,
  source: NotificationSource,
  groupKey: string,
  job: NotificationJobContext | undefined,
  fullMessage: string
): string {
  const id = job?.job_id
  return [
    part(type),
    part(source),
    part(groupKey),
    id === null || id === undefined ? part('') : part(String(id)),
    part(job?.job_title),
    part(job?.job_company),
    part(job?.job_location),
    part(fullMessage)
  ].join('|')
}

/**
 * `<byteLength>:<value>` for one key part, so joining parts is reversible.
 *
 * UTF-8 bytes rather than JS string length, because the consumer only ever
 * compares whole strings for equality — the encoding has to be injective,
 * and `String.length` counts UTF-16 units while the values came out of a
 * UTF-8 store file. `—` is one unit and three bytes, so the two would
 * disagree on where a part ends if the encoder and the value disagreed
 * about the alphabet; using bytes on both sides keeps them agreeing
 * regardless.
 */
function part(value: string | null | undefined): string {
  const s = typeof value === 'string' ? value : ''
  return `${Buffer.byteLength(s, 'utf-8')}:${s}`
}
