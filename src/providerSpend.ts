/**
 * ONE AI PROVIDER'S SPEND, AS THE RENDERER IS ALLOWED TO SEE IT.
 *
 * The renderer cannot reach `ProviderBudget` (electron/ai.ts): the numbers
 * live in the main process behind a persisted ledger, and the renderer gets
 * them over IPC like every other piece of app state. This is that shape — the
 * contract for `ai:providerSpend` — and it is deliberately NOT
 * `ProviderBudget`:
 *
 *   * no `key`. That is the bucket identity, `endpoint#credential hash`, and
 *     the app's rule is that ids and credentials stay in the main process.
 *     The row is identified by its `label`, which `providerBudget` documents
 *     as "Host, for logs and the cap message. Never a path, a key or an id".
 *   * no `ProviderBudget` import, so the two sides cannot drift: the handler's
 *     return type and the renderer's are the same declaration. (This is the
 *     opposite of `src/queueBlocked.ts`, which mirrors a main-process type
 *     because the two halves of that shape were written separately; here the
 *     renderer half is the only place a renderer can legally import from, and
 *     main-process modules may import from `src/` — main.ts already does.)
 *
 * Every field is a real value read from the real ledger. Nothing here is
 * derived, rounded, defaulted or carried over: if the ledger cannot be read,
 * the answer is an error at the call site, never a zero standing in for one.
 */
export interface ProviderSpend {
  /** Host of the provider, or `<unclassifiable base URL>`. Never a path. */
  label: string
  /** Total real calls inside the rolling 24h window, automated and manual. */
  used: number
  /** Of those, the ones the app issued on its own. */
  automated: number
  /** Of those, the ones a person asked for. */
  manual: number
  /** The cap this provider is measured against, as the app enforces it. */
  cap: number
  /**
   * Epoch ms this provider's budget frees — the instant `used` drops BELOW
   * `cap`. Null while there is still room, which is not the same as "in the
   * past": it means there is no wait to describe.
   */
  freeAt: number | null
  /**
   * A recorded call is dated more than a whole window ahead of now, so every
   * timestamp in this ledger is suspect and the cap is not being applied to
   * this provider at all. The spend is still reported, because deleting it
   * would hide the anomaly rather than fix it — but it cannot be presented as
   * a number to act on.
   */
  clockSkewed: boolean
}
