import type { ChatProvider } from '@xsai-ext/providers/utils'
import type { CommonContentPart, Message, ToolMessage } from '@xsai/shared-chat'

import type { AgentContextPort } from '../contracts/context-port'
import type { AgentForegroundStreamPort } from '../contracts/stream-port'
import type { PromptContribution } from '../messages/prompt-contributions'
import type { ChatAssistantMessage, ChatHistoryItem, ChatSlices, ChatStreamEventContext, ChatTurnCancellationReason, ContextMessage, StreamingAssistantMessage } from '../types/chat'
import type { StreamEvent, StreamOptions } from '../types/llm'

import { createQueue } from '@proj-airi/stream-kit'

import { formatContextPromptText } from '../messages/context-prompt'
import { formatTimePrefix } from '../messages/datetime-prefix'
import { composePromptContributions } from '../messages/prompt-contributions'
import { createChatHooks } from './agent-hooks'
import { useLlmmarkerParser } from './llm-marker-parser'
import { categorizeResponse, createStreamingCategorizer } from './response-categoriser'

const STREAMING_UI_FLUSH_CHUNK_SIZE = 24

const DEFAULT_CHAT_QUEUE_POLICY: ChatOrchestratorQueuePolicy = {
  maxConcurrentSessions: 4,
  maxQueuedPerSession: 8,
  maxQueuedTotal: 64,
}

/** Policy that bounds the core chat scheduler. */
export interface ChatOrchestratorQueuePolicy {
  /** Maximum exact sessions whose providers may run concurrently. @default 4 */
  maxConcurrentSessions: number
  /** Maximum waiting turns retained for one exact session. @default 8 */
  maxQueuedPerSession: number
  /** Maximum waiting turns retained across all sessions. @default 64 */
  maxQueuedTotal: number
}

/** Safe, transport-independent overload error returned when a chat queue is full. */
export class ChatQueueCapacityError extends Error {
  readonly code = 'CHAT_QUEUE_CAPACITY_EXCEEDED'

  constructor(readonly scope: 'session' | 'global') {
    super('Chat request queue is full. Please retry after an earlier request finishes.')
    this.name = 'ChatQueueCapacityError'
  }
}

/** Cancellation error used when an exact chat turn reaches its deadline or is invalidated. */
export class ChatTurnCancelledError extends Error {
  readonly code = 'CHAT_TURN_CANCELLED'

  constructor(readonly reason: ChatTurnCancellationReason) {
    super(reason === 'deadline'
      ? 'Chat turn deadline exceeded'
      : reason === 'reset'
        ? 'Chat session was reset before send could start'
        : 'Chat turn was cancelled')
    this.name = 'ChatTurnCancelledError'
  }
}

function prependTextToContent<T extends { content?: unknown }>(msg: T, text: string): T {
  const content = msg.content
  if (content === undefined)
    return { ...msg, content: text }
  if (typeof content === 'string')
    return { ...msg, content: `${text}${content}` }

  if (Array.isArray(content)) {
    const first = content[0] as { type?: string, text?: string } | undefined
    if (first && first.type === 'text' && typeof first.text === 'string') {
      const next = [{ ...first, text: `${text}${first.text}` }, ...content.slice(1)]
      return { ...msg, content: next }
    }
    return { ...msg, content: [{ type: 'text', text }, ...content] }
  }

  return msg
}

function cloneStreamingMessage(message: StreamingAssistantMessage): StreamingAssistantMessage {
  try {
    return structuredClone(message)
  }
  catch {
    return JSON.parse(JSON.stringify(message)) as StreamingAssistantMessage
  }
}

/**
 * Options accepted by the chat orchestrator runtime for one user send.
 */
export interface ChatOrchestratorSendOptions {
  /** Provider model identifier used for the outbound LLM request. */
  model: string
  /** Concrete chat provider implementation selected by the caller. */
  chatProvider: ChatProvider
  /** Provider-specific request options, currently used for headers. */
  providerConfig?: Record<string, unknown>
  /** Image attachments appended to the user message content parts. */
  attachments?: { type: 'image', data: string, mimeType: string }[]
  /** Tool definitions passed through to the LLM stream port. */
  tools?: StreamOptions['tools']
  /** Original transport input metadata used by bridge/devtools observers. */
  input?: ChatStreamEventContext['input']
  /** Stable transport correlation identifier. A local identifier is generated when omitted. */
  turnId?: string
  /** Absolute wall-clock deadline for queueing, provider work, and all later side effects. */
  deadlineAt?: number
  /** Optional caller cancellation propagated to the provider and turn-side-effect gate. */
  abortSignal?: AbortSignal
}

interface QueuedSend {
  sendingMessage: string
  options: ChatOrchestratorSendOptions
  generation: number
  sessionId: string
  turnId: string
  deadlineAt?: number
  controller: AbortController
  deadlineTimer?: ReturnType<typeof setTimeout>
  removeExternalAbortListener?: () => void
  promiseSettled: boolean
  cancelled?: boolean
  deferred: {
    resolve: () => void
    reject: (error: unknown) => void
  }
}

