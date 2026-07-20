import type { VoiceDiagnosticSignal } from '../bots/discord/commands/voiceDiagnostics'

import { randomBytes } from 'node:crypto'

/** Fixed contract version for the complete capability diagnostic snapshot. */
export const STANDALONE_CAPABILITY_DIAGNOSTICS_CONTRACT_VERSION = '1'

/** Ordered observable and user-confirmed boundaries of one diagnostic run. */
export type StandaloneCapabilityBoundaryId
  = | 'artifact-identity' | 'dashboard-api' | 'configuration' | 'bot-ready' | 'global-commands'
    | 'text-ingress' | 'text-reply-sent' | 'text-reply-correct' | 'voice-consent-join'
    | 'voice-transport' | 'voice-provider' | 'voice-speaking' | 'voice-opus-pcm-admission'
    | 'voice-provider-response' | 'voice-playback' | 'voice-heard' | 'voice-cleanup'

/** Safe outcome for one diagnostic boundary. */
export type StandaloneCapabilityBoundaryStatus = 'blocked' | 'fail' | 'pass' | 'unproven'

/** Typed, allowlisted human confirmations. */
export type StandaloneCapabilityConfirmation = 'text-reply-correct' | 'voice-consent-join' | 'voice-heard'

/** Public, source-honest identity of the currently running artifact. */
export interface StandaloneCapabilityArtifactIdentity {
  /** Fixed product surface that emitted this snapshot. */
  artifactKind: 'standalone-discord-bot'
  /** Version of the public diagnostic boundary contract. */
  diagnosticsContractVersion: string
  /** Build version reported by the owning bot artifact. */
  productVersion: string
  /** ISO timestamp captured when the owning artifact started. */
  startedAt: string
}

/** One sanitized diagnostic boundary displayed by the Dashboard. */
export interface StandaloneCapabilityBoundarySnapshot {
  /** Stable identifier in the ordered diagnostic boundary chain. */
  id: StandaloneCapabilityBoundaryId
  /** Truthful lifecycle result currently known for this boundary. */
  status: StandaloneCapabilityBoundaryStatus
  /** Source required before this boundary can pass. */
  expectedEvidence: 'automatic' | 'user-confirmation'
  /** Source actually received for this boundary, if any. */
  evidence: 'automatic' | 'user-confirmation' | 'waiting'
}

/** One bounded diagnostic run. It never contains Discord IDs, content, audio, or provider errors. */
export interface StandaloneCapabilityDiagnosticSnapshot {
  /** Content-free artifact identity for the process that owns this run. */
  artifact: StandaloneCapabilityArtifactIdentity
  /** Ordered public result for every diagnostic boundary. */
  boundaries: StandaloneCapabilityBoundarySnapshot[]
  /** ISO deadline after which the marker and pending run are invalid. */
  deadlineAt: string
  /** First boundary whose known outcome is failure or downstream blocking. */
  firstFailedOrBlockedBoundary?: StandaloneCapabilityBoundaryId
  /** First boundary that did not pass; downstream boundaries never supersede it. */
  firstNonPassBoundary?: StandaloneCapabilityBoundaryId
  /** First boundary still awaiting truthful evidence. */
  firstUnprovenBoundary?: StandaloneCapabilityBoundaryId
  /** Final contiguous successful boundary before the first non-pass result. */
  lastSuccessfulBoundary?: StandaloneCapabilityBoundaryId
  /** One-time text challenge, exposed only while it can be accepted. */
  marker?: string
  /** Current bounded lifecycle state. */
  phase: 'cancelled' | 'completed' | 'idle' | 'running' | 'timed-out'
}

/** Inputs captured at the owned Dashboard boundary when a diagnostic run starts. */
export interface StandaloneCapabilityDiagnosticsStartInput {
  /** Content-free identity of the process that owns the run. */
  artifact: StandaloneCapabilityArtifactIdentity
  /** Whether the adapter had already completed its ready lifecycle. */
  botReady?: boolean
  /** Configuration facts evaluated synchronously at the start boundary. */
  configuration: {
    /** Whether the Discord adapter has all required configuration. */
    discordConfigured: boolean
    /** Whether the selected voice provider has all required configuration. */
    providerConfigured: boolean
  }
  /** Whether the same-origin Dashboard API was reachable for this run. */
  dashboardApiHealthy: boolean
}

