import type { Readable } from 'node:stream'

import type { VoiceConnection } from '@discordjs/voice'
import type { BaseGuildVoiceChannel, ButtonInteraction, ChatInputCommandInteraction, Client as DiscordClient, GuildMember } from 'discord.js'

import type { RealtimeVoiceCallRuntime, RealtimeVoiceCallSessionEvents, VoiceTranscriptionInput } from './summon'
import type { VoiceDiagnosticSignal } from './voiceDiagnostics'

import { Buffer } from 'node:buffer'
import { EventEmitter } from 'node:events'
import { Readable as NodeReadable, PassThrough } from 'node:stream'

import { describe, expect, it, vi } from 'vitest'

import { StandaloneSpeechRuntime } from '../../../standalone/speech-runtime'
import { createOpusPcm16Fixture } from '../../../test/pcmFixtures'
import { VoiceManager } from './summon'

const voiceMocks = vi.hoisted(() => ({
  createAudioPlayer: vi.fn(),
  createAudioResource: vi.fn(),
  joinVoiceChannel: vi.fn(),
  openaiTranscribe: vi.fn(async () => '你好 AIRI'),
}))

vi.mock('@discordjs/voice', () => ({
  createAudioPlayer: voiceMocks.createAudioPlayer,
  createAudioResource: voiceMocks.createAudioResource,
  entersState: vi.fn(async () => {}),
  getVoiceConnections: vi.fn(() => new Map()),
  joinVoiceChannel: voiceMocks.joinVoiceChannel,
  NoSubscriberBehavior: { Pause: 'pause' },
  StreamType: { Arbitrary: 'arbitrary', Raw: 'raw' },
  VoiceConnectionStatus: {
    Connecting: 'connecting',
    Destroyed: 'destroyed',
    Disconnected: 'disconnected',
    Ready: 'ready',
    Signalling: 'signalling',
  },
}))

function createMock<T extends object>(value: object): T {
  return value as T
}

/**
 * @example
 * describe('standalone voice conversation handoff', () => {})
 */
