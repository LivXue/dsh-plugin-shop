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

import { openSync, closeSync } from 'node:fs'
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
 * process too. Harmless: it only delays the boot. */
export function startRestart(options: {
  dshBin: string
  argv: string[]
  parentPid: number
  logFile: string
  env?: NodeJS.ProcessEnv
}): void {
  const { dshBin, argv, parentPid, logFile, env } = options
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
      dshBin,
      ...argv,
    ], {
      stdio: ['ignore', logFd, logFd],
      env: env ?? process.env,
      detached: true, // its own process group: survives this process's exit
    })
    helper.unref()
  } finally {
    closeSync(logFd)
  }
}
