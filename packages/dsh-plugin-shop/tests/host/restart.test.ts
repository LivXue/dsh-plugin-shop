import { describe, expect, it } from 'vitest'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { restartCommand, startRestart } from '../../src/host/restart.ts'
import { fileTempRoot } from './temp-root.ts'

const TEMP_ROOT = fileTempRoot('restart')

// A fixture `dsh` that records its argv in a marker file when it finally
// runs — the marker's appearance is the proof the helper waited for the
// parent pid and then exec'd the command.
//
// Still a `#!/bin/sh` script, deliberately, unlike every other fixture in
// this suite: it is `exec`'d by the POSIX helper, and the two cases that use
// it are the two that cannot run on Windows at all (see their skip). A node
// script here would suggest the helper had become portable.
function fixtureDsh(marker: string): string {
  const dir = mkdtempSync(join(TEMP_ROOT, 'dsh-restart-bin-'))
  const bin = join(dir, 'dsh')
  writeFileSync(bin, [
    '#!/bin/sh',
    `echo "$1 $2 $3" >> "${marker}"`,
    'echo "dsh web: http://127.0.0.1:9999"',
    'exit 0',
    '',
  ].join('\n'))
  chmodSync(bin, 0o755)
  return bin
}

/** The two cases that drive the handoff end to end. `startRestart` spawns
 * `sh -c` with `kill -0`, `sleep` and `exec "$@"`, none of which Windows has
 * — the gateway refuses a restart there before reaching this module at all
 * (index.ts `restartPlatformSupported`, asserted in `index.test.ts`). So this
 * is the product's own boundary rather than a fixture limitation, and the
 * three cases below it DO run on Windows: the log-open refusal, the
 * `restartCommand` arithmetic, and the helper-that-could-not-start log, which
 * on Windows is not even hypothetical. */
const posixHandoff = it.skipIf(process.platform === 'win32')

async function until(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('condition not met in time')
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}

/** A pid that is already dead when the helper's first poll runs. The current
 * node rather than `sh`: this is used by a case that DOES run on Windows,
 * where a `spawn('sh', …)` resolves to a spawn failure whose pid is
 * `undefined` — the case then passed while asserting nothing about a dead
 * pid. */
async function deadPid(): Promise<number> {
  const gone = spawn(process.execPath, ['-e', ''])
  await new Promise(resolve => gone.on('exit', resolve))
  return gone.pid!
}

describe('startRestart', () => {
  posixHandoff('execs the dsh command verbatim once the parent pid is gone, logging its output', async () => {
    const dir = mkdtempSync(join(TEMP_ROOT, 'dsh-restart-case-'))
    const marker = join(dir, 'calls.log')
    const logFile = join(dir, 'restart.log')
    startRestart({
      command: fixtureDsh(marker),
      args: ['web', '--no-open'],
      parentPid: await deadPid(),
      logFile,
    })
    await until(() => existsSync(marker), 5000)
    expect(readFileSync(marker, 'utf8')).toContain('web --no-open')
    // The child's output lands in the log file — the failed-boot diagnosis.
    await until(() => existsSync(logFile) && readFileSync(logFile, 'utf8').includes('dsh web:'), 5000)
    rmSync(dir, { recursive: true, force: true })
  })

  posixHandoff('holds the child back while the parent pid is alive', async () => {
    const dir = mkdtempSync(join(TEMP_ROOT, 'dsh-restart-case-'))
    const marker = join(dir, 'calls.log')
    const sleeper = spawn('sh', ['-c', 'exec sleep 10'])
    startRestart({
      command: fixtureDsh(marker),
      args: ['web'],
      parentPid: sleeper.pid!,
      logFile: join(dir, 'restart.log'),
    })
    await new Promise(resolve => setTimeout(resolve, 1000))
    expect(existsSync(marker)).toBe(false)
    sleeper.kill()
    await until(() => existsSync(marker), 5000)
    rmSync(dir, { recursive: true, force: true })
  })

  it('throws when the log file cannot be opened, before committing', () => {
    expect(() => startRestart({
      command: fixtureDsh(join(tmpdir(), 'unused.log')),
      args: ['web'],
      parentPid: 1,
      logFile: join(tmpdir(), 'no-such-dir', 'restart.log'),
    })).toThrow()
  })
})

describe('restartCommand', () => {
  it('re-runs this process by its own entry, not a name on PATH', () => {
    expect(restartCommand({
      dshBin: 'dsh',
      argv: ['web', '--no-open'],
      execPath: '/usr/bin/node',
      execArgv: ['--enable-source-maps'],
      script: '/opt/dsh/lib/bin.js',
    })).toEqual({
      command: '/usr/bin/node',
      args: ['--enable-source-maps', '/opt/dsh/lib/bin.js', 'web', '--no-open'],
    })
  })

  it('honours an explicit dshBin as given', () => {
    expect(restartCommand({
      dshBin: '/tmp/fixture/dsh',
      argv: ['web'],
      execPath: '/usr/bin/node',
      execArgv: [],
      script: '/opt/dsh/lib/bin.js',
    })).toEqual({ command: '/tmp/fixture/dsh', args: ['web'] })
  })

  it('falls back to the bare name when this process has no script path', () => {
    expect(restartCommand({
      dshBin: 'dsh', argv: ['web'], execPath: '/usr/bin/node', execArgv: [], script: undefined,
    })).toEqual({ command: 'dsh', args: ['web'] })
  })
})

describe('restart helper startup failure', () => {
  it('records a helper that could not start, instead of raising an uncaught event', async () => {
    // An empty PATH makes the helper's `sh` lookup fail asynchronously. The
    // failure must be diagnosable in the handoff log after this function has
    // already returned to its caller.
    const dir = mkdtempSync(join(TEMP_ROOT, 'dsh-restart-nopath-'))
    const logFile = join(dir, 'restart.log')
    startRestart({
      command: 'dsh',
      args: ['web'],
      parentPid: await deadPid(),
      logFile,
      env: { PATH: '' },
    })
    await until(() => existsSync(logFile) && readFileSync(logFile, 'utf8').includes('the restart helper could not start'), 5000)
    rmSync(dir, { recursive: true, force: true })
  })
})
