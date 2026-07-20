import type { Configuration } from 'electron-builder'

import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

const buildResources = resolve(import.meta.dirname, '..', 'stage-tamagotchi', 'build')
const electronDist = resolve(import.meta.dirname, 'node_modules', 'electron', 'dist')

export default {
  appId: 'ai.moeru.airi.discord',
  productName: 'AIRI Discord',
  asar: true,
  afterPack: ({ appOutDir, electronPlatformName, packager }) => {
    if (electronPlatformName !== 'darwin')
      return

    // A deep ad-hoc signature gives the app and Electron Framework the same
    // identity, which macOS on Apple Silicon requires even for local builds.
    execFileSync('codesign', [
      '--force',
      '--deep',
      '--sign',
      '-',
      resolve(appOutDir, `${packager.appInfo.productFilename}.app`),
    ])
  },
  electronDist,
  directories: {
    buildResources,
    output: 'dist',
  },
  extraMetadata: {
    main: 'out/main/index.js',
    name: 'ai.moeru.airi.discord',
  },
  files: [
    'out/**',
    'package.json',
  ],
  mac: {
    category: 'public.app-category.social-networking',
    icon: resolve(buildResources, 'icon.icns'),
    identity: null,
    target: ['dir'],
  },
  npmRebuild: false,
} satisfies Configuration
