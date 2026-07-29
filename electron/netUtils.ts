// Shared network helpers for board scanning and per-URL job ingestion.
// Previously duplicated in boards.ts and jobSearch.ts.

import { fetchHtmlViaBrowser, isChallengePage } from './browserScraper'

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

export async function fetchPageHtml(url: string, useBrowser: boolean, signal?: AbortSignal): Promise<string> {
  if (useBrowser) {
    try {
      return await fetchHtmlViaBrowser(url, { signal })
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') throw err
      throw new Error('Blocked by anti-bot protection (Cloudflare/Cloudfront).')
    }
  }
  // Combine the scan-cancel signal with the 30s per-request timeout.
  // Without this, a Cancel click during a long fetch leaves the request
  // running until the timeout fires (up to 30s), which the user reads as
  // "Cancel is broken." Combining the two signals means either source of
  // abort tears the in-flight request down immediately.
  const timeoutSignal = AbortSignal.timeout(30000)
  const combinedSignal = signal
    ? AbortSignal.any([signal, timeoutSignal])
    : timeoutSignal
  const response = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br'
    },
    signal: combinedSignal,
    redirect: 'follow'
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const html = await response.text()
  if (isChallengePage(html)) {
    try {
      return await fetchHtmlViaBrowser(url, { signal })
    } catch {
      throw new Error(`HTTP ${  response.status  } (blocked)`)
    }
  }
  return html
}

// Fetch a sitemap XML document. Uses the same HTTP-with-challenge-
// fallback as fetchPageHtml. Sitemaps are <urlset> or <sitemapindex>
// XML; the caller runs extractSitemapUrls on the result.
export async function fetchSitemapText(url: string, useBrowser: boolean): Promise<string> {
  // Sitemaps are well-known XML; tell the server that's what we
  // want so a Cloudflare-fronted origin doesn't try to serve us
  // an HTML challenge page by default.
  return fetchPageHtml(url, useBrowser)
}

// Pull <loc>...</loc> URLs out of a sitemap XML document. Handles
// both <urlset> (returns the per-URL <loc>s) and <sitemapindex>
// (returns the sub-sitemap <loc>s — the caller fetches them in
// turn). Returns a de-duplicated list.
export function extractSitemapUrls(xml: string): string[] {
  const locRe = /<loc>\s*([^<]+?)\s*<\/loc>/gi
  const out: string[] = []
  const seen = new Set<string>()
  let m: RegExpExecArray | null
  while ((m = locRe.exec(xml)) !== null) {
    const u = m[1].trim()
    if (!seen.has(u)) {
      seen.add(u)
      out.push(u)
    }
  }
  return out
}
