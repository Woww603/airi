import type { Message as DiscordMessage, GatewayDispatchPayload, Interaction, PermissionsBitField, VoiceState } from 'discord.js'

import type { RealtimeVoiceCallRuntime, VoiceTranscriptionInput } from '../bots/discord/commands/summon'
import type { VoiceDiagnosticsObserver } from '../bots/discord/commands/voiceDiagnostics'
import type { StandaloneChatRuntime, StandaloneChatRuntimeErrorKind, StandaloneDiscordChatTurn } from '../standalone/chat-runtime'
import type { StandaloneDiscordFilterConfig, StandaloneDiscordFilterInput, StandaloneDiscordFilterRejectReason } from '../standalone/filter'
import type { SafeDiscordTextPayload } from './discordSend'

import { Buffer } from 'node:buffer'
import { env } from 'node:process'
import { Readable } from 'node:stream'

import { Client, Events, GatewayDispatchEvents, GatewayIntentBits, MessageReferenceType, MessageType, Partials, PermissionFlagsBits } from 'discord.js'

import { canManageDiscordVoiceInteraction } from '../bots/discord/commands/authorization'
import { handlePing } from '../bots/discord/commands/ping'
import { registerStandaloneDiscordCommands } from '../bots/discord/commands/registration'
import { VoiceManager } from '../bots/discord/commands/summon'
import { StandaloneChatRuntimeError } from '../standalone/chat-runtime'
import { StandaloneDiscordFilter } from '../standalone/filter'
import { resolveStandaloneSpeechRuntimeConfig, StandaloneSpeechRuntime } from '../standalone/speech-runtime'
import { DiscordIngressScheduler } from './discordIngressScheduler'
import { removeDiscordBotMention } from './discordMention'
import { deliverDiscordText, DiscordTextChunkingError, DiscordTextDeliveryError, DiscordTransportCapacityError, resolveDiscordReplyReference, startDiscordTransport, waitForDiscordTransportBoundary } from './discordSend'

/** Keeps repeated non-mention traffic from filling the local dashboard log. */
const IGNORED_MESSAGE_EVENT_INTERVAL_MS = 30_000

/** Bounds short-lived ignored-message keys created within one throttle interval. */
const MAX_IGNORED_MESSAGE_EVENT_KEYS = 256

/** Matches bridge disclosure retention while preventing process-lifetime session state. */
const PRIVACY_NOTICE_SESSION_TTL_MS = 24 * 60 * 60 * 1000

/** LRU eviction can only cause a safe repeat of the disclosure. */
const MAX_PRIVACY_NOTICE_SESSIONS = 256

/** Reserves bounded ownership for queue-full status delivery during synchronous gateway bursts. */
const MAX_IN_FLIGHT_MESSAGE_CAPACITY_STATUSES = 8

/** Bounds slash/button interaction work retained by EventEmitter listeners. */
const MAX_IN_FLIGHT_INTERACTION_HANDLERS = 64

/** Bounds asynchronous voice-state work; overflow synchronously invalidates the affected generation. */
const MAX_IN_FLIGHT_VOICE_STATE_HANDLERS = 64

/** Refreshes Discord's expiring typing indicator during slow model requests. */
const DEFAULT_TYPING_REFRESH_INTERVAL_MS = 7_000

interface DiscordSendTarget {
  send: (payload: SafeDiscordTextPayload) => Promise<unknown> | unknown
}

interface DiscordTypingTarget {
  sendTyping: () => Promise<unknown> | unknown
}

interface DiscordMessageAuthor {
  bot: boolean
  globalName?: string | null
  id: string
  username: string
}

interface StandaloneDiscordMessageEnvelope {
  author: DiscordMessageAuthor
  botUserId?: string
  filterInput: StandaloneDiscordFilterInput
  isDirectMessage: boolean
  isMentioned: boolean
  lifecycleGeneration: number
  lifecycleSignal: AbortSignal
  message: DiscordMessage
  operationSequence: number
  principalKey: string
  scope: string
  surface: StandaloneDiscordActivitySurface
  sessionId: string
  turn: StandaloneDiscordChatTurn
}

interface StandaloneDiscordMessageDispatch {
  kind: 'capacity-status' | 'scheduled'
  task: Promise<void>
}

type StandaloneDiscordErrorLocale = 'de' | 'en' | 'es' | 'fr' | 'ja' | 'ko' | 'zh'

/** Stable reply-failure categories safe for dashboard and audit events. */
export type StandaloneDiscordReplyFailureKind
  = | StandaloneChatRuntimeErrorKind
    | 'cancelled'
    | 'chunking-failure'
    | 'delivery-failure'
    | 'provider-failure'

/** Content-free Discord surface classification used by local observability. */
export type StandaloneDiscordActivitySurface
  = | 'classic-voice'
    | 'qwen-realtime'
    | 'text-direct-message'
    | 'text-guild'

/** Fixed failures that may cross from Discord/provider boundaries into local observability. */
export type StandaloneDiscordOperationFailureCategory
  = | 'command-registration-failure'
    | 'discord-fetch-failure'
    | 'discord-ingress-failure'
    | 'discord-interaction-failure'
    | 'discord-typing-failure'
    | 'discord-typing-refresh-failure'
    | 'discord-voice-capacity-cleanup-failure'
    | 'discord-voice-cleanup-failure'
    | 'lifecycle-cleanup-failure'
    | StandaloneDiscordReplyFailureKind

/** Anonymous operation correlation shared by adapter callbacks and Dashboard events. */
export interface StandaloneDiscordOperationObservation {
  /** Process-local bounded sequence; it is unrelated to Discord identifiers. */
  operationSequence: number
  /** Fixed transport surface without guild, channel, user, or message identity. */
  surface: StandaloneDiscordActivitySurface
}

type StandaloneDiscordAuditEvent
  = | 'dm-recovery-failed'
    | 'dm-recovery-skipped'
    | 'ingress-failed'
    | 'input-accepted'
    | 'input-rejected'
    | 'interaction-failed'
    | 'interaction-rejected'
    | 'memory-command-handled'
    | 'message-ignored'
    | 'privacy-notice-sent'
    | 'reply-failed'
    | 'reply-reference-resolved'
    | 'reply-sent'
    | 'voice-input-accepted'
    | 'voice-input-rejected'
    | 'voice-reply-failed'
    | 'voice-reply-generated'

const AUDIT_FAILURE_CATEGORIES = new Set<StandaloneDiscordOperationFailureCategory>([
  'cancelled',
  'chunking-failure',
  'command-registration-failure',
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
  'provider-failure',
  'queue-full',
  'service-unavailable',
  'stopped',
  'timeout',
  'unknown',
])

const AUDIT_REASONS = new Set([
  'blocked-guild',
  'blocked-term',
  'blocked-user',
  'capacity',
  'cancelled',
  'channel-not-allowed',
  'deadline-expired',
  'direct-message-disabled',
  'empty-content',
  'fetch-failure',
  'fetch-failed',
  'handler-capacity',
  'inactive-generation',
  'mention-required',
  'missing-author',
  'missing-discord-permission',
  'missing-reference',
  'missing-principal',
  'missing-send-target',
  'missing-session-metadata',
  'no-reference',
  'not-bot-author',
  'privacy-notice-failed',
  'prompt-attack',
  'queue-full',
  'rate-limited',
  'reference-fetch-failed',
  'reference-fetch-timeout',
  'referenced-message-missing',
  'sensitive-input',
  'send-failure',
  'timeout',
  'transport-capacity',
  'author-mismatch',
  'matched',
])

const AUDIT_STATUSES = new Set([
  'cleanup-failed',
  'delivery-failed',
  'discarded-after-stop',
  'failed-after-stop',
  'fetch-failed',
  'handler-capacity',
  'missing-principal',
  'registration-failed',
  'transport-capacity',
])

const AUDIT_ERROR_NAMES = new Set([
  'DiscordTextChunkingError',
  'DiscordTextDeliveryError',
  'Error',
  'SpeechProviderRequestError',
  'StandaloneChatRuntimeError',
])

function boundedObservationCount(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
    return undefined
  return Math.min(65_535, Math.trunc(value))
}

/**
 * Projects audit fields through a strict allowlist.
 *
 * Before:
 * - `{ scope: "server / channel", reason: "blocked-user" }`
 *
 * After:
 * - `{ reason: "blocked-user" }`
 */
