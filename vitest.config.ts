import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['registry/scripts/tests/**/*.test.ts'],
  },
})
