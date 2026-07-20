import type { ChatProvider } from '@xsai-ext/providers/utils'
import type { Message } from '@xsai/shared-chat'

import type { PromptContribution } from '../messages/prompt-contributions'
import type { ChatHistoryItem, ContextMessage, StreamingAssistantMessage } from '../types/chat'
import type { StreamEvent, StreamOptions } from '../types/llm'
import type { ChatOrchestratorPromptProjection, ChatOrchestratorQueuePolicy } from './chat-orchestrator-runtime'

import { ContextUpdateStrategy } from '@proj-airi/server-shared/types'
import { describe, expect, it, vi } from 'vitest'

import { createChatOrchestratorRuntime } from './chat-orchestrator-runtime'

const provider = {
  chat: () => ({ baseURL: 'https://example.com/' }),
} as unknown as ChatProvider

function createHarness(options: { queuePolicy?: Partial<ChatOrchestratorQueuePolicy> } = {}) {
  const sessionMessages: Record<string, ChatHistoryItem[]> = {
    'session-1': [
      {
        role: 'system',
        content: 'system prompt',
        createdAt: new Date(2026, 3, 25, 18, 0).getTime(),
        id: 'system',
      },
    ],
  }
  const contextSnapshot: Record<string, ContextMessage[]> = {}
  const foregroundPatches: StreamingAssistantMessage[] = []
  const foregroundResets: StreamingAssistantMessage[] = []
  const lifecycleRecords: unknown[] = []
  const promptProjections: ChatOrchestratorPromptProjection[] = []
  const userAppended: unknown[] = []
  const assistantAppended: unknown[] = []
  const userTurns: unknown[] = []
  const assistantTurns: unknown[] = []
  const stateChanges: unknown[] = []
  const telemetry = {
    messageSendStarted: [] as unknown[],
    llmRequestStarted: [] as unknown[],
    llmFirstToken: [] as unknown[],
    assistantResponseRendered: [] as unknown[],
    messageRound: [] as unknown[],
  }
  const stream = vi.fn(async (_model: string, _chatProvider: ChatProvider, _messages: Message[], options?: StreamOptions) => {
    await options?.onStreamEvent?.({ type: 'text-delta', text: 'assistant reply' })
    await options?.onStreamEvent?.({ type: 'finish', finishReason: 'stop' })
  })
  const ids = ['stream-context', 'assistant-id', 'user-id', 'fallback-id']
  let systemPromptSupplement: string | undefined
  let nowValue = new Date(2026, 3, 25, 18, 47).getTime()
  let monotonicNowValues = [1000]
  let generation = 1
  let turnSequence = 0

  const runtime = createChatOrchestratorRuntime({
    session: {
      ensureSession: (sessionId) => {
        sessionMessages[sessionId] ??= []
      },
      getSessionMessages: sessionId => sessionMessages[sessionId] ?? [],
      appendSessionMessage: (sessionId, message) => {
        sessionMessages[sessionId] ??= []
        sessionMessages[sessionId].push(message)
      },
      getSessionGeneration: () => generation,
    },
    context: {
      ingest: vi.fn(),
      snapshot: () => structuredClone(contextSnapshot),
    },
    foregroundStream: {
      patch: message => foregroundPatches.push(message),
      reset: () => foregroundResets.push({ role: 'assistant', content: '', slices: [], tool_results: [] }),
    },
    llm: {
      stream,
    },
    getActiveSessionId: () => 'session-1',
    getActiveProvider: () => 'mock-provider',
    getSystemPromptSupplement: () => systemPromptSupplement,
    now: () => nowValue,
    monotonicNow: () => monotonicNowValues.shift() ?? 1000,
    createId: () => ids.shift() ?? 'generated-id',
    createTurnId: () => `turn-${++turnSequence}`,
    ...(options.queuePolicy ? { queuePolicy: options.queuePolicy } : {}),
    onLifecycle: record => lifecycleRecords.push(record),
    onPromptProjection: payload => promptProjections.push(payload),
    onUserMessageAppended: event => userAppended.push(event),
    onAssistantMessageAppended: event => assistantAppended.push(event),
    onUserTurnReady: event => userTurns.push(event),
    onAssistantTurnReady: event => assistantTurns.push(event),
    onStateChange: state => stateChanges.push(state),
    onMessageSendStarted: event => telemetry.messageSendStarted.push(event),
    onLlmRequestStarted: event => telemetry.llmRequestStarted.push(event),
    onLlmFirstToken: event => telemetry.llmFirstToken.push(event),
    onAssistantResponseRendered: event => telemetry.assistantResponseRendered.push(event),
    onMessageRound: event => telemetry.messageRound.push(event),
  })

  return {
    assistantAppended,
    assistantTurns,
    contextSnapshot,
    foregroundPatches,
    foregroundResets,
    generation: {
      set: (next: number) => {
        generation = next
      },
    },
    lifecycleRecords,
    now: {
      set: (next: number) => {
        nowValue = next
      },
    },
    monotonicNow: {
      set: (next: number[]) => {
        monotonicNowValues = [...next]
      },
    },
    promptProjections,
    runtime,
    sessionMessages,
    stateChanges,
    stream,
    systemPromptSupplement: {
      set: (next: string | undefined) => {
        systemPromptSupplement = next
      },
    },
    telemetry,
    userAppended,
    userTurns,
  }
}

/**
 * @example
 * const runtime = createChatOrchestratorRuntime(deps)
 * await runtime.ingest('hello', { model, chatProvider })
 */
