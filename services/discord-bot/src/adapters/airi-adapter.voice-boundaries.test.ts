import type { Readable } from 'node:stream'

import { Buffer } from 'node:buffer'

import { Events } from 'discord.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { DiscordAdapter } from './airi-adapter'

interface SyntheticVoiceInput {
  abortSignal: AbortSignal
  channelId: string
  deadlineAt: number
  guildId: string
  rateLimitAdmitted: true
  speaker: {
    displayName: string
    guildName: string
    nickname: string
  }
  speechProviderOwnerKey: string
  speechProviderPrincipalKey: string
  text: string
  userId: string
}

type SyntheticVoiceHandler = (input: SyntheticVoiceInput) => Promise<Readable | undefined>
type SyntheticVoiceTranscriber = (buffer: Buffer, options: {
  abortSignal: AbortSignal
  deadlineAt: number
  ownerKey: string
  principalKey: string
}) => Promise<string>
interface SyntheticVoiceAdmissionPolicy {
  admit: (input: { channelId: string, guildId: string, userId: string }) => boolean
  allows: (input: { channelId: string, guildId: string, userId: string }) => boolean
}
type ServerEventHandler = (event: { data: { config: Record<string, unknown> } }) => Promise<void> | void

const bridgeMocks = vi.hoisted(() => ({
  airiReady: undefined as (() => void) | undefined,
  airiStateChange: undefined as ((state: { previousStatus: string, status: string }) => void) | undefined,
  discordClient: undefined as { emit: (event: string, ...args: unknown[]) => boolean } | undefined,
  handleJoinChannelCommand: vi.fn(async () => {}),
  handleLeaveChannelCommand: vi.fn(async () => {}),
  revalidateSpeakerAdmissions: vi.fn(),
  send: vi.fn((_event: unknown) => true),
  serverEventHandlers: new Map<string, ServerEventHandler>(),
  transcribe: vi.fn(async () => 'synthetic transcript'),
  voiceAdmissionPolicy: undefined as SyntheticVoiceAdmissionPolicy | undefined,
  voiceHandler: undefined as SyntheticVoiceHandler | undefined,
  voiceStop: vi.fn(async () => {}),
  voiceTranscriber: undefined as SyntheticVoiceTranscriber | undefined,
}))

vi.mock('@proj-airi/server-sdk', () => ({
  Client: class {
    close = vi.fn(async () => {})
    send = bridgeMocks.send

    constructor(config: {
      onReady?: () => void
      onStateChange?: (state: { previousStatus: string, status: string }) => void
    }) {
      bridgeMocks.airiReady = config.onReady
      bridgeMocks.airiStateChange = config.onStateChange
    }

    onEvent(event: string, handler: ServerEventHandler) {
      bridgeMocks.serverEventHandlers.set(event, handler)
      return () => bridgeMocks.serverEventHandlers.delete(event)
    }
  },
}))

vi.mock('discord.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('discord.js')>()

  return {
    ...actual,
    Client: class extends actual.Client {
      constructor(options: ConstructorParameters<typeof actual.Client>[0]) {
        super(options)
        bridgeMocks.discordClient = {
          emit: (event, ...args) => this.emit(event, ...args),
        }
      }
    },
  }
})

vi.mock('../bots/discord/commands', () => ({
  handlePing: vi.fn(async () => {}),
  registerCommands: vi.fn(async () => {}),
  VoiceManager: class {
    handleJoinChannelCommand = bridgeMocks.handleJoinChannelCommand
    handleLeaveChannelCommand = bridgeMocks.handleLeaveChannelCommand
    revalidateSpeakerAdmissions = bridgeMocks.revalidateSpeakerAdmissions

    constructor(
      _client: unknown,
      handler: SyntheticVoiceHandler,
      transcriber: SyntheticVoiceTranscriber,
      _runtime: unknown,
      admissionPolicy: SyntheticVoiceAdmissionPolicy,
    ) {
      bridgeMocks.voiceHandler = handler
      bridgeMocks.voiceTranscriber = transcriber
      bridgeMocks.voiceAdmissionPolicy = admissionPolicy
    }

    stop = bridgeMocks.voiceStop
  },
}))

