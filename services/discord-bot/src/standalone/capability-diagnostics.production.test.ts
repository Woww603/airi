import type { BaseGuildVoiceChannel, ChatInputCommandInteraction, Client as DiscordClient } from 'discord.js'

import type { RealtimeVoiceCallSessionEvents } from '../bots/discord/commands/summon'

import { Buffer } from 'node:buffer'

import { createAudioPlayer, createAudioResource, entersState, getVoiceConnections, joinVoiceChannel } from '@discordjs/voice'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { StandaloneDiscordAdapter } from '../adapters/standalone-adapter'
import { VoiceManager } from '../bots/discord/commands/summon'
import { createDiscordVoiceHarness } from '../test/discordVoiceHarness'
import { StandaloneDiscordAppController } from './app-controller'
import { StandaloneDashboardState } from './dashboard-state'

vi.mock('@discordjs/voice', () => ({
  createAudioPlayer: vi.fn(),
  createAudioResource: vi.fn(),
  demuxProbe: vi.fn(),
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

vi.mock('../adapters/standalone-adapter', () => {
  function MockStandaloneDiscordAdapter(config: { events?: { onReady?: () => void } }) {
    return {
      start: vi.fn(async () => config.events?.onReady?.()),
      stop: vi.fn(async () => {}),
    }
  }

  return { StandaloneDiscordAdapter: vi.fn(MockStandaloneDiscordAdapter) }
})

interface ProductionPlayer {
  emitState: (status: 'idle' | 'playing') => void
  on: ReturnType<typeof vi.fn>
  play: ReturnType<typeof vi.fn>
  removeAllListeners: ReturnType<typeof vi.fn>
  state: { status: string }
  stop: ReturnType<typeof vi.fn>
}

function createMock<T extends object>(value: object): T {
  return value as T
}

function createProductionPlayer(): ProductionPlayer {
  let stateChange: ((oldState: { status: string }, newState: { status: string }) => void) | undefined
  const player: ProductionPlayer = {
    emitState: (status) => {
      const previous = player.state.status
      player.state.status = status
      stateChange?.({ status: previous }, { status })
    },
    on: vi.fn((event: string, listener: (oldState: { status: string }, newState: { status: string }) => void) => {
      if (event === 'stateChange')
        stateChange = listener
    }),
    play: vi.fn(),
    removeAllListeners: vi.fn(),
    state: { status: 'idle' },
    stop: vi.fn(),
  }
  return player
}

async function createProductionCapabilityHarness() {
  const state = new StandaloneDashboardState()
  const controller = new StandaloneDiscordAppController({
    env: {
      DEEPSEEK_API_KEY: 'configured',
      DEEPSEEK_MODEL: 'configured',
      DISCORD_TOKEN: 'configured',
    },
    envFilePath: '/private/tmp/airi-capability-production-regression-config',
    state,
  })
  const startResult = await controller.startBot()
  if (!startResult.ok)
    throw new Error('The production controller did not start with the isolated adapter boundary.')
  const adapterConfig = vi.mocked(StandaloneDiscordAdapter).mock.calls.at(-1)?.[0]
  const observer = adapterConfig?.voiceDiagnostics
  if (!observer)
    throw new Error('The production controller did not install its generation-owned voice observer.')

  const started = state.startCapabilityDiagnostics({
    discordConfigured: true,
    productVersion: 'test',
    providerConfigured: true,
  })
  if (!started)
    throw new Error('Capability diagnosis did not start.')
  state.recordDiagnosticTextAccepted(started.marker, { operationSequence: 1, surface: 'text-guild' })
  state.recordSuccessfulReply({ operationSequence: 1, surface: 'text-guild' })
  if (!state.confirmCapabilityDiagnostics('text-reply-correct'))
    throw new Error('The text confirmation boundary did not admit the production voice run.')

  let providerEvents: RealtimeVoiceCallSessionEvents | undefined
  const provider = {
    abortInput: vi.fn(),
    appendAudio: vi.fn((pcm: Buffer, inputSequence: number) => {
      providerEvents?.onInputAudioSent?.({
        byteLength: pcm.length,
        chunkCount: 1,
        inputSequence,
        kind: 'user-audio',
      })
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
  const players: ProductionPlayer[] = []
  vi.mocked(createAudioPlayer).mockImplementation(() => {
    const player = createProductionPlayer()
    players.push(player)
    return createMock<ReturnType<typeof createAudioPlayer>>(player)
  })
  const fixture = createDiscordVoiceHarness('guild-production', 'voice-production', 'user-production')
  const channel = createMock<BaseGuildVoiceChannel>(fixture.channel)
  vi.mocked(joinVoiceChannel).mockReturnValue(createMock<ReturnType<typeof joinVoiceChannel>>(fixture.connection))
  const manager = new VoiceManager(
    createMock<DiscordClient>({ user: { id: 'bot-production' } }),
    async () => undefined,
    async () => '',
    runtime,
    undefined,
    undefined,
    undefined,
    observer,
  )
  await manager.joinChannel(
    createMock<ChatInputCommandInteraction>({ reply: vi.fn(async () => {}) }),
    channel,
  )
  if (!state.confirmCapabilityDiagnostics('voice-consent-join'))
    throw new Error('The production voice session did not admit consent confirmation.')
  if (!providerEvents)
    throw new Error('The production provider callbacks were not installed.')

  return { channel, controller, fixture, manager, players, provider, providerEvents, state }
}

async function beginProductionTurn(harness: Awaited<ReturnType<typeof createProductionCapabilityHarness>>): Promise<number> {
  const appendCount = harness.provider.appendAudio.mock.calls.length
  harness.fixture.speaking.emit('start', harness.fixture.userId)
  await harness.fixture.drain()
  harness.fixture.feedSpeech(harness.fixture.userId, 6)
  await vi.waitFor(() => {
    if (harness.provider.appendAudio.mock.calls.length <= appendCount)
      throw new Error('The real Discord receiver turn has not reached provider.appendAudio.')
  })
  const turnSequence = harness.provider.appendAudio.mock.calls.at(-1)?.[1]
  if (!turnSequence)
    throw new Error('The production append boundary did not expose its owned turn sequence.')
  harness.fixture.speaking.emit('end', harness.fixture.userId)
  await harness.fixture.drain()
  return turnSequence
}

function commitProductionResponse(
  harness: Awaited<ReturnType<typeof createProductionCapabilityHarness>>,
  turnSequence: number,
  suffix: string,
): { itemId: string, responseId: string } {
  const itemId = `item-${suffix}`
  const responseId = `response-${suffix}`
  harness.providerEvents.onInputCommitted?.({ inputSequence: turnSequence, itemId })
  harness.providerEvents.onSpeechStarted?.({ inputSequence: turnSequence, itemId })
  harness.providerEvents.onResponseCreated?.({ itemId, responseId })
  return { itemId, responseId }
}

function completeProductionResponse(
  harness: Awaited<ReturnType<typeof createProductionCapabilityHarness>>,
  responseId: string,
): void {
  harness.providerEvents.onAudio?.(Buffer.from([1, 2, 3, 4]), { responseId })
  const player = harness.players.at(-1)
  if (!player)
    throw new Error('The production response did not create a Discord audio player.')
  player.emitState('playing')
  harness.providerEvents.onAudioDone?.({ responseId })
  harness.providerEvents.onResponseDone?.({ responseId }, 'completed')
  player.emitState('idle')
}

function capabilitySnapshot(harness: Awaited<ReturnType<typeof createProductionCapabilityHarness>>) {
  return harness.state.getSnapshot().capabilityDiagnostics
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(entersState).mockResolvedValue(undefined)
  vi.mocked(getVoiceConnections).mockReturnValue(new Map())
  vi.mocked(createAudioResource).mockReturnValue(createMock<ReturnType<typeof createAudioResource>>({
    source: 'production-capability-regression',
  }))
})

/** @example describe('production capability voice chain', () => {}) */
describe('production capability voice chain', () => {
  /** @example it('retries two provider-input-cleared producer turns and completes turn 3', async () => {}) */
  it('retries two provider-input-cleared producer turns and completes turn 3', async () => {
    // ROOT CAUSE:
    //
    // Before this regression, capability tests manufactured terminal signals
    // directly and never proved that VoiceManager's provider callbacks supplied
    // the turn sequence owned by the corresponding Discord receiver capture.
    // The public receiver and provider callbacks below now own every sequence.
    const harness = await createProductionCapabilityHarness()
    const turn1 = await beginProductionTurn(harness)
    harness.providerEvents.onInputCleared?.({ inputSequence: turn1 })
    const turn2 = await beginProductionTurn(harness)
    harness.providerEvents.onInputCleared?.({ inputSequence: turn2 })
    const turn3 = await beginProductionTurn(harness)
    const beforeLateCallbacks = capabilitySnapshot(harness)
    harness.providerEvents.onInputCleared?.({ inputSequence: turn1 })
    harness.providerEvents.onInputCleared?.({ inputSequence: turn2 })
    harness.providerEvents.onResponseCreated?.({ itemId: 'late-cleared-item-1', responseId: 'late-cleared-response-1' })
    harness.providerEvents.onAudio?.(Buffer.from([9, 1]), { responseId: 'late-cleared-response-1' })
    harness.providerEvents.onAudioDone?.({ responseId: 'late-cleared-response-1' })
    harness.providerEvents.onResponseDone?.({ responseId: 'late-cleared-response-1' }, 'failed')
    harness.providerEvents.onResponseCancelled?.({ responseId: 'late-cleared-response-1' })
    harness.providerEvents.onResponseCreated?.({ itemId: 'late-cleared-item-2', responseId: 'late-cleared-response-2' })
    harness.providerEvents.onAudio?.(Buffer.from([9, 2]), { responseId: 'late-cleared-response-2' })
    harness.providerEvents.onAudioDone?.({ responseId: 'late-cleared-response-2' })
    harness.providerEvents.onResponseDone?.({ responseId: 'late-cleared-response-2' }, 'failed')
    harness.providerEvents.onResponseCancelled?.({ responseId: 'late-cleared-response-2' })
    /** @example expect(capabilitySnapshot(harness)).toEqual(beforeLateCallbacks) */
    expect(capabilitySnapshot(harness)).toEqual(beforeLateCallbacks)
    const { responseId } = commitProductionResponse(harness, turn3, 'cleared-turn-3')
    completeProductionResponse(harness, responseId)
    harness.state.confirmCapabilityDiagnostics('voice-heard')
    harness.manager.leaveChannel(harness.channel)

    const snapshot = capabilitySnapshot(harness)
    /** @example expect([turn1, turn2, turn3]).toEqual([1, 2, 3]) */
    expect([turn1, turn2, turn3]).toEqual([1, 2, 3])
    /** @example expect(snapshot.phase).toBe('completed') */
    expect(snapshot.phase).toBe('completed')
    /** @example expect(snapshot.firstNonPassBoundary).toBeUndefined() */
    expect(snapshot.firstNonPassBoundary).toBeUndefined()
  })

  /** @example it('ignores late response producer callbacks while turn 3 remains active', async () => {}) */
  it('ignores late response producer callbacks while turn 3 remains active', async () => {
    const harness = await createProductionCapabilityHarness()
    const turn1 = await beginProductionTurn(harness)
    const response1 = commitProductionResponse(harness, turn1, 'cancelled-turn-1')
    harness.providerEvents.onAudio?.(Buffer.from([1, 1]), { responseId: response1.responseId })
    const retiredPlayer1 = harness.players.at(-1)
    retiredPlayer1?.emitState('playing')
    harness.providerEvents.onResponseCancelled?.({ responseId: response1.responseId })
    const turn2 = await beginProductionTurn(harness)
    const response2 = commitProductionResponse(harness, turn2, 'cancelled-turn-2')
    harness.providerEvents.onAudio?.(Buffer.from([2, 2]), { responseId: response2.responseId })
    const retiredPlayer2 = harness.players.at(-1)
    retiredPlayer2?.emitState('playing')
    harness.providerEvents.onResponseCancelled?.({ responseId: response2.responseId })
    const turn3 = await beginProductionTurn(harness)
    const response3 = commitProductionResponse(harness, turn3, 'cancelled-turn-3')
    const beforeLateCallbacks = capabilitySnapshot(harness)

    // ROOT CAUSE:
    //
    // A lower response once shared mutable correlation slots with the active
    // response. Late failure, creation, audio, playback, and duplicate terminal
    // callbacks could therefore overwrite the higher turn's evidence. Production
    // response identities and the capability turn owner now reject them.
    harness.providerEvents.onResponseDone?.({ responseId: response1.responseId }, 'failed')
    harness.providerEvents.onResponseCreated?.({ itemId: response1.itemId, responseId: 'late-response-1' })
    harness.providerEvents.onAudio?.(Buffer.from([9, 9]), { responseId: response1.responseId })
    harness.providerEvents.onAudioDone?.({ responseId: response1.responseId })
    harness.providerEvents.onResponseCancelled?.({ responseId: response1.responseId })
    retiredPlayer1?.emitState('playing')
    retiredPlayer1?.emitState('idle')
    harness.providerEvents.onResponseDone?.({ responseId: response2.responseId }, 'failed')
    harness.providerEvents.onResponseCancelled?.({ responseId: response2.responseId })
    retiredPlayer2?.emitState('playing')
    retiredPlayer2?.emitState('idle')

    const afterLateCallbacks = capabilitySnapshot(harness)
    /** @example expect(afterLateCallbacks).toEqual(beforeLateCallbacks) */
    expect(afterLateCallbacks).toEqual(beforeLateCallbacks)
    completeProductionResponse(harness, response3.responseId)
    harness.state.confirmCapabilityDiagnostics('voice-heard')
    harness.manager.leaveChannel(harness.channel)
    const completed = capabilitySnapshot(harness)
    /** @example expect([turn1, turn2, turn3]).toEqual([1, 2, 3]) */
    expect([turn1, turn2, turn3]).toEqual([1, 2, 3])
    /** @example expect(completed.phase).toBe('completed') */
    expect(completed.phase).toBe('completed')
  })

  /** @example it('reaches playback-aborted from production playback interruption and completes turn 3', async () => {}) */
  it('reaches playback-aborted from production playback interruption and completes turn 3', async () => {
    const harness = await createProductionCapabilityHarness()
    const turn1 = await beginProductionTurn(harness)
    const response1 = commitProductionResponse(harness, turn1, 'playback-turn-1')
    harness.providerEvents.onAudio?.(Buffer.from([1, 2]), { responseId: response1.responseId })
    const retiredPlayer1 = harness.players.at(-1)
    retiredPlayer1?.emitState('playing')
    const turn2 = await beginProductionTurn(harness)
    const response2 = commitProductionResponse(harness, turn2, 'playback-turn-2')
    harness.providerEvents.onAudio?.(Buffer.from([3, 4]), { responseId: response2.responseId })
    const retiredPlayer2 = harness.players.at(-1)
    retiredPlayer2?.emitState('playing')
    const turn3 = await beginProductionTurn(harness)
    const response3 = commitProductionResponse(harness, turn3, 'playback-turn-3')
    const beforeLateCallbacks = capabilitySnapshot(harness)

    // ROOT CAUSE:
    //
    // Playback interruption used to leave callbacks from a cleaned player and
    // retired response reachable after the next input owned the diagnostics run.
    // Production player cleanup and response correlation must make every late
    // callback an exact no-op for the active turn's ordered evidence.
    for (const [response, retiredPlayer] of [[response1, retiredPlayer1], [response2, retiredPlayer2]] as const) {
      harness.providerEvents.onResponseDone?.({ responseId: response.responseId }, 'failed')
      harness.providerEvents.onResponseCreated?.({ itemId: response.itemId, responseId: `late-${response.responseId}` })
      harness.providerEvents.onAudio?.(Buffer.from([8, 8]), { responseId: response.responseId })
      harness.providerEvents.onAudioDone?.({ responseId: response.responseId })
      harness.providerEvents.onResponseCancelled?.({ responseId: response.responseId })
      retiredPlayer?.emitState('playing')
      retiredPlayer?.emitState('idle')
    }
    /** @example expect(capabilitySnapshot(harness)).toEqual(beforeLateCallbacks) */
    expect(capabilitySnapshot(harness)).toEqual(beforeLateCallbacks)
    completeProductionResponse(harness, response3.responseId)
    harness.state.confirmCapabilityDiagnostics('voice-heard')
    harness.manager.leaveChannel(harness.channel)

    const voiceSession = harness.state.getSnapshot().voiceDiagnostics.completed[0]
    const turn1Projection = voiceSession?.turns.find(turn => turn.turnSequence === turn1)
    const turn2Projection = voiceSession?.turns.find(turn => turn.turnSequence === turn2)
    const snapshot = capabilitySnapshot(harness)
    /** @example expect([turn1, turn2, turn3]).toEqual([1, 2, 3]) */
    expect([turn1, turn2, turn3]).toEqual([1, 2, 3])
    /** @example expect(turn1Projection?.playbackAborted).toBe(1) */
    expect(turn1Projection?.playbackAborted).toBe(1)
    /** @example expect(turn2Projection?.playbackAborted).toBe(1) */
    expect(turn2Projection?.playbackAborted).toBe(1)
    /** @example expect(snapshot.phase).toBe('completed') */
    expect(snapshot.phase).toBe('completed')
  })

  /** @example it('fails voice cleanup when production connection destruction throws after heard', async () => {}) */
  it('fails voice cleanup when production connection destruction throws after heard', async () => {
    const harness = await createProductionCapabilityHarness()
    const turn = await beginProductionTurn(harness)
    const response = commitProductionResponse(harness, turn, 'destroy-failure')
    completeProductionResponse(harness, response.responseId)
    harness.state.confirmCapabilityDiagnostics('voice-heard')
    const teardownFailure = new Error('production connection teardown failure')
    harness.fixture.connection.destroy.mockImplementation(() => {
      throw teardownFailure
    })

    // ROOT CAUSE:
    //
    // Unit tests asserted a synthetic failed cleanup without proving that the
    // release producer withheld dismissed until every connection teardown
    // operation succeeded. The public leave path must rethrow and emit failed once.
    /** @example expect(() => harness.manager.leaveChannel(harness.channel)).toThrow(teardownFailure) */
    expect(() => harness.manager.leaveChannel(harness.channel)).toThrow(teardownFailure)
    const failed = harness.state.getSnapshot()
    /** @example expect(failed.voiceDiagnostics.completed.map(session => session.completionReason)).toEqual(['failed']) */
    expect(failed.voiceDiagnostics.completed.map(session => session.completionReason)).toEqual(['failed'])
    /** @example expect(failed.capabilityDiagnostics.firstFailedOrBlockedBoundary).toBe('voice-cleanup') */
    expect(failed.capabilityDiagnostics.firstFailedOrBlockedBoundary).toBe('voice-cleanup')
    /** @example expect(failed.capabilityDiagnostics.phase).toBe('running') */
    expect(failed.capabilityDiagnostics.phase).toBe('running')
    harness.manager.leaveChannel(harness.channel)
    /** @example expect(harness.state.getSnapshot()).toEqual(failed) */
    expect(harness.state.getSnapshot()).toEqual(failed)
  })

  /** @example it('fails voice cleanup when production listener removal throws after heard', async () => {}) */
  it('fails voice cleanup when production listener removal throws after heard', async () => {
    const harness = await createProductionCapabilityHarness()
    const turn = await beginProductionTurn(harness)
    const response = commitProductionResponse(harness, turn, 'listener-failure')
    completeProductionResponse(harness, response.responseId)
    harness.state.confirmCapabilityDiagnostics('voice-heard')
    const teardownFailure = new Error('production listener teardown failure')
    vi.spyOn(harness.fixture.connection, 'off').mockImplementationOnce(() => {
      throw teardownFailure
    })

    /** @example expect(() => harness.manager.leaveChannel(harness.channel)).toThrow(teardownFailure) */
    expect(() => harness.manager.leaveChannel(harness.channel)).toThrow(teardownFailure)
    const failed = harness.state.getSnapshot()
    /** @example expect(failed.voiceDiagnostics.completed.map(session => session.completionReason)).toEqual(['failed']) */
    expect(failed.voiceDiagnostics.completed.map(session => session.completionReason)).toEqual(['failed'])
    /** @example expect(failed.capabilityDiagnostics.firstFailedOrBlockedBoundary).toBe('voice-cleanup') */
    expect(failed.capabilityDiagnostics.firstFailedOrBlockedBoundary).toBe('voice-cleanup')
    /** @example expect(failed.capabilityDiagnostics.phase).not.toBe('completed') */
    expect(failed.capabilityDiagnostics.phase).not.toBe('completed')
  })

  /** @example it('completes only after normal production teardown and keeps second cleanup idempotent', async () => {}) */
  it('completes only after normal production teardown and keeps second cleanup idempotent', async () => {
    const harness = await createProductionCapabilityHarness()
    const turn = await beginProductionTurn(harness)
    const response = commitProductionResponse(harness, turn, 'normal-cleanup')
    completeProductionResponse(harness, response.responseId)
    harness.state.confirmCapabilityDiagnostics('voice-heard')
    harness.manager.leaveChannel(harness.channel)
    const completed = harness.state.getSnapshot()
    harness.manager.leaveChannel(harness.channel)

    /** @example expect(completed.voiceDiagnostics.completed.map(session => session.completionReason)).toEqual(['dismissed']) */
    expect(completed.voiceDiagnostics.completed.map(session => session.completionReason)).toEqual(['dismissed'])
    /** @example expect(completed.capabilityDiagnostics.phase).toBe('completed') */
    expect(completed.capabilityDiagnostics.phase).toBe('completed')
    /** @example expect(harness.state.getSnapshot()).toEqual(completed) */
    expect(harness.state.getSnapshot()).toEqual(completed)
  })

  /** @example it('keeps a current production response failure authoritative over later turns', async () => {}) */
  it('keeps a current production response failure authoritative over later turns', async () => {
    const harness = await createProductionCapabilityHarness()
    const turn1 = await beginProductionTurn(harness)
    const response1 = commitProductionResponse(harness, turn1, 'current-failure')
    harness.providerEvents.onResponseDone?.({ responseId: response1.responseId }, 'failed')
    const failed = capabilitySnapshot(harness)

    // ROOT CAUSE:
    //
    // Synthetic state-machine coverage could not prove whether a current
    // provider failure retained its producer-owned turn sequence. The real
    // response callback must fail the active boundary and retire the session.
    const turn2 = await beginProductionTurn(harness)
    const response2 = commitProductionResponse(harness, turn2, 'ignored-after-current-failure')
    completeProductionResponse(harness, response2.responseId)
    harness.state.confirmCapabilityDiagnostics('voice-heard')
    harness.manager.leaveChannel(harness.channel)

    /** @example expect([turn1, turn2]).toEqual([1, 2]) */
    expect([turn1, turn2]).toEqual([1, 2])
    /** @example expect(failed.firstFailedOrBlockedBoundary).toBe('voice-provider-response') */
    expect(failed.firstFailedOrBlockedBoundary).toBe('voice-provider-response')
    /** @example expect(capabilitySnapshot(harness).firstFailedOrBlockedBoundary).toBe('voice-provider-response') */
    expect(capabilitySnapshot(harness).firstFailedOrBlockedBoundary).toBe('voice-provider-response')
    /** @example expect(capabilitySnapshot(harness).phase).not.toBe('completed') */
    expect(capabilitySnapshot(harness).phase).not.toBe('completed')
  })

  /** @example it('keeps a production session failure without turn ownership fatal', async () => {}) */
  it('keeps a production session failure without turn ownership fatal', async () => {
    const harness = await createProductionCapabilityHarness()
    harness.fixture.connection.emit('error', new Error('production connection failure'))
    await harness.fixture.drain()
    const failed = capabilitySnapshot(harness)

    const ignoredTurn = await beginProductionTurn(harness)
    const response = commitProductionResponse(harness, ignoredTurn, 'ignored-after-session-failure')
    completeProductionResponse(harness, response.responseId)
    harness.state.confirmCapabilityDiagnostics('voice-heard')
    harness.manager.leaveChannel(harness.channel)

    /** @example expect(ignoredTurn).toBe(1) */
    expect(ignoredTurn).toBe(1)
    /** @example expect(failed.firstFailedOrBlockedBoundary).toBe('voice-speaking') */
    expect(failed.firstFailedOrBlockedBoundary).toBe('voice-speaking')
    /** @example expect(capabilitySnapshot(harness).firstFailedOrBlockedBoundary).toBe('voice-speaking') */
    expect(capabilitySnapshot(harness).firstFailedOrBlockedBoundary).toBe('voice-speaking')
    /** @example expect(capabilitySnapshot(harness).phase).not.toBe('completed') */
    expect(capabilitySnapshot(harness).phase).not.toBe('completed')
  })
})
