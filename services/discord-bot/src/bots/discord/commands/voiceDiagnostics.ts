/** Fixed voice-call stages that are safe to expose through the local Dashboard. */
export type VoiceDiagnosticStage
  = | 'failure'
    | 'local-input-admitted'
    | 'local-input-rejected:below-threshold'
    | 'local-input-rejected:incomplete-sample'
    | 'local-input-rejected:insufficient-duration'
    | 'local-input-rejected:no-samples'
    | 'playback-aborted'
    | 'playback-completed'
    | 'playback-started'
    | 'player-state'
    | 'provider-input-appended'
    | 'provider-input-cleared'
    | 'provider-input-committed'
    | 'provider-input-finished'
    | 'provider-ready'
    | 'provider-response-audio'
    | 'provider-response-cancelled'
    | 'provider-response-completed'
    | 'provider-response-created'
    | 'provider-vad'
    | 'receiver-audio'
    | 'session-cleaned'
    | 'session-started'
    | 'speaking-ended'
    | 'speaking-started'
    | 'transport-ready'

/** Fixed failure categories that never include provider- or Discord-controlled text. */
export type VoiceDiagnosticFailureCategory
  = | 'connection-error'
    | 'playback-error'
    | 'provider-input-capacity'
    | 'provider-error'
    | 'receiver-error'

/** Fixed cleanup classifications for one anonymous voice generation. */
export type VoiceDiagnosticCleanupReason
  = | 'dismissed'
    | 'disconnected'
    | 'failed'
    | 'replaced'
    | 'stopped'

/** Fixed Discord player states exposed by voice diagnostics. */
export type VoiceDiagnosticPlayerState = 'buffering' | 'error' | 'idle' | 'playing'

interface VoiceDiagnosticSignalBase {
  /** Adapter-local sequence that separates restart generations. */
  runtimeSequence: number
  /** VoiceManager-local sequence for one Discord voice generation. */
  sessionSequence: number
}

interface VoiceDiagnosticTurnSignalBase extends VoiceDiagnosticSignalBase {
  /** Anonymous turn sequence within the session, when a turn owns the signal. */
  turnSequence: number
}

/**
 * Content-free signal emitted from a real Discord voice lifecycle boundary.
 *
 * The stage discriminant admits only the fields owned by that transition. The
 * contract intentionally has no fields for Discord identifiers, names,
 * transcripts, audio, URLs, raw provider events, or Error objects. Numeric
 * counts are cumulative snapshots and are saturated by the projection owner.
 */
export type VoiceDiagnosticSignal
  = | VoiceDiagnosticSignalBase & {
    /** Fixed production lifecycle transition. */
    stage: 'session-started'
    /** Provider mode, present only when a session starts. */
    mode: 'classic' | 'qwen-realtime'
  }
  | VoiceDiagnosticSignalBase & {
    /** Fixed production lifecycle transition. */
    stage: 'provider-ready' | 'transport-ready'
  }
  | VoiceDiagnosticSignalBase & {
    /** Fixed failure category for a session-level failure before any turn exists. */
    failureCategory: VoiceDiagnosticFailureCategory
    /** Fixed production lifecycle transition. */
    stage: 'failure'
    /** Anonymous turn sequence when the failure belongs to an admitted turn. */
    turnSequence?: number
  }
  | VoiceDiagnosticSignalBase & {
    /** Fixed lifecycle reason for the exact cleaned session. */
    cleanupReason: VoiceDiagnosticCleanupReason
    /** Fixed production lifecycle transition. */
    stage: 'session-cleaned'
  }
  | VoiceDiagnosticTurnSignalBase & {
    /** Provider aggregate whose public capture ownership remains explicit. */
    aggregateTurnSequence: number
    /** Bounded capture sequences that contributed to this aggregate. */
    captureTurnSequences: number[]
    /** Fixed production lifecycle transition. */
    stage: 'provider-input-committed'
  }
  | VoiceDiagnosticTurnSignalBase & {
    /** Fixed production lifecycle transition. */
    stage:
      | 'playback-aborted'
      | 'playback-completed'
      | 'playback-started'
      | 'local-input-admitted'
      | 'local-input-rejected:below-threshold'
      | 'local-input-rejected:incomplete-sample'
      | 'local-input-rejected:insufficient-duration'
      | 'local-input-rejected:no-samples'
      | 'provider-input-cleared'
      | 'provider-input-finished'
      | 'provider-response-cancelled'
      | 'provider-response-completed'
      | 'provider-response-created'
      | 'provider-vad'
      | 'speaking-ended'
      | 'speaking-started'
  }
  | VoiceDiagnosticTurnSignalBase & {
    /** Cumulative raw Discord Opus packet count for the turn. */
    opusPackets: number
    /** Cumulative raw Discord Opus byte count for the turn. */
    opusBytes: number
    /** Cumulative decoded PCM frame count for the turn. */
    pcmFrames: number
    /** Cumulative decoded PCM byte count for the turn. */
    pcmBytes: number
    /** Fixed production lifecycle transition. */
    stage: 'receiver-audio'
  }
  | VoiceDiagnosticTurnSignalBase & {
    /** Distinguishes captured user audio from runtime-generated trailing silence. */
    inputKind: 'synthetic-silence' | 'user-audio'
    /** Cumulative successful Qwen socket sends for this input kind and turn. */
    providerInputChunks: number
    /** Cumulative successful Qwen socket bytes for this input kind and turn. */
    providerInputBytes: number
    /** Fixed production lifecycle transition. */
    stage: 'provider-input-appended'
  }
  | VoiceDiagnosticTurnSignalBase & {
    /** Cumulative Qwen response audio chunks observed for the turn. */
    responseAudioChunks: number
    /** Cumulative Qwen response audio bytes observed for the turn. */
    responseAudioBytes: number
    /** Fixed production lifecycle transition. */
    stage: 'provider-response-audio'
  }
  | VoiceDiagnosticTurnSignalBase & {
    /** Fixed player state, present only for `player-state`. */
    playerState: VoiceDiagnosticPlayerState
    /** Fixed production lifecycle transition. */
    stage: 'player-state'
  }

/** Production event before the observer supplies its runtime generation. */
export type VoiceDiagnosticEvent = VoiceDiagnosticSignal extends infer Signal
  ? Signal extends VoiceDiagnosticSignal
    ? Omit<Signal, 'runtimeSequence'>
    : never
  : never

/** Enriches one typed production event with its observer-owned runtime generation. */
export function withVoiceDiagnosticRuntime(
  runtimeSequence: number,
  event: VoiceDiagnosticEvent,
): VoiceDiagnosticSignal {
  return { ...event, runtimeSequence }
}

/** Optional content-free observer installed only by the local standalone runtime. */
export interface VoiceDiagnosticsObserver {
  /** Adapter-local sequence used to disambiguate manager replacements. */
  runtimeSequence: number
  /** Records one allowlisted production signal without logging it. */
  record: (signal: VoiceDiagnosticSignal) => void
}
