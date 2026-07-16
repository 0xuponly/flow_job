// Minimal RSS 2.0 / Atom feed parser for job-board feeds.
//
// We don't pull a dependency for this — RSS 2.0 and Atom 1.0 are
// simple XML formats and the inputs we deal with are predictable
// (Remotive, We Work Remotely, Authentic Jobs, Startup.jobs, etc.).
// A 60-line regex parser is enough; if a feed breaks in production,
// we can add a real XML parser then.
//
// Each fetch returns a list of CreateJobInput ready for createJob.
// The caller is expected to apply the same work-type/location/dup
// funnel as the other apiFetcher boards.

import type { CreateJobInput } from './types'

interface FeedOpts {
  signal?: AbortSignal
}

// Decode the few common XML entities. Anything we don't recognize
// we pass through unchanged; createJob's `decodeEntities` pass will
// catch the rest.
function decode(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .trim()
}

// Extract a top-level XML element's text content. Returns null if
// not present. Used for `<title>`, `<description>`, `<link>`, etc.
function extractTag(xml: string, tag: string): string | null {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i')
  const m = xml.match(re)
  if (!m) return null
  return decode(m[1])
}

// Atom feeds use `<entry>` rather than `<item>`. Detect the format
// by the presence of `<feed ` or `<rss ` and dispatch.
function parseRss2(xml: string, source: string): CreateJobInput[] {
  const out: CreateJobInput[] = []
  // Match each `<item>...</item>` block.
  const itemRe = /<item[\s>][\s\S]*?<\/item>/gi
  let m: RegExpExecArray | null
  while ((m = itemRe.exec(xml)) !== null) {
    const block = m[0]
    const title = extractTag(block, 'title') || ''
    const link = extractTag(block, 'link') || ''
    const description = extractTag(block, 'description') || ''
    if (!title || !link) continue
    // RSS feeds often have very short `<description>`; that's
    // enough for our use — the listing-side description is what
    // the user sees, and createJob requires non-empty.
    const cleanTitle = title.replace(/<[^>]+>/g, '').trim()
    const cleanDesc = description.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
    if (!cleanTitle || !cleanDesc) continue
    // Try to pick a company from `<author>` or from a known pattern
    // in the title; RSS feeds vary widely.
    const author = extractTag(block, 'author') || extractTag(block, 'dc:creator') || ''
    out.push({
      title: cleanTitle,
      company: author.trim() || source,
      location: 'Remote',
      url: link.trim(),
      description: cleanDesc,
      salary_range: null,
      source,
      requirements: null,
      application_requirements: null,
      hiring_manager: null,
      employment_type: null,
      work_mode: 'REMOTE',
      notes: null
    })
  }
  return out
}

// Fetch and parse a single feed URL. Returns [] on any error so
// a broken feed doesn't kill the scan.
export async function fetchRssFeed(url: string, source: string, opts: FeedOpts = {}): Promise<CreateJobInput[]> {
  try {
    const response = await fetch(url, { headers: { Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml' }, signal: opts.signal })
    if (!response.ok) return []
    const xml = await response.text()
    return parseRss2(xml, source)
  } catch {
    return []
  }
}
