import type { Plugin } from '@proj-airi/plugin-sdk'
import type { PluginRuntimeSessionFactory } from '@proj-airi/plugin-sdk/plugin-host'

import { readFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { defineInvoke } from '@moeru/eventa'
import { BrowserWindow, ipcMain, protocol, session } from 'electron'

import pluginSandboxPreloadPath from '../../../../../preload/pluginSandbox.cjs?asset'

import {
  pluginSandboxInitialize,
  pluginSandboxLoad,
  pluginSandboxSetupModules,
} from '../../../../../shared/eventa/plugin/sandbox'
import { createWindowEventaContext } from '../../../../libs/electron/eventa'
import { baseUrl, getElectronMainDirname, load } from '../../../../libs/electron/location'
import {
  invokePluginSandboxLifecycle,
  pluginSandboxScheme,
  resolvePluginSandboxEntrypoint,
  resolvePluginSandboxModuleRequest,
} from './policy'
import { createPluginSandboxWindowOptions } from './window-policy'

/**
 * Registers the privileged custom scheme before Electron becomes ready.
 *
 * Use when:
 * - Bootstrapping the desktop main process before `app.whenReady()`
 *
 * Expects:
 * - This is called exactly once during application startup
 *
 * Returns:
 * - Nothing; individual non-persistent sessions install their own protocol handler later
 */
export function registerPluginSandboxScheme() {
  protocol.registerSchemesAsPrivileged([{
    scheme: pluginSandboxScheme,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  }])
}

function isPathInside(rootPath: string, candidatePath: string) {
  const relativePath = relative(rootPath, candidatePath)
  return relativePath !== '..'
    && !relativePath.startsWith(`..${sep}`)
    && !isAbsolute(relativePath)
}

function resolveRunnerUrl(location: ReturnType<typeof baseUrl>) {
  if ('url' in location && location.url) {
    return new URL(location.url)
  }
  if (!('file' in location) || !location.file) {
    throw new Error('Plugin sandbox runner location is invalid.')
  }

  return new URL(pathToFileURL(location.file))
}

function isAllowedBootstrapRequest(requestUrl: URL, runnerUrl: URL) {
  if (runnerUrl.protocol !== 'file:') {
    return requestUrl.origin === runnerUrl.origin
  }
  if (requestUrl.protocol !== 'file:') {
    return false
  }

  // Production renderer assets may be code-split, so allow only files beneath the
  // trusted built renderer directory while the sandbox runner is bootstrapping.
  return isPathInside(
    dirname(fileURLToPath(runnerUrl)),
    fileURLToPath(requestUrl),
  )
}

/**
 * Creates the Electron plugin runtime that executes each plugin in its own hidden Chromium sandbox.
 *
 * Use when:
 * - The desktop plugin host loads local third-party browser-compatible ESM plugins
 *
 * Expects:
 * - {@link registerPluginSandboxScheme} ran before Electron became ready
 * - Plugin entrypoints are relative `.js` or `.mjs` files contained by the manifest directory
 *
 * Returns:
 * - A fail-closed runtime session factory with isolated IPC, storage, permissions, and network policy
 */
export function createElectronPluginSandboxRuntimeSessionFactory(): PluginRuntimeSessionFactory {
  return async ({ manifest, loadOptions }) => {
    const runtimeId = crypto.randomUUID()
    const resolvedEntrypoint = await resolvePluginSandboxEntrypoint({
      manifest,
      loadOptions,
      runtimeId,
    })
    const electronSession = session.fromPartition(`airi-plugin-${runtimeId}`, { cache: false })

    await electronSession.protocol.handle(pluginSandboxScheme, async (request) => {
      if (request.method !== 'GET') {
        return new Response(null, { status: 405 })
      }

      try {
        const modulePath = await resolvePluginSandboxModuleRequest({
          requestUrl: request.url,
          rootPath: resolvedEntrypoint.rootPath,
          runtimeId,
        })
        const source = await readFile(modulePath)
        return new Response(source, {
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'no-store',
            'Content-Type': 'text/javascript; charset=utf-8',
            'Cross-Origin-Resource-Policy': 'cross-origin',
            'X-Content-Type-Options': 'nosniff',
          },
        })
      }
      catch {
        // Do not expose host filesystem paths or policy details to untrusted code.
        return new Response(null, { status: 404 })
      }
    })

    electronSession.setPermissionCheckHandler(() => false)
    electronSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
    electronSession.setDevicePermissionHandler(() => false)

    const channelId = crypto.randomUUID()
    const messageEventName = `airi-plugin-message-${channelId}`
    const pushEventName = `airi-plugin-push-${channelId}`
    const errorEventName = `airi-plugin-error-${channelId}`
    const window = new BrowserWindow(createPluginSandboxWindowOptions({
      electronSession,
      preloadPath: pluginSandboxPreloadPath,
      messageEventName,
      pushEventName,
      errorEventName,
    }))

    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

    const eventa = createWindowEventaContext(ipcMain, window, {
      messageEventName,
      pushEventName,
      errorEventName,
      onlySameWindow: true,
    })
    const runnerLocation = baseUrl(
      join(getElectronMainDirname(), '..', 'renderer'),
      'plugin-sandbox.html',
    )
    const runnerUrl = resolveRunnerUrl(runnerLocation)
    let runnerBootstrapping = true

    electronSession.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
      const requestUrl = new URL(details.url)
      const pluginModuleRequest
        = requestUrl.protocol === `${pluginSandboxScheme}:`
          && requestUrl.host === runtimeId
      const bootstrapRequest
        = runnerBootstrapping
          && isAllowedBootstrapRequest(requestUrl, runnerUrl)
      callback({ cancel: !pluginModuleRequest && !bootstrapRequest })
    })

    let transportDisposed = false
    let runtimeDisposed = false
    const disposeTransport = (reason: unknown) => {
      if (transportDisposed) {
        return
      }
      transportDisposed = true
      eventa.dispose(reason)
    }
    const dispose = (reason?: unknown) => {
      if (runtimeDisposed) {
        return
      }
      runtimeDisposed = true
      disposeTransport(reason ?? new Error(`Plugin sandbox disposed: ${manifest.name}`))
      electronSession.webRequest.onBeforeRequest(null)
      electronSession.protocol.unhandle(pluginSandboxScheme)
      if (!window.isDestroyed()) {
        window.destroy()
      }
    }

    window.on('closed', () => disposeTransport(new Error(`Plugin sandbox window closed: ${manifest.name}`)))
    window.webContents.on('render-process-gone', (_event, details) => {
      disposeTransport(new Error(`Plugin sandbox renderer exited: ${details.reason}`))
    })

    try {
      await load(window, runnerLocation)
      runnerBootstrapping = false
      window.webContents.on('will-navigate', event => event.preventDefault())
      window.webContents.on('will-redirect', event => event.preventDefault())

      const invokeLoad = defineInvoke(eventa.context, pluginSandboxLoad)
      await invokePluginSandboxLifecycle({
        phase: 'module load',
        timeoutMs: 10_000,
        invoke: async signal => await invokeLoad(
          { entrypointUrl: resolvedEntrypoint.entrypointUrl },
          { signal },
        ),
      })
      const invokeInitialize = defineInvoke(eventa.context, pluginSandboxInitialize)
      const invokeSetupModules = defineInvoke(eventa.context, pluginSandboxSetupModules)

      const plugin: Plugin = {
        init: async () => await invokePluginSandboxLifecycle({
          phase: 'initialization',
          timeoutMs: 10_000,
          invoke: async signal => await invokeInitialize(undefined, { signal }),
        }),
        setupModules: async () => await invokePluginSandboxLifecycle({
          phase: 'module setup',
          timeoutMs: 10_000,
          invoke: async signal => await invokeSetupModules(undefined, { signal }),
        }),
      }

      return {
        hostChannel: eventa.context,
        loadPlugin: async () => plugin,
        dispose,
      }
    }
    catch (error) {
      dispose(error)
      throw error
    }
  }
}
