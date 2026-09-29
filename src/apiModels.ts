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
 * Return `incoming` with `api_key` pre-filled from a sibling model that
 * targets the same base_url, when the incoming model has no key yet.
 *
 * An explicit key on `incoming` is never overwritten — the user (or a
 * preset) meant it. If no same-provider sibling has a key, the model is
 * returned unchanged with its empty key.
 */
export function inheritProviderApiKey<T extends { base_url: string; api_key: string }>(
  incoming: T,
  existing: readonly T[]
): T {
  if (incoming.api_key) return incoming
  const target = normalizeBaseUrl(incoming.base_url)
  const sibling = existing.find(
    (m) => m.api_key && normalizeBaseUrl(m.base_url) === target
  )
  return sibling ? { ...incoming, api_key: sibling.api_key } : incoming
}
