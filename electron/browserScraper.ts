import { BrowserWindow, session, app } from 'electron'
import { createLogger } from './logger'
import path from 'path'
import fs from 'fs'

const log = createLogger('browser')

const LOAD_TIMEOUT_MS = 180000
const CHALLENGE_WAIT_MS = 10000
const USER_AGENTS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
]

// Randomised viewport dimensions for BrowserWindow. Using a fixed
// default size is a detectable fingerprint — real users have varied
// screen sizes. Pick one from the distribution per session.
const VIEWPORT_PRESETS = [
  { width: 1920, height: 1080 },
  { width: 1440, height: 900 },
  { width: 1366, height: 768 },
  { width: 1536, height: 864 },
  { width: 1280, height: 800 },
  { width: 2560, height: 1440 },
  { width: 1680, height: 1050 }
]

function randomViewport(): { width: number; height: number } {
  return VIEWPORT_PRESETS[Math.floor(Math.random() * VIEWPORT_PRESETS.length)]
}

// Stealth script: patches navigator to hide headless/automation signals.
// Runs in the page's main world before any site scripts execute.
//
// Ported from puppeteer-extra-plugin-stealth's 13 evasion modules:
//   navigator.webdriver, chrome.app, chrome.csi, chrome.loadTimes,
//   chrome.runtime, media.codecs, navigator.hardwareConcurrency,
//   navigator.languages, navigator.permissions, navigator.plugins,
//   navigator.platform, navigator.vendor, navigator.connection,
//   webgl.vendor, window.outerdimensions, hairline, iframe.contentWindow.
// ─── Fingerprint randomization pools ──────────────────────────
// Realistic-but-varied values per session so every request doesn't
// share identical navigator / WebGL signals.

const HARDWARE_CONCURRENCY_VALUES = [4, 8, 12, 16]
const DEVICE_MEMORY_VALUES = [4, 8]
const WEBGL_VENDORS = ['Intel Inc.', 'Google Inc. (Intel)', 'Apple Inc.', 'NVIDIA Corporation']
const WEBGL_RENDERERS = [
  'Intel Iris OpenGL Engine',
  'Intel(R) UHD Graphics 630',
  'Apple M1',
  'Apple M2',
  'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0)',
  'ANGLE (Apple, Apple M1 Pro Direct3D11 vs_5_0 ps_5_0)'
]
const CONNECTION_RTT_VALUES = [50, 75, 100, 150, 200]

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]
}

