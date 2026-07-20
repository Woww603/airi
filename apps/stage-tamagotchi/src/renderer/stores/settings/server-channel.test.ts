import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick, ref } from 'vue'

const invokeMocks = vi.hoisted(() => {
  const getConfig = vi.fn(async () => ({
    authToken: 'existing-token',
    hostname: '127.0.0.1',
    tlsConfig: null,
  }))
  const applyConfig = vi.fn(async (config: unknown) => config)

  return {
    applyConfig,
    getConfig,
  }
})

vi.mock('@proj-airi/electron-vueuse', () => ({
  useElectronEventaInvoke: (event: { receiveEvent?: { id?: string } }) => {
    if (event?.receiveEvent?.id === 'eventa:invoke:electron:server-channel:get-config-receive')
      return invokeMocks.getConfig
    if (event?.receiveEvent?.id === 'eventa:invoke:electron:server-channel:apply-config-receive')
      return invokeMocks.applyConfig

    throw new Error(`Unexpected eventa invoke: ${JSON.stringify(event)}`)
  },
}))

vi.mock('@vueuse/core', () => ({
  useLocalStorage: <T>(key: string, initialValue: T) => {
    if (key === 'settings/server-channel/hostname')
      return ref('127.0.0.1')
    if (key === 'settings/server-channel/auth-token')
      return ref('existing-token')
    if (key === 'settings/server-channel/websocket-tls-config')
      return ref(null)

    return ref(initialValue)
  },
}))

vi.mock('@proj-airi/stage-shared/composables', () => ({
  useSensitiveStorage: <T>(key: string, initialValue: T) => {
    if (key === 'settings/server-channel/auth-token')
      return ref('existing-token')
    if (key === 'settings/server-channel/websocket-tls-config')
      return ref(null)

    return ref(initialValue)
  },
}))

const toastError = vi.fn()

vi.mock('vue-sonner', () => ({
  toast: {
    error: toastError,
  },
}))

/**
 * @example
 * describe('useServerChannelSettingsStore', () => {})
 */
describe('useServerChannelSettingsStore', async () => {
  const { useServerChannelSettingsStore } = await import('./server-channel')

  beforeEach(() => {
    setActivePinia(createPinia())
    invokeMocks.getConfig.mockClear()
    invokeMocks.applyConfig.mockClear()
    toastError.mockClear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  /**
   * @example
   * it('does not write a server-originated configuration back to the server', async () => {})
   */
  it('does not write a server-originated configuration back to the server', async () => {
    invokeMocks.getConfig.mockResolvedValueOnce({
      authToken: 'server-token',
      hostname: '0.0.0.0',
      tlsConfig: null,
    })

    const store = useServerChannelSettingsStore()
    await store.refreshServerChannelConfig()

    await vi.waitFor(() => {
      // @example
      expect(store.authToken).toBe('server-token')
      // @example
      expect(store.hostname).toBe('0.0.0.0')
      // @example
      expect(store.tlsConfig).toBeNull()
    })
    await nextTick()

    // ROOT CAUSE:
    //
    // The old implementation cleared syncingWithServer before Vue flushed the watcher.
    // The watcher then treated values read from the main process as renderer edits and
    // applied them back to the server, creating an unbounded restart loop.
    //
    // We fixed this by tracking the last authoritative server snapshot and ignoring
    // watcher callbacks whose complete configuration matches that snapshot.
    // @example
    expect(invokeMocks.applyConfig).not.toHaveBeenCalled()
  })

  /**
   * @example
   * it('rolls back optimistic values when applying server channel config fails', async () => {})
   */
  it('rolls back optimistic values when applying server channel config fails', async () => {
    invokeMocks.applyConfig.mockRejectedValueOnce(new Error('apply failed'))

    const store = useServerChannelSettingsStore()
    await store.refreshServerChannelConfig()

    store.hostname = '0.0.0.0'
    store.authToken = 'next-token'
    store.tlsConfig = {}
    await nextTick()

    await vi.waitFor(() => {
      // @example
      expect(store.hostname).toBe('127.0.0.1')
      // @example
      expect(store.authToken).toBe('existing-token')
      // @example
      expect(store.tlsConfig).toBeNull()
      // @example
      expect(store.lastApplyError).toBe('apply failed')
      // @example
      expect(toastError).toHaveBeenCalledWith('apply failed')
    })
  })
})
