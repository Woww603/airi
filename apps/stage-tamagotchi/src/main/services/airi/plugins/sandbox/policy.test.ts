import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  invokePluginSandboxLifecycle,
  resolvePluginSandboxEntrypoint,
  resolvePluginSandboxModuleRequest,
} from './policy'

const temporaryRoots: string[] = []

async function createPluginRoot() {
  const root = await mkdtemp(join(tmpdir(), 'airi-plugin-sandbox-'))
  temporaryRoots.push(root)
  return root
}

function createManifest(entrypoint: string) {
  return {
    apiVersion: 'v1' as const,
    kind: 'manifest.plugin.airi.moeru.ai' as const,
    name: 'sandbox-test-plugin',
    permissions: {},
    entrypoints: { electron: entrypoint },
  }
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

/**
 * Covers filesystem containment and module restrictions at the sandbox protocol edge.
 *
 * @example
 * describe('plugin sandbox path policy', () => {
 *   expect(entrypoint.entrypointUrl).toContain('airi-plugin://runtime-test/')
 * })
 */
describe('plugin sandbox path policy', () => {
  /**
   * Verifies a browser-compatible ESM entrypoint is mapped to the session origin.
   *
   * @example
   * it('maps a contained ESM entrypoint to the isolated protocol', async () => {
   *   expect(entrypoint.rootPath).toBe(root)
   * })
   */
  it('maps a contained ESM entrypoint to the isolated protocol', async () => {
    const root = await createPluginRoot()
    await writeFile(join(root, 'index.mjs'), 'export async function init() {}')

    const entrypoint = await resolvePluginSandboxEntrypoint({
      manifest: createManifest('./index.mjs?cacheBust=test'),
      loadOptions: { cwd: root, runtime: 'electron' },
      runtimeId: 'runtime-test',
    })

    expect(entrypoint.rootPath).toBe(await realpath(root))
    expect(entrypoint.entrypointUrl).toBe('airi-plugin://runtime-test/index.mjs?cacheBust=test')
  })

  /**
   * Verifies manifest paths cannot select arbitrary host files.
   *
   * @example
   * it('rejects absolute entrypoints', async () => {
   *   await expect(resolve()).rejects.toThrow('must be relative')
   * })
   */
  it('rejects absolute entrypoints', async () => {
    const root = await createPluginRoot()

    await expect(resolvePluginSandboxEntrypoint({
      manifest: createManifest(join(root, 'index.mjs')),
      loadOptions: { cwd: root, runtime: 'electron' },
      runtimeId: 'runtime-test',
    })).rejects.toThrow('must be relative')
  })

  /**
   * Verifies a symlink cannot escape the canonical manifest directory.
   *
   * @example
   * it('rejects symlink escapes', async () => {
   *   await expect(resolve()).rejects.toThrow('outside')
   * })
   */
  it('rejects symlink escapes', async () => {
    const root = await createPluginRoot()
    const outsideRoot = await createPluginRoot()
    await writeFile(join(outsideRoot, 'outside.mjs'), 'export async function init() {}')
    await symlink(join(outsideRoot, 'outside.mjs'), join(root, 'index.mjs'))

    await expect(resolvePluginSandboxEntrypoint({
      manifest: createManifest('./index.mjs'),
      loadOptions: { cwd: root, runtime: 'electron' },
      runtimeId: 'runtime-test',
    })).rejects.toThrow('outside')
  })

  /**
   * Verifies imported modules are constrained to browser ESM code inside the same root.
   *
   * @example
   * it('rejects non-JavaScript module requests', async () => {
   *   await expect(resolve()).rejects.toThrow('Unsupported')
   * })
   */
  it('rejects non-JavaScript module requests', async () => {
    const root = await createPluginRoot()
    await mkdir(join(root, 'nested'))
    await writeFile(join(root, 'nested', 'secrets.json'), '{}')

    await expect(resolvePluginSandboxModuleRequest({
      requestUrl: 'airi-plugin://runtime-test/nested/secrets.json',
      rootPath: root,
      runtimeId: 'runtime-test',
    })).rejects.toThrow('Unsupported plugin module extension')
  })
})

/**
 * Covers the fail-closed deadline around renderer-owned lifecycle calls.
 *
 * @example
 * describe('plugin sandbox lifecycle policy', () => {
 *   await expect(invoke()).rejects.toThrow('timed out')
 * })
 */
describe('plugin sandbox lifecycle policy', () => {
  /**
   * Verifies a responsive renderer returns before its deadline.
   *
   * @example
   * it('returns a lifecycle result before the deadline', async () => {
   *   await expect(invoke()).resolves.toBe('ready')
   * })
   */
  it('returns a lifecycle result before the deadline', async () => {
    await expect(invokePluginSandboxLifecycle({
      phase: 'initialization',
      timeoutMs: 100,
      invoke: async () => 'ready',
    })).resolves.toBe('ready')
  })

  /**
   * Verifies a renderer that never replies cannot hold plugin startup indefinitely.
   *
   * @example
   * it('aborts and rejects a lifecycle call at its deadline', async () => {
   *   await expect(invoke()).rejects.toThrow('timed out')
   * })
   */
  it('aborts and rejects a lifecycle call at its deadline', async () => {
    // ROOT CAUSE:
    //
    // If a sandbox preload or renderer crashes before installing its Eventa handlers, the invoke never receives a response.
    // This happens because Electron IPC has no automatic peer-startup timeout for the pending request.
    //
    // Before the patch, plugin loading remained pending until the entire Electron process was stopped.
    //
    // We fixed this by racing each lifecycle invocation against a deadline and aborting the Eventa request.
    // After the patch, the host rejects deterministically and disposes the failed runtime session.
    let operationSignal: AbortSignal | undefined

    await expect(invokePluginSandboxLifecycle({
      phase: 'module load',
      timeoutMs: 10,
      invoke: async (signal) => {
        operationSignal = signal
        return await new Promise<string>(() => {})
      },
    })).rejects.toThrow('Plugin sandbox module load timed out after 10ms.')

    expect(operationSignal?.aborted).toBe(true)
  })
})