function projectStandaloneDiscordAuditFields(fields: Readonly<Record<string, unknown>>): Record<string, boolean | number | string> {
  const projected: Record<string, boolean | number | string> = {}
  const activeTransportCount = boundedObservationCount(fields.activeTransportCount)
  const deliveredChunks = boundedObservationCount(fields.deliveredChunks)
  const operationSequence = boundedObservationCount(fields.operationSequence)
  const retryAfterMs = boundedObservationCount(fields.retryAfterMs)
  const totalChunks = boundedObservationCount(fields.totalChunks)
  if (activeTransportCount !== undefined)
    projected.activeTransportCount = activeTransportCount
  if (deliveredChunks !== undefined)
    projected.deliveredChunks = deliveredChunks
  if (operationSequence !== undefined)
    projected.operationSequence = operationSequence
  if (retryAfterMs !== undefined)
    projected.retryAfterMs = retryAfterMs
  if (totalChunks !== undefined)
    projected.totalChunks = totalChunks
  if (typeof fields.matched === 'boolean')
    projected.matched = fields.matched
  if (typeof fields.safetyCleanupApplied === 'boolean')
    projected.safetyCleanupApplied = fields.safetyCleanupApplied
  if (typeof fields.surface === 'string' && (['classic-voice', 'qwen-realtime', 'text-direct-message', 'text-guild'] as const).includes(fields.surface as StandaloneDiscordActivitySurface))
    projected.surface = fields.surface
  if (typeof fields.failureCategory === 'string' && AUDIT_FAILURE_CATEGORIES.has(fields.failureCategory as StandaloneDiscordOperationFailureCategory))
    projected.failureCategory = fields.failureCategory
  if (typeof fields.errorKind === 'string' && AUDIT_FAILURE_CATEGORIES.has(fields.errorKind as StandaloneDiscordOperationFailureCategory))
    projected.errorKind = fields.errorKind
  if (typeof fields.errorName === 'string' && AUDIT_ERROR_NAMES.has(fields.errorName))
    projected.errorName = fields.errorName
  if (typeof fields.reason === 'string' && AUDIT_REASONS.has(fields.reason))
    projected.reason = fields.reason
  if (typeof fields.status === 'string' && AUDIT_STATUSES.has(fields.status))
    projected.status = fields.status
  if (fields.deliveryReason === 'capacity' || fields.deliveryReason === 'send-failure')
    projected.deliveryReason = fields.deliveryReason
  if (fields.capacityScope === 'global-capacity' || fields.capacityScope === 'session-capacity')
    projected.capacityScope = fields.capacityScope
  return projected
}

const STANDALONE_DISCORD_ERROR_MESSAGES: Record<StandaloneDiscordErrorLocale, Record<StandaloneChatRuntimeErrorKind, string>> = {
  de: {
    'configuration': 'Die Modellkonfiguration ist ungültig. Prüfe den API-Schlüssel und das ausgewählte Modell im Dashboard.',
    'queue-full': 'AIRI verarbeitet gerade zu viele Nachrichten. Versuche es gleich noch einmal.',
    'service-unavailable': 'Der Modelldienst ist nach einem erneuten Versuch vorübergehend nicht verfügbar. Versuche es später noch einmal.',
    'stopped': 'AIRI wird gerade beendet oder neu gestartet.',
    'timeout': 'Die Modellantwort hat diesmal zu lange gedauert. Versuche es später noch einmal.',
    'unknown': 'Beim Erstellen der Antwort ist ein Fehler aufgetreten. Prüfe das lokale Laufzeitprotokoll.',
  },
  en: {
    'configuration': 'The model configuration is invalid. Check the API key and selected model in the Dashboard.',
    'queue-full': 'AIRI is handling too many messages right now. Please try again shortly.',
    'service-unavailable': 'The model service is temporarily unavailable after one retry. Please try again later.',
    'stopped': 'AIRI is stopping or restarting right now.',
    'timeout': 'The model response timed out this time. Please try again later.',
    'unknown': 'A reply could not be generated. Check the local runtime log.',
  },
  es: {
    'configuration': 'La configuración del modelo no es válida. Revisa la clave API y el modelo seleccionado en el panel.',
    'queue-full': 'AIRI está procesando demasiados mensajes. Inténtalo de nuevo en un momento.',
    'service-unavailable': 'El servicio del modelo sigue temporalmente no disponible después de un reintento. Inténtalo más tarde.',
    'stopped': 'AIRI se está cerrando o reiniciando.',
    'timeout': 'La respuesta del modelo tardó demasiado. Inténtalo de nuevo más tarde.',
    'unknown': 'No se pudo generar una respuesta. Revisa el registro local de ejecución.',
  },
  fr: {
    'configuration': 'La configuration du modèle est incorrecte. Vérifie la clé API et le modèle sélectionné dans le tableau de bord.',
    'queue-full': 'AIRI traite trop de messages pour le moment. Réessaie dans un instant.',
    'service-unavailable': 'Le service du modèle est temporairement indisponible après une nouvelle tentative. Réessaie plus tard.',
    'stopped': 'AIRI est en cours d’arrêt ou de redémarrage.',
    'timeout': 'La réponse du modèle a expiré cette fois-ci. Réessaie plus tard.',
    'unknown': 'La réponse n’a pas pu être générée. Consulte le journal d’exécution local.',
  },
  ja: {
    'configuration': 'モデル設定が正しくありません。ダッシュボードで API キーと選択中のモデルを確認してください。',
    'queue-full': 'AIRI は現在、多くのメッセージを処理しています。少し待ってからもう一度お試しください。',
    'service-unavailable': '再試行後もモデルサービスを一時的に利用できません。しばらくしてからもう一度お試しください。',
    'stopped': 'AIRI は現在、終了または再起動中です。',
    'timeout': 'モデルの応答がタイムアウトしました。しばらくしてからもう一度お試しください。',
    'unknown': '返信を生成できませんでした。ローカルの実行ログを確認してください。',
  },
  ko: {
    'configuration': '모델 설정이 올바르지 않습니다. 대시보드에서 API 키와 선택한 모델을 확인해 주세요.',
    'queue-full': 'AIRI가 현재 너무 많은 메시지를 처리하고 있습니다. 잠시 후 다시 시도해 주세요.',
    'service-unavailable': '한 번 재시도했지만 모델 서비스를 일시적으로 사용할 수 없습니다. 나중에 다시 시도해 주세요.',
    'stopped': 'AIRI가 현재 종료되거나 다시 시작되는 중입니다.',
    'timeout': '이번 모델 응답이 시간 초과되었습니다. 나중에 다시 시도해 주세요.',
    'unknown': '답변을 생성하지 못했습니다. 로컬 실행 로그를 확인해 주세요.',
  },
  zh: {
    'configuration': '模型配置无效。请在仪表盘中检查 API 密钥和所选模型。',
    'queue-full': 'AIRI 当前正在处理太多消息，请稍后再试。',
    'service-unavailable': '模型服务在重试后仍暂时不可用，请稍后再试。',
    'stopped': 'AIRI 当前正在关闭或重新启动。',
    'timeout': '这次模型响应超时了。请稍后再试一次。',
    'unknown': '暂时无法生成回复，请查看本地运行日志。',
  },
}

function resolveStandaloneDiscordErrorLocale(turn: StandaloneDiscordChatTurn): StandaloneDiscordErrorLocale {
  const channelLanguage = turn.channelName?.normalize('NFKC').toLowerCase().match(/(?:^|[-_])(de|en|es|fr|ja|jp|ko|kr|zh|cn)(?:$|[-_])/)?.[1]
  if (channelLanguage === 'jp')
    return 'ja'
  if (channelLanguage === 'kr')
    return 'ko'
  if (channelLanguage === 'cn')
    return 'zh'
  if (channelLanguage === 'de' || channelLanguage === 'en' || channelLanguage === 'es' || channelLanguage === 'fr' || channelLanguage === 'ja' || channelLanguage === 'ko' || channelLanguage === 'zh')
    return channelLanguage

  if (/\p{Script=Hiragana}|\p{Script=Katakana}/u.test(turn.text))
    return 'ja'
  if (/\p{Script=Hangul}/u.test(turn.text))
    return 'ko'
  if (/\p{Script=Han}/u.test(turn.text))
    return 'zh'

  const normalizedText = ` ${turn.text.normalize('NFKC').toLowerCase().replace(/\P{L}+/gu, ' ')} `
  if (/\b(?:bonjour|merci|pourquoi|salut|vous)\b/.test(normalizedText))
    return 'fr'
  if (/\b(?:danke|hallo|ich|warum|wie)\b/.test(normalizedText))
    return 'de'
  if (/\b(?:como|cómo|gracias|hola|porque|porqué)\b/.test(normalizedText))
    return 'es'

  return 'en'
}

/**
 * Formats a safe localized Discord error without exposing provider internals.
 *
 * Use when:
 * - Model generation failed after ingress and permission checks.
 * - Local observability only needs the fixed owning-boundary failure category.
 *
 * Expects:
 * - `turn` contains the current text and optional language-specific channel name.
 *
 * Returns:
 * - A short user-facing message in the best available conversation language.
 */
