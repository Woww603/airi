import type { ModuleCredential } from '@proj-airi/server-runtime'
import type { Server, ServerOptions } from '@proj-airi/server-runtime/server'
import type { Lifecycle } from 'injeca'

import type { ElectronServerChannelConfig } from '../../../../shared/eventa'
import type { SecureStorageHandle } from '../../electron/secure-storage'

import { randomUUID, X509Certificate } from 'node:crypto'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { isIP } from 'node:net'
import { join } from 'node:path'
import { env, platform } from 'node:process'

import { useLogg } from '@guiiai/logg'
import { defineInvokeHandler } from '@moeru/eventa'
import { createContext } from '@moeru/eventa/adapters/electron/main'
import { errorMessageFrom } from '@moeru/std'
import { createServer, getLocalIPs } from '@proj-airi/server-runtime/server'
import { createServerChannelQrPayload } from '@proj-airi/stage-shared/server-channel-qr'
import { Mutex } from 'async-mutex'
import { app, ipcMain, session } from 'electron'
import { createCA, createCert } from 'mkcert'
import { x } from 'tinyexec'
import { nullable, object, optional, string } from 'valibot'
import { z } from 'zod'

import {
  electronApplyServerChannelConfig,
  electronGetServerChannelConfig,
  electronGetServerChannelQrPayload,
} from '../../../../shared/eventa'
import { createConfig } from '../../../libs/electron/persistence'
import { ensureServerChannelConfigDefaults } from './config'

type DiscordModuleIdentity = ModuleCredential['module']['identity']

const channelServerConfigSchema = object({
  hostname: optional(string()),
  authToken: optional(string()),
  tlsConfig: optional(nullable(object({
    cert: optional(string()),
    key: optional(string()),
    passphrase: optional(string()),
  }))),
})

const channelServerInvokeConfigSchema = z.object({
  hostname: z.string().optional(),
  authToken: z.string().optional(),
  tlsConfig: z.object({ }).nullable().optional(),
}).strict()

const channelServerConfigStore = createConfig('server-channel', 'config.json', channelServerConfigSchema, {
  default: {
    hostname: '127.0.0.1',
    authToken: '',
    tlsConfig: null,
  },
  autoHeal: true,
})
let serverChannelServiceRegistered = false
let serverChannelCertificateTrustConfigured = false
let secureStorage: SecureStorageHandle | undefined

const SERVER_CHANNEL_AUTH_TOKEN_KEY = 'main/server-channel/auth-token'
const SERVER_CHANNEL_TLS_KEY_KEY = 'main/server-channel/tls-key'
const SERVER_CHANNEL_CA_KEY_KEY = 'main/server-channel/ca-key'

interface ServerChannelCertificateVerifyRequest {
  hostname: string
  verificationResult: string
  errorCode: number
  certificate: {
    subject: {
      commonName: string
    }
    issuer: {
      commonName: string
      country: string
      locality: string
      organizations: string[]
    }
  }
}

