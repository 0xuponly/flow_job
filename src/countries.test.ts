import { describe, it, expect } from 'vitest';
import { COUNTRIES, isRecognizedCountry } from './countries';

describe('isRecognizedCountry', () => {
  it('matches exact names', () => {
    expect(isRecognizedCountry('United States')).toBe(true);
  });

  it('is case-insensitive and trims whitespace', () => {
    expect(isRecognizedCountry('  united KINGDOM ')).toBe(true);
  });

  it('rejects unknown values', () => {
    expect(isRecognizedCountry('Atlantis')).toBe(false);
  });

  it('rejects empty input', () => {
    expect(isRecognizedCountry('')).toBe(false);
  });

  it('exports a non-empty list', () => {
    expect(COUNTRIES.length).toBeGreaterThan(0);
  });
});
