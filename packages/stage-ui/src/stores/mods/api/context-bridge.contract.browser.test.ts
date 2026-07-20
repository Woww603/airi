import { ContextUpdateStrategy } from '@proj-airi/server-sdk'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'

import { CHAT_STREAM_CHANNEL_NAME, CONTEXT_CHANNEL_NAME } from '../../chat/constants'

type HookCallback = (...args: unknown[]) => Promise<void> | void
type UseContextBridgeStore = typeof import('./context-bridge')['useContextBridgeStore']

const contextUpdateHooks: HookCallback[] = []
const serverEventHooks = new Map<string, HookCallback[]>()

const chatContextIngestMock = vi.fn()
const beginStreamMock = vi.fn()
const appendStreamLiteralMock = vi.fn()
const finalizeStreamMock = vi.fn()
const resetStreamMock = vi.fn()
const serverSendMock = vi.fn()
const ensureConnectedMock = vi.fn().mockResolvedValue(undefined)
const onReconnectedMock = vi.fn(() => () => {})
const onContextUpdateMock = vi.fn((callback: HookCallback) => registerHook(contextUpdateHooks, callback))
const onEventMock = vi.fn((eventName: string, callback: HookCallback) => registerServerEventHook(eventName, callback))
const getProviderInstanceMock = vi.fn()
const recordLifecycleMock = vi.fn()
const syncDiscordSettingsMock = vi.fn()
const rememberObservedDiscordScopeMock = vi.fn()
const hasLongTermMemoryConsentMock = vi.fn()
const getLongTermMemoryConsentMock = vi.fn()
const setLongTermMemoryConsentMock = vi.fn()
const clearCurrentMemoryScopeMock = vi.fn()

const activeProviderRef = ref<string | null>(null)
const activeModelRef = ref<string | null>(null)

const beforeComposeHooks: HookCallback[] = []
const afterComposeHooks: HookCallback[] = []
const beforeSendHooks: HookCallback[] = []
const afterSendHooks: HookCallback[] = []
const tokenLiteralHooks: HookCallback[] = []
const tokenSpecialHooks: HookCallback[] = []
const streamEndHooks: HookCallback[] = []
const assistantEndHooks: HookCallback[] = []
const assistantMessageHooks: HookCallback[] = []
const turnCompleteHooks: HookCallback[] = []

const activeSessionIdRef = ref('session-1')
let currentGeneration = 7
const testChannels: BroadcastChannel[] = []
let useContextBridgeStore: UseContextBridgeStore

function registerHook(target: HookCallback[], callback: HookCallback) {
  target.push(callback)
  return () => {
    const index = target.indexOf(callback)
    if (index >= 0)
      target.splice(index, 1)
  }
}

function registerServerEventHook(eventName: string, callback: HookCallback) {
  const hooks = serverEventHooks.get(eventName) ?? []
  serverEventHooks.set(eventName, hooks)
  return registerHook(hooks, callback)
}

function createTestChannel(name: string) {
  const channel = new BroadcastChannel(name)
  testChannels.push(channel)
  return channel
}

function collectChannelMessages<T>(name: string) {
  const messages: T[] = []
  const channel = createTestChannel(name)
  channel.addEventListener('message', (event) => {
    messages.push((event as MessageEvent<T>).data)
  })
  return messages
}

function closeTestChannels() {
  for (const channel of testChannels) {
    channel.close()
  }
  testChannels.length = 0
}

async function waitForBroadcastDelivery() {
  await new Promise(resolve => setTimeout(resolve, 50))
}

async function emitHooks(target: HookCallback[], ...args: unknown[]) {
  for (const callback of target) {
    await callback(...args)
  }
}

async function emitContextUpdate(event: unknown) {
  await emitHooks(contextUpdateHooks, event)
}

async function emitServerEvent(eventName: string, event: unknown) {
  await emitHooks(serverEventHooks.get(eventName) ?? [], event)
}

function createMetadata(pluginId: string, instanceId: string) {
  return {
    source: {
      id: instanceId,
      kind: 'plugin',
      plugin: {
        id: pluginId,
      },
    },
  }
}

function createContextMessage(overrides: Record<string, unknown> = {}) {
  const id = typeof overrides.id === 'string' ? overrides.id : 'context-1'

  return {
    id,
    contextId: typeof overrides.contextId === 'string' ? overrides.contextId : id,
    strategy: ContextUpdateStrategy.AppendSelf,
    text: 'context text',
    createdAt: 1,
    ...overrides,
  }
}

function createContextUpdateEvent(overrides: Record<string, unknown> = {}) {
  const id = typeof overrides.id === 'string' ? overrides.id : 'context-1'

  return {
    type: 'context:update',
    source: 'plugin-module-host',
    metadata: createMetadata('weather', 'station-1'),
    data: {
      id,
      contextId: id,
      strategy: ContextUpdateStrategy.AppendSelf,
      text: 'weather changed',
      ...overrides,
    },
  }
}

const chatOrchestratorMock = {
  sending: false,
  ingest: vi.fn(),
  cancelTurn: vi.fn(),
  emitTurnCancelledHooks: vi.fn(),

  onBeforeMessageComposed: (callback: HookCallback) => registerHook(beforeComposeHooks, callback),
  onAfterMessageComposed: (callback: HookCallback) => registerHook(afterComposeHooks, callback),
  onBeforeSend: (callback: HookCallback) => registerHook(beforeSendHooks, callback),
  onAfterSend: (callback: HookCallback) => registerHook(afterSendHooks, callback),
  onTokenLiteral: (callback: HookCallback) => registerHook(tokenLiteralHooks, callback),
  onTokenSpecial: (callback: HookCallback) => registerHook(tokenSpecialHooks, callback),
  onStreamEnd: (callback: HookCallback) => registerHook(streamEndHooks, callback),
  onAssistantResponseEnd: (callback: HookCallback) => registerHook(assistantEndHooks, callback),
  onAssistantMessage: (callback: HookCallback) => registerHook(assistantMessageHooks, callback),
  onChatTurnComplete: (callback: HookCallback) => registerHook(turnCompleteHooks, callback),

  emitBeforeMessageComposedHooks: (...args: unknown[]) => emitHooks(beforeComposeHooks, ...args),
  emitAfterMessageComposedHooks: (...args: unknown[]) => emitHooks(afterComposeHooks, ...args),
  emitBeforeSendHooks: (...args: unknown[]) => emitHooks(beforeSendHooks, ...args),
  emitAfterSendHooks: (...args: unknown[]) => emitHooks(afterSendHooks, ...args),
  emitTokenLiteralHooks: (...args: unknown[]) => emitHooks(tokenLiteralHooks, ...args),
  emitTokenSpecialHooks: (...args: unknown[]) => emitHooks(tokenSpecialHooks, ...args),
  emitStreamEndHooks: (...args: unknown[]) => emitHooks(streamEndHooks, ...args),
  emitAssistantResponseEndHooks: (...args: unknown[]) => emitHooks(assistantEndHooks, ...args),
}

vi.mock('pinia', async () => {
  const actual = await vi.importActual<typeof import('pinia')>('pinia')
  return {
    ...actual,
    storeToRefs: (store: unknown) => store,
  }
})

vi.mock('@proj-airi/stage-shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@proj-airi/stage-shared')>()
  return {
    ...actual,
    isStageWeb: () => true,
    isStageTamagotchi: () => false,
  }
})

vi.mock('es-toolkit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('es-toolkit')>()
  return {
    ...actual,
    Mutex: class {
      async acquire() {}
      release() {}
    },
  }
})

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock('../../character', () => ({
  useCharacterOrchestratorStore: () => ({
    handleSparkNotifyWithReaction: vi.fn(async (_event: unknown, options: { fallbackText: string }) => options.fallbackText),
  }),
}))

vi.mock('../../chat', () => ({
  useChatOrchestratorStore: () => chatOrchestratorMock,
}))

vi.mock('../../chat/context-store', () => ({
  useChatContextStore: () => ({
    ingestContextMessage: chatContextIngestMock,
  }),
}))

vi.mock('../../chat/memory-store', () => ({
  useChatMemoryStore: () => ({
    clearCurrentScope: clearCurrentMemoryScopeMock,
  }),
}))

vi.mock('../../chat/session-store', () => ({
  useChatSessionStore: () => ({
    get activeSessionId() {
      return activeSessionIdRef.value
    },
    getSessionGenerationValue: () => currentGeneration,
  }),
}))

vi.mock('../../chat/stream-store', () => ({
  useChatStreamStore: () => ({
    beginStream: beginStreamMock,
    appendStreamLiteral: appendStreamLiteralMock,
    finalizeStream: finalizeStreamMock,
    resetStream: resetStreamMock,
  }),
}))

vi.mock('../../devtools/context-observability', () => ({
  useContextObservabilityStore: () => ({
    recordLifecycle: recordLifecycleMock,
  }),
}))

vi.mock('../../modules/consciousness', () => ({
  useConsciousnessStore: () => ({
    activeProvider: activeProviderRef,
    activeModel: activeModelRef,
  }),
}))

