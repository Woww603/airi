import type { Log } from '@guiiai/logg'

import type { Peer } from './types'

import { Buffer } from 'node:buffer'

import {
  Format,
  getGlobalHookPostLog,
  LogLevelString,
  setGlobalHookPostLog,
} from '@guiiai/logg'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { setupApp } from './index'

interface GatewayHooks {
  close: (peer: Peer, details?: Record<string, unknown>) => void
  error: (peer: Peer, error: Error) => void
  open: (peer: Peer) => void
  message: (peer: Peer, message: { text: () => string }) => void
}

interface TestPeer extends Peer {
  failSendWhen: (frame: string) => Error | undefined
  sentFrames: string[]
}

const AUTH_TOKEN = 'synthetic-auth-token'
const INPUT_SENTINEL = 'synthetic-input-text-sentinel'
const MEMORY_SENTINEL = 'synthetic-memory-command-sentinel'
const CONFIG_SENTINEL = 'synthetic-config-token-sentinel'
const RAW_ERROR_SENTINEL = 'synthetic-raw-error-sentinel'
const GATEWAY_ERROR_MESSAGE_SENTINEL = 'synthetic-gateway-error-message-sentinel'
const GATEWAY_ERROR_NAME_SENTINEL = 'synthetic-gateway-error-name-sentinel'
const GATEWAY_ERROR_CAUSE_SENTINEL = 'synthetic-gateway-error-cause-sentinel'
const GATEWAY_ERROR_CUSTOM_SENTINEL = 'synthetic-gateway-error-custom-sentinel'
const CLOSE_REASON_SENTINEL = 'synthetic-close-reason-sentinel'
const CLOSE_DETAIL_SENTINEL = 'synthetic-close-detail-sentinel'
const CLOSE_REMOTE_SENTINEL = 'synthetic-close-remote-sentinel'

const runtimes: Array<ReturnType<typeof setupApp>> = []
let previousHook = getGlobalHookPostLog()

function hasGatewayHooks(response: Response): response is Response & { crossws: GatewayHooks } {
  if (!('crossws' in response) || typeof response.crossws !== 'object' || response.crossws === null)
    return false

  return 'open' in response.crossws
    && typeof response.crossws.open === 'function'
    && 'message' in response.crossws
    && typeof response.crossws.message === 'function'
    && 'error' in response.crossws
    && typeof response.crossws.error === 'function'
    && 'close' in response.crossws
    && typeof response.crossws.close === 'function'
}

function createPeer(id: string, remoteAddress = '127.0.0.1'): TestPeer {
  const peer: TestPeer = {
    id,
    remoteAddress,
    request: {
      headers: new Headers(),
      url: '/ws',
    },
    sentFrames: [],
    failSendWhen: () => undefined,
    close: vi.fn(),
    send: vi.fn((data: unknown) => {
      const frame = String(data)
      peer.sentFrames.push(frame)
      const failure = peer.failSendWhen(frame)
      if (failure)
        throw failure
    }),
  }
  return peer
}

function sendEvent(hooks: GatewayHooks, peer: Peer, event: Record<string, unknown>): void {
  hooks.message(peer, { text: () => JSON.stringify(event) })
}

function authenticateAndAnnounce(hooks: GatewayHooks, peer: Peer, name: string): void {
  const identity = {
    id: `${name}-instance`,
    kind: 'plugin',
    plugin: { id: name },
  }
  hooks.open(peer)
  sendEvent(hooks, peer, {
    type: 'module:authenticate',
    data: {
      token: AUTH_TOKEN,
      module: { name, identity },
    },
  })
  sendEvent(hooks, peer, {
    type: 'module:announce',
    data: {
      name,
      identity,
      possibleEvents: [],
    },
  })
}

async function createHarness(options?: Parameters<typeof setupApp>[0]): Promise<{ hooks: GatewayHooks, logs: Log[] }> {
  const logs: Log[] = []
  previousHook = getGlobalHookPostLog()
  setGlobalHookPostLog(log => logs.push(log))
  const runtime = setupApp({
    ...options,
    auth: { token: AUTH_TOKEN, ...options?.auth },
    instanceId: 'synthetic-server-instance',
    logger: {
      app: { format: Format.JSON, level: LogLevelString.Debug },
      websocket: { format: Format.JSON, level: LogLevelString.Debug },
    },
  })
  runtimes.push(runtime)
  const response = await runtime.app.request('/ws')
  if (!hasGatewayHooks(response))
    throw new Error('Expected the setupApp WebSocket route to expose crossws hooks')

  return { hooks: response.crossws, logs }
}

