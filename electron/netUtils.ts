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
      // Preserve the original error from fetchHtmlViaBrowser instead of
      // wrapping in a generic message — the BrowserWindow path emits
      // specific diagnostics like "This site blocked automated access
      // (Cloudflare)..." that help the user understand what happened.
      throw err instanceof Error ? err : new Error('Blocked by anti-bot protection (Cloudflare/Cloudfront).')
    }
  }

  // Combine the scan-cancel signal with the 30s per-request timeout.
  const timeoutSignal = AbortSignal.timeout(30000)
  const combinedSignal = signal
    ? AbortSignal.any([signal, timeoutSignal])
    : timeoutSignal

  // Retry on transient HTTP errors (429, 5xx) up to 2 times with
  // 1s/3s exponential backoff. The 30s AbortSignal.timeout is the
  // hard upper bound. 501 (Not Implemented) is excluded because
  // no host is going to start implementing it during our retry window.
  const MAX_RETRIES = 2
  const RETRY_DELAYS = [1000, 3000]
  let response: Response
  for (let attempt = 0; ; attempt++) {
    response = await fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br'
      },
      signal: combinedSignal,
      redirect: 'follow'
    })
    if (response.ok || signal?.aborted) break
    const status = response.status
    const transient = status === 429 || (status >= 500 && status !== 501)
    if (!transient || attempt >= MAX_RETRIES) break
    response.body?.cancel().catch(() => {})
    await new Promise(r => setTimeout(r, RETRY_DELAYS[attempt]))
    if (timeoutSignal.aborted) break
  }

  if (response.ok) {
    const html = await response.text()
    if (isChallengePage(html)) {
      try {
        return await fetchHtmlViaBrowser(url, { signal })
      } catch {
        throw new Error(`HTTP ${response.status} (blocked)`)
      }
    }
    return html
  }

  // Non-ok response. Cloudflare (and other WAFs) sometimes return 403
  // with a challenge-page body instead of letting isChallengePage see
  // the HTML. Read the body and, if it looks like a challenge, retry
  // through the browser. If it's a genuine 403 (no challenge body),
  // surface the original error.
  const body = await response.text().catch(() => '')
  if (isChallengePage(body)) {
    try {
      return await fetchHtmlViaBrowser(url, { signal })
    } catch {
      throw new Error(`HTTP ${response.status} (blocked)`)
    }
  }
  throw new Error(`HTTP ${response.status}`)
}

// Fetch a sitemap XML document. Uses the same HTTP-with-challenge-
// fallback as fetchPageHtml. Sitemaps are <urlset> or <sitemapindex>
// XML; the caller runs extractSitemapUrls on the result.
export async function fetchSitemapText(url: string, useBrowser: boolean, signal?: AbortSignal): Promise<string> {
  // Sitemaps are well-known XML; tell the server that's what we
  // want so a Cloudflare-fronted origin doesn't try to serve us
  // an HTML challenge page by default.
  return fetchPageHtml(url, useBrowser, signal)
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
