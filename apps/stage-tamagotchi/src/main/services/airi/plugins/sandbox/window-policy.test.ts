import type { Session } from 'electron'

import { describe, expect, it } from 'vitest'

import { createPluginSandboxWindowOptions } from './window-policy'

/**
 * Locks the production BrowserWindow security invariants for plugin execution.
 *
 * @example
 * describe('plugin sandbox window policy', () => {
 *   expect(options.webPreferences?.sandbox).toBe(true)
 * })
 */
describe('plugin sandbox window policy', () => {
  /**
   * Verifies plugin code cannot receive Node or unsandboxed renderer privileges.
   *
   * @example
   * it('enables Chromium sandboxing and disables Node integration', () => {
   *   expect(options.webPreferences?.nodeIntegration).toBe(false)
   * })
   */
  it('enables Chromium sandboxing and disables Node integration', () => {
    // NOTICE:
    // BrowserWindow options require Electron's full Session interface, while this pure policy test only verifies object identity.
    // Electron Session instances cannot be constructed in a Node Vitest process without starting Electron.
    // Source/context: `Electron.BrowserWindowConstructorOptions.webPreferences.session`.
    // Removal condition: the policy accepts a narrower session token or this assertion moves to an Electron integration test.
    const electronSession = {} as unknown as Session
    const options = createPluginSandboxWindowOptions({
      electronSession,
      preloadPath: '/app/out/main/pluginSandbox.cjs',
      messageEventName: 'message-test',
      pushEventName: 'push-test',
      errorEventName: 'error-test',
    })

    expect(options.show).toBe(false)
    expect(options.webPreferences?.sandbox).toBe(true)
    expect(options.webPreferences?.contextIsolation).toBe(true)
    expect(options.webPreferences?.nodeIntegration).toBe(false)
    expect(options.webPreferences?.webSecurity).toBe(true)
    expect(options.webPreferences?.allowRunningInsecureContent).toBe(false)
    expect(options.webPreferences?.session).toBe(electronSession)
    expect(options.webPreferences?.preload).toBe('/app/out/main/pluginSandbox.cjs')
    expect(options.webPreferences?.additionalArguments).toEqual([
      '--airi-plugin-message=message-test',
      '--airi-plugin-push=push-test',
      '--airi-plugin-error=error-test',
    ])
  })
})
