import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

import type { StandaloneDashboardConfigPatch, StandaloneDiscordAppController, StandaloneSecretPatch } from './app-controller'
import type { StandaloneMemoryInput, StandaloneMemoryScope } from './memory-store'

import { Buffer } from 'node:buffer'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'

import { renderAiriSettingsDashboardHtml } from './dashboard-ui'

/**
 * Resolved dashboard server settings.
 */
export interface StandaloneDashboardServerSettings {
  /** Whether the local dashboard should start with standalone mode. @default true */
  enabled: boolean
  /** Local dashboard bind host. @default "127.0.0.1" */
  host: string
  /** Local dashboard bind port. @default 6122 */
  port: number
}

/**
 * Address returned after the dashboard server starts.
 */
export interface StandaloneDashboardAddress {
  /** Host used for the browser URL. */
  host: string
  /** Port used for the browser URL. */
  port: number
  /** Fully qualified local dashboard URL. */
  url: string
}

const DEFAULT_DASHBOARD_HOST = '127.0.0.1'
const DEFAULT_DASHBOARD_PORT = 6122
const MAX_JSON_BODY_BYTES = 64 * 1024
const DASHBOARD_TOKEN_HEADER = 'x-airi-dashboard-token'
const DASHBOARD_SESSION_COOKIE = 'airi_dashboard_session'

const RESPONSE_SECURITY_HEADERS = {
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
}

class DashboardHttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message)
    this.name = 'DashboardHttpError'
  }
}

function parseDashboardEnabled(value: string | undefined) {
  const normalized = value?.trim().toLowerCase()
  return normalized !== '0' && normalized !== 'false' && normalized !== 'off'
}

function parseDashboardPort(value: string | undefined) {
  const parsed = Number.parseInt(value ?? '', 10)
  if (!Number.isFinite(parsed))
    return DEFAULT_DASHBOARD_PORT

  return Math.min(65535, Math.max(0, Math.trunc(parsed)))
}

function parseDashboardHost(value: string | undefined): string {
  const normalized = value?.trim().toLowerCase()
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1'
    ? normalized
    : DEFAULT_DASHBOARD_HOST
}

function createJsonResponse(response: ServerResponse, statusCode: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  response.writeHead(statusCode, {
    ...RESPONSE_SECURITY_HEADERS,
    'Cache-Control': 'no-store',
    'Content-Length': String(Buffer.byteLength(body)),
    'Content-Type': 'application/json; charset=utf-8',
  })
  response.end(body)
}

function createHtmlResponse(response: ServerResponse, body: string, scriptNonce: string, sessionToken: string): void {
  response.writeHead(200, {
    ...RESPONSE_SECURITY_HEADERS,
    'Cache-Control': 'no-store',
    'Content-Security-Policy': `default-src 'none'; base-uri 'none'; connect-src 'self'; font-src 'self' data:; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; script-src 'nonce-${scriptNonce}'; style-src 'unsafe-inline'`,
    'Content-Length': String(Buffer.byteLength(body)),
    'Content-Type': 'text/html; charset=utf-8',
    // The dashboard is intentionally served over loopback HTTP, so Secure would
    // prevent the browser from returning this capability. HttpOnly keeps the
    // per-process capability outside HTML, DOM, and JavaScript reach.
    'Set-Cookie': `${DASHBOARD_SESSION_COOKIE}=${sessionToken}; HttpOnly; Path=/; SameSite=Strict`,
  })
  response.end(body)
}

function createTextResponse(response: ServerResponse, statusCode: number, body: string): void {
  response.writeHead(statusCode, {
    ...RESPONSE_SECURITY_HEADERS,
    'Cache-Control': 'no-store',
    'Content-Length': String(Buffer.byteLength(body)),
    'Content-Type': 'text/plain; charset=utf-8',
  })
  response.end(body)
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const mediaType = request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase()
  if (mediaType !== 'application/json')
    throw new DashboardHttpError(415, 'Content-Type must be application/json.')

  const declaredLength = Number.parseInt(request.headers['content-length'] ?? '', 10)
  if (Number.isFinite(declaredLength) && declaredLength > MAX_JSON_BODY_BYTES)
    throw new DashboardHttpError(413, 'Request body is too large.')

  const chunks: Buffer[] = []
  let bodyBytes = 0
  for await (const chunk of request) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    bodyBytes += buffer.byteLength
    if (bodyBytes > MAX_JSON_BODY_BYTES)
      throw new DashboardHttpError(413, 'Request body is too large.')
    chunks.push(buffer)
  }

  const body = Buffer.concat(chunks, bodyBytes).toString('utf8')

  if (!body.trim())
    return {}

  let parsed: unknown
  try {
    parsed = JSON.parse(body) as unknown
  }
  catch {
    throw new DashboardHttpError(400, 'Request body must be valid JSON.')
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    throw new DashboardHttpError(400, 'Request body must be a JSON object.')

  return parsed as Record<string, unknown>
}

