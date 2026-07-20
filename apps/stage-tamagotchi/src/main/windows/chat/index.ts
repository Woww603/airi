import type { I18n } from '../../libs/i18n'
import type { ServerChannel } from '../../services/airi/channel-server'
import type { McpStdioManager } from '../../services/airi/mcp-servers'
import type { WidgetsWindowManager } from '../widgets'

import { resolve } from 'node:path'

import { BrowserWindow, shell } from 'electron'

import icon from '../../../../resources/icon.png?asset'

import { baseUrl, getElectronMainDirname, load, withHashRoute } from '../../libs/electron/location'
import { createReusableWindow } from '../../libs/electron/window-manager'
import { rendererPreloadPath } from '../shared/preload'
import { createTrustedRendererWindowPreferences, installTrustedRendererWindowSecurity } from '../shared/security'
import { setupChatWindowElectronInvokes } from './rpc/index.electron'

export function setupChatWindowReusableFunc(params: {
  widgetsManager: WidgetsWindowManager
  serverChannel: ServerChannel
  mcpStdioManager: McpStdioManager
  i18n: I18n
}) {
  return createReusableWindow(async () => {
    const rendererBase = baseUrl(resolve(getElectronMainDirname(), '..', 'renderer'))
    const window = new BrowserWindow({
      title: 'Chat',
      width: 600.0,
      height: 800.0,
      show: false,
      icon,
      webPreferences: createTrustedRendererWindowPreferences({ preloadPath: rendererPreloadPath }),
    })

    window.on('ready-to-show', () => window.show())
    installTrustedRendererWindowSecurity({
      window,
      rendererLocation: rendererBase,
      openExternal: async url => await shell.openExternal(url),
    })

    await setupChatWindowElectronInvokes({
      window,
      widgetsManager: params.widgetsManager,
      serverChannel: params.serverChannel,
      mcpStdioManager: params.mcpStdioManager,
      i18n: params.i18n,
    })

    await load(window, withHashRoute(rendererBase, '/chat'))

    return window
  }).getWindow
}
