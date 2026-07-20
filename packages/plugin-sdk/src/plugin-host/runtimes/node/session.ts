import type { PluginRuntimeSessionFactory } from '../../shared/types'

import { createPluginContext } from './context'
import { FileSystemLoader } from './loaders'

/**
 * Creates the trusted local-filesystem runtime used by Node hosts and tests.
 *
 * Use when:
 * - A trusted Node application intentionally runs plugins in its own process
 * - Tests need deterministic in-process plugin hooks
 *
 * Expects:
 * - Entrypoints are trusted because they execute with full host-process privileges
 * - The selected transport is supported by the Node Eventa adapter
 *
 * Returns:
 * - A runtime session factory backed by {@link FileSystemLoader}
 */
export function createFileSystemPluginRuntimeSessionFactory(): PluginRuntimeSessionFactory {
  const loader = new FileSystemLoader()

  return async ({ manifest, transport, loadOptions }) => {
    const hostChannel = createPluginContext(transport)
    return {
      hostChannel,
      loadPlugin: async () => await loader.loadPluginFor(manifest, loadOptions),
      dispose: reason => hostChannel.abort(reason ?? new Error('Plugin runtime session disposed.')),
    }
  }
}
