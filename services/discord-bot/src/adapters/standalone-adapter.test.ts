import type { Readable } from 'node:stream'

import type { VoiceDiagnosticsObserver } from '../bots/discord/commands/voiceDiagnostics'
import type { SafeDiscordTextPayload } from './discordSend'

import { Buffer } from 'node:buffer'
import { PassThrough } from 'node:stream'

import { Events, MessageReferenceType, MessageType, PermissionFlagsBits, PermissionsBitField } from 'discord.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { VoiceManager } from '../bots/discord/commands/summon'
import { StandaloneChatRuntime, StandaloneChatRuntimeError } from '../standalone/chat-runtime'
import { StandaloneSpeechRuntime } from '../standalone/speech-runtime'
import { resolveDiscordReplyReference } from './discordSend'
import { formatStandaloneDiscordReplyError, resolveStandaloneDiscordSendPermission, resolveStandaloneDiscordSessionId, StandaloneDiscordAdapter } from './standalone-adapter'

const registrationMocks = vi.hoisted(() => ({
  register: vi.fn(async () => {}),
}))

vi.mock('../bots/discord/commands/registration', () => ({
  registerStandaloneDiscordCommands: registrationMocks.register,
}))

beforeEach(() => {
  registrationMocks.register.mockReset()
  registrationMocks.register.mockResolvedValue(undefined)
})

/**
 * @example
 * describe('resolveStandaloneDiscordSendPermission', () => {})
 */
describe('resolveStandaloneDiscordSendPermission', () => {
  /**
   * @example
   * it('allows direct messages without guild permission state', () => {})
   */
  it('allows direct messages without guild permission state', () => {
    expect(resolveStandaloneDiscordSendPermission({
      directMessage: true,
      thread: false,
    })).toEqual({ allowed: true })
  })

  /**
   * @example
   * it('requires view and send permissions in regular guild channels', () => {})
   */
  it('requires view and send permissions in regular guild channels', () => {
    expect(resolveStandaloneDiscordSendPermission({
      directMessage: false,
      permissions: new PermissionsBitField(PermissionFlagsBits.ViewChannel),
      thread: false,
    })).toEqual({
      allowed: false,
      missingPermissions: ['SEND_MESSAGES'],
    })

    expect(resolveStandaloneDiscordSendPermission({
      directMessage: false,
      permissions: new PermissionsBitField([
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ViewChannel,
      ]),
      thread: false,
    })).toEqual({ allowed: true })
  })

  /**
   * @example
   * it('uses the thread-specific send permission and current thread state', () => {})
   */
  it('uses the thread-specific send permission and current thread state', () => {
    expect(resolveStandaloneDiscordSendPermission({
      directMessage: false,
      permissions: new PermissionsBitField([
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ViewChannel,
      ]),
      thread: true,
      threadSendable: true,
    })).toEqual({
      allowed: false,
      missingPermissions: ['SEND_MESSAGES_IN_THREADS'],
    })

    expect(resolveStandaloneDiscordSendPermission({
      directMessage: false,
      permissions: new PermissionsBitField([
        PermissionFlagsBits.SendMessagesInThreads,
        PermissionFlagsBits.ViewChannel,
      ]),
      thread: true,
      threadSendable: false,
    })).toEqual({
      allowed: false,
      missingPermissions: ['THREAD_NOT_SENDABLE'],
    })
  })

  /**
   * @example
   * it('fails closed when guild permission state is unavailable', () => {})
   */
  it('fails closed when guild permission state is unavailable', () => {
    expect(resolveStandaloneDiscordSendPermission({
      directMessage: false,
      thread: false,
    })).toEqual({
      allowed: false,
      missingPermissions: ['PERMISSION_STATE_UNAVAILABLE'],
    })
  })
})

/**
 * @example
 * describe('standalone ignored-message event throttling', () => {})
 */
describe('standalone ignored-message event throttling', () => {
  /**
   * @example
   * it('prunes expired mention throttle keys', () => {})
   */
  it('bounds, expires, and clears mention throttle keys for Discord audit D-012', async () => {
    let now = 0
    const adapter = new StandaloneDiscordAdapter({
      now: () => now,
      runtime: new StandaloneChatRuntime({
        apiKey: 'test-key',
        discordRulesByGuild: {},
        maxHistoryMessages: 4,
        model: 'test-model',
        systemPrompt: 'You are AIRI.',
      }, async () => ({ text: 'reply' })),
    })
    const recordIgnoredMessage = Reflect.get(adapter, 'recordIgnoredMessage')

    // ROOT CAUSE:
    //
    // Expiration alone did not bound keys created within one sweep interval, and
    // stop left the last retained keys behind. High-cardinality guild/channel
    // traffic could therefore grow process state until the next sweep and retain
    // it across deterministic adapter cleanup.
    for (let index = 0; index < 300; index += 1)
      Reflect.apply(recordIgnoredMessage, adapter, [`server / channel-${index}`, 'mention-required'])
    expect(Reflect.get(adapter, 'ignoredMessageEventTimestamps')).toHaveProperty('size', 256)

    now = 30_001
    Reflect.apply(recordIgnoredMessage, adapter, ['server / channel-fresh', 'mention-required'])
    expect(Reflect.get(adapter, 'ignoredMessageEventTimestamps')).toHaveProperty('size', 1)

    await adapter.stop()
    expect(Reflect.get(adapter, 'ignoredMessageEventTimestamps')).toHaveProperty('size', 0)
  })
})

/**
 * @example
 * describe('standalone Discord lifecycle cleanup', () => {})
 */
