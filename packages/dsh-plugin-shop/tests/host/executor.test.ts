import { describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync, chmodSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { installFailureDetail, installTimeoutDetail, killTree, lineSink, spawnFailureDetail, startInstall, startUninstall, type InstallStatus } from '../../src/host/executor.ts'
import type { HotRestartReason } from '../../src/host/hot.ts'

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

// A fixture `dsh` that emits CRLF line endings, as every Windows console
// producer does — pnpm, node and dsh's own wrapper all write `\r\n` there. The
// bytes come from the script, not the host, so this reproduces the Windows
// stream shape while running on Linux or macOS.
function fixtureDshCrlf(exitCode: number, lines: readonly string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-fixture-crlf-'))
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
    const home = mkdtempSync(join(tmpdir(), 'dsh-confirm-remove-'))
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
    const home = mkdtempSync(join(tmpdir(), 'dsh-confirm-remove-missing-'))
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
    const dir = mkdtempSync(join(tmpdir(), 'dsh-grandchild-'))
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
    const dir = mkdtempSync(join(tmpdir(), 'dsh-deadline-'))
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
    const dir = mkdtempSync(join(tmpdir(), 'dsh-split-'))
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
    const dir = mkdtempSync(join(tmpdir(), 'dsh-unterminated-'))
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
    const dir = mkdtempSync(join(tmpdir(), 'dsh-env-'))
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
    const dir = mkdtempSync(join(tmpdir(), 'dsh-env-pinned-'))
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
