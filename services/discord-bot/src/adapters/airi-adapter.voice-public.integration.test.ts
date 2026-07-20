import type { WebSocketEventOf, WebSocketEventOptionalSource } from '@proj-airi/server-shared/types'
import type { Message } from 'discord.js'

import { Events, MessageReferenceType, MessageType } from 'discord.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createDiscordVoiceHarness } from '../test/discordVoiceHarness'
import { DiscordAdapter } from './airi-adapter'

type InputTextEvent = Extract<WebSocketEventOptionalSource, { type: 'input:text' }>
type OutputChatMessageEvent = WebSocketEventOf<'output:gen-ai:chat:message'>
interface MessageCreateFixture {
  author: Pick<Message['author'], 'bot' | 'id' | 'username'>
  channel: {
    isTextBased: () => boolean
    send: (payload: { content: string }) => Promise<void>
  }
  channelId: string
  content: string
  fetchReference?: () => Promise<{ author: Pick<Message['author'], 'id'> }>
  guild: Pick<NonNullable<Message['guild']>, 'name'> | null
  guildId: string | null
  id: string
  member: Pick<NonNullable<Message['member']>, 'displayName' | 'nickname'> | null
  mentions: { has: (user: string | { id: string }) => boolean }
  reference: Pick<NonNullable<Message['reference']>, 'messageId' | 'type'> | null
  type: number
}

const bridgeMocks = vi.hoisted(() => {
  const sent: WebSocketEventOptionalSource[] = []
  let ready: (() => void) | undefined
  let outputChatMessage: ((event: OutputChatMessageEvent) => unknown) | undefined
  let sendResult = true

  return {
    channel: undefined as { emitReady: () => void } | undefined,
    emitReady: () => ready?.(),
    order: [] as string[],
    outputChatMessage: () => outputChatMessage,
    sent,
    send: vi.fn((event: WebSocketEventOptionalSource) => {
      sent.push(event)
      bridgeMocks.order.push(event.type)
      return sendResult
    }),
    setOutputChatMessage: (listener: ((event: OutputChatMessageEvent) => unknown) | undefined) => { outputChatMessage = listener },
    setReady: (nextReady: (() => void) | undefined) => { ready = nextReady },
    setSendResult: (nextSendResult: boolean) => { sendResult = nextSendResult },
  }
})

const discordMocks = vi.hoisted(() => ({
  client: undefined as {
    drain: () => Promise<void>
    emit: (event: string, ...args: unknown[]) => boolean
  } | undefined,
  sends: [] as Array<{ channelId: string, content: string }>,
  registrationPut: vi.fn(async () => {}),
}))

const voiceMocks = vi.hoisted(() => ({
  entersState: vi.fn(async () => {}),
  joinVoiceChannel: vi.fn(),
}))

const speechMocks = vi.hoisted(() => ({
  transcribe: vi.fn(async () => 'public voice transcript'),
}))

vi.mock('@proj-airi/server-sdk', () => ({
  Client: class {
    close = vi.fn(async () => {})
    send = bridgeMocks.send

    constructor(config: { onReady?: () => void }) {
      bridgeMocks.setReady(config.onReady)
      bridgeMocks.channel = { emitReady: bridgeMocks.emitReady }
    }

    onEvent(event: string, listener: (event: OutputChatMessageEvent) => unknown) {
      if (event === 'output:gen-ai:chat:message')
        bridgeMocks.setOutputChatMessage(listener)
      return () => {}
    }
  },
}))

vi.mock('discord.js', () => {
  class TestDiscordClient {
    listeners = new Map<string, Array<(...args: unknown[]) => unknown>>()
    pending = new Set<Promise<unknown>>()
    ready = false

    channels = {
      fetch: vi.fn(async (channelId: string) => ({
        isTextBased: () => true,
        send: async (payload: { content: string }) => {
          discordMocks.sends.push({ channelId, content: payload.content })
          bridgeMocks.order.push('discord:send')
        },
      })),
    }

    user = { id: 'public-test-application' }

    constructor() {
      discordMocks.client = this
    }

    destroy() {
      this.ready = false
    }

    async drain() {
      while (this.pending.size)
        await Promise.all(this.pending)
    }

    emit(event: string, ...args: unknown[]): boolean {
      const listeners = this.listeners.get(event) ?? []
      for (const listener of listeners) {
        const result = listener(...args)
        if (result && typeof result === 'object' && 'then' in result && typeof result.then === 'function') {
          const pending = Promise.resolve(result)
          this.pending.add(pending)
          void pending.finally(() => this.pending.delete(pending))
        }
      }
      return listeners.length > 0
    }

    isReady() {
      return this.ready
    }

    async login() {
      this.ready = true
      return 'public-test-token'
    }

    off(event: string, listener: (...args: unknown[]) => unknown) {
      const listeners = this.listeners.get(event)
      if (!listeners)
        return this
      this.listeners.set(event, listeners.filter(candidate => candidate !== listener))
      return this
    }

    on(event: string, listener: (...args: unknown[]) => unknown) {
      this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener])
      return this
    }

    removeAllListeners() {
      this.listeners.clear()
      return this
    }
  }

  class TestRest {
    setToken() {
      return this
    }

    put = discordMocks.registrationPut
  }

  class TestButtonBuilder {
    customId = ''

    setCustomId(customId: string) {
      this.customId = customId
      return this
    }

    setLabel() {
      return this
    }

    setStyle() {
      return this
    }

    toJSON() {
      return { custom_id: this.customId }
    }
  }

  class TestActionRowBuilder {
    components: TestButtonBuilder[] = []

    addComponents(...components: TestButtonBuilder[]) {
      this.components.push(...components)
      return this
    }

    toJSON() {
      return { components: this.components.map(component => component.toJSON()) }
    }
  }

  class TestSlashCommandBuilder {
    addChoices() {
      return this
    }

    addStringOption(callback: (option: TestSlashCommandBuilder) => TestSlashCommandBuilder) {
      callback(new TestSlashCommandBuilder())
      return this
    }

    addSubcommand(callback: (option: TestSlashCommandBuilder) => TestSlashCommandBuilder) {
      callback(new TestSlashCommandBuilder())
      return this
    }

    addSubcommandGroup(callback: (option: TestSlashCommandBuilder) => TestSlashCommandBuilder) {
      callback(new TestSlashCommandBuilder())
      return this
    }

    setDefaultMemberPermissions() {
      return this
    }

    setDescription() {
      return this
    }

    setDMPermission() {
      return this
    }

    setMaxLength() {
      return this
    }

    setName() {
      return this
    }

    setRequired() {
      return this
    }
  }

  return {
    ActionRowBuilder: TestActionRowBuilder,
    ButtonBuilder: TestButtonBuilder,
    ButtonStyle: { Secondary: 2, Success: 3 },
    Client: TestDiscordClient,
    Events: {
      ClientReady: 'ready',
      InteractionCreate: 'interactionCreate',
      MessageCreate: 'messageCreate',
      Raw: 'raw',
      ShardDisconnect: 'shardDisconnect',
      ShardReady: 'shardReady',
      VoiceStateUpdate: 'voiceStateUpdate',
    },
    GatewayIntentBits: {
      DirectMessages: 1,
      GuildMessages: 2,
      Guilds: 4,
      GuildVoiceStates: 8,
      MessageContent: 16,
    },
    MessageReferenceType: { Default: 0, Forward: 1 },
    MessageType: { ChatInputCommand: 20, Reply: 19 },
    Partials: { Channel: 0, Message: 1, User: 2 },
    PermissionFlagsBits: { ManageGuild: 32n },
    REST: TestRest,
    Routes: { applicationCommands: (applicationId: string) => `/applications/${applicationId}/commands` },
    SlashCommandBuilder: TestSlashCommandBuilder,
  }
})

