import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { literal, object, record, safeParse, string } from 'valibot'

const MAX_ENTRY_COUNT = 256
const MAX_KEY_BYTES = 160
const MAX_VALUE_BYTES = 256 * 1024
const MAX_PLAINTEXT_BYTES = 1024 * 1024
const MAX_CIPHERTEXT_BYTES = 2 * 1024 * 1024
const PROTECTED_STORAGE_KEY_PATTERN = /^[a-z\d][\w./:-]*$/i
const MAIN_PROCESS_STORAGE_PREFIX = 'main/'
const RETIRED_RENDERER_SECRET_KEYS = new Set(['settings/discord/token'])

function isRendererVisibleKey(key: string): boolean {
  return !key.startsWith(MAIN_PROCESS_STORAGE_PREFIX) && !RETIRED_RENDERER_SECRET_KEYS.has(key)
}

const protectedStoragePayloadSchema = object({
  version: literal(1),
  entries: record(string(), string()),
})

export type ProtectedStoragePersistence = 'protected' | 'memory-only'

/** OS-backed encryption boundary used by the protected credential store. */
export interface ProtectedStorageCipher {
  /** Whether encryption provides real OS-backed protection for this session. */
  isProtectionAvailable: () => boolean
  /** Encrypts a UTF-8 payload before it crosses the filesystem boundary. */
  protect: (plaintext: string) => Buffer
  /** Decrypts a payload previously produced by {@link ProtectedStorageCipher.protect}. */
  unprotect: (ciphertext: Buffer) => string
}

/** Minimal Electron safeStorage surface required by the credential store. */
export interface SafeStorageLike {
  /** Decrypts ciphertext using the current OS user protection provider. */
  decryptString: (ciphertext: Buffer) => string
  /** Encrypts plaintext using the current OS user protection provider. */
  encryptString: (plaintext: string) => Buffer
  /** Reports the selected Linux password-store implementation. */
  getSelectedStorageBackend: () => string
  /** Reports whether Electron can currently encrypt and decrypt values. */
  isEncryptionAvailable: () => boolean
}

/**
 * Adapts Electron safeStorage while rejecting its weak Linux plaintext fallback.
 *
 * Use when:
 * - Creating the production cipher after Electron emits `ready`
 *
 * Expects:
 * - `platform` is the main process platform
 * - Linux callers expose the backend selected by Electron
 *
 * Returns:
 * - A cipher that fails closed for `basic_text`, `unknown`, or unavailable encryption
 */
export function createSafeStorageCipher(input: {
  platform: NodeJS.Platform
  safeStorage: SafeStorageLike
}): ProtectedStorageCipher {
  return {
    isProtectionAvailable: () => {
      if (!input.safeStorage.isEncryptionAvailable())
        return false
      if (input.platform !== 'linux')
        return true

      const backend = input.safeStorage.getSelectedStorageBackend()
      return backend !== 'basic_text' && backend !== 'unknown'
    },
    // NOTICE:
    // Electron 41.2.1 only exposes the synchronous safeStorage API used here.
    // Root cause: async safeStorage methods exist in newer Electron documentation
    // but are absent from this repository's installed `electron.d.ts`.
    // Source/context: `node_modules/electron/electron.d.ts` SafeStorage and
    // `https://www.electronjs.org/docs/latest/api/safe-storage`.
    // Removal condition: migrate these adapters to encryptStringAsync and
    // decryptStringAsync after AIRI's Electron version exposes them.
    protect: plaintext => input.safeStorage.encryptString(plaintext),
    unprotect: ciphertext => input.safeStorage.decryptString(ciphertext),
  }
}

/** Validated snapshot returned to an authorized AIRI renderer. */
export interface ProtectedStorageSnapshot {
  /** Serialized VueUse values keyed by their stable storage identifiers. */
  entries: Record<string, string>
  /** Whether changes survive restart using OS-backed encryption. */
  persistence: ProtectedStoragePersistence
}

/**
 * Owns AIRI's encrypted credential file and in-memory authoritative state.
 *
 * Use when:
 * - Persisting renderer credentials through Electron's main process
 * - Falling back to session-only memory when OS encryption is unavailable
 *
 * Expects:
 * - {@link initialize} runs after Electron's `ready` event and before renderer access
 * - `filePath` is inside AIRI's user-data directory
 *
 * Returns:
 * - Validated snapshots and completion promises for atomic encrypted writes
 */
export class ProtectedStorage {
  readonly #cipher: ProtectedStorageCipher
  readonly #entries = new Map<string, string>()
  readonly #filePath: string
  #initialized = false
  #persistence: ProtectedStoragePersistence = 'memory-only'
  #writeQueue: Promise<void> = Promise.resolve()

  constructor(input: { cipher: ProtectedStorageCipher, filePath: string }) {
    this.#cipher = input.cipher
    this.#filePath = input.filePath
  }