describe('standalone Discord lifecycle cleanup', () => {
  /**
   * @example
   * it('keeps Discord identities and raw lifecycle errors out of adapter observability', async () => {})
   */
  it('keeps Discord identities and raw lifecycle errors out of adapter observability', async () => {
    const sentinels = [
      'synthetic-adapter-guild-name-sentinel',
      '949494949494949494',
      'https://synthetic.invalid/private?credential=sentinel',
      'synthetic-user-message-sentinel',
    ]
    const observedEvents: unknown[] = []
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const consoleInfo = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const runtime = new StandaloneChatRuntime({
      apiKey: 'synthetic-key',
      discordRulesByGuild: {},
      maxHistoryMessages: 4,
      model: 'synthetic-model',
      systemPrompt: 'Synthetic system prompt.',
    }, async () => ({ text: 'synthetic reply' }))
    const adapter = new StandaloneDiscordAdapter({
      events: {
        onIngressFailed: event => observedEvents.push(event),
        onMessageAccepted: event => observedEvents.push(event),
        onMessageIgnored: event => observedEvents.push(event),
        onMessageRejected: event => observedEvents.push(event),
        onReplyFailed: event => observedEvents.push(event),
      },
      filterConfig: { auditLogEnabled: true },
      runtime,
      typingRefreshIntervalMs: 5,
    })
    const rawFailure = new Error(`${sentinels[3]} ${sentinels[2]}`)
    rawFailure.name = sentinels[0]
    const voiceManager = Reflect.get(adapter, 'voiceManager')
    vi.spyOn(voiceManager, 'handleVoiceStateUpdate').mockRejectedValue(rawFailure)
    vi.spyOn(voiceManager, 'handleConsentInteraction').mockRejectedValue(rawFailure)

    // ROOT CAUSE:
    //
    // Typing, interaction, ingress, and voice-state boundaries serialized raw
    // Error.message values or Discord guild/channel/user identifiers. Audit
    // records also accepted arbitrary fields and therefore persisted the same
    // values when local audit logging was enabled.
    await Reflect.apply(Reflect.get(adapter, 'paceIncomingText'), adapter, [{
      sendTyping: async () => {
        throw rawFailure
      },
    }])
    vi.useFakeTimers()
    let finishTypingRefresh = () => {}
    const typingRefreshTask = Reflect.apply(Reflect.get(adapter, 'withTypingKeepAlive'), adapter, [{
      sendTyping: async () => {
        throw rawFailure
      },
    }, () => new Promise<void>((resolve) => {
      finishTypingRefresh = resolve
    })]) as Promise<void>
    await vi.advanceTimersByTimeAsync(5)
    finishTypingRefresh()
    await typingRefreshTask
    vi.useRealTimers()
    await Reflect.apply(Reflect.get(adapter, 'handleDiscordInteractionSafely'), adapter, [{
      isButton: () => true,
      isChatInputCommand: () => false,
    }])
    Reflect.apply(Reflect.get(adapter, 'recordDiscordIngressFailure'), adapter, [{
      author: { bot: false, id: sentinels[1], username: sentinels[0] },
      channelId: sentinels[1],
      guild: { name: sentinels[0] },
      guildId: sentinels[1],
    }, rawFailure])
    await Reflect.apply(Reflect.get(adapter, 'handleDiscordVoiceStateUpdateSafely'), adapter, [
      { channelId: sentinels[1], guild: { id: sentinels[1] }, id: sentinels[1] },
      { channelId: null, guild: { id: sentinels[1] }, id: sentinels[1] },
    ])

    const serialized = JSON.stringify({
      console: [...consoleError.mock.calls, ...consoleInfo.mock.calls, ...consoleWarn.mock.calls],
      events: observedEvents,
    })
    for (const sentinel of sentinels) {
      // @example
      expect(serialized).not.toContain(sentinel)
    }

    await adapter.stop()
    consoleError.mockRestore()
    consoleInfo.mockRestore()
    consoleWarn.mockRestore()
  })

  /**
   * @example
   * it('reproduces Discord audit D-016 by sharing one pending login across concurrent starts', async () => {})
   */
  it('reproduces Discord audit D-016 by sharing one pending login across concurrent starts', async () => {
    let resolveLogin = (_token: string) => {}
    const loginPending = new Promise<string>((resolve) => {
      resolveLogin = resolve
    })
    const runtime = new StandaloneChatRuntime({
      apiKey: 'synthetic-key',
      discordRulesByGuild: {},
      maxHistoryMessages: 4,
      model: 'synthetic-model',
      systemPrompt: 'Synthetic system prompt.',
    }, async () => ({ text: 'synthetic reply' }))
    const adapter = new StandaloneDiscordAdapter({
      discordToken: 'synthetic-discord-token',
      runtime,
    })
    const login = vi.spyOn(Reflect.get(adapter, 'discordClient'), 'login').mockImplementation(() => loginPending)

    // ROOT CAUSE:
    //
    // start() owned no pending task or connected state. Concurrent dashboard
    // starts called Client.login independently, creating duplicate gateway
    // lifecycles and allowing either completion to mutate the same adapter.
    const startA = adapter.start()
    const startB = adapter.start()
    /**
     * @example
     * expect(startB).toBe(startA)
     */
    expect(startB).toBe(startA)
    /**
     * @example
     * expect(login).toHaveBeenCalledOnce()
     */
    expect(login).toHaveBeenCalledOnce()
    resolveLogin('synthetic-discord-token')
    await Promise.all([startA, startB])
    await adapter.start()
    /**
     * @example
     * expect(login).toHaveBeenCalledOnce()
     */
    expect(login).toHaveBeenCalledOnce()
    await adapter.stop()
  })

  /**
   * @example
   * it('reproduces Discord audit D-016 by draining a pending login before destroy and permitting failed-start retry', async () => {})
   */
  it('reproduces Discord audit D-016 by draining a pending login before destroy and permitting failed-start retry', async () => {
    let resolveLogin = (_token: string) => {}
    const loginPending = new Promise<string>((resolve) => {
      resolveLogin = resolve
    })
    const statuses: string[] = []
    const runtime = new StandaloneChatRuntime({
      apiKey: 'synthetic-key',
      discordRulesByGuild: {},
      maxHistoryMessages: 4,
      model: 'synthetic-model',
      systemPrompt: 'Synthetic system prompt.',
    }, async () => ({ text: 'synthetic reply' }))
    const adapter = new StandaloneDiscordAdapter({
      discordToken: 'synthetic-discord-token',
      events: { onStatusChange: event => statuses.push(event.status) },
      runtime,
    })
    const discordClient = Reflect.get(adapter, 'discordClient')
    const login = vi.spyOn(discordClient, 'login')
      .mockImplementationOnce(() => loginPending)
    const destroy = vi.spyOn(discordClient, 'destroy').mockImplementation(() => {})
    vi.spyOn(Reflect.get(adapter, 'voiceManager'), 'stop').mockResolvedValue(undefined)
    vi.spyOn(runtime, 'stop').mockResolvedValue(undefined)

    const startTask = adapter.start()
    let stopSettled = false
    const stopTask = adapter.stop().finally(() => {
      stopSettled = true
    })
    await new Promise<void>(resolve => setImmediate(resolve))

    // ROOT CAUSE:
    //
    // stop() did not own or await Client.login. It destroyed the client while
    // login was still pending, then the late login completion could revive the
    // stopped adapter and emit ready state after all cleanup had reported done.
    /**
     * @example
     * expect(stopSettled).toBe(false)
     */
    expect(stopSettled).toBe(false)
    /**
     * @example
     * expect(destroy).not.toHaveBeenCalled()
     */
    expect(destroy).not.toHaveBeenCalled()
    resolveLogin('synthetic-discord-token')
    await startTask
    await stopTask
    /**
     * @example
     * expect(destroy).toHaveBeenCalledOnce()
     */
    expect(destroy).toHaveBeenCalledOnce()
    /**
     * @example
     * expect(statuses).toEqual(['starting', 'stopping', 'stopped'])
     */
    expect(statuses).toEqual(['starting', 'stopping', 'stopped'])
    /**
     * @example
     * await expect(adapter.start()).rejects.toThrow('stopped')
     */
    await expect(adapter.start()).rejects.toThrow('stopped')
    /**
     * @example
     * expect(login).toHaveBeenCalledOnce()
     */
    expect(login).toHaveBeenCalledOnce()

    const retryAdapter = new StandaloneDiscordAdapter({
      discordToken: 'synthetic-discord-token',
      runtime: new StandaloneChatRuntime({
        apiKey: 'synthetic-key',
        discordRulesByGuild: {},
        maxHistoryMessages: 4,
        model: 'synthetic-model',
        systemPrompt: 'Synthetic system prompt.',
      }, async () => ({ text: 'synthetic reply' })),
    })
    const retryLogin = vi.spyOn(Reflect.get(retryAdapter, 'discordClient'), 'login')
      .mockRejectedValueOnce(new Error('synthetic login failure'))
      .mockResolvedValueOnce('synthetic-discord-token')
    await expect(retryAdapter.start()).rejects.toThrow('synthetic login failure')
    await expect(retryAdapter.start()).resolves.toBeUndefined()
    /**
     * @example
     * expect(retryLogin).toHaveBeenCalledTimes(2)
     */
    expect(retryLogin).toHaveBeenCalledTimes(2)
    await retryAdapter.stop()
  })

  /**
   * @example
   * it('reproduces Discord audit D-016 by draining pending command registration without late ready state', async () => {})
   */
  it('reproduces Discord audit D-016 by draining pending command registration without late ready state', async () => {
    let resolveRegistration = () => {}
    const registrationPending = new Promise<void>((resolve) => {
      resolveRegistration = resolve
    })
    registrationMocks.register.mockReturnValue(registrationPending)
    const statuses: string[] = []
    let readyCount = 0
    const runtime = new StandaloneChatRuntime({
      apiKey: 'synthetic-key',
      discordRulesByGuild: {},
      maxHistoryMessages: 4,
      model: 'synthetic-model',
      systemPrompt: 'Synthetic system prompt.',
    }, async () => ({ text: 'synthetic reply' }))
    const adapter = new StandaloneDiscordAdapter({
      discordToken: 'synthetic-discord-token',
      events: {
        onReady: () => {
          readyCount += 1
        },
        onStatusChange: event => statuses.push(event.status),
      },
      runtime,
    })
    const discordClient = Reflect.get(adapter, 'discordClient')
    vi.spyOn(discordClient, 'destroy').mockImplementation(() => {})
    vi.spyOn(Reflect.get(adapter, 'voiceManager'), 'stop').mockResolvedValue(undefined)
    vi.spyOn(runtime, 'stop').mockResolvedValue(undefined)
    discordClient.emit(Events.ClientReady, {
      user: { id: 'bot-user', tag: 'synthetic-bot' },
    })
    await vi.waitFor(() => {
      /**
       * @example
       * expect(registrationMocks.register).toHaveBeenCalledOnce()
       */
      expect(registrationMocks.register).toHaveBeenCalledOnce()
    })

    // ROOT CAUSE:
    //
    // ClientReady launched command registration as an unowned promise. stop()
    // removed the listener but neither tracked nor drained work already started,
    // so late completion emitted onReady/status=ready after stopped cleanup.
    let stopSettled = false
    const stopTask = adapter.stop().finally(() => {
      stopSettled = true
    })
    await new Promise<void>(resolve => setImmediate(resolve))
    /**
     * @example
     * expect(stopSettled).toBe(false)
     */
    expect(stopSettled).toBe(false)
    resolveRegistration()
    await stopTask
    /**
     * @example
     * expect(readyCount).toBe(0)
     */
    expect(readyCount).toBe(0)
    /**
     * @example
     * expect(statuses).toEqual(['stopping', 'stopped'])
     */
    expect(statuses).toEqual(['stopping', 'stopped'])
    /**
     * @example
     * expect(commandRegistrationTask).toBeUndefined()
     */
    expect(Reflect.get(adapter, 'commandRegistrationTask')).toBeUndefined()
  })

  /**
   * @example
   * it('reproduces Discord audit D-016 by draining every adapter owner after one cleanup rejects', async () => {})
   */
  it('reproduces Discord audit D-016 by draining every adapter owner after one cleanup rejects', async () => {
    const statuses: string[] = []
    const runtime = new StandaloneChatRuntime({
      apiKey: 'synthetic-key',
      discordRulesByGuild: {},
      maxHistoryMessages: 4,
      model: 'synthetic-model',
      systemPrompt: 'Synthetic system prompt.',
    }, async () => ({ text: 'synthetic reply' }))
    const adapter = new StandaloneDiscordAdapter({
      events: {
        onStatusChange: event => statuses.push(event.status),
      },
      runtime,
    })
    const voiceFailure = new Error('synthetic voice cleanup failure')
    const runtimeFailure = new Error('synthetic runtime cleanup failure')
    const stopVoice = vi.spyOn(Reflect.get(adapter, 'voiceManager'), 'stop').mockRejectedValue(voiceFailure)
    const destroyDiscord = vi.spyOn(Reflect.get(adapter, 'discordClient'), 'destroy').mockImplementation(() => {})
    const stopRuntime = vi.spyOn(runtime, 'stop').mockRejectedValue(runtimeFailure)
    let releaseInFlight = () => {}
    const inFlight = new Promise<void>((resolve) => {
      releaseInFlight = resolve
    })
    Reflect.get(adapter, 'inFlightMessages').add(inFlight)

    // ROOT CAUSE:
    //
    // Adapter stop awaited voice cleanup and Discord destruction in one
    // fail-fast try, then awaited runtime stop and in-flight work sequentially
    // in finally. A voice or runtime rejection skipped later owners, could replace
    // the first failure, and left deterministic task registries uncleared.
    let stopSettled = false
    const stopResult = adapter.stop().then(
      () => ({ error: undefined, rejected: false }),
      error => ({ error, rejected: true }),
    ).finally(() => {
      stopSettled = true
    })
    await new Promise<void>(resolve => setImmediate(resolve))
    const settledBeforeDrain = stopSettled
    releaseInFlight()
    const result = await stopResult

    /**
     * @example
     * expect(settledBeforeDrain).toBe(false)
     */
    expect(settledBeforeDrain).toBe(false)
    /**
     * @example
     * expect(result).toEqual({ error: voiceFailure, rejected: true })
     */
    expect(result).toEqual({ error: voiceFailure, rejected: true })
    /**
     * @example
     * expect(stopVoice).toHaveBeenCalledOnce()
     */
    expect(stopVoice).toHaveBeenCalledOnce()
    /**
     * @example
     * expect(destroyDiscord).toHaveBeenCalledOnce()
     */
    expect(destroyDiscord).toHaveBeenCalledOnce()
    /**
     * @example
     * expect(stopRuntime).toHaveBeenCalledOnce()
     */
    expect(stopRuntime).toHaveBeenCalledOnce()
    /**
     * @example
     * expect(inFlightMessages.size).toBe(0)
     */
    expect(Reflect.get(adapter, 'inFlightMessages').size).toBe(0)
    /**
     * @example
     * expect(statuses).toEqual(['stopping', 'error'])
     */
    expect(statuses).toEqual(['stopping', 'error'])
  })

  /**
   * @example
   * it('keeps the exact failed Discord audit D-019 client cleanup retryable', async () => {})
   */
  it('keeps the exact failed Discord audit D-019 client cleanup retryable', async () => {
    const statuses: string[] = []
    const runtime = new StandaloneChatRuntime({
      apiKey: 'synthetic-key',
      discordRulesByGuild: {},
      maxHistoryMessages: 4,
      model: 'synthetic-model',
      systemPrompt: 'Synthetic system prompt.',
    }, async () => ({ text: 'synthetic reply' }))
    const adapter = new StandaloneDiscordAdapter({
      discordToken: 'synthetic-discord-token',
      events: {
        onStatusChange: event => statuses.push(event.status),
      },
      runtime,
    })
    const destroyFailure = new Error('SYNTHETIC_D019_DESTROY_FAILURE')
    const destroyDiscord = vi.spyOn(Reflect.get(adapter, 'discordClient'), 'destroy')
      .mockRejectedValueOnce(destroyFailure)
      .mockResolvedValueOnce(undefined)
    const loginDiscord = vi.spyOn(Reflect.get(adapter, 'discordClient'), 'login')
      .mockResolvedValue('synthetic-discord-token')
    vi.spyOn(Reflect.get(adapter, 'voiceManager'), 'stop').mockResolvedValue(undefined)
    vi.spyOn(runtime, 'stop').mockResolvedValue(undefined)

    // ROOT CAUSE:
    //
    // stop() marked the adapter stopped and emitted `stopped` before checking
    // aggregated cleanup failures. A rejected Client.destroy therefore made the
    // still-live client unreachable: every later stop returned early instead of
    // retrying the exact owner. Final stopped state must publish only after a
    // retry has completed all cleanup owners successfully.
    await expect(adapter.stop()).rejects.toBe(destroyFailure)
    /**
     * @example
     * expect(statuses).toEqual(['stopping', 'error'])
     */
    expect(statuses).toEqual(['stopping', 'error'])
    /**
     * @example
     * expect(Reflect.get(adapter, 'stopped')).toBe(false)
     */
    expect(Reflect.get(adapter, 'stopped')).toBe(false)
    /**
     * @example
     * await expect(adapter.start()).rejects.toThrow('cleanup must complete')
     */
    await expect(adapter.start()).rejects.toThrow('cleanup must complete')
    /**
     * @example
     * expect(loginDiscord).not.toHaveBeenCalled()
     */
    expect(loginDiscord).not.toHaveBeenCalled()

    await expect(adapter.stop()).resolves.toBeUndefined()
    /**
     * @example
     * expect(destroyDiscord).toHaveBeenCalledTimes(2)
     */
    expect(destroyDiscord).toHaveBeenCalledTimes(2)
    /**
     * @example
     * expect(statuses).toEqual(['stopping', 'error', 'stopping', 'stopped'])
     */
    expect(statuses).toEqual(['stopping', 'error', 'stopping', 'stopped'])
    /**
     * @example
     * expect(Reflect.get(adapter, 'stopped')).toBe(true)
     */
    expect(Reflect.get(adapter, 'stopped')).toBe(true)
  })

  /**
   * @example
   * it('reproduces Discord audit D-016 by observing voice-state cleanup rejection at the EventEmitter boundary', async () => {})
   */
  it('reproduces Discord audit D-016 by observing voice-state cleanup rejection at the EventEmitter boundary', async () => {
    const runtime = new StandaloneChatRuntime({
      apiKey: 'synthetic-key',
      discordRulesByGuild: {},
      maxHistoryMessages: 4,
      model: 'synthetic-model',
      systemPrompt: 'Synthetic system prompt.',
    }, async () => ({ text: 'synthetic reply' }))
    const adapter = new StandaloneDiscordAdapter({ runtime })
    const cleanupFailure = new Error('synthetic voice-state cleanup failure')
    vi.spyOn(Reflect.get(adapter, 'voiceManager'), 'handleVoiceStateUpdate').mockRejectedValue(cleanupFailure)
    const discordClient = Reflect.get(adapter, 'discordClient')
    const listener = discordClient.listeners(Events.VoiceStateUpdate)[0]
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    // ROOT CAUSE:
    //
    // VoiceStateUpdate bypassed the adapter's safe ingress boundary. A rejected
    // exact-generation cleanup left both the original task and the promise
    // returned by finally unobserved, so Discord's EventEmitter produced an
    // unhandled rejection instead of sanitized lifecycle telemetry.
    Reflect.apply(listener, discordClient, [
      { channelId: 'voice-old', guild: { id: 'guild-1' }, id: 'user-1' },
      { channelId: null, guild: { id: 'guild-1' }, id: 'user-1' },
    ])
    await new Promise<void>(resolve => setImmediate(resolve))

    /**
     * @example
     * expect(consoleError).toHaveBeenCalledWith(message, fields)
     */
    expect(consoleError).toHaveBeenCalledWith(
      '[discord-bot:standalone] voice-state lifecycle cleanup failed',
      {
        failureCategory: 'discord-voice-cleanup-failure',
        status: 'cleanup-failed',
      },
    )
    /**
     * @example
     * expect(inFlightVoiceStateUpdates.size).toBe(0)
     */
    expect(Reflect.get(adapter, 'inFlightVoiceStateUpdates').size).toBe(0)
    consoleError.mockRestore()
  })
})

/**
 * @example
 * describe('standalone privacy notice routing', () => {})
 */
describe('standalone privacy notice routing', () => {
  /**
   * @example
   * it('bounds and expires privacy notice state for Discord audit D-012', async () => {})
   */
  it('bounds, expires, and clears privacy notice state for Discord audit D-012', async () => {
    let now = 0
    const adapter = new StandaloneDiscordAdapter({
      filterConfig: {
        messagePacingMs: 0,
        privacyNoticeEnabled: true,
        privacyNoticeText: 'Synthetic privacy disclosure.',
      },
      now: () => now,
      runtime: new StandaloneChatRuntime({
        apiKey: 'synthetic-key',
        discordRulesByGuild: {},
        maxHistoryMessages: 4,
        model: 'synthetic-model',
        systemPrompt: 'Synthetic system prompt.',
      }, async () => ({ text: 'synthetic reply' })),
    })
    const target = { send: vi.fn(async () => {}) }
    const sendPrivacyNotice = Reflect.get(adapter, 'sendPrivacyNoticeIfNeeded')
    const generation = Reflect.get(adapter, 'lifecycleGeneration') as number

    // ROOT CAUSE:
    //
    // Successful disclosures were stored in a process-lifetime Set. Every new
    // exact session permanently increased state, and stop did not clear it.
    // The same Set also meant a long-lived session never received the notice
    // again after the documented disclosure retention window.
    for (let index = 0; index < 257; index += 1) {
      await Reflect.apply(sendPrivacyNotice, adapter, [
        target,
        `discord-dm-user-${index}`,
        generation,
        `user-${index}`,
      ])
    }
    expect(Reflect.get(adapter, 'privacyNoticeSessionIds')).toHaveProperty('size', 256)

    now = 24 * 60 * 60 * 1000 + 1
    await Reflect.apply(sendPrivacyNotice, adapter, [
      target,
      'discord-dm-user-256',
      generation,
      'user-256',
    ])
    expect(target.send).toHaveBeenCalledTimes(258)

    await adapter.stop()
    expect(Reflect.get(adapter, 'privacyNoticeSessionIds')).toHaveProperty('size', 0)
  })

  /**
   * @example
   * it('sends the DM privacy notice as a separate message before the first reply', async () => {})
   */
  it('sends the DM privacy notice as a separate message before the first reply', async () => {
    const sent: string[] = []
    const privacyNotice = 'DM memory is enabled by default. Use memory off to disable it.'
    const adapter = new StandaloneDiscordAdapter({
      filterConfig: {
        messagePacingMs: 0,
        privacyNoticeEnabled: true,
        privacyNoticeText: privacyNotice,
      },
      runtime: new StandaloneChatRuntime({
        apiKey: 'test-key',
        discordRulesByGuild: {},
        maxHistoryMessages: 4,
        model: 'test-model',
        systemPrompt: 'You are AIRI.',
      }, async () => ({ text: 'reply' })),
    })
    const channel = {
      isThread: () => false,
      send: async (payload: SafeDiscordTextPayload) => {
        sent.push(payload.content)
      },
    }
    const message = (content: string, id: string) => ({
      author: {
        bot: false,
        id: 'user-1',
        username: 'Owen',
      },
      channel,
      channelId: 'dm-channel',
      content,
      guild: undefined,
      guildId: undefined,
      id,
      inGuild: () => false,
      member: undefined,
    })
    const handleDiscordMessage = Reflect.get(adapter, 'handleDiscordMessage')
    await Reflect.apply(handleDiscordMessage, adapter, [message('hello', 'message-1')])
    await Reflect.apply(handleDiscordMessage, adapter, [message('hello again', 'message-2')])

    /**
     * @example
     * expect(sent).toEqual([privacyNotice, 'reply', 'reply'])
     */
    expect(sent).toEqual([privacyNotice, 'reply', 'reply'])
  })
})

