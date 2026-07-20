import type { StandaloneDiscordAdapterEvents } from '../adapters/standalone-adapter'
import type { VoiceDiagnosticsObserver } from '../bots/discord/commands/voiceDiagnostics'
import type { StandaloneCharacterCard, StandaloneCharacterCardPatch } from './character-card'
import type { StandaloneDashboardState } from './dashboard-state'
import type { StandaloneEnvValues } from './env-file'
import type { StandaloneMemoryEntry, StandaloneMemoryInput } from './memory-store'

import { dirname } from 'node:path'

import { StandaloneDiscordAdapter } from '../adapters/standalone-adapter'
import {
  parseStandaloneCharacterCardJson,
  serializeStandaloneCharacterCard,
  updateStandaloneCharacterCard,
} from './character-card'
import {
  defaultStandaloneTextGenerator,
  normalizeStandaloneModelRequestTimeout,
  resolveStandaloneChatRuntimeConfig,
  StandaloneChatRuntime,
} from './chat-runtime'
import { readStandaloneEnvFileIfExists, writeStandaloneEnvValues } from './env-file'
import { resolveStandaloneDiscordFilterConfig } from './filter'
import { createStandaloneMemoryExtractor } from './memory-extractor'
import { resolveStandaloneMemoryStoreConfig, StandaloneMemoryStore } from './memory-store'
import { QwenRealtimeRuntime, resolveQwenRealtimeConfig } from './qwen-realtime'
import {
  parseStandaloneDiscordRulesByGuildJson,
  resolveStandaloneDiscordRulesDraft,
  serializeStandaloneDiscordRulesByGuild,
  updateStandaloneDiscordRules,
} from './rules'
import { resolveStandaloneSpeechRuntimeConfig, StandaloneSpeechRuntime } from './speech-runtime'

/**
 * Public standalone config shown in the dashboard.
 */
export interface StandaloneDashboardPublicConfig {
  /** Absolute `.env.local` path edited by the dashboard. */
  envFilePath: string
  /** Whether `DISCORD_TOKEN` is non-empty. */
  discordTokenConfigured: boolean
  /** Whether `DEEPSEEK_API_KEY` is non-empty. */
  deepSeekApiKeyConfigured: boolean
  /** DeepSeek model used by standalone chat. */
  deepSeekModel: string
  /** Optional DeepSeek-compatible base URL override. */
  deepSeekApiBaseUrl: string
  /** Active standalone AIRI character card. */
  characterCard: StandaloneCharacterCard
  /** Standalone Discord system prompt. */
  systemPrompt: string
  /** Newline-separated exact Discord channel ids accepted for guild messages. */
  allowedChannelIdsText: string
  /** Newline-separated exact Discord role ids allowed to use future management commands. */
  adminRoleIdsText: string
  /** Newline-separated exact Discord user ids rejected before model generation. */
  blockedUserIdsText: string
  /** Newline-separated exact Discord guild/server ids rejected before model generation. */
  blockedGuildIdsText: string
  /** Newline-separated plain-text terms rejected before model generation. */
  blockedTermsText: string
  /** Whether direct messages are accepted. */
  allowDirectMessages: boolean
  /** Whether prompt-injection and roleplay bypass attempts are rejected before generation. */
  promptAttackProtectionEnabled: boolean
  /** Whether secrets and personal identifiers are rejected before generation. */
  sensitiveInputProtectionEnabled: boolean
  /** Whether privacy notices are sent before first handled message in a session. */
  privacyNoticeEnabled: boolean
  /** Privacy notice sent into Discord. */
  privacyNoticeText: string
  /** Whether guild long-term memory requires explicit per-session consent. DMs default on unless explicitly disabled. */
  memoryConsentRequired: boolean
  /** Whether local structured Discord policy audit logs are enabled. */
  auditLogEnabled: boolean
  /** Typing/pacing wait before model generation, in milliseconds. */
  messagePacingMs: number
  /** Accepted messages per session/rate-limit window. */
  rateLimitMaxMessages: number
  /** Rate-limit window length in milliseconds. */
  rateLimitWindowMs: number
  /** Bounded history limit shown in the settings form. */
  historyLimit: number
  /** Maximum duration of one model request in milliseconds. */
  modelRequestTimeoutMs: number
  /** Whether standalone long-term memory is enabled. */
  memoryEnabled: boolean
  /** Whether explicit memory phrases in chat are captured as cards. */
  memoryAutoCaptureEnabled: boolean
  /** Absolute local JSON memory file path. */
  memoryFilePath: string
  /** Number of local memory cards. */
  memoryCount: number
  /** Absolute bounded runtime log file path when file logging is enabled. */
  runtimeLogFilePath: string
  /** Whether OpenAI-compatible fallback fields are also configured. */
  openAICompatibleConfigured: boolean
  /** Whether the standalone STT API key is configured. */
  sttApiKeyConfigured: boolean
  /** Optional OpenAI-compatible STT base URL. */
  sttApiBaseUrl: string
  /** STT model used for Discord voice input. */
  sttModel: string
  /** Whether TTS has an explicit key or reuses the STT key. */
  ttsApiKeyConfigured: boolean
  /** Optional OpenAI-compatible TTS base URL. */
  ttsApiBaseUrl: string
  /** TTS model used for AIRI voice replies. */
  ttsModel: string
  /** TTS voice identifier used for AIRI replies. */
  ttsVoice: string
  /** Provider mode used by `/summon`. */
  voiceCallMode: 'classic' | 'qwen-realtime'
  /** Whether a DashScope API key is configured without exposing it. */
  qwenRealtimeApiKeyConfigured: boolean
  /** Local interruption sensitivity from 0 (strong noise rejection) to 100 (soft voice activation). */
  qwenRealtimeInterruptionSensitivity: number
  /** Alibaba Cloud region used by Qwen Realtime. */
  qwenRealtimeRegion: 'beijing' | 'singapore'
  /** Whether a Bailian business workspace id is configured without exposing it. */
  qwenRealtimeWorkspaceIdConfigured: boolean
  /** Native audio-to-audio model identifier. */
  qwenRealtimeModel: string
  /** Native Qwen output voice identifier. */
  qwenRealtimeVoice: string
  /** Discord speaking-end debounce before submitting a Qwen turn, in milliseconds. */
  qwenRealtimeSilenceDurationMs: number
  /** Whether the standalone dashboard cycles the accent color like AIRI's RGB ON option. */
  dashboardRgbOn: boolean
  /** Selected exact guild/server id for scoped rules. */
  selectedGuildId: string
  /** Guild-wide scoped rule text for `selectedGuildId`. */
  guildRulesText: string
  /** Selected exact channel id for scoped channel rules. */
  selectedChannelId: string
  /** Channel-scoped rule text for `selectedChannelId`. */
  channelRulesText: string
}

