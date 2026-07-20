import type {
  DeliveryConfig,
  MetadataEventSource,
  WebSocketBaseEvent,
  WebSocketEvent,
} from '@proj-airi/server-shared/types'

import type {
  RouteMiddleware,
  RoutingPolicy,
} from './middlewares'
import type { ServerWsConsumerSelectionCandidate, ServerWsStickyAssignment } from './server-ws/core'
import type {
  AuthenticatedModuleBinding,
  AuthenticatedPeer,
  ModuleCredential,
  Peer,
} from './types'

import { Buffer } from 'node:buffer'
import { timingSafeEqual } from 'node:crypto'

import { availableLogLevelStrings, Format, LogLevelString, logLevelStringToLogLevelMap, useLogg } from '@guiiai/logg'
import { errorMessageFrom } from '@moeru/std'
import {
  createInvalidJsonServerErrorMessage,
  ServerErrorMessages,
} from '@proj-airi/server-shared'
import {
  MessageHeartbeat,
  MessageHeartbeatKind,
} from '@proj-airi/server-shared/types'
import { defineWebSocketHandler, H3 } from 'h3'
import { nanoid } from 'nanoid'

import { optionOrEnv } from './config'
import {
  collectDestinations,
  createPolicyMiddleware,
  isDevtoolsPeer,
  matchesDestinations,
} from './middlewares'
import {
  createEventMetadata,
  createGateway,
  createResponses,
  forEachEventMiddlewares,
  heartbeatFrameFrom,
  isAiriWebSocketEventFormatError,
  parseEvent,
  resolveEventDelivery,
  stringifyEvent,
} from './server-ws/airi'
import {
  createConsumerOrchestrator,
  createServerWsPeerStore,
  createServerWsTrafficGuard,
  isConsumerDeliveryMode,
  isServerWsOriginAllowed,
  normalizeConsumerMode,
  normalizeConsumerPriority,
  resolveServerWsHealthCheckIntervalMs,
  selectConsumerPeerId as selectServerWsConsumerPeerId,
  serverWsDefaultHeartbeatTtlMs,
  serverWsHealthCheckMissesDead,
  serverWsHealthCheckMissesUnhealthy,
} from './server-ws/core'

export {
  heartbeatFrameFrom,
  resolveEventDelivery,
}

export type { ModuleCredential } from './types'

/**
 * Candidate peer metadata used for consumer selection.
 */
export type ConsumerSelectionCandidate = ServerWsConsumerSelectionCandidate

function normalizeRootConsumerGroup(mode: DeliveryConfig['mode'], group?: string) {
  if (mode === 'consumer') {
    return 'default'
  }

  return group || 'default'
}

/**
 * Selects a concrete consumer peer for consumer-style delivery modes.
 *
 * Use when:
 * - Existing server-runtime callers need the package-root consumer selector
 * - Sticky and round-robin state should remain stored in the original root API shape
 *
 * Expects:
 * - Candidates already describe authenticated and health state
 *
 * Returns:
 * - The selected peer id, or `undefined` when no eligible consumer is available
 */
export function selectConsumerPeerId(options: {
  eventType: string
  fromPeerId: string
  delivery?: DeliveryConfig
  candidates: ConsumerSelectionCandidate[]
  roundRobinCursor?: Map<string, number>
  stickyAssignments?: Map<string, string>
}) {
  if (!options.delivery || !isConsumerDeliveryMode(options.delivery.mode)) {
    return selectServerWsConsumerPeerId({
      eventType: options.eventType,
      fromPeerId: options.fromPeerId,
      delivery: options.delivery,
      candidates: options.candidates,
      roundRobinCursor: options.roundRobinCursor,
    })
  }

  const normalizedGroup = normalizeRootConsumerGroup(options.delivery.mode, options.delivery.group)
  const legacyRegistryKey = `${options.eventType}::${normalizedGroup}`
  const coreRegistryKey = JSON.stringify([options.eventType, normalizedGroup])
  const roundRobinCursor = options.roundRobinCursor
    ? new Map([[coreRegistryKey, options.roundRobinCursor.get(legacyRegistryKey) ?? 0]])
    : undefined

  const stickyAssignments = new Map<string, ServerWsStickyAssignment>()
  if (options.delivery.selection === 'sticky' && options.delivery.stickyKey && options.stickyAssignments) {
    const legacyStickyKey = `${legacyRegistryKey}::${options.delivery.stickyKey}`
    const stickyPeerId = options.stickyAssignments.get(legacyStickyKey)
    if (stickyPeerId) {
      stickyAssignments.set(JSON.stringify([options.eventType, normalizedGroup, options.delivery.stickyKey]), {
        event: options.eventType,
        group: normalizedGroup,
        peerId: stickyPeerId,
      })
    }
  }

  const selectedPeerId = selectServerWsConsumerPeerId({
    ...options,
    roundRobinCursor,
    stickyAssignments,
  })

  const nextCursor = roundRobinCursor?.get(coreRegistryKey)
  if (typeof nextCursor === 'number') {
    options.roundRobinCursor?.set(legacyRegistryKey, nextCursor)
  }

  if (options.delivery.selection === 'sticky' && options.delivery.stickyKey && selectedPeerId) {
    options.stickyAssignments?.set(`${legacyRegistryKey}::${options.delivery.stickyKey}`, selectedPeerId)
  }

  return selectedPeerId
}

/**
 * Constant-time string comparison that prevents timing attacks (CWE-208).
 *
 * Compares two strings in constant time to prevent attackers from learning
 * information about the target string through timing side-channels.
 *
 * Use when:
 * - Comparing authentication tokens or secrets
 * - Any security-sensitive string comparison
 *
 * Expects:
 * - Both strings are available (no lazy evaluation)
 *
 * Returns:
 * - `true` if the strings are equal, `false` otherwise
 */
function timingSafeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)

  // Normalize attacker-controlled input to the expected length
  // so timingSafeEqual always performs a real comparison.
  const paddedA = Buffer.alloc(bufB.length)

  bufA.copy(
    paddedA,
    0,
    0,
    Math.min(bufA.length, bufB.length),
  )

  return (
    timingSafeEqual(paddedA, bufB)
    && bufA.length === bufB.length
  )
}

function labelsMatch(left?: Record<string, string>, right?: Record<string, string>): boolean {
  const leftEntries = Object.entries(left ?? {}).sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
  const rightEntries = Object.entries(right ?? {}).sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
  return JSON.stringify(leftEntries) === JSON.stringify(rightEntries)
}

function moduleBindingsMatch(left: AuthenticatedModuleBinding, right: AuthenticatedModuleBinding): boolean {
  return left.name === right.name
    && left.index === right.index
    && left.identity.id === right.identity.id
    && left.identity.kind === right.identity.kind
    && left.identity.plugin.id === right.identity.plugin.id
    && left.identity.plugin.version === right.identity.plugin.version
    && labelsMatch(left.identity.plugin.labels, right.identity.plugin.labels)
    && labelsMatch(left.identity.labels, right.identity.labels)
}

function isValidModuleBinding(value: unknown): value is AuthenticatedModuleBinding {
  if (typeof value !== 'object' || value === null)
    return false

  const module = value as Partial<AuthenticatedModuleBinding>
  if (!module.name || typeof module.name !== 'string')
    return false
  if (module.index !== undefined && (!Number.isInteger(module.index) || module.index < 0))
    return false

  const identity = module.identity
  return Boolean(
    identity
    && identity.kind === 'plugin'
    && typeof identity.id === 'string'
    && identity.id.length > 0
    && typeof identity.plugin?.id === 'string'
    && identity.plugin.id === module.name,
  )
}

function capabilityAllows(values: readonly string[] | undefined, requested: string): boolean {
  return Boolean(values?.includes('*') || values?.includes(requested))
}

function validateModuleCredentials(credentials: readonly ModuleCredential[], pairingToken: string): void {
  const tokens: string[] = []
  const principals = new Set<string>()

  for (const credential of credentials) {
    if (!credential.token || !isValidModuleBinding(credential.module))
      throw new Error('Invalid server module credential configuration')
    if (pairingToken && timingSafeCompare(credential.token, pairingToken))
      throw new Error('Module credentials must differ from the generic pairing token')
    if (tokens.some(token => timingSafeCompare(token, credential.token)))
      throw new Error('Duplicate server module credential token')

    const principalKey = JSON.stringify([credential.module.name, credential.module.index ?? null])
    if (principals.has(principalKey))
      throw new Error('Duplicate server module credential principal')

    tokens.push(credential.token)
    principals.add(principalKey)
  }
}

function findModuleCredential(credentials: readonly ModuleCredential[], token: string): ModuleCredential | undefined {
  let matched: ModuleCredential | undefined
  for (const credential of credentials) {
    if (timingSafeCompare(token, credential.token))
      matched = credential
  }
  return matched
}

/**
 * Normalizes one WebSocket resource limit.
 *
 * Before:
 * - NaN, Infinity, fractional, or out-of-range configuration
 *
 * After:
 * - A finite integer within the declared security bounds
 */
function normalizeServerWsLimit(value: number | undefined, defaultValue: number, minimum: number, maximum: number) {
  const candidate = typeof value === 'number' && Number.isFinite(value) ? value : defaultValue
  return Math.min(maximum, Math.max(minimum, Math.floor(candidate)))
}

/**
 * Builds the only event-derived fields permitted at the websocket logger boundary.
 *
 * The event body, route object, delivery object, and thrown transport errors are
 * deliberately excluded. Source identity comes from the server-authenticated peer,
 * while payload size preserves enough transport observability without content.
 */
function createRoutingLogFields(
  event: WebSocketEvent,
  payload: string,
  fromPeer: AuthenticatedPeer,
  options?: {
    delivery?: DeliveryConfig
    failureCategory?: 'peer-send-failed'
    toPeer?: AuthenticatedPeer
  },
) {
  const requestedDeliveryMode = options?.delivery?.mode
  // Parsed websocket envelopes are runtime data despite their TypeScript shape.
  // Only protocol modes that the gateway actually implements may reach logs.
  const deliveryMode = requestedDeliveryMode === 'consumer' || requestedDeliveryMode === 'consumer-group'
    ? requestedDeliveryMode
    : 'broadcast'

  return {
    eventType: event.type,
    eventId: event.metadata?.event?.id,
    sourceKind: fromPeer.identity?.kind,
    sourceId: fromPeer.identity?.id,
    sourcePluginId: fromPeer.identity?.plugin?.id,
    payloadByteLength: Buffer.byteLength(payload, 'utf8'),
    fromPeer: fromPeer.peer.id,
    fromPeerName: fromPeer.name,
    deliveryMode,
    ...(options?.toPeer
      ? {
          toPeer: options.toPeer.peer.id,
          toPeerName: options.toPeer.name,
        }
      : {}),
    ...(options?.failureCategory
      ? { failureCategory: options.failureCategory }
      : {}),
  }
}

/**
 * Sends an event to a specific peer.
 * Converts the event to JSON format before transmission.
 * @internal
 */
function send(peer: Peer, event: WebSocketBaseEvent<string, unknown> | string) {
  peer.send(stringifyEvent(event))
}

