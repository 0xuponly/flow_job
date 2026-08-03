import { describe, it, expect } from 'vitest'

// Regression guard: importing the App module must never throw. The 2026-08-03
// renderer code-splitting crash (React.lazy used without importing React)
// failed exactly here — module evaluation threw ReferenceError and the
// renderer never mounted.
describe('App module', () => {
  it('evaluates without throwing', async () => {
    await expect(import('./App')).resolves.toBeDefined()
  })
})