/**
 * @example
 * describe('standalone uncached DM recovery', () => {})
 */
describe('standalone uncached DM recovery', () => {
  /**
   * @example
   * it('bounds orphan fetches per user and releases stop waiters for Discord audit D-012', async () => {})
   */
  it('bounds orphan fetches per user and releases stop waiters for Discord audit D-012', async () => {
    const adapter = new StandaloneDiscordAdapter({
      filterConfig: {
        messagePacingMs: 0,
        privacyNoticeEnabled: false,
      },
      runtime: new StandaloneChatRuntime({
        apiKey: 'synthetic-key',
        discordRulesByGuild: {},
        maxHistoryMessages: 4,
        model: 'synthetic-model',
        systemPrompt: 'Synthetic system prompt.',
      }, async () => ({ text: 'synthetic reply' })),
    })
    const discordClient = Reflect.get(adapter, 'discordClient')
    let releaseUserAFetch = (_value: null) => {}
    const userAFetch = new Promise<null>((resolve) => {
      releaseUserAFetch = resolve
    })
    const fetchChannel = vi.spyOn(discordClient.channels, 'fetch').mockImplementation((channelId: string) => {
      if (channelId === 'dm-channel-b')
        return Promise.resolve(null)
      return userAFetch
    })
    const rawPacket = (messageId: string, channelId: string, userId: string) => ({
      d: {
        author: { id: userId },
        channel_id: channelId,
        id: messageId,
      },
      op: 0,
      s: 1,
      t: 'MESSAGE_CREATE',
    })

    // ROOT CAUSE:
    //
    // Raw uncached-DM recovery invoked Discord channel/message fetches directly
    // and retained every wrapper in inFlightMessages. A user could create
    // unbounded non-cancellable fetches, consume the process, and make stop wait
    // forever; no stable-principal reservation remained for an unrelated user.
    for (let index = 0; index < 5; index += 1)
      discordClient.emit(Events.Raw, rawPacket(`message-a-${index}`, `dm-channel-a-${index}`, 'user-a'))
    discordClient.emit(Events.Raw, rawPacket('message-b', 'dm-channel-b', 'user-b'))

    await vi.waitFor(() => {
      expect(fetchChannel.mock.calls.filter(([channelId]) => channelId === 'dm-channel-b')).toHaveLength(1)
    })
    expect(fetchChannel.mock.calls.filter(([channelId]) => typeof channelId === 'string' && channelId.startsWith('dm-channel-a-'))).toHaveLength(4)
    await vi.waitFor(() => {
      expect(Reflect.get(adapter, 'inFlightDirectMessageRecoveries')).toHaveProperty('size', 4)
    })

    let stopSettled = false
    const stopping = adapter.stop().then(() => {
      stopSettled = true
    })
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(stopSettled).toBe(true)

    releaseUserAFetch(null)
    await stopping
  })

  /**
   * @example
   * it('isolates Raw recovery ownership from canonical ingress for Discord audit D-011', async () => {})
   */
  it('isolates Raw recovery ownership from canonical ingress for Discord audit D-011', async () => {
    let releaseRawFetch = (_value: null) => {}
    const rawFetchGate = new Promise<null>((resolve) => {
      releaseRawFetch = resolve
    })
    let releaseProvider = (_value: { text: string }) => {}
    const providerGate = new Promise<{ text: string }>((resolve) => {
      releaseProvider = resolve
    })
    const onMessageRejected = vi.fn()
    const adapter = new StandaloneDiscordAdapter({
      events: { onMessageRejected },
      filterConfig: {
        messagePacingMs: 0,
        privacyNoticeEnabled: false,
        rateLimitMaxMessages: 100,
      },
      runtime: new StandaloneChatRuntime({
        apiKey: 'synthetic-key',
        discordRulesByGuild: {},
        maxHistoryMessages: 4,
        model: 'synthetic-model',
        systemPrompt: 'Synthetic system prompt.',
      }, async () => providerGate, undefined, {
        maxQueuedModelRequests: 100,
      }),
    })
    const discordClient = Reflect.get(adapter, 'discordClient')
    vi.spyOn(discordClient.channels, 'fetch').mockImplementation(() => rawFetchGate)
    const channel = {
      isThread: () => false,
      send: vi.fn(async () => {}),
    }

    // ROOT CAUSE:
    //
    // Raw DM recovery and canonical MessageCreate work shared one wrapper Set.
    // Thirty-two admitted deferred fetches plus thirty-two valid turns filled
    // that outer Set even though the canonical scheduler was only half full.
    // The next eight turns entered a misleading status reserve as normal model
    // work and the ninth was silently dropped. Each owning boundary now tracks
    // only its own hard-capped work.
    for (let index = 0; index < 32; index += 1) {
      discordClient.emit(Events.Raw, {
        d: {
          author: { id: `raw-user-${index}` },
          channel_id: `raw-channel-${index}`,
          id: `raw-message-${index}`,
        },
        op: 0,
        s: index,
        t: 'MESSAGE_CREATE',
      })
    }
    for (let index = 0; index < 41; index += 1) {
      discordClient.emit(Events.MessageCreate, {
        author: { bot: false, id: `user-${index}`, username: `user-${index}` },
        channel,
        channelId: `dm-channel-${index}`,
        content: `synthetic request ${index}`,
        guild: undefined,
        guildId: undefined,
        id: `message-${index}`,
        inGuild: () => false,
        member: undefined,
      })
    }

    /** @example expect(Reflect.get(adapter, 'inFlightDirectMessageRecoveries')).toHaveProperty('size', 32) */
    expect(Reflect.get(adapter, 'inFlightDirectMessageRecoveries')).toHaveProperty('size', 32)
    /** @example expect(Reflect.get(adapter, 'ingressScheduler')).toHaveProperty('pendingCount', 41) */
    expect(Reflect.get(adapter, 'ingressScheduler')).toHaveProperty('pendingCount', 41)
    /** @example expect(Reflect.get(adapter, 'inFlightMessages')).toHaveProperty('size', 41) */
    expect(Reflect.get(adapter, 'inFlightMessages')).toHaveProperty('size', 41)
    /** @example expect(Reflect.get(adapter, 'inFlightMessageCapacityStatuses')).toHaveProperty('size', 0) */
    expect(Reflect.get(adapter, 'inFlightMessageCapacityStatuses')).toHaveProperty('size', 0)
    /** @example expect(onMessageRejected).not.toHaveBeenCalled() */
    expect(onMessageRejected).not.toHaveBeenCalled()

    releaseRawFetch(null)
    releaseProvider({ text: 'synthetic reply' })
    await vi.waitFor(() => {
      expect(Reflect.get(adapter, 'inFlightDirectMessageRecoveries')).toHaveProperty('size', 0)
      expect(Reflect.get(adapter, 'inFlightMessages')).toHaveProperty('size', 0)
    })
    await adapter.stop()
  })

  /**
   * @example
   * it('hard-caps synchronous message wrapper ownership for Discord audit D-011', async () => {})
   */
  it('hard-caps synchronous message wrapper ownership for Discord audit D-011', async () => {
    let releaseProvider = (_value: { text: string }) => {}
    const providerGate = new Promise<{ text: string }>((resolve) => {
      releaseProvider = resolve
    })
    const onMessageRejected = vi.fn()
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const adapter = new StandaloneDiscordAdapter({
      events: { onMessageRejected },
      filterConfig: {
        messagePacingMs: 0,
        privacyNoticeEnabled: false,
        rateLimitMaxMessages: 100,
      },
      runtime: new StandaloneChatRuntime({
        apiKey: 'synthetic-key',
        discordRulesByGuild: {},
        maxHistoryMessages: 4,
        model: 'synthetic-model',
        systemPrompt: 'Synthetic system prompt.',
      }, async () => providerGate, undefined, {
        maxQueuedModelRequests: 100,
      }),
    })
    const discordClient = Reflect.get(adapter, 'discordClient')
    const channel = {
      isThread: () => false,
      send: vi.fn(async () => {}),
    }

    // ROOT CAUSE:
    //
    // Even capacity-rejected async handlers return a promise. Adding every
    // wrapper before the microtask checkpoint let one synchronous EventEmitter
    // burst grow inFlightMessages without a hard bound despite the inner queue.
    // The first outer cap then silently dropped overload before the scheduler's
    // user-visible queue-full reply, so audit-disabled deployments gave the user
    // no rejection status. The adapter now owns a separate bounded delivery
    // reserve for capacity replies while normal handler ownership stays capped.
    for (let index = 0; index < 73; index += 1) {
      discordClient.emit(Events.MessageCreate, {
        author: { bot: false, id: `user-${index}`, username: `user-${index}` },
        channel,
        channelId: `dm-channel-${index}`,
        content: `synthetic request ${index}`,
        guild: undefined,
        guildId: undefined,
        id: `message-${index}`,
        inGuild: () => false,
        member: undefined,
      })
    }

    /** @example expect(Reflect.get(adapter, 'inFlightMessages')).toHaveProperty('size', 64) */
    expect(Reflect.get(adapter, 'inFlightMessages')).toHaveProperty('size', 64)
    /** @example expect(Reflect.get(adapter, 'inFlightMessageCapacityStatuses')).toHaveProperty('size', 8) */
    expect(Reflect.get(adapter, 'inFlightMessageCapacityStatuses')).toHaveProperty('size', 8)
    /** @example expect(onMessageRejected).toHaveBeenCalledTimes(9) */
    expect(onMessageRejected).toHaveBeenCalledTimes(9)
    /** @example expect(onMessageRejected).toHaveBeenCalledWith({ reason: 'queue-full', surface }) */
    expect(onMessageRejected).toHaveBeenCalledWith({
      operationSequence: 65,
      reason: 'queue-full',
      surface: 'text-direct-message',
    })
    /** @example expect(consoleWarn).toHaveBeenCalledWith(message, fields) */
    expect(consoleWarn).toHaveBeenCalledWith(
      '[discord-bot:standalone] message handler capacity reached',
      {
        status: 'capacity-status-reserve-exhausted',
        transport: 'message-create',
      },
    )
    await vi.waitFor(() => {
      /** @example expect(channel.send).toHaveBeenCalledTimes(8) */
      expect(channel.send).toHaveBeenCalledTimes(8)
    })

    releaseProvider({ text: 'synthetic reply' })
    await vi.waitFor(() => {
      /** @example expect(Reflect.get(adapter, 'inFlightMessages')).toHaveProperty('size', 0) */
      expect(Reflect.get(adapter, 'inFlightMessages')).toHaveProperty('size', 0)
      /** @example expect(Reflect.get(adapter, 'inFlightMessageCapacityStatuses')).toHaveProperty('size', 0) */
      expect(Reflect.get(adapter, 'inFlightMessageCapacityStatuses')).toHaveProperty('size', 0)
    })
    await adapter.stop()
    consoleWarn.mockRestore()
  })

  /**
   * @example
   * it('hard-caps synchronous interaction ownership for Discord audit D-013', async () => {})
   */
  it('hard-caps synchronous interaction ownership for Discord audit D-013', async () => {
    let releaseVoiceState = () => {}
    const voiceStateGate = new Promise<void>((resolve) => {
      releaseVoiceState = resolve
    })
    const adapter = new StandaloneDiscordAdapter({
      runtime: new StandaloneChatRuntime({
        apiKey: 'synthetic-key',
        discordRulesByGuild: {},
        maxHistoryMessages: 4,
        model: 'synthetic-model',
        systemPrompt: 'Synthetic system prompt.',
      }, async () => ({ text: 'synthetic reply' })),
    })
    const voiceManager = Reflect.get(adapter, 'voiceManager')
    const handleVoiceStateUpdate = vi.spyOn(voiceManager, 'handleVoiceStateUpdate')
      .mockImplementation(() => voiceStateGate)
    const abortVoiceStateUpdateAtCapacity = vi.spyOn(voiceManager, 'abortVoiceStateUpdateAtCapacity')
    const discordClient = Reflect.get(adapter, 'discordClient')
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    // ROOT CAUSE:
    //
    // InteractionCreate and VoiceStateUpdate added every returned promise to a
    // process-lifetime Set without admission. A synchronous gateway burst could
    // therefore retain unbounded interaction and voice lifecycle work before
    // any promise settled. The listener boundary now rejects before invocation
    // once its exact owner pool reaches the documented hard cap.
    for (let index = 0; index < 65; index += 1) {
      discordClient.emit(
        Events.VoiceStateUpdate,
        { channelId: `old-${index}`, guild: { id: 'guild-1' }, id: `user-${index}` },
        { channelId: `new-${index}`, guild: { id: 'guild-1' }, id: `user-${index}` },
      )
    }

    /** @example expect(handleVoiceStateUpdate).toHaveBeenCalledTimes(64) */
    expect(handleVoiceStateUpdate).toHaveBeenCalledTimes(64)
    /** @example expect(Reflect.get(adapter, 'inFlightVoiceStateUpdates')).toHaveProperty('size', 64) */
    expect(Reflect.get(adapter, 'inFlightVoiceStateUpdates')).toHaveProperty('size', 64)
    /** @example expect(abortVoiceStateUpdateAtCapacity).toHaveBeenCalledOnce() */
    expect(abortVoiceStateUpdateAtCapacity).toHaveBeenCalledOnce()
    /** @example expect(consoleWarn).toHaveBeenCalledWith(message, fields) */
    expect(consoleWarn).toHaveBeenCalledWith(
      '[discord-bot:standalone] interaction handler capacity reached',
      {
        event: 'voice-state-update',
        safetyCleanupApplied: false,
        status: 'handler-capacity',
      },
    )

    releaseVoiceState()
    await vi.waitFor(() => {
      /** @example expect(Reflect.get(adapter, 'inFlightVoiceStateUpdates')).toHaveProperty('size', 0) */
      expect(Reflect.get(adapter, 'inFlightVoiceStateUpdates')).toHaveProperty('size', 0)
    })
    await adapter.stop()
    consoleWarn.mockRestore()
  })

  /**
   * @example
   * it('fails closed for consent withdrawal at interaction capacity for Discord audit D-007', async () => {})
   */
  it('fails closed for consent withdrawal at interaction capacity for Discord audit D-007', async () => {
    const adapter = new StandaloneDiscordAdapter({
      runtime: new StandaloneChatRuntime({
        apiKey: 'synthetic-key',
        discordRulesByGuild: {},
        maxHistoryMessages: 4,
        model: 'synthetic-model',
        systemPrompt: 'Synthetic system prompt.',
      }, async () => ({ text: 'synthetic reply' })),
    })
    const inFlightInteractions = Reflect.get(adapter, 'inFlightInteractions')
    for (let index = 0; index < 64; index += 1)
      inFlightInteractions.add(Promise.resolve(index).then(() => undefined))
    const voiceManager = Reflect.get(adapter, 'voiceManager')
    const handleConsentInteraction = vi.spyOn(voiceManager, 'handleConsentInteraction')
    const abortConsentWithdrawalAtCapacity = vi.spyOn(voiceManager, 'abortConsentWithdrawalAtCapacity')
      .mockReturnValue(true)
    const disconnectGuildVoiceAtCapacity = vi.spyOn(voiceManager, 'disconnectGuildVoiceAtCapacity')
      .mockReturnValue(true)
    const interaction = {
      customId: 'airi:voice-consent:withdraw:synthetic-consent',
      isButton: () => true,
      isChatInputCommand: () => false,
    }

    // ROOT CAUSE:
    //
    // The first interaction hard cap returned before dispatching every 65th
    // event. A consent withdrawal could therefore leave existing capture and
    // provider work authorized. Capacity handling must synchronously apply the
    // trusted withdrawal's fail-closed state transition instead of dropping it.
    Reflect.get(adapter, 'discordClient').emit(Events.InteractionCreate, interaction)

    /** @example expect(abortConsentWithdrawalAtCapacity).toHaveBeenCalledWith(interaction) */
    expect(abortConsentWithdrawalAtCapacity).toHaveBeenCalledWith(interaction)
    /** @example expect(handleConsentInteraction).not.toHaveBeenCalled() */
    expect(handleConsentInteraction).not.toHaveBeenCalled()

    const dismissInteraction = {
      commandName: 'dismiss',
      guildId: 'guild-1',
      inCachedGuild: () => true,
      isButton: () => false,
      isChatInputCommand: () => true,
      member: { roles: [] },
      memberPermissions: new PermissionsBitField(PermissionFlagsBits.ManageGuild),
    }
    Reflect.get(adapter, 'discordClient').emit(Events.InteractionCreate, dismissInteraction)
    /** @example expect(disconnectGuildVoiceAtCapacity).toHaveBeenCalledWith('guild-1') */
    expect(disconnectGuildVoiceAtCapacity).toHaveBeenCalledWith('guild-1')
    await adapter.stop()
  })
})

