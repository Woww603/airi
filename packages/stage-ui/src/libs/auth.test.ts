import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const authClientMocks = vi.hoisted(() => ({
  getSession: vi.fn(),
}))

const apiMocks = vi.hoisted(() => ({
  getFlux: vi.fn(),
}))

vi.mock('better-auth/vue', () => ({
  createAuthClient: () => authClientMocks,
}))

vi.mock('../composables/api', () => ({
  client: {
    api: {
      v1: {
        flux: {
          $get: apiMocks.getFlux,
        },
      },
    },
  },
}))

vi.mock('@proj-airi/stage-shared', () => ({
  isStageTamagotchi: () => true,
}))

class MemoryStorage implements Storage {
  private readonly store = new Map<string, string>()

  get length() {
    return this.store.size
  }

  clear() {
    this.store.clear()
  }

  getItem(key: string) {
    return this.store.get(key) ?? null
  }

  key(index: number) {
    return Array.from(this.store.keys())[index] ?? null
  }

  removeItem(key: string) {
    this.store.delete(key)
  }

  setItem(key: string, value: string) {
    this.store.set(key, value)
  }
}

class MockStorageEvent {
  constructor(
    readonly type: string,
    readonly init?: StorageEventInit,
  ) {}
}

function createMemoryStorage(): Storage {
  return new MemoryStorage()
}

/**
 * @example
 * describe('initializeAuth', () => {})
 */
describe('initializeAuth', () => {
  beforeEach(() => {
    vi.resetModules()
    setActivePinia(createPinia())
    const localStorage = createMemoryStorage()
    vi.stubGlobal('Storage', MemoryStorage)
    vi.stubGlobal('StorageEvent', MockStorageEvent)
    vi.stubGlobal('localStorage', localStorage)
    vi.stubGlobal('window', {
      addEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
      localStorage,
      removeEventListener: vi.fn(),
    })
    vi.stubGlobal('document', {})
    authClientMocks.getSession.mockReset()
    authClientMocks.getSession.mockResolvedValue({
      data: {
        user: { id: 'user-1' },
        session: { id: 'session-1' },
      },
    })
    apiMocks.getFlux.mockReset()
    apiMocks.getFlux.mockResolvedValue({ ok: false })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  /**
   * @example
   * it('recovers Electron refresh sessions missing an OIDC client id', () => {})
   */
  it('recovers Electron refresh sessions missing an OIDC client id', async () => {
    localStorage.setItem('auth/v1/token', JSON.stringify('access-token'))
    localStorage.setItem('auth/v1/refresh-token', JSON.stringify('refresh-token'))
    localStorage.setItem('auth/v1/oidc-token-expiry', String(Date.now() + 60_000))

    const { initializeAuth } = await import('./auth')

    await initializeAuth()

    // @example
    expect(localStorage.getItem('auth/v1/oidc-client-id')).toBe('airi-stage-electron')
    // @example
    expect(localStorage.getItem('auth/v1/refresh-token')).toBe(JSON.stringify('refresh-token'))
    // @example
    expect(authClientMocks.getSession).toHaveBeenCalledOnce()
  })
})