/**
 * Explicit mutation requested for a dashboard-managed secret.
 */
export type StandaloneSecretPatch
  = | {
    /** Preserve the effective secret without writing a local override. */
    action: 'unchanged'
  }
  | {
    /** Replace the effective secret with an explicit empty local override. */
    action: 'clear'
  }
  | {
    /** Replace the effective secret with `value`. */
    action: 'set'
    /** Non-empty secret value accepted only at the local HTTP boundary. */
    value: string
  }

/**
 * Dashboard config patch submitted by the browser form.
 */
export interface StandaloneDashboardConfigPatch extends StandaloneCharacterCardPatch {
  /** Explicit Discord token mutation. Missing values preserve the effective secret. */
  discordToken?: StandaloneSecretPatch
  /** Explicit DeepSeek API key mutation. Missing values preserve the effective secret. */
  deepSeekApiKey?: StandaloneSecretPatch
  /** DeepSeek model id. */
  deepSeekModel?: string
  /** Optional DeepSeek base URL override. */
  deepSeekApiBaseUrl?: string
  /** Optional standalone system prompt. */
  systemPrompt?: string
  /** Explicit STT API key mutation. Missing values preserve the effective secret. */
  sttApiKey?: StandaloneSecretPatch
  /** Optional OpenAI-compatible STT base URL. */
  sttApiBaseUrl?: string
  /** STT model identifier. */
  sttModel?: string
  /** Explicit TTS API key mutation. Missing values preserve the effective secret. */
  ttsApiKey?: StandaloneSecretPatch
  /** Optional OpenAI-compatible TTS base URL. */
  ttsApiBaseUrl?: string
  /** TTS model identifier. */
  ttsModel?: string
  /** TTS voice identifier. */
  ttsVoice?: string
  /** Provider mode used by `/summon`. */
  voiceCallMode?: string
  /** Explicit DashScope API key mutation. Missing values preserve the effective secret. */
  qwenRealtimeApiKey?: StandaloneSecretPatch
  /** Local interruption sensitivity from 0 to 100. */
  qwenRealtimeInterruptionSensitivity?: string
  /** Alibaba Cloud provider region. */
  qwenRealtimeRegion?: string
  /** Explicit Bailian workspace id mutation. Missing values preserve the effective identifier. */
  qwenRealtimeWorkspaceId?: StandaloneSecretPatch
  /** Qwen audio-to-audio model identifier. */
  qwenRealtimeModel?: string
  /** Qwen output voice identifier. */
  qwenRealtimeVoice?: string
  /** Discord speaking-end debounce before submitting a Qwen turn, in milliseconds. */
  qwenRealtimeSilenceDurationMs?: string
  /** Optional newline-separated Discord channel allowlist. */
  allowedChannelIdsText?: string
  /** Optional newline-separated Discord admin role ids. */
  adminRoleIdsText?: string
  /** Optional newline-separated blocked user ids. */
  blockedUserIdsText?: string
  /** Optional newline-separated blocked guild ids. */
  blockedGuildIdsText?: string
  /** Optional newline-separated blocked terms. */
  blockedTermsText?: string
  /** Optional direct-message enabled flag. */
  allowDirectMessages?: string
  /** Optional prompt-injection protection flag. */
  promptAttackProtectionEnabled?: string
  /** Optional sensitive input protection flag. */
  sensitiveInputProtectionEnabled?: string
  /** Optional privacy notice enabled flag. */
  privacyNoticeEnabled?: string
  /** Optional privacy notice text. */
  privacyNoticeText?: string
  /** Optional guild memory consent gate flag. */
  memoryConsentRequired?: string
  /** Optional audit log enabled flag. */
  auditLogEnabled?: string
  /** Optional message pacing value. */
  messagePacingMs?: string
  /** Optional rate-limit message count. */
  rateLimitMaxMessages?: string
  /** Optional rate-limit window value. */
  rateLimitWindowMs?: string
  /** Optional history limit. */
  historyLimit?: string
  /** Optional model request timeout in milliseconds. */
  modelRequestTimeoutMs?: string
  /** Optional long-term memory enabled flag. */
  memoryEnabled?: string
  /** Optional explicit chat memory capture flag. */
  memoryAutoCaptureEnabled?: string
  /** Optional dashboard RGB accent animation flag. */
  dashboardRgbOn?: string
  /** Optional selected exact Discord guild id for scoped rules. */
  selectedGuildId?: string
  /** Optional guild-wide scoped rule text. */
  guildRulesText?: string
  /** Optional selected exact Discord channel id for scoped rules. */
  selectedChannelId?: string
  /** Optional channel-specific scoped rule text. */
  channelRulesText?: string
}