function buildStealthScript(): string {
  const hardwareConcurrency = pick(HARDWARE_CONCURRENCY_VALUES)
  const deviceMemory = pick(DEVICE_MEMORY_VALUES)
  const webglVendor = pick(WEBGL_VENDORS)
  const webglRenderer = pick(WEBGL_RENDERERS)
  const rtt = pick(CONNECTION_RTT_VALUES)

  return `
(() => {
  try {
    const ua = navigator.userAgent

    // ─── navigator.webdriver ────────────────────────────────────
    Object.defineProperty(navigator, 'webdriver', { get: () => false, configurable: true })

    // ─── navigator.plugins (3 default Chrome plugins) ──────────
    Object.defineProperty(navigator, 'plugins', {
      get: () => {
        const arr = [
          { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
          { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
          { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' }
        ]
        arr.item = (i) => arr[i]
        arr.namedItem = (n) => arr.find((p) => p.name === n) || null
        arr.length = 3
        return arr
      },
      configurable: true
    })

    // ─── navigator.languages ────────────────────────────────────
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'], configurable: true })

    // ─── navigator.vendor (Chrome = "Google Inc.") ─────────────
    Object.defineProperty(navigator, 'vendor', { get: () => 'Google Inc.', configurable: true })

    // ─── navigator.platform (matching UA) ──────────────────────
    let platform = 'Win32'
    if (ua.includes('Mac')) platform = 'MacIntel'
    else if (ua.includes('Linux')) platform = 'Linux x86_64'
    Object.defineProperty(navigator, 'platform', { get: () => platform, configurable: true })

    // ─── navigator.hardwareConcurrency / deviceMemory ──────────
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => ${hardwareConcurrency}, configurable: true })
    Object.defineProperty(navigator, 'deviceMemory', { get: () => ${deviceMemory}, configurable: true })

    // ─── navigator.connection (NetworkInformation API) ─────────
    if (navigator.connection) {
      try {
        Object.defineProperty(navigator.connection, 'rtt', { get: () => ${rtt}, configurable: true })
      } catch {}
    }

    // ─── navigator.permissions (notifications → denied) ────────
    if (navigator.permissions && navigator.permissions.query) {
      const origQuery = navigator.permissions.query.bind(navigator.permissions)
      navigator.permissions.query = (params) =>
        origQuery(params).then((res) => {
          if (params.name === 'notifications') Object.defineProperty(res, 'state', { get: () => 'denied' })
          return res
        })
    }

    // ─── WebGL vendor/renderer (avoid SwiftShader) ─────────────
    try {
      const origGetParam = WebGLRenderingContext.prototype.getParameter
      WebGLRenderingContext.prototype.getParameter = function (p) {
        if (p === 37445) return '${webglVendor}'
        if (p === 37446) return '${webglRenderer}'
        return origGetParam.call(this, p)
      }
    } catch {}

    // ─── MediaDevices.enumerateDevices (avoid empty list) ──────
    if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
      const origEnum = navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices)
      navigator.mediaDevices.enumerateDevices = async () => {
        const devices = await origEnum()
        if (devices.length === 0) {
          return [
            { deviceId: 'default', kind: 'audiooutput', label: '', groupId: 'default' }
          ]
        }
        return devices
      }
    }

    // ─── window.outerDimensions ────────────────────────────────
    if (window.outerWidth === 0) {
      try {
        Object.defineProperty(window, 'outerWidth', { get: () => window.innerWidth, configurable: true })
        Object.defineProperty(window, 'outerHeight', { get: () => window.innerHeight + 85, configurable: true })
      } catch {}
    }

    // ─── Chrome app / csi / loadTimes / runtime ────────────────
    if (!window.chrome) {
      window.chrome = {}
    }
    if (!window.chrome.app) {
      window.chrome.app = {
        isInstalled: false,
        InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
        RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' }
      }
    }
    if (!window.chrome.csi || typeof window.chrome.csi !== 'function') {
      window.chrome.csi = () => ({
        onloadT: Date.now(),
        pageT: Math.floor(Math.random() * 5000) + 1000,
        startE: Date.now() - Math.floor(Math.random() * 10000),
        onload: Date.now(),
        tran: Math.floor(Math.random() * 20)
      })
    }
    if (!window.chrome.loadTimes || typeof window.chrome.loadTimes !== 'function') {
      window.chrome.loadTimes = () => {
        const now = Date.now() / 1000
        return {
          commitLoadTime: now - 0.1,
          connectionInfo: 'http/1.1',
          finishDocumentLoadTime: now,
          finishLoadTime: now + 0.05,
          firstPaintAfterLoadTime: 0,
          firstPaintTime: now + 0.01,
          navigationType: 'Other',
          npnNegotiatedProtocol: 'unknown',
          requestTime: now - 0.2,
          startLoadTime: now - 0.15,
          wasAlternateProtocolAvailable: false,
          wasFetchedViaSpdy: false,
          wasNpnNegotiated: false
        }
      }
    }
    if (!window.chrome.runtime) {
      window.chrome.runtime = {
        onInstalled: { addListener: () => {}, removeListener: () => {} },
        onMessage: { addListener: () => {}, removeListener: () => {} },
        onConnect: { addListener: () => {}, removeListener: () => {} },
        sendMessage: () => {},
        connect: () => ({
          onMessage: { addListener: () => {}, removeListener: () => {} },
          onDisconnect: { addListener: () => {}, removeListener: () => {} },
          postMessage: () => {},
          disconnect: () => {}
        })
      }
    }

    // ─── hairline detection (border-image: none check) ─────────
    try {
      const origGetProperty = CSSStyleDeclaration.prototype.getPropertyValue
      CSSStyleDeclaration.prototype.getPropertyValue = function (prop) {
        const val = origGetProperty.call(this, prop)
        if (prop === 'border-image' && val === 'none') {
          return 'url("data:image/svg+xml,...") 30 stretch'
        }
        return val
      }
    } catch {}

    // ─── Notification permission default ───────────────────────
    if (window.Notification && Notification.permission === 'default') {
      try { Object.defineProperty(Notification, 'permission', { get: () => 'denied', configurable: true }) } catch {}
    }

    // ─── iframe.contentWindow spoofing ─────────────────────────
    try {
      const origContentWindow = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentWindow')
      if (origContentWindow && origContentWindow.get) {
        Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', {
          get: function () {
            const win = origContentWindow.get.call(this)
            if (win) {
              try {
                if (!win.document.write.__patched) {
                  const origWrite = win.document.write.bind(win.document)
                  win.document.write = (...args) => {
                    try { origWrite(...args) } catch {}
                  }
                  win.document.write.__patched = true
                }
              } catch {}
            }
            return win
          },
          configurable: true
        })
      }
    } catch {}
  } catch {}
})();
`}

// Returns a promise that resolves true as soon as the signal aborts.
// Used to race long setTimeout waits so the cancel button feels
// immediate rather than waiting for the full CHALLENGE_WAIT_MS / 1.5s.
function abortPromise(signal?: AbortSignal): Promise<true> {
  if (!signal) return new Promise(() => {}) // never resolves
  if (signal.aborted) return Promise.resolve(true)
  return new Promise((resolve) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort)
      resolve(true)
    }
    signal.addEventListener('abort', onAbort)
  })
}

