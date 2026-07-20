// NOTICE:
// Electron sandboxed preloads execute as plain CommonJS scripts and reject ESM import syntax.
// This file stays dependency-free and is copied as an asset so no generated ESM wrapper can restore that failure.
// Source/context: https://www.electronjs.org/docs/latest/tutorial/sandbox#preload-scripts.
// Removal condition: Electron supports ESM preload scripts while Chromium sandboxing remains enabled.
const process = require('node:process')

const { contextBridge, ipcRenderer } = require('electron')

function resolveSandboxArgument(name) {
  const prefix = `--${name}=`
  const argument = process.argv.find(value => value.startsWith(prefix))
  const value = argument?.slice(prefix.length)
  if (!value) {
    throw new Error(`Missing plugin sandbox process argument: ${name}`)
  }

  return value
}

const messageEventName = resolveSandboxArgument('airi-plugin-message')
const pushEventName = resolveSandboxArgument('airi-plugin-push')
const errorEventName = resolveSandboxArgument('airi-plugin-error')
const inboundChannels = new Set([messageEventName, pushEventName, errorEventName])
const listenerWrappers = new Map()

function assertInboundChannel(channel) {
  if (!inboundChannels.has(channel)) {
    throw new Error(`Plugin sandbox IPC subscription denied: ${channel}`)
  }
}

const exposedIpcRenderer = {
  send(channel, ...args) {
    if (channel !== messageEventName) {
      throw new Error(`Plugin sandbox IPC send denied: ${channel}`)
    }
    ipcRenderer.send(channel, ...args)
  },
  on(channel, listener) {
    assertInboundChannel(channel)
    const wrappedListener = (_event, ...args) => listener(undefined, ...args)
    listenerWrappers.set(listener, wrappedListener)
    ipcRenderer.on(channel, wrappedListener)
    return () => {
      ipcRenderer.removeListener(channel, wrappedListener)
      listenerWrappers.delete(listener)
    }
  },
  removeListener(channel, listener) {
    assertInboundChannel(channel)
    const wrappedListener = listenerWrappers.get(listener)
    if (wrappedListener) {
      ipcRenderer.removeListener(channel, wrappedListener)
      listenerWrappers.delete(listener)
    }
    return exposedIpcRenderer
  },
}

contextBridge.exposeInMainWorld('airiPluginSandbox', {
  messageEventName,
  pushEventName,
  errorEventName,
  ipcRenderer: exposedIpcRenderer,
})
