/** One temporary root per test file, removed when that file finishes.
 *
 * The host tests build a DSH_HOME, a profile or a fake CLI tree per scenario:
 * 101 `mkdtempSync` calls against 12 removals, which left 203 directories
 * behind on every run and 8,878 in /tmp by the time it was measured (audit
 * H-11). Paired `rmSync` calls did not hold, and could not: a scenario that
 * throws never reaches its own cleanup, and a new scenario copied from an old
 * one inherits the creation and not the removal.
 *
 * One root per file has neither failure mode. `afterAll` runs whether the
 * file's tests passed, failed or threw, and a scenario added later lands
 * under the root without anyone remembering to remove it. Scenarios that
 * already clean up eagerly may keep doing so — the root is a backstop, not a
 * replacement.
 *
 * `tests/temp-dir-leak.test.ts` runs this directory under an isolated TMPDIR
 * and fails if anything `dsh-` prefixed outlives the run.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll } from 'vitest'

/**
 * Call at module scope of a test file — `afterAll` has to be registered
 * during collection, so a call from inside an `it` would be too late.
 *
 * @param label names the file in the directory, so a leak that escapes the
 * root is still attributable.
 */
export function fileTempRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `dsh-testrun-${label}-`))
  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
  })
  return root
}