// ─── Camoufox-powered fetch (Firefox anti-fingerprinting) ─────
// Uses camoufox-js which wraps a patched Firefox binary with
// sophisticated anti-fingerprinting. No Chrome/Google dependency.
// Falls back to BrowserWindow when camoufox isn't available.
//
// The Camoufox browser is kept as a module-level singleton because
// it uses a persistent Firefox profile (data_dir) — Firefox locks
// the profile, so only one process can use it at a time. Scanning
// runs boards in parallel (Promise.allSettled), so without a
// singleton every board would try to launch its own Camoufox and
// crash with "A copy of Camoufox is already open".

let camoufoxBrowser: any = null
let camoufoxInit: Promise<any> | null = null

async function initCamoufox(proxyConfig?: { server: string; username?: string; password?: string }): Promise<any> {
  if (camoufoxBrowser) return camoufoxBrowser
  if (camoufoxInit) return camoufoxInit

  // Dynamic require so the import only fails at runtime (not compile time)
  // when camoufox isn't installed.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Camoufox } = require('camoufox')

  const vp = randomViewport()
  const systemLocale = Intl.NumberFormat().resolvedOptions().locale || 'en-US'
  const systemTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York'
  const profileDir = path.join(app.getPath('userData'), 'camoufox-profile')

  // Clean any stale Firefox lock files from a previous app session.
  // Firebase uses parent.lock (and .parentlock on some platforms) to
  // prevent multiple processes from using the same profile. If the
  // app was force-quit or crashed, the lock file survives and blocks
  // the next launch with "A copy of Camoufox is already open".
  const lockFiles = ['parent.lock', '.parentlock']
  for (const f of lockFiles) {
    try { fs.unlinkSync(path.join(profileDir, f)) } catch { /* file doesn't exist — nothing to clean */ }
  }

  // Workaround: the Camoufox binary looks for properties.json in the
  // MacOS/ directory of the app bundle, but the file may only exist in
  // Resources/. Copy it if missing. See team memory for root cause.
  try {
    const camoufoxAppDir = path.dirname(require.resolve('camoufox/package.json'))
    const macosDir = path.join(camoufoxAppDir, 'Camoufox.app', 'Contents', 'MacOS')
    const resourcesDir = path.join(camoufoxAppDir, 'Camoufox.app', 'Contents', 'Resources')
    const macosProps = path.join(macosDir, 'properties.json')
    const resourcesProps = path.join(resourcesDir, 'properties.json')
    if (!fs.existsSync(macosProps) && fs.existsSync(resourcesProps)) {
      fs.copyFileSync(resourcesProps, macosProps)
    }
  } catch { /* non-critical — Camoufox will fall back gracefully */ }

  // Proxy on the singleton: the first call's proxy config is used for
  // the browser lifetime. Call closeCamoufox() and re-init to change.
  camoufoxInit = Camoufox({
    headless: true,
    geoip: false,
    data_dir: profileDir,
    humanize: true,
    // Disable Playwright's default viewport (1280x720 with isMobile)
    // because the Camoufox binary rejects the isMobile property in
    // Browser.setDefaultViewport during launchPersistentContext.
    viewport: null,
    // Set realistic screen dimensions
    screen: { min_width: vp.width, max_width: vp.width, min_height: vp.height, max_height: vp.height },
    // Runtime locale/timezone — Cloudflare checks locale-vs-IP-geo
    // consistency; the real browser already sends these, so matching
    // them here doesn't leak anything detectable.
    locale: systemLocale,
    timezone: systemTimezone,
    // Block WebRTC only when a proxy is configured — without one,
    // Camoufox already normalizes WebRTC so blocking is a detectable
    // anti-fingerprinting signal that real browsers don't emit.
    ...(proxyConfig ? { block_webrtc: true } : {}),
    // Proxy configuration when provided
    ...(proxyConfig ? { proxy: proxyConfig } : {})
  }).then((browser: any) => {
    camoufoxBrowser = browser
    patchCamoufoxIsMobile(browser)
    camoufoxInit = null // release promise ref
    return browser
  }, (err: any) => {
    // DO NOT set camoufoxInit = null here. When launchPersistentContext
    // fails partway through, the Camoufox process may still be running
    // and holding the profile lock. Clearing the promise lets a retry
    // re-launch, which hits "A copy of Camoufox is already open" because
    // the original process is still alive. The caller can explicitly
    // closeCamoufox() then retry if they want a clean restart.
    throw err
  })

  return camoufoxInit
}

/** Close the shared Camoufox browser. Call when scans are done
 *  or when the app is quitting. The browser is auto-recreated
 *  on the next fetchHtmlViaCamoufox() call. */
export async function closeCamoufox(): Promise<void> {
  if (camoufoxBrowser) {
    const b = camoufoxBrowser
    camoufoxBrowser = null
    camoufoxInit = null
    await b.close().catch(() => {})
  }
}

