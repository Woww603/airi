import { describe, expect, it } from 'vitest'

import { resolveStandaloneDashboardServerSettings } from './dashboard'
import { StandaloneDashboardState } from './dashboard-state'
import { StandaloneVoiceDiagnostics } from './voiceDiagnostics'

/**
 * @example
 * describe('standalone dashboard state', () => {})
 */
describe('standalone dashboard state', () => {
  /**
   * @example
   * it('tracks bot lifecycle and redacted reply counters', () => {})
   */
  it('tracks bot lifecycle and redacted reply counters', () => {
    const state = new StandaloneDashboardState()

    state.recordAcceptedMessage({ operationSequence: 1, surface: 'text-direct-message' })
    state.recordRejectedMessage({ operationSequence: 2, reason: 'blocked-term', surface: 'text-guild' })
    state.recordSuccessfulReply({ operationSequence: 1, surface: 'text-direct-message' })
    state.recordFailedReply({ errorKind: 'provider-failure', operationSequence: 2, surface: 'text-guild' })
    state.setBotReady()

    const snapshot = state.getSnapshot()

    /**
     * @example
     * expect(snapshot.botStatus).toBe('ready')
     */
    expect(snapshot.botStatus).toBe('ready')
    /**
     * @example
     * expect(snapshot.acceptedMessages).toBe(1)
     */
    expect(snapshot.acceptedMessages).toBe(1)
    /**
     * @example
     * expect(snapshot.rejectedMessages).toBe(1)
     */
    expect(snapshot.rejectedMessages).toBe(1)
    /**
     * @example
     * expect(snapshot.successfulReplies).toBe(1)
     */
    expect(snapshot.successfulReplies).toBe(1)
    /**
     * @example
     * expect(snapshot.failedReplies).toBe(1)
     */
    expect(snapshot.failedReplies).toBe(1)
    /**
     * @example
     * expect(snapshot.events[0].code).toBe('bot-ready')
     */
    expect(snapshot.events[0].code).toBe('bot-ready')
  })

  /**
   * @example
   * it('projects only allowlisted general-event fields at the Dashboard boundary', () => {})
   */
  it('projects only allowlisted general-event fields at the Dashboard boundary', () => {
    const sentinels = [
      'synthetic-guild-name-sentinel',
      '919191919191919191',
      'https://synthetic.invalid/private?credential=sentinel',
      'synthetic-error-message-sentinel',
    ]
    const state = new StandaloneDashboardState()

    // ROOT CAUSE:
    //
    // General Dashboard events accepted arbitrary scope, detail, title, and
    // error strings. The state then copied those values into both `lastError`
    // and the public event list without an allowlist projection.
    const acceptedObservation = {
      operationSequence: 1,
      scope: `${sentinels[0]} / ${sentinels[1]}`,
      surface: 'text-guild' as const,
    }
    const rejectedObservation = {
      operationSequence: 2,
      reason: 'blocked-user' as const,
      retryAfterMs: 1_000,
      scope: sentinels[1],
      surface: 'text-guild' as const,
    }
    const ignoredObservation = {
      detail: sentinels[2],
      operationSequence: 3,
      reason: 'missing-discord-permission' as const,
      scope: sentinels[0],
      surface: 'text-guild' as const,
    }
    const ingressObservation = {
      error: sentinels[3],
      failureCategory: 'discord-ingress-failure' as const,
      operationSequence: 4,
      scope: sentinels[1],
      surface: 'text-guild' as const,
    }
    const failedReplyObservation = {
      error: sentinels[2],
      errorKind: 'provider-failure' as const,
      operationSequence: 5,
      scope: sentinels[0],
      surface: 'text-guild' as const,
    }
    state.recordAcceptedMessage(acceptedObservation)
    state.recordRejectedMessage(rejectedObservation)
    state.recordIgnoredMessage(ignoredObservation)
    state.recordIngressFailure(ingressObservation)
    state.recordFailedReply(failedReplyObservation)
    Reflect.apply(state.setBotStatus, state, ['error', sentinels[3]])
    Reflect.apply(state.recordEvent, state, [{ code: 'message-accepted', detail: sentinels[2], title: sentinels[3] }])
    Reflect.apply(state.recordEvent, state, [{ code: sentinels[3], detail: sentinels[2], title: sentinels[0] }])
    Reflect.apply(state.recordFailedReply, state, [{ errorKind: sentinels[3], operationSequence: 6, surface: sentinels[0] }])

    const serialized = JSON.stringify(state.getSnapshot())

    for (const sentinel of sentinels) {
      // @example
      expect(serialized).not.toContain(sentinel)
    }
    // @example
    expect(state.getSnapshot()).toMatchObject({
      acceptedMessages: 1,
      failedReplies: 2,
      lastError: 'unknown',
      rejectedMessages: 1,
    })
  })

  /**
   * @example
   * it('continues persisted counters and reports each counter change', () => {})
   */
  it('continues persisted counters and reports each counter change', () => {
    const persistedSnapshots: unknown[] = []
    const state = new StandaloneDashboardState({
      initialCounters: {
        acceptedMessages: 5,
        failedReplies: 2,
        rejectedMessages: 3,
        successfulReplies: 4,
      },
      onCountersChanged: counters => persistedSnapshots.push(counters),
    })

    state.recordAcceptedMessage({ operationSequence: 1, surface: 'text-direct-message' })
    state.recordSuccessfulReply({ operationSequence: 1, surface: 'text-direct-message' })

    expect(state.getSnapshot()).toMatchObject({
      acceptedMessages: 6,
      failedReplies: 2,
      rejectedMessages: 3,
      successfulReplies: 5,
    })
    expect(persistedSnapshots).toEqual([
      {
        acceptedMessages: 6,
        failedReplies: 2,
        rejectedMessages: 3,
        successfulReplies: 4,
      },
      {
        acceptedMessages: 6,
        failedReplies: 2,
        rejectedMessages: 3,
        successfulReplies: 5,
      },
    ])
  })

  /**
   * @example
   * it('logs ignored messages without changing accepted or rejected counters', () => {})
   */
  it('logs ignored messages without changing accepted or rejected counters', () => {
    const state = new StandaloneDashboardState()

    state.recordIgnoredMessage({ operationSequence: 1, reason: 'mention-required', surface: 'text-guild' })

    const snapshot = state.getSnapshot()

    /**
     * @example
     * expect(snapshot.acceptedMessages).toBe(0)
     */
    expect(snapshot.acceptedMessages).toBe(0)
    /**
     * @example
     * expect(snapshot.rejectedMessages).toBe(0)
     */
    expect(snapshot.rejectedMessages).toBe(0)
    /**
     * @example
     * expect(snapshot.events[0].code).toBe('message-ignored')
     */
    expect(snapshot.events[0].code).toBe('message-ignored')
    /**
     * @example
     * expect(snapshot.events[0].reason).toBe('mention-required')
     */
    expect(snapshot.events[0].reason).toBe('mention-required')
  })

  /**
   * @example
   * it('keeps a bounded runtime log with newest events first', () => {})
   */
  it('keeps a bounded runtime log with newest events first', () => {
    const state = new StandaloneDashboardState()

    for (let i = 1; i <= 205; i += 1) {
      state.recordEvent({ code: 'message-accepted', operationSequence: i, surface: 'text-guild' })
    }

    const snapshot = state.getSnapshot()

    /**
     * @example
     * expect(snapshot.events).toHaveLength(200)
     */
    expect(snapshot.events).toHaveLength(200)
    /**
     * @example
     * expect(snapshot.events[0].operationSequence).toBe(205)
     */
    expect(snapshot.events[0].operationSequence).toBe(205)
    /**
     * @example
     * expect(snapshot.events.at(-1)?.operationSequence).toBe(6)
     */
    expect(snapshot.events.at(-1)?.operationSequence).toBe(6)
  })

  /**
   * @example
   * it('records bounded content-free voice stages through the dashboard boundary', () => {})
   */
  it('records bounded content-free voice stages through the dashboard boundary', () => {
    // ROOT CAUSE:
    //
    // The live voice pipeline previously exposed no structured receiver, provider, or
    // playback state. A failed human E2E therefore could not be localized past join.
    //
    // Before this patch, StandaloneDashboardState had no voice diagnostics boundary.
    //
    // We fixed this with a strict signal state machine whose snapshot contains only
    // anonymous sequences, bounded counts, allowlisted stages, and fixed outcomes.
    const state = new StandaloneDashboardState()
    const unsafeSignal = {
      audioPayload: 'synthetic-audio-sentinel',
      endpoint: 'https://synthetic.invalid/private',
      message: 'synthetic-transcript-sentinel',
      mode: 'qwen-realtime',
      runtimeSequence: 1,
      secret: 'synthetic-secret-sentinel',
      sessionSequence: 41,
      stage: 'session-started',
      userId: '999999999999999999',
    } as const

    state.recordVoiceDiagnostic(unsafeSignal)
    state.recordVoiceDiagnostic({ runtimeSequence: 1, sessionSequence: 41, stage: 'transport-ready' })
    state.recordVoiceDiagnostic({ runtimeSequence: 1, sessionSequence: 41, stage: 'provider-ready' })
    state.recordVoiceDiagnostic({ runtimeSequence: 1, sessionSequence: 41, stage: 'speaking-started', turnSequence: 1 })
    state.recordVoiceDiagnostic({ opusBytes: 64, opusPackets: 1, pcmBytes: 128, pcmFrames: 2, runtimeSequence: 1, sessionSequence: 41, stage: 'receiver-audio', turnSequence: 1 })
    state.recordVoiceDiagnostic({ inputKind: 'user-audio', providerInputBytes: 128, providerInputChunks: 2, runtimeSequence: 1, sessionSequence: 41, stage: 'provider-input-appended', turnSequence: 1 })
    state.recordVoiceDiagnostic({
      aggregateTurnSequence: 1,
      captureTurnSequences: [1],
      runtimeSequence: 1,
      sessionSequence: 41,
      stage: 'provider-input-committed',
      turnSequence: 1,
    })
    state.recordVoiceDiagnostic({ runtimeSequence: 1, sessionSequence: 41, stage: 'provider-vad', turnSequence: 1 })
    state.recordVoiceDiagnostic({ runtimeSequence: 1, sessionSequence: 41, stage: 'provider-response-created', turnSequence: 1 })
    state.recordVoiceDiagnostic({ responseAudioBytes: 192, responseAudioChunks: 3, runtimeSequence: 1, sessionSequence: 41, stage: 'provider-response-audio', turnSequence: 1 })
    state.recordVoiceDiagnostic({ playerState: 'buffering', runtimeSequence: 1, sessionSequence: 41, stage: 'player-state', turnSequence: 1 })
    state.recordVoiceDiagnostic({ playerState: 'playing', runtimeSequence: 1, sessionSequence: 41, stage: 'player-state', turnSequence: 1 })
    state.recordVoiceDiagnostic({ runtimeSequence: 1, sessionSequence: 41, stage: 'playback-started', turnSequence: 1 })
    state.recordVoiceDiagnostic({ runtimeSequence: 1, sessionSequence: 41, stage: 'provider-response-completed', turnSequence: 1 })
    state.recordVoiceDiagnostic({ runtimeSequence: 1, sessionSequence: 41, stage: 'playback-completed', turnSequence: 1 })
    state.recordVoiceDiagnostic({ playerState: 'idle', runtimeSequence: 1, sessionSequence: 41, stage: 'player-state', turnSequence: 1 })
    state.recordVoiceDiagnostic({ cleanupReason: 'dismissed', runtimeSequence: 1, sessionSequence: 41, stage: 'session-cleaned' })

    const snapshot = state.getSnapshot()
    const serialized = JSON.stringify(snapshot.voiceDiagnostics)

    /**
     * @example
     * expect(snapshot.voiceDiagnostics.active).toHaveLength(0)
     */
    expect(snapshot.voiceDiagnostics.active).toHaveLength(0)
    /**
     * @example
     * expect(snapshot.voiceDiagnostics.completed[0]).toMatchObject({})
     */
    expect(snapshot.voiceDiagnostics.completed[0]).toMatchObject({
      completionReason: 'dismissed',
      outcome: 'response-audio',
      providerReady: true,
      sessionSequence: 41,
      stage: 'completed',
      transportReady: true,
    })
    /**
     * @example
     * expect(snapshot.voiceDiagnostics.completed[0].turns[0]).toMatchObject({})
     */
    expect(snapshot.voiceDiagnostics.completed[0].turns[0]).toMatchObject({
      aggregateTurnSequence: 1,
      captureTurnSequences: [1],
      inputAppends: 2,
      inputCommits: 1,
      outcome: 'response-audio',
      opusBytes: 64,
      opusPackets: 1,
      playbackCompleted: 1,
      playbackStarted: 1,
      playerState: 'idle',
      providerVadTurns: 1,
      receiverAudioObserved: true,
      pcmBytes: 128,
      pcmFrames: 2,
      responseAudioChunks: 3,
      responsesCompleted: 1,
      responsesStarted: 1,
      syntheticInputAppends: 0,
      syntheticInputBytes: 0,
      turnSequence: 1,
      userInputAppends: 2,
      userInputBytes: 128,
    })
    /**
     * @example
     * expect(serialized).not.toContain('synthetic-secret-sentinel')
     */
    expect(serialized).not.toContain('synthetic-secret-sentinel')
    /**
     * @example
     * expect(serialized).not.toContain('999999999999999999')
     */
    expect(serialized).not.toContain('999999999999999999')
    /**
     * @example
     * expect(serialized).not.toContain('synthetic-transcript-sentinel')
     */
    expect(serialized).not.toContain('synthetic-transcript-sentinel')
    /**
     * @example
     * expect(serialized).not.toContain('synthetic-audio-sentinel')
     */
    expect(serialized).not.toContain('synthetic-audio-sentinel')
    /**
     * @example
     * expect(serialized).not.toContain('synthetic.invalid')
     */
    expect(serialized).not.toContain('synthetic.invalid')
  })

  /**
   * @example
   * it('distinguishes no input, no provider response, and player failure', () => {})
   */
  it('distinguishes no input, no provider response, and player failure', () => {
    const diagnostics = new StandaloneVoiceDiagnostics()

    diagnostics.record({ mode: 'qwen-realtime', runtimeSequence: 1, sessionSequence: 1, stage: 'session-started' })
    diagnostics.record({ cleanupReason: 'dismissed', runtimeSequence: 1, sessionSequence: 1, stage: 'session-cleaned' })

    diagnostics.record({ mode: 'qwen-realtime', runtimeSequence: 1, sessionSequence: 2, stage: 'session-started' })
    diagnostics.record({ opusBytes: 32, opusPackets: 1, pcmBytes: 64, pcmFrames: 1, runtimeSequence: 1, sessionSequence: 2, stage: 'receiver-audio', turnSequence: 1 })
    diagnostics.record({
      aggregateTurnSequence: 1,
      captureTurnSequences: [1],
      runtimeSequence: 1,
      sessionSequence: 2,
      stage: 'provider-input-committed',
      turnSequence: 1,
    })
    diagnostics.record({ cleanupReason: 'dismissed', runtimeSequence: 1, sessionSequence: 2, stage: 'session-cleaned' })

    diagnostics.record({ mode: 'qwen-realtime', runtimeSequence: 1, sessionSequence: 3, stage: 'session-started' })
    diagnostics.record({ responseAudioBytes: 64, responseAudioChunks: 1, runtimeSequence: 1, sessionSequence: 3, stage: 'provider-response-audio', turnSequence: 1 })
    diagnostics.record({ failureCategory: 'playback-error', runtimeSequence: 1, sessionSequence: 3, stage: 'failure', turnSequence: 1 })
    diagnostics.record({ cleanupReason: 'failed', runtimeSequence: 1, sessionSequence: 3, stage: 'session-cleaned' })

    const snapshot = diagnostics.getSnapshot()

    /**
     * @example
     * expect(snapshot.completed.map(session => session.outcome)).toEqual([])
     */
    expect(snapshot.completed.map(session => session.outcome)).toEqual([
      'player-failure',
      'provider-no-response',
      'no-input',
    ])
    /**
     * @example
     * expect(snapshot.completed[0].turns[0].failureCategory).toBe('resource-error')
     */
    expect(snapshot.completed[0].turns[0].failureCategory).toBe('playback-error')
    const providerNoResponse = snapshot.completed.find(session => session.sessionSequence === 2)
    expect(providerNoResponse?.turns[0]).toMatchObject({
      aggregateTurnSequence: 1,
      captureTurnSequences: [1],
      inputCommits: 1,
      turnSequence: 1,
    })
  })

  /**
   * @example
   * it('bounds active and completed diagnostics and reports saturation', () => {})
   */
  it('bounds active and completed diagnostics and reports saturation', () => {
    const diagnostics = new StandaloneVoiceDiagnostics()

    for (let sessionSequence = 1; sessionSequence <= 20; sessionSequence += 1)
      diagnostics.record({ mode: 'qwen-realtime', runtimeSequence: 1, sessionSequence, stage: 'session-started' })

    const saturated = diagnostics.getSnapshot()

    /**
     * @example
     * expect(saturated.active).toHaveLength(16)
     */
    expect(saturated.active).toHaveLength(16)
    /**
     * @example
     * expect(saturated.saturatedSessions).toBe(4)
     */
    expect(saturated.saturatedSessions).toBe(4)

    diagnostics.finalizeAllActive('stopped')

    for (let sessionSequence = 21; sessionSequence <= 60; sessionSequence += 1) {
      diagnostics.record({ mode: 'qwen-realtime', runtimeSequence: 1, sessionSequence, stage: 'session-started' })
      diagnostics.record({ cleanupReason: 'dismissed', runtimeSequence: 1, sessionSequence, stage: 'session-cleaned' })
    }

    const completed = diagnostics.getSnapshot()

    /**
     * @example
     * expect(completed.active).toHaveLength(0)
     */
    expect(completed.active).toHaveLength(0)
    /**
     * @example
     * expect(completed.completed).toHaveLength(24)
     */
    expect(completed.completed).toHaveLength(24)
    /**
     * @example
     * expect(completed.completed[0].sessionSequence).toBe(60)
     */
    expect(completed.completed[0].sessionSequence).toBe(60)
    /**
     * @example
     * expect(completed.completed.at(-1)?.sessionSequence).toBe(37)
     */
    expect(completed.completed.at(-1)?.sessionSequence).toBe(37)
  })

  /**
   * @example
   * it('returns deeply detached voice diagnostic snapshots', () => {})
   */
  it('returns deeply detached voice diagnostic snapshots', () => {
    const diagnostics = new StandaloneVoiceDiagnostics()

    diagnostics.record({ mode: 'qwen-realtime', runtimeSequence: 1, sessionSequence: 1, stage: 'session-started' })
    diagnostics.record({ opusBytes: 8, opusPackets: 1, pcmBytes: 16, pcmFrames: 1, runtimeSequence: 1, sessionSequence: 1, stage: 'receiver-audio', turnSequence: 1 })

    const first = diagnostics.getSnapshot()
    first.active[0].turns[0].pcmBytes = 0
    first.active[0].turns.splice(0)
    first.active.splice(0)

    const second = diagnostics.getSnapshot()

    /**
     * @example
     * expect(second.active).toHaveLength(1)
     */
    expect(second.active).toHaveLength(1)
    /**
     * @example
     * expect(second.active[0].turns).toHaveLength(1)
     */
    expect(second.active[0].turns).toHaveLength(1)
    /**
     * @example
     * expect(second.active[0].turns[0].receiverBytes).toBe(16)
     */
    expect(second.active[0].turns[0].pcmBytes).toBe(16)
  })
})

