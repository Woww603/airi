import type { DiscordBridgeRuntimeConfig } from './airi-adapter'
import type { SafeDiscordTextPayload } from './discordSend'

import { Client as ServerChannel } from '@proj-airi/server-sdk'
import { Client as DiscordClient, MessageReferenceType, MessageType } from 'discord.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { VoiceManager } from '../bots/discord/commands'
import { DiscordAdapter } from './airi-adapter'

interface SyntheticAiriEvent {
  data: Record<string, unknown>
}

type SyntheticAiriHandler = (event: SyntheticAiriEvent) => Promise<unknown> | unknown

type SyntheticDiscordHandler = (...args: unknown[]) => Promise<unknown> | unknown

interface SyntheticTextOverrides {
  sendPrivacyNotice?: (payload: SafeDiscordTextPayload, abortSignal?: AbortSignal) => Promise<unknown> | unknown
  sendTyping?: () => Promise<unknown> | unknown
}

vi.mock('@proj-airi/server-sdk', () => {
  function MockServerChannel(config: { onReady?: () => void }) {
    const airiHandlers = new Map<string, SyntheticAiriHandler>()
    const sentEvents: Array<{ type: string, data: Record<string, unknown> }> = []
    return {
      airiHandlers,
      close: vi.fn(),
      config,
      onEvent: vi.fn((type: string, callback: SyntheticAiriHandler) => {
        airiHandlers.set(type, callback)
        return () => airiHandlers.delete(type)
      }),
      send: vi.fn((event: { type: string, data: Record<string, unknown> }) => {
        sentEvents.push(event)
        return true
      }),
      sentEvents,
    }
  }

  return { Client: vi.fn(MockServerChannel) }
})

vi.mock('discord.js', () => {
  function MockDiscordClient() {
    const channelSend = vi.fn(async (_payload?: unknown) => {})
    const discordHandlers = new Map<string, SyntheticDiscordHandler>()
    const client = {
      channelSend,
      channels: {
        fetch: vi.fn(async () => ({
          isTextBased: () => true,
          send: channelSend,
        })),
      },
      destroy: vi.fn(async () => {
        client.ready = false
      }),
      discordHandlers,
      isReady: vi.fn(() => client.ready),
      login: vi.fn(async () => {
        client.ready = true
      }),
      on: vi.fn((type: string, callback: SyntheticDiscordHandler) => {
        discordHandlers.set(type, callback)
        return client
      }),
      once: vi.fn((type: string, callback: SyntheticDiscordHandler) => {
        discordHandlers.set(type, callback)
        return client
      }),
      ready: false,
      removeAllListeners: vi.fn((type: string) => {
        discordHandlers.delete(type)
        return client
      }),
      users: { fetch: vi.fn() },
    }
    return client
  }

  return {
    Client: vi.fn(MockDiscordClient),
    Events: {
      ClientReady: 'client-ready',
      InteractionCreate: 'interaction-create',
      MessageCreate: 'message-create',
      Raw: 'raw',
      ShardDisconnect: 'shard-disconnect',
      ShardReady: 'shard-ready',
      VoiceStateUpdate: 'voice-state-update',
    },
    GatewayIntentBits: {
      DirectMessages: 1,
      GuildMessages: 2,
      GuildVoiceStates: 4,
      Guilds: 8,
      MessageContent: 16,
    },
    MessageReferenceType: {
      Default: 0,
      Forward: 1,
    },
    MessageType: {
      ChannelFollowAdd: 12,
      Default: 0,
      Reply: 19,
    },
    Partials: {
      Channel: 1,
      Message: 2,
      User: 3,
    },
  }
})

vi.mock('../bots/discord/commands', () => {
  function MockVoiceManager() {
    return {
      handleConsentInteraction: vi.fn(),
      handleJoinChannelCommand: vi.fn(),
      handleLeaveChannelCommand: vi.fn(),
      handleVoiceStateUpdate: vi.fn(async () => {}),
      revalidateSpeakerAdmissions: vi.fn(),
      stop: vi.fn(async () => {}),
    }
  }

  return {
    handlePing: vi.fn(),
    registerCommands: vi.fn(),
    VoiceManager: vi.fn(MockVoiceManager),
  }
})

vi.mock('../pipelines/openai-speech', () => ({
  describeOpenAICompatibleProvider: vi.fn(() => 'synthetic speech provider'),
  transcribeOpenAICompatible: vi.fn(),
}))

function currentServerChannel() {
  const result = vi.mocked(ServerChannel).mock.results.at(-1)
  if (!result || result.type !== 'return')
    throw new Error('Expected DiscordAdapter to construct the AIRI server channel.')
  return result.value
}

function currentDiscordClient() {
  const result = vi.mocked(DiscordClient).mock.results.at(-1)
  if (!result || result.type !== 'return')
    throw new Error('Expected DiscordAdapter to construct the Discord client.')
  return result.value
}

function currentVoiceManager() {
  const result = vi.mocked(VoiceManager).mock.results.at(-1)
  if (!result || result.type !== 'return')
    throw new Error('Expected DiscordAdapter to construct the voice manager.')
  return result.value
}

const turnMocks = {
  get airiReady(): (() => void) | undefined {
    return Reflect.get(currentServerChannel(), 'config').onReady
  },
  get airiHandlers(): Map<string, SyntheticAiriHandler> {
    return Reflect.get(currentServerChannel(), 'airiHandlers')
  },
  get channelFetch() {
    return vi.mocked(currentDiscordClient().channels.fetch)
  },
  get channelSend(): ReturnType<typeof vi.fn> {
    return Reflect.get(currentDiscordClient(), 'channelSend')
  },
  get close() {
    return vi.mocked(currentServerChannel().close)
  },
  get destroy() {
    return vi.mocked(currentDiscordClient().destroy)
  },
  get discordHandlers(): Map<string, SyntheticDiscordHandler> {
    return Reflect.get(currentDiscordClient(), 'discordHandlers')
  },
  get login() {
    return vi.mocked(currentDiscordClient().login)
  },
  get sentEvents(): Array<{ type: string, data: Record<string, unknown> }> {
    return Reflect.get(currentServerChannel(), 'sentEvents')
  },
  get voiceStateUpdate() {
    return vi.mocked(currentVoiceManager().handleVoiceStateUpdate)
  },
  get voiceStop() {
    return vi.mocked(currentVoiceManager().stop)
  },
}

function handleText(
  adapter: DiscordAdapter,
  content: string,
  abortSignal?: AbortSignal,
  overrides: SyntheticTextOverrides = {},
) {
  return Reflect.apply(Reflect.get(adapter, 'handleDiscordTextInput'), adapter, [{
    abortSignal,
    channelId: 'synthetic-channel',
    content,
    directMessage: false,
    displayName: 'Synthetic user',
    guildId: 'synthetic-guild',
    guildName: 'Synthetic guild',
    nickname: 'Synthetic user',
    rawContent: content,
    userId: 'synthetic-user',
    ...overrides,
  }]) as Promise<void>
}

function inputEvents() {
  return turnMocks.sentEvents.filter(event => event.type === 'input:text')
}

function cancellationEvents() {
  return turnMocks.sentEvents.filter(event => event.type === 'chat:turn:cancel')
}

async function createAdapter(overrides: Partial<DiscordBridgeRuntimeConfig> = {}) {
  const adapter = new DiscordAdapter({})
  await adapter.applyRuntimeConfig({
    enabled: false,
    globalRateLimitMaxMessages: 1_000,
    guildRateLimitMaxMessages: 1_000,
    messagePacingMs: 0,
    privacyNoticeEnabled: false,
    rateLimitMaxMessages: 100,
    userRateLimitMaxMessages: 1_000,
    ...overrides,
  })
  return adapter
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(1_000)
  vi.clearAllMocks()
})

/**
 * @example
 * describe('Discord turn correlation lifecycle', () => {})
 */