  /**
   * Loads and validates the encrypted credential file when protection is available.
   *
   * Use when:
   * - Electron has emitted `ready`, before registering renderer IPC handlers
   *
   * Expects:
   * - The cipher reports false for weak or unavailable platform backends
   *
   * Returns:
   * - Nothing; subsequent snapshots reflect disk state or memory-only mode
   */
  async initialize(): Promise<void> {
    if (this.#initialized)
      return

    this.#initialized = true
    if (!this.#cipher.isProtectionAvailable())
      return

    this.#persistence = 'protected'

    let ciphertext: Buffer
    try {
      const fileStats = await stat(this.#filePath)
      if (fileStats.size > MAX_CIPHERTEXT_BYTES)
        throw new Error('Protected storage file is too large')
      ciphertext = await readFile(this.#filePath)
    }
    catch (error) {
      if (isMissingFileError(error))
        return
      throw error
    }

    const plaintext = this.#cipher.unprotect(ciphertext)
    if (Buffer.byteLength(plaintext) > MAX_PLAINTEXT_BYTES)
      throw new Error('Protected storage payload is too large')

    let untrustedPayload: unknown
    try {
      untrustedPayload = JSON.parse(plaintext) as unknown
    }
    catch {
      throw new Error('Protected storage payload is not valid JSON')
    }

    const parsed = safeParse(protectedStoragePayloadSchema, untrustedPayload)
    if (!parsed.success)
      throw new Error('Protected storage payload has an invalid schema')

    const entries = Object.entries(parsed.output.entries)
    if (entries.length > MAX_ENTRY_COUNT)
      throw new Error('Protected storage contains too many entries')

    for (const [key, value] of entries) {
      validateEntry(key, value)
      this.#entries.set(key, value)
    }
  }

  /** Returns a copy of the current authoritative credential state. */
  snapshot(): ProtectedStorageSnapshot {
    this.#assertInitialized()
    return {
      entries: Object.fromEntries(this.#entries),
      persistence: this.#persistence,
    }
  }

  /**
   * Returns only credentials intentionally shared with trusted AIRI renderers.
   *
   * Use when:
   * - Serving the protected-storage renderer snapshot IPC request.
   *
   * Expects:
   * - Main-only credentials use the reserved `main/` key namespace.
   *
   * Returns:
   * - A copy that excludes every Main-owned server, TLS, and bot credential.
   */
  snapshotForRenderer(): ProtectedStorageSnapshot {
    this.#assertInitialized()
    return {
      entries: Object.fromEntries(
        [...this.#entries].filter(([key]) => isRendererVisibleKey(key)),
      ),
      persistence: this.#persistence,
    }
  }

  /** Returns one serialized value without exposing the mutable entry map. */
  getItem(key: string): string | null {
    this.#assertInitialized()
    validateKey(key)
    return this.#entries.get(key) ?? null
  }

  /** Validates, updates, and schedules persistence of one serialized value. */
  setItem(key: string, value: string): Promise<void> {
    this.#assertInitialized()
    validateEntry(key, value)
    if (!this.#entries.has(key) && this.#entries.size >= MAX_ENTRY_COUNT)
      throw new Error('Protected storage contains too many entries')

    this.#entries.set(key, value)
    return this.#scheduleWrite()
  }

  /** Removes one value and schedules persistence of the resulting state. */
  removeItem(key: string): Promise<void> {
    this.#assertInitialized()
    validateKey(key)
    if (!this.#entries.delete(key))
      return Promise.resolve()
    return this.#scheduleWrite()
  }

  /** Waits for every encrypted file write already accepted by the store. */
  async flush(): Promise<void> {
    await this.#writeQueue
  }

  #assertInitialized(): void {
    if (!this.#initialized)
      throw new Error('Protected storage has not been initialized')
  }

  #scheduleWrite(): Promise<void> {
    if (this.#persistence === 'memory-only')
      return Promise.resolve()

    const plaintext = JSON.stringify({
      version: 1,
      entries: Object.fromEntries(this.#entries),
    })
    if (Buffer.byteLength(plaintext) > MAX_PLAINTEXT_BYTES)
      throw new Error('Protected storage payload is too large')

    const write = this.#writeQueue
      .catch(() => {})
      .then(() => this.#writeProtectedPayload(plaintext))
    this.#writeQueue = write
    return write
  }

  async #writeProtectedPayload(plaintext: string): Promise<void> {
    const ciphertext = this.#cipher.protect(plaintext)
    if (ciphertext.byteLength > MAX_CIPHERTEXT_BYTES)
      throw new Error('Protected storage ciphertext is too large')

    const directory = dirname(this.#filePath)
    // The directory and file permissions limit passive reads before OS-backed
    // encryption is considered. Windows ignores POSIX mode bits safely.
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await chmod(directory, 0o700)

    // A random same-directory temporary name prevents predictable symlink races;
    // rename then replaces the target atomically on supported desktop filesystems.
    const temporaryPath = join(directory, `.secrets-${randomUUID()}.tmp`)
    try {
      await writeFile(temporaryPath, ciphertext, { flag: 'wx', mode: 0o600 })
      await chmod(temporaryPath, 0o600)
      await rename(temporaryPath, this.#filePath)
      await chmod(this.#filePath, 0o600)
    }
    catch (error) {
      await unlink(temporaryPath).catch(() => {})
      throw error
    }
  }
}

function validateEntry(key: string, value: string): void {
  validateKey(key)
  if (Buffer.byteLength(value) > MAX_VALUE_BYTES)
    throw new Error('Protected storage value is too large')
}

function validateKey(key: string): void {
  if (
    Buffer.byteLength(key) === 0
    || Buffer.byteLength(key) > MAX_KEY_BYTES
    || !PROTECTED_STORAGE_KEY_PATTERN.test(key)
  ) {
    throw new Error('Invalid protected storage key')
  }
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error
    && 'code' in error
    && error.code === 'ENOENT'
}