/**
 * @example
 * describe('standalone Discord text delivery', () => {})
 */
describe('standalone Discord text delivery', () => {
  /**
   * @example
   * it('counts a confirmed chunk and gates deferred invocation for Discord audit D-022', async () => {})
   */
  it('counts a confirmed chunk and gates deferred invocation for Discord audit D-022', async () => {
    const createDeliveryAdapter = () => new StandaloneDiscordAdapter({
      filterConfig: {
        messagePacingMs: 0,
        privacyNoticeEnabled: false,
      },
      runtime: new StandaloneChatRuntime({
        apiKey: 'synthetic-key',
        discordRulesByGuild: {},
        maxHistoryMessages: 4,
        model: 'synthetic-model',
        systemPrompt: 'Synthetic system prompt.',
      }, async () => ({ text: 'synthetic reply' })),
    })
    const adapter = createDeliveryAdapter()
    const generation = Reflect.get(adapter, 'lifecycleGeneration') as number
    let confirmFirstChunk = () => {}
    const confirmedTarget = {
      send: vi.fn(() => new Promise<void>((resolve) => {
        confirmFirstChunk = resolve
      })),
    }

    // ROOT CAUSE:
    //
    // Adapter callbacks checked generation again after a raw Discord send had
    // confirmed. A lifecycle flip in that gap returned false, so the shared
    // deliverer reported zero delivered chunks. Conversely, transport admission
    // defers invocation to a microtask and the bare operation could still call
    // Discord after synchronous stop.
    const confirmedDelivery = Reflect.apply(Reflect.get(adapter, 'deliverText'), adapter, [
      confirmedTarget,
      'X'.repeat(2_001),
      generation,
      'discord-user-confirmed',
    ]) as Promise<unknown>
    await vi.waitFor(() => {
      /** @example expect(confirmedTarget.send).toHaveBeenCalledOnce() */
      expect(confirmedTarget.send).toHaveBeenCalledOnce()
    })
    confirmFirstChunk()
    const stoppingAfterConfirmation = adapter.stop()
    /** @example await expect(confirmedDelivery).resolves.toEqual({ deliveredChunks: 1, status: 'cancelled', totalChunks: 2 }) */
    await expect(confirmedDelivery).resolves.toEqual({
      deliveredChunks: 1,
      status: 'cancelled',
      totalChunks: 2,
    })
    /** @example expect(confirmedTarget.send).toHaveBeenCalledOnce() */
    expect(confirmedTarget.send).toHaveBeenCalledOnce()
    await stoppingAfterConfirmation

    const stoppingAdapter = createDeliveryAdapter()
    const stoppingGeneration = Reflect.get(stoppingAdapter, 'lifecycleGeneration') as number
    const staleTarget = { send: vi.fn(async () => {}) }
    const staleDelivery = Reflect.apply(Reflect.get(stoppingAdapter, 'deliverText'), stoppingAdapter, [
      staleTarget,
      'SENTINEL_MUST_NOT_SEND',
      stoppingGeneration,
      'discord-user-stale',
    ]) as Promise<unknown>
    const stopping = stoppingAdapter.stop()

    /** @example await expect(staleDelivery).resolves.toEqual({ deliveredChunks: 0, status: 'cancelled', totalChunks: 1 }) */
    await expect(staleDelivery).resolves.toEqual({
      deliveredChunks: 0,
      status: 'cancelled',
      totalChunks: 1,
    })
    /** @example expect(staleTarget.send).not.toHaveBeenCalled() */
    expect(staleTarget.send).not.toHaveBeenCalled()
    await stopping
  })

  /**
   * @example
   * it('preserves graphemes and reports partial delivery for Discord audit D-022', async () => {})
   */
  it('preserves graphemes and reports partial delivery for Discord audit D-022', async () => {
    const family = '👨‍👩‍👧‍👦'
    const reply = `  ${'A'.repeat(1997)}${family}\n\n\n  tail  `
    const attempted: string[] = []
    const failures: unknown[] = []
    const adapter = new StandaloneDiscordAdapter({
      events: {
        onReplyFailed: payload => failures.push(payload),
      },
      filterConfig: {
        messagePacingMs: 0,
        privacyNoticeEnabled: false,
      },
      runtime: new StandaloneChatRuntime({
        apiKey: 'synthetic-key',
        discordRulesByGuild: {},
        maxHistoryMessages: 4,
        model: 'synthetic-model',
        systemPrompt: 'Synthetic system prompt.',
      }, async () => ({ text: reply })),
    })
    const channel = {
      isThread: () => false,
      send: vi.fn(async (payload: SafeDiscordTextPayload) => {
        attempted.push(payload.content)
        if (attempted.length === 2)
          throw new Error('SYNTHETIC_DISCORD_SEND_PRIVATE_DETAIL')
      }),
    }

    // ROOT CAUSE:
    //
    // Each adapter sliced at 2,000 UTF-16 code units and trimmed the remainder.
    // A boundary inside one emoji grapheme produced invalid Discord chunks. Even
    // after splitter unification, standalone normalized the provider reply first,
    // removing leading/trailing spaces and collapsing blank lines before delivery.
    // If chunk two failed, standalone also sent a fallback without reporting how
    // much of the original reply was delivered.
    Reflect.get(adapter, 'discordClient').emit(Events.MessageCreate, {
      author: { bot: false, id: 'user-1', username: 'Synthetic user' },
      channel,
      channelId: 'dm-channel',
      content: 'synthetic request',
      guild: undefined,
      guildId: undefined,
      id: 'message-d022',
      inGuild: () => false,
      member: undefined,
    })

    await vi.waitFor(() => {
      /** @example expect(failures).toHaveLength(1) */
      expect(failures).toHaveLength(1)
    })
    /** @example expect(attempted).toHaveLength(2) */
    expect(attempted).toHaveLength(2)
    /** @example expect(attempted.join('')).toBe(reply) */
    expect(attempted.join('')).toBe(reply)
    /** @example expect(attempted.some(chunk => chunk.includes(family))).toBe(true) */
    expect(attempted.some(chunk => chunk.includes(family))).toBe(true)
    /** @example expect(attempted.every(chunk => chunk.length <= 2000)).toBe(true) */
    expect(attempted.every(chunk => chunk.length <= 2000)).toBe(true)
    /** @example expect(failures[0]).toMatchObject({ deliveredChunks: 1, totalChunks: 2 }) */
    expect(failures[0]).toMatchObject({
      deliveredChunks: 1,
      deliveryReason: 'send-failure',
      errorKind: 'delivery-failure',
      errorName: 'DiscordTextDeliveryError',
      totalChunks: 2,
    })
    /** @example expect(JSON.stringify(failures)).not.toContain('PRIVATE_DETAIL') */
    expect(JSON.stringify(failures)).not.toContain('PRIVATE_DETAIL')

    await adapter.stop()
  })

  /**
   * @example
   * it('bounds hung sends per user and stops late chunks for Discord audit D-022', async () => {})
   */
  it('bounds hung sends per user and stops late chunks for Discord audit D-022', async () => {
    const aAttempts: string[] = []
    const aReleases: Array<() => void> = []
    const bAttempts: string[] = []
    const failures: unknown[] = []
    const sentObservations: unknown[] = []
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const reply = 'X'.repeat(2_001)
    const adapter = new StandaloneDiscordAdapter({
      events: {
        onReplyFailed: payload => failures.push(payload),
        onReplySent: payload => sentObservations.push(payload),
      },
      filterConfig: {
        messagePacingMs: 0,
        privacyNoticeEnabled: false,
        rateLimitMaxMessages: 20,
      },
      runtime: new StandaloneChatRuntime({
        apiKey: 'synthetic-key',
        discordRulesByGuild: {},
        maxHistoryMessages: 4,
        model: 'synthetic-model',
        systemPrompt: 'Synthetic system prompt.',
      }, async () => ({ text: reply })),
    })
    const discordClient = Reflect.get(adapter, 'discordClient')
    Object.defineProperty(discordClient, 'user', {
      configurable: true,
      value: { id: 'bot-1' },
    })
    const botMember = {}
    const aChannel = {
      isThread: () => false,
      permissionsFor: () => new PermissionsBitField([
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ViewChannel,
      ]),
      send: vi.fn(async (payload: SafeDiscordTextPayload) => {
        aAttempts.push(payload.content)
        await new Promise<void>((resolve) => {
          aReleases.push(resolve)
        })
      }),
    }
    const bChannel = {
      isThread: () => false,
      permissionsFor: () => new PermissionsBitField([
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ViewChannel,
      ]),
      send: vi.fn(async (payload: SafeDiscordTextPayload) => {
        bAttempts.push(payload.content)
      }),
    }
    const message = (
      id: string,
      userId: string,
      channelId: string,
      channel: typeof aChannel | typeof bChannel,
    ) => ({
      author: { bot: false, id: userId, username: userId },
      channel,
      channelId,
      content: '<@bot-1> synthetic request',
      guild: { members: { me: botMember }, name: 'Synthetic guild' },
      guildId: 'guild-1',
      id,
      inGuild: () => true,
      member: { displayName: userId },
      mentions: { has: () => true },
      reference: undefined,
      type: MessageType.Default,
    })

    // ROOT CAUSE:
    //
    // Standalone kept every non-cancellable Discord send only in the message
    // handler await. Four hung sends from one user could be followed by unlimited
    // additional sends and stop waited forever. Shared actual-settlement ownership
    // now caps that user, preserves capacity for B, and aborts only local waiters.
    for (let index = 0; index < 5; index += 1) {
      discordClient.emit(
        Events.MessageCreate,
        message(`message-a-${index}`, 'user-a', `dm-user-a-${index}`, aChannel),
      )
    }
    discordClient.emit(Events.MessageCreate, message('message-b', 'user-b', 'dm-user-b', bChannel))

    await vi.waitFor(() => {
      /** @example expect(aAttempts).toHaveLength(4) */
      expect(aAttempts).toHaveLength(4)
      /** @example expect(failures).toContainEqual(expect.objectContaining({ deliveryReason: 'capacity' })) */
      expect(failures).toContainEqual(expect.objectContaining({
        deliveredChunks: 0,
        deliveryReason: 'capacity',
        errorName: 'DiscordTextDeliveryError',
      }))
      /** @example expect(bAttempts.join('')).toBe(reply) */
      expect(bAttempts.join('')).toBe(reply)
    })

    await adapter.stop()
    for (const release of aReleases)
      release()
    await Promise.resolve()
    await Promise.resolve()

    /** @example expect(aAttempts).toHaveLength(4) */
    expect(aAttempts).toHaveLength(4)
    /** @example expect(sentObservations).toEqual([{ operationSequence: 6, surface: 'text-guild' }]) */
    expect(sentObservations).toEqual([{ operationSequence: 6, surface: 'text-guild' }])
    consoleError.mockRestore()
  })
})

