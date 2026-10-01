// Recognise a provider's billing / quota / auth notice delivered as an
// ordinary assistant message.
//
// The failure this exists for: providers answer HTTP 200 and put a
// plaintext notice in `choices[0].message.content` instead of a model
// response. Measured in `fit.log` + `fit.log.1`: 337 of 353 parse-failure
// log lines carried one, e.g.
//
//   "The account behind this API key doesn't have enough credits. This
//    model needs paid Pollen. Please [top up](https://enter.pollinations
//    .ai/top-up?ref=agent_low_balance_topup), then try again."
//
// Because the verify and fit call sites pass no `validateResponse`, that
// body was non-null content and took the success branch in `tryModels`,
// which DELETED the model's health entry. A provider that is out of
// credit therefore had its failure history erased on every call, never
// cooled down, and returned to the front of the rotation: it looked
// healthy precisely because it was failing invisibly.
//
// -------------------------------------------------------------------------
// The asymmetry that sets the threshold
// -------------------------------------------------------------------------
// A false positive here DISCARDS a legitimate model answer, which is
// worse than the status quo (a wrong-but-readable document, or a review
// that scores a good CV as broken). A false negative is just today's
// behaviour. So the rule is a conjunction, never a disjunction:
//
//   notice := billingPhrase(in head) AND corroborator AND not(an answer)
//
// * `billingPhrase` is a provider-shaped clause ("not enough credits"),
//   not a bare noun ("credit", "billing", "quota") — a financial
//   analyst's CV bullet and a credit-risk job posting both contain those
//   nouns, and both are legitimate answers.
// * `corroborator` is proof the body is ABOUT the caller's account
//   rather than an answer to the prompt: a checkout/top-up URL, or
//   account-prose address ("The account behind this API key…").
// * `not(an answer)` refuses any body that parses as a JSON object
//   without an `error` key — every structured call site in this app asks
//   for JSON, so a JSON body is an answer by construction.
//
// Pure, deterministic, no I/O, no imports — unit-testable in isolation.

/**
 * How far into the body a billing phrase still counts. A provider puts
 * the reason in its first sentence; an answer puts its subject matter
 * nowhere near the front. Measured bodies all trip well inside 200
 * characters; 400 leaves headroom for a chatty preamble without ever
 * reaching the body of a CV.
 */
const HEAD_CHARS = 400

/**
 * Decisive on their own: each is a clause about the account's balance,
 * phrased the way a provider phrases it and not the way a CV bullet
 * phrases it. "Credit risk" and "billing team" do not appear here.
 */
const DECISIVE_PHRASES: readonly RegExp[] = [
  /\bnot enough credits?\b/i,
  /\binsufficient (?:credits?|balance|funds?|quota|pollen)\b/i,
  /\b(?:requires?|needed|needs|require) (?:more|additional|extra) credits?\b/i,
  /\b(?:ran out of|out of) credits?\b/i,
  /\bcredits? (?:are|is|were|was)? ?(?:exhausted|depleted|used up)\b/i,
  /\bneeds? paid\b/i,
  /\bpaid pollen\b/i,
  /\bquota (?:exceeded|exhausted)\b/i,
  /\b(?:top ?up|recharge) (?:your|the) (?:account|balance|credits?)\b/i,
  /\bthe account behind (?:this|your|the) api ?key\b/i,
  /\bbalance (?:is )?(?:too low|insufficient|depleted|exhausted|empty)\b/i,
  /\bno (?:remaining )?(?:credits?|balance|funds?)\b/i
]

/**
 * Ambiguous alone — a CV bullet about a billing team or a credit-risk
 * posting trips every one of these — so two are required, plus a
 * corroborator. "top up", "payment required" and the bare nouns are here
 * precisely because they are common English.
 */
const SUPPORTING_PHRASES: readonly RegExp[] = [
  /\btop[\s-]?up\b/i,
  /\bpayment required\b/i,
  /\bcredits?\b/i,
  /\bbalance\b/i,
  /\bbilling\b/i,
  /\bquota\b/i,
  /\bsubscription\b/i,
  /\bpaid (?:plan|tier|account)\b/i,
  /\bcheck ?out\b/i,
  /\bfunds?\b/i,
  /\bunauthori[sz]ed\b/i,
  /\binvalid api[\s_-]?key\b/i
]