const BOUNDARIES: readonly StandaloneCapabilityBoundaryId[] = [
  'artifact-identity',
  'dashboard-api',
  'configuration',
  'bot-ready',
  'global-commands',
  'text-ingress',
  'text-reply-sent',
  'text-reply-correct',
  'voice-consent-join',
  'voice-transport',
  'voice-provider',
  'voice-speaking',
  'voice-opus-pcm-admission',
  'voice-provider-response',
  'voice-playback',
  'voice-heard',
  'voice-cleanup',
]

const CONFIRMATIONS: Readonly<Record<StandaloneCapabilityConfirmation, StandaloneCapabilityBoundaryId>> = {
  'text-reply-correct': 'text-reply-correct',
  'voice-consent-join': 'voice-consent-join',
  'voice-heard': 'voice-heard',
}

const RUN_DEADLINE_MS = 15 * 60_000

/**
 * Owns the bounded, ordered production diagnostic state machine.
 *
 * Use when:
 * - The local Dashboard needs a truthful end-to-end capability check.
 * - Production text and voice observations must be correlated without retaining their content.
 *
 * Expects:
 * - Text observations originate from the normal Discord message/reply path.
 * - Voice observations originate from the existing content-free VoiceDiagnostics observer.
 *
 * Returns:
 * - A single active run with typed confirmations, expiry, and immutable safe snapshots.
 */
export class StandaloneCapabilityDiagnostics {
  private readonly now: () => number
  private readonly randomToken: () => string
  private artifact: StandaloneCapabilityArtifactIdentity = {
    artifactKind: 'standalone-discord-bot',
    diagnosticsContractVersion: STANDALONE_CAPABILITY_DIAGNOSTICS_CONTRACT_VERSION,
    productVersion: 'unknown',
    startedAt: '',
  }

  private deadlineAt = 0
  private marker: string | undefined
  private phase: StandaloneCapabilityDiagnosticSnapshot['phase'] = 'idle'
  private readonly statuses = new Map<StandaloneCapabilityBoundaryId, StandaloneCapabilityBoundaryStatus>()
  private readonly evidence = new Set<StandaloneCapabilityBoundaryId>()
  private textOperationSequence: number | undefined
  private voiceSession: string | undefined
  private voiceTurn: number | undefined
  private closedVoiceTurn = 0
  private voiceSessionTerminal = false
  private voiceTurnTerminal = false
  private readonly pendingVoiceReadiness = new Set<'voice-provider' | 'voice-transport'>()
  private readonly voiceStages = new Set<string>()

  constructor(options: { now?: () => number, randomToken?: () => string } = {}) {
    this.now = options.now ?? Date.now
    this.randomToken = options.randomToken ?? (() => randomBytes(12).toString('base64url'))
  }

  /**
   * Starts one bounded, content-free diagnostic run.
   *
   * Use when:
   * - The Dashboard accepts a user request to check the currently owned bot.
   *
   * Returns:
   * - A one-time marker, or `undefined` while another run owns the state machine.
   */
  start(input: StandaloneCapabilityDiagnosticsStartInput): { marker: string } | undefined {
    if (this.phase === 'running')
      return undefined
    this.artifact = { ...input.artifact }
    this.deadlineAt = this.now() + RUN_DEADLINE_MS
    this.marker = `airi-diagnostic-${this.randomToken()}`
    this.phase = 'running'
    this.statuses.clear()
    this.evidence.clear()
    this.textOperationSequence = undefined
    this.voiceSession = undefined
    this.voiceTurn = undefined
    this.closedVoiceTurn = 0
    this.voiceSessionTerminal = false
    this.voiceTurnTerminal = false
    this.pendingVoiceReadiness.clear()
    this.voiceStages.clear()
    this.markEvidence('artifact-identity')
    if (input.dashboardApiHealthy)
      this.markEvidence('dashboard-api')
    if (input.configuration.discordConfigured && input.configuration.providerConfigured)
      this.markEvidence('configuration')
    else
      this.fail('configuration')
    // The standalone adapter publishes ready only after global command
    // registration resolves, so an already-ready adapter is authoritative for
    // both boundaries when a user starts a diagnosis mid-lifecycle.
    if (input.botReady) {
      this.markEvidence('bot-ready')
      this.markEvidence('global-commands')
    }
    this.reconcile()
    return { marker: this.marker }
  }

