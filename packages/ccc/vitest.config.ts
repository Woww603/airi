import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: '@proj-airi/ccc',
    include: ['src/**/*.test.ts'],
  },
})
