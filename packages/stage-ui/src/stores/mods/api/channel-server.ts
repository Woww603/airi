import type {
  ContextUpdate,
  InputContextUpdate,
  WebSocketBaseEvent,
  WebSocketEvent,
  WebSocketEventOptionalSource,
  WebSocketEvents,
  WebSocketLikeConstructor,
} from '@proj-airi/server-sdk'
import type { CommonContentPart } from '@xsai/shared-chat'

import { Client, WebSocketEventSource } from '@proj-airi/server-sdk'
import { isStageTamagotchi, isStageWeb } from '@proj-airi/stage-shared'
import { useSensitiveStorage } from '@proj-airi/stage-shared/composables'
import { useLocalStorage } from '@vueuse/core'
import { nanoid } from 'nanoid'
import { defineStore } from 'pinia'
import { computed, ref, shallowRef, watch } from 'vue'

import { useWebSocketInspectorStore } from '../../devtools/websocket-inspector'

interface ChannelListenerEntry {
  type: keyof WebSocketEvents
  callback: (event: WebSocketBaseEvent<any, any>) => void | Promise<void>
  binding?: ChannelListenerBinding
}

interface ChannelClientOwner {
  client: Client
  generation: number
  internalUnsubscribers: Array<() => void>
}

interface ChannelInitializationAttempt {
  owner?: ChannelClientOwner
  promise: Promise<void>
  reject: (reason?: unknown) => void
  resolve: () => void
  settled: boolean
}

interface ChannelListenerBinding {
  owner: ChannelClientOwner
  callback: (event: WebSocketBaseEvent<any, any>) => void | Promise<void>
}

class ChannelInitializationError extends Error {
  constructor() {
    super('WebSocket channel initialization failed.')
    this.name = 'ChannelInitializationError'
  }
}

class ChannelInitializationCancelledError extends Error {
  constructor() {
    super('WebSocket channel initialization was cancelled.')
    this.name = 'ChannelInitializationCancelledError'
  }
}

function hasReconnectableWebSocketScheme(url: string | undefined) {
  if (!url) {
    return false
  }

  try {
    const parsedUrl = new URL(url)
    return parsedUrl.protocol === 'ws:' || parsedUrl.protocol === 'wss:'
  }
  catch {
    return false
  }
}

const REPLAYABLE_EVENT_TYPES = new Set<keyof WebSocketEvents>([
  'module:announced',
  'module:de-announced',
  'registry:modules:health:healthy',
  'registry:modules:health:unhealthy',
  'registry:modules:sync',
])

