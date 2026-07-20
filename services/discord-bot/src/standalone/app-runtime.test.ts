import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { startStandaloneDiscordAppRuntime } from './app-runtime'

const adapterMocks = vi.hoisted(() => ({
  start: vi.fn<() => Promise<void>>(),
  stop: vi.fn<() => Promise<void>>(),
}))

vi.mock('../adapters/standalone-adapter', () => ({
  StandaloneDiscordAdapter: class {
    start = vi.fn(() => adapterMocks.start())
    stop = vi.fn(() => adapterMocks.stop())
  },
}))

beforeEach(() => {
  adapterMocks.start.mockReset()
  adapterMocks.start.mockResolvedValue(undefined)
  adapterMocks.stop.mockReset()
  adapterMocks.stop.mockResolvedValue(undefined)
})

/**
 * @example
 * describe('standalone Discord app runtime', () => {})
 */
describe('standalone Discord app runtime', () => {
  /**
   * @example
   * it('keeps the host process alive when bot credentials are missing', async () => {})
   */
  it('keeps the host process alive when bot credentials are missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'airi-discord-runtime-'))

    try {
      const runtime = await startStandaloneDiscordAppRuntime({
        env: {
          AIRI_DISCORD_DASHBOARD_ENABLED: 'false',
        },
        envFilePath: join(dir, '.env.local'),
      })

      expect(runtime.dashboardAddress).toBeUndefined()
      expect(runtime.startResult.ok).toBe(false)
      expect(runtime.startResult.message).toBe('启动独立 Discord bot 失败。请查看本地运行日志。')
      expect(runtime.startResult.message).not.toContain('API_KEY')
      await runtime.stop()
      await runtime.stop()
    }
    finally {
      await rm(dir, { force: true, recursive: true })
    }
  })

  /**
   * @example
   * it('propagates Discord audit D-019 runtime shutdown failure without raw error content', async () => {})
   */
  it('propagates Discord audit D-019 runtime shutdown failure without raw error content', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'airi-discord-runtime-lifecycle-'))
    adapterMocks.stop.mockRejectedValueOnce(new Error('SYNTHETIC_D019_RUNTIME_STOP_FAILURE'))

    try {
      const runtime = await startStandaloneDiscordAppRuntime({
        env: {
          AIRI_DISCORD_DASHBOARD_ENABLED: 'false',
          DEEPSEEK_API_KEY: 'synthetic-model-key',
          DEEPSEEK_MODEL: 'synthetic-model',
          DISCORD_TOKEN: 'synthetic-discord-token',
        },
        envFilePath: join(dir, '.env.local'),
      })
      /**
       * @example
       * expect(runtime.startResult.ok).toBe(true)
       */
      expect(runtime.startResult.ok).toBe(true)

      // ROOT CAUSE:
      //
      // The controller converted teardown rejection into an `{ ok: false }`
      // dashboard result, but app-runtime ignored that result and reported a
      // clean host shutdown even though the Discord owner failed to close.
      // The public runtime boundary must still reject while keeping provider,
      // transport, and user-controlled error text out of the surfaced error.
      const stopTask = runtime.stop()
      /**
       * @example
       * await expect(stopTask).rejects.toThrow('停止独立 Discord bot 失败。请查看本地运行日志。')
       */
      await expect(stopTask).rejects.toThrow('停止独立 Discord bot 失败。请查看本地运行日志。')
      await expect(stopTask).rejects.not.toThrow('SYNTHETIC_D019_RUNTIME_STOP_FAILURE')
      /**
       * @example
       * expect(adapterMocks.stop).toHaveBeenCalledOnce()
       */
      expect(adapterMocks.stop).toHaveBeenCalledOnce()
    }
    finally {
      await rm(dir, { force: true, recursive: true })
    }
  })

  /**
   * @example
   * it('shares concurrent Discord audit D-019 runtime stop completion', async () => {})
   */
  it('shares concurrent Discord audit D-019 runtime stop completion', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'airi-discord-runtime-stop-'))
    let resolveStop = () => {}
    adapterMocks.stop.mockReturnValue(new Promise<void>((resolve) => {
      resolveStop = resolve
    }))

    try {
      const runtime = await startStandaloneDiscordAppRuntime({
        env: {
          AIRI_DISCORD_DASHBOARD_ENABLED: 'false',
          DEEPSEEK_API_KEY: 'synthetic-model-key',
          DEEPSEEK_MODEL: 'synthetic-model',
          DISCORD_TOKEN: 'synthetic-discord-token',
        },
        envFilePath: join(dir, '.env.local'),
      })

      // ROOT CAUSE:
      //
      // app-runtime set a stopped boolean before its first teardown completed.
      // A concurrent caller therefore returned an unrelated fulfilled promise
      // while the actual adapter/client cleanup was still pending.
      const stopA = runtime.stop()
      const stopB = runtime.stop()
      const sharedCompletion = stopB === stopA
      resolveStop()
      await Promise.all([stopA, stopB])
      /**
       * @example
       * expect(sharedCompletion).toBe(true)
       */
      expect(sharedCompletion).toBe(true)
      /**
       * @example
       * expect(adapterMocks.stop).toHaveBeenCalledOnce()
       */
      expect(adapterMocks.stop).toHaveBeenCalledOnce()
    }
    finally {
      await rm(dir, { force: true, recursive: true })
    }
  })
})
