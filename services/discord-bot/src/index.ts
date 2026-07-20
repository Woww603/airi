import process, { env } from 'node:process'

import { fileURLToPath } from 'node:url'

import { Format, LogLevel, setGlobalFormat, setGlobalLogLevel, useLogg } from '@guiiai/logg'

import { startStandaloneDiscordAppRuntime } from './standalone/app-runtime'

setGlobalFormat(Format.Pretty)
setGlobalLogLevel(LogLevel.Log)
const log = useLogg('Bot').useGlobalConfig()

/**
 * Runs standalone Discord with its local dashboard.
 *
 * Call stack:
 *
 * main
 *   -> {@link runStandaloneDiscordApp}
 *     -> {@link StandaloneDashboardServer.start}
 *     -> {@link StandaloneDiscordAppController.startBot}
 */
async function runStandaloneDiscordApp() {
  const runtime = await startStandaloneDiscordAppRuntime({
    env,
    envFilePath: fileURLToPath(new URL('../.env.local', import.meta.url)),
  })
  if (runtime.dashboardAddress)
    log.withFields({ dashboardReady: true }).log('[discord-bot:standalone] dashboard ready')

  if (!runtime.startResult.ok) {
    log.withFields({
      dashboardEnabled: Boolean(runtime.dashboardAddress),
      failureCategory: 'standalone-start-failure',
    }).error('[discord-bot:standalone] startup failed')
  }

  async function gracefulShutdown(signal: string) {
    log.log(`Received ${signal}, shutting down...`)
    await runtime.stop()
    process.exit(0)
  }

  process.on('SIGINT', async () => {
    await gracefulShutdown('SIGINT')
  })

  process.on('SIGTERM', async () => {
    await gracefulShutdown('SIGTERM')
  })
}

/**
 * Runs the only supported source-level Discord service entrypoint.
 *
 * Call stack:
 *
 * main
 *   -> {@link runStandaloneDiscordApp}
 *     -> {@link startStandaloneDiscordAppRuntime}
 *
 * Electron bridge mode is owned by Tamagotchi Main and its protected utility
 * process; it intentionally has no environment-driven service entrypoint.
 */
async function main() {
  log.withFields({
    hasDiscordToken: Boolean(env.DISCORD_TOKEN),
    mode: 'standalone',
  }).log('[discord-bot] boot')
  await runStandaloneDiscordApp()
}

main().catch(() => log.withFields({
  failureCategory: 'standalone-runtime-failure',
}).error('[discord-bot:standalone] runtime failed'))
