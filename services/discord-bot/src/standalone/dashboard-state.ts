import type {
  StandaloneDiscordActivitySurface,
  StandaloneDiscordMessageIgnoredReason,
  StandaloneDiscordOperationFailureCategory,
  StandaloneDiscordOperationObservation,
  StandaloneDiscordReplyFailureKind,
} from '../adapters/standalone-adapter'
import type { VoiceDiagnosticCleanupReason, VoiceDiagnosticSignal } from '../bots/discord/commands/voiceDiagnostics'
import type { StandaloneDiscordFilterRejectReason } from './filter'
import type { StandaloneVoiceDiagnosticsSnapshot } from './voiceDiagnostics'

import { STANDALONE_CAPABILITY_DIAGNOSTICS_CONTRACT_VERSION, StandaloneCapabilityDiagnostics } from './capability-diagnostics'
import { StandaloneVoiceDiagnostics } from './voiceDiagnostics'

/**
 * Lifecycle state for the standalone Discord connection.
 */
export type StandaloneDiscordBotStatus = 'idle' | 'starting' | 'ready' | 'stopping' | 'stopped' | 'error'

/**
 * Severity shown for recent dashboard events.
 */
export type StandaloneDashboardEventKind = 'info' | 'success' | 'warning' | 'error'

/** Fixed Dashboard event codes rendered into localized labels by the browser. */
export type StandaloneDashboardEventCode
  = | 'bot-ready'
    | 'bot-start-failed'
    | 'bot-starting'
    | 'bot-stop-failed'
    | 'bot-stopped'
    | 'config-capacity'
    | 'config-saved'
    | 'ingress-failed'
    | 'memory-cleared'
    | 'memory-deleted'
    | 'memory-missing'
    | 'memory-save-failed'
    | 'memory-saved'
    | 'message-accepted'
    | 'message-ignored'
    | 'message-rejected'
    | 'reply-failed'
    | 'reply-sent'

/** Fixed failures retained by the Dashboard instead of external Error text. */
export type StandaloneDashboardFailureCategory
  = | 'bot-start-failure'
    | 'bot-stop-failure'
    | 'config-capacity'
    | 'memory-save-failure'
    | StandaloneDiscordOperationFailureCategory

/** Keeps runtime logs useful in the dashboard without letting process memory grow without bound. */
const MAX_STANDALONE_DASHBOARD_EVENTS = 200

const DASHBOARD_EVENT_KINDS: Record<StandaloneDashboardEventCode, StandaloneDashboardEventKind> = {
  'bot-ready': 'success',
  'bot-start-failed': 'error',
  'bot-starting': 'info',
  'bot-stop-failed': 'error',
  'bot-stopped': 'info',
  'config-capacity': 'warning',
  'config-saved': 'success',
  'ingress-failed': 'error',
  'memory-cleared': 'warning',
  'memory-deleted': 'success',
  'memory-missing': 'warning',
  'memory-save-failed': 'error',
  'memory-saved': 'success',
  'message-accepted': 'info',
  'message-ignored': 'warning',
  'message-rejected': 'warning',
  'reply-failed': 'error',
  'reply-sent': 'success',
}

const REJECT_REASON_LABELS: Partial<Record<StandaloneDiscordFilterRejectReason | 'queue-full', string>> = {
  'blocked-guild': '服务器已屏蔽',
  'blocked-term': '命中屏蔽词',
  'blocked-user': '用户已屏蔽',
  'channel-not-allowed': '频道未允许',
  'direct-message-disabled': '私信已关闭',
  'privacy-notice-failed': '隐私提示发送失败',
  'prompt-attack': '防角色扮演绕过',
  'queue-full': '处理队列已满',
  'rate-limited': '速率限制',
  'sensitive-input': '防敏感输入',
}

const IGNORED_REASON_LABELS: Record<StandaloneDiscordMessageIgnoredReason, string> = {
  'empty-content': '消息内容为空，请检查 Discord Message Content Intent 或只发送了 @',
  'missing-author': 'Discord 没有提供消息作者信息',
  'missing-discord-permission': '机器人缺少频道发送权限',
  'mention-required': '服务器频道内需要 @airi 才会回复',
  'missing-send-target': '当前频道不可发送消息，请检查频道权限',
  'missing-session-metadata': 'Discord 消息缺少会话 ID',
}

