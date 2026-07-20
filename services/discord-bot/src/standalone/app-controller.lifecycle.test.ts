import type { StandaloneDiscordAdapterEvents } from '../adapters/standalone-adapter'
import type { VoiceDiagnosticsObserver } from '../bots/discord/commands/voiceDiagnostics'

import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { StandaloneDiscordAppController } from './app-controller'
import { StandaloneDashboardState } from './dashboard-state'

const adapterMocks = vi.hoisted(() => ({
  instances: [] as Array<{
    discordToken?: string
    events?: StandaloneDiscordAdapterEvents
    start: ReturnType<typeof vi.fn>
    stop: ReturnType<typeof vi.fn>
    voiceDiagnostics?: VoiceDiagnosticsObserver
  }>,
  start: vi.fn<() => Promise<void>>(),
  stop: vi.fn<() => Promise<void>>(),
}))

vi.mock('../adapters/standalone-adapter', () => ({
  StandaloneDiscordAdapter: class {
    discordToken: string | undefined
    events: StandaloneDiscordAdapterEvents | undefined
    start = vi.fn(() => adapterMocks.start())
    stop = vi.fn(() => adapterMocks.stop())
    voiceDiagnostics: VoiceDiagnosticsObserver | undefined

    constructor(config: {
      discordToken?: string
      events?: StandaloneDiscordAdapterEvents
      voiceDiagnostics?: VoiceDiagnosticsObserver
    }) {
      this.discordToken = config.discordToken
      this.events = config.events
      this.voiceDiagnostics = config.voiceDiagnostics
      adapterMocks.instances.push(this)
    }
  },
}))

beforeEach(() => {
  adapterMocks.instances.length = 0
  adapterMocks.start.mockReset()
  adapterMocks.start.mockResolvedValue(undefined)
  adapterMocks.stop.mockReset()
  adapterMocks.stop.mockResolvedValue(undefined)
})

function createController(env: NodeJS.ProcessEnv = {
  DEEPSEEK_API_KEY: 'synthetic-model-key',
  DEEPSEEK_MODEL: 'synthetic-model',
  DISCORD_TOKEN: 'synthetic-discord-token',
}) {
  return new StandaloneDiscordAppController({
    env,
    envFilePath: join(tmpdir(), 'airi-discord-controller-lifecycle-missing.env'),
    state: new StandaloneDashboardState(),
  })
}

/**
 * @example
 * describe('standalone Discord controller lifecycle ownership', () => {})
 */
