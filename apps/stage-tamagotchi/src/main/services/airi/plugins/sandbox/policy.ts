import type { ManifestV1, PluginLoadOptions, PluginRuntime } from '@proj-airi/plugin-sdk/plugin-host'

import { realpath, stat } from 'node:fs/promises'
import { extname, isAbsolute, relative, resolve, sep } from 'node:path'

export const pluginSandboxScheme = 'airi-plugin'

// Plugin code is loaded into memory by Chromium. Limiting each module prevents a
// single manifest from forcing an unbounded main-process allocation before execution.
const maxPluginModuleBytes = 8 * 1024 * 1024
const supportedPluginModuleExtensions = new Set(['.js', '.mjs'])

/** Resolved code location that is safe to expose through the plugin-only protocol. */
export interface PluginSandboxEntrypoint {
  /** Canonical plugin root used for every subsequent module request. */
  rootPath: string
  /** Custom-protocol URL imported by the sandbox renderer. */
  entrypointUrl: string
}

/**
 * Runs one renderer-owned plugin lifecycle operation within a hard deadline.
 *
 * Use when:
 * - Invoking plugin load, initialization, or module setup over Eventa
 * - A crashed or non-responsive sandbox must fail closed instead of blocking the host
 *
 * Expects:
 * - `invoke` forwards the supplied signal to Eventa when it supports cancellation
 * - `timeoutMs` is a positive finite duration
 *
 * Returns:
 * - The lifecycle result, or a phase-specific timeout error
 */
export async function invokePluginSandboxLifecycle<T>(input: {
  phase: string
  timeoutMs: number
  invoke: (signal: AbortSignal) => Promise<T>
}): Promise<T> {
  if (!Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0) {
    throw new Error('Plugin sandbox lifecycle timeout must be a positive finite number.')
  }

  const controller = new AbortController()
  let timeout: ReturnType<typeof setTimeout> | undefined
  const timeoutError = new Error(
    `Plugin sandbox ${input.phase} timed out after ${input.timeoutMs}ms.`,
  )
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      // Abort tells Eventa to cancel its pending invocation; rejecting the local race
      // also protects the host if a future transport fails to honor that signal.
      controller.abort(timeoutError)
      reject(timeoutError)
    }, input.timeoutMs)
  })

  try {
    return await Promise.race([
      input.invoke(controller.signal),
      deadline,
    ])
  }
  finally {
    if (timeout !== undefined) {
      clearTimeout(timeout)
    }
  }
}

function assertInsideRoot(rootPath: string, filePath: string) {
  const relativePath = relative(rootPath, filePath)
  if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error('Plugin module resolves outside its manifest directory.')
  }

  return relativePath
}

async function resolveAllowedModulePath(rootPath: string, relativePath: string) {
  const candidatePath = await realpath(resolve(rootPath, relativePath))
  assertInsideRoot(rootPath, candidatePath)

  const extension = extname(candidatePath).toLowerCase()
  if (!supportedPluginModuleExtensions.has(extension)) {
    throw new Error(`Unsupported plugin module extension: ${extension || '(none)'}`)
  }

  const fileStat = await stat(candidatePath)
  if (!fileStat.isFile()) {
    throw new Error('Plugin module must be a regular file.')
  }
  if (fileStat.size > maxPluginModuleBytes) {
    throw new Error(`Plugin module exceeds the ${maxPluginModuleBytes}-byte limit.`)
  }

  return candidatePath
}

function resolveDeclaredEntrypoint(manifest: ManifestV1, runtime: PluginRuntime) {
  const entrypoint
    = manifest.entrypoints[runtime]
      ?? manifest.entrypoints.default
      ?? manifest.entrypoints.electron

  if (!entrypoint) {
    throw new Error(`Plugin entrypoint is required for sandbox runtime \`${runtime}\`.`)
  }

  return entrypoint
}

/**
 * Resolves and validates the manifest entrypoint served to a sandbox renderer.
 *
 * Use when:
 * - Creating an Electron sandbox runtime for an untrusted local plugin
 *
 * Expects:
 * - `loadOptions.cwd` is the directory containing the validated manifest
 * - Plugin code is browser-compatible ESM ending in `.js` or `.mjs`
 *
 * Returns:
 * - A canonical root plus a custom-protocol URL that cannot escape that root
 */
export async function resolvePluginSandboxEntrypoint(input: {
  manifest: ManifestV1
  loadOptions: Required<PluginLoadOptions>
  runtimeId: string
}): Promise<PluginSandboxEntrypoint> {
  const declaredEntrypoint = resolveDeclaredEntrypoint(input.manifest, input.loadOptions.runtime)
  const baseUrl = new URL(`${pluginSandboxScheme}://${input.runtimeId}/`)
  const entrypointUrl = new URL(declaredEntrypoint, baseUrl)
  const declaredPath = decodeURIComponent(entrypointUrl.pathname.slice(1))

  if (entrypointUrl.origin !== baseUrl.origin || isAbsolute(declaredEntrypoint.split(/[?#]/u, 1)[0])) {
    throw new Error('Plugin sandbox entrypoint must be relative to its manifest directory.')
  }

  const rootPath = await realpath(input.loadOptions.cwd)
  const entrypointPath = await resolveAllowedModulePath(rootPath, declaredPath)
  const canonicalRelativePath = assertInsideRoot(rootPath, entrypointPath)

  // Custom protocol URLs always use POSIX separators, including on Windows hosts.
  entrypointUrl.pathname = `/${canonicalRelativePath.split(sep).map(encodeURIComponent).join('/')}`

  return {
    rootPath,
    entrypointUrl: entrypointUrl.toString(),
  }
}

/**
 * Resolves one custom-protocol module request against its canonical plugin root.
 *
 * Use when:
 * - Serving an entrypoint or one of its relative ESM imports to Chromium
 *
 * Expects:
 * - `requestUrl` uses the session-specific runtime host
 *
 * Returns:
 * - A canonical `.js` or `.mjs` file path contained by `rootPath`
 */
export async function resolvePluginSandboxModuleRequest(input: {
  requestUrl: string
  rootPath: string
  runtimeId: string
}) {
  const requestUrl = new URL(input.requestUrl)
  if (requestUrl.protocol !== `${pluginSandboxScheme}:` || requestUrl.host !== input.runtimeId) {
    throw new Error('Plugin module request does not belong to this sandbox runtime.')
  }

  const relativePath = decodeURIComponent(requestUrl.pathname.slice(1))
  const rootPath = await realpath(input.rootPath)
  return await resolveAllowedModulePath(rootPath, relativePath)
}