export const useModsServerChannelStore = defineStore('mods:channels:proj-airi:server', () => {
  const connected = ref(false)
  const client = shallowRef<Client>()
  const initializing = shallowRef<ChannelInitializationAttempt | null>(null)
  const websocketConstructor = ref<WebSocketLikeConstructor>()
  const hasEverConnected = ref(false)
  const pendingSend = ref<Array<WebSocketEvent>>([])
  const pendingSendCount = computed(() => pendingSend.value.length)
  const reconnectedCallbacks = new Set<() => void>()
  let clientOwnerGeneration = 0
  let clientOwner: ChannelClientOwner | undefined

  const defaultWebSocketUrl = import.meta.env.VITE_AIRI_WS_URL || 'ws://localhost:6121/ws'
  const websocketUrl = useLocalStorage('settings/connection/websocket-url', defaultWebSocketUrl)
  const websocketAuthToken = useSensitiveStorage('settings/connection/websocket-auth-token', '')
  const registeredListeners: ChannelListenerEntry[] = []
  const replayableEvents = new Map<keyof WebSocketEvents, WebSocketBaseEvent<any, any>>()

  const basePossibleEvents: Array<keyof WebSocketEvents> = [
    'context:update',
    'error',
    'module:announce',
    'module:announced',
    'module:configure',
    'module:de-announced',
    'module:consumer:register',
    'module:consumer:unregister',
    'module:authenticated',
    'registry:modules:health:healthy',
    'registry:modules:health:unhealthy',
    'registry:modules:sync',
    'spark:notify',
    'spark:emit',
    'spark:command',
    'discord:memory:command',
    'discord:memory:command:result',
    'input:text',
    'input:text:voice',
    'output:gen-ai:chat:message',
    'output:gen-ai:chat:complete',
    'output:gen-ai:chat:tool-call',
    'ui:configure',
  ]

  function recoverConnectedStateFromReadyClient() {
    const owner = clientOwner
    const attempt = initializing.value
    if (!owner || !attempt || !isActiveInitializationOwner(attempt, owner) || !owner.client.isReady)
      return false

    const wasConnected = connected.value
    hasEverConnected.value = true
    connected.value = true
    initializeListeners()

    if (!wasConnected)
      flush()

    return true
  }

  function isActiveClientOwner(owner: ChannelClientOwner) {
    return clientOwner === owner
      && client.value === owner.client
      && clientOwner.generation === owner.generation
  }

  function isActiveInitializationOwner(attempt: ChannelInitializationAttempt, owner: ChannelClientOwner) {
    return initializing.value === attempt
      && attempt.owner === owner
      && isActiveClientOwner(owner)
  }

  function createInitializationAttempt(): ChannelInitializationAttempt {
    const { promise, reject, resolve } = Promise.withResolvers<void>()
    return {
      promise,
      reject,
      resolve,
      settled: false,
    }
  }

  function resolveInitializationAttempt(attempt: ChannelInitializationAttempt, owner: ChannelClientOwner) {
    if (!isActiveInitializationOwner(attempt, owner) || attempt.settled)
      return false

    attempt.settled = true
    attempt.resolve()
    return true
  }

  function rejectInitializationAttempt(attempt: ChannelInitializationAttempt | null, error: unknown) {
    if (!attempt || initializing.value !== attempt)
      return false

    // Release authority before rejecting. Promise reactions may synchronously
    // request a replacement on their next microtask and must see no stale lock.
    initializing.value = null
    if (attempt.settled)
      return true

    attempt.settled = true
    attempt.reject(error)
    return true
  }

  function takeClientOwner(owningClient?: Client) {
    const owner = clientOwner
    if (!owner || (owningClient && owner.client !== owningClient))
      return

    // Invalidate every callback before external cleanup so a failed unsubscribe
    // cannot retain authority over a replacement Client or its replay cache.
    clientOwner = undefined
    clientOwnerGeneration += 1

    return owner
  }

  function unsubscribeInternalListeners(owner: ChannelClientOwner | undefined) {
    let failures = 0
    for (const unsubscribe of owner?.internalUnsubscribers ?? []) {
      try {
        unsubscribe()
      }
      catch {
        failures += 1
      }
    }

    return failures
  }

  function failInitializationOwner(
    attempt: ChannelInitializationAttempt,
    owner: ChannelClientOwner,
    error: ChannelInitializationError,
  ) {
    if (!isActiveInitializationOwner(attempt, owner))
      return

    // Retire transport authority before closing. Client.close() may synchronously
    // invoke lifecycle callbacks, and those stale callbacks must be inert.
    const failedOwner = takeClientOwner(owner.client)
    if (client.value === owner.client)
      client.value = undefined
    connected.value = false

    let cleanupFailures = clearListeners()
    cleanupFailures += unsubscribeInternalListeners(failedOwner)
    try {
      replayableEvents.clear()
    }
    catch {
      cleanupFailures += 1
    }
    try {
      owner.client.close()
    }
    catch {
      cleanupFailures += 1
    }

    rejectInitializationAttempt(attempt, error)
    if (cleanupFailures > 0)
      console.warn('WebSocket channel cleanup failed', { failures: cleanupFailures })
  }

  function bindInternalListeners(owner: ChannelClientOwner, attempt: ChannelInitializationAttempt) {
    try {
      for (const eventType of REPLAYABLE_EVENT_TYPES) {
        owner.internalUnsubscribers.push(owner.client.onEvent(eventType, (event) => {
          if (!isActiveInitializationOwner(attempt, owner))
            return

          replayableEvents.set(eventType, event as WebSocketBaseEvent<any, any>)
        }))
      }

      owner.internalUnsubscribers.push(owner.client.onEvent('module:authenticated', (event) => {
        if (!isActiveInitializationOwner(attempt, owner))
          return

        if (event.data.authenticated) {
          if (!hasEverConnected.value) {
            // First connection can flush immediately after authentication.
            connected.value = true
            flush()
            initializeListeners()
          }
          // On reconnect, wait for onReady (after announce) before flushing business events.
          resolveInitializationAttempt(attempt, owner)

          return
        }

        connected.value = false
      }))
    }
    catch (error) {
      const failedOwner = takeClientOwner(owner.client)
      if (client.value === owner.client)
        client.value = undefined
      let cleanupFailures = unsubscribeInternalListeners(failedOwner)
      try {
        replayableEvents.clear()
      }
      catch {
        cleanupFailures += 1
      }
      try {
        owner.client.close()
      }
      catch {
        cleanupFailures += 1
      }
      if (cleanupFailures > 0)
        console.warn('WebSocket channel cleanup failed', { failures: cleanupFailures })
      throw error
    }
  }

  function initialize(options?: {
    token?: string
    possibleEvents?: Array<keyof WebSocketEvents>
    websocketConstructor?: WebSocketLikeConstructor
  }): Promise<void> {
    if (initializing.value)
      return initializing.value.promise
    if (connected.value && client.value)
      return Promise.resolve()

    if (options?.websocketConstructor) {
      websocketConstructor.value = options.websocketConstructor
    }

    const possibleEvents = Array.from(new Set<keyof WebSocketEvents>([
      ...basePossibleEvents,
      ...(options?.possibleEvents ?? []),
    ]))

    const attempt = createInitializationAttempt()
    initializing.value = attempt
    try {
      const previousOwner = takeClientOwner()
      if (previousOwner && client.value === previousOwner.client)
        client.value = undefined
      let previousCleanupFailures = clearListeners()
      previousCleanupFailures += unsubscribeInternalListeners(previousOwner)
      try {
        replayableEvents.clear()
      }
      catch {
        previousCleanupFailures += 1
      }
      if (previousOwner) {
        try {
          previousOwner.client.close()
        }
        catch {
          previousCleanupFailures += 1
        }
      }
      if (previousCleanupFailures > 0)
        console.warn('WebSocket channel cleanup failed', { failures: previousCleanupFailures })

      let owner: ChannelClientOwner | undefined
      const owningClient = new Client({
        name: isStageWeb() ? WebSocketEventSource.StageWeb : isStageTamagotchi() ? WebSocketEventSource.StageTamagotchi : WebSocketEventSource.StageWeb,
        url: websocketUrl.value || defaultWebSocketUrl,
        token: options?.token ?? (websocketAuthToken.value || undefined),
        websocketConstructor: websocketConstructor.value,
        heartbeat: {
          // Keep client and server heartbeat windows aligned to reduce false-positive disconnects.
          readTimeout: 60_000,
          pingInterval: 20_000,
        },
        possibleEvents,
        onAnyMessage: (event) => {
          if (!owner || !isActiveInitializationOwner(attempt, owner))
            return

          useWebSocketInspectorStore().add('incoming', event)
        },
        onAnySend: (event) => {
          if (!owner || !isActiveInitializationOwner(attempt, owner))
            return

          useWebSocketInspectorStore().add('outgoing', event)
        },
        onObserverError: ({ category, direction }) => {
          if (!owner || !isActiveInitializationOwner(attempt, owner))
            return

          console.warn('WebSocket observer diagnostic failed', {
            category,
            direction,
            failures: 1,
          })
        },
        onError: () => {
          if (!owner || !isActiveInitializationOwner(attempt, owner))
            return

          connected.value = false
          // Do not clear listeners or replay cache here.
          // onError may be recoverable while the SDK is reconnecting.
          if (import.meta.env.DEV) {
            console.info('WebSocket server connection error:', {
              category: 'recoverable-transport-error',
            })
          }
        },
        onClose: () => {
          if (!owner || !isActiveInitializationOwner(attempt, owner))
            return

          connected.value = false

          if (!attempt.settled)
            failInitializationOwner(attempt, owner, new ChannelInitializationError())
          // Runtime disconnect: keep initialize/listeners for SDK auto-reconnect.
          // Terminal failure: handled by onStateChange status === 'failed'.
        },
        onStateChange: ({ status }) => {
          if (!owner || !isActiveInitializationOwner(attempt, owner))
            return

          if (status === 'failed') {
            // SDK entered terminal state (auth terminal / retries exhausted / autoReconnect disabled).
            failInitializationOwner(attempt, owner, new ChannelInitializationError())
            console.warn('WebSocket server connection failed')
          }
        },
        onReady: () => {
          if (!owner || !isActiveInitializationOwner(attempt, owner))
            return

          const isReconnect = hasEverConnected.value

          hasEverConnected.value = true
          connected.value = true
          flush()
          initializeListeners()

          if (isReconnect) {
            for (const callback of reconnectedCallbacks) {
              try {
                callback()
              }
              catch (error) {
                console.error('Error in reconnected callback:', error)
              }
            }
          }
          if (isReconnect && import.meta.env.DEV) {
            // eslint-disable-next-line no-console
            console.debug('WebSocket server connection re-established')
          }
        },
      })

      owner = {
        client: owningClient,
        generation: ++clientOwnerGeneration,
        internalUnsubscribers: [],
      }
      client.value = owningClient
      clientOwner = owner
      attempt.owner = owner
      bindInternalListeners(owner, attempt)
    }
    catch (error) {
      rejectInitializationAttempt(attempt, error)
    }

    return attempt.promise
  }

  function initializeInBackground() {
    void initialize().catch(() => {
      console.warn('WebSocket channel initialization failed', {
        category: 'background-initialization-failed',
      })
    })
  }

  async function ensureConnected() {
    await initializing.value?.promise
    if (recoverConnectedStateFromReadyClient())
      return

    if (!connected.value) {
      return await initialize()
    }
  }

  function clearListeners() {
    let failures = 0
    for (const listener of registeredListeners) {
      const binding = listener.binding
      listener.binding = undefined
      if (binding) {
        try {
          binding.owner.client.offEvent(listener.type, binding.callback as any)
        }
        catch {
          failures += 1
        }
      }
    }

    return failures
  }

  function initializeListeners() {
    const owner = clientOwner
    if (!owner || !isActiveClientOwner(owner))
      return

    let cleanupFailures = 0
    for (const listener of registeredListeners) {
      if (listener.binding?.owner === owner)
        continue

      const previousBinding = listener.binding
      listener.binding = undefined
      if (previousBinding) {
        try {
          previousBinding.owner.client.offEvent(listener.type, previousBinding.callback as any)
        }
        catch {
          cleanupFailures += 1
        }
      }

      const binding: ChannelListenerBinding = {
        owner,
        callback: (event) => {
          if (listener.binding !== binding || !isActiveClientOwner(owner))
            return

          return listener.callback(event)
        },
      }
      listener.binding = binding
      try {
        owner.client.onEvent(listener.type, binding.callback as any)
      }
      catch (error) {
        if (listener.binding === binding)
          listener.binding = undefined
        throw error
      }
    }

    if (cleanupFailures > 0)
      console.warn('WebSocket channel cleanup failed', { failures: cleanupFailures })
  }

  function registerListener<E extends keyof WebSocketEvents>(
    type: E,
    callback: (event: WebSocketBaseEvent<E, WebSocketEvents[E]>) => void | Promise<void>,
  ) {
    if (!client.value && !initializing.value)
      initializeInBackground()

    const entry: ChannelListenerEntry = {
      type,
      callback: callback as any,
    }
    registeredListeners.push(entry)
    initializeListeners()

    const replayableEvent = replayableEvents.get(type)
    if (replayableEvent)
      void Promise.resolve(callback(replayableEvent as WebSocketBaseEvent<E, WebSocketEvents[E]>))

    return () => {
      const index = registeredListeners.indexOf(entry)
      if (index >= 0)
        registeredListeners.splice(index, 1)

      const binding = entry.binding
      entry.binding = undefined
      if (binding) {
        try {
          binding.owner.client.offEvent(type, binding.callback as any)
        }
        catch {
          console.warn('WebSocket channel cleanup failed', { failures: 1 })
        }
      }
    }
  }

  function send<C = undefined>(data: WebSocketEventOptionalSource<C>) {
    if (!client.value && !initializing.value)
      initializeInBackground()

    recoverConnectedStateFromReadyClient()

    if (client.value && connected.value) {
      client.value.send(data as WebSocketEvent)
    }
    else {
      pendingSend.value.push(data as WebSocketEvent)
    }
  }

  function flush(owningClient = client.value, isConnected = connected.value) {
    if (owningClient && isConnected) {
      for (const update of pendingSend.value) {
        owningClient.send(update)
      }

      pendingSend.value = []
    }
  }

  function onContextUpdate(callback: (event: WebSocketBaseEvent<'context:update', ContextUpdate>) => void | Promise<void>) {
    return registerListener('context:update', callback)
  }

  function onEvent<E extends keyof WebSocketEvents>(
    type: E,
    callback: (event: WebSocketBaseEvent<E, WebSocketEvents[E]>) => void | Promise<void>,
  ) {
    return registerListener(type, callback)
  }

  function onReconnected(callback: () => void) {
    reconnectedCallbacks.add(callback)

    return () => {
      reconnectedCallbacks.delete(callback)
    }
  }

  function sendContextUpdate(message: InputContextUpdate) {
    const id = nanoid()
    send({
      type: 'context:update',
      data: { id, contextId: id, ...message },
    } as WebSocketEventOptionalSource<string | CommonContentPart[]>)
  }

  function dispose() {
    const attempt = initializing.value
    const owningClient = client.value
    const wasConnected = connected.value
    const owner = takeClientOwner(owningClient)

    // Linearize disposal before invoking any external callback. Every callback
    // below may throw, but none may restore authority to this Client generation.
    if (client.value === owningClient)
      client.value = undefined
    hasEverConnected.value = false
    connected.value = false
    rejectInitializationAttempt(attempt, new ChannelInitializationCancelledError())
    let failures = 0

    try {
      flush(owningClient, wasConnected)
    }
    catch {
      failures += 1
    }

    failures += clearListeners()
    failures += unsubscribeInternalListeners(owner)

    try {
      replayableEvents.clear()
    }
    catch {
      failures += 1
    }

    if (owningClient) {
      try {
        owningClient.close()
      }
      catch {
        failures += 1
      }
    }

    if (failures > 0)
      console.warn('WebSocket channel cleanup failed', { failures })
  }

  watch([websocketUrl, websocketAuthToken], ([newUrl, newToken], [oldUrl, oldToken]) => {
    if (newUrl === oldUrl && newToken === oldToken)
      return

    if (!hasReconnectableWebSocketScheme(newUrl))
      return

    if (client.value || initializing.value) {
      dispose()
      initializeInBackground()
    }
  })

  return {
    connected,
    pendingSendCount,
    websocketAuthToken,
    websocketUrl,
    ensureConnected,

    initialize,
    send,
    sendContextUpdate,
    onContextUpdate,
    onEvent,
    onReconnected,
    getPendingSendSnapshot: () => [...pendingSend.value],
    dispose,
  }
})