// The camoufox-patched Firefox binary doesn't support isMobile in
// its CDP viewport schema. Playwright's Firefox adapter always
// includes isMobile in Browser.setDefaultViewport (sent during
// context initialization) and Page.setViewportSize (sent during
// page initialization). Strip it so browser.newPage() doesn't
// throw:
//   Protocol error (Browser.setDefaultViewport): Found property
//   "<root>.viewport.isMobile" which is not described in this scheme
// The browser returned by Camoufox() is a client-side Playwright
// API object — a Browser2 object when no data_dir is set, or a
// BrowserContext2 object when data_dir IS set (launchPersistentContext).
// The root CDP session lives on different internals depending on
// which shape was returned:
//   - Browser2: has _connection; toImpl returns FFBrowser with .session
//   - BrowserContext2: has _browser (the parent Browser2) which holds
//     the session. toImpl returns FF{Browser}Context which may not
//     have session directly, so we fall back to fb._browser.session.
// Regardless of shape, the FFConnection is always reachable via
// fb._connection (both ChannelOwner subtypes inherit it).
function patchCamoufoxIsMobile(browser: any): void {
  const fb = browser as any

  // BrowserContext (data_dir mode) wraps a Browser via _browser.
  // Browser (no data_dir) IS the browser directly. Handle both shapes.
  const isContext = !!(fb._browser && typeof fb._browser === 'object' && fb._browser._connection)
  const rootBrowser = isContext ? fb._browser : fb

  // Access the root CDP session. For Browser it's on toImpl(browser).session;
  // for BrowserContext the internal path is fb._browser.session.
  const rootSession = (() => {
    const connection = rootBrowser._connection
    if (!connection) return undefined
    // Try toImpl for Browser shape
    const impl = connection.toImpl?.(rootBrowser)
    if (impl?.session) return impl.session
    // Fallback: direct session property on the root browser object
    return rootBrowser.session
  })()

  if (!rootSession) {
    log.warn('camoufox: cannot access internal CDP session, skipping isMobile patch')
    return
  }

  const origRootSend = rootSession.send.bind(rootSession)
  rootSession.send = (method: string, params?: any) => {
    if (method === 'Browser.setDefaultViewport' && params?.viewport?.isMobile !== undefined) {
      params = { ...params, viewport: { ...params.viewport } }
      delete params.viewport.isMobile
    }
    return origRootSend(method, params)
  }

  // Page sessions are created lazily via _connection.createSession
  // on the FFConnection. Patch it so every new page session also
  // strips isMobile from Page.setViewportSize.
  // For Browser:        rootBrowser._connection (FFConnection directly)
  // For BrowserContext: rootBrowser._connection (FFConnection, same one)
  const ffConnection = rootBrowser._connection
  if (ffConnection?.createSession) {
    const origCreateSession = ffConnection.createSession.bind(ffConnection)
    ffConnection.createSession = (sessionId: string) => {
      const session = origCreateSession(sessionId)
      const origPageSend = session.send.bind(session)
      session.send = (method: string, params?: any) => {
        if (method === 'Page.setViewportSize') {
          params = { ...params }
          // Camoufox binary doesn't support isMobile or
          // screenSize in Page.setViewportSize — Playwright's
          // Firefox adapter always sends these for desktop.
          if ('isMobile' in params) delete params.isMobile
          if ('screenSize' in params) delete params.screenSize
        }
        return origPageSend(method, params)
      }
      return session
    }
  }
}

