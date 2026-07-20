import type { BaseGuildVoiceChannel, ChatInputCommandInteraction, Client as DiscordClient } from 'discord.js'

import type { VoiceDiagnosticSignal, VoiceDiagnosticsObserver } from './voiceDiagnostics'

import { Buffer } from 'node:buffer'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { QwenRealtimeRuntime, resolveQwenRealtimeConfig } from '../../../standalone/qwen-realtime'
import { createOpusPcm16Fixture } from '../../../test/pcmFixtures'
import { VoiceManager } from './summon'

const voiceMocks = vi.hoisted(() => ({
  createAudioPlayer: vi.fn(),
  createAudioResource: vi.fn(),
  entersState: vi.fn(async () => undefined),
  getVoiceConnections: vi.fn(() => new Map()),
  joinVoiceChannel: vi.fn(),
}))

vi.mock('@discordjs/voice', () => ({
  createAudioPlayer: voiceMocks.createAudioPlayer,
  createAudioResource: voiceMocks.createAudioResource,
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

class FakeSocket extends EventEmitter {
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

function emitTurn(socket: FakeSocket, inputId: string, responseId: string) {
  socket.emit('message', Buffer.from(JSON.stringify({ event_id: `${inputId}-committed`, item_id: inputId, type: 'input_audio_buffer.committed' })))
  socket.emit('message', Buffer.from(JSON.stringify({ event_id: `${responseId}-created`, response: { id: responseId }, type: 'response.created' })))
  socket.emit('message', Buffer.from(JSON.stringify({
    delta: Buffer.from([1, 2, 3, 4]).toString('base64'),
    event_id: `${responseId}-audio-delta`,
    response_id: responseId,
    type: 'response.audio.delta',
  })))
  socket.emit('message', Buffer.from(JSON.stringify({ event_id: `${responseId}-done`, response: { id: responseId, status: 'completed' }, type: 'response.done' })))
}

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

/**
 * Exercises the public Discord/Qwen voice boundary with only transport and clock fakes.
 *
 * Use when:
 * - A Qwen reconnect risks retaining Discord turn ownership across socket generations.
 * - A provider failure must release the public Discord voice owner without test-only hooks.
 */
describe('qwen Realtime VoiceManager public-path integration', () => {
  /** @example it('does not route an old turn through a recovered Qwen socket', async () => {}) */
  it('does not route an old turn through a recovered Qwen socket', async () => {
    vi.useFakeTimers()
    const sockets = [new FakeSocket(), new FakeSocket()]
    const socketFactory = vi.fn(() => sockets.shift()!)
    const streams: PassThrough[] = []
    const receiver = {
      speaking: new EventEmitter(),
      subscribe: vi.fn(() => {
        const stream = new PassThrough()
        streams.push(stream)
        return stream
      }),
    }
    const connectionEvents = new EventEmitter()
    const connection = Object.assign(connectionEvents, {
      destroy: vi.fn(),
      joinConfig: { channelId: 'voice', guildId: 'guild' },
      receiver,
      state: { status: 'ready' },
      subscribe: vi.fn(() => ({ unsubscribe: vi.fn() })),
    })
    const player = Object.assign(new EventEmitter(), {
      play: vi.fn(),
      state: { status: 'idle' },
      stop: vi.fn(),
    })
    voiceMocks.createAudioPlayer.mockReturnValue(player)
    voiceMocks.createAudioResource.mockReturnValue({})
    voiceMocks.joinVoiceChannel.mockReturnValue(connection)

    const runtime = new QwenRealtimeRuntime(resolveQwenRealtimeConfig({
      AIRI_DISCORD_VOICE_CALL_MODE: 'qwen-realtime',
      DASHSCOPE_API_KEY: 'synthetic-key',
      QWEN_REALTIME_VAD_SILENCE_DURATION_MS: '200',
      QWEN_REALTIME_WORKSPACE_ID: 'synthetic-workspace',
    }), { socketFactory })
    const manager = new VoiceManager(asMock<DiscordClient>({ user: { id: 'bot' } }), async () => undefined, async () => '', runtime)
    const channel = asMock<BaseGuildVoiceChannel>({
      guild: { id: 'guild', members: { me: undefined }, voiceAdapterCreator: {} },
      id: 'voice',
      members: new Map([['speaker', {
        displayName: 'Speaker',
        guild: { id: 'guild', name: 'Guild' },
        id: 'speaker',
        nickname: null,
        user: { bot: false },
        voice: { sessionId: 'speaker-session' },
      }]]),
    })
    const interaction = asMock<ChatInputCommandInteraction>({ reply: vi.fn(async () => undefined) })

    const joined = manager.joinChannel(interaction, channel)
    await vi.waitFor(() => expect(socketFactory).toHaveBeenCalledOnce())
    const first = socketFactory.mock.results[0].value as FakeSocket
    first.ready()
    await joined

    receiver.speaking.emit('start', 'speaker')
    await vi.waitFor(() => expect(streams).toHaveLength(1))
    const packets = createOpusPcm16Fixture()
    for (let index = 0; index < 6; index += 1)
      streams[0].write(packets.nextSpeechPacket(8_000))
    await vi.waitFor(() => expect(first.sent.some(frame => JSON.parse(frame).type === 'input_audio_buffer.append')).toBe(true))
    receiver.speaking.emit('end', 'speaker')
    await vi.advanceTimersByTimeAsync(200)
    // Turn 1 reaches the provider commit boundary but never receives a response
    // terminal event. Transport loss must retire that diagnostic ownership; it
    // is not safe for the recovered socket to infer a turn from this stale state.
    first.emit('message', Buffer.from(JSON.stringify({ event_id: 'turn-1-committed', item_id: 'turn-1-input', type: 'input_audio_buffer.committed' })))
    await vi.runAllTicks()
    expect(player.play).not.toHaveBeenCalled()

    first.emit('error', new Error('synthetic transport loss'))
    first.emit('close', 1006, Buffer.from('synthetic transport loss'))
    await vi.advanceTimersByTimeAsync(250)
    const second = socketFactory.mock.results[1].value as FakeSocket
    second.ready()

    // Late generation-one callbacks and an unsolicited generation-two commit,
    // response, and audio cannot own incomplete Turn 1 or start playback.
    first.emit('message', Buffer.from(JSON.stringify({ event_id: 'late-created', response: { id: 'late' }, type: 'response.created' })))
    first.emit('message', Buffer.from(JSON.stringify({ delta: 'AQIDBA==', event_id: 'late-audio-delta', response_id: 'late', type: 'response.audio.delta' })))
    // Deliberate negative: no item_id or event_id must fail closed.
    second.emit('message', Buffer.from(JSON.stringify({ type: 'input_audio_buffer.committed' })))
    second.emit('message', Buffer.from(JSON.stringify({ event_id: 'unsolicited-created', response: { id: 'unsolicited' }, type: 'response.created' })))
    second.emit('message', Buffer.from(JSON.stringify({ delta: 'AQIDBA==', event_id: 'unsolicited-audio-delta', response_id: 'unsolicited', type: 'response.audio.delta' })))
    expect(player.play).not.toHaveBeenCalled()

    receiver.speaking.emit('start', 'speaker')
    await vi.runAllTicks()
    expect(streams).toHaveLength(1)
    for (let index = 0; index < 6; index += 1)
      streams[0].write(packets.nextSpeechPacket(8_000))
    receiver.speaking.emit('end', 'speaker')
    await vi.advanceTimersByTimeAsync(200)
    emitTurn(second, 'turn-2-input', 'turn-2-response')

    expect(player.play).toHaveBeenCalledOnce()
    expect(connection.subscribe).toHaveBeenCalledWith(player)
    await manager.stop()
    expect(connection.destroy).toHaveBeenCalledOnce()
    expect(connection.listenerCount('stateChange')).toBe(0)
    expect(connection.listenerCount('error')).toBe(0)
    expect(receiver.speaking.listenerCount('start')).toBe(0)
    expect(receiver.speaking.listenerCount('end')).toBe(0)
    // An obsolete provider generation must release its callbacks as well as
    // rejecting them. Otherwise five reconnects retain five closures forever.
    expect(first.listenerCount('open')).toBe(0)
    expect(first.listenerCount('message')).toBe(0)
    expect(first.listenerCount('error')).toBe(0)
    expect(first.listenerCount('close')).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  /** @example it('retires a pending aggregate before a recovered socket accepts another capture', async () => {}) */
  it('retires a pending aggregate before a recovered socket accepts another capture', async () => {
    vi.useFakeTimers()
    const sockets = [new FakeSocket(), new FakeSocket()]
    const socketFactory = vi.fn(() => sockets.shift()!)
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
    const player = Object.assign(new EventEmitter(), {
      play: vi.fn(),
      state: { status: 'idle' },
      stop: vi.fn(),
    })
    voiceMocks.createAudioPlayer.mockReturnValue(player)
    voiceMocks.createAudioResource.mockReturnValue({})
    voiceMocks.joinVoiceChannel.mockReturnValue(connection)
    const runtime = new QwenRealtimeRuntime(resolveQwenRealtimeConfig({
      AIRI_DISCORD_VOICE_CALL_MODE: 'qwen-realtime',
      DASHSCOPE_API_KEY: 'synthetic-key',
      QWEN_REALTIME_VAD_SILENCE_DURATION_MS: '200',
      QWEN_REALTIME_WORKSPACE_ID: 'synthetic-workspace',
    }), { socketFactory })
    const diagnostics: VoiceDiagnosticSignal[] = []
    const observer: VoiceDiagnosticsObserver = { record: signal => diagnostics.push({ ...signal }), runtimeSequence: 91 }
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
    const channel = asMock<BaseGuildVoiceChannel>({
      guild: { id: 'guild', members: { me: undefined }, voiceAdapterCreator: {} },
      id: 'voice',
      members: new Map(['speaker-1', 'speaker-2'].map(id => [id, {
        displayName: id,
        guild: { id: 'guild', name: 'Guild' },
        id,
        nickname: null,
        user: { bot: false },
        voice: { sessionId: `${id}-session` },
      }])),
    })
    const joined = manager.joinChannel(asMock<ChatInputCommandInteraction>({ reply: vi.fn(async () => undefined) }), channel)
    await vi.waitFor(() => expect(socketFactory).toHaveBeenCalledOnce())
    const first = socketFactory.mock.results[0]?.value
    if (!first)
      throw new Error('Expected the first Qwen socket.')
    first.ready()
    await joined

    const packets = createOpusPcm16Fixture()
    receiver.speaking.emit('start', 'speaker-1')
    await vi.waitFor(() => expect(streams).toHaveLength(1))
    for (let index = 0; index < 6; index += 1)
      streams[0].write(packets.nextSpeechPacket(8_000))
    await vi.waitFor(() => expect(first.sent.some(frame => JSON.parse(frame).type === 'input_audio_buffer.append')).toBe(true))
    receiver.speaking.emit('end', 'speaker-1')
    await vi.advanceTimersByTimeAsync(200)

    first.emit('error', new Error('synthetic transport loss'))
    first.emit('close', 1006, Buffer.from('synthetic transport loss'))
    await vi.advanceTimersByTimeAsync(250)
    const second = socketFactory.mock.results[1]?.value
    if (!second)
      throw new Error('Expected the recovered Qwen socket.')
    second.ready()

    receiver.speaking.emit('start', 'speaker-2')
    await vi.waitFor(() => expect(streams).toHaveLength(2))
    for (let index = 0; index < 6; index += 1)
      streams[1].write(packets.nextSpeechPacket(8_000))
    await vi.waitFor(() => expect(second.sent.some(frame => JSON.parse(frame).type === 'input_audio_buffer.append')).toBe(true))
    receiver.speaking.emit('end', 'speaker-2')
    await vi.advanceTimersByTimeAsync(200)
    emitTurn(second, 'turn-2-input', 'turn-2-response')

    // ROOT CAUSE:
    //
    // Provider transport retirement cleared per-turn maps but retained the
    // pending aggregate. The recovered generation then reused Turn 1 as the
    // owner of Turn 2's commit and response.
    const commits = diagnostics.filter((signal): signal is Extract<VoiceDiagnosticSignal, { stage: 'provider-input-committed' }> => signal.stage === 'provider-input-committed')
    expect(commits).toHaveLength(1)
    expect(commits[0]).toMatchObject({
      aggregateTurnSequence: 2,
      captureTurnSequences: [2],
      turnSequence: 2,
    })
    expect(player.play).toHaveBeenCalledOnce()
    await manager.stop()
    expect(connection.destroy).toHaveBeenCalledOnce()
  })

  /** @example it('releases the Discord voice owner after initial provider configuration timeout', async () => {}) */
  it('releases the Discord voice owner after initial provider configuration timeout', async () => {
    vi.useFakeTimers()
    const socket = new FakeSocket()
    const connection = Object.assign(new EventEmitter(), {
      destroy: vi.fn(),
      joinConfig: { channelId: 'voice', guildId: 'guild' },
      receiver: { speaking: new EventEmitter(), subscribe: vi.fn() },
      state: { status: 'ready' },
    })
    voiceMocks.joinVoiceChannel.mockReturnValue(connection)
    const runtime = new QwenRealtimeRuntime(resolveQwenRealtimeConfig({
      AIRI_DISCORD_VOICE_CALL_MODE: 'qwen-realtime',
      DASHSCOPE_API_KEY: 'synthetic-key',
      QWEN_REALTIME_WORKSPACE_ID: 'synthetic-workspace',
    }), { socketFactory: () => socket })
    const manager = new VoiceManager(asMock<DiscordClient>({ user: { id: 'bot' } }), async () => undefined, async () => '', runtime)
    const channel = asMock<BaseGuildVoiceChannel>({
      guild: { id: 'guild', members: { me: undefined }, voiceAdapterCreator: {} },
      id: 'voice',
      members: new Map(),
    })
    const joining = manager.joinChannel(asMock<ChatInputCommandInteraction>({ reply: vi.fn(async () => undefined) }), channel)
    await vi.waitFor(() => expect(socket.listenerCount('open')).toBe(1))
    socket.readyState = 1
    socket.emit('open')
    await vi.advanceTimersByTimeAsync(10_000)

    await expect(joining).rejects.toMatchObject({ category: 'configuration-timeout', disposition: 'terminal' })
    expect(connection.destroy).toHaveBeenCalledOnce()
    expect(connection.listenerCount('stateChange')).toBe(0)
    expect(connection.listenerCount('error')).toBe(0)
    expect(connection.receiver.speaking.listenerCount('start')).toBe(0)
    expect(connection.receiver.speaking.listenerCount('end')).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })
})
