/**
 * Dual-mirror of electron/currency.ts. The renderer cannot import
 * from electron/, so the table is duplicated here. The two files must
 * stay in lockstep; if you add or change an entry on one side, mirror
 * it on the other in the same commit.
 *
 * See electron/currency.ts for the rationale on which countries are
 * included and why Israel is excluded.
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
