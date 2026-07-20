import type {
  ChatTurnCancelEvent,
  ChatTurnCorrelation,
  Discord,
  DiscordMemoryCommandAction,
  DiscordMemoryCommandEvent,
  DiscordMemoryCommandResultEvent,
  MemoryScope,
  MetadataEventSource,
} from '@proj-airi/server-shared/types'
import type { AssistantMessage } from '@xsai/shared-chat'
import type { ChatInputCommandInteraction, ClientEvents, Interaction } from 'discord.js'

import type { OpenAITranscriptionConfig } from '../pipelines/openai-speech'
import type { SafeDiscordTextPayload } from './discordSend'

import { randomUUID } from 'node:crypto'
import { env } from 'node:process'

import { useLogg } from '@guiiai/logg'
import { Client as ServerChannel } from '@proj-airi/server-sdk'
import { Client, Events, GatewayIntentBits, MessageReferenceType, MessageType, Partials } from 'discord.js'

import { handlePing, registerCommands, VoiceManager } from '../bots/discord/commands'
import { canManageDiscordVoiceInteraction } from '../bots/discord/commands/authorization'
import { describeOpenAICompatibleProvider, transcribeOpenAICompatible } from '../pipelines/openai-speech'
import { DiscordIngressScheduler } from './discordIngressScheduler'
import { removeDiscordBotMention } from './discordMention'
import { deliverDiscordText, DiscordTextChunkingError, DiscordTextDeliveryError, DiscordTransportCapacityError, resolveDiscordReplyReference, startDiscordTransport, waitForDiscordTransportBoundary } from './discordSend'

const log = useLogg('DiscordAdapter').useGlobalConfig()

export interface DiscordAdapterConfig {
  /** Protected Discord bot token handed to this process once by Electron Main. */
  discordToken?: string
  /** Server-bound credential for the exact Discord module identity. */
  airiToken?: string
  /** AIRI server-channel URL owned by Electron Main. */
  airiUrl?: string
  /** Exact identity bound to `airiToken` by the server. */
  moduleIdentity?: MetadataEventSource
  /** Protected classic STT settings delivered with the one-time worker bootstrap. */
  transcription?: OpenAITranscriptionConfig
}

/** Default privacy notice used when the UI sends an empty notice body. */
const DEFAULT_DISCORD_PRIVACY_NOTICE = 'Privacy note: AIRI keeps Discord chats separated by server, channel, and user. Long-term memory is disabled for Discord unless you explicitly allow it in settings.'

/** Keeps configured waits below a visible stall while still supporting a human typing beat. */
const MAX_DISCORD_MESSAGE_PACING_MS = 10_000

/** Keeps rate-limit windows bounded to avoid accidentally muting a session for too long. */
const MAX_DISCORD_RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000

/** Bounds exact-session buckets while preserving active window counters against LRU bypass. */
const MAX_DISCORD_EXACT_RATE_LIMIT_BUCKETS = 1_024

/** Bounds shared user/guild/global buckets while preserving active window counters against LRU bypass. */
const MAX_DISCORD_LAYERED_RATE_LIMIT_BUCKETS = 2_048

/** Bounds reply routing state; active provider turns are protected from eviction. */
const MAX_DISCORD_REPLY_TARGETS = 256

/** Bounds remembered privacy disclosures; LRU eviction only causes a safe notice replay. */
const MAX_DISCORD_PRIVACY_NOTICE_SESSIONS = 256

/** Bounds gateway dedupe state for the fixed replay window. */
const MAX_HANDLED_DISCORD_MESSAGE_IDS = 2_048

/** Bounds concurrent slash-command round trips to Stage memory policy. */
const MAX_PENDING_DISCORD_MEMORY_COMMANDS = 128

/** Matches the core-agent per-session waiting bound at the external ingress boundary. */
const MAX_PENDING_DISCORD_TURNS_PER_SESSION = 8

/** Matches the core-agent global waiting bound and caps timers/correlation state. */
const MAX_PENDING_DISCORD_TURNS = 64

/** Bounds all non-cancellable Discord.js fetch/send work retained after a local abort. */
const MAX_RAW_DISCORD_TRANSPORTS = 8

/** Bounds non-cancellable slash-command REST work retained after timeout or supersession. */
const MAX_RAW_COMMAND_REGISTRATION_TASKS = 8

/** One application generation cannot consume every retained registration slot. */
const MAX_RAW_COMMAND_REGISTRATION_TASKS_PER_APPLICATION = 3

/** Keeps registration capacity for a replacement Discord application identity. */
const RESERVED_COMMAND_REGISTRATION_TASKS_FOR_REPLACEMENT = 2

/** Bounds each slash-command REST attempt without pretending the raw request was cancelled. */
const DISCORD_COMMAND_REGISTRATION_TIMEOUT_MS = 10_000

/** Two bounded retries cover transient Discord REST failures without creating a timer storm. */
const DISCORD_COMMAND_REGISTRATION_RETRY_DELAYS_MS = [250, 1_000] as const

/** Prevents repeated Ready events from turning an exhausted retry cycle into a tight loop. */
const DISCORD_COMMAND_REGISTRATION_RECOVERY_DELAY_MS = 30_000

/** Reply routes expire after inactivity, except while a provider response is still pending. */
const DISCORD_REPLY_TARGET_TTL_MS = 15 * 60 * 1000

/** Privacy disclosures are repeated after one day instead of being remembered forever. */
const DISCORD_PRIVACY_NOTICE_TTL_MS = 24 * 60 * 60 * 1000

/** Matches the Discord Raw/MessageCreate overlap window without one timer per message id. */
const HANDLED_DISCORD_MESSAGE_ID_TTL_MS = 60_000

/** User-facing status sent only when Discord reached the bot but the AIRI channel is unavailable. */
const DISCORD_AIRI_CHANNEL_NOT_READY_MESSAGE = 'AIRI received your Discord message, but the local AIRI app is not connected to the Discord bridge yet. Please open AIRI, keep the Discord module enabled, and try again.'

/** User-facing timeout for accepted Discord input that never receives a local AI response. */
const DISCORD_AIRI_RESPONSE_TIMEOUT_MESSAGE = 'AIRI received your Discord message, but the local AI response did not come back in time. Please check that AIRI is open and a chat provider/model is selected, then try again.'

/** Content-free overload status for inputs rejected before Stage/provider execution. */
const DISCORD_AIRI_QUEUE_FULL_MESSAGE = 'AIRI is handling too many pending Discord messages right now. Please wait for an earlier response, then try again.'

/** Long enough for normal model latency, short enough to avoid silent Discord failures. */
const DISCORD_AIRI_RESPONSE_TIMEOUT_MS = 45_000

/** Bounds best-effort timeout-status delivery so a dead Discord transport cannot retain correlation forever. */
const DISCORD_TIMEOUT_NOTIFICATION_TIMEOUT_MS = 10_000

/** Helps confirm the restarted process is running the current DM diagnostics without logging secrets. */
const DISCORD_ADAPTER_RUNTIME_VERSION = '2026-06-10-dm-output-trace-v4'

/** Default bounded short-term Discord transcript length. */
const DEFAULT_DISCORD_SHORT_TERM_LIMIT = 20

/** Avoid letting a bad environment value turn short-term context into unbounded history. */
const MAX_DISCORD_SHORT_TERM_LIMIT = 80

/**
 * Runtime safety settings for Discord ingress.
 *
 * @param TId Exact Discord id string type used by persisted UI config.
 */
export interface DiscordRuntimeConfig<TId extends string = string> {
  /** Exact Discord channel ids where guild messages are allowed. Empty means all mentioned guild channels are accepted. */
  allowedChannelIds?: TId[]
  /** Exact Discord role ids allowed to use restricted Discord-side commands. */
  adminRoleIds?: TId[]
  /** Whether direct messages are accepted. @default true */
  allowDirectMessages?: boolean
  /** Whether Discord turns require explicit consent before long-term memory can be used. @default true */
  memoryConsentRequired?: boolean
  /** Whether the bot sends a privacy notice before first handling a Discord session. @default true */
  privacyNoticeEnabled?: boolean
  /** Short notice sent into Discord before the first handled message for a session. */
  privacyNoticeText?: string
  /** Whether structured local audit logs are written for Discord policy events. @default true */
  auditLogEnabled?: boolean
  /** Typing indicator wait before forwarding Discord input to AIRI, in milliseconds. @default 600 */
  messagePacingMs?: number
  /** Number of accepted Discord text inputs allowed per session/window. @default 6 */
  rateLimitMaxMessages?: number
  /** Number of accepted inputs allowed per Discord user across channels/guilds per window. @default 2x the exact-session limit */
  userRateLimitMaxMessages?: number
  /** Number of accepted inputs allowed per Discord guild per window. @default 20x the exact-session limit */
  guildRateLimitMaxMessages?: number
  /** Number of accepted inputs allowed across this Discord bridge process per window. @default 50x the exact-session limit */
  globalRateLimitMaxMessages?: number
  /** Rate-limit window length in milliseconds. @default 30000 */
  rateLimitWindowMs?: number
}

/** Non-secret Discord policy applied by the parent process at runtime. */
export interface DiscordBridgeRuntimeConfig extends DiscordRuntimeConfig {
  /** Whether this protected-token process may connect to Discord. */
  enabled: boolean
}

interface NormalizedDiscordRuntimeConfig {
  allowedChannelIds: string[]
  adminRoleIds: string[]
  allowDirectMessages: boolean
  memoryConsentRequired: boolean
  privacyNoticeEnabled: boolean
  privacyNoticeText: string
  auditLogEnabled: boolean
  messagePacingMs: number
  rateLimitMaxMessages: number
  userRateLimitMaxMessages: number
  guildRateLimitMaxMessages: number
  globalRateLimitMaxMessages: number
  rateLimitWindowMs: number
}

/**
 * Runtime decision for whether a Discord input can be forwarded into AIRI.
 */
export type DiscordInputPolicyDecision
  = | { accepted: true }
    | { accepted: false, reason: 'channel-not-allowed' | 'direct-message-disabled' }

type DiscordInteractionMemberRoleSource = {
  roles?: readonly string[] | {
    cache?: {
      keys: () => Iterable<string>
    }
  }
} | null

interface DiscordRateLimitBucket {
  count: number
  resetAt: number
}

interface ManagedDiscordRateLimitBucket extends DiscordRateLimitBucket {
  lastAccessedAt: number
}

interface ExpiringDiscordState {
  expiresAt: number
  lastAccessedAt: number
}

interface DiscordReplyTargetState extends ExpiringDiscordState {
  activeIngressCount: number
  lastTurnGeneration: number
  target: DiscordReplyTarget
}

interface DiscordRateLimitDecision {
  accepted: boolean
  retryAfterMs?: number
}

interface PendingDiscordMemoryCommand {
  reject: (error: Error) => void
  resolve: (result: DiscordMemoryCommandResultEvent) => void
  timeout: ReturnType<typeof setTimeout>
}

interface RawDiscordCommandRegistration {
  applicationId: string
  task: Promise<void>
}

interface DiscordCommandRegistrationAttempt {
  abortController: AbortController
  applicationId: string
  configGeneration: number
  generation: number
  task: Promise<void>
  timeout?: ReturnType<typeof setTimeout>
}

interface PendingDiscordTurn {
  cancellationEmitted: boolean
  configGeneration: number
  discordContext: Discord
  notificationAbortController: AbortController
  notificationTimeout?: ReturnType<typeof setTimeout>
  phase: 'pending' | 'response' | 'timeout'
  removeAbortListener?: () => void
  responseAbortController: AbortController
  sessionId: string
  timeout: ReturnType<typeof setTimeout>
  turn: ChatTurnCorrelation
}

interface DiscordReplyTarget {
  channelId: string
  userId: string
  directMessage: boolean
}

interface DiscordSendTarget {
  send: (payload: SafeDiscordTextPayload) => Promise<unknown> | unknown
}

interface DiscordTextInputSource {
  abortSignal?: AbortSignal
  /** Deferred address proof run inside the exact-session admission envelope. */
  authorize?: (deadlineAt: number) => Promise<boolean>
  channelId: string
  content: string
  /** Absolute upstream voice deadline; canonical Stage ingress may only shorten it. */
  deadlineAt?: number
  directMessage: boolean
  displayName: string
  guildId?: string
  guildName?: string
  nickname: string
  /** Set only by VoiceManager after pre-capture rate admission. */
  rateLimitAdmitted?: boolean
  rawContent: string
  sendPrivacyNotice?: (payload: SafeDiscordTextPayload, abortSignal?: AbortSignal) => Promise<unknown> | unknown
  sendTyping?: () => Promise<unknown> | unknown
  userId: string
}

/** Fixed bridge audit events retained without Discord identities or arbitrary caller fields. */
const DISCORD_AUDIT_EVENT_CODES = [
  'audit-observation-rejected',
  'command-registration-completed',
  'command-registration-failed',
  'command-registration-retry-available',
  'command-registration-retry-scheduled',
  'discord-delivery-cancelled',
  'discord-ready-ignored',
  'discord-transport-skipped',
  'gateway-message-create-received',
  'input-accepted',
  'input-forwarded',
  'input-handling-started',
  'input-rejected',
  'interaction-rejected',
  'memory-command-result',
  'message-create-ignored',
  'message-create-received',
  'output-delivery-failed',
  'output-message-received',
  'output-message-sent',
  'output-message-skipped',
  'output-target-missing',
  'privacy-notice-delivery-failed',
  'privacy-notice-sent',
  'raw-dm-fallback-error',
  'raw-dm-fallback-skipped',
  'raw-dm-fallback-started',
  'reply-reference-resolved',
  'runtime-config-failed',
  'runtime-config-rejected',
  'turn-cancelled',
  'voice-input-rejected',
] as const

type DiscordAuditEventCode = typeof DISCORD_AUDIT_EVENT_CODES[number]

/** Fixed audit reasons accepted at the process-log boundary. */
const DISCORD_AUDIT_REASONS = new Set([
  'airi-channel-not-connected',
  'application-changed-within-generation',
  'author-mismatch',
  'cancelled',
  'capacity',
  'channel-not-allowed',
  'deadline',
  'deadline-expired',
  'direct-message-disabled',
  'disabled',
  'disconnect',
  'duplicate-message',
  'empty-content',
  'explicit-disable-cleanup-required',
  'fetch-failure',
  'global-capacity',
  'inactive-generation',
  'manage-guild-and-admin-role-required',
  'matched',
  'missing-content',
  'missing-discord-channel',
  'missing-reference',
  'missing-session-metadata',
  'missing-turn-correlation',
  'not-addressed',
  'owner-or-admin-required',
  'privacy-notice-failed',
  'rate-limited',
  'referenced-message-missing',
  'reply-state-capacity',
  'request-failure',
  'reset',
  'send-failure',
  'session-capacity',
  'stale-or-disabled',
  'stale-or-mismatched-turn',
  'timeout',
  'transport-capacity',
  'turn-cancelled',
  'turn-deadline-expired',
  'turn-queue-capacity',
])

/** Fixed Discord memory actions safe to retain in a content-free audit record. */
const DISCORD_AUDIT_MEMORY_ACTIONS = new Set<DiscordMemoryCommandAction>([
  'forget-current-session',
  'forget-memory',
  'memory-approve',
  'memory-clear',
  'memory-list',
  'memory-opt-in',
  'memory-opt-out',
  'memory-reject',
  'privacy',
  'remember',
])

/** Fixed bridge failure stages retained without the originating Error object. */
const DISCORD_BRIDGE_FAILURE_EVENT_CODES = [
  'adapter-stop-failed',
  'airi-channel-error',
  'bridge-failure-observation-rejected',
  'disconnect-cleanup-failed',
  'discord-ready-lifecycle-failed',
  'dm-channel-resolution-failed',
  'dm-user-resolution-failed',
  'memory-command-failed',
  'missing-token-cleanup-failed',
  'overload-status-delivery-failed',
  'pending-turn-expiration-failed',
  'raw-dm-ingress-failed',
  'typing-indicator-failed',
  'voice-state-update-failed',
] as const

type DiscordBridgeFailureEventCode = typeof DISCORD_BRIDGE_FAILURE_EVENT_CODES[number]
type DiscordBridgeFailureCategory
  = | 'airi-channel'
    | 'cleanup'
    | 'discord-lifecycle'
    | 'discord-transport'
    | 'ingress'
    | 'internal'
    | 'memory-bridge'
    | 'turn-lifecycle'

