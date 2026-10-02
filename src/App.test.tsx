import { describe, it, expect } from 'vitest'

/**
 * Regression guard: importing the App module must never throw. The 2026-08-03
 * renderer code-splitting crash (React.lazy used without importing React)
 * failed exactly here — module evaluation threw ReferenceError and the
 * renderer never mounted.
 *
 * The explicit timeout is not a performance claim, it is a hang detector, and
 * it is here because this test's entire body is a cold import. App.tsx
 * statically pulls in fifteen components (twelve pages, Sidebar,
 * Notifications, ErrorBoundary, NotificationDrawer) and their transitive
 * dependencies, so the cost is vite transforming and evaluating that whole
 * graph before the assertion can run. Measured on this machine:
 *
 *     running this file alone, warm fs cache     1443ms
 *     inside a full suite run                    2718ms
 *     under 8 competing CPU spinners             3099ms
 *
 * Against vitest's 5000ms default that is 3.5x headroom at best and none at
 * all on a busy box: across 30 runs of this file on its own it timed out once,
 * and under 24 spinners it timed out every time. 30s is a wide margin over the
 * worst number above, and it stays a bound -- a module graph that genuinely
 * hangs still fails here rather than hanging the suite.
 *
 * The brief flagged this test as a possible unhandled rejection or a
 * store/DB handle racing a parallel teardown. It is neither: 30 runs produced
 * one timeout and zero unhandled rejections, and App.tsx has no top-level side
 * effects, no lazy imports and no store access. The failure mode is the plain
 * `Test timed out in 5000ms`, nothing else.
 */
const COLD_GRAPH_IMPORT_TIMEOUT_MS = 30_000

describe('App module', () => {
  it('evaluates without throwing', async () => {
    await expect(import('./App')).resolves.toBeDefined()
  }, COLD_GRAPH_IMPORT_TIMEOUT_MS)
})
