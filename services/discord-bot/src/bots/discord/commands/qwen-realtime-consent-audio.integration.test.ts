import type { BaseGuildVoiceChannel, ButtonInteraction, ChatInputCommandInteraction, Client as DiscordClient, GuildMember } from 'discord.js'

import type { VoiceDiagnosticSignal, VoiceDiagnosticsObserver } from './voiceDiagnostics'

import { Buffer } from 'node:buffer'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { QwenRealtimeRuntime, resolveQwenRealtimeConfig } from '../../../standalone/qwen-realtime'
import { createOpusPcm16Fixture } from '../../../test/pcmFixtures'
import { VoiceManager } from './summon'

const voiceMocks = vi.hoisted(() => ({
  entersState: vi.fn(async () => undefined),
  getVoiceConnections: vi.fn(() => new Map()),
  joinVoiceChannel: vi.fn(),
}))

vi.mock('@discordjs/voice', () => ({
  entersState: voiceMocks.entersState,
  getVoiceConnections: voiceMocks.getVoiceConnections,
  joinVoiceChannel: voiceMocks.joinVoiceChannel,
  NoSubscriberBehavior: { Pause: 'pause' },
  StreamType: { Raw: 'raw' },
  VoiceConnectionStatus: {
    Connecting: 'connecting',
    Destroyed: 'destroyed',
    Disconnected: 'disconnected',
    Ready: 'ready',
    Signalling: 'signalling',
  },
}))

class FakeQwenSocket extends EventEmitter {
  readonly sent: string[] = []
  bufferedAmount = 0
  readyState = 0

  close = vi.fn((code = 1000, reason = 'closed') => {
    this.readyState = 3
    this.emit('close', code, Buffer.from(reason))
  })

  onClose(listener: (code: number, reason: Buffer) => void) {
    this.on('close', listener)
  }

  onError(listener: (error: Error) => void) {
    this.on('error', listener)
  }

  onMessage(listener: (message: Buffer) => void) {
    this.on('message', listener)
  }

  onOpen(listener: () => void) {
    this.on('open', listener)
  }

  send(data: string) {
    this.sent.push(data)
  }

  ready() {
    this.readyState = 1
    this.emit('open')
    this.emit('message', Buffer.from(JSON.stringify({ event_id: 'session-configured', type: 'session.updated' })))
  }
}

function asMock<T extends object>(value: object): T {
  return value as T
}

function socketEvents(socket: FakeQwenSocket, type: string) {
  return socket.sent
    .map(frame => JSON.parse(frame) as { type?: string })
    .filter(frame => frame.type === type)
}

/** Narrows public diagnostics that own an anonymous capture or provider turn. */
function hasTurnSequence(signal: VoiceDiagnosticSignal): signal is VoiceDiagnosticSignal & { readonly turnSequence: number } {
  return 'turnSequence' in signal
}

/** Compares an allowlisted future diagnostic stage without bypassing its current public union. */
function hasDiagnosticStage(signal: { readonly stage: string }, stage: string): boolean {
  return signal.stage === stage
}

interface PublicVoiceHarness {
  readonly channel: BaseGuildVoiceChannel
  readonly connection: EventEmitter & { destroy: ReturnType<typeof vi.fn>, receiver: { speaking: EventEmitter, subscribe: ReturnType<typeof vi.fn> } }
  readonly diagnostics: VoiceDiagnosticSignal[]
  readonly joinCallsBeforeFreshParticipantOptIn: number
  readonly manager: VoiceManager
  readonly secondSpeaker?: GuildMember
  readonly socket: FakeQwenSocket
  readonly speaker: GuildMember
  readonly streams: PassThrough[]
  readonly wrongUser: ButtonInteraction
}

