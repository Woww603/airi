import type {
  VoiceDiagnosticCleanupReason,
  VoiceDiagnosticFailureCategory,
  VoiceDiagnosticPlayerState,
  VoiceDiagnosticSignal,
} from '../bots/discord/commands/voiceDiagnostics'

/** Session-level stage exposed by the local Dashboard. */
export type StandaloneVoiceDiagnosticStage
  = | 'buffering'
    | 'completed'
    | 'failed'
    | 'playing'
    | 'provider-processing'
    | 'provider-ready'
    | 'receiving'
    | 'responding'
    | 'started'
    | 'transport-ready'

/** Content-free result derived from observed voice lifecycle stages. */
export type StandaloneVoiceDiagnosticOutcome
  = | 'no-input'
    | 'player-failure'
    | 'provider-no-response'
    | 'response-audio'

/** Fixed local PCM gate result; deliberately excludes audio measurements and identity. */
export type StandaloneVoiceDiagnosticLocalAdmissionStatus
  = | 'admitted'
    | 'rejected:below-threshold'
    | 'rejected:incomplete-sample'
    | 'rejected:insufficient-duration'
    | 'rejected:no-samples'

/** Bounded per-turn projection. It deliberately contains no source identifiers or content. */
export interface StandaloneVoiceDiagnosticTurnSnapshot {
  /** Anonymous turn sequence assigned by the live voice owner. */
  turnSequence: number
  /** Aggregate owner for a committed provider input, when this turn owns one. */
  aggregateTurnSequence?: number
  /** Bounded capture turns that contributed to the committed provider aggregate. */
  captureTurnSequences?: number[]
  /** Latest fixed local PCM gate result, if the gate evaluated this turn. */
  localAdmissionStatus?: StandaloneVoiceDiagnosticLocalAdmissionStatus
  /** Whether Discord delivered any non-empty Opus or decoded PCM data. */
  receiverAudioObserved: boolean
  /** Saturated cumulative Discord Opus packet count. */
  opusPackets: number
  /** Saturated cumulative Discord Opus byte count. */
  opusBytes: number
  /** Saturated cumulative decoded PCM frame count. */
  pcmFrames: number
  /** Saturated cumulative decoded PCM byte count. */
  pcmBytes: number
  /** Saturated cumulative provider input chunks accepted. */
  inputAppends: number
  /** Saturated cumulative provider input bytes accepted. */
  inputBytes: number
  /** Saturated cumulative successful user-audio socket sends. */
  userInputAppends: number
  /** Saturated cumulative successful user-audio socket bytes. */
  userInputBytes: number
  /** Saturated cumulative successful synthetic-silence socket sends. */
  syntheticInputAppends: number
  /** Saturated cumulative successful synthetic-silence socket bytes. */
  syntheticInputBytes: number
  /** Number of observed input commits. */
  inputCommits: number
  /** Number of observed server-VAD turns. */
  providerVadTurns: number
  /** Number of provider responses created. */
  responsesStarted: number
  /** Saturated cumulative response-audio chunk count. */
  responseAudioChunks: number
  /** Saturated cumulative response-audio byte count. */
  responseAudioBytes: number
  /** Number of provider responses completed. */
  responsesCompleted: number
  /** Number of provider responses cancelled. */
  responsesCancelled: number
  /** Latest allowlisted Discord audio-player state. */
  playerState?: VoiceDiagnosticPlayerState
  /** Number of Discord sender/playback starts. */
  playbackStarted: number
  /** Number of Discord sender/playback completions. */
  playbackCompleted: number
  /** Number of Discord sender/playback aborts. */
  playbackAborted: number
  /** Latest fixed failure category, never an Error or provider-controlled string. */
  failureCategory?: VoiceDiagnosticFailureCategory
  /** Derived diagnostic result for this turn. */
  outcome: StandaloneVoiceDiagnosticOutcome
}

