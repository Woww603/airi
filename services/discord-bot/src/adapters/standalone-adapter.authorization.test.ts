import { Events, PermissionFlagsBits, PermissionsBitField } from 'discord.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { StandaloneChatRuntime } from '../standalone/chat-runtime'
import { StandaloneSpeechRuntime } from '../standalone/speech-runtime'
import { StandaloneDiscordAdapter } from './standalone-adapter'

const standaloneAuthorizationMocks = vi.hoisted(() => ({
  discordClient: undefined as { emit: (event: string, ...args: unknown[]) => boolean } | undefined,
  handleJoinChannelCommand: vi.fn(async () => {}),
  handleLeaveChannelCommand: vi.fn(async () => {}),
}))

vi.mock('discord.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('discord.js')>()

  return {
    ...actual,
    Client: class extends actual.Client {
      constructor(options: ConstructorParameters<typeof actual.Client>[0]) {
        super(options)
        standaloneAuthorizationMocks.discordClient = {
          emit: (event, ...args) => this.emit(event, ...args),
        }
      }
    },
  }
})

vi.mock('../bots/discord/commands/summon', () => ({
  VoiceManager: class {
    handleJoinChannelCommand = standaloneAuthorizationMocks.handleJoinChannelCommand
    handleLeaveChannelCommand = standaloneAuthorizationMocks.handleLeaveChannelCommand

    getVoiceCallMode() {
      return 'classic'
    }

    isRealtimeVoiceCallConfigured() {
      return false
    }

    async stop() {}
  },
}))

beforeEach(() => {
  standaloneAuthorizationMocks.discordClient = undefined
  standaloneAuthorizationMocks.handleJoinChannelCommand.mockClear()
  standaloneAuthorizationMocks.handleLeaveChannelCommand.mockClear()
})

/**
 * @example
 * describe('standalone Discord voice authorization boundary', () => {})
 */
describe('standalone Discord voice authorization boundary', () => {
  /**
   * @example
   * it('discord audit D-010 rejects ManageGuild when a configured admin role is missing', async () => {})
   */
  it('discord audit D-010 rejects ManageGuild when a configured admin role is missing', async () => {
    const adapter = new StandaloneDiscordAdapter({
      filterConfig: {
        adminRoleIds: ['role-admin'],
      },
      runtime: new StandaloneChatRuntime({
        apiKey: 'synthetic-model-key',
        discordRulesByGuild: {},
        maxHistoryMessages: 4,
        model: 'synthetic-model',
        systemPrompt: 'You are AIRI.',
      }, async () => ({ text: 'synthetic reply' })),
      speechRuntime: new StandaloneSpeechRuntime({
        stt: { apiKey: 'synthetic-stt-key', model: 'synthetic-stt' },
        tts: { apiKey: 'synthetic-tts-key', model: 'synthetic-tts', voice: 'synthetic-voice' },
      }, {
        synthesize: async () => new ArrayBuffer(0),
        transcribe: async () => '',
      }),
    })
    const reply = vi.fn(async () => {})
    const interaction = {
      commandName: 'summon',
      inCachedGuild: () => true,
      isButton: () => false,
      isChatInputCommand: () => true,
      member: {
        roles: ['role-member'],
      },
      memberPermissions: new PermissionsBitField(PermissionFlagsBits.ManageGuild),
      reply,
      user: {
        id: 'user-1',
        tag: 'synthetic-user',
      },
    }

    // ROOT CAUSE:
    //
    // Standalone voice management checks ManageGuild at runtime but ignores
    // the configured admin role ids already present in its filter config. A
    // member with ManageGuild and the wrong role can therefore invoke summon.
    standaloneAuthorizationMocks.discordClient?.emit(Events.InteractionCreate, interaction)
    await Promise.resolve()
    await Promise.resolve()

    expect(reply).toHaveBeenCalledWith(expect.objectContaining({
      ephemeral: true,
    }))
    expect(standaloneAuthorizationMocks.handleJoinChannelCommand).not.toHaveBeenCalled()
    await adapter.stop()
  })
})
