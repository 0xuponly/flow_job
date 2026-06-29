export const COUNTRIES: string[] = [
  'Argentina', 'Australia', 'Austria', 'Belgium', 'Brazil', 'Bulgaria', 'Canada',
  'Chile', 'China', 'Colombia', 'Croatia', 'Cyprus', 'Czech Republic', 'Denmark',
  'Estonia', 'Finland', 'France', 'Germany', 'Greece', 'Hong Kong', 'Hungary',
  'Iceland', 'India', 'Indonesia', 'Ireland', 'Israel', 'Italy', 'Japan',
  'Latvia', 'Lithuania', 'Luxembourg', 'Malaysia', 'Malta', 'Mexico', 'Netherlands',
  'New Zealand', 'Nigeria', 'Norway', 'Philippines', 'Poland', 'Portugal',
  'Romania', 'Saudi Arabia', 'Singapore', 'Slovakia', 'Slovenia', 'South Africa',
  'South Korea', 'Spain', 'Sweden', 'Switzerland', 'Taiwan', 'Thailand',
  'Turkey', 'Ukraine', 'United Arab Emirates', 'United Kingdom', 'United States',
  'Vietnam'
]

export function isRecognizedCountry(value: string): boolean {
  if (!value) return false
  const v = value.trim().toLowerCase()
  return COUNTRIES.some((c) => c.toLowerCase() === v)
}