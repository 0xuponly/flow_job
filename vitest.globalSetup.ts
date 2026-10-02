import { readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Where the test store directories live.
 *
 * `/tmp`, deliberately and not `os.tmpdir()`: the store paths are hardcoded
 * `/tmp/flow_job-test-...` literals in the test files, and on macOS
 * `os.tmpdir()` is a per-user directory under `/var/folders/...`, so sweeping
 * that one silently matched nothing. (It did, for a while -- the first version
 * of this cleanup ran against `os.tmpdir()` and never removed a thing.)
 */
const STORE_ROOT = '/tmp'

/**
 * One id per `npm test` invocation, shared by every worker in that run.
 *
 * Test store directories used to be fixed absolute paths (`/tmp/flow_job-test`,
 * `/tmp/flow_job-test-docsweep`, ...), so every test process on the machine
 * shared them. Two concurrent runs -- two worktrees, two CI jobs, or a second
 * run started while the first is still going -- raced on the same
 * `apply-assistant-data.json` and `apply-assistant-key` pair, and
 * `reloadStore` reads one and decrypts with the other. When a process wiped or
 * regenerated the pair mid-read, the loser threw `Cannot decrypt data file
 * (... the encryption key may have been regenerated)` and took down every test
 * in its file at once. Three concurrent runs reproduced 44 failures across 9
 * files, 26 of them that error.
 *
 * Putting this run's id in the path means concurrent runs cannot collide, and
 * it also gives `teardown` below an exact suffix to match, so cleanup can only
 * ever remove directories this run created.
 *
 * It is a run id rather than a pid because a pid does not survive to clean up:
 * vitest terminates worker processes abruptly, so `process.on('exit')` and
 * `afterAll` in a setup file both never fire (verified with probes). The main
 * process does get a clean `teardown`, and it is the only place that runs once
 * per run.
 */

let runId = ''

export function setup(): void {
  runId = `${Date.now().toString(36)}${process.pid.toString(36)}`
  // Workers inherit the main process's env, which is how this reaches them.
  process.env.FLOW_JOB_TEST_RUN_ID = runId
}

export function teardown(): void {
  if (!runId) return
  const suffix = `-${runId}`
  try {
    for (const entry of readdirSync(STORE_ROOT)) {
      if (!entry.startsWith('flow_job-test') || !entry.endsWith(suffix)) continue;
      rmSync(join(STORE_ROOT, entry), { recursive: true, force: true });
    }
  } catch {
    // Best effort: never turn a green run red because /tmp could not be swept.
  }
}