interface DiscordBridgeFailureObservation {
  eventCode: DiscordBridgeFailureEventCode
  failureCategory: DiscordBridgeFailureCategory
  retryable: boolean
  terminal: boolean
}

const DISCORD_AUDIT_EVENT_CODE_SET = new Set<string>(DISCORD_AUDIT_EVENT_CODES)
const DISCORD_BRIDGE_FAILURE_EVENT_CODE_SET = new Set<string>(DISCORD_BRIDGE_FAILURE_EVENT_CODES)
const DISCORD_BRIDGE_FAILURE_CATEGORIES = new Set<DiscordBridgeFailureCategory>([
  'airi-channel',
  'cleanup',
  'discord-lifecycle',
  'discord-transport',
  'ingress',
  'internal',
  'memory-bridge',
  'turn-lifecycle',
])
const DISCORD_AUDIT_ERROR_KINDS = new Set(['grapheme-too-long', 'segmenter-unavailable'])
const DISCORD_AUDIT_ERROR_NAMES = new Set([
  'DiscordTextChunkingError',
  'DiscordTextDeliveryError',
  'DiscordTransportCapacityError',
  'Error',
  'UnknownError',
])
const DISCORD_AUDIT_STATUSES = new Set([
  'cooldown-complete',
  'error',
  'ok',
  'previous-config-failed',
  'retry-exhausted',
])
const DISCORD_LOGGABLE_COMMAND_NAMES = new Set([
  'airi',
  'dismiss',
  'forget',
  'memory',
  'ping',
  'remember',
  'summon',
])

/**
 * Normalizes an operational count before it crosses the bridge log boundary.
 *
 * Before:
 * - 99999
 *
 * After:
 * - 65535
 */
function boundedDiscordAuditCount(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value))
    return undefined
  return Math.min(65_535, Math.max(0, Math.trunc(value)))
}

/**
 * Normalizes a bridge audit observation through a strict runtime allowlist.
 *
 * Before:
 * - `{ event: "input-rejected", guildId: "external-id", reason: "rate-limited" }`
 *
 * After:
 * - `{ event: "input-rejected", reason: "rate-limited" }`
 */
function projectDiscordAuditObservation(
  event: unknown,
  fields: Readonly<Record<string, unknown>>,
): Record<string, boolean | number | string> {
  if (typeof event !== 'string' || !DISCORD_AUDIT_EVENT_CODE_SET.has(event)) {
    return {
      event: 'audit-observation-rejected',
      failureCategory: 'invalid-observation',
    }
  }

  const observation: Record<string, boolean | number | string> = { event }
  for (const key of [
    'activeTransportCount',
    'attempt',
    'attemptCount',
    'configGeneration',
    'contentLength',
    'currentConfigGeneration',
    'deliveredChunks',
    'retryAfterMs',
    'retryDelayMs',
    'totalChunks',
    'turnGeneration',
  ] as const) {
    const value = boundedDiscordAuditCount(fields[key])
    if (value !== undefined)
      observation[key] = value
  }
  for (const key of [
    'directMessage',
    'hasContent',
    'hasDiscordContext',
    'hasTurnCorrelation',
    'matched',
    'mentioned',
    'safetyCleanupApplied',
  ] as const) {
    if (typeof fields[key] === 'boolean')
      observation[key] = fields[key]
  }
  if (typeof fields.reason === 'string' && DISCORD_AUDIT_REASONS.has(fields.reason))
    observation.reason = fields.reason
  if (typeof fields.status === 'string' && DISCORD_AUDIT_STATUSES.has(fields.status))
    observation.status = fields.status
  if (typeof fields.action === 'string' && DISCORD_AUDIT_MEMORY_ACTIONS.has(fields.action as DiscordMemoryCommandAction))
    observation.action = fields.action
  if (typeof fields.errorKind === 'string' && DISCORD_AUDIT_ERROR_KINDS.has(fields.errorKind))
    observation.errorKind = fields.errorKind
  if (typeof fields.errorName === 'string' && DISCORD_AUDIT_ERROR_NAMES.has(fields.errorName))
    observation.errorName = fields.errorName
  return observation
}

/** Writes one fixed bridge failure observation without retaining the external Error. */
function logDiscordBridgeFailure(
  level: 'error' | 'warn',
  observation: DiscordBridgeFailureObservation,
): void {
  const valid = DISCORD_BRIDGE_FAILURE_EVENT_CODE_SET.has(observation.eventCode)
    && DISCORD_BRIDGE_FAILURE_CATEGORIES.has(observation.failureCategory)
  const fields: DiscordBridgeFailureObservation = valid
    ? {
        eventCode: observation.eventCode,
        failureCategory: observation.failureCategory,
        retryable: observation.retryable,
        terminal: observation.terminal,
      }
    : {
        eventCode: 'bridge-failure-observation-rejected',
        failureCategory: 'internal',
        retryable: false,
        terminal: true,
      }
  const scopedLogger = log.withFields(fields)
  if (level === 'warn') {
    scopedLogger.warn('[discord-bot] bridge lifecycle failure')
    return
  }
  scopedLogger.error('[discord-bot] bridge lifecycle failure')
}

function isReadonlyStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

function isChatTurnCorrelation(value: unknown): value is ChatTurnCorrelation {
  return typeof value === 'object'
    && value !== null
    && 'id' in value
    && typeof value.id === 'string'
    && value.id.length > 0
    && 'generation' in value
    && Number.isSafeInteger(value.generation)
    && Number(value.generation) > 0
    && 'deadlineAt' in value
    && typeof value.deadlineAt === 'number'
    && Number.isFinite(value.deadlineAt)
}

/**
 * Normalizes provider assistant content into Discord text.
 *
 * Before:
 * - [{ type: "text", text: "hello" }, { type: "refusal", refusal: "cannot comply" }]
 *
 * After:
 * - "hello\ncannot comply"
 */
function normalizeDiscordAssistantContent(content: AssistantMessage['content']): string {
  if (typeof content === 'string')
    return content

  return (content ?? []).map((part) => {
    if (part.type === 'text')
      return part.text
    return part.refusal
  }).filter(Boolean).join('\n')
}

/**
 * Normalizes Discord ids before exact-scope matching.
 *
 * Before:
 * - " 123456789 "
 *
 * After:
 * - "123456789"
 */
function normalizeDiscordId(value: string | undefined) {
  return value?.trim() ?? ''
}

/**
 * Normalizes Discord id arrays before policy decisions.
 *
 * Before:
 * - [" 111 ", "222", "111"]
 *
 * After:
 * - ["111", "222"]
 */
function normalizeDiscordIdList(value: string[] | undefined) {
  return Array.from(new Set((value ?? []).map(normalizeDiscordId).filter(Boolean)))
}

/**
 * Normalizes Discord message pacing.
 *
 * Before:
 * - 12000
 *
 * After:
 * - 10000
 */
function normalizeDiscordMessagePacingMs(value: number | undefined) {
  const normalized = Number.isFinite(value) ? Math.trunc(value ?? 0) : 0
  return Math.min(MAX_DISCORD_MESSAGE_PACING_MS, Math.max(0, normalized))
}

/**
 * Normalizes Discord rate-limit message counts.
 *
 * Before:
 * - -1
 *
 * After:
 * - 0
 */
function normalizeDiscordRateLimitMaxMessages(value: number | undefined) {
  const normalized = Number.isFinite(value) ? Math.trunc(value ?? 0) : 0
  return Math.min(100, Math.max(0, normalized))
}

function normalizeDiscordLayeredRateLimitMaxMessages(value: number | undefined, defaultValue: number, maximum: number) {
  const normalized = Number.isFinite(value) ? Math.trunc(value ?? defaultValue) : defaultValue
  return Math.min(maximum, Math.max(1, normalized))
}

/**
 * Normalizes Discord rate-limit windows.
 *
 * Before:
 * - 600000
 *
 * After:
 * - 300000
 */
function normalizeDiscordRateLimitWindowMs(value: number | undefined) {
  const normalized = Number.isFinite(value) ? Math.trunc(value ?? 0) : 0
  return Math.min(MAX_DISCORD_RATE_LIMIT_WINDOW_MS, Math.max(1000, normalized))
}

/**
 * Normalizes the Discord short-term memory retention limit.
 *
 * Before:
 * - "200"
 *
 * After:
 * - 80
 */
export function normalizeDiscordShortTermLimit(value: string | number | undefined) {
  const parsed = typeof value === 'string' ? Number.parseInt(value, 10) : value
  if (!Number.isFinite(parsed))
    return DEFAULT_DISCORD_SHORT_TERM_LIMIT

  return Math.min(MAX_DISCORD_SHORT_TERM_LIMIT, Math.max(1, Math.trunc(parsed ?? DEFAULT_DISCORD_SHORT_TERM_LIMIT)))
}

/**
 * Checks whether one Discord user id matches the configured owner id.
 *
 * Use when:
 * - Slash commands need owner-only memory permissions.
 * - Discord message metadata needs to tell Stage UI whether the current user is owner.
 *
 * Expects:
 * - `ownerUserId` came from `AIRI_OWNER_USER_ID`, not a username or display name.
 *
 * Returns:
 * - `true` only for an exact normalized Discord user-id match.
 */
export function isDiscordOwner(userId: string | undefined, ownerUserId = env.AIRI_OWNER_USER_ID) {
  const normalizedOwnerUserId = normalizeDiscordId(ownerUserId)
  return Boolean(normalizedOwnerUserId && normalizeDiscordId(userId) === normalizedOwnerUserId)
}

const MEMORY_SCOPE_VALUES = new Set<MemoryScope>([
  'global',
  'server',
  'channel',
  'user',
  'dm',
  'temporary',
  'project',
])

/**
 * Normalizes Discord slash-command memory scopes.
 *
 * Before:
 * - " Channel "
 *
 * After:
 * - "channel"
 */
export function resolveDiscordMemoryScope(value: string | null | undefined): MemoryScope | undefined {
  const normalized = value?.trim().toLowerCase()
  if (!normalized || !MEMORY_SCOPE_VALUES.has(normalized as MemoryScope))
    return undefined

  return normalized as MemoryScope
}

/**
 * Parses temporary memory duration text from Discord slash commands.
 *
 * Before:
 * - "6h"
 *
 * After:
 * - 21600000
 */
export function parseDiscordMemoryDurationMs(value: string | null | undefined) {
  const normalized = value?.trim().toLowerCase()
  if (!normalized)
    return undefined

  const match = /^(\d{1,4})\s*([mhd])?$/.exec(normalized)
  if (!match)
    return undefined

  const amount = Number.parseInt(match[1], 10)
  const unit = match[2] ?? 'h'
  const multiplier = unit === 'd'
    ? 24 * 60 * 60 * 1000
    : unit === 'h'
      ? 60 * 60 * 1000
      : 60 * 1000

  return Math.min(30 * 24 * 60 * 60 * 1000, Math.max(60 * 1000, amount * multiplier))
}

/**
 * Normalizes Discord runtime security config.
 *
 * Before:
 * - { allowedChannelIds: [" 111 ", "111"], messagePacingMs: 12000 }
 *
 * After:
 * - { allowedChannelIds: ["111"], messagePacingMs: 10000, allowDirectMessages: true }
 */
function normalizeDiscordRuntimeConfig(config: DiscordRuntimeConfig = {}): NormalizedDiscordRuntimeConfig {
  const rateLimitMaxMessages = normalizeDiscordRateLimitMaxMessages(config.rateLimitMaxMessages ?? 6)
  // An operator may disable the exact-session convenience layer with zero, but
  // cross-user/process abuse boundaries remain mandatory and retain safe defaults.
  const layeredDefaultBase = rateLimitMaxMessages || 6

  return {
    allowedChannelIds: normalizeDiscordIdList(config.allowedChannelIds),
    adminRoleIds: normalizeDiscordIdList(config.adminRoleIds),
    allowDirectMessages: config.allowDirectMessages ?? true,
    memoryConsentRequired: config.memoryConsentRequired ?? true,
    privacyNoticeEnabled: config.privacyNoticeEnabled ?? true,
    privacyNoticeText: (config.privacyNoticeText ?? '').replace(/\r\n?/g, '\n').trim().slice(0, 1900) || DEFAULT_DISCORD_PRIVACY_NOTICE,
    auditLogEnabled: config.auditLogEnabled ?? true,
    messagePacingMs: normalizeDiscordMessagePacingMs(config.messagePacingMs ?? 600),
    rateLimitMaxMessages,
    userRateLimitMaxMessages: normalizeDiscordLayeredRateLimitMaxMessages(config.userRateLimitMaxMessages, layeredDefaultBase * 2, 200),
    guildRateLimitMaxMessages: normalizeDiscordLayeredRateLimitMaxMessages(config.guildRateLimitMaxMessages, layeredDefaultBase * 20, 2000),
    globalRateLimitMaxMessages: normalizeDiscordLayeredRateLimitMaxMessages(config.globalRateLimitMaxMessages, layeredDefaultBase * 50, 5000),
    rateLimitWindowMs: normalizeDiscordRateLimitWindowMs(config.rateLimitWindowMs ?? 30_000),
  }
}

function normalizeDiscordMetadata(discord?: Discord): Discord | undefined {
  if (!discord)
    return undefined

  if (!discord.guildMember)
    return discord

  const { guildMember } = discord

  return {
    ...discord,
    guildMember: {
      id: guildMember.id ?? '',
      nickname: guildMember.nickname ?? guildMember.displayName ?? '',
      displayName: guildMember.displayName ?? guildMember.nickname ?? '',
    },
  }
}

function isDiscordSendTarget(target: unknown): target is DiscordSendTarget {
  return typeof target === 'object'
    && target !== null
    && 'send' in target
    && typeof target.send === 'function'
}

/** Waits for ingress pacing while allowing stop, disable, or the turn deadline to clear its timer immediately. */
function waitForDiscordTurnDelay(ms: number, abortSignal: AbortSignal): Promise<boolean> {
  if (abortSignal.aborted)
    return Promise.resolve(false)

  return new Promise<boolean>((resolve) => {
    let timeout: ReturnType<typeof setTimeout>
    const stopWaiting = () => {
      clearTimeout(timeout)
      resolve(false)
    }
    timeout = setTimeout(() => {
      abortSignal.removeEventListener('abort', stopWaiting)
      resolve(true)
    }, ms)
    abortSignal.addEventListener('abort', stopWaiting, { once: true })
  })
}

/**
 * Resolves the AIRI chat session boundary for one Discord input.
 *
 * Use when:
 * - Discord text or voice input must be routed into an isolated AIRI chat session.
 * - Guild/channel messages must not share history or memory with other guilds, channels, or users.
 *
 * Expects:
 * - Guild messages should include `guildId`, `channelId`, and `guildMember.id` whenever Discord provides them.
 *
 * Returns:
 * - A deterministic session id scoped by guild+channel+user or DM user.
 * - `undefined` when required Discord ids are missing so callers can fail closed.
 */
export function resolveDiscordSessionId(discord?: Discord) {
  const guildId = discord?.guildId?.trim()
  const channelId = discord?.channelId?.trim()
  const userId = discord?.guildMember?.id?.trim()

  if (guildId) {
    if (channelId && userId)
      return `discord-guild-${guildId}-channel-${channelId}-user-${userId}`

    return undefined
  }

  if (userId)
    return `discord-dm-${userId}`

  return undefined
}

/**
 * Resolves the Discord target used to send AIRI's reply back to the same safe scope.
 *
 * Use when:
 * - AIRI output needs to return to either the original guild channel or the original DM user.
 * - DM replies should not depend only on Discord channel fetching.
 *
 * Expects:
 * - `discord.channelId` and `discord.guildMember.id` came from a trusted Discord message event.
 *
 * Returns:
 * - A send target snapshot, or `undefined` when channel/user metadata is incomplete.
 */
export function resolveDiscordReplyTarget(discord?: Discord): DiscordReplyTarget | undefined {
  const channelId = normalizeDiscordId(discord?.channelId)
  const userId = normalizeDiscordId(discord?.guildMember?.id)
  if (!channelId || !userId)
    return undefined

  return {
    channelId,
    userId,
    directMessage: !normalizeDiscordId(discord?.guildId),
  }
}

