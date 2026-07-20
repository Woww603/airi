import type { Readable } from 'node:stream'

import type { AudioPlayer, AudioPlayerState, PlayerSubscription, VoiceConnection, VoiceConnectionState } from '@discordjs/voice'
import type { Logg } from '@guiiai/logg'
import type {
  BaseGuildVoiceChannel,
  ButtonInteraction,
  CacheType,
  ChatInputCommandInteraction,
  Client as DiscordClient,
  GuildMember,
  VoiceState,
} from 'discord.js'

import type { RealtimeVoiceProviderFailure } from '../../../standalone/realtime-provider-failure'
import type {
  VoiceDiagnosticCleanupReason,
  VoiceDiagnosticEvent,
  VoiceDiagnosticsObserver,
} from './voiceDiagnostics'

import { Buffer } from 'node:buffer'
import { EventEmitter } from 'node:events'
import { PassThrough, pipeline } from 'node:stream'

import {
  createAudioPlayer,
  createAudioResource,
  entersState,
  getVoiceConnections,
  joinVoiceChannel,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
} from '@discordjs/voice'
import { useLogg } from '@guiiai/logg'
import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js'

import { DECODE_SAMPLE_RATE } from '../../../constants/audio'
import { createClassicDiscordVoiceAudioResource } from '../../../pipelines/classic-voice-audio'
import { SpeechProviderRequestError } from '../../../pipelines/openai-speech'
import { normalizeRealtimeVoiceProviderFailure } from '../../../standalone/realtime-provider-failure'
import { convertOpusToWav, Pcm16InputSafetyGate, Pcm16InterruptionGate, Pcm24kMonoTo48kStereoTransform } from '../../../utils/audio'
import { AudioMonitor } from '../../../utils/audio-monitor'
import { OpusDecoder } from '../../../utils/opus'
import { withVoiceDiagnosticRuntime } from './voiceDiagnostics'

/** Stable speaker metadata retained across asynchronous Discord voice work. */
export interface VoiceSpeakerIdentity {
  /** Discord display name captured when the utterance starts. */
  readonly displayName: string
  /** Discord guild name captured when the utterance starts. */
  readonly guildName: string
  /** Optional guild nickname captured when the utterance starts. */
  readonly nickname?: string
}

/** One bounded Discord voice utterance after speech-to-text conversion. */
export interface VoiceTranscriptionInput {
  /** Cancels STT, chat, TTS, and playback when the voice session changes. */
  abortSignal: AbortSignal
  /** Discord voice channel containing the utterance. */
  channelId: string
  /** Absolute deadline shared by decode, STT, chat, TTS, and audio handoff. */
  deadlineAt: number
  /** Discord server containing the voice channel. */
  guildId: string
  /** Stable speaker labels without a live Discord GuildMember object. */
  speaker: VoiceSpeakerIdentity
  /** Confirms identity, access, consent, and rate admission ran before this audio turn was captured. */
  rateLimitAdmitted: true
  /** Exact guild/channel/generation/user owner for bounded provider work. */
  speechProviderOwnerKey: string
  /** Stable participant identity that bounds provider work across replacements. */
  speechProviderPrincipalKey: string
  /** Provider-visible transcription text. */
  text: string
  /** Exact Discord user id for isolation and playback routing. */
  userId: string
}

/**
 * Conversation boundary invoked after Discord speech-to-text succeeds.
 */
export type VoiceTranscriptionHandler = (input: VoiceTranscriptionInput) => Promise<Readable | undefined>

/**
 * Batch speech-to-text boundary used by the Discord voice manager.
 */
export type VoiceTranscriber = (wavBuffer: Buffer, options: {
  /** Cancels the exact classic voice turn. */
  abortSignal: AbortSignal
  /** Absolute deadline created once when the speaking turn is admitted. */
  deadlineAt: number
  /** Exact guild/channel/generation/user provider owner. */
  ownerKey: string
  /** Stable participant identity shared by replacement generations. */
  principalKey: string
}) => Promise<string>

/** Opaque provider correlation retained only within one realtime session generation. */
export interface RealtimeVoiceProviderEventIdentity {
  /** Anonymous caller-owned input operation retained until commit or clear. */
  readonly inputSequence?: number
  /** Opaque provider item identity retained only for in-process turn ownership. */
  readonly itemId?: string
  /** Opaque provider response identity retained only for in-process turn ownership. */
  readonly responseId?: string
}

/** Successful provider-input socket send without audio content. */
export interface RealtimeVoiceInputAudioSent {
  /** Number of PCM bytes accepted by the socket send. */
  readonly byteLength: number
  /** Number of chunks represented by the increment. */
  readonly chunkCount: 1
  /** Anonymous input operation supplied at the first successful append. */
  readonly inputSequence: number
  /** Distinguishes captured speech from runtime-generated trailing silence. */
  readonly kind: 'synthetic-silence' | 'user-audio'
}

/** Fixed provider terminal result; never includes provider-controlled text. */
export type RealtimeVoiceResponseTerminalOutcome
  = | 'aborted'
    | 'cancelled'
    | 'completed'
    | 'failed'
    | 'incomplete'
    | 'unknown'

/** Callbacks consumed by a native audio-to-audio voice provider session. */
export interface RealtimeVoiceCallSessionEvents {
  /** Receives raw 24 kHz mono PCM16 provider audio. */
  onAudio?: (pcm: Buffer, identity: RealtimeVoiceProviderEventIdentity) => void
  /** Marks the end of the current provider audio stream. */
  onAudioDone?: (identity: RealtimeVoiceProviderEventIdentity) => void
  /** Receives the final assistant transcript without changing chat storage. */
  onAssistantTranscript?: (text: string, identity: RealtimeVoiceProviderEventIdentity) => void
  /** Reports provider session closure. */
  onClose?: (code: number, reason: string) => void
  /** Reports provider or transport failure. */
  onError?: (failure: RealtimeVoiceProviderFailure) => void
  /** Confirms the provider accepted a buffered input commit. */
  onInputCommitted?: (identity: RealtimeVoiceProviderEventIdentity) => void
  /** Confirms the provider cleared its current input buffer. */
  onInputCleared?: (identity: RealtimeVoiceProviderEventIdentity) => void
  /** Reports one non-empty input chunk after the provider socket accepts it. */
  onInputAudioSent?: (increment: RealtimeVoiceInputAudioSent) => void
  /** Confirms the provider accepted cancellation of its current response. */
  onResponseCancelled?: (identity: RealtimeVoiceProviderEventIdentity) => void
  /** Marks provider creation of a new response. */
  onResponseCreated?: (identity: RealtimeVoiceProviderEventIdentity) => void
  /** Marks the end of one complete provider response. */
  onResponseDone?: (
    identity: RealtimeVoiceProviderEventIdentity,
    outcome: RealtimeVoiceResponseTerminalOutcome,
  ) => void
  /** Signals barge-in after server-side voice activity detection. */
  onSpeechStarted?: (identity: RealtimeVoiceProviderEventIdentity) => void
  /** Signals the end of a server-side voice activity interval. */
  onSpeechStopped?: (identity: RealtimeVoiceProviderEventIdentity) => void
  /** Receives the final user transcript without changing chat storage. */
  onUserTranscript?: (text: string, identity: RealtimeVoiceProviderEventIdentity) => void
  /** Reports a recoverable provider condition without ending the Discord voice generation. */
  onWarning?: (warning: RealtimeVoiceProviderFailure) => void
}

/** Active native voice provider session for one Discord channel. */
export interface RealtimeVoiceCallSession {
  /** Appends raw 16 kHz mono PCM16 input and returns false under backpressure. */
  appendAudio: (pcm: Buffer, inputSequence: number) => boolean
  /** Discards a pending provider input when an admitted speaker is revoked before speaking end. */
  abortInput?: () => void
  /** Cancels an in-progress provider response. */
  cancelResponse: () => void
  /** Releases the upstream voice provider connection. */
  close: () => void
  /** Schedules trailing PCM silence so provider VAD can finish the current Discord utterance. */
  finishInput: () => void
  /** Cancels only a scheduled finish while a new Discord capture begins. */
  pauseInputFinish?: () => void
}

/** Lifecycle ownership supplied while opening one native voice provider session. */
export interface RealtimeVoiceCallConnectOptions {
  /** Aborts a pending provider connection when its Discord voice generation ends. */
  readonly signal: AbortSignal
}

/** Native voice-call provider boundary used by the Discord voice manager. */
export interface RealtimeVoiceCallRuntime {
  /** Opens one independently isolated session for a Discord voice channel. */
  connect: (
    events: RealtimeVoiceCallSessionEvents,
    options?: RealtimeVoiceCallConnectOptions,
  ) => Promise<RealtimeVoiceCallSession>
  /** Returns the local PCM16 RMS threshold used to confirm a human interruption. */
  getInterruptionRmsThreshold: () => number
  /** Returns the configured user-facing voice-call mode. */
  getMode: () => 'classic' | 'qwen-realtime'
  /** Returns whether all selected provider settings are present. */
  isConfigured: () => boolean
}

/** Speaker identity metadata checked before native audio leaves Discord. */
export interface RealtimeVoiceSpeakerInput {
  /** Discord voice channel receiving the speaker. */
  readonly channelId: string
  /** Discord server receiving the speaker. */
  readonly guildId: string
  /** Exact Discord speaker id. */
  readonly userId: string
}

/** Mutable voice-ingress policy checked before and during Discord audio capture. */
export interface RealtimeVoiceSpeakerAdmissionPolicy {
  /** Consumes rate admission for one speaking turn after current access policy passes. */
  admit: (input: RealtimeVoiceSpeakerInput) => boolean
  /** Rechecks current identity/guild/channel policy without consuming another rate slot. */
  allows: (input: RealtimeVoiceSpeakerInput) => boolean
}

/** Public provider facts shown before classic Discord voice capture begins. */
export interface ClassicVoiceProviderDisclosure {
  /** Model boundary that receives the speech-to-text transcript. */
  model: string
  /** Speech-to-text vendor or endpoint that receives opted-in audio. */
  stt: string
  /** Optional text-to-speech vendor or endpoint that receives reply text. */
  tts?: string
}

type VoiceConsentAction = 'opt-in' | 'withdraw'

interface VoiceConsentSession {
  channel: BaseGuildVoiceChannel
  consentedUserIds: Set<string>
  id: string
  interaction: ChatInputCommandInteraction<CacheType>
  participantVoiceSessionIds: Map<string, string>
  state: 'active' | 'activating' | 'pending'
}

interface ActiveVoiceSession {
  abortController: AbortController
  channel: BaseGuildVoiceChannel
  connection: VoiceConnection
  consentSessionId?: string
  currentDiagnosticTurnSequence?: number
  diagnosticCleaned: boolean
  diagnosticSessionSequence: number
  discordVoiceSessionId?: string
  nextDiagnosticTurnSequence: number
  pendingDiscordVoiceStateResetCount: number
  pendingDiscordVoiceSessionId?: string
  scope: VoicePlaybackScope
}

interface VoiceUserState {
  abortSignal: AbortSignal
  buffers: Buffer[]
  capture: VoiceCaptureIdentity
  connection: VoiceConnection
  lastActive: number
  scope: VoicePlaybackScope
  speaker: VoiceSpeakerIdentity
  totalLength: number
  transcriptionText: string
  userId: string
}

interface ClassicVoiceTurnBoundary {
  abortController: AbortController
  deadlineAt: number
  deadlineTimer?: ReturnType<typeof setTimeout>
  ownerKey: string
  principalKey: string
  signal: AbortSignal
  speakerKey: string
  state: VoiceUserState
}

/** Identifies one immutable Discord voice-channel generation. */
export interface VoicePlaybackScope {
  /** Discord voice channel that owns receive and playback side effects. */
  readonly channelId: string
  /** Monotonic manager-local generation invalidated by move, leave, or disconnect. */
  readonly generation: number
  /** Discord guild that owns the voice connection. */
  readonly guildId: string
}

interface ScopedClassicPlayback {
  abortSignal: AbortSignal
  audioStream: Readable
  cleaned: boolean
  player: AudioPlayer
  scope: VoicePlaybackScope
  stopAbortedPlayback: () => void
  subscription?: PlayerSubscription
}

interface ScopedRealtimePlayback {
  cleaned: boolean
  converted: Readable
  diagnosticSessionSequence?: number
  handlePlaybackError: (error: Error) => void
  handlePlayerStateChange: (oldState: AudioPlayerState, newState: AudioPlayerState) => void
  input: PassThrough
  player: AudioPlayer
  scope: VoicePlaybackScope
  started: boolean
  subscribed: boolean
  subscription?: PlayerSubscription
  terminalReported: boolean
  turnSequence?: number
}

/** One provider commit and the Discord captures whose PCM it contains. */
interface CommittedInputRecord {
  readonly captureTurnSequences: readonly number[]
  readonly itemId?: string
  readonly ownerTurnSequence: number
}

/** One synchronous provider acknowledgement that is causally owned by appendAudio. */
interface RealtimeAppendInvocation {
  acknowledged: boolean
  readonly correlationEpoch: number
  readonly inputSequence: number
}

/** Tracks whether a completed Discord capture received a formal provider acknowledgement. */
interface RealtimeCaptureAppendState {
  hasFormalProviderAck: boolean
  hasSuccessfulUserAppend: boolean
  /** A capture owns exactly one capacity slot until synchronous acknowledgement or speaking end. */
  reservationHeld: boolean
}

interface ScopedRealtimeSession {
  activeCaptureTurnSequence?: number
  activeProviderInputTurnSequence?: number
  readonly abortController: AbortController
  captureAppendStates?: Map<number, RealtimeCaptureAppendState>
  readonly committedInputByItemId?: Map<string, CommittedInputRecord>
  readonly committedInputTurnSequences: number[]
  readonly committedInputRecords?: CommittedInputRecord[]
  connectTask?: Promise<void>
  correlationEpoch?: number
  readonly finishedInputTurnSequences: number[]
  inputAppendInvocations?: RealtimeAppendInvocation[]
  readonly inputItemTurnSequences: Map<string, number>
  readonly committedInputItemIds: Set<string>
  readonly observedSpeechItemIds: Set<string>
  pendingInputAggregate?: { captureTurnSequences: number[], ownerTurnSequence: number }
  provider?: RealtimeVoiceCallSession
  readonly providerInputByTurn: Map<number, RealtimeProviderInputCounters>
  readonly responseMetricsByTurn: Map<number, RealtimeResponseMetrics>
  readonly responseTurnSequences: Map<string, number>
  readonly retiredInputItemIds: Set<string>
  readonly retiredResponseIds: Set<string>
  readonly scope: VoicePlaybackScope
  terminated: boolean
}

interface RealtimeProviderInputCounters {
  syntheticInputBytes: number
  syntheticInputChunks: number
  userInputBytes: number
  userInputChunks: number
}

interface RealtimeResponseMetrics {
  audioReported: boolean
  cancelledReported: boolean
  responseAudioBytes: number
  responseAudioChunks: number
}

/** Distinguishes receiver replacements that share one speaker generation key. */
interface VoiceCaptureIdentity {
  readonly id: symbol
}

interface ScopedVoiceMonitor {
  admitted: boolean
  readonly capture: VoiceCaptureIdentity
  readonly discordVoiceSessionId?: string
  diagnosticTurnSequence?: number
  finishing: boolean
  opusBytes: number
  opusPackets: number
  pcmBytes: number
  pcmFrames: number
  readonly scope: VoicePlaybackScope
  readonly stop: () => void
  readonly userId: string
}

interface JoinVoiceChannelOptions {
  /** Whether the command response should be replaced with a joined notice. @default true */
  announce?: boolean
  /** Exact public consent session authorizing this join. */
  consentSessionId?: string
}

const VOICE_CONSENT_CUSTOM_ID_PREFIX = 'airi:voice-consent'
/** Bounds stale provider connects if an injected or future runtime ignores cancellation. */
const MAX_PENDING_REALTIME_CONNECTS = 64
/** Bounds process-owned Discord connections and their one-to-one provider/listener/session maps. */
const MAX_ACTIVE_VOICE_GENERATIONS = 64
/** Bounds pending and active `/summon` consent owners retained by the process. */
const MAX_VOICE_CONSENT_SESSION_OWNERS = 64
/** Bounds live decoder/stream/controller owners across all connected Discord channels. */
const MAX_ACTIVE_VOICE_MONITORS = 512
/** Prevents one voice channel from consuming the process-wide live capture budget. */
const MAX_ACTIVE_VOICE_MONITORS_PER_SCOPE = 32
/** Bounds provider identity and per-turn telemetry retained by one realtime session. */
const MAX_REALTIME_TURN_CORRELATIONS = 64
/** A provider input buffer can truthfully commit at most 32 Discord capture owners. */
const MAX_PENDING_INPUT_AGGREGATE_CONTRIBUTORS = 32
/** Retains completed provider identities across a normal 110-minute generation so delayed duplicates cannot be reused. */
const MAX_REALTIME_RETIRED_IDENTITIES = 1_024
/** Content-free status returned when a voice owner cannot be safely admitted. */
const VOICE_CAPACITY_STATUS = 'Discord voice capacity is temporarily exhausted. Try again later.'
/** End-to-end classic voice deadline from speaking admission through audio handoff. */
const DEFAULT_CLASSIC_VOICE_TURN_TIMEOUT_MS = 180_000

type VoiceLifecycleFailureCategory
  = | 'capacity'
    | 'cancelled'
    | 'cleanup'
    | 'connection'
    | 'diagnostics'
    | 'discord-operation'
    | 'internal'
    | 'playback'
    | 'policy'
    | 'provider'
    | 'receiver'
    | 'timeout'

type VoiceLifecycleEventCode
  = | 'classic-operation-discard-failed'
    | 'classic-operation-discarded'
    | 'classic-playback-callback-cleanup-failed'
    | 'classic-playback-completed'
    | 'classic-playback-error'
    | 'classic-playback-rollback-failed'
    | 'classic-turn-cancelled'
    | 'classic-turn-failed'
    | 'connection-disconnect-confirmed'
    | 'connection-disconnected'
    | 'connection-error'
    | 'connection-established'
    | 'connection-reconnecting'
    | 'connection-state-change'
    | 'consent-message-refresh-failed'
    | 'consent-session-connect-failed'
    | 'diagnostics-observer-rejected'
    | 'input-finalize-failed'
    | 'input-generation-cleanup-failed'
    | 'member-fetch-failed'
    | 'monitor-buffer-failed'
    | 'monitor-capacity-rejected'
    | 'monitor-empty-buffer'
    | 'monitor-started'
    | 'monitor-stream-failed'
    | 'monitor-stopped'
    | 'participant-input-ended'
    | 'participant-input-started'
    | 'participant-policy-rejected'
    | 'playback-cleanup-failed'
    | 'playback-completed'
    | 'playback-error'
    | 'playback-generation-cleanup-failed'
    | 'provider-callback-cleanup-failed'
    | 'provider-callback-failed'
    | 'provider-close-cleanup-failed'
    | 'provider-connect-failed'
    | 'provider-correlation-rejected'
    | 'provider-error'
    | 'provider-error-cleanup-failed'
    | 'provider-input-backpressure'
    | 'provider-reply-target-cleanup-failed'
    | 'provider-session-closed'
    | 'provider-transport-lost'
    | 'provider-transcript-complete'
    | 'provider-warning'
    | 'receiver-decoder-closed'
    | 'receiver-decoder-error'
    | 'receiver-pipeline-error'
    | 'receiver-stream-cleanup-failed'
    | 'receiver-stream-closed'
    | 'self-voice-state-update-failed'
    | 'session-capacity-rejected'
    | 'session-cleanup-failed'
    | 'session-dismissed'
    | 'session-not-found'
    | 'speaking-end-cleanup-failed'
    | 'speaking-end-handler-failed'
    | 'speaking-start-cleanup-failed'
    | 'speaking-start-handler-failed'
    | 'state-change-cleanup-failed'
    | 'state-change-handler-failed'
    | 'transcription-complete'
    | 'withdrawal-cleanup-failed'

interface VoiceLifecycleLogRecord {
  /** Stable allowlisted lifecycle code; never derived from external input. */
  eventCode: VoiceLifecycleEventCode
  /** Fixed failure class when the event represents degraded behavior. */
  failureCategory?: VoiceLifecycleFailureCategory
  /** Anonymous process-local voice session correlation. */
  sessionSequence?: number
  /** Anonymous process-local turn correlation. */
  turnSequence?: number
  /** Bounded process-wide active owner count. */
  activeCount?: number
  /** Bounded per-scope active owner count. */
  scopeCount?: number
  /** Bounded provider transcript size; content is never retained. */
  characterCount?: number
  /** WebSocket/Discord close code without peer-controlled reason text. */
  closeCode?: number
  /** Bounded local playback duration. */
  elapsedMs?: number
  /** Fixed voice mode selected for this lifecycle. */
  mode?: 'classic' | 'qwen-realtime'
  /** Allowlisted Discord voice transport state. */
  state?: VoiceConnectionState['status']
  /** Allowlisted previous Discord voice transport state. */
  oldState?: VoiceConnectionState['status']
  /** Allowlisted next Discord voice transport state. */
  newState?: VoiceConnectionState['status']
  /** Fixed classic provider phase. */
  phase?: 'chat-tts' | 'stt'
  /** Fixed completion category for late operations. */
  result?: 'rejected' | 'resolved'
  /** Whether a lifecycle failure can recover without replacing the owner. */
  retryable?: boolean
  /** Whether the lifecycle owner was terminated. */
  terminal?: boolean
}

function boundedVoiceLogCount(value: number): number {
  if (!Number.isFinite(value) || value <= 0)
    return 0
  return Math.min(65_535, Math.trunc(value))
}

/**
 * Writes one content-free Discord voice lifecycle event.
 *
 * The record is a compile-time allowlist: no Discord identifiers, names,
 * provider payloads, URLs, transcripts, or raw Error objects can cross this
 * process-log boundary.
 */
function logVoiceLifecycle(
  logger: Logg,
  level: 'error' | 'log' | 'warn',
  record: VoiceLifecycleLogRecord,
): void {
  const fields: VoiceLifecycleLogRecord = {
    ...(record.activeCount === undefined ? {} : { activeCount: boundedVoiceLogCount(record.activeCount) }),
    ...(record.characterCount === undefined ? {} : { characterCount: boundedVoiceLogCount(record.characterCount) }),
    ...(record.closeCode === undefined ? {} : { closeCode: boundedVoiceLogCount(record.closeCode) }),
    ...(record.elapsedMs === undefined ? {} : { elapsedMs: Math.min(300_000, boundedVoiceLogCount(record.elapsedMs)) }),
    eventCode: record.eventCode,
    ...(record.failureCategory === undefined ? {} : { failureCategory: record.failureCategory }),
    ...(record.mode === undefined ? {} : { mode: record.mode }),
    ...(record.newState === undefined ? {} : { newState: record.newState }),
    ...(record.oldState === undefined ? {} : { oldState: record.oldState }),
    ...(record.phase === undefined ? {} : { phase: record.phase }),
    ...(record.result === undefined ? {} : { result: record.result }),
    ...(record.retryable === undefined ? {} : { retryable: record.retryable }),
    ...(record.scopeCount === undefined ? {} : { scopeCount: boundedVoiceLogCount(record.scopeCount) }),
    ...(record.sessionSequence === undefined ? {} : { sessionSequence: boundedVoiceLogCount(record.sessionSequence) }),
    ...(record.state === undefined ? {} : { state: record.state }),
    ...(record.terminal === undefined ? {} : { terminal: record.terminal }),
    ...(record.turnSequence === undefined ? {} : { turnSequence: boundedVoiceLogCount(record.turnSequence) }),
  }
  const scopedLogger = logger.withFields(fields)
  if (level === 'error') {
    scopedLogger.error('Discord voice lifecycle event')
    return
  }
  if (level === 'warn') {
    scopedLogger.warn('Discord voice lifecycle event')
    return
  }
  scopedLogger.log('Discord voice lifecycle event')
}