/**
 * Serializable view of a queued send waiting to be processed.
 */
export interface QueuedSendSnapshot {
  /** Stable identifier for the pending turn. */
  turnId: string
  /** Session that owns the queued send. */
  sessionId: string
  /** Session generation captured when the send was enqueued. */
  generation: number
  /** Whether the queued send has been rejected before execution. */
  cancelled: boolean
  /** First 120 characters of the pending user message. */
  messagePreview: string
  /** Whether the queued send carries image attachments. */
  hasAttachments: boolean
  /** Optional input event type for transport-originated sends. */
  inputType?: NonNullable<ChatStreamEventContext['input']>['type']
  /** Absolute turn deadline, when the ingress supplied one. */
  deadlineAt?: number
}

/**
 * Session operations required by the core chat orchestrator runtime.
 */
export interface ChatOrchestratorSessionPort {
  /** Ensures a session exists before messages are appended. */
  ensureSession: (sessionId: string) => void
  /** Returns chronological chat history for a session. */
  getSessionMessages: (sessionId: string) => ChatHistoryItem[]
  /** Appends a finalized user/assistant/tool history item. */
  appendSessionMessage: (sessionId: string, message: ChatHistoryItem) => void
  /** Returns a monotonic generation used to reject stale queued sends. */
  getSessionGeneration: (sessionId: string) => number
}

/**
 * LLM streaming boundary used by the core chat orchestrator runtime.
 */
export interface ChatOrchestratorLLMPort {
  /** Streams one composed chat request and emits normalized stream events. */
  stream: (model: string, chatProvider: ChatProvider, messages: Message[], options?: StreamOptions) => Promise<void>
}

/**
 * Lifecycle record emitted around prompt composition.
 */
export interface ChatOrchestratorLifecycleRecord {
  /** Composition phase being observed. */
  phase: 'before-compose' | 'prompt-context-built' | 'after-compose'
  /** Logical event channel for context observability. */
  channel: 'chat'
  /** Session associated with this send. */
  sessionId: string
  /** Optional compact preview of the user text. */
  textPreview?: string
  /** Phase-specific payload for devtools and diagnostics. */
  details?: unknown
}

/**
 * Prompt projection emitted after the runtime has composed provider messages.
 */
export interface ChatOrchestratorPromptProjection {
  /** Session associated with the projected prompt. */
  sessionId: string
  /** Raw user message text that triggered the prompt. */
  message: string
  /** Active context snapshot read during prompt composition. */
  contexts: Record<string, ContextMessage[]>
  /** Historical standalone context prompt shape, kept for compatibility. */
  promptMessage?: Message | null
  /** Provider-ready message array sent to the LLM port. */
  composedMessage?: Message[]
  /** Dynamic prompt contributions, including excluded diagnostics. */
  contributions: PromptContribution[]
}

/**
 * Reactive state mirrored by UI facades.
 */
export interface ChatOrchestratorRuntimeState {
  /** Whether the runtime currently owns an active send. */
  sending: boolean
  /** Number of sends waiting behind the active one. */
  pendingQueuedSendCount: number
}

/**
 * Dependency surface used by the platform-agnostic chat orchestrator runtime.
 */
