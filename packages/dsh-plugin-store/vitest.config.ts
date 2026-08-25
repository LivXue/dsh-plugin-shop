import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // The web full-flow e2e lives in *.e2e.ts and must be part of the
    // package's vitest run (P2 exit criterion); the default include pattern
    // only matches *.test.* and *.spec.*.
    include: ['tests/**/*.{test,spec,e2e}.?(c|m)[jt]s?(x)'],
  },
})