/** Bounded session projection shown by the local Dashboard. */
export interface StandaloneVoiceDiagnosticSessionSnapshot {
  /** Anonymous runtime sequence that scopes this source session. */
  runtimeSequence: number
  /** Anonymous source session sequence that scopes this source session. */
  sessionSequence: number
  /** Provider mode needed to interpret the observed stages. */
  mode: 'classic' | 'qwen-realtime'
  /** Latest allowlisted lifecycle stage. */
  stage: StandaloneVoiceDiagnosticStage
  /** Whether the Discord voice transport reached ready. */
  transportReady: boolean
  /** Whether the configured voice provider reached ready. */
  providerReady: boolean
  /** Whether Discord currently reports an admitted speaker as active. */
  speaking: boolean
  /** Number of speaking-start transitions. */
  speakingStarts: number
  /** Number of speaking-end transitions. */
  speakingEnds: number
  /** Most recent bounded turns, newest first. */
  turns: StandaloneVoiceDiagnosticTurnSnapshot[]
  /** Derived result across all retained turns. */
  outcome: StandaloneVoiceDiagnosticOutcome
  /** Fixed cleanup classification once the session is completed. */
  completionReason?: VoiceDiagnosticCleanupReason
  /** Unique fixed failure categories observed by this session. */
  failureCategories: VoiceDiagnosticFailureCategory[]
}

/** Immutable local-only voice diagnostics projection. */
export interface StandaloneVoiceDiagnosticsSnapshot {
  /** Active sessions, newest first, with a hard maximum of 16. */
  active: StandaloneVoiceDiagnosticSessionSnapshot[]
  /** Recently completed sessions, newest first, with a hard maximum of 24. */
  completed: StandaloneVoiceDiagnosticSessionSnapshot[]
  /** Saturated count of session starts rejected by the active-session hard cap. */
  saturatedSessions: number
  /** Saturated count of stale, invalid, or capacity-rejected signals. */
  droppedSignals: number
}

interface MutableTurnDiagnostics {
  aggregateTurnSequence?: number
  captureTurnSequences?: number[]
  failureCategory?: VoiceDiagnosticFailureCategory
  inputAppends: number
  inputBytes: number
  inputCommits: number
  localAdmissionStatus?: StandaloneVoiceDiagnosticLocalAdmissionStatus
  opusBytes: number
  opusPackets: number
  pcmBytes: number
  pcmFrames: number
  playbackAborted: number
  playbackCompleted: number
  playbackStarted: number
  playerState?: VoiceDiagnosticPlayerState
  providerVadTurns: number
  receiverAudioObserved: boolean
  responseAudioBytes: number
  responseAudioChunks: number
  responsesCancelled: number
  responsesCompleted: number
  responsesStarted: number
  syntheticInputAppends: number
  syntheticInputBytes: number
  turnSequence: number
  userInputAppends: number
  userInputBytes: number
}

interface MutableSessionDiagnostics {
  failureCategories: VoiceDiagnosticFailureCategory[]
  mode: 'classic' | 'qwen-realtime'
  providerReady: boolean
  runtimeSequence: number
  sessionSequence: number
  sourceKey: string
  speaking: boolean
  speakingEnds: number
  speakingStarts: number
  stage: StandaloneVoiceDiagnosticStage
  transportReady: boolean
  highestTurnSequence: number
  turnOrder: number[]
  turns: Map<number, MutableTurnDiagnostics>
}

/** Concurrent calls are bounded well above the intended single-digit live voice channel count. */
const MAX_ACTIVE_VOICE_DIAGNOSTIC_SESSIONS = 16
/** Completed sessions are a short troubleshooting ring, not process-lifetime history. */
const MAX_COMPLETED_VOICE_DIAGNOSTIC_SESSIONS = 24
/** A live session retains only its latest turns; cumulative process history belongs in metrics. */
const MAX_TURNS_PER_VOICE_DIAGNOSTIC_SESSION = 16
/** Prevents attacker-controlled cumulative counters from producing unbounded numeric projections. */
const MAX_VOICE_DIAGNOSTIC_COUNT = 65_535
/** Provider aggregate ownership is diagnostic metadata, not unbounded capture history. */
const MAX_PROVIDER_CAPTURE_TURN_SEQUENCES = 32

function saturatedCount(value: number | undefined): number {
  if (!Number.isFinite(value) || value === undefined || value <= 0)
    return 0

  return Math.min(MAX_VOICE_DIAGNOSTIC_COUNT, Math.trunc(value))
}