/**
 * @example
 * describe('standalone memory command routing', () => {})
 */
describe('standalone memory command routing', () => {
  /**
   * @example
   * it('handles exact memory commands and cancels memory work for Discord audit D-024', async () => {})
   */
  it('handles exact memory commands and cancels memory work for Discord audit D-024', async () => {
    const sent: string[] = []
    let generatorCalls = 0
    let memoryCommandCalls = 0
    let memoryCommandMessageId: string | undefined
    let memoryCommandSessionId: string | undefined
    const runtime = new StandaloneChatRuntime({
      apiKey: 'test-key',
      discordRulesByGuild: {},
      maxHistoryMessages: 4,
      model: 'test-model',
      systemPrompt: 'You are AIRI.',
    }, async () => {
      generatorCalls += 1
      return { text: 'reply' }
    })
    const clearMemorySession = vi.spyOn(runtime, 'clearMemorySession')
    const adapter = new StandaloneDiscordAdapter({
      filterConfig: {
        messagePacingMs: 0,
        privacyNoticeEnabled: false,
        rateLimitMaxMessages: 1,
      },
      memoryCommands: {
        handleCommand: async (turn, context) => {
          if (turn.text !== '记忆 关闭')
            return undefined

          memoryCommandCalls += 1
          memoryCommandMessageId = turn.messageId
          memoryCommandSessionId = turn.sessionId
          context?.onMemoryDisabled()
          return '当前会话长期记忆已关闭。'
        },
      },
      runtime,
    })
    const channel = {
      isThread: () => false,
      send: async (payload: SafeDiscordTextPayload) => {
        sent.push(payload.content)
      },
    }
    const message = (content: string, id: string) => ({
      author: {
        bot: false,
        id: 'user-1',
        username: 'Owen',
      },
      channel,
      channelId: 'dm-channel',
      content,
      guild: undefined,
      guildId: undefined,
      id,
      inGuild: () => false,
      member: undefined,
    })
    const handleDiscordMessage = Reflect.get(adapter, 'handleDiscordMessage')

    await Reflect.apply(handleDiscordMessage, adapter, [message('hello', 'message-1')])
    await Reflect.apply(handleDiscordMessage, adapter, [message('记忆 关闭', 'message-2')])

    expect(generatorCalls).toBe(1)
    expect(memoryCommandCalls).toBe(1)
    expect(memoryCommandMessageId).toBe('message-2')
    // ROOT CAUSE:
    //
    // The memory store persisted opt-out but had no exact-session lifecycle hook,
    // so already accepted extraction could continue after the command succeeded.
    // The command owner now invokes the adapter-provided cancellation only after
    // its durable disabling write completes.
    // @example
    expect(clearMemorySession).toHaveBeenCalledTimes(1)
    // @example
    expect(clearMemorySession).toHaveBeenCalledWith(memoryCommandSessionId)
    expect(sent).toEqual(['reply', '当前会话长期记忆已关闭。'])
  })

  /**
   * @example
   * it('applies access filters before memory commands', async () => {})
   */
  it('applies access filters before memory commands', async () => {
    const sent: string[] = []
    let memoryCommandCalls = 0
    const rejected: string[] = []
    const adapter = new StandaloneDiscordAdapter({
      events: {
        onMessageRejected: payload => rejected.push(payload.reason),
      },
      filterConfig: {
        blockedUserIds: ['blocked-user'],
        messagePacingMs: 0,
      },
      memoryCommands: {
        handleCommand: async () => {
          memoryCommandCalls += 1
          return 'Memory changed.'
        },
      },
      runtime: new StandaloneChatRuntime({
        apiKey: 'test-key',
        discordRulesByGuild: {},
        maxHistoryMessages: 4,
        model: 'test-model',
        systemPrompt: 'You are AIRI.',
      }, async () => ({ text: 'reply' })),
    })
    const channel = {
      isThread: () => false,
      send: async (payload: SafeDiscordTextPayload) => {
        sent.push(payload.content)
      },
    }
    const handleDiscordMessage = Reflect.get(adapter, 'handleDiscordMessage')

    // ROOT CAUSE:
    //
    // Memory commands were dispatched before the standalone access filter. A
    // blocked Discord user could therefore make the bot respond and mutate the
    // exact-session memory preference even though ordinary chat was denied.
    await Reflect.apply(handleDiscordMessage, adapter, [{
      author: { bot: false, id: 'blocked-user', username: 'Blocked' },
      channel,
      channelId: 'dm-channel',
      content: 'memory off',
      guild: undefined,
      guildId: undefined,
      inGuild: () => false,
      member: undefined,
    }])

    expect(memoryCommandCalls).toBe(0)
    expect(sent).toEqual([])
    expect(rejected).toEqual(['blocked-user'])
  })
})

/**
 * @example
 * describe('standalone Discord mention normalization', () => {})
 */
describe('standalone Discord mention normalization', () => {
  /**
   * @example
   * it('removes only the AIRI mention and preserves other mentioned users', async () => {})
   */
  it('removes only the AIRI mention and preserves other mentioned users', async () => {
    let providerUserMessage = ''
    const adapter = new StandaloneDiscordAdapter({
      filterConfig: {
        messagePacingMs: 0,
      },
      runtime: new StandaloneChatRuntime({
        apiKey: 'test-key',
        discordRulesByGuild: {},
        maxHistoryMessages: 4,
        model: 'test-model',
        systemPrompt: 'You are AIRI.',
      }, async (input) => {
        providerUserMessage = String(input.messages.at(-1)?.content ?? '')
        return { text: 'reply' }
      }),
    })
    const discordClient = Reflect.get(adapter, 'discordClient')
    Object.defineProperty(discordClient, 'user', {
      configurable: true,
      value: { id: '111' },
    })
    const botMember = {}
    const channel = {
      isThread: () => false,
      permissionsFor: () => new PermissionsBitField([
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ViewChannel,
      ]),
      send: async () => {},
    }
    const handleDiscordMessage = Reflect.get(adapter, 'handleDiscordMessage')

    // ROOT CAUSE:
    //
    // The mention cleanup matched every Discord user mention instead of only
    // AIRI's id, so references to other people disappeared before generation.
    await Reflect.apply(handleDiscordMessage, adapter, [{
      author: { bot: false, id: 'user-1', username: 'Owen' },
      channel,
      channelId: 'channel-1',
      content: '<@111> ask <@222> whether they agree',
      guild: {
        members: { me: botMember },
        name: 'Test server',
      },
      guildId: 'guild-1',
      inGuild: () => true,
      member: { displayName: 'Owen' },
      mentions: {
        has: (user: { id?: string }) => user.id === '111',
      },
    }])

    expect(providerUserMessage).not.toContain('<@111>')
    expect(providerUserMessage).toContain('<@222>')
  })
})

/**
 * @example
 * describe('standalone Discord reply triggers', () => {})
 */
