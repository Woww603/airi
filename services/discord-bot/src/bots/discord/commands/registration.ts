import { PermissionFlagsBits, REST, Routes, SlashCommandBuilder } from 'discord.js'

const memoryScopeChoices = [
  { name: 'user', value: 'user' },
  { name: 'channel', value: 'channel' },
  { name: 'server', value: 'server' },
  { name: 'global', value: 'global' },
  { name: 'dm', value: 'dm' },
  { name: 'temporary', value: 'temporary' },
  { name: 'project', value: 'project' },
] as const

/** Discord-side default permission for commands that mutate AIRI or Discord bot state. */
const restrictedCommandPermission = PermissionFlagsBits.ManageGuild

function createPingCommand() {
  return new SlashCommandBuilder().setName('ping').setDescription('Replies with Pong!')
}

function createSummonCommand() {
  return new SlashCommandBuilder()
    .setName('summon')
    .setDescription('Summons the bot to your voice channel')
    .setDMPermission(false)
    .setDefaultMemberPermissions(restrictedCommandPermission)
}

function createDismissCommand() {
  return new SlashCommandBuilder()
    .setName('dismiss')
    .setDescription('Disconnects the bot from its current voice channel')
    .setDMPermission(false)
    .setDefaultMemberPermissions(restrictedCommandPermission)
}

/**
 * Builds the slash commands implemented by standalone mode.
 *
 * Use when:
 * - The bot runs without the AIRI desktop bridge and voice manager.
 *
 * Expects:
 * - Every returned command has a standalone interaction handler.
 *
 * Returns:
 * - The minimal standalone command contract.
 */
export function createStandaloneDiscordCommands() {
  return [createPingCommand(), createSummonCommand(), createDismissCommand()]
}

/**
 * Builds the global Discord slash-command contract.
 *
 * Use when:
 * - Registering commands after the Discord client becomes ready.
 * - Verifying command visibility and default permission boundaries.
 *
 * Expects:
 * - Runtime authorization still verifies owner/admin roles for restricted commands.
 *
 * Returns:
 * - Discord.js builders ready for REST registration.
 */
export function createDiscordCommands() {
  return [
    createPingCommand(),
    createSummonCommand(),
    createDismissCommand(),
    new SlashCommandBuilder()
      .setName('airi')
      .setDescription('Manage AIRI privacy and memory for the current Discord session')
      .setDefaultMemberPermissions(restrictedCommandPermission)
      .addSubcommand(subcommand =>
        subcommand
          .setName('privacy')
          .setDescription('Show memory/privacy status for this exact Discord session'))
      .addSubcommand(subcommand =>
        subcommand
          .setName('forget')
          .setDescription('Forget long-term memory for this exact Discord session'))
      .addSubcommandGroup(group =>
        group
          .setName('memory')
          .setDescription('Manage long-term memory consent for this exact Discord session')
          .addSubcommand(subcommand =>
            subcommand
              .setName('opt-in')
              .setDescription('Allow long-term memory for this exact Discord session'))
          .addSubcommand(subcommand =>
            subcommand
              .setName('opt-out')
              .setDescription('Disable and clear long-term memory for this exact Discord session'))),
    new SlashCommandBuilder()
      .setName('remember')
      .setDescription('Request a safe explicit long-term memory')
      .setDefaultMemberPermissions(restrictedCommandPermission)
      .addStringOption(option =>
        option
          .setName('content')
          .setDescription('The memory AIRI should consider storing')
          .setRequired(true)
          .setMaxLength(1200))
      .addStringOption(option =>
        option
          .setName('scope')
          .setDescription('Where this memory may be used')
          .setRequired(false)
          .addChoices(...memoryScopeChoices))
      .addStringOption(option =>
        option
          .setName('duration')
          .setDescription('Temporary duration like 30m, 6h, or 2d')
          .setRequired(false)),
    new SlashCommandBuilder()
      .setName('memory')
      .setDescription('List, clear, approve, or reject explicit AIRI memories')
      .setDefaultMemberPermissions(restrictedCommandPermission)
      .addSubcommand(subcommand =>
        subcommand
          .setName('list')
          .setDescription('List memories visible in this Discord scope'))
      .addSubcommand(subcommand =>
        subcommand
          .setName('clear')
          .setDescription('Clear memories visible in this Discord scope'))
      .addSubcommand(subcommand =>
        subcommand
          .setName('approve')
          .setDescription('Owner only: approve a pending memory')
          .addStringOption(option =>
            option
              .setName('id')
              .setDescription('Pending memory id')
              .setRequired(true)))
      .addSubcommand(subcommand =>
        subcommand
          .setName('reject')
          .setDescription('Owner only: reject a pending memory')
          .addStringOption(option =>
            option
              .setName('id')
              .setDescription('Pending memory id')
              .setRequired(true))),
    new SlashCommandBuilder()
      .setName('forget')
      .setDescription('Delete one explicit AIRI memory by id')
      .setDefaultMemberPermissions(restrictedCommandPermission)
      .addStringOption(option =>
        option
          .setName('id')
          .setDescription('Memory id from /memory list')
          .setRequired(true)),
  ]
}

async function registerCommandContract(token: string, clientId: string, body: ReturnType<typeof createDiscordCommands>) {
  const rest = new REST()

  rest.setToken(token)
  await rest.put(Routes.applicationCommands(clientId), { body })
}

export async function registerCommands(token: string, clientId: string) {
  await registerCommandContract(token, clientId, createDiscordCommands())
}

/** Registers only the commands that standalone mode can answer. */
export async function registerStandaloneDiscordCommands(token: string, clientId: string) {
  await registerCommandContract(token, clientId, createStandaloneDiscordCommands())
}
