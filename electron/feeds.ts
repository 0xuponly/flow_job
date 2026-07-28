import type { CreateJobInput } from './types'

/**
 * Parse RSS feed XML into CreateJobInput entries.
 * Handles standard RSS 2.0 <item> elements with <title>, <link>,
 * <description>, <pubDate>, and optional <dc:creator> for company.
 */
export function parseRssFeed(xml: string, sourceName: string): CreateJobInput[] {
  const jobs: CreateJobInput[] = []

  // Extract <item> blocks
  const itemRe = /<item>([\s\S]*?)<\/item>/gi
  let itemMatch: RegExpExecArray | null
  while ((itemMatch = itemRe.exec(xml)) !== null) {
    const item = itemMatch[1]

    const title = extractTag(item, 'title')
    const link = extractTag(item, 'link')
    // dc:creator (namespace-prefixed) or author
    let company = extractTag(item, 'dc:creator') || extractTag(item, 'author')
    const description = extractTag(item, 'description')

    if (!title || !link) continue

    // Clean HTML entities from the description.
    // Decode entities first so HTML tags can be stripped afterwards.
    const cleanedDesc = description
      ? decodeEntities(description)
          .replace(/<[^>]+>/g, ' ')  // strip HTML tags
          .replace(/\s+/g, ' ')
          .trim()
      : undefined

    jobs.push({
      title: decodeEntities(title),
      company: company ? decodeEntities(company) : sourceName,
      url: link,
      description: cleanedDesc,
      source: sourceName
    })
  }

  return jobs
}

function extractTag(xml: string, tag: string): string | undefined {
  // Handle both <tag> and <tag attr="..."> opening tags
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i')
  const m = re.exec(xml)
  return m ? m[1].trim() : undefined
}

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, '/')
}
