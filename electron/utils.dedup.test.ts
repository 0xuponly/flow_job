import { describe, it, expect } from 'vitest'
import { dedupKey } from './utils'

describe('dedupKey', () => {
  it('normalizes to lowercase and strips trailing slash', () => {
    expect(dedupKey('https://Example.COM/Job/123/')).toBe('https://example.com/job/123')
  })

  it('strips common tracking parameters', () => {
    const url = 'https://example.com/job/1?utm_source=linkedin&utm_medium=ref&ref=abc&id=5'
    expect(dedupKey(url)).toBe('https://example.com/job/1?id=5')
  })

  it('preserves path-like hash fragments (e.g. WorkBC)', () => {
    const url = 'https://www.workbc.ca/find-job/search-jobs#/job-details/12345'
    expect(dedupKey(url)).toContain('#/job-details/12345')
  })

  it('strips non-path hash fragments (e.g. anchors)', () => {
    const url = 'https://example.com/job/1#apply'
    expect(dedupKey(url)).toBe('https://example.com/job/1')
  })

  it('handles invalid URLs gracefully', () => {
    expect(dedupKey('not-a-url')).toBe('not-a-url')
  })
})