  /** Cancels the active run and invalidates its marker and future evidence. */
  cancel(): void {
    if (this.phase === 'running') {
      this.phase = 'cancelled'
      this.marker = undefined
    }
  }

  /**
   * Applies an allowlisted human confirmation at its exact ordered boundary.
   *
   * Returns:
   * - `true` only when the active run can consume that confirmation.
   */
  confirm(action: StandaloneCapabilityConfirmation): boolean {
    this.expireIfNeeded()
    if (this.phase !== 'running')
      return false
    const boundary = CONFIRMATIONS[action]
    if (action === 'voice-consent-join' && (this.voiceSession === undefined || this.voiceSessionTerminal))
      return false
    if (!this.canConfirm(boundary))
      return false
    this.markEvidence(boundary)
    if (action === 'voice-consent-join') {
      for (const readiness of this.pendingVoiceReadiness)
        this.markEvidence(readiness)
    }
    this.reconcile()
    return true
  }

  /** Checks whether text is the still-valid one-time marker without retaining it. */
  matchesTextChallenge(text: string): boolean {
    this.expireIfNeeded()
    return this.phase === 'running' && this.marker !== undefined && text.trim() === this.marker
  }

  /** Records the production adapter-ready transition. */
  recordBotReady(): void { this.record('bot-ready') }
  /** Records the production global-command-registration transition. */
  recordCommandsRegistered(): void { this.record('global-commands') }

  /** Records the exact marker only after normal production text ingress admits it. */
  recordTextAccepted(marker: string, operationSequence: number): void {
    if (!this.matchesTextChallenge(marker) || !this.validSequence(operationSequence))
      return
    // The marker is consumed only after normal production admission calls this
    // method. JavaScript's single-threaded transition makes duplicate matching
    // attempts observe the cleared marker, including concurrent event handlers.
    this.marker = undefined
    this.textOperationSequence = operationSequence
    this.record('text-ingress')
  }

  /** Records a successfully sent reply for the marker-owning text operation. */
  recordTextReplySent(operationSequence: number): void {
    if (operationSequence === this.textOperationSequence)
      this.record('text-reply-sent')
  }

  /** Records the typed outcome of the exact production text operation. */
  recordTextReplyFailed(operationSequence: number): void {
    if (operationSequence === this.textOperationSequence)
      this.fail('text-reply-sent')
  }

  /** Records a production bot lifecycle failure and invalidates ready-dependent evidence. */
  recordBotFailure(): void {
    this.fail('bot-ready')
    this.marker = undefined
    this.textOperationSequence = undefined
    this.resetVoiceSessionOwnership()
    this.phase = 'cancelled'
  }

