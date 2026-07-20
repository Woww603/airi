import type { BrowserWindowConstructorOptions, Session } from 'electron'

import { pluginSandboxArgumentNames } from '../../../../../shared/plugin/sandbox-bridge'

/** Inputs used to construct one hardened plugin sandbox window. */
export interface PluginSandboxWindowPolicyInput {
  /** Non-persistent Electron session dedicated to one plugin runtime. */
  electronSession: Session
  /** Absolute path to the dependency-free CommonJS sandbox preload. */
  preloadPath: string
  /** Session-specific Eventa request/response channel. */
  messageEventName: string
  /** Session-specific Eventa host push channel. */
  pushEventName: string
  /** Session-specific Eventa error channel. */
  errorEventName: string
}

/**
 * Builds the fixed Chromium security policy for a hidden plugin window.
 *
 * Use when:
 * - Creating a renderer that will execute untrusted local plugin ESM
 *
 * Expects:
 * - The Electron session is non-persistent and has deny-by-default permissions
 * - Eventa channels are unguessable and unique to this renderer
 *
 * Returns:
 * - BrowserWindow options with Chromium sandboxing enabled and Node access disabled
 */
export function createPluginSandboxWindowOptions(
  input: PluginSandboxWindowPolicyInput,
): BrowserWindowConstructorOptions {
  return {
    show: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      session: input.electronSession,
      preload: input.preloadPath,
      additionalArguments: [
        `--${pluginSandboxArgumentNames.message}=${input.messageEventName}`,
        `--${pluginSandboxArgumentNames.push}=${input.pushEventName}`,
        `--${pluginSandboxArgumentNames.error}=${input.errorEventName}`,
      ],
    },
  }
}