vi.mock('@discordjs/voice', () => ({
  createAudioPlayer: vi.fn(() => ({
    on: vi.fn(),
    play: vi.fn(),
    removeAllListeners: vi.fn(),
    state: { status: 'idle' },
    stop: vi.fn(),
  })),
  createAudioResource: vi.fn(),
  entersState: voiceMocks.entersState,
  getVoiceConnections: vi.fn(() => new Map()),
  joinVoiceChannel: voiceMocks.joinVoiceChannel,
  NoSubscriberBehavior: { Pause: 'pause' },
  StreamType: { Arbitrary: 'arbitrary', OggOpus: 'ogg/opus', Raw: 'raw' },
  VoiceConnectionStatus: {
    Connecting: 'connecting',
    Destroyed: 'destroyed',
    Disconnected: 'disconnected',
    Ready: 'ready',
    Signalling: 'signalling',
  },
}))

vi.mock('../pipelines/openai-speech', () => ({
  SpeechProviderRequestError: class extends Error {
    constructor(kind: string, operation: string) {
      super(`Speech ${operation} request ${kind}.`)
    }
  },
  describeOpenAICompatibleProvider: () => 'the public test STT provider',
  transcribeOpenAICompatible: speechMocks.transcribe,
}))

function requireDiscordClient() {
  if (!discordMocks.client)
    throw new Error('Discord client fixture was not created.')
  return discordMocks.client
}

function requireServerChannel() {
  if (!bridgeMocks.channel)
    throw new Error('AIRI server-channel fixture was not created.')
  return bridgeMocks.channel
}

function requireOutputChatMessageListener() {
  const listener = bridgeMocks.outputChatMessage()
  if (!listener)
    throw new Error('The public output listener was not registered.')
  return listener
}

function createGuildMessage(input: {
  channelId: string
  guildId: string
  messageId: string
  userId: string
}): MessageCreateFixture {
  const send = async (payload: { content: string }) => {
    discordMocks.sends.push({ channelId: input.channelId, content: payload.content })
  }
  return {
    author: { bot: false, id: input.userId, username: `User ${input.userId}` },
    channel: { isTextBased: () => true, send },
    channelId: input.channelId,
    content: `<@public-test-application> message-${input.messageId}`,
    guild: { name: `Guild ${input.guildId}` },
    guildId: input.guildId,
    id: input.messageId,
    member: { displayName: `User ${input.userId}`, nickname: `User ${input.userId}` },
    mentions: { has: (user: { id: string }) => user.id === 'public-test-application' },
    reference: null,
    type: 0,
  }
}

function createGuildReplyMessage(input: {
  channelId: string
  guildId: string
  messageId: string
  referenceType: NonNullable<MessageCreateFixture['reference']>['type']
  referencedAuthorId: () => Promise<string>
  userId: string
}) {
  const fetchReference = vi.fn(async () => ({ author: { id: await input.referencedAuthorId() } }))
  const send = async (payload: { content: string }) => {
    discordMocks.sends.push({ channelId: input.channelId, content: payload.content })
  }
  const message: MessageCreateFixture = {
    author: { bot: false, id: input.userId, username: `User ${input.userId}` },
    channel: { isTextBased: () => true, send },
    channelId: input.channelId,
    content: `reply-${input.messageId}`,
    fetchReference,
    guild: { name: `Guild ${input.guildId}` },
    guildId: input.guildId,
    id: input.messageId,
    member: { displayName: `User ${input.userId}`, nickname: `User ${input.userId}` },
    mentions: { has: () => false },
    reference: { messageId: `reference-${input.messageId}`, type: input.referenceType },
    type: MessageType.Reply,
  }
  return { fetchReference, message }
}

