import type { Server } from '../server'
import type { ServerProcessHost, ServerProcessSignal } from './processLifecycle'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { ServerProcessLifecycle } from './processLifecycle'

class SyntheticProcessHost implements ServerProcessHost {
  private readonly listeners = new Map<ServerProcessSignal, Set<() => void>>()

  readonly exit = vi.fn((_code: number) => {})

  emit(signal: ServerProcessSignal) {
    for (const listener of this.listeners.get(signal) ?? [])
      listener()
  }

  listenerCount(signal: ServerProcessSignal) {
    return this.listeners.get(signal)?.size ?? 0
  }

  off(signal: ServerProcessSignal, listener: () => void) {
    this.listeners.get(signal)?.delete(listener)
  }

  on(signal: ServerProcessSignal, listener: () => void) {
    const listeners = this.listeners.get(signal) ?? new Set()
    listeners.add(listener)
    this.listeners.set(signal, listeners)
  }
}

/**
 * @example
 * describe('ServerProcessLifecycle', () => {})
 */
describe('server process lifecycle', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  /**
   * @example
   * it('owns and releases CLI signal listeners', async () => {})
   */
  it('owns and releases CLI signal listeners after graceful shutdown (Discord audit N-001)', async () => {
    // ROOT CAUSE:
    //
    // The executable and every embedded srvx instance both owned process
    // signals. The CLI now has one explicit owner, while createServer only
    // owns network start/stop/restart lifecycle.
    const host = new SyntheticProcessHost()
    const server: Pick<Server, 'start' | 'stop'> = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
    }
    const lifecycle = new ServerProcessLifecycle(server, host)

    await lifecycle.start()

    // @example
    expect(host.listenerCount('SIGINT')).toBe(1)
    // @example
    expect(host.listenerCount('SIGTERM')).toBe(1)

    host.emit('SIGTERM')
    await vi.waitFor(() => {
      // @example
      expect(server.stop).toHaveBeenCalledWith(false)
    })

    // @example
    expect(host.exit).toHaveBeenCalledWith(0)
    // @example
    expect(host.listenerCount('SIGINT')).toBe(0)
    // @example
    expect(host.listenerCount('SIGTERM')).toBe(0)
  })

  /**
   * @example
   * it('forces active connections closed after the graceful deadline', async () => {})
   */
  it('forces active connections closed after a bounded graceful deadline (Discord audit N-001)', async () => {
    vi.useFakeTimers()
    let resolveGraceful: () => void = () => {}
    const gracefulStop = new Promise<void>((resolve) => {
      resolveGraceful = resolve
    })
    const host = new SyntheticProcessHost()
    const server: Pick<Server, 'start' | 'stop'> = {
      start: vi.fn(async () => {}),
      stop: vi.fn((closeActiveConnections = true) => closeActiveConnections
        ? Promise.resolve()
        : gracefulStop),
    }
    const lifecycle = new ServerProcessLifecycle(server, host, { gracefulTimeoutMs: 500 })

    await lifecycle.start()
    host.emit('SIGINT')
    await vi.advanceTimersByTimeAsync(500)

    // @example
    expect(server.stop).toHaveBeenNthCalledWith(1, false)
    // @example
    expect(server.stop).toHaveBeenNthCalledWith(2, true)
    // @example
    expect(host.exit).toHaveBeenCalledWith(0)
    // @example
    expect(host.listenerCount('SIGINT')).toBe(0)
    // @example
    expect(host.listenerCount('SIGTERM')).toBe(0)

    resolveGraceful()
    await lifecycle.shutdown()
  })

  /**
   * @example
   * it('forces active connections closed on a repeated signal', async () => {})
   */
  it('forces active connections closed when shutdown receives a second signal (Discord audit N-001)', async () => {
    let resolveGraceful: () => void = () => {}
    const gracefulStop = new Promise<void>((resolve) => {
      resolveGraceful = resolve
    })
    const host = new SyntheticProcessHost()
    const server: Pick<Server, 'start' | 'stop'> = {
      start: vi.fn(async () => {}),
      stop: vi.fn((closeActiveConnections = true) => closeActiveConnections
        ? Promise.resolve()
        : gracefulStop),
    }
    const lifecycle = new ServerProcessLifecycle(server, host)

    await lifecycle.start()
    host.emit('SIGINT')
    host.emit('SIGINT')

    await vi.waitFor(() => {
      // @example
      expect(server.stop).toHaveBeenCalledTimes(2)
    })
    // @example
    expect(server.stop).toHaveBeenNthCalledWith(1, false)
    // @example
    expect(server.stop).toHaveBeenNthCalledWith(2, true)
    // @example
    expect(host.exit).toHaveBeenCalledWith(0)

    resolveGraceful()
    await lifecycle.shutdown()
  })

  /**
   * @example
   * it('releases signal ownership when server startup fails', async () => {})
   */
  it('releases signal ownership when server startup fails (Discord audit N-001)', async () => {
    const host = new SyntheticProcessHost()
    const server: Pick<Server, 'start' | 'stop'> = {
      start: vi.fn(async () => {
        throw new Error('synthetic bind failure')
      }),
      stop: vi.fn(async () => {}),
    }
    const lifecycle = new ServerProcessLifecycle(server, host)

    // @example
    await expect(lifecycle.start()).rejects.toThrow('synthetic bind failure')
    // @example
    expect(host.listenerCount('SIGINT')).toBe(0)
    // @example
    expect(host.listenerCount('SIGTERM')).toBe(0)
    // @example
    expect(host.exit).not.toHaveBeenCalled()
  })

  /**
   * @example
   * it('forces remaining cleanup and reports a graceful-close failure', async () => {})
   */
  it('forces remaining cleanup and reports a graceful-close failure (Discord audit N-001)', async () => {
    const host = new SyntheticProcessHost()
    const onError = vi.fn()
    const server: Pick<Server, 'start' | 'stop'> = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async (closeActiveConnections = true) => {
        if (!closeActiveConnections)
          throw new Error('synthetic graceful close failure')
      }),
    }
    const lifecycle = new ServerProcessLifecycle(server, host, { onError })

    await lifecycle.start()
    host.emit('SIGTERM')

    await vi.waitFor(() => {
      // @example
      expect(server.stop).toHaveBeenCalledTimes(2)
    })
    // @example
    expect(server.stop).toHaveBeenNthCalledWith(1, false)
    // @example
    expect(server.stop).toHaveBeenNthCalledWith(2, true)
    // @example
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      message: 'synthetic graceful close failure',
    }))
    // @example
    expect(host.exit).toHaveBeenCalledWith(1)
    // @example
    expect(host.listenerCount('SIGINT')).toBe(0)
    // @example
    expect(host.listenerCount('SIGTERM')).toBe(0)
  })

  /**
   * @example
   * it('continues forced cleanup when the error observer throws', async () => {})
   */
  it('continues forced cleanup when the error observer throws (Discord audit N-001)', async () => {
    // ROOT CAUSE:
    //
    // onError ran inline before forced cleanup. If structured observation
    // itself threw, runGracefulShutdown rejected immediately, skipped stop(true)
    // and exit, and retained both process listeners. Observation failures now
    // propagate only after the remaining lifecycle cleanup has completed.
    const host = new SyntheticProcessHost()
    const closeError = new Error('synthetic graceful close failure')
    const observerError = new Error('synthetic shutdown observer failure')
    const onError = vi.fn(() => {
      throw observerError
    })
    const server: Pick<Server, 'start' | 'stop'> = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async (closeActiveConnections = true) => {
        if (!closeActiveConnections)
          throw closeError
      }),
    }
    const lifecycle = new ServerProcessLifecycle(server, host, { onError })

    await lifecycle.start()

    // @example
    await expect(lifecycle.shutdown()).rejects.toEqual(expect.objectContaining({
      errors: [closeError, observerError],
      message: 'Server shutdown error observation failed.',
    }))
    // @example
    expect(server.stop).toHaveBeenNthCalledWith(1, false)
    // @example
    expect(server.stop).toHaveBeenNthCalledWith(2, true)
    // @example
    expect(host.exit).toHaveBeenCalledWith(1)
    // @example
    expect(host.listenerCount('SIGINT')).toBe(0)
    // @example
    expect(host.listenerCount('SIGTERM')).toBe(0)
  })

  /**
   * @example
   * it('observes force-timeout rejection without retaining listeners', async () => {})
   */
  it('observes force-timeout rejection without retaining listeners (Discord audit N-001)', async () => {
    // ROOT CAUSE:
    //
    // The graceful deadline launched forceShutdown with an unobserved `void`
    // promise. If forced close and its observer both threw, the rejection was
    // unhandled and finish never detached listeners. Timer-owned force now uses
    // the same terminal observation path as a second process signal.
    vi.useFakeTimers()
    const host = new SyntheticProcessHost()
    const onError = vi.fn(() => {
      throw new Error('synthetic forced-close observer failure')
    })
    const server: Pick<Server, 'start' | 'stop'> = {
      start: vi.fn(async () => {}),
      stop: vi.fn((closeActiveConnections = true) => closeActiveConnections
        ? Promise.reject(new Error('synthetic forced close failure'))
        : new Promise<void>(() => {})),
    }
    const lifecycle = new ServerProcessLifecycle(server, host, {
      gracefulTimeoutMs: 500,
      onError,
    })

    await lifecycle.start()
    void lifecycle.shutdown()
    await vi.advanceTimersByTimeAsync(500)

    // @example
    expect(server.stop).toHaveBeenNthCalledWith(1, false)
    // @example
    expect(server.stop).toHaveBeenNthCalledWith(2, true)
    // @example
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      message: 'synthetic forced close failure',
    }))
    // @example
    expect(host.exit).toHaveBeenCalledWith(1)
    // @example
    expect(host.listenerCount('SIGINT')).toBe(0)
    // @example
    expect(host.listenerCount('SIGTERM')).toBe(0)
  })
})