/**
 * Resolves whether one Discord input is allowed to reach AIRI.
 *
 * Use when:
 * - Guild messages must be restricted to an exact channel allowlist.
 * - Direct messages need an explicit runtime allow/deny gate.
 *
 * Expects:
 * - `discord.channelId` is present for guild messages that need allowlist checks.
 *
 * Returns:
 * - An accepted decision, or a rejection reason suitable for local audit logs.
 */
export function resolveDiscordInputPolicy(discord: Discord | undefined, config: DiscordRuntimeConfig = {}): DiscordInputPolicyDecision {
  const runtimeConfig = normalizeDiscordRuntimeConfig(config)
  const guildId = normalizeDiscordId(discord?.guildId)

  if (!guildId) {
    return runtimeConfig.allowDirectMessages
      ? { accepted: true }
      : { accepted: false, reason: 'direct-message-disabled' }
  }

  const channelId = normalizeDiscordId(discord?.channelId)
  if (runtimeConfig.allowedChannelIds.length && !runtimeConfig.allowedChannelIds.includes(channelId))
    return { accepted: false, reason: 'channel-not-allowed' }

  return { accepted: true }
}

/**
 * Resolves exact role ids from a Discord interaction member.
 *
 * Use when:
 * - Slash commands need to check configured admin role ids.
 * - Discord.js may provide either cached guild member roles or raw API role ids.
 *
 * Expects:
 * - `member.roles` is either a string array from Discord API payloads or a Discord.js role manager cache.
 *
 * Returns:
 * - Normalized exact Discord role ids.
 */
export function resolveDiscordMemberRoleIds(member: DiscordInteractionMemberRoleSource | undefined) {
  const roles = member?.roles
  if (!roles)
    return []

  if (isReadonlyStringArray(roles))
    return normalizeDiscordIdList([...roles])

  return normalizeDiscordIdList(Array.from(roles.cache?.keys() ?? []))
}

/**
 * Checks whether a Discord interaction member satisfies the configured admin role gate.
 *
 * Use when:
 * - A Discord slash command can change bot state or join channels.
 * - Empty admin role configuration should preserve the existing open behavior.
 *
 * Expects:
 * - `adminRoleIds` contains exact Discord role ids from trusted local settings.
 *
 * Returns:
 * - `true` when no admin roles are configured or at least one member role matches.
 */
export function hasRequiredDiscordAdminRole(member: DiscordInteractionMemberRoleSource | undefined, adminRoleIds: string[] | undefined) {
  const requiredRoleIds = normalizeDiscordIdList(adminRoleIds)
  if (!requiredRoleIds.length)
    return true

  const memberRoleIds = resolveDiscordMemberRoleIds(member)
  return memberRoleIds.some(roleId => requiredRoleIds.includes(roleId))
}

/**
 * Checks whether a Discord user can run restricted AIRI commands.
 *
 * Use when:
 * - Slash commands mutate or expose AIRI memory/session state.
 * - The configured owner needs access from DMs where role metadata is unavailable.
 *
 * Expects:
 * - `ownerUserId` and `adminRoleIds` came from trusted local runtime configuration.
 *
 * Returns:
 * - `true` for the exact configured owner or a member with one configured admin role.
 * - `false` when neither owner nor admin roles are configured.
 */
export function canUseRestrictedDiscordCommand(input: {
  userId: string | undefined
  ownerUserId: string | undefined
  member: DiscordInteractionMemberRoleSource | undefined
  adminRoleIds: string[] | undefined
}) {
  if (isDiscordOwner(input.userId, input.ownerUserId))
    return true

  const requiredRoleIds = normalizeDiscordIdList(input.adminRoleIds)
  if (!requiredRoleIds.length)
    return false

  const memberRoleIds = resolveDiscordMemberRoleIds(input.member)
  return memberRoleIds.some(roleId => requiredRoleIds.includes(roleId))
}

/**
 * Applies a per-session Discord message rate limit.
 *
 * Use when:
 * - Discord text ingress needs local backpressure before reaching AIRI.
 * - Each guild/channel/user session must have an independent bucket.
 *
 * Expects:
 * - `bucket` belongs only to the exact session currently being checked.
 *
 * Returns:
 * - The updated bucket and whether the message should be accepted.
 */
export function resolveDiscordRateLimit(
  bucket: DiscordRateLimitBucket | undefined,
  config: DiscordRuntimeConfig,
  now = Date.now(),
): { bucket: DiscordRateLimitBucket, decision: DiscordRateLimitDecision } {
  const runtimeConfig = normalizeDiscordRuntimeConfig(config)

  if (runtimeConfig.rateLimitMaxMessages <= 0) {
    return {
      bucket: {
        count: 0,
        resetAt: now + runtimeConfig.rateLimitWindowMs,
      },
      decision: { accepted: true },
    }
  }

  const activeBucket = bucket && bucket.resetAt > now
    ? bucket
    : {
        count: 0,
        resetAt: now + runtimeConfig.rateLimitWindowMs,
      }

  if (activeBucket.count >= runtimeConfig.rateLimitMaxMessages) {
    return {
      bucket: activeBucket,
      decision: {
        accepted: false,
        retryAfterMs: Math.max(0, activeBucket.resetAt - now),
      },
    }
  }

  return {
    bucket: {
      ...activeBucket,
      count: activeBucket.count + 1,
    },
    decision: { accepted: true },
  }
}

export class DiscordAdapter {
  private airiClient: ServerChannel
  private discordClient: Client
  private discordToken: string
  private ownerUserId: string
  private shortTermLimit: number
  private voiceManager: VoiceManager
  private runtimeConfigTask: Promise<void> = Promise.resolve()
  private disconnectCleanupTask?: Promise<void>
  private adapterStopping = false
  private runtimeConfigGeneration = 0
  private appliedRuntimeConfigGeneration = 0
  private discordConnectionGeneration?: number
  private runtimeConfig = normalizeDiscordRuntimeConfig()
  private privacyNoticeSessionIds = new Map<string, ExpiringDiscordState>()
  private rateLimitBuckets = new Map<string, ManagedDiscordRateLimitBucket>()
  private layeredRateLimitBuckets = new Map<string, ManagedDiscordRateLimitBucket>()
  private replyTargetsBySessionId = new Map<string, DiscordReplyTargetState>()
  private handledDiscordMessageIds = new Map<string, ExpiringDiscordState>()
  private nextBoundedStateSweepAt = 0
  private pendingDiscordTurnsById = new Map<string, PendingDiscordTurn>()
  private pendingDiscordTurnIdsBySessionId = new Map<string, Set<string>>()
  private readonly discordIngressScheduler = new DiscordIngressScheduler()
  private discordIngressLifecycle = new AbortController()
  private replyReferenceLifecycle = new AbortController()
  private discordIngressEnabled = false
  private discordTransportReady = false
  // Canonical Stage ownership is unavailable until ServerChannel proves ready.
  // This prevents Discord ingress from outrunning the initial AIRI connection.
  private airiChannelReady = false
  private disconnectCleanupFailed = false
  private runtimePolicyEnabled = false
  private rawDiscordTransports = new Set<Promise<unknown>>()
  private rawCommandRegistrationTasks = new Set<RawDiscordCommandRegistration>()
  // Each wrapper exists only after an admitted raw registration, so the raw
  // eight-task cap is also a hard bound for controllers, timers, and waiters.
  private commandRegistrationAttempts = new Set<DiscordCommandRegistrationAttempt>()
  private pendingMemoryCommands = new Map<string, PendingDiscordMemoryCommand>()
  private commandRegistrationGeneration = 0
  private commandRegistrationOwner?: { applicationId: string, configGeneration: number, generation: number }
  private commandRegistrationRetryTimer?: ReturnType<typeof setTimeout>
  private commandRegistrationTask?: Promise<void>
  private pendingDiscordLoginGeneration?: number
  private registeredDiscordApplicationId?: string
  private registeredDiscordApplicationGeneration?: number