function optionalString(input: Record<string, unknown>, key: string) {
  const value = input[key]
  return typeof value === 'string' ? value : undefined
}

function optionalBooleanString(input: Record<string, unknown>, key: string) {
  const value = input[key]
  if (typeof value === 'boolean')
    return value ? 'true' : 'false'

  return typeof value === 'string' ? value : undefined
}

function optionalSecretPatch(input: Record<string, unknown>, key: string): StandaloneSecretPatch | undefined {
  if (!(key in input))
    return undefined

  const value = input[key]
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new DashboardHttpError(400, 'Secret updates must use an explicit action.')

  const secretPatch = value as Record<string, unknown>
  const action = secretPatch.action
  const keys = Object.keys(secretPatch)
  if (action === 'unchanged' || action === 'clear') {
    if (keys.length !== 1)
      throw new DashboardHttpError(400, 'Secret updates contain unsupported fields.')
    return { action }
  }

  if (action === 'set') {
    if (keys.length !== 2 || !keys.includes('value'))
      throw new DashboardHttpError(400, 'Secret updates contain unsupported fields.')
    const secretValue = secretPatch.value
    if (typeof secretValue !== 'string' || !secretValue.trim())
      throw new DashboardHttpError(400, 'Secret set actions require a non-empty value.')
    return { action, value: secretValue }
  }

  throw new DashboardHttpError(400, 'Secret updates must use unchanged, clear, or set.')
}

function optionalMemoryScope(input: Record<string, unknown>, key: string): StandaloneMemoryScope | undefined {
  const value = input[key]
  if (
    value === 'global'
    || value === 'server'
    || value === 'channel'
    || value === 'user'
    || value === 'dm'
    || value === 'session'
  ) {
    return value
  }

  return undefined
}