describe('standalone Discord reply triggers', () => {
  /**
   * @example
   * it('recognizes a direct reply to the bot without requiring a mention', async () => {})
   */
  it('recognizes a direct reply to the bot without requiring a mention', async () => {
    expect(await resolveDiscordReplyReference({
      botUserId: 'bot-1',
      fetchReferencedAuthorId: async () => 'bot-1',
      principalKey: 'guild/channel/user',
      referencedMessageId: 'message-1',
    })).toEqual({ matched: true, reason: 'matched' })
    expect(await resolveDiscordReplyReference({
      botUserId: 'bot-1',
      fetchReferencedAuthorId: async () => 'user-2',
      principalKey: 'guild/channel/user',
      referencedMessageId: 'message-2',
    })).toEqual({ matched: false, reason: 'author-mismatch' })
    expect(await resolveDiscordReplyReference({
      botUserId: 'bot-1',
      fetchReferencedAuthorId: async () => 'bot-1',
      principalKey: 'guild/channel/user',
    })).toEqual({ matched: false, reason: 'missing-reference' })
  })

  /**
   * @example
   * it('fetches reply authors and ignores forged reply metadata for Discord audit D-023', async () => {})
   */
  it('fetches reply authors and ignores forged reply metadata for Discord audit D-023', async () => {
    let providerCalls = 0
    const sent: string[] = []
    const adapter = new StandaloneDiscordAdapter({
      filterConfig: {
        messagePacingMs: 0,
        privacyNoticeEnabled: false,
      },
      runtime: new StandaloneChatRuntime({
        apiKey: 'synthetic-key',
        discordRulesByGuild: {},
        maxHistoryMessages: 4,
        model: 'synthetic-model',
        systemPrompt: 'Synthetic system prompt.',
      }, async () => {
        providerCalls += 1
        return { text: 'synthetic reply' }
      }),
    })
    const discordClient = Reflect.get(adapter, 'discordClient')
    Object.defineProperty(discordClient, 'user', {
      configurable: true,
      value: { id: 'bot-1' },
    })
    const botMember = {}
    const channel = {
      isThread: () => false,
      permissionsFor: () => new PermissionsBitField([
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ViewChannel,
      ]),
      send: async (payload: SafeDiscordTextPayload) => {
        sent.push(payload.content)
      },
    }
    const message = (id: string, referencedAuthorId: string) => ({
      author: { bot: false, id: 'user-1', username: 'Synthetic user' },
      channel,
      channelId: 'channel-1',
      content: 'synthetic follow-up',
      fetchReference: vi.fn(async () => ({ author: { id: referencedAuthorId } })),
      guild: { members: { me: botMember }, name: 'Synthetic guild' },
      guildId: 'guild-1',
      id,
      inGuild: () => true,
      member: { displayName: 'Synthetic user' },
      mentions: {
        has: () => false,
        repliedUser: { id: 'bot-1' },
      },
      reference: { messageId: `reference-${id}`, type: MessageReferenceType.Default },
      type: MessageType.Reply,
    })

    // ROOT CAUSE:
    //
    // Standalone had a local resolver while bridge had none. The shared contract
    // must keep the working standalone behavior but trust only a controlled fetch
    // of the referenced message author, never the forgeable replied-user payload.
    discordClient.emit(Events.MessageCreate, message('message-bot', 'bot-1'))
    await vi.waitFor(() => {
      /** @example expect(providerCalls).toBe(1) */
      expect(providerCalls).toBe(1)
    })
    const mentionedFetch = vi.fn(async () => 'bot-1')
    const mentionedMessage = message('message-mentioned', 'bot-1')
    mentionedMessage.content = '<@bot-1> synthetic mentioned reply'
    mentionedMessage.fetchReference = vi.fn(async () => ({ author: { id: await mentionedFetch() } }))
    mentionedMessage.mentions.has = () => true
    discordClient.emit(Events.MessageCreate, mentionedMessage)
    await vi.waitFor(() => {
      /** @example expect(providerCalls).toBe(2) */
      expect(providerCalls).toBe(2)
    })
    /** @example expect(mentionedFetch).not.toHaveBeenCalled() */
    expect(mentionedFetch).not.toHaveBeenCalled()
    discordClient.emit(Events.MessageCreate, message('message-forged', 'user-2'))
    await vi.waitFor(() => {
      /** @example expect(sent).toEqual(['synthetic reply', 'synthetic reply']) */
      expect(sent).toEqual(['synthetic reply', 'synthetic reply'])
    })
    /** @example expect(providerCalls).toBe(2) */
    expect(providerCalls).toBe(2)

    await adapter.stop()
  })

  /**
   * @example
   * it('serializes reply admission with mentions per exact session for Discord audit D-023', async () => {})
   */
  it('serializes reply admission with mentions per exact session for Discord audit D-023', async () => {
    const providerInputs: string[] = []
    const adapter = new StandaloneDiscordAdapter({
      filterConfig: {
        messagePacingMs: 0,
        privacyNoticeEnabled: false,
        rateLimitMaxMessages: 100,
        userRateLimitMaxMessages: 100,
      },
      runtime: new StandaloneChatRuntime({
        apiKey: 'synthetic-key',
        discordRulesByGuild: {},
        maxHistoryMessages: 4,
        model: 'synthetic-model',
        systemPrompt: 'Synthetic system prompt.',
      }, async (input) => {
        providerInputs.push(String(input.messages.at(-1)?.content ?? ''))
        return { text: 'synthetic reply' }
      }),
    })
    const discordClient = Reflect.get(adapter, 'discordClient')
    Object.defineProperty(discordClient, 'user', {
      configurable: true,
      value: { id: 'bot-1' },
    })
    const botMember = {}
    const channel = {
      isThread: () => false,
      permissionsFor: () => new PermissionsBitField([
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ViewChannel,
      ]),
      send: vi.fn(async () => {}),
    }
    let releaseReference = (_authorId: string) => {}
    const fetchFirstReference = vi.fn(() => new Promise<{ author: { id: string } }>((resolve) => {
      releaseReference = authorId => resolve({ author: { id: authorId } })
    }))
    const message = (id: string, userId: string, content: string, mentioned: boolean, fetchReference?: () => Promise<{ author: { id: string } }>) => ({
      author: { bot: false, id: userId, username: `Synthetic ${userId}` },
      channel,
      channelId: 'channel-1',
      content: mentioned ? `<@bot-1> ${content}` : content,
      fetchReference: fetchReference ?? vi.fn(async () => ({ author: { id: 'bot-1' } })),
      guild: { members: { me: botMember }, name: 'Synthetic guild' },
      guildId: 'guild-1',
      id,
      inGuild: () => true,
      member: { displayName: `Synthetic ${userId}` },
      mentions: { has: () => mentioned },
      reference: mentioned ? undefined : { messageId: `reference-${id}`, type: MessageReferenceType.Default },
      type: mentioned ? MessageType.Default : MessageType.Reply,
    })
    const handleDiscordMessage = Reflect.get(adapter, 'handleDiscordMessage')
    // ROOT CAUSE:
    //
    // Standalone resolved references before StandaloneChatRuntime's exact-session
    // queue. A later mention could therefore enter the provider first, while a
    // different user's exact session must remain independently runnable.
    const first = Reflect.apply(handleDiscordMessage, adapter, [message('a1', 'user-a', 'SENTINEL_A1', false, fetchFirstReference)]) as Promise<void>
    await vi.waitFor(() => {
      /** @example expect(fetchFirstReference).toHaveBeenCalledOnce() */
      expect(fetchFirstReference).toHaveBeenCalledOnce()
    })
    const second = Reflect.apply(handleDiscordMessage, adapter, [message('a2', 'user-a', 'SENTINEL_A2', true)]) as Promise<void>
    const otherSession = Reflect.apply(handleDiscordMessage, adapter, [message('b1', 'user-b', 'SENTINEL_B1', true)]) as Promise<void>
    await otherSession

    /** @example expect(providerInputs).toHaveLength(1) */
    expect(providerInputs).toHaveLength(1)
    /** @example expect(providerInputs[0]).toContain('SENTINEL_B1') */
    expect(providerInputs[0]).toContain('SENTINEL_B1')
    /** @example expect(providerInputs[0]).not.toContain('SENTINEL_A2') */
    expect(providerInputs[0]).not.toContain('SENTINEL_A2')
    releaseReference('bot-1')
    await Promise.all([first, second])
    const userAInputs = providerInputs.filter(text => text.includes('SENTINEL_A'))
    /** @example expect(userAInputs[0]).toContain('SENTINEL_A1') */
    expect(userAInputs[0]).toContain('SENTINEL_A1')
    /** @example expect(userAInputs[1]).toContain('SENTINEL_A2') */
    expect(userAInputs[1]).toContain('SENTINEL_A2')

    await adapter.stop()
  })

  /**
   * @example
   * it('rejects blocked reply candidates before fetching for Discord audit D-023', async () => {})
   */
  it('rejects blocked reply candidates before fetching for Discord audit D-023', async () => {
    const adapter = new StandaloneDiscordAdapter({
      filterConfig: {
        blockedUserIds: ['blocked-user'],
        messagePacingMs: 0,
        privacyNoticeEnabled: false,
      },
      runtime: new StandaloneChatRuntime({
        apiKey: 'synthetic-key',
        discordRulesByGuild: {},
        maxHistoryMessages: 4,
        model: 'synthetic-model',
        systemPrompt: 'Synthetic system prompt.',
      }, async () => ({ text: 'unexpected reply' })),
    })
    const discordClient = Reflect.get(adapter, 'discordClient')
    Object.defineProperty(discordClient, 'user', {
      configurable: true,
      value: { id: 'bot-1' },
    })
    const botMember = {}
    const fetchReference = vi.fn(async () => ({ author: { id: 'bot-1' } }))
    const handleDiscordMessage = Reflect.get(adapter, 'handleDiscordMessage')

    // ROOT CAUSE:
    //
    // Standalone fetched the referenced message before its pure guild/channel/
    // user access check. A blocked principal could waste the bounded REST pool
    // despite being ineligible to consume rate or reach the provider.
    await Reflect.apply(handleDiscordMessage, adapter, [{
      author: { bot: false, id: 'blocked-user', username: 'Blocked synthetic user' },
      channel: {
        isThread: () => false,
        permissionsFor: () => new PermissionsBitField([
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ViewChannel,
        ]),
        send: vi.fn(async () => {}),
      },
      channelId: 'channel-1',
      content: 'SENTINEL_BLOCKED_REPLY',
      fetchReference,
      guild: { members: { me: botMember }, name: 'Synthetic guild' },
      guildId: 'guild-1',
      id: 'blocked-message',
      inGuild: () => true,
      member: { displayName: 'Blocked synthetic user' },
      mentions: { has: () => false },
      reference: { messageId: 'blocked-reference', type: MessageReferenceType.Default },
      type: MessageType.Reply,
    }])

    /** @example expect(fetchReference).not.toHaveBeenCalled() */
    expect(fetchReference).not.toHaveBeenCalled()
    const allowedChannel = {
      isThread: () => false,
      permissionsFor: () => new PermissionsBitField([
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ViewChannel,
      ]),
      send: vi.fn(async () => {}),
    }
    const forwardedFetch = vi.fn(async () => ({ author: { id: 'bot-1' } }))
    const forwarded = {
      author: { bot: false, id: 'allowed-user', username: 'Allowed synthetic user' },
      channel: allowedChannel,
      channelId: 'channel-1',
      content: 'SENTINEL_FORWARDED_MESSAGE',
      fetchReference: forwardedFetch,
      guild: { members: { me: botMember }, name: 'Synthetic guild' },
      guildId: 'guild-1',
      id: 'forwarded-message',
      inGuild: () => true,
      member: { displayName: 'Allowed synthetic user' },
      mentions: { has: () => false },
      reference: { messageId: 'forwarded-reference', type: MessageReferenceType.Forward },
      type: MessageType.Reply,
    }
    await Reflect.apply(handleDiscordMessage, adapter, [forwarded])
    await Reflect.apply(handleDiscordMessage, adapter, [{
      ...forwarded,
      content: 'SENTINEL_CROSSPOST_MESSAGE',
      fetchReference: forwardedFetch,
      id: 'crosspost-message',
      reference: { messageId: 'crosspost-reference', type: MessageReferenceType.Default },
      type: MessageType.ChannelFollowAdd,
    }])
    /** @example expect(forwardedFetch).not.toHaveBeenCalled() */
    expect(forwardedFetch).not.toHaveBeenCalled()
    await adapter.stop()
  })

  /**
   * @example
   * it('bounds exact-session reply envelopes and recovers capacity for Discord audit D-023', async () => {})
   */
  it('bounds exact-session reply envelopes and recovers capacity for Discord audit D-023', async () => {
    let providerCalls = 0
    const rejections: string[] = []
    const adapter = new StandaloneDiscordAdapter({
      events: {
        onMessageRejected: payload => rejections.push(payload.reason),
      },
      filterConfig: {
        messagePacingMs: 0,
        privacyNoticeEnabled: false,
        rateLimitMaxMessages: 100,
        userRateLimitMaxMessages: 100,
      },
      runtime: new StandaloneChatRuntime({
        apiKey: 'synthetic-key',
        discordRulesByGuild: {},
        maxHistoryMessages: 4,
        model: 'synthetic-model',
        systemPrompt: 'Synthetic system prompt.',
      }, async () => {
        providerCalls += 1
        return { text: 'synthetic reply' }
      }),
    })
    const discordClient = Reflect.get(adapter, 'discordClient')
    Object.defineProperty(discordClient, 'user', {
      configurable: true,
      value: { id: 'bot-1' },
    })
    const botMember = {}
    const channel = {
      isThread: () => false,
      permissionsFor: () => new PermissionsBitField([
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ViewChannel,
      ]),
      send: vi.fn(async () => {}),
    }
    let releaseFirstReference = (_authorId: string) => {}
    const fetches = Array.from({ length: 9 }, (_, index) => index === 0
      ? vi.fn(() => new Promise<{ author: { id: string } }>((resolve) => {
          releaseFirstReference = authorId => resolve({ author: { id: authorId } })
        }))
      : vi.fn(async () => ({ author: { id: 'other-bot' } })))
    const message = (index: number, mentioned = false) => ({
      author: { bot: false, id: 'user-a', username: 'Synthetic user A' },
      channel,
      channelId: 'channel-1',
      content: mentioned ? `<@bot-1> SENTINEL_CAP_${index}` : `SENTINEL_CAP_${index}`,
      fetchReference: fetches[index],
      guild: { members: { me: botMember }, name: 'Synthetic guild' },
      guildId: 'guild-1',
      id: `capacity-${index}-${mentioned ? 'mention' : 'reply'}`,
      inGuild: () => true,
      member: { displayName: 'Synthetic user A' },
      mentions: { has: () => mentioned },
      reference: mentioned ? undefined : { messageId: `reference-${index}`, type: MessageReferenceType.Default },
      type: mentioned ? MessageType.Default : MessageType.Reply,
    })
    const handleDiscordMessage = Reflect.get(adapter, 'handleDiscordMessage')

    // ROOT CAUSE:
    //
    // Standalone's provider queue could not bound reference work that happened
    // before runtime.reply(). The shared envelope scheduler now rejects the
    // ninth same-session candidate before fetch/rate/privacy/provider work and
    // restores capacity after the retained FIFO settles.
    const first = Reflect.apply(handleDiscordMessage, adapter, [message(0)]) as Promise<void>
    await vi.waitFor(() => {
      /** @example expect(fetches[0]).toHaveBeenCalledOnce() */
      expect(fetches[0]).toHaveBeenCalledOnce()
    })
    const retained = Array.from({ length: 7 }, (_, index) => Reflect.apply(
      handleDiscordMessage,
      adapter,
      [message(index + 1)],
    ) as Promise<void>)
    await Promise.resolve()
    await Reflect.apply(handleDiscordMessage, adapter, [message(8)])

    /** @example expect(fetches[8]).not.toHaveBeenCalled() */
    expect(fetches[8]).not.toHaveBeenCalled()
    /** @example expect(rejections).toContain('queue-full') */
    expect(rejections).toContain('queue-full')
    /** @example expect(Reflect.get(adapter, 'ingressScheduler')).toHaveProperty('pendingCount', 8) */
    expect(Reflect.get(adapter, 'ingressScheduler')).toHaveProperty('pendingCount', 8)

    releaseFirstReference('other-bot')
    await Promise.all([first, ...retained])
    /** @example expect(providerCalls).toBe(2) */
    expect(providerCalls).toBe(0)

    await Reflect.apply(handleDiscordMessage, adapter, [message(8, true)])
    /** @example expect(providerCalls).toBe(1) */
    expect(providerCalls).toBe(1)
    /** @example expect(Reflect.get(adapter, 'ingressScheduler')).toHaveProperty('pendingCount', 0) */
    expect(Reflect.get(adapter, 'ingressScheduler')).toHaveProperty('pendingCount', 0)
    await adapter.stop()
  })

  /**
   * @example
   * it('observes missing rejected and timed-out references for Discord audit D-023', async () => {})
   */
  it('observes missing rejected and timed-out references for Discord audit D-023', async () => {
    vi.useFakeTimers()
    const consoleInfo = vi.spyOn(console, 'info').mockImplementation(() => {})
    let providerCalls = 0
    const adapter = new StandaloneDiscordAdapter({
      filterConfig: {
        auditLogEnabled: true,
        messagePacingMs: 0,
        privacyNoticeEnabled: false,
      },
      runtime: new StandaloneChatRuntime({
        apiKey: 'synthetic-key',
        discordRulesByGuild: {},
        maxHistoryMessages: 4,
        model: 'synthetic-model',
        systemPrompt: 'Synthetic system prompt.',
      }, async () => {
        providerCalls += 1
        return { text: 'synthetic reply' }
      }),
    })
    const discordClient = Reflect.get(adapter, 'discordClient')
    Object.defineProperty(discordClient, 'user', {
      configurable: true,
      value: { id: 'bot-1' },
    })
    const botMember = {}
    const channel = {
      isThread: () => false,
      permissionsFor: () => new PermissionsBitField([
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ViewChannel,
      ]),
      send: vi.fn(async () => {}),
    }
    const message = (id: string, fetchReference: () => Promise<{ author: { id: string } }>, referenced = true) => ({
      author: { bot: false, id: 'user-reference', username: 'Synthetic user' },
      channel,
      channelId: 'channel-1',
      content: 'synthetic follow-up',
      fetchReference,
      guild: { members: { me: botMember }, name: 'Synthetic guild' },
      guildId: 'guild-1',
      id,
      inGuild: () => true,
      member: { displayName: 'Synthetic user' },
      mentions: { has: () => false },
      reference: referenced
        ? { messageId: `reference-${id}`, type: MessageReferenceType.Default }
        : { messageId: undefined, type: MessageReferenceType.Default },
      type: MessageType.Reply,
    })
    const handleDiscordMessage = Reflect.get(adapter, 'handleDiscordMessage')
    const mentionedMessage = (id: string) => ({
      ...message(id, async () => ({ author: { id: 'bot-1' } })),
      content: `<@bot-1> SENTINEL_${id.toUpperCase()}`,
      mentions: { has: () => true },
      reference: undefined,
      type: MessageType.Default,
    })

    // ROOT CAUSE:
    //
    // Adapter-local reply checks collapsed deleted, rejected, timed-out, and
    // cancelled reference fetches into an unobservable false. Both modes now
    // expose only fixed reasons while every path fails closed before provider use.
    const missingFetch = vi.fn(async () => ({ author: { id: 'bot-1' } }))
    await Reflect.apply(handleDiscordMessage, adapter, [message('missing', missingFetch, false)])
    await Reflect.apply(handleDiscordMessage, adapter, [message('rejected', async () => {
      throw new Error('SYNTHETIC_REFERENCE_PRIVATE_DETAIL')
    })])
    let releaseMismatch = (_authorId: string) => {}
    const mismatched = Reflect.apply(handleDiscordMessage, adapter, [message('mismatch', () => new Promise((resolve) => {
      releaseMismatch = authorId => resolve({ author: { id: authorId } })
    }))]) as Promise<void>
    const afterMismatch = Reflect.apply(handleDiscordMessage, adapter, [mentionedMessage('after-mismatch')]) as Promise<void>
    await vi.advanceTimersByTimeAsync(0)
    releaseMismatch('other-bot')
    await Promise.all([mismatched, afterMismatch])

    let releaseReference = (_authorId: string) => {}
    const timedOut = Reflect.apply(handleDiscordMessage, adapter, [message('timeout', () => new Promise((resolve) => {
      releaseReference = authorId => resolve({ author: { id: authorId } })
    }))]) as Promise<void>
    const afterTimeout = Reflect.apply(handleDiscordMessage, adapter, [mentionedMessage('after-timeout')]) as Promise<void>
    await vi.advanceTimersByTimeAsync(5_000)
    await Promise.all([timedOut, afterTimeout])
    releaseReference('bot-1')
    await vi.advanceTimersByTimeAsync(0)

    /** @example expect(missingFetch).not.toHaveBeenCalled() */
    expect(missingFetch).not.toHaveBeenCalled()
    /** @example expect(providerCalls).toBe(0) */
    expect(providerCalls).toBe(2)
    /** @example expect(Reflect.get(adapter, 'ingressScheduler')).toHaveProperty('pendingCount', 0) */
    expect(Reflect.get(adapter, 'ingressScheduler')).toHaveProperty('pendingCount', 0)
    const observations = JSON.stringify(consoleInfo.mock.calls)
    /** @example expect(observations).toContain('missing-reference') */
    expect(observations).toContain('missing-reference')
    /** @example expect(observations).toContain('fetch-failure') */
    expect(observations).toContain('fetch-failure')
    /** @example expect(observations).toContain('author-mismatch') */
    expect(observations).toContain('author-mismatch')
    /** @example expect(observations).toContain('timeout') */
    expect(observations).toContain('timeout')
    /** @example expect(observations).not.toContain('PRIVATE_DETAIL') */
    expect(observations).not.toContain('PRIVATE_DETAIL')

    consoleInfo.mockRestore()
    await adapter.stop()
    vi.useRealTimers()
  })
})