export function formatStandaloneDiscordReplyError(turn: StandaloneDiscordChatTurn, error: unknown): string {
  const kind = error instanceof StandaloneChatRuntimeError ? error.kind : 'unknown'
  return STANDALONE_DISCORD_ERROR_MESSAGES[resolveStandaloneDiscordErrorLocale(turn)][kind]
}

function describeStandaloneReplyFailure(error: unknown): {
  deliveredChunks?: number
  deliveryReason?: 'capacity' | 'send-failure'
  errorKind: StandaloneDiscordReplyFailureKind
  errorName: 'DiscordTextChunkingError' | 'DiscordTextDeliveryError' | 'Error' | 'SpeechProviderRequestError' | 'StandaloneChatRuntimeError'
  totalChunks?: number
} {
  if (error instanceof DiscordTextDeliveryError) {
    return {
      deliveredChunks: error.deliveredChunks,
      deliveryReason: error.reason,
      errorKind: 'delivery-failure',
      errorName: 'DiscordTextDeliveryError',
      totalChunks: error.totalChunks,
    }
  }

  if (error instanceof DiscordTextChunkingError) {
    return {
      errorKind: 'chunking-failure',
      errorName: 'DiscordTextChunkingError',
    }
  }

  if (error instanceof StandaloneChatRuntimeError) {
    return {
      errorKind: error.kind,
      errorName: 'StandaloneChatRuntimeError',
    }
  }

  if (typeof error === 'object' && error !== null) {
    const kind = Reflect.get(error, 'kind')
    if (kind === 'cancelled' || kind === 'provider-failure' || kind === 'timeout') {
      return {
        errorKind: kind,
        errorName: 'SpeechProviderRequestError',
      }
    }
  }

  return {
    errorKind: 'unknown',
    errorName: 'Error',
  }
}

export interface StandaloneDiscordAdapterConfig {
  /** Discord bot token used by the standalone app. */
  discordToken?: string
  /** Optional dashboard observer for lifecycle and redacted message events. */
  events?: StandaloneDiscordAdapterEvents
  /** Optional standalone Discord ingress filter settings. */
  filterConfig?: Partial<StandaloneDiscordFilterConfig>
  /** Clock used for expiring local event-throttle state. @default Date.now */
  now?: () => number
  /** Direct chat runtime that answers Discord text without AIRI desktop. */
  runtime: StandaloneChatRuntime
  /** Optional preconfigured STT/TTS runtime, normally resolved from the effective dashboard environment. */
  speechRuntime?: StandaloneSpeechRuntime
  /** Optional native audio-to-audio runtime selected instead of classic STT/TTS. */
  voiceCallRuntime?: RealtimeVoiceCallRuntime
  /** Optional generation-scoped sink for local, content-free voice diagnostics. */
  voiceDiagnostics?: VoiceDiagnosticsObserver
  /** Optional local memory command handler that bypasses model generation. */
  memoryCommands?: StandaloneDiscordMemoryCommandHandler
  /** Interval between typing-indicator refreshes while the model is working. @default 7000 */
  typingRefreshIntervalMs?: number
}

/**
 * Exact-session memory command boundary used by the Discord adapter.
 */
export interface StandaloneDiscordMemoryCommandHandler {
  /** Returns a direct Discord response and invalidates memory work only after a disabling write succeeds. */
  handleCommand: (
    turn: StandaloneDiscordChatTurn,
    context?: StandaloneDiscordMemoryCommandContext,
  ) => Promise<string | undefined>
}

/** Exact-session lifecycle effects available to the durable-memory command owner. */
export interface StandaloneDiscordMemoryCommandContext {
  /** Cancels queued/active automatic memory after opt-out or forget is durably recorded. */
  onMemoryDisabled: () => void
}

/**
 * Redacted standalone Discord lifecycle callbacks.
 */
export interface StandaloneDiscordAdapterEvents {
  /** Called when Discord confirms the bot connection without exposing its account tag. */
  onReady?: () => void
  /** Called when message ingress itself fails before a normal filter/reply decision. */
  onIngressFailed?: (payload: StandaloneDiscordOperationObservation & {
    /** Fixed ingress failure category; never Error.message/name/stack. */
    failureCategory: 'discord-ingress-failure'
  }) => void
  /** Called when a Discord message is observed but intentionally not handled. */
  onMessageIgnored?: (payload: StandaloneDiscordOperationObservation & {
    /** Allowlisted routing reason without permission names or external content. */
    reason: StandaloneDiscordMessageIgnoredReason
  }) => void
  /** Called when a Discord message is accepted for model generation. */
  onMessageAccepted?: (payload: StandaloneDiscordOperationObservation) => void
  /** Checks the ephemeral diagnostic marker in-process; the text is never retained or emitted. */
  matchesDiagnosticTextChallenge?: (text: string) => boolean
  /** Called after a matching message has passed the normal production admission path. */
  onDiagnosticTextAccepted?: (payload: StandaloneDiscordOperationObservation, text: string) => void
  /** Called when a Discord message is rejected before model generation. */
  onMessageRejected?: (payload: StandaloneDiscordOperationObservation & {
    /** Fixed admission rejection reason. */
    reason: StandaloneDiscordFilterRejectReason | 'queue-full'
    /** Bounded retry delay when rate policy supplies one. */
    retryAfterMs?: number
  }) => void
  /** Called after a generated reply is sent to Discord. */
  onReplySent?: (payload: StandaloneDiscordOperationObservation) => void
  /** Called when reply generation or sending fails, without provider-controlled text. */
  onReplyFailed?: (payload: {
    /** Stable failure category used for dashboard status. */
    errorKind: StandaloneDiscordReplyFailureKind
    /** Stable owning-boundary error class; never the provider's Error.name. */
    errorName: 'DiscordTextChunkingError' | 'DiscordTextDeliveryError' | 'Error' | 'SpeechProviderRequestError' | 'StandaloneChatRuntimeError'
    /** Confirmed chunks before a partial transport failure. */
    deliveredChunks?: number
    /** Fixed transport classification without Discord.js error content. */
    deliveryReason?: 'capacity' | 'send-failure'
    /** Anonymous operation correlation and fixed surface. */
    operationSequence: number
    /** Fixed surface without Discord identifiers. */
    surface: StandaloneDiscordActivitySurface
    /** Exact total chunks planned before the first send. */
    totalChunks?: number
  }) => void
  /** Called when the Discord connection lifecycle changes. */
  onStatusChange?: (payload: {
    /** Fixed failure category when status is terminal error. */
    failureCategory?: 'command-registration-failure' | 'lifecycle-cleanup-failure'
    /** Current lifecycle state. */
    status: 'starting' | 'ready' | 'stopping' | 'stopped' | 'error'
  }) => void
}

/**
 * Reason a Discord message was observed but not routed to model generation.
 */
export type StandaloneDiscordMessageIgnoredReason
  = | 'empty-content'
    | 'missing-author'
    | 'missing-discord-permission'
    | 'mention-required'
    | 'missing-send-target'
    | 'missing-session-metadata'

/**
 * Discord permission state required before standalone model generation.
 */
export interface StandaloneDiscordSendPermissionInput {
  /** Whether the message is outside a guild/server. */
  directMessage: boolean
  /** Effective bot permissions in the guild channel. */
  permissions?: Readonly<PermissionsBitField> | null
  /** Whether Discord reports this channel as a thread. */
  thread: boolean
  /** Whether Discord.js reports the current thread as writable now. */
  threadSendable?: boolean
}

/**
 * Result of the Discord send-permission preflight.
 */
export type StandaloneDiscordSendPermissionDecision
  = | { allowed: true }
    | { allowed: false, missingPermissions: string[] }

/**
 * Checks whether the bot can answer before any model request is made.
 *
 * Use when:
 * - A Discord message has passed mention and content checks.
 * - A failed send should not consume model API quota.
 *
 * Expects:
 * - Guild permissions are already resolved for the current bot member.
 * - `threadSendable` reflects archived, locked, membership, and timeout state.
 *
 * Returns:
 * - An allow decision or fixed diagnostic permission names safe for local logs.
 */
