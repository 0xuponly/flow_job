import { describe, it, expect } from 'vitest'
import { formatLocation, normalizeTitle, normalizeCompany } from './utils'

describe('formatLocation — country-last contract', () => {
  it('1-part input with defaultCountry produces City, CC', () => {
    expect(formatLocation('Vancouver', 'Canada')).toBe('Vancouver, CA')
  })

  it('1-part input without defaultCountry returns null', () => {
    expect(formatLocation('Vancouver', '')).toBeNull()
  })

  // 1-part input that is already a known country name should NOT
  // have the defaultCountry appended — "Canada" + user_country "CA"
  // would otherwise round-trip to "Canada, CA", which the
  // renderer's condenseLocation collapses back to "Canada" anyway.
  // Return the input as-is; the renderer's currency decider has a
  // long-name fallback that recovers the 2-letter code.
  it('1-part input that is a known country name returns the name verbatim (no defaultCountry append)', () => {
    expect(formatLocation('Canada', 'CA')).toBe('Canada')
    expect(formatLocation('United States', 'US')).toBe('United States')
    expect(formatLocation('United Kingdom', 'GB')).toBe('United Kingdom')
  })

  it('2-part input where second token is a known 2-letter country code produces City, CC', () => {
    expect(formatLocation('Vancouver, CA', 'US')).toBe('Vancouver, CA')
  })

  it('2-part input where second token is an unknown 2-letter code falls back to defaultCountry', () => {
    expect(formatLocation('Vancouver, MH', 'US')).toBe('Vancouver, US')
  })

  it('2-part input with unknown full-name second token falls back to defaultCountry', () => {
    expect(formatLocation('Vancouver, Atlantis', 'US')).toBe('Vancouver, US')
  })

  it('2-part input with unknown full-name and no defaultCountry returns null', () => {
    expect(formatLocation('Vancouver, Atlantis', '')).toBeNull()
  })

  it('2-part input where second token is a region produces City, REGION (no defaultCountry append)', () => {
    expect(formatLocation('Vancouver, BC', 'US')).toBe('Vancouver, BC')
  })

  it('2-part input where second token is a full country name produces City, CC', () => {
    expect(formatLocation('London, United Kingdom', 'US')).toBe('London, GB')
  })

  it('3-part input with known region and country produces City, REGION, CC', () => {
    expect(formatLocation('Vancouver, BC, Canada', 'US')).toBe('Vancouver, BC, CA')
  })

  it('3-part input with unknown region and known country produces City, CC', () => {
    expect(formatLocation('Sydney, NSW, Australia', 'US')).toBe('Sydney, AU')
  })

  it('3-part input with known region and unknown country falls back to defaultCountry', () => {
    expect(formatLocation('Paris, Île-de-France, Atlantis', 'FR')).toBe('Paris, Île-de-France, FR')
  })

  it('3-part input with neither region nor country and no defaultCountry returns null', () => {
    expect(formatLocation('Foo, Bar, Baz', '')).toBeNull()
  })

  it('Remote token is preserved verbatim', () => {
    expect(formatLocation('Remote', 'US')).toBe('Remote')
  })

  it('Remote token with country suffix is collapsed to just the token', () => {
    expect(formatLocation('Remote, CA, US', 'US')).toBe('Remote')
  })

  it('null input returns null', () => {
    expect(formatLocation(null, 'US')).toBeNull()
  })

  it('empty input returns null', () => {
    expect(formatLocation('', 'US')).toBeNull()
  })

  it('multi-location joined by semicolon normalizes each piece', () => {
    expect(formatLocation('Vancouver, BC; Toronto, ON', 'US')).toBe('Vancouver, BC; Toronto, ON')
  })
})

