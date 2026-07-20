import { defineConfig } from 'electron-vite'

export default defineConfig({
  main: {
    build: {
      // The standalone service is pure TypeScript/JavaScript. Bundling all dependencies
      // leaves the packaged app independent from pnpm and workspace node_modules.
      externalizeDeps: false,
      rolldownOptions: {
        // NOTICE:
        // Discord.js loads zlib-sync lazily and catches a missing module to use identify compression.
        // Rolldown otherwise treats that optional dynamic import as a required build dependency.
        // Source/context: @discordjs/ws dist/index.js getZlibSync().
        // Remove this when @discordjs/ws no longer emits the optional bare import.
        external: ['electron', 'zlib-sync'],
      },
    },
  },
})
