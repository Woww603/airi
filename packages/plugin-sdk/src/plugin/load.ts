import type { definePlugin } from './define'
import type { Plugin } from './shared'

function isPluginDefinition(value: unknown): value is ReturnType<typeof definePlugin> {
  return typeof value === 'object'
    && value !== null
    && 'setup' in value
    && typeof (value as { setup?: unknown }).setup === 'function'
}

/**
 * Resolves a dynamically imported module into the plugin lifecycle hook surface.
 *
 * Use when:
 * - A runtime loads a plugin entrypoint through dynamic `import()`
 * - A plugin exports either `definePlugin(...)`, a default hook object, or named hooks
 *
 * Expects:
 * - The module was loaded inside the runtime boundary selected by the application
 *
 * Returns:
 * - The concrete plugin hooks, or rejects when the module export shape is unsupported
 */
export async function coercePluginFromModule(moduleValue: unknown): Promise<Plugin> {
  if (isPluginDefinition(moduleValue)) {
    return await moduleValue.setup()
  }

  if (typeof moduleValue === 'object' && moduleValue !== null) {
    if ('default' in moduleValue && isPluginDefinition(moduleValue.default)) {
      return await moduleValue.default.setup()
    }

    if ('default' in moduleValue && typeof moduleValue.default === 'object' && moduleValue.default !== null) {
      const defaultPlugin = moduleValue.default as Plugin
      if (typeof defaultPlugin.init === 'function' || typeof defaultPlugin.setupModules === 'function') {
        return defaultPlugin
      }
    }

    const plugin = moduleValue as Plugin
    if (typeof plugin.init === 'function' || typeof plugin.setupModules === 'function') {
      return plugin
    }
  }

  throw new Error('Failed to resolve plugin module. The entrypoint must export either definePlugin(...) or Plugin hooks.')
}