export function resolveStandaloneDiscordSendPermission(input: StandaloneDiscordSendPermissionInput): StandaloneDiscordSendPermissionDecision {
  if (input.directMessage)
    return { allowed: true }

  if (!input.permissions) {
    return {
      allowed: false,
      missingPermissions: ['PERMISSION_STATE_UNAVAILABLE'],
    }
  }

  const requiredPermissions = input.thread
    ? [{ bit: PermissionFlagsBits.ViewChannel, name: 'VIEW_CHANNEL' }, { bit: PermissionFlagsBits.SendMessagesInThreads, name: 'SEND_MESSAGES_IN_THREADS' }]
    : [{ bit: PermissionFlagsBits.ViewChannel, name: 'VIEW_CHANNEL' }, { bit: PermissionFlagsBits.SendMessages, name: 'SEND_MESSAGES' }]
  const missingPermissions = requiredPermissions
    .filter(permission => !input.permissions?.has(permission.bit))
    .map(permission => permission.name)

  if (input.thread && input.threadSendable === false && missingPermissions.length === 0)
    missingPermissions.push('THREAD_NOT_SENDABLE')

  return missingPermissions.length > 0
    ? { allowed: false, missingPermissions }
    : { allowed: true }
}

function isDiscordSendTarget(target: unknown): target is DiscordSendTarget {
  return typeof target === 'object'
    && target !== null
    && 'send' in target
    && typeof target.send === 'function'
}

function isDiscordTypingTarget(target: unknown): target is DiscordTypingTarget {
  return typeof target === 'object'
    && target !== null
    && 'sendTyping' in target
    && typeof target.sendTyping === 'function'
}

function isDiscordMessageAuthor(value: unknown): value is DiscordMessageAuthor {
  return typeof value === 'object'
    && value !== null
    && 'bot' in value
    && typeof value.bot === 'boolean'
    && 'id' in value
    && typeof value.id === 'string'
    && 'username' in value
    && typeof value.username === 'string'
}

/**
 * Resolves the standalone Discord chat session boundary.
 *
 * Use when:
 * - Discord text should be answered without AIRI desktop.
 * - Per-user, per-channel history should stay isolated for DMs and servers.
 *
 * Expects:
 * - Guild messages include `guildId`, `channelId`, and `userId`.
 *
 * Returns:
 * - A stable exact session id, or `undefined` when required ids are missing.
 */
export function resolveStandaloneDiscordSessionId(input: {
  channelId?: string
  guildId?: string | null
  userId?: string
}) {
  const channelId = input.channelId?.trim()
  const guildId = input.guildId?.trim()
  const userId = input.userId?.trim()
  if (!channelId || !userId)
    return undefined

  if (guildId)
    return `discord-standalone-guild-${guildId}-channel-${channelId}-user-${userId}`

  return `discord-standalone-dm-${userId}`
}

/**
 * Resolves an internal Discord location key for throttling only.
 *
 * Use when:
 * - Repeated ignored-message events need an exact internal throttle owner.
 * - Message metadata may be incomplete during early ingress checks.
 *
 * Expects:
 * - The caller already decided whether this is a DM.
 *
 * Returns:
 * - A process-local throttle key that must never cross an observability boundary.
 */
function describeStandaloneDiscordScope(message: DiscordMessage, directMessage: boolean, author?: DiscordMessageAuthor): string {
  if (directMessage)
    return `DM with ${author?.username ?? 'unknown user'}`

  return `${message.guild?.name ?? message.guildId ?? 'Discord server'} / ${message.channelId}`
}

function resolveStandaloneDiscordActivitySurface(directMessage: boolean): StandaloneDiscordActivitySurface {
  return directMessage ? 'text-direct-message' : 'text-guild'
}

function sleep(ms: number) {
  return new Promise<void>(resolve => setTimeout(resolve, ms))
}

/**
 * Discord client adapter for standalone AIRI chat.
 *
 * Use when:
 * - The Discord bot should run as its own software.
 * - AIRI desktop and the server channel websocket should not be started.
 *
 * Expects:
 * - `discordToken` is present before `start()`.
 * - `runtime` owns direct model generation for accepted text turns.
 *
 * Returns:
 * - A lifecycle object that can start and stop the Discord connection.
 */
export class StandaloneDiscordAdapter {
  private readonly discordClient: Client
  private readonly discordToken: string
  private readonly events: StandaloneDiscordAdapterEvents | undefined
  private readonly filter: StandaloneDiscordFilter
  private readonly ingressScheduler = new DiscordIngressScheduler()
  private readonly inFlightDirectMessageRecoveries = new Set<Promise<void>>()
  private readonly inFlightInteractions = new Set<Promise<void>>()
  private readonly inFlightMessageCapacityStatuses = new Set<Promise<void>>()
  private readonly inFlightMessages = new Set<Promise<void>>()
  private readonly inFlightVoiceStateUpdates = new Set<Promise<void>>()
  private readonly memoryCommands: StandaloneDiscordMemoryCommandHandler | undefined
  private readonly now: () => number
  private readonly runtime: StandaloneChatRuntime
  private readonly speechRuntime: StandaloneSpeechRuntime
  private readonly typingRefreshIntervalMs: number
  private readonly voiceManager: VoiceManager
  private readonly privacyNoticeSessionIds = new Map<string, number>()
  private readonly ignoredMessageEventTimestamps = new Map<string, number>()
  private commandRegistrationTask?: Promise<void>
  private lifecycleAbortController = new AbortController()
  private lifecycleGeneration = 1
  private nextIgnoredMessageEventSweepAt = 0
  private nextOperationSequence = 1
  private cleanupFailed = false
  private started = false
  private startTask?: Promise<void>
  private stopped = false
  private stopping = false
  private stopTask?: Promise<void>

  private reserveOperationSequence(): number {
    const sequence = this.nextOperationSequence
    this.nextOperationSequence = sequence >= 65_535 ? 1 : sequence + 1
    return sequence
  }

  constructor(config: StandaloneDiscordAdapterConfig) {
    this.discordToken = config.discordToken?.trim() ?? ''
    this.events = config.events
    this.filter = new StandaloneDiscordFilter(config.filterConfig)
    this.memoryCommands = config.memoryCommands
    this.now = config.now ?? Date.now
    this.runtime = config.runtime
    this.typingRefreshIntervalMs = Math.max(1, Math.trunc(config.typingRefreshIntervalMs ?? DEFAULT_TYPING_REFRESH_INTERVAL_MS))
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
    this.speechRuntime = config.speechRuntime ?? new StandaloneSpeechRuntime(resolveStandaloneSpeechRuntimeConfig(env))
    this.voiceManager = new VoiceManager(
      this.discordClient,
      input => this.handleVoiceTranscription(input),
      (wavBuffer, { abortSignal, deadlineAt, ownerKey, principalKey }) => this.speechRuntime.transcribe(wavBuffer, {
        abortSignal,
        deadlineAt,
        ownerKey,
        principalKey,
      }),
      config.voiceCallRuntime,
      {
        admit: (input) => {
          const sessionId = resolveStandaloneDiscordSessionId(input)
          if (!sessionId)
            return false

          const decision = this.filter.resolveInput({
            channelId: input.channelId,
            content: '',
            directMessage: false,
            guildId: input.guildId,
            sessionId,
            userId: input.userId,
          })
          if (decision.accepted === false) {
            const operationSequence = this.reserveOperationSequence()
            this.events?.onMessageRejected?.({
              operationSequence,
              reason: decision.reason,
              retryAfterMs: decision.retryAfterMs,
              surface: 'qwen-realtime',
            })
            this.audit('voice-input-rejected', {
              operationSequence,
              reason: decision.reason,
              retryAfterMs: decision.retryAfterMs,
              surface: 'qwen-realtime',
            })
            return false
          }

          return true
        },
        allows: (input) => {
          const sessionId = resolveStandaloneDiscordSessionId(input)
          if (!sessionId)
            return false

          return this.filter.resolveAccessPolicy({
            channelId: input.channelId,
            content: '',
            directMessage: false,
            guildId: input.guildId,
            sessionId,
            userId: input.userId,
          }).accepted
        },
      },
      {
        model: 'the configured standalone AIRI model provider',
        ...this.speechRuntime.getProviderDisclosure(),
      },
      undefined,
      config.voiceDiagnostics,
    )

    this.setupEventHandlers()
  }

