import type { StandaloneDiscordAppRuntime } from '@proj-airi/discord-bot/standalone-app'
import type { StandaloneRuntimeFileLogging } from '@proj-airi/discord-bot/standalone-log'

import process from 'node:process'

import { access, chmod, copyFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import { startStandaloneDiscordAppRuntime } from '@proj-airi/discord-bot/standalone-app'
import { installStandaloneRuntimeFileLogging } from '@proj-airi/discord-bot/standalone-log'
import { app, BrowserWindow, dialog, Menu } from 'electron'

import { createApplicationMenuTemplate } from './application-menu'

const productName = 'AIRI Discord'
const remoteDebugPort = process.env.AIRI_DISCORD_REMOTE_DEBUG_PORT?.trim()
if (remoteDebugPort && /^\d+$/.test(remoteDebugPort)) {
  // Expose CDP only when explicitly requested for local packaged-app verification.
  app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1')
  app.commandLine.appendSwitch('remote-debugging-port', remoteDebugPort)
}

app.setName(productName)
app.setPath('userData', join(app.getPath('appData'), productName))

let mainWindow: BrowserWindow | undefined
let runtime: StandaloneDiscordAppRuntime | undefined
let runtimeLog: StandaloneRuntimeFileLogging | undefined
let restoreConsoleFileLog = () => {}
let cleanupStarted = false

type PackagedAppFailureCategory
  = | 'dashboard-window-open-failed'
    | 'runtime-log-close-failed'
    | 'runtime-log-init-failed'
    | 'runtime-stop-failed'
    | 'startup-failed'

/**
 * Records only an allowlisted lifecycle category at the Electron process boundary.
 *
 * External errors can contain local paths, provider endpoints, identifiers, or
 * user-controlled text, so neither the Error object nor its message is logged.
 */
function recordPackagedAppFailure(category: PackagedAppFailureCategory): void {
  process.stderr.write(`[${productName}] ${category}\n`)
}

/**
 * Copies an explicitly supplied legacy data file only on the first packaged launch.
 *
 * The packaged app never embeds secrets. A local installer can instead provide the
 * previous `.env.local` and memory paths through environment variables once.
 */
async function importLegacyFile(sourcePath: string | undefined, targetPath: string): Promise<void> {
  const source = sourcePath?.trim()
  if (!source)
    return

  try {
    await access(targetPath)
    return
  }
  catch {
    // Missing target is the expected first-launch migration case.
  }

  await copyFile(source, targetPath)
  await chmod(targetPath, 0o600)
}

function installApplicationMenu(): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate(createApplicationMenuTemplate(productName, () => app.quit())))
}

async function openDashboardWindow(url: string): Promise<void> {
  if (mainWindow) {
    if (mainWindow.isMinimized())
      mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
    return
  }

  mainWindow = new BrowserWindow({
    backgroundColor: '#101010',
    height: 760,
    minHeight: 560,
    minWidth: 560,
    show: false,
    title: 'Settings',
    width: 620,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  const dashboardOrigin = new URL(url).origin
  mainWindow.webContents.on('will-navigate', (event, navigationUrl) => {
    try {
      if (new URL(navigationUrl).origin === dashboardOrigin)
        return
    }
    catch {
      // Invalid navigation targets are denied below.
    }

    event.preventDefault()
  })
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.once('ready-to-show', () => mainWindow?.show())
  mainWindow.on('closed', () => {
    mainWindow = undefined
    app.quit()
  })
  await mainWindow.loadURL(url)
}

/**
 * Starts the packaged Discord app without relying on a source checkout.
 *
 * Call stack:
 *
 * startPackagedApp
 *   -> {@link startStandaloneDiscordAppRuntime}
 *   -> {@link openDashboardWindow}
 */
async function startPackagedApp(): Promise<void> {
  const userDataPath = app.getPath('userData')
  await mkdir(userDataPath, { recursive: true })
  try {
    runtimeLog = await installStandaloneRuntimeFileLogging({
      filePath: join(userDataPath, 'logs', 'runtime.log'),
    })
    restoreConsoleFileLog = runtimeLog.restore
    console.info(`[${productName}] runtime-log-ready`)
  }
  catch {
    recordPackagedAppFailure('runtime-log-init-failed')
    await stopPackagedApp(1)
    return
  }
  const envFilePath = join(userDataPath, '.env.local')
  await importLegacyFile(process.env.AIRI_DISCORD_IMPORT_ENV_PATH, envFilePath)
  await importLegacyFile(
    process.env.AIRI_DISCORD_IMPORT_MEMORY_PATH,
    join(userDataPath, '.airi-discord-memory.json'),
  )

  runtime = await startStandaloneDiscordAppRuntime({
    env: {
      ...process.env,
      AIRI_DISCORD_DASHBOARD_ENABLED: 'true',
      AIRI_DISCORD_DASHBOARD_HOST: '127.0.0.1',
      AIRI_DISCORD_DASHBOARD_PORT: process.env.AIRI_DISCORD_DASHBOARD_PORT || '6122',
      AIRI_DISCORD_MODE: 'standalone',
      AIRI_DISCORD_RUNTIME_LOG_PATH: runtimeLog?.filePath ?? '',
    },
    envFilePath,
    stateFilePath: join(userDataPath, '.airi-discord-dashboard-state.json'),
  })
  if (!runtime.dashboardAddress)
    throw new Error('Standalone dashboard did not start.')

  await openDashboardWindow(runtime.dashboardAddress.url)
}

async function stopPackagedApp(initialExitCode = 0): Promise<void> {
  if (cleanupStarted)
    return

  cleanupStarted = true
  let exitCode = initialExitCode
  try {
    await runtime?.stop()
  }
  catch {
    exitCode = 1
    console.error(`[${productName}] runtime-stop-failed`)
  }
  finally {
    try {
      await runtimeLog?.close()
    }
    catch {
      exitCode = 1
      recordPackagedAppFailure('runtime-log-close-failed')
    }
    finally {
      restoreConsoleFileLog()
      app.exit(exitCode)
    }
  }
}

const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
}
else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized())
        mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    }
  })

  app.on('before-quit', (event) => {
    if (cleanupStarted)
      return

    event.preventDefault()
    void stopPackagedApp()
  })

  app.on('window-all-closed', () => app.quit())
  app.on('activate', () => {
    if (!mainWindow && runtime?.dashboardAddress) {
      void openDashboardWindow(runtime.dashboardAddress.url).catch(() => {
        recordPackagedAppFailure('dashboard-window-open-failed')
      })
    }
  })

  app.whenReady()
    .then(async () => {
      installApplicationMenu()
      await startPackagedApp()
    })
    .catch(() => {
      recordPackagedAppFailure('startup-failed')
      dialog.showErrorBox(`${productName} 启动失败`, '启动失败（startup-failed）。')
      void stopPackagedApp(1)
    })
}

process.on('SIGINT', () => app.quit())
process.on('SIGTERM', () => app.quit())
