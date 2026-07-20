import { describe, expect, it } from 'vitest'

import {
  canUseRestrictedDiscordCommand,
  hasRequiredDiscordAdminRole,
  isDiscordOwner,
  normalizeDiscordShortTermLimit,
  parseDiscordMemoryDurationMs,
  resolveDiscordInputPolicy,
  resolveDiscordMemberRoleIds,
  resolveDiscordMemoryScope,
  resolveDiscordRateLimit,
  resolveDiscordReplyTarget,
  resolveDiscordSessionId,
} from './airi-adapter'

describe('resolveDiscordSessionId', () => {
  it('scopes guild messages by guild, channel, and user so Discord identities cannot share sessions', () => {
    expect(resolveDiscordSessionId({
      guildId: 'guild-1',
      channelId: 'channel-a',
      guildMember: {
        id: 'user-1',
        displayName: 'User 1',
        nickname: 'User 1',
      },
    })).toBe('discord-guild-guild-1-channel-channel-a-user-user-1')

    expect(resolveDiscordSessionId({
      guildId: 'guild-1',
      channelId: 'channel-b',
      guildMember: {
        id: 'user-1',
        displayName: 'User 1',
        nickname: 'User 1',
      },
    })).toBe('discord-guild-guild-1-channel-channel-b-user-user-1')

    expect(resolveDiscordSessionId({
      guildId: 'guild-2',
      channelId: 'channel-a',
      guildMember: {
        id: 'user-1',
        displayName: 'User 1',
        nickname: 'User 1',
      },
    })).toBe('discord-guild-guild-2-channel-channel-a-user-user-1')

    expect(resolveDiscordSessionId({
      guildId: 'guild-1',
      channelId: 'channel-a',
      guildMember: {
        id: 'user-2',
        displayName: 'User 2',
        nickname: 'User 2',
      },
    })).toBe('discord-guild-guild-1-channel-channel-a-user-user-2')
  })

  it('scopes direct messages by Discord user id', () => {
    expect(resolveDiscordSessionId({
      channelId: 'dm-channel',
      guildMember: {
        id: 'discord-user-1',
        displayName: 'AIRI Friend',
        nickname: 'Friend',
      },
    })).toBe('discord-dm-discord-user-1')
  })

  it('fails closed for incomplete guild metadata instead of routing to unknown sessions', () => {
    expect(resolveDiscordSessionId({
      guildId: 'guild-1',
      channelId: 'channel-a',
    })).toBeUndefined()

    expect(resolveDiscordSessionId({
      guildId: 'guild-1',
      guildMember: {
        id: 'user-1',
        displayName: 'User 1',
        nickname: 'User 1',
      },
    })).toBeUndefined()

    expect(resolveDiscordSessionId()).toBeUndefined()
  })
})

/**
 * @example
 * describe('discord memory command helpers', () => {})
 */
describe('discord memory command helpers', () => {
  /**
   * @example
   * it('checks owner permissions by exact Discord user id', () => {})
   */
  it('checks owner permissions by exact Discord user id', () => {
    expect(isDiscordOwner(' 123 ', '123')).toBe(true)
    expect(isDiscordOwner('woww', '123')).toBe(false)
    expect(isDiscordOwner('123', undefined)).toBe(false)
  })

  /**
   * @example
   * it('normalizes short-term limits to a bounded range', () => {})
   */
  it('normalizes short-term limits to a bounded range', () => {
    expect(normalizeDiscordShortTermLimit(undefined)).toBe(20)
    expect(normalizeDiscordShortTermLimit('0')).toBe(1)
    expect(normalizeDiscordShortTermLimit('200')).toBe(80)
  })

  /**
   * @example
   * it('parses explicit temporary memory durations', () => {})
   */
  it('parses explicit temporary memory durations', () => {
    expect(parseDiscordMemoryDurationMs('30m')).toBe(30 * 60 * 1000)
    expect(parseDiscordMemoryDurationMs('6h')).toBe(6 * 60 * 60 * 1000)
    expect(parseDiscordMemoryDurationMs('2d')).toBe(2 * 24 * 60 * 60 * 1000)
    expect(parseDiscordMemoryDurationMs('soon')).toBeUndefined()
  })

  /**
   * @example
   * it('normalizes slash command memory scopes', () => {})
   */
  it('normalizes slash command memory scopes', () => {
    expect(resolveDiscordMemoryScope(' Channel ')).toBe('channel')
    expect(resolveDiscordMemoryScope('unknown')).toBeUndefined()
  })
})

