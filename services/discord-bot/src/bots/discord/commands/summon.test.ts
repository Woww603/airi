import type { AudioPlayer, AudioResource, VoiceConnection, VoiceConnectionState } from '@discordjs/voice'
import type { BaseGuildVoiceChannel, ButtonInteraction, ChatInputCommandInteraction, Client as DiscordClient, GuildMember, VoiceState } from 'discord.js'

import type { RealtimeVoiceCallSessionEvents } from './summon'
import type { VoiceDiagnosticSignal, VoiceDiagnosticsObserver } from './voiceDiagnostics'

import { Buffer } from 'node:buffer'
import { EventEmitter } from 'node:events'
import { Readable as NodeReadable, PassThrough } from 'node:stream'

import { createAudioPlayer, createAudioResource, demuxProbe, entersState, getVoiceConnections, joinVoiceChannel, StreamType } from '@discordjs/voice'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { QwenRealtimeRuntime, resolveQwenRealtimeConfig } from '../../../standalone/qwen-realtime'
import { StandaloneVoiceDiagnostics } from '../../../standalone/voiceDiagnostics'
import { createDiscordVoiceHarness } from '../../../test/discordVoiceHarness'
import { createOpusPcm16Fixture, createPcm16Cursor, speechPcm16 } from '../../../test/pcmFixtures'
import { VoiceManager } from './summon'

vi.mock('@discordjs/voice', () => ({
  createAudioPlayer: vi.fn(),
  createAudioResource: vi.fn(),
  demuxProbe: vi.fn(async (stream: NodeReadable) => ({ stream, type: 'ogg/opus' })),
  entersState: vi.fn(async () => {}),
  getVoiceConnections: vi.fn(() => new Map()),
  joinVoiceChannel: vi.fn(),
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

const voiceMocks = {
  createAudioPlayer: vi.mocked(createAudioPlayer, { partial: true }),
  createAudioResource: vi.mocked(createAudioResource, { partial: true }),
  demuxProbe: vi.mocked(demuxProbe, { partial: true }),
  entersState: vi.mocked(entersState, { partial: true }),
  getVoiceConnections: vi.mocked(getVoiceConnections, { partial: true }),
  joinVoiceChannel: vi.mocked(joinVoiceChannel, { partial: true }),
}

function resetVoiceMocks(): void {
  vi.resetAllMocks()
  voiceMocks.createAudioPlayer.mockImplementation(() => createMock<AudioPlayer>({
    on: vi.fn(),
    play: vi.fn(),
    removeAllListeners: vi.fn(),
    state: { status: 'idle' },
    stop: vi.fn(),
  }))
  voiceMocks.createAudioResource.mockReturnValue(createMock<AudioResource<null>>({}))
  voiceMocks.entersState.mockResolvedValue({})
  voiceMocks.getVoiceConnections.mockReturnValue(createMock<Map<string, VoiceConnection>>(new Map()))
  voiceMocks.demuxProbe.mockImplementation(async stream => ({ stream, type: StreamType.OggOpus }))
}

beforeEach(() => {
  resetVoiceMocks()
})

afterEach(() => {
  vi.useRealTimers()
  resetVoiceMocks()
})

function createManager() {
  return new VoiceManager(
    createMock<DiscordClient>({ user: { id: 'bot-user' } }),
    async () => undefined,
    async () => '',
  )
}

function createMock<T extends object>(value: object): T {
  return value as T
}

/** Builds a real public receiver/provider boundary for capacity regressions. */
async function createPublicCapacityHarness(acknowledgeAppend: boolean) {
  let providerEvents: RealtimeVoiceCallSessionEvents = {}
  const diagnostics: VoiceDiagnosticSignal[] = []
  const receiveStream = new PassThrough()
  const player = {
    on: vi.fn(),
    play: vi.fn(),
    removeAllListeners: vi.fn(),
    state: { status: 'idle' },
    stop: vi.fn(),
  }
  voiceMocks.createAudioPlayer.mockReturnValue(createMock<AudioPlayer>(player))
  const provider = {
    abortInput: vi.fn(),
    appendAudio: vi.fn((pcm: Buffer, inputSequence: number) => {
      if (acknowledgeAppend)
        providerEvents.onInputAudioSent?.({ byteLength: pcm.length, chunkCount: 1, inputSequence, kind: 'user-audio' })
      return true
    }),
    cancelResponse: vi.fn(),
    close: vi.fn(),
    finishInput: vi.fn(),
  }
  const runtime = {
    connect: vi.fn(async (events: RealtimeVoiceCallSessionEvents) => {
      providerEvents = events
      return provider
    }),
    getInterruptionRmsThreshold: () => 0.04,
    getMode: () => 'qwen-realtime' as const,
    isConfigured: () => true,
  }
  const speaking = new EventEmitter()
  const connection = Object.assign(new EventEmitter(), {
    destroy: vi.fn(),
    receiver: {
      speaking,
      subscribe: vi.fn(() => receiveStream),
    },
    state: { status: 'ready' },
    subscribe: vi.fn(() => ({ unsubscribe: vi.fn() })),
  })
  voiceMocks.joinVoiceChannel.mockReturnValue(createMock<VoiceConnection>(connection))
  const manager = new VoiceManager(
    createMock<DiscordClient>({ user: { id: 'bot-user' } }),
    async () => undefined,
    async () => '',
    runtime,
    undefined,
    undefined,
    undefined,
    { record: signal => diagnostics.push({ ...signal }), runtimeSequence: 51 },
  )
  const guild = { id: 'guild-capacity', members: { me: undefined }, voiceAdapterCreator: {} }
  const channel = createMock<BaseGuildVoiceChannel>({
    guild,
    guildId: guild.id,
    id: 'voice-capacity',
    members: new Map([['user-1', {
      displayName: 'Capacity speaker',
      guild,
      id: 'user-1',
      user: { bot: false },
    }]]),
    name: 'Capacity voice',
  })
  await manager.joinChannel(createMock<ChatInputCommandInteraction>({ reply: vi.fn(async () => {}) }), channel)
  return { channel, connection, diagnostics, manager, player, provider, providerEvents: () => providerEvents, receiveStream }
}

/** Starts one real Discord receiver capture and writes enough PCM for local admission. */
async function beginPublicCapacityCapture(
  harness: Awaited<ReturnType<typeof createPublicCapacityHarness>>,
  packets: ReturnType<typeof createOpusPcm16Fixture>,
): Promise<void> {
  harness.connection.receiver.speaking.emit('start', 'user-1')
  await vi.runAllTicks()
  for (let frame = 0; frame < 6; frame += 1)
    harness.receiveStream.write(packets.nextSpeechPacket())
}

/** Starts and completes one real Discord receiver capture, returning its public provider sequence. */
async function completePublicCapacityCapture(
  harness: Awaited<ReturnType<typeof createPublicCapacityHarness>>,
  packets: ReturnType<typeof createOpusPcm16Fixture>,
): Promise<number> {
  const appendedBefore = harness.provider.appendAudio.mock.calls.length
  await beginPublicCapacityCapture(harness, packets)
  await vi.waitFor(() => expect(harness.provider.appendAudio.mock.calls.length).toBeGreaterThan(appendedBefore))
  const inputSequence = harness.provider.appendAudio.mock.calls.at(-1)?.[1]
  if (!inputSequence)
    throw new Error('Each actual receiver capture must reach the public appendAudio boundary.')
  harness.connection.receiver.speaking.emit('end', 'user-1')
  await vi.runAllTicks()
  return inputSequence
}

/** Drives 65 publicly admitted captures while the provider withholds every formal acknowledgement. */
async function overflowPublicCapacityWithoutAcknowledgements() {
  const harness = await createPublicCapacityHarness(false)
  const packets = createOpusPcm16Fixture()
  const captures: number[] = []

  for (let capture = 1; capture <= 64; capture += 1)
    captures.push(await completePublicCapacityCapture(harness, packets))
  await beginPublicCapacityCapture(harness, packets)
  await vi.runAllTicks()
  return { captures, harness }
}

/** Creates one public Discord receiver boundary used by Qwen lifecycle regressions. */
function createPublicRealtimeChannel(guildId: string, channelId: string, userId: string) {
  const harness = createDiscordVoiceHarness(guildId, channelId, userId)
  return { ...harness, channel: createMock<BaseGuildVoiceChannel>(harness.channel) }
}

/** Drives a locally admitted capture to the public provider append boundary. */
async function appendPublicRealtimeInput(
  fixture: ReturnType<typeof createPublicRealtimeChannel>,
  provider: { appendAudio: ReturnType<typeof vi.fn> },
): Promise<number> {
  const appendedBefore = provider.appendAudio.mock.calls.length
  fixture.speaking.emit('start', fixture.userId)
  await vi.waitFor(() => expect(fixture.connection.receiver.subscribe).toHaveBeenCalled())
  const packets = createOpusPcm16Fixture()
  for (let frame = 0; frame < 6; frame += 1)
    fixture.receiveStream.write(packets.nextSpeechPacket())
  await vi.waitFor(() => expect(provider.appendAudio.mock.calls.length).toBeGreaterThan(appendedBefore))
  const inputSequence = provider.appendAudio.mock.calls.at(-1)?.[1]
  if (!inputSequence)
    throw new Error('A public receiver capture must reach provider.appendAudio before provider callbacks run.')
  return inputSequence
}

/** @example it('accepts nested synchronous provider acknowledgements in LIFO callback order', async () => {}) */
it('accepts nested synchronous provider acknowledgements in LIFO callback order', async () => {
  // ROOT CAUSE:
  //
  // A provider append may synchronously trigger another active Discord capture
  // before its own acknowledgement returns. A single mutable active sequence
  // loses the outer invocation after the inner callback clears it, incorrectly
  // treating the valid 2 -> 1 callback order as a late provider event.
  //
  // The correlation boundary must therefore model nested append invocations as
  // a stack: inner capture 2 acknowledges first, then outer capture 1 resumes.
  let providerEvents: RealtimeVoiceCallSessionEvents = {}
  const diagnostics: VoiceDiagnosticSignal[] = []
  const outerStream = new PassThrough()
  const innerStream = new PassThrough()
  const outerPackets = createOpusPcm16Fixture()
  const innerPackets = createOpusPcm16Fixture()
  const acknowledgedSequences: number[] = []
  let releasedInnerPackets = false
  const provider = {
    abortInput: vi.fn(),
    appendAudio: vi.fn((pcm: Buffer, inputSequence: number) => {
      if (inputSequence === 1 && !releasedInnerPackets) {
        releasedInnerPackets = true
        for (let frame = 0; frame < 6; frame += 1)
          innerStream.write(innerPackets.nextSpeechPacket())
      }
      acknowledgedSequences.push(inputSequence)
      providerEvents.onInputAudioSent?.({ byteLength: pcm.length, chunkCount: 1, inputSequence, kind: 'user-audio' })
      return true
    }),
    cancelResponse: vi.fn(),
    close: vi.fn(),
    finishInput: vi.fn(),
  }
  const runtime = {
    connect: vi.fn(async (events: RealtimeVoiceCallSessionEvents) => {
      providerEvents = events
      return provider
    }),
    getInterruptionRmsThreshold: () => 0.04,
    getMode: () => 'qwen-realtime' as const,
    isConfigured: () => true,
  }
  const speaking = new EventEmitter()
  const connection = Object.assign(new EventEmitter(), {
    destroy: vi.fn(),
    receiver: {
      speaking,
      subscribe: vi.fn((userId: string) => userId === 'outer-user' ? outerStream : innerStream),
    },
    state: { status: 'ready' },
    subscribe: vi.fn(() => ({ unsubscribe: vi.fn() })),
  })
  voiceMocks.joinVoiceChannel.mockReturnValue(createMock<VoiceConnection>(connection))
  const guild = { id: 'guild-nested', members: { me: undefined }, voiceAdapterCreator: {} }
  const channel = createMock<BaseGuildVoiceChannel>({
    guild,
    guildId: guild.id,
    id: 'voice-nested',
    members: new Map([
      ['outer-user', { displayName: 'Outer', guild, id: 'outer-user', user: { bot: false } }],
      ['inner-user', { displayName: 'Inner', guild, id: 'inner-user', user: { bot: false } }],
    ]),
    name: 'Nested voice',
  })
  const manager = new VoiceManager(
    createMock<DiscordClient>({ user: { id: 'bot-user' } }),
    async () => undefined,
    async () => '',
    runtime,
    undefined,
    undefined,
    undefined,
    { record: signal => diagnostics.push({ ...signal }), runtimeSequence: 73 },
  )

  await manager.joinChannel(createMock<ChatInputCommandInteraction>({ reply: vi.fn(async () => {}) }), channel)
  speaking.emit('start', 'outer-user')
  speaking.emit('start', 'inner-user')
  await vi.waitFor(() => expect(connection.receiver.subscribe).toHaveBeenCalledTimes(2))
  for (let frame = 0; frame < 6; frame += 1)
    outerStream.write(outerPackets.nextSpeechPacket())

  await vi.waitFor(() => expect(provider.appendAudio.mock.calls.length).toBeGreaterThan(1))
  expect(provider.appendAudio.mock.calls.map(([, inputSequence]) => inputSequence)).toContain(1)
  expect(provider.appendAudio.mock.calls.map(([, inputSequence]) => inputSequence)).toContain(2)
  expect(acknowledgedSequences.at(-1)).toBe(1)
  expect(acknowledgedSequences.slice(0, -1)).toEqual(expect.arrayContaining([2]))
  expect(provider.abortInput).not.toHaveBeenCalled()
  expect(provider.cancelResponse).not.toHaveBeenCalled()
  expect(provider.close).not.toHaveBeenCalled()
  const userAppends = diagnostics.filter(
    (signal): signal is Extract<VoiceDiagnosticSignal, { stage: 'provider-input-appended' }> => signal.stage === 'provider-input-appended' && signal.inputKind === 'user-audio',
  )
  expect(userAppends.map(signal => signal.turnSequence)).toContain(2)
  expect(userAppends.map(signal => signal.turnSequence)).toContain(1)

  providerEvents.onInputCommitted?.({ inputSequence: 1, itemId: 'nested-item' })
  const committed = diagnostics.filter(
    (signal): signal is Extract<VoiceDiagnosticSignal, { stage: 'provider-input-committed' }> => signal.stage === 'provider-input-committed',
  )
  expect(committed).toEqual([
    expect.objectContaining({
      aggregateTurnSequence: 1,
      captureTurnSequences: [1, 2],
      turnSequence: 1,
    }),
  ])
  await manager.stop()
})

/**
 * @example
 * describe('voice manager lifecycle safety', () => {})
 */
describe('voice manager lifecycle safety', () => {
  /**
   * @example
   * it('Discord audit D-030 binds classic provider Opus bytes to Ogg Opus playback', async () => {})
   */
  it('binds classic provider Opus bytes to Ogg Opus playback for Discord audit D-030', async () => {
    const manager = createManager()
    const player = {
      on: vi.fn(),
      play: vi.fn(),
      removeAllListeners: vi.fn(),
      state: { status: 'idle' },
      stop: vi.fn(),
    }
    voiceMocks.createAudioPlayer.mockReturnValue(createMock<AudioPlayer>(player))
    voiceMocks.createAudioResource.mockReturnValue(createMock<AudioResource<null>>({ synthetic: 'resource' }))
    const audioStream = NodeReadable.from(Buffer.from('synthetic-ogg-opus'))

    // ROOT CAUSE:
    //
    // Classic playback marked MP3 bytes as an arbitrary stream. That chooses
    // Discord Voice's FFmpeg path and makes a clean packaged runtime fail before
    // it can play the already-supported Ogg Opus transport.
    await manager.playAudioStream(
      createMock<VoiceConnection>({ subscribe: vi.fn() }),
      audioStream,
      new AbortController().signal,
      { channelId: 'voice-d030', generation: 1, guildId: 'guild-d030' },
      Number.MAX_SAFE_INTEGER,
    )

    /** @example expect(voiceMocks.createAudioResource).toHaveBeenCalledWith( expect.anything(), { inputType: 'ogg/opus' }, ) */
    expect(voiceMocks.createAudioResource).toHaveBeenCalledWith(
      expect.anything(),
      { inputType: 'ogg/opus' },
    )
  })

  /**
   * @example
   * it('closes the active voice session and monitors when dismissed', async () => {})
   */
  it('closes the active voice session and monitors when dismissed', async () => {
    const connection = {
      destroy: vi.fn(),
      joinConfig: {
        channelId: 'voice-1',
        guildId: 'guild-1',
      },
      state: { status: 'ready' },
    }
    voiceMocks.getVoiceConnections.mockReturnValue(createMock<Map<string, VoiceConnection>>(new Map([['guild-1', connection]])))
    const manager = createManager()
    const close = vi.fn()
    const stop = vi.fn()
    const scope = { channelId: 'voice-1', generation: 1, guildId: 'guild-1' }
    Reflect.get(manager, 'connections').set('voice-1', connection)
    Reflect.get(manager, 'realtimeSessions').set('guild-1:voice-1:1', {
      abortController: new AbortController(),
      committedInputItemIds: new Set(),
      committedInputTurnSequences: [],
      finishedInputTurnSequences: [],
      inputItemTurnSequences: new Map(),
      observedSpeechItemIds: new Set(),
      providerInputByTurn: new Map(),
      responseMetricsByTurn: new Map(),
      responseTurnSequences: new Map(),
      retiredInputItemIds: new Set(),
      retiredResponseIds: new Set(),
      provider: {
        appendAudio: vi.fn(() => true),
        cancelResponse: vi.fn(),
        close,
        finishInput: vi.fn(),
      },
      scope,
      terminated: false,
    })
    Reflect.get(manager, 'activeMonitors').set('guild-1:voice-1:1:user-1', {
      admitted: true,
      scope,
      stop,
      userId: 'user-1',
    })
    const reply = vi.fn(async () => {})
    const interaction = createMock<ChatInputCommandInteraction>({
      guildId: 'guild-1',
      reply,
    })

    // ROOT CAUSE:
    //
    // The leave handler previously destroyed only the Discord voice connection.
    // Realtime sessions and receive monitors could survive until a later state
    // event, leaving provider sockets and microphone streams active after exit.
    await manager.handleLeaveChannelCommand(interaction)

    expect(connection.destroy).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledOnce()
    expect(stop).toHaveBeenCalledOnce()
    expect(reply).toHaveBeenCalledWith('Left the voice channel.')
  })

  /**
   * @example
   * it('publishes consent before waiting for a slow voice connection', async () => {})
   */
  it('publishes consent before waiting for a slow voice connection', async () => {
    let releaseVoiceConnection = () => {}
    const voiceConnectionReady = new Promise<void>((resolve) => {
      releaseVoiceConnection = resolve
    })
    voiceMocks.entersState.mockImplementation(async () => {
      await voiceConnectionReady
      return {}
    })
    const connection = {
      destroy: vi.fn(),
      on: vi.fn(),
      receiver: {
        speaking: {
          on: vi.fn(),
        },
      },
      state: { status: 'ready' },
    }
    voiceMocks.joinVoiceChannel.mockReturnValue(createMock<VoiceConnection>(connection))
    const manager = createManager()
    const channel = createMock<BaseGuildVoiceChannel>({
      guild: {
        id: 'guild-1',
        members: { me: undefined },
        voiceAdapterCreator: {},
      },
      guildId: 'guild-1',
      id: 'voice-1',
      members: new Map([['user-1', { id: 'user-1', user: { bot: false } }]]),
      name: 'Voice',
    })
    const editReply = vi.fn(async () => {})
    const reply = vi.fn(async () => {})
    const interaction = createMock<ChatInputCommandInteraction>({
      editReply,
      id: '1',
      inCachedGuild: () => true,
      member: { voice: { channel } },
      reply,
    })

    await manager.handleJoinChannelCommand(interaction)
    const update = vi.fn(async () => {})
    const consentTask = manager.handleConsentInteraction(createMock<ButtonInteraction>({
      customId: 'airi:voice-consent:opt-in:guild-1-1',
      followUp: vi.fn(async () => {}),
      guildId: 'guild-1',
      inCachedGuild: () => true,
      member: { voice: { channelId: 'voice-1', sessionId: 'participant-session-user-1' } },
      update,
      user: { id: 'user-1' },
    }))
    await Promise.resolve()
    const noticePublishedBeforeConnection = reply.mock.calls.length
    releaseVoiceConnection()
    await consentTask

    expect(noticePublishedBeforeConnection).toBe(1)
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringMatching(/opt.?in/i) }))
    expect(update).toHaveBeenCalled()
    expect(editReply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('Consent: 1/1') }))
  })

  /**
   * @example
   * it('reports a consented voice connection failure without leaving capture active', async () => {})
   */
  it('reports a consented voice connection failure without leaving capture active', async () => {
    voiceMocks.entersState.mockRejectedValue(new Error('voice transport unavailable'))
    const connection = {
      destroy: vi.fn(),
      receiver: {
        speaking: {
          on: vi.fn(),
        },
      },
      state: { status: 'connecting' },
    }
    voiceMocks.joinVoiceChannel.mockReturnValue(createMock<VoiceConnection>(connection))
    const manager = createManager()
    const channel = createMock<BaseGuildVoiceChannel>({
      guild: {
        id: 'guild-1',
        members: { me: undefined },
        voiceAdapterCreator: {},
      },
      guildId: 'guild-1',
      id: 'voice-1',
      members: new Map([['user-1', { id: 'user-1', user: { bot: false } }]]),
      name: 'Voice',
    })
    const editReply = vi.fn(async () => {})
    const reply = vi.fn(async () => {})
    const interaction = createMock<ChatInputCommandInteraction>({
      editReply,
      id: '1',
      inCachedGuild: () => true,
      member: { voice: { channel } },
      reply,
    })

    await manager.handleJoinChannelCommand(interaction)
    const followUp = vi.fn(async () => {})
    await manager.handleConsentInteraction(createMock<ButtonInteraction>({
      customId: 'airi:voice-consent:opt-in:guild-1-1',
      followUp,
      guildId: 'guild-1',
      inCachedGuild: () => true,
      member: { voice: { channelId: 'voice-1', sessionId: 'participant-session-user-1' } },
      update: vi.fn(async () => {}),
      user: { id: 'user-1' },
    }))

    expect(reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringMatching(/opt.?in/i) }))
    expect(followUp).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }))
    expect(connection.destroy).toHaveBeenCalledOnce()
  })

  /**
   * @example
   * it('reproduces Discord audit D-015 by committing an admitted turn after the member cache entry disappears', async () => {})
   */
  it('reproduces Discord audit D-015 by committing an admitted turn after the member cache entry disappears', async () => {
    let speakingStart = (_userId: string): Promise<void> => Promise.resolve()
    let speakingEnd = (_userId: string): Promise<void> => Promise.resolve()
    let providerEvents: RealtimeVoiceCallSessionEvents = {}
    const receiveStream = new PassThrough()
    const connection = {
      destroy: vi.fn(),
      off: vi.fn(),
      on: vi.fn(),
      receiver: {
        subscribe: vi.fn(() => receiveStream),
        speaking: {
          off: vi.fn(),
          on: vi.fn((event: string, listener: (userId: string) => Promise<void>) => {
            if (event === 'start')
              speakingStart = listener
            if (event === 'end')
              speakingEnd = listener
          }),
        },
      },
      state: { status: 'ready' },
    }
    const finishInput = vi.fn()
    const abortInput = vi.fn()
    const cancelResponse = vi.fn()
    const appendAudio = vi.fn((pcm: Buffer, inputSequence: number) => {
      providerEvents.onInputAudioSent?.({
        byteLength: pcm.length,
        chunkCount: 1,
        inputSequence,
        kind: 'user-audio',
      })
      return true
    })
    const runtime = {
      connect: vi.fn(async (events: RealtimeVoiceCallSessionEvents) => {
        providerEvents = events
        return {
          abortInput,
          appendAudio,
          cancelResponse,
          close: vi.fn(),
          finishInput,
        }
      }),
      getInterruptionRmsThreshold: () => 0.04,
      getMode: () => 'qwen-realtime' as const,
      isConfigured: () => true,
    }
    const diagnostics: VoiceDiagnosticSignal[] = []
    const observer: VoiceDiagnosticsObserver = {
      record: signal => diagnostics.push({ ...signal }),
      runtimeSequence: 1,
    }
    const manager = new VoiceManager(
      createMock<DiscordClient>({ user: { id: 'bot-user' } }),
      async () => undefined,
      async () => '',
      runtime,
      undefined,
      undefined,
      undefined,
      observer,
    )
    const member = createMock<GuildMember>({
      displayName: 'Synthetic departed speaker',
      guild: { id: 'guild-1', name: 'Synthetic guild' },
      id: 'departed-user',
      nickname: 'Synthetic nickname',
      user: { bot: false },
    })
    const members = new Map([['departed-user', member]])
    const channel = createMock<BaseGuildVoiceChannel>({
      guild: { id: 'guild-1', members: { me: undefined }, voiceAdapterCreator: {} },
      guildId: 'guild-1',
      id: 'voice-1',
      members,
      name: 'Synthetic voice',
    })
    voiceMocks.joinVoiceChannel.mockReturnValue(createMock<VoiceConnection>(connection))

    await manager.joinChannel(createMock<ChatInputCommandInteraction>({ reply: vi.fn(async () => {}) }), channel)
    await speakingStart('departed-user')
    const packets = createOpusPcm16Fixture()
    await vi.waitFor(() => expect(connection.receiver.subscribe).toHaveBeenCalledOnce())
    for (let frame = 0; frame < 6; frame += 1)
      receiveStream.write(packets.nextSpeechPacket())
    await vi.waitFor(() => expect(appendAudio).toHaveBeenCalled())
    members.delete('departed-user')

    // ROOT CAUSE:
    //
    // Discord can evict a GuildMember before emitting the matching speaking-end
    // event. The old end handler queried the live member cache first and returned,
    // even though begin had already admitted audio into Qwen. The provider input
    // then remained pending without its required trailing-silence boundary.
    await speakingEnd('departed-user')
    await speakingEnd('departed-user')

    /**
     * @example
     * expect(finishInput).toHaveBeenCalledOnce()
     */
    expect(finishInput).toHaveBeenCalledOnce()
    providerEvents.onInputCommitted?.({ inputSequence: 1, itemId: 'departed-item' })
    /**
     * @example
     * expect(commit).toMatchObject({ aggregateTurnSequence: 1, captureTurnSequences: [1], turnSequence: 1 })
     */
    expect(diagnostics.find(signal => signal.stage === 'provider-input-committed')).toMatchObject({
      aggregateTurnSequence: 1,
      captureTurnSequences: [1],
      turnSequence: 1,
    })
    /**
     * @example
     * expect(abortInput).not.toHaveBeenCalled()
     */
    expect(abortInput).not.toHaveBeenCalled()
    /**
     * @example
     * expect(cancelResponse).not.toHaveBeenCalled()
     */
    expect(cancelResponse).not.toHaveBeenCalled()
    receiveStream.emit('close')
    await vi.waitFor(() => {
      expect(Reflect.get(manager, 'activeMonitors').has('guild-1:voice-1:0:departed-user')).toBe(false)
    })
    /**
     * @example
     * expect(activeMonitors.has(speakerKey)).toBe(false)
     */
    await manager.stop()
  })

  /**
   * @example
   * it('reproduces Discord audit D-015 by dropping completed provider output after the last reply target leaves', async () => {})
   */
  it('reproduces Discord audit D-015 by dropping completed provider output after the last reply target leaves', async () => {
    let providerEvents: RealtimeVoiceCallSessionEvents = {}
    const provider = {
      abortInput: vi.fn(),
      appendAudio: vi.fn(() => true),
      cancelResponse: vi.fn(),
      close: vi.fn(),
      finishInput: vi.fn(),
    }
    const runtime = {
      connect: vi.fn(async (events: RealtimeVoiceCallSessionEvents) => {
        providerEvents = events
        return provider
      }),
      getInterruptionRmsThreshold: () => 0.04,
      getMode: () => 'qwen-realtime' as const,
      isConfigured: () => true,
    }
    const player = {
      on: vi.fn(),
      play: vi.fn(),
      removeAllListeners: vi.fn(),
      state: { status: 'playing' },
      stop: vi.fn(),
    }
    voiceMocks.createAudioPlayer.mockReturnValue(createMock<AudioPlayer>(player))
    const connection = {
      destroy: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
      receiver: { speaking: { off: vi.fn(), on: vi.fn() } },
      state: { status: 'ready' },
      subscribe: vi.fn(),
    }
    voiceMocks.joinVoiceChannel.mockReturnValue(createMock<VoiceConnection>(connection))
    const member = createMock<GuildMember>({
      displayName: 'Departing reply target',
      guild: { id: 'guild-1', name: 'Synthetic guild' },
      id: 'user-1',
      user: { bot: false },
    })
    const members = new Map([['user-1', member]])
    const channel = createMock<BaseGuildVoiceChannel>({
      guild: { id: 'guild-1', members: { me: undefined }, voiceAdapterCreator: {} },
      id: 'voice-1',
      members,
      name: 'Synthetic voice',
    })
    const manager = new VoiceManager(
      createMock<DiscordClient>({ user: { id: 'bot-user' } }),
      async () => undefined,
      async () => '',
      runtime,
    )
    await manager.joinChannel(
      createMock<ChatInputCommandInteraction>({ reply: vi.fn(async () => {}) }),
      channel,
    )
    const session = Reflect.get(manager, 'activeVoiceSessionsByGuildId').get('guild-1')
    session.currentDiagnosticTurnSequence = 1
    Reflect.get(manager, 'activeMonitors').set(`guild-1:voice-1:${session.scope.generation}:user-1`, {
      admitted: true,
      capture: { id: Symbol('capture') },
      diagnosticTurnSequence: 1,
      finishing: false,
      scope: session.scope,
      stop: vi.fn(),
      userId: 'user-1',
    })
    members.delete('user-1')

    // ROOT CAUSE:
    //
    // Cache-independent speaking end must not manufacture a provider input for
    // an empty capture. Late audio callbacks still cannot play into the channel
    // after its final human reply target disappeared, and response completion
    // must retire the provider socket and generation.
    await manager.handleAudioReceiveStreamEnd(channel, session.scope)('user-1')
    providerEvents.onInputAudioSent?.({ byteLength: 2, chunkCount: 1, inputSequence: 1, kind: 'user-audio' })
    providerEvents.onInputCommitted?.({ inputSequence: 1, itemId: 'departed-item' })
    providerEvents.onResponseCreated?.({ responseId: 'departed-response' })
    providerEvents.onAudio?.(Buffer.from([1, 2, 3]), { responseId: 'departed-response' })
    /**
     * @example
     * expect(connection.subscribe).not.toHaveBeenCalled()
     */
    expect(connection.subscribe).not.toHaveBeenCalled()
    providerEvents.onResponseDone?.({ responseId: 'departed-response' }, 'completed')
    /**
     * @example
     * expect(provider.finishInput).not.toHaveBeenCalled()
     */
    expect(provider.finishInput).not.toHaveBeenCalled()
    /**
     * @example
     * expect(provider.close).toHaveBeenCalledOnce()
     */
    expect(provider.close).toHaveBeenCalledOnce()
    /**
     * @example
     * expect(realtimeSessions.size).toBe(0)
     */
    expect(Reflect.get(manager, 'realtimeSessions').size).toBe(0)
    await manager.stop()
  })

  /**
   * @example
   * it('reproduces Discord audit D-015 by projecting member identity before asynchronous capture callbacks', async () => {})
   */
  it('reproduces Discord audit D-015 by projecting member identity before asynchronous capture callbacks', async () => {
    const receiveStream = new PassThrough()
    const connection = {
      destroy: vi.fn(),
      joinConfig: { guildId: 'guild-1' },
      receiver: { subscribe: vi.fn(() => receiveStream) },
      state: { status: 'ready' },
    }
    voiceMocks.getVoiceConnections.mockReturnValue(createMock<Map<string, VoiceConnection>>(new Map([['guild-1', connection]])))
    const runtime = {
      connect: vi.fn(),
      getInterruptionRmsThreshold: () => 0.04,
      getMode: () => 'qwen-realtime' as const,
      isConfigured: () => true,
    }
    const manager = new VoiceManager(
      createMock<DiscordClient>({ user: { id: 'bot-user' } }),
      async () => undefined,
      async () => '',
      runtime,
    )
    Reflect.get(manager, 'realtimeSessions').set('guild-1:voice-1:0', {
      abortController: new AbortController(),
      committedInputItemIds: new Set(),
      committedInputTurnSequences: [],
      finishedInputTurnSequences: [],
      inputItemTurnSequences: new Map(),
      observedSpeechItemIds: new Set(),
      providerInputByTurn: new Map(),
      responseMetricsByTurn: new Map(),
      responseTurnSequences: new Map(),
      retiredInputItemIds: new Set(),
      retiredResponseIds: new Set(),
      provider: {
        appendAudio: vi.fn(() => true),
        cancelResponse: vi.fn(),
        close: vi.fn(),
        finishInput: vi.fn(),
      },
      scope: { channelId: 'voice-1', generation: 0, guildId: 'guild-1' },
      terminated: false,
    })
    let memberReleased = false
    const member = createMock<GuildMember>({
      get displayName() {
        if (memberReleased)
          throw new Error('full GuildMember retained after speaking begin')
        return 'Synthetic speaker'
      },
      guild: { id: 'guild-1', name: 'Synthetic guild' },
      id: 'user-1',
      nickname: 'Synthetic nickname',
      user: { bot: false },
    })
    const channel = createMock<BaseGuildVoiceChannel>({
      guild: { id: 'guild-1' },
      id: 'voice-1',
      members: new Map([['user-1', member]]),
    })
    await manager.handleAudioReceiveStreamStart(channel)('user-1')
    memberReleased = true

    // ROOT CAUSE:
    //
    // Qwen capture retained the complete mutable GuildMember through decoder
    // close callbacks solely to read displayName later. Cache eviction therefore
    // did not release the member, and delayed callbacks observed mutable identity.
    /**
     * @example
     * expect(() => receiveStream.emit('close')).not.toThrow()
     */
    expect(() => receiveStream.emit('close')).not.toThrow()
    await manager.stop()
  })

  /**
   * @example
   * it('reproduces Discord audit D-015 by failing closed when realtime finish throws', async () => {})
   */
  it('reproduces Discord audit D-015 by failing closed when realtime finish throws', async () => {
    let speakingStart = (_userId: string): Promise<void> => Promise.resolve()
    let speakingEnd = (_userId: string): Promise<void> => Promise.resolve()
    let providerEvents: RealtimeVoiceCallSessionEvents = {}
    const receiveStream = new PassThrough()
    const provider = {
      abortInput: vi.fn(),
      appendAudio: vi.fn((pcm: Buffer, inputSequence: number) => {
        providerEvents.onInputAudioSent?.({
          byteLength: pcm.length,
          chunkCount: 1,
          inputSequence,
          kind: 'user-audio',
        })
        return true
      }),
      cancelResponse: vi.fn(),
      close: vi.fn(),
      finishInput: vi.fn(() => {
        throw new Error('synthetic finish failure')
      }),
    }
    const runtime = {
      connect: vi.fn(async (events: RealtimeVoiceCallSessionEvents) => {
        providerEvents = events
        return provider
      }),
      getInterruptionRmsThreshold: () => 0.04,
      getMode: () => 'qwen-realtime' as const,
      isConfigured: () => true,
    }
    const diagnostics: VoiceDiagnosticSignal[] = []
    const observer: VoiceDiagnosticsObserver = {
      record: signal => diagnostics.push({ ...signal }),
      runtimeSequence: 19,
    }
    const connection = {
      destroy: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
      receiver: {
        subscribe: vi.fn(() => receiveStream),
        speaking: {
          off: vi.fn(),
          on: vi.fn((event: string, listener: (userId: string) => Promise<void>) => {
            if (event === 'start')
              speakingStart = listener
            if (event === 'end')
              speakingEnd = listener
          }),
        },
      },
      state: { status: 'ready' },
    }
    voiceMocks.joinVoiceChannel.mockReturnValue(createMock<VoiceConnection>(connection))
    const manager = new VoiceManager(
      createMock<DiscordClient>({ user: { id: 'bot-user' } }),
      async () => undefined,
      async () => '',
      runtime,
      undefined,
      undefined,
      undefined,
      observer,
    )
    const channel = createMock<BaseGuildVoiceChannel>({
      guild: { id: 'guild-1', members: { me: undefined }, voiceAdapterCreator: {} },
      guildId: 'guild-1',
      id: 'voice-1',
      members: new Map([['user-1', {
        displayName: 'Synthetic speaker',
        guild: { id: 'guild-1', name: 'Synthetic guild' },
        id: 'user-1',
        user: { bot: false },
      }]]),
      name: 'Synthetic voice',
    })
    await manager.joinChannel(createMock<ChatInputCommandInteraction>({ reply: vi.fn(async () => {}) }), channel)
    await speakingStart('user-1')
    await vi.waitFor(() => expect(connection.receiver.subscribe).toHaveBeenCalledOnce())
    const packets = createOpusPcm16Fixture()
    for (let frame = 0; frame < 6; frame += 1)
      receiveStream.write(packets.nextSpeechPacket())
    await vi.waitFor(() => expect(provider.appendAudio).toHaveBeenCalled())

    // ROOT CAUSE:
    //
    // The raw async EventEmitter callback called finishInput without an owned
    // rejection boundary. A provider throw escaped as an unhandled rejection and
    // left the monitor marked finishing even though the turn could never commit.
    /**
     * @example
     * await expect(speakingEnd('user-1')).resolves.toBeUndefined()
     */
    await expect(speakingEnd('user-1')).resolves.toBeUndefined()
    /**
     * @example
     * expect(provider.finishInput).toHaveBeenCalledOnce()
     */
    expect(provider.finishInput).toHaveBeenCalledOnce()
    /**
     * @example
     * expect(provider.abortInput).toHaveBeenCalledOnce()
     */
    expect(provider.abortInput).toHaveBeenCalledOnce()
    /**
     * @example
     * expect(provider.cancelResponse).toHaveBeenCalledOnce()
     */
    expect(provider.cancelResponse).toHaveBeenCalledOnce()
    /**
     * @example
     * expect(provider.close).toHaveBeenCalledOnce()
     */
    expect(provider.close).toHaveBeenCalledOnce()
    /**
     * @example
     * expect(activeMonitors.size).toBe(0)
     */
    expect(Reflect.get(manager, 'activeMonitors').size).toBe(0)
    /**
     * @example
     * expect(realtimeSessions.size).toBe(0)
     */
    expect(Reflect.get(manager, 'realtimeSessions').size).toBe(0)
    /**
     * @example
     * expect(activeRealtimePlaybacks.size).toBe(0)
     */
    expect(Reflect.get(manager, 'activeRealtimePlaybacks').size).toBe(0)
    /**
     * @example
     * expect(diagnostics).toContainEqual(expect.objectContaining({ failureCategory: 'provider-error', runtimeSequence: 19, stage: 'failure', turnSequence: 1 }))
     */
    expect(diagnostics).toContainEqual(expect.objectContaining({
      failureCategory: 'provider-error',
      runtimeSequence: 19,
      stage: 'failure',
      turnSequence: 1,
    }))
    await manager.stop()
  })

  /** @example it('fails closed for unsolicited provider correlations without contaminating a later admitted capture', async () => {}) */
  it('fails closed for unsolicited provider correlations without contaminating a later admitted capture', async () => {
    let speakingStart = (_userId: string): Promise<void> => Promise.resolve()
    let providerEvents: RealtimeVoiceCallSessionEvents = {}
    const diagnostics: VoiceDiagnosticSignal[] = []
    const receiveStream = new PassThrough()
    const player = {
      on: vi.fn(),
      play: vi.fn(),
      removeAllListeners: vi.fn(),
      state: { status: 'idle' },
      stop: vi.fn(),
    }
    voiceMocks.createAudioPlayer.mockReturnValue(createMock<AudioPlayer>(player))
    const provider = {
      abortInput: vi.fn(),
      appendAudio: vi.fn((pcm: Buffer, inputSequence: number) => {
        providerEvents.onInputAudioSent?.({ byteLength: pcm.length, chunkCount: 1, inputSequence, kind: 'user-audio' })
        return true
      }),
      cancelResponse: vi.fn(),
      close: vi.fn(),
      finishInput: vi.fn(),
    }
    const runtime = {
      connect: vi.fn(async (events: RealtimeVoiceCallSessionEvents) => {
        providerEvents = events
        return provider
      }),
      getInterruptionRmsThreshold: () => 0.04,
      getMode: () => 'qwen-realtime' as const,
      isConfigured: () => true,
    }
    const connection = {
      destroy: vi.fn(),
      off: vi.fn(),
      on: vi.fn(),
      receiver: {
        speaking: {
          off: vi.fn(),
          on: vi.fn((event: string, listener: (userId: string) => Promise<void>) => {
            if (event === 'start')
              speakingStart = listener
          }),
        },
        subscribe: vi.fn(() => receiveStream),
      },
      state: { status: 'ready' },
      subscribe: vi.fn(() => ({ unsubscribe: vi.fn() })),
    }
    voiceMocks.joinVoiceChannel.mockReturnValue(createMock<VoiceConnection>(connection))
    const manager = new VoiceManager(
      createMock<DiscordClient>({ user: { id: 'bot-user' } }),
      async () => undefined,
      async () => '',
      runtime,
      undefined,
      undefined,
      undefined,
      { record: signal => diagnostics.push({ ...signal }), runtimeSequence: 29 },
    )
    const channel = createMock<BaseGuildVoiceChannel>({
      guild: { id: 'guild-1', members: { me: undefined }, voiceAdapterCreator: {} },
      guildId: 'guild-1',
      id: 'voice-1',
      members: new Map([['user-1', {
        displayName: 'Synthetic speaker',
        guild: { id: 'guild-1', name: 'Synthetic guild' },
        id: 'user-1',
        user: { bot: false },
      }]]),
      name: 'Synthetic voice',
    })
    await manager.joinChannel(createMock<ChatInputCommandInteraction>({ reply: vi.fn(async () => {}) }), channel)

    // ROOT CAUSE:
    //
    // Provider callbacks can arrive after a cleared buffer or for a different
    // socket generation. They must not manufacture a commit/FIFO record from
    // an active capture guess, nor may a VAD-only or unknown item consume the
    // next legitimate committed input.
    providerEvents.onInputCommitted?.({ inputSequence: 1, itemId: 'unsolicited-item' })
    providerEvents.onSpeechStarted?.({ itemId: 'vad-only-item' })
    providerEvents.onResponseCreated?.({ itemId: 'vad-only-item', responseId: 'vad-only-response' })
    providerEvents.onAudio?.(Buffer.from([1, 2]), { responseId: 'vad-only-response' })
    providerEvents.onResponseDone?.({ responseId: 'vad-only-response' }, 'completed')
    expect(diagnostics.filter(signal => signal.stage === 'provider-input-committed')).toHaveLength(0)
    expect(diagnostics.filter(signal => signal.stage === 'provider-response-created' || signal.stage === 'provider-response-audio')).toHaveLength(0)
    expect(player.play).not.toHaveBeenCalled()

    await speakingStart('user-1')
    await vi.waitFor(() => expect(connection.receiver.subscribe).toHaveBeenCalledOnce())
    const packets = createOpusPcm16Fixture()
    for (let frame = 0; frame < 6; frame += 1)
      receiveStream.write(packets.nextSpeechPacket())
    await vi.waitFor(() => expect(provider.appendAudio).toHaveBeenCalled())

    providerEvents.onInputCommitted?.({ inputSequence: 1, itemId: 'item-a' })
    providerEvents.onInputCommitted?.({ inputSequence: 1, itemId: 'item-a' })
    providerEvents.onResponseCreated?.({ itemId: 'unknown-item', responseId: 'unknown-response' })
    providerEvents.onAudio?.(Buffer.from([3, 4]), { responseId: 'unknown-response' })
    providerEvents.onResponseDone?.({ responseId: 'unknown-response' }, 'completed')

    const commits = diagnostics.filter(signal => signal.stage === 'provider-input-committed')
    expect(commits).toEqual([expect.objectContaining({
      aggregateTurnSequence: 1,
      captureTurnSequences: [1],
      turnSequence: 1,
    })])
    expect(player.play).not.toHaveBeenCalled()

    providerEvents.onResponseCreated?.({ itemId: 'item-a', responseId: 'response-a' })
    providerEvents.onAudio?.(Buffer.from([5, 6]), { responseId: 'response-a' })

    // ROOT CAUSE:
    //
    // A provider VAD item without a successful append, committed input, or
    // explicit item mapping is unsolicited. It must not borrow the active
    // capture to create a provider-vad diagnostic or interrupt a separately
    // legitimate response that is already playing.
    providerEvents.onSpeechStarted?.({ itemId: 'vad-unknown-active-response' })
    expect(diagnostics.filter(signal => signal.stage === 'provider-vad')).toHaveLength(0)
    expect(player.stop).not.toHaveBeenCalled()

    providerEvents.onResponseDone?.({ responseId: 'response-a' }, 'completed')
    providerEvents.onResponseCreated?.({ itemId: 'item-a', responseId: 'response-a-late' })
    providerEvents.onAudio?.(Buffer.from([7, 8]), { responseId: 'response-a-late' })

    expect(diagnostics.filter(signal => signal.stage === 'provider-response-created')).toEqual([
      expect.objectContaining({ turnSequence: 1 }),
    ])
    expect(diagnostics.filter(signal => signal.stage === 'provider-response-audio')).toEqual([
      expect.objectContaining({ responseAudioBytes: 2, responseAudioChunks: 1, turnSequence: 1 }),
    ])
    expect(player.play).toHaveBeenCalledOnce()
    await manager.stop()
  })

  /** @example it('retires a faulty provider generation that reports successful captures out of source order', async () => {}) */
  it('retires a faulty provider generation that reports successful captures out of source order', async () => {
    let providerEvents: RealtimeVoiceCallSessionEvents = {}
    const speakingListeners = new Map<string, (userId: string) => Promise<void>>()
    const streams: PassThrough[] = []
    const sentSequences: number[] = []
    const provider = {
      abortInput: vi.fn(),
      appendAudio: vi.fn((_pcm: Buffer, inputSequence: number) => {
        sentSequences.push(inputSequence)
        return true
      }),
      cancelResponse: vi.fn(),
      close: vi.fn(),
      finishInput: vi.fn(),
    }
    const runtime = {
      connect: vi.fn(async (events: RealtimeVoiceCallSessionEvents) => {
        providerEvents = events
        return provider
      }),
      getInterruptionRmsThreshold: () => 0.04,
      getMode: () => 'qwen-realtime' as const,
      isConfigured: () => true,
    }
    const connection = {
      destroy: vi.fn(),
      off: vi.fn(),
      on: vi.fn(),
      receiver: {
        speaking: {
          off: vi.fn(),
          on: vi.fn((event: string, listener: (userId: string) => Promise<void>) => speakingListeners.set(event, listener)),
        },
        subscribe: vi.fn(() => {
          const stream = new PassThrough()
          streams.push(stream)
          return stream
        }),
      },
      state: { status: 'ready' },
      subscribe: vi.fn(() => ({ unsubscribe: vi.fn() })),
    }
    voiceMocks.joinVoiceChannel.mockReturnValue(createMock<VoiceConnection>(connection))
    const manager = new VoiceManager(
      createMock<DiscordClient>({ user: { id: 'bot-user' } }),
      async () => undefined,
      async () => '',
      runtime,
    )
    const guild = { id: 'guild-1', members: { me: undefined }, voiceAdapterCreator: {} }
    const members = new Map(['user-1', 'user-2'].map(id => [id, {
      displayName: id,
      guild,
      id,
      user: { bot: false },
    }]))
    const channel = createMock<BaseGuildVoiceChannel>({ guild, guildId: 'guild-1', id: 'voice-1', members, name: 'Synthetic voice' })
    await manager.joinChannel(createMock<ChatInputCommandInteraction>({ reply: vi.fn(async () => {}) }), channel)
    const start = speakingListeners.get('start')
    if (!start)
      throw new Error('The joined public receiver must install its speaking-start callback.')
    await start('user-1')
    await start('user-2')
    await vi.waitFor(() => expect(streams).toHaveLength(2))
    const first = createOpusPcm16Fixture()
    const second = createOpusPcm16Fixture()
    for (let frame = 0; frame < 6; frame += 1) {
      streams[0].write(first.nextSpeechPacket())
      streams[1].write(second.nextSpeechPacket())
    }
    await vi.waitFor(() => expect(sentSequences).toContain(1))
    await vi.waitFor(() => expect(sentSequences).toContain(2))

    // ROOT CAUSE:
    //
    // This fault-injection provider records real successful append calls but
    // reports their public callbacks out of order. The manager must reject the
    // impossible source sequence rather than create a [2,1] aggregate.
    providerEvents.onInputAudioSent?.({ byteLength: 640, chunkCount: 1, inputSequence: 2, kind: 'user-audio' })
    providerEvents.onInputAudioSent?.({ byteLength: 640, chunkCount: 1, inputSequence: 1, kind: 'user-audio' })

    expect(provider.abortInput).toHaveBeenCalledOnce()
    expect(provider.cancelResponse).toHaveBeenCalledOnce()
    expect(provider.close).toHaveBeenCalledOnce()
    providerEvents.onInputCommitted?.({ inputSequence: 2, itemId: 'late-item' })
    expect(provider.close).toHaveBeenCalledOnce()
    await manager.stop()
  })

  /** @example it('retires a generation when a provider launders a numerically newer input success outside appendAudio', async () => {}) */
  it('retires a generation when a provider launders a numerically newer input success outside appendAudio', async () => {
    let speakingStart = (_userId: string): Promise<void> => Promise.resolve()
    let providerEvents: RealtimeVoiceCallSessionEvents = {}
    const diagnostics: VoiceDiagnosticSignal[] = []
    const receiveStream = new PassThrough()
    const player = {
      on: vi.fn(),
      play: vi.fn(),
      removeAllListeners: vi.fn(),
      state: { status: 'idle' },
      stop: vi.fn(),
    }
    voiceMocks.createAudioPlayer.mockReturnValue(createMock<AudioPlayer>(player))
    const provider = {
      abortInput: vi.fn(),
      appendAudio: vi.fn((pcm: Buffer, inputSequence: number) => {
        providerEvents.onInputAudioSent?.({ byteLength: pcm.length, chunkCount: 1, inputSequence, kind: 'user-audio' })
        return true
      }),
      cancelResponse: vi.fn(),
      close: vi.fn(),
      finishInput: vi.fn(),
    }
    const runtime = {
      connect: vi.fn(async (events: RealtimeVoiceCallSessionEvents) => {
        providerEvents = events
        return provider
      }),
      getInterruptionRmsThreshold: () => 0.04,
      getMode: () => 'qwen-realtime' as const,
      isConfigured: () => true,
    }
    const connection = {
      destroy: vi.fn(),
      off: vi.fn(),
      on: vi.fn(),
      receiver: {
        speaking: {
          off: vi.fn(),
          on: vi.fn((event: string, listener: (userId: string) => Promise<void>) => {
            if (event === 'start')
              speakingStart = listener
          }),
        },
        subscribe: vi.fn(() => receiveStream),
      },
      state: { status: 'ready' },
      subscribe: vi.fn(() => ({ unsubscribe: vi.fn() })),
    }
    voiceMocks.joinVoiceChannel.mockReturnValue(createMock<VoiceConnection>(connection))
    const manager = new VoiceManager(
      createMock<DiscordClient>({ user: { id: 'bot-user' } }),
      async () => undefined,
      async () => '',
      runtime,
      undefined,
      undefined,
      undefined,
      { record: signal => diagnostics.push({ ...signal }), runtimeSequence: 41 },
    )
    const channel = createMock<BaseGuildVoiceChannel>({
      guild: { id: 'guild-c1', members: { me: undefined }, voiceAdapterCreator: {} },
      guildId: 'guild-c1',
      id: 'voice-c1',
      members: new Map([['user-1', {
        displayName: 'C1 speaker',
        guild: { id: 'guild-c1', name: 'C1 guild' },
        id: 'user-1',
        user: { bot: false },
      }]]),
      name: 'C1 voice',
    })
    await manager.joinChannel(createMock<ChatInputCommandInteraction>({ reply: vi.fn(async () => {}) }), channel)
    await speakingStart('user-1')
    await vi.waitFor(() => expect(connection.receiver.subscribe).toHaveBeenCalledOnce())
    const packets = createOpusPcm16Fixture()
    for (let frame = 0; frame < 6; frame += 1)
      receiveStream.write(packets.nextSpeechPacket())
    await vi.waitFor(() => expect(provider.appendAudio).toHaveBeenCalled())
    const captureTurn = provider.appendAudio.mock.calls.at(-1)?.[1]
    if (!captureTurn)
      throw new Error('A successful public append must expose its capture sequence.')

    // ROOT CAUSE:
    //
    // The provider callback was accepted based only on a positive, increasing
    // number. A faulty provider can therefore report a never-appended future
    // capture and silently append it to the aggregate. The callback must be
    // causally paired with the active appendAudio call or retire this generation.
    //
    // Before the repair, this callback creates contributor 2 after capture 1.
    // After the repair, the generation closes exactly once and later events are
    // unable to manufacture a commit, response, or playback.
    providerEvents.onInputAudioSent?.({
      byteLength: 640,
      chunkCount: 1,
      inputSequence: captureTurn + 1,
      kind: 'user-audio',
    })

    expect(provider.abortInput).toHaveBeenCalledOnce()
    expect(provider.cancelResponse).toHaveBeenCalledOnce()
    expect(provider.close).toHaveBeenCalledOnce()
    providerEvents.onInputCommitted?.({ inputSequence: captureTurn + 1, itemId: 'laundered-item' })
    providerEvents.onResponseCreated?.({ itemId: 'laundered-item', responseId: 'laundered-response' })
    providerEvents.onAudio?.(Buffer.from([1, 2]), { responseId: 'laundered-response' })
    providerEvents.onResponseDone?.({ responseId: 'laundered-response' }, 'completed')
    expect(diagnostics.filter(signal => signal.stage === 'provider-input-committed')).toHaveLength(0)
    expect(diagnostics.filter(signal => signal.stage === 'provider-response-created' || signal.stage === 'provider-response-audio')).toHaveLength(0)
    expect(player.play).not.toHaveBeenCalled()
    await manager.stop()
  })

  /** @example it('does not let a false append result be laundered into provider ownership', async () => {}) */
  it('does not let a false append result be laundered into provider ownership', async () => {
    let speakingStart = (_userId: string): Promise<void> => Promise.resolve()
    let providerEvents: RealtimeVoiceCallSessionEvents = {}
    const diagnostics: VoiceDiagnosticSignal[] = []
    const receiveStream = new PassThrough()
    const player = {
      on: vi.fn(),
      play: vi.fn(),
      removeAllListeners: vi.fn(),
      state: { status: 'idle' },
      stop: vi.fn(),
    }
    voiceMocks.createAudioPlayer.mockReturnValue(createMock<AudioPlayer>(player))
    const provider = {
      abortInput: vi.fn(),
      appendAudio: vi.fn((_pcm: Buffer, _inputSequence: number) => false),
      cancelResponse: vi.fn(),
      close: vi.fn(),
      finishInput: vi.fn(),
    }
    const runtime = {
      connect: vi.fn(async (events: RealtimeVoiceCallSessionEvents) => {
        providerEvents = events
        return provider
      }),
      getInterruptionRmsThreshold: () => 0.04,
      getMode: () => 'qwen-realtime' as const,
      isConfigured: () => true,
    }
    const connection = {
      destroy: vi.fn(),
      off: vi.fn(),
      on: vi.fn(),
      receiver: {
        speaking: {
          off: vi.fn(),
          on: vi.fn((event: string, listener: (userId: string) => Promise<void>) => {
            if (event === 'start')
              speakingStart = listener
          }),
        },
        subscribe: vi.fn(() => receiveStream),
      },
      state: { status: 'ready' },
      subscribe: vi.fn(() => ({ unsubscribe: vi.fn() })),
    }
    voiceMocks.joinVoiceChannel.mockReturnValue(createMock<VoiceConnection>(connection))
    const manager = new VoiceManager(
      createMock<DiscordClient>({ user: { id: 'bot-user' } }),
      async () => undefined,
      async () => '',
      runtime,
      undefined,
      undefined,
      undefined,
      { record: signal => diagnostics.push({ ...signal }), runtimeSequence: 42 },
    )
    const channel = createMock<BaseGuildVoiceChannel>({
      guild: { id: 'guild-c2', members: { me: undefined }, voiceAdapterCreator: {} },
      guildId: 'guild-c2',
      id: 'voice-c2',
      members: new Map([['user-1', {
        displayName: 'C2 speaker',
        guild: { id: 'guild-c2', name: 'C2 guild' },
        id: 'user-1',
        user: { bot: false },
      }]]),
      name: 'C2 voice',
    })
    await manager.joinChannel(createMock<ChatInputCommandInteraction>({ reply: vi.fn(async () => {}) }), channel)
    await speakingStart('user-1')
    await vi.waitFor(() => expect(connection.receiver.subscribe).toHaveBeenCalledOnce())
    const packets = createOpusPcm16Fixture()
    for (let frame = 0; frame < 6; frame += 1)
      receiveStream.write(packets.nextSpeechPacket())
    await vi.waitFor(() => expect(provider.appendAudio).toHaveBeenCalled())

    // ROOT CAUSE:
    //
    // appendAudio(false) means this generation never has a successful provider
    // input. A later faulty success callback must not resurrect that capture or
    // create a pending aggregate after backpressure has already failed closed.
    providerEvents.onInputAudioSent?.({ byteLength: 640, chunkCount: 1, inputSequence: 1, kind: 'user-audio' })
    providerEvents.onInputCommitted?.({ inputSequence: 1, itemId: 'false-append-item' })
    providerEvents.onResponseCreated?.({ itemId: 'false-append-item', responseId: 'false-append-response' })
    providerEvents.onAudio?.(Buffer.from([1, 2]), { responseId: 'false-append-response' })

    expect(provider.abortInput).toHaveBeenCalledOnce()
    expect(provider.cancelResponse).toHaveBeenCalledOnce()
    expect(provider.close).toHaveBeenCalledOnce()
    expect(diagnostics.filter(signal => signal.stage === 'provider-input-appended' || signal.stage === 'provider-input-committed')).toHaveLength(0)
    expect(diagnostics.filter(signal => signal.stage === 'provider-response-created' || signal.stage === 'provider-response-audio')).toHaveLength(0)
    expect(player.play).not.toHaveBeenCalled()
    await manager.stop()
  })

  /** @example it('rejects an unknown provider input clear without erasing the real pending aggregate', async () => {}) */
  it('rejects an unknown provider input clear without erasing the real pending aggregate', async () => {
    let speakingStart = (_userId: string): Promise<void> => Promise.resolve()
    let providerEvents: RealtimeVoiceCallSessionEvents = {}
    const diagnostics: VoiceDiagnosticSignal[] = []
    const receiveStream = new PassThrough()
    const player = {
      on: vi.fn(),
      play: vi.fn(),
      removeAllListeners: vi.fn(),
      state: { status: 'idle' },
      stop: vi.fn(),
    }
    voiceMocks.createAudioPlayer.mockReturnValue(createMock<AudioPlayer>(player))
    const provider = {
      abortInput: vi.fn(),
      appendAudio: vi.fn((pcm: Buffer, inputSequence: number) => {
        providerEvents.onInputAudioSent?.({ byteLength: pcm.length, chunkCount: 1, inputSequence, kind: 'user-audio' })
        return true
      }),
      cancelResponse: vi.fn(),
      close: vi.fn(),
      finishInput: vi.fn(),
    }
    const runtime = {
      connect: vi.fn(async (events: RealtimeVoiceCallSessionEvents) => {
        providerEvents = events
        return provider
      }),
      getInterruptionRmsThreshold: () => 0.04,
      getMode: () => 'qwen-realtime' as const,
      isConfigured: () => true,
    }
    const connection = {
      destroy: vi.fn(),
      off: vi.fn(),
      on: vi.fn(),
      receiver: {
        speaking: {
          off: vi.fn(),
          on: vi.fn((event: string, listener: (userId: string) => Promise<void>) => {
            if (event === 'start')
              speakingStart = listener
          }),
        },
        subscribe: vi.fn(() => receiveStream),
      },
      state: { status: 'ready' },
      subscribe: vi.fn(() => ({ unsubscribe: vi.fn() })),
    }
    voiceMocks.joinVoiceChannel.mockReturnValue(createMock<VoiceConnection>(connection))
    const manager = new VoiceManager(
      createMock<DiscordClient>({ user: { id: 'bot-user' } }),
      async () => undefined,
      async () => '',
      runtime,
      undefined,
      undefined,
      undefined,
      { record: signal => diagnostics.push({ ...signal }), runtimeSequence: 43 },
    )
    const channel = createMock<BaseGuildVoiceChannel>({
      guild: { id: 'guild-c3', members: { me: undefined }, voiceAdapterCreator: {} },
      guildId: 'guild-c3',
      id: 'voice-c3',
      members: new Map([['user-1', {
        displayName: 'C3 speaker',
        guild: { id: 'guild-c3', name: 'C3 guild' },
        id: 'user-1',
        user: { bot: false },
      }]]),
      name: 'C3 voice',
    })
    await manager.joinChannel(createMock<ChatInputCommandInteraction>({ reply: vi.fn(async () => {}) }), channel)
    await speakingStart('user-1')
    await vi.waitFor(() => expect(connection.receiver.subscribe).toHaveBeenCalledOnce())
    const packets = createOpusPcm16Fixture()
    for (let frame = 0; frame < 6; frame += 1)
      receiveStream.write(packets.nextSpeechPacket())
    await vi.waitFor(() => expect(provider.appendAudio).toHaveBeenCalled())
    const captureTurn = provider.appendAudio.mock.calls.at(-1)?.[1]
    if (!captureTurn)
      throw new Error('A successful public append must expose its capture sequence.')

    // ROOT CAUSE:
    //
    // inputTurnFor treats any positive inputSequence as authoritative. An
    // unknown item paired with the correct sequence can therefore erase an
    // unrelated pending aggregate and make its legitimate commit disappear.
    // Unknown clears must be rejected without mutating the real aggregate; its
    // actual item can still commit and respond.
    providerEvents.onInputCleared?.({ inputSequence: captureTurn, itemId: 'unknown-pending-item' })
    expect(diagnostics.filter(signal => signal.stage === 'provider-input-cleared')).toHaveLength(0)

    providerEvents.onInputCommitted?.({ inputSequence: captureTurn, itemId: 'real-pending-item' })
    providerEvents.onResponseCreated?.({ itemId: 'real-pending-item', responseId: 'real-pending-response' })
    providerEvents.onAudio?.(Buffer.from([1, 2]), { responseId: 'real-pending-response' })
    providerEvents.onResponseDone?.({ responseId: 'real-pending-response' }, 'completed')

    expect(provider.abortInput).not.toHaveBeenCalled()
    expect(provider.cancelResponse).not.toHaveBeenCalled()
    expect(provider.close).not.toHaveBeenCalled()
    expect(diagnostics.filter(signal => signal.stage === 'provider-input-committed')).toEqual([
      expect.objectContaining({
        aggregateTurnSequence: captureTurn,
        captureTurnSequences: [captureTurn],
        turnSequence: captureTurn,
      }),
    ])
    expect(diagnostics.filter(signal => signal.stage === 'provider-response-created')).toEqual([
      expect.objectContaining({ turnSequence: captureTurn }),
    ])
    expect(player.play).toHaveBeenCalledOnce()
    await manager.stop()
  })

  /** @example it('accepts only one mapped clear whose explicit sequence matches the pending owner', async () => {}) */
  it('accepts only one mapped clear whose explicit sequence matches the pending owner', async () => {
    vi.useFakeTimers()
    const harness = await createPublicCapacityHarness(true)
    const inputSequence = await completePublicCapacityCapture(harness, createOpusPcm16Fixture())

    // ROOT CAUSE:
    //
    // A clear that carries both identities is trustworthy only when its mapped
    // item and explicit sequence agree with the pending aggregate owner. The
    // previous protocol accepted a correct sequence even when the item was
    // unrelated, making item identity decorative rather than authoritative.
    harness.providerEvents().onSpeechStarted?.({ inputSequence, itemId: 'mapped-pending-item' })
    harness.providerEvents().onInputCleared?.({ inputSequence: inputSequence + 1, itemId: 'mapped-pending-item' })
    /** @example expect(harness.diagnostics.filter(signal => signal.stage === 'provider-input-cleared')).toHaveLength(0) */
    expect(harness.diagnostics.filter(signal => signal.stage === 'provider-input-cleared')).toHaveLength(0)

    harness.providerEvents().onInputCleared?.({ inputSequence, itemId: 'mapped-pending-item' })
    harness.providerEvents().onInputCleared?.({ inputSequence, itemId: 'mapped-pending-item' })
    /** @example expect(harness.diagnostics.filter(signal => signal.stage === 'provider-input-cleared')).toEqual([expect.objectContaining({ turnSequence: inputSequence })]) */
    expect(harness.diagnostics.filter(signal => signal.stage === 'provider-input-cleared')).toEqual([
      expect.objectContaining({ turnSequence: inputSequence }),
    ])
    /** @example expect(harness.provider.abortInput).not.toHaveBeenCalled() */
    expect(harness.provider.abortInput).not.toHaveBeenCalled()
    /** @example expect(harness.provider.cancelResponse).not.toHaveBeenCalled() */
    expect(harness.provider.cancelResponse).not.toHaveBeenCalled()
    /** @example expect(harness.provider.close).not.toHaveBeenCalled() */
    expect(harness.provider.close).not.toHaveBeenCalled()
    await harness.manager.stop()
  })

  /** @example it('does not treat an invalid explicit clear item as if the item were omitted', async () => {}) */
  it('does not treat an invalid explicit clear item as if the item were omitted', async () => {
    vi.useFakeTimers()
    const harness = await createPublicCapacityHarness(true)
    const inputSequence = await completePublicCapacityCapture(harness, createOpusPcm16Fixture())

    // ROOT CAUSE:
    //
    // Empty provider item ids are invalid explicit identities. Normalizing an
    // empty string to undefined turns an invalid item+sequence clear into a
    // sequence-only clear and incorrectly releases the pending aggregate.
    harness.providerEvents().onInputCleared?.({ inputSequence, itemId: '' })
    /** @example expect(harness.diagnostics.filter(signal => signal.stage === 'provider-input-cleared')).toHaveLength(0) */
    expect(harness.diagnostics.filter(signal => signal.stage === 'provider-input-cleared')).toHaveLength(0)

    harness.providerEvents().onInputCommitted?.({ inputSequence, itemId: 'healthy-after-invalid-clear' })
    harness.providerEvents().onResponseCreated?.({ itemId: 'healthy-after-invalid-clear', responseId: 'healthy-after-invalid-clear-response' })
    harness.providerEvents().onAudio?.(Buffer.from([1, 2]), { responseId: 'healthy-after-invalid-clear-response' })
    /** @example expect(harness.diagnostics.filter(signal => signal.stage === 'provider-input-committed')).toEqual([expect.objectContaining({ turnSequence: inputSequence })]) */
    expect(harness.diagnostics.filter(signal => signal.stage === 'provider-input-committed')).toEqual([
      expect.objectContaining({ turnSequence: inputSequence }),
    ])
    /** @example expect(harness.player.play).toHaveBeenCalledOnce() */
    expect(harness.player.play).toHaveBeenCalledOnce()
    /** @example expect(harness.provider.close).not.toHaveBeenCalled() */
    expect(harness.provider.close).not.toHaveBeenCalled()
    await harness.manager.stop()
  })

  /** @example it('accepts a valid sequence-only clear but rejects a clear with no identity', async () => {}) */
  it('accepts a valid sequence-only clear but rejects a clear with no identity', async () => {
    vi.useFakeTimers()
    const harness = await createPublicCapacityHarness(true)
    const inputSequence = await completePublicCapacityCapture(harness, createOpusPcm16Fixture())

    // ROOT CAUSE:
    //
    // Qwen's timer/abort path legitimately supplies only the exact owner
    // sequence. That allowance must not become a fallback for a callback that
    // supplies neither item nor sequence.
    harness.providerEvents().onInputCleared?.({})
    /** @example expect(harness.diagnostics.filter(signal => signal.stage === 'provider-input-cleared')).toHaveLength(0) */
    expect(harness.diagnostics.filter(signal => signal.stage === 'provider-input-cleared')).toHaveLength(0)
    harness.providerEvents().onInputCleared?.({ inputSequence })
    /** @example expect(harness.diagnostics.filter(signal => signal.stage === 'provider-input-cleared')).toEqual([expect.objectContaining({ turnSequence: inputSequence })]) */
    expect(harness.diagnostics.filter(signal => signal.stage === 'provider-input-cleared')).toEqual([
      expect.objectContaining({ turnSequence: inputSequence }),
    ])
    await harness.manager.stop()
  })

  /** @example it('retires a generation before a sixty-fifth committed provider input can remain awaiting response.created', async () => {}) */
  it('retires a generation before a sixty-fifth committed provider input can remain awaiting response.created', async () => {
    vi.useFakeTimers()
    const harness = await createPublicCapacityHarness(true)
    const packets = createOpusPcm16Fixture()
    const captures: number[] = []

    for (let capture = 1; capture <= 65; capture += 1) {
      const inputSequence = await completePublicCapacityCapture(harness, packets)
      captures.push(inputSequence)
      harness.providerEvents().onInputCommitted?.({ inputSequence, itemId: `backlog-item-${inputSequence}` })
      await vi.runAllTicks()
    }

    // ROOT CAUSE:
    //
    // A committed input awaits response.created in a manager-owned record. The
    // source has a 64-record cap, but the existing 65th branch merely logs and
    // leaves the generation alive. A warning alone retains unbounded provider
    // ownership and lets later protocol callbacks act on a partial generation.
    //
    // Before the repair, 64 records remain and the 65th pending aggregate stays
    // live. After the repair, the 65th commit retires the generation exactly
    // once; its late response cannot create diagnostics or Discord playback.
    expect(captures).toEqual(Array.from({ length: 65 }, (_, index) => index + 1))
    expect(harness.diagnostics.filter(signal => signal.stage === 'provider-input-committed').map(signal => signal.turnSequence)).toEqual(
      Array.from({ length: 64 }, (_, index) => index + 1),
    )

    harness.providerEvents().onResponseCreated?.({ itemId: 'backlog-item-65', responseId: 'backlog-response-65' })
    harness.providerEvents().onAudio?.(Buffer.from([1, 2]), { responseId: 'backlog-response-65' })
    harness.providerEvents().onResponseDone?.({ responseId: 'backlog-response-65' }, 'completed')

    expect(harness.provider.abortInput).toHaveBeenCalledOnce()
    expect(harness.provider.cancelResponse).toHaveBeenCalledOnce()
    expect(harness.provider.close).toHaveBeenCalledOnce()
    expect(harness.diagnostics.filter(signal => signal.stage === 'provider-response-created' || signal.stage === 'provider-response-audio')).toHaveLength(0)
    expect(harness.player.play).not.toHaveBeenCalled()
    await harness.manager.stop()
  })

  /** @example it('reports an admitted sixty-fifth capture as a failed provider-capacity boundary without giving it provider ownership', async () => {}) */
  it('reports an admitted sixty-fifth capture as a failed provider-capacity boundary without giving it provider ownership', async () => {
    vi.useFakeTimers()
    const { captures, harness } = await overflowPublicCapacityWithoutAcknowledgements()

    // ROOT CAUSE:
    //
    // Local PCM admission and provider input ownership are independent facts.
    // appendAudio returning true is not proof that the provider acknowledged
    // input. If callbacks are lost forever, capture ownership must be bounded
    // before the next provider call, not after a sixty-fifth raw send has
    // already escaped the Discord safety boundary.
    //
    // Before the repair, capture 65 reaches appendAudio and only later events
    // can expose exhaustion. After the ownership-preflight repair, the local
    // gate still admits capture 65, but provider ownership rejects it before
    // any provider call. The terminal failure must therefore be visible as
    // provider-input-capacity and must clean the session as failed, not
    // replaced. Late provider callbacks must remain unable to revive it.
    /** @example expect(captures).toEqual(Array.from({ length: 64 }, (_, index) => index + 1)) */
    expect(captures).toEqual(Array.from({ length: 64 }, (_, index) => index + 1))
    const localAdmissionTurnSequences = harness.diagnostics.flatMap((signal) => {
      if (signal.stage !== 'local-input-admitted')
        return []
      return [signal.turnSequence]
    })
    /** @example expect(localAdmissionTurnSequences).toEqual(Array.from({ length: 65 }, (_, index) => index + 1)) */
    expect(localAdmissionTurnSequences).toEqual(
      Array.from({ length: 65 }, (_, index) => index + 1),
    )
    const providerInputSequences = [...new Set(harness.provider.appendAudio.mock.calls.map(([, inputSequence]) => inputSequence))]
    // One capture can legally contain several PCM chunks. The boundary that
    // must stay capped is its first provider append / input identity, not the
    // number of chunks already owned by the first 64 captures.
    /** @example expect(providerInputSequences).toEqual(Array.from({ length: 64 }, (_, index) => index + 1)) */
    expect(providerInputSequences).toEqual(Array.from({ length: 64 }, (_, index) => index + 1))
    /** @example expect(harness.provider.abortInput).toHaveBeenCalledOnce() */
    expect(harness.provider.abortInput).toHaveBeenCalledOnce()
    /** @example expect(harness.provider.cancelResponse).toHaveBeenCalledOnce() */
    expect(harness.provider.cancelResponse).toHaveBeenCalledOnce()
    /** @example expect(harness.provider.close).toHaveBeenCalledOnce() */
    expect(harness.provider.close).toHaveBeenCalledOnce()
    /** @example expect(harness.diagnostics.filter(signal => signal.stage === 'provider-input-appended')).toHaveLength(0) */
    expect(harness.diagnostics.filter(signal => signal.stage === 'provider-input-appended')).toHaveLength(0)
    /** @example expect(harness.diagnostics.filter(signal => signal.stage === 'failure' && signal.turnSequence === 65)).toEqual([expect.objectContaining({ failureCategory: 'provider-input-capacity' })]) */
    expect(harness.diagnostics.filter(signal => signal.stage === 'failure' && signal.turnSequence === 65)).toEqual([
      expect.objectContaining({ failureCategory: 'provider-input-capacity' }),
    ])
    /** @example expect(harness.diagnostics.filter(signal => signal.stage === 'session-cleaned')).toEqual([expect.objectContaining({ cleanupReason: 'failed' })]) */
    expect(harness.diagnostics.filter(signal => signal.stage === 'session-cleaned')).toEqual([
      expect.objectContaining({ cleanupReason: 'failed' }),
    ])
    const admittedIndex = harness.diagnostics.findIndex(signal => signal.stage === 'local-input-admitted' && signal.turnSequence === 65)
    const failureIndex = harness.diagnostics.findIndex(signal => signal.stage === 'failure' && signal.turnSequence === 65)
    const cleanedIndex = harness.diagnostics.findIndex(signal => signal.stage === 'session-cleaned' && signal.cleanupReason === 'failed')
    /** @example expect(admittedIndex).toBeGreaterThanOrEqual(0) */
    expect(admittedIndex).toBeGreaterThanOrEqual(0)
    /** @example expect(failureIndex).toBeGreaterThan(admittedIndex) */
    expect(failureIndex).toBeGreaterThan(admittedIndex)
    /** @example expect(cleanedIndex).toBeGreaterThan(failureIndex) */
    expect(cleanedIndex).toBeGreaterThan(failureIndex)
    const turn65ProviderSignals = harness.diagnostics.filter((signal) => {
      if (!('turnSequence' in signal) || signal.turnSequence !== 65)
        return false
      return signal.stage === 'provider-input-appended'
        || signal.stage === 'provider-input-committed'
        || signal.stage === 'provider-response-audio'
        || signal.stage === 'provider-response-created'
        || signal.stage === 'playback-started'
    })
    /** @example expect(turn65ProviderSignals).toHaveLength(0) */
    expect(turn65ProviderSignals).toHaveLength(0)

    const lateInputSequence = 65
    const diagnosticsBeforeLateCallbacks = harness.diagnostics.length
    harness.providerEvents().onInputAudioSent?.({
      byteLength: 640,
      chunkCount: 1,
      inputSequence: lateInputSequence,
      kind: 'user-audio',
    })
    harness.providerEvents().onInputCommitted?.({ inputSequence: lateInputSequence, itemId: 'lost-ack-item-65' })
    harness.providerEvents().onResponseCreated?.({ itemId: 'lost-ack-item-65', responseId: 'lost-ack-response-65' })
    harness.providerEvents().onAudio?.(Buffer.from([3, 4]), { responseId: 'lost-ack-response-65' })
    harness.providerEvents().onResponseDone?.({ responseId: 'lost-ack-response-65' }, 'completed')

    /** @example expect(harness.provider.close).toHaveBeenCalledOnce() */
    expect(harness.provider.close).toHaveBeenCalledOnce()
    /** @example expect(harness.diagnostics).toHaveLength(diagnosticsBeforeLateCallbacks) */
    expect(harness.diagnostics).toHaveLength(diagnosticsBeforeLateCallbacks)
    /** @example expect(harness.diagnostics.filter(signal => signal.stage === 'provider-input-committed')).toHaveLength(0) */
    expect(harness.diagnostics.filter(signal => signal.stage === 'provider-input-committed')).toHaveLength(0)
    /** @example expect(harness.diagnostics.filter(signal => signal.stage === 'provider-response-created' || signal.stage === 'provider-response-audio')).toHaveLength(0) */
    expect(harness.diagnostics.filter(signal => signal.stage === 'provider-response-created' || signal.stage === 'provider-response-audio')).toHaveLength(0)
    /** @example expect(harness.player.play).not.toHaveBeenCalled() */
    expect(harness.player.play).not.toHaveBeenCalled()
    await harness.manager.stop()
  })

  /** @example it('cleans an admitted capacity rejection as failed rather than replaced', async () => {}) */
  it('cleans an admitted capacity rejection as failed rather than replaced', async () => {
    vi.useFakeTimers()
    const { harness } = await overflowPublicCapacityWithoutAcknowledgements()

    // ROOT CAUSE:
    //
    // Capacity exhaustion is a terminal provider-ownership failure for the
    // current voice generation. Marking that cleanup as replaced falsely
    // claims a successor generation caused it and makes the Dashboard hide a
    // failed capacity boundary.
    //
    // The local gate has already admitted turn 65, so the one terminal cleanup
    // must be `failed` even though no provider input record was ever created.
    /** @example expect(harness.diagnostics.filter(signal => signal.stage === 'session-cleaned')).toEqual([expect.objectContaining({ cleanupReason: 'failed' })]) */
    expect(harness.diagnostics.filter(signal => signal.stage === 'session-cleaned')).toEqual([
      expect.objectContaining({ cleanupReason: 'failed' }),
    ])
    /** @example expect(harness.diagnostics.filter(signal => signal.stage === 'local-input-admitted' && signal.turnSequence === 65)).toHaveLength(1) */
    expect(harness.diagnostics.filter(signal => signal.stage === 'local-input-admitted' && signal.turnSequence === 65)).toHaveLength(1)
    /** @example expect(harness.diagnostics.filter(signal => signal.stage === 'provider-input-appended' || signal.stage === 'provider-input-committed')).toHaveLength(0) */
    expect(harness.diagnostics.filter(signal => signal.stage === 'provider-input-appended' || signal.stage === 'provider-input-committed')).toHaveLength(0)
    /** @example expect(harness.provider.abortInput).toHaveBeenCalledOnce() */
    expect(harness.provider.abortInput).toHaveBeenCalledOnce()
    /** @example expect(harness.provider.cancelResponse).toHaveBeenCalledOnce() */
    expect(harness.provider.cancelResponse).toHaveBeenCalledOnce()
    /** @example expect(harness.provider.close).toHaveBeenCalledOnce() */
    expect(harness.provider.close).toHaveBeenCalledOnce()
    await harness.manager.stop()
  })

  /** @example it('preserves a class-based provider instance through append, finish, and cleanup', async () => {}) */
  it('preserves a class-based provider instance through append, finish, and cleanup', async () => {
    let provider: InstanceBoundProvider | undefined
    class InstanceBoundProvider {
      appendCalls = 0
      abortCalls = 0
      cancelCalls = 0
      closeCalls = 0
      finishCalls = 0
      lastInputSequence: number | undefined

      constructor(private readonly events: RealtimeVoiceCallSessionEvents) {}

      appendAudio(pcm: Buffer, inputSequence: number): boolean {
        this.appendCalls += 1
        this.lastInputSequence = inputSequence
        this.events.onInputAudioSent?.({ byteLength: pcm.length, chunkCount: 1, inputSequence, kind: 'user-audio' })
        return true
      }

      abortInput(): void {
        this.abortCalls += 1
      }

      cancelResponse(): void {
        this.cancelCalls += 1
      }

      close(): void {
        this.closeCalls += 1
      }

      finishInput(): void {
        this.finishCalls += 1
      }
    }
    const runtime = {
      connect: vi.fn(async (events: RealtimeVoiceCallSessionEvents) => {
        provider = new InstanceBoundProvider(events)
        return provider
      }),
      getInterruptionRmsThreshold: () => 0.04,
      getMode: () => 'qwen-realtime' as const,
      isConfigured: () => true,
    }
    const fixture = createPublicRealtimeChannel('guild-instance-provider', 'voice-instance-provider', 'user-instance-provider')
    voiceMocks.joinVoiceChannel.mockReturnValue(createMock<VoiceConnection>(fixture.connection))
    const manager = new VoiceManager(
      createMock<DiscordClient>({ user: { id: 'bot-user' } }),
      async () => undefined,
      async () => '',
      runtime,
    )
    await manager.joinChannel(createMock<ChatInputCommandInteraction>({ reply: vi.fn(async () => {}) }), fixture.channel)
    if (!provider)
      throw new Error('The public runtime connection must retain its provider instance.')

    // ROOT CAUSE:
    //
    // Wrapping a provider with object spread keeps only own properties. Native
    // providers commonly put lifecycle methods on their prototype and depend on
    // instance fields through `this`; a spread wrapper therefore drops finish,
    // abort, cancel, and close despite appendAudio being bound separately.
    //
    // The manager must preserve the original public provider instance while it
    // adds correlation behavior. Receiver append, terminal finish, and leave
    // cleanup must all call the same instance exactly once.
    fixture.speaking.emit('start', fixture.userId)
    await vi.waitFor(() => expect(fixture.connection.receiver.subscribe).toHaveBeenCalledOnce())
    const packets = createOpusPcm16Fixture()
    for (let frame = 0; frame < 6; frame += 1)
      fixture.receiveStream.write(packets.nextSpeechPacket())
    await vi.waitFor(() => expect(provider.appendCalls).toBeGreaterThan(0))
    /** @example expect(provider.lastInputSequence).toBe(1) */
    expect(provider.lastInputSequence).toBe(1)

    fixture.speaking.emit('end', fixture.userId)
    await vi.waitFor(() => expect(provider.finishCalls).toBe(1))
    manager.leaveChannel(fixture.channel)
    /** @example expect(provider.abortCalls).toBe(1) */
    expect(provider.abortCalls).toBe(1)
    /** @example expect(provider.cancelCalls).toBe(1) */
    expect(provider.cancelCalls).toBe(1)
    /** @example expect(provider.closeCalls).toBe(1) */
    expect(provider.closeCalls).toBe(1)
    /** @example expect(fixture.connection.destroy).toHaveBeenCalledOnce() */
    expect(fixture.connection.destroy).toHaveBeenCalledOnce()
    await manager.stop()
    /** @example expect(provider.closeCalls).toBe(1) */
    expect(provider.closeCalls).toBe(1)
  })

  /**
   * @example
   * it('reproduces Discord audit D-016 by containing speaking-end cleanup rejection at the receiver boundary', async () => {})
   */
  it('reproduces Discord audit D-016 by containing speaking-end cleanup rejection at the receiver boundary', async () => {
    let speakingEnd = (_userId: string): Promise<void> => Promise.resolve()
    const provider = {
      abortInput: vi.fn(),
      appendAudio: vi.fn(() => true),
      cancelResponse: vi.fn(),
      close: vi.fn(),
      finishInput: vi.fn(),
    }
    const runtime = {
      connect: vi.fn(async () => provider),
      getInterruptionRmsThreshold: () => 0.04,
      getMode: () => 'qwen-realtime' as const,
      isConfigured: () => true,
    }
    const connection = {
      destroy: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
      receiver: {
        speaking: {
          off: vi.fn(),
          on: vi.fn((event: string, listener: (userId: string) => Promise<void>) => {
            if (event === 'end')
              speakingEnd = listener
          }),
        },
      },
      state: { status: 'ready' },
    }
    voiceMocks.joinVoiceChannel.mockReturnValue(createMock<VoiceConnection>(connection))
    const manager = new VoiceManager(
      createMock<DiscordClient>({ user: { id: 'bot-user' } }),
      async () => undefined,
      async () => '',
      runtime,
      { admit: () => true, allows: () => false },
    )
    const channel = createMock<BaseGuildVoiceChannel>({
      guild: { id: 'guild-1', members: { me: undefined }, voiceAdapterCreator: {} },
      id: 'voice-1',
      members: new Map([['user-1', { id: 'user-1', user: { bot: false } }]]),
      name: 'Synthetic voice',
    })
    await manager.joinChannel(
      createMock<ChatInputCommandInteraction>({ reply: vi.fn(async () => {}) }),
      channel,
    )
    const session = Reflect.get(manager, 'activeVoiceSessionsByGuildId').get('guild-1')
    const stopCapture = vi.fn(() => {
      throw new Error('synthetic capture cleanup failure')
    })
    Reflect.get(manager, 'activeMonitors').set(`guild-1:voice-1:${session.scope.generation}:user-1`, {
      admitted: true,
      capture: { id: Symbol('capture') },
      finishing: false,
      scope: session.scope,
      stop: stopCapture,
      userId: 'user-1',
    })

    // ROOT CAUSE:
    //
    // The raw receiver speaking-end async listener could reject when exact
    // capture cleanup threw before or after policy revocation. Discord's
    // EventEmitter never observes that promise, producing an unhandled rejection
    // and leaving the channel provider generation partially alive.
    /**
     * @example
     * await expect(speakingEnd('user-1')).resolves.toBeUndefined()
     */
    await expect(speakingEnd('user-1')).resolves.toBeUndefined()
    /**
     * @example
     * expect(stopCapture).toHaveBeenCalledOnce()
     */
    expect(stopCapture).toHaveBeenCalledOnce()
    /**
     * @example
     * expect(provider.abortInput).toHaveBeenCalledOnce()
     */
    expect(provider.abortInput).toHaveBeenCalledOnce()
    /**
     * @example
     * expect(provider.cancelResponse).toHaveBeenCalledOnce()
     */
    expect(provider.cancelResponse).toHaveBeenCalledOnce()
    /**
     * @example
     * expect(provider.close).toHaveBeenCalledOnce()
     */
    expect(provider.close).toHaveBeenCalledOnce()
    /**
     * @example
     * expect(activeVoiceSessionsByGuildId.size).toBe(0)
     */
    expect(Reflect.get(manager, 'activeVoiceSessionsByGuildId').size).toBe(0)
    await manager.stop()
  })

  /**
   * @example
   * it('reproduces Discord audit D-016 by completing realtime playback cleanup after one resource throws', () => {})
   */
  it('reproduces Discord audit D-016 by completing realtime playback cleanup after one resource throws', () => {
    const manager = createManager()
    const cleanupFailure = new Error('synthetic realtime input cleanup failure')
    const input = {
      destroy: vi.fn(() => {
        throw cleanupFailure
      }),
      destroyed: false,
      removeListener: vi.fn(),
    }
    const converted = { removeListener: vi.fn() }
    const player = {
      removeAllListeners: vi.fn(),
      stop: vi.fn(),
    }
    const playback = {
      cleaned: false,
      converted,
      handlePlaybackError: vi.fn(),
      handlePlayerStateChange: vi.fn(),
      input,
      player,
      scope: { channelId: 'voice-1', generation: 1, guildId: 'guild-1' },
      started: false,
      terminalReported: false,
    }
    Reflect.get(manager, 'activeRealtimePlaybacks').set('guild-1:voice-1:1', playback)

    // ROOT CAUSE:
    //
    // Realtime playback cleanup called input.destroy(), player.stop(), and
    // removeAllListeners() as one fail-fast sequence. A native stream cleanup
    // error skipped the player teardown and leaked listeners after stop.
    /**
     * @example
     * expect(() => cleanup(playback)).toThrow(cleanupFailure)
     */
    expect(() => Reflect.apply(Reflect.get(manager, 'cleanupRealtimePlayback'), manager, [playback])).toThrow(cleanupFailure)
    /**
     * @example
     * expect(player.stop).toHaveBeenCalledOnce()
     */
    expect(player.stop).toHaveBeenCalledOnce()
    /**
     * @example
     * expect(player.removeAllListeners).toHaveBeenCalledOnce()
     */
    expect(player.removeAllListeners).toHaveBeenCalledOnce()
    /**
     * @example
     * expect(activeRealtimePlaybacks.size).toBe(0)
     */
    expect(Reflect.get(manager, 'activeRealtimePlaybacks').size).toBe(0)
  })

  /**
   * @example
   * it('reproduces Discord audit D-018 by completing classic playback cleanup after the stream throws', () => {})
   */
  it('reproduces Discord audit D-018 by completing classic playback cleanup after the stream throws', () => {
    const manager = createManager()
    const cleanupFailure = new Error('synthetic classic stream cleanup failure')
    const abortController = new AbortController()
    const audioStream = {
      destroy: vi.fn(() => {
        throw cleanupFailure
      }),
      destroyed: false,
    }
    const player = {
      removeAllListeners: vi.fn(),
      stop: vi.fn(),
    }
    const playback = {
      abortSignal: abortController.signal,
      audioStream,
      cleaned: false,
      player,
      scope: { channelId: 'voice-1', generation: 1, guildId: 'guild-1' },
      stopAbortedPlayback: vi.fn(),
    }
    Reflect.get(manager, 'activeClassicPlaybacks').set('guild-1:voice-1:1', playback)

    // ROOT CAUSE:
    //
    // Classic TTS playback cleanup used one fail-fast sequence. If stream
    // destruction threw, the scoped player and its listeners survived even
    // though the generation owner had already been removed from the map.
    /**
     * @example
     * expect(() => cleanup(playback)).toThrow(cleanupFailure)
     */
    expect(() => Reflect.apply(Reflect.get(manager, 'cleanupClassicPlayback'), manager, [playback.scope, playback])).toThrow(cleanupFailure)
    /**
     * @example
     * expect(player.stop).toHaveBeenCalledOnce()
     */
    expect(player.stop).toHaveBeenCalledOnce()
    /**
     * @example
     * expect(player.removeAllListeners).toHaveBeenCalledOnce()
     */
    expect(player.removeAllListeners).toHaveBeenCalledOnce()
    /**
     * @example
     * expect(activeClassicPlaybacks.size).toBe(0)
     */
    expect(Reflect.get(manager, 'activeClassicPlaybacks').size).toBe(0)
  })

  /**
   * @example
   * it('reproduces Discord audit D-018 by rolling back classic resource handoff when player startup throws', async () => {})
   */
  it('reproduces Discord audit D-018 by rolling back classic resource handoff when player startup throws', async () => {
    const manager = createManager()
    const startupFailure = new Error('synthetic classic player startup failure')
    const player = {
      on: vi.fn(),
      play: vi.fn(() => {
        throw startupFailure
      }),
      removeAllListeners: vi.fn(),
      state: { status: 'idle' },
      stop: vi.fn(),
    }
    voiceMocks.createAudioPlayer.mockReturnValue(createMock<AudioPlayer>(player))
    const connection = createMock<VoiceConnection>({ subscribe: vi.fn() })
    const audioStream = new PassThrough()
    const destroyAudioStream = vi.spyOn(audioStream, 'destroy')
    const abortController = new AbortController()
    const removeAbortListener = vi.spyOn(abortController.signal, 'removeEventListener')
    const scope = { channelId: 'voice-1', generation: 1, guildId: 'guild-1' }

    // ROOT CAUSE:
    //
    // Classic resource handoff published the playback owner before subscribing,
    // building the audio resource, and starting the player. A synchronous throw
    // from any later step bypassed cleanup, retaining the stream, player listeners,
    // abort callback, and active playback map entry.
    /**
     * @example
     * await expect(playAudioStream()).rejects.toBe(startupFailure)
     */
    await expect(manager.playAudioStream(
      connection,
      audioStream,
      abortController.signal,
      scope,
      Number.MAX_SAFE_INTEGER,
    )).rejects.toBe(startupFailure)
    /**
     * @example
     * expect(destroyAudioStream).toHaveBeenCalledOnce()
     */
    expect(destroyAudioStream).toHaveBeenCalledOnce()
    /**
     * @example
     * expect(player.stop).toHaveBeenCalledOnce()
     */
    expect(player.stop).toHaveBeenCalledOnce()
    /**
     * @example
     * expect(player.removeAllListeners).toHaveBeenCalledOnce()
     */
    expect(player.removeAllListeners).toHaveBeenCalledOnce()
    /**
     * @example
     * expect(activeClassicPlaybacks.size).toBe(0)
     */
    expect(Reflect.get(manager, 'activeClassicPlaybacks').size).toBe(0)
    /**
     * @example
     * expect(removeAbortListener).toHaveBeenCalledWith('abort', expect.any(Function))
     */
    expect(removeAbortListener).toHaveBeenCalledWith('abort', expect.any(Function))
    abortController.abort(new Error('synthetic late abort'))
    /**
     * @example
     * expect(player.stop).toHaveBeenCalledOnce()
     */
    expect(player.stop).toHaveBeenCalledOnce()
  })

  /**
   * @example
   * it('reproduces Discord audit D-018 by rejecting a generation aborted during classic subscription', async () => {})
   */
  it('reproduces Discord audit D-018 by rejecting a generation aborted during classic subscription', async () => {
    const manager = createManager()
    const abortController = new AbortController()
    const removeAbortListener = vi.spyOn(abortController.signal, 'removeEventListener')
    const player = {
      on: vi.fn(),
      play: vi.fn(),
      removeAllListeners: vi.fn(),
      state: { status: 'idle' },
      stop: vi.fn(),
    }
    voiceMocks.createAudioPlayer.mockReturnValue(createMock<AudioPlayer>(player))
    const connection = createMock<VoiceConnection>({
      subscribe: vi.fn(() => {
        abortController.abort(new Error('synthetic generation replacement during subscribe'))
      }),
    })
    const audioStream = new PassThrough()
    const destroyAudioStream = vi.spyOn(audioStream, 'destroy')
    const scope = { channelId: 'voice-1', generation: 1, guildId: 'guild-1' }

    // ROOT CAUSE:
    //
    // Classic playback checked cancellation only before subscribing. If the
    // synchronous subscription boundary invalidated the generation, the abort
    // listener was registered too late to observe it and the stale turn still
    // created a resource and started playback after stop/replacement.
    await manager.playAudioStream(
      connection,
      audioStream,
      abortController.signal,
      scope,
      Number.MAX_SAFE_INTEGER,
    )

    /**
     * @example
     * expect(voiceMocks.createAudioResource).not.toHaveBeenCalled()
     */
    expect(voiceMocks.createAudioResource).not.toHaveBeenCalled()
    /**
     * @example
     * expect(player.play).not.toHaveBeenCalled()
     */
    expect(player.play).not.toHaveBeenCalled()
    /**
     * @example
     * expect(destroyAudioStream).toHaveBeenCalledOnce()
     */
    expect(destroyAudioStream).toHaveBeenCalledOnce()
    /**
     * @example
     * expect(removeAbortListener).toHaveBeenCalledWith('abort', expect.any(Function))
     */
    expect(removeAbortListener).toHaveBeenCalledWith('abort', expect.any(Function))
    /**
     * @example
     * expect(activeClassicPlaybacks.size).toBe(0)
     */
    expect(Reflect.get(manager, 'activeClassicPlaybacks').size).toBe(0)
  })

  /**
   * @example
   * it('reproduces Discord audit D-018 by destroying an unowned stream when classic player creation throws', async () => {})
   */
  it('reproduces Discord audit D-018 by destroying an unowned stream when classic player creation throws', async () => {
    const manager = createManager()
    const startupFailure = new Error('synthetic classic player factory failure')
    voiceMocks.createAudioPlayer.mockImplementation(() => {
      throw startupFailure
    })
    const audioStream = new PassThrough()
    const destroyAudioStream = vi.spyOn(audioStream, 'destroy')

    // ROOT CAUSE:
    //
    // The incoming TTS stream had no published owner while createAudioPlayer
    // ran outside the startup rollback boundary. A synchronous factory failure
    // therefore leaked the stream and replaced no active-map entry to clean it.
    /**
     * @example
     * await expect(playAudioStream()).rejects.toBe(startupFailure)
     */
    await expect(manager.playAudioStream(
      createMock<VoiceConnection>({ subscribe: vi.fn() }),
      audioStream,
      new AbortController().signal,
      { channelId: 'voice-1', generation: 1, guildId: 'guild-1' },
      Number.MAX_SAFE_INTEGER,
    )).rejects.toBe(startupFailure)
    /**
     * @example
     * expect(destroyAudioStream).toHaveBeenCalledOnce()
     */
    expect(destroyAudioStream).toHaveBeenCalledOnce()
    /**
     * @example
     * expect(activeClassicPlaybacks.size).toBe(0)
     */
    expect(Reflect.get(manager, 'activeClassicPlaybacks').size).toBe(0)
  })

  /**
   * @example
   * it('reproduces Discord audit D-018 by rejecting playback when subscription crosses the absolute deadline', async () => {})
   */
  it('reproduces Discord audit D-018 by rejecting playback when subscription crosses the absolute deadline', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const manager = createManager()
    const player = {
      on: vi.fn(),
      play: vi.fn(),
      removeAllListeners: vi.fn(),
      state: { status: 'idle' },
      stop: vi.fn(),
    }
    voiceMocks.createAudioPlayer.mockReturnValue(createMock<AudioPlayer>(player))
    const connection = createMock<VoiceConnection>({
      subscribe: vi.fn(() => {
        vi.setSystemTime(2_001)
      }),
    })
    const audioStream = new PassThrough()
    const destroyAudioStream = vi.spyOn(audioStream, 'destroy')

    // ROOT CAUSE:
    //
    // The classic turn checked its deadline before calling playAudioStream, but
    // the handoff retained only AbortSignal. A synchronous subscription could
    // cross the absolute deadline before the timer callback ran, after which the
    // stale turn still built a resource and started Discord playback.
    /**
     * @example
     * await expect(playAudioStream()).rejects.toMatchObject({ kind: 'timeout' })
     */
    await expect(manager.playAudioStream(
      connection,
      audioStream,
      new AbortController().signal,
      { channelId: 'voice-1', generation: 1, guildId: 'guild-1' },
      2_000,
    )).rejects.toMatchObject({
      kind: 'timeout',
      name: 'SpeechProviderTimeoutError',
    })
    /**
     * @example
     * expect(voiceMocks.createAudioResource).not.toHaveBeenCalled()
     */
    expect(voiceMocks.createAudioResource).not.toHaveBeenCalled()
    /**
     * @example
     * expect(player.play).not.toHaveBeenCalled()
     */
    expect(player.play).not.toHaveBeenCalled()
    /**
     * @example
     * expect(destroyAudioStream).toHaveBeenCalledOnce()
     */
    expect(destroyAudioStream).toHaveBeenCalledOnce()
    /**
     * @example
     * expect(activeClassicPlaybacks.size).toBe(0)
     */
    expect(Reflect.get(manager, 'activeClassicPlaybacks').size).toBe(0)
  })

  /**
   * @example
   * it('reproduces Discord audit D-018 by rejecting playback when resource creation crosses the absolute deadline', async () => {})
   */
  it('reproduces Discord audit D-018 by rejecting playback when resource creation crosses the absolute deadline', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(3_000)
    const manager = createManager()
    const player = {
      on: vi.fn(),
      play: vi.fn(),
      removeAllListeners: vi.fn(),
      state: { status: 'idle' },
      stop: vi.fn(),
    }
    voiceMocks.createAudioPlayer.mockReturnValue(createMock<AudioPlayer>(player))
    voiceMocks.createAudioResource.mockImplementation(() => {
      vi.setSystemTime(4_001)
      return createMock<AudioResource<null>>({})
    })
    const audioStream = new PassThrough()
    const destroyAudioStream = vi.spyOn(audioStream, 'destroy')

    // ROOT CAUSE:
    //
    // Resource construction is another synchronous external boundary. Without
    // an absolute Date gate after it, a turn could expire during decode/resource
    // ownership transfer and still call player.play before its timeout task ran.
    /**
     * @example
     * await expect(playAudioStream()).rejects.toMatchObject({ kind: 'timeout' })
     */
    await expect(manager.playAudioStream(
      createMock<VoiceConnection>({ subscribe: vi.fn() }),
      audioStream,
      new AbortController().signal,
      { channelId: 'voice-1', generation: 1, guildId: 'guild-1' },
      4_000,
    )).rejects.toMatchObject({
      kind: 'timeout',
      name: 'SpeechProviderTimeoutError',
    })
    /**
     * @example
     * expect(voiceMocks.createAudioResource).toHaveBeenCalledOnce()
     */
    expect(voiceMocks.createAudioResource).toHaveBeenCalledOnce()
    /**
     * @example
     * expect(player.play).not.toHaveBeenCalled()
     */
    expect(player.play).not.toHaveBeenCalled()
    /**
     * @example
     * expect(destroyAudioStream).toHaveBeenCalledOnce()
     */
    expect(destroyAudioStream).toHaveBeenCalledOnce()
    /**
     * @example
     * expect(activeClassicPlaybacks.size).toBe(0)
     */
    expect(Reflect.get(manager, 'activeClassicPlaybacks').size).toBe(0)
  })

  /**
   * @example
   * it('reproduces Discord audit D-018 by classifying an expired operation before its deadline timer runs', async () => {})
   */
  it('reproduces Discord audit D-018 by classifying an expired operation before its deadline timer runs', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(10_000)
    const manager = createManager()
    const speakerKey = 'guild-1:voice-1:1:user-1'
    const state = {
      abortSignal: new AbortController().signal,
      buffers: [],
      capture: { id: Symbol('synthetic-capture') },
      connection: createMock<VoiceConnection>({}),
      lastActive: 0,
      scope: { channelId: 'voice-1', generation: 1, guildId: 'guild-1' },
      speaker: { displayName: 'Synthetic speaker', guildName: 'Synthetic guild' },
      totalLength: 0,
      transcriptionText: '',
      userId: 'user-1',
    }
    Reflect.get(manager, 'userStates').set(speakerKey, state)
    const boundary = Reflect.apply(
      Reflect.get(manager, 'beginClassicVoiceTurn'),
      manager,
      [speakerKey, state],
    ) as { readonly deadlineAt: number, readonly signal: AbortSignal }
    let rejectOperation = (_error: Error) => {}
    const operation = new Promise<never>((_resolve, reject) => {
      rejectOperation = reject
    })
    const waiting = Reflect.apply(
      Reflect.get(manager, 'waitForClassicVoiceTurnOperation'),
      manager,
      [operation, boundary, 'stt'],
    )

    // ROOT CAUSE:
    //
    // Operation settlement checked the absolute deadline, but its replacement
    // error looked only at AbortSignal.reason. If wall-clock time crossed the
    // deadline before the scheduled timer callback ran, a real timeout was
    // mislabeled as cancellation and emitted the wrong structured failure kind.
    vi.setSystemTime(boundary.deadlineAt + 1)
    rejectOperation(new Error('synthetic late provider rejection'))
    /**
     * @example
     * await expect(waiting).rejects.toMatchObject({ kind: 'timeout' })
     */
    await expect(waiting).rejects.toMatchObject({
      kind: 'timeout',
      name: 'SpeechProviderTimeoutError',
    })
    /**
     * @example
     * expect(boundary.signal.aborted).toBe(false)
     */
    expect(boundary.signal.aborted).toBe(false)
    Reflect.apply(Reflect.get(manager, 'finishClassicVoiceTurn'), manager, [boundary])
  })

  /**
   * @example
   * it('reproduces Discord audit D-016 by destroying the decoder after receiver cleanup throws', async () => {})
   */
  it('reproduces Discord audit D-016 by destroying the decoder after receiver cleanup throws', async () => {
    const receiveStream = new PassThrough()
    const connection = {
      destroy: vi.fn(),
      joinConfig: { guildId: 'guild-1' },
      receiver: { subscribe: vi.fn(() => receiveStream) },
      state: { status: 'ready' },
    }
    voiceMocks.getVoiceConnections.mockReturnValue(createMock<Map<string, VoiceConnection>>(new Map([['guild-1', connection]])))
    const manager = createManager()
    const member = createMock<GuildMember>({
      displayName: 'Synthetic speaker',
      guild: { id: 'guild-1', name: 'Synthetic guild' },
      id: 'user-1',
      nickname: undefined,
      user: { bot: false },
    })
    const channel = createMock<BaseGuildVoiceChannel>({
      guild: { id: 'guild-1' },
      id: 'voice-1',
      members: new Map([['user-1', member]]),
    })
    await manager.handleAudioReceiveStreamStart(channel)('user-1')
    const decoder = Reflect.get(manager, 'streams').get('guild-1:voice-1:0:user-1')
    const destroyDecoder = vi.spyOn(decoder, 'destroy')
    const destroyReceiveStream = vi.spyOn(receiveStream, 'destroy').mockImplementation(() => {
      throw new Error('synthetic receiver cleanup failure')
    })

    // ROOT CAUSE:
    //
    // Capture cleanup destroyed the Discord receiver before the Opus decoder.
    // A receiver exception therefore skipped decoder destruction even though
    // stop had already invalidated and removed the exact capture owner.
    /**
     * @example
     * await expect(manager.stop()).rejects.toThrow('synthetic receiver cleanup failure')
     */
    await expect(manager.stop()).rejects.toThrow('synthetic receiver cleanup failure')
    destroyReceiveStream.mockRestore()
    await new Promise<void>(resolve => setImmediate(resolve))
    /**
     * @example
     * expect(destroyDecoder).toHaveBeenCalledOnce()
     */
    expect(destroyDecoder).toHaveBeenCalledOnce()
    /**
     * @example
     * expect(activeMonitors.size).toBe(0)
     */
    expect(Reflect.get(manager, 'activeMonitors').size).toBe(0)
  })

  /**
   * @example
   * it('reproduces Discord audit D-016 by draining a join paused after voice connection before restart', async () => {})
   */
  it('reproduces Discord audit D-016 by draining a join paused after voice connection before restart', async () => {
    let releaseSelfDeaf = () => {}
    const selfDeafPending = new Promise<void>((resolve) => {
      releaseSelfDeaf = resolve
    })
    const connectionA = {
      destroy: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
      receiver: { speaking: { off: vi.fn(), on: vi.fn() } },
      state: { status: 'ready' },
    }
    const connectionB = {
      destroy: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
      receiver: { speaking: { off: vi.fn(), on: vi.fn() } },
      state: { status: 'ready' },
    }
    voiceMocks.joinVoiceChannel.mockReturnValueOnce(createMock<VoiceConnection>(connectionA)).mockReturnValueOnce(createMock<VoiceConnection>(connectionB))
    const manager = createManager()
    const interaction = createMock<ChatInputCommandInteraction>({ reply: vi.fn(async () => {}) })
    const channelA = createMock<BaseGuildVoiceChannel>({
      guild: {
        id: 'guild-1',
        members: {
          me: {
            permissions: { has: () => true },
            voice: {
              setDeaf: vi.fn(async () => selfDeafPending),
              setMute: vi.fn(async () => {}),
            },
          },
        },
        voiceAdapterCreator: {},
      },
      id: 'voice-a',
      name: 'Synthetic A',
    })
    const channelB = createMock<BaseGuildVoiceChannel>({
      guild: { id: 'guild-1', members: { me: undefined }, voiceAdapterCreator: {} },
      id: 'voice-b',
      name: 'Synthetic B',
    })
    const joinA = manager.joinChannel(interaction, channelA)
    await vi.waitFor(() => {
      /**
       * @example
       * expect(channelA.guild.members.me.voice.setDeaf).toHaveBeenCalledOnce()
       */
      expect(channelA.guild.members.me?.voice.setDeaf).toHaveBeenCalledOnce()
    })
    let stopSettled = false
    const stopTask = manager.stop().then(() => {
      stopSettled = true
    })
    const joinB = manager.joinChannel(interaction, channelB)
    await new Promise<void>(resolve => setImmediate(resolve))

    // ROOT CAUSE:
    //
    // stop() drained pending provider connects but not the owning join task.
    // A join paused in post-connect voice setup therefore outlived stop, while
    // a replacement generation could start before the old task had settled.
    /**
     * @example
     * expect(stopSettled).toBe(false)
     */
    expect(stopSettled).toBe(false)
    /**
     * @example
     * expect(voiceMocks.joinVoiceChannel).toHaveBeenCalledOnce()
     */
    expect(voiceMocks.joinVoiceChannel).toHaveBeenCalledOnce()

    releaseSelfDeaf()
    await joinA
    await stopTask
    await joinB
    /**
     * @example
     * expect(voiceMocks.joinVoiceChannel).toHaveBeenCalledTimes(2)
     */
    expect(voiceMocks.joinVoiceChannel).toHaveBeenCalledTimes(2)
    /**
     * @example
     * expect(connectionA.destroy).toHaveBeenCalledOnce()
     */
    expect(connectionA.destroy).toHaveBeenCalledOnce()
    await manager.stop()
    /**
     * @example
     * expect(pendingVoiceJoinTasks.size).toBe(0)
     */
    expect(Reflect.get(manager, 'pendingVoiceJoinTasks').size).toBe(0)
    /**
     * @example
     * expect(voiceJoinTaskByGuildId.size).toBe(0)
     */
    expect(Reflect.get(manager, 'voiceJoinTaskByGuildId').size).toBe(0)
  })

  /**
   * @example
   * it('fails closed at capacity for Discord audit D-007/D-015 without invalidating another channel', async () => {})
   */
  it('fails closed at capacity for Discord audit D-007/D-015 without invalidating another channel', async () => {
    const manager = createManager()
    const scopeA = { channelId: 'voice-a', generation: 1, guildId: 'guild-a' }
    const scopeB = { channelId: 'voice-b', generation: 2, guildId: 'guild-b' }
    const providerA = {
      abortInput: vi.fn(),
      appendAudio: vi.fn(() => true),
      cancelResponse: vi.fn(),
      close: vi.fn(),
      finishInput: vi.fn(),
    }
    const providerB = {
      abortInput: vi.fn(),
      appendAudio: vi.fn(() => true),
      cancelResponse: vi.fn(),
      close: vi.fn(),
      finishInput: vi.fn(),
    }
    const createConnection = () => ({
      destroy: vi.fn(),
      off: vi.fn(),
      receiver: { speaking: { off: vi.fn() } },
      state: { status: 'ready' },
    })
    const connectionA = createConnection()
    const channelA = createMock<BaseGuildVoiceChannel>({
      guild: { id: 'guild-a' },
      id: 'voice-a',
      members: new Map([
        ['user-a', { id: 'user-a', user: { bot: false } }],
        ['user-a2', { id: 'user-a2', user: { bot: false } }],
      ]),
      name: 'Synthetic A',
    })
    const consentSession = {
      channel: channelA,
      consentedUserIds: new Set(['user-a', 'user-a2']),
      id: 'consent-a',
      interaction: { editReply: vi.fn(async () => {}) },
      participantVoiceSessionIds: new Map([
        ['user-a', 'participant-session-a'],
        ['user-a2', 'participant-session-a2'],
      ]),
      state: 'active',
    }
    Reflect.get(manager, 'consentSessions').set('consent-a', consentSession)
    Reflect.get(manager, 'consentSessionIdByGuildId').set('guild-a', 'consent-a')
    Reflect.get(manager, 'activeVoiceSessionsByGuildId').set('guild-a', {
      abortController: new AbortController(),
      channel: channelA,
      connection: connectionA,
      consentSessionId: 'consent-a',
      pendingDiscordVoiceStateResetCount: 0,
      scope: scopeA,
    })
    Reflect.get(manager, 'realtimeSessions').set('guild-a:voice-a:1', {
      abortController: new AbortController(),
      committedInputItemIds: new Set(),
      committedInputTurnSequences: [],
      finishedInputTurnSequences: [],
      inputItemTurnSequences: new Map(),
      observedSpeechItemIds: new Set(),
      providerInputByTurn: new Map(),
      responseMetricsByTurn: new Map(),
      responseTurnSequences: new Map(),
      retiredInputItemIds: new Set(),
      retiredResponseIds: new Set(),
      provider: providerA,
      scope: scopeA,
      terminated: false,
    })
    Reflect.get(manager, 'realtimeSessions').set('guild-b:voice-b:2', {
      abortController: new AbortController(),
      committedInputItemIds: new Set(),
      committedInputTurnSequences: [],
      finishedInputTurnSequences: [],
      inputItemTurnSequences: new Map(),
      observedSpeechItemIds: new Set(),
      providerInputByTurn: new Map(),
      responseMetricsByTurn: new Map(),
      responseTurnSequences: new Map(),
      retiredInputItemIds: new Set(),
      retiredResponseIds: new Set(),
      provider: providerB,
      scope: scopeB,
      terminated: false,
    })
    const stopA = vi.fn()
    const stopA2 = vi.fn()
    const stopB = vi.fn()
    Reflect.get(manager, 'activeMonitors').set('guild-a:voice-a:1:user-a', {
      admitted: true,
      capture: { id: Symbol('capture-a') },
      finishing: false,
      scope: scopeA,
      stop: stopA,
      userId: 'user-a',
    })
    Reflect.get(manager, 'activeMonitors').set('guild-a:voice-a:1:user-a2', {
      admitted: true,
      capture: { id: Symbol('capture-a2') },
      finishing: false,
      scope: scopeA,
      stop: stopA2,
      userId: 'user-a2',
    })
    Reflect.get(manager, 'activeMonitors').set('guild-b:voice-b:2:user-b', {
      admitted: true,
      capture: { id: Symbol('capture-b') },
      finishing: false,
      scope: scopeB,
      stop: stopB,
      userId: 'user-b',
    })

    // ROOT CAUSE:
    //
    // Qwen owns one aggregate provider input per channel generation. Removing
    // only the withdrawn user's monitor cannot erase that user's already-sent
    // PCM from the provider buffer. The adapter's first handler cap also dropped
    // withdrawal before this cleanup ran. Capacity revocation must synchronously
    // fail closed for that exact channel generation while leaving other channels
    // live; the Discord response is only a later best-effort side effect.
    const applied = manager.abortConsentWithdrawalAtCapacity(createMock<ButtonInteraction>({
      customId: 'airi:voice-consent:withdraw:consent-a',
      guildId: 'guild-a',
      inCachedGuild: () => true,
      member: { voice: { channelId: 'voice-a' } },
      update: vi.fn(async () => {}),
      user: { id: 'user-a' },
    }))

    /**
     * @example
     * expect(applied).toBe(true)
     */
    expect(applied).toBe(true)

    /**
     * @example
     * expect(providerA.abortInput).toHaveBeenCalledOnce()
     */
    expect(providerA.abortInput).toHaveBeenCalledOnce()
    /**
     * @example
     * expect(providerA.cancelResponse).toHaveBeenCalledOnce()
     */
    expect(providerA.cancelResponse).toHaveBeenCalledOnce()
    /**
     * @example
     * expect(providerA.close).toHaveBeenCalledOnce()
     */
    expect(providerA.close).toHaveBeenCalledOnce()
    /**
     * @example
     * expect(stopA).toHaveBeenCalledOnce()
     */
    expect(stopA).toHaveBeenCalledOnce()
    /**
     * @example
     * expect(stopA2).toHaveBeenCalledOnce()
     */
    expect(stopA2).toHaveBeenCalledOnce()
    /**
     * @example
     * expect(consentSession.state).toBe('pending')
     */
    expect(consentSession.state).toBe('pending')
    /**
     * @example
     * expect(providerB.close).not.toHaveBeenCalled()
     */
    expect(providerB.close).not.toHaveBeenCalled()
    /**
     * @example
     * expect(stopB).not.toHaveBeenCalled()
     */
    expect(stopB).not.toHaveBeenCalled()
    /**
     * @example
     * expect(realtimeSessions.has(scopeBKey)).toBe(true)
     */
    expect(Reflect.get(manager, 'realtimeSessions').has('guild-b:voice-b:2')).toBe(true)
    await manager.stop()
    /**
     * @example
     * expect(providerB.close).toHaveBeenCalledOnce()
     */
    expect(providerB.close).toHaveBeenCalledOnce()
  })

  /**
   * @example
   * it('revokes an uncached participant through normal and capacity paths for Discord audit D-007/D-013', async () => {})
   */
  it('revokes an uncached participant through normal and capacity paths for Discord audit D-007/D-013', async () => {
    const manager = createManager()
    const channel = createMock<BaseGuildVoiceChannel>({
      guild: { id: 'guild-a' },
      id: 'voice-a',
      members: new Map(),
      name: 'Synthetic A',
    })
    const consentSession = {
      channel,
      consentedUserIds: new Set(['user-a']),
      id: 'consent-a',
      interaction: { editReply: vi.fn(async () => {}) },
      participantVoiceSessionIds: new Map([['user-a', 'participant-session-a']]),
      state: 'active',
    }
    Reflect.get(manager, 'consentSessions').set('consent-a', consentSession)

    // ROOT CAUSE:
    //
    // Capacity withdrawal repeated the normal opt-in path's live GuildMember
    // cache check. A participant who had already consented could click withdraw
    // after their member cache entry disappeared, but the full interaction pool
    // then dropped the request and left capture/provider state authorized.
    const applied = manager.abortConsentWithdrawalAtCapacity(createMock<ButtonInteraction>({
      customId: 'airi:voice-consent:withdraw:consent-a',
      guildId: 'guild-a',
      inCachedGuild: () => false,
      user: { id: 'user-a' },
    }))

    /** @example expect(applied).toBe(true) */
    expect(applied).toBe(true)
    /** @example expect(consentSession.consentedUserIds.has('user-a')).toBe(false) */
    expect(consentSession.consentedUserIds.has('user-a')).toBe(false)
    /** @example expect(consentSession.state).toBe('pending') */
    expect(consentSession.state).toBe('pending')

    consentSession.consentedUserIds.add('user-a')
    consentSession.state = 'active'
    const reply = vi.fn(async () => {})
    const update = vi.fn(async () => {})
    await manager.handleConsentInteraction(createMock<ButtonInteraction>({
      customId: 'airi:voice-consent:withdraw:consent-a',
      guildId: 'guild-a',
      inCachedGuild: () => false,
      reply,
      update,
      user: { id: 'user-a' },
    }))

    /** @example expect(reply).not.toHaveBeenCalled() */
    expect(reply).not.toHaveBeenCalled()
    /** @example expect(update).toHaveBeenCalledOnce() */
    expect(update).toHaveBeenCalledOnce()
    /** @example expect(consentSession.consentedUserIds.has('user-a')).toBe(false) */
    expect(consentSession.consentedUserIds.has('user-a')).toBe(false)
    /** @example expect(consentSession.state).toBe('pending') */
    expect(consentSession.state).toBe('pending')
  })

  /**
   * @example
   * it('aborts only the moved participant generation at VoiceState capacity for Discord audit D-013/D-015', async () => {})
   */
  it('aborts only the moved participant generation at VoiceState capacity for Discord audit D-013/D-015', async () => {
    const manager = createManager()
    const scopeA = { channelId: 'voice-a', generation: 1, guildId: 'guild-a' }
    const scopeB = { channelId: 'voice-b', generation: 2, guildId: 'guild-b' }
    const connectionA = {
      destroy: vi.fn(),
      state: { status: 'ready' },
    }
    const connectionB = {
      destroy: vi.fn(),
      state: { status: 'ready' },
    }
    const channelA = createMock<BaseGuildVoiceChannel>({
      guild: { id: 'guild-a' },
      id: 'voice-a',
      members: new Map(),
      name: 'Synthetic A',
    })
    const channelB = createMock<BaseGuildVoiceChannel>({
      guild: { id: 'guild-b' },
      id: 'voice-b',
      members: new Map(),
      name: 'Synthetic B',
    })
    const consentA = {
      channel: channelA,
      consentedUserIds: new Set(['user-a']),
      id: 'consent-a',
      interaction: { editReply: vi.fn(async () => {}) },
      participantVoiceSessionIds: new Map([['user-a', 'participant-session-a2']]),
      state: 'active',
    }
    Reflect.get(manager, 'consentSessions').set('consent-a', consentA)
    Reflect.get(manager, 'consentSessionIdByGuildId').set('guild-a', 'consent-a')
    Reflect.get(manager, 'activeVoiceSessionsByGuildId').set('guild-a', {
      abortController: new AbortController(),
      channel: channelA,
      connection: connectionA,
      consentSessionId: 'consent-a',
      pendingDiscordVoiceStateResetCount: 0,
      scope: scopeA,
    })
    Reflect.get(manager, 'activeVoiceSessionsByGuildId').set('guild-b', {
      abortController: new AbortController(),
      channel: channelB,
      connection: connectionB,
      pendingDiscordVoiceStateResetCount: 0,
      scope: scopeB,
    })
    Reflect.get(manager, 'activeMonitors').set('guild-a:voice-a:1:user-a', {
      admitted: true,
      capture: { id: Symbol('capture-a2') },
      discordVoiceSessionId: 'participant-session-a2',
      finishing: false,
      scope: scopeA,
      stop: vi.fn(),
      userId: 'user-a',
    })

    // ROOT CAUSE:
    //
    // A full shared interaction Set dropped the 65th VoiceStateUpdate. A move or
    // leave could therefore keep consent, receiver capture, and provider state
    // alive. Capacity overflow now chooses explicit, observable fail-closed
    // generation invalidation instead of silently skipping lifecycle cleanup.
    const staleApplied = manager.abortVoiceStateUpdateAtCapacity(
      createMock<VoiceState>({ channelId: 'voice-a', guild: { id: 'guild-a' }, id: 'user-a', sessionId: 'participant-session-a1' }),
      createMock<VoiceState>({ channelId: null, guild: { id: 'guild-a' }, id: 'user-a', sessionId: null }),
    )

    /** @example expect(staleApplied).toBe(false) */
    expect(staleApplied).toBe(false)
    /** @example expect(connectionA.destroy).not.toHaveBeenCalled() */
    expect(connectionA.destroy).not.toHaveBeenCalled()
    /** @example expect(consentA.consentedUserIds.has('user-a')).toBe(true) */
    expect(consentA.consentedUserIds.has('user-a')).toBe(true)

    const partialStaleApplied = manager.abortVoiceStateUpdateAtCapacity(
      createMock<VoiceState>({
        channelId: 'voice-a',
        guild: {
          id: 'guild-a',
          voiceStates: {
            cache: new Map([
              ['user-a', { channelId: 'voice-a', sessionId: 'participant-session-a2' }],
            ]),
          },
        },
        id: 'user-a',
        sessionId: null,
      }),
      createMock<VoiceState>({ channelId: null, guild: { id: 'guild-a' }, id: 'user-a', sessionId: null }),
    )

    // ROOT CAUSE:
    //
    // A partial stale callback with no old session id bypassed the monitor and
    // guild-cache identity checks. Even though the cache proved A2 was still in
    // the channel, the overflow path revoked A2 and destroyed its generation.
    /** @example expect(partialStaleApplied).toBe(false) */
    expect(partialStaleApplied).toBe(false)
    /** @example expect(connectionA.destroy).not.toHaveBeenCalled() */
    expect(connectionA.destroy).not.toHaveBeenCalled()
    /** @example expect(consentA.consentedUserIds.has('user-a')).toBe(true) */
    expect(consentA.consentedUserIds.has('user-a')).toBe(true)

    const applied = manager.abortVoiceStateUpdateAtCapacity(
      createMock<VoiceState>({ channelId: 'voice-a', guild: { id: 'guild-a' }, id: 'user-a', sessionId: 'participant-session-a2' }),
      createMock<VoiceState>({ channelId: 'voice-replacement', guild: { id: 'guild-a' }, id: 'user-a', sessionId: 'participant-session-a3' }),
    )

    /** @example expect(applied).toBe(true) */
    expect(applied).toBe(true)
    /** @example expect(consentA.consentedUserIds.has('user-a')).toBe(false) */
    expect(consentA.consentedUserIds.has('user-a')).toBe(false)
    /** @example expect(consentA.state).toBe('pending') */
    expect(consentA.state).toBe('pending')
    /** @example expect(connectionA.destroy).toHaveBeenCalledOnce() */
    expect(connectionA.destroy).toHaveBeenCalledOnce()
    /** @example expect(connectionB.destroy).not.toHaveBeenCalled() */
    expect(connectionB.destroy).not.toHaveBeenCalled()
    /** @example expect(Reflect.get(manager, 'activeVoiceSessionsByGuildId').has('guild-a')).toBe(false) */
    expect(Reflect.get(manager, 'activeVoiceSessionsByGuildId').has('guild-a')).toBe(false)
    /** @example expect(Reflect.get(manager, 'activeVoiceSessionsByGuildId').has('guild-b')).toBe(true) */
    expect(Reflect.get(manager, 'activeVoiceSessionsByGuildId').has('guild-b')).toBe(true)
    await manager.stop()
    /** @example expect(connectionB.destroy).toHaveBeenCalledOnce() */
    expect(connectionB.destroy).toHaveBeenCalledOnce()
  })

  /**
   * @example
   * it('revokes participant consent on a same-channel voice identity replacement for Discord audit D-007/D-013', async () => {})
   */
  it('revokes participant consent on a same-channel voice identity replacement for Discord audit D-007/D-013', async () => {
    const manager = createManager()
    const connection = {
      destroy: vi.fn(),
      state: { status: 'ready' },
    }
    const voiceStates = {
      cache: new Map([
        ['user-a', { channelId: 'voice-a', sessionId: 'participant-session-a2' }],
      ]),
    }
    const channel = createMock<BaseGuildVoiceChannel>({
      guild: { id: 'guild-a', voiceStates },
      id: 'voice-a',
      members: new Map(),
      name: 'Synthetic A',
    })
    const consentSession = {
      channel,
      consentedUserIds: new Set(['user-a']),
      id: 'consent-a',
      interaction: { editReply: vi.fn(async () => {}) },
      participantVoiceSessionIds: new Map([['user-a', 'participant-session-a1']]),
      state: 'active',
    }
    const scope = { channelId: 'voice-a', generation: 1, guildId: 'guild-a' }
    Reflect.get(manager, 'consentSessions').set('consent-a', consentSession)
    Reflect.get(manager, 'consentSessionIdByGuildId').set('guild-a', 'consent-a')
    Reflect.get(manager, 'activeVoiceSessionsByGuildId').set('guild-a', {
      abortController: new AbortController(),
      channel,
      connection,
      consentSessionId: 'consent-a',
      pendingDiscordVoiceStateResetCount: 0,
      scope,
    })
    Reflect.get(manager, 'activeMonitors').set('guild-a:voice-a:1:user-a', {
      admitted: true,
      capture: { id: Symbol('capture-a1') },
      discordVoiceSessionId: 'participant-session-a1',
      finishing: false,
      scope,
      stop: vi.fn(),
      userId: 'user-a',
    })
    const oldState = createMock<VoiceState>({
      channelId: 'voice-a',
      guild: { id: 'guild-a', voiceStates },
      id: 'user-a',
      sessionId: 'participant-session-a1',
    })
    const newState = createMock<VoiceState>({
      channelId: 'voice-a',
      guild: { id: 'guild-a', voiceStates },
      id: 'user-a',
      sessionId: 'participant-session-a2',
    })

    // ROOT CAUSE:
    //
    // Participant handling returned on equal channel ids before comparing the
    // immutable Discord voice session. A1 capture and consent therefore survived
    // an A1 -> A2 rejoin and could consume A2 audio without a fresh opt-in.
    await manager.handleVoiceStateUpdate(oldState, newState)

    /** @example expect(consentSession.consentedUserIds.has('user-a')).toBe(false) */
    expect(consentSession.consentedUserIds.has('user-a')).toBe(false)
    /** @example expect(consentSession.state).toBe('pending') */
    expect(consentSession.state).toBe('pending')
    /** @example expect(connection.destroy).toHaveBeenCalledOnce() */
    expect(connection.destroy).toHaveBeenCalledOnce()
    /** @example expect(Reflect.get(manager, 'activeVoiceSessionsByGuildId').has('guild-a')).toBe(false) */
    expect(Reflect.get(manager, 'activeVoiceSessionsByGuildId').has('guild-a')).toBe(false)
    await manager.stop()
  })

  /**
   * @example
   * it('rejects a replacement speaker before receiver subscription for Discord audit D-007/D-013', async () => {})
   */
  it('rejects a replacement speaker before receiver subscription for Discord audit D-007/D-013', async () => {
    const receiveStream = new PassThrough()
    const subscribe = vi.fn(() => receiveStream)
    const connection = createMock<VoiceConnection>({
      destroy: vi.fn(),
      off: vi.fn(),
      receiver: {
        speaking: { off: vi.fn() },
        subscribe,
      },
      state: { status: 'ready' },
    })
    const voiceStates = {
      cache: new Map([
        ['user-a', { channelId: 'voice-a', sessionId: 'participant-session-a2' }],
      ]),
    }
    const guild = { id: 'guild-a', name: 'Synthetic guild', voiceStates }
    const member = createMock<GuildMember>({
      displayName: 'Synthetic A',
      guild,
      id: 'user-a',
      nickname: undefined,
      user: { bot: false },
      voice: { sessionId: 'participant-session-a2' },
    })
    const channel = createMock<BaseGuildVoiceChannel>({
      guild,
      id: 'voice-a',
      members: new Map([['user-a', member]]),
      name: 'Synthetic voice',
    })
    const scope = { channelId: 'voice-a', generation: 1, guildId: 'guild-a' }
    const runtime = {
      connect: vi.fn(),
      getInterruptionRmsThreshold: () => 0.04,
      getMode: () => 'qwen-realtime' as const,
      isConfigured: () => true,
    }
    const admitSpeaker = vi.fn(() => true)
    const manager = new VoiceManager(
      createMock<DiscordClient>({ user: { id: 'bot-user' } }),
      async () => undefined,
      async () => '',
      runtime,
      {
        admit: admitSpeaker,
        allows: () => true,
      },
    )
    const consentSession = {
      channel,
      consentedUserIds: new Set(['user-a']),
      id: 'consent-a',
      interaction: { editReply: vi.fn(async () => {}) },
      participantVoiceSessionIds: new Map([['user-a', 'participant-session-a1']]),
      state: 'active',
    }
    Reflect.get(manager, 'consentSessions').set('consent-a', consentSession)
    Reflect.get(manager, 'consentSessionIdByGuildId').set('guild-a', 'consent-a')
    Reflect.get(manager, 'activeVoiceSessionsByGuildId').set('guild-a', {
      abortController: new AbortController(),
      channel,
      connection,
      consentSessionId: 'consent-a',
      pendingDiscordVoiceStateResetCount: 0,
      scope,
    })
    Reflect.get(manager, 'realtimeSessions').set('guild-a:voice-a:1', {
      abortController: new AbortController(),
      committedInputItemIds: new Set(),
      committedInputTurnSequences: [],
      finishedInputTurnSequences: [],
      inputItemTurnSequences: new Map(),
      observedSpeechItemIds: new Set(),
      providerInputByTurn: new Map(),
      responseMetricsByTurn: new Map(),
      responseTurnSequences: new Map(),
      retiredInputItemIds: new Set(),
      retiredResponseIds: new Set(),
      provider: {
        abortInput: vi.fn(),
        appendAudio: vi.fn(() => true),
        cancelResponse: vi.fn(),
        close: vi.fn(),
        finishInput: vi.fn(),
      },
      scope,
      terminated: false,
    })

    // ROOT CAUSE:
    //
    // Speaking-start checked only the stable user id in consentedUserIds. A1
    // could disconnect and rejoin as A2, reach receiver subscription before the
    // A1 -> A2 VoiceState cleanup, then monitorMember overwrote the immutable A1
    // consent owner with A2. The delayed cleanup was consequently classified as
    // stale and A2 audio reached the provider without a fresh public opt-in.
    const start = manager.handleAudioReceiveStreamStart(channel, scope)
    await start('user-a')

    /** @example expect(subscribe).not.toHaveBeenCalled() */
    expect(subscribe).not.toHaveBeenCalled()
    /** @example expect(admitSpeaker).not.toHaveBeenCalled() */
    expect(admitSpeaker).not.toHaveBeenCalled()
    /** @example expect(consentSession.participantVoiceSessionIds.get('user-a')).toBe('participant-session-a1') */
    expect(consentSession.participantVoiceSessionIds.get('user-a')).toBe('participant-session-a1')
    /** @example expect(Reflect.get(manager, 'activeMonitors').size).toBe(0) */
    expect(Reflect.get(manager, 'activeMonitors').size).toBe(0)

    Reflect.set(member, 'voice', { sessionId: 'participant-session-a1' })
    await start('user-a')

    /** @example expect(subscribe).toHaveBeenCalledOnce() */
    expect(subscribe).toHaveBeenCalledOnce()
    /** @example expect(admitSpeaker).toHaveBeenCalledOnce() */
    expect(admitSpeaker).toHaveBeenCalledOnce()
    /** @example expect(consentSession.participantVoiceSessionIds.get('user-a')).toBe('participant-session-a1') */
    expect(consentSession.participantVoiceSessionIds.get('user-a')).toBe('participant-session-a1')

    manager.revalidateSpeakerAdmissions()

    /** @example expect(Reflect.get(manager, 'activeMonitors').size).toBe(1) */
    expect(Reflect.get(manager, 'activeMonitors').size).toBe(1)

    const capacityCleanupApplied = manager.abortVoiceStateUpdateAtCapacity(
      createMock<VoiceState>({ channelId: 'voice-a', guild, id: 'user-a', sessionId: 'participant-session-a1' }),
      createMock<VoiceState>({ channelId: 'voice-a', guild, id: 'user-a', sessionId: 'participant-session-a2' }),
    )

    /** @example expect(capacityCleanupApplied).toBe(true) */
    expect(capacityCleanupApplied).toBe(true)
    /** @example expect(consentSession.consentedUserIds.has('user-a')).toBe(false) */
    expect(consentSession.consentedUserIds.has('user-a')).toBe(false)
    /** @example expect(consentSession.state).toBe('pending') */
    expect(consentSession.state).toBe('pending')
    await manager.stop()
  })

  /**
   * @example
   * it('rejects a stale participant replacement when a newer monitor owns the channel for Discord audit D-013', async () => {})
   */
  it('rejects a stale participant replacement when a newer monitor owns the channel for Discord audit D-013', async () => {
    const manager = createManager()
    const channel = createMock<BaseGuildVoiceChannel>({
      guild: { id: 'guild-a' },
      id: 'voice-a',
      members: new Map(),
      name: 'Synthetic A',
    })
    const consentSession = {
      channel,
      consentedUserIds: new Set(['user-a']),
      id: 'consent-a',
      interaction: { editReply: vi.fn(async () => {}) },
      participantVoiceSessionIds: new Map([['user-a', 'participant-session-a3']]),
      state: 'active',
    }
    const stopA3 = vi.fn()
    const scopeA3 = { channelId: 'voice-a', generation: 3, guildId: 'guild-a' }
    Reflect.get(manager, 'consentSessions').set('consent-a', consentSession)
    Reflect.get(manager, 'consentSessionIdByGuildId').set('guild-a', 'consent-a')
    Reflect.get(manager, 'activeMonitors').set('guild-a:voice-a:3:user-a', {
      admitted: true,
      capture: { id: Symbol('capture-a3') },
      discordVoiceSessionId: 'participant-session-a3',
      finishing: false,
      scope: scopeA3,
      stop: stopA3,
      userId: 'user-a',
    })

    // ROOT CAUSE:
    //
    // When the guild cache was temporarily absent, a delayed A1 -> A2 callback
    // was accepted without comparing the A3 monitor's immutable session owner.
    // That stale callback revoked consent and destroyed the newer capture.
    const applied = manager.abortVoiceStateUpdateAtCapacity(
      createMock<VoiceState>({
        channelId: 'voice-a',
        guild: { id: 'guild-a' },
        id: 'user-a',
        sessionId: 'participant-session-a1',
      }),
      createMock<VoiceState>({
        channelId: 'voice-a',
        guild: { id: 'guild-a' },
        id: 'user-a',
        sessionId: 'participant-session-a2',
      }),
    )

    /** @example expect(applied).toBe(false) */
    expect(applied).toBe(false)
    /** @example expect(consentSession.consentedUserIds.has('user-a')).toBe(true) */
    expect(consentSession.consentedUserIds.has('user-a')).toBe(true)
    /** @example expect(stopA3).not.toHaveBeenCalled() */
    expect(stopA3).not.toHaveBeenCalled()
    await manager.stop()
  })

  /**
   * @example
   * it('rejects a replayed participant replacement after re-consent for Discord audit D-007/D-013', async () => {})
   */
  it('rejects a replayed participant replacement after re-consent for Discord audit D-007/D-013', async () => {
    const manager = createManager()
    const voiceStates = {
      cache: new Map([
        ['user-a', { channelId: 'voice-a', sessionId: 'participant-session-a2' }],
      ]),
    }
    const guild = { id: 'guild-a', voiceStates }
    const channel = createMock<BaseGuildVoiceChannel>({
      guild,
      id: 'voice-a',
      members: new Map(),
      name: 'Synthetic A',
    })
    const stopA2 = vi.fn()
    const connectionA2 = {
      destroy: vi.fn(),
      receiver: { speaking: { off: vi.fn() } },
      state: { status: 'ready' },
    }
    const scopeA2 = { channelId: 'voice-a', generation: 2, guildId: 'guild-a' }
    const consentSession = {
      channel,
      consentedUserIds: new Set(['user-a']),
      id: 'consent-a',
      interaction: { editReply: vi.fn(async () => {}) },
      participantVoiceSessionIds: new Map([['user-a', 'participant-session-a2']]),
      state: 'active',
    }
    Reflect.get(manager, 'consentSessions').set('consent-a', consentSession)
    Reflect.get(manager, 'consentSessionIdByGuildId').set('guild-a', 'consent-a')
    Reflect.get(manager, 'activeVoiceSessionsByGuildId').set('guild-a', {
      abortController: new AbortController(),
      channel,
      connection: connectionA2,
      consentSessionId: 'consent-a',
      pendingDiscordVoiceStateResetCount: 0,
      scope: scopeA2,
    })
    Reflect.get(manager, 'activeMonitors').set('guild-a:voice-a:2:user-a', {
      admitted: true,
      capture: { id: Symbol('capture-a2') },
      discordVoiceSessionId: 'participant-session-a2',
      finishing: false,
      scope: scopeA2,
      stop: stopA2,
      userId: 'user-a',
    })
    const oldState = createMock<VoiceState>({
      channelId: 'voice-a',
      guild,
      id: 'user-a',
      sessionId: 'participant-session-a1',
    })
    const newState = createMock<VoiceState>({
      channelId: 'voice-a',
      guild,
      id: 'user-a',
      sessionId: 'participant-session-a2',
    })

    // ROOT CAUSE:
    //
    // The guild cache and current monitor both identify the callback's new A2
    // session after re-consent. Treating `cache === newState` as proof that an
    // A1 -> A2 transition was new let a replay revoke the replacement capture.
    // Consent now retains the immutable participant session admitted at opt-in,
    // so only a transition whose old identity owns consent may invalidate it.
    await manager.handleVoiceStateUpdate(oldState, newState)

    /** @example expect(consentSession.consentedUserIds.has('user-a')).toBe(true) */
    expect(consentSession.consentedUserIds.has('user-a')).toBe(true)
    /** @example expect(stopA2).not.toHaveBeenCalled() */
    expect(stopA2).not.toHaveBeenCalled()
    /** @example expect(connectionA2.destroy).not.toHaveBeenCalled() */
    expect(connectionA2.destroy).not.toHaveBeenCalled()

    const capacityCleanupApplied = manager.abortVoiceStateUpdateAtCapacity(oldState, newState)

    /** @example expect(capacityCleanupApplied).toBe(false) */
    expect(capacityCleanupApplied).toBe(false)
    /** @example expect(consentSession.consentedUserIds.has('user-a')).toBe(true) */
    expect(consentSession.consentedUserIds.has('user-a')).toBe(true)
    /** @example expect(consentSession.participantVoiceSessionIds.get('user-a')).toBe('participant-session-a2') */
    expect(consentSession.participantVoiceSessionIds.get('user-a')).toBe('participant-session-a2')
    /** @example expect(stopA2).not.toHaveBeenCalled() */
    expect(stopA2).not.toHaveBeenCalled()
    /** @example expect(connectionA2.destroy).not.toHaveBeenCalled() */
    expect(connectionA2.destroy).not.toHaveBeenCalled()
    await manager.stop()
  })

  /**
   * @example
   * it('drains exact dismiss cleanup at capacity for Discord audit D-013/D-016', async () => {})
   */
  it('drains exact dismiss cleanup at capacity for Discord audit D-013/D-016', async () => {
    const manager = createManager()
    const cleanupFailure = new Error('synthetic exact-guild disconnect failure')
    const connectionA = {
      destroy: vi.fn(() => {
        throw cleanupFailure
      }),
      state: { status: 'ready' },
    }
    const connectionB = {
      destroy: vi.fn(),
      state: { status: 'ready' },
    }
    const channelA = createMock<BaseGuildVoiceChannel>({ guild: { id: 'guild-a' }, id: 'voice-a' })
    const channelB = createMock<BaseGuildVoiceChannel>({ guild: { id: 'guild-b' }, id: 'voice-b' })
    const scopeA = { channelId: 'voice-a', generation: 1, guildId: 'guild-a' }
    const scopeB = { channelId: 'voice-b', generation: 2, guildId: 'guild-b' }
    Reflect.get(manager, 'activeVoiceSessionsByGuildId').set('guild-a', {
      abortController: new AbortController(),
      channel: channelA,
      connection: connectionA,
      pendingDiscordVoiceStateResetCount: 0,
      scope: scopeA,
    })
    Reflect.get(manager, 'activeVoiceSessionsByGuildId').set('guild-b', {
      abortController: new AbortController(),
      channel: channelB,
      connection: connectionB,
      pendingDiscordVoiceStateResetCount: 0,
      scope: scopeB,
    })
    const closeProviderA = vi.fn()
    Reflect.get(manager, 'realtimeSessions').set('guild-a:voice-a:1', {
      abortController: new AbortController(),
      committedInputItemIds: new Set(),
      committedInputTurnSequences: [],
      finishedInputTurnSequences: [],
      inputItemTurnSequences: new Map(),
      observedSpeechItemIds: new Set(),
      providerInputByTurn: new Map(),
      responseMetricsByTurn: new Map(),
      responseTurnSequences: new Map(),
      retiredInputItemIds: new Set(),
      retiredResponseIds: new Set(),
      provider: {
        appendAudio: vi.fn(() => true),
        cancelResponse: vi.fn(),
        close: closeProviderA,
        finishInput: vi.fn(),
      },
      scope: scopeA,
      terminated: false,
    })

    // ROOT CAUSE:
    //
    // Capacity-specific dismiss must use the same aggregated generation cleanup
    // as the normal lifecycle. A throwing connection destroy cannot leave the
    // target provider/session alive, hide the first error, or touch another guild.
    /** @example expect(() => manager.disconnectGuildVoiceAtCapacity('guild-a')).toThrow(cleanupFailure) */
    expect(() => manager.disconnectGuildVoiceAtCapacity('guild-a')).toThrow(cleanupFailure)
    /** @example expect(closeProviderA).toHaveBeenCalledOnce() */
    expect(closeProviderA).toHaveBeenCalledOnce()
    /** @example expect(Reflect.get(manager, 'activeVoiceSessionsByGuildId').has('guild-a')).toBe(false) */
    expect(Reflect.get(manager, 'activeVoiceSessionsByGuildId').has('guild-a')).toBe(false)
    /** @example expect(Reflect.get(manager, 'activeVoiceSessionsByGuildId').has('guild-b')).toBe(true) */
    expect(Reflect.get(manager, 'activeVoiceSessionsByGuildId').has('guild-b')).toBe(true)
    /** @example expect(connectionB.destroy).not.toHaveBeenCalled() */
    expect(connectionB.destroy).not.toHaveBeenCalled()
    await manager.stop()
    /** @example expect(connectionB.destroy).toHaveBeenCalledOnce() */
    expect(connectionB.destroy).toHaveBeenCalledOnce()
  })

  /**
   * @example
   * it('reproduces Discord audit D-016 by bounding active voice generations while allowing same-guild replacement', async () => {})
   */
  it('reproduces Discord audit D-016 by bounding active voice generations while allowing same-guild replacement', async () => {
    const manager = createManager()
    const activeSessions = Reflect.get(manager, 'activeVoiceSessionsByGuildId')
    const survivingAbortController = new AbortController()
    for (let index = 0; index < 64; index += 1) {
      const guildId = `synthetic-guild-${index}`
      activeSessions.set(guildId, {
        abortController: index === 1 ? survivingAbortController : new AbortController(),
        channel: { guild: { id: guildId }, id: `voice-${index}` },
        connection: {
          destroy: vi.fn(),
          off: vi.fn(),
          receiver: { speaking: { off: vi.fn() } },
          state: { status: 'ready' },
        },
        pendingDiscordVoiceStateResetCount: 0,
        scope: { channelId: `voice-${index}`, generation: index + 1, guildId },
      })
    }
    const createConnection = () => ({
      destroy: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
      receiver: { speaking: { off: vi.fn(), on: vi.fn() } },
      state: { status: 'ready' },
    })
    voiceMocks.joinVoiceChannel.mockReturnValue(createMock<VoiceConnection>(createConnection()))
    const overflowChannel = createMock<BaseGuildVoiceChannel>({
      guild: { id: 'overflow-guild', members: { me: undefined }, voiceAdapterCreator: {} },
      id: 'overflow-voice',
      name: 'Overflow voice',
    })
    const interaction = createMock<ChatInputCommandInteraction>({ reply: vi.fn(async () => {}) })

    // ROOT CAUSE:
    //
    // Pending join/connect tasks were capped, but each completed join left an
    // active session, listener set, connection, and optional provider socket in
    // maps without a process admission cap. Sequential guild joins could grow
    // those one-to-one derived owners without bound.
    /**
     * @example
     * await expect(manager.joinChannel(interaction, overflowChannel)).rejects.toThrow('capacity')
     */
    await expect(manager.joinChannel(interaction, overflowChannel)).rejects.toThrow('capacity')
    /**
     * @example
     * expect(voiceMocks.joinVoiceChannel).not.toHaveBeenCalled()
     */
    expect(voiceMocks.joinVoiceChannel).not.toHaveBeenCalled()
    /**
     * @example
     * expect(survivingAbortController.signal.aborted).toBe(false)
     */
    expect(survivingAbortController.signal.aborted).toBe(false)

    const replacementConnection = createConnection()
    voiceMocks.joinVoiceChannel.mockReturnValue(createMock<VoiceConnection>(replacementConnection))
    const replacementChannel = createMock<BaseGuildVoiceChannel>({
      guild: { id: 'synthetic-guild-0', members: { me: undefined }, voiceAdapterCreator: {} },
      id: 'replacement-voice',
      name: 'Replacement voice',
    })
    await manager.joinChannel(interaction, replacementChannel)
    /**
     * @example
     * expect(voiceMocks.joinVoiceChannel).toHaveBeenCalledOnce()
     */
    expect(voiceMocks.joinVoiceChannel).toHaveBeenCalledOnce()
    /**
     * @example
     * expect(activeSessions.size).toBe(64)
     */
    expect(activeSessions.size).toBe(64)
    /**
     * @example
     * expect(survivingAbortController.signal.aborted).toBe(false)
     */
    expect(survivingAbortController.signal.aborted).toBe(false)

    for (const guildId of Array.from(activeSessions.keys())) {
      if (guildId !== 'synthetic-guild-0')
        activeSessions.delete(guildId)
    }
    await manager.stop()
    /**
     * @example
     * expect(activeSessions.size).toBe(0)
     */
    expect(activeSessions.size).toBe(0)
  })

  /**
   * @example
   * it('reproduces Discord audit D-016 by bounding pending consent owners and freeing capacity on cleanup', async () => {})
   */
  it('reproduces Discord audit D-016 by bounding pending consent owners and freeing capacity on cleanup', async () => {
    const manager = createManager()
    const consentSessions = Reflect.get(manager, 'consentSessions')
    const consentSessionIdByGuildId = Reflect.get(manager, 'consentSessionIdByGuildId')
    for (let index = 0; index < 64; index += 1) {
      const guildId = `synthetic-guild-${index}`
      const sessionId = `synthetic-consent-${index}`
      consentSessions.set(sessionId, {
        channel: { guild: { id: guildId }, id: `voice-${index}` },
        consentedUserIds: new Set(),
        id: sessionId,
        interaction: { editReply: vi.fn(async () => {}) },
        participantVoiceSessionIds: new Map(),
        state: 'pending',
      })
      consentSessionIdByGuildId.set(guildId, sessionId)
    }
    const channel = createMock<BaseGuildVoiceChannel>({
      guild: { id: 'new-guild' },
      id: 'new-voice',
      members: new Map(),
      name: 'New voice',
    })
    const reply = vi.fn(async () => {})
    const interaction = createMock<ChatInputCommandInteraction>({
      id: 'new-interaction',
      inCachedGuild: () => true,
      member: { voice: { channel } },
      reply,
    })

    // ROOT CAUSE:
    //
    // Every `/summon` in a new guild allocated a pending consent session before
    // provider admission. Guilds that never completed consent could retain these
    // owners indefinitely and bypass the pending connection cap.
    await manager.handleJoinChannelCommand(interaction)
    /**
     * @example
     * expect(reply).toHaveBeenCalledWith('Discord voice capacity is temporarily exhausted. Try again later.')
     */
    expect(reply).toHaveBeenCalledWith('Discord voice capacity is temporarily exhausted. Try again later.')
    /**
     * @example
     * expect(consentSessions.size).toBe(64)
     */
    expect(consentSessions.size).toBe(64)
    /**
     * @example
     * expect(voiceMocks.joinVoiceChannel).not.toHaveBeenCalled()
     */
    expect(voiceMocks.joinVoiceChannel).not.toHaveBeenCalled()

    const replacementReply = vi.fn(async () => {})
    const replacementChannel = createMock<BaseGuildVoiceChannel>({
      guild: { id: 'synthetic-guild-1' },
      id: 'replacement-voice',
      members: new Map(),
      name: 'Replacement voice',
    })
    await manager.handleJoinChannelCommand(createMock<ChatInputCommandInteraction>({
      id: 'replacement-interaction',
      inCachedGuild: () => true,
      member: { voice: { channel: replacementChannel } },
      reply: replacementReply,
    }))
    /**
     * @example
     * expect(replacementReply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringMatching(/opt.?in/i) }))
     */
    expect(replacementReply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringMatching(/opt.?in/i) }))
    /**
     * @example
     * expect(consentSessions.size).toBe(64)
     */
    expect(consentSessions.size).toBe(64)
    /**
     * @example
     * expect(consentSessions.has('synthetic-consent-1')).toBe(false)
     */
    expect(consentSessions.has('synthetic-consent-1')).toBe(false)

    Reflect.apply(Reflect.get(manager, 'clearConsentSessionForGuild'), manager, ['synthetic-guild-0'])
    reply.mockClear()
    await manager.handleJoinChannelCommand(interaction)
    /**
     * @example
     * expect(reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringMatching(/opt.?in/i) }))
     */
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringMatching(/opt.?in/i) }))
    /**
     * @example
     * expect(consentSessions.size).toBe(64)
     */
    expect(consentSessions.size).toBe(64)
    await manager.stop()
  })

  /**
   * @example
   * it('reproduces Discord audit D-016 by bounding active monitors before rate or provider admission', async () => {})
   */
  it('reproduces Discord audit D-016 by bounding active monitors before rate or provider admission', async () => {
    const receiveStream = new PassThrough()
    const connection = {
      destroy: vi.fn(),
      joinConfig: { guildId: 'guild-new' },
      receiver: { subscribe: vi.fn(() => receiveStream) },
      state: { status: 'ready' },
    }
    voiceMocks.getVoiceConnections.mockReturnValue(createMock<Map<string, VoiceConnection>>(new Map([['guild-new', connection]])))
    const admit = vi.fn(() => true)
    const runtime = {
      connect: vi.fn(),
      getInterruptionRmsThreshold: () => 0.04,
      getMode: () => 'qwen-realtime' as const,
      isConfigured: () => true,
    }
    const manager = new VoiceManager(
      createMock<DiscordClient>({ user: { id: 'bot-user' } }),
      async () => undefined,
      async () => '',
      runtime,
      { admit, allows: () => true },
    )
    const activeMonitors = Reflect.get(manager, 'activeMonitors')
    for (let index = 0; index < 512; index += 1) {
      const scope = { channelId: `voice-${index}`, generation: index + 1, guildId: `guild-${index}` }
      activeMonitors.set(`guild-${index}:voice-${index}:${index + 1}:user-${index}`, {
        admitted: true,
        capture: { id: Symbol(`capture-${index}`) },
        finishing: false,
        scope,
        stop: vi.fn(),
        userId: `user-${index}`,
      })
    }
    const scope = { channelId: 'voice-new', generation: 0, guildId: 'guild-new' }
    Reflect.get(manager, 'realtimeSessions').set('guild-new:voice-new:0', {
      abortController: new AbortController(),
      committedInputItemIds: new Set(),
      committedInputTurnSequences: [],
      finishedInputTurnSequences: [],
      inputItemTurnSequences: new Map(),
      observedSpeechItemIds: new Set(),
      providerInputByTurn: new Map(),
      responseMetricsByTurn: new Map(),
      responseTurnSequences: new Map(),
      retiredInputItemIds: new Set(),
      retiredResponseIds: new Set(),
      provider: {
        abortInput: vi.fn(),
        appendAudio: vi.fn(() => true),
        cancelResponse: vi.fn(),
        close: vi.fn(),
        finishInput: vi.fn(),
      },
      scope,
      terminated: false,
    })
    const member = createMock<GuildMember>({
      displayName: 'Capacity speaker',
      guild: { id: 'guild-new', name: 'Synthetic guild' },
      id: 'user-new',
      nickname: undefined,
      user: { bot: false },
    })
    const channel = createMock<BaseGuildVoiceChannel>({
      guild: { id: 'guild-new' },
      id: 'voice-new',
      members: new Map([['user-new', member]]),
    })

    // ROOT CAUSE:
    //
    // Speaker rate admission bounded requests over time but did not bound the
    // live capture owners themselves. A high-cardinality set of simultaneous
    // speakers could allocate decoder, stream, timer, and controller state before
    // any previous capture released its slot.
    await manager.handleAudioReceiveStreamStart(channel)('user-new')
    /**
     * @example
     * expect(admit).not.toHaveBeenCalled()
     */
    expect(admit).not.toHaveBeenCalled()
    /**
     * @example
     * expect(connection.receiver.subscribe).not.toHaveBeenCalled()
     */
    expect(connection.receiver.subscribe).not.toHaveBeenCalled()
    /**
     * @example
     * expect(activeMonitors.size).toBe(512)
     */
    expect(activeMonitors.size).toBe(512)

    activeMonitors.delete('guild-0:voice-0:1:user-0')
    await manager.handleAudioReceiveStreamStart(channel)('user-new')
    /**
     * @example
     * expect(admit).toHaveBeenCalledOnce()
     */
    expect(admit).toHaveBeenCalledOnce()
    /**
     * @example
     * expect(connection.receiver.subscribe).toHaveBeenCalledOnce()
     */
    expect(connection.receiver.subscribe).toHaveBeenCalledOnce()
    /**
     * @example
     * expect(activeMonitors.size).toBe(512)
     */
    expect(activeMonitors.size).toBe(512)
    await manager.stop()
  })

  /**
   * @example
   * it('reproduces Discord audit D-016 by isolating the per-scope monitor cap from other channels', async () => {})
   */
  it('reproduces Discord audit D-016 by isolating the per-scope monitor cap from other channels', async () => {
    const receiveA = new PassThrough()
    const receiveB = new PassThrough()
    const connectionA = {
      destroy: vi.fn(),
      joinConfig: { guildId: 'guild-a' },
      receiver: { subscribe: vi.fn(() => receiveA) },
      state: { status: 'ready' },
    }
    const connectionB = {
      destroy: vi.fn(),
      joinConfig: { guildId: 'guild-b' },
      receiver: { subscribe: vi.fn(() => receiveB) },
      state: { status: 'ready' },
    }
    voiceMocks.getVoiceConnections.mockReturnValue(createMock<Map<string, VoiceConnection>>(new Map([
      ['guild-a', connectionA],
      ['guild-b', connectionB],
    ])))
    const admit = vi.fn(() => true)
    const runtime = {
      connect: vi.fn(),
      getInterruptionRmsThreshold: () => 0.04,
      getMode: () => 'qwen-realtime' as const,
      isConfigured: () => true,
    }
    const manager = new VoiceManager(
      createMock<DiscordClient>({ user: { id: 'bot-user' } }),
      async () => undefined,
      async () => '',
      runtime,
      { admit, allows: () => true },
    )
    const activeMonitors = Reflect.get(manager, 'activeMonitors')
    const scopeA = { channelId: 'voice-a', generation: 0, guildId: 'guild-a' }
    for (let index = 0; index < 32; index += 1) {
      activeMonitors.set(`guild-a:voice-a:0:user-${index}`, {
        admitted: true,
        capture: { id: Symbol(`capture-${index}`) },
        finishing: false,
        scope: scopeA,
        stop: vi.fn(),
        userId: `user-${index}`,
      })
    }
    const scopeB = { channelId: 'voice-b', generation: 0, guildId: 'guild-b' }
    Reflect.get(manager, 'realtimeSessions').set('guild-b:voice-b:0', {
      abortController: new AbortController(),
      committedInputItemIds: new Set(),
      committedInputTurnSequences: [],
      finishedInputTurnSequences: [],
      inputItemTurnSequences: new Map(),
      observedSpeechItemIds: new Set(),
      providerInputByTurn: new Map(),
      responseMetricsByTurn: new Map(),
      responseTurnSequences: new Map(),
      retiredInputItemIds: new Set(),
      retiredResponseIds: new Set(),
      provider: {
        abortInput: vi.fn(),
        appendAudio: vi.fn(() => true),
        cancelResponse: vi.fn(),
        close: vi.fn(),
        finishInput: vi.fn(),
      },
      scope: scopeB,
      terminated: false,
    })
    const memberA = createMock<GuildMember>({
      displayName: 'Scope A overflow speaker',
      guild: { id: 'guild-a', name: 'Synthetic A' },
      id: 'user-overflow',
      user: { bot: false },
    })
    const memberB = createMock<GuildMember>({
      displayName: 'Scope B speaker',
      guild: { id: 'guild-b', name: 'Synthetic B' },
      id: 'user-b',
      user: { bot: false },
    })
    const channelA = createMock<BaseGuildVoiceChannel>({
      guild: { id: 'guild-a' },
      id: 'voice-a',
      members: new Map([['user-overflow', memberA]]),
    })
    const channelB = createMock<BaseGuildVoiceChannel>({
      guild: { id: 'guild-b' },
      id: 'voice-b',
      members: new Map([['user-b', memberB]]),
    })

    // ROOT CAUSE:
    //
    // A process-only monitor cap prevents global exhaustion but lets one busy
    // channel consume every slot. The per-generation cap must reject before
    // rate/provider admission while leaving unrelated channel capacity usable.
    await manager.handleAudioReceiveStreamStart(channelA)('user-overflow')
    /**
     * @example
     * expect(connectionA.receiver.subscribe).not.toHaveBeenCalled()
     */
    expect(connectionA.receiver.subscribe).not.toHaveBeenCalled()
    /**
     * @example
     * expect(admit).not.toHaveBeenCalled()
     */
    expect(admit).not.toHaveBeenCalled()

    await manager.handleAudioReceiveStreamStart(channelB)('user-b')
    /**
     * @example
     * expect(connectionB.receiver.subscribe).toHaveBeenCalledOnce()
     */
    expect(connectionB.receiver.subscribe).toHaveBeenCalledOnce()
    /**
     * @example
     * expect(admit).toHaveBeenCalledOnce()
     */
    expect(admit).toHaveBeenCalledOnce()
    /**
     * @example
     * expect(activeMonitors.size).toBe(33)
     */
    expect(activeMonitors.size).toBe(33)
    await manager.stop()
  })

  /**
   * @example
   * it('reproduces Discord audit D-016 by aborting and draining a pending Qwen connect before stop completes', async () => {})
   */
  it('reproduces Discord audit D-016 by aborting and draining a pending Qwen connect before stop completes', async () => {
    let resolveConnect = (_provider: {
      appendAudio: (pcm: Buffer) => boolean
      cancelResponse: () => void
      close: () => void
      finishInput: () => void
    }) => {}
    const pendingConnect = new Promise<{
      appendAudio: (pcm: Buffer) => boolean
      cancelResponse: () => void
      close: () => void
      finishInput: () => void
    }>((resolve) => {
      resolveConnect = resolve
    })
    const runtime = {
      connect: vi.fn((_events: RealtimeVoiceCallSessionEvents, _options?: { signal: AbortSignal }) => pendingConnect),
      getInterruptionRmsThreshold: () => 0.04,
      getMode: () => 'qwen-realtime' as const,
      isConfigured: () => true,
    }
    const connection = {
      destroy: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
      receiver: {
        speaking: {
          off: vi.fn(),
          on: vi.fn(),
        },
      },
      state: { status: 'ready' },
    }
    voiceMocks.joinVoiceChannel.mockReturnValue(createMock<VoiceConnection>(connection))
    const manager = new VoiceManager(
      createMock<DiscordClient>({ user: { id: 'bot-user' } }),
      async () => undefined,
      async () => '',
      runtime,
    )
    const channel = createMock<BaseGuildVoiceChannel>({
      guild: {
        id: 'guild-1',
        members: { me: undefined },
        voiceAdapterCreator: {},
      },
      guildId: 'guild-1',
      id: 'voice-1',
      name: 'Synthetic voice',
    })
    const interaction = createMock<ChatInputCommandInteraction>({ reply: vi.fn(async () => {}) })
    const joinTask = manager.joinChannel(interaction, channel)
    const duplicateJoinTask = manager.joinChannel(interaction, channel)
    /**
     * @example
     * expect(duplicateJoinTask).toBe(joinTask)
     */
    expect(duplicateJoinTask).toBe(joinTask)
    await vi.waitFor(() => {
      /**
       * @example
       * expect(runtime.connect).toHaveBeenCalledOnce()
       */
      expect(runtime.connect).toHaveBeenCalledOnce()
    })

    // ROOT CAUSE:
    //
    // VoiceManager installed connection listeners before awaiting Qwen connect,
    // but registered their cleanup record only after connect resolved. stop()
    // therefore could neither abort/drain the pending provider task nor detach
    // those listeners. A late connect could outlive the stopped voice generation.
    const stopTask = manager.stop()
    const connectOptions = runtime.connect.mock.calls[0][1]

    /**
     * @example
     * expect(connectOptions?.signal.aborted).toBe(true)
     */
    expect(connectOptions?.signal.aborted).toBe(true)
    /**
     * @example
     * expect(connection.off).toHaveBeenCalledWith('stateChange', expect.any(Function))
     */
    expect(connection.off).toHaveBeenCalledWith('stateChange', expect.any(Function))
    /**
     * @example
     * expect(connection.off).toHaveBeenCalledWith('error', expect.any(Function))
     */
    expect(connection.off).toHaveBeenCalledWith('error', expect.any(Function))

    const lateProvider = {
      appendAudio: vi.fn(() => true),
      cancelResponse: vi.fn(),
      close: vi.fn(),
      finishInput: vi.fn(),
    }
    resolveConnect(lateProvider)
    await stopTask
    await joinTask

    /**
     * @example
     * expect(lateProvider.cancelResponse).toHaveBeenCalledOnce()
     */
    expect(lateProvider.cancelResponse).toHaveBeenCalledOnce()
    /**
     * @example
     * expect(lateProvider.close).toHaveBeenCalledOnce()
     */
    expect(lateProvider.close).toHaveBeenCalledOnce()
    /**
     * @example
     * expect(Reflect.get(manager, 'realtimeSessions').size).toBe(0)
     */
    expect(Reflect.get(manager, 'realtimeSessions').size).toBe(0)
    /**
     * @example
     * expect(Reflect.get(manager, 'connectionListeners').size).toBe(0)
     */
    expect(Reflect.get(manager, 'connectionListeners').size).toBe(0)
  })

  /**
   * @example
   * it('reproduces Discord audit D-016 by retaining connect and cleanup failures in lifecycle order', async () => {})
   */
  it('reproduces Discord audit D-016 by retaining connect and cleanup failures in lifecycle order', async () => {
    const connectFailure = new Error('synthetic provider connect failure')
    const cleanupFailure = new Error('synthetic Discord connection cleanup failure')
    const diagnostics: VoiceDiagnosticSignal[] = []
    const runtime = {
      connect: vi.fn(async () => {
        throw connectFailure
      }),
      getInterruptionRmsThreshold: () => 0.04,
      getMode: () => 'qwen-realtime' as const,
      isConfigured: () => true,
    }
    const connection = {
      destroy: vi.fn(() => {
        throw cleanupFailure
      }),
      off: vi.fn(),
      on: vi.fn(),
      receiver: { speaking: { off: vi.fn(), on: vi.fn() } },
      state: { status: 'ready' },
    }
    voiceMocks.joinVoiceChannel.mockReturnValue(createMock<VoiceConnection>(connection))
    const manager = new VoiceManager(
      createMock<DiscordClient>({ user: { id: 'bot-user' } }),
      async () => undefined,
      async () => '',
      runtime,
      undefined,
      undefined,
      undefined,
      { record: signal => diagnostics.push(signal), runtimeSequence: 91 },
    )
    const logger = {
      error: vi.fn(),
      log: vi.fn(),
      warn: vi.fn(),
      withError: vi.fn(),
      withField: vi.fn(),
      withFields: vi.fn(),
    }
    logger.withError.mockReturnValue(logger)
    logger.withField.mockReturnValue(logger)
    logger.withFields.mockReturnValue(logger)
    Reflect.set(manager, 'logger', logger)
    const channel = createMock<BaseGuildVoiceChannel>({
      guild: {
        id: 'guild-1',
        members: { me: undefined },
        voiceAdapterCreator: {},
      },
      guildId: 'guild-1',
      id: 'voice-1',
      name: 'Synthetic voice',
    })

    // ROOT CAUSE:
    //
    // establishVoiceSession caught the provider connect failure and then called
    // releaseVoiceSession outside an aggregation boundary. If cleanup threw,
    // that later error replaced the original failure even though both are needed
    // to diagnose the failed connect and prove exception-safe lifecycle teardown.
    // The same catch also passed the raw provider exception to structured logging,
    // which could serialize a request URL, response body, credential, or stack.
    // The fixed boundary propagates both errors but logs only a fixed lifecycle
    // category and anonymous session correlation.
    const joinTask = manager.joinChannel(
      createMock<ChatInputCommandInteraction>({ reply: vi.fn(async () => {}) }),
      channel,
    )
    /**
     * @example
     * await expect(joinTask).rejects.toEqual(expect.objectContaining({ errors: [connectFailure, cleanupFailure] }))
     */
    await expect(joinTask).rejects.toEqual(expect.objectContaining({
      errors: [connectFailure, cleanupFailure],
    }))
    /** @example expect(diagnostics.filter(signal => signal.stage === 'session-cleaned')).toEqual([expect.objectContaining({ cleanupReason: 'failed' })]) */
    expect(diagnostics.filter(signal => signal.stage === 'session-cleaned')).toEqual([
      expect.objectContaining({ cleanupReason: 'failed' }),
    ])
    /**
     * @example
     * expect(connection.off).toHaveBeenCalledWith('stateChange', expect.any(Function))
     */
    expect(connection.off).toHaveBeenCalledWith('stateChange', expect.any(Function))
    /**
     * @example
     * expect(connection.off).toHaveBeenCalledWith('error', expect.any(Function))
     */
    expect(connection.off).toHaveBeenCalledWith('error', expect.any(Function))
    /**
     * @example
     * expect(connection.receiver.speaking.off).toHaveBeenCalledWith('start', expect.any(Function))
     */
    expect(connection.receiver.speaking.off).toHaveBeenCalledWith('start', expect.any(Function))
    /**
     * @example
     * expect(connection.receiver.speaking.off).toHaveBeenCalledWith('end', expect.any(Function))
     */
    expect(connection.receiver.speaking.off).toHaveBeenCalledWith('end', expect.any(Function))
    /**
     * @example
     * expect(Reflect.get(manager, 'activeVoiceSessionsByGuildId').size).toBe(0)
     */
    expect(Reflect.get(manager, 'activeVoiceSessionsByGuildId').size).toBe(0)
    /**
     * @example
     * expect(Reflect.get(manager, 'realtimeSessions').size).toBe(0)
     */
    expect(Reflect.get(manager, 'realtimeSessions').size).toBe(0)
    /**
     * @example
     * expect(logger.withError).not.toHaveBeenCalled()
     */
    expect(logger.withError).not.toHaveBeenCalled()
    /**
     * @example
     * expect(logger.withFields).toHaveBeenCalledWith(expect.objectContaining({ eventCode: 'provider-connect-failed' }))
     */
    expect(logger.withFields).toHaveBeenCalledWith(expect.objectContaining({
      eventCode: 'provider-connect-failed',
      failureCategory: 'provider',
      mode: 'qwen-realtime',
      sessionSequence: 1,
      terminal: true,
    }))
    const serializedLogs = JSON.stringify(logger.withFields.mock.calls)
    /** @example expect(serializedLogs).not.toContain('guild-1') */
    expect(serializedLogs).not.toContain('guild-1')
    /** @example expect(serializedLogs).not.toContain('voice-1') */
    expect(serializedLogs).not.toContain('voice-1')
    /** @example expect(serializedLogs).not.toContain(connectFailure.message) */
    expect(serializedLogs).not.toContain(connectFailure.message)
    /** @example expect(serializedLogs).not.toContain(cleanupFailure.message) */
    expect(serializedLogs).not.toContain(cleanupFailure.message)
  })

  /**
   * @example
   * it('reproduces Discord audit D-016 by containing an installed voice state-change cleanup rejection', async () => {})
   */
  it('reproduces Discord audit D-016 by containing an installed voice state-change cleanup rejection', async () => {
    const cleanupFailure = new Error('synthetic installed state-change cleanup failure')
    let installedStateChange: ((oldState: { status: string }, newState: { status: string }) => Promise<void>) | undefined
    const connection = {
      destroy: vi.fn(() => {
        throw cleanupFailure
      }),
      off: vi.fn(),
      on: vi.fn((event: string, listener: (oldState: { status: string }, newState: { status: string }) => Promise<void>) => {
        if (event === 'stateChange')
          installedStateChange = listener
      }),
      receiver: { speaking: { off: vi.fn(), on: vi.fn() } },
      state: { status: 'ready' },
    }
    voiceMocks.joinVoiceChannel.mockReturnValue(createMock<VoiceConnection>(connection))
    const manager = createManager()
    const logger = {
      error: vi.fn(),
      log: vi.fn(),
      warn: vi.fn(),
      withError: vi.fn(),
      withField: vi.fn(),
      withFields: vi.fn(),
    }
    logger.withError.mockReturnValue(logger)
    logger.withField.mockReturnValue(logger)
    logger.withFields.mockReturnValue(logger)
    Reflect.set(manager, 'logger', logger)
    const channel = createMock<BaseGuildVoiceChannel>({
      guild: {
        id: 'guild-1',
        members: { me: undefined },
        voiceAdapterCreator: {},
      },
      guildId: 'guild-1',
      id: 'voice-1',
      name: 'Synthetic voice',
    })
    await manager.joinChannel(
      createMock<ChatInputCommandInteraction>({ reply: vi.fn(async () => {}) }),
      channel,
    )
    if (!installedStateChange)
      throw new Error('Synthetic connection did not receive the state-change callback.')

    // ROOT CAUSE:
    //
    // @discordjs/voice installs stateChange on a synchronous EventEmitter, but
    // the listener returned an unobserved promise. A release cleanup rejection
    // therefore became an unhandled rejection even after exact generation state
    // had been invalidated. The installed boundary must contain and log it while
    // the public direct handler keeps its rejecting semantics for explicit callers.
    /**
     * @example
     * await expect(installedStateChange({ status: 'ready' }, { status: 'destroyed' })).resolves.toBeUndefined()
     */
    await expect(installedStateChange(
      { status: 'ready' },
      { status: 'destroyed' },
    )).resolves.toBeUndefined()
    /**
     * @example
     * expect(logger.withFields).toHaveBeenCalledWith(expect.objectContaining({ eventCode: 'state-change-handler-failed', failureCategory: 'cleanup' }))
     */
    expect(logger.withFields).toHaveBeenCalledWith(expect.objectContaining({
      eventCode: 'state-change-handler-failed',
      failureCategory: 'cleanup',
      newState: 'destroyed',
      oldState: 'ready',
      sessionSequence: 1,
      terminal: true,
    }))
    const serializedLogs = JSON.stringify(logger.withFields.mock.calls)
    /** @example expect(serializedLogs).not.toContain('guild-1') */
    expect(serializedLogs).not.toContain('guild-1')
    /** @example expect(serializedLogs).not.toContain('voice-1') */
    expect(serializedLogs).not.toContain('voice-1')
    /** @example expect(serializedLogs).not.toContain(cleanupFailure.message) */
    expect(serializedLogs).not.toContain(cleanupFailure.message)
    /**
     * @example
     * expect(logger.error).toHaveBeenCalledWith('Discord voice lifecycle event')
     */
    expect(logger.error).toHaveBeenCalledWith('Discord voice lifecycle event')
    /**
     * @example
     * expect(Reflect.get(manager, 'activeVoiceSessionsByGuildId').size).toBe(0)
     */
    expect(Reflect.get(manager, 'activeVoiceSessionsByGuildId').size).toBe(0)
    /**
     * @example
     * expect(Reflect.get(manager, 'connectionListeners').size).toBe(0)
     */
    expect(Reflect.get(manager, 'connectionListeners').size).toBe(0)
  })

  /**
   * @example
   * it('reproduces Discord audit D-016 by containing an installed speaking-start cleanup rejection', async () => {})
   */
  it('reproduces Discord audit D-016 by containing an installed speaking-start cleanup rejection', async () => {
    const cleanupFailure = new Error('synthetic installed speaking-start cleanup failure')
    let installedSpeakingStart: ((userId: string) => Promise<void>) | undefined
    const connection = {
      destroy: vi.fn(),
      off: vi.fn(),
      on: vi.fn(),
      receiver: {
        speaking: {
          off: vi.fn(),
          on: vi.fn((event: string, listener: (userId: string) => Promise<void>) => {
            if (event === 'start')
              installedSpeakingStart = listener
          }),
        },
      },
      state: { status: 'ready' },
    }
    voiceMocks.joinVoiceChannel.mockReturnValue(createMock<VoiceConnection>(connection))
    const manager = new VoiceManager(
      createMock<DiscordClient>({ user: { id: 'bot-user' } }),
      async () => undefined,
      async () => '',
      undefined,
      {
        admit: vi.fn(() => true),
        allows: vi.fn(() => false),
      },
    )
    const logger = {
      error: vi.fn(),
      log: vi.fn(),
      warn: vi.fn(),
      withError: vi.fn(),
      withField: vi.fn(),
      withFields: vi.fn(),
    }
    logger.withError.mockReturnValue(logger)
    logger.withField.mockReturnValue(logger)
    logger.withFields.mockReturnValue(logger)
    Reflect.set(manager, 'logger', logger)
    const member = createMock<GuildMember>({
      displayName: 'Synthetic speaker',
      guild: { id: 'guild-1', name: 'Synthetic guild' },
      id: 'user-1',
      nickname: undefined,
      user: { bot: false },
    })
    const channel = createMock<BaseGuildVoiceChannel>({
      guild: {
        id: 'guild-1',
        members: { me: undefined },
        voiceAdapterCreator: {},
      },
      guildId: 'guild-1',
      id: 'voice-1',
      members: new Map([['user-1', member]]),
      name: 'Synthetic voice',
    })
    await manager.joinChannel(
      createMock<ChatInputCommandInteraction>({ reply: vi.fn(async () => {}) }),
      channel,
    )
    if (!installedSpeakingStart)
      throw new Error('Synthetic connection did not receive the speaking-start callback.')
    const session = Reflect.get(manager, 'activeVoiceSessionsByGuildId').get('guild-1')
    const speakerKey = `guild-1:voice-1:${session.scope.generation}:user-1`
    Reflect.get(manager, 'activeMonitors').set(speakerKey, {
      admitted: true,
      capture: { id: Symbol('synthetic-capture') },
      finishing: false,
      scope: session.scope,
      stop: vi.fn(() => {
        throw cleanupFailure
      }),
      userId: 'user-1',
    })

    // ROOT CAUSE:
    //
    // speakingStart was also installed as a raw async EventEmitter listener.
    // Revoking a speaker could synchronously remove its exact monitor, then a
    // receiver cleanup failure rejected the listener promise with no observer.
    // The installed boundary must contain it and invalidate only its generation.
    /**
     * @example
     * await expect(installedSpeakingStart('user-1')).resolves.toBeUndefined()
     */
    await expect(installedSpeakingStart('user-1')).resolves.toBeUndefined()
    /**
     * @example
     * expect(logger.withFields).toHaveBeenCalledWith(expect.objectContaining({ eventCode: 'speaking-start-handler-failed', failureCategory: 'receiver' }))
     */
    expect(logger.withFields).toHaveBeenCalledWith(expect.objectContaining({
      eventCode: 'speaking-start-handler-failed',
      failureCategory: 'receiver',
      sessionSequence: 1,
      terminal: true,
    }))
    const serializedLogs = JSON.stringify(logger.withFields.mock.calls)
    /** @example expect(serializedLogs).not.toContain('guild-1') */
    expect(serializedLogs).not.toContain('guild-1')
    /** @example expect(serializedLogs).not.toContain('voice-1') */
    expect(serializedLogs).not.toContain('voice-1')
    /** @example expect(serializedLogs).not.toContain('user-1') */
    expect(serializedLogs).not.toContain('user-1')
    /** @example expect(serializedLogs).not.toContain(cleanupFailure.message) */
    expect(serializedLogs).not.toContain(cleanupFailure.message)
    /**
     * @example
     * expect(logger.error).toHaveBeenCalledWith('Discord voice lifecycle event')
     */
    expect(logger.error).toHaveBeenCalledWith('Discord voice lifecycle event')
    /**
     * @example
     * expect(Reflect.get(manager, 'activeVoiceSessionsByGuildId').size).toBe(0)
     */
    expect(Reflect.get(manager, 'activeVoiceSessionsByGuildId').size).toBe(0)
    /**
     * @example
     * expect(Reflect.get(manager, 'activeMonitors').size).toBe(0)
     */
    expect(Reflect.get(manager, 'activeMonitors').size).toBe(0)
  })

  /**
   * @example
   * it('reproduces Discord audit D-015 by isolating leave and speaking-end finalization for concurrent speakers', async () => {})
   */
  it('reproduces Discord audit D-015 by isolating leave and speaking-end finalization for concurrent speakers', async () => {
    const manager = createManager()
    const finishInput = vi.fn()
    const abortInput = vi.fn()
    const stopA = vi.fn()
    const stopB = vi.fn()
    const scope = { channelId: 'voice-1', generation: 1, guildId: 'guild-1' }
    const connection = {
      destroy: vi.fn(),
      off: vi.fn(),
      receiver: { speaking: { off: vi.fn() } },
      state: { status: 'ready' },
    }
    const members = new Map([['user-b', { id: 'user-b', user: { bot: false } }]])
    const channel = createMock<BaseGuildVoiceChannel>({
      guild: { id: 'guild-1' },
      id: 'voice-1',
      members,
      name: 'Synthetic voice',
    })
    const activeSession = {
      abortController: new AbortController(),
      channel,
      connection,
      pendingDiscordVoiceStateResetCount: 0,
      scope,
    }
    Reflect.get(manager, 'activeVoiceSessionsByGuildId').set('guild-1', activeSession)
    Reflect.get(manager, 'realtimeSessions').set('guild-1:voice-1:1', {
      abortController: new AbortController(),
      committedInputItemIds: new Set(),
      committedInputTurnSequences: [],
      finishedInputTurnSequences: [],
      inputItemTurnSequences: new Map(),
      observedSpeechItemIds: new Set(),
      providerInputByTurn: new Map(),
      responseMetricsByTurn: new Map(),
      responseTurnSequences: new Map(),
      retiredInputItemIds: new Set(),
      retiredResponseIds: new Set(),
      provider: {
        abortInput,
        appendAudio: vi.fn(() => true),
        cancelResponse: vi.fn(),
        close: vi.fn(),
        finishInput,
      },
      scope,
      terminated: false,
    })
    Reflect.get(manager, 'activeMonitors').set('guild-1:voice-1:1:user-a', {
      admitted: true,
      capture: { id: Symbol('capture-a') },
      scope,
      stop: stopA,
      userId: 'user-a',
    })
    Reflect.get(manager, 'activeMonitors').set('guild-1:voice-1:1:user-b', {
      admitted: true,
      capture: { id: Symbol('capture-b') },
      scope,
      stop: stopB,
      userId: 'user-b',
    })
    Reflect.get(manager, 'consentSessionIdByGuildId').set('guild-1', 'consent-1')
    Reflect.get(manager, 'consentSessions').set('consent-1', {
      channel,
      consentedUserIds: new Set(['user-a', 'user-b']),
      id: 'consent-1',
      interaction: { editReply: vi.fn(async () => {}) },
      participantVoiceSessionIds: new Map([
        ['user-a', 'participant-session-a'],
        ['user-b', 'participant-session-b'],
      ]),
      state: 'active',
    })

    // ROOT CAUSE:
    //
    // A participant leave and the matching speaking-end event can arrive in
    // either order. Cleanup used mutable cache membership and channel-global
    // provider state, so A could leave its input pending or clear/submit B's
    // simultaneous turn. Each admitted monitor now owns one exact terminal state.
    const end = manager.handleAudioReceiveStreamEnd(channel, scope)
    await end('user-a')
    /**
     * @example
     * expect(finishInput).not.toHaveBeenCalled()
     */
    expect(finishInput).not.toHaveBeenCalled()
    await manager.handleVoiceStateUpdate(
      createMock<VoiceState>({ channelId: 'voice-1', guild: { id: 'guild-1' }, id: 'user-a' }),
      createMock<VoiceState>({ channelId: null, guild: { id: 'guild-1' }, id: 'user-a' }),
    )
    await end('user-a')
    await end('user-a')
    await end('user-b')
    await end('user-b')

    /**
     * @example
     * expect(stopA).toHaveBeenCalledOnce()
     */
    expect(stopA).toHaveBeenCalledOnce()
    /**
     * @example
     * expect(stopB).not.toHaveBeenCalled()
     */
    expect(stopB).not.toHaveBeenCalled()
    /**
     * @example
     * expect(abortInput).not.toHaveBeenCalled()
     */
    expect(abortInput).not.toHaveBeenCalled()
    /**
     * @example
     * expect(finishInput).not.toHaveBeenCalled()
     */
    expect(finishInput).not.toHaveBeenCalled()
    await manager.stop()
  })

  /**
   * @example
   * it('reproduces Discord audit D-016 by rejecting stale replacement connect side effects and permitting a fresh generation', async () => {})
   */
  it('reproduces Discord audit D-016 by rejecting stale replacement connect side effects and permitting a fresh generation', async () => {
    interface SyntheticProvider {
      appendAudio: (pcm: Buffer) => boolean
      cancelResponse: () => void
      close: () => void
      finishInput: () => void
    }
    const connectResolvers: Array<(provider: SyntheticProvider) => void> = []
    const runtime = {
      connect: vi.fn((_events: RealtimeVoiceCallSessionEvents, _options?: { signal: AbortSignal }) => {
        return new Promise<SyntheticProvider>(resolve => connectResolvers.push(resolve))
      }),
      getInterruptionRmsThreshold: () => 0.04,
      getMode: () => 'qwen-realtime' as const,
      isConfigured: () => true,
    }
    const createConnection = () => ({
      destroy: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
      receiver: { speaking: { off: vi.fn(), on: vi.fn() } },
      state: { status: 'ready' },
      subscribe: vi.fn(),
    })
    const connectionA = createConnection()
    const connectionB = createConnection()
    const connectionC = createConnection()
    voiceMocks.joinVoiceChannel
      .mockReturnValueOnce(createMock<VoiceConnection>(connectionA))
      .mockReturnValueOnce(createMock<VoiceConnection>(connectionB))
      .mockReturnValueOnce(createMock<VoiceConnection>(connectionC))
    const manager = new VoiceManager(
      createMock<DiscordClient>({ user: { id: 'bot-user' } }),
      async () => undefined,
      async () => '',
      runtime,
    )
    const createChannel = (id: string) => createMock<BaseGuildVoiceChannel>({
      guild: { id: 'guild-1', members: { me: undefined }, voiceAdapterCreator: {} },
      guildId: 'guild-1',
      id,
      name: id,
    })
    const interaction = createMock<ChatInputCommandInteraction>({ reply: vi.fn(async () => {}) })
    const joinA = manager.joinChannel(interaction, createChannel('voice-a'))
    await vi.waitFor(() => {
      /**
       * @example
       * expect(runtime.connect).toHaveBeenCalledTimes(1)
       */
      expect(runtime.connect).toHaveBeenCalledTimes(1)
    })
    const eventsA = runtime.connect.mock.calls[0][0]
    const optionsA = runtime.connect.mock.calls[0][1]
    const joinB = manager.joinChannel(interaction, createChannel('voice-b'))
    await vi.waitFor(() => {
      /**
       * @example
       * expect(runtime.connect).toHaveBeenCalledTimes(2)
       */
      expect(runtime.connect).toHaveBeenCalledTimes(2)
    })

    // ROOT CAUSE:
    //
    // A pending A connect had no registered generation owner. Replacement B
    // invalidated only visible sessions, allowing A's late resolution to install
    // callbacks/socket state over B. The pending record now exists before await,
    // receives abort, and closes any runtime that ignores that signal.
    /**
     * @example
     * expect(optionsA?.signal.aborted).toBe(true)
     */
    expect(optionsA?.signal.aborted).toBe(true)
    const providerA = {
      appendAudio: vi.fn(() => true),
      cancelResponse: vi.fn(),
      close: vi.fn(),
      finishInput: vi.fn(),
    }
    const providerB = {
      appendAudio: vi.fn(() => true),
      cancelResponse: vi.fn(),
      close: vi.fn(),
      finishInput: vi.fn(),
    }
    connectResolvers[0](providerA)
    connectResolvers[1](providerB)
    await joinA
    await joinB
    eventsA.onAudio?.(Buffer.from([1, 2, 3]), { responseId: 'stale-response' })

    /**
     * @example
     * expect(providerA.cancelResponse).toHaveBeenCalledOnce()
     */
    expect(providerA.cancelResponse).toHaveBeenCalledOnce()
    /**
     * @example
     * expect(providerA.close).toHaveBeenCalledOnce()
     */
    expect(providerA.close).toHaveBeenCalledOnce()
    /**
     * @example
     * expect(connectionA.subscribe).not.toHaveBeenCalled()
     */
    expect(connectionA.subscribe).not.toHaveBeenCalled()
    /**
     * @example
     * expect(connectionB.receiver.speaking.on).toHaveBeenCalledTimes(2)
     */
    expect(connectionB.receiver.speaking.on).toHaveBeenCalledTimes(2)

    await manager.stop()
    /**
     * @example
     * expect(providerB.close).toHaveBeenCalledOnce()
     */
    expect(providerB.close).toHaveBeenCalledOnce()
    /**
     * @example
     * expect(optionsB.signal.aborted).toBe(true)
     */
    expect(runtime.connect.mock.calls[1][1]?.signal.aborted).toBe(true)
    /**
     * @example
     * expect(pendingRealtimeConnectTasks.size).toBe(0)
     */
    expect(Reflect.get(manager, 'pendingRealtimeConnectTasks').size).toBe(0)

    const joinC = manager.joinChannel(interaction, createChannel('voice-c'))
    await vi.waitFor(() => {
      /**
       * @example
       * expect(runtime.connect).toHaveBeenCalledTimes(3)
       */
      expect(runtime.connect).toHaveBeenCalledTimes(3)
    })
    const providerC = {
      appendAudio: vi.fn(() => true),
      cancelResponse: vi.fn(),
      close: vi.fn(),
      finishInput: vi.fn(),
    }
    connectResolvers[2](providerC)
    await joinC
    /**
     * @example
     * expect(connectionC.receiver.speaking.on).toHaveBeenCalledTimes(2)
     */
    expect(connectionC.receiver.speaking.on).toHaveBeenCalledTimes(2)
    await manager.stop()
  })

  /**
   * @example
   * it('reproduces Discord audit D-016 by treating a late connect rejection after stop as drained cancellation', async () => {})
   */
  it('reproduces Discord audit D-016 by treating a late connect rejection after stop as drained cancellation', async () => {
    let rejectConnect = (_error: Error) => {}
    const pendingConnect = new Promise<never>((_resolve, reject) => {
      rejectConnect = reject
    })
    const runtime = {
      connect: vi.fn((_events: RealtimeVoiceCallSessionEvents, _options?: { signal: AbortSignal }) => pendingConnect),
      getInterruptionRmsThreshold: () => 0.04,
      getMode: () => 'qwen-realtime' as const,
      isConfigured: () => true,
    }
    const manager = new VoiceManager(
      createMock<DiscordClient>({ user: { id: 'bot-user' } }),
      async () => undefined,
      async () => '',
      runtime,
    )
    const connection = createMock<VoiceConnection>({
      destroy: vi.fn(),
      off: vi.fn(),
      receiver: { speaking: { off: vi.fn() } },
      state: { status: 'ready' },
    })
    const channel = createMock<BaseGuildVoiceChannel>({ guild: { id: 'guild-1' }, id: 'voice-1' })
    const voiceSession = {
      abortController: new AbortController(),
      channel,
      connection,
      pendingDiscordVoiceStateResetCount: 0,
      scope: { channelId: 'voice-1', generation: 1, guildId: 'guild-1' },
    }
    Reflect.get(manager, 'activeVoiceSessionsByGuildId').set('guild-1', voiceSession)
    const openTask = Reflect.apply(Reflect.get(manager, 'openRealtimeSession'), manager, [connection, voiceSession])
    await vi.waitFor(() => {
      /**
       * @example
       * expect(runtime.connect).toHaveBeenCalledOnce()
       */
      expect(runtime.connect).toHaveBeenCalledOnce()
    })

    // ROOT CAUSE:
    //
    // A provider rejection after stop used to escape an abandoned connect
    // Promise as an unhandled rejection. Cancellation now owns and drains the
    // exact task; only a failure from a still-current generation propagates.
    const stopTask = manager.stop()
    rejectConnect(new Error('synthetic late provider rejection'))

    /**
     * @example
     * await expect(openTask).resolves.toBeUndefined()
     */
    await expect(openTask).resolves.toBeUndefined()
    /**
     * @example
     * await expect(stopTask).resolves.toBeUndefined()
     */
    await expect(stopTask).resolves.toBeUndefined()
    /**
     * @example
     * expect(pendingRealtimeConnectTasks.size).toBe(0)
     */
    expect(Reflect.get(manager, 'pendingRealtimeConnectTasks').size).toBe(0)
    /**
     * @example
     * expect(realtimeSessions.size).toBe(0)
     */
    expect(Reflect.get(manager, 'realtimeSessions').size).toBe(0)
  })

  /**
   * @example
   * it('reproduces Discord audit D-016 by completing all stop cleanup before propagating the first failure', async () => {})
   */
  it('reproduces Discord audit D-016 by completing all stop cleanup before propagating the first failure', async () => {
    const manager = createManager()
    const firstCleanupError = new Error('synthetic first connection cleanup failure')
    const connectionA = {
      destroy: vi.fn(() => {
        throw firstCleanupError
      }),
      state: { status: 'ready' },
    }
    const connectionB = {
      destroy: vi.fn(),
      state: { status: 'ready' },
    }
    Reflect.get(manager, 'connections').set('voice-a', connectionA)
    Reflect.get(manager, 'connections').set('voice-b', connectionB)
    const closeProvider = vi.fn()
    Reflect.get(manager, 'realtimeSessions').set('guild-1:voice-a:1', {
      abortController: new AbortController(),
      committedInputItemIds: new Set(),
      committedInputTurnSequences: [],
      finishedInputTurnSequences: [],
      inputItemTurnSequences: new Map(),
      observedSpeechItemIds: new Set(),
      providerInputByTurn: new Map(),
      responseMetricsByTurn: new Map(),
      responseTurnSequences: new Map(),
      retiredInputItemIds: new Set(),
      retiredResponseIds: new Set(),
      provider: {
        appendAudio: vi.fn(() => true),
        cancelResponse: vi.fn(() => {
          throw new Error('synthetic later provider cleanup failure')
        }),
        close: closeProvider,
        finishInput: vi.fn(),
      },
      scope: { channelId: 'voice-a', generation: 1, guildId: 'guild-1' },
      terminated: false,
    })

    // ROOT CAUSE:
    //
    // Lifecycle cleanup previously ran as one fail-fast sequence. A throwing
    // connection/player/provider cleanup left later sockets, timers, and maps
    // alive. stop now records the first error, attempts every owned resource,
    // clears registries deterministically, and only then propagates that error.
    /**
     * @example
     * await expect(manager.stop()).rejects.toBe(firstCleanupError)
     */
    await expect(manager.stop()).rejects.toBe(firstCleanupError)
    /**
     * @example
     * expect(connectionB.destroy).toHaveBeenCalledOnce()
     */
    expect(connectionB.destroy).toHaveBeenCalledOnce()
    /**
     * @example
     * expect(closeProvider).toHaveBeenCalledOnce()
     */
    expect(closeProvider).toHaveBeenCalledOnce()
    /**
     * @example
     * expect(Reflect.get(manager, 'connections').size).toBe(0)
     */
    expect(Reflect.get(manager, 'connections').size).toBe(0)
    /**
     * @example
     * expect(Reflect.get(manager, 'realtimeSessions').size).toBe(0)
     */
    expect(Reflect.get(manager, 'realtimeSessions').size).toBe(0)
    /**
     * @example
     * await expect(manager.stop()).resolves.toBeUndefined()
     */
    await expect(manager.stop()).resolves.toBeUndefined()
  })

  /**
   * @example
   * it('does not submit an empty realtime turn when Discord reports speaking end', async () => {})
   */
  it('does not submit an empty realtime turn when Discord reports speaking end', async () => {
    const manager = createManager()
    const finishInput = vi.fn()
    const scope = { channelId: 'voice-1', generation: 0, guildId: 'guild-1' }
    const realtimeSessions = Reflect.get(manager, 'realtimeSessions')
    realtimeSessions.set('guild-1:voice-1:0', {
      abortController: new AbortController(),
      committedInputItemIds: new Set(),
      committedInputTurnSequences: [],
      finishedInputTurnSequences: [],
      inputItemTurnSequences: new Map(),
      observedSpeechItemIds: new Set(),
      providerInputByTurn: new Map(),
      responseMetricsByTurn: new Map(),
      responseTurnSequences: new Map(),
      retiredInputItemIds: new Set(),
      retiredResponseIds: new Set(),
      provider: {
        appendAudio: vi.fn(() => true),
        cancelResponse: vi.fn(),
        close: vi.fn(),
        finishInput,
      },
      scope,
      terminated: false,
    })
    Reflect.get(manager, 'activeMonitors').set('guild-1:voice-1:0:user-1', {
      admitted: true,
      scope,
      stop: vi.fn(),
      userId: 'user-1',
    })
    const handler = manager.handleAudioReceiveStreamEnd(createMock<BaseGuildVoiceChannel>({
      guild: { id: 'guild-1' },
      id: 'voice-1',
      members: {
        get: () => ({ displayName: 'Owen', user: { bot: false } }),
      },
    }))

    await handler('user-1')

    expect(finishInput).not.toHaveBeenCalled()
  })

  /**
   * @example
   * it('does not cancel realtime output on Discord speaking start before provider VAD', async () => {})
   */
  it('does not cancel realtime output on Discord speaking start before provider VAD', async () => {
    const manager = createManager()
    const cancelResponse = vi.fn()
    const realtimeSessions = Reflect.get(manager, 'realtimeSessions')
    realtimeSessions.set('guild-1:voice-1:0', {
      abortController: new AbortController(),
      committedInputItemIds: new Set(),
      committedInputTurnSequences: [],
      finishedInputTurnSequences: [],
      inputItemTurnSequences: new Map(),
      observedSpeechItemIds: new Set(),
      providerInputByTurn: new Map(),
      responseMetricsByTurn: new Map(),
      responseTurnSequences: new Map(),
      retiredInputItemIds: new Set(),
      retiredResponseIds: new Set(),
      provider: {
        appendAudio: vi.fn(() => true),
        cancelResponse,
        close: vi.fn(),
        finishInput: vi.fn(),
      },
      scope: { channelId: 'voice-1', generation: 0, guildId: 'guild-1' },
      terminated: false,
    })
    const member = {
      displayName: 'Owen',
      guild: { id: 'guild-1' },
      id: 'user-1',
      user: { bot: false },
    }
    const handler = manager.handleAudioReceiveStreamStart(createMock<BaseGuildVoiceChannel>({
      id: 'voice-1',
      members: {
        get: () => member,
      },
    }))

    // ROOT CAUSE:
    //
    // Discord emits `speaking.start` for any transmitted microphone audio,
    // including a fan crossing the user's client-side input threshold. The old
    // handler cancelled Qwen and destroyed playback before inspecting decoded
    // PCM, so a single noise packet interrupted AIRI.
    //
    // Speaking start must only open/reset the receive monitor. Local admission
    // is an input safety prefilter; Qwen provider VAD owns semantic speech and
    // the associated response cancellation decision.
    await handler('user-1')

    expect(cancelResponse).not.toHaveBeenCalled()
  })

  /**
   * @example
   * it('forwards locally admitted PCM without interrupting until provider VAD', async () => {})
   */
  it('forwards locally admitted PCM without interrupting until provider VAD', async () => {
    const receiveStream = new PassThrough()
    const connection = {
      destroy: vi.fn(),
      joinConfig: { guildId: 'guild-1' },
      receiver: {
        subscribe: vi.fn(() => receiveStream),
      },
      state: { status: 'ready' },
    }
    voiceMocks.getVoiceConnections.mockReturnValue(createMock<Map<string, VoiceConnection>>(new Map([['voice', connection]])))
    const cancelResponse = vi.fn()
    const appendAudio = vi.fn(() => true)
    const runtime = {
      connect: vi.fn(),
      getInterruptionRmsThreshold: () => 0.04,
      getMode: () => 'qwen-realtime' as const,
      isConfigured: () => true,
    }
    const manager = new VoiceManager(
      createMock<DiscordClient>({ user: { id: 'bot-user' } }),
      async () => undefined,
      async () => '',
      runtime,
    )
    const realtimeSessions = Reflect.get(manager, 'realtimeSessions')
    realtimeSessions.set('guild-1:voice-1:0', {
      abortController: new AbortController(),
      committedInputItemIds: new Set(),
      committedInputTurnSequences: [],
      finishedInputTurnSequences: [],
      inputItemTurnSequences: new Map(),
      observedSpeechItemIds: new Set(),
      providerInputByTurn: new Map(),
      responseMetricsByTurn: new Map(),
      responseTurnSequences: new Map(),
      retiredInputItemIds: new Set(),
      retiredResponseIds: new Set(),
      provider: {
        appendAudio,
        cancelResponse,
        close: vi.fn(),
        finishInput: vi.fn(),
      },
      scope: { channelId: 'voice-1', generation: 0, guildId: 'guild-1' },
      terminated: false,
    })
    const member = createMock<GuildMember>({
      displayName: 'Owen',
      guild: { id: 'guild-1' },
      id: 'user-1',
      user: { bot: false },
    })
    const channel = createMock<BaseGuildVoiceChannel>({
      guild: { id: 'guild-1' },
      id: 'voice-1',
      members: { get: () => member },
    })
    Reflect.get(manager, 'activeVoiceSessionsByGuildId').set('guild-1', {
      abortController: new AbortController(),
      channel,
      connection,
      currentDiagnosticTurnSequence: 1,
      diagnosticCleaned: false,
      diagnosticSessionSequence: 1,
      nextDiagnosticTurnSequence: 1,
      pendingDiscordVoiceStateResetCount: 0,
      scope: { channelId: 'voice-1', generation: 0, guildId: 'guild-1' },
    })
    const handler = manager.handleAudioReceiveStreamStart(channel)
    const packets = createOpusPcm16Fixture()

    await handler('user-1')
    for (let index = 0; index < 10; index += 1)
      receiveStream.write(packets.nextLowNoisePacket())

    expect(cancelResponse).not.toHaveBeenCalled()
    expect(appendAudio).not.toHaveBeenCalled()

    for (let index = 0; index < 6; index += 1)
      receiveStream.write(packets.nextSpeechPacket())

    expect(cancelResponse).not.toHaveBeenCalled()
    expect(appendAudio).toHaveBeenCalled()
    manager.stop()
  })

  /**
   * @example
   * it('records content-free production Voice diagnostics after R-003', async () => {})
   */
  it('records content-free production Voice diagnostics after R-003', async () => {
    const diagnostics: VoiceDiagnosticSignal[] = []
    const observer: VoiceDiagnosticsObserver = {
      record: signal => diagnostics.push({ ...signal }),
      runtimeSequence: 73,
    }
    const receiveStream = new PassThrough()
    let speakingStart: ((userId: string) => Promise<void>) | undefined
    let speakingEnd: ((userId: string) => Promise<void>) | undefined
    const playerListeners = new Map<string, (...args: unknown[]) => void>()
    const player = {
      on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
        playerListeners.set(event, listener)
        return player
      }),
      play: vi.fn(),
      removeAllListeners: vi.fn(),
      state: { status: 'idle' },
      stop: vi.fn(),
    }
    voiceMocks.createAudioPlayer.mockReturnValue(createMock<AudioPlayer>(player))
    voiceMocks.createAudioResource.mockReturnValue(createMock<AudioResource<null>>({ synthetic: 'voice-diagnostics-resource' }))
    const subscription = { unsubscribe: vi.fn() }
    const connection = createMock<VoiceConnection>({
      destroy: vi.fn(),
      joinConfig: {
        channelId: '900000000000000002',
        guildId: '900000000000000001',
      },
      off: vi.fn(),
      on: vi.fn(),
      receiver: {
        speaking: {
          off: vi.fn(),
          on: vi.fn((event: string, listener: (userId: string) => Promise<void>) => {
            if (event === 'start')
              speakingStart = listener
            if (event === 'end')
              speakingEnd = listener
          }),
        },
        subscribe: vi.fn(() => receiveStream),
      },
      state: { status: 'ready' },
      subscribe: vi.fn(() => createMock(subscription)),
    })
    voiceMocks.joinVoiceChannel.mockReturnValue(createMock<VoiceConnection>(connection))
    let providerEvents: RealtimeVoiceCallSessionEvents | undefined
    let providerAppendCount = 0
    const provider = {
      abortInput: vi.fn(),
      appendAudio: vi.fn((chunk: Buffer, inputSequence: number) => {
        providerAppendCount += 1
        if (providerAppendCount > 1)
          return false
        providerEvents?.onInputAudioSent?.({ byteLength: chunk.length, chunkCount: 1, inputSequence, kind: 'user-audio' })
        return true
      }),
      cancelResponse: vi.fn(),
      close: vi.fn(),
      finishInput: vi.fn(() => {
        providerEvents?.onInputAudioSent?.({ byteLength: 320, chunkCount: 1, inputSequence: 1, kind: 'synthetic-silence' })
      }),
    }
    const runtime = {
      connect: vi.fn(async (events: RealtimeVoiceCallSessionEvents) => {
        providerEvents = events
        return provider
      }),
      getInterruptionRmsThreshold: () => 0.04,
      getMode: () => 'qwen-realtime' as const,
      isConfigured: () => true,
    }
    const member = createMock<GuildMember>({
      displayName: 'SYNTHETIC_PRIVATE_TRANSCRIPT_SENTINEL',
      guild: { id: '900000000000000001' },
      id: '900000000000000003',
      user: { bot: false },
    })
    const channel = createMock<BaseGuildVoiceChannel>({
      guild: {
        id: '900000000000000001',
        members: { me: undefined },
        voiceAdapterCreator: {},
      },
      guildId: '900000000000000001',
      id: '900000000000000002',
      members: new Map([['900000000000000003', member]]),
      name: 'wss://synthetic-provider.invalid/realtime?workspace=SYNTHETIC_WORKSPACE_SECRET',
    })
    const manager = new VoiceManager(
      createMock<DiscordClient>({ user: { id: '900000000000000004' } }),
      async () => undefined,
      async () => '',
      runtime,
      undefined,
      undefined,
      undefined,
      observer,
    )
    const logger = {
      error: vi.fn(),
      log: vi.fn(),
      warn: vi.fn(),
      withError: vi.fn(),
      withField: vi.fn(),
      withFields: vi.fn(),
    }
    logger.withError.mockReturnValue(logger)
    logger.withField.mockReturnValue(logger)
    logger.withFields.mockReturnValue(logger)
    Reflect.set(manager, 'logger', logger)
    const interaction = createMock<ChatInputCommandInteraction>({
      deferred: false,
      editReply: vi.fn(async () => {}),
      reply: vi.fn(async () => {}),
      replied: false,
    })

    // ROOT CAUSE:
    //
    // The previous voice path exposed no content-free state projection at its
    // real Discord receiver, Qwen callback, player, or cleanup boundaries. A
    // failed human E2E could prove only that nobody heard output; it could not
    // distinguish muted/no input from provider-no-response or playback failure.
    // The diagnostics observer must receive bounded counters and fixed stages
    // from those production handlers without retaining any controlled content.
    await manager.joinChannel(interaction, channel)
    if (!speakingStart || !speakingEnd || !providerEvents)
      throw new Error('Expected the synthetic voice lifecycle callbacks to be installed.')

    const activeSession = Reflect.get(manager, 'activeVoiceSessionsByGuildId').get(channel.guild.id)
    if (!activeSession)
      throw new Error('Expected the synthetic voice session to own the connection.')
    await manager.handleVoiceConnectionStateChange(channel, connection, activeSession)(
      createMock<VoiceConnectionState>({ status: 'ready' }),
      createMock<VoiceConnectionState>({ status: 'disconnected' }),
    )

    await speakingStart(member.id)
    const packets = createOpusPcm16Fixture()
    for (let index = 0; index < 16; index += 1)
      receiveStream.write(packets.nextSpeechPacket())
    await vi.waitFor(() => {
      /** @example expect(provider.appendAudio).toHaveBeenCalled() */
      expect(provider.appendAudio).toHaveBeenCalled()
    })
    await speakingEnd(member.id)

    // Exercise the real receiver close callback after backpressure has already
    // crossed the logger boundary. Both callbacks previously retained the
    // external Discord scope in structured fields.
    receiveStream.emit('close')

    const activeMonitors = Reflect.get(manager, 'activeMonitors')
    for (let index = 0; index < 32; index += 1) {
      activeMonitors.set(`synthetic-capacity-${index}`, {
        admitted: true,
        scope: activeSession.scope,
        stop: vi.fn(),
        userId: `synthetic-capacity-user-${index}`,
      })
    }
    const overflowMember = createMock<GuildMember>({
      guild: { id: channel.guild.id },
      id: '900000000000000005',
      user: { bot: false },
    })
    channel.members.set(overflowMember.id, overflowMember)
    await speakingStart(overflowMember.id)
    for (let index = 0; index < 32; index += 1)
      activeMonitors.delete(`synthetic-capacity-${index}`)

    // ROOT CAUSE:
    //
    // A provider append failure retires the capture generation. The old test
    // accepted a late committed/response callback as a new playback owner,
    // which could revive a retired generation after backpressure.
    //
    // A retired generation must fail closed: none of its late callbacks may
    // attach a player listener or begin playback.
    providerEvents.onInputCommitted?.({ itemId: 'synthetic-item' })
    providerEvents.onSpeechStarted?.({ itemId: 'synthetic-item' })
    providerEvents.onResponseCreated?.({ responseId: 'synthetic-response' })
    providerEvents.onUserTranscript?.('SYNTHETIC_PRIVATE_TRANSCRIPT_SENTINEL', { itemId: 'synthetic-item' })
    providerEvents.onAssistantTranscript?.('SYNTHETIC_ASSISTANT_TEXT_SENTINEL', { responseId: 'synthetic-response' })
    providerEvents.onAudio?.(Buffer.from('SYNTHETIC_AUDIO_PAYLOAD_SENTINEL'), { responseId: 'synthetic-response' })
    providerEvents.onResponseDone?.({ responseId: 'synthetic-response' }, 'completed')
    /** @example expect(playerListeners.size).toBe(0) */
    expect(playerListeners.size).toBe(0)
    /** @example expect(player.play).not.toHaveBeenCalled() */
    expect(player.play).not.toHaveBeenCalled()
    /** @example expect(subscription.unsubscribe).not.toHaveBeenCalled() */
    expect(subscription.unsubscribe).not.toHaveBeenCalled()
    providerEvents.onError?.({ category: 'provider-error', disposition: 'terminal' })
    manager.leaveChannel(channel)
    await manager.stop()
    /** @example expect(provider.close).toHaveBeenCalledOnce() */
    expect(provider.close).toHaveBeenCalledOnce()

    /** @example expect(diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ mode: 'qwen-realtime', runtimeSequence: 73, stage: 'session-started' }), expect.objectContaining({ cleanupReason: 'replaced', runtimeSequence: 73, stage: 'session-cleaned' })])) */
    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ mode: 'qwen-realtime', runtimeSequence: 73, stage: 'session-started' }),
      expect.objectContaining({ runtimeSequence: 73, stage: 'transport-ready' }),
      expect.objectContaining({ runtimeSequence: 73, stage: 'provider-ready' }),
      expect.objectContaining({ runtimeSequence: 73, stage: 'speaking-started' }),
      expect.objectContaining({ cleanupReason: 'replaced', runtimeSequence: 73, stage: 'session-cleaned' }),
    ]))
    const receiverDiagnostic = diagnostics.find(signal => signal.stage === 'receiver-audio')
    /** @example expect(receiverDiagnostic?.opusPackets).toBeGreaterThan(0) */
    expect(receiverDiagnostic?.opusPackets).toBeGreaterThan(0)
    /** @example expect(receiverDiagnostic?.opusBytes).toBeGreaterThan(0) */
    expect(receiverDiagnostic?.opusBytes).toBeGreaterThan(0)
    /** @example expect(receiverDiagnostic?.pcmFrames).toBeGreaterThan(0) */
    expect(receiverDiagnostic?.pcmFrames).toBeGreaterThan(0)
    /** @example expect(receiverDiagnostic?.pcmBytes).toBeGreaterThan(0) */
    expect(receiverDiagnostic?.pcmBytes).toBeGreaterThan(0)
    const providerInputDiagnostics = diagnostics.filter(
      (signal): signal is Extract<VoiceDiagnosticSignal, { stage: 'provider-input-appended' }> => signal.stage === 'provider-input-appended',
    )
    const userInputDiagnostic = providerInputDiagnostics.find(signal => signal.inputKind === 'user-audio')
    /** @example expect(userInputDiagnostic?.providerInputChunks).toBeGreaterThan(0) */
    expect(userInputDiagnostic?.providerInputChunks).toBeGreaterThan(0)
    /** @example expect(userInputDiagnostic?.providerInputBytes).toBeGreaterThan(0) */
    expect(userInputDiagnostic?.providerInputBytes).toBeGreaterThan(0)
    const serializedDiagnostics = JSON.stringify(diagnostics)
    /** @example expect(serializedDiagnostics).not.toContain('SYNTHETIC_PRIVATE_TRANSCRIPT_SENTINEL') */
    expect(serializedDiagnostics).not.toContain('SYNTHETIC_PRIVATE_TRANSCRIPT_SENTINEL')
    /** @example expect(serializedDiagnostics).not.toContain('SYNTHETIC_ASSISTANT_TEXT_SENTINEL') */
    expect(serializedDiagnostics).not.toContain('SYNTHETIC_ASSISTANT_TEXT_SENTINEL')
    /** @example expect(serializedDiagnostics).not.toContain('SYNTHETIC_AUDIO_PAYLOAD_SENTINEL') */
    expect(serializedDiagnostics).not.toContain('SYNTHETIC_AUDIO_PAYLOAD_SENTINEL')
    /** @example expect(serializedDiagnostics).not.toContain('SYNTHETIC_PROVIDER_SECRET') */
    expect(serializedDiagnostics).not.toContain('SYNTHETIC_PROVIDER_SECRET')
    /** @example expect(serializedDiagnostics).not.toContain('SYNTHETIC_WORKSPACE_SECRET') */
    expect(serializedDiagnostics).not.toContain('SYNTHETIC_WORKSPACE_SECRET')
    /** @example expect(serializedDiagnostics).not.toContain('synthetic-provider.invalid') */
    expect(serializedDiagnostics).not.toContain('synthetic-provider.invalid')
    /** @example expect(serializedDiagnostics).not.toContain('900000000000000001') */
    expect(serializedDiagnostics).not.toContain('900000000000000001')
    /** @example expect(serializedDiagnostics).not.toContain('900000000000000002') */
    expect(serializedDiagnostics).not.toContain('900000000000000002')
    /** @example expect(serializedDiagnostics).not.toContain('900000000000000003') */
    expect(serializedDiagnostics).not.toContain('900000000000000003')
    const serializedLogs = JSON.stringify({
      error: logger.error.mock.calls,
      log: logger.log.mock.calls,
      warn: logger.warn.mock.calls,
      withError: logger.withError.mock.calls,
      withField: logger.withField.mock.calls,
      withFields: logger.withFields.mock.calls,
    })
    /** @example expect(serializedLogs).not.toContain('SYNTHETIC_PRIVATE_TRANSCRIPT_SENTINEL') */
    expect(serializedLogs).not.toContain('SYNTHETIC_PRIVATE_TRANSCRIPT_SENTINEL')
    /** @example expect(serializedLogs).not.toContain('SYNTHETIC_ASSISTANT_TEXT_SENTINEL') */
    expect(serializedLogs).not.toContain('SYNTHETIC_ASSISTANT_TEXT_SENTINEL')
    /** @example expect(serializedLogs).not.toContain('SYNTHETIC_AUDIO_PAYLOAD_SENTINEL') */
    expect(serializedLogs).not.toContain('SYNTHETIC_AUDIO_PAYLOAD_SENTINEL')
    /** @example expect(serializedLogs).not.toContain('SYNTHETIC_PROVIDER_SECRET') */
    expect(serializedLogs).not.toContain('SYNTHETIC_PROVIDER_SECRET')
    /** @example expect(serializedLogs).not.toContain('SYNTHETIC_WORKSPACE_SECRET') */
    expect(serializedLogs).not.toContain('SYNTHETIC_WORKSPACE_SECRET')
    /** @example expect(serializedLogs).not.toContain('synthetic-provider.invalid') */
    expect(serializedLogs).not.toContain('synthetic-provider.invalid')
    /** @example expect(serializedLogs).not.toContain('900000000000000001') */
    expect(serializedLogs).not.toContain('900000000000000001')
    /** @example expect(serializedLogs).not.toContain('900000000000000002') */
    expect(serializedLogs).not.toContain('900000000000000002')
    /** @example expect(serializedLogs).not.toContain('900000000000000003') */
    expect(serializedLogs).not.toContain('900000000000000003')
    /** @example expect(serializedLogs).not.toContain('900000000000000005') */
    expect(serializedLogs).not.toContain('900000000000000005')
    const lifecycleFields = logger.withFields.mock.calls.map(([fields]) => fields)
    /** @example expect(lifecycleFields).toEqual(expect.arrayContaining([expect.objectContaining({ eventCode: 'connection-established', state: 'ready' }), expect.objectContaining({ eventCode: 'session-dismissed' })])) */
    expect(lifecycleFields).toEqual(expect.arrayContaining([
      expect.objectContaining({ eventCode: 'connection-established', state: 'ready' }),
      expect.objectContaining({ eventCode: 'connection-reconnecting', retryable: true }),
      expect.objectContaining({
        eventCode: 'provider-input-backpressure',
        failureCategory: 'provider',
        retryable: true,
      }),
      expect.objectContaining({
        eventCode: 'provider-correlation-rejected',
        failureCategory: 'provider',
        retryable: true,
      }),
      expect.objectContaining({ eventCode: 'session-dismissed' }),
    ]))
  })

  /**
   * @example
   * it('correlates interleaved realtime responses to their exact turns', async () => {})
   */
  it('correlates interleaved realtime responses to their exact turns for Discord audit P2-A', async () => {
    // ROOT CAUSE:
    //
    // VoiceManager retained one pending input turn and one response turn. A
    // Turn 1 response remained pending when barge-in opened Turn 2, so the next
    // speech/commit callbacks were attributed back to Turn 1. A late Turn 1
    // terminal callback then cleared the shared slots owned by Turn 2.
    //
    // Before this patch, provider item/response identities were discarded and
    // this interleaving recorded Turn 2 VAD/commit on Turn 1.
    //
    // We fixed this with bounded item-to-turn and response-to-turn ownership,
    // plus separate capture and committed-input queues.
    const diagnostics: VoiceDiagnosticSignal[] = []
    let providerEvents: RealtimeVoiceCallSessionEvents | undefined
    const provider = {
      abortInput: vi.fn(),
      appendAudio: vi.fn((pcm: Buffer, inputSequence: number) => {
        providerEvents?.onInputAudioSent?.({ byteLength: pcm.length, chunkCount: 1, inputSequence, kind: 'user-audio' })
        return true
      }),
      cancelResponse: vi.fn(),
      close: vi.fn(),
      finishInput: vi.fn(),
    }
    const runtime = {
      connect: vi.fn(async (events: RealtimeVoiceCallSessionEvents) => {
        providerEvents = events
        return provider
      }),
      getInterruptionRmsThreshold: () => 0.04,
      getMode: () => 'qwen-realtime' as const,
      isConfigured: () => true,
    }
    const manager = new VoiceManager(
      createMock<DiscordClient>({ user: { id: 'synthetic-bot' } }),
      async () => undefined,
      async () => '',
      runtime,
      undefined,
      undefined,
      undefined,
      { record: signal => diagnostics.push({ ...signal }), runtimeSequence: 1 },
    )
    const player = {
      on: vi.fn(),
      play: vi.fn(),
      removeAllListeners: vi.fn(),
      state: { status: 'idle' },
      stop: vi.fn(),
    }
    voiceMocks.createAudioPlayer.mockReturnValue(createMock<AudioPlayer>(player))
    voiceMocks.createAudioResource.mockReturnValue(createMock<AudioResource<null>>({ synthetic: 'correlation-resource' }))
    const fixture = createPublicRealtimeChannel('synthetic-guild', 'synthetic-channel', 'synthetic-user')
    voiceMocks.joinVoiceChannel.mockReturnValue(createMock<VoiceConnection>(fixture.connection))
    await manager.joinChannel(createMock<ChatInputCommandInteraction>({ reply: vi.fn(async () => {}) }), fixture.channel)
    if (!providerEvents)
      throw new Error('Expected realtime callbacks to be installed.')

    const turn1 = await appendPublicRealtimeInput(fixture, provider)
    providerEvents.onSpeechStarted?.({ inputSequence: turn1, itemId: 'provider-item-1' })
    providerEvents.onInputCommitted?.({ inputSequence: turn1, itemId: 'provider-item-1' })
    providerEvents.onResponseCreated?.({ responseId: 'provider-response-1' })
    providerEvents.onAudio?.(Buffer.from([1, 1]), { responseId: 'provider-response-1' })

    fixture.speaking.emit('end', fixture.userId)
    const turn2 = await appendPublicRealtimeInput(fixture, provider)
    providerEvents.onSpeechStarted?.({ inputSequence: turn2, itemId: 'provider-item-2' })
    providerEvents.onInputCommitted?.({ inputSequence: turn2, itemId: 'provider-item-2' })

    providerEvents.onResponseCancelled?.({ responseId: 'provider-response-1' })
    providerEvents.onResponseCreated?.({ responseId: 'provider-response-2' })
    providerEvents.onAudio?.(Buffer.from([2, 2]), { responseId: 'provider-response-2' })

    // A cancel request can cross already-buffered response audio. Once Turn 1
    // is locally cancelled, its late delta and duplicate input events must not
    // restart Turn 1 playback or mutate its counters while Turn 2 is active.
    providerEvents.onAudio?.(Buffer.from([9, 9]), { responseId: 'provider-response-1' })
    providerEvents.onSpeechStarted?.({ inputSequence: turn1, itemId: 'provider-item-1' })
    providerEvents.onInputCommitted?.({ inputSequence: turn1, itemId: 'provider-item-1' })
    providerEvents.onResponseDone?.({ responseId: 'provider-response-1' }, 'cancelled')

    // ROOT CAUSE:
    //
    // Releasing a completed response deleted its provider identities outright.
    // A late duplicate `response.created` could therefore consume Turn 3's
    // committed-input FIFO slot and masquerade as the new response.
    //
    // Retired provider identities now remain in a generation-owned bounded
    // tombstone set. Reuse fails closed instead of stealing newer ownership.
    fixture.speaking.emit('end', fixture.userId)
    const turn3 = await appendPublicRealtimeInput(fixture, provider)
    providerEvents.onSpeechStarted?.({ inputSequence: turn3, itemId: 'provider-item-3' })
    providerEvents.onInputCommitted?.({ inputSequence: turn3, itemId: 'provider-item-3' })
    providerEvents.onResponseCreated?.({ responseId: 'provider-response-1' })
    providerEvents.onResponseCreated?.({ responseId: 'provider-response-3' })
    providerEvents.onAudio?.(Buffer.from([3, 3]), { responseId: 'provider-response-3' })
    providerEvents.onResponseDone?.({ responseId: 'provider-response-3' }, 'completed')

    providerEvents.onAudioDone?.({ responseId: 'provider-response-2' })
    providerEvents.onResponseDone?.({ responseId: 'provider-response-2' }, 'completed')

    const stages = diagnostics
      .filter((signal): signal is Extract<VoiceDiagnosticSignal, { turnSequence: number }> => 'turnSequence' in signal)
      .map(signal => ({ stage: signal.stage, turnSequence: signal.turnSequence }))

    expect(stages).toContainEqual({ stage: 'provider-input-committed', turnSequence: 1 })
    expect(stages).toContainEqual({ stage: 'provider-response-created', turnSequence: 1 })
    expect(stages).toContainEqual({ stage: 'provider-response-cancelled', turnSequence: 1 })
    expect(stages).toContainEqual({ stage: 'provider-vad', turnSequence: 2 })
    expect(stages).toContainEqual({ stage: 'provider-input-committed', turnSequence: 2 })
    expect(stages).toContainEqual({ stage: 'provider-response-created', turnSequence: 2 })
    expect(stages).toContainEqual({ stage: 'provider-response-completed', turnSequence: 2 })
    expect(stages).toContainEqual({ stage: 'provider-response-created', turnSequence: 3 })
    expect(stages).toContainEqual({ stage: 'provider-response-completed', turnSequence: 3 })
    expect(stages.filter(stage => stage.stage === 'provider-vad' && stage.turnSequence === 1)).toHaveLength(1)
    expect(stages.filter(stage => stage.stage === 'provider-input-committed' && stage.turnSequence === 1)).toHaveLength(1)
    expect(diagnostics.filter(signal => signal.stage === 'provider-response-audio' && signal.turnSequence === 1)).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ responseAudioChunks: 2 })]),
    )
    expect(stages.filter(stage => stage.stage === 'provider-response-completed')).toEqual([
      { stage: 'provider-response-completed', turnSequence: 3 },
      { stage: 'provider-response-completed', turnSequence: 2 },
    ])

    await manager.stop()
    expect(provider.close).toHaveBeenCalledOnce()
  })

  /**
   * @example
   * it('projects parser identities and actual Qwen socket sends end to end', async () => {})
   */
  it('projects parser identities and actual Qwen socket sends end to end for Discord audit P2-A/P3', async () => {
    // ROOT CAUSE:
    //
    // The Qwen parser formerly discarded provider identities, while provider
    // input telemetry was counted before the runtime performed its socket send.
    // Testing either state container alone could not prove the production
    // parser, VoiceManager correlation, and Dashboard projection agreed.
    //
    // This regression drives real Qwen message parsing and successful public
    // receiver input through VoiceManager into the bounded diagnostics
    // projection. Directly calling the provider wrapper bypassed the mandatory
    // appendRealtimeChunks invocation stack and became invalid once formal
    // acknowledgements were made causal.
    vi.useFakeTimers()
    const socketEvents = new EventEmitter()
    const sentFrames: string[] = []
    let readyState = 0
    const socket = {
      get bufferedAmount() {
        return 0
      },
      get readyState() {
        return readyState
      },
      close: vi.fn((code = 1000, reason = 'closed') => {
        readyState = 3
        socketEvents.emit('close', code, Buffer.from(reason))
      }),
      off: socketEvents.off.bind(socketEvents),
      on: socketEvents.on.bind(socketEvents),
      onOpen: (listener: () => void) => socketEvents.on('open', listener),
      send: vi.fn((data: string) => sentFrames.push(data)),
    }
    const runtime = new QwenRealtimeRuntime(resolveQwenRealtimeConfig({
      AIRI_DISCORD_VOICE_CALL_MODE: 'qwen-realtime',
      DASHSCOPE_API_KEY: 'synthetic-provider-key',
      QWEN_REALTIME_VAD_SILENCE_DURATION_MS: '200',
      QWEN_REALTIME_WORKSPACE_ID: 'synthetic-workspace',
    }), { socketFactory: () => socket })
    const projection = new StandaloneVoiceDiagnostics()
    const player = {
      on: vi.fn(),
      play: vi.fn(),
      removeAllListeners: vi.fn(),
      state: { status: 'idle' },
      stop: vi.fn(),
    }
    voiceMocks.createAudioPlayer.mockReturnValue(createMock<AudioPlayer>(player))
    voiceMocks.createAudioResource.mockReturnValue(createMock<AudioResource<null>>({ synthetic: 'qwen-parser-resource' }))
    const fixture = createPublicRealtimeChannel('synthetic-guild', 'synthetic-channel', 'synthetic-user')
    const manager = new VoiceManager(
      createMock<DiscordClient>({ user: { id: 'synthetic-bot' } }),
      async () => undefined,
      async () => '',
      runtime,
      undefined,
      undefined,
      undefined,
      { record: signal => projection.record(signal), runtimeSequence: 7 },
    )
    voiceMocks.joinVoiceChannel.mockReturnValue(createMock<VoiceConnection>(fixture.connection))
    const openTask = manager.joinChannel(
      createMock<ChatInputCommandInteraction>({ reply: vi.fn(async () => {}) }),
      fixture.channel,
    )
    await vi.waitFor(() => {
      expect(socketEvents.listenerCount('open')).toBeGreaterThan(0)
      expect(sentFrames).toHaveLength(0)
    })
    readyState = 1
    socketEvents.emit('open')
    socketEvents.emit('message', Buffer.from(JSON.stringify({ event_id: 'session-configured', type: 'session.updated' })))
    await openTask

    const inputFrames = () => sentFrames
      .map(frame => JSON.parse(frame) as { audio?: string, type?: string })
      .filter(frame => frame.type === 'input_audio_buffer.append')
    const appendCapture = async () => {
      const appendedBefore = inputFrames().length
      fixture.speaking.emit('start', fixture.userId)
      await vi.waitFor(() => expect(fixture.connection.receiver.subscribe).toHaveBeenCalled())
      const packets = createOpusPcm16Fixture()
      for (let frame = 0; frame < 6; frame += 1)
        fixture.receiveStream.write(packets.nextSpeechPacket())
      await vi.waitFor(() => expect(inputFrames().length).toBeGreaterThan(appendedBefore))
      return appendedBefore
    }

    await appendCapture()
    const firstUserFrames = inputFrames().slice()
    fixture.speaking.emit('end', fixture.userId)
    await vi.advanceTimersByTimeAsync(200)
    const firstInputFrames = inputFrames().slice()

    socketEvents.emit('message', Buffer.from(JSON.stringify({ event_id: 'provider-item-1-committed', item_id: 'provider-item-1', type: 'input_audio_buffer.committed' })))
    socketEvents.emit('message', Buffer.from(JSON.stringify({ event_id: 'provider-response-1-created', response: { id: 'provider-response-1' }, type: 'response.created' })))
    socketEvents.emit('message', Buffer.from(JSON.stringify({
      delta: Buffer.from([1, 1]).toString('base64'),
      event_id: 'provider-response-1-audio-delta',
      response_id: 'provider-response-1',
      type: 'response.audio.delta',
    })))

    await appendCapture()
    const allInputFrames = inputFrames()
    const secondUserFrames = allInputFrames.slice(firstInputFrames.length)
    socketEvents.emit('message', Buffer.from(JSON.stringify({ event_id: 'provider-item-2-speech-started', item_id: 'provider-item-2', type: 'input_audio_buffer.speech_started' })))
    socketEvents.emit('message', Buffer.from(JSON.stringify({ event_id: 'provider-item-2-committed', item_id: 'provider-item-2', type: 'input_audio_buffer.committed' })))
    socketEvents.emit('message', Buffer.from(JSON.stringify({ event_id: 'provider-response-1-cancelled', response: { id: 'provider-response-1', status: 'cancelled' }, type: 'response.done' })))
    socketEvents.emit('message', Buffer.from(JSON.stringify({ event_id: 'provider-response-2-created', response: { id: 'provider-response-2' }, type: 'response.created' })))
    socketEvents.emit('message', Buffer.from(JSON.stringify({
      delta: Buffer.from([2, 2]).toString('base64'),
      event_id: 'provider-response-2-audio-delta',
      response_id: 'provider-response-2',
      type: 'response.audio.delta',
    })))
    socketEvents.emit('message', Buffer.from(JSON.stringify({ event_id: 'provider-response-2-done', response: { id: 'provider-response-2', status: 'completed' }, type: 'response.done' })))

    const userInputBytes = firstUserFrames.reduce((total, frame) => total + Buffer.from(frame.audio ?? '', 'base64').byteLength, 0)
    const syntheticFrames = firstInputFrames.slice(firstUserFrames.length)
    const syntheticInputBytes = syntheticFrames.reduce((total, frame) => total + Buffer.from(frame.audio ?? '', 'base64').byteLength, 0)
    const secondUserInputBytes = secondUserFrames.reduce((total, frame) => total + Buffer.from(frame.audio ?? '', 'base64').byteLength, 0)
    const turn1 = projection.getSnapshot().active[0].turns.find(turn => turn.turnSequence === 1)
    const turn2 = projection.getSnapshot().active[0].turns.find(turn => turn.turnSequence === 2)

    expect(firstUserFrames.length).toBeGreaterThan(0)
    expect(syntheticFrames.length).toBeGreaterThan(0)
    expect(secondUserFrames.length).toBeGreaterThan(0)
    expect(allInputFrames).toHaveLength(firstUserFrames.length + syntheticFrames.length + secondUserFrames.length)
    expect(turn1).toMatchObject({
      inputAppends: firstUserFrames.length + syntheticFrames.length,
      inputBytes: userInputBytes + syntheticInputBytes,
      responsesCancelled: 1,
      responsesCompleted: 0,
      syntheticInputAppends: syntheticFrames.length,
      syntheticInputBytes,
      userInputAppends: firstUserFrames.length,
      userInputBytes,
    })
    expect(turn2).toMatchObject({
      inputAppends: secondUserFrames.length,
      inputBytes: secondUserInputBytes,
      providerVadTurns: 1,
      responsesCompleted: 1,
      responsesStarted: 1,
      syntheticInputAppends: 0,
      syntheticInputBytes: 0,
      userInputAppends: secondUserFrames.length,
      userInputBytes: secondUserInputBytes,
    })

    await manager.stop()
    expect(socket.close).toHaveBeenCalledOnce()
  })

  /**
   * @example
   * it('keeps the VoiceManager session alive across a recoverable Qwen transport loss', async () => {})
   */
  it('keeps the VoiceManager session alive across a recoverable Qwen transport loss for Discord audit P2-B', async () => {
    // ROOT CAUSE:
    //
    // This fixture previously wrote directly into the private realtime session
    // and called its provider wrapper. That skipped Discord receiver admission
    // and the causal append invocation stack, incorrectly requiring the old
    // wrapper architecture to accept a stackless acknowledgement.
    //
    // The public receiver boundary now supplies the post-reconnect PCM. The
    // real Qwen runtime must reconnect, accept that causal input, ignore late
    // callbacks from the first socket, and leave the replacement lifecycle
    // healthy until normal cleanup.
    vi.useFakeTimers()
    const sockets = [new EventEmitter(), new EventEmitter()].map((events) => {
      let readyState = 0
      const sent: string[] = []
      return {
        events,
        socket: {
          get bufferedAmount() { return 0 },
          get readyState() { return readyState },
          close: vi.fn((code = 1000, reason = 'closed') => {
            readyState = 3
            events.emit('close', code, Buffer.from(reason))
          }),
          off: events.off.bind(events),
          on: events.on.bind(events),
          send: vi.fn((data: string) => sent.push(data)),
        },
        setReady: (value: number) => { readyState = value },
        sent,
      }
    })
    const [first, second] = sockets
    const socketQueue = [first, second]
    const runtime = new QwenRealtimeRuntime(resolveQwenRealtimeConfig({
      AIRI_DISCORD_VOICE_CALL_MODE: 'qwen-realtime',
      DASHSCOPE_API_KEY: 'synthetic-provider-key',
      QWEN_REALTIME_WORKSPACE_ID: 'synthetic-workspace',
    }), { socketFactory: vi.fn(() => socketQueue.shift()!.socket) })
    const diagnostics: VoiceDiagnosticSignal[] = []
    const player = {
      on: vi.fn(),
      play: vi.fn(),
      removeAllListeners: vi.fn(),
      state: { status: 'idle' },
      stop: vi.fn(),
    }
    voiceMocks.createAudioPlayer.mockReturnValue(createMock<AudioPlayer>(player))
    const fixture = createPublicRealtimeChannel('synthetic-guild', 'synthetic-channel', 'synthetic-user')
    voiceMocks.joinVoiceChannel.mockReturnValue(createMock<VoiceConnection>(fixture.connection))
    const manager = new VoiceManager(
      createMock<DiscordClient>({ user: { id: 'synthetic-bot' } }),
      async () => undefined,
      async () => '',
      runtime,
      undefined,
      undefined,
      undefined,
      { record: signal => diagnostics.push({ ...signal }), runtimeSequence: 92 },
    )
    const openTask = manager.joinChannel(
      createMock<ChatInputCommandInteraction>({ reply: vi.fn(async () => {}) }),
      fixture.channel,
    )
    await vi.waitFor(() => expect(first.events.listenerCount('open')).toBeGreaterThan(0))
    first.setReady(1)
    first.events.emit('open')
    first.events.emit('message', Buffer.from(JSON.stringify({ event_id: 'session-configured', type: 'session.updated' })))
    await openTask

    first.events.emit('error', new Error('https://transport.invalid/?token=secret'))
    first.events.emit('close', 1006, Buffer.from('network lost'))
    expect(fixture.connection.destroy).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(250)
    second.setReady(1)
    second.events.emit('open')
    second.events.emit('message', Buffer.from(JSON.stringify({ event_id: 'session-configured', type: 'session.updated' })))

    fixture.speaking.emit('start', fixture.userId)
    await vi.waitFor(() => expect(fixture.connection.receiver.subscribe).toHaveBeenCalledOnce())
    const packets = createOpusPcm16Fixture()
    for (let frame = 0; frame < 6; frame += 1)
      fixture.receiveStream.write(packets.nextSpeechPacket())
    await vi.waitFor(() => expect(second.sent.some(frame => JSON.parse(frame).type === 'input_audio_buffer.append')).toBe(true))
    second.events.emit('message', Buffer.from(JSON.stringify({
      event_id: 'current-input-committed',
      item_id: 'current-input',
      type: 'input_audio_buffer.committed',
    })))
    second.events.emit('message', Buffer.from(JSON.stringify({
      event_id: 'current-response-created',
      response: { id: 'current-response' },
      type: 'response.created',
    })))
    second.events.emit('message', Buffer.from(JSON.stringify({
      delta: Buffer.from([2, 3]).toString('base64'),
      event_id: 'current-response-audio-delta',
      response_id: 'current-response',
      type: 'response.audio.delta',
    })))
    first.events.emit('message', Buffer.from(JSON.stringify({ event_id: 'late-response-created', response: { id: 'late' }, type: 'response.created' })))
    first.events.emit('close', 1006, Buffer.from('late close'))

    expect(second.sent.some(frame => JSON.parse(frame).type === 'input_audio_buffer.append')).toBe(true)
    expect(diagnostics.filter(signal => signal.stage === 'provider-response-created')).toEqual([
      expect.objectContaining({ runtimeSequence: 92, turnSequence: 1 }),
    ])
    expect(diagnostics.filter(signal => signal.stage === 'provider-response-audio')).toEqual([
      expect.objectContaining({ runtimeSequence: 92, turnSequence: 1 }),
    ])
    expect(fixture.connection.subscribe).toHaveBeenCalledWith(player)
    expect(second.socket.close).not.toHaveBeenCalled()
    await manager.stop()
    expect(second.socket.close).toHaveBeenCalledOnce()
  })

  /**
   * @example
   * it('keeps resumed Discord captures in one pending provider aggregate', async () => {})
   */
  it('keeps resumed Discord captures in one pending provider aggregate for Discord audit P2-A/P3', async () => {
    vi.useFakeTimers()
    const socketEvents = new EventEmitter()
    const sentFrames: string[] = []
    let readyState = 0
    const socket = {
      get bufferedAmount() {
        return 0
      },
      get readyState() {
        return readyState
      },
      close: vi.fn((code = 1000, reason = 'closed') => {
        readyState = 3
        socketEvents.emit('close', code, Buffer.from(reason))
      }),
      off: socketEvents.off.bind(socketEvents),
      on: socketEvents.on.bind(socketEvents),
      send: vi.fn((data: string) => sentFrames.push(data)),
    }
    const runtime = new QwenRealtimeRuntime(resolveQwenRealtimeConfig({
      AIRI_DISCORD_VOICE_CALL_MODE: 'qwen-realtime',
      DASHSCOPE_API_KEY: 'synthetic-provider-key',
      QWEN_REALTIME_VAD_SILENCE_DURATION_MS: '200',
      QWEN_REALTIME_WORKSPACE_ID: 'synthetic-workspace',
    }), { socketFactory: () => socket })
    const projection = new StandaloneVoiceDiagnostics()
    const diagnostics: VoiceDiagnosticSignal[] = []
    projection.record({ mode: 'qwen-realtime', runtimeSequence: 9, sessionSequence: 1, stage: 'session-started' })
    const receiveStream = new PassThrough()
    const connection = createMock<VoiceConnection>({
      destroy: vi.fn(),
      receiver: {
        subscribe: vi.fn(() => receiveStream),
      },
      state: { status: 'ready' },
      subscribe: vi.fn(() => ({ unsubscribe: vi.fn() })),
    })
    const guild = { id: 'synthetic-guild', name: 'Synthetic Guild' }
    const member = createMock<GuildMember>({
      displayName: 'Synthetic Speaker',
      guild,
      id: 'synthetic-user',
      nickname: undefined,
      user: { bot: false },
      voice: { sessionId: 'synthetic-voice-session' },
    })
    const channel = createMock<BaseGuildVoiceChannel>({
      guild,
      id: 'synthetic-channel',
      members: new Map([[member.id, member]]),
    })
    const manager = new VoiceManager(
      createMock<DiscordClient>({ user: { id: 'synthetic-bot' } }),
      async () => undefined,
      async () => '',
      runtime,
      undefined,
      undefined,
      undefined,
      {
        record: (signal) => {
          diagnostics.push(signal)
          projection.record(signal)
        },
        runtimeSequence: 9,
      },
    )
    const scope = { channelId: channel.id, generation: 1, guildId: guild.id }
    const activeSession = {
      abortController: new AbortController(),
      channel,
      connection,
      currentDiagnosticTurnSequence: undefined,
      diagnosticCleaned: false,
      diagnosticSessionSequence: 1,
      nextDiagnosticTurnSequence: 0,
      pendingDiscordVoiceStateResetCount: 0,
      scope,
    }
    Reflect.get(manager, 'activeVoiceSessionsByGuildId').set(guild.id, activeSession)
    const openTask = Reflect.apply(Reflect.get(manager, 'openRealtimeSession'), manager, [connection, activeSession])
    readyState = 1
    socketEvents.emit('open')
    socketEvents.emit('message', Buffer.from(JSON.stringify({ event_id: 'session-configured', type: 'session.updated' })))
    await openTask

    const start = manager.handleAudioReceiveStreamStart(channel, scope)
    const end = manager.handleAudioReceiveStreamEnd(channel, scope)
    const packets = createOpusPcm16Fixture()
    await start(member.id)
    for (let index = 0; index < 16; index += 1)
      receiveStream.write(packets.nextSpeechPacket())
    await vi.waitFor(() => {
      expect(sentFrames.some(frame => JSON.parse(frame).type === 'input_audio_buffer.append')).toBe(true)
    })
    await end(member.id)

    await vi.advanceTimersByTimeAsync(199)
    const appendsBeforeResumedBoundary = sentFrames
      .map(frame => JSON.parse(frame))
      .filter(event => event.type === 'input_audio_buffer.append')
      .length
    await start(member.id)
    // A new Discord speaking boundary resumes the provider aggregate before
    // its local safety gate can admit PCM. It must still cancel the prior
    // finish debounce rather than inject owner silence and prematurely end the
    // aggregate while capture 2 is pending admission.
    await vi.advanceTimersByTimeAsync(2)
    expect(sentFrames
      .map(frame => JSON.parse(frame))
      .filter(event => event.type === 'input_audio_buffer.append')).toHaveLength(appendsBeforeResumedBoundary)
    for (let index = 0; index < 16; index += 1)
      receiveStream.write(packets.nextSpeechPacket())
    await end(member.id)
    await vi.advanceTimersByTimeAsync(200)

    socketEvents.emit('message', Buffer.from(JSON.stringify({
      event_id: 'provider-input-item-committed',
      item_id: 'provider-input-item',
      type: 'input_audio_buffer.committed',
    })))
    socketEvents.emit('message', Buffer.from(JSON.stringify({
      event_id: 'provider-response-created',
      response: { id: 'provider-response' },
      type: 'response.created',
    })))
    socketEvents.emit('message', Buffer.from(JSON.stringify({
      event_id: 'provider-response-done',
      response: { id: 'provider-response', status: 'completed' },
      type: 'response.done',
    })))

    // ROOT CAUSE:
    //
    // A Discord speaking boundary is a capture identity, whereas Qwen keeps
    // one pending provider buffer across a short resume. Collapsing the
    // snapshot to the provider owner hid capture 2; attributing every socket
    // increment to the owner hid its successful user audio.
    const sessionSnapshot = projection.getSnapshot().active[0]
    if (!sessionSnapshot)
      throw new Error('The resumed capture session must remain observable.')
    const turnsBySequence = new Map(sessionSnapshot.turns.map(turn => [turn.turnSequence, turn]))
    const owner = turnsBySequence.get(1)
    const resumedCapture = turnsBySequence.get(2)
    if (!owner || !resumedCapture)
      throw new Error('Both capture turns must remain in the bounded standalone snapshot.')

    expect(owner).toMatchObject({
      aggregateTurnSequence: 1,
      captureTurnSequences: [1, 2],
      inputCommits: 1,
      responsesCompleted: 1,
      responsesStarted: 1,
      turnSequence: 1,
    })
    expect(owner.userInputAppends).toBeGreaterThan(0)
    expect(owner.syntheticInputAppends).toBeGreaterThan(0)
    expect(resumedCapture).toMatchObject({
      localAdmissionStatus: 'admitted',
      syntheticInputAppends: 0,
      inputCommits: 0,
      responsesCompleted: 0,
      responsesStarted: 0,
      turnSequence: 2,
    })
    expect(resumedCapture.opusPackets).toBeGreaterThan(0)
    expect(resumedCapture.opusBytes).toBeGreaterThan(0)
    expect(resumedCapture.pcmFrames).toBeGreaterThan(0)
    expect(resumedCapture.pcmBytes).toBeGreaterThan(0)
    expect(resumedCapture.userInputAppends).toBeGreaterThan(0)

    const inputDiagnostics = diagnostics.filter(signal => signal.stage === 'provider-input-appended')
    const userInputSequences = inputDiagnostics
      .filter(signal => signal.inputKind === 'user-audio')
      .map(signal => signal.turnSequence)
    expect([...new Set(userInputSequences)].sort((left, right) => left - right)).toEqual([1, 2])
    expect(inputDiagnostics
      .filter(signal => signal.inputKind === 'synthetic-silence')
      .every(signal => signal.turnSequence === 1)).toBe(true)
    const terminalInputSnapshots = inputDiagnostics.reduce((snapshots, signal) => {
      const key = `${signal.turnSequence}:${signal.inputKind}`
      const previous = snapshots.get(key)
      snapshots.set(key, {
        bytes: Math.max(previous?.bytes ?? 0, signal.providerInputBytes),
        chunks: Math.max(previous?.chunks ?? 0, signal.providerInputChunks),
      })
      return snapshots
    }, new Map<string, { bytes: number, chunks: number }>())
    const appendEvents = sentFrames
      .map(frame => JSON.parse(frame) as { audio?: string, type?: string })
      .filter(event => event.type === 'input_audio_buffer.append')
    expect([...terminalInputSnapshots.values()].reduce((count, snapshot) => count + snapshot.chunks, 0)).toBe(appendEvents.length)
    expect([...terminalInputSnapshots.values()].reduce((bytes, snapshot) => bytes + snapshot.bytes, 0)).toBe(
      appendEvents.reduce((bytes, event) => bytes + Buffer.from(event.audio ?? '', 'base64').byteLength, 0),
    )
    expect(diagnostics.filter(signal => signal.stage === 'provider-input-committed' && signal.turnSequence === 1)).toHaveLength(1)
    expect(diagnostics.filter(signal => signal.stage === 'provider-response-created' && signal.turnSequence === 1)).toHaveLength(1)
    expect(diagnostics.filter(signal => signal.stage === 'provider-response-completed' && signal.turnSequence === 1)).toHaveLength(1)

    const snapshotBeforeLateCallbacks = projection.getSnapshot()
    socketEvents.emit('message', Buffer.from(JSON.stringify({
      // Deliberate replay: same provider item and server event instance.
      event_id: 'provider-input-item-committed',
      item_id: 'provider-input-item',
      type: 'input_audio_buffer.committed',
    })))
    socketEvents.emit('message', Buffer.from(JSON.stringify({
      event_id: 'unsolicited-provider-item-committed',
      item_id: 'unsolicited-provider-item',
      type: 'input_audio_buffer.committed',
    })))
    socketEvents.emit('message', Buffer.from(JSON.stringify({
      event_id: 'unsolicited-provider-response-created',
      response: { id: 'unsolicited-provider-response' },
      type: 'response.created',
    })))
    /** @example expect(projection.getSnapshot()).toEqual(snapshotBeforeLateCallbacks) */
    expect(projection.getSnapshot()).toEqual(snapshotBeforeLateCallbacks)

    await manager.stop()
    /** @example expect(Reflect.get(manager, 'realtimeSessions').size).toBe(0) */
    expect(Reflect.get(manager, 'realtimeSessions').size).toBe(0)
  })

  /**
   * @example
   * it('removes the exact voice listeners installed while joining', async () => {})
   */
  it('removes the exact voice listeners installed while joining', async () => {
    const stateChangeListener = vi.fn()
    const errorListener = vi.fn()
    const speakingStartListener = vi.fn()
    const speakingEndListener = vi.fn()
    const connection = {
      destroy: vi.fn(),
      on: vi.fn((event: string, listener: (...args: never[]) => void) => {
        if (event === 'stateChange')
          stateChangeListener.mockImplementation(listener)
        if (event === 'error')
          errorListener.mockImplementation(listener)
      }),
      off: vi.fn(),
      receiver: {
        speaking: {
          off: vi.fn(),
          on: vi.fn((event: string, listener: (...args: never[]) => void) => {
            if (event === 'start')
              speakingStartListener.mockImplementation(listener)
            if (event === 'end')
              speakingEndListener.mockImplementation(listener)
          }),
        },
      },
      state: { status: 'ready' },
    }
    voiceMocks.joinVoiceChannel.mockReturnValue(createMock<VoiceConnection>(connection))
    const manager = createManager()
    const channel = createMock<BaseGuildVoiceChannel>({
      guild: {
        id: 'guild-1',
        members: { me: undefined },
        voiceAdapterCreator: {},
      },
      guildId: 'guild-1',
      id: 'voice-1',
      name: 'Voice',
    })
    const interaction = createMock<ChatInputCommandInteraction>({ reply: vi.fn(async () => {}) })

    await manager.joinChannel(interaction, channel)
    manager.leaveChannel(channel)

    /** @example expect(connection.off).toHaveBeenCalledWith('stateChange', expect.any(Function)) */
    expect(connection.off).toHaveBeenCalledWith('stateChange', expect.any(Function))
    /** @example expect(connection.off).toHaveBeenCalledWith('error', expect.any(Function)) */
    expect(connection.off).toHaveBeenCalledWith('error', expect.any(Function))
    /** @example expect(connection.receiver.speaking.off).toHaveBeenCalledWith('start', expect.any(Function)) */
    expect(connection.receiver.speaking.off).toHaveBeenCalledWith('start', expect.any(Function))
    /** @example expect(connection.receiver.speaking.off).toHaveBeenCalledWith('end', expect.any(Function)) */
    expect(connection.receiver.speaking.off).toHaveBeenCalledWith('end', expect.any(Function))
    /** @example expect(connection.destroy).toHaveBeenCalledOnce() */
    expect(connection.destroy).toHaveBeenCalledOnce()
    /** @example expect(interaction.reply).toHaveBeenCalledWith(expect.stringContaining('transcribed')) */
    expect(interaction.reply).toHaveBeenCalledWith(expect.stringContaining('transcribed'))
  })

  /**
   * @example
   * it('debounces transcription independently for each Discord speaker', () => {})
   */
  it('debounces transcription independently for each Discord speaker', () => {
    vi.useFakeTimers()
    const manager = createManager()
    const abortController = new AbortController()
    const userStates = Reflect.get(manager, 'userStates')
    const createState = (userId: string) => ({
      abortSignal: abortController.signal,
      buffers: [],
      connection: {},
      lastActive: 0,
      scope: { channelId: 'voice-1', generation: 1, guildId: 'guild-1' },
      speaker: { displayName: 'Speaker', guildName: 'Guild' },
      totalLength: 0,
      transcriptionText: '',
      userId,
    })
    userStates.set('guild-1:voice-1:1:user-1', createState('user-1'))
    userStates.set('guild-1:voice-1:1:user-2', createState('user-2'))

    void manager.debouncedProcessTranscription('guild-1:voice-1:1:user-1')
    void manager.debouncedProcessTranscription('guild-1:voice-1:1:user-2')

    expect(vi.getTimerCount()).toBe(2)
  })

  /**
   * @example
   * it('reproduces Discord audit D-013 by isolating stale transcription work from a replacement generation', async () => {})
   */
  it('reproduces Discord audit D-013 by isolating stale transcription work from a replacement generation', async () => {
    vi.useFakeTimers()
    let releaseA1 = () => {}
    let releaseA2 = () => {}
    const a1Deferred = new Promise<void>((resolve) => {
      releaseA1 = resolve
    })
    const a2Deferred = new Promise<void>((resolve) => {
      releaseA2 = resolve
    })
    const manager = createManager()
    const processTranscription = vi.fn(async (_speakerKey: string, state: { scope: { generation: number } }) => {
      await (state.scope.generation === 1 ? a1Deferred : a2Deferred)
    })
    Reflect.set(manager, 'processTranscription', processTranscription)
    const handleUserStream = Reflect.get(manager, 'handleUserStream')
    const streamA1 = new PassThrough()
    const streamA2 = new PassThrough()
    const createInput = (generation: number, audioStream: PassThrough) => ({
      abortSignal: new AbortController().signal,
      audioStream,
      connection: {},
      scope: { channelId: 'voice-1', generation, guildId: 'guild-1' },
      speaker: { displayName: 'Synthetic speaker', guildName: 'Synthetic guild' },
      stopCapture: vi.fn(),
      userId: 'user-1',
    })

    await Reflect.apply(handleUserStream, manager, [createInput(1, streamA1)])
    const userStates = Reflect.get(manager, 'userStates')
    const [a1Key, a1State] = [...userStates.entries()]
      .find(([, state]) => state.scope.generation === 1)
    a1State.buffers.push(Buffer.from([1]))
    a1State.totalLength = 1
    await manager.debouncedProcessTranscription(a1Key)
    vi.advanceTimersByTime(1_500)
    await Promise.resolve()

    await Reflect.apply(handleUserStream, manager, [createInput(2, streamA2)])
    const [a2Key, a2State] = [...userStates.entries()]
      .find(([, state]) => state.scope.generation === 2)
    const a2Buffer = Buffer.from([2])
    a2State.buffers.push(a2Buffer)
    a2State.totalLength = a2Buffer.length

    // ROOT CAUSE:
    //
    // Speaker timers, processing gates, streams, and monitors were keyed only by
    // guild/channel/user. A replacement A2 generation therefore overwrote A1's
    // records while A1 transcription was still deferred. A2 then looked busy,
    // dropped its buffered turn, and A1's late finally deleted A2's processing gate.
    await manager.debouncedProcessTranscription(a2Key)

    expect(a2State.buffers).toEqual([a2Buffer])
    const a2Timeout = Reflect.get(manager, 'transcriptionTimeouts').get(a2Key)
    expect(a2Timeout).toBeDefined()
    streamA1.emit('speakingStarted')
    expect(Reflect.get(manager, 'transcriptionTimeouts').get(a2Key)).toBe(a2Timeout)
    expect([...Reflect.get(manager, 'activeMonitors').values()]
      .some(monitor => monitor.scope.generation === 2)).toBe(true)

    vi.advanceTimersByTime(1_500)
    await Promise.resolve()
    expect(processTranscription).toHaveBeenCalledWith(a2Key, a2State)
    expect(Reflect.get(manager, 'processingUsers').has(a2Key)).toBe(true)

    releaseA1()
    await Promise.resolve()
    await Promise.resolve()
    expect(Reflect.get(manager, 'processingUsers').has(a2Key)).toBe(true)

    releaseA2()
    await Promise.resolve()
    await Promise.resolve()
    manager.stop()
  })

  /**
   * @example
   * it('Discord audit D-013 keeps a replacement capture alive within the same generation', async () => {})
   */
  it('reproduces Discord audit D-013 by keeping a replacement capture alive within the same generation', async () => {
    vi.useFakeTimers()
    let releaseA1 = () => {}
    let releaseA2 = () => {}
    const a1Deferred = new Promise<void>((resolve) => {
      releaseA1 = resolve
    })
    const a2Deferred = new Promise<void>((resolve) => {
      releaseA2 = resolve
    })
    const manager = createManager()
    let a1State: object | undefined
    const processTranscription = vi.fn(async (_speakerKey: string, state: object) => {
      await (state === a1State ? a1Deferred : a2Deferred)
    })
    Reflect.set(manager, 'processTranscription', processTranscription)
    const handleUserStream = Reflect.get(manager, 'handleUserStream')
    const scope = { channelId: 'voice-1', generation: 1, guildId: 'guild-1' }
    const speakerKey = 'guild-1:voice-1:1:user-1'
    const streamA1 = new PassThrough()
    const streamA2 = new PassThrough()
    const abortA1 = new AbortController()
    const abortA2 = new AbortController()
    const createInput = (audioStream: PassThrough, abortController: AbortController) => ({
      abortSignal: abortController.signal,
      audioStream,
      connection: {},
      scope,
      speaker: { displayName: 'Synthetic speaker', guildName: 'Synthetic guild' },
      stopCapture: () => abortController.abort(new Error('Synthetic capture replacement.')),
      userId: 'user-1',
    })

    await Reflect.apply(handleUserStream, manager, [createInput(streamA1, abortA1)])
    a1State = Reflect.get(manager, 'userStates').get(speakerKey)
    if (!a1State)
      throw new Error('Expected the first synthetic voice capture state.')
    const staleSpeakingStarted = streamA1.listeners('speakingStarted')[0]
    if (typeof staleSpeakingStarted !== 'function')
      throw new Error('Expected the first synthetic AudioMonitor start callback.')
    Reflect.set(a1State, 'buffers', [Buffer.from([1])])
    Reflect.set(a1State, 'totalLength', 1)
    await manager.debouncedProcessTranscription(speakerKey)
    await vi.advanceTimersByTimeAsync(1_500)

    Reflect.apply(Reflect.get(manager, 'stopMonitoringMember'), manager, [{
      channelId: scope.channelId,
      guildId: scope.guildId,
      userId: 'user-1',
    }, scope.generation])
    await Reflect.apply(handleUserStream, manager, [createInput(streamA2, abortA2)])
    const a2State = Reflect.get(manager, 'userStates').get(speakerKey)
    if (!a2State)
      throw new Error('Expected the replacement synthetic voice capture state.')
    Reflect.set(a2State, 'buffers', [Buffer.from([2])])
    Reflect.set(a2State, 'totalLength', 1)
    await manager.debouncedProcessTranscription(speakerKey)
    const a2Timeout = Reflect.get(manager, 'transcriptionTimeouts').get(speakerKey)

    // ROOT CAUSE:
    //
    // Guild/channel/generation/user identifies a voice session speaker, but not a
    // concrete receiver capture. Withdrawal and re-consent can replace A1 with A2
    // inside the same generation. A1's retained AudioMonitor callback then cleared
    // A2's timer, and A1's deferred transcription finally deleted A2's processing gate.
    Reflect.apply(staleSpeakingStarted, streamA1, [])

    /**
     * @example
     * expect(transcriptionTimeouts.get(speakerKey)).toBe(a2Timeout)
     */
    expect(Reflect.get(manager, 'transcriptionTimeouts').get(speakerKey)).toBe(a2Timeout)

    await vi.advanceTimersByTimeAsync(1_500)
    /**
     * @example
     * expect(processingUsers.has(speakerKey)).toBe(true)
     */
    expect(Reflect.get(manager, 'processingUsers').has(speakerKey)).toBe(true)

    releaseA1()
    await Promise.resolve()
    await Promise.resolve()
    /**
     * @example
     * expect(processingUsers.has(speakerKey)).toBe(true)
     */
    expect(Reflect.get(manager, 'processingUsers').has(speakerKey)).toBe(true)

    releaseA2()
    await Promise.resolve()
    await Promise.resolve()
    manager.stop()
  })

  /**
   * @example
   * it('Discord audit D-013 ignores a superseded bot voice-state callback after same-channel rejoin', async () => {})
   */
  it('reproduces Discord audit D-013 by ignoring a superseded bot voice-state callback after same-channel rejoin', async () => {
    const manager = createManager()
    const connectionA2 = {
      destroy: vi.fn(),
      receiver: { speaking: { off: vi.fn() } },
      state: { status: 'ready' },
    }
    const channel = createMock<BaseGuildVoiceChannel>({
      guild: { id: 'guild-1' },
      id: 'voice-1',
    })
    const sessionA2 = {
      abortController: new AbortController(),
      channel,
      connection: connectionA2,
      discordVoiceSessionId: 'voice-session-a2',
      scope: { channelId: 'voice-1', generation: 2, guildId: 'guild-1' },
    }
    Reflect.get(manager, 'activeVoiceSessionsByGuildId').set('guild-1', sessionA2)

    // ROOT CAUSE:
    //
    // Rejoining the same channel installs A2 locally before Discord necessarily
    // returns A1's leave VOICE_STATE_UPDATE. Cleanup compared only guild/channel,
    // so A1's old voice session callback destroyed the current A2 generation.
    // The first capacity fallback repeated that bug because it bypassed the
    // normal pending-reset/session-id state machine entirely.
    const staleOldState = createMock<VoiceState>({
      channelId: 'voice-1',
      guild: { id: 'guild-1' },
      id: 'bot-user',
      sessionId: 'voice-session-a1',
    })
    const staleNewState = createMock<VoiceState>({
      channelId: null,
      guild: { id: 'guild-1' },
      id: 'bot-user',
      sessionId: null,
    })
    const capacityCleanupApplied = manager.abortVoiceStateUpdateAtCapacity(staleOldState, staleNewState)

    /**
     * @example
     * expect(capacityCleanupApplied).toBe(false)
     */
    expect(capacityCleanupApplied).toBe(false)
    await manager.handleVoiceStateUpdate(staleOldState, staleNewState)

    /**
     * @example
     * expect(connectionA2.destroy).not.toHaveBeenCalled()
     */
    expect(connectionA2.destroy).not.toHaveBeenCalled()
    /**
     * @example
     * expect(activeVoiceSessionsByGuildId.get('guild-1')).toBe(sessionA2)
     */
    expect(Reflect.get(manager, 'activeVoiceSessionsByGuildId').get('guild-1')).toBe(sessionA2)

    await manager.handleVoiceStateUpdate(
      createMock<VoiceState>({
        channelId: 'voice-1',
        guild: { id: 'guild-1' },
        id: 'bot-user',
        sessionId: 'voice-session-a2',
      }),
      createMock<VoiceState>({
        channelId: null,
        guild: { id: 'guild-1' },
        id: 'bot-user',
        sessionId: null,
      }),
    )

    /**
     * @example
     * expect(connectionA2.destroy).toHaveBeenCalledOnce()
     */
    expect(connectionA2.destroy).toHaveBeenCalledOnce()
    /**
     * @example
     * expect(activeVoiceSessionsByGuildId.has('guild-1')).toBe(false)
     */
    expect(Reflect.get(manager, 'activeVoiceSessionsByGuildId').has('guild-1')).toBe(false)
    manager.stop()
  })

  /**
   * @example
   * it('reconciles same-channel bot replacement at capacity for Discord audit D-013', async () => {})
   */
  it('reconciles same-channel bot replacement at capacity for Discord audit D-013', async () => {
    const manager = createManager()
    const connectionA2 = {
      destroy: vi.fn(),
      receiver: { speaking: { off: vi.fn() } },
      state: {
        networking: {
          state: {
            connectionOptions: { sessionId: 'voice-session-a2' },
          },
        },
        status: 'ready',
      },
    }
    const channel = createMock<BaseGuildVoiceChannel>({
      guild: { id: 'guild-1' },
      id: 'voice-1',
    })
    const sessionA2 = {
      abortController: new AbortController(),
      channel,
      connection: connectionA2,
      discordVoiceSessionId: 'voice-session-a1',
      pendingDiscordVoiceStateResetCount: 1,
      scope: { channelId: 'voice-1', generation: 2, guildId: 'guild-1' },
    }
    Reflect.get(manager, 'activeVoiceSessionsByGuildId').set('guild-1', sessionA2)
    const voiceState = (sessionId: string) => createMock<VoiceState>({
      channelId: 'voice-1',
      guild: { id: 'guild-1' },
      id: 'bot-user',
      sessionId,
    })

    // ROOT CAUSE:
    //
    // The first capacity fallback returned immediately when old/new channel ids
    // matched, so it never consumed the expected connection reset or installed
    // A2's immutable session id. A later real A2 leave was then misclassified as
    // stale and leaked the replacement runtime.
    const cleanupApplied = manager.abortVoiceStateUpdateAtCapacity(
      voiceState('voice-session-a1'),
      voiceState('voice-session-a2'),
    )

    /** @example expect(cleanupApplied).toBe(false) */
    expect(cleanupApplied).toBe(false)
    /** @example expect(sessionA2.pendingDiscordVoiceStateResetCount).toBe(0) */
    expect(sessionA2.pendingDiscordVoiceStateResetCount).toBe(0)
    /** @example expect(sessionA2.discordVoiceSessionId).toBe('voice-session-a2') */
    expect(sessionA2.discordVoiceSessionId).toBe('voice-session-a2')
    /** @example expect(connectionA2.destroy).not.toHaveBeenCalled() */
    expect(connectionA2.destroy).not.toHaveBeenCalled()
    await manager.stop()
  })

  /**
   * @example
   * it('coalesces multiple pending bot resets into the authoritative replacement for Discord audit D-013', async () => {})
   */
  it('coalesces multiple pending bot resets into the authoritative replacement for Discord audit D-013', async () => {
    const manager = createManager()
    const connectionA3 = {
      destroy: vi.fn(),
      receiver: { speaking: { off: vi.fn() } },
      state: {
        networking: {
          state: {
            connectionOptions: { sessionId: 'voice-session-a3' },
          },
        },
        status: 'ready',
      },
    }
    const channel = createMock<BaseGuildVoiceChannel>({
      guild: { id: 'guild-1' },
      id: 'voice-1',
    })
    const sessionA3 = {
      abortController: new AbortController(),
      channel,
      connection: connectionA3,
      diagnosticCleaned: false,
      diagnosticSessionSequence: 1,
      discordVoiceSessionId: 'voice-session-a1',
      nextDiagnosticTurnSequence: 0,
      pendingDiscordVoiceStateResetCount: 2,
      scope: { channelId: 'voice-1', generation: 3, guildId: 'guild-1' },
    }
    Reflect.get(manager, 'activeVoiceSessionsByGuildId').set('guild-1', sessionA3)
    const voiceState = (channelId: string | null, sessionId: string | null) => createMock<VoiceState>({
      channelId,
      guild: { id: 'guild-1' },
      id: 'bot-user',
      sessionId,
    })

    // ROOT CAUSE:
    //
    // Pending resets were decremented one event at a time even when Discord
    // coalesced A1 -> A2 -> A3 into one transition and the exact connection
    // already proved A3. The real A3 leave was then consumed as an old reset.
    const cleanupApplied = manager.abortVoiceStateUpdateAtCapacity(
      voiceState('voice-1', 'voice-session-a1'),
      voiceState('voice-1', 'voice-session-a3'),
    )

    /** @example expect(cleanupApplied).toBe(false) */
    expect(cleanupApplied).toBe(false)
    /** @example expect(sessionA3.pendingDiscordVoiceStateResetCount).toBe(0) */
    expect(sessionA3.pendingDiscordVoiceStateResetCount).toBe(0)
    /** @example expect(Reflect.get(sessionA3, 'discordVoiceSessionId')).toBe('voice-session-a3') */
    expect(Reflect.get(sessionA3, 'discordVoiceSessionId')).toBe('voice-session-a3')

    await manager.handleVoiceStateUpdate(
      voiceState('voice-1', 'voice-session-a3'),
      voiceState(null, null),
    )

    /** @example expect(connectionA3.destroy).toHaveBeenCalledOnce() */
    expect(connectionA3.destroy).toHaveBeenCalledOnce()
    /** @example expect(Reflect.get(manager, 'activeVoiceSessionsByGuildId').has('guild-1')).toBe(false) */
    expect(Reflect.get(manager, 'activeVoiceSessionsByGuildId').has('guild-1')).toBe(false)
    await manager.stop()
  })

  /**
   * @example
   * it('accepts a delayed authoritative connection identity after a coalesced bot replacement for Discord audit D-013', async () => {})
   */
  it('accepts a delayed authoritative connection identity after a coalesced bot replacement for Discord audit D-013', async () => {
    const manager = createManager()
    const signallingState = createMock<VoiceConnectionState>({ status: 'signalling' })
    const readyA3State = createMock<VoiceConnectionState>({
      networking: {
        state: {
          connectionOptions: { sessionId: 'voice-session-a3' },
        },
      },
      status: 'ready',
    })
    const connectionA3 = createMock<VoiceConnection>({
      destroy: vi.fn(),
      receiver: { speaking: { off: vi.fn() } },
      state: signallingState,
    })
    const channel = createMock<BaseGuildVoiceChannel>({
      guild: { id: 'guild-1' },
      id: 'voice-1',
    })
    const sessionA3 = {
      abortController: new AbortController(),
      channel,
      connection: connectionA3,
      diagnosticCleaned: false,
      diagnosticSessionSequence: 1,
      nextDiagnosticTurnSequence: 0,
      discordVoiceSessionId: 'voice-session-a1',
      pendingDiscordVoiceStateResetCount: 2,
      scope: { channelId: 'voice-1', generation: 3, guildId: 'guild-1' },
    }
    Reflect.get(manager, 'activeVoiceSessionsByGuildId').set('guild-1', sessionA3)
    const voiceState = (channelId: string | null, sessionId: string | null) => createMock<VoiceState>({
      channelId,
      guild: { id: 'guild-1' },
      id: 'bot-user',
      sessionId,
    })

    // ROOT CAUSE:
    //
    // A coalesced A1 -> A3 VoiceState can arrive while the replacement
    // VoiceConnection is still Signalling and cannot yet prove its session id.
    // The callback reduced two pending resets to one, but the later authoritative
    // Ready state was ignored while that count was non-zero. A real A3 leave was
    // then consumed as the last stale reset and leaked the active generation.
    const cleanupApplied = manager.abortVoiceStateUpdateAtCapacity(
      voiceState('voice-1', 'voice-session-a1'),
      voiceState('voice-1', 'voice-session-a3'),
    )

    /** @example expect(cleanupApplied).toBe(false) */
    expect(cleanupApplied).toBe(false)
    /** @example expect(sessionA3.pendingDiscordVoiceStateResetCount).toBe(1) */
    expect(sessionA3.pendingDiscordVoiceStateResetCount).toBe(1)
    /** @example expect(Reflect.get(sessionA3, 'pendingDiscordVoiceSessionId')).toBe('voice-session-a3') */
    expect(Reflect.get(sessionA3, 'pendingDiscordVoiceSessionId')).toBe('voice-session-a3')
    /** @example expect(sessionA3.discordVoiceSessionId).toBe('voice-session-a1') */
    expect(sessionA3.discordVoiceSessionId).toBe('voice-session-a1')

    Reflect.set(connectionA3, 'state', readyA3State)
    await manager.handleVoiceConnectionStateChange(channel, connectionA3, sessionA3)(
      signallingState,
      readyA3State,
    )

    /** @example expect(sessionA3.pendingDiscordVoiceStateResetCount).toBe(0) */
    expect(sessionA3.pendingDiscordVoiceStateResetCount).toBe(0)
    /** @example expect(Reflect.get(sessionA3, 'pendingDiscordVoiceSessionId')).toBeUndefined() */
    expect(Reflect.get(sessionA3, 'pendingDiscordVoiceSessionId')).toBeUndefined()
    /** @example expect(sessionA3.discordVoiceSessionId).toBe('voice-session-a3') */
    expect(sessionA3.discordVoiceSessionId).toBe('voice-session-a3')

    await manager.handleVoiceStateUpdate(
      voiceState('voice-1', 'voice-session-a3'),
      voiceState(null, null),
    )

    /** @example expect(connectionA3.destroy).toHaveBeenCalledOnce() */
    expect(connectionA3.destroy).toHaveBeenCalledOnce()
    /** @example expect(Reflect.get(manager, 'activeVoiceSessionsByGuildId').has('guild-1')).toBe(false) */
    expect(Reflect.get(manager, 'activeVoiceSessionsByGuildId').has('guild-1')).toBe(false)
    await manager.stop()
  })

  /**
   * @example
   * it('accepts a delayed authoritative connection identity after split bot reset and join events for Discord audit D-013', async () => {})
   */
  it('accepts a delayed authoritative connection identity after split bot reset and join events for Discord audit D-013', async () => {
    const manager = createManager()
    const signallingState = createMock<VoiceConnectionState>({ status: 'signalling' })
    const readyA3State = createMock<VoiceConnectionState>({
      networking: {
        state: {
          connectionOptions: { sessionId: 'voice-session-a3' },
        },
      },
      status: 'ready',
    })
    const connectionA3 = createMock<VoiceConnection>({
      destroy: vi.fn(),
      receiver: { speaking: { off: vi.fn() } },
      state: signallingState,
    })
    const channel = createMock<BaseGuildVoiceChannel>({
      guild: { id: 'guild-1' },
      id: 'voice-1',
    })
    const sessionA3 = {
      abortController: new AbortController(),
      channel,
      connection: connectionA3,
      diagnosticCleaned: false,
      diagnosticSessionSequence: 1,
      nextDiagnosticTurnSequence: 0,
      pendingDiscordVoiceStateResetCount: 2,
      scope: { channelId: 'voice-1', generation: 3, guildId: 'guild-1' },
    }
    Reflect.get(manager, 'activeVoiceSessionsByGuildId').set('guild-1', sessionA3)
    const voiceState = (channelId: string | null, sessionId: string | null) => createMock<VoiceState>({
      channelId,
      guild: { id: 'guild-1' },
      id: 'bot-user',
      sessionId,
    })

    // ROOT CAUSE:
    //
    // Discord may preserve the reset and replacement join as separate packets
    // while still coalescing away an intermediate A2 identity. A1 -> null reduced
    // two pending resets to one, but null -> A3 was ignored because only an
    // old-channel identity change recorded the pending replacement. The exact
    // A3 connection could then never reconcile the remaining synthetic reset.
    await manager.handleVoiceStateUpdate(
      voiceState('voice-1', 'voice-session-a1'),
      voiceState(null, null),
    )
    await manager.handleVoiceStateUpdate(
      voiceState(null, null),
      voiceState('voice-1', 'voice-session-a3'),
    )

    /** @example expect(sessionA3.pendingDiscordVoiceStateResetCount).toBe(1) */
    expect(sessionA3.pendingDiscordVoiceStateResetCount).toBe(1)
    /** @example expect(Reflect.get(sessionA3, 'pendingDiscordVoiceSessionId')).toBe('voice-session-a3') */
    expect(Reflect.get(sessionA3, 'pendingDiscordVoiceSessionId')).toBe('voice-session-a3')

    Reflect.set(connectionA3, 'state', readyA3State)
    await manager.handleVoiceConnectionStateChange(channel, connectionA3, sessionA3)(
      signallingState,
      readyA3State,
    )

    /** @example expect(sessionA3.pendingDiscordVoiceStateResetCount).toBe(0) */
    expect(sessionA3.pendingDiscordVoiceStateResetCount).toBe(0)
    /** @example expect(Reflect.get(sessionA3, 'discordVoiceSessionId')).toBe('voice-session-a3') */
    expect(Reflect.get(sessionA3, 'discordVoiceSessionId')).toBe('voice-session-a3')

    await manager.handleVoiceStateUpdate(
      voiceState('voice-1', 'voice-session-a3'),
      voiceState(null, null),
    )

    /** @example expect(connectionA3.destroy).toHaveBeenCalledOnce() */
    expect(connectionA3.destroy).toHaveBeenCalledOnce()
    /** @example expect(Reflect.get(manager, 'activeVoiceSessionsByGuildId').has('guild-1')).toBe(false) */
    expect(Reflect.get(manager, 'activeVoiceSessionsByGuildId').has('guild-1')).toBe(false)
    await manager.stop()
  })

  /**
   * @example
   * it('rejects a stale bot join while the current connection identity is temporarily unavailable for Discord audit D-013', async () => {})
   */
  it('rejects a stale bot join while the current connection identity is temporarily unavailable for Discord audit D-013', async () => {
    const manager = createManager()
    const connectionA2 = {
      destroy: vi.fn(),
      receiver: { speaking: { off: vi.fn() } },
      state: { status: 'signalling' },
    }
    const channel = createMock<BaseGuildVoiceChannel>({
      guild: { id: 'guild-1' },
      id: 'voice-1',
    })
    const sessionA2 = {
      abortController: new AbortController(),
      channel,
      connection: connectionA2,
      discordVoiceSessionId: 'voice-session-a2',
      pendingDiscordVoiceStateResetCount: 0,
      scope: { channelId: 'voice-1', generation: 2, guildId: 'guild-1' },
    }
    Reflect.get(manager, 'activeVoiceSessionsByGuildId').set('guild-1', sessionA2)
    const voiceState = (channelId: string | null, sessionId: string | null) => createMock<VoiceState>({
      channelId,
      guild: { id: 'guild-1' },
      id: 'bot-user',
      sessionId,
    })

    // ROOT CAUSE:
    //
    // When the replacement connection was temporarily Signalling, any delayed
    // join targeting the same channel overwrote the already-known A2 session id.
    // A later real A2 leave was then rejected as stale and leaked the runtime.
    await manager.handleVoiceStateUpdate(
      voiceState(null, 'voice-session-a1'),
      voiceState('voice-1', 'voice-session-a1'),
    )

    /** @example expect(sessionA2.discordVoiceSessionId).toBe('voice-session-a2') */
    expect(sessionA2.discordVoiceSessionId).toBe('voice-session-a2')

    await manager.handleVoiceStateUpdate(
      voiceState('voice-1', 'voice-session-a2'),
      voiceState(null, null),
    )

    /** @example expect(connectionA2.destroy).toHaveBeenCalledOnce() */
    expect(connectionA2.destroy).toHaveBeenCalledOnce()
    /** @example expect(Reflect.get(manager, 'activeVoiceSessionsByGuildId').has('guild-1')).toBe(false) */
    expect(Reflect.get(manager, 'activeVoiceSessionsByGuildId').has('guild-1')).toBe(false)
    await manager.stop()
  })

  /**
   * @example
   * it('Discord audit D-013 binds bot voice-state cleanup to the owning connection identity', async () => {})
   */
  it('reproduces Discord audit D-013 by rejecting delayed bot voice-state identity before the replacement connection is identified', async () => {
    const manager = createManager()
    const createConnection = () => ({
      destroy: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
      receiver: { speaking: { on: vi.fn(), off: vi.fn() } },
      state: { status: 'signalling' },
    })
    const connectionA1 = createConnection()
    const connectionA2 = createConnection()
    const channel = createMock<BaseGuildVoiceChannel>({
      guild: {
        id: 'guild-1',
        members: { me: undefined },
        voiceAdapterCreator: {},
      },
      guildId: 'guild-1',
      id: 'voice-1',
      name: 'voice-1',
    })
    const interaction = createMock<ChatInputCommandInteraction>({ reply: vi.fn(async () => {}) })
    voiceMocks.joinVoiceChannel.mockReturnValueOnce(createMock<VoiceConnection>(connectionA1)).mockReturnValueOnce(createMock<VoiceConnection>(connectionA2))
    await manager.joinChannel(interaction, channel)
    await manager.joinChannel(interaction, channel)
    const sessionA2 = Reflect.get(manager, 'activeVoiceSessionsByGuildId').get('guild-1')
    if (!sessionA2)
      throw new Error('Expected replacement voice generation A2.')

    const voiceState = (channelId: string | null, sessionId: string | null) => createMock<VoiceState>({
      channelId,
      guild: { id: 'guild-1' },
      id: 'bot-user',
      sessionId,
    })

    // ROOT CAUSE:
    //
    // joinChannel can settle while @discordjs/voice is still Signalling, before
    // A1's Discord session id reaches either the active session or member cache.
    // If A2 replaces A1 at that point, delayed A1 join was assigned to A2 solely
    // because the channel matched; delayed A1 leave then destroyed A2.
    // discord.js forwards the gateway packet to the current voice adapter before
    // emitting voiceStateUpdate, so A2's connection can temporarily expose A1 too.
    Reflect.set(connectionA2, 'state', {
      networking: {
        state: {
          connectionOptions: { sessionId: 'voice-session-a1' },
        },
      },
      status: 'ready',
    })
    await manager.handleVoiceStateUpdate(
      voiceState(null, 'voice-session-a1'),
      voiceState('voice-1', 'voice-session-a1'),
    )
    await manager.handleVoiceStateUpdate(
      voiceState('voice-1', 'voice-session-a1'),
      voiceState(null, null),
    )

    /**
     * @example
     * expect(connectionA2.destroy).not.toHaveBeenCalled()
     */
    expect(connectionA2.destroy).not.toHaveBeenCalled()
    /**
     * @example
     * expect(activeVoiceSessionsByGuildId.get('guild-1')).toBe(sessionA2)
     */
    expect(Reflect.get(manager, 'activeVoiceSessionsByGuildId').get('guild-1')).toBe(sessionA2)

    // @discordjs/voice exposes the session id from the networking state owned by
    // this exact VoiceConnection after it receives A2's gateway state packet.
    Reflect.set(connectionA2, 'state', {
      networking: {
        state: {
          connectionOptions: { sessionId: 'voice-session-a2' },
        },
      },
      status: 'ready',
    })
    await manager.handleVoiceStateUpdate(
      voiceState(null, 'voice-session-a2'),
      voiceState('voice-1', 'voice-session-a2'),
    )
    await manager.handleVoiceStateUpdate(
      voiceState('voice-1', 'voice-session-a2'),
      voiceState(null, null),
    )

    /**
     * @example
     * expect(connectionA2.destroy).toHaveBeenCalledOnce()
     */
    expect(connectionA2.destroy).toHaveBeenCalledOnce()
    /**
     * @example
     * expect(activeVoiceSessionsByGuildId.has('guild-1')).toBe(false)
     */
    expect(Reflect.get(manager, 'activeVoiceSessionsByGuildId').has('guild-1')).toBe(false)
    manager.stop()
  })

  /**
   * @example
   * it('Discord audit D-013 recognizes a coalesced bot move as the replacement voice identity', async () => {})
   */
  it('reproduces Discord audit D-013 by recognizing a coalesced bot move as the replacement voice identity', async () => {
    const manager = createManager()
    const connection = {
      destroy: vi.fn(),
      receiver: { speaking: { off: vi.fn() } },
      state: { status: 'ready' },
    }
    const channel = createMock<BaseGuildVoiceChannel>({
      guild: { id: 'guild-1' },
      id: 'voice-b',
    })
    const session = {
      abortController: new AbortController(),
      channel,
      connection,
      pendingDiscordVoiceStateResetCount: 1,
      scope: { channelId: 'voice-b', generation: 2, guildId: 'guild-1' },
    }
    Reflect.get(manager, 'activeVoiceSessionsByGuildId').set('guild-1', session)
    const voiceState = (channelId: string | null, sessionId: string | null) => createMock<VoiceState>({
      channelId,
      guild: { id: 'guild-1' },
      id: 'bot-user',
      sessionId,
    })

    // ROOT CAUSE:
    //
    // Rapid replacement can surface as one direct old-channel -> new-channel
    // VoiceStateUpdate instead of an old-channel -> null reset followed by a join.
    // The pending-reset counter advanced only for `newState.channelId === null`,
    // so it ignored the replacement identity and later consumed B's real leave as
    // A's pending reset. B then retained its connection and all scoped voice state.
    await manager.handleVoiceStateUpdate(
      voiceState('voice-a', 'voice-session-a'),
      voiceState('voice-b', 'voice-session-b'),
    )

    /**
     * @example
     * expect(session.discordVoiceSessionId).toBe('voice-session-b')
     */
    expect(Reflect.get(session, 'discordVoiceSessionId')).toBe('voice-session-b')
    /**
     * @example
     * expect(session.pendingDiscordVoiceStateResetCount).toBe(0)
     */
    expect(session.pendingDiscordVoiceStateResetCount).toBe(0)

    await manager.handleVoiceStateUpdate(
      voiceState('voice-b', 'voice-session-b'),
      voiceState(null, null),
    )

    /**
     * @example
     * expect(connection.destroy).toHaveBeenCalledOnce()
     */
    expect(connection.destroy).toHaveBeenCalledOnce()
    /**
     * @example
     * expect(activeVoiceSessionsByGuildId.has('guild-1')).toBe(false)
     */
    expect(Reflect.get(manager, 'activeVoiceSessionsByGuildId').has('guild-1')).toBe(false)
    manager.stop()
  })

  /**
   * @example
   * it('rejects summon outside a cached guild before reading member voice state', async () => {})
   */
  it('rejects summon outside a cached guild before reading member voice state', async () => {
    const manager = createManager()
    const interaction = createMock<ChatInputCommandInteraction>({
      inCachedGuild: () => false,
      reply: vi.fn(async () => {}),
    })

    await manager.handleJoinChannelCommand(interaction)

    expect(interaction.reply).toHaveBeenCalledWith('This command can only be used in a server voice channel.')
    expect(voiceMocks.joinVoiceChannel).not.toHaveBeenCalled()
  })

  /**
   * @example
   * it('rejects summon before deferring when the member is not in voice', async () => {})
   */
  it('rejects summon before deferring when the member is not in voice', async () => {
    const manager = createManager()
    const deferReply = vi.fn(async () => {})
    const reply = vi.fn(async () => {})
    const interaction = createMock<ChatInputCommandInteraction>({
      deferReply,
      inCachedGuild: () => true,
      member: { voice: { channel: undefined } },
      reply,
    })

    await manager.handleJoinChannelCommand(interaction)

    expect(reply).toHaveBeenCalledWith('Please join a voice channel first.')
    expect(deferReply).not.toHaveBeenCalled()
    expect(voiceMocks.joinVoiceChannel).not.toHaveBeenCalled()
  })

  /**
   * @example
   * it('Discord audit D-007 publishes consent before joining or starting a provider', async () => {})
   */
  it('reproduces Discord audit D-007 by publishing consent before joining or starting a provider', async () => {
    let noticePublished = false
    const joinedBeforeNotice: boolean[] = []
    const connection = {
      destroy: vi.fn(),
      on: vi.fn(),
      receiver: {
        speaking: {
          on: vi.fn(),
        },
      },
      state: { status: 'ready' },
    }
    voiceMocks.joinVoiceChannel.mockImplementation(() => {
      joinedBeforeNotice.push(!noticePublished)
      return createMock<VoiceConnection>(connection)
    })
    const manager = new VoiceManager(
      createMock<DiscordClient>({ user: { id: 'bot-user' } }),
      async () => undefined,
      async () => '',
      undefined,
      undefined,
      {
        model: 'the AIRI model provider',
        stt: 'OpenAI at api.openai.com',
        tts: 'OpenAI at api.openai.com',
      },
    )
    const channel = createMock<BaseGuildVoiceChannel>({
      guild: {
        id: 'guild-1',
        members: {
          me: undefined,
        },
        voiceAdapterCreator: {},
      },
      guildId: 'guild-1',
      id: 'voice-1',
      members: new Map([
        ['user-1', { id: 'user-1', user: { bot: false } }],
        ['user-2', { id: 'user-2', user: { bot: false } }],
      ]),
      name: 'Voice',
    })
    let deferred = false
    const deferReply = vi.fn(async () => {
      deferred = true
    })
    const reply = vi.fn(async () => {
      noticePublished = true
    })
    const interaction = createMock<ChatInputCommandInteraction>({
      deferReply,
      get deferred() {
        return deferred
      },
      editReply: vi.fn(async () => {}),
      id: '1',
      inCachedGuild: () => true,
      member: { voice: { channel } },
      reply,
    })

    // ROOT CAUSE:
    //
    // `/summon` currently joins Discord and opens the selected voice provider
    // before publishing any provider disclosure or collecting participant
    // consent. Deferring the command is only an acknowledgement; it is not a
    // public, session-scoped opt-in decision from each voice participant.
    await manager.handleJoinChannelCommand(interaction)

    expect(reply).toHaveBeenCalledWith(expect.objectContaining({
      allowedMentions: { parse: [] },
      components: expect.any(Array),
      content: expect.stringMatching(/OpenAI at api\.openai\.com.*AIRI model provider.*OpenAI at api\.openai\.com.*opt.?in/is),
    }))
    expect(joinedBeforeNotice).toEqual([])
    expect(deferReply).not.toHaveBeenCalled()
  })

  /**
   * @example
   * it('Discord audit D-007 discloses the Qwen audio path before joining', async () => {})
   */
  it('reproduces Discord audit D-007 by disclosing the Qwen audio path before joining', async () => {
    const realtimeRuntime = {
      connect: vi.fn(),
      getInterruptionRmsThreshold: vi.fn(() => 100),
      getMode: vi.fn(() => 'qwen-realtime' as const),
      isConfigured: vi.fn(() => true),
    }
    const manager = new VoiceManager(
      createMock<DiscordClient>({ user: { id: 'bot-user' } }),
      async () => undefined,
      async () => '',
      realtimeRuntime,
    )
    const channel = createMock<BaseGuildVoiceChannel>({
      guild: {
        id: 'guild-1',
        members: { me: undefined },
        voiceAdapterCreator: {},
      },
      guildId: 'guild-1',
      id: 'voice-1',
      members: new Map([['user-1', { id: 'user-1', user: { bot: false } }]]),
      name: 'Voice',
    })
    const reply = vi.fn(async () => {})
    const interaction = createMock<ChatInputCommandInteraction>({
      id: '1',
      inCachedGuild: () => true,
      member: { voice: { channel } },
      reply,
    })

    await manager.handleJoinChannelCommand(interaction)

    expect(reply).toHaveBeenCalledWith(expect.objectContaining({
      allowedMentions: { parse: [] },
      content: expect.stringMatching(/raw audio.*Alibaba Cloud DashScope.*provider-side voice activity detection.*opt.?in/is),
    }))
    expect(voiceMocks.joinVoiceChannel).not.toHaveBeenCalled()
    expect(realtimeRuntime.connect).not.toHaveBeenCalled()
  })

  /**
   * @example
   * it('rejects a consent button from a pre-restart disclosure session', async () => {})
   */
  it('rejects a consent button from a pre-restart disclosure session (Discord audit D-007)', async () => {
    const channel = createMock<BaseGuildVoiceChannel>({
      guild: {
        id: 'guild-1',
        members: { me: undefined },
        voiceAdapterCreator: {},
      },
      guildId: 'guild-1',
      id: 'voice-1',
      members: new Map([['user-1', { id: 'user-1', user: { bot: false } }]]),
      name: 'Voice',
    })
    const createSlashInteraction = (id: string) => createMock<ChatInputCommandInteraction>({
      editReply: vi.fn(async () => {}),
      id,
      inCachedGuild: () => true,
      member: { voice: { channel } },
      reply: vi.fn(async () => {}),
    })
    const managerBeforeRestart = createManager()
    await managerBeforeRestart.handleJoinChannelCommand(createSlashInteraction('old-summon'))
    const oldConsentSessionId = Reflect.get(managerBeforeRestart, 'consentSessionIdByGuildId').get('guild-1')

    const managerAfterRestart = createManager()
    await managerAfterRestart.handleJoinChannelCommand(createSlashInteraction('new-summon'))
    const newConsentSessionId = Reflect.get(managerAfterRestart, 'consentSessionIdByGuildId').get('guild-1')
    const reply = vi.fn(async () => {})
    const update = vi.fn(async () => {})

    // ROOT CAUSE:
    //
    // The prior process-local counter restarted at one, so a stale Discord
    // consent message reused the exact custom id of the first new `/summon`.
    // Clicking the stale button could authorize a differently disclosed session.
    await managerAfterRestart.handleConsentInteraction(createMock<ButtonInteraction>({
      customId: `airi:voice-consent:opt-in:${oldConsentSessionId}`,
      guildId: 'guild-1',
      inCachedGuild: () => true,
      member: { voice: { channelId: 'voice-1', sessionId: 'participant-session-user-1' } },
      reply,
      update,
      user: { id: 'user-1' },
    }))

    /** @example expect(oldConsentSessionId).not.toBe(newConsentSessionId) */
    expect(oldConsentSessionId).not.toBe(newConsentSessionId)
    /** @example expect(reply).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true })) */
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }))
    /** @example expect(update).not.toHaveBeenCalled() */
    expect(update).not.toHaveBeenCalled()
    /** @example expect(voiceMocks.joinVoiceChannel).not.toHaveBeenCalled() */
    expect(voiceMocks.joinVoiceChannel).not.toHaveBeenCalled()
  })

  /**
   * @example
   * it('Discord audit D-007 rejects a classic speaker before receiver subscription', async () => {})
   */
  it('reproduces Discord audit D-007 by rejecting a classic speaker before receiver subscription', async () => {
    const receiveStream = new PassThrough()
    const connection = {
      destroy: vi.fn(),
      joinConfig: { guildId: 'guild-1' },
      receiver: {
        subscribe: vi.fn(() => receiveStream),
      },
      state: { status: 'ready' },
    }
    voiceMocks.getVoiceConnections.mockReturnValue(createMock<Map<string, VoiceConnection>>(new Map([['guild-1', connection]])))
    const allowsSpeaker = vi.fn(() => false)
    const manager = new VoiceManager(
      createMock<DiscordClient>({ user: { id: 'bot-user' } }),
      async () => undefined,
      async () => '',
      undefined,
      {
        admit: () => false,
        allows: allowsSpeaker,
      },
    )
    const member = createMock<GuildMember>({
      displayName: 'Unconsented speaker',
      guild: { id: 'guild-1' },
      id: 'user-1',
      user: { bot: false },
    })
    const handler = manager.handleAudioReceiveStreamStart(createMock<BaseGuildVoiceChannel>({
      id: 'voice-1',
      members: new Map([['user-1', member]]),
    }))

    // ROOT CAUSE:
    //
    // The existing pre-subscribe access callback is consulted only for Qwen
    // Realtime. Classic STT subscribes first and evaluates policy only after
    // audio has already been captured and transcribed by the provider.
    await handler('user-1')
    const accessCallCount = allowsSpeaker.mock.calls.length
    const subscriptionCallCount = connection.receiver.subscribe.mock.calls.length
    manager.stop()

    expect(accessCallCount).toBe(1)
    expect(subscriptionCallCount).toBe(0)
  })

  /**
   * @example
   * it('Discord audit D-007 consumes rate admission before every captured speaking turn', async () => {})
   */
  it('reproduces Discord audit D-007 by consuming rate admission before every captured speaking turn', async () => {
    const receiveStream = new PassThrough()
    const destroyReceiveStream = vi.spyOn(receiveStream, 'destroy')
    const connection = {
      destroy: vi.fn(),
      joinConfig: { guildId: 'guild-1' },
      receiver: {
        subscribe: vi.fn(() => receiveStream),
      },
      state: { status: 'ready' },
    }
    voiceMocks.getVoiceConnections.mockReturnValue(createMock<Map<string, VoiceConnection>>(new Map([['guild-1', connection]])))
    const admitSpeaker = vi.fn()
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false)
    const manager = new VoiceManager(
      createMock<DiscordClient>({ user: { id: 'bot-user' } }),
      async () => undefined,
      async () => '',
      undefined,
      {
        admit: admitSpeaker,
        allows: () => true,
      },
    )
    const member = createMock<GuildMember>({
      displayName: 'Rate-limited speaker',
      guild: { id: 'guild-1' },
      id: 'user-1',
      user: { bot: false },
    })
    const channel = createMock<BaseGuildVoiceChannel>({
      guild: { id: 'guild-1' },
      id: 'voice-1',
      members: new Map([['user-1', member]]),
    })
    const handler = manager.handleAudioReceiveStreamStart(channel)

    // ROOT CAUSE:
    //
    // Voice access used to check only blocked guild/user/channel policy before
    // receiver subscription. Standalone consumed its rate quota only after STT,
    // while Qwen never consumed a voice-turn quota at all. A persistent receive
    // stream therefore kept exporting later turns after the rate limit was full.
    await handler('user-1')
    await manager.handleAudioReceiveStreamEnd(channel)('user-1')
    await handler('user-1')

    /** @example expect(admitSpeaker).toHaveBeenCalledTimes(2) */
    expect(admitSpeaker).toHaveBeenCalledTimes(2)
    /** @example expect(connection.receiver.subscribe).toHaveBeenCalledOnce() */
    expect(connection.receiver.subscribe).toHaveBeenCalledOnce()
    /** @example expect(destroyReceiveStream).toHaveBeenCalledOnce() */
    expect(destroyReceiveStream).toHaveBeenCalledOnce()
    manager.stop()
  })

  /**
   * @example
   * it('Discord audit D-012 charges one voice input once when Discord repeats speaking-start', async () => {})
   */
  it('reproduces Discord audit D-012 by charging one voice input once when Discord repeats speaking-start', async () => {
    const receiveStream = new PassThrough()
    const connection = {
      destroy: vi.fn(),
      joinConfig: { guildId: 'guild-1' },
      receiver: {
        subscribe: vi.fn(() => receiveStream),
      },
      state: { status: 'ready' },
    }
    voiceMocks.getVoiceConnections.mockReturnValue(createMock<Map<string, VoiceConnection>>(new Map([['guild-1', connection]])))
    const admitSpeaker = vi.fn(() => true)
    const allowsSpeaker = vi.fn(() => true)
    const manager = new VoiceManager(
      createMock<DiscordClient>({ user: { id: 'bot-user' } }),
      async () => undefined,
      async () => '',
      undefined,
      {
        admit: admitSpeaker,
        allows: allowsSpeaker,
      },
    )
    const member = createMock<GuildMember>({
      displayName: 'Synthetic speaker',
      guild: { id: 'guild-1' },
      id: 'user-1',
      user: { bot: false },
    })
    const handler = manager.handleAudioReceiveStreamStart(createMock<BaseGuildVoiceChannel>({
      id: 'voice-1',
      members: new Map([['user-1', member]]),
    }))

    // ROOT CAUSE:
    //
    // The speaking-start callback consumed rate admission before checking whether
    // the exact scoped receiver was already admitted for the same active utterance.
    // Duplicate Discord start notifications therefore charged one voice input twice.
    await handler('user-1')
    await handler('user-1')

    /**
     * @example
     * expect(allowsSpeaker).toHaveBeenCalledTimes(2)
     */
    expect(allowsSpeaker).toHaveBeenCalledTimes(2)
    /**
     * @example
     * expect(admitSpeaker).toHaveBeenCalledOnce()
     */
    expect(admitSpeaker).toHaveBeenCalledOnce()
    /**
     * @example
     * expect(connection.receiver.subscribe).toHaveBeenCalledOnce()
     */
    expect(connection.receiver.subscribe).toHaveBeenCalledOnce()
    manager.stop()
  })

  /**
   * @example
   * it('Discord audit D-004 revokes active voice capture after a runtime allowlist change', () => {})
   */
  it('reproduces Discord audit D-004 by revoking active voice capture after a runtime allowlist change', () => {
    const stop = vi.fn()
    const manager = new VoiceManager(
      createMock<DiscordClient>({ user: { id: 'bot-user' } }),
      async () => undefined,
      async () => '',
      undefined,
      {
        admit: () => true,
        allows: () => false,
      },
    )
    Reflect.get(manager, 'activeMonitors').set('guild-1:voice-1:1:user-1', {
      admitted: true,
      scope: { channelId: 'voice-1', generation: 1, guildId: 'guild-1' },
      stop,
      userId: 'user-1',
    })

    // ROOT CAUSE:
    //
    // Updating bridge policy replaced the allowlist but never revisited receive
    // streams that had already subscribed. Their raw Qwen/classic audio remained
    // active until a later Discord disconnect or explicit dismiss.
    manager.revalidateSpeakerAdmissions()

    /** @example expect(stop).toHaveBeenCalledOnce() */
    expect(stop).toHaveBeenCalledOnce()
    /** @example expect(Reflect.get(manager, 'activeMonitors').has('guild-1:voice-1:1:user-1')).toBe(false) */
    expect(Reflect.get(manager, 'activeMonitors').has('guild-1:voice-1:1:user-1')).toBe(false)
  })

  /**
   * @example
   * it('Discord audit D-007 aborts in-flight classic STT when the speaker withdraws consent', async () => {})
   */
  it('reproduces Discord audit D-007 by aborting in-flight classic STT when the speaker withdraws consent', async () => {
    let markTranscriptionStarted = () => {}
    const transcriptionStarted = new Promise<void>((resolve) => {
      markTranscriptionStarted = resolve
    })
    let providerSignal: AbortSignal | undefined
    const transcribeAudio = vi.fn(async (_buffer: Buffer, { abortSignal }: { abortSignal: AbortSignal }) => {
      providerSignal = abortSignal
      markTranscriptionStarted()
      await new Promise<never>((_resolve, reject) => {
        abortSignal.addEventListener('abort', () => reject(abortSignal.reason), { once: true })
      })
      return ''
    })
    const manager = new VoiceManager(
      createMock<DiscordClient>({ user: { id: 'bot-user' } }),
      async () => undefined,
      transcribeAudio,
    )
    const receiveStream = new PassThrough()
    const destroyReceiveStream = vi.spyOn(receiveStream, 'destroy')
    const connection = {
      destroy: vi.fn(),
      joinConfig: { guildId: 'guild-1' },
      receiver: {
        subscribe: vi.fn(() => receiveStream),
      },
      state: { status: 'ready' },
    }
    voiceMocks.getVoiceConnections.mockReturnValue(createMock<Map<string, VoiceConnection>>(new Map([['guild-1', connection]])))
    const guild = { id: 'guild-1', name: 'Synthetic guild' }
    const member = createMock<GuildMember>({
      displayName: 'Withdrawing speaker',
      guild,
      id: 'user-1',
      nickname: 'Withdrawing speaker',
      user: { bot: false },
    })
    const channel = createMock<BaseGuildVoiceChannel>({
      guild,
      id: 'voice-1',
      members: new Map([['user-1', member]]),
      name: 'Synthetic voice',
    })
    Reflect.get(manager, 'consentSessions').set('consent-1', {
      channel,
      consentedUserIds: new Set(['user-1']),
      id: 'consent-1',
      interaction: { editReply: vi.fn(async () => {}) },
      participantVoiceSessionIds: new Map([['user-1', 'participant-session-user-1']]),
      state: 'active',
    })
    Reflect.get(manager, 'consentSessionIdByGuildId').set('guild-1', 'consent-1')

    await manager.handleAudioReceiveStreamStart(channel)('user-1')
    const packets = createOpusPcm16Fixture()
    receiveStream.write(packets.nextSpeechPacket())
    receiveStream.write(packets.nextSpeechPacket())
    vi.useFakeTimers()
    await manager.handleAudioReceiveStreamEnd(channel)('user-1')
    vi.advanceTimersByTime(1_500)
    await transcriptionStarted

    // ROOT CAUSE:
    //
    // Withdrawal detached AudioMonitor listeners but left the receiver, decoder,
    // and the already-started provider request alive. The late result was dropped,
    // but the participant's audio kept being processed after consent was revoked.
    await manager.handleConsentInteraction(createMock<ButtonInteraction>({
      customId: 'airi:voice-consent:withdraw:consent-1',
      guildId: 'guild-1',
      inCachedGuild: () => true,
      member: { voice: { channelId: 'voice-1', sessionId: 'participant-session-user-1' } },
      update: vi.fn(async () => {}),
      user: { id: 'user-1' },
    }))

    /** @example expect(providerSignal?.aborted).toBe(true) */
    expect(providerSignal?.aborted).toBe(true)
    /** @example expect(destroyReceiveStream).toHaveBeenCalledOnce() */
    expect(destroyReceiveStream).toHaveBeenCalledOnce()
  })

  /**
   * @example
   * it('Discord audit D-007 requires unanimous opt-in and honors withdrawal before subscribe', async () => {})
   */
  it('reproduces Discord audit D-007 by requiring unanimous opt-in and honoring withdrawal before subscribe', async () => {
    const receiveStream = new PassThrough()
    const connection = {
      destroy: vi.fn(),
      joinConfig: { channelId: 'voice-1', guildId: 'guild-1' },
      off: vi.fn(),
      on: vi.fn(),
      receiver: {
        speaking: {
          off: vi.fn(),
          on: vi.fn(),
        },
        subscribe: vi.fn(() => receiveStream),
      },
      state: { status: 'ready' },
      subscribe: vi.fn(),
    }
    voiceMocks.joinVoiceChannel.mockReturnValue(createMock<VoiceConnection>(connection))
    const manager = createManager()
    const guild = {
      id: 'guild-1',
      members: { me: undefined },
      name: 'Synthetic guild',
      voiceAdapterCreator: {},
    }
    const members = new Map<string, GuildMember>()
    const createMember = (id: string) => createMock<GuildMember>({
      displayName: id,
      guild,
      id,
      nickname: id,
      user: { bot: false },
      voice: { channelId: 'voice-1', sessionId: `participant-session-${id}` },
    })
    members.set('user-1', createMember('user-1'))
    members.set('user-2', createMember('user-2'))
    const channel = createMock<BaseGuildVoiceChannel>({
      guild,
      guildId: 'guild-1',
      id: 'voice-1',
      members,
      name: 'Voice',
    })
    const editReply = vi.fn(async () => {})
    const slashInteraction = createMock<ChatInputCommandInteraction>({
      editReply,
      id: '1',
      inCachedGuild: () => true,
      member: { voice: { channel } },
      reply: vi.fn(async () => {}),
    })
    const consentInteraction = (action: 'opt-in' | 'withdraw', userId: string) => createMock<ButtonInteraction>({
      customId: `airi:voice-consent:${action}:guild-1-1`,
      followUp: vi.fn(async () => {}),
      guildId: 'guild-1',
      inCachedGuild: () => true,
      member: { voice: { channelId: 'voice-1', sessionId: `participant-session-${userId}` } },
      update: vi.fn(async () => {}),
      user: { id: userId },
    })

    // ROOT CAUSE:
    //
    // The old `/summon` flow treated command delivery as consent and installed
    // receive/provider listeners before any participant made a session-scoped
    // choice. New participants and withdrawn participants were also subscribed.
    await manager.handleJoinChannelCommand(slashInteraction)
    await manager.handleConsentInteraction(consentInteraction('opt-in', 'user-1'))

    expect(voiceMocks.joinVoiceChannel).not.toHaveBeenCalled()

    await manager.handleConsentInteraction(consentInteraction('opt-in', 'user-2'))

    expect(voiceMocks.joinVoiceChannel).toHaveBeenCalledOnce()

    const destroyReceiveStream = vi.spyOn(receiveStream, 'destroy')
    await manager.handleAudioReceiveStreamStart(channel)('user-1')

    expect(connection.receiver.subscribe).toHaveBeenCalledOnce()

    members.set('user-3', createMember('user-3'))
    await manager.handleAudioReceiveStreamStart(channel)('user-3')
    await manager.handleConsentInteraction(consentInteraction('withdraw', 'user-1'))
    await manager.handleAudioReceiveStreamStart(channel)('user-1')

    expect(connection.receiver.subscribe).toHaveBeenCalledOnce()
    expect(destroyReceiveStream).toHaveBeenCalledOnce()
    manager.stop()
  })

  /**
   * @example
   * it('Discord audit D-009 drops a deferred channel A turn after moving the speaker to channel B', async () => {})
   */
  it('reproduces Discord audit D-009 by dropping a deferred channel A turn after moving the speaker to channel B', async () => {
    let resolveTranscription = (_text: string) => {}
    let markTranscriptionStarted = () => {}
    const transcriptionStarted = new Promise<void>((resolve) => {
      markTranscriptionStarted = resolve
    })
    const deferredTranscription = new Promise<string>((resolve) => {
      resolveTranscription = resolve
    })
    const handleTranscription = vi.fn(async () => NodeReadable.from(Buffer.from([1, 2, 3])))
    const transcribeAudio = vi.fn(async () => {
      markTranscriptionStarted()
      return deferredTranscription
    })
    const manager = new VoiceManager(
      createMock<DiscordClient>({ user: { id: 'bot-user' } }),
      handleTranscription,
      transcribeAudio,
    )
    const createConnection = (receiveStream: PassThrough) => ({
      destroy: vi.fn(),
      joinConfig: { guildId: 'guild-1' },
      on: vi.fn(),
      off: vi.fn(),
      receiver: {
        speaking: {
          on: vi.fn(),
          off: vi.fn(),
        },
        subscribe: vi.fn(() => receiveStream),
      },
      state: { status: 'ready' },
      subscribe: vi.fn(),
    })
    const receiveA = new PassThrough()
    const receiveB = new PassThrough()
    const connectionA = createConnection(receiveA)
    const connectionB = createConnection(receiveB)
    const member = createMock<GuildMember>({
      displayName: 'Speaker',
      guild: { id: 'guild-1', members: { fetch: vi.fn() } },
      id: 'user-1',
      user: { bot: false },
    })
    const createChannel = (id: string) => createMock<BaseGuildVoiceChannel>({
      guild: {
        id: 'guild-1',
        members: { me: undefined },
        voiceAdapterCreator: {},
      },
      guildId: 'guild-1',
      id,
      members: new Map([['user-1', member]]),
      name: id,
    })
    const channelA = createChannel('voice-a')
    const channelB = createChannel('voice-b')
    const interaction = createMock<ChatInputCommandInteraction>({
      reply: vi.fn(async () => {}),
    })
    const audioPlayer = {
      on: vi.fn(),
      play: vi.fn(),
      removeAllListeners: vi.fn(),
      state: { status: 'idle' },
      stop: vi.fn(),
    }
    voiceMocks.createAudioPlayer.mockReturnValue(createMock<AudioPlayer>(audioPlayer))
    voiceMocks.joinVoiceChannel.mockReturnValueOnce(createMock<VoiceConnection>(connectionA)).mockReturnValueOnce(createMock<VoiceConnection>(connectionB))

    await manager.joinChannel(interaction, channelA)
    voiceMocks.getVoiceConnections.mockReturnValue(createMock<Map<string, VoiceConnection>>(new Map([['guild-1', connectionA]])))
    await manager.handleAudioReceiveStreamStart(channelA)('user-1')
    await vi.waitFor(() => {
      expect(connectionA.receiver.subscribe).toHaveBeenCalledOnce()
    })

    const packets = createOpusPcm16Fixture()
    receiveA.write(packets.nextSpeechPacket())
    receiveA.write(packets.nextSpeechPacket())
    vi.useFakeTimers()
    await manager.handleAudioReceiveStreamEnd(channelA)('user-1')
    vi.advanceTimersByTime(1_500)
    await transcriptionStarted

    voiceMocks.getVoiceConnections.mockReturnValue(createMock<Map<string, VoiceConnection>>(new Map([['guild-1', connectionA]])))
    await manager.joinChannel(interaction, channelB)
    voiceMocks.getVoiceConnections.mockReturnValue(createMock<Map<string, VoiceConnection>>(new Map([['guild-1', connectionB]])))
    await manager.handleAudioReceiveStreamStart(channelB)('user-1')
    vi.useRealTimers()
    await vi.waitFor(() => {
      expect(connectionB.receiver.subscribe).toHaveBeenCalledOnce()
    })

    // ROOT CAUSE:
    //
    // A classic voice turn has no session generation or abort signal. Its
    // delayed STT/chat/TTS continuation looks up playback by user id, so an A
    // result can subscribe to the user's newer B connection after a move.
    resolveTranscription('stale channel A transcript')
    await new Promise<void>(resolve => setImmediate(resolve))
    const stalePlaybackCount = connectionB.subscribe.mock.calls.length
    manager.stop()

    expect(stalePlaybackCount).toBe(0)
  })

  /**
   * @example
   * it('Discord audit D-013 isolates classic playback and barge-in by voice scope', async () => {})
   */
  it('reproduces Discord audit D-013 by isolating classic playback and barge-in by voice scope', async () => {
    // ROOT CAUSE:
    //
    // Classic playback used one process-global `activeAudioPlayer`, so starting
    // or interrupting channel A stopped the unrelated player subscribed to B.
    // Playback ownership now includes guild, channel, and connection generation.
    const receiveA = new PassThrough()
    const receiveB = new PassThrough()
    const createConnection = (guildId: string, receiveStream: PassThrough) => ({
      destroy: vi.fn(),
      joinConfig: { guildId },
      on: vi.fn(),
      off: vi.fn(),
      receiver: {
        speaking: {
          on: vi.fn(),
          off: vi.fn(),
        },
        subscribe: vi.fn(() => receiveStream),
      },
      state: { status: 'ready' },
      subscribe: vi.fn(),
    })
    const connectionA = createConnection('guild-a', receiveA)
    const connectionB = createConnection('guild-b', receiveB)
    const memberA = createMock<GuildMember>({
      displayName: 'Synthetic A',
      guild: { id: 'guild-a', name: 'Guild A' },
      id: 'user-a',
      user: { bot: false },
    })
    const memberB = createMock<GuildMember>({
      displayName: 'Synthetic B',
      guild: { id: 'guild-b', name: 'Guild B' },
      id: 'user-b',
      user: { bot: false },
    })
    const createChannel = (id: string, guildId: string, member: GuildMember) => createMock<BaseGuildVoiceChannel>({
      guild: {
        id: guildId,
        members: { me: undefined },
        voiceAdapterCreator: {},
      },
      guildId,
      id,
      members: new Map([[member.id, member]]),
      name: id,
    })
    const channelA = createChannel('voice-a', 'guild-a', memberA)
    const channelB = createChannel('voice-b', 'guild-b', memberB)
    const interaction = createMock<ChatInputCommandInteraction>({ reply: vi.fn(async () => {}) })
    const createPlayer = () => ({
      on: vi.fn(),
      play: vi.fn(),
      removeAllListeners: vi.fn(),
      state: { status: 'playing' },
      stop: vi.fn(),
    })
    const playerA = createPlayer()
    const playerB = createPlayer()
    voiceMocks.createAudioPlayer.mockReturnValueOnce(createMock<AudioPlayer>(playerA)).mockReturnValueOnce(createMock<AudioPlayer>(playerB))
    voiceMocks.joinVoiceChannel.mockReturnValueOnce(createMock<VoiceConnection>(connectionA)).mockReturnValueOnce(createMock<VoiceConnection>(connectionB))
    const manager = createManager()

    await manager.joinChannel(interaction, channelA)
    await manager.joinChannel(interaction, channelB)
    const sessionA = Reflect.get(manager, 'activeVoiceSessionsByGuildId').get('guild-a')
    const sessionB = Reflect.get(manager, 'activeVoiceSessionsByGuildId').get('guild-b')
    await manager.playAudioStream(createMock<VoiceConnection>(connectionA), NodeReadable.from(Buffer.from([1])), sessionA.abortController.signal, {
      channelId: 'voice-a',
      generation: sessionA.scope.generation,
      guildId: 'guild-a',
    }, Number.MAX_SAFE_INTEGER)
    await manager.playAudioStream(createMock<VoiceConnection>(connectionB), NodeReadable.from(Buffer.from([2])), sessionB.abortController.signal, {
      channelId: 'voice-b',
      generation: sessionB.scope.generation,
      guildId: 'guild-b',
    }, Number.MAX_SAFE_INTEGER)
    await manager.handleAudioReceiveStreamStart(channelA)('user-a')
    const decoderA = [...Reflect.get(manager, 'streams').values()][0]
    const playbackA = [...Reflect.get(manager, 'activeClassicPlaybacks').values()]
      .find(playback => playback.scope.channelId === 'voice-a')
    const monitorA = [...Reflect.get(manager, 'activeMonitors').values()]
      .find(monitor => monitor.scope.channelId === 'voice-a')
    const speechCursor = createPcm16Cursor()

    // ROOT CAUSE:
    //
    // Classic playback was stored in one process-global `activeAudioPlayer`.
    // Starting B stopped A, and A's PCM interruption detector subsequently
    // stopped whichever global player happened to be newest, including B.
    expect(playbackA.player).toBe(playerA)
    expect(monitorA.admitted).toBe(true)
    expect(decoderA.listenerCount('data')).toBeGreaterThan(1)
    for (let index = 0; index < 30; index += 1)
      decoderA.emit('data', speechPcm16(speechCursor, 320, 8_000))

    await vi.waitFor(() => {
      expect(playerA.stop).toHaveBeenCalledOnce()
    })
    expect(playerB.stop).not.toHaveBeenCalled()
    expect(connectionA.subscribe).toHaveBeenCalledWith(playerA)
    expect(connectionB.subscribe).toHaveBeenCalledWith(playerB)
    manager.stop()
  })

  /**
   * @example
   * it('Discord audit D-013 ignores a stale classic player callback after generation replacement', async () => {})
   */
  it('reproduces Discord audit D-013 by ignoring a stale classic player callback after generation replacement', async () => {
    // ROOT CAUSE:
    //
    // An old classic player's idle/error callback cleaned whichever player was
    // globally current. Record-identity and generation checks now make stale A1
    // callbacks unable to remove A2 or any B playback.
    let staleStateChange: ((oldState: { status: string }, newState: { status: string }) => void) | undefined
    const playerA1 = {
      on: vi.fn((event: string, listener: (oldState: { status: string }, newState: { status: string }) => void) => {
        if (event === 'stateChange')
          staleStateChange = listener
      }),
      play: vi.fn(),
      removeAllListeners: vi.fn(),
      state: { status: 'playing' },
      stop: vi.fn(),
    }
    const createPlayer = () => ({
      on: vi.fn(),
      play: vi.fn(),
      removeAllListeners: vi.fn(),
      state: { status: 'playing' },
      stop: vi.fn(),
    })
    const playerA2 = createPlayer()
    const playerB = createPlayer()
    voiceMocks.createAudioPlayer
      .mockReturnValueOnce(createMock<AudioPlayer>(playerA1))
      .mockReturnValueOnce(createMock<AudioPlayer>(playerA2))
      .mockReturnValueOnce(createMock<AudioPlayer>(playerB))
    const connectionA1 = createMock<VoiceConnection>({ subscribe: vi.fn() })
    const connectionA2 = createMock<VoiceConnection>({ subscribe: vi.fn() })
    const connectionB = createMock<VoiceConnection>({ subscribe: vi.fn() })
    const manager = createManager()
    const abortA1 = new AbortController()
    const abortA2 = new AbortController()
    const abortB = new AbortController()
    const scopeA1 = { channelId: 'voice-a', generation: 1, guildId: 'guild-a' }
    const scopeA2 = { channelId: 'voice-a', generation: 2, guildId: 'guild-a' }
    const scopeB = { channelId: 'voice-b', generation: 3, guildId: 'guild-b' }

    await manager.playAudioStream(connectionA1, NodeReadable.from(Buffer.from([1])), abortA1.signal, scopeA1, Number.MAX_SAFE_INTEGER)
    abortA1.abort(new Error('synthetic generation replacement'))
    await manager.playAudioStream(connectionA2, NodeReadable.from(Buffer.from([2])), abortA2.signal, scopeA2, Number.MAX_SAFE_INTEGER)
    await manager.playAudioStream(connectionB, NodeReadable.from(Buffer.from([3])), abortB.signal, scopeB, Number.MAX_SAFE_INTEGER)

    // ROOT CAUSE:
    //
    // Classic player callbacks had no immutable scope identity. A late idle/error
    // callback from A1 could clear whichever process-global player was current,
    // including A2 or an unrelated channel B playback.
    staleStateChange?.({ status: 'playing' }, { status: 'idle' })

    expect(playerA1.stop).toHaveBeenCalledOnce()
    expect(playerA2.stop).not.toHaveBeenCalled()
    expect(playerB.stop).not.toHaveBeenCalled()
    manager.stop()
  })

  /**
   * @example
   * it('Discord audit D-013 isolates concurrent Qwen playback and interruption by voice scope', async () => {})
   */
  it('reproduces Discord audit D-013 by isolating concurrent Qwen playback and interruption by voice scope', async () => {
    // ROOT CAUSE:
    //
    // Qwen player/socket and interruption state was shared or channel-only, so
    // B startup and A barge-in could stop the other scope. Both provider and
    // playback records now carry immutable guild/channel/generation ownership.
    const providerEvents: RealtimeVoiceCallSessionEvents[] = []
    const providerSessions: Array<{
      abortInput: ReturnType<typeof vi.fn>
      appendAudio: ReturnType<typeof vi.fn>
      cancelResponse: ReturnType<typeof vi.fn>
      close: ReturnType<typeof vi.fn>
      finishInput: ReturnType<typeof vi.fn>
    }> = []
    const runtime = {
      connect: vi.fn(async (events: RealtimeVoiceCallSessionEvents) => {
        providerEvents.push(events)
        const provider = {
          abortInput: vi.fn(),
          appendAudio: vi.fn((pcm: Buffer, inputSequence: number) => {
            events.onInputAudioSent?.({ byteLength: pcm.length, chunkCount: 1, inputSequence, kind: 'user-audio' })
            return true
          }),
          cancelResponse: vi.fn(),
          close: vi.fn(),
          finishInput: vi.fn(),
        }
        providerSessions.push(provider)
        return provider
      }),
      getInterruptionRmsThreshold: () => 0.04,
      getMode: () => 'qwen-realtime' as const,
      isConfigured: () => true,
    }
    const createPlayer = () => ({
      on: vi.fn(),
      play: vi.fn(),
      removeAllListeners: vi.fn(),
      stop: vi.fn(),
    })
    const playerA = createPlayer()
    const playerB = createPlayer()
    voiceMocks.createAudioPlayer.mockReturnValueOnce(createMock<AudioPlayer>(playerA)).mockReturnValueOnce(createMock<AudioPlayer>(playerB))
    const fixtureA = createPublicRealtimeChannel('guild-a', 'voice-a', 'user-a')
    const fixtureB = createPublicRealtimeChannel('guild-b', 'voice-b', 'user-b')
    const manager = new VoiceManager(
      createMock<DiscordClient>({ user: { id: 'bot-user' } }),
      async () => undefined,
      async () => '',
      runtime,
    )
    voiceMocks.joinVoiceChannel.mockReturnValueOnce(createMock<VoiceConnection>(fixtureA.connection)).mockReturnValueOnce(createMock<VoiceConnection>(fixtureB.connection))
    const interaction = createMock<ChatInputCommandInteraction>({ reply: vi.fn(async () => {}) })
    await manager.joinChannel(interaction, fixtureA.channel)
    await manager.joinChannel(interaction, fixtureB.channel)
    const inputSequenceA = await appendPublicRealtimeInput(fixtureA, providerSessions[0])
    providerEvents[0].onInputCommitted?.({ inputSequence: inputSequenceA, itemId: 'item-a' })
    providerEvents[0].onResponseCreated?.({ responseId: 'response-a' })
    const inputSequenceB = await appendPublicRealtimeInput(fixtureB, providerSessions[1])
    providerEvents[1].onInputCommitted?.({ inputSequence: inputSequenceB, itemId: 'item-b' })
    providerEvents[1].onResponseCreated?.({ responseId: 'response-b' })
    providerEvents[0].onAudio?.(Buffer.from([1, 2]), { responseId: 'response-a' })
    providerEvents[1].onAudio?.(Buffer.from([3, 4]), { responseId: 'response-b' })

    // ROOT CAUSE:
    //
    // Qwen playback was nominally indexed by channel, but creating any player
    // first cleaned the same process-global `activeAudioPlayer`. Concurrent
    // guild/channel replies therefore stopped each other before targeted
    // interruption logic even ran.
    expect(playerA.stop).not.toHaveBeenCalled()
    expect(playerB.stop).not.toHaveBeenCalled()
    providerEvents[0].onSpeechStarted?.({ inputSequence: inputSequenceA, itemId: 'item-a' })
    expect(playerA.stop).toHaveBeenCalledOnce()
    expect(playerB.stop).not.toHaveBeenCalled()
    expect(fixtureA.connection.subscribe).toHaveBeenCalledWith(playerA)
    expect(fixtureB.connection.subscribe).toHaveBeenCalledWith(playerB)
    providerEvents[0].onError?.({ category: 'provider-error', disposition: 'terminal' })
    expect(providerSessions[0].cancelResponse).toHaveBeenCalledOnce()
    expect(providerSessions[0].close).toHaveBeenCalledOnce()
    expect(providerSessions[1].cancelResponse).not.toHaveBeenCalled()
    expect(providerSessions[1].close).not.toHaveBeenCalled()
    manager.leaveChannel(fixtureA.channel)
    expect(fixtureA.connection.destroy).toHaveBeenCalledOnce()
    expect(fixtureB.connection.destroy).not.toHaveBeenCalled()
    expect(playerB.stop).not.toHaveBeenCalled()
    manager.stop()
  })

  /**
   * @example
   * it('reproduces Discord audit D-017 by keeping rotation warnings nonfatal at the voice owner', async () => {})
   */
  it('reproduces Discord audit D-017 by keeping rotation warnings nonfatal at the voice owner', async () => {
    const diagnostics: VoiceDiagnosticSignal[] = []
    let providerEvents: RealtimeVoiceCallSessionEvents | undefined
    const provider = {
      abortInput: vi.fn(),
      appendAudio: vi.fn((pcm: Buffer, inputSequence: number) => {
        providerEvents?.onInputAudioSent?.({ byteLength: pcm.length, chunkCount: 1, inputSequence, kind: 'user-audio' })
        return true
      }),
      cancelResponse: vi.fn(),
      close: vi.fn(),
      finishInput: vi.fn(),
    }
    const runtime = {
      connect: vi.fn(async (events: RealtimeVoiceCallSessionEvents) => {
        providerEvents = events
        return provider
      }),
      getInterruptionRmsThreshold: () => 0.04,
      getMode: () => 'qwen-realtime' as const,
      isConfigured: () => true,
    }
    const player = {
      on: vi.fn(),
      play: vi.fn(),
      removeAllListeners: vi.fn(),
      stop: vi.fn(),
    }
    voiceMocks.createAudioPlayer.mockReturnValue(createMock<AudioPlayer>(player))
    const manager = new VoiceManager(
      createMock<DiscordClient>({ user: { id: 'bot-user' } }),
      async () => undefined,
      async () => '',
      runtime,
      undefined,
      undefined,
      undefined,
      { record: signal => diagnostics.push({ ...signal }), runtimeSequence: 17 },
    )
    const fixture = createPublicRealtimeChannel('guild-1', 'voice-1', 'user-1')
    voiceMocks.joinVoiceChannel.mockReturnValue(createMock<VoiceConnection>(fixture.connection))
    await manager.joinChannel(createMock<ChatInputCommandInteraction>({ reply: vi.fn(async () => {}) }), fixture.channel)
    if (!providerEvents)
      throw new Error('The public Qwen join must install provider callbacks.')

    // ROOT CAUSE:
    //
    // D-017's bounded rotation grace reports a recoverable warning while it
    // preserves an active turn. Routing that warning through the fatal onError
    // callback would close the provider and recreate the original truncation.
    // Both provider callbacks also passed their raw Error to the logger. A
    // transport error can contain an upstream URL, response body, or credential,
    // so only its fixed classification and anonymous diagnostic ownership may
    // be observable. Discord scope identifiers are not operational log fields.
    providerEvents.onWarning?.({ category: 'rotation-overdue', disposition: 'terminal' })
    providerEvents.onWarning?.({ category: 'rotation-overdue', disposition: 'terminal' })
    const inputSequence = await appendPublicRealtimeInput(fixture, provider)
    providerEvents.onInputCommitted?.({ inputSequence, itemId: 'warning-item' })
    providerEvents.onResponseCreated?.({ responseId: 'warning-response' })
    providerEvents.onAudio?.(Buffer.from([1, 2, 3, 4]), { responseId: 'warning-response' })

    /**
     * @example
     * expect(provider.cancelResponse).not.toHaveBeenCalled()
     */
    expect(provider.cancelResponse).not.toHaveBeenCalled()
    /**
     * @example
     * expect(provider.close).not.toHaveBeenCalled()
     */
    expect(provider.close).not.toHaveBeenCalled()
    /**
     * @example
     * expect(connection.subscribe).toHaveBeenCalledWith(player)
     */
    expect(fixture.connection.subscribe).toHaveBeenCalledWith(player)
    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: 'provider-input-committed', turnSequence: inputSequence }),
      expect.objectContaining({ stage: 'provider-response-created', turnSequence: inputSequence }),
      expect.objectContaining({ stage: 'provider-response-audio', turnSequence: inputSequence }),
    ]))

    providerEvents.onError?.({ category: 'provider-error', disposition: 'terminal' })
    /**
     * @example
     * expect(provider.close).toHaveBeenCalledOnce()
     */
    expect(provider.close).toHaveBeenCalledOnce()
    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ failureCategory: 'provider-error', stage: 'failure', turnSequence: inputSequence }),
    ]))
    await manager.stop()
  })

  /**
   * @example
   * it('Discord audit D-013 ignores stale Qwen callbacks after a same-channel generation change', async () => {})
   */
  it('reproduces Discord audit D-013 by ignoring stale Qwen callbacks after a same-channel generation change', async () => {
    // ROOT CAUSE:
    //
    // Qwen close/error callbacks looked up mutable channel state and could close
    // a replacement session. Cleanup now requires the original generation and
    // record identity before touching current state.
    const providerEvents: RealtimeVoiceCallSessionEvents[] = []
    const providers: Array<{
      abortInput: ReturnType<typeof vi.fn>
      appendAudio: ReturnType<typeof vi.fn>
      cancelResponse: ReturnType<typeof vi.fn>
      close: ReturnType<typeof vi.fn>
      finishInput: ReturnType<typeof vi.fn>
    }> = []
    const diagnostics: VoiceDiagnosticSignal[] = []
    const runtime = {
      connect: vi.fn(async (events: RealtimeVoiceCallSessionEvents) => {
        providerEvents.push(events)
        const provider = {
          abortInput: vi.fn(),
          appendAudio: vi.fn((pcm: Buffer, inputSequence: number) => {
            events.onInputAudioSent?.({ byteLength: pcm.length, chunkCount: 1, inputSequence, kind: 'user-audio' })
            return true
          }),
          cancelResponse: vi.fn(),
          close: vi.fn(),
          finishInput: vi.fn(),
        }
        providers.push(provider)
        return provider
      }),
      getInterruptionRmsThreshold: () => 0.04,
      getMode: () => 'qwen-realtime' as const,
      isConfigured: () => true,
    }
    const createPlayer = () => ({
      on: vi.fn(),
      play: vi.fn(),
      removeAllListeners: vi.fn(),
      stop: vi.fn(),
    })
    const playerA1 = createPlayer()
    const playerA2 = createPlayer()
    voiceMocks.createAudioPlayer.mockReturnValueOnce(createMock<AudioPlayer>(playerA1)).mockReturnValueOnce(createMock<AudioPlayer>(playerA2))
    const fixtureA1 = createPublicRealtimeChannel('guild-a', 'voice-a', 'user-a')
    const fixtureA2 = createPublicRealtimeChannel('guild-a', 'voice-a', 'user-a')
    const manager = new VoiceManager(
      createMock<DiscordClient>({ user: { id: 'bot-user' } }),
      async () => undefined,
      async () => '',
      runtime,
      undefined,
      undefined,
      undefined,
      { record: signal => diagnostics.push({ ...signal }), runtimeSequence: 91 },
    )
    voiceMocks.joinVoiceChannel.mockReturnValueOnce(createMock<VoiceConnection>(fixtureA1.connection)).mockReturnValueOnce(createMock<VoiceConnection>(fixtureA2.connection))
    const interaction = createMock<ChatInputCommandInteraction>({ reply: vi.fn(async () => {}) })
    await manager.joinChannel(interaction, fixtureA1.channel)
    const inputA1 = await appendPublicRealtimeInput(fixtureA1, providers[0])
    providerEvents[0].onInputCommitted?.({ inputSequence: inputA1, itemId: 'item-a1' })
    providerEvents[0].onResponseCreated?.({ responseId: 'response-a1' })
    providerEvents[0].onAudio?.(Buffer.from([1, 1]), { responseId: 'response-a1' })

    // A public dismissal releases the old same-channel generation before the
    // next public join constructs its replacement. No private session map is
    // needed to manufacture either identity.
    manager.leaveChannel(fixtureA1.channel)
    expect(fixtureA1.connection.destroy).toHaveBeenCalledOnce()
    expect(providers[0].close).toHaveBeenCalledOnce()

    await manager.joinChannel(interaction, fixtureA2.channel)
    const inputA2 = await appendPublicRealtimeInput(fixtureA2, providers[1])
    providerEvents[1].onInputCommitted?.({ inputSequence: inputA2, itemId: 'item-a2' })
    providerEvents[1].onResponseCreated?.({ responseId: 'response-a2' })
    providerEvents[1].onAudio?.(Buffer.from([2, 2]), { responseId: 'response-a2' })
    const diagnosticsBeforeStaleCallbacks = diagnostics.slice()

    // ROOT CAUSE:
    //
    // Qwen close/error callbacks captured only `channelId`. An old socket close
    // could therefore finish or remove the playback installed by a newer
    // generation that rejoined the same channel.
    providerEvents[0].onInputCommitted?.({ inputSequence: inputA1, itemId: 'stale-item-a1' })
    providerEvents[0].onResponseCreated?.({ responseId: 'stale-response-a1' })
    providerEvents[0].onAudio?.(Buffer.from([9, 9]), { responseId: 'stale-response-a1' })
    providerEvents[0].onClose?.(1000, 'synthetic stale close')

    expect(diagnostics).toEqual(diagnosticsBeforeStaleCallbacks)
    expect(playerA2.stop).not.toHaveBeenCalled()
    expect(fixtureA2.connection.subscribe).toHaveBeenCalledWith(playerA2)
    expect(providers[1].cancelResponse).not.toHaveBeenCalled()
    expect(providers[1].close).not.toHaveBeenCalled()
    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ runtimeSequence: 91, stage: 'provider-input-committed', turnSequence: inputA2 }),
      expect.objectContaining({ runtimeSequence: 91, stage: 'provider-response-created', turnSequence: inputA2 }),
      expect.objectContaining({ runtimeSequence: 91, stage: 'provider-response-audio', turnSequence: inputA2 }),
    ]))

    providerEvents[1].onAudioDone?.({ responseId: 'response-a2' })
    await manager.stop()
    expect(providers[1].close).toHaveBeenCalledOnce()
  })

  /**
   * @example
   * it('Discord audit D-013 scopes receiver, monitor, and move cleanup for the same speaker across guilds', async () => {})
   */
  it('reproduces Discord audit D-013 by scoping receiver, monitor, and move cleanup for the same speaker across guilds', async () => {
    // ROOT CAUSE:
    //
    // Receiver, monitor, stream, timer, and processing maps used only `userId`.
    // The same Discord user in another guild replaced A and A cleanup removed B.
    // Speaker state now uses guild/channel/user plus connection generation.
    const receiveA = new PassThrough()
    const receiveB = new PassThrough()
    const createConnection = (guildId: string, receiveStream: PassThrough) => ({
      destroy: vi.fn(),
      joinConfig: { guildId },
      on: vi.fn(),
      off: vi.fn(),
      receiver: {
        speaking: { on: vi.fn(), off: vi.fn() },
        subscribe: vi.fn(() => receiveStream),
      },
      state: { status: 'ready' },
      subscribe: vi.fn(),
    })
    const connectionA = createConnection('guild-a', receiveA)
    const connectionB = createConnection('guild-b', receiveB)
    const createMember = (guildId: string) => createMock<GuildMember>({
      displayName: 'Synthetic shared speaker',
      guild: { id: guildId, name: guildId },
      id: 'shared-user',
      user: { bot: false },
    })
    const memberA = createMember('guild-a')
    const memberB = createMember('guild-b')
    const createChannel = (id: string, guildId: string, member: GuildMember) => createMock<BaseGuildVoiceChannel>({
      guild: { id: guildId, members: { me: undefined }, voiceAdapterCreator: {} },
      guildId,
      id,
      members: new Map([['shared-user', member]]),
      name: id,
    })
    const channelA = createChannel('voice-a', 'guild-a', memberA)
    const channelB = createChannel('voice-b', 'guild-b', memberB)
    voiceMocks.joinVoiceChannel.mockReturnValueOnce(createMock<VoiceConnection>(connectionA)).mockReturnValueOnce(createMock<VoiceConnection>(connectionB))
    const manager = createManager()
    const interaction = createMock<ChatInputCommandInteraction>({ reply: vi.fn(async () => {}) })
    await manager.joinChannel(interaction, channelA)
    await manager.joinChannel(interaction, channelB)
    await manager.handleAudioReceiveStreamStart(channelA)('shared-user')
    await manager.handleAudioReceiveStreamStart(channelB)('shared-user')

    // ROOT CAUSE:
    //
    // Receiver, monitor, stream, processing, and timeout maps used bare userId
    // keys. The same Discord user speaking in another guild replaced or stopped
    // the first channel's generation, and channel-A lifecycle cleanup could hit B.
    expect(connectionA.receiver.subscribe).toHaveBeenCalledOnce()
    expect(connectionB.receiver.subscribe).toHaveBeenCalledOnce()
    expect(receiveA.destroyed).toBe(false)
    expect(receiveB.destroyed).toBe(false)

    Reflect.get(manager, 'consentSessionIdByGuildId').set('guild-a', 'consent-a')
    Reflect.get(manager, 'consentSessions').set('consent-a', {
      channel: channelA,
      consentedUserIds: new Set(['shared-user']),
      id: 'consent-a',
      interaction: { editReply: vi.fn(async () => {}) },
      participantVoiceSessionIds: new Map([['shared-user', 'participant-session-shared-a']]),
      state: 'active',
    })
    await manager.handleVoiceStateUpdate(
      createMock<VoiceState>({ channelId: 'voice-a', guild: { id: 'guild-a' }, id: 'shared-user' }),
      createMock<VoiceState>({ channelId: null, guild: { id: 'guild-a' }, id: 'shared-user' }),
    )

    expect(receiveA.destroyed).toBe(true)
    expect(receiveB.destroyed).toBe(false)

    manager.leaveChannel(channelA)

    expect(receiveB.destroyed).toBe(false)
    expect(connectionA.destroy).toHaveBeenCalledOnce()
    expect(connectionB.destroy).not.toHaveBeenCalled()
    manager.stop()
  })

  /** @example it.each(['idle', 'error'])('releases a synchronously terminal realtime subscription returned by %s', async () => {}) */
  it.each(['idle', 'error'] as const)('releases a synchronously terminal realtime subscription returned by %s', async (terminal) => {
    let providerEvents: RealtimeVoiceCallSessionEvents | undefined
    const receiveStream = new PassThrough()
    const provider = {
      appendAudio: vi.fn((pcm: Buffer, inputSequence: number) => {
        providerEvents?.onInputAudioSent?.({ byteLength: pcm.length, chunkCount: 1, inputSequence, kind: 'user-audio' })
        return true
      }),
      cancelResponse: vi.fn(),
      close: vi.fn(),
      finishInput: vi.fn(),
    }
    const runtime = {
      connect: vi.fn(async (events: RealtimeVoiceCallSessionEvents) => {
        providerEvents = events
        return provider
      }),
      getInterruptionRmsThreshold: () => 0.04,
      getMode: () => 'qwen-realtime' as const,
      isConfigured: () => true,
    }
    const player = Object.assign(new EventEmitter(), {
      play: vi.fn(),
      removeAllListeners: vi.fn(function (this: EventEmitter) {
        return EventEmitter.prototype.removeAllListeners.call(this)
      }),
      state: { status: 'idle' },
      stop: vi.fn(),
    })
    const unsubscribe = vi.fn()
    const connection = Object.assign(new EventEmitter(), {
      destroy: vi.fn(),
      joinConfig: { channelId: 'voice-sync', guildId: 'guild-sync' },
      receiver: { speaking: new EventEmitter(), subscribe: vi.fn(() => receiveStream) },
      state: { status: 'ready' },
      subscribe: vi.fn(() => {
        if (terminal === 'idle')
          player.emit('stateChange', { status: 'buffering' }, { status: 'idle' })
        else
          player.emit('error', new Error('synthetic realtime player failure'))
        return { unsubscribe }
      }),
    })
    const guild = { id: 'guild-sync', members: { me: undefined }, voiceAdapterCreator: {} }
    const channel = createMock<BaseGuildVoiceChannel>({
      guild,
      id: 'voice-sync',
      members: new Map([['listener', { displayName: 'Listener', guild, id: 'listener', user: { bot: false } }]]),
    })
    const manager = new VoiceManager(
      createMock<DiscordClient>({ user: { id: 'bot-user' } }),
      async () => undefined,
      async () => '',
      runtime,
    )
    voiceMocks.createAudioPlayer.mockReturnValue(createMock<AudioPlayer>(player))
    voiceMocks.createAudioResource.mockReturnValue(createMock<AudioResource<null>>({ synthetic: 'realtime-resource' }))
    voiceMocks.joinVoiceChannel.mockReturnValue(createMock<VoiceConnection>(connection))

    await manager.joinChannel(createMock<ChatInputCommandInteraction>({ reply: vi.fn(async () => {}) }), channel)
    if (!providerEvents)
      throw new Error('Expected the public Qwen session to install provider callbacks.')
    connection.receiver.speaking.emit('start', 'listener')
    await vi.waitFor(() => expect(connection.receiver.subscribe).toHaveBeenCalledOnce())
    const packets = createOpusPcm16Fixture()
    for (let frame = 0; frame < 6; frame += 1)
      receiveStream.write(packets.nextSpeechPacket())
    await vi.waitFor(() => expect(provider.appendAudio).toHaveBeenCalled())
    const inputSequence = provider.appendAudio.mock.calls.at(-1)?.[1]
    if (!inputSequence)
      throw new Error('Raw playback must follow a real successful receiver append.')
    providerEvents.onInputCommitted?.({ inputSequence })
    providerEvents.onResponseCreated?.({ responseId: `response-${terminal}` })
    providerEvents.onAudio?.(Buffer.from([1, 2, 3, 4]), { responseId: `response-${terminal}` })

    expect(connection.subscribe).toHaveBeenCalledWith(player)
    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(player.play).not.toHaveBeenCalled()
    expect(player.stop).toHaveBeenCalledOnce()
    manager.leaveChannel(channel)
    expect(unsubscribe).toHaveBeenCalledOnce()
    await manager.stop()
  })

  /** @example it.each(['abort', 'idle', 'leave'])('releases classic playback subscriptions exactly once on %s cleanup', async () => {}) */
  it.each(['abort', 'idle', 'leave'] as const)('releases classic playback subscriptions exactly once on %s cleanup', async (cleanup) => {
    const player = Object.assign(new EventEmitter(), {
      play: vi.fn(),
      removeAllListeners: vi.fn(function (this: EventEmitter) {
        return EventEmitter.prototype.removeAllListeners.call(this)
      }),
      state: { status: 'idle' },
      stop: vi.fn(),
    })
    const subscribedPlayers = new Set<object>()
    const unsubscribe = vi.fn(() => subscribedPlayers.delete(player))
    const connection = Object.assign(new EventEmitter(), {
      destroy: vi.fn(),
      joinConfig: { channelId: 'voice-classic', guildId: 'guild-classic' },
      receiver: { speaking: new EventEmitter(), subscribe: vi.fn() },
      state: { status: 'ready' },
      subscribe: vi.fn((candidate: object) => {
        subscribedPlayers.add(candidate)
        return { unsubscribe }
      }),
    })
    const channel = createMock<BaseGuildVoiceChannel>({
      guild: { id: 'guild-classic', members: { me: undefined }, voiceAdapterCreator: {} },
      id: 'voice-classic',
      members: new Map(),
    })
    const manager = createManager()
    const abortController = new AbortController()
    voiceMocks.createAudioPlayer.mockReturnValue(createMock<AudioPlayer>(player))
    voiceMocks.createAudioResource.mockReturnValue(createMock<AudioResource<null>>({ synthetic: 'classic-resource' }))
    voiceMocks.joinVoiceChannel.mockReturnValue(createMock<VoiceConnection>(connection))

    await manager.joinChannel(createMock<ChatInputCommandInteraction>({ reply: vi.fn(async () => {}) }), channel)
    await manager.playAudioStream(
      createMock<VoiceConnection>(connection),
      NodeReadable.from(Buffer.from('synthetic-ogg-opus')),
      abortController.signal,
      { channelId: 'voice-classic', generation: 1, guildId: 'guild-classic' },
      Number.MAX_SAFE_INTEGER,
    )
    if (cleanup === 'abort')
      abortController.abort(new Error('synthetic classic cancellation'))
    else if (cleanup === 'idle')
      player.emit('stateChange', { status: 'playing' }, { status: 'idle' })
    else
      manager.leaveChannel(channel)

    expect(connection.subscribe).toHaveBeenCalledWith(player)
    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(subscribedPlayers).toEqual(new Set())
    expect(player.stop).toHaveBeenCalledOnce()
    manager.leaveChannel(channel)
    expect(unsubscribe).toHaveBeenCalledOnce()
    await manager.stop()
  })
})
