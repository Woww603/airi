import type { AppOptions } from '..'

import { isIP } from 'node:net'
import { networkInterfaces } from 'node:os'

import { useLogg } from '@guiiai/logg'
import { merge } from '@moeru/std'
import { plugin as ws } from 'crossws/server'
import { serve } from 'h3'

import { normalizeLoggerConfig, setupApp } from '..'

export interface ServerOptions extends AppOptions {
  port?: number
  hostname?: string
  tlsConfig?: {
    cert?: string
    key?: string
    passphrase?: string
  } | null
}

interface ServerInstance {
  close: (closeActiveConnections?: boolean) => Promise<void>
}

interface ServerCloseState {
  activeCallers: number
  forceTask: Promise<void> | null
  gracefulTask: Promise<void> | null
  instance: ServerInstance
  pendingTasks: number
}

/** Lifecycle controller for one embedded AIRI server runtime. */
export interface Server {
  /** Returns listener addresses suitable for client connection hints. */
  getConnectionHost: () => string[]
  /** Starts the current configuration once, de-duplicating concurrent calls. */
  start: () => Promise<void>
  /**
   * Stops the active instance.
   *
   * @param closeActiveConnections - Whether in-flight requests and sockets should be terminated immediately.
   * @default true
   */
  stop: (closeActiveConnections?: boolean) => Promise<void>
  /** Stops the active instance and starts a replacement with the latest options. */
  restart: () => Promise<void>
  /** Merges options used by the next start or restart. */
  updateConfig: (newOptions: ServerOptions) => void
}

function isAddressInUseError(error: unknown) {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === 'EADDRINUSE'
}

/**
 * Collects local IP addresses that can be used to reach the server from the LAN.
 *
 * Use when:
 * - Building connection hints for `0.0.0.0` listeners
 * - Showing reachable addresses in logs or UI
 *
 * Expects:
 * - Virtual interfaces should be ignored to reduce noisy or misleading addresses
 *
 * Returns:
 * - A de-duplicated list of valid IP addresses discovered from the host network interfaces
 */
export function getLocalIPs(): string[] {
  const interfaces = networkInterfaces()
  const addresses = new Set<string>()

  const VIRTUAL_INTERFACE_PREFIXES = [
    'vboxnet',
    'vmnet',
    'docker',
    'br-',
    'veth',
    'utun',
    'wg',
    'tap',
    'tun',
  ]
  const isVirtualInterface = (name: string) =>
    VIRTUAL_INTERFACE_PREFIXES.some(prefix => name.startsWith(prefix))

  for (const [name, entries] of Object.entries(interfaces)) {
    if (!entries)
      continue
    if (isVirtualInterface(name))
      continue

    for (const entry of entries) {
      const rawAddress = entry.address
      if (!rawAddress)
        continue

      const address = rawAddress.includes('%') ? rawAddress.split('%')[0] : rawAddress
      if (isIP(address))
        addresses.add(address)
    }
  }

  return [...addresses]
}

/**
 * Creates the websocket server controller for the AIRI runtime.
 *
 * Use when:
 * - Starting, stopping, or restarting the standalone runtime server
 * - Updating bind options between restarts
 *
 * Expects:
 * - The returned controller to manage a single active server instance at a time
 *
 * Returns:
 * - Lifecycle helpers for starting, stopping, restarting, and updating server options
 */
