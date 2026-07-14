import { BrowserWindow, session } from 'electron'

const LOAD_TIMEOUT_MS = 60000
const CHALLENGE_WAIT_MS = 8000
const USER_AGENTS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
]

// Stealth script: patches navigator to hide headless/automation signals.
// Runs in the page's main world before any site scripts execute.
const STEALTH_SCRIPT = `
(() => {
  try {
    // Hide webdriver flag
    Object.defineProperty(navigator, 'webdriver', { get: () => false, configurable: true })
    // Fake plugins (real Chrome has 3 default plugins)
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
    // Languages
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'], configurable: true })
    // Platform (matching UA)
    const ua = navigator.userAgent
    let platform = 'Win32'
    if (ua.includes('Mac')) platform = 'MacIntel'
    else if (ua.includes('Linux')) platform = 'Linux x86_64'
    Object.defineProperty(navigator, 'platform', { get: () => platform, configurable: true })
    // Hardware concurrency (looks like a real machine)
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8, configurable: true })
    Object.defineProperty(navigator, 'deviceMemory', { get: () => 8, configurable: true })
    // Permissions API: notifications default should be 'default' or 'denied', not 'prompt' in headless
    if (navigator.permissions && navigator.permissions.query) {
      const origQuery = navigator.permissions.query.bind(navigator.permissions)
      navigator.permissions.query = (params) =>
        origQuery(params).then((res) => {
          if (params.name === 'notifications') Object.defineProperty(res, 'state', { get: () => 'denied' })
          return res
        })
    }
    // WebGL vendor/renderer (avoid the SwiftShader fallback that signals headless)
    try {
      const origGetParam = WebGLRenderingContext.prototype.getParameter
      WebGLRenderingContext.prototype.getParameter = function (p) {
        if (p === 37445) return 'Intel Inc.'
        if (p === 37446) return 'Intel Iris OpenGL Engine'
        return origGetParam.call(this, p)
      }
    } catch {}
    // Chrome runtime stub (some sites check for it)
    if (!window.chrome) {
      window.chrome = {
        runtime: {
          onMessage: { addListener: () => {}, removeListener: () => {} },
          sendMessage: () => {},
          connect: () => ({ onMessage: { addListener: () => {} } })
        },
        loadTimes: () => ({}),
        csi: () => ({}),
        app: { isInstalled: false }
      }
    }
    // Notification permission default
    if (window.Notification && Notification.permission === 'default') {
      try { Object.defineProperty(Notification, 'permission', { get: () => 'denied', configurable: true }) } catch {}
    }
  } catch {}
})();
`

export async function fetchHtmlViaBrowser(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const ses = session.fromPartition(`scraper-${  Date.now()}`, { cache: false })
    const ua = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]

    const win = new BrowserWindow({
      show: false,
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
        await new Promise((r) => setTimeout(r, attempt === 0 ? CHALLENGE_WAIT_MS : 4000))
        const html = await win.webContents.executeJavaScript(
          'document.documentElement.outerHTML',
          true
        )
        if (isChallengePage(html)) {
          if (attempt === 0) {
            await new Promise((r) => setTimeout(r, 10000))
            return extract(1)
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

    win.webContents.on('did-finish-load', () => {
      void extract()
    })

    win.webContents.on('did-fail-load', (_event, code, description) => {
      finish(() => reject(new Error(`Failed to load page (${code}: ${description}).`)))
    })

    void win.loadURL(url)
  })
}

export function isChallengePage(html: string): boolean {
  return (
    html.includes('Just a moment...') ||
    html.includes('cf-challenge') ||
    html.includes('challenge-platform') ||
    html.includes('Enable JavaScript and cookies to continue') ||
    html.includes('Verifying you are human') ||
    html.includes('Checking your browser before accessing')
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
  perPageWaitMs = 2500
): Promise<string> {
  // Reuse fetchHtmlViaBrowser for the initial load — it already handles
  // stealth injection, challenge detection, and timeout. Then continue
  // in the same BrowserWindow via a second loadURL with a query-string
  // hack: SPAs that key on the hash won't re-render on hash changes
  // alone, so we navigate to a SAME-PAGE URL with a cache-busting query
  // string. This forces a real document reload that re-initializes the
  // SPA with the new hash.
  const firstPageHtml = await fetchHtmlViaBrowser(baseUrl)
  if (pageHashes.length === 0) return firstPageHtml

  const ses = session.fromPartition(`scraper-paginate-${  Date.now()}`, { cache: false })
  const ua = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]

  const win = new BrowserWindow({
    show: false,
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