/**
 * A provider's own checkout / top-up / billing endpoint. Matched against
 * the whole body, not the head, because a notice may explain itself at
 * length before linking. The path segment must be a billing action, so
 * an unrelated link (`github.com/jane/billing-service`) does not match.
 */
const CHECKOUT_URL_RE =
  /https?:\/\/[^\s)\]"'<>]*\/(?:top[\s_-]?up|checkout|check-out|billing|billings?|payment|payments?|recharge|add[_-]?credits?|buy[_-]?credits?)(?:[/?#\s)\]"'<>]|$)/i

/**
 * Account prose: the body addresses the caller's account / key /
 * subscription instead of answering the prompt. Anchored to the head so
 * that "your" in the middle of a cover letter ("your team's goals") is
 * not a match.
 *
 * Deliberately requires the SECOND PERSON. A bare `Account:` or `Balance:`
 * heading at the start of a body is NOT enough: a finance-flavoured
 * answer opens with those all the time ("Account: the credit facility
 * carries a payment-required covenant…"). It takes `your account` /
 * `the account behind this api key` — phrasings addressed to the caller —
 * which is what a provider writes and an answer about the subject matter
 * does not.
 *
 * NOTE: joined via `.map(r => r.source)` and the flags re-applied on the
 * composed RegExp. `Array.join` stringifies a RegExp via `toString()`,
 * which includes the `/.../i` delimiters — joining the objects directly
 * produces a pattern that can never match anything.
 *
 * `credits` is plural-only here. `credits?` matches the "Credit" in
 * "The Credit Risk Analyst will carry a revenue quota…" — a job title,
 * not a provider address, and a false positive that would discard a real
 * answer.
 */
const ACCOUNT_PROSE_RE = new RegExp(
  [
    /^(?:your|the|this) (?:account|api ?key|subscription|balance|credits|quota|plan|organization|organisation|workspace|team)\b/i,
    /^(?:this|the) (?:model|request|api ?key|key)\b/i,
    /^(?:please )?(?:top ?up|recharge|add credits?|upgrade|visit|go to|sign ?up|log ?in)\b/i,
    /\bthe account behind\b/i,
    /\byour (?:api ?key|account) (?:has|is|does|needs)\b/i
  ]
    .map((r) => r.source)
    .join('|'),
  'i'
)

/**
 * True when the body is a JSON object rather than prose. An object with
 * an `error` key is a provider error envelope, not an answer, so it is
 * NOT short-circuited — that case still has to reach the classifier.
 */
function isAnswerShapedJson(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('```')) return false
  const candidate = trimmed.startsWith('```')
    ? trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
    : trimmed
  try {
    const parsed = JSON.parse(candidate)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return false
    return !('error' in (parsed as Record<string, unknown>))
  } catch {
    // Malformed or truncated JSON: not confidently an answer, so let the
    // phrase rules decide. Being wrong here means a billing notice with a
    // stray brace still gets recognised, which is the safe direction.
    return false
  }
}

function countMatches(phrases: readonly RegExp[], head: string): number {
  let n = 0
  for (const re of phrases) if (re.test(head)) n++
  return n
}

/**
 * Does this response body read as a provider billing/quota/auth notice
 * rather than a model answer?
 *
 * Deliberately conservative — see the header. Returns false whenever
 * there is any doubt.
 */
export function looksLikeProviderNotice(content: string): boolean {
  if (typeof content !== 'string') return false
  const text = content.trim()
  if (text.length === 0) return false

  // A structured answer is an answer. Checked first so that a JSON
  // review whose feedback happens to say "billing" is never discarded.
  if (isAnswerShapedJson(text)) return false

  const head = text.slice(0, HEAD_CHARS)

  // Tier 1 — a provider-shaped balance clause is enough on its own.
  for (const re of DECISIVE_PHRASES) {
    if (re.test(head)) return true
  }

  // Tier 2 — common English that needs corroboration: two supporting
  // phrases AND proof the body is about the account.
  if (countMatches(SUPPORTING_PHRASES, head) < 2) return false
  return CHECKOUT_URL_RE.test(text) || ACCOUNT_PROSE_RE.test(head)
}

/**
 * A short, log-safe label for the failure. Kept out of the classifier so
 * the matching logic stays a pure predicate over the body.
 */
export function describeProviderNotice(content: string): string {
  const snippet = content.replace(/\s+/g, ' ').trim().slice(0, 160)
  return `provider billing/quota notice (not a model response)${snippet ? ` — ${snippet}` : ''}`
}