/**
 * @example
 * describe('standalone dashboard settings', () => {})
 */
describe('standalone dashboard settings', () => {
  /**
   * @example
   * it('uses local defaults and bounded ports', () => {})
   */
  it('uses local defaults and bounded ports', () => {
    const defaults = resolveStandaloneDashboardServerSettings({})
    const disabled = resolveStandaloneDashboardServerSettings({
      AIRI_DISCORD_DASHBOARD_ENABLED: 'false',
      AIRI_DISCORD_DASHBOARD_HOST: 'localhost',
      AIRI_DISCORD_DASHBOARD_PORT: '999999',
    })

    /**
     * @example
     * expect(defaults.enabled).toBe(true)
     */
    expect(defaults.enabled).toBe(true)
    /**
     * @example
     * expect(defaults.host).toBe('127.0.0.1')
     */
    expect(defaults.host).toBe('127.0.0.1')
    expect(resolveStandaloneDashboardServerSettings({
      AIRI_DISCORD_DASHBOARD_HOST: '0.0.0.0',
    }).host).toBe('127.0.0.1')
    /**
     * @example
     * expect(defaults.port).toBe(6122)
     */
    expect(defaults.port).toBe(6122)
    /**
     * @example
     * expect(disabled.enabled).toBe(false)
     */
    expect(disabled.enabled).toBe(false)
    /**
     * @example
     * expect(disabled.port).toBe(65535)
     */
    expect(disabled.port).toBe(65535)
  })
})
