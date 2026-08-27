import { describe, expect, it } from 'vitest'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startRestart } from '../../src/host/restart.ts'

// A fixture `dsh` that records its argv in a marker file when it finally
// runs — the marker's appearance is the proof the helper waited for the
// parent pid and then exec'd the command.
function fixtureDsh(marker: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-restart-bin-'))
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

async function until(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('condition not met in time')
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}

/** A pid that is already dead when the helper's first poll runs. */
async function deadPid(): Promise<number> {
  const gone = spawn('sh', ['-c', 'exit 0'])
  await new Promise(resolve => gone.on('exit', resolve))
  return gone.pid!
}

describe('startRestart', () => {
  it('execs the dsh command verbatim once the parent pid is gone, logging its output', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-restart-case-'))
    const marker = join(dir, 'calls.log')
    const logFile = join(dir, 'restart.log')
    startRestart({
      dshBin: fixtureDsh(marker),
      argv: ['web', '--no-open'],
      parentPid: await deadPid(),
      logFile,
    })
    await until(() => existsSync(marker), 5000)
    expect(readFileSync(marker, 'utf8')).toContain('web --no-open')
    // The child's output lands in the log file — the failed-boot diagnosis.
    await until(() => existsSync(logFile) && readFileSync(logFile, 'utf8').includes('dsh web:'), 5000)
    rmSync(dir, { recursive: true, force: true })
  })

  it('holds the child back while the parent pid is alive', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-restart-case-'))
    const marker = join(dir, 'calls.log')
    const sleeper = spawn('sh', ['-c', 'exec sleep 10'])
    startRestart({
      dshBin: fixtureDsh(marker),
      argv: ['web'],
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
      dshBin: fixtureDsh(join(tmpdir(), 'unused.log')),
      argv: ['web'],
      parentPid: 1,
      logFile: join(tmpdir(), 'no-such-dir', 'restart.log'),
    })).toThrow()
  })
})