export interface AppOptions {
  instanceId?: string
  auth?: {
    /** Generic pairing token. It authenticates a peer but grants no protected module capabilities. */
    token: string
    /** Session credentials bound to exact module identities and least-privilege capabilities. */
    moduleCredentials?: readonly ModuleCredential[]
  }
  logger?: {
    app?: { level?: LogLevelString, format?: Format }
    websocket?: { level?: LogLevelString, format?: Format }
  }
  routing?: {
    middleware?: RouteMiddleware[]
    allowBypass?: boolean
    policy?: RoutingPolicy
  }
  heartbeat?: {
    readTimeout?: number
    message?: MessageHeartbeat | string
  }
  security?: {
    /** Maximum decoded WebSocket message size accepted by the transport. @default 8388608 */
    maxMessageBytes?: number
    /** Maximum simultaneous WebSocket connections per server instance. @default 64 */
    maxConnections?: number
    /** Maximum connections waiting for message-based authentication. @default 8 */
    maxUnauthenticatedConnections?: number
    /** Maximum messages accepted from one connection in one rate window. @default 1000 */
    maxMessagesPerWindow?: number
    /** Per-connection message-rate window in milliseconds. @default 10000 */
    messageWindowMs?: number
    /** Time allowed for a connection to authenticate in milliseconds. @default 5000 */
    authenticationTimeoutMs?: number
    /** Exact non-loopback browser origins allowed to open WebSockets. @default [] */
    allowedOrigins?: string[]
  }
}

/**
 * Normalizes logger settings from explicit options and environment variables.
 *
 * Use when:
 * - The runtime should support config-driven and env-driven logging
 * - App and websocket logger settings need consistent defaults
 *
 * Expects:
 * - Explicit websocket settings to override app-level defaults
 *
 * Returns:
 * - The resolved app and websocket logger configuration
 */
export function normalizeLoggerConfig(options?: AppOptions) {
  const appLogLevel = optionOrEnv(options?.logger?.app?.level, 'LOG_LEVEL', LogLevelString.Log, { validator: (value): value is LogLevelString => availableLogLevelStrings.includes(value as LogLevelString) })
  const appLogFormat = optionOrEnv(options?.logger?.app?.format, 'LOG_FORMAT', Format.Pretty, { validator: (value): value is Format => Object.values(Format).includes(value as Format) })
  const websocketLogLevel = options?.logger?.websocket?.level || appLogLevel || LogLevelString.Log
  const websocketLogFormat = options?.logger?.websocket?.format || appLogFormat || Format.Pretty

  return {
    appLogLevel,
    appLogFormat,
    websocketLogLevel,
    websocketLogFormat,
  }
}

/**
 * Creates the H3 websocket application and its in-memory peer registry.
 *
 * Sets up a complete websocket server with:
 * - Peer authentication and lifecycle management
 * - Module registration and discovery (registry sync)
 * - Consumer-based event routing for load distribution
 * - Health checking with automatic peer removal on timeout
 * - Event routing with optional policy-based filtering
 * - Heartbeat monitoring for liveness detection
 *
 * Use when:
 * - Embedding the AIRI websocket runtime inside a server process
 * - Spinning up a testable application instance before binding a socket listener
 *
 * Expects:
 * - Caller lifecycle management to invoke `dispose` when the app is no longer needed
 * - Auth token (if provided) must be validated for all clients
 * - Routing middleware should be stateless and idempotent
 *
 * Returns:
 * - The H3 app at `/ws` endpoint plus cleanup helpers for peer shutdown and timer disposal
 *
 * Ownership:
 * - Manages peer registry and module registry as internal mutable state
 * - Owns all timers and intervals created during setup
 * - Consumer orchestrator state is isolated within this function scope
 */
