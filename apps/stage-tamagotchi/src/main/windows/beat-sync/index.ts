import { resolve } from 'node:path'

import { initScreenCaptureForWindow } from '@proj-airi/electron-screen-capture/main'
import { BrowserWindow, shell } from 'electron'

import { baseUrl, getElectronMainDirname, load } from '../../libs/electron/location'
import { rendererPreloadPath } from '../shared/preload'
import { createTrustedRendererWindowPreferences, installTrustedRendererWindowSecurity } from '../shared/security'

export async function setupBeatSync() {
  const rendererLocation = baseUrl(resolve(getElectronMainDirname(), '..', 'renderer'), 'beat-sync.html')
  const window = new BrowserWindow({
    show: false,
    webPreferences: createTrustedRendererWindowPreferences({ preloadPath: rendererPreloadPath }),
  })
  installTrustedRendererWindowSecurity({
    window,
    rendererLocation,
    openExternal: async url => await shell.openExternal(url),
  })

  await load(window, rendererLocation)

  initScreenCaptureForWindow(window)

  return window
}
