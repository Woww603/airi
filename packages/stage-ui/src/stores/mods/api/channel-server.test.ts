import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'

const serverSdkMocks = vi.hoisted(() => {
  class MockClient {
    static instances: MockClient[] = []
    static constructorError: Error | undefined
    static onEventError: Error | undefined

    readonly listeners = new Map<string, Set<(event: any) => void | Promise<void>>>()
    readonly sent: any[] = []
    closeCalls = 0
    throwOnOffEventType?: string

    constructor(public readonly options: Record<string, any>) {
      if (MockClient.constructorError)
        throw MockClient.constructorError
      MockClient.instances.push(this)
    }

    onEvent(type: string, callback: (event: any) => void | Promise<void>) {
      if (MockClient.onEventError) {
        const error = MockClient.onEventError
        MockClient.onEventError = undefined
        throw error
      }

      let callbacks = this.listeners.get(type)
      if (!callbacks) {
        callbacks = new Set()
        this.listeners.set(type, callbacks)
      }

      callbacks.add(callback)

      return () => {
        this.offEvent(type, callback)
      }
    }

    offEvent(type: string, callback?: (event: any) => void | Promise<void>) {
      if (this.throwOnOffEventType === type)
        throw new Error('synthetic replay unsubscribe failure')

      const callbacks = this.listeners.get(type)
      if (!callbacks) {
        return
      }

      if (callback) {
        callbacks.delete(callback)
        if (!callbacks.size) {
          this.listeners.delete(type)
        }
        return
      }

      this.listeners.delete(type)
    }

    send(event: any) {
      this.sent.push(event)
      return true
    }

    close(code?: number, reason?: string) {
      this.closeCalls += 1
      this.options.onClose?.(code, reason)
    }

    emit(type: string, data: any) {
      const event = { type, data }
      for (const callback of this.listeners.get(type) ?? []) {
        void callback(event)
      }
    }

    simulateAuthenticated() {
      this.emit('module:authenticated', { authenticated: true })
    }

    simulateTransientDisconnect() {
      this.options.onClose?.(1005, '')
    }

    simulateClose(code?: number, reason?: string) {
      this.options.onClose?.(code, reason)
    }

    simulateReconnectReady() {
      this.options.onReady?.()
    }

    simulateError(error: unknown) {
      this.options.onError?.(error)
    }

    simulateStateChange(previousStatus: string, status: string) {
      this.options.onStateChange?.({ previousStatus, status })
    }
  }

  return {
    MockClient,
  }
})

const inspectorMocks = vi.hoisted(() => ({
  add: vi.fn(),
}))

vi.mock('@proj-airi/server-sdk', () => ({
  Client: serverSdkMocks.MockClient,
  WebSocketEventSource: {
    StageTamagotchi: 'proj-airi:stage-tamagotchi',
    StageWeb: 'proj-airi:stage-web',
  },
}))

vi.mock('@proj-airi/stage-shared', () => ({
  isStageTamagotchi: () => true,
  isStageWeb: () => false,
}))

vi.mock('@vueuse/core', async () => {
  const { ref } = await import('vue')
  const useStorage = (_key: string, initialValue: string) => ref(initialValue)

  return {
    useLocalStorage: useStorage,
    useStorage,
  }
})

vi.mock('../../devtools/websocket-inspector', () => ({
  useWebSocketInspectorStore: () => inspectorMocks,
}))

const { useModsServerChannelStore } = await import('./channel-server')

async function drainCurrentPromiseReactions() {
  // Pinia action instrumentation adds a fixed then/catch chain. Draining a
  // bounded set of microtasks observes premature fulfillment without using a
  // timer; a correct pending handshake remains unsettled throughout.
  for (let index = 0; index < 8; index += 1)
    await Promise.resolve()
}

