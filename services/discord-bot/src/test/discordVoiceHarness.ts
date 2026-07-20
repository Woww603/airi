import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

import { vi } from 'vitest'

import { createOpusPcm16Fixture } from './pcmFixtures'

/** Public Discord interaction reply shape needed to inspect consent components. */
export interface PublicVoiceReply {
  allowedMentions?: { parse: string[] }
  components?: Array<{ toJSON: () => { components: Array<{ custom_id?: string }> } }>
  content?: string
  ephemeral?: boolean
}

/** Structural slash-command interaction that reaches the adapter through Client.emit. */
export interface PublicSummonInteraction {
  commandName: 'summon'
  guildId: string
  id: string
  inCachedGuild: () => boolean
  isButton: () => boolean
  isChatInputCommand: () => boolean
  member: { voice: { channel: PublicVoiceChannelFixture['channel'] } }
  memberPermissions: { has: () => boolean }
  replies: PublicVoiceReply[]
  reply: ReturnType<typeof vi.fn<(reply: PublicVoiceReply) => Promise<void>>>
  user: { id: string }
}

/** Structural button interaction that applies one public voice-consent decision. */
export interface PublicConsentInteraction {
  customId: string
  guildId: string
  inCachedGuild: () => boolean
  isButton: () => boolean
  member: { voice: { channelId: string, sessionId: string } }
  replies: PublicVoiceReply[]
  reply: ReturnType<typeof vi.fn<(reply: PublicVoiceReply) => Promise<void>>>
  update: ReturnType<typeof vi.fn<(reply: PublicVoiceReply) => Promise<void>>>
  user: { id: string }
}

/** Structural public Discord voice fixture; concrete Discord casts stay with each consumer test. */
export interface PublicVoiceChannelFixture {
  addParticipant: (userId: string) => void
  channel: {
    guild: { id: string, members: { me: undefined }, voiceAdapterCreator: object }
    guildId: string
    id: string
    members: Map<string, { displayName: string, guild: object, id: string, user: { bot: boolean } }>
    name: string
  }
  createConsentInteraction: (userId: string, customId: string) => PublicConsentInteraction
  createSummonInteraction: (userId: string, interactionId: string) => PublicSummonInteraction
  connection: EventEmitter & {
    destroy: ReturnType<typeof vi.fn>
    joinConfig: { channelId: string, guildId: string }
    receiver: { speaking: EventEmitter, subscribe: ReturnType<typeof vi.fn> }
    state: { status: string }
    subscribe: ReturnType<typeof vi.fn>
  }
  drain: () => Promise<void>
  feedSpeech: (userId: string, packetCount?: number) => void
  receiveStream: PassThrough
  receiveStreams: Map<string, PassThrough>
  speaking: EventEmitter
  userId: string
}

/** Builds a public receiver/speaking transport without depending on Discord concrete types. */
export function createDiscordVoiceHarness(guildId: string, channelId: string, userId: string): PublicVoiceChannelFixture {
  const receiveStreams = new Map<string, PassThrough>()
  const speaking = new EventEmitter()
  const guild = { id: guildId, members: { me: undefined }, voiceAdapterCreator: {} }
  const members = new Map<string, { displayName: string, guild: object, id: string, user: { bot: boolean }, voice: { channelId: string, sessionId: string } }>()
  const addParticipant = (participantId: string) => {
    receiveStreams.set(participantId, new PassThrough())
    members.set(participantId, {
      displayName: `Speaker ${participantId}`,
      guild,
      id: participantId,
      user: { bot: false },
      voice: { channelId, sessionId: `voice-session-${participantId}` },
    })
  }
  addParticipant(userId)
  const connection = Object.assign(new EventEmitter(), {
    destroy: vi.fn(),
    joinConfig: { channelId, guildId },
    receiver: { speaking, subscribe: vi.fn((requestedUserId: string) => receiveStreams.get(requestedUserId)) },
    state: { status: 'ready' },
    subscribe: vi.fn(() => ({ unsubscribe: vi.fn() })),
  })
  const channel = { guild, guildId, id: channelId, members, name: channelId }
  const createSummonInteraction = (participantId: string, interactionId: string): PublicSummonInteraction => {
    const replies: PublicVoiceReply[] = []
    return {
      commandName: 'summon',
      guildId,
      id: interactionId,
      inCachedGuild: () => true,
      isButton: () => false,
      isChatInputCommand: () => true,
      member: { voice: { channel } },
      memberPermissions: { has: () => true },
      replies,
      reply: vi.fn(async (reply: PublicVoiceReply) => { replies.push(reply) }),
      user: { id: participantId },
    }
  }
  const createConsentInteraction = (participantId: string, customId: string): PublicConsentInteraction => {
    const replies: PublicVoiceReply[] = []
    return {
      customId,
      guildId,
      inCachedGuild: () => true,
      isButton: () => true,
      member: { voice: { channelId, sessionId: `voice-session-${participantId}` } },
      replies,
      reply: vi.fn(async (reply: PublicVoiceReply) => { replies.push(reply) }),
      update: vi.fn(async (reply: PublicVoiceReply) => { replies.push(reply) }),
      user: { id: participantId },
    }
  }
  const feedSpeech = (participantId: string, packetCount = 6) => {
    const stream = receiveStreams.get(participantId)
    if (!stream)
      throw new Error(`Unknown voice fixture participant: ${participantId}`)
    const opus = createOpusPcm16Fixture()
    for (let index = 0; index < packetCount; index += 1)
      stream.write(opus.nextSpeechPacket())
  }
  return {
    addParticipant,
    channel,
    createConsentInteraction,
    createSummonInteraction,
    connection,
    drain: async () => {
      await new Promise<void>(resolve => setImmediate(resolve))
      await new Promise<void>(resolve => setImmediate(resolve))
    },
    feedSpeech,
    receiveStream: receiveStreams.get(userId)!,
    receiveStreams,
    speaking,
    userId,
  }
}
