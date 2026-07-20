import { beforeEach, describe, expect, it, vi } from 'vitest'

import { DiscordAdapter } from './airi-adapter'

interface SyntheticServerChannelOptions {
  onError?: (error: Error) => void
}

const securityMocks = vi.hoisted(() => {
  const logger = {
    error: vi.fn(),
    log: vi.fn(),
    useGlobalConfig: vi.fn(),
    warn: vi.fn(),
    withError: vi.fn(),
    withField: vi.fn(),
    withFields: vi.fn(),
  }
  logger.useGlobalConfig.mockReturnValue(logger)
  logger.withError.mockReturnValue(logger)
  logger.withField.mockReturnValue(logger)
  logger.withFields.mockReturnValue(logger)

  return {
    airiClose: vi.fn(),
    airiHandlers: new Map<string, (event: { data: Record<string, unknown> }) => unknown>(),
    airiSend: vi.fn(() => true),
    channelFetch: vi.fn(async () => ({
      isTextBased: () => true,
      send: vi.fn(async () => undefined),
    })),
    discordDestroy: vi.fn(async () => undefined),
    discordHandlers: new Map<string, (...args: unknown[]) => unknown>(),
    discordLogin: vi.fn(async () => undefined),
    logger,
    registerCommands: vi.fn(async () => undefined),
    serverChannelOptions: [] as SyntheticServerChannelOptions[],
    userFetch: vi.fn(async () => ({ send: vi.fn(async () => undefined) })),
    voiceRevalidate: vi.fn(),
    voiceStateUpdate: vi.fn(async () => undefined),
    voiceStop: vi.fn(async () => undefined),
  }
})

vi.mock('@guiiai/logg', () => ({
  useLogg: vi.fn(() => securityMocks.logger),
}))

vi.mock('@proj-airi/server-sdk', () => ({
  Client: class {
    close = securityMocks.airiClose
    send = securityMocks.airiSend

    constructor(options: SyntheticServerChannelOptions) {
      securityMocks.serverChannelOptions.push(options)
    }

    onEvent(type: string, callback: (event: { data: Record<string, unknown> }) => unknown) {
      securityMocks.airiHandlers.set(type, callback)
      return () => securityMocks.airiHandlers.delete(type)
    }
  },
}))

vi.mock('discord.js', () => ({
  Client: class {
    channels = { fetch: securityMocks.channelFetch }
    ready = false
    user = { id: 'synthetic-application' }
    users = { fetch: securityMocks.userFetch }

    async destroy() {
      this.ready = false
      await securityMocks.discordDestroy()
    }

    isReady() {
      return this.ready
    }

    async login() {
      await securityMocks.discordLogin()
      this.ready = true
    }

    on(type: string, callback: (...args: unknown[]) => unknown) {
      securityMocks.discordHandlers.set(type, callback)
      return this
    }

    once(type: string, callback: (...args: unknown[]) => unknown) {
      securityMocks.discordHandlers.set(type, callback)
      return this
    }

    removeAllListeners(type: string) {
      securityMocks.discordHandlers.delete(type)
      return this
    }
  },
  Events: {
    ClientReady: 'client-ready',
    InteractionCreate: 'interaction-create',
    MessageCreate: 'message-create',
    Raw: 'raw',
    ShardDisconnect: 'shard-disconnect',
    ShardReady: 'shard-ready',
    VoiceStateUpdate: 'voice-state-update',
  },
  GatewayIntentBits: {
    DirectMessages: 1,
    GuildMessages: 2,
    GuildVoiceStates: 4,
    Guilds: 8,
    MessageContent: 16,
  },
  MessageReferenceType: {
    Default: 0,
    Forward: 1,
  },
  MessageType: {
    Default: 0,
    Reply: 19,
  },
  Partials: {
    Channel: 1,
    Message: 2,
    User: 3,
  },
}))