describe('channel-server store reconnect', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    serverSdkMocks.MockClient.instances.length = 0
    serverSdkMocks.MockClient.constructorError = undefined
    serverSdkMocks.MockClient.onEventError = undefined
    inspectorMocks.add.mockClear()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  /**
   * @example
   * it('Discord audit R-001 keeps initial authentication pending', async () => {})
   */
  it('keeps the first initialize pending until authentication for Discord audit R-001', async () => {
    // ROOT CAUSE:
    //
    // initialize was async but did not return the stored initialization
    // Promise on its first path. The async wrapper therefore fulfilled on the
    // next microtask while the SDK handshake was still pending.
    //
    // Before: initialize assigned initializing.value and fell through.
    //
    // We fixed this by returning the exact stored lifecycle-attempt Promise.
    const store = useModsServerChannelStore()
    const initializePromise = store.initialize({ token: 'synthetic-r001-pending-token' })
    const client = serverSdkMocks.MockClient.instances[0]
    let settled = false
    void initializePromise.then(
      () => { settled = true },
      () => { settled = true },
    )

    await drainCurrentPromiseReactions()

    expect(settled).toBe(false)

    client.simulateAuthenticated()
    await initializePromise

    expect(settled).toBe(true)
    expect(store.connected).toBe(true)
  })

  /**
   * @example
   * it('Discord audit R-001 reuses one exact underlying initialize attempt', async () => {})
   */
  it('reuses one pending attempt across concurrent calls and recoverable errors for Discord audit R-001', async () => {
    // ROOT CAUSE:
    //
    // Returning initializing.value from an async function created another
    // adopting Promise. Pinia also instruments every public action Promise, so
    // public object identity cannot prove whether the underlying lock is shared.
    //
    // Before: async initialize() returned an async-wrapper Promise.
    //
    // We fixed initialize to return the stored underlying Promise and verify
    // sharing through one Client plus coordinated pending/settlement behavior.
    const store = useModsServerChannelStore()
    const consoleInfoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
    const firstInitialize = store.initialize({ token: 'synthetic-r001-shared-token' })
    const client = serverSdkMocks.MockClient.instances[0]
    let firstSettled = false
    let secondSettled = false
    void firstInitialize.then(
      () => { firstSettled = true },
      () => { firstSettled = true },
    )

    client.simulateError(new Error('synthetic recoverable transport failure'))
    const secondInitialize = store.initialize({ token: 'synthetic-r001-ignored-token' })
    void secondInitialize.then(
      () => { secondSettled = true },
      () => { secondSettled = true },
    )

    await drainCurrentPromiseReactions()

    expect(firstSettled).toBe(false)
    expect(secondSettled).toBe(false)
    expect(serverSdkMocks.MockClient.instances).toHaveLength(1)

    client.simulateAuthenticated()
    await firstInitialize
    await secondInitialize
    expect(firstSettled).toBe(true)
    expect(secondSettled).toBe(true)
    consoleInfoSpy.mockRestore()
  })

  /**
   * @example
   * it('Discord audit R-001 rejects a closed initial handshake and retries', async () => {})
   */
  it('rejects a closed initial handshake with a fixed error and allows retry for Discord audit R-001', async () => {
    // ROOT CAUSE:
    //
    // onClose cleared initializing.value without rejecting the Promise stored
    // in it. Explicit callers observed an already-fulfilled async wrapper while
    // the real attempt remained pending forever.
    //
    // Before: initializing.value = null.
    //
    // We fixed close to release then reject the exact active attempt once.
    const store = useModsServerChannelStore()
    const firstInitialize = store.initialize({ token: 'synthetic-r001-close-token' })
    const firstClient = serverSdkMocks.MockClient.instances[0]
    const firstClientCloseSpy = vi.spyOn(firstClient, 'close')
    const firstFailure = firstInitialize.catch(error => error)
    const secondInitialize = store.initialize({ token: 'synthetic-r001-ignored-close-token' })
    const secondFailure = secondInitialize.catch(error => error)

    expect(serverSdkMocks.MockClient.instances).toHaveLength(1)

    firstClient.simulateClose(1008, 'synthetic-r001-close-reason-sentinel')

    const [initializationError, concurrentInitializationError] = await Promise.all([firstFailure, secondFailure])
    expect(initializationError).toMatchObject({
      name: 'ChannelInitializationError',
      message: 'WebSocket channel initialization failed.',
    })
    expect(concurrentInitializationError).toBe(initializationError)
    expect(JSON.stringify(initializationError)).not.toContain('synthetic-r001-close-reason-sentinel')
    expect(firstClientCloseSpy).toHaveBeenCalledOnce()

    const retry = store.initialize({ token: 'synthetic-r001-retry-token' })
    const retryClient = serverSdkMocks.MockClient.instances[1]
    expect(retryClient).toBeDefined()

    retryClient.simulateAuthenticated()
    await retry
    expect(store.connected).toBe(true)
  })

  /**
   * @example
   * it('Discord audit R-001 rejects a terminal failed handshake and retries', async () => {})
   */
  it('rejects a terminal failed handshake and allows retry for Discord audit R-001', async () => {
    // ROOT CAUSE:
    //
    // terminal onStateChange released only the ref and never settled the
    // original attempt, making failure invisible to its explicit caller.
    //
    // Before: status failed assigned initializing.value = null.
    //
    // We fixed terminal failure with the same exact-attempt rejection boundary.
    const store = useModsServerChannelStore()
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const firstInitialize = store.initialize({ token: 'synthetic-r001-failed-token' })
    const firstClient = serverSdkMocks.MockClient.instances[0]
    const firstClientCloseSpy = vi.spyOn(firstClient, 'close')
    const failure = firstInitialize.catch(error => error)

    firstClient.simulateStateChange('authenticating', 'failed')

    await expect(failure).resolves.toMatchObject({
      name: 'ChannelInitializationError',
      message: 'WebSocket channel initialization failed.',
    })
    expect(firstClientCloseSpy).toHaveBeenCalledOnce()

    const retry = store.initialize({ token: 'synthetic-r001-failed-retry-token' })
    const retryClient = serverSdkMocks.MockClient.instances[1]
    retryClient.simulateAuthenticated()
    await retry

    expect(store.connected).toBe(true)
    consoleWarnSpy.mockRestore()
  })

  /**
   * @example
   * it('Discord audit R-001 cancels a disposed attempt without stale settlement', async () => {})
   */
  it('cancels a pending dispose and rejects stale generation callbacks for Discord audit R-001', async () => {
    // ROOT CAUSE:
    //
    // dispose discarded initializing.value without settling its Promise. A
    // late callback from that Client also closed over shared resolution state.
    //
    // Before: dispose assigned initializing.value = null and closed the Client.
    //
    // We fixed disposal by invalidating ownership, releasing the exact attempt,
    // then rejecting it with a fixed cancellation before replacement starts.
    const store = useModsServerChannelStore()
    const firstInitialize = store.initialize({ token: 'synthetic-r001-dispose-token' })
    const firstClient = serverSdkMocks.MockClient.instances[0]
    const cancellation = firstInitialize.catch(error => error)

    store.dispose()

    await expect(cancellation).resolves.toMatchObject({
      name: 'ChannelInitializationCancelledError',
      message: 'WebSocket channel initialization was cancelled.',
    })

    const replacement = store.initialize({ token: 'synthetic-r001-replacement-token' })
    const replacementClient = serverSdkMocks.MockClient.instances[1]
    let replacementSettled = false
    void replacement.then(
      () => { replacementSettled = true },
      () => { replacementSettled = true },
    )

    firstClient.simulateAuthenticated()
    firstClient.simulateReconnectReady()
    firstClient.simulateStateChange('reconnecting', 'failed')
    await Promise.resolve()

    expect(replacementSettled).toBe(false)
    expect(store.connected).toBe(false)

    replacementClient.simulateAuthenticated()
    await replacement
    expect(store.connected).toBe(true)
  })

  /**
   * @example
   * it('Discord audit R-001 preserves synchronous setup errors and retries', async () => {})
   */
  it('preserves a synchronous Client setup error and releases the attempt for Discord audit R-001', async () => {
    // ROOT CAUSE:
    //
    // synchronous Client setup ran inside an unreturned Promise executor. Its
    // rejection was disconnected from the public async wrapper and the retry
    // boundary was not explicit.
    //
    // Before: new Client() threw inside initializing.value = new Promise(...).
    //
    // We fixed setup to install the deferred attempt first, then reject that
    // same Promise with the original error after releasing the bad lock.
    const store = useModsServerChannelStore()
    const setupError = new Error('synthetic-r001-constructor-failure')
    serverSdkMocks.MockClient.constructorError = setupError

    await expect(store.initialize({ token: 'synthetic-r001-setup-token' })).rejects.toBe(setupError)

    serverSdkMocks.MockClient.constructorError = undefined
    const retry = store.initialize({ token: 'synthetic-r001-setup-retry-token' })
    const retryClient = serverSdkMocks.MockClient.instances[0]
    retryClient.simulateAuthenticated()

    await retry
    expect(store.connected).toBe(true)
  })

  /**
   * @example
   * it('Discord audit R-001 closes a Client whose listener setup fails', async () => {})
   */
  it('closes a Client after synchronous listener setup failure and allows retry for Discord audit R-001', async () => {
    // ROOT CAUSE:
    //
    // A Client can be constructed before its required lifecycle listeners are
    // registered. If registration throws, retaining that partially configured
    // Client leaves an external socket owner outside the initialization lock.
    //
    // Before: listener setup had no explicit lifecycle settlement boundary.
    //
    // We fixed setup failure by invalidating and closing the exact partial owner,
    // then rejecting the stored attempt with the original setup error.
    const store = useModsServerChannelStore()
    const setupError = new Error('synthetic-r001-listener-setup-failure')
    serverSdkMocks.MockClient.onEventError = setupError

    await expect(store.initialize({ token: 'synthetic-r001-listener-token' })).rejects.toBe(setupError)

    const failedClient = serverSdkMocks.MockClient.instances[0]
    expect(failedClient.closeCalls).toBe(1)

    const retry = store.initialize({ token: 'synthetic-r001-listener-retry-token' })
    const retryClient = serverSdkMocks.MockClient.instances[1]
    retryClient.simulateAuthenticated()

    await retry
    expect(store.connected).toBe(true)
  })

  /**
   * @example
   * it('Discord audit R-001 handles background initialize rejection', async () => {})
   */
  it('handles internal fire-and-forget initialization rejection without raw details for Discord audit R-001', async () => {
    // ROOT CAUSE:
    //
    // registerListener, send, and config watch discarded initialize(). Once the
    // public Promise correctly rejects, those internal call sites would create
    // unhandled rejections without an explicit fixed-category policy.
    //
    // Before: void initialize().
    //
    // We fixed every internal call site to attach the same sanitized rejection
    // handler while preserving rejection for explicit callers.
    const store = useModsServerChannelStore()
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    store.send({
      type: 'spark:notify',
      data: { message: 'synthetic-r001-background-input' },
    } as any)
    const client = serverSdkMocks.MockClient.instances[0]
    client.simulateClose(1008, 'synthetic-r001-background-close-sentinel')
    await Promise.resolve()

    expect(consoleWarnSpy).toHaveBeenCalledWith(
      'WebSocket channel initialization failed',
      { category: 'background-initialization-failed' },
    )
    expect(JSON.stringify(consoleWarnSpy.mock.calls)).not.toContain('synthetic-r001-background-close-sentinel')

    consoleWarnSpy.mockRestore()
  })

  /**
   * @example
   * it('Discord audit D-028 forwards only SDK observer events to Inspector', () => {})
   */
  it('reproduces Discord audit D-028 by wiring incoming and outgoing SDK observer events to the Inspector exactly once', () => {
    // ROOT CAUSE:
    //
    // channel-server is the production owner connecting Client observers to
    // Inspector history. Its callbacks must consume the SDK's redacted copy,
    // not bypass that observer boundary with a raw dispatch or wire payload.
    //
    // Before and after, channel-server uses onAnyMessage/onAnySend; the SDK now
    // guarantees those callback values are detached and redacted. This test
    // locks the owning wiring so a future raw-path shortcut cannot replace it.
    const store = useModsServerChannelStore()
    void store.initialize({ token: 'synthetic-d028-channel-token' })
    const client = serverSdkMocks.MockClient.instances[0]
    const incoming = {
      type: 'module:configure',
      data: { config: { token: '[REDACTED]', safeLabel: 'incoming' } },
      metadata: {
        source: { kind: 'plugin', plugin: { id: 'synthetic-server' }, id: 'server-d028' },
        event: { id: 'incoming-d028' },
      },
    }
    const outgoing = {
      type: 'ui:configure',
      data: {
        moduleName: 'synthetic-module',
        config: { botToken: '[REDACTED]', safeLabel: 'outgoing' },
      },
      metadata: {
        source: { kind: 'plugin', plugin: { id: 'synthetic-stage' }, id: 'stage-d028' },
        event: { id: 'outgoing-d028' },
      },
    }

    client.options.onAnyMessage(incoming)
    client.options.onAnySend(outgoing)

    expect(inspectorMocks.add).toHaveBeenCalledTimes(2)
    expect(inspectorMocks.add).toHaveBeenNthCalledWith(1, 'incoming', incoming)
    expect(inspectorMocks.add).toHaveBeenNthCalledWith(2, 'outgoing', outgoing)
  })

  /**
   * @example
   * it('Discord audit D-028 keeps replay listeners on raw dispatch events', () => {})
   */
  it('reproduces Discord audit D-028 by keeping immediate and replayed listeners on raw dispatch events', () => {
    // ROOT CAUSE:
    //
    // channel-server populated replayableEvents inside onAnyMessage. Once the
    // SDK made that callback diagnostic-safe, late onEvent subscribers received
    // the redacted observer copy instead of the real internally dispatched event.
    //
    // Before: onAnyMessage(event) both captured Inspector history and cached event.
    //
    // We fixed this by keeping onAnyMessage diagnostic-only and populating the
    // replay cache with an internal Client.onEvent listener on the raw path.
    const store = useModsServerChannelStore()
    void store.initialize({ token: 'synthetic-d028-channel-token' })
    const client = serverSdkMocks.MockClient.instances[0]
    const immediateListener = vi.fn()
    const lateListener = vi.fn()
    store.onEvent('registry:modules:sync', immediateListener)

    const observerEvent = {
      type: 'registry:modules:sync',
      data: {
        modules: [],
        diagnostics: { token: '[REDACTED]' },
      },
      metadata: {
        source: { kind: 'plugin', plugin: { id: 'synthetic-server' }, id: 'server-d028' },
        event: { id: 'sync-d028' },
      },
    }
    const rawData = {
      modules: [],
      diagnostics: { token: 'synthetic-d028-replay-token' },
    }

    client.options.onAnyMessage(observerEvent)
    client.emit('registry:modules:sync', rawData)
    store.onEvent('registry:modules:sync', lateListener)

    expect(inspectorMocks.add).toHaveBeenCalledWith('incoming', observerEvent)
    expect(JSON.stringify(inspectorMocks.add.mock.calls)).not.toContain('synthetic-d028-replay-token')
    expect(immediateListener).toHaveBeenCalledWith({
      type: 'registry:modules:sync',
      data: rawData,
    })
    expect(lateListener).toHaveBeenCalledWith({
      type: 'registry:modules:sync',
      data: rawData,
    })
  })

  /**
   * @example
   * it('Discord audit D-028 rejects stale replay callbacks after replacement', () => {})
   */
  it('reproduces Discord audit D-028 by rejecting stale replay callbacks after client replacement', async () => {
    // ROOT CAUSE:
    //
    // Internal replay listeners were never unsubscribed or tied to the Client
    // instance that installed them. An old Client could emit after dispose and
    // repopulate the shared cache with stale data owned by a replacement.
    //
    // Before: initialize registered anonymous raw listeners and dispose only
    // cleared replayableEvents.
    //
    // We fixed this with an exact Client/generation owner, stored unsubscribe
    // callbacks, exception-safe cleanup, and an identity guard in every callback.
    const store = useModsServerChannelStore()
    const clientAInitialization = store.initialize({ token: 'synthetic-d028-client-a-token' })
    const clientACancellation = clientAInitialization.catch(error => error)
    const clientA = serverSdkMocks.MockClient.instances[0]
    clientA.throwOnOffEventType = 'registry:modules:sync'
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    store.dispose()
    await expect(clientACancellation).resolves.toMatchObject({
      name: 'ChannelInitializationCancelledError',
      message: 'WebSocket channel initialization was cancelled.',
    })
    void store.initialize({ token: 'synthetic-d028-client-b-token' })
    const clientB = serverSdkMocks.MockClient.instances[1]

    clientA.emit('registry:modules:sync', {
      modules: [{ name: 'stale-client-a' }],
    })

    const subscriberAfterStaleA = vi.fn()
    store.onEvent('registry:modules:sync', subscriberAfterStaleA)

    expect(subscriberAfterStaleA).not.toHaveBeenCalled()

    const clientBData = {
      modules: [{ name: 'current-client-b' }],
    }
    clientB.emit('registry:modules:sync', clientBData)

    expect(subscriberAfterStaleA).toHaveBeenCalledWith({
      type: 'registry:modules:sync',
      data: clientBData,
    })

    const lateClientBSubscriber = vi.fn()
    store.onEvent('registry:modules:sync', lateClientBSubscriber)

    expect(lateClientBSubscriber).toHaveBeenCalledWith({
      type: 'registry:modules:sync',
      data: clientBData,
    })
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      'WebSocket channel cleanup failed',
      { failures: 1 },
    )

    consoleWarnSpy.mockRestore()
  })

  /**
   * @example
   * it('Discord audit D-028 continues dispose after ordinary listener cleanup fails', () => {})
   */
  it('reproduces Discord audit D-028 by continuing dispose after ordinary listener cleanup fails', async () => {
    // ROOT CAUSE:
    //
    // dispose called clearListeners before invalidating the replay owner. One
    // ordinary offEvent exception aborted replay cleanup, cache clearing, and
    // Client.close, leaving the old Client authoritative after replacement.
    //
    // Before: clearListeners(); disposeReplayListeners(); close().
    //
    // We fixed this by invalidating replay ownership first and independently
    // attempting every cleanup step while reporting only a fixed failure count.
    const store = useModsServerChannelStore()
    const clientAInitialization = store.initialize({ token: 'synthetic-d028-cleanup-client-a-token' })
    const clientACancellation = clientAInitialization.catch(error => error)
    const clientA = serverSdkMocks.MockClient.instances[0]
    const clientACloseSpy = vi.spyOn(clientA, 'close')
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const ordinaryListener = vi.fn()
    store.onEvent('input:text', ordinaryListener)
    clientA.throwOnOffEventType = 'input:text'

    expect(() => store.dispose()).not.toThrow()
    await expect(clientACancellation).resolves.toMatchObject({
      name: 'ChannelInitializationCancelledError',
      message: 'WebSocket channel initialization was cancelled.',
    })
    expect(clientACloseSpy).toHaveBeenCalledTimes(1)

    void store.initialize({ token: 'synthetic-d028-cleanup-client-b-token' })
    const clientB = serverSdkMocks.MockClient.instances[1]
    clientA.emit('input:text', {
      text: 'synthetic-stale-client-a-input',
    })

    expect(ordinaryListener).not.toHaveBeenCalled()

    clientA.emit('registry:modules:sync', {
      modules: [{ name: 'stale-cleanup-client-a' }],
    })

    const clientBSubscriber = vi.fn()
    store.onEvent('registry:modules:sync', clientBSubscriber)

    expect(clientBSubscriber).not.toHaveBeenCalled()

    const clientBData = {
      modules: [{ name: 'current-cleanup-client-b' }],
    }
    clientB.emit('registry:modules:sync', clientBData)
    clientB.emit('input:text', {
      text: 'synthetic-current-client-b-input',
    })

    expect(clientBSubscriber).toHaveBeenCalledWith({
      type: 'registry:modules:sync',
      data: clientBData,
    })
    expect(ordinaryListener).toHaveBeenCalledOnce()
    expect(ordinaryListener).toHaveBeenCalledWith({
      type: 'input:text',
      data: { text: 'synthetic-current-client-b-input' },
    })
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      'WebSocket channel cleanup failed',
      { failures: 1 },
    )

    consoleWarnSpy.mockRestore()
  })

  /**
   * @example
   * it('Discord audit D-028 rejects every stale Client lifecycle callback', () => {})
   */
  it('reproduces Discord audit D-028 by rejecting stale observer, authentication, and lifecycle callbacks after replacement', async () => {
    // ROOT CAUSE:
    //
    // Client option callbacks and the anonymous module:authenticated listener
    // closed over shared store state without an exact Client/generation owner.
    // A disposed Client could capture Inspector events, flush B's pending data,
    // install B listeners early, or toggle B's connected state.
    //
    // Before: callbacks directly mutated connected/initializing/replay state.
    //
    // We fixed this by assigning every internal callback and listener to one
    // exact Client owner and invalidating it before any external cleanup step.
    const store = useModsServerChannelStore()
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const clientAInitialization = store.initialize({ token: 'synthetic-d028-lifecycle-client-a-token' })
    const clientACancellation = clientAInitialization.catch(error => error)
    const clientA = serverSdkMocks.MockClient.instances[0]
    clientA.throwOnOffEventType = 'module:authenticated'
    store.send({
      type: 'spark:notify',
      data: { message: 'synthetic-d028-pending-for-client-b' },
    } as any)

    store.dispose()
    await expect(clientACancellation).resolves.toMatchObject({
      name: 'ChannelInitializationCancelledError',
      message: 'WebSocket channel initialization was cancelled.',
    })
    void store.initialize({ token: 'synthetic-d028-lifecycle-client-b-token' })
    const clientB = serverSdkMocks.MockClient.instances[1]
    const staleObserverEvent = {
      type: 'ui:configure',
      data: { config: { token: '[REDACTED]' } },
    }

    clientA.options.onAnyMessage(staleObserverEvent)
    clientA.options.onAnySend(staleObserverEvent)
    clientA.simulateAuthenticated()

    expect(inspectorMocks.add).not.toHaveBeenCalled()
    expect(store.connected).toBe(false)
    expect(store.pendingSendCount).toBe(1)
    expect(clientB.sent).toHaveLength(0)
    expect(clientB.listeners.has('input:text')).toBe(false)

    clientA.simulateReconnectReady()
    expect(store.connected).toBe(false)
    expect(clientB.sent).toHaveLength(0)

    clientA.simulateError(new Error('synthetic-d028-stale-client-error'))
    clientA.simulateStateChange('reconnecting', 'failed')
    clientA.simulateTransientDisconnect()
    expect(store.connected).toBe(false)
    expect(clientB.sent).toHaveLength(0)

    clientB.simulateAuthenticated()

    expect(store.connected).toBe(true)
    expect(store.pendingSendCount).toBe(0)
    expect(clientB.sent).toEqual([
      {
        type: 'spark:notify',
        data: { message: 'synthetic-d028-pending-for-client-b' },
      },
    ])

    clientB.options.onObserverError({
      category: 'observer-callback-failed',
      direction: 'incoming',
    })

    expect(store.connected).toBe(true)
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      'WebSocket observer diagnostic failed',
      {
        category: 'observer-callback-failed',
        direction: 'incoming',
        failures: 1,
      },
    )

    clientA.simulateTransientDisconnect()
    clientA.simulateStateChange('ready', 'failed')
    expect(store.connected).toBe(true)
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      'WebSocket channel cleanup failed',
      { failures: 1 },
    )

    consoleWarnSpy.mockRestore()
  })

  /**
   * @example
   * it('Discord audit D-028 clears replay state during terminal replacement', () => {})
   */
  it('reproduces Discord audit D-028 by clearing the terminal Client replay cache before installing its replacement', async () => {
    // ROOT CAUSE:
    //
    // A terminal SDK state released initializing without calling dispose. The
    // next initialize invalidated A's listeners but retained A's replay cache,
    // so a listener registered for B immediately consumed A-owned state.
    //
    // Before: replacement cleaned listeners and closed A but did not clear cache.
    //
    // We fixed replacement cleanup to clear replay state inside the same
    // exception-safe cleanup sequence before installing the next owner.
    const store = useModsServerChannelStore()
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const clientAInitialization = store.initialize({ token: 'synthetic-d028-terminal-client-a-token' })
    const clientAFailure = clientAInitialization.catch(error => error)
    const clientA = serverSdkMocks.MockClient.instances[0]
    clientA.emit('registry:modules:sync', {
      modules: [{ name: 'synthetic-stale-terminal-client-a' }],
    })
    clientA.simulateStateChange('reconnecting', 'failed')
    await expect(clientAFailure).resolves.toMatchObject({
      name: 'ChannelInitializationError',
      message: 'WebSocket channel initialization failed.',
    })

    void store.initialize({ token: 'synthetic-d028-terminal-client-b-token' })
    const clientB = serverSdkMocks.MockClient.instances[1]
    const clientBListener = vi.fn()
    store.onEvent('registry:modules:sync', clientBListener)

    expect(clientBListener).not.toHaveBeenCalled()

    const clientBData = {
      modules: [{ name: 'synthetic-current-terminal-client-b' }],
    }
    clientB.emit('registry:modules:sync', clientBData)

    expect(clientBListener).toHaveBeenCalledOnce()
    expect(clientBListener).toHaveBeenCalledWith({
      type: 'registry:modules:sync',
      data: clientBData,
    })
    expect(consoleWarnSpy).toHaveBeenCalledWith('WebSocket server connection failed')

    consoleWarnSpy.mockRestore()
  })

  /**
   * @example
   * it('Discord audit D-028 invalidates a listener before failed unsubscribe', () => {})
   */
  it('reproduces Discord audit D-028 by invalidating an individual listener when its unsubscribe cleanup fails', () => {
    // ROOT CAUSE:
    //
    // The listener disposer called offEvent without a cleanup error policy.
    // A transport cleanup exception escaped even though the binding had to be
    // irrevocably invalidated before that external operation.
    //
    // Before: binding?.owner.client.offEvent(...).
    //
    // We fixed the disposer to invalidate first, then report only the fixed
    // cleanup category/count while its stale wrapper rejects late delivery.
    const store = useModsServerChannelStore()
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    void store.initialize({ token: 'synthetic-d028-individual-listener-token' })
    const client = serverSdkMocks.MockClient.instances[0]
    const listener = vi.fn()
    const unsubscribe = store.onEvent('input:text', listener)
    client.throwOnOffEventType = 'input:text'

    expect(() => unsubscribe()).not.toThrow()
    client.emit('input:text', { text: 'synthetic-d028-late-after-unsubscribe' })

    expect(listener).not.toHaveBeenCalled()
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      'WebSocket channel cleanup failed',
      { failures: 1 },
    )

    consoleWarnSpy.mockRestore()
  })

  // Regression coverage for https://github.com/moeru-ai/airi/issues/1545
  it('issue #1545: restores connected state and flushes queued sends when the client reports ready after a reconnect', async () => {
    const store = useModsServerChannelStore()

    store.send({
      type: 'spark:notify',
      data: { message: 'before-init' },
    } as any)

    const initializePromise = store.initialize({ token: 'secret' })
    const client = serverSdkMocks.MockClient.instances[0]

    client.simulateAuthenticated()
    await initializePromise

    expect(store.connected).toBe(true)
    expect(store.pendingSendCount).toBe(0)
    expect(client.sent).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'spark:notify',
        data: { message: 'before-init' },
      }),
    ]))

    client.simulateTransientDisconnect()

    expect(store.connected).toBe(false)

    store.send({
      type: 'spark:notify',
      data: { message: 'queued-during-disconnect' },
    } as any)

    expect(store.pendingSendCount).toBe(1)

    client.simulateReconnectReady()

    expect(store.connected).toBe(true)
    expect(store.pendingSendCount).toBe(0)
    expect(client.sent).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'spark:notify',
        data: { message: 'queued-during-disconnect' },
      }),
    ]))
  })

  it('uses explicit heartbeat settings to avoid client/server timeout mismatch', async () => {
    const store = useModsServerChannelStore()

    const initializePromise = store.initialize({ token: 'secret' })
    const client = serverSdkMocks.MockClient.instances[0]

    client.simulateAuthenticated()
    await initializePromise

    expect(client.options.heartbeat).toEqual({
      readTimeout: 60_000,
      pingInterval: 20_000,
    })
  })

  it('notifies onReconnected callbacks when the websocket becomes ready again', async () => {
    const store = useModsServerChannelStore()
    const onReconnected = vi.fn()
    store.onReconnected(onReconnected)

    const initializePromise = store.initialize({ token: 'secret' })
    const client = serverSdkMocks.MockClient.instances[0]

    client.simulateAuthenticated()
    await initializePromise

    client.simulateTransientDisconnect()
    client.simulateReconnectReady()
    client.simulateReconnectReady()

    expect(onReconnected).toHaveBeenCalledTimes(1)
  })

  it('does not notify onReconnected on first authenticated->ready flow and only on subsequent ready events', async () => {
    const store = useModsServerChannelStore()
    const onReconnected = vi.fn()
    store.onReconnected(onReconnected)

    const initializePromise = store.initialize({ token: 'secret' })
    const client = serverSdkMocks.MockClient.instances[0]

    client.simulateAuthenticated()
    client.simulateReconnectReady()
    expect(onReconnected).toHaveBeenCalledTimes(0)

    client.simulateReconnectReady()
    expect(onReconnected).toHaveBeenCalledTimes(1)

    await initializePromise
  })

  it('continues invoking remaining onReconnected callbacks when one throws', async () => {
    const store = useModsServerChannelStore()
    const successfulCallback = vi.fn()
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    store.onReconnected(() => {
      throw new Error('boom')
    })
    store.onReconnected(successfulCallback)

    const initializePromise = store.initialize({ token: 'secret' })
    const client = serverSdkMocks.MockClient.instances[0]

    client.simulateAuthenticated()
    await initializePromise

    client.simulateTransientDisconnect()
    client.simulateReconnectReady()
    client.simulateReconnectReady()

    expect(successfulCallback).toHaveBeenCalledTimes(1)
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1)

    consoleErrorSpy.mockRestore()
  })

  /**
   * @example
   * it('Discord audit R-001 rejects the original closed handshake before retry', async () => {})
   */
  it('allows initialize retry after first handshake close before any successful connection', async () => {
    const store = useModsServerChannelStore()

    const firstInitializePromise = store.initialize({ token: 'invalid-token' })
    const firstFailure = firstInitializePromise.catch(error => error)
    const firstClient = serverSdkMocks.MockClient.instances[0]

    firstClient.simulateClose(1008, 'synthetic-r001-legacy-close-reason')

    const initializationError = await firstFailure
    expect(initializationError).toMatchObject({
      name: 'ChannelInitializationError',
      message: 'WebSocket channel initialization failed.',
    })
    expect(JSON.stringify(initializationError)).not.toContain('synthetic-r001-legacy-close-reason')

    const secondInitializePromise = store.initialize({ token: 'valid-token' })
    const secondClient = serverSdkMocks.MockClient.instances[1]

    expect(secondInitializePromise).not.toBe(firstInitializePromise)
    expect(secondClient).toBeDefined()

    secondClient.simulateAuthenticated()
    await secondInitializePromise

    expect(store.connected).toBe(true)
  })

  it('allows initialize retry when sdk enters failed after a previous successful connection', async () => {
    const store = useModsServerChannelStore()

    const firstInitializePromise = store.initialize({ token: 'secret' })
    const firstClient = serverSdkMocks.MockClient.instances[0]

    firstClient.simulateAuthenticated()
    await firstInitializePromise

    firstClient.simulateStateChange('reconnecting', 'failed')

    const secondInitializePromise = store.initialize({ token: 'secret-rotated' })
    const secondClient = serverSdkMocks.MockClient.instances[1]

    expect(secondInitializePromise).not.toBe(firstInitializePromise)
    expect(secondClient).toBeDefined()

    secondClient.simulateAuthenticated()
    await secondInitializePromise

    expect(store.connected).toBe(true)
  })

  it('keeps the initialize lock on recoverable onError so auto-reconnect does not spawn a second client', () => {
    const store = useModsServerChannelStore()
    const consoleDebugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {})

    const firstInitializePromise = store.initialize({ token: 'secret' })
    const firstClient = serverSdkMocks.MockClient.instances[0]

    firstClient.simulateError(new Error('temporary websocket glitch'))

    const secondInitializePromise = store.initialize({ token: 'secret' })

    expect(secondInitializePromise).toBeInstanceOf(Promise)
    expect(firstInitializePromise).toBeInstanceOf(Promise)
    expect(serverSdkMocks.MockClient.instances).toHaveLength(1)

    consoleDebugSpy.mockRestore()
  })

  it('does not flush queued events on reconnect authenticated before ready', async () => {
    const store = useModsServerChannelStore()

    const initializePromise = store.initialize({ token: 'secret' })
    const client = serverSdkMocks.MockClient.instances[0]

    client.simulateAuthenticated()
    await initializePromise
    client.simulateReconnectReady()

    client.simulateTransientDisconnect()

    store.send({
      type: 'spark:notify',
      data: { message: 'reconnect-authenticated-queued' },
    } as any)

    expect(store.pendingSendCount).toBe(1)

    client.simulateAuthenticated()

    expect(store.connected).toBe(false)
    expect(store.pendingSendCount).toBe(1)

    client.simulateReconnectReady()

    expect(store.connected).toBe(true)
    expect(store.pendingSendCount).toBe(0)
    expect(client.sent).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'spark:notify',
        data: { message: 'reconnect-authenticated-queued' },
      }),
    ]))
  })

  it('does not reconnect while the url scheme is not valid', async () => {
    const store = useModsServerChannelStore()

    const initializePromise = store.initialize({ token: 'secret' })
    const firstClient = serverSdkMocks.MockClient.instances[0]

    firstClient.simulateAuthenticated()
    await initializePromise

    store.websocketUrl = 'wss:'
    await nextTick()

    expect(serverSdkMocks.MockClient.instances).toHaveLength(1)

    store.websocketUrl = 'wss://192.168.123.112:6121/ws'
    await nextTick()

    expect(serverSdkMocks.MockClient.instances).toHaveLength(2)
  })

  it('uses the persisted websocket auth token when initialize does not receive an explicit token', async () => {
    const store = useModsServerChannelStore()
    store.websocketAuthToken = 'persisted-secret'

    const initializePromise = store.initialize()
    const client = serverSdkMocks.MockClient.instances[0]

    expect(client.options.token).toBe('persisted-secret')

    client.simulateAuthenticated()
    await initializePromise
  })

  it('reconnects when the persisted websocket auth token changes', async () => {
    const store = useModsServerChannelStore()
    store.websocketAuthToken = 'initial-secret'

    const initializePromise = store.initialize()
    const firstClient = serverSdkMocks.MockClient.instances[0]

    firstClient.simulateAuthenticated()
    await initializePromise

    store.websocketAuthToken = 'rotated-secret'
    await nextTick()

    expect(serverSdkMocks.MockClient.instances.length).toBeGreaterThan(1)
    expect(serverSdkMocks.MockClient.instances.at(-1)?.options.token).toBe('rotated-secret')
  })
})