export function setupApp(options?: AppOptions): { app: H3, closeAllPeers: () => void, dispose: () => void } {
  // === Configuration & State Initialization ===
  const instanceId = options?.instanceId || optionOrEnv(undefined, 'SERVER_INSTANCE_ID', nanoid())
  const authToken = optionOrEnv(options?.auth?.token, 'AUTHENTICATION_TOKEN', '')
  const moduleCredentials = (options?.auth?.moduleCredentials ?? []).map<ModuleCredential>(credential => ({
    token: credential.token,
    module: {
      name: credential.module.name,
      index: credential.module.index,
      identity: {
        ...credential.module.identity,
        plugin: { ...credential.module.identity.plugin },
        labels: credential.module.identity.labels ? { ...credential.module.identity.labels } : undefined,
      },
    },
    capabilities: {
      emit: [...(credential.capabilities.emit ?? [])],
      exclusiveEmit: [...(credential.capabilities.exclusiveEmit ?? [])],
      configure: [...(credential.capabilities.configure ?? [])],
    },
  }))
  validateModuleCredentials(moduleCredentials, authToken)
  const protectedModuleNames = new Set(moduleCredentials.map(credential => credential.module.name))
  const protectedEmitEvents = new Set(
    moduleCredentials.flatMap(credential => credential.capabilities.exclusiveEmit ?? []).filter(event => event !== '*'),
  )

  const { appLogLevel, appLogFormat, websocketLogLevel, websocketLogFormat } = normalizeLoggerConfig(options)

  const appLogger = useLogg('@proj-airi/server-runtime').withLogLevel(logLevelStringToLogLevelMap[appLogLevel]).withFormat(appLogFormat)
  const logger = useLogg('@proj-airi/server-runtime:websocket').withLogLevel(logLevelStringToLogLevelMap[websocketLogLevel]).withFormat(websocketLogFormat)

  const app = new H3({
    onError: error => appLogger.withError(error).error('an error occurred'),
  })

  // === Registries & Orchestrators ===
  const peerStore = createServerWsPeerStore<AuthenticatedPeer>()
  const peers = peerStore.peers
  const peersByModule = new Map<string, Map<number | undefined, AuthenticatedPeer>>()
  const consumers = createConsumerOrchestrator()
  // These bounds preserve high-frequency streaming traffic while preventing unbounded
  // connection registries and per-peer message processing.
  const maxConnections = normalizeServerWsLimit(options?.security?.maxConnections, 64, 1, 1_024)
  const maxUnauthenticatedConnections = normalizeServerWsLimit(options?.security?.maxUnauthenticatedConnections, 8, 1, maxConnections)
  const maxMessagesPerWindow = normalizeServerWsLimit(options?.security?.maxMessagesPerWindow, 1_000, 10, 10_000)
  const messageWindowMs = normalizeServerWsLimit(options?.security?.messageWindowMs, 10_000, 1_000, 60_000)
  const authenticationTimeoutMs = normalizeServerWsLimit(options?.security?.authenticationTimeoutMs, 5_000, 1_000, 60_000)
  const trafficGuard = createServerWsTrafficGuard({
    maxConnections,
    maxUnauthenticatedConnections,
    maxMessagesPerWindow,
    messageWindowMs,
  })
  const authenticationTimeouts = new Map<string, ReturnType<typeof setTimeout>>()
  const allowedOrigins = options?.security?.allowedOrigins ?? []
  const heartbeatTtlMs = options?.heartbeat?.readTimeout ?? serverWsDefaultHeartbeatTtlMs
  const heartbeatMessage = options?.heartbeat?.message ?? MessageHeartbeat.Pong
  const RESPONSES = createResponses(instanceId)
  const routingMiddleware = [
    ...(options?.routing?.policy ? [createPolicyMiddleware(options.routing.policy)] : []),
    ...(options?.routing?.middleware ?? []),
  ]

  const healthCheckIntervalMs = resolveServerWsHealthCheckIntervalMs(heartbeatTtlMs)
  let disposed = false

  // === Health Check & Peer Liveness ===
  function broadcastPeerHealthy(peerInfo: AuthenticatedPeer, parentId?: string) {
    if (!peerInfo.name || !peerInfo.identity) {
      return
    }

    broadcastToAuthenticated({
      type: 'registry:modules:health:healthy',
      data: { name: peerInfo.name, index: peerInfo.index, identity: peerInfo.identity },
      metadata: createEventMetadata(instanceId, parentId),
    })
  }

  function markPeerAlive(peerInfo: AuthenticatedPeer, options?: { parentId?: string, logMessage?: string }) {
    peerInfo.lastHeartbeatAt = Date.now()
    peerInfo.missedHeartbeats = 0

    if (peerInfo.healthy === false && peerInfo.authenticated) {
      peerInfo.healthy = true
      logger.withFields({ peer: peerInfo.peer.id, peerName: peerInfo.name }).debug(options?.logMessage ?? 'peer activity recovered, marking healthy')
      broadcastPeerHealthy(peerInfo, options?.parentId)
    }
  }

  function resetRoutingState(force = false) {
    if (!force && peers.size > 0) {
      return
    }

    peers.clear()
    peersByModule.clear()
    consumers.clear()
  }

  const healthCheckInterval = setInterval(() => {
    const now = Date.now()
    for (const [id, peerInfo] of peers.entries()) {
      if (!peerInfo.lastHeartbeatAt) {
        continue
      }

      const elapsed = now - peerInfo.lastHeartbeatAt
      if (elapsed > healthCheckIntervalMs) {
        peerInfo.missedHeartbeats = (peerInfo.missedHeartbeats ?? 0) + 1
      }
      else {
        peerInfo.missedHeartbeats = 0
      }

      if (peerInfo.missedHeartbeats >= serverWsHealthCheckMissesDead) {
        // 10 consecutive misses — completely dead, drop the peer
        logger.withFields({ peer: id, peerName: peerInfo.name, missedHeartbeats: peerInfo.missedHeartbeats }).debug('heartbeat expired after max misses, dropping peer')
        try {
          peerInfo.peer.close?.()
        }
        catch (error) {
          logger.withFields({ peer: id, peerName: peerInfo.name }).withError(error as Error).debug('failed to close expired peer')
        }

        removePeerConnection(peerInfo, 'heartbeat expired')
      }
      else if (peerInfo.missedHeartbeats >= serverWsHealthCheckMissesUnhealthy && peerInfo.healthy !== false && peerInfo.name && peerInfo.identity) {
        // 5 consecutive misses — mark unhealthy
        peerInfo.healthy = false
        logger.withFields({ peer: id, peerName: peerInfo.name, missedHeartbeats: peerInfo.missedHeartbeats }).debug('heartbeat late, marking unhealthy')
        broadcastToAuthenticated({
          type: 'registry:modules:health:unhealthy',
          data: { name: peerInfo.name, index: peerInfo.index, identity: peerInfo.identity, reason: 'heartbeat late' },
          metadata: createEventMetadata(instanceId),
        })
      }
    }
  }, healthCheckIntervalMs)
  if (typeof healthCheckInterval === 'object') {
    healthCheckInterval.unref?.()
  }

  // === Module Registry & Consumer Management ===
  function registerModulePeer(p: AuthenticatedPeer, name: string, index?: number) {
    if (!peersByModule.has(name)) {
      peersByModule.set(name, new Map())
    }

    const group = peersByModule.get(name)!
    if (group.has(index)) {
      // log instead of silent overwrite
      logger.withFields({ name, index }).debug('peer replaced for module')
    }

    p.healthy = true
    group.set(index, p)
    broadcastRegistrySync()
  }

  function registerConsumer(peerId: string, event: string, mode: ReturnType<typeof normalizeConsumerMode>, group?: string, priority?: number) {
    consumers.register({ peerId, event, mode, group, priority })
  }

  function unregisterConsumer(peerId: string, event: string, mode: ReturnType<typeof normalizeConsumerMode>, group?: string) {
    consumers.unregister({ peerId, event, mode, group })
  }

  function unregisterPeerConsumers(peerId: string) {
    consumers.unregisterPeer(peerId)
  }

  function selectConsumer(event: WebSocketEvent, fromPeerId: string, delivery?: DeliveryConfig) {
    if (!isConsumerDeliveryMode(delivery?.mode)) {
      return
    }

    const selectedPeerId = consumers.select({
      eventType: event.type,
      fromPeerId,
      delivery,
      candidates: consumers.listFor({
        event: event.type,
        mode: delivery?.mode,
        group: delivery?.group,
      }).map(entry => ({
        peerId: entry.peerId,
        priority: entry.priority,
        registeredAt: entry.registeredAt,
        authenticated: Boolean(peers.get(entry.peerId)?.authenticated),
        healthy: peers.get(entry.peerId)?.healthy,
      })),
    })

    if (!selectedPeerId) {
      return
    }

    return peers.get(selectedPeerId)
  }

  function unregisterModuleRegistration(
    peerInfo: AuthenticatedPeer,
    options?: { reason?: string, unregisterConsumers?: boolean },
  ) {
    if (options?.unregisterConsumers !== false) {
      unregisterPeerConsumers(peerInfo.peer.id)
    }

    if (!peerInfo.name)
      return

    const group = peersByModule.get(peerInfo.name)
    if (group) {
      group.delete(peerInfo.index)

      if (group.size === 0) {
        peersByModule.delete(peerInfo.name)
      }
    }

    // broadcast module:de-announced to all authenticated peers
    if (peerInfo.identity) {
      broadcastToAuthenticated({
        type: 'module:de-announced',
        data: { name: peerInfo.name, index: peerInfo.index, identity: peerInfo.identity, reason: options?.reason },
        metadata: createEventMetadata(instanceId),
      })
    }

    peerInfo.name = ''
    peerInfo.index = undefined

    broadcastRegistrySync()
  }

  function unregisterModulePeer(peerInfo: AuthenticatedPeer, reason?: string) {
    unregisterModuleRegistration(peerInfo, { reason })
  }

  function clearAuthenticationTimeout(peerId: string) {
    const timeout = authenticationTimeouts.get(peerId)
    if (timeout)
      clearTimeout(timeout)
    authenticationTimeouts.delete(peerId)
  }

  function removePeerConnection(peerInfo: AuthenticatedPeer, reason?: string) {
    if (!peers.has(peerInfo.peer.id)) {
      return
    }

    peers.delete(peerInfo.peer.id)
    trafficGuard.close(peerInfo.peer.id)
    clearAuthenticationTimeout(peerInfo.peer.id)
    unregisterModulePeer(peerInfo, reason)
  }

  function listKnownModules() {
    return Array.from(peers.values())
      .filter(peerInfo => peerInfo.name && peerInfo.identity)
      .map(peerInfo => ({
        name: peerInfo.name,
        index: peerInfo.index,
        identity: peerInfo.identity!,
      }))
  }

  // === Broadcasting & Registry Synchronization ===
  function sendRegistrySync(peer: Peer, parentId?: string) {
    send(peer, {
      type: 'registry:modules:sync',
      data: { modules: listKnownModules() },
      metadata: createEventMetadata(instanceId, parentId),
    })
  }

  function broadcastRegistrySync() {
    for (const p of peers.values()) {
      if (p.authenticated) {
        sendRegistrySync(p.peer)
      }
    }
  }

  function broadcastToAuthenticated(event: WebSocketEvent<Record<string, unknown>>) {
    for (const p of peers.values()) {
      if (p.authenticated) {
        send(p.peer, event)
      }
    }
  }

  // === WebSocket Gateway Handler ===
  // Handles peer lifecycle: open, message, error, close
  const websocketGateway = createGateway({
    handler: {
      upgrade: (request) => {
        const origin = request.headers.get('origin') ?? undefined
        if (isServerWsOriginAllowed(origin, allowedOrigins)) {
          return
        }

        logger.withFields({ origin }).warn('websocket upgrade rejected by origin policy')
        return new Response('Forbidden WebSocket origin', { status: 403 })
      },
      open: (peer) => {
        const connectionDecision = trafficGuard.open(peer.id, false)
        if (connectionDecision.accepted === false) {
          logger.withFields({
            peer: peer.id,
            peerRemote: peer.remoteAddress,
            reason: connectionDecision.reason,
          }).warn('connection rejected by traffic limits')
          peer.close?.(1013, 'Server connection limit exceeded')
          return
        }

        peers.set(peer.id, { peer, authenticated: false, name: '', lastHeartbeatAt: Date.now() })

        const timeout = setTimeout(() => {
          const peerInfo = peers.get(peer.id)
          if (!peerInfo || peerInfo.authenticated) {
            return
          }

          logger.withFields({ peer: peer.id, peerRemote: peer.remoteAddress }).warn('authentication timed out')
          peer.close?.(1008, 'Authentication timeout')
          removePeerConnection(peerInfo, 'authentication timeout')
        }, authenticationTimeoutMs)
        if (typeof timeout === 'object')
          timeout.unref?.()
        authenticationTimeouts.set(peer.id, timeout)

        logger.withFields({ peer: peer.id, activePeers: peers.size }).log('connected')
      },
      message: (peer, message) => {
        const authenticatedPeer = peers.get(peer.id)
        let event: WebSocketEvent

        const messageDecision = trafficGuard.acceptMessage(peer.id)
        if (messageDecision.accepted === false) {
          logger.withFields({
            peer: peer.id,
            peerRemote: peer.remoteAddress,
            reason: messageDecision.reason,
          }).warn('connection closed by message traffic limits')
          peer.close?.(1008, 'Message rate limit exceeded')
          if (authenticatedPeer)
            removePeerConnection(authenticatedPeer, 'message rate limit exceeded')
          return
        }

        try {
          const text = message.text()
          const controlFrame = heartbeatFrameFrom(text)

          // Some websocket runtimes surface control frames as plain text messages instead of
          // exposing them through dedicated ping/pong hooks. Treat those payloads as transport
          // liveness only so they do not leak into the application event protocol.
          if (controlFrame) {
            if (authenticatedPeer) {
              markPeerAlive(authenticatedPeer, { logMessage: 'ping/pong recovered, marking healthy' })
            }

            return
          }

          event = parseEvent(text)
        }
        catch (err) {
          if (isAiriWebSocketEventFormatError(err)) {
            send(peer, RESPONSES.error(ServerErrorMessages.invalidEventFormat))
            return
          }

          const errorMessage = errorMessageFrom(err) ?? 'Unknown JSON parsing error'
          send(peer, RESPONSES.error(createInvalidJsonServerErrorMessage(errorMessage)))

          return
        }

        logger.withFields({
          peer: peer.id,
          peerAuthenticated: authenticatedPeer?.authenticated,
          peerModule: authenticatedPeer?.name,
          peerModuleIndex: authenticatedPeer?.index,
        }).debug('received event')

        if (authenticatedPeer) {
          markPeerAlive(authenticatedPeer, { parentId: event.metadata?.event?.id })
        }

        if (event.type === 'transport:connection:heartbeat') {
          if (authenticatedPeer) {
            markPeerAlive(authenticatedPeer, {
              parentId: event.metadata?.event?.id,
              logMessage: 'heartbeat recovered, marking healthy',
            })
          }

          if (event.data.kind === MessageHeartbeatKind.Ping)
            send(peer, RESPONSES.heartbeat(MessageHeartbeatKind.Pong, heartbeatMessage, event.metadata?.event?.id))
          return
        }

        if (event.type === 'module:authenticate') {
          const clientToken = typeof event.data.token === 'string' ? event.data.token : ''
          const requestedModule = (event.data as { module?: unknown }).module
          const moduleCredential = findModuleCredential(moduleCredentials, clientToken)
          const pairingCredentialMatched = timingSafeCompare(clientToken, authToken)

          if (!authenticatedPeer || authenticatedPeer.authenticated || !isValidModuleBinding(requestedModule)) {
            send(peer, RESPONSES.error(ServerErrorMessages.moduleAuthenticationInvalid, event.metadata?.event?.id))
            return
          }

          if (!moduleCredential && !pairingCredentialMatched) {
            logger.withFields({ peer: peer.id, peerRemote: peer.remoteAddress, peerRequest: peer.request?.url }).log('authentication failed')
            send(peer, RESPONSES.error(ServerErrorMessages.invalidToken, event.metadata?.event?.id))
            peer.close?.(1008, 'Authentication failed')
            removePeerConnection(authenticatedPeer, 'authentication failed')
            return
          }

          if (moduleCredential && !moduleBindingsMatch(moduleCredential.module, requestedModule)) {
            send(peer, RESPONSES.error(ServerErrorMessages.invalidToken, event.metadata?.event?.id))
            peer.close?.(1008, 'Authentication failed')
            removePeerConnection(authenticatedPeer, 'module credential mismatch')
            return
          }

          if (!moduleCredential && protectedModuleNames.has(requestedModule.name)) {
            send(peer, RESPONSES.error(ServerErrorMessages.invalidToken, event.metadata?.event?.id))
            peer.close?.(1008, 'Authentication failed')
            removePeerConnection(authenticatedPeer, 'protected module credential required')
            return
          }

          const boundModule = moduleCredential?.module ?? requestedModule
          const duplicatePrincipal = moduleCredential
            ? Array.from(peers.values()).find(other => (
                other.peer.id !== peer.id
                && other.authenticated
                && other.boundModule
                && moduleBindingsMatch(other.boundModule, boundModule)
              ))
            : undefined
          if (duplicatePrincipal) {
            send(peer, RESPONSES.error(ServerErrorMessages.moduleAlreadyRegistered, event.metadata?.event?.id))
            peer.close?.(1008, 'Module principal already active')
            removePeerConnection(authenticatedPeer, 'duplicate module principal')
            return
          }

          authenticatedPeer.authenticated = true
          authenticatedPeer.boundModule = boundModule
          authenticatedPeer.credentialKind = moduleCredential ? 'module' : 'pairing'
          authenticatedPeer.capabilities = moduleCredential?.capabilities ?? {}
          trafficGuard.authenticate(peer.id)
          clearAuthenticationTimeout(peer.id)

          send(peer, RESPONSES.authenticated(event.metadata?.event?.id))
          sendRegistrySync(peer, event.metadata?.event?.id)
          return
        }

        const p = peers.get(peer.id)
        if (!p?.authenticated) {
          logger.withFields({ peer: peer.id, peerName: p?.name, peerRemote: peer.remoteAddress, peerRequest: peer.request?.url }).debug('not authenticated')
          send(peer, RESPONSES.notAuthenticated(event.metadata?.event?.id))
          return
        }

        if (event.type !== 'module:announce' && (!p.name || !p.identity)) {
          send(peer, RESPONSES.error(ServerErrorMessages.mustAnnounceBeforeEvents, event.metadata?.event?.id))
          return
        }

        if (event.type === 'module:announce') {
          const { name, index, identity } = event.data as { name: string, index?: number, identity?: MetadataEventSource }
          if (!name || typeof name !== 'string') {
            send(peer, RESPONSES.error(ServerErrorMessages.moduleAnnounceNameInvalid, event.metadata?.event?.id))
            return
          }
          if (index !== undefined && (!Number.isInteger(index) || index < 0)) {
            send(peer, RESPONSES.error(ServerErrorMessages.moduleAnnounceIndexInvalid, event.metadata?.event?.id))
            return
          }
          if (!identity || identity.kind !== 'plugin' || !identity.plugin?.id) {
            send(peer, RESPONSES.error(ServerErrorMessages.moduleAnnounceIdentityInvalid, event.metadata?.event?.id))
            return
          }

          const requestedBinding = { name, index, identity }
          if (!p.boundModule || !isValidModuleBinding(requestedBinding) || !moduleBindingsMatch(p.boundModule, requestedBinding)) {
            send(peer, RESPONSES.error(ServerErrorMessages.moduleIdentityMismatch, event.metadata?.event?.id))
            return
          }

          const activePrincipal = peersByModule.get(name)?.get(index)
          if (p.credentialKind === 'module' && activePrincipal && activePrincipal.peer.id !== peer.id) {
            send(peer, RESPONSES.error(ServerErrorMessages.moduleAlreadyRegistered, event.metadata?.event?.id))
            return
          }

          p.name = p.boundModule.name
          p.index = p.boundModule.index
          p.identity = p.boundModule.identity
          registerModulePeer(p, p.name, p.index)

          for (const other of peers.values()) {
            if (other.authenticated && other.peer.id !== peer.id) {
              send(other.peer, {
                type: 'module:announced',
                data: { name: p.name, index: p.index, identity: p.identity },
                metadata: createEventMetadata(instanceId, event.metadata?.event?.id),
              })
            }
          }
          return
        }

        if (event.type === 'ui:configure') {
          const data = event.data as {
            moduleName?: string
            moduleIndex?: number
            identity?: MetadataEventSource
            config?: Record<string, unknown>
          }
          const moduleName = data.moduleName ?? data.identity?.plugin?.id ?? ''
          const moduleIndex = data.moduleIndex
          if (!moduleName) {
            send(peer, RESPONSES.error(ServerErrorMessages.uiConfigureModuleNameInvalid, event.metadata?.event?.id))
            return
          }
          if (moduleIndex !== undefined && (!Number.isInteger(moduleIndex) || moduleIndex < 0)) {
            send(peer, RESPONSES.error(ServerErrorMessages.uiConfigureModuleIndexInvalid, event.metadata?.event?.id))
            return
          }
          const mayConfigure = p.credentialKind === 'module'
            ? capabilityAllows(p.capabilities?.configure, moduleName)
            : !protectedModuleNames.has(moduleName)
          if (!mayConfigure) {
            send(peer, RESPONSES.error(ServerErrorMessages.configureCapabilityDenied, event.metadata?.event?.id))
            return
          }

          const target = peersByModule.get(moduleName)?.get(moduleIndex)
          if (!target) {
            send(peer, RESPONSES.error(ServerErrorMessages.moduleNotFound, event.metadata?.event?.id))
            return
          }

          send(target.peer, {
            type: 'module:configure',
            data: { config: data.config ?? {} },
            metadata: {
              ...event.metadata,
              source: p.identity,
            },
          })
          return
        }

        if (event.type === 'module:consumer:register' || event.type === 'module:consumer:unregister') {
          const data = event.data as {
            event?: string
            mode?: 'consumer' | 'consumer-group'
            group?: string
            priority?: number
          }
          if (!data.event || typeof data.event !== 'string') {
            send(peer, RESPONSES.error(ServerErrorMessages.moduleConsumerEventInvalid, event.metadata?.event?.id))
            return
          }

          if (event.type === 'module:consumer:register') {
            registerConsumer(
              peer.id,
              data.event,
              normalizeConsumerMode(data.mode, data.group),
              data.group,
              normalizeConsumerPriority(data.priority),
            )
          }
          else {
            unregisterConsumer(peer.id, data.event, normalizeConsumerMode(data.mode, data.group), data.group)
          }
          return
        }

        const mayEmit = p.credentialKind === 'module'
          ? capabilityAllows(p.capabilities?.emit, event.type)
          : !protectedEmitEvents.has(event.type)
        if (!mayEmit) {
          send(peer, RESPONSES.error(ServerErrorMessages.eventCapabilityDenied, event.metadata?.event?.id))
          return
        }

        event = {
          ...event,
          metadata: {
            ...event.metadata,
            source: p.identity!,
          },
        }

        const payload = stringifyEvent(event)
        const allowBypass = options?.routing?.allowBypass !== false
        const shouldBypass = Boolean(event.route?.bypass && allowBypass && isDevtoolsPeer(p))
        const destinations = shouldBypass ? undefined : collectDestinations(event)
        const delivery = shouldBypass ? undefined : resolveEventDelivery(event)
        const effectiveRoutingMiddleware = shouldBypass ? [] : routingMiddleware
        const decision = forEachEventMiddlewares({
          event,
          fromPeer: p,
          peers,
          destinations,
          middleware: effectiveRoutingMiddleware,
        })

        if (decision?.type === 'drop') {
          logger.withFields(createRoutingLogFields(event, payload, p, { delivery })).debug('routing dropped event')
          return
        }

        const selectedConsumer = selectConsumer(event, peer.id, delivery)
        if (delivery && (delivery.mode === 'consumer' || delivery.mode === 'consumer-group')) {
          if (!selectedConsumer) {
            logger.withFields(createRoutingLogFields(event, payload, p, { delivery })).warn('no consumer registered for event delivery')
            if (delivery.required) {
              send(peer, RESPONSES.error(ServerErrorMessages.noConsumerRegistered, event.metadata?.event?.id))
            }
            return
          }

          try {
            logger.withFields(createRoutingLogFields(event, payload, p, {
              delivery,
              toPeer: selectedConsumer,
            })).debug('sending event to selected consumer')

            selectedConsumer.peer.send(payload)
          }
          catch {
            logger.withFields(createRoutingLogFields(event, payload, p, {
              delivery,
              failureCategory: 'peer-send-failed',
              toPeer: selectedConsumer,
            })).error('failed to send event to selected consumer, removing peer')

            removePeerConnection(selectedConsumer, 'consumer send failed')
          }
          return
        }

        const targetIds = decision?.type === 'targets' ? decision.targetIds : undefined
        const shouldBroadcast = decision?.type === 'broadcast' || !targetIds

        logger.withFields(createRoutingLogFields(event, payload, p, { delivery })).debug('broadcasting event to peers')

        for (const [id, other] of peers.entries()) {
          if (id === peer.id) {
            logger.withFields(createRoutingLogFields(event, payload, p, {
              delivery,
              toPeer: p,
            })).debug('not sending event to self')
            continue
          }

          if (!other.authenticated) {
            logger.withFields(createRoutingLogFields(event, payload, p, {
              delivery,
              toPeer: other,
            })).debug('not sending event to unauthenticated peer')
            continue
          }

          if (!shouldBroadcast && targetIds && !targetIds.has(id)) {
            continue
          }

          if (shouldBroadcast && destinations !== undefined && !matchesDestinations(destinations, other)) {
            continue
          }

          try {
            logger.withFields(createRoutingLogFields(event, payload, p, {
              delivery,
              toPeer: other,
            })).debug('sending event to peer')
            other.peer.send(payload)
          }
          catch {
            logger.withFields(createRoutingLogFields(event, payload, p, {
              delivery,
              failureCategory: 'peer-send-failed',
              toPeer: other,
            })).error('failed to send event to peer, removing peer')
            logger.withFields({ peer: peer.id, peerName: other.name }).debug('removing closed peer')
            removePeerConnection(other, 'send failed')
          }
        }
      },
      error: (peer) => {
        logger.withFields({
          peer: peer.id,
          failureCategory: 'gateway-error',
        }).error('an error occurred')
      },
      close: (peer, details) => {
        const p = peers.get(peer.id)
        const now = Date.now()
        const peerHealthy = p?.healthy
        const peerMissedHeartbeats = p?.missedHeartbeats
        const safeDetails = details ?? {}
        const closeCode = typeof safeDetails.code === 'number' ? safeDetails.code : undefined
        const closeWasClean = typeof (safeDetails as { wasClean?: unknown }).wasClean === 'boolean'
          ? (safeDetails as { wasClean?: unknown }).wasClean
          : undefined
        const heartbeatLastSeenAt = p?.lastHeartbeatAt
        const heartbeatSilentForMs = heartbeatLastSeenAt ? now - heartbeatLastSeenAt : undefined
        const likelyHeartbeatExpiry = Boolean(
          p
          && typeof heartbeatSilentForMs === 'number'
          && heartbeatSilentForMs > heartbeatTtlMs,
        )
        const likelySilentNetworkClose = closeCode === 1005

        if (p) {
          removePeerConnection(p, 'connection closed')
        }
        else {
          trafficGuard.close(peer.id)
          clearAuthenticationTimeout(peer.id)
        }

        logger.withFields({
          peer: peer.id,
          failureCategory: 'gateway-close',
          closeCode,
          closeWasClean,
          activePeers: peers.size,
          peerAuthenticated: p?.authenticated,
          peerHealthy,
          peerMissedHeartbeats,
          heartbeatLastSeenAt,
          heartbeatSilentForMs,
          heartbeatTtlMs,
          healthCheckIntervalMs,
          likelyHeartbeatExpiry,
          likelySilentNetworkClose,
        }).log('closed')
      },
    },
    dispose: () => {
      clearInterval(healthCheckInterval)
      closeAllPeers()
      trafficGuard.clear()
      for (const timeout of authenticationTimeouts.values())
        clearTimeout(timeout)
      authenticationTimeouts.clear()
      resetRoutingState(true)
    },
  })

  app.get('/ws', defineWebSocketHandler(websocketGateway.handler))

  function closeAllPeers() {
    logger.withFields({ totalPeers: peers.size }).log('closing all peers')

    for (const peerInfo of Array.from(peers.values())) {
      logger.withFields({
        peer: peerInfo.peer.id,
        peerName: peerInfo.name,
      }).debug('closing peer')

      try {
        peerInfo.peer.close?.()
      }
      catch (error) {
        logger
          .withFields({
            peer: peerInfo.peer.id,
            peerName: peerInfo.name,
          })
          .withError(error as Error)
          .debug('failed to close peer during shutdown')

        // Leave the peer registered until forced disposal cleanup.
        continue
      }

      // Some websocket runtimes may never emit `close`
      // during abrupt shutdown sequences. Remove peers
      // synchronously after initiating a successful close
      // so shutdown cleanup is deterministic.
      try {
        removePeerConnection(peerInfo, 'server shutdown')
      }
      catch (error) {
        logger
          .withFields({
            peer: peerInfo.peer.id,
            peerName: peerInfo.name,
          })
          .withError(error as Error)
          .debug('failed to unregister peer during shutdown')
      }
    }
  }

  function dispose() {
    if (disposed) {
      return
    }

    disposed = true
    websocketGateway.dispose()
  }

  return {
    app,
    closeAllPeers,
    dispose,
  }
}