/**
 * Result of a standalone bot lifecycle operation.
 */
export interface StandaloneBotOperationResult {
  /** Whether the operation completed. */
  ok: boolean
  /** User-facing message for dashboard toasts. */
  message: string
}

/**
 * Snapshot of standalone memory cards for the dashboard.
 */
export interface StandaloneMemorySnapshot {
  /** Effective memory store settings. */
  config: Pick<StandaloneDashboardPublicConfig, 'memoryAutoCaptureEnabled' | 'memoryEnabled' | 'memoryFilePath'>
  /** Stored memory cards, newest/recently-used first. */
  memories: StandaloneMemoryEntry[]
}

/**
 * Controller for standalone Discord bot and dashboard operations.
 *
 * Use when:
 * - A local dashboard should configure and control the standalone bot process.
 * - The process should remain alive even when Discord/DeepSeek config is missing.
 *
 * Expects:
 * - `envFilePath` points to the package `.env.local` file.
 * - Secrets are never returned through public config snapshots.
 *
 * Returns:
 * - Start/stop/save operations for the dashboard HTTP server.
 */
export class StandaloneDiscordAppController {
  /** Maximum active and queued config transactions retained by one controller. */
  private static readonly pendingConfigSaveLimit = 16

  private readonly env: NodeJS.ProcessEnv
  private readonly envFilePath: string
  private readonly state: StandaloneDashboardState
  private adapter: StandaloneDiscordAdapter | undefined
  // A failed cleanup owner remains reachable until the exact adapter confirms
  // teardown. This single slot prevents a replacement client from overlapping a
  // gateway whose destroy operation failed.
  private retiringAdapter: StandaloneDiscordAdapter | undefined
  private lifecycleGeneration = 0
  private capabilityDiagnosticsGeneration = 0
  private startTask?: Promise<StandaloneBotOperationResult>
  private startTaskGeneration?: number
  private stopTask?: Promise<StandaloneBotOperationResult>
  // Config persistence is a read-modify-write transaction. The gate covers the
  // initial read through the disk commit so concurrent dashboard forms cannot
  // both derive a replacement file from the same stale snapshot.
  private configSaveTail: Promise<void> = Promise.resolve()
  private pendingConfigSaveCount = 0

  constructor(config: {
    env: NodeJS.ProcessEnv
    envFilePath: string
    state: StandaloneDashboardState
  }) {
    this.env = config.env
    this.envFilePath = config.envFilePath
    this.state = config.state
  }

  private async readEffectiveEnv(): Promise<NodeJS.ProcessEnv> {
    return {
      ...this.env,
      ...(await readStandaloneEnvFileIfExists(this.envFilePath)),
    }
  }

  private createMemoryStore(effectiveEnv: NodeJS.ProcessEnv, extractor?: ReturnType<typeof createStandaloneMemoryExtractor>) {
    return new StandaloneMemoryStore(resolveStandaloneMemoryStoreConfig(effectiveEnv, dirname(this.envFilePath)), { extractor })
  }

  private async getMemoryCount(effectiveEnv: NodeJS.ProcessEnv) {
    try {
      return (await this.createMemoryStore(effectiveEnv).listMemories()).length
    }
    catch {
      return 0
    }
  }

  private createFilterConfig(effectiveEnv: NodeJS.ProcessEnv) {
    return resolveStandaloneDiscordFilterConfig(effectiveEnv)
  }

  private static formatConfigList(values: readonly string[]) {
    return values.join('\n')
  }

  private static booleanPatch(value: string | undefined, fallback: string | undefined, defaultValue: string) {
    if (value === undefined)
      return fallback ?? defaultValue

    const normalized = value.trim().toLowerCase()
    return normalized === 'true' || normalized === '1' || normalized === 'on' || normalized === 'yes'
      ? 'true'
      : 'false'
  }

  private createAdapterEvents(generation: number): StandaloneDiscordAdapterEvents {
    const ownsLifecycle = () => generation === this.lifecycleGeneration
    return {
      onIngressFailed: (observation) => {
        if (ownsLifecycle())
          this.state.recordIngressFailure(observation)
      },
      onMessageIgnored: (observation) => {
        if (ownsLifecycle())
          this.state.recordIgnoredMessage(observation)
      },
      onMessageAccepted: (observation) => {
        if (ownsLifecycle())
          this.state.recordAcceptedMessage(observation)
      },
      matchesDiagnosticTextChallenge: text => ownsLifecycle() && this.state.matchesCapabilityTextChallenge(text),
      onDiagnosticTextAccepted: (observation, text) => {
        if (ownsLifecycle())
          this.state.recordDiagnosticTextAccepted(text, observation)
      },
      onMessageRejected: (observation) => {
        if (ownsLifecycle())
          this.state.recordRejectedMessage(observation)
      },
      onReady: () => {
        if (ownsLifecycle()) {
          this.state.setBotReady()
          this.state.recordCapabilityBotReady()
        }
      },
      onReplyFailed: ({ errorKind, operationSequence, surface }) => {
        if (ownsLifecycle())
          this.state.recordFailedReply({ errorKind, operationSequence, surface })
      },
      onReplySent: (observation) => {
        if (ownsLifecycle())
          this.state.recordSuccessfulReply(observation)
      },
      onStatusChange: ({ failureCategory, status }) => {
        if (ownsLifecycle()) {
          this.state.setBotStatus(status, failureCategory)
          if (status === 'error')
            this.state.recordCapabilityBotFailure()
        }
      },
    }
  }