async function fetchHtmlViaCamoufox(url: string, opts?: { proxy?: string; signal?: AbortSignal }): Promise<string | null> {
  if (opts?.signal?.aborted) return null
  try {
    // Build proxy config if provided.
    let proxyConfig: { server: string; username?: string; password?: string } | undefined
    if (opts?.proxy) {
      const u = new URL(opts.proxy.replace(/^(https?|socks5):\/\//, 'http://'))
      proxyConfig = {
        server: opts.proxy,
        username: u.username || undefined,
        password: u.password || undefined
      }
    }

    // Get or initialise the singleton browser.
    const browser = await initCamoufox(proxyConfig)
    const vp = randomViewport()

    // Hoisted before the inner try block so the finally always has
    // access to it. If defined inside the inner try and the
    // browser.newPage() call throws before the declaration is reached,
    // the finally's removeEventListener would ReferenceError on the TDZ.
    let abortHandler: (() => void) | undefined
    let page: any
    try {
      // On cancel: close the current page to interrupt in-flight
      // page.goto(). Closing the page makes it throw (detached),
      // which the outer catch converts to a null return.
      abortHandler = () => { page?.close().catch(() => {}) }
      opts?.signal?.addEventListener('abort', abortHandler, { once: true })

      page = await browser.newPage()

      // Inject our custom stealth script before every navigation.
      // addInitScript is the Playwright equivalent of puppeteer's
      // evaluateOnNewDocument — runs in the page's main world before
      // any site scripts execute.
      await page.addInitScript(buildStealthScript())

      // Navigate with network-idle wait so the page is fully loaded.
      // Camoufox's patched Firefox has native anti-fingerprinting
      // built into the browser binary, plus our JS-level stealth
      // script on top — belt AND suspenders.
      await page.goto(url, {
        waitUntil: 'networkidle',
        timeout: LOAD_TIMEOUT_MS
      })
      if (opts?.signal?.aborted) return null

      // Race each wait against the abort signal so cancel feels
      // immediate rather than waiting for the full setTimeout.
      await Promise.race([
        new Promise((r) => setTimeout(r, 1500)),
        abortPromise(opts?.signal)
      ])
      if (opts?.signal?.aborted) return null

      // Scroll to simulate human reading behavior. Cloudflare's behavior
      // analytics detect dead-still pages. Use evaluate() rather than
      // Playwright's mouse API to avoid automation fingerprints.
      const scrollPx = Math.floor(Math.random() * (vp.height * 0.4)) + Math.floor(vp.height * 0.3)
      await page.evaluate((y: number) => window.scrollTo({ top: y, behavior: 'smooth' }), scrollPx).catch(() => {})
      await Promise.race([
        new Promise((r) => setTimeout(r, 200 + Math.random() * 300)),
        abortPromise(opts?.signal)
      ])
      if (opts?.signal?.aborted) return null
      await page.evaluate(() => window.scrollBy({ top: Math.floor(Math.random() * 100), behavior: 'smooth' })).catch(() => {})
      await Promise.race([
        new Promise((r) => setTimeout(r, 100 + Math.random() * 200)),
        abortPromise(opts?.signal)
      ])
      if (opts?.signal?.aborted) return null

      // Challenge detection and retry via page reload (not content polling).
      // Cloudflare challenges execute during page load — re-reading HTML
      // doesn't re-trigger them. Reloading gives a fresh HTTP attempt, and
      // the challenge cookie from a previous attempt may still be valid.
      const challengeDeadline = Date.now() + LOAD_TIMEOUT_MS
      let html = await page.content()
      while (isChallengePage(html) && Date.now() < challengeDeadline && !opts?.signal?.aborted) {
        await page.reload({ waitUntil: 'networkidle', timeout: Math.max(30000, challengeDeadline - Date.now()) }).catch(() => {})
        if (opts?.signal?.aborted) return null
        await Promise.race([
          new Promise((r) => setTimeout(r, CHALLENGE_WAIT_MS)),
          abortPromise(opts?.signal)
        ])
        if (opts?.signal?.aborted) return null
        html = await page.content()
      }
      if (isChallengePage(html) && !opts?.signal?.aborted) {
        throw new Error(
          'This site blocked automated access (Cloudflare). Open the job in your browser and try again later.'
        )
      }

      return html
    } finally {
      if (opts?.signal) opts.signal.removeEventListener('abort', abortHandler)
      // Close the page, NOT the browser — the browser is a shared
      // singleton kept alive across board fetches.
      if (page) await page.close().catch(() => {})
    }
  } catch (err) {
    // Camoufox unavailable or navigation failed.
    // Log the actual error so we can distinguish "not installed" from
    // "blocked by Cloudflare" from "timeout" — previously all three
    // silently returned null and the caller (BrowserWindow fallback)
    // produced the same generic error regardless.
    const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
    log.info(`stage=camoufox-fallback url=${url} error="${message}"`)
    // Caller falls back to BrowserWindow.
    return null
  }
}

export async function fetchHtmlViaBrowser(url: string, opts?: { proxy?: string; signal?: AbortSignal }): Promise<string> {
  if (opts?.signal?.aborted) throw new DOMException('Aborted', 'AbortError')

  // Camoufox path: uses patched Firefox with anti-fingerprinting
  // (Camoufox) + our custom JS stealth script on top.
  // No Chrome/Google dependency. Falls back to BrowserWindow
  // when camoufox isn't available.
  const camoufoxHtml = await fetchHtmlViaCamoufox(url, opts)
  if (camoufoxHtml !== null) return camoufoxHtml

  // Aborted during camoufox setup — don't fall through to BrowserWindow.
  if (opts?.signal?.aborted) throw new DOMException('Aborted', 'AbortError')

  // Fall through to the standard BrowserWindow path.
  return new Promise((resolve, reject) => {
    const ses = session.fromPartition('scraper-persistent')
    const ua = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]

    // Configure proxy if provided. The proxy URL format follows
    // Electron's proxy rules: "http://user:pass@host:port",
    // "socks5://host:port", or "socks5://user:pass@host:port".
    if (opts?.proxy) {
      ses.setProxy({ proxyRules: opts.proxy, proxyBypassRules: '<local>;*.local' }).catch(() => {})
    }

    const vp = randomViewport()
    const win = new BrowserWindow({
      show: false,
      width: vp.width,
      height: vp.height,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: false,
        session: ses
      }
    })

    // Inject the stealth script as early as possible (before page scripts run).
    // 'will-frame-navigate' fires before any frame's JS executes.
    const injectStealth = (e: Electron.Event, details: Electron.Event) => {
      if (!win.isDestroyed()) {
        win.webContents.executeJavaScript(buildStealthScript(), true).catch(() => {})
      }
    }
    win.webContents.on('will-frame-navigate', injectStealth)
    win.webContents.on('did-start-loading', injectStealth)

    ses.webRequest.onBeforeSendHeaders((details, callback) => {
      details.requestHeaders['User-Agent'] = ua
      details.requestHeaders['Accept'] = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8'
      details.requestHeaders['Accept-Language'] = 'en-US,en;q=0.9'
      details.requestHeaders['Accept-Encoding'] = 'gzip, deflate, br'
      details.requestHeaders['DNT'] = '1'
      details.requestHeaders['Upgrade-Insecure-Requests'] = '1'
      callback({ requestHeaders: details.requestHeaders })
    })

    let settled = false

    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (!win.isDestroyed()) win.destroy()
      fn()
    }

    const timer = setTimeout(() => {
      finish(() => reject(new Error('Timed out loading the job page.')))
    }, LOAD_TIMEOUT_MS)

    // React to scan cancel: tear down the BrowserWindow and reject
    // immediately so the caller sees the abort rather than waiting
    // for the timeout.
    if (opts?.signal) {
      opts.signal.addEventListener('abort', () => {
        finish(() => reject(new DOMException('Aborted', 'AbortError')))
      }, { once: true })
    }

    const extract = async (attempt = 0) => {
      try {
        if (opts?.signal?.aborted) {
          finish(() => reject(new DOMException('Aborted', 'AbortError')))
          return
        }
        // First attempt: short wait so non-challenge pages return fast
        // (the vast majority of browser-mode boards aren't behind
        // Cloudflare). On retry, fall back to the full
        // CHALLENGE_WAIT_MS — challenges need real time to resolve.
        const initialWait = attempt === 0 ? 1500 : CHALLENGE_WAIT_MS
        await Promise.race([
          new Promise((r) => setTimeout(r, initialWait)),
          abortPromise(opts?.signal)
        ])
        if (opts?.signal?.aborted) {
          finish(() => reject(new DOMException('Aborted', 'AbortError')))
          return
        }
        const html = await win.webContents.executeJavaScript(
          'document.documentElement.outerHTML',
          true
        )
        if (isChallengePage(html)) {
          // Cloudflare challenges usually clear in 3-5s once the JS
          // challenge runs, but harder Turnstile challenges can take
          // 15-20s. 5 retries × 10s gives the challenge 50s to resolve.
          if (attempt < 5) {
            if (opts?.signal?.aborted) {
              finish(() => reject(new DOMException('Aborted', 'AbortError')))
              return
            }
            await Promise.race([
              new Promise((r) => setTimeout(r, CHALLENGE_WAIT_MS)),
              abortPromise(opts?.signal)
            ])
            return extract(attempt + 1)
          }
          finish(() =>
            reject(
              new Error(
                'This site blocked automated access (Cloudflare). Open the job in your browser and try again later.'
              )
            )
          )
          return
        }
        finish(() => resolve(html))
      } catch (err) {
        finish(() =>
          reject(err instanceof Error ? err : new Error('Failed to read page content.'))
        )
      }
    }

    win.webContents.once('did-finish-load', () => {
      void extract()
    })

    win.webContents.on('did-fail-load', (_event, code, description) => {
      // `ERR_ABORTED` (-3) fires whenever the renderer is redirected or
      // detaches the current frame mid-load — including the very common
      // case where the server returns a JS challenge page that the
      // renderer navigates away from, or where a `meta refresh` /
      // JS redirect cancels the current navigation. Don't treat it as
      // a hard failure; the next `did-finish-load` (if it comes) will
      // resolve the promise through the normal `extract()` path. Only
      // real errors (network failure, DNS, cert) are hard rejection.
      if (code === -3) return
      finish(() => reject(new Error(`Failed to load page (${code}: ${description}).`)))
    })

    void win.loadURL(url)
  })
}