/**
 * Normalizes the end-to-end classic voice deadline.
 *
 * Before:
 * - `100`
 * - `900000`
 *
 * After:
 * - `5000`
 * - `300000`
 */
function normalizeClassicVoiceTurnTimeout(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs))
    return DEFAULT_CLASSIC_VOICE_TURN_TIMEOUT_MS

  return Math.min(300_000, Math.max(5_000, Math.trunc(timeoutMs)))
}

function voiceScopeKey(scope: VoicePlaybackScope): string {
  // Discord snowflake ids contain only decimal digits, so colon separators keep
  // guild/channel/generation ownership unambiguous without retaining live objects.
  return `${scope.guildId}:${scope.channelId}:${scope.generation}`
}

function speakerScopeKey(scope: VoicePlaybackScope, userId: string): string {
  // Including the immutable generation prevents late A1 timer/stream callbacks
  // from resolving to replacement A2 state for the same Discord speaker.
  return `${scope.guildId}:${scope.channelId}:${scope.generation}:${userId}`
}

/** Reads the Discord session id owned by one exact @discordjs/voice connection. */
function resolveDiscordVoiceSessionId(state: VoiceConnectionState): string | undefined {
  if (!('networking' in state))
    return undefined

  const networkingState = state.networking.state
  if (!('connectionOptions' in networkingState))
    return undefined

  return networkingState.connectionOptions.sessionId || undefined
}

function isValidTranscription(text: string): boolean {
  if (!text || text.includes('[BLANK_AUDIO]'))
    return false
  return true
}

async function respondToVoiceInteraction(interaction: ChatInputCommandInteraction<CacheType>, content: string) {
  if (interaction.deferred || interaction.replied) {
    await interaction.editReply(content)
    return
  }

  await interaction.reply(content)
}

async function setSelfVoice(logger: Logg, me?: GuildMember | null) {
  if (me?.voice && me.permissions.has('DeafenMembers')) {
    try {
      await me.voice.setDeaf(false)
      await me.voice.setMute(false)
    }
    catch {
      logVoiceLifecycle(logger, 'warn', {
        eventCode: 'self-voice-state-update-failed',
        failureCategory: 'discord-operation',
        retryable: true,
      }) // Continue anyway
    }
  }
}

// eliza/packages/client-discord/src/voice.ts at develop · elizaOS/eliza
// https://github.com/elizaOS/eliza/blob/develop/packages/client-discord/src/voice.ts

export class VoiceManager extends EventEmitter {
  private logger = useLogg('VoiceManager').useGlobalConfig()
  private processingUsers = new Map<string, VoiceUserState>()
  private classicVoiceTurnBoundaries = new Map<string, ClassicVoiceTurnBoundary>()
  private pendingClassicVoiceTurnTasks = new Set<Promise<void>>()
  private transcriptionTimeouts = new Map<string, NodeJS.Timeout>()
  private userStates = new Map<string, VoiceUserState>()

  private activeClassicPlaybacks = new Map<string, ScopedClassicPlayback>()
  private activeRealtimePlaybacks = new Map<string, ScopedRealtimePlayback>()
  private client: DiscordClient
  private handleTranscription: VoiceTranscriptionHandler
  private transcribeAudio: VoiceTranscriber
  private streams: Map<string, Readable> = new Map()
  private connections: Map<string, VoiceConnection> = new Map()
  // Admission into activeMonitors is the parent cap for per-speaker streams,
  // decoder state, deadlines, processing gates, and AbortControllers below.
  private activeMonitors = new Map<string, ScopedVoiceMonitor>()

  // Active generation admission is the parent cap for realtime sessions,
  // Discord connections/listeners, and one scoped playback of each kind.
  private realtimeSessions = new Map<string, ScopedRealtimeSession>()
  private pendingRealtimeConnectTasks = new Set<Promise<void>>()
  private readonly realtimeVoiceCallRuntime: RealtimeVoiceCallRuntime | undefined
  private readonly realtimeVoiceSpeakerAdmissionPolicy: RealtimeVoiceSpeakerAdmissionPolicy | undefined
  private readonly classicVoiceProviderDisclosure: ClassicVoiceProviderDisclosure | undefined
  private readonly classicVoiceTurnTimeoutMs: number
  private readonly voiceDiagnostics: VoiceDiagnosticsObserver | undefined
  private activeVoiceSessionsByGuildId = new Map<string, ActiveVoiceSession>()
  // Consent admission owns both maps one-to-one; clearing either lifecycle uses
  // clearConsentSessionForGuild so identifiers cannot accumulate independently.
  private consentSessionIdByGuildId = new Map<string, string>()
  private consentSessions = new Map<string, VoiceConsentSession>()
  private pendingVoiceJoinTasks = new Set<Promise<void>>()
  // pendingVoiceJoinTasks is the capped parent owner for these per-guild
  // single-flight records; both are removed by the task settlement handler.
  private voiceJoinTaskByGuildId = new Map<string, {
    channelId: string
    consentSessionId?: string
    interaction: ChatInputCommandInteraction<CacheType>
    task: Promise<void>
  }>()

  private nextVoiceGeneration = 0
  private nextVoiceDiagnosticSessionSequence = 0
  private stopTask?: Promise<void>

  // Track event listeners for cleanup
  private connectionListeners: Map<string, {
    connection: VoiceConnection
    stateChange: (oldState: VoiceConnectionState, newState: VoiceConnectionState) => Promise<void>
    error: (error: Error) => void
    scope: VoicePlaybackScope
    speakingStart: (userId: string) => Promise<void>
    speakingEnd: (userId: string) => Promise<void>
  }> = new Map()

  /**
   * Owns Discord voice receive, interruption, transcription, and playback lifecycles.
   *
   * Use when:
   * - Bridge mode forwards STT text to AIRI desktop.
   * - Standalone mode returns a synthesized AIRI reply stream.
   *
   * Expects:
   * - `handleTranscription` preserves Discord user/channel isolation.
   * - `transcribeAudio` accepts one bounded WAV utterance.
   * - `classicVoiceTurnTimeoutMs` bounds decode, STT, chat, TTS, and audio handoff together.
   *
   * Returns:
   * - A manager controlled through `/summon` and Discord voice events.
   */
  constructor(
    client: DiscordClient,
    handleTranscription: VoiceTranscriptionHandler,
    transcribeAudio: VoiceTranscriber,
    realtimeVoiceCallRuntime?: RealtimeVoiceCallRuntime,
    realtimeVoiceSpeakerAdmissionPolicy?: RealtimeVoiceSpeakerAdmissionPolicy,
    classicVoiceProviderDisclosure?: ClassicVoiceProviderDisclosure,
    /** End-to-end classic turn lifetime from speaking admission through audio handoff. @default 180000 */
    classicVoiceTurnTimeoutMs?: number,
    /** Optional local-only observer for bounded, content-free voice lifecycle diagnostics. */
    voiceDiagnostics?: VoiceDiagnosticsObserver,
  ) {
    super()
    this.client = client
    this.handleTranscription = handleTranscription
    this.transcribeAudio = transcribeAudio
    this.realtimeVoiceCallRuntime = realtimeVoiceCallRuntime
    this.realtimeVoiceSpeakerAdmissionPolicy = realtimeVoiceSpeakerAdmissionPolicy
    this.classicVoiceProviderDisclosure = classicVoiceProviderDisclosure
    this.classicVoiceTurnTimeoutMs = normalizeClassicVoiceTurnTimeout(classicVoiceTurnTimeoutMs)
    this.voiceDiagnostics = voiceDiagnostics
  }

  private recordVoiceDiagnostic(
    signal: VoiceDiagnosticEvent,
  ): void {
    const observer = this.voiceDiagnostics
    if (!observer)
      return

    try {
      observer.record(withVoiceDiagnosticRuntime(observer.runtimeSequence, signal))
    }
    catch {
      // Diagnostics must never become part of the voice availability path. The
      // fixed category preserves observability without retaining callback data.
      logVoiceLifecycle(this.logger, 'warn', {
        eventCode: 'diagnostics-observer-rejected',
        failureCategory: 'diagnostics',
        retryable: true,
      })
    }
  }

  private diagnosticSessionFor(scope: VoicePlaybackScope): ActiveVoiceSession | undefined {
    const session = this.activeVoiceSessionsByGuildId.get(scope.guildId)
    return session && voiceScopeKey(session.scope) === voiceScopeKey(scope)
      ? session
      : undefined
  }

  private voiceLogOwner(scope: VoicePlaybackScope, turnSequence?: number): Pick<VoiceLifecycleLogRecord, 'sessionSequence' | 'turnSequence'> {
    const sessionSequence = this.diagnosticSessionFor(scope)?.diagnosticSessionSequence
    return {
      ...(sessionSequence === undefined ? {} : { sessionSequence }),
      ...(turnSequence === undefined ? {} : { turnSequence }),
    }
  }

  private recordMonitorAudio(monitor: ScopedVoiceMonitor): void {
    const session = this.diagnosticSessionFor(monitor.scope)
    if (!monitor.diagnosticTurnSequence || !session)
      return

    this.recordVoiceDiagnostic({
      opusBytes: monitor.opusBytes,
      opusPackets: monitor.opusPackets,
      pcmBytes: monitor.pcmBytes,
      pcmFrames: monitor.pcmFrames,
      sessionSequence: session.diagnosticSessionSequence,
      stage: 'receiver-audio',
      turnSequence: monitor.diagnosticTurnSequence,
    })
  }

  /** Returns the provider mode currently used by `/summon`. */
  getVoiceCallMode() {
    return this.realtimeVoiceCallRuntime?.getMode() ?? 'classic'
  }

  /** Returns whether the selected `/summon` provider has complete credentials. */
  isRealtimeVoiceCallConfigured() {
    return this.getVoiceCallMode() === 'qwen-realtime' && Boolean(this.realtimeVoiceCallRuntime?.isConfigured())
  }

  private joinedVoiceContent(channel: BaseGuildVoiceChannel): string {
    return this.getVoiceCallMode() === 'qwen-realtime'
      ? `Joined: ${channel.name}. Qwen Realtime uses Discord speaking boundaries for low-latency turns; speaking while AIRI replies will interrupt playback.`
      : `Joined: ${channel.name}. Voice from opted-in participants in this channel will be transcribed by the configured STT service, sent to AIRI, and AIRI replies will be synthesized by the configured TTS service until I leave.`
  }

  private discardClassicVoiceTurnInput(state: VoiceUserState): void {
    state.buffers.length = 0
    state.totalLength = 0
    state.transcriptionText = ''
  }

  private beginClassicVoiceTurn(speakerKey: string, state: VoiceUserState): ClassicVoiceTurnBoundary {
    const existing = this.classicVoiceTurnBoundaries.get(speakerKey)
    if (existing?.state === state && !existing.signal.aborted)
      return existing
    if (existing)
      this.cancelClassicVoiceTurn(existing, 'cancelled')

    // Admission owns the audio that arrives after this point. Clearing before a
    // new boundary prevents post-timeout or superseded buffers from being replayed
    // under a renewed deadline.
    this.discardClassicVoiceTurnInput(state)

    const abortController = new AbortController()
    const boundary: ClassicVoiceTurnBoundary = {
      abortController,
      deadlineAt: Date.now() + this.classicVoiceTurnTimeoutMs,
      ownerKey: speakerKey,
      principalKey: state.userId,
      signal: AbortSignal.any([state.abortSignal, abortController.signal]),
      speakerKey,
      state,
    }
    boundary.deadlineTimer = setTimeout(() => {
      this.cancelClassicVoiceTurn(boundary, 'timeout')
    }, this.classicVoiceTurnTimeoutMs)
    this.classicVoiceTurnBoundaries.set(speakerKey, boundary)
    return boundary
  }

  private cancelClassicVoiceTurn(
    boundary: ClassicVoiceTurnBoundary,
    reason: 'cancelled' | 'timeout',
  ): void {
    if (this.classicVoiceTurnBoundaries.get(boundary.speakerKey) !== boundary)
      return

    this.classicVoiceTurnBoundaries.delete(boundary.speakerKey)
    if (boundary.deadlineTimer)
      clearTimeout(boundary.deadlineTimer)
    this.discardClassicVoiceTurnInput(boundary.state)
    if (!boundary.abortController.signal.aborted) {
      boundary.abortController.abort(new SpeechProviderRequestError(
        reason === 'timeout' ? 'timeout' : 'cancelled',
        'transcription',
      ))
    }
    logVoiceLifecycle(this.logger, 'warn', {
      ...this.voiceLogOwner(boundary.state.scope),
      eventCode: 'classic-turn-cancelled',
      failureCategory: reason,
      terminal: true,
    })
  }

  private finishClassicVoiceTurn(boundary: ClassicVoiceTurnBoundary): void {
    if (boundary.deadlineTimer)
      clearTimeout(boundary.deadlineTimer)
    if (this.classicVoiceTurnBoundaries.get(boundary.speakerKey) === boundary)
      this.classicVoiceTurnBoundaries.delete(boundary.speakerKey)
  }

  private isClassicVoiceTurnCurrent(boundary: ClassicVoiceTurnBoundary): boolean {
    return !boundary.signal.aborted
      && boundary.deadlineAt > Date.now()
      && this.classicVoiceTurnBoundaries.get(boundary.speakerKey) === boundary
      && this.userStates.get(boundary.speakerKey) === boundary.state
  }

