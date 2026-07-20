import { describe, expect, it } from 'vitest'

import { StandaloneCapabilityDiagnostics } from './capability-diagnostics'

function startVoiceDiagnosis(randomToken: string): StandaloneCapabilityDiagnostics {
  const diagnostics = new StandaloneCapabilityDiagnostics({ randomToken: () => randomToken })
  const started = diagnostics.start({ artifact: { artifactKind: 'standalone-discord-bot', diagnosticsContractVersion: '1', productVersion: 'test', startedAt: '2026-07-19T00:00:00.000Z' }, botReady: true, configuration: { discordConfigured: true, providerConfigured: true }, dashboardApiHealthy: true })
  if (!started)
    throw new Error('Diagnostic start unexpectedly rejected.')
  diagnostics.recordTextAccepted(started.marker, 1)
  diagnostics.recordTextReplySent(1)
  diagnostics.confirm('text-reply-correct')
  diagnostics.recordVoice({ mode: 'qwen-realtime', runtimeSequence: 1, sessionSequence: 1, stage: 'session-started' })
  diagnostics.recordVoice({ runtimeSequence: 1, sessionSequence: 1, stage: 'transport-ready' })
  diagnostics.recordVoice({ runtimeSequence: 1, sessionSequence: 1, stage: 'provider-ready' })
  diagnostics.confirm('voice-consent-join')
  return diagnostics
}

function completeVoiceTurn(diagnostics: StandaloneCapabilityDiagnostics, turnSequence: number): void {
  diagnostics.recordVoice({ runtimeSequence: 1, sessionSequence: 1, stage: 'speaking-started', turnSequence })
  diagnostics.recordVoice({ opusBytes: 1, opusPackets: 1, pcmBytes: 1, pcmFrames: 1, runtimeSequence: 1, sessionSequence: 1, stage: 'receiver-audio', turnSequence })
  diagnostics.recordVoice({ runtimeSequence: 1, sessionSequence: 1, stage: 'local-input-admitted', turnSequence })
  diagnostics.recordVoice({ inputKind: 'user-audio', providerInputBytes: 1, providerInputChunks: 1, runtimeSequence: 1, sessionSequence: 1, stage: 'provider-input-appended', turnSequence })
  diagnostics.recordVoice({ aggregateTurnSequence: turnSequence, captureTurnSequences: [turnSequence], runtimeSequence: 1, sessionSequence: 1, stage: 'provider-input-committed', turnSequence })
  diagnostics.recordVoice({ runtimeSequence: 1, sessionSequence: 1, stage: 'provider-vad', turnSequence })
  diagnostics.recordVoice({ runtimeSequence: 1, sessionSequence: 1, stage: 'provider-response-created', turnSequence })
  diagnostics.recordVoice({ responseAudioBytes: 1, responseAudioChunks: 1, runtimeSequence: 1, sessionSequence: 1, stage: 'provider-response-audio', turnSequence })
  diagnostics.recordVoice({ runtimeSequence: 1, sessionSequence: 1, stage: 'playback-started', turnSequence })
  diagnostics.recordVoice({ runtimeSequence: 1, sessionSequence: 1, stage: 'playback-completed', turnSequence })
}