function createDmMessage(input: {
  channelId: string
  messageId: string
  userId: string
}): MessageCreateFixture {
  const send = async (payload: { content: string }) => {
    discordMocks.sends.push({ channelId: input.channelId, content: payload.content })
  }
  return {
    author: { bot: false, id: input.userId, username: `User ${input.userId}` },
    channel: { isTextBased: () => true, send },
    channelId: input.channelId,
    content: `message-${input.messageId}`,
    guild: null,
    guildId: null,
    id: input.messageId,
    member: null,
    mentions: { has: () => false },
    reference: null,
    type: 0,
  }
}

function inputTextEvents(): InputTextEvent[] {
  return bridgeMocks.sent.filter(isInputTextEvent)
}

function createOutputChatMessage(input: InputTextEvent, content: string): OutputChatMessageEvent {
  return {
    data: {
      discord: input.data.discord,
      message: { content, role: 'assistant' },
      turn: input.data.turn,
    },
    type: 'output:gen-ai:chat:message',
  }
}

function requireConsentCustomId(reply: { components?: Array<{ toJSON: () => { components: Array<{ custom_id?: string }> } }> }) {
  const customId = reply.components?.[0]?.toJSON().components[0]?.custom_id
  if (!customId)
    throw new Error('The public summon reply did not include an opt-in consent id.')
  return customId
}

function isInputTextEvent(event: WebSocketEventOptionalSource): event is InputTextEvent {
  return event.type === 'input:text'
}

/** Server lifecycle events are valid after `adapter.stop()` and excluded only from pre-stop privacy ordering. */
const CONTROL_EVENT_TYPES = new Set(['chat:turn:cancel'])

/** Every visible pre-stop event must remain either the privacy notice or one of the voice ingress contracts. */
const PRIVACY_AND_VOICE_EVENT_TYPES = new Set([
  'privacy-notice',
  'input:text',
  'input:text:voice',
  'input:voice',
])

function privacyAndVoiceIngressOrder(order: readonly string[]): string[] {
  const visibleOrder = order
    .filter(type => !CONTROL_EVENT_TYPES.has(type))
    .map(type => type === 'discord:send' ? 'privacy-notice' : type)
  expect(visibleOrder.every(type => PRIVACY_AND_VOICE_EVENT_TYPES.has(type))).toBe(true)
  return visibleOrder
}

function expectScalarDto(value: unknown): void {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string')
    return
  if (Array.isArray(value)) {
    for (const entry of value)
      expectScalarDto(entry)
    return
  }
  if (!isScalarRecord(value))
    throw new Error('AIRI voice DTO must not retain live Discord objects.')
  for (const entry of Object.values(value))
    expectScalarDto(entry)
}

function isScalarRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

beforeEach(() => {
  bridgeMocks.channel = undefined
  bridgeMocks.order.length = 0
  bridgeMocks.sent.length = 0
  bridgeMocks.send.mockClear()
  bridgeMocks.setOutputChatMessage(undefined)
  bridgeMocks.setSendResult(true)
  discordMocks.client = undefined
  discordMocks.sends.length = 0
  discordMocks.registrationPut.mockClear()
  speechMocks.transcribe.mockClear()
  voiceMocks.entersState.mockClear()
  voiceMocks.joinVoiceChannel.mockReset()
  voiceMocks.entersState.mockResolvedValue(undefined)
})

afterEach(() => {
  vi.useRealTimers()
})

/**
 * @example
 * describe('discord public classic voice integration', () => {})
 */