  private createVoiceDiagnosticsObserver(generation: number): VoiceDiagnosticsObserver {
    return {
      record: (signal) => {
        if (generation === this.lifecycleGeneration && signal.runtimeSequence === generation)
          this.state.recordVoiceDiagnostic(signal)
      },
      runtimeSequence: generation,
    }
  }

  async getPublicConfig(): Promise<StandaloneDashboardPublicConfig> {
    const effectiveEnv = await this.readEffectiveEnv()
    const filterConfig = this.createFilterConfig(effectiveEnv)
    const memoryConfig = this.createMemoryStore(effectiveEnv).getConfig()
    const rulesDraft = resolveStandaloneDiscordRulesDraft(
      parseStandaloneDiscordRulesByGuildJson(effectiveEnv.AIRI_DISCORD_RULES_BY_GUILD_JSON),
      effectiveEnv.AIRI_DISCORD_SELECTED_GUILD_ID,
      effectiveEnv.AIRI_DISCORD_SELECTED_CHANNEL_ID,
    )
    const characterCard = parseStandaloneCharacterCardJson(effectiveEnv.AIRI_DISCORD_CHARACTER_CARD_JSON)
    const speechConfig = resolveStandaloneSpeechRuntimeConfig(effectiveEnv)
    const qwenRealtimeConfig = resolveQwenRealtimeConfig(effectiveEnv)

    return {
      allowedChannelIdsText: StandaloneDiscordAppController.formatConfigList(filterConfig.allowedChannelIds),
      adminRoleIdsText: StandaloneDiscordAppController.formatConfigList(filterConfig.adminRoleIds),
      allowDirectMessages: filterConfig.allowDirectMessages,
      auditLogEnabled: filterConfig.auditLogEnabled,
      blockedGuildIdsText: StandaloneDiscordAppController.formatConfigList(filterConfig.blockedGuildIds),
      blockedTermsText: StandaloneDiscordAppController.formatConfigList(filterConfig.blockedTerms),
      blockedUserIdsText: StandaloneDiscordAppController.formatConfigList(filterConfig.blockedUserIds),
      characterCard,
      channelRulesText: rulesDraft.channelRulesText,
      deepSeekApiBaseUrl: effectiveEnv.DEEPSEEK_API_BASE_URL?.trim() ?? '',
      deepSeekApiKeyConfigured: Boolean(effectiveEnv.DEEPSEEK_API_KEY?.trim()),
      deepSeekModel: effectiveEnv.DEEPSEEK_MODEL?.trim() || 'deepseek-v4-flash',
      dashboardRgbOn: StandaloneDiscordAppController.booleanPatch(
        effectiveEnv.AIRI_DISCORD_DASHBOARD_RGB_ON,
        undefined,
        'false',
      ) === 'true',
      discordTokenConfigured: Boolean(effectiveEnv.DISCORD_TOKEN?.trim()),
      envFilePath: this.envFilePath,
      historyLimit: Number.parseInt(effectiveEnv.AIRI_DISCORD_HISTORY_LIMIT ?? '24', 10) || 24,
      memoryAutoCaptureEnabled: memoryConfig.autoCaptureEnabled,
      memoryCount: await this.getMemoryCount(effectiveEnv),
      memoryConsentRequired: filterConfig.memoryConsentRequired,
      memoryEnabled: memoryConfig.enabled,
      memoryFilePath: memoryConfig.filePath,
      messagePacingMs: filterConfig.messagePacingMs,
      modelRequestTimeoutMs: normalizeStandaloneModelRequestTimeout(effectiveEnv.AIRI_DISCORD_MODEL_TIMEOUT_MS),
      openAICompatibleConfigured: Boolean(effectiveEnv.OPENAI_API_KEY?.trim() && effectiveEnv.OPENAI_MODEL?.trim()),
      privacyNoticeEnabled: filterConfig.privacyNoticeEnabled,
      privacyNoticeText: filterConfig.privacyNoticeText,
      promptAttackProtectionEnabled: filterConfig.promptAttackProtectionEnabled,
      rateLimitMaxMessages: filterConfig.rateLimitMaxMessages,
      rateLimitWindowMs: filterConfig.rateLimitWindowMs,
      runtimeLogFilePath: effectiveEnv.AIRI_DISCORD_RUNTIME_LOG_PATH?.trim() ?? '',
      selectedChannelId: rulesDraft.selectedChannelId,
      selectedGuildId: rulesDraft.selectedGuildId,
      sensitiveInputProtectionEnabled: filterConfig.sensitiveInputProtectionEnabled,
      systemPrompt: effectiveEnv.AIRI_DISCORD_SYSTEM_PROMPT ?? '',
      sttApiBaseUrl: speechConfig.stt.baseURL ?? '',
      sttApiKeyConfigured: Boolean(speechConfig.stt.apiKey),
      sttModel: speechConfig.stt.model ?? 'whisper-1',
      ttsApiBaseUrl: speechConfig.tts.baseURL ?? '',
      ttsApiKeyConfigured: Boolean(speechConfig.tts.apiKey),
      ttsModel: speechConfig.tts.model,
      ttsVoice: speechConfig.tts.voice,
      voiceCallMode: qwenRealtimeConfig.mode,
      qwenRealtimeApiKeyConfigured: Boolean(qwenRealtimeConfig.apiKey),
      qwenRealtimeInterruptionSensitivity: qwenRealtimeConfig.interruptionSensitivity,
      qwenRealtimeModel: qwenRealtimeConfig.model,
      qwenRealtimeRegion: qwenRealtimeConfig.region,
      qwenRealtimeSilenceDurationMs: qwenRealtimeConfig.turnDebounceMs,
      qwenRealtimeVoice: qwenRealtimeConfig.voice,
      qwenRealtimeWorkspaceIdConfigured: Boolean(qwenRealtimeConfig.workspaceId),
      guildRulesText: rulesDraft.guildRulesText,
    }
  }