  private async handleVoiceTranscription(input: VoiceTranscriptionInput): Promise<Readable | undefined> {
    if (input.abortSignal.aborted)
      return undefined

    const sessionId = resolveStandaloneDiscordSessionId({
      channelId: input.channelId,
      guildId: input.guildId,
      userId: input.userId,
    })
    if (!sessionId)
      return undefined

    const operationSequence = this.reserveOperationSequence()
    const surface = 'classic-voice' as const
    const turn: StandaloneDiscordChatTurn = {
      channelId: input.channelId,
      channelName: undefined,
      directMessage: false,
      displayName: input.speaker.displayName,
      guildId: input.guildId,
      guildName: input.speaker.guildName,
      sessionId,
      text: input.text,
      userId: input.userId,
    }
    const filterInput = {
      channelId: input.channelId,
      content: input.text,
      directMessage: false,
      guildId: input.guildId,
      sessionId,
      userId: input.userId,
    }
    // Identity and rate quota were admitted before Discord capture. Transcript-only
    // safety checks still run here because spoken content does not exist before STT.
    const filterDecision = this.filter.resolveAccessPolicy(filterInput)
    if (filterDecision.accepted === false) {
      this.audit('voice-input-rejected', {
        operationSequence,
        reason: filterDecision.reason,
        retryAfterMs: filterDecision.retryAfterMs,
        surface,
      })
      this.events?.onMessageRejected?.({
        operationSequence,
        reason: filterDecision.reason,
        retryAfterMs: filterDecision.retryAfterMs,
        surface,
      })
      return undefined
    }

    this.audit('voice-input-accepted', { operationSequence, surface })
    this.events?.onMessageAccepted?.({ operationSequence, surface })
    try {
      const reply = await this.runtime.reply(turn, {
        abortSignal: input.abortSignal,
        deadlineAt: input.deadlineAt,
      })
      if (this.stopping || input.abortSignal.aborted)
        return undefined

      const audio = await this.speechRuntime.synthesize(reply, {
        abortSignal: input.abortSignal,
        deadlineAt: input.deadlineAt,
        ownerKey: input.speechProviderOwnerKey,
        principalKey: input.speechProviderPrincipalKey,
      })
      if (this.stopping || input.abortSignal.aborted)
        return undefined

      this.audit('voice-reply-generated', { operationSequence, surface })
      this.events?.onReplySent?.({ operationSequence, surface })
      return Readable.from(Buffer.from(audio))
    }
    catch (error) {
      if (this.stopping || input.abortSignal.aborted)
        return undefined

      const failure = describeStandaloneReplyFailure(error)
      console.error('[discord-bot:standalone] failed to answer Discord voice input', {
        ...failure,
        operationSequence,
        surface,
      })
      this.audit('voice-reply-failed', { ...failure, operationSequence, surface })
      this.events?.onReplyFailed?.({ ...failure, operationSequence, surface })
      return undefined
    }
  }

  private async paceIncomingText(target: unknown): Promise<void> {
    const pacingMs = this.filter.getConfig().messagePacingMs
    if (isDiscordTypingTarget(target)) {
      try {
        await target.sendTyping()
      }
      catch {
        console.warn('[discord-bot:standalone] failed to send typing indicator', {
          failureCategory: 'discord-typing-failure',
        })
      }
    }

    // Discord typing indicators expire quickly; this pause keeps replies from feeling abrupt.
    if (pacingMs > 0)
      await sleep(pacingMs)
  }

  private async withTypingKeepAlive<T>(target: unknown, operation: () => Promise<T>): Promise<T> {
    if (!isDiscordTypingTarget(target))
      return operation()

    let typingRequestInFlight = false
    const refreshTyping = async () => {
      if (typingRequestInFlight)
        return

      typingRequestInFlight = true
      try {
        await target.sendTyping()
      }
      catch {
        console.warn('[discord-bot:standalone] failed to refresh typing indicator', {
          failureCategory: 'discord-typing-refresh-failure',
        })
      }
      finally {
        typingRequestInFlight = false
      }
    }
    const refreshTimer = setInterval(() => void refreshTyping(), this.typingRefreshIntervalMs)
    try {
      return await operation()
    }
    finally {
      clearInterval(refreshTimer)
    }
  }

  private isLifecycleActive(generation: number, signal = this.lifecycleAbortController.signal): boolean {
    return generation === this.lifecycleGeneration
      && !signal.aborted
      && !this.stopping
      && !this.stopped
  }

  private async deliverText(target: DiscordSendTarget, content: string, generation: number, principalKey: string) {
    const signal = this.lifecycleAbortController.signal
    return deliverDiscordText(content, async (payload) => {
      // NOTICE:
      // Discord.js may confirm send() immediately before the lifecycle signal aborts.
      // The wrapper task settles on later microtasks, so the abort race alone would undercount that confirmed chunk.
      // Source/context: `standalone-adapter.test.ts`, Discord audit D-022 confirmed-send regression.
      // Removal condition: Discord.js exposes an abortable send API with an atomic confirmation result.
      let confirmed = false
      const started = startDiscordTransport(principalKey, async () => {
        // Transport admission and invocation are separated by a microtask. Gate
        // again inside the raw owner so stop cannot start stale Discord REST work.
        if (!this.isLifecycleActive(generation, signal))
          return false
        await target.send(payload)
        confirmed = true
        return true
      })
      if (!started.accepted)
        throw new DiscordTransportCapacityError()
      const boundary = await waitForDiscordTransportBoundary(started.task, signal)
      return boundary.completed ? boundary.value : confirmed
    }, {
      isActive: () => this.isLifecycleActive(generation, signal),
      signal,
    })
  }

  private async sendPrivacyNoticeIfNeeded(
    target: DiscordSendTarget,
    sessionId: string,
    generation: number,
    principalKey: string,
  ): Promise<boolean> {
    const filterConfig = this.filter.getConfig()
    if (!filterConfig.privacyNoticeEnabled || this.hasSentPrivacyNotice(sessionId))
      return true

    try {
      const delivery = await this.deliverText(target, filterConfig.privacyNoticeText, generation, principalKey)
      if (delivery.status !== 'delivered' || !this.isLifecycleActive(generation))
        return false
      this.rememberPrivacyNotice(sessionId)
      this.audit('privacy-notice-sent', {})
      return true
    }
    catch {
      console.warn('[discord-bot:standalone] failed to send privacy notice', {
        status: 'delivery-failed',
      })
      return false
    }
  }

  private hasSentPrivacyNotice(sessionId: string): boolean {
    const now = this.now()
    const expiresAt = this.privacyNoticeSessionIds.get(sessionId)
    if (expiresAt === undefined || expiresAt <= now) {
      this.privacyNoticeSessionIds.delete(sessionId)
      return false
    }

    // Map insertion order owns LRU state; checking a live disclosure refreshes
    // its position without extending the fixed retention window.
    this.privacyNoticeSessionIds.delete(sessionId)
    this.privacyNoticeSessionIds.set(sessionId, expiresAt)
    return true
  }

  private rememberPrivacyNotice(sessionId: string): void {
    const now = this.now()
    this.privacyNoticeSessionIds.delete(sessionId)
    if (this.privacyNoticeSessionIds.size >= MAX_PRIVACY_NOTICE_SESSIONS) {
      for (const [trackedSessionId, expiresAt] of this.privacyNoticeSessionIds) {
        if (expiresAt <= now)
          this.privacyNoticeSessionIds.delete(trackedSessionId)
      }
    }
    while (this.privacyNoticeSessionIds.size >= MAX_PRIVACY_NOTICE_SESSIONS) {
      const leastRecentlyUsedSessionId = this.privacyNoticeSessionIds.keys().next().value
      if (typeof leastRecentlyUsedSessionId !== 'string')
        break
      this.privacyNoticeSessionIds.delete(leastRecentlyUsedSessionId)
    }
    this.privacyNoticeSessionIds.set(sessionId, now + PRIVACY_NOTICE_SESSION_TTL_MS)
  }

  private audit(event: StandaloneDiscordAuditEvent, fields: Readonly<Record<string, unknown>>): void {
    if (!this.filter.getConfig().auditLogEnabled)
      return

    console.info('[discord-bot:standalone] audit', {
      event,
      ...projectStandaloneDiscordAuditFields(fields),
    })
  }

  private recordIgnoredMessage(
    scope: string,
    reason: StandaloneDiscordMessageIgnoredReason,
    surface: StandaloneDiscordActivitySurface,
    operationSequence: number,
  ): void {
    const key = `${reason}:${scope}`
    const now = this.now()
    if (now >= this.nextIgnoredMessageEventSweepAt) {
      for (const [trackedKey, recordedAt] of this.ignoredMessageEventTimestamps) {
        if (now - recordedAt >= IGNORED_MESSAGE_EVENT_INTERVAL_MS)
          this.ignoredMessageEventTimestamps.delete(trackedKey)
      }
      this.nextIgnoredMessageEventSweepAt = now + IGNORED_MESSAGE_EVENT_INTERVAL_MS
    }

    const lastRecordedAt = this.ignoredMessageEventTimestamps.get(key)
    if (reason === 'mention-required' && lastRecordedAt !== undefined && now - lastRecordedAt < IGNORED_MESSAGE_EVENT_INTERVAL_MS)
      return

    if (reason === 'mention-required') {
      this.ignoredMessageEventTimestamps.delete(key)
      while (this.ignoredMessageEventTimestamps.size >= MAX_IGNORED_MESSAGE_EVENT_KEYS) {
        const leastRecentlyUsedKey = this.ignoredMessageEventTimestamps.keys().next().value
        if (typeof leastRecentlyUsedKey !== 'string')
          break
        this.ignoredMessageEventTimestamps.delete(leastRecentlyUsedKey)
      }
      this.ignoredMessageEventTimestamps.set(key, now)
    }
    this.audit('message-ignored', { operationSequence, reason, surface })
    this.events?.onMessageIgnored?.({ operationSequence, reason, surface })
  }

