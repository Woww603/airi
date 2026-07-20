import type { ElectronAPI } from '@electron-toolkit/preload'

import { isStageTamagotchi } from './environment'

export type SecureStoragePersistence = 'protected' | 'memory-only'

/** Serialized protected storage snapshot returned by Electron's main process. */
export interface SecureStorageSnapshot {
  /** VueUse-compatible serialized values keyed by stable storage identifiers. */
  entries: Record<string, string>
  /** Whether values survive restart under OS-backed encryption. */
  persistence: SecureStoragePersistence
}

/** Narrow credential storage API exposed by AIRI's sandboxed Electron preload. */
export interface ElectronSecureStorageAPI {
  /** Reads the authoritative protected state during renderer bootstrap. */
  getSnapshot: () => Promise<SecureStorageSnapshot>
  /** Removes a serialized value from protected state. */
  removeItem: (key: string) => Promise<void>
  /** Writes a serialized value into protected state. */
  setItem: (key: string, value: string) => Promise<void>
  /** Subscribes to protected changes made by another AIRI renderer. */
  subscribe: (listener: (change: { key: string, newValue: string | null }) => void) => () => void
}

export interface ElectronWindow<CustomApi = unknown> {
  electron: Pick<ElectronAPI, 'ipcRenderer'> & { secureStorage: ElectronSecureStorageAPI }
  platform: NodeJS.Platform
  api: CustomApi
}

export function isElectronWindow<CustomApi = unknown>(window: Window): window is (Window & ElectronWindow<CustomApi>) {
  return isStageTamagotchi() && typeof window === 'object' && window !== null && 'electron' in window
}