export interface ChatOrchestratorRuntimeDeps {
  /** Session persistence and generation guard port. */
  session: ChatOrchestratorSessionPort
  /** Context registry facade used for runtime context ingest and prompt snapshots. */
  context: Pick<AgentContextPort, 'ingest' | 'snapshot'>
  /** Foreground assistant stream port controlled by the UI facade. */
  foregroundStream: AgentForegroundStreamPort
  /** Provider-agnostic LLM streaming port. */
  llm: ChatOrchestratorLLMPort
  /** Returns the currently visible session ID. */
  getActiveSessionId: () => string
  /** Returns the currently active provider ID for categorization policy. */
  getActiveProvider: () => string | undefined
  /** Returns optional prompt text appended to the provider system message for this send. */
  getSystemPromptSupplement?: () => string | undefined
  /** Runtime context providers ingested immediately before prompt composition. */
  runtimeContextProviders?: Array<() => ContextMessage | null | undefined>
  /** Clock used for persisted message timestamps. @default Date.now */
  now?: () => number
  /** Monotonic clock used for elapsed telemetry in milliseconds. @default performance.now */
  monotonicNow?: () => number
  /** ID factory used for persisted chat messages. @default crypto.randomUUID fallback */
  createId?: () => string
  /** ID factory used only when an ingress does not provide a stable turn identifier. */
  createTurnId?: () => string
  /** Bounded per-session scheduler policy. */
  queuePolicy?: Partial<ChatOrchestratorQueuePolicy>
  /** Optional adapter for removing framework proxies before provider composition. */
  unwrapMessage?: <T>(message: T) => T
  /** Called whenever writable runtime state changes. */
  onStateChange?: (state: ChatOrchestratorRuntimeState) => void
  /** Called after a runtime-owned send completes or fails and `sending` has been cleared. */
  onSendSettled?: (event: { sessionId: string, turnId: string }) => void
  /** Called when a send starts and the first assistant placeholder is created. */
  onTrackFirstMessage?: () => void
  /** Called when a user message send begins. */
  onMessageSendStarted?: (event: {
    source: 'text' | 'voice'
    model: string
  }) => void
  /** Called immediately before the provider LLM request starts. */
  onLlmRequestStarted?: (event: {
    model: string
    provider: string
    hasVoice: boolean
  }) => void
  /** Called when the first text token arrives from the provider stream. */
  onLlmFirstToken?: (event: {
    model: string
    ttfbMs: number
  }) => void
  /** Called after the assistant stream is parsed and rendered into runtime state. */
  onAssistantResponseRendered?: (event: {
    model: string
    latencyMs: number
  }) => void
  /** Called after one user-to-assistant message round completes successfully. */
  onMessageRound?: (event: {
    durationMs: number
    hasVoice: boolean
    model: string
  }) => void
  /** Called for context/prompt lifecycle observability. */
  onLifecycle?: (record: ChatOrchestratorLifecycleRecord) => void
  /** Called with the final provider prompt projection. */
  onPromptProjection?: (payload: ChatOrchestratorPromptProjection) => void
  /** Called after the user message has been appended to session history. */
  onUserMessageAppended?: (event: {
    sessionId: string
    turnId: string
    message: Extract<ChatHistoryItem, { role: 'user' }> & { id: string }
    messageText: string
    input?: ChatStreamEventContext['input']
  }) => void
  /** Called after the assistant message has been finalized into session history. */
  onAssistantMessageAppended?: (event: {
    sessionId: string
    turnId: string
    message: StreamingAssistantMessage
    messageText: string
    input?: ChatStreamEventContext['input']
  }) => void
  /** Called after user turn persistence, before provider prompt composition. */
  onUserTurnReady?: (event: {
    sessionId: string
    turnId: string
    messageText: string
    sessionMessages: ChatHistoryItem[]
  }) => void
  /** Called after assistant streaming and hook finalization. */
  onAssistantTurnReady?: (event: {
    sessionId: string
    turnId: string
    messageText: string
    sessionMessages: ChatHistoryItem[]
  }) => void
}

/**
 * Platform-agnostic chat orchestrator runtime API.
 */
export interface ChatOrchestratorRuntime {
  /** Enqueues a user send for the target session, preserving FIFO order. */
  ingest: (sendingMessage: string, options: ChatOrchestratorSendOptions, targetSessionId?: string) => Promise<void>
  /** Rejects queued sends that have not started yet. */
  cancelPendingSends: (sessionId?: string) => void
  /** Cancels one exact queued or running turn and rejects its ingest promise. */
  cancelTurn: (turnId: string, reason?: ChatTurnCancelledError['reason']) => boolean
  /** Cancels queued and running work owned by one session, or all sessions when omitted. */
  cancelSessionSends: (sessionId?: string) => void
  /** Returns serializable snapshots of currently queued sends. */
  getPendingQueuedSendSnapshot: () => QueuedSendSnapshot[]
  /** Returns the current queued send count. */
  getPendingQueuedSendCount: () => number
  /** Reads the writable sending flag. */
  getSending: () => boolean
  /** Updates the writable sending flag and notifies facade mirrors. */
  setSending: (next: boolean) => void
  /** Hook registry preserved from the previous stage-ui store API. */
  hooks: ReturnType<typeof createChatHooks>
}

function defaultCreateId() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

function cancellationErrorFrom(signal: AbortSignal) {
  return signal.reason instanceof Error
    ? signal.reason
    : new ChatTurnCancelledError('cancelled')
}

async function waitForPromiseOrAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted)
    throw cancellationErrorFrom(signal)

  let removeAbortListener: (() => void) | undefined
  const aborted = new Promise<never>((_resolve, reject) => {
    const onAbort = () => reject(cancellationErrorFrom(signal))
    signal.addEventListener('abort', onAbort, { once: true })
    removeAbortListener = () => signal.removeEventListener('abort', onAbort)
  })

  try {
    // Promise.race installs handlers on the provider promise, so a provider that
    // ignores AbortSignal cannot produce an unhandled late rejection.
    return await Promise.race([promise, aborted])
  }
  finally {
    removeAbortListener?.()
  }
}

/**
 * Creates the core chat orchestrator runtime used behind UI facades.
 *
 * Use when:
 * - A platform wants AIRI chat send orchestration without Vue/Pinia coupling.
 * - Session, context, foreground stream, and LLM integrations are provided as adapters.
 *
 * Expects:
 * - Session messages are returned in chronological order.
 * - `foregroundStream.patch` replaces the visible streaming assistant message.
 *
 * Returns:
 * - A runtime with send queue APIs, hook registry, writable sending state, and queue snapshots.
 */
