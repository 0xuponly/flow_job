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
})
