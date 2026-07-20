import type { LlmStreamingControlCallManifest } from '@proj-airi/pipelines-audio'
import type { ChatTurnCorrelation, WebSocketEventOf } from '@proj-airi/server-sdk'
import type { ChatProvider } from '@xsai-ext/providers/utils'
import type { AssistantMessage, UserMessage } from '@xsai/shared-chat'

import type { DiscordMemoryContext, Memory } from '../../../database/repos/discord-memory.repo'
import type { ChatStreamEvent, ChatStreamEventContext, ContextMessage } from '../../../types/chat'
import type { SparkNotifyPerformanceResult, SparkNotifyReactionOptions } from './spark-notify-reaction'

import { errorMessageFrom } from '@moeru/std'
import { ChatQueueCapacityError, ChatTurnCancelledError } from '@proj-airi/core-agent'
import { isStageTamagotchi, isStageWeb } from '@proj-airi/stage-shared'
import { useBroadcastChannel } from '@vueuse/core'
import { Mutex } from 'es-toolkit'
import { nanoid } from 'nanoid'
import { defineStore, storeToRefs } from 'pinia'
import { ref, toRaw, watch } from 'vue'

import {
  clearDiscordMemoriesForActor,
  clearShortTermMessages,
  createMemoryRecord,
  decideMemoryAction,
  discordMemoryRepo,
  forgetDiscordMemoryForActor,
  getShortTermScopeKey,
  listDiscordMemoriesForActor,
  normalizeMemoryContent,
  reviewPendingDiscordMemory,
} from '../../../database/repos/discord-memory.repo'
import { getEventSourceKey } from '../../../utils/event-source'
import { useCharacterOrchestratorStore } from '../../character'
import { useChatOrchestratorStore } from '../../chat'
import { CHAT_STREAM_CHANNEL_NAME, CONTEXT_CHANNEL_NAME } from '../../chat/constants'
import { useChatContextStore } from '../../chat/context-store'
import { useChatMemoryStore } from '../../chat/memory-store'
import { useChatSessionStore } from '../../chat/session-store'
import { useChatStreamStore } from '../../chat/stream-store'
import { useContextObservabilityStore } from '../../devtools/context-observability'
import { useLlmStreamingControlStore } from '../../llm-streaming-control'
import { useConsciousnessStore } from '../../modules/consciousness'
import { useDiscordStore } from '../../modules/discord'
import { useProvidersStore } from '../../providers'
import { useModsServerChannelStore } from './channel-server'

export function normalizeContextSnapshot<C extends Pick<ChatStreamEventContext, 'contexts'>>(contexts: C): C {
  return {
    ...contexts,
    contexts: Object.fromEntries(
      Object
        .entries(toRaw(contexts.contexts))
        .map(([key, ctx]) => [
          key,
          ctx.map(c => toRaw(c)),
        ]),
    ),
  }
}

const DISCORD_LOCAL_AI_NOT_READY_MESSAGE = 'AIRI received your Discord message, but the local chat provider/model is not ready yet. Please open AIRI, choose a provider and model, then try again.'
const DISCORD_PROVIDER_START_FAILED_MESSAGE = 'AIRI received your Discord message, but the selected chat provider could not start. Please check the provider settings in AIRI and try again.'
const DISCORD_CHAT_INGEST_FAILED_MESSAGE = 'AIRI received your Discord message, but the local chat request failed before a response could be generated. Please check AIRI and try again.'
const DISCORD_CHAT_QUEUE_FULL_MESSAGE = 'AIRI is handling too many chat requests right now. Please retry after an earlier request finishes.'
const DISCORD_TURN_CORRELATION_REQUIRED_MESSAGE = 'AIRI rejected this Discord request because its turn identity was missing. Please retry.'
const DISCORD_SENSITIVE_MEMORY_REJECTION_MESSAGE = 'This type of content should not be saved as long-term memory.'

/** Shared-origin key containing only bounded turn lifecycle state. */
const CONTEXT_BRIDGE_TURN_LEDGER_STORAGE_KEY = 'airi:context-bridge:discord-turn-ledger:v2'

/** Serializes the tiny shared-ledger read/modify/write transaction across windows. */
const CONTEXT_BRIDGE_TURN_LEDGER_LOCK_NAME = 'context-bridge:discord-turn-ledger'

/** Broadcasts claims and cancellations when browser storage is unavailable. */
const CONTEXT_BRIDGE_TURN_LIFECYCLE_CHANNEL_NAME = 'airi-context-bridge-discord-turn-lifecycle'

/** Legitimate ingress is capped at 64 pending turns; headroom covers completed-turn replay windows. */
const MAX_CONTEXT_BRIDGE_TURN_CLAIMS = 1_024

/** Retains a completed deadline briefly so delayed server delivery cannot replay it. */
const MIN_CONTEXT_BRIDGE_TURN_CLAIM_TTL_MS = 60_000

/** A malformed remote deadline cannot persist a browser dedupe claim indefinitely. */
const MAX_CONTEXT_BRIDGE_TURN_CLAIM_TTL_MS = 5 * 60 * 1000

/** Mirrors the bounded ingress ledger so passive-window hook state cannot grow without limit. */
const MAX_CONTEXT_BRIDGE_REMOTE_STREAM_GUARDS = 1_024

type ContextBridgeCancellationReason = 'deadline' | 'reset'
type ContextBridgeTurnLedgerEntry = [
  turnId: string,
  expiresAt: number,
  state: 'cancelled' | 'claimed',
  reason?: ContextBridgeCancellationReason,
]
type ContextBridgeTurnClaimResult = 'cancelled' | 'capacity' | 'claimed' | 'duplicate'
interface ContextBridgeTurnLifecycleMessage {
  entry: ContextBridgeTurnLedgerEntry
}

interface ContextBridgeRemoteStreamGuard {
  /** Retained only for trusted Discord turns so passive cancellation can reach Stage hooks. */
  context?: ChatStreamEventContext
  expiresAt: number
  generation: number
  lastAccessedAt: number
  sessionId: string
  streamStarted: boolean
}

interface ContextBridgeRetainedTurnLock {
  abortController: AbortController
  promise: Promise<void>
}

const fallbackContextBridgeTurnLedger = new Map<string, ContextBridgeTurnLedgerEntry>()

function isContextBridgeTurnLedgerEntry(value: unknown): value is ContextBridgeTurnLedgerEntry {
  return Array.isArray(value)
    && (value.length === 3 || value.length === 4)
    && typeof value[0] === 'string'
    && value[0].length > 0
    && typeof value[1] === 'number'
    && Number.isFinite(value[1])
    && (
      (value[2] === 'claimed' && value[3] === undefined)
      || (value[2] === 'cancelled' && (value[3] === 'deadline' || value[3] === 'reset'))
    )
}

function readContextBridgeTurnLedger(now: number): ContextBridgeTurnLedgerEntry[] {
  try {
    const serialized = globalThis.localStorage?.getItem(CONTEXT_BRIDGE_TURN_LEDGER_STORAGE_KEY)
    if (!serialized)
      return []

    const parsed: unknown = JSON.parse(serialized)
    if (!Array.isArray(parsed))
      return []

    return parsed
      .filter(isContextBridgeTurnLedgerEntry)
      .filter(([, expiresAt]) => expiresAt > now)
  }
  catch {
    // Some embedded/privacy contexts deny localStorage. The per-window fallback
    // remains bounded; Web Locks still prevent simultaneous duplicate owners.
    return []
  }
}

function writeContextBridgeTurnLedger(entries: ContextBridgeTurnLedgerEntry[]): boolean {
  try {
    globalThis.localStorage?.setItem(CONTEXT_BRIDGE_TURN_LEDGER_STORAGE_KEY, JSON.stringify(entries))
    return true
  }
  catch {
    return false
  }
}

function resolveContextBridgeTurnExpiry(deadlineAt: number, now: number): number {
  return Math.min(
    Math.max(deadlineAt + MIN_CONTEXT_BRIDGE_TURN_CLAIM_TTL_MS, now + MIN_CONTEXT_BRIDGE_TURN_CLAIM_TTL_MS),
    now + MAX_CONTEXT_BRIDGE_TURN_CLAIM_TTL_MS,
  )
}

function rememberContextBridgeTurnEntry(entry: ContextBridgeTurnLedgerEntry, now = Date.now()): void {
  for (const [turnId, existing] of fallbackContextBridgeTurnLedger) {
    if (existing[1] <= now)
      fallbackContextBridgeTurnLedger.delete(turnId)
  }

  if (!fallbackContextBridgeTurnLedger.has(entry[0]) && fallbackContextBridgeTurnLedger.size >= MAX_CONTEXT_BRIDGE_TURN_CLAIMS)
    return
  fallbackContextBridgeTurnLedger.set(entry[0], entry)
}