  /**
   * Records one content-free production voice signal for the active run.
   *
   * Use when:
   * - The normal `VoiceDiagnostics` observer emits a lifecycle event.
   *
   * Returns:
   * - Nothing; unowned, terminal, stale, and out-of-order signals are ignored.
   */
  recordVoice(signal: VoiceDiagnosticSignal): void {
    this.expireIfNeeded()
    if (this.phase !== 'running')
      return
    const session = `${signal.runtimeSequence}:${signal.sessionSequence}`
    if (signal.stage === 'session-started') {
      if (this.voiceSession !== undefined || this.statuses.get('text-reply-correct') !== 'pass')
        return
      this.voiceSession = session
      return
    }
    if (session !== this.voiceSession || this.voiceSessionTerminal)
      return
    if (signal.stage === 'failure') {
      // A failure with turn ownership is never a session-fatal event. Provider
      // callbacks can arrive after a retry has handed ownership to a higher turn.
      if (signal.turnSequence !== undefined && (signal.turnSequence !== this.voiceTurn || this.voiceTurnTerminal))
        return
      const boundary = this.nextVoiceBoundary()
      if (boundary)
        this.fail(boundary)
      this.resetVoiceSessionOwnership()
      return
    }
    if (signal.stage === 'session-cleaned') {
      const boundary = this.nextVoiceBoundary()
      if (signal.cleanupReason === 'dismissed' && boundary === 'voice-cleanup')
        this.record('voice-cleanup')
      else if (boundary)
        this.fail(boundary)
      this.resetVoiceSessionOwnership()
      return
    }
    if (signal.stage === 'transport-ready') {
      this.pendingVoiceReadiness.add('voice-transport')
      if (this.statuses.get('voice-consent-join') === 'pass')
        this.markEvidence('voice-transport')
    }
    if (signal.stage === 'provider-ready') {
      this.pendingVoiceReadiness.add('voice-provider')
      if (this.statuses.get('voice-consent-join') === 'pass')
        this.markEvidence('voice-provider')
    }
    if ('turnSequence' in signal && this.voiceTurn === undefined && signal.stage === 'speaking-started') {
      if (signal.turnSequence <= this.closedVoiceTurn || !this.canPass('voice-speaking')) {
        this.reconcile()
        return
      }
      this.voiceTurn = signal.turnSequence
      this.voiceTurnTerminal = false
      this.voiceStages.clear()
    }
    if (!('turnSequence' in signal) || signal.turnSequence !== this.voiceTurn) {
      this.reconcile()
      return
    }
    if (this.voiceTurnTerminal)
      return
    if (signal.stage === 'provider-input-cleared' || signal.stage === 'provider-response-cancelled' || signal.stage === 'playback-aborted') {
      this.closedVoiceTurn = signal.turnSequence
      this.resetVoiceTurnEvidence()
      return
    }
    if (signal.stage === 'speaking-started')
      this.record('voice-speaking')
    if (signal.stage === 'receiver-audio' && signal.opusPackets > 0 && signal.pcmFrames > 0)
      this.voiceStages.add('audio')
    if (signal.stage === 'local-input-admitted' && this.voiceStages.has('audio'))
      this.voiceStages.add('admitted')
    if (this.voiceStages.has('admitted'))
      this.record('voice-opus-pcm-admission')
    if (signal.stage === 'provider-input-appended' && signal.providerInputChunks > 0 && this.voiceStages.has('admitted'))
      this.voiceStages.add('append')
    if (signal.stage === 'provider-input-committed' && this.voiceStages.has('append') && signal.aggregateTurnSequence === signal.turnSequence && signal.captureTurnSequences.includes(signal.turnSequence))
      this.voiceStages.add('commit')
    if (signal.stage === 'provider-vad' && this.voiceStages.has('commit'))
      this.voiceStages.add('vad')
    if (signal.stage === 'provider-response-created' && this.voiceStages.has('vad'))
      this.voiceStages.add('response-created')
    if (signal.stage === 'provider-response-audio' && signal.responseAudioChunks > 0 && this.voiceStages.has('response-created'))
      this.voiceStages.add('response-audio')
    if (this.voiceStages.has('response-audio'))
      this.record('voice-provider-response')
    if (signal.stage === 'playback-started' && this.voiceStages.has('response-audio'))
      this.voiceStages.add('playback-started')
    if (signal.stage === 'playback-completed' && this.voiceStages.has('playback-started'))
      this.record('voice-playback')
    this.reconcile()
  }

  getSnapshot(): StandaloneCapabilityDiagnosticSnapshot {
    this.expireIfNeeded()
    const boundaries: StandaloneCapabilityBoundarySnapshot[] = BOUNDARIES.map(id => ({
      evidence: this.evidence.has(id) ? this.confirmationFor(id) ? 'user-confirmation' : 'automatic' : 'waiting',
      expectedEvidence: this.confirmationFor(id) ? 'user-confirmation' : 'automatic',
      id,
      status: this.statuses.get(id) ?? 'unproven',
    }))
    const completed = boundaries.every(boundary => boundary.status === 'pass')
    if (this.phase === 'running' && completed) {
      this.phase = 'completed'
      this.marker = undefined
    }
    const firstNonPass = boundaries.find(boundary => boundary.status !== 'pass')?.id
    const firstFailedOrBlocked = boundaries.find(boundary => boundary.status === 'fail' || boundary.status === 'blocked')?.id
    return {
      artifact: { ...this.artifact },
      boundaries,
      deadlineAt: new Date(this.deadlineAt).toISOString(),
      firstFailedOrBlockedBoundary: firstFailedOrBlocked,
      firstNonPassBoundary: firstNonPass,
      firstUnprovenBoundary: boundaries.find(boundary => boundary.status === 'unproven')?.id,
      lastSuccessfulBoundary: firstNonPass === undefined ? boundaries.at(-1)?.id : boundaries[BOUNDARIES.indexOf(firstNonPass) - 1]?.id,
      marker: this.phase === 'running' ? this.marker : undefined,
      phase: this.phase,
    }
  }

