import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'

import { useLlmStreamingControlStore } from '../../llm-streaming-control'
import { useContextBridgeStore } from './context-bridge'

type SparkNotifyReactionMock = (event: {
  data?: {
    id?: string
  }
}, options?: unknown) => Promise<string>

const handleSparkNotifyWithReaction = vi.fn<SparkNotifyReactionMock>(async () => 'reaction text')

function getLastSparkEventId() {
  return handleSparkNotifyWithReaction.mock.calls.at(-1)?.[0]?.data?.id
}

vi.mock('../../character', () => ({
  useCharacterOrchestratorStore: () => ({
    handleSparkNotifyWithReaction,
  }),
}))

vi.mock('../../chat', () => ({
  useChatOrchestratorStore: () => ({}),
}))

vi.mock('../../chat/session-store', () => ({
  useChatSessionStore: () => ({}),
}))

vi.mock('../../chat/stream-store', () => ({
  useChatStreamStore: () => ({}),
}))

vi.mock('../../chat/context-store', () => ({
  useChatContextStore: () => ({
    ingestContextMessage: vi.fn(),
  }),
}))

// ROOT CAUSE:
//
// Discord memory support added eager context-bridge store dependencies. This
// focused performance-call test did not isolate them, so store construction
// escaped into the unrelated airi-card/i18n component context and failed before
// the behavior under test ran.
//
// Keep the new direct dependencies explicit here so this suite continues to
// test only Spark performance dispatch behavior.
vi.mock('../../chat/memory-store', () => ({
  useChatMemoryStore: () => ({
    clearCurrentScope: vi.fn(async () => undefined),
  }),
}))

vi.mock('../../devtools/context-observability', () => ({
  useContextObservabilityStore: () => ({
    recordLifecycle: vi.fn(),
  }),
}))

vi.mock('../../modules/consciousness', () => ({
  useConsciousnessStore: () => ({
    activeProvider: ref(undefined),
    activeModel: ref(undefined),
  }),
}))

vi.mock('../../modules/discord', () => ({
  useDiscordStore: () => ({
    getLongTermMemoryConsent: vi.fn(),
    memoryConsentRequired: true,
    rememberObservedDiscordScope: vi.fn(),
    setLongTermMemoryConsent: vi.fn(),
    syncSavedSettingsToBackend: vi.fn(),
  }),
}))

vi.mock('../../providers', () => ({
  useProvidersStore: () => ({}),
}))

vi.mock('./channel-server', () => ({
  useModsServerChannelStore: () => ({
    ensureConnected: vi.fn(async () => undefined),
    send: vi.fn(),
    onReconnected: vi.fn(() => () => undefined),
    onContextUpdate: vi.fn(() => () => undefined),
    onEvent: vi.fn(() => () => undefined),
  }),
}))

