import { describe, expect, it } from 'vitest'

import { canManageDiscordVoice } from './authorization'

/**
 * @example
 * describe('discord voice management authorization', () => {})
 */
describe('discord voice management authorization', () => {
  /**
   * @example
   * it('discord audit D-010 requires cached-guild ManageGuild authorization', () => {})
   */
  it('discord audit D-010 requires cached-guild ManageGuild authorization', () => {
    // ROOT CAUSE:
    //
    // Discord command registration defaults are only a visibility hint. The
    // bridge runtime currently treats an empty role list as authorization,
    // while standalone checks ManageGuild but ignores configured role ids.
    // Both modes need the same runtime decision for every interaction.
    expect(canManageDiscordVoice({
      inCachedGuild: false,
      hasManageGuild: true,
      memberRoleIds: [],
      requiredRoleIds: [],
    })).toBe(false)
    expect(canManageDiscordVoice({
      inCachedGuild: true,
      hasManageGuild: false,
      memberRoleIds: [],
      requiredRoleIds: [],
    })).toBe(false)
    expect(canManageDiscordVoice({
      inCachedGuild: true,
      hasManageGuild: true,
      memberRoleIds: [],
      requiredRoleIds: [],
    })).toBe(true)
  })

  /**
   * @example
   * it('discord audit D-010 requires an exact configured role in addition to ManageGuild', () => {})
   */
  it('discord audit D-010 requires an exact configured role in addition to ManageGuild', () => {
    expect(canManageDiscordVoice({
      inCachedGuild: true,
      hasManageGuild: true,
      memberRoleIds: ['role-member'],
      requiredRoleIds: ['role-admin'],
    })).toBe(false)
    expect(canManageDiscordVoice({
      inCachedGuild: true,
      hasManageGuild: true,
      memberRoleIds: ['role-member', 'role-admin'],
      requiredRoleIds: ['role-admin'],
    })).toBe(true)
  })

  /**
   * @example
   * it('discord audit D-010 does not let a configured role replace ManageGuild', () => {})
   */
  it('discord audit D-010 does not let a configured role replace ManageGuild', () => {
    expect(canManageDiscordVoice({
      inCachedGuild: true,
      hasManageGuild: false,
      memberRoleIds: ['role-admin'],
      requiredRoleIds: ['role-admin'],
    })).toBe(false)
  })
})
