const { execFile, spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const process = require('node:process')

const { app, BrowserWindow, Menu, shell } = require('electron')

const { probeDashboardReadiness, resolveDashboardRootUrl, waitForDashboardReadiness } = require('./readiness.cjs')

const repoDir = path.resolve(__dirname, '../..')
const defaultDashboardUrl = process.env.AIRI_DISCORD_DASHBOARD_URL || 'http://127.0.0.1:6122'
const electronIconPath = path.join(repoDir, 'apps/stage-tamagotchi/build/icon.icns')
const ansiEscapePattern = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')
const logFilePath = path.join(os.tmpdir(), 'airi-discord-dashboard-window.log')

let mainWindow
let botProcess
let dashboardUrl = defaultDashboardUrl
let isQuitting = false
let isLoadingDashboard = false
let isQuitCleanupStarted = false
let shouldStopDashboardPortOnQuit = false
let recentLog = ''

app.setName('AIRI Discord')
app.setPath('userData', path.join(app.getPath('appData'), 'AIRI Discord'))

const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
  process.exit(0)
}

function stripAnsi(input) {
  return input.replace(ansiEscapePattern, '')
}

function findPnpmBinary() {
  const homebrewPnpm = '/opt/homebrew/bin/pnpm'
  if (fs.existsSync(homebrewPnpm))
    return homebrewPnpm

  return 'pnpm'
}

function findLsofBinary() {
  const systemLsof = '/usr/sbin/lsof'
  if (fs.existsSync(systemLsof))
    return systemLsof

  return 'lsof'
}

function execFileText(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, {
      cwd: repoDir,
      env: {
        ...process.env,
        PATH: [
          '/usr/sbin',
          '/opt/homebrew/bin',
          '/usr/local/bin',
          process.env.PATH,
        ].filter(Boolean).join(':'),
      },
    }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout
        error.stderr = stderr
        reject(error)
        return
      }

      resolve(stdout.toString('utf-8'))
    })
  })
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function dashboardPort() {
  try {
    const url = new URL(dashboardUrl)
    return url.port || (url.protocol === 'https:' ? '443' : '80')
  }
  catch {
    return '6122'
  }
}

async function findDashboardListenerPids() {
  try {
    const output = await execFileText(findLsofBinary(), [
      '-nP',
      `-iTCP:${dashboardPort()}`,
      '-sTCP:LISTEN',
      '-t',
    ])
    return output
      .split(/\s+/)
      .map(value => value.trim())
      .filter(value => value && value !== String(process.pid))
  }
  catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 1)
      return []

    console.warn('[airi-discord-dashboard] failed to inspect dashboard port:', error.message ?? error)
    return []
  }
}

function signalPid(pid, signal) {
  try {
    process.kill(Number(pid), signal)
  }
  catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH')
      return

    console.warn(`[airi-discord-dashboard] failed to send ${signal} to pid ${pid}:`, error.message ?? error)
  }
}

function signalProcessGroupOrChild(childProcess, signal) {
  if (!childProcess?.pid)
    return

  try {
    process.kill(-childProcess.pid, signal)
    return
  }
  catch {
    // The child may have been started by an older launcher without its own process group.
  }

  try {
    childProcess.kill(signal)
  }
  catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH')
      return

    console.warn(`[airi-discord-dashboard] failed to send ${signal} to child:`, error.message ?? error)
  }
}

function isChildExited(childProcess) {
  return !childProcess || childProcess.exitCode !== null || childProcess.signalCode !== null
}

function waitForChildExit(childProcess, timeoutMs) {
  if (isChildExited(childProcess))
    return Promise.resolve(true)

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      childProcess.off('exit', onExit)
      resolve(false)
    }, timeoutMs)

    function onExit() {
      clearTimeout(timeout)
      resolve(true)
    }

    childProcess.once('exit', onExit)
  })
}

