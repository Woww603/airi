import type { BrowserWindow, IpcMain, IpcMainEvent } from 'electron'

import { createContext } from '@moeru/eventa/adapters/electron/main'

type IpcMainListener = Parameters<IpcMain['on']>[1]

interface IpcMainSubscriptions {
  on: (channel: string, listener: IpcMainListener) => unknown
  off: (channel: string, listener: IpcMainListener) => unknown
}

/**
 * Restricts inbound IpcMain subscriptions to one expected renderer sender.
 *
 * Use when:
 * - Binding an Eventa context to a specific BrowserWindow
 *
 * Expects:
 * - `expectedSenderId` is the owning window's current WebContents id
 *
 * Returns:
 * - The minimal IpcMain facade consumed by Eventa, with foreign messages dropped
 */
export function createSenderScopedIpcMain(
  source: IpcMainSubscriptions,
  expectedSenderId: number,
): IpcMain {
  const listenerWrappers = new Map<IpcMainListener, IpcMainListener>()

  // NOTICE:
  // Eventa beta.8 accepts the full IpcMain interface even though its main adapter uses only `on` and `off`.
  // This deliberately narrow facade enforces inbound sender identity before Eventa parses or dispatches a payload.
  // Source/context: `node_modules/@moeru/eventa/dist/adapters/electron/main.mjs`.
  // Removal condition: Eventa exposes an inbound sender predicate or a WebContents-scoped main adapter.
  const scoped = {
    on(channel: string, listener: IpcMainListener) {
      const wrappedListener: IpcMainListener = (event: IpcMainEvent, ...args) => {
        if (event.sender.id === expectedSenderId) {
          listener(event, ...args)
        }
      }
      listenerWrappers.set(listener, wrappedListener)
      source.on(channel, wrappedListener)
      return scoped
    },
    off(channel: string, listener: IpcMainListener) {
      const wrappedListener = listenerWrappers.get(listener)
      if (wrappedListener) {
        source.off(channel, wrappedListener)
        listenerWrappers.delete(listener)
      }
      return scoped
    },
  } as IpcMain

  return scoped
}

/**
 * Creates an Eventa context whose inbound requests belong to one BrowserWindow.
 *
 * Use when:
 * - Registering window-specific Electron RPC or event handlers
 *
 * Expects:
 * - The renderer window is live and owns the handlers registered on the returned context
 *
 * Returns:
 * - Eventa's context/dispose pair with sender-scoped inbound IPC and same-window responses
 */
export function createWindowEventaContext(
  ipcMain: IpcMainSubscriptions,
  window: BrowserWindow,
  options?: NonNullable<Parameters<typeof createContext>[2]>,
) {
  const eventa = createContext(
    createSenderScopedIpcMain(ipcMain, window.webContents.id),
    window,
    {
      ...options,
      onlySameWindow: true,
    },
  )
  let disposed = false
  function disposeOnClosed() {
    dispose(new Error('Window-specific Eventa context closed.'))
  }
  function dispose(reason?: unknown) {
    if (disposed) {
      return
    }
    disposed = true
    window.removeListener('closed', disposeOnClosed)
    eventa.dispose(reason)
  }

  // Window managers frequently keep only the Eventa context, so bind transport
  // cleanup here to prevent global IpcMain listeners accumulating after closes.
  window.once('closed', disposeOnClosed)

  return {
    context: eventa.context,
    dispose,
  }
}
