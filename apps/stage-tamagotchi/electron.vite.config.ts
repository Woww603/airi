import { join, resolve } from 'node:path'

import VueI18n from '@intlify/unplugin-vue-i18n/vite'
import templateCompilerOptions from '@tresjs/core/template-compiler-options'
import Vue from '@vitejs/plugin-vue'
import UnoCss from 'unocss/vite'
import Info from 'unplugin-info/vite'
import Yaml from 'unplugin-yaml/vite'
import Inspect from 'vite-plugin-inspect'
import VitePluginVueDevTools from 'vite-plugin-vue-devtools'
import Layouts from 'vite-plugin-vue-layouts'
import VueMacros from 'vue-macros/vite'
import VueRouter from 'vue-router/vite'

import { Download } from '@proj-airi/unplugin-fetch'
import { DownloadLive2DSDK } from '@proj-airi/unplugin-live2d-sdk'
import { defineConfig } from 'electron-vite'

import packageJSON from './package.json' with { type: 'json' }

const stageUIAssetsRoot = resolve(join(import.meta.dirname, '..', '..', 'packages', 'stage-ui', 'src', 'assets'))
const sharedCacheDir = resolve(join(import.meta.dirname, '..', '..', '.cache'))
const bundledMainDependencies = new Set([
  '@proj-airi/audio',
  '@proj-airi/discord-bot',
  '@proj-airi/server-sdk',
  '@proj-airi/stage-shared',
])
const externalMainDependencies = [
  ...Object.keys(packageJSON.dependencies).filter(dependency => !bundledMainDependencies.has(dependency)),
  'zlib-sync',
]

/** Mirrors electron-vite dependency externalization in Vite 8's active Rolldown options. */
function isExternalMainDependency(id: string): boolean {
  return externalMainDependencies.some(dependency => id === dependency || id.startsWith(`${dependency}/`))
}

const discordBridgeWorkerEntry = resolve(join(import.meta.dirname, 'src', 'main', 'services', 'airi', 'discord-bridge', 'worker.ts'))

/** Kept in both compatibility option names so electron-vite and Vite 8 see the same Main entry. */
const mainBuildInput = {
  'index': resolve(join(import.meta.dirname, 'src', 'main', 'index.ts')),
  'discord-bridge': discordBridgeWorkerEntry,
}