  async saveConfig(patch: StandaloneDashboardConfigPatch): Promise<StandaloneBotOperationResult> {
    if (this.pendingConfigSaveCount >= StandaloneDiscordAppController.pendingConfigSaveLimit) {
      this.state.recordEvent({ code: 'config-capacity', failureCategory: 'config-capacity' })
      throw new Error('Configuration save queue is full.')
    }

    const precedingSave = this.configSaveTail
    const currentSave = Promise.withResolvers<void>()
    this.pendingConfigSaveCount += 1
    this.configSaveTail = currentSave.promise

    try {
      await precedingSave
      return await this.persistConfigPatch(patch)
    }
    finally {
      this.pendingConfigSaveCount -= 1
      currentSave.resolve()
    }
  }

  private async persistConfigPatch(patch: StandaloneDashboardConfigPatch): Promise<StandaloneBotOperationResult> {
    const local = await readStandaloneEnvFileIfExists(this.envFilePath)
    const effectiveEnv = { ...this.env, ...local }
    const updates: StandaloneEnvValues = {}

    const writeExact = (key: string, value: string | undefined) => {
      if (value !== undefined)
        updates[key] = value
    }
    const writeTrimmed = (key: string, value: string | undefined) => {
      if (value !== undefined)
        updates[key] = value.trim()
    }
    const writeBoolean = (key: string, value: string | undefined) => {
      if (value !== undefined)
        updates[key] = StandaloneDiscordAppController.booleanPatch(value, undefined, 'false')
    }
    const writeSecret = (key: string, value: StandaloneSecretPatch | undefined) => {
      if (value === undefined || value.action === 'unchanged')
        return
      if (value.action === 'clear') {
        updates[key] = ''
        return
      }

      const normalized = value.value.trim()
      if (!normalized)
        throw new Error('Secret set actions require a non-empty value.')
      updates[key] = normalized
    }

    writeExact('AIRI_DISCORD_ALLOWED_CHANNEL_IDS', patch.allowedChannelIdsText)
    writeExact('AIRI_DISCORD_ADMIN_ROLE_IDS', patch.adminRoleIdsText)
    writeBoolean('AIRI_DISCORD_ALLOW_DIRECT_MESSAGES', patch.allowDirectMessages)
    writeBoolean('AIRI_DISCORD_AUDIT_LOG_ENABLED', patch.auditLogEnabled)
    writeExact('AIRI_DISCORD_BLOCKED_GUILD_IDS', patch.blockedGuildIdsText)
    writeExact('AIRI_DISCORD_BLOCKED_TERMS', patch.blockedTermsText)
    writeExact('AIRI_DISCORD_BLOCKED_USER_IDS', patch.blockedUserIdsText)
    writeBoolean('AIRI_DISCORD_DASHBOARD_RGB_ON', patch.dashboardRgbOn)
    writeTrimmed('AIRI_DISCORD_HISTORY_LIMIT', patch.historyLimit)
    writeBoolean('AIRI_DISCORD_MEMORY_AUTO_CAPTURE', patch.memoryAutoCaptureEnabled)
    writeBoolean('AIRI_DISCORD_MEMORY_ENABLED', patch.memoryEnabled)
    writeBoolean('AIRI_DISCORD_MEMORY_CONSENT_REQUIRED', patch.memoryConsentRequired)
    writeTrimmed('AIRI_DISCORD_MESSAGE_PACING_MS', patch.messagePacingMs)
    if (patch.modelRequestTimeoutMs !== undefined) {
      updates.AIRI_DISCORD_MODEL_TIMEOUT_MS = String(
        normalizeStandaloneModelRequestTimeout(patch.modelRequestTimeoutMs.trim()),
      )
    }
    writeBoolean('AIRI_DISCORD_PRIVACY_NOTICE_ENABLED', patch.privacyNoticeEnabled)
    writeExact('AIRI_DISCORD_PRIVACY_NOTICE_TEXT', patch.privacyNoticeText)
    writeBoolean('AIRI_DISCORD_PROMPT_ATTACK_PROTECTION_ENABLED', patch.promptAttackProtectionEnabled)
    writeTrimmed('AIRI_DISCORD_RATE_LIMIT_MAX_MESSAGES', patch.rateLimitMaxMessages)
    writeTrimmed('AIRI_DISCORD_RATE_LIMIT_WINDOW_MS', patch.rateLimitWindowMs)
    writeTrimmed('AIRI_DISCORD_SELECTED_CHANNEL_ID', patch.selectedChannelId)
    writeTrimmed('AIRI_DISCORD_SELECTED_GUILD_ID', patch.selectedGuildId)
    writeBoolean('AIRI_DISCORD_SENSITIVE_INPUT_PROTECTION_ENABLED', patch.sensitiveInputProtectionEnabled)
    writeExact('AIRI_DISCORD_SYSTEM_PROMPT', patch.systemPrompt)
    writeTrimmed('AIRI_DISCORD_VOICE_CALL_MODE', patch.voiceCallMode)
    writeTrimmed('DEEPSEEK_API_BASE_URL', patch.deepSeekApiBaseUrl)
    writeTrimmed('DEEPSEEK_MODEL', patch.deepSeekModel)
    writeTrimmed('OPENAI_STT_API_BASE_URL', patch.sttApiBaseUrl)
    writeTrimmed('OPENAI_STT_MODEL', patch.sttModel)
    writeTrimmed('OPENAI_TTS_API_BASE_URL', patch.ttsApiBaseUrl)
    writeTrimmed('OPENAI_TTS_MODEL', patch.ttsModel)
    writeTrimmed('OPENAI_TTS_VOICE', patch.ttsVoice)
    writeTrimmed('QWEN_REALTIME_MODEL', patch.qwenRealtimeModel)
    writeTrimmed('QWEN_REALTIME_INTERRUPTION_SENSITIVITY', patch.qwenRealtimeInterruptionSensitivity)
    writeTrimmed('QWEN_REALTIME_REGION', patch.qwenRealtimeRegion)
    writeTrimmed('QWEN_REALTIME_VAD_SILENCE_DURATION_MS', patch.qwenRealtimeSilenceDurationMs)
    writeTrimmed('QWEN_REALTIME_VOICE', patch.qwenRealtimeVoice)
    writeSecret('QWEN_REALTIME_WORKSPACE_ID', patch.qwenRealtimeWorkspaceId)

    writeSecret('DASHSCOPE_API_KEY', patch.qwenRealtimeApiKey)
    writeSecret('DEEPSEEK_API_KEY', patch.deepSeekApiKey)
    writeSecret('DISCORD_TOKEN', patch.discordToken)
    writeSecret('OPENAI_STT_API_KEY', patch.sttApiKey)
    writeSecret('OPENAI_TTS_API_KEY', patch.ttsApiKey)

    const characterFields: (keyof StandaloneCharacterCardPatch)[] = [
      'characterCardJson',
      'characterCreator',
      'characterDescription',
      'characterGreetingsText',
      'characterName',
      'characterNickname',
      'characterNotes',
      'characterPersonality',
      'characterPostHistoryInstructions',
      'characterScenario',
      'characterSystemPrompt',
      'characterVersion',
    ]
    if (characterFields.some(key => patch[key] !== undefined)) {
      const existingCharacterCard = parseStandaloneCharacterCardJson(effectiveEnv.AIRI_DISCORD_CHARACTER_CARD_JSON)
      updates.AIRI_DISCORD_CHARACTER_CARD_JSON = serializeStandaloneCharacterCard(
        updateStandaloneCharacterCard(existingCharacterCard, patch),
      )
    }

    if (patch.guildRulesText !== undefined || patch.channelRulesText !== undefined) {
      const existingRules = parseStandaloneDiscordRulesByGuildJson(effectiveEnv.AIRI_DISCORD_RULES_BY_GUILD_JSON)
      const nextRules = updateStandaloneDiscordRules(existingRules, {
        channelRulesText: patch.channelRulesText,
        guildRulesText: patch.guildRulesText,
        selectedChannelId: patch.selectedChannelId ?? effectiveEnv.AIRI_DISCORD_SELECTED_CHANNEL_ID,
        selectedGuildId: patch.selectedGuildId ?? effectiveEnv.AIRI_DISCORD_SELECTED_GUILD_ID,
      })
      updates.AIRI_DISCORD_RULES_BY_GUILD_JSON = serializeStandaloneDiscordRulesByGuild(nextRules)
    }

    if (Object.keys(updates).length > 0) {
      await writeStandaloneEnvValues(this.envFilePath, updates)
      this.state.recordEvent({ code: 'config-saved' })
    }

    const needsBotRestart = Object.keys(updates).some(key => key !== 'AIRI_DISCORD_DASHBOARD_RGB_ON')
    return {
      message: needsBotRestart
        ? '设置已保存。请在 dashboard 里重启 bot 以应用更改。'
        : '外观已保存。',
      ok: true,
    }
  }

