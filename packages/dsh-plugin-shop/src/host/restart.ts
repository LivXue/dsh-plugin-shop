/** Restart executor: re-spawn the Host's own command line and hand the
 * browser the new server's URL. The child is detached (its own process
 * group), so it survives both the parent's exit and the launching
 * terminal's. The parent exits only AFTER the child printed its
 * `dsh web: <url>` line — a restart that fails to come up leaves the old
 * process running untouched. */

import { spawn } from 'node:child_process'

/** `shop/restart` outcome: the new server's URL, or a typed failure with an
 * author-readable detail. A failure means the OLD process is still serving —
 * the restart is all-or-nothing. */
export type RestartOutcome =
  | { ok: true; url: string }
  | { ok: false; detail: string }

/** How long to wait for the child to print its URL before declaring the
 * restart failed and killing the child. dsh web prints the URL once the
 * Loader tree settles; 20s is generous on slow machines. */
const RESTART_UP_TIMEOUT_MS = 20_000

/** Spawn the restarted server and wait for it to announce its URL.
 *
 * The child runs the same `dsh` with the same argv the current process was
 * launched with (`process.argv.slice(2)` — node and the CLI script path
 * stripped), so the profile, port and flags reproduce the user's launch
 * verbatim. `--port 0` therefore yields a NEW port, and the returned URL is
 * how the browser finds it.
 *
 * On success the caller exits the old process — but only after delivering
 * the RPC response carrying `url`, which is the caller's sequencing duty,
 * not this module's. On failure (child exits before announcing, spawn
 * error, or the timeout) the child is killed if still running and the old
 * process is untouched. */
export function startRestart(options: {
  dshBin: string
  argv: string[]
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
}): Promise<RestartOutcome> {
  const { dshBin, argv, env, timeoutMs = RESTART_UP_TIMEOUT_MS } = options
  const stderr: string[] = []

  return new Promise<RestartOutcome>((resolve) => {
    const child = spawn(dshBin, argv, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: env ?? process.env,
      detached: true, // its own process group: survives the parent's exit
    })
    child.unref()
    const timeout = setTimeout(() => {
      child.kill()
      resolve({ ok: false, detail: 'the restarted server did not announce its URL in time' })
    }, timeoutMs)

    child.stdout.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n')) {
        if (line === '') continue
        const match = /dsh web: (http:\/\/\S+)/.exec(line)
        if (match?.[1] !== undefined) {
          clearTimeout(timeout)
          resolve({ ok: true, url: match[1] })
        }
      }
    })
    child.stderr.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n')) if (line !== '') stderr.push(line)
    })
    child.on('error', (error) => {
      const code = (error as NodeJS.ErrnoException).code
      clearTimeout(timeout)
      resolve({
        ok: false,
        detail: code === 'ENOENT'
          ? 'dsh not found on PATH — restart could not be launched'
          : `restart spawn failed: ${error.message}`,
      })
    })
    child.on('close', () => {
      // A close before the URL line means the child died during boot: the
      // old process must keep serving. The stderr tail names the reason.
      clearTimeout(timeout)
      resolve({
        ok: false,
        detail: `the restarted server exited during boot — ${stderr[stderr.length - 1] ?? 'no output'}`,
      })
    })
  })
}
