import { afterEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'

class MemoryStorage implements Storage {
  readonly #items = new Map<string, string>()

  get length(): number {
    return this.#items.size
  }

  clear(): void {
    this.#items.clear()
  }

  getItem(key: string): string | null {
    return this.#items.get(key) ?? null
  }

  key(index: number): string | null {
    return Array.from(this.#items.keys())[index] ?? null
  }

  removeItem(key: string): void {
    this.#items.delete(key)
  }

  setItem(key: string, value: string): void {
    this.#items.set(key, value)
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

/**
 * Migrates desktop secrets out of Chromium localStorage before Vue mounts.
 *
 * @example
 * describe('useSensitiveStorage', () => {
 *   expect(localStorage.getItem('auth/v1/token')).toBeNull()
 * })
 */
describe('useSensitiveStorage', () => {
  /**
   * Reproduces and removes the raw localStorage credential exposure.
   *
   * @example
   * it('migrates plaintext Electron secrets into protected storage', async () => {})
   */
  it('migrates plaintext Electron secrets into protected storage', async () => {
    const localStorage = new MemoryStorage()
    const protectedEntries = new Map<string, string>()
    const listeners = new Set<(change: { key: string, newValue: string | null }) => void>()
    localStorage.setItem('auth/v1/token', 'plaintext-access-token')

    const secureStorage = {
      getSnapshot: vi.fn(async () => ({ entries: {}, persistence: 'protected' as const })),
      removeItem: vi.fn(async (key: string) => protectedEntries.delete(key)),
      setItem: vi.fn(async (key: string, value: string) => protectedEntries.set(key, value)),
      subscribe: vi.fn((listener: (change: { key: string, newValue: string | null }) => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      }),
    }
    vi.stubGlobal('localStorage', localStorage)
    vi.stubGlobal('window', {
      addEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
      electron: { secureStorage },
      localStorage,
      removeEventListener: vi.fn(),
    })
    vi.stubGlobal('Storage', MemoryStorage)

    const { initializeSensitiveStorage, useSensitiveStorage } = await import('.')
    await initializeSensitiveStorage()
    const token = useSensitiveStorage<string | null>('auth/v1/token', null)

    // ROOT CAUSE:
    //
    // useAuthStore and provider/module stores wrote secrets through
    // useLocalStorage, leaving plaintext in Chromium's profile database.
    // The desktop bootstrap now moves known sensitive keys into the protected
    // main-process store before any Pinia store is created.
    // @example
    expect(localStorage.getItem('auth/v1/token')).toBeNull()
    // @example
    expect(protectedEntries.get('auth/v1/token')).toBe('plaintext-access-token')
    // @example
    expect(token.value).toBe('plaintext-access-token')

    token.value = 'rotated-access-token'
    await nextTick()

    // @example
    expect(secureStorage.setItem).toHaveBeenLastCalledWith('auth/v1/token', 'rotated-access-token')
  })
})
