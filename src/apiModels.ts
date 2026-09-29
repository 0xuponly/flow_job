// Helpers for reasoning about the user's configured AI providers.
//
// A "provider" here is identified purely by its base_url: two model
// configs pointing at the same base_url are the same provider and can
// share one credential. This is what lets the user add a second model
// from a provider they already configured without re-pasting their key.

/** Strip trailing slashes so `https://x/v1` and `https://x/v1/` match. */
function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '')
}

/**
 * Scheme-less host[:port] for a base_url, lowercased, with the default
 * port for the scheme dropped. Returns null when the string isn't
 * parseable as a URL, so junk strings never accidentally match.
 */
function originOf(baseUrl: string): string | null {
  const raw = normalizeBaseUrl(baseUrl)
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`
  try {
    const url = new URL(withScheme)
    const port = url.port && url.port !== '443' && url.port !== '80' ? `:${url.port}` : ''
    return `${url.hostname.toLowerCase()}${port}`
  } catch {
    return null
  }
}

/**
 * True when two base_urls address the same provider.
 *
 * Exact (normalized) equality is checked first by the caller. As a
 * fallback we compare the origin, because the same provider is routinely
 * typed a few different ways — `https://openrouter.ai/api` vs
 * `.../api/v1`, a trailing slash, a capitalised host, an explicit `:443`.
 *
 * Trade-off: two configs that differ only in path on the same host are
 * treated as one provider, so a self-hosted gateway fronting several
 * upstreams would share a key. That is the intended trade — it is far
 * more common for someone to typo a path than to run a multi-provider
 * proxy, and the key is still theirs to overwrite.
 */
function sameProvider(a: string, b: string): boolean {
  if (normalizeBaseUrl(a) === normalizeBaseUrl(b)) return true
  const originA = originOf(a)
  return originA !== null && originA === originOf(b)
}

/**
 * Return `incoming` with `api_key` pre-filled from a sibling model that
 * targets the same base_url, when the incoming model has no key yet.
 *
 * An explicit key on `incoming` is never overwritten — the user (or a
 * preset) meant it. Exact URL matches win over looser same-host ones.
 * If no same-provider sibling has a key, the model is returned unchanged
 * with its empty key.
 */
export function inheritProviderApiKey<T extends { base_url: string; api_key: string }>(
  incoming: T,
  existing: readonly T[]
): T {
  if (incoming.api_key) return incoming
  const keyed = existing.filter((m) => m.api_key)
  const exact = keyed.find((m) => normalizeBaseUrl(m.base_url) === normalizeBaseUrl(incoming.base_url))
  const sibling = exact ?? keyed.find((m) => sameProvider(m.base_url, incoming.base_url))
  return sibling ? { ...incoming, api_key: sibling.api_key } : incoming
}
