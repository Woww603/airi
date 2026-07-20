import type { BrowserWindow, WebPreferences } from 'electron'

import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** Location accepted by Electron's `loadURL` or `loadFile` renderer bootstrap. */
export type TrustedRendererLocation = { url: string } | { file: string }

/**
 * Builds the mandatory web preferences for AIRI-owned renderer windows.
 *
 * Use when:
 * - Creating a BrowserWindow that loads AIRI's bundled or development renderer
 *
 * Expects:
 * - `preloadPath` points to the sandbox-compatible CommonJS preload asset
 *
 * Returns:
 * - Explicit Chromium isolation settings with Node integration disabled
 */
export function createTrustedRendererWindowPreferences(input: {
  preloadPath: string
  backgroundThrottling?: boolean
}): WebPreferences {
  return {
    preload: input.preloadPath,
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
    backgroundThrottling: input.backgroundThrottling,
  }
}

/**
 * Checks whether a renderer-selected URL may be delegated to the operating system.
 *
 * Use when:
 * - Handling links requested by an AIRI renderer
 *
 * Expects:
 * - A fully qualified URL string
 *
 * Returns:
 * - `true` only for ordinary HTTP(S) browser navigation
 */
export function isAllowedExternalNavigation(url: string): boolean {
  try {
    const protocol = new URL(url).protocol
    return protocol === 'https:' || protocol === 'http:'
  }
  catch {
    return false
  }
}

function isPathInside(rootPath: string, candidatePath: string): boolean {
  const relativePath = relative(rootPath, candidatePath)
  return relativePath !== '..'
    && !relativePath.startsWith(`..${sep}`)
    && !isAbsolute(relativePath)
}

/**
 * Checks whether a navigation remains inside AIRI's trusted renderer boundary.
 *
 * Use when:
 * - Filtering `will-navigate` and `will-redirect` events
 *
 * Expects:
 * - Development renderers use an HTTP(S) origin
 * - Production renderers use files beneath one built renderer directory
 *
 * Returns:
 * - `true` for the configured development origin or packaged renderer directory only
 */
export function isTrustedRendererNavigation(
  candidateUrl: string,
  rendererLocation: TrustedRendererLocation,
): boolean {
  try {
    const trustedUrl = 'url' in rendererLocation
      ? new URL(rendererLocation.url)
      : new URL(pathToFileURL(rendererLocation.file))
    const candidate = new URL(candidateUrl)

    if (trustedUrl.protocol !== 'file:') {
      return candidate.origin === trustedUrl.origin
        && candidate.protocol === trustedUrl.protocol
    }
    if (candidate.protocol !== 'file:') {
      return false
    }

    const rendererRoot = dirname(resolve(fileURLToPath(trustedUrl)))
    const candidatePath = resolve(fileURLToPath(candidate))
    return isPathInside(rendererRoot, candidatePath)
  }
  catch {
    return false
  }
}

/**
 * Installs navigation and new-window guards on an AIRI-owned BrowserWindow.
 *
 * Use when:
 * - A trusted renderer window has been constructed but not loaded
 *
 * Expects:
 * - `rendererLocation` is the exact base location passed to the window loader
 * - `openExternal` delegates a validated HTTP(S) URL to the operating system
 *
 * Returns:
 * - Nothing; the WebContents handlers remain active for the window lifetime
 */
export function installTrustedRendererWindowSecurity(input: {
  window: BrowserWindow
  rendererLocation: TrustedRendererLocation
  openExternal: (url: string) => Promise<void>
}): void {
  function openAllowedExternal(url: string): void {
    if (!isAllowedExternalNavigation(url)) {
      return
    }

    void input.openExternal(url).catch((error) => {
      console.error('Failed to open an allowed external renderer URL.', error)
    })
  }

  input.window.webContents.setWindowOpenHandler((details) => {
    openAllowedExternal(details.url)
    return { action: 'deny' }
  })

  input.window.webContents.on('will-navigate', (event, url) => {
    if (!isTrustedRendererNavigation(url, input.rendererLocation)) {
      event.preventDefault()
    }
  })
  input.window.webContents.on('will-redirect', (event, url) => {
    if (!isTrustedRendererNavigation(url, input.rendererLocation)) {
      event.preventDefault()
    }
  })
  input.window.webContents.on('will-attach-webview', (event) => {
    event.preventDefault()
  })
}