function claimContextBridgeTurn(turnId: string, deadlineAt: number, now = Date.now()): ContextBridgeTurnClaimResult {
  for (const [existingTurnId, entry] of fallbackContextBridgeTurnLedger) {
    if (entry[1] <= now)
      fallbackContextBridgeTurnLedger.delete(existingTurnId)
  }
  const fallbackEntry = fallbackContextBridgeTurnLedger.get(turnId)
  if (fallbackEntry && fallbackEntry[1] > now)
    return fallbackEntry[2] === 'cancelled' ? 'cancelled' : 'duplicate'

  const entries = readContextBridgeTurnLedger(now)
  const existingEntry = entries.find(([existingTurnId]) => existingTurnId === turnId)
  if (existingEntry) {
    rememberContextBridgeTurnEntry(existingEntry, now)
    return existingEntry[2] === 'cancelled' ? 'cancelled' : 'duplicate'
  }
  if (entries.length >= MAX_CONTEXT_BRIDGE_TURN_CLAIMS || fallbackContextBridgeTurnLedger.size >= MAX_CONTEXT_BRIDGE_TURN_CLAIMS)
    return 'capacity'

  const entry: ContextBridgeTurnLedgerEntry = deadlineAt <= now
    ? [turnId, resolveContextBridgeTurnExpiry(deadlineAt, now), 'cancelled', 'deadline']
    : [turnId, resolveContextBridgeTurnExpiry(deadlineAt, now), 'claimed']
  writeContextBridgeTurnLedger([...entries, entry])
  rememberContextBridgeTurnEntry(entry, now)
  if (entry[2] === 'cancelled')
    return 'cancelled'
  return 'claimed'
}

function cancelContextBridgeTurn(
  turnId: string,
  deadlineAt: number,
  reason: ContextBridgeCancellationReason,
  now = Date.now(),
): ContextBridgeTurnLedgerEntry | undefined {
  const entries = readContextBridgeTurnLedger(now)
  const entry: ContextBridgeTurnLedgerEntry = [
    turnId,
    resolveContextBridgeTurnExpiry(deadlineAt, now),
    'cancelled',
    reason,
  ]
  const existingIndex = entries.findIndex(([existingTurnId]) => existingTurnId === turnId)
  if (existingIndex >= 0)
    entries.splice(existingIndex, 1, entry)
  else if (entries.length >= MAX_CONTEXT_BRIDGE_TURN_CLAIMS)
    return undefined
  else
    entries.push(entry)

  writeContextBridgeTurnLedger(entries)
  rememberContextBridgeTurnEntry(entry, now)
  return entry
}

function getContextBridgeTurnCancellation(turnId: string, now = Date.now()): ContextBridgeCancellationReason | undefined {
  const fallbackEntry = fallbackContextBridgeTurnLedger.get(turnId)
  if (fallbackEntry && fallbackEntry[1] > now && fallbackEntry[2] === 'cancelled')
    return fallbackEntry[3]
  if (fallbackEntry)
    fallbackContextBridgeTurnLedger.delete(turnId)

  const entry = readContextBridgeTurnLedger(now).find(([existingTurnId]) => existingTurnId === turnId)
  if (!entry)
    return undefined
  rememberContextBridgeTurnEntry(entry, now)
  return entry[2] === 'cancelled' ? entry[3] : undefined
}

function isTrustedDiscordInputEvent(event: WebSocketEventOf<'input:text'>) {
  return event.metadata?.source?.kind === 'plugin'
    && event.metadata.source.plugin?.id === 'discord'
}

function isTrustedDiscordStreamContext(context: ChatStreamEvent['context']) {
  return context.input?.metadata?.source?.kind === 'plugin'
    && context.input.metadata.source.plugin?.id === 'discord'
}

/**
 * Normalizes a pre-compose hook context into the complete cancellation shape.
 *
 * Before:
 * - `{ turnId: "turn-1", composedMessage: <absent> }`
 *
 * After:
 * - `{ turnId: "turn-1", composedMessage: [] }`
 */
function normalizeRemoteStreamContext(context: ChatStreamEvent['context']): ChatStreamEventContext {
  if ('composedMessage' in context)
    return context

  return {
    ...context,
    composedMessage: [],
  }
}

function isValidDiscordTurnCorrelation(value: unknown): value is ChatTurnCorrelation {
  return typeof value === 'object'
    && value !== null
    && 'id' in value
    && typeof value.id === 'string'
    && value.id.length > 0
    && 'generation' in value
    && Number.isSafeInteger(value.generation)
    && Number(value.generation) > 0
    && 'deadlineAt' in value
    && typeof value.deadlineAt === 'number'
    && Number.isFinite(value.deadlineAt)
}

