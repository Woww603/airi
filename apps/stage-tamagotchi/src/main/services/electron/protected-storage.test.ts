import type { ProtectedStorageCipher } from './protected-storage'

import { Buffer } from 'node:buffer'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { createSafeStorageCipher, ProtectedStorage } from './protected-storage'

const temporaryDirectories: string[] = []

async function createTemporaryStoragePath(): Promise<string> {
  // Each test receives a private OS temporary directory so atomic rename and
  // permission behavior match the production filesystem boundary.
  const directory = await mkdtemp(join(tmpdir(), 'airi-protected-storage-'))
  temporaryDirectories.push(directory)
  return join(directory, 'secrets.bin')
}

const protectedCipher: ProtectedStorageCipher = {
  isProtectionAvailable: () => true,
  protect: plaintext => Buffer.from(`protected:${Buffer.from(plaintext).toString('base64')}`),
  unprotect: ciphertext => Buffer.from(ciphertext.toString().slice('protected:'.length), 'base64').toString(),
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

/**
 * Protects renderer credentials from plaintext recovery on disk.
 *
 * @example
 * describe('ProtectedStorage', () => {
 *   expect(file.includes('provider-secret')).toBe(false)
 * })
 */
describe('protected storage', () => {
  /**
   * @example
   * it('keeps Main-owned credentials out of renderer snapshots (Discord audit D-001)', async () => {})
   */
  it('keeps Main-owned credentials out of renderer snapshots (Discord audit D-001)', async () => {
    // ROOT CAUSE:
    //
    // The protected file encrypted values at rest, but the renderer snapshot
    // returned every entry. A Discord token stored under a Main-owned key would
    // therefore still enter renderer memory and DevTools.
    //
    // The fixed renderer projection excludes the reserved Main namespace while
    // the authoritative Main API can still retrieve the same credential.
    const filePath = await createTemporaryStoragePath()
    const storage = new ProtectedStorage({ cipher: protectedCipher, filePath })
    await storage.initialize()
    await storage.setItem('settings/provider/token', 'synthetic-renderer-token')
    await storage.setItem('settings/discord/token', 'synthetic-retired-discord-token')
    await storage.setItem('main/discord-bridge/bot-token', 'synthetic-discord-bot-token')

    // @example
    expect(storage.getItem('main/discord-bridge/bot-token')).toBe('synthetic-discord-bot-token')
    // @example
    expect(storage.snapshotForRenderer()).toEqual({
      entries: {
        'settings/provider/token': 'synthetic-renderer-token',
      },
      persistence: 'protected',
    })
  })

  /**
   * Rejects Electron's documented weak Linux fallback even when encryption reports available.
   *
   * @example
   * it('treats Linux basic_text as unavailable protection', () => {})
   */
  it('treats Linux basic_text as unavailable protection', () => {
    const cipher = createSafeStorageCipher({
      platform: 'linux',
      safeStorage: {
        decryptString: ciphertext => ciphertext.toString(),
        encryptString: plaintext => Buffer.from(plaintext),
        getSelectedStorageBackend: () => 'basic_text',
        isEncryptionAvailable: () => true,
      },
    })

    // @example
    expect(cipher.isProtectionAvailable()).toBe(false)
  })

  /**
   * Reproduces the current localStorage exposure with a disk-level assertion.
   *
   * @example
   * it('encrypts values before atomically persisting them', async () => {})
   */
  it('encrypts values before atomically persisting them', async () => {
    const filePath = await createTemporaryStoragePath()
    const storage = new ProtectedStorage({ cipher: protectedCipher, filePath })
    const plaintextSecret = 'provider-secret-visible-to-local-malware'

    await storage.initialize()
    await storage.setItem('settings/credentials/providers', plaintextSecret)

    const persisted = await readFile(filePath)
    const fileStats = await stat(filePath)

    // ROOT CAUSE:
    //
    // Provider credentials and auth tokens were persisted by VueUse directly
    // into Chromium localStorage. Any process running as the same OS user could
    // recover those raw values from the Electron profile without launching AIRI.
    //
    // We fix this by encrypting the complete validated payload with Electron's
    // OS-backed safeStorage provider before the atomic file write.
    // @example
    expect(persisted.includes(Buffer.from(plaintextSecret))).toBe(false)
    // @example
    expect(fileStats.mode & 0o077).toBe(0)
    // @example
    expect(storage.snapshot()).toEqual({
      entries: { 'settings/credentials/providers': plaintextSecret },
      persistence: 'protected',
    })
  })

  /**
   * Verifies AIRI never substitutes plaintext or weak Linux basic_text storage.
   *
   * @example
   * it('fails closed to memory when OS protection is unavailable', async () => {})
   */
  it('fails closed to memory when OS protection is unavailable', async () => {
    const filePath = await createTemporaryStoragePath()
    const unavailableCipher: ProtectedStorageCipher = {
      isProtectionAvailable: () => false,
      protect: () => { throw new Error('must not encrypt') },
      unprotect: () => { throw new Error('must not decrypt') },
    }
    const storage = new ProtectedStorage({ cipher: unavailableCipher, filePath })

    await storage.initialize()
    await storage.setItem('auth/v1/refresh-token', 'refresh-secret')

    // @example
    await expect(stat(filePath)).rejects.toMatchObject({ code: 'ENOENT' })
    // @example
    expect(storage.snapshot()).toEqual({
      entries: { 'auth/v1/refresh-token': 'refresh-secret' },
      persistence: 'memory-only',
    })
  })

  /**
   * Verifies renderer-controlled keys and values cannot create an unbounded file.
   *
   * @example
   * it('rejects invalid keys and oversized values', async () => {})
   */
  it('rejects invalid keys and oversized values', async () => {
    const filePath = await createTemporaryStoragePath()
    const storage = new ProtectedStorage({ cipher: protectedCipher, filePath })
    await storage.initialize()

    // @example
    expect(() => storage.setItem('../escape', 'secret')).toThrow('Invalid protected storage key')
    // @example
    expect(() => storage.setItem('auth/v1/token', 'x'.repeat(256 * 1024 + 1))).toThrow('Protected storage value is too large')
  })
})
