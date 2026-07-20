import type { Server } from 'node:http'

import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import {
  probeDashboardReadiness,
  waitForDashboardReadiness,
} from '../../../../scripts/airi-discord-dashboard-window/readiness.cjs'

const wrapperPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../scripts/airi-discord-dashboard-window/main.cjs')
const servers: Server[] = []
const tempDirectories: string[] = []

afterEach(async () => {
  await Promise.allSettled(servers.splice(0).map(server => new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => {
      if (error)
        rejectClose(error)
      else
        resolveClose()
    })
  })))
  await Promise.all(tempDirectories.splice(0).map(directory => rm(directory, { force: true, recursive: true })))
})

async function runDashboardWindow(address: string): Promise<{ code: number | null, stderr: string, stdout: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'airi-dashboard-window-'))
  tempDirectories.push(directory)
  const electronModuleDirectory = join(directory, 'node_modules', 'electron')
  await mkdir(electronModuleDirectory, { recursive: true })
  await writeFile(join(electronModuleDirectory, 'index.js'), `
const { EventEmitter } = require('node:events')

const app = new EventEmitter()
app.setName = () => {}
app.setPath = () => {}
app.getPath = () => process.env.HOME
app.requestSingleInstanceLock = () => true
app.quit = () => {}
app.exit = code => process.exit(code)
app.whenReady = () => Promise.resolve()

class BrowserWindow extends EventEmitter {
  constructor() {
    super()
    this.webContents = { setWindowOpenHandler() {} }
  }

  async loadURL(url) {
    if (/^https?:/.test(url)) {
      process.stdout.write('WINDOW_URL ' + url + '\\n')
      setImmediate(() => process.exit(0))
    }
  }

  isMinimized() { return false }
  restore() {}
  show() {}
  focus() {}
}

module.exports = {
  app,
  BrowserWindow,
  Menu: {
    buildFromTemplate: value => value,
    setApplicationMenu() {},
  },
  shell: { async openExternal() {} },
}
`)

  return await new Promise((resolveChild, rejectChild) => {
    const child = spawn(process.execPath, [wrapperPath], {
      cwd: resolve(dirname(wrapperPath), '../..'),
      env: {
        AIRI_DISCORD_DASHBOARD_URL: address,
        HOME: directory,
        NODE_PATH: join(directory, 'node_modules'),
        PATH: process.env.PATH ?? '',
        TMPDIR: directory,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    let stdout = ''
    child.stderr.setEncoding('utf8')
    child.stdout.setEncoding('utf8')
    child.stderr.on('data', chunk => stderr += chunk)
    child.stdout.on('data', chunk => stdout += chunk)
    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
      rejectChild(new Error('Synthetic Dashboard window did not complete.'))
    }, 5_000)
    child.once('error', (error) => {
      clearTimeout(timeout)
      rejectChild(error)
    })
    child.once('close', (code) => {
      clearTimeout(timeout)
      resolveChild({ code, stderr, stdout })
    })
  })
}

/**
 * @example
 * describe('legacy Dashboard window readiness protocol', () => {})
 */