describe('createChatOrchestratorRuntime', () => {
  /**
   * @example
   * Hook order and prompt composition stay compatible with the stage-ui facade.
   */
  it('keeps hook order and appends context prompt to the latest user message', async () => {
    const harness = createHarness()
    harness.contextSnapshot['system:weather'] = [
      {
        id: 'weather',
        contextId: 'system:weather',
        strategy: ContextUpdateStrategy.ReplaceSelf,
        text: 'sunny',
        createdAt: 1,
      },
    ]
    const hookOrder: string[] = []
    let composedMessages: Message[] = []

    harness.runtime.hooks.onBeforeMessageComposed(async () => {
      hookOrder.push('before-compose')
    })
    harness.runtime.hooks.onAfterMessageComposed(async () => {
      hookOrder.push('after-compose')
    })
    harness.runtime.hooks.onBeforeSend(async () => {
      hookOrder.push('before-send')
    })
    harness.runtime.hooks.onTokenLiteral(async () => {
      hookOrder.push('token-literal')
    })
    harness.runtime.hooks.onStreamEnd(async () => {
      hookOrder.push('stream-end')
    })
    harness.runtime.hooks.onAssistantResponseEnd(async () => {
      hookOrder.push('assistant-end')
    })
    harness.runtime.hooks.onAfterSend(async () => {
      hookOrder.push('after-send')
    })
    harness.runtime.hooks.onAssistantMessage(async () => {
      hookOrder.push('assistant-message')
    })
    harness.runtime.hooks.onChatTurnComplete(async () => {
      hookOrder.push('turn-complete')
    })
    harness.stream.mockImplementationOnce(async (_model, _chatProvider, messages, options) => {
      composedMessages = messages
      await options?.onStreamEvent?.({ type: 'text-delta', text: 'hello' })
      await options?.onStreamEvent?.({ type: 'finish', finishReason: 'stop' })
    })

    await harness.runtime.ingest('hello from user', {
      model: 'gpt-test',
      chatProvider: provider,
    })

    expect(hookOrder).toEqual([
      'before-compose',
      'after-compose',
      'before-send',
      'token-literal',
      'stream-end',
      'assistant-end',
      'after-send',
      'assistant-message',
      'turn-complete',
    ])
    expect(composedMessages).toHaveLength(2)
    expect(composedMessages[0]).toMatchObject({ role: 'system', content: 'system prompt' })
    expect(composedMessages[1]).toMatchObject({ role: 'user' })
    expect(composedMessages[1]?.content).toEqual([
      {
        type: 'text',
        text: '[2026-04-25 18:47] hello from user',
      },
      {
        type: 'text',
        text: '\n[Context]\n- system:weather: sunny',
      },
    ])
    expect(harness.lifecycleRecords).toEqual(expect.arrayContaining([
      expect.objectContaining({ phase: 'before-compose' }),
      expect.objectContaining({ phase: 'prompt-context-built' }),
      expect.objectContaining({ phase: 'after-compose' }),
    ]))
    expect(harness.promptProjections).toHaveLength(1)
  })

  /**
   * @example
   * deps.getSystemPromptSupplement() returns tool guidance.
   * The runtime appends it to the existing provider system message.
   */
  it('appends system prompt supplement to the provider system message', async () => {
    const harness = createHarness()
    let composedMessages: Message[] = []
    harness.systemPromptSupplement.set('Plugin toolset guidance.')
    harness.stream.mockImplementationOnce(async (_model, _chatProvider, messages, options) => {
      composedMessages = messages
      await options?.onStreamEvent?.({ type: 'text-delta', text: 'hello' })
      await options?.onStreamEvent?.({ type: 'finish', finishReason: 'stop' })
    })

    await harness.runtime.ingest('hello from user', {
      model: 'gpt-test',
      chatProvider: provider,
    })

    expect(composedMessages[0]).toMatchObject({
      role: 'system',
      content: 'system prompt\n\nPlugin toolset guidance.',
    })
  })

  /**
   * @example
   * A session has only user history.
   * The runtime creates a provider system message for supplemental guidance.
   */
  it('creates a system message when only a system prompt supplement is available', async () => {
    const harness = createHarness()
    let composedMessages: Message[] = []
    harness.sessionMessages['session-1'] = []
    harness.systemPromptSupplement.set('Plugin toolset guidance.')
    harness.stream.mockImplementationOnce(async (_model, _chatProvider, messages, options) => {
      composedMessages = messages
      await options?.onStreamEvent?.({ type: 'text-delta', text: 'hello' })
      await options?.onStreamEvent?.({ type: 'finish', finishReason: 'stop' })
    })

    await harness.runtime.ingest('hello from user', {
      model: 'gpt-test',
      chatProvider: provider,
    })

    expect(composedMessages[0]).toMatchObject({
      role: 'system',
      content: 'Plugin toolset guidance.',
    })
    expect(composedMessages[1]).toMatchObject({ role: 'user' })
  })

  /**
   * @example
   * Included prompt contributions are projected around the character prompt while excluded diagnostics stay observable.
   */
  it('composes structured prompt contributions and keeps exclusions observable', async () => {
    const harness = createHarness()
    let composedMessages: Message[] = []
    const promptContributions: PromptContribution[] = [
      {
        content: 'Lore before character.',
        id: 'lore-before',
        label: 'Ancient archive',
        placement: 'system-before',
        source: 'character-lorebook',
        status: 'included',
      },
      {
        content: 'Lore after character.',
        estimatedTokens: 8,
        id: 'lore-after',
        label: 'Current location',
        placement: 'system-after',
        source: 'character-lorebook',
        status: 'included',
      },
      {
        content: 'Evicted lore.',
        id: 'lore-evicted',
        label: 'Low priority detail',
        metadata: { reason: 'budget-evicted' },
        placement: 'system-after',
        source: 'character-lorebook',
        status: 'excluded',
      },
    ]
    harness.runtime.hooks.onBeforeMessageComposed(async (_message, context) => {
      context.promptContributions.push(...promptContributions)
    })
    harness.stream.mockImplementationOnce(async (_model, _chatProvider, messages, options) => {
      composedMessages = messages
      await options?.onStreamEvent?.({ type: 'text-delta', text: 'hello' })
      await options?.onStreamEvent?.({ type: 'finish', finishReason: 'stop' })
    })

    await harness.runtime.ingest('hello from user', {
      model: 'gpt-test',
      chatProvider: provider,
    })

    expect(composedMessages[0]).toMatchObject({
      role: 'system',
      content: 'Lore before character.\n\nsystem prompt\n\nLore after character.',
    })
    expect(harness.promptProjections[0]?.contributions).toHaveLength(3)
    expect(harness.promptProjections[0]?.contributions[2]).toMatchObject({
      id: 'lore-evicted',
      status: 'excluded',
    })
  })

  /**
   * @example
   * Concurrent queued Discord sends keep their prompt contributions on the owning turn.
   */
  it('keeps prompt contributions isolated across concurrently queued sessions (Discord audit D-005)', async () => {
    const harness = createHarness()

    // ROOT CAUSE:
    //
    // Discord turn metadata currently travels through shared mutable prompt/context
    // state. Two inputs can therefore overwrite the same contribution before the
    // owning provider request composes its prompt.
    //
    // Before the fix, ChatStreamEventContext has no turn-owned contribution list.
    // After the fix, every performSend allocation owns one independent list.
    harness.runtime.hooks.onBeforeMessageComposed(async (_message, context) => {
      // @example
      expect(context).toHaveProperty('promptContributions')
      if (!('promptContributions' in context) || !Array.isArray(context.promptContributions))
        throw new Error('Expected a turn-local prompt contribution list.')

      context.promptContributions.push({
        content: `Discord sentinel for ${context.sessionId}`,
        id: 'discord-turn-context',
        label: 'Discord turn context',
        metadata: {
          role: 'system',
          scope: {
            sessionId: context.sessionId,
          },
        },
        placement: 'system-after',
        source: 'discord',
        status: 'included',
      })
    })

    await Promise.all([
      harness.runtime.ingest('Discord turn A', {
        model: 'gpt-test',
        chatProvider: provider,
      }, 'discord-session-a'),
      harness.runtime.ingest('Discord turn B', {
        model: 'gpt-test',
        chatProvider: provider,
      }, 'discord-session-b'),
    ])

    const projectionA = harness.promptProjections.find(projection => projection.sessionId === 'discord-session-a')
    const projectionB = harness.promptProjections.find(projection => projection.sessionId === 'discord-session-b')

    // @example
    expect(projectionA?.contributions).toEqual([
      expect.objectContaining({
        content: 'Discord sentinel for discord-session-a',
        metadata: expect.objectContaining({
          scope: { sessionId: 'discord-session-a' },
        }),
      }),
    ])
    // @example
    expect(projectionB?.contributions).toEqual([
      expect.objectContaining({
        content: 'Discord sentinel for discord-session-b',
        metadata: expect.objectContaining({
          scope: { sessionId: 'discord-session-b' },
        }),
      }),
    ])
  })

  /**
   * @example
   * Session B starts while session A1 is deferred, but session A2 waits for A1.
   */
  it('runs exact sessions concurrently while preserving per-session FIFO (Discord audit D-011)', async () => {
    const harness = createHarness()
    const started: string[] = []
    let releaseSessionA1: (() => void) | undefined

    // ROOT CAUSE:
    //
    // Every chat send currently enters one process-wide createQueue instance.
    // A deferred provider call for session A therefore prevents session B from
    // reaching the provider, even though B has independent history and state.
    //
    // Before the fix, only A1 starts until its provider promise settles.
    // After the fix, B can complete concurrently while A2 remains behind A1.
    harness.stream.mockImplementation(async (_model, _chatProvider, messages, options) => {
      const content = messages.at(-1)?.content
      const text = typeof content === 'string'
        ? content
        : content?.map(part => 'text' in part && typeof part.text === 'string' ? part.text : '').join('') ?? ''
      const turn = text.includes('session-a-1')
        ? 'session-a-1'
        : text.includes('session-a-2')
          ? 'session-a-2'
          : 'session-b-1'
      started.push(turn)

      if (turn === 'session-a-1') {
        await new Promise<void>((resolve) => {
          releaseSessionA1 = resolve
        })
      }

      await options?.onStreamEvent?.({ type: 'text-delta', text: `${turn}-reply` })
      await options?.onStreamEvent?.({ type: 'finish', finishReason: 'stop' })
    })

    const sessionA1 = harness.runtime.ingest('session-a-1', {
      model: 'gpt-test',
      chatProvider: provider,
    }, 'discord-session-a')
    const sessionA2 = harness.runtime.ingest('session-a-2', {
      model: 'gpt-test',
      chatProvider: provider,
    }, 'discord-session-a')
    const sessionB1 = harness.runtime.ingest('session-b-1', {
      model: 'gpt-test',
      chatProvider: provider,
    }, 'discord-session-b')

    try {
      await vi.waitFor(() => {
        expect(started).toContain('session-b-1')
      })
      expect(started).not.toContain('session-a-2')
    }
    finally {
      releaseSessionA1?.()
      await Promise.allSettled([sessionA1, sessionA2, sessionB1])
    }

    expect(started.indexOf('session-a-1')).toBeLessThan(started.indexOf('session-a-2'))
  })

  /**
   * @example
   * A full exact-session or process queue rejects only the new turn.
   */
  it('fails closed at per-session and global queue limits (Discord audit D-011)', async () => {
    const harness = createHarness({
      queuePolicy: {
        maxConcurrentSessions: 2,
        maxQueuedPerSession: 1,
        maxQueuedTotal: 2,
      },
    })
    const releases = new Map<string, () => void>()

    // ROOT CAUSE:
    //
    // The previous process-wide createQueue accepted every input without a
    // per-session or global pending limit. An attacker could therefore retain
    // unbounded Discord content and provider work behind deferred requests.
    //
    // The bounded scheduler rejects only the overflowing turn and preserves all
    // work that was already running or admitted.
    harness.stream.mockImplementation(async (_model, _chatProvider, messages, streamOptions) => {
      const content = messages.at(-1)?.content
      const text = typeof content === 'string'
        ? content
        : content?.map(part => 'text' in part && typeof part.text === 'string' ? part.text : '').join('') ?? ''
      if (text.includes('hold')) {
        await new Promise<void>((resolve) => {
          releases.set(text.includes('session-a') ? 'a' : 'b', resolve)
        })
      }
      await streamOptions?.onStreamEvent?.({ type: 'text-delta', text: 'accepted-reply' })
      await streamOptions?.onStreamEvent?.({ type: 'finish', finishReason: 'stop' })
    })

    const sessionA1 = harness.runtime.ingest('hold-session-a', { model: 'gpt-test', chatProvider: provider }, 'session-a')
    const sessionA2 = harness.runtime.ingest('queued-session-a', { model: 'gpt-test', chatProvider: provider }, 'session-a')
    const sessionB1 = harness.runtime.ingest('hold-session-b', { model: 'gpt-test', chatProvider: provider }, 'session-b')
    const sessionB2 = harness.runtime.ingest('queued-session-b', { model: 'gpt-test', chatProvider: provider }, 'session-b')

    await expect(harness.runtime.ingest('overflow-session-a', {
      model: 'gpt-test',
      chatProvider: provider,
    }, 'session-a')).rejects.toMatchObject({
      code: 'CHAT_QUEUE_CAPACITY_EXCEEDED',
      scope: 'session',
    })
    await expect(harness.runtime.ingest('overflow-global', {
      model: 'gpt-test',
      chatProvider: provider,
    }, 'session-c')).rejects.toMatchObject({
      code: 'CHAT_QUEUE_CAPACITY_EXCEEDED',
      scope: 'global',
    })

    releases.get('a')?.()
    releases.get('b')?.()
    await Promise.all([sessionA1, sessionA2, sessionB1, sessionB2])
    expect(harness.assistantAppended).toHaveLength(4)
  })

  /**
   * @example
   * A timed-out provider releases its slot and cannot emit late assistant state.
   */
  it('aborts a timed-out turn and gates every late provider side effect (Discord audit D-011)', async () => {
    vi.useFakeTimers()
    try {
      const harness = createHarness({
        queuePolicy: {
          maxConcurrentSessions: 1,
        },
      })
      harness.now.set(1000)
      let releaseLateProvider: (() => void) | undefined
      let lateProviderOptions: Parameters<typeof harness.stream>[3]
      const emittedAssistantTurns: string[] = []
      const cancelledTurns: Array<{ reason: string, turnId: string }> = []
      harness.runtime.hooks.onAssistantMessage(async (_message, messageText) => {
        emittedAssistantTurns.push(messageText)
      })
      harness.runtime.hooks.onTurnCancelled(async (context, reason) => {
        cancelledTurns.push({ reason, turnId: context.turnId })
      })
      harness.stream
        .mockImplementationOnce(async (_model, _chatProvider, _messages, streamOptions) => {
          lateProviderOptions = streamOptions
          await new Promise<void>((resolve) => {
            releaseLateProvider = resolve
          })
          await streamOptions?.onStreamEvent?.({ type: 'text-delta', text: 'LATE_A1_SENTINEL' })
          await streamOptions?.onStreamEvent?.({ type: 'finish', finishReason: 'stop' })
        })
        .mockImplementationOnce(async (_model, _chatProvider, _messages, streamOptions) => {
          await streamOptions?.onStreamEvent?.({ type: 'text-delta', text: 'A2_VISIBLE' })
          await streamOptions?.onStreamEvent?.({ type: 'finish', finishReason: 'stop' })
        })

      // ROOT CAUSE:
      //
      // The old scheduler had neither per-turn deadlines nor an AbortSignal at
      // the provider boundary. A timeout outside core could report failure while
      // the provider later appended history and emitted Discord output hooks.
      //
      // The owning turn now races its provider against an exact deadline and all
      // late callbacks consult that turn's abort/generation gate.
      const sessionA1 = harness.runtime.ingest('session-a-1', {
        model: 'gpt-test',
        chatProvider: provider,
        turnId: 'turn-a-1',
        deadlineAt: 1050,
      }, 'session-a')
      const sessionA1Outcome = sessionA1.catch(error => error)
      const sessionA2 = harness.runtime.ingest('session-a-2', {
        model: 'gpt-test',
        chatProvider: provider,
        turnId: 'turn-a-2',
        deadlineAt: 1200,
      }, 'session-a')

      await vi.advanceTimersByTimeAsync(50)
      await expect(sessionA1Outcome).resolves.toMatchObject({
        code: 'CHAT_TURN_CANCELLED',
        reason: 'deadline',
      })
      await sessionA2
      expect(lateProviderOptions?.abortSignal?.aborted).toBe(true)

      releaseLateProvider?.()
      await Promise.resolve()
      await Promise.resolve()

      const assistantContents = harness.sessionMessages['session-a']
        ?.filter(message => message.role === 'assistant')
        .map(message => message.content)
      expect(assistantContents).toEqual(['A2_VISIBLE'])
      expect(harness.assistantAppended).toHaveLength(1)
      expect(emittedAssistantTurns).toEqual(['A2_VISIBLE'])
      expect(cancelledTurns).toEqual([{
        reason: 'deadline',
        turnId: 'turn-a-1',
      }])
    }
    finally {
      vi.useRealTimers()
    }
  })

  /**
   * @example
   * A timed-out lifecycle hook cannot retain the only global scheduler slot.
   */
  it('releases bounded concurrency when an async hook outlives its Discord audit D-011 turn', async () => {
    vi.useFakeTimers()
    let releaseLateHook: (() => void) | undefined
    try {
      const harness = createHarness({ queuePolicy: { maxConcurrentSessions: 1 } })
      harness.now.set(2_000)
      const providerTurns: string[] = []
      harness.runtime.hooks.onBeforeMessageComposed(async (_message, context) => {
        if (context.turnId !== 'hook-timeout-a')
          return
        await new Promise<void>((resolve) => {
          releaseLateHook = resolve
        })
      })
      harness.stream.mockImplementation(async (_model, _chatProvider, _messages, options) => {
        providerTurns.push(options?.turnId ?? 'missing-turn')
        await options?.onStreamEvent?.({ type: 'text-delta', text: 'VISIBLE_RESPONSE_123456789' })
        await options?.onStreamEvent?.({ type: 'finish', finishReason: 'stop' })
      })

      // ROOT CAUSE:
      //
      // Provider execution was raced against AbortSignal, but lifecycle hooks
      // were awaited directly. A hook that outlived its deadline kept the exact
      // session and global running slot occupied even after cancelTurn aborted it.
      //
      // Every async turn boundary must race the owning signal and recheck the
      // absolute deadline before any later history, hook, or queue side effect.
      const turnA = harness.runtime.ingest('hold-hook-a', {
        model: 'gpt-test',
        chatProvider: provider,
        turnId: 'hook-timeout-a',
        deadlineAt: 2_050,
      }, 'session-a').catch(error => error)
      const turnB = harness.runtime.ingest('run-b', {
        model: 'gpt-test',
        chatProvider: provider,
        turnId: 'hook-visible-b',
        deadlineAt: 2_500,
      }, 'session-b')

      await vi.advanceTimersByTimeAsync(50)

      // @example
      await expect(turnA).resolves.toMatchObject({ reason: 'deadline' })
      // @example
      await expect(turnB).resolves.toBeUndefined()
      // @example
      expect(providerTurns).toEqual(['hook-visible-b'])
    }
    finally {
      releaseLateHook?.()
      vi.useRealTimers()
    }
  })

  /**
   * @example
   * Cancelling a turn while its first hook is deferred prevents later hooks from starting.
   */
  it('stops later hook subscribers after cancelling their Discord audit D-011 turn', async () => {
    const harness = createHarness()
    let releaseFirstHook: (() => void) | undefined
    let markFirstHookStarted: (() => void) | undefined
    const firstHookStarted = new Promise<void>((resolve) => {
      markFirstHookStarted = resolve
    })
    const laterHook = vi.fn(async () => {})

    // ROOT CAUSE:
    //
    // The runtime races one hook-emission promise against the turn AbortSignal,
    // but the hook registry previously kept iterating its subscriber array after
    // that abandoned promise's current hook eventually resolved.
    //
    // Before the fix, cancelling the turn released its scheduler slot while the
    // registry later invoked the next subscriber. After the fix, the owning
    // registry checks the exact-turn activity predicate between subscribers.
    harness.runtime.hooks.onBeforeMessageComposed(async () => {
      markFirstHookStarted?.()
      await new Promise<void>((resolve) => {
        releaseFirstHook = resolve
      })
    })
    harness.runtime.hooks.onBeforeMessageComposed(laterHook)

    const turnOutcome = harness.runtime.ingest('deferred hook turn', {
      model: 'gpt-test',
      chatProvider: provider,
      turnId: 'cancelled-hook-chain',
    }, 'discord-hook-session').catch(error => error)

    await firstHookStarted
    // @example
    expect(harness.runtime.cancelTurn('cancelled-hook-chain')).toBe(true)
    // @example
    await expect(turnOutcome).resolves.toMatchObject({
      code: 'CHAT_TURN_CANCELLED',
      reason: 'cancelled',
    })

    releaseFirstHook?.()
    await Promise.resolve()
    await Promise.resolve()

    // @example
    expect(laterHook).not.toHaveBeenCalled()
    // @example
    expect(harness.stream).not.toHaveBeenCalled()
  })

  /**
   * @example
   * A hanging or failing cancellation subscriber cannot block later exact-turn cleanup.
   */
  it('isolates hanging and failing cancellation hooks while releasing the scheduler for Discord audit D-011', async () => {
    const harness = createHarness({ queuePolicy: { maxConcurrentSessions: 1 } })
    const startedTurns: string[] = []
    const teardownTurn = vi.fn()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    let releaseCancellationHook: (() => void) | undefined
    let releaseProviderA: (() => void) | undefined

    // ROOT CAUSE:
    //
    // Cancellation subscribers were awaited serially. One cleanup that never
    // resolved retained the scheduler slot forever, while one rejection skipped
    // every later subscriber, including Stage's exact-turn TTS teardown.
    //
    // Cancellation dispatch must start every subscriber independently, observe
    // failures without leaking content, and never make queue release depend on a
    // third-party cleanup promise settling.
    harness.runtime.hooks.onTurnCancelled(async () => {
      await new Promise<void>((resolve) => {
        releaseCancellationHook = resolve
      })
    })
    harness.runtime.hooks.onTurnCancelled(async () => {
      throw new Error('synthetic cancellation cleanup failure')
    })
    harness.runtime.hooks.onTurnCancelled(async (context) => {
      teardownTurn(context.turnId)
    })
    harness.stream.mockImplementation(async (_model, _chatProvider, _messages, options) => {
      const turnId = options?.turnId ?? 'missing-turn'
      startedTurns.push(turnId)
      if (turnId === 'cancellation-hook-a') {
        await new Promise<void>((resolve) => {
          releaseProviderA = resolve
        })
        return
      }

      await options?.onStreamEvent?.({ type: 'text-delta', text: 'SESSION_B_VISIBLE_RESPONSE_123456789' })
      await options?.onStreamEvent?.({ type: 'finish', finishReason: 'stop' })
    })

    const turnA = harness.runtime.ingest('turn-a', {
      model: 'gpt-test',
      chatProvider: provider,
      turnId: 'cancellation-hook-a',
    }, 'session-a').catch(error => error)
    const turnB = harness.runtime.ingest('turn-b', {
      model: 'gpt-test',
      chatProvider: provider,
      turnId: 'cancellation-hook-b',
    }, 'session-b')

    try {
      await vi.waitFor(() => {
        expect(startedTurns).toEqual(['cancellation-hook-a'])
      })
      expect(harness.runtime.cancelTurn('cancellation-hook-a')).toBe(true)

      await vi.waitFor(() => {
        expect(teardownTurn).toHaveBeenCalledWith('cancellation-hook-a')
      })
      await expect(turnA).resolves.toMatchObject({
        code: 'CHAT_TURN_CANCELLED',
        reason: 'cancelled',
      })
      await expect(turnB).resolves.toBeUndefined()
      expect(startedTurns).toEqual(['cancellation-hook-a', 'cancellation-hook-b'])
      expect(consoleError).toHaveBeenCalledWith(
        '[core-agent] Chat turn cancellation hook failed',
        expect.objectContaining({
          hookIndex: 1,
          reason: 'cancelled',
          turnId: 'cancellation-hook-a',
        }),
      )
    }
    finally {
      releaseCancellationHook?.()
      releaseProviderA?.()
      await Promise.allSettled([turnA, turnB])
      consoleError.mockRestore()
    }
  })

  /**
   * @example
   * A deadline inside a post-provider hook leaves no committed assistant state.
   */
  it('commits no assistant history when a post-provider hook exceeds the Discord audit D-011 deadline', async () => {
    vi.useFakeTimers()
    let releasePostProviderHook: (() => void) | undefined
    try {
      const harness = createHarness()
      harness.now.set(1_000)
      let markPostProviderHookStarted: (() => void) | undefined
      const postProviderHookStarted = new Promise<void>((resolve) => {
        markPostProviderHookStarted = resolve
      })
      const laterPostProviderHook = vi.fn(async () => {})
      harness.stream.mockImplementationOnce(async (_model, _chatProvider, _messages, streamOptions) => {
        await streamOptions?.onStreamEvent?.({
          type: 'text-delta',
          text: 'POST_PROVIDER_ASSISTANT_SENTINEL_123456789',
        })
        await streamOptions?.onStreamEvent?.({ type: 'finish', finishReason: 'stop' })
      })
      harness.runtime.hooks.onStreamEnd(async () => {
        markPostProviderHookStarted?.()
        await new Promise<void>((resolve) => {
          releasePostProviderHook = resolve
        })
      })
      harness.runtime.hooks.onStreamEnd(laterPostProviderHook)

      // ROOT CAUSE:
      //
      // The runtime previously appended the assistant message and notified the
      // assistant persistence/memory boundary immediately after provider parsing,
      // before post-provider hooks had completed under the turn deadline.
      //
      // A deferred post hook could therefore time out the visible turn while its
      // assistant reply remained hidden in history and memory. The assistant
      // commit now occurs only after every post hook and final activity gate.
      const turnOutcome = harness.runtime.ingest('post-provider timeout turn', {
        model: 'gpt-test',
        chatProvider: provider,
        turnId: 'post-provider-timeout',
        deadlineAt: 1_050,
      }, 'discord-post-hook-session').catch(error => error)

      await postProviderHookStarted
      harness.now.set(1_050)
      await vi.advanceTimersByTimeAsync(50)

      // @example
      await expect(turnOutcome).resolves.toMatchObject({
        code: 'CHAT_TURN_CANCELLED',
        reason: 'deadline',
      })
      const assistantHistory = harness.sessionMessages['discord-post-hook-session']
        ?.filter(message => message.role === 'assistant')
      // @example
      expect(assistantHistory).toEqual([])
      // @example
      expect(harness.assistantAppended).toEqual([])
      // @example
      expect(harness.assistantTurns).toEqual([])

      releasePostProviderHook?.()
      await Promise.resolve()
      await Promise.resolve()

      // @example
      expect(laterPostProviderHook).not.toHaveBeenCalled()
    }
    finally {
      releasePostProviderHook?.()
      vi.useRealTimers()
    }
  })

  /**
   * @example
   * A1 timing out never clears or replaces A2's independent deadline.
   */
  it('keeps same-session turn timers independently owned (Discord audit D-011)', async () => {
    vi.useFakeTimers()
    try {
      const harness = createHarness({ queuePolicy: { maxConcurrentSessions: 1 } })
      harness.now.set(5000)
      const releases: Array<() => void> = []
      harness.stream.mockImplementation(async () => {
        await new Promise<void>((resolve) => {
          releases.push(resolve)
        })
      })

      // ROOT CAUSE:
      //
      // A session-keyed timeout lets a newer turn overwrite the prior timer, and
      // prior cleanup can then clear the newer turn's timer. Neither deadline is
      // actually owned by the exact request it is meant to cancel.
      //
      // Each queued turn now owns one timer and AbortController keyed by turnId.
      const sessionA1 = harness.runtime.ingest('session-a-1', {
        model: 'gpt-test',
        chatProvider: provider,
        turnId: 'independent-a-1',
        deadlineAt: 5050,
      }, 'session-a').catch(error => error)
      const sessionA2 = harness.runtime.ingest('session-a-2', {
        model: 'gpt-test',
        chatProvider: provider,
        turnId: 'independent-a-2',
        deadlineAt: 5100,
      }, 'session-a').catch(error => error)

      await vi.advanceTimersByTimeAsync(50)
      await expect(sessionA1).resolves.toMatchObject({ reason: 'deadline' })
      await vi.advanceTimersByTimeAsync(50)
      await expect(sessionA2).resolves.toMatchObject({ reason: 'deadline' })

      for (const release of releases)
        release()
    }
    finally {
      vi.useRealTimers()
    }
  })

  /**
   * @example
   * Cancelling Discord turn A tears down only A's speech intent while B keeps streaming.
   */
  it('correlates token and cancellation hooks to the owning TTS turn (Discord audit D-011)', async () => {
    const harness = createHarness()
    const releases = new Map<string, () => void>()
    const ttsTurns = new Map<string, { cancelled: boolean, literals: string[], sessionId: string }>()
    const cancellationEvents: Array<{ reason: string, sessionId: string, turnId: string }> = []

    // ROOT CAUSE:
    //
    // Token hooks carry a turn context, but cancellation previously stopped only
    // the provider promise. Stage.vue therefore had no exact-turn cancellation
    // signal and routed every concurrent token through one global TTS session.
    // Cancelling A could leave A audio alive or globally stop B's unrelated audio.
    //
    // The hook registry now emits one cancellation for the owning active turn.
    // Stage can keep a turnId-keyed TTS map and cancel only that turn's intent.
    harness.runtime.hooks.onBeforeMessageComposed(async (_message, context) => {
      ttsTurns.set(context.turnId, {
        cancelled: false,
        literals: [],
        sessionId: context.sessionId,
      })
    })
    harness.runtime.hooks.onTokenLiteral(async (literal, context) => {
      ttsTurns.get(context.turnId)?.literals.push(literal)
    })

    harness.runtime.hooks.onTurnCancelled(async (context, reason) => {
      const turn = ttsTurns.get(context.turnId)
      if (turn)
        turn.cancelled = true
      cancellationEvents.push({
        reason,
        sessionId: context.sessionId,
        turnId: context.turnId,
      })
    })

    harness.stream.mockImplementation(async (_model, _chatProvider, _messages, streamOptions) => {
      const turnId = streamOptions?.turnId
      if (!turnId)
        throw new Error('Expected a correlated turnId at the provider boundary.')

      await streamOptions.onStreamEvent?.({
        type: 'text-delta',
        text: turnId === 'tts-turn-a'
          ? 'A_ONLY_LITERAL_SENTINEL_123456789'
          : 'B_ONLY_LITERAL_SENTINEL_123456789',
      })
      await new Promise<void>((resolve) => {
        releases.set(turnId, resolve)
      })
      await streamOptions.onStreamEvent?.({
        type: 'text-delta',
        text: `LATE_${turnId}`,
      })
      await streamOptions.onStreamEvent?.({ type: 'finish', finishReason: 'stop' })
    })

    const turnA = harness.runtime.ingest('turn-a', {
      model: 'gpt-test',
      chatProvider: provider,
      turnId: 'tts-turn-a',
    }, 'discord-session-a')
    const turnAOutcome = turnA.catch(error => error)
    const turnB = harness.runtime.ingest('turn-b', {
      model: 'gpt-test',
      chatProvider: provider,
      turnId: 'tts-turn-b',
    }, 'discord-session-b')

    await vi.waitFor(() => {
      expect(releases.size).toBe(2)
    })
    expect(harness.runtime.cancelTurn('tts-turn-a')).toBe(true)
    await expect(turnAOutcome).resolves.toMatchObject({
      code: 'CHAT_TURN_CANCELLED',
      reason: 'cancelled',
    })

    expect(ttsTurns.get('tts-turn-a')).toMatchObject({
      cancelled: true,
      sessionId: 'discord-session-a',
    })
    expect(ttsTurns.get('tts-turn-b')).toMatchObject({
      cancelled: false,
      sessionId: 'discord-session-b',
    })

    releases.get('tts-turn-b')?.()
    await turnB
    releases.get('tts-turn-a')?.()
    await Promise.resolve()
    await Promise.resolve()

    expect(ttsTurns.get('tts-turn-a')?.literals.join('')).toContain('A_ONLY_LITERAL_SENTINEL')
    expect(ttsTurns.get('tts-turn-a')?.literals.join('')).not.toContain('B_ONLY_LITERAL_SENTINEL')
    expect(ttsTurns.get('tts-turn-a')?.literals.join('')).not.toContain('LATE_tts-turn-a')
    expect(ttsTurns.get('tts-turn-b')?.literals.join('')).toContain('B_ONLY_LITERAL_SENTINEL_123456789')
    expect(cancellationEvents).toEqual([{
      reason: 'cancelled',
      sessionId: 'discord-session-a',
      turnId: 'tts-turn-a',
    }])
  })

  /**
   * @example
   * A failed Discord provider request cannot leak its temporary contribution into a later local turn.
   */
  it('releases turn-local contributions after provider rejection (Discord audit D-005)', async () => {
    const harness = createHarness()

    // ROOT CAUSE:
    //
    // A failed provider request can leave Discord prompt metadata in shared
    // contribution state. The next unrelated turn then inherits a contribution
    // whose owning turn never completed.
    //
    // The contribution must instead live on the performSend context so failure
    // disposal releases it with that exact turn.
    harness.runtime.hooks.onBeforeMessageComposed(async (message, context) => {
      if (message !== 'Discord turn that fails')
        return

      // @example
      expect(context).toHaveProperty('promptContributions')
      if (!('promptContributions' in context) || !Array.isArray(context.promptContributions))
        throw new Error('Expected a turn-local prompt contribution list.')

      context.promptContributions.push({
        content: 'discord-rejection-sentinel',
        id: 'discord-turn-context',
        label: 'Discord turn context',
        placement: 'system-after',
        source: 'discord',
        status: 'included',
      })
    })
    harness.stream.mockRejectedValueOnce(new Error('synthetic provider failure'))

    // @example
    await expect(harness.runtime.ingest('Discord turn that fails', {
      model: 'gpt-test',
      chatProvider: provider,
    }, 'discord-session-failed')).rejects.toThrow('synthetic provider failure')

    await harness.runtime.ingest('Local turn after failure', {
      model: 'gpt-test',
      chatProvider: provider,
    }, 'local-session')

    const localProjection = harness.promptProjections.find(projection => projection.sessionId === 'local-session')

    // @example
    expect(localProjection?.contributions).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ content: 'discord-rejection-sentinel' }),
    ]))
  })

  /**
   * @example
   * A visible historical message marked excludedFromPrompt remains in the session but not in the provider request.
   */
  it('omits locally excluded history and local response metadata from provider messages', async () => {
    const harness = createHarness()
    let composedMessages: Message[] = []
    harness.sessionMessages['session-1'] = [
      harness.sessionMessages['session-1']![0]!,
      {
        content: 'private draft',
        excludedFromPrompt: true,
        id: 'excluded-user',
        role: 'user',
      },
      {
        activeResponseAlternative: 0,
        content: 'selected answer',
        id: 'selected-assistant',
        responseAlternatives: [
          {
            content: 'selected answer',
            id: 'candidate-1',
            slices: [{ type: 'text', text: 'selected answer' }],
            tool_results: [],
          },
        ],
        role: 'assistant',
        slices: [{ type: 'text', text: 'selected answer' }],
        tool_results: [],
      },
    ]
    harness.stream.mockImplementationOnce(async (_model, _chatProvider, messages, options) => {
      composedMessages = messages
      await options?.onStreamEvent?.({ type: 'text-delta', text: 'next reply' })
      await options?.onStreamEvent?.({ type: 'finish', finishReason: 'stop' })
    })

    await harness.runtime.ingest('next turn', {
      model: 'gpt-test',
      chatProvider: provider,
    })

    expect(composedMessages.some(message => message.content === 'private draft')).toBe(false)
    expect(composedMessages).toContainEqual({
      content: 'selected answer',
      role: 'assistant',
    })
    expect(composedMessages.some(message => 'responseAlternatives' in message)).toBe(false)
  })

  /**
   * @example
   * Runtime telemetry callbacks expose client-visible latency milestones.
   */
  it('emits telemetry milestones for a successful voice-backed message round', async () => {
    const harness = createHarness()
    harness.monotonicNow.set([100, 150, 250, 400, 460])

    await harness.runtime.ingest('hello from voice', {
      model: 'gpt-test',
      chatProvider: provider,
      input: {
        type: 'input:text',
        data: {
          text: 'hello from voice',
        },
      },
    })

    expect(harness.telemetry.messageSendStarted).toEqual([{
      source: 'voice',
      model: 'gpt-test',
    }])
    expect(harness.telemetry.llmRequestStarted).toEqual([{
      model: 'gpt-test',
      provider: 'mock-provider',
      hasVoice: true,
    }])
    expect(harness.telemetry.llmFirstToken).toEqual([{
      model: 'gpt-test',
      ttfbMs: 100,
    }])
    expect(harness.telemetry.assistantResponseRendered).toEqual([{
      model: 'gpt-test',
      latencyMs: 250,
    }])
    expect(harness.telemetry.messageRound).toEqual([{
      durationMs: 360,
      hasVoice: true,
      model: 'gpt-test',
    }])
  })

  /**
   * @example
   * Cancelling a queued send rejects only pending work that has not started.
   */
  it('rejects cancelled queued sends before they start', async () => {
    const harness = createHarness()
    let releaseFirstSend: (() => void) | undefined
    harness.stream.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        releaseFirstSend = resolve
      })
    })

    const firstSend = harness.runtime.ingest('hold queue', {
      model: 'gpt-test',
      chatProvider: provider,
    })
    const secondSend = harness.runtime.ingest('cancel me', {
      model: 'gpt-test',
      chatProvider: provider,
    })

    await vi.waitFor(() => {
      expect(harness.stream).toHaveBeenCalledTimes(1)
    })
    await vi.waitFor(() => {
      expect(harness.runtime.getPendingQueuedSendCount()).toBe(1)
    })
    harness.runtime.cancelPendingSends('session-1')
    releaseFirstSend?.()

    await expect(secondSend).rejects.toThrow('Chat session was reset before send could start')
    await firstSend
  })

  /**
   * @example
   * A queued send rejects if its captured session generation becomes stale.
   */
  it('rejects stale generation sends before they start', async () => {
    const harness = createHarness()
    const cancelledTurns: Array<{ reason: string, turnId: string }> = []
    let releaseFirstSend: (() => void) | undefined
    harness.runtime.hooks.onTurnCancelled(async (context, reason) => {
      cancelledTurns.push({ reason, turnId: context.turnId })
    })
    harness.stream.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        releaseFirstSend = resolve
      })
    })

    const firstSend = harness.runtime.ingest('hold queue', {
      model: 'gpt-test',
      chatProvider: provider,
    })
    const firstSendOutcome = firstSend.catch(error => error)
    const secondSend = harness.runtime.ingest('stale request', {
      model: 'gpt-test',
      chatProvider: provider,
    })

    await vi.waitFor(() => {
      expect(harness.stream).toHaveBeenCalledTimes(1)
    })
    await vi.waitFor(() => {
      expect(harness.runtime.getPendingQueuedSendCount()).toBe(1)
    })
    harness.generation.set(2)
    releaseFirstSend?.()

    await expect(firstSendOutcome).resolves.toMatchObject({
      code: 'CHAT_TURN_CANCELLED',
      reason: 'reset',
    })
    await expect(secondSend).rejects.toThrow('Chat session was reset before send could start')
    expect(harness.stream).toHaveBeenCalledTimes(1)
    expect(cancelledTurns).toEqual([{
      reason: 'reset',
      turnId: 'turn-1',
    }])
  })

  /**
   * @example
   * runtime.setSending(true)
   * expect(runtime.getSending()).toBe(true)
   */
  it('keeps sending externally writable for UI facades', () => {
    const harness = createHarness()

    harness.runtime.setSending(true)
    expect(harness.runtime.getSending()).toBe(true)
    expect(harness.stateChanges.at(-1)).toEqual({
      sending: true,
      pendingQueuedSendCount: 0,
    })

    harness.runtime.setSending(false)
    expect(harness.runtime.getSending()).toBe(false)
    expect(harness.stateChanges.at(-1)).toEqual({
      sending: false,
      pendingQueuedSendCount: 0,
    })
  })

  /**
   * @example
   * const snapshot = runtime.getPendingQueuedSendSnapshot()
   * expect(snapshot[0].inputType).toBe('input:text')
   */
  it('returns pending queued send snapshots with public fields', async () => {
    const harness = createHarness()
    let releaseFirstSend: (() => void) | undefined
    harness.stream.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        releaseFirstSend = resolve
      })
    })

    const queuedMessage = 'queued-message-'.repeat(12)
    const firstSend = harness.runtime.ingest('hold queue', {
      model: 'gpt-test',
      chatProvider: provider,
    })
    const secondSend = harness.runtime.ingest(queuedMessage, {
      model: 'gpt-test',
      chatProvider: provider,
      attachments: [
        {
          type: 'image',
          data: 'aW1hZ2U=',
          mimeType: 'image/png',
        },
      ],
      input: {
        type: 'input:text',
        data: {
          text: 'queued input',
        },
      },
    })

    await vi.waitFor(() => {
      expect(harness.stream).toHaveBeenCalledTimes(1)
    })
    await vi.waitFor(() => {
      expect(harness.runtime.getPendingQueuedSendCount()).toBe(1)
    })

    expect(harness.runtime.getPendingQueuedSendSnapshot()).toEqual([
      {
        turnId: 'turn-2',
        sessionId: 'session-1',
        generation: 1,
        cancelled: false,
        messagePreview: queuedMessage.slice(0, 120),
        hasAttachments: true,
        inputType: 'input:text',
      },
    ])

    harness.runtime.cancelPendingSends('session-1')
    releaseFirstSend?.()

    await expect(secondSend).rejects.toThrow('Chat session was reset before send could start')
    await firstSend
  })

  /**
   * @example
   * Attachments, reasoning deltas, and tool events update the assistant builder.
   */
  it('handles attachments, reasoning deltas, tool events, and assistant finalization', async () => {
    const harness = createHarness()
    let composedMessages: Message[] = []
    harness.stream.mockImplementationOnce(async (_model, _chatProvider, messages, options) => {
      composedMessages = messages
      await options?.onStreamEvent?.({ type: 'reasoning-delta', text: 'thinking' })
      await options?.onStreamEvent?.({
        type: 'tool-call',
        toolCallId: 'tool-1',
        toolName: 'weather',
        args: {},
      } as StreamEvent)
      await options?.onStreamEvent?.({
        type: 'tool-result',
        toolCallId: 'tool-1',
        result: 'sunny',
      } as StreamEvent)
      await options?.onStreamEvent?.({ type: 'text-delta', text: 'visible reply' })
      await options?.onStreamEvent?.({ type: 'finish', finishReason: 'stop' })
    })

    await harness.runtime.ingest('see image', {
      model: 'gpt-test',
      chatProvider: provider,
      attachments: [
        {
          type: 'image',
          data: 'aW1hZ2U=',
          mimeType: 'image/png',
        },
      ],
    })

    expect(composedMessages[1]?.content).toEqual([
      {
        type: 'text',
        text: '[2026-04-25 18:47] see image',
      },
      {
        type: 'image_url',
        image_url: {
          url: 'data:image/png;base64,aW1hZ2U=',
        },
      },
    ])
    const assistant = harness.sessionMessages['session-1']?.at(-1)
    expect(assistant).toMatchObject({
      role: 'assistant',
      content: 'visible reply',
      categorization: {
        reasoning: 'thinking',
      },
    })
    expect((assistant as StreamingAssistantMessage).slices).toEqual([
      expect.objectContaining({
        type: 'tool-call',
        toolCall: expect.objectContaining({
          toolCallId: 'tool-1',
        }),
      }),
      {
        type: 'text',
        text: 'visible reply',
      },
    ])
    expect((assistant as StreamingAssistantMessage).tool_results).toEqual([
      {
        type: 'tool-call-result',
        id: 'tool-1',
        result: 'sunny',
      },
    ])
    expect(harness.assistantAppended).toHaveLength(1)
    expect(harness.foregroundResets).toHaveLength(1)
  })
})