vi.mock('../bots/discord/commands', () => ({
  handlePing: vi.fn(),
  registerCommands: securityMocks.registerCommands,
  VoiceManager: class {
    handleConsentInteraction = vi.fn()
    handleJoinChannelCommand = vi.fn()
    handleLeaveChannelCommand = vi.fn()
    handleVoiceStateUpdate = securityMocks.voiceStateUpdate
    revalidateSpeakerAdmissions = securityMocks.voiceRevalidate
    stop = securityMocks.voiceStop
  },
}))

vi.mock('../pipelines/openai-speech', () => ({
  describeOpenAICompatibleProvider: vi.fn(() => 'synthetic speech provider'),
  transcribeOpenAICompatible: vi.fn(),
}))

function serializedLogBoundary(): string {
  return JSON.stringify({
    console: securityMocks.logger.error.mock.calls,
    error: securityMocks.logger.error.mock.calls,
    log: securityMocks.logger.log.mock.calls,
    warn: securityMocks.logger.warn.mock.calls,
    withError: securityMocks.logger.withError.mock.calls,
    withField: securityMocks.logger.withField.mock.calls,
    withFields: securityMocks.logger.withFields.mock.calls,
  })
}

beforeEach(() => {
  vi.useRealTimers()
  securityMocks.airiClose.mockClear()
  securityMocks.airiHandlers.clear()
  securityMocks.airiSend.mockReset()
  securityMocks.airiSend.mockReturnValue(true)
  securityMocks.channelFetch.mockReset()
  securityMocks.channelFetch.mockResolvedValue({
    isTextBased: () => true,
    send: vi.fn(async () => undefined),
  })
  securityMocks.discordDestroy.mockClear()
  securityMocks.discordHandlers.clear()
  securityMocks.discordLogin.mockClear()
  securityMocks.logger.error.mockClear()
  securityMocks.logger.log.mockClear()
  securityMocks.logger.warn.mockClear()
  securityMocks.logger.withError.mockClear()
  securityMocks.logger.withField.mockClear()
  securityMocks.logger.withFields.mockClear()
  securityMocks.registerCommands.mockClear()
  securityMocks.serverChannelOptions.length = 0
  securityMocks.userFetch.mockReset()
  securityMocks.userFetch.mockResolvedValue({ send: vi.fn(async () => undefined) })
  securityMocks.voiceRevalidate.mockClear()
  securityMocks.voiceStateUpdate.mockReset()
  securityMocks.voiceStateUpdate.mockResolvedValue(undefined)
  securityMocks.voiceStop.mockReset()
  securityMocks.voiceStop.mockResolvedValue(undefined)
})

/**
 * @example
 * describe('bridge logging security', () => {})
 */