  /** Runs dynamic address, rate, privacy, and provider work inside exact-session FIFO. */
  private async processDiscordMessageEnvelope(envelope: StandaloneDiscordMessageEnvelope): Promise<void> {
    const {
      botUserId,
      filterInput,
      isDirectMessage,
      isMentioned,
      lifecycleGeneration,
      lifecycleSignal,
      message,
      operationSequence,
      principalKey,
      scope,
      surface,
      sessionId,
      turn,
    } = envelope
    const lifecycleActive = () => this.isLifecycleActive(lifecycleGeneration, lifecycleSignal)
    if (!lifecycleActive())
      return

    if (!isDirectMessage && !isMentioned) {
      const replyReference = await resolveDiscordReplyReference({
        botUserId,
        fetchReferencedAuthorId: async () => (await message.fetchReference()).author.id,
        isActive: lifecycleActive,
        principalKey,
        referencedMessageId: message.reference?.messageId,
        signal: lifecycleSignal,
      })
      this.audit('reply-reference-resolved', {
        matched: replyReference.matched,
        operationSequence,
        reason: replyReference.reason,
        surface,
      })
      if (!lifecycleActive())
        return
      if (!replyReference.matched) {
        this.recordIgnoredMessage(scope, 'mention-required', surface, operationSequence)
        return
      }
    }

    const memoryCommandReply = await this.memoryCommands?.handleCommand(turn, {
      onMemoryDisabled: () => this.runtime.clearMemorySession(sessionId),
    })
    if (memoryCommandReply) {
      if (!lifecycleActive() || !isDiscordSendTarget(message.channel))
        return

      const delivery = await this.deliverText(message.channel, memoryCommandReply, lifecycleGeneration, principalKey)
      if (delivery.status === 'delivered' && lifecycleActive())
        this.audit('memory-command-handled', { operationSequence, surface })
      return
    }

    const filterDecision = this.filter.resolveInput(filterInput)
    if (filterDecision.accepted === false) {
      this.audit('input-rejected', {
        operationSequence,
        reason: filterDecision.reason,
        retryAfterMs: filterDecision.retryAfterMs,
        surface,
      })
      this.events?.onMessageRejected?.({
        operationSequence,
        reason: filterDecision.reason,
        retryAfterMs: filterDecision.retryAfterMs,
        surface,
      })
      return
    }

    this.audit('input-accepted', { operationSequence, surface })
    this.events?.onMessageAccepted?.({ operationSequence, surface })
    if (this.events?.matchesDiagnosticTextChallenge?.(turn.text))
      this.events.onDiagnosticTextAccepted?.({ operationSequence, surface }, turn.text)
    if (!isDiscordSendTarget(message.channel))
      return

    try {
      await this.paceIncomingText(message.channel)
      if (!lifecycleActive())
        return
      const privacyNoticeReady = await this.sendPrivacyNoticeIfNeeded(
        message.channel,
        sessionId,
        lifecycleGeneration,
        principalKey,
      )
      if (!privacyNoticeReady) {
        if (lifecycleActive())
          this.events?.onMessageRejected?.({ operationSequence, reason: 'privacy-notice-failed', surface })
        return
      }

      const reply = await this.withTypingKeepAlive(message.channel, () => this.runtime.reply(turn))
      if (!lifecycleActive())
        return

      const delivery = await this.deliverText(message.channel, reply, lifecycleGeneration, principalKey)
      if (delivery.status !== 'delivered' || !lifecycleActive())
        return
      this.audit('reply-sent', { operationSequence, surface })
      this.events?.onReplySent?.({ operationSequence, surface })
    }
    catch (error) {
      if (!lifecycleActive())
        return

      const failure = describeStandaloneReplyFailure(error)
      console.error('[discord-bot:standalone] failed to answer Discord message', {
        ...failure,
        operationSequence,
        surface,
      })
      this.audit('reply-failed', { ...failure, operationSequence, surface })
      this.events?.onReplyFailed?.({ ...failure, operationSequence, surface })
      if (error instanceof DiscordTextDeliveryError && error.deliveredChunks > 0)
        return
      try {
        await this.deliverText(
          message.channel,
          formatStandaloneDiscordReplyError(turn, error),
          lifecycleGeneration,
          principalKey,
        )
      }
      catch {
        console.error('[discord-bot:standalone] failed to send fallback error message', {
          status: 'delivery-failed',
        })
      }
    }
  }

  private dispatchDiscordMessage(message: DiscordMessage): StandaloneDiscordMessageDispatch | undefined {
    const lifecycleGeneration = this.lifecycleGeneration
    const lifecycleSignal = this.lifecycleAbortController.signal
    const lifecycleActive = () => this.isLifecycleActive(lifecycleGeneration, lifecycleSignal)
    if (!lifecycleActive())
      return

    const authorValue = Reflect.get(message, 'author')
    const author = isDiscordMessageAuthor(authorValue) ? authorValue : undefined
    const isDM = !message.guild
    const operationSequence = this.reserveOperationSequence()
    const scope = describeStandaloneDiscordScope(message, isDM, author)
    const surface = resolveStandaloneDiscordActivitySurface(isDM)

    if (!author) {
      this.recordIgnoredMessage(scope, 'missing-author', surface, operationSequence)
      return
    }

    if (author.bot)
      return

    const principalKey = `discord-user-${author.id}`

    const sessionId = resolveStandaloneDiscordSessionId({
      channelId: message.channelId,
      guildId: message.guildId,
      userId: author.id,
    })
    if (!sessionId) {
      this.recordIgnoredMessage(scope, 'missing-session-metadata', surface, operationSequence)
      return
    }

    const botUserId = this.discordClient.user?.id
    const isMentioned = this.discordClient.user != null && message.mentions.has(this.discordClient.user)
    const isReplyCandidate = message.type === MessageType.Reply
      && message.reference?.type === MessageReferenceType.Default
    if (!isDM && !isMentioned && !isReplyCandidate) {
      this.recordIgnoredMessage(scope, 'mention-required', surface, operationSequence)
      return
    }

    const rawContent = message.content
    const content = isMentioned && botUserId
      // Remove AIRI's addressing mention while preserving references to other Discord users.
      ? removeDiscordBotMention(rawContent, botUserId)
      : rawContent.trim()
    if (!content) {
      this.recordIgnoredMessage(scope, 'empty-content', surface, operationSequence)
      return
    }

    if (!isDiscordSendTarget(message.channel)) {
      this.recordIgnoredMessage(scope, 'missing-send-target', surface, operationSequence)
      return
    }

    let permissions: Readonly<PermissionsBitField> | null | undefined
    if (message.inGuild()) {
      const botMember = message.guild.members.me
      permissions = botMember
        ? message.channel.permissionsFor(botMember)
        : undefined
    }
    const thread = message.channel.isThread()
    const sendPermission = resolveStandaloneDiscordSendPermission({
      directMessage: isDM,
      permissions,
      thread,
      threadSendable: thread ? message.channel.sendable : undefined,
    })
    if (sendPermission.allowed === false) {
      this.recordIgnoredMessage(scope, 'missing-discord-permission', surface, operationSequence)
      return
    }

    const turn: StandaloneDiscordChatTurn = {
      channelId: message.channelId,
      channelName: typeof Reflect.get(message.channel, 'name') === 'string' ? Reflect.get(message.channel, 'name') : undefined,
      directMessage: isDM,
      displayName: message.member?.displayName ?? author.globalName ?? author.username,
      guildId: message.guildId ?? undefined,
      guildName: message.guild?.name,
      messageId: message.id,
      sessionId,
      text: content,
      userId: author.id,
    }
    const filterInput = {
      channelId: message.channelId,
      content,
      directMessage: isDM,
      guildId: message.guildId,
      sessionId,
      userId: author.id,
    }
    const accessDecision = this.filter.resolveAccessPolicy(filterInput)
    if (accessDecision.accepted === false) {
      this.audit('input-rejected', {
        operationSequence,
        reason: accessDecision.reason,
        retryAfterMs: accessDecision.retryAfterMs,
        surface,
      })
      this.events?.onMessageRejected?.({
        operationSequence,
        reason: accessDecision.reason,
        retryAfterMs: accessDecision.retryAfterMs,
        surface,
      })
      return
    }
    if (!lifecycleActive())
      return

    const scheduled = this.ingressScheduler.schedule(principalKey, sessionId, () => this.processDiscordMessageEnvelope({
      author,
      botUserId,
      filterInput,
      isDirectMessage: isDM,
      isMentioned,
      lifecycleGeneration,
      lifecycleSignal,
      message,
      operationSequence,
      principalKey,
      scope,
      surface,
      sessionId,
      turn,
    }))
    if (scheduled.accepted === true) {
      return {
        kind: 'scheduled',
        task: scheduled.task,
      }
    }

    this.audit('input-rejected', {
      capacityScope: scheduled.reason,
      operationSequence,
      reason: 'queue-full',
      surface,
    })
    this.events?.onMessageRejected?.({ operationSequence, reason: 'queue-full', surface })
    if (this.inFlightMessageCapacityStatuses.size >= MAX_IN_FLIGHT_MESSAGE_CAPACITY_STATUSES) {
      // Queue-full replies need their own hard bound; otherwise overload could
      // create an unbounded secondary Discord delivery queue.
      console.warn('[discord-bot:standalone] message handler capacity reached', {
        status: 'capacity-status-reserve-exhausted',
        transport: 'message-create',
      })
      return undefined
    }

    const task = this.deliverText(
      message.channel,
      formatStandaloneDiscordReplyError(
        turn,
        new StandaloneChatRuntimeError('queue-full', 'Standalone Discord ingress queue is full.'),
      ),
      lifecycleGeneration,
      principalKey,
    ).then(
      () => undefined,
      () => {
        console.error('[discord-bot:standalone] failed to send queue capacity status', {
          status: 'delivery-failed',
        })
      },
    )
    return {
      kind: 'capacity-status',
      task,
    }
  }

