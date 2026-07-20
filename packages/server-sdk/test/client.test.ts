import type { WebSocketEvent, WebSocketEventOf } from '@proj-airi/server-shared/types'

import superjson from 'superjson'

import { afterEach, describe, expect, it, vi } from 'vitest'

class MockWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3

  static instances: MockWebSocket[] = []

  readonly sent: Array<string | ArrayBufferLike | ArrayBufferView<ArrayBufferLike>> = []
  readyState = MockWebSocket.CONNECTING
  onclose?: () => void
  onerror?: (event: { error?: Error } | unknown) => void
  onmessage?: (event: { data: string | ArrayBufferLike | ArrayBufferView<ArrayBufferLike> }) => void
  onopen?: () => void

  constructor(public readonly url: string) {
    MockWebSocket.instances.push(this)
  }

  send(data: string | ArrayBufferLike | ArrayBufferView<ArrayBufferLike>) {
    this.sent.push(data)
  }

  close() {
    this.readyState = MockWebSocket.CLOSED
    this.onclose?.()
  }

  ping() {}
  pong() {}
}

class InjectedMockWebSocket extends MockWebSocket {
  static instances: InjectedMockWebSocket[] = []

  constructor(url: string) {
    super(url)
    InjectedMockWebSocket.instances.push(this)
  }
}

vi.mock('crossws/websocket', () => ({
  default: MockWebSocket,
}))

const { Client } = await import('../src/client')

const SYNTHETIC_PAIRING_TOKEN = 'synthetic-d028-pairing-token-sentinel'
const SYNTHETIC_BOT_TOKEN = 'synthetic-d028-bot-token-sentinel'
const SYNTHETIC_NESTED_SECRET = 'synthetic-d028-nested-secret-sentinel'
const SYNTHETIC_URL_QUERY_SECRET = 'synthetic-d028-url-query-secret-sentinel'

function lastSocket() {
  const socket = MockWebSocket.instances.at(-1)
  if (!socket) {
    throw new Error('No mock websocket instance created')
  }

  return socket
}

function parseSent(socket: MockWebSocket, index = -1) {
  const payload = socket.sent.at(index)
  if (!payload) {
    throw new Error(`No sent payload at index ${index}`)
  }
  if (typeof payload === 'string') {
    return superjson.parse<WebSocketEvent>(payload)
  }

  const textDecoder = new TextDecoder()
  const decoded = textDecoder.decode(payload)

  return superjson.parse<WebSocketEvent>(decoded)
}

function emitOpen(socket: MockWebSocket) {
  socket.readyState = MockWebSocket.OPEN
  socket.onopen?.()
}

function emitMessage(socket: MockWebSocket, event: WebSocketEvent) {
  socket.onmessage?.({
    data: superjson.stringify(event),
  })
}

function acceptAuthentication(socket: MockWebSocket): WebSocketEventOf<'module:announce'> {
  const authenticationEvent = parseSent(socket)
  if (authenticationEvent.type !== 'module:authenticate')
    throw new Error('Client did not authenticate before announcing')

  emitMessage(socket, {
    type: 'module:authenticated',
    data: { authenticated: true },
    metadata: {
      source: { kind: 'plugin', plugin: { id: 'server' }, id: 'server-1' },
      event: { id: 'auth-1' },
    },
  })

  return parseSent(socket) as WebSocketEventOf<'module:announce'>
}

afterEach(() => {
  MockWebSocket.instances.length = 0
  InjectedMockWebSocket.instances.length = 0
  vi.useRealTimers()
})