export function createChatOrchestratorRuntime(deps: ChatOrchestratorRuntimeDeps): ChatOrchestratorRuntime {
  const hooks = createChatHooks()
  const now = deps.now ?? (() => Date.now())
  const monotonicNow = deps.monotonicNow ?? (() => globalThis.performance?.now?.() ?? Date.now())
  const createId = deps.createId ?? defaultCreateId
  const createTurnId = deps.createTurnId ?? defaultCreateId
  const unwrapMessage = deps.unwrapMessage ?? (<T>(message: T) => message)
  const queuePolicy: ChatOrchestratorQueuePolicy = {
    maxConcurrentSessions: Math.max(1, Math.trunc(deps.queuePolicy?.maxConcurrentSessions ?? DEFAULT_CHAT_QUEUE_POLICY.maxConcurrentSessions)),
    maxQueuedPerSession: Math.max(1, Math.trunc(deps.queuePolicy?.maxQueuedPerSession ?? DEFAULT_CHAT_QUEUE_POLICY.maxQueuedPerSession)),
    maxQueuedTotal: Math.max(1, Math.trunc(deps.queuePolicy?.maxQueuedTotal ?? DEFAULT_CHAT_QUEUE_POLICY.maxQueuedTotal)),
  }

  let sending = false
  let pendingQueuedSends: QueuedSend[] = []
  let runningSendCount = 0
  const queuesBySessionId = new Map<string, QueuedSend[]>()
  const readySessionIds: string[] = []
  const activeSessionIds = new Set<string>()
  const activeTurnsById = new Map<string, QueuedSend>()
  const turnPromisesById = new Map<string, Promise<void>>()

  function emitStateChange() {
    deps.onStateChange?.({
      sending,
      pendingQueuedSendCount: pendingQueuedSends.length,
    })
  }

  function setSending(next: boolean) {
    if (sending === next)
      return
    sending = next
    emitStateChange()
  }

  function isForegroundSession(sessionId: string) {
    return sessionId === deps.getActiveSessionId()
  }

  function patchForegroundStream(sessionId: string, message: StreamingAssistantMessage) {
    if (isForegroundSession(sessionId))
      deps.foregroundStream.patch(cloneStreamingMessage(message))
  }

  function resetForegroundStream(sessionId: string) {
    if (isForegroundSession(sessionId))
      deps.foregroundStream.reset()
  }

  function ingestRuntimeContexts() {
    for (const provider of deps.runtimeContextProviders ?? []) {
      const contextMessage = provider()
      if (contextMessage)
        deps.context.ingest(contextMessage)
    }
  }

  function buildProviderMessages(sessionMessagesForSend: ChatHistoryItem[]): Message[] {
    const nowTs = now()
    const providerMessages: Message[] = []

    for (const msg of sessionMessagesForSend) {
      const {
        activeResponseAlternative: _activeResponseAlternative,
        context: _context,
        createdAt,
        excludedFromPrompt,
        id: _id,
        responseAlternatives: _responseAlternatives,
        ...withoutContext
      } = msg
      if (excludedFromPrompt)
        continue

      const rawMessage = unwrapMessage(withoutContext)

      if (rawMessage.role === 'error')
        continue

      if (rawMessage.role === 'user') {
        providerMessages.push(prependTextToContent(rawMessage, formatTimePrefix(createdAt ?? nowTs)))
        continue
      }

      if (rawMessage.role === 'assistant') {
        const { slices: _slices, tool_results: _toolResults, categorization: _categorization, ...rest } = rawMessage as ChatAssistantMessage
        providerMessages.push(unwrapMessage(rest))
        continue
      }

      providerMessages.push(rawMessage)
    }

    return providerMessages
  }

  async function performSend(
    sendingMessage: string,
    options: ChatOrchestratorSendOptions,
    generation: number,
    sessionId: string,
    turnId: string,
    deadlineAt: number | undefined,
    abortSignal: AbortSignal,
  ) {
    if (!sendingMessage && !options.attachments?.length)
      return

    deps.session.ensureSession(sessionId)

    // Datetime is no longer injected through the side-channel context store.
    // It is applied at message-assembly time (see below) as a system-prompt
    // date anchor + per-message [HH:MM] prefixes, which is more KV-cache
    // friendly and less prone to weak models echoing timestamps verbatim.
    ingestRuntimeContexts()

    const sendingCreatedAt = now()

    // TODO: Expire or prune stale runtime contexts from disconnected services before composing.
    const streamingMessageContext: ChatStreamEventContext = {
      turnId,
      generation,
      deadlineAt,
      sessionId,
      promptContributions: [],
      message: { role: 'user', content: sendingMessage, createdAt: sendingCreatedAt, id: createId() },
      contexts: deps.context.snapshot(),
      composedMessage: [],
      input: options.input,
    }
    deps.onLifecycle?.({
      phase: 'before-compose',
      channel: 'chat',
      sessionId,
      textPreview: sendingMessage,
      details: {
        contexts: streamingMessageContext.contexts,
      },
    })

    const isStaleGeneration = () => deps.session.getSessionGeneration(sessionId) !== generation
    const isPastDeadline = () => deadlineAt !== undefined && deadlineAt <= now()
    const shouldAbort = () => abortSignal.aborted || isStaleGeneration() || isPastDeadline()
    const isTurnActive = () => !shouldAbort()
    const throwIfTurnInactive = () => {
      if (abortSignal.aborted)
        throw cancellationErrorFrom(abortSignal)
      if (isStaleGeneration())
        throw new ChatTurnCancelledError('reset')
      if (isPastDeadline())
        throw new ChatTurnCancelledError('deadline')
    }
    const waitForTurnBoundary = async <T>(promise: Promise<T>): Promise<T> => {
      const result = await waitForPromiseOrAbort(promise, abortSignal)
      throwIfTurnInactive()
      return result
    }
    throwIfTurnInactive()

    const buildingMessage: StreamingAssistantMessage = {
      role: 'assistant',
      content: '',
      slices: [],
      tool_results: [],
      createdAt: now(),
      id: createId(),
    }
    patchForegroundStream(sessionId, buildingMessage)
    deps.onTrackFirstMessage?.()
    deps.onMessageSendStarted?.({
      source: options.input ? 'voice' : 'text',
      model: options.model,
    })
    const roundStartedAt = monotonicNow()

    try {
      await waitForTurnBoundary(hooks.emitBeforeMessageComposedHooks(sendingMessage, streamingMessageContext, isTurnActive))

      const contentParts: CommonContentPart[] = [{ type: 'text', text: sendingMessage }]

      if (options.attachments) {
        for (const attachment of options.attachments) {
          if (attachment.type === 'image') {
            contentParts.push({
              type: 'image_url',
              image_url: {
                url: `data:${attachment.mimeType};base64,${attachment.data}`,
              },
            })
          }
        }
      }

      const finalContent = contentParts.length > 1 ? contentParts : sendingMessage
      if (!streamingMessageContext.input) {
        streamingMessageContext.input = {
          type: 'input:text',
          data: {
            text: sendingMessage,
          },
        }
      }

      throwIfTurnInactive()

      const userMessageId = createId()
      const userMessage = {
        role: 'user' as const,
        content: finalContent,
        createdAt: sendingCreatedAt,
        id: userMessageId,
      }
      deps.session.appendSessionMessage(sessionId, userMessage)

      // Cloud sync v1: only the raw text part round-trips; image attachments
      // and other non-text parts stay local.
      deps.onUserMessageAppended?.({
        sessionId,
        turnId,
        message: userMessage,
        messageText: sendingMessage,
        input: streamingMessageContext.input,
      })

      const sessionMessagesForSend = deps.session.getSessionMessages(sessionId)
      throwIfTurnInactive()
      deps.onUserTurnReady?.({
        sessionId,
        turnId,
        messageText: sendingMessage,
        sessionMessages: sessionMessagesForSend,
      })

      const categorizer = createStreamingCategorizer(deps.getActiveProvider())
      let streamPosition = 0

      const parser = useLlmmarkerParser({
        onLiteral: async (literal) => {
          if (shouldAbort())
            return

          categorizer.consume(literal)

          const speechOnly = categorizer.filterToSpeech(literal, streamPosition)
          streamPosition += literal.length

          if (speechOnly.trim()) {
            await hooks.emitTokenLiteralHooks(speechOnly, streamingMessageContext, isTurnActive)
            if (shouldAbort())
              return

            buildingMessage.content += speechOnly
            const lastSlice = buildingMessage.slices.at(-1)
            if (lastSlice?.type === 'text') {
              lastSlice.text += speechOnly
            }
            else {
              buildingMessage.slices.push({
                type: 'text',
                text: speechOnly,
              })
            }
            patchForegroundStream(sessionId, buildingMessage)
          }
        },
        onSpecial: async (special) => {
          if (shouldAbort())
            return

          await hooks.emitTokenSpecialHooks(special, streamingMessageContext, isTurnActive)
        },
        onEnd: async (fullText) => {
          if (shouldAbort())
            return

          const finalCategorization = categorizeResponse(fullText, deps.getActiveProvider())

          const reasoningContentField = buildingMessage.categorization?.reasoning?.trim()
          buildingMessage.categorization = {
            speech: finalCategorization.speech,
            reasoning: reasoningContentField || finalCategorization.reasoning,
          }
          patchForegroundStream(sessionId, buildingMessage)
        },
        minLiteralEmitLength: STREAMING_UI_FLUSH_CHUNK_SIZE,
      })

      const toolCallQueue = createQueue<ChatSlices>({
        handlers: [
          async (ctx) => {
            if (shouldAbort())
              return
            if (ctx.data.type === 'tool-call') {
              buildingMessage.slices.push(ctx.data)
              patchForegroundStream(sessionId, buildingMessage)
              return
            }

            if (ctx.data.type === 'tool-call-result') {
              buildingMessage.tool_results.push(ctx.data)
              patchForegroundStream(sessionId, buildingMessage)
            }
          },
        ],
      })

      const contributions = [...streamingMessageContext.promptContributions]
      const systemPromptSupplement = deps.getSystemPromptSupplement?.()?.trim()
      if (systemPromptSupplement) {
        contributions.push({
          content: systemPromptSupplement,
          id: 'legacy-system-supplement',
          label: 'System supplement',
          placement: 'system-after',
          source: 'legacy-system-supplement',
          status: 'included',
        })
      }
      const newMessages = composePromptContributions(
        buildProviderMessages(sessionMessagesForSend),
        contributions,
      )

      const contextsSnapshot = deps.context.snapshot()
      const contextPromptText = formatContextPromptText(contextsSnapshot)
      if (contextPromptText) {
        const lastMessage = newMessages.at(-1)
        if (lastMessage && lastMessage.role === 'user') {
          const existingParts = typeof lastMessage.content === 'string'
            ? [{ type: 'text' as const, text: lastMessage.content }]
            : lastMessage.content

          lastMessage.content = [
            ...existingParts,
            { type: 'text' as const, text: `\n${contextPromptText}` },
          ]
        }

        deps.onLifecycle?.({
          phase: 'prompt-context-built',
          channel: 'chat',
          sessionId,
          details: {
            contexts: contextsSnapshot,
            promptText: contextPromptText,
          },
        })
      }

      streamingMessageContext.composedMessage = newMessages as Message[]
      deps.onPromptProjection?.({
        sessionId,
        message: sendingMessage,
        contexts: contextsSnapshot,
        promptMessage: undefined,
        composedMessage: newMessages as Message[],
        contributions,
      })
      deps.onLifecycle?.({
        phase: 'after-compose',
        channel: 'chat',
        sessionId,
        textPreview: sendingMessage,
        details: {
          composedMessage: newMessages,
        },
      })

      await waitForTurnBoundary(hooks.emitAfterMessageComposedHooks(sendingMessage, streamingMessageContext, isTurnActive))
      await waitForTurnBoundary(hooks.emitBeforeSendHooks(sendingMessage, streamingMessageContext, isTurnActive))

      let fullText = ''
      const headers = (options.providerConfig?.headers || {}) as Record<string, string>

      throwIfTurnInactive()

      const llmRequestStartedAt = monotonicNow()
      let llmFirstTokenEmitted = false
      deps.onLlmRequestStarted?.({
        model: options.model,
        provider: deps.getActiveProvider() || 'unknown',
        hasVoice: !!options.input,
      })

      const providerPromise = deps.llm.stream(options.model, options.chatProvider, newMessages as Message[], {
        turnId,
        abortSignal,
        headers,
        tools: options.tools,
        waitForTools: true,
        captureToolErrors: true,
        onStreamEvent: async (event: StreamEvent) => {
          if (shouldAbort())
            return

          switch (event.type) {
            case 'tool-call':
              toolCallQueue.enqueue({
                type: 'tool-call',
                toolCall: event,
              })

              break
            case 'tool-result':
              toolCallQueue.enqueue({
                type: 'tool-call-result',
                id: event.toolCallId,
                result: event.result,
              })

              break
            case 'tool-error':
              toolCallQueue.enqueue({
                type: 'tool-call-result',
                id: event.toolCallId,
                isError: true,
                result: event.result,
              })

              break
            case 'text-delta':
              if (!llmFirstTokenEmitted) {
                llmFirstTokenEmitted = true
                deps.onLlmFirstToken?.({
                  model: options.model,
                  ttfbMs: Math.round(monotonicNow() - llmRequestStartedAt),
                })
              }
              fullText += event.text
              await waitForTurnBoundary(parser.consume(event.text))
              break
            case 'reasoning-delta': {
              if (shouldAbort())
                return

              const { reasoning = '' } = buildingMessage.categorization ?? {}
              const nextReasoning = reasoning + event.text
              buildingMessage.categorization = {
                speech: typeof buildingMessage.content === 'string' ? buildingMessage.content : '',
                reasoning: nextReasoning,
              }
              const crossesBoundary
                = Math.floor(nextReasoning.length / STREAMING_UI_FLUSH_CHUNK_SIZE)
                  > Math.floor(reasoning.length / STREAMING_UI_FLUSH_CHUNK_SIZE)
              if (!reasoning || crossesBoundary)
                patchForegroundStream(sessionId, buildingMessage)
              break
            }
            case 'finish':
              break
            case 'error':
              throw event.error ?? new Error('Stream error')
          }
        },
      })
      await waitForTurnBoundary(providerPromise)

      await waitForTurnBoundary(parser.end())
      deps.onAssistantResponseRendered?.({
        model: options.model,
        latencyMs: Math.round(monotonicNow() - llmRequestStartedAt),
      })

      await waitForTurnBoundary(hooks.emitStreamEndHooks(streamingMessageContext, isTurnActive))
      await waitForTurnBoundary(hooks.emitAssistantResponseEndHooks(fullText, streamingMessageContext, isTurnActive))

      await waitForTurnBoundary(hooks.emitAfterSendHooks(sendingMessage, streamingMessageContext, isTurnActive))
      await waitForTurnBoundary(hooks.emitAssistantMessageHooks({ ...buildingMessage }, fullText, streamingMessageContext, isTurnActive))
      await waitForTurnBoundary(hooks.emitChatTurnCompleteHooks({
        output: { ...buildingMessage },
        outputText: fullText,
        toolCalls: sessionMessagesForSend.filter(msg => msg.role === 'tool') as ToolMessage[],
      }, streamingMessageContext, isTurnActive))

      // The assistant message is the durable success commit. Keep it after every
      // awaited post-provider hook so a deadline cannot leave hidden history or
      // trigger persistence/memory for a turn that externally failed.
      throwIfTurnInactive()
      if (buildingMessage.slices.length > 0) {
        const finalAssistant = buildingMessage
        deps.session.appendSessionMessage(sessionId, finalAssistant)
        deps.onAssistantMessageAppended?.({
          sessionId,
          turnId,
          message: finalAssistant,
          messageText: fullText,
          input: streamingMessageContext.input,
        })
      }

      deps.onAssistantTurnReady?.({
        sessionId,
        turnId,
        messageText: fullText,
        sessionMessages: deps.session.getSessionMessages(sessionId),
      })

      resetForegroundStream(sessionId)
      deps.onMessageRound?.({
        durationMs: Math.round(monotonicNow() - roundStartedAt),
        hasVoice: !!options.input,
        model: options.model,
      })
    }
    catch (error) {
      const cancellationReason = error instanceof ChatTurnCancelledError
        ? error.reason
        : abortSignal.aborted
          ? 'cancelled'
          : isStaleGeneration()
            ? 'reset'
            : undefined
      if (cancellationReason)
        await hooks.emitTurnCancelledHooks(streamingMessageContext, cancellationReason)
      else
        console.error('Error sending message:', error)
      throw error
    }
    finally {
      deps.onSendSettled?.({ sessionId, turnId })
    }
  }

  function cleanupTurn(queued: QueuedSend) {
    if (queued.deadlineTimer)
      clearTimeout(queued.deadlineTimer)
    queued.removeExternalAbortListener?.()
    turnPromisesById.delete(queued.turnId)
  }

  function resolveTurn(queued: QueuedSend) {
    if (queued.promiseSettled)
      return
    queued.promiseSettled = true
    cleanupTurn(queued)
    queued.deferred.resolve()
  }

  function rejectTurn(queued: QueuedSend, error: unknown) {
    if (queued.promiseSettled)
      return
    queued.promiseSettled = true
    cleanupTurn(queued)
    queued.deferred.reject(error)
  }

  function removeReadySession(sessionId: string) {
    for (let index = readySessionIds.length - 1; index >= 0; index -= 1) {
      if (readySessionIds[index] === sessionId)
        readySessionIds.splice(index, 1)
    }
  }

  function removePendingTurn(queued: QueuedSend) {
    pendingQueuedSends = pendingQueuedSends.filter(item => item !== queued)
    const sessionQueue = queuesBySessionId.get(queued.sessionId)
    if (!sessionQueue)
      return

    const queueIndex = sessionQueue.indexOf(queued)
    if (queueIndex >= 0)
      sessionQueue.splice(queueIndex, 1)
    if (sessionQueue.length > 0)
      return

    queuesBySessionId.delete(queued.sessionId)
    removeReadySession(queued.sessionId)
  }

  function queueSessionWhenReady(sessionId: string) {
    if (activeSessionIds.has(sessionId) || readySessionIds.includes(sessionId))
      return
    if ((queuesBySessionId.get(sessionId)?.length ?? 0) === 0)
      return
    readySessionIds.push(sessionId)
  }

  function scheduleQueuedSends() {
    while (runningSendCount < queuePolicy.maxConcurrentSessions && readySessionIds.length > 0) {
      const sessionId = readySessionIds.shift()
      if (!sessionId || activeSessionIds.has(sessionId))
        continue

      const sessionQueue = queuesBySessionId.get(sessionId)
      const queued = sessionQueue?.shift()
      if (!queued)
        continue

      if (sessionQueue.length === 0)
        queuesBySessionId.delete(sessionId)

      pendingQueuedSends = pendingQueuedSends.filter(item => item !== queued)
      activeSessionIds.add(sessionId)
      activeTurnsById.set(queued.turnId, queued)
      runningSendCount += 1
      setSending(true)
      emitStateChange()

      void (async () => {
        try {
          if (queued.cancelled || queued.controller.signal.aborted)
            throw cancellationErrorFrom(queued.controller.signal)
          if (deps.session.getSessionGeneration(sessionId) !== queued.generation)
            throw new ChatTurnCancelledError('reset')

          await performSend(
            queued.sendingMessage,
            queued.options,
            queued.generation,
            queued.sessionId,
            queued.turnId,
            queued.deadlineAt,
            queued.controller.signal,
          )
          resolveTurn(queued)
        }
        catch (error) {
          rejectTurn(queued, error)
        }
        finally {
          activeTurnsById.delete(queued.turnId)
          activeSessionIds.delete(sessionId)
          runningSendCount -= 1
          setSending(runningSendCount > 0)
          queueSessionWhenReady(sessionId)
          emitStateChange()
          scheduleQueuedSends()
        }
      })()
    }
  }

  function ingest(
    sendingMessage: string,
    options: ChatOrchestratorSendOptions,
    targetSessionId?: string,
  ) {
    const sessionId = targetSessionId || deps.getActiveSessionId()
    const generation = deps.session.getSessionGeneration(sessionId)
    const turnId = options.turnId?.trim() || createTurnId()
    const existingTurn = turnPromisesById.get(turnId)
    if (existingTurn)
      return existingTurn

    const sessionQueueLength = queuesBySessionId.get(sessionId)?.length ?? 0
    if (sessionQueueLength >= queuePolicy.maxQueuedPerSession)
      return Promise.reject(new ChatQueueCapacityError('session'))
    if (pendingQueuedSends.length >= queuePolicy.maxQueuedTotal)
      return Promise.reject(new ChatQueueCapacityError('global'))

    const deadlineAt = options.deadlineAt !== undefined && Number.isFinite(options.deadlineAt)
      ? options.deadlineAt
      : undefined
    if (deadlineAt !== undefined && deadlineAt <= now())
      return Promise.reject(new ChatTurnCancelledError('deadline'))
    if (options.abortSignal?.aborted)
      return Promise.reject(cancellationErrorFrom(options.abortSignal))

    const turnPromise = new Promise<void>((resolve, reject) => {
      const controller = new AbortController()
      const queued: QueuedSend = {
        sendingMessage,
        options,
        generation,
        sessionId,
        turnId,
        deadlineAt,
        controller,
        promiseSettled: false,
        deferred: { resolve, reject },
      }

      if (deadlineAt !== undefined) {
        // The timeout starts at ingress, not provider start, so queue wait cannot
        // silently extend the externally advertised deadline.
        queued.deadlineTimer = setTimeout(() => {
          cancelTurn(turnId, 'deadline')
        }, Math.max(0, deadlineAt - now()))
      }

      if (options.abortSignal) {
        const onExternalAbort = () => cancelTurn(turnId, 'cancelled')
        options.abortSignal.addEventListener('abort', onExternalAbort, { once: true })
        queued.removeExternalAbortListener = () => options.abortSignal?.removeEventListener('abort', onExternalAbort)
      }

      const sessionQueue = queuesBySessionId.get(sessionId) ?? []
      sessionQueue.push(queued)
      queuesBySessionId.set(sessionId, sessionQueue)
      pendingQueuedSends.push(queued)
      queueSessionWhenReady(sessionId)
      emitStateChange()
      scheduleQueuedSends()
    })
    turnPromisesById.set(turnId, turnPromise)
    return turnPromise
  }

  function cancelPendingSends(sessionId?: string) {
    for (const queued of pendingQueuedSends) {
      if (sessionId && queued.sessionId !== sessionId)
        continue

      queued.cancelled = true
      const error = new ChatTurnCancelledError('reset')
      queued.controller.abort(error)
      removePendingTurn(queued)
      rejectTurn(queued, error)
    }

    emitStateChange()
    scheduleQueuedSends()
  }

  function cancelTurn(turnId: string, reason: ChatTurnCancelledError['reason'] = 'cancelled') {
    const queued = pendingQueuedSends.find(item => item.turnId === turnId)
    const active = activeTurnsById.get(turnId)
    const turn = queued ?? active
    if (!turn)
      return false

    const error = new ChatTurnCancelledError(reason)
    turn.cancelled = true
    turn.controller.abort(error)
    if (queued) {
      removePendingTurn(queued)
      rejectTurn(queued, error)
      emitStateChange()
      scheduleQueuedSends()
    }
    return true
  }

  function cancelSessionSends(sessionId?: string) {
    cancelPendingSends(sessionId)
    for (const active of activeTurnsById.values()) {
      if (sessionId && active.sessionId !== sessionId)
        continue
      cancelTurn(active.turnId, 'reset')
    }
  }

  function getPendingQueuedSendSnapshot() {
    return pendingQueuedSends.map(queued => ({
      turnId: queued.turnId,
      sessionId: queued.sessionId,
      generation: queued.generation,
      cancelled: !!queued.cancelled,
      messagePreview: queued.sendingMessage.slice(0, 120),
      hasAttachments: !!queued.options.attachments?.length,
      inputType: queued.options.input?.type,
      ...(queued.deadlineAt !== undefined ? { deadlineAt: queued.deadlineAt } : {}),
    } satisfies QueuedSendSnapshot))
  }

  return {
    ingest,
    cancelPendingSends,
    cancelTurn,
    cancelSessionSends,
    getPendingQueuedSendSnapshot,
    getPendingQueuedSendCount: () => pendingQueuedSends.length,
    getSending: () => sending,
    setSending,
    hooks,
  }
}
