import type { ServerProcessHost } from './bin/processLifecycle'

import { Format, LogLevelString } from '@guiiai/logg'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ServerProcessLifecycle } from './bin/processLifecycle'

const logMocks = vi.hoisted(() => {
  const logger = {
    error: vi.fn(),
    log: vi.fn(),
    warn: vi.fn(),
    withError: vi.fn(),
    withFields: vi.fn(),
    withFormat: vi.fn(),
    withLogLevelString: vi.fn(),
  }
  logger.withError.mockReturnValue(logger)
  logger.withFields.mockReturnValue(logger)
  logger.withFormat.mockReturnValue(logger)
  logger.withLogLevelString.mockReturnValue(logger)
  return logger
})

const serveMocks = vi.hoisted(() => {
  let resolveServe: (() => void) | null = null
  let rejectServe: ((error: Error) => void) | null = null

  const serveCall = vi.fn(() => new Promise<void>((resolve, reject) => {
    resolveServe = resolve
    rejectServe = reject
  }))

  const closeCall = vi.fn(async (_closeActiveConnections = false) => {})
  const createServerCall = vi.fn(() => ({
    serve: serveCall,
    close: closeCall,
  }))
  const disposeCall = vi.fn(() => {})
  const websocketPluginCall = vi.fn(() => ({}))
  const setupAppCall = vi.fn(() => ({
    app: {
      fetch: vi.fn(async () => ({ crossws: {} })),
    },
    closeAllPeers: vi.fn(),
    dispose: disposeCall,
  }))

  return {
    closeCall,
    createServerCall,
    disposeCall,
    rejectServe: (error: Error) => rejectServe?.(error),
    resolveServe: () => resolveServe?.(),
    serveCall,
    setupAppCall,
    websocketPluginCall,
  }
})

vi.mock('h3', () => ({
  H3: class {
    get = vi.fn()
  },
  defineWebSocketHandler: vi.fn(handler => handler),
  serve: serveMocks.createServerCall,
}))

vi.mock('crossws/server', () => ({
  plugin: serveMocks.websocketPluginCall,
}))

vi.mock('@guiiai/logg', async (importOriginal) => {
  const original = await importOriginal<typeof import('@guiiai/logg')>()
  return {
    ...original,
    useLogg: () => logMocks,
  }
})

vi.mock('./index', () => ({
  normalizeLoggerConfig: () => ({
    appLogFormat: 'pretty',
    appLogLevel: 'log',
  }),
  setupApp: serveMocks.setupAppCall,
}))

