import { describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync, chmodSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { activationFailureDetail, shellSafeTarget, installFailureDetail, installTimeoutDetail, killTree, lineSink, spawnFailureDetail, startInstall, startUninstall, type InstallStatus } from '../../src/host/executor.ts'
import type { HotRestartReason } from '../../src/host/hot.ts'
import { fileTempRoot } from './temp-root.ts'

const TEMP_ROOT = fileTempRoot('executor')

// A fixture `dsh` that records its full argv in a marker file and exits with
// the requested code, proving the executor passes --profile and the pinned
// spec through: `dsh plugin --profile <p> add <spec>` is `$1 $2 $3 $4 $5`.
function fixtureDsh(exitCode: number): string {
  const dir = mkdtempSync(join(TEMP_ROOT, 'dsh-fixture-'))
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

// A fixture `dsh` that emits CRLF line endings, as every Windows console
// producer does — pnpm, node and dsh's own wrapper all write `\r\n` there. The
// bytes come from the script, not the host, so this reproduces the Windows
// stream shape while running on Linux or macOS.
function fixtureDshCrlf(exitCode: number, lines: readonly string[]): string {
  const dir = mkdtempSync(join(TEMP_ROOT, 'dsh-fixture-crlf-'))
  const bin = join(dir, 'dsh')
  const payload = lines.map(line => `${line}\\r\\n`).join('')
  writeFileSync(bin, [
    '#!/bin/sh',
    `printf '%b' '${payload}'`,
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

  // POSIX-only: the detail is platform-dependent by design, and on Windows a
  // missing binary reports the entry-lookup failure instead (see
  // `spawnFailureDetail`). Every other case in this file already depends on
  // `#!/bin/sh` fixtures, so the file as a whole does not run on Windows; the
  // Windows path is covered by dsh-cli.test.ts and real-install.test.ts.
  it.skipIf(process.platform === 'win32')('reports failed with the CLI hint when dsh is not on PATH', async () => {
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
    const dir = mkdtempSync(join(TEMP_ROOT, 'dsh-serialize-'))
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
    const dir = mkdtempSync(join(TEMP_ROOT, 'dsh-cap-'))
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
    const dir = mkdtempSync(join(TEMP_ROOT, 'dsh-stderr-'))
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
  it('strips the carriage return from CRLF output so a Windows log reads like a POSIX one', () => {
    // Windows-only defect class: every line the executor captured there kept a
    // literal `\r`, because the capture loop split on '\n' alone. The client
    // renders this log verbatim.
    const bin = fixtureDshCrlf(1, ['installing...', 'Done.'])
    const install = startInstall({ profile: 'web', spec: 'dsh-hello-plugin@1.2.0', dshBin: bin })
    return install.finished.then(status => {
      expect(status.state).toBe('failed')
      for (const line of status.log) expect(line).not.toMatch(/\r/)
      expect(status.log).toContain('installing...')
    })
  })

  it('reports the explanatory line, not pnpm punctuation, when the log arrives as CRLF', () => {
    // The picker falls back to the last line that survived the noise filter.
    // With `\r` still attached, `/^\++$/` no longer matched `+++`, so a row of
    // plus signs survived and became the reported reason the install failed —
    // precisely the defect 8851898 fixed for POSIX, reintroduced by line
    // endings alone. No ERR_/Error line here on purpose: those are picked
    // ahead of the fallback and would hide this.
    const bin = fixtureDshCrlf(1, [
      'Progress: resolved 41, reused 41, downloaded 0',
      'the bundle did not appear in dsh.profile.bundles',
      '+++',
    ])
    const install = startInstall({ profile: 'web', spec: 'dsh-hello-plugin@1.2.0', dshBin: bin })
    return install.finished.then(status => {
      expect(status.state).toBe('failed')
      expect(status.detail).toMatch(/did not appear/)
      expect(status.detail).not.toMatch(/\+\+\+/)
      expect(status.detail).not.toMatch(/\r/)
    })
  })

})

describe('startInstall post-install confirm (§7.2 step 6)', () => {
  // The confirm reads the profile manifest through app-boot's real
  // resolveProfileDir, honoring the DSH_HOME the child was spawned with; each
  // case builds a fixture home and pins it via the env option. No dsh
  // reconcile is needed — the fixture dsh exits 0 and the manifest is what
  // the confirm must verify against.
  function confirmHome(bundles: string[], dependencies: Record<string, string> = {}): string {
    const home = mkdtempSync(join(TEMP_ROOT, 'dsh-confirm-'))
    mkdirSync(join(home, 'profiles', 'web'), { recursive: true })
    writeFileSync(
      join(home, 'profiles', 'web', 'package.json'),
      JSON.stringify({ dependencies, dsh: { profile: { bundles } } }),
    )
    return home
  }

  it('reports done when the profile manifest gained the expected bundle', async () => {
    const home = confirmHome(['dsh-hello-fixture'], { 'dsh-hello-fixture': '1.0.0' })
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

  // The confirm has to establish CHANGE, not membership. A bundle row left
  // over from a previous install satisfies `bundles.includes` while THIS
  // attempt put a different package on disk — and the caller would then
  // hot-mount the old tree and publish "running now, no restart needed" over
  // an install that did nothing. The name must also be an own dependency.
  // A fixture dsh that MUTATES the profile manifest the way the real one
  // does, so the before/after difference is produced by the run rather than
  // pre-seeded. An exit-0 stub that writes nothing can only ever model "the
  // install added nothing".
  function fixtureDshAdding(home: string, name: string, spec: string): string {
    const dir = mkdtempSync(join(TEMP_ROOT, 'dsh-fixture-add-'))
    const bin = join(dir, 'dsh')
    const manifest = join(home, 'profiles', 'web', 'package.json')
    writeFileSync(bin, [
      '#!/bin/sh',
      'echo "installing..."',
      `node -e '`
      + `const f=process.argv[1];const fs=require("fs");const m=JSON.parse(fs.readFileSync(f,"utf8"));`
      + `m.dependencies=m.dependencies||{};m.dependencies[process.argv[2]]=process.argv[3];`
      + `fs.writeFileSync(f,JSON.stringify(m));`
      + `' "${manifest}" "${name}" "${spec}"`,
      'exit 0',
      '',
    ].join('\n'))
    chmodSync(bin, 0o755)
    return bin
  }

  it('refuses a leftover bundle row when this install added something else', async () => {
    // The bundle row for the entry is ALREADY there from an earlier install,
    // so a membership-only confirm passes — while this run actually put
    // `some-monorepo-root` on disk and never touched the entry.
    const home = confirmHome(['dsh-hello-fixture'], {})
    const install = startInstall({
      profile: 'web',
      spec: 'dsh-hello-fixture@1.0.0',
      dshBin: fixtureDshAdding(home, 'some-monorepo-root', 'github:acme/mono#0123456789abcdef'),
      env: { ...process.env, DSH_HOME: home },
      expectedName: 'dsh-hello-fixture',
    })
    const status = await install.finished
    expect(status.state).toBe('failed')
    expect(status.detail).toBe(
      'dsh-hello-fixture is not in the profile\'s dependencies — the install added some-monorepo-root'
      + ' instead. Remove it with: dsh plugin --profile web remove some-monorepo-root',
    )
  })

  // A bundle list that is a STRING, not an array. `readProfileManifest`
  // validates only that the document is an object, so `.includes` on a string
  // answers true for any substring and passes a confirm that never happened.
  it('refuses a bundles field that is not an array', async () => {
    const home = mkdtempSync(join(TEMP_ROOT, 'dsh-confirm-str-'))
    mkdirSync(join(home, 'profiles', 'web'), { recursive: true })
    writeFileSync(
      join(home, 'profiles', 'web', 'package.json'),
      JSON.stringify({
        dependencies: { 'dsh-plugin-shop': '1.0.0' },
        dsh: { profile: { bundles: 'dsh-plugin-shop-extras' } },
      }),
    )
    const install = startInstall({
      profile: 'web',
      spec: 'dsh-plugin-shop@1.0.0',
      dshBin: fixtureDsh(0),
      env: { ...process.env, DSH_HOME: home },
      expectedName: 'dsh-plugin-shop',
    })
    const status = await install.finished
    expect(status.state).toBe('failed')
  })

  // Was "reports failed with the stale-catalog detail". The catalog is named
  // only on this branch now — nothing was added and the name is absent, which
  // is the one shape where a catalog behind the registry is a real candidate.
  it('reports failed, naming the absent dependency, when nothing was added', async () => {
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
    expect(status.detail).toBe(
      'dsh-hello-fixture is in neither dsh.profile.bundles nor the profile\'s dependencies, and the'
      + ' install added nothing — if the entry is new the catalog may be behind; refresh it and retry.',
    )
    // The collected log lines are kept on the confirm failure path too.
    expect(status.log.join('\n')).toContain('installing...')
  })

  // A package that installed and declares no `dsh.bundle` is a different
  // outcome from one that never landed, and reporting the second for the
  // first is what sent a reader to refresh a catalog that was already right.
  it('distinguishes a plain dependency from a bundle that never landed', async () => {
    const home = confirmHome(['dsh-something-else'], { 'dsh-hello-fixture': '1.0.0' })
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
      'dsh-hello-fixture is a dependency of the profile but is not in dsh.profile.bundles, so dsh'
      + ' did not activate it as a profile layer and the shop has nothing to mount.',
    )
  })

  it('reports failed, naming the file, when the manifest cannot be read', async () => {
    // A profile dir that does not exist at all — readProfileManifest throws,
    // and the executor must not crash: it reports the same failed outcome.
    const home = mkdtempSync(join(TEMP_ROOT, 'dsh-confirm-missing-'))
    const install = startInstall({
      profile: 'web',
      spec: 'dsh-hello-fixture@1.0.0',
      dshBin: fixtureDsh(0),
      env: { ...process.env, DSH_HOME: home },
      expectedName: 'dsh-hello-fixture',
    })
    const status = await install.finished
    expect(status.state).toBe('failed')
    // Was "— the catalog may be stale; refresh it". An unreadable manifest
    // says nothing about the catalog; what it costs is knowing the outcome.
    expect(status.detail).toBe(
      `installed but the profile manifest could not be read (${join(home, 'profiles', 'web', 'package.json')})`
      + ' — the install\'s result is unknown; check that file.',
    )
  })

  // The mirror of the case above, on the BEFORE read. A manifest that cannot
  // be read before the spawn used to be reported as an empty prior state, so
  // every dependency the profile already had came back as something this
  // install added — and the detail told the reader to remove one of their own
  // working plugins. The prior state must be reported as unknown instead.
  it('does not name pre-existing dependencies as added when the before-read failed', async () => {
    const home = mkdtempSync(join(TEMP_ROOT, 'dsh-confirm-before-'))
    const profileDir = join(home, 'profiles', 'web')
    mkdirSync(profileDir, { recursive: true })
    const manifestPath = join(profileDir, 'package.json')
    // Present but unparseable at before-time; the fixture dsh then replaces it
    // wholesale with a valid manifest that lacks the expected bundle, so the
    // AFTER read succeeds and only the prior state is missing.
    writeFileSync(manifestPath, '{ not json')
    const after = { 'dsh-hello-plugin': '1.0.0', 'dsh-memory': '2.1.0' }
    const dir = mkdtempSync(join(TEMP_ROOT, 'dsh-fixture-replace-'))
    const bin = join(dir, 'dsh')
    writeFileSync(bin, [
      '#!/bin/sh',
      'echo "installing..."',
      `printf '%s' '${JSON.stringify({ dependencies: after, dsh: { profile: { bundles: [] } } })}'`
      + ` > "${manifestPath}"`,
      'exit 0',
      '',
    ].join('\n'))
    chmodSync(bin, 0o755)
    const status = await startInstall({
      profile: 'web',
      spec: '@acme/plugin@1.0.0',
      dshBin: bin,
      env: { ...process.env, DSH_HOME: home },
      expectedName: '@acme/plugin',
    }).finished
    expect(status.state).toBe('failed')
    expect(status.detail).toContain('could not be read before the install')
    for (const name of Object.keys(after)) expect(status.detail).not.toContain(name)
    expect(status.detail).not.toContain('remove')
  })

  // And the legitimate empty prior state still names what landed: an ABSENT
  // manifest means nothing was installed, which is a first install into a
  // fresh profile, not a lost read.
  it('names what landed through a real spawn into a profile with no manifest', async () => {
    const home = mkdtempSync(join(TEMP_ROOT, 'dsh-confirm-fresh-'))
    const profileDir = join(home, 'profiles', 'web')
    mkdirSync(profileDir, { recursive: true })
    const manifestPath = join(profileDir, 'package.json')
    const dir = mkdtempSync(join(TEMP_ROOT, 'dsh-fixture-fresh-'))
    const bin = join(dir, 'dsh')
    writeFileSync(bin, [
      '#!/bin/sh',
      `printf '%s' '${JSON.stringify({
        dependencies: { 'some-monorepo-root': 'github:acme/mono#0123456789abcdef' },
        dsh: { profile: { bundles: [] } },
      })}' > "${manifestPath}"`,
      'exit 0',
      '',
    ].join('\n'))
    chmodSync(bin, 0o755)
    const status = await startInstall({
      profile: 'web',
      spec: '@acme/plugin@1.0.0',
      dshBin: bin,
      env: { ...process.env, DSH_HOME: home },
      expectedName: '@acme/plugin',
    }).finished
    expect(status.state).toBe('failed')
    expect(status.detail).toContain('the install added some-monorepo-root instead')
    expect(status.detail).toContain('dsh plugin --profile web remove some-monorepo-root')
  })
})

/**
 * The Windows quoting, driven through `startInstall` so the wire is covered.
 *
 * The fixture dsh records its own argv, which is the only way to see what the
 * downstream would receive. Severing this wire used to leave the whole suite
 * byte-identical — no case passed the spec far enough for the quoting to
 * matter, which is how two misattribution bugs reached review.
 */
describe('startInstall quotes a subpackage spec for the shell dsh uses on Windows', () => {
  function specSeenByDsh(platform: NodeJS.Platform, spec: string): Promise<string> {
    const dir = mkdtempSync(join(TEMP_ROOT, 'dsh-argv-'))
    const bin = join(dir, 'dsh')
    writeFileSync(bin, ['#!/bin/sh', `printf '%s' "$5" > "${join(dir, 'spec.txt')}"`, 'exit 0', ''].join('\n'))
    chmodSync(bin, 0o755)
    return startInstall({ profile: 'web', spec, dshBin: bin, platform }).finished
      .then(() => readFileSync(join(dir, 'spec.txt'), 'utf8'))
  }

  const SUBPACKAGE = 'github:acme/mono#0123456789abcdef0123456789abcdef01234567&path:packages/rt'

  it('wraps a spec carrying &path: in quotes on win32', async () => {
    expect(await specSeenByDsh('win32', SUBPACKAGE)).toBe(`"${SUBPACKAGE}"`)
  })

  it('leaves the same spec bare off Windows, where dsh spawns pnpm with no shell', async () => {
    expect(await specSeenByDsh('linux', SUBPACKAGE)).toBe(SUBPACKAGE)
  })

  it('leaves a spec without & bare even on win32', async () => {
    expect(await specSeenByDsh('win32', 'dsh-hello-fixture@1.0.0')).toBe('dsh-hello-fixture@1.0.0')
  })
})

/**
 * `shellSafeTarget` as a value function — the same three decisions without a
 * spawn, plus the boundary the quoting depends on.
 */
describe('shellSafeTarget', () => {
  const SPEC = 'github:acme/mono#0123456789abcdef0123456789abcdef01234567&path:packages/rt'

  it('quotes only on win32, and only when the spec carries an ampersand', () => {
    expect(shellSafeTarget(SPEC, 'win32')).toBe(`"${SPEC}"`)
    expect(shellSafeTarget(SPEC, 'linux')).toBe(SPEC)
    expect(shellSafeTarget(SPEC, 'darwin')).toBe(SPEC)
    expect(shellSafeTarget('pkg@1.0.0', 'win32')).toBe('pkg@1.0.0')
  })

  // The quoting is only safe because the operand cannot already contain a
  // quote: `spawnPluginCli` refuses one before this runs, so every `"` in the
  // spawned command line is ours. If that gate ever stopped refusing `"`,
  // catalog data could close our quote and append a command.
  it('is guarded by an operand gate that refuses a quote outright', () => {
    expect(() => startInstall({
      profile: 'web',
      spec: 'github:acme/mono#0123456789abcdef0123456789abcdef01234567"&calc&path:x',
      dshBin: 'dsh',
      platform: 'win32',
    })).toThrow(/unsafe operand/)
  })
})

describe('activationFailureDetail', () => {
  const base = { expectedName: '@acme/plugin', profile: 'web' }

  it('states the dependency fact without claiming why dsh did not list it', () => {
    const detail = activationFailureDetail({ ...base, before: {}, after: { '@acme/plugin': '1.2.3' } })
    expect(detail).toContain('@acme/plugin')
    expect(detail).toContain('is not in dsh.profile.bundles')
    // No cause may be asserted here, and the catalog is not implicated when
    // the entry's own package is sitting in the profile's dependencies.
    expect(detail).not.toMatch(/catalog/i)
    expect(detail).not.toMatch(/&path:|cmd.exe|subpackage/i)
  })

  it('names what actually landed, with a command that can remove it', () => {
    const detail = activationFailureDetail({
      ...base,
      before: { 'dsh-plugin-shop': '0.8.0' },
      after: { 'dsh-plugin-shop': '0.8.0', 'some-monorepo-root': 'github:acme/mono#0123456789abcdef' },
    })
    expect(detail).toContain('some-monorepo-root')
    expect(detail).toContain('dsh plugin --profile web remove some-monorepo-root')
    // What landed is by construction NOT a catalog entry, so the shop's own
    // uninstall cannot reach it — the CLI line is the only usable instruction.
    expect(detail).not.toMatch(/catalog/i)
    // And no inference about WHY it landed.
    expect(detail).not.toMatch(/&path:|cmd.exe|Windows/i)
  })

  it('keeps the catalog as a candidate only when nothing at all was added', () => {
    const detail = activationFailureDetail({
      ...base,
      before: { 'unrelated-plugin': '2.0.0' },
      after: { 'unrelated-plugin': '2.0.0' },
    })
    expect(detail).toContain('neither dsh.profile.bundles nor')
    expect(detail).toContain('the catalog may be behind')
  })

  // `constructor` is a legal npm name, and both records are parsed from the
  // profile manifest, so they carry Object.prototype: an index read answers
  // with a function for a package that never landed. Both the presence check
  // and the added-set diff must use own-property tests.
  it('does not mistake an inherited Object.prototype key for a dependency', () => {
    for (const inherited of ['constructor', 'valueof', 'isprototypeof']) {
      const detail = activationFailureDetail({
        ...base,
        expectedName: inherited,
        before: { 'unrelated-plugin': '2.0.0' },
        after: { 'unrelated-plugin': '2.0.0' },
      })
      expect(detail).toContain('neither dsh.profile.bundles nor')
      expect(detail).not.toContain('is a dependency of the profile')
    }
    // Present for real, it still takes the dependency branch.
    expect(activationFailureDetail({
      ...base, expectedName: 'constructor', before: {}, after: { constructor: '1.0.0' },
    })).toContain('is a dependency of the profile')
    // And an inherited key must never be counted as something the install ADDED.
    expect(activationFailureDetail({
      ...base, before: {}, after: {},
    })).toContain('install added nothing')
  })

  // An ABSENT manifest is an empty prior state, and that is the truth for a
  // first install into a fresh profile — the branch that names what landed
  // has to keep working there, so `{}` must NOT be read as "unknown".
  it('names what landed when the profile had no manifest before the install', () => {
    const detail = activationFailureDetail({
      ...base,
      before: {},
      after: { 'some-monorepo-root': 'github:acme/mono#0123456789abcdef' },
    })
    expect(detail).toContain('the install added some-monorepo-root instead')
    expect(detail).toContain('dsh plugin --profile web remove some-monorepo-root')
  })

  // `null` is a manifest that EXISTED and could not be read. Both remaining
  // branches are claims about what changed, and neither survives without the
  // prior state: read as `{}`, every pre-existing dependency looks newly
  // added, so the detail would name an innocent plugin and put it in a
  // `dsh plugin remove` line.
  it('withholds both diff branches when the prior state could not be read', () => {
    const installed = { 'dsh-hello-plugin': '1.0.0', 'dsh-memory': '2.1.0', 'another-plugin': '0.4.0' }
    const detail = activationFailureDetail({ ...base, before: null, after: installed })
    expect(detail).toContain('could not be read before the install')
    expect(detail).toContain('unknown')
    for (const name of Object.keys(installed)) expect(detail).not.toContain(name)
    expect(detail).not.toContain('remove')
    // Nor may it borrow the wording of a readable manifest at either end.
    expect(detail).not.toContain('the install added')
    expect(detail).not.toContain('install added nothing')
    expect(detail).not.toMatch(/catalog/i)
  })

  // The dependency branch reads `after` alone, so an unreadable prior state
  // does not suppress the one fact that is still established.
  it('still states the dependency fact when the prior state is unknown', () => {
    const detail = activationFailureDetail({
      ...base, before: null, after: { '@acme/plugin': '1.2.3' },
    })
    expect(detail).toContain('is not in dsh.profile.bundles')
    expect(detail).not.toContain('could not be read')
  })
})

describe('startInstall afterDone seam', () => {
  it('withholds done until afterDone settles and takes its needsRestart', async () => {
    const bin = fixtureDsh(0)
    let settle: (v: { needsRestart: boolean }) => void
    let afterDoneCalls = 0
    const afterDone = () => {
      afterDoneCalls += 1
      return new Promise<{ needsRestart: boolean }>(resolve => { settle = resolve })
    }
    const running = startInstall({ profile: 'p', spec: 'fixture@1.0.0', dshBin: bin, afterDone })
    // Wait for the child to exit and the close handler to invoke afterDone;
    // under parallel-suite load no fixed sleep is safe, so poll instead.
    await vi.waitFor(() => expect(afterDoneCalls).toBe(1))
    // The child has exited and afterDone is pending — the terminal `done` is
    // withheld until it settles.
    expect(running.status().state).toBe('running')
    settle!({ needsRestart: false })
    const status = await running.finished
    expect(status.state).toBe('done')
    expect(status.needsRestart).toBe(false)
  })

  it('an afterDone failure still reports done, with needsRestart true and the fallback reason', async () => {
    const bin = fixtureDsh(0)
    const running = startInstall({ profile: 'p', spec: 'fixture@1.0.0', dshBin: bin,
      afterDone: async () => { throw new Error('boom') } })
    const status = await running.finished
    expect(status.state).toBe('done')
    expect(status.needsRestart).toBe(true)
    expect(status.restartReason).toBe('mount-failed')
  })
})

describe('startUninstall', () => {
  it('refuses a flag-like name instead of letting the CLI parse it as an option', () => {
    // A name beginning with `-` would be argv smuggling (e.g. `--profile` as
    // an operand); the executor must throw rather than spawn. The same guard
    // covers startInstall, whose spec is `name@version`.
    expect(() => startUninstall({ profile: 'web', name: '--profile' })).toThrow(
      'dsh-plugin-shop: refusing to spawn with a flag-like operand: --profile',
    )
    expect(() => startInstall({ profile: 'web', spec: '-x@1.0.0' })).toThrow(
      'dsh-plugin-shop: refusing to spawn with a flag-like operand: -x@1.0.0',
    )
  })

  it('refuses a target carrying shell punctuation, whatever built it', () => {
    // dsh itself invokes pnpm with shell mode on Windows, where these
    // characters change the command line that actually runs.
    for (const spec of ['dsh-x@1.0.0 & calc.exe', 'dsh-x@1.0.0|calc', 'dsh-x@1.0.0"', 'dsh-x@$(calc)', 'dsh-x@1.0.0\n', 'dsh-{{x}}@1.0.0']) {
      expect(() => startInstall({ profile: 'web', spec }), spec).toThrow(
        /refusing to spawn with an unsafe operand/,
      )
    }
  })

  it('spawns dsh plugin remove and reports done with needsRestart', async () => {
    const bin = fixtureDsh(0)
    const uninstall = startUninstall({ profile: 'web', name: 'dsh-hello-plugin', dshBin: bin })
    const status = await uninstall.finished
    expect(status.state).toBe('done')
    expect(status.needsRestart).toBe(true)
    expect(status.log.join('\n')).toContain('installing...')
    const calls = readFileSync(join(dirname(bin), 'calls.log'), 'utf8')
    expect(calls).toContain('plugin --profile web remove dsh-hello-plugin')
  })

  it('passes afterDone through: withholds done and takes its needsRestart and restartReason', async () => {
    const bin = fixtureDsh(0)
    let settle: (v: { needsRestart: boolean; restartReason?: HotRestartReason }) => void
    let afterDoneCalls = 0
    const afterDone = () => {
      afterDoneCalls += 1
      return new Promise<{ needsRestart: boolean; restartReason?: HotRestartReason }>(resolve => { settle = resolve })
    }
    const running = startUninstall({ profile: 'web', name: 'dsh-hello-plugin', dshBin: bin, afterDone })
    await vi.waitFor(() => expect(afterDoneCalls).toBe(1))
    expect(running.status().state).toBe('running')
    settle!({ needsRestart: false, restartReason: 'mount-failed' })
    const status = await running.finished
    expect(status.state).toBe('done')
    expect(status.needsRestart).toBe(false)
    expect(status.restartReason).toBe('mount-failed')
  })

  it('reports failed with the recovery hint when pnpm fails', async () => {
    const bin = fixtureDsh(1)
    const uninstall = startUninstall({ profile: 'web', name: 'dsh-hello-plugin', dshBin: bin })
    const status = await uninstall.finished
    expect(status.state).toBe('failed')
    expect(status.detail).toContain('dsh plugin --profile web install')
  })
})

describe('startUninstall post-remove confirm', () => {
  function confirmHome(bundles: string[]): string {
    const home = mkdtempSync(join(TEMP_ROOT, 'dsh-confirm-remove-'))
    mkdirSync(join(home, 'profiles', 'web'), { recursive: true })
    writeFileSync(
      join(home, 'profiles', 'web', 'package.json'),
      JSON.stringify({ dsh: { profile: { bundles } } }),
    )
    return home
  }

  it('reports done when the profile manifest lost the expected bundle', async () => {
    const home = confirmHome(['dsh-something-else'])
    const uninstall = startUninstall({
      profile: 'web',
      name: 'dsh-hello-fixture',
      dshBin: fixtureDsh(0),
      env: { ...process.env, DSH_HOME: home },
      expectedName: 'dsh-hello-fixture',
    })
    const status = await uninstall.finished
    expect(status.state).toBe('done')
    expect(status.needsRestart).toBe(true)
  })

  it('reports failed with the re-run detail when the bundle is still present', async () => {
    const home = confirmHome(['dsh-hello-fixture'])
    const uninstall = startUninstall({
      profile: 'web',
      name: 'dsh-hello-fixture',
      dshBin: fixtureDsh(0),
      env: { ...process.env, DSH_HOME: home },
      expectedName: 'dsh-hello-fixture',
    })
    const status = await uninstall.finished
    expect(status.state).toBe('failed')
    expect(status.detail).toBe('removed but dsh.profile.bundles did not change — re-run the uninstall')
  })

  it('reports failed, naming the file, when the manifest cannot be read', async () => {
    const home = mkdtempSync(join(TEMP_ROOT, 'dsh-confirm-remove-missing-'))
    const uninstall = startUninstall({
      profile: 'web',
      name: 'dsh-hello-fixture',
      dshBin: fixtureDsh(0),
      env: { ...process.env, DSH_HOME: home },
      expectedName: 'dsh-hello-fixture',
    })
    const status = await uninstall.finished
    expect(status.state).toBe('failed')
    expect(status.detail).toBe(
      `removed but the profile manifest could not be read (${join(home, 'profiles', 'web', 'package.json')}) — re-run the uninstall`,
    )
  })
})

describe('installFailureDetail', () => {
  // Both fixtures are verbatim logs from real failed installs run against the
  // live catalog on dsh 0.1.1-rc.2 (2026-09-02), in a throwaway DSH_HOME.
  // Sampling 40 random npm entries end to end, 2 failed — and in BOTH the
  // useful line was in the log while `log[log.length - 1]` was noise, so the
  // shop reported "Install failed" over a detail that said nothing.

  it('surfaces the pnpm error code rather than dsh\'s own trailing wrapper', () => {
    // dsh-agent-toolkit@0.2.2 and dsh-imessage: a TRANSITIVE dependency
    // carries a build script, which pnpm blocks by default and exits non-zero
    // for. The registry's `requires-build` gate only reads a repo's OWN
    // manifest, so this class reaches the install — the 2026-08-30 design's
    // own spot-check noted it ("the fifth a transitive postinstall script")
    // and left it open.
    const log = [
      '+ dsh-agent-toolkit 0.2.2',
      'Added 1 entry to minimumReleaseAgeExclude in pnpm-workspace.yaml',
      '  dsh-agent-toolkit@0.2.2',
      '[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: protobufjs@7.6.6',
      'Run "pnpm approve-builds" to pick which dependencies should be allowed to run scripts.',
      'dsh: pnpm failed in profile directory /root/probe/profiles/f5',
    ]
    const detail = installFailureDetail('web', log)
    expect(detail).toMatch(/ERR_PNPM_IGNORED_BUILDS/)
    expect(detail).toMatch(/protobufjs@7\.6\.6/)
    // The build-script block is the user's decision to make, not ours to
    // bypass: the shop never passes allowBuilds (§7.2), so the detail has to
    // name the approval step instead.
    expect(detail).toMatch(/approve-builds/)
    // The line that used to be reported said only that pnpm failed, in a
    // directory the user did not choose and cannot act on.
    expect(detail).not.toMatch(/pnpm failed in profile directory/)
  })

  it('surfaces a thrown error rather than the node version footer', () => {
    // dsh-plan-adversarial@0.1.0: pnpm SUCCEEDED ("Done in 581ms"), then
    // dsh's own readProfileManifest threw on a UTF-8 BOM in the package.json.
    // That is an upstream dsh defect, not a shop one — but the shop reported
    // it as `Node.js v26.6.0`, the literal last line, which is why a user
    // cannot tell an install failure from a crash.
    const log = [
      'Done in 581ms using pnpm v11.13.0',
      '<anonymous_script>:1',
      '﻿{',
      '^',
      'SyntaxError: Unexpected token \'﻿\', "﻿{ "name"... is not valid JSON',
      '    at JSON.parse (<anonymous>)',
      '    at readProfileManifest (file:///…/dsh-app-boot/lib/index.js:453:22)',
      'Node.js v26.6.0',
    ]
    const detail = installFailureDetail('web', log)
    expect(detail).toMatch(/SyntaxError/)
    expect(detail).toMatch(/not valid JSON/)
    expect(detail).not.toMatch(/Node\.js v26/)
  })

  it('keeps the recovery hint and falls back to the last line when nothing looks diagnostic', () => {
    const detail = installFailureDetail('web', ['something unhelpful happened'])
    expect(detail).toMatch(/Run: dsh plugin --profile web install/)
    expect(detail).toMatch(/something unhelpful happened/)
    // An empty log must not produce a dangling separator.
    expect(installFailureDetail('web', [])).toMatch(/Run: dsh plugin --profile web install/)
  })
  it('tolerates carriage returns already attached to the lines', () => {
    // Defence in depth. The capture loop normalizes now, but these patterns
    // are the fragile part: every one of them anchors with `$`, and `$` without
    // /m matches only at end of string — so one trailing control character
    // silently disables the filter that line was written for.
    const log = [
      'Progress: resolved 41, reused 41, downloaded 0\r',
      'the bundle did not appear in dsh.profile.bundles\r',
      '+++\r',
    ]
    const detail = installFailureDetail('web', log)
    expect(detail).toMatch(/did not appear/)
    expect(detail).not.toMatch(/\+\+\+/)
    expect(detail).not.toMatch(/\r/)
  })


  it('carries pnpm\'s root cause, not just the code that names the failure', () => {
    // Reported 2026-09-06 against 0.8.0-beta.0. pnpm prints a code line and
    // then a causal chain beneath it; the code line is the only one carrying
    // ERR_, so the picker took it and the user read a detail that named a
    // failure class and nothing about why. The chain's last link — pnpm marks
    // it `╰─▶` — is the reason, and it is what tells this user their network
    // timed out on a 151 MB tarball rather than that the plugin is broken.
    const log = [
      'Error: ERR_PNPM_PACKAGE_MANAGER_ADD_RESOLVE_GIT',
      '  × adding a new package',
      '  ├─▶ Failed to resolve git dependency "github:nexu-io/open-design#c5ae629&path:packages/dsh-runtime"',
      '  ├─▶ error decoding response body',
      '  ├─▶ request or response body error',
      '  ╰─▶ operation timed out',
      'dsh: pnpm failed in profile directory /Users/admin/.dsh/profiles/web',
    ]
    const detail = installFailureDetail('web', log)
    expect(detail).toContain('ERR_PNPM_PACKAGE_MANAGER_ADD_RESOLVE_GIT')
    expect(detail, 'the reason the user needs is the chain\'s last link').toContain('operation timed out')
    // Still one line: the intermediate links are not piled on.
    expect(detail).not.toContain('error decoding response body')
    expect(detail.split('\n')).toHaveLength(1)
  })

  it('adds nothing when the picked line has no causal chain under it', () => {
    // The common case must not grow a trailing colon or a duplicated clause.
    const detail = installFailureDetail('web', ['[ERR_PNPM_FETCH_404] GET https://registry.npmjs.org/dsh-nope: Not Found - 404'])
    expect(detail).toBe(
      'pnpm failed in the profile. Run: dsh plugin --profile web install'
      + ' — [ERR_PNPM_FETCH_404] GET https://registry.npmjs.org/dsh-nope: Not Found - 404',
    )
  })

  it('picks the LAST pnpm error code when a failed install emits several', () => {
    // "Scanning from the end" is the documented rule, and with two codes it is
    // the only thing that decides which one a user reads. Both existing
    // verbatim fixtures carry exactly one diagnostic line, so dropping the
    // reverse and taking the first match passed (H-3). pnpm emits the peer
    // warning while resolving and the fetch failure when it gives up: the later
    // line is the one that ended the install.
    const log = [
      '+ dsh-two-codes 1.0.0',
      '[ERR_PNPM_PEER_DEP_ISSUES] Unmet peer dependencies',
      'Progress: resolved 12, reused 12, downloaded 0',
      '[ERR_PNPM_FETCH_404] GET https://registry.npmjs.org/dsh-nope: Not Found - 404',
      'dsh: pnpm failed in profile directory /root/probe/profiles/f7',
    ]
    const detail = installFailureDetail('web', log)
    expect(detail).toMatch(/ERR_PNPM_FETCH_404/)
    expect(detail).not.toMatch(/ERR_PNPM_PEER_DEP_ISSUES/)
    // The noise filter still ran: neither the Progress line nor dsh's own
    // wrapper may be what the user is shown.
    expect(detail).not.toMatch(/Progress: resolved/)
    expect(detail).not.toMatch(/pnpm failed in profile directory/)
    // The approve-builds hint belongs to ERR_PNPM_IGNORED_BUILDS alone.
    expect(detail).not.toMatch(/approve-builds/)
  })

  it('prefers a pnpm error code over a thrown error even when the throw came later', () => {
    // The rule is a precedence, not a position: "a pnpm error code first, then
    // any thrown error". The TypeError below is LATER in the log than the pnpm
    // code, so scanning from the end alone would pick it — which is what makes
    // this able to catch a swap of the two find clauses. pnpm named the actual
    // failure; dsh's own reconcile then threw over the half-installed profile,
    // which is a consequence, not the cause.
    const log = [
      'Done in 1.2s using pnpm v11.13.0',
      '[ERR_PNPM_NO_MATCHING_VERSION] No matching version found for dsh-nope@9.9.9',
      'TypeError: Cannot read properties of undefined (reading \'bundles\')',
      '    at reconcile (file:///…/dsh-app-boot/lib/index.js:512:9)',
      'Node.js v26.6.0',
    ]
    const detail = installFailureDetail('web', log)
    expect(detail).toMatch(/ERR_PNPM_NO_MATCHING_VERSION/)
    expect(detail).toMatch(/dsh-nope@9\.9\.9/)
    expect(detail).not.toMatch(/TypeError/)
    expect(detail).not.toMatch(/Node\.js v26/)
    expect(detail).toMatch(/Run: dsh plugin --profile web install/)
  })
})

describe('the install deadline and the process group (F-1)', () => {
  function grandchildDsh(sleepSeconds: number): { bin: string; pidFile: string } {
    const dir = mkdtempSync(join(TEMP_ROOT, 'dsh-grandchild-'))
    const pidFile = join(dir, 'grandchild.pid')
    const bin = join(dir, 'dsh')
    writeFileSync(bin, [
      '#!/bin/sh',
      'echo "installing..."',
      `sleep ${sleepSeconds} &`,
      `echo $! > "${pidFile}"`,
      'exit 0',
      '',
    ].join('\n'))
    chmodSync(bin, 0o755)
    return { bin, pidFile }
  }

  it('settles on exit even while a grandchild holds the pipe', async () => {
    const { bin, pidFile } = grandchildDsh(20)
    const started = Date.now()
    const status = await startInstall({ profile: 'grandchild', spec: 'a@1.0.0', dshBin: bin }).finished
    expect(status.state).toBe('done')
    expect(status.log.join('\n')).toContain('installing...')
    expect(Date.now() - started).toBeLessThan(5000)
    const grandchild = Number(readFileSync(pidFile, 'utf8').trim())
    try {
      process.kill(grandchild, 'SIGKILL')
    } catch {
      // Already gone; nothing to clean up.
    }
  })

  it('stops a command that outlives its deadline and frees the profile queue', async () => {
    const dir = mkdtempSync(join(TEMP_ROOT, 'dsh-deadline-'))
    const hung = join(dir, 'dsh')
    writeFileSync(hung, [
      '#!/bin/sh',
      'sleep 30 &',
      `echo $! > "${join(dir, 'gpid')}"`,
      'wait',
      '',
    ].join('\n'))
    chmodSync(hung, 0o755)

    const first = startInstall({ profile: 'deadline', spec: 'a@1.0.0', dshBin: hung, timeoutMs: 300 })
    const second = startInstall({ profile: 'deadline', spec: 'b@1.0.0', dshBin: fixtureDsh(0) })
    const firstStatus = await first.finished
    expect(firstStatus.state).toBe('failed')
    expect(firstStatus.detail).toMatch(/did not finish within 1s and was stopped/)
    expect(firstStatus.detail).toMatch(/dsh plugin --profile deadline install/)
    expect((await second.finished).state).toBe('done')

    const grandchild = Number(readFileSync(join(dir, 'gpid'), 'utf8').trim())
    await vi.waitFor(() => { expect(() => process.kill(grandchild, 0)).toThrow() })
  })

  it('names the deadline rather than blaming pnpm', () => {
    const detail = installTimeoutDetail('web', 900_000)
    expect(detail).toMatch(/did not finish within 900s and was stopped/)
    expect(detail).toMatch(/dsh plugin --profile web install/)
    expect(detail).not.toMatch(/pnpm failed/)
  })
})

describe('killTree', () => {
  it('walks the tree with taskkill on Windows and with the group on POSIX', () => {
    const calls: string[] = []
    const kills = {
      killGroup: (pid: number) => { calls.push(`group:${pid}`) },
      killPid: (pid: number) => { calls.push(`pid:${pid}`) },
      taskkill: (pid: number) => { calls.push(`taskkill:${pid}`) },
    }
    killTree(4242, 'win32', kills)
    expect(calls).toEqual(['taskkill:4242'])
    calls.length = 0
    killTree(4242, 'linux', kills)
    expect(calls).toEqual(['group:4242'])
    calls.length = 0
    killTree(4242, 'linux', {
      ...kills,
      killGroup: () => { throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' }) },
    })
    expect(calls).toEqual(['pid:4242'])
    calls.length = 0
    killTree(undefined, 'linux', kills)
    expect(calls).toEqual([])
  })
})

describe('lineSink (F-6)', () => {
  it('completes a line split across chunks instead of emitting the fragment', () => {
    const lines: string[] = []
    const sink = lineSink(line => lines.push(line))
    sink.write(Buffer.from(' ERR_PNPM_FE'))
    sink.write(Buffer.from('TCH_404 GET https://r/x: Not Found - 404\n'))
    sink.flush()
    expect(lines).toEqual([' ERR_PNPM_FETCH_404 GET https://r/x: Not Found - 404'])
  })

  it('reassembles a multi-byte character split across chunks', () => {
    const lines: string[] = []
    const sink = lineSink(line => lines.push(line))
    const bytes = Buffer.from('已安装\n', 'utf8')
    sink.write(bytes.subarray(0, 4))
    sink.write(bytes.subarray(4))
    sink.flush()
    expect(lines).toEqual(['已安装'])
  })

  it('emits a final line the stream never terminated', () => {
    const lines: string[] = []
    const sink = lineSink(line => lines.push(line))
    sink.write(Buffer.from('no newline here'))
    expect(lines).toEqual([])
    sink.flush()
    expect(lines).toEqual(['no newline here'])
  })

  it('splits CRLF as well as LF and drops empty lines', () => {
    const lines: string[] = []
    const sink = lineSink(line => lines.push(line))
    sink.write(Buffer.from('a\r\n\r\nb\r\n'))
    sink.flush()
    expect(lines).toEqual(['a', 'b'])
  })
})

describe('startInstall line assembly (F-6)', () => {
  it('reports the whole line when the stream splits it, not the fragment', async () => {
    const dir = mkdtempSync(join(TEMP_ROOT, 'dsh-split-'))
    const bin = join(dir, 'dsh')
    writeFileSync(bin, [
      '#!/bin/sh',
      "printf '%s' ' ERR_PNPM_FE'",
      'sleep 0.3',
      "printf '%s\\n' 'TCH_404 GET https://r/x: Not Found - 404'",
      'exit 1',
      '',
    ].join('\n'))
    chmodSync(bin, 0o755)
    const status = await startInstall({ profile: 'split', spec: 'a@1.0.0', dshBin: bin }).finished
    expect(status.state).toBe('failed')
    expect(status.log).toEqual([' ERR_PNPM_FETCH_404 GET https://r/x: Not Found - 404'])
    expect(status.detail).toMatch(/ERR_PNPM_FETCH_404/)
  })

  it('keeps a final unterminated line in the log', async () => {
    const dir = mkdtempSync(join(TEMP_ROOT, 'dsh-unterminated-'))
    const bin = join(dir, 'dsh')
    writeFileSync(bin, ['#!/bin/sh', "printf '%s' 'the bundle did not appear'", 'exit 1', ''].join('\n'))
    chmodSync(bin, 0o755)
    const status = await startInstall({ profile: 'unterminated', spec: 'a@1.0.0', dshBin: bin }).finished
    expect(status.log).toEqual(['the bundle did not appear'])
    expect(status.detail).toMatch(/did not appear/)
  })
})

describe('spawnFailureDetail', () => {
  // Reported from Windows (2026-09-02): updating the shop showed "Update
  // failed / dsh not found on PATH — install the dsh CLI to manage profile
  // plugins" on a machine where dsh WAS installed and working. The advice was
  // not just unhelpful, it was wrong: npm installs a CLI on Windows as
  // `dsh.cmd` / `dsh.ps1` shims with no `.exe`, and CreateProcess (which
  // node's spawn uses without a shell) resolves a bare name against `.exe`
  // only — so it can never find `dsh`, however correctly it is installed.
  //
  // `dsh-cli.ts` now runs the CLI's own JS entry through node, so this
  // function no longer describes an unconditional Windows gap: reaching it
  // means the entry could not be LOCATED. The two cases below kept their
  // assertions (the POSIX advice is still wrong here, and the mechanism is
  // still worth naming) and gained the third, which pins the new claim.
  const ENOENT = 'spawn dsh ENOENT'

  it('does not tell a Windows user to install the dsh they already have', () => {
    const detail = spawnFailureDetail('ENOENT', ENOENT, 'dsh', 'win32')
    expect(detail).not.toMatch(/install the dsh CLI/)
    expect(detail).toMatch(/Windows/)
    // Names the actual mechanism, so the report is actionable rather than
    // mysterious: this is the shop's own gap, not the user's setup.
    expect(detail).toMatch(/\.cmd/)
  })

  it('says the CLI entry could not be located, and which package carries it', () => {
    // The recovery step a user can actually take. The old text told them to
    // run the update by hand "until the shop can do it for you", which is now
    // false — the shop does do it, so a failure here is a lookup that came up
    // empty and `dsh --version` is the thing to check.
    const detail = spawnFailureDetail('ENOENT', ENOENT, 'dsh', 'win32')
    expect(detail).toMatch(/@deepseek-ai\/dsh/)
    expect(detail).toMatch(/dsh --version/)
    expect(detail).not.toMatch(/until the shop can do it for you/)
  })

  it('keeps the honest advice where a missing binary really is the cause', () => {
    expect(spawnFailureDetail('ENOENT', ENOENT, 'dsh', 'linux')).toMatch(/install the dsh CLI/)
    expect(spawnFailureDetail('ENOENT', ENOENT, 'dsh', 'darwin')).toMatch(/install the dsh CLI/)
  })

  it('treats EINVAL on Windows as the same shim problem', () => {
    // Node refuses to spawn a .cmd without a shell since the 2024 batfile
    // argument-injection fix, and surfaces EINVAL rather than ENOENT when the
    // path resolves. Both arrive here as the same underlying gap.
    const detail = spawnFailureDetail('EINVAL', 'spawn EINVAL', 'C:\\npm\\dsh.cmd', 'win32')
    expect(detail).toMatch(/Windows/)
    expect(detail).not.toMatch(/install the dsh CLI/)
  })

  it('reports any other spawn failure verbatim', () => {
    expect(spawnFailureDetail('EACCES', 'spawn dsh EACCES', 'dsh', 'linux'))
      .toBe('dsh spawn failed: spawn dsh EACCES')
  })
})

describe('the child environment (F-12 residual)', () => {
  it('passes the parent environment to the child, deliberately', async () => {
    const dir = mkdtempSync(join(TEMP_ROOT, 'dsh-env-'))
    const bin = join(dir, 'dsh')
    writeFileSync(bin, ['#!/bin/sh', `printf '%s\n' "$SHOP_F12_PROBE" > "${join(dir, 'env.txt')}"`, 'exit 0', ''].join('\n'))
    chmodSync(bin, 0o755)
    process.env.SHOP_F12_PROBE = 'inherited'
    try {
      await startInstall({ profile: 'env', spec: 'a@1.0.0', dshBin: bin }).finished
      expect(readFileSync(join(dir, 'env.txt'), 'utf8').trim()).toBe('inherited')
    } finally {
      delete process.env.SHOP_F12_PROBE
    }
  })

  it('uses only the given environment when one is passed', async () => {
    const dir = mkdtempSync(join(TEMP_ROOT, 'dsh-env-pinned-'))
    const bin = join(dir, 'dsh')
    writeFileSync(bin, ['#!/bin/sh', `printf '%s\n' "$SHOP_F12_PROBE" > "${join(dir, 'env.txt')}"`, 'exit 0', ''].join('\n'))
    chmodSync(bin, 0o755)
    process.env.SHOP_F12_PROBE = 'inherited'
    try {
      await startInstall({ profile: 'env-pinned', spec: 'a@1.0.0', dshBin: bin, env: { PATH: process.env.PATH ?? '' } }).finished
      expect(readFileSync(join(dir, 'env.txt'), 'utf8').trim()).toBe('')
    } finally {
      delete process.env.SHOP_F12_PROBE
    }
  })
})
