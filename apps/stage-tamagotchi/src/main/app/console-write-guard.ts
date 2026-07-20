const CONSOLE_METHOD_NAMES = ['debug', 'error', 'info', 'log', 'warn'] as const
const TRANSIENT_STDIO_ERROR_CODES = new Set(['EIO', 'EPIPE', 'EBADF'])

type ConsoleMethodName = typeof CONSOLE_METHOD_NAMES[number]
type ConsoleMethod = (...data: unknown[]) => void
type ConsoleMethodTarget = Record<ConsoleMethodName, ConsoleMethod>

function isTransientStdioError(error: unknown) {
  if (typeof error !== 'object' || error === null)
    return false

  const code = 'code' in error ? error.code : undefined
  return typeof code === 'string' && TRANSIENT_STDIO_ERROR_CODES.has(code)
}

/**
 * Guards Electron main-process console writes against detached stdio streams.
 *
 * Use when:
 * - The app is launched from a terminal, script, or launcher that may close stdout/stderr before AIRI exits.
 * - Logger calls should keep the app alive even when the terminal output stream is gone.
 *
 * Expects:
 * - The guard is installed before loggers start writing frequently.
 * - Only transient stdio write failures such as `EIO`, `EPIPE`, and `EBADF` should be suppressed.
 *
 * Returns:
 * - A restore function for tests and controlled teardown.
 */
export function installConsoleWriteFailureGuard(consoleTarget: ConsoleMethodTarget = console) {
  const originals = new Map<ConsoleMethodName, ConsoleMethod>()

  for (const methodName of CONSOLE_METHOD_NAMES) {
    const original = consoleTarget[methodName]
    originals.set(methodName, original)

    // NOTICE:
    // Electron can keep running after the launching terminal disappears, especially from .command launchers.
    // In that state Node's console stream may throw `write EIO`, and @guiiai/logg calls console methods directly.
    // Source/context: screenshot on 2026-06-10 showed `Error: write EIO` from `@guiiai/logg/dist/index.mjs`.
    // Removal condition: remove if @guiiai/logg catches console write failures or AIRI stops attaching to volatile stdio.
    consoleTarget[methodName] = (...data: unknown[]) => {
      try {
        original(...data)
      }
      catch (error) {
        if (!isTransientStdioError(error))
          throw error
      }
    }
  }

  return () => {
    for (const [methodName, original] of originals)
      consoleTarget[methodName] = original
  }
}
