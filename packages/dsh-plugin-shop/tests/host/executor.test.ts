import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync, chmodSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { startInstall, type InstallStatus } from '../../src/host/executor.ts'

// A fixture `dsh` that records its full argv in a marker file and exits with
// the requested code, proving the executor passes --profile and the pinned
// spec through: `dsh plugin --profile <p> add <spec>` is `$1 $2 $3 $4 $5`.
function fixtureDsh(exitCode: number): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-fixture-'))
  const bin = join(dir, 'dsh')
  writeFileSync(bin, [
    '#!/bin/sh',
    `echo "$1 $2 $3 $4 $5" >> "${join(dir, 'calls.log')}"`,
    'echo "installing..."',
    `exit ${exitCode}`,
    '',
  ].join('\n'))
  chmodSync(bin, 0o755)
  return bin
}

describe('startInstall', () => {
  it('spawns dsh plugin with the pinned spec and reports done with needsRestart', async () => {
    const bin = fixtureDsh(0)
    const install = startInstall({ profile: 'web', spec: 'dsh-hello-plugin@1.2.0', dshBin: bin })
    const status = await install.finished
    expect(status.state).toBe('done')
    expect(status.needsRestart).toBe(true)
    expect(status.log.join('\n')).toContain('installing...')
    const calls = readFileSync(join(dirname(bin), 'calls.log'), 'utf8')
    expect(calls).toContain('plugin --profile web add dsh-hello-plugin@1.2.0')
  })

  it('reports failed with the recovery hint when pnpm fails', async () => {
    const bin = fixtureDsh(1)
    const install = startInstall({ profile: 'web', spec: 'dsh-hello-plugin@1.2.0', dshBin: bin })
    const status = await install.finished
    expect(status.state).toBe('failed')
    expect(status.detail).toContain('dsh plugin --profile web install')
  })

  it('reports failed with the CLI hint when dsh is not on PATH', async () => {
    const install = startInstall({ profile: 'web', spec: 'dsh-hello-plugin@1.2.0', dshBin: join(tmpdir(), 'no-such-dsh-bin') })
    const status = await install.finished
    expect(status.state).toBe('failed')
    expect(status.detail).toBe('dsh not found on PATH — install the dsh CLI to manage profile plugins')
  })

  it('reports progress through onStatus as lines arrive', async () => {
    const bin = fixtureDsh(0)
    const seen: InstallStatus[] = []
    const install = startInstall({ profile: 'web', spec: 'x@1.0.0', dshBin: bin, onStatus: s => { seen.push(s) } })
    await install.finished
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.some(s => s.log.includes('installing...'))).toBe(true)
    expect(seen[seen.length - 1]?.state).toBe('done')
  })

  it('serializes installs into one profile', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-serialize-'))
    const bin = join(dir, 'dsh')
    writeFileSync(bin, [
      '#!/bin/sh',
      `echo "start $3" >> "${join(dir, 'events.log')}"`,
      'sleep 0.2',
      `echo "end $3" >> "${join(dir, 'events.log')}"`,
      'exit 0',
      '',
    ].join('\n'))
    chmodSync(bin, 0o755)
    const first = startInstall({ profile: 'web', spec: 'a@1.0.0', dshBin: bin })
    const second = startInstall({ profile: 'web', spec: 'b@1.0.0', dshBin: bin })
    const other = startInstall({ profile: 'tui', spec: 'c@1.0.0', dshBin: bin })
    await Promise.all([first.finished, second.finished, other.finished])
    const events = readFileSync(join(dir, 'events.log'), 'utf8').trim().split('\n')
    // The two `web` installs never interleave: each start is followed by its own end.
    const web = events.filter(line => line.includes('web'))
    expect(web).toEqual(['start web', 'end web', 'start web', 'end web'])
    // The mutex is per profile, not global: `tui` installs in parallel with
    // `web`, so its start lands while web's first install is still sleeping —
    // before the first `end web`. A global mutex would serialize it behind
    // web's second install and this assertion would fail.
    expect(events.indexOf('start tui')).toBeLessThan(events.indexOf('end web'))
  })

  it('caps the log at 200 lines, dropping the oldest', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-cap-'))
    const bin = join(dir, 'dsh')
    writeFileSync(bin, [
      '#!/bin/sh',
      'i=1',
      'while [ $i -le 250 ]; do',
      '  echo "line $i"',
      '  i=$((i+1))',
      'done',
      'exit 0',
      '',
    ].join('\n'))
    chmodSync(bin, 0o755)
    const install = startInstall({ profile: 'web', spec: 'a@1.0.0', dshBin: bin })
    const status = await install.finished
    // 250 newline-terminated lines: the cap keeps exactly the newest 200,
    // regardless of chunk boundaries, and the last is the 250th line.
    expect(status.log).toHaveLength(200)
    expect(status.log[199]).toBe('line 250')
  })

  it('surfaces stderr verbatim in the log with the recovery hint on failure', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-stderr-'))
    const bin = join(dir, 'dsh')
    writeFileSync(bin, [
      '#!/bin/sh',
      'echo "boom one" >&2',
      'echo "boom two" >&2',
      'exit 1',
      '',
    ].join('\n'))
    chmodSync(bin, 0o755)
    const install = startInstall({ profile: 'web', spec: 'a@1.0.0', dshBin: bin })
    const status = await install.finished
    expect(status.state).toBe('failed')
    expect(status.log).toContain('boom one')
    expect(status.log).toContain('boom two')
    expect(status.detail).toContain('dsh plugin --profile web install')
  })
})