function toConfigPatch(input: Record<string, unknown>): StandaloneDashboardConfigPatch {
  return {
    allowedChannelIdsText: optionalString(input, 'allowedChannelIdsText'),
    adminRoleIdsText: optionalString(input, 'adminRoleIdsText'),
    allowDirectMessages: optionalBooleanString(input, 'allowDirectMessages'),
    auditLogEnabled: optionalBooleanString(input, 'auditLogEnabled'),
    blockedGuildIdsText: optionalString(input, 'blockedGuildIdsText'),
    blockedTermsText: optionalString(input, 'blockedTermsText'),
    blockedUserIdsText: optionalString(input, 'blockedUserIdsText'),
    characterCardJson: optionalString(input, 'characterCardJson'),
    characterCreator: optionalString(input, 'characterCreator'),
    characterDescription: optionalString(input, 'characterDescription'),
    characterGreetingsText: optionalString(input, 'characterGreetingsText'),
    characterName: optionalString(input, 'characterName'),
    characterNickname: optionalString(input, 'characterNickname'),
    characterNotes: optionalString(input, 'characterNotes'),
    characterPersonality: optionalString(input, 'characterPersonality'),
    characterPostHistoryInstructions: optionalString(input, 'characterPostHistoryInstructions'),
    characterScenario: optionalString(input, 'characterScenario'),
    characterSystemPrompt: optionalString(input, 'characterSystemPrompt'),
    characterVersion: optionalString(input, 'characterVersion'),
    channelRulesText: optionalString(input, 'channelRulesText'),
    dashboardRgbOn: optionalBooleanString(input, 'dashboardRgbOn'),
    deepSeekApiBaseUrl: optionalString(input, 'deepSeekApiBaseUrl'),
    deepSeekApiKey: optionalSecretPatch(input, 'deepSeekApiKey'),
    deepSeekModel: optionalString(input, 'deepSeekModel'),
    discordToken: optionalSecretPatch(input, 'discordToken'),
    historyLimit: optionalString(input, 'historyLimit'),
    memoryAutoCaptureEnabled: optionalBooleanString(input, 'memoryAutoCaptureEnabled'),
    memoryConsentRequired: optionalBooleanString(input, 'memoryConsentRequired'),
    memoryEnabled: optionalBooleanString(input, 'memoryEnabled'),
    messagePacingMs: optionalString(input, 'messagePacingMs'),
    modelRequestTimeoutMs: optionalString(input, 'modelRequestTimeoutMs'),
    privacyNoticeEnabled: optionalBooleanString(input, 'privacyNoticeEnabled'),
    privacyNoticeText: optionalString(input, 'privacyNoticeText'),
    qwenRealtimeApiKey: optionalSecretPatch(input, 'qwenRealtimeApiKey'),
    qwenRealtimeInterruptionSensitivity: optionalString(input, 'qwenRealtimeInterruptionSensitivity'),
    qwenRealtimeModel: optionalString(input, 'qwenRealtimeModel'),
    qwenRealtimeRegion: optionalString(input, 'qwenRealtimeRegion'),
    qwenRealtimeSilenceDurationMs: optionalString(input, 'qwenRealtimeSilenceDurationMs'),
    qwenRealtimeVoice: optionalString(input, 'qwenRealtimeVoice'),
    qwenRealtimeWorkspaceId: optionalSecretPatch(input, 'qwenRealtimeWorkspaceId'),
    rateLimitMaxMessages: optionalString(input, 'rateLimitMaxMessages'),
    rateLimitWindowMs: optionalString(input, 'rateLimitWindowMs'),
    selectedChannelId: optionalString(input, 'selectedChannelId'),
    selectedGuildId: optionalString(input, 'selectedGuildId'),
    sttApiBaseUrl: optionalString(input, 'sttApiBaseUrl'),
    sttApiKey: optionalSecretPatch(input, 'sttApiKey'),
    sttModel: optionalString(input, 'sttModel'),
    systemPrompt: optionalString(input, 'systemPrompt'),
    ttsApiBaseUrl: optionalString(input, 'ttsApiBaseUrl'),
    ttsApiKey: optionalSecretPatch(input, 'ttsApiKey'),
    ttsModel: optionalString(input, 'ttsModel'),
    ttsVoice: optionalString(input, 'ttsVoice'),
    voiceCallMode: optionalString(input, 'voiceCallMode'),
    guildRulesText: optionalString(input, 'guildRulesText'),
  }
}
function toMemoryInput(input: Record<string, unknown>): StandaloneMemoryInput {
  return {
    channelId: optionalString(input, 'channelId'),
    content: optionalString(input, 'content'),
    displayName: optionalString(input, 'displayName'),
    guildId: optionalString(input, 'guildId'),
    scope: optionalMemoryScope(input, 'scope'),
    userId: optionalString(input, 'userId'),
  }
}

function isAddressInUse(error: unknown) {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === 'EADDRINUSE'
}

/**
 * Resolves dashboard settings from environment values.
 *
 * Use when:
 * - Standalone mode should expose a local status/config page.
 * - Tests need deterministic dashboard config parsing.
 *
 * Expects:
 * - `AIRI_DISCORD_DASHBOARD_PORT` is either empty or a TCP port number.
 *
 * Returns:
 * - Dashboard server settings with local-only defaults.
 */
export function resolveStandaloneDashboardServerSettings(env: NodeJS.ProcessEnv): StandaloneDashboardServerSettings {
  return {
    enabled: parseDashboardEnabled(env.AIRI_DISCORD_DASHBOARD_ENABLED),
    host: parseDashboardHost(env.AIRI_DISCORD_DASHBOARD_HOST),
    port: parseDashboardPort(env.AIRI_DISCORD_DASHBOARD_PORT),
  }
}

