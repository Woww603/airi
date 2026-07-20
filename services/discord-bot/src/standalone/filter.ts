import { checkStandaloneDiscordInputSafety, normalizeStandaloneDiscordPolicyText } from './safety-policy'

/** Default privacy notice used by the standalone Discord filter. */
export const DEFAULT_STANDALONE_DISCORD_PRIVACY_NOTICE = '隐私提示：AIRI 在私聊默认启用长期记忆，并按 Discord 用户隔离。服务器频道仍需发送“记忆 开启”或 `!airi memory on` 才会启用。发送“记忆 关闭”或 `!airi memory off` 可停止当前会话的记忆读写；发送“记忆 遗忘”或 `!airi memory forget` 可同时删除当前会话已保存的记忆。'

/** Keep configured typing/pacing delays below a user-visible stall. */
const MAX_STANDALONE_DISCORD_MESSAGE_PACING_MS = 10_000

/** Keep rate-limit windows bounded so a bad value cannot mute a session for too long. */
const MAX_STANDALONE_DISCORD_RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000

/**
 * Reason a standalone Discord input was rejected before model generation.
 */
export type StandaloneDiscordFilterRejectReason
  = | 'blocked-guild'
    | 'blocked-term'
    | 'blocked-user'
    | 'channel-not-allowed'
    | 'direct-message-disabled'
    | 'privacy-notice-failed'
    | 'prompt-attack'
    | 'rate-limited'
    | 'sensitive-input'

/**
 * Standalone Discord ingress filter settings.
 */
export interface StandaloneDiscordFilterConfig {
  /** Exact Discord channel ids allowed for guild messages. Empty means all mentioned guild channels are accepted. */
  allowedChannelIds: string[]
  /** Exact Discord role ids allowed to use future Discord-side management commands. */
  adminRoleIds: string[]
  /** Exact Discord user ids rejected before model generation. */
  blockedUserIds: string[]
  /** Exact Discord guild/server ids rejected before model generation. */
  blockedGuildIds: string[]
  /** Case-insensitive plain-text terms rejected before model generation. */
  blockedTerms: string[]
  /** Whether direct messages are accepted. @default true */
  allowDirectMessages: boolean
  /** Whether prompt-injection and roleplay bypass attempts are rejected before model generation. @default true */
  promptAttackProtectionEnabled: boolean
  /** Whether obvious secrets and personal identifiers are rejected before model generation. @default true */
  sensitiveInputProtectionEnabled: boolean
  /** Whether the bot sends a privacy notice before first handling a Discord session. @default true */
  privacyNoticeEnabled: boolean
  /** Short notice sent into Discord before the first handled message for a session. */
  privacyNoticeText: string
  /** Whether guild long-term memory requires explicit per-session consent. DMs default on unless explicitly disabled. @default true */
  memoryConsentRequired: boolean
  /** Whether structured local audit logs are written for Discord policy events. @default true */
  auditLogEnabled: boolean
  /** Typing indicator wait before model generation, in milliseconds. @default 600 */
  messagePacingMs: number
  /** Number of accepted text inputs allowed per session/window. @default 6 */
  rateLimitMaxMessages: number
  /** Number of accepted text inputs allowed per Discord user/window across channels. @default 12 */
  userRateLimitMaxMessages: number
  /** Number of accepted text inputs allowed per Discord guild/window. @default 120 */
  guildRateLimitMaxMessages: number
  /** Number of accepted text inputs allowed across the whole bot/window. @default 300 */
  globalRateLimitMaxMessages: number
  /** Rate-limit window length in milliseconds. @default 30000 */
  rateLimitWindowMs: number
}

/**
 * One Discord input considered by the standalone filter.
 */
export interface StandaloneDiscordFilterInput {
  /** Exact Discord channel id. */
  channelId?: string
  /** Exact Discord guild/server id; absent for DMs. */
  guildId?: string | null
  /** Exact Discord user id. */
  userId?: string
  /** Whether this message came from a direct message channel. */
  directMessage: boolean
  /** Stable per-user/channel Discord chat session id. */
  sessionId: string
  /** User-visible message content after bot mentions have been removed. */
  content: string
}

