import { defineStore } from 'pinia'

import { useModsServerChannelStore } from './mods/api/channel-server'

/** Host-owned transport that keeps protected module configuration off server-channel. */
export type SecureModuleConfigurationHandler = (config: Record<string, unknown>) => Promise<unknown> | unknown

const secureConfigurationHandlers = new Map<string, SecureModuleConfigurationHandler>()

/**
 * Registers a local protected configuration transport for one module.
 *
 * Use when:
 * - A host such as Electron Main owns secrets that cannot cross server-channel.
 *
 * Expects:
 * - The handler validates its renderer/host trust boundary before mutating state.
 *
 * Returns:
 * - A disposer that removes only the handler registered by this call.
 */
export function registerSecureModuleConfigurationHandler<TConfig extends object>(
  moduleName: string,
  handler: (config: TConfig) => Promise<unknown> | unknown,
): () => void {
  if (secureConfigurationHandlers.has(moduleName))
    throw new Error(`Secure configuration handler already registered for module: ${moduleName}`)

  const wrappedHandler: SecureModuleConfigurationHandler = config => handler(config as TConfig)
  secureConfigurationHandlers.set(moduleName, wrappedHandler)
  return () => {
    if (secureConfigurationHandlers.get(moduleName) === wrappedHandler)
      secureConfigurationHandlers.delete(moduleName)
  }
}

export const useConfiguratorByModsChannelServer = defineStore('configurator:adapter:proj-airi:server-sdk', () => {
  const { send } = useModsServerChannelStore()

  function updateFor(moduleName: string, config: Record<string, unknown>) {
    send({
      type: 'ui:configure' as const,
      data: {
        moduleName,
        config,
      },
    })
  }

  function updateSecureFor(moduleName: string, config: Record<string, unknown>) {
    const handler = secureConfigurationHandlers.get(moduleName)
    if (!handler)
      throw new Error(`No protected configuration transport is available for module: ${moduleName}`)

    return handler(config)
  }

  return {
    updateFor,
    updateSecureFor,
  }
})
