import '@testing-library/jest-dom/vitest';
import { vi } from 'vitest'

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
    on: () => {},
    whenReady: () => Promise.resolve(),
    isReady: () => true,
  },
  ipcMain: { handle: () => {}, on: () => {} },
  BrowserWindow: class {},
  session: { defaultSession: { webRequest: { onBeforeRequest: () => {} } } },
}))