async function createPublicVoiceHarness(options: { includeSecondSpeaker?: boolean, requireFreshAttackerConsent?: boolean } = {}): Promise<PublicVoiceHarness> {
  const socket = new FakeQwenSocket()
  const streams: PassThrough[] = []
  const receiver = {
    speaking: new EventEmitter(),
    subscribe: vi.fn(() => {
      const stream = new PassThrough()
      streams.push(stream)
      return stream
    }),
  }
  const connection = Object.assign(new EventEmitter(), {
    destroy: vi.fn(),
    joinConfig: { channelId: 'voice', guildId: 'guild' },
    receiver,
    state: { status: 'ready' },
    subscribe: vi.fn(() => ({ unsubscribe: vi.fn() })),
  })
  voiceMocks.joinVoiceChannel.mockReturnValue(connection)

  const guild = {
    id: 'guild',
    members: {
      fetch: vi.fn(),
      me: undefined,
    },
    name: 'Guild',
    voiceAdapterCreator: {},
  }
  const speaker = asMock<GuildMember>({
    displayName: 'Speaker',
    guild,
    id: 'speaker',
    nickname: null,
    user: { bot: false },
    voice: { channelId: 'voice', sessionId: 'speaker-session-stable' },
  })
  const attacker = asMock<GuildMember>({
    displayName: 'Attacker',
    guild,
    id: 'attacker',
    nickname: null,
    user: { bot: false },
    voice: { channelId: 'voice', sessionId: 'attacker-session-stable' },
  })
  const secondSpeaker = asMock<GuildMember>({
    displayName: 'Second speaker',
    guild,
    id: 'speaker-2',
    nickname: null,
    user: { bot: false },
    voice: { channelId: 'voice', sessionId: 'speaker-2-session-stable' },
  })
  guild.members.fetch.mockImplementation(async (userId: string) => userId === secondSpeaker.id ? secondSpeaker : speaker)
  const channel = asMock<BaseGuildVoiceChannel>({
    guild,
    id: 'voice',
    members: new Map(options.includeSecondSpeaker ? [['speaker', speaker], [secondSpeaker.id, secondSpeaker]] : [['speaker', speaker]]),
    name: 'voice',
  })
  const diagnostics: VoiceDiagnosticSignal[] = []
  const observer: VoiceDiagnosticsObserver = {
    record: signal => diagnostics.push(signal),
    runtimeSequence: 1,
  }
  const runtime = new QwenRealtimeRuntime(resolveQwenRealtimeConfig({
    AIRI_DISCORD_VOICE_CALL_MODE: 'qwen-realtime',
    DASHSCOPE_API_KEY: 'synthetic-key',
    QWEN_REALTIME_VAD_SILENCE_DURATION_MS: '200',
    QWEN_REALTIME_WORKSPACE_ID: 'synthetic-workspace',
  }), { socketFactory: () => socket })
  const manager = new VoiceManager(
    asMock<DiscordClient>({ user: { id: 'bot' } }),
    async () => undefined,
    async () => '',
    runtime,
    undefined,
    undefined,
    undefined,
    observer,
  )
  const summon = asMock<ChatInputCommandInteraction>({
    editReply: vi.fn(async () => undefined),
    id: 'summon-1',
    inCachedGuild: () => true,
    member: { voice: { channel } },
    reply: vi.fn(async () => undefined),
  })

  await manager.handleJoinChannelCommand(summon)
  expect(voiceMocks.joinVoiceChannel).not.toHaveBeenCalled()

  const wrongUser = asMock<ButtonInteraction>({
    customId: 'airi:voice-consent:opt-in:guild-summon-1',
    guildId: 'guild',
    inCachedGuild: () => true,
    member: { voice: { channelId: 'voice', sessionId: 'attacker-session' } },
    reply: vi.fn(async () => undefined),
    update: vi.fn(async () => undefined),
    user: { id: 'attacker' },
  })
  await manager.handleConsentInteraction(wrongUser)
  expect(receiver.subscribe).not.toHaveBeenCalled()
  expect(voiceMocks.joinVoiceChannel).not.toHaveBeenCalled()

  if (options.requireFreshAttackerConsent)
    channel.members.set(attacker.id, attacker)

  const speakerOptIn = manager.handleConsentInteraction(asMock<ButtonInteraction>({
    customId: 'airi:voice-consent:opt-in:guild-summon-1',
    followUp: vi.fn(async () => undefined),
    guildId: 'guild',
    inCachedGuild: () => true,
    member: { voice: { channelId: 'voice', sessionId: 'speaker-session-stable' } },
    reply: vi.fn(async () => undefined),
    update: vi.fn(async () => undefined),
    user: { id: 'speaker' },
  }))
  if (options.includeSecondSpeaker) {
    await vi.runAllTicks()
    const secondSpeakerOptIn = manager.handleConsentInteraction(asMock<ButtonInteraction>({
      customId: 'airi:voice-consent:opt-in:guild-summon-1',
      guildId: 'guild',
      inCachedGuild: () => true,
      member: { voice: { channelId: 'voice', sessionId: 'speaker-2-session-stable' } },
      reply: vi.fn(async () => undefined),
      update: vi.fn(async () => undefined),
      user: { id: secondSpeaker.id },
    }))
    await waitForJoinedVoiceConnection()
    socket.ready()
    await Promise.all([speakerOptIn, secondSpeakerOptIn])
    return { channel, connection, diagnostics, joinCallsBeforeFreshParticipantOptIn: 0, manager, secondSpeaker, socket, speaker, streams, wrongUser }
  }
  if (!options.requireFreshAttackerConsent) {
    await waitForJoinedVoiceConnection()
    socket.ready()
    await speakerOptIn
  }
  else {
    await vi.runAllTicks()
    const joinCallsBeforeFreshParticipantOptIn = voiceMocks.joinVoiceChannel.mock.calls.length
    if (joinCallsBeforeFreshParticipantOptIn > 0) {
      socket.ready()
      await speakerOptIn
    }
    else {
      await speakerOptIn
      const attackerOptIn = manager.handleConsentInteraction(asMock<ButtonInteraction>({
        customId: 'airi:voice-consent:opt-in:guild-summon-1',
        guildId: 'guild',
        inCachedGuild: () => true,
        member: { voice: { channelId: 'voice', sessionId: 'attacker-session-stable' } },
        update: vi.fn<() => Promise<void>>(async () => undefined),
        user: { id: 'attacker' },
      }))
      await waitForJoinedVoiceConnection()
      socket.ready()
      await attackerOptIn
    }

    // Retained below so the public test can distinguish a rejected click from
    // a latent write that would let a participant join without opting in.
    return { channel, connection, diagnostics, joinCallsBeforeFreshParticipantOptIn, manager, socket, speaker, streams, wrongUser }
  }

  // A stale Discord voice identity may not enter the receiver path after the
  // participant has given consent for a different immutable voice session.
  speaker.voice.sessionId = 'speaker-session-stale'
  receiver.speaking.emit('start', 'speaker')
  await vi.runAllTicks()
  expect(receiver.subscribe).not.toHaveBeenCalled()
  speaker.voice.sessionId = 'speaker-session-stable'

  return { channel, connection, diagnostics, joinCallsBeforeFreshParticipantOptIn: 0, manager, socket, speaker, streams, wrongUser }
}

