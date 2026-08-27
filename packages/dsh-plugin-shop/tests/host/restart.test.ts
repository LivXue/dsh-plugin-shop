import { describe, expect, it } from 'vitest'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startRestart } from '../../src/host/restart.ts'

// A fixture `dsh` that behaves like the real CLI's web boot: prints the
// `dsh web: <url>` line the restart parses, then either keeps running
// (sleeps) or exits with the requested code and stderr.
function fixtureDsh(behavior: 'announce-and-stay' | 'exit-1' | 'silent', url = 'http://127.0.0.1:9999'): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-restart-'))
  const bin = join(dir, 'dsh')
  const body = (() => {
    switch (behavior) {
      case 'announce-and-stay':
        return `echo "dsh web: ${url}"; sleep 60`
      case 'exit-1':
        return 'echo "boom: cannot bind" >&2; exit 1'
      case 'silent':
        return 'sleep 60'
    }
  })()
  writeFileSync(bin, `#!/bin/sh\n${body}\n`)
  chmodSync(bin, 0o755)
  return bin
}

describe('startRestart', () => {
  it('resolves the announced URL of the restarted server', async () => {
    const outcome = await startRestart({ dshBin: fixtureDsh('announce-and-stay'), argv: ['web'] })
    expect(outcome).toEqual({ ok: true, url: 'http://127.0.0.1:9999' })
  })

  it('reports a failure with the stderr tail when the child exits during boot', async () => {
    const outcome = await startRestart({ dshBin: fixtureDsh('exit-1'), argv: ['web'] })
    expect(outcome).toEqual({
      ok: false,
      detail: 'the restarted server exited during boot — boom: cannot bind',
    })
  })

  it('times out and reports failure when the child never announces', async () => {
    const outcome = await startRestart({
      dshBin: fixtureDsh('silent'),
      argv: ['web'],
      timeoutMs: 300,
    })
    expect(outcome).toEqual({ ok: false, detail: 'the restarted server did not announce its URL in time' })
  })

  it('reports the CLI hint when dsh is not on PATH', async () => {
    const outcome = await startRestart({ dshBin: join(tmpdir(), 'no-such-dsh-bin'), argv: ['web'] })
    expect(outcome).toEqual({ ok: false, detail: 'dsh not found on PATH — restart could not be launched' })
  })
})
