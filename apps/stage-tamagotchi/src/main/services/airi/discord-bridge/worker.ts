import type { DiscordBridgeRuntimeConfig } from '@proj-airi/discord-bot/adapter'
import type { DiscordBridgeBootstrap, DiscordBridgeRuntimePolicy } from '@proj-airi/stage-shared/discord-bridge'
import type { MessageEvent, MessagePortMain } from 'electron'

import process from 'node:process'

import { DiscordAdapter } from '@proj-airi/discord-bot/adapter'
import { DiscordBridgeBootstrapSchema, DiscordBridgeRuntimePolicySchema } from '@proj-airi/stage-shared/discord-bridge'
import { safeParse } from 'valibot'

interface BootstrapMessage extends DiscordBridgeBootstrap {
  type: 'discord-bridge:bootstrap'
}

/** Adapter lifecycle used by the isolated Discord worker. */
export interface DiscordBridgeWorkerAdapter {
  /** Applies the latest parent-authorized, non-secret policy. */
  applyRuntimeConfig: (policy: DiscordBridgeRuntimeConfig) => Promise<void>
  /** Initializes the adapter without connecting before policy admission. */
  start: () => Promise<void>
  /** Drains connection work and closes every adapter-owned resource. */
  stop: () => Promise<void>
}

/** External boundaries owned by one isolated Discord worker lifecycle. */
export interface DiscordBridgeWorkerLifecycleOptions {
  /** Constructs the adapter only after a valid one-time protected bootstrap arrives. */
  createAdapter?: (bootstrap: DiscordBridgeBootstrap) => DiscordBridgeWorkerAdapter
  /** Records a sanitized lifecycle category and never receives provider messages or credentials. */
  onError?: (event: 'bootstrap' | 'initialization' | 'policy' | 'shutdown', errorName: 'Error' | 'UnknownError') => void
}

/** Controllable lifecycle behind the utility-process message/signal entrypoint. */
export interface DiscordBridgeWorkerLifecycle {
  /** Accepts the one-time Main-owned secret port. Duplicate ports are closed. */
  acceptBootstrap: (port: MessagePortMain) => void
  /** Validates and applies a parent policy, or remembers it until bootstrap completes. */
  applyPolicy: (value: unknown) => void
  /** Stops the exact adapter owner and returns the process exit code. */
  shutdown: () => Promise<0 | 1>
}

function parseBootstrapMessage(value: unknown): BootstrapMessage | undefined {
  const result = safeParse(DiscordBridgeBootstrapSchema, value)
  return result.success ? result.output : undefined
}

