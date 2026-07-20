import { beforeEach, describe, expect, it, vi } from 'vitest'

import { DiscordAdapter } from './airi-adapter'

interface MockAiriEvent {
  data: {
    config?: Record<string, unknown>
  }
}

interface MockServerChannelOptions {
  onReady?: () => void
  possibleEvents?: string[]
}

const runtimeMocks = vi.hoisted(() => ({
  airiClose: vi.fn(),
  airiReady: undefined as (() => void) | undefined,
  airiSend: vi.fn(() => true),
  airiHandlers: new Map<string, (event: MockAiriEvent) => unknown>(),
  discordHandlers: new Map<string, (...args: unknown[]) => unknown>(),
  discordDestroy: vi.fn(async () => {}),
  discordLogin: vi.fn(async (_token: string) => {}),
  registerCommands: vi.fn(async (_token: string, _clientId: string) => {}),
  serverChannelOptions: [] as MockServerChannelOptions[],
  voiceRevalidate: vi.fn(),
  voiceStop: vi.fn(async () => {}),
}))

vi.mock('@proj-airi/server-sdk', () => ({
  Client: class {
    constructor(options: MockServerChannelOptions) {
      runtimeMocks.serverChannelOptions.push(options)
      runtimeMocks.airiReady = options.onReady
    }

    close = runtimeMocks.airiClose

    onEvent(type: string, callback: (event: MockAiriEvent) => unknown) {
      runtimeMocks.airiHandlers.set(type, callback)
      return () => runtimeMocks.airiHandlers.delete(type)
    }

    send = runtimeMocks.airiSend
  },
}))