export const useContextBridgeStore = defineStore('mods:api:context-bridge', () => {
  const consumerRegistrationEvents = [
    'input:text',
    'input:text:voice',
    'input:voice',
    'chat:turn:cancel',
  ] as const
  const discordMemoryConsumerRegistration = {
    event: 'discord:memory:command',
    group: 'discord-memory-command',
  } as const
  const mutex = new Mutex()

  const chatOrchestrator = useChatOrchestratorStore()
  const chatSession = useChatSessionStore()
  const chatStream = useChatStreamStore()
  const chatContext = useChatContextStore()
  const chatMemory = useChatMemoryStore()
  const serverChannelStore = useModsServerChannelStore()
  const contextObservability = useContextObservabilityStore()
  const characterOrchestratorStore = useCharacterOrchestratorStore()
  const consciousnessStore = useConsciousnessStore()
  const providersStore = useProvidersStore()
  const discordStore = useDiscordStore()
  const { activeProvider, activeModel } = storeToRefs(consciousnessStore)
  const streamingControl = useLlmStreamingControlStore()

  const { post: broadcastContext, data: incomingContext } = useBroadcastChannel<ContextMessage, ContextMessage>({ name: CONTEXT_CHANNEL_NAME })
  const { post: broadcastStreamEvent, data: incomingStreamEvent } = useBroadcastChannel<ChatStreamEvent, ChatStreamEvent>({ name: CHAT_STREAM_CHANNEL_NAME })
  const {
    post: broadcastTurnLifecycle,
    data: incomingTurnLifecycle,
  } = useBroadcastChannel<ContextBridgeTurnLifecycleMessage, ContextBridgeTurnLifecycleMessage>({ name: CONTEXT_BRIDGE_TURN_LIFECYCLE_CHANNEL_NAME })
  type SparkNotifyBridgeMessage
    = | {
      type: 'request'
      requestId: string
      fromInstanceId: string
      payload: SparkNotifyReactionOptions
      performance?: {
        callManifests: LlmStreamingControlCallManifest[]
        timeoutMs?: number
      }
    }
    | {
      type: 'response'
      requestId: string
      toInstanceId: string
      reaction: string
      performance?: SparkNotifyPerformanceResult
    }
  const SPARK_NOTIFY_BRIDGE_CHANNEL_NAME = 'airi-spark-notify-bridge'
  const sparkNotifyBridgeInstanceId = `spark-notify-${nanoid()}`
  const sparkNotifyHostRole = ref<'main' | 'client'>('client')
  const sparkNotifyBridgeWaiters = new Map<string, {
    resolve: (result: { reaction: string, performance?: SparkNotifyPerformanceResult }) => Promise<void> | void
    timeout?: ReturnType<typeof setTimeout>
  }>()
  const { post: postSparkNotifyBridgeMessage, data: incomingSparkNotifyBridgeMessage } = useBroadcastChannel<SparkNotifyBridgeMessage, SparkNotifyBridgeMessage>({ name: SPARK_NOTIFY_BRIDGE_CHANNEL_NAME })

  const disposeHookFns = ref<Array<() => void>>([])
  const remoteStreamGuardsByTurnId = new Map<string, ContextBridgeRemoteStreamGuard>()
  const retainedTurnLocksByTurnId = new Map<string, ContextBridgeRetainedTurnLock>()
  let initialized = false

  function recordContextIngestRejected(options: {
    channel: 'server' | 'broadcast' | 'input'
    contextMessage: ContextMessage
    details?: unknown
    error: unknown
    sourceLabel?: string
  }) {
    contextObservability.recordLifecycle({
      phase: 'store-ingest-rejected',
      channel: options.channel,
      sourceKey: getEventSourceKey(options.contextMessage),
      strategy: options.contextMessage.strategy,
      lane: options.contextMessage.lane,
      contextId: options.contextMessage.contextId,
      eventId: options.contextMessage.id,
      textPreview: options.contextMessage.text,
      sourceLabel: options.sourceLabel,
      details: {
        errorMessage: errorMessageFrom(options.error) ?? 'Unknown context ingest error',
        event: options.details,
      },
    })
  }

  function ingestContextMessageSafely(options: {
    channel: 'server' | 'broadcast' | 'input'
    contextMessage: ContextMessage
    details?: unknown
    sourceLabel?: string
  }) {
    try {
      return {
        ok: true as const,
        result: chatContext.ingestContextMessage(options.contextMessage),
      }
    }
    catch (error) {
      recordContextIngestRejected({
        ...options,
        error,
      })
      return {
        ok: false as const,
      }
    }
  }

  function withStreamingCallPrompt(options: SparkNotifyReactionOptions, callPrompt: string): SparkNotifyReactionOptions {
    if (!callPrompt) {
      return options
    }

    return {
      ...options,
      messageOverride: {
        ...options.messageOverride,
        appendSystemInstructions: [
          ...(options.messageOverride?.appendSystemInstructions ?? []),
          callPrompt,
        ],
      },
    }
  }

  function sendDiscordStatusReply(event: WebSocketEventOf<'input:text'>, content: string) {
    if (!event.data.discord)
      return

    const userMessage: UserMessage = {
      role: 'user',
      content: event.data.text,
    }
    const assistantMessage: AssistantMessage = {
      role: 'assistant',
      content,
    }

    serverChannelStore.send({
      type: 'output:gen-ai:chat:message',
      data: {
        ...event.data,
        'message': assistantMessage,
        'stage-web': isStageWeb(),
        'stage-tamagotchi': isStageTamagotchi(),
        'gen-ai:chat': {
          message: userMessage,
          composedMessage: [userMessage],
          contexts: {},
          input: {
            type: event.type,
            data: event.data,
          },
        },
      },
    })
  }

  async function handleSparkNotifyReactionLocal(options: SparkNotifyReactionOptions, identity?: { id?: string, eventId?: string }) {
    const event: WebSocketEventOf<'spark:notify'> = {
      type: 'spark:notify',
      source: options.source ?? 'plugin-module-host',
      data: {
        id: identity?.id ?? nanoid(),
        eventId: identity?.eventId ?? nanoid(),
        lane: options.lane,
        kind: options.kind ?? 'ping',
        urgency: options.urgency ?? 'immediate',
        headline: options.headline,
        note: options.note,
        payload: options.payload,
        ttlMs: options.ttlMs,
        requiresAck: options.requiresAck,
        destinations: options.destinations?.length ? options.destinations : ['character'],
        metadata: options.metadata,
      },
    }

    try {
      return await characterOrchestratorStore.handleSparkNotifyWithReaction(event, {
        fallbackText: options.fallbackResponseText,
        forceResponse: options.forceResponse,
        forceTextResponse: options.forceTextResponse,
        forceSparkCommandResponse: options.forceSparkCommandResponse,
        messageOverride: options.messageOverride,
      })
    }
    catch (error) {
      console.warn('[context-bridge] spark:notify handling failed; using fallback', error)
      return options.fallbackResponseText
    }
  }

  function setSparkNotifyHostRole(role: 'main' | 'client') {
    sparkNotifyHostRole.value = role
  }

  async function dispatchSparkNotifyReaction(options: SparkNotifyReactionOptions) {
    if (sparkNotifyHostRole.value === 'main') {
      return await handleSparkNotifyReactionLocal(options)
    }

    const requestId = nanoid()
    return await new Promise<string>((resolve) => {
      const timeout = setTimeout(() => {
        sparkNotifyBridgeWaiters.delete(requestId)
        resolve(options.fallbackResponseText)
      }, 5000)

      sparkNotifyBridgeWaiters.set(requestId, {
        resolve: ({ reaction }) => {
          clearTimeout(timeout)
          resolve(reaction || options.fallbackResponseText)
        },
        timeout,
      })

      postSparkNotifyBridgeMessage({
        type: 'request',
        requestId,
        fromInstanceId: sparkNotifyBridgeInstanceId,
        payload: options,
      })
    })
  }

  async function handleSparkNotifyPerformanceLocal(options: SparkNotifyReactionOptions): Promise<SparkNotifyPerformanceResult> {
    const calls = options.calls ?? []

    if (calls.length === 0) {
      const reaction = await handleSparkNotifyReactionLocal(options)
      return {
        type: 'completed',
        reaction,
      }
    }

    const sparkNotifyId = nanoid()
    const turn = streamingControl.beginTurn({ turnId: `spark:${sparkNotifyId}` })

    let latestReaction = ''
    let reactionPromise: Promise<string> | undefined
    let dispose: (() => void) | undefined

    const calledPromise = new Promise<SparkNotifyPerformanceResult>((resolve) => {
      const disposers = calls.map(call => turn.on(call.manifest, async (payload) => {
        await call.handler(payload)
        const reaction = await (reactionPromise ?? Promise.resolve(latestReaction || options.fallbackResponseText))
        resolve({
          type: 'called',
          name: call.manifest.name,
          payload,
          reaction,
        })
      }))
      dispose = () => {
        for (const item of disposers) {
          item()
        }
      }
    })

    reactionPromise = handleSparkNotifyReactionLocal(withStreamingCallPrompt(
      options,
      turn.renderManifestPrompt(),
    ), { id: sparkNotifyId })
      .then((reaction) => {
        latestReaction = reaction
        return reaction
      })
      .catch(() => {
        latestReaction = options.fallbackResponseText
        return options.fallbackResponseText
      })

    const turnDonePromise = turn.done.then(async (result): Promise<SparkNotifyPerformanceResult> => {
      const reaction = await (reactionPromise ?? Promise.resolve(latestReaction || options.fallbackResponseText))
      return {
        type: result.type === 'cancelled' ? 'cancelled' : 'completed',
        reaction: reaction || options.fallbackResponseText,
      }
    })

    const result = await Promise.race([calledPromise, turnDonePromise])
    dispose?.()
    return result
  }

  async function dispatchSparkNotifyPerformance(options: SparkNotifyReactionOptions): Promise<SparkNotifyPerformanceResult> {
    const calls = options.calls ?? []

    if (sparkNotifyHostRole.value === 'main') {
      return await handleSparkNotifyPerformanceLocal(options)
    }

    if (calls.length === 0) {
      const reaction = await dispatchSparkNotifyReaction(options)
      return {
        type: 'completed',
        reaction,
      }
    }

    const requestId = nanoid()
    return await new Promise<SparkNotifyPerformanceResult>((resolve) => {
      const timeout = setTimeout(() => {
        sparkNotifyBridgeWaiters.delete(requestId)
        resolve(createFallbackPerformanceResult(options, 'timeout'))
      }, Math.max(1, options.timeoutMs ?? 5000))

      sparkNotifyBridgeWaiters.set(requestId, {
        resolve: async ({ reaction, performance }) => {
          clearTimeout(timeout)
          if (performance?.type === 'called' && performance.name) {
            await findPerformanceCall(options, performance.name)?.handler(performance.payload)
          }

          resolve(performance ?? createFallbackPerformanceResult(options, 'completed', reaction))
        },
        timeout,
      })

      const { calls: _calls, timeoutMs: _timeoutMs, ...payload } = options
      postSparkNotifyBridgeMessage({
        type: 'request',
        requestId,
        fromInstanceId: sparkNotifyBridgeInstanceId,
        payload,
        performance: {
          callManifests: calls.map(call => call.manifest),
          timeoutMs: options.timeoutMs,
        },
      })
    })
  }

  function createFallbackPerformanceResult(
    options: SparkNotifyReactionOptions,
    type: Extract<SparkNotifyPerformanceResult['type'], 'completed' | 'timeout'>,
    reaction?: string,
  ): SparkNotifyPerformanceResult {
    return {
      type,
      reaction: reaction || options.fallbackResponseText,
    }
  }

  function findPerformanceCall(options: SparkNotifyReactionOptions, name: string) {
    return options.calls?.find(call => call.manifest.name === name)
  }

  async function withContextBridgeExclusiveLock<T>(
    key: string,
    callback: () => Promise<T>,
    options: { waitForOwnership?: boolean } = {},
  ): Promise<T | undefined> {
    if (typeof navigator !== 'undefined' && 'locks' in navigator && typeof navigator.locks.request === 'function') {
      // BroadcastChannel delivers the same bridge request to every Stage window.
      // `ifAvailable` makes non-owning windows skip instead of queueing and replaying
      // the same spark reaction after the first window finishes.
      if (options.waitForOwnership)
        return await navigator.locks.request(key, callback)

      return await navigator.locks.request(key, { ifAvailable: true }, async (lock) => {
        if (!lock) {
          return undefined
        }
        return await callback()
      })
    }

    return await callback()
  }

  async function retainContextBridgeTurnLock(deadlineAt: number, signal: AbortSignal): Promise<void> {
    const now = Date.now()
    const retentionMs = Math.max(0, resolveContextBridgeTurnExpiry(deadlineAt, now) - now)
    if (retentionMs === 0 || signal.aborted)
      return

    // The lock remains owned beyond provider completion because delayed delivery
    // in another renderer is still the same server turn. `dispose()` aborts this
    // bounded timer so renderer shutdown never waits for the remote deadline.
    await new Promise<void>((resolve) => {
      let settled = false
      let timeout: ReturnType<typeof setTimeout> | undefined
      const finish = () => {
        if (settled)
          return
        settled = true
        if (timeout)
          clearTimeout(timeout)
        signal.removeEventListener('abort', finish)
        resolve()
      }
      timeout = setTimeout(finish, retentionMs)
      signal.addEventListener('abort', finish, { once: true })
    })
  }

  async function claimTrustedDiscordTurn(turn: ChatTurnCorrelation): Promise<ContextBridgeTurnClaimResult | undefined> {
    if (retainedTurnLocksByTurnId.has(turn.id))
      return undefined

    const claimLedger = async () => await withContextBridgeExclusiveLock(
      CONTEXT_BRIDGE_TURN_LEDGER_LOCK_NAME,
      async () => claimContextBridgeTurn(turn.id, turn.deadlineAt),
      { waitForOwnership: true },
    )

    if (typeof navigator === 'undefined' || !('locks' in navigator) || typeof navigator.locks.request !== 'function')
      return await claimLedger()

    const abortController = new AbortController()
    let settleDecision: (claim: ContextBridgeTurnClaimResult | undefined) => void = () => {}
    let decisionSettled = false
    const decision = new Promise<ContextBridgeTurnClaimResult | undefined>((resolve) => {
      settleDecision = (claim) => {
        if (decisionSettled)
          return
        decisionSettled = true
        resolve(claim)
      }
    })

    const lockName = `context-bridge:event:input:text:${turn.id}`
    const promise = navigator.locks.request(lockName, { ifAvailable: true }, async (lock) => {
      if (!lock) {
        settleDecision(undefined)
        return
      }

      const claim = await claimLedger()
      settleDecision(claim)
      if (claim === 'claimed')
        await retainContextBridgeTurnLock(turn.deadlineAt, abortController.signal)
    })
      .catch(() => {
        settleDecision(undefined)
      })
      .then(() => undefined)
      .finally(() => {
        if (retainedTurnLocksByTurnId.get(turn.id)?.promise === promise)
          retainedTurnLocksByTurnId.delete(turn.id)
      })

    retainedTurnLocksByTurnId.set(turn.id, {
      abortController,
      promise,
    })
    return await decision
  }

  function pruneRemoteStreamGuards(now = Date.now()): void {
    for (const [turnId, guard] of remoteStreamGuardsByTurnId) {
      if (guard.expiresAt <= now)
        remoteStreamGuardsByTurnId.delete(turnId)
    }
  }

  function retainRemoteStreamContext(
    context: ChatStreamEvent['context'],
    options: { streamStarted?: boolean } = {},
  ): ContextBridgeRemoteStreamGuard | undefined {
    const now = Date.now()
    pruneRemoteStreamGuards(now)
    const existing = remoteStreamGuardsByTurnId.get(context.turnId)
    if (!existing && remoteStreamGuardsByTurnId.size >= MAX_CONTEXT_BRIDGE_REMOTE_STREAM_GUARDS)
      return undefined

    const guard: ContextBridgeRemoteStreamGuard = {
      context: isTrustedDiscordStreamContext(context)
        ? normalizeRemoteStreamContext(context)
        : existing?.context,
      expiresAt: context.deadlineAt === undefined
        ? now + MAX_CONTEXT_BRIDGE_TURN_CLAIM_TTL_MS
        : resolveContextBridgeTurnExpiry(context.deadlineAt, now),
      generation: context.generation,
      lastAccessedAt: now,
      sessionId: context.sessionId,
      streamStarted: options.streamStarted ?? existing?.streamStarted ?? false,
    }
    remoteStreamGuardsByTurnId.set(context.turnId, guard)
    return guard
  }

  function reserveTrustedLocalDiscordTurn(turn: ChatTurnCorrelation, sessionId: string): boolean {
    const now = Date.now()
    pruneRemoteStreamGuards(now)
    const existing = remoteStreamGuardsByTurnId.get(turn.id)
    if (existing)
      return existing.sessionId === sessionId
    if (remoteStreamGuardsByTurnId.size >= MAX_CONTEXT_BRIDGE_REMOTE_STREAM_GUARDS)
      return false

    // Reserve cancellation ownership before provider construction or Stage hooks.
    // The first trusted local hook replaces this placeholder with the complete
    // canonical context needed for post-provider TTS cancellation.
    remoteStreamGuardsByTurnId.set(turn.id, {
      expiresAt: resolveContextBridgeTurnExpiry(turn.deadlineAt, now),
      generation: chatSession.getSessionGenerationValue(sessionId),
      lastAccessedAt: now,
      sessionId,
      streamStarted: false,
    })
    return true
  }

  function releaseUnstartedLocalDiscordTurn(turnId: string): void {
    const guard = remoteStreamGuardsByTurnId.get(turnId)
    if (guard && !guard.context && !guard.streamStarted)
      remoteStreamGuardsByTurnId.delete(turnId)
  }

  function retainTrustedLocalDiscordHookContext(context: ChatStreamEvent['context']): void {
    if (isTrustedDiscordStreamContext(context))
      retainRemoteStreamContext(context)
  }

  function releaseRemoteStreamOwnership(turnId: string, guard: ContextBridgeRemoteStreamGuard): void {
    if (!guard.context) {
      remoteStreamGuardsByTurnId.delete(turnId)
      return
    }

    // Provider completion ends only mirrored UI ownership. Trusted Discord TTS
    // playback can outlive core/stream completion, so its cancellation context
    // remains available until the bounded turn expiry or an explicit cancel.
    guard.streamStarted = false
    guard.lastAccessedAt = Date.now()
    if (guard.context.deadlineAt === undefined)
      guard.expiresAt = guard.lastAccessedAt + MAX_CONTEXT_BRIDGE_TURN_CLAIM_TTL_MS
  }

  async function cancelLocalOrRemoteTurn(turnId: string, reason: ContextBridgeCancellationReason): Promise<void> {
    const cancelledLocally = chatOrchestrator.cancelTurn(turnId, reason)
    pruneRemoteStreamGuards()
    const remoteGuard = remoteStreamGuardsByTurnId.get(turnId)
    if (!remoteGuard)
      return

    remoteStreamGuardsByTurnId.delete(turnId)
    if (remoteGuard.streamStarted
      && remoteGuard.sessionId === chatSession.activeSessionId
      && remoteGuard.generation === chatSession.getSessionGenerationValue(remoteGuard.sessionId)) {
      chatStream.resetStream()
      chatOrchestrator.sending = false
    }

    // Origin windows cancel through core-agent, which emits the same hooks.
    // Passive windows have no local core turn and must replay cancellation once
    // against the trusted context retained before their first async hook.
    if (!cancelledLocally && remoteGuard.context)
      await chatOrchestrator.emitTurnCancelledHooks(remoteGuard.context, reason)
  }

  function sendDiscordMemoryCommandResult(
    event: WebSocketEventOf<'discord:memory:command'>,
    result: {
      message: string
      status: 'ok' | 'error'
    },
  ) {
    serverChannelStore.send({
      type: 'discord:memory:command:result',
      data: {
        commandId: event.data.commandId,
        action: event.data.action,
        sessionId: event.data.sessionId,
        status: result.status,
        message: result.message,
        handledAt: Date.now(),
      },
    })
  }

  function resolveDiscordMemoryCommandContext(event: WebSocketEventOf<'discord:memory:command'>): DiscordMemoryContext | undefined {
    const userId = event.data.userId.trim()
    if (!userId)
      return undefined

    const guildId = event.data.guildId?.trim() || undefined
    const channelId = event.data.channelId?.trim() || undefined
    const ownerUserIdConfigured = event.data.ownerUserIdConfigured === true
    return {
      userId,
      username: event.data.displayName || userId,
      isDM: !guildId,
      guildId,
      channelId,
      ownerUserIdConfigured,
      isOwner: ownerUserIdConfigured && event.data.isOwner === true,
    }
  }

  function formatMemoryPreview(content: string) {
    const normalized = normalizeMemoryContent(content)
    return normalized.length > 140 ? `${normalized.slice(0, 139)}...` : normalized
  }

  function formatMemoryLine(memory: Memory) {
    return `- ${memory.id} [${memory.type}/${memory.scope}/${memory.status}] ${formatMemoryPreview(memory.content)}`
  }

  async function clearDiscordMemoryCommandScope(context: DiscordMemoryContext, now: number) {
    const deleted = await clearDiscordMemoriesForActor(context, discordMemoryRepo, now)
    const shortTermScopeKey = getShortTermScopeKey(context)
    if (shortTermScopeKey)
      await clearShortTermMessages(shortTermScopeKey)
    return deleted
  }

  async function handleRememberMemoryCommand(event: WebSocketEventOf<'discord:memory:command'>, context: DiscordMemoryContext) {
    const now = Date.now()
    const content = event.data.content ?? ''
    const expiresAt = event.data.durationMs
      ? event.data.requestedAt + event.data.durationMs
      : undefined
    const decision = await decideMemoryAction({
      content,
      userId: context.userId,
      username: context.username,
      isOwner: context.isOwner === true,
      source: context.isDM ? 'dm' : 'discord_message',
      guildId: context.guildId,
      channelId: context.channelId,
      requestedScope: event.data.requestedScope ?? null,
      expiresAt,
      now,
    })

    if (decision.decision === 'reject') {
      sendDiscordMemoryCommandResult(event, {
        status: 'ok',
        message: decision.reason === 'Sensitive information should not be stored.'
          ? DISCORD_SENSITIVE_MEMORY_REJECTION_MESSAGE
          : `Memory rejected: ${decision.reason}`,
      })
      return
    }

    if (decision.decision === 'ask_confirmation') {
      if (!decision.content) {
        sendDiscordMemoryCommandResult(event, {
          status: 'ok',
          message: `Memory requires owner confirmation: ${decision.reason}`,
        })
        return
      }

      const pendingMemory = createMemoryRecord({
        decision,
        context,
        status: 'pending',
        now,
      })
      await discordMemoryRepo.saveMemory(pendingMemory)
      sendDiscordMemoryCommandResult(event, {
        status: 'ok',
        message: `Saved pending memory ${pendingMemory.id}. Owner approval is required before AIRI can use it.`,
      })
      return
    }

    const memory = createMemoryRecord({
      decision,
      context,
      status: 'active',
      now,
    })
    await discordMemoryRepo.saveMemory(memory)
    sendDiscordMemoryCommandResult(event, {
      status: 'ok',
      message: memory.status === 'active'
        ? `Saved memory ${memory.id} for scope ${memory.scope}.`
        : `Saved pending memory ${memory.id}. Owner approval is required before AIRI can use it.`,
    })
  }

  async function handleListMemoryCommand(event: WebSocketEventOf<'discord:memory:command'>, context: DiscordMemoryContext) {
    const memories = await listDiscordMemoriesForActor(context, discordMemoryRepo, {
      includePending: true,
      now: Date.now(),
    })
    if (memories.length === 0) {
      sendDiscordMemoryCommandResult(event, {
        status: 'ok',
        message: 'No visible memories for this Discord scope.',
      })
      return
    }

    sendDiscordMemoryCommandResult(event, {
      status: 'ok',
      message: [
        'Visible memories for this Discord scope:',
        ...memories.slice(0, 20).map(formatMemoryLine),
      ].join('\n'),
    })
  }

  async function handleForgetMemoryCommand(event: WebSocketEventOf<'discord:memory:command'>, context: DiscordMemoryContext) {
    const memoryId = event.data.memoryId?.trim()
    if (!memoryId) {
      sendDiscordMemoryCommandResult(event, {
        status: 'ok',
        message: 'Missing memory id.',
      })
      return
    }

    const result = await forgetDiscordMemoryForActor(
      context,
      memoryId,
      discordMemoryRepo,
      Date.now(),
    )
    if (result.outcome === 'forbidden') {
      sendDiscordMemoryCommandResult(event, {
        status: 'ok',
        message: 'You can only forget memory owned by your Discord identity here.',
      })
      return
    }
    if (result.outcome !== 'updated') {
      sendDiscordMemoryCommandResult(event, {
        status: 'ok',
        message: 'Memory not found.',
      })
      return
    }
    sendDiscordMemoryCommandResult(event, {
      status: 'ok',
      message: `Deleted memory ${result.memory.id}.`,
    })
  }

  async function handleApproveOrRejectMemoryCommand(event: WebSocketEventOf<'discord:memory:command'>, context: DiscordMemoryContext, status: 'active' | 'rejected') {
    if (!context.ownerUserIdConfigured) {
      sendDiscordMemoryCommandResult(event, {
        status: 'ok',
        message: 'Owner user id is not configured, so protected memory approval commands are disabled.',
      })
      return
    }

    if (!context.isOwner) {
      sendDiscordMemoryCommandResult(event, {
        status: 'ok',
        message: 'Only the owner can approve or reject pending memories.',
      })
      return
    }

    const memoryId = event.data.memoryId?.trim()
    if (!memoryId) {
      sendDiscordMemoryCommandResult(event, {
        status: 'ok',
        message: 'Missing memory id.',
      })
      return
    }

    const result = await reviewPendingDiscordMemory(
      context,
      memoryId,
      status === 'active' ? 'approve' : 'reject',
      discordMemoryRepo,
      Date.now(),
    )
    if (result.outcome === 'forbidden') {
      sendDiscordMemoryCommandResult(event, {
        status: 'ok',
        message: 'Only the owner can approve or reject pending memories.',
      })
      return
    }
    if (result.outcome === 'invalid') {
      sendDiscordMemoryCommandResult(event, {
        status: 'ok',
        message: 'This pending memory failed lifecycle validation and was not activated.',
      })
      return
    }
    if (result.outcome !== 'updated') {
      sendDiscordMemoryCommandResult(event, {
        status: 'ok',
        message: 'Pending memory not found.',
      })
      return
    }
    sendDiscordMemoryCommandResult(event, {
      status: 'ok',
      message: status === 'active'
        ? `Approved memory ${result.memory.id}.`
        : `Rejected memory ${result.memory.id}.`,
    })
  }

  async function handleDiscordMemoryCommand(event: WebSocketEventOf<'discord:memory:command'>) {
    await withContextBridgeExclusiveLock(`context-bridge:discord-memory:${event.data.commandId}`, async () => {
      try {
        const sessionId = event.data.sessionId
        const context = resolveDiscordMemoryCommandContext(event)
        if (!context) {
          sendDiscordMemoryCommandResult(event, {
            status: 'error',
            message: 'Cannot resolve this Discord memory scope safely.',
          })
          return
        }

        switch (event.data.action) {
          case 'privacy': {
            const consent = discordStore.getLongTermMemoryConsent(sessionId)
            const message = consent?.allowed === true
              ? 'Legacy automatic long-term memory consent is enabled for this exact Discord session, but Discord durable memories are now saved only through /remember.'
              : consent?.allowed === false
                ? 'Legacy automatic long-term memory is explicitly disabled for this exact Discord session. Durable memories are saved only through /remember.'
                : discordStore.memoryConsentRequired
                  ? 'Discord durable memory is explicit only. Use /remember to request a memory, /memory list to view visible memories, and /forget <id> to delete one.'
                  : 'Discord durable memory is explicit only. Use /remember to request a memory, /memory list to view visible memories, and /forget <id> to delete one.'
            sendDiscordMemoryCommandResult(event, { status: 'ok', message })
            return
          }

          case 'memory-opt-in': {
            discordStore.setLongTermMemoryConsent(sessionId, true)
            sendDiscordMemoryCommandResult(event, {
              status: 'ok',
              message: 'Long-term memory is now enabled for this exact Discord session only.',
            })
            return
          }

          case 'memory-opt-out': {
            discordStore.setLongTermMemoryConsent(sessionId, false)
            await chatMemory.clearCurrentScope(sessionId)
            await clearDiscordMemoryCommandScope(context, Date.now())
            sendDiscordMemoryCommandResult(event, {
              status: 'ok',
              message: 'Legacy automatic long-term memory is now disabled and visible memories for this Discord scope were cleared.',
            })
            return
          }

          case 'forget-current-session': {
            discordStore.setLongTermMemoryConsent(sessionId, false)
            await chatMemory.clearCurrentScope(sessionId)
            await clearDiscordMemoryCommandScope(context, Date.now())
            sendDiscordMemoryCommandResult(event, {
              status: 'ok',
              message: 'Forgot visible memories for this Discord scope and disabled legacy automatic memory until opt-in.',
            })
            return
          }

          case 'remember':
            await handleRememberMemoryCommand(event, context)
            return

          case 'memory-list':
            await handleListMemoryCommand(event, context)
            return

          case 'forget-memory':
            await handleForgetMemoryCommand(event, context)
            return

          case 'memory-clear': {
            const count = await clearDiscordMemoryCommandScope(context, Date.now())
            sendDiscordMemoryCommandResult(event, {
              status: 'ok',
              message: `Cleared ${count} visible memory record(s) for this Discord scope.`,
            })
            return
          }

          case 'memory-approve':
            await handleApproveOrRejectMemoryCommand(event, context, 'active')
            return

          case 'memory-reject':
            await handleApproveOrRejectMemoryCommand(event, context, 'rejected')
        }
      }
      catch {
        console.warn('[context-bridge] Discord memory command failed', {
          action: event.data.action,
          commandId: event.data.commandId,
          status: 'error',
        })
        sendDiscordMemoryCommandResult(event, {
          status: 'error',
          message: 'Failed to update Discord memory settings.',
        })
      }
    })
  }

  async function initialize() {
    await mutex.acquire()

    try {
      if (initialized)
        return

      const registerConsumers = () => {
        for (const consumerEvent of consumerRegistrationEvents) {
          serverChannelStore.send({
            type: 'module:consumer:register',
            data: {
              event: consumerEvent,
              mode: 'consumer-group',
              group: 'chat-ingestion',
            },
          })
        }

        serverChannelStore.send({
          type: 'module:consumer:register',
          data: {
            event: discordMemoryConsumerRegistration.event,
            mode: 'consumer-group',
            group: discordMemoryConsumerRegistration.group,
          },
        })
      }

      await serverChannelStore.ensureConnected()

      registerConsumers()
      discordStore.syncSavedSettingsToBackend()
      disposeHookFns.value.push(serverChannelStore.onReconnected(() => {
        registerConsumers()
        discordStore.syncSavedSettingsToBackend()
      }))
      disposeHookFns.value.push(serverChannelStore.onEvent('module:announced', (event) => {
        if (event.data.name === 'discord')
          discordStore.syncSavedSettingsToBackend()
      }))

      let isProcessingRemoteStream = 0

      const { stop: stopTurnLifecycleWatch } = watch(incomingTurnLifecycle, async (message) => {
        if (!message)
          return
        rememberContextBridgeTurnEntry(message.entry)
        if (message.entry[2] === 'cancelled')
          await cancelLocalOrRemoteTurn(message.entry[0], message.entry[3] === 'deadline' ? 'deadline' : 'reset')
      })
      disposeHookFns.value.push(stopTurnLifecycleWatch)

      const { stop } = watch(incomingContext, (event) => {
        if (!event)
          return

        contextObservability.recordLifecycle({
          phase: 'broadcast-received',
          channel: 'broadcast',
          sourceKey: getEventSourceKey(event),
          strategy: event.strategy,
          lane: event.lane,
          contextId: event.contextId,
          eventId: event.id,
          textPreview: event.text,
          sourceLabel: event.metadata?.source?.plugin?.id ?? event.metadata?.source?.id,
          details: event,
        })
        const ingestAttempt = ingestContextMessageSafely({
          channel: 'broadcast',
          contextMessage: event,
          sourceLabel: event.metadata?.source?.plugin?.id ?? event.metadata?.source?.id,
          details: event,
        })
        if (ingestAttempt.ok && ingestAttempt.result) {
          contextObservability.recordLifecycle({
            phase: 'store-ingested',
            channel: 'broadcast',
            sourceKey: ingestAttempt.result.sourceKey,
            strategy: event.strategy,
            lane: event.lane,
            contextId: event.contextId,
            eventId: event.id,
            mutation: ingestAttempt.result.mutation,
            textPreview: event.text,
            sourceLabel: event.metadata?.source?.plugin?.id ?? event.metadata?.source?.id,
            details: {
              entryCount: ingestAttempt.result.entryCount,
              event,
            },
          })
        }
      })
      disposeHookFns.value.push(stop)

      const { stop: stopSparkNotifyBridgeWatch } = watch(incomingSparkNotifyBridgeMessage, async (event) => {
        if (!event) {
          return
        }

        if (event.type === 'request') {
          if (sparkNotifyHostRole.value !== 'main' || event.fromInstanceId === sparkNotifyBridgeInstanceId) {
            return
          }

          await withContextBridgeExclusiveLock(`context-bridge:spark-notify:${event.requestId}`, async () => {
            const performance = event.performance?.callManifests.length
              ? await handleSparkNotifyPerformanceLocal({
                  ...event.payload,
                  calls: event.performance.callManifests.map(manifest => ({
                    manifest,
                    handler: async () => undefined,
                  })),
                  timeoutMs: event.performance.timeoutMs,
                })
              : undefined
            const reaction = performance?.reaction ?? await handleSparkNotifyReactionLocal(event.payload)
            postSparkNotifyBridgeMessage({
              type: 'response',
              requestId: event.requestId,
              toInstanceId: event.fromInstanceId,
              reaction,
              ...(performance ? { performance } : {}),
            })
          })
          return
        }

        if (event.type === 'response') {
          if (event.toInstanceId !== sparkNotifyBridgeInstanceId) {
            return
          }

          const waiter = sparkNotifyBridgeWaiters.get(event.requestId)
          if (!waiter) {
            return
          }

          sparkNotifyBridgeWaiters.delete(event.requestId)
          await waiter.resolve({
            reaction: event.reaction,
            performance: event.performance,
          })
        }
      })
      disposeHookFns.value.push(stopSparkNotifyBridgeWatch)

      disposeHookFns.value.push(serverChannelStore.onContextUpdate((event) => {
        contextObservability.recordLifecycle({
          phase: 'server-received',
          channel: 'server',
          sourceKey: getEventSourceKey(event),
          strategy: event.data.strategy,
          lane: event.data.lane,
          contextId: event.data.contextId,
          eventId: event.data.id,
          textPreview: event.data.text,
          sourceLabel: event.metadata?.source?.plugin?.id ?? event.metadata?.source?.id ?? event.source,
          details: event,
        })
        const contextMessage: ContextMessage = {
          ...event.data,
          metadata: event.metadata,
          createdAt: Date.now(),
        }
        const ingestAttempt = ingestContextMessageSafely({
          channel: 'server',
          contextMessage,
          sourceLabel: event.metadata?.source?.plugin?.id ?? event.metadata?.source?.id ?? event.source,
          details: event,
        })
        if (!ingestAttempt.ok)
          return

        if (ingestAttempt.result) {
          contextObservability.recordLifecycle({
            phase: 'store-ingested',
            channel: 'server',
            sourceKey: ingestAttempt.result.sourceKey,
            strategy: contextMessage.strategy,
            lane: contextMessage.lane,
            contextId: contextMessage.contextId,
            eventId: contextMessage.id,
            mutation: ingestAttempt.result.mutation,
            textPreview: contextMessage.text,
            sourceLabel: event.metadata?.source?.plugin?.id ?? event.metadata?.source?.id ?? event.source,
            details: {
              entryCount: ingestAttempt.result.entryCount,
              event,
            },
          })
        }
        broadcastContext(toRaw(contextMessage))
        contextObservability.recordLifecycle({
          phase: 'broadcast-posted',
          channel: 'broadcast',
          sourceKey: getEventSourceKey(contextMessage),
          strategy: contextMessage.strategy,
          lane: contextMessage.lane,
          contextId: contextMessage.contextId,
          eventId: contextMessage.id,
          textPreview: contextMessage.text,
          sourceLabel: event.metadata?.source?.plugin?.id ?? event.metadata?.source?.id ?? event.source,
          details: contextMessage,
        })
      }))

      disposeHookFns.value.push(serverChannelStore.onEvent('discord:memory:command', handleDiscordMemoryCommand))

      disposeHookFns.value.push(serverChannelStore.onEvent('chat:turn:cancel', async (event) => {
        if (event.metadata?.source?.kind !== 'plugin' || event.metadata.source.plugin?.id !== 'discord')
          return
        const reason = event.data.reason === 'deadline' ? 'deadline' : 'reset'
        const entry = await withContextBridgeExclusiveLock(
          CONTEXT_BRIDGE_TURN_LEDGER_LOCK_NAME,
          async () => cancelContextBridgeTurn(
            event.data.turn.id,
            event.data.turn.deadlineAt,
            reason,
          ),
          { waitForOwnership: true },
        )
        if (entry)
          broadcastTurnLifecycle({ entry })
        await cancelLocalOrRemoteTurn(event.data.turn.id, reason)
      }))

      disposeHookFns.value.push(serverChannelStore.onEvent('input:text', async (event) => {
        const {
          text,
          textRaw,
          overrides,
          contextUpdates,
        } = event.data
        const targetSessionId = overrides?.sessionId
        discordStore.rememberObservedDiscordScope(event)
        const isTrustedDiscordInput = isTrustedDiscordInputEvent(event)
        if (isTrustedDiscordInput && !isValidDiscordTurnCorrelation(event.data.turn)) {
          sendDiscordStatusReply(event, DISCORD_TURN_CORRELATION_REQUIRED_MESSAGE)
          return
        }

        if (isTrustedDiscordInput && event.data.turn) {
          const claim = await claimTrustedDiscordTurn(event.data.turn)
          if (!claim || claim === 'duplicate' || claim === 'cancelled')
            return
          if (claim === 'capacity') {
            sendDiscordStatusReply(event, DISCORD_CHAT_QUEUE_FULL_MESSAGE)
            return
          }

          const claimedEntry = fallbackContextBridgeTurnLedger.get(event.data.turn.id)
          if (claimedEntry)
            broadcastTurnLifecycle({ entry: claimedEntry })

          const reservationSessionId = targetSessionId || chatSession.activeSessionId
          if (!reserveTrustedLocalDiscordTurn(event.data.turn, reservationSessionId)) {
            sendDiscordStatusReply(event, DISCORD_CHAT_QUEUE_FULL_MESSAGE)
            return
          }
        }

        // Discord metadata belongs to the exact chat turn. Letting its legacy
        // ReplaceSelf update enter the global registry can overwrite another
        // guild/channel/user turn before prompt composition.
        const normalizedContextUpdates = isTrustedDiscordInput
          ? undefined
          : contextUpdates?.map((update) => {
              const id = update.id ?? nanoid()
              const contextId = update.contextId ?? id
              return {
                ...update,
                id,
                contextId,
              }
            })
        const acceptedContextUpdates: typeof normalizedContextUpdates = normalizedContextUpdates ? [] : undefined

        if (normalizedContextUpdates?.length) {
          const createdAt = Date.now()
          for (const update of normalizedContextUpdates) {
            contextObservability.recordLifecycle({
              phase: 'input-context-update',
              channel: 'input',
              strategy: update.strategy,
              lane: update.lane,
              contextId: update.contextId,
              eventId: update.id,
              textPreview: update.text,
              sourceLabel: event.metadata?.source?.plugin?.id ?? event.metadata?.source?.id ?? event.source,
              details: {
                inputType: event.type,
                update,
              },
            })
            const contextMessage: ContextMessage = {
              ...update,
              metadata: event.metadata,
              createdAt,
            }
            const ingestAttempt = ingestContextMessageSafely({
              channel: 'input',
              contextMessage,
              sourceLabel: event.metadata?.source?.plugin?.id ?? event.metadata?.source?.id ?? event.source,
              details: {
                inputType: event.type,
                update: contextMessage,
              },
            })
            if (!ingestAttempt.ok)
              continue

            acceptedContextUpdates?.push(update)

            if (ingestAttempt.result) {
              contextObservability.recordLifecycle({
                phase: 'store-ingested',
                channel: 'input',
                sourceKey: ingestAttempt.result.sourceKey,
                strategy: contextMessage.strategy,
                lane: contextMessage.lane,
                contextId: contextMessage.contextId,
                eventId: contextMessage.id,
                mutation: ingestAttempt.result.mutation,
                textPreview: contextMessage.text,
                sourceLabel: event.metadata?.source?.plugin?.id ?? event.metadata?.source?.id ?? event.source,
                details: {
                  entryCount: ingestAttempt.result.entryCount,
                  inputType: event.type,
                  update: contextMessage,
                },
              })
            }
          }
        }

        if (activeProvider.value && activeModel.value) {
          if (event.data.turn && getContextBridgeTurnCancellation(event.data.turn.id))
            return

          let chatProvider: ChatProvider
          try {
            chatProvider = await providersStore.getProviderInstance<ChatProvider>(activeProvider.value)
          }
          catch (err) {
            if (event.data.turn && getContextBridgeTurnCancellation(event.data.turn.id))
              return
            if (event.data.turn)
              releaseUnstartedLocalDiscordTurn(event.data.turn.id)
            console.error('[context-bridge] getProviderInstance failed for provider:', activeProvider.value, err)
            sendDiscordStatusReply(event, DISCORD_PROVIDER_START_FAILED_MESSAGE)
            return
          }

          let messageText = text
          if (overrides?.messagePrefix) {
            messageText = `${overrides.messagePrefix}${text}`
          }

          // This guard intentionally owns only duplicate delivery across Stage windows.
          // Per-session FIFO and bounded cross-session concurrency belong to core-agent.
          //
          // Background behind this, as server-sdk is in fact integrated in every Stage Web window/tab, each
          // window/tab has its own connection & chat orchestrator instance, when multiple windows/tabs are open,
          // each of them will receive the same input:text event and process ingestion independently, causing
          // duplicated messages handling and output:* events emission.
          //
          // We don't have ability to control how many windows/tabs the user will open (sometimes) user will forget
          // to close the extra windows/tabs, so we need a way to coordinate the ingestion processing to
          // ensure only one window/tab is handling the ingestion at a time.
          //
          // SharedWorker solution was considered but it's completely disabled in Chromium based Android browsers
          // (which is a big portion of mobile Stage Web users as stage-ui serves as the unified / universal
          // api wrapper for most of the shared logic across Web, Pocket, and Tamagotchi).
          //
          // Read more here:
          // - https://chromestatus.com/feature/6265472244514816
          // - https://developer.mozilla.org/en-US/docs/Web/API/SharedWorker
          // - https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API
          const correlationId = event.data.turn?.id ?? event.metadata?.event?.id
          const ingestWithCorrelation = async () => {
            if (event.data.turn && getContextBridgeTurnCancellation(event.data.turn.id))
              return
            try {
              await chatOrchestrator.ingest(messageText, {
                model: activeModel.value,
                chatProvider,
                turnId: event.data.turn?.id,
                deadlineAt: event.data.turn?.deadlineAt,
                input: {
                  type: 'input:text',
                  source: event.source,
                  metadata: event.metadata,
                  route: event.route,
                  data: {
                    ...event.data,
                    text,
                    textRaw,
                    overrides,
                    contextUpdates: acceptedContextUpdates,
                  },
                },
              }, targetSessionId)
            }
            catch (err) {
              if (err instanceof ChatQueueCapacityError) {
                if (event.data.turn)
                  releaseUnstartedLocalDiscordTurn(event.data.turn.id)
                sendDiscordStatusReply(event, DISCORD_CHAT_QUEUE_FULL_MESSAGE)
                return
              }
              if (err instanceof ChatTurnCancelledError) {
                if (event.data.turn)
                  releaseUnstartedLocalDiscordTurn(event.data.turn.id)
                return
              }
              if (event.data.turn)
                releaseUnstartedLocalDiscordTurn(event.data.turn.id)
              console.error('Error ingesting text input via context bridge:', err)
              sendDiscordStatusReply(event, DISCORD_CHAT_INGEST_FAILED_MESSAGE)
            }
          }

          if (correlationId && !isTrustedDiscordInput) {
            await withContextBridgeExclusiveLock(`context-bridge:event:input:text:${correlationId}`, async () => {
              await ingestWithCorrelation()
            })
          }
          else {
            await ingestWithCorrelation()
          }
        }
        else {
          if (event.data.turn)
            releaseUnstartedLocalDiscordTurn(event.data.turn.id)
          console.warn('[context-bridge] input:text skipped because chat provider/model is not selected', {
            activeProvider: activeProvider.value || '',
            hasActiveModel: Boolean(activeModel.value),
          })
          sendDiscordStatusReply(event, DISCORD_LOCAL_AI_NOT_READY_MESSAGE)
        }
      }))

      disposeHookFns.value.push(
        chatOrchestrator.onBeforeMessageComposed(async (message, context) => {
          if (isProcessingRemoteStream)
            return

          retainTrustedLocalDiscordHookContext(context)
          broadcastStreamEvent({ type: 'before-compose', message, sessionId: context.sessionId, context: structuredClone(normalizeContextSnapshot(context)) })
        }),
        chatOrchestrator.onAfterMessageComposed(async (message, context) => {
          if (isProcessingRemoteStream)
            return

          retainTrustedLocalDiscordHookContext(context)
          broadcastStreamEvent({ type: 'after-compose', message, sessionId: context.sessionId, context: structuredClone(normalizeContextSnapshot(context)) })
        }),
        chatOrchestrator.onBeforeSend(async (message, context) => {
          if (isProcessingRemoteStream)
            return

          retainTrustedLocalDiscordHookContext(context)
          broadcastStreamEvent({ type: 'before-send', message, sessionId: context.sessionId, context: structuredClone(normalizeContextSnapshot(context)) })
        }),
        chatOrchestrator.onAfterSend(async (message, context) => {
          if (isProcessingRemoteStream)
            return

          retainTrustedLocalDiscordHookContext(context)
          broadcastStreamEvent({ type: 'after-send', message, sessionId: context.sessionId, context: structuredClone(normalizeContextSnapshot(context)) })
        }),
        chatOrchestrator.onTokenLiteral(async (literal, context) => {
          if (isProcessingRemoteStream)
            return

          retainTrustedLocalDiscordHookContext(context)
          broadcastStreamEvent({ type: 'token-literal', literal, sessionId: context.sessionId, context: structuredClone(normalizeContextSnapshot(context)) })
        }),
        chatOrchestrator.onTokenSpecial(async (special, context) => {
          if (isProcessingRemoteStream)
            return

          retainTrustedLocalDiscordHookContext(context)
          broadcastStreamEvent({ type: 'token-special', special, sessionId: context.sessionId, context: structuredClone(normalizeContextSnapshot(context)) })
        }),
        chatOrchestrator.onStreamEnd(async (context) => {
          if (isProcessingRemoteStream)
            return

          retainTrustedLocalDiscordHookContext(context)
          broadcastStreamEvent({ type: 'stream-end', sessionId: context.sessionId, context: structuredClone(normalizeContextSnapshot(context)) })
        }),
        chatOrchestrator.onAssistantResponseEnd(async (message, context) => {
          if (isProcessingRemoteStream)
            return

          retainTrustedLocalDiscordHookContext(context)
          broadcastStreamEvent({ type: 'assistant-end', message, sessionId: context.sessionId, context: structuredClone(normalizeContextSnapshot(context)) })
        }),

        chatOrchestrator.onAssistantMessage(async (message, _messageText, context) => {
          serverChannelStore.send({
            type: 'output:gen-ai:chat:message',
            data: {
              ...context.input?.data,
              message,
              'stage-web': isStageWeb(),
              'stage-tamagotchi': isStageTamagotchi(),
              'gen-ai:chat': {
                message: context.message as UserMessage,
                composedMessage: context.composedMessage,
                contexts: context.contexts,
                input: context.input,
              },
            },
          })
        }),

        chatOrchestrator.onChatTurnComplete(async (chat, context) => {
          serverChannelStore.send({
            type: 'output:gen-ai:chat:complete',
            data: {
              ...context.input?.data,
              'message': chat.output,
              // TODO: tool calls should be captured properly
              'toolCalls': [],
              'stage-web': isStageWeb(),
              'stage-tamagotchi': isStageTamagotchi(),
              // TODO: Properly calculate usage data
              'usage': {
                promptTokens: 0,
                completionTokens: 0,
                totalTokens: 0,
                source: 'estimate-based',
              },
              'gen-ai:chat': {
                message: context.message as UserMessage,
                composedMessage: context.composedMessage,
                contexts: context.contexts,
                input: context.input,
              },
            },
          })
        }),
      )

      const { stop: stopIncomingStreamWatch } = watch(incomingStreamEvent, async (event) => {
        if (!event)
          return
        if (event.sessionId !== chatSession.activeSessionId)
          return
        if (event.context.sessionId !== event.sessionId)
          return
        if (chatSession.getSessionGenerationValue(event.sessionId) !== event.context.generation)
          return
        const deadlineAt = event.context.deadlineAt
        if (deadlineAt !== undefined && deadlineAt <= Date.now()) {
          const existingCancellation = getContextBridgeTurnCancellation(event.context.turnId)
          if (!existingCancellation) {
            const entry = await withContextBridgeExclusiveLock(
              CONTEXT_BRIDGE_TURN_LEDGER_LOCK_NAME,
              async () => {
                if (getContextBridgeTurnCancellation(event.context.turnId))
                  return undefined

                return cancelContextBridgeTurn(
                  event.context.turnId,
                  deadlineAt,
                  'deadline',
                )
              },
              { waitForOwnership: true },
            )
            if (entry)
              broadcastTurnLifecycle({ entry })
          }
          await cancelLocalOrRemoteTurn(
            event.context.turnId,
            getContextBridgeTurnCancellation(event.context.turnId) ?? 'deadline',
          )
          return
        }
        const cancellation = getContextBridgeTurnCancellation(event.context.turnId)
        if (cancellation) {
          await cancelLocalOrRemoteTurn(event.context.turnId, cancellation)
          return
        }

        isProcessingRemoteStream += 1

        try {
          pruneRemoteStreamGuards()
          const remoteStreamGuard = remoteStreamGuardsByTurnId.get(event.context.turnId)
          const ownsRemoteStream = remoteStreamGuard?.sessionId === event.sessionId
            && remoteStreamGuard.generation === event.context.generation
            && remoteStreamGuard.streamStarted

          switch (event.type) {
            case 'before-compose': {
              if (!retainRemoteStreamContext(event.context))
                return
              await chatOrchestrator.emitBeforeMessageComposedHooks(event.message, event.context)
              break
            }
            case 'after-compose': {
              if (!retainRemoteStreamContext(event.context))
                return
              await chatOrchestrator.emitAfterMessageComposedHooks(event.message, event.context)
              break
            }
            case 'before-send': {
              for (const [turnId, guard] of remoteStreamGuardsByTurnId) {
                if (turnId !== event.context.turnId && guard.sessionId === event.sessionId)
                  releaseRemoteStreamOwnership(turnId, guard)
              }
              const guard = retainRemoteStreamContext(event.context, { streamStarted: false })
              if (!guard)
                return
              await chatOrchestrator.emitBeforeSendHooks(event.message, event.context)
              const cancellationAfterHook = getContextBridgeTurnCancellation(event.context.turnId)
              if (cancellationAfterHook) {
                await cancelLocalOrRemoteTurn(event.context.turnId, cancellationAfterHook)
                return
              }
              if (remoteStreamGuardsByTurnId.get(event.context.turnId) !== guard) {
                return
              }
              guard.streamStarted = true
              chatOrchestrator.sending = true
              chatStream.beginStream()
              break
            }
            case 'after-send':
              if (!ownsRemoteStream)
                return
              remoteStreamGuard.lastAccessedAt = Date.now()
              if (event.context.deadlineAt === undefined)
                remoteStreamGuard.expiresAt = remoteStreamGuard.lastAccessedAt + MAX_CONTEXT_BRIDGE_TURN_CLAIM_TTL_MS
              await chatOrchestrator.emitAfterSendHooks(event.message, event.context)
              break
            case 'token-literal':
              if (!ownsRemoteStream)
                return
              remoteStreamGuard.lastAccessedAt = Date.now()
              if (event.context.deadlineAt === undefined)
                remoteStreamGuard.expiresAt = remoteStreamGuard.lastAccessedAt + MAX_CONTEXT_BRIDGE_TURN_CLAIM_TTL_MS
              chatStream.appendStreamLiteral(event.literal)
              await chatOrchestrator.emitTokenLiteralHooks(event.literal, event.context)
              break
            case 'token-special':
              if (!ownsRemoteStream)
                return
              remoteStreamGuard.lastAccessedAt = Date.now()
              if (event.context.deadlineAt === undefined)
                remoteStreamGuard.expiresAt = remoteStreamGuard.lastAccessedAt + MAX_CONTEXT_BRIDGE_TURN_CLAIM_TTL_MS
              await chatOrchestrator.emitTokenSpecialHooks(event.special, event.context)
              break
            case 'stream-end':
              if (!ownsRemoteStream)
                break
              await chatOrchestrator.emitStreamEndHooks(event.context)
              // NOTICE: Remote stream events are mirrored across renderer windows for UI feedback only.
              // Persisting them here would append assistant messages into the receiver's local session
              // without the corresponding user message, corrupting IndexedDB history across windows.
              chatStream.resetStream()
              chatOrchestrator.sending = false
              releaseRemoteStreamOwnership(event.context.turnId, remoteStreamGuard)
              break
            case 'assistant-end':
              if (!ownsRemoteStream)
                break
              await chatOrchestrator.emitAssistantResponseEndHooks(event.message, event.context)
              // NOTICE: The originating renderer already persists the final assistant message.
              // Receiver windows must not write it again, or they can overwrite the same session
              // with assistant-only history when their local session state is stale.
              chatStream.resetStream()
              chatOrchestrator.sending = false
              releaseRemoteStreamOwnership(event.context.turnId, remoteStreamGuard)
              break
          }
        }
        finally {
          isProcessingRemoteStream -= 1
        }
      })
      disposeHookFns.value.push(stopIncomingStreamWatch)
      initialized = true
    }
    finally {
      mutex.release()
    }
  }

  async function dispose() {
    await mutex.acquire()

    try {
      if (!initialized)
        return

      for (const consumerEvent of consumerRegistrationEvents) {
        serverChannelStore.send({
          type: 'module:consumer:unregister',
          data: {
            event: consumerEvent,
            mode: 'consumer-group',
            group: 'chat-ingestion',
          },
        })
      }

      for (const fn of disposeHookFns.value) {
        fn()
      }

      initialized = false
      remoteStreamGuardsByTurnId.clear()

      const retainedTurnLockPromises = Array.from(retainedTurnLocksByTurnId.values(), retained => retained.promise)
      for (const retained of retainedTurnLocksByTurnId.values())
        retained.abortController.abort()
      await Promise.allSettled(retainedTurnLockPromises)
      retainedTurnLocksByTurnId.clear()

      for (const [requestId, waiter] of sparkNotifyBridgeWaiters) {
        if (waiter.timeout)
          clearTimeout(waiter.timeout)
        sparkNotifyBridgeWaiters.delete(requestId)
      }
    }
    finally {
      mutex.release()
    }

    disposeHookFns.value = []
  }

  return {
    initialize,
    dispose,
    dispatchSparkNotifyReaction,
    dispatchSparkNotifyPerformance,
    setSparkNotifyHostRole,
  }
})