  private async handleDiscordMessage(message: DiscordMessage): Promise<void> {
    const dispatch = this.handleDiscordMessageSafely(message)
    if (!dispatch)
      return
    this.trackDiscordMessageDispatch(dispatch)
    await dispatch.task
  }

  private recordDiscordIngressFailure(message: DiscordMessage, _error: unknown): void {
    const isDM = !message.guild
    const operationSequence = this.reserveOperationSequence()
    const surface = resolveStandaloneDiscordActivitySurface(isDM)
    console.error('[discord-bot:standalone] failed before Discord message could be routed', {
      failureCategory: 'discord-ingress-failure',
      operationSequence,
      surface,
    })
    this.audit('ingress-failed', {
      failureCategory: 'discord-ingress-failure',
      operationSequence,
      surface,
    })
    this.events?.onIngressFailed?.({
      failureCategory: 'discord-ingress-failure',
      operationSequence,
      surface,
    })
  }

  private handleDiscordMessageSafely(message: DiscordMessage): StandaloneDiscordMessageDispatch | undefined {
    try {
      const dispatch = this.dispatchDiscordMessage(message)
      if (!dispatch)
        return undefined
      return {
        kind: dispatch.kind,
        task: dispatch.task.catch((error) => {
          this.recordDiscordIngressFailure(message, error)
        }),
      }
    }
    catch (error) {
      this.recordDiscordIngressFailure(message, error)
      return undefined
    }
  }

  private trackDiscordMessageDispatch(dispatch: StandaloneDiscordMessageDispatch): void {
    const owner = dispatch.kind === 'scheduled'
      ? this.inFlightMessages
      : this.inFlightMessageCapacityStatuses
    owner.add(dispatch.task)
    void dispatch.task.finally(() => owner.delete(dispatch.task))
  }

  private async handleDiscordInteractionSafely(interaction: Interaction): Promise<void> {
    try {
      if (interaction.isButton()) {
        await this.voiceManager.handleConsentInteraction(interaction)
        return
      }

      if (!interaction.isChatInputCommand())
        return

      if (interaction.commandName === 'ping')
        await handlePing(interaction)

      if (interaction.commandName === 'summon' || interaction.commandName === 'dismiss') {
        if (!canManageDiscordVoiceInteraction(interaction, this.filter.getConfig().adminRoleIds)) {
          await interaction.reply({
            content: 'Manage Server permission and any configured AIRI admin role are required to manage voice chat.',
            ephemeral: true,
          })
          return
        }

        if (interaction.commandName === 'dismiss') {
          await this.voiceManager.handleLeaveChannelCommand(interaction)
          return
        }

        if (this.voiceManager.getVoiceCallMode() === 'qwen-realtime' && !this.voiceManager.isRealtimeVoiceCallConfigured()) {
          await interaction.reply({
            content: 'Configure the Qwen Realtime API key and workspace id in Voice Call settings before using /summon.',
            ephemeral: true,
          })
          return
        }

        if (this.voiceManager.getVoiceCallMode() === 'classic' && !this.speechRuntime.isConfigured()) {
          await interaction.reply({
            content: 'Configure STT and TTS API keys in the AIRI Discord Dashboard before using /summon.',
            ephemeral: true,
          })
          return
        }

        await this.voiceManager.handleJoinChannelCommand(interaction)
      }
    }
    catch {
      console.warn('[discord-bot:standalone] failed to handle Discord interaction', {
        failureCategory: 'discord-interaction-failure',
      })
      this.audit('interaction-failed', {
        failureCategory: 'discord-interaction-failure',
      })
    }
  }

  private async handleDiscordVoiceStateUpdateSafely(oldState: VoiceState, newState: VoiceState): Promise<void> {
    try {
      await this.voiceManager.handleVoiceStateUpdate(oldState, newState)
    }
    catch {
      // Discord's EventEmitter cannot observe rejected async listeners. Preserve
      // lifecycle observability through a fixed category. Discord identifiers,
      // provider errors, tokens, and participant content never cross this sink.
      console.error('[discord-bot:standalone] voice-state lifecycle cleanup failed', {
        failureCategory: 'discord-voice-cleanup-failure',
        status: 'cleanup-failed',
      })
    }
  }

  // NOTICE:
  // Discord.js 14.26.3 drops MESSAGE_CREATE for an uncached DM channel.
  // The gateway payload has no channel `type`, so MessageCreateAction cannot build the DMChannel.
  // Source/context: `discord.js/src/client/actions/MessageCreate.js:8` and `actions/Action.js:33`.
  // Remove this recovery after Discord.js emits MessageCreate for the live uncached-DM regression test.
  private recoverUncachedDirectMessage(packet: GatewayDispatchPayload): Promise<void> | undefined {
    if (packet.t !== GatewayDispatchEvents.MessageCreate || packet.d.guild_id)
      return undefined

    if (this.discordClient.channels.cache.has(packet.d.channel_id))
      return undefined

    const userId = packet.d.author?.id?.trim()
    const directMessageChannelId = packet.d.channel_id.trim()
    if (!userId && !directMessageChannelId) {
      this.audit('dm-recovery-skipped', { status: 'missing-principal' })
      return undefined
    }

    const generation = this.lifecycleGeneration
    const signal = this.lifecycleAbortController.signal
    const isActive = () => this.isLifecycleActive(generation, signal)
    // Some partial Raw payloads omit author even though the authoritative
    // fetched message contains it. A Discord DM channel is stable for the
    // current bot/user pair, so it remains a cross-generation principal key.
    const principalKey = userId
      ? `discord-user-${userId}`
      : `discord-dm-channel-${directMessageChannelId}`
    const transport = startDiscordTransport(principalKey, async () => {
      if (!isActive())
        return undefined
      const channel = await this.discordClient.channels.fetch(packet.d.channel_id)
      if (!isActive() || !channel?.isDMBased() || !channel.isTextBased())
        return undefined

      const message = await channel.messages.fetch(packet.d.id)
      return isActive() ? message : undefined
    })
    if (transport.accepted === false) {
      console.warn('[discord-bot:standalone] skipped uncached Discord DM recovery', {
        activeTransportCount: transport.activeTransportCount,
        status: 'transport-capacity',
      })
      this.audit('dm-recovery-skipped', {
        activeTransportCount: transport.activeTransportCount,
        status: 'transport-capacity',
      })
      return undefined
    }

    return (async () => {
      try {
        const boundary = await waitForDiscordTransportBoundary(transport.task, signal)
        if (!boundary.completed || !boundary.value || !isActive())
          return
        await this.handleDiscordMessage(boundary.value)
      }
      catch {
        const observation = {
          failureCategory: 'discord-fetch-failure',
          status: 'fetch-failed',
        }
        console.warn('[discord-bot:standalone] failed to recover uncached Discord DM', observation)
        this.audit('dm-recovery-failed', observation)
      }
    })()
  }

