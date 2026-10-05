import { describe, it, expect } from 'vitest'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setup as publishRunId, teardown as sweepRunDirs } from '../vitest.globalSetup'

// REVIEWER-ADDED on fix-notif-blockers. Closes the class, not the instance.
//
// Nine test files once dropped `${process.env.FLOW_JOB_TEST_RUN_ID ??
// `pid${process.pid}`}` from their STORE_DIR and went back to a fixed
// `/tmp/flow_job-<name>` literal. Nothing failed at review time and nothing
// fails in a single run: the damage is only visible when two `npm test`
// invocations overlap, which is this repo's normal mode -- several review
// worktrees run the suite at the same time. Then two processes share one
// `apply-assistant-data.json` / `apply-assistant-key` pair, `reloadStore`
// reads one and decrypts it with the other, and the loser throws "Cannot
// decrypt data file (... the encryption key may have been regenerated)"
// across every test in its file at once. That reads as a flaky suite rather
// than a config mistake, so it burns hours.
//
// Measured here, at this commit:
//
//   fixed,   2 clones x 2 concurrent runs of moneyleaks.store.test.ts:
//            4/4 files passed, 15/15 each, 0 decrypt errors
//   reverted, the same 4 runs with one literal put back to `/tmp/flow_job-
//            moneyleaks-review`: 4/4 files FAILED (4/6/5/7 failed),
//            10 "Cannot decrypt data file"
//
// Restoring the nine was a nine-line diff. It came back once already, via a
// merge that resolved a conflict by taking an older side of a file, and a
// nine-line diff that a merge can silently undo is not a fix. So the invariant
// is pinned in the tree instead: no test in this repo may name a store
// directory that is not run-id-scoped, and the sweep below is what notices.
//
// Source-scanning rather than behavioural because the failure has no
// behavioural form at one run. There is nothing to assert about a single
// process's store path except that it is the wrong one.

const REPO = join(__dirname, '..')
const RUN_ID = 'FLOW_JOB_TEST_RUN_ID'
const ROOT_SETUP_FILES = ['vitest.setup.ts', 'vitest.globalSetup.ts']

// Assembled rather than written out, so this file -- which is itself a test
// file in the scan, and which has to name the path it is looking for -- holds
// no literal that the scan below would report. Excluding it instead would
// leave one file with a standing exemption, and the next person to widen the
// scan would not know it was there.
const STORE_PATH_PREFIX = ['/tmp/', 'flow_job'].join('')
const SWEEPED_PREFIX = `${STORE_PATH_PREFIX}-test-`

/** Every file that can name a test store directory. */
function scopedFiles(): string[] {
  const acc: string[] = []
  for (const dir of ['electron', 'src']) {
    walk(join(REPO, dir), acc)
  }
  for (const f of ROOT_SETUP_FILES) acc.push(join(REPO, f))
  return acc
}

function walk(dir: string, acc: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, acc)
    else if (/\.test\.tsx?$/.test(entry.name)) acc.push(full)
  }
}

/**
 * The file with comments blanked out, comments-only text replaced by spaces
 * so offsets survive.
 *
 * Comments are the reason this needs doing at all: `vitest.setup.ts` and
 * `vitest.globalSetup.ts` both narrate the fixed paths they no longer use
 * (`/tmp/flow_job-test`, `/tmp/flow_job-test-...`), and a scanner that read
 * its own documentation would demand a run id from a sentence explaining why
 * one is not needed.
 */
function codeOnly(src: string): string {
  const noBlock = src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/.*$/gm, (m) => ' '.repeat(m.length))
  return noBlock
}

interface StoreLiteral {
  file: string
  line: number
  /** The path expression, from `/tmp` to the end of its line. */
  text: string
}

/** Every `/tmp/flow_job...` path expression in code, comments excluded. */
function storeLiterals(): StoreLiteral[] {
  const found: StoreLiteral[] = []
  for (const file of scopedFiles()) {
    const src = codeOnly(readFileSync(file, 'utf-8'))
    const lines = src.split('\n')
    lines.forEach((line, i) => {
      const at = line.indexOf(STORE_PATH_PREFIX)
      if (at === -1) return
      found.push({ file, line: i + 1, text: line.slice(at).trim() })
    })
  }
  return found
}

/**
 * Identifiers this literal interpolates, by bare name: `${TEST_RUN}` yields
 * `TEST_RUN` and `${process.env.X}` yields nothing.
 */
function interpolatedNames(text: string): string[] {
  return [...text.matchAll(/\$\{\s*([A-Za-z_$][\w$]*)\s*\}/g)].map((m) => m[1])
}

