import { Buffer } from 'node:buffer'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { secureStorageIpcChannels, setupSecureStorage } from './secure-storage'

type TestIpcHandler = (event: TestIpcEvent, ...args: unknown[]) => unknown

interface TestIpcEvent {
  sender: TestWebContents
  senderFrame: { url: string }
}

interface TestWebContents {
  getURL: () => string
  isDestroyed: () => boolean
  mainFrame: { url: string }
  once: (event: string, listener: () => void) => void
  send: (channel: string, value: unknown) => void
}

const electronMocks = vi.hoisted(() => {
  const handlers = new Map<string, TestIpcHandler>()
  return {
    handlers,
    ipcMain: {
      handle: vi.fn((channel: string, handler: TestIpcHandler) => handlers.set(channel, handler)),
      removeHandler: vi.fn((channel: string) => handlers.delete(channel)),
    },
    safeStorage: {
      decryptString: (ciphertext: Buffer) => Buffer.from(ciphertext.toString().slice('protected:'.length), 'base64').toString(),
      encryptString: (plaintext: string) => Buffer.from(`protected:${Buffer.from(plaintext).toString('base64')}`),
      getSelectedStorageBackend: () => 'keychain',
      isEncryptionAvailable: () => true,
    },
  }
})

vi.mock('electron', () => ({
  ipcMain: electronMocks.ipcMain,
  safeStorage: electronMocks.safeStorage,
}))

const temporaryDirectories: string[] = []

afterEach(async () => {
  electronMocks.handlers.clear()
  vi.clearAllMocks()
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { force: true, recursive: true })))
})

/**
 * @example
 * describe('secure storage IPC boundary', () => {})
 */
describe('secure storage IPC boundary', () => {
  /**
   * @example
   * Main-only credentials remain authoritative in Main and inaccessible through renderer handlers.
   */
  it('blocks renderer reads and mutations of Main-only Discord credentials (Discord audit D-001)', async () => {
    // ROOT CAUSE:
    //
    // Testing only the storage class did not prove that the actual IPC handlers
    // used the filtered projection or rejected renderer writes to `main/*`.
    // This exercises the registered handler boundary with a trusted main frame.
    const directory = await mkdtemp(join(tmpdir(), 'airi-secure-storage-ipc-'))
    temporaryDirectories.push(directory)
    const storage = await setupSecureStorage({
      filePath: join(directory, 'secrets.bin'),
      isTrustedRendererUrl: url => url === 'airi://renderer/index.html',
    })
    await storage.setItem('main/discord-bridge/bot-token', 'synthetic-discord-secret')
    await storage.setItem('settings/provider/token', 'synthetic-renderer-secret')

    const mainFrame = { url: 'airi://renderer/index.html' }
    const sender: TestWebContents = {
      getURL: () => mainFrame.url,
      isDestroyed: () => false,
      mainFrame,
      once: vi.fn(),
      send: vi.fn(),
    }
    const event: TestIpcEvent = { sender, senderFrame: mainFrame }
    const snapshotHandler = electronMocks.handlers.get(secureStorageIpcChannels.getSnapshot)
    const setHandler = electronMocks.handlers.get(secureStorageIpcChannels.setItem)
    const removeHandler = electronMocks.handlers.get(secureStorageIpcChannels.removeItem)
    if (!snapshotHandler || !setHandler || !removeHandler)
      throw new Error('Secure storage IPC handlers were not registered')

    // @example
    expect(snapshotHandler(event)).toEqual({
      entries: { 'settings/provider/token': 'synthetic-renderer-secret' },
      persistence: 'protected',
    })
    // @example
    await expect(Promise.resolve(setHandler(event, 'main/discord-bridge/bot-token', 'attacker-value'))).rejects.toThrow('Invalid protected storage request')
    // @example
    await expect(Promise.resolve(removeHandler(event, 'main/discord-bridge/bot-token'))).rejects.toThrow('Invalid protected storage request')
    // @example
    expect(storage.getItem('main/discord-bridge/bot-token')).toBe('synthetic-discord-secret')

    storage.dispose()
  })
})
