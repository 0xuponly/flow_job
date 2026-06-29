const ENTITY_MAP: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&#x27;': "'",
  '&#x2F;': '/',
  '&#8211;': '–',
  '&#8212;': '—',
  '&#8230;': '…',
  '&#160;': ' ',
  '&nbsp;': ' ',
}

export function decodeEntities(s: string): string {
  return s.replace(/&[#\w]+;/g, (m) => ENTITY_MAP[m] ?? m)
}
