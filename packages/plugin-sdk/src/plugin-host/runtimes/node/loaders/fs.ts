import type { definePlugin } from '../../../../plugin/define'
import type { ManifestV1, PluginLoadOptions } from '../../../shared/types'

import { isAbsolute, join } from 'node:path'
import { cwd } from 'node:process'

import { coercePluginFromModule } from '../../../../plugin/load'

function isPluginDefinition(value: unknown): value is ReturnType<typeof definePlugin> {
  return typeof value === 'object'
    && value !== null
    && 'setup' in value
    && typeof (value as { setup?: unknown }).setup === 'function'
}

/**
 * Loads plugin entrypoints from the local filesystem for the current runtime.
 *
 * Use when:
 * - The host needs to resolve a manifest entrypoint path
 * - The host needs to import either a lazy `definePlugin(...)` export or a concrete plugin module
 *
 * Expects:
 * - Entry points are valid importable module paths for the active runtime
 *
 * Returns:
 * - Filesystem-backed helpers for resolving and loading plugin entrypoints
 */
export class FileSystemLoader {
  /**
   * Resolve a manifest entrypoint for the requested runtime.
   *
   * Resolution order:
   * 1) `entrypoints.<runtime>`
   * 2) `entrypoints.default`
   * 3) `entrypoints.electron` (legacy fallback for current local plugin manifests)
   */
  resolveEntrypointFor(manifest: ManifestV1, options?: PluginLoadOptions) {
    const runtime = options?.runtime ?? 'electron'
    const root = options?.cwd ?? cwd()
    const entrypoint
      = manifest.entrypoints[runtime]
        ?? manifest.entrypoints.default
        ?? manifest.entrypoints.electron

    if (!entrypoint) {
      throw new Error(''
        + `Plugin entrypoint is required for runtime \`${runtime}\`. `
        + 'Define one of `entrypoints.<runtime>`, `entrypoints.default`, '
        + 'or `entrypoints.electron` in the plugin manifest.',
      )
    }

    return isAbsolute(entrypoint) ? entrypoint : join(root, entrypoint)
  }

  async loadLazyPluginFor(manifest: ManifestV1, options?: PluginLoadOptions) {
    const entrypoint = this.resolveEntrypointFor(manifest, options)
    const pluginModule = await import(entrypoint)

    if (isPluginDefinition(pluginModule)) {
      return pluginModule
    }

    if (typeof pluginModule === 'object' && pluginModule !== null) {
      const defaultExport = (pluginModule as { default?: unknown }).default
      if (isPluginDefinition(defaultExport)) {
        return defaultExport
      }
    }

    throw new Error('Plugin lazy loader expects a definePlugin(...) export.')
  }

  async loadPluginFor(manifest: ManifestV1, options?: PluginLoadOptions) {
    const entrypoint = this.resolveEntrypointFor(manifest, options)
    const pluginModule = await import(entrypoint)
    return coercePluginFromModule(pluginModule)
  }
}
