/** Listener surface exposed by the sandbox preload to the isolated renderer world. */
export type PluginSandboxIpcListener = (event: unknown, ...args: unknown[]) => void

/** Minimal IPC subset required by the Eventa Electron renderer adapter. */
export interface PluginSandboxIpcRenderer {
  /** Sends one Eventa payload on the session-specific request channel. */
  send: (channel: string, ...args: unknown[]) => void
  /** Subscribes to one of the three session-specific Eventa response channels. */
  on: (channel: string, listener: PluginSandboxIpcListener) => () => void
  /** Removes a previously registered response listener. */
  removeListener: (channel: string, listener: PluginSandboxIpcListener) => PluginSandboxIpcRenderer
}

/** Narrow main-world bridge made available only to the plugin sandbox runner. */
export interface PluginSandboxBridge {
  /** Eventa bidirectional request/response channel. */
  messageEventName: string
  /** Eventa host-to-plugin push channel. */
  pushEventName: string
  /** Eventa transport error channel. */
  errorEventName: string
  /** Fixed-channel IPC adapter; it cannot access arbitrary Electron IPC names. */
  ipcRenderer: PluginSandboxIpcRenderer
}

export const pluginSandboxArgumentNames = {
  message: 'airi-plugin-message',
  push: 'airi-plugin-push',
  error: 'airi-plugin-error',
} as const
