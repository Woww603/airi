import type { I18n } from '../../libs/i18n'
import type { ServerChannel } from '../../services/airi/channel-server'

import { resolve } from 'node:path'

import { defineInvokeHandler } from '@moeru/eventa'
import { safeClose } from '@proj-airi/electron-vueuse/main'
import { BrowserWindow, ipcMain, shell } from 'electron'
import { isMacOS } from 'std-env'

import icon from '../../../../resources/icon.png?asset'

import { electronOnboardingClose } from '../../../shared/eventa'
import { createWindowEventaContext } from '../../libs/electron/eventa'
import { baseUrl, getElectronMainDirname, load, withHashRoute } from '../../libs/electron/location'
import { createReusableWindow } from '../../libs/electron/window-manager'
import { createAuthService } from '../../services/airi/auth'
import { toggleWindowShow } from '../shared'
import { rendererPreloadPath } from '../shared/preload'
import { createTrustedRendererWindowPreferences, installTrustedRendererWindowSecurity } from '../shared/security'
import { setupBaseWindowElectronInvokes } from '../shared/window'

export interface OnboardingWindowManager {
  getWindow: () => Promise<BrowserWindow>
  getAndToggleWindow: () => Promise<BrowserWindow>
  onClosed: (callback: () => void) => () => void
}

export function setupOnboardingWindowManager(params: {
  serverChannel: ServerChannel
  i18n: I18n
}): OnboardingWindowManager {
  const closeCallbacks = new Set<() => void>()

  async function getOnboardingWindow(getWindow: () => Promise<BrowserWindow>) {
    const window = await getWindow()
    await toggleWindowShow(window)

    return window
  }

  const reusableWindow = createReusableWindow(async () => {
    const rendererBase = baseUrl(resolve(getElectronMainDirname(), '..', 'renderer'))
    const newWindow = new BrowserWindow({
      title: 'Welcome to AIRI',
      width: 1000,
      height: 650,
      minWidth: 400,
      minHeight: 500,
      show: false,
      icon,
      resizable: true,
      frame: !isMacOS,
      titleBarStyle: isMacOS ? 'hidden' : undefined,
      transparent: false,
      backgroundColor: '#0f0f0f',
      webPreferences: createTrustedRendererWindowPreferences({ preloadPath: rendererPreloadPath }),
    })

    newWindow.on('ready-to-show', () => newWindow.show())
    installTrustedRendererWindowSecurity({
      window: newWindow,
      rendererLocation: rendererBase,
      openExternal: async url => await shell.openExternal(url),
    })

    // TODO: once we refactored eventa to support window-namespaced contexts,
    // we can remove the setMaxListeners call below since eventa will be able to dispatch and
    // manage events within eventa's context system.
    ipcMain.setMaxListeners(0)

    const { context } = createWindowEventaContext(ipcMain, newWindow)

    defineInvokeHandler(context, electronOnboardingClose, async () => {
      safeClose(newWindow)
    })

    await setupBaseWindowElectronInvokes({ context, window: newWindow, i18n: params.i18n, serverChannel: params.serverChannel })
    createAuthService({ context, window: newWindow })

    await load(newWindow, withHashRoute(rendererBase, '/onboarding'))

    newWindow.on('closed', () => {
      for (const cb of closeCallbacks) {
        try {
          cb()
        }
        catch { /* noop */ }
      }
    })

    return newWindow
  })

  return {
    getWindow: async () => reusableWindow.getWindow(),
    getAndToggleWindow: async () => await getOnboardingWindow(reusableWindow.getWindow),
    onClosed: (callback: () => void) => {
      closeCallbacks.add(callback)
      return () => {
        closeCallbacks.delete(callback)
      }
    },
  }
}
