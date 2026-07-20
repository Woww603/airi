import type { ChatStreamEventContext } from '@proj-airi/core-agent'

import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useDiscordStore } from './discord'

type DiscordInput = NonNullable<ChatStreamEventContext['input']>
type DiscordMetadata = NonNullable<DiscordInput['data']['discord']>

const configuratorMocks = vi.hoisted(() => ({
  updateFor: vi.fn(),
  updateSecureFor: vi.fn(),
}))

vi.mock('../configurator', () => ({
  useConfiguratorByModsChannelServer: () => ({
    updateFor: configuratorMocks.updateFor,
    updateSecureFor: configuratorMocks.updateSecureFor,
  }),
}))

function createMetadata(pluginId = 'discord') {
  return {
    source: {
      id: `${pluginId}-1`,
      kind: 'plugin' as const,
      plugin: {
        id: pluginId,
      },
    },
  }
}

function inputWithDiscord(discord: DiscordMetadata, pluginId = 'discord'): DiscordInput {
  return {
    type: 'input:text',
    metadata: createMetadata(pluginId),
    data: {
      text: 'hello',
      discord,
    },
  }
}

/**
 * @example
 * describe('discord store scoped rules', () => {})
 */
describe('discord store scoped rules', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    globalThis.localStorage?.clear()
    configuratorMocks.updateFor.mockReset()
    configuratorMocks.updateSecureFor.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  /**
   * @example
   * it('starts without bundled guild data (Discord audit D-027)', () => {})
   */
  it('starts without bundled guild data (Discord audit D-027)', () => {
    // ROOT CAUSE:
    //
    // The production store bundled owner-specific guild ids, labels, rules, and
    // a versioned auto-apply marker. Constructing the store on a fresh profile
    // therefore materialized permanent guild configuration and selected one of
    // those guilds without any user action.
    //
    // Before: fresh `rulesByGuild` contained bundled records and the selection
    // pointed at a bundled guild.
    // After: fresh rules and selections are empty, and no preset marker is
    // written to localStorage.
    const store = useDiscordStore()
    const discordStorageKeys = Array.from(
      { length: globalThis.localStorage?.length ?? 0 },
      (_, index) => globalThis.localStorage?.key(index) ?? '',
    ).filter(key => key.includes('discord'))

    // @example
    expect(store.rulesByGuild).toEqual({})
    // @example
    expect(store.selectedGuildId).toBe('')
    // @example
    expect(store.selectedChannelId).toBe('')
    // @example
    expect(discordStorageKeys.some(key => /preset/i.test(key))).toBe(false)

    store.rememberObservedDiscordScope(inputWithDiscord({
      guildId: 'synthetic-observed-guild',
      guildName: 'Synthetic Observed Guild',
      channelId: 'synthetic-observed-channel',
    }))

    // @example
    expect(store.observedGuildsById['synthetic-observed-guild']).toBeDefined()
    // @example
    expect(store.rulesByGuild).toEqual({})
    // @example
    expect(store.selectedGuildId).toBe('')
    // @example
    expect(store.selectedChannelId).toBe('')
  })

  /**
   * @example
   * it('builds rule prompts only for exact Discord guild and channel metadata', () => {})
   */
  it('builds rule prompts only for exact Discord guild and channel metadata', () => {
    const store = useDiscordStore()

    store.saveGuildRules(' guild-a ', 'Use the Alpha moderation policy.', 'Alpha')
    store.saveChannelRules('guild-a', ' channel-1 ', 'No spoiler discussion.')

    const exactPrompt = store.buildRulesPromptForInput(inputWithDiscord({
      guildId: 'guild-a',
      guildName: 'Alpha',
      channelId: 'channel-1',
      guildMember: {
        id: 'user-1',
        displayName: 'Synthetic Member One',
        nickname: 'Synthetic Member One',
      },
    }))
    const otherChannelPrompt = store.buildRulesPromptForInput(inputWithDiscord({
      guildId: 'guild-a',
      channelId: 'channel-2',
      guildMember: {
        id: 'user-2',
        displayName: 'Synthetic Member Two',
        nickname: 'Synthetic Member Two',
      },
    }))
    const otherGuildPrompt = store.buildRulesPromptForInput(inputWithDiscord({
      guildId: 'guild-b',
      channelId: 'channel-1',
      guildMember: {
        id: 'user-3',
        displayName: 'Synthetic Member Three',
        nickname: 'Synthetic Member Three',
      },
    }))

    // @example
    expect(exactPrompt).toContain('Use the Alpha moderation policy.')
    // @example
    expect(exactPrompt).toContain('No spoiler discussion.')
    // @example
    expect(otherChannelPrompt).toContain('Use the Alpha moderation policy.')
    // @example
    expect(otherChannelPrompt).not.toContain('No spoiler discussion.')
    // @example
    expect(otherGuildPrompt).toContain('Discord hard safety rules for this turn:')
    // @example
    expect(otherGuildPrompt).not.toContain('Use the Alpha moderation policy.')
  })

  /**
   * @example
   * it('does not trust Discord payload fields from non-Discord sources', () => {})
   */
  it('does not trust Discord payload fields from non-Discord sources', () => {
    const store = useDiscordStore()

    store.saveGuildRules('guild-a', 'Use the Alpha moderation policy.')
    store.rememberObservedDiscordScope(inputWithDiscord({
      guildId: 'guild-a',
      channelId: 'channel-1',
    }, 'weather'))

    const spoofedPrompt = store.buildRulesPromptForInput(inputWithDiscord({
      guildId: 'guild-a',
      channelId: 'channel-1',
    }, 'weather'))

    // @example
    expect(spoofedPrompt).toBe('')
    // @example
    expect(store.observedGuildsById['guild-a']).toBeUndefined()
  })

  /**
   * @example
   * it('does not apply guild rules to Discord DMs or missing guild metadata', () => {})
   */
  it('does not apply guild rules to Discord DMs or missing guild metadata', () => {
    const store = useDiscordStore()

    store.saveGuildRules('guild-a', 'Use the Alpha moderation policy.')

    const dmPrompt = store.buildRulesPromptForInput(inputWithDiscord({
      channelId: 'dm-channel',
      guildMember: {
        id: 'user-1',
        displayName: 'Synthetic Member One',
        nickname: 'Synthetic Member One',
      },
    }))

    // @example
    expect(dmPrompt).toContain('Discord hard safety rules for this turn:')
    // @example
    expect(dmPrompt).not.toContain('Use the Alpha moderation policy.')
  })

  /**
   * @example
   * it('records observed Discord scopes without creating rules', () => {})
   */
  it('records observed Discord scopes without creating rules', () => {
    const store = useDiscordStore()

    store.rememberObservedDiscordScope(inputWithDiscord({
      guildId: ' guild-a ',
      guildName: ' Alpha ',
      channelId: ' channel-1 ',
    }))

    // @example
    expect(store.observedGuildsById['guild-a']?.guildName).toBe('Alpha')
    // @example
    expect(store.observedGuildsById['guild-a']?.channels['channel-1']?.channelId).toBe('channel-1')
    // @example
    expect(store.rulesByGuild['guild-a']).toBeUndefined()
  })

  /**
   * @example
   * it('bounds observed Discord scope state while retaining selected and current scopes (Discord audit D-012)', () => {})
   */
  it('bounds observed Discord scope state while retaining selected and current scopes (Discord audit D-012)', () => {
    // ROOT CAUSE:
    //
    // Every trusted guild/channel pair was appended to persisted
    // `observedGuildsById` forever. A high-cardinality Discord process could
    // therefore grow localStorage without a TTL or hard limit, and a naive
    // cleanup could evict the settings page's selected scope while it was in use.
    //
    // Before: 160 guilds and 300 channels remained persisted indefinitely.
    // After: expired/LRU entries are capped while the selected and just-observed
    // scopes remain available.
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
    const store = useDiscordStore()

    store.selectedGuildId = 'selected-guild'
    store.selectedChannelId = 'selected-channel'
    store.rememberObservedDiscordScope(inputWithDiscord({
      guildId: 'selected-guild',
      channelId: 'selected-channel',
    }))
    store.rememberObservedDiscordScope(inputWithDiscord({
      guildId: 'expired-guild',
      channelId: 'expired-channel',
    }))

    vi.advanceTimersByTime(31 * 24 * 60 * 60 * 1000)

    for (let index = 0; index < 300; index += 1) {
      vi.advanceTimersByTime(1)
      store.rememberObservedDiscordScope(inputWithDiscord({
        guildId: 'selected-guild',
        channelId: `channel-${index}`,
      }))
    }

    for (let index = 0; index < 160; index += 1) {
      vi.advanceTimersByTime(1)
      store.rememberObservedDiscordScope(inputWithDiscord({
        guildId: `guild-${index}`,
        channelId: 'general',
      }))
    }

    // @example
    expect(Object.keys(store.observedGuildsById)).toHaveLength(128)
    // @example
    expect(store.observedGuildsById['expired-guild']).toBeUndefined()
    // @example
    expect(store.observedGuildsById['selected-guild']).toBeDefined()
    // @example
    expect(store.observedGuildsById['guild-159']).toBeDefined()
    // @example
    expect(Object.keys(store.observedGuildsById['selected-guild']?.channels ?? {})).toHaveLength(256)
    // @example
    expect(store.observedGuildsById['selected-guild']?.channels['selected-channel']).toBeDefined()
    // @example
    expect(store.observedGuildsById['selected-guild']?.channels['channel-299']).toBeDefined()
    // @example
    expect(store.rulesByGuild['expired-guild']).toBeUndefined()
  })

  /**
   * @example
   * it('keeps the bot token on the protected configurator path (Discord audit D-001)', () => {})
   */
  it('keeps the bot token on the protected configurator path (Discord audit D-001)', () => {
    // ROOT CAUSE:
    //
    // The Discord store previously embedded the raw bot token in `ui:configure`.
    // Every generic websocket observer and the Stage websocket inspector could
    // therefore read a credential that belongs only to Electron Main and its
    // managed Discord utility process.
    //
    // Before: `{ token: 'synthetic-discord-token', enabled: true, ...policy }`
    // was sent through the generic websocket configurator.
    // After: the whole Discord update uses the protected configurator with an
    // explicit token action, so generic configuration receives nothing.
    const store = useDiscordStore()

    store.enabled = true
    store.token = ' synthetic-discord-token '
    store.allowedChannelIdsText = ' channel-a, channel-b\nchannel-a '
    store.adminRoleIdsText = ' role-a; role-b role-a '
    store.allowDirectMessages = false
    store.memoryConsentRequired = true
    store.privacyNoticeEnabled = true
    store.privacyNoticeText = ' Custom privacy notice. '
    store.auditLogEnabled = true
    store.messagePacingMs = 12_000
    store.rateLimitMaxMessages = -1
    store.rateLimitWindowMs = 600_000

    store.syncSavedSettingsToBackend({ force: true })

    // @example
    expect(configuratorMocks.updateFor).not.toHaveBeenCalled()
    // @example
    expect(configuratorMocks.updateSecureFor).toHaveBeenCalledWith('discord', {
      token: {
        action: 'set',
        value: 'synthetic-discord-token',
      },
      enabled: true,
      allowedChannelIds: ['channel-a', 'channel-b'],
      adminRoleIds: ['role-a', 'role-b'],
      allowDirectMessages: false,
      memoryConsentRequired: true,
      privacyNoticeEnabled: true,
      privacyNoticeText: 'Custom privacy notice.',
      auditLogEnabled: true,
      messagePacingMs: 10_000,
      rateLimitMaxMessages: 0,
      rateLimitWindowMs: 300_000,
    })
  })

  /**
   * @example
   * it('syncs disable and security policy when the token field is empty (Discord audit D-004)', () => {})
   */
  it('syncs disable and security policy when the token field is empty (Discord audit D-004)', () => {
    // ROOT CAUSE:
    //
    // The module-announced synchronization returned early whenever Stage had no
    // token. That also discarded `enabled: false` and every security policy,
    // allowing an adapter with a separately provisioned token to stay online
    // before Stage policy reached it.
    //
    // Before: an empty token produced no configurator call.
    // After: non-secret enabled and security policy always synchronize through
    // the protected path with an explicit instruction to retain the secret.
    const store = useDiscordStore()

    store.enabled = false
    store.token = ''
    store.allowedChannelIdsText = ' channel-a '
    store.adminRoleIdsText = ' role-admin '
    store.allowDirectMessages = false
    store.privacyNoticeEnabled = true

    store.syncSavedSettingsToBackend()

    // @example
    expect(configuratorMocks.updateFor).not.toHaveBeenCalled()
    // @example
    expect(configuratorMocks.updateSecureFor).toHaveBeenCalledWith('discord', expect.objectContaining({
      token: {
        action: 'unchanged',
      },
      enabled: false,
      allowedChannelIds: ['channel-a'],
      adminRoleIds: ['role-admin'],
      allowDirectMessages: false,
      privacyNoticeEnabled: true,
    }))
  })

  /**
   * @example
   * it('requires consent before trusted Discord input can use long-term memory', () => {})
   */
  it('requires consent before trusted Discord input can use long-term memory', () => {
    const store = useDiscordStore()
    const discordInput = inputWithDiscord({
      guildId: 'guild-a',
      channelId: 'channel-1',
      guildMember: {
        id: 'user-1',
        displayName: 'Synthetic Member One',
        nickname: 'Synthetic Member One',
      },
    })

    // @example
    expect(store.shouldUseLongTermMemoryForInput(discordInput)).toBe(false)

    store.setLongTermMemoryConsent('discord-guild-guild-a-channel-channel-1-user-user-1', true)

    // @example
    expect(store.shouldUseLongTermMemoryForInput(discordInput)).toBe(true)

    store.setLongTermMemoryConsent('discord-guild-guild-a-channel-channel-1-user-user-1', false)

    // @example
    expect(store.shouldUseLongTermMemoryForInput(discordInput)).toBe(false)

    store.memoryConsentRequired = false

    // @example
    expect(store.shouldUseLongTermMemoryForInput(discordInput)).toBe(false)

    store.clearLongTermMemoryConsent('discord-guild-guild-a-channel-channel-1-user-user-1')

    // @example
    expect(store.shouldUseLongTermMemoryForInput(discordInput)).toBe(true)
    // @example
    expect(store.shouldUseLongTermMemoryForInput(inputWithDiscord({
      guildId: 'guild-a',
      channelId: 'channel-1',
    }, 'weather'))).toBe(true)
  })
})