describe('normalizeTitle — Roman numerals', () => {
  it('preserves trailing "II" when source is all-caps', () => {
    expect(normalizeTitle('Recreation Assistant Ii')).toBe('Recreation Assistant II')
  })
  it('preserves trailing "III" when source is all-caps', () => {
    expect(normalizeTitle('Analyst Iii')).toBe('Analyst III')
  })
  it('preserves trailing "IV" when source is all-caps', () => {
    expect(normalizeTitle('Engineer Iv')).toBe('Engineer IV')
  })
  it('preserves trailing single-letter "I" when source is all-caps', () => {
    expect(normalizeTitle('Data Analyst I')).toBe('Data Analyst I')
  })
  it('canonicalizes mid-title "Ii" before a separator (real-world job title)', () => {
    expect(normalizeTitle('Senior Software Engineer Ii - Shopper Activation & Engagement'))
      .toBe('Senior Software Engineer II - Shopper Activation & Engagement')
  })
  it('canonicalizes mid-title Roman numeral "III"', () => {
    expect(normalizeTitle('Iii Consultant')).toBe('III Consultant')
  })
})

describe('normalizeTitle — acronyms', () => {
  it('preserves "IT" anywhere in the title', () => {
    expect(normalizeTitle('It Director')).toBe('IT Director')
  })
  it('preserves "AI" anywhere in the title', () => {
    expect(normalizeTitle('Senior Ai Analytics')).toBe('Senior AI Analytics')
  })
  it('preserves mid-title acronyms like "QA"', () => {
    expect(normalizeTitle('Senior Qa Engineer')).toBe('Senior QA Engineer')
  })
  it('preserves 3-letter acronyms like "SRE"', () => {
    expect(normalizeTitle('Sre Engineer')).toBe('SRE Engineer')
  })
  it('preserves "CSE" anywhere in the title', () => {
    expect(normalizeTitle('CSE Manager')).toBe('CSE Manager')
    expect(normalizeTitle('cse manager')).toBe('CSE Manager')
  })
})

describe('normalizeTitle — intentionally-mixed-case acronyms', () => {
  it('normalizes "Phd" to "PhD"', () => {
    expect(normalizeTitle('Phd Student')).toBe('PhD Student')
  })
  it('normalizes "Ios" to "iOS"', () => {
    expect(normalizeTitle('Ios Engineer')).toBe('iOS Engineer')
  })
  it('normalizes "Ebay" to "eBay"', () => {
    expect(normalizeTitle('Ebay Seller')).toBe('eBay Seller')
  })
})

describe('normalizeTitle — regressions', () => {
  it('basic title case still works', () => {
    expect(normalizeTitle('software developer')).toBe('Software Developer')
  })
  it('lowercases all-caps then title-cases', () => {
    expect(normalizeTitle('SENIOR SOFTWARE DEVELOPER')).toBe('Senior Software Developer')
  })
  it('keeps small words lowercase mid-title', () => {
    expect(normalizeTitle('manager of engineering')).toBe('Manager of Engineering')
  })
  it('preserves mixed-case tokens like "iOS"', () => {
    expect(normalizeTitle('iOS engineer')).toBe('iOS Engineer')
  })
  it('returns null for null input', () => {
    expect(normalizeTitle(null)).toBeNull()
  })
  it('returns null for empty input', () => {
    expect(normalizeTitle('   ')).toBeNull()
  })
})

describe('normalizeCompany — acronyms', () => {
  it('preserves "IBM" all-caps', () => {
    expect(normalizeCompany('IBM')).toBe('IBM')
  })
  it('canonicalizes lowercase acronyms to upper-case', () => {
    expect(normalizeCompany('ibm')).toBe('IBM')
  })
  it('canonicalizes mixed-case acronyms to upper-case', () => {
    expect(normalizeCompany('Ibm')).toBe('IBM')
  })
  it('preserves "EY"', () => {
    expect(normalizeCompany('EY')).toBe('EY')
  })
  it('preserves "SAP"', () => {
    expect(normalizeCompany('SAP')).toBe('SAP')
  })
  it('preserves "GitHub" via mixed-case rule', () => {
    expect(normalizeCompany('GitHub')).toBe('GitHub')
  })
  it('strips trailing punctuation', () => {
    expect(normalizeCompany('IBM Corp.')).toBe('IBM Corp')
  })
})
