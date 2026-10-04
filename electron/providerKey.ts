// THE PROVIDER BUCKET — the one place that answers "which budget does this
// call come out of?".
//
// It lives in its own module rather than inside ai.ts because two modules
// now need the answer and one of them must not import ai.ts: `ai.ts` reads
// the bucket to enforce the cap, and `database.ts` writes it to the
// persisted ledger — including the one write that has to know a bucket is
// about to be RENAMED (a key rotation on an unchanged endpoint, see
// `saveApiModels`). Two derivations of the same identity is how a key edit
// came to hand the same account a fresh allowance: the reader and the
// writer had to agree, and there was only one of them.
//
// No store access, no AI logic, no side effects beyond one log line per
// unclassifiable model per process. Everything here is a pure function of
// the model config, which is what makes it safe for both callers to use.

import type { ApiModelConfig } from './types'
import { log } from './logger'

/**
 * djb2, string to base36.
 *
 * Not a security boundary: the ledger lives inside the encrypted store, and
 * the credential is only ever hashed so that nothing readable is written
 * down. One-way, stable and cheap — which is all a bucket needs, since a
 * credential is hashed here and never has to be recovered.
 */
export function hashString(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) >>> 0
  }
  return h.toString(36)
}

/**
 * Which CONFIGURED MODEL is this? The health map's key, and — for a base
 * URL the app cannot classify — the tail of that model's private bucket.
 *
 * `id` first so a re-save that keeps the id keeps the entry; the
 * `base_url::model` slug is the fallback for a config object that was
 * never written to the store (a caller building one by hand).
 */
export function modelKey(model: ApiModelConfig): string {
  return model.id || `${model.base_url}::${model.model}`
}

// -------------------------------------------------------------------------
// THE PROVIDER KEY
//
// `modelKey()` above answers "which configured model is this?", which is the
// wrong unit for money. Twenty free OpenRouter models on one key are twenty
// health entries with twenty independent cooldowns, so the provider can be
// called twenty times the moment those lapse — and what gets cut off when a
// free tier runs dry is the KEY, not the model.
//
// So the bucket is derived the same way `modelKey` derives its key — from
// the base URL / the credential, never from the model name — as
// `normalised endpoint + credential fingerprint`:
//
//   * the endpoint, so a model on a different base URL is its own provider
//     (opencode Zen and OpenRouter never share a budget), compared
//     case-insensitively and without a trailing slash, so
//     `https://openrouter.ai/api/v1` and `https://openrouter.ai/api/v1/`
//     are one provider rather than two;
//   * the credential, so two keys against the same host are two budgets —
//     each key has its own allowance, and the thing being protected is the
//     key. Two keys on one account therefore get TWO budgets, which is more
//     permissive than OpenRouter's own per-account free tier; the cap is a
//     ceiling the app puts on itself, and this is the unit it chose. The
//     route that made that choice abusable — editing a model's key to get
//     the same account a new allowance — is closed in `saveApiModels`,
//     which carries the spend across a key edit instead of orphaning it.
//
// The credential is stored as a one-way hash, never as the key and never as
// a fragment of it, so the persisted ledger can match two models that share a
// credential without the store holding one.
// -------------------------------------------------------------------------

/**
 * Host + normalised path of a base URL, or null if it cannot be classified.
 *
 * The path is lower-cased as well as the host. HTTP paths are formally
 * case-sensitive, so this merges two endpoints a pedantic server would
 * treat as distinct — which is the safe direction to be wrong in: a user
 * who typed `/API/v1` once and `/api/v1` once gets ONE budget rather than
 * two, so the cap is tighter than reality rather than looser. The opposite
 * mistake (one host, two spellings, two budgets) is the spend-through
 * direction, and this is the whole reason the path is normalised.
 */
export function providerEndpoint(baseUrl: string | undefined): { key: string; label: string } | null {
  const raw = (baseUrl ?? '').trim()
  if (raw.length === 0) return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  const protocol = url.protocol.toLowerCase()
  // http is legitimate and expected: local models (Ollama, LM Studio) are
  // served over plain http on localhost. Anything else is not an endpoint we
  // know how to spend against.
  if (protocol !== 'http:' && protocol !== 'https:') return null
  const host = url.host.toLowerCase()
  const path = url.pathname.replace(/\/+$/, '').toLowerCase()
  // Query and hash are dropped: an API version or a trailing slash is not a
  // different provider, and `?api-key=` style query credentials would put a
  // secret in a persisted key for no benefit.
  return { key: `${protocol}//${host}${path}`, label: host }
}

