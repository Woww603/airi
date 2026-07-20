import { describe, expect, it } from 'vitest'

import { StandaloneVoiceDiagnostics } from './voiceDiagnostics'

/** Narrows the frozen public snapshot identity without reaching into diagnostics internals. */
function hasSourceSessionIdentity(value: object): value is { readonly runtimeSequence: number, readonly sessionSequence: number } {
  return 'runtimeSequence' in value
    && typeof value.runtimeSequence === 'number'
    && 'sessionSequence' in value
    && typeof value.sessionSequence === 'number'
}

/** Narrows mandatory provider aggregate ownership from a public turn snapshot. */
function hasAggregateOwnership(value: object): value is { readonly aggregateTurnSequence: number, readonly captureTurnSequences: readonly number[] } {
  return 'aggregateTurnSequence' in value
    && typeof value.aggregateTurnSequence === 'number'
    && 'captureTurnSequences' in value
    && Array.isArray(value.captureTurnSequences)
}

/**
 * @example
 * describe('standalone voice diagnostics', () => {})
 */
describe('standalone voice diagnostics', () => {
  /**
   * @example
   * it('bounds active sessions and projects only anonymous capacity telemetry', () => {})
   */
  it('bounds active sessions and projects only anonymous capacity telemetry', () => {
    const diagnostics = new StandaloneVoiceDiagnostics()
    const sensitiveSourceKey = 'private-session https://synthetic.invalid/?token=secret body=private-body'

    for (let sequence = 1; sequence <= 17; sequence += 1) {
      diagnostics.record({
        mode: 'qwen-realtime',
        runtimeSequence: sequence,
        sessionSequence: sequence,
        stage: 'session-started',
      })
    }

    const snapshot = diagnostics.getSnapshot()
    expect(snapshot.active).toHaveLength(16)
    expect(snapshot.active.map(session => session.sessionSequence)).toEqual([
      16,
      15,
      14,
      13,
      12,
      11,
      10,
      9,
      8,
      7,
      6,
      5,
      4,
      3,
      2,
      1,
    ])
    expect(snapshot.saturatedSessions).toBe(1)
    expect(JSON.stringify(snapshot)).not.toContain(sensitiveSourceKey)
  })

  /**
   * @example
   * it('keeps only the newest completed sessions in anonymous order', () => {})
   */
  it('keeps only the newest completed sessions in anonymous order', () => {
    const diagnostics = new StandaloneVoiceDiagnostics()

    for (let sequence = 1; sequence <= 25; sequence += 1) {
      diagnostics.record({ mode: 'classic', runtimeSequence: sequence, sessionSequence: sequence, stage: 'session-started' })
      diagnostics.record({ cleanupReason: 'stopped', runtimeSequence: sequence, sessionSequence: sequence, stage: 'session-cleaned' })
    }

    const snapshot = diagnostics.getSnapshot()
    expect(snapshot.completed).toHaveLength(24)
    expect(snapshot.completed.map(session => session.sessionSequence)).toEqual([
      25,
      24,
      23,
      22,
      21,
      20,
      19,
      18,
      17,
      16,
      15,
      14,
      13,
      12,
      11,
      10,
      9,
      8,
      7,
      6,
      5,
      4,
      3,
      2,
    ])
    expect(JSON.stringify(snapshot)).not.toContain('synthetic.invalid')
    expect(JSON.stringify(snapshot)).not.toContain('private-body')
  })

  /**
   * @example
   * it('attributes actual provider sends by input kind', () => {})
   */
  it('attributes actual provider sends by input kind for Discord audit P3', () => {
    // ROOT CAUSE:
    //
    // VoiceManager used to count only user-audio chunks before calling the
    // provider. Qwen's trailing-silence sends happened inside the runtime and
    // therefore never appeared in the provider-input projection.
    //
    // Before this patch, the projection had only one undifferentiated input
    // counter and could not represent successful synthetic-silence sends.
    //
    // We fixed this by recording successful socket sends at the Qwen boundary,
    // retaining separate user-audio and synthetic-silence cumulative counters.
    const diagnostics = new StandaloneVoiceDiagnostics()

    diagnostics.record({ mode: 'qwen-realtime', runtimeSequence: 1, sessionSequence: 1, stage: 'session-started' })
    diagnostics.record({ inputKind: 'user-audio', providerInputBytes: 320, providerInputChunks: 2, runtimeSequence: 1, sessionSequence: 1, stage: 'provider-input-appended', turnSequence: 1 })
    diagnostics.record({ inputKind: 'synthetic-silence', providerInputBytes: 960, providerInputChunks: 6, runtimeSequence: 1, sessionSequence: 1, stage: 'provider-input-appended', turnSequence: 1 })

    const turn = diagnostics.getSnapshot().active[0].turns[0]

    expect(turn.userInputAppends).toBe(2)
    expect(turn.userInputBytes).toBe(320)
    expect(turn.syntheticInputAppends).toBe(6)
    expect(turn.syntheticInputBytes).toBe(960)
    expect(turn.inputAppends).toBe(8)
    expect(turn.inputBytes).toBe(1280)
  })

  /**
   * @example
   * it('projects only fixed anonymous local admission outcomes', () => {})
   */
  it('projects only fixed anonymous local admission outcomes', () => {
    const diagnostics = new StandaloneVoiceDiagnostics()
    diagnostics.record({ mode: 'qwen-realtime', runtimeSequence: 1, sessionSequence: 1, stage: 'session-started' })
    diagnostics.record({ runtimeSequence: 1, sessionSequence: 1, stage: 'local-input-rejected:insufficient-duration', turnSequence: 1 })

    const rejected = diagnostics.getSnapshot().active[0].turns[0]
    expect('localAdmissionStatus' in rejected).toBe(true)
    expect(JSON.stringify(rejected)).not.toContain('rms')
    expect(JSON.stringify(rejected)).not.toContain('audio')

    diagnostics.record({ runtimeSequence: 1, sessionSequence: 1, stage: 'local-input-admitted', turnSequence: 1 })

    expect(diagnostics.getSnapshot().active[0].turns[0]).toMatchObject({ localAdmissionStatus: 'admitted' })
  })

  /** @example it('projects an admitted capacity rejection without inventing provider ownership', () => {}) */
  it('projects an admitted capacity rejection without inventing provider ownership', () => {
    // ROOT CAUSE:
    //
    // Local admission is produced by Pcm16InputSafetyGate before the provider
    // accepts ownership. A capacity rejection after admission must not erase
    // that local fact or invent provider input that was never sent.
    //
    // The typed diagnostic boundary owns the fixed capacity category. Its
    // bounded snapshot must keep that failure on the admitted capture without
    // treating a zero provider-input count as contradictory evidence.
    const diagnostics = new StandaloneVoiceDiagnostics()
    diagnostics.record({ mode: 'qwen-realtime', runtimeSequence: 65, sessionSequence: 65, stage: 'session-started' })
    diagnostics.record({ runtimeSequence: 65, sessionSequence: 65, stage: 'local-input-admitted', turnSequence: 65 })
    diagnostics.record({ failureCategory: 'provider-input-capacity', runtimeSequence: 65, sessionSequence: 65, stage: 'failure', turnSequence: 65 })
    diagnostics.record({ cleanupReason: 'failed', runtimeSequence: 65, sessionSequence: 65, stage: 'session-cleaned' })

    const completed = diagnostics.getSnapshot().completed
    expect(completed).toHaveLength(1)
    expect(completed[0]).toMatchObject({
      completionReason: 'failed',
      failureCategories: ['provider-input-capacity'],
      runtimeSequence: 65,
      sessionSequence: 65,
    })
    const [turn] = completed[0].turns
    if (!turn)
      throw new Error('The completed capacity-style failure must preserve its admitted turn.')
    expect(turn.localAdmissionStatus).toBe('admitted')
    expect(turn.inputAppends).toBe(0)
    expect(turn.inputBytes).toBe(0)
    expect(turn.inputCommits).toBe(0)
    expect(turn.failureCategory).toBe('provider-input-capacity')
  })

  /** @example it('keeps every terminal admission outcome on its owning turn and runtime generation exactly once', () => {}) */
  it('keeps every terminal admission outcome on its owning turn and runtime generation exactly once', () => {
    const diagnostics = new StandaloneVoiceDiagnostics()
    diagnostics.record({ mode: 'qwen-realtime', runtimeSequence: 1, sessionSequence: 1, stage: 'session-started' })
    diagnostics.record({ runtimeSequence: 1, sessionSequence: 1, stage: 'local-input-rejected:no-samples', turnSequence: 1 })
    diagnostics.record({ runtimeSequence: 1, sessionSequence: 1, stage: 'local-input-rejected:below-threshold', turnSequence: 2 })
    diagnostics.record({ runtimeSequence: 1, sessionSequence: 1, stage: 'local-input-rejected:insufficient-duration', turnSequence: 3 })
    diagnostics.record({ runtimeSequence: 1, sessionSequence: 1, stage: 'local-input-rejected:incomplete-sample', turnSequence: 4 })
    diagnostics.record({ runtimeSequence: 1, sessionSequence: 1, stage: 'local-input-admitted', turnSequence: 5 })
    diagnostics.record({ mode: 'qwen-realtime', runtimeSequence: 2, sessionSequence: 1, stage: 'session-started' })
    diagnostics.record({ runtimeSequence: 2, sessionSequence: 1, stage: 'local-input-admitted', turnSequence: 1 })

    const active = diagnostics.getSnapshot().active
    expect(active).toHaveLength(2)
    expect(active[1].turns.map(turn => 'localAdmissionStatus' in turn ? turn.localAdmissionStatus : undefined)).toEqual([
      'admitted',
      'rejected:incomplete-sample',
      'rejected:insufficient-duration',
      'rejected:below-threshold',
      'rejected:no-samples',
    ])
    expect(active[0].turns.map(turn => 'localAdmissionStatus' in turn ? turn.localAdmissionStatus : undefined)).toEqual(['admitted'])
  })

  /** @example it('retains mandatory bounded aggregate ownership on committed provider input', () => {}) */
  it('retains mandatory bounded aggregate ownership on committed provider input', () => {
    const diagnostics = new StandaloneVoiceDiagnostics()
    diagnostics.record({ mode: 'qwen-realtime', runtimeSequence: 7, sessionSequence: 3, stage: 'session-started' })
    diagnostics.record({
      aggregateTurnSequence: 4,
      captureTurnSequences: [4, 5, 4, 3],
      runtimeSequence: 7,
      sessionSequence: 3,
      stage: 'provider-input-committed',
      turnSequence: 4,
    })

    // ROOT CAUSE:
    //
    // A provider commit describes one aggregate, not merely a counter. The
    // bounded standalone snapshot must preserve its owner and contributing
    // captures with the runtime/session identity that scopes the event.
    expect(diagnostics.getSnapshot().active[0].turns[0]).toMatchObject({
      aggregateTurnSequence: 4,
      captureTurnSequences: [4, 5],
      inputCommits: 1,
      turnSequence: 4,
    })
  })

  /** @example it('preserves source session identity and ordered aggregate contributors', () => {}) */
  it('preserves source session identity and ordered aggregate contributors', () => {
    const diagnostics = new StandaloneVoiceDiagnostics()
    const captureTurnSequences = [17, 19, 19, 18, 20, 22, 21, 23]
    diagnostics.record({ mode: 'qwen-realtime', runtimeSequence: 73, sessionSequence: 41, stage: 'session-started' })
    const droppedSignalsBefore = diagnostics.getSnapshot().droppedSignals
    diagnostics.record({
      aggregateTurnSequence: 17,
      captureTurnSequences,
      runtimeSequence: 73,
      sessionSequence: 41,
      stage: 'provider-input-committed',
      turnSequence: 17,
    })

    // ROOT CAUSE:
    //
    // The standalone projection grouped events by source identity, then
    // discarded that identity and exposed a process-local counter instead.
    // Dashboard consumers could no longer correlate a committed aggregate to
    // its runtime/session owner. A malformed callback could also expose raw
    // duplicate or descending contributor sequences, making capture ownership
    // non-monotonic and unbounded at the public projection boundary.
    const [session] = diagnostics.getSnapshot().active
    if (!session)
      throw new Error('The committed provider input must retain an active session snapshot.')
    expect(hasSourceSessionIdentity(session)).toBe(true)
    if (!hasSourceSessionIdentity(session))
      return
    expect(session.runtimeSequence).toBe(73)
    expect(session.sessionSequence).toBe(41)

    const [turn] = session.turns
    if (!turn)
      throw new Error('The committed provider input must retain its owning turn snapshot.')
    expect(hasAggregateOwnership(turn)).toBe(true)
    if (!hasAggregateOwnership(turn))
      return
    expect(turn.aggregateTurnSequence).toBe(17)
    expect(turn.captureTurnSequences).toEqual([17, 19, 20, 22, 23])
    expect(diagnostics.getSnapshot().droppedSignals).toBe(droppedSignalsBefore + 1)
  })

  /** @example it('detaches completed aggregate contributors from a previously returned snapshot', () => {}) */
  it('detaches completed aggregate contributors from a previously returned snapshot', () => {
    const diagnostics = new StandaloneVoiceDiagnostics()
    diagnostics.record({ mode: 'qwen-realtime', runtimeSequence: 81, sessionSequence: 82, stage: 'session-started' })
    diagnostics.record({
      aggregateTurnSequence: 7,
      captureTurnSequences: [7, 8],
      runtimeSequence: 81,
      sessionSequence: 82,
      stage: 'provider-input-committed',
      turnSequence: 7,
    })
    diagnostics.record({ cleanupReason: 'stopped', runtimeSequence: 81, sessionSequence: 82, stage: 'session-cleaned' })
    const first = diagnostics.getSnapshot().completed[0]?.turns[0]
    if (!first || !hasAggregateOwnership(first))
      throw new Error('The completed provider aggregate must retain its public ownership snapshot.')
    first.captureTurnSequences.push(9_999)

    // ROOT CAUSE:
    //
    // Completed sessions retained the mutable aggregate array returned to an
    // earlier Dashboard consumer. A consumer mutation then corrupted history.
    const second = diagnostics.getSnapshot().completed[0]?.turns[0]
    if (!second || !hasAggregateOwnership(second))
      throw new Error('A later completed snapshot must retain aggregate ownership.')
    expect(second.captureTurnSequences).toEqual([7, 8])
    expect(second.captureTurnSequences).not.toBe(first.captureTurnSequences)
  })

  /** @example it('exposes only typed aggregate ownership recording without an untrusted ingest seam', () => {}) */
  it('exposes only typed aggregate ownership recording without an untrusted ingest seam', () => {
    const diagnostics = new StandaloneVoiceDiagnostics()
    diagnostics.record({ mode: 'qwen-realtime', runtimeSequence: 91, sessionSequence: 92, stage: 'session-started' })

    // ROOT CAUSE:
    //
    // Production only routes typed VoiceDiagnosticSignal values through
    // DashboardState.recordVoiceDiagnostic. The unknown ingest method had no
    // production caller, so malformed-object tests created a duplicate schema
    // and a fictional provider trust boundary instead of exercising wiring.
    //
    // Diagnostics must expose the typed record/finalize/snapshot surface and
    // retain committed aggregate ownership through that real public boundary.
    expect('record' in diagnostics).toBe(true)
    expect('finalizeAllActive' in diagnostics).toBe(true)
    expect('getSnapshot' in diagnostics).toBe(true)
    expect('ingest' in diagnostics).toBe(false)

    diagnostics.record({
      aggregateTurnSequence: 1,
      captureTurnSequences: [1, 2],
      runtimeSequence: 91,
      sessionSequence: 92,
      stage: 'provider-input-committed',
      turnSequence: 1,
    })

    const [turn] = diagnostics.getSnapshot().active[0]?.turns ?? []
    if (!turn)
      throw new Error('Typed committed input must retain its aggregate ownership snapshot.')
    expect(turn).toMatchObject({
      aggregateTurnSequence: 1,
      captureTurnSequences: [1, 2],
      inputCommits: 1,
      turnSequence: 1,
    })
  })

  /** @example it('detaches aggregate contributor snapshots from subsequent Dashboard reads', () => {}) */
  it('detaches aggregate contributor snapshots from subsequent Dashboard reads', () => {
    const diagnostics = new StandaloneVoiceDiagnostics()
    diagnostics.record({ mode: 'qwen-realtime', runtimeSequence: 31, sessionSequence: 47, stage: 'session-started' })
    diagnostics.record({
      aggregateTurnSequence: 7,
      captureTurnSequences: [7, 8, 9],
      runtimeSequence: 31,
      sessionSequence: 47,
      stage: 'provider-input-committed',
      turnSequence: 7,
    })

    const first = diagnostics.getSnapshot().active[0]?.turns[0]
    if (!first || !hasAggregateOwnership(first))
      throw new Error('Committed provider input must expose aggregate ownership in the public snapshot.')
    first.captureTurnSequences.push(10_000)

    // ROOT CAUSE:
    //
    // Dashboard snapshots used the mutable turn's contributor array directly.
    // A consumer could therefore mutate a prior snapshot and corrupt later
    // snapshots and the retained aggregate ownership without emitting a signal.
    //
    // Snapshot projection must copy this bounded array at the public boundary.
    const second = diagnostics.getSnapshot().active[0]?.turns[0]
    if (!second || !hasAggregateOwnership(second))
      throw new Error('A later snapshot must retain the committed aggregate ownership.')
    expect(second.captureTurnSequences).toEqual([7, 8, 9])
    expect(second.captureTurnSequences).not.toBe(first.captureTurnSequences)
  })

  /**
   * @example
   * it('bounds turns and rejects late evicted signals', () => {})
   */
  it('bounds sixteen turns and rejects late evicted signals', () => {
    const diagnostics = new StandaloneVoiceDiagnostics()
    diagnostics.record({ mode: 'qwen-realtime', runtimeSequence: 1, sessionSequence: 1, stage: 'session-started' })

    for (let turnSequence = 1; turnSequence <= 17; turnSequence += 1) {
      diagnostics.record({
        opusBytes: turnSequence,
        opusPackets: 1,
        pcmBytes: turnSequence,
        pcmFrames: 1,
        runtimeSequence: 1,
        sessionSequence: 1,
        stage: 'receiver-audio',
        turnSequence,
      })
    }
    diagnostics.record({
      opusBytes: 65_535,
      opusPackets: 65_535,
      pcmBytes: 65_535,
      pcmFrames: 65_535,
      runtimeSequence: 1,
      sessionSequence: 1,
      stage: 'receiver-audio',
      turnSequence: 1,
    })
    diagnostics.record({ inputKind: 'user-audio', providerInputBytes: 100_000, providerInputChunks: 100_000, runtimeSequence: 1, sessionSequence: 1, stage: 'provider-input-appended', turnSequence: 17 })
    diagnostics.record({ inputKind: 'synthetic-silence', providerInputBytes: 100_000, providerInputChunks: 100_000, runtimeSequence: 1, sessionSequence: 1, stage: 'provider-input-appended', turnSequence: 17 })
    diagnostics.record({ responseAudioBytes: 100_000, responseAudioChunks: 100_000, runtimeSequence: 1, sessionSequence: 1, stage: 'provider-response-audio', turnSequence: 17 })

    const snapshot = diagnostics.getSnapshot()

    expect(snapshot.active[0].turns).toHaveLength(16)
    expect(snapshot.active[0].turns.map(turn => turn.turnSequence)).toEqual([
      17,
      16,
      15,
      14,
      13,
      12,
      11,
      10,
      9,
      8,
      7,
      6,
      5,
      4,
      3,
      2,
    ])
    expect(snapshot.droppedSignals).toBe(2)
    expect(snapshot.active[0].turns[0]).toMatchObject({
      inputAppends: 65_535,
      inputBytes: 65_535,
      responseAudioBytes: 65_535,
      responseAudioChunks: 65_535,
      syntheticInputAppends: 65_535,
      syntheticInputBytes: 65_535,
      userInputAppends: 65_535,
      userInputBytes: 65_535,
    })
  })

  /**
   * @example
   * it('saturates diagnostic rejection counts', () => {})
   */
  it('saturates diagnostic rejection counts at the documented maximum', () => {
    const diagnostics = new StandaloneVoiceDiagnostics()

    for (let index = 0; index < 65_540; index += 1)
      diagnostics.record({ runtimeSequence: 0, sessionSequence: 0, stage: 'transport-ready' })

    expect(diagnostics.getSnapshot().droppedSignals).toBe(65_535)
  })
})