async function startPublicTurn(harness: PublicVoiceHarness) {
  harness.connection.receiver.speaking.emit('start', harness.speaker.id)
  await vi.waitFor(() => expect(harness.streams).toHaveLength(1))
  return harness.streams[0]
}

async function waitForJoinedVoiceConnection() {
  await vi.waitFor(() => expect(voiceMocks.joinVoiceChannel).toHaveBeenCalledOnce())
}

async function finishPublicTurn(harness: PublicVoiceHarness) {
  harness.connection.receiver.speaking.emit('end', harness.speaker.id)
  await vi.advanceTimersByTimeAsync(200)
}

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

/**
 * Exercises consent, Discord receiver Opus decoding, PCM gating, and Qwen's public socket protocol.
 *
 * Follow-up browser E2E specification only: invoke the real UI command by mentioning the current bot,
 * or reply to an actual bot message; do not imitate a command interaction in the browser.
 */
describe('qwen realtime consented Discord audio public path', () => {
  /** @example it('rejects a non-participant consent click without persisting it before the real participant opts in', async () => {}) */
  it('rejects a non-participant consent click without persisting it before the real participant opts in', async () => {
    vi.useFakeTimers()
    const harness = await createPublicVoiceHarness()

    expect(harness.wrongUser.reply).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      content: expect.stringMatching(/no longer active/i),
      ephemeral: true,
    }))
    expect(harness.wrongUser.update).not.toHaveBeenCalled()
    // The harness reaches its joined state only through the speaker's later,
    // valid opt-in; a forged click cannot consume the participant's consent.
    expect(voiceMocks.joinVoiceChannel).toHaveBeenCalledOnce()
    await harness.manager.stop()
  })

  /** @example it('requires a forged non-participant to submit a fresh participant opt-in before connecting', async () => {}) */
  it('requires a forged non-participant to submit a fresh participant opt-in before connecting', async () => {
    vi.useFakeTimers()
    const harness = await createPublicVoiceHarness({ requireFreshAttackerConsent: true })

    expect(harness.wrongUser.reply).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      content: expect.stringMatching(/no longer active/i),
      ephemeral: true,
    }))
    expect(harness.joinCallsBeforeFreshParticipantOptIn).toBe(0)
    expect(voiceMocks.joinVoiceChannel).toHaveBeenCalledOnce()
    await harness.manager.stop()
  })

  /** @example it('terra high accepts fragmented conversational PCM after public consent', async () => {}) */
  it('terra high accepts fragmented conversational PCM after public consent', async () => {
    vi.useFakeTimers()
    const harness = await createPublicVoiceHarness()
    const stream = await startPublicTurn(harness)
    const packets = createOpusPcm16Fixture()

    // ROOT CAUSE:
    //
    // Conversational Discord speech can contain a single quiet 20 ms Opus frame
    // between five loud frames. PCM decoding succeeds for every packet, but the
    // local admission currently clears the entire 120 ms energetic window on
    // that short dip, so Qwen receives neither user PCM nor a finishable input turn.
    for (let burst = 0; burst < 3; burst += 1) {
      for (let frame = 0; frame < 5; frame += 1)
        stream.write(packets.nextSpeechPacket(4_000))
      stream.write(packets.nextLowNoisePacket())
    }
    await vi.waitFor(() => expect(harness.diagnostics.some(signal => signal.stage === 'receiver-audio')).toBe(true))

    /** @example expect(socketEvents(socket, 'input_audio_buffer.append').length).toBeGreaterThan(0) */
    expect(socketEvents(harness.socket, 'input_audio_buffer.append').length).toBeGreaterThan(0)
    const userAppendCount = socketEvents(harness.socket, 'input_audio_buffer.append').length

    await finishPublicTurn(harness)
    expect(socketEvents(harness.socket, 'input_audio_buffer.append').length).toBeGreaterThan(userAppendCount)
    harness.socket.emit('message', Buffer.from(JSON.stringify({ event_id: 'input-a-committed', item_id: 'input-a', type: 'input_audio_buffer.committed' })))
    await vi.runAllTicks()
    expect(harness.diagnostics.some(signal => signal.stage === 'provider-input-committed')).toBe(true)

    await harness.manager.stop()
  })

  /** @example it('keeps sustained low-noise PCM out of Qwen after public consent', async () => {}) */
  it('keeps sustained low-noise PCM out of Qwen after public consent', async () => {
    vi.useFakeTimers()
    const harness = await createPublicVoiceHarness()
    const stream = await startPublicTurn(harness)
    const packets = createOpusPcm16Fixture()
    for (let frame = 0; frame < 12; frame += 1)
      stream.write(packets.nextLowNoisePacket())
    await vi.waitFor(() => expect(harness.diagnostics.some(signal => signal.stage === 'receiver-audio')).toBe(true))

    await finishPublicTurn(harness)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(socketEvents(harness.socket, 'input_audio_buffer.append')).toHaveLength(0)
    expect(socketEvents(harness.socket, 'input_audio_buffer.commit')).toHaveLength(0)
    expect(harness.diagnostics.some(signal => signal.stage === 'provider-input-finished')).toBe(false)
    expect(harness.diagnostics.some(signal => signal.stage === 'provider-input-committed')).toBe(false)
    expect(harness.diagnostics.some(signal => signal.stage === 'provider-response-created')).toBe(false)
    expect(harness.diagnostics.some(signal => signal.stage === 'playback-started')).toBe(false)

    await harness.manager.stop()
  })

  /** @example it('does not finish an empty Qwen capture after its terminal gate result', async () => {}) */
  it('does not finish an empty Qwen capture after its terminal gate result', async () => {
    vi.useFakeTimers()
    const harness = await createPublicVoiceHarness()
    await startPublicTurn(harness)

    // ROOT CAUSE:
    //
    // Speaking end used to queue and finish a provider aggregate after the
    // local terminal gate rejected an empty capture. Qwen could then receive
    // synthetic silence and create a turn with no admitted user PCM.
    await finishPublicTurn(harness)
    await vi.advanceTimersByTimeAsync(1_000)

    expect(socketEvents(harness.socket, 'input_audio_buffer.append')).toEqual([])
    expect(socketEvents(harness.socket, 'input_audio_buffer.commit')).toEqual([])
    expect(harness.diagnostics.some(signal => hasDiagnosticStage(signal, 'local-input-rejected:no-samples'))).toBe(true)
    expect(harness.diagnostics.some(signal => signal.stage === 'provider-input-finished')).toBe(false)
    expect(harness.diagnostics.some(signal => signal.stage === 'provider-input-committed')).toBe(false)
    expect(harness.diagnostics.some(signal => signal.stage === 'provider-response-created')).toBe(false)
    expect(harness.diagnostics.some(signal => signal.stage === 'playback-started')).toBe(false)
    await harness.manager.stop()
  })

  /** @example it('admits representative speech after a low-noise prefix and appends it to Qwen', async () => {}) */
  it('admits representative speech after a low-noise prefix and appends it to Qwen', async () => {
    vi.useFakeTimers()
    const harness = await createPublicVoiceHarness()
    const stream = await startPublicTurn(harness)
    const packets = createOpusPcm16Fixture()

    // ROOT CAUSE:
    //
    // A low-noise prefix is common when Discord opens a participant stream.
    // It must not permanently poison a later energetic capture; Qwen receives
    // the admitted PCM through the same append path as a capture without prefix.
    for (let frame = 0; frame < 10; frame += 1)
      stream.write(packets.nextLowNoisePacket())
    for (let frame = 0; frame < 6; frame += 1)
      stream.write(packets.nextSpeechPacket(4_000))

    await vi.waitFor(() => expect(socketEvents(harness.socket, 'input_audio_buffer.append').length).toBeGreaterThan(0))
    expect(harness.diagnostics.some(signal => hasDiagnosticStage(signal, 'local-input-admitted'))).toBe(true)
    await harness.manager.stop()
  })

  /** @example it('does not synthesize a provider response from local energetic admission', async () => {}) */
  it('does not synthesize a provider response from local energetic admission', async () => {
    vi.useFakeTimers()
    const harness = await createPublicVoiceHarness()
    const stream = await startPublicTurn(harness)
    const packets = createOpusPcm16Fixture()

    // The fixture establishes only that energetic PCM may reach Qwen's input
    // buffer. This harness deliberately emits no provider VAD, commit, or
    // response event, so it cannot make claims about provider semantics.
    for (let frame = 0; frame < 6; frame += 1)
      stream.write(packets.nextEnergeticAcPacket())
    await vi.waitFor(() => expect(socketEvents(harness.socket, 'input_audio_buffer.append').length).toBeGreaterThan(0))

    expect(socketEvents(harness.socket, 'response.create')).toEqual([])
    expect(harness.diagnostics.some(signal => signal.stage === 'provider-response-created')).toBe(false)
    expect(harness.diagnostics.some(signal => signal.stage === 'provider-response-audio')).toBe(false)
    expect(harness.diagnostics.some(signal => signal.stage === 'playback-started')).toBe(false)
    await harness.manager.stop()
  })

  /** @example it('accepts sustained boundary conversational PCM after public consent', async () => {}) */
  it('accepts sustained boundary conversational PCM after public consent', async () => {
    vi.useFakeTimers()
    const harness = await createPublicVoiceHarness()
    const stream = await startPublicTurn(harness)
    const packets = createOpusPcm16Fixture()
    for (let frame = 0; frame < 6; frame += 1)
      stream.write(packets.nextSpeechPacket())

    await vi.waitFor(() => expect(socketEvents(harness.socket, 'input_audio_buffer.append').length).toBeGreaterThan(0))
    await finishPublicTurn(harness)
    harness.socket.emit('message', Buffer.from(JSON.stringify({ event_id: 'input-boundary-committed', item_id: 'input-boundary', type: 'input_audio_buffer.committed' })))
    await vi.runAllTicks()
    expect(harness.diagnostics.some(signal => signal.stage === 'provider-input-committed')).toBe(true)

    await harness.manager.stop()
  })

  /** @example it('excludes rejected captures from a later provider aggregate contributor list', async () => {}) */
  it('excludes rejected captures from a later provider aggregate contributor list', async () => {
    vi.useFakeTimers()
    const harness = await createPublicVoiceHarness()
    const stream = await startPublicTurn(harness)
    const packets = createOpusPcm16Fixture()

    // ROOT CAUSE:
    //
    // Speaking boundaries and provider contributors are not the same thing.
    // A rejected capture has no successful user-audio append, so retaining its
    // turn in the finished queue makes a later provider commit claim PCM it
    // never received.
    for (let frame = 0; frame < 12; frame += 1)
      stream.write(packets.nextLowNoisePacket())
    await finishPublicTurn(harness)

    harness.connection.receiver.speaking.emit('start', harness.speaker.id)
    await vi.runAllTicks()
    for (let frame = 0; frame < 6; frame += 1)
      stream.write(packets.nextSpeechPacket())
    await vi.waitFor(() => expect(socketEvents(harness.socket, 'input_audio_buffer.append').length).toBeGreaterThan(0))
    await finishPublicTurn(harness)

    harness.socket.emit('message', Buffer.from(JSON.stringify({ event_id: 'successful-input-only-committed', item_id: 'successful-input-only', type: 'input_audio_buffer.committed' })))
    await vi.runAllTicks()
    const [commit] = harness.diagnostics.filter(signal => signal.stage === 'provider-input-committed')
    if (!commit || !hasTurnSequence(commit))
      throw new Error('A successful user-audio aggregate must produce one committed provider input.')
    expect(commit).toEqual(expect.objectContaining({
      aggregateTurnSequence: 2,
      captureTurnSequences: [2],
      runtimeSequence: 1,
      sessionSequence: 1,
      turnSequence: 2,
    }))
    await harness.manager.stop()
  })

  /** @example it('keeps one production receive stream alive while assigning each speaking boundary to a new turn', async () => {}) */
  it('keeps one production receive stream alive while assigning each speaking boundary to a new turn', async () => {
    vi.useFakeTimers()
    const harness = await createPublicVoiceHarness()
    const stream = await startPublicTurn(harness)
    const packets = createOpusPcm16Fixture()

    for (let frame = 0; frame < 6; frame += 1)
      stream.write(packets.nextSpeechPacket())
    await vi.waitFor(() => expect(socketEvents(harness.socket, 'input_audio_buffer.append')).not.toHaveLength(0))
    await finishPublicTurn(harness)
    harness.socket.emit('message', Buffer.from(JSON.stringify({ event_id: 'turn-1-committed', item_id: 'turn-1', type: 'input_audio_buffer.committed' })))

    // The Discord receiver owns this stream. Speaking boundaries define turns;
    // a test must not end the transport stream to manufacture Turn 2.
    harness.connection.receiver.speaking.emit('start', harness.speaker.id)
    await vi.runAllTicks()
    expect(harness.streams).toHaveLength(1)
    for (let frame = 0; frame < 6; frame += 1)
      stream.write(packets.nextSpeechPacket())
    await vi.waitFor(() => expect(socketEvents(harness.socket, 'input_audio_buffer.append').length).toBeGreaterThan(6))
    await finishPublicTurn(harness)
    harness.socket.emit('message', Buffer.from(JSON.stringify({ event_id: 'turn-2-committed', item_id: 'turn-2', type: 'input_audio_buffer.committed' })))
    await vi.runAllTicks()

    const admittedTurns = harness.diagnostics.reduce<number[]>((turns, signal) => {
      if (hasDiagnosticStage(signal, 'local-input-admitted') && hasTurnSequence(signal))
        turns.push(signal.turnSequence)
      return turns
    }, [])
    expect(admittedTurns).toEqual([1, 2])
    await harness.manager.stop()
  })

  /** @example it('assigns concurrent consented speakers distinct capture sequences before one aggregate commit', async () => {}) */
  it('assigns concurrent consented speakers distinct capture sequences before one aggregate commit', async () => {
    vi.useFakeTimers()
    const harness = await createPublicVoiceHarness({ includeSecondSpeaker: true })
    if (!harness.secondSpeaker)
      throw new Error('The two-speaker harness must retain both public consent participants.')
    const firstSpeakerPackets = createOpusPcm16Fixture()
    const secondSpeakerPackets = createOpusPcm16Fixture()

    // ROOT CAUSE:
    //
    // A channel-level provider aggregate can receive audio from overlapping
    // consented speakers. Capture ownership still belongs to each Discord
    // speaking boundary, so the public diagnostics sequence must increase once
    // per accepted boundary rather than reuse an aggregate or consent-session
    // number.
    harness.connection.receiver.speaking.emit('start', harness.speaker.id)
    harness.connection.receiver.speaking.emit('start', harness.secondSpeaker.id)
    await vi.waitFor(() => expect(harness.streams).toHaveLength(2))
    for (let frame = 0; frame < 8; frame += 1) {
      harness.streams[0].write(firstSpeakerPackets.nextSpeechPacket())
      harness.streams[1].write(secondSpeakerPackets.nextSpeechPacket())
    }
    await vi.waitFor(() => expect(harness.diagnostics
      .reduce<number[]>((turns, signal) => {
        if (signal.stage === 'provider-input-appended' && signal.inputKind === 'user-audio')
          turns.push(signal.turnSequence)
        return turns
      }, [])
      .filter((turnSequence, index, turns) => turns.indexOf(turnSequence) === index)
      .sort((left, right) => left - right)).toEqual([1, 2]))
    harness.connection.receiver.speaking.emit('end', harness.speaker.id)
    await vi.runAllTicks()
    for (let frame = 0; frame < 3; frame += 1)
      harness.streams[1].write(secondSpeakerPackets.nextSpeechPacket())
    harness.connection.receiver.speaking.emit('end', harness.secondSpeaker.id)
    await vi.runAllTicks()

    harness.socket.emit('message', Buffer.from(JSON.stringify({ event_id: 'concurrent-aggregate-1-committed', item_id: 'concurrent-aggregate-1', type: 'input_audio_buffer.committed' })))
    await vi.runAllTicks()

    expect(harness.diagnostics
      .filter((signal): signal is VoiceDiagnosticSignal & { readonly turnSequence: number } => {
        return signal.stage === 'speaking-started' && hasTurnSequence(signal)
      })
      .map(signal => signal.turnSequence)).toEqual([1, 2])
    const [commit] = harness.diagnostics.filter(signal => signal.stage === 'provider-input-committed')
    if (!commit || !hasTurnSequence(commit))
      throw new Error('A concurrent provider aggregate must retain an owning capture turn.')
    expect(commit).toEqual(expect.objectContaining({
      aggregateTurnSequence: 1,
      captureTurnSequences: [1, 2],
      runtimeSequence: 1,
      sessionSequence: 1,
      stage: 'provider-input-committed',
      turnSequence: 1,
    }))
    await harness.manager.stop()
  })

  /** @example it('keeps a successful concurrent aggregate when another capture is rejected', async () => {}) */
  it('keeps a successful concurrent aggregate when another capture is rejected', async () => {
    vi.useFakeTimers()
    const harness = await createPublicVoiceHarness({ includeSecondSpeaker: true })
    if (!harness.secondSpeaker)
      throw new Error('The two-speaker harness must retain both public consent participants.')
    const admittedPackets = createOpusPcm16Fixture()
    const rejectedPackets = createOpusPcm16Fixture()

    // ROOT CAUSE:
    //
    // A rejected concurrent capture owns no user-audio append. Treating its
    // speaking end as a provider aggregate failure clears the independent
    // admitted capture that is still waiting for Qwen's commit.
    harness.connection.receiver.speaking.emit('start', harness.speaker.id)
    harness.connection.receiver.speaking.emit('start', harness.secondSpeaker.id)
    await vi.waitFor(() => expect(harness.streams).toHaveLength(2))
    for (let frame = 0; frame < 6; frame += 1)
      harness.streams[0].write(admittedPackets.nextSpeechPacket())
    for (let frame = 0; frame < 12; frame += 1)
      harness.streams[1].write(rejectedPackets.nextLowNoisePacket())
    await vi.waitFor(() => expect(harness.diagnostics.some((signal) => {
      return signal.stage === 'provider-input-appended' && signal.inputKind === 'user-audio' && hasTurnSequence(signal) && signal.turnSequence === 1
    })).toBe(true))
    const successfulAppendCount = socketEvents(harness.socket, 'input_audio_buffer.append').length

    harness.connection.receiver.speaking.emit('end', harness.secondSpeaker.id)
    await vi.runAllTicks()
    expect(socketEvents(harness.socket, 'input_audio_buffer.append')).toHaveLength(successfulAppendCount)
    expect(socketEvents(harness.socket, 'input_audio_buffer.clear')).toEqual([])

    harness.connection.receiver.speaking.emit('end', harness.speaker.id)
    await vi.runAllTicks()
    harness.socket.emit('message', Buffer.from(JSON.stringify({ event_id: 'concurrent-success-only-committed', item_id: 'concurrent-success-only', type: 'input_audio_buffer.committed' })))
    await vi.runAllTicks()

    const commits = harness.diagnostics.filter(signal => signal.stage === 'provider-input-committed')
    expect(commits).toHaveLength(1)
    expect(commits[0]).toEqual(expect.objectContaining({
      aggregateTurnSequence: 1,
      captureTurnSequences: [1],
      runtimeSequence: 1,
      sessionSequence: 1,
      turnSequence: 1,
    }))
    await harness.manager.stop()
  })

  /** @example it('assigns delayed-provider rapid speaking boundaries to distinct diagnostics on one Manual receive stream', async () => {}) */
  it('assigns delayed-provider rapid speaking boundaries to distinct diagnostics on one Manual receive stream', async () => {
    vi.useFakeTimers()
    const harness = await createPublicVoiceHarness()
    const stream = await startPublicTurn(harness)
    const packets = createOpusPcm16Fixture()

    for (let index = 0; index < 6; index += 1)
      stream.write(packets.nextSpeechPacket())
    await vi.waitFor(() => expect(socketEvents(harness.socket, 'input_audio_buffer.append')).not.toHaveLength(0))
    harness.connection.receiver.speaking.emit('end', harness.speaker.id)
    await vi.runAllTicks()

    // Do not manufacture a provider commit between Discord speaking turns.
    // The live Manual stream must allocate the next ownership before Qwen
    // acknowledges the previous aggregate input buffer.
    harness.connection.receiver.speaking.emit('start', harness.speaker.id)
    await vi.runAllTicks()
    for (let index = 0; index < 6; index += 1)
      stream.write(packets.nextSpeechPacket())
    await vi.waitFor(() => expect(socketEvents(harness.socket, 'input_audio_buffer.append').length).toBeGreaterThan(6))
    harness.connection.receiver.speaking.emit('end', harness.speaker.id)
    await vi.runAllTicks()

    harness.connection.receiver.speaking.emit('start', harness.speaker.id)
    await vi.runAllTicks()
    for (let index = 0; index < 6; index += 1)
      stream.write(packets.nextSpeechPacket())
    await vi.waitFor(() => expect(socketEvents(harness.socket, 'input_audio_buffer.append').length).toBeGreaterThan(12))
    harness.connection.receiver.speaking.emit('end', harness.speaker.id)
    await vi.runAllTicks()

    const boundaryDiagnostics = harness.diagnostics
      .filter((signal): signal is VoiceDiagnosticSignal & { turnSequence: number } => {
        return 'turnSequence' in signal && [
          'local-input-admitted',
          'provider-input-finished',
          'speaking-ended',
          'speaking-started',
        ].includes(signal.stage)
      })
      .map(signal => ({ stage: signal.stage, turnSequence: signal.turnSequence }))

    expect(boundaryDiagnostics).toEqual([
      { stage: 'speaking-started', turnSequence: 1 },
      { stage: 'local-input-admitted', turnSequence: 1 },
      { stage: 'speaking-ended', turnSequence: 1 },
      { stage: 'provider-input-finished', turnSequence: 1 },
      { stage: 'speaking-started', turnSequence: 2 },
      { stage: 'local-input-admitted', turnSequence: 2 },
      { stage: 'speaking-ended', turnSequence: 2 },
      { stage: 'provider-input-finished', turnSequence: 2 },
      { stage: 'speaking-started', turnSequence: 3 },
      { stage: 'local-input-admitted', turnSequence: 3 },
      { stage: 'speaking-ended', turnSequence: 3 },
      { stage: 'provider-input-finished', turnSequence: 3 },
    ])
    await harness.manager.stop()
  })

  /** @example it('projects one provider aggregate onto every rapid public capture exactly once', async () => {}) */
  it('projects one provider aggregate onto every rapid public capture exactly once', async () => {
    vi.useFakeTimers()
    const harness = await createPublicVoiceHarness()
    const stream = await startPublicTurn(harness)
    const packets = createOpusPcm16Fixture()

    // ROOT CAUSE:
    //
    // Qwen accepts audio through one debounced aggregate buffer, while Discord
    // exposes three completed speaking captures before the provider commits.
    // The old correlation chose aggregate turn 1 for every append, then a
    // commit consumed only 1 and left 2/3 claimable by an unsolicited callback.
    // Public diagnostics need to expose the aggregate-to-captures association;
    // private manager queues cannot be the contract for dashboard consumers.
    for (let capture = 0; capture < 3; capture += 1) {
      for (let frame = 0; frame < 6; frame += 1)
        stream.write(packets.nextSpeechPacket())
      harness.connection.receiver.speaking.emit('end', harness.speaker.id)
      await vi.runAllTicks()
      if (capture < 2) {
        harness.connection.receiver.speaking.emit('start', harness.speaker.id)
        await vi.runAllTicks()
      }
    }

    harness.socket.emit('message', Buffer.from(JSON.stringify({ event_id: 'aggregate-1-committed', item_id: 'aggregate-1', type: 'input_audio_buffer.committed' })))
    await vi.runAllTicks()
    const commits = harness.diagnostics.filter(signal => signal.stage === 'provider-input-committed')

    expect(commits).toHaveLength(1)
    const [commit] = commits
    if (!commit || !hasTurnSequence(commit))
      throw new Error('A provider commit must retain its public anonymous turn identity.')
    expect(commit.runtimeSequence).toBe(1)
    expect(commit.sessionSequence).toBe(1)
    expect(commit.stage).toBe('provider-input-committed')
    expect(commit.turnSequence).toBe(1)
    expect(commit).toEqual(expect.objectContaining({
      aggregateTurnSequence: 1,
      captureTurnSequences: [1, 2, 3],
      stage: 'provider-input-committed',
      turnSequence: 1,
    }))

    // The same provider item is idempotent and an uncorrelated item must not
    // claim another finished capture while the aggregate has already committed.
    // Deliberate replay: same item and event instance must be exact-once.
    harness.socket.emit('message', Buffer.from(JSON.stringify({ event_id: 'aggregate-1-committed', item_id: 'aggregate-1', type: 'input_audio_buffer.committed' })))
    harness.socket.emit('message', Buffer.from(JSON.stringify({ event_id: 'unsolicited-2-committed', item_id: 'unsolicited-2', type: 'input_audio_buffer.committed' })))
    await vi.runAllTicks()
    expect(harness.diagnostics.filter(signal => signal.stage === 'provider-input-committed')).toHaveLength(1)
    await harness.manager.stop()
  })

  /** @example it('retains exactly thirty-two increasing public capture contributors', async () => {}) */
  it('retains exactly thirty-two increasing public capture contributors', async () => {
    vi.useFakeTimers()
    const harness = await createPublicVoiceHarness()
    const stream = await startPublicTurn(harness)
    const packets = createOpusPcm16Fixture()

    for (let capture = 1; capture <= 32; capture += 1) {
      for (let frame = 0; frame < 6; frame += 1)
        stream.write(packets.nextSpeechPacket())
      harness.connection.receiver.speaking.emit('end', harness.speaker.id)
      await vi.runAllTicks()
      if (capture < 32) {
        harness.connection.receiver.speaking.emit('start', harness.speaker.id)
        await vi.runAllTicks()
      }
    }

    // ROOT CAUSE:
    //
    // Contributor bounds must be enforced at the source aggregate, where
    // future commits and responses are owned, rather than only when Dashboard
    // projection slices an already-invalid list.
    harness.socket.emit('message', Buffer.from(JSON.stringify({ event_id: 'aggregate-thirty-two-committed', item_id: 'aggregate-thirty-two', type: 'input_audio_buffer.committed' })))
    await vi.runAllTicks()

    const [commit] = harness.diagnostics.filter(signal => signal.stage === 'provider-input-committed')
    if (!commit || !hasTurnSequence(commit))
      throw new Error('The bounded provider aggregate must commit exactly once.')
    expect(commit).toEqual(expect.objectContaining({
      aggregateTurnSequence: 1,
      captureTurnSequences: Array.from({ length: 32 }, (_, index) => index + 1),
      runtimeSequence: 1,
      sessionSequence: 1,
      turnSequence: 1,
    }))
    const finished = harness.diagnostics.reduce<number[]>((turnSequences, signal) => {
      if (signal.stage === 'provider-input-finished' && hasTurnSequence(signal))
        turnSequences.push(signal.turnSequence)
      return turnSequences
    }, [])
    expect(finished).toEqual(Array.from({ length: 32 }, (_, index) => index + 1))
    await harness.manager.stop()
  })

  /** @example it('retires the public provider generation when the thirty-third capture contributes input', async () => {}) */
  it('retires the public provider generation when the thirty-third capture contributes input', async () => {
    vi.useFakeTimers()
    const harness = await createPublicVoiceHarness()
    const stream = await startPublicTurn(harness)
    const packets = createOpusPcm16Fixture()

    for (let capture = 1; capture <= 33; capture += 1) {
      for (let frame = 0; frame < 6; frame += 1)
        stream.write(packets.nextSpeechPacket())
      harness.connection.receiver.speaking.emit('end', harness.speaker.id)
      await vi.runAllTicks()
      if (capture < 33) {
        harness.connection.receiver.speaking.emit('start', harness.speaker.id)
        await vi.runAllTicks()
      }
    }

    // ROOT CAUSE:
    //
    // Truncating a 33-entry source aggregate in Dashboard projection preserves
    // an invalid provider buffer that can later commit with a false [1..32]
    // ownership record. Capacity is an admission boundary: the 33rd successful
    // provider send must retire this generation before any commit can occur.
    expect(harness.socket.close).toHaveBeenCalledOnce()
    harness.socket.emit('message', Buffer.from(JSON.stringify({ event_id: 'aggregate-overflow-committed', item_id: 'aggregate-overflow', type: 'input_audio_buffer.committed' })))
    await vi.runAllTicks()
    expect(harness.diagnostics.filter(signal => signal.stage === 'provider-input-committed')).toHaveLength(0)
    expect(harness.connection.destroy).toHaveBeenCalledOnce()
    await harness.manager.stop()
    expect(harness.socket.close).toHaveBeenCalledOnce()
  })

  /** @example it('does not commit a provider utterance after audio backpressure rejects every append', async () => {}) */
  it('does not commit a provider utterance after audio backpressure rejects every append', async () => {
    vi.useFakeTimers()
    const harness = await createPublicVoiceHarness()
    const stream = await startPublicTurn(harness)
    const packets = createOpusPcm16Fixture()

    // ROOT CAUSE:
    //
    // appendAudio returning false was logged once and then ignored. The capture
    // still finished and committed an aggregate whose user PCM had been
    // silently dropped. While the socket remains over its backpressure limit,
    // the observable contract must fail closed rather than commit a partial
    // utterance. A future bounded retry implementation may satisfy this by
    // appending before it permits a commit.
    harness.socket.bufferedAmount = Number.MAX_SAFE_INTEGER
    for (let frame = 0; frame < 6; frame += 1)
      stream.write(packets.nextSpeechPacket())
    await vi.waitFor(() => expect(harness.diagnostics.some(signal => hasDiagnosticStage(signal, 'local-input-admitted'))).toBe(true))

    await finishPublicTurn(harness)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(socketEvents(harness.socket, 'input_audio_buffer.append')).toEqual([])
    expect(socketEvents(harness.socket, 'input_audio_buffer.commit')).toEqual([])
    expect(harness.diagnostics.some(signal => signal.stage === 'provider-input-finished')).toBe(false)
    await harness.manager.stop()
  })

  /** @example it('fails closed exactly once when backpressure begins after a partial provider aggregate', async () => {}) */
  it('fails closed exactly once when backpressure begins after a partial provider aggregate', async () => {
    vi.useFakeTimers()
    const harness = await createPublicVoiceHarness()
    const stream = await startPublicTurn(harness)
    const packets = createOpusPcm16Fixture()

    // ROOT CAUSE:
    //
    // The all-failed case does not cover the unsafe state where some user PCM
    // has already entered Qwen's aggregate and a later append fails. Finishing
    // that aggregate silently turns a truncated utterance into a provider turn;
    // an unsolicited commit/response can then revive it. The public lifecycle
    // must emit one failure and retire the aggregate before any commit or reply.
    for (let frame = 0; frame < 6; frame += 1)
      stream.write(packets.nextSpeechPacket())
    await vi.waitFor(() => expect(socketEvents(harness.socket, 'input_audio_buffer.append').length).toBeGreaterThan(0))
    const successfulAppends = socketEvents(harness.socket, 'input_audio_buffer.append').length

    harness.socket.bufferedAmount = Number.MAX_SAFE_INTEGER
    stream.write(packets.nextSpeechPacket())
    await vi.runAllTicks()
    expect(socketEvents(harness.socket, 'input_audio_buffer.append')).toHaveLength(successfulAppends)

    await finishPublicTurn(harness)
    const providerFailures = harness.diagnostics.filter((signal) => {
      return signal.stage === 'failure' && signal.failureCategory === 'provider-error'
    })
    expect(providerFailures).toHaveLength(1)
    expect(harness.diagnostics.some(signal => signal.stage === 'provider-input-finished')).toBe(false)
    expect(socketEvents(harness.socket, 'input_audio_buffer.commit')).toEqual([])
    expect(socketEvents(harness.socket, 'input_audio_buffer.clear')).toHaveLength(1)
    expect(harness.socket.close).toHaveBeenCalledOnce()

    harness.socket.emit('message', Buffer.from(JSON.stringify({ event_id: 'partial-aggregate-committed', item_id: 'partial-aggregate', type: 'input_audio_buffer.committed' })))
    harness.socket.emit('message', Buffer.from(JSON.stringify({ event_id: 'partial-response-created', response: { id: 'partial-response' }, type: 'response.created' })))
    await vi.runAllTicks()
    expect(harness.diagnostics.some(signal => signal.stage === 'provider-input-committed')).toBe(false)
    expect(harness.diagnostics.some(signal => signal.stage === 'provider-response-created')).toBe(false)
    await harness.manager.stop()
  })
})