vi.mock('../../modules/discord', () => ({
  useDiscordStore: () => ({
    syncSavedSettingsToBackend: syncDiscordSettingsMock,
    rememberObservedDiscordScope: rememberObservedDiscordScopeMock,
    memoryConsentRequired: true,
    hasLongTermMemoryConsent: hasLongTermMemoryConsentMock,
    getLongTermMemoryConsent: getLongTermMemoryConsentMock,
    setLongTermMemoryConsent: setLongTermMemoryConsentMock,
  }),
}))

vi.mock('../../providers', () => ({
  useProvidersStore: () => ({
    configuredSpeechProvidersMetadata: [],
    getProviderConfig: vi.fn(() => ({})),
    getProviderInstance: getProviderInstanceMock,
    getProviderMetadata: vi.fn(() => ({
      capabilities: {},
    })),
    providerRuntimeState: {},
  }),
}))

vi.mock('./channel-server', () => ({
  useModsServerChannelStore: () => ({
    ensureConnected: ensureConnectedMock,
    onReconnected: onReconnectedMock,
    onContextUpdate: onContextUpdateMock,
    onEvent: onEventMock,
    send: serverSendMock,
  }),
}))

describe('context bridge contract', () => {
  beforeEach(async () => {
    setActivePinia(createPinia())
    ;({ useContextBridgeStore } = await import('./context-bridge'))

    chatContextIngestMock.mockReset()
    beginStreamMock.mockReset()
    appendStreamLiteralMock.mockReset()
    finalizeStreamMock.mockReset()
    resetStreamMock.mockReset()
    serverSendMock.mockReset()
    ensureConnectedMock.mockClear()
    ensureConnectedMock.mockResolvedValue(undefined)
    onReconnectedMock.mockClear()
    onContextUpdateMock.mockClear()
    onEventMock.mockClear()
    syncDiscordSettingsMock.mockReset()
    rememberObservedDiscordScopeMock.mockReset()
    hasLongTermMemoryConsentMock.mockReset()
    hasLongTermMemoryConsentMock.mockReturnValue(false)
    getLongTermMemoryConsentMock.mockReset()
    getLongTermMemoryConsentMock.mockReturnValue(undefined)
    setLongTermMemoryConsentMock.mockReset()
    clearCurrentMemoryScopeMock.mockReset()
    clearCurrentMemoryScopeMock.mockResolvedValue(undefined)
    getProviderInstanceMock.mockReset()
    recordLifecycleMock.mockReset()
    chatOrchestratorMock.ingest.mockReset()
    chatOrchestratorMock.cancelTurn.mockReset()
    chatOrchestratorMock.emitTurnCancelledHooks.mockReset()
    chatOrchestratorMock.emitTurnCancelledHooks.mockResolvedValue(undefined)

    globalThis.localStorage.clear()

    activeProviderRef.value = null
    activeModelRef.value = null
    activeSessionIdRef.value = 'session-1'
    currentGeneration = 7
    chatOrchestratorMock.sending = false

    beforeComposeHooks.length = 0
    afterComposeHooks.length = 0
    beforeSendHooks.length = 0
    afterSendHooks.length = 0
    tokenLiteralHooks.length = 0
    tokenSpecialHooks.length = 0
    streamEndHooks.length = 0
    assistantEndHooks.length = 0
    assistantMessageHooks.length = 0
    turnCompleteHooks.length = 0
    contextUpdateHooks.length = 0
    serverEventHooks.clear()
  })

  afterEach(() => {
    closeTestChannels()
    vi.restoreAllMocks()
  })

  /**
   * @example
   * Discord memory commands are registered as a consumer group.
   */
  it('registers Discord memory commands as a single consumer group', async () => {
    const store = useContextBridgeStore()
    await store.initialize()

    expect(serverSendMock).toHaveBeenCalledWith({
      type: 'module:consumer:register',
      data: {
        event: 'discord:memory:command',
        mode: 'consumer-group',
        group: 'discord-memory-command',
      },
    })

    await store.dispose()
  })

  /**
   * @example
   * Discord forget command clears only the exact session and returns a result event.
   */
  it('handles Discord forget memory command without invoking chat ingestion', async () => {
    const store = useContextBridgeStore()
    await store.initialize()

    await emitServerEvent('discord:memory:command', {
      type: 'discord:memory:command',
      metadata: createMetadata('discord', 'discord-1'),
      data: {
        commandId: 'command-1',
        action: 'forget-current-session',
        sessionId: 'discord-guild-111-channel-aaa-user-user-1',
        guildId: '111',
        channelId: 'aaa',
        userId: 'user-1',
        requestedAt: 1,
      },
    })

    expect(setLongTermMemoryConsentMock).toHaveBeenCalledWith('discord-guild-111-channel-aaa-user-user-1', false)
    expect(clearCurrentMemoryScopeMock).toHaveBeenCalledWith('discord-guild-111-channel-aaa-user-user-1')
    expect(chatOrchestratorMock.ingest).not.toHaveBeenCalled()
    expect(serverSendMock).toHaveBeenCalledWith({
      type: 'discord:memory:command:result',
      data: expect.objectContaining({
        commandId: 'command-1',
        action: 'forget-current-session',
        sessionId: 'discord-guild-111-channel-aaa-user-user-1',
        status: 'ok',
      }),
    })

    await store.dispose()
  })

  /**
   * @example
   * Discord opt-in command grants memory consent for the exact session.
   */
  it('handles Discord memory opt-in for the exact session', async () => {
    const store = useContextBridgeStore()
    await store.initialize()

    await emitServerEvent('discord:memory:command', {
      type: 'discord:memory:command',
      metadata: createMetadata('discord', 'discord-1'),
      data: {
        commandId: 'command-2',
        action: 'memory-opt-in',
        sessionId: 'discord-guild-111-channel-aaa-user-user-1',
        guildId: '111',
        channelId: 'aaa',
        userId: 'user-1',
        requestedAt: 1,
      },
    })

    expect(setLongTermMemoryConsentMock).toHaveBeenCalledWith('discord-guild-111-channel-aaa-user-user-1', true)
    expect(clearCurrentMemoryScopeMock).not.toHaveBeenCalled()
    expect(serverSendMock).toHaveBeenCalledWith({
      type: 'discord:memory:command:result',
      data: expect.objectContaining({
        commandId: 'command-2',
        action: 'memory-opt-in',
        sessionId: 'discord-guild-111-channel-aaa-user-user-1',
        status: 'ok',
      }),
    })

    await store.dispose()
  })

  /**
   * @example
   * An expired pending record cannot be revived with an old command timestamp.
   */
  it('rechecks pending expiry against the current clock for Discord audit D-025', async () => {
    // ROOT CAUSE:
    //
    // The bridge passed the approval event's `requestedAt` to the repository as
    // the review clock. A delayed or replayed owner command with an older timestamp
    // could therefore make an already-expired temporary record look active again.
    //
    // Before: the expired record transitioned from pending to active.
    // After: the bridge uses its current clock, physically removes the expired
    // temporary record, and reports that no pending memory remains.
    const {
      createMemoryRecord,
      decideMemoryAction,
      discordMemoryRepo,
    } = await import('../../../database/repos/discord-memory.repo')
    const now = Date.now()
    const decision = await decideMemoryAction({
      content: 'currently using compact summaries',
      userId: 'user-1',
      isOwner: false,
      source: 'discord_message',
      requestedScope: 'temporary',
      expiresAt: now - 1,
      now: now - 1_000,
    })
    expect(decision.decision).toBe('store_temporary')
    if (decision.decision !== 'store_temporary')
      return

    const expiredPending = createMemoryRecord({
      decision,
      context: {
        userId: 'user-1',
        isDM: false,
        guildId: '111',
        channelId: 'aaa',
        isOwner: false,
        ownerUserIdConfigured: true,
      },
      status: 'pending',
      now: now - 1_000,
    })
    await discordMemoryRepo.saveMemory(expiredPending)

    const store = useContextBridgeStore()
    await store.initialize()
    try {
      await emitServerEvent('discord:memory:command', {
        type: 'discord:memory:command',
        metadata: createMetadata('discord', 'discord-1'),
        data: {
          commandId: 'command-expired-approval',
          action: 'memory-approve',
          sessionId: 'discord-dm-owner-1',
          channelId: 'owner-dm',
          userId: 'owner-1',
          isOwner: true,
          ownerUserIdConfigured: true,
          memoryId: expiredPending.id,
          requestedAt: now - 2_000,
        },
      })

      expect(await discordMemoryRepo.getMemoryById(expiredPending.id)).toBeNull()
      expect(serverSendMock).toHaveBeenCalledWith({
        type: 'discord:memory:command:result',
        data: expect.objectContaining({
          commandId: 'command-expired-approval',
          status: 'ok',
          message: 'Pending memory not found.',
        }),
      })
    }
    finally {
      await discordMemoryRepo.deleteMemory(expiredPending.id)
      await store.dispose()
    }
  })

  /**
   * @example
   * Project, server, and channel commands retain repository ownership semantics.
   */
  it('orchestrates wide and exact scope lifecycle commands for Discord audit D-025', async () => {
    const { discordMemoryRepo } = await import('../../../database/repos/discord-memory.repo')
    const createdIds: string[] = []
    const now = Date.now()
    const store = useContextBridgeStore()
    await store.initialize()

    const emitMemoryCommand = async (commandId: string, data: Record<string, unknown>) => {
      await emitServerEvent('discord:memory:command', {
        type: 'discord:memory:command',
        metadata: createMetadata('discord', 'discord-1'),
        data: {
          commandId,
          sessionId: 'discord-guild-111-channel-aaa-user-user-1',
          guildId: '111',
          channelId: 'aaa',
          userId: 'user-1',
          ownerUserIdConfigured: true,
          isOwner: false,
          requestedAt: now,
          ...data,
        },
      })

      const result = serverSendMock.mock.calls
        .map(call => call[0])
        .find(event => event?.type === 'discord:memory:command:result' && event.data?.commandId === commandId)
      expect(result).toBeDefined()
      return typeof result?.data?.message === 'string' ? result.data.message : ''
    }

    const rememberPending = async (commandId: string, scope: 'channel' | 'project' | 'server', content: string) => {
      const message = await emitMemoryCommand(commandId, {
        action: 'remember',
        content,
        requestedScope: scope,
      })
      const id = message.match(/^Saved pending memory ([^.]+)\./)?.[1]
      expect(id).toBeTruthy()
      if (!id)
        throw new Error('Synthetic pending memory id was not returned')
      createdIds.push(id)
      return id
    }

    try {
      const projectId = await rememberPending(
        'project-create',
        'project',
        'Project installation uses synthetic compact summaries.',
      )
      expect(await emitMemoryCommand('project-creator-list', {
        action: 'memory-list',
      })).toContain(projectId)
      expect(await emitMemoryCommand('project-hostile-list', {
        action: 'memory-list',
        userId: 'user-2',
        sessionId: 'discord-guild-111-channel-aaa-user-user-2',
      })).not.toContain(projectId)
      expect(await emitMemoryCommand('project-hostile-forget', {
        action: 'forget-memory',
        memoryId: projectId,
        userId: 'user-2',
        sessionId: 'discord-guild-111-channel-aaa-user-user-2',
      })).toBe('You can only forget memory owned by your Discord identity here.')
      expect((await discordMemoryRepo.getMemoryById(projectId))?.status).toBe('pending')
      expect(await emitMemoryCommand('project-owner-approve', {
        action: 'memory-approve',
        guildId: '222',
        channelId: 'bbb',
        userId: 'owner-1',
        isOwner: true,
        memoryId: projectId,
      })).toBe(`Approved memory ${projectId}.`)
      expect(await emitMemoryCommand('project-creator-forget', {
        action: 'forget-memory',
        guildId: undefined,
        channelId: 'dm-user-1',
        sessionId: 'discord-dm-user-1',
        memoryId: projectId,
      })).toBe(`Deleted memory ${projectId}.`)

      const serverId = await rememberPending(
        'server-create',
        'server',
        'Server synthetic launch summaries use compact layout.',
      )
      expect(await emitMemoryCommand('server-wrong-guild-list', {
        action: 'memory-list',
        guildId: '222',
        channelId: 'bbb',
      })).not.toContain(serverId)
      expect(await emitMemoryCommand('server-wrong-guild-forget', {
        action: 'forget-memory',
        guildId: '222',
        channelId: 'bbb',
        memoryId: serverId,
      })).toBe('You can only forget memory owned by your Discord identity here.')
      expect(await emitMemoryCommand('server-owner-wide-list', {
        action: 'memory-list',
        guildId: '222',
        channelId: 'bbb',
        userId: 'owner-1',
        isOwner: true,
      })).toContain(serverId)
      expect(await emitMemoryCommand('server-owner-wide-approve', {
        action: 'memory-approve',
        guildId: '222',
        channelId: 'bbb',
        userId: 'owner-1',
        isOwner: true,
        memoryId: serverId,
      })).toBe(`Approved memory ${serverId}.`)
      expect(await emitMemoryCommand('server-owner-wide-active-list', {
        action: 'memory-list',
        guildId: '222',
        channelId: 'bbb',
        userId: 'owner-1',
        isOwner: true,
      })).not.toContain(serverId)
      expect(await emitMemoryCommand('server-hostile-forget', {
        action: 'forget-memory',
        userId: 'user-2',
        sessionId: 'discord-guild-111-channel-aaa-user-user-2',
        memoryId: serverId,
      })).toBe('You can only forget memory owned by your Discord identity here.')
      expect(await emitMemoryCommand('server-creator-forget', {
        action: 'forget-memory',
        memoryId: serverId,
      })).toBe(`Deleted memory ${serverId}.`)

      const channelId = await rememberPending(
        'channel-create',
        'channel',
        'Channel synthetic launch summaries use compact layout.',
      )
      expect(await emitMemoryCommand('channel-wrong-channel-forget', {
        action: 'forget-memory',
        channelId: 'ccc',
        memoryId: channelId,
      })).toBe('You can only forget memory owned by your Discord identity here.')
      expect(await emitMemoryCommand('channel-owner-wide-approve', {
        action: 'memory-approve',
        guildId: '222',
        channelId: 'bbb',
        userId: 'owner-1',
        isOwner: true,
        memoryId: channelId,
      })).toBe(`Approved memory ${channelId}.`)
      expect(await emitMemoryCommand('channel-owner-wide-active-list', {
        action: 'memory-list',
        guildId: '222',
        channelId: 'bbb',
        userId: 'owner-1',
        isOwner: true,
      })).not.toContain(channelId)
      expect(await emitMemoryCommand('channel-creator-forget', {
        action: 'forget-memory',
        memoryId: channelId,
      })).toBe(`Deleted memory ${channelId}.`)
    }
    finally {
      for (const id of createdIds) {
        await discordMemoryRepo.deleteMemory(id)
      }
      await store.dispose()
    }
  })

  /**
   * @example
   * Broadcast context updates record store-ingested with core result fields.
   */
  it('records core ingest result for broadcast context updates', async () => {
    chatContextIngestMock.mockReturnValueOnce({
      sourceKey: 'weather:station-1',
      mutation: 'append',
      entryCount: 2,
    })
    const store = useContextBridgeStore()
    await store.initialize()
    const contextSender = createTestChannel(CONTEXT_CHANNEL_NAME)

    contextSender.postMessage(createContextMessage({
      id: 'broadcast-context',
      metadata: createMetadata('weather', 'station-1'),
      text: 'broadcast weather',
    }))

    await vi.waitFor(() => {
      expect(chatContextIngestMock).toHaveBeenCalledTimes(1)
    })
    expect(recordLifecycleMock).toHaveBeenCalledWith(expect.objectContaining({
      phase: 'store-ingested',
      channel: 'broadcast',
      sourceKey: 'weather:station-1',
      mutation: 'append',
      details: expect.objectContaining({
        entryCount: 2,
      }),
    }))

    await store.dispose()
  })

  /**
   * @example
   * Server context updates record store-ingested before broadcast-posted.
   */
  it('records core ingest result for server context updates before broadcasting', async () => {
    chatContextIngestMock.mockReturnValueOnce({
      sourceKey: 'weather:station-1',
      mutation: 'replace',
      entryCount: 1,
    })
    const store = useContextBridgeStore()
    await store.initialize()

    await emitContextUpdate(createContextUpdateEvent({
      id: 'server-context',
      strategy: ContextUpdateStrategy.ReplaceSelf,
      text: 'server weather',
    }))

    expect(chatContextIngestMock).toHaveBeenCalledTimes(1)
    expect(recordLifecycleMock).toHaveBeenCalledWith(expect.objectContaining({
      phase: 'store-ingested',
      channel: 'server',
      sourceKey: 'weather:station-1',
      mutation: 'replace',
      details: expect.objectContaining({
        entryCount: 1,
      }),
    }))
    expect(recordLifecycleMock).toHaveBeenCalledWith(expect.objectContaining({
      phase: 'broadcast-posted',
      channel: 'broadcast',
      contextId: 'server-context',
    }))

    await store.dispose()
  })

  /**
   * @example
   * Input context updates record store-ingested and stay in chat input payload.
   */
  it('records core ingest result for input context updates and forwards accepted updates', async () => {
    chatContextIngestMock.mockReturnValueOnce({
      sourceKey: 'weather:station-1',
      mutation: 'append',
      entryCount: 1,
    })
    activeProviderRef.value = 'mock-provider'
    activeModelRef.value = 'mock-model'
    getProviderInstanceMock.mockResolvedValueOnce({})
    const store = useContextBridgeStore()
    await store.initialize()

    const inputEvent = {
      type: 'input:text',
      source: 'plugin-module-host',
      metadata: createMetadata('weather', 'station-1'),
      data: {
        text: 'hello',
        contextUpdates: [
          {
            strategy: ContextUpdateStrategy.AppendSelf,
            text: 'input weather',
          },
        ],
      },
    }

    await emitServerEvent('input:text', inputEvent)

    expect(chatContextIngestMock).toHaveBeenCalledTimes(1)
    expect(recordLifecycleMock).toHaveBeenCalledWith(expect.objectContaining({
      phase: 'store-ingested',
      channel: 'input',
      sourceKey: 'weather:station-1',
      mutation: 'append',
      details: expect.objectContaining({
        entryCount: 1,
        inputType: 'input:text',
      }),
    }))
    expect(chatOrchestratorMock.ingest).toHaveBeenCalledTimes(1)
    expect(rememberObservedDiscordScopeMock).toHaveBeenCalledWith(inputEvent)
    expect(chatOrchestratorMock.ingest.mock.calls[0]?.[1]?.input?.metadata).toEqual(createMetadata('weather', 'station-1'))
    expect(chatOrchestratorMock.ingest.mock.calls[0]?.[1]?.input?.source).toBe('plugin-module-host')
    expect(chatOrchestratorMock.ingest.mock.calls[0]?.[1]?.input?.data.contextUpdates).toEqual([
      expect.objectContaining({
        contextId: expect.any(String),
        id: expect.any(String),
        text: 'input weather',
      }),
    ])

    await store.dispose()
  })

  /**
   * @example
   * Trusted Discord input cannot mutate the global context registry before its exact-session turn starts.
   */
  it('keeps concurrent Discord input context out of the global registry (Discord audit D-005)', async () => {
    activeProviderRef.value = 'mock-provider'
    activeModelRef.value = 'mock-model'
    getProviderInstanceMock.mockResolvedValue({})
    const store = useContextBridgeStore()
    await store.initialize()

    // ROOT CAUSE:
    //
    // input:text currently ingests contextUpdates before acquiring the context
    // bridge Web Lock. Discord uses one fixed ReplaceSelf context id, so turn B can
    // overwrite turn A's metadata before A reaches provider composition.
    //
    // Discord turn metadata must be derived inside the exact chat turn instead of
    // entering the global context registry. Non-Discord context providers retain
    // the existing contextUpdates behavior covered by the preceding test.
    const createDiscordInput = (userId: string, channelId: string) => ({
      type: 'input:text',
      source: 'plugin-module-host',
      metadata: createMetadata('discord', 'discord-1'),
      data: {
        text: `Synthetic Discord input for ${userId}`,
        turn: {
          id: `discord-turn-${userId}-${channelId}`,
          generation: 1,
          deadlineAt: Date.now() + 30_000,
        },
        overrides: {
          sessionId: `discord-guild-guild-1-channel-${channelId}-user-${userId}`,
        },
        contextUpdates: [
          {
            id: 'discord-current-input',
            contextId: 'discord-current-input',
            strategy: ContextUpdateStrategy.ReplaceSelf,
            text: `discord-global-context-sentinel-${userId}`,
          },
        ],
        discord: {
          guildId: 'guild-1',
          channelId,
          guildMember: {
            id: userId,
            displayName: `Synthetic ${userId}`,
            nickname: `Synthetic ${userId}`,
          },
        },
      },
    })

    await Promise.all([
      emitServerEvent('input:text', createDiscordInput('user-a', 'channel-a')),
      emitServerEvent('input:text', createDiscordInput('user-b', 'channel-b')),
    ])

    // @example
    expect(chatContextIngestMock).not.toHaveBeenCalled()
    // @example
    expect(chatOrchestratorMock.ingest).toHaveBeenCalledTimes(2)
    // @example
    expect(chatOrchestratorMock.ingest.mock.calls.map(call => call[2])).toEqual(expect.arrayContaining([
      'discord-guild-guild-1-channel-channel-a-user-user-a',
      'discord-guild-guild-1-channel-channel-b-user-user-b',
    ]))
    // @example
    expect(chatOrchestratorMock.ingest.mock.calls.map(call => call[1]?.input?.data.contextUpdates)).toEqual([
      undefined,
      undefined,
    ])

    await store.dispose()
  })

  /**
   * @example
   * Two Stage windows receive one server event, but only one owns that turn.
   */
  it('processes one correlated input only once across Stage windows for Discord audit D-011', async () => {
    activeProviderRef.value = 'mock-provider'
    activeModelRef.value = 'mock-model'
    getProviderInstanceMock.mockResolvedValue({})
    let releaseIngest: (() => void) | undefined
    let ingestCallCount = 0
    chatOrchestratorMock.ingest.mockImplementation(async () => {
      ingestCallCount += 1
      if (ingestCallCount > 1)
        return
      await new Promise<void>((resolve) => {
        releaseIngest = resolve
      })
    })

    // ROOT CAUSE:
    //
    // Every Stage window receives the same consumer event. The old Web Lock uses
    // one fixed name and waits for ownership, so the losing window processes the
    // same event again after the first window releases the lock.
    //
    // A per-turn ifAvailable lock makes the loser skip instead of replaying, and
    // unrelated turn ids use different lock names.
    setActivePinia(createPinia())
    const firstWindow = useContextBridgeStore()
    await firstWindow.initialize()
    setActivePinia(createPinia())
    const secondWindow = useContextBridgeStore()
    await secondWindow.initialize()

    const inputEvent = {
      type: 'input:text',
      source: 'plugin-module-host',
      metadata: {
        ...createMetadata('discord', 'discord-1'),
        event: { id: 'server-event-turn-1' },
      },
      data: {
        text: 'synthetic duplicate delivery',
        turn: {
          id: 'discord-turn-1',
          generation: 1,
          deadlineAt: Date.now() + 30_000,
        },
        overrides: { sessionId: 'discord-dm-user-1' },
        discord: {
          channelId: 'dm-channel',
          guildMember: {
            id: 'user-1',
            displayName: 'User 1',
            nickname: 'User 1',
          },
        },
      },
    }
    const inputHooks = serverEventHooks.get('input:text') ?? []
    const deliveries = inputHooks.map(callback => callback(inputEvent))

    await vi.waitFor(() => {
      expect(chatOrchestratorMock.ingest).toHaveBeenCalledTimes(1)
    })
    releaseIngest?.()
    await Promise.all(deliveries)

    // A delayed duplicate must remain claimed after the winner releases the
    // Web Lock; otherwise delivery skew can replay the completed event.
    await inputHooks[1]?.(inputEvent)

    expect(getProviderInstanceMock).toHaveBeenCalledTimes(1)
    expect(chatOrchestratorMock.ingest).toHaveBeenCalledTimes(1)

    await firstWindow.dispose()
    await secondWindow.dispose()
  })

  /**
   * @example
   * A claimed Discord turn remains exclusively owned through its deadline even when storage is denied.
   */
  it('retains the per-turn Web Lock without blocking unrelated turns for Discord audit D-011', async () => {
    // ROOT CAUSE:
    //
    // The per-turn Web Lock was released as soon as the shared ledger claim was
    // written. When localStorage was denied, a delayed delivery in another real
    // Stage window could then acquire the same lock because each window's fallback
    // ledger is process-local, replaying the provider turn.
    //
    // The winning window must retain that exact lock through the bounded turn
    // deadline while unrelated lock names remain independently acquirable.
    activeProviderRef.value = 'mock-provider'
    activeModelRef.value = 'mock-model'
    getProviderInstanceMock.mockResolvedValue({})
    chatOrchestratorMock.ingest.mockResolvedValue(undefined)
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('Synthetic storage denial', 'SecurityError')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Synthetic storage denial', 'SecurityError')
    })

    const store = useContextBridgeStore()
    await store.initialize()
    const turnId = 'discord-retained-lock-turn'
    const lockName = `context-bridge:event:input:text:${turnId}`

    const inputEvent = {
      type: 'input:text',
      source: 'plugin-module-host',
      metadata: createMetadata('discord', 'discord-1'),
      data: {
        text: 'SENTINEL_RETAIN_LOCK',
        turn: {
          id: turnId,
          generation: 1,
          deadlineAt: Date.now() + 30_000,
        },
        overrides: { sessionId: 'discord-dm-user-1' },
        discord: {
          channelId: 'dm-channel',
          guildMember: {
            id: 'user-1',
            displayName: 'User 1',
            nickname: 'User 1',
          },
        },
      },
    }
    await emitServerEvent('input:text', inputEvent)
    await emitServerEvent('input:text', inputEvent)

    try {
      const sameTurnAvailable = await navigator.locks.request(lockName, { ifAvailable: true }, lock => Boolean(lock))
      const unrelatedTurnAvailable = await navigator.locks.request(
        'context-bridge:event:input:text:unrelated-turn',
        { ifAvailable: true },
        lock => Boolean(lock),
      )

      // @example
      expect(sameTurnAvailable).toBe(false)
      // @example
      expect(unrelatedTurnAvailable).toBe(true)
      // @example
      expect(chatOrchestratorMock.ingest).toHaveBeenCalledTimes(1)
    }
    finally {
      await store.dispose()
    }

    const releasedAfterDispose = await navigator.locks.request(lockName, { ifAvailable: true }, lock => Boolean(lock))
    // @example
    expect(releasedAfterDispose).toBe(true)
  })

  /**
   * @example
   * A trusted Discord lifecycle cancellation invalidates only its correlated Stage turn.
   */
  it('routes trusted exact-turn cancellation into Stage for Discord audit D-011', async () => {
    // ROOT CAUSE:
    //
    // Discord timeout, disconnect, disable, and voice-session abort previously
    // ended only adapter timers. Stage and providers had no canonical event that
    // could invalidate the exact queued or running turn.
    //
    // The trusted Discord consumer now routes the stable turn id to core-agent's
    // exact cancellation gate without resetting newer work in the same session.
    const store = useContextBridgeStore()
    await store.initialize()

    await emitServerEvent('chat:turn:cancel', {
      type: 'chat:turn:cancel',
      metadata: createMetadata('discord', 'discord-1'),
      data: {
        cancelledAt: Date.now(),
        reason: 'deadline',
        sessionId: 'discord-dm-user-1',
        turn: {
          id: 'discord-cancelled-turn-1',
          generation: 1,
          deadlineAt: Date.now() + 30_000,
        },
      },
    })

    // @example
    expect(chatOrchestratorMock.cancelTurn).toHaveBeenCalledTimes(1)
    // @example
    expect(chatOrchestratorMock.cancelTurn).toHaveBeenCalledWith('discord-cancelled-turn-1', 'deadline')

    await store.dispose()
  })

  /**
   * @example
   * Cancellation received while the provider is starting prevents that turn from entering Stage.
   */
  it('retains cancellation received before provider registration for Discord audit D-011', async () => {
    // ROOT CAUSE:
    //
    // The cancellation consumer called cancelTurn immediately, but input:text did
    // not register the turn with core-agent until after provider construction.
    // A timeout delivered while getProviderInstance was pending therefore found
    // nothing to cancel, and the input started after the provider promise resolved.
    //
    // The bridge must retain a bounded exact-turn cancellation tombstone and
    // recheck it before provider construction and immediately before ingestion.
    activeProviderRef.value = 'mock-provider'
    activeModelRef.value = 'mock-model'
    let releaseProvider: ((provider: object) => void) | undefined
    getProviderInstanceMock.mockImplementationOnce(() => new Promise<object>((resolve) => {
      releaseProvider = resolve
    }))
    chatOrchestratorMock.cancelTurn.mockReturnValue(false)
    const store = useContextBridgeStore()
    await store.initialize()

    const deadlineAt = Date.now() + 30_000
    const inputDelivery = emitServerEvent('input:text', {
      type: 'input:text',
      source: 'plugin-module-host',
      metadata: createMetadata('discord', 'discord-1'),
      data: {
        text: 'SENTINEL_CANCEL_BEFORE_PROVIDER',
        turn: {
          id: 'discord-cancel-before-provider',
          generation: 1,
          deadlineAt,
        },
        overrides: { sessionId: 'discord-dm-user-1' },
        discord: {
          channelId: 'dm-channel',
          guildMember: {
            id: 'user-1',
            displayName: 'User 1',
            nickname: 'User 1',
          },
        },
      },
    })

    await vi.waitFor(() => {
      expect(getProviderInstanceMock).toHaveBeenCalledTimes(1)
    })
    await emitServerEvent('chat:turn:cancel', {
      type: 'chat:turn:cancel',
      metadata: createMetadata('discord', 'discord-1'),
      data: {
        cancelledAt: Date.now(),
        reason: 'deadline',
        sessionId: 'discord-dm-user-1',
        turn: {
          id: 'discord-cancel-before-provider',
          generation: 1,
          deadlineAt,
        },
      },
    })
    releaseProvider?.({})
    await inputDelivery

    // @example
    expect(chatOrchestratorMock.ingest).not.toHaveBeenCalled()

    await store.dispose()
  })

  /**
   * @example
   * A follower window cancels its retained Discord hook context without owning the provider turn.
   */
  it('cancels passive-window hooks and rejects late remote output for Discord audit D-011', async () => {
    // ROOT CAUSE:
    //
    // A follower Stage window replayed `before-compose` hooks (including TTS)
    // but retained no hook context until `before-send`. Its local core runtime did
    // not own the provider turn, so `cancelTurn()` returned false and timeout
    // cancellation never reached Stage hooks. Later broadcast tokens could still
    // recreate UI/audio side effects.
    //
    // Trusted remote Discord contexts must remain bounded and cancellable from
    // before-compose through their deadline; cancellation becomes a tombstone for
    // every later event carrying that exact turn id.
    activeSessionIdRef.value = 'passive-session'
    currentGeneration = 7
    chatOrchestratorMock.cancelTurn.mockReturnValue(false)
    const store = useContextBridgeStore()
    await store.initialize()
    const streamSender = createTestChannel(CHAT_STREAM_CHANNEL_NAME)
    const deadlineAt = Date.now() + 30_000
    const context = {
      turnId: 'remote-discord-cancelled-turn',
      generation: 7,
      deadlineAt,
      sessionId: 'passive-session',
      promptContributions: [],
      message: { role: 'user', content: 'SENTINEL_PASSIVE_CANCEL' },
      contexts: {},
      input: {
        type: 'input:text',
        source: 'plugin-module-host',
        metadata: createMetadata('discord', 'discord-1'),
        data: {
          text: 'SENTINEL_PASSIVE_CANCEL',
          turn: {
            id: 'remote-discord-cancelled-turn',
            generation: 7,
            deadlineAt,
          },
          overrides: { sessionId: 'passive-session' },
        },
      },
    }

    streamSender.postMessage({
      type: 'before-compose',
      message: 'SENTINEL_PASSIVE_CANCEL',
      sessionId: 'passive-session',
      context,
    })
    await waitForBroadcastDelivery()

    await emitServerEvent('chat:turn:cancel', {
      type: 'chat:turn:cancel',
      metadata: createMetadata('discord', 'discord-1'),
      data: {
        cancelledAt: Date.now(),
        reason: 'deadline',
        sessionId: 'passive-session',
        turn: {
          id: 'remote-discord-cancelled-turn',
          generation: 7,
          deadlineAt,
        },
      },
    })

    // @example
    expect(chatOrchestratorMock.emitTurnCancelledHooks).toHaveBeenCalledTimes(1)
    // @example
    expect(chatOrchestratorMock.emitTurnCancelledHooks).toHaveBeenCalledWith(
      expect.objectContaining({
        turnId: 'remote-discord-cancelled-turn',
        sessionId: 'passive-session',
      }),
      'deadline',
    )

    streamSender.postMessage({
      type: 'before-send',
      message: 'LATE_SEND_MUST_BE_DROPPED',
      sessionId: 'passive-session',
      context: { ...context, composedMessage: [] },
    })
    streamSender.postMessage({
      type: 'token-literal',
      literal: 'LATE_LITERAL_MUST_BE_DROPPED',
      sessionId: 'passive-session',
      context: { ...context, composedMessage: [] },
    })
    await waitForBroadcastDelivery()

    // @example
    expect(beginStreamMock).not.toHaveBeenCalled()
    // @example
    expect(appendStreamLiteralMock).not.toHaveBeenCalledWith('LATE_LITERAL_MUST_BE_DROPPED')

    await store.dispose()
  })

  /**
   * @example
   * A passive renderer enforces the correlated deadline even if the server cancellation event is delayed.
   */
  it('cancels passive hooks exactly once when their Discord audit D-011 deadline expires', async () => {
    // ROOT CAUSE:
    //
    // The passive stream watcher noticed an expired deadline but only released
    // mirrored UI ownership. Its retained TTS session kept playing until a separate
    // server cancellation event arrived, so a delayed/lost event bypassed the
    // deadline already present on the canonical turn context.
    //
    // Deadline observation must atomically write the shared cancellation ledger,
    // run exact-turn cancellation once, and reject every later stream event.
    activeSessionIdRef.value = 'passive-deadline-session'
    currentGeneration = 7
    chatOrchestratorMock.cancelTurn.mockReturnValue(false)
    const store = useContextBridgeStore()
    await store.initialize()
    const streamSender = createTestChannel(CHAT_STREAM_CHANNEL_NAME)
    const deadlineAt = Date.now() + 30_000
    const context = {
      turnId: 'passive-deadline-turn',
      generation: 7,
      deadlineAt,
      sessionId: 'passive-deadline-session',
      promptContributions: [],
      message: { role: 'user', content: 'SENTINEL_PASSIVE_DEADLINE' },
      contexts: {},
      composedMessage: [],
      input: {
        type: 'input:text',
        source: 'plugin-module-host',
        metadata: createMetadata('discord', 'discord-1'),
        data: {
          text: 'SENTINEL_PASSIVE_DEADLINE',
          turn: {
            id: 'passive-deadline-turn',
            generation: 7,
            deadlineAt,
          },
          overrides: { sessionId: 'passive-deadline-session' },
        },
      },
    }

    try {
      streamSender.postMessage({
        type: 'before-compose',
        message: 'SENTINEL_PASSIVE_DEADLINE',
        sessionId: 'passive-deadline-session',
        context,
      })
      await waitForBroadcastDelivery()
      streamSender.postMessage({
        type: 'before-send',
        message: 'SENTINEL_PASSIVE_DEADLINE',
        sessionId: 'passive-deadline-session',
        context,
      })
      await vi.waitFor(() => {
        expect(beginStreamMock).toHaveBeenCalledTimes(1)
      })

      vi.spyOn(Date, 'now').mockReturnValue(deadlineAt + 1)
      streamSender.postMessage({
        type: 'token-literal',
        literal: 'LATE_DEADLINE_LITERAL_ONE',
        sessionId: 'passive-deadline-session',
        context,
      })
      await vi.waitFor(() => {
        expect(chatOrchestratorMock.emitTurnCancelledHooks).toHaveBeenCalledTimes(1)
      })
      streamSender.postMessage({
        type: 'token-literal',
        literal: 'LATE_DEADLINE_LITERAL_TWO',
        sessionId: 'passive-deadline-session',
        context,
      })
      await waitForBroadcastDelivery()

      // @example
      expect(chatOrchestratorMock.emitTurnCancelledHooks).toHaveBeenCalledWith(
        expect.objectContaining({ turnId: 'passive-deadline-turn' }),
        'deadline',
      )
      // @example
      expect(chatOrchestratorMock.emitTurnCancelledHooks).toHaveBeenCalledTimes(1)
      // @example
      expect(appendStreamLiteralMock).not.toHaveBeenCalled()
      const ledger = JSON.parse(globalThis.localStorage.getItem('airi:context-bridge:discord-turn-ledger:v2') ?? '[]') as unknown[]
      // @example
      expect(ledger).toEqual(expect.arrayContaining([
        expect.arrayContaining(['passive-deadline-turn', expect.any(Number), 'cancelled', 'deadline']),
      ]))
    }
    finally {
      await store.dispose()
    }
  })

  /**
   * @example
   * Shared cancellation observed before its broadcast callback still reaches passive hooks.
   */
  it('consumes shared cancellation before a late remote event for Discord audit D-011', async () => {
    // ROOT CAUSE:
    //
    // Another window can commit the shared cancellation ledger before its
    // BroadcastChannel lifecycle message is delivered. The remote stream watcher
    // previously noticed that tombstone, deleted the retained hook context, and
    // returned. When the lifecycle callback arrived it no longer had a context
    // with which to stop passive TTS.
    //
    // Observing a shared tombstone in any stream path must immediately execute the
    // same exact-turn cancellation fallback before rejecting the late event.
    activeSessionIdRef.value = 'passive-ledger-race-session'
    currentGeneration = 7
    chatOrchestratorMock.cancelTurn.mockReturnValue(false)
    const store = useContextBridgeStore()
    await store.initialize()
    const streamSender = createTestChannel(CHAT_STREAM_CHANNEL_NAME)
    const turnId = 'passive-ledger-race-turn'
    const deadlineAt = Date.now() + 30_000
    const context = {
      turnId,
      generation: 7,
      deadlineAt,
      sessionId: 'passive-ledger-race-session',
      promptContributions: [],
      message: { role: 'user', content: 'SENTINEL_LEDGER_RACE' },
      contexts: {},
      input: {
        type: 'input:text',
        source: 'plugin-module-host',
        metadata: createMetadata('discord', 'discord-1'),
        data: {
          text: 'SENTINEL_LEDGER_RACE',
          turn: {
            id: turnId,
            generation: 7,
            deadlineAt,
          },
          overrides: { sessionId: 'passive-ledger-race-session' },
        },
      },
    }

    try {
      streamSender.postMessage({
        type: 'before-compose',
        message: 'SENTINEL_LEDGER_RACE',
        sessionId: 'passive-ledger-race-session',
        context,
      })
      await waitForBroadcastDelivery()

      globalThis.localStorage.setItem('airi:context-bridge:discord-turn-ledger:v2', JSON.stringify([
        [turnId, Date.now() + 60_000, 'cancelled', 'deadline'],
      ]))
      streamSender.postMessage({
        type: 'before-send',
        message: 'LATE_SEND_MUST_CANCEL_FIRST',
        sessionId: 'passive-ledger-race-session',
        context: { ...context, composedMessage: [] },
      })

      await vi.waitFor(() => {
        expect(chatOrchestratorMock.emitTurnCancelledHooks).toHaveBeenCalledTimes(1)
      })
      // @example
      expect(beginStreamMock).not.toHaveBeenCalled()
    }
    finally {
      await store.dispose()
    }
  })

  /**
   * @example
   * Origin-window TTS remains cancellable after the provider turn has completed.
   */
  it('retains local Discord hook context after core completion for Discord audit D-011', async () => {
    // ROOT CAUSE:
    //
    // Only incoming remote stream events populated the cancellation context map.
    // In the provider-owning window, core-agent removes its active turn after the
    // response hooks complete, while queued TTS playback can still be running.
    // A later disconnect then made `cancelTurn()` return false and no cancellation
    // hook reached that surviving TTS session.
    //
    // The origin must retain the trusted hook context through the bounded deadline
    // even after assistant-end, then consume it exactly once on late cancellation.
    chatOrchestratorMock.cancelTurn.mockReturnValue(false)
    const store = useContextBridgeStore()
    await store.initialize()
    const deadlineAt = Date.now() + 30_000
    const context = {
      turnId: 'origin-completed-discord-turn',
      generation: 7,
      deadlineAt,
      sessionId: 'origin-discord-session',
      promptContributions: [],
      message: { role: 'user', content: 'SENTINEL_ORIGIN_TTS' },
      contexts: {},
      composedMessage: [],
      input: {
        type: 'input:text',
        source: 'plugin-module-host',
        metadata: createMetadata('discord', 'discord-1'),
        data: {
          text: 'SENTINEL_ORIGIN_TTS',
          turn: {
            id: 'origin-completed-discord-turn',
            generation: 7,
            deadlineAt,
          },
          overrides: { sessionId: 'origin-discord-session' },
        },
      },
    }

    try {
      await chatOrchestratorMock.emitBeforeMessageComposedHooks('SENTINEL_ORIGIN_TTS', context)
      await chatOrchestratorMock.emitAssistantResponseEndHooks('synthetic final answer', context)

      const cancelEvent = {
        type: 'chat:turn:cancel',
        metadata: createMetadata('discord', 'discord-1'),
        data: {
          cancelledAt: Date.now(),
          reason: 'disconnect',
          sessionId: 'origin-discord-session',
          turn: {
            id: 'origin-completed-discord-turn',
            generation: 7,
            deadlineAt,
          },
        },
      }
      await emitServerEvent('chat:turn:cancel', cancelEvent)
      await emitServerEvent('chat:turn:cancel', cancelEvent)

      // @example
      expect(chatOrchestratorMock.emitTurnCancelledHooks).toHaveBeenCalledTimes(1)
      // @example
      expect(chatOrchestratorMock.emitTurnCancelledHooks).toHaveBeenCalledWith(
        expect.objectContaining({ turnId: 'origin-completed-discord-turn' }),
        'reset',
      )
    }
    finally {
      await store.dispose()
    }
  })

  /**
   * @example
   * Passive-window TTS remains cancellable after mirrored assistant completion.
   */
  it('retains passive Discord hook context after assistant-end for Discord audit D-011', async () => {
    // ROOT CAUSE:
    //
    // The passive watcher deleted its exact-turn guard at stream-end or
    // assistant-end even though Stage TTS can keep queued playback after those
    // hooks. A later disconnect/reset therefore had no context with which to
    // cancel the surviving passive-window audio.
    //
    // Completion must release only mirrored UI stream ownership; the trusted
    // cancellation context remains until cancellation, disposal, or bounded expiry.
    activeSessionIdRef.value = 'passive-completed-session'
    currentGeneration = 7
    chatOrchestratorMock.cancelTurn.mockReturnValue(false)
    const store = useContextBridgeStore()
    await store.initialize()
    const streamSender = createTestChannel(CHAT_STREAM_CHANNEL_NAME)
    const deadlineAt = Date.now() + 30_000
    const context = {
      turnId: 'passive-completed-discord-turn',
      generation: 7,
      deadlineAt,
      sessionId: 'passive-completed-session',
      promptContributions: [],
      message: { role: 'user', content: 'SENTINEL_PASSIVE_TTS' },
      contexts: {},
      composedMessage: [],
      input: {
        type: 'input:text',
        source: 'plugin-module-host',
        metadata: createMetadata('discord', 'discord-1'),
        data: {
          text: 'SENTINEL_PASSIVE_TTS',
          turn: {
            id: 'passive-completed-discord-turn',
            generation: 7,
            deadlineAt,
          },
          overrides: { sessionId: 'passive-completed-session' },
        },
      },
    }

    try {
      streamSender.postMessage({
        type: 'before-compose',
        message: 'SENTINEL_PASSIVE_TTS',
        sessionId: 'passive-completed-session',
        context,
      })
      await waitForBroadcastDelivery()
      streamSender.postMessage({
        type: 'before-send',
        message: 'SENTINEL_PASSIVE_TTS',
        sessionId: 'passive-completed-session',
        context,
      })
      await vi.waitFor(() => {
        expect(beginStreamMock).toHaveBeenCalledTimes(1)
      })
      streamSender.postMessage({
        type: 'assistant-end',
        message: 'synthetic final answer',
        sessionId: 'passive-completed-session',
        context,
      })
      await vi.waitFor(() => {
        expect(resetStreamMock).toHaveBeenCalledTimes(1)
      })

      await emitServerEvent('chat:turn:cancel', {
        type: 'chat:turn:cancel',
        metadata: createMetadata('discord', 'discord-1'),
        data: {
          cancelledAt: Date.now(),
          reason: 'disconnect',
          sessionId: 'passive-completed-session',
          turn: {
            id: 'passive-completed-discord-turn',
            generation: 7,
            deadlineAt,
          },
        },
      })

      // @example
      expect(chatOrchestratorMock.emitTurnCancelledHooks).toHaveBeenCalledTimes(1)
      // @example
      expect(chatOrchestratorMock.emitTurnCancelledHooks).toHaveBeenCalledWith(
        expect.objectContaining({ turnId: 'passive-completed-discord-turn' }),
        'reset',
      )
    }
    finally {
      await store.dispose()
    }
  })

  /**
   * @example
   * Passive-window Discord hook contexts fail closed at their documented hard cap.
   */
  it('bounds retained passive-window contexts without evicting active turns for Discord audit D-011', async () => {
    // ROOT CAUSE:
    //
    // Remote stream ownership used an unbounded map once exact-turn guards were
    // introduced. Merely adding expiry was insufficient: a burst of unique
    // before-compose events could retain message contexts until all deadlines.
    //
    // The passive bridge retains at most the same 1,024-turn envelope as ingress,
    // rejects overflow before hooks run, and keeps already-active turn contexts
    // cancellable instead of evicting them.
    activeSessionIdRef.value = 'bounded-passive-session'
    currentGeneration = 7
    chatOrchestratorMock.cancelTurn.mockReturnValue(false)
    const store = useContextBridgeStore()
    await store.initialize()
    const streamSender = createTestChannel(CHAT_STREAM_CHANNEL_NAME)
    const observedBeforeCompose = vi.fn()
    beforeComposeHooks.push(observedBeforeCompose)
    const deadlineAt = Date.now() + 30_000

    try {
      for (let index = 0; index < 1_025; index += 1) {
        const turnId = `bounded-passive-turn-${index}`
        streamSender.postMessage({
          type: 'before-compose',
          message: `SENTINEL_BOUNDED_${index}`,
          sessionId: 'bounded-passive-session',
          context: {
            turnId,
            generation: 7,
            deadlineAt,
            sessionId: 'bounded-passive-session',
            promptContributions: [],
            message: { role: 'user', content: `SENTINEL_BOUNDED_${index}` },
            contexts: {},
            input: {
              type: 'input:text',
              source: 'plugin-module-host',
              metadata: createMetadata('discord', 'discord-1'),
              data: {
                text: `SENTINEL_BOUNDED_${index}`,
                turn: {
                  id: turnId,
                  generation: 7,
                  deadlineAt,
                },
                overrides: { sessionId: 'bounded-passive-session' },
              },
            },
          },
        })
      }

      await vi.waitFor(() => {
        expect(observedBeforeCompose).toHaveBeenCalledTimes(1_024)
      }, { timeout: 5_000 })
      await waitForBroadcastDelivery()

      // @example
      expect(observedBeforeCompose).toHaveBeenCalledTimes(1_024)

      await emitServerEvent('chat:turn:cancel', {
        type: 'chat:turn:cancel',
        metadata: createMetadata('discord', 'discord-1'),
        data: {
          cancelledAt: Date.now(),
          reason: 'deadline',
          sessionId: 'bounded-passive-session',
          turn: {
            id: 'bounded-passive-turn-1024',
            generation: 7,
            deadlineAt,
          },
        },
      })
      // @example
      expect(chatOrchestratorMock.emitTurnCancelledHooks).not.toHaveBeenCalled()

      await emitServerEvent('chat:turn:cancel', {
        type: 'chat:turn:cancel',
        metadata: createMetadata('discord', 'discord-1'),
        data: {
          cancelledAt: Date.now(),
          reason: 'deadline',
          sessionId: 'bounded-passive-session',
          turn: {
            id: 'bounded-passive-turn-0',
            generation: 7,
            deadlineAt,
          },
        },
      })
      // @example
      expect(chatOrchestratorMock.emitTurnCancelledHooks).toHaveBeenCalledTimes(1)
    }
    finally {
      await store.dispose()
    }
  })

  /**
   * @example
   * A provider-owning Discord turn is rejected before core/TTS when the retained-context cap is full.
   */
  it('fails closed before local ingestion when the Discord audit D-012 turn guard cap is full', async () => {
    // ROOT CAUSE:
    //
    // The guard cap rejected passive overflow before hooks ran, but the local
    // provider-owning hook ignored the same capacity result. Core and Stage TTS
    // could therefore start without retained cancellation context; after core
    // completion a disconnect found neither an active turn nor a guard to stop audio.
    //
    // The winning ingress window must reserve bounded cancellation context before
    // provider construction or core hooks, and return a safe overload reply when
    // no reservation is available.
    activeProviderRef.value = 'mock-provider'
    activeModelRef.value = 'mock-model'
    activeSessionIdRef.value = 'origin-cap-session'
    currentGeneration = 7
    getProviderInstanceMock.mockResolvedValue({})
    chatOrchestratorMock.ingest.mockResolvedValue(undefined)
    const store = useContextBridgeStore()
    await store.initialize()
    const streamSender = createTestChannel(CHAT_STREAM_CHANNEL_NAME)
    const observedBeforeCompose = vi.fn()
    beforeComposeHooks.push(observedBeforeCompose)
    const deadlineAt = Date.now() + 30_000

    try {
      for (let index = 0; index < 1_024; index += 1) {
        const turnId = `origin-cap-filler-${index}`
        streamSender.postMessage({
          type: 'before-compose',
          message: `SENTINEL_ORIGIN_CAP_FILLER_${index}`,
          sessionId: 'origin-cap-session',
          context: {
            turnId,
            generation: 7,
            deadlineAt,
            sessionId: 'origin-cap-session',
            promptContributions: [],
            message: { role: 'user', content: `SENTINEL_ORIGIN_CAP_FILLER_${index}` },
            contexts: {},
            input: {
              type: 'input:text',
              source: 'plugin-module-host',
              metadata: createMetadata('discord', 'discord-1'),
              data: {
                text: `SENTINEL_ORIGIN_CAP_FILLER_${index}`,
                turn: { id: turnId, generation: 7, deadlineAt },
                overrides: { sessionId: 'origin-cap-session' },
              },
            },
          },
        })
      }
      await vi.waitFor(() => {
        expect(observedBeforeCompose).toHaveBeenCalledTimes(1_024)
      }, { timeout: 5_000 })

      await emitServerEvent('input:text', {
        type: 'input:text',
        source: 'plugin-module-host',
        metadata: createMetadata('discord', 'discord-1'),
        data: {
          text: 'SENTINEL_ORIGIN_CAP_REJECTED',
          turn: {
            id: 'origin-cap-rejected-turn',
            generation: 1,
            deadlineAt,
          },
          overrides: { sessionId: 'origin-cap-session' },
          discord: {
            channelId: 'origin-cap-channel',
            guildMember: {
              id: 'origin-cap-user',
              displayName: 'Origin cap user',
              nickname: 'Origin cap user',
            },
          },
        },
      })

      // @example
      expect(getProviderInstanceMock).not.toHaveBeenCalled()
      // @example
      expect(chatOrchestratorMock.ingest).not.toHaveBeenCalled()
      // @example
      expect(serverSendMock).toHaveBeenCalledWith(expect.objectContaining({
        type: 'output:gen-ai:chat:message',
        data: expect.objectContaining({
          message: {
            role: 'assistant',
            content: 'AIRI is handling too many chat requests right now. Please retry after an earlier request finishes.',
          },
        }),
      }))
    }
    finally {
      await store.dispose()
    }
  })

  /**
   * @example
   * Discord input returns a status message when the local chat provider/model is not ready.
   */
  it('returns a Discord status reply instead of silently dropping input when no provider or model is selected', async () => {
    const store = useContextBridgeStore()
    await store.initialize()

    const inputEvent = {
      type: 'input:text',
      source: 'plugin-module-host',
      metadata: createMetadata('discord', 'discord-1'),
      data: {
        text: 'hello',
        turn: {
          id: 'discord-not-ready-turn-1',
          generation: 1,
          deadlineAt: Date.now() + 30_000,
        },
        overrides: {
          sessionId: 'discord-dm-user-1',
        },
        discord: {
          channelId: 'dm-channel',
          guildMember: {
            id: 'user-1',
            displayName: 'User 1',
            nickname: 'User 1',
          },
        },
      },
    }

    await emitServerEvent('input:text', inputEvent)

    expect(chatOrchestratorMock.ingest).not.toHaveBeenCalled()
    expect(serverSendMock).toHaveBeenCalledWith({
      type: 'output:gen-ai:chat:message',
      data: expect.objectContaining({
        'discord': inputEvent.data.discord,
        'message': expect.objectContaining({
          role: 'assistant',
          content: expect.stringContaining('local chat provider/model is not ready'),
        }),
        'gen-ai:chat': expect.objectContaining({
          input: {
            type: 'input:text',
            data: inputEvent.data,
          },
        }),
      }),
    })

    await store.dispose()
  })

  /**
   * @example
   * Broadcast context ingest failures record store-ingest-rejected instead of escaping.
   */
  it('records rejected lifecycle for broadcast ingest failures without interrupting the watcher', async () => {
    chatContextIngestMock.mockImplementationOnce(() => {
      throw new Error('Cannot clone broadcast context')
    })
    const store = useContextBridgeStore()
    await store.initialize()
    const contextSender = createTestChannel(CONTEXT_CHANNEL_NAME)

    contextSender.postMessage(createContextMessage({
      id: 'bad-broadcast-context',
      metadata: createMetadata('weather', 'station-1'),
      text: 'bad broadcast weather',
    }))

    await vi.waitFor(() => {
      expect(recordLifecycleMock).toHaveBeenCalledWith(expect.objectContaining({
        phase: 'store-ingest-rejected',
        channel: 'broadcast',
        contextId: 'bad-broadcast-context',
        details: expect.objectContaining({
          errorMessage: 'Cannot clone broadcast context',
        }),
      }))
    })

    await store.dispose()
  })

  /**
   * @example
   * Server context ingest failures are not rebroadcast.
   */
  it('records rejected lifecycle and skips broadcast when server context ingest fails', async () => {
    chatContextIngestMock.mockImplementationOnce(() => {
      throw new Error('Cannot clone server context')
    })
    const postedContexts = collectChannelMessages(CONTEXT_CHANNEL_NAME)
    const store = useContextBridgeStore()
    await store.initialize()

    await emitContextUpdate(createContextUpdateEvent({
      id: 'bad-server-context',
      text: 'bad server weather',
    }))
    await waitForBroadcastDelivery()

    expect(recordLifecycleMock).toHaveBeenCalledWith(expect.objectContaining({
      phase: 'store-ingest-rejected',
      channel: 'server',
      contextId: 'bad-server-context',
      details: expect.objectContaining({
        errorMessage: 'Cannot clone server context',
      }),
    }))
    expect(recordLifecycleMock).not.toHaveBeenCalledWith(expect.objectContaining({
      phase: 'broadcast-posted',
      contextId: 'bad-server-context',
    }))
    expect(postedContexts).toHaveLength(0)

    await store.dispose()
  })

  /**
   * @example
   * Input context ingest failures drop only the failed context update.
   */
  it('records rejected lifecycle and continues text ingestion when input context ingest fails', async () => {
    chatContextIngestMock.mockImplementationOnce(() => {
      throw new Error('Cannot clone input context')
    })
    activeProviderRef.value = 'mock-provider'
    activeModelRef.value = 'mock-model'
    getProviderInstanceMock.mockResolvedValueOnce({})
    const store = useContextBridgeStore()
    await store.initialize()

    await emitServerEvent('input:text', {
      type: 'input:text',
      source: 'plugin-module-host',
      metadata: createMetadata('weather', 'station-1'),
      data: {
        text: 'hello',
        contextUpdates: [
          {
            strategy: ContextUpdateStrategy.AppendSelf,
            text: 'bad input weather',
          },
        ],
      },
    })

    expect(recordLifecycleMock).toHaveBeenCalledWith(expect.objectContaining({
      phase: 'store-ingest-rejected',
      channel: 'input',
      details: expect.objectContaining({
        errorMessage: 'Cannot clone input context',
      }),
    }))
    expect(chatOrchestratorMock.ingest).toHaveBeenCalledTimes(1)
    expect(chatOrchestratorMock.ingest.mock.calls[0]?.[1]?.input?.data.contextUpdates).toEqual([])

    await store.dispose()
  })

  it('replays remote stream lifecycle into sending and stream store APIs', async () => {
    activeSessionIdRef.value = 'remote-session'
    const store = useContextBridgeStore()
    await store.initialize()
    const streamSender = createTestChannel(CHAT_STREAM_CHANNEL_NAME)

    const context = {
      turnId: 'remote-turn',
      generation: 7,
      sessionId: 'remote-session',
      promptContributions: [],
      message: { role: 'user', content: 'ping' },
      contexts: {},
      composedMessage: [],
    }

    streamSender.postMessage({ type: 'before-send', message: 'ping', sessionId: 'remote-session', context })
    await vi.waitFor(() => {
      expect(chatOrchestratorMock.sending).toBe(true)
      expect(beginStreamMock).toHaveBeenCalledTimes(1)
    })

    streamSender.postMessage({ type: 'token-literal', literal: 'hello', sessionId: 'remote-session', context })
    await vi.waitFor(() => {
      expect(appendStreamLiteralMock).toHaveBeenCalledWith('hello')
    })

    streamSender.postMessage({ type: 'assistant-end', message: 'final answer', sessionId: 'remote-session', context })
    await vi.waitFor(() => {
      expect(resetStreamMock).toHaveBeenCalledTimes(1)
    })

    // The bridge should call resetStream on follower tabs, not finalizeStream,
    // to avoid corrupting history by persisting a duplicate assistant message.
    expect(finalizeStreamMock).not.toHaveBeenCalled()
    expect(chatOrchestratorMock.sending).toBe(false)

    await store.dispose()
  })

  it('suppresses outbound broadcast while processing remote stream events', async () => {
    activeSessionIdRef.value = 'remote-session'
    const outgoingStreamMessages = collectChannelMessages<{ sessionId: string }>(CHAT_STREAM_CHANNEL_NAME)
    const store = useContextBridgeStore()
    await store.initialize()
    const streamSender = createTestChannel(CHAT_STREAM_CHANNEL_NAME)

    const context = {
      turnId: 'remote-special-turn',
      generation: 7,
      sessionId: 'remote-session',
      promptContributions: [],
      message: { role: 'user', content: 'ping' },
      contexts: {},
      composedMessage: [],
    }

    await chatOrchestratorMock.emitTokenSpecialHooks('manual-special', {
      ...context,
      turnId: 'manual-special-turn',
      sessionId: 'session-1',
    })
    await vi.waitFor(() => {
      expect(outgoingStreamMessages).toHaveLength(1)
    })

    streamSender.postMessage({ type: 'before-send', message: 'remote', sessionId: 'remote-session', context })
    await vi.waitFor(() => {
      expect(beginStreamMock).toHaveBeenCalledTimes(1)
    })
    streamSender.postMessage({ type: 'token-special', special: 'remote-special', sessionId: 'remote-session', context })
    await waitForBroadcastDelivery()

    expect(outgoingStreamMessages.filter(message => message.sessionId === 'session-1')).toHaveLength(1)

    await store.dispose()
  })

  it('ignores remote literal and end events when generation guard is stale', async () => {
    activeSessionIdRef.value = 'remote-session'
    const store = useContextBridgeStore()
    await store.initialize()
    const streamSender = createTestChannel(CHAT_STREAM_CHANNEL_NAME)

    const context = {
      turnId: 'remote-stale-turn',
      generation: 7,
      sessionId: 'remote-session',
      promptContributions: [],
      message: { role: 'user', content: 'ping' },
      contexts: {},
      composedMessage: [],
    }

    streamSender.postMessage({ type: 'before-send', message: 'ping', sessionId: 'remote-session', context })
    await vi.waitFor(() => {
      expect(beginStreamMock).toHaveBeenCalledTimes(1)
    })

    currentGeneration = 8
    streamSender.postMessage({ type: 'token-literal', literal: 'stale-literal', sessionId: 'remote-session', context })
    await waitForBroadcastDelivery()

    streamSender.postMessage({ type: 'stream-end', sessionId: 'remote-session', context })
    await waitForBroadcastDelivery()

    expect(appendStreamLiteralMock).not.toHaveBeenCalledWith('stale-literal')
    expect(finalizeStreamMock).not.toHaveBeenCalled()
    expect(chatOrchestratorMock.sending).toBe(true)

    await store.dispose()
  })

  /**
   * @example
   * A follower window mirrors only the correlated turn for its visible exact session.
   */
  it('isolates concurrent remote stream mirrors by exact turn for Discord audit D-011', async () => {
    // ROOT CAUSE:
    //
    // The follower used one global remoteStreamGuard and assigned every incoming
    // before-send event to its currently visible session. Concurrent session B
    // could therefore replace session A's guard and append B tokens into A's UI
    // and TTS hook stream.
    //
    // Remote mirroring must validate event.sessionId/generation and retain guard
    // identity by turnId; an unrelated session never starts or mutates that stream.
    activeSessionIdRef.value = 'session-a'
    currentGeneration = 7
    const store = useContextBridgeStore()
    await store.initialize()
    const streamSender = createTestChannel(CHAT_STREAM_CHANNEL_NAME)
    const contextA = {
      turnId: 'remote-turn-a',
      generation: 7,
      sessionId: 'session-a',
      promptContributions: [],
      message: { role: 'user', content: 'ping-a' },
      contexts: {},
      composedMessage: [],
    }
    const contextB = {
      ...contextA,
      turnId: 'remote-turn-b',
      sessionId: 'session-b',
      message: { role: 'user', content: 'ping-b' },
    }

    streamSender.postMessage({ type: 'before-send', message: 'ping-a', sessionId: 'session-a', context: contextA })
    await vi.waitFor(() => {
      expect(beginStreamMock).toHaveBeenCalledTimes(1)
    })
    streamSender.postMessage({ type: 'before-send', message: 'ping-b', sessionId: 'session-b', context: contextB })
    streamSender.postMessage({ type: 'token-literal', literal: 'B_MUST_NOT_MIRROR', sessionId: 'session-b', context: contextB })
    streamSender.postMessage({ type: 'token-literal', literal: 'A_VISIBLE', sessionId: 'session-a', context: contextA })
    await waitForBroadcastDelivery()

    // @example
    expect(beginStreamMock).toHaveBeenCalledTimes(1)
    // @example
    expect(appendStreamLiteralMock).toHaveBeenCalledWith('A_VISIBLE')
    // @example
    expect(appendStreamLiteralMock).not.toHaveBeenCalledWith('B_MUST_NOT_MIRROR')

    await store.dispose()
  })
})