describe('standalone Discord controller lifecycle ownership', () => {
  /**
   * @example
   * it('returns fixed lifecycle failures without exposing rejected Error text', async () => {})
   */
  it('returns fixed lifecycle failures without exposing rejected Error text', async () => {
    const startSentinel = 'synthetic-controller-start-error https://synthetic.invalid/private?credential=start'
    const stopSentinel = 'synthetic-controller-stop-error https://synthetic.invalid/private?credential=stop'
    adapterMocks.start.mockRejectedValueOnce(new Error(startSentinel))
    const startController = createController()

    // ROOT CAUSE:
    //
    // Controller start/stop paths converted arbitrary adapter errors with
    // errorMessageFrom and returned the result through HTTP while also storing
    // it in Dashboard `lastError` and recent events.
    const startResult = await startController.startBot()

    const stopController = createController()
    await stopController.startBot()
    adapterMocks.stop.mockRejectedValueOnce(new Error(stopSentinel))
    const stopResult = await stopController.stopBot()
    const serialized = JSON.stringify({
      startResult,
      startSnapshot: startController.getSnapshot(),
      stopResult,
      stopSnapshot: stopController.getSnapshot(),
    })

    // @example
    expect(startResult.ok).toBe(false)
    // @example
    expect(stopResult.ok).toBe(false)
    // @example
    expect(serialized).not.toContain(startSentinel)
    // @example
    expect(serialized).not.toContain(stopSentinel)
    // @example
    expect(serialized).not.toContain('synthetic.invalid')
  })

  /**
   * @example
   * it('reproduces Discord audit D-016 by sharing one controller start and adapter owner', async () => {})
   */
  it('reproduces Discord audit D-016 and Discord audit D-019 by sharing one controller start and adapter owner', async () => {
    let resolveStart = () => {}
    adapterMocks.start.mockReturnValue(new Promise<void>((resolve) => {
      resolveStart = resolve
    }))
    const controller = createController()

    // ROOT CAUSE:
    //
    // startBot published this.adapter only after awaiting adapter.start(). Two
    // dashboard requests therefore both observed no owner, constructed separate
    // Discord clients, and began independent gateway logins for one process.
    const startA = controller.startBot()
    const startB = controller.startBot()
    const startC = controller.startBot()
    await vi.waitFor(() => {
      /**
       * @example
       * expect(adapterMocks.instances).toHaveLength(1)
       */
      expect(adapterMocks.instances).toHaveLength(1)
    })
    /**
     * @example
     * expect(startB).toBe(startA)
     */
    expect(startB).toBe(startA)
    /**
     * @example
     * expect(startC).toBe(startA)
     */
    expect(startC).toBe(startA)
    /**
     * @example
     * expect(adapterMocks.start).toHaveBeenCalledOnce()
     */
    expect(adapterMocks.start).toHaveBeenCalledOnce()
    resolveStart()
    const [resultA, resultB, resultC] = await Promise.all([startA, startB, startC])
    /**
     * @example
     * expect(resultA.ok).toBe(true)
     */
    expect(resultA.ok).toBe(true)
    /**
     * @example
     * expect(resultB).toEqual(resultA)
     */
    expect(resultB).toEqual(resultA)
    /**
     * @example
     * expect(resultC).toEqual(resultA)
     */
    expect(resultC).toEqual(resultA)
  })

  /**
   * @example
   * it('reproduces Discord audit D-016 by stopping the adapter published before pending start', async () => {})
   */
  it('reproduces Discord audit D-016 and Discord audit D-019 by stopping the adapter published before pending start', async () => {
    let resolveStart = () => {}
    const startPending = new Promise<void>((resolve) => {
      resolveStart = resolve
    })
    let resolveStop = () => {}
    const stopPending = new Promise<void>((resolve) => {
      resolveStop = resolve
    })
    adapterMocks.start.mockReturnValue(startPending)
    adapterMocks.stop.mockReturnValue(stopPending)
    const controller = createController()
    const startTask = controller.startBot()
    await vi.waitFor(() => {
      /**
       * @example
       * expect(adapterMocks.instances).toHaveLength(1)
       */
      expect(adapterMocks.instances).toHaveLength(1)
    })

    // ROOT CAUSE:
    //
    // stopBot could not see an adapter whose login was still pending because
    // startBot retained it only in a local variable. stop returned "not running",
    // then late login completion assigned the adapter and resurrected the bot.
    let stopSettled = false
    const stopTask = controller.stopBot().finally(() => {
      stopSettled = true
    })
    await new Promise<void>(resolve => setImmediate(resolve))
    /**
     * @example
     * expect(adapterMocks.stop).toHaveBeenCalledOnce()
     */
    expect(adapterMocks.stop).toHaveBeenCalledOnce()
    /**
     * @example
     * expect(stopSettled).toBe(false)
     */
    expect(stopSettled).toBe(false)
    resolveStart()
    resolveStop()
    const [startResult, stopResult] = await Promise.all([startTask, stopTask])
    /**
     * @example
     * expect(startResult.ok).toBe(false)
     */
    expect(startResult.ok).toBe(false)
    /**
     * @example
     * expect(stopResult.ok).toBe(true)
     */
    expect(stopResult.ok).toBe(true)
    /**
     * @example
     * expect(controller.adapter).toBeUndefined()
     */
    expect(Reflect.get(controller, 'adapter')).toBeUndefined()
  })

  /**
   * @example
   * it('reproduces Discord audit D-016 by sharing concurrent controller stop requests', async () => {})
   */
  it('reproduces Discord audit D-016 by sharing concurrent controller stop requests', async () => {
    const controller = createController()
    await controller.startBot()
    let resolveStop = () => {}
    adapterMocks.stop.mockReturnValue(new Promise<void>((resolve) => {
      resolveStop = resolve
    }))

    // ROOT CAUSE:
    //
    // stopBot cleared this.adapter before its cleanup settled but owned no stop
    // task. A concurrent stop returned early while the first cleanup remained
    // pending, so callers observed incompatible lifecycle completion points.
    const stopA = controller.stopBot()
    const stopB = controller.stopBot()
    /**
     * @example
     * expect(stopB).toBe(stopA)
     */
    expect(stopB).toBe(stopA)
    /**
     * @example
     * expect(adapterMocks.stop).toHaveBeenCalledOnce()
     */
    expect(adapterMocks.stop).toHaveBeenCalledOnce()
    resolveStop()
    await Promise.all([stopA, stopB])
  })

  /**
   * @example
   * it('reproduces Discord audit D-016 by letting a concurrent stop cancel pending restart', async () => {})
   */
  it('reproduces Discord audit D-016 and Discord audit D-019 by letting a concurrent stop cancel pending restart', async () => {
    const controller = createController()
    await controller.startBot()
    let resolveStop = () => {}
    adapterMocks.stop.mockReturnValue(new Promise<void>((resolve) => {
      resolveStop = resolve
    }))

    // ROOT CAUSE:
    //
    // restartBot awaited the shared stop task and unconditionally called
    // startBot afterward. A later explicit stop shared the old cleanup promise
    // but carried no generation, so restart resurrected a new adapter after the
    // stop caller had already requested a terminal stopped state.
    const restartTask = controller.restartBot()
    await vi.waitFor(() => {
      /**
       * @example
       * expect(adapterMocks.stop).toHaveBeenCalledOnce()
       */
      expect(adapterMocks.stop).toHaveBeenCalledOnce()
    })
    const stopTask = controller.stopBot()
    resolveStop()
    const [restartResult, stopResult] = await Promise.all([restartTask, stopTask])

    /**
     * @example
     * expect(restartResult.ok).toBe(false)
     */
    expect(restartResult.ok).toBe(false)
    /**
     * @example
     * expect(stopResult.ok).toBe(true)
     */
    expect(stopResult.ok).toBe(true)
    /**
     * @example
     * expect(adapterMocks.instances).toHaveLength(1)
     */
    expect(adapterMocks.instances).toHaveLength(1)
    /**
     * @example
     * expect(adapterMocks.start).toHaveBeenCalledOnce()
     */
    expect(adapterMocks.start).toHaveBeenCalledOnce()
  })

  /**
   * @example
   * it('keeps the latest start intent after an earlier Discord audit D-019 stop', async () => {})
   */
  it('keeps the latest start intent after an earlier Discord audit D-019 stop', async () => {
    const controller = createController()
    await controller.startBot()
    let resolveStop = () => {}
    adapterMocks.stop.mockReturnValue(new Promise<void>((resolve) => {
      resolveStop = resolve
    }))

    // ROOT CAUSE:
    //
    // startBot rejected every request observed while stopTask existed. A start
    // that was linearly later than stop therefore lost to the older intent,
    // leaving the dashboard stopped even though the user's latest action was
    // start.
    const stopTask = controller.stopBot()
    const latestStartTask = controller.startBot()
    const sharedLatestStartTask = controller.startBot()
    /**
     * @example
     * expect(sharedLatestStartTask).toBe(latestStartTask)
     */
    expect(sharedLatestStartTask).toBe(latestStartTask)
    resolveStop()
    const [stopResult, latestStartResult] = await Promise.all([stopTask, latestStartTask, sharedLatestStartTask])

    /**
     * @example
     * expect(stopResult.ok).toBe(true)
     */
    expect(stopResult.ok).toBe(true)
    /**
     * @example
     * expect(latestStartResult.ok).toBe(true)
     */
    expect(latestStartResult.ok).toBe(true)
    /**
     * @example
     * expect(adapterMocks.instances).toHaveLength(2)
     */
    expect(adapterMocks.instances).toHaveLength(2)
    /**
     * @example
     * expect(adapterMocks.start).toHaveBeenCalledTimes(2)
     */
    expect(adapterMocks.start).toHaveBeenCalledTimes(2)
    adapterMocks.instances[1]?.events?.onReady?.()
    /**
     * @example
     * expect(controller.getSnapshot().botStatus).toBe('ready')
     */
    expect(controller.getSnapshot().botStatus).toBe('ready')
  })

  /**
   * @example
   * it('lets a terminal Discord audit D-019 stop cancel a queued start', async () => {})
   */
  it('lets a terminal Discord audit D-019 stop cancel a queued start', async () => {
    const controller = createController()
    await controller.startBot()
    let resolveStop = () => {}
    adapterMocks.stop.mockReturnValue(new Promise<void>((resolve) => {
      resolveStop = resolve
    }))

    // ROOT CAUSE:
    //
    // A queued restart/start that did not carry its own generation could run
    // unconditionally after a later explicit stop shared the original teardown
    // promise, resurrecting a client after the latest terminal intent.
    const initialStopTask = controller.stopBot()
    const queuedStartTask = controller.startBot()
    const terminalStopTask = controller.stopBot()
    /**
     * @example
     * expect(terminalStopTask).toBe(initialStopTask)
     */
    expect(terminalStopTask).toBe(initialStopTask)
    resolveStop()
    const [initialStop, queuedStart, terminalStop] = await Promise.all([
      initialStopTask,
      queuedStartTask,
      terminalStopTask,
    ])

    /**
     * @example
     * expect(initialStop.ok).toBe(true)
     */
    expect(initialStop.ok).toBe(true)
    /**
     * @example
     * expect(terminalStop.ok).toBe(true)
     */
    expect(terminalStop.ok).toBe(true)
    /**
     * @example
     * expect(queuedStart.ok).toBe(false)
     */
    expect(queuedStart.ok).toBe(false)
    /**
     * @example
     * expect(adapterMocks.instances).toHaveLength(1)
     */
    expect(adapterMocks.instances).toHaveLength(1)
    /**
     * @example
     * expect(controller.getSnapshot().botStatus).toBe('stopped')
     */
    expect(controller.getSnapshot().botStatus).toBe('stopped')
    /**
     * @example
     * expect(Reflect.get(controller, 'startTask')).toBeUndefined()
     */
    expect(Reflect.get(controller, 'startTask')).toBeUndefined()
    /**
     * @example
     * expect(Reflect.get(controller, 'stopTask')).toBeUndefined()
     */
    expect(Reflect.get(controller, 'stopTask')).toBeUndefined()
  })

  /**
   * @example
   * it('linearizes deferred start restart start stop for Discord audit D-019', async () => {})
   */
  it('linearizes deferred start restart start stop for Discord audit D-019', async () => {
    let resolveStart = () => {}
    adapterMocks.start.mockReturnValue(new Promise<void>((resolve) => {
      resolveStart = resolve
    }))
    const controller = createController()
    const originalStart = controller.startBot()
    await vi.waitFor(() => {
      /**
       * @example
       * expect(adapterMocks.instances).toHaveLength(1)
       */
      expect(adapterMocks.instances).toHaveLength(1)
    })

    // ROOT CAUSE:
    //
    // Independent start/stop/restart branches had no shared operation order.
    // A restart or queued start could run after a newer terminal stop once the
    // original login finally resolved, creating a replacement against the
    // user's latest intent.
    const restartTask = controller.restartBot()
    const queuedStartTask = controller.startBot()
    const terminalStopTask = controller.stopBot()
    resolveStart()
    const [originalResult, restartResult, queuedResult, stopResult] = await Promise.all([
      originalStart,
      restartTask,
      queuedStartTask,
      terminalStopTask,
    ])

    /**
     * @example
     * expect(originalResult.ok).toBe(false)
     */
    expect(originalResult.ok).toBe(false)
    /**
     * @example
     * expect(restartResult.ok).toBe(false)
     */
    expect(restartResult.ok).toBe(false)
    /**
     * @example
     * expect(queuedResult.ok).toBe(false)
     */
    expect(queuedResult.ok).toBe(false)
    /**
     * @example
     * expect(stopResult.ok).toBe(true)
     */
    expect(stopResult.ok).toBe(true)
    /**
     * @example
     * expect(adapterMocks.instances).toHaveLength(1)
     */
    expect(adapterMocks.instances).toHaveLength(1)
    /**
     * @example
     * expect(adapterMocks.start).toHaveBeenCalledOnce()
     */
    expect(adapterMocks.start).toHaveBeenCalledOnce()
    /**
     * @example
     * expect(adapterMocks.stop).toHaveBeenCalledOnce()
     */
    expect(adapterMocks.stop).toHaveBeenCalledOnce()
    /**
     * @example
     * expect(controller.getSnapshot().botStatus).toBe('stopped')
     */
    expect(controller.getSnapshot().botStatus).toBe('stopped')
  })

  /**
   * @example
   * it('ignores stale adapter callbacks after Discord audit D-019 stop', async () => {})
   */
  it('ignores stale adapter callbacks after Discord audit D-019 stop', async () => {
    const controller = createController()
    await controller.startBot()
    const staleEvents = adapterMocks.instances[0]?.events
    staleEvents?.onReady?.()
    await controller.stopBot()

    // ROOT CAUSE:
    //
    // Controller event callbacks were not bound to their adapter generation.
    // A listener already queued by an old client could publish ready/reply state
    // after stop or replacement and make the public dashboard lie about both
    // lifecycle state and delivery counters.
    staleEvents?.onReady?.()
    staleEvents?.onReplySent?.({ operationSequence: 1, surface: 'text-guild' })

    const snapshot = controller.getSnapshot()
    /**
     * @example
     * expect(snapshot.botStatus).toBe('stopped')
     */
    expect(snapshot.botStatus).toBe('stopped')
    /**
     * @example
     * expect(snapshot.successfulReplies).toBe(0)
     */
    expect(snapshot.successfulReplies).toBe(0)
  })

  /**
   * @example
   * it('drains a late Discord audit D-019 login rejection without reviving the bot', async () => {})
   */
  it('drains a late Discord audit D-019 login rejection without reviving the bot', async () => {
    let rejectStart = (_error: Error) => {}
    adapterMocks.start.mockReturnValue(new Promise<void>((_resolve, reject) => {
      rejectStart = reject
    }))
    const controller = createController()
    const startTask = controller.startBot()
    await vi.waitFor(() => {
      /**
       * @example
       * expect(adapterMocks.instances).toHaveLength(1)
       */
      expect(adapterMocks.instances).toHaveLength(1)
    })

    // ROOT CAUSE:
    //
    // An unowned pending login rejection could settle after stop, escape as an
    // unhandled rejection, or restore error/ready state from the stale start.
    // stop must own and drain that exact task while preserving stopped state.
    const stopTask = controller.stopBot()
    rejectStart(new Error('SYNTHETIC_D019_LATE_LOGIN_FAILURE'))
    const [startResult, stopResult] = await Promise.all([startTask, stopTask])

    /**
     * @example
     * expect(startResult.ok).toBe(false)
     */
    expect(startResult.ok).toBe(false)
    /**
     * @example
     * expect(stopResult.ok).toBe(true)
     */
    expect(stopResult.ok).toBe(true)
    /**
     * @example
     * expect(adapterMocks.stop).toHaveBeenCalledOnce()
     */
    expect(adapterMocks.stop).toHaveBeenCalledOnce()
    /**
     * @example
     * expect(controller.getSnapshot().botStatus).toBe('stopped')
     */
    expect(controller.getSnapshot().botStatus).toBe('stopped')
  })

  /**
   * @example
   * it('retries the exact failed cleanup owner before a fresh Discord audit D-019 start', async () => {})
   */
  it('retries the exact failed cleanup owner before a fresh Discord audit D-019 start', async () => {
    const controller = createController()
    await controller.startBot()
    adapterMocks.stop.mockRejectedValueOnce(new Error('SYNTHETIC_D019_CLEANUP_FAILURE'))

    // ROOT CAUSE:
    //
    // The controller discarded its adapter reference before cleanup completed.
    // If destroy then failed, a later start constructed a second Discord client
    // while the exact failed gateway owner could still be alive and unreachable.
    // The failed owner must remain in a bounded retirement slot and a later start
    // must retry that exact cleanup before constructing the replacement.
    const failedStop = await controller.stopBot()
    /**
     * @example
     * expect(failedStop.ok).toBe(false)
     */
    expect(failedStop.ok).toBe(false)
    /**
     * @example
     * expect(controller.getSnapshot().botStatus).toBe('error')
     */
    expect(controller.getSnapshot().botStatus).toBe('error')
    /**
     * @example
     * expect(Reflect.get(controller, 'retiringAdapter')).toBe(adapterMocks.instances[0])
     */
    expect(Reflect.get(controller, 'retiringAdapter')).toBe(adapterMocks.instances[0])
    let releaseCleanupRetry = () => {}
    adapterMocks.stop.mockReturnValueOnce(new Promise<void>((resolve) => {
      releaseCleanupRetry = resolve
    }))
    const freshStartTask = controller.startBot()
    await vi.waitFor(() => {
      /**
       * @example
       * expect(adapterMocks.stop).toHaveBeenCalledTimes(2)
       */
      expect(adapterMocks.stop).toHaveBeenCalledTimes(2)
    })
    /**
     * @example
     * expect(adapterMocks.instances).toHaveLength(1)
     */
    expect(adapterMocks.instances).toHaveLength(1)

    releaseCleanupRetry()
    const freshStart = await freshStartTask
    adapterMocks.instances[1]?.events?.onReady?.()
    /**
     * @example
     * expect(freshStart.ok).toBe(true)
     */
    expect(freshStart.ok).toBe(true)
    /**
     * @example
     * expect(adapterMocks.instances).toHaveLength(2)
     */
    expect(adapterMocks.instances).toHaveLength(2)
    /**
     * @example
     * expect(Reflect.get(controller, 'retiringAdapter')).toBeUndefined()
     */
    expect(Reflect.get(controller, 'retiringAdapter')).toBeUndefined()
    /**
     * @example
     * expect(controller.getSnapshot().botStatus).toBe('ready')
     */
    expect(controller.getSnapshot().botStatus).toBe('ready')
  })

  /**
   * @example
   * it('continues draining pending login after Discord audit D-019 cleanup rejects', async () => {})
   */
  it('continues draining pending login after Discord audit D-019 cleanup rejects', async () => {
    let resolveStart = () => {}
    adapterMocks.start.mockReturnValue(new Promise<void>((resolve) => {
      resolveStart = resolve
    }))
    adapterMocks.stop.mockRejectedValueOnce(new Error('SYNTHETIC_D019_DESTROY_FAILURE'))
    const controller = createController()
    const startTask = controller.startBot()
    await vi.waitFor(() => {
      /**
       * @example
       * expect(adapterMocks.instances).toHaveLength(1)
       */
      expect(adapterMocks.instances).toHaveLength(1)
    })

    // ROOT CAUSE:
    //
    // Sequential teardown aborted at the first destroy/cleanup rejection and
    // stopped observing the still-pending login. The old login could then
    // settle outside lifecycle ownership after the dashboard reported failure.
    let stopSettled = false
    const stopTask = controller.stopBot().finally(() => {
      stopSettled = true
    })
    await new Promise<void>(resolve => setImmediate(resolve))
    /**
     * @example
     * expect(stopSettled).toBe(false)
     */
    expect(stopSettled).toBe(false)
    resolveStart()
    const [startResult, stopResult] = await Promise.all([startTask, stopTask])

    /**
     * @example
     * expect(startResult.ok).toBe(false)
     */
    expect(startResult.ok).toBe(false)
    /**
     * @example
     * expect(stopResult.ok).toBe(false)
     */
    expect(stopResult.ok).toBe(false)
    /**
     * @example
     * expect(Reflect.get(controller, 'adapter')).toBeUndefined()
     */
    expect(Reflect.get(controller, 'adapter')).toBeUndefined()
    /**
     * @example
     * expect(Reflect.get(controller, 'startTask')).toBeUndefined()
     */
    expect(Reflect.get(controller, 'startTask')).toBeUndefined()
    /**
     * @example
     * expect(Reflect.get(controller, 'stopTask')).toBeUndefined()
     */
    expect(Reflect.get(controller, 'stopTask')).toBeUndefined()
  })

  /**
   * @example
   * it('uses the latest config after Discord audit D-019 restart', async () => {})
   */
  it('uses the latest config after Discord audit D-019 restart', async () => {
    const env: NodeJS.ProcessEnv = {
      DEEPSEEK_API_KEY: 'synthetic-model-key',
      DEEPSEEK_MODEL: 'synthetic-model',
      DISCORD_TOKEN: 'synthetic-discord-token-a',
    }
    const controller = createController(env)
    await controller.startBot()
    adapterMocks.instances[0]?.events?.onReady?.()
    let resolveStop = () => {}
    adapterMocks.stop.mockReturnValue(new Promise<void>((resolve) => {
      resolveStop = resolve
    }))

    // ROOT CAUSE:
    //
    // A restart that reused configuration captured by the old adapter could
    // construct its replacement with stale credentials after the dashboard
    // saved newer settings during teardown.
    const restartTask = controller.restartBot()
    env.DISCORD_TOKEN = 'synthetic-discord-token-b'
    resolveStop()
    const restartResult = await restartTask
    adapterMocks.instances[1]?.events?.onReady?.()

    /**
     * @example
     * expect(restartResult.ok).toBe(true)
     */
    expect(restartResult.ok).toBe(true)
    /**
     * @example
     * expect(adapterMocks.instances).toHaveLength(2)
     */
    expect(adapterMocks.instances).toHaveLength(2)
    /**
     * @example
     * expect(adapterMocks.instances[1]?.discordToken).toBe('synthetic-discord-token-b')
     */
    expect(adapterMocks.instances[1]?.discordToken).toBe('synthetic-discord-token-b')
    /** @example expect(controller.getSnapshot().botStatus).toBe('ready') */
    expect(controller.getSnapshot().botStatus).toBe('ready')
  })

  /**
   * @example
   * it('keeps replacement state isolated from stale Discord audit D-019 callbacks', async () => {})
   */
  it('keeps replacement state isolated from stale Discord audit D-019 callbacks', async () => {
    const controller = createController()
    await controller.startBot()
    const staleEvents = adapterMocks.instances[0]?.events
    staleEvents?.onReady?.()
    await controller.restartBot()
    const currentEvents = adapterMocks.instances[1]?.events
    currentEvents?.onReady?.()

    // ROOT CAUSE:
    //
    // Adapter callbacks shared one unscoped dashboard observer. A callback
    // queued by the replaced client could overwrite the new bot tag/status or
    // increment reply counters as if the old delivery belonged to the current
    // connection.
    staleEvents?.onStatusChange?.({ failureCategory: 'lifecycle-cleanup-failure', status: 'error' })
    staleEvents?.onReady?.()
    staleEvents?.onReplySent?.({ operationSequence: 1, surface: 'text-guild' })

    const snapshot = controller.getSnapshot()
    /**
     * @example
     * expect(snapshot.botStatus).toBe('ready')
     */
    expect(snapshot.botStatus).toBe('ready')
    /**
     * @example
     * expect(snapshot.successfulReplies).toBe(0)
     */
    expect(snapshot.successfulReplies).toBe(0)
  })

  /**
   * @example
   * it('finalizes stopped voice diagnostics and rejects stale generation signals', async () => {})
   */
  it('finalizes stopped voice diagnostics and rejects stale generation signals', async () => {
    const controller = createController()
    await controller.startBot()
    const oldObserver = adapterMocks.instances[0]?.voiceDiagnostics
    if (!oldObserver)
      throw new Error('Expected a generation-scoped standalone voice diagnostics observer.')

    oldObserver.record({
      mode: 'qwen-realtime',
      runtimeSequence: oldObserver.runtimeSequence,
      sessionSequence: 1,
      stage: 'session-started',
    })
    // @example
    expect(controller.getSnapshot().voiceDiagnostics.active).toHaveLength(1)

    let resolveStop = () => {}
    adapterMocks.stop.mockReturnValueOnce(new Promise<void>((resolve) => {
      resolveStop = resolve
    }))

    // ROOT CAUSE:
    //
    // A lifecycle generation gate protected ordinary Dashboard events, but no
    // observer existed for voice transitions and stop did not deterministically
    // finalize active diagnostic sessions. A stopped adapter could therefore
    // leave a live projection behind, while a late callback from that adapter
    // could contaminate the replacement generation.
    //
    // Stop now invalidates the generation and synchronously finalizes retained
    // sessions before awaiting cleanup. Each replacement gets a new observer;
    // its record callback accepts signals only while that generation is current.
    const restartTask = controller.restartBot()
    let snapshot = controller.getSnapshot()
    // @example
    expect(snapshot.voiceDiagnostics.active).toHaveLength(0)
    // @example
    expect(snapshot.voiceDiagnostics.completed[0]?.completionReason).toBe('stopped')

    oldObserver.record({
      mode: 'qwen-realtime',
      runtimeSequence: oldObserver.runtimeSequence,
      sessionSequence: 2,
      stage: 'session-started',
    })
    // @example
    expect(controller.getSnapshot().voiceDiagnostics.active).toHaveLength(0)

    resolveStop()
    // @example
    await expect(restartTask).resolves.toMatchObject({ ok: true })
    const newObserver = adapterMocks.instances[1]?.voiceDiagnostics
    if (!newObserver)
      throw new Error('Expected a replacement voice diagnostics observer.')

    // @example
    expect(newObserver.runtimeSequence).not.toBe(oldObserver.runtimeSequence)
    newObserver.record({
      mode: 'qwen-realtime',
      runtimeSequence: newObserver.runtimeSequence,
      sessionSequence: 1,
      stage: 'session-started',
    })
    oldObserver.record({
      runtimeSequence: oldObserver.runtimeSequence,
      sessionSequence: 1,
      stage: 'transport-ready',
    })
    snapshot = controller.getSnapshot()
    // @example
    expect(snapshot.voiceDiagnostics.active).toHaveLength(1)
    // @example
    expect(snapshot.voiceDiagnostics.active[0]).toMatchObject({
      stage: 'started',
      transportReady: false,
    })

    await controller.stopBot()
  })

  /**
   * @example
   * it('reserves one capability run and invalidates pending starts across cancellation and bot lifecycle changes', async () => {})
   */
  it('reserves one capability run and invalidates pending starts across cancellation and bot lifecycle changes', async () => {
    const controller = createController()

    // The production public-config read is asynchronous. Concurrent callers
    // must therefore be resolved by the controller generation, not by timing
    // assumptions in the HTTP adapter.
    const concurrent = await Promise.all([
      controller.startCapabilityDiagnostics(),
      controller.startCapabilityDiagnostics(),
    ])
    /** @example expect(concurrent.filter(Boolean)).toHaveLength(1) */
    expect(concurrent.filter(Boolean)).toHaveLength(1)
    /** @example expect(controller.getSnapshot().capabilityDiagnostics.phase).toBe('running') */
    expect(controller.getSnapshot().capabilityDiagnostics.phase).toBe('running')

    controller.cancelCapabilityDiagnostics()
    controller.cancelCapabilityDiagnostics()
    /** @example expect(controller.getSnapshot().capabilityDiagnostics.phase).toBe('cancelled') */
    expect(controller.getSnapshot().capabilityDiagnostics.phase).toBe('cancelled')

    const cancelledStart = controller.startCapabilityDiagnostics()
    controller.cancelCapabilityDiagnostics()
    /** @example await expect(cancelledStart).resolves.toBeUndefined() */
    await expect(cancelledStart).resolves.toBeUndefined()
    /** @example expect(controller.getSnapshot().capabilityDiagnostics.phase).toBe('cancelled') */
    expect(controller.getSnapshot().capabilityDiagnostics.phase).toBe('cancelled')

    const stoppedStart = controller.startCapabilityDiagnostics()
    await controller.stopBot()
    /** @example await expect(stoppedStart).resolves.toBeUndefined() */
    await expect(stoppedStart).resolves.toBeUndefined()
    /** @example expect(controller.getSnapshot().capabilityDiagnostics.phase).toBe('cancelled') */
    expect(controller.getSnapshot().capabilityDiagnostics.phase).toBe('cancelled')
  })
})