export default defineConfig({
  main: {
    build: {
      // NOTICE:
      // electron-vite 5 writes dependency externalization to `rollupOptions.external`.
      // Mixing that with a separate Vite 8 `rolldownOptions.input` drops the external list and bundles workspace aliases into Electron Main.
      // Source/context: `node_modules/electron-vite/dist/chunks/lib-q6ns0vZr.js:1127-1152` and Vite 8's deprecated rollup alias.
      // Removal condition: electron-vite writes `externalizeDeps` to `rolldownOptions`, or this app stops using its externalizer.
      rollupOptions: {
        input: mainBuildInput,
      },
      rolldownOptions: {
        external: isExternalMainDependency,
        input: mainBuildInput,
      },
      externalizeDeps: {
        exclude: [
          // The utility entry is packaged only from `out/**`; bundle workspace
          // sources that electron-builder intentionally excludes from the app.
          '@proj-airi/audio',
          '@proj-airi/discord-bot',
          '@proj-airi/server-sdk',
          '@proj-airi/stage-shared',
        ],
        include: [
          // Native modules that have `__dirname` usages. Externalize to avoid bundling
          // them into ESM and causing issues in runtime.
          'electron-click-drag-plugin',
          'uiohook-napi',
          // Optional native Discord WebSocket compression. Runtime feature
          // detection continues without compression when it is not installed.
          'zlib-sync',
        ],
      },
    },
    plugins: [
      {
        // This previously described avoiding `rollupOptions` entirely. Main entry inputs
        // now intentionally use electron-vite's compatible `rollupOptions` path, while
        // output chunk grouping stays here because `manualChunks` did not work under Rolldown.
        name: 'manual-chunks',
        outputOptions(options) {
          // NOTICE:
          // electron-vite 5 sets `build.minify: false`, but Vite 8 converts it to Rolldown's `dce-only` output mode.
          // That incompatible mode erases the complete Discord worker after renderChunk and silently emits a zero-byte executable.
          // Source/context: `node_modules/vite/dist/node/chunks/node.js` maps false minification while resolving output options.
          // Removal condition: electron-vite supports Vite 8, or the repository returns to a supported Vite version.
          options.minify = false
          options.codeSplitting = {
            groups: [
              {
                name(moduleId) {
                  // https://github.com/lobehub/lobehub/blob/6ecba929b738e1259e15d17e7643941e015324ee/apps/desktop/electron.vite.config.ts#L54
                  // Prevent debug package from being bundled into index.js to avoid side-effect pollution
                  if (moduleId.includes('node_modules/debug')) {
                    return 'vendor-debug'
                  }
                },
              },
              {
                name(moduleId) {
                  // https://github.com/lobehub/lobehub/blob/6ecba929b738e1259e15d17e7643941e015324ee/apps/desktop/electron.vite.config.ts#L54
                  // Prevent debug package from being bundled into index.js to avoid side-effect pollution
                  if (moduleId.includes('node_modules/h3')) {
                    return 'vendor-h3'
                  }
                },
              },
            ],
          }

          return options
        },
        generateBundle(_options, bundle) {
          const worker = bundle['discord-bridge.js']
          if (worker?.type !== 'chunk' || worker.code.trim().length === 0)
            this.error('Discord bridge worker build produced an empty executable.')
        },
      },
      Info(),
    ],

    resolve: {
      alias: {
        '@proj-airi/i18n': resolve(join(import.meta.dirname, '..', '..', 'packages', 'i18n', 'src')),
        '@proj-airi/server-runtime/server': resolve(join(import.meta.dirname, '..', '..', 'packages', 'server-runtime', 'src', 'server', 'index.ts')),
        '@proj-airi/server-runtime': resolve(join(import.meta.dirname, '..', '..', 'packages', 'server-runtime', 'src', 'index.ts')),
      },
    },
  },

  renderer: {
    // Thanks to [@Maqsyo](https://github.com/Maqsyo)
    // https://github.com/alex8088/electron-vite/issues/99#issuecomment-1862671727
    base: './',

    build: {
      rolldownOptions: {
        input: {
          'main': resolve(join(import.meta.dirname, 'src', 'renderer', 'index.html')),
          'beat-sync': resolve(join(import.meta.dirname, 'src', 'renderer', 'beat-sync.html')),
          'plugin-sandbox': resolve(join(import.meta.dirname, 'src', 'renderer', 'plugin-sandbox.html')),
        },
      },
    },

    optimizeDeps: {
      exclude: [
        // Internal Packages
        '@proj-airi/stage-ui/*',
        '@proj-airi/drizzle-duckdb-wasm',
        '@proj-airi/drizzle-duckdb-wasm/*',
        '@proj-airi/electron-screen-capture',

        // Static Assets: Models, Images, etc.
        'src/renderer/public/assets/*',

        // Live2D SDK
        '@framework/live2dcubismframework',
        '@framework/math/cubismmatrix44',
        '@framework/type/csmvector',
        '@framework/math/cubismviewmatrix',
        '@framework/cubismdefaultparameterid',
        '@framework/cubismmodelsettingjson',
        '@framework/effect/cubismbreath',
        '@framework/effect/cubismeyeblink',
        '@framework/model/cubismusermodel',
        '@framework/motion/acubismmotion',
        '@framework/motion/cubismmotionqueuemanager',
        '@framework/type/csmmap',
        '@framework/utils/cubismdebug',
        '@framework/model/cubismmoc',
      ],
    },

    resolve: {
      alias: {
        '@proj-airi/server-sdk': resolve(join(import.meta.dirname, '..', '..', 'packages', 'server-sdk', 'src')),
        '@proj-airi/i18n': resolve(join(import.meta.dirname, '..', '..', 'packages', 'i18n', 'src')),
        // NOTICE: the @proj-airi/stage-ui alias resolves to a directory; rolldown
        // concatenates sub-paths without a file extension, so bare .ts files at the
        // stores/ root (e.g. mcp-tool-bridge.ts) are not found.  Add explicit aliases
        // for each such file that the renderer imports from @proj-airi/stage-ui.
        '@proj-airi/stage-ui/stores/mcp-tool-bridge': resolve(join(import.meta.dirname, '..', '..', 'packages', 'stage-ui', 'src', 'stores', 'mcp-tool-bridge.ts')),
        '@proj-airi/stage-ui': resolve(join(import.meta.dirname, '..', '..', 'packages', 'stage-ui', 'src')),
        '@proj-airi/stage-pages': resolve(join(import.meta.dirname, '..', '..', 'packages', 'stage-pages', 'src')),
        '@proj-airi/stage-shared': resolve(join(import.meta.dirname, '..', '..', 'packages', 'stage-shared', 'src')),
      },
    },

    server: {
      fs: {
        // To mute errors like:
        //   The request id ".../node_modules/@fontsource/sniglet/files/sniglet-latin-400-normal.woff" is outside of Vite serving allow list.
        //
        // See: https://vite.dev/config/server-options#server-fs-strict
        strict: false,
      },
      warmup: {
        clientFiles: [
          `${resolve(join(import.meta.dirname, '..', '..', 'packages', 'stage-ui', 'src'))}/*.vue`,
          `${resolve(join(import.meta.dirname, '..', '..', 'packages', 'stage-pages', 'src'))}/*.vue`,
        ],
      },
    },

    worker: {
      format: 'es',
      rollupOptions: {
        output: {
          inlineDynamicImports: false,
        },
      },
    },

    plugins: [
      Info(),

      {
        name: 'proj-airi:defines',
        config(ctx) {
          const define: Record<string, any> = {
            'import.meta.env.RUNTIME_ENVIRONMENT': '\'electron\'',
          }
          if (ctx.mode === 'development') {
            define['import.meta.env.URL_MODE'] = '\'server\''
          }
          if (ctx.mode === 'production') {
            define['import.meta.env.URL_MODE'] = '\'file\''
          }

          return { define }
        },
      },

      Inspect(),

      Yaml(),

      VueMacros({
        plugins: {
          vue: Vue({
            include: [/\.vue$/, /\.md$/],
            ...templateCompilerOptions,
          }),
          vueJsx: false,
        },
        betterDefine: false,
      }),

      VueRouter({
        dts: resolve(import.meta.dirname, 'src/renderer/typed-router.d.ts'),
        routesFolder: [
          {
            src: resolve(import.meta.dirname, '..', '..', 'packages', 'stage-pages', 'src', 'pages'),
            exclude: base => [
              ...base,
              '**/settings/account/index.vue',
              '**/settings/connection/index.vue',
              '**/settings/data/index.vue',
              '**/settings/models/index.vue',
              '**/settings/system/general.vue',
              '**/settings/modules/mcp.vue',
              '**/devtools/index.vue',
              '**/settings/index.vue',
            ],
          },
          resolve(import.meta.dirname, 'src', 'renderer', 'pages'),
        ],
        exclude: ['**/components/**'],
      }),

      VitePluginVueDevTools(),

      // https://github.com/JohnCampionJr/vite-plugin-vue-layouts
      Layouts({
        layoutsDirs: [
          resolve(import.meta.dirname, 'src', 'renderer', 'layouts'),
          resolve(import.meta.dirname, '..', '..', 'packages', 'stage-layouts', 'src', 'layouts'),
        ],
        pagesDirs: [resolve(import.meta.dirname, 'src', 'renderer', 'pages')],
      }),

      UnoCss(),

      // https://github.com/intlify/bundle-tools/tree/main/packages/unplugin-vue-i18n
      VueI18n({
        runtimeOnly: true,
        compositionOnly: true,
        fullInstall: true,
      }),

      DownloadLive2DSDK(),
      Download('https://dist.ayaka.moe/live2d-models/hiyori_free_zh.zip', 'hiyori_free_zh.zip', 'live2d/models', { parentDir: stageUIAssetsRoot, cacheDir: sharedCacheDir }),
      Download('https://dist.ayaka.moe/live2d-models/hiyori_pro_zh.zip', 'hiyori_pro_zh.zip', 'live2d/models', { parentDir: stageUIAssetsRoot, cacheDir: sharedCacheDir }),
      Download('https://dist.ayaka.moe/vrm-models/VRoid-Hub/AvatarSample-A/AvatarSample_A.vrm', 'AvatarSample_A.vrm', 'vrm/models/AvatarSample-A', { parentDir: stageUIAssetsRoot, cacheDir: sharedCacheDir }),
      Download('https://dist.ayaka.moe/vrm-models/VRoid-Hub/AvatarSample-B/AvatarSample_B.vrm', 'AvatarSample_B.vrm', 'vrm/models/AvatarSample-B', { parentDir: stageUIAssetsRoot, cacheDir: sharedCacheDir }),
    ],
  },
})
