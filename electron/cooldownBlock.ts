/**
 * What a "no provider is available" failure looks like ON DISK.
 *
 * `callAI` throws this before it makes any request (see
 * `ProviderCooldownError` in ai.ts), so it costs nothing but still has to
 * be told apart from a real failure: the queue used to charge it an
 * attempt, which is how 265 tasks drained a 10-attempt budget in 20
 * hours without a single provider call (2026-10-02 incident).
 *
 * This module exists so the message has exactly ONE definition and both
 * sides of the boundary that has to recognise it can import it:
 *
 *   electron/ai.ts        — throws it (via ProviderCooldownError)
 *   electron/database.ts  — the one-shot migration
 *                           (`unpoisonCooldownFailedAIQueueItems`) matches
 *                           rows whose recorded `lastError` is this text
 *
 * It cannot live in either of those without an import cycle: ai.ts
 * already imports database.ts, and database.ts importing ai.ts would
 * close the loop. It imports nothing, so it is safe from both sides.
 *
 * This is a MESSAGE MATCH and it is deliberately quarantined here, away
 * from every branch that decides anything. Control flow runs off
 * `instanceof ProviderCooldownError` / `providerAvailability()`, which
 * cannot drift when the copy is reworded. What is left is data repair
 * over rows an older build already wrote: those rows have nothing on
 * disk but the text, so text is the only thing that can identify them.
 * The error type is the discriminator at runtime and this is the
 * historical one, and the two are produced from the same constant so
 * they cannot disagree.
 */
export const PROVIDERS_COOLING_DOWN_MESSAGE =
  'All configured AI models are cooling down after rate limits or persistent errors — try again shortly.'

/**
 * Is this recorded error the no-request cooldown block?
 *
 * Anchored on the fixed prefix, not an `includes` anywhere in the
 * string: the part that identifies the condition is "every model is
 * cooling down", and the tail after it is user-facing prose that may be
 * reworded. Anchoring there means a reworded tail still matches and an
 * unrelated error that merely mentions cooling down does not.
 *
 * Null / undefined / empty is false — a row with no recorded failure is
 * not a poisoned row.
 */
export function isCooldownBlockedMessage(message?: string | null): boolean {
  if (typeof message !== 'string') return false
  return message.startsWith('All configured AI models are cooling down')
}