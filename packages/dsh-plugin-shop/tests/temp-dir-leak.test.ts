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

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { nodeCliCommand } from './fixtures/node-cli.ts'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))

describe('the host suite leaves no temporary directory behind', () => {
  it('creates nothing under its own temporary directory that outlives the run', () => {
    // An isolated temporary root rather than a count of the real one: every
    // scenario's directory lands here and nowhere else, so this cannot race
    // another suite on the machine or inherit whatever backlog was there.
    const sandbox = mkdtempSync(join(tmpdir(), 'dsh-tmp-guard-'))
    try {
      // Vitest's own worker variables are stripped: inherited, they make the
      // nested run believe it is a worker of THIS one and it exits non-zero
      // before running anything, which would turn this guard green for a
      // reason that has nothing to do with temporary directories.
      const inherited = Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !key.startsWith('VITEST')),
      )
      // All three knobs, because `os.tmpdir()` reads a different one per
      // platform: TMPDIR on POSIX, TEMP then TMP on Windows. TMPDIR alone —
      // what this used to set — redirects nothing on Windows, so every
      // nested `mkdtempSync` landed in the real %TEMP% and the assertion at
      // the bottom could not fail however much the suite leaked.
      const env = { ...inherited, TMPDIR: sandbox, TEMP: sandbox, TMP: sandbox }

      // And that redirection is verified rather than assumed. Without this,
      // the only evidence for it is the emptiness of a directory nothing was
      // ever going to write to — a green run proving the sandbox exists.
      const probe = spawnSync(process.execPath, ['-p', 'require("node:os").tmpdir()'], {
        env, encoding: 'utf8',
      })
      expect(resolve((probe.stdout ?? '').trim()), 'the child does not honour the sandboxed temporary directory')
        .toBe(resolve(sandbox))

      // Vitest's own bin script under the current node, not `npx vitest`:
      // a bare `npx` is ENOENT on Windows (it installs as `npx.cmd`, and
      // libuv resolves a bare name against `.com`/`.exe` only), which took
      // this whole case down on the platform the shop is developed on.
      const report = join(sandbox, 'host-run.json')
      const { command, args } = nodeCliCommand('vitest', [
        'run', 'tests/host/', '--reporter=json', `--outputFile=${report}`,
      ])
      const run = spawnSync(command, args, { cwd: packageRoot, stdio: 'ignore', env })
      expect(run.error, `the nested run never started: ${run.error?.message ?? ''}`).toBeUndefined()

      // The child's exit STATUS is deliberately not the gate. A leaked
      // directory is a leak whether or not the scenario that made it also
      // asserted correctly, and hanging this guard on the whole host suite
      // being green makes it report someone else's failure. What it does need
      // is proof the suite RAN: nothing can leak before the scenarios that
      // create the directories execute, and a vitest that refused its
      // environment leaves an empty sandbox that satisfies the assertion
      // below for entirely the wrong reason. Every host test file having
      // produced a result is that proof, and it needs no threshold to drift.
      const summary = JSON.parse(readFileSync(report, 'utf8')) as { testResults?: unknown[] }
      const hostFiles = readdirSync(join(packageRoot, 'tests', 'host')).filter(f => f.endsWith('.test.ts'))
      expect(summary.testResults?.length ?? 0, 'the nested run did not reach every host test file').toBe(hostFiles.length)

      // `dsh-` only: node drops its own `node-compile-cache` here too, that
      // is not ours to account for, and `host-run.json` above is this file's
      // own bookkeeping rather than a scenario's leftover.
      const left = readdirSync(sandbox).filter(name => name.startsWith('dsh-'))
      expect(left, `${left.length} directories outlived the host suite`).toEqual([])
    } finally {
      rmSync(sandbox, { recursive: true, force: true })
    }
  }, 300_000)
})