describe('standalone voice conversation handoff', () => {
  /**
   * @example
   * it('hands STT text to standalone chat and plays its TTS stream', async () => {})
   */
  it('hands STT text to standalone chat and plays its TTS stream', async () => {
    const speechStream: Readable = NodeReadable.from(Buffer.from([4, 5, 6]))
    const handleTranscription = vi.fn(async (_input: VoiceTranscriptionInput) => speechStream)
    const manager = new VoiceManager(
      createMock<DiscordClient>({ user: { id: 'bot-user' } }),
      handleTranscription,
      voiceMocks.openaiTranscribe,
    )
    const abortController = new AbortController()
    const connection = createMock<VoiceConnection>({ subscribe: vi.fn() })
    const playAudioStream = vi.spyOn(manager, 'playAudioStream').mockResolvedValue()
    const userStates = Reflect.get(manager, 'userStates')
    const state = {
      abortSignal: abortController.signal,
      buffers: [] as Buffer[],
      connection,
      lastActive: 0,
      scope: { channelId: 'voice-1', generation: 1, guildId: 'guild-1' },
      speaker: {
        displayName: 'Owen',
        guildName: 'Test Guild',
      },
      totalLength: 0,
      transcriptionText: '',
      userId: 'user-1',
    }
    const speakerKey = 'guild-1:voice-1:1:user-1'
    userStates.set(speakerKey, state)
    Reflect.apply(Reflect.get(manager, 'beginClassicVoiceTurn'), manager, [speakerKey, state])
    state.buffers.push(Buffer.from([9, 8, 7]))
    state.totalLength = 3
    const processTranscription = Reflect.get(manager, 'processTranscription')

    await Reflect.apply(processTranscription, manager, [speakerKey, state])

    expect(handleTranscription).toHaveBeenCalledWith({
      abortSignal: expect.any(AbortSignal),
      channelId: 'voice-1',
      deadlineAt: expect.any(Number),
      guildId: 'guild-1',
      rateLimitAdmitted: true,
      speaker: {
        displayName: 'Owen',
        guildName: 'Test Guild',
      },
      speechProviderOwnerKey: 'guild-1:voice-1:1:user-1',
      speechProviderPrincipalKey: 'user-1',
      text: '你好 AIRI',
      userId: 'user-1',
    })
    const turnSignal = handleTranscription.mock.calls[0][0].abortSignal
    const turnDeadlineAt = handleTranscription.mock.calls[0][0].deadlineAt
    expect(playAudioStream).toHaveBeenCalledWith(
      connection,
      speechStream,
      turnSignal,
      { channelId: 'voice-1', generation: 1, guildId: 'guild-1' },
      turnDeadlineAt,
    )
  })

  /**
   * @example
   * it('reproduces Discord audit D-018 by releasing the exact speaker gate after a hung STT deadline', async () => {})
   */
  it('reproduces Discord audit D-018 by releasing the exact speaker gate after a hung STT deadline', async () => {
    vi.useFakeTimers()
    let providerCalls = 0
    let firstProviderSignal: AbortSignal | undefined
    let resolveFirstProvider = (_text: string) => {}
    const firstProvider = new Promise<string>((resolve) => {
      resolveFirstProvider = resolve
    })
    const providerDeadlines: number[] = []
    const voiceTurnOptions: Array<{
      abortSignal: AbortSignal
      deadlineAt: number
      ownerKey: string
      principalKey: string
    }> = []
    const speechRuntime = new StandaloneSpeechRuntime({
      stt: { apiKey: 'synthetic-stt-key', model: 'synthetic-stt-model' },
      sttRequestTimeoutMs: 120_000,
      tts: { apiKey: 'synthetic-tts-key', model: 'synthetic-tts-model', voice: 'synthetic-voice' },
    }, {
      synthesize: vi.fn(async () => new ArrayBuffer(0)),
      transcribe: vi.fn(async (_wavBuffer, _config, options) => {
        providerCalls += 1
        if (options?.deadlineAt !== undefined)
          providerDeadlines.push(options.deadlineAt)
        if (providerCalls > 1)
          return 'recovered speaker turn'

        firstProviderSignal = options?.abortSignal
        return firstProvider
      }),
    })
    const handleTranscription = vi.fn(async () => undefined)
    const manager = new VoiceManager(
      createMock<DiscordClient>({ user: { id: 'bot-user' } }),
      handleTranscription,
      (wavBuffer, options) => {
        voiceTurnOptions.push(options)
        return speechRuntime.transcribe(wavBuffer, options)
      },
      undefined,
      undefined,
      undefined,
      5_000,
    )
    const abortController = new AbortController()
    const speakerKey = 'guild-1:voice-1:1:user-1'
    const state = {
      abortSignal: abortController.signal,
      buffers: [] as Buffer[],
      connection: createMock<VoiceConnection>({ subscribe: vi.fn() }),
      lastActive: 0,
      scope: { channelId: 'voice-1', generation: 1, guildId: 'guild-1' },
      speaker: { displayName: 'Synthetic speaker', guildName: 'Synthetic guild' },
      totalLength: 0,
      transcriptionText: '',
      userId: 'user-1',
    }
    Reflect.get(manager, 'userStates').set(speakerKey, state)
    const beginClassicVoiceTurn = Reflect.get(manager, 'beginClassicVoiceTurn')
    Reflect.apply(beginClassicVoiceTurn, manager, [speakerKey, state])
    state.buffers.push(Buffer.from([1]))
    state.totalLength = 1

    await manager.debouncedProcessTranscription(speakerKey)
    await vi.advanceTimersByTimeAsync(1_500)

    // ROOT CAUSE:
    //
    // A never-resolving STT promise kept `processTranscription` pending, so its
    // `finally` never released the exact speaker gate. Later utterances from the
    // same speaker were dropped while unrelated lifecycle cleanup could not abort
    // the provider. The provider boundary now rejects at an owned deadline.
    // @example
    expect(Reflect.get(manager, 'processingUsers').has(speakerKey)).toBe(true)

    await vi.advanceTimersByTimeAsync(5_000)

    // @example
    expect(firstProviderSignal?.aborted).toBe(true)
    // @example
    expect(Reflect.get(manager, 'processingUsers').has(speakerKey)).toBe(false)
    // @example
    expect(handleTranscription).not.toHaveBeenCalled()

    resolveFirstProvider('discarded late transcription')
    await vi.advanceTimersByTimeAsync(0)

    // @example
    expect(handleTranscription).not.toHaveBeenCalled()

    Reflect.apply(beginClassicVoiceTurn, manager, [speakerKey, state])
    state.buffers.push(Buffer.from([2]))
    state.totalLength = 1
    await manager.debouncedProcessTranscription(speakerKey)
    await vi.advanceTimersByTimeAsync(1_500)

    // @example
    expect(handleTranscription).toHaveBeenCalledWith(expect.objectContaining({
      abortSignal: voiceTurnOptions[1].abortSignal,
      deadlineAt: voiceTurnOptions[1].deadlineAt,
      speechProviderOwnerKey: speakerKey,
      speechProviderPrincipalKey: 'user-1',
      text: 'recovered speaker turn',
      userId: 'user-1',
    }))
    // @example
    expect(providerDeadlines[1]).toBe(voiceTurnOptions[1].deadlineAt)
    await manager.stop()
    // @example
    expect(Reflect.get(manager, 'classicVoiceTurnBoundaries').size).toBe(0)
    // @example
    expect(Reflect.get(manager, 'pendingClassicVoiceTurnTasks').size).toBe(0)
    // @example
    expect(vi.getTimerCount()).toBe(0)
  })

  /**
   * @example
   * it('reproduces Discord audit D-018 by refusing to renew an expired admission deadline', async () => {})
   */
  it('reproduces Discord audit D-018 by refusing to renew an expired admission deadline', async () => {
    vi.useFakeTimers()
    const transcribeAudio = vi.fn(async () => 'fresh admitted turn')
    const handleTranscription = vi.fn(async () => undefined)
    const manager = new VoiceManager(
      createMock<DiscordClient>({ user: { id: 'bot-user' } }),
      handleTranscription,
      transcribeAudio,
      undefined,
      undefined,
      undefined,
      5_000,
    )
    const stateController = new AbortController()
    const speakerKey = 'guild-1:voice-1:3:user-1'
    const state = {
      abortSignal: stateController.signal,
      buffers: [] as Buffer[],
      connection: createMock<VoiceConnection>({ subscribe: vi.fn() }),
      lastActive: 0,
      scope: { channelId: 'voice-1', generation: 3, guildId: 'guild-1' },
      speaker: { displayName: 'Synthetic speaker', guildName: 'Synthetic guild' },
      totalLength: 0,
      transcriptionText: '',
      userId: 'user-1',
    }
    Reflect.get(manager, 'userStates').set(speakerKey, state)
    const beginClassicVoiceTurn = Reflect.get(manager, 'beginClassicVoiceTurn')
    const cancelClassicVoiceTurn = Reflect.get(manager, 'cancelClassicVoiceTurn')
    const processTranscription = Reflect.get(manager, 'processTranscription')
    const expiredBoundary = Reflect.apply(beginClassicVoiceTurn, manager, [speakerKey, state])
    state.buffers.push(Buffer.from([1]))
    state.totalLength = 1

    await vi.advanceTimersByTimeAsync(5_000)
    state.buffers.push(Buffer.from([2]))
    state.totalLength += 1
    await Reflect.apply(processTranscription, manager, [speakerKey, state])

    // ROOT CAUSE:
    //
    // The admission timer deleted its boundary but retained buffered audio.
    // `processTranscription` then created a fresh full deadline for that expired
    // utterance and disclosed it to STT. Expiration now discards only the owned
    // state, and processing without its original admission boundary fails closed.
    // @example
    expect(transcribeAudio).not.toHaveBeenCalled()
    // @example
    expect(state.buffers).toHaveLength(0)
    // @example
    expect(state.totalLength).toBe(0)

    const replacementBoundary = Reflect.apply(beginClassicVoiceTurn, manager, [speakerKey, state]) as { signal: AbortSignal }
    state.buffers.push(Buffer.from([3]))
    state.totalLength = 1
    Reflect.apply(cancelClassicVoiceTurn, manager, [expiredBoundary, 'timeout'])

    // @example
    expect(replacementBoundary.signal.aborted).toBe(false)
    // @example
    expect(state.buffers).toHaveLength(1)

    await Reflect.apply(processTranscription, manager, [speakerKey, state])

    // @example
    expect(transcribeAudio).toHaveBeenCalledOnce()
    // @example
    expect(handleTranscription).toHaveBeenCalledOnce()
    await manager.stop()
    // @example
    expect(vi.getTimerCount()).toBe(0)
  })

  /**
   * @example
   * it('reproduces Discord audit D-018 by draining a stopped turn and destroying ignored late TTS output', async () => {})
   */
  it('reproduces Discord audit D-018 by draining a stopped turn and destroying ignored late TTS output', async () => {
    vi.useFakeTimers()
    let resolveLateAudio = (_stream: Readable | undefined) => {}
    const lateAudio = new Promise<Readable | undefined>((resolve) => {
      resolveLateAudio = resolve
    })
    let handlerSignal: AbortSignal | undefined
    const handleTranscription = vi.fn(async (input) => {
      handlerSignal = input.abortSignal
      return lateAudio
    })
    const manager = new VoiceManager(
      createMock<DiscordClient>({ user: { id: 'bot-user' } }),
      handleTranscription,
      vi.fn(async () => 'synthetic stopped turn'),
    )
    const playAudioStream = vi.spyOn(manager, 'playAudioStream').mockResolvedValue()
    const stateController = new AbortController()
    const speakerKey = 'guild-1:voice-1:2:user-1'
    const state = {
      abortSignal: stateController.signal,
      buffers: [] as Buffer[],
      connection: createMock<VoiceConnection>({ subscribe: vi.fn() }),
      lastActive: 0,
      scope: { channelId: 'voice-1', generation: 2, guildId: 'guild-1' },
      speaker: { displayName: 'Synthetic speaker', guildName: 'Synthetic guild' },
      totalLength: 0,
      transcriptionText: '',
      userId: 'user-1',
    }
    Reflect.get(manager, 'userStates').set(speakerKey, state)
    Reflect.apply(Reflect.get(manager, 'beginClassicVoiceTurn'), manager, [speakerKey, state])
    state.buffers.push(Buffer.from([1]))
    state.totalLength = 1

    await manager.debouncedProcessTranscription(speakerKey)
    await vi.advanceTimersByTimeAsync(1_500)

    // ROOT CAUSE:
    //
    // Stop previously invalidated Discord state but could leave an ignored
    // chat/TTS promise holding the speaker gate. Its late audio could then enter
    // playback after the owning generation was gone. The exact turn boundary now
    // rejects immediately, drains the tracked task, and destroys late audio.
    // @example
    expect(handleTranscription).toHaveBeenCalledOnce()
    // @example
    expect(Reflect.get(manager, 'pendingClassicVoiceTurnTasks').size).toBe(1)

    await manager.stop()

    // @example
    expect(handlerSignal?.aborted).toBe(true)
    // @example
    expect(Reflect.get(manager, 'processingUsers').size).toBe(0)
    // @example
    expect(Reflect.get(manager, 'classicVoiceTurnBoundaries').size).toBe(0)
    // @example
    expect(Reflect.get(manager, 'pendingClassicVoiceTurnTasks').size).toBe(0)

    const lateStream: Readable = NodeReadable.from(Buffer.from([7, 8, 9]))
    const destroyLateStream = vi.spyOn(lateStream, 'destroy')
    resolveLateAudio(lateStream)
    await vi.advanceTimersByTimeAsync(0)

    // @example
    expect(destroyLateStream).toHaveBeenCalledOnce()
    // @example
    expect(playAudioStream).not.toHaveBeenCalled()
    // @example
    expect(vi.getTimerCount()).toBe(0)
  })

  /**
   * @example
   * it('streams Qwen response PCM directly without calling classic STT or chat handoff', async () => {})
   */
  it('streams a publicly correlated Qwen response as raw PCM without classic STT or chat handoff', async () => {
    voiceMocks.openaiTranscribe.mockClear()
    voiceMocks.createAudioResource.mockClear()
    const handleTranscription = vi.fn(async () => undefined)
    let providerEvents: RealtimeVoiceCallSessionEvents = {}
    const diagnostics: VoiceDiagnosticSignal[] = []
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
    const connect = vi.fn(async (events: RealtimeVoiceCallSessionEvents) => {
      providerEvents = events
      return provider
    })
    const runtime: RealtimeVoiceCallRuntime = {
      connect,
      getInterruptionRmsThreshold: () => 0.04,
      getMode: () => 'qwen-realtime',
      isConfigured: () => true,
    }
    const player = {
      on: vi.fn(),
      play: vi.fn(),
      removeAllListeners: vi.fn(),
      state: { status: 'idle' },
      stop: vi.fn(),
    }
    voiceMocks.createAudioPlayer.mockReturnValue(player)
    const receiveStream = new PassThrough()
    const receiver = {
      speaking: new EventEmitter(),
      subscribe: vi.fn(() => receiveStream),
    }
    const connection = Object.assign(new EventEmitter(), {
      destroy: vi.fn(),
      receiver,
      state: { status: 'ready' },
      subscribe: vi.fn(() => ({ unsubscribe: vi.fn() })),
    })
    voiceMocks.joinVoiceChannel.mockReturnValue(connection)
    const manager = new VoiceManager(
      createMock<DiscordClient>({ user: { id: 'bot-user' } }),
      handleTranscription,
      voiceMocks.openaiTranscribe,
      runtime,
      undefined,
      undefined,
      undefined,
      { record: signal => diagnostics.push({ ...signal }), runtimeSequence: 61 },
    )
    const guild = {
      id: 'guild-1',
      members: { fetch: vi.fn(), me: undefined },
      name: 'Standalone guild',
      voiceAdapterCreator: {},
    }
    const speaker = createMock<GuildMember>({
      displayName: 'Standalone speaker',
      guild,
      id: 'user-1',
      user: { bot: false },
      voice: { channelId: 'voice-1', sessionId: 'voice-session-1' },
    })
    guild.members.fetch.mockResolvedValue(speaker)
    const channel = createMock<BaseGuildVoiceChannel>({
      guild,
      guildId: guild.id,
      id: 'voice-1',
      members: new Map([[speaker.id, speaker]]),
      name: 'Standalone voice',
    })
    const summon = createMock<ChatInputCommandInteraction>({
      editReply: vi.fn(async () => undefined),
      id: 'standalone-summon',
      inCachedGuild: () => true,
      member: { voice: { channel } },
      reply: vi.fn(async () => undefined),
    })
    await manager.handleJoinChannelCommand(summon)
    expect(voiceMocks.joinVoiceChannel).not.toHaveBeenCalled()
    const consent = createMock<ButtonInteraction>({
      customId: 'airi:voice-consent:opt-in:guild-1-standalone-summon',
      guildId: guild.id,
      inCachedGuild: () => true,
      member: { voice: { channelId: channel.id, sessionId: 'voice-session-1' } },
      reply: vi.fn(async () => undefined),
      update: vi.fn(async () => undefined),
      user: { id: speaker.id },
    })
    await manager.handleConsentInteraction(consent)
    await vi.waitFor(() => expect(voiceMocks.joinVoiceChannel).toHaveBeenCalledOnce())

    receiver.speaking.emit('start', speaker.id)
    await vi.waitFor(() => expect(receiver.subscribe).toHaveBeenCalledOnce())
    const packets = createOpusPcm16Fixture()
    for (let frame = 0; frame < 6; frame += 1)
      receiveStream.write(packets.nextSpeechPacket())
    await vi.waitFor(() => expect(provider.appendAudio).toHaveBeenCalled())
    const inputSequence = provider.appendAudio.mock.calls.at(-1)?.[1]
    if (!inputSequence)
      throw new Error('Admitted receiver PCM must expose a public provider input sequence.')
    receiver.speaking.emit('end', speaker.id)
    await vi.waitFor(() => expect(provider.finishInput).toHaveBeenCalledOnce())

    // ROOT CAUSE:
    //
    // The old fixture opened a private realtime session and injected a response
    // without an append, acknowledged input, or committed item. Production
    // correctly rejected that impossible state, leaving no raw audio resource.
    // A valid raw Qwen response is instead owned by one public consented capture.
    providerEvents.onInputCommitted?.({ inputSequence, itemId: 'standalone-item-1' })
    providerEvents.onResponseCreated?.({ itemId: 'standalone-item-1', responseId: 'standalone-response-1' })
    providerEvents.onAudio?.(Buffer.from([1, 2, 3, 4]), { responseId: 'standalone-response-1' })
    providerEvents.onSpeechStarted?.({ inputSequence, itemId: 'standalone-item-1' })
    providerEvents.onAudioDone?.({ responseId: 'standalone-response-1' })
    providerEvents.onResponseDone?.({ responseId: 'standalone-response-1' }, 'completed')

    expect(manager.getVoiceCallMode()).toBe('qwen-realtime')
    expect(handleTranscription).not.toHaveBeenCalled()
    expect(voiceMocks.openaiTranscribe).not.toHaveBeenCalled()
    expect(voiceMocks.createAudioResource).toHaveBeenCalledWith(
      expect.anything(),
      { inputType: 'raw' },
    )
    expect(connection.subscribe).toHaveBeenCalledWith(player)
    expect(player.play).toHaveBeenCalledOnce()
    expect(player.stop).toHaveBeenCalledOnce()
    const inputAppends = diagnostics.filter(signal => signal.stage === 'provider-input-appended')
    const appendedBytes = provider.appendAudio.mock.calls.reduce((total, [pcm]) => total + pcm.length, 0)
    expect(inputAppends).toHaveLength(provider.appendAudio.mock.calls.length)
    expect(inputAppends.at(-1)).toEqual(expect.objectContaining({
      inputKind: 'user-audio',
      providerInputBytes: appendedBytes,
      providerInputChunks: provider.appendAudio.mock.calls.length,
      turnSequence: inputSequence,
    }))
    expect(diagnostics.filter(signal => signal.stage === 'provider-input-committed')).toEqual([
      expect.objectContaining({
        aggregateTurnSequence: inputSequence,
        captureTurnSequences: [inputSequence],
        turnSequence: inputSequence,
      }),
    ])
    expect(diagnostics.filter(signal => signal.stage === 'provider-response-created')).toEqual([
      expect.objectContaining({ turnSequence: inputSequence }),
    ])
    expect(diagnostics.filter(signal => signal.stage === 'provider-response-audio')).toEqual([
      expect.objectContaining({ responseAudioBytes: 4, responseAudioChunks: 1, turnSequence: inputSequence }),
    ])
    await manager.stop()
    await manager.stop()
    expect(provider.abortInput).toHaveBeenCalledOnce()
    expect(provider.cancelResponse).toHaveBeenCalledOnce()
    expect(provider.close).toHaveBeenCalledOnce()
    expect(connection.destroy).toHaveBeenCalledOnce()
  })
})