  private setupEventHandlers(): void {
    this.discordClient.once(Events.ClientReady, (readyClient) => {
      const task = Promise.resolve()
        .then(() => registerStandaloneDiscordCommands(this.discordToken, readyClient.user.id))
        .then(() => {
          if (this.stopping || this.stopped) {
            console.info('[discord-bot:standalone] command registration completed after shutdown began', {
              status: 'discarded-after-stop',
            })
            return
          }
          console.info('[discord-bot:standalone] Discord bot ready')
          this.events?.onReady?.()
          this.events?.onStatusChange?.({ status: 'ready' })
        }, (error) => {
          const observation = {
            failureCategory: 'command-registration-failure',
            status: this.stopping || this.stopped ? 'failed-after-stop' : 'registration-failed',
          }
          console.error('[discord-bot:standalone] standalone command registration failed', observation)
          if (!this.stopping && !this.stopped) {
            this.events?.onStatusChange?.({
              failureCategory: 'command-registration-failure',
              status: 'error',
            })
          }
          throw error
        })
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
    })

    this.discordClient.on(Events.MessageCreate, (message) => {
      const dispatch = this.handleDiscordMessageSafely(message)
      if (!dispatch)
        return
      this.trackDiscordMessageDispatch(dispatch)
    })

    this.discordClient.on(Events.InteractionCreate, (interaction: Interaction) => {
      if (this.inFlightInteractions.size >= MAX_IN_FLIGHT_INTERACTION_HANDLERS) {
        let safetyCleanupApplied = false
        try {
          if (interaction.isButton()) {
            safetyCleanupApplied = this.voiceManager.abortConsentWithdrawalAtCapacity(interaction)
          }
          else if (
            interaction.isChatInputCommand()
            && interaction.commandName === 'dismiss'
            && interaction.guildId
            && canManageDiscordVoiceInteraction(interaction, this.filter.getConfig().adminRoleIds)
          ) {
            safetyCleanupApplied = this.voiceManager.disconnectGuildVoiceAtCapacity(interaction.guildId)
          }
        }
        catch {
          console.error('[discord-bot:standalone] interaction capacity cleanup failed', {
            event: 'interaction-create',
            status: 'cleanup-failed',
          })
        }
        console.warn('[discord-bot:standalone] interaction handler capacity reached', {
          event: 'interaction-create',
          safetyCleanupApplied,
          status: 'handler-capacity',
        })
        this.audit('interaction-rejected', {
          event: 'interaction-create',
          reason: 'handler-capacity',
          safetyCleanupApplied,
        })
        return
      }
      const task = this.handleDiscordInteractionSafely(interaction)
      this.inFlightInteractions.add(task)
      void task.finally(() => this.inFlightInteractions.delete(task))
    })

    this.discordClient.on(Events.VoiceStateUpdate, (oldState, newState) => {
      if (this.inFlightVoiceStateUpdates.size >= MAX_IN_FLIGHT_VOICE_STATE_HANDLERS) {
        let safetyCleanupApplied = false
        try {
          safetyCleanupApplied = this.voiceManager.abortVoiceStateUpdateAtCapacity(oldState, newState)
        }
        catch {
          console.error('[discord-bot:standalone] voice-state capacity cleanup failed', {
            failureCategory: 'discord-voice-capacity-cleanup-failure',
            status: 'cleanup-failed',
          })
        }
        console.warn('[discord-bot:standalone] interaction handler capacity reached', {
          event: 'voice-state-update',
          safetyCleanupApplied,
          status: 'handler-capacity',
        })
        this.audit('interaction-rejected', {
          reason: 'handler-capacity',
          safetyCleanupApplied,
        })
        return
      }
      const task = this.handleDiscordVoiceStateUpdateSafely(oldState, newState)
      this.inFlightVoiceStateUpdates.add(task)
      void task.then(
        () => this.inFlightVoiceStateUpdates.delete(task),
        () => this.inFlightVoiceStateUpdates.delete(task),
      )
    })

    this.discordClient.on(Events.Raw, (packet) => {
      const task = this.recoverUncachedDirectMessage(packet)
      if (!task)
        return
      this.inFlightDirectMessageRecoveries.add(task)
      void task.finally(() => this.inFlightDirectMessageRecoveries.delete(task))
    })
  }

  start(): Promise<void> {
    if (!this.discordToken)
      return Promise.reject(new Error('DISCORD_TOKEN is required when AIRI_DISCORD_MODE=standalone.'))
    if (this.cleanupFailed)
      return Promise.reject(new Error('Standalone Discord adapter cleanup must complete before another start.'))
    if (this.stopping || this.stopped)
      return Promise.reject(new Error('Standalone Discord adapter is stopped and cannot be restarted.'))
    if (this.started)
      return Promise.resolve()
    if (this.startTask)
      return this.startTask

    let loginTask: Promise<string>
    try {
      console.info('[discord-bot:standalone] starting Discord client')
      this.events?.onStatusChange?.({ status: 'starting' })
      loginTask = this.discordClient.login(this.discordToken)
    }
    catch (error) {
      return Promise.reject(error)
    }

    const task = loginTask.then(() => {
      if (!this.stopping && !this.stopped)
        this.started = true
    })
    const trackedTask = task.finally(() => {
      if (this.startTask === trackedTask)
        this.startTask = undefined
    })
    this.startTask = trackedTask
    return trackedTask
  }

  stop(): Promise<void> {
    if (this.stopTask)
      return this.stopTask
    if (this.stopped)
      return Promise.resolve()

    const task = (async () => {
      console.info('[discord-bot:standalone] stopping Discord client')
      this.stopping = true
      this.started = false
      this.lifecycleGeneration += 1
      this.lifecycleAbortController.abort('stop')
      this.ignoredMessageEventTimestamps.clear()
      this.nextIgnoredMessageEventSweepAt = 0
      this.privacyNoticeSessionIds.clear()
      const failures: unknown[] = []
      const cleanupSync = (operation: () => void) => {
        try {
          operation()
        }
        catch (error) {
          failures.push(error)
        }
      }

      cleanupSync(() => this.events?.onStatusChange?.({ status: 'stopping' }))
      cleanupSync(() => this.discordClient.removeAllListeners(Events.ClientReady))
      cleanupSync(() => this.discordClient.removeAllListeners(Events.InteractionCreate))
      cleanupSync(() => this.discordClient.removeAllListeners(Events.MessageCreate))
      cleanupSync(() => this.discordClient.removeAllListeners(Events.Raw))
      cleanupSync(() => this.discordClient.removeAllListeners(Events.VoiceStateUpdate))

      // Login and ClientReady registration are bounded single owners. Drain
      // them before destroying the Discord client so neither can publish ready
      // state or revive gateway resources after stop reports completion.
      const pendingLifecycleResults = await Promise.allSettled([
        ...(this.startTask ? [this.startTask] : []),
        ...(this.commandRegistrationTask ? [this.commandRegistrationTask] : []),
      ])
      for (const result of pendingLifecycleResults) {
        if (result.status === 'rejected')
          failures.push(result.reason)
      }

      const inFlightDirectMessageRecoveries = [...this.inFlightDirectMessageRecoveries]
      const inFlightMessages = [...this.inFlightMessages]
      const inFlightMessageCapacityStatuses = [...this.inFlightMessageCapacityStatuses]
      const inFlightInteractions = [...this.inFlightInteractions]
      const inFlightVoiceStateUpdates = [...this.inFlightVoiceStateUpdates]
      const cleanupResults = await Promise.allSettled([
        Promise.resolve().then(() => this.voiceManager.stop()),
        Promise.resolve().then(() => this.discordClient.destroy()),
        Promise.resolve().then(() => this.runtime.stop()),
        ...inFlightDirectMessageRecoveries,
        ...inFlightMessages,
        ...inFlightMessageCapacityStatuses,
        ...inFlightInteractions,
        ...inFlightVoiceStateUpdates,
      ])
      for (const result of cleanupResults) {
        if (result.status === 'rejected')
          failures.push(result.reason)
      }
      this.inFlightDirectMessageRecoveries.clear()
      this.inFlightMessages.clear()
      this.inFlightMessageCapacityStatuses.clear()
      this.inFlightInteractions.clear()
      this.inFlightVoiceStateUpdates.clear()
      if (failures.length > 0) {
        this.cleanupFailed = true
        this.stopping = false
        cleanupSync(() => this.events?.onStatusChange?.({
          failureCategory: 'lifecycle-cleanup-failure',
          status: 'error',
        }))
        // Keep shutdown observable without serializing provider errors, request
        // bodies, transcripts, or tokens into process logs.
        console.error('[discord-bot:standalone] shutdown cleanup failed', {
          failedOperationCount: failures.length,
        })
        throw failures[0]
      }

      this.commandRegistrationTask = undefined
      this.cleanupFailed = false
      this.stopped = true
      this.stopping = false
      this.events?.onStatusChange?.({ status: 'stopped' })
    })()
    const trackedTask = task.finally(() => {
      if (this.stopTask === trackedTask)
        this.stopTask = undefined
    })
    this.stopTask = trackedTask
    return trackedTask
  }
}
