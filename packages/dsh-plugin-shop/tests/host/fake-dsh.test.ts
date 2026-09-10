import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { fakeDsh } from '../fixtures/fake-dsh.ts'

const TEMP_ROOT = mkdtempSync(join(tmpdir(), 'fake-dsh-fixture-'))
afterAll(() => { rmSync(TEMP_ROOT, { recursive: true, force: true }) })

/**
 * Far past what a pipe plus the parent's own read buffer can hold, so the
 * child's writes MUST queue.
 *
 * The first version of this test used ten thousand lines (~88 KB), sized
 * against a 64 KiB pipe alone. That was wrong: the parent buffers about
 * another 64 KiB before it stops reading, so most of that volume fits in the
 * combined space and never queues at all — measured, an UNFIXED fixture still
 * delivered 6,637 of 10,000. At 200,000 lines (~2.4 MB) the same fixture
 * delivers 6,836, and a fixed one delivers every line. That gap is the
 * instrument; 10,000 lines did not have one.
 */
const LINES = 200_000

interface Delivered {
  readonly lines: number
  /** The child's own stderr, so a CRASH is never mistaken for a truncation. */
  readonly stderr: string
}

/**
 * Spawn `bin` and count the lines that actually arrive, with the pipe held
 * shut until `drainAfterMs`.
 *
 * The delay is the instrument. `process.stdout.write` to a pipe is
 * ASYNCHRONOUS in node, and `process.exit()` does not flush what is still
 * queued — documented, and the reason this file exists. While a reader keeps
 * the pipe empty each write completes inside `uv_write`'s first `write(2)` and
 * nothing is ever queued, which is why the defect is invisible on an idle
 * machine and why it surfaced as a load-dependent flake instead: under a full
 * parallel suite the reader is starved, the pipe backs up, and the writes that
 * queued are dropped at exit. Refusing to read reproduces that starvation on
 * purpose rather than hoping to lose the race.
 */
function spawnAndCount(bin: string, drainAfterMs: number): Promise<Delivered> {
  return new Promise((resolve) => {
    // stderr is CAPTURED, not ignored. A child that dies before writing
    // anything and a child whose writes were dropped both deliver zero lines,
    // and only its stderr tells them apart — the first version of this helper
    // discarded it and turned a crash into a number that looked exactly like
    // the defect under test.
    const child = spawn(process.execPath, [bin], { stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks: string[] = []
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => { stderr += chunk })
    child.stdout.setEncoding('utf8')
    // The consumer is registered BEFORE the pause, and this ordering is the
    // whole difference between measuring the fixture and measuring ourselves.
    //
    // Node resumes a child's stdio streams when the child exits. On a paused
    // stream that nobody is listening to, that resume DISCARDS everything
    // buffered — measured: `end` fires on the exact millisecond of the child's
    // exit and delivers 0 of 10,000 lines, while the identical child observed
    // through the ordering below delivers all 10,000. So the earlier spelling
    // (pause now, listen after the timer) reported total loss for every child
    // that outran its own drain timer, whether or not the fixture was fixed —
    // an assertion that cannot fail differently for the two things it is meant
    // to tell apart. With a listener attached, `pause()` means "buffer this"
    // instead of "throw it away", and the count is the child's alone.
    child.stdout.on('data', (chunk: string) => chunks.push(chunk))
    child.stdout.pause()
    // Resolve on the stdout stream's own `end`, never on `exit`/`close`. Those
    // two can fire while bytes are still unread, and settling there resolves
    // with a buffer nobody has drained. `end` is the only event that means
    // "this stream is finished AND you have read it".
    child.stdout.on('end', () => {
      resolve({ lines: chunks.join('').split('\n').filter(line => line !== '').length, stderr })
    })
    // Releasing the pipe is what lets a CORRECT fixture finish: it cannot
    // flush 2.4 MB into a pipe nobody is emptying, so it waits here. A broken
    // one has already exited and dropped its queue by now — the pipe fills
    // within the first few milliseconds, so this delay is ~50x longer than the
    // back-pressure needs to build.
    setTimeout(() => { child.stdout.resume() }, drainAfterMs)
  })
}

describe('fakeDsh output survives the fixture\'s own exit', () => {
  it('delivers every line even when the reader drains late', async () => {
    const bin = fakeDsh(mkdtempSync(join(TEMP_ROOT, 'volume-')), [
      `for (let i = 1; i <= ${LINES}; i += 1) out(\`line \${i}\`)`,
      'process.exit(0)',
    ].join('\n'))
    const got = await spawnAndCount(bin, 200)
    expect(got.stderr, 'the child must not have died instead').toBe('')
    expect(got.lines).toBe(LINES)
  }, 30_000)

  it('delivers a direct process.stdout.write the same way', async () => {
    // `out` is not the only spelling a body uses: several fixtures call
    // `process.stdout.write` directly for the unterminated-line cases. Fixing
    // only the helper would leave those exposed, so the seam has to be the
    // stream itself.
    const bin = fakeDsh(mkdtempSync(join(TEMP_ROOT, 'direct-')), [
      `for (let i = 1; i <= ${LINES}; i += 1) process.stdout.write('line ' + i + '\\n')`,
      'process.exit(0)',
    ].join('\n'))
    const got = await spawnAndCount(bin, 200)
    expect(got.stderr, 'the child must not have died instead').toBe('')
    expect(got.lines).toBe(LINES)
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
