import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { createDiscordBridgeManager, setupDiscordBridgeService } from './index'

type ConfigureHandler = (request: unknown, options: unknown) => unknown

const mainBoundaryMocks = vi.hoisted(() => ({
  bootstrapMessages: [] as unknown[],
  configureHandler: undefined as ConfigureHandler | undefined,
  dispose: vi.fn(),
  utilityFork: vi.fn(),
}))

function configuredHandler(): ConfigureHandler {
  const handler = mainBoundaryMocks.configureHandler
  if (!handler)
    throw new Error('Expected the protected Discord configuration handler.')
  return handler
}

vi.mock('@moeru/eventa', () => ({
  defineInvokeHandler: (_context: unknown, _contract: unknown, handler: ConfigureHandler) => {
    mainBoundaryMocks.configureHandler = handler
  },
}))

vi.mock('@moeru/eventa/adapters/electron/main', () => ({
  createContext: () => ({ context: {}, dispose: mainBoundaryMocks.dispose }),
}))

vi.mock('../../../../shared/eventa', () => ({
  electronConfigureDiscordBridge: {},
}))

vi.mock('electron', () => ({
  ipcMain: {},
  MessageChannelMain: class {
    port1 = { close: vi.fn() }
    port2 = {
      close: vi.fn(),
      postMessage: (message: unknown) => mainBoundaryMocks.bootstrapMessages.push(message),
    }
  },
  utilityProcess: { fork: mainBoundaryMocks.utilityFork },
}))

/**
 * @example
 * describe('discord bridge utility process manager', () => {})
 */