  private startAdapter(generation: number): Promise<StandaloneBotOperationResult> {
    return (async (): Promise<StandaloneBotOperationResult> => {
      this.state.setBotStatus('starting')
      this.state.recordEvent({ code: 'bot-starting' })

      let adapter: StandaloneDiscordAdapter | undefined
      try {
        const effectiveEnv = await this.readEffectiveEnv()
        if (generation !== this.lifecycleGeneration) {
          return {
            message: 'Discord bot 启动已被停止请求取消。',
            ok: false,
          }
        }

        const filterConfig = this.createFilterConfig(effectiveEnv)
        const chatConfig = resolveStandaloneChatRuntimeConfig(effectiveEnv)
        const memoryStore = this.createMemoryStore(effectiveEnv, createStandaloneMemoryExtractor({
          apiKey: chatConfig.apiKey,
          baseURL: chatConfig.baseURL,
          model: chatConfig.model,
          timeoutMs: chatConfig.modelRequestTimeoutMs ?? normalizeStandaloneModelRequestTimeout(undefined),
        }, defaultStandaloneTextGenerator))
        const runtime = new StandaloneChatRuntime(chatConfig, undefined, memoryStore)
        const speechRuntime = new StandaloneSpeechRuntime(resolveStandaloneSpeechRuntimeConfig(effectiveEnv))
        const voiceCallRuntime = new QwenRealtimeRuntime(resolveQwenRealtimeConfig(effectiveEnv))
        adapter = new StandaloneDiscordAdapter({
          discordToken: effectiveEnv.DISCORD_TOKEN,
          events: this.createAdapterEvents(generation),
          filterConfig,
          memoryCommands: memoryStore,
          runtime,
          speechRuntime,
          voiceCallRuntime,
          voiceDiagnostics: this.createVoiceDiagnosticsObserver(generation),
        })
        // Publish ownership before the external login await. stopBot can now
        // invalidate and drain this exact adapter instead of observing "stopped"
        // while an unowned client continues connecting in the background.
        this.adapter = adapter
        await adapter.start()
        if (generation !== this.lifecycleGeneration || this.adapter !== adapter) {
          return {
            message: 'Discord bot 启动已被停止请求取消。',
            ok: false,
          }
        }
        return {
          message: 'Discord bot 已启动。',
          ok: true,
        }
      }
      catch {
        if (generation !== this.lifecycleGeneration || (adapter && this.adapter !== adapter)) {
          return {
            message: 'Discord bot 启动已被停止请求取消。',
            ok: false,
          }
        }

        let cleanupFailed = false
        if (adapter) {
          try {
            await adapter.stop()
          }
          catch {
            cleanupFailed = true
          }
        }
        if (this.adapter === adapter) {
          this.adapter = undefined
          if (cleanupFailed)
            this.retiringAdapter = adapter
        }
        const message = '启动独立 Discord bot 失败。请查看本地运行日志。'
        this.state.setBotStatus('error', 'bot-start-failure')
        this.state.recordEvent({ code: 'bot-start-failed', failureCategory: 'bot-start-failure' })
        return {
          message,
          ok: false,
        }
      }
    })()
  }

