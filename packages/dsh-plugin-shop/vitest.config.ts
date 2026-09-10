import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // The web full-flow e2e lives in *.e2e.ts and must be part of the
    // package's vitest run (P2 exit criterion); the default include pattern
    // only matches *.test.* and *.spec.*.
    include: ['tests/**/*.{test,spec,e2e}.?(c|m)[jt]s?(x)'],
    // Above every deadline the host tests set for THEMSELVES, which vitest's
    // 5 s default sat underneath. Ten `Date.now() + 5000`/`+ 15000` polling
    // loops in `index.test.ts` could therefore never reach their own
    // expiry — the harness killed the test first, so each one was dead code
    // and every slow run reported `Test timed out in 5000ms` instead of the
    // assertion that was actually unmet. An inner deadline is only a check if
    // the outer budget lets it fire.
    //
    // Load is what made that matter. These tests spawn a real CLI per install
    // — 33 of them in the eviction case, 3.3 s when it runs alone — so the
    // margin under 5 s was about a second, and a full parallel suite spends it.
    // The cost of the larger budget is a genuinely wedged test taking longer
    // to report, and the inner deadlines are what keep that bounded.
    testTimeout: 30_000,
  },
})