describe('startInstall post-install confirm (§7.2 step 6)', () => {
  // The confirm reads the profile manifest through app-boot's real
  // resolveProfileDir, honoring the DSH_HOME the child was spawned with; each
  // case builds a fixture home and pins it via the env option. No dsh
  // reconcile is needed — the fixture dsh exits 0 and the manifest is what
  // the confirm must verify against.
  function confirmHome(bundles: string[]): string {
    const home = mkdtempSync(join(tmpdir(), 'dsh-confirm-'))
    mkdirSync(join(home, 'profiles', 'web'), { recursive: true })
    writeFileSync(
      join(home, 'profiles', 'web', 'package.json'),
      JSON.stringify({ dsh: { profile: { bundles } } }),
    )
    return home
  }

  it('reports done when the profile manifest gained the expected bundle', async () => {
    const home = confirmHome(['dsh-hello-fixture'])
    const install = startInstall({
      profile: 'web',
      spec: 'dsh-hello-fixture@1.0.0',
      dshBin: fixtureDsh(0),
      env: { ...process.env, DSH_HOME: home },
      expectedName: 'dsh-hello-fixture',
    })
    const status = await install.finished
    expect(status.state).toBe('done')
    expect(status.needsRestart).toBe(true)
    expect(status.log.join('\n')).toContain('installing...')
  })

  it('reports failed with the stale-catalog detail when bundles did not change', async () => {
    const home = confirmHome(['dsh-something-else'])
    const install = startInstall({
      profile: 'web',
      spec: 'dsh-hello-fixture@1.0.0',
      dshBin: fixtureDsh(0),
      env: { ...process.env, DSH_HOME: home },
      expectedName: 'dsh-hello-fixture',
    })
    const status = await install.finished
    expect(status.state).toBe('failed')
    expect(status.detail).toBe('installed but dsh.profile.bundles did not change — the catalog may be stale; refresh it')
    // The collected log lines are kept on the confirm failure path too.
    expect(status.log.join('\n')).toContain('installing...')
  })

  it('reports failed, naming the file, when the manifest cannot be read', async () => {
    // A profile dir that does not exist at all — readProfileManifest throws,
    // and the executor must not crash: it reports the same failed outcome.
    const home = mkdtempSync(join(tmpdir(), 'dsh-confirm-missing-'))
    const install = startInstall({
      profile: 'web',
      spec: 'dsh-hello-fixture@1.0.0',
      dshBin: fixtureDsh(0),
      env: { ...process.env, DSH_HOME: home },
      expectedName: 'dsh-hello-fixture',
    })
    const status = await install.finished
    expect(status.state).toBe('failed')
    expect(status.detail).toBe(
      `installed but the profile manifest could not be read (${join(home, 'profiles', 'web', 'package.json')}) — the catalog may be stale; refresh it`,
    )
  })
})