/**
 * For a hash-routed SPA where the *document path* is always the same
 * (e.g. WorkBC keeps `/find-job/search-jobs` for both search results
 * and a per-job detail panel that lives at `#/job-details/{id}`), this
 * helper:
 *   1. Loads the base URL.
 *   2. Sets `window.location.hash` to the target hash fragment.
 *   3. Polls `document.documentElement.outerHTML` until the rendered
 *      HTML contains a marker that proves the SPA swapped in the new
 *      panel (default: any of `markerSubstrings`).
 *   4. Returns that HTML.
 *
 * `markerSubstrings` should be stable strings that appear ONLY in the
 * target panel — for example, `"Job details"`, the page title text,
 * or a field label that the search-results page does not show.
 *
 * `timeoutMs` is the upper bound for the whole wait; defaults to 15s.
 */
export async function navigateToHashViaBrowser(
  baseUrl: string,
  targetHash: string,
  markerSubstrings: string[],
  timeoutMs = 15000,
  opts?: { proxy?: string; signal?: AbortSignal }
): Promise<string> {
  const ses = session.fromPartition('scraper-hashnav-persistent')
  const ua = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]

  if (opts?.proxy) {
    ses.setProxy({ proxyRules: opts.proxy, proxyBypassRules: '<local>;*.local' }).catch(() => {})
  }

  const vp = randomViewport()
  const win = new BrowserWindow({
    show: false,
    width: vp.width,
    height: vp.height,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      session: ses
    }
  })

  const injectStealth = (_e: Electron.Event, _details: Electron.Event) => {
    if (!win.isDestroyed()) {
      win.webContents.executeJavaScript(buildStealthScript(), true).catch(() => {})
    }
  }
  win.webContents.on('will-frame-navigate', injectStealth)
  win.webContents.on('did-start-loading', injectStealth)

  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    details.requestHeaders['User-Agent'] = ua
    details.requestHeaders['Accept'] = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8'
    details.requestHeaders['Accept-Language'] = 'en-US,en;q=0.9'
    details.requestHeaders['Accept-Encoding'] = 'gzip, deflate, br'
    details.requestHeaders['DNT'] = '1'
    details.requestHeaders['Upgrade-Insecure-Requests'] = '1'
    callback({ requestHeaders: details.requestHeaders })
  })

  const finish = () => {
    if (!win.isDestroyed()) win.destroy()
  }

  try {
    // 1. Initial document load.
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        win.webContents.off('did-finish-load', onFinish)
        win.webContents.off('did-fail-load', onFail)
        if (!win.isDestroyed()) win.destroy()
        reject(new DOMException('Aborted', 'AbortError'))
      }
      opts?.signal?.addEventListener('abort', onAbort, { once: true })

      const onFinish = () => {
        opts?.signal?.removeEventListener('abort', onAbort)
        win.webContents.off('did-fail-load', onFail)
        resolve()
      }
      const onFail = (_e: unknown, code: number, desc: string) => {
        opts?.signal?.removeEventListener('abort', onAbort)
        win.webContents.off('did-finish-load', onFinish)
        reject(new Error(`Failed to load page (${code}: ${desc}).`))
      }
      win.webContents.once('did-finish-load', onFinish)
      win.webContents.once('did-fail-load', onFail)
      win.loadURL(baseUrl).catch(reject)
    })

    // 2. Give the SPA time to bootstrap (its router has to attach hash
    // listeners after the document is ready).
    await Promise.race([
      new Promise((r) => setTimeout(r, CHALLENGE_WAIT_MS)),
      abortPromise(opts?.signal)
    ])

    // 3. Set the hash and wait for the panel to render.
    const start = Date.now()
    let html = ''
    while (Date.now() - start < timeoutMs && !opts?.signal?.aborted) {
      // Trigger router by setting hash. Most SPAs re-render on the
      // `hashchange` event; setting `location.hash` if it's already
      // the same value is a no-op, so we always re-set.
      await win.webContents.executeJavaScript(
        `(() => {
          const want = ${JSON.stringify(targetHash)};
          if (window.location.hash !== want) {
            window.location.hash = want;
          } else {
            // Force a re-render by dispatching the event manually.
            window.dispatchEvent(new HashChangeEvent('hashchange'));
          }
        })()`,
        true
      ).catch(() => {})

      // Give the SPA a moment to fetch + render.
      await Promise.race([
        new Promise((r) => setTimeout(r, 800)),
        abortPromise(opts?.signal)
      ])

      html = await win.webContents.executeJavaScript(
        'document.documentElement.outerHTML',
        true
      )

      // Marker check: the panel is up when ANY of the markers appears
      // in the rendered HTML.
      if (markerSubstrings.some((m) => html.includes(m))) {
        return html
      }
    }

    // Timed out — return whatever we have. Caller can decide whether
    // the extracted fields look complete enough to use.
    return html
  } finally {
    finish()
  }
}