export function credentialFingerprint(apiKey: string | undefined): string {
  const raw = (apiKey ?? '').trim()
  if (raw.length === 0) return 'anonymous'
  // One-way and stable. Not a security boundary and not claimed to be — the
  // ledger lives inside the encrypted store — but it is enough that the same
  // credential always lands in the same bucket and nothing readable is
  // written down.
  return hashString(raw)
}

/**
 * UNCLASSIFIABLE BASE URL — the one case that has no honest single answer.
 * If the base URL is not a parseable http(s) URL there is no way to tell
 * whether two such models share a credential, and both available answers are
 * wrong in a way the user pays for:
 *
 *   * bucket them all together, and one typo'd or exotic endpoint silently
 *     spends the whole budget of twenty unrelated models — the rotation goes
 *     dark with no cause on the provider that is working fine;
 *   * treat them as uncapable, and the cap is not a cap.
 *
 * So each unclassifiable model gets a bucket of its own, keyed by its own
 * model key: still capped (the bound holds for every model), never silently
 * merged (nothing else is affected), and logged once per model, because a
 * base URL the app cannot parse is a configuration error the user should
 * hear about rather than a condition to work around quietly.
 *
 * The model's store `id` is what makes "its own" mean anything, and it has
 * a consequence worth stating rather than hiding: deleting a model and
 * adding it back mints a NEW id (`nextModelId`), so such a model starts
 * again with a full budget. That is a deliberate trade for never merging two
 * models the app cannot prove share a credential — the alternative would
 * silently cap an unrelated model, which is the failure mode above. An
 * endpoint the app can parse never has this problem: it buckets on the
 * endpoint, which a re-add cannot change.
 */
// One warning per unclassifiable model per process, not one per rotation.
const unclassifiedProvidersLogged = new Set<string>()

/** Forget the once-per-process warnings, so tests start from a clean slate. */
export function resetProviderKeyWarnings(): void {
  unclassifiedProvidersLogged.clear()
}

export function providerKey(model: ApiModelConfig): string {
  const endpoint = providerEndpoint(model.base_url)
  if (!endpoint) {
    const key = `unclassified:${credentialFingerprint(model.api_key)}:${modelKey(model)}`
    if (!unclassifiedProvidersLogged.has(key)) {
      unclassifiedProvidersLogged.add(key)
      log.ai.warn(
        `[ai] model "${model.name}" has a base URL this app cannot classify; ` +
        'it gets its own provider budget rather than sharing one'
      )
    }
    return key
  }
  return `${endpoint.key}#${credentialFingerprint(model.api_key)}`
}

/**
 * The two buckets a model config is the same provider AS — the one it had,
 * and the one it has now.
 *
 * `saveApiModels` uses this to answer "did the user rotate this model's
 * credential, or move it to another provider?" without re-deriving the
 * rule. `true` means the endpoint is unchanged and the credential is not:
 * the same account, wearing a new key, and the spend already recorded
 * against the old bucket belongs to the new one.
 *
 * Both null for an unclassifiable base URL, because `null` is also how an
 * unclassifiable endpoint reports itself and there is no way to tell an
 * unclassifiable bucket that merely changed id from one that changed
 * meaning. Those get no carry, which is the permissive direction — see the
 * note on `providerKey`'s unclassifiable branch.
 */
export function providerKeyMoved(
  before: Pick<ApiModelConfig, 'base_url' | 'api_key'> | undefined,
  after: Pick<ApiModelConfig, 'base_url' | 'api_key'>
): boolean {
  if (!before) return false
  const was = providerEndpoint(before.base_url)
  const now = providerEndpoint(after.base_url)
  if (!was || !now) return false
  return was.key === now.key && credentialFingerprint(before.api_key) !== credentialFingerprint(after.api_key)
}