describe('client', () => {
  /**
   * @example
   * it('Discord audit R-001 owns automatic connection task rejection', async () => {})
   */
  it('owns automatic connection task rejection during lifecycle close for Discord audit R-001', async () => {
    // ROOT CAUSE:
    //
    // Client started constructor and reconnect work with `void this.connect()`.
    // Closing a pending socket rejected that discarded Promise after the normal
    // onError/state callbacks, escaping the Client as an unhandled rejection.
    //
    // Before: every automatic connect launch discarded its returned Promise.
    //
    // We fixed this by retaining and observing each internal connection task;
    // the existing onError/lastError/state lifecycle remains the failure channel.
    const transportErrors = vi.fn()
    const unhandledRejections: unknown[] = []
    const captureUnhandledRejection = (reason: unknown) => {
      unhandledRejections.push(reason)
    }
    let client: Client | undefined

    // Node emits unhandledRejection at the end of the current event-loop turn.
    // The listener and setImmediate boundary observe that exact process contract
    // without a timing delay or a real network transport.
    process.on('unhandledRejection', captureUnhandledRejection)
    try {
      client = new Client({
        name: 'synthetic-r001-auto-connect-owner',
        onClose: () => client?.close(),
        onError: transportErrors,
      })
      const socket = lastSocket()
      socket.readyState = MockWebSocket.CLOSED
      socket.onclose?.()

      await new Promise<void>(resolve => setImmediate(resolve))

      // @example
      expect(unhandledRejections).toEqual([])
      // @example
      expect(transportErrors).toHaveBeenCalledOnce()
      // @example
      expect(transportErrors).toHaveBeenCalledWith(expect.objectContaining({
        message: 'Client closed',
      }))
      // @example
      expect(client.connectionStatus).toBe('closed')
      // @example
      expect(client.lastError).toEqual(expect.objectContaining({
        message: 'Client closed',
      }))
    }
    finally {
      process.removeListener('unhandledRejection', captureUnhandledRejection)
      client?.close()
    }
  })

  /**
   * @example
   * it('Discord audit R-001 owns reconnect task rejection during lifecycle close', async () => {})
   */
  it('owns automatic reconnect task rejection during lifecycle close for Discord audit R-001', async () => {
    // ROOT CAUSE:
    //
    // Ready-socket close and protocol recovery used the same discarded connect
    // pattern as constructor auto-connect. Stopping during the replacement
    // handshake therefore escaped through a second unhandled rejection path.
    //
    // Before: reconnect callbacks invoked `void this.connect()`.
    //
    // We fixed all automatic launch sites to share the Client-owned task slot.
    const transportErrors = vi.fn()
    const unhandledRejections: unknown[] = []
    const captureUnhandledRejection = (reason: unknown) => {
      unhandledRejections.push(reason)
    }
    const client = new Client({
      autoConnect: false,
      autoReconnect: true,
      name: 'synthetic-r001-reconnect-owner',
      onError: transportErrors,
    })

    const connecting = client.connect()
    const initialSocket = lastSocket()
    emitOpen(initialSocket)
    const announceEvent = acceptAuthentication(initialSocket)
    emitMessage(initialSocket, {
      type: 'module:announced',
      data: {
        name: 'synthetic-r001-reconnect-owner',
        identity: announceEvent.data.identity,
      },
      metadata: {
        source: { kind: 'plugin', plugin: { id: 'synthetic-server' }, id: 'synthetic-server-r001' },
        event: { id: 'synthetic-r001-announced' },
      },
    })
    await connecting

    process.on('unhandledRejection', captureUnhandledRejection)
    try {
      initialSocket.readyState = MockWebSocket.CLOSED
      initialSocket.onclose?.()
      const reconnectSocket = lastSocket()

      // @example
      expect(reconnectSocket).not.toBe(initialSocket)

      client.close()
      await new Promise<void>(resolve => setImmediate(resolve))

      // @example
      expect(unhandledRejections).toEqual([])
      // @example
      expect(transportErrors).toHaveBeenCalledOnce()
      // @example
      expect(client.connectionStatus).toBe('closed')
      // @example
      expect(client.lastError).toEqual(expect.objectContaining({
        message: 'Client closed',
      }))
    }
    finally {
      process.removeListener('unhandledRejection', captureUnhandledRejection)
      client.close()
    }
  })

  /**
   * @example
   * it('Discord audit D-028 keeps outgoing observer payloads redacted and detached', () => {})
   */
  it('reproduces Discord audit D-028 by keeping outgoing observer payloads redacted and detached while the wire receives the real payload', async () => {
    // ROOT CAUSE:
    //
    // Client.send passed the same payload object to onAnySend and the websocket.
    // The observer therefore received authentication/config secrets, and an
    // Inspector callback could mutate the production frame before serialization.
    //
    // Before: onAnySend(payload); websocket.send(stringify(payload)).
    //
    // We fixed this at the SDK observer boundary by producing a deeply detached,
    // deterministically redacted observer event while retaining the real wire event.
    const observed: WebSocketEvent[] = []
    const client = new Client({
      autoConnect: false,
      autoReconnect: false,
      name: 'synthetic-d028-plugin',
      token: SYNTHETIC_PAIRING_TOKEN,
      onAnySend: (event) => {
        observed.push(event)
        if (event.type === 'ui:configure') {
          const config = event.data.config as Record<string, unknown>
          config.safeLabel = 'observer-mutated'
        }
      },
    })

    const connecting = client.connect()
    const socket = lastSocket()
    emitOpen(socket)

    const authenticationWireEvent = parseSent(socket)
    const authenticationObserverEvent = observed.at(-1)

    expect(JSON.stringify(authenticationWireEvent)).toContain(SYNTHETIC_PAIRING_TOKEN)
    expect(JSON.stringify(authenticationObserverEvent)).not.toContain(SYNTHETIC_PAIRING_TOKEN)
    expect(authenticationObserverEvent).toMatchObject({
      type: 'module:authenticate',
      data: {
        token: '[REDACTED]',
        module: { name: 'synthetic-d028-plugin' },
      },
      metadata: {
        source: { kind: 'plugin', plugin: { id: 'synthetic-d028-plugin' } },
        event: { id: expect.any(String) },
      },
    })

    const recordedAt = new Date('2026-07-15T12:00:00.000Z')
    const diagnosticMap = new Map<string, unknown>([
      ['token', SYNTHETIC_NESTED_SECRET],
      ['tokenCount', 23],
      ['secretary', 'ordinary-map-field'],
    ])
    const sent = client.send({
      type: 'ui:configure',
      data: {
        moduleName: 'synthetic-d028-target',
        config: {
          safeLabel: 'wire-original',
          tokenCount: 17,
          maxTokens: 4096,
          secretary: 'ordinary-field',
          authorizationUrl: 'https://synthetic.invalid/authorize',
          token: {
            action: 'replace',
            value: SYNTHETIC_NESTED_SECRET,
          },
          diagnostics: {
            recordedAt,
            values: diagnosticMap,
          },
          nested: [{
            'BOT_TOKEN': SYNTHETIC_BOT_TOKEN,
            'auth-token': SYNTHETIC_NESTED_SECRET,
            'authentication_token': SYNTHETIC_NESTED_SECRET,
            'access-token': SYNTHETIC_NESTED_SECRET,
            'refresh token': SYNTHETIC_NESTED_SECRET,
            'Bearer.Token': SYNTHETIC_NESTED_SECRET,
            'API-Token': SYNTHETIC_NESTED_SECRET,
            'OAuth/Token': SYNTHETIC_NESTED_SECRET,
            'discord.token': SYNTHETIC_NESTED_SECRET,
            'Webhook:Token': SYNTHETIC_NESTED_SECRET,
            'Api_Key': SYNTHETIC_NESTED_SECRET,
            'AUTHORIZATION': SYNTHETIC_NESTED_SECRET,
            'password': SYNTHETIC_NESTED_SECRET,
            'client-secret': SYNTHETIC_NESTED_SECRET,
            'secret.key': SYNTHETIC_NESTED_SECRET,
            'private_key': SYNTHETIC_NESTED_SECRET,
            'Signing Key': SYNTHETIC_NESTED_SECRET,
            'openaiApiKey': SYNTHETIC_NESTED_SECRET,
            'dashscope-api-key': SYNTHETIC_NESTED_SECRET,
            'tts_api_key': SYNTHETIC_NESTED_SECRET,
            'oauthAccessToken': SYNTHETIC_NESTED_SECRET,
            'apiSecret': SYNTHETIC_NESTED_SECRET,
            'awsSecretKey': SYNTHETIC_NESTED_SECRET,
            'provider_secret_key': SYNTHETIC_NESTED_SECRET,
            'access_key_secret': SYNTHETIC_NESTED_SECRET,
            'webhook:secret': SYNTHETIC_NESTED_SECRET,
            'websocketAuthToken': SYNTHETIC_NESTED_SECRET,
          }],
        },
      },
    })

    expect(sent).toBe(true)

    const configureWireEvent = parseSent(socket)
    const configureObserverEvent = observed.at(-1)
    const serializedObserver = JSON.stringify(configureObserverEvent)

    expect(JSON.stringify(configureWireEvent)).toContain(SYNTHETIC_BOT_TOKEN)
    expect(JSON.stringify(configureWireEvent)).toContain(SYNTHETIC_NESTED_SECRET)
    expect(configureWireEvent).toMatchObject({
      data: { config: { safeLabel: 'wire-original' } },
    })
    expect(serializedObserver).not.toContain(SYNTHETIC_BOT_TOKEN)
    expect(serializedObserver).not.toContain(SYNTHETIC_NESTED_SECRET)
    expect(configureObserverEvent).toMatchObject({
      type: 'ui:configure',
      data: {
        config: {
          safeLabel: 'observer-mutated',
          tokenCount: 17,
          maxTokens: 4096,
          secretary: 'ordinary-field',
          authorizationUrl: 'https://synthetic.invalid/authorize',
          token: '[REDACTED]',
          nested: [{
            'BOT_TOKEN': '[REDACTED]',
            'auth-token': '[REDACTED]',
            'authentication_token': '[REDACTED]',
            'access-token': '[REDACTED]',
            'refresh token': '[REDACTED]',
            'Bearer.Token': '[REDACTED]',
            'API-Token': '[REDACTED]',
            'OAuth/Token': '[REDACTED]',
            'discord.token': '[REDACTED]',
            'Webhook:Token': '[REDACTED]',
            'Api_Key': '[REDACTED]',
            'AUTHORIZATION': '[REDACTED]',
            'password': '[REDACTED]',
            'client-secret': '[REDACTED]',
            'secret.key': '[REDACTED]',
            'private_key': '[REDACTED]',
            'Signing Key': '[REDACTED]',
            'openaiApiKey': '[REDACTED]',
            'dashscope-api-key': '[REDACTED]',
            'tts_api_key': '[REDACTED]',
            'oauthAccessToken': '[REDACTED]',
            'apiSecret': '[REDACTED]',
            'awsSecretKey': '[REDACTED]',
            'provider_secret_key': '[REDACTED]',
            'access_key_secret': '[REDACTED]',
            'webhook:secret': '[REDACTED]',
            'websocketAuthToken': '[REDACTED]',
          }],
        },
      },
    })

    if (configureObserverEvent?.type !== 'ui:configure')
      throw new Error('Expected observed ui:configure event')
    if (configureWireEvent.type !== 'ui:configure')
      throw new Error('Expected wire ui:configure event')

    const observerConfig = configureObserverEvent.data.config as Record<string, unknown>
    const observerDiagnostics = observerConfig.diagnostics as Record<string, unknown>
    const observerMap = observerDiagnostics.values as Map<string, unknown>
    const wireConfig = configureWireEvent.data.config as Record<string, unknown>
    const wireDiagnostics = wireConfig.diagnostics as Record<string, unknown>
    const wireMap = wireDiagnostics.values as Map<string, unknown>

    expect(observerDiagnostics.recordedAt).toEqual(recordedAt)
    expect(observerDiagnostics.recordedAt).not.toBe(recordedAt)
    expect(observerMap).not.toBe(diagnosticMap)
    expect(observerMap.get('token')).toBe('[REDACTED]')
    expect(observerMap.get('tokenCount')).toBe(23)
    expect(observerMap.get('secretary')).toBe('ordinary-map-field')
    expect(wireMap.get('token')).toBe(SYNTHETIC_NESTED_SECRET)

    client.close()
    await expect(connecting).rejects.toThrow('Client closed')
  })

  /**
   * ROOT CAUSE:
   *
   * Key-based observer redaction does not inspect an ordinary string value that
   * happens to be a URL. Secret query parameters therefore reached public
   * onAnySend observers even while header and nested-object secrets were masked.
   *
   * @example
   * it('redacts secret query parameters from public outgoing observer URLs without changing the wire', async () => {})
   */
  it('redacts secret query parameters from public outgoing observer URLs without changing the wire', async () => {
    const observed: WebSocketEvent[] = []
    const client = new Client({
      autoConnect: false,
      autoReconnect: false,
      name: 'synthetic-d028-url-plugin',
      onAnySend: event => observed.push(event),
    })
    const event = {
      type: 'ui:configure',
      data: {
        moduleName: 'synthetic-d028-url-module',
        config: {
          callbackUrl: `https://callback.synthetic.invalid/return?token=${SYNTHETIC_URL_QUERY_SECRET}&authorization=${SYNTHETIC_URL_QUERY_SECRET}&state=visible`,
          endpoint: `https://service.synthetic.invalid/v1/events?access_token=${SYNTHETIC_URL_QUERY_SECRET}&api_key=${SYNTHETIC_URL_QUERY_SECRET}&safe=visible`,
          headers: {
            'Authorization': `Bearer ${SYNTHETIC_URL_QUERY_SECRET}`,
            'X-Api-Key': SYNTHETIC_URL_QUERY_SECRET,
            'X-Request-Id': 'visible',
          },
          query: {
            access_token: SYNTHETIC_URL_QUERY_SECRET,
            api_key: SYNTHETIC_URL_QUERY_SECRET,
            page: 3,
          },
        },
      },
    } satisfies WebSocketEvent

    const connecting = client.connect()
    const socket = lastSocket()
    emitOpen(socket)
    expect(client.send(event)).toBe(true)

    const observerEvent = observed.at(-1)
    const wireEvent = parseSent(socket)
    expect(JSON.stringify(observerEvent)).not.toContain(SYNTHETIC_URL_QUERY_SECRET)
    if (observerEvent?.type !== 'ui:configure')
      throw new Error('The public outgoing observer did not receive ui:configure.')
    if (wireEvent.type !== 'ui:configure')
      throw new Error('The websocket wire did not receive ui:configure.')

    const observerConfig = observerEvent.data.config
    const observerEndpoint = observerConfig.endpoint
    const observerCallbackUrl = observerConfig.callbackUrl
    if (typeof observerEndpoint !== 'string' || typeof observerCallbackUrl !== 'string')
      throw new Error('The observer removed URL structure instead of redacting secret query values.')
    const observerEndpointUrl = new URL(observerEndpoint)
    const observerCallback = new URL(observerCallbackUrl)
    expect(observerEndpointUrl.origin).toBe('https://service.synthetic.invalid')
    expect(observerEndpointUrl.pathname).toBe('/v1/events')
    expect(observerEndpointUrl.searchParams.get('access_token')).toBe('[REDACTED]')
    expect(observerEndpointUrl.searchParams.get('api_key')).toBe('[REDACTED]')
    expect(observerEndpointUrl.searchParams.get('safe')).toBe('visible')
    expect(observerCallback.pathname).toBe('/return')
    expect(observerCallback.searchParams.get('token')).toBe('[REDACTED]')
    expect(observerCallback.searchParams.get('authorization')).toBe('[REDACTED]')
    expect(observerCallback.searchParams.get('state')).toBe('visible')
    expect(observerConfig.headers).toEqual({
      'Authorization': '[REDACTED]',
      'X-Api-Key': '[REDACTED]',
      'X-Request-Id': 'visible',
    })
    expect(observerConfig.query).toEqual({
      access_token: '[REDACTED]',
      api_key: '[REDACTED]',
      page: 3,
    })

    expect(JSON.stringify(wireEvent)).toContain(SYNTHETIC_URL_QUERY_SECRET)
    expect(wireEvent.data.config).toMatchObject({
      endpoint: event.data.config.endpoint,
      headers: event.data.config.headers,
      query: event.data.config.query,
    })
    expect(event.data.config).toMatchObject({
      callbackUrl: expect.stringContaining(SYNTHETIC_URL_QUERY_SECRET),
      endpoint: expect.stringContaining(SYNTHETIC_URL_QUERY_SECRET),
      headers: { Authorization: `Bearer ${SYNTHETIC_URL_QUERY_SECRET}` },
      query: { access_token: SYNTHETIC_URL_QUERY_SECRET, api_key: SYNTHETIC_URL_QUERY_SECRET },
    })

    client.close()
    await expect(connecting).rejects.toThrow('Client closed')
  })

  /**
   * @example
   * it('Discord audit D-028 keeps incoming observer mutation out of dispatch', () => {})
   */
  it('reproduces Discord audit D-028 by redacting incoming observers without mutating internal event dispatch', async () => {
    // ROOT CAUSE:
    //
    // handleMessage passed one parsed object to onAnyMessage, control handling,
    // and onEvent listeners. The Inspector saw raw config and could change what
    // application listeners consumed.
    //
    // Before: onAnyMessage(data); dispatchMessage(data).
    //
    // We fixed this by observing a separate redacted clone and dispatching the
    // untouched parsed event through the existing internal path.
    const observed: WebSocketEvent[] = []
    const internallyDispatched: WebSocketEvent[] = []
    const client = new Client({
      autoConnect: false,
      autoReconnect: false,
      name: 'synthetic-d028-plugin',
      onAnyMessage: (event) => {
        observed.push(event)
        if (event.type === 'module:configure') {
          const config = event.data.config as Record<string, unknown>
          config.safeLabel = 'observer-mutated'
        }
        if (event.type === 'module:authenticated')
          event.data.authenticated = false
      },
    })

    client.onEvent('module:configure', (event) => {
      internallyDispatched.push(event)
    })

    const connecting = client.connect()
    const socket = lastSocket()
    emitMessage(socket, {
      type: 'module:configure',
      data: {
        config: {
          safeLabel: 'dispatch-original',
          botToken: SYNTHETIC_BOT_TOKEN,
          nested: [{ privateKey: SYNTHETIC_NESTED_SECRET }],
        },
      },
      metadata: {
        source: { kind: 'plugin', plugin: { id: 'synthetic-server' }, id: 'server-d028' },
        event: { id: 'incoming-d028' },
      },
    })

    await vi.waitFor(() => {
      expect(internallyDispatched).toHaveLength(1)
    })

    expect(JSON.stringify(observed)).not.toContain(SYNTHETIC_BOT_TOKEN)
    expect(JSON.stringify(observed)).not.toContain(SYNTHETIC_NESTED_SECRET)
    expect(observed[0]).toMatchObject({
      type: 'module:configure',
      data: {
        config: {
          safeLabel: 'observer-mutated',
          botToken: '[REDACTED]',
          nested: [{ privateKey: '[REDACTED]' }],
        },
      },
      metadata: {
        source: { id: 'server-d028' },
        event: { id: 'incoming-d028' },
      },
    })
    expect(internallyDispatched[0]).toMatchObject({
      data: {
        config: {
          safeLabel: 'dispatch-original',
          botToken: SYNTHETIC_BOT_TOKEN,
          nested: [{ privateKey: SYNTHETIC_NESTED_SECRET }],
        },
      },
    })

    emitOpen(socket)
    emitMessage(socket, {
      type: 'module:authenticated',
      data: { authenticated: true },
      metadata: {
        source: { kind: 'plugin', plugin: { id: 'synthetic-server' }, id: 'server-d028' },
        event: { id: 'authenticated-d028' },
      },
    })

    await vi.waitFor(() => {
      expect(parseSent(socket).type).toBe('module:announce')
    })
    expect(observed.find(event => event.type === 'module:authenticated')).toMatchObject({
      data: { authenticated: false },
    })

    client.close()
    await expect(connecting).rejects.toThrow('Client closed')
  })

  /**
   * @example
   * it('Discord audit D-028 isolates observer failures from transport state', () => {})
   */
  it('reproduces Discord audit D-028 by isolating synchronous and asynchronous observer failures from wire and raw dispatch', async () => {
    // ROOT CAUSE:
    //
    // notifyObserver reported observer callback failures through the transport
    // onError callback and ignored rejected observer promises. A diagnostic
    // failure could therefore mark a healthy channel disconnected, while an
    // async rejection became unhandled.
    //
    // Before: catch { this.opts.onError(new Error(...)) }.
    //
    // We fixed this with an independent, fixed, payload-free observer failure
    // channel that handles both thrown and rejected callbacks without delaying
    // the wire or raw internal dispatch.
    const transportErrors = vi.fn()
    const observerFailures = vi.fn()
    const rawAuthenticatedListener = vi.fn()
    const options = {
      autoConnect: false,
      autoReconnect: false,
      name: 'synthetic-d028-observer-failure-plugin',
      token: SYNTHETIC_PAIRING_TOKEN,
      onError: transportErrors,
      onObserverError: observerFailures,
      onAnySend: (event: WebSocketEvent) => {
        if (event.type === 'module:authenticate')
          throw new Error('synthetic-d028-outgoing-observer-error-sentinel')
      },
      onAnyMessage: async (event: WebSocketEvent) => {
        if (event.type === 'module:authenticated')
          throw new Error('synthetic-d028-incoming-observer-error-sentinel')
      },
    }
    const client = new Client(options)
    client.onEvent('module:authenticated', rawAuthenticatedListener)

    const connecting = client.connect()
    const socket = lastSocket()
    emitOpen(socket)

    expect(JSON.stringify(parseSent(socket))).toContain(SYNTHETIC_PAIRING_TOKEN)

    emitMessage(socket, {
      type: 'module:authenticated',
      data: { authenticated: true },
      metadata: {
        source: { kind: 'plugin', plugin: { id: 'synthetic-server' }, id: 'server-d028' },
        event: { id: 'observer-failure-authenticated-d028' },
      },
    })

    await vi.waitFor(() => {
      expect(rawAuthenticatedListener).toHaveBeenCalledWith(expect.objectContaining({
        type: 'module:authenticated',
        data: { authenticated: true },
      }))
      expect(parseSent(socket).type).toBe('module:announce')
    })

    const announceEvent = parseSent(socket) as WebSocketEventOf<'module:announce'>
    emitMessage(socket, {
      type: 'module:announced',
      data: {
        name: 'synthetic-d028-observer-failure-plugin',
        identity: announceEvent.data.identity,
      },
      metadata: {
        source: { kind: 'plugin', plugin: { id: 'synthetic-server' }, id: 'server-d028' },
        event: { id: 'observer-failure-announced-d028' },
      },
    })
    await connecting

    await vi.waitFor(() => {
      expect(observerFailures).toHaveBeenCalledTimes(2)
    })
    expect(observerFailures).toHaveBeenNthCalledWith(1, {
      category: 'observer-callback-failed',
      direction: 'outgoing',
    })
    expect(observerFailures).toHaveBeenNthCalledWith(2, {
      category: 'observer-callback-failed',
      direction: 'incoming',
    })
    expect(JSON.stringify(observerFailures.mock.calls)).not.toContain('synthetic-d028-outgoing-observer-error-sentinel')
    expect(JSON.stringify(observerFailures.mock.calls)).not.toContain('synthetic-d028-incoming-observer-error-sentinel')
    expect(transportErrors).not.toHaveBeenCalled()
    expect(client.isReady).toBe(true)

    client.close()
  })

  it('resolves connect only after authentication and self announcement', async () => {
    const client = new Client({
      autoConnect: false,
      autoReconnect: false,
      name: 'test-plugin',
      token: 'secret',
    })

    const connected = client.connect()
    const socket = lastSocket()

    emitOpen(socket)

    expect(parseSent(socket)).toMatchObject({
      type: 'module:authenticate',
      data: {
        token: 'secret',
        module: {
          name: 'test-plugin',
          identity: {
            kind: 'plugin',
            plugin: { id: 'test-plugin' },
          },
        },
      },
    })

    emitMessage(socket, {
      type: 'module:authenticated',
      data: { authenticated: true },
      metadata: {
        source: { kind: 'plugin', plugin: { id: 'server' }, id: 'server-1' },
        event: { id: 'auth-1' },
      },
    })

    const announceEvent = parseSent(socket) as WebSocketEventOf<'module:announce'>

    expect(announceEvent).toMatchObject({
      type: 'module:announce',
      data: { name: 'test-plugin' },
    })

    emitMessage(socket, {
      type: 'module:announced',
      data: {
        name: 'test-plugin',
        identity: announceEvent.data.identity,
      },
      metadata: {
        source: { kind: 'plugin', plugin: { id: 'server' }, id: 'server-1' },
        event: { id: 'announce-1' },
      },
    })

    await expect(connected).resolves.toBeUndefined()
    expect(client.connectionStatus).toBe('ready')
    expect(client.isReady).toBe(true)
  })

  it('fails terminally on invalid token', async () => {
    const client = new Client({
      autoConnect: false,
      autoReconnect: true,
      name: 'test-plugin',
      token: 'wrong-token',
    })

    const connected = client.connect()
    const socket = lastSocket()

    emitOpen(socket)
    emitMessage(socket, {
      type: 'error',
      data: { message: 'invalid token' },
      metadata: {
        source: { kind: 'plugin', plugin: { id: 'server' }, id: 'server-1' },
        event: { id: 'error-1' },
      },
    })

    await expect(connected).rejects.toThrow('invalid token')
    expect(client.connectionStatus).toBe('failed')
  })

  it('returns an unsubscribe function from onEvent', () => {
    const client = new Client({
      autoConnect: false,
      autoReconnect: false,
      name: 'test-plugin',
    })

    const listener = vi.fn()
    const dispose = client.onEvent('input:text', listener)

    dispose()
    expect(() => client.offEvent('input:text', listener)).not.toThrow()
  })

  it('uses an injected websocket constructor when provided', async () => {
    const client = new Client({
      autoConnect: false,
      autoReconnect: false,
      name: 'test-plugin',
      websocketConstructor: InjectedMockWebSocket,
    })

    const connected = client.connect()
    const socket = InjectedMockWebSocket.instances.at(-1)

    expect(socket).toBeDefined()
    expect(MockWebSocket.instances).toHaveLength(1)

    if (!socket) {
      throw new Error('No custom mock websocket instance created')
    }

    emitOpen(socket)
    const announceEvent = acceptAuthentication(socket)

    emitMessage(socket, {
      type: 'module:announced',
      data: {
        name: 'test-plugin',
        identity: announceEvent.data.identity,
      },
      metadata: {
        source: { kind: 'plugin', plugin: { id: 'server' }, id: 'server-1' },
        event: { id: 'announce-1' },
      },
    })

    await expect(connected).resolves.toBeUndefined()
  })

  it('supports timeout-aware ensureConnected without cancelling the shared connect task', async () => {
    vi.useFakeTimers()

    const client = new Client({
      autoConnect: false,
      autoReconnect: false,
      name: 'test-plugin',
    })

    const timedOut = client.ensureConnected({ timeout: 50 })
    const timedOutAssertion = expect(timedOut).rejects.toThrow('Connection timed out after 50ms')
    const socket = lastSocket()

    await vi.advanceTimersByTimeAsync(50)
    await timedOutAssertion

    emitOpen(socket)
    const announceEvent = acceptAuthentication(socket)

    emitMessage(socket, {
      type: 'module:announced',
      data: {
        name: 'test-plugin',
        identity: announceEvent.data.identity,
      },
      metadata: {
        source: { kind: 'plugin', plugin: { id: 'server' }, id: 'server-1' },
        event: { id: 'announce-1' },
      },
    })

    await expect(client.ensureConnected()).resolves.toBeUndefined()
    expect(client.isReady).toBe(true)
  })

  it('supports abort-aware connect', async () => {
    const client = new Client({
      autoConnect: false,
      autoReconnect: false,
      name: 'test-plugin',
    })

    const controller = new AbortController()
    const connecting = client.connect({ abortSignal: controller.signal })

    lastSocket()
    controller.abort()

    await expect(connecting).rejects.toThrow('Connection aborted')
    expect(client.connectionStatus).toBe('connecting')
  })

  it('notifies external state listeners', async () => {
    const client = new Client({
      autoConnect: false,
      autoReconnect: false,
      name: 'test-plugin',
    })

    const listener = vi.fn()
    const dispose = client.onConnectionStateChange(listener)
    const connected = client.connect()
    const socket = lastSocket()

    emitOpen(socket)
    const announceEvent = acceptAuthentication(socket)

    emitMessage(socket, {
      type: 'module:announced',
      data: {
        name: 'test-plugin',
        identity: announceEvent.data.identity,
      },
      metadata: {
        source: { kind: 'plugin', plugin: { id: 'server' }, id: 'server-1' },
        event: { id: 'announce-1' },
      },
    })

    await connected

    expect(listener).toHaveBeenCalledWith({ previousStatus: 'idle', status: 'connecting' })
    expect(listener).toHaveBeenCalledWith({ previousStatus: 'connecting', status: 'authenticating' })
    expect(listener).toHaveBeenCalledWith({ previousStatus: 'authenticating', status: 'announcing' })
    expect(listener).toHaveBeenCalledWith({ previousStatus: 'announcing', status: 'ready' })

    dispose()
  })

  it('retries after connect timeout and eventually connects on a later socket', async () => {
    vi.useFakeTimers()

    const client = new Client({
      autoConnect: false,
      autoReconnect: true,
      connectTimeoutMs: 50,
      name: 'test-plugin',
    })

    const connecting = client.connect()
    const firstSocket = lastSocket()
    const firstCloseSpy = vi.spyOn(firstSocket, 'close')

    await vi.advanceTimersByTimeAsync(50)
    expect(firstCloseSpy).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(1_000)
    expect(MockWebSocket.instances).toHaveLength(2)

    const secondSocket = lastSocket()
    emitOpen(secondSocket)
    const announceEvent = acceptAuthentication(secondSocket)

    emitMessage(secondSocket, {
      type: 'module:announced',
      data: {
        name: 'test-plugin',
        identity: announceEvent.data.identity,
      },
      metadata: {
        source: { kind: 'plugin', plugin: { id: 'server' }, id: 'server-1' },
        event: { id: 'announce-retry-1' },
      },
    })

    await expect(connecting).resolves.toBeUndefined()
    expect(client.connectionStatus).toBe('ready')
  })

  it('does not emit onReady twice when sync fallback already moved status to ready', async () => {
    const onReady = vi.fn()
    const client = new Client({
      autoConnect: false,
      autoReconnect: false,
      name: 'test-plugin',
      onReady,
    })

    const connecting = client.connect()
    const socket = lastSocket()
    emitOpen(socket)
    const announceEvent = acceptAuthentication(socket)

    const selfIdentity = announceEvent.data.identity

    emitMessage(socket, {
      type: 'registry:modules:sync',
      data: {
        modules: [{ name: 'test-plugin', identity: selfIdentity }],
      },
      metadata: {
        source: { kind: 'plugin', plugin: { id: 'server' }, id: 'server-1' },
        event: { id: 'sync-1' },
      },
    })

    emitMessage(socket, {
      type: 'module:announced',
      data: {
        name: 'test-plugin',
        identity: selfIdentity,
      },
      metadata: {
        source: { kind: 'plugin', plugin: { id: 'server' }, id: 'server-1' },
        event: { id: 'announce-1' },
      },
    })

    await expect(connecting).resolves.toBeUndefined()
    expect(onReady).toHaveBeenCalledTimes(1)
  })
})