const DASHBOARD_FAILURE_CATEGORIES = new Set<StandaloneDashboardFailureCategory>([
  'bot-start-failure',
  'bot-stop-failure',
  'cancelled',
  'chunking-failure',
  'command-registration-failure',
  'config-capacity',
  'configuration',
  'delivery-failure',
  'discord-fetch-failure',
  'discord-ingress-failure',
  'discord-interaction-failure',
  'discord-typing-failure',
  'discord-typing-refresh-failure',
  'discord-voice-capacity-cleanup-failure',
  'discord-voice-cleanup-failure',
  'lifecycle-cleanup-failure',
  'memory-save-failure',
  'provider-failure',
  'queue-full',
  'service-unavailable',
  'stopped',
  'timeout',
  'unknown',
])

const DASHBOARD_BOT_STATUSES = new Set<StandaloneDiscordBotStatus>([
  'error',
  'idle',
  'ready',
  'starting',
  'stopped',
  'stopping',
])

/**
 * One recent standalone dashboard event.
 */
export interface StandaloneDashboardEvent {
  /** Stable event id for rendering lists without leaking message content. */
  id: number
  /** ISO timestamp when the event was recorded. */
  at: string
  /** Event severity used by the dashboard badge. */
  kind: StandaloneDashboardEventKind
  /** Fixed code resolved into display text by a browser-side allowlist. */
  code: StandaloneDashboardEventCode
  /** Fixed failure category when the event represents an error. */
  failureCategory?: StandaloneDashboardFailureCategory
  /** Anonymous bounded operation correlation, unrelated to Discord identity. */
  operationSequence?: number
  /** Fixed admission/routing reason. */
  reason?: StandaloneDiscordFilterRejectReason | StandaloneDiscordMessageIgnoredReason | 'queue-full'
  /** Bounded retry delay when present. */
  retryAfterMs?: number
  /** Fixed Discord surface without external identifiers. */
  surface?: StandaloneDiscordActivitySurface
}

/** Input accepted by the Dashboard state security projection. */
export interface StandaloneDashboardEventInput {
  /** Fixed event code; unknown runtime values are ignored. */
  code: StandaloneDashboardEventCode
  /** Fixed failure category; unknown runtime values are dropped. */
  failureCategory?: StandaloneDashboardFailureCategory
  /** Process-local operation correlation. */
  operationSequence?: number
  /** Allowlisted rejection or ignored-message reason. */
  reason?: StandaloneDiscordFilterRejectReason | StandaloneDiscordMessageIgnoredReason | 'queue-full'
  /** Retry delay supplied by the admission policy. */
  retryAfterMs?: number
  /** Fixed Discord activity surface. */
  surface?: StandaloneDiscordActivitySurface
}

/**
 * Read-only snapshot consumed by the local dashboard.
 */
export interface StandaloneDashboardSnapshot {
  /** ISO timestamp when the standalone process state was created. */
  startedAt: string
  /** Current Discord lifecycle status. */
  botStatus: StandaloneDiscordBotStatus
  /** Last fixed lifecycle or provider failure category. */
  lastError?: StandaloneDashboardFailureCategory
  /** Accepted Discord messages since process start. */
  acceptedMessages: number
  /** Rejected Discord messages since process start. */
  rejectedMessages: number
  /** Successful model replies since process start. */
  successfulReplies: number
  /** Failed model replies since process start. */
  failedReplies: number
  /** Bounded lifecycle, message, filter, and error events for the dashboard runtime log. */
  events: StandaloneDashboardEvent[]
  /** Local-only, content-free, bounded voice lifecycle diagnostics. */
  voiceDiagnostics: StandaloneVoiceDiagnosticsSnapshot
  /** One bounded complete-capability diagnostic run. */
  capabilityDiagnostics: ReturnType<StandaloneCapabilityDiagnostics['getSnapshot']>
}

/**
 * Historical dashboard counters persisted across standalone app restarts.
 */
export interface StandaloneDashboardCounters {
  /** Discord messages accepted for model generation. */
  acceptedMessages: number
  /** Model generation or Discord send failures. */
  failedReplies: number
  /** Discord messages rejected by configured filters. */
  rejectedMessages: number
  /** Generated replies successfully sent to Discord. */
  successfulReplies: number
}

/**
 * Construction options for persistent dashboard counters.
 */
export interface StandaloneDashboardStateOptions {
  /** Previously persisted historical counters. */
  initialCounters?: Partial<StandaloneDashboardCounters>
  /** Receives a new immutable counter snapshot after every counter mutation. */
  onCountersChanged?: (counters: StandaloneDashboardCounters) => void
}

function normalizeDashboardCounter(value: number | undefined): number {
  return Number.isFinite(value) && value !== undefined && value >= 0
    ? Math.trunc(value)
    : 0
}

