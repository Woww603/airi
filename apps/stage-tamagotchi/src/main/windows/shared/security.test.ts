import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  createTrustedRendererWindowPreferences,
  isAllowedExternalNavigation,
  isTrustedRendererNavigation,
} from './security'

/**
 * Locks the security policy shared by AIRI-owned renderer windows.
 *
 * @example
 * describe('trusted renderer window security', () => {
 *   expect(preferences.sandbox).toBe(true)
 * })
 */
describe('trusted renderer window security', () => {
  /**
   * Verifies every trusted UI renderer uses Chromium isolation and a sandbox-compatible preload.
   *
   * @example
   * it('enables renderer isolation by default', () => {
   *   expect(preferences.nodeIntegration).toBe(false)
   * })
   */
  it('enables renderer isolation by default', () => {
    const preferences = createTrustedRendererWindowPreferences({
      preloadPath: '/app/out/main/chunks/rendererPreload.cjs',
    })

    expect(preferences.preload).toBe('/app/out/main/chunks/rendererPreload.cjs')
    expect(preferences.sandbox).toBe(true)
    expect(preferences.contextIsolation).toBe(true)
    expect(preferences.nodeIntegration).toBe(false)
    expect(preferences.webSecurity).toBe(true)
    expect(preferences.allowRunningInsecureContent).toBe(false)
    expect(preferences.webviewTag).toBe(false)
  })

  /**
   * Verifies renderer links cannot dispatch dangerous operating-system URL handlers.
   *
   * @example
   * it('allows web links and rejects privileged schemes', () => {
   *   expect(isAllowedExternalNavigation('file:///tmp/attack')).toBe(false)
   * })
   */
  it('allows web links and rejects privileged schemes', () => {
    expect(isAllowedExternalNavigation('https://airi.moeru.ai/docs')).toBe(true)
    expect(isAllowedExternalNavigation('http://localhost:5173/docs')).toBe(true)
    expect(isAllowedExternalNavigation('file:///tmp/attack')).toBe(false)
    expect(isAllowedExternalNavigation('javascript:alert(1)')).toBe(false)
    expect(isAllowedExternalNavigation('vscode://file/etc/passwd')).toBe(false)
    expect(isAllowedExternalNavigation('not a URL')).toBe(false)
  })

  /**
   * Verifies development navigation stays on the configured Vite origin.
   *
   * @example
   * it('contains development navigation to the renderer origin', () => {
   *   expect(isTrustedRendererNavigation(input)).toBe(true)
   * })
   */
  it('contains development navigation to the renderer origin', () => {
    const rendererLocation = { url: 'http://127.0.0.1:5173/' }

    expect(isTrustedRendererNavigation('http://127.0.0.1:5173/#/settings', rendererLocation)).toBe(true)
    expect(isTrustedRendererNavigation('http://localhost:5173/#/settings', rendererLocation)).toBe(false)
    expect(isTrustedRendererNavigation('https://example.com/', rendererLocation)).toBe(false)
  })

  /**
   * Verifies production navigation cannot escape the built renderer directory.
   *
   * @example
   * it('contains file navigation to the renderer directory', () => {
   *   expect(isTrustedRendererNavigation(input)).toBe(false)
   * })
   */
  it('contains file navigation to the renderer directory', () => {
    const rendererRoot = join('/Applications', 'AIRI.app', 'Contents', 'Resources', 'app.asar', 'out', 'renderer')
    const rendererLocation = { file: join(rendererRoot, 'index.html') }

    expect(isTrustedRendererNavigation(
      pathToFileURL(join(rendererRoot, 'index.html')).toString(),
      rendererLocation,
    )).toBe(true)
    expect(isTrustedRendererNavigation(
      pathToFileURL(join(rendererRoot, 'plugin-sandbox.html')).toString(),
      rendererLocation,
    )).toBe(true)
    expect(isTrustedRendererNavigation(
      pathToFileURL(join(rendererRoot, '..', 'main', 'index.js')).toString(),
      rendererLocation,
    )).toBe(false)
  })
})
