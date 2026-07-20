import type { I18n } from '../../libs/i18n'
import type { ServerChannel } from '../../services/airi/channel-server'
import type { AutoUpdater } from '../../services/electron/auto-updater'

import { resolve } from 'node:path'

import { BrowserWindow, shell } from 'electron'

import icon from '../../../../resources/icon.png?asset'

import { baseUrl, getElectronMainDirname, load, withHashRoute } from '../../libs/electron/location'
import { createReusableWindow } from '../../libs/electron/window-manager'
import { rendererPreloadPath } from '../shared/preload'
import { createTrustedRendererWindowPreferences, installTrustedRendererWindowSecurity } from '../shared/security'
import { setupAboutWindowElectronInvokes } from './rpc/index.electron'

export function setupAboutWindowReusable(params: {
  autoUpdater: AutoUpdater
  i18n: I18n
  serverChannel: ServerChannel
}) {
  return createReusableWindow(async () => {
    const rendererBase = baseUrl(resolve(getElectronMainDirname(), '..', 'renderer'))
    const window = new BrowserWindow({
      title: 'About AIRI',
      width: 670,
      height: 880,
      show: false,
      resizable: true,
      maximizable: false,
      minimizable: false,
      icon,
      webPreferences: createTrustedRendererWindowPreferences({ preloadPath: rendererPreloadPath }),
    })

    window.on('ready-to-show', () => window.show())
    installTrustedRendererWindowSecurity({
      window,
      rendererLocation: rendererBase,
      openExternal: async url => await shell.openExternal(url),
    })

    await setupAboutWindowElectronInvokes({
      window,
      autoUpdater: params.autoUpdater,
      i18n: params.i18n,
      serverChannel: params.serverChannel,
    })

    await load(window, withHashRoute(rendererBase, '/about'))

    return window
  }).getWindow
}
