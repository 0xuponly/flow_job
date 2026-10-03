import { describe, it, expect, beforeEach, vi } from 'vitest'

// The queue's spend bound has been asserted on the WRONG INSTRUMENT.
//
// Every existing bound test counts `attempts` — a value the queue increments
// itself. A reviewer proved that this counter can be made to disagree with
// reality: mutating `recordModelFailure` so it computes the 429 backoff and
// discards it doubles REAL provider spend while every one of those tests still
// passes. A bound that cannot fail when spend doubles is not a bound.
//
// These cases measure the thing that costs money: how many times the provider
// is actually called. That is the instrument a user pays for.

describe('the spend bound, measured in provider calls rather than a self-reported counter', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('a rotation over N rate-limited models issues at most N provider calls per pass', async () => {
    const fetchMock = vi.fn()
    let calls = 0
    fetchMock.mockImplementation(() => {
      calls++
      return Promise.resolve({
        ok: false,
        status: 429,
        headers: new Map(),
        text: () => Promise.resolve('rate limited')
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const { callAI } = await import('./ai')
    const { addApiModel } = await import('./database')
    for (let i = 0; i < 4; i++) {
      addApiModel({
        name: `m${i}`,
        base_url: 'https://example.invalid',
        api_key: 'k',
        model: `model-${i}`,
        enabled: true
      } as never)
    }

    await expect(callAI('sys', 'user')).rejects.toThrow()

    // One call per enabled model for this pass — not more, because a
    // rate-limited model must not be re-walked inside the same rotation.
    expect(calls).toBeLessThanOrEqual(4)
    expect(calls).toBeGreaterThan(0)
  })

  it('a second pass makes no provider calls at all while every model is cooling down', async () => {
    const fetchMock = vi.fn()
    let calls = 0
    fetchMock.mockImplementation(() => {
      calls++
      return Promise.resolve({
        ok: false,
        status: 429,
        headers: new Map(),
        text: () => Promise.resolve('rate limited')
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const { callAI, resetModelHealth } = await import('./ai')
    const { addApiModel } = await import('./database')
    for (let i = 0; i < 3; i++) {
      addApiModel({
        name: `m${i}`,
        base_url: 'https://example.invalid',
        api_key: 'k',
        model: `model-${i}`,
        enabled: true
      } as never)
    }

    await expect(callAI('sys', 'user')).rejects.toThrow()
    const afterFirst = calls
    expect(afterFirst).toBeGreaterThan(0)

    // The 429 backoff is 15s on the first failure, so an immediate second
    // pass must find nothing eligible and must spend nothing.
    await expect(callAI('sys', 'user')).rejects.toThrow()

    expect(calls).toBe(afterFirst)

    resetModelHealth()
  })

  it('a circuit-broken model is not called again within the hour', async () => {
    const fetchMock = vi.fn()
    let calls = 0
    fetchMock.mockImplementation(() => {
      calls++
      return Promise.resolve({
        ok: false,
        status: 402,
        headers: new Map(),
        text: () => Promise.resolve('payment required')
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const { callAI, resetModelHealth } = await import('./ai')
    const { addApiModel } = await import('./database')
    addApiModel({
      name: 'dead',
      base_url: 'https://example.invalid',
      api_key: 'k',
      model: 'dead-model',
      enabled: true
    } as never)

    await expect(callAI('sys', 'user')).rejects.toThrow()
    const afterFirst = calls

    await expect(callAI('sys', 'user')).rejects.toThrow()
    expect(calls).toBe(afterFirst)

    resetModelHealth()
  })
})
