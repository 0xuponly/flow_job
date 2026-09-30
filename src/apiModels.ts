// Helpers for reasoning about the user's configured AI providers.
//
// A "provider" here is identified by where a base_url actually sends
// traffic: scheme, host, port, and the first path segment (the routing
// prefix a self-hosted gateway uses to pick an upstream). Two model
// configs addressing the same provider can share one credential. This is
// what lets the user add a second model from a provider they already
// configured without re-pasting their key.

/** Strip trailing slashes so `https://x/v1` and `https://x/v1/` match. */
function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '')
}

/** The parts of a base_url that separate one credential from another. */
interface ProviderTarget {
  /** Lowercased, with the colon: `https:` / `http:`. */
  scheme: string
  /** Lowercased hostname, no port. */
  host: string
  /** Effective port, `''` for the scheme's default. */
  port: string
  /**
   * First path segment, lowercased — the gateway's upstream selector.
   * `''` when the URL has no path segment, which matches only another
   * `''`: a bare host must not donate its key to every path on that host.
   */
  firstSegment: string
}

/**
 * Decompose a base_url into its provider identity, or null when the
 * string isn't parseable as a URL, so junk strings never match.
 *
 * A missing scheme is read as `https:`, matching how the URL is used.
 * The port is the URL's *effective* port: the parser already drops the
 * scheme's default, so `https://x:443` and `https://x` agree while
 * `https://x:80` stays distinct from `https://x`.
 */
function providerTarget(baseUrl: string): ProviderTarget | null {
  const raw = normalizeBaseUrl(baseUrl)
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`
  try {
    const url = new URL(withScheme)
    if (!url.hostname) return null
    const segments = url.pathname.split('/').filter(Boolean)
    return {
      scheme: url.protocol.toLowerCase(),
      host: url.hostname.toLowerCase(),
      port: url.port,
      firstSegment: segments[0]?.toLowerCase() ?? ''
    }
  } catch {
    return null
  }
}

/**
 * True when two base_urls address the same provider.
 *
 * Exact (normalized) equality is checked first by the caller. As a
 * fallback the two URLs are compared on everything that decides where
 * the request goes: host, effective port, first path segment, and — in
 * one direction only — scheme. The same provider is routinely typed a
 * few different ways (`https://openrouter.ai/api` vs `.../api/v1`, a
 * trailing slash, a capitalised host, an explicit `:443`) and those all
 * still match, because none of them moves the traffic.
 *
 * What deliberately does not match, because it moves a credential to a
 * party that was never issued it:
 *  - a different first path segment. A shared gateway fronts several
 *    upstreams behind one host and issues a separate key per upstream
 *    (`/openai/v1` vs `/anthropic/v1`); treating those as one provider
 *    hands one vendor's key to a different vendor.
 *  - a different port. Another process on the host, another service.
 *  - a plaintext downgrade. A key configured for an `https:` endpoint is
 *    never handed to an `http:` one. The reverse (a key that was already
 *    in cleartext moving to TLS) is allowed: it only narrows exposure.
 */
function sameProvider(siblingBaseUrl: string, incomingBaseUrl: string): boolean {
  if (normalizeBaseUrl(siblingBaseUrl) === normalizeBaseUrl(incomingBaseUrl)) return true
  const sibling = providerTarget(siblingBaseUrl)
  const incoming = providerTarget(incomingBaseUrl)
  if (!sibling || !incoming) return false
  if (sibling.host !== incoming.host) return false
  if (sibling.port !== incoming.port) return false
  if (sibling.firstSegment !== incoming.firstSegment) return false
  // No plaintext downgrade, ever: the incoming endpoint may not be
  // cleartext when the one the key would come from is not.
  if (incoming.scheme === 'http:' && sibling.scheme !== 'http:') return false
  return true
}

/**
 * Return `incoming` with `api_key` pre-filled from a sibling model that
 * targets the same base_url, when the incoming model has no key yet.
 *
 * An explicit key on `incoming` is never overwritten — the user (or a
 * preset) meant it. Exact URL matches win over same-provider ones, so
 * the model's own spelling beats a looser one. If no same-provider
 * sibling has a key, the model is returned unchanged with its empty key.
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