export function isChallengePage(html: string): boolean {
  return (
    // Cloudflare-specific challenge signals
    html.includes('Just a moment...') ||
    html.includes('cf-challenge') ||
    html.includes('challenge-platform') ||
    html.includes('Enable JavaScript and cookies to continue') ||
    html.includes('Verifying you are human') ||
    html.includes('Checking your browser before accessing') ||
    html.includes('cf-turnstile') ||
    html.includes('data-turnstile') ||
    html.includes('_cf_chl_opt') ||
    html.includes('_cf_chl_tk') ||
    html.includes('turnstile.render') ||
    html.includes('cf-browser-verification') ||
    html.includes('data-cf-challenge') ||
    html.includes('cf_challenge_response') ||
    html.includes('Cloudflare') && (html.includes('challenge') || html.includes('security check')) ||
    html.includes('Attention Required') && html.includes('Cloudflare') ||
    // Non-Cloudflare WAF / anti-bot signals
    html.includes('Please enable cookies') && html.includes('continue') ||
    html.includes('Your request has been blocked') ||
    html.includes('Access to this page has been denied') ||
    html.includes('blocked') && html.includes('automated access') ||
    html.includes('Something about the behavior of your browser') ||
    html.includes('Pardon Our Interruption') ||
    html.includes('Browser Check') && html.includes('captcha') ||
    html.includes('Detected unusual traffic') ||
    // Generic "access denied" from Akamai / F5 / Imperva
    html.includes('Access Denied') && (html.includes('bot') || html.includes('automated') || html.includes('security') || html.includes('blocked'))
  )
}

