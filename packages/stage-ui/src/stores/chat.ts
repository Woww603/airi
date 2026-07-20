import type { ChatOrchestratorRuntimeState, ChatOrchestratorSendOptions, ChatTurnCancellationReason, PromptContribution, StreamEvent, StreamOptions } from '@proj-airi/core-agent'
import type { ChatProvider } from '@xsai-ext/providers/utils'
import type { Message } from '@xsai/shared-chat'

import type { ChatHistoryItem } from '../types/chat'

import { evaluateCharacterBook } from '@proj-airi/ccc'
import { createChatOrchestratorRuntime } from '@proj-airi/core-agent'
import { IOAttributes, IOEvents, IOSpanNames, IOSubsystems } from '@proj-airi/stage-shared'
import { nanoid } from 'nanoid'
import { defineStore, storeToRefs } from 'pinia'
import { ref, toRaw, watch } from 'vue'

import { useAnalytics } from '../composables'
import { activeTurnSpan, startSpan } from '../composables/use-io-tracer'
import {
  buildChatSafetyPolicyPrompt,
  shouldKeepChatHistoryText,
} from '../libs/chat-safety-policy'
import { extractMessageText, isCloudSyncableMessage } from '../libs/chat-sync'
import { createMinecraftContext } from './chat/context-providers'
import { useChatContextStore } from './chat/context-store'
import { useChatMemoryStore } from './chat/memory-store'
import { useChatSessionStore } from './chat/session-store'
import { useChatStreamStore } from './chat/stream-store'
import { useContextObservabilityStore } from './devtools/context-observability'
import { useLLM } from './llm'
import { useLlmToolsetPromptsStore } from './llm-toolset-prompts'
import { useAiriCardStore } from './modules/airi-card'
import { useAutonomousArtistryStore } from './modules/artistry-autonomous'
import { useConsciousnessStore } from './modules/consciousness'
import { useDiscordStore } from './modules/discord'

interface ForkOptions {
  fromSessionId?: string
  atIndex?: number
  reason?: string
  hidden?: boolean
}

type ProviderHistoryMessage = Exclude<ChatHistoryItem, { role: 'error' }>

function toProviderHistory(messages: ChatHistoryItem[]): Message[] {
  return messages.filter((message): message is ProviderHistoryMessage => message.role !== 'error')
}

function isTextDelta(event: StreamEvent): event is Extract<StreamEvent, { type: 'text-delta' }> {
  return event.type === 'text-delta'
}

export type { QueuedSendSnapshot, ChatOrchestratorSendOptions as SendOptions } from '@proj-airi/core-agent'

