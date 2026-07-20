import type { ChildProcess, SpawnOptions } from 'node:child_process'

import { spawn } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

const temporaryDirectories: string[] = []
const launcherPath = resolve(import.meta.dirname, '../../../scripts/dev-airi-discord.command')

interface ProcessResult {
  code: number | null
  signal: NodeJS.Signals | null
  stderr: string
  stdout: string
}

async function createLauncherSandbox(mode: 'exit' | 'signal') {
  const root = await mkdtemp(join(tmpdir(), 'airi-discord-launcher-'))
  temporaryDirectories.push(root)

  const home = join(root, 'home')
  const fakeBin = join(home, 'Library', 'pnpm')
  const tracePath = join(root, 'launcher.trace')
  const configPath = join(
    home,
    'Library',
    'Application Support',
    '@proj-airi',
    'stage-tamagotchi',
    'server-channel-config.json',
  )
  const syntheticToken = 'synthetic-d031-auth-token-sentinel'

  await mkdir(fakeBin, { recursive: true })
  await mkdir(dirname(configPath), { recursive: true })
  await writeFile(configPath, JSON.stringify({ authToken: syntheticToken }), 'utf8')

  const fakeNode = join(fakeBin, 'node')
  await writeFile(fakeNode, `#!/bin/zsh
print -r -- "node:$*" >> "$LAUNCHER_TRACE"
last_arg="\${@: -1}"
if [[ "$last_arg" == <-> ]]; then
  exit 0
fi
exec ${JSON.stringify(process.execPath)} "$@"
`, 'utf8')
  await chmod(fakeNode, 0o755)

  const fakePnpm = join(fakeBin, 'pnpm')
  await writeFile(fakePnpm, `#!/bin/zsh
print -r -- "pnpm:$*" >> "$LAUNCHER_TRACE"
print -r -- "airi-token:\${AIRI_TOKEN-<unset>}" >> "$LAUNCHER_TRACE"

if [[ "$FAKE_PNPM_MODE" == "signal" ]]; then
  trap 'print -r -- "signal:SIGINT" >> "$LAUNCHER_TRACE"; exit 130' INT
  trap 'print -r -- "signal:SIGTERM" >> "$LAUNCHER_TRACE"; exit 143' TERM
  print -r -- "ready" >> "$LAUNCHER_TRACE"
  while true; do
    sleep 0.1
  done
fi

sleep 1
exit 23
`, 'utf8')
  await chmod(fakePnpm, 0o755)

  const spawnOptions: SpawnOptions = {
    cwd: resolve(import.meta.dirname, '../../..'),
    env: {
      FAKE_PNPM_MODE: mode,
      HOME: home,
      LANG: 'C',
      LAUNCHER_TRACE: tracePath,
      PATH: '/usr/bin:/bin',
      SERVER_CHANNEL_PORT: '63131',
      TMPDIR: root,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  }

  return {
    spawnOptions,
    syntheticToken,
    tracePath,
  }
}

function waitForProcess(child: ChildProcess): Promise<ProcessResult> {
  return new Promise((resolveProcess, rejectProcess) => {
    let stdout = ''
    let stderr = ''

    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', chunk => stdout += chunk)
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', chunk => stderr += chunk)
    child.once('error', rejectProcess)
    child.once('close', (code, signal) => {
      resolveProcess({ code, signal, stderr, stdout })
    })
  })
}

async function waitForTrace(tracePath: string, expected: string): Promise<string> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const trace = await readFile(tracePath, 'utf8').catch(() => '')
    if (trace.includes(expected))
      return trace
    await new Promise(resolveWait => setTimeout(resolveWait, 20))
  }
  throw new Error(`Launcher trace did not reach the expected synthetic state: ${expected}`)
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { force: true, recursive: true })))
})

/**
 * @example
 * describe('discord launcher contract', () => {})
 */
describe('discord launcher contract', () => {
  /**
   * @example
   * it('for Discord audit D-031, delegates only to Tamagotchi Main', async () => {})
   */
  it('for Discord audit D-031, delegates only to Tamagotchi Main', async () => {
    // ROOT CAUSE:
    //
    // The legacy shortcut parsed Main's plaintext server-channel JSON, exported
    // that credential, then started a second source-level Discord process.
    // This bypassed the supported Main-owned protected-storage/MessagePort flow.
    //
    // Before: the fake external bot observes the synthetic JSON credential.
    // After: the real launcher replaces itself with Tamagotchi only; Electron
    // Main owns the internal Discord utility process and every secret handoff.
    const sandbox = await createLauncherSandbox('exit')
    const child = spawn('/bin/zsh', [launcherPath], sandbox.spawnOptions)
    const result = await waitForProcess(child)
    const trace = await readFile(sandbox.tracePath, 'utf8')
    const serializedEvidence = JSON.stringify({ result, trace })
    const pnpmInvocations = trace
      .split('\n')
      .filter(line => line.startsWith('pnpm:'))

    // @example
    expect({
      leakedSyntheticToken: serializedEvidence.includes(sandbox.syntheticToken),
      nodeInvocationCount: trace.split('\n').filter(line => line.startsWith('node:')).length,
      pnpmInvocations,
    }).toEqual({
      leakedSyntheticToken: false,
      nodeInvocationCount: 0,
      pnpmInvocations: ['pnpm:-F @proj-airi/stage-tamagotchi dev'],
    })
    // @example
    expect(result).toEqual({
      code: 23,
      signal: null,
      stderr: '',
      stdout: expect.stringContaining('Configure and enable Discord in AIRI settings'),
    })
  }, 15_000)

  /**
   * @example
   * it('for Discord audit D-031, forwards SIGINT and SIGTERM to Tamagotchi', async () => {})
   */
  it('for Discord audit D-031, forwards SIGINT and SIGTERM to Tamagotchi', async () => {
    for (const [signal, expectedCode] of [['SIGINT', 130], ['SIGTERM', 143]] as const) {
      const sandbox = await createLauncherSandbox('signal')
      const child = spawn('/bin/zsh', [launcherPath], sandbox.spawnOptions)
      const resultPromise = waitForProcess(child)
      await waitForTrace(sandbox.tracePath, 'ready')

      child.kill(signal)

      const result = await resultPromise
      const trace = await readFile(sandbox.tracePath, 'utf8')

      // @example
      expect(result.code).toBe(expectedCode)
      // @example
      expect(result.signal).toBeNull()
      // @example
      expect(trace.split('\n').filter(line => line.startsWith('pnpm:'))).toEqual([
        'pnpm:-F @proj-airi/stage-tamagotchi dev',
      ])
      // @example
      expect(trace.split('\n').filter(line => line.startsWith('signal:'))).toEqual([`signal:${signal}`])
    }
  }, 15_000)
})