describe('bridge logging security', () => {
  /**
   * @example
   * it('runtime-projects audit observations without Discord identifiers for P1-B', () => {})
   */
  it('runtime-projects audit observations without Discord identifiers for P1-B', () => {
    const adapter = new DiscordAdapter({})

    // ROOT CAUSE:
    //
    // The bridge audit sink spread every caller-owned field into Logg. Discord
    // ids, session/turn correlations, names, URLs, and raw error objects therefore
    // crossed the process log boundary even though callers only needed a fixed
    // event/reason plus bounded operational counters.
    Reflect.apply(Reflect.get(adapter, 'audit'), adapter, ['voice-input-rejected', {
      channelId: 'SYNTHETIC_CHANNEL_IDENTIFIER',
      detail: 'SYNTHETIC_ARBITRARY_DETAIL',
      directMessage: false,
      error: new Error('SYNTHETIC_AUDIT_ERROR'),
      guildId: 'SYNTHETIC_GUILD_IDENTIFIER',
      messageId: 'SYNTHETIC_MESSAGE_IDENTIFIER',
      name: 'SYNTHETIC_GUILD_NAME',
      reason: 'rate-limited',
      retryAfterMs: 99_999,
      sessionId: 'SYNTHETIC_SESSION_IDENTIFIER',
      turnGeneration: 7,
      turnId: 'SYNTHETIC_TURN_IDENTIFIER',
      url: 'https://synthetic.invalid/private?query=SYNTHETIC_QUERY',
      userId: 'SYNTHETIC_USER_IDENTIFIER',
    }])
    Reflect.apply(Reflect.get(adapter, 'audit'), adapter, ['SYNTHETIC_EVENT_IDENTIFIER', {
      reason: 'SYNTHETIC_REASON',
    }])

    const serialized = serializedLogBoundary()
    for (const sentinel of [
      'SYNTHETIC_CHANNEL_IDENTIFIER',
      'SYNTHETIC_ARBITRARY_DETAIL',
      'SYNTHETIC_AUDIT_ERROR',
      'SYNTHETIC_GUILD_IDENTIFIER',
      'SYNTHETIC_MESSAGE_IDENTIFIER',
      'SYNTHETIC_GUILD_NAME',
      'SYNTHETIC_SESSION_IDENTIFIER',
      'SYNTHETIC_TURN_IDENTIFIER',
      'synthetic.invalid',
      'SYNTHETIC_QUERY',
      'SYNTHETIC_USER_IDENTIFIER',
      'SYNTHETIC_EVENT_IDENTIFIER',
      'SYNTHETIC_REASON',
    ]) {
      /** @example expect(serialized).not.toContain(sentinel) */
      expect(serialized).not.toContain(sentinel)
    }

    /** @example expect(securityMocks.logger.withFields).toHaveBeenCalledWith(fields) */
    expect(securityMocks.logger.withFields).toHaveBeenCalledWith({
      directMessage: false,
      event: 'voice-input-rejected',
      reason: 'rate-limited',
      retryAfterMs: 65_535,
      turnGeneration: 7,
    })
    /** @example expect(securityMocks.logger.withFields).toHaveBeenCalledWith(fields) */
    expect(securityMocks.logger.withFields).toHaveBeenCalledWith({
      event: 'audit-observation-rejected',
      failureCategory: 'invalid-observation',
    })
  })

  /**
   * @example
   * it('keeps Discord identities out of non-audit lifecycle logs for P1-B', async () => {})
   */
  it('keeps Discord identities out of non-audit lifecycle logs for P1-B', async () => {
    const adapter = new DiscordAdapter({})
    const applicationId = 'SYNTHETIC_APPLICATION_IDENTIFIER'
    const interactionUserId = 'SYNTHETIC_INTERACTION_USER_IDENTIFIER'
    const commandName = 'SYNTHETIC_COMMAND_NAME'

    // ROOT CAUSE:
    //
    // Command registration, ClientReady failure, and interaction diagnostics
    // bypassed the audit projection and logged Discord application/user ids
    // directly. These production hooks prove the direct sinks now retain only
    // bounded lifecycle state and an allowlisted command category.
    Reflect.set(adapter, 'runtimePolicyEnabled', true)
    Reflect.set(adapter, 'runtimeConfigGeneration', 1)
    Reflect.set(adapter, 'commandRegistrationGeneration', 1)
    const registrationOwner = {
      applicationId,
      configGeneration: 1,
      generation: 1,
    }
    Reflect.set(adapter, 'commandRegistrationOwner', registrationOwner)
    Reflect.apply(Reflect.get(adapter, 'scheduleCommandRegistrationRetry'), adapter, [
      registrationOwner,
      2,
      'request-failure',
    ])

    Reflect.set(adapter, 'discordConnectionGeneration', 1)
    Reflect.set(adapter, 'handleDiscordReady', vi.fn().mockRejectedValue(new Error('synthetic ready failure')))
    await securityMocks.discordHandlers.get('client-ready')?.({
      user: { id: applicationId },
    })

    Reflect.set(adapter, 'discordIngressEnabled', true)
    await securityMocks.discordHandlers.get('interaction-create')?.({
      commandName,
      isButton: () => false,
      isChatInputCommand: () => true,
      user: { id: interactionUserId },
    })

    const serialized = serializedLogBoundary()
    /** @example expect(serialized).not.toContain(applicationId) */
    expect(serialized).not.toContain(applicationId)
    /** @example expect(serialized).not.toContain(interactionUserId) */
    expect(serialized).not.toContain(interactionUserId)
    /** @example expect(serialized).not.toContain(commandName) */
    expect(serialized).not.toContain(commandName)
    /** @example expect(securityMocks.logger.withField).toHaveBeenCalledWith('commandName', 'unknown') */
    expect(securityMocks.logger.withField).toHaveBeenCalledWith('commandName', 'unknown')
    /** @example expect(securityMocks.logger.withFields).toHaveBeenCalledWith(fields) */
    expect(securityMocks.logger.withFields).toHaveBeenCalledWith({
      attemptCount: 3,
      reason: 'request-failure',
    })
    /** @example expect(securityMocks.logger.withFields).toHaveBeenCalledWith(fields) */
    expect(securityMocks.logger.withFields).toHaveBeenCalledWith({
      eventCode: 'discord-ready-lifecycle-failed',
      failureCategory: 'discord-lifecycle',
      retryable: true,
      terminal: false,
    })

    Reflect.apply(Reflect.get(adapter, 'invalidateCommandRegistration'), adapter, [])
  })

  /**
   * @example
   * it('classifies external bridge failures without persisting raw errors for P2-B', async () => {})
   */
  it('classifies external bridge failures without persisting raw errors for P2-B', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const adapter = new DiscordAdapter({})
    await adapter.applyRuntimeConfig({
      auditLogEnabled: true,
      enabled: false,
      messagePacingMs: 1,
    })

    const failures = {
      airi: new Error('SYNTHETIC_AIRI_CHANNEL_ERROR https://synthetic.invalid/airi?token=SYNTHETIC_A'),
      dmChannel: new Error('SYNTHETIC_DM_CHANNEL_ERROR SYNTHETIC_DISCORD_IDENTIFIER'),
      dmUser: new Error('SYNTHETIC_DM_USER_ERROR SYNTHETIC_USER_CONTENT'),
      memory: new Error('SYNTHETIC_MEMORY_ERROR SYNTHETIC_MEMORY_CONTENT'),
      overload: new Error('SYNTHETIC_OVERLOAD_ERROR SYNTHETIC_SECRET'),
      rawDm: new Error('SYNTHETIC_RAW_DM_ERROR SYNTHETIC_RAW_BODY'),
      typing: new Error('SYNTHETIC_TYPING_ERROR SYNTHETIC_ENDPOINT_QUERY'),
    }

    securityMocks.serverChannelOptions[0]?.onError?.(failures.airi)

    await Reflect.apply(Reflect.get(adapter, 'paceIncomingText'), adapter, [{
      sendTyping: () => Promise.reject(failures.typing),
      userId: 'synthetic-user',
    }, new AbortController().signal, () => true])

    securityMocks.channelFetch.mockRejectedValueOnce(failures.dmChannel)
    securityMocks.userFetch.mockRejectedValueOnce(failures.dmUser)
    await Reflect.apply(Reflect.get(adapter, 'resolveOutputSendTarget'), adapter, [{
      channelId: 'synthetic-dm-channel',
      guildMember: {
        displayName: 'Synthetic user',
        id: 'synthetic-dm-user',
        nickname: 'Synthetic user',
      },
    }])

    securityMocks.channelFetch.mockRejectedValueOnce(failures.overload)
    await Reflect.apply(Reflect.get(adapter, 'scheduleDiscordOverloadStatus'), adapter, [{
      channelId: 'synthetic-guild-channel',
      guildId: 'synthetic-guild',
      guildMember: {
        displayName: 'Synthetic user',
        id: 'synthetic-guild-user',
        nickname: 'Synthetic user',
      },
    }, new AbortController().signal])

    Reflect.set(adapter, 'requestDiscordMemoryCommand', vi.fn().mockRejectedValue(failures.memory))
    await Reflect.apply(Reflect.get(adapter, 'handleDiscordMemoryBridgeCommand'), adapter, [{
      channelId: 'synthetic-channel',
      deferReply: vi.fn(async () => undefined),
      editReply: vi.fn(async () => undefined),
      guild: { name: 'Synthetic guild' },
      guildId: 'synthetic-guild',
      member: { displayName: 'Synthetic user', nickname: 'Synthetic user' },
      reply: vi.fn(async () => undefined),
      user: {
        globalName: 'Synthetic user',
        id: 'synthetic-user',
        username: 'Synthetic user',
      },
    }, { action: 'memory-list' }])

    Reflect.set(adapter, 'discordIngressEnabled', true)
    Reflect.set(adapter, 'handleDiscordTextInput', vi.fn().mockRejectedValue(failures.rawDm))
    securityMocks.discordHandlers.get('raw')?.({
      d: {
        author: {
          bot: false,
          global_name: 'Synthetic user',
          id: 'synthetic-user',
          username: 'Synthetic user',
        },
        channel_id: 'synthetic-channel',
        content: 'synthetic harmless input',
        id: 'synthetic-message',
      },
      t: 'MESSAGE_CREATE',
    })
    await Promise.resolve()
    await Promise.resolve()

    const serialized = JSON.stringify({
      console: consoleError.mock.calls,
      logger: serializedLogBoundary(),
    })
    for (const sentinel of [
      'SYNTHETIC_AIRI_CHANNEL_ERROR',
      'synthetic.invalid',
      'SYNTHETIC_A',
      'SYNTHETIC_DM_CHANNEL_ERROR',
      'SYNTHETIC_DISCORD_IDENTIFIER',
      'SYNTHETIC_DM_USER_ERROR',
      'SYNTHETIC_USER_CONTENT',
      'SYNTHETIC_MEMORY_ERROR',
      'SYNTHETIC_MEMORY_CONTENT',
      'SYNTHETIC_OVERLOAD_ERROR',
      'SYNTHETIC_SECRET',
      'SYNTHETIC_RAW_DM_ERROR',
      'SYNTHETIC_RAW_BODY',
      'SYNTHETIC_TYPING_ERROR',
      'SYNTHETIC_ENDPOINT_QUERY',
    ]) {
      /** @example expect(serialized).not.toContain(sentinel) */
      expect(serialized).not.toContain(sentinel)
    }
    /** @example expect(consoleError).not.toHaveBeenCalled() */
    expect(consoleError).not.toHaveBeenCalled()
    /** @example expect(securityMocks.logger.withError).not.toHaveBeenCalled() */
    expect(securityMocks.logger.withError).not.toHaveBeenCalled()

    const eventCodes = securityMocks.logger.withFields.mock.calls
      .map(([fields]) => fields.eventCode)
      .filter(Boolean)
    for (const eventCode of [
      'airi-channel-error',
      'typing-indicator-failed',
      'dm-channel-resolution-failed',
      'dm-user-resolution-failed',
      'overload-status-delivery-failed',
      'memory-command-failed',
      'raw-dm-ingress-failed',
    ]) {
      /** @example expect(eventCodes).toContain(eventCode) */
      expect(eventCodes).toContain(eventCode)
    }
    consoleError.mockRestore()
  })

  /**
   * @example
   * it('classifies pending-turn timeout cleanup failures without retaining the raw error for P2-B', async () => {})
   */
  it('classifies pending-turn timeout cleanup failures without retaining the raw error for P2-B', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const adapter = new DiscordAdapter({})
    const failure = new Error('SYNTHETIC_EXPIRATION_ERROR SYNTHETIC_TIMEOUT_BODY')
    securityMocks.airiSend.mockImplementationOnce(() => {
      throw failure
    })

    const registered = Reflect.apply(Reflect.get(adapter, 'registerPendingDiscordTurn'), adapter, [{
      channelId: 'synthetic-channel',
      guildId: 'synthetic-guild',
      guildMember: {
        displayName: 'Synthetic user',
        id: 'synthetic-user',
        nickname: 'Synthetic user',
      },
    }, 'synthetic-session', {
      deadlineAt: 1_001,
      generation: 1,
      id: 'synthetic-turn',
    }])
    /** @example expect(registered).toBe(true) */
    expect(registered).toBe(true)

    await vi.advanceTimersByTimeAsync(1)

    const serialized = serializedLogBoundary()
    /** @example expect(serialized).not.toContain('SYNTHETIC_EXPIRATION_ERROR') */
    expect(serialized).not.toContain('SYNTHETIC_EXPIRATION_ERROR')
    /** @example expect(serialized).not.toContain('SYNTHETIC_TIMEOUT_BODY') */
    expect(serialized).not.toContain('SYNTHETIC_TIMEOUT_BODY')
    /** @example expect(securityMocks.logger.withError).not.toHaveBeenCalled() */
    expect(securityMocks.logger.withError).not.toHaveBeenCalled()
    /** @example expect(securityMocks.logger.withFields).toHaveBeenCalledWith(fields) */
    expect(securityMocks.logger.withFields).toHaveBeenCalledWith({
      eventCode: 'pending-turn-expiration-failed',
      failureCategory: 'turn-lifecycle',
      retryable: false,
      terminal: true,
    })
  })

  /**
   * @example
   * it('classifies lifecycle cleanup errors without retaining attacker-controlled Error names for P2-B', async () => {})
   */
  it('classifies lifecycle cleanup errors without retaining attacker-controlled Error names for P2-B', async () => {
    const adapter = new DiscordAdapter({})
    const voiceStateFailure = new Error('synthetic voice-state failure')
    voiceStateFailure.name = 'SYNTHETIC_VOICE_STATE_ERROR_NAME'
    securityMocks.voiceStateUpdate.mockRejectedValueOnce(voiceStateFailure)
    Reflect.set(adapter, 'discordIngressEnabled', true)
    securityMocks.discordHandlers.get('voice-state-update')?.({}, {})
    await Promise.resolve()
    await Promise.resolve()

    const disconnectFailure = new Error('synthetic disconnect failure')
    disconnectFailure.name = 'SYNTHETIC_DISCONNECT_ERROR_NAME'
    securityMocks.voiceStop.mockRejectedValueOnce(disconnectFailure)
    Reflect.set(adapter, 'runtimePolicyEnabled', true)
    Reflect.apply(Reflect.get(adapter, 'beginDisconnectCleanup'), adapter, [])
    await Reflect.get(adapter, 'disconnectCleanupTask')
      ?.catch(() => undefined)
    await Promise.resolve()

    const missingTokenAdapter = new DiscordAdapter({})
    const missingTokenFailure = new Error('synthetic missing-token cleanup failure')
    missingTokenFailure.name = 'SYNTHETIC_MISSING_TOKEN_ERROR_NAME'
    securityMocks.voiceStop.mockRejectedValueOnce(missingTokenFailure)
    await expect(missingTokenAdapter.applyRuntimeConfig({ enabled: true })).rejects.toBe(missingTokenFailure)

    const serialized = serializedLogBoundary()
    for (const sentinel of [
      'SYNTHETIC_VOICE_STATE_ERROR_NAME',
      'SYNTHETIC_DISCONNECT_ERROR_NAME',
      'SYNTHETIC_MISSING_TOKEN_ERROR_NAME',
    ]) {
      /** @example expect(serialized).not.toContain(sentinel) */
      expect(serialized).not.toContain(sentinel)
    }
    const eventCodes = securityMocks.logger.withFields.mock.calls
      .map(([fields]) => fields.eventCode)
      .filter(Boolean)
    for (const eventCode of [
      'voice-state-update-failed',
      'disconnect-cleanup-failed',
      'missing-token-cleanup-failed',
    ]) {
      /** @example expect(eventCodes).toContain(eventCode) */
      expect(eventCodes).toContain(eventCode)
    }
  })
})