/**
 * @example
 * describe('resolveDiscordReplyTarget', () => {})
 */
describe('resolveDiscordReplyTarget', () => {
  /**
   * @example
   * it('preserves direct-message user ids so replies can be sent through the user DM API', () => {})
   */
  it('preserves direct-message user ids so replies can be sent through the user DM API', () => {
    expect(resolveDiscordReplyTarget({
      channelId: 'dm-channel',
      guildMember: {
        id: 'discord-user-1',
        displayName: 'AIRI Friend',
        nickname: 'Friend',
      },
    })).toEqual({
      channelId: 'dm-channel',
      userId: 'discord-user-1',
      directMessage: true,
    })
  })

  /**
   * @example
   * it('keeps guild replies channel-scoped instead of treating them as DMs', () => {})
   */
  it('keeps guild replies channel-scoped instead of treating them as DMs', () => {
    expect(resolveDiscordReplyTarget({
      guildId: 'guild-1',
      channelId: 'channel-a',
      guildMember: {
        id: 'discord-user-1',
        displayName: 'AIRI Friend',
        nickname: 'Friend',
      },
    })).toEqual({
      channelId: 'channel-a',
      userId: 'discord-user-1',
      directMessage: false,
    })
  })
})

/**
 * @example
 * describe('resolveDiscordInputPolicy', () => {})
 */
describe('resolveDiscordInputPolicy', () => {
  /**
   * @example
   * it('accepts only exact allowlisted guild channels when a channel allowlist is configured', () => {})
   */
  it('accepts only exact allowlisted guild channels when a channel allowlist is configured', () => {
    expect(resolveDiscordInputPolicy({
      guildId: 'guild-1',
      channelId: ' channel-a ',
      guildMember: {
        id: 'user-1',
        displayName: 'User 1',
        nickname: 'User 1',
      },
    }, {
      allowedChannelIds: ['channel-a', 'channel-b'],
    })).toEqual({ accepted: true })

    expect(resolveDiscordInputPolicy({
      guildId: 'guild-1',
      channelId: 'channel-c',
      guildMember: {
        id: 'user-1',
        displayName: 'User 1',
        nickname: 'User 1',
      },
    }, {
      allowedChannelIds: ['channel-a', 'channel-b'],
    })).toEqual({
      accepted: false,
      reason: 'channel-not-allowed',
    })
  })

  /**
   * @example
   * it('allows mentioned guild channels when no channel allowlist is configured', () => {})
   */
  it('allows mentioned guild channels when no channel allowlist is configured', () => {
    expect(resolveDiscordInputPolicy({
      guildId: 'guild-1',
      channelId: 'channel-c',
      guildMember: {
        id: 'user-1',
        displayName: 'User 1',
        nickname: 'User 1',
      },
    })).toEqual({ accepted: true })
  })

  /**
   * @example
   * it('can reject direct messages through the runtime safety gate', () => {})
   */
  it('can reject direct messages through the runtime safety gate', () => {
    const discordDm = {
      channelId: 'dm-channel',
      guildMember: {
        id: 'user-1',
        displayName: 'User 1',
        nickname: 'User 1',
      },
    }

    expect(resolveDiscordInputPolicy(discordDm)).toEqual({ accepted: true })
    expect(resolveDiscordInputPolicy(discordDm, {
      allowDirectMessages: false,
    })).toEqual({
      accepted: false,
      reason: 'direct-message-disabled',
    })
  })
})

/**
 * @example
 * describe('hasRequiredDiscordAdminRole', () => {})
 */
