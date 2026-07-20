import { Buffer } from 'node:buffer'
import { appendFile, chmod, mkdir, rename, rm, stat } from 'node:fs/promises'
import { dirname } from 'node:path'

/** Default two-megabyte active runtime log. */
const DEFAULT_STANDALONE_LOG_MAX_BYTES = 2 * 1024 * 1024

/** Keep three older log generations in addition to the active file. */
const DEFAULT_STANDALONE_LOG_BACKUP_COUNT = 3

const runtimeConsoleMethods = ['debug', 'error', 'info', 'log', 'warn'] as const

type RuntimeConsoleMethod = typeof runtimeConsoleMethods[number]
type RuntimeConsoleTarget = Pick<Console, RuntimeConsoleMethod>

/**
 * Options for the standalone runtime file-log owning boundary.
 */
export interface StandaloneRuntimeFileLoggingOptions {
  /** Number of older `filePath.N` generations retained. @default 3 */
  backupCount?: number
  /** Console-like external output target. @default globalThis.console */
  consoleTarget?: RuntimeConsoleTarget
  /** Absolute active log file path. */
  filePath: string
  /** Maximum active file size before rotation. @default 2097152 */
  maxBytes?: number
}

/**
 * Lifecycle controls for the installed standalone runtime logger.
 */
export interface StandaloneRuntimeFileLogging {
  /** Active runtime log file path. */
  readonly filePath: string
  /** Restores only console methods still owned by this installation. */
  restore: () => void
  /** Flushes pending writes and prevents all later file appends. */
  close: () => Promise<void>
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

async function fileSize(filePath: string): Promise<number> {
  try {
    return (await stat(filePath)).size
  }
  catch (error) {
    if (isMissingFileError(error))
      return 0
    throw error
  }
}

async function restrictLogFilePermissions(filePath: string): Promise<void> {
  try {
    await chmod(filePath, 0o600)
  }
  catch (error) {
    if (!isMissingFileError(error))
      throw error
  }
}

async function rotateLogFiles(filePath: string, backupCount: number): Promise<void> {
  if (backupCount <= 0) {
    await rm(filePath, { force: true })
    return
  }

  await rm(`${filePath}.${backupCount}`, { force: true })
  for (let generation = backupCount - 1; generation >= 1; generation -= 1) {
    try {
      await rename(`${filePath}.${generation}`, `${filePath}.${generation + 1}`)
    }
    catch (error) {
      if (!isMissingFileError(error))
        throw error
    }
  }

  try {
    await rename(filePath, `${filePath}.1`)
  }
  catch (error) {
    if (!isMissingFileError(error))
      throw error
  }
}

/**
 * Installs a fixed-schema runtime file logger and owns every disk append.
 *
 * Use when:
 * - The standalone Electron main process needs durable logs without serializing console arguments.
 * - A caller needs lifecycle-safe console redaction during shutdown.
 *
 * Expects:
 * - `filePath` to identify an application-owned log location.
 * - `consoleTarget` to be an actual console-like external output boundary.
 *
 * Returns:
 * - The active path plus idempotent restore and close lifecycle controls; no raw writer is exposed.
 */
export async function installStandaloneRuntimeFileLogging(options: StandaloneRuntimeFileLoggingOptions): Promise<StandaloneRuntimeFileLogging> {
  const backupCount = Math.max(0, Math.trunc(options.backupCount ?? DEFAULT_STANDALONE_LOG_BACKUP_COUNT))
  const maxBytes = Math.max(1, Math.trunc(options.maxBytes ?? DEFAULT_STANDALONE_LOG_MAX_BYTES))
  const consoleTarget = options.consoleTarget ?? console
  await mkdir(dirname(options.filePath), { recursive: true })
  await restrictLogFilePermissions(options.filePath)
  for (let generation = 1; generation <= backupCount; generation += 1)
    await restrictLogFilePermissions(`${options.filePath}.${generation}`)

  let currentSize = await fileSize(options.filePath)
  let closing = false
  let closePromise: Promise<void> | undefined
  let writeQueue = Promise.resolve()
  const originals = Object.fromEntries(runtimeConsoleMethods.map(method => [method, consoleTarget[method]])) as Record<RuntimeConsoleMethod, Console[RuntimeConsoleMethod]>
  const wrappers = {} as Record<RuntimeConsoleMethod, Console[RuntimeConsoleMethod]>

  const reportFailure = (category: 'runtime-log-append-failure' | 'runtime-log-close-failure') => {
    try {
      originals.error.call(consoleTarget, '[discord-bot:standalone] runtime-log-failure', { failureCategory: category })
    }
    catch {
      // Failure reporting is an external boundary and must never poison the write queue.
    }
  }

  const enqueue = (method: RuntimeConsoleMethod) => {
    if (closing)
      return

    const category = `console-${method}`
    const content = `[${new Date().toISOString()}] [${method.toUpperCase()}] ${category}\n`
    const contentBytes = Buffer.byteLength(content)
    writeQueue = writeQueue.then(async () => {
      if (currentSize > 0 && currentSize + contentBytes > maxBytes) {
        await rotateLogFiles(options.filePath, backupCount)
        currentSize = 0
      }
      await appendFile(options.filePath, content, { encoding: 'utf8', mode: 0o600 })
      currentSize += contentBytes
    }).catch(() => {
      reportFailure('runtime-log-append-failure')
    })
  }

  for (const method of runtimeConsoleMethods) {
    const wrapper = (..._values: unknown[]) => {
      originals[method].call(consoleTarget, `[discord-bot:standalone] console-${method}`)
      enqueue(method)
    }
    wrappers[method] = wrapper as Console[RuntimeConsoleMethod]
    consoleTarget[method] = wrappers[method]
  }

  const restore = () => {
    for (const method of runtimeConsoleMethods) {
      if (consoleTarget[method] === wrappers[method])
        consoleTarget[method] = originals[method]
    }
  }

  return {
    filePath: options.filePath,
    restore,
    close() {
      closePromise ??= (async () => {
        closing = true
        try {
          await writeQueue
        }
        catch {
          reportFailure('runtime-log-close-failure')
        }
      })()
      return closePromise
    },
  }
}
