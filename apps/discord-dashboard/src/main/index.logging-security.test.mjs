import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { build } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const sourceDirectory = dirname(fileURLToPath(import.meta.url))
const sentinel = 'private-message https://synthetic.invalid/path?token=secret body=private-body'
let temporaryDirectory
let artifactPath
let appDataPath
let metafile

async function installExternalBoundaryStubs(directory) {
  const electronDirectory = join(directory, 'node_modules', 'electron')
  const discordBotDirectory = join(directory, 'node_modules', '@proj-airi', 'discord-bot')
  await mkdir(electronDirectory, { recursive: true })
  await mkdir(discordBotDirectory, { recursive: true })
  await writeFile(join(electronDirectory, 'package.json'), JSON.stringify({ exports: './index.js', name: 'electron', type: 'module' }))
  await writeFile(join(electronDirectory, 'index.js'), `
import { EventEmitter } from 'node:events'
class SyntheticApp extends EventEmitter {
  commandLine = { appendSwitch() {} }; paths = new Map()
  setName() {} setPath(key, value) { this.paths.set(key, value) }
  getPath(key) { return this.paths.get(key) || process.env.SYNTHETIC_APP_DATA }
  requestSingleInstanceLock() { return true } whenReady() { return Promise.resolve() }
  quit() { let prevented = false; this.emit('before-quit', { preventDefault() { prevented = true } }); if (!prevented) setImmediate(() => process.exit(0)) }
  exit(code) { setImmediate(() => process.exit(code)) }
}
export const app = new SyntheticApp()
export class BrowserWindow extends EventEmitter {
  webContents = { on() {}, setWindowOpenHandler() {} }; isMinimized() { return false }; restore() {}; show() {}; focus() {}
  async loadURL() { setImmediate(() => app.quit()) }
}
export const dialog = { showErrorBox(title, message) { process.stdout.write(JSON.stringify({ dialog: { title, message } }) + '\\n') } }
export const Menu = { buildFromTemplate(template) { return template }, setApplicationMenu() {} }
`)
  await writeFile(join(discordBotDirectory, 'package.json'), JSON.stringify({ exports: { './standalone-app': './standalone-app.js' }, name: '@proj-airi/discord-bot', type: 'module' }))
  await writeFile(join(discordBotDirectory, 'standalone-app.js'), `
export async function startStandaloneDiscordAppRuntime() {
  const sentinel = process.env.SYNTHETIC_SENTINEL
  const circular = { sentinel }; circular.self = circular
  const hostile = new Error(sentinel, { cause: { body: sentinel } }); hostile.name = sentinel; hostile.stack = sentinel
  const throwing = new Proxy({}, { get() { throw new Error(sentinel) }, ownKeys() { throw new Error(sentinel) }, getOwnPropertyDescriptor() { throw new Error(sentinel) } })
  for (const method of ['debug', 'error', 'info', 'log', 'warn']) console[method](hostile, sentinel, new URL('https://synthetic.invalid/' + sentinel), { url: sentinel, body: sentinel }, [sentinel], Symbol(sentinel), 1n, circular, throwing)
  return {
    dashboardAddress: { url: 'http://127.0.0.1:6122/' },
    async stop() {
      setImmediate(() => console.error('late-' + sentinel))
    },
  }
}
`)
}

async function runPackagedMain() {
  return await new Promise((resolveChild, rejectChild) => {
    const child = spawn(process.execPath, [artifactPath], { cwd: temporaryDirectory, env: { SYNTHETIC_APP_DATA: appDataPath, SYNTHETIC_SENTINEL: sentinel, TMPDIR: temporaryDirectory }, stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    let stdout = ''
    child.stderr.setEncoding('utf8')
    child.stdout.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
      rejectChild(new Error('Synthetic packaged Dashboard main did not settle.'))
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

beforeAll(async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), 'airi-discord-dashboard-main-'))
  appDataPath = join(temporaryDirectory, 'app-data')
  artifactPath = join(temporaryDirectory, 'index.mjs')
  await installExternalBoundaryStubs(temporaryDirectory)
  const result = await build({ bundle: true, entryPoints: [resolve(sourceDirectory, 'index.ts')], external: ['@proj-airi/discord-bot/standalone-app', 'electron'], format: 'esm', metafile: true, outfile: artifactPath, platform: 'node', target: 'node22' })
  metafile = result.metafile
})

afterAll(async () => {
  if (temporaryDirectory)
    await rm(temporaryDirectory, { force: true, recursive: true })
})

/** @example describe('packaged Dashboard main logging security', () => {}) */
describe('packaged Dashboard main logging security', () => {
  /** @example it('bundles and installs the production logger', async () => {}) */
  it('bundles and installs the production logger, retaining only fixed categories (P2-B)', async () => {
    const productionLogger = resolve(sourceDirectory, '../../../../services/discord-bot/src/standalone/rotating-file-log.ts')
    expect(Object.keys(metafile.inputs).some(input => resolve(input) === productionLogger)).toBe(true)
    const child = await runPackagedMain()
    const filePath = join(appDataPath, 'AIRI Discord', 'logs', 'runtime.log')
    const log = await readFile(filePath, 'utf8')
    const observations = JSON.stringify(child)
    for (const category of ['console-debug', 'console-error', 'console-info', 'console-log', 'console-warn'])
      expect(log).toContain(category)
    for (const forbidden of [sentinel, 'synthetic.invalid', 'private-body', appDataPath]) {
      expect(log).not.toContain(forbidden)
      expect(observations).not.toContain(forbidden)
    }
    expect((await stat(filePath)).mode & 0o777).toBe(0o600)
    expect(child.code).toBe(0)
  })

  it('fails closed when the bundled production logger cannot create its log directory (P1)', async () => {
    // The bundled logger is intentionally retained in this artifact. A file at
    // the required logs-directory path makes its real mkdir call fail before
    // any runtime code can install a console wrapper.
    await rm(appDataPath, { force: true, recursive: true })
    const userDataPath = join(appDataPath, 'AIRI Discord')
    await mkdir(userDataPath, { recursive: true })
    await writeFile(join(userDataPath, 'logs'), 'not-a-directory')

    const child = await runPackagedMain()
    const observations = JSON.stringify(child)
    const logPath = join(userDataPath, 'logs', 'runtime.log')

    expect({
      exitsSuccessfully: child.code === 0,
      exposesRawRuntimeContent: [sentinel, 'synthetic.invalid', 'private-body', appDataPath]
        .some(forbidden => observations.includes(forbidden)),
    }).toEqual({
      exitsSuccessfully: false,
      exposesRawRuntimeContent: false,
    })
    await expect(readFile(logPath, 'utf8')).rejects.toMatchObject({ code: 'ENOTDIR' })
  })
})
