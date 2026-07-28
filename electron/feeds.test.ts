import { describe, it, expect } from 'vitest'
import { parseRssFeed } from './feeds'

describe('parseRssFeed', () => {
  it('parses standard RSS 2.0 items', () => {
    const xml = `<?xml version="1.0"?>
<rss version="2.0">
  <channel>
    <title>Indeed Jobs</title>
    <item>
      <title>Software Engineer</title>
      <link>https://example.com/job/123</link>
      <description>&lt;p&gt;Build things.&lt;/p&gt;</description>
      <dc:creator>Acme Corp</dc:creator>
      <pubDate>Mon, 28 Jul 2026 12:00:00 GMT</pubDate>
    </item>
    <item>
      <title>Senior Developer</title>
      <link>https://example.com/job/456</link>
      <description>Full stack role</description>
      <author>Beta Inc</author>
    </item>
    <item>
      <title>NoLinkItem</title>
      <description>Missing link</description>
    </item>
  </channel>
</rss>`
    const jobs = parseRssFeed(xml, 'Indeed')
    expect(jobs).toHaveLength(2)
    expect(jobs[0].title).toBe('Software Engineer')
    expect(jobs[0].company).toBe('Acme Corp')
    expect(jobs[0].url).toBe('https://example.com/job/123')
    expect(jobs[0].description).toBe('Build things.')
    expect(jobs[1].title).toBe('Senior Developer')
    expect(jobs[1].company).toBe('Beta Inc')
    expect(jobs[1].url).toBe('https://example.com/job/456')
  })

  it('falls back to source name when no company found', () => {
    const xml = `<?xml version="1.0"?>
<rss version="2.0">
  <channel>
    <item>
      <title>Engineer</title>
      <link>https://example.com/job/1</link>
      <description>A job</description>
    </item>
  </channel>
</rss>`
    const jobs = parseRssFeed(xml, 'Indeed')
    expect(jobs[0].company).toBe('Indeed')
  })

  it('returns empty array for empty feed', () => {
    const xml = `<?xml version="1.0"?>
<rss version="2.0">
  <channel>
    <title>Empty Feed</title>
  </channel>
</rss>`
    expect(parseRssFeed(xml, 'Indeed')).toEqual([])
  })
})