/**
 * For hash-routed SPAs, navigating to a new page is the same document
 * with a different fragment — `loadURL` won't fire `did-finish-load` and
 * `fetchHtmlViaBrowser` would return the original page's HTML every
 * time. This helper:
 *   1. Loads the base URL once.
 *   2. For each subsequent `pageHash` in `pageHashes`, sets
 *      `window.location.hash` to that fragment, waits for the SPA to
 *      re-render, and concatenates the resulting outerHTML.
 *
 * The first page is whatever was rendered after the initial load; you
 * typically pass `[]` if you only care about page 2+.
 *
 * `perPageWaitMs` defaults to 2500 — most SPAs finish their route +
 * fetch + re-render in well under 2s. Override for slower sites.
 */
export async function paginateHtmlViaBrowser(
  baseUrl: string,
  pageHashes: string[],
  perPageWaitMs = 2500,
  opts?: { proxy?: string; signal?: AbortSignal }
): Promise<string> {
  // Reuse fetchHtmlViaBrowser for the initial load — it already handles
  // stealth injection, challenge detection, and timeout. Then continue
  // in the same BrowserWindow via a second loadURL with a query-string
  // hack: SPAs that key on the hash won't re-render on hash changes
  // alone, so we navigate to a SAME-PAGE URL with a cache-busting query
  // string. This forces a real document reload that re-initializes the
  // SPA with the new hash.
  const firstPageHtml = await fetchHtmlViaBrowser(baseUrl, opts)
  if (pageHashes.length === 0) return firstPageHtml

  const ses = session.fromPartition('scraper-paginate-persistent')
  const ua = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]

  if (opts?.proxy) {
    ses.setProxy({ proxyRules: opts.proxy, proxyBypassRules: '<local>;*.local' }).catch(() => {})
  }

  const vp = randomViewport()
  const win = new BrowserWindow({
    show: false,
    width: vp.width,
    height: vp.height,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      session: ses
    }
  })

  const injectStealth = (_e: Electron.Event, _details: Electron.Event) => {
    if (!win.isDestroyed()) {
      win.webContents.executeJavaScript(buildStealthScript(), true).catch(() => {})
    }
  }
  win.webContents.on('will-frame-navigate', injectStealth)
  win.webContents.on('did-start-loading', injectStealth)

  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    details.requestHeaders['User-Agent'] = ua
    details.requestHeaders['Accept'] = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8'
    details.requestHeaders['Accept-Language'] = 'en-US,en;q=0.9'
    details.requestHeaders['Accept-Encoding'] = 'gzip, deflate, br'
    details.requestHeaders['DNT'] = '1'
    details.requestHeaders['Upgrade-Insecure-Requests'] = '1'
    callback({ requestHeaders: details.requestHeaders })
  })

  const collected: string[] = []
  let aborted = false

  const finish = () => {
    if (!win.isDestroyed()) win.destroy()
  }

  try {
    for (let i = 0; i < pageHashes.length; i++) {
      if (aborted || opts?.signal?.aborted) break
      const hash = pageHashes[i]
      // Build a same-origin URL whose hash matches what the user sees
      // for this page. Add a cache-buster query so the browser treats
      // it as a fresh navigation and re-runs the SPA bootstrap.
      const u = new URL(baseUrl)
      u.hash = hash
      u.searchParams.set('_p', String(i + 2)) // page numbers are 1-based; page 1 was the initial load

      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          win.webContents.off('did-finish-load', onFinish)
          win.webContents.off('did-fail-load', onFail)
          if (!win.isDestroyed()) win.destroy()
          reject(new DOMException('Aborted', 'AbortError'))
        }
        opts?.signal?.addEventListener('abort', onAbort, { once: true })

        const onFinish = () => {
          opts?.signal?.removeEventListener('abort', onAbort)
          win.webContents.off('did-fail-load', onFail)
          resolve()
        }
        const onFail = (_e: unknown, code: number, desc: string) => {
          opts?.signal?.removeEventListener('abort', onAbort)
          win.webContents.off('did-finish-load', onFinish)
          reject(new Error(`Failed to load page (${code}: ${desc}).`))
        }
        win.webContents.once('did-finish-load', onFinish)
        win.webContents.once('did-fail-load', onFail)
        win.loadURL(u.href).catch(reject)
      })

      // Give the SPA time to fetch its data and re-render the list.
      await Promise.race([
        new Promise((r) => setTimeout(r, perPageWaitMs)),
        abortPromise(opts?.signal)
      ])

      const html = await win.webContents.executeJavaScript(
        'document.documentElement.outerHTML',
        true
      )
      collected.push(html)
    }
  } catch (err) {
    // Partial result is fine — return what we have so far.
    aborted = true
  } finally {
    finish()
  }

  return [firstPageHtml, ...collected].join('\n')
}
