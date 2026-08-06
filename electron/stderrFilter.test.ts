// electron/stderrFilter.test.ts
import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createStderrFilter } from './stderrFilter'

const IPC_BLOCK =
  "Error occurred in handler for 'jobs:create': Error: Job already exists: Acme — Engineer\n" +
  '    at /path/to/main.ts:308:16\n' +
  '    at WebContents.<anonymous> (node:electron/js2c/browser_init:2:87444)\n'

describe('createStderrFilter', () => {
  const logDir = mkdtempSync(join(tmpdir(), 'stderr-filter-test-'))

  afterAll(() => {
    rmSync(logDir, { recursive: true, force: true })
  })

  it('captures an IPC handler rejection dump to ipc.log', () => {
    const { handle } = createStderrFilter({ logDir })
    expect(handle(IPC_BLOCK)).toBe(true)
    const log = readFileSync(join(logDir, 'ipc.log'), 'utf-8')
    expect(log).toContain("Error occurred in handler for 'jobs:create'")
    expect(log).toContain('at /path/to/main.ts:308:16')
  })

  it('captures known-harmless Chromium noise to stderr.log', () => {
    const { handle } = createStderrFilter({ logDir })
    expect(handle('Hit debug scenario: 4\n')).toBe(true)
    const log = readFileSync(join(logDir, 'stderr.log'), 'utf-8')
    expect(log).toContain('Hit debug scenario: 4')
  })

  it('passes unknown stderr lines through', () => {
    const { handle } = createStderrFilter({ logDir })
    expect(handle('Error: something real happened\n')).toBe(false)
  })

  it('passes everything through when verbose', () => {
    const { handle } = createStderrFilter({ logDir, verbose: true })
    expect(handle(IPC_BLOCK)).toBe(false)
    expect(handle('Hit debug scenario: 4\n')).toBe(false)
  })
})
