import type {
  DiscordBridgeBootstrap,
  DiscordBridgeConfiguration,
  DiscordBridgeRuntimePolicy,
  DiscordBridgeStatus,
} from '@proj-airi/stage-shared/discord-bridge'
import type { ForkOptions, IpcMainEvent, MessagePortMain } from 'electron'
import type { Lifecycle } from 'injeca'

import type { SecureStorageHandle } from '../../electron/secure-storage'
import type { ServerChannel } from '../channel-server'

import process from 'node:process'

import { defineInvokeHandler } from '@moeru/eventa'
import { createContext } from '@moeru/eventa/adapters/electron/main'
import { DiscordBridgeConfigurationSchema } from '@proj-airi/stage-shared/discord-bridge'
import { ipcMain, MessageChannelMain, utilityProcess } from 'electron'
import { safeParse } from 'valibot'

import { electronConfigureDiscordBridge } from '../../../../shared/eventa'

interface DiscordBridgeUtilityProcess {
  kill: () => boolean
  once: (event: 'spawn' | 'exit', listener: (() => void) | ((code: number) => void)) => unknown
  postMessage: (message: unknown, transfer?: DiscordBridgeMessagePort[]) => void
}

interface DiscordBridgeMessagePort {
  close: () => void
  postMessage?: (message: unknown) => void
}

interface DiscordBridgeMessageChannel {
  port1: DiscordBridgeMessagePort
  port2: DiscordBridgeMessagePort & { postMessage: (message: unknown) => void }
}

/** Inputs for the Electron-owned Discord utility-process lifecycle. */
export interface DiscordBridgeManagerOptions {
  /** Secret bootstrap copied into the one-time MessagePort payload only. */
  bootstrap: DiscordBridgeBootstrap
  /** Creates the one-time port pair used for secret handoff. */
  createMessageChannel?: () => DiscordBridgeMessageChannel
  /** Built utility-process entrypoint. */
  entryPath: string
  /** Starts Electron's sandboxed Node utility process. */
  fork?: (modulePath: string, args: string[], options: ForkOptions) => DiscordBridgeUtilityProcess
  /** Bounded lifecycle logger. Secrets must never be passed to this callback. */
  log?: (message: string) => void
  /** Observes child exit without receiving process metadata or credentials. */
  onExit?: () => void
  /** Parent environment copied after credential-bearing keys are removed. */
  runtimeEnvironment?: NodeJS.ProcessEnv
}

/** Lifecycle controller for the Electron-owned Discord utility process. */
export interface DiscordBridgeManager {
  /** Applies non-secret policy after the child receives its one-time credentials. */
  applyPolicy: (policy: DiscordBridgeRuntimePolicy) => void
  /** Starts one utility process and transfers credentials exactly once. */
  start: () => Promise<void>
  /** Whether the active utility process reached its spawn event and has not exited. */
  isRunning: () => boolean
  /** Stops the active utility process, if one exists. */
  stop: () => Promise<void>
}

const SECRET_ENVIRONMENT_KEYS = new Set([
  'AIRI_TOKEN',
  'DASHSCOPE_API_KEY',
  'DEEPSEEK_API_KEY',
  'DISCORD_TOKEN',
  'OPENAI_API_KEY',
  'OPENAI_STT_API_KEY',
  'OPENAI_TTS_API_KEY',
])

const DISCORD_BOT_TOKEN_STORAGE_KEY = 'main/discord-bridge/bot-token'

function sanitizedEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(environment).filter(([key]) => !SECRET_ENVIRONMENT_KEYS.has(key)),
  )
}

/**
 * Creates the one-process Discord bridge manager owned by Electron Main.
 *
 * Use when:
 * - Discord must run outside every AIRI renderer.
 * - Bot and module credentials must avoid argv, environment, websocket config,
 *   renderer stores, and generic logging.
 *
 * Expects:
 * - `bootstrap` contains session-only synthetic/runtime credentials.
 * - `entryPath` points to the bundled utility-process entry.
 *
 * Returns:
 * - An idempotent lifecycle controller with a one-time MessagePort handoff.
 */