function getServerChannelPort() {
  return env.SERVER_CHANNEL_PORT ? Number.parseInt(env.SERVER_CHANNEL_PORT) : 6121
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1'])

function isLoopbackHost(host: string) {
  return LOOPBACK_HOSTS.has(host)
}

function getServerChannelQrHosts(config: ElectronServerChannelConfig, serverChannel: Server) {
  if (config.hostname === '0.0.0.0') {
    return Array.from(new Set(serverChannel.getConnectionHost()))
      .filter(host => !isLoopbackHost(host))
      .sort()
  }

  if (isLoopbackHost(config.hostname)) {
    return []
  }

  return [config.hostname]
}

function createServerChannelUrl(protocol: 'ws' | 'wss', host: string) {
  const urlHost = isIP(host) === 6 ? `[${host}]` : host
  // TODO: Deduplicate the server channel websocket path with `packages/server-runtime/src/index.ts`
  // and `packages/server-sdk/src/client.ts` so this does not rely on three separate `/ws` literals.
  return `${protocol}://${urlHost}:${getServerChannelPort()}/ws`
}

function getServerChannelQrPayload(config: ElectronServerChannelConfig, serverChannel: Server) {
  const protocol = config.tlsConfig ? 'wss' : 'ws'
  const urls = getServerChannelQrHosts(config, serverChannel)
    .map(host => createServerChannelUrl(protocol, host))

  if (!urls.length) {
    throw new Error('No reachable private LAN address is available for the current server channel host.')
  }

  return createServerChannelQrPayload({
    type: 'airi:server-channel',
    version: 1,
    urls,
    authToken: config.authToken,
  })
}

async function getChannelServerConfig(): Promise<ElectronServerChannelConfig> {
  const config = channelServerConfigStore.get() || { hostname: '127.0.0.1', authToken: '', tlsConfig: null }
  const secrets = getSecureStorage()
  let authToken = secrets.getItem(SERVER_CHANNEL_AUTH_TOKEN_KEY)

  if (authToken === null && config.authToken) {
    await secrets.setItem(SERVER_CHANNEL_AUTH_TOKEN_KEY, config.authToken)
    authToken = config.authToken
  }

  const persistedTlsConfig = config.tlsConfig ? {} : null
  if ('authToken' in config || (config.tlsConfig && Object.keys(config.tlsConfig).length > 0)) {
    channelServerConfigStore.update({
      hostname: config.hostname,
      tlsConfig: persistedTlsConfig,
    })
  }

  return {
    hostname: config.hostname || '127.0.0.1',
    authToken: authToken || '',
    tlsConfig: persistedTlsConfig,
  }
}

async function persistChannelServerConfig(config: ElectronServerChannelConfig): Promise<void> {
  const secrets = getSecureStorage()
  if (config.authToken)
    await secrets.setItem(SERVER_CHANNEL_AUTH_TOKEN_KEY, config.authToken)
  else
    await secrets.removeItem(SERVER_CHANNEL_AUTH_TOKEN_KEY)

  channelServerConfigStore.update({
    hostname: config.hostname,
    tlsConfig: config.tlsConfig ? {} : null,
  })
}

function getServerRuntimeBaseOptions() {
  return {
    port: getServerChannelPort(),
    hostname: '127.0.0.1',
  }
}

async function resolveServerRuntimeOptions(
  config: ServerOptions,
  moduleCredentials?: readonly ModuleCredential[],
): Promise<ServerOptions> {
  return {
    ...getServerRuntimeBaseOptions(),
    auth: {
      token: 'authToken' in config && typeof config.authToken === 'string' ? config.authToken : '',
      moduleCredentials,
    },
    hostname: 'hostname' in config && typeof config.hostname === 'string'
      ? config.hostname || '127.0.0.1'
      : '127.0.0.1',
    tlsConfig: config.tlsConfig ? await getOrCreateCertificate() : null,
  }
}

async function normalizeChannelServerOptions(payload: unknown, fallback?: ElectronServerChannelConfig) {
  if (!fallback) {
    fallback = await getChannelServerConfig()
  }

  const parsed = channelServerInvokeConfigSchema.safeParse(payload)
  if (!parsed.success) {
    return fallback
  }

  const normalizedConfig = {
    hostname: parsed.data.hostname ?? fallback.hostname,
    authToken: parsed.data.authToken ?? fallback.authToken,
    tlsConfig: typeof parsed.data.tlsConfig === 'undefined' ? null : parsed.data.tlsConfig,
  }

  return ensureServerChannelConfigDefaults(normalizedConfig, randomUUID).config
}

function getCertificateDomains(): string[] {
  const localIPs = getLocalIPs()
  const hostname = channelServerConfigStore.get()?.hostname || env.SERVER_RUNTIME_HOSTNAME
  return Array.from(new Set([
    'localhost',
    '127.0.0.1',
    '::1',
    ...(hostname ? [hostname] : []),
    ...localIPs,
  ]))
}

function getCertificatePaths() {
  const userDataPath = app.getPath('userData')

  return {
    certPath: join(userDataPath, 'websocket-cert.pem'),
    keyPath: join(userDataPath, 'websocket-key.pem'),
    caCertPath: join(userDataPath, 'websocket-ca-cert.pem'),
    caKeyPath: join(userDataPath, 'websocket-ca-key.pem'),
  }
}

function withCertificateChain(cert: string, caCert?: string) {
  return caCert ? `${cert.trim()}\n${caCert.trim()}\n` : cert
}

function certHasAllDomains(certPem: string, domains: string[]): boolean {
  try {
    const cert = new X509Certificate(certPem)
    const san = cert.subjectAltName || ''
    const entries = san.split(',').map(part => part.trim())
    const values = entries
      .map((entry) => {
        if (entry.startsWith('DNS:'))
          return entry.slice(4).trim()
        if (entry.startsWith('IP Address:'))
          return entry.slice(11).trim()
        return ''
      })
      .filter(Boolean)

    const sanSet = new Set(values)
    return domains.every(domain => sanSet.has(domain))
  }
  catch {
    return false
  }
}

function isTrustedServerChannelCertificate(request: ServerChannelCertificateVerifyRequest): boolean {
  if (!['CERT_AUTHORITY_INVALID', 'ERR_CERT_AUTHORITY_INVALID'].includes(request.verificationResult)
    && request.errorCode !== -202) {
    return false
  }

  if (!getCertificateDomains().includes(request.hostname)) {
    return false
  }

  const issuer = request.certificate.issuer
  return request.certificate.subject.commonName === 'localhost'
    && issuer.commonName === 'AIRI'
    && issuer.country === 'US'
    && issuer.locality === 'Local'
    && issuer.organizations.includes('AIRI')
}

function configureServerChannelCertificateTrust() {
  if (serverChannelCertificateTrustConfigured) {
    return
  }

  session.defaultSession.setCertificateVerifyProc((request, callback) => {
    if (isTrustedServerChannelCertificate(request)) {
      callback(0)
      return
    }

    callback(-3)
  })

  serverChannelCertificateTrustConfigured = true
}

async function installCACertificate(caCert: string) {
  const { caCertPath } = getCertificatePaths()
  const log = useLogg('main/server-runtime').useGlobalConfig()
  writeFileSync(caCertPath, caCert, { mode: 0o644 })

  try {
    if (platform === 'darwin') {
      await x('security', ['add-trusted-cert', '-d', '-r', 'trustRoot', '-k', join(app.getPath('home'), 'Library/Keychains/login.keychain-db'), caCertPath], { nodeOptions: { stdio: 'ignore' } })
    }
    else if (platform === 'win32') {
      await x('certutil', ['-addstore', '-f', 'Root', caCertPath], { nodeOptions: { stdio: 'ignore' } })
    }
    else if (platform === 'linux') {
      const caDir = '/usr/local/share/ca-certificates'
      const caFileName = 'airi-websocket-ca.crt'
      try {
        writeFileSync(join(caDir, caFileName), caCert, { mode: 0o644 })
        await x('update-ca-certificates', [], { nodeOptions: { stdio: 'ignore' } })
      }
      catch {
        const userCaDir = join(env.HOME || '', '.local/share/ca-certificates')
        try {
          if (!existsSync(userCaDir)) {
            await x('mkdir', ['-p', userCaDir], { nodeOptions: { stdio: 'ignore' } })
          }
          writeFileSync(join(userCaDir, caFileName), caCert, { mode: 0o644 })
        }
        catch {
          // Ignore errors
        }
      }
    }
  }
  catch (error) {
    log.withError(error).warn(`Failed to install AIRI WebSocket CA certificate from ${caCertPath}`)
  }
}

async function generateCertificate() {
  const { caCertPath, caKeyPath } = getCertificatePaths()

  let ca: { key: string, cert: string }
  const protectedCaKey = await getOrMigratePrivateKey(SERVER_CHANNEL_CA_KEY_KEY, caKeyPath)

  if (existsSync(caCertPath) && protectedCaKey) {
    ca = {
      cert: readFileSync(caCertPath, 'utf-8'),
      key: protectedCaKey,
    }
  }
  else {
    ca = await createCA({
      organization: 'AIRI',
      countryCode: 'US',
      state: 'Development',
      locality: 'Local',
      validity: 365,
    })
    await getSecureStorage().setItem(SERVER_CHANNEL_CA_KEY_KEY, ca.key)
    writeFileSync(caCertPath, ca.cert, { mode: 0o644 })
  }

  await installCACertificate(ca.cert)

  const domains = getCertificateDomains()

  const cert = await createCert({
    ca: { key: ca.key, cert: ca.cert },
    domains,
    validity: 365,
  })

  return {
    cert: cert.cert,
    key: cert.key,
  }
}

async function getOrCreateCertificate() {
  const { certPath, keyPath, caCertPath } = getCertificatePaths()
  const expectedDomains = getCertificateDomains()
  const protectedKey = await getOrMigratePrivateKey(SERVER_CHANNEL_TLS_KEY_KEY, keyPath)

  if (existsSync(certPath) && protectedKey) {
    const cert = readFileSync(certPath, 'utf-8')
    if (certHasAllDomains(cert, expectedDomains)) {
      const caCert = existsSync(caCertPath) ? readFileSync(caCertPath, 'utf-8') : undefined
      return { cert: withCertificateChain(cert, caCert), key: protectedKey }
    }
  }

  const { cert, key } = await generateCertificate()
  await getSecureStorage().setItem(SERVER_CHANNEL_TLS_KEY_KEY, key)
  writeFileSync(certPath, cert, { mode: 0o644 })

  const caCert = existsSync(caCertPath) ? readFileSync(caCertPath, 'utf-8') : undefined
  return { cert: withCertificateChain(cert, caCert), key }
}

/** Protected Discord module bootstrap retained only by Electron Main. */
export interface DiscordBridgeServerBootstrap {
  /** Loopback websocket endpoint for the managed utility process. */
  airiUrl: string
  /** Session-only module authentication credential. */
  moduleCredential: string
  /** Immutable module identity bound to the credential. */
  moduleIdentity: DiscordModuleIdentity
}

/** Server channel plus Main-only Discord bridge bootstrap access. */
export interface ServerChannel extends Server {
  /** Resolves the current loopback URL and session credential for Discord. */
  getDiscordBridgeBootstrap: () => Promise<DiscordBridgeServerBootstrap>
}

export async function setupServerChannel(params: { lifecycle: Lifecycle, secureStorage: SecureStorageHandle }): Promise<ServerChannel> {
  secureStorage = params.secureStorage
  channelServerConfigStore.setup()
  configureServerChannelCertificateTrust()

  const storedConfig = await getChannelServerConfig()
  const { changed: storedConfigChanged, config: normalizedStoredConfig } = ensureServerChannelConfigDefaults(storedConfig, randomUUID)
  if (storedConfigChanged) {
    await persistChannelServerConfig(normalizedStoredConfig)
  }

  const discordModuleIdentity: DiscordModuleIdentity = {
    id: 'discord-utility-process',
    kind: 'plugin',
    plugin: { id: 'discord' },
  }
  const discordModuleCredential = randomUUID()
  const moduleCredentials: readonly ModuleCredential[] = [{
    token: discordModuleCredential,
    module: {
      name: 'discord',
      identity: discordModuleIdentity,
    },
    capabilities: {
      emit: ['discord:memory:command', 'input:text'],
      exclusiveEmit: ['discord:memory:command'],
    },
  }]
  const serverChannel = createServer(await resolveServerRuntimeOptions(normalizedStoredConfig, moduleCredentials))

  const mutex = new Mutex()

  params.lifecycle.appHooks.onStart(async () => {
    const release = await mutex.acquire()

    const log = useLogg('main/server-runtime').useGlobalConfig()

    try {
      await serverChannel.start()
      log.log('WebSocket server started')
    }
    catch (error) {
      log.withError(error).error('Error starting WebSocket server')
    }
    finally {
      release()
    }
  })
  params.lifecycle.appHooks.onStop(async () => {
    const release = await mutex.acquire()

    const log = useLogg('main/server-runtime').useGlobalConfig()
    if (!serverChannel) {
      return
    }

    try {
      await serverChannel.stop()
      log.log('WebSocket server closed')
    }
    catch (error) {
      log.withError(error).error('Error closing WebSocket server')
    }
    finally {
      release()
    }
  })

  return {
    async getDiscordBridgeBootstrap() {
      const currentConfig = await getChannelServerConfig()
      return {
        airiUrl: createServerChannelUrl(currentConfig.tlsConfig ? 'wss' : 'ws', '127.0.0.1'),
        moduleCredential: discordModuleCredential,
        moduleIdentity: discordModuleIdentity,
      }
    },
    getConnectionHost() {
      return serverChannel.getConnectionHost()
    },
    async start() {
      const release = await mutex.acquire()
      try {
        await serverChannel.start()
      }
      finally {
        release()
      }
    },
    async restart() {
      const release = await mutex.acquire()
      try {
        await serverChannel.stop()
        await serverChannel.start()
      }
      finally {
        release()
      }
    },
    async stop() {
      const release = await mutex.acquire()
      try {
        await serverChannel.stop()
      }
      finally {
        release()
      }
    },
    async updateConfig(config) {
      const release = await mutex.acquire()
      try {
        await serverChannel.updateConfig({
          ...config,
          auth: {
            token: config.auth?.token ?? '',
            moduleCredentials,
          },
        })
      }
      finally {
        release()
      }
    },
  }
}

export async function createServerChannelService(params: { serverChannel: Server }) {
  if (serverChannelServiceRegistered) {
    return
  }
  serverChannelServiceRegistered = true

  const { context } = createContext(ipcMain)

  defineInvokeHandler(context, electronGetServerChannelConfig, async () => {
    return await getChannelServerConfig()
  })

  defineInvokeHandler(context, electronGetServerChannelQrPayload, async () => {
    const config = await getChannelServerConfig()
    return getServerChannelQrPayload(config, params.serverChannel)
  })

  defineInvokeHandler(context, electronApplyServerChannelConfig, async (req) => {
    const current = await getChannelServerConfig()
    const next = await normalizeChannelServerOptions(req, current)
    const tlsChanged = JSON.stringify(next.tlsConfig) !== JSON.stringify(current.tlsConfig)
    const hostnameChanged = next.hostname !== current.hostname
    const authTokenChanged = next.authToken !== current.authToken
    const runtimeChanged = tlsChanged || hostnameChanged || authTokenChanged

    try {
      if (runtimeChanged) {
        const nextRuntimeOptions = await resolveServerRuntimeOptions(next)

        await params.serverChannel.updateConfig(nextRuntimeOptions)
        await params.serverChannel.restart()
      }

      await persistChannelServerConfig(next)
      return next
    }
    catch (error) {
      useLogg('main/server-runtime').withError(error).error('Failed to apply server channel configuration')
      if (runtimeChanged) {
        const previousRuntimeOptions = await resolveServerRuntimeOptions(current)

        try {
          await params.serverChannel.updateConfig(previousRuntimeOptions)
          await params.serverChannel.restart()
        }
        catch (rollbackError) {
          useLogg('main/server-runtime').withError(rollbackError).error('Failed to restore previous server channel configuration')
        }
      }

      throw new Error(errorMessageFrom(error) ?? 'Failed to apply server channel configuration')
    }
  })
}

function getSecureStorage(): SecureStorageHandle {
  if (!secureStorage)
    throw new Error('Server channel protected storage is not initialized')
  return secureStorage
}

async function getOrMigratePrivateKey(protectedKey: string, legacyFilePath: string): Promise<string | null> {
  const secrets = getSecureStorage()
  const existing = secrets.getItem(protectedKey)
  if (existing) {
    if (existsSync(legacyFilePath))
      unlinkSync(legacyFilePath)
    return existing
  }
  if (!existsSync(legacyFilePath))
    return null

  const legacyKey = readFileSync(legacyFilePath, 'utf-8')
  await secrets.setItem(protectedKey, legacyKey)
  // Delete plaintext only after the protected write succeeds. A failed write
  // leaves the legacy key intact so TLS remains recoverable on the next launch.
  unlinkSync(legacyFilePath)
  return legacyKey
}