vi.mock('discord.js', () => ({
  Client: class {
    ready = false
    user = undefined
    channels = { fetch: vi.fn() }
    users = { fetch: vi.fn() }

    async destroy() {
      this.ready = false
      await runtimeMocks.discordDestroy()
    }

    isReady() {
      return this.ready
    }

    async login(token: string) {
      await runtimeMocks.discordLogin(token)
      this.ready = true
    }

    on(type: string, callback: (...args: unknown[]) => unknown) {
      runtimeMocks.discordHandlers.set(type, callback)
      return this
    }

    once(type: string, callback: (...args: unknown[]) => unknown) {
      runtimeMocks.discordHandlers.set(type, callback)
      return this
    }

    removeAllListeners(type: string) {
      runtimeMocks.discordHandlers.delete(type)
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
  Partials: {
    Channel: 1,
    Message: 2,
    User: 3,
  },
}))

vi.mock('../bots/discord/commands', () => ({
  handlePing: vi.fn(),
  registerCommands: runtimeMocks.registerCommands,
  VoiceManager: class {
    handleJoinChannelCommand = vi.fn()
    handleLeaveChannelCommand = vi.fn()
    revalidateSpeakerAdmissions = runtimeMocks.voiceRevalidate
    stop = runtimeMocks.voiceStop
  },
}))

vi.mock('../pipelines/tts', () => ({
  openaiTranscribe: vi.fn(),
}))

beforeEach(() => {
  runtimeMocks.airiClose.mockClear()
  runtimeMocks.airiReady = undefined
  runtimeMocks.airiSend.mockClear()
  runtimeMocks.airiHandlers.clear()
  runtimeMocks.discordHandlers.clear()
  runtimeMocks.discordDestroy.mockClear()
  runtimeMocks.discordLogin.mockReset()
  runtimeMocks.discordLogin.mockResolvedValue(undefined)
  runtimeMocks.registerCommands.mockReset()
  runtimeMocks.registerCommands.mockResolvedValue(undefined)
  runtimeMocks.serverChannelOptions.length = 0
  runtimeMocks.voiceRevalidate.mockClear()
  runtimeMocks.voiceStop.mockClear()
})

/**
 * @example
 * describe('discord adapter connection lifecycle', () => {})
 */
describe('discord adapter connection lifecycle', () => {
  /**
   * @example
   * it('coalesces an intermediate enabled policy behind a pending login for Discord audit D-021', async () => {})
   */
  it('coalesces an intermediate enabled policy behind a pending login for Discord audit D-021', async () => {
    let releaseLogin = () => {}
    runtimeMocks.discordLogin.mockImplementationOnce(() => new Promise<void>((resolve) => {
      releaseLogin = resolve
    }))
    const adapter = new DiscordAdapter({
      discordToken: 'synthetic-discord-bot-token',
    })

    const firstEnable = adapter.applyRuntimeConfig({
      allowedChannelIds: ['channel-a'],
      enabled: true,
    })
    await vi.waitFor(() => {
      /** @example expect(runtimeMocks.discordLogin).toHaveBeenCalledOnce() */
      expect(runtimeMocks.discordLogin).toHaveBeenCalledOnce()
    })
    const supersededEnable = adapter.applyRuntimeConfig({
      allowedChannelIds: ['channel-b'],
      enabled: true,
    })
    const latestEnable = adapter.applyRuntimeConfig({
      allowedChannelIds: ['channel-c'],
      enabled: true,
    })

    // ROOT CAUSE:
    //
    // Runtime config work was serialized, but every queued enabled policy still
    // replayed after a pending login. Only the latest non-security policy should
    // publish or revalidate state once that safe connection becomes available.
    releaseLogin()
    await Promise.all([firstEnable, supersededEnable, latestEnable])

    /** @example expect(runtimeMocks.voiceStop).not.toHaveBeenCalled() */
    expect(runtimeMocks.voiceStop).not.toHaveBeenCalled()
    /** @example expect(runtimeMocks.discordDestroy).not.toHaveBeenCalled() */
    expect(runtimeMocks.discordDestroy).not.toHaveBeenCalled()
    /** @example expect(runtimeMocks.discordLogin).toHaveBeenCalledOnce() */
    expect(runtimeMocks.discordLogin).toHaveBeenCalledOnce()
    /** @example expect(Reflect.get(adapter, 'runtimeConfig').allowedChannelIds).toEqual(['channel-c']) */
    expect(Reflect.get(adapter, 'runtimeConfig').allowedChannelIds).toEqual(['channel-c'])

    await adapter.stop()
  })

  /**
   * @example
   * it('drains a disable security barrier before a later enable for Discord audit D-021', async () => {})
   */
  it('drains a disable security barrier before a later enable for Discord audit D-021', async () => {
    let releaseLogin = () => {}
    runtimeMocks.discordLogin.mockImplementationOnce(() => new Promise<void>((resolve) => {
      releaseLogin = resolve
    }))
    const adapter = new DiscordAdapter({
      discordToken: 'synthetic-discord-bot-token',
    })

    const firstEnable = adapter.applyRuntimeConfig({ enabled: true })
    await vi.waitFor(() => {
      /** @example expect(runtimeMocks.discordLogin).toHaveBeenCalledOnce() */
      expect(runtimeMocks.discordLogin).toHaveBeenCalledOnce()
    })
    const disableBarrier = adapter.applyRuntimeConfig({ enabled: false })
    const replacementEnable = adapter.applyRuntimeConfig({
      allowedChannelIds: ['channel-c'],
      enabled: true,
    })

    // ROOT CAUSE:
    //
    // Enabled policy updates may coalesce, but disable is a security barrier.
    // Skipping its exact voice/provider/client cleanup would let consent and
    // lifecycle state survive into C. C must start only after B has drained.
    releaseLogin()
    await Promise.all([firstEnable, disableBarrier, replacementEnable])

    /** @example expect(runtimeMocks.voiceStop).toHaveBeenCalledOnce() */
    expect(runtimeMocks.voiceStop).toHaveBeenCalledOnce()
    /** @example expect(runtimeMocks.discordDestroy).toHaveBeenCalledOnce() */
    expect(runtimeMocks.discordDestroy).toHaveBeenCalledOnce()
    /** @example expect(runtimeMocks.discordLogin).toHaveBeenCalledTimes(2) */
    expect(runtimeMocks.discordLogin).toHaveBeenCalledTimes(2)
    /** @example expect(Reflect.get(adapter, 'runtimeConfig').allowedChannelIds).toEqual(['channel-c']) */
    expect(Reflect.get(adapter, 'runtimeConfig').allowedChannelIds).toEqual(['channel-c'])

    await adapter.stop()
  })

  /**
   * @example
   * it('retries a failed disable cleanup barrier before re-enabling for Discord audit D-021', async () => {})
   */
  it('retries a failed disable cleanup barrier before re-enabling for Discord audit D-021', async () => {
    const cleanupFailure = new Error('SYNTHETIC_D021_DISABLE_CLEANUP_FAILURE')
    const retryFailure = new Error('SYNTHETIC_D021_RETRY_CLEANUP_FAILURE')
    runtimeMocks.voiceStop
      .mockRejectedValueOnce(cleanupFailure)
      .mockRejectedValueOnce(retryFailure)
      .mockResolvedValue(undefined)
    const adapter = new DiscordAdapter({
      discordToken: 'synthetic-discord-bot-token',
    })
    await adapter.applyRuntimeConfig({ enabled: true })

    // ROOT CAUSE:
    //
    // A failed disable set `disconnectCleanupFailed`, but the next enabled
    // configuration skipped the failed exact owner, logged in again, and resolved
    // successfully while ingress remained permanently closed behind that flag.
    // A later policy must retry and drain the cleanup barrier before it may login,
    // register commands, or publish enabled state.
    await expect(adapter.applyRuntimeConfig({ enabled: false })).rejects.toBe(cleanupFailure)
    /** @example expect(Reflect.get(adapter, 'disconnectCleanupFailed')).toBe(true) */
    expect(Reflect.get(adapter, 'disconnectCleanupFailed')).toBe(true)

    await expect(adapter.applyRuntimeConfig({
      allowedChannelIds: ['replacement-channel'],
      enabled: true,
    })).rejects.toThrow('cleanup must complete')

    /** @example expect(runtimeMocks.discordLogin).toHaveBeenCalledOnce() */
    expect(runtimeMocks.discordLogin).toHaveBeenCalledOnce()
    /** @example expect(Reflect.get(adapter, 'disconnectCleanupFailed')).toBe(true) */
    expect(Reflect.get(adapter, 'disconnectCleanupFailed')).toBe(true)

    await expect(adapter.applyRuntimeConfig({ enabled: false })).rejects.toBe(retryFailure)
    /** @example expect(runtimeMocks.discordLogin).toHaveBeenCalledOnce() */
    expect(runtimeMocks.discordLogin).toHaveBeenCalledOnce()
    /** @example expect(Reflect.get(adapter, 'disconnectCleanupFailed')).toBe(true) */
    expect(Reflect.get(adapter, 'disconnectCleanupFailed')).toBe(true)

    await expect(adapter.applyRuntimeConfig({ enabled: false })).resolves.toBeUndefined()
    /** @example expect(Reflect.get(adapter, 'disconnectCleanupFailed')).toBe(false) */
    expect(Reflect.get(adapter, 'disconnectCleanupFailed')).toBe(false)

    await expect(adapter.applyRuntimeConfig({
      allowedChannelIds: ['replacement-channel'],
      enabled: true,
    })).resolves.toBeUndefined()

    /** @example expect(runtimeMocks.voiceStop).toHaveBeenCalledTimes(3) */
    expect(runtimeMocks.voiceStop).toHaveBeenCalledTimes(3)
    /** @example expect(runtimeMocks.discordDestroy).toHaveBeenCalledTimes(3) */
    expect(runtimeMocks.discordDestroy).toHaveBeenCalledTimes(3)
    /** @example expect(runtimeMocks.discordLogin).toHaveBeenCalledTimes(2) */
    expect(runtimeMocks.discordLogin).toHaveBeenCalledTimes(2)
    /** @example expect(Reflect.get(adapter, 'disconnectCleanupFailed')).toBe(false) */
    expect(Reflect.get(adapter, 'disconnectCleanupFailed')).toBe(false)
    /** @example expect(Reflect.get(adapter, 'runtimeConfig').allowedChannelIds).toEqual(['replacement-channel']) */
    expect(Reflect.get(adapter, 'runtimeConfig').allowedChannelIds).toEqual(['replacement-channel'])

    await adapter.stop()
  })

  /**
   * @example
   * it('keeps a final disable closed after deferred login settlement for Discord audit D-021', async () => {})
   */
  it('keeps a final disable closed after deferred login settlement for Discord audit D-021', async () => {
    let releaseLogin = () => {}
    runtimeMocks.discordLogin.mockImplementationOnce(() => new Promise<void>((resolve) => {
      releaseLogin = resolve
    }))
    const adapter = new DiscordAdapter({ discordToken: 'synthetic-discord-bot-token' })
    const enabling = adapter.applyRuntimeConfig({ enabled: true })
    await vi.waitFor(() => {
      /** @example expect(runtimeMocks.discordLogin).toHaveBeenCalledOnce() */
      expect(runtimeMocks.discordLogin).toHaveBeenCalledOnce()
    })
    const disabling = adapter.applyRuntimeConfig({ enabled: false })

    // ROOT CAUSE:
    //
    // A login promise cannot be aborted. Without applied/connection generation
    // ownership, its late Ready could reopen ingress after the final disable.
    releaseLogin()
    await Promise.all([enabling, disabling])
    const ready = runtimeMocks.discordHandlers.get('client-ready')
    await ready?.({ user: { id: 'late-application' } })

    /** @example expect(runtimeMocks.registerCommands).not.toHaveBeenCalled() */
    expect(runtimeMocks.registerCommands).not.toHaveBeenCalled()
    /** @example expect(Reflect.get(adapter, 'runtimePolicyEnabled')).toBe(false) */
    expect(Reflect.get(adapter, 'runtimePolicyEnabled')).toBe(false)
    /** @example expect(Reflect.get(adapter, 'discordIngressEnabled')).toBe(false) */
    expect(Reflect.get(adapter, 'discordIngressEnabled')).toBe(false)
    /** @example expect(runtimeMocks.discordDestroy).toHaveBeenCalledOnce() */
    expect(runtimeMocks.discordDestroy).toHaveBeenCalledOnce()

    await adapter.stop()
  })

  /**
   * @example
   * it('continues the final disable after deferred login rejection for Discord audit D-021', async () => {})
   */
  it('continues the final disable after deferred login rejection for Discord audit D-021', async () => {
    let rejectLogin = (_error: Error) => {}
    runtimeMocks.discordLogin.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => {
      rejectLogin = reject
    }))
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const adapter = new DiscordAdapter({ discordToken: 'synthetic-discord-bot-token' })
    const enabling = adapter.applyRuntimeConfig({ enabled: true })
    await vi.waitFor(() => {
      /** @example expect(runtimeMocks.discordLogin).toHaveBeenCalledOnce() */
      expect(runtimeMocks.discordLogin).toHaveBeenCalledOnce()
    })
    const disabling = adapter.applyRuntimeConfig({ enabled: false })

    // ROOT CAUSE:
    //
    // Queue continuation previously used an empty catch. The disable must still
    // execute after A rejects, while observability stays structured and the
    // caller that owned A still receives its rejection.
    rejectLogin(new Error('SYNTHETIC_LOGIN_PRIVATE_DETAIL'))
    await expect(enabling).rejects.toThrow('SYNTHETIC_LOGIN_PRIVATE_DETAIL')
    await expect(disabling).resolves.toBeUndefined()

    /** @example expect(Reflect.get(adapter, 'runtimePolicyEnabled')).toBe(false) */
    expect(Reflect.get(adapter, 'runtimePolicyEnabled')).toBe(false)
    /** @example expect(runtimeMocks.registerCommands).not.toHaveBeenCalled() */
    expect(runtimeMocks.registerCommands).not.toHaveBeenCalled()
    /** @example expect(JSON.stringify(consoleError.mock.calls)).not.toContain('PRIVATE_DETAIL') */
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain('PRIVATE_DETAIL')

    consoleError.mockRestore()
    await adapter.stop()
  })

  /**
   * @example
   * it('closes ingress while the latest enabled policy is pending for Discord audit D-021', async () => {})
   */
  it('closes ingress while the latest enabled policy is pending for Discord audit D-021', async () => {
    const adapter = new DiscordAdapter({ discordToken: 'synthetic-discord-bot-token' })
    runtimeMocks.airiReady?.()
    await adapter.applyRuntimeConfig({ enabled: true })
    const ready = runtimeMocks.discordHandlers.get('client-ready')
    await ready?.({ user: { id: 'current-application' } })
    runtimeMocks.airiSend.mockClear()

    Reflect.set(Reflect.get(adapter, 'discordClient'), 'ready', false)
    let releaseLogin = () => {}
    runtimeMocks.discordLogin.mockImplementationOnce(() => new Promise<void>((resolve) => {
      releaseLogin = resolve
    }))
    const tightening = adapter.applyRuntimeConfig({
      allowedChannelIds: ['channel-b'],
      enabled: true,
    })
    await vi.waitFor(() => {
      /** @example expect(runtimeMocks.discordLogin).toHaveBeenCalledTimes(2) */
      expect(runtimeMocks.discordLogin).toHaveBeenCalledTimes(2)
    })
    const messageCreate = runtimeMocks.discordHandlers.get('message-create')

    // ROOT CAUSE:
    //
    // Enabled policy updates did not synchronously gate old ingress. Messages
    // could reach Stage under policy A while policy B was waiting on connection.
    await messageCreate?.({ author: { bot: false } })
    /** @example expect(runtimeMocks.airiSend).not.toHaveBeenCalled() */
    expect(runtimeMocks.airiSend).not.toHaveBeenCalled()
    /** @example expect(Reflect.get(adapter, 'discordIngressEnabled')).toBe(false) */
    expect(Reflect.get(adapter, 'discordIngressEnabled')).toBe(false)

    releaseLogin()
    await tightening
    await adapter.stop()
  })

  /**
   * @example
   * it('single-flights registration and cancels retry ownership on disable for Discord audit D-021', async () => {})
   */
  it('single-flights registration and cancels retry ownership on disable for Discord audit D-021', async () => {
    let rejectRegistration = (_error: Error) => {}
    runtimeMocks.registerCommands.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => {
      rejectRegistration = reject
    }))
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const adapter = new DiscordAdapter({ discordToken: 'synthetic-discord-bot-token' })
    await adapter.applyRuntimeConfig({ enabled: true })
    const ready = runtimeMocks.discordHandlers.get('client-ready')
    if (!ready)
      throw new Error('Expected the Discord ClientReady handler.')

    const firstReady = Promise.resolve(ready({ user: { id: 'current-application' } }))
    const duplicateReady = Promise.resolve(ready({ user: { id: 'current-application' } }))
    await vi.waitFor(() => {
      /** @example expect(runtimeMocks.registerCommands).toHaveBeenCalledOnce() */
      expect(runtimeMocks.registerCommands).toHaveBeenCalledOnce()
    })
    const disabling = adapter.applyRuntimeConfig({ enabled: false })
    rejectRegistration(new Error('SYNTHETIC_REGISTRATION_PRIVATE_DETAIL'))
    await Promise.all([firstReady, duplicateReady, disabling])

    /** @example expect(runtimeMocks.registerCommands).toHaveBeenCalledOnce() */
    expect(runtimeMocks.registerCommands).toHaveBeenCalledOnce()
    /** @example expect(Reflect.get(adapter, 'commandRegistrationRetryTimer')).toBeUndefined() */
    expect(Reflect.get(adapter, 'commandRegistrationRetryTimer')).toBeUndefined()
    /** @example expect(Reflect.get(adapter, 'commandRegistrationOwner')).toBeUndefined() */
    expect(Reflect.get(adapter, 'commandRegistrationOwner')).toBeUndefined()
    /** @example expect(JSON.stringify(consoleError.mock.calls)).not.toContain('PRIVATE_DETAIL') */
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain('PRIVATE_DETAIL')

    await adapter.stop()
    /** @example expect(runtimeMocks.discordHandlers.has('client-ready')).toBe(false) */
    expect(runtimeMocks.discordHandlers.has('client-ready')).toBe(false)
    consoleError.mockRestore()
  })

  /**
   * @example
   * it('cancels every superseded registration wrapper before stop completes for Discord audit D-021', async () => {})
   */
  it('cancels every superseded registration wrapper before stop completes for Discord audit D-021', async () => {
    // ROOT CAUSE:
    //
    // Slash registration kept only the newest wrapper promise in one field.
    // Superseding deferred application A with B overwrote that field, so stop
    // could drain B while A's ten-second timeout and wrapper task remained live.
    // The raw Discord REST promise must remain retained, but every local waiter,
    // timer, and retry owner belongs to its exact registration generation.
    vi.useFakeTimers()
    let releaseApplicationA = () => {}
    runtimeMocks.registerCommands.mockImplementation((_token, applicationId) => {
      if (applicationId !== 'application-a')
        return Promise.resolve()
      return new Promise<void>((resolve) => {
        releaseApplicationA = resolve
      })
    })
    const adapter = new DiscordAdapter({ discordToken: 'synthetic-discord-bot-token' })
    await adapter.applyRuntimeConfig({ enabled: true })
    const ready = runtimeMocks.discordHandlers.get('client-ready')
    if (!ready)
      throw new Error('Expected the Discord ClientReady handler.')

    const readyA = Promise.resolve(ready({ user: { id: 'application-a' } }))
    await vi.waitFor(() => {
      /** @example expect(runtimeMocks.registerCommands).toHaveBeenCalledOnce() */
      expect(runtimeMocks.registerCommands).toHaveBeenCalledOnce()
    })
    await adapter.applyRuntimeConfig({ enabled: true })
    await ready({ user: { id: 'application-b' } })
    await adapter.stop()

    const timerCountAfterStop = vi.getTimerCount()
    const wrapperAttemptCountAfterStop = Reflect.get(adapter, 'commandRegistrationAttempts')?.size
    /** @example expect(Reflect.get(adapter, 'rawCommandRegistrationTasks').size).toBe(1) */
    expect(Reflect.get(adapter, 'rawCommandRegistrationTasks').size).toBe(1)

    releaseApplicationA()
    await readyA
    await Promise.resolve()
    await Promise.resolve()

    /** @example expect(timerCountAfterStop).toBe(0) */
    expect(timerCountAfterStop).toBe(0)
    /** @example expect(wrapperAttemptCountAfterStop).toBe(0) */
    expect(wrapperAttemptCountAfterStop).toBe(0)
    /** @example expect(Reflect.get(adapter, 'rawCommandRegistrationTasks').size).toBe(0) */
    expect(Reflect.get(adapter, 'rawCommandRegistrationTasks').size).toBe(0)
    /** @example expect(Reflect.get(adapter, 'registeredDiscordApplicationId')).toBeUndefined() */
    expect(Reflect.get(adapter, 'registeredDiscordApplicationId')).toBeUndefined()
    vi.useRealTimers()
  })

  /**
   * @example
   * it('rechecks registration ownership at deferred REST dispatch for Discord audit D-021', async () => {})
   */
  it('rechecks registration ownership at deferred REST dispatch for Discord audit D-021', async () => {
    // ROOT CAUSE:
    //
    // The shared Discord transport admits work synchronously but invokes the
    // REST closure in a microtask. A disable/config supersession in that gap
    // invalidated the owner while the stale closure still called Discord REST.
    // Admission and dispatch now both prove the same exact generation.
    const adapter = new DiscordAdapter({ discordToken: 'synthetic-discord-bot-token' })
    await adapter.applyRuntimeConfig({ enabled: true })
    const ready = runtimeMocks.discordHandlers.get('client-ready')
    if (!ready)
      throw new Error('Expected the Discord ClientReady handler.')

    const staleReady = Promise.resolve(ready({ user: { id: 'stale-application' } }))
    const disabling = adapter.applyRuntimeConfig({ enabled: false })
    await Promise.all([staleReady, disabling])

    /** @example expect(runtimeMocks.registerCommands).not.toHaveBeenCalled() */
    expect(runtimeMocks.registerCommands).not.toHaveBeenCalled()
    /** @example expect(Reflect.get(adapter, 'commandRegistrationAttempts')).toHaveProperty('size', 0) */
    expect(Reflect.get(adapter, 'commandRegistrationAttempts')).toHaveProperty('size', 0)
    /** @example expect(Reflect.get(adapter, 'commandRegistrationRetryTimer')).toBeUndefined() */
    expect(Reflect.get(adapter, 'commandRegistrationRetryTimer')).toBeUndefined()
    /** @example expect(Reflect.get(adapter, 'commandRegistrationOwner')).toBeUndefined() */
    expect(Reflect.get(adapter, 'commandRegistrationOwner')).toBeUndefined()

    await adapter.stop()
  })

  /**
   * @example
   * it('recovers after bounded registration retry cooldown for Discord audit D-021', async () => {})
   */
  it('recovers after bounded registration retry cooldown for Discord audit D-021', async () => {
    vi.useFakeTimers()
    runtimeMocks.registerCommands
      .mockRejectedValueOnce(new Error('SYNTHETIC_REGISTRATION_FAILURE_1'))
      .mockRejectedValueOnce(new Error('SYNTHETIC_REGISTRATION_FAILURE_2'))
      .mockRejectedValueOnce(new Error('SYNTHETIC_REGISTRATION_FAILURE_3'))
      .mockResolvedValue(undefined)
    const adapter = new DiscordAdapter({ discordToken: 'synthetic-discord-bot-token' })
    await adapter.applyRuntimeConfig({ enabled: true })
    const ready = runtimeMocks.discordHandlers.get('client-ready')
    if (!ready)
      throw new Error('Expected the Discord ClientReady handler.')

    // ROOT CAUSE:
    //
    // Retry exhaustion left the same application owner installed forever, so
    // future legal Ready events returned without another attempt. Clearing it
    // immediately would instead create a Ready-event retry storm. A bounded
    // cooldown now makes recovery explicit and stop-owned.
    await ready({ user: { id: 'current-application' } })
    await vi.runAllTimersAsync()
    /** @example expect(runtimeMocks.registerCommands).toHaveBeenCalledTimes(3) */
    expect(runtimeMocks.registerCommands).toHaveBeenCalledTimes(3)
    /** @example expect(Reflect.get(adapter, 'commandRegistrationOwner')).toBeUndefined() */
    expect(Reflect.get(adapter, 'commandRegistrationOwner')).toBeUndefined()
    /** @example expect(Reflect.get(adapter, 'commandRegistrationRetryTimer')).toBeUndefined() */
    expect(Reflect.get(adapter, 'commandRegistrationRetryTimer')).toBeUndefined()

    await ready({ user: { id: 'current-application' } })
    /** @example expect(runtimeMocks.registerCommands).toHaveBeenCalledTimes(4) */
    expect(runtimeMocks.registerCommands).toHaveBeenCalledTimes(4)
    await adapter.stop()
    /** @example expect(vi.getTimerCount()).toBe(0) */
    expect(vi.getTimerCount()).toBe(0)
    vi.useRealTimers()
  })

  /**
   * @example
   * it('reserves command registration capacity for a replacement application in Discord audit D-021', async () => {})
   */
  it('reserves command registration capacity for a replacement application in Discord audit D-021', async () => {
    vi.useFakeTimers()
    const releaseStaleRegistrations: Array<() => void> = []
    runtimeMocks.registerCommands.mockImplementation((_token, applicationId) => {
      if (applicationId === 'replacement-application')
        return Promise.resolve()
      return new Promise<void>((resolve) => {
        releaseStaleRegistrations.push(resolve)
      })
    })
    const adapter = new DiscordAdapter({ discordToken: 'synthetic-discord-bot-token' })
    await adapter.applyRuntimeConfig({ enabled: true })
    const ready = runtimeMocks.discordHandlers.get('client-ready')
    if (!ready)
      throw new Error('Expected the Discord ClientReady handler.')

    // ROOT CAUSE:
    //
    // Discord command registration cannot be aborted. A timeout released the
    // local waiter while every raw REST promise remained active. Without an
    // exact application cap plus reserved replacement capacity, those stale
    // promises could consume the whole registry and deny a new connection.
    const staleReady = Promise.resolve(ready({ user: { id: 'stale-application' } }))
    await vi.advanceTimersByTimeAsync(31_250)
    await staleReady
    /** @example expect(runtimeMocks.registerCommands).toHaveBeenCalledTimes(3) */
    expect(runtimeMocks.registerCommands).toHaveBeenCalledTimes(3)
    /** @example expect(Reflect.get(adapter, 'rawCommandRegistrationTasks').size).toBe(3) */
    expect(Reflect.get(adapter, 'rawCommandRegistrationTasks').size).toBe(3)

    await adapter.applyRuntimeConfig({ enabled: true })
    await ready({ user: { id: 'replacement-application' } })

    /** @example expect(runtimeMocks.registerCommands).toHaveBeenCalledTimes(4) */
    expect(runtimeMocks.registerCommands).toHaveBeenCalledTimes(4)
    /** @example expect(runtimeMocks.registerCommands).toHaveBeenLastCalledWith(expect.any(String), 'replacement-application') */
    expect(runtimeMocks.registerCommands).toHaveBeenLastCalledWith(
      'synthetic-discord-bot-token',
      'replacement-application',
    )
    /** @example expect(Reflect.get(adapter, 'registeredDiscordApplicationId')).toBe('replacement-application') */
    expect(Reflect.get(adapter, 'registeredDiscordApplicationId')).toBe('replacement-application')

    for (const release of releaseStaleRegistrations)
      release()
    await vi.waitFor(() => {
      /** @example expect(Reflect.get(adapter, 'rawCommandRegistrationTasks').size).toBe(0) */
      expect(Reflect.get(adapter, 'rawCommandRegistrationTasks').size).toBe(0)
    })
    await adapter.stop()
    /** @example expect(vi.getTimerCount()).toBe(0) */
    expect(vi.getTimerCount()).toBe(0)
    vi.useRealTimers()
  })

  /**
   * @example
   * it('continues stop cleanup after one owner rejects for Discord audit D-021', async () => {})
   */
  it('continues stop cleanup after one owner rejects for Discord audit D-021', async () => {
    const cleanupFailure = new Error('SYNTHETIC_VOICE_CLEANUP_FAILURE')
    runtimeMocks.voiceStop.mockRejectedValueOnce(cleanupFailure)
    const adapter = new DiscordAdapter({ discordToken: 'synthetic-discord-bot-token' })
    await adapter.applyRuntimeConfig({ enabled: true })

    // ROOT CAUSE:
    //
    // Lifecycle cleanup must aggregate ownership attempts. A voice cleanup
    // rejection cannot skip Discord destroy, listener removal, or AIRI close.
    await expect(adapter.stop()).rejects.toBe(cleanupFailure)

    /** @example expect(runtimeMocks.discordDestroy).toHaveBeenCalledOnce() */
    expect(runtimeMocks.discordDestroy).toHaveBeenCalledOnce()
    /** @example expect(runtimeMocks.airiClose).toHaveBeenCalledOnce() */
    expect(runtimeMocks.airiClose).toHaveBeenCalledOnce()
    /** @example expect(runtimeMocks.discordHandlers.has('client-ready')).toBe(false) */
    expect(runtimeMocks.discordHandlers.has('client-ready')).toBe(false)
  })

  /**
   * @example
   * it('removes every exact installed listener for Discord audit D-021', async () => {})
   */
  it('removes every exact installed listener for Discord audit D-021', async () => {
    const adapter = new DiscordAdapter({ discordToken: 'synthetic-discord-bot-token' })
    const installedEvents = [
      'client-ready',
      'interaction-create',
      'message-create',
      'raw',
      'shard-disconnect',
      'shard-ready',
      'voice-state-update',
    ]
    expect(Array.from(runtimeMocks.discordHandlers.keys()).sort()).toEqual(installedEvents)

    // ROOT CAUSE:
    //
    // setupEventHandlers installed seven Discord listeners, but stop removed only
    // ClientReady. Reusing or retaining the client after stop left stale ingress,
    // shard lifecycle, interaction, and voice callbacks owned by the dead adapter.
    await adapter.stop()

    expect(Array.from(runtimeMocks.discordHandlers.keys())).toEqual([])
  })

  /**
   * @example
   * it('gates stale ready and retries registration without raw errors for Discord audit D-021', async () => {})
   */
  it('gates stale ready and retries registration without raw errors for Discord audit D-021', async () => {
    vi.useFakeTimers()
    let releaseLogin = () => {}
    runtimeMocks.discordLogin.mockImplementationOnce(() => new Promise<void>((resolve) => {
      releaseLogin = resolve
    }))
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const adapter = new DiscordAdapter({
      discordToken: 'synthetic-discord-bot-token',
    })
    const enabling = adapter.applyRuntimeConfig({ enabled: true })
    await vi.advanceTimersByTimeAsync(0)
    const disabling = adapter.applyRuntimeConfig({ enabled: false })
    const ready = runtimeMocks.discordHandlers.get('client-ready')
    if (!ready)
      throw new Error('Expected the Discord ClientReady handler.')

    // ROOT CAUSE:
    //
    // ClientReady used a process-lifetime `once` listener with no config-generation
    // gate. A superseded login could consume it and register commands while disabled;
    // a later application then had no listener. REST rejection also escaped the async
    // EventEmitter callback instead of entering a bounded, sanitized retry lifecycle.
    await ready({ user: { id: 'stale-application' } })
    /** @example expect(runtimeMocks.registerCommands).not.toHaveBeenCalled() */
    expect(runtimeMocks.registerCommands).not.toHaveBeenCalled()
    releaseLogin()
    await Promise.all([enabling, disabling])

    runtimeMocks.registerCommands
      .mockRejectedValueOnce(new Error('SYNTHETIC_REGISTRATION_PRIVATE_DETAIL'))
      .mockResolvedValue(undefined)
    await adapter.applyRuntimeConfig({ enabled: true })
    await ready({ user: { id: 'current-application' } })
    await vi.runAllTimersAsync()

    /** @example expect(runtimeMocks.registerCommands).toHaveBeenCalledTimes(2) */
    expect(runtimeMocks.registerCommands).toHaveBeenCalledTimes(2)
    /** @example expect(runtimeMocks.registerCommands).toHaveBeenLastCalledWith(expect.any(String), 'current-application') */
    expect(runtimeMocks.registerCommands).toHaveBeenLastCalledWith(
      'synthetic-discord-bot-token',
      'current-application',
    )
    await ready({ user: { id: 'current-application' } })
    /** @example expect(runtimeMocks.registerCommands).toHaveBeenCalledTimes(2) */
    expect(runtimeMocks.registerCommands).toHaveBeenCalledTimes(2)
    await ready({ user: { id: 'replacement-application' } })
    /** @example expect(runtimeMocks.registerCommands).toHaveBeenCalledTimes(2) */
    expect(runtimeMocks.registerCommands).toHaveBeenCalledTimes(2)
    await adapter.applyRuntimeConfig({ enabled: true })
    await ready({ user: { id: 'replacement-application' } })
    /** @example expect(runtimeMocks.registerCommands).toHaveBeenCalledTimes(3) */
    expect(runtimeMocks.registerCommands).toHaveBeenCalledTimes(3)
    /** @example expect(JSON.stringify(consoleError.mock.calls)).not.toContain('PRIVATE_DETAIL') */
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain('PRIVATE_DETAIL')

    consoleError.mockRestore()
    await adapter.stop()
    vi.useRealTimers()
  })

  /**
   * @example
   * it('waits for Main runtime policy before logging in with a protected token (Discord audit D-004)', async () => {})
   */
  it('waits for Main runtime policy before logging in with a protected token (Discord audit D-004)', async () => {
    // ROOT CAUSE:
    //
    // The bridge adapter treated the presence of an environment or constructor
    // token as authorization to log in during `start()`. Stage had not yet sent
    // `enabled`, channel policy, privacy policy, or rate limits at that point.
    //
    // Before: `start()` called Discord login immediately.
    // After: the protected token remains inert until a non-secret `enabled: true`
    // policy is applied through the parent-controlled adapter API.
    const adapter = new DiscordAdapter({
      airiToken: 'synthetic-discord-module-token',
      airiUrl: 'ws://127.0.0.1:47260/ws',
      discordToken: 'synthetic-discord-bot-token',
    })

    // @example
    expect(runtimeMocks.serverChannelOptions[0]?.possibleEvents).not.toContain('module:configure')
    // @example
    expect(runtimeMocks.airiHandlers.has('module:configure')).toBe(false)

    await adapter.start()

    // @example
    expect(runtimeMocks.discordLogin).not.toHaveBeenCalled()

    await adapter.applyRuntimeConfig({
      enabled: false,
      allowedChannelIds: ['synthetic-channel'],
      allowDirectMessages: false,
      privacyNoticeEnabled: true,
    })

    // @example
    expect(runtimeMocks.discordLogin).not.toHaveBeenCalled()

    await adapter.applyRuntimeConfig({
      enabled: true,
      allowedChannelIds: ['synthetic-channel'],
      allowDirectMessages: false,
      privacyNoticeEnabled: true,
    })

    // @example
    expect(runtimeMocks.discordLogin).toHaveBeenCalledTimes(1)
    // @example
    expect(runtimeMocks.discordLogin).toHaveBeenCalledWith('synthetic-discord-bot-token')
    // @example
    expect(runtimeMocks.voiceRevalidate).toHaveBeenCalledTimes(2)
  })

  /**
   * @example
   * it('joins an in-flight login before stop completes for Discord audit D-011', async () => {})
   */
  it('joins an in-flight login before stop completes for Discord audit D-011', async () => {
    // ROOT CAUSE:
    //
    // stop invalidated the config generation and destroyed the current client,
    // but did not join a login already awaiting Discord.js. That stale login
    // could establish a connection after stop had reported completion.
    //
    // Before: stop resolved first and the later login left the client connected.
    // After: stop invalidates ingress immediately, joins serialized config work,
    // then performs the final destroy before resolving.
    let releaseLogin: (() => void) | undefined
    runtimeMocks.discordLogin.mockImplementationOnce(() => new Promise<void>((resolve) => {
      releaseLogin = resolve
    }))
    const adapter = new DiscordAdapter({
      discordToken: 'synthetic-discord-bot-token',
    })
    const enabling = adapter.applyRuntimeConfig({ enabled: true })
    await vi.waitFor(() => {
      // @example
      expect(runtimeMocks.discordLogin).toHaveBeenCalledTimes(1)
    })

    let stopResolved = false
    const stopping = adapter.stop().then(() => {
      stopResolved = true
    })
    await Promise.resolve()
    await Promise.resolve()

    // @example
    expect(stopResolved).toBe(false)

    releaseLogin?.()
    await Promise.all([enabling, stopping])

    // @example
    expect(Reflect.get(adapter, 'discordClient').isReady()).toBe(false)
    // @example
    expect(runtimeMocks.discordDestroy).toHaveBeenCalledTimes(1)
  })

  /**
   * @example
   * it('finishes cleanup when serialized config fails for Discord audit D-011', async () => {})
   */
  it('finishes cleanup when serialized config fails for Discord audit D-011', async () => {
    // ROOT CAUSE:
    //
    // stop awaited the serialized runtime-config task inside one broad try block.
    // A rejected Discord login jumped directly to catch, skipping the final
    // Discord destroy and AIRI channel close boundaries.
    //
    // Before: failed config work left both transports open after stop rejected.
    // After: stop records the first failure, deterministically attempts every
    // cleanup boundary, and only then rethrows the original failure.
    runtimeMocks.discordLogin.mockRejectedValueOnce(new Error('synthetic login failure'))
    const adapter = new DiscordAdapter({
      discordToken: 'synthetic-discord-bot-token',
    })

    // @example
    await expect(adapter.applyRuntimeConfig({ enabled: true })).rejects.toThrow('synthetic login failure')
    // @example
    await expect(adapter.stop()).rejects.toThrow('synthetic login failure')

    // @example
    expect(runtimeMocks.discordDestroy).toHaveBeenCalledTimes(1)
    // @example
    expect(runtimeMocks.airiClose).toHaveBeenCalledTimes(1)
  })
})