export function createDiscordBridgeManager(options: DiscordBridgeManagerOptions): DiscordBridgeManager {
  class StartCancelledError extends Error {
    constructor() {
      super('Discord bridge utility process stopped before spawn')
      this.name = 'DiscordBridgeStartCancelledError'
    }
  }

  let active: {
    child: DiscordBridgeUtilityProcess
    exited: Promise<void>
    resolveExit: () => void
    resolveStart: () => void
    rejectStart: (error: unknown) => void
    startOutcome: Promise<{ status: 'fulfilled' } | { error: unknown, status: 'rejected' }>
    startSettled: boolean
    startTask: Promise<void>
    spawned: boolean
    stopping: boolean
  } | undefined
  let stopTask: Promise<void> | undefined

  function applyPolicy(policy: DiscordBridgeRuntimePolicy) {
    if (!active?.spawned)
      return

    active.child.postMessage({
      type: 'discord-bridge:configure',
      policy,
    })
  }

  async function start() {
    if (stopTask)
      await stopTask
    if (active?.spawned)
      return
    if (active)
      return await active.startTask

    const fork = options.fork ?? ((modulePath, args, forkOptions) => {
      const nativeChild = utilityProcess.fork(modulePath, args, forkOptions)
      const child: DiscordBridgeUtilityProcess = {
        kill: () => nativeChild.kill(),
        once: (event, listener) => event === 'spawn'
          ? nativeChild.once('spawn', listener as () => void)
          : nativeChild.once('exit', listener as (code: number) => void),
        postMessage: (message: unknown, transfer?: DiscordBridgeMessagePort[]) => {
          nativeChild.postMessage(message, transfer?.map(port => port as MessagePortMain))
        },
      }
      return child
    })
    const createMessageChannel = options.createMessageChannel ?? (() => new MessageChannelMain())
    const nextChild = fork(options.entryPath, [], {
      env: sanitizedEnvironment(options.runtimeEnvironment ?? process.env),
      serviceName: 'AIRI Discord Bridge',
      stdio: 'ignore',
    })
    let resolveExit = () => {}
    const exited = new Promise<void>((resolve) => {
      resolveExit = resolve
    })
    let resolveStart = () => {}
    let rejectStart = (_error: unknown) => {}
    const pendingStart = new Promise<void>((resolve, reject) => {
      resolveStart = resolve
      rejectStart = reject
    })
    const nextActive = {
      child: nextChild,
      exited,
      resolveExit,
      resolveStart: () => {
        if (nextActive.startSettled)
          return
        nextActive.startSettled = true
        resolveStart()
      },
      rejectStart: (error: unknown) => {
        if (nextActive.startSettled)
          return
        nextActive.startSettled = true
        rejectStart(error)
      },
      startOutcome: Promise.resolve<{ status: 'fulfilled' } | { error: unknown, status: 'rejected' }>({ status: 'fulfilled' }),
      startSettled: false,
      startTask: pendingStart,
      spawned: false,
      stopping: false,
    }
    nextActive.startOutcome = pendingStart.then(
      () => ({ status: 'fulfilled' as const }),
      error => ({ error, status: 'rejected' as const }),
    )
    active = nextActive

    try {
      nextChild.once('exit', (code: number) => {
        const spawned = nextActive.spawned
        nextActive.resolveExit()
        if (!nextActive.startSettled) {
          nextActive.rejectStart(nextActive.stopping
            ? new StartCancelledError()
            : new Error(`Discord bridge utility process exited before spawn (${code})`))
        }
        if (active === nextActive)
          active = undefined
        try {
          options.onExit?.()
        }
        catch {
          options.log?.('Discord bridge utility process exit observer failed')
        }

        if (!spawned)
          return

        options.log?.(nextActive.stopping
          ? 'Discord bridge utility process stopped'
          : 'Discord bridge utility process exited')
      })
      nextChild.once('spawn', () => {
        if (nextActive.stopping || active !== nextActive) {
          nextActive.rejectStart(new StartCancelledError())
          return
        }

        let port1: DiscordBridgeMessagePort | undefined
        let port2: DiscordBridgeMessagePort | undefined
        let port1Transferred = false
        let bootstrapError: unknown
        try {
          const channel = createMessageChannel()
          port1 = channel.port1
          port2 = channel.port2
          nextChild.postMessage({ type: 'discord-bridge:bootstrap-port' }, [port1])
          port1Transferred = true
          if (!port2.postMessage)
            throw new Error('Discord bridge bootstrap sending port is unavailable')
          port2.postMessage({
            type: 'discord-bridge:bootstrap',
            ...options.bootstrap,
          })
        }
        catch (error) {
          bootstrapError = error
        }
        try {
          port2?.close()
        }
        catch (error) {
          bootstrapError ??= error
        }

        if (bootstrapError !== undefined) {
          if (!port1Transferred) {
            try {
              port1?.close()
            }
            catch {
              options.log?.('Discord bridge bootstrap port cleanup failed')
            }
          }
          nextActive.stopping = true
          nextActive.rejectStart(bootstrapError)
          try {
            nextChild.kill()
          }
          catch {
            options.log?.('Discord bridge utility process cleanup failed after bootstrap error')
          }
          return
        }

        nextActive.spawned = true
        options.log?.('Discord bridge utility process started')
        nextActive.resolveStart()
      })
    }
    catch (error) {
      nextActive.stopping = true
      nextActive.rejectStart(error)
      try {
        nextChild.kill()
      }
      catch {
        options.log?.('Discord bridge utility process cleanup failed during listener setup')
      }
    }

    return await pendingStart
  }

  async function performStop() {
    const activeChild = active
    if (!activeChild)
      return

    activeChild.stopping = true
    if (!activeChild.startSettled)
      activeChild.rejectStart(new StartCancelledError())

    const cleanupErrors: unknown[] = []
    try {
      if (!activeChild.child.kill())
        cleanupErrors.push(new Error('Discord bridge utility process rejected the stop request'))
    }
    catch (error) {
      cleanupErrors.push(error)
    }

    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        activeChild.exited,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error('Discord bridge utility process did not stop in time')), 5000)
        }),
      ])
    }
    catch (error) {
      cleanupErrors.push(error)
    }
    finally {
      if (timeout)
        clearTimeout(timeout)
    }

    const startOutcome = await activeChild.startOutcome
    if (startOutcome.status === 'rejected' && !(startOutcome.error instanceof StartCancelledError))
      cleanupErrors.push(startOutcome.error)

    if (cleanupErrors.length > 0) {
      options.log?.('Discord bridge utility process stop failed')
      throw cleanupErrors[0]
    }
  }

  function stop(): Promise<void> {
    if (stopTask)
      return stopTask

    const task = performStop()
    stopTask = task
    void task.then(
      () => {
        if (stopTask === task)
          stopTask = undefined
      },
      () => {
        if (stopTask === task)
          stopTask = undefined
      },
    )
    return task
  }

  return {
    applyPolicy,
    isRunning: () => Boolean(active?.spawned),
    start,
    stop,
  }
}

