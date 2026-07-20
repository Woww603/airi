import { PermissionFlagsBits } from 'discord.js'
import { describe, expect, it } from 'vitest'

import { createDiscordCommands, createStandaloneDiscordCommands } from './index'

/**
 * @example
 * describe('Discord slash command contract', () => {})
 */
describe('discord slash command contract', () => {
  /**
   * @example
   * it('keeps stateful commands restricted and voice summon unavailable in DMs', () => {})
   */
  it('keeps stateful commands restricted and voice summon unavailable in DMs', () => {
    const commands = createDiscordCommands().map(command => command.toJSON())
    const commandByName = new Map(commands.map(command => [command.name, command]))
    const restrictedPermission = PermissionFlagsBits.ManageGuild.toString()

    expect(commands.map(command => command.name)).toEqual(['ping', 'summon', 'dismiss', 'airi', 'remember', 'memory', 'forget'])
    expect(commandByName.get('ping')?.default_member_permissions).toBeUndefined()
    expect(commandByName.get('summon')?.default_member_permissions).toBe(restrictedPermission)
    expect(commandByName.get('summon')?.dm_permission).toBe(false)
    expect(commandByName.get('dismiss')?.default_member_permissions).toBe(restrictedPermission)
    expect(commandByName.get('dismiss')?.dm_permission).toBe(false)
    expect(commandByName.get('airi')?.default_member_permissions).toBe(restrictedPermission)
    expect(commandByName.get('remember')?.default_member_permissions).toBe(restrictedPermission)
    expect(commandByName.get('memory')?.default_member_permissions).toBe(restrictedPermission)
    expect(commandByName.get('forget')?.default_member_permissions).toBe(restrictedPermission)
  })

  /**
   * @example
   * it('publishes only commands implemented by standalone mode', () => {})
   */
  it('publishes only commands implemented by standalone mode', () => {
    const commands = createStandaloneDiscordCommands().map(command => command.toJSON())
    const commandByName = new Map(commands.map(command => [command.name, command]))
    const restrictedPermission = PermissionFlagsBits.ManageGuild.toString()

    expect(commands.map(command => command.name)).toEqual(['ping', 'summon', 'dismiss'])
    expect(commandByName.get('summon')?.default_member_permissions).toBe(restrictedPermission)
    expect(commandByName.get('summon')?.dm_permission).toBe(false)
    expect(commandByName.get('dismiss')?.default_member_permissions).toBe(restrictedPermission)
    expect(commandByName.get('dismiss')?.dm_permission).toBe(false)
  })
})