describe('dispatchSparkNotifyPerformance', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    handleSparkNotifyWithReaction.mockClear()
  })

  /**
   * @example
   * const resultPromise = store.dispatchSparkNotifyPerformance({ headline: 'x', fallbackResponseText: '', calls: [{ manifest: { name: 'plugin.action', prompt: 'Run it.' }, handler }] })
   * await streamingControl.dispatchWith('<|CALL ["plugin.action"]|>', { turnId })
   * await expect(resultPromise).resolves.toMatchObject({ type: 'called', name: 'plugin.action' })
   */
  it('resolves when a registered generic performance call is emitted', async () => {
    const store = useContextBridgeStore()
    store.setSparkNotifyHostRole('main')
    const handler = vi.fn()
    const streamingControl = useLlmStreamingControlStore()

    const resultPromise = store.dispatchSparkNotifyPerformance({
      headline: 'Plugin performance',
      fallbackResponseText: '',
      calls: [
        {
          manifest: {
            name: 'plugin.action',
            prompt: 'Run the plugin action when the model is ready.',
            examples: [
              '<|CALL ["plugin.action"]|>',
            ],
          },
          handler,
        },
      ],
      timeoutMs: 1000,
    })

    const sparkEventId = getLastSparkEventId()
    expect(sparkEventId).toEqual(expect.any(String))

    await streamingControl.dispatchWith('<|CALL ["plugin.action"]|>', {
      turnId: `spark:${sparkEventId}`,
    })

    await expect(resultPromise).resolves.toEqual({
      type: 'called',
      name: 'plugin.action',
      reaction: 'reaction text',
    })
    expect(handler).toHaveBeenCalledTimes(1)
    expect(handleSparkNotifyWithReaction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        messageOverride: expect.objectContaining({
          appendSystemInstructions: [
            expect.stringContaining('<|CALL ["plugin.action"]|>'),
          ],
        }),
      }),
    )
  })

  it('includes the CALL payload in the performance result', async () => {
    const store = useContextBridgeStore()
    store.setSparkNotifyHostRole('main')
    const handler = vi.fn()
    const streamingControl = useLlmStreamingControlStore()

    const resultPromise = store.dispatchSparkNotifyPerformance({
      headline: 'Plugin performance',
      fallbackResponseText: '',
      calls: [
        {
          manifest: {
            name: 'plugin.action',
            prompt: 'Run the plugin action when the model is ready.',
          },
          handler,
        },
      ],
    })
    const sparkEventId = getLastSparkEventId()
    expect(sparkEventId).toEqual(expect.any(String))

    await streamingControl.dispatchWith('<|CALL ["plugin.action", {"move":"Nf3"}]|>', {
      turnId: `spark:${sparkEventId}`,
    })

    await expect(resultPromise).resolves.toEqual({
      type: 'called',
      name: 'plugin.action',
      payload: { move: 'Nf3' },
      reaction: 'reaction text',
    })
    expect(handler).toHaveBeenCalledWith({ move: 'Nf3' })
  })

  it('falls back when a client-side performance bridge request is not answered', async () => {
    vi.useFakeTimers()
    const store = useContextBridgeStore()
    store.setSparkNotifyHostRole('client')

    const resultPromise = store.dispatchSparkNotifyPerformance({
      headline: 'Plugin performance',
      fallbackResponseText: 'fallback text',
      calls: [
        {
          manifest: {
            name: 'plugin.action',
            prompt: 'Run the plugin action when the model is ready.',
          },
          handler: vi.fn(),
        },
      ],
      timeoutMs: 10,
    })

    await vi.advanceTimersByTimeAsync(10)

    await expect(resultPromise).resolves.toEqual({
      type: 'timeout',
      reaction: 'fallback text',
    })
    vi.useRealTimers()
  })

  /**
   * @example
   * const result = store.dispatchSparkNotifyPerformance({ calls: [{ manifest: { name: 'plugin.action', prompt: 'Run it.' }, handler }] })
   * streamingControl.completeTurn(turnId)
   * await expect(result).resolves.toMatchObject({ type: 'completed' })
   */
  it('resolves with completed when the turn ends without CALL', async () => {
    const store = useContextBridgeStore()
    store.setSparkNotifyHostRole('main')
    const handler = vi.fn()
    const streamingControl = useLlmStreamingControlStore()

    const resultPromise = store.dispatchSparkNotifyPerformance({
      headline: 'Plugin performance',
      fallbackResponseText: '',
      calls: [
        {
          manifest: {
            name: 'plugin.action',
            prompt: 'Run the plugin action when the model is ready.',
          },
          handler,
        },
      ],
    })
    const sparkEventId = getLastSparkEventId()
    expect(sparkEventId).toEqual(expect.any(String))
    streamingControl.completeTurn(`spark:${sparkEventId}`)

    await expect(resultPromise).resolves.toEqual({
      type: 'completed',
      reaction: 'reaction text',
    })
    expect(handler).not.toHaveBeenCalled()
  })
})