function normalizeDashboardObservationCount(value: number | undefined): number | undefined {
  if (!Number.isFinite(value) || value === undefined || value < 0)
    return undefined
  return Math.min(65_535, Math.trunc(value))
}

/**
 * Keeps local dashboard state for the standalone Discord app.
 *
 * Use when:
 * - The bot and dashboard run in one process.
 * - Runtime events must be shown without exposing secrets or Discord message text.
 *
 * Expects:
 * - Callers provide fixed event codes and structured operation observations.
 *
 * Returns:
 * - Immutable snapshots for HTTP responses.
 */
export class StandaloneDashboardState {
  private readonly startedAt = new Date().toISOString()
  private readonly events: StandaloneDashboardEvent[] = []
  private nextEventId = 1
  private botStatus: StandaloneDiscordBotStatus = 'idle'
  private lastError: StandaloneDashboardFailureCategory | undefined
  private acceptedMessages: number
  private failedReplies: number
  private readonly onCountersChanged: ((counters: StandaloneDashboardCounters) => void) | undefined
  private rejectedMessages: number
  private successfulReplies: number
  private readonly voiceDiagnostics = new StandaloneVoiceDiagnostics()
  private readonly capabilityDiagnostics = new StandaloneCapabilityDiagnostics()

  constructor(options: StandaloneDashboardStateOptions = {}) {
    this.acceptedMessages = normalizeDashboardCounter(options.initialCounters?.acceptedMessages)
    this.failedReplies = normalizeDashboardCounter(options.initialCounters?.failedReplies)
    this.onCountersChanged = options.onCountersChanged
    this.rejectedMessages = normalizeDashboardCounter(options.initialCounters?.rejectedMessages)
    this.successfulReplies = normalizeDashboardCounter(options.initialCounters?.successfulReplies)
  }

  recordEvent(input: StandaloneDashboardEventInput): void {
    if (!Object.hasOwn(DASHBOARD_EVENT_KINDS, input.code))
      return
    const kind = DASHBOARD_EVENT_KINDS[input.code]

    const event: StandaloneDashboardEvent = {
      id: this.nextEventId++,
      at: new Date().toISOString(),
      code: input.code,
      kind,
    }
    const operationSequence = normalizeDashboardObservationCount(input.operationSequence)
    const retryAfterMs = normalizeDashboardObservationCount(input.retryAfterMs)
    if (operationSequence !== undefined)
      event.operationSequence = operationSequence
    if (retryAfterMs !== undefined)
      event.retryAfterMs = retryAfterMs
    if (input.surface === 'classic-voice' || input.surface === 'qwen-realtime' || input.surface === 'text-direct-message' || input.surface === 'text-guild')
      event.surface = input.surface
    if (input.reason && (Object.hasOwn(REJECT_REASON_LABELS, input.reason) || Object.hasOwn(IGNORED_REASON_LABELS, input.reason)))
      event.reason = input.reason
    if (input.failureCategory && DASHBOARD_FAILURE_CATEGORIES.has(input.failureCategory))
      event.failureCategory = input.failureCategory

    this.events.unshift(event)

    if (this.events.length > MAX_STANDALONE_DASHBOARD_EVENTS)
      this.events.length = MAX_STANDALONE_DASHBOARD_EVENTS
  }

  setBotStatus(status: StandaloneDiscordBotStatus, failureCategory?: StandaloneDashboardFailureCategory): void {
    if (!DASHBOARD_BOT_STATUSES.has(status))
      return
    this.botStatus = status
    if (status === 'error') {
      this.lastError = failureCategory && DASHBOARD_FAILURE_CATEGORIES.has(failureCategory)
        ? failureCategory
        : 'unknown'
    }
    if (status === 'ready')
      this.lastError = undefined
  }

  setBotReady(): void {
    this.setBotStatus('ready')
    this.recordEvent({ code: 'bot-ready' })
  }

  recordAcceptedMessage(observation: StandaloneDiscordOperationObservation): void {
    this.acceptedMessages += 1
    this.emitCountersChanged()
    this.recordEvent({ code: 'message-accepted', ...observation })
  }

  /** Records a matched production diagnostic challenge only after normal ingress admission. */
  recordDiagnosticTextAccepted(text: string, observation: StandaloneDiscordOperationObservation): void {
    this.capabilityDiagnostics.recordTextAccepted(text, observation.operationSequence)
  }

  recordRejectedMessage(observation: StandaloneDiscordOperationObservation & {
    reason: StandaloneDiscordFilterRejectReason | 'queue-full'
    retryAfterMs?: number
  }): void {
    this.rejectedMessages += 1
    this.emitCountersChanged()
    this.recordEvent({ code: 'message-rejected', ...observation })
  }