async function waitForDashboardPortRelease(timeoutMs) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const pids = await findDashboardListenerPids()
    if (!pids.length)
      return true

    await delay(150)
  }

  return false
}

function renderLoadingPage(message, detail = '') {
  const escapedMessage = message.replace(/[&<>"]/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
  })[char])
  const escapedDetail = detail.replace(/[&<>"]/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
  })[char])

  return `<!doctype html>
<html lang="zh-Hans">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>AIRI Discord</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: #f8f7fb;
      --panel: rgba(255, 255, 255, 0.88);
      --text: #22202a;
      --muted: #746d80;
      --line: rgba(50, 45, 60, 0.12);
      --accent: #f06a9b;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #121117;
        --panel: rgba(28, 26, 36, 0.92);
        --text: #f3edf7;
        --muted: #a8a0b7;
        --line: rgba(255, 255, 255, 0.12);
      }
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      background: var(--bg);
      color: var(--text);
    }
    section {
      width: min(520px, calc(100vw - 36px));
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel);
      padding: 22px;
      box-shadow: 0 18px 50px rgba(43, 35, 66, 0.12);
    }
    h1 {
      margin: 0 0 8px;
      font-size: 26px;
      letter-spacing: 0;
    }
    p {
      margin: 0;
      color: var(--muted);
      line-height: 1.55;
    }
    .pulse {
      width: 36px;
      height: 36px;
      border-radius: 999px;
      margin-bottom: 18px;
      background: var(--accent);
      animation: pulse 1.5s infinite ease-in-out;
    }
    pre {
      max-height: 160px;
      overflow: auto;
      margin: 14px 0 0;
      padding: 12px;
      border-radius: 8px;
      border: 1px solid var(--line);
      color: var(--muted);
      background: rgba(0, 0, 0, 0.04);
      white-space: pre-wrap;
      font-size: 12px;
    }
    @keyframes pulse {
      0%, 100% { transform: scale(0.92); opacity: 0.66; }
      50% { transform: scale(1); opacity: 1; }
    }
  </style>
</head>
<body>
  <section>
    <div class="pulse"></div>
    <h1>AIRI Discord</h1>
    <p>${escapedMessage}</p>
    ${escapedDetail ? `<pre>${escapedDetail}</pre>` : ''}
  </section>
</body>
</html>`
}