/**
 * @example
 * describe('standalone Discord interaction errors', () => {})
 */
describe('standalone Discord interaction errors', () => {
  /**
   * @example
   * it('routes an authorized standalone summon command to the voice manager', async () => {})
   */
  it('routes an authorized standalone summon command to the voice manager', async () => {
    const handleJoin = vi.spyOn(VoiceManager.prototype, 'handleJoinChannelCommand').mockImplementation(async () => {})
    const adapter = new StandaloneDiscordAdapter({
      runtime: new StandaloneChatRuntime({
        apiKey: 'test-key',
        discordRulesByGuild: {},
        maxHistoryMessages: 4,
        model: 'test-model',
        systemPrompt: 'You are AIRI.',
      }, async () => ({ text: 'reply' })),
      speechRuntime: new StandaloneSpeechRuntime({
        stt: { apiKey: 'stt-key', model: 'whisper-1' },
        tts: { apiKey: 'tts-key', model: 'tts-1', voice: 'alloy' },
      }, {
        synthesize: async () => new ArrayBuffer(0),
        transcribe: async () => '',
      }),
    })
    const discordClient = Reflect.get(adapter, 'discordClient')
    const interaction = {
      commandName: 'summon',
      inCachedGuild: () => true,
      isButton: () => false,
      isChatInputCommand: () => true,
      memberPermissions: new PermissionsBitField(PermissionFlagsBits.ManageGuild),
      reply: vi.fn(async () => {}),
    }

    discordClient.emit(Events.InteractionCreate, interaction)

    await vi.waitFor(() => {
      expect(handleJoin).toHaveBeenCalledWith(interaction)
    })
    handleJoin.mockRestore()
  })

  /**
   * @example
   * it('routes an authorized standalone dismiss command to the voice manager', async () => {})
   */
  it('routes an authorized standalone dismiss command to the voice manager', async () => {
    const handleLeave = vi.spyOn(VoiceManager.prototype, 'handleLeaveChannelCommand').mockImplementation(async () => {})
    const adapter = new StandaloneDiscordAdapter({
      runtime: new StandaloneChatRuntime({
        apiKey: 'test-key',
        discordRulesByGuild: {},
        maxHistoryMessages: 4,
        model: 'test-model',
        systemPrompt: 'You are AIRI.',
      }, async () => ({ text: 'reply' })),
    })
    const discordClient = Reflect.get(adapter, 'discordClient')
    const interaction = {
      commandName: 'dismiss',
      inCachedGuild: () => true,
      isButton: () => false,
      isChatInputCommand: () => true,
      memberPermissions: new PermissionsBitField(PermissionFlagsBits.ManageGuild),
      reply: vi.fn(async () => {}),
    }

    discordClient.emit(Events.InteractionCreate, interaction)

    await vi.waitFor(() => {
      expect(handleLeave).toHaveBeenCalledWith(interaction)
    })
    handleLeave.mockRestore()
  })

  /**
   * @example
   * it('rejects a standalone summon command without Manage Server permission', async () => {})
   */
  it('rejects a standalone summon command without Manage Server permission', async () => {
    const handleJoin = vi.spyOn(VoiceManager.prototype, 'handleJoinChannelCommand').mockImplementation(async () => {})
    const adapter = new StandaloneDiscordAdapter({
      runtime: new StandaloneChatRuntime({
        apiKey: 'test-key',
        discordRulesByGuild: {},
        maxHistoryMessages: 4,
        model: 'test-model',
        systemPrompt: 'You are AIRI.',
      }, async () => ({ text: 'reply' })),
    })
    const discordClient = Reflect.get(adapter, 'discordClient')
    const reply = vi.fn(async () => {})

    discordClient.emit(Events.InteractionCreate, {
      commandName: 'summon',
      inCachedGuild: () => true,
      isButton: () => false,
      isChatInputCommand: () => true,
      memberPermissions: new PermissionsBitField(),
      reply,
    })

    await vi.waitFor(() => {
      expect(reply).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }))
    })
    expect(handleJoin).not.toHaveBeenCalled()
    handleJoin.mockRestore()
  })

  /**
   * @example
   * it('contains rejected slash-command replies instead of crashing the bot', async () => {})
   */
  it('contains rejected slash-command replies instead of crashing the bot', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const adapter = new StandaloneDiscordAdapter({
      runtime: new StandaloneChatRuntime({
        apiKey: 'test-key',
        discordRulesByGuild: {},
        maxHistoryMessages: 4,
        model: 'test-model',
        systemPrompt: 'You are AIRI.',
      }, async () => ({ text: 'reply' })),
    })
    const discordClient = Reflect.get(adapter, 'discordClient')

    // ROOT CAUSE:
    //
    // The InteractionCreate listener was async but had no rejection boundary.
    // Discord error 10062 (expired/unknown interaction) therefore surfaced as
    // an unhandled EventEmitter rejection and terminated the standalone bot.
    discordClient.emit(Events.InteractionCreate, {
      commandName: 'ping',
      isButton: () => false,
      isChatInputCommand: () => true,
      reply: vi.fn(async () => {
        throw new Error('Unknown interaction')
      }),
    })

    await vi.waitFor(() => {
      expect(warning).toHaveBeenCalledWith(
        '[discord-bot:standalone] failed to handle Discord interaction',
        { failureCategory: 'discord-interaction-failure' },
      )
    })
    warning.mockRestore()
  })
})

/**
 * @example
 * describe('standalone Discord voice conversation', () => {})
 */
describe('standalone Discord voice conversation', () => {
  /**
   * @example
   * it('wires the standalone voice diagnostics observer into the production manager', () => {})
   */
  it('wires the standalone voice diagnostics observer into the production manager', () => {
    const observer: VoiceDiagnosticsObserver = {
      record: vi.fn(),
      runtimeSequence: 7,
    }
    const adapter = new StandaloneDiscordAdapter({
      runtime: new StandaloneChatRuntime({
        apiKey: 'synthetic-model-key',
        discordRulesByGuild: {},
        maxHistoryMessages: 4,
        model: 'synthetic-model',
        systemPrompt: 'Synthetic system prompt.',
      }, async () => ({ text: 'synthetic reply' })),
      voiceDiagnostics: observer,
    })
    const manager = Reflect.get(adapter, 'voiceManager') as VoiceManager

    // ROOT CAUSE:
    //
    // VoiceManager owned the real receiver, provider, and player transitions,
    // but the standalone adapter had no observer input and therefore discarded
    // every content-free diagnostic signal before it reached Dashboard state.
    // The adapter now passes the exact generation observer as VoiceManager's
    // final optional constructor argument without changing bridge construction.
    // @example
    expect(Reflect.get(manager, 'voiceDiagnostics')).toBe(observer)
  })

  /**
   * @example
   * it('Discord audit D-007 consumes standalone rate admission before receiver capture', async () => {})
   */
  it('reproduces Discord audit D-007 by consuming standalone rate admission before receiver capture', async () => {
    const adapter = new StandaloneDiscordAdapter({
      filterConfig: {
        allowedChannelIds: ['voice-1'],
        rateLimitMaxMessages: 1,
        rateLimitWindowMs: 30_000,
      },
      runtime: new StandaloneChatRuntime({
        apiKey: 'test-key',
        discordRulesByGuild: {},
        maxHistoryMessages: 4,
        model: 'test-model',
        systemPrompt: 'You are AIRI.',
      }, async () => ({ text: 'reply' })),
    })
    const manager = Reflect.get(adapter, 'voiceManager') as VoiceManager
    const receiveStream = new PassThrough()
    const destroyReceiveStream = vi.spyOn(receiveStream, 'destroy')
    const connection = {
      destroy: vi.fn(),
      off: vi.fn(),
      receiver: {
        speaking: { off: vi.fn() },
        subscribe: vi.fn(() => receiveStream),
      },
      state: { status: 'ready' },
    }
    const guild = { id: 'guild-1', name: 'Synthetic guild' }
    const member = {
      displayName: 'Rate-limited speaker',
      guild,
      id: 'user-1',
      nickname: 'Rate-limited speaker',
      user: { bot: false },
    }
    const channel = {
      guild,
      id: 'voice-1',
      members: new Map([['user-1', member]]),
      name: 'Synthetic voice',
    }
    Reflect.get(manager, 'activeVoiceSessionsByGuildId').set('guild-1', {
      abortController: new AbortController(),
      channel,
      connection,
      scope: { channelId: 'voice-1', generation: 1, guildId: 'guild-1' },
    })
    const handleSpeakingStart = Reflect.apply(
      manager.handleAudioReceiveStreamStart,
      manager,
      [channel],
    ) as (userId: string) => Promise<void>
    const handleSpeakingEnd = Reflect.apply(
      manager.handleAudioReceiveStreamEnd,
      manager,
      [channel],
    ) as (userId: string) => Promise<void>

    // ROOT CAUSE:
    //
    // Standalone voice called resolveAccessPolicy before capture but consumed
    // resolveInput's session/user/guild/global quota only after external STT.
    // Qwen's direct-audio path skipped that later text handler entirely.
    await handleSpeakingStart('user-1')
    await handleSpeakingEnd('user-1')
    await handleSpeakingStart('user-1')

    // @example
    expect(connection.receiver.subscribe).toHaveBeenCalledOnce()
    // @example
    expect(destroyReceiveStream).toHaveBeenCalledOnce()
    manager.stop()
  })

  /**
   * @example
   * it('keeps the voice turn isolated and sends only the final reply to TTS', async () => {})
   */
  it('keeps the voice admission deadline through chat and TTS for Discord audit D-018', async () => {
    const runtime = new StandaloneChatRuntime({
      apiKey: 'test-key',
      discordRulesByGuild: {},
      maxHistoryMessages: 4,
      model: 'test-model',
      systemPrompt: 'You are AIRI.',
    }, async () => ({ text: 'spoken reply' }))
    const reply = vi.spyOn(runtime, 'reply')
    const synthesize = vi.fn(async () => new Uint8Array([1, 2, 3]).buffer)
    const adapter = new StandaloneDiscordAdapter({
      filterConfig: { messagePacingMs: 0 },
      runtime,
      speechRuntime: new StandaloneSpeechRuntime({
        stt: { apiKey: 'stt-key', model: 'whisper-1' },
        tts: { apiKey: 'tts-key', model: 'tts-1', voice: 'alloy' },
      }, {
        synthesize,
        transcribe: async () => '',
      }),
    })
    const handleVoiceTranscription = Reflect.get(adapter, 'handleVoiceTranscription')
    const abortController = new AbortController()
    const deadlineAt = Date.now() + 20_000
    const audio = await Reflect.apply(handleVoiceTranscription, adapter, [{
      abortSignal: abortController.signal,
      channelId: 'voice-1',
      deadlineAt,
      guildId: 'guild-1',
      rateLimitAdmitted: true,
      speaker: {
        displayName: 'Owen',
        guildName: 'Test Guild',
      },
      speechProviderOwnerKey: 'guild-1:voice-1:1:user-1',
      speechProviderPrincipalKey: 'user-1',
      text: '你好 AIRI',
      userId: 'user-1',
    }]) as Readable
    const chunks: Buffer[] = []
    for await (const chunk of audio)
      chunks.push(Buffer.from(chunk))

    expect(reply).toHaveBeenCalledWith(
      {
        channelId: 'voice-1',
        channelName: undefined,
        directMessage: false,
        displayName: 'Owen',
        guildId: 'guild-1',
        guildName: 'Test Guild',
        sessionId: 'discord-standalone-guild-guild-1-channel-voice-1-user-user-1',
        text: '你好 AIRI',
        userId: 'user-1',
      },
      { abortSignal: abortController.signal, deadlineAt },
    )
    expect(synthesize).toHaveBeenCalledWith('spoken reply', {
      apiKey: 'tts-key',
      model: 'tts-1',
      voice: 'alloy',
    }, {
      abortSignal: expect.any(AbortSignal),
      deadlineAt,
    })
    expect(Buffer.concat(chunks)).toEqual(Buffer.from([1, 2, 3]))
  })

  /**
   * @example
   * it('Discord audit D-009 drops a deferred model result after generation abort', async () => {})
   */
  it('reproduces Discord audit D-009 by dropping a deferred model result after generation abort', async () => {
    let resolveModel = (_value: { text: string }) => {}
    let markModelStarted = () => {}
    const modelStarted = new Promise<void>((resolve) => {
      markModelStarted = resolve
    })
    const modelResult = new Promise<{ text: string }>((resolve) => {
      resolveModel = resolve
    })
    const synthesize = vi.fn(async () => new ArrayBuffer(0))
    const adapter = new StandaloneDiscordAdapter({
      runtime: new StandaloneChatRuntime({
        apiKey: 'test-key',
        discordRulesByGuild: {},
        maxHistoryMessages: 4,
        model: 'test-model',
        systemPrompt: 'You are AIRI.',
      }, async () => {
        markModelStarted()
        return modelResult
      }),
      speechRuntime: new StandaloneSpeechRuntime({
        stt: { apiKey: 'stt-key', model: 'whisper-1' },
        tts: { apiKey: 'tts-key', model: 'tts-1', voice: 'alloy' },
      }, {
        synthesize,
        transcribe: async () => '',
      }),
    })
    const abortController = new AbortController()
    const deadlineAt = Date.now() + 30_000
    const handleVoiceTranscription = Reflect.get(adapter, 'handleVoiceTranscription')
    const task = Reflect.apply(handleVoiceTranscription, adapter, [{
      abortSignal: abortController.signal,
      channelId: 'voice-a',
      deadlineAt,
      guildId: 'guild-1',
      rateLimitAdmitted: true,
      speaker: { displayName: 'Speaker', guildName: 'Guild' },
      speechProviderOwnerKey: 'guild-1:voice-a:1:user-1',
      speechProviderPrincipalKey: 'user-1',
      text: 'channel A turn',
      userId: 'user-1',
    }]) as Promise<Readable | undefined>
    await modelStarted

    // ROOT CAUSE:
    //
    // A moved voice user previously left model and TTS promises detached from
    // the channel generation. Releasing either promise after channel B became
    // current allowed the old A continuation to reach playback.
    abortController.abort(new Error('voice channel moved'))
    resolveModel({ text: 'stale reply' })

    await expect(task).resolves.toBeUndefined()
    expect(synthesize).not.toHaveBeenCalled()
  })

  /**
   * @example
   * it('reproduces Discord audits D-009 and D-018 by dropping deferred TTS bytes after generation abort', async () => {})
   */
  it('reproduces Discord audits D-009 and D-018 by dropping deferred TTS bytes after generation abort', async () => {
    let resolveSpeech = (_value: ArrayBuffer) => {}
    let markSpeechStarted = () => {}
    let providerSignal: AbortSignal | undefined
    const replySent = vi.fn()
    const speechStarted = new Promise<void>((resolve) => {
      markSpeechStarted = resolve
    })
    const speechResult = new Promise<ArrayBuffer>((resolve) => {
      resolveSpeech = resolve
    })
    const adapter = new StandaloneDiscordAdapter({
      events: { onReplySent: replySent },
      runtime: new StandaloneChatRuntime({
        apiKey: 'test-key',
        discordRulesByGuild: {},
        maxHistoryMessages: 4,
        model: 'test-model',
        systemPrompt: 'You are AIRI.',
      }, async () => ({ text: 'deferred speech reply' })),
      speechRuntime: new StandaloneSpeechRuntime({
        stt: { apiKey: 'stt-key', model: 'whisper-1' },
        tts: { apiKey: 'tts-key', model: 'tts-1', voice: 'alloy' },
      }, {
        synthesize: async (_text, _config, options) => {
          providerSignal = options?.abortSignal
          markSpeechStarted()
          return speechResult
        },
        transcribe: async () => '',
      }),
    })
    const abortController = new AbortController()
    const deadlineAt = Date.now() + 30_000
    const handleVoiceTranscription = Reflect.get(adapter, 'handleVoiceTranscription')
    const task = Reflect.apply(handleVoiceTranscription, adapter, [{
      abortSignal: abortController.signal,
      channelId: 'voice-a',
      deadlineAt,
      guildId: 'guild-1',
      rateLimitAdmitted: true,
      speaker: { displayName: 'Speaker', guildName: 'Guild' },
      speechProviderOwnerKey: 'guild-1:voice-a:1:user-1',
      speechProviderPrincipalKey: 'user-1',
      text: 'channel A turn',
      userId: 'user-1',
    }]) as Promise<Readable | undefined>
    await speechStarted

    abortController.abort(new Error('voice channel moved'))

    // ROOT CAUSE:
    //
    // A provider that ignored AbortSignal kept the adapter waiting for its raw
    // bytes. Releasing those bytes after a move could return a playable stream
    // owned by the invalid generation. Cancellation now resolves the adapter
    // before the orphan settles, and its late bytes cannot publish a reply.
    // @example
    await expect(task).resolves.toBeUndefined()
    // @example
    expect(providerSignal?.aborted).toBe(true)
    // @example
    expect(replySent).not.toHaveBeenCalled()

    resolveSpeech(new Uint8Array([1, 2, 3]).buffer)
    await Promise.resolve()
    await Promise.resolve()

    // @example
    expect(replySent).not.toHaveBeenCalled()
  })
})

