/**
 * THE PER-PROVIDER SPEND, READ OUT OF THE REAL LEDGER.
 *
 * The number was always there. `providerBudget(key, now)` in `ai.ts` counts
 * the recorded requests inside the rolling 24h window for one provider
 * bucket and already carries everything a user needs to act on: `used`,
 * `automated`, `manual`, `cap`, `freeAt`, `clockSkewed`. On a real 6h44m
 * window it returned 629 against a cap of 50 — and Settings → Auto-queue →
 * AI provider budget showed the user the 50, because the cap they TYPED is
 * the only number that had a path to the screen. This module is that path:
 * one row per provider, built field by field from `providerBudget`, with no
 * second source of truth and no arithmetic of its own.
 *
 * WHY PER PROVIDER AND NOT ONE TOTAL. The cap is per provider — a single
 * `provider_call_cap` setting, applied to each credential separately
 * (`providerKey`: endpoint + credential fingerprint). A user with two keys
 * has two ledgers and therefore two budgets, so a summed total would be a
 * number compared against a cap that does not exist, and could read as
 * "over" while every individual provider is under.
 *
 * WHY THE ROWS ARE THE UNION OF THE MODEL LIST AND THE LEDGER. "Which
 * providers exist" has two honest answers and this page needs both:
 *
 *   * every provider a CONFIGURED MODEL buckets into, whether or not it has
 *     spent anything. A provider the user set up and has not called is a real
 *     provider with a real count of zero, and it is the row that tells them
 *     what they have. Blank API key included: the shipped OpenRouter presets
 *     all carry one until the user pastes their key, and a local endpoint
 *     needs none, so `credentialFingerprint('')` buckets as `anonymous` and
 *     gets its own row rather than being dropped or merged into a keyed one.
 *   * every provider the LEDGER still holds spend for, even if no model
 *     configures it any more. Deleting a model does not un-spend the money,
 *     and `getProviderSpend` only drops a bucket once every stamp in it has
 *     aged out of the window. Omitting these is the same defect as the one
 *     this module was added to fix: a ledger saying 629 and a page saying
 *     nothing at all.
 *
 * What is deliberately NOT here is a row for a provider that does not exist:
 * with nothing configured and nothing recorded the answer is the empty list,
 * because a row carrying `used: 0` for a provider the user never configured
 * is indistinguishable, on screen, from a real measurement of zero.
 *
 * `now` is a parameter, never read here. It is the same one `providerBudget`
 * takes and the same one the renderer is handed, so "which day is this moment
 * on" and "has this moment passed" are decided by one clock reading (see
 * `clockTime` in ai.ts, and why that function takes `now`).
 */
import { getProviderSpend, listApiModels } from './database'
import { providerKey } from './providerKey'
import { providerBudget } from './ai'
import type { ProviderBudget } from './ai'
import type { ProviderSpend } from '../src/providerSpend'

export type { ProviderSpend }

/**
 * The label this payload carries: the HOST, which is as much of
 * `ProviderBudget.label` as belongs on a screen.
 *
 * `providerLabel` (ai.ts) documents itself as "Host, for logs and the cap
 * message. Never a path, a key or an id" and then returns the whole endpoint
 * — for `https://openrouter.ai/api/v1` it yields `openrouter.ai/api/v1`, so
 * the path is in it. (The doc comment and the code disagree; ai.ts is not
 * this lane's to change, so the payload is trimmed here instead of inheriting
 * the path.) Cutting at the first `/` is exact rather than a guess: what
 * `providerLabel` returns is `authority + path`, and a URL authority cannot
 * contain a slash, so the first one can only be the start of the path. A port
 * survives the cut, which is right — two local services on one machine are
 * told apart by it. `<unclassifiable base URL>` has no slash and is returned
 * whole, which is the sentence the rest of the app uses for that case.
 *
 * The path is not secret (the user typed it into Settings → Models), but the
 * rule this project works to is that the UI shows outcomes rather than
 * configuration, and a spend row is an outcome. The host is also the whole of
 * what identifies the provider to a person reading it.
 */
function providerHost(budget: ProviderBudget): string {
  const slash = budget.label.indexOf('/')
  return slash === -1 ? budget.label : budget.label.slice(0, slash)
}


/**
 * One row per provider bucket, in a stable order.
 *
 * Configured providers first, in the order the user arranged their models —
 * so a row's position does not move when an unrelated provider's ledger ages
 * out — then any ledger-only provider, sorted by label so two runs over the
 * same store give the same list.
 *
 * The bucket key is used for de-duplication and for ordering the tail, and is
 * never returned: it is `endpoint#credential hash`, and this payload goes to
 * a renderer (see `ProviderSpend`).
 */
export function providerSpendRows(now: number = Date.now()): ProviderSpend[] {
  const keys: string[] = []
  const seen = new Set<string>()
  for (const model of listApiModels()) {
    const key = providerKey(model)
    if (seen.has(key)) continue
    seen.add(key)
    keys.push(key)
  }
  const unconfigured = Object.keys(getProviderSpend())
    .filter((key) => !seen.has(key))
    .sort((a, b) => (providerBudget(a, now).label < providerBudget(b, now).label ? -1 : 1))
  keys.push(...unconfigured)

  return keys.map((key) => {
    const budget = providerBudget(key, now)
    // Field by field, deliberately: `ProviderBudget` also carries `key`, and
    // spreading the struct would ship the bucket identity to the renderer.
    return {
      label: providerHost(budget),
      used: budget.used,
      automated: budget.automated,
      manual: budget.manual,
      cap: budget.cap,
      freeAt: budget.freeAt,
      clockSkewed: budget.clockSkewed
    }
  })
}
