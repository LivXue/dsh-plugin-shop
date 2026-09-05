/** The host suite builds a DSH_HOME or a profile directory per scenario and
 * used to remove almost none of them: 102 `mkdtempSync` sites against 12
 * removals, 204 directories left behind per run, and 8,878 sitting in /tmp
 * when this was written (audit H-11). The cost is inodes and directory
 * entries rather than disk — each is nearly empty — but it makes an unrelated
 * `ls /tmp` useless and it grows with every CI run.
 *
 * This file lives at `tests/`, not `tests/host/`, on purpose: it runs the
 * host directory in a child process, and a guard inside that directory would
 * spawn itself.
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))

describe('the host suite leaves no temporary directory behind', () => {
  it('creates nothing under its own TMPDIR that outlives the run', () => {
    // An isolated TMPDIR rather than a count of /tmp: `os.tmpdir()` reads
    // TMPDIR first on POSIX, so every scenario's directory lands here and
    // nowhere else. Counting /tmp directly would race with any other suite on
    // the machine and would inherit whatever backlog was already there.
    const sandbox = mkdtempSync(join(tmpdir(), 'dsh-tmp-guard-'))
    try {
      // Vitest's own worker variables are stripped: inherited, they make the
      // nested run believe it is a worker of THIS one and it exits non-zero
      // before running anything, which would turn this guard green for a
      // reason that has nothing to do with temporary directories.
      const env = Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !key.startsWith('VITEST')),
      )
      execFileSync('npx', ['vitest', 'run', 'tests/host/'], {
        cwd: packageRoot,
        stdio: 'ignore',
        env: { ...env, TMPDIR: sandbox },
      })
      // `dsh-` only: node drops its own `node-compile-cache` here too, and
      // that is not ours to account for.
      const left = readdirSync(sandbox).filter(name => name.startsWith('dsh-'))
      expect(left, `${left.length} directories outlived the host suite`).toEqual([])
    } finally {
      rmSync(sandbox, { recursive: true, force: true })
    }
  }, 300_000)
})