function parseRuntimePolicy(value: unknown): DiscordBridgeRuntimePolicy | undefined {
  const result = safeParse(DiscordBridgeRuntimePolicySchema, value)
  return result.success ? result.output : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Creates the isolated worker lifecycle without taking ownership of process exit.
 *
 * Use when:
 * - Electron's utility-process entrypoint needs to bind parent messages and signals.
 * - Tests need to prove shutdown status without terminating the test process.
 *
 * Expects:
 * - Bootstrap credentials arrive once through a transferred Main-owned port.
 * - Runtime policy messages contain no secret token.
 *
 * Returns:
 * - A lifecycle that classifies shutdown failure as exit code 1.
 */
export function createDiscordBridgeWorkerLifecycle(
  options: DiscordBridgeWorkerLifecycleOptions = {},
): DiscordBridgeWorkerLifecycle {
  type TaskOutcome
    = | { status: 'fulfilled' }
      | { error: unknown, status: 'rejected' }
  interface WorkerOwner {
    adapter: DiscordBridgeWorkerAdapter
    attemptedPolicyGeneration: number
    failed: boolean
    generation: number
    policyTask?: Promise<TaskOutcome>
    started: boolean
    startTask?: Promise<TaskOutcome>
  }

  let activeOwner: WorkerOwner | undefined
  let latestPolicy: { generation: number, policy: DiscordBridgeRuntimeConfig } | undefined
  let bootstrapAccepted = false
  let lifecycleFailed = false
  let lifecycleGeneration = 0
  let policyGeneration = 0
  let pendingBootstrap: {
    listener: (event: MessageEvent) => void
    port: MessagePortMain
  } | undefined
  let stopping = false
  let shutdownTask: Promise<0 | 1> | undefined

  const lifecycleErrorObserver = options.onError ?? ((event: string, errorName: 'Error' | 'UnknownError') => {
    console.error(`Discord bridge ${event} failed (${errorName}).`)
  })
  const reportError = (event: Parameters<NonNullable<DiscordBridgeWorkerLifecycleOptions['onError']>>[0], errorName: 'Error' | 'UnknownError') => {
    try {
      lifecycleErrorObserver(event, errorName)
    }
    catch {
      console.error('Discord bridge lifecycle error observer failed.')
    }
  }
  const observeError = (event: Parameters<NonNullable<DiscordBridgeWorkerLifecycleOptions['onError']>>[0], error: unknown) => {
    reportError(event, error instanceof Error ? 'Error' : 'UnknownError')
  }

  function captureOperation(operation: () => Promise<void> | void): Promise<TaskOutcome> {
    try {
      return Promise.resolve(operation()).then(
        () => ({ status: 'fulfilled' }),
        error => ({ error, status: 'rejected' }),
      )
    }
    catch (error) {
      return Promise.resolve({ error, status: 'rejected' })
    }
  }

  function isOwnerActive(owner: WorkerOwner): boolean {
    return activeOwner === owner
      && owner.generation === lifecycleGeneration
      && !stopping
  }

  async function runPolicyLoop(owner: WorkerOwner): Promise<void> {
    for (;;) {
      if (!owner.started || !isOwnerActive(owner))
        return

      const target = latestPolicy
      if (!target || target.generation <= owner.attemptedPolicyGeneration)
        return

      owner.attemptedPolicyGeneration = target.generation
      await owner.adapter.applyRuntimeConfig(target.policy)
      if (!isOwnerActive(owner))
        return
    }
  }

  function ensurePolicyLoop(owner: WorkerOwner): void {
    if (!owner.started || !isOwnerActive(owner) || owner.policyTask)
      return

    const task = captureOperation(() => runPolicyLoop(owner))
    owner.policyTask = task
    void task.then((outcome) => {
      if (owner.policyTask === task)
        owner.policyTask = undefined
      if (outcome.status === 'rejected') {
        owner.failed = true
        if (isOwnerActive(owner))
          observeError('policy', outcome.error)
      }
      if (
        isOwnerActive(owner)
        && latestPolicy
        && latestPolicy.generation > owner.attemptedPolicyGeneration
      ) {
        ensurePolicyLoop(owner)
      }
    })
  }

  function beginOwnerStart(owner: WorkerOwner): void {
    const task = captureOperation(() => owner.adapter.start())
    owner.startTask = task
    void task.then((outcome) => {
      if (owner.startTask === task)
        owner.startTask = undefined
      if (outcome.status === 'rejected') {
        owner.failed = true
        observeError('initialization', outcome.error)
        return
      }

      owner.started = true
      if (isOwnerActive(owner))
        ensurePolicyLoop(owner)
    })
  }

  function acceptBootstrap(port: MessagePortMain): void {
    if (bootstrapAccepted || stopping) {
      try {
        port.close()
      }
      catch (error) {
        lifecycleFailed = true
        observeError('bootstrap', error)
      }
      return
    }
    bootstrapAccepted = true

    try {
      const handleBootstrap = (event: MessageEvent) => {
        if (pendingBootstrap?.listener === handleBootstrap)
          pendingBootstrap = undefined
        const message = parseBootstrapMessage(event.data)
        try {
          port.close()
        }
        catch (error) {
          lifecycleFailed = true
          observeError('bootstrap', error)
        }
        if (!message || stopping) {
          if (!message) {
            lifecycleFailed = true
            reportError('bootstrap', 'UnknownError')
          }
          return
        }

        const createAdapter = options.createAdapter ?? (bootstrap => new DiscordAdapter({
          airiToken: bootstrap.moduleCredential,
          airiUrl: bootstrap.airiUrl,
          discordToken: bootstrap.discordToken,
          moduleIdentity: bootstrap.moduleIdentity,
          transcription: bootstrap.transcription,
        }))
        let owner: DiscordBridgeWorkerAdapter
        try {
          owner = createAdapter(message)
        }
        catch (error) {
          lifecycleFailed = true
          observeError('initialization', error)
          return
        }
        const generation = lifecycleGeneration + 1
        lifecycleGeneration = generation
        const state: WorkerOwner = {
          adapter: owner,
          attemptedPolicyGeneration: 0,
          failed: false,
          generation,
          started: false,
        }
        activeOwner = state
        beginOwnerStart(state)
      }
      pendingBootstrap = { listener: handleBootstrap, port }
      port.once('message', handleBootstrap)
      port.start()
    }
    catch (error) {
      const bootstrapOwner = pendingBootstrap?.port === port
        ? pendingBootstrap
        : undefined
      if (bootstrapOwner)
        pendingBootstrap = undefined
      lifecycleFailed = true
      observeError('bootstrap', error)
      if (bootstrapOwner) {
        try {
          port.removeListener('message', bootstrapOwner.listener)
        }
        catch (listenerError) {
          observeError('bootstrap', listenerError)
        }
      }
      try {
        port.close()
      }
      catch (closeError) {
        observeError('bootstrap', closeError)
      }
    }
  }

  function applyPolicy(value: unknown): void {
    const policy = parseRuntimePolicy(value)
    if (!policy || stopping)
      return

    const generation = policyGeneration + 1
    policyGeneration = generation
    latestPolicy = {
      generation,
      policy: policy satisfies DiscordBridgeRuntimeConfig,
    }
    if (activeOwner)
      ensurePolicyLoop(activeOwner)
  }

  function shutdown(): Promise<0 | 1> {
    if (shutdownTask)
      return shutdownTask

    stopping = true
    lifecycleGeneration += 1
    const bootstrapOwner = pendingBootstrap
    pendingBootstrap = undefined
    if (bootstrapOwner) {
      try {
        bootstrapOwner.port.removeListener('message', bootstrapOwner.listener)
      }
      catch (error) {
        lifecycleFailed = true
        observeError('shutdown', error)
      }
      try {
        bootstrapOwner.port.close()
      }
      catch (error) {
        lifecycleFailed = true
        observeError('shutdown', error)
      }
    }
    const owner = activeOwner
    activeOwner = undefined

    let resolveShutdown = (_code: 0 | 1) => {}
    const task = new Promise<0 | 1>((resolve) => {
      resolveShutdown = resolve
    })
    shutdownTask = task

    void (async () => {
      if (!owner) {
        resolveShutdown(lifecycleFailed ? 1 : 0)
        return
      }

      const pendingStart = owner.startTask
      const pendingPolicy = owner.policyTask
      // Stop is invoked before any await so DiscordAdapter can invalidate and
      // drain its own pending login/config lifecycle instead of deadlocking.
      const firstStop = captureOperation(() => owner.adapter.stop())
      let settlementOrder = 0
      const ordered = (pending: Promise<TaskOutcome>) => pending.then(outcome => ({
        order: settlementOrder += 1,
        outcome,
      }))
      const startResult = pendingStart ? ordered(pendingStart) : undefined
      const policyResult = pendingPolicy ? ordered(pendingPolicy) : undefined
      const stopResult = ordered(firstStop)
      const [settledStart, settledPolicy, settledStop] = await Promise.all([
        startResult,
        policyResult,
        stopResult,
      ])

      let failed = lifecycleFailed || owner.failed
      if (settledStart?.outcome.status === 'rejected')
        failed = true
      if (settledPolicy?.outcome.status === 'rejected')
        failed = true
      if (settledStop.outcome.status === 'rejected') {
        failed = true
        observeError('shutdown', settledStop.outcome.error)
      }

      const lifecycleSettledAfterStop = (settledStart?.order ?? 0) > settledStop.order
        || (settledPolicy?.order ?? 0) > settledStop.order
      if (lifecycleSettledAfterStop) {
        const finalStop = await captureOperation(() => owner.adapter.stop())
        if (finalStop.status === 'rejected') {
          failed = true
          observeError('shutdown', finalStop.error)
        }
      }

      resolveShutdown(failed ? 1 : 0)
    })().catch((error) => {
      observeError('shutdown', error)
      resolveShutdown(1)
    })
    return task
  }

  return { acceptBootstrap, applyPolicy, shutdown }
}

/**
 * Starts the isolated Discord bridge worker message loop.
 *
 * Use when:
 * - Electron launches this module as a utility process entrypoint.
 * - The worker must accept its one-time protected bootstrap port before starting Discord.
 *
 * Expects:
 * - Electron exposes `process.parentPort` inside the utility process.
 * - Electron Main sends the bootstrap port before runtime policy updates are useful.
 *
 * Returns:
 * - Nothing; listeners remain active until a termination signal completes shutdown.
 *
 * Call stack:
 *
 * startDiscordBridgeWorker
 *   -> {@link createDiscordBridgeWorkerLifecycle}
 *     -> DiscordAdapter.start
 */
export function startDiscordBridgeWorker(): void {
  const parentPort = process.parentPort
  if (!parentPort)
    return

  const lifecycle = createDiscordBridgeWorkerLifecycle()
  parentPort.on('message', (event) => {
    const message: unknown = event.data
    if (!isRecord(message))
      return

    if (message.type === 'discord-bridge:bootstrap-port') {
      const [port] = event.ports
      if (port)
        lifecycle.acceptBootstrap(port)
      return
    }

    if (message.type === 'discord-bridge:configure')
      lifecycle.applyPolicy(message.policy)
  })

  const requestShutdown = () => {
    void lifecycle.shutdown().then(
      code => process.exit(code),
      () => process.exit(1),
    )
  }
  process.once('SIGTERM', requestShutdown)
  process.once('SIGINT', requestShutdown)
}

startDiscordBridgeWorker()
