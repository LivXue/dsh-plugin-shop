import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync, chmodSync, readFileSync } from 'node:fs'
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
  })
})