function incrementSaturated(value: number): number {
  return Math.min(MAX_VOICE_DIAGNOSTIC_COUNT, value + 1)
}

function validSequence(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function sourceKeyFor(signal: VoiceDiagnosticSignal): string | undefined {
  if (!validSequence(signal.runtimeSequence) || !validSequence(signal.sessionSequence))
    return undefined

  return `${signal.runtimeSequence}:${signal.sessionSequence}`
}

function createTurn(turnSequence: number): MutableTurnDiagnostics {
  return {
    inputAppends: 0,
    inputBytes: 0,
    inputCommits: 0,
    opusBytes: 0,
    opusPackets: 0,
    pcmBytes: 0,
    pcmFrames: 0,
    playbackAborted: 0,
    playbackCompleted: 0,
    playbackStarted: 0,
    providerVadTurns: 0,
    receiverAudioObserved: false,
    responseAudioBytes: 0,
    responseAudioChunks: 0,
    responsesCancelled: 0,
    responsesCompleted: 0,
    responsesStarted: 0,
    syntheticInputAppends: 0,
    syntheticInputBytes: 0,
    turnSequence,
    userInputAppends: 0,
    userInputBytes: 0,
  }
}

function turnOutcome(turn: MutableTurnDiagnostics): StandaloneVoiceDiagnosticOutcome {
  if (turn.failureCategory === 'playback-error' || turn.playerState === 'error')
    return 'player-failure'
  if (turn.responseAudioChunks > 0 || turn.responseAudioBytes > 0)
    return 'response-audio'
  if (turn.receiverAudioObserved || turn.inputAppends > 0 || turn.inputBytes > 0 || turn.inputCommits > 0)
    return 'provider-no-response'
  return 'no-input'
}

function turnSnapshot(turn: MutableTurnDiagnostics): StandaloneVoiceDiagnosticTurnSnapshot {
  const inputAppends = Math.min(
    MAX_VOICE_DIAGNOSTIC_COUNT,
    turn.userInputAppends + turn.syntheticInputAppends,
  )
  const inputBytes = Math.min(
    MAX_VOICE_DIAGNOSTIC_COUNT,
    turn.userInputBytes + turn.syntheticInputBytes,
  )
  return {
    aggregateTurnSequence: turn.aggregateTurnSequence,
    captureTurnSequences: turn.captureTurnSequences ? [...turn.captureTurnSequences] : undefined,
    failureCategory: turn.failureCategory,
    inputAppends,
    inputBytes,
    inputCommits: turn.inputCommits,
    localAdmissionStatus: turn.localAdmissionStatus,
    opusBytes: turn.opusBytes,
    opusPackets: turn.opusPackets,
    outcome: turnOutcome(turn),
    pcmBytes: turn.pcmBytes,
    pcmFrames: turn.pcmFrames,
    playbackAborted: turn.playbackAborted,
    playbackCompleted: turn.playbackCompleted,
    playbackStarted: turn.playbackStarted,
    playerState: turn.playerState,
    providerVadTurns: turn.providerVadTurns,
    receiverAudioObserved: turn.receiverAudioObserved,
    responseAudioBytes: turn.responseAudioBytes,
    responseAudioChunks: turn.responseAudioChunks,
    responsesCancelled: turn.responsesCancelled,
    responsesCompleted: turn.responsesCompleted,
    responsesStarted: turn.responsesStarted,
    syntheticInputAppends: turn.syntheticInputAppends,
    syntheticInputBytes: turn.syntheticInputBytes,
    turnSequence: turn.turnSequence,
    userInputAppends: turn.userInputAppends,
    userInputBytes: turn.userInputBytes,
  }
}

function sessionOutcome(session: MutableSessionDiagnostics): StandaloneVoiceDiagnosticOutcome {
  const outcomes = session.turnOrder.map(turnSequence => turnOutcome(session.turns.get(turnSequence)!))
  if (outcomes.includes('player-failure'))
    return 'player-failure'
  if (outcomes.includes('response-audio'))
    return 'response-audio'
  if (outcomes.includes('provider-no-response'))
    return 'provider-no-response'
  return 'no-input'
}

function sessionSnapshot(
  session: MutableSessionDiagnostics,
  completionReason?: VoiceDiagnosticCleanupReason,
): StandaloneVoiceDiagnosticSessionSnapshot {
  return {
    completionReason,
    failureCategories: [...session.failureCategories],
    mode: session.mode,
    outcome: sessionOutcome(session),
    providerReady: session.providerReady,
    runtimeSequence: session.runtimeSequence,
    sessionSequence: session.sessionSequence,
    speaking: session.speaking,
    speakingEnds: session.speakingEnds,
    speakingStarts: session.speakingStarts,
    stage: completionReason === 'failed' || session.stage === 'failed' ? 'failed' : completionReason ? 'completed' : session.stage,
    transportReady: session.transportReady,
    turns: session.turnOrder.toReversed().map(turnSequence => turnSnapshot(session.turns.get(turnSequence)!)),
  }
}

/**
 * Owns the bounded, content-free projection of live Discord voice diagnostics.
 *
 * Use when:
 * - Production voice handlers emit allowlisted {@link VoiceDiagnosticSignal} transitions.
 * - The local Dashboard needs enough evidence to distinguish receive, provider, and playback failures.
 *
 * Expects:
 * - Runtime/session/turn sequences are anonymous positive integers scoped to this process.
 * - Signals never contain Discord identifiers, content, provider events, URLs, or Error objects.
 *
 * Returns:
 * - Deeply detached snapshots with hard-bounded sessions, turns, and counters.
 */
export class StandaloneVoiceDiagnostics {
  private readonly active = new Map<string, MutableSessionDiagnostics>()
  private readonly completed: StandaloneVoiceDiagnosticSessionSnapshot[] = []
  private droppedSignals = 0
  private saturatedSessions = 0

  /** Records one allowlisted production lifecycle transition. */
  record(signal: VoiceDiagnosticSignal): void {
    const sourceKey = sourceKeyFor(signal)
    if (sourceKey === undefined) {
      this.recordDroppedSignal()
      return
    }

    if (signal.stage === 'session-started') {
      this.startSession(sourceKey, signal)
      return
    }

    const session = this.active.get(sourceKey)
    if (session === undefined) {
      this.recordDroppedSignal()
      return
    }

    if (signal.stage === 'session-cleaned') {
      this.finalizeSession(session, signal.cleanupReason)
      return
    }

    this.recordSessionSignal(session, signal)
  }

  /** Finalizes every active projection during stop, replacement, or forced cleanup. */
  finalizeAllActive(reason: VoiceDiagnosticCleanupReason): void {
    for (const session of this.active.values())
      this.finalizeSession(session, reason)
  }

  /** Returns a deeply detached, hard-bounded Dashboard projection. */
  getSnapshot(): StandaloneVoiceDiagnosticsSnapshot {
    return {
      active: [...this.active.values()].toReversed().map(session => sessionSnapshot(session)),
      completed: this.completed.map(session => ({
        ...session,
        failureCategories: [...session.failureCategories],
        turns: session.turns.map(turn => ({
          ...turn,
          captureTurnSequences: turn.captureTurnSequences ? [...turn.captureTurnSequences] : undefined,
        })),
      })),
      droppedSignals: this.droppedSignals,
      saturatedSessions: this.saturatedSessions,
    }
  }

  private startSession(
    sourceKey: string,
    signal: Extract<VoiceDiagnosticSignal, { stage: 'session-started' }>,
  ): void {
    if (this.active.has(sourceKey))
      return

    if (this.active.size >= MAX_ACTIVE_VOICE_DIAGNOSTIC_SESSIONS) {
      this.saturatedSessions = incrementSaturated(this.saturatedSessions)
      return
    }

    this.active.set(sourceKey, {
      failureCategories: [],
      mode: signal.mode,
      providerReady: false,
      runtimeSequence: signal.runtimeSequence,
      sessionSequence: signal.sessionSequence,
      sourceKey,
      speaking: false,
      speakingEnds: 0,
      speakingStarts: 0,
      stage: 'started',
      transportReady: false,
      highestTurnSequence: 0,
      turnOrder: [],
      turns: new Map(),
    })
  }

  private recordSessionSignal(session: MutableSessionDiagnostics, signal: VoiceDiagnosticSignal): void {
    if (signal.stage === 'transport-ready') {
      session.transportReady = true
      session.stage = 'transport-ready'
      return
    }
    if (signal.stage === 'provider-ready') {
      session.providerReady = true
      session.stage = 'provider-ready'
      return
    }
    if (signal.stage === 'speaking-started') {
      session.speaking = true
      session.speakingStarts = incrementSaturated(session.speakingStarts)
      session.stage = 'receiving'
    }
    else if (signal.stage === 'speaking-ended') {
      session.speaking = false
      session.speakingEnds = incrementSaturated(session.speakingEnds)
    }

    if (signal.stage === 'failure' && signal.turnSequence === undefined) {
      if (!session.failureCategories.includes(signal.failureCategory))
        session.failureCategories.push(signal.failureCategory)
      session.stage = 'failed'
      return
    }

    if (!('turnSequence' in signal)) {
      this.recordDroppedSignal()
      return
    }

    const turn = this.turnFor(session, signal.turnSequence)
    if (turn === undefined)
      return

    switch (signal.stage) {
      case 'local-input-admitted': {
        turn.localAdmissionStatus = 'admitted'
        break
      }
      case 'local-input-rejected:below-threshold': {
        turn.localAdmissionStatus = 'rejected:below-threshold'
        break
      }
      case 'local-input-rejected:incomplete-sample': {
        turn.localAdmissionStatus = 'rejected:incomplete-sample'
        break
      }
      case 'local-input-rejected:insufficient-duration': {
        turn.localAdmissionStatus = 'rejected:insufficient-duration'
        break
      }
      case 'local-input-rejected:no-samples': {
        turn.localAdmissionStatus = 'rejected:no-samples'
        break
      }
      case 'failure': {
        turn.failureCategory = signal.failureCategory
        if (!session.failureCategories.includes(signal.failureCategory))
          session.failureCategories.push(signal.failureCategory)
        if (signal.failureCategory === 'playback-error')
          turn.playerState = 'error'
        session.stage = 'failed'
        break
      }
      case 'playback-aborted': {
        turn.playbackAborted = incrementSaturated(turn.playbackAborted)
        break
      }
      case 'playback-completed': {
        turn.playbackCompleted = incrementSaturated(turn.playbackCompleted)
        break
      }
      case 'playback-started': {
        turn.playbackStarted = incrementSaturated(turn.playbackStarted)
        session.stage = 'playing'
        break
      }
      case 'player-state': {
        turn.playerState = signal.playerState
        session.stage = signal.playerState === 'buffering'
          ? 'buffering'
          : signal.playerState === 'playing'
            ? 'playing'
            : signal.playerState === 'error'
              ? 'failed'
              : session.stage
        break
      }
      case 'provider-input-appended': {
        if (signal.inputKind === 'user-audio') {
          turn.userInputAppends = Math.max(turn.userInputAppends, saturatedCount(signal.providerInputChunks))
          turn.userInputBytes = Math.max(turn.userInputBytes, saturatedCount(signal.providerInputBytes))
        }
        else {
          turn.syntheticInputAppends = Math.max(turn.syntheticInputAppends, saturatedCount(signal.providerInputChunks))
          turn.syntheticInputBytes = Math.max(turn.syntheticInputBytes, saturatedCount(signal.providerInputBytes))
        }
        turn.inputAppends = Math.min(MAX_VOICE_DIAGNOSTIC_COUNT, turn.userInputAppends + turn.syntheticInputAppends)
        turn.inputBytes = Math.min(MAX_VOICE_DIAGNOSTIC_COUNT, turn.userInputBytes + turn.syntheticInputBytes)
        session.stage = 'provider-processing'
        break
      }
      case 'provider-input-committed': {
        const aggregateTurnSequence = signal.aggregateTurnSequence
        const captureTurnSequences = signal.captureTurnSequences
        if (
          !validSequence(aggregateTurnSequence)
          || !Array.isArray(captureTurnSequences)
          || captureTurnSequences.length === 0
          || captureTurnSequences.length > MAX_PROVIDER_CAPTURE_TURN_SEQUENCES
        ) {
          this.recordDroppedSignal()
          return
        }
        const contributors = [aggregateTurnSequence]
        let lastAccepted = aggregateTurnSequence
        let filteredContributor = false
        for (const [index, candidate] of captureTurnSequences.entries()) {
          if (contributors.length >= MAX_PROVIDER_CAPTURE_TURN_SEQUENCES)
            break
          if (index === 0 && candidate === aggregateTurnSequence)
            continue
          if (!validSequence(candidate) || candidate <= lastAccepted) {
            filteredContributor = true
            continue
          }
          contributors.push(candidate)
          lastAccepted = candidate
        }
        if (filteredContributor)
          this.recordDroppedSignal()
        turn.inputCommits = incrementSaturated(turn.inputCommits)
        turn.aggregateTurnSequence = aggregateTurnSequence
        turn.captureTurnSequences = contributors
        session.stage = 'provider-processing'
        break
      }
      case 'provider-response-audio': {
        turn.responseAudioChunks = Math.max(turn.responseAudioChunks, saturatedCount(signal.responseAudioChunks))
        turn.responseAudioBytes = Math.max(turn.responseAudioBytes, saturatedCount(signal.responseAudioBytes))
        session.stage = 'responding'
        break
      }
      case 'provider-response-cancelled': {
        turn.responsesCancelled = incrementSaturated(turn.responsesCancelled)
        break
      }
      case 'provider-response-completed': {
        turn.responsesCompleted = incrementSaturated(turn.responsesCompleted)
        break
      }
      case 'provider-response-created': {
        turn.responsesStarted = incrementSaturated(turn.responsesStarted)
        session.stage = 'responding'
        break
      }
      case 'provider-vad': {
        turn.providerVadTurns = incrementSaturated(turn.providerVadTurns)
        session.stage = 'provider-processing'
        break
      }
      case 'receiver-audio': {
        turn.opusPackets = Math.max(turn.opusPackets, saturatedCount(signal.opusPackets))
        turn.opusBytes = Math.max(turn.opusBytes, saturatedCount(signal.opusBytes))
        turn.pcmFrames = Math.max(turn.pcmFrames, saturatedCount(signal.pcmFrames))
        turn.pcmBytes = Math.max(turn.pcmBytes, saturatedCount(signal.pcmBytes))
        turn.receiverAudioObserved = turn.opusPackets > 0 || turn.opusBytes > 0 || turn.pcmFrames > 0 || turn.pcmBytes > 0
        session.stage = 'receiving'
        break
      }
      case 'provider-input-cleared':
      case 'provider-input-finished':
      case 'speaking-ended':
      case 'speaking-started':
        break
    }
  }

  private turnFor(session: MutableSessionDiagnostics, turnSequence: number | undefined): MutableTurnDiagnostics | undefined {
    if (!validSequence(turnSequence)) {
      this.recordDroppedSignal()
      return undefined
    }

    const existing = session.turns.get(turnSequence)
    if (existing !== undefined)
      return existing

    // Turn sequences are monotonic within one live voice session. Once an old
    // turn has been evicted, a late provider callback must not recreate it and
    // evict newer diagnostic ownership.
    if (turnSequence <= session.highestTurnSequence) {
      this.recordDroppedSignal()
      return undefined
    }

    if (session.turnOrder.length >= MAX_TURNS_PER_VOICE_DIAGNOSTIC_SESSION) {
      const oldestTurnSequence = session.turnOrder.shift()!
      session.turns.delete(oldestTurnSequence)
      this.recordDroppedSignal()
    }

    const turn = createTurn(turnSequence)
    session.highestTurnSequence = turnSequence
    session.turnOrder.push(turnSequence)
    session.turns.set(turnSequence, turn)
    return turn
  }

  private finalizeSession(session: MutableSessionDiagnostics, reason: VoiceDiagnosticCleanupReason): void {
    this.active.delete(session.sourceKey)
    this.completed.unshift(sessionSnapshot(session, reason))
    if (this.completed.length > MAX_COMPLETED_VOICE_DIAGNOSTIC_SESSIONS)
      this.completed.length = MAX_COMPLETED_VOICE_DIAGNOSTIC_SESSIONS
  }

  private recordDroppedSignal(): void {
    this.droppedSignals = incrementSaturated(this.droppedSignals)
  }
}
