import '@testing-library/jest-dom/vitest';
// @ts-expect-error jsdom 29 ships no type declarations; this setup file is a runtime shim
import { JSDOM } from 'jsdom';
import { vi } from 'vitest'

// Vitest 4's jsdom env doesn't proxy `localStorage` onto the global (its
// built-in key list predates the change and `Object.getOwnPropertyNames` on
// the jsdom window still surfaces the empty descriptor). Install a working
// `localStorage` from a fresh JSDOM if the global one isn't a real Storage.
if (typeof (globalThis as { localStorage?: Storage }).localStorage?.clear !== 'function') {
  const { localStorage } = new JSDOM('<!doctype html>', { url: 'http://localhost:3000' }).window;
  Object.defineProperty(globalThis, 'localStorage', { value: localStorage, configurable: true, writable: true });
}

/**
 * Identifies this `npm test` invocation. Set by vitest.globalSetup.ts in the
 * main process and inherited by the workers; the pid fallback only applies if
 * a worker somehow runs without it.
 */
const TEST_RUN = process.env.FLOW_JOB_TEST_RUN_ID ?? `pid${process.pid}`;

// Stub the parts of the electron module that jobSearch.ts (and any other
// main-process modules it transitively pulls in) reach for at import time.
// Without this, importing jobSearch.ts from a test fails on
// `app.getPath('userData')` in electron/logger.ts because no Electron
// runtime is available in the jsdom env. Only the surface used by the
// import chain is stubbed; behavior tests still exercise the real code.
//
// The store directory carries TEST_RUN. It used to be the bare
// `/tmp/flow_job-test`, which every test process on the machine shared -- so
// two concurrent `npm test` runs (two worktrees, two CI jobs, or one run
// started while another is still going) raced on the same
// `apply-assistant-data.json` and `apply-assistant-key`. `reloadStore` reads
// the data file and decrypts it with the key file; when one process wipes or
// regenerates the pair mid-read, the other throws `Cannot decrypt data file
// (... the encryption key may have been regenerated)`, which takes down every
// test in the file at once rather than one. Three concurrent runs reproduced
// 44 failures across 9 files, 26 of them that error.
//
// Test files that want their own store under a different name build it the
// same way -- see electron/docsAutoQueue.store.test.ts. Cleanup happens in
// vitest.globalSetup.ts's teardown, which is the only place that reliably runs
// once per run: vitest kills worker processes abruptly, so neither an
// `afterAll` in a setup file nor `process.on('exit')` fires in a worker.
const STORE_DIR = `/tmp/flow_job-test-${TEST_RUN}`;

vi.mock('electron', () => ({
  app: {
    getPath: (_key: string) => STORE_DIR,
    getName: () => 'flow_job',
    getVersion: () => '0.0.0-test',
    on: () => undefined,
    whenReady: () => Promise.resolve(),
    isReady: () => true,
  },
  ipcMain: { handle: () => undefined, on: () => undefined },
  BrowserWindow: class {},
  session: { defaultSession: { webRequest: { onBeforeRequest: () => undefined } } },
}))