/** @example describe('standalone capability diagnostics', () => {}) */
describe('standalone capability diagnostics', () => {
  /** @example it('keeps a production text and voice diagnosis ordered and confirmation-gated', () => {}) */
  it('keeps a production text and voice diagnosis ordered and confirmation-gated', () => {
    const now = 1_000
    const diagnostics = new StandaloneCapabilityDiagnostics({ now: () => now, randomToken: () => 'marker' })

    const started = diagnostics.start({
      artifact: { artifactKind: 'standalone-discord-bot', diagnosticsContractVersion: '1', productVersion: 'unknown', startedAt: '2026-07-19T00:00:00.000Z' },
      configuration: { discordConfigured: true, providerConfigured: true },
      dashboardApiHealthy: true,
    })
    /** @example expect(started).toEqual({ marker: 'airi-diagnostic-marker' }) */
    expect(started).toEqual({ marker: 'airi-diagnostic-marker' })
    /** @example expect(diagnostics.start({ artifact: { artifactKind: 'standalone-discord-bot', diagnosticsContractVersion: '1', productVersion: 'unknown', startedAt: '2026-07-19T00:00:00.000Z' }, configuration: { discordConfigured: true, providerConfigured: true }, dashboardApiHealthy: true })).toBeUndefined() */
    expect(diagnostics.start({
      artifact: { artifactKind: 'standalone-discord-bot', diagnosticsContractVersion: '1', productVersion: 'unknown', startedAt: '2026-07-19T00:00:00.000Z' },
      configuration: { discordConfigured: true, providerConfigured: true },
      dashboardApiHealthy: true,
    })).toBeUndefined()
    if (!started)
      throw new Error('Diagnostic start unexpectedly rejected.')
    diagnostics.recordBotReady()
    diagnostics.recordCommandsRegistered()
    diagnostics.recordTextAccepted(started.marker, 7)
    diagnostics.recordTextReplySent(7)

    /** @example expect(diagnostics.getSnapshot().boundaries.find(boundary => boundary.id === 'text-reply-correct')?.status).toBe('unproven') */
    expect(diagnostics.getSnapshot().boundaries.find(boundary => boundary.id === 'text-reply-correct')?.status).toBe('unproven')
    /** @example expect(diagnostics.confirm('text-reply-correct')).toBe(true) */
    expect(diagnostics.confirm('text-reply-correct')).toBe(true)

    diagnostics.recordVoice({ mode: 'qwen-realtime', runtimeSequence: 1, sessionSequence: 1, stage: 'session-started' })
    /** @example expect(diagnostics.getSnapshot().boundaries.find(boundary => boundary.id === 'voice-consent-join')?.status).toBe('unproven') */
    expect(diagnostics.getSnapshot().boundaries.find(boundary => boundary.id === 'voice-consent-join')?.status).toBe('unproven')
    /** @example expect(diagnostics.confirm('voice-consent-join')).toBe(true) */
    expect(diagnostics.confirm('voice-consent-join')).toBe(true)
    diagnostics.recordVoice({ runtimeSequence: 1, sessionSequence: 1, stage: 'transport-ready' })
    diagnostics.recordVoice({ runtimeSequence: 1, sessionSequence: 1, stage: 'provider-ready' })
    diagnostics.recordVoice({ runtimeSequence: 1, sessionSequence: 1, stage: 'speaking-started', turnSequence: 1 })
    diagnostics.recordVoice({ runtimeSequence: 1, sessionSequence: 1, stage: 'receiver-audio', turnSequence: 1, opusBytes: 1, opusPackets: 1, pcmBytes: 1, pcmFrames: 1 })
    diagnostics.recordVoice({ runtimeSequence: 1, sessionSequence: 1, stage: 'local-input-admitted', turnSequence: 1 })
    diagnostics.recordVoice({ inputKind: 'user-audio', providerInputBytes: 1, providerInputChunks: 1, runtimeSequence: 1, sessionSequence: 1, stage: 'provider-input-appended', turnSequence: 1 })
    diagnostics.recordVoice({ aggregateTurnSequence: 1, captureTurnSequences: [1], runtimeSequence: 1, sessionSequence: 1, stage: 'provider-input-committed', turnSequence: 1 })
    diagnostics.recordVoice({ runtimeSequence: 1, sessionSequence: 1, stage: 'provider-vad', turnSequence: 1 })
    diagnostics.recordVoice({ runtimeSequence: 1, sessionSequence: 1, stage: 'provider-response-created', turnSequence: 1 })
    diagnostics.recordVoice({ responseAudioBytes: 1, responseAudioChunks: 1, runtimeSequence: 1, sessionSequence: 1, stage: 'provider-response-audio', turnSequence: 1 })
    diagnostics.recordVoice({ runtimeSequence: 1, sessionSequence: 1, stage: 'playback-started', turnSequence: 1 })
    diagnostics.recordVoice({ runtimeSequence: 1, sessionSequence: 1, stage: 'playback-completed', turnSequence: 1 })

    /** @example expect(diagnostics.confirm('voice-heard')).toBe(true) */
    expect(diagnostics.confirm('voice-heard')).toBe(true)
    diagnostics.recordVoice({ cleanupReason: 'dismissed', runtimeSequence: 1, sessionSequence: 1, stage: 'session-cleaned' })
    /** @example expect(diagnostics.getSnapshot().lastSuccessfulBoundary).toBe('voice-cleanup') */
    expect(diagnostics.getSnapshot().lastSuccessfulBoundary).toBe('voice-cleanup')
    /** @example expect(diagnostics.getSnapshot().firstFailedOrBlockedBoundary).toBeUndefined() */
    expect(diagnostics.getSnapshot().firstFailedOrBlockedBoundary).toBeUndefined()
  })

  /** @example it('fails closed after the first failed boundary and expires ephemeral challenges', () => {}) */
  it('fails closed after the first failed boundary and expires ephemeral challenges', () => {
    let now = 1_000
    const diagnostics = new StandaloneCapabilityDiagnostics({ now: () => now, randomToken: () => 'marker' })
    diagnostics.start({
      artifact: { artifactKind: 'standalone-discord-bot', diagnosticsContractVersion: '1', productVersion: 'unknown', startedAt: '2026-07-19T00:00:00.000Z' },
      configuration: { discordConfigured: false, providerConfigured: true },
      dashboardApiHealthy: true,
    })
    const failed = diagnostics.getSnapshot()
    /** @example expect(failed.firstFailedOrBlockedBoundary).toBe('configuration') */
    expect(failed.firstFailedOrBlockedBoundary).toBe('configuration')
    /** @example expect(failed.boundaries.find(boundary => boundary.id === 'bot-ready')?.status).toBe('blocked') */
    expect(failed.boundaries.find(boundary => boundary.id === 'bot-ready')?.status).toBe('blocked')

    now += 16 * 60_000
    /** @example expect(diagnostics.getSnapshot().phase).toBe('timed-out') */
    expect(diagnostics.getSnapshot().phase).toBe('timed-out')
    /** @example expect(diagnostics.matchesTextChallenge('marker')).toBe(false) */
    expect(diagnostics.matchesTextChallenge('marker')).toBe(false)
  })

  /** @example it('binds voice evidence to one ordered session and turn', () => {}) */
  it('binds voice evidence to one ordered session and turn', () => {
    const diagnostics = new StandaloneCapabilityDiagnostics({ randomToken: () => 'marker' })
    const started = diagnostics.start({
      artifact: { artifactKind: 'standalone-discord-bot', diagnosticsContractVersion: '1', productVersion: 'unknown', startedAt: '2026-07-19T00:00:00.000Z' },
      botReady: true,
      configuration: { discordConfigured: true, providerConfigured: true },
      dashboardApiHealthy: true,
    })
    if (!started)
      throw new Error('Diagnostic start unexpectedly rejected.')
    diagnostics.recordTextAccepted(started.marker, 1)
    diagnostics.recordTextReplySent(1)
    diagnostics.confirm('text-reply-correct')
    // ROOT CAUSE:
    // Run-wide booleans previously combined observations from separate turns.
    // The state machine now admits only one session and a strict turn chain.
    diagnostics.recordVoice({ mode: 'qwen-realtime', runtimeSequence: 1, sessionSequence: 1, stage: 'session-started' })
    diagnostics.recordVoice({ runtimeSequence: 1, sessionSequence: 1, stage: 'transport-ready' })
    diagnostics.recordVoice({ runtimeSequence: 1, sessionSequence: 1, stage: 'provider-ready' })
    diagnostics.confirm('voice-consent-join')
    diagnostics.recordVoice({ runtimeSequence: 1, sessionSequence: 1, stage: 'speaking-started', turnSequence: 1 })
    diagnostics.recordVoice({ opusBytes: 1, opusPackets: 1, pcmBytes: 1, pcmFrames: 1, runtimeSequence: 1, sessionSequence: 1, stage: 'receiver-audio', turnSequence: 2 })
    diagnostics.recordVoice({ runtimeSequence: 1, sessionSequence: 1, stage: 'local-input-admitted', turnSequence: 1 })
    /** @example expect(diagnostics.getSnapshot().boundaries.find(boundary => boundary.id === 'voice-opus-pcm-admission')?.status).toBe('unproven') */
    expect(diagnostics.getSnapshot().boundaries.find(boundary => boundary.id === 'voice-opus-pcm-admission')?.status).toBe('unproven')
    diagnostics.recordVoice({ opusBytes: 1, opusPackets: 1, pcmBytes: 1, pcmFrames: 1, runtimeSequence: 1, sessionSequence: 1, stage: 'receiver-audio', turnSequence: 1 })
    diagnostics.recordVoice({ runtimeSequence: 1, sessionSequence: 1, stage: 'local-input-admitted', turnSequence: 1 })
    diagnostics.recordVoice({ inputKind: 'user-audio', providerInputBytes: 1, providerInputChunks: 1, runtimeSequence: 1, sessionSequence: 1, stage: 'provider-input-appended', turnSequence: 1 })
    diagnostics.recordVoice({ aggregateTurnSequence: 1, captureTurnSequences: [1], runtimeSequence: 1, sessionSequence: 1, stage: 'provider-input-committed', turnSequence: 1 })
    diagnostics.recordVoice({ runtimeSequence: 1, sessionSequence: 1, stage: 'provider-vad', turnSequence: 1 })
    diagnostics.recordVoice({ responseAudioBytes: 1, responseAudioChunks: 1, runtimeSequence: 1, sessionSequence: 1, stage: 'provider-response-audio', turnSequence: 1 })
    /** @example expect(diagnostics.getSnapshot().boundaries.find(boundary => boundary.id === 'voice-provider-response')?.status).toBe('unproven') */
    expect(diagnostics.getSnapshot().boundaries.find(boundary => boundary.id === 'voice-provider-response')?.status).toBe('unproven')
    diagnostics.recordVoice({ runtimeSequence: 1, sessionSequence: 1, stage: 'provider-response-created', turnSequence: 1 })
    diagnostics.recordVoice({ responseAudioBytes: 1, responseAudioChunks: 1, runtimeSequence: 1, sessionSequence: 1, stage: 'provider-response-audio', turnSequence: 1 })
    diagnostics.recordVoice({ runtimeSequence: 1, sessionSequence: 1, stage: 'playback-started', turnSequence: 1 })
    diagnostics.recordVoice({ runtimeSequence: 1, sessionSequence: 1, stage: 'playback-completed', turnSequence: 2 })
    /** @example expect(diagnostics.getSnapshot().boundaries.find(boundary => boundary.id === 'voice-playback')?.status).toBe('unproven') */
    expect(diagnostics.getSnapshot().boundaries.find(boundary => boundary.id === 'voice-playback')?.status).toBe('unproven')
  })

  /** @example it('consumes an admitted marker exactly once and reports the first non-pass boundary', () => {}) */
  it('consumes an admitted marker exactly once and reports the first non-pass boundary', () => {
    const diagnostics = new StandaloneCapabilityDiagnostics({ randomToken: () => 'real-marker' })
    const started = diagnostics.start({ artifact: { artifactKind: 'standalone-discord-bot', diagnosticsContractVersion: '1', productVersion: 'unknown', startedAt: '2026-07-19T00:00:00.000Z' }, botReady: true, configuration: { discordConfigured: true, providerConfigured: true }, dashboardApiHealthy: true })
    if (!started)
      throw new Error('Diagnostic start unexpectedly rejected.')
    /** @example expect(diagnostics.matchesTextChallenge(started.marker)).toBe(true) */
    expect(diagnostics.matchesTextChallenge(started.marker)).toBe(true)
    diagnostics.recordTextAccepted(started.marker, 7)
    /** @example expect(diagnostics.matchesTextChallenge(started.marker)).toBe(false) */
    expect(diagnostics.matchesTextChallenge(started.marker)).toBe(false)
    diagnostics.recordTextReplyFailed(7)
    const snapshot = diagnostics.getSnapshot()
    /** @example expect(snapshot.firstNonPassBoundary).toBe('text-reply-sent') */
    expect(snapshot.firstNonPassBoundary).toBe('text-reply-sent')
    /** @example expect(snapshot.lastSuccessfulBoundary).toBe('text-ingress') */
    expect(snapshot.lastSuccessfulBoundary).toBe('text-ingress')
  })

  /** @example it('expires and invalidates the exact published marker without retaining diagnostic content', () => {}) */
  it('expires and invalidates the exact published marker without retaining diagnostic content', () => {
    let now = 0
    const diagnostics = new StandaloneCapabilityDiagnostics({ now: () => now, randomToken: () => 'generated-marker' })
    const started = diagnostics.start({
      artifact: { artifactKind: 'standalone-discord-bot', diagnosticsContractVersion: '1', productVersion: 'unknown', startedAt: '2026-07-19T00:00:00.000Z' },
      botReady: true,
      configuration: { discordConfigured: true, providerConfigured: true },
      dashboardApiHealthy: true,
    })
    if (!started)
      throw new Error('Diagnostic start unexpectedly rejected.')
    /** @example expect(started.marker).toBe('airi-diagnostic-generated-marker') */
    expect(started.marker).toBe('airi-diagnostic-generated-marker')
    diagnostics.recordTextAccepted(started.marker, 11)
    diagnostics.recordTextAccepted(started.marker, 12)
    const consumed = JSON.stringify(diagnostics.getSnapshot())
    /** @example expect(consumed).not.toContain(started.marker) */
    expect(consumed).not.toContain(started.marker)
    /** @example expect(diagnostics.getSnapshot().boundaries.find(boundary => boundary.id === 'text-ingress')?.status).toBe('pass') */
    expect(diagnostics.getSnapshot().boundaries.find(boundary => boundary.id === 'text-ingress')?.status).toBe('pass')
    diagnostics.cancel()
    /** @example expect(diagnostics.matchesTextChallenge(started.marker)).toBe(false) */
    expect(diagnostics.matchesTextChallenge(started.marker)).toBe(false)

    const restarted = diagnostics.start({
      artifact: { artifactKind: 'standalone-discord-bot', diagnosticsContractVersion: '1', productVersion: 'unknown', startedAt: '2026-07-19T00:00:00.000Z' },
      botReady: true,
      configuration: { discordConfigured: true, providerConfigured: true },
      dashboardApiHealthy: true,
    })
    if (!restarted)
      throw new Error('Diagnostic restart unexpectedly rejected.')
    now = 16 * 60_000
    const timedOut = diagnostics.getSnapshot()
    /** @example expect(timedOut.phase).toBe('timed-out') */
    expect(timedOut.phase).toBe('timed-out')
    /** @example expect(timedOut.marker).toBeUndefined() */
    expect(timedOut.marker).toBeUndefined()
    /** @example expect(diagnostics.matchesTextChallenge(restarted.marker)).toBe(false) */
    expect(diagnostics.matchesTextChallenge(restarted.marker)).toBe(false)
  })

  /** @example it('consumes production readiness emitted before consent without accepting another session', () => {}) */
  it('consumes production readiness emitted before consent without accepting another session', () => {
    const diagnostics = new StandaloneCapabilityDiagnostics({ randomToken: () => 'marker' })
    const started = diagnostics.start({ artifact: { artifactKind: 'standalone-discord-bot', diagnosticsContractVersion: '1', productVersion: 'test', startedAt: '2026-07-19T00:00:00.000Z' }, botReady: true, configuration: { discordConfigured: true, providerConfigured: true }, dashboardApiHealthy: true })
    if (!started)
      throw new Error('Diagnostic start unexpectedly rejected.')
    diagnostics.recordTextAccepted(started.marker, 1)
    diagnostics.recordTextReplySent(1)
    diagnostics.confirm('text-reply-correct')

    // `/summon` emits these production boundaries before the user can confirm consent.
    diagnostics.recordVoice({ mode: 'qwen-realtime', runtimeSequence: 1, sessionSequence: 1, stage: 'session-started' })
    diagnostics.recordVoice({ runtimeSequence: 1, sessionSequence: 1, stage: 'transport-ready' })
    diagnostics.recordVoice({ runtimeSequence: 1, sessionSequence: 1, stage: 'provider-ready' })
    diagnostics.recordVoice({ runtimeSequence: 1, sessionSequence: 2, stage: 'transport-ready' })
    /** @example expect(diagnostics.confirm('voice-consent-join')).toBe(true) */
    expect(diagnostics.confirm('voice-consent-join')).toBe(true)
    const snapshot = diagnostics.getSnapshot()
    /** @example expect(snapshot.boundaries.find(boundary => boundary.id === 'voice-transport')?.status).toBe('pass') */
    expect(snapshot.boundaries.find(boundary => boundary.id === 'voice-transport')?.status).toBe('pass')
    /** @example expect(snapshot.boundaries.find(boundary => boundary.id === 'voice-provider')?.status).toBe('pass') */
    expect(snapshot.boundaries.find(boundary => boundary.id === 'voice-provider')?.status).toBe('pass')
  })

  /** @example it('rejects stale signals after a terminal cleanup or terminal turn signal', () => {}) */
  it('rejects stale signals after a terminal cleanup or terminal turn signal', () => {
    const diagnostics = new StandaloneCapabilityDiagnostics({ randomToken: () => 'marker' })
    const started = diagnostics.start({ artifact: { artifactKind: 'standalone-discord-bot', diagnosticsContractVersion: '1', productVersion: 'test', startedAt: '2026-07-19T00:00:00.000Z' }, botReady: true, configuration: { discordConfigured: true, providerConfigured: true }, dashboardApiHealthy: true })
    if (!started)
      throw new Error('Diagnostic start unexpectedly rejected.')
    diagnostics.recordTextAccepted(started.marker, 1)
    diagnostics.recordTextReplySent(1)
    diagnostics.confirm('text-reply-correct')
    diagnostics.recordVoice({ mode: 'qwen-realtime', runtimeSequence: 1, sessionSequence: 1, stage: 'session-started' })
    diagnostics.recordVoice({ runtimeSequence: 1, sessionSequence: 1, stage: 'transport-ready' })
    diagnostics.recordVoice({ runtimeSequence: 1, sessionSequence: 1, stage: 'provider-ready' })
    diagnostics.confirm('voice-consent-join')
    diagnostics.recordVoice({ cleanupReason: 'dismissed', runtimeSequence: 1, sessionSequence: 1, stage: 'session-cleaned' })
    diagnostics.recordVoice({ runtimeSequence: 1, sessionSequence: 1, stage: 'speaking-started', turnSequence: 1 })
    diagnostics.recordVoice({ runtimeSequence: 1, sessionSequence: 1, stage: 'transport-ready' })
    /** @example expect(diagnostics.getSnapshot().phase).toBe('running') */
    expect(diagnostics.getSnapshot().phase).toBe('running')
    /** @example expect(diagnostics.getSnapshot().boundaries.find(boundary => boundary.id === 'voice-cleanup')?.status).toBe('blocked') */
    expect(diagnostics.getSnapshot().boundaries.find(boundary => boundary.id === 'voice-cleanup')?.status).toBe('blocked')

    const response = new StandaloneCapabilityDiagnostics({ randomToken: () => 'response' })
    const responseStarted = response.start({ artifact: { artifactKind: 'standalone-discord-bot', diagnosticsContractVersion: '1', productVersion: 'test', startedAt: '2026-07-19T00:00:00.000Z' }, botReady: true, configuration: { discordConfigured: true, providerConfigured: true }, dashboardApiHealthy: true })
    if (!responseStarted)
      throw new Error('Diagnostic start unexpectedly rejected.')
    response.recordTextAccepted(responseStarted.marker, 1)
    response.recordTextReplySent(1)
    response.confirm('text-reply-correct')
    response.recordVoice({ mode: 'qwen-realtime', runtimeSequence: 1, sessionSequence: 1, stage: 'session-started' })
    response.recordVoice({ runtimeSequence: 1, sessionSequence: 1, stage: 'transport-ready' })
    response.recordVoice({ runtimeSequence: 1, sessionSequence: 1, stage: 'provider-ready' })
    response.confirm('voice-consent-join')
    response.recordVoice({ runtimeSequence: 1, sessionSequence: 1, stage: 'speaking-started', turnSequence: 1 })
    response.recordVoice({ opusBytes: 1, opusPackets: 1, pcmBytes: 1, pcmFrames: 1, runtimeSequence: 1, sessionSequence: 1, stage: 'receiver-audio', turnSequence: 1 })
    response.recordVoice({ runtimeSequence: 1, sessionSequence: 1, stage: 'local-input-admitted', turnSequence: 1 })
    response.recordVoice({ inputKind: 'user-audio', providerInputBytes: 1, providerInputChunks: 1, runtimeSequence: 1, sessionSequence: 1, stage: 'provider-input-appended', turnSequence: 1 })
    response.recordVoice({ aggregateTurnSequence: 1, captureTurnSequences: [1], runtimeSequence: 1, sessionSequence: 1, stage: 'provider-input-committed', turnSequence: 1 })
    response.recordVoice({ runtimeSequence: 1, sessionSequence: 1, stage: 'provider-vad', turnSequence: 1 })
    response.recordVoice({ runtimeSequence: 1, sessionSequence: 1, stage: 'provider-response-created', turnSequence: 1 })
    response.recordVoice({ runtimeSequence: 1, sessionSequence: 1, stage: 'provider-response-cancelled', turnSequence: 1 })
    response.recordVoice({ responseAudioBytes: 1, responseAudioChunks: 1, runtimeSequence: 1, sessionSequence: 1, stage: 'provider-response-audio', turnSequence: 1 })
    response.recordVoice({ runtimeSequence: 1, sessionSequence: 1, stage: 'playback-started', turnSequence: 1 })
    response.recordVoice({ runtimeSequence: 1, sessionSequence: 1, stage: 'playback-completed', turnSequence: 1 })
    /** @example expect(response.getSnapshot().boundaries.find(boundary => boundary.id === 'voice-provider-response')?.status).toBe('unproven') */
    expect(response.getSnapshot().boundaries.find(boundary => boundary.id === 'voice-provider-response')?.status).toBe('unproven')
  })

  /** @example it('makes a later production lifecycle failure visible after ready evidence', () => {}) */
  it('makes a later production lifecycle failure visible after ready evidence', () => {
    const diagnostics = new StandaloneCapabilityDiagnostics({ randomToken: () => 'marker' })
    diagnostics.start({ artifact: { artifactKind: 'standalone-discord-bot', diagnosticsContractVersion: '1', productVersion: 'test', startedAt: '2026-07-19T00:00:00.000Z' }, botReady: true, configuration: { discordConfigured: true, providerConfigured: true }, dashboardApiHealthy: true })
    diagnostics.recordBotFailure()
    const snapshot = diagnostics.getSnapshot()
    /** @example expect(snapshot.firstFailedOrBlockedBoundary).toBe('bot-ready') */
    expect(snapshot.firstFailedOrBlockedBoundary).toBe('bot-ready')
    /** @example expect(snapshot.lastSuccessfulBoundary).toBe('configuration') */
    expect(snapshot.lastSuccessfulBoundary).toBe('configuration')
    /** @example expect(snapshot.boundaries.find(boundary => boundary.id === 'global-commands')?.status).toBe('blocked') */
    expect(snapshot.boundaries.find(boundary => boundary.id === 'global-commands')?.status).toBe('blocked')
  })

  /** @example it('fails a prematurely cleaned session and never consumes its buffered consent readiness', () => {}) */
  it('fails a prematurely cleaned session and never consumes its buffered consent readiness', () => {
    // ROOT CAUSE:
    // A cleaned session left its pre-consent transport/provider observations buffered.
    // Confirmation then consumed that dead session's evidence and advanced the voice chain.
    // We fix this by terminally failing the first incomplete voice boundary and clearing
    // all session-scoped ownership before any confirmation can be considered.
    const diagnostics = new StandaloneCapabilityDiagnostics({ randomToken: () => 'cleanup-before-consent' })
    const started = diagnostics.start({ artifact: { artifactKind: 'standalone-discord-bot', diagnosticsContractVersion: '1', productVersion: 'test', startedAt: '2026-07-19T00:00:00.000Z' }, botReady: true, configuration: { discordConfigured: true, providerConfigured: true }, dashboardApiHealthy: true })
    if (!started)
      throw new Error('Diagnostic start unexpectedly rejected.')
    diagnostics.recordTextAccepted(started.marker, 1)
    diagnostics.recordTextReplySent(1)
    diagnostics.confirm('text-reply-correct')
    diagnostics.recordVoice({ mode: 'qwen-realtime', runtimeSequence: 1, sessionSequence: 1, stage: 'session-started' })
    diagnostics.recordVoice({ runtimeSequence: 1, sessionSequence: 1, stage: 'transport-ready' })
    diagnostics.recordVoice({ runtimeSequence: 1, sessionSequence: 1, stage: 'provider-ready' })
    diagnostics.recordVoice({ cleanupReason: 'dismissed', runtimeSequence: 1, sessionSequence: 1, stage: 'session-cleaned' })
    diagnostics.recordVoice({ runtimeSequence: 1, sessionSequence: 1, stage: 'transport-ready' })
    /** @example expect(diagnostics.confirm('voice-consent-join')).toBe(false) */
    expect(diagnostics.confirm('voice-consent-join')).toBe(false)
    const snapshot = diagnostics.getSnapshot()
    /** @example expect(snapshot.firstFailedOrBlockedBoundary).toBe('voice-consent-join') */
    expect(snapshot.firstFailedOrBlockedBoundary).toBe('voice-consent-join')
    /** @example expect(snapshot.boundaries.find(boundary => boundary.id === 'voice-transport')?.evidence).toBe('waiting') */
    expect(snapshot.boundaries.find(boundary => boundary.id === 'voice-transport')?.evidence).toBe('waiting')
  })

  /** @example it('rolls retryable terminal turns back so only a higher production turn can complete', () => {}) */
  it('rolls retryable terminal turns back so only a higher production turn can complete', () => {
    const diagnostics = new StandaloneCapabilityDiagnostics({ randomToken: () => 'retry-turn' })
    const started = diagnostics.start({ artifact: { artifactKind: 'standalone-discord-bot', diagnosticsContractVersion: '1', productVersion: 'test', startedAt: '2026-07-19T00:00:00.000Z' }, botReady: true, configuration: { discordConfigured: true, providerConfigured: true }, dashboardApiHealthy: true })
    if (!started)
      throw new Error('Diagnostic start unexpectedly rejected.')
    diagnostics.recordTextAccepted(started.marker, 1)
    diagnostics.recordTextReplySent(1)
    diagnostics.confirm('text-reply-correct')
    diagnostics.recordVoice({ mode: 'qwen-realtime', runtimeSequence: 1, sessionSequence: 1, stage: 'session-started' })
    diagnostics.recordVoice({ runtimeSequence: 1, sessionSequence: 1, stage: 'transport-ready' })
    diagnostics.recordVoice({ runtimeSequence: 1, sessionSequence: 1, stage: 'provider-ready' })
    diagnostics.confirm('voice-consent-join')
    diagnostics.recordVoice({ runtimeSequence: 1, sessionSequence: 1, stage: 'speaking-started', turnSequence: 1 })
    diagnostics.recordVoice({ runtimeSequence: 1, sessionSequence: 1, stage: 'provider-input-cleared', turnSequence: 1 })
    diagnostics.recordVoice({ runtimeSequence: 1, sessionSequence: 1, stage: 'speaking-started', turnSequence: 1 })
    diagnostics.recordVoice({ runtimeSequence: 1, sessionSequence: 1, stage: 'provider-response-created', turnSequence: 1 })
    /** @example expect(diagnostics.getSnapshot().boundaries.find(boundary => boundary.id === 'voice-speaking')?.status).toBe('unproven') */
    expect(diagnostics.getSnapshot().boundaries.find(boundary => boundary.id === 'voice-speaking')?.status).toBe('unproven')
    diagnostics.recordVoice({ runtimeSequence: 1, sessionSequence: 1, stage: 'speaking-started', turnSequence: 2 })
    diagnostics.recordVoice({ opusBytes: 1, opusPackets: 1, pcmBytes: 1, pcmFrames: 1, runtimeSequence: 1, sessionSequence: 1, stage: 'receiver-audio', turnSequence: 2 })
    diagnostics.recordVoice({ runtimeSequence: 1, sessionSequence: 1, stage: 'local-input-admitted', turnSequence: 2 })
    diagnostics.recordVoice({ inputKind: 'user-audio', providerInputBytes: 1, providerInputChunks: 1, runtimeSequence: 1, sessionSequence: 1, stage: 'provider-input-appended', turnSequence: 2 })
    diagnostics.recordVoice({ aggregateTurnSequence: 2, captureTurnSequences: [2], runtimeSequence: 1, sessionSequence: 1, stage: 'provider-input-committed', turnSequence: 2 })
    diagnostics.recordVoice({ runtimeSequence: 1, sessionSequence: 1, stage: 'provider-vad', turnSequence: 2 })
    diagnostics.recordVoice({ runtimeSequence: 1, sessionSequence: 1, stage: 'provider-response-created', turnSequence: 2 })
    diagnostics.recordVoice({ responseAudioBytes: 1, responseAudioChunks: 1, runtimeSequence: 1, sessionSequence: 1, stage: 'provider-response-audio', turnSequence: 2 })
    diagnostics.recordVoice({ runtimeSequence: 1, sessionSequence: 1, stage: 'playback-started', turnSequence: 2 })
    diagnostics.recordVoice({ runtimeSequence: 1, sessionSequence: 1, stage: 'playback-completed', turnSequence: 2 })
    diagnostics.confirm('voice-heard')
    diagnostics.recordVoice({ cleanupReason: 'dismissed', runtimeSequence: 1, sessionSequence: 1, stage: 'session-cleaned' })
    /** @example expect(diagnostics.getSnapshot().lastSuccessfulBoundary).toBe('voice-cleanup') */
    expect(diagnostics.getSnapshot().lastSuccessfulBoundary).toBe('voice-cleanup')
  })

  /** @example it('admits only a strictly higher turn after every retryable terminal signal', () => {}) */
  it('admits only a strictly higher turn after every retryable terminal signal', () => {
    const retryableTerminalStages = ['provider-input-cleared', 'provider-response-cancelled', 'playback-aborted'] as const
    for (const stage of retryableTerminalStages) {
      const diagnostics = new StandaloneCapabilityDiagnostics({ randomToken: () => stage })
      const started = diagnostics.start({ artifact: { artifactKind: 'standalone-discord-bot', diagnosticsContractVersion: '1', productVersion: 'test', startedAt: '2026-07-19T00:00:00.000Z' }, botReady: true, configuration: { discordConfigured: true, providerConfigured: true }, dashboardApiHealthy: true })
      if (!started)
        throw new Error('Diagnostic start unexpectedly rejected.')
      diagnostics.recordTextAccepted(started.marker, 1)
      diagnostics.recordTextReplySent(1)
      diagnostics.confirm('text-reply-correct')
      diagnostics.recordVoice({ mode: 'qwen-realtime', runtimeSequence: 1, sessionSequence: 1, stage: 'session-started' })
      diagnostics.recordVoice({ runtimeSequence: 1, sessionSequence: 1, stage: 'transport-ready' })
      diagnostics.recordVoice({ runtimeSequence: 1, sessionSequence: 1, stage: 'provider-ready' })
      diagnostics.confirm('voice-consent-join')
      diagnostics.recordVoice({ runtimeSequence: 1, sessionSequence: 1, stage: 'speaking-started', turnSequence: 4 })
      diagnostics.recordVoice({ opusBytes: 1, opusPackets: 1, pcmBytes: 1, pcmFrames: 1, runtimeSequence: 1, sessionSequence: 1, stage: 'receiver-audio', turnSequence: 4 })
      diagnostics.recordVoice({ runtimeSequence: 1, sessionSequence: 1, stage: 'local-input-admitted', turnSequence: 4 })
      diagnostics.recordVoice({ inputKind: 'user-audio', providerInputBytes: 1, providerInputChunks: 1, runtimeSequence: 1, sessionSequence: 1, stage: 'provider-input-appended', turnSequence: 4 })
      if (stage !== 'provider-input-cleared') {
        diagnostics.recordVoice({ aggregateTurnSequence: 4, captureTurnSequences: [4], runtimeSequence: 1, sessionSequence: 1, stage: 'provider-input-committed', turnSequence: 4 })
        diagnostics.recordVoice({ runtimeSequence: 1, sessionSequence: 1, stage: 'provider-vad', turnSequence: 4 })
        diagnostics.recordVoice({ runtimeSequence: 1, sessionSequence: 1, stage: 'provider-response-created', turnSequence: 4 })
      }
      if (stage === 'playback-aborted') {
        diagnostics.recordVoice({ responseAudioBytes: 1, responseAudioChunks: 1, runtimeSequence: 1, sessionSequence: 1, stage: 'provider-response-audio', turnSequence: 4 })
        diagnostics.recordVoice({ runtimeSequence: 1, sessionSequence: 1, stage: 'playback-started', turnSequence: 4 })
      }
      diagnostics.recordVoice({ runtimeSequence: 1, sessionSequence: 1, stage, turnSequence: 4 })
      diagnostics.recordVoice({ runtimeSequence: 1, sessionSequence: 1, stage: 'speaking-started', turnSequence: 4 })
      diagnostics.recordVoice({ runtimeSequence: 1, sessionSequence: 1, stage: 'provider-response-created', turnSequence: 4 })
      // ROOT CAUSE:
      //
      // The prior regression stopped at speaking-started, so it could not prove
      // that a retry after each production terminal reaches heard and cleanup.
      // The complete higher turn below keeps the terminal-stage branch explicit.
      completeVoiceTurn(diagnostics, 5)
      diagnostics.confirm('voice-heard')
      diagnostics.recordVoice({ cleanupReason: 'dismissed', runtimeSequence: 1, sessionSequence: 1, stage: 'session-cleaned' })
      /** @example expect(diagnostics.getSnapshot().boundaries.find(boundary => boundary.id === 'voice-speaking')?.status).toBe('pass') */
      expect(diagnostics.getSnapshot().boundaries.find(boundary => boundary.id === 'voice-speaking')?.status).toBe('pass')
      /** @example expect(diagnostics.getSnapshot().phase).toBe('completed') */
      expect(diagnostics.getSnapshot().phase).toBe('completed')
    }
  })

  /** @example it('atomically terminalizes fatal bot failure until a new run starts', () => {}) */
  it('atomically terminalizes fatal bot failure until a new run starts', () => {
    const diagnostics = new StandaloneCapabilityDiagnostics({ randomToken: () => 'fatal' })
    const started = diagnostics.start({ artifact: { artifactKind: 'standalone-discord-bot', diagnosticsContractVersion: '1', productVersion: 'test', startedAt: '2026-07-19T00:00:00.000Z' }, botReady: true, configuration: { discordConfigured: true, providerConfigured: true }, dashboardApiHealthy: true })
    if (!started)
      throw new Error('Diagnostic start unexpectedly rejected.')
    diagnostics.recordBotFailure()
    diagnostics.recordBotReady()
    diagnostics.recordCommandsRegistered()
    diagnostics.recordTextAccepted(started.marker, 1)
    /** @example expect(diagnostics.matchesTextChallenge(started.marker)).toBe(false) */
    expect(diagnostics.matchesTextChallenge(started.marker)).toBe(false)
    /** @example expect(diagnostics.getSnapshot().boundaries.find(boundary => boundary.id === 'bot-ready')?.evidence).toBe('waiting') */
    expect(diagnostics.getSnapshot().boundaries.find(boundary => boundary.id === 'bot-ready')?.evidence).toBe('waiting')
    const restarted = diagnostics.start({ artifact: { artifactKind: 'standalone-discord-bot', diagnosticsContractVersion: '1', productVersion: 'test', startedAt: '2026-07-19T00:01:00.000Z' }, botReady: true, configuration: { discordConfigured: true, providerConfigured: true }, dashboardApiHealthy: true })
    /** @example expect(restarted).toEqual({ marker: 'airi-diagnostic-fatal' }) */
    expect(restarted).toEqual({ marker: 'airi-diagnostic-fatal' })
  })

  /** @example it('ignores a retired turn failure while a higher turn owns the session', () => {}) */
  it('ignores a retired turn failure while a higher turn owns the session', () => {
    const diagnostics = startVoiceDiagnosis('late-failure')
    diagnostics.recordVoice({ runtimeSequence: 1, sessionSequence: 1, stage: 'speaking-started', turnSequence: 1 })
    diagnostics.recordVoice({ runtimeSequence: 1, sessionSequence: 1, stage: 'provider-input-cleared', turnSequence: 1 })
    completeVoiceTurn(diagnostics, 2)
    diagnostics.recordVoice({ failureCategory: 'provider-error', runtimeSequence: 1, sessionSequence: 1, stage: 'failure', turnSequence: 1 })
    diagnostics.confirm('voice-heard')
    diagnostics.recordVoice({ cleanupReason: 'dismissed', runtimeSequence: 1, sessionSequence: 1, stage: 'session-cleaned' })
    const snapshot = diagnostics.getSnapshot()
    /** @example expect(snapshot.phase).toBe('completed') */
    expect(snapshot.phase).toBe('completed')
    /** @example expect(snapshot.lastSuccessfulBoundary).toBe('voice-cleanup') */
    expect(snapshot.lastSuccessfulBoundary).toBe('voice-cleanup')
  })

  /** @example it('fails instead of completing when cleanup reports a teardown failure', () => {}) */
  it('fails instead of completing when cleanup reports a teardown failure', () => {
    const diagnostics = startVoiceDiagnosis('failed-cleanup')
    completeVoiceTurn(diagnostics, 1)
    diagnostics.confirm('voice-heard')
    diagnostics.recordVoice({ cleanupReason: 'failed', runtimeSequence: 1, sessionSequence: 1, stage: 'session-cleaned' })
    const snapshot = diagnostics.getSnapshot()
    /** @example expect(snapshot.phase).toBe('running') */
    expect(snapshot.phase).toBe('running')
    /** @example expect(snapshot.firstFailedOrBlockedBoundary).toBe('voice-cleanup') */
    expect(snapshot.firstFailedOrBlockedBoundary).toBe('voice-cleanup')
  })

  /** @example it('keeps a current turn failure and a session-level fatal failure authoritative', () => {}) */
  it('keeps a current turn failure and a session-level fatal failure authoritative', () => {
    const turnFailure = startVoiceDiagnosis('current-failure')
    completeVoiceTurn(turnFailure, 1)
    turnFailure.recordVoice({ failureCategory: 'provider-error', runtimeSequence: 1, sessionSequence: 1, stage: 'failure', turnSequence: 1 })
    completeVoiceTurn(turnFailure, 2)
    const turnSnapshot = turnFailure.getSnapshot()
    /** @example expect(turnSnapshot.firstFailedOrBlockedBoundary).toBe('voice-heard') */
    expect(turnSnapshot.firstFailedOrBlockedBoundary).toBe('voice-heard')

    const sessionFailure = startVoiceDiagnosis('session-failure')
    sessionFailure.recordVoice({ failureCategory: 'connection-error', runtimeSequence: 1, sessionSequence: 1, stage: 'failure' })
    const sessionSnapshot = sessionFailure.getSnapshot()
    /** @example expect(sessionSnapshot.firstFailedOrBlockedBoundary).toBe('voice-speaking') */
    expect(sessionSnapshot.firstFailedOrBlockedBoundary).toBe('voice-speaking')
  })
})
