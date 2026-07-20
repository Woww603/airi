import { array, boolean, check, finite, integer, literal, maxLength, maxValue, minLength, minValue, number, optional, pipe, strictObject, string, trim, union } from 'valibot'

/** Explicit update for the Discord bot token owned by Electron Main. */
export type DiscordBridgeTokenUpdate
  = | { action: 'unchanged' }
    | { action: 'clear' }
    | { action: 'set', value: string }

/** Non-secret runtime policy applied to the managed Discord bridge. */
export interface DiscordBridgeRuntimePolicy {
  /** Whether Electron Main may run and connect the managed Discord bot. */
  enabled: boolean
  /** Exact Discord channel ids accepted for guild text and voice ingress. */
  allowedChannelIds: string[]
  /** Exact role ids that additionally restrict privileged commands. */
  adminRoleIds: string[]
  /** Whether Discord direct messages may enter AIRI. */
  allowDirectMessages: boolean
  /** Whether long-term memory needs exact-session consent. */
  memoryConsentRequired: boolean
  /** Whether a privacy disclosure must precede the first handled session turn. */
  privacyNoticeEnabled: boolean
  /** Public privacy disclosure sent to Discord participants. */
  privacyNoticeText: string
  /** Whether local structured Discord policy audit events are recorded. */
  auditLogEnabled: boolean
  /** Artificial text-ingress pacing delay in milliseconds. */
  messagePacingMs: number
  /** Accepted messages per exact-session rate-limit window. */
  rateLimitMaxMessages: number
  /** Exact-session rate-limit window duration in milliseconds. */
  rateLimitWindowMs: number
}

/** Protected renderer-to-Main Discord bridge configuration request. */
export interface DiscordBridgeConfiguration extends DiscordBridgeRuntimePolicy {
  /** Three-state secret mutation; empty strings never encode two meanings. */
  token: DiscordBridgeTokenUpdate
}

/** Public state returned after Electron Main applies Discord configuration. */
export interface DiscordBridgeStatus {
  /** Whether Main protected storage currently contains a Discord Bot token. */
  configured: boolean
  /** Whether policy currently permits the managed utility process to run. */
  enabled: boolean
  /** Whether the utility process was started for the current policy. */
  running: boolean
}

/** Immutable Discord module identity transferred from Electron Main. */
export interface DiscordBridgeModuleIdentity {
  /** Stable process identity reserved by the local server runtime. */
  id: string
  /** Server-channel identity kind. */
  kind: 'plugin'
  /** Exact protected plugin principal. */
  plugin: {
    /** Reserved Discord module name. */
    id: string
  }
}

/** Protected OpenAI-compatible speech-to-text configuration for bridge voice. */
export interface DiscordBridgeTranscriptionConfig {
  /** Provider API key sent only through the one-time Main-to-worker port. */
  apiKey: string
  /** Optional HTTP(S) provider endpoint configured by the trusted local operator. */
  baseURL?: string
  /** Optional provider transcription model identifier. */
  model?: string
}

/** One-time protected bootstrap sent from Electron Main to its utility process. */
export interface DiscordBridgeBootstrap {
  /** Loopback AIRI websocket endpoint owned by Electron Main. */
  airiUrl: string
  /** Discord Bot token read only from Main's protected storage. */
  discordToken: string
  /** Session-only server credential bound to the Discord module identity. */
  moduleCredential: string
  /** Immutable Discord module identity authenticated by the server. */
  moduleIdentity: DiscordBridgeModuleIdentity
  /** Optional protected classic STT settings; absent keeps voice transcription fail closed. */
  transcription?: DiscordBridgeTranscriptionConfig
}

const discordIdSchema = pipe(string(), trim(), minLength(1), maxLength(64))
const finiteIntegerSchema = pipe(number(), finite(), integer())
const discordBridgeRuntimePolicyEntries = {
  enabled: boolean(),
  allowedChannelIds: pipe(array(discordIdSchema), maxLength(500)),
  adminRoleIds: pipe(array(discordIdSchema), maxLength(500)),
  allowDirectMessages: boolean(),
  memoryConsentRequired: boolean(),
  privacyNoticeEnabled: boolean(),
  privacyNoticeText: pipe(string(), maxLength(2000)),
  auditLogEnabled: boolean(),
  messagePacingMs: pipe(finiteIntegerSchema, minValue(0), maxValue(10_000)),
  rateLimitMaxMessages: pipe(finiteIntegerSchema, minValue(0), maxValue(100)),
  rateLimitWindowMs: pipe(finiteIntegerSchema, minValue(1000), maxValue(5 * 60 * 1000)),
}

/** Strict runtime-policy schema shared by Main and the utility process. */
export const DiscordBridgeRuntimePolicySchema = strictObject(discordBridgeRuntimePolicyEntries)

/** Strict protected renderer-to-Main configuration schema. */
export const DiscordBridgeConfigurationSchema = strictObject({
  ...discordBridgeRuntimePolicyEntries,
  token: union([
    strictObject({ action: literal('unchanged') }),
    strictObject({ action: literal('clear') }),
    strictObject({
      action: literal('set'),
      value: pipe(string(), trim(), minLength(1), maxLength(512)),
    }),
  ]),
})

function isProtectedServerUrl(value: string) {
  try {
    const url = new URL(value)
    return (url.protocol === 'ws:' || url.protocol === 'wss:')
      && url.hostname === '127.0.0.1'
      && url.pathname === '/ws'
      && !url.username
      && !url.password
      && !url.search
      && !url.hash
      && Boolean(url.port)
  }
  catch {
    return false
  }
}

function isSpeechProviderUrl(value: string) {
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:')
      && !url.username
      && !url.password
      && !url.hash
  }
  catch {
    return false
  }
}

/** Strict one-time Main-to-utility bootstrap schema. */
export const DiscordBridgeBootstrapSchema = strictObject({
  type: literal('discord-bridge:bootstrap'),
  airiUrl: pipe(string(), trim(), minLength(1), maxLength(2048), check(isProtectedServerUrl)),
  discordToken: pipe(string(), minLength(1), maxLength(512)),
  moduleCredential: pipe(string(), minLength(1), maxLength(512)),
  moduleIdentity: strictObject({
    id: literal('discord-utility-process'),
    kind: literal('plugin'),
    plugin: strictObject({ id: literal('discord') }),
  }),
  transcription: optional(strictObject({
    apiKey: pipe(string(), minLength(1), maxLength(4096)),
    baseURL: optional(pipe(string(), trim(), minLength(1), maxLength(2048), check(isSpeechProviderUrl))),
    model: optional(pipe(string(), trim(), minLength(1), maxLength(256))),
  })),
})
