import type { ChatInputCommandInteraction } from 'discord.js'

import { PermissionFlagsBits } from 'discord.js'

/** Discord role shapes returned by cached and raw interaction members. */
export type DiscordInteractionMemberRoleSource = {
  roles?: readonly string[] | {
    cache?: {
      keys: () => Iterable<string>
    }
  }
} | null

/** Runtime facts used to authorize Discord voice-management commands. */
export interface DiscordVoiceManagementAuthorization {
  /** Whether Discord resolved the interaction against a cached guild member. */
  inCachedGuild: boolean
  /** Whether the interaction member currently has Manage Server permission. */
  hasManageGuild: boolean
  /** Exact role ids currently assigned to the interaction member. */
  memberRoleIds: readonly string[]
  /** Additional configured role ids; empty means ManageGuild is sufficient. */
  requiredRoleIds: readonly string[]
}

function isDiscordRoleIdArray(
  roles: readonly string[] | { cache?: { keys: () => Iterable<string> } },
): roles is readonly string[] {
  return Array.isArray(roles)
}

/**
 * Normalizes exact Discord role ids from cached or raw interaction members.
 *
 * Before:
 * - `[" role-admin ", "role-admin"]`
 *
 * After:
 * - `["role-admin"]`
 */
export function resolveDiscordMemberRoleIds(member: DiscordInteractionMemberRoleSource | undefined): string[] {
  const roles = member?.roles
  if (!roles)
    return []

  const ids = isDiscordRoleIdArray(roles)
    ? roles
    : Array.from(roles.cache?.keys() ?? [])
  return Array.from(new Set(ids.map(roleId => roleId.trim()).filter(Boolean)))
}

/**
 * Authorizes one Discord voice-management command from trusted runtime facts.
 *
 * Use when:
 * - Bridge and standalone adapters receive `/summon` or `/dismiss`.
 * - Configured admin roles add a restriction on top of Manage Server.
 *
 * Expects:
 * - Permission and role facts came from the current Discord interaction.
 *
 * Returns:
 * - `true` only for cached-guild ManageGuild members matching a configured role when required.
 */
export function canManageDiscordVoice(input: DiscordVoiceManagementAuthorization): boolean {
  if (!input.inCachedGuild || !input.hasManageGuild)
    return false

  const requiredRoleIds = Array.from(new Set(input.requiredRoleIds.map(roleId => roleId.trim()).filter(Boolean)))
  if (!requiredRoleIds.length)
    return true

  const memberRoleIds = new Set(input.memberRoleIds.map(roleId => roleId.trim()).filter(Boolean))
  return requiredRoleIds.some(roleId => memberRoleIds.has(roleId))
}

/**
 * Projects a Discord interaction into the shared voice-management policy.
 *
 * Use when:
 * - An adapter needs to authorize `/summon` or `/dismiss` at execution time.
 *
 * Expects:
 * - `requiredRoleIds` came from trusted local runtime configuration.
 *
 * Returns:
 * - The shared ManageGuild-and-role authorization decision.
 */
export function canManageDiscordVoiceInteraction(
  interaction: ChatInputCommandInteraction,
  requiredRoleIds: readonly string[],
): boolean {
  return canManageDiscordVoice({
    inCachedGuild: interaction.inCachedGuild(),
    hasManageGuild: Boolean(interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)),
    memberRoleIds: resolveDiscordMemberRoleIds(interaction.member),
    requiredRoleIds,
  })
}