  recordIgnoredMessage(observation: StandaloneDiscordOperationObservation & {
    reason: StandaloneDiscordMessageIgnoredReason
  }): void {
    this.recordEvent({ code: 'message-ignored', ...observation })
  }

  recordIngressFailure(observation: StandaloneDiscordOperationObservation & {
    failureCategory: 'discord-ingress-failure'
  }): void {
    this.lastError = 'discord-ingress-failure'
    this.recordEvent({ code: 'ingress-failed', ...observation })
  }

  recordSuccessfulReply(observation: StandaloneDiscordOperationObservation): void {
    this.successfulReplies += 1
    this.emitCountersChanged()
    this.recordEvent({ code: 'reply-sent', ...observation })
    this.capabilityDiagnostics.recordTextReplySent(observation.operationSequence)
  }

  recordFailedReply(observation: StandaloneDiscordOperationObservation & {
    errorKind: StandaloneDiscordReplyFailureKind
  }): void {
    this.failedReplies += 1
    this.emitCountersChanged()
    const failureCategory = DASHBOARD_FAILURE_CATEGORIES.has(observation.errorKind)
      ? observation.errorKind
      : 'unknown'
    this.lastError = failureCategory
    this.recordEvent({
      code: 'reply-failed',
      failureCategory,
      operationSequence: observation.operationSequence,
      surface: observation.surface,
    })
    this.capabilityDiagnostics.recordTextReplyFailed(observation.operationSequence)
  }

  /** Records one content-free signal from a production Discord voice lifecycle boundary. */
  recordVoiceDiagnostic(signal: VoiceDiagnosticSignal): void {
    this.voiceDiagnostics.record(signal)
    this.capabilityDiagnostics.recordVoice(signal)
  }

  /** Starts the one allowed diagnostic run and returns its short-lived text marker. */
  startCapabilityDiagnostics(input: { discordConfigured: boolean, providerConfigured: boolean, productVersion: string }): { marker: string } | undefined {
    return this.capabilityDiagnostics.start({
      artifact: {
        artifactKind: 'standalone-discord-bot',
        diagnosticsContractVersion: STANDALONE_CAPABILITY_DIAGNOSTICS_CONTRACT_VERSION,
        productVersion: input.productVersion,
        startedAt: this.startedAt,
      },
      botReady: this.botStatus === 'ready',
      configuration: { discordConfigured: input.discordConfigured, providerConfigured: input.providerConfigured },
      dashboardApiHealthy: true,
    })
  }

  /** Applies one typed user confirmation to the active capability run. */
  confirmCapabilityDiagnostics(action: 'text-reply-correct' | 'voice-consent-join' | 'voice-heard'): boolean {
    return this.capabilityDiagnostics.confirm(action)
  }

  /** Idempotently cancels the active capability run. */
  cancelCapabilityDiagnostics(): void { this.capabilityDiagnostics.cancel() }

  /** Checks a short-lived marker without storing or emitting the raw Discord message. */
  matchesCapabilityTextChallenge(text: string): boolean { return this.capabilityDiagnostics.matchesTextChallenge(text) }

  /** Records ready and global command registration only after the production adapter completes both. */
  recordCapabilityBotReady(): void {
    this.capabilityDiagnostics.recordBotReady()
    this.capabilityDiagnostics.recordCommandsRegistered()
  }

  /** Records an observed bot lifecycle failure without exposing external error text. */
  recordCapabilityBotFailure(): void { this.capabilityDiagnostics.recordBotFailure() }

  /** Finalizes every active diagnostic session during adapter stop or replacement. */
  finalizeVoiceDiagnostics(reason: VoiceDiagnosticCleanupReason): void {
    this.voiceDiagnostics.finalizeAllActive(reason)
  }

  getSnapshot(): StandaloneDashboardSnapshot {
    return {
      acceptedMessages: this.acceptedMessages,
      botStatus: this.botStatus,
      events: this.events.map(event => ({ ...event })),
      failedReplies: this.failedReplies,
      lastError: this.lastError,
      rejectedMessages: this.rejectedMessages,
      startedAt: this.startedAt,
      successfulReplies: this.successfulReplies,
      voiceDiagnostics: this.voiceDiagnostics.getSnapshot(),
      capabilityDiagnostics: this.capabilityDiagnostics.getSnapshot(),
    }
  }

  private emitCountersChanged(): void {
    this.onCountersChanged?.({
      acceptedMessages: this.acceptedMessages,
      failedReplies: this.failedReplies,
      rejectedMessages: this.rejectedMessages,
      successfulReplies: this.successfulReplies,
    })
  }
}
