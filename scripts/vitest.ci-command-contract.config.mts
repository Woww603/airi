import { defineConfig } from 'vitest/config'

export default defineConfig({
  root: import.meta.dirname,
  test: {
    environment: 'node',
    include: ['verify-ci-command-contract.test.mjs'],
  },
})