describe('discord turn correlation lifecycle', () => {
  /**
   * @example
   * it('routes only fetched replies to the current bot for Discord audit D-023', async () => {})
   */
  it('routes only fetched replies to the current bot for Discord audit D-023', async () => {
    const adapter = new DiscordAdapter({
      discordToken: 'synthetic-discord-token',
    })
    turnMocks.airiReady?.()
    await adapter.applyRuntimeConfig({
      allowedChannelIds: ['allowed-channel'],
      enabled: true,
      messagePacingMs: 0,
      privacyNoticeEnabled: false,
    })
    Reflect.set(Reflect.get(adapter, 'discordClient'), 'user', { id: 'bot-1' })
    const messageCreate = turnMocks.discordHandlers.get('message-create')
    if (!messageCreate)
      throw new Error('Expected the Discord MessageCreate handler.')
    const message = (
      id: string,
      channelId: string,
      fetchReferencedAuthorId: () => Promise<string>,
    ) => ({
      author: { bot: false, id: 'user-1', username: 'Synthetic user' },
      channel: {
        isTextBased: () => true,
        send: turnMocks.channelSend,
        sendTyping: vi.fn(async () => {}),
      },
      channelId,
      content: 'synthetic reply without ping',
      fetchReference: async () => ({ author: { id: await fetchReferencedAuthorId() } }),
      guild: { name: 'Synthetic guild' },
      guildId: 'guild-1',
      id,
      member: { displayName: 'Synthetic user', nickname: 'Synthetic user' },
      mentions: {
        has: () => false,
        repliedUser: { id: 'bot-1' },
      },
      reference: { messageId: `reference-${id}`, type: MessageReferenceType.Default },
      type: MessageType.Reply,
    })

    // ROOT CAUSE:
    //
    // Bridge admitted guild text only when Discord populated an explicit mention.
    // Reply ping can be disabled, so a genuine reply to AIRI was silently ignored.
    // The fix must fetch the referenced author, fail closed on forged metadata, and
    // then re-enter the same canonical allowlist/rate/session policy as a mention.
    await messageCreate(message('message-bot', 'allowed-channel', async () => 'bot-1'))
    /** @example expect(inputEvents()).toHaveLength(1) */
    expect(inputEvents()).toHaveLength(1)

    const mentionedReferenceFetch = vi.fn(async () => 'bot-1')
    const mentionedMessage = message('message-mentioned-reply', 'allowed-channel', mentionedReferenceFetch)
    mentionedMessage.content = '<@bot-1> synthetic mentioned reply'
    mentionedMessage.mentions.has = () => true
    await messageCreate(mentionedMessage)
    /** @example expect(mentionedReferenceFetch).not.toHaveBeenCalled() */
    expect(mentionedReferenceFetch).not.toHaveBeenCalled()
    /** @example expect(inputEvents()).toHaveLength(2) */
    expect(inputEvents()).toHaveLength(2)

    await messageCreate(message('message-forged', 'allowed-channel', async () => 'user-2'))
    /** @example expect(inputEvents()).toHaveLength(2) */
    expect(inputEvents()).toHaveLength(2)

    await messageCreate(message('message-blocked', 'blocked-channel', async () => 'bot-1'))
    /** @example expect(inputEvents()).toHaveLength(2) */
    expect(inputEvents()).toHaveLength(2)

    let releaseReference = (_authorId: string) => {}
    const pendingReference = new Promise<string>((resolve) => {
      releaseReference = resolve
    })
    const fetchPendingReference = vi.fn(() => pendingReference)
    const pendingMessage = messageCreate(message(
      'message-stale',
      'allowed-channel',
      fetchPendingReference,
    ))
    await vi.waitFor(() => {
      /** @example expect(fetchPendingReference).toHaveBeenCalledOnce() */
      expect(fetchPendingReference).toHaveBeenCalledOnce()
    })
    const disabling = adapter.applyRuntimeConfig({ enabled: false })
    releaseReference('bot-1')
    await Promise.all([pendingMessage, disabling])
    /** @example expect(inputEvents()).toHaveLength(2) */
    expect(inputEvents()).toHaveLength(2)

    await adapter.stop()
  })

  /**
   * @example
   * it('serializes reply admission with mentions per exact session for Discord audit D-023', async () => {})
   */
  it('serializes reply admission with mentions per exact session for Discord audit D-023', async () => {
    const adapter = new DiscordAdapter({ discordToken: 'synthetic-discord-token' })
    turnMocks.airiReady?.()
    await adapter.applyRuntimeConfig({
      allowedChannelIds: ['allowed-channel'],
      enabled: true,
      globalRateLimitMaxMessages: 100,
      guildRateLimitMaxMessages: 100,
      messagePacingMs: 0,
      privacyNoticeEnabled: false,
      rateLimitMaxMessages: 100,
      userRateLimitMaxMessages: 100,
    })
    Reflect.set(Reflect.get(adapter, 'discordClient'), 'user', { id: 'bot-1' })
    const messageCreate = turnMocks.discordHandlers.get('message-create')
    if (!messageCreate)
      throw new Error('Expected the Discord MessageCreate handler.')

    let releaseReference = (_authorId: string) => {}
    const fetchFirstReference = vi.fn(() => new Promise<string>((resolve) => {
      releaseReference = resolve
    }))
    const message = (id: string, userId: string, content: string, mentioned: boolean, fetchAuthorId?: () => Promise<string>) => ({
      author: { bot: false, id: userId, username: `Synthetic ${userId}` },
      channel: {
        isTextBased: () => true,
        send: turnMocks.channelSend,
        sendTyping: vi.fn(async () => {}),
      },
      channelId: 'allowed-channel',
      content: mentioned ? `<@bot-1> ${content}` : content,
      fetchReference: async () => ({ author: { id: await fetchAuthorId?.() } }),
      guild: { name: 'Synthetic guild' },
      guildId: 'guild-1',
      id,
      member: { displayName: `Synthetic ${userId}`, nickname: `Synthetic ${userId}` },
      mentions: { has: () => mentioned },
      reference: mentioned ? undefined : { messageId: `reference-${id}`, type: MessageReferenceType.Default },
      type: mentioned ? MessageType.Default : MessageType.Reply,
    })

    // ROOT CAUSE:
    //
    // MessageCreate awaited authoritative reply lookup before entering the
    // existing exact-session ingress tail. A later mention therefore reached
    // Stage before an earlier reply from the same user, while unrelated users
    // should remain concurrent.
    const first = Promise.resolve(messageCreate(message('a1', 'user-a', 'SENTINEL_A1', false, fetchFirstReference)))
    await vi.waitFor(() => {
      /** @example expect(fetchFirstReference).toHaveBeenCalledOnce() */
      expect(fetchFirstReference).toHaveBeenCalledOnce()
    })
    const second = Promise.resolve(messageCreate(message('a2', 'user-a', 'SENTINEL_A2', true)))
    const otherSession = Promise.resolve(messageCreate(message('b1', 'user-b', 'SENTINEL_B1', true)))
    await otherSession

    const beforeRelease = inputEvents()
    /** @example expect(beforeRelease.map(event => event.data.text)).toEqual(['SENTINEL_B1']) */
    expect(beforeRelease.map(event => event.data.text)).toEqual(['SENTINEL_B1'])

    releaseReference('bot-1')
    await Promise.all([first, second])
    const userAInputs = inputEvents().filter((event) => {
      const discord = event.data.discord
      return typeof discord === 'object'
        && discord !== null
        && Reflect.get(Reflect.get(discord, 'guildMember') ?? {}, 'id') === 'user-a'
    })
    /** @example expect(userAInputs.map(event => event.data.text)).toEqual(['SENTINEL_A1', 'SENTINEL_A2']) */
    expect(userAInputs.map(event => event.data.text)).toEqual(['SENTINEL_A1', 'SENTINEL_A2'])

    await adapter.stop()
  })

  /**
   * @example
   * it('rejects blocked reply candidates before fetching for Discord audit D-023', async () => {})
   */
  it('rejects blocked reply candidates before fetching for Discord audit D-023', async () => {
    const adapter = new DiscordAdapter({ discordToken: 'synthetic-discord-token' })
    turnMocks.airiReady?.()
    await adapter.applyRuntimeConfig({
      allowedChannelIds: ['allowed-channel'],
      enabled: true,
      messagePacingMs: 0,
      privacyNoticeEnabled: false,
    })
    Reflect.set(Reflect.get(adapter, 'discordClient'), 'user', { id: 'bot-1' })
    const messageCreate = turnMocks.discordHandlers.get('message-create')
    if (!messageCreate)
      throw new Error('Expected the Discord MessageCreate handler.')
    const fetchReference = vi.fn(async () => ({ author: { id: 'bot-1' } }))

    // ROOT CAUSE:
    //
    // Reply resolution ran before the static channel allowlist. A blocked
    // channel could therefore consume Discord REST capacity even though it was
    // ineligible for rate, privacy, Stage, or provider admission.
    await messageCreate({
      author: { bot: false, id: 'blocked-user', username: 'Blocked synthetic user' },
      channel: { isTextBased: () => true, send: turnMocks.channelSend },
      channelId: 'blocked-channel',
      content: 'SENTINEL_BLOCKED_REPLY',
      fetchReference,
      guild: { name: 'Synthetic guild' },
      guildId: 'guild-1',
      id: 'blocked-message',
      member: { displayName: 'Blocked synthetic user', nickname: 'Blocked synthetic user' },
      mentions: { has: () => false },
      reference: { messageId: 'blocked-reference', type: MessageReferenceType.Default },
      type: MessageType.Reply,
    })

    /** @example expect(fetchReference).not.toHaveBeenCalled() */
    expect(fetchReference).not.toHaveBeenCalled()
    const forwardedFetch = vi.fn(async () => ({ author: { id: 'bot-1' } }))
    await messageCreate({
      author: { bot: false, id: 'allowed-user', username: 'Allowed synthetic user' },
      channel: { isTextBased: () => true, send: turnMocks.channelSend },
      channelId: 'allowed-channel',
      content: 'SENTINEL_FORWARDED_MESSAGE',
      fetchReference: forwardedFetch,
      guild: { name: 'Synthetic guild' },
      guildId: 'guild-1',
      id: 'forwarded-message',
      member: { displayName: 'Allowed synthetic user', nickname: 'Allowed synthetic user' },
      mentions: { has: () => false },
      reference: { messageId: 'forwarded-reference', type: MessageReferenceType.Forward },
      type: MessageType.Reply,
    })
    const crosspostFetch = vi.fn(async () => ({ author: { id: 'bot-1' } }))
    await messageCreate({
      author: { bot: false, id: 'allowed-user', username: 'Allowed synthetic user' },
      channel: { isTextBased: () => true, send: turnMocks.channelSend },
      channelId: 'allowed-channel',
      content: 'SENTINEL_CROSSPOST_MESSAGE',
      fetchReference: crosspostFetch,
      guild: { name: 'Synthetic guild' },
      guildId: 'guild-1',
      id: 'crosspost-message',
      member: { displayName: 'Allowed synthetic user', nickname: 'Allowed synthetic user' },
      mentions: { has: () => false },
      reference: { messageId: 'crosspost-reference', type: MessageReferenceType.Default },
      type: MessageType.ChannelFollowAdd,
    })
    /** @example expect(forwardedFetch).not.toHaveBeenCalled() */
    expect(forwardedFetch).not.toHaveBeenCalled()
    /** @example expect(crosspostFetch).not.toHaveBeenCalled() */
    expect(crosspostFetch).not.toHaveBeenCalled()
    /** @example expect(inputEvents()).toHaveLength(0) */
    expect(inputEvents()).toHaveLength(0)
    await adapter.stop()
  })

  /**
   * @example
   * it('bounds exact-session reply envelopes and recovers capacity for Discord audit D-023', async () => {})
   */
  it('bounds exact-session reply envelopes and recovers capacity for Discord audit D-023', async () => {
    const adapter = new DiscordAdapter({ discordToken: 'synthetic-discord-token' })
    turnMocks.airiReady?.()
    await adapter.applyRuntimeConfig({
      allowedChannelIds: ['allowed-channel'],
      enabled: true,
      globalRateLimitMaxMessages: 100,
      guildRateLimitMaxMessages: 100,
      messagePacingMs: 0,
      privacyNoticeEnabled: false,
      rateLimitMaxMessages: 100,
      userRateLimitMaxMessages: 100,
    })
    Reflect.set(Reflect.get(adapter, 'discordClient'), 'user', { id: 'bot-1' })
    const audit = vi.fn()
    Reflect.set(adapter, 'audit', audit)
    const messageCreate = turnMocks.discordHandlers.get('message-create')
    if (!messageCreate)
      throw new Error('Expected the Discord MessageCreate handler.')

    let releaseFirstReference = (_authorId: string) => {}
    const fetches = Array.from({ length: 9 }, (_, index) => index === 0
      ? vi.fn(() => new Promise<string>((resolve) => {
          releaseFirstReference = resolve
        }))
      : vi.fn(async () => 'other-bot'))
    const reply = (index: number) => ({
      author: { bot: false, id: 'user-a', username: 'Synthetic user A' },
      channel: { isTextBased: () => true, send: turnMocks.channelSend },
      channelId: 'allowed-channel',
      content: `SENTINEL_CAP_${index}`,
      fetchReference: async () => ({ author: { id: await fetches[index]?.() } }),
      guild: { name: 'Synthetic guild' },
      guildId: 'guild-1',
      id: `capacity-${index}`,
      member: { displayName: 'Synthetic user A', nickname: 'Synthetic user A' },
      mentions: { has: () => false },
      reference: { messageId: `reference-${index}`, type: MessageReferenceType.Default },
      type: MessageType.Reply,
    })

    // ROOT CAUSE:
    //
    // Moving reference lookup into FIFO without a separate envelope bound would
    // let one deferred reference accumulate unlimited mention/reply candidates.
    // The scheduler counts active plus waiting envelopes and rejects before a
    // ninth reference fetch, then releases ownership by identity on settlement.
    const first = Promise.resolve(messageCreate(reply(0)))
    await vi.waitFor(() => {
      /** @example expect(fetches[0]).toHaveBeenCalledOnce() */
      expect(fetches[0]).toHaveBeenCalledOnce()
    })
    const retained = Array.from({ length: 7 }, (_, index) => Promise.resolve(messageCreate(reply(index + 1))))
    await Promise.resolve()
    await messageCreate(reply(8))

    /** @example expect(fetches[8]).not.toHaveBeenCalled() */
    expect(fetches[8]).not.toHaveBeenCalled()
    /** @example expect(Reflect.get(adapter, 'discordIngressScheduler')).toHaveProperty('pendingCount', 8) */
    expect(Reflect.get(adapter, 'discordIngressScheduler')).toHaveProperty('pendingCount', 8)
    /** @example expect(audit).toHaveBeenCalledWith('input-rejected', expect.objectContaining({ reason: 'session-capacity' })) */
    expect(audit).toHaveBeenCalledWith('input-rejected', expect.objectContaining({ reason: 'session-capacity' }))

    releaseFirstReference('other-bot')
    await Promise.all([first, ...retained])
    /** @example expect(inputEvents()).toHaveLength(0) */
    expect(inputEvents()).toHaveLength(0)

    await messageCreate({
      ...reply(8),
      content: '<@bot-1> SENTINEL_CAP_RECOVERY',
      id: 'capacity-recovery',
      mentions: { has: () => true },
      reference: undefined,
      type: MessageType.Default,
    })
    /** @example expect(inputEvents()).toHaveLength(1) */
    expect(inputEvents()).toHaveLength(1)
    /** @example expect(Reflect.get(adapter, 'discordIngressScheduler')).toHaveProperty('pendingCount', 0) */
    expect(Reflect.get(adapter, 'discordIngressScheduler')).toHaveProperty('pendingCount', 0)
    await adapter.stop()
  })

  /**
   * @example
   * it('drains retained reply envelopes on stop for Discord audit D-023', async () => {})
   */
  it('drains retained reply envelopes on stop for Discord audit D-023', async () => {
    const adapter = new DiscordAdapter({ discordToken: 'synthetic-discord-token' })
    turnMocks.airiReady?.()
    await adapter.applyRuntimeConfig({
      allowedChannelIds: ['allowed-channel'],
      enabled: true,
      messagePacingMs: 0,
      privacyNoticeEnabled: false,
    })
    Reflect.set(Reflect.get(adapter, 'discordClient'), 'user', { id: 'bot-1' })
    const messageCreate = turnMocks.discordHandlers.get('message-create')
    if (!messageCreate)
      throw new Error('Expected the Discord MessageCreate handler.')
    let releaseReference = (_authorId: string) => {}
    const fetchReference = vi.fn(() => new Promise<{ author: { id: string } }>((resolve) => {
      releaseReference = authorId => resolve({ author: { id: authorId } })
    }))
    const message = (id: string, mentioned: boolean) => ({
      author: { bot: false, id: 'user-a', username: 'Synthetic user A' },
      channel: { isTextBased: () => true, send: turnMocks.channelSend },
      channelId: 'allowed-channel',
      content: mentioned ? '<@bot-1> SENTINEL_QUEUED_MENTION' : 'SENTINEL_PENDING_REPLY',
      fetchReference,
      guild: { name: 'Synthetic guild' },
      guildId: 'guild-1',
      id,
      member: { displayName: 'Synthetic user A', nickname: 'Synthetic user A' },
      mentions: { has: () => mentioned },
      reference: mentioned ? undefined : { messageId: 'reference-pending', type: MessageReferenceType.Default },
      type: mentioned ? MessageType.Default : MessageType.Reply,
    })

    // ROOT CAUSE:
    //
    // A stopped adapter could release its local reference waiter while leaving
    // the exact-session envelope tail retained. A queued mention could then run
    // after shutdown, or stop could report completion with scheduler ownership.
    const first = Promise.resolve(messageCreate(message('stop-reply', false)))
    await vi.waitFor(() => {
      /** @example expect(fetchReference).toHaveBeenCalledOnce() */
      expect(fetchReference).toHaveBeenCalledOnce()
    })
    const second = Promise.resolve(messageCreate(message('stop-mention', true)))
    /** @example expect(Reflect.get(adapter, 'discordIngressScheduler')).toHaveProperty('pendingCount', 2) */
    expect(Reflect.get(adapter, 'discordIngressScheduler')).toHaveProperty('pendingCount', 2)

    const stopping = adapter.stop()
    await Promise.all([first, second, stopping])
    /** @example expect(Reflect.get(adapter, 'discordIngressScheduler')).toHaveProperty('pendingCount', 0) */
    expect(Reflect.get(adapter, 'discordIngressScheduler')).toHaveProperty('pendingCount', 0)
    /** @example expect(inputEvents()).toHaveLength(0) */
    expect(inputEvents()).toHaveLength(0)

    releaseReference('bot-1')
    await vi.advanceTimersByTimeAsync(0)
    /** @example expect(inputEvents()).toHaveLength(0) */
    expect(inputEvents()).toHaveLength(0)
  })

  /**
   * @example
   * it('includes envelope waiting in the absolute deadline for Discord audit D-011 and D-023', async () => {})
   */
  it('includes envelope waiting in the absolute deadline for Discord audit D-011 and D-023', async () => {
    const adapter = await createAdapter({
      messagePacingMs: 1_000,
      privacyNoticeEnabled: false,
    })
    let releaseTyping = () => {}
    const sendTyping = vi.fn(() => new Promise<void>((resolve) => {
      releaseTyping = resolve
    }))

    // ROOT CAUSE:
    //
    // The inner turn was allocated only after the new admission envelope reached
    // the head of its session. That restarted the 45-second clock after queue or
    // reference waiting, allowing stale text to reach Stage well past ingress.
    // The absolute deadline is now captured before scheduling and may only be
    // shortened by an upstream voice deadline.
    const first = handleText(adapter, 'SENTINEL_DEADLINE_A1', undefined, { sendTyping })
    await vi.waitFor(() => {
      /** @example expect(sendTyping).toHaveBeenCalledOnce() */
      expect(sendTyping).toHaveBeenCalledOnce()
    })
    const second = handleText(adapter, 'SENTINEL_DEADLINE_A2')
    /** @example expect(Reflect.get(adapter, 'discordIngressScheduler')).toHaveProperty('pendingCount', 2) */
    expect(Reflect.get(adapter, 'discordIngressScheduler')).toHaveProperty('pendingCount', 2)
    /** @example expect(Reflect.get(adapter, 'pendingDiscordTurnsById')).toHaveProperty('size', 1) */
    expect(Reflect.get(adapter, 'pendingDiscordTurnsById')).toHaveProperty('size', 1)

    await vi.advanceTimersByTimeAsync(45_000)
    await Promise.all([first, second])

    /** @example expect(inputEvents()).toHaveLength(0) */
    expect(inputEvents()).toHaveLength(0)
    /** @example expect(Reflect.get(adapter, 'pendingDiscordTurnsById')).toHaveProperty('size', 0) */
    expect(Reflect.get(adapter, 'pendingDiscordTurnsById')).toHaveProperty('size', 0)
    /** @example expect(Reflect.get(adapter, 'discordIngressScheduler')).toHaveProperty('pendingCount', 0) */
    expect(Reflect.get(adapter, 'discordIngressScheduler')).toHaveProperty('pendingCount', 0)

    releaseTyping()
    await vi.advanceTimersByTimeAsync(0)
    await adapter.stop()
    /** @example expect(vi.getTimerCount()).toBe(0) */
    expect(vi.getTimerCount()).toBe(0)
  })

  /**
   * @example
   * it('bounds queued reply lookup by the original ingress deadline for Discord audit D-023', async () => {})
   */
  it('bounds queued reply lookup by the original ingress deadline for Discord audit D-023', async () => {
    const adapter = new DiscordAdapter({ discordToken: 'synthetic-discord-token' })
    turnMocks.airiReady?.()
    await adapter.applyRuntimeConfig({
      allowedChannelIds: ['allowed-channel'],
      enabled: true,
      globalRateLimitMaxMessages: 100,
      guildRateLimitMaxMessages: 100,
      messagePacingMs: 1_000,
      privacyNoticeEnabled: false,
      rateLimitMaxMessages: 2,
      rateLimitWindowMs: 60_000,
      userRateLimitMaxMessages: 100,
    })
    Reflect.set(Reflect.get(adapter, 'discordClient'), 'user', { id: 'bot-1' })
    const audit = vi.fn()
    Reflect.set(adapter, 'audit', audit)
    const messageCreate = turnMocks.discordHandlers.get('message-create')
    if (!messageCreate)
      throw new Error('Expected the Discord MessageCreate handler.')
    let releaseTyping = () => {}
    const blockedTyping = vi.fn(() => new Promise<void>((resolve) => {
      releaseTyping = resolve
    }))
    let releaseReference = (_authorId: string) => {}
    const fetchReference = vi.fn(() => new Promise<{ author: { id: string } }>((resolve) => {
      releaseReference = authorId => resolve({ author: { id: authorId } })
    }))
    const message = (
      id: string,
      content: string,
      mentioned: boolean,
      sendTyping: () => Promise<unknown> | unknown,
    ) => ({
      author: { bot: false, id: 'user-a', username: 'Synthetic user A' },
      channel: { isTextBased: () => true, send: turnMocks.channelSend, sendTyping },
      channelId: 'allowed-channel',
      content: mentioned ? `<@bot-1> ${content}` : content,
      fetchReference,
      guild: { name: 'Synthetic guild' },
      guildId: 'guild-1',
      id,
      member: { displayName: 'Synthetic user A', nickname: 'Synthetic user A' },
      mentions: { has: () => mentioned },
      reference: mentioned ? undefined : { messageId: `reference-${id}`, type: MessageReferenceType.Default },
      type: mentioned ? MessageType.Default : MessageType.Reply,
    })

    // ROOT CAUSE:
    //
    // The queue captured an absolute 45-second budget, but authoritative reply
    // lookup created a fresh five-second timeout when it finally reached the
    // head. A reply starting near expiry could therefore retain REST work beyond
    // ingress deadline and could consume rate quota despite never owning a turn.
    const first = Promise.resolve(messageCreate(message('deadline-a1', 'SENTINEL_DEADLINE_A1', true, blockedTyping)))
    await vi.advanceTimersByTimeAsync(0)
    /** @example expect(blockedTyping).toHaveBeenCalledOnce() */
    expect(blockedTyping).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(100)
    const second = Promise.resolve(messageCreate(message('deadline-a2', 'SENTINEL_DEADLINE_A2', false, vi.fn(async () => {}))))

    await vi.advanceTimersByTimeAsync(42_900)
    releaseTyping()
    await vi.advanceTimersByTimeAsync(1_000)
    await first
    /** @example expect(fetchReference).toHaveBeenCalledOnce() */
    expect(fetchReference).toHaveBeenCalledOnce()

    await vi.advanceTimersByTimeAsync(1_100)
    await second
    /** @example expect(audit).toHaveBeenCalledWith('reply-reference-resolved', expect.objectContaining({ reason: 'timeout' })) */
    expect(audit).toHaveBeenCalledWith('reply-reference-resolved', expect.objectContaining({ reason: 'timeout' }))
    releaseReference('bot-1')
    await vi.advanceTimersByTimeAsync(0)

    const recovery = Promise.resolve(messageCreate(message(
      'deadline-recovery',
      'SENTINEL_DEADLINE_RECOVERY',
      true,
      vi.fn(async () => {}),
    )))
    await vi.advanceTimersByTimeAsync(1_000)
    await recovery
    /** @example expect(inputEvents().map(event => event.data.text)).toEqual(['SENTINEL_DEADLINE_A1', 'SENTINEL_DEADLINE_RECOVERY']) */
    expect(inputEvents().map(event => event.data.text)).toEqual([
      'SENTINEL_DEADLINE_A1',
      'SENTINEL_DEADLINE_RECOVERY',
    ])
    /** @example expect(Reflect.get(adapter, 'discordIngressScheduler')).toHaveProperty('pendingCount', 0) */
    expect(Reflect.get(adapter, 'discordIngressScheduler')).toHaveProperty('pendingCount', 0)
    await adapter.stop()
  })

  /**
   * @example
   * it('owns timeout and late-output gates by exact turn for Discord audit D-011', async () => {})
   */
  it('owns timeout and late-output gates by exact turn for Discord audit D-011', async () => {
    // ROOT CAUSE:
    //
    // The bridge stored one timeout per session and emitted no stable turn
    // correlation. A newer same-session input cleared the older timeout, while
    // any later provider output could clear the newer timer and reply to Discord.
    //
    // Before: A2 replaced A1's timer and a late A1 output was still delivered.
    // After: every accepted input owns an independent id/generation/deadline;
    // timeout, completion, and late-output rejection claim only that exact turn.
    const adapter = await createAdapter()

    await handleText(adapter, 'SENTINEL_A1')
    const firstInput = inputEvents()[0]
    const firstTurn = firstInput?.data.turn as { id: string, generation: number, deadlineAt: number }

    await vi.advanceTimersByTimeAsync(10_000)
    await handleText(adapter, 'SENTINEL_A2')
    const secondInput = inputEvents()[1]
    const secondTurn = secondInput?.data.turn as { id: string, generation: number, deadlineAt: number }

    /** @example expect(firstTurn.id).not.toBe(secondTurn.id) */
    expect(firstTurn.id).not.toBe(secondTurn.id)
    /** @example expect(firstTurn.generation).toBe(1) */
    expect(firstTurn.generation).toBe(1)
    /** @example expect(secondTurn.generation).toBe(2) */
    expect(secondTurn.generation).toBe(2)
    /** @example expect(secondTurn.deadlineAt - firstTurn.deadlineAt).toBe(10_000) */
    expect(secondTurn.deadlineAt - firstTurn.deadlineAt).toBe(10_000)

    await vi.advanceTimersByTimeAsync(35_000)

    /** @example expect(cancellationEvents()).toEqual([ expect.objectContaining({ data: expect.objectContaining({ reason: 'deadline', turn: firstTurn, }), }), ]) */
    expect(cancellationEvents()).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({
          reason: 'deadline',
          turn: firstTurn,
        }),
      }),
    ])
    /** @example expect(turnMocks.channelSend).toHaveBeenCalledTimes(1) */
    expect(turnMocks.channelSend).toHaveBeenCalledTimes(1)
    /** @example expect(turnMocks.channelSend).toHaveBeenLastCalledWith(expect.objectContaining({ content: expect.stringContaining('did not come back in time'), })) */
    expect(turnMocks.channelSend).toHaveBeenLastCalledWith(expect.objectContaining({
      content: expect.stringContaining('did not come back in time'),
    }))

    await turnMocks.airiHandlers.get('output:gen-ai:chat:message')?.({
      data: {
        discord: firstInput?.data.discord,
        message: { content: 'SENTINEL_LATE_A1_OUTPUT' },
        turn: firstTurn,
      },
    })
    /** @example expect(turnMocks.channelSend).toHaveBeenCalledTimes(1) */
    expect(turnMocks.channelSend).toHaveBeenCalledTimes(1)

    await turnMocks.airiHandlers.get('output:gen-ai:chat:message')?.({
      data: {
        discord: secondInput?.data.discord,
        message: { content: 'SENTINEL_A2_OUTPUT' },
        turn: secondTurn,
      },
    })
    /** @example expect(turnMocks.channelSend).toHaveBeenCalledTimes(2) */
    expect(turnMocks.channelSend).toHaveBeenCalledTimes(2)
    /** @example expect(turnMocks.channelSend.mock.calls.flat()).not.toEqual(expect.arrayContaining([ expect.objectContaining({ content: 'SENTINEL_LATE_A1_OUTPUT' }), ])) */
    expect(turnMocks.channelSend.mock.calls.flat()).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ content: 'SENTINEL_LATE_A1_OUTPUT' }),
    ]))
    /** @example expect(turnMocks.channelSend).toHaveBeenLastCalledWith(expect.objectContaining({ content: 'SENTINEL_A2_OUTPUT' })) */
    expect(turnMocks.channelSend).toHaveBeenLastCalledWith(expect.objectContaining({ content: 'SENTINEL_A2_OUTPUT' }))

    await vi.advanceTimersByTimeAsync(10_001)
    /** @example expect(turnMocks.channelSend).toHaveBeenCalledTimes(2) */
    expect(turnMocks.channelSend).toHaveBeenCalledTimes(2)

    await adapter.stop()
  })

  /**
   * @example
   * it('fails closed at the per-session pending cap for Discord audit D-011', async () => {})
   */
  it('fails closed at the per-session pending cap for Discord audit D-011', async () => {
    // ROOT CAUSE:
    //
    // The Discord adapter had no hard bound on accepted responses awaiting
    // correlation. A disconnected Stage consumer could make attacker-controlled
    // sessions retain timers and reply routes without a queue admission limit.
    //
    // Before: every input was forwarded and retained until its timeout.
    // After: the ninth waiting turn in one exact session fails closed with a
    // content-free status while the eight already admitted turns remain intact.
    const adapter = await createAdapter()

    for (let index = 0; index < 9; index += 1)
      await handleText(adapter, `SENTINEL_QUEUE_${index}`)

    /** @example expect(inputEvents()).toHaveLength(8) */
    expect(inputEvents()).toHaveLength(8)
    /** @example expect(turnMocks.channelSend).toHaveBeenCalledTimes(1) */
    expect(turnMocks.channelSend).toHaveBeenCalledTimes(1)
    /** @example expect(turnMocks.channelSend).toHaveBeenLastCalledWith(expect.objectContaining({ content: expect.stringContaining('too many pending Discord messages'), })) */
    expect(turnMocks.channelSend).toHaveBeenLastCalledWith(expect.objectContaining({
      content: expect.stringContaining('too many pending Discord messages'),
    }))
    /** @example expect(turnMocks.channelSend).not.toHaveBeenLastCalledWith(expect.objectContaining({ content: expect.stringContaining('SENTINEL_QUEUE_8'), })) */
    expect(turnMocks.channelSend).not.toHaveBeenLastCalledWith(expect.objectContaining({
      content: expect.stringContaining('SENTINEL_QUEUE_8'),
    }))
    /** @example expect(Reflect.get(adapter, 'pendingDiscordTurnsById')).toHaveProperty('size', 8) */
    expect(Reflect.get(adapter, 'pendingDiscordTurnsById')).toHaveProperty('size', 8)

    await adapter.stop()
  })

  /**
   * @example
   * it('cancels active turns on abort and stop for Discord audit D-011', async () => {})
   */
  it('cancels active turns on abort and stop for Discord audit D-011', async () => {
    // ROOT CAUSE:
    //
    // Move, disconnect, consent withdrawal, disable, and adapter stop only
    // cleared local timers. Stage/provider work continued and could emit late
    // history, memory, sync, voice, or Discord reply side effects.
    //
    // Before: no cancellation crossed the server-channel boundary.
    // After: source abort cancels its exact turn and stop invalidates every
    // remaining turn before local correlation state is destroyed.
    const adapter = await createAdapter()
    const abortController = new AbortController()

    await handleText(adapter, 'SENTINEL_ABORTED', abortController.signal)
    await handleText(adapter, 'SENTINEL_STOPPED')
    const [abortedInput, stoppedInput] = inputEvents()

    abortController.abort()
    /** @example expect(cancellationEvents()).toEqual([ expect.objectContaining({ data: expect.objectContaining({ reason: 'reset', turn: abortedInput?.data.turn, }), }), ]) */
    expect(cancellationEvents()).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({
          reason: 'reset',
          turn: abortedInput?.data.turn,
        }),
      }),
    ])

    await adapter.stop()
    /** @example expect(cancellationEvents()).toEqual(expect.arrayContaining([ expect.objectContaining({ data: expect.objectContaining({ reason: 'disconnect', turn: stoppedInput?.data.turn, }), }), ])) */
    expect(cancellationEvents()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        data: expect.objectContaining({
          reason: 'disconnect',
          turn: stoppedInput?.data.turn,
        }),
      }),
    ]))
    /** @example expect(Reflect.get(adapter, 'pendingDiscordTurnsById')).toHaveProperty('size', 0) */
    expect(Reflect.get(adapter, 'pendingDiscordTurnsById')).toHaveProperty('size', 0)
  })

  /**
   * @example
   * it('finishes disable cleanup when cancellation delivery throws for Discord audit D-011', async () => {})
   */
  it('finishes disable cleanup when cancellation delivery throws for Discord audit D-011', async () => {
    // ROOT CAUSE:
    //
    // Exact-turn cleanup called the server-channel cancellation transport before
    // removing the turn and clearing its deadline timer. If that synchronous send
    // threw, the cancellation loop stopped at the first turn, bounded maps stayed
    // populated, and the immediate disable path never reached voice/Discord cleanup.
    //
    // Before: the first failed cancellation retained both pending turns and made
    // applyRuntimeConfig throw before it could stop voice or destroy Discord.
    // After: every exact turn is taken in a finally boundary, all bounded state is
    // cleared, disable completes every cleanup boundary, then rejects observably.
    const adapter = new DiscordAdapter({ discordToken: 'synthetic-discord-bot-token' })
    await adapter.applyRuntimeConfig({
      enabled: true,
      globalRateLimitMaxMessages: 1_000,
      guildRateLimitMaxMessages: 1_000,
      messagePacingMs: 0,
      privacyNoticeEnabled: false,
      rateLimitMaxMessages: 100,
      userRateLimitMaxMessages: 1_000,
    })
    await handleText(adapter, 'SENTINEL_CANCELLATION_FAILURE_A')
    await handleText(adapter, 'SENTINEL_CANCELLATION_FAILURE_B')

    const cancellationFailure = new Error('synthetic cancellation transport failure')
    const cancellationSend = vi.fn((event: { type: string }) => {
      if (event.type === 'chat:turn:cancel')
        throw cancellationFailure
      return true
    })
    Reflect.set(Reflect.get(adapter, 'airiClient'), 'send', cancellationSend)

    /** @example await expect(adapter.applyRuntimeConfig({ enabled: false })).rejects.toThrow(cancellationFailure) */
    await expect(adapter.applyRuntimeConfig({ enabled: false })).rejects.toThrow(cancellationFailure)

    /** @example expect(cancellationSend).toHaveBeenCalledTimes(2) */
    expect(cancellationSend).toHaveBeenCalledTimes(2)
    /** @example expect(Reflect.get(adapter, 'pendingDiscordTurnsById')).toHaveProperty('size', 0) */
    expect(Reflect.get(adapter, 'pendingDiscordTurnsById')).toHaveProperty('size', 0)
    /** @example expect(Reflect.get(adapter, 'pendingDiscordTurnIdsBySessionId')).toHaveProperty('size', 0) */
    expect(Reflect.get(adapter, 'pendingDiscordTurnIdsBySessionId')).toHaveProperty('size', 0)
    /** @example expect(Reflect.get(adapter, 'rateLimitBuckets')).toHaveProperty('size', 0) */
    expect(Reflect.get(adapter, 'rateLimitBuckets')).toHaveProperty('size', 0)
    /** @example expect(Reflect.get(adapter, 'layeredRateLimitBuckets')).toHaveProperty('size', 0) */
    expect(Reflect.get(adapter, 'layeredRateLimitBuckets')).toHaveProperty('size', 0)
    /** @example expect(Reflect.get(adapter, 'replyTargetsBySessionId')).toHaveProperty('size', 0) */
    expect(Reflect.get(adapter, 'replyTargetsBySessionId')).toHaveProperty('size', 0)
    /** @example expect(turnMocks.voiceStop).toHaveBeenCalledTimes(1) */
    expect(turnMocks.voiceStop).toHaveBeenCalledTimes(1)
    /** @example expect(turnMocks.destroy).toHaveBeenCalledTimes(1) */
    expect(turnMocks.destroy).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(45_000)
    /** @example expect(cancellationSend).toHaveBeenCalledTimes(2) */
    expect(cancellationSend).toHaveBeenCalledTimes(2)
  })

  /**
   * @example
   * it('finishes bounded cleanup after memory-command cancellation throws for Discord audit D-016', async () => {})
   */
  it('finishes bounded cleanup after memory-command cancellation throws for Discord audit D-016', async () => {
    const adapter = new DiscordAdapter({ discordToken: 'synthetic-discord-bot-token' })
    await adapter.applyRuntimeConfig({
      enabled: true,
      globalRateLimitMaxMessages: 1_000,
      guildRateLimitMaxMessages: 1_000,
      messagePacingMs: 0,
      privacyNoticeEnabled: false,
      rateLimitMaxMessages: 100,
      userRateLimitMaxMessages: 1_000,
    })
    await handleText(adapter, 'SENTINEL_MEMORY_CLEANUP_FAILURE')
    const originalClearMemory = Reflect.get(adapter, 'clearPendingMemoryCommands')
    const memoryCleanupFailure = new Error('synthetic memory cleanup failure')
    Reflect.set(adapter, 'clearPendingMemoryCommands', vi.fn(() => {
      throw memoryCleanupFailure
    }))

    // ROOT CAUSE:
    //
    // `clearPendingMemoryCommands` ran outside the bounded-state cleanup guard.
    // One rejection callback throwing therefore skipped exact turn cancellation,
    // deadline disposal, and every long-lived map clear. Cleanup now records the
    // first error, completes every owned boundary, then rethrows it.
    /** @example expect(() => Reflect.apply(Reflect.get(adapter, 'clearBoundedRuntimeState'), adapter, ['disconnect'])) */
    expect(() => Reflect.apply(Reflect.get(adapter, 'clearBoundedRuntimeState'), adapter, ['disconnect']))
      .toThrow(memoryCleanupFailure)
    /** @example expect(cancellationEvents()).toHaveLength(1) */
    expect(cancellationEvents()).toHaveLength(1)
    /** @example expect(Reflect.get(adapter, 'pendingDiscordTurnsById')).toHaveProperty('size', 0) */
    expect(Reflect.get(adapter, 'pendingDiscordTurnsById')).toHaveProperty('size', 0)
    /** @example expect(Reflect.get(adapter, 'pendingDiscordTurnIdsBySessionId')).toHaveProperty('size', 0) */
    expect(Reflect.get(adapter, 'pendingDiscordTurnIdsBySessionId')).toHaveProperty('size', 0)
    /** @example expect(Reflect.get(adapter, 'discordIngressScheduler')).toHaveProperty('pendingCount', 0) */
    expect(Reflect.get(adapter, 'discordIngressScheduler')).toHaveProperty('pendingCount', 0)
    /** @example expect(Reflect.get(adapter, 'replyTargetsBySessionId')).toHaveProperty('size', 0) */
    expect(Reflect.get(adapter, 'replyTargetsBySessionId')).toHaveProperty('size', 0)
    /** @example expect(vi.getTimerCount()).toBe(0) */
    expect(vi.getTimerCount()).toBe(0)

    Reflect.set(adapter, 'clearPendingMemoryCommands', originalClearMemory)
    await adapter.stop()
  })

  /**
   * @example
   * it('observes shard-disconnect voice cleanup after synchronous cleanup failure for Discord audit D-016', async () => {})
   */
  it('observes shard-disconnect voice cleanup after synchronous cleanup failure for Discord audit D-016', async () => {
    let releaseVoiceStop = () => {}
    const voiceStop = new Promise<void>((resolve) => {
      releaseVoiceStop = resolve
    })
    const adapter = new DiscordAdapter({})
    turnMocks.voiceStop.mockImplementation(() => voiceStop)
    Reflect.set(adapter, 'runtimePolicyEnabled', true)
    const memoryCleanupFailure = new Error('synthetic shard memory cleanup failure')
    Reflect.set(adapter, 'clearPendingMemoryCommands', vi.fn(() => {
      throw memoryCleanupFailure
    }))
    const shardDisconnect = turnMocks.discordHandlers.get('shard-disconnect')
    if (!shardDisconnect)
      throw new Error('Expected synthetic shard-disconnect handler.')

    // ROOT CAUSE:
    //
    // Discord EventEmitter invoked bounded cleanup synchronously before voice
    // stop. A cleanup exception escaped `emit`, skipped voice teardown, and left
    // no promise for adapter stop to observe. The adapter now owns one tracked
    // shard cleanup task and records its first error after voice stop settles.
    /** @example expect(() => shardDisconnect()).not.toThrow() */
    expect(() => shardDisconnect()).not.toThrow()
    /** @example expect(turnMocks.voiceStop).toHaveBeenCalledOnce() */
    expect(turnMocks.voiceStop).toHaveBeenCalledOnce()

    let stopOutcome: 'pending' | 'rejected' | 'resolved' | 'unexpected' = 'pending'
    const stopping = adapter.stop().then(
      () => {
        stopOutcome = 'resolved'
      },
      (error: unknown) => {
        stopOutcome = error === memoryCleanupFailure ? 'rejected' : 'unexpected'
      },
    )
    await Promise.resolve()
    await Promise.resolve()

    /** @example expect(stopOutcome).toBe('pending') */
    expect(stopOutcome).toBe('pending')
    releaseVoiceStop()
    await stopping
    /** @example expect(stopOutcome).toBe('rejected') */
    expect(stopOutcome).toBe('rejected')
    /** @example expect(turnMocks.destroy).toHaveBeenCalledOnce() */
    expect(turnMocks.destroy).toHaveBeenCalledOnce()
    /** @example expect(turnMocks.close).toHaveBeenCalledOnce() */
    expect(turnMocks.close).toHaveBeenCalledOnce()
  })

  /**
   * @example
   * it('completes missing-token teardown and propagates the first error for Discord audit D-016', async () => {})
   */
  it('completes missing-token teardown and propagates the first error for Discord audit D-016', async () => {
    const cleanupOrder: string[] = []
    const memoryCleanupFailure = new Error('synthetic missing-token memory cleanup failure')
    const adapter = new DiscordAdapter({})
    Reflect.set(Reflect.get(adapter, 'discordClient'), 'ready', true)
    Reflect.set(adapter, 'clearPendingMemoryCommands', vi.fn(() => {
      cleanupOrder.push('clear')
      throw memoryCleanupFailure
    }))
    turnMocks.voiceStop.mockImplementationOnce(async () => {
      cleanupOrder.push('voice')
      throw new Error('synthetic secondary voice cleanup failure')
    })
    turnMocks.destroy.mockImplementationOnce(async () => {
      cleanupOrder.push('destroy')
    })

    // ROOT CAUSE:
    //
    // The enabled-without-token branch awaited teardown in one linear chain.
    // Any early cleanup failure skipped voice stop and Discord destroy, obscuring
    // the first owner error behind leaked lifecycle state. It now attempts every
    // teardown boundary in order and propagates the first failure observably.
    /** @example await expect(adapter.applyRuntimeConfig({ enabled: true })).rejects.toBe(memoryCleanupFailure) */
    await expect(adapter.applyRuntimeConfig({ enabled: true })).rejects.toBe(memoryCleanupFailure)
    /** @example expect(cleanupOrder).toEqual(['clear', 'voice', 'destroy']) */
    expect(cleanupOrder).toEqual(['clear', 'voice', 'destroy'])
    /** @example expect(turnMocks.voiceStop).toHaveBeenCalledOnce() */
    expect(turnMocks.voiceStop).toHaveBeenCalledOnce()
    /** @example expect(turnMocks.destroy).toHaveBeenCalledOnce() */
    expect(turnMocks.destroy).toHaveBeenCalledOnce()

    Reflect.set(adapter, 'clearPendingMemoryCommands', vi.fn())
    turnMocks.voiceStop.mockResolvedValue(undefined)
    // The serialized config task retains its observable first failure until stop joins it.
    /** @example await expect(adapter.stop()).rejects.toBe(memoryCleanupFailure) */
    await expect(adapter.stop()).rejects.toBe(memoryCleanupFailure)
  })

  /**
   * @example
   * it('drains a superseded disable before re-enabling ingress for Discord audit D-018', async () => {})
   */
  it('drains a superseded disable before re-enabling ingress for Discord audit D-018', async () => {
    const adapter = new DiscordAdapter({ discordToken: 'synthetic-discord-bot-token' })
    turnMocks.airiReady?.()
    await adapter.applyRuntimeConfig({ enabled: true })
    turnMocks.destroy.mockClear()
    turnMocks.login.mockClear()
    turnMocks.voiceStop.mockClear()
    let releaseVoiceStop = () => {}
    turnMocks.voiceStop.mockImplementationOnce(() => new Promise<void>((resolve) => {
      releaseVoiceStop = resolve
    }))
    let enableSettled = false

    const disabling = adapter.applyRuntimeConfig({ enabled: false })
    const enabling = adapter.applyRuntimeConfig({ enabled: true }).then(() => {
      enableSettled = true
    })
    await vi.advanceTimersByTimeAsync(0)
    const voiceStopCallsBeforeRelease = turnMocks.voiceStop.mock.calls.length
    const enableSettledBeforeRelease = enableSettled

    // ROOT CAUSE:
    //
    // A newer config generation made the queued disable task return before voice
    // stop and Discord destroy. The subsequent enable reopened ingress while the
    // old classic generation remained alive. Serialized disable teardown must
    // drain first; only then may the newer enable login and admit new work.
    releaseVoiceStop()
    await Promise.all([disabling, enabling])

    /** @example expect(voiceStopCallsBeforeRelease).toBe(1) */
    expect(voiceStopCallsBeforeRelease).toBe(1)
    /** @example expect(enableSettledBeforeRelease).toBe(false) */
    expect(enableSettledBeforeRelease).toBe(false)
    /** @example expect(turnMocks.destroy).toHaveBeenCalledOnce() */
    expect(turnMocks.destroy).toHaveBeenCalledOnce()
    /** @example expect(turnMocks.login).toHaveBeenCalledOnce() */
    expect(turnMocks.login).toHaveBeenCalledOnce()
    /** @example expect(Reflect.get(adapter, 'discordIngressEnabled')).toBe(true) */
    expect(Reflect.get(adapter, 'discordIngressEnabled')).toBe(true)

    turnMocks.voiceStop.mockResolvedValue(undefined)
    await adapter.stop()
  })

  /**
   * @example
   * it('recovers only after a successful explicit teardown for Discord audit D-018', async () => {})
   */
  it('recovers only after a successful explicit teardown for Discord audit D-018', async () => {
    const adapter = new DiscordAdapter({ discordToken: 'synthetic-discord-bot-token' })
    turnMocks.airiReady?.()
    await adapter.applyRuntimeConfig({ enabled: true })
    const disconnectFailure = new Error('synthetic disconnect cleanup failure')
    turnMocks.voiceStop.mockRejectedValueOnce(disconnectFailure)
    turnMocks.discordHandlers.get('shard-disconnect')?.()
    await vi.waitFor(() => {
      /** @example expect(Reflect.get(adapter, 'disconnectCleanupTask')).toBeUndefined() */
      expect(Reflect.get(adapter, 'disconnectCleanupTask')).toBeUndefined()
      /** @example expect(Reflect.get(adapter, 'disconnectCleanupFailed')).toBe(true) */
      expect(Reflect.get(adapter, 'disconnectCleanupFailed')).toBe(true)
    })

    let ingressAfterFailedDisable = true
    let latchAfterSuccessfulDisable = true
    let ingressAfterRecovery = false
    try {
      const disableFailure = new Error('synthetic explicit teardown failure')
      turnMocks.voiceStop.mockRejectedValueOnce(disableFailure)
      /** @example await expect(adapter.applyRuntimeConfig({ enabled: false })).rejects.toBe(disableFailure) */
      await expect(adapter.applyRuntimeConfig({ enabled: false })).rejects.toBe(disableFailure)
      /** @example await expect(adapter.applyRuntimeConfig({ enabled: true })).rejects.toThrow('cleanup must complete') */
      await expect(adapter.applyRuntimeConfig({ enabled: true })).rejects.toThrow('cleanup must complete')
      ingressAfterFailedDisable = Reflect.get(adapter, 'discordIngressEnabled')

      // ROOT CAUSE:
      //
      // A failed disconnect must fail closed, but the failure latch previously
      // had no recovery owner. Conversely, clearing it on any enable would allow
      // an old voice generation to revive after failed teardown. Only a later
      // explicit disable that drains all cleanup successfully may clear the latch.
      await adapter.applyRuntimeConfig({ enabled: false })
      latchAfterSuccessfulDisable = Reflect.get(adapter, 'disconnectCleanupFailed')
      await adapter.applyRuntimeConfig({ enabled: true })
      ingressAfterRecovery = Reflect.get(adapter, 'discordIngressEnabled')
    }
    finally {
      await adapter.stop()
    }

    /** @example expect(ingressAfterFailedDisable).toBe(false) */
    expect(ingressAfterFailedDisable).toBe(false)
    /** @example expect(latchAfterSuccessfulDisable).toBe(false) */
    expect(latchAfterSuccessfulDisable).toBe(false)
    /** @example expect(ingressAfterRecovery).toBe(true) */
    expect(ingressAfterRecovery).toBe(true)
  })

  /**
   * @example
   * it('observes VoiceStateUpdate cleanup rejection at the EventEmitter boundary for Discord audit D-016', async () => {})
   */
  it('observes VoiceStateUpdate cleanup rejection at the EventEmitter boundary for Discord audit D-016', async () => {
    const adapter = new DiscordAdapter({})
    Reflect.set(adapter, 'discordIngressEnabled', true)
    turnMocks.voiceStateUpdate.mockRejectedValueOnce(new Error('synthetic voice-state cleanup failure'))
    const voiceStateUpdate = turnMocks.discordHandlers.get('voice-state-update')
    if (!voiceStateUpdate)
      throw new Error('Expected synthetic voice-state-update handler.')

    // ROOT CAUSE:
    //
    // Discord EventEmitter does not observe promises returned by async listeners.
    // A rejected generation cleanup therefore became process-global. The handler
    // now owns the promise, records a sanitized error category, and returns void.
    const listenerResult = voiceStateUpdate({}, {})
    if (listenerResult instanceof Promise)
      void listenerResult.catch(() => {})
    await Promise.resolve()
    await Promise.resolve()

    /** @example expect(listenerResult).toBeUndefined() */
    expect(listenerResult).toBeUndefined()
    /** @example expect(turnMocks.voiceStateUpdate).toHaveBeenCalledOnce() */
    expect(turnMocks.voiceStateUpdate).toHaveBeenCalledOnce()
    await adapter.stop()
  })

  /**
   * @example
   * it('gates a claimed output across asynchronous target resolution for Discord audit D-011', async () => {})
   */
  it('gates a claimed output across asynchronous target resolution for Discord audit D-011', async () => {
    // ROOT CAUSE:
    //
    // The output handler removed correlation state before awaiting channels.fetch.
    // Once removed, stop/disable/deadline could no longer find or invalidate that
    // delivery, so releasing the deferred fetch still sent the stale response.
    //
    // Correlation ownership must remain registered through target resolution and
    // every send await, with stop aborting that exact delivery before side effects.
    const adapter = await createAdapter()
    await handleText(adapter, 'SENTINEL_OUTPUT_FETCH_RACE')
    const input = inputEvents()[0]

    const staleTarget = await turnMocks.channelFetch('synthetic-output-target')
    if (!staleTarget)
      throw new Error('Expected the production Discord channel boundary to return a target.')
    turnMocks.channelFetch.mockClear()
    let releaseTarget: ((target: typeof staleTarget) => void) | undefined
    turnMocks.channelFetch.mockImplementationOnce(() => new Promise((resolve) => {
      releaseTarget = resolve
    }))
    const outputDelivery = turnMocks.airiHandlers.get('output:gen-ai:chat:message')?.({
      data: {
        discord: input?.data.discord,
        message: { content: 'SENTINEL_STALE_OUTPUT' },
        turn: input?.data.turn,
      },
    })

    await vi.waitFor(() => {
      /** @example expect(turnMocks.channelFetch).toHaveBeenCalledTimes(1) */
      expect(turnMocks.channelFetch).toHaveBeenCalledTimes(1)
    })
    await adapter.stop()
    releaseTarget?.(staleTarget)
    await outputDelivery

    /** @example expect(turnMocks.channelSend).not.toHaveBeenCalledWith(expect.objectContaining({ content: 'SENTINEL_STALE_OUTPUT', })) */
    expect(turnMocks.channelSend).not.toHaveBeenCalledWith(expect.objectContaining({
      content: 'SENTINEL_STALE_OUTPUT',
    }))
  })

  /**
   * @example
   * it('reserves and serializes preprocessing from ingress for Discord audit D-011', async () => {})
   */
  it('reserves and serializes preprocessing from ingress for Discord audit D-011', async () => {
    // ROOT CAUSE:
    //
    // Turn allocation happened after asynchronous typing and privacy work. A2
    // could therefore reach AIRI before an earlier A1 in the same exact session,
    // and concurrent preprocessing could bypass the external queue reservation.
    //
    // Before: releasing A2's privacy work first forwarded A2 before A1.
    // After: both turns are reserved synchronously at ingress and preprocessing
    // is an exact-session FIFO whose waiting entries count toward the hard cap.
    const adapter = await createAdapter({ privacyNoticeEnabled: true })
    let releaseFirstNotice: (() => void) | undefined
    const firstNotice = vi.fn(() => new Promise<void>((resolve) => {
      releaseFirstNotice = resolve
    }))
    const secondNotice = vi.fn(async () => {})

    const firstHandling = handleText(adapter, 'SENTINEL_PREPROCESS_A1', undefined, {
      sendPrivacyNotice: firstNotice,
    })
    await vi.waitFor(() => {
      /** @example expect(firstNotice).toHaveBeenCalledTimes(1) */
      expect(firstNotice).toHaveBeenCalledTimes(1)
    })
    const secondHandling = handleText(adapter, 'SENTINEL_PREPROCESS_A2', undefined, {
      sendPrivacyNotice: secondNotice,
    })
    await Promise.resolve()

    /** @example expect(inputEvents()).toHaveLength(0) */
    expect(inputEvents()).toHaveLength(0)
    /** @example expect(secondNotice).not.toHaveBeenCalled() */
    expect(secondNotice).not.toHaveBeenCalled()
    /** @example expect(Reflect.get(adapter, 'discordIngressScheduler')).toHaveProperty('pendingCount', 2) */
    expect(Reflect.get(adapter, 'discordIngressScheduler')).toHaveProperty('pendingCount', 2)
    /** @example expect(Reflect.get(adapter, 'pendingDiscordTurnsById')).toHaveProperty('size', 1) */
    expect(Reflect.get(adapter, 'pendingDiscordTurnsById')).toHaveProperty('size', 1)

    releaseFirstNotice?.()
    await Promise.all([firstHandling, secondHandling])

    /** @example expect(inputEvents().map(event => event.data.text)).toEqual([ 'SENTINEL_PREPROCESS_A1', 'SENTINEL_PREPROCESS_A2', ]) */
    expect(inputEvents().map(event => event.data.text)).toEqual([
      'SENTINEL_PREPROCESS_A1',
      'SENTINEL_PREPROCESS_A2',
    ])

    await adapter.stop()
  })

  /**
   * @example
   * it('starts the deadline before deferred privacy preprocessing for Discord audit D-011', async () => {})
   */
  it('starts the deadline before deferred privacy preprocessing for Discord audit D-011', async () => {
    // ROOT CAUSE:
    //
    // The adapter created a turn only after privacy delivery settled. A hung
    // notice therefore had no deadline, no queue reservation, and could later
    // enter AIRI with a fresh full response window.
    //
    // Before: releasing the notice after 45 seconds still forwarded the input.
    // After: the ingress-owned turn expires while preprocessing is blocked and
    // releasing the obsolete promise cannot forward or rebuild correlation.
    const adapter = await createAdapter({ privacyNoticeEnabled: true })
    let releaseNotice: (() => void) | undefined
    const notice = vi.fn(() => new Promise<void>((resolve) => {
      releaseNotice = resolve
    }))

    const handling = handleText(adapter, 'SENTINEL_EXPIRED_PREPROCESS', undefined, {
      sendPrivacyNotice: notice,
    })
    await vi.waitFor(() => {
      /** @example expect(notice).toHaveBeenCalledTimes(1) */
      expect(notice).toHaveBeenCalledTimes(1)
    })

    await vi.advanceTimersByTimeAsync(45_000)
    /** @example expect(cancellationEvents()).toEqual([ expect.objectContaining({ data: expect.objectContaining({ reason: 'deadline' }) }), ]) */
    expect(cancellationEvents()).toEqual([
      expect.objectContaining({ data: expect.objectContaining({ reason: 'deadline' }) }),
    ])

    releaseNotice?.()
    await handling

    /** @example expect(inputEvents()).toHaveLength(0) */
    expect(inputEvents()).toHaveLength(0)
    /** @example expect(Reflect.get(adapter, 'pendingDiscordTurnsById')).toHaveProperty('size', 0) */
    expect(Reflect.get(adapter, 'pendingDiscordTurnsById')).toHaveProperty('size', 0)

    await adapter.stop()
  })

  /**
   * @example
   * it('does not resume deferred ingress after disable for Discord audit D-012', async () => {})
   */
  it('does not resume deferred ingress after disable for Discord audit D-012', async () => {
    // ROOT CAUSE:
    //
    // Disable cleared bounded maps only at one instant. An already awaited
    // privacy operation could resume afterward, repopulate privacy state, and
    // forward a provider request under the disabled lifecycle generation.
    //
    // Before: resolving the deferred notice after disable rebuilt state and sent input.
    // After: disable aborts every ingress-owned turn and each await boundary
    // checks the captured lifecycle before any state mutation or forwarding.
    const adapter = await createAdapter({ privacyNoticeEnabled: true })
    let releaseNotice: (() => void) | undefined
    const notice = vi.fn(() => new Promise<void>((resolve) => {
      releaseNotice = resolve
    }))

    const handling = handleText(adapter, 'SENTINEL_DISABLED_PREPROCESS', undefined, {
      sendPrivacyNotice: notice,
    })
    await vi.waitFor(() => {
      /** @example expect(notice).toHaveBeenCalledTimes(1) */
      expect(notice).toHaveBeenCalledTimes(1)
    })

    await adapter.applyRuntimeConfig({
      enabled: false,
      messagePacingMs: 0,
      privacyNoticeEnabled: true,
    })
    releaseNotice?.()
    await handling

    /** @example expect(inputEvents()).toHaveLength(0) */
    expect(inputEvents()).toHaveLength(0)
    /** @example expect(Reflect.get(adapter, 'privacyNoticeSessionIds')).toHaveProperty('size', 0) */
    expect(Reflect.get(adapter, 'privacyNoticeSessionIds')).toHaveProperty('size', 0)
    /** @example expect(Reflect.get(adapter, 'pendingDiscordTurnsById')).toHaveProperty('size', 0) */
    expect(Reflect.get(adapter, 'pendingDiscordTurnsById')).toHaveProperty('size', 0)
  })

  /**
   * @example
   * it('aborts deferred raw privacy delivery before Discord send for Discord audit D-011', async () => {})
   */
  it('aborts deferred raw privacy delivery before Discord send for Discord audit D-011', async () => {
    // ROOT CAUSE:
    //
    // The raw-DM privacy callback did not receive the exact ingress AbortSignal.
    // The outer adapter stopped awaiting it on disable, but its deferred channel
    // fetch continued and then invoked Discord send after the turn was cancelled.
    //
    // Before: resolving the raw fetch after abort still performed the send.
    // After: the callback receives the exact signal and gates every transport
    // transition, while the raw promise remains bounded until it really settles.
    const adapter = await createAdapter({ privacyNoticeEnabled: true })
    const abortController = new AbortController()
    let releaseFetch: (() => void) | undefined
    const rawSend = vi.fn(async () => {})
    const notice = vi.fn(async (_payload: SafeDiscordTextPayload, abortSignal?: AbortSignal) => {
      await new Promise<void>((resolve) => {
        releaseFetch = resolve
      })
      if (abortSignal?.aborted)
        return
      await rawSend()
    })

    const handling = handleText(adapter, 'SENTINEL_RAW_PRIVACY_ABORT', abortController.signal, {
      sendPrivacyNotice: notice,
    })
    await vi.waitFor(() => {
      /** @example expect(notice).toHaveBeenCalledTimes(1) */
      expect(notice).toHaveBeenCalledTimes(1)
    })

    abortController.abort()
    releaseFetch?.()
    await handling

    /** @example expect(notice).toHaveBeenCalledWith(expect.objectContaining({ allowedMentions: { parse: [] }, content: expect.any(String), }), expect.any(AbortSignal)) */
    expect(notice).toHaveBeenCalledWith(expect.objectContaining({
      allowedMentions: { parse: [] },
      content: expect.any(String),
    }), expect.any(AbortSignal))
    /** @example expect(notice.mock.calls[0]?.[1]?.aborted).toBe(true) */
    expect(notice.mock.calls[0]?.[1]?.aborted).toBe(true)
    /** @example expect(rawSend).not.toHaveBeenCalled() */
    expect(rawSend).not.toHaveBeenCalled()

    await adapter.stop()
  })

  /**
   * @example
   * it('aborts remaining response chunks at the exact deadline for Discord audit D-011', async () => {})
   */
  it('aborts remaining response chunks at the exact deadline for Discord audit D-011', async () => {
    // ROOT CAUSE:
    //
    // Response delivery and the timeout notice shared one controller, and moving
    // the turn into timeout phase did not abort the response sender. A deferred
    // first Discord chunk could resume after expiry and send every remaining chunk.
    //
    // Before: the second response chunk was sent after the deadline.
    // After: deadline aborts only the response controller; a separate bounded
    // notification controller may send the content-free timeout status.
    const adapter = await createAdapter()
    await handleText(adapter, 'SENTINEL_LONG_RESPONSE')
    const input = inputEvents()[0]
    let releaseFirstChunk: (() => void) | undefined
    turnMocks.channelSend.mockImplementationOnce(() => new Promise<void>((resolve) => {
      releaseFirstChunk = resolve
    }))

    const outputDelivery = turnMocks.airiHandlers.get('output:gen-ai:chat:message')?.({
      data: {
        discord: input?.data.discord,
        message: { content: `${'A'.repeat(2000)} SENTINEL_FORBIDDEN_SECOND_CHUNK` },
        turn: input?.data.turn,
      },
    })
    await vi.waitFor(() => {
      /** @example expect(turnMocks.channelSend).toHaveBeenCalledTimes(1) */
      expect(turnMocks.channelSend).toHaveBeenCalledTimes(1)
    })

    await vi.advanceTimersByTimeAsync(45_000)
    releaseFirstChunk?.()
    await outputDelivery

    /** @example expect(turnMocks.channelSend.mock.calls).not.toEqual(expect.arrayContaining([ [expect.objectContaining({ content: expect.stringContaining('SENTINEL_FORBIDDEN_SECOND_CHUNK') })], ])) */
    expect(turnMocks.channelSend.mock.calls).not.toEqual(expect.arrayContaining([
      [expect.objectContaining({ content: expect.stringContaining('SENTINEL_FORBIDDEN_SECOND_CHUNK') })],
    ]))
    /** @example expect(turnMocks.channelSend).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('did not come back in time'), })) */
    expect(turnMocks.channelSend).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining('did not come back in time'),
    }))

    await adapter.stop()
  })

  /**
   * @example
   * it('preserves Discord graphemes and whitespace across bridge chunks for Discord audit D-022', async () => {})
   */
  it('preserves Discord graphemes and whitespace across bridge chunks for Discord audit D-022', async () => {
    const adapter = await createAdapter()
    await handleText(adapter, 'SYNTHETIC_D022_REQUEST')
    const input = inputEvents()[0]
    const family = '👨‍👩‍👧‍👦'
    const reply = `${'A'.repeat(1999)}${family}  \n tail `
    const chunks: string[] = []
    turnMocks.channelSend.mockImplementation(async (payload: { content: string }) => {
      chunks.push(payload.content)
    })

    // ROOT CAUSE:
    //
    // Bridge delivery duplicated standalone's UTF-16 slice/trim loop. The loop
    // could split one extended grapheme and silently delete whitespace, so the
    // sequence accepted by Discord was not the provider's exact output.
    await turnMocks.airiHandlers.get('output:gen-ai:chat:message')?.({
      data: {
        discord: input?.data.discord,
        message: { content: reply },
        turn: input?.data.turn,
      },
    })

    /** @example expect(chunks.join('')).toBe(reply) */
    expect(chunks.join('')).toBe(reply)
    /** @example expect(chunks.some(chunk => chunk.includes(family))).toBe(true) */
    expect(chunks.some(chunk => chunk.includes(family))).toBe(true)
    /** @example expect(chunks.every(chunk => chunk.length <= 2000)).toBe(true) */
    expect(chunks.every(chunk => chunk.length <= 2000)).toBe(true)

    await adapter.stop()
  })

  /**
   * @example
   * it('reports bridge partial delivery without retry for Discord audit D-022', async () => {})
   */
  it('reports bridge partial delivery without retry for Discord audit D-022', async () => {
    const adapter = await createAdapter()
    await handleText(adapter, 'SYNTHETIC_D022_PARTIAL_REQUEST')
    const input = inputEvents()[0]
    const attempts: string[] = []
    const audit = vi.fn()
    Reflect.set(adapter, 'audit', audit)
    turnMocks.channelSend.mockImplementation(async (payload: unknown) => {
      const content = typeof payload === 'object' && payload !== null
        ? Reflect.get(payload, 'content')
        : undefined
      if (typeof content === 'string')
        attempts.push(content)
      if (attempts.length === 2)
        throw new Error('SYNTHETIC_DISCORD_SEND_PRIVATE_DETAIL')
    })

    // ROOT CAUSE:
    //
    // Bridge had no delivered/total contract. A later chunk failure only logged
    // the raw Discord rejection, leaving operators unable to distinguish a full
    // failure from a partial reply or safely decide whether retry would duplicate.
    await turnMocks.airiHandlers.get('output:gen-ai:chat:message')?.({
      data: {
        discord: input?.data.discord,
        message: { content: 'X'.repeat(4_001) },
        turn: input?.data.turn,
      },
    })

    /** @example expect(attempts).toHaveLength(2) */
    expect(attempts).toHaveLength(2)
    /** @example expect(audit).toHaveBeenCalledWith('output-delivery-failed', expect.objectContaining({ deliveredChunks: 1, totalChunks: 3 })) */
    expect(audit).toHaveBeenCalledWith('output-delivery-failed', expect.objectContaining({
      deliveredChunks: 1,
      errorName: 'DiscordTextDeliveryError',
      reason: 'send-failure',
      totalChunks: 3,
    }))
    /** @example expect(JSON.stringify(audit.mock.calls)).not.toContain('PRIVATE_DETAIL') */
    expect(JSON.stringify(audit.mock.calls)).not.toContain('PRIVATE_DETAIL')

    await adapter.stop()
  })

  /**
   * @example
   * it('counts a confirmed bridge chunk and gates deferred invocation for Discord audit D-022', async () => {})
   */
  it('counts a confirmed bridge chunk and gates deferred invocation for Discord audit D-022', async () => {
    const adapter = await createAdapter()
    const audit = vi.fn()
    Reflect.set(adapter, 'audit', audit)
    const confirmedController = new AbortController()
    let confirmFirstChunk = () => {}
    const confirmedTarget = {
      send: vi.fn(() => new Promise<void>((resolve) => {
        confirmFirstChunk = resolve
      })),
    }

    // ROOT CAUSE:
    //
    // Bridge returned false when exact generation changed after raw Discord
    // confirmation, losing the confirmed chunk from partial-delivery accounting.
    // Its admitted raw operation was also deferred, so stop could occur before
    // invocation while the unguarded microtask still called Discord.
    const confirmedDelivery = Reflect.apply(Reflect.get(adapter, 'sendDiscordContent'), adapter, [
      confirmedTarget,
      'X'.repeat(2_001),
      'discord-user-confirmed',
      confirmedController.signal,
    ]) as Promise<boolean>
    await vi.waitFor(() => {
      /** @example expect(confirmedTarget.send).toHaveBeenCalledOnce() */
      expect(confirmedTarget.send).toHaveBeenCalledOnce()
    })
    confirmFirstChunk()
    confirmedController.abort('generation-superseded')
    /** @example await expect(confirmedDelivery).resolves.toBe(false) */
    await expect(confirmedDelivery).resolves.toBe(false)
    /** @example expect(audit).toHaveBeenCalledWith('discord-delivery-cancelled', { deliveredChunks: 1, totalChunks: 2 }) */
    expect(audit).toHaveBeenCalledWith('discord-delivery-cancelled', {
      deliveredChunks: 1,
      totalChunks: 2,
    })
    /** @example expect(confirmedTarget.send).toHaveBeenCalledOnce() */
    expect(confirmedTarget.send).toHaveBeenCalledOnce()
    await adapter.stop()

    const stoppingAdapter = await createAdapter()
    const staleTarget = { send: vi.fn(async () => {}) }
    const ingressSignal = Reflect.get(stoppingAdapter, 'discordIngressLifecycle').signal as AbortSignal
    const staleDelivery = Reflect.apply(Reflect.get(stoppingAdapter, 'sendDiscordContent'), stoppingAdapter, [
      staleTarget,
      'SENTINEL_MUST_NOT_SEND',
      'discord-user-stale',
      ingressSignal,
    ]) as Promise<boolean>
    const stopping = stoppingAdapter.stop()

    /** @example await expect(staleDelivery).resolves.toBe(false) */
    await expect(staleDelivery).resolves.toBe(false)
    /** @example expect(staleTarget.send).not.toHaveBeenCalled() */
    expect(staleTarget.send).not.toHaveBeenCalled()
    await stopping
  })

  /**
   * @example
   * it('does not launch admitted privacy transport after config supersession for Discord audit D-022', async () => {})
   */
  it('does not launch admitted privacy transport after config supersession for Discord audit D-022', async () => {
    const config: DiscordBridgeRuntimeConfig = {
      allowedChannelIds: ['allowed-channel'],
      enabled: true,
      messagePacingMs: 0,
      privacyNoticeEnabled: true,
      privacyNoticeText: 'Synthetic privacy notice.',
    }
    const adapter = new DiscordAdapter({ discordToken: 'synthetic-discord-token' })
    turnMocks.airiReady?.()
    await adapter.applyRuntimeConfig(config)
    Reflect.set(Reflect.get(adapter, 'discordClient'), 'user', { id: 'bot-1' })
    const messageCreate = turnMocks.discordHandlers.get('message-create')
    if (!messageCreate)
      throw new Error('Expected the Discord MessageCreate handler.')
    const send = vi.fn(async () => {})
    const originalBeginRawTransport = Reflect.get(adapter, 'beginRawDiscordTransport')
    let superseding: Promise<void> | undefined
    Reflect.set(adapter, 'beginRawDiscordTransport', (
      principalKey: string,
      operation: () => Promise<unknown> | unknown,
    ) => {
      const transport = Reflect.apply(originalBeginRawTransport, adapter, [principalKey, operation])
      // The production registry admits before invoking on a microtask. Apply a
      // real enabled-to-enabled policy generation in that exact race window.
      superseding ??= adapter.applyRuntimeConfig(config)
      return transport
    })

    // ROOT CAUSE:
    //
    // Enabled-to-enabled policy updates advanced config generation without
    // aborting every pending turn signal. Privacy/typing/target raw operations
    // checked only before admission, so their deferred microtask could still
    // call Discord under the superseded generation.
    const handling = Promise.resolve(messageCreate({
      author: { bot: false, id: 'user-a', username: 'Synthetic user A' },
      channel: { isTextBased: () => true, send },
      channelId: 'allowed-channel',
      content: '<@bot-1> SENTINEL_CONFIG_SUPERSESSION',
      guild: { name: 'Synthetic guild' },
      guildId: 'guild-1',
      id: 'config-supersession',
      member: { displayName: 'Synthetic user A', nickname: 'Synthetic user A' },
      mentions: { has: () => true },
      reference: undefined,
      type: MessageType.Default,
    }))
    await handling
    await superseding

    /** @example expect(send).not.toHaveBeenCalled() */
    expect(send).not.toHaveBeenCalled()
    /** @example expect(inputEvents()).toHaveLength(0) */
    expect(inputEvents()).toHaveLength(0)
    /** @example expect(Reflect.get(adapter, 'discordIngressScheduler')).toHaveProperty('pendingCount', 0) */
    expect(Reflect.get(adapter, 'discordIngressScheduler')).toHaveProperty('pendingCount', 0)
    await adapter.stop()
  })

  /**
   * @example
   * it('expires a response whose Discord send settles after its deadline for Discord audit D-011', async () => {})
   */
  it('expires a response whose Discord send settles after its deadline for Discord audit D-011', async () => {
    // ROOT CAUSE:
    //
    // The post-send activity check returned when wall-clock time had crossed the
    // deadline, but the output finally block then removed the turn and its timer.
    // A delayed timer callback therefore could no longer emit cancellation.
    //
    // Before: settling the send after the deadline silently completed the turn.
    // After: the post-send gate explicitly expires the exact turn, preserving
    // cancellation and timeout notification even when fake/system time jumps.
    const adapter = await createAdapter()
    await handleText(adapter, 'SENTINEL_POST_SEND_DEADLINE')
    const input = inputEvents()[0]
    let releaseResponseSend: (() => void) | undefined
    turnMocks.channelSend.mockImplementationOnce(() => new Promise<void>((resolve) => {
      releaseResponseSend = resolve
    }))

    const delivery = turnMocks.airiHandlers.get('output:gen-ai:chat:message')?.({
      data: {
        discord: input?.data.discord,
        message: { content: 'SENTINEL_RESPONSE_CROSSES_DEADLINE' },
        turn: input?.data.turn,
      },
    })
    await vi.waitFor(() => {
      /** @example expect(turnMocks.channelSend).toHaveBeenCalledTimes(1) */
      expect(turnMocks.channelSend).toHaveBeenCalledTimes(1)
    })

    vi.setSystemTime(46_001)
    releaseResponseSend?.()
    await delivery

    /** @example expect(cancellationEvents()).toEqual([ expect.objectContaining({ data: expect.objectContaining({ reason: 'deadline', turn: input?.data.turn }) }), ]) */
    expect(cancellationEvents()).toEqual([
      expect.objectContaining({ data: expect.objectContaining({ reason: 'deadline', turn: input?.data.turn }) }),
    ])
    /** @example expect(turnMocks.channelSend).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('did not come back in time'), })) */
    expect(turnMocks.channelSend).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining('did not come back in time'),
    }))

    await adapter.stop()
  })

  /**
   * @example
   * it('bounds non-cancellable overload status transports for Discord audit D-012', async () => {})
   */
  it('bounds non-cancellable overload status transports for Discord audit D-012', async () => {
    // ROOT CAUSE:
    //
    // Every capacity rejection independently awaited a Discord channel fetch.
    // Abort stopped the adapter from awaiting that promise but could not cancel
    // Discord.js transport work, so repeated overload traffic accumulated an
    // unbounded number of detached fetches outside all bounded state maps.
    //
    // Before: twenty overflow inputs started twenty never-settling fetches.
    // After: one explicit process-wide transport set admits at most eight raw
    // status operations and retains each slot until its real promise settles.
    const adapter = await createAdapter()
    const releases: Array<() => void> = []
    turnMocks.channelFetch.mockImplementation(() => new Promise<undefined>((resolve) => {
      releases.push(() => resolve(undefined))
    }))
    const ingressLifecycle = Reflect.get(adapter, 'discordIngressLifecycle').signal as AbortSignal
    const overflowHandlings = Array.from({ length: 20 }, (_, index) => Reflect.apply(
      Reflect.get(adapter, 'scheduleDiscordOverloadStatus'),
      adapter,
      [{
        channelId: `synthetic-channel-${index}`,
        guildId: 'synthetic-guild',
        guildMember: {
          displayName: `Synthetic user ${index}`,
          id: `synthetic-user-${index}`,
          nickname: `Synthetic user ${index}`,
        },
      }, ingressLifecycle],
    ) as Promise<void>)
    await vi.waitFor(() => {
      /** @example expect(turnMocks.channelFetch).toHaveBeenCalled() */
      expect(turnMocks.channelFetch).toHaveBeenCalled()
    })
    await Promise.resolve()
    await Promise.resolve()

    /** @example expect(turnMocks.channelFetch).toHaveBeenCalledTimes(8) */
    expect(turnMocks.channelFetch).toHaveBeenCalledTimes(8)
    /** @example expect(Reflect.get(adapter, 'rawDiscordTransports')).toHaveProperty('size', 8) */
    expect(Reflect.get(adapter, 'rawDiscordTransports')).toHaveProperty('size', 8)

    await adapter.stop()
    await Promise.all(overflowHandlings)
    for (const release of releases)
      release()
    await vi.waitFor(() => {
      /** @example expect(Reflect.get(adapter, 'rawDiscordTransports')).toHaveProperty('size', 0) */
      expect(Reflect.get(adapter, 'rawDiscordTransports')).toHaveProperty('size', 0)
    })
  })

  /**
   * @example
   * it('revalidates deferred ingress after an enabled policy tightens for Discord audit D-012', async () => {})
   */
  it('revalidates deferred ingress after an enabled policy tightens for Discord audit D-012', async () => {
    // ROOT CAUSE:
    //
    // Allowed-channel and DM policy was checked only before reserving a turn.
    // An enabled-to-enabled update could tighten access while privacy delivery
    // was pending, then the stale ingress resumed under its original decision.
    //
    // Before: the newly denied message was forwarded after privacy completed.
    // After: applying policy revalidates every reserved correlation and aborts
    // denied preprocessing before it can mutate notice state or reach Stage.
    const adapter = new DiscordAdapter({ discordToken: 'synthetic-discord-bot-token' })
    await adapter.applyRuntimeConfig({
      allowedChannelIds: ['synthetic-channel'],
      enabled: true,
      messagePacingMs: 0,
      privacyNoticeEnabled: true,
    })
    let releaseNotice: (() => void) | undefined
    const notice = vi.fn(() => new Promise<void>((resolve) => {
      releaseNotice = resolve
    }))
    const handling = handleText(adapter, 'SENTINEL_POLICY_TIGHTENED', undefined, {
      sendPrivacyNotice: notice,
    })
    await vi.waitFor(() => {
      /** @example expect(notice).toHaveBeenCalledTimes(1) */
      expect(notice).toHaveBeenCalledTimes(1)
    })

    await adapter.applyRuntimeConfig({
      allowedChannelIds: ['different-synthetic-channel'],
      enabled: true,
      messagePacingMs: 0,
      privacyNoticeEnabled: true,
    })
    releaseNotice?.()
    await handling

    /** @example expect(inputEvents()).toHaveLength(0) */
    expect(inputEvents()).toHaveLength(0)
    /** @example expect(cancellationEvents()).toEqual([ expect.objectContaining({ data: expect.objectContaining({ reason: 'reset' }) }), ]) */
    expect(cancellationEvents()).toEqual([
      expect.objectContaining({ data: expect.objectContaining({ reason: 'reset' }) }),
    ])
    /** @example expect(Reflect.get(adapter, 'privacyNoticeSessionIds')).toHaveProperty('size', 0) */
    expect(Reflect.get(adapter, 'privacyNoticeSessionIds')).toHaveProperty('size', 0)

    await adapter.stop()
  })

  /**
   * @example
   * it('invalidates pending turns on Discord shard disconnect for Discord audit D-011', async () => {})
   */
  it('invalidates pending turns on Discord shard disconnect for Discord audit D-011', async () => {
    // ROOT CAUSE:
    //
    // Only explicit adapter stop and policy disable invalidated correlations.
    // A Discord gateway disconnect left provider work live until its old deadline,
    // allowing history and output work to outlive the reply transport.
    //
    // Before: shard disconnect retained the pending turn.
    // After: the transport lifecycle cancels every exact pending turn immediately.
    const adapter = await createAdapter()
    Reflect.set(adapter, 'runtimePolicyEnabled', true)
    await handleText(adapter, 'SENTINEL_DISCONNECTED')
    const input = inputEvents()[0]

    await turnMocks.discordHandlers.get('shard-disconnect')?.({})

    /** @example expect(cancellationEvents()).toEqual([ expect.objectContaining({ data: expect.objectContaining({ reason: 'disconnect', turn: input?.data.turn, }), }), ]) */
    expect(cancellationEvents()).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({
          reason: 'disconnect',
          turn: input?.data.turn,
        }),
      }),
    ])
    /** @example expect(Reflect.get(adapter, 'pendingDiscordTurnsById')).toHaveProperty('size', 0) */
    expect(Reflect.get(adapter, 'pendingDiscordTurnsById')).toHaveProperty('size', 0)

    await turnMocks.airiHandlers.get('output:gen-ai:chat:message')?.({
      data: {
        discord: input?.data.discord,
        message: { content: 'SENTINEL_LATE_DISCONNECTED_OUTPUT' },
        turn: input?.data.turn,
      },
    })
    /** @example expect(turnMocks.channelSend).not.toHaveBeenCalledWith(expect.objectContaining({ content: 'SENTINEL_LATE_DISCONNECTED_OUTPUT', })) */
    expect(turnMocks.channelSend).not.toHaveBeenCalledWith(expect.objectContaining({
      content: 'SENTINEL_LATE_DISCONNECTED_OUTPUT',
    }))
  })

  /**
   * @example
   * it('bounds a stalled timeout notification for Discord audit D-012', async () => {})
   */
  it('bounds a stalled timeout notification for Discord audit D-012', async () => {
    // ROOT CAUSE:
    //
    // A response deadline changed correlation into timeout phase, but resolving
    // its Discord channel had no deadline of its own. Sixty-four hung fetches
    // could therefore retain every pending slot until process restart.
    //
    // Before: a never-settling channel fetch retained the timeout correlation forever.
    // After: timeout-status resolution has its own ten-second abort boundary and
    // removes the exact pending turn without waiting for the transport promise.
    const adapter = await createAdapter()
    await handleText(adapter, 'SENTINEL_STALLED_TIMEOUT_TARGET')
    let releaseFetch = () => {}
    turnMocks.channelFetch.mockImplementationOnce(() => new Promise<undefined>((resolve) => {
      releaseFetch = () => resolve(undefined)
    }))

    await vi.advanceTimersByTimeAsync(45_000)
    await vi.waitFor(() => {
      /** @example expect(turnMocks.channelFetch).toHaveBeenCalledTimes(1) */
      expect(turnMocks.channelFetch).toHaveBeenCalledTimes(1)
    })
    /** @example expect(Reflect.get(adapter, 'pendingDiscordTurnsById')).toHaveProperty('size', 1) */
    expect(Reflect.get(adapter, 'pendingDiscordTurnsById')).toHaveProperty('size', 1)

    await vi.advanceTimersByTimeAsync(10_000)
    /** @example expect(Reflect.get(adapter, 'pendingDiscordTurnsById')).toHaveProperty('size', 0) */
    expect(Reflect.get(adapter, 'pendingDiscordTurnsById')).toHaveProperty('size', 0)

    await adapter.stop()
    releaseFetch()
    await Promise.resolve()
  })

  /**
   * @example
   * it('caps raw timeout notification transports for Discord audit D-012', async () => {})
   */
  it('caps raw timeout notification transports for Discord audit D-012', async () => {
    // ROOT CAUSE:
    //
    // The ten-second notification deadline released correlation state but only
    // raced the local waiter. Discord.js fetch promises cannot be aborted, so
    // each expired turn left one detached raw transport and fresh sessions could
    // repeat the leak without bound.
    //
    // Before: twenty expired exact sessions started twenty unresolved fetches.
    // After: one process-wide raw transport cap admits eight operations and keeps
    // each slot until the underlying Discord.js promise actually settles.
    const adapter = await createAdapter()
    const releases: Array<() => void> = []
    turnMocks.channelFetch.mockImplementation(() => new Promise<undefined>((resolve) => {
      releases.push(() => resolve(undefined))
    }))

    for (let index = 0; index < 20; index += 1) {
      await Reflect.apply(Reflect.get(adapter, 'handleDiscordTextInput'), adapter, [{
        channelId: `synthetic-channel-${index}`,
        content: `SENTINEL_TIMEOUT_TRANSPORT_${index}`,
        directMessage: false,
        displayName: 'Synthetic user',
        guildId: 'synthetic-guild',
        guildName: 'Synthetic guild',
        nickname: 'Synthetic user',
        rawContent: `SENTINEL_TIMEOUT_TRANSPORT_${index}`,
        userId: `synthetic-user-${index}`,
      }])
    }

    await vi.advanceTimersByTimeAsync(45_000)

    /** @example expect(turnMocks.channelFetch).toHaveBeenCalledTimes(8) */
    expect(turnMocks.channelFetch).toHaveBeenCalledTimes(8)
    /** @example expect(Reflect.get(adapter, 'rawDiscordTransports')).toHaveProperty('size', 8) */
    expect(Reflect.get(adapter, 'rawDiscordTransports')).toHaveProperty('size', 8)

    await vi.advanceTimersByTimeAsync(10_000)
    /** @example expect(Reflect.get(adapter, 'pendingDiscordTurnsById')).toHaveProperty('size', 0) */
    expect(Reflect.get(adapter, 'pendingDiscordTurnsById')).toHaveProperty('size', 0)

    await adapter.stop()
    for (const release of releases)
      release()
    await Promise.resolve()
  })
})
