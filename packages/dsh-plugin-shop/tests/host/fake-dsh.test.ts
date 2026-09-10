import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { fakeDsh } from '../fixtures/fake-dsh.ts'

const TEMP_ROOT = mkdtempSync(join(tmpdir(), 'fake-dsh-fixture-'))
afterAll(() => { rmSync(TEMP_ROOT, { recursive: true, force: true }) })

/**
 * Spawn `bin` and count the lines that actually arrive, with the reader
 * attached LATE.
 *
 * The delay is the whole instrument. `process.stdout.write` to a pipe is
 * ASYNCHRONOUS in node, and `process.exit()` does not flush what is still
 * queued — documented, and the reason this file exists. While a reader keeps
 * the pipe empty each write completes inside `uv_write`'s first `write(2)` and
 * nothing is ever queued, which is why the defect is invisible on an idle
 * machine and why it surfaced as a load-dependent flake instead: under a full
 * parallel suite the reader is starved, the pipe backs up, and the writes that
 * queued are dropped at exit.
 *
 * Draining late reproduces that starvation deterministically rather than
 * hoping to lose a race.
 */
function spawnAndCount(bin: string, drainAfterMs: number): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [bin], { stdio: ['ignore', 'pipe', 'ignore'] })
    const chunks: string[] = []
    child.stdout.setEncoding('utf8')
    child.stdout.pause()
    setTimeout(() => {
      child.stdout.on('data', (chunk: string) => chunks.push(chunk))
      child.stdout.resume()
    }, drainAfterMs)
    let exited = false
    let closed = false
    const settle = (): void => {
      if (exited && closed) resolve(chunks.join('').split('\n').filter(line => line !== '').length)
    }
    child.on('exit', () => { exited = true; settle() })
    child.on('close', () => { closed = true; settle() })
  })
}

describe('fakeDsh output survives the fixture\'s own exit', () => {
  it('delivers every line even when the reader drains late', async () => {
    // Ten thousand lines is past a 64 KiB pipe on purpose: under the buffer
    // nothing has to queue, and the defect cannot be observed at all. Past it,
    // an asynchronous write MUST queue, and `process.exit(0)` MUST drop the
    // queue — measured 6 runs of 6 losing every line before the fix, against
    // 6 of 6 complete after it.
    const bin = fakeDsh(mkdtempSync(join(TEMP_ROOT, 'volume-')), [
      'for (let i = 1; i <= 10000; i += 1) out(`line ${i}`)',
      'process.exit(0)',
    ].join('\n'))
    expect(await spawnAndCount(bin, 200)).toBe(10000)
  }, 30_000)

  it('delivers a direct process.stdout.write the same way', async () => {
    // `out` is not the only spelling a body uses: several fixtures call
    // `process.stdout.write` directly for the unterminated-line cases. Fixing
    // only the helper would leave those exposed, so the seam has to be the
    // stream itself.
    const bin = fakeDsh(mkdtempSync(join(TEMP_ROOT, 'direct-')), [
      "for (let i = 1; i <= 10000; i += 1) process.stdout.write('line ' + i + '\\n')",
      'process.exit(0)',
    ].join('\n'))
    expect(await spawnAndCount(bin, 200)).toBe(10000)
  }, 30_000)

  it('keeps the exit code the body asked for', async () => {
    // The fix must not change what `process.exit(n)` means. Sixteen call sites
    // depend on the code, and several assert a failure path.
    const bin = fakeDsh(mkdtempSync(join(TEMP_ROOT, 'code-')), [
      "out('one')",
      'process.exit(3)',
    ].join('\n'))
    const code = await new Promise<number | null>((resolve) => {
      const child = spawn(process.execPath, [bin], { stdio: ['ignore', 'ignore', 'ignore'] })
      child.on('exit', c => resolve(c))
    })
    expect(code).toBe(3)
  })
})