/**
 * Local HTTP dashboard for the standalone Discord app.
 *
 * Use when:
 * - The user wants an AIRI-style dashboard without starting AIRI desktop.
 * - Bot status, config health, and recent events should be visible in a browser.
 *
 * Expects:
 * - The server is bound to a trusted local host by default.
 * - Secrets are only accepted through POST requests and never rendered back.
 *
 * Returns:
 * - A start/stop lifecycle around the local HTTP server.
 */
export class StandaloneDashboardServer {
  private readonly apiToken: string
  private readonly controller: StandaloneDiscordAppController
  private readonly settings: StandaloneDashboardServerSettings
  private dashboardOrigin: string | undefined
  private server: Server | undefined

  constructor(config: {
    apiToken?: string
    controller: StandaloneDiscordAppController
    settings: StandaloneDashboardServerSettings
  }) {
    this.apiToken = config.apiToken?.trim() || randomBytes(32).toString('base64url')
    this.controller = config.controller
    this.settings = config.settings
  }

  private createServer(): Server {
    const server = createServer((request, response) => {
      void this.handleRequest(request, response)
    })
    // The dashboard is local-only, but explicit limits keep malformed or stalled
    // loopback clients from holding sockets and process resources indefinitely.
    server.headersTimeout = 10_000
    server.requestTimeout = 15_000
    server.keepAliveTimeout = 5_000
    server.maxHeadersCount = 50
    return server
  }