export function createServer(opts?: ServerOptions): Server {
  let options = merge<ServerOptions>({ port: 6121, hostname: '127.0.0.1' }, opts)

  const { appLogFormat, appLogLevel } = normalizeLoggerConfig(options)
  const log = useLogg('@proj-airi/server-runtime/server').withLogLevelString(appLogLevel).withFormat(appLogFormat)
  let serverInstance: ServerInstance | null = null
  let closeState: ServerCloseState | null = null
  let startTask: Promise<void> | null = null
  let stopClosesActiveConnections = false
  let stopTask: Promise<void> | null = null

  log.withFields({ hasTlsConfig: !!options?.tlsConfig }).log('creating server channel')

  function maybeReleaseCloseState(state: ServerCloseState) {
    if (state.activeCallers > 0 || state.pendingTasks > 0 || closeState !== state)
      return

    if (serverInstance === state.instance)
      serverInstance = null
    closeState = null
  }

  function closeTaskFor(state: ServerCloseState, closeActiveConnections: boolean) {
    const existingTask = closeActiveConnections ? state.forceTask : state.gracefulTask
    if (existingTask)
      return existingTask

    state.pendingTasks += 1
    const task = (async () => {
      try {
        if (closeActiveConnections)
          log.log('closing existing server instance')
        await state.instance.close(closeActiveConnections)
        if (closeActiveConnections)
          log.log('existing server instance closed')
      }
      catch (error) {
        if (
          typeof error === 'object'
          && error !== null
          && 'code' in error
          && error.code === 'ERR_SERVER_NOT_RUNNING'
        ) {
          return
        }

        log.withError(error).error('Error closing WebSocket server')
        throw error
      }
      finally {
        state.pendingTasks -= 1
        maybeReleaseCloseState(state)
      }
    })()

    if (closeActiveConnections)
      state.forceTask = task
    else
      state.gracefulTask = task
    return task
  }

  async function waitForCloseTasks(tasks: Promise<void>[]) {
    const results = await Promise.allSettled(tasks)
    const errors = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map(result => result.reason)
    if (errors.length === 1)
      throw errors[0]
    if (errors.length > 1)
      throw new AggregateError(errors, 'Multiple server shutdown operations failed.')
  }

  async function closeServer(closeActiveConnections = false) {
    if (!closeState) {
      if (!serverInstance || typeof serverInstance.close !== 'function')
        return
      closeState = {
        activeCallers: 0,
        forceTask: null,
        gracefulTask: null,
        instance: serverInstance,
        pendingTasks: 0,
      }
    }

    const state = closeState
    state.activeCallers += 1
    try {
      if (closeActiveConnections) {
        const forceTask = closeTaskFor(state, true)
        // The bounded force caller must not inherit a graceful close that may
        // never settle. The original graceful caller remains attached to its
        // own task and reports that result independently.
        await waitForCloseTasks([forceTask])
        if (closeState === state) {
          if (serverInstance === state.instance)
            serverInstance = null
          closeState = null
        }
        return
      }

      const gracefulTask = closeTaskFor(state, false)
      try {
        await waitForCloseTasks([gracefulTask])
      }
      catch {
        // A graceful close failure must not prevent the same owning instance
        // from attempting active-connection cleanup. Await both operations so
        // the caller receives the original error or an AggregateError.
        const forceTask = closeTaskFor(state, true)
        await waitForCloseTasks([gracefulTask, forceTask])
      }
    }
    finally {
      state.activeCallers -= 1
      maybeReleaseCloseState(state)
    }
  }

  async function start() {
    const pendingStop = stopTask
    if (pendingStop) {
      await pendingStop
      return start()
    }
    if (startTask) {
      return startTask
    }
    if (serverInstance) {
      return
    }

    startTask = (async () => {
      const secureEnabled = options?.tlsConfig != null
      const h3App = setupApp(options)

      const port = options.port
      const hostname = options.hostname
      // Bound configuration as well as traffic so an invalid environment or API value
      // cannot silently restore the underlying ws default of 100 MiB.
      const maxMessageBytes = typeof options.security?.maxMessageBytes === 'number' && Number.isFinite(options.security.maxMessageBytes)
        ? Math.min(64 * 1024 * 1024, Math.max(64 * 1024, Math.floor(options.security.maxMessageBytes)))
        : 8 * 1024 * 1024

      const instance = serve(h3App.app, {
        plugins: [ws({
          resolve: async (req) => {
            const response = await h3App.app.fetch(req)
            // @ts-expect-error - the .crossws property wasn't extended in types
            return response.crossws
          },
          options: {
            node: {
              serverOptions: {
                maxPayload: maxMessageBytes,
                perMessageDeflate: false,
              },
            },
          },
        })],
        port,
        hostname,
        tls: options?.tlsConfig || undefined,
        reusePort: true,
        silent: true,
        manual: true,
        // NOTICE:
        // Embedded server controllers must not install process-wide signal handlers.
        // srvx 0.11.15 registers SIGINT/SIGTERM listeners per instance and does not
        // remove them from close(); see `srvx/dist/_chunks/_plugins.mjs:26-58`.
        // The CLI owns bounded graceful/forced shutdown in `bin/processLifecycle.ts`.
        // Remove this override only when srvx exposes disposable signal ownership.
        gracefulShutdown: false,
      })

      try {
        let appDisposed = false
        serverInstance = {
          close: async (closeActiveConnections = false) => {
            const cleanupTasks: Promise<void>[] = []
            if (!appDisposed) {
              appDisposed = true
              cleanupTasks.push(Promise.resolve().then(() => h3App.dispose()))
            }
            cleanupTasks.push((async () => {
              log.log('closing server instance')
              await instance.close(closeActiveConnections)
              log.log('server instance closed')
            })())

            // Application disposal and transport close are independent owners.
            // Await both so one cleanup exception cannot strand sockets, timers,
            // or peers, and preserve every failure for the lifecycle caller.
            await waitForCloseTasks(cleanupTasks)
          },
        }

        await instance.serve()

        const protocol = secureEnabled ? 'wss' : 'ws'
        if (hostname === '0.0.0.0') {
          const ips = getLocalIPs().filter(ip => ip !== '127.0.0.1' && ip !== '::1')
          const targets = ips.length > 0 ? ips.join(', ') : 'localhost'
          log.log(`@proj-airi/server-runtime started on ${protocol}://0.0.0.0:${port} (reachable via: ${targets})`)
        }
        else {
          log.log(`@proj-airi/server-runtime started on ${protocol}://${hostname}:${port}`)
        }
      }
      catch (error) {
        serverInstance = null
        const cleanupResults = await Promise.allSettled([
          Promise.resolve().then(() => h3App.dispose()),
          Promise.resolve().then(() => instance.close(true)),
        ])
        const cleanupErrors = cleanupResults
          .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
          .map(result => result.reason)
        for (const cleanupError of cleanupErrors)
          log.withError(cleanupError).error('failed to clean up an incomplete WebSocket server start')

        if (isAddressInUseError(error) && cleanupErrors.length === 0) {
          log.withError(error).warn('WebSocket server port already in use, assuming an existing listener is available')
          return
        }

        const failure = cleanupErrors.length > 0
          ? new AggregateError([error, ...cleanupErrors], 'Server startup and cleanup failed.')
          : error
        log.withError(failure).error('failed to start WebSocket server')
        throw failure
      }
    })().finally(() => {
      startTask = null
    })

    return startTask
  }
  function stop(closeActiveConnections = true) {
    if (stopTask && (!closeActiveConnections || stopClosesActiveConnections))
      return stopTask

    const pendingStart = startTask
    const ownedStopTask = (async () => {
      const errors: unknown[] = []
      if (pendingStart) {
        try {
          // srvx 0.11.15 treats close-before-listening as a successful no-op.
          // Drain the exact pending listen before closing so it cannot publish
          // an orphaned server after this controller has released ownership.
          await pendingStart
        }
        catch (error) {
          errors.push(error)
        }
      }

      try {
        await closeServer(closeActiveConnections)
      }
      catch (error) {
        errors.push(error)
      }

      if (errors.length === 1)
        throw errors[0]
      if (errors.length > 1)
        throw new AggregateError(errors, 'Server start and shutdown both failed.')
    })().finally(() => {
      if (stopTask === ownedStopTask) {
        stopTask = null
        stopClosesActiveConnections = false
      }
    })
    stopTask = ownedStopTask
    stopClosesActiveConnections = closeActiveConnections
    return ownedStopTask
  }

  async function restart() {
    log.withFields({
      authenticationConfigured: Boolean(options.auth?.token),
      hasTlsConfig: options.tlsConfig != null,
      hostname: options.hostname,
      moduleCredentialCount: options.auth?.moduleCredentials?.length ?? 0,
      port: options.port,
    }).log('restarting server channel')
    // Reuse stop ordering so a restart requested during serve() cannot close
    // before listening and then revive the stale instance without an owner.
    await stop(true)
    await start()
  }

  function updateConfig(newOptions: ServerOptions) {
    options = merge<ServerOptions>(options, newOptions)
  }

  return {
    getConnectionHost: () => {
      if (options.hostname && options.hostname !== '0.0.0.0' && options.hostname !== '::') {
        return [options.hostname]
      }

      return getLocalIPs()
    },
    start,
    stop,
    restart,
    updateConfig,
  }
}
