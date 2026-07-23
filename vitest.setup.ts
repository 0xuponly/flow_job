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

// Stub the parts of the electron module that jobSearch.ts (and any other
// main-process modules it transitively pulls in) reach for at import time.
// Without this, importing jobSearch.ts from a test fails on
// `app.getPath('userData')` in electron/logger.ts because no Electron
// runtime is available in the jsdom env. Only the surface used by the
// import chain is stubbed; behavior tests still exercise the real code.
vi.mock('electron', () => ({
  app: {
    getPath: (_key: string) => '/tmp/flow_job-test',
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