export const useChatOrchestratorStore = defineStore('chat-orchestrator', () => {
  const llmStore = useLLM()
  const llmToolsetPromptsStore = useLlmToolsetPromptsStore()
  const consciousnessStore = useConsciousnessStore()
  const artistryAutonomousStore = useAutonomousArtistryStore()
  const { activeProvider } = storeToRefs(consciousnessStore)
  const {
    trackFirstMessage,
    trackMessageSendStarted,
    trackLlmRequestStarted,
    trackLlmFirstToken,
    trackAssistantResponseRendered,
    trackMessageRound,
  } = useAnalytics()

  const chatSession = useChatSessionStore()
  const chatStream = useChatStreamStore()
  const chatContext = useChatContextStore()
  const chatMemory = useChatMemoryStore()
  const cardStore = useAiriCardStore()
  const discordStore = useDiscordStore()
  const contextObservability = useContextObservabilityStore()
  const { activeSessionId } = storeToRefs(chatSession)
  const { streamingMessage } = storeToRefs(chatStream)

  const sending = ref(false)
  const pendingQueuedSendCount = ref(0)
  const currentTurnUserMessageIdsBySessionId = new Map<string, Set<string>>()
  const ownedTurnSpansByTurnId = new Map<string, NonNullable<typeof activeTurnSpan.value>>()

  function shouldKeepProviderHistoryMessage(sessionId: string, message: ChatHistoryItem) {
    if (message.id && currentTurnUserMessageIdsBySessionId.get(sessionId)?.has(message.id))
      return true

    if (message.role !== 'user' && message.role !== 'assistant')
      return true

    const messageText = extractMessageText(message)
    return shouldKeepChatHistoryText(message.role, messageText)
  }

  function getProviderSafeSessionMessages(sessionId: string) {
    return chatSession
      .getSessionMessages(sessionId)
      .filter(message => shouldKeepProviderHistoryMessage(sessionId, message))
      .map(message => toRaw(message))
  }

  async function streamWithStageAdapters(
    model: string,
    chatProvider: ChatProvider,
    messages: Message[],
    options?: StreamOptions,
  ) {
    let llmTextLength = 0

    const turnId = options?.turnId
    const hadExistingTurn = !!activeTurnSpan.value && ownedTurnSpansByTurnId.size === 0
    let turnSpan = activeTurnSpan.value
    if (!hadExistingTurn) {
      turnSpan = startSpan(IOSpanNames.InteractionTurn)
      if (!activeTurnSpan.value)
        activeTurnSpan.value = turnSpan
      if (turnId)
        ownedTurnSpansByTurnId.set(turnId, turnSpan)
    }

    const llmSpan = startSpan(IOSpanNames.LLMInference, turnSpan, {
      [IOAttributes.Subsystem]: IOSubsystems.LLM,
      [IOAttributes.GenAIRequestModel]: model,
    })
    const llmRequestTs = performance.now()
    let llmFirstTokenEmitted = false

    try {
      const { turnId: _turnId, ...providerOptions } = options ?? {}
      await llmStore.stream(model, chatProvider, messages, {
        ...providerOptions,
        onStreamEvent: async (event: StreamEvent) => {
          if (isTextDelta(event)) {
            if (!llmFirstTokenEmitted) {
              llmFirstTokenEmitted = true
              llmSpan.addEvent(IOEvents.LLMFirstToken, {
                [IOAttributes.LLM_TTFT]: performance.now() - llmRequestTs,
              })
            }
            llmTextLength += event.text.length
          }

          await options?.onStreamEvent?.(event)
        },
      })

      llmSpan.setAttribute(IOAttributes.LLMTextLength, llmTextLength)
    }
    finally {
      llmSpan.end()
    }
  }

  function syncRuntimeState(state: ChatOrchestratorRuntimeState) {
    sending.value = state.sending
    pendingQueuedSendCount.value = state.pendingQueuedSendCount
  }

  function settleOwnedTurn(turnId: string, sessionId: string) {
    currentTurnUserMessageIdsBySessionId.delete(sessionId)
    const ownedTurnSpan = ownedTurnSpansByTurnId.get(turnId)
    if (!ownedTurnSpan)
      return

    ownedTurnSpan.end()
    ownedTurnSpansByTurnId.delete(turnId)
    if (activeTurnSpan.value === ownedTurnSpan)
      activeTurnSpan.value = undefined
  }

  const runtime = createChatOrchestratorRuntime({
    session: {
      ensureSession: sessionId => chatSession.ensureSession(sessionId),
      getSessionMessages: getProviderSafeSessionMessages,
      appendSessionMessage: (sessionId, message) => chatSession.appendSessionMessage(sessionId, message),
      getSessionGeneration: sessionId => chatSession.getSessionGeneration(sessionId),
    },
    context: {
      ingest: envelope => chatContext.ingestContextMessage(envelope),
      snapshot: () => chatContext.getContextsSnapshot(),
    },
    foregroundStream: {
      patch: (message) => {
        streamingMessage.value = message
      },
      reset: () => {
        streamingMessage.value = { role: 'assistant', content: '', slices: [], tool_results: [] }
      },
    },
    llm: {
      stream: streamWithStageAdapters,
    },
    getActiveSessionId: () => activeSessionId.value,
    getActiveProvider: () => activeProvider.value,
    runtimeContextProviders: [
      createMinecraftContext,
    ],
    createId: nanoid,
    unwrapMessage: message => toRaw(message),
    onStateChange: syncRuntimeState,
    onSendSettled: ({ sessionId, turnId }) => settleOwnedTurn(turnId, sessionId),
    onTrackFirstMessage: trackFirstMessage,
    onMessageSendStarted: ({ source, model }) => trackMessageSendStarted({
      source,
      model,
    }),
    onLlmRequestStarted: ({ model, provider, hasVoice }) => trackLlmRequestStarted({
      model,
      provider,
      has_voice: hasVoice,
    }),
    onLlmFirstToken: ({ model, ttfbMs }) => trackLlmFirstToken({
      model,
      ttfb_ms: ttfbMs,
    }),
    onAssistantResponseRendered: ({ model, latencyMs }) => trackAssistantResponseRendered({
      model,
      latency_ms: latencyMs,
    }),
    onMessageRound: ({ durationMs, hasVoice, model }) => trackMessageRound({
      duration_ms: durationMs,
      has_voice: hasVoice,
      model,
    }),
    onLifecycle: record => contextObservability.recordLifecycle(record),
    onPromptProjection: payload => contextObservability.capturePromptProjection(payload),
    onUserMessageAppended: ({ sessionId, message, messageText, input }) => {
      const currentTurnUserMessageIds = currentTurnUserMessageIdsBySessionId.get(sessionId) ?? new Set<string>()
      currentTurnUserMessageIds.add(message.id)
      currentTurnUserMessageIdsBySessionId.set(sessionId, currentTurnUserMessageIds)
      const turnInput = input
      const discordMemoryContext = chatMemory.resolveDiscordMemoryContext(turnInput)

      const hasDiscordPayload = Boolean(turnInput?.data.discord)
      const automaticMemoryAllowed = !hasDiscordPayload
        && !discordMemoryContext
        && discordStore.shouldUseLongTermMemoryForInput(turnInput)
      if (discordMemoryContext) {
        void chatMemory.rememberDiscordShortTermMessage({
          input: turnInput,
          role: 'user',
          content: messageText,
          createdAt: message.createdAt,
        })
      }
      else if (automaticMemoryAllowed) {
        void chatMemory.rememberMessage({
          sessionId,
          role: 'user',
          content: messageText,
        })
      }

      if (turnInput?.data.overrides?.cloudSync !== 'disabled' && isCloudSyncableMessage(message)) {
        void chatSession.pushMessageToCloud(sessionId, {
          id: message.id,
          role: 'user',
          content: messageText,
        })
      }
    },
    onAssistantMessageAppended: ({ sessionId, message, input }) => {
      const content = extractMessageText(message)
      const turnInput = input
      const discordMemoryContext = chatMemory.resolveDiscordMemoryContext(turnInput)
      const hasDiscordPayload = Boolean(turnInput?.data.discord)
      const automaticMemoryAllowed = !hasDiscordPayload
        && !discordMemoryContext
        && discordStore.shouldUseLongTermMemoryForInput(turnInput)
      if (discordMemoryContext) {
        void chatMemory.rememberDiscordShortTermMessage({
          input: turnInput,
          role: 'assistant',
          content,
          createdAt: message.createdAt,
        })
      }
      else if (automaticMemoryAllowed) {
        void chatMemory.rememberMessage({
          sessionId,
          role: 'assistant',
          content,
        })
      }

      if (turnInput?.data.overrides?.cloudSync !== 'disabled' && isCloudSyncableMessage(message) && message.id) {
        void chatSession.pushMessageToCloud(sessionId, {
          id: message.id,
          role: 'assistant',
          content,
        })
      }
    },
    onUserTurnReady: ({ messageText, sessionMessages }) => {
      const autonomousTarget = cardStore.activeCard?.extensions?.airi?.modules?.artistry?.autonomousTarget || 'user'
      if (autonomousTarget === 'user')
        void artistryAutonomousStore.runArtistTask(messageText, toProviderHistory(sessionMessages))
    },
    onAssistantTurnReady: ({ messageText, sessionMessages }) => {
      const artistry = cardStore.activeCard?.extensions?.airi?.modules?.artistry
      if (artistry?.autonomousEnabled && artistry?.autonomousTarget === 'assistant')
        void artistryAutonomousStore.runArtistTask(messageText, toProviderHistory(sessionMessages))
    },
  })

  runtime.hooks.onBeforeMessageComposed(async (message, context) => {
    const discordMemoryContext = chatMemory.resolveDiscordMemoryContext(context.input)
    const hasDiscordPayload = Boolean(context.input?.data.discord)
    const automaticMemoryAllowed = !hasDiscordPayload
      && !discordMemoryContext
      && discordStore.shouldUseLongTermMemoryForInput(context.input)
    const scopedMemoryPrompt = await chatMemory.buildDiscordPromptForInput({
      input: context.input,
    })
    const automaticMemoryPrompt = automaticMemoryAllowed
      ? await chatMemory.buildPromptForMessage({
          sessionId: context.sessionId,
          message,
        })
      : ''
    const memoryPrompt = [
      scopedMemoryPrompt,
      automaticMemoryPrompt,
    ].filter(Boolean).join('\n\n')

    const promptProfile = chatSession.getSessionPromptProfile(context.sessionId)
    const sessionPromptContributions: PromptContribution[] = []
    if (promptProfile?.userPersona) {
      sessionPromptContributions.push({
        content: [
          `User persona${promptProfile.userPersona.name ? `: ${promptProfile.userPersona.name}` : ''}`,
          promptProfile.userPersona.description,
        ].filter(Boolean).join('\n'),
        id: 'session-user-persona',
        label: 'User persona',
        placement: 'system-before',
        source: 'user-persona',
        status: 'included',
      })
    }
    if (promptProfile?.rollingSummary) {
      sessionPromptContributions.push({
        content: `Conversation summary:\n${promptProfile.rollingSummary.content}`,
        id: 'session-rolling-summary',
        label: 'Editable conversation summary',
        metadata: {
          sourceMessageIds: promptProfile.rollingSummary.sourceMessageIds,
          updatedAt: promptProfile.rollingSummary.updatedAt,
        },
        placement: 'system-after',
        source: 'rolling-summary',
        status: 'included',
      })
    }
    if (promptProfile?.authorNote) {
      sessionPromptContributions.push({
        content: `Author's note:\n${promptProfile.authorNote}`,
        id: 'session-author-note',
        label: 'Author note',
        placement: 'system-after',
        source: 'author-note',
        status: 'included',
      })
    }
    const characterBook = cardStore.activeCard?.characterBook
    let lorebookContributions: PromptContribution[] = []
    if (characterBook) {
      const messages = chatSession
        .getSessionMessages(context.sessionId)
        .filter(historyItem => historyItem.role === 'user' || historyItem.role === 'assistant')
        .map(historyItem => extractMessageText(historyItem))
      const evaluation = evaluateCharacterBook(characterBook, {
        messages: [...messages, message],
      })

      lorebookContributions = evaluation.entries.map(entry => ({
        content: entry.content,
        estimatedTokens: entry.estimatedTokens,
        id: `character-lorebook:${entry.id}:${entry.index}`,
        label: entry.name ?? `Lore entry ${entry.id}`,
        metadata: {
          characterId: cardStore.activeCardId,
          matchedBy: entry.matchedBy,
          reason: entry.status,
          tokenBudget: evaluation.tokenBudget,
          usedTokens: evaluation.usedTokens,
        },
        placement: entry.position === 'before_char' ? 'system-before' : 'system-after',
        source: 'character-lorebook',
        status: entry.status === 'included' ? 'included' : 'excluded',
      }))
    }

    const turnContributions: PromptContribution[] = [
      ...lorebookContributions,
      ...sessionPromptContributions,
    ]
    if (memoryPrompt.trim()) {
      turnContributions.push({
        content: memoryPrompt,
        id: 'chat-memory',
        label: 'Relevant memory',
        placement: 'system-after',
        source: 'memory',
        status: 'included',
      })
    }

    const safetyPolicyPrompt = buildChatSafetyPolicyPrompt({ assistantName: cardStore.activeCard?.name })
    if (safetyPolicyPrompt.trim()) {
      turnContributions.push({
        content: safetyPolicyPrompt,
        id: 'chat-safety-policy',
        label: 'Chat safety policy',
        placement: 'system-after',
        source: 'safety-policy',
        status: 'included',
      })
    }

    const discordRulesContribution = discordStore.buildRulesPromptContributionForInput(
      context.input,
      context.sessionId,
      turnContributions.length,
    )
    if (discordRulesContribution)
      turnContributions.push(discordRulesContribution)

    if (llmToolsetPromptsStore.activeToolsetPrompt.trim()) {
      turnContributions.push({
        content: llmToolsetPromptsStore.activeToolsetPrompt,
        id: 'toolset-guidance',
        label: 'Toolset guidance',
        placement: 'system-after',
        source: 'tools',
        status: 'included',
      })
    }

    context.promptContributions.push(...turnContributions)
  })

  watch(sending, (next) => {
    if (runtime.getSending() !== next)
      runtime.setSending(next)
  })

  async function ingest(
    sendingMessage: string,
    options: ChatOrchestratorSendOptions,
    targetSessionId?: string,
  ) {
    return runtime.ingest(sendingMessage, options, targetSessionId)
  }

  async function ingestOnFork(
    sendingMessage: string,
    options: ChatOrchestratorSendOptions,
    forkOptions?: ForkOptions,
  ) {
    const baseSessionId = forkOptions?.fromSessionId ?? activeSessionId.value
    if (!forkOptions)
      return ingest(sendingMessage, options, baseSessionId)

    const forkSessionId = await chatSession.forkSession({
      fromSessionId: baseSessionId,
      atIndex: forkOptions.atIndex,
      reason: forkOptions.reason,
      hidden: forkOptions.hidden,
    })
    return ingest(sendingMessage, options, forkSessionId || baseSessionId)
  }

  function cancelPendingSends(sessionId?: string) {
    runtime.cancelPendingSends(sessionId)
  }

  function cancelTurn(turnId: string, reason?: ChatTurnCancellationReason) {
    return runtime.cancelTurn(turnId, reason)
  }

  function cancelSessionSends(sessionId?: string) {
    runtime.cancelSessionSends(sessionId)
  }

  function getPendingQueuedSendSnapshot() {
    return runtime.getPendingQueuedSendSnapshot()
  }

  return {
    sending,
    pendingQueuedSendCount,

    ingest,
    ingestOnFork,
    cancelPendingSends,
    cancelTurn,
    cancelSessionSends,
    getPendingQueuedSendSnapshot,

    clearHooks: runtime.hooks.clearHooks,

    emitBeforeMessageComposedHooks: runtime.hooks.emitBeforeMessageComposedHooks,
    emitAfterMessageComposedHooks: runtime.hooks.emitAfterMessageComposedHooks,
    emitBeforeSendHooks: runtime.hooks.emitBeforeSendHooks,
    emitAfterSendHooks: runtime.hooks.emitAfterSendHooks,
    emitTokenLiteralHooks: runtime.hooks.emitTokenLiteralHooks,
    emitTokenSpecialHooks: runtime.hooks.emitTokenSpecialHooks,
    emitStreamEndHooks: runtime.hooks.emitStreamEndHooks,
    emitAssistantResponseEndHooks: runtime.hooks.emitAssistantResponseEndHooks,
    emitAssistantMessageHooks: runtime.hooks.emitAssistantMessageHooks,
    emitChatTurnCompleteHooks: runtime.hooks.emitChatTurnCompleteHooks,
    emitTurnCancelledHooks: runtime.hooks.emitTurnCancelledHooks,

    onBeforeMessageComposed: runtime.hooks.onBeforeMessageComposed,
    onAfterMessageComposed: runtime.hooks.onAfterMessageComposed,
    onBeforeSend: runtime.hooks.onBeforeSend,
    onAfterSend: runtime.hooks.onAfterSend,
    onTokenLiteral: runtime.hooks.onTokenLiteral,
    onTokenSpecial: runtime.hooks.onTokenSpecial,
    onStreamEnd: runtime.hooks.onStreamEnd,
    onAssistantResponseEnd: runtime.hooks.onAssistantResponseEnd,
    onAssistantMessage: runtime.hooks.onAssistantMessage,
    onChatTurnComplete: runtime.hooks.onChatTurnComplete,
    onTurnCancelled: runtime.hooks.onTurnCancelled,
  }
})
