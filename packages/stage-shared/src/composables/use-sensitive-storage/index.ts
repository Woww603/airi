import type {
  ManualResetRefReturn,
  RemovableRef,
  StorageLike,
  UseStorageOptions,
} from '@vueuse/core'
import type { MaybeRefOrGetter, WatchOptions } from 'vue'

import type { ElectronSecureStorageAPI } from '../../window'

import { customStorageEventName, refManualReset, useStorage } from '@vueuse/core'
import { unref, watch } from 'vue'

const sensitiveStorageKeys = [
  'artistry-nanobanana-api-key',
  'artistry-provider-options',
  'artistry-replicate-api-key',
  'auth/v1/id-token',
  'auth/v1/oidc-id-token',
  'auth/v1/refresh-token',
  'auth/v1/session',
  'auth/v1/token',
  'auth/v1/user',
  'settings/connection/websocket-auth-token',
  'settings/credentials/providers',
  'settings/discord/token',
  'settings/server-channel/auth-token',
  'settings/server-channel/websocket-tls-config',
  'settings/twitter/access-token',
  'settings/twitter/access-token-secret',
  'settings/twitter/api-key',
  'settings/twitter/api-secret',
] as const

let activeStorage: StorageLike | undefined
let initialization: Promise<void> | undefined

class ElectronSensitiveStorage implements StorageLike {
  readonly #bridge: ElectronSecureStorageAPI
  readonly #entries = new Map<string, string>()

  constructor(bridge: ElectronSecureStorageAPI, entries: Record<string, string>) {
    this.#bridge = bridge
    for (const [key, value] of Object.entries(entries))
      this.#entries.set(key, value)
  }

  getItem(key: string): string | null {
    return this.#entries.get(key) ?? null
  }

  removeItem(key: string): void {
    this.#entries.delete(key)
    void this.#bridge.removeItem(key).catch(() => {
      console.error('Failed to remove a protected AIRI setting.')
    })
  }

  setItem(key: string, value: string): void {
    this.#entries.set(key, value)
    void this.#bridge.setItem(key, value).catch(() => {
      console.error('Failed to persist a protected AIRI setting.')
    })
  }

  applyRemoteChange(change: { key: string, newValue: string | null }): void {
    const oldValue = this.getItem(change.key)
    if (change.newValue === null)
      this.#entries.delete(change.key)
    else
      this.#entries.set(change.key, change.newValue)

    if (oldValue === change.newValue || typeof window === 'undefined' || typeof CustomEvent === 'undefined')
      return

    window.dispatchEvent(new CustomEvent(customStorageEventName, {
      detail: {
        key: change.key,
        newValue: change.newValue,
        oldValue,
        storageArea: this,
      },
    }))
  }
}

/**
 * Initializes the renderer credential backend before Vue and Pinia are mounted.
 *
 * Use when:
 * - Bootstrapping stage-web or stage-tamagotchi
 * - Migrating existing Electron plaintext credentials exactly once
 *
 * Expects:
 * - Electron exposes the narrow `window.electron.secureStorage` preload API
 * - Browser builds provide ordinary localStorage
 *
 * Returns:
 * - A promise that resolves only after desktop plaintext migration completes
 */
export function initializeSensitiveStorage(): Promise<void> {
  if (initialization)
    return initialization

  initialization = initialize()
  return initialization
}

async function initialize(): Promise<void> {
  const bridge = resolveElectronSecureStorage()
  if (!bridge) {
    activeStorage = resolveLocalStorage()
    return
  }

  const snapshot = await bridge.getSnapshot()
  const storage = new ElectronSensitiveStorage(bridge, snapshot.entries)
  activeStorage = storage

  bridge.subscribe(change => storage.applyRemoteChange(change))

  const localStorage = resolveLocalStorage()
  for (const key of sensitiveStorageKeys) {
    const plaintextValue = localStorage?.getItem(key)
    const protectedValue = storage.getItem(key)

    if (protectedValue === null && plaintextValue != null) {
      await bridge.setItem(key, plaintextValue)
      storage.applyRemoteChange({ key, newValue: plaintextValue })
    }

    if (plaintextValue != null)
      localStorage?.removeItem(key)
  }
}

/**
 * Creates a VueUse ref backed by protected storage on Electron.
 *
 * Use when:
 * - Persisting auth tokens, provider credentials, private keys, or API secrets
 *
 * Expects:
 * - Application entrypoints await {@link initializeSensitiveStorage} before mounting
 *
 * Returns:
 * - A reactive ref with the same serialization semantics as VueUse `useStorage`
 */
export function useSensitiveStorage<T>(
  key: MaybeRefOrGetter<string>,
  initialValue: MaybeRefOrGetter<T>,
  options?: UseStorageOptions<T>,
): RemovableRef<T> {
  return useStorage<T>(key, initialValue, resolveActiveStorage(), options)
}

/**
 * Creates a manually resettable ref backed by protected storage on Electron.
 *
 * Use when:
 * - A sensitive settings field needs VueUse manual-reset behavior
 *
 * Expects:
 * - Application entrypoints await {@link initializeSensitiveStorage} before mounting
 *
 * Returns:
 * - A manual-reset ref synchronized with the protected backend
 */
export function useSensitiveStorageManualReset<T>(
  key: MaybeRefOrGetter<string>,
  initialValue: MaybeRefOrGetter<T>,
  options?: UseStorageOptions<T> & WatchOptions,
): ManualResetRefReturn<T> {
  const value = unref(initialValue)
  const persistedState = useSensitiveStorage<T>(key, value, options)
  const state = refManualReset<T>(persistedState)

  const { resume, pause } = watch(state, newValue => persistedState.value = newValue, options)
  watch(persistedState, (newValue) => {
    pause()
    state.value = newValue
    resume()
  }, options)

  return state
}

/** Returns one raw serialized sensitive value without requiring Pinia. */
export function getSensitiveStorageItem(key: string): string | null {
  return resolveActiveStorage()?.getItem(key) ?? null
}

function resolveActiveStorage(): StorageLike | undefined {
  return activeStorage ?? resolveLocalStorage()
}

function resolveLocalStorage(): Storage | undefined {
  if (typeof window === 'undefined')
    return undefined
  return window.localStorage
}

function resolveElectronSecureStorage(): ElectronSecureStorageAPI | undefined {
  if (typeof window === 'undefined' || !('electron' in window))
    return undefined

  const electronWindow = window as Window & { electron?: { secureStorage?: ElectronSecureStorageAPI } }
  return electronWindow.electron?.secureStorage
}
