import { defineConfig } from 'vitest/config'
import { availableParallelism } from 'node:os'
import path from 'node:path'

/**
 * Worker count.
 *
 * Vitest defaults to `max(cpus - 1, 1)`, i.e. one worker per core. On this
 * suite that oversubscribes, because the workers are not all doing CPU work
 * at the same moment and some of them reach for the OS: the jsdom
 * environment, the esbuild/vite transform pipeline, and the ONNX runtime's
 * own native thread pool in semanticSkillMatcher.test.ts.
 *
 * Measured on this machine (8 cores, `npm test`, 3 runs per setting):
 *
 *     maxWorkers=7 (the default)  13.2s / 13.7s / 16.9s   1 run failed
 *     maxWorkers=4                15.1s / 15.3s / 15.5s   0 runs failed
 *     maxWorkers=2                24.1s / 24.0s / 24.2s   0 runs failed
 *
 * Halving the workers costs ~1.5s (about 11%) and buys back the headroom
 * that the starvation-sensitive assertions need. Halving again costs another
 * 9s, which is not a trade worth making: the point is to stop oversubscribing,
 * not to serialise the suite. `maxWorkers=2` is the floor of what is still
 * worth having -- the suite is 69 files and one worker leaves most of the
 * machine idle during the ~20s transform phase.
 *
 * Scaled off the machine rather than hardcoded so a 4-core CI box gets 2 and a
 * 2-core box gets 1.
 */
const MAX_WORKERS = Math.max(1, Math.floor(availableParallelism() / 2))

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    // Gives every run its own store directories and cleans them up after.
    // See vitest.globalSetup.ts for why the paths cannot be fixed literals.
    globalSetup: ['./vitest.globalSetup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}', 'electron/**/*.{test,spec}.{ts,tsx}'],

    maxWorkers: MAX_WORKERS,

    /**
     * Left at vitest's 5000ms default on purpose, and stated explicitly so
     * the choice is visible rather than accidental.
     *
     * This suite has tests whose honest cost is several seconds of cold start
     * (App.tsx pulls in the whole renderer graph; the matcher pays an ONNX
     * runtime init). Raising the global default to make those fit would blunt
     * hang detection for all 1553 tests to accommodate a handful, so those
     * tests carry their own explicit, commented timeout instead and the
     * global stays tight.
     */
    testTimeout: 5_000,

    /**
     * Vitest's 10s default, stated explicitly rather than left to chance.
     *
     * This was 60s, to cover the one-time ONNX warm-up in
     * semanticSkillMatcher.test.ts (2.5-2.9s for the first real inference under
     * CPU load, 0-4ms for every one after it). That hook already carries its own
     * explicit `WARM_UP_TIMEOUT_MS`, which is the mechanism that is actually
     * sized to it -- `src/semanticSkillMatcher.test.ts`. With this deleted
     * outright, the matcher file passed 11/11 under 24 competing spinners.
     *
     * What 60s bought instead was 10s -> 60s of hang detection for every
     * `beforeAll`/`afterAll` in all 76 files. There are three hooks in the suite
     * and the other two are a ResizeObserver stub and an `rmSync`: a hook
     * deadlocked for 59s passed. A probe file whose `beforeAll` sleeps 15s now
     * fails with `Hook timed out in 10000ms` after 10.0s of test time, where it
     * passed at 15s before.
     */
    hookTimeout: 10_000,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