  private trackStartTask(
    task: Promise<StandaloneBotOperationResult>,
    generation: number,
  ): Promise<StandaloneBotOperationResult> {
    const trackedTask = task.finally(() => {
      if (this.startTask === trackedTask) {
        this.startTask = undefined
        this.startTaskGeneration = undefined
      }
    })
    this.startTask = trackedTask
    this.startTaskGeneration = generation
    return trackedTask
  }

  startBot(): Promise<StandaloneBotOperationResult> {
    if (this.stopTask) {
      // Multiple starts issued after the same stop share one latest running
      // intent. A start task from before stop has an older generation and must
      // not absorb the newer request.
      if (this.startTask && this.startTaskGeneration === this.lifecycleGeneration)
        return this.startTask

      const pendingStop = this.stopTask
      const generation = ++this.lifecycleGeneration
      return this.trackStartTask((async () => {
        const stopResult = await pendingStop
        if (!stopResult.ok)
          return stopResult
        if (generation !== this.lifecycleGeneration) {
          return {
            message: 'Discord bot 启动已被停止请求取消。',
            ok: false,
          }
        }

        return this.startAdapter(generation)
      })(), generation)
    }
    if (this.startTask)
      return this.startTask
    if (this.retiringAdapter) {
      const pendingStop = this.stopBot()
      const generation = ++this.lifecycleGeneration
      return this.trackStartTask((async () => {
        const stopResult = await pendingStop
        if (!stopResult.ok)
          return stopResult
        if (generation !== this.lifecycleGeneration) {
          return {
            message: 'Discord bot 启动已被停止请求取消。',
            ok: false,
          }
        }

        return this.startAdapter(generation)
      })(), generation)
    }
    if (this.adapter) {
      return Promise.resolve({
        message: 'Discord bot 已在运行。',
        ok: true,
      })
    }

    const generation = ++this.lifecycleGeneration
    return this.trackStartTask(this.startAdapter(generation), generation)
  }

