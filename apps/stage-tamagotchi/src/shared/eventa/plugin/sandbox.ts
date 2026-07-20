import { defineInvokeEventa } from '@moeru/eventa'

/** Payload used to load one validated custom-protocol plugin entrypoint. */
export interface PluginSandboxLoadPayload {
  /** Session-scoped `airi-plugin:` URL created by the main process. */
  entrypointUrl: string
}

export const pluginSandboxLoad = defineInvokeEventa<void, PluginSandboxLoadPayload>('eventa:invoke:electron:plugins:sandbox:load')
export const pluginSandboxInitialize = defineInvokeEventa<false | undefined>('eventa:invoke:electron:plugins:sandbox:initialize')
export const pluginSandboxSetupModules = defineInvokeEventa<void>('eventa:invoke:electron:plugins:sandbox:setup-modules')