vi.mock('../pipelines/openai-speech', () => ({
  describeOpenAICompatibleProvider: (baseURL?: string) => baseURL
    ? 'the OpenAI-compatible provider at speech.example'
    : 'OpenAI at api.openai.com',
  transcribeOpenAICompatible: bridgeMocks.transcribe,
}))

beforeEach(() => {
  bridgeMocks.airiReady = undefined
  bridgeMocks.airiStateChange = undefined
  bridgeMocks.discordClient = undefined
  bridgeMocks.handleJoinChannelCommand.mockClear()
  bridgeMocks.handleLeaveChannelCommand.mockClear()
  bridgeMocks.revalidateSpeakerAdmissions.mockClear()
  bridgeMocks.send.mockClear()
  bridgeMocks.serverEventHandlers.clear()
  bridgeMocks.transcribe.mockClear()
  bridgeMocks.voiceAdmissionPolicy = undefined
  bridgeMocks.voiceHandler = undefined
  bridgeMocks.voiceStop.mockReset()
  bridgeMocks.voiceStop.mockResolvedValue(undefined)
  bridgeMocks.voiceTranscriber = undefined
})

/**
 * @example
 * describe('AIRI Discord bridge voice boundaries', () => {})
 */
describe('airi Discord bridge voice boundaries', () => {
  /**
   * @example
   * it('keeps raw ingress closed until AIRI is ready for Discord audit D-018', async () => {})
   */
  it('keeps raw ingress closed until AIRI is ready for Discord audit D-018', async () => {
    const adapter = new DiscordAdapter({})
    const syntheticSend = vi.fn(async () => {})
    const discordClient = Reflect.get(adapter, 'discordClient')
    discordClient.channels.fetch = vi.fn(async () => ({
      isTextBased: () => true,
      send: syntheticSend,
    }))
    discordClient.users.fetch = vi.fn(async () => ({ send: syntheticSend }))
    Reflect.set(adapter, 'runtimePolicyEnabled', true)
    bridgeMocks.discordClient?.emit(Events.ShardReady)

    const rawMessage = {
      d: {
        author: {
          bot: false,
          global_name: 'Synthetic user',
          id: 'synthetic-user',
          username: 'synthetic-user',
        },
        channel_id: 'synthetic-dm',
        content: 'synthetic initial-connect turn',
        id: 'synthetic-message-before-ready',
      },
      t: 'MESSAGE_CREATE',
    }

    // ROOT CAUSE:
    //
    // AIRI transport availability was initialized optimistically. If Discord
    // connected before ServerChannel's first onReady callback, raw ingress could
    // allocate a provider turn with no canonical Stage owner. Readiness is now
    // fail-closed and only an observed AIRI ready signal may open the bridge.
    try {
      bridgeMocks.discordClient?.emit(Events.Raw, rawMessage)
      await Promise.resolve()
      await Promise.resolve()
      const handledBeforeAiriReady = Reflect.get(adapter, 'handledDiscordMessageIds').size

      bridgeMocks.airiReady?.()
      bridgeMocks.discordClient?.emit(Events.Raw, {
        ...rawMessage,
        d: {
          ...rawMessage.d,
          content: 'synthetic post-ready turn',
          id: 'synthetic-message-after-ready',
        },
      })
      await vi.waitFor(() => {
        expect(Reflect.get(adapter, 'handledDiscordMessageIds').size).toBe(handledBeforeAiriReady + 1)
      })

      // @example
      expect(handledBeforeAiriReady).toBe(0)
      // @example
      expect(Reflect.get(adapter, 'handledDiscordMessageIds').size).toBe(1)
    }
    finally {
      await adapter.stop()
    }
  })

  /**
   * @example
   * it('preserves the original voice deadline for Discord audit D-018', async () => {})
   */
  it('preserves the original voice deadline through canonical AIRI ingress for Discord audit D-018', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(10_000)
    const adapter = new DiscordAdapter({})
    try {
      await adapter.applyRuntimeConfig({
        enabled: false,
        messagePacingMs: 0,
        privacyNoticeEnabled: false,
      })
      Reflect.set(adapter, 'runtimePolicyEnabled', true)
      Reflect.set(adapter, 'discordIngressEnabled', true)

      await bridgeMocks.voiceHandler?.({
        abortSignal: new AbortController().signal,
        channelId: 'voice-deadline-channel',
        deadlineAt: 20_000,
        guildId: 'voice-deadline-guild',
        rateLimitAdmitted: true,
        speaker: {
          displayName: 'Synthetic speaker',
          guildName: 'Synthetic guild',
          nickname: 'Synthetic nickname',
        },
        speechProviderOwnerKey: 'voice-deadline-guild:voice-deadline-channel:1:voice-deadline-user',
        speechProviderPrincipalKey: 'voice-deadline-user',
        text: 'synthetic bounded voice turn',
        userId: 'voice-deadline-user',
      })

      // ROOT CAUSE:
      //
      // VoiceManager carried the admission deadline through STT, but the AIRI
      // adapter discarded it and allocated a fresh 45-second Stage deadline.
      // A nearly-expired voice turn could therefore outlive its exact capture
      // generation and publish late Stage/history/reply side effects.
      // Canonical allocation now takes the earlier voice or Stage deadline.
      const forwarded = bridgeMocks.send.mock.calls[0]?.[0] as {
        data?: { turn?: { deadlineAt?: number } }
      } | undefined
      // @example
      expect(forwarded?.data?.turn?.deadlineAt).toBe(20_000)
    }
    finally {
      await adapter.stop()
      vi.useRealTimers()
    }
  })

  /**
   * @example
   * it('rejects an expired voice deadline for Discord audit D-018', async () => {})
   */
  it('rejects an already-expired voice deadline before AIRI ingress for Discord audit D-018', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(10_000)
    const adapter = new DiscordAdapter({})
    try {
      await adapter.applyRuntimeConfig({
        enabled: false,
        messagePacingMs: 0,
        privacyNoticeEnabled: false,
      })
      Reflect.set(adapter, 'runtimePolicyEnabled', true)
      Reflect.set(adapter, 'discordIngressEnabled', true)

      await bridgeMocks.voiceHandler?.({
        abortSignal: new AbortController().signal,
        channelId: 'expired-voice-channel',
        deadlineAt: 9_999,
        guildId: 'expired-voice-guild',
        rateLimitAdmitted: true,
        speaker: {
          displayName: 'Synthetic speaker',
          guildName: 'Synthetic guild',
          nickname: 'Synthetic nickname',
        },
        speechProviderOwnerKey: 'expired-voice-guild:expired-voice-channel:1:expired-voice-user',
        speechProviderPrincipalKey: 'expired-voice-user',
        text: 'synthetic expired voice turn',
        userId: 'expired-voice-user',
      })

      // ROOT CAUSE:
      //
      // The bridge checked only AbortSignal. A provider result can resume after
      // wall-clock expiry before the deadline timer callback runs, so the stale
      // transcript previously allocated a new canonical turn and reached Stage.
      // Wall-clock admission now fails closed before correlation or send state.
      // @example
      expect(bridgeMocks.send).not.toHaveBeenCalled()
      // @example
      expect(Reflect.get(adapter, 'pendingDiscordTurnsById').size).toBe(0)
    }
    finally {
      await adapter.stop()
      vi.useRealTimers()
    }
  })

  /**
   * @example
   * it('Discord audit D-007 consumes bridge rate admission before STT and does not charge it twice', async () => {})
   */
  it('reproduces Discord audit D-007 by consuming bridge rate admission before STT without charging twice', async () => {
    const adapter = new DiscordAdapter({})
    await adapter.applyRuntimeConfig({
      allowedChannelIds: ['voice-1'],
      enabled: false,
      messagePacingMs: 0,
      privacyNoticeEnabled: false,
      rateLimitMaxMessages: 1,
      rateLimitWindowMs: 30_000,
    })
    Reflect.set(adapter, 'runtimePolicyEnabled', true)
    Reflect.set(adapter, 'discordIngressEnabled', true)
    const speaker = {
      channelId: 'voice-1',
      guildId: 'guild-1',
      userId: 'user-1',
    }

    // ROOT CAUSE:
    //
    // Bridge voice consumed the canonical rate bucket only after external STT.
    // Moving that exact charge before capture must not make the canonical text
    // path charge the same admitted voice turn a second time.
    const firstAdmission = bridgeMocks.voiceAdmissionPolicy?.admit(speaker)
    await bridgeMocks.voiceHandler?.({
      abortSignal: new AbortController().signal,
      channelId: speaker.channelId,
      deadlineAt: Date.now() + 30_000,
      guildId: speaker.guildId,
      rateLimitAdmitted: true,
      speaker: {
        displayName: 'Synthetic speaker',
        guildName: 'Synthetic guild',
        nickname: 'Synthetic nickname',
      },
      speechProviderOwnerKey: 'guild-1:voice-1:1:user-1',
      speechProviderPrincipalKey: 'user-1',
      text: 'first admitted voice turn',
      userId: speaker.userId,
    })
    const secondAdmission = bridgeMocks.voiceAdmissionPolicy?.admit(speaker)

    expect(firstAdmission).toBe(true)
    expect(bridgeMocks.send).toHaveBeenCalledOnce()
    expect(secondAdmission).toBe(false)
  })

  /**
   * @example
   * it('Discord audit D-011 drops late voice transcripts after disconnect', async () => {})
   */
  it('drops late voice transcripts after disconnect for Discord audit D-011', async () => {
    // ROOT CAUSE:
    //
    // VoiceManager's transcription callback entered canonical text handling
    // without checking the current bridge lifecycle. Shard disconnect cleared
    // existing turns but left VoiceManager running, so a transcript completing
    // afterward allocated and forwarded a brand-new provider turn.
    //
    // Before: invoking the late callback after disconnect emitted input:text.
    // After: disconnect stops voice work and the callback fails closed before
    // allocating correlation, rate buckets, history, or provider work.
    const adapter = new DiscordAdapter({})
    // NOTICE:
    // This unit test emits a synthetic shard event without a real Discord login.
    // The lifecycle flags model the connected state before that event.
    // Source/context: mocked Discord Client event emitter in this test file.
    // Remove when the test uses a synthetic public ready lifecycle.
    Reflect.set(adapter, 'runtimePolicyEnabled', true)
    Reflect.set(adapter, 'discordIngressEnabled', true)
    Reflect.get(adapter, 'discordClient').channels.fetch = vi.fn(async () => ({
      isTextBased: () => true,
      send: vi.fn(async () => {}),
    }))

    bridgeMocks.discordClient?.emit(Events.ShardDisconnect)
    await bridgeMocks.voiceHandler?.({
      abortSignal: new AbortController().signal,
      channelId: 'voice-1',
      deadlineAt: Date.now() + 30_000,
      guildId: 'guild-1',
      rateLimitAdmitted: true,
      speaker: {
        displayName: 'Synthetic speaker',
        guildName: 'Synthetic guild',
        nickname: 'Synthetic nickname',
      },
      speechProviderOwnerKey: 'guild-1:voice-1:1:user-1',
      speechProviderPrincipalKey: 'user-1',
      text: 'synthetic late voice turn',
      userId: 'user-1',
    })

    // @example
    expect(bridgeMocks.voiceStop).toHaveBeenCalledOnce()
    // @example
    expect(bridgeMocks.send).not.toHaveBeenCalled()
  })

  /**
   * @example
   * it('keeps ingress gated until deferred shard cleanup settles for Discord audit D-018', async () => {})
   */
  it('keeps ingress gated until deferred shard cleanup settles for Discord audit D-018', async () => {
    let releaseVoiceStop = () => {}
    bridgeMocks.voiceStop.mockImplementationOnce(() => new Promise<void>((resolve) => {
      releaseVoiceStop = resolve
    }))
    const adapter = new DiscordAdapter({})
    Reflect.set(adapter, 'runtimePolicyEnabled', true)
    Reflect.set(adapter, 'discordTransportReady', true)
    Reflect.set(adapter, 'discordIngressEnabled', true)
    bridgeMocks.airiReady?.()
    Reflect.get(adapter, 'discordClient').channels.fetch = vi.fn(async () => ({
      isTextBased: () => true,
      send: vi.fn(async () => {}),
    }))
    const voiceInput: SyntheticVoiceInput = {
      abortSignal: new AbortController().signal,
      channelId: 'voice-1',
      deadlineAt: Date.now() + 30_000,
      guildId: 'guild-1',
      rateLimitAdmitted: true,
      speaker: {
        displayName: 'Synthetic speaker',
        guildName: 'Synthetic guild',
        nickname: 'Synthetic nickname',
      },
      speechProviderOwnerKey: 'guild-1:voice-1:1:user-1',
      speechProviderPrincipalKey: 'user-1',
      text: 'synthetic shard-race turn',
      userId: 'user-1',
    }

    bridgeMocks.discordClient?.emit(Events.ShardDisconnect)
    bridgeMocks.discordClient?.emit(Events.ShardReady)
    await bridgeMocks.voiceHandler?.(voiceInput)
    const sendsBeforeCleanupSettled = bridgeMocks.send.mock.calls.length

    // ROOT CAUSE:
    //
    // ShardReady reopened ingress while the prior shard's voice stop was still
    // pending. A new generation could start and then be cleared by the old stop.
    // Ready now records transport availability but cannot reopen ingress until
    // the tracked disconnect generation has fully drained.
    releaseVoiceStop()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    await bridgeMocks.voiceHandler?.({
      ...voiceInput,
      text: 'synthetic post-cleanup turn',
    })

    // @example
    expect(sendsBeforeCleanupSettled).toBe(0)
    // @example
    expect(bridgeMocks.send).toHaveBeenCalledOnce()
    await adapter.stop()
  })

  /**
   * @example
   * it('stops voice and gates ingress across AIRI channel reconnect for Discord audit D-018', async () => {})
   */
  it('stops voice and gates ingress across AIRI channel reconnect for Discord audit D-018', async () => {
    let releaseVoiceStop = () => {}
    bridgeMocks.voiceStop.mockImplementationOnce(() => new Promise<void>((resolve) => {
      releaseVoiceStop = resolve
    }))
    const adapter = new DiscordAdapter({})
    Reflect.set(adapter, 'runtimePolicyEnabled', true)
    Reflect.set(adapter, 'discordTransportReady', true)
    Reflect.set(adapter, 'discordIngressEnabled', true)
    Reflect.get(adapter, 'discordClient').channels.fetch = vi.fn(async () => ({
      isTextBased: () => true,
      send: vi.fn(async () => {}),
    }))
    const voiceInput: SyntheticVoiceInput = {
      abortSignal: new AbortController().signal,
      channelId: 'voice-1',
      deadlineAt: Date.now() + 30_000,
      guildId: 'guild-1',
      rateLimitAdmitted: true,
      speaker: {
        displayName: 'Synthetic speaker',
        guildName: 'Synthetic guild',
        nickname: 'Synthetic nickname',
      },
      speechProviderOwnerKey: 'guild-1:voice-1:1:user-1',
      speechProviderPrincipalKey: 'user-1',
      text: 'synthetic AIRI-disconnect turn',
      userId: 'user-1',
    }

    // ROOT CAUSE:
    //
    // AIRI server-channel disconnect cleared text correlation only. VoiceManager
    // remained active, ingress stayed open, and a late STT result could allocate
    // a new Stage turn after a fast reconnect. Both transports now share the same
    // tracked disconnect teardown and exact voice-generation stop.
    bridgeMocks.airiStateChange?.({ previousStatus: 'ready', status: 'closed' })
    bridgeMocks.airiStateChange?.({ previousStatus: 'closed', status: 'ready' })
    await bridgeMocks.voiceHandler?.(voiceInput)
    const sendsBeforeCleanupSettled = bridgeMocks.send.mock.calls.length

    releaseVoiceStop()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    await bridgeMocks.voiceHandler?.({
      ...voiceInput,
      text: 'synthetic AIRI-reconnected turn',
    })

    // @example
    expect(bridgeMocks.voiceStop).toHaveBeenCalledOnce()
    // @example
    expect(sendsBeforeCleanupSettled).toBe(0)
    // @example
    expect(bridgeMocks.send).toHaveBeenCalledOnce()
    await adapter.stop()
  })

  /**
   * @example
   * it('Discord audit D-004 uses only the protected bootstrap STT credential', async () => {})
   */
  it('reproduces Discord audit D-004 by using only the protected bootstrap STT credential', async () => {
    const adapter = new DiscordAdapter({
      transcription: {
        apiKey: 'synthetic-protected-stt-key',
        baseURL: 'https://speech.example/v1',
        model: 'synthetic-stt-model',
      },
    })
    const abortSignal = new AbortController().signal
    const deadlineAt = Date.now() + 30_000
    const ownerKey = 'guild-1:voice-1:1:user-1'
    const principalKey = 'user-1'
    const wavBuffer = Buffer.from('synthetic-wav')

    // ROOT CAUSE:
    //
    // Electron Main correctly removed OPENAI_STT_API_KEY from the child process
    // environment, but the bridge adapter still read only that sanitized env.
    // Packaged classic voice therefore had no credential at its provider call.
    await bridgeMocks.voiceTranscriber?.(wavBuffer, { abortSignal, deadlineAt, ownerKey, principalKey })

    expect(bridgeMocks.transcribe).toHaveBeenCalledWith(wavBuffer, {
      apiKey: 'synthetic-protected-stt-key',
      baseURL: 'https://speech.example/v1',
      model: 'synthetic-stt-model',
    }, { abortSignal, deadlineAt, ownerKey, principalKey })
    await adapter.stop()
  })

  /**
   * @example
   * it('Discord audit D-010 rejects bridge summon without runtime ManageGuild permission', async () => {})
   */
  it('reproduces Discord audit D-010 by rejecting bridge summon without runtime ManageGuild permission', async () => {
    const adapter = new DiscordAdapter({})
    // NOTICE:
    // This unit test emits a synthetic Discord interaction without logging in.
    // The production handler is now gated by the parent-authorized connection lifecycle.
    // Source/context: services/discord-bot/src/adapters/airi-adapter.ts setupEventHandlers().
    // Remove when the test harness can emit a synthetic authenticated ClientReady lifecycle.
    Reflect.set(adapter, 'discordIngressEnabled', true)
    const reply = vi.fn(async () => {})
    const interaction = {
      commandName: 'summon',
      inCachedGuild: () => true,
      isButton: () => false,
      isChatInputCommand: () => true,
      member: { roles: [] },
      memberPermissions: { has: () => false },
      reply,
      user: {
        id: 'user-1',
        tag: 'synthetic-user',
      },
    }

    // ROOT CAUSE:
    //
    // Bridge runtime authorization checks configured role ids only. With the
    // default empty role list, any cached-guild interaction can reach voice
    // management even when Discord reports no ManageGuild permission.
    bridgeMocks.discordClient?.emit(Events.InteractionCreate, interaction)
    await Promise.resolve()
    await Promise.resolve()

    expect(reply).toHaveBeenCalledWith(expect.objectContaining({
      ephemeral: true,
    }))
    expect(bridgeMocks.handleJoinChannelCommand).not.toHaveBeenCalled()
    await adapter.stop()
  })
})