/** Whether `name` is bound in `src` to something derived from the run id. */
function derivedFromRunId(src: string, name: string): boolean {
  return new RegExp(`\\b${name}\\b[^=\\n]*=[^\\n]*${RUN_ID}`).test(src)
}

describe('every test store directory is scoped to the run, not to the machine', () => {
  const literals = storeLiterals()

  it('finds the store paths there are to check', () => {
    // A floor, not a count. The scan reads sources, so anything that moves
    // the paths out from under it -- a rename of `/tmp`, a switch to
    // `os.tmpdir()`, an `mkdtemp` helper -- would otherwise turn this file
    // into a suite that passes by finding nothing. Below this many, the
    // invariant is unverified rather than upheld.
    expect(literals.length).toBeGreaterThanOrEqual(25)
  })

  it('scopes each one to this run', () => {
    const offenders: string[] = []
    for (const lit of literals) {
      const src = readFileSync(lit.file, 'utf-8')
      const named = interpolatedNames(lit.text)
      const scoped =
        lit.text.includes(RUN_ID) ||
        (named.length > 0 && named.every((n) => derivedFromRunId(src, n)))
      if (!scoped) {
        offenders.push(
          `${lit.file}:${lit.line}  ${lit.text}\n` +
            '    a fixed path here is shared by every npm test on the machine, so two ' +
            'concurrent runs race on one apply-assistant-data.json / apply-assistant-key ' +
            'pair and the loser fails every test in the file with "Cannot decrypt data file"'
        )
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([])
  })

  it('keeps each one inside the sweep the teardown performs', () => {
    // `vitest.globalSetup.ts`'s teardown removes entries that both
    // startsWith('flow_job-test') and end with `-<runId>`. Three of the nine
    // that regressed also lost their `flow_job-test-` prefix, so the run id
    // alone would not have saved them: they would have been isolated from
    // each other and still leaked in /tmp forever. The prefix is half the
    // mechanism, not decoration.
    const offenders = literals
      .filter((l) => !l.text.startsWith(SWEEPED_PREFIX))
      .map((l) => `${l.file}:${l.line}  ${l.text}`)
    expect(offenders, offenders.join('\n')).toEqual([])
  })
})

describe('the mechanism those paths depend on', () => {
  it('is wired into the run, so the id in a path is ever set at all', () => {
    const config = readFileSync(join(REPO, 'vitest.config.ts'), 'utf-8')
    expect(codeOnly(config)).toMatch(/globalSetup:\s*\[[^\]]*vitest\.globalSetup/)
  })

  it('publishes an id that cannot collide between two runs, and sweeps exactly it', () => {
    const before = process.env[RUN_ID]
    // Both probes carry the prefix, so both are inside the sweep's scope, and
    // the only thing separating them is the suffix.
    const mine = `${STORE_PATH_PREFIX}-test-runid-guard-published`
    const theirs = `${STORE_PATH_PREFIX}-test-runid-guard-other-run`
    const made: string[] = []
    try {
      publishRunId()
      const id = process.env[RUN_ID]
      expect(id, 'setup() must publish the id for the workers to inherit').toBeTruthy()
      // Pid-derived, so two `npm test` processes started in the same
      // millisecond still get different ids. This is the property the whole
      // scheme rests on and the one a timestamp alone would not give.
      expect(id).toContain(process.pid.toString(36))

      const mineDir = `${mine}-${id}`
      for (const d of [mineDir, theirs]) { mkdirSync(d, { recursive: true }); made.push(d) }
      writeFileSync(join(mineDir, 'apply-assistant-data.json'), '{}')

      sweepRunDirs()

      expect(existsSync(mineDir), 'teardown must remove the directory this run created').toBe(false)
      // And it must remove ONLY that one. A teardown that swept every
      // `flow_job-test*` would delete a concurrent run's store mid-read and
      // cause exactly the failure this file exists to prevent.
      expect(existsSync(theirs), "teardown must not touch another run's directories").toBe(true)
    } finally {
      if (before === undefined) delete process.env[RUN_ID]
      else process.env[RUN_ID] = before
      for (const d of made) rmSync(d, { recursive: true, force: true })
    }
  })

  it('never reads a path that the sweep cannot reach', () => {
    // Guards the two halves against drifting apart in the other direction:
    // a teardown that stopped matching the prefix would orphan directories,
    // and one that stopped matching the suffix would delete other runs'.
    const src = codeOnly(readFileSync(join(REPO, 'vitest.globalSetup.ts'), 'utf-8'))
    expect(src).toMatch(/startsWith\('flow_job-test'\)/)
    expect(src).toMatch(/endsWith\(suffix\)/)
  })
})
