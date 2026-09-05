/** Restart executor: hand the port to a new dsh instance, two-phase.
 *
 * The old process cannot wait for the new one: the new one must bind the
 * port the old one still holds, and two live processes cannot bind it at
 * once — the first implementation spawned the child and waited for its URL,
 * and the child crashed in boot with EADDRINUSE every time. The handoff is
 * therefore inverted: the parent commits and exits FIRST, and a detached
 * helper waits for the parent's pid to disappear before exec'ing the same
 * dsh command line. The browser monitors the origin and refreshes once the
 * new server answers; a boot that fails is diagnosed from the log file,
 * since nobody is attached to the child's pipes. */

import { appendFileSync, openSync, closeSync } from 'node:fs'
import { spawn } from 'node:child_process'

/** `shop/restart` result: committed, or a typed refusal issued BEFORE
 * anything is torn down. Once `ok` is returned the old process WILL exit —
 * the client monitors the new server and reports a failed boot with the
 * manual command. */
export type RestartOutcome =
  | { ok: true }
  | { ok: false; detail: string }

/** Spawn the two-phase handoff. The helper is a POSIX shell wrapper that
 * polls the parent pid until it is gone, then replaces itself with the dsh
 * command — `exec "$@"` keeps the argv verbatim, so no argument quoting is
 * involved. The child's stdout/stderr go to `logFile`, opened here in
 * append mode; opening throws on failure, and the caller treats a throw as
 * a refusal (the restart is never committed without its log).
 *
 * The pid-poll has the usual tiny reuse race — if the parent's pid is
 * recycled within the 0.2s polling gap the helper waits for the unrelated
 * process too. Harmless: it only delays the boot.
 *
 * POSIX only: `sh`, `kill -0` and `sleep` are all Unix, and `exec "$@"` has
 * no Windows equivalent. The spawn would fail ASYNCHRONOUSLY, after this
 * function has already returned and the caller has committed — so the gateway
 * refuses on Windows before reaching here rather than exiting into nothing
 * (index.ts `restartPlatformSupported`). */
/**
 * Resolve the command line that re-runs this process.
 *
 * A bare `dsh` from PATH is not necessarily the process serving the current
 * port: a dsh launched through `node`, `npx`, or `pnpm dlx` carries its own
 * script and `execArgv`. Reconstructing that exact node invocation preserves
 * the entry point and runtime flags. An explicitly named binary remains an
 * explicit choice and is passed through unchanged.
 */
export function restartCommand(options: {
  dshBin: string
  argv: readonly string[]
  execPath: string
  execArgv: readonly string[]
  script: string | undefined
}): { command: string; args: string[] } {
  const { dshBin, argv, execPath, execArgv, script } = options
  if (dshBin === 'dsh' && script !== undefined) {
    return { command: execPath, args: [...execArgv, script, ...argv] }
  }
  return { command: dshBin, args: [...argv] }
}

export function startRestart(options: {
  /** The already-resolved command — see `restartCommand`. */
  command: string
  args: readonly string[]
  parentPid: number
  logFile: string
  env?: NodeJS.ProcessEnv
}): void {
  const { command, args, parentPid, logFile, env } = options
  // Opened by the parent: the descriptor is inherited by the helper and the
  // dsh child; the parent's own copy closes right after the spawn.
  const logFd = openSync(logFile, 'a')
  try {
    const helper = spawn('sh', [
      '-c',
      // $1 is the parent pid; once `kill -0` fails the loop ends, the pid
      // is shifted away, and "$@" is the dsh command line verbatim.
      'while kill -0 "$1" 2>/dev/null; do sleep 0.2; done; shift; exec "$@"',
      'sh',
      String(parentPid),
      command,
      ...args,
    ], {
      stdio: ['ignore', logFd, logFd],
      env: env ?? process.env,
      detached: true, // its own process group: survives this process's exit
    })
    helper.on('error', (error) => {
      // Spawn failures arrive asynchronously, after the caller may already
      // have committed the handoff. Without a listener Node rethrows the
      // event as an uncaught exception; retain the diagnosis in the log.
      try {
        appendFileSync(logFile, `dsh-plugin-shop: the restart helper could not start: ${error.message}\n`)
      } catch {
        // The log was writable when opened; if it disappears there is no
        // second reporting channel for this detached helper.
      }
    })
    helper.unref()
  } finally {
    closeSync(logFd)
  }
}