describe('legacy Dashboard window readiness protocol', () => {
  /**
   * @example
   * it('probes healthz and then loads the capability-bootstrapping root page', async () => {})
   */
  it('probes healthz and then loads the capability-bootstrapping root page (Discord audit D-032)', async () => {
    // ROOT CAUSE:
    //
    // The wrapper hard-codes `/api/status` as its readiness URL even though that
    // endpoint requires a capability that only the root HTML can bootstrap.
    // This test executes the real wrapper entrypoint in an isolated child and
    // records its actual HTTP request instead of duplicating the path constant.
    const requestedPaths: string[] = []
    const server = createServer((request, response) => {
      requestedPaths.push(request.url ?? '')
      response.writeHead(request.url === '/healthz' ? 204 : 200)
      response.end()
    })
    servers.push(server)
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once('error', rejectListen)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', rejectListen)
        resolveListen()
      })
    })
    const address = server.address()
    if (typeof address !== 'object' || !address)
      throw new Error('Synthetic Dashboard server did not return a TCP address.')

    const dashboardUrl = `http://127.0.0.1:${address.port}`
    const result = await runDashboardWindow(dashboardUrl)

    // @example
    expect(result.code).toBe(0)
    // @example
    expect(result.stderr).toBe('')
    // @example
    expect(requestedPaths).toEqual(['/healthz'])
    // @example
    expect(result.stdout).toContain(`WINDOW_URL ${dashboardUrl}/`)
    // @example
    expect(result.stdout).not.toContain('/api/status')
  })

  /**
   * @example
   * it('accepts only 2xx readiness and reports request timeout without response details', async () => {})
   */
  it('accepts only 2xx readiness and reports request timeout without response details (Discord audit D-032)', async () => {
    // ROOT CAUSE:
    //
    // A readiness wrapper that accepts any HTTP response would treat a secured
    // 403 or an unrelated 404 as ready. A request with no response also needs a
    // bounded, sanitized failure instead of hanging the Electron lifecycle.
    let responseMode: 'not-ready' | 'timeout' = 'not-ready'
    const server = createServer((_request, response) => {
      if (responseMode === 'timeout')
        return

      response.writeHead(503)
      response.end('synthetic-response-body-must-not-surface')
    })
    servers.push(server)
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once('error', rejectListen)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', rejectListen)
        resolveListen()
      })
    })
    const address = server.address()
    if (typeof address !== 'object' || !address)
      throw new Error('Synthetic Dashboard server did not return a TCP address.')
    const dashboardUrl = `http://127.0.0.1:${address.port}`

    // @example
    await expect(probeDashboardReadiness(`${dashboardUrl}/api/status`)).rejects.toMatchObject({
      code: 'DASHBOARD_URL_INVALID',
      message: 'Dashboard readiness URL is invalid.',
    })

    // @example
    await expect(probeDashboardReadiness(dashboardUrl)).rejects.toMatchObject({
      code: 'DASHBOARD_NOT_READY',
      message: 'Dashboard is not ready.',
    })

    responseMode = 'timeout'
    // @example
    await expect(probeDashboardReadiness(dashboardUrl, { requestTimeoutMs: 20 })).rejects.toMatchObject({
      code: 'DASHBOARD_REQUEST_TIMEOUT',
      message: 'Dashboard readiness request timed out.',
    })
  })

  /**
   * @example
   * it('rejects non-loopback and credential-bearing readiness URLs before transport', async () => {})
   */
  it('rejects non-loopback and credential-bearing readiness URLs before transport (Discord audit D-032)', async () => {
    // ROOT CAUSE:
    //
    // Checking only the `http:` protocol permits an environment override to
    // direct the wrapper at a remote host or embed HTTP Basic credentials. The
    // wrapper must fail before transport and never load such a URL.
    // @example
    await expect(probeDashboardReadiness('http://remote.invalid:6122')).rejects.toMatchObject({
      code: 'DASHBOARD_URL_INVALID',
      message: 'Dashboard readiness URL is invalid.',
    })
    // @example
    await expect(probeDashboardReadiness('http://synthetic-user:synthetic-password@127.0.0.1:6122')).rejects.toMatchObject({
      code: 'DASHBOARD_URL_INVALID',
      message: 'Dashboard readiness URL is invalid.',
    })
    // @example
    await expect(probeDashboardReadiness('http://127.0.0.1:6122/?capability=synthetic-value')).rejects.toMatchObject({
      code: 'DASHBOARD_URL_INVALID',
      message: 'Dashboard readiness URL is invalid.',
    })
    // @example
    await expect(probeDashboardReadiness('http://127.0.0.1:6122/#synthetic-fragment')).rejects.toMatchObject({
      code: 'DASHBOARD_URL_INVALID',
      message: 'Dashboard readiness URL is invalid.',
    })
  })

  /**
   * @example
   * it('fails immediately after the owned process exits and bounds ordinary retries', async () => {})
   */
  it('fails immediately after the owned process exits and bounds ordinary retries (Discord audit D-032)', async () => {
    // ROOT CAUSE:
    //
    // The old wait loop swallowed every readiness failure for all 40 retries,
    // even after the exact bot child had exited. That hid the terminal lifecycle
    // state and delayed the wrapper's visible failure by the full retry window.
    const server = createServer((_request, response) => {
      response.writeHead(503)
      response.end()
    })
    servers.push(server)
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once('error', rejectListen)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', rejectListen)
        resolveListen()
      })
    })
    const address = server.address()
    if (typeof address !== 'object' || !address)
      throw new Error('Synthetic Dashboard server did not return a TCP address.')
    const dashboardUrl = `http://127.0.0.1:${address.port}`
    let processChecks = 0

    // @example
    await expect(waitForDashboardReadiness(dashboardUrl, {
      attempts: 5,
      delayMs: 1,
      isServiceRunning: () => ++processChecks === 1,
      requestTimeoutMs: 20,
    })).rejects.toMatchObject({
      code: 'DASHBOARD_PROCESS_EXITED',
      message: 'Dashboard process exited before readiness.',
    })

    // @example
    await expect(waitForDashboardReadiness(dashboardUrl, {
      attempts: 2,
      delayMs: 1,
      isServiceRunning: () => true,
      requestTimeoutMs: 20,
    })).rejects.toMatchObject({
      code: 'DASHBOARD_WAIT_TIMEOUT',
      message: 'Dashboard did not become ready.',
    })
  })
})
