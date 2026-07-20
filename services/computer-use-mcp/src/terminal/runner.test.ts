import { execPath } from 'node:process'

import { describe, expect, it } from 'vitest'

import { createTestConfig } from '../test-fixtures'
import { createLocalShellRunner, TERMINAL_OUTPUT_MAX_CHARS } from './runner'

describe('createLocalShellRunner', () => {
  it('executes commands and keeps cwd sticky across calls', async () => {
    const runner = createLocalShellRunner(createTestConfig({
      terminalShell: '/bin/zsh',
    }))

    const first = await runner.execute({
      command: 'pwd',
      cwd: '/tmp',
    })
    const second = await runner.execute({
      command: 'pwd',
    })

    expect(first.exitCode).toBe(0)
    expect(first.effectiveCwd).toBe('/tmp')
    expect(first.stdout.trim()).toContain('/tmp')
    expect(second.effectiveCwd).toBe('/tmp')
    expect(runner.getState().effectiveCwd).toBe('/tmp')
  })

  it('returns non-zero exit codes without throwing', async () => {
    const runner = createLocalShellRunner(createTestConfig())
    const result = await runner.execute({
      command: 'exit 7',
    })

    expect(result.exitCode).toBe(7)
    expect(runner.getState().lastExitCode).toBe(7)
  })

  it('bounds captured stdout and stderr for large command output', async () => {
    // ROOT CAUSE:
    //
    // A login shell may emit startup diagnostics before the command runs. The
    // previous exact stderr-length assertion treated that valid shell output as
    // runner corruption, which made the test depend on the user's zsh setup.
    //
    // The runner must count those diagnostics, so stderr can exceed the command
    // payload while the captured value remains correctly bounded.
    const runner = createLocalShellRunner(createTestConfig())
    const result = await runner.execute({
      command: `${JSON.stringify(execPath)} -e "process.stdout.write('o'.repeat(20000)); process.stderr.write('e'.repeat(20000))"`,
    })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toHaveLength(TERMINAL_OUTPUT_MAX_CHARS)
    expect(result.stderr).toHaveLength(TERMINAL_OUTPUT_MAX_CHARS)
    expect(result.stdoutTruncated).toBe(true)
    expect(result.stderrTruncated).toBe(true)
    expect(result.stdoutOriginalLength).toBe(20_000)
    expect(result.stderrOriginalLength).toBeGreaterThanOrEqual(20_000)
  })

  it('resets the tracked state', async () => {
    const runner = createLocalShellRunner(createTestConfig())
    await runner.execute({
      command: 'pwd',
      cwd: '/tmp',
    })

    const reset = runner.resetState('test reset')
    expect(reset.effectiveCwd).toBe(process.cwd())
    expect(reset.lastExitCode).toBeUndefined()
    expect(reset.lastCommandSummary).toBeUndefined()
  })
})
