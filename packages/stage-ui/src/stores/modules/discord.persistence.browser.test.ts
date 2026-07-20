import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useDiscordStore } from './discord'

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

/**
 * @example
 * describe('discord observed-scope persistence', () => {})
 */
describe('discord observed-scope persistence', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    globalThis.localStorage.clear()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-01T00:00:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
    globalThis.localStorage.clear()
  })

  /**
   * @example
   * it('expires persisted observed scopes when the store starts (Discord audit D-012)', () => {})
   */
  it('expires persisted observed scopes when the store starts (Discord audit D-012)', () => {
    // ROOT CAUSE:
    //
    // TTL cleanup originally ran only while recording another Discord input.
    // If the bot became idle, expired high-cardinality discovery state remained
    // in localStorage and in the settings UI indefinitely.
    //
    // Store initialization must apply the same bounded TTL policy even when no
    // later Discord event arrives.
    globalThis.localStorage.setItem('settings/discord/observed-guilds/v1', JSON.stringify({
      'startup-expired-guild': {
        guildId: 'startup-expired-guild',
        channels: {
          'startup-expired-channel': {
            channelId: 'startup-expired-channel',
            lastSeenAt: Date.now() - 31 * 24 * 60 * 60 * 1000,
          },
        },
        lastSeenAt: Date.now() - 31 * 24 * 60 * 60 * 1000,
      },
    }))

    const store = useDiscordStore()

    // @example
    expect(store.observedGuildsById['startup-expired-guild']).toBeUndefined()
  })

  /**
   * @example
   * it('preserves user-owned guild configuration across store startup (Discord audit D-027)', () => {})
   */
  it('preserves user-owned guild configuration across store startup (Discord audit D-027)', () => {
    // ROOT CAUSE:
    //
    // Store construction previously merged bundled owner-specific presets into
    // persisted rules and replaced the user's selected guild. Existing local
    // configuration therefore was not an authoritative startup input.
    //
    // Before: startup added bundled records and changed the selected guild.
    // After: the exact synthetic localStorage records and selections survive
    // repeated store construction without additions or replacement.
    const persistedRules = {
      'synthetic-guild': {
        guildId: 'synthetic-guild',
        guildName: 'Synthetic Guild',
        rules: 'Synthetic guild rule.',
        channels: {
          'synthetic-channel': {
            channelId: 'synthetic-channel',
            rules: 'Synthetic channel rule.',
            updatedAt: 1_784_116_800_000,
          },
        },
        updatedAt: 1_784_116_800_000,
      },
    }
    globalThis.localStorage.setItem('settings/discord/rules/by-guild/v1', JSON.stringify(persistedRules))
    globalThis.localStorage.setItem('settings/discord/rules/selected-guild-id', 'synthetic-guild')
    globalThis.localStorage.setItem('settings/discord/rules/selected-channel-id', 'synthetic-channel')

    const store = useDiscordStore()

    // @example
    expect(store.rulesByGuild).toEqual(persistedRules)
    // @example
    expect(store.selectedGuildId).toBe('synthetic-guild')
    // @example
    expect(store.selectedChannelId).toBe('synthetic-channel')
    // @example
    expect(globalThis.localStorage.getItem('settings/discord/rules/by-guild/v1')).toBe(JSON.stringify(persistedRules))
    // @example
    expect(Array.from(
      { length: globalThis.localStorage.length },
      (_, index) => globalThis.localStorage.key(index) ?? '',
    ).some(key => /preset/i.test(key))).toBe(false)

    setActivePinia(createPinia())
    const restartedStore = useDiscordStore()

    // @example
    expect(restartedStore.rulesByGuild).toEqual(persistedRules)
    // @example
    expect(restartedStore.selectedGuildId).toBe('synthetic-guild')
    // @example
    expect(restartedStore.selectedChannelId).toBe('synthetic-channel')
  })
})
