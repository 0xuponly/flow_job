import type { NotificationSource, NotificationType } from './types'

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