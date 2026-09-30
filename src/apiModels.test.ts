import { describe, it, expect } from 'vitest'
import { inheritProviderApiKey } from './apiModels'
import type { ApiModelConfig } from './types'

const ZEN = 'https://opencode.ai/zen/v1'
const ROUTER = 'https://openrouter.ai/api/v1'

function model(over: Partial<ApiModelConfig> = {}): ApiModelConfig {
  return {
    id: 'm1',
    name: 'Some Model',
    base_url: ZEN,
    api_key: '',
    model: 'some-model',
    ...over
  }
}

describe('inheritProviderApiKey', () => {
  it('copies the key from an existing model on the same base_url', () => {
    const existing = [model({ api_key: 'sk-zen-secret' })]
    const incoming = model({ id: '', model: 'big-pickle' })
    expect(inheritProviderApiKey(incoming, existing).api_key).toBe('sk-zen-secret')
  })

  it('leaves the key empty when no model shares the base_url', () => {
    const existing = [model({ base_url: ROUTER, api_key: 'sk-or-secret' })]
    const incoming = model({ id: '', model: 'big-pickle' })
    expect(inheritProviderApiKey(incoming, existing).api_key).toBe('')
  })

  it('does not overwrite a key that is already set on the incoming model', () => {
    const existing = [model({ api_key: 'sk-old' })]
    const incoming = model({ id: '', api_key: 'sk-explicit' })
    expect(inheritProviderApiKey(incoming, existing).api_key).toBe('sk-explicit')
  })

  it('matches the same provider despite a trailing slash difference', () => {
    const existing = [model({ base_url: `${ZEN}/`, api_key: 'sk-zen-secret' })]
    const incoming = model({ id: '', base_url: ZEN })
    expect(inheritProviderApiKey(incoming, existing).api_key).toBe('sk-zen-secret')
  })

  it('skips same-provider siblings that have no key yet', () => {
    const existing = [
      model({ id: 'a', api_key: '' }),
      model({ id: 'b', api_key: 'sk-second' })
    ]
    const incoming = model({ id: '' })
    expect(inheritProviderApiKey(incoming, existing).api_key).toBe('sk-second')
  })

  it('returns the key unchanged when every same-provider sibling is keyless', () => {
    const existing = [model({ api_key: '' })]
    const incoming = model({ id: '' })
    expect(inheritProviderApiKey(incoming, existing).api_key).toBe('')
  })

  it('preserves the other fields of the incoming model', () => {
    const existing = [model({ api_key: 'sk-zen-secret' })]
    const incoming = model({ id: '', name: 'Big Pickle', model: 'big-pickle' })
    expect(inheritProviderApiKey(incoming, existing)).toEqual({
      id: '',
      name: 'Big Pickle',
      base_url: ZEN,
      api_key: 'sk-zen-secret',
      model: 'big-pickle'
    })
  })

  describe('tolerates different spellings of the same provider URL', () => {
    it('inherits when the path differs but the host matches', () => {
      const existing = [model({ base_url: 'https://openrouter.ai/api', api_key: 'sk-or-secret' })]
      const incoming = model({ id: '', base_url: ROUTER })
      expect(inheritProviderApiKey(incoming, existing).api_key).toBe('sk-or-secret')
    })

    it('inherits when the existing URL is the one with the longer path', () => {
      const existing = [model({ base_url: ROUTER, api_key: 'sk-or-secret' })]
      const incoming = model({ id: '', base_url: 'https://openrouter.ai/api' })
      expect(inheritProviderApiKey(incoming, existing).api_key).toBe('sk-or-secret')
    })

    it('inherits when the host differs only in case', () => {
      const existing = [model({ base_url: 'https://OpenRouter.ai/api/v1', api_key: 'sk-or-secret' })]
      const incoming = model({ id: '', base_url: ROUTER })
      expect(inheritProviderApiKey(incoming, existing).api_key).toBe('sk-or-secret')
    })

    it('inherits when a default port is written out explicitly', () => {
      const existing = [model({ base_url: 'https://openrouter.ai:443/api/v1', api_key: 'sk-or-secret' })]
      const incoming = model({ id: '', base_url: ROUTER })
      expect(inheritProviderApiKey(incoming, existing).api_key).toBe('sk-or-secret')
    })

    it('does not inherit across different hosts on the same path', () => {
      const existing = [model({ base_url: 'https://evil.example.com/api/v1', api_key: 'sk-other' })]
      const incoming = model({ id: '', base_url: ROUTER })
      expect(inheritProviderApiKey(incoming, existing).api_key).toBe('')
    })

    it('prefers an exact URL match over a looser same-host match', () => {
      const existing = [
        model({ id: 'a', base_url: 'https://openrouter.ai/api', api_key: 'sk-loose' }),
        model({ id: 'b', base_url: ROUTER, api_key: 'sk-exact' })
      ]
      const incoming = model({ id: '', base_url: ROUTER })
      expect(inheritProviderApiKey(incoming, existing).api_key).toBe('sk-exact')
    })
  })

  // A key inherited here is saved without the user typing it, so every
  // case below must leave the incoming key empty. Matching too loosely
  // hands one vendor's key to another vendor's endpoint.
  describe('refuses to inherit across a credential boundary', () => {
    it('does not inherit between two different paths on one host', () => {
      // A shared gateway (LiteLLM et al) fronts several vendors behind one
      // host and issues a SEPARATE key per upstream.
      const existing = [model({ base_url: 'https://gw.corp.example/openai/v1', api_key: 'sk-openai' })]
      const incoming = model({ id: '', base_url: 'https://gw.corp.example/anthropic/v1' })
      expect(inheritProviderApiKey(incoming, existing).api_key).toBe('')
    })

    it('does not inherit onto a bare host from a path on that host', () => {
      // The empty first segment matches only another empty one, or a
      // bare host would donate its key to every path behind it.
      const existing = [model({ base_url: 'https://gw.corp.example', api_key: 'sk-gateway' })]
      const incoming = model({ id: '', base_url: 'https://gw.corp.example/anthropic/v1' })
      expect(inheritProviderApiKey(incoming, existing).api_key).toBe('')
    })

    it('does not inherit when the incoming scheme is a plaintext downgrade', () => {
      // http:// transmits the key in cleartext. Matching across the scheme
      // hands a key destined for TLS to an unencrypted endpoint.
      const existing = [model({ base_url: 'https://api.vendor.test/v1', api_key: 'sk-vendor' })]
      const incoming = model({ id: '', base_url: 'http://api.vendor.test/v1' })
      expect(inheritProviderApiKey(incoming, existing).api_key).toBe('')
    })

    it('does not inherit when the port differs', () => {
      // A different port is a different service on the same host.
      const existing = [model({ base_url: 'https://gw.corp.example:8443/v1', api_key: 'sk-8443' })]
      const incoming = model({ id: '', base_url: 'https://gw.corp.example:9443/v1' })
      expect(inheritProviderApiKey(incoming, existing).api_key).toBe('')
    })

    it('does not inherit across a host-prefix collision', () => {
      const existing = [model({ base_url: 'https://api.example.com/v1', api_key: 'sk-api' })]
      const incoming = model({ id: '', base_url: 'https://api.example.com.attacker.test/v1' })
      expect(inheritProviderApiKey(incoming, existing).api_key).toBe('')
    })

    it('does not inherit onto a subdomain of the keyed host', () => {
      const existing = [model({ base_url: ROUTER, api_key: 'sk-or-secret' })]
      const incoming = model({ id: '', base_url: 'https://evil-openrouter.ai/api/v1' })
      expect(inheritProviderApiKey(incoming, existing).api_key).toBe('')
    })
  })
})
