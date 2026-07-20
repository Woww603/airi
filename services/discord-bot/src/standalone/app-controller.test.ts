import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { StandaloneDiscordAppController } from './app-controller'
import { StandaloneDashboardState } from './dashboard-state'
import { parseStandaloneEnvFile } from './env-file'

/**
 * @example
 * describe('standalone Discord app controller', () => {})
 */
describe('standalone Discord app controller', () => {
  /**
   * @example
   * it('keeps the Qwen Workspace ID out of public snapshots for R-003', async () => {})
   */
  it('keeps the Qwen Workspace ID out of public snapshots for R-003', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'airi-discord-controller-'))
    const envPath = join(dir, '.env.local')
    const workspaceSentinel = 'synthetic-workspace-sensitive-sentinel'

    try {
      const controller = new StandaloneDiscordAppController({
        env: {
          QWEN_REALTIME_WORKSPACE_ID: workspaceSentinel,
        },
        envFilePath: envPath,
        state: new StandaloneDashboardState(),
      })

      // ROOT CAUSE:
      //
      // The public config projection returned the complete Workspace ID even
      // though the Dashboard only needs to know whether one is configured. The
      // generated page then copied that value into a normal text input and its
      // endpoint preview, making a saved identifier recoverable from the DOM.
      //
      // The fixed projection exposes only a configured boolean. Sparse unrelated
      // saves preserve the effective value without ever serializing it publicly.
      const initialConfig = await controller.getPublicConfig()
      await controller.saveConfig({ dashboardRgbOn: 'true' })
      const configAfterUnrelatedSave = await controller.getPublicConfig()

      // @example
      expect(initialConfig.qwenRealtimeWorkspaceIdConfigured).toBe(true)
      // @example
      expect(JSON.stringify(initialConfig)).not.toContain(workspaceSentinel)
      // @example
      expect(configAfterUnrelatedSave.qwenRealtimeWorkspaceIdConfigured).toBe(true)
      // @example
      expect(JSON.stringify(configAfterUnrelatedSave)).not.toContain(workspaceSentinel)
    }
    finally {
      await rm(dir, { force: true, recursive: true })
    }
  })

  /**
   * @example
   * it('saves dashboard config without clearing secrets marked unchanged', async () => {})
   */
  it('saves dashboard config without clearing secrets marked unchanged', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'airi-discord-controller-'))
    const envPath = join(dir, '.env.local')

    try {
      await writeFile(envPath, [
        'DISCORD_TOKEN=\'discord-token\'',
        'DEEPSEEK_API_KEY=\'deepseek-key\'',
        'DEEPSEEK_MODEL=\'deepseek-v4-flash\'',
        'OPENAI_STT_API_KEY=\'stt-key\'',
        'OPENAI_TTS_API_KEY=\'tts-key\'',
        'DASHSCOPE_API_KEY=\'dashscope-secret\'',
      ].join('\n'))

      const controller = new StandaloneDiscordAppController({
        env: {},
        envFilePath: envPath,
        state: new StandaloneDashboardState(),
      })

      const result = await controller.saveConfig({
        allowedChannelIdsText: 'channel-1\nchannel-2',
        adminRoleIdsText: 'role-1\nrole-2',
        allowDirectMessages: 'false',
        auditLogEnabled: 'false',
        blockedTermsText: 'spam phrase',
        characterDescription: 'A standalone character.',
        characterName: 'mika',
        characterPersonality: 'Calm and direct.',
        characterPostHistoryInstructions: 'Keep the Discord scope isolated.',
        characterScenario: 'Discord-only companion.',
        characterSystemPrompt: 'You are mika.',
        characterVersion: '2.0.0',
        channelRulesText: 'Channel-specific rule',
        deepSeekApiBaseUrl: '',
        deepSeekApiKey: { action: 'unchanged' },
        deepSeekModel: 'deepseek-v4-pro',
        discordToken: { action: 'unchanged' },
        guildRulesText: 'Guild-wide rule',
        historyLimit: '48',
        memoryConsentRequired: 'true',
        messagePacingMs: '1200',
        modelRequestTimeoutMs: '120000',
        promptAttackProtectionEnabled: 'false',
        rateLimitMaxMessages: '3',
        rateLimitWindowMs: '9000',
        selectedChannelId: 'channel-1',
        selectedGuildId: 'guild-1',
        sensitiveInputProtectionEnabled: 'false',
        sttApiBaseUrl: 'https://speech.example/v1',
        sttApiKey: { action: 'unchanged' },
        sttModel: 'whisper-large-v3',
        systemPrompt: 'AIRI from dashboard',
        ttsApiBaseUrl: 'https://speech.example/v1',
        ttsApiKey: { action: 'unchanged' },
        ttsModel: 'tts-model',
        ttsVoice: 'airi-voice',
        voiceCallMode: 'qwen-realtime',
        qwenRealtimeApiKey: { action: 'unchanged' },
        qwenRealtimeInterruptionSensitivity: '25',
        qwenRealtimeModel: 'qwen3.5-omni-flash-realtime',
        qwenRealtimeRegion: 'singapore',
        qwenRealtimeSilenceDurationMs: '600',
        qwenRealtimeVoice: 'Ethan',
        qwenRealtimeWorkspaceId: { action: 'set', value: 'ws-airi-123' },
      })
      const source = await readFile(envPath, 'utf-8')
      const config = await controller.getPublicConfig()

      /**
       * @example
       * expect(result.ok).toBe(true)
       */
      expect(result.ok).toBe(true)
      /**
       * @example
       * expect(source).toContain("DISCORD_TOKEN='discord-token'")
       */
      expect(source).toContain('DISCORD_TOKEN=\'discord-token\'')
      /**
       * @example
       * expect(source).toContain("DEEPSEEK_API_KEY='deepseek-key'")
       */
      expect(source).toContain('DEEPSEEK_API_KEY=\'deepseek-key\'')
      expect(source).toContain('OPENAI_STT_API_KEY=\'stt-key\'')
      expect(source).toContain('OPENAI_TTS_API_KEY=\'tts-key\'')
      expect(source).toContain('DASHSCOPE_API_KEY=\'dashscope-secret\'')
      /**
       * @example
       * expect(config.deepSeekModel).toBe('deepseek-v4-pro')
       */
      expect(config.deepSeekModel).toBe('deepseek-v4-pro')
      /**
       * @example
       * expect(config.historyLimit).toBe(48)
       */
      expect(config.historyLimit).toBe(48)
      /**
       * @example
       * expect(config.allowedChannelIdsText).toBe('channel-1\nchannel-2')
       */
      expect(config.allowedChannelIdsText).toBe('channel-1\nchannel-2')
      /**
       * @example
       * expect(config.adminRoleIdsText).toBe('role-1\nrole-2')
       */
      expect(config.adminRoleIdsText).toBe('role-1\nrole-2')
      /**
       * @example
       * expect(config.allowDirectMessages).toBe(false)
       */
      expect(config.allowDirectMessages).toBe(false)
      /**
       * @example
       * expect(config.auditLogEnabled).toBe(false)
       */
      expect(config.auditLogEnabled).toBe(false)
      /**
       * @example
       * expect(config.blockedTermsText).toBe('spam phrase')
       */
      expect(config.blockedTermsText).toBe('spam phrase')
      /**
       * @example
       * expect(config.channelRulesText).toBe('Channel-specific rule')
       */
      expect(config.channelRulesText).toBe('Channel-specific rule')
      /**
       * @example
       * expect(config.characterCard.name).toBe('mika')
       */
      expect(config.characterCard.name).toBe('mika')
      /**
       * @example
       * expect(config.characterCard.systemPrompt).toBe('You are mika.')
       */
      expect(config.characterCard.systemPrompt).toBe('You are mika.')
      /**
       * @example
       * expect(config.guildRulesText).toBe('Guild-wide rule')
       */
      expect(config.guildRulesText).toBe('Guild-wide rule')
      /**
       * @example
       * expect(config.messagePacingMs).toBe(1200)
       */
      expect(config.messagePacingMs).toBe(1200)
      expect(config.modelRequestTimeoutMs).toBe(120000)
      /**
       * @example
       * expect(config.memoryConsentRequired).toBe(true)
       */
      expect(config.memoryConsentRequired).toBe(true)
      /**
       * @example
       * expect(config.promptAttackProtectionEnabled).toBe(false)
       */
      expect(config.promptAttackProtectionEnabled).toBe(false)
      /**
       * @example
       * expect(config.sensitiveInputProtectionEnabled).toBe(false)
       */
      expect(config.sensitiveInputProtectionEnabled).toBe(false)
      /**
       * @example
       * expect(config.rateLimitMaxMessages).toBe(3)
       */
      expect(config.rateLimitMaxMessages).toBe(3)
      /**
       * @example
       * expect(config.rateLimitWindowMs).toBe(9000)
       */
      expect(config.rateLimitWindowMs).toBe(9000)
      /**
       * @example
       * expect(config.discordTokenConfigured).toBe(true)
       */
      expect(config.discordTokenConfigured).toBe(true)
      /**
       * @example
       * expect(config.deepSeekApiKeyConfigured).toBe(true)
       */
      expect(config.deepSeekApiKeyConfigured).toBe(true)
      expect(config.sttApiKeyConfigured).toBe(true)
      expect(config.sttApiBaseUrl).toBe('https://speech.example/v1')
      expect(config.sttModel).toBe('whisper-large-v3')
      expect(config.ttsApiKeyConfigured).toBe(true)
      expect(config.ttsApiBaseUrl).toBe('https://speech.example/v1')
      expect(config.ttsModel).toBe('tts-model')
      expect(config.ttsVoice).toBe('airi-voice')
      expect(config.voiceCallMode).toBe('qwen-realtime')
      expect(config.qwenRealtimeApiKeyConfigured).toBe(true)
      expect(config.qwenRealtimeRegion).toBe('singapore')
      expect(config.qwenRealtimeWorkspaceIdConfigured).toBe(true)
      expect(JSON.stringify(config)).not.toContain('ws-airi-123')
      expect(config.qwenRealtimeModel).toBe('qwen3.5-omni-flash-realtime')
      expect(config.qwenRealtimeVoice).toBe('Ethan')
      expect(config.qwenRealtimeSilenceDurationMs).toBe(600)
      expect(config.qwenRealtimeInterruptionSensitivity).toBe(25)
      expect(source).toContain('QWEN_REALTIME_INTERRUPTION_SENSITIVITY=\'25\'')
      expect(source).toContain('QWEN_REALTIME_VAD_SILENCE_DURATION_MS=\'600\'')
      /**
       * @example
       * expect(config.selectedChannelId).toBe('channel-1')
       */
      expect(config.selectedChannelId).toBe('channel-1')
      /**
       * @example
       * expect(config.selectedGuildId).toBe('guild-1')
       */
      expect(config.selectedGuildId).toBe('guild-1')
      /**
       * @example
       * expect(source).toContain("AIRI_DISCORD_MEMORY_CONSENT_REQUIRED='true'")
       */
      expect(source).toContain('AIRI_DISCORD_MEMORY_CONSENT_REQUIRED=\'true\'')
      /**
       * @example
       * expect(source).toContain("AIRI_DISCORD_AUDIT_LOG_ENABLED='false'")
       */
      expect(source).toContain('AIRI_DISCORD_AUDIT_LOG_ENABLED=\'false\'')
      expect(source).toContain('AIRI_DISCORD_MODEL_TIMEOUT_MS=\'120000\'')
      /**
       * @example
       * expect(source).toContain("AIRI_DISCORD_PROMPT_ATTACK_PROTECTION_ENABLED='false'")
       */
      expect(source).toContain('AIRI_DISCORD_PROMPT_ATTACK_PROTECTION_ENABLED=\'false\'')
      /**
       * @example
       * expect(source).toContain("AIRI_DISCORD_SENSITIVE_INPUT_PROTECTION_ENABLED='false'")
       */
      expect(source).toContain('AIRI_DISCORD_SENSITIVE_INPUT_PROTECTION_ENABLED=\'false\'')
      /**
       * @example
       * expect(source).toContain('AIRI_DISCORD_CHARACTER_CARD_JSON=')
       */
      expect(source).toContain('AIRI_DISCORD_CHARACTER_CARD_JSON=')
      /**
       * @example
       * expect(source).toContain('AIRI_DISCORD_RULES_BY_GUILD_JSON=')
       */
      expect(source).toContain('AIRI_DISCORD_RULES_BY_GUILD_JSON=')
    }
    finally {
      await rm(dir, { force: true, recursive: true })
    }
  })

  /**
   * @example
   * it('saves RGB ON appearance without requiring a bot restart', async () => {})
   */
  it('saves RGB ON appearance without requiring a bot restart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'airi-discord-controller-'))
    const envPath = join(dir, '.env.local')

    try {
      const controller = new StandaloneDiscordAppController({
        env: {},
        envFilePath: envPath,
        state: new StandaloneDashboardState(),
      })

      const result = await controller.saveConfig({
        dashboardRgbOn: 'true',
      })
      const source = await readFile(envPath, 'utf-8')
      const config = await controller.getPublicConfig()

      /**
       * @example
       * expect(result.message).toBe('外观已保存。')
       */
      expect(result.message).toBe('外观已保存。')
      /**
       * @example
       * expect(source).toContain("AIRI_DISCORD_DASHBOARD_RGB_ON='true'")
       */
      expect(source).toContain('AIRI_DISCORD_DASHBOARD_RGB_ON=\'true\'')
      /**
       * @example
       * expect(config.dashboardRgbOn).toBe(true)
       */
      expect(config.dashboardRgbOn).toBe(true)
    }
    finally {
      await rm(dir, { force: true, recursive: true })
    }
  })

  /**
   * @example
   * An RGB-only dashboard patch writes one local override and leaves inherited process configuration effective.
   */
  it('preserves inherited secrets and policy when saving only RGB appearance (Discord audit D-006)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'airi-discord-controller-'))
    const envPath = join(dir, '.env.local')

    try {
      const controller = new StandaloneDiscordAppController({
        env: {
          AIRI_DISCORD_ALLOWED_CHANNEL_IDS: 'channel-sentinel',
          AIRI_DISCORD_ALLOW_DIRECT_MESSAGES: 'false',
          AIRI_DISCORD_PRIVACY_NOTICE_ENABLED: 'false',
          AIRI_DISCORD_PROMPT_ATTACK_PROTECTION_ENABLED: 'false',
          AIRI_DISCORD_SENSITIVE_INPUT_PROTECTION_ENABLED: 'false',
          DEEPSEEK_API_KEY: 'deepseek-synthetic-sentinel',
          DISCORD_TOKEN: 'discord-synthetic-sentinel',
        },
        envFilePath: envPath,
        state: new StandaloneDashboardState(),
      })

      // ROOT CAUSE:
      //
      // saveConfig currently builds a complete update object from only the local
      // env file. When that file does not exist, an RGB-only save materializes
      // empty secrets and default policy values that override inherited process env.
      //
      // The fixed controller writes only fields explicitly present in the patch and
      // resolves any necessary fallback from the effective process-plus-local env.
      const result = await controller.saveConfig({
        dashboardRgbOn: 'true',
      })
      const localValues = parseStandaloneEnvFile(await readFile(envPath, 'utf-8'))
      const config = await controller.getPublicConfig()

      // @example
      expect(result.message).toBe('外观已保存。')
      // @example
      expect(localValues).toEqual({
        AIRI_DISCORD_DASHBOARD_RGB_ON: 'true',
      })
      // @example
      expect(config.discordTokenConfigured).toBe(true)
      // @example
      expect(config.deepSeekApiKeyConfigured).toBe(true)
      // @example
      expect(config.allowedChannelIdsText).toBe('channel-sentinel')
      // @example
      expect(config.allowDirectMessages).toBe(false)
      // @example
      expect(config.privacyNoticeEnabled).toBe(false)
      // @example
      expect(config.promptAttackProtectionEnabled).toBe(false)
      // @example
      expect(config.sensitiveInputProtectionEnabled).toBe(false)
    }
    finally {
      await rm(dir, { force: true, recursive: true })
    }
  })

  /**
   * @example
   * Explicit secret actions clear, replace, or preserve their independent local values.
   */
  it('applies explicit secret mutations independently (Discord audit D-006)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'airi-discord-controller-'))
    const envPath = join(dir, '.env.local')

    try {
      await writeFile(envPath, [
        'DEEPSEEK_API_KEY=\'deepseek-old\'',
        'DISCORD_TOKEN=\'discord-old\'',
        'OPENAI_STT_API_KEY=\'stt-old\'',
      ].join('\n'))
      const controller = new StandaloneDiscordAppController({
        env: {},
        envFilePath: envPath,
        state: new StandaloneDashboardState(),
      })

      // ROOT CAUSE:
      //
      // Raw password strings made an empty value ambiguous: it could not safely
      // mean both "preserve" and "clear". Each secret now carries an explicit
      // mutation, and sparse writes leave unrelated keys untouched.
      await controller.saveConfig({
        deepSeekApiKey: { action: 'set', value: ' deepseek-new ' },
        discordToken: { action: 'clear' },
        sttApiKey: { action: 'unchanged' },
      })
      const localValues = parseStandaloneEnvFile(await readFile(envPath, 'utf-8'))

      // @example
      expect(localValues.DISCORD_TOKEN).toBe('')
      // @example
      expect(localValues.DEEPSEEK_API_KEY).toBe('deepseek-new')
      // @example
      expect(localValues.OPENAI_STT_API_KEY).toBe('stt-old')
      // @example
      expect(Object.keys(localValues).sort()).toEqual([
        'DEEPSEEK_API_KEY',
        'DISCORD_TOKEN',
        'OPENAI_STT_API_KEY',
      ])
    }
    finally {
      await rm(dir, { force: true, recursive: true })
    }
  })

  /**
   * @example
   * it('applies unchanged, set, and clear Workspace ID mutations without public recovery for R-003', async () => {})
   */
  it('applies unchanged, set, and clear Workspace ID mutations without public recovery for R-003', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'airi-discord-controller-'))
    const envPath = join(dir, '.env.local')
    const inheritedSentinel = 'synthetic-inherited-workspace-sentinel'
    const replacementSentinel = 'synthetic-replacement-workspace-sentinel'
    const state = new StandaloneDashboardState()

    try {
      const controller = new StandaloneDiscordAppController({
        env: { QWEN_REALTIME_WORKSPACE_ID: inheritedSentinel },
        envFilePath: envPath,
        state,
      })

      await controller.saveConfig({ dashboardRgbOn: 'true' })
      let localValues = parseStandaloneEnvFile(await readFile(envPath, 'utf-8'))
      let publicConfig = await controller.getPublicConfig()

      // ROOT CAUSE:
      //
      // Workspace updates used a raw optional string, so an empty Dashboard
      // input could not distinguish preserve from clear. The page worked around
      // that ambiguity by refilling the exact saved value from the public API.
      //
      // The same explicit unchanged/set/clear mutation contract used for API
      // keys now keeps public reads value-free while supporting sparse saves.
      // @example
      expect(localValues).not.toHaveProperty('QWEN_REALTIME_WORKSPACE_ID')
      // @example
      expect(publicConfig.qwenRealtimeWorkspaceIdConfigured).toBe(true)

      await controller.saveConfig({
        qwenRealtimeWorkspaceId: { action: 'set', value: ` ${replacementSentinel} ` },
      })
      localValues = parseStandaloneEnvFile(await readFile(envPath, 'utf-8'))
      publicConfig = await controller.getPublicConfig()

      // @example
      expect(localValues.QWEN_REALTIME_WORKSPACE_ID).toBe(replacementSentinel)
      // @example
      expect(publicConfig.qwenRealtimeWorkspaceIdConfigured).toBe(true)

      await controller.saveConfig({
        qwenRealtimeWorkspaceId: { action: 'clear' },
      })
      localValues = parseStandaloneEnvFile(await readFile(envPath, 'utf-8'))
      publicConfig = await controller.getPublicConfig()

      // @example
      expect(localValues.QWEN_REALTIME_WORKSPACE_ID).toBe('')
      // @example
      expect(publicConfig.qwenRealtimeWorkspaceIdConfigured).toBe(false)
      // @example
      expect(JSON.stringify({ publicConfig, state: state.getSnapshot() })).not.toContain(inheritedSentinel)
      // @example
      expect(JSON.stringify({ publicConfig, state: state.getSnapshot() })).not.toContain(replacementSentinel)
    }
    finally {
      await rm(dir, { force: true, recursive: true })
    }
  })

  /**
   * @example
   * Concurrent dashboard forms preserve both successful config saves.
   */
  it('serializes concurrent form saves without losing either update (Discord audit D-020)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'airi-discord-controller-'))
    const envPath = join(dir, '.env.local')

    try {
      await writeFile(envPath, 'AIRI_DISCORD_SYSTEM_PROMPT=\'existing-sentinel\'\n')
      const controller = new StandaloneDiscordAppController({
        env: {},
        envFilePath: envPath,
        state: new StandaloneDashboardState(),
      })

      // ROOT CAUSE:
      //
      // Each saveConfig() independently read the dotenv file before
      // writeStandaloneEnvValues() performed another read-modify-write. Two forms
      // saving concurrently could therefore both report success after writing
      // snapshots derived from the same baseline, with the last write dropping the
      // other form's update.
      //
      // The controller now serializes the complete config transaction so every
      // update reads the file produced by the prior successful save.
      const [filterResult, rulesResult] = await Promise.all([
        controller.saveConfig({
          allowedChannelIdsText: 'channel-filter-sentinel',
        }),
        controller.saveConfig({
          guildRulesText: 'guild-rules-sentinel',
          selectedGuildId: 'guild-sentinel',
        }),
      ])
      const localValues = parseStandaloneEnvFile(await readFile(envPath, 'utf-8'))

      // @example
      expect(filterResult.ok).toBe(true)
      // @example
      expect(rulesResult.ok).toBe(true)
      // @example
      expect(localValues.AIRI_DISCORD_ALLOWED_CHANNEL_IDS).toBe('channel-filter-sentinel')
      // @example
      expect(localValues.AIRI_DISCORD_SELECTED_GUILD_ID).toBe('guild-sentinel')
      // @example
      expect(localValues.AIRI_DISCORD_RULES_BY_GUILD_JSON).toContain('guild-rules-sentinel')
      // @example
      expect(localValues.AIRI_DISCORD_SYSTEM_PROMPT).toBe('existing-sentinel')

      const rejectedSave = controller.saveConfig({
        deepSeekApiKey: { action: 'set', value: '   ' },
      })
      const recoverySave = controller.saveConfig({
        blockedTermsText: 'recovery-sentinel',
      })

      // @example
      await expect(rejectedSave).rejects.toThrow('Secret set actions require a non-empty value.')
      // @example
      await expect(recoverySave).resolves.toMatchObject({ ok: true })
      const recoveredValues = parseStandaloneEnvFile(await readFile(envPath, 'utf-8'))
      // @example
      expect(recoveredValues.AIRI_DISCORD_BLOCKED_TERMS).toBe('recovery-sentinel')
      // @example
      expect(recoveredValues.AIRI_DISCORD_ALLOWED_CHANNEL_IDS).toBe('channel-filter-sentinel')
    }
    finally {
      await rm(dir, { force: true, recursive: true })
    }
  })

  /**
   * @example
   * Excess concurrent saves fail closed without disturbing the bounded queue.
   */
  it('hard-caps pending config saves and recovers released capacity (Discord audit D-020)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'airi-discord-controller-'))
    const envPath = join(dir, '.env.local')

    try {
      const controller = new StandaloneDiscordAppController({
        env: {},
        envFilePath: envPath,
        state: new StandaloneDashboardState(),
      })

      // ROOT CAUSE:
      //
      // Serializing saveConfig() fixed lost updates, but every concurrent caller
      // still received a promise chained behind the active disk operation. Multiple
      // tabs or direct authenticated local API calls could therefore retain an
      // unbounded queue even though one dashboard page limits its own requests.
      //
      // The controller now owns a hard cap across active and queued saves, rejects
      // excess work observably, and releases every admitted slot in finally.
      const admittedSaves = Array.from({ length: 16 }, (_, index) => {
        if (index === 0) {
          return controller.saveConfig({
            deepSeekApiKey: { action: 'set', value: '   ' },
          })
        }

        return controller.saveConfig({
          systemPrompt: `ordered-sentinel-${index}`,
        })
      })
      const admittedSettlements = Promise.allSettled(admittedSaves)
      const overloadedSave = controller.saveConfig({
        systemPrompt: 'overload-must-not-write',
      })

      // @example
      await expect(overloadedSave).rejects.toThrow('Configuration save queue is full.')
      const settlements = await admittedSettlements
      // @example
      expect(settlements.filter(result => result.status === 'fulfilled')).toHaveLength(15)
      // @example
      expect(settlements.filter(result => result.status === 'rejected')).toHaveLength(1)
      const orderedValues = parseStandaloneEnvFile(await readFile(envPath, 'utf-8'))
      // @example
      expect(orderedValues.AIRI_DISCORD_SYSTEM_PROMPT).toBe('ordered-sentinel-15')

      const recoverySaves = Array.from({ length: 16 }, (_, index) => controller.saveConfig({
        blockedTermsText: `capacity-recovery-sentinel-${index}`,
      }))
      // @example
      await expect(Promise.all(recoverySaves)).resolves.toHaveLength(16)
      const recoveredValues = parseStandaloneEnvFile(await readFile(envPath, 'utf-8'))
      // @example
      expect(recoveredValues.AIRI_DISCORD_BLOCKED_TERMS).toBe('capacity-recovery-sentinel-15')
      // @example
      expect(recoveredValues.AIRI_DISCORD_SYSTEM_PROMPT).toBe('ordered-sentinel-15')
    }
    finally {
      await rm(dir, { force: true, recursive: true })
    }
  })
})
