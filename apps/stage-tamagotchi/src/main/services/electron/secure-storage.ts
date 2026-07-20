import type { IpcMainInvokeEvent, WebContents } from 'electron'

import process from 'node:process'

import { ipcMain, safeStorage } from 'electron'

import {
  createSafeStorageCipher,
  ProtectedStorage,
} from './protected-storage'

export const secureStorageIpcChannels = {
  changed: 'airi:secure-storage:v1:changed',
  getSnapshot: 'airi:secure-storage:v1:get-snapshot',
  removeItem: 'airi:secure-storage:v1:remove-item',
  setItem: 'airi:secure-storage:v1:set-item',
} as const

/** Lifecycle handle for AIRI's protected renderer credential bridge. */
export interface SecureStorageHandle {
  /** Removes IPC handlers and releases tracked renderer references. */
  dispose: () => void
  /** Waits until every accepted encrypted write has reached disk. */
  flush: () => Promise<void>
  /** Reads a main-process value from authoritative protected state. */
  getItem: (key: string) => string | null
  /** Removes a main-process value from authoritative protected state. */
  removeItem: (key: string) => Promise<void>
  /** Writes a main-process value into authoritative protected state. */
  setItem: (key: string, value: string) => Promise<void>
}

/**
 * Registers a sender-validated IPC bridge backed by OS-protected storage.
 *
 * Use when:
 * - Electron is ready and before any AIRI renderer window is created
 *
 * Expects:
 * - `filePath` is within AIRI's user-data directory
 * - `isTrustedRendererUrl` applies the same origin/path policy as BrowserWindow navigation
 *
 * Returns:
 * - A lifecycle handle used to flush writes during application shutdown
 */
export async function setupSecureStorage(input: {
  filePath: string
  isTrustedRendererUrl: (url: string) => boolean
}): Promise<SecureStorageHandle> {
  const productionCipher = createSafeStorageCipher({
    platform: process.platform,
    safeStorage,
  })
  let storage = new ProtectedStorage({
    cipher: productionCipher,
    filePath: input.filePath,
  })

  try {
    await storage.initialize()
  }
  catch {
    // A corrupt or undecryptable file remains untouched. Continuing in memory
    // avoids both plaintext fallback and accidental destruction of recoverable data.
    console.error('Protected credential storage could not be loaded; using memory-only storage for this session.')
    storage = new ProtectedStorage({
      cipher: {
        isProtectionAvailable: () => false,
        protect: () => { throw new Error('Memory-only protected storage cannot encrypt') },
        unprotect: () => { throw new Error('Memory-only protected storage cannot decrypt') },
      },
      filePath: input.filePath,
    })
    await storage.initialize()
  }

  if (storage.snapshot().persistence === 'memory-only') {
    console.warn('OS-backed credential encryption is unavailable; AIRI will keep secrets in memory only for this session.')
  }

  const authorizedRenderers = new Set<WebContents>()

  function assertTrustedSender(event: IpcMainInvokeEvent): void {
    const senderFrame = event.senderFrame
    if (
      !senderFrame
      || senderFrame !== event.sender.mainFrame
      || !input.isTrustedRendererUrl(senderFrame.url)
    ) {
      throw new Error('Unauthorized protected storage request')
    }

    if (!authorizedRenderers.has(event.sender)) {
      authorizedRenderers.add(event.sender)
      event.sender.once('destroyed', () => authorizedRenderers.delete(event.sender))
    }
  }

  function broadcastChange(change: { key: string, newValue: string | null }): void {
    for (const renderer of authorizedRenderers) {
      if (renderer.isDestroyed() || !input.isTrustedRendererUrl(renderer.getURL())) {
        authorizedRenderers.delete(renderer)
        continue
      }
      renderer.send(secureStorageIpcChannels.changed, change)
    }
  }

  ipcMain.handle(secureStorageIpcChannels.getSnapshot, (event) => {
    assertTrustedSender(event)
    return storage.snapshotForRenderer()
  })
  ipcMain.handle(secureStorageIpcChannels.setItem, async (event, key: unknown, value: unknown) => {
    assertTrustedSender(event)
    if (typeof key !== 'string' || key.startsWith('main/') || key === 'settings/discord/token' || typeof value !== 'string')
      throw new Error('Invalid protected storage request')

    try {
      await storage.setItem(key, value)
    }
    catch {
      throw new Error('Failed to persist protected storage value')
    }
    broadcastChange({ key, newValue: value })
  })
  ipcMain.handle(secureStorageIpcChannels.removeItem, async (event, key: unknown) => {
    assertTrustedSender(event)
    if (typeof key !== 'string' || key.startsWith('main/') || key === 'settings/discord/token')
      throw new Error('Invalid protected storage request')

    try {
      await storage.removeItem(key)
    }
    catch {
      throw new Error('Failed to remove protected storage value')
    }
    broadcastChange({ key, newValue: null })
  })

  return {
    dispose: () => {
      ipcMain.removeHandler(secureStorageIpcChannels.getSnapshot)
      ipcMain.removeHandler(secureStorageIpcChannels.setItem)
      ipcMain.removeHandler(secureStorageIpcChannels.removeItem)
      authorizedRenderers.clear()
    },
    flush: () => storage.flush(),
    getItem: key => storage.getItem(key),
    removeItem: key => storage.removeItem(key),
    setItem: (key, value) => storage.setItem(key, value),
  }
}