/**
 * @example
 * describe('standalone Discord direct-message recovery', () => {})
 */
describe('standalone Discord direct-message recovery', () => {
  /**
   * @example
   * it('recovers an uncached DM that Discord.js drops after the raw event', async () => {})
   */
  it('recovers an uncached DM that Discord.js drops after the raw event', async () => {
    const sent: string[] = []
    const adapter = new StandaloneDiscordAdapter({
      filterConfig: {
        auditLogEnabled: false,
        messagePacingMs: 0,
        privacyNoticeEnabled: false,
      },
      runtime: new StandaloneChatRuntime({
        apiKey: 'test-key',
        discordRulesByGuild: {},
        maxHistoryMessages: 4,
        model: 'test-model',
        systemPrompt: 'You are AIRI.',
      }, async () => ({ text: 'dm reply' })),
    })
    const discordClient = Reflect.get(adapter, 'discordClient')
    const channel = {
      isDMBased: () => true,
      isTextBased: () => true,
      isThread: () => false,
      messages: {
        fetch: vi.fn(async () => ({
          author: { bot: false, id: 'user-1', username: 'Owen' },
          channel: {
            isThread: () => false,
            send: async (payload: SafeDiscordTextPayload) => sent.push(payload.content),
          },
          channelId: 'dm-channel',
          content: 'hello from dm',
          guild: undefined,
          guildId: undefined,
          inGuild: () => false,
          member: undefined,
        })),
      },
    }
    const fetchChannel = vi.fn(async () => channel)
    Reflect.set(Reflect.get(discordClient, 'channels'), 'fetch', fetchChannel)

    // ROOT CAUSE:
    //
    // Discord.js 14.26.3 receives raw DM MESSAGE_CREATE payloads, but its
    // MessageCreateAction cannot construct an uncached DMChannel because the
    // payload has no channel `type`. It therefore emits no MessageCreate event.
    discordClient.emit(Events.Raw, {
      d: {
        channel_id: 'dm-channel',
        id: 'message-1',
      },
      t: 'MESSAGE_CREATE',
    })

    await vi.waitFor(() => {
      expect(fetchChannel).toHaveBeenCalledWith('dm-channel')
      expect(sent).toEqual(['dm reply'])
    })
  })
})

/**
 * @example
 * describe('standalone Discord typing keepalive', () => {})
 */
describe('standalone Discord typing keepalive', () => {
  /**
   * @example
   * it('refreshes typing while a model reply remains pending', async () => {})
   */
  it('refreshes typing while a model reply remains pending', async () => {
    let typingCalls = 0
    const sent: string[] = []
    const adapter = new StandaloneDiscordAdapter({
      filterConfig: {
        auditLogEnabled: false,
        messagePacingMs: 0,
        privacyNoticeEnabled: false,
      },
      runtime: new StandaloneChatRuntime({
        apiKey: 'test-key',
        discordRulesByGuild: {},
        maxHistoryMessages: 4,
        model: 'test-model',
        systemPrompt: 'You are AIRI.',
      }, async () => {
        await new Promise(resolve => setTimeout(resolve, 24))
        return { text: 'reply' }
      }),
      typingRefreshIntervalMs: 5,
    })
    const channel = {
      isThread: () => false,
      send: async (payload: SafeDiscordTextPayload) => {
        sent.push(payload.content)
      },
      sendTyping: async () => {
        typingCalls += 1
      },
    }
    const handleDiscordMessage = Reflect.get(adapter, 'handleDiscordMessage')

    await Reflect.apply(handleDiscordMessage, adapter, [{
      author: { bot: false, id: 'user-1', username: 'Owen' },
      channel,
      channelId: 'dm-channel',
      content: 'hello',
      guild: undefined,
      guildId: undefined,
      inGuild: () => false,
      member: undefined,
    }])

    expect(typingCalls).toBeGreaterThanOrEqual(3)
    expect(sent).toEqual(['reply'])
  })
})

/**
 * @example
 * describe('standalone localized Discord errors', () => {})
 */
describe('standalone localized Discord errors', () => {
  /**
   * @example
   * it('keeps provider secrets out of reply observability for Discord audit D-018', async () => {})
   */
  it('keeps provider secrets out of reply observability for Discord audit D-018', async () => {
    const secretSentinel = 'SYNTHETIC_TOKEN=https://provider.invalid/private body=SYNTHETIC_PROMPT'
    const sent: string[] = []
    const replyFailed = vi.fn()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const consoleInfo = vi.spyOn(console, 'info').mockImplementation(() => {})
    const adapter = new StandaloneDiscordAdapter({
      events: { onReplyFailed: replyFailed },
      filterConfig: {
        auditLogEnabled: true,
        messagePacingMs: 0,
        privacyNoticeEnabled: false,
      },
      runtime: new StandaloneChatRuntime({
        apiKey: 'test-key',
        discordRulesByGuild: {},
        maxHistoryMessages: 4,
        model: 'test-model',
        systemPrompt: 'You are AIRI.',
      }, async () => {
        throw new Error(secretSentinel)
      }),
    })
    const channel = {
      isThread: () => false,
      send: async (payload: SafeDiscordTextPayload) => {
        sent.push(payload.content)
      },
      sendTyping: async () => {},
    }
    const handleDiscordMessage = Reflect.get(adapter, 'handleDiscordMessage')

    await Reflect.apply(handleDiscordMessage, adapter, [{
      author: { bot: false, id: 'synthetic-user', username: 'Synthetic user' },
      channel,
      channelId: 'synthetic-dm',
      content: 'synthetic request',
      guild: undefined,
      guildId: undefined,
      inGuild: () => false,
      member: undefined,
    }])

    // ROOT CAUSE:
    //
    // Standalone chat copied provider-controlled Error.message into its public
    // runtime error. The adapter then wrote it to console, audit state, and the
    // dashboard callback. Provider URLs, bodies, echoed prompts, or tokens could
    // therefore persist even though the Discord fallback itself was localized.
    const observablePayload = JSON.stringify([
      consoleError.mock.calls,
      consoleInfo.mock.calls,
      replyFailed.mock.calls,
      sent,
    ])
    expect(observablePayload).not.toContain(secretSentinel)
    expect(observablePayload).not.toContain('provider.invalid')
    expect(replyFailed).toHaveBeenCalledWith({
      errorKind: 'unknown',
      errorName: 'StandaloneChatRuntimeError',
      operationSequence: 1,
      surface: 'text-direct-message',
    })
    expect(consoleInfo).toHaveBeenCalledWith(
      '[discord-bot:standalone] audit',
      expect.objectContaining({
        errorKind: 'unknown',
        errorName: 'StandaloneChatRuntimeError',
        event: 'reply-failed',
        operationSequence: 1,
        surface: 'text-direct-message',
      }),
    )
    expect(sent).toEqual(['A reply could not be generated. Check the local runtime log.'])
    consoleError.mockRestore()
    consoleInfo.mockRestore()
  })

  /**
   * @example
   * it('uses the current message language for direct-message errors', () => {})
   */
  it('uses the current message language for direct-message errors', () => {
    expect(formatStandaloneDiscordReplyError({
      channelId: 'dm-channel',
      directMessage: true,
      displayName: 'Owen',
      sessionId: 'dm-user-1',
      text: '你还在吗？',
    }, new StandaloneChatRuntimeError('timeout', 'request timed out'))).toBe('这次模型响应超时了。请稍后再试一次。')
  })

  /**
   * @example
   * it('uses a language-specific guild channel name before ambiguous text', () => {})
   */
  it('uses a language-specific guild channel name before ambiguous text', () => {
    expect(formatStandaloneDiscordReplyError({
      channelId: 'channel-fr',
      channelName: 'general-fr',
      directMessage: false,
      displayName: 'Owen',
      guildId: 'guild-1',
      sessionId: 'guild-user-1',
      text: 'ok',
    }, new StandaloneChatRuntimeError('service-unavailable', 'provider sent 503'))).toBe('Le service du modèle est temporairement indisponible après une nouvelle tentative. Réessaie plus tard.')
  })
})

/**
 * @example
 * describe('resolveStandaloneDiscordSessionId', () => {})
 */
describe('resolveStandaloneDiscordSessionId', () => {
  /**
   * @example
   * it('scopes standalone guild chats by guild, channel, and user', () => {})
   */
  it('scopes standalone guild chats by guild, channel, and user', () => {
    expect(resolveStandaloneDiscordSessionId({
      channelId: 'channel-a',
      guildId: 'guild-1',
      userId: 'user-1',
    })).toBe('discord-standalone-guild-guild-1-channel-channel-a-user-user-1')

    expect(resolveStandaloneDiscordSessionId({
      channelId: 'channel-a',
      guildId: 'guild-1',
      userId: 'user-2',
    })).toBe('discord-standalone-guild-guild-1-channel-channel-a-user-user-2')
  })

  /**
   * @example
   * it('scopes standalone direct messages by exact Discord user id', () => {})
   */
  it('scopes standalone direct messages by exact Discord user id', () => {
    expect(resolveStandaloneDiscordSessionId({
      channelId: 'dm-channel',
      userId: 'user-1',
    })).toBe('discord-standalone-dm-user-1')
  })

  /**
   * @example
   * it('fails closed when required Discord ids are missing', () => {})
   */
  it('fails closed when required Discord ids are missing', () => {
    expect(resolveStandaloneDiscordSessionId({
      guildId: 'guild-1',
      userId: 'user-1',
    })).toBeUndefined()

    expect(resolveStandaloneDiscordSessionId({
      channelId: 'channel-a',
    })).toBeUndefined()
  })
})