describe('discord bridge utility process manager', () => {
  /**
   * @example
   * it('transfers secrets once without placing them in process arguments environment or logs (Discord audit D-001)', async () => {})
   */
  it('transfers secrets once without placing them in process arguments environment or logs (Discord audit D-001)', async () => {
    // ROOT CAUSE:
    //
    // The legacy launcher copied credentials through files and process
    // environment, while Stage also sent the Discord token over the generic
    // websocket configuration channel. Those transports are observable by
    // unrelated processes, module inspectors, and diagnostic tooling.
    //
    // Before: secrets appeared in launcher environment and `ui:configure`.
    // After: Electron Main sends them once through a transferred MessagePort and
    // closes that port; process metadata and logs contain no secret values.
    const discordToken = 'synthetic-discord-bot-token'
    const moduleCredential = 'synthetic-discord-module-token'
    const sttApiKey = 'synthetic-protected-stt-key'
    const childPostMessage = vi.fn()
    let exitListener: ((code: number) => void) | undefined
    const childKill = vi.fn(() => {
      exitListener?.(0)
      return true
    })
    const portClose = vi.fn()
    const portPostMessage = vi.fn()
    const fork = vi.fn(() => ({
      kill: childKill,
      once(event: 'spawn' | 'exit', listener: (() => void) | ((code: number) => void)) {
        if (event === 'spawn')
          (listener as () => void)()
        else
          exitListener = listener as (code: number) => void
        return this
      },
      postMessage: childPostMessage,
    }))
    const transferredPort = { close: vi.fn() }
    const sendingPort = {
      close: portClose,
      postMessage: portPostMessage,
    }
    const log = vi.fn()
    const manager = createDiscordBridgeManager({
      bootstrap: {
        airiUrl: 'ws://127.0.0.1:47270/ws',
        discordToken,
        moduleCredential,
        moduleIdentity: {
          id: 'discord-utility-process',
          kind: 'plugin',
          plugin: { id: 'discord' },
        },
        transcription: {
          apiKey: sttApiKey,
          baseURL: 'https://speech.example/v1',
          model: 'synthetic-stt-model',
        },
      },
      createMessageChannel: () => ({
        port1: transferredPort,
        port2: sendingPort,
      }),
      entryPath: join('synthetic', 'app', 'out', 'main', 'discord-bridge.js'),
      fork,
      log,
      runtimeEnvironment: {
        DISCORD_TOKEN: discordToken,
        AIRI_TOKEN: moduleCredential,
        NODE_ENV: 'test',
        OPENAI_STT_API_KEY: sttApiKey,
      },
    })

    await manager.start()

    // @example
    expect(fork).toHaveBeenCalledTimes(1)
    const serializedForkCall = JSON.stringify(fork.mock.calls[0])
    // @example
    expect(serializedForkCall).not.toContain(discordToken)
    // @example
    expect(serializedForkCall).not.toContain(moduleCredential)
    // @example
    expect(serializedForkCall).not.toContain(sttApiKey)
    // @example
    expect(childPostMessage).toHaveBeenCalledWith({ type: 'discord-bridge:bootstrap-port' }, [transferredPort])
    // @example
    expect(portPostMessage).toHaveBeenCalledOnce()
    // @example
    expect(portPostMessage).toHaveBeenCalledWith({
      type: 'discord-bridge:bootstrap',
      airiUrl: 'ws://127.0.0.1:47270/ws',
      discordToken,
      moduleCredential,
      moduleIdentity: {
        id: 'discord-utility-process',
        kind: 'plugin',
        plugin: { id: 'discord' },
      },
      transcription: {
        apiKey: sttApiKey,
        baseURL: 'https://speech.example/v1',
        model: 'synthetic-stt-model',
      },
    })
    // @example
    expect(portClose).toHaveBeenCalledOnce()
    // @example
    expect(JSON.stringify(log.mock.calls)).not.toContain(discordToken)
    // @example
    expect(JSON.stringify(log.mock.calls)).not.toContain(moduleCredential)
    // @example
    expect(JSON.stringify(log.mock.calls)).not.toContain(sttApiKey)
    // @example
    expect(manager.isRunning()).toBe(true)

    await manager.stop()

    // @example
    expect(childKill).toHaveBeenCalledOnce()
    // @example
    expect(manager.isRunning()).toBe(false)
  })

  /**
   * @example
   * An unexpected utility exit clears lifecycle state so the same manager can restart safely.
   */
  it('clears crashed utility state before a later restart (Discord audit D-004)', async () => {
    // ROOT CAUSE:
    //
    // The original manager retained a child reference after `exit`, so policy
    // updates treated a crashed process as running and never restarted it.
    // Exit now settles lifecycle state before the next start.
    const exitListeners: ((code: number) => void)[] = []
    const fork = vi.fn(() => ({
      kill: () => {
        exitListeners.at(-1)?.(0)
        return true
      },
      once(event: 'spawn' | 'exit', listener: (() => void) | ((code: number) => void)) {
        if (event === 'spawn')
          (listener as () => void)()
        else
          exitListeners.push(listener as (code: number) => void)
        return this
      },
      postMessage: vi.fn(),
    }))
    const manager = createDiscordBridgeManager({
      bootstrap: {
        airiUrl: 'wss://127.0.0.1:47270/ws',
        discordToken: 'synthetic-discord-token',
        moduleCredential: 'synthetic-module-credential',
        moduleIdentity: {
          id: 'discord-utility-process',
          kind: 'plugin',
          plugin: { id: 'discord' },
        },
      },
      createMessageChannel: () => ({
        port1: { close: vi.fn() },
        port2: { close: vi.fn(), postMessage: vi.fn() },
      }),
      entryPath: join('synthetic', 'app', 'out', 'main', 'discord-bridge.js'),
      fork,
    })

    await manager.start()
    exitListeners[0]?.(1)

    // @example
    expect(manager.isRunning()).toBe(false)

    await manager.start()

    // @example
    expect(fork).toHaveBeenCalledTimes(2)
    // @example
    expect(manager.isRunning()).toBe(true)
    await manager.stop()
  })

  /**
   * @example
   * it('kills a pending child before waiting for spawn for Discord audit D-021', async () => {})
   */
  it('kills a pending child before waiting for spawn for Discord audit D-021', async () => {
    // ROOT CAUSE:
    //
    // `stop()` awaited the unresolved start promise before it called `kill()`.
    // A utility process that never emitted `spawn` therefore prevented a newer
    // token or disabled policy from superseding the old lifecycle.
    //
    // Before: stop waited forever and the pending child was never signalled.
    // After: stop invalidates start, kills immediately, and drains actual exit.
    let exitListener: ((code: number) => void) | undefined
    const childKill = vi.fn(() => true)
    const fork = vi.fn(() => ({
      kill: childKill,
      once(event: 'spawn' | 'exit', listener: (() => void) | ((code: number) => void)) {
        if (event === 'exit')
          exitListener = listener as (code: number) => void
        return this
      },
      postMessage: vi.fn(),
    }))
    const manager = createDiscordBridgeManager({
      bootstrap: {
        airiUrl: 'ws://127.0.0.1:47270/ws',
        discordToken: 'synthetic-pending-token',
        moduleCredential: 'synthetic-pending-module-credential',
        moduleIdentity: {
          id: 'discord-utility-process',
          kind: 'plugin',
          plugin: { id: 'discord' },
        },
      },
      entryPath: join('synthetic', 'discord-bridge.js'),
      fork,
    })

    const starting = manager.start()
    const stopping = manager.stop()
    await Promise.resolve()

    // @example
    expect(childKill).toHaveBeenCalledOnce()
    exitListener?.(0)
    // @example
    await expect(starting).rejects.toThrow('stopped before spawn')
    await stopping
    // @example
    expect(manager.isRunning()).toBe(false)
  })

  /**
   * @example
   * it('does not bootstrap a late spawn after stop for Discord audit D-021', async () => {})
   */
  it('does not bootstrap a late spawn after stop for Discord audit D-021', async () => {
    // ROOT CAUSE:
    //
    // A late `spawn` callback had no lifecycle generation/stop gate. It could
    // transfer the protected token after stop had already become the latest
    // intent, briefly resurrecting the superseded utility process.
    let exitListener: ((code: number) => void) | undefined
    let spawnListener: (() => void) | undefined
    const childPostMessage = vi.fn()
    const childKill = vi.fn(() => true)
    const portPostMessage = vi.fn()
    const fork = vi.fn(() => ({
      kill: childKill,
      once(event: 'spawn' | 'exit', listener: (() => void) | ((code: number) => void)) {
        if (event === 'spawn')
          spawnListener = listener as () => void
        else
          exitListener = listener as (code: number) => void
        return this
      },
      postMessage: childPostMessage,
    }))
    const manager = createDiscordBridgeManager({
      bootstrap: {
        airiUrl: 'ws://127.0.0.1:47270/ws',
        discordToken: 'synthetic-late-token',
        moduleCredential: 'synthetic-late-module-credential',
        moduleIdentity: {
          id: 'discord-utility-process',
          kind: 'plugin',
          plugin: { id: 'discord' },
        },
      },
      createMessageChannel: () => ({
        port1: { close: vi.fn() },
        port2: { close: vi.fn(), postMessage: portPostMessage },
      }),
      entryPath: join('synthetic', 'discord-bridge.js'),
      fork,
    })

    const starting = manager.start()
    const stopping = manager.stop()
    spawnListener?.()
    exitListener?.(0)

    // @example
    await expect(starting).rejects.toThrow('stopped before spawn')
    await stopping
    // @example
    expect(childPostMessage).not.toHaveBeenCalled()
    // @example
    expect(portPostMessage).not.toHaveBeenCalled()
    // @example
    expect(childKill).toHaveBeenCalledOnce()
  })

  /**
   * @example
   * it('closes bootstrap ports and preserves the first startup error for Discord audit D-021', async () => {})
   */
  it('closes bootstrap ports and preserves the first startup error for Discord audit D-021', async () => {
    // ROOT CAUSE:
    //
    // Bootstrap transfer errors could leave the sending port open, and a
    // synchronous child exit during cleanup could replace the real bootstrap
    // failure with a generic cancellation result.
    let exitListener: ((code: number) => void) | undefined
    const childKill = vi.fn(() => {
      exitListener?.(0)
      return true
    })
    const portClose = vi.fn()
    const manager = createDiscordBridgeManager({
      bootstrap: {
        airiUrl: 'ws://127.0.0.1:47270/ws',
        discordToken: 'synthetic-bootstrap-token',
        moduleCredential: 'synthetic-bootstrap-module-credential',
        moduleIdentity: {
          id: 'discord-utility-process',
          kind: 'plugin',
          plugin: { id: 'discord' },
        },
      },
      createMessageChannel: () => ({
        port1: { close: vi.fn() },
        port2: {
          close: portClose,
          postMessage: () => {
            throw new Error('synthetic bootstrap transfer failure')
          },
        },
      }),
      entryPath: join('synthetic', 'discord-bridge.js'),
      fork: () => ({
        kill: childKill,
        once(event: 'spawn' | 'exit', listener: (() => void) | ((code: number) => void)) {
          if (event === 'spawn')
            (listener as () => void)()
          else
            exitListener = listener as (code: number) => void
          return this
        },
        postMessage: vi.fn(),
      }),
    })

    // @example
    await expect(manager.start()).rejects.toThrow('synthetic bootstrap transfer failure')
    // @example
    expect(portClose).toHaveBeenCalledOnce()
    // @example
    expect(childKill).toHaveBeenCalledOnce()
    // @example
    expect(manager.isRunning()).toBe(false)
  })
})

