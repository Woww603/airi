import { describe, expect, it } from 'vitest'

import { installConsoleWriteFailureGuard } from './console-write-guard'

type TestConsoleMethod = (...data: unknown[]) => void
type TestConsoleTarget = Record<'debug' | 'error' | 'info' | 'log' | 'warn', TestConsoleMethod>

function createConsoleTarget(method: TestConsoleMethod): TestConsoleTarget {
  return {
    debug: method,
    error: method,
    info: method,
    log: method,
    warn: method,
  }
}

/**
 * @example
 * describe('installConsoleWriteFailureGuard', () => {})
 */
describe('installConsoleWriteFailureGuard', () => {
  /**
   * @example
   * it('suppresses transient stdio write failures from console methods', () => {})
   */
  it('suppresses transient stdio write failures from console methods', () => {
    const writeError = Object.assign(new Error('write EIO'), {
      code: 'EIO',
      syscall: 'write',
    })
    let callCount = 0
    const consoleTarget = createConsoleTarget(() => {
      callCount += 1
      throw writeError
    })

    installConsoleWriteFailureGuard(consoleTarget)

    // @example
    expect(() => consoleTarget.log('boot message')).not.toThrow()
    // @example
    expect(callCount).toBe(1)
  })

  /**
   * @example
   * it('rethrows non-stdio console failures', () => {})
   */
  it('rethrows non-stdio console failures', () => {
    const unexpectedError = new Error('unexpected console failure')
    const consoleTarget = createConsoleTarget(() => {
      throw unexpectedError
    })

    installConsoleWriteFailureGuard(consoleTarget)

    // @example
    expect(() => consoleTarget.error('boot message')).toThrow(unexpectedError)
  })

  /**
   * @example
   * it('restores original console methods', () => {})
   */
  it('restores original console methods', () => {
    let callCount = 0
    const original = () => {
      callCount += 1
    }
    const consoleTarget = createConsoleTarget(original)
    const restore = installConsoleWriteFailureGuard(consoleTarget)

    restore()
    consoleTarget.info('after restore')

    // @example
    expect(callCount).toBe(1)
    // @example
    expect(consoleTarget.info).toBe(original)
  })
})