  private waitForClassicVoiceTurnOperation<T>(
    operation: Promise<T>,
    boundary: ClassicVoiceTurnBoundary,
    phase: 'chat-tts' | 'stt',
    discardLateResult?: (value: T) => void,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false
      const providerPhase = phase === 'stt' ? 'transcription' : 'synthesis'
      const cancellationError = () => {
        if (boundary.deadlineAt <= Date.now())
          return new SpeechProviderRequestError('timeout', providerPhase)

        return boundary.signal.reason instanceof Error
          ? boundary.signal.reason
          : new SpeechProviderRequestError('cancelled', providerPhase)
      }
      const logDiscard = (result: 'rejected' | 'resolved') => {
        logVoiceLifecycle(this.logger, 'warn', {
          ...this.voiceLogOwner(boundary.state.scope),
          eventCode: 'classic-operation-discarded',
          failureCategory: 'cancelled',
          phase,
          result,
          terminal: true,
        })
      }
      const handleAbort = () => {
        if (settled)
          return
        settled = true
        boundary.signal.removeEventListener('abort', handleAbort)
        reject(cancellationError())
      }
      const cleanup = () => boundary.signal.removeEventListener('abort', handleAbort)

      boundary.signal.addEventListener('abort', handleAbort, { once: true })
      if (boundary.signal.aborted)
        handleAbort()

      void operation.then(
        (value) => {
          if (settled || !this.isClassicVoiceTurnCurrent(boundary)) {
            try {
              discardLateResult?.(value)
            }
            catch {
              logVoiceLifecycle(this.logger, 'error', {
                ...this.voiceLogOwner(boundary.state.scope),
                eventCode: 'classic-operation-discard-failed',
                failureCategory: 'cleanup',
                phase,
                terminal: true,
              })
            }
            finally {
              logDiscard('resolved')
            }
            if (!settled) {
              settled = true
              cleanup()
              reject(cancellationError())
            }
            return
          }

          settled = true
          cleanup()
          resolve(value)
        },
        (error: unknown) => {
          if (settled || !this.isClassicVoiceTurnCurrent(boundary)) {
            logDiscard('rejected')
            if (!settled) {
              settled = true
              cleanup()
              reject(cancellationError())
            }
            return
          }

          settled = true
          cleanup()
          reject(error)
        },
      )
    })
  }

  private getCurrentParticipantIds(channel: BaseGuildVoiceChannel): string[] {
    return [...channel.members.values()]
      .filter(member => !member.user.bot)
      .map(member => member.id)
  }

  private createConsentComponents(sessionId: string) {
    return [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`${VOICE_CONSENT_CUSTOM_ID_PREFIX}:opt-in:${sessionId}`)
          .setLabel('Opt in to voice')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`${VOICE_CONSENT_CUSTOM_ID_PREFIX}:withdraw:${sessionId}`)
          .setLabel('Withdraw consent')
          .setStyle(ButtonStyle.Secondary),
      ),
    ]
  }

  private createConsentContent(session: VoiceConsentSession): string {
    const participantIds = this.getCurrentParticipantIds(session.channel)
    const consentedCount = participantIds.filter(userId => session.consentedUserIds.has(userId)).length
    const providerDisclosure = this.getVoiceCallMode() === 'qwen-realtime'
      ? 'Qwen Realtime sends opted-in raw audio to Alibaba Cloud DashScope, including provider-side voice activity detection, and returns generated audio/transcripts.'
      : this.classicVoiceProviderDisclosure
        ? [
            `Classic voice sends opted-in audio to ${this.classicVoiceProviderDisclosure.stt} for speech-to-text.`,
            `The transcript is sent to ${this.classicVoiceProviderDisclosure.model}.`,
            this.classicVoiceProviderDisclosure.tts
              ? `Reply text is sent to ${this.classicVoiceProviderDisclosure.tts} for speech synthesis.`
              : 'AIRI returns the reply as Discord text; this bridge does not send reply text to a TTS provider.',
          ].join(' ')
        : 'Classic voice sends opted-in audio to the configured external STT provider, then sends the transcript through the configured AIRI model path.'

    return [
      `AIRI voice consent for **${session.channel.name}**.`,
      providerDisclosure,
      'Voice turns are isolated to this Discord session and are not synchronized to AIRI cloud chat storage.',
      `Every current participant must opt in before AIRI joins. Consent: ${consentedCount}/${participantIds.length}. You can withdraw at any time.`,
    ].join('\n')
  }

  private parseConsentCustomId(customId: string): { action: VoiceConsentAction, sessionId: string } | undefined {
    const match = /^airi:voice-consent:(opt-in|withdraw):(.+)$/.exec(customId)
    if (!match)
      return undefined

    return {
      action: match[1] as VoiceConsentAction,
      sessionId: match[2],
    }
  }

  private clearConsentSessionForGuild(guildId: string): void {
    const sessionId = this.consentSessionIdByGuildId.get(guildId)
    this.consentSessionIdByGuildId.delete(guildId)
    if (sessionId)
      this.consentSessions.delete(sessionId)
  }

  private isVoiceSessionCurrent(session: ActiveVoiceSession): boolean {
    return !session.abortController.signal.aborted
      && this.activeVoiceSessionsByGuildId.get(session.channel.guild.id) === session
  }

  private invalidateVoiceGeneration(
    scope: VoicePlaybackScope,
    clearConsent: boolean,
    diagnosticReason: VoiceDiagnosticCleanupReason = 'replaced',
  ): void {
    let cleanupFailed = false
    let firstCleanupError: unknown
    const cleanup = (operation: () => void) => {
      try {
        operation()
      }
      catch (error) {
        if (!cleanupFailed) {
          cleanupFailed = true
          firstCleanupError = error
        }
      }
    }
    const scopeKey = voiceScopeKey(scope)
    const activeSession = this.activeVoiceSessionsByGuildId.get(scope.guildId)
    if (activeSession && voiceScopeKey(activeSession.scope) === scopeKey) {
      cleanup(() => this.releaseVoiceSession(activeSession, clearConsent, diagnosticReason))
    }
    else {
      cleanup(() => this.closeRealtimeSession(scope))
      cleanup(() => this.cleanupClassicPlayback(scope))
      for (const monitor of Array.from(this.activeMonitors.values())) {
        if (voiceScopeKey(monitor.scope) !== scopeKey)
          continue
        cleanup(() => this.stopMonitoringMember({
          channelId: monitor.scope.channelId,
          guildId: monitor.scope.guildId,
          userId: monitor.userId,
        }, monitor.scope.generation, monitor.capture, true))
      }
    }

    if (cleanupFailed)
      throw firstCleanupError
  }

  private reconcileBotVoiceStateIdentity(
    activeSession: ActiveVoiceSession,
    oldState: VoiceState,
    newState: VoiceState,
  ): boolean {
    const pendingResetCount = activeSession.pendingDiscordVoiceStateResetCount ?? 0
    if (pendingResetCount > 0) {
      const oldVoiceSessionId = oldState.sessionId ?? undefined
      if (
        newState.channelId === activeSession.channel.id
        && newState.sessionId
      ) {
        // A reset and replacement join may remain as separate gateway packets
        // even when an intermediate connection identity is coalesced away. Keep
        // the replacement candidate until this exact VoiceConnection proves it.
        activeSession.pendingDiscordVoiceSessionId = newState.sessionId
      }
      const leavesKnownCurrentSession = oldState.channelId === activeSession.channel.id
        && oldVoiceSessionId !== undefined
        && oldVoiceSessionId === activeSession.discordVoiceSessionId
        && newState.channelId !== activeSession.channel.id
      if (!leavesKnownCurrentSession) {
        // Discord can coalesce an old connection reset and its replacement join
        // into either a channel move or a same-channel session-id change. Count
        // that immutable identity boundary exactly once; waiting only for a null
        // channel would later consume the replacement session's real leave.
        const replacesVoiceIdentity = oldState.channelId !== null
          && (
            oldState.channelId !== newState.channelId
            || (
              newState.channelId !== null
              && oldVoiceSessionId !== undefined
              && newState.sessionId !== null
              && oldVoiceSessionId !== newState.sessionId
            )
          )
        if (replacesVoiceIdentity) {
          activeSession.pendingDiscordVoiceSessionId = newState.sessionId ?? undefined
          const connectionSessionId = resolveDiscordVoiceSessionId(activeSession.connection.state)
          const remainingResetCount = connectionSessionId === newState.sessionId
            ? 0
            : pendingResetCount - 1
          activeSession.pendingDiscordVoiceStateResetCount = remainingResetCount
          if (
            remainingResetCount === 0
            && newState.channelId === activeSession.channel.id
            && newState.sessionId
            && (!connectionSessionId || connectionSessionId === newState.sessionId)
          ) {
            activeSession.discordVoiceSessionId = newState.sessionId
            activeSession.pendingDiscordVoiceSessionId = undefined
          }
        }
        return false
      }
    }

    const connectionSessionId = resolveDiscordVoiceSessionId(activeSession.connection.state)
    if (
      newState.channelId === activeSession.channel.id
      && newState.sessionId
      && (
        connectionSessionId === newState.sessionId
        || (
          !connectionSessionId
          && (
            !activeSession.discordVoiceSessionId
            || activeSession.discordVoiceSessionId === newState.sessionId
          )
        )
      )
    ) {
      activeSession.discordVoiceSessionId = newState.sessionId
    }
    return true
  }

  private isParticipantVoiceIdentityReplacement(oldState: VoiceState, newState: VoiceState): boolean {
    return oldState.channelId !== null
      && oldState.channelId === newState.channelId
      && oldState.sessionId !== null
      && newState.sessionId !== null
      && oldState.sessionId !== newState.sessionId
  }

  private isCurrentParticipantVoiceState(
    oldState: VoiceState,
    newState: VoiceState,
    channelId: string,
  ): boolean {
    const cachedVoiceState = oldState.guild.voiceStates?.cache.get(oldState.id)
    const activeSession = this.activeVoiceSessionsByGuildId.get(oldState.guild.id)
    const consentSessionId = this.consentSessionIdByGuildId.get(oldState.guild.id)
    const consentSession = consentSessionId ? this.consentSessions.get(consentSessionId) : undefined
    const consentedVoiceSessionId = consentSession?.participantVoiceSessionIds.get(oldState.id)
    const monitor = [...this.activeMonitors.values()].find((candidate) => {
      return candidate.scope.channelId === channelId
        && candidate.scope.guildId === oldState.guild.id
        && candidate.userId === oldState.id
        && (!activeSession || voiceScopeKey(candidate.scope) === voiceScopeKey(activeSession.scope))
    })
    if (this.isParticipantVoiceIdentityReplacement(oldState, newState)) {
      if (consentedVoiceSessionId)
        return consentedVoiceSessionId === oldState.sessionId
      if (cachedVoiceState) {
        if (cachedVoiceState.channelId !== channelId)
          return false
        if (cachedVoiceState.sessionId)
          return cachedVoiceState.sessionId === newState.sessionId
      }
      if (
        monitor?.discordVoiceSessionId
        && monitor.discordVoiceSessionId !== oldState.sessionId
        && monitor.discordVoiceSessionId !== newState.sessionId
      ) {
        return false
      }
      return true
    }

    const oldVoiceSessionId = oldState.sessionId ?? undefined
    if (!oldVoiceSessionId) {
      // A partial old state cannot identify its generation. If the authoritative
      // guild cache still proves this user owns a current identity in the target
      // channel, the callback is stale and must not revoke that replacement.
      return cachedVoiceState?.channelId !== channelId
    }

    if (monitor?.discordVoiceSessionId)
      return monitor.discordVoiceSessionId === oldVoiceSessionId

    if (
      cachedVoiceState?.channelId === channelId
      && cachedVoiceState.sessionId
      && cachedVoiceState.sessionId !== oldVoiceSessionId
    ) {
      return false
    }
    return true
  }

  private withdrawParticipantConsent(session: VoiceConsentSession, userId: string): void {
    session.consentedUserIds.delete(userId)
    session.participantVoiceSessionIds.delete(userId)
    session.state = 'pending'
    const activeSession = this.activeVoiceSessionsByGuildId.get(session.channel.guild.id)
    const matchingSession = activeSession?.consentSessionId === session.id
      && activeSession.channel.id === session.channel.id
      ? activeSession
      : undefined
    const fallbackScope = [...this.activeMonitors.values()].find((monitor) => {
      return monitor.scope.channelId === session.channel.id
        && monitor.scope.guildId === session.channel.guild.id
    })?.scope
    const scope = matchingSession?.scope ?? fallbackScope
    if (!scope)
      return

    try {
      // The provider buffer is channel-scoped, so individual PCM cannot be
      // erased after it was sent. Explicit withdrawal invalidates only this
      // consent session's current channel generation.
      this.invalidateVoiceGeneration(scope, false)
    }
    catch (error) {
      logVoiceLifecycle(this.logger, 'error', {
        ...this.voiceLogOwner(scope),
        eventCode: 'withdrawal-cleanup-failed',
        failureCategory: 'cleanup',
        terminal: true,
      })
      throw error
    }
  }

  /**
   * Applies a trusted consent withdrawal synchronously when async interaction capacity is exhausted.
   *
   * Use when:
   * - The adapter cannot retain another InteractionCreate task.
   * - A withdrawal must revoke capture before any best-effort Discord response.
   *
   * Expects:
   * - The interaction came from the current Discord client and still matches the exact consent session/channel/user.
   *
   * Returns:
   * - Whether a current withdrawal was applied; opt-in and stale/forged interactions fail closed without mutation.
   */
  abortConsentWithdrawalAtCapacity(interaction: ButtonInteraction<CacheType>): boolean {
    const parsed = this.parseConsentCustomId(interaction.customId)
    if (!parsed || parsed.action !== 'withdraw')
      return false

    const session = this.consentSessions.get(parsed.sessionId)
    if (
      !session
      || interaction.guildId !== session.channel.guild.id
      || !session.consentedUserIds.has(interaction.user.id)
    ) {
      return false
    }

    this.withdrawParticipantConsent(session, interaction.user.id)
    return true
  }

  /**
   * Aborts the exact voice generation affected by a move/leave that cannot enter the async lifecycle pool.
   *
   * Use when:
   * - The adapter's bounded VoiceStateUpdate owner pool is full.
   *
   * Expects:
   * - Old and new states came from the current Discord client.
   *
   * Returns:
   * - Whether active capture, consent, or the bot's exact voice session was invalidated synchronously.
   */
  abortVoiceStateUpdateAtCapacity(oldState: VoiceState, newState: VoiceState): boolean {
    const guildId = oldState.guild.id
    const activeSession = this.activeVoiceSessionsByGuildId.get(guildId)
    if (oldState.id === this.client.user?.id && activeSession) {
      if (!this.reconcileBotVoiceStateIdentity(activeSession, oldState, newState))
        return false
      if (oldState.channelId === newState.channelId || activeSession.channel.id !== oldState.channelId)
        return false

      const oldVoiceSessionId = oldState.sessionId ?? undefined
      if (!oldVoiceSessionId || oldVoiceSessionId !== activeSession.discordVoiceSessionId)
        return false

      this.invalidateVoiceGeneration(activeSession.scope, true)
      return true
    }

    const participantVoiceIdentityChanged = this.isParticipantVoiceIdentityReplacement(oldState, newState)
    if (oldState.channelId === newState.channelId && !participantVoiceIdentityChanged)
      return false

    const consentSessionId = this.consentSessionIdByGuildId.get(guildId)
    const consentSession = consentSessionId ? this.consentSessions.get(consentSessionId) : undefined
    if (consentSession && oldState.channelId === consentSession.channel.id) {
      if (!this.isCurrentParticipantVoiceState(oldState, newState, consentSession.channel.id))
        return false
      this.withdrawParticipantConsent(consentSession, oldState.id)
      return true
    }

    const monitor = [...this.activeMonitors.values()].find((candidate) => {
      return candidate.scope.channelId === oldState.channelId
        && candidate.scope.guildId === guildId
        && candidate.userId === oldState.id
    })
    if (!monitor)
      return false
    if (!this.isCurrentParticipantVoiceState(oldState, newState, monitor.scope.channelId))
      return false

    this.invalidateVoiceGeneration(monitor.scope, false)
    return true
  }

  /**
   * Disconnects one exact guild voice owner when a privileged dismiss interaction cannot be queued.
   *
   * Use when:
   * - The adapter has already authenticated `/dismiss` but its bounded interaction pool is full.
   *
   * Expects:
   * - `guildId` is the authenticated interaction guild.
   *
   * Returns:
   * - Whether an active or pending voice-consent owner was cleared synchronously.
   */
  disconnectGuildVoiceAtCapacity(guildId: string): boolean {
    const activeSession = this.activeVoiceSessionsByGuildId.get(guildId)
    if (activeSession) {
      this.invalidateVoiceGeneration(activeSession.scope, true)
      return true
    }
    if (!this.consentSessionIdByGuildId.has(guildId))
      return false

    this.clearConsentSessionForGuild(guildId)
    return true
  }

  private isSpeakerAllowed(
    input: RealtimeVoiceSpeakerInput,
    activeSession?: ActiveVoiceSession,
    discordVoiceSessionId?: string,
  ): boolean {
    if (activeSession?.consentSessionId) {
      const consentSession = this.consentSessions.get(activeSession.consentSessionId)
      if (
        !consentSession
        || consentSession.channel.id !== input.channelId
        || consentSession.channel.guild.id !== input.guildId
        || consentSession.state === 'pending'
        || !consentSession.consentedUserIds.has(input.userId)
        || !discordVoiceSessionId
        || consentSession.participantVoiceSessionIds.get(input.userId) !== discordVoiceSessionId
      ) {
        return false
      }
    }

    return this.realtimeVoiceSpeakerAdmissionPolicy?.allows(input) ?? true
  }

  private admitSpeaker(input: RealtimeVoiceSpeakerInput): boolean {
    return this.realtimeVoiceSpeakerAdmissionPolicy?.admit(input) ?? true
  }

  /**
   * Stops existing capture streams whose current guild/channel/user policy was revoked.
   *
   * Use when:
   * - A parent process applies a new Discord allowlist while voice is connected.
   * - Runtime policy must take effect before another buffered/provider audio chunk.
   *
   * Expects:
   * - The admission policy's `allows` check does not consume rate quota.
   *
   * Returns:
   * - Nothing; disallowed receive streams are synchronously destroyed.
   */
  revalidateSpeakerAdmissions(): void {
    const invalidScopes = new Map<string, VoicePlaybackScope>()
    for (const monitor of this.activeMonitors.values()) {
      const activeSession = this.activeVoiceSessionsByGuildId.get(monitor.scope.guildId)
      if (this.isSpeakerAllowed({
        channelId: monitor.scope.channelId,
        guildId: monitor.scope.guildId,
        userId: monitor.userId,
      }, activeSession, monitor.discordVoiceSessionId)) {
        continue
      }

      invalidScopes.set(voiceScopeKey(monitor.scope), monitor.scope)
    }

    let cleanupFailed = false
    let firstCleanupError: unknown
    for (const scope of invalidScopes.values()) {
      try {
        // Qwen owns one aggregate input buffer per channel generation. Once a
        // speaker is revoked, closing that exact generation is the only way to
        // prove their already-forwarded PCM cannot be committed later.
        this.invalidateVoiceGeneration(scope, true)
      }
      catch (error) {
        if (!cleanupFailed) {
          cleanupFailed = true
          firstCleanupError = error
        }
      }
    }

    if (cleanupFailed)
      throw firstCleanupError
  }

  private async refreshConsentMessage(session: VoiceConsentSession): Promise<void> {
    try {
      await session.interaction.editReply({
        allowedMentions: { parse: [] },
        components: this.createConsentComponents(session.id),
        content: this.createConsentContent(session),
      })
    }
    catch {
      logVoiceLifecycle(this.logger, 'warn', {
        eventCode: 'consent-message-refresh-failed',
        failureCategory: 'discord-operation',
        retryable: true,
      })
    }
  }

  /**
   * Revokes participant consent and capture when Discord reports a channel move.
   *
   * Use when:
   * - An adapter receives `VoiceStateUpdate` for a participant or this bot.
   *
   * Expects:
   * - Old and new states came from the current Discord client cache.
   *
   * Returns:
   * - A promise that settles after the public consent count is refreshed.
   */
  async handleVoiceStateUpdate(oldState: VoiceState, newState: VoiceState): Promise<void> {
    const guildId = oldState.guild.id
    const activeSession = this.activeVoiceSessionsByGuildId.get(guildId)
    const isBotVoiceState = oldState.id === this.client.user?.id
    if (isBotVoiceState && activeSession && !this.reconcileBotVoiceStateIdentity(activeSession, oldState, newState))
      return

    const participantVoiceIdentityChanged = !isBotVoiceState
      && this.isParticipantVoiceIdentityReplacement(oldState, newState)
    if (oldState.channelId === newState.channelId && !participantVoiceIdentityChanged)
      return

    if (
      isBotVoiceState
      && activeSession
      && activeSession.channel.id === oldState.channelId
    ) {
      const oldVoiceSessionId = oldState.sessionId ?? undefined
      if (!oldVoiceSessionId || oldVoiceSessionId !== activeSession.discordVoiceSessionId)
        return

      this.disconnectChannel(activeSession.channel.id, activeSession.connection, true, 'disconnected')
      return
    }

    const consentSessionId = this.consentSessionIdByGuildId.get(guildId)
    const consentSession = consentSessionId ? this.consentSessions.get(consentSessionId) : undefined
    if (!consentSession)
      return

    if (oldState.channelId === consentSession.channel.id) {
      if (!this.isCurrentParticipantVoiceState(oldState, newState, consentSession.channel.id))
        return
      const speakerMonitors = [...this.activeMonitors.values()].filter((monitor) => {
        return monitor.scope.channelId === consentSession.channel.id
          && monitor.scope.guildId === guildId
          && monitor.userId === oldState.id
      })
      if (newState.channelId === null) {
        // A normal participant leave is also a legitimate Discord speaking-end
        // boundary. Commit admitted PCM before removing consent, then release
        // only that capture. A concurrent speaker in the channel remains owned.
        for (const monitor of speakerMonitors) {
          if (monitor.admitted) {
            try {
              await this.handleAudioReceiveStreamEnd(
                consentSession.channel,
                activeSession ? monitor.scope : undefined,
              )(oldState.id)
            }
            catch {
              logVoiceLifecycle(this.logger, 'error', {
                ...this.voiceLogOwner(monitor.scope, monitor.diagnosticTurnSequence),
                eventCode: 'input-finalize-failed',
                failureCategory: 'provider',
                terminal: true,
              })
              try {
                this.invalidateVoiceGeneration(monitor.scope, false)
              }
              catch {
                logVoiceLifecycle(this.logger, 'error', {
                  ...this.voiceLogOwner(monitor.scope, monitor.diagnosticTurnSequence),
                  eventCode: 'input-generation-cleanup-failed',
                  failureCategory: 'cleanup',
                  terminal: true,
                })
              }
              break
            }
          }
        }
        consentSession.consentedUserIds.delete(oldState.id)
        consentSession.participantVoiceSessionIds.delete(oldState.id)
        for (const monitor of speakerMonitors) {
          try {
            this.stopMonitoringMember({
              channelId: monitor.scope.channelId,
              guildId: monitor.scope.guildId,
              userId: oldState.id,
            }, monitor.scope.generation, monitor.capture)
          }
          catch {
            logVoiceLifecycle(this.logger, 'error', {
              ...this.voiceLogOwner(monitor.scope, monitor.diagnosticTurnSequence),
              eventCode: 'receiver-stream-cleanup-failed',
              failureCategory: 'cleanup',
              terminal: true,
            })
          }
        }
      }
      else {
        consentSession.consentedUserIds.delete(oldState.id)
        consentSession.participantVoiceSessionIds.delete(oldState.id)
        consentSession.state = 'pending'
        const matchingSession = activeSession?.channel.id === consentSession.channel.id
          ? activeSession
          : undefined
        const scope = matchingSession?.scope ?? speakerMonitors[0]?.scope
        if (scope) {
          try {
            // A move is an explicit channel ownership change, not a trailing
            // speaking-end. Fail closed so old aggregate provider input cannot
            // survive into the replacement channel lifecycle.
            this.invalidateVoiceGeneration(scope, false)
          }
          catch {
            logVoiceLifecycle(this.logger, 'error', {
              ...this.voiceLogOwner(scope),
              eventCode: 'withdrawal-cleanup-failed',
              failureCategory: 'cleanup',
              terminal: true,
            })
          }
        }
      }
    }

    if (oldState.channelId === consentSession.channel.id || newState.channelId === consentSession.channel.id)
      await this.refreshConsentMessage(consentSession)
  }

  /**
   * Applies one public participant opt-in or withdrawal interaction.
   *
   * Use when:
   * - An adapter receives a button interaction created by `/summon`.
   *
   * Expects:
   * - Opt-in clickers are still present in the exact target voice channel.
   * - Withdrawal clickers already own consent in the exact session and guild.
   *
   * Returns:
   * - A public consent-state update and starts capture only after unanimous current opt-in.
   */
  async handleConsentInteraction(interaction: ButtonInteraction<CacheType>): Promise<void> {
    const parsed = this.parseConsentCustomId(interaction.customId)
    if (!parsed)
      return

    const session = this.consentSessions.get(parsed.sessionId)
    if (
      !session
      || interaction.guildId !== session.channel.guild.id
    ) {
      await interaction.reply({
        allowedMentions: { parse: [] },
        content: 'This voice consent request is no longer active for your current channel.',
        ephemeral: true,
      })
      return
    }

    const userId = interaction.user.id
    if (parsed.action === 'withdraw') {
      if (!session.consentedUserIds.has(userId)) {
        await interaction.reply({
          allowedMentions: { parse: [] },
          content: 'This voice consent request is no longer active for your current channel.',
          ephemeral: true,
        })
        return
      }
      this.withdrawParticipantConsent(session, userId)
      await interaction.update({
        allowedMentions: { parse: [] },
        components: this.createConsentComponents(session.id),
        content: this.createConsentContent(session),
      })
      return
    }

    const participantIds = this.getCurrentParticipantIds(session.channel)
    if (
      !interaction.inCachedGuild()
      || interaction.member.voice.channelId !== session.channel.id
      || !interaction.member.voice.sessionId
      || !participantIds.includes(userId)
    ) {
      await interaction.reply({
        allowedMentions: { parse: [] },
        content: 'This voice consent request is no longer active for your current channel.',
        ephemeral: true,
      })
      return
    }

    session.consentedUserIds.add(userId)
    session.participantVoiceSessionIds.set(userId, interaction.member.voice.sessionId)
    const ready = participantIds.length > 0
      && participantIds.every(participantId => session.consentedUserIds.has(participantId))
    if (!ready || session.state !== 'pending') {
      await interaction.update({
        allowedMentions: { parse: [] },
        components: this.createConsentComponents(session.id),
        content: this.createConsentContent(session),
      })
      return
    }

    session.state = 'activating'
    await interaction.update({
      allowedMentions: { parse: [] },
      components: this.createConsentComponents(session.id),
      content: `${this.createConsentContent(session)}\n\nAll current participants opted in. AIRI is connecting now.`,
    })

    const participantsBeforeJoin = this.getCurrentParticipantIds(session.channel)
    if (
      participantsBeforeJoin.length === 0
      || !participantsBeforeJoin.every(participantId => session.consentedUserIds.has(participantId))
    ) {
      session.state = 'pending'
      await this.refreshConsentMessage(session)
      return
    }

    try {
      await this.joinChannel(session.interaction, session.channel, {
        announce: false,
        consentSessionId: session.id,
      })
      session.state = 'active'
      await this.refreshConsentMessage(session)
    }
    catch {
      session.state = 'pending'
      logVoiceLifecycle(this.logger, 'error', {
        eventCode: 'consent-session-connect-failed',
        failureCategory: 'connection',
        terminal: true,
      })
      await interaction.followUp({
        content: 'AIRI could not establish the consented voice connection.',
        ephemeral: true,
      })
    }
  }

  private releaseVoiceSession(
    session: ActiveVoiceSession,
    clearConsent: boolean,
    diagnosticReason: VoiceDiagnosticCleanupReason = 'replaced',
  ): void {
    let cleanupFailed = false
    let firstCleanupError: unknown
    const cleanup = (operation: () => void) => {
      try {
        operation()
      }
      catch (error) {
        if (!cleanupFailed) {
          cleanupFailed = true
          firstCleanupError = error
        }
      }
    }

    if (this.activeVoiceSessionsByGuildId.get(session.channel.guild.id) === session)
      this.activeVoiceSessionsByGuildId.delete(session.channel.guild.id)

    if (!session.abortController.signal.aborted)
      cleanup(() => session.abortController.abort(new Error('Discord voice channel generation invalidated.')))

    const scopeKey = voiceScopeKey(session.scope)
    const listeners = this.connectionListeners.get(scopeKey)
    if (listeners) {
      cleanup(() => session.connection.off('stateChange', listeners.stateChange))
      cleanup(() => session.connection.off('error', listeners.error))
      cleanup(() => session.connection.receiver.speaking.off('start', listeners.speakingStart))
      cleanup(() => session.connection.receiver.speaking.off('end', listeners.speakingEnd))
      this.connectionListeners.delete(scopeKey)
    }

    for (const monitor of this.activeMonitors.values()) {
      if (voiceScopeKey(monitor.scope) !== scopeKey)
        continue

      cleanup(() => this.stopMonitoringMember({
        channelId: monitor.scope.channelId,
        guildId: monitor.scope.guildId,
        userId: monitor.userId,
      }, session.scope.generation, undefined, false, true))
    }

    cleanup(() => this.closeRealtimeSession(session.scope))
    cleanup(() => this.cleanupClassicPlayback(session.scope))
    if (this.connections.get(session.channel.id) === session.connection)
      this.connections.delete(session.channel.id)
    if (session.connection.state.status !== VoiceConnectionStatus.Destroyed)
      cleanup(() => session.connection.destroy())

    if (clearConsent)
      cleanup(() => this.clearConsentSessionForGuild(session.channel.guild.id))

    if (cleanupFailed) {
      if (!session.diagnosticCleaned) {
        session.diagnosticCleaned = true
        this.recordVoiceDiagnostic({
          cleanupReason: 'failed',
          sessionSequence: session.diagnosticSessionSequence,
          stage: 'session-cleaned',
        })
      }
      throw firstCleanupError
    }

    if (!session.diagnosticCleaned) {
      session.diagnosticCleaned = true
      this.recordVoiceDiagnostic({
        cleanupReason: diagnosticReason,
        sessionSequence: session.diagnosticSessionSequence,
        stage: 'session-cleaned',
      })
    }
  }

  handleVoiceConnectionStateChange(channel: BaseGuildVoiceChannel, connection: VoiceConnection, session?: ActiveVoiceSession): (oldState: VoiceConnectionState, newState: VoiceConnectionState) => Promise<void> {
    return async (oldState, newState) => {
      logVoiceLifecycle(this.logger, 'log', {
        ...(session ? { sessionSequence: session.diagnosticSessionSequence } : {}),
        eventCode: 'connection-state-change',
        newState: newState.status,
        oldState: oldState.status,
      })

      const connectionSessionId = resolveDiscordVoiceSessionId(newState)
      if (
        session
        && this.isVoiceSessionCurrent(session)
        && newState.status === VoiceConnectionStatus.Ready
      ) {
        this.recordVoiceDiagnostic({
          sessionSequence: session.diagnosticSessionSequence,
          stage: 'transport-ready',
        })
      }
      if (
        session
        && this.isVoiceSessionCurrent(session)
        && connectionSessionId
      ) {
        const pendingResetCount = session.pendingDiscordVoiceStateResetCount ?? 0
        if (pendingResetCount === 0) {
          session.discordVoiceSessionId = connectionSessionId
        }
        else if (session.pendingDiscordVoiceSessionId === connectionSessionId) {
          session.pendingDiscordVoiceStateResetCount = 0
          session.pendingDiscordVoiceSessionId = undefined
          session.discordVoiceSessionId = connectionSessionId
        }
      }

      if (newState.status === VoiceConnectionStatus.Destroyed) {
        if (session && this.activeVoiceSessionsByGuildId.get(channel.guild.id) === session) {
          this.releaseVoiceSession(session, true, 'disconnected')
        }
        else if (this.connections.get(channel.id) === connection) {
          this.connections.delete(channel.id)
          if (session)
            this.closeRealtimeSession(session.scope)
        }
      }
      else if (
        (!session || this.isVoiceSessionCurrent(session))
        && !this.connections.has(channel.id)
        && (newState.status === VoiceConnectionStatus.Ready || newState.status === VoiceConnectionStatus.Signalling)
      ) {
        this.connections.set(channel.id, connection)
      }
      else if (newState.status === VoiceConnectionStatus.Disconnected) {
        logVoiceLifecycle(this.logger, 'warn', {
          ...(session ? { sessionSequence: session.diagnosticSessionSequence } : {}),
          eventCode: 'connection-disconnected',
          failureCategory: 'connection',
          retryable: true,
        })

        try {
        // Try to reconnect if disconnected
          await Promise.race([
            entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
            entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
          ])
          // Seems to be reconnecting to a new channel
          logVoiceLifecycle(this.logger, 'log', {
            ...(session ? { sessionSequence: session.diagnosticSessionSequence } : {}),
            eventCode: 'connection-reconnecting',
            retryable: true,
          })
        }
        catch {
        // Seems to be a real disconnect, destroy and cleanup
          logVoiceLifecycle(this.logger, 'warn', {
            ...(session ? { sessionSequence: session.diagnosticSessionSequence } : {}),
            eventCode: 'connection-disconnect-confirmed',
            failureCategory: 'connection',
            terminal: true,
          })
          if (session) {
            if (this.activeVoiceSessionsByGuildId.get(channel.guild.id) === session)
              this.releaseVoiceSession(session, true, 'disconnected')
            else
              this.closeRealtimeSession(session.scope)
          }
          else if (this.connections.get(channel.id) === connection) {
            connection.destroy()
            this.connections.delete(channel.id)
          }
        }
      }
    }
  }

  handleVoiceConnectionError(_error: unknown, session?: ActiveVoiceSession) {
    logVoiceLifecycle(this.logger, 'warn', {
      ...(session ? { sessionSequence: session.diagnosticSessionSequence } : {}),
      eventCode: 'connection-error',
      failureCategory: 'connection',
      retryable: true,
    })
    if (session) {
      this.recordVoiceDiagnostic({
        failureCategory: 'connection-error',
        sessionSequence: session.diagnosticSessionSequence,
        stage: 'failure',
        turnSequence: session.currentDiagnosticTurnSequence,
      })
    }
    // Don't immediately destroy - let the state change handler deal with it
  }

  /**
   * Creates a Discord speaking-start callback bound to one voice generation.
   *
   * Use when:
   * - Registering receiver listeners for a newly joined Discord voice channel.
   * - Tests exercise the generation-zero connection lookup path.
   *
   * Expects:
   * - `expectedScope`, when provided, belongs to the listener's connection.
   *
   * Returns:
   * - An async callback that admits and starts only the matching speaker capture.
   */
  handleAudioReceiveStreamStart(channel: BaseGuildVoiceChannel, expectedScope?: VoicePlaybackScope): (userId: string) => Promise<void> {
    return async (userId) => {
      let user = channel.members.get(userId)
      if (!user) {
        try {
          user = await channel.guild.members.fetch(userId)
        }
        catch {
          logVoiceLifecycle(this.logger, 'warn', {
            eventCode: 'member-fetch-failed',
            failureCategory: 'discord-operation',
            retryable: true,
          })
        }
      }
      if (user && !user?.user.bot) {
        const guildId = user.guild.id
        const activeSession = this.activeVoiceSessionsByGuildId.get(guildId)
        if (
          expectedScope
          && (!activeSession || voiceScopeKey(activeSession.scope) !== voiceScopeKey(expectedScope))
        ) {
          return
        }
        const scope = expectedScope ?? activeSession?.scope ?? { channelId: channel.id, generation: 0, guildId }
        logVoiceLifecycle(this.logger, 'log', {
          ...this.voiceLogOwner(scope),
          eventCode: 'participant-input-started',
        })
        const admissionInput = { channelId: channel.id, guildId, userId }
        const speakerKey = speakerScopeKey(scope, userId)
        const activeMonitor = this.activeMonitors.get(speakerKey)
        if (!this.isSpeakerAllowed(admissionInput, activeSession, user.voice?.sessionId ?? undefined)) {
          if (activeMonitor) {
            this.stopMonitoringMember(admissionInput, activeMonitor.scope.generation, activeMonitor.capture, true)
          }
          logVoiceLifecycle(this.logger, 'warn', {
            ...this.voiceLogOwner(scope, activeMonitor?.diagnosticTurnSequence),
            eventCode: 'participant-policy-rejected',
            failureCategory: 'policy',
            terminal: true,
          })
          return
        }
        if (activeMonitor?.admitted)
          return

        const scopeKey = voiceScopeKey(scope)
        const scopeMonitorCount = [...this.activeMonitors.values()].filter((monitor) => {
          return voiceScopeKey(monitor.scope) === scopeKey
        }).length
        if (
          !activeMonitor
          && (
            this.activeMonitors.size >= MAX_ACTIVE_VOICE_MONITORS
            || scopeMonitorCount >= MAX_ACTIVE_VOICE_MONITORS_PER_SCOPE
          )
        ) {
          logVoiceLifecycle(this.logger, 'warn', {
            ...this.voiceLogOwner(scope),
            activeCount: this.activeMonitors.size,
            eventCode: 'monitor-capacity-rejected',
            failureCategory: 'capacity',
            scopeCount: scopeMonitorCount,
            terminal: true,
          })
          return
        }

        if (!this.admitSpeaker(admissionInput)) {
          if (activeMonitor)
            this.stopMonitoringMember(admissionInput, activeMonitor.scope.generation, activeMonitor.capture, true)
          logVoiceLifecycle(this.logger, 'warn', {
            ...this.voiceLogOwner(scope, activeMonitor?.diagnosticTurnSequence),
            eventCode: 'participant-policy-rejected',
            failureCategory: 'policy',
            terminal: true,
          })
          return
        }

        if (activeSession) {
          // Every speaking boundary owns a capture sequence, including
          // concurrent speakers sharing Qwen's later provider aggregate.
          activeSession.currentDiagnosticTurnSequence = ++activeSession.nextDiagnosticTurnSequence

          // Discord receive subscriptions use Manual end behavior by default.
          // A single live stream can therefore span several speaking turns;
          // move its diagnostic and provider ownership before accepting PCM
          // for the next boundary rather than subscribing a duplicate listener.
          if (activeMonitor && activeMonitor.scope.generation === scope.generation) {
            const realtimeSession = this.realtimeSessions.get(scopeKey)
            // Public consent sessions expose capture-level diagnostics. Internal
            // sessions without a consent owner retain aggregate diagnostics so
            // their provider audit lifecycle remains one coherent input turn.
            activeMonitor.diagnosticTurnSequence = activeSession.consentSessionId
              ? activeSession.currentDiagnosticTurnSequence
              : realtimeSession?.activeProviderInputTurnSequence
                ?? activeSession.currentDiagnosticTurnSequence
            activeMonitor.finishing = false
            activeMonitor.opusBytes = 0
            activeMonitor.opusPackets = 0
            activeMonitor.pcmBytes = 0
            activeMonitor.pcmFrames = 0
          }
        }

        void this.monitorMember(user as GuildMember, channel.id, expectedScope).catch(() => {
          logVoiceLifecycle(this.logger, 'error', {
            ...this.voiceLogOwner(scope, activeSession?.currentDiagnosticTurnSequence),
            eventCode: 'monitor-stream-failed',
            failureCategory: 'receiver',
            terminal: true,
          })
        })
        const admittedMonitor = this.activeMonitors.get(speakerKey)
        if (admittedMonitor) {
          admittedMonitor.finishing = false
          admittedMonitor.admitted = true
          const state = this.userStates.get(speakerKey)
          if (state && this.getVoiceCallMode() === 'classic')
            this.beginClassicVoiceTurn(speakerKey, state)
          if (admittedMonitor.diagnosticTurnSequence && activeSession) {
            const realtimeSession = this.realtimeSessions.get(voiceScopeKey(admittedMonitor.scope))
            if (realtimeSession)
              realtimeSession.activeCaptureTurnSequence = admittedMonitor.diagnosticTurnSequence
            this.recordVoiceDiagnostic({
              sessionSequence: activeSession.diagnosticSessionSequence,
              stage: 'speaking-started',
              turnSequence: admittedMonitor.diagnosticTurnSequence,
            })
          }
        }
        this.streams.get(speakerKey)?.emit('speakingStarted')
      }
    }
  }

  /**
   * Creates a Discord speaking-end callback bound to one voice generation.
   *
   * Use when:
   * - Registering receiver listeners for a newly joined Discord voice channel.
   * - Finalizing one admitted realtime speaker turn.
   *
   * Expects:
   * - `expectedScope`, when provided, belongs to the listener's connection.
   *
   * Returns:
   * - An async callback that finalizes only the matching speaker capture.
   */
  handleAudioReceiveStreamEnd(channel: BaseGuildVoiceChannel, expectedScope?: VoicePlaybackScope): (userId: string) => Promise<void> {
    return async (userId: string) => {
      const activeSession = this.activeVoiceSessionsByGuildId.get(channel.guild.id)
      if (
        expectedScope
        && (!activeSession || voiceScopeKey(activeSession.scope) !== voiceScopeKey(expectedScope))
      ) {
        return
      }
      const scope = expectedScope ?? activeSession?.scope ?? {
        channelId: channel.id,
        generation: 0,
        guildId: channel.guild.id,
      }
      const speakerInput = { channelId: channel.id, guildId: channel.guild.id, userId }
      const speakerKey = speakerScopeKey(scope, userId)
      const activeMonitor = this.activeMonitors.get(speakerKey)
      if (!activeMonitor?.admitted)
        return

      if (!this.isSpeakerAllowed(speakerInput, activeSession, activeMonitor.discordVoiceSessionId)) {
        // Qwen input is aggregated by channel generation. A policy change can
        // invalidate already-forwarded PCM, so revoke the exact generation
        // instead of trying to erase only one speaker from the provider buffer.
        this.invalidateVoiceGeneration(activeMonitor.scope, false)
        return
      }

      // The monitor is the immutable admission record captured at speaking begin.
      // Discord may remove the live GuildMember before delivering speaking end,
      // so finalization must never depend on a second cache lookup.
      activeMonitor.admitted = false
      activeMonitor.finishing = true
      logVoiceLifecycle(this.logger, 'log', {
        ...this.voiceLogOwner(activeMonitor.scope, activeMonitor.diagnosticTurnSequence),
        eventCode: 'participant-input-ended',
      })
      this.recordMonitorAudio(activeMonitor)
      if (activeMonitor.diagnosticTurnSequence && activeSession) {
        this.recordVoiceDiagnostic({
          sessionSequence: activeSession.diagnosticSessionSequence,
          stage: 'speaking-ended',
          turnSequence: activeMonitor.diagnosticTurnSequence,
        })
      }
      this.streams.get(speakerKey)?.emit('speakingStopped')
      if (this.realtimeSessions.has(voiceScopeKey(activeMonitor.scope)) && activeMonitor.finishing)
        return
      const hasAnotherActiveSpeaker = [...this.activeMonitors.values()].some((candidate) => {
        return candidate !== activeMonitor
          && (candidate.admitted || candidate.finishing)
          && voiceScopeKey(candidate.scope) === voiceScopeKey(activeMonitor.scope)
      })
      if (!hasAnotherActiveSpeaker) {
        try {
          const realtimeSession = this.realtimeSessions.get(voiceScopeKey(activeMonitor.scope))
          const diagnosticSession = this.diagnosticSessionFor(activeMonitor.scope)
          const aggregateOwner = realtimeSession?.pendingInputAggregate?.ownerTurnSequence
          const captureTurnSequence = activeMonitor.diagnosticTurnSequence
          if (!realtimeSession?.provider || !diagnosticSession || !aggregateOwner || !captureTurnSequence)
            return

          realtimeSession.provider.finishInput()
          this.recordVoiceDiagnostic({
            sessionSequence: diagnosticSession.diagnosticSessionSequence,
            stage: 'provider-input-finished',
            turnSequence: captureTurnSequence,
          })
        }
        catch {
          // This function is installed directly on Discord's EventEmitter,
          // which cannot observe a rejected async listener. Record the exact
          // owner and fail closed before the unfinished input can survive.
          logVoiceLifecycle(this.logger, 'error', {
            ...this.voiceLogOwner(activeMonitor.scope, activeMonitor.diagnosticTurnSequence),
            eventCode: 'input-finalize-failed',
            failureCategory: 'provider',
            terminal: true,
          })
          if (activeSession && activeMonitor.diagnosticTurnSequence) {
            this.recordVoiceDiagnostic({
              failureCategory: 'provider-error',
              sessionSequence: activeSession.diagnosticSessionSequence,
              stage: 'failure',
              turnSequence: activeMonitor.diagnosticTurnSequence,
            })
          }
          if (activeSession?.consentSessionId) {
            const consentSession = this.consentSessions.get(activeSession.consentSessionId)
            if (consentSession)
              consentSession.state = 'pending'
          }
          try {
            this.invalidateVoiceGeneration(activeMonitor.scope, false)
          }
          catch {
            logVoiceLifecycle(this.logger, 'error', {
              ...this.voiceLogOwner(activeMonitor.scope, activeMonitor.diagnosticTurnSequence),
              eventCode: 'input-generation-cleanup-failed',
              failureCategory: 'cleanup',
              terminal: true,
            })
          }
        }
      }
    }
  }

  joinChannel(
    interaction: ChatInputCommandInteraction<CacheType>,
    channel: BaseGuildVoiceChannel,
    options: JoinVoiceChannelOptions = {},
  ): Promise<void> {
    const currentJoin = this.voiceJoinTaskByGuildId.get(channel.guild.id)
    if (
      currentJoin?.channelId === channel.id
      && currentJoin.consentSessionId === options.consentSessionId
    ) {
      if (currentJoin.interaction === interaction || options.announce === false)
        return currentJoin.task
      return currentJoin.task.then(async () => {
        await respondToVoiceInteraction(interaction, this.joinedVoiceContent(channel))
      })
    }
    if (this.pendingVoiceJoinTasks.size >= MAX_PENDING_REALTIME_CONNECTS)
      return Promise.reject(new Error('Discord voice connection capacity is temporarily exhausted.'))

    const task = (async () => {
      // A restart requested while global stop is still draining begins only
      // after the invalidated generation has released its provider transport.
      const activeStop = this.stopTask
      if (activeStop)
        await activeStop
      await this.establishVoiceSession(interaction, channel, options)
    })()
    const taskRecord = {
      channelId: channel.id,
      consentSessionId: options.consentSessionId,
      interaction,
      task,
    }
    this.voiceJoinTaskByGuildId.set(channel.guild.id, taskRecord)
    this.pendingVoiceJoinTasks.add(task)
    void task.then(
      () => {
        this.pendingVoiceJoinTasks.delete(task)
        if (this.voiceJoinTaskByGuildId.get(channel.guild.id) === taskRecord)
          this.voiceJoinTaskByGuildId.delete(channel.guild.id)
      },
      () => {
        this.pendingVoiceJoinTasks.delete(task)
        if (this.voiceJoinTaskByGuildId.get(channel.guild.id) === taskRecord)
          this.voiceJoinTaskByGuildId.delete(channel.guild.id)
      },
    )
    return task
  }

  private async establishVoiceSession(
    interaction: ChatInputCommandInteraction<CacheType>,
    channel: BaseGuildVoiceChannel,
    options: JoinVoiceChannelOptions,
  ): Promise<void> {
    if (options.consentSessionId) {
      const consentSession = this.consentSessions.get(options.consentSessionId)
      const participantIds = this.getCurrentParticipantIds(channel)
      if (
        !consentSession
        || consentSession.channel.id !== channel.id
        || consentSession.channel.guild.id !== channel.guild.id
        || consentSession.state === 'pending'
        || participantIds.length === 0
        || !participantIds.every(userId => consentSession.consentedUserIds.has(userId))
      ) {
        throw new Error('Discord voice consent is incomplete for the requested channel.')
      }
    }

    const clientUserId = this.getClientUserId()
    const previousSession = this.activeVoiceSessionsByGuildId.get(channel.guild.id)
    if (!previousSession && this.activeVoiceSessionsByGuildId.size >= MAX_ACTIVE_VOICE_GENERATIONS)
      throw new Error(VOICE_CAPACITY_STATUS)
    let pendingDiscordVoiceStateResetCount = previousSession?.pendingDiscordVoiceStateResetCount ?? 0
    if (previousSession) {
      if (previousSession.connection.state.status !== VoiceConnectionStatus.Destroyed)
        pendingDiscordVoiceStateResetCount += 1
      this.releaseVoiceSession(
        previousSession,
        previousSession.consentSessionId !== options.consentSessionId,
      )
    }
    else {
      const oldConnection = this.getVoiceConnection(channel.guild.id)
      if (oldConnection) {
        try {
          const requestsVoiceStateReset = oldConnection.state.status !== VoiceConnectionStatus.Destroyed
          const oldChannelId = oldConnection.joinConfig.channelId
          if (oldChannelId)
            this.disconnectChannel(oldChannelId, oldConnection, false, 'replaced')
          else
            oldConnection.destroy()
          if (requestsVoiceStateReset)
            pendingDiscordVoiceStateResetCount += 1
        }
        catch {
          logVoiceLifecycle(this.logger, 'warn', {
            eventCode: 'session-cleanup-failed',
            failureCategory: 'cleanup',
            terminal: true,
          })
        }
      }
    }

    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false,
      group: clientUserId,
    })
    const generation = ++this.nextVoiceGeneration
    const session: ActiveVoiceSession = {
      abortController: new AbortController(),
      channel,
      connection,
      consentSessionId: options.consentSessionId,
      diagnosticCleaned: false,
      diagnosticSessionSequence: ++this.nextVoiceDiagnosticSessionSequence,
      nextDiagnosticTurnSequence: 0,
      pendingDiscordVoiceStateResetCount,
      scope: {
        channelId: channel.id,
        generation,
        guildId: channel.guild.id,
      },
    }
    this.activeVoiceSessionsByGuildId.set(channel.guild.id, session)
    this.recordVoiceDiagnostic({
      mode: this.getVoiceCallMode(),
      sessionSequence: session.diagnosticSessionSequence,
      stage: 'session-started',
    })

    try {
      // Wait for either Ready or Signalling state
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Ready, 20_000),
        entersState(connection, VoiceConnectionStatus.Signalling, 20_000),
      ])
      if (!this.isVoiceSessionCurrent(session))
        return

      if (connection.state.status === VoiceConnectionStatus.Ready) {
        this.recordVoiceDiagnostic({
          sessionSequence: session.diagnosticSessionSequence,
          stage: 'transport-ready',
        })
      }

      const observedDiscordVoiceSessionId = resolveDiscordVoiceSessionId(connection.state)
      if (pendingDiscordVoiceStateResetCount === 0 && observedDiscordVoiceSessionId)
        session.discordVoiceSessionId = observedDiscordVoiceSessionId

      // Log connection success
      logVoiceLifecycle(this.logger, 'log', {
        eventCode: 'connection-established',
        sessionSequence: session.diagnosticSessionSequence,
        state: connection.state.status,
      })
      // Set up ongoing state change monitoring
      const handleStateChange = this.handleVoiceConnectionStateChange(channel, connection, session)
      const stateChange = async (oldState: VoiceConnectionState, newState: VoiceConnectionState) => {
        try {
          await handleStateChange(oldState, newState)
        }
        catch {
          // @discordjs/voice dispatches this callback through EventEmitter and
          // cannot observe its promise. Contain cleanup failures at that owned
          // boundary while invalidating only the generation that installed it.
          logVoiceLifecycle(this.logger, 'error', {
            eventCode: 'state-change-handler-failed',
            failureCategory: 'cleanup',
            newState: newState.status,
            oldState: oldState.status,
            sessionSequence: session.diagnosticSessionSequence,
            terminal: true,
          })
          try {
            this.invalidateVoiceGeneration(session.scope, false)
          }
          catch {
            logVoiceLifecycle(this.logger, 'error', {
              eventCode: 'state-change-cleanup-failed',
              failureCategory: 'cleanup',
              sessionSequence: session.diagnosticSessionSequence,
              terminal: true,
            })
          }
        }
      }
      const error = (voiceError: Error) => this.handleVoiceConnectionError(voiceError, session)
      const startSpeakerInput = this.handleAudioReceiveStreamStart(channel, session.scope)
      const speakingStart = async (userId: string) => {
        try {
          await startSpeakerInput(userId)
        }
        catch {
          // Receiver speaking events are synchronous EventEmitter callbacks;
          // contain a rejected cleanup promise at the installed boundary and
          // invalidate only the generation that owns this listener.
          logVoiceLifecycle(this.logger, 'error', {
            eventCode: 'speaking-start-handler-failed',
            failureCategory: 'receiver',
            sessionSequence: session.diagnosticSessionSequence,
            terminal: true,
          })
          try {
            this.invalidateVoiceGeneration(session.scope, false)
          }
          catch {
            logVoiceLifecycle(this.logger, 'error', {
              eventCode: 'speaking-start-cleanup-failed',
              failureCategory: 'cleanup',
              sessionSequence: session.diagnosticSessionSequence,
              terminal: true,
            })
          }
        }
      }
      const finishSpeakerInput = this.handleAudioReceiveStreamEnd(channel, session.scope)
      const speakingEnd = async (userId: string) => {
        try {
          await finishSpeakerInput(userId)
        }
        catch {
          // Discord does not observe rejected async EventEmitter listeners. Log
          // only structured ownership, then finish invalidating this generation.
          logVoiceLifecycle(this.logger, 'error', {
            eventCode: 'speaking-end-handler-failed',
            failureCategory: 'provider',
            sessionSequence: session.diagnosticSessionSequence,
            terminal: true,
          })
          try {
            this.invalidateVoiceGeneration(session.scope, false)
          }
          catch {
            logVoiceLifecycle(this.logger, 'error', {
              eventCode: 'speaking-end-cleanup-failed',
              failureCategory: 'cleanup',
              sessionSequence: session.diagnosticSessionSequence,
              terminal: true,
            })
          }
        }
      }
      connection.on('stateChange', stateChange)
      connection.on('error', error)
      // Register listener ownership before awaiting the provider. stop/restart
      // must be able to detach these exact callbacks while connect is pending.
      this.connectionListeners.set(voiceScopeKey(session.scope), {
        connection,
        error,
        scope: session.scope,
        speakingEnd,
        speakingStart,
        stateChange,
      })

      // Store the connection
      this.connections.set(channel.id, connection)

      if (this.getVoiceCallMode() === 'qwen-realtime') {
        await this.openRealtimeSession(connection, session)
        if (!this.isVoiceSessionCurrent(session))
          return
        if (this.realtimeSessions.get(voiceScopeKey(session.scope))?.provider) {
          this.recordVoiceDiagnostic({
            sessionSequence: session.diagnosticSessionSequence,
            stage: 'provider-ready',
          })
        }
      }

      connection.receiver.speaking.on('start', speakingStart)
      connection.receiver.speaking.on('end', speakingEnd)

      // Continue with voice state modifications
      await setSelfVoice(this.logger, channel.guild.members.me)
      if (!this.isVoiceSessionCurrent(session))
        return

      if (options.announce !== false) {
        await respondToVoiceInteraction(interaction, this.joinedVoiceContent(channel))
      }
    }
    catch (error) {
      // Provider/websocket errors can embed request URLs, headers, or response
      // bodies. Keep the original exception for callers while logging only its
      // classification and the immutable lifecycle owner.
      logVoiceLifecycle(this.logger, 'error', {
        eventCode: 'provider-connect-failed',
        failureCategory: this.getVoiceCallMode() === 'qwen-realtime' ? 'provider' : 'connection',
        mode: this.getVoiceCallMode(),
        sessionSequence: session.diagnosticSessionSequence,
        terminal: true,
      })
      this.recordVoiceDiagnostic({
        failureCategory: this.getVoiceCallMode() === 'qwen-realtime' ? 'provider-error' : 'connection-error',
        sessionSequence: session.diagnosticSessionSequence,
        stage: 'failure',
      })
      try {
        this.releaseVoiceSession(session, false, 'failed')
      }
      catch (cleanupError) {
        // Preserve causal order: the external connection failed first, then
        // exception-safe teardown reported its own failure after releasing all
        // remaining owners. Neither failure may replace the other.
        throw new AggregateError(
          [error, cleanupError],
          'Discord voice connection failed and lifecycle cleanup also failed.',
        )
      }
      throw error
    }
  }

  private getVoiceConnection(guildId: string) {
    const activeSession = this.activeVoiceSessionsByGuildId.get(guildId)
    if (activeSession && this.isVoiceSessionCurrent(activeSession))
      return activeSession.connection

    const connections = getVoiceConnections(this.getClientUserId())
    if (!connections) {
      logVoiceLifecycle(this.logger, 'warn', {
        eventCode: 'session-not-found',
        failureCategory: 'connection',
      })
      return
    }
    const connection = [...connections.values()].find(
      connection => connection.joinConfig.guildId === guildId,
    )
    if (!connection) {
      logVoiceLifecycle(this.logger, 'warn', {
        eventCode: 'session-not-found',
        failureCategory: 'connection',
      })
    }

    return connection
  }

  private getClientUserId() {
    const clientUserId = this.client.user?.id
    if (!clientUserId)
      throw new Error('Discord client user is unavailable before voice login completes.')

    return clientUserId
  }

  private async openRealtimeSession(connection: VoiceConnection, voiceSession: ActiveVoiceSession) {
    const runtime = this.realtimeVoiceCallRuntime
    if (!runtime?.isConfigured())
      throw new Error('Qwen Realtime is selected but its API key or workspace id is missing.')

    if (!this.isVoiceSessionCurrent(voiceSession))
      return

    const { scope } = voiceSession
    const scopeKey = voiceScopeKey(scope)
    this.closeRealtimeSession(scope)
    if (this.pendingRealtimeConnectTasks.size >= MAX_PENDING_REALTIME_CONNECTS)
      throw new Error('Qwen Realtime connection capacity is temporarily exhausted.')

    const realtimeSession: ScopedRealtimeSession = {
      abortController: new AbortController(),
      captureAppendStates: new Map(),
      committedInputByItemId: new Map(),
      committedInputItemIds: new Set(),
      committedInputTurnSequences: [],
      committedInputRecords: [],
      correlationEpoch: 0,
      finishedInputTurnSequences: [],
      inputAppendInvocations: [],
      inputItemTurnSequences: new Map(),
      observedSpeechItemIds: new Set(),
      providerInputByTurn: new Map(),
      responseMetricsByTurn: new Map(),
      responseTurnSequences: new Map(),
      retiredInputItemIds: new Set(),
      retiredResponseIds: new Set(),
      scope,
      terminated: false,
    }
    this.realtimeSessions.set(scopeKey, realtimeSession)
    const ownsCurrentGeneration = () => {
      return this.realtimeSessions.get(scopeKey) === realtimeSession
        && !realtimeSession.terminated
        && this.isVoiceSessionCurrent(voiceSession)
    }
    const hasReplyTarget = () => this.getCurrentParticipantIds(voiceSession.channel).length > 0
    const currentCorrelationTurn = () => {
      return realtimeSession.activeCaptureTurnSequence
        ?? realtimeSession.committedInputTurnSequences[0]
        ?? realtimeSession.finishedInputTurnSequences[0]
        ?? realtimeSession.responseTurnSequences.values().next().value
        ?? voiceSession.currentDiagnosticTurnSequence
    }
    const correlationKey = (value: string | undefined) => {
      return value && value.length <= 256 ? value : undefined
    }
    const correlationSequence = (value: number | undefined) => {
      return value !== undefined && Number.isSafeInteger(value) && value > 0
        ? value
        : undefined
    }
    const correlationRejected = (turnSequence?: number, terminal = false) => {
      logVoiceLifecycle(this.logger, terminal ? 'error' : 'warn', {
        ...this.voiceLogOwner(scope, turnSequence),
        eventCode: 'provider-correlation-rejected',
        failureCategory: terminal ? 'capacity' : 'provider',
        retryable: !terminal,
        terminal,
      })
    }
    const retainTurnMapping = (mapping: Map<string, number>, key: string, turnSequence: number) => {
      if (!mapping.has(key) && mapping.size >= MAX_REALTIME_TURN_CORRELATIONS) {
        correlationRejected(turnSequence, true)
        return false
      }
      mapping.set(key, turnSequence)
      return true
    }
    const retainIdentity = (
      identities: Set<string>,
      key: string,
      turnSequence: number,
      capacity = MAX_REALTIME_TURN_CORRELATIONS,
    ) => {
      if (!identities.has(key) && identities.size >= capacity) {
        correlationRejected(turnSequence, true)
        return false
      }
      identities.add(key)
      return true
    }
    const removeQueuedTurn = (queue: number[], turnSequence: number) => {
      const index = queue.indexOf(turnSequence)
      if (index >= 0)
        queue.splice(index, 1)
    }
    const responseTurnFor = (identity: RealtimeVoiceProviderEventIdentity) => {
      const responseId = correlationKey(identity.responseId)
      return responseId === undefined
        ? undefined
        : realtimeSession.responseTurnSequences.get(responseId)
    }
    const inputTurnFor = (identity: RealtimeVoiceProviderEventIdentity) => {
      const itemId = correlationKey(identity.itemId)
      if (itemId && realtimeSession.retiredInputItemIds.has(itemId))
        return undefined
      const inputSequence = correlationSequence(identity.inputSequence)
      if (inputSequence)
        return inputSequence
      if (itemId)
        return realtimeSession.inputItemTurnSequences.get(itemId)
      return realtimeSession.activeProviderInputTurnSequence
        ?? realtimeSession.activeCaptureTurnSequence
        ?? realtimeSession.finishedInputTurnSequences[0]
        ?? voiceSession.currentDiagnosticTurnSequence
    }
    const responseMetricsFor = (turnSequence: number) => {
      const existing = realtimeSession.responseMetricsByTurn.get(turnSequence)
      if (existing)
        return existing
      if (realtimeSession.responseMetricsByTurn.size >= MAX_REALTIME_TURN_CORRELATIONS) {
        correlationRejected(turnSequence, true)
        return undefined
      }
      const metrics: RealtimeResponseMetrics = {
        audioReported: false,
        cancelledReported: false,
        responseAudioBytes: 0,
        responseAudioChunks: 0,
      }
      realtimeSession.responseMetricsByTurn.set(turnSequence, metrics)
      return metrics
    }
    const providerInputFor = (turnSequence: number) => {
      const existing = realtimeSession.providerInputByTurn.get(turnSequence)
      if (existing)
        return existing
      if (realtimeSession.providerInputByTurn.size >= MAX_REALTIME_TURN_CORRELATIONS) {
        correlationRejected(turnSequence, true)
        return undefined
      }
      const counters: RealtimeProviderInputCounters = {
        syntheticInputBytes: 0,
        syntheticInputChunks: 0,
        userInputBytes: 0,
        userInputChunks: 0,
      }
      realtimeSession.providerInputByTurn.set(turnSequence, counters)
      return counters
    }
    /** Retires only the uncommitted aggregate and every contributor-owned input counter. */
    const resetPendingInputAggregate = () => {
      const aggregate = realtimeSession.pendingInputAggregate
      realtimeSession.pendingInputAggregate = undefined
      if (!aggregate)
        return undefined
      for (const turnSequence of aggregate.captureTurnSequences) {
        realtimeSession.providerInputByTurn.delete(turnSequence)
        realtimeSession.captureAppendStates?.delete(turnSequence)
        removeQueuedTurn(realtimeSession.finishedInputTurnSequences, turnSequence)
      }
      return aggregate
    }
    const captureAppendStateFor = (turnSequence: number) => {
      const captureAppendStates = realtimeSession.captureAppendStates
      return captureAppendStates?.get(turnSequence)
    }
    const releaseInputTurn = (identity: RealtimeVoiceProviderEventIdentity, turnSequence: number) => {
      const itemId = correlationKey(identity.itemId)
      if (itemId && !retainIdentity(realtimeSession.retiredInputItemIds, itemId, turnSequence, MAX_REALTIME_RETIRED_IDENTITIES))
        throw new Error('Realtime retired input identity capacity exhausted.')
      realtimeSession.providerInputByTurn.delete(turnSequence)
      removeQueuedTurn(realtimeSession.committedInputTurnSequences, turnSequence)
      removeQueuedTurn(realtimeSession.finishedInputTurnSequences, turnSequence)
      realtimeSession.captureAppendStates?.delete(turnSequence)
      for (const [mappedItemId, itemTurnSequence] of realtimeSession.inputItemTurnSequences) {
        if (itemTurnSequence !== turnSequence)
          continue
        if (!retainIdentity(realtimeSession.retiredInputItemIds, mappedItemId, turnSequence, MAX_REALTIME_RETIRED_IDENTITIES))
          throw new Error('Realtime retired input identity capacity exhausted.')
        realtimeSession.inputItemTurnSequences.delete(mappedItemId)
        realtimeSession.committedInputItemIds.delete(mappedItemId)
        realtimeSession.observedSpeechItemIds.delete(mappedItemId)
      }
      if (realtimeSession.activeProviderInputTurnSequence === turnSequence)
        realtimeSession.activeProviderInputTurnSequence = undefined
      if (realtimeSession.activeCaptureTurnSequence === turnSequence)
        realtimeSession.activeCaptureTurnSequence = undefined
    }
    const releaseResponseTurn = (identity: RealtimeVoiceProviderEventIdentity, turnSequence: number) => {
      const responseId = correlationKey(identity.responseId)
      if (responseId) {
        if (!retainIdentity(realtimeSession.retiredResponseIds, responseId, turnSequence, MAX_REALTIME_RETIRED_IDENTITIES))
          throw new Error('Realtime retired response identity capacity exhausted.')
        realtimeSession.responseTurnSequences.delete(responseId)
      }
      realtimeSession.responseMetricsByTurn.delete(turnSequence)
      releaseInputTurn(identity, turnSequence)
    }
    const runCurrentProviderCallback = (operation: () => void, turnSequence?: number) => {
      if (!ownsCurrentGeneration())
        return
      try {
        operation()
      }
      catch {
        logVoiceLifecycle(this.logger, 'error', {
          ...this.voiceLogOwner(scope, turnSequence ?? currentCorrelationTurn()),
          eventCode: 'provider-callback-failed',
          failureCategory: 'provider',
          terminal: true,
        })
        try {
          this.invalidateVoiceGeneration(scope, false)
        }
        catch {
          logVoiceLifecycle(this.logger, 'error', {
            ...this.voiceLogOwner(scope, turnSequence ?? currentCorrelationTurn()),
            eventCode: 'provider-callback-cleanup-failed',
            failureCategory: 'cleanup',
            terminal: true,
          })
        }
      }
    }
    const connectTask = (async () => {
      let provider: RealtimeVoiceCallSession
      try {
        provider = await runtime.connect({
          onAudio: (pcm, identity) => {
            const turnSequence = responseTurnFor(identity)
            if (!turnSequence) {
              correlationRejected()
              return
            }
            runCurrentProviderCallback(() => {
              const metrics = responseMetricsFor(turnSequence)
              if (!metrics)
                throw new Error('Realtime response metric capacity exhausted.')
              if (metrics.cancelledReported)
                return
              metrics.responseAudioChunks = Math.min(65_535, metrics.responseAudioChunks + 1)
              metrics.responseAudioBytes = Math.min(65_535, metrics.responseAudioBytes + pcm.length)
              if (metrics.responseAudioChunks === 1) {
                metrics.audioReported = true
                this.recordVoiceDiagnostic({
                  responseAudioBytes: metrics.responseAudioBytes,
                  responseAudioChunks: metrics.responseAudioChunks,
                  sessionSequence: voiceSession.diagnosticSessionSequence,
                  stage: 'provider-response-audio',
                  turnSequence,
                })
              }
              if (hasReplyTarget())
                this.writeRealtimeAudio(scope, connection, pcm, turnSequence)
            })
          },
          onAudioDone: (identity) => {
            const turnSequence = responseTurnFor(identity)
            if (!turnSequence) {
              correlationRejected()
              return
            }
            runCurrentProviderCallback(() => {
              const metrics = realtimeSession.responseMetricsByTurn.get(turnSequence)
              if (metrics?.cancelledReported)
                return
              if (metrics && metrics.responseAudioChunks > 0 && !metrics.audioReported) {
                metrics.audioReported = true
                this.recordVoiceDiagnostic({
                  responseAudioBytes: metrics.responseAudioBytes,
                  responseAudioChunks: metrics.responseAudioChunks,
                  sessionSequence: voiceSession.diagnosticSessionSequence,
                  stage: 'provider-response-audio',
                  turnSequence,
                })
              }
              if (hasReplyTarget())
                this.finishRealtimeAudio(scope, turnSequence)
            }, turnSequence)
          },
          onAssistantTranscript: (text, identity) => {
            if (!ownsCurrentGeneration())
              return
            const turnSequence = responseTurnFor(identity)
            logVoiceLifecycle(this.logger, 'log', {
              ...this.voiceLogOwner(scope, turnSequence),
              characterCount: text.length,
              eventCode: 'provider-transcript-complete',
            })
          },
          onClose: (code) => {
            if (!ownsCurrentGeneration())
              return
            logVoiceLifecycle(this.logger, 'warn', {
              ...this.voiceLogOwner(scope, currentCorrelationTurn()),
              closeCode: code,
              eventCode: 'provider-session-closed',
              failureCategory: 'provider',
              terminal: true,
            })
            this.recordVoiceDiagnostic({
              failureCategory: 'provider-error',
              sessionSequence: voiceSession.diagnosticSessionSequence,
              stage: 'failure',
              turnSequence: currentCorrelationTurn(),
            })
            try {
              this.invalidateVoiceGeneration(scope, false)
            }
            catch {
              logVoiceLifecycle(this.logger, 'error', {
                ...this.voiceLogOwner(scope, currentCorrelationTurn()),
                eventCode: 'provider-close-cleanup-failed',
                failureCategory: 'cleanup',
                terminal: true,
              })
            }
          },
          onError: (failure) => {
            if (!ownsCurrentGeneration())
              return
            const normalizedFailure = normalizeRealtimeVoiceProviderFailure(failure)
            if (
              normalizedFailure.disposition === 'recoverable'
              && (normalizedFailure.category === 'transport-closed' || normalizedFailure.category === 'transport-error')
            ) {
              this.retireRealtimeTransportCorrelations(realtimeSession)
              logVoiceLifecycle(this.logger, 'warn', {
                ...this.voiceLogOwner(scope, currentCorrelationTurn()),
                eventCode: 'provider-transport-lost',
                failureCategory: 'provider',
                retryable: true,
                terminal: false,
              })
              return
            }
            logVoiceLifecycle(this.logger, 'error', {
              ...this.voiceLogOwner(scope, currentCorrelationTurn()),
              eventCode: 'provider-error',
              failureCategory: 'provider',
              terminal: true,
            })
            this.recordVoiceDiagnostic({
              failureCategory: 'provider-error',
              sessionSequence: voiceSession.diagnosticSessionSequence,
              stage: 'failure',
              turnSequence: currentCorrelationTurn(),
            })
            try {
              this.invalidateVoiceGeneration(scope, false)
            }
            catch {
              logVoiceLifecycle(this.logger, 'error', {
                ...this.voiceLogOwner(scope, currentCorrelationTurn()),
                eventCode: 'provider-error-cleanup-failed',
                failureCategory: 'cleanup',
                terminal: true,
              })
            }
          },
          onInputAudioSent: (increment) => {
            const turnSequence = correlationSequence(increment.inputSequence)
            runCurrentProviderCallback(() => {
              if (
                !turnSequence
                || increment.chunkCount !== 1
                || !Number.isSafeInteger(increment.byteLength)
                || increment.byteLength <= 0
                || (increment.kind !== 'synthetic-silence' && increment.kind !== 'user-audio')
              ) {
                correlationRejected(turnSequence, true)
                throw new Error('Realtime provider reported an invalid successful input append.')
              }
              if (increment.kind === 'user-audio') {
                const invocation = realtimeSession.inputAppendInvocations?.at(-1)
                if (
                  !invocation
                  || invocation.correlationEpoch !== realtimeSession.correlationEpoch
                  || invocation.inputSequence !== turnSequence
                  || invocation.acknowledged
                ) {
                  correlationRejected(turnSequence, true)
                  throw new Error('Realtime provider input acknowledgement is not bound to its append invocation.')
                }
                invocation.acknowledged = true
                const captureState = captureAppendStateFor(turnSequence)
                if (!captureState)
                  throw new Error('Realtime provider acknowledgement has no reserved capture state.')
                captureState.hasFormalProviderAck = true
                captureState.reservationHeld = false
                const aggregate = realtimeSession.pendingInputAggregate ?? {
                  captureTurnSequences: [],
                  ownerTurnSequence: turnSequence,
                }
                const lastContributor = aggregate.captureTurnSequences.at(-1)
                if (!aggregate.captureTurnSequences.includes(turnSequence)) {
                  if (aggregate.captureTurnSequences.length >= MAX_PENDING_INPUT_AGGREGATE_CONTRIBUTORS) {
                    correlationRejected(turnSequence, true)
                    throw new Error('Realtime provider aggregate contributor source is invalid.')
                  }
                  if (lastContributor !== undefined && turnSequence < lastContributor) {
                    aggregate.captureTurnSequences.unshift(turnSequence)
                    aggregate.ownerTurnSequence = turnSequence
                  }
                  else {
                    aggregate.captureTurnSequences.push(turnSequence)
                  }
                }
                realtimeSession.pendingInputAggregate = aggregate
              }
              const aggregate = realtimeSession.pendingInputAggregate
              const diagnosticTurnSequence = increment.kind === 'synthetic-silence'
                ? aggregate?.ownerTurnSequence
                : turnSequence
              if (!diagnosticTurnSequence)
                throw new Error('Realtime synthetic input has no pending aggregate owner.')
              const counters = providerInputFor(diagnosticTurnSequence)
              if (!counters)
                throw new Error('Realtime provider-input metric capacity exhausted.')
              const byteLength = Math.min(65_535, Math.max(0, Math.trunc(increment.byteLength)))
              if (increment.kind === 'user-audio') {
                counters.userInputChunks = Math.min(65_535, counters.userInputChunks + increment.chunkCount)
                counters.userInputBytes = Math.min(65_535, counters.userInputBytes + byteLength)
                this.recordVoiceDiagnostic({
                  inputKind: increment.kind,
                  providerInputBytes: counters.userInputBytes,
                  providerInputChunks: counters.userInputChunks,
                  sessionSequence: voiceSession.diagnosticSessionSequence,
                  stage: 'provider-input-appended',
                  turnSequence: diagnosticTurnSequence,
                })
                return
              }
              counters.syntheticInputChunks = Math.min(65_535, counters.syntheticInputChunks + increment.chunkCount)
              counters.syntheticInputBytes = Math.min(65_535, counters.syntheticInputBytes + byteLength)
              this.recordVoiceDiagnostic({
                inputKind: increment.kind,
                providerInputBytes: counters.syntheticInputBytes,
                providerInputChunks: counters.syntheticInputChunks,
                sessionSequence: voiceSession.diagnosticSessionSequence,
                stage: 'provider-input-appended',
                turnSequence: diagnosticTurnSequence,
              })
            }, turnSequence)
          },
          onInputCleared: (identity) => {
            runCurrentProviderCallback(() => {
              const pendingAggregate = realtimeSession.pendingInputAggregate
              const turnSequence = pendingAggregate?.ownerTurnSequence
              const itemIdProvided = Object.hasOwn(identity, 'itemId')
              const inputSequenceProvided = Object.hasOwn(identity, 'inputSequence')
              const itemId = correlationKey(identity.itemId)
              const inputSequence = correlationSequence(identity.inputSequence)
              if (
                !turnSequence
                || (itemIdProvided && !itemId)
                || (inputSequenceProvided && !inputSequence)
                || (!itemIdProvided && !inputSequenceProvided)
              ) {
                correlationRejected()
                return
              }
              if (itemIdProvided) {
                if (!itemId) {
                  correlationRejected()
                  return
                }
                const mappedTurnSequence = realtimeSession.inputItemTurnSequences.get(itemId)
                if (
                  mappedTurnSequence !== turnSequence
                  || (inputSequenceProvided && inputSequence !== mappedTurnSequence)
                ) {
                  correlationRejected()
                  return
                }
              }
              else if (inputSequence !== turnSequence) {
                correlationRejected()
                return
              }
              this.recordVoiceDiagnostic({
                sessionSequence: voiceSession.diagnosticSessionSequence,
                stage: 'provider-input-cleared',
                turnSequence,
              })
              resetPendingInputAggregate()
            })
          },
          onInputCommitted: (identity) => {
            runCurrentProviderCallback(() => {
              // A provider commit can only consume PCM that this generation
              // accepted synchronously through onInputAudioSent.
              const pendingAggregate = realtimeSession.pendingInputAggregate
              if (!pendingAggregate) {
                correlationRejected()
                return
              }
              const itemId = correlationKey(identity.itemId)
              if (itemId && realtimeSession.retiredInputItemIds.has(itemId)) {
                correlationRejected()
                return
              }
              if (itemId && realtimeSession.committedInputItemIds.has(itemId))
                return
              const committedRecords = realtimeSession.committedInputRecords
              const committedInputByItemId = realtimeSession.committedInputByItemId
              if (!committedRecords || !committedInputByItemId) {
                correlationRejected()
                return
              }
              const turnSequence = pendingAggregate.ownerTurnSequence
              if (committedRecords.length >= MAX_REALTIME_TURN_CORRELATIONS) {
                correlationRejected(turnSequence, true)
                throw new Error('Realtime committed input backlog capacity exhausted.')
              }
              if (itemId && !committedInputByItemId.has(itemId) && committedInputByItemId.size >= MAX_REALTIME_TURN_CORRELATIONS) {
                correlationRejected(turnSequence, true)
                throw new Error('Realtime committed item backlog capacity exhausted.')
              }
              if (itemId && !retainTurnMapping(realtimeSession.inputItemTurnSequences, itemId, turnSequence))
                throw new Error('Realtime item correlation capacity exhausted.')
              if (itemId && !retainIdentity(realtimeSession.committedInputItemIds, itemId, turnSequence))
                throw new Error('Realtime committed item identity capacity exhausted.')
              removeQueuedTurn(realtimeSession.finishedInputTurnSequences, turnSequence)
              if (realtimeSession.activeProviderInputTurnSequence === turnSequence)
                realtimeSession.activeProviderInputTurnSequence = undefined
              const record: CommittedInputRecord = {
                captureTurnSequences: Object.freeze([...pendingAggregate.captureTurnSequences]),
                ...(itemId ? { itemId } : {}),
                ownerTurnSequence: turnSequence,
              }
              committedRecords.push(record)
              if (itemId)
                committedInputByItemId.set(itemId, record)
              this.recordVoiceDiagnostic({
                aggregateTurnSequence: turnSequence,
                captureTurnSequences: [...record.captureTurnSequences],
                sessionSequence: voiceSession.diagnosticSessionSequence,
                stage: 'provider-input-committed',
                turnSequence,
              })
              resetPendingInputAggregate()
            })
          },
          onResponseCancelled: (identity) => {
            const turnSequence = responseTurnFor(identity)
            if (!turnSequence) {
              correlationRejected()
              return
            }
            runCurrentProviderCallback(() => {
              const metrics = responseMetricsFor(turnSequence)
              if (!metrics || metrics.cancelledReported)
                return
              metrics.cancelledReported = true
              this.recordVoiceDiagnostic({
                sessionSequence: voiceSession.diagnosticSessionSequence,
                stage: 'provider-response-cancelled',
                turnSequence,
              })
            }, turnSequence)
          },
          onResponseCreated: (identity) => {
            runCurrentProviderCallback(() => {
              const responseId = correlationKey(identity.responseId)
              if (!responseId) {
                correlationRejected()
                return
              }
              if (realtimeSession.retiredResponseIds.has(responseId)) {
                correlationRejected()
                return
              }
              if (realtimeSession.responseTurnSequences.has(responseId))
                return
              const itemId = correlationKey(identity.itemId)
              const committedRecords = realtimeSession.committedInputRecords
              const committedInputByItemId = realtimeSession.committedInputByItemId
              const record = itemId
                ? committedInputByItemId?.get(itemId)
                : committedRecords?.[0]
              if (!record || !committedRecords) {
                correlationRejected()
                return
              }
              const recordIndex = committedRecords.indexOf(record)
              if (recordIndex < 0) {
                correlationRejected(record.ownerTurnSequence, true)
                return
              }
              committedRecords.splice(recordIndex, 1)
              if (record.itemId)
                committedInputByItemId?.delete(record.itemId)
              const turnSequence = record.ownerTurnSequence
              if (!retainTurnMapping(realtimeSession.responseTurnSequences, responseId, turnSequence))
                throw new Error('Realtime response correlation capacity exhausted.')
              realtimeSession.responseMetricsByTurn.set(turnSequence, {
                audioReported: false,
                cancelledReported: false,
                responseAudioBytes: 0,
                responseAudioChunks: 0,
              })
              this.recordVoiceDiagnostic({
                sessionSequence: voiceSession.diagnosticSessionSequence,
                stage: 'provider-response-created',
                turnSequence,
              })
            })
          },
          onResponseDone: (identity, outcome) => {
            const turnSequence = responseTurnFor(identity)
            if (!turnSequence) {
              correlationRejected()
              return
            }
            if (ownsCurrentGeneration() && !hasReplyTarget()) {
              try {
                this.invalidateVoiceGeneration(scope, false)
              }
              catch {
                logVoiceLifecycle(this.logger, 'error', {
                  ...this.voiceLogOwner(scope, turnSequence),
                  eventCode: 'provider-reply-target-cleanup-failed',
                  failureCategory: 'cleanup',
                  terminal: true,
                })
              }
              return
            }
            runCurrentProviderCallback(() => {
              const metrics = realtimeSession.responseMetricsByTurn.get(turnSequence)
              if (metrics && metrics.responseAudioChunks > 0 && !metrics.audioReported) {
                metrics.audioReported = true
                this.recordVoiceDiagnostic({
                  responseAudioBytes: metrics.responseAudioBytes,
                  responseAudioChunks: metrics.responseAudioChunks,
                  sessionSequence: voiceSession.diagnosticSessionSequence,
                  stage: 'provider-response-audio',
                  turnSequence,
                })
              }
              if (outcome === 'completed') {
                this.recordVoiceDiagnostic({
                  sessionSequence: voiceSession.diagnosticSessionSequence,
                  stage: 'provider-response-completed',
                  turnSequence,
                })
              }
              else if (outcome === 'cancelled') {
                if (!metrics?.cancelledReported) {
                  this.recordVoiceDiagnostic({
                    sessionSequence: voiceSession.diagnosticSessionSequence,
                    stage: 'provider-response-cancelled',
                    turnSequence,
                  })
                }
              }
              else {
                this.recordVoiceDiagnostic({
                  failureCategory: 'provider-error',
                  sessionSequence: voiceSession.diagnosticSessionSequence,
                  stage: 'failure',
                  turnSequence,
                })
              }
              this.finishRealtimeAudio(scope, turnSequence)
              for (const monitor of this.activeMonitors.values()) {
                if (
                  voiceScopeKey(monitor.scope) === scopeKey
                  && monitor.diagnosticTurnSequence === turnSequence
                ) {
                  monitor.finishing = false
                }
              }
              if (voiceSession.currentDiagnosticTurnSequence === turnSequence)
                voiceSession.currentDiagnosticTurnSequence = undefined
              releaseResponseTurn(identity, turnSequence)
            }, turnSequence)
          },
          onSpeechStarted: (identity) => {
            runCurrentProviderCallback(() => {
              const itemId = correlationKey(identity.itemId)
              if (itemId && realtimeSession.retiredInputItemIds.has(itemId)) {
                correlationRejected()
                return
              }
              if (itemId && realtimeSession.observedSpeechItemIds.has(itemId))
                return
              const mappedTurnSequence = itemId
                ? realtimeSession.inputItemTurnSequences.get(itemId)
                : undefined
              const inputSequence = correlationSequence(identity.inputSequence)
              const pendingAggregate = realtimeSession.pendingInputAggregate
              const hasSuccessfulPendingInput = inputSequence !== undefined
                && (
                  realtimeSession.providerInputByTurn.has(inputSequence)
                  || pendingAggregate?.captureTurnSequences.includes(inputSequence)
                )
              const turnSequence = mappedTurnSequence
                ?? (hasSuccessfulPendingInput ? inputSequence : undefined)
              if (!turnSequence) {
                correlationRejected()
                return
              }
              if (itemId && !retainTurnMapping(realtimeSession.inputItemTurnSequences, itemId, turnSequence))
                throw new Error('Realtime VAD correlation capacity exhausted.')
              if (itemId && !retainIdentity(realtimeSession.observedSpeechItemIds, itemId, turnSequence))
                throw new Error('Realtime VAD identity capacity exhausted.')
              this.recordVoiceDiagnostic({
                sessionSequence: voiceSession.diagnosticSessionSequence,
                stage: 'provider-vad',
                turnSequence,
              })
              this.interruptRealtimePlayback(scope)
            })
          },
          onUserTranscript: (text, identity) => {
            if (!ownsCurrentGeneration())
              return
            logVoiceLifecycle(this.logger, 'log', {
              ...this.voiceLogOwner(scope, inputTurnFor(identity)),
              characterCount: text.length,
              eventCode: 'provider-transcript-complete',
            })
          },
          onWarning: () => {
            if (!ownsCurrentGeneration())
              return
            logVoiceLifecycle(this.logger, 'warn', {
              ...this.voiceLogOwner(scope, currentCorrelationTurn()),
              eventCode: 'provider-warning',
              failureCategory: 'provider',
              retryable: true,
            })
          },
        }, { signal: realtimeSession.abortController.signal })
      }
      catch (error) {
        if (realtimeSession.abortController.signal.aborted || !ownsCurrentGeneration())
          return
        throw error
      }

      realtimeSession.provider = provider
      if (ownsCurrentGeneration())
        return

      // A provider implementation may ignore AbortSignal and resolve after the
      // Discord generation is gone. Close that detached transport immediately;
      // both cleanup operations still run if the first one throws.
      let cleanupFailed = false
      let firstCleanupError: unknown
      try {
        provider.cancelResponse()
      }
      catch (error) {
        cleanupFailed = true
        firstCleanupError = error
      }
      try {
        provider.close()
      }
      catch (error) {
        if (!cleanupFailed) {
          cleanupFailed = true
          firstCleanupError = error
        }
      }
      if (cleanupFailed)
        throw firstCleanupError
    })()
    realtimeSession.connectTask = connectTask
    this.pendingRealtimeConnectTasks.add(connectTask)
    try {
      await connectTask
    }
    finally {
      this.pendingRealtimeConnectTasks.delete(connectTask)
      if (realtimeSession.connectTask === connectTask)
        realtimeSession.connectTask = undefined
    }
  }

  private writeRealtimeAudio(
    scope: VoicePlaybackScope,
    connection: VoiceConnection,
    pcm: Buffer,
    turnSequence?: number,
  ) {
    const scopeKey = voiceScopeKey(scope)
    let playback = this.activeRealtimePlaybacks.get(scopeKey)
    if (playback && turnSequence && playback.turnSequence !== turnSequence) {
      this.cleanupRealtimePlayback(playback)
      playback = undefined
    }
    if (playback?.input.destroyed || playback?.input.writableEnded) {
      this.cleanupRealtimePlayback(playback)
      playback = undefined
    }
    if (!playback) {
      const input = new PassThrough()
      const converted = input.pipe(new Pcm24kMonoTo48kStereoTransform())
      const player = createAudioPlayer({
        behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
      })
      const resource = createAudioResource(converted, { inputType: StreamType.Raw })
      const diagnosticSession = this.diagnosticSessionFor(scope)
      let scopedPlayback: ScopedRealtimePlayback
      const cleanupPlaybackFromCallback = () => {
        try {
          this.cleanupRealtimePlayback(scopedPlayback)
        }
        catch {
          logVoiceLifecycle(this.logger, 'error', {
            ...this.voiceLogOwner(scope, scopedPlayback.turnSequence),
            eventCode: 'playback-cleanup-failed',
            failureCategory: 'cleanup',
            terminal: true,
          })
          try {
            this.invalidateVoiceGeneration(scope, false)
          }
          catch {
            logVoiceLifecycle(this.logger, 'error', {
              ...this.voiceLogOwner(scope, scopedPlayback.turnSequence),
              eventCode: 'playback-generation-cleanup-failed',
              failureCategory: 'cleanup',
              terminal: true,
            })
          }
        }
      }
      const handlePlayerStateChange = (_oldState: AudioPlayerState, newState: AudioPlayerState) => {
        if (scopedPlayback.cleaned || !diagnosticSession || !scopedPlayback.turnSequence)
          return
        const playerState = newState.status === 'playing'
          ? 'playing'
          : newState.status === 'idle'
            ? 'idle'
            : 'buffering'
        this.recordVoiceDiagnostic({
          playerState,
          sessionSequence: diagnosticSession.diagnosticSessionSequence,
          stage: 'player-state',
          turnSequence: scopedPlayback.turnSequence,
        })
        if (playerState === 'playing' && !scopedPlayback.started) {
          scopedPlayback.started = true
          if (scopedPlayback.subscribed) {
            this.recordVoiceDiagnostic({
              sessionSequence: diagnosticSession.diagnosticSessionSequence,
              stage: 'playback-started',
              turnSequence: scopedPlayback.turnSequence,
            })
          }
          else {
            this.recordVoiceDiagnostic({
              failureCategory: 'connection-error',
              sessionSequence: diagnosticSession.diagnosticSessionSequence,
              stage: 'failure',
              turnSequence: scopedPlayback.turnSequence,
            })
          }
        }
        if (playerState === 'idle') {
          if (scopedPlayback.started && scopedPlayback.subscribed && !scopedPlayback.terminalReported) {
            scopedPlayback.terminalReported = true
            this.recordVoiceDiagnostic({
              sessionSequence: diagnosticSession.diagnosticSessionSequence,
              stage: 'playback-completed',
              turnSequence: scopedPlayback.turnSequence,
            })
          }
          cleanupPlaybackFromCallback()
        }
      }
      const handlePlaybackError = () => {
        logVoiceLifecycle(this.logger, 'error', {
          ...this.voiceLogOwner(scope, scopedPlayback.turnSequence),
          eventCode: 'playback-error',
          failureCategory: 'playback',
          terminal: true,
        })
        if (diagnosticSession && scopedPlayback.turnSequence) {
          this.recordVoiceDiagnostic({
            playerState: 'error',
            sessionSequence: diagnosticSession.diagnosticSessionSequence,
            stage: 'player-state',
            turnSequence: scopedPlayback.turnSequence,
          })
          this.recordVoiceDiagnostic({
            failureCategory: 'playback-error',
            sessionSequence: diagnosticSession.diagnosticSessionSequence,
            stage: 'failure',
            turnSequence: scopedPlayback.turnSequence,
          })
        }
        cleanupPlaybackFromCallback()
      }
      scopedPlayback = {
        cleaned: false,
        converted,
        diagnosticSessionSequence: diagnosticSession?.diagnosticSessionSequence,
        handlePlaybackError,
        handlePlayerStateChange,
        input,
        player,
        scope,
        started: false,
        subscribed: false,
        terminalReported: false,
        turnSequence,
      }

      input.on('error', handlePlaybackError)
      converted.on('error', handlePlaybackError)
      player.on('error', handlePlaybackError)
      player.on('stateChange', handlePlayerStateChange)
      // Establish ownership before Discord can synchronously emit idle/error
      // from subscribe() or play(). Callback cleanup must never resurrect it.
      this.activeRealtimePlaybacks.set(scopeKey, scopedPlayback)
      const subscription = connection.subscribe(player)
      scopedPlayback.subscription = subscription
      scopedPlayback.subscribed = Boolean(scopedPlayback.subscription)
      if (scopedPlayback.cleaned) {
        subscription?.unsubscribe()
        return
      }
      player.play(resource)
      playback = this.activeRealtimePlaybacks.get(scopeKey)
      if (playback !== scopedPlayback)
        return
      if (diagnosticSession && turnSequence) {
        this.recordVoiceDiagnostic({
          playerState: 'buffering',
          sessionSequence: diagnosticSession.diagnosticSessionSequence,
          stage: 'player-state',
          turnSequence,
        })
      }
    }

    playback.input.write(pcm)
  }

  private finishRealtimeAudio(scope: VoicePlaybackScope, expectedTurnSequence?: number) {
    const playback = this.activeRealtimePlaybacks.get(voiceScopeKey(scope))
    if (expectedTurnSequence && playback?.turnSequence !== expectedTurnSequence)
      return
    if (playback && !playback.input.writableEnded)
      playback.input.end()
  }

  private interruptRealtimePlayback(scope: VoicePlaybackScope) {
    const playback = this.activeRealtimePlaybacks.get(voiceScopeKey(scope))
    if (!playback)
      return

    this.cleanupRealtimePlayback(playback)
  }

  private cleanupRealtimePlayback(playback: ScopedRealtimePlayback): void {
    if (playback.cleaned)
      return
    playback.cleaned = true

    let cleanupFailed = false
    let firstCleanupError: unknown
    const cleanup = (operation: () => void) => {
      try {
        operation()
      }
      catch (error) {
        if (!cleanupFailed) {
          cleanupFailed = true
          firstCleanupError = error
        }
      }
    }

    const scopeKey = voiceScopeKey(playback.scope)
    if (!playback.terminalReported && playback.diagnosticSessionSequence && playback.turnSequence) {
      playback.terminalReported = true
      this.recordVoiceDiagnostic({
        sessionSequence: playback.diagnosticSessionSequence,
        stage: 'playback-aborted',
        turnSequence: playback.turnSequence,
      })
    }
    if (this.activeRealtimePlaybacks.get(scopeKey) === playback)
      this.activeRealtimePlaybacks.delete(scopeKey)
    cleanup(() => playback.input.removeListener('error', playback.handlePlaybackError))
    cleanup(() => playback.converted.removeListener('error', playback.handlePlaybackError))
    if (playback.subscription)
      cleanup(() => playback.subscription?.unsubscribe())
    if (!playback.input.destroyed)
      cleanup(() => playback.input.destroy())
    if (!playback.converted.destroyed)
      cleanup(() => playback.converted.destroy())
    cleanup(() => playback.player.stop())
    cleanup(() => playback.player.removeAllListeners())
    if (cleanupFailed)
      throw firstCleanupError
  }

  private terminateRealtimeSession(realtimeSession: ScopedRealtimeSession, closeProvider: boolean): void {
    const scopeKey = voiceScopeKey(realtimeSession.scope)
    if (this.realtimeSessions.get(scopeKey) !== realtimeSession)
      return

    this.realtimeSessions.delete(scopeKey)
    realtimeSession.terminated = true
    let cleanupFailed = false
    let firstCleanupError: unknown
    const cleanup = (operation: () => void) => {
      try {
        operation()
      }
      catch (error) {
        if (!cleanupFailed) {
          cleanupFailed = true
          firstCleanupError = error
        }
      }
    }
    cleanup(() => realtimeSession.abortController.abort(new Error('Discord realtime voice generation invalidated.')))
    if (closeProvider) {
      if (realtimeSession.provider?.abortInput)
        cleanup(() => realtimeSession.provider?.abortInput?.())
      cleanup(() => realtimeSession.provider?.cancelResponse())
      cleanup(() => realtimeSession.provider?.close())
    }
    realtimeSession.activeCaptureTurnSequence = undefined
    realtimeSession.activeProviderInputTurnSequence = undefined
    realtimeSession.correlationEpoch = (realtimeSession.correlationEpoch ?? 0) + 1
    realtimeSession.inputAppendInvocations?.splice(0)
    realtimeSession.captureAppendStates?.clear()
    realtimeSession.pendingInputAggregate = undefined
    realtimeSession.committedInputByItemId?.clear()
    realtimeSession.committedInputItemIds.clear()
    realtimeSession.committedInputTurnSequences.length = 0
    realtimeSession.committedInputRecords?.splice(0)
    realtimeSession.finishedInputTurnSequences.length = 0
    realtimeSession.inputItemTurnSequences.clear()
    realtimeSession.observedSpeechItemIds.clear()
    realtimeSession.providerInputByTurn.clear()
    realtimeSession.responseMetricsByTurn.clear()
    realtimeSession.responseTurnSequences.clear()
    realtimeSession.retiredInputItemIds.clear()
    realtimeSession.retiredResponseIds.clear()
    for (const monitor of Array.from(this.activeMonitors.values())) {
      if (voiceScopeKey(monitor.scope) !== scopeKey)
        continue
      cleanup(() => this.stopMonitoringMember({
        channelId: monitor.scope.channelId,
        guildId: monitor.scope.guildId,
        userId: monitor.userId,
      }, monitor.scope.generation, monitor.capture, false, true))
    }
    cleanup(() => this.interruptRealtimePlayback(realtimeSession.scope))
    if (cleanupFailed)
      throw firstCleanupError
  }

  /** Retires turn-local provider identities after an in-generation transport loss. */
  private retireRealtimeTransportCorrelations(realtimeSession: ScopedRealtimeSession): void {
    const scopeKey = voiceScopeKey(realtimeSession.scope)
    const diagnosticSession = this.diagnosticSessionFor(realtimeSession.scope)
    if (diagnosticSession)
      diagnosticSession.currentDiagnosticTurnSequence = undefined
    realtimeSession.activeCaptureTurnSequence = undefined
    realtimeSession.activeProviderInputTurnSequence = undefined
    realtimeSession.correlationEpoch = (realtimeSession.correlationEpoch ?? 0) + 1
    realtimeSession.inputAppendInvocations?.splice(0)
    realtimeSession.captureAppendStates?.clear()
    realtimeSession.pendingInputAggregate = undefined
    realtimeSession.committedInputByItemId?.clear()
    realtimeSession.committedInputItemIds.clear()
    realtimeSession.committedInputTurnSequences.length = 0
    realtimeSession.committedInputRecords?.splice(0)
    realtimeSession.finishedInputTurnSequences.length = 0
    realtimeSession.inputItemTurnSequences.clear()
    realtimeSession.observedSpeechItemIds.clear()
    realtimeSession.providerInputByTurn.clear()
    realtimeSession.responseMetricsByTurn.clear()
    realtimeSession.responseTurnSequences.clear()
    realtimeSession.retiredInputItemIds.clear()
    realtimeSession.retiredResponseIds.clear()
    for (const monitor of this.activeMonitors.values()) {
      if (voiceScopeKey(monitor.scope) === scopeKey)
        monitor.diagnosticTurnSequence = undefined
    }
    this.interruptRealtimePlayback(realtimeSession.scope)
  }

  private closeRealtimeSession(scope: VoicePlaybackScope) {
    const realtimeSession = this.realtimeSessions.get(voiceScopeKey(scope))
    if (!realtimeSession) {
      this.interruptRealtimePlayback(scope)
      return
    }

    this.terminateRealtimeSession(realtimeSession, true)
  }

  private async monitorMember(
    member: GuildMember,
    channelId: string,
    expectedScope?: VoicePlaybackScope,
  ) {
    const userId = member.id
    const guildId = member.guild.id
    const discordVoiceSessionId = member.voice?.sessionId ?? undefined
    // Project the only provider metadata needed by classic chat before any
    // asynchronous capture callback is installed. The mutable GuildMember and
    // its cache graph must not become turn-lifecycle state.
    const speaker: VoiceSpeakerIdentity = {
      displayName: member.displayName,
      guildName: member.guild.name ?? 'Discord',
      nickname: member.nickname ?? undefined,
    }
    const activeSession = this.activeVoiceSessionsByGuildId.get(guildId)
    if (activeSession && (!this.isVoiceSessionCurrent(activeSession) || activeSession.channel.id !== channelId))
      return
    if (
      expectedScope
      && (!activeSession || voiceScopeKey(activeSession.scope) !== voiceScopeKey(expectedScope))
    ) {
      return
    }

    const scope: VoicePlaybackScope = expectedScope ?? activeSession?.scope ?? { channelId, generation: 0, guildId }
    const scopeKey = voiceScopeKey(scope)
    const speakerKey = speakerScopeKey(scope, userId)
    const existingMonitor = this.activeMonitors.get(speakerKey)
    if (existingMonitor?.scope.generation === scope.generation)
      return
    if (existingMonitor)
      this.stopMonitoringMember({ channelId, guildId, userId }, existingMonitor.scope.generation, existingMonitor.capture, true)

    const capture: VoiceCaptureIdentity = { id: Symbol('discord-voice-capture') }

    const connection = activeSession?.connection ?? this.getVoiceConnection(guildId)
    const speakerAbortController = new AbortController()
    const abortSignal = activeSession
      ? AbortSignal.any([activeSession.abortController.signal, speakerAbortController.signal])
      : speakerAbortController.signal
    if (abortSignal.aborted)
      return

    const receiveStream = connection?.receiver.subscribe(userId, {
      autoDestroy: true,
      emitClose: true,
    })
    if (!receiveStream) {
      logVoiceLifecycle(this.logger, 'warn', {
        ...this.voiceLogOwner(scope),
        eventCode: 'monitor-stream-failed',
        failureCategory: 'receiver',
        retryable: true,
      })
      return
    }

    const opusDecoder = new OpusDecoder(DECODE_SAMPLE_RATE, 1)
    // Require sustained PCM energy rather than a single Discord speaking packet;
    // 20 ms keeps only one decoded frame because classic playback does not forward pre-roll.
    const classicInterruptionGate = new Pcm16InterruptionGate({
      confirmationMs: 120,
      preRollMs: 20,
      rmsThreshold: 0.05,
      sampleRate: DECODE_SAMPLE_RATE,
    })
    const realtimeInputGate = this.realtimeSessions.has(scopeKey)
      ? new Pcm16InputSafetyGate({
          confirmationMs: 120,
          preRollMs: 250,
          rmsThreshold: this.realtimeVoiceCallRuntime!.getInterruptionRmsThreshold(),
          sampleRate: DECODE_SAMPLE_RATE,
        })
      : undefined
    let realtimeBackpressureReported = false
    let realtimeGateReported = false
    let realtimeInputFailed = false
    let hasSuccessfulUserAppend = false

    const recordRealtimeGateStatus = (terminalStatus?: ReturnType<Pcm16InputSafetyGate['getStatus']>) => {
      const activeMonitor = this.activeMonitors.get(speakerKey)
      const diagnosticSession = this.diagnosticSessionFor(scope)
      if (!realtimeInputGate || !activeMonitor?.diagnosticTurnSequence || !diagnosticSession)
        return

      const status = terminalStatus ?? realtimeInputGate.getStatus()
      const stage = status === 'admitted'
        ? 'local-input-admitted'
        : status === 'rejected:below-threshold'
          ? 'local-input-rejected:below-threshold'
          : status === 'rejected:insufficient-duration'
            ? 'local-input-rejected:insufficient-duration'
            : status === 'rejected:incomplete-sample'
              ? 'local-input-rejected:incomplete-sample'
              : 'local-input-rejected:no-samples'
      this.recordVoiceDiagnostic({
        sessionSequence: diagnosticSession.diagnosticSessionSequence,
        stage,
        turnSequence: activeMonitor.diagnosticTurnSequence,
      })
      realtimeGateReported = true
    }

    /** Appends locally admitted PCM through one correlation and fail-closed path. */
    const appendRealtimeChunks = (acceptedChunks: Buffer[], activeMonitor: ScopedVoiceMonitor): boolean => {
      const realtimeSession = this.realtimeSessions.get(scopeKey)
      if (!realtimeSession?.provider || realtimeInputFailed)
        return false
      const inputSequence = activeMonitor.diagnosticTurnSequence
        ?? realtimeSession.activeProviderInputTurnSequence
      if (!inputSequence) {
        logVoiceLifecycle(this.logger, 'error', {
          ...this.voiceLogOwner(scope),
          eventCode: 'provider-correlation-rejected',
          failureCategory: 'provider',
          terminal: true,
        })
        realtimeInputFailed = true
        this.invalidateVoiceGeneration(scope, false)
        return false
      }
      const failProviderInputCapacity = () => {
        if (realtimeInputFailed)
          return false
        realtimeInputFailed = true
        const diagnosticSession = this.diagnosticSessionFor(scope)
        if (diagnosticSession) {
          this.recordVoiceDiagnostic({
            failureCategory: 'provider-input-capacity',
            sessionSequence: diagnosticSession.diagnosticSessionSequence,
            stage: 'failure',
            turnSequence: inputSequence,
          })
        }
        logVoiceLifecycle(this.logger, 'error', {
          ...this.voiceLogOwner(scope, inputSequence),
          eventCode: 'provider-correlation-rejected',
          failureCategory: 'capacity',
          terminal: true,
        })
        // This is a manager-owned correlation cap, before any provider input exists.
        this.invalidateVoiceGeneration(scope, false, 'failed')
        return false
      }
      for (const chunk of acceptedChunks) {
        const captureAppendStates = realtimeSession.captureAppendStates ??= new Map()
        let captureState = captureAppendStates.get(inputSequence)
        if (!captureState) {
          const activeUnacknowledgedReservations = Array.from(captureAppendStates.values())
            .filter(state => state.reservationHeld)
            .length
          // Active reservations and finished captures share one hard ownership bound.
          if (activeUnacknowledgedReservations + realtimeSession.finishedInputTurnSequences.length >= MAX_REALTIME_TURN_CORRELATIONS)
            return failProviderInputCapacity()
          captureState = {
            hasFormalProviderAck: false,
            hasSuccessfulUserAppend: false,
            reservationHeld: true,
          }
          captureAppendStates.set(inputSequence, captureState)
        }
        const inputAppendInvocations = realtimeSession.inputAppendInvocations ??= []
        if (inputAppendInvocations.length >= MAX_REALTIME_TURN_CORRELATIONS)
          return failProviderInputCapacity()
        const invocation: RealtimeAppendInvocation = {
          acknowledged: false,
          correlationEpoch: realtimeSession.correlationEpoch ?? 0,
          inputSequence,
        }
        inputAppendInvocations.push(invocation)
        let appended: boolean
        try {
          // Keep the original session instance so class methods retain their receiver and lifecycle state.
          appended = realtimeSession.provider.appendAudio(chunk, inputSequence)
        }
        catch {
          captureAppendStates.delete(inputSequence)
          realtimeInputFailed = true
          this.invalidateVoiceGeneration(scope, false)
          return false
        }
        finally {
          const index = inputAppendInvocations.lastIndexOf(invocation)
          if (index >= 0)
            inputAppendInvocations.splice(index, 1)
        }
        if (appended) {
          // appendAudio can synchronously re-enter through onInputAudioSent;
          // a rejected source callback retires this generation before it returns.
          if (
            this.realtimeSessions.get(scopeKey) !== realtimeSession
            || realtimeSession.terminated
            || (activeSession && !this.isVoiceSessionCurrent(activeSession))
          ) {
            realtimeInputFailed = true
            return false
          }
          hasSuccessfulUserAppend = true
          captureState.hasSuccessfulUserAppend = true
          continue
        }
        captureAppendStates.delete(inputSequence)
        if (!realtimeBackpressureReported) {
          realtimeBackpressureReported = true
          const diagnosticSession = this.diagnosticSessionFor(scope)
          if (diagnosticSession) {
            this.recordVoiceDiagnostic({
              failureCategory: 'provider-error',
              sessionSequence: diagnosticSession.diagnosticSessionSequence,
              stage: 'failure',
              turnSequence: activeMonitor.diagnosticTurnSequence,
            })
          }
          logVoiceLifecycle(this.logger, 'warn', {
            ...this.voiceLogOwner(scope, activeMonitor.diagnosticTurnSequence),
            eventCode: 'provider-input-backpressure',
            failureCategory: 'provider',
            retryable: true,
          })
        }
        realtimeInputFailed = true
        this.invalidateVoiceGeneration(scope, false)
        return false
      }
      return true
    }

    const receiveDataHandler = (packet: Buffer) => {
      const activeMonitor = this.activeMonitors.get(speakerKey)
      if (
        !activeMonitor?.admitted
        || activeMonitor.capture !== capture
        || activeMonitor.scope.generation !== scope.generation
      ) {
        return
      }

      activeMonitor.opusPackets = Math.min(65_535, activeMonitor.opusPackets + 1)
      activeMonitor.opusBytes = Math.min(65_535, activeMonitor.opusBytes + packet.length)
    }

    const dataHandler = (pcmData: Buffer) => {
      if (abortSignal.aborted || (activeSession && !this.isVoiceSessionCurrent(activeSession)))
        return

      const activeMonitor = this.activeMonitors.get(speakerKey)
      if (
        !activeMonitor?.admitted
        || activeMonitor.capture !== capture
        || activeMonitor.scope.generation !== scope.generation
        || !this.isSpeakerAllowed({ channelId, guildId, userId }, activeSession, activeMonitor.discordVoiceSessionId)
      ) {
        if (activeMonitor)
          this.stopMonitoringMember({ channelId, guildId, userId }, scope.generation, capture, true)
        return
      }

      activeMonitor.pcmFrames = Math.min(65_535, activeMonitor.pcmFrames + 1)
      activeMonitor.pcmBytes = Math.min(65_535, activeMonitor.pcmBytes + pcmData.length)
      if (activeMonitor.pcmFrames === 1)
        this.recordMonitorAudio(activeMonitor)

      const realtimeSession = this.realtimeSessions.get(scopeKey)
      if (realtimeSession?.provider && realtimeInputGate) {
        const acceptedChunks = realtimeInputGate.push(pcmData)
        if (!acceptedChunks)
          return

        if (!realtimeGateReported)
          recordRealtimeGateStatus()

        appendRealtimeChunks(acceptedChunks, activeMonitor)
        return
      }

      // Monitor the audio volume while the agent is speaking.
      // If the average volume of the user's audio exceeds the defined threshold, it indicates active speaking.
      // When active speaking is detected, stop the agent's current audio playback to avoid overlap.

      const classicPlayback = this.activeClassicPlaybacks.get(scopeKey)
      if (classicPlayback) {
        if (classicPlayback.player.state.status === 'idle') {
          this.cleanupClassicPlayback(scope, classicPlayback)
          return
        }
        if (classicInterruptionGate.push(pcmData)) {
          classicInterruptionGate.reset()
          this.cleanupClassicPlayback(scope, classicPlayback)
        }
      }
    }
    const speakingStartedHandler = () => {
      if (abortSignal.aborted)
        return
      classicInterruptionGate.reset()
      realtimeInputGate?.reset()
      realtimeBackpressureReported = false
      realtimeGateReported = false
      realtimeInputFailed = false
      hasSuccessfulUserAppend = false
      this.realtimeSessions.get(scopeKey)?.provider?.pauseInputFinish?.()
    }
    const speakingStoppedHandler = () => {
      const activeMonitor = this.activeMonitors.get(speakerKey)
      if (!realtimeInputGate || !activeMonitor)
        return
      const finalization = realtimeInputGate.finalize()
      if (!realtimeGateReported || finalization.status !== 'admitted')
        recordRealtimeGateStatus(finalization.status)
      if (finalization.status !== 'admitted') {
        if (hasSuccessfulUserAppend && !realtimeInputFailed) {
          realtimeInputFailed = true
          this.invalidateVoiceGeneration(scope, false)
        }
        activeMonitor.finishing = false
        return
      }
      if (finalization.released.length > 0 && !appendRealtimeChunks(finalization.released, activeMonitor))
        return
      const realtimeSession = this.realtimeSessions.get(scopeKey)
      const inputSequence = activeMonitor.diagnosticTurnSequence
      const captureState = inputSequence === undefined
        ? undefined
        : realtimeSession?.captureAppendStates?.get(inputSequence)
      if (realtimeSession && inputSequence && hasSuccessfulUserAppend && captureState?.hasSuccessfulUserAppend) {
        if (captureState.hasFormalProviderAck) {
          realtimeSession.captureAppendStates?.delete(inputSequence)
        }
        else if (captureState.reservationHeld && !realtimeSession.finishedInputTurnSequences.includes(inputSequence)) {
          // The preflight reservation moves to the finished FIFO without a second capacity race.
          captureState.reservationHeld = false
          realtimeSession.finishedInputTurnSequences.push(inputSequence)
          realtimeSession.captureAppendStates?.delete(inputSequence)
        }
        else {
          realtimeInputFailed = true
          this.invalidateVoiceGeneration(scope, false)
          return
        }
      }
      activeMonitor.finishing = false
    }

    this.streams.set(speakerKey, opusDecoder)

    const errorHandler = () => {
      logVoiceLifecycle(this.logger, 'error', {
        ...this.voiceLogOwner(scope, this.activeMonitors.get(speakerKey)?.diagnosticTurnSequence),
        eventCode: 'receiver-decoder-error',
        failureCategory: 'receiver',
        terminal: true,
      })
      const diagnosticSession = this.diagnosticSessionFor(scope)
      const diagnosticTurn = this.activeMonitors.get(speakerKey)?.diagnosticTurnSequence
      if (diagnosticSession) {
        this.recordVoiceDiagnostic({
          failureCategory: 'receiver-error',
          sessionSequence: diagnosticSession.diagnosticSessionSequence,
          stage: 'failure',
          turnSequence: diagnosticTurn,
        })
      }
    }
    const streamCloseHandler = () => {
      logVoiceLifecycle(this.logger, 'log', {
        ...this.voiceLogOwner(scope, this.activeMonitors.get(speakerKey)?.diagnosticTurnSequence),
        eventCode: 'receiver-stream-closed',
      })

      if (this.streams.get(speakerKey) === opusDecoder)
        this.streams.delete(speakerKey)
      try {
        this.stopMonitoringMember({ channelId, guildId, userId }, scope.generation, capture)
      }
      catch {
        logVoiceLifecycle(this.logger, 'error', {
          ...this.voiceLogOwner(scope, this.activeMonitors.get(speakerKey)?.diagnosticTurnSequence),
          eventCode: 'receiver-stream-cleanup-failed',
          failureCategory: 'cleanup',
          terminal: true,
        })
      }
    }
    const closeHandler = () => {
      logVoiceLifecycle(this.logger, 'log', {
        ...this.voiceLogOwner(scope, this.activeMonitors.get(speakerKey)?.diagnosticTurnSequence),
        eventCode: 'receiver-decoder-closed',
      })

      opusDecoder.removeListener('data', dataHandler)
      opusDecoder.removeListener('error', errorHandler)
      opusDecoder.removeListener('close', closeHandler)
      opusDecoder.removeListener('speakingStarted', speakingStartedHandler)
      opusDecoder.removeListener('speakingStopped', speakingStoppedHandler)
      receiveStream?.removeListener('data', receiveDataHandler)
      receiveStream?.removeListener('close', streamCloseHandler)
    }
    let captureStopped = false
    const stopCapture = () => {
      if (captureStopped)
        return
      captureStopped = true
      let cleanupFailed = false
      let firstCleanupError: unknown
      const cleanup = (operation: () => void) => {
        try {
          operation()
        }
        catch (error) {
          if (!cleanupFailed) {
            cleanupFailed = true
            firstCleanupError = error
          }
        }
      }
      cleanup(() => speakerAbortController.abort(new Error('Discord speaker capture stopped.')))

      // Withdrawal and policy revocation must close the Discord receiver itself;
      // detaching buffer listeners alone leaves native audio capture and Opus decode alive.
      cleanup(() => opusDecoder.removeListener('data', dataHandler))
      cleanup(() => opusDecoder.removeListener('error', errorHandler))
      cleanup(() => opusDecoder.removeListener('close', closeHandler))
      cleanup(() => opusDecoder.removeListener('speakingStarted', speakingStartedHandler))
      cleanup(() => opusDecoder.removeListener('speakingStopped', speakingStoppedHandler))
      cleanup(() => receiveStream.removeListener('data', receiveDataHandler))
      cleanup(() => receiveStream.removeListener('close', streamCloseHandler))
      cleanup(() => receiveStream.destroy())
      cleanup(() => opusDecoder.destroy())
      if (cleanupFailed)
        throw firstCleanupError
    }

    opusDecoder.on('data', dataHandler)
    opusDecoder.on('error', errorHandler)
    opusDecoder.on('close', closeHandler)
    opusDecoder.on('speakingStarted', speakingStartedHandler)
    opusDecoder.on('speakingStopped', speakingStoppedHandler)
    receiveStream?.on('data', receiveDataHandler)
    receiveStream?.on('close', streamCloseHandler)

    pipeline(receiveStream, opusDecoder, (error) => {
      if (!error || captureStopped)
        return

      // Malformed or truncated voice packets must terminate only this user's monitor,
      // never throw from the asynchronous pipeline callback and crash the bot process.
      logVoiceLifecycle(this.logger, 'error', {
        ...this.voiceLogOwner(scope, this.activeMonitors.get(speakerKey)?.diagnosticTurnSequence),
        eventCode: 'receiver-pipeline-error',
        failureCategory: 'receiver',
        terminal: true,
      })
      const diagnosticSession = this.diagnosticSessionFor(scope)
      const diagnosticTurn = this.activeMonitors.get(speakerKey)?.diagnosticTurnSequence
      if (diagnosticSession) {
        this.recordVoiceDiagnostic({
          failureCategory: 'receiver-error',
          sessionSequence: diagnosticSession.diagnosticSessionSequence,
          stage: 'failure',
          turnSequence: diagnosticTurn,
        })
      }
      try {
        this.stopMonitoringMember({ channelId, guildId, userId }, scope.generation, capture)
      }
      catch {
        logVoiceLifecycle(this.logger, 'error', {
          ...this.voiceLogOwner(scope, this.activeMonitors.get(speakerKey)?.diagnosticTurnSequence),
          eventCode: 'receiver-stream-cleanup-failed',
          failureCategory: 'cleanup',
          terminal: true,
        })
      }
    })

    logVoiceLifecycle(this.logger, 'log', {
      ...this.voiceLogOwner(scope, activeSession?.currentDiagnosticTurnSequence),
      eventCode: 'monitor-started',
    })
    if (this.realtimeSessions.has(scopeKey)) {
      this.activeMonitors.set(speakerKey, {
        admitted: false,
        capture,
        diagnosticTurnSequence: activeSession?.currentDiagnosticTurnSequence,
        discordVoiceSessionId,
        finishing: false,
        opusBytes: 0,
        opusPackets: 0,
        pcmBytes: 0,
        pcmFrames: 0,
        scope,
        stop: stopCapture,
        userId,
      })
      return
    }

    await this.handleUserStream({
      abortSignal,
      audioStream: opusDecoder,
      capture,
      connection: connection as VoiceConnection,
      discordVoiceSessionId,
      scope,
      speaker,
      stopCapture,
      userId,
    })
  }

  private disconnectChannel(
    channelId: string,
    connection?: VoiceConnection,
    clearConsent = true,
    diagnosticReason: VoiceDiagnosticCleanupReason = 'dismissed',
  ) {
    const activeSession = [...this.activeVoiceSessionsByGuildId.values()]
      .find(session => session.channel.id === channelId && (!connection || session.connection === connection))
    if (activeSession) {
      this.releaseVoiceSession(activeSession, clearConsent, diagnosticReason)
      return
    }

    if (connection) {
      // Remove event listeners to prevent memory leaks
      for (const [scopeKey, listeners] of this.connectionListeners) {
        if (listeners.scope.channelId !== channelId || listeners.connection !== connection)
          continue

        listeners.connection.off('stateChange', listeners.stateChange)
        listeners.connection.off('error', listeners.error)
        listeners.connection.receiver.speaking.off('start', listeners.speakingStart)
        listeners.connection.receiver.speaking.off('end', listeners.speakingEnd)
        this.connectionListeners.delete(scopeKey)
      }

      if (connection.state.status !== VoiceConnectionStatus.Destroyed)
        connection.destroy()
      if (this.connections.get(channelId) === connection)
        this.connections.delete(channelId)
    }

    for (const realtimeSession of this.realtimeSessions.values()) {
      if (realtimeSession.scope.channelId === channelId)
        this.closeRealtimeSession(realtimeSession.scope)
    }
    for (const playback of this.activeClassicPlaybacks.values()) {
      if (playback.scope.channelId === channelId)
        this.cleanupClassicPlayback(playback.scope, playback)
    }

    // Stop monitoring all members in this channel
    for (const monitorInfo of this.activeMonitors.values()) {
      if (monitorInfo.scope.channelId === channelId && monitorInfo.userId !== this.client.user?.id) {
        this.stopMonitoringMember({
          channelId,
          guildId: monitorInfo.scope.guildId,
          userId: monitorInfo.userId,
        }, monitorInfo.scope.generation)
      }
    }

    if (clearConsent) {
      const consentSession = [...this.consentSessions.values()].find(session => session.channel.id === channelId)
      if (consentSession)
        this.clearConsentSessionForGuild(consentSession.channel.guild.id)
    }
  }

  leaveChannel(channel: BaseGuildVoiceChannel) {
    this.disconnectChannel(channel.id, this.connections.get(channel.id))
    logVoiceLifecycle(this.logger, 'log', {
      eventCode: 'session-dismissed',
    })
  }

  private stopMonitoringMember(
    input: RealtimeVoiceSpeakerInput,
    generation?: number,
    expectedCapture?: VoiceCaptureIdentity,
    abortFinishingInput = false,
    skipRealtimeProviderCleanup = false,
  ) {
    if (generation === undefined) {
      const matchingGenerations = new Set<number>()
      for (const monitor of this.activeMonitors.values()) {
        if (
          monitor.scope.guildId === input.guildId
          && monitor.scope.channelId === input.channelId
          && monitor.userId === input.userId
        ) {
          matchingGenerations.add(monitor.scope.generation)
        }
      }
      for (const state of this.userStates.values()) {
        if (
          state.scope.guildId === input.guildId
          && state.scope.channelId === input.channelId
          && state.userId === input.userId
        ) {
          matchingGenerations.add(state.scope.generation)
        }
      }
      for (const matchingGeneration of matchingGenerations)
        this.stopMonitoringMember(input, matchingGeneration, undefined, abortFinishingInput, skipRealtimeProviderCleanup)
      return
    }

    const speakerKey = speakerScopeKey({ ...input, generation }, input.userId)
    const monitorInfo = this.activeMonitors.get(speakerKey)
    if (monitorInfo && generation !== undefined && monitorInfo.scope.generation !== generation)
      return

    const state = this.userStates.get(speakerKey)
    if (!monitorInfo && generation !== undefined && state && state.scope.generation !== generation)
      return

    const ownsMonitor = !expectedCapture || monitorInfo?.capture === expectedCapture
    const ownsState = !expectedCapture || state?.capture === expectedCapture
    if (expectedCapture && !ownsMonitor && !ownsState)
      return

    const abortsPendingRealtimeInput = Boolean(
      !skipRealtimeProviderCleanup
      && monitorInfo
      && ownsMonitor
      && (monitorInfo.admitted || (abortFinishingInput && monitorInfo.finishing)),
    )
    if (monitorInfo && ownsMonitor) {
      monitorInfo.admitted = false
      monitorInfo.finishing = false
      this.activeMonitors.delete(speakerKey)
    }
    const classicBoundary = this.classicVoiceTurnBoundaries.get(speakerKey)
    if (ownsState && state && classicBoundary?.state === state)
      this.cancelClassicVoiceTurn(classicBoundary, 'cancelled')
    if (ownsMonitor || ownsState)
      this.streams.delete(speakerKey)
    if (state && ownsState)
      this.userStates.delete(speakerKey)
    if (ownsState) {
      const timeout = this.transcriptionTimeouts.get(speakerKey)
      if (timeout)
        clearTimeout(timeout)
      this.transcriptionTimeouts.delete(speakerKey)
      if (!state || this.processingUsers.get(speakerKey) === state)
        this.processingUsers.delete(speakerKey)
    }
    let cleanupFailed = false
    let firstCleanupError: unknown
    const cleanup = (operation: () => void) => {
      try {
        operation()
      }
      catch (error) {
        if (!cleanupFailed) {
          cleanupFailed = true
          firstCleanupError = error
        }
      }
    }
    if (ownsMonitor && monitorInfo)
      cleanup(monitorInfo.stop)
    if (abortsPendingRealtimeInput && monitorInfo) {
      const hasAnotherPendingSpeaker = [...this.activeMonitors.values()].some((candidate) => {
        return (candidate.admitted || candidate.finishing)
          && voiceScopeKey(candidate.scope) === voiceScopeKey(monitorInfo.scope)
      })
      if (!hasAnotherPendingSpeaker) {
        const provider = this.realtimeSessions.get(voiceScopeKey(monitorInfo.scope))?.provider
        if (provider?.abortInput)
          cleanup(() => provider.abortInput?.())
        if (provider)
          cleanup(() => provider.cancelResponse())
        cleanup(() => this.interruptRealtimePlayback(monitorInfo.scope))
      }
    }
    logVoiceLifecycle(this.logger, 'log', {
      ...(monitorInfo ? this.voiceLogOwner(monitorInfo.scope, monitorInfo.diagnosticTurnSequence) : {}),
      eventCode: 'monitor-stopped',
    })
    if (cleanupFailed)
      throw firstCleanupError
  }

  /** Stops every active voice resource and drains provider connects owned by the invalidated generations. */
  stop(): Promise<void> {
    if (this.stopTask)
      return this.stopTask

    const task = (async () => {
      const pendingClassicTurns = [...this.pendingClassicVoiceTurnTasks]
      // Snapshot joins before invalidating their sessions. A join may already
      // have installed provider/listener state and then pause in Discord voice
      // setup; stop is not complete until that owning task observes abort and exits.
      const pendingVoiceJoins = [...this.pendingVoiceJoinTasks]
      let cleanupFailed = false
      let firstCleanupError: unknown
      const cleanup = (operation: () => void) => {
        try {
          operation()
        }
        catch (error) {
          if (!cleanupFailed) {
            cleanupFailed = true
            firstCleanupError = error
          }
        }
      }

      for (const session of Array.from(this.activeVoiceSessionsByGuildId.values()))
        cleanup(() => this.releaseVoiceSession(session, true, 'stopped'))

      for (const listeners of Array.from(this.connectionListeners.values())) {
        cleanup(() => listeners.connection.off('stateChange', listeners.stateChange))
        cleanup(() => listeners.connection.off('error', listeners.error))
        cleanup(() => listeners.connection.receiver.speaking.off('start', listeners.speakingStart))
        cleanup(() => listeners.connection.receiver.speaking.off('end', listeners.speakingEnd))
      }

      for (const monitor of Array.from(this.activeMonitors.values())) {
        cleanup(() => this.stopMonitoringMember({
          channelId: monitor.scope.channelId,
          guildId: monitor.scope.guildId,
          userId: monitor.userId,
        }, monitor.scope.generation, undefined, false, this.realtimeSessions.has(voiceScopeKey(monitor.scope))))
      }
      for (const timeout of this.transcriptionTimeouts.values())
        cleanup(() => clearTimeout(timeout))
      for (const boundary of Array.from(this.classicVoiceTurnBoundaries.values()))
        cleanup(() => this.cancelClassicVoiceTurn(boundary, 'cancelled'))
      for (const connection of new Set(this.connections.values())) {
        cleanup(() => {
          if (connection.state.status !== VoiceConnectionStatus.Destroyed)
            connection.destroy()
        })
      }

      for (const playback of Array.from(this.activeClassicPlaybacks.values()))
        cleanup(() => this.cleanupClassicPlayback(playback.scope, playback))
      for (const realtimeSession of Array.from(this.realtimeSessions.values()))
        cleanup(() => this.closeRealtimeSession(realtimeSession.scope))
      this.connectionListeners.clear()
      this.activeMonitors.clear()
      this.activeClassicPlaybacks.clear()
      this.activeRealtimePlaybacks.clear()
      this.classicVoiceTurnBoundaries.clear()
      this.transcriptionTimeouts.clear()
      this.processingUsers.clear()
      this.streams.clear()
      this.connections.clear()
      this.userStates.clear()
      this.activeVoiceSessionsByGuildId.clear()
      this.consentSessionIdByGuildId.clear()
      this.consentSessions.clear()

      const pendingConnects = [...this.pendingRealtimeConnectTasks]
      const pendingResults = await Promise.allSettled([
        ...pendingClassicTurns,
        ...pendingConnects,
        ...pendingVoiceJoins,
      ])
      this.pendingClassicVoiceTurnTasks.clear()
      for (const result of pendingResults) {
        if (result.status === 'rejected' && !cleanupFailed) {
          cleanupFailed = true
          firstCleanupError = result.reason
        }
      }

      if (cleanupFailed)
        throw firstCleanupError
    })()
    const trackedTask = task.finally(() => {
      if (this.stopTask === trackedTask)
        this.stopTask = undefined
    })
    this.stopTask = trackedTask
    return trackedTask
  }

  async debouncedProcessTranscription(
    speakerKey: string,
  ) {
    const DEBOUNCE_TRANSCRIPTION_THRESHOLD = 1500 // wait for 1.5 seconds of silence
    const state = this.userStates.get(speakerKey)
    if (!state || state.abortSignal.aborted)
      return

    const playback = this.activeClassicPlaybacks.get(voiceScopeKey(state.scope))
    if (playback?.player.state.status === 'idle') {
      logVoiceLifecycle(this.logger, 'log', {
        ...this.voiceLogOwner(state.scope),
        eventCode: 'playback-completed',
      })
      this.cleanupClassicPlayback(state.scope, playback)
    }
    if (
      this.activeClassicPlaybacks.has(voiceScopeKey(state.scope))
      || this.processingUsers.get(speakerKey) === state
    ) {
      state.buffers.length = 0
      state.totalLength = 0
      return
    }

    const existingTimeout = this.transcriptionTimeouts.get(speakerKey)
    if (existingTimeout)
      clearTimeout(existingTimeout)

    const timeout = setTimeout(async () => {
      if (this.transcriptionTimeouts.get(speakerKey) === timeout)
        this.transcriptionTimeouts.delete(speakerKey)
      if (state.abortSignal.aborted || this.userStates.get(speakerKey) !== state)
        return

      const task = (async () => {
        this.processingUsers.set(speakerKey, state)
        try {
          await this.processTranscription(speakerKey, state)
        }
        finally {
          if (this.processingUsers.get(speakerKey) === state)
            this.processingUsers.delete(speakerKey)
        }
      })()
      this.pendingClassicVoiceTurnTasks.add(task)
      try {
        await task
      }
      catch {
        logVoiceLifecycle(this.logger, 'error', {
          ...this.voiceLogOwner(state.scope),
          eventCode: 'classic-turn-failed',
          failureCategory: 'internal',
          terminal: true,
        })
      }
      finally {
        this.pendingClassicVoiceTurnTasks.delete(task)
      }
    }, DEBOUNCE_TRANSCRIPTION_THRESHOLD)
    this.transcriptionTimeouts.set(speakerKey, timeout)
  }

  private async handleUserStream(input: {
    abortSignal: AbortSignal
    audioStream: Readable
    capture?: VoiceCaptureIdentity
    connection: VoiceConnection
    discordVoiceSessionId?: string
    scope: VoicePlaybackScope
    speaker: VoiceSpeakerIdentity
    stopCapture: () => void
    userId: string
  }) {
    const { abortSignal, audioStream, connection, discordVoiceSessionId, scope, speaker, stopCapture, userId } = input
    const capture = input.capture ?? { id: Symbol('discord-voice-capture') }
    const speakerKey = speakerScopeKey(scope, userId)
    logVoiceLifecycle(this.logger, 'log', {
      ...this.voiceLogOwner(scope),
      eventCode: 'monitor-started',
    })

    const state: VoiceUserState = {
      abortSignal,
      buffers: [],
      capture,
      connection,
      lastActive: Date.now(),
      scope,
      speaker,
      totalLength: 0,
      transcriptionText: '',
      userId,
    }
    this.userStates.set(speakerKey, state)

    const processBuffer = async (buffer: Buffer) => {
      try {
        if (abortSignal.aborted || this.userStates.get(speakerKey) !== state)
          return

        state.buffers.push(buffer)
        state.totalLength += buffer.length
        state.lastActive = Date.now()

        // Keep at most the newest 10 MB per speaker while waiting for the
        // transcription debounce. Continuous speech must not grow memory without bound.
        const maxBufferedAudioBytes = 10_000_000
        while (state.totalLength > maxBufferedAudioBytes && state.buffers.length > 0) {
          const first = state.buffers[0]
          const overflow = state.totalLength - maxBufferedAudioBytes
          if (first.length <= overflow) {
            state.buffers.shift()
            state.totalLength -= first.length
            continue
          }

          state.buffers[0] = first.subarray(overflow)
          state.totalLength -= overflow
        }

        await this.debouncedProcessTranscription(speakerKey)
      }
      catch {
        logVoiceLifecycle(this.logger, 'error', {
          ...this.voiceLogOwner(scope, this.activeMonitors.get(speakerKey)?.diagnosticTurnSequence),
          eventCode: 'monitor-buffer-failed',
          failureCategory: 'receiver',
          terminal: true,
        })
      }
    }

    const monitor = new AudioMonitor(
      audioStream,
      10000000,
      () => {
        if (this.userStates.get(speakerKey) !== state)
          return
        const timeout = this.transcriptionTimeouts.get(speakerKey)
        if (timeout)
          clearTimeout(timeout)
        this.transcriptionTimeouts.delete(speakerKey)
      },
      async (buffer) => {
        if (!buffer) {
          logVoiceLifecycle(this.logger, 'warn', {
            ...this.voiceLogOwner(scope, this.activeMonitors.get(speakerKey)?.diagnosticTurnSequence),
            eventCode: 'monitor-empty-buffer',
            failureCategory: 'receiver',
            retryable: true,
          })
          return
        }

        await processBuffer(buffer)
      },
    )
    this.activeMonitors.set(speakerKey, {
      admitted: false,
      capture,
      diagnosticTurnSequence: this.diagnosticSessionFor(scope)?.currentDiagnosticTurnSequence,
      discordVoiceSessionId,
      finishing: false,
      opusBytes: 0,
      opusPackets: 0,
      pcmBytes: 0,
      pcmFrames: 0,
      scope,
      stop: () => {
        monitor.stop()
        stopCapture()
      },
      userId,
    })
  }

  private async processTranscription(
    speakerKey: string,
    state: VoiceUserState,
  ) {
    const existingBoundary = this.classicVoiceTurnBoundaries.get(speakerKey)
    if (
      state.abortSignal.aborted
      || this.userStates.get(speakerKey) !== state
      || state.buffers.length === 0
    ) {
      if (existingBoundary?.state === state)
        this.finishClassicVoiceTurn(existingBoundary)
      return
    }

    if (!existingBoundary || existingBoundary.state !== state) {
      // Only speaking admission may mint a classic turn deadline. Processing
      // buffered audio without that boundary would silently renew an expired or
      // revoked turn and disclose stale audio to STT.
      this.discardClassicVoiceTurnInput(state)
      return
    }
    const boundary = existingBoundary
    if (!this.isClassicVoiceTurnCurrent(boundary)) {
      this.cancelClassicVoiceTurn(
        boundary,
        boundary.deadlineAt <= Date.now() ? 'timeout' : 'cancelled',
      )
      return
    }
    try {
      const inputBuffer = Buffer.concat(state.buffers, state.totalLength)

      state.buffers.length = 0 // Clear the buffers
      state.totalLength = 0

      // Convert Opus to WAV
      const wavBuffer = await convertOpusToWav(inputBuffer)
      if (!this.isClassicVoiceTurnCurrent(boundary))
        return

      const result = await this.waitForClassicVoiceTurnOperation(
        this.transcribeAudio(wavBuffer, {
          abortSignal: boundary.signal,
          deadlineAt: boundary.deadlineAt,
          ownerKey: boundary.ownerKey,
          principalKey: boundary.principalKey,
        }),
        boundary,
        'stt',
      )
      if (!this.isClassicVoiceTurnCurrent(boundary))
        return

      const transcriptionText = result

      if (transcriptionText && isValidTranscription(transcriptionText)) {
        state.transcriptionText += transcriptionText
      }
      if (state.transcriptionText.length) {
        this.cleanupClassicPlayback(state.scope)
        const finalText = state.transcriptionText
        state.transcriptionText = ''

        logVoiceLifecycle(this.logger, 'log', {
          ...this.voiceLogOwner(state.scope, boundary.state.capture === state.capture ? this.activeMonitors.get(speakerKey)?.diagnosticTurnSequence : undefined),
          characterCount: finalText.length,
          eventCode: 'transcription-complete',
        })
        const audioStream = await this.waitForClassicVoiceTurnOperation(
          this.handleTranscription({
            abortSignal: boundary.signal,
            channelId: state.scope.channelId,
            deadlineAt: boundary.deadlineAt,
            guildId: state.scope.guildId,
            rateLimitAdmitted: true,
            speaker: state.speaker,
            speechProviderOwnerKey: boundary.ownerKey,
            speechProviderPrincipalKey: boundary.principalKey,
            text: finalText,
            userId: state.userId,
          }),
          boundary,
          'chat-tts',
          audioStream => audioStream?.destroy(),
        )
        if (!this.isClassicVoiceTurnCurrent(boundary)) {
          audioStream?.destroy()
          return
        }
        if (audioStream) {
          await this.playAudioStream(
            state.connection,
            audioStream,
            boundary.signal,
            state.scope,
            boundary.deadlineAt,
          )
        }
      }
    }
    catch (error) {
      logVoiceLifecycle(this.logger, 'warn', {
        ...this.voiceLogOwner(state.scope, this.activeMonitors.get(speakerKey)?.diagnosticTurnSequence),
        eventCode: 'classic-turn-failed',
        failureCategory: error instanceof SpeechProviderRequestError
          ? error.kind === 'provider-failure' ? 'provider' : error.kind
          : 'internal',
        terminal: true,
      })
    }
    finally {
      this.finishClassicVoiceTurn(boundary)
    }
  }

  /**
   * Starts classic TTS playback on the connection captured by one voice generation.
   *
   * Use when:
   * - A completed classic STT/chat turn returns a synthesized audio stream.
   * - Playback must coexist with unrelated guild/channel sessions.
   *
   * Expects:
   * - `scope` identifies the same immutable generation as `abortSignal` and `connection`.
   * - `deadlineAt` is the absolute deadline minted when this classic turn was admitted.
   * - The caller destroys or aborts the generation when its channel lifecycle ends.
   *
   * Returns:
   * - A promise that resolves after the scoped player is subscribed and started.
   */
  async playAudioStream(
    connection: VoiceConnection,
    audioStream: Readable,
    abortSignal: AbortSignal,
    scope: VoicePlaybackScope,
    deadlineAt: number,
  ) {
    const assertBeforeDeadline = () => {
      if (deadlineAt <= Date.now())
        throw new SpeechProviderRequestError('timeout', 'synthesis')
    }
    let playback: ScopedClassicPlayback | undefined
    try {
      // Timers are scheduling hints, not deadline authority. Date gates before
      // and after every synchronous external handoff prevent a blocked callback
      // from starting playback after the absolute turn deadline.
      assertBeforeDeadline()
      if (abortSignal.aborted) {
        audioStream.destroy()
        return
      }
      // Take over the exact scope before constructing a replacement. If old
      // cleanup fails, the catch path still releases the incoming unowned stream.
      this.cleanupClassicPlayback(scope)
      assertBeforeDeadline()
      if (abortSignal.aborted) {
        audioStream.destroy()
        return
      }

      const audioPlayer = createAudioPlayer({
        behaviors: {
          noSubscriber: NoSubscriberBehavior.Pause,
        },
      })
      assertBeforeDeadline()
      playback = {
        abortSignal,
        audioStream,
        cleaned: false,
        player: audioPlayer,
        scope,
        stopAbortedPlayback: () => {},
      }
      const ownedPlayback = playback
      const cleanupPlaybackFromCallback = () => {
        try {
          this.cleanupClassicPlayback(scope, ownedPlayback)
        }
        catch {
          logVoiceLifecycle(this.logger, 'error', {
            ...this.voiceLogOwner(scope),
            eventCode: 'classic-playback-callback-cleanup-failed',
            failureCategory: 'cleanup',
            terminal: true,
          })
        }
      }
      ownedPlayback.stopAbortedPlayback = cleanupPlaybackFromCallback
      this.activeClassicPlaybacks.set(voiceScopeKey(scope), ownedPlayback)

      // Register cancellation before any external startup boundary. Each
      // synchronous boundary is followed by a gate because provider/voice mocks
      // and future runtimes may invalidate this generation re-entrantly.
      abortSignal.addEventListener('abort', ownedPlayback.stopAbortedPlayback, { once: true })
      assertBeforeDeadline()
      if (abortSignal.aborted || ownedPlayback.cleaned) {
        this.cleanupClassicPlayback(scope, ownedPlayback)
        return
      }
      const subscription = connection.subscribe(audioPlayer)
      ownedPlayback.subscription = subscription
      assertBeforeDeadline()
      if (abortSignal.aborted || ownedPlayback.cleaned) {
        if (ownedPlayback.cleaned)
          subscription?.unsubscribe()
        this.cleanupClassicPlayback(scope, ownedPlayback)
        return
      }

      const audioStartTime = Date.now()
      assertBeforeDeadline()
      const resource = await createClassicDiscordVoiceAudioResource(audioStream)
      assertBeforeDeadline()
      if (abortSignal.aborted || ownedPlayback.cleaned) {
        this.cleanupClassicPlayback(scope, ownedPlayback)
        return
      }

      audioPlayer.on('error', () => {
        logVoiceLifecycle(this.logger, 'error', {
          ...this.voiceLogOwner(scope),
          eventCode: 'classic-playback-error',
          failureCategory: 'playback',
          terminal: true,
        })
        cleanupPlaybackFromCallback()
      })
      audioPlayer.on('stateChange', (_oldState: AudioPlayerState, newState: AudioPlayerState) => {
        if (newState.status === 'idle') {
          abortSignal.removeEventListener('abort', ownedPlayback.stopAbortedPlayback)
          const idleTime = Date.now()
          logVoiceLifecycle(this.logger, 'log', {
            ...this.voiceLogOwner(scope),
            elapsedMs: idleTime - audioStartTime,
            eventCode: 'classic-playback-completed',
          })
          cleanupPlaybackFromCallback()
        }
      })
      if (abortSignal.aborted || ownedPlayback.cleaned) {
        this.cleanupClassicPlayback(scope, ownedPlayback)
        return
      }

      assertBeforeDeadline()
      audioPlayer.play(resource)
    }
    catch (startupError) {
      let rollbackFailed = false
      let rollbackError: unknown
      try {
        if (playback)
          this.cleanupClassicPlayback(scope, playback)
        else if (!audioStream.destroyed)
          audioStream.destroy()
      }
      catch (cleanupError) {
        rollbackFailed = true
        rollbackError = cleanupError
        logVoiceLifecycle(this.logger, 'error', {
          ...this.voiceLogOwner(scope),
          eventCode: 'classic-playback-rollback-failed',
          failureCategory: 'cleanup',
          terminal: true,
        })
      }
      if (rollbackFailed) {
        throw new AggregateError(
          [startupError, rollbackError],
          'Classic Discord playback startup failed and rollback also failed.',
        )
      }
      throw startupError
    }
  }

  private cleanupClassicPlayback(scope: VoicePlaybackScope, expectedPlayback?: ScopedClassicPlayback): void {
    const scopeKey = voiceScopeKey(scope)
    const playback = expectedPlayback ?? this.activeClassicPlaybacks.get(scopeKey)
    if (!playback || playback.cleaned)
      return
    playback.cleaned = true

    let cleanupFailed = false
    let firstCleanupError: unknown
    const cleanup = (operation: () => void) => {
      try {
        operation()
      }
      catch (error) {
        if (!cleanupFailed) {
          cleanupFailed = true
          firstCleanupError = error
        }
      }
    }

    if (this.activeClassicPlaybacks.get(scopeKey) === playback)
      this.activeClassicPlaybacks.delete(scopeKey)
    cleanup(() => playback.abortSignal.removeEventListener('abort', playback.stopAbortedPlayback))
    if (playback.subscription)
      cleanup(() => playback.subscription?.unsubscribe())
    if (!playback.audioStream.destroyed)
      cleanup(() => playback.audioStream.destroy())
    cleanup(() => playback.player.stop())
    cleanup(() => playback.player.removeAllListeners())
    if (cleanupFailed)
      throw firstCleanupError
  }

  async handleJoinChannelCommand(interaction: ChatInputCommandInteraction<CacheType>) {
    if (!interaction.inCachedGuild()) {
      await interaction.reply('This command can only be used in a server voice channel.')
      return
    }

    try {
      const currVoiceChannel = interaction.member.voice.channel
      if (!currVoiceChannel) {
        await interaction.reply('Please join a voice channel first.')
        return
      }

      const existingConsentSessionId = this.consentSessionIdByGuildId.get(currVoiceChannel.guild.id)
      const replacesExistingConsentOwner = existingConsentSessionId !== undefined
        && this.consentSessions.has(existingConsentSessionId)
      if (
        !replacesExistingConsentOwner
        && this.consentSessions.size >= MAX_VOICE_CONSENT_SESSION_OWNERS
      ) {
        await interaction.reply(VOICE_CAPACITY_STATUS)
        return
      }

      const activeSession = this.activeVoiceSessionsByGuildId.get(currVoiceChannel.guild.id)
      if (activeSession)
        this.releaseVoiceSession(activeSession, true)
      else
        this.clearConsentSessionForGuild(currVoiceChannel.guild.id)

      const session: VoiceConsentSession = {
        channel: currVoiceChannel,
        consentedUserIds: new Set(),
        // Discord interaction snowflakes do not repeat across process restarts,
        // so stale disclosure buttons cannot authorize a later `/summon` session.
        id: `${currVoiceChannel.guild.id}-${interaction.id}`,
        interaction,
        participantVoiceSessionIds: new Map(),
        state: 'pending',
      }
      this.consentSessions.set(session.id, session)
      this.consentSessionIdByGuildId.set(currVoiceChannel.guild.id, session.id)
      try {
        await interaction.reply({
          allowedMentions: { parse: [] },
          components: this.createConsentComponents(session.id),
          content: this.createConsentContent(session),
        })
      }
      catch (error) {
        this.clearConsentSessionForGuild(currVoiceChannel.guild.id)
        throw error
      }
    }
    catch {
      logVoiceLifecycle(this.logger, 'error', {
        eventCode: 'consent-session-connect-failed',
        failureCategory: 'connection',
        terminal: true,
      })
      try {
        await respondToVoiceInteraction(interaction, 'Failed to join the voice channel.')
      }
      catch {
        logVoiceLifecycle(this.logger, 'error', {
          eventCode: 'consent-message-refresh-failed',
          failureCategory: 'discord-operation',
          terminal: true,
        })
      }
    }
  }

  async handleLeaveChannelCommand(interaction: ChatInputCommandInteraction<CacheType>) {
    const connection = interaction.guildId
      ? this.getVoiceConnection(interaction.guildId)
      : undefined

    if (!connection) {
      if (interaction.guildId && this.consentSessionIdByGuildId.has(interaction.guildId)) {
        this.clearConsentSessionForGuild(interaction.guildId)
        await interaction.reply('Cancelled the pending voice consent request.')
        return
      }
      await interaction.reply('Not currently in a voice channel.')
      return
    }

    try {
      const channelId = connection.joinConfig.channelId
      if (channelId)
        this.disconnectChannel(channelId, connection)
      else
        connection.destroy()
      await interaction.reply('Left the voice channel.')
    }
    catch {
      logVoiceLifecycle(this.logger, 'error', {
        eventCode: 'session-cleanup-failed',
        failureCategory: 'cleanup',
        terminal: true,
      })

      await interaction.reply('Failed to leave the voice channel.')
    }
  }
}
