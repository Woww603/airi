// NOTICE:
// Sandboxed Electron preloads run in a restricted CommonJS environment and cannot execute the ESM preload chunks emitted for this package.
// The bridge intentionally exposes IPC transport only; environment variables, Node, webFrame, webUtils, and raw IpcRendererEvent objects stay private.
// Source/context: `https://www.electronjs.org/docs/latest/tutorial/sandbox#preload-scripts` and `src/preload/shared.ts`.
// Removal condition: Electron supports bundled ESM preload scripts in sandboxed renderers and the bridge remains a single auditable asset.
const { contextBridge, ipcRenderer } = require('electron')

ipcRenderer.setMaxListeners(0)

const listenerWrappers = new Map()
const emptyEvent = Object.freeze({})
const secureStorageChannels = Object.freeze({
  changed: 'airi:secure-storage:v1:changed',
  getSnapshot: 'airi:secure-storage:v1:get-snapshot',
  removeItem: 'airi:secure-storage:v1:remove-item',
  setItem: 'airi:secure-storage:v1:set-item',
})
const textEncoder = new TextEncoder()

function rememberListener(channel, listener, once) {
  const wrappedListener = (_event, ...args) => {
    if (once) {
      listenerWrappers.get(channel)?.delete(listener)
    }
    listener(emptyEvent, ...args)
  }
  let channelListeners = listenerWrappers.get(channel)
  if (!channelListeners) {
    channelListeners = new Map()
    listenerWrappers.set(channel, channelListeners)
  }
  channelListeners.set(listener, wrappedListener)
  return wrappedListener
}

const exposedIpcRenderer = {
  send(channel, ...args) {
    ipcRenderer.send(channel, ...args)
  },
  sendTo() {
    throw new Error('"sendTo" has been removed since Electron 28.')
  },
  sendSync(channel, ...args) {
    return ipcRenderer.sendSync(channel, ...args)
  },
  sendToHost(channel, ...args) {
    ipcRenderer.sendToHost(channel, ...args)
  },
  postMessage(channel, message, transfer) {
    ipcRenderer.postMessage(channel, message, transfer)
  },
  invoke(channel, ...args) {
    return ipcRenderer.invoke(channel, ...args)
  },
  on(channel, listener) {
    const wrappedListener = rememberListener(channel, listener, false)
    ipcRenderer.on(channel, wrappedListener)
    return () => exposedIpcRenderer.removeListener(channel, listener)
  },
  once(channel, listener) {
    const wrappedListener = rememberListener(channel, listener, true)
    ipcRenderer.once(channel, wrappedListener)
    return () => exposedIpcRenderer.removeListener(channel, listener)
  },
  removeListener(channel, listener) {
    const channelListeners = listenerWrappers.get(channel)
    const wrappedListener = channelListeners?.get(listener)
    if (wrappedListener) {
      ipcRenderer.removeListener(channel, wrappedListener)
      channelListeners.delete(listener)
      if (channelListeners.size === 0) {
        listenerWrappers.delete(channel)
      }
    }
    return exposedIpcRenderer
  },
  removeAllListeners(channel) {
    ipcRenderer.removeAllListeners(channel)
    listenerWrappers.delete(channel)
  },
}

function assertSecureStorageKey(key) {
  if (typeof key !== 'string' || !/^[a-z\d][\w./:-]*$/i.test(key) || textEncoder.encode(key).byteLength > 160) {
    throw new TypeError('Invalid protected storage key')
  }
}

const secureStorage = {
  getSnapshot() {
    return ipcRenderer.invoke(secureStorageChannels.getSnapshot)
  },
  removeItem(key) {
    assertSecureStorageKey(key)
    return ipcRenderer.invoke(secureStorageChannels.removeItem, key)
  },
  setItem(key, value) {
    assertSecureStorageKey(key)
    if (typeof value !== 'string' || textEncoder.encode(value).byteLength > 256 * 1024) {
      throw new TypeError('Invalid protected storage value')
    }
    return ipcRenderer.invoke(secureStorageChannels.setItem, key, value)
  },
  subscribe(listener) {
    if (typeof listener !== 'function') {
      throw new TypeError('Protected storage listener must be a function')
    }
    const wrappedListener = (_event, change) => {
      if (
        typeof change !== 'object'
        || change === null
        || typeof change.key !== 'string'
        || (change.newValue !== null && typeof change.newValue !== 'string')
      ) {
        return
      }
      listener(Object.freeze({ key: change.key, newValue: change.newValue }))
    }
    ipcRenderer.on(secureStorageChannels.changed, wrappedListener)
    return () => ipcRenderer.removeListener(secureStorageChannels.changed, wrappedListener)
  },
}

contextBridge.exposeInMainWorld('electron', {
  ipcRenderer: exposedIpcRenderer,
  secureStorage,
})
// Sandboxed preloads receive Electron's restricted process global but cannot import Node's process module.
// eslint-disable-next-line node/prefer-global/process
contextBridge.exposeInMainWorld('platform', process.platform)