  constructor(config: DiscordAdapterConfig) {
    this.discordToken = config.discordToken ?? ''
    this.ownerUserId = normalizeDiscordId(env.AIRI_OWNER_USER_ID)
    this.shortTermLimit = normalizeDiscordShortTermLimit(env.AIRI_SHORT_TERM_LIMIT)
    if (!this.ownerUserId)
      log.warn('[discord-bot] AIRI_OWNER_USER_ID is missing. Global/core memory modification commands are disabled.')

    // Initialize Discord client
    this.discordClient = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
      partials: [Partials.Channel, Partials.Message, Partials.User],
    })

    // Initialize AIRI client
    this.airiClient = new ServerChannel({
      name: 'discord',
      possibleEvents: [
        'discord:memory:command',
        'discord:memory:command:result',
        'chat:turn:cancel',
        'input:text',
        'output:gen-ai:chat:message',
      ],
      identity: config.moduleIdentity,
      token: config.airiToken,
      url: config.airiUrl,
      onReady: () => {
        this.airiChannelReady = true
        this.refreshDiscordIngressAvailability()
        log.log('[discord-bot] AIRI channel ready')
      },
      onStateChange: ({ previousStatus, status }) => {
        log.withField('status', status).log('[discord-bot] AIRI channel state')
        if (status === 'ready') {
          this.airiChannelReady = true
          this.refreshDiscordIngressAvailability()
          return
        }

        this.airiChannelReady = false
        this.refreshDiscordIngressAvailability()
        if (previousStatus === 'ready' && this.runtimePolicyEnabled && !this.adapterStopping)
          this.beginDisconnectCleanup()
      },
      onError: () => {
        logDiscordBridgeFailure('error', {
          eventCode: 'airi-channel-error',
          failureCategory: 'airi-channel',
          retryable: true,
          terminal: false,
        })
      },
    })

    this.voiceManager = new VoiceManager(
      this.discordClient,
      async ({ abortSignal, channelId, deadlineAt, guildId, rateLimitAdmitted, speaker, text, userId }) => {
        if (abortSignal.aborted || deadlineAt <= Date.now() || !this.runtimePolicyEnabled || !this.discordIngressEnabled)
          return undefined

        await this.handleDiscordTextInput({
          abortSignal,
          channelId,
          content: text,
          deadlineAt,
          directMessage: false,
          displayName: speaker.displayName,
          guildId,
          guildName: speaker.guildName,
          nickname: speaker.nickname ?? speaker.displayName,
          rateLimitAdmitted,
          rawContent: text,
          userId,
        })

        return undefined
      },
      (wavBuffer, { abortSignal, deadlineAt, ownerKey, principalKey }) => {
        if (!config.transcription?.apiKey)
          throw new Error('Protected Discord bridge STT configuration is missing.')

        return transcribeOpenAICompatible(wavBuffer, config.transcription, {
          abortSignal,
          deadlineAt,
          ownerKey,
          principalKey,
        })
      },
      undefined,
      {
        admit: ({ channelId, guildId, userId }) => {
          if (!this.runtimePolicyEnabled || !this.discordIngressEnabled)
            return false

          const discord = {
            channelId,
            guildId,
            guildMember: {
              displayName: '',
              id: userId,
              nickname: '',
            },
          }
          const sessionId = resolveDiscordSessionId(discord)
          if (!sessionId || resolveDiscordInputPolicy(discord, this.runtimeConfig).accepted === false)
            return false

          const decision = this.resolveIncomingRateLimit(sessionId, userId, guildId)
          if (!decision.accepted) {
            this.audit('voice-input-rejected', {
              channelId,
              guildId,
              reason: 'rate-limited',
              retryAfterMs: decision.retryAfterMs,
              sessionId,
              userId,
            })
          }
          return decision.accepted
        },
        allows: ({ channelId, guildId, userId }) => this.runtimePolicyEnabled
          && this.discordIngressEnabled
          && resolveDiscordInputPolicy({
            channelId,
            guildId,
            guildMember: {
              displayName: '',
              id: userId,
              nickname: '',
            },
          }, this.runtimeConfig).accepted,
      },
      {
        model: 'the model provider currently selected in local AIRI',
        stt: describeOpenAICompatibleProvider(config.transcription?.baseURL),
      },
    )

    this.setupEventHandlers()
  }

  private audit(event: DiscordAuditEventCode, fields: Record<string, unknown>): void {
    if (!this.runtimeConfig.auditLogEnabled)
      return

    log.withFields(projectDiscordAuditObservation(event, fields)).log('[discord-bot] audit')
  }

  /**
   * Starts one bounded Discord.js operation and retains its slot until the raw
   * promise settles, even when the exact turn stops awaiting it.
   */
  private beginRawDiscordTransport<T>(principalKey: string, operation: () => Promise<T> | T): Promise<T> | undefined {
    if (this.rawDiscordTransports.size >= MAX_RAW_DISCORD_TRANSPORTS) {
      this.audit('discord-transport-skipped', {
        activeTransportCount: this.rawDiscordTransports.size,
        reason: 'transport-capacity',
      })
      return undefined
    }

    const started = startDiscordTransport(principalKey, operation)
    if (started.accepted === false) {
      this.audit('discord-transport-skipped', {
        activeTransportCount: started.activeTransportCount,
        reason: started.reason,
      })
      return undefined
    }

    // This adapter-local registry preserves the existing eight-operation cap;
    // the shared registry additionally bounds lifecycle churn and principal fairness.
    const transport = started.task
    this.rawDiscordTransports.add(transport)
    void transport.then(
      () => this.rawDiscordTransports.delete(transport),
      () => this.rawDiscordTransports.delete(transport),
    )
    return transport
  }

  private isOwner(userId: string | undefined): boolean {
    return isDiscordOwner(userId, this.ownerUserId)
  }

  private resolveDiscordOwnerContext(userId: string | undefined) {
    return {
      configured: Boolean(this.ownerUserId),
      currentUserIsOwner: this.isOwner(userId),
    }
  }

  private resolveIncomingRateLimit(targetSessionId: string, userId: string, guildId: string | undefined, now = Date.now()): DiscordRateLimitDecision {
    this.pruneExpiredBoundedState(now)

    const layers = [
      ...(this.runtimeConfig.rateLimitMaxMessages > 0
        ? [{
            key: targetSessionId,
            limit: this.runtimeConfig.rateLimitMaxMessages,
            map: this.rateLimitBuckets,
          }]
        : []),
      {
        key: `user:${normalizeDiscordId(userId)}`,
        limit: this.runtimeConfig.userRateLimitMaxMessages,
        map: this.layeredRateLimitBuckets,
      },
      ...(normalizeDiscordId(guildId)
        ? [{
            key: `guild:${normalizeDiscordId(guildId)}`,
            limit: this.runtimeConfig.guildRateLimitMaxMessages,
            map: this.layeredRateLimitBuckets,
          }]
        : []),
      {
        key: 'global',
        limit: this.runtimeConfig.globalRateLimitMaxMessages,
        map: this.layeredRateLimitBuckets,
      },
    ]
    const resolvedLayers = layers.map((layer) => {
      const activeBucket = layer.map.get(layer.key)
      return {
        ...layer,
        bucket: activeBucket && activeBucket.resetAt > now
          ? activeBucket
          : {
              count: 0,
              lastAccessedAt: now,
              resetAt: now + this.runtimeConfig.rateLimitWindowMs,
            },
      }
    })
    const rejectedLayer = resolvedLayers.find(layer => layer.bucket.count >= layer.limit)
    if (rejectedLayer) {
      return {
        accepted: false,
        retryAfterMs: Math.max(0, rejectedLayer.bucket.resetAt - now),
      }
    }

    const newExactBucketCount = resolvedLayers.filter(layer => layer.map === this.rateLimitBuckets && !layer.map.has(layer.key)).length
    const newLayeredBucketCount = resolvedLayers.filter(layer => layer.map === this.layeredRateLimitBuckets && !layer.map.has(layer.key)).length
    if (
      this.rateLimitBuckets.size + newExactBucketCount > MAX_DISCORD_EXACT_RATE_LIMIT_BUCKETS
      || this.layeredRateLimitBuckets.size + newLayeredBucketCount > MAX_DISCORD_LAYERED_RATE_LIMIT_BUCKETS
    ) {
      // Live rate buckets are never evicted: doing so would let high-cardinality
      // inputs reset counters. Capacity exhaustion therefore fails closed.
      return {
        accepted: false,
        retryAfterMs: this.runtimeConfig.rateLimitWindowMs,
      }
    }

    for (const layer of resolvedLayers) {
      layer.map.delete(layer.key)
      layer.map.set(layer.key, {
        count: layer.bucket.count + 1,
        lastAccessedAt: now,
        resetAt: layer.bucket.resetAt,
      })
    }

    return { accepted: true }
  }

  private pruneExpiredBoundedState(now = Date.now(), force = false): void {
    if (!force && now < this.nextBoundedStateSweepAt)
      return

    for (const [sessionId, bucket] of this.rateLimitBuckets) {
      if (bucket.resetAt <= now)
        this.rateLimitBuckets.delete(sessionId)
    }
    for (const [scopeId, bucket] of this.layeredRateLimitBuckets) {
      if (bucket.resetAt <= now)
        this.layeredRateLimitBuckets.delete(scopeId)
    }
    for (const [messageId, state] of this.handledDiscordMessageIds) {
      if (state.expiresAt <= now)
        this.handledDiscordMessageIds.delete(messageId)
    }
    for (const [sessionId, state] of this.privacyNoticeSessionIds) {
      if (state.expiresAt <= now)
        this.privacyNoticeSessionIds.delete(sessionId)
    }
    for (const [sessionId, state] of this.replyTargetsBySessionId) {
      if (state.expiresAt <= now && !this.isReplyTargetActive(sessionId, state))
        this.replyTargetsBySessionId.delete(sessionId)
    }

    this.nextBoundedStateSweepAt = now + Math.min(this.runtimeConfig.rateLimitWindowMs, HANDLED_DISCORD_MESSAGE_ID_TTL_MS)
  }

  private hasSentPrivacyNotice(targetSessionId: string, now = Date.now()): boolean {
    this.pruneExpiredBoundedState(now)
    const state = this.privacyNoticeSessionIds.get(targetSessionId)
    if (!state || state.expiresAt <= now) {
      this.privacyNoticeSessionIds.delete(targetSessionId)
      return false
    }

    this.privacyNoticeSessionIds.delete(targetSessionId)
    this.privacyNoticeSessionIds.set(targetSessionId, {
      expiresAt: state.expiresAt,
      lastAccessedAt: now,
    })
    return true
  }

  private rememberPrivacyNotice(targetSessionId: string, now = Date.now()): void {
    this.pruneExpiredBoundedState(now, this.privacyNoticeSessionIds.size >= MAX_DISCORD_PRIVACY_NOTICE_SESSIONS)
    this.privacyNoticeSessionIds.delete(targetSessionId)
    while (this.privacyNoticeSessionIds.size >= MAX_DISCORD_PRIVACY_NOTICE_SESSIONS) {
      const leastRecentlyUsedSessionId = this.privacyNoticeSessionIds.keys().next().value
      if (typeof leastRecentlyUsedSessionId !== 'string')
        break
      this.privacyNoticeSessionIds.delete(leastRecentlyUsedSessionId)
    }
    this.privacyNoticeSessionIds.set(targetSessionId, {
      expiresAt: now + DISCORD_PRIVACY_NOTICE_TTL_MS,
      lastAccessedAt: now,
    })
  }

  private storeReplyTarget(targetSessionId: string, target: DiscordReplyTarget, now = Date.now()): boolean {
    this.pruneExpiredBoundedState(now, this.replyTargetsBySessionId.size >= MAX_DISCORD_REPLY_TARGETS)
    const existing = this.replyTargetsBySessionId.get(targetSessionId)
    if (existing) {
      this.replyTargetsBySessionId.delete(targetSessionId)
      this.replyTargetsBySessionId.set(targetSessionId, {
        activeIngressCount: existing.activeIngressCount + 1,
        expiresAt: now + DISCORD_REPLY_TARGET_TTL_MS,
        lastTurnGeneration: existing.lastTurnGeneration,
        lastAccessedAt: now,
        target,
      })
      return true
    }

    if (this.replyTargetsBySessionId.size >= MAX_DISCORD_REPLY_TARGETS) {
      for (const [sessionId, state] of this.replyTargetsBySessionId) {
        if (this.isReplyTargetActive(sessionId, state))
          continue

        this.replyTargetsBySessionId.delete(sessionId)
        break
      }
    }
    if (this.replyTargetsBySessionId.size >= MAX_DISCORD_REPLY_TARGETS)
      return false

    this.replyTargetsBySessionId.set(targetSessionId, {
      activeIngressCount: 1,
      expiresAt: now + DISCORD_REPLY_TARGET_TTL_MS,
      lastTurnGeneration: 0,
      lastAccessedAt: now,
      target,
    })
    return true
  }

  private releaseReplyTargetIngress(targetSessionId: string, now = Date.now()): void {
    const state = this.replyTargetsBySessionId.get(targetSessionId)
    if (!state)
      return

    this.replyTargetsBySessionId.delete(targetSessionId)
    this.replyTargetsBySessionId.set(targetSessionId, {
      ...state,
      activeIngressCount: Math.max(0, state.activeIngressCount - 1),
      lastAccessedAt: now,
    })
  }

  private isReplyTargetActive(targetSessionId: string, state = this.replyTargetsBySessionId.get(targetSessionId)): boolean {
    return Boolean(state?.activeIngressCount || this.pendingDiscordTurnIdsBySessionId.has(targetSessionId))
  }

  private resolveSavedReplyTarget(targetSessionId: string, now = Date.now()): DiscordReplyTarget | undefined {
    this.pruneExpiredBoundedState(now)
    const state = this.replyTargetsBySessionId.get(targetSessionId)
    if (!state)
      return undefined

    if (state.expiresAt <= now && !this.isReplyTargetActive(targetSessionId, state)) {
      this.replyTargetsBySessionId.delete(targetSessionId)
      return undefined
    }

    this.replyTargetsBySessionId.delete(targetSessionId)
    this.replyTargetsBySessionId.set(targetSessionId, {
      ...state,
      expiresAt: now + DISCORD_REPLY_TARGET_TTL_MS,
      lastAccessedAt: now,
    })
    return state.target
  }

  private claimDiscordMessage(messageId: string | undefined, now = Date.now()): boolean {
    const normalizedMessageId = normalizeDiscordId(messageId)
    if (!normalizedMessageId)
      return true

    this.pruneExpiredBoundedState(now, this.handledDiscordMessageIds.size >= MAX_HANDLED_DISCORD_MESSAGE_IDS)
    const existing = this.handledDiscordMessageIds.get(normalizedMessageId)
    if (existing && existing.expiresAt > now)
      return false

    this.handledDiscordMessageIds.delete(normalizedMessageId)
    if (this.handledDiscordMessageIds.size >= MAX_HANDLED_DISCORD_MESSAGE_IDS)
      return false

    this.handledDiscordMessageIds.set(normalizedMessageId, {
      expiresAt: now + HANDLED_DISCORD_MESSAGE_ID_TTL_MS,
      lastAccessedAt: now,
    })
    return true
  }

  private async paceIncomingText(
    source: DiscordTextInputSource,
    abortSignal: AbortSignal,
    isGenerationActive: () => boolean,
  ): Promise<boolean> {
    const active = () => !abortSignal.aborted && isGenerationActive()
    if (!active())
      return false

    const pacingMs = this.runtimeConfig.messagePacingMs
    if (pacingMs <= 0)
      return true

    if (source.sendTyping) {
      try {
        const transport = this.beginRawDiscordTransport(`discord-user-${source.userId}`, async () => {
          if (!active())
            return false
          await source.sendTyping?.()
          return true
        })
        if (!transport)
          return false
        const typing = await waitForDiscordTransportBoundary(
          transport,
          abortSignal,
        )
        if (!typing.completed || !typing.value || !active())
          return false
      }
      catch {
        if (!active())
          return false
        logDiscordBridgeFailure('warn', {
          eventCode: 'typing-indicator-failed',
          failureCategory: 'discord-transport',
          retryable: true,
          terminal: false,
        })
      }
    }

    // Discord typing indicators expire quickly; this small pause makes the
    // bot feel less abrupt before the model request starts.
    return await waitForDiscordTurnDelay(pacingMs, abortSignal)
  }

  private async sendPrivacyNoticeIfNeeded(
    source: DiscordTextInputSource,
    targetSessionId: string,
    discordContext: Discord,
    abortSignal?: AbortSignal,
    isGenerationActive: () => boolean = () => true,
  ): Promise<boolean> {
    const active = () => !abortSignal?.aborted && isGenerationActive()
    if (!active())
      return false
    if (!this.runtimeConfig.privacyNoticeEnabled || this.hasSentPrivacyNotice(targetSessionId))
      return true

    if (!source.sendPrivacyNotice) {
      const target = await this.resolveOutputSendTarget(discordContext, abortSignal, active)
      if (!target || !active())
        return false

      const sent = await this.sendDiscordContent(
        target,
        this.runtimeConfig.privacyNoticeText,
        `discord-user-${source.userId}`,
        abortSignal,
        active,
      )
      if (!sent || !active())
        return false
      this.rememberPrivacyNotice(targetSessionId)
      this.audit('privacy-notice-sent', {
        channelId: source.channelId,
        guildId: source.guildId,
        userId: source.userId,
        sessionId: targetSessionId,
      })
      return true
    }

    try {
      const sent = await this.sendDiscordContent({
        send: payload => source.sendPrivacyNotice?.(payload, abortSignal),
      }, this.runtimeConfig.privacyNoticeText, `discord-user-${source.userId}`, abortSignal, active)
      if (!sent || !active())
        return false
      this.rememberPrivacyNotice(targetSessionId)
      this.audit('privacy-notice-sent', {
        channelId: source.channelId,
        guildId: source.guildId,
        userId: source.userId,
        sessionId: targetSessionId,
      })
      return true
    }
    catch (error) {
      if (!active())
        return false
      const failure = error instanceof DiscordTextDeliveryError
        ? {
            deliveredChunks: error.deliveredChunks,
            errorName: error.name,
            reason: error.reason,
            totalChunks: error.totalChunks,
          }
        : {
            errorName: error instanceof DiscordTextChunkingError ? error.name : 'DiscordTextDeliveryError',
          }
      this.audit('privacy-notice-delivery-failed', {
        ...failure,
        channelId: source.channelId,
        guildId: source.guildId,
        sessionId: targetSessionId,
        userId: source.userId,
      })
      log.withFields(failure).warn('[discord-bot] failed to send privacy notice')
      return false
    }
  }

  private async resolveOutputSendTarget(
    discordContext: Discord,
    abortSignal?: AbortSignal,
    isGenerationActive: () => boolean = () => true,
  ): Promise<DiscordSendTarget | undefined> {
    const active = () => !abortSignal?.aborted && isGenerationActive()
    if (!active())
      return undefined

    const sessionId = resolveDiscordSessionId(discordContext)
    const savedTarget = sessionId ? this.resolveSavedReplyTarget(sessionId) : undefined
    const fallbackTarget = resolveDiscordReplyTarget(discordContext)
    const target = savedTarget ?? fallbackTarget
    if (!target)
      return undefined

    if (target.directMessage) {
      try {
        const channelTransport = this.beginRawDiscordTransport(`discord-user-${target.userId}`, () => {
          if (!active())
            return undefined
          return this.discordClient.channels.fetch(target.channelId)
        })
        if (!channelTransport)
          return undefined
        const channelResult = abortSignal
          ? await waitForDiscordTransportBoundary(channelTransport, abortSignal)
          : { completed: true as const, value: await channelTransport }
        if (!channelResult.completed || !active())
          return undefined
        const channel = channelResult.value
        if (channel?.isTextBased() && isDiscordSendTarget(channel))
          return channel
      }
      catch {
        if (!active())
          return undefined
        logDiscordBridgeFailure('warn', {
          eventCode: 'dm-channel-resolution-failed',
          failureCategory: 'discord-transport',
          retryable: true,
          terminal: false,
        })
      }

      try {
        const userTransport = this.beginRawDiscordTransport(`discord-user-${target.userId}`, () => {
          if (!active())
            return undefined
          return this.discordClient.users.fetch(target.userId)
        })
        if (!userTransport)
          return undefined
        const userResult = abortSignal
          ? await waitForDiscordTransportBoundary(userTransport, abortSignal)
          : { completed: true as const, value: await userTransport }
        if (!userResult.completed || !active())
          return undefined
        const user = userResult.value
        if (isDiscordSendTarget(user))
          return user
      }
      catch {
        if (!active())
          return undefined
        logDiscordBridgeFailure('warn', {
          eventCode: 'dm-user-resolution-failed',
          failureCategory: 'discord-transport',
          retryable: true,
          terminal: false,
        })
      }
    }

    const channelTransport = this.beginRawDiscordTransport(`discord-user-${target.userId}`, () => {
      if (!active())
        return undefined
      return this.discordClient.channels.fetch(target.channelId)
    })
    if (!channelTransport)
      return undefined
    const channelResult = abortSignal
      ? await waitForDiscordTransportBoundary(channelTransport, abortSignal)
      : { completed: true as const, value: await channelTransport }
    if (!channelResult.completed || !active())
      return undefined
    const channel = channelResult.value
    if (channel?.isTextBased() && isDiscordSendTarget(channel))
      return channel

    return undefined
  }

  /** Starts best-effort overload delivery through the process-wide raw transport cap. */
  private async scheduleDiscordOverloadStatus(
    discordContext: Discord,
    ingressLifecycle: AbortSignal,
    isGenerationActive: () => boolean = () => true,
  ): Promise<void> {
    const active = () => !ingressLifecycle.aborted && isGenerationActive()
    if (!active())
      return

    try {
      const target = await this.resolveOutputSendTarget(discordContext, ingressLifecycle, active)
      if (!target || !active())
        return
      await this.sendDiscordContent(
        target,
        DISCORD_AIRI_QUEUE_FULL_MESSAGE,
        `discord-user-${discordContext.guildMember?.id ?? 'unknown'}`,
        ingressLifecycle,
        active,
      )
    }
    catch {
      if (active()) {
        logDiscordBridgeFailure('warn', {
          eventCode: 'overload-status-delivery-failed',
          failureCategory: 'discord-transport',
          retryable: true,
          terminal: false,
        })
      }
    }
  }

  private canAdmitDiscordTurn(targetSessionId: string): boolean {
    return this.pendingDiscordTurnsById.size < MAX_PENDING_DISCORD_TURNS
      && (this.pendingDiscordTurnIdsBySessionId.get(targetSessionId)?.size ?? 0) < MAX_PENDING_DISCORD_TURNS_PER_SESSION
  }

  private allocateDiscordTurn(
    targetSessionId: string,
    now = Date.now(),
    upstreamDeadlineAt?: number,
  ): ChatTurnCorrelation | undefined {
    const state = this.replyTargetsBySessionId.get(targetSessionId)
    if (!state)
      return undefined

    const deadlineAt = Math.min(
      now + DISCORD_AIRI_RESPONSE_TIMEOUT_MS,
      upstreamDeadlineAt ?? Number.POSITIVE_INFINITY,
    )
    if (deadlineAt <= now)
      return undefined

    const generation = state.lastTurnGeneration >= Number.MAX_SAFE_INTEGER
      ? 1
      : state.lastTurnGeneration + 1
    this.replyTargetsBySessionId.delete(targetSessionId)
    this.replyTargetsBySessionId.set(targetSessionId, {
      ...state,
      expiresAt: now + DISCORD_REPLY_TARGET_TTL_MS,
      lastAccessedAt: now,
      lastTurnGeneration: generation,
    })

    return {
      id: randomUUID(),
      generation,
      deadlineAt,
    }
  }

  private takePendingDiscordTurn(turnId: string): PendingDiscordTurn | undefined {
    const pending = this.pendingDiscordTurnsById.get(turnId)
    if (!pending)
      return undefined

    this.pendingDiscordTurnsById.delete(turnId)
    clearTimeout(pending.timeout)
    if (pending.notificationTimeout)
      clearTimeout(pending.notificationTimeout)
    pending.removeAbortListener?.()
    pending.responseAbortController.abort('settled')
    pending.notificationAbortController.abort('settled')

    const sessionTurnIds = this.pendingDiscordTurnIdsBySessionId.get(pending.sessionId)
    sessionTurnIds?.delete(turnId)
    if (sessionTurnIds?.size === 0)
      this.pendingDiscordTurnIdsBySessionId.delete(pending.sessionId)

    return pending
  }

  private beginPendingDiscordTurnDelivery(
    turnId: string,
    phase: Extract<PendingDiscordTurn['phase'], 'response' | 'timeout'>,
  ): PendingDiscordTurn | undefined {
    const pending = this.pendingDiscordTurnsById.get(turnId)
    if (!pending || pending.phase !== 'pending')
      return undefined

    pending.phase = phase
    if (phase === 'timeout')
      clearTimeout(pending.timeout)
    return pending
  }

  private isPendingDiscordTurnDeliveryActive(
    pending: PendingDiscordTurn,
    phase: Extract<PendingDiscordTurn['phase'], 'response' | 'timeout'>,
  ): boolean {
    const abortSignal = phase === 'response'
      ? pending.responseAbortController.signal
      : pending.notificationAbortController.signal
    return this.pendingDiscordTurnsById.get(pending.turn.id) === pending
      && pending.phase === phase
      && !abortSignal.aborted
      && pending.configGeneration === this.runtimeConfigGeneration
      && (phase === 'timeout' || pending.turn.deadlineAt > Date.now())
  }

  private isPendingDiscordTurnIngressActive(pending: PendingDiscordTurn): boolean {
    return this.pendingDiscordTurnsById.get(pending.turn.id) === pending
      && pending.phase === 'pending'
      && !pending.responseAbortController.signal.aborted
      && pending.configGeneration === this.runtimeConfigGeneration
      && pending.turn.deadlineAt > Date.now()
  }

  private emitDiscordTurnCancellation(pending: PendingDiscordTurn, reason: ChatTurnCancelEvent['reason']): void {
    if (pending.cancellationEmitted)
      return
    pending.cancellationEmitted = true
    this.airiClient.send({
      type: 'chat:turn:cancel',
      data: {
        cancelledAt: Date.now(),
        reason,
        sessionId: pending.sessionId,
        turn: pending.turn,
      },
    })
    this.audit('turn-cancelled', {
      reason,
      sessionId: pending.sessionId,
      turnId: pending.turn.id,
      turnGeneration: pending.turn.generation,
    })
  }

  private cancelPendingDiscordTurn(turnId: string, reason: ChatTurnCancelEvent['reason']): PendingDiscordTurn | undefined {
    const pending = this.pendingDiscordTurnsById.get(turnId)
    if (!pending)
      return undefined

    pending.responseAbortController.abort(reason)
    pending.notificationAbortController.abort(reason)
    try {
      this.emitDiscordTurnCancellation(pending, reason)
    }
    finally {
      // Cancellation delivery is observable but not authoritative for local
      // ownership. A failed server-channel send must never retain this timer or
      // let an old turn mutate a later lifecycle generation.
      this.takePendingDiscordTurn(turnId)
    }
    return pending
  }

  private cancelPendingDiscordTurns(reason: ChatTurnCancelEvent['reason']): void {
    let firstCancellationError: unknown
    let cancellationFailed = false
    for (const turnId of this.pendingDiscordTurnsById.keys()) {
      try {
        this.cancelPendingDiscordTurn(turnId, reason)
      }
      catch (error) {
        if (!cancellationFailed) {
          firstCancellationError = error
          cancellationFailed = true
        }
      }
    }

    if (cancellationFailed)
      throw firstCancellationError
  }

  /** Cancels reserved or active turns that no longer satisfy the current parent policy. */
  private revalidatePendingDiscordTurnPolicies(): void {
    let firstCancellationError: unknown
    let cancellationFailed = false
    for (const [turnId, pending] of this.pendingDiscordTurnsById) {
      const decision = resolveDiscordInputPolicy(pending.discordContext, this.runtimeConfig)
      if (decision.accepted !== false)
        continue

      this.audit('input-rejected', {
        reason: decision.reason,
        sessionId: pending.sessionId,
        turnId: pending.turn.id,
        turnGeneration: pending.turn.generation,
      })
      try {
        this.cancelPendingDiscordTurn(turnId, 'reset')
      }
      catch (error) {
        if (!cancellationFailed) {
          firstCancellationError = error
          cancellationFailed = true
        }
      }
    }

    if (cancellationFailed)
      throw firstCancellationError
  }

  private async expirePendingDiscordTurn(turnId: string): Promise<void> {
    const existing = this.pendingDiscordTurnsById.get(turnId)
    if (!existing || existing.phase === 'timeout')
      return
    if (existing.phase === 'response')
      existing.phase = 'timeout'
    const pending = existing.phase === 'pending'
      ? this.beginPendingDiscordTurnDelivery(turnId, 'timeout')
      : existing
    if (!pending)
      return

    let firstExpirationError: unknown
    let expirationFailed = false
    clearTimeout(pending.timeout)
    pending.responseAbortController.abort('deadline')
    try {
      this.emitDiscordTurnCancellation(pending, 'deadline')
    }
    catch (error) {
      firstExpirationError = error
      expirationFailed = true
    }
    pending.notificationTimeout = setTimeout(() => {
      pending.notificationAbortController.abort('deadline')
    }, DISCORD_TIMEOUT_NOTIFICATION_TIMEOUT_MS)
    try {
      try {
        const target = await this.resolveOutputSendTarget(
          pending.discordContext,
          pending.notificationAbortController.signal,
          () => this.isPendingDiscordTurnDeliveryActive(pending, 'timeout'),
        )
        if (target && this.isPendingDiscordTurnDeliveryActive(pending, 'timeout')) {
          await this.sendDiscordContent(
            target,
            DISCORD_AIRI_RESPONSE_TIMEOUT_MESSAGE,
            `discord-user-${pending.discordContext.guildMember?.id ?? 'unknown'}`,
            pending.notificationAbortController.signal,
            () => this.isPendingDiscordTurnDeliveryActive(pending, 'timeout'),
          )
        }
      }
      catch (error) {
        if (!expirationFailed) {
          firstExpirationError = error
          expirationFailed = true
        }
      }
    }
    finally {
      if (this.pendingDiscordTurnsById.get(turnId) === pending)
        this.takePendingDiscordTurn(turnId)
    }

    if (expirationFailed)
      throw firstExpirationError
  }

  private registerPendingDiscordTurn(
    discordContext: Discord,
    targetSessionId: string,
    turn: ChatTurnCorrelation,
    abortSignal?: AbortSignal,
  ): boolean {
    if (!this.canAdmitDiscordTurn(targetSessionId))
      return false

    const timeout = setTimeout(() => {
      void this.expirePendingDiscordTurn(turn.id).catch(() => {
        logDiscordBridgeFailure('warn', {
          eventCode: 'pending-turn-expiration-failed',
          failureCategory: 'turn-lifecycle',
          retryable: false,
          terminal: true,
        })
      })
    }, Math.max(0, turn.deadlineAt - Date.now()))
    const pending: PendingDiscordTurn = {
      cancellationEmitted: false,
      configGeneration: this.runtimeConfigGeneration,
      discordContext,
      notificationAbortController: new AbortController(),
      phase: 'pending',
      responseAbortController: new AbortController(),
      sessionId: targetSessionId,
      timeout,
      turn,
    }
    this.pendingDiscordTurnsById.set(turn.id, pending)

    const sessionTurnIds = this.pendingDiscordTurnIdsBySessionId.get(targetSessionId) ?? new Set<string>()
    sessionTurnIds.add(turn.id)
    this.pendingDiscordTurnIdsBySessionId.set(targetSessionId, sessionTurnIds)

    if (abortSignal) {
      const cancelAbortedTurn = () => {
        this.cancelPendingDiscordTurn(turn.id, 'reset')
      }
      abortSignal.addEventListener('abort', cancelAbortedTurn, { once: true })
      pending.removeAbortListener = () => abortSignal.removeEventListener('abort', cancelAbortedTurn)
      if (abortSignal.aborted)
        cancelAbortedTurn()
    }

    return this.pendingDiscordTurnsById.has(turn.id)
  }

  private clearBoundedRuntimeState(reason: ChatTurnCancelEvent['reason']): void {
    let firstCleanupError: unknown
    let cleanupFailed = false
    const cleanup = (operation: () => void) => {
      try {
        operation()
      }
      catch (error) {
        if (!cleanupFailed) {
          firstCleanupError = error
          cleanupFailed = true
        }
      }
    }
    const previousIngressLifecycle = this.discordIngressLifecycle
    this.discordIngressLifecycle = new AbortController()
    cleanup(() => previousIngressLifecycle.abort(reason))
    cleanup(() => this.clearPendingMemoryCommands(new Error('Discord bridge stopped before the memory command completed.')))
    cleanup(() => this.cancelPendingDiscordTurns(reason))
    this.handledDiscordMessageIds.clear()
    this.layeredRateLimitBuckets.clear()
    this.pendingDiscordTurnIdsBySessionId.clear()
    this.privacyNoticeSessionIds.clear()
    this.rateLimitBuckets.clear()
    this.replyTargetsBySessionId.clear()
    this.nextBoundedStateSweepAt = 0

    if (cleanupFailed)
      throw firstCleanupError
  }

  private refreshDiscordIngressAvailability(): void {
    this.discordIngressEnabled = this.runtimePolicyEnabled
      && this.discordTransportReady
      && this.airiChannelReady
      && !this.disconnectCleanupTask
      && !this.disconnectCleanupFailed
  }

  private beginDisconnectCleanup(): void {
    this.discordIngressEnabled = false
    if (this.adapterStopping || !this.runtimePolicyEnabled)
      return
    if (this.disconnectCleanupTask)
      return

    let firstCleanupError: unknown
    let cleanupFailed = false
    try {
      this.clearBoundedRuntimeState('disconnect')
    }
    catch (error) {
      firstCleanupError = error
      cleanupFailed = true
    }

    const task = (async () => {
      try {
        await this.voiceManager.stop()
      }
      catch (error) {
        if (!cleanupFailed) {
          firstCleanupError = error
          cleanupFailed = true
        }
      }

      if (cleanupFailed)
        throw firstCleanupError
    })()
    this.disconnectCleanupTask = task
    void task.then(
      () => {
        if (this.disconnectCleanupTask !== task)
          return
        this.disconnectCleanupTask = undefined
        this.disconnectCleanupFailed = false
        this.refreshDiscordIngressAvailability()
      },
      () => {
        if (this.disconnectCleanupTask !== task)
          return
        this.disconnectCleanupTask = undefined
        this.disconnectCleanupFailed = true
        this.refreshDiscordIngressAvailability()
        logDiscordBridgeFailure('error', {
          eventCode: 'disconnect-cleanup-failed',
          failureCategory: 'cleanup',
          retryable: true,
          terminal: true,
        })
      },
    )
  }

  private async sendDiscordContent(
    target: DiscordSendTarget,
    content: string,
    principalKey: string,
    abortSignal?: AbortSignal,
    isGenerationActive: () => boolean = () => true,
  ): Promise<boolean> {
    const active = () => !abortSignal?.aborted && isGenerationActive()
    if (!active())
      return false

    const sendChunk = async (payload: SafeDiscordTextPayload): Promise<boolean> => {
      // NOTICE:
      // Discord.js may confirm send() immediately before the lifecycle signal aborts.
      // The wrapper task settles on later microtasks, so the abort race alone would undercount that confirmed chunk.
      // Source/context: `airi-adapter.turn-correlation.test.ts`, Discord audit D-022 confirmed-send regression.
      // Removal condition: Discord.js exposes an abortable send API with an atomic confirmation result.
      let confirmed = false
      const transport = this.beginRawDiscordTransport(principalKey, async () => {
        // startDiscordTransport invokes on a microtask. Recheck exact lifecycle
        // ownership there so a synchronous stop cannot launch stale REST work.
        if (!active())
          return false
        await target.send(payload)
        confirmed = true
        return true
      })
      if (!transport)
        throw new DiscordTransportCapacityError()
      if (abortSignal) {
        const delivery = await waitForDiscordTransportBoundary(transport, abortSignal)
        if (!delivery.completed)
          return confirmed
        return delivery.value
      }
      return await transport
    }

    const delivery = await deliverDiscordText(content, sendChunk, {
      isActive: active,
      signal: abortSignal,
    })
    if (delivery.status === 'cancelled') {
      this.audit('discord-delivery-cancelled', {
        deliveredChunks: delivery.deliveredChunks,
        totalChunks: delivery.totalChunks,
      })
    }
    return delivery.status === 'delivered'
  }

  /** Runs preprocessing and forwarding only while the ingress-owned exact turn remains active. */
  private async processPendingDiscordTurnIngress(
    pending: PendingDiscordTurn,
    source: DiscordTextInputSource,
  ): Promise<void> {
    if (!this.isPendingDiscordTurnIngressActive(pending))
      return

    const paced = await this.paceIncomingText(
      source,
      pending.responseAbortController.signal,
      () => this.isPendingDiscordTurnIngressActive(pending),
    )
    if (!paced || !this.isPendingDiscordTurnIngressActive(pending))
      return

    const privacyNoticeReady = await this.sendPrivacyNoticeIfNeeded(
      source,
      pending.sessionId,
      pending.discordContext,
      pending.responseAbortController.signal,
      () => this.isPendingDiscordTurnIngressActive(pending),
    )
    if (!privacyNoticeReady || !this.isPendingDiscordTurnIngressActive(pending)) {
      if (this.isPendingDiscordTurnIngressActive(pending)) {
        this.audit('input-rejected', {
          reason: 'privacy-notice-failed',
          channelId: source.channelId,
          guildId: source.guildId,
          userId: source.userId,
          sessionId: pending.sessionId,
        })
        this.takePendingDiscordTurn(pending.turn.id)
      }
      return
    }

    this.audit('input-accepted', {
      channelId: source.channelId,
      guildId: source.guildId,
      userId: source.userId,
      sessionId: pending.sessionId,
      directMessage: source.directMessage,
    })

    const forwarded = this.airiClient.send({
      type: 'input:text',
      data: {
        text: source.content,
        textRaw: source.rawContent,
        turn: pending.turn,
        overrides: {
          cloudSync: 'disabled',
          sessionId: pending.sessionId,
        },
        discord: pending.discordContext,
      },
    })
    if (!forwarded) {
      this.audit('input-rejected', {
        reason: 'airi-channel-not-connected',
        channelId: source.channelId,
        guildId: source.guildId,
        userId: source.userId,
        sessionId: pending.sessionId,
        turnId: pending.turn.id,
        turnGeneration: pending.turn.generation,
      })

      const target = await this.resolveOutputSendTarget(
        pending.discordContext,
        pending.responseAbortController.signal,
        () => this.isPendingDiscordTurnIngressActive(pending),
      )
      if (target && this.isPendingDiscordTurnIngressActive(pending)) {
        await this.sendDiscordContent(
          target,
          DISCORD_AIRI_CHANNEL_NOT_READY_MESSAGE,
          `discord-user-${source.userId}`,
          pending.responseAbortController.signal,
          () => this.isPendingDiscordTurnIngressActive(pending),
        )
      }
      if (this.pendingDiscordTurnsById.get(pending.turn.id) === pending && pending.phase === 'pending')
        this.takePendingDiscordTurn(pending.turn.id)
      return
    }

    this.audit('input-forwarded', {
      channelId: source.channelId,
      guildId: source.guildId,
      userId: source.userId,
      sessionId: pending.sessionId,
      turnId: pending.turn.id,
      turnGeneration: pending.turn.generation,
      directMessage: source.directMessage,
    })
  }

  /** Runs one statically accepted envelope after exact-session scheduling. */
  private async processDiscordTextInputEnvelope(
    source: DiscordTextInputSource,
    normalizedDiscord: Discord,
    targetSessionId: string,
    ingressDeadlineAt: number,
    ingressLifecycle: AbortSignal,
    configGeneration: number,
  ): Promise<void> {
    const active = () => !source.abortSignal?.aborted
      && !ingressLifecycle.aborted
      && configGeneration === this.runtimeConfigGeneration
    if (!active() || ingressDeadlineAt <= Date.now()) {
      if (active()) {
        this.audit('input-rejected', {
          reason: 'turn-deadline-expired',
          channelId: source.channelId,
          guildId: source.guildId,
          userId: source.userId,
          sessionId: targetSessionId,
        })
      }
      return
    }

    if (source.authorize) {
      const authorized = await source.authorize(ingressDeadlineAt)
      if (!authorized || !active())
        return
    }

    if (!this.canAdmitDiscordTurn(targetSessionId)) {
      this.audit('input-rejected', {
        reason: 'turn-queue-capacity',
        channelId: source.channelId,
        guildId: source.guildId,
        userId: source.userId,
        sessionId: targetSessionId,
      })
      await this.scheduleDiscordOverloadStatus(normalizedDiscord, ingressLifecycle, active)
      return
    }

    // Queue wait and authoritative reply lookup consume the same absolute
    // ingress budget. Capture one admission time immediately before rate quota
    // so an expired envelope cannot spend quota without owning a turn.
    const allocationNow = Date.now()
    if (ingressDeadlineAt <= allocationNow) {
      this.audit('input-rejected', {
        reason: 'turn-deadline-expired',
        channelId: source.channelId,
        guildId: source.guildId,
        userId: source.userId,
        sessionId: targetSessionId,
      })
      return
    }

    if (!source.rateLimitAdmitted) {
      const rateLimitDecision = this.resolveIncomingRateLimit(targetSessionId, source.userId, source.guildId)
      if (!rateLimitDecision.accepted) {
        this.audit('input-rejected', {
          reason: 'rate-limited',
          retryAfterMs: rateLimitDecision.retryAfterMs,
          channelId: source.channelId,
          guildId: source.guildId,
          userId: source.userId,
          sessionId: targetSessionId,
        })
        return
      }
    }

    const replyTarget = resolveDiscordReplyTarget(normalizedDiscord)
    const replyTargetStored = replyTarget ? this.storeReplyTarget(targetSessionId, replyTarget) : false
    if (replyTarget && !replyTargetStored) {
      this.audit('input-rejected', {
        reason: 'reply-state-capacity',
        channelId: source.channelId,
        guildId: source.guildId,
        userId: source.userId,
        sessionId: targetSessionId,
      })
      return
    }

    const turn = this.allocateDiscordTurn(targetSessionId, allocationNow, ingressDeadlineAt)
    const turnRegistered = turn
      ? this.registerPendingDiscordTurn(normalizedDiscord, targetSessionId, turn, source.abortSignal)
      : false
    if (!turn || !turnRegistered) {
      if (replyTargetStored)
        this.releaseReplyTargetIngress(targetSessionId)
      if (!active())
        return

      this.audit('input-rejected', {
        reason: 'turn-queue-capacity',
        channelId: source.channelId,
        guildId: source.guildId,
        userId: source.userId,
        sessionId: targetSessionId,
      })
      await this.scheduleDiscordOverloadStatus(normalizedDiscord, ingressLifecycle, active)
      return
    }

    const pending = this.pendingDiscordTurnsById.get(turn.id)
    if (!pending) {
      if (replyTargetStored)
        this.releaseReplyTargetIngress(targetSessionId)
      return
    }

    try {
      await this.processPendingDiscordTurnIngress(pending, source)
    }
    catch (error) {
      if (this.pendingDiscordTurnsById.get(turn.id) === pending)
        this.cancelPendingDiscordTurn(turn.id, 'reset')
      throw error
    }
    finally {
      if (replyTargetStored)
        this.releaseReplyTargetIngress(targetSessionId)
    }
  }

  private async handleDiscordTextInput(source: DiscordTextInputSource): Promise<void> {
    const receivedAt = Date.now()
    const upstreamDeadlineAt = source.deadlineAt !== undefined && Number.isFinite(source.deadlineAt)
      ? source.deadlineAt
      : undefined
    const ingressDeadlineAt = Math.min(
      upstreamDeadlineAt ?? Number.POSITIVE_INFINITY,
      receivedAt + DISCORD_AIRI_RESPONSE_TIMEOUT_MS,
    )
    if (source.abortSignal?.aborted || ingressDeadlineAt <= receivedAt) {
      this.audit('input-rejected', {
        reason: source.abortSignal?.aborted ? 'turn-cancelled' : 'turn-deadline-expired',
        channelId: source.channelId,
        guildId: source.guildId,
        userId: source.userId,
        directMessage: source.directMessage,
      })
      return
    }

    const ingressLifecycle = this.discordIngressLifecycle.signal
    const configGeneration = this.runtimeConfigGeneration

    this.audit('input-handling-started', {
      channelId: source.channelId,
      guildId: source.guildId,
      userId: source.userId,
      directMessage: source.directMessage,
      contentLength: source.content.length,
    })

    if (!source.content) {
      this.audit('input-rejected', {
        reason: 'empty-content',
        channelId: source.channelId,
        guildId: source.guildId,
        userId: source.userId,
        directMessage: source.directMessage,
      })
      return
    }

    log.withFields({
      contentLength: source.content.length,
      directMessage: source.directMessage,
    }).log('Received Discord text message')

    const discordContext: Discord = {
      channelId: source.channelId,
      guildId: source.guildId,
      guildName: source.guildName,
      guildMember: {
        id: source.userId,
        displayName: source.displayName,
        nickname: source.nickname,
      },
      owner: this.resolveDiscordOwnerContext(source.userId),
      memory: {
        shortTermLimit: this.shortTermLimit,
      },
    }
    const normalizedDiscord = normalizeDiscordMetadata(discordContext) ?? discordContext
    const targetSessionId = resolveDiscordSessionId(normalizedDiscord)
    if (!targetSessionId) {
      log.warn('Dropping Discord input because required guild/channel/user metadata was incomplete.')
      this.audit('input-rejected', {
        reason: 'missing-session-metadata',
        channelId: source.channelId,
        guildId: source.guildId,
        userId: source.userId,
      })
      return
    }

    const policyDecision = resolveDiscordInputPolicy(normalizedDiscord, this.runtimeConfig)
    if (policyDecision.accepted === false) {
      this.audit('input-rejected', {
        reason: policyDecision.reason,
        channelId: source.channelId,
        guildId: source.guildId,
        userId: source.userId,
        sessionId: targetSessionId,
      })
      return
    }

    const scheduled = this.discordIngressScheduler.schedule(targetSessionId, () => this.processDiscordTextInputEnvelope(
      source,
      normalizedDiscord,
      targetSessionId,
      ingressDeadlineAt,
      ingressLifecycle,
      configGeneration,
    ))
    if (scheduled.accepted === false) {
      this.audit('input-rejected', {
        reason: scheduled.reason,
        channelId: source.channelId,
        guildId: source.guildId,
        userId: source.userId,
        sessionId: targetSessionId,
      })
      await this.scheduleDiscordOverloadStatus(
        normalizedDiscord,
        ingressLifecycle,
        () => configGeneration === this.runtimeConfigGeneration,
      )
      return
    }
    await scheduled.task
  }

  private resolveInteractionDiscordContext(interaction: ChatInputCommandInteraction): Discord {
    const member = interaction.member
    const displayName = member && 'displayName' in member && typeof member.displayName === 'string'
      ? member.displayName
      : interaction.user.globalName ?? interaction.user.username
    const nickname = member && 'nickname' in member && typeof member.nickname === 'string'
      ? member.nickname
      : displayName

    return {
      channelId: interaction.channelId ?? undefined,
      guildId: interaction.guildId ?? undefined,
      guildName: interaction.guild?.name ?? undefined,
      guildMember: {
        id: interaction.user.id,
        displayName,
        nickname,
      },
      owner: this.resolveDiscordOwnerContext(interaction.user.id),
      memory: {
        shortTermLimit: this.shortTermLimit,
      },
    }
  }

  private resolveAiriMemoryCommandAction(interaction: ChatInputCommandInteraction): DiscordMemoryCommandAction | undefined {
    const group = interaction.options.getSubcommandGroup(false)
    const subcommand = interaction.options.getSubcommand()

    if (group === 'memory') {
      if (subcommand === 'opt-in')
        return 'memory-opt-in'
      if (subcommand === 'opt-out')
        return 'memory-opt-out'
      return undefined
    }

    if (subcommand === 'privacy')
      return 'privacy'
    if (subcommand === 'forget')
      return 'forget-current-session'

    return undefined
  }

  private waitForMemoryCommandResult(commandId: string): Promise<DiscordMemoryCommandResultEvent> {
    if (this.pendingMemoryCommands.size >= MAX_PENDING_DISCORD_MEMORY_COMMANDS)
      return Promise.reject(new Error('Discord memory command capacity is exhausted.'))

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingMemoryCommands.delete(commandId)
        reject(new Error('Timed out waiting for Discord memory command result.'))
      }, 10_000)

      this.pendingMemoryCommands.set(commandId, {
        reject,
        resolve,
        timeout,
      })
    })
  }

  private settleMemoryCommandResult(result: DiscordMemoryCommandResultEvent): void {
    const pending = this.pendingMemoryCommands.get(result.commandId)
    if (!pending)
      return

    clearTimeout(pending.timeout)
    this.pendingMemoryCommands.delete(result.commandId)
    pending.resolve(result)
  }

  private rejectPendingMemoryCommand(commandId: string, error: Error): void {
    const pending = this.pendingMemoryCommands.get(commandId)
    if (!pending)
      return

    clearTimeout(pending.timeout)
    this.pendingMemoryCommands.delete(commandId)
    pending.reject(error)
  }

  private clearPendingMemoryCommands(error: Error): void {
    for (const commandId of this.pendingMemoryCommands.keys())
      this.rejectPendingMemoryCommand(commandId, error)
  }

  private async requestDiscordMemoryCommand(input: {
    action: DiscordMemoryCommandAction
    discord: Discord
    sessionId: string
    content?: string
    requestedScope?: MemoryScope
    durationMs?: number
    memoryId?: string
  }) {
    if (this.pendingMemoryCommands.size >= MAX_PENDING_DISCORD_MEMORY_COMMANDS)
      throw new Error('Discord memory command capacity is exhausted.')

    const commandId = randomUUID()
    const command: DiscordMemoryCommandEvent = {
      commandId,
      action: input.action,
      sessionId: input.sessionId,
      guildId: input.discord.guildId,
      guildName: input.discord.guildName,
      channelId: input.discord.channelId,
      userId: input.discord.guildMember?.id ?? '',
      displayName: input.discord.guildMember?.displayName,
      isOwner: input.discord.owner?.currentUserIsOwner,
      ownerUserIdConfigured: input.discord.owner?.configured,
      content: input.content,
      requestedScope: input.requestedScope,
      durationMs: input.durationMs,
      memoryId: input.memoryId,
      requestedAt: Date.now(),
    }
    const result = this.waitForMemoryCommandResult(commandId)
    const sent = this.airiClient.send({
      type: 'discord:memory:command',
      data: command,
    })

    if (!sent) {
      this.rejectPendingMemoryCommand(commandId, new Error('AIRI channel is not connected for Discord memory commands.'))
    }

    return await result
  }

  private async handleAiriCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const action = this.resolveAiriMemoryCommandAction(interaction)
    if (!action) {
      await interaction.reply({
        content: 'Unknown AIRI command.',
        ephemeral: true,
      })
      return
    }

    await this.handleDiscordMemoryBridgeCommand(interaction, { action })
  }

  private async handleDiscordMemoryBridgeCommand(
    interaction: ChatInputCommandInteraction,
    input: {
      action: DiscordMemoryCommandAction
      content?: string
      requestedScope?: MemoryScope
      durationMs?: number
      memoryId?: string
    },
  ): Promise<void> {
    const discord = normalizeDiscordMetadata(this.resolveInteractionDiscordContext(interaction))
    const sessionId = resolveDiscordSessionId(discord)
    if (!sessionId) {
      await interaction.reply({
        content: 'Cannot resolve this Discord session safely, so AIRI will not change memory settings here.',
        ephemeral: true,
      })
      return
    }

    await interaction.deferReply({ ephemeral: true })

    try {
      const result = await this.requestDiscordMemoryCommand({
        action: input.action,
        discord: discord!,
        sessionId,
        content: input.content,
        requestedScope: input.requestedScope,
        durationMs: input.durationMs,
        memoryId: input.memoryId,
      })
      await interaction.editReply(result.message)
      this.audit('memory-command-result', {
        action: input.action,
        status: result.status,
        sessionId,
        guildId: discord?.guildId,
        channelId: discord?.channelId,
        userId: discord?.guildMember?.id,
      })
    }
    catch {
      logDiscordBridgeFailure('warn', {
        eventCode: 'memory-command-failed',
        failureCategory: 'memory-bridge',
        retryable: true,
        terminal: true,
      })
      await interaction.editReply('AIRI could not update memory settings right now. Try again after Stage UI is connected.')
    }
  }

  private async handleRememberCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const content = interaction.options.getString('content', true)
    const requestedScope = resolveDiscordMemoryScope(interaction.options.getString('scope', false))
    const durationMs = parseDiscordMemoryDurationMs(interaction.options.getString('duration', false))
    await this.handleDiscordMemoryBridgeCommand(interaction, {
      action: 'remember',
      content,
      requestedScope,
      durationMs: requestedScope === 'temporary' ? durationMs : undefined,
    })
  }

  private async handleMemoryCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const subcommand = interaction.options.getSubcommand()
    if (subcommand === 'list') {
      await this.handleDiscordMemoryBridgeCommand(interaction, { action: 'memory-list' })
      return
    }

    if (subcommand === 'clear') {
      await this.handleDiscordMemoryBridgeCommand(interaction, { action: 'memory-clear' })
      return
    }

    if (subcommand === 'approve') {
      await this.handleDiscordMemoryBridgeCommand(interaction, {
        action: 'memory-approve',
        memoryId: interaction.options.getString('id', true),
      })
      return
    }

    if (subcommand === 'reject') {
      await this.handleDiscordMemoryBridgeCommand(interaction, {
        action: 'memory-reject',
        memoryId: interaction.options.getString('id', true),
      })
      return
    }

    await interaction.reply({
      content: 'Unknown memory command.',
      ephemeral: true,
    })
  }

  private async handleForgetCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    await this.handleDiscordMemoryBridgeCommand(interaction, {
      action: 'forget-memory',
      memoryId: interaction.options.getString('id', true),
    })
  }

  private async ensureAdminInteractionAllowed(interaction: ChatInputCommandInteraction, commandName: string): Promise<boolean> {
    if (canManageDiscordVoiceInteraction(interaction, this.runtimeConfig.adminRoleIds))
      return true

    this.audit('interaction-rejected', {
      reason: 'manage-guild-and-admin-role-required',
      commandName,
      guildId: interaction.guildId,
      userId: interaction.user.id,
    })

    await interaction.reply({
      content: 'Manage Server permission and any configured AIRI admin role are required to manage voice chat.',
      ephemeral: true,
    })
    return false
  }

  private async ensureRestrictedInteractionAllowed(interaction: ChatInputCommandInteraction, commandName: string): Promise<boolean> {
    if (canUseRestrictedDiscordCommand({
      userId: interaction.user.id,
      ownerUserId: this.ownerUserId,
      member: interaction.member,
      adminRoleIds: this.runtimeConfig.adminRoleIds,
    })) {
      return true
    }

    this.audit('interaction-rejected', {
      reason: 'owner-or-admin-required',
      commandName,
      guildId: interaction.guildId,
      userId: interaction.user.id,
    })

    await interaction.reply({
      content: 'Only the configured AIRI owner or Discord admin roles can use this command.',
      ephemeral: true,
    })
    return false
  }

  private invalidateCommandRegistration(): void {
    this.commandRegistrationGeneration += 1
    if (this.commandRegistrationRetryTimer !== undefined) {
      clearTimeout(this.commandRegistrationRetryTimer)
      this.commandRegistrationRetryTimer = undefined
    }
    for (const attempt of this.commandRegistrationAttempts) {
      if (attempt.generation >= this.commandRegistrationGeneration)
        continue
      if (attempt.timeout !== undefined) {
        clearTimeout(attempt.timeout)
        attempt.timeout = undefined
      }
      attempt.abortController.abort('registration-owner-invalidated')
    }
    this.commandRegistrationOwner = undefined
  }

  private isCommandRegistrationOwnerActive(owner: NonNullable<DiscordAdapter['commandRegistrationOwner']>): boolean {
    return this.commandRegistrationOwner === owner
      && owner.generation === this.commandRegistrationGeneration
      && owner.configGeneration === this.runtimeConfigGeneration
      && this.runtimePolicyEnabled
      && !this.adapterStopping
  }

  private scheduleCommandRegistrationRetry(
    owner: NonNullable<DiscordAdapter['commandRegistrationOwner']>,
    attemptIndex: number,
    reason: 'capacity' | 'request-failure' | 'timeout',
  ): void {
    if (!this.isCommandRegistrationOwnerActive(owner))
      return

    const retryDelay = DISCORD_COMMAND_REGISTRATION_RETRY_DELAYS_MS[attemptIndex]
    if (retryDelay === undefined) {
      this.audit('command-registration-failed', {
        applicationId: owner.applicationId,
        attemptCount: attemptIndex + 1,
        reason,
        status: 'retry-exhausted',
      })
      log.withFields({
        attemptCount: boundedDiscordAuditCount(attemptIndex + 1),
        reason,
      }).error('[discord-bot] Discord command registration exhausted bounded retries')
      this.commandRegistrationRetryTimer = setTimeout(() => {
        if (!this.isCommandRegistrationOwnerActive(owner))
          return
        this.commandRegistrationRetryTimer = undefined
        this.commandRegistrationOwner = undefined
        this.audit('command-registration-retry-available', {
          applicationId: owner.applicationId,
          status: 'cooldown-complete',
        })
      }, DISCORD_COMMAND_REGISTRATION_RECOVERY_DELAY_MS)
      return
    }

    this.audit('command-registration-retry-scheduled', {
      applicationId: owner.applicationId,
      attempt: attemptIndex + 2,
      reason,
      retryDelayMs: retryDelay,
    })
    this.commandRegistrationRetryTimer = setTimeout(() => {
      if (!this.isCommandRegistrationOwnerActive(owner))
        return
      this.commandRegistrationRetryTimer = undefined
      void this.runCommandRegistrationAttempt(owner, attemptIndex + 1)
    }, retryDelay)
  }

  private runCommandRegistrationAttempt(
    owner: NonNullable<DiscordAdapter['commandRegistrationOwner']>,
    attemptIndex: number,
  ): Promise<void> {
    if (!this.isCommandRegistrationOwnerActive(owner))
      return Promise.resolve()

    let applicationTaskCount = 0
    for (const registration of this.rawCommandRegistrationTasks) {
      if (registration.applicationId === owner.applicationId)
        applicationTaskCount += 1
    }
    const hasLocalCapacity = applicationTaskCount < MAX_RAW_COMMAND_REGISTRATION_TASKS_PER_APPLICATION
      && this.rawCommandRegistrationTasks.size < MAX_RAW_COMMAND_REGISTRATION_TASKS
      && (
        applicationTaskCount === 0
        || this.rawCommandRegistrationTasks.size < MAX_RAW_COMMAND_REGISTRATION_TASKS - RESERVED_COMMAND_REGISTRATION_TASKS_FOR_REPLACEMENT
      )
    if (!hasLocalCapacity) {
      this.scheduleCommandRegistrationRetry(owner, attemptIndex, 'capacity')
      return Promise.resolve()
    }

    // Discord's REST registration has no AbortSignal. Retain the raw request
    // until actual settlement while a bounded wrapper owns timeout and retry.
    const started = startDiscordTransport(
      `discord-application-${owner.applicationId}`,
      () => {
        // Transport admission and REST dispatch occur in different microtasks.
        // Recheck the exact owner so synchronous disable/stop cannot dispatch
        // a request that was only current at admission time.
        if (!this.isCommandRegistrationOwnerActive(owner))
          return Promise.resolve()
        return registerCommands(this.discordToken, owner.applicationId)
      },
    )
    if (started.accepted === false) {
      this.scheduleCommandRegistrationRetry(owner, attemptIndex, 'capacity')
      return Promise.resolve()
    }
    const rawTask = started.task
    const registration: RawDiscordCommandRegistration = {
      applicationId: owner.applicationId,
      task: rawTask,
    }
    this.rawCommandRegistrationTasks.add(registration)
    void rawTask.then(
      () => this.rawCommandRegistrationTasks.delete(registration),
      () => this.rawCommandRegistrationTasks.delete(registration),
    )

    const abortController = new AbortController()
    let deadlineExpired = false
    let attempt: DiscordCommandRegistrationAttempt
    const observed = rawTask.then(
      () => 'registered' as const,
      () => 'request-failure' as const,
    )
    const operation = (async () => {
      const boundary = await waitForDiscordTransportBoundary(observed, abortController.signal)
      if (!boundary.completed) {
        if (deadlineExpired && this.isCommandRegistrationOwnerActive(owner))
          this.scheduleCommandRegistrationRetry(owner, attemptIndex, 'timeout')
        return
      }
      if (!this.isCommandRegistrationOwnerActive(owner))
        return

      if (boundary.value === 'registered') {
        this.registeredDiscordApplicationId = owner.applicationId
        this.registeredDiscordApplicationGeneration = owner.configGeneration
        this.commandRegistrationOwner = undefined
        this.audit('command-registration-completed', {
          applicationId: owner.applicationId,
          attemptCount: attemptIndex + 1,
        })
        return
      }

      this.scheduleCommandRegistrationRetry(owner, attemptIndex, boundary.value)
    })()
    const task = operation.finally(() => {
      if (attempt.timeout !== undefined)
        clearTimeout(attempt.timeout)
      this.commandRegistrationAttempts.delete(attempt)
    })
    attempt = {
      abortController,
      applicationId: owner.applicationId,
      configGeneration: owner.configGeneration,
      generation: owner.generation,
      task,
      timeout: setTimeout(() => {
        attempt.timeout = undefined
        deadlineExpired = true
        abortController.abort('registration-deadline')
      }, DISCORD_COMMAND_REGISTRATION_TIMEOUT_MS),
    }
    this.commandRegistrationAttempts.add(attempt)
    this.commandRegistrationTask = task
    void task.then(
      () => {
        if (this.commandRegistrationTask === task)
          this.commandRegistrationTask = undefined
      },
      () => {
        if (this.commandRegistrationTask === task)
          this.commandRegistrationTask = undefined
      },
    )
    return task
  }

  private ensureCommandRegistration(applicationId: string, configGeneration: number): Promise<void> {
    if (this.registeredDiscordApplicationId === applicationId)
      return Promise.resolve()
    if (
      this.commandRegistrationOwner?.applicationId === applicationId
      && this.commandRegistrationOwner.configGeneration === configGeneration
    ) {
      return this.commandRegistrationTask ?? Promise.resolve()
    }

    this.invalidateCommandRegistration()
    const owner = {
      applicationId,
      configGeneration,
      generation: this.commandRegistrationGeneration,
    }
    this.commandRegistrationOwner = owner
    return this.runCommandRegistrationAttempt(owner, 0)
  }

  private async handleDiscordReady(readyClient: { user: { id: string } }, configGeneration: number): Promise<void> {
    if (
      configGeneration !== this.runtimeConfigGeneration
      || configGeneration !== this.appliedRuntimeConfigGeneration
      || configGeneration !== this.discordConnectionGeneration
      || !this.runtimePolicyEnabled
      || this.adapterStopping
    ) {
      this.audit('discord-ready-ignored', {
        configGeneration,
        currentConfigGeneration: this.runtimeConfigGeneration,
        reason: 'stale-or-disabled',
      })
      return
    }

    const ownedApplicationId = this.commandRegistrationOwner?.applicationId ?? this.registeredDiscordApplicationId
    const ownedApplicationGeneration = this.commandRegistrationOwner?.configGeneration ?? this.registeredDiscordApplicationGeneration
    if (
      ownedApplicationId
      && ownedApplicationId !== readyClient.user.id
      && ownedApplicationGeneration === configGeneration
    ) {
      this.audit('discord-ready-ignored', {
        applicationId: readyClient.user.id,
        configGeneration,
        reason: 'application-changed-within-generation',
      })
      return
    }

    this.discordTransportReady = true
    this.refreshDiscordIngressAvailability()
    log.withField('configGeneration', boundedDiscordAuditCount(configGeneration)).log('[discord-bot] Discord ready')
    log.withFields({
      runtimeVersion: DISCORD_ADAPTER_RUNTIME_VERSION,
      directMessagesIntent: true,
      messageContentIntent: true,
    }).log('[discord-bot] runtime diagnostics')
    await this.ensureCommandRegistration(readyClient.user.id, configGeneration)
  }

  private setupEventHandlers(): void {
    // Handle input from AIRI system
    this.airiClient.onEvent('input:text', async (event) => {
      log.withField('contentLength', event.data.text.length).log('Received input from AIRI system')
      // Process Discord-related commands
      // For now, we'll just log the input
    })

    this.airiClient.onEvent('discord:memory:command:result', async (event) => {
      this.settleMemoryCommandResult(event.data)
    })

    // Handle output from AIRI system (IA response)
    this.airiClient.onEvent('output:gen-ai:chat:message', async (event) => {
      try {
        const data = event.data
        const message = data.message
        const messageContent = normalizeDiscordAssistantContent(message.content)
        const discordContext = data['gen-ai:chat']?.input?.data?.discord ?? data.discord
        const turn = data.turn

        this.audit('output-message-received', {
          hasContent: Boolean(messageContent),
          hasDiscordContext: Boolean(discordContext),
          hasTurnCorrelation: isChatTurnCorrelation(turn),
          channelId: discordContext?.channelId,
          guildId: discordContext?.guildId,
          userId: discordContext?.guildMember?.id,
          directMessage: Boolean(discordContext && !discordContext.guildId),
        })

        if (!messageContent || !discordContext?.channelId || !isChatTurnCorrelation(turn)) {
          this.audit('output-message-skipped', {
            reason: !messageContent
              ? 'missing-content'
              : !discordContext?.channelId
                  ? 'missing-discord-channel'
                  : 'missing-turn-correlation',
            hasDiscordContext: Boolean(discordContext),
          })
          return
        }

        const sessionId = resolveDiscordSessionId(discordContext)
        const pending = this.pendingDiscordTurnsById.get(turn.id)
        if (
          !pending
          || pending.phase !== 'pending'
          || !sessionId
          || pending.sessionId !== sessionId
          || pending.turn.generation !== turn.generation
          || pending.turn.deadlineAt !== turn.deadlineAt
        ) {
          this.audit('output-message-skipped', {
            reason: 'stale-or-mismatched-turn',
            sessionId,
            turnId: turn.id,
            turnGeneration: turn.generation,
          })
          return
        }

        if (turn.deadlineAt <= Date.now()) {
          await this.expirePendingDiscordTurn(turn.id)
          return
        }

        const claimed = this.beginPendingDiscordTurnDelivery(turn.id, 'response')
        if (!claimed)
          return

        try {
          const target = await this.resolveOutputSendTarget(
            claimed.discordContext,
            claimed.responseAbortController.signal,
            () => this.isPendingDiscordTurnDeliveryActive(claimed, 'response'),
          )
          if (!this.isPendingDiscordTurnDeliveryActive(claimed, 'response')) {
            if (
              this.pendingDiscordTurnsById.get(turn.id) === claimed
              && claimed.phase === 'response'
              && claimed.turn.deadlineAt <= Date.now()
            ) {
              await this.expirePendingDiscordTurn(turn.id)
            }
            return
          }
          if (!target) {
            this.audit('output-target-missing', {
              channelId: claimed.discordContext.channelId,
              guildId: claimed.discordContext.guildId,
              userId: claimed.discordContext.guildMember?.id,
              sessionId,
              turnId: turn.id,
              turnGeneration: turn.generation,
              directMessage: !claimed.discordContext.guildId,
            })
            return
          }

          const sent = await this.sendDiscordContent(
            target,
            messageContent,
            `discord-user-${claimed.discordContext.guildMember?.id ?? 'unknown'}`,
            claimed.responseAbortController.signal,
            () => this.isPendingDiscordTurnDeliveryActive(claimed, 'response'),
          )
          if (!sent || !this.isPendingDiscordTurnDeliveryActive(claimed, 'response')) {
            if (
              this.pendingDiscordTurnsById.get(turn.id) === claimed
              && claimed.phase === 'response'
              && claimed.turn.deadlineAt <= Date.now()
            ) {
              await this.expirePendingDiscordTurn(turn.id)
            }
            return
          }
          this.audit('output-message-sent', {
            channelId: discordContext.channelId,
            guildId: discordContext.guildId,
            userId: discordContext.guildMember?.id,
            sessionId,
            turnId: turn.id,
            turnGeneration: turn.generation,
            directMessage: !discordContext.guildId,
            contentLength: messageContent.length,
          })
        }
        finally {
          if (this.pendingDiscordTurnsById.get(turn.id) === claimed && claimed.phase === 'response')
            this.takePendingDiscordTurn(turn.id)
        }
      }
      catch (error) {
        if (error instanceof DiscordTextDeliveryError) {
          const failure = {
            deliveredChunks: error.deliveredChunks,
            errorName: error.name,
            reason: error.reason,
            totalChunks: error.totalChunks,
          }
          this.audit('output-delivery-failed', failure)
          log.withFields(failure).error('Failed to send response to Discord')
          return
        }
        if (error instanceof DiscordTextChunkingError) {
          const failure = {
            errorKind: error.kind,
            errorName: error.name,
          }
          this.audit('output-delivery-failed', failure)
          log.withFields(failure).error('Failed to send response to Discord')
          return
        }
        log.withField('errorName', error instanceof Error ? 'Error' : 'UnknownError')
          .error('Failed to send response to Discord')
      }
    })

    // Set up Discord event handlers
    this.discordClient.on(Events.ClientReady, (readyClient) => {
      const configGeneration = this.discordConnectionGeneration
      if (configGeneration === undefined)
        return Promise.resolve()
      return this.handleDiscordReady(readyClient, configGeneration).catch(() => {
        logDiscordBridgeFailure('error', {
          eventCode: 'discord-ready-lifecycle-failed',
          failureCategory: 'discord-lifecycle',
          retryable: true,
          terminal: false,
        })
      })
    })

    this.discordClient.on(Events.ShardDisconnect, () => {
      this.discordTransportReady = false
      this.refreshDiscordIngressAvailability()
      if (this.runtimePolicyEnabled && !this.adapterStopping)
        this.beginDisconnectCleanup()
    })

    this.discordClient.on(Events.ShardReady, () => {
      this.discordTransportReady = true
      this.refreshDiscordIngressAvailability()
    })

    this.discordClient.on(Events.Raw, (packet) => {
      if (!this.discordIngressEnabled)
        return
      if (packet.t !== 'MESSAGE_CREATE')
        return

      const data = packet.d as {
        author?: {
          bot?: boolean
          global_name?: string | null
          id?: string
          username?: string
        }
        channel_id?: string
        content?: string
        guild_id?: string
        id?: string
      }
      if (data.author?.bot)
        return

      this.audit('gateway-message-create-received', {
        channelId: data.channel_id,
        guildId: data.guild_id,
        userId: data.author?.id,
        directMessage: !data.guild_id,
        contentLength: typeof data.content === 'string' ? data.content.length : 0,
      })

      if (data.guild_id)
        return

      if (!this.claimDiscordMessage(data.id)) {
        this.audit('raw-dm-fallback-skipped', {
          reason: 'duplicate-message',
          channelId: data.channel_id,
          userId: data.author?.id,
          directMessage: true,
        })
        return
      }

      const channelId = normalizeDiscordId(data.channel_id)
      const userId = normalizeDiscordId(data.author?.id)
      if (!channelId || !userId) {
        this.audit('input-rejected', {
          reason: 'missing-session-metadata',
          channelId: data.channel_id,
          guildId: data.guild_id,
          userId: data.author?.id,
          directMessage: true,
        })
        return
      }

      const rawContent = typeof data.content === 'string' ? data.content : ''
      const displayName = data.author?.global_name ?? data.author?.username ?? userId
      this.audit('raw-dm-fallback-started', {
        channelId,
        userId,
        directMessage: true,
        contentLength: rawContent.length,
      })
      void this.handleDiscordTextInput({
        channelId,
        content: rawContent.trim(),
        directMessage: true,
        displayName,
        nickname: displayName,
        rawContent,
        sendPrivacyNotice: async (payload: SafeDiscordTextPayload, abortSignal?: AbortSignal) => {
          if (abortSignal?.aborted)
            return false
          const channel = await this.discordClient.channels.fetch(channelId)
          if (abortSignal?.aborted)
            return false
          if (isDiscordSendTarget(channel))
            return await channel.send(payload)

          const user = await this.discordClient.users.fetch(userId)
          if (abortSignal?.aborted)
            return false
          return await user.send(payload)
        },
        userId,
      }).catch(() => {
        this.audit('raw-dm-fallback-error', {
          channelId,
          userId,
          directMessage: true,
        })
        logDiscordBridgeFailure('error', {
          eventCode: 'raw-dm-ingress-failed',
          failureCategory: 'ingress',
          retryable: true,
          terminal: true,
        })
      })
    })

    // Handle text messages from Discord
    this.discordClient.on(Events.MessageCreate, async (message) => {
      if (!this.discordIngressEnabled)
        return
      if (message.author.bot)
        return

      const configGeneration = this.runtimeConfigGeneration
      const referenceLifecycle = this.replyReferenceLifecycle
      const referenceActive = () => configGeneration === this.runtimeConfigGeneration
        && referenceLifecycle === this.replyReferenceLifecycle
        && !referenceLifecycle.signal.aborted
        && this.runtimePolicyEnabled
        && this.discordIngressEnabled
        && !this.adapterStopping
      const isDM = !message.guild
      const isMentioned = this.discordClient.user && message.mentions.has(this.discordClient.user)
      if (!referenceActive())
        return
      const isReplyCandidate = message.type === MessageType.Reply
        && message.reference?.type === MessageReferenceType.Default
      if (!isDM && !isMentioned && !isReplyCandidate) {
        this.audit('message-create-ignored', {
          channelId: message.channelId,
          guildId: message.guildId,
          reason: 'not-addressed',
          userId: message.author.id,
        })
        return
      }
      this.audit('message-create-received', {
        channelId: message.channelId,
        guildId: message.guildId,
        userId: message.author.id,
        directMessage: isDM,
        mentioned: Boolean(isMentioned),
        contentLength: message.content.length,
      })

      if (!this.claimDiscordMessage(message.id))
        return

      const rawContent = message.content
      const content = isMentioned
        ? removeDiscordBotMention(rawContent, this.discordClient.user?.id ?? '')
        : rawContent.trim()
      const principalKey = `discord-user-${message.author.id}`
      // Only an actual Discord reply/default reference may enter authoritative
      // lookup. Forward/crosspost references are not address proofs.
      const authorize = !isDM && !isMentioned
        ? async (deadlineAt: number) => {
          const replyReference = await resolveDiscordReplyReference({
            botUserId: this.discordClient.user?.id,
            deadlineAt,
            fetchReferencedAuthorId: async () => (await message.fetchReference()).author.id,
            isActive: referenceActive,
            principalKey,
            referencedMessageId: message.reference?.messageId,
            signal: referenceLifecycle.signal,
          })
          this.audit('reply-reference-resolved', {
            channelId: message.channelId,
            guildId: message.guildId,
            matched: replyReference.matched,
            reason: replyReference.reason,
            userId: message.author.id,
          })
          return replyReference.matched && referenceActive()
        }
        : undefined
      const sendPrivacyNotice = message.channel.isTextBased() && 'send' in message.channel && typeof message.channel.send === 'function'
        ? (payload: SafeDiscordTextPayload) => message.channel.send(payload)
        : undefined
      const sendTyping = message.channel.isTextBased() && 'sendTyping' in message.channel && typeof message.channel.sendTyping === 'function'
        ? () => message.channel.sendTyping()
        : undefined

      await this.handleDiscordTextInput({
        authorize,
        channelId: message.channelId,
        content,
        directMessage: isDM,
        displayName: message.member?.displayName ?? message.author.username,
        guildId: message.guildId ?? undefined,
        guildName: message.guild?.name ?? undefined,
        nickname: message.member?.nickname ?? message.author.username,
        rawContent,
        sendPrivacyNotice,
        sendTyping,
        userId: message.author.id,
      })
    })

    this.discordClient.on(Events.InteractionCreate, async (interaction: Interaction) => {
      if (!this.discordIngressEnabled)
        return
      if (interaction.isButton()) {
        await this.voiceManager.handleConsentInteraction(interaction)
        return
      }

      if (!interaction.isChatInputCommand())
        return

      log.withField(
        'commandName',
        DISCORD_LOGGABLE_COMMAND_NAMES.has(interaction.commandName) ? interaction.commandName : 'unknown',
      ).log('[discord-bot] interaction received')

      switch (interaction.commandName) {
        case 'airi':
          if (!await this.ensureRestrictedInteractionAllowed(interaction, interaction.commandName))
            break

          await this.handleAiriCommand(interaction)
          break
        case 'remember':
          if (!await this.ensureRestrictedInteractionAllowed(interaction, interaction.commandName))
            break

          await this.handleRememberCommand(interaction)
          break
        case 'memory':
          if (!await this.ensureRestrictedInteractionAllowed(interaction, interaction.commandName))
            break

          await this.handleMemoryCommand(interaction)
          break
        case 'forget':
          if (!await this.ensureRestrictedInteractionAllowed(interaction, interaction.commandName))
            break

          await this.handleForgetCommand(interaction)
          break
        case 'ping':
          await handlePing(interaction)
          break
        case 'summon':
          if (!await this.ensureAdminInteractionAllowed(interaction, interaction.commandName))
            break

          await this.voiceManager.handleJoinChannelCommand(interaction)
          break
        case 'dismiss':
          if (!await this.ensureAdminInteractionAllowed(interaction, interaction.commandName))
            break

          await this.voiceManager.handleLeaveChannelCommand(interaction)
          break
      }
    })

    this.discordClient.on(Events.VoiceStateUpdate, (oldState, newState) => {
      if (!this.discordIngressEnabled)
        return
      void Promise.resolve()
        .then(() => this.voiceManager.handleVoiceStateUpdate(oldState, newState))
        .catch(() => {
          logDiscordBridgeFailure('error', {
            eventCode: 'voice-state-update-failed',
            failureCategory: 'discord-lifecycle',
            retryable: true,
            terminal: false,
          })
        })
    })
  }

  /**
   * Applies parent-authorized, non-secret Discord runtime policy.
   *
   * Use when:
   * - Electron Main has received an authenticated Stage policy update.
   * - The utility-process parent needs to disable Discord immediately.
   *
   * Expects:
   * - The bot token was already delivered through the protected bootstrap port.
   * - Calls may overlap; policy changes are applied in call order.
   *
   * Returns:
   * - A promise that settles after Discord connection state matches the policy.
   */
  applyRuntimeConfig(config: DiscordBridgeRuntimeConfig): Promise<void> {
    const configGeneration = this.runtimeConfigGeneration + 1
    this.runtimeConfigGeneration = configGeneration
    const previousReplyReferenceLifecycle = this.replyReferenceLifecycle
    this.replyReferenceLifecycle = new AbortController()
    previousReplyReferenceLifecycle.abort('runtime-config-changed')
    this.invalidateCommandRegistration()
    // Every arriving policy closes ingress immediately. Only the latest policy
    // may reopen it after serialized connection work and generation checks.
    this.runtimePolicyEnabled = false
    this.discordIngressEnabled = false
    let immediateDisableCleanupError: unknown
    let immediateDisableCleanupFailed = false
    if (!config.enabled) {
      this.runtimePolicyEnabled = false
      this.discordIngressEnabled = false
      try {
        this.clearBoundedRuntimeState('disabled')
      }
      catch (error) {
        // Policy gating is synchronous, but the serialized disable task still
        // owns voice/Discord teardown and must run before this error is exposed.
        immediateDisableCleanupError = error
        immediateDisableCleanupFailed = true
      }
    }

    const task = this.runtimeConfigTask
      .catch((error: unknown) => {
        const observation = {
          errorName: error instanceof Error ? 'Error' : 'UnknownError',
          status: 'previous-config-failed',
        }
        this.audit('runtime-config-failed', observation)
        log.withFields(observation).error('[discord-bot] previous runtime config failed before queue continuation')
      })
      .then(async () => {
        const superseded = configGeneration !== this.runtimeConfigGeneration
        if (superseded && config.enabled) {
          if (immediateDisableCleanupFailed)
            throw immediateDisableCleanupError
          return
        }

        if (!superseded) {
          this.runtimeConfig = normalizeDiscordRuntimeConfig(config)
          this.appliedRuntimeConfigGeneration = configGeneration
        }

        if (!config.enabled) {
          let firstDisableError = immediateDisableCleanupError
          let disableFailed = immediateDisableCleanupFailed
          const retryingFailedCleanup = this.disconnectCleanupFailed
          const inFlightDisconnectCleanup = this.disconnectCleanupTask
          this.runtimePolicyEnabled = false
          this.discordIngressEnabled = false

          try {
            this.revalidatePendingDiscordTurnPolicies()
          }
          catch (error) {
            if (!disableFailed) {
              firstDisableError = error
              disableFailed = true
            }
          }
          try {
            this.voiceManager.revalidateSpeakerAdmissions()
          }
          catch (error) {
            if (!disableFailed) {
              firstDisableError = error
              disableFailed = true
            }
          }
          this.pruneExpiredBoundedState(Date.now(), true)
          try {
            this.clearBoundedRuntimeState('disabled')
          }
          catch (error) {
            if (!disableFailed) {
              firstDisableError = error
              disableFailed = true
            }
          }
          if (inFlightDisconnectCleanup) {
            try {
              await inFlightDisconnectCleanup
            }
            catch (error) {
              if (!disableFailed) {
                firstDisableError = error
                disableFailed = true
              }
            }
          }
          try {
            await this.voiceManager.stop()
          }
          catch (error) {
            if (!disableFailed) {
              firstDisableError = error
              disableFailed = true
            }
          }
          try {
            // A prior destroy may have changed local ready state before rejecting.
            // Explicit disable remains the sole recovery owner and must retry that
            // exact client even when `isReady()` is already false.
            if (this.discordClient.isReady() || retryingFailedCleanup)
              await this.discordClient.destroy()
          }
          catch (error) {
            if (!disableFailed) {
              firstDisableError = error
              disableFailed = true
            }
          }
          this.discordConnectionGeneration = undefined
          this.discordTransportReady = this.discordClient.isReady()

          if (disableFailed) {
            this.disconnectCleanupFailed = true
            this.refreshDiscordIngressAvailability()
            throw firstDisableError
          }
          this.disconnectCleanupFailed = false
          this.refreshDiscordIngressAvailability()
          return
        }

        if (this.disconnectCleanupFailed) {
          const observation = {
            configGeneration,
            reason: 'explicit-disable-cleanup-required',
          }
          this.audit('runtime-config-rejected', observation)
          log.withFields(observation).error('Discord enable rejected until explicit cleanup succeeds')
          throw new Error('Discord disconnect cleanup must complete through a disabled policy before enabling.')
        }
        this.revalidatePendingDiscordTurnPolicies()
        this.voiceManager.revalidateSpeakerAdmissions()
        this.pruneExpiredBoundedState(Date.now(), true)

        if (!this.discordToken) {
          let firstMissingTokenCleanupError: unknown
          let missingTokenCleanupFailed = false
          this.runtimePolicyEnabled = false
          this.discordIngressEnabled = false
          try {
            this.clearBoundedRuntimeState('disabled')
          }
          catch (error) {
            firstMissingTokenCleanupError = error
            missingTokenCleanupFailed = true
          }
          try {
            await this.voiceManager.stop()
          }
          catch (error) {
            if (!missingTokenCleanupFailed) {
              firstMissingTokenCleanupError = error
              missingTokenCleanupFailed = true
            }
          }
          try {
            if (this.discordClient.isReady())
              await this.discordClient.destroy()
          }
          catch (error) {
            if (!missingTokenCleanupFailed) {
              firstMissingTokenCleanupError = error
              missingTokenCleanupFailed = true
            }
          }
          this.discordConnectionGeneration = undefined
          if (missingTokenCleanupFailed) {
            this.disconnectCleanupFailed = true
            this.refreshDiscordIngressAvailability()
            logDiscordBridgeFailure('error', {
              eventCode: 'missing-token-cleanup-failed',
              failureCategory: 'cleanup',
              retryable: true,
              terminal: true,
            })
            throw firstMissingTokenCleanupError
          }
          this.disconnectCleanupFailed = false
          this.refreshDiscordIngressAvailability()
          log.warn('Discord bridge is enabled without a protected token; remaining disconnected.')
          return
        }

        this.runtimePolicyEnabled = true
        this.discordIngressEnabled = false
        if (!this.discordClient.isReady()) {
          this.pendingDiscordLoginGeneration = configGeneration
          this.discordConnectionGeneration = configGeneration
          try {
            await this.discordClient.login(this.discordToken)
          }
          catch (error) {
            if (this.discordConnectionGeneration === configGeneration)
              this.discordConnectionGeneration = undefined
            throw error
          }
          finally {
            if (this.pendingDiscordLoginGeneration === configGeneration)
              this.pendingDiscordLoginGeneration = undefined
          }
        }
        else {
          // A safe existing connection can be adopted only after the latest
          // runtime policy itself has reached this serialized boundary.
          this.discordConnectionGeneration = configGeneration
        }
        this.discordTransportReady = this.discordClient.isReady()
        if (configGeneration !== this.runtimeConfigGeneration)
          return
        this.refreshDiscordIngressAvailability()
        const readyUser = this.discordClient.user
        if (this.discordTransportReady && readyUser)
          await this.handleDiscordReady({ user: readyUser }, configGeneration)
      })

    this.runtimeConfigTask = task
    return task
  }

  async start(): Promise<void> {
    log.log('Discord bridge initialized; waiting for parent-authorized runtime policy.')
  }

  async stop(): Promise<void> {
    log.log('Stopping Discord adapter...')
    const cleanupErrors: unknown[] = []
    this.adapterStopping = true
    const inFlightRuntimeConfig = this.runtimeConfigTask
    const inFlightDisconnectCleanup = this.disconnectCleanupTask
    const inFlightCommandRegistrations = Array.from(
      this.commandRegistrationAttempts,
      attempt => attempt.task,
    )
    const inFlightIngress = this.discordIngressScheduler.drain()
    this.runtimeConfigGeneration += 1
    this.replyReferenceLifecycle.abort('stop')
    this.replyReferenceLifecycle = new AbortController()
    this.invalidateCommandRegistration()
    this.runtimePolicyEnabled = false
    this.discordIngressEnabled = false
    this.discordConnectionGeneration = undefined
    this.discordTransportReady = false
    this.airiChannelReady = false

    try {
      this.clearBoundedRuntimeState('disconnect')
    }
    catch (error) {
      cleanupErrors.push(error)
    }
    if (inFlightDisconnectCleanup) {
      try {
        await inFlightDisconnectCleanup
      }
      catch (error) {
        cleanupErrors.push(error)
      }
    }
    for (const inFlightCommandRegistration of inFlightCommandRegistrations) {
      try {
        await inFlightCommandRegistration
      }
      catch (error) {
        cleanupErrors.push(error)
      }
    }
    try {
      await inFlightIngress
    }
    catch (error) {
      cleanupErrors.push(error)
    }
    try {
      await this.voiceManager.stop()
    }
    catch (error) {
      cleanupErrors.push(error)
    }
    try {
      // A Discord.js login boundary cannot be aborted. Join it before the final
      // destroy so no stale connection can appear after stop reports completion.
      await inFlightRuntimeConfig
    }
    catch (error) {
      cleanupErrors.push(error)
    }
    try {
      await this.discordClient.destroy()
    }
    catch (error) {
      cleanupErrors.push(error)
    }
    const ownedDiscordEvents = [
      Events.ClientReady,
      Events.ShardDisconnect,
      Events.ShardReady,
      Events.MessageCreate,
      Events.InteractionCreate,
      Events.VoiceStateUpdate,
    ] satisfies readonly (keyof ClientEvents)[]
    for (const event of ownedDiscordEvents) {
      try {
        this.discordClient.removeAllListeners(event)
      }
      catch (error) {
        cleanupErrors.push(error)
      }
    }
    try {
      // Discord.js exposes Raw through a dedicated overload instead of ClientEvents.
      this.discordClient.removeAllListeners(Events.Raw)
    }
    catch (error) {
      cleanupErrors.push(error)
    }
    try {
      await this.airiClient.close()
    }
    catch (error) {
      cleanupErrors.push(error)
    }

    this.commandRegistrationTask = undefined
    this.registeredDiscordApplicationId = undefined
    this.registeredDiscordApplicationGeneration = undefined
    if (cleanupErrors.length > 0) {
      this.disconnectCleanupFailed = true
      logDiscordBridgeFailure('error', {
        eventCode: 'adapter-stop-failed',
        failureCategory: 'cleanup',
        retryable: false,
        terminal: true,
      })
      throw cleanupErrors[0]
    }

    this.disconnectCleanupFailed = false
    log.log('Discord adapter stopped')
  }
}