  stopBot(): Promise<StandaloneBotOperationResult> {
    ++this.capabilityDiagnosticsGeneration
    this.state.cancelCapabilityDiagnostics()
    if (this.stopTask) {
      // A repeated explicit stop supersedes any restart waiting on this shared
      // cleanup without starting a second teardown.
      ++this.lifecycleGeneration
      this.state.finalizeVoiceDiagnostics('stopped')
      return this.stopTask
    }

    const adapter = this.adapter ?? this.retiringAdapter
    const pendingStart = this.startTask
    ++this.lifecycleGeneration
    this.state.finalizeVoiceDiagnostics('stopped')
    if (!adapter && !pendingStart) {
      this.state.setBotStatus('stopped')
      return Promise.resolve({
        message: 'Discord bot 没有运行。',
        ok: true,
      })
    }

    if (this.adapter === adapter) {
      this.adapter = undefined
      this.retiringAdapter = adapter
    }
    const task = (async (): Promise<StandaloneBotOperationResult> => {
      this.state.setBotStatus('stopping')
      const results = await Promise.allSettled([
        ...(adapter ? [adapter.stop()] : []),
        ...(pendingStart ? [pendingStart] : []),
      ])
      let failedOperationCount = 0
      for (const result of results) {
        if (result.status === 'rejected')
          failedOperationCount += 1
      }
      if (failedOperationCount > 0) {
        const message = '停止独立 Discord bot 失败。请查看本地运行日志。'
        this.state.setBotStatus('error', 'bot-stop-failure')
        this.state.recordEvent({ code: 'bot-stop-failed', failureCategory: 'bot-stop-failure' })
        return {
          message,
          ok: false,
        }
      }

      if (this.retiringAdapter === adapter)
        this.retiringAdapter = undefined
      this.state.setBotStatus('stopped')
      this.state.recordEvent({ code: 'bot-stopped' })
      return {
        message: 'Discord bot 已停止。',
        ok: true,
      }
    })()
    const trackedTask = task.finally(() => {
      if (this.stopTask === trackedTask)
        this.stopTask = undefined
    })
    this.stopTask = trackedTask
    return trackedTask
  }

  async restartBot(): Promise<StandaloneBotOperationResult> {
    const stopTask = this.stopBot()
    const restartGeneration = this.lifecycleGeneration
    const stopResult = await stopTask
    if (!stopResult.ok)
      return stopResult
    if (restartGeneration !== this.lifecycleGeneration) {
      return {
        message: 'Discord bot 重启已被后续停止请求取消。',
        ok: false,
      }
    }

    return this.startBot()
  }

  async getMemorySnapshot(): Promise<StandaloneMemorySnapshot> {
    const effectiveEnv = await this.readEffectiveEnv()
    const memoryStore = this.createMemoryStore(effectiveEnv)
    const memoryConfig = memoryStore.getConfig()
    return {
      config: {
        memoryAutoCaptureEnabled: memoryConfig.autoCaptureEnabled,
        memoryEnabled: memoryConfig.enabled,
        memoryFilePath: memoryConfig.filePath,
      },
      memories: await memoryStore.listMemories(),
    }
  }

  async addMemory(input: StandaloneMemoryInput): Promise<StandaloneBotOperationResult & { memory?: StandaloneMemoryEntry }> {
    try {
      const memoryStore = this.createMemoryStore(await this.readEffectiveEnv())
      const memory = await memoryStore.addMemory(input)
      this.state.recordEvent({ code: 'memory-saved' })
      return {
        memory,
        message: '记忆卡已保存。',
        ok: true,
      }
    }
    catch {
      const message = '保存记忆卡失败。'
      this.state.recordEvent({ code: 'memory-save-failed', failureCategory: 'memory-save-failure' })
      return {
        message,
        ok: false,
      }
    }
  }

  async deleteMemory(id: string): Promise<StandaloneBotOperationResult> {
    const memoryStore = this.createMemoryStore(await this.readEffectiveEnv())
    const deleted = await memoryStore.deleteMemory(id)
    this.state.recordEvent({ code: deleted ? 'memory-deleted' : 'memory-missing' })
    return {
      message: deleted ? '记忆卡已删除。' : '没有找到这张记忆卡。',
      ok: deleted,
    }
  }

  async clearMemory(): Promise<StandaloneBotOperationResult> {
    const memoryStore = this.createMemoryStore(await this.readEffectiveEnv())
    await memoryStore.clearMemories()
    this.state.recordEvent({ code: 'memory-cleared' })
    return {
      message: '记忆卡已清空。',
      ok: true,
    }
  }

  getSnapshot() {
    return this.state.getSnapshot()
  }

  /** Starts the single bounded production capability diagnostic using only public readiness booleans. */
  async startCapabilityDiagnostics(): Promise<{ marker: string } | undefined> {
    const generation = ++this.capabilityDiagnosticsGeneration
    const config = await this.getPublicConfig()
    if (generation !== this.capabilityDiagnosticsGeneration)
      return undefined
    const voiceProviderConfigured = config.voiceCallMode === 'qwen-realtime'
      ? config.qwenRealtimeApiKeyConfigured && config.qwenRealtimeWorkspaceIdConfigured
      : config.sttApiKeyConfigured && config.ttsApiKeyConfigured
    return this.state.startCapabilityDiagnostics({
      discordConfigured: config.discordTokenConfigured,
      productVersion: this.env.npm_package_version?.trim() || 'unknown',
      providerConfigured: config.deepSeekApiKeyConfigured && voiceProviderConfigured,
    })
  }

  /** Applies an allowlisted user confirmation to the active capability diagnostic. */
  confirmCapabilityDiagnostics(action: 'text-reply-correct' | 'voice-consent-join' | 'voice-heard'): boolean {
    return this.state.confirmCapabilityDiagnostics(action)
  }

  /** Cancels the active capability diagnostic without affecting the Discord bot lifecycle. */
  cancelCapabilityDiagnostics(): void {
    ++this.capabilityDiagnosticsGeneration
    this.state.cancelCapabilityDiagnostics()
  }
}