/**
 * @example
 * describe('discord bridge protected configuration lifecycle', () => {})
 */
describe('discord bridge protected configuration lifecycle', () => {
  /**
   * @example
   * it('coalesces token A, disabled B, and token C while A is pending spawn for Discord audit D-021', async () => {})
   */
  it('coalesces token A, disabled B, and token C while A is pending spawn for Discord audit D-021', async () => {
    // ROOT CAUSE:
    //
    // Main queued every protected configuration behind the previous manager
    // start. Because that start waited for `spawn`, token B/C and disable could
    // not signal the A child, and stale A was allowed to bootstrap first.
    //
    // Before: B/C waited behind A and `kill()` remained uncalled.
    // After: ingress records the latest generation, immediately retires A, and
    // the single coalescing loop starts only the latest protected token owner.
    mainBoundaryMocks.bootstrapMessages.length = 0
    mainBoundaryMocks.configureHandler = undefined
    mainBoundaryMocks.utilityFork.mockReset()
    const childMessages: unknown[][] = []
    const childKills: ReturnType<typeof vi.fn>[] = []
    const exitListeners: Array<((code: number) => void) | undefined> = []
    const spawnListeners: Array<(() => void) | undefined> = []
    mainBoundaryMocks.utilityFork.mockImplementation(() => {
      const childIndex = childKills.length
      const messages: unknown[] = []
      childMessages.push(messages)
      const kill = vi.fn(() => {
        exitListeners[childIndex]?.(0)
        return true
      })
      childKills.push(kill)
      return {
        kill,
        once(event: 'spawn' | 'exit', listener: (() => void) | ((code: number) => void)) {
          if (event === 'spawn')
            spawnListeners[childIndex] = listener as () => void
          else
            exitListeners[childIndex] = listener as (code: number) => void
          return this
        },
        postMessage: (message: unknown) => messages.push(message),
      }
    })

    const stored = new Map<string, string>()
    const setItem = vi.fn(async (key: string, value: string) => {
      stored.set(key, value)
    })
    const removeItem = vi.fn(async (key: string) => {
      stored.delete(key)
    })
    let stopHook: (() => void | Promise<void>) | undefined
    setupDiscordBridgeService({
      entryPath: join('synthetic', 'discord-bridge.js'),
      isTrustedRendererUrl: url => url === 'app://airi/settings',
      lifecycle: {
        appHooks: {
          onStart: vi.fn(),
          onStop: (hook) => {
            stopHook = hook
          },
        },
      },
      secureStorage: {
        dispose: vi.fn(),
        flush: vi.fn(async () => {}),
        getItem: key => stored.get(key) ?? null,
        removeItem,
        setItem,
      },
      serverChannel: {
        getDiscordBridgeBootstrap: vi.fn(async () => ({
          airiUrl: 'ws://127.0.0.1:47270/ws',
          moduleCredential: 'synthetic-main-module-credential',
          moduleIdentity: {
            id: 'discord-utility-process' as const,
            kind: 'plugin' as const,
            plugin: { id: 'discord' as const },
          },
        })),
      },
    })
    const configure = configuredHandler()
    const senderFrame = { url: 'app://airi/settings' }
    const handlerOptions = {
      raw: {
        ipcMainEvent: {
          sender: { mainFrame: senderFrame },
          senderFrame,
        },
      },
    }
    const basePolicy = {
      adminRoleIds: [],
      allowDirectMessages: false,
      auditLogEnabled: true,
      enabled: true,
      memoryConsentRequired: true,
      messagePacingMs: 600,
      privacyNoticeEnabled: true,
      privacyNoticeText: 'Synthetic disclosure',
      rateLimitMaxMessages: 6,
      rateLimitWindowMs: 30_000,
    }
    const applyingA = Promise.resolve(configure({
      ...basePolicy,
      allowedChannelIds: ['channel-a'],
      token: { action: 'set', value: 'synthetic-token-a' },
    }, handlerOptions))
    await vi.waitFor(() => {
      // @example
      expect(mainBoundaryMocks.utilityFork).toHaveBeenCalledOnce()
    })

    const applyingB = Promise.resolve(configure({
      ...basePolicy,
      allowedChannelIds: ['channel-b'],
      enabled: false,
      token: { action: 'unchanged' },
    }, handlerOptions))
    const applyingC = Promise.resolve(configure({
      ...basePolicy,
      allowedChannelIds: ['channel-c'],
      token: { action: 'set', value: 'synthetic-token-c' },
    }, handlerOptions))
    await Promise.resolve()

    // @example
    expect(childKills[0]).toHaveBeenCalledOnce()
    await vi.waitFor(() => {
      // @example
      expect(mainBoundaryMocks.utilityFork).toHaveBeenCalledTimes(2)
    })
    spawnListeners[1]?.()
    const statuses = await Promise.all([applyingA, applyingB, applyingC])

    // @example
    expect(statuses).toEqual([
      { configured: true, enabled: true, running: true },
      { configured: true, enabled: true, running: true },
      { configured: true, enabled: true, running: true },
    ])
    // @example
    expect(setItem.mock.calls.map(call => call[1])).toEqual([
      'synthetic-token-a',
      'synthetic-token-c',
    ])
    // @example
    expect(JSON.stringify(mainBoundaryMocks.bootstrapMessages)).not.toContain('synthetic-token-a')
    // @example
    expect(JSON.stringify(mainBoundaryMocks.bootstrapMessages)).toContain('synthetic-token-c')
    // @example
    expect(childMessages[1]).toContainEqual({
      type: 'discord-bridge:configure',
      policy: expect.objectContaining({ allowedChannelIds: ['channel-c'] }),
    })

    await stopHook?.()
    // @example
    expect(childKills[1]).toHaveBeenCalledOnce()
  })

  /**
   * @example
   * it('folds a pending token mutation into the latest unchanged policy for Discord audit D-021', async () => {})
   */
  it('folds a pending token mutation into the latest unchanged policy for Discord audit D-021', async () => {
    mainBoundaryMocks.bootstrapMessages.length = 0
    mainBoundaryMocks.configureHandler = undefined
    mainBoundaryMocks.utilityFork.mockReset()
    const childMessages: unknown[][] = []
    const childKills: ReturnType<typeof vi.fn>[] = []
    const exitListeners: Array<((code: number) => void) | undefined> = []
    mainBoundaryMocks.utilityFork.mockImplementation(() => {
      const childIndex = childKills.length
      const messages: unknown[] = []
      childMessages.push(messages)
      const kill = vi.fn(() => {
        exitListeners[childIndex]?.(0)
        return true
      })
      childKills.push(kill)
      return {
        kill,
        once(event: 'spawn' | 'exit', listener: (() => void) | ((code: number) => void)) {
          if (event === 'spawn')
            (listener as () => void)()
          else
            exitListeners[childIndex] = listener as (code: number) => void
          return this
        },
        postMessage: (message: unknown) => messages.push(message),
      }
    })

    const stored = new Map<string, string>()
    let releaseTokenA = () => {}
    const tokenAWrite = new Promise<void>((resolve) => {
      releaseTokenA = resolve
    })
    const setItem = vi.fn(async (key: string, value: string) => {
      if (value === 'synthetic-pending-token-a')
        await tokenAWrite
      stored.set(key, value)
    })
    let stopHook: (() => void | Promise<void>) | undefined
    setupDiscordBridgeService({
      entryPath: join('synthetic', 'discord-bridge.js'),
      isTrustedRendererUrl: url => url === 'app://airi/settings',
      lifecycle: {
        appHooks: {
          onStart: vi.fn(),
          onStop: (hook) => {
            stopHook = hook
          },
        },
      },
      secureStorage: {
        dispose: vi.fn(),
        flush: vi.fn(async () => {}),
        getItem: key => stored.get(key) ?? null,
        removeItem: vi.fn(async (key) => {
          stored.delete(key)
        }),
        setItem,
      },
      serverChannel: {
        getDiscordBridgeBootstrap: vi.fn(async () => ({
          airiUrl: 'ws://127.0.0.1:47270/ws',
          moduleCredential: 'synthetic-coalesced-module-credential',
          moduleIdentity: {
            id: 'discord-utility-process' as const,
            kind: 'plugin' as const,
            plugin: { id: 'discord' as const },
          },
        })),
      },
    })
    const configure = configuredHandler()
    const senderFrame = { url: 'app://airi/settings' }
    const handlerOptions = {
      raw: {
        ipcMainEvent: {
          sender: { mainFrame: senderFrame },
          senderFrame,
        },
      },
    }
    const basePolicy = {
      adminRoleIds: [],
      allowDirectMessages: false,
      auditLogEnabled: true,
      enabled: true,
      memoryConsentRequired: true,
      messagePacingMs: 600,
      privacyNoticeEnabled: true,
      privacyNoticeText: 'Synthetic disclosure',
      rateLimitMaxMessages: 6,
      rateLimitWindowMs: 30_000,
    }
    const applyingA = Promise.resolve(configure({
      ...basePolicy,
      allowedChannelIds: ['channel-a'],
      token: { action: 'set', value: 'synthetic-pending-token-a' },
    }, handlerOptions))
    await vi.waitFor(() => {
      // @example
      expect(setItem).toHaveBeenCalledOnce()
    })

    // ROOT CAUSE:
    //
    // Public policy coalescing replaced the whole desired configuration. While
    // token A's secure-storage write was pending, B's newer token mutation was
    // overwritten by C's `unchanged` action. Once A settled stale, C read token A
    // from storage and bootstrapped the wrong credential. Secret mutations must
    // fold into the latest desired policy until that mutation is durably applied.
    const applyingB = Promise.resolve(configure({
      ...basePolicy,
      allowedChannelIds: ['channel-b'],
      token: { action: 'set', value: 'synthetic-pending-token-b' },
    }, handlerOptions))
    const applyingC = Promise.resolve(configure({
      ...basePolicy,
      allowedChannelIds: ['channel-c'],
      token: { action: 'unchanged' },
    }, handlerOptions))
    releaseTokenA()
    const statuses = await Promise.all([applyingA, applyingB, applyingC])

    // @example
    expect(statuses).toEqual([
      { configured: true, enabled: true, running: true },
      { configured: true, enabled: true, running: true },
      { configured: true, enabled: true, running: true },
    ])
    // @example
    expect(setItem.mock.calls.map(call => call[1])).toEqual([
      'synthetic-pending-token-a',
      'synthetic-pending-token-b',
    ])
    // @example
    expect(JSON.stringify(mainBoundaryMocks.bootstrapMessages)).not.toContain('synthetic-pending-token-a')
    // @example
    expect(JSON.stringify(mainBoundaryMocks.bootstrapMessages)).toContain('synthetic-pending-token-b')
    // @example
    expect(childMessages[0]).toContainEqual({
      type: 'discord-bridge:configure',
      policy: expect.objectContaining({ allowedChannelIds: ['channel-c'] }),
    })

    await stopHook?.()
    // @example
    expect(childKills[0]).toHaveBeenCalledOnce()
  })

  /**
   * @example
   * it('retires a superseded failed start before applying the latest policy for Discord audit D-021', async () => {})
   */
  it('retires a superseded failed start before applying the latest policy for Discord audit D-021', async () => {
    // ROOT CAUSE:
    //
    // A failed utility start returned early when its configuration generation
    // had already been superseded. The failed manager therefore remained the
    // active owner, and a policy-only B configuration reused A's permanently
    // rejected start task instead of constructing a clean replacement.
    //
    // Before: both A and B rejected and only A's child was ever forked.
    // After: every failed start retires and drains its exact manager first;
    // the coalescing loop then starts a fresh owner with B's latest policy.
    mainBoundaryMocks.bootstrapMessages.length = 0
    mainBoundaryMocks.configureHandler = undefined
    mainBoundaryMocks.utilityFork.mockReset()
    const childMessages: unknown[][] = []
    const childKills: ReturnType<typeof vi.fn>[] = []
    const exitListeners: Array<((code: number) => void) | undefined> = []
    const spawnListeners: Array<(() => void) | undefined> = []
    mainBoundaryMocks.utilityFork.mockImplementation(() => {
      const childIndex = childKills.length
      const messages: unknown[] = []
      childMessages.push(messages)
      const kill = vi.fn(() => {
        // The bootstrap failure initiates the first kill. Keep the synthetic
        // child alive until Main explicitly retires the failed exact owner.
        if (childIndex > 0 || kill.mock.calls.length > 1)
          exitListeners[childIndex]?.(0)
        return true
      })
      childKills.push(kill)
      return {
        kill,
        once(event: 'spawn' | 'exit', listener: (() => void) | ((code: number) => void)) {
          if (event === 'spawn')
            spawnListeners[childIndex] = listener as () => void
          else
            exitListeners[childIndex] = listener as (code: number) => void
          return this
        },
        postMessage: childIndex === 0
          ? vi.fn(() => {
              throw new Error('SYNTHETIC_PRIVATE_START_DETAIL')
            })
          : (message: unknown) => messages.push(message),
      }
    })

    const stored = new Map<string, string>([
      ['main/discord-bridge/bot-token', 'synthetic-existing-token'],
    ])
    let stopHook: (() => void | Promise<void>) | undefined
    setupDiscordBridgeService({
      entryPath: join('synthetic', 'discord-bridge.js'),
      isTrustedRendererUrl: url => url === 'app://airi/settings',
      lifecycle: {
        appHooks: {
          onStart: vi.fn(),
          onStop: (hook) => {
            stopHook = hook
          },
        },
      },
      secureStorage: {
        dispose: vi.fn(),
        flush: vi.fn(async () => {}),
        getItem: key => stored.get(key) ?? null,
        removeItem: vi.fn(async (key) => {
          stored.delete(key)
        }),
        setItem: vi.fn(async (key, value) => {
          stored.set(key, value)
        }),
      },
      serverChannel: {
        getDiscordBridgeBootstrap: vi.fn(async () => ({
          airiUrl: 'ws://127.0.0.1:47270/ws',
          moduleCredential: 'synthetic-stale-start-module-credential',
          moduleIdentity: {
            id: 'discord-utility-process' as const,
            kind: 'plugin' as const,
            plugin: { id: 'discord' as const },
          },
        })),
      },
    })
    const configure = configuredHandler()
    const senderFrame = { url: 'app://airi/settings' }
    const handlerOptions = {
      raw: {
        ipcMainEvent: {
          sender: { mainFrame: senderFrame },
          senderFrame,
        },
      },
    }
    const basePolicy = {
      adminRoleIds: [],
      allowDirectMessages: false,
      auditLogEnabled: true,
      enabled: true,
      memoryConsentRequired: true,
      messagePacingMs: 600,
      privacyNoticeEnabled: true,
      privacyNoticeText: 'Synthetic disclosure',
      rateLimitMaxMessages: 6,
      rateLimitWindowMs: 30_000,
    }
    const applyingA = Promise.resolve(configure({
      ...basePolicy,
      allowedChannelIds: ['channel-a'],
      token: { action: 'unchanged' },
    }, handlerOptions)).then(
      value => ({ status: 'fulfilled' as const, value }),
      reason => ({ reason, status: 'rejected' as const }),
    )
    await vi.waitFor(() => {
      // @example
      expect(mainBoundaryMocks.utilityFork).toHaveBeenCalledOnce()
    })

    const applyingB = Promise.resolve(configure({
      ...basePolicy,
      allowedChannelIds: ['channel-b'],
      token: { action: 'unchanged' },
    }, handlerOptions)).then(
      value => ({ status: 'fulfilled' as const, value }),
      reason => ({ reason, status: 'rejected' as const }),
    )
    spawnListeners[0]?.()

    await vi.waitFor(() => {
      // @example
      expect(mainBoundaryMocks.utilityFork).toHaveBeenCalledTimes(2)
    })
    spawnListeners[1]?.()
    const outcomes = await Promise.all([applyingA, applyingB])

    // @example
    expect(outcomes).toEqual([
      { status: 'fulfilled', value: { configured: true, enabled: true, running: true } },
      { status: 'fulfilled', value: { configured: true, enabled: true, running: true } },
    ])
    // @example
    expect(childKills[0]).toHaveBeenCalledTimes(2)
    // @example
    expect(childMessages[1]).toContainEqual({
      type: 'discord-bridge:configure',
      policy: expect.objectContaining({ allowedChannelIds: ['channel-b'] }),
    })
    // @example
    expect(childMessages[1]).not.toContainEqual({
      type: 'discord-bridge:configure',
      policy: expect.objectContaining({ allowedChannelIds: ['channel-a'] }),
    })

    await stopHook?.()
    // @example
    expect(childKills[1]).toHaveBeenCalledOnce()
  })

  /**
   * @example
   * it('retries the same retiring owner after cleanup failure for Discord audit D-021', async () => {})
   */
  it('retries the same retiring owner after cleanup failure for Discord audit D-021', async () => {
    // ROOT CAUSE:
    //
    // A failed manager stop used to leave configuration serialization rejected
    // or discard the exact old owner. Either behavior prevented a later valid
    // token update from retrying cleanup before starting a replacement.
    //
    // The retirement slot now retains the old owner, but not a cached rejected
    // promise, so the next generation retries stop and only then starts C.
    mainBoundaryMocks.bootstrapMessages.length = 0
    mainBoundaryMocks.configureHandler = undefined
    mainBoundaryMocks.utilityFork.mockReset()
    const exitListeners: Array<((code: number) => void) | undefined> = []
    const spawnListeners: Array<(() => void) | undefined> = []
    const childKills: ReturnType<typeof vi.fn>[] = []
    mainBoundaryMocks.utilityFork.mockImplementation(() => {
      const childIndex = childKills.length
      const kill = childIndex === 0
        ? vi.fn(() => {
            exitListeners[childIndex]?.(0)
            throw new Error('SYNTHETIC_PRIVATE_KILL_DETAIL')
          })
        : vi.fn(() => {
            exitListeners[childIndex]?.(0)
            return true
          })
      childKills.push(kill)
      return {
        kill,
        once(event: 'spawn' | 'exit', listener: (() => void) | ((code: number) => void)) {
          if (event === 'spawn')
            spawnListeners[childIndex] = listener as () => void
          else
            exitListeners[childIndex] = listener as (code: number) => void
          return this
        },
        postMessage: vi.fn(),
      }
    })

    const stored = new Map<string, string>()
    const setItem = vi.fn(async (key: string, value: string) => {
      stored.set(key, value)
    })
    let stopHook: (() => void | Promise<void>) | undefined
    setupDiscordBridgeService({
      entryPath: join('synthetic', 'discord-bridge.js'),
      isTrustedRendererUrl: url => url === 'app://airi/settings',
      lifecycle: {
        appHooks: {
          onStart: vi.fn(),
          onStop: (hook) => {
            stopHook = hook
          },
        },
      },
      secureStorage: {
        dispose: vi.fn(),
        flush: vi.fn(async () => {}),
        getItem: key => stored.get(key) ?? null,
        removeItem: vi.fn(async (key) => {
          stored.delete(key)
        }),
        setItem,
      },
      serverChannel: {
        getDiscordBridgeBootstrap: vi.fn(async () => ({
          airiUrl: 'ws://127.0.0.1:47270/ws',
          moduleCredential: 'synthetic-recovery-module-credential',
          moduleIdentity: {
            id: 'discord-utility-process' as const,
            kind: 'plugin' as const,
            plugin: { id: 'discord' as const },
          },
        })),
      },
    })
    const configure = configuredHandler()
    const senderFrame = { url: 'app://airi/settings' }
    const handlerOptions = {
      raw: {
        ipcMainEvent: {
          sender: { mainFrame: senderFrame },
          senderFrame,
        },
      },
    }
    const basePolicy = {
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
    }
    const applyingA = Promise.resolve(configure({
      ...basePolicy,
      token: { action: 'set', value: 'synthetic-recovery-token-a' },
    }, handlerOptions))
    await vi.waitFor(() => {
      // @example
      expect(mainBoundaryMocks.utilityFork).toHaveBeenCalledOnce()
    })
    spawnListeners[0]?.()
    await applyingA

    // @example
    await expect(Promise.resolve(configure({
      ...basePolicy,
      token: { action: 'set', value: 'synthetic-recovery-token-b' },
    }, handlerOptions))).rejects.toThrow('Discord bridge utility process failed to stop')

    const applyingC = Promise.resolve(configure({
      ...basePolicy,
      token: { action: 'set', value: 'synthetic-recovery-token-c' },
    }, handlerOptions))
    await vi.waitFor(() => {
      // @example
      expect(mainBoundaryMocks.utilityFork).toHaveBeenCalledTimes(2)
    })
    spawnListeners[1]?.()
    await expect(applyingC).resolves.toEqual({ configured: true, enabled: true, running: true })

    // @example
    expect(setItem.mock.calls.map(call => call[1])).toEqual([
      'synthetic-recovery-token-a',
      'synthetic-recovery-token-c',
    ])
    // @example
    expect(JSON.stringify(mainBoundaryMocks.dispose.mock.calls)).not.toContain('PRIVATE_KILL_DETAIL')

    await stopHook?.()
    // @example
    expect(childKills[1]).toHaveBeenCalledOnce()
  })
})
