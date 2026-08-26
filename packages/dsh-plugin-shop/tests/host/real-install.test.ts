/**
 * One real installation (spec §11.3 item 3 — the P1 exit criterion): drive
 * the executor against the real `dsh` CLI with a temporary `DSH_HOME` and a
 * `file:`-spec fixture package, then assert the profile manifest gained the
 * bundle. Subprocesses and profile state are the only parts of the store
 * that genuinely fail at runtime, so this cannot be a fixture test.
 */

import { afterAll, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { startInstall } from '../../src/host/executor.ts'

// The test needs the real dsh executable on PATH. CI installs it in
// .github/workflows/plugin.yml; the skip fires only on machines that never
// set the CLI up, so the P1 exit criterion still gates the CI run.
const hasDsh = (() => {
  try {
    const probe = spawnSync('dsh', ['--version'], { stdio: 'ignore' })
    return probe.status === 0
  } catch {
    return false
  }
})()

describe('real installation', () => {
  const tmpHome = mkdtempSync(join(tmpdir(), 'dsh-home-'))
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