function serializedRoutingLogs(logs: Log[]): string {
  return JSON.stringify(logs.filter(log => [
    'routing dropped event',
    'no consumer registered for event delivery',
    'sending event to selected consumer',
    'failed to send event to selected consumer, removing peer',
    'broadcasting event to peers',
    'not sending event to self',
    'not sending event to unauthenticated peer',
    'sending event to peer',
    'failed to send event to peer, removing peer',
  ].includes(log.message)))
}

function fieldKeys(value: unknown): string[] {
  if (Array.isArray(value))
    return value.flatMap(fieldKeys)
  if (typeof value !== 'object' || value === null)
    return []

  return Object.entries(value).flatMap(([key, nested]) => [key, ...fieldKeys(nested)])
}

afterEach(() => {
  for (const runtime of runtimes.splice(0))
    runtime.dispose()
  setGlobalHookPostLog(previousHook)
})

/**
 * @example
 * describe.sequential('server-runtime safe event logging', () => {})
 */
describe.sequential('server-runtime safe event logging', () => {
  /**
   * @example
   * it('summarizes gateway errors without peer-controlled error content (Discord audit R-002)', async () => {})
   */
  it('summarizes gateway errors without peer-controlled error content (Discord audit R-002)', async () => {
    // ROOT CAUSE:
    //
    // The real gateway error hook forwarded the complete peer-controlled Error
    // to `withError`, leaving message, name/stack, cause, and future custom-field
    // serialization to the logger instead of defining a gateway allowlist.
    //
    // Before: serialized gateway logs contain message, name/stack, and cause sentinels.
    // After: the hook records only peer correlation and a fixed failure category.
    const { hooks, logs } = await createHarness()
    const peer = createPeer('gateway-error-peer')
    hooks.open(peer)

    const gatewayError = new Error(GATEWAY_ERROR_MESSAGE_SENTINEL, {
      cause: { nested: GATEWAY_ERROR_CAUSE_SENTINEL },
    })
    gatewayError.name = GATEWAY_ERROR_NAME_SENTINEL
    Object.assign(gatewayError, { custom: GATEWAY_ERROR_CUSTOM_SENTINEL })
    hooks.error(peer, gatewayError)

    const serializedLogs = JSON.stringify(logs)
    const errorLog = logs.find(log => log.message === 'an error occurred')

    // @example
    expect(serializedLogs).not.toContain(GATEWAY_ERROR_MESSAGE_SENTINEL)
    // @example
    expect(serializedLogs).not.toContain(GATEWAY_ERROR_NAME_SENTINEL)
    // @example
    expect(serializedLogs).not.toContain(GATEWAY_ERROR_CAUSE_SENTINEL)
    // @example
    expect(serializedLogs).not.toContain(GATEWAY_ERROR_CUSTOM_SENTINEL)
    // @example
    expect(fieldKeys(errorLog)).not.toContain('error')
    // @example
    expect(errorLog?.fields).toEqual({
      failureCategory: 'gateway-error',
      peer: 'gateway-error-peer',
    })
  })

  /**
   * @example
   * it('summarizes gateway closes without peer-controlled close details (Discord audit R-002)', async () => {})
   */
  it('summarizes gateway closes without peer-controlled close details (Discord audit R-002)', async () => {
    // ROOT CAUSE:
    //
    // The real gateway close hook persisted the raw details object, close reason,
    // and remote address. All three values may be controlled by the remote peer.
    //
    // Before: serialized close logs contain reason, nested-detail, and address sentinels.
    // After: only allowlisted numeric/boolean health and close classifications remain.
    const { hooks, logs } = await createHarness()
    const peer = createPeer('gateway-close-peer', CLOSE_REMOTE_SENTINEL)
    authenticateAndAnnounce(hooks, peer, 'gateway-close-module')

    hooks.close(peer, {
      code: 1001,
      extra: { nested: CLOSE_DETAIL_SENTINEL },
      reason: CLOSE_REASON_SENTINEL,
      remoteAddress: CLOSE_REMOTE_SENTINEL,
      wasClean: true,
    })

    const serializedLogs = JSON.stringify(logs)
    const closeLog = logs.find(log => log.message === 'closed')

    // @example
    expect(serializedLogs).not.toContain(CLOSE_REASON_SENTINEL)
    // @example
    expect(serializedLogs).not.toContain(CLOSE_DETAIL_SENTINEL)
    // @example
    expect(serializedLogs).not.toContain(CLOSE_REMOTE_SENTINEL)
    // @example
    expect(fieldKeys(closeLog?.fields)).not.toContain('details')
    // @example
    expect(fieldKeys(closeLog?.fields)).not.toContain('closeReason')
    // @example
    expect(fieldKeys(closeLog?.fields)).not.toContain('peerRemote')
    // @example
    expect(Object.keys(closeLog?.fields ?? {}).sort()).toEqual([
      'activePeers',
      'closeCode',
      'closeWasClean',
      'failureCategory',
      'healthCheckIntervalMs',
      'heartbeatLastSeenAt',
      'heartbeatSilentForMs',
      'heartbeatTtlMs',
      'likelyHeartbeatExpiry',
      'likelySilentNetworkClose',
      'peer',
      'peerAuthenticated',
      'peerHealthy',
      'peerMissedHeartbeats',
    ])
    // @example
    expect(closeLog?.fields).toMatchObject({
      activePeers: 0,
      closeCode: 1001,
      closeWasClean: true,
      failureCategory: 'gateway-close',
      heartbeatTtlMs: expect.any(Number),
      healthCheckIntervalMs: expect.any(Number),
      likelyHeartbeatExpiry: false,
      likelySilentNetworkClose: false,
      peer: 'gateway-close-peer',
      peerAuthenticated: true,
      peerHealthy: true,
      peerMissedHeartbeats: 0,
    })
  })

  /**
   * @example
   * it('summarizes selected-consumer failures without event or raw error fields (Discord audit D-029)', async () => {})
   */
  it('summarizes selected-consumer failures without event or raw error fields (Discord audit D-029)', async () => {
    // ROOT CAUSE:
    //
    // The selected-consumer gateway branch attached the complete event and
    // delivery objects to logger fields, then passed the thrown send error to
    // `withError`. User text and any sentinel embedded in message, name, cause,
    // stack, or custom error fields therefore reached persistent log sinks.
    //
    // Before: serialized logger calls contain the input and raw-error sentinels.
    // After: only an authenticated routing summary and fixed failure category remain.
    const { hooks, logs } = await createHarness()
    const sender = createPeer('sender-peer')
    const consumer = createPeer('consumer-peer')
    authenticateAndAnnounce(hooks, sender, 'sender-module')
    authenticateAndAnnounce(hooks, consumer, 'consumer-module')
    sendEvent(hooks, consumer, {
      type: 'module:consumer:register',
      data: {
        event: 'input:text',
        group: 'chat-ingestion',
        mode: 'consumer-group',
      },
    })

    const rawError = new Error(`${RAW_ERROR_SENTINEL}-message`, {
      cause: { token: `${RAW_ERROR_SENTINEL}-cause` },
    })
    rawError.name = `${RAW_ERROR_SENTINEL}-name`
    Object.assign(rawError, { custom: `${RAW_ERROR_SENTINEL}-custom` })
    consumer.failSendWhen = frame => frame.includes(INPUT_SENTINEL) ? rawError : undefined
    sendEvent(hooks, sender, {
      type: 'input:text',
      data: {
        config: { token: CONFIG_SENTINEL },
        text: `${INPUT_SENTINEL}-🩵`,
      },
      metadata: { event: { id: 'synthetic-consumer-event-id' } },
    })

    const serializedLogs = JSON.stringify(logs)
    const failure = logs.find(log => log.message === 'failed to send event to selected consumer, removing peer')
    const deliveredFrame = consumer.sentFrames.find(frame => frame.includes(INPUT_SENTINEL))

    // @example
    expect(serializedLogs).not.toContain(AUTH_TOKEN)
    // @example
    expect(serializedLogs).not.toContain(INPUT_SENTINEL)
    // @example
    expect(serializedLogs).not.toContain(MEMORY_SENTINEL)
    // @example
    expect(serializedLogs).not.toContain(CONFIG_SENTINEL)
    // @example
    expect(serializedLogs).not.toContain(RAW_ERROR_SENTINEL)
    // @example
    expect(fieldKeys(failure?.fields)).not.toContain('event')
    // @example
    expect(fieldKeys(failure?.fields)).not.toContain('data')
    // @example
    expect(fieldKeys(failure?.fields)).not.toContain('envelope')
    // @example
    expect(failure?.fields).toMatchObject({
      deliveryMode: 'consumer-group',
      eventId: 'synthetic-consumer-event-id',
      eventType: 'input:text',
      failureCategory: 'peer-send-failed',
      fromPeer: 'sender-peer',
      sourceId: 'sender-module-instance',
      sourceKind: 'plugin',
      sourcePluginId: 'sender-module',
      toPeer: 'consumer-peer',
    })
    // @example
    expect(failure?.fields.payloadByteLength).toBe(Buffer.byteLength(deliveredFrame ?? '', 'utf8'))
  })

  /**
   * @example
   * it('summarizes broadcast failures without event or raw error fields (Discord audit D-029)', async () => {})
   */
  it('summarizes broadcast failures without event or raw error fields (Discord audit D-029)', async () => {
    // ROOT CAUSE:
    //
    // Normal broadcast logging repeated the entire event on every target and
    // attached raw send exceptions. A single body could therefore be copied to
    // many debug/error entries, including exception-controlled secret content.
    //
    // Before: the memory body and raw exception are serialized by the logger.
    // After: every branch uses the same fixed summary and error category.
    const { hooks, logs } = await createHarness()
    const sender = createPeer('broadcast-sender')
    const receiver = createPeer('broadcast-receiver')
    authenticateAndAnnounce(hooks, sender, 'broadcast-source')
    authenticateAndAnnounce(hooks, receiver, 'broadcast-target')

    const rawError = new Error(`${RAW_ERROR_SENTINEL}-broadcast`)
    rawError.name = `${RAW_ERROR_SENTINEL}-broadcast-name`
    Object.assign(rawError, {
      cause: `${RAW_ERROR_SENTINEL}-broadcast-cause`,
      custom: `${RAW_ERROR_SENTINEL}-broadcast-custom`,
    })
    receiver.failSendWhen = frame => frame.includes(MEMORY_SENTINEL) ? rawError : undefined
    sendEvent(hooks, sender, {
      type: 'discord:memory:command',
      data: {
        body: MEMORY_SENTINEL,
        config: { botToken: CONFIG_SENTINEL },
      },
      metadata: { event: { id: 'synthetic-broadcast-event-id' } },
      route: {
        delivery: {
          mode: 'broadcast',
          stickyKey: `${CONFIG_SENTINEL}-sticky-key`,
        },
      },
    })

    const serializedLogs = JSON.stringify(logs)
    const failure = logs.find(log => log.message === 'failed to send event to peer, removing peer')

    // @example
    expect(serializedLogs).not.toContain(AUTH_TOKEN)
    // @example
    expect(serializedLogs).not.toContain(INPUT_SENTINEL)
    // @example
    expect(serializedLogs).not.toContain(MEMORY_SENTINEL)
    // @example
    expect(serializedLogs).not.toContain(CONFIG_SENTINEL)
    // @example
    expect(serializedLogs).not.toContain(RAW_ERROR_SENTINEL)
    // @example
    expect(fieldKeys(failure?.fields)).not.toContain('event')
    // @example
    expect(fieldKeys(failure?.fields)).not.toContain('data')
    // @example
    expect(fieldKeys(failure?.fields)).not.toContain('envelope')
    // @example
    expect(failure?.fields).toMatchObject({
      deliveryMode: 'broadcast',
      eventId: 'synthetic-broadcast-event-id',
      eventType: 'discord:memory:command',
      failureCategory: 'peer-send-failed',
      fromPeer: 'broadcast-sender',
      sourceId: 'broadcast-source-instance',
      sourceKind: 'plugin',
      sourcePluginId: 'broadcast-source',
      toPeer: 'broadcast-receiver',
    })
    // @example
    expect(failure?.fields.payloadByteLength).toBeGreaterThan(0)
  })

  /**
   * @example
   * it('keeps safe summaries for success, drop, and no-consumer paths (Discord audit D-029)', async () => {})
   */
  it('keeps safe summaries for success, drop, and no-consumer paths (Discord audit D-029)', async () => {
    // ROOT CAUSE:
    //
    // Debug and warning branches logged the same raw envelope even when delivery
    // succeeded, routing dropped the event, or no consumer existed. Removing only
    // error logging would leave the primary disclosure paths intact.
    //
    // Before: each branch persists the synthetic message/config body.
    // After: each branch preserves event correlation and byte counts only.
    const { hooks, logs } = await createHarness({
      routing: {
        middleware: [({ event }) => event.metadata?.event?.id === 'synthetic-drop-event-id' ? { type: 'drop' } : undefined],
      },
    })
    const sender = createPeer('debug-sender')
    const receiver = createPeer('debug-receiver')
    const unauthenticated = createPeer('debug-unauthenticated')
    authenticateAndAnnounce(hooks, sender, 'debug-source')
    authenticateAndAnnounce(hooks, receiver, 'debug-target')
    hooks.open(unauthenticated)

    for (const [type, id] of [
      ['synthetic:success', 'synthetic-success-event-id'],
      ['synthetic:drop', 'synthetic-drop-event-id'],
      ['input:text', 'synthetic-no-consumer-event-id'],
    ] as const) {
      sendEvent(hooks, sender, {
        type,
        data: {
          config: { accessToken: CONFIG_SENTINEL },
          text: `${INPUT_SENTINEL}-${type}`,
        },
        metadata: { event: { id } },
      })
    }

    const serialized = serializedRoutingLogs(logs)
    const serializedLogs = JSON.stringify(logs)
    const routingLogs = logs.filter(log => serialized.includes(log.message))

    // @example
    expect(serializedLogs).not.toContain(AUTH_TOKEN)
    // @example
    expect(serializedLogs).not.toContain(INPUT_SENTINEL)
    // @example
    expect(serializedLogs).not.toContain(MEMORY_SENTINEL)
    // @example
    expect(serializedLogs).not.toContain(CONFIG_SENTINEL)
    // @example
    expect(serializedLogs).not.toContain(RAW_ERROR_SENTINEL)
    // @example
    expect(fieldKeys(routingLogs.map(log => log.fields))).not.toContain('event')
    // @example
    expect(fieldKeys(routingLogs.map(log => log.fields))).not.toContain('data')
    // @example
    expect(fieldKeys(routingLogs.map(log => log.fields))).not.toContain('envelope')
    // @example
    expect(logs.find(log => log.message === 'routing dropped event')?.fields).toMatchObject({
      eventId: 'synthetic-drop-event-id',
      eventType: 'synthetic:drop',
      sourcePluginId: 'debug-source',
    })
    // @example
    expect(logs.find(log => log.message === 'no consumer registered for event delivery')?.fields).toMatchObject({
      deliveryMode: 'consumer-group',
      eventId: 'synthetic-no-consumer-event-id',
      eventType: 'input:text',
      sourcePluginId: 'debug-source',
    })
    // @example
    expect(logs.find(log => log.message === 'sending event to peer')?.fields).toMatchObject({
      deliveryMode: 'broadcast',
      eventId: 'synthetic-success-event-id',
      eventType: 'synthetic:success',
      sourcePluginId: 'debug-source',
      toPeer: 'debug-receiver',
    })
    // @example
    expect(logs.find(log => log.message === 'not sending event to unauthenticated peer')?.fields).toMatchObject({
      deliveryMode: 'broadcast',
      eventId: 'synthetic-success-event-id',
      eventType: 'synthetic:success',
      sourcePluginId: 'debug-source',
      toPeer: 'debug-unauthenticated',
    })
  })
})
