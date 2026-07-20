import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

const { appendFileMock, renameMock } = vi.hoisted(() => ({ appendFileMock: vi.fn(), renameMock: vi.fn() }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  appendFileMock.mockImplementation(actual.appendFile)
  renameMock.mockImplementation(actual.rename)
  return { ...actual, appendFile: appendFileMock, rename: renameMock }
})

const { installStandaloneRuntimeFileLogging } = await import('./rotating-file-log')

const temporaryDirectories: string[] = []
const levels = ['debug', 'error', 'info', 'log', 'warn'] as const

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { force: true, recursive: true })))
})

async function createLogPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'airi-rotating-log-'))
  temporaryDirectories.push(directory)
  return join(directory, 'runtime.log')
}

function createConsoleTarget() {
  const entries: unknown[][] = []
  const record = (...values: unknown[]) => entries.push(values)
  const target: Pick<Console, typeof levels[number]> = {
    debug: record,
    error: record,
    info: record,
    log: record,
    warn: record,
  }
  return { entries, target }
}

/** @example describe('installStandaloneRuntimeFileLogging', () => {}) */
describe('installStandaloneRuntimeFileLogging', () => {
  /** @example it('owns writing and exposes only lifecycle operations', async () => {}) */
  it('owns writing and exposes only lifecycle operations', async () => {
    const filePath = await createLogPath()
    const { target } = createConsoleTarget()
    const handle = await installStandaloneRuntimeFileLogging({ consoleTarget: target, filePath })

    expect(Object.keys(handle).sort()).toEqual(['close', 'filePath', 'restore'])
    expect(handle).not.toHaveProperty('append')
    expect(handle).not.toHaveProperty('write')
    await handle.close()
  })

  /** @example it('redacts hostile console values while retaining fixed method categories', async () => {}) */
  it('redacts hostile console values while retaining fixed method categories', async () => {
    const filePath = await createLogPath()
    const { entries, target } = createConsoleTarget()
    const sentinel = 'private-message https://synthetic.invalid/path?token=secret body=private-body'
    const circular: { nested?: unknown, sentinel: string } = { sentinel }
    circular.nested = circular
    const throwingGetter = Object.defineProperty({}, 'secret', {
      get() {
        throw new Error(sentinel)
      },
    })
    const throwingProxy = new Proxy({}, {
      get() { throw new Error(sentinel) },
      getOwnPropertyDescriptor() { throw new Error(sentinel) },
      ownKeys() { throw new Error(sentinel) },
    })
    const hostileError = new Error(sentinel, { cause: { body: sentinel, nested: [sentinel] } })
    hostileError.name = sentinel
    hostileError.stack = sentinel
    const handle = await installStandaloneRuntimeFileLogging({ consoleTarget: target, filePath })

    const values = [hostileError, sentinel, new URL(`https://synthetic.invalid/${sentinel}`), { body: sentinel, url: sentinel }, [sentinel], Symbol(sentinel), 1n, circular, throwingGetter, throwingProxy]
    for (const level of levels)
      target[level](...values)
    await handle.close()

    const persisted = await readFile(filePath, 'utf8')
    const observed = JSON.stringify(entries)
    for (const category of ['console-debug', 'console-error', 'console-info', 'console-log', 'console-warn'])
      expect(persisted).toContain(category)
    for (const forbidden of [sentinel, 'synthetic.invalid', 'private-body', tmpdir()]) {
      expect(persisted).not.toContain(forbidden)
      expect(observed).not.toContain(forbidden)
    }
  })

  /** @example it('rotates securely and keeps generations bounded', async () => {}) */
  it('rotates securely and keeps generations bounded', async () => {
    const filePath = await createLogPath()
    const { target } = createConsoleTarget()
    const handle = await installStandaloneRuntimeFileLogging({ backupCount: 2, consoleTarget: target, filePath, maxBytes: 30 })
    for (let index = 0; index < 6; index += 1)
      target.log(index)
    await handle.close()

    expect((await stat(filePath)).mode & 0o777).toBe(0o600)
    expect((await stat(`${filePath}.1`)).mode & 0o777).toBe(0o600)
    expect((await stat(`${filePath}.2`)).mode & 0o777).toBe(0o600)
    await expect(stat(`${filePath}.3`)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  /** @example it('recovers the serialized queue after an append failure', async () => {}) */
  it('recovers the serialized queue after an append failure', async () => {
    const filePath = await createLogPath()
    const { entries, target } = createConsoleTarget()
    const sentinel = 'synthetic-private-filesystem-error https://synthetic.invalid/secret'
    appendFileMock.mockRejectedValueOnce(new Error(sentinel))
    const handle = await installStandaloneRuntimeFileLogging({ backupCount: 1, consoleTarget: target, filePath, maxBytes: 1 })
    target.info('append failure')
    target.warn('recovery write')
    await handle.close()

    const persisted = await readFile(filePath, 'utf8')
    const observed = JSON.stringify(entries)
    expect(persisted).toContain('console-warn')
    expect(observed).toContain('runtime-log-append-failure')
    expect(persisted).not.toContain(sentinel)
    expect(observed).not.toContain(sentinel)
  })

  /** @example it('recovers the serialized queue after a rotation failure', async () => {}) */
  it('recovers the serialized queue after a rotation failure', async () => {
    const filePath = await createLogPath()
    const { entries, target } = createConsoleTarget()
    const sentinel = 'synthetic-private-rotation-error https://synthetic.invalid/secret'
    renameMock.mockRejectedValueOnce(new Error(sentinel))
    const handle = await installStandaloneRuntimeFileLogging({ backupCount: 1, consoleTarget: target, filePath, maxBytes: 1 })
    target.info('first write')
    target.warn('rotation failure')
    target.log('recovery write')
    await handle.close()

    const persisted = await readFile(filePath, 'utf8')
    const observed = JSON.stringify(entries)
    expect(persisted).toContain('console-log')
    expect(observed).toContain('runtime-log-append-failure')
    expect(persisted).not.toContain(sentinel)
    expect(observed).not.toContain(sentinel)
  })

  /** @example it('keeps the queue usable when the safe failure reporter throws after a filesystem append failure', async () => {}) */
  it('keeps the queue usable when the safe failure reporter throws after a filesystem append failure', async () => {
    const filePath = await mkdtemp(join(tmpdir(), 'airi-rotating-log-directory-'))
    temporaryDirectories.push(filePath)
    const { entries, target } = createConsoleTarget()
    const reporterFailure = new Error('synthetic reporter failure')
    target.error = vi.fn((...values: unknown[]) => {
      entries.push(values)
      throw reporterFailure
    })
    const originalError = target.error
    const handle = await installStandaloneRuntimeFileLogging({ consoleTarget: target, filePath })

    // A directory at the active-log path makes the production append fail with
    // EISDIR. Removing it restores the exact filesystem boundary for the next
    // queued event without substituting the logger implementation.
    target.info('append-to-directory')
    await vi.waitFor(() => expect(originalError).toHaveBeenCalledOnce())
    await rm(filePath, { force: true, recursive: true })
    target.warn('write-after-filesystem-recovery')

    await expect(handle.close()).resolves.toBeUndefined()
    await expect(readFile(filePath, 'utf8')).resolves.toContain('console-warn')
    expect(JSON.stringify(entries)).not.toContain(reporterFailure.message)
  })

  /** @example it('restores only its own wrappers, idempotently', async () => {}) */
  it('restores only its own wrappers, idempotently', async () => {
    const filePath = await createLogPath()
    const { target } = createConsoleTarget()
    const original = target.info
    const handle = await installStandaloneRuntimeFileLogging({ consoleTarget: target, filePath })
    const laterWrapper = () => undefined
    target.info = laterWrapper

    handle.restore()
    handle.restore()
    expect(target.info).toBe(laterWrapper)
    target.info = original
    await handle.close()
  })

  /** @example it('flushes pre-close events, keeps redaction while closing, then stops appends', async () => {}) */
  it('flushes pre-close events, keeps redaction while closing, then stops appends', async () => {
    const filePath = await createLogPath()
    const { entries, target } = createConsoleTarget()
    const original = target.info
    const handle = await installStandaloneRuntimeFileLogging({ consoleTarget: target, filePath })
    target.info('before-close')
    const firstClose = handle.close()
    target.info('late-private-value')
    const secondClose = handle.close()
    expect(secondClose).toBe(firstClose)
    await firstClose
    const persisted = await readFile(filePath, 'utf8')
    expect(persisted).toContain('console-info')
    expect(persisted).not.toContain('late-private-value')
    expect(JSON.stringify(entries)).not.toContain('late-private-value')
    expect(target.info).not.toBe(original)
    target.info('after-close-private-value')
    expect((await readFile(filePath, 'utf8'))).toBe(persisted)
    handle.restore()
    expect(target.info).toBe(original)
  })
})
