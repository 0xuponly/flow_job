/**
 * Country (ISO 3166-1 alpha-2) → currency (ISO 4217) lookup.
 *
 * Mirrors the writer's `COUNTRIES` map in electron/utils.ts: every
 * country that the location normalizer can write to the store has a
 * currency entry here. The decider in src/pages/JobsPage.tsx reads
 * its dual-mirror in src/currency.ts.
 *
 * Currencies follow ISO 4217 alphabetic codes. Where a country
 * officially uses a non-USD dollar or a non-EUR euro, we use the
 * local code (CAD, AUD, CHF, etc.) — the goal is correct labeling,
 * not regional preferences.
 *
 * `IL` (Israel) is intentionally absent. The "no Israel in geo
 * datasets" convention removes Israel from the country map at the
 * writer; the corresponding currency entry is not added here.
 */
export const COUNTRY_TO_CURRENCY: Record<string, string> = {
  // Americas
  US: 'USD',
  CA: 'CAD',
  BR: 'BRL',
  MX: 'MXN',
  AR: 'ARS',
  CL: 'CLP',
  CO: 'COP',
  // Europe — Eurozone
  DE: 'EUR', FR: 'EUR', NL: 'EUR', ES: 'EUR', IT: 'EUR', IE: 'EUR',
  PT: 'EUR', BE: 'EUR', AT: 'EUR', FI: 'EUR', GR: 'EUR',
  // Europe — non-Eurozone
  GB: 'GBP',
  SE: 'SEK', NO: 'NOK', DK: 'DKK', CH: 'CHF',
  PL: 'PLN', CZ: 'CZK', HU: 'HUF', RO: 'RON',
  // Asia
  IN: 'INR', CN: 'CNY', JP: 'JPY', KR: 'KRW',
  SG: 'SGD', HK: 'HKD', TW: 'TWD',
  // Middle East / Africa
  AE: 'AED', ZA: 'ZAR', NG: 'NGN', EG: 'EGP', KE: 'KES',
  // Eastern Europe / Caucasus
  TR: 'TRY', RU: 'RUB', UA: 'UAH',
  // Oceania
  AU: 'AUD', NZ: 'NZD',
}
