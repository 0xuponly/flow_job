import data from './data/locations.json';

type RawCountry = { id: string; name: string };
type RawState = { id: string; name: string; type: 'state' | 'province'; countryId: string };
type RawCity = { id: string; name: string; stateId: string | null; countryId: string };

export type LocationNode = {
  id: string;
  name: string;
  type: 'city' | 'state' | 'province' | 'country';
  parentId: string | null;
  display(): string;
};

const byId = new Map<string, LocationNode>();
let memoized: LocationNode[] | null = null;

function buildNodes(): LocationNode[] {
  if (memoized) return memoized;

  // First pass: build country + state nodes.
  for (const c of data.countries as RawCountry[]) {
    byId.set(c.id, {
      id: c.id,
      name: c.name,
      type: 'country',
      parentId: null,
      display: () => c.name,
    });
  }
  for (const s of data.states as RawState[]) {
    byId.set(s.id, {
      id: s.id,
      name: s.name,
      type: s.type,
      parentId: s.countryId,
      display: () => {
        const country = byId.get(s.countryId);
        return country ? `${s.name}, ${country.name}` : s.name;
      },
    });
  }
  // Second pass: build city nodes — they need to read parent state.
  for (const c of data.cities as RawCity[]) {
    byId.set(c.id, {
      id: c.id,
      name: c.name,
      type: 'city',
      parentId: c.stateId,
      display: () => {
        const parts: string[] = [c.name];
        if (c.stateId) {
          const state = byId.get(c.stateId);
          if (state) {
            parts.push(state.name);
            const country = byId.get(state.parentId!);
            if (country) parts.push(country.name);
          } else {
            const country = byId.get(c.countryId);
            if (country) parts.push(country.name);
          }
        } else {
          const country = byId.get(c.countryId);
          if (country) parts.push(country.name);
        }
        return parts.join(', ');
      },
    });
  }

  memoized = Array.from(byId.values());
  return memoized;
}

export function getLocations(): LocationNode[] {
  return buildNodes();
}

export function getCountries(): string[] {
  return (data.countries as RawCountry[]).map((c) => c.name);
}

export function isRecognizedCountry(value: string): boolean {
  if (!value) return false;
  const v = value.trim().toLowerCase();
  return (data.countries as RawCountry[]).some((c) => c.name.toLowerCase() === v);
}

// In-memory index for fast prefix search. Built lazily on first call.
let byNameIndex: Map<string, LocationNode[]> | null = null;

function buildNameIndex(): Map<string, LocationNode[]> {
  if (byNameIndex) return byNameIndex;
  const idx = new Map<string, LocationNode[]>();
  for (const n of buildNodes()) {
    const key = n.name.toLowerCase();
    const arr = idx.get(key);
    if (arr) arr.push(n);
    else idx.set(key, [n]);
  }
  byNameIndex = idx;
  return idx;
}

// ISO 3166-1 alpha-2 country code map keyed by full English country name.
// Covers the countries flow_job users actually see on scraped job boards;
// unmapped names fall through unchanged. Names match the dataset at
// data/locations.json (and the long-form autocomplete that uses it).
const COUNTRY_CODES: Record<string, string> = {
  'United States': 'US',
  'United States of America': 'US',
  Canada: 'CA',
  'United Kingdom': 'UK',
  'Great Britain': 'UK',
  Australia: 'AU',
  'New Zealand': 'NZ',
  Japan: 'JP',
  Germany: 'DE',
  France: 'FR',
  Netherlands: 'NL',
  Spain: 'ES',
  Italy: 'IT',
  Ireland: 'IE',
  Portugal: 'PT',
  Belgium: 'BE',
  Austria: 'AT',
  Finland: 'FI',
  Greece: 'GR',
  India: 'IN',
  China: 'CN',
  Brazil: 'BR',
  Mexico: 'MX',
  Argentina: 'AR',
  Chile: 'CL',
  Colombia: 'CO',
  Peru: 'PE',
  'South Africa': 'ZA',
  Egypt: 'EG',
  Nigeria: 'NG',
  Kenya: 'KE',
  'United Arab Emirates': 'AE',
  'Saudi Arabia': 'SA',
  Turkey: 'TR',
  Russia: 'RU',
  Ukraine: 'UA',
  Poland: 'PL',
  'Czech Republic': 'CZ',
  'Czechia': 'CZ',
  Hungary: 'HU',
  Romania: 'RO',
  Sweden: 'SE',
  Norway: 'NO',
  Denmark: 'DK',
  Switzerland: 'CH',
  'South Korea': 'KR',
  'Korea, Republic of': 'KR',
  Singapore: 'SG',
  Malaysia: 'MY',
  Thailand: 'TH',
  Vietnam: 'VN',
  Philippines: 'PH',
  Indonesia: 'ID',
  'Hong Kong': 'HK',
  Taiwan: 'TW',
  Pakistan: 'PK',
  Bangladesh: 'BD',
  'Sri Lanka': 'LK',
  Israel: 'IL',
  Luxembourg: 'LU',
  Iceland: 'IS',
  'New Caledonia': 'NC',
};