describe('discord public classic voice integration', () => {
  /**
   * @example
   * it('routes unanimous public voice consent through canonical input:text ingress', async () => {})
   */
  it('routes unanimous public voice consent through canonical input:text ingress', async () => {
    const harness = createDiscordVoiceHarness('guild-public', 'voice-public', 'user-a')
    harness.addParticipant('user-b')
    voiceMocks.joinVoiceChannel.mockReturnValue(harness.connection)
    const adapter = new DiscordAdapter({
      discordToken: 'public-test-token',
      transcription: { apiKey: 'public-test-key' },
    })

    try {
      await adapter.applyRuntimeConfig({
        allowedChannelIds: ['voice-public'],
        enabled: true,
        messagePacingMs: 0,
        privacyNoticeEnabled: true,
        privacyNoticeText: 'Voice privacy notice.',
        rateLimitMaxMessages: 1,
      })
      requireServerChannel().emitReady()

      const summon = harness.createSummonInteraction('user-a', 'summon-public')
      requireDiscordClient().emit(Events.InteractionCreate, summon)
      await vi.waitFor(() => expect(summon.replies).toHaveLength(1))

      const consentId = requireConsentCustomId(summon.replies[0]!)
      expect(summon.replies[0]?.content).toContain('Every current participant must opt in')
      expect(voiceMocks.joinVoiceChannel).not.toHaveBeenCalled()
      expect(harness.connection.receiver.subscribe).not.toHaveBeenCalled()
      expect(speechMocks.transcribe).not.toHaveBeenCalled()

      requireDiscordClient().emit(Events.InteractionCreate, harness.createConsentInteraction('user-a', consentId))
      await harness.drain()
      expect(voiceMocks.joinVoiceChannel).not.toHaveBeenCalled()
      expect(harness.connection.receiver.subscribe).not.toHaveBeenCalled()
      expect(speechMocks.transcribe).not.toHaveBeenCalled()

      requireDiscordClient().emit(Events.InteractionCreate, harness.createConsentInteraction('user-b', consentId))
      await vi.waitFor(() => expect(voiceMocks.joinVoiceChannel).toHaveBeenCalledOnce())
      expect(harness.connection.receiver.subscribe).not.toHaveBeenCalled()
      expect(speechMocks.transcribe).not.toHaveBeenCalled()

      harness.speaking.emit('start', 'user-a')
      await vi.waitFor(() => expect(harness.connection.receiver.subscribe).toHaveBeenCalledWith('user-a', expect.anything()))
      harness.feedSpeech('user-a')
      harness.speaking.emit('end', 'user-a')
      await vi.waitFor(() => expect(speechMocks.transcribe).toHaveBeenCalledTimes(1), { timeout: 3_000 })
      await vi.waitFor(() => expect(bridgeMocks.sent.map(event => event.type)).toEqual(['input:text']), { timeout: 3_000 })

      harness.speaking.emit('start', 'user-b')
      await vi.waitFor(() => expect(harness.connection.receiver.subscribe).toHaveBeenCalledWith('user-b', expect.anything()))
      harness.feedSpeech('user-b')
      harness.speaking.emit('end', 'user-b')
      await vi.waitFor(() => expect(speechMocks.transcribe).toHaveBeenCalledTimes(2), { timeout: 3_000 })
      await vi.waitFor(() => expect(bridgeMocks.sent.map(event => event.type)).toEqual(['input:text', 'input:text']), { timeout: 3_000 })

      expect(bridgeMocks.sent.map(event => event.type)).toEqual(['input:text', 'input:text'])
      const inputTextEvents = bridgeMocks.sent.filter(isInputTextEvent)
      expect(inputTextEvents).toHaveLength(2)
      expect(inputTextEvents.map(event => event.data.overrides?.sessionId)).toEqual([
        'discord-guild-guild-public-channel-voice-public-user-user-a',
        'discord-guild-guild-public-channel-voice-public-user-user-b',
      ])
      expect(inputTextEvents.map(event => event.data.overrides?.cloudSync)).toEqual(['disabled', 'disabled'])
      expect(inputTextEvents.map(event => event.data.discord)).toEqual([
        {
          channelId: 'voice-public',
          guildId: 'guild-public',
          guildMember: { displayName: 'Speaker user-a', id: 'user-a', nickname: 'Speaker user-a' },
          guildName: 'Discord',
          memory: { shortTermLimit: 20 },
          owner: { configured: false, currentUserIsOwner: false },
        },
        {
          channelId: 'voice-public',
          guildId: 'guild-public',
          guildMember: { displayName: 'Speaker user-b', id: 'user-b', nickname: 'Speaker user-b' },
          guildName: 'Discord',
          memory: { shortTermLimit: 20 },
          owner: { configured: false, currentUserIsOwner: false },
        },
      ])
      for (const event of inputTextEvents)
        expectScalarDto(event.data)
      expect(discordMocks.sends).toEqual([
        { channelId: 'voice-public', content: 'Voice privacy notice.' },
        { channelId: 'voice-public', content: 'Voice privacy notice.' },
      ])

      harness.channel.members.delete('user-a')
      requireDiscordClient().emit(
        Events.VoiceStateUpdate,
        { channelId: 'voice-public', guild: harness.channel.guild, id: 'user-a', sessionId: 'voice-session-user-a' },
        { channelId: null, guild: harness.channel.guild, id: 'user-a', sessionId: null },
      )
      await harness.drain()
      harness.addParticipant('user-a')
      requireDiscordClient().emit(
        Events.VoiceStateUpdate,
        { channelId: null, guild: harness.channel.guild, id: 'user-a', sessionId: null },
        { channelId: 'voice-public', guild: harness.channel.guild, id: 'user-a', sessionId: 'voice-session-user-a' },
      )
      requireDiscordClient().emit(Events.InteractionCreate, harness.createConsentInteraction('user-a', consentId))
      await harness.drain()

      expect(privacyAndVoiceIngressOrder(bridgeMocks.order)).toEqual(['privacy-notice', 'input:text', 'privacy-notice', 'input:text'])
      const sentBeforeRateLimitedCapture = [...bridgeMocks.sent]
      const subscriptionsBeforeRateLimitedCapture = harness.connection.receiver.subscribe.mock.calls.length
      const transcriptionsBeforeRateLimitedCapture = speechMocks.transcribe.mock.calls.length
      harness.speaking.emit('start', 'user-a')
      await harness.drain()
      expect(harness.connection.receiver.subscribe).toHaveBeenCalledTimes(subscriptionsBeforeRateLimitedCapture)
      harness.feedSpeech('user-a')
      harness.speaking.emit('end', 'user-a')
      await harness.drain()
      expect(harness.connection.receiver.subscribe).toHaveBeenCalledTimes(subscriptionsBeforeRateLimitedCapture)
      expect(speechMocks.transcribe).toHaveBeenCalledTimes(transcriptionsBeforeRateLimitedCapture)
      expect(bridgeMocks.sent).toEqual(sentBeforeRateLimitedCapture)
    }
    finally {
      await adapter.stop()
    }
  })

  /**
   * @example
   * it('rejects a disallowed voice channel before subscribe, STT, or AIRI ingress', async () => {})
   */
  it('rejects a disallowed voice channel before subscribe, STT, or AIRI ingress', async () => {
    const harness = createDiscordVoiceHarness('guild-denied', 'voice-denied', 'user-a')
    harness.addParticipant('user-b')
    voiceMocks.joinVoiceChannel.mockReturnValue(harness.connection)
    const adapter = new DiscordAdapter({
      discordToken: 'public-test-token',
      transcription: { apiKey: 'public-test-key' },
    })

    try {
      await adapter.applyRuntimeConfig({
        allowedChannelIds: ['voice-allowed'],
        enabled: true,
        messagePacingMs: 0,
      })
      requireServerChannel().emitReady()

      const summon = harness.createSummonInteraction('user-a', 'summon-denied')
      requireDiscordClient().emit(Events.InteractionCreate, summon)
      await vi.waitFor(() => expect(summon.replies).toHaveLength(1))
      const consentId = requireConsentCustomId(summon.replies[0]!)

      requireDiscordClient().emit(Events.InteractionCreate, harness.createConsentInteraction('user-a', consentId))
      requireDiscordClient().emit(Events.InteractionCreate, harness.createConsentInteraction('user-b', consentId))
      await vi.waitFor(() => expect(voiceMocks.joinVoiceChannel).toHaveBeenCalledOnce())

      harness.speaking.emit('start', 'user-a')
      await harness.drain()
      harness.speaking.emit('end', 'user-a')
      await harness.drain()

      expect(harness.connection.receiver.subscribe).not.toHaveBeenCalled()
      expect(speechMocks.transcribe).not.toHaveBeenCalled()
      expect(bridgeMocks.sent).toEqual([])
    }
    finally {
      await adapter.stop()
    }
  })

  /**
   * ROOT CAUSE:
   *
   * A private map assertion can remain green after gateway ingress stops consulting
   * one of its shared layers. This public sequence makes each rejection observable
   * through the absence of canonical AIRI input and the absence of a Discord reply
   * for the rejected identity.
   *
   * @example
   * it('keeps exact, user, guild, and global quota admission atomic at public message ingress', async () => {})
   */
  it('keeps exact, user, guild, and global quota admission atomic at public message ingress', async () => {
    bridgeMocks.setSendResult(false)
    const adapter = new DiscordAdapter({ discordToken: 'public-test-token' })

    try {
      await adapter.applyRuntimeConfig({
        enabled: true,
        globalRateLimitMaxMessages: 4,
        guildRateLimitMaxMessages: 3,
        messagePacingMs: 0,
        privacyNoticeEnabled: false,
        rateLimitMaxMessages: 10,
        userRateLimitMaxMessages: 2,
      })
      requireServerChannel().emitReady()
      const client = requireDiscordClient()
      const messages = [
        createGuildMessage({ channelId: 'channel-1', guildId: 'guild-1', messageId: 'rate-1', userId: 'user-a' }),
        createGuildMessage({ channelId: 'channel-2', guildId: 'guild-1', messageId: 'rate-2', userId: 'user-a' }),
        createGuildMessage({ channelId: 'channel-3', guildId: 'guild-1', messageId: 'rate-3', userId: 'user-a' }),
        createGuildMessage({ channelId: 'channel-4', guildId: 'guild-1', messageId: 'rate-4', userId: 'user-b' }),
        createGuildMessage({ channelId: 'channel-5', guildId: 'guild-1', messageId: 'rate-5', userId: 'user-c' }),
        createGuildMessage({ channelId: 'channel-6', guildId: 'guild-2', messageId: 'rate-6', userId: 'user-d' }),
        createGuildMessage({ channelId: 'channel-7', guildId: 'guild-3', messageId: 'rate-7', userId: 'user-e' }),
      ]

      for (const message of messages) {
        client.emit(Events.MessageCreate, message)
        await client.drain()
      }

      expect(inputTextEvents().map(event => event.data.textRaw)).toEqual([
        '<@public-test-application> message-rate-1',
        '<@public-test-application> message-rate-2',
        '<@public-test-application> message-rate-4',
        '<@public-test-application> message-rate-6',
      ])
      expect(discordMocks.sends).toEqual([
        { channelId: 'channel-1', content: expect.stringContaining('AIRI received') },
        { channelId: 'channel-2', content: expect.stringContaining('AIRI received') },
        { channelId: 'channel-4', content: expect.stringContaining('AIRI received') },
        { channelId: 'channel-6', content: expect.stringContaining('AIRI received') },
      ])
    }
    finally {
      await adapter.stop()
    }
  })

  /**
   * ROOT CAUSE:
   *
   * Voice admission is a separate Discord surface, so testing a text rejection
   * alone cannot prove it spends the same public user quota as a transcribed turn.
   *
   * @example
   * it('shares user quota between blocked text, admitted voice, and later text ingress', async () => {})
   */
  it('shares user quota between blocked text, admitted voice, and later text ingress', async () => {
    const harness = createDiscordVoiceHarness('guild-mixed', 'voice-allowed', 'user-a')
    harness.addParticipant('user-b')
    voiceMocks.joinVoiceChannel.mockReturnValue(harness.connection)
    const adapter = new DiscordAdapter({
      discordToken: 'public-test-token',
      transcription: { apiKey: 'public-test-key' },
    })

    try {
      await adapter.applyRuntimeConfig({
        allowedChannelIds: ['voice-allowed', 'text-allowed'],
        enabled: true,
        globalRateLimitMaxMessages: 10,
        guildRateLimitMaxMessages: 10,
        messagePacingMs: 0,
        privacyNoticeEnabled: false,
        rateLimitMaxMessages: 10,
        userRateLimitMaxMessages: 1,
      })
      requireServerChannel().emitReady()
      const client = requireDiscordClient()
      client.emit(Events.MessageCreate, createGuildMessage({
        channelId: 'text-blocked',
        guildId: 'guild-mixed',
        messageId: 'mixed-blocked',
        userId: 'user-a',
      }))
      await client.drain()
      expect(inputTextEvents()).toEqual([])

      const summon = harness.createSummonInteraction('user-a', 'summon-mixed')
      client.emit(Events.InteractionCreate, summon)
      await vi.waitFor(() => expect(summon.replies).toHaveLength(1))
      const consentId = requireConsentCustomId(summon.replies[0]!)
      client.emit(Events.InteractionCreate, harness.createConsentInteraction('user-a', consentId))
      await harness.drain()
      client.emit(Events.InteractionCreate, harness.createConsentInteraction('user-b', consentId))
      await vi.waitFor(() => expect(voiceMocks.joinVoiceChannel).toHaveBeenCalledOnce())
      harness.speaking.emit('start', 'user-a')
      await vi.waitFor(() => expect(harness.connection.receiver.subscribe).toHaveBeenCalledWith('user-a', expect.anything()))
      harness.feedSpeech('user-a')
      harness.speaking.emit('end', 'user-a')
      await vi.waitFor(() => expect(speechMocks.transcribe).toHaveBeenCalledOnce(), { timeout: 3_000 })
      await harness.drain()

      client.emit(Events.MessageCreate, createGuildMessage({
        channelId: 'text-allowed',
        guildId: 'guild-mixed',
        messageId: 'mixed-after-voice',
        userId: 'user-a',
      }))
      await client.drain()

      expect(inputTextEvents()).toHaveLength(1)
      expect(speechMocks.transcribe).toHaveBeenCalledOnce()
      expect(bridgeMocks.sent.map(event => event.type)).toEqual(['input:text'])
    }
    finally {
      await adapter.stop()
    }
  })

  /**
   * ROOT CAUSE:
   *
   * Internal capacity checks are only meaningful if public ingress creates live
   * identities, fails closed at the exact bound, and releases expired state when
   * a later message reaches the adapter. This is a default-cap pressure test;
   * no internal map or cleanup function is inspected.
   *
   * @example
   * it('fails closed at public exact and layered capacities, then recovers after ingress sweep', async () => {})
   */
  it('fails closed at public exact and layered capacities, then recovers after ingress sweep', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    bridgeMocks.setSendResult(false)
    const exactAdapter = new DiscordAdapter({ discordToken: 'public-test-token' })
    const batchSize = 64
    const pressureStartedAt = performance.now()

    try {
      await exactAdapter.applyRuntimeConfig({
        enabled: true,
        globalRateLimitMaxMessages: 5_000,
        guildRateLimitMaxMessages: 2_000,
        messagePacingMs: 0,
        privacyNoticeEnabled: false,
        rateLimitMaxMessages: 100,
        rateLimitWindowMs: 1_000,
        userRateLimitMaxMessages: 200,
      })
      requireServerChannel().emitReady()
      const exactClient = requireDiscordClient()
      for (let index = 0; index < 1_024; index++) {
        exactClient.emit(Events.MessageCreate, createGuildMessage({
          channelId: `exact-channel-${index}`,
          guildId: 'exact-guild',
          messageId: `exact-message-${index}`,
          userId: `exact-user-${index % 6}`,
        }))
        if ((index + 1) % batchSize === 0)
          await exactClient.drain()
      }
      await exactClient.drain()
      expect(inputTextEvents()).toHaveLength(1_024)

      exactClient.emit(Events.MessageCreate, createGuildMessage({
        channelId: 'exact-channel-overflow',
        guildId: 'exact-guild',
        messageId: 'exact-message-overflow',
        userId: 'exact-user-overflow',
      }))
      await exactClient.drain()
      expect(inputTextEvents()).toHaveLength(1_024)

      vi.setSystemTime(Date.now() + 1_001)
      exactClient.emit(Events.MessageCreate, createGuildMessage({
        channelId: 'exact-channel-after-ttl',
        guildId: 'exact-guild',
        messageId: 'exact-message-after-ttl',
        userId: 'exact-user-after-ttl',
      }))
      await exactClient.drain()
      expect(inputTextEvents()).toHaveLength(1_025)
    }
    finally {
      await exactAdapter.stop()
    }

    bridgeMocks.channel = undefined
    bridgeMocks.order.length = 0
    bridgeMocks.sent.length = 0
    discordMocks.sends.length = 0
    const layeredAdapter = new DiscordAdapter({ discordToken: 'public-test-token' })
    try {
      await layeredAdapter.applyRuntimeConfig({
        enabled: true,
        globalRateLimitMaxMessages: 5_000,
        guildRateLimitMaxMessages: 2_000,
        messagePacingMs: 0,
        privacyNoticeEnabled: false,
        rateLimitMaxMessages: 0,
        rateLimitWindowMs: 60_000,
        userRateLimitMaxMessages: 200,
      })
      requireServerChannel().emitReady()
      const layeredClient = requireDiscordClient()
      for (let index = 0; index < 2_047; index++) {
        layeredClient.emit(Events.MessageCreate, createDmMessage({
          channelId: `layered-channel-${index}`,
          messageId: `layered-message-${index}`,
          userId: `layered-user-${index}`,
        }))
        if ((index + 1) % batchSize === 0)
          await layeredClient.drain()
      }
      await layeredClient.drain()
      expect(inputTextEvents()).toHaveLength(2_047)

      layeredClient.emit(Events.MessageCreate, createDmMessage({
        channelId: 'layered-channel-overflow-user',
        messageId: 'layered-message-overflow-user',
        userId: 'layered-user-overflow',
      }))
      await layeredClient.drain()
      expect(inputTextEvents()).toHaveLength(2_047)

      layeredClient.emit(Events.MessageCreate, createDmMessage({
        channelId: 'layered-channel-dedupe',
        messageId: 'layered-message-dedupe',
        userId: 'layered-user-0',
      }))
      await layeredClient.drain()
      expect(inputTextEvents()).toHaveLength(2_047)

      vi.setSystemTime(Date.now() + 60_001)
      layeredClient.emit(Events.MessageCreate, createDmMessage({
        channelId: 'layered-channel-after-ttl',
        messageId: 'layered-message-after-ttl',
        userId: 'layered-user-0',
      }))
      await layeredClient.drain()
      expect(inputTextEvents()).toHaveLength(2_048)
      const pressureRun = {
        batchSize,
        elapsedMs: performance.now() - pressureStartedAt,
        exactInputEvents: 1_025,
        layeredInputEvents: inputTextEvents().length,
      }
      expect(pressureRun).toMatchObject({
        batchSize: 64,
        exactInputEvents: 1_025,
        layeredInputEvents: 2_048,
      })
      expect(pressureRun.elapsedMs).toBeLessThan(30_000)
    }
    finally {
      await layeredAdapter.stop()
    }
  }, 30_000)

  /**
   * ROOT CAUSE:
   *
   * Bounded privacy, reply, dedupe, exact-rate, and layered user-rate state
   * must remain observable at the Discord boundary. The first cleanup input
   * exhausts both non-expired quota layers; re-enable succeeds only when disable
   * retires those buckets along with old reply correlation.
   *
   * @example
   * it('replays evicted and expired privacy notices, then clears ingress and reply state on disable', async () => {})
   */
  it('replays evicted and expired privacy notices, then clears ingress and reply state on disable', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    bridgeMocks.setSendResult(false)
    const privacyNotice = 'D-012 privacy notice.'
    const adapter = new DiscordAdapter({ discordToken: 'public-test-token' })

    try {
      const enabledConfig = {
        enabled: true,
        globalRateLimitMaxMessages: 5_000,
        guildRateLimitMaxMessages: 2_000,
        messagePacingMs: 0,
        privacyNoticeEnabled: true,
        privacyNoticeText: privacyNotice,
        rateLimitMaxMessages: 0,
        userRateLimitMaxMessages: 200,
      } as const
      await adapter.applyRuntimeConfig(enabledConfig)
      requireServerChannel().emitReady()
      const client = requireDiscordClient()
      for (let index = 0; index < 257; index++) {
        client.emit(Events.MessageCreate, createDmMessage({
          channelId: `privacy-channel-${index}`,
          messageId: `privacy-message-${index}`,
          userId: `privacy-user-${index}`,
        }))
        await client.drain()
      }
      await client.drain()
      const privacySends = () => discordMocks.sends.filter(send => send.content === privacyNotice)
      expect(privacySends()).toHaveLength(257)

      client.emit(Events.MessageCreate, createDmMessage({
        channelId: 'privacy-channel-0',
        messageId: 'privacy-message-0-revisit',
        userId: 'privacy-user-0',
      }))
      await client.drain()
      expect(privacySends()).toHaveLength(258)

      client.emit(Events.MessageCreate, createDmMessage({
        channelId: 'privacy-channel-256',
        messageId: 'privacy-message-256-revisit',
        userId: 'privacy-user-256',
      }))
      await client.drain()
      expect(privacySends()).toHaveLength(258)

      vi.setSystemTime(Date.now() + 24 * 60 * 60 * 1_000 + 1)
      client.emit(Events.MessageCreate, createDmMessage({
        channelId: 'privacy-channel-256',
        messageId: 'privacy-message-256-expired',
        userId: 'privacy-user-256',
      }))
      await client.drain()
      expect(privacySends()).toHaveLength(259)

      const inputCountBeforeCleanup = inputTextEvents().length
      const privacySendCountBeforeCleanup = privacySends().length
      const cleanupConfig = {
        ...enabledConfig,
        rateLimitMaxMessages: 1,
        rateLimitWindowMs: 60_000,
        userRateLimitMaxMessages: 1,
      } as const
      await adapter.applyRuntimeConfig(cleanupConfig)
      bridgeMocks.setSendResult(true)
      client.emit(Events.MessageCreate, createDmMessage({
        channelId: 'old-channel',
        messageId: 'cleanup-message',
        userId: 'cleanup-user',
      }))
      await client.drain()
      const oldInput = inputTextEvents().at(-1)
      if (!oldInput)
        throw new Error('The cleanup ingress did not produce a canonical input.')
      expect(inputTextEvents()).toHaveLength(inputCountBeforeCleanup + 1)
      expect(privacySends()).toHaveLength(privacySendCountBeforeCleanup + 1)
      const sentBeforeDisable = [...bridgeMocks.sent]

      await adapter.applyRuntimeConfig({ enabled: false })
      const cancellations = bridgeMocks.sent.slice(sentBeforeDisable.length)
      expect(cancellations).toHaveLength(1)
      expect(cancellations[0]).toMatchObject({
        data: {
          reason: 'disabled',
          sessionId: 'discord-dm-cleanup-user',
          turn: oldInput.data.turn,
        },
        type: 'chat:turn:cancel',
      })
      client.emit(Events.MessageCreate, createDmMessage({
        channelId: 'disabled-channel',
        messageId: 'disabled-message',
        userId: 'cleanup-user',
      }))
      await client.drain()
      expect(bridgeMocks.sent).toHaveLength(sentBeforeDisable.length + 1)

      await adapter.applyRuntimeConfig(cleanupConfig)
      client.emit(Events.MessageCreate, createDmMessage({
        channelId: 'new-channel',
        messageId: 'cleanup-message',
        userId: 'cleanup-user',
      }))
      await client.drain()
      const newInput = inputTextEvents().at(-1)
      if (!newInput)
        throw new Error('The re-enabled cleanup ingress did not produce a canonical input.')
      expect(inputTextEvents()).toHaveLength(inputCountBeforeCleanup + 2)
      expect(newInput.data.overrides?.sessionId).toBe('discord-dm-cleanup-user')
      expect(privacySends()).toHaveLength(privacySendCountBeforeCleanup + 2)
      expect(privacySends().at(-1)).toEqual({ channelId: 'new-channel', content: privacyNotice })

      const outputListener = requireOutputChatMessageListener()
      const sendsBeforeOldOutput = [...discordMocks.sends]
      await outputListener(createOutputChatMessage(oldInput, 'old output must be ignored'))
      expect(discordMocks.sends).toEqual(sendsBeforeOldOutput)
      await outputListener(createOutputChatMessage(newInput, 'new output reaches only the new channel'))
      expect(discordMocks.sends.at(-1)).toEqual({
        channelId: 'new-channel',
        content: 'new output reaches only the new channel',
      })
    }
    finally {
      await adapter.stop()
    }
  })

  /**
   * ROOT CAUSE:
   *
   * Private listener tests can remain green when the gateway no longer wires
   * MessageCreate into authoritative reply resolution. This public boundary
   * accepts only a Discord Reply/Default reference fetched from the current bot,
   * and makes every failed lookup observable as no outbound AIRI ingress.
   *
   * @example
   * it('resolves mentionless guild replies only from authoritative bot references', async () => {})
   */
  it('resolves mentionless guild replies only from authoritative bot references', async () => {
    bridgeMocks.setSendResult(false)
    const adapter = new DiscordAdapter({ discordToken: 'public-test-token' })

    try {
      await adapter.applyRuntimeConfig({
        allowedChannelIds: ['reply-channel-valid', 'reply-channel-rejected', 'reply-channel-nonbot', 'reply-channel-forwarded'],
        enabled: true,
        globalRateLimitMaxMessages: 10,
        guildRateLimitMaxMessages: 10,
        messagePacingMs: 0,
        privacyNoticeEnabled: false,
        rateLimitMaxMessages: 10,
        userRateLimitMaxMessages: 10,
      })
      requireServerChannel().emitReady()
      const client = requireDiscordClient()
      const validReply = createGuildReplyMessage({
        channelId: 'reply-channel-valid',
        guildId: 'reply-guild-valid',
        messageId: 'reply-valid',
        referenceType: MessageReferenceType.Default,
        referencedAuthorId: async () => 'public-test-application',
        userId: 'reply-user-valid',
      })
      const rejectedReply = createGuildReplyMessage({
        channelId: 'reply-channel-rejected',
        guildId: 'reply-guild-rejected',
        messageId: 'reply-rejected',
        referenceType: MessageReferenceType.Default,
        referencedAuthorId: async () => { throw new Error('Discord reference fetch failed.') },
        userId: 'reply-user-rejected',
      })
      const nonBotReply = createGuildReplyMessage({
        channelId: 'reply-channel-nonbot',
        guildId: 'reply-guild-nonbot',
        messageId: 'reply-nonbot',
        referenceType: MessageReferenceType.Default,
        referencedAuthorId: async () => 'another-discord-user',
        userId: 'reply-user-nonbot',
      })
      const forwardedReply = createGuildReplyMessage({
        channelId: 'reply-channel-forwarded',
        guildId: 'reply-guild-forwarded',
        messageId: 'reply-forwarded',
        referenceType: MessageReferenceType.Forward,
        referencedAuthorId: async () => 'public-test-application',
        userId: 'reply-user-forwarded',
      })

      expect(validReply.message.content).not.toContain('public-test-application')
      client.emit(Events.MessageCreate, validReply.message)
      await client.drain()
      expect(validReply.fetchReference).toHaveBeenCalledOnce()
      expect(inputTextEvents()).toHaveLength(1)
      const acceptedInput = inputTextEvents()[0]
      if (!acceptedInput)
        throw new Error('The authoritative reply did not produce a canonical input.')
      expect(acceptedInput.data).toMatchObject({
        discord: {
          channelId: 'reply-channel-valid',
          guildId: 'reply-guild-valid',
          guildMember: { id: 'reply-user-valid' },
        },
        overrides: {
          sessionId: 'discord-guild-reply-guild-valid-channel-reply-channel-valid-user-reply-user-valid',
        },
        text: 'reply-reply-valid',
        textRaw: 'reply-reply-valid',
      })
      const outboundAfterValidReply = [...bridgeMocks.sent]
      const discordSendsAfterValidReply = [...discordMocks.sends]

      client.emit(Events.MessageCreate, rejectedReply.message)
      await client.drain()
      expect(rejectedReply.fetchReference).toHaveBeenCalledOnce()
      expect(bridgeMocks.sent).toEqual(outboundAfterValidReply)
      expect(discordMocks.sends).toEqual(discordSendsAfterValidReply)

      client.emit(Events.MessageCreate, nonBotReply.message)
      await client.drain()
      expect(nonBotReply.fetchReference).toHaveBeenCalledOnce()
      expect(bridgeMocks.sent).toEqual(outboundAfterValidReply)
      expect(discordMocks.sends).toEqual(discordSendsAfterValidReply)

      client.emit(Events.MessageCreate, forwardedReply.message)
      await client.drain()
      expect(forwardedReply.fetchReference).not.toHaveBeenCalled()
      expect(bridgeMocks.sent).toEqual(outboundAfterValidReply)
      expect(discordMocks.sends).toEqual(discordSendsAfterValidReply)
      expect(bridgeMocks.sent.map(event => event.type)).toEqual(['input:text'])
    }
    finally {
      await adapter.stop()
    }
  })
})
