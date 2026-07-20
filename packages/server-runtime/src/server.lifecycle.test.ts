import { describe, expect, it } from 'vitest'

import { createServer } from './server'

type ShutdownSignal = 'SIGINT' | 'SIGTERM'

function removeListenersAddedAfter(
  signal: ShutdownSignal,
  baseline: Set<NodeJS.SignalsListener>,
) {
  for (const listener of process.listeners(signal)) {
    if (!baseline.has(listener))
      process.off(signal, listener)
  }
}

/**
 * @example
 * describe('server lifecycle signal ownership', () => {})
 */
describe('server lifecycle signal ownership', () => {
  /**
   * @example
   * it('keeps process signal listeners at baseline', async () => {})
   */
  it('keeps process signal listeners at baseline across programmatic servers (Discord audit N-001)', async () => {
    // ROOT CAUSE:
    //
    // Programmatic createServer().start() explicitly enabled srvx gracefulShutdown.
    // Every srvx instance registered SIGINT and SIGTERM handlers, while close()
    // never removed them. Repeated start/stop cycles therefore retained process
    // listeners even though the owning server instances were already stopped.
    //
    // Before the fix, twelve start/restart cycles leave twenty-four new
    // handlers per signal and emit MaxListenersExceededWarning. Programmatic
    // servers now disable srvx signal ownership; only the CLI lifecycle owns
    // process-level shutdown.
    const baselineSigintListeners = new Set(process.listeners('SIGINT'))
    const baselineSigtermListeners = new Set(process.listeners('SIGTERM'))

    try {
      for (let index = 0; index < 12; index++) {
        const server = createServer({ hostname: '127.0.0.1', port: 0 })
        await server.start()
        await server.restart()
        await server.stop()
      }

      // @example
      expect(process.listenerCount('SIGINT')).toBe(baselineSigintListeners.size)
      // @example
      expect(process.listenerCount('SIGTERM')).toBe(baselineSigtermListeners.size)
    }
    finally {
      // The failing-before run must not poison unrelated Vitest files with the
      // exact leaked handlers that this regression is designed to expose.
      removeListenersAddedAfter('SIGINT', baselineSigintListeners)
      removeListenersAddedAfter('SIGTERM', baselineSigtermListeners)
    }
  })
})
