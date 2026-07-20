import type { MessagePortMain } from 'electron'

import { describe, expect, it, vi } from 'vitest'

import { createDiscordBridgeWorkerLifecycle } from './worker'

/**
 * @example
 * describe('discord bridge worker lifecycle', () => {})
 */
describe('discord bridge worker lifecycle', () => {
  /**
   * @example
   * it('closes a pending bootstrap port during shutdown for Discord audit D-021', async () => {})
   */
  it('closes a pending bootstrap port during shutdown for Discord audit D-021', async () => {
    // ROOT CAUSE:
    //
    // The pre-message bootstrap port/listener had no lifecycle owner. Shutdown
    // without a delivered bootstrap therefore returned while both remained live.
    const lifecycle = createDiscordBridgeWorkerLifecycle({ onError: vi.fn() })
    const close = vi.fn()
    const removeListener = vi.fn()
    const port = {
      close,
      once: vi.fn(() => port),
      removeListener,
      start: vi.fn(),
    }
    // NOTICE:
    // Electron's MessagePortMain fluent methods return the full native object,
    // which a synthetic structural port cannot implement without Electron.
    // Source/context: Electron MessagePortMain `once()` return type.
    // Remove this assertion if Electron exposes a side-effect-free port interface.
    lifecycle.acceptBootstrap(port as unknown as MessagePortMain)

    // @example
    await expect(lifecycle.shutdown()).resolves.toBe(0)
    // @example
    expect(removeListener).toHaveBeenCalledOnce()
    // @example
    expect(close).toHaveBeenCalledOnce()
  })

  /**
   * @example
   * it('detaches the exact bootstrap listener when port start fails for Discord audit D-021', async () => {})
   */
  it('detaches the exact bootstrap listener when port start fails for Discord audit D-021', async () => {
    // ROOT CAUSE:
    //
    // The bootstrap failure path closed a port after `start()` threw, but it
    // did not detach the exact listener already installed by `once()`. Relying
    // on native close side effects left listener ownership implicit and made a
    // synthetic or alternate port retain the callback after failure.
    const onError = vi.fn()
    const lifecycle = createDiscordBridgeWorkerLifecycle({ onError })
    const close = vi.fn()
    const removeListener = vi.fn()
    let installedListener: ((event: { data: unknown }) => void) | undefined
    const port = {
      close,
      once: vi.fn((_event: 'message', listener: (event: { data: unknown }) => void) => {
        installedListener = listener
        return port
      }),
      removeListener,
      start: vi.fn(() => {
        throw new Error('SYNTHETIC_PRIVATE_PORT_START_DETAIL')
      }),
    }
    // NOTICE:
    // Electron's MessagePortMain fluent methods return the full native object,
    // which a synthetic structural port cannot implement without Electron.
    // Source/context: Electron MessagePortMain `once()` return type.
    // Remove this assertion if Electron exposes a side-effect-free port interface.
    lifecycle.acceptBootstrap(port as unknown as MessagePortMain)

    // @example
    expect(removeListener).toHaveBeenCalledOnce()
    // @example
    expect(removeListener).toHaveBeenCalledWith('message', installedListener)
    // @example
    expect(close).toHaveBeenCalledOnce()
    // @example
    expect(onError).toHaveBeenCalledWith('bootstrap', 'Error')
    // @example
    await expect(lifecycle.shutdown()).resolves.toBe(1)
  })

  /**
   * @example
   * it('drains bootstrap start before shutdown can report completion for Discord audit D-021', async () => {})
   */
  it('drains bootstrap start before shutdown can report completion for Discord audit D-021', async () => {
    // ROOT CAUSE:
    //
    // Bootstrap scheduled `owner.start()` in an untracked microtask. A same-tick
    // shutdown could call stop and resolve first; the old owner then started and
    // applied the queued policy after its lifecycle had already ended.
    //
    // Before: the trace was stop -> start -> policy and shutdown resolved early.
    // After: start is registered first, stop invalidates policy, shutdown drains
    // actual settlement, and a final exact-owner stop closes late start effects.
    let releaseStart = () => {}
    const trace: string[] = []
    const start = vi.fn(() => {
      trace.push('start')
      return new Promise<void>((resolve) => {
        releaseStart = resolve
      })
    })
    const applyRuntimeConfig = vi.fn(async () => {
      trace.push('policy')
    })
    const stop = vi.fn(async () => {
      trace.push('stop')
    })
    const lifecycle = createDiscordBridgeWorkerLifecycle({
      createAdapter: () => ({ applyRuntimeConfig, start, stop }),
      onError: vi.fn(),
    })
    let messageListener: ((event: { data: unknown }) => void) | undefined
    const port = {
      close: vi.fn(),
      once: vi.fn((_event: 'message', listener: (event: { data: unknown }) => void) => {
        messageListener = listener
        return port
      }),
      start: vi.fn(),
    }
    // NOTICE:
    // Electron's MessagePortMain fluent methods return the full native object,
    // which a synthetic structural port cannot implement without Electron.
    // Source/context: Electron MessagePortMain `once()` return type.
    // Remove this assertion if Electron exposes a side-effect-free port interface.
    lifecycle.acceptBootstrap(port as unknown as MessagePortMain)
    messageListener?.({
      data: {
        type: 'discord-bridge:bootstrap',
        airiUrl: 'ws://127.0.0.1:47270/ws',
        discordToken: 'synthetic-worker-start-token',
        moduleCredential: 'synthetic-worker-start-module-credential',
        moduleIdentity: {
          id: 'discord-utility-process',
          kind: 'plugin',
          plugin: { id: 'discord' },
        },
      },
    })
    lifecycle.applyPolicy({
      adminRoleIds: [],
      allowDirectMessages: false,
      allowedChannelIds: ['synthetic-channel'],
      auditLogEnabled: true,
      enabled: true,
      memoryConsentRequired: true,
      messagePacingMs: 600,
      privacyNoticeEnabled: true,
      privacyNoticeText: 'Synthetic disclosure',
      rateLimitMaxMessages: 6,
      rateLimitWindowMs: 30_000,
    })

    let shutdownResolved = false
    const shuttingDown = lifecycle.shutdown().then((code) => {
      shutdownResolved = true
      return code
    })
    await Promise.resolve()
    await Promise.resolve()

    // @example
    expect(trace).toEqual(['start', 'stop'])
    // @example
    expect(applyRuntimeConfig).not.toHaveBeenCalled()
    // @example
    expect(shutdownResolved).toBe(false)

    releaseStart()
    // @example
    await expect(shuttingDown).resolves.toBe(0)
    // @example
    expect(stop).toHaveBeenCalledTimes(2)
    // @example
    expect(applyRuntimeConfig).not.toHaveBeenCalled()
  })

  /**
   * @example
   * it('drains an in-flight policy before the final owner stop for Discord audit D-021', async () => {})
   */
  it('drains an in-flight policy before the final owner stop for Discord audit D-021', async () => {
    // ROOT CAUSE:
    //
    // Policy promises were fire-and-forget. Shutdown stopped once and returned
    // without waiting for a non-cooperative configuration boundary to settle.
    let releasePolicy = () => {}
    const trace: string[] = []
    const applyRuntimeConfig = vi.fn(() => {
      trace.push('policy')
      return new Promise<void>((resolve) => {
        releasePolicy = resolve
      })
    })
    const stop = vi.fn(async () => {
      trace.push('stop')
    })
    const lifecycle = createDiscordBridgeWorkerLifecycle({
      createAdapter: () => ({
        applyRuntimeConfig,
        start: vi.fn(async () => {
          trace.push('start')
        }),
        stop,
      }),
      onError: vi.fn(),
    })
    let messageListener: ((event: { data: unknown }) => void) | undefined
    const port = {
      close: vi.fn(),
      once: vi.fn((_event: 'message', listener: (event: { data: unknown }) => void) => {
        messageListener = listener
        return port
      }),
      start: vi.fn(),
    }
    // NOTICE:
    // Electron's MessagePortMain fluent methods return the full native object,
    // which a synthetic structural port cannot implement without Electron.
    // Source/context: Electron MessagePortMain `once()` return type.
    // Remove this assertion if Electron exposes a side-effect-free port interface.
    lifecycle.acceptBootstrap(port as unknown as MessagePortMain)
    messageListener?.({
      data: {
        type: 'discord-bridge:bootstrap',
        airiUrl: 'ws://127.0.0.1:47270/ws',
        discordToken: 'synthetic-worker-policy-token',
        moduleCredential: 'synthetic-worker-policy-module-credential',
        moduleIdentity: {
          id: 'discord-utility-process',
          kind: 'plugin',
          plugin: { id: 'discord' },
        },
      },
    })
    await Promise.resolve()
    await Promise.resolve()
    lifecycle.applyPolicy({
      adminRoleIds: [],
      allowDirectMessages: false,
      allowedChannelIds: ['synthetic-channel'],
      auditLogEnabled: true,
      enabled: true,
      memoryConsentRequired: true,
      messagePacingMs: 600,
      privacyNoticeEnabled: true,
      privacyNoticeText: 'Synthetic disclosure',
      rateLimitMaxMessages: 6,
      rateLimitWindowMs: 30_000,
    })
    await vi.waitFor(() => {
      // @example
      expect(applyRuntimeConfig).toHaveBeenCalledOnce()
    })

    let shutdownResolved = false
    const shuttingDown = lifecycle.shutdown().then((code) => {
      shutdownResolved = true
      return code
    })
    await Promise.resolve()
    await Promise.resolve()

    // @example
    expect(shutdownResolved).toBe(false)
    // @example
    expect(trace).toEqual(['start', 'policy', 'stop'])

    releasePolicy()
    // @example
    await expect(shuttingDown).resolves.toBe(0)
    // @example
    expect(stop).toHaveBeenCalledTimes(2)
    // @example
    expect(applyRuntimeConfig).toHaveBeenCalledOnce()
  })

  /**
   * @example
   * it('single-flights normal shutdown and stops an already-settled owner once for Discord audit D-021', async () => {})
   */
  it('single-flights normal shutdown and stops an already-settled owner once for Discord audit D-021', async () => {
    const stop = vi.fn(async () => {})
    const start = vi.fn(async () => {})
    const lifecycle = createDiscordBridgeWorkerLifecycle({
      createAdapter: () => ({
        applyRuntimeConfig: vi.fn(async () => {}),
        start,
        stop,
      }),
      onError: vi.fn(),
    })
    let messageListener: ((event: { data: unknown }) => void) | undefined
    const port = {
      close: vi.fn(),
      once: vi.fn((_event: 'message', listener: (event: { data: unknown }) => void) => {
        messageListener = listener
        return port
      }),
      start: vi.fn(),
    }
    // NOTICE:
    // Electron's MessagePortMain fluent methods return the full native object,
    // which a synthetic structural port cannot implement without Electron.
    // Source/context: Electron MessagePortMain `once()` return type.
    // Remove this assertion if Electron exposes a side-effect-free port interface.
    lifecycle.acceptBootstrap(port as unknown as MessagePortMain)
    messageListener?.({
      data: {
        type: 'discord-bridge:bootstrap',
        airiUrl: 'ws://127.0.0.1:47270/ws',
        discordToken: 'synthetic-worker-normal-token',
        moduleCredential: 'synthetic-worker-normal-module-credential',
        moduleIdentity: {
          id: 'discord-utility-process',
          kind: 'plugin',
          plugin: { id: 'discord' },
        },
      },
    })
    await vi.waitFor(() => {
      // @example
      expect(start).toHaveBeenCalledOnce()
    })
    await Promise.resolve()
    await Promise.resolve()

    const firstShutdown = lifecycle.shutdown()
    const secondShutdown = lifecycle.shutdown()

    // @example
    expect(firstShutdown).toBe(secondShutdown)
    // @example
    await expect(firstShutdown).resolves.toBe(0)
    // @example
    expect(stop).toHaveBeenCalledOnce()
  })

  /**
   * @example
   * it('returns exit code 1 when adapter shutdown fails for Discord audit D-021', async () => {})
   */
  it('returns exit code 1 when adapter shutdown fails for Discord audit D-021', async () => {
    // ROOT CAUSE:
    //
    // The utility signal handler called `process.exit(0)` from a `finally`
    // block. An adapter stop rejection was therefore reported as successful
    // shutdown and the real cleanup failure had no structured observer.
    //
    // Before: every shutdown path exited 0.
    // After: the lifecycle returns 1 after recording a sanitized error class;
    // only the process entrypoint owns the actual `process.exit` call.
    const stop = vi.fn(async () => {
      throw new Error('SYNTHETIC_PRIVATE_SHUTDOWN_DETAIL')
    })
    const onError = vi.fn()
    const lifecycle = createDiscordBridgeWorkerLifecycle({
      createAdapter: () => ({
        applyRuntimeConfig: vi.fn(async () => {}),
        start: vi.fn(async () => {}),
        stop,
      }),
      onError,
    })
    let messageListener: ((event: { data: unknown }) => void) | undefined
    const port = {
      close: vi.fn(),
      once: vi.fn((_event: 'message', listener: (event: { data: unknown }) => void) => {
        messageListener = listener
        return port
      }),
      start: vi.fn(),
    }

    // NOTICE:
    // Electron's MessagePortMain fluent methods return the full native object,
    // which a synthetic structural port cannot implement without Electron.
    // Source/context: Electron MessagePortMain `once()` return type.
    // Remove this assertion if Electron exposes a side-effect-free port interface.
    lifecycle.acceptBootstrap(port as unknown as MessagePortMain)
    messageListener?.({
      data: {
        type: 'discord-bridge:bootstrap',
        airiUrl: 'ws://127.0.0.1:47270/ws',
        discordToken: 'synthetic-worker-token',
        moduleCredential: 'synthetic-worker-module-credential',
        moduleIdentity: {
          id: 'discord-utility-process',
          kind: 'plugin',
          plugin: { id: 'discord' },
        },
      },
    })
    await Promise.resolve()

    const exitCode = await lifecycle.shutdown()

    // @example
    expect(exitCode).toBe(1)
    // @example
    expect(stop).toHaveBeenCalledOnce()
    // @example
    expect(onError).toHaveBeenCalledWith('shutdown', 'Error')
    // @example
    expect(JSON.stringify(onError.mock.calls)).not.toContain('PRIVATE_SHUTDOWN_DETAIL')
  })
})