function assertTrustedRendererRequest(
  event: IpcMainEvent | undefined,
  isTrustedRendererUrl: (url: string) => boolean,
): void {
  const senderFrame = event?.senderFrame
  if (
    !event
    || !senderFrame
    || senderFrame !== event.sender.mainFrame
    || !isTrustedRendererUrl(senderFrame.url)
  ) {
    throw new Error('Unauthorized Discord bridge configuration request')
  }
}

/**
 * Registers the protected Discord bridge configuration and lifecycle boundary.
 *
 * Use when:
 * - Electron Main has initialized protected storage and the local server channel.
 * - Trusted AIRI renderers need to submit explicit token mutations and public policy.
 *
 * Expects:
 * - The utility entry is part of the current Electron build.
 * - `isTrustedRendererUrl` matches BrowserWindow navigation policy.
 *
 * Returns:
 * - Nothing; lifecycle hooks stop the utility process during application shutdown.
 */
export function setupDiscordBridgeService(options: {
  entryPath: string
  isTrustedRendererUrl: (url: string) => boolean
  lifecycle: Lifecycle
  secureStorage: SecureStorageHandle
  serverChannel: Pick<ServerChannel, 'getDiscordBridgeBootstrap'>
}): void {
  const { context, dispose } = createContext(ipcMain)
  // The former renderer-owned token key is retired unconditionally. Its value
  // is intentionally never read or migrated across the new Main-only boundary.
  void options.secureStorage.removeItem('settings/discord/token').catch(() => {
    console.error('Failed to remove the retired renderer-owned Discord token entry.')
  })
  let manager: DiscordBridgeManager | undefined
  let retiringManager: DiscordBridgeManager | undefined
  let retirementTask: Promise<{ error?: unknown, succeeded: boolean }> | undefined
  let running = false
  let serviceStopping = false
  let desiredConfiguration: { config: DiscordBridgeConfiguration, generation: number } | undefined
  let configurationGeneration = 0
  let appliedConfigurationGeneration = 0
  let configurationTask: Promise<void> | undefined
  let latestStatus: DiscordBridgeStatus = {
    configured: Boolean(options.secureStorage.getItem(DISCORD_BOT_TOKEN_STORAGE_KEY)),
    enabled: false,
    running: false,
  }

  function beginManagerRetirement(
    target: DiscordBridgeManager | undefined = manager ?? retiringManager,
  ): void {
    if (!target)
      return
    if (retiringManager && retiringManager !== target)
      throw new Error('Discord bridge utility process lifecycle owners overlapped')

    if (manager === target) {
      manager = undefined
      running = false
    }
    retiringManager = target
    if (retirementTask)
      return

    let rawStop: Promise<void>
    try {
      rawStop = target.stop()
    }
    catch (error) {
      rawStop = Promise.reject(error)
    }
    retirementTask = rawStop.then(
      () => ({ succeeded: true }),
      error => ({ error, succeeded: false }),
    )
  }

  async function drainManagerRetirement(): Promise<void> {
    if (!retiringManager)
      return
    if (!retirementTask)
      beginManagerRetirement()

    const target = retiringManager
    const task = retirementTask
    if (!task)
      return
    const outcome = await task
    if (retiringManager !== target || retirementTask !== task)
      return

    retirementTask = undefined
    if (!outcome.succeeded)
      throw new Error('Discord bridge utility process failed to stop', { cause: outcome.error })
    retiringManager = undefined
  }

  function isCurrentConfiguration(generation: number): boolean {
    return !serviceStopping
      && desiredConfiguration?.generation === generation
      && configurationGeneration === generation
  }

  async function applyConfiguration(
    config: DiscordBridgeConfiguration,
    generation: number,
  ): Promise<DiscordBridgeStatus | undefined> {
    await drainManagerRetirement()
    if (!isCurrentConfiguration(generation))
      return undefined

    let token = options.secureStorage.getItem(DISCORD_BOT_TOKEN_STORAGE_KEY) ?? ''
    if (config.token.action === 'set') {
      await options.secureStorage.setItem(DISCORD_BOT_TOKEN_STORAGE_KEY, config.token.value)
      token = config.token.value
    }
    else if (config.token.action === 'clear') {
      await options.secureStorage.removeItem(DISCORD_BOT_TOKEN_STORAGE_KEY)
      token = ''
    }
    if (!isCurrentConfiguration(generation))
      return undefined

    const policy: DiscordBridgeRuntimePolicy = {
      enabled: config.enabled,
      allowedChannelIds: [...config.allowedChannelIds],
      adminRoleIds: [...config.adminRoleIds],
      allowDirectMessages: config.allowDirectMessages,
      memoryConsentRequired: config.memoryConsentRequired,
      privacyNoticeEnabled: config.privacyNoticeEnabled,
      privacyNoticeText: config.privacyNoticeText,
      auditLogEnabled: config.auditLogEnabled,
      messagePacingMs: config.messagePacingMs,
      rateLimitMaxMessages: config.rateLimitMaxMessages,
      rateLimitWindowMs: config.rateLimitWindowMs,
    }

    if (!policy.enabled || !token) {
      beginManagerRetirement()
      await drainManagerRetirement()
      if (!isCurrentConfiguration(generation))
        return undefined
      return {
        configured: Boolean(token),
        enabled: policy.enabled,
        running: false,
      }
    }

    if (!manager) {
      const serverBootstrap = await options.serverChannel.getDiscordBridgeBootstrap()
      if (!isCurrentConfiguration(generation))
        return undefined
      const sttApiKey = process.env.OPENAI_STT_API_KEY?.trim()
      const sttBaseURL = process.env.OPENAI_STT_API_BASE_URL?.trim()
      const sttModel = process.env.OPENAI_STT_MODEL?.trim()
      const nextManager = createDiscordBridgeManager({
        bootstrap: {
          ...serverBootstrap,
          discordToken: token,
          ...(sttApiKey
            ? {
                transcription: {
                  apiKey: sttApiKey,
                  ...(sttBaseURL ? { baseURL: sttBaseURL } : {}),
                  ...(sttModel ? { model: sttModel } : {}),
                },
              }
            : {}),
        },
        entryPath: options.entryPath,
        onExit: () => {
          if (manager === nextManager) {
            manager = undefined
            running = false
          }
        },
      })
      manager = nextManager
    }

    const ownedManager = manager
    if (!ownedManager.isRunning()) {
      try {
        await ownedManager.start()
      }
      catch (error) {
        beginManagerRetirement(ownedManager)
        let cleanupError: unknown
        try {
          await drainManagerRetirement()
        }
        catch (caughtCleanupError) {
          cleanupError = caughtCleanupError
        }
        if (!isCurrentConfiguration(generation)) {
          if (cleanupError !== undefined)
            throw cleanupError
          return undefined
        }
        if (cleanupError !== undefined) {
          throw new AggregateError(
            [error, cleanupError],
            'Discord bridge utility process failed to start and clean up',
          )
        }
        throw new Error('Discord bridge utility process failed to start', { cause: error })
      }
    }
    if (!isCurrentConfiguration(generation) || manager !== ownedManager)
      return undefined

    running = ownedManager.isRunning()
    ownedManager.applyPolicy(policy)
    return {
      configured: true,
      enabled: true,
      running,
    }
  }

  async function runConfigurationLoop(): Promise<void> {
    for (;;) {
      if (serviceStopping || !desiredConfiguration)
        return
      const target = desiredConfiguration
      if (target.generation <= appliedConfigurationGeneration)
        return

      let status: DiscordBridgeStatus | undefined
      try {
        status = await applyConfiguration(target.config, target.generation)
      }
      catch (error) {
        if (target.generation !== configurationGeneration) {
          console.error('A superseded Discord bridge configuration failed during cleanup.')
          continue
        }
        throw error
      }
      if (!status || !isCurrentConfiguration(target.generation))
        continue

      latestStatus = status
      appliedConfigurationGeneration = target.generation
      if (
        desiredConfiguration?.generation === target.generation
        && desiredConfiguration.config.token.action !== 'unchanged'
      ) {
        // The secret mutation is durable now. Retain only public policy in the
        // coalescing slot instead of keeping a token value for the service lifetime.
        desiredConfiguration = {
          config: {
            ...desiredConfiguration.config,
            token: { action: 'unchanged' },
          },
          generation: target.generation,
        }
      }
    }
  }

  function ensureConfigurationTask(): Promise<void> {
    if (configurationTask)
      return configurationTask

    const task = runConfigurationLoop()
    configurationTask = task
    void task.then(
      () => {
        if (configurationTask === task)
          configurationTask = undefined
      },
      () => {
        if (configurationTask === task)
          configurationTask = undefined
      },
    )
    return task
  }

  defineInvokeHandler(context, electronConfigureDiscordBridge, async (request, handlerOptions) => {
    assertTrustedRendererRequest(handlerOptions?.raw?.ipcMainEvent, options.isTrustedRendererUrl)
    const parsed = safeParse(DiscordBridgeConfigurationSchema, request)
    if (!parsed.success)
      throw new Error('Invalid Discord bridge configuration request')
    if (serviceStopping)
      throw new Error('Discord bridge service is stopped')

    const generation = configurationGeneration + 1
    configurationGeneration = generation
    const pendingTokenMutation = desiredConfiguration
      && desiredConfiguration.generation > appliedConfigurationGeneration
      && desiredConfiguration.config.token.action !== 'unchanged'
      ? desiredConfiguration.config.token
      : undefined
    // Public policy is latest-wins, but an `unchanged` token action cannot erase
    // a newer secret mutation that has not reached secure storage yet. Fold that
    // one bounded mutation into the newest desired policy so A(set), B(set),
    // C(unchanged) durably applies B before C starts a utility process.
    const desiredConfig: DiscordBridgeConfiguration = {
      ...parsed.output,
      token: parsed.output.token.action === 'unchanged' && pendingTokenMutation
        ? pendingTokenMutation
        : parsed.output.token,
    }
    desiredConfiguration = { config: desiredConfig, generation }
    if (!desiredConfig.enabled || desiredConfig.token.action !== 'unchanged')
      beginManagerRetirement()

    for (;;) {
      if (serviceStopping || appliedConfigurationGeneration >= generation)
        break
      await ensureConfigurationTask()
    }
    return latestStatus
  })

  options.lifecycle.appHooks.onStop(async () => {
    const cleanupErrors: unknown[] = []
    serviceStopping = true
    configurationGeneration += 1
    desiredConfiguration = undefined
    beginManagerRetirement()
    try {
      dispose(new Error('Discord bridge service stopped'))
    }
    catch (error) {
      cleanupErrors.push(error)
    }
    if (configurationTask) {
      try {
        await configurationTask
      }
      catch (error) {
        cleanupErrors.push(error)
      }
    }
    beginManagerRetirement()
    try {
      await drainManagerRetirement()
    }
    catch (error) {
      cleanupErrors.push(error)
    }
    if (cleanupErrors.length > 0)
      throw cleanupErrors[0]
  })
}
