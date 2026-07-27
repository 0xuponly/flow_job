import { BrowserWindow, session } from 'electron'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

const LOAD_TIMEOUT_MS = 90000
const CHALLENGE_WAIT_MS = 8000
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
const STEALTH_SCRIPT = `
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
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8, configurable: true })
    Object.defineProperty(navigator, 'deviceMemory', { get: () => 8, configurable: true })

    // ─── navigator.connection (NetworkInformation API) ─────────
    // Some headless browsers expose navigator.connection as undefined
    // or with null properties. Real Chrome has an object with
    // downlink, effectiveType, rtt, saveData.
    if (navigator.connection) {
      try {
        Object.defineProperty(navigator.connection, 'rtt', { get: () => 100, configurable: true })
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
        if (p === 37445) return 'Intel Inc.'
        if (p === 37446) return 'Intel Iris OpenGL Engine'
        return origGetParam.call(this, p)
      }
    } catch {}

    // ─── MediaDevices.enumerateDevices (avoid empty list) ──────
    // Headless Chrome returns an empty MediaDeviceInfo list. Real
    // Chrome returns at least a default audio output device. Some
    // bot detectors call enumerateDevices() and check the length.
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
    // Headless Chrome doesn't set outerWidth/outerHeight properly.
    // These should match the viewport or be slightly larger.
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
    // chrome.app — many sites check for chrome.app.isInstalled
    if (!window.chrome.app) {
      window.chrome.app = {
        isInstalled: false,
        InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
        RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' }
      }
    }
    // chrome.csi — Chrome's Client Side Information
    if (!window.chrome.csi || typeof window.chrome.csi !== 'function') {
      window.chrome.csi = () => ({
        onloadT: Date.now(),
        pageT: Math.floor(Math.random() * 5000) + 1000,
        startE: Date.now() - Math.floor(Math.random() * 10000),
        onload: Date.now(),
        tran: Math.floor(Math.random() * 20)
      })
    }
    // chrome.loadTimes — Page load timing
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
    // chrome.runtime — messaging stub (already present but make it more complete)
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
    // Some fingerprinters check if the browser renders a hairline
    // border by checking computed style. Headless Chrome doesn't
    // render borders the same way. Patch at CSS level.
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
    // When an iframe is created via document.createElement('iframe'),
    // bot detectors check if the contentWindow is accessible and
    // behaves like a real window. Some headless environments fail
    // this check. Patch HTMLIFrameElement.prototype to make the
    // contentWindow look real.
    try {
      const origContentWindow = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentWindow')
      if (origContentWindow && origContentWindow.get) {
        Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', {
          get: function () {
            const win = origContentWindow.get.call(this)
            if (win) {
              try {
                // Ensure document.write doesn't throw
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
`

// ─── Chrome path detection ────────────────────────────────────
// Tries common Chrome/Chromium installation paths. Returns null
// when no real browser is found — caller falls back to BrowserWindow.
// Users can force a path via CHROME_PATH or PUPPETEER_CHROMIUM_REVISION.
function findChromePath(): string | null {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH
  }

  // macOS: homebrew cask and standard installations
  if (process.platform === 'darwin') {
    const paths = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      join(homedir(), 'Applications', 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome')
    ]
    for (const p of paths) {
      if (existsSync(p)) return p
    }
    return null
  }

  // Windows
  if (process.platform === 'win32') {
    const paths = [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      join(process.env.LOCALAPPDATA || 'C:\\Users\\Default', 'Google\\Chrome\\Application\\chrome.exe')
    ]
    for (const p of paths) {
      if (existsSync(p)) return p
    }
    return null
  }

  // Linux: try PATH
  try {
    const { execSync } = require('child_process')
    const candidates = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']
    for (const bin of candidates) {
      try {
        const which = execSync(`which ${bin} 2>/dev/null`, { encoding: 'utf8' }).trim()
        if (which) return which
      } catch {}
    }
  } catch {}
  return null
}

// ─── Puppeteer-powered fetch ──────────────────────────────────
// Uses rebrowser-puppeteer-core (patched puppeteer that fixes the
// Runtime.Enable CDP leak detected by Cloudflare and DataDome).
// Requires a real Chrome/Chromium installation; falls back to null
// when that dependency isn't available.
const _chromePath = findChromePath()
async function fetchHtmlViaPuppeteer(url: string, opts?: { proxy?: string }): Promise<string | null> {
  if (!_chromePath) return null
  try {
    // Dynamic require so the import only fails at runtime (not compile time)
    // when rebrowser-puppeteer-core isn't installed.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const puppeteer = require('rebrowser-puppeteer-core')

    const launchArgs: string[] = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-background-networking',
      '--disable-sync',
      '--no-first-run',
      '--disable-extensions',
      '--disable-default-apps',
      // Suppress "Chrome is controlled by automated software" infobar
      '--disable-automation',
      '--hide-scrollbars',
      // Match the Accept header we set in BrowserWindow
      '--enable-features=NetworkService,NetworkServiceInProcess'
    ]
    if (opts?.proxy) {
      launchArgs.push(`--proxy-server=${opts.proxy}`)
    }

    const browser = await puppeteer.launch({
      executablePath: _chromePath,
      headless: 'new',
      args: launchArgs,
      // Disable automated-flag in Chrome so navigator.webdriver isn't
      // set by Chrome itself — our STEALTH_SCRIPT overrides it anyway.
      ignoreDefaultArgs: ['--enable-automation']
    })

    try {
      const page = await browser.newPage()

      // Set a random UA on the page
      const ua = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]
      await page.setUserAgent(ua)

      // Set realistic viewport to match UA hints
      const vp = randomViewport()
      await page.setViewport(vp)

      // Inject our stealth script before every navigation.
      // evaluateOnNewDocument registers the script to run in the
      // page's main world before any site scripts execute — same
      // timing as the BrowserWindow path's will-frame-navigate hook.
      await page.evaluateOnNewDocument(STEALTH_SCRIPT)

      // Navigate with network-idle wait so the page is fully loaded
      await page.goto(url, {
        waitUntil: 'networkidle',
        timeout: LOAD_TIMEOUT_MS
      })

      // Wait an extra moment for any delayed JavaScript rendering
      await new Promise((r) => setTimeout(r, 1500))

      let html = await page.content()

      // Challenge detection with retry (same logic as BrowserWindow path)
      if (isChallengePage(html)) {
        let retries = 0
        while (retries < 3 && isChallengePage(html)) {
          await new Promise((r) => setTimeout(r, CHALLENGE_WAIT_MS))
          html = await page.content()
          retries++
        }
        if (isChallengePage(html)) {
          throw new Error(
            'This site blocked automated access (Cloudflare). Open the job in your browser and try again later.'
          )
        }
      }

      return html
    } finally {
      await browser.close().catch(() => {})
    }
  } catch (err) {
    // Puppeteer unavailable, Chrome not found, or navigation failed.
    // Caller falls back to BrowserWindow.
    return null
  }
}