  private record(boundary: StandaloneCapabilityBoundaryId): void {
    this.expireIfNeeded()
    if (this.phase !== 'running' || !this.canPass(boundary))
      return
    this.markEvidence(boundary)
    this.reconcile()
  }

  private markEvidence(boundary: StandaloneCapabilityBoundaryId): void { this.evidence.add(boundary) }

  private canPass(boundary: StandaloneCapabilityBoundaryId): boolean {
    const index = BOUNDARIES.indexOf(boundary)
    return index === 0 || this.statuses.get(BOUNDARIES[index - 1]!) === 'pass'
  }

  /** Returns whether an unconsumed human confirmation can truthfully pass its boundary. */
  private canConfirm(boundary: StandaloneCapabilityBoundaryId): boolean {
    return this.statuses.get(boundary) === 'unproven'
      && !this.evidence.has(boundary)
      && this.canPass(boundary)
  }

  private confirmationFor(boundary: StandaloneCapabilityBoundaryId): boolean {
    return Object.values(CONFIRMATIONS).includes(boundary)
  }

  private nextVoiceBoundary(): StandaloneCapabilityBoundaryId | undefined {
    return BOUNDARIES.slice(8).find(boundary => this.statuses.get(boundary) !== 'pass')
  }

  private reconcile(): void {
    if (this.phase !== 'running')
      return
    let blocked = false
    for (const boundary of BOUNDARIES) {
      if (this.statuses.get(boundary) === 'fail') {
        blocked = true
        continue
      }
      if (blocked) {
        this.statuses.set(boundary, 'blocked')
        continue
      }
      if (this.evidence.has(boundary) && this.canPass(boundary))
        this.statuses.set(boundary, 'pass')
      else if (this.statuses.get(boundary) !== 'pass')
        this.statuses.set(boundary, 'unproven')
    }
  }

  private fail(boundary: StandaloneCapabilityBoundaryId): void {
    if (this.phase !== 'running')
      return
    const failureIndex = BOUNDARIES.indexOf(boundary)
    for (const downstream of BOUNDARIES.slice(failureIndex)) {
      this.statuses.delete(downstream)
      this.evidence.delete(downstream)
    }
    this.statuses.set(boundary, 'fail')
    this.reconcile()
  }

  /** Clears the owned session after its one permitted cleanup, failure, or fatal lifecycle stop. */
  private resetVoiceSessionOwnership(): void {
    this.voiceSession = undefined
    this.voiceTurn = undefined
    this.voiceSessionTerminal = true
    this.voiceTurnTerminal = true
    this.pendingVoiceReadiness.clear()
    this.voiceStages.clear()
  }

  /** Rolls a retryable production turn back to the first turn-scoped voice boundary. */
  private resetVoiceTurnEvidence(): void {
    const firstTurnBoundary = BOUNDARIES.indexOf('voice-speaking')
    for (const boundary of BOUNDARIES.slice(firstTurnBoundary)) {
      this.statuses.delete(boundary)
      this.evidence.delete(boundary)
    }
    this.voiceTurn = undefined
    this.voiceTurnTerminal = false
    this.voiceStages.clear()
    this.reconcile()
  }

  private expireIfNeeded(): void {
    if (this.phase === 'running' && this.now() >= this.deadlineAt) {
      const pending = BOUNDARIES.find(boundary => this.statuses.get(boundary) !== 'pass')
      if (pending)
        this.statuses.set(pending, 'fail')
      this.phase = 'timed-out'
      this.marker = undefined
      let afterFailure = false
      for (const boundary of BOUNDARIES) {
        if (afterFailure)
          this.statuses.set(boundary, 'blocked')
        if (this.statuses.get(boundary) === 'fail')
          afterFailure = true
      }
    }
  }

  private validSequence(value: number): boolean { return Number.isSafeInteger(value) && value > 0 }
}
