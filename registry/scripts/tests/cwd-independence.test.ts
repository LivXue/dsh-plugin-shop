/** No test may read a fixture through a cwd-relative path.
 *
 * `pipeline.test.ts` opened `registry/scripts/tests/fixtures/packuments.json`
 * relative to the working directory, so the suite passed or failed on where it
 * was invoked from — reproduced before the fix: running it from `/tmp` with an
 * explicit `--root` raised `ENOENT`, and the file reported "no tests" rather
 * than a failure, which is the shape that hides.
 *
 * The rule is enforced over the source rather than by running each file from a
 * different directory: that would double the suite's runtime to catch a defect
 * whose signature is one regex. */

import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const testsDir = dirname(fileURLToPath(import.meta.url))

/** Every `readFileSync`/`readFile` whose first argument is a bare string
 * literal — the spelling that resolves against the cwd. A path built from
 * `join(...)`, `import.meta.dirname` or a variable is not matched, because
 * those are how a module-relative path is written. */
const CWD_RELATIVE_READ = /\breadFile(?:Sync)?\(\s*'(?!\/)[^']*'/

describe('fixtures resolve from the module, not the working directory', () => {
  const files = readdirSync(testsDir).filter(f => f.endsWith('.test.ts')).sort()

  it('scans the suite at all, so the check cannot pass by matching nothing', () => {
    expect(files.length).toBeGreaterThan(20)
  })

  it('finds no cwd-relative fixture read in any test file', () => {
    for (const file of files) {
      const source = readFileSync(join(testsDir, file), 'utf8')
      for (const [index, line] of source.split('\n').entries()) {
        expect(
          CWD_RELATIVE_READ.test(line),
          `${file}:${index + 1} reads a path relative to the working directory, so this `
            + `suite passes or fails on where it was invoked from. Resolve it from the module: `
            + `join(dirname(fileURLToPath(import.meta.url)), …). Line: ${line.trim()}`,
        ).toBe(false)
      }
    }
  })
})