/**
 * Standalone filter decision for a Discord text input.
 */
export type StandaloneDiscordFilterDecision
  = | { accepted: true }
    | { accepted: false, reason: StandaloneDiscordFilterRejectReason, retryAfterMs?: number }

interface StandaloneRateLimitBucket {
  count: number
  resetAt: number
}

function parseBooleanFlag(value: string | undefined, defaultValue: boolean) {
  const normalized = value?.trim().toLowerCase()
  if (!normalized)
    return defaultValue

  return normalized !== '0' && normalized !== 'false' && normalized !== 'off' && normalized !== 'no'
}

function parseInteger(value: string | number | undefined, defaultValue: number) {
  const parsed = typeof value === 'number' ? value : Number.parseInt(value ?? '', 10)
  return Number.isFinite(parsed) ? Math.trunc(parsed) : defaultValue
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
function normalizeDiscordId(value: string | undefined | null) {
  return value?.trim() ?? ''
}

/**
 * Normalizes pasted Discord id lists.
 *
 * Before:
 * - " 111, 222\n111 "
 *
 * After:
 * - ["111", "222"]
 */
function normalizeDiscordIdList(value: readonly string[] | string | undefined) {
  const source = typeof value === 'string'
    ? value.split(/[\s,;]+/)
    : [...(value ?? [])]

  return Array.from(new Set(source.map(normalizeDiscordId).filter(Boolean)))
}

/**
 * Normalizes blocked term lists while preserving phrase spacing.
 *
 * Before:
 * - "spam phrase\nTOKEN"
 *
 * After:
 * - ["spam phrase", "TOKEN"]
 */
function normalizeBlockedTerms(value: readonly string[] | string | undefined) {
  const source = typeof value === 'string'
    ? value.split(/[\n,;]+/)
    : [...(value ?? [])]

  const seenTerms = new Set<string>()
  const terms: string[] = []

  for (const item of source) {
    const term = item.replace(/\s+/g, ' ').trim()
    const key = term.toLowerCase()
    if (!term || seenTerms.has(key))
      continue

    seenTerms.add(key)
    terms.push(term)
  }

  return terms
}

/**
 * Normalizes the Discord privacy notice.
 *
 * Before:
 * - " Custom notice.\r\n"
 *
 * After:
 * - "Custom notice."
 */
function normalizePrivacyNotice(value: string | undefined) {
  return (value ?? '').replace(/\r\n?/g, '\n').trim().slice(0, 1900)
    || DEFAULT_STANDALONE_DISCORD_PRIVACY_NOTICE
}

/**
 * Normalizes Discord message pacing.
 *
 * Before:
 * - "12000"
 *
 * After:
 * - 10000
 */
function normalizeMessagePacingMs(value: string | number | undefined) {
  return Math.min(MAX_STANDALONE_DISCORD_MESSAGE_PACING_MS, Math.max(0, parseInteger(value, 600)))
}

/**
 * Normalizes Discord rate-limit message counts.
 *
 * Before:
 * - "-1"
 *
 * After:
 * - 0
 */
function normalizeRateLimitMaxMessages(value: string | number | undefined) {
  return Math.min(100, Math.max(0, parseInteger(value, 6)))
}

function normalizeLayeredRateLimitMaxMessages(value: string | number | undefined, defaultValue: number, maximum: number) {
  return Math.min(maximum, Math.max(0, parseInteger(value, defaultValue)))
}

/**
 * Normalizes Discord rate-limit windows.
 *
 * Before:
 * - "600000"
 *
 * After:
 * - 300000
 */
function normalizeRateLimitWindowMs(value: string | number | undefined) {
  return Math.min(MAX_STANDALONE_DISCORD_RATE_LIMIT_WINDOW_MS, Math.max(1000, parseInteger(value, 30_000)))
}

function createFilterConfig(config: Partial<StandaloneDiscordFilterConfig>): StandaloneDiscordFilterConfig {
  const rateLimitMaxMessages = normalizeRateLimitMaxMessages(config.rateLimitMaxMessages)
  return {
    allowedChannelIds: normalizeDiscordIdList(config.allowedChannelIds),
    adminRoleIds: normalizeDiscordIdList(config.adminRoleIds),
    allowDirectMessages: config.allowDirectMessages ?? true,
    auditLogEnabled: config.auditLogEnabled ?? true,
    blockedGuildIds: normalizeDiscordIdList(config.blockedGuildIds),
    blockedTerms: normalizeBlockedTerms(config.blockedTerms),
    blockedUserIds: normalizeDiscordIdList(config.blockedUserIds),
    globalRateLimitMaxMessages: normalizeLayeredRateLimitMaxMessages(config.globalRateLimitMaxMessages, rateLimitMaxMessages * 50, 5000),
    guildRateLimitMaxMessages: normalizeLayeredRateLimitMaxMessages(config.guildRateLimitMaxMessages, rateLimitMaxMessages * 20, 2000),
    memoryConsentRequired: config.memoryConsentRequired ?? true,
    messagePacingMs: normalizeMessagePacingMs(config.messagePacingMs),
    privacyNoticeEnabled: config.privacyNoticeEnabled ?? true,
    privacyNoticeText: normalizePrivacyNotice(config.privacyNoticeText),
    promptAttackProtectionEnabled: config.promptAttackProtectionEnabled ?? true,
    rateLimitMaxMessages,
    rateLimitWindowMs: normalizeRateLimitWindowMs(config.rateLimitWindowMs),
    sensitiveInputProtectionEnabled: config.sensitiveInputProtectionEnabled ?? true,
    userRateLimitMaxMessages: normalizeLayeredRateLimitMaxMessages(config.userRateLimitMaxMessages, rateLimitMaxMessages * 2, 200),
  }
}

function matchesBlockedTerm(content: string, blockedTerms: readonly string[]) {
  if (!blockedTerms.length)
    return false

  const normalizedContent = normalizeStandaloneDiscordPolicyText(content).toLowerCase()
  return blockedTerms.some(term => normalizedContent.includes(normalizeStandaloneDiscordPolicyText(term).toLowerCase()))
}

/**
 * Resolves standalone Discord filter config from process-like environment values.
 *
 * Use when:
 * - Starting the standalone Discord app without AIRI desktop.
 * - The local dashboard needs the effective filter settings.
 *
 * Expects:
 * - ID lists use whitespace, comma, or semicolon separators.
 * - Blocked terms use newlines, commas, or semicolons.
 *
 * Returns:
 * - A complete standalone Discord filter config with bounded pacing/rate-limit values.
 */
export function resolveStandaloneDiscordFilterConfig(env: NodeJS.ProcessEnv): StandaloneDiscordFilterConfig {
  const rateLimitMaxMessages = normalizeRateLimitMaxMessages(env.AIRI_DISCORD_RATE_LIMIT_MAX_MESSAGES)
  return createFilterConfig({
    allowedChannelIds: normalizeDiscordIdList(env.AIRI_DISCORD_ALLOWED_CHANNEL_IDS),
    adminRoleIds: normalizeDiscordIdList(env.AIRI_DISCORD_ADMIN_ROLE_IDS),
    allowDirectMessages: parseBooleanFlag(env.AIRI_DISCORD_ALLOW_DIRECT_MESSAGES, true),
    auditLogEnabled: parseBooleanFlag(env.AIRI_DISCORD_AUDIT_LOG_ENABLED, true),
    blockedGuildIds: normalizeDiscordIdList(env.AIRI_DISCORD_BLOCKED_GUILD_IDS),
    blockedTerms: normalizeBlockedTerms(env.AIRI_DISCORD_BLOCKED_TERMS),
    blockedUserIds: normalizeDiscordIdList(env.AIRI_DISCORD_BLOCKED_USER_IDS),
    globalRateLimitMaxMessages: normalizeLayeredRateLimitMaxMessages(env.AIRI_DISCORD_GLOBAL_RATE_LIMIT_MAX_MESSAGES, rateLimitMaxMessages * 50, 5000),
    guildRateLimitMaxMessages: normalizeLayeredRateLimitMaxMessages(env.AIRI_DISCORD_GUILD_RATE_LIMIT_MAX_MESSAGES, rateLimitMaxMessages * 20, 2000),
    memoryConsentRequired: parseBooleanFlag(env.AIRI_DISCORD_MEMORY_CONSENT_REQUIRED, true),
    messagePacingMs: normalizeMessagePacingMs(env.AIRI_DISCORD_MESSAGE_PACING_MS),
    privacyNoticeEnabled: parseBooleanFlag(env.AIRI_DISCORD_PRIVACY_NOTICE_ENABLED, true),
    privacyNoticeText: env.AIRI_DISCORD_PRIVACY_NOTICE_TEXT,
    promptAttackProtectionEnabled: parseBooleanFlag(env.AIRI_DISCORD_PROMPT_ATTACK_PROTECTION_ENABLED, true),
    rateLimitMaxMessages,
    rateLimitWindowMs: normalizeRateLimitWindowMs(env.AIRI_DISCORD_RATE_LIMIT_WINDOW_MS),
    sensitiveInputProtectionEnabled: parseBooleanFlag(env.AIRI_DISCORD_SENSITIVE_INPUT_PROTECTION_ENABLED, true),
    userRateLimitMaxMessages: normalizeLayeredRateLimitMaxMessages(env.AIRI_DISCORD_USER_RATE_LIMIT_MAX_MESSAGES, rateLimitMaxMessages * 2, 200),
  })
}

/**
 * Applies standalone Discord ingress filtering before model generation.
 *
 * Use when:
 * - The Discord bot runs without AIRI desktop security stores.
 * - Local env/dashboard settings must reject unwanted Discord inputs early.
 *
 * Expects:
 * - `sessionId` is stable for the current Discord user/channel boundary.
 * - Message content has already had the bot mention stripped.
 *
 * Returns:
 * - Accepted/rejected decisions and maintains per-session rate-limit buckets.
 */
export class StandaloneDiscordFilter {
  private readonly config: StandaloneDiscordFilterConfig
  private readonly layeredRateLimitBuckets = new Map<string, StandaloneRateLimitBucket>()
  private readonly rateLimitBuckets = new Map<string, StandaloneRateLimitBucket>()
  private nextRateLimitSweepAt = 0

  constructor(config: Partial<StandaloneDiscordFilterConfig> = {}) {
    this.config = createFilterConfig(config)
  }

  getConfig(): StandaloneDiscordFilterConfig {
    return {
      ...this.config,
      allowedChannelIds: [...this.config.allowedChannelIds],
      adminRoleIds: [...this.config.adminRoleIds],
      blockedGuildIds: [...this.config.blockedGuildIds],
      blockedTerms: [...this.config.blockedTerms],
      blockedUserIds: [...this.config.blockedUserIds],
    }
  }

  /**
   * Resolves whether one Discord input should reach the model.
   *
   * Use when:
   * - A Discord message has passed mention/content checks.
   * - The caller is ready to record accepted inputs in the rate-limit bucket.
   *
   * Expects:
   * - `now` is milliseconds since epoch when supplied by tests.
   *
   * Returns:
   * - A rejection reason or an accepted decision.
   */
  resolveInput(input: StandaloneDiscordFilterInput, now = Date.now()): StandaloneDiscordFilterDecision {
    this.pruneExpiredRateLimitBuckets(now)
    const accessDecision = this.resolveAccessPolicy(input)
    if (!accessDecision.accepted)
      return accessDecision

    return this.resolveRateLimit(
      input.sessionId,
      normalizeDiscordId(input.userId),
      normalizeDiscordId(input.guildId),
      now,
    )
  }

  /**
   * Applies standalone access and content policy without consuming rate-limit quota.
   *
   * Use when:
   * - Exact local management commands must remain available after a rate limit.
   * - Blocked users, guilds, channels, or message classes must still fail closed.
   *
   * Expects:
   * - The same Discord ingress metadata accepted by {@link resolveInput}.
   *
   * Returns:
   * - An access rejection or an accepted decision without mutating rate buckets.
   */
  resolveAccessPolicy(input: StandaloneDiscordFilterInput): StandaloneDiscordFilterDecision {
    const guildId = normalizeDiscordId(input.guildId)
    const channelId = normalizeDiscordId(input.channelId)
    const userId = normalizeDiscordId(input.userId)

    if (input.directMessage && !this.config.allowDirectMessages)
      return { accepted: false, reason: 'direct-message-disabled' }

    if (guildId && this.config.blockedGuildIds.includes(guildId))
      return { accepted: false, reason: 'blocked-guild' }

    if (userId && this.config.blockedUserIds.includes(userId))
      return { accepted: false, reason: 'blocked-user' }

    if (!input.directMessage && this.config.allowedChannelIds.length && !this.config.allowedChannelIds.includes(channelId))
      return { accepted: false, reason: 'channel-not-allowed' }

    if (matchesBlockedTerm(input.content, this.config.blockedTerms))
      return { accepted: false, reason: 'blocked-term' }

    const safetyDecision = checkStandaloneDiscordInputSafety(input.content)
    if (
      this.config.promptAttackProtectionEnabled
      && (safetyDecision.reason === 'prompt-attack' || safetyDecision.reason === 'internal-data-request')
    ) {
      return { accepted: false, reason: 'prompt-attack' }
    }

    if (
      this.config.sensitiveInputProtectionEnabled
      && (
        safetyDecision.reason === 'credential-or-secret'
        || safetyDecision.reason === 'internal-data-request'
        || safetyDecision.reason === 'personal-identifier'
      )
    ) {
      return { accepted: false, reason: 'sensitive-input' }
    }

    return { accepted: true }
  }

  private resolveRateLimit(sessionId: string, userId: string, guildId: string, now: number): StandaloneDiscordFilterDecision {
    const layers = [
      { key: sessionId, limit: this.config.rateLimitMaxMessages, map: this.rateLimitBuckets },
      ...(userId ? [{ key: `user:${userId}`, limit: this.config.userRateLimitMaxMessages, map: this.layeredRateLimitBuckets }] : []),
      ...(guildId ? [{ key: `guild:${guildId}`, limit: this.config.guildRateLimitMaxMessages, map: this.layeredRateLimitBuckets }] : []),
      { key: 'global', limit: this.config.globalRateLimitMaxMessages, map: this.layeredRateLimitBuckets },
    ].filter(layer => layer.limit > 0)
    const resolvedLayers = layers.map((layer) => {
      const activeBucket = layer.map.get(layer.key)
      return {
        ...layer,
        bucket: activeBucket && activeBucket.resetAt > now
          ? activeBucket
          : { count: 0, resetAt: now + this.config.rateLimitWindowMs },
      }
    })
    const rejectedLayer = resolvedLayers.find(layer => layer.bucket.count >= layer.limit)
    if (rejectedLayer) {
      return {
        accepted: false,
        reason: 'rate-limited',
        retryAfterMs: Math.max(0, rejectedLayer.bucket.resetAt - now),
      }
    }

    for (const layer of resolvedLayers) {
      layer.map.set(layer.key, {
        ...layer.bucket,
        count: layer.bucket.count + 1,
      })
    }

    return { accepted: true }
  }

  private pruneExpiredRateLimitBuckets(now: number): void {
    if (now < this.nextRateLimitSweepAt)
      return

    for (const [sessionId, bucket] of this.rateLimitBuckets) {
      if (bucket.resetAt <= now)
        this.rateLimitBuckets.delete(sessionId)
    }
    for (const [scopeId, bucket] of this.layeredRateLimitBuckets) {
      if (bucket.resetAt <= now)
        this.layeredRateLimitBuckets.delete(scopeId)
    }
    this.nextRateLimitSweepAt = now + this.config.rateLimitWindowMs
  }
}