// Subdivision abbreviation map. Keyed by the full subdivision name as
// it appears in the locations dataset (and the long-form autocomplete).
// 50 US states + DC, 13 Canadian provinces/territories.
const SUBDIVISION_CODES: Record<string, string> = {
  // US states
  Alabama: 'AL',
  Alaska: 'AK',
  Arizona: 'AZ',
  Arkansas: 'AR',
  California: 'CA',
  Colorado: 'CO',
  Connecticut: 'CT',
  Delaware: 'DE',
  'District of Columbia': 'DC',
  Florida: 'FL',
  Georgia: 'GA',
  Hawaii: 'HI',
  Idaho: 'ID',
  Illinois: 'IL',
  Indiana: 'IN',
  Iowa: 'IA',
  Kansas: 'KS',
  Kentucky: 'KY',
  Louisiana: 'LA',
  Maine: 'ME',
  Maryland: 'MD',
  Massachusetts: 'MA',
  Michigan: 'MI',
  Minnesota: 'MN',
  Mississippi: 'MS',
  Missouri: 'MO',
  Montana: 'MT',
  Nebraska: 'NE',
  Nevada: 'NV',
  'New Hampshire': 'NH',
  'New Jersey': 'NJ',
  'New Mexico': 'NM',
  'New York': 'NY',
  'North Carolina': 'NC',
  'North Dakota': 'ND',
  Ohio: 'OH',
  Oklahoma: 'OK',
  Oregon: 'OR',
  Pennsylvania: 'PA',
  'Rhode Island': 'RI',
  'South Carolina': 'SC',
  'South Dakota': 'SD',
  Tennessee: 'TN',
  Texas: 'TX',
  Utah: 'UT',
  Vermont: 'VT',
  Virginia: 'VA',
  Washington: 'WA',
  'West Virginia': 'WV',
  Wisconsin: 'WI',
  Wyoming: 'WY',
  // Canadian provinces and territories
  Alberta: 'AB',
  'British Columbia': 'BC',
  Manitoba: 'MB',
  'New Brunswick': 'NB',
  'Newfoundland and Labrador': 'NL',
  'Nova Scotia': 'NS',
  Ontario: 'ON',
  'Prince Edward Island': 'PE',
  Quebec: 'QC',
  Saskatchewan: 'SK',
  Yukon: 'YT',
  'Northwest Territories': 'NT',
  Nunavut: 'NU',
};

/**
 * Render a long-form location string in a condensed display form.
 *
 * Examples:
 *   "Vancouver, British Columbia, Canada" -> "Vancouver, BC, CA"
 *   "San Francisco, California, United States" -> "San Francisco, CA, US"
 *   "London, United Kingdom" -> "London, UK"
 *   "Remote" -> "Remote"            (free text, no comma)
 *   "" -> ""                        (empty stays empty)
 *   null / undefined -> ""
 *   "Mumbai, Maharashtra, India" -> "Mumbai, Maharashtra, IN"
 *   "Vancouver, British Columbia, Atlantis" -> "Vancouver, BC, Atlantis"
 *
 * Splits on ", " (comma + space), condenses middle segments (state /
 * province) and the last segment (country) when their full name is in
 * the abbreviation maps. Unknown segments are left as-is so unmapped
 * countries/states still show the long form.
 */
export function condenseLocation(value: string | null | undefined): string {
  if (value == null) return '';
  const input = value;
  if (!input) return '';
  const parts = input.split(', ');
  if (parts.length <= 1) return input;
  // Country is the last segment. Look up by full name; fall through if
  // not in the map (handles "Atlantis", free-text like "EU", etc.).
  const countryRaw = parts[parts.length - 1];
  const country = COUNTRY_CODES[countryRaw] ?? countryRaw;
  // Middle segments: state/province. Only the first middle segment has
  // a known abbreviation in practice, but the loop keeps things general.
  const middle: string[] = [];
  for (let i = 1; i < parts.length - 1; i++) {
    const seg = parts[i];
    middle.push(SUBDIVISION_CODES[seg] ?? seg);
  }
  // First segment is the city; always preserved as-is.
  return [parts[0], ...middle, country].join(', ');
}

export function findByPrefix(query: string, limit = 10): LocationNode[] {
  if (!query) return [];
  const q = query.trim().toLowerCase();
  if (!q) return [];

  const idx = buildNameIndex();
  const out: LocationNode[] = [];

  // First pass: exact-prefix matches.
  for (const [name, nodes] of idx) {
    if (name.startsWith(q)) {
      for (const n of nodes) {
        out.push(n);
        if (out.length >= limit) return out;
      }
    }
  }
  return out;
}