describe('hasRequiredDiscordAdminRole', () => {
  /**
   * @example
   * it('allows admin-gated commands when the member has an exact configured role id', () => {})
   */
  it('allows admin-gated commands when the member has an exact configured role id', () => {
    expect(hasRequiredDiscordAdminRole({
      roles: [' role-a ', 'role-b'],
    }, ['role-a'])).toBe(true)

    expect(hasRequiredDiscordAdminRole({
      roles: ['role-c'],
    }, ['role-a'])).toBe(false)
  })

  /**
   * @example
   * it('preserves open command behavior when no admin roles are configured', () => {})
   */
  it('preserves open command behavior when no admin roles are configured', () => {
    expect(hasRequiredDiscordAdminRole(undefined, [])).toBe(true)
    expect(hasRequiredDiscordAdminRole(undefined, undefined)).toBe(true)
  })

  /**
   * @example
   * it('resolves Discord.js role manager cache ids', () => {})
   */
  it('resolves Discord.js role manager cache ids', () => {
    const member = {
      roles: {
        cache: new Map<string, unknown>([
          ['role-a', {}],
          ['role-b', {}],
        ]),
      },
    }

    expect(resolveDiscordMemberRoleIds(member)).toEqual(['role-a', 'role-b'])
    expect(hasRequiredDiscordAdminRole(member, ['role-b'])).toBe(true)
  })
})

/**
 * @example
 * describe('canUseRestrictedDiscordCommand', () => {})
 */
describe('canUseRestrictedDiscordCommand', () => {
  /**
   * @example
   * it('allows the configured owner even when Discord role metadata is unavailable', () => {})
   */
  it('allows the configured owner even when Discord role metadata is unavailable', () => {
    expect(canUseRestrictedDiscordCommand({
      userId: 'owner-user',
      ownerUserId: ' owner-user ',
      member: undefined,
      adminRoleIds: [],
    })).toBe(true)
  })

  /**
   * @example
   * it('allows members with a configured admin role', () => {})
   */
  it('allows members with a configured admin role', () => {
    expect(canUseRestrictedDiscordCommand({
      userId: 'user-1',
      ownerUserId: 'owner-user',
      member: {
        roles: [' role-admin ', 'role-other'],
      },
      adminRoleIds: ['role-admin'],
    })).toBe(true)
  })

  /**
   * @example
   * it('rejects ordinary users when restricted command roles are not configured', () => {})
   */
  it('rejects ordinary users when restricted command roles are not configured', () => {
    expect(canUseRestrictedDiscordCommand({
      userId: 'user-1',
      ownerUserId: 'owner-user',
      member: {
        roles: ['role-member'],
      },
      adminRoleIds: [],
    })).toBe(false)
  })

  /**
   * @example
   * it('rejects members without a configured admin role', () => {})
   */
  it('rejects members without a configured admin role', () => {
    expect(canUseRestrictedDiscordCommand({
      userId: 'user-1',
      ownerUserId: undefined,
      member: {
        roles: ['role-member'],
      },
      adminRoleIds: ['role-admin'],
    })).toBe(false)
  })
})

/**
 * @example
 * describe('resolveDiscordRateLimit', () => {})
 */
describe('resolveDiscordRateLimit', () => {
  /**
   * @example
   * it('accepts only the configured number of messages inside one session window', () => {})
   */
  it('accepts only the configured number of messages inside one session window', () => {
    const now = 1_000
    const first = resolveDiscordRateLimit(undefined, {
      rateLimitMaxMessages: 2,
      rateLimitWindowMs: 30_000,
    }, now)
    const second = resolveDiscordRateLimit(first.bucket, {
      rateLimitMaxMessages: 2,
      rateLimitWindowMs: 30_000,
    }, now + 1)
    const third = resolveDiscordRateLimit(second.bucket, {
      rateLimitMaxMessages: 2,
      rateLimitWindowMs: 30_000,
    }, now + 2)

    expect(first.decision).toEqual({ accepted: true })
    expect(second.decision).toEqual({ accepted: true })
    expect(third.decision.accepted).toBe(false)
    expect(third.decision.retryAfterMs).toBe(29_998)
  })

  /**
   * @example
   * it('resets the rate-limit bucket after the configured window', () => {})
   */
  it('resets the rate-limit bucket after the configured window', () => {
    const first = resolveDiscordRateLimit(undefined, {
      rateLimitMaxMessages: 1,
      rateLimitWindowMs: 30_000,
    }, 1_000)
    const second = resolveDiscordRateLimit(first.bucket, {
      rateLimitMaxMessages: 1,
      rateLimitWindowMs: 30_000,
    }, 31_001)

    expect(first.decision).toEqual({ accepted: true })
    expect(second.decision).toEqual({ accepted: true })
    expect(second.bucket.count).toBe(1)
  })
})