describe('createServer', async () => {
  const { createServer } = await import('./server')

  beforeEach(() => {
    vi.clearAllMocks()
    logMocks.withError.mockReturnValue(logMocks)
    logMocks.withFields.mockReturnValue(logMocks)
    logMocks.withFormat.mockReturnValue(logMocks)
    logMocks.withLogLevelString.mockReturnValue(logMocks)
    serveMocks.closeCall.mockImplementation(async () => {})
  })

  it('deduplicates concurrent start callers on the pending listen (Discord audit N-001)', async () => {
    const server = createServer({ hostname: '127.0.0.1', port: 6121 })

    const firstStart = server.start()
    const secondStart = server.start()
    let secondStartSettled = false
    void secondStart.then(() => {
      secondStartSettled = true
    })

    expect(serveMocks.serveCall).toHaveBeenCalledTimes(1)
    await Promise.resolve()
    const secondSettledBeforeListening = secondStartSettled

    serveMocks.resolveServe()

    await Promise.all([firstStart, secondStart])
    // ROOT CAUSE:
    //
    // start() published serverInstance before srvx serve() settled, then checked
    // that wrapper before the single-flight startTask. A concurrent caller could
    // therefore resolve before the socket listened and miss a later bind error.
    // The pending start task is now authoritative until listening completes.
    expect(secondSettledBeforeListening).toBe(false)
    expect(serveMocks.serveCall).toHaveBeenCalledTimes(1)
  })

  /**
   * @example
   * it('waits for a pending listen before closing it', async () => {})
   */
  it('waits for a pending listen before closing the same instance (Discord audit N-001)', async () => {
    const server = createServer({ hostname: '127.0.0.1', port: 6121 })
    const startTask = server.start()
    const stopTask = server.stop(true)
    const closeCallsBeforeListening = serveMocks.closeCall.mock.calls.length

    // ROOT CAUSE:
    //
    // createServer published its wrapper before srvx serve() finished, and
    // stop() called close() concurrently with that pending listen. srvx 0.11.15
    // treats close-before-listening as a successful no-op, so serve() could then
    // open an orphaned listener after createServer had cleared its ownership.
    // Stop now drains the pending start first and closes that same instance only
    // after the transport has either started or failed its own cleanup.
    serveMocks.resolveServe()
    await expect(Promise.all([startTask, stopTask])).resolves.toEqual([undefined, undefined])
    expect(closeCallsBeforeListening).toBe(0)
    expect(serveMocks.closeCall).toHaveBeenCalledOnce()
    expect(serveMocks.closeCall).toHaveBeenCalledWith(true)
  })

  it('clears the single-flight state when start fails', async () => {
    const server = createServer({ hostname: '127.0.0.1', port: 6121 })

    const firstStart = server.start()
    serveMocks.rejectServe(new Error('bind failed'))

    await expect(firstStart).rejects.toThrow('bind failed')
    expect(serveMocks.disposeCall).toHaveBeenCalledTimes(1)

    const retryStart = server.start()
    expect(serveMocks.serveCall).toHaveBeenCalledTimes(2)

    serveMocks.resolveServe()
    await retryStart
  })

  /**
   * @example
   * it('continues and aggregates startup cleanup failures', async () => {})
   */
  it('continues and aggregates startup cleanup failures (Discord audit N-001)', async () => {
    // ROOT CAUSE:
    //
    // The startup catch called application disposal before transport close and
    // explicitly swallowed close rejection. A disposal throw therefore skipped
    // socket cleanup and replaced the bind failure. Both cleanup owners now run
    // to settlement and their failures are aggregated with the startup error.
    const startError = new Error('synthetic serve failure')
    const disposeError = new Error('synthetic startup dispose failure')
    const closeError = new Error('synthetic startup close failure')
    serveMocks.disposeCall.mockImplementationOnce(() => {
      throw disposeError
    })
    serveMocks.closeCall.mockRejectedValueOnce(closeError)
    const server = createServer({ hostname: '127.0.0.1', port: 6121 })
    const startTask = server.start()
    serveMocks.rejectServe(startError)

    // @example
    await expect(startTask).rejects.toEqual(expect.objectContaining({
      errors: [startError, disposeError, closeError],
      message: 'Server startup and cleanup failed.',
    }))
    // @example
    expect(serveMocks.disposeCall).toHaveBeenCalledTimes(1)
    // @example
    expect(serveMocks.closeCall).toHaveBeenCalledWith(true)
    // @example
    expect(logMocks.withError).toHaveBeenCalledWith(disposeError)
    // @example
    expect(logMocks.withError).toHaveBeenCalledWith(closeError)
  })

  /**
   * @example
   * it('starts a replacement requested while close is pending', async () => {})
   */
  it('starts a replacement requested while close is pending (Discord audit N-001)', async () => {
    // ROOT CAUSE:
    //
    // start() treated a still-published serverInstance as running even while
    // stop() was closing it. A start request in that interval resolved early,
    // then close cleared the instance and left the controller stopped. Start
    // now joins the owning stop task before deciding whether to create a new
    // server instance.
    let resolveClose: () => void = () => {}
    const pendingClose = new Promise<void>((resolve) => {
      resolveClose = resolve
    })
    const server = createServer({ hostname: '127.0.0.1', port: 6121 })
    const initialStart = server.start()
    serveMocks.resolveServe()
    await initialStart
    serveMocks.closeCall.mockReturnValueOnce(pendingClose)

    const stopTask = server.stop(true)
    await vi.waitFor(() => {
      // @example
      expect(serveMocks.closeCall).toHaveBeenCalledWith(true)
    })
    const replacementStart = server.start()
    resolveClose()
    await stopTask
    await vi.waitFor(() => {
      // @example
      expect(serveMocks.serveCall).toHaveBeenCalledTimes(2)
    })
    serveMocks.resolveServe()

    // @example
    await expect(replacementStart).resolves.toBeUndefined()
  })

  /**
   * @example
   * it('replaces a server whose start was still pending', async () => {})
   */
  it('replaces a server whose start was still pending when restart begins (Discord audit N-001)', async () => {
    // ROOT CAUSE:
    //
    // restart() closed the candidate instance and then reused its still-live
    // startTask. When that stale serve promise resolved, restart returned even
    // though close had already removed the instance. Restart now drains the
    // prior start lifecycle before opening a distinct replacement.
    const server = createServer({ hostname: '127.0.0.1', port: 6121 })
    const pendingStart = server.start()
    const restartTask = server.restart()
    await Promise.resolve()
    // @example
    expect(serveMocks.closeCall).not.toHaveBeenCalled()
    serveMocks.resolveServe()
    await vi.waitFor(() => {
      // @example
      expect(serveMocks.closeCall).toHaveBeenCalledWith(true)
    })
    await pendingStart
    await vi.waitFor(() => {
      // @example
      expect(serveMocks.serveCall).toHaveBeenCalledTimes(2)
    })
    serveMocks.resolveServe()

    // @example
    await expect(restartTask).resolves.toBeUndefined()
  })

  /**
   * @example
   * it('propagates a real controller close failure after deterministic cleanup', async () => {})
   */
  it('propagates a real controller close failure after deterministic cleanup (Discord audit N-001)', async () => {
    // ROOT CAUSE:
    //
    // closeServer logged every non-ERR_SERVER_NOT_RUNNING exception and then
    // resolved. The CLI lifecycle therefore could not distinguish a successful
    // shutdown from a failed srvx close and incorrectly exited with code zero.
    // The owning controller now clears its state, keeps the structured log, and
    // rejects so the process lifecycle can force remaining cleanup and exit 1.
    const server = createServer({ hostname: '127.0.0.1', port: 6121 })
    const startTask = server.start()
    serveMocks.resolveServe()
    await startTask
    serveMocks.closeCall.mockRejectedValueOnce(new Error('synthetic srvx close failure'))

    // @example
    await expect(server.stop(false)).rejects.toThrow('synthetic srvx close failure')
    // @example
    expect(serveMocks.disposeCall).toHaveBeenCalledTimes(1)
    // @example
    expect(serveMocks.closeCall).toHaveBeenNthCalledWith(1, false)
    // @example
    expect(serveMocks.closeCall).toHaveBeenNthCalledWith(2, true)
    // @example
    expect(logMocks.withError).toHaveBeenCalledWith(expect.objectContaining({
      message: 'synthetic srvx close failure',
    }))

    const replacementStart = server.start()
    serveMocks.resolveServe()
    // @example
    await expect(replacementStart).resolves.toBeUndefined()
    // @example
    expect(serveMocks.serveCall).toHaveBeenCalledTimes(2)
  })

  /**
   * @example
   * it('preserves a non-Error transport rejection', async () => {})
   */
  it('preserves a non-Error transport rejection during shutdown (Discord audit N-001)', async () => {
    // ROOT CAUSE:
    //
    // The ERR_SERVER_NOT_RUNNING check used the `in` operator after asserting
    // every rejection was an object. JavaScript promises can reject with any
    // value, so a primitive transport rejection was replaced by a TypeError
    // before structured reporting could observe the original failure.
    const server = createServer({ hostname: '127.0.0.1', port: 6121 })
    const startTask = server.start()
    serveMocks.resolveServe()
    await startTask
    serveMocks.closeCall.mockRejectedValue('synthetic primitive close failure')

    // @example
    await expect(server.stop(true)).rejects.toBe('synthetic primitive close failure')
    // @example
    expect(logMocks.withError).toHaveBeenCalledWith('synthetic primitive close failure')
  })

  /**
   * @example
   * it('carries a createServer close failure through the CLI lifecycle', async () => {})
   */
  it('carries a createServer close failure through the CLI lifecycle (Discord audit N-001)', async () => {
    // ROOT CAUSE:
    //
    // A mock Server rejection proved the CLI policy but not the production
    // controller boundary, because createServer previously swallowed the srvx
    // rejection. This test composes the real controller with the CLI lifecycle
    // and verifies the failure reaches structured reporting and exit status.
    const onError = vi.fn()
    const host: ServerProcessHost = {
      exit: vi.fn(),
      off: vi.fn(),
      on: vi.fn(),
    }
    const server = createServer({ hostname: '127.0.0.1', port: 6121 })
    const lifecycle = new ServerProcessLifecycle(server, host, { onError })
    const startTask = lifecycle.start()
    serveMocks.resolveServe()
    await startTask
    const closeError = new Error('synthetic owning-boundary close failure')
    serveMocks.closeCall.mockRejectedValueOnce(closeError)

    await lifecycle.shutdown()

    // @example
    expect(serveMocks.closeCall).toHaveBeenNthCalledWith(1, false)
    // @example
    expect(serveMocks.closeCall).toHaveBeenNthCalledWith(2, true)
    // @example
    expect(onError).toHaveBeenCalledWith(closeError)
    // @example
    expect(host.exit).toHaveBeenCalledWith(1)
    // @example
    expect(host.off).toHaveBeenCalledTimes(2)
  })

  /**
   * @example
   * it('upgrades a pending graceful close to forced active-connection cleanup', async () => {})
   */
  it('upgrades a pending graceful close on the same srvx instance (Discord audit N-001)', async () => {
    let resolveGracefulClose: () => void = () => {}
    const gracefulClose = new Promise<void>((resolve) => {
      resolveGracefulClose = resolve
    })
    serveMocks.closeCall.mockImplementation(closeActiveConnections => closeActiveConnections
      ? Promise.resolve()
      : gracefulClose)
    const server = createServer({ hostname: '127.0.0.1', port: 6121 })
    const startTask = server.start()
    serveMocks.resolveServe()
    await startTask

    const gracefulStop = server.stop(false)
    await vi.waitFor(() => {
      // @example
      expect(serveMocks.closeCall).toHaveBeenCalledWith(false)
    })
    const forcedStop = server.stop(true)
    await vi.waitFor(() => {
      // @example
      expect(serveMocks.closeCall).toHaveBeenCalledWith(true)
    })

    resolveGracefulClose()
    // @example
    await expect(Promise.all([gracefulStop, forcedStop])).resolves.toEqual([undefined, undefined])
    // @example
    expect(serveMocks.closeCall).toHaveBeenCalledTimes(2)
    // @example
    expect(serveMocks.disposeCall).toHaveBeenCalledTimes(1)
  })

  /**
   * @example
   * it('does not make forced close wait for a stuck graceful close', async () => {})
   */
  it('does not make forced close wait for a stuck graceful close (Discord audit N-001)', async () => {
    // ROOT CAUSE:
    //
    // A concurrent stop(true) did invoke the underlying forced srvx close, but
    // closeServer then awaited the already-stuck graceful close as well. The
    // CLI timeout therefore could not complete bounded shutdown when the
    // graceful promise ignored the force request. A forced caller now owns and
    // awaits only the force task; the original graceful caller still observes
    // and reports its own eventual result.
    let resolveGracefulClose: () => void = () => {}
    const gracefulClose = new Promise<void>((resolve) => {
      resolveGracefulClose = resolve
    })
    serveMocks.closeCall.mockImplementation(closeActiveConnections => closeActiveConnections
      ? Promise.resolve()
      : gracefulClose)
    const server = createServer({ hostname: '127.0.0.1', port: 6121 })
    const startTask = server.start()
    serveMocks.resolveServe()
    await startTask

    const gracefulStop = server.stop(false)
    await vi.waitFor(() => {
      // @example
      expect(serveMocks.closeCall).toHaveBeenCalledWith(false)
    })
    let forcedStopSettled = false
    const forcedStop = server.stop(true).then(() => {
      forcedStopSettled = true
    })
    await vi.waitFor(() => {
      // @example
      expect(serveMocks.closeCall).toHaveBeenCalledWith(true)
    })

    await vi.waitFor(() => {
      // @example
      expect(forcedStopSettled).toBe(true)
    })
    // @example
    expect(serveMocks.closeCall).toHaveBeenCalledTimes(2)

    const replacementStart = server.start()
    await vi.waitFor(() => {
      // @example
      expect(serveMocks.serveCall).toHaveBeenCalledTimes(2)
    })
    serveMocks.resolveServe()
    // @example
    await expect(replacementStart).resolves.toBeUndefined()

    resolveGracefulClose()
    // @example
    await expect(Promise.all([gracefulStop, forcedStop])).resolves.toEqual([undefined, undefined])
  })

  /**
   * @example
   * it('aggregates graceful and forced close failures without skipping force cleanup', async () => {})
   */
  it('aggregates graceful and forced close failures without skipping force cleanup (Discord audit N-001)', async () => {
    const gracefulError = new Error('synthetic graceful close failure')
    const forceError = new Error('synthetic force close failure')
    serveMocks.closeCall.mockImplementation(async (closeActiveConnections) => {
      throw closeActiveConnections ? forceError : gracefulError
    })
    const server = createServer({ hostname: '127.0.0.1', port: 6121 })
    const startTask = server.start()
    serveMocks.resolveServe()
    await startTask

    // @example
    await expect(server.stop(false)).rejects.toEqual(expect.objectContaining({
      errors: [gracefulError, forceError],
      message: 'Multiple server shutdown operations failed.',
    }))
    // @example
    expect(serveMocks.closeCall).toHaveBeenNthCalledWith(1, false)
    // @example
    expect(serveMocks.closeCall).toHaveBeenNthCalledWith(2, true)
    // @example
    expect(serveMocks.disposeCall).toHaveBeenCalledTimes(1)
    // @example
    expect(logMocks.withError).toHaveBeenCalledWith(gracefulError)
    // @example
    expect(logMocks.withError).toHaveBeenCalledWith(forceError)
  })

  /**
   * @example
   * it('continues transport cleanup when application disposal throws', async () => {})
   */
  it('continues transport cleanup when application disposal throws (Discord audit N-001)', async () => {
    const disposeError = new Error('synthetic application dispose failure')
    const transportError = new Error('synthetic transport close failure')
    serveMocks.disposeCall.mockImplementationOnce(() => {
      throw disposeError
    })
    serveMocks.closeCall.mockRejectedValueOnce(transportError)
    const server = createServer({ hostname: '127.0.0.1', port: 6121 })
    const startTask = server.start()
    serveMocks.resolveServe()
    await startTask

    // @example
    await expect(server.stop(true)).rejects.toEqual(expect.objectContaining({
      errors: [disposeError, transportError],
    }))
    // @example
    expect(serveMocks.disposeCall).toHaveBeenCalledTimes(1)
    // @example
    expect(serveMocks.closeCall).toHaveBeenCalledWith(true)
  })

  it('treats EADDRINUSE as an existing listener instead of failing startup', async () => {
    const server = createServer({ hostname: '127.0.0.1', port: 6121 })

    const startTask = server.start()
    const error = new Error('listen EADDRINUSE: address already in use 127.0.0.1:6121') as NodeJS.ErrnoException
    error.code = 'EADDRINUSE'
    serveMocks.rejectServe(error)

    await expect(startTask).resolves.toBeUndefined()
    expect(serveMocks.disposeCall).toHaveBeenCalledTimes(1)
    expect(serveMocks.closeCall).toHaveBeenCalledWith(true)
  })

  it('merges nested config updates instead of replacing sibling logger settings', async () => {
    const server = createServer({
      hostname: '127.0.0.1',
      port: 6121,
      logger: {
        app: { level: LogLevelString.Log },
        websocket: { format: Format.Pretty },
      },
    })

    server.updateConfig({
      logger: {
        app: { format: Format.Pretty },
      },
    })

    const startTask = server.start()
    serveMocks.resolveServe()
    await startTask

    expect(serveMocks.setupAppCall).toHaveBeenCalledWith(expect.objectContaining({
      logger: {
        app: {
          level: LogLevelString.Log,
          format: Format.Pretty,
        },
        websocket: {
          format: Format.Pretty,
        },
      },
    }))
  })

  /**
   * @example
   * it('caps websocket messages before application parsing', async () => {})
   */
  it('caps websocket messages before application parsing', async () => {
    const server = createServer({ hostname: '127.0.0.1', port: 6121 })

    const startTask = server.start()
    serveMocks.resolveServe()
    await startTask

    // @example
    expect(serveMocks.createServerCall).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ gracefulShutdown: false }),
    )

    // @example
    expect(serveMocks.websocketPluginCall).toHaveBeenCalledWith(expect.objectContaining({
      options: {
        node: {
          serverOptions: {
            maxPayload: 8 * 1024 * 1024,
            perMessageDeflate: false,
          },
        },
      },
    }))
  })

  /**
   * @example
   * Restart diagnostics expose only a non-secret server summary.
   */
  it('does not log pairing or module credentials during restart (Discord audit D-001)', async () => {
    // ROOT CAUSE:
    //
    // Restart logging passed the complete ServerOptions object to the logger,
    // including both the shared pairing token and one-time module credentials.
    // The logger now receives only explicit non-secret summary fields.
    const server = createServer({
      auth: {
        moduleCredentials: [{
          capabilities: { emit: ['input:text'] },
          module: {
            identity: {
              id: 'synthetic-module-instance',
              kind: 'plugin',
              plugin: { id: 'synthetic-module' },
            },
            name: 'synthetic-module',
          },
          token: 'synthetic-module-secret-sentinel',
        }],
        token: 'synthetic-pairing-secret-sentinel',
      },
      hostname: '127.0.0.1',
      port: 6121,
    })

    const restartTask = server.restart()
    await vi.waitFor(() => expect(serveMocks.serveCall).toHaveBeenCalledTimes(1))
    serveMocks.resolveServe()
    await restartTask
    const logged = JSON.stringify({
      fields: logMocks.withFields.mock.calls,
      messages: logMocks.log.mock.calls,
    })

    // @example
    expect(logged).not.toContain('synthetic-pairing-secret-sentinel')
    // @example
    expect(logged).not.toContain('synthetic-module-secret-sentinel')
    // @example
    expect(logMocks.withFields).toHaveBeenCalledWith(expect.objectContaining({
      authenticationConfigured: true,
      moduleCredentialCount: 1,
    }))
  })
})
