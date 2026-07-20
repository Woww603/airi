import type { StandaloneDashboardAddress } from './dashboard'

import { dirname, resolve } from 'node:path'

import { StandaloneDiscordAppController } from './app-controller'
import { resolveStandaloneDashboardServerSettings, StandaloneDashboardServer } from './dashboard'
import { StandaloneDashboardState } from './dashboard-state'
import { StandaloneDashboardCounterStore } from './dashboard-state-store'

/**
 * Configuration for one standalone Discord application runtime.
 */
export interface StandaloneDiscordAppRuntimeOptions {
  /** Process-like environment used for dashboard and bot defaults. */
  env: NodeJS.ProcessEnv
  /** Persistent dotenv file used for secrets and dashboard settings. */
  envFilePath: string
  /** Persistent historical dashboard counter file. */
  stateFilePath?: string
}

/**
 * Running standalone Discord application resources.
 */
export interface StandaloneDiscordAppRuntime {
  /** Local dashboard address when the dashboard server is enabled. */
  dashboardAddress?: StandaloneDashboardAddress
  /** Result of the initial Discord bot startup attempt. */
  startResult: {
    /** Whether Discord connected successfully. */
    ok: boolean
    /** Human-readable startup result. */
    message: string
  }
  /** Stops Discord and the local dashboard exactly once. */
  stop: () => Promise<void>
}

/**
 * Starts the reusable standalone Discord runtime shared by the CLI and Electron app.
 *
 * Use when:
 * - Discord, the local dashboard, and DeepSeek should run without AIRI desktop.
 * - A host process needs to own shutdown instead of letting the CLI call `process.exit()`.
 *
 * Expects:
 * - `envFilePath` points to a writable user-owned settings location.
 * - Dashboard settings bind to a trusted local interface.
 *
 * Returns:
 * - Dashboard address, initial bot result, and an idempotent stop operation.
 *
 * Call stack:
 *
 * startStandaloneDiscordAppRuntime
 *   -> {@link StandaloneDashboardServer.start}
 *   -> {@link StandaloneDiscordAppController.startBot}
 */
export async function startStandaloneDiscordAppRuntime(
  options: StandaloneDiscordAppRuntimeOptions,
): Promise<StandaloneDiscordAppRuntime> {
  const counterStore = new StandaloneDashboardCounterStore({
    filePath: options.stateFilePath ?? resolve(dirname(options.envFilePath), '.airi-discord-dashboard-state.json'),
  })
  const state = new StandaloneDashboardState({
    initialCounters: await counterStore.load(),
    onCountersChanged: counters => counterStore.schedule(counters),
  })
  const controller = new StandaloneDiscordAppController({
    env: options.env,
    envFilePath: options.envFilePath,
    state,
  })
  const dashboardSettings = resolveStandaloneDashboardServerSettings(options.env)
  const dashboard = dashboardSettings.enabled
    ? new StandaloneDashboardServer({ controller, settings: dashboardSettings })
    : undefined
  const dashboardAddress = await dashboard?.start()
  const startResult = await controller.startBot()
  let stopTask: Promise<void> | undefined

  return {
    dashboardAddress,
    startResult,
    stop() {
      if (stopTask)
        return stopTask

      const task = (async () => {
        const failures: unknown[] = []
        try {
          const result = await controller.stopBot()
          if (!result.ok)
            failures.push(new Error(result.message))
        }
        catch (error) {
          failures.push(error)
        }

        try {
          await dashboard?.stop()
        }
        catch (error) {
          failures.push(error)
        }

        try {
          await counterStore.flush()
        }
        catch (error) {
          failures.push(error)
        }

        if (failures.length === 1)
          throw failures[0]
        if (failures.length > 1)
          throw new AggregateError(failures, 'Standalone Discord application cleanup failed.')
      })()
      stopTask = task
      return task
    },
  }
}
