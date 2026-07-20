import type { Plugin } from '@proj-airi/plugin-sdk'

import type { PluginSandboxBridge } from '../shared/plugin/sandbox-bridge'

import { defineInvokeHandler } from '@moeru/eventa'
import { createContext } from '@moeru/eventa/adapters/electron/renderer'
import { coercePluginFromModule, createApis } from '@proj-airi/plugin-sdk'
import { object, pipe, safeParse, string, url } from 'valibot'

import {
  pluginSandboxInitialize,
  pluginSandboxLoad,
  pluginSandboxSetupModules,
} from '../shared/eventa/plugin/sandbox'

declare global {
  interface Window {
    airiPluginSandbox: PluginSandboxBridge
  }
}

const bridge = window.airiPluginSandbox
// NOTICE:
// Eventa's Electron renderer adapter only calls send/on/removeListener, but beta.8 types the input as the full preload IpcRenderer API.
// The sandbox deliberately exposes only those three fixed-channel methods so plugin code cannot reach arbitrary Electron IPC.
// Source/context: `node_modules/@moeru/eventa/dist/adapters/electron/renderer.mjs` and `renderer.d.mts`.
// Removal condition: Eventa accepts a minimal renderer transport interface matching the methods its adapter actually uses.
const eventaIpcRenderer = bridge.ipcRenderer as Parameters<typeof createContext>[0]
const { context } = createContext(eventaIpcRenderer, {
  messageEventName: bridge.messageEventName,
  pushEventName: bridge.pushEventName,
  errorEventName: bridge.errorEventName,
})
const apis = createApis(context)
const loadPayloadSchema = object({
  entrypointUrl: pipe(string(), url()),
})

let plugin: Plugin | undefined

function getLoadedPlugin() {
  if (!plugin) {
    throw new Error('Plugin sandbox lifecycle invoked before the entrypoint was loaded.')
  }

  return plugin
}

defineInvokeHandler(context, pluginSandboxLoad, async (payload) => {
  const parsedPayload = safeParse(loadPayloadSchema, payload)
  if (!parsedPayload.success) {
    throw new Error('Plugin sandbox received an invalid entrypoint URL.')
  }

  const entrypointUrl = new URL(parsedPayload.output.entrypointUrl)
  if (entrypointUrl.protocol !== 'airi-plugin:') {
    throw new Error('Plugin sandbox only loads airi-plugin protocol entrypoints.')
  }

  const pluginModule: unknown = await import(/* @vite-ignore */ entrypointUrl.toString())
  plugin = await coercePluginFromModule(pluginModule)
})

defineInvokeHandler(context, pluginSandboxInitialize, async () => {
  const result = await getLoadedPlugin().init?.({
    channels: { host: context },
    apis,
  })
  return result === false ? false : undefined
})

defineInvokeHandler(context, pluginSandboxSetupModules, async () => {
  await getLoadedPlugin().setupModules?.({
    channels: { host: context },
    apis,
  })
})
