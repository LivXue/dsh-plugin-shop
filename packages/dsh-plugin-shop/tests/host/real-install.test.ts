/**
 * One real installation (spec §11.3 item 3 — the P1 exit criterion): drive
 * the executor against the real `dsh` CLI with a temporary `DSH_HOME` and a
 * `file:`-spec fixture package, then assert the profile manifest gained the
 * bundle. Subprocesses and profile state are the only parts of the shop
 * that genuinely fail at runtime, so this cannot be a fixture test.
 */

import { afterAll, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { startInstall } from '../../src/host/executor.ts'
import { dshCommand, resolveDshScript } from '../../src/host/dsh-cli.ts'
import { fileTempRoot } from './temp-root.ts'

const TEMP_ROOT = fileTempRoot('real-install')

// The test needs the real dsh CLI installed. CI installs it in
// .github/workflows/plugin.yml; the skip fires only on machines that never
// set the CLI up, so the P1 exit criterion still gates the CI run.
//
// The probe goes through the SAME resolution the executor uses rather than
// `spawnSync('dsh', …)` directly. That earlier form was itself a casualty of
// the Windows shim defect this resolution fixes: `spawn('dsh')` is always
// ENOENT there, so `hasDsh` was false on every Windows machine and the P1
// exit criterion silently skipped — the one test that would have caught the
// defect was disabled by it.
const hasDsh = (() => {
  const { command, args } = dshCommand({
    dshBin: 'dsh',
    args: ['--version'],
    platform: process.platform,
    execPath: process.execPath,
    script: resolveDshScript(
      { exists: path => existsSync(path), read: path => readFileSync(path, 'utf8') },
      { argv1: process.argv[1], path: process.env.PATH },
    ),
  })
  try {
    return spawnSync(command, args, { stdio: 'ignore' }).status === 0
  } catch {
    // spawnSync throws rather than reporting when the binary cannot be
    // started at all (a Windows .cmd shim throws EINVAL); either way the CLI
    // is unusable from here and the case skips.
    return false
  }
})()

/**
 * When set, a skipped exit-criterion case is a FAILURE rather than a silent
 * pass.
 *
 * Both this file and web-full-flow.e2e.ts probe for a working `dsh` and skip
 * when they cannot find one. That is right locally — not every machine has the
 * harness installed — and wrong in CI, where these two files ARE the P1 and P2
 * exit criteria. Reproduced 2026-09-05: with `dsh` hidden from PATH the run
 * reported `1 skipped` and **exited 0**, so a green CI run was not evidence
 * that either criterion had executed.
 *
 * plugin.yml sets it, because that workflow installs the harness precisely so
 * these can run. A machine without `dsh` still skips.
 */
const requireE2E = process.env.DSH_SHOP_REQUIRE_E2E === '1'

describe('real installation', () => {
  it('has the harness it needs, when the environment says it must', () => {
    // Not `skipIf`: the whole point is that this one cannot be skipped. It is
    // the guard that turns "the exit criterion did not run" from a silent
    // pass into a red build.
    expect(
      !requireE2E || hasDsh,
      'DSH_SHOP_REQUIRE_E2E=1 but no usable `dsh` was found, so the exit-criterion '
        + 'case below would have skipped and the run would still have exited 0. '
        + 'Either install the harness or unset the variable.',
    ).toBe(true)
  })

  const tmpHome = mkdtempSync(join(TEMP_ROOT, 'dsh-home-'))
  const fixtureDir = fileURLToPath(new URL('../fixtures/hello-packages/dsh-plugin-shop', import.meta.url))

  afterAll(() => {
    rmSync(tmpHome, { recursive: true, force: true })
  })

  it.skipIf(!hasDsh)(
    'installs a file: fixture into a temporary DSH_HOME and records the bundle',
    async () => {
      const install = startInstall({
        profile: 'test',
        spec: pathToFileURL(fixtureDir).href,
        // Pin the profile home to the temp dir: without this override the
        // child dsh would write to the developer's real DSH_HOME.
        env: { ...process.env, DSH_HOME: tmpHome },
        // The full §7.2 step-6 confirm runs end to end: the fixture IS a
        // bundle, reconcile adds it, and the manifest read must confirm it.
        expectedName: 'dsh-hello-fixture',
      })
      const status = await install.finished
      // The log carries the dsh/pnpm stderr verbatim; surface it when the
      // install itself failed so the failure is actionable.
      expect(status.state, status.log.join('\n')).toBe('done')

      const manifest = JSON.parse(
        readFileSync(join(tmpHome, 'profiles', 'test', 'package.json'), 'utf8'),
      ) as { dependencies?: Record<string, string>; dsh?: { profile?: { bundles?: string[] } } }
      expect(manifest.dsh?.profile?.bundles).toContain('dsh-hello-fixture')
      // pnpm records the spec under the package's true name; the value is
      // the normalized file: spec (a file:///… URL is written as file:/…).
      expect(manifest.dependencies?.['dsh-hello-fixture']).toMatch(/^file:/)
    },
    60_000,
  )
})