  private async listen(server: Server, port: number): Promise<AddressInfo> {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, this.settings.host, () => {
        server.off('error', reject)
        resolve()
      })
    })

    const address = server.address()
    if (typeof address !== 'object' || address === null)
      throw new Error('Dashboard server did not return a TCP address.')

    return address
  }

  private async handleApiRequest(pathname: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!this.hasValidApiCredential(request)) {
      createJsonResponse(response, 403, { error: 'Forbidden' })
      return
    }

    if (request.headers.origin && request.headers.origin !== this.dashboardOrigin) {
      createJsonResponse(response, 403, { error: 'Forbidden' })
      return
    }

    if (request.method === 'GET' && pathname === '/api/status') {
      createJsonResponse(response, 200, {
        config: await this.controller.getPublicConfig(),
        state: this.controller.getSnapshot(),
      })
      return
    }

    if (request.method === 'GET' && pathname === '/api/config') {
      createJsonResponse(response, 200, await this.controller.getPublicConfig())
      return
    }

    if (request.method === 'POST' && pathname === '/api/config') {
      const result = await this.controller.saveConfig(toConfigPatch(await readJsonBody(request)))
      createJsonResponse(response, result.ok ? 200 : 400, result)
      return
    }

    if (request.method === 'GET' && pathname === '/api/memory') {
      createJsonResponse(response, 200, await this.controller.getMemorySnapshot())
      return
    }

    if (request.method === 'POST' && pathname === '/api/memory') {
      const result = await this.controller.addMemory(toMemoryInput(await readJsonBody(request)))
      createJsonResponse(response, result.ok ? 200 : 400, result)
      return
    }

    if (request.method === 'POST' && pathname === '/api/memory/delete') {
      const body = await readJsonBody(request)
      const result = await this.controller.deleteMemory(optionalString(body, 'id') ?? '')
      createJsonResponse(response, result.ok ? 200 : 404, result)
      return
    }

    if (request.method === 'POST' && pathname === '/api/memory/clear') {
      const result = await this.controller.clearMemory()
      createJsonResponse(response, result.ok ? 200 : 400, result)
      return
    }

    if (request.method === 'POST' && pathname === '/api/bot/start') {
      const result = await this.controller.startBot()
      createJsonResponse(response, result.ok ? 200 : 400, result)
      return
    }

    if (request.method === 'POST' && pathname === '/api/bot/stop') {
      const result = await this.controller.stopBot()
      createJsonResponse(response, result.ok ? 200 : 400, result)
      return
    }

    if (request.method === 'POST' && pathname === '/api/bot/restart') {
      const result = await this.controller.restartBot()
      createJsonResponse(response, result.ok ? 200 : 400, result)
      return
    }

    if (request.method === 'POST' && pathname === '/api/diagnostics/start') {
      await readJsonBody(request)
      const result = await this.controller.startCapabilityDiagnostics()
      createJsonResponse(response, result ? 200 : 409, result ?? { error: 'Diagnostic run already active.' })
      return
    }

    if (request.method === 'POST' && pathname === '/api/diagnostics/confirm') {
      const action = optionalString(await readJsonBody(request), 'action')
      if (action !== 'text-reply-correct' && action !== 'voice-consent-join' && action !== 'voice-heard') {
        createJsonResponse(response, 400, { error: 'Unsupported diagnostic confirmation.' })
        return
      }
      const confirmed = this.controller.confirmCapabilityDiagnostics(action)
      createJsonResponse(response, confirmed ? 200 : 409, { confirmed })
      return
    }

    if (request.method === 'POST' && pathname === '/api/diagnostics/cancel') {
      await readJsonBody(request)
      this.controller.cancelCapabilityDiagnostics()
      createJsonResponse(response, 200, { cancelled: true })
      return
    }

    createJsonResponse(response, 404, { error: 'Not found' })
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const url = new URL(request.url ?? '/', `http://${this.settings.host}`)
      if (!this.hasExpectedHost(request)) {
        createTextResponse(response, 403, 'Forbidden')
        return
      }

      if (request.method === 'GET' && url.pathname === '/healthz') {
        response.writeHead(204, {
          'Cache-Control': 'no-store',
        })
        response.end()
        return
      }

      if (url.pathname.startsWith('/api/')) {
        await this.handleApiRequest(url.pathname, request, response)
        return
      }

      if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/dashboard')) {
        const scriptNonce = randomBytes(18).toString('base64url')
        createHtmlResponse(response, renderAiriSettingsDashboardHtml(scriptNonce), scriptNonce, this.apiToken)
        return
      }

      createTextResponse(response, 404, 'Not found')
    }
    catch (error) {
      if (error instanceof DashboardHttpError) {
        createJsonResponse(response, error.statusCode, { error: error.message })
        return
      }

      console.error('[discord-bot:standalone] dashboard request failed', {
        failureCategory: 'dashboard-request-failure',
      })
      createJsonResponse(response, 500, { error: 'Dashboard request failed.' })
    }
  }

  async start(): Promise<StandaloneDashboardAddress> {
    if (this.server)
      throw new Error('独立 dashboard 服务已在运行。')

    this.server = this.createServer()

    let address: AddressInfo
    try {
      address = await this.listen(this.server, this.settings.port)
    }
    catch (error) {
      if (!isAddressInUse(error) || this.settings.port === 0)
        throw error

      this.server = this.createServer()
      address = await this.listen(this.server, 0)
    }

    const host = address.address === '::' ? 'localhost' : this.settings.host
    const urlHost = host.includes(':') ? `[${host}]` : host
    this.dashboardOrigin = `http://${urlHost}:${address.port}`
    return {
      host,
      port: address.port,
      url: this.dashboardOrigin,
    }
  }

  async stop(): Promise<void> {
    const server = this.server
    if (!server)
      return

    this.server = undefined
    this.dashboardOrigin = undefined
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error)
          reject(error)
        else
          resolve()
      })
    })
  }

  private hasExpectedHost(request: IncomingMessage): boolean {
    if (!this.dashboardOrigin || !request.headers.host)
      return false

    try {
      return new URL(`http://${request.headers.host}`).host === new URL(this.dashboardOrigin).host
    }
    catch {
      return false
    }
  }

  private matchesApiToken(providedToken: string | undefined): boolean {
    if (!providedToken)
      return false
    const expected = Buffer.from(this.apiToken)
    const provided = Buffer.from(providedToken)
    return expected.length === provided.length && timingSafeEqual(expected, provided)
  }

  private hasValidApiCredential(request: IncomingMessage): boolean {
    const bearer = request.headers[DASHBOARD_TOKEN_HEADER]
    if (typeof bearer === 'string' && this.matchesApiToken(bearer))
      return true

    const cookieHeader = request.headers.cookie
    if (!cookieHeader)
      return false

    const sessionCookie = cookieHeader.split(';').map(value => value.trim()).find(value => value.startsWith(`${DASHBOARD_SESSION_COOKIE}=`))
    return this.matchesApiToken(sessionCookie?.slice(DASHBOARD_SESSION_COOKIE.length + 1))
  }
}