function loadInlinePage(message, detail = '') {
  if (!mainWindow)
    return

  void mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(renderLoadingPage(message, detail))}`)
}

function installApplicationMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: 'AIRI Discord Dashboard',
      submenu: [
        {
          accelerator: 'Command+Q',
          click: () => app.quit(),
          label: '退出 AIRI Discord Dashboard',
        },
      ],
    },
  ]))
}

function captureLog(chunk) {
  const text = stripAnsi(chunk.toString('utf-8'))
  recentLog = `${recentLog}${text}`.slice(-4000)
  fs.appendFile(logFilePath, text, () => {})
  const urlMatch = text.match(/http:\/\/(?:127\.0\.0\.1|localhost):\d+/)
  if (urlMatch)
    dashboardUrl = urlMatch[0]
}

function startBotProcess() {
  if (botProcess)
    return

  const pnpmBinary = findPnpmBinary()
  botProcess = spawn(pnpmBinary, ['dev:discord'], {
    cwd: repoDir,
    detached: true,
    env: {
      ...process.env,
      AIRI_DISCORD_DASHBOARD_ENABLED: 'true',
      AIRI_DISCORD_DASHBOARD_HOST: '127.0.0.1',
      AIRI_DISCORD_DASHBOARD_PORT: '6122',
      PATH: [
        '/opt/homebrew/bin',
        '/usr/local/bin',
        process.env.PATH,
      ].filter(Boolean).join(':'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  botProcess.stdout.on('data', captureLog)
  botProcess.stderr.on('data', captureLog)
  botProcess.on('exit', (code, signal) => {
    botProcess = undefined
    if (isQuitting)
      return

    const detail = recentLog || `进程退出，代码 ${code ?? 'unknown'}，信号 ${signal ?? 'none'}。`
    loadInlinePage('Discord bot 已停止，正在尝试重新启动。', detail)
    setTimeout(() => {
      if (!isQuitting)
        void loadDashboardWithBot()
    }, 1000).unref()
  })
}

async function loadDashboardWithBot() {
  if (isLoadingDashboard)
    return

  isLoadingDashboard = true
  loadInlinePage('正在启动独立 Discord bot，并准备 AIRI 风格 dashboard...', recentLog)

  try {
    let dashboardRootUrl
    try {
      dashboardRootUrl = resolveDashboardRootUrl(dashboardUrl)
    }
    catch (error) {
      loadInlinePage(error.message, recentLog)
      return
    }

    try {
      await probeDashboardReadiness(dashboardRootUrl)
      shouldStopDashboardPortOnQuit = true
      if (mainWindow)
        await mainWindow.loadURL(dashboardRootUrl)
      return
    }
    catch {
      startBotProcess()
    }

    try {
      await waitForDashboardReadiness(dashboardRootUrl, {
        isServiceRunning: () => !isChildExited(botProcess),
      })
      shouldStopDashboardPortOnQuit = true
      if (mainWindow)
        await mainWindow.loadURL(dashboardRootUrl)
    }
    catch (error) {
      loadInlinePage(error.message, recentLog)
    }
  }
  finally {
    isLoadingDashboard = false
  }
}

async function openDashboardWindow() {
  if (mainWindow) {
    if (mainWindow.isMinimized())
      mainWindow.restore()

    mainWindow.show()
    mainWindow.focus()
    void loadDashboardWithBot()
    return
  }

  mainWindow = new BrowserWindow({
    backgroundColor: '#101010',
    height: 760,
    icon: electronIconPath,
    minHeight: 560,
    minWidth: 560,
    show: true,
    title: 'Settings',
    width: 620,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  mainWindow.on('closed', () => {
    mainWindow = undefined
    app.quit()
  })

  loadInlinePage('正在启动独立 Discord bot，并准备 AIRI 风格 dashboard...')
  mainWindow.show()
  mainWindow.focus()
  await loadDashboardWithBot()
}

async function stopDashboardPortListeners() {
  if (!shouldStopDashboardPortOnQuit)
    return

  const termPids = await findDashboardListenerPids()
  for (const pid of termPids) {
    signalPid(pid, 'SIGTERM')
  }

  if (await waitForDashboardPortRelease(2500))
    return

  const killPids = await findDashboardListenerPids()
  for (const pid of killPids) {
    signalPid(pid, 'SIGKILL')
  }

  await waitForDashboardPortRelease(1000)
}

async function stopBotProcess() {
  const processToStop = botProcess
  botProcess = undefined

  if (processToStop && !isChildExited(processToStop)) {
    signalProcessGroupOrChild(processToStop, 'SIGINT')
    if (!await waitForChildExit(processToStop, 2500)) {
      signalProcessGroupOrChild(processToStop, 'SIGTERM')
      await waitForChildExit(processToStop, 1500)
    }
  }

  await stopDashboardPortListeners()
}

async function quitAfterCleanup() {
  if (isQuitCleanupStarted)
    return

  isQuitCleanupStarted = true
  isQuitting = true
  await stopBotProcess()
  app.exit(0)
}

app.whenReady().then(async () => {
  installApplicationMenu()
  await openDashboardWindow()
})

app.on('second-instance', () => {
  void openDashboardWindow()
})

app.on('activate', () => {
  if (!mainWindow)
    void openDashboardWindow()
})

app.on('before-quit', (event) => {
  if (isQuitCleanupStarted)
    return

  event.preventDefault()
  void quitAfterCleanup()
})

app.on('window-all-closed', () => {
  app.quit()
})

process.on('SIGINT', () => {
  void quitAfterCleanup()
})

process.on('SIGTERM', () => {
  void quitAfterCleanup()
})