export async function fetchHtmlViaBrowser(url: string, opts?: { proxy?: string }): Promise<string> {
  // Puppeteer path: uses rebrowser-puppeteer-core (patched puppeteer that
  // fixes the Runtime.Enable CDP leak detected by Cloudflare/DataDome).
  // Only available when a real Chrome/Chromium is installed on the system.
  // Falls back to BrowserWindow when Chrome isn't available.
  const puppeteerHtml = await fetchHtmlViaPuppeteer(url, opts)
  if (puppeteerHtml !== null) return puppeteerHtml

  // Fall through to the standard BrowserWindow path.
  return new Promise((resolve, reject) => {
    const ses = session.fromPartition(`scraper-${  Date.now()}`, { cache: false })
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
        win.webContents.executeJavaScript(STEALTH_SCRIPT, true).catch(() => {})
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

    const extract = async (attempt = 0) => {
      try {
        // First attempt: short wait so non-challenge pages return fast
        // (the vast majority of browser-mode boards aren't behind
        // Cloudflare). On retry, fall back to the full
        // CHALLENGE_WAIT_MS — challenges need real time to resolve.
        const initialWait = attempt === 0 ? 1500 : CHALLENGE_WAIT_MS
        await new Promise((r) => setTimeout(r, initialWait))
        const html = await win.webContents.executeJavaScript(
          'document.documentElement.outerHTML',
          true
        )
        if (isChallengePage(html)) {
          // Cloudflare challenges usually clear in 3-5s once the JS
          // challenge runs, but harder Turnstile challenges can take
          // 15-20s. Cap retries at 3 to keep the overall request under
          // the 60s timer.
          if (attempt < 3) {
            await new Promise((r) => setTimeout(r, 8000))
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
      // real errors (network failure, DNS, cert) are hard rejections.
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
  opts?: { proxy?: string }
): Promise<string> {
  const ses = session.fromPartition(`scraper-hashnav-${  Date.now()}`, { cache: false })
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
      win.webContents.executeJavaScript(STEALTH_SCRIPT, true).catch(() => {})
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
      const onFinish = () => {
        win.webContents.off('did-fail-load', onFail)
        resolve()
      }
      const onFail = (_e: unknown, code: number, desc: string) => {
        win.webContents.off('did-finish-load', onFinish)
        reject(new Error(`Failed to load page (${code}: ${desc}).`))
      }
      win.webContents.once('did-finish-load', onFinish)
      win.webContents.once('did-fail-load', onFail)
      win.loadURL(baseUrl).catch(reject)
    })

    // 2. Give the SPA time to bootstrap (its router has to attach hash
    // listeners after the document is ready).
    await new Promise((r) => setTimeout(r, CHALLENGE_WAIT_MS))

    // 3. Set the hash and wait for the panel to render.
    const start = Date.now()
    let html = ''
    while (Date.now() - start < timeoutMs) {
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
      await new Promise((r) => setTimeout(r, 800))

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
    html.includes('Cloudflare') && (html.includes('challenge') || html.includes('security check'))
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
  opts?: { proxy?: string }
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

  const ses = session.fromPartition(`scraper-paginate-${  Date.now()}`, { cache: false })
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
      win.webContents.executeJavaScript(STEALTH_SCRIPT, true).catch(() => {})
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
      if (aborted) break
      const hash = pageHashes[i]
      // Build a same-origin URL whose hash matches what the user sees
      // for this page. Add a cache-buster query so the browser treats
      // it as a fresh navigation and re-runs the SPA bootstrap.
      const u = new URL(baseUrl)
      u.hash = hash
      u.searchParams.set('_p', String(i + 2)) // page numbers are 1-based; page 1 was the initial load

      await new Promise<void>((resolve, reject) => {
        const onFinish = () => {
          win.webContents.off('did-fail-load', onFail)
          resolve()
        }
        const onFail = (_e: unknown, code: number, desc: string) => {
          win.webContents.off('did-finish-load', onFinish)
          reject(new Error(`Failed to load page (${code}: ${desc}).`))
        }
        win.webContents.once('did-finish-load', onFinish)
        win.webContents.once('did-fail-load', onFail)
        win.loadURL(u.href).catch(reject)
      })

      // Give the SPA time to fetch its data and re-render the list.
      await new Promise((r) => setTimeout(r, perPageWaitMs))

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
