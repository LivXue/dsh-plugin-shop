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

import { appendFileSync, openSync, closeSync, writeSync } from 'node:fs'
import { spawn, type ChildProcess } from 'node:child_process'

/** `shop/restart` result: committed, or a typed refusal issued BEFORE
 * anything is torn down. Once `ok` is returned the old process WILL exit —
 * the client monitors the new server and reports a failed boot with the
 * manual command and `logFile`, the file the new process's output goes to:
 * where a boot that died explains itself, at a path that depends on DSH_HOME
 * and the shop row's `cacheDir`, which only the host knows. A host older than
 * the field answers without it, so the client reads it as optional.
 *
 * `bootId` and `pid` name the process that committed: its boot identity
 * (own-version.ts) and the pid the takeover waits on. A page reloaded into a
 * process with that same boot is a restart that never happened, and the pid
 * is what the reader has to stop by hand (design §8, 2026-10-06 amendment).
 * Optional for the same older-host reason as `logFile`. */
export type RestartOutcome =
  | { ok: true; logFile?: string; bootId?: string; pid?: number }
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

/** One line of the handoff's own in the log, stamped in UTC ISO 8601 so a
 * reader can line it up against the new process's output and the browser's
 * clock. The helper stamps its line with `date -u` to the same shape, to the
 * second. */
function stamped(text: string): string {
  return `${new Date().toISOString()} dsh-plugin-shop: ${text}\n`
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
    // Written before the helper exists, so it precedes anything the helper or
    // the new dsh writes. With the helper's own line below, it is what tells
    // the two ways a page can end up reloaded into the process it asked to
    // restart apart: a commit with no exit after it is an old process that
    // never went, both and then a boot that died is a new dsh that failed
    // (design §8, 2026-10-06 amendment).
    writeSync(logFd, stamped(`restart committed; the new dsh starts once pid ${parentPid} exits: ${[command, ...args].join(' ')}`))
    let helper: ChildProcess
    try {
      helper = spawn('sh', [
        '-c',
        // $1 is the parent pid; once `kill -0` fails the loop ends, the exit
        // is stamped, the pid is shifted away, and "$@" is the dsh command
        // line verbatim.
        'while kill -0 "$1" 2>/dev/null; do sleep 0.2; done; '
          + 'echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) dsh-plugin-shop: pid $1 exited; starting the new dsh"; '
          + 'shift; exec "$@"',
        'sh',
        String(parentPid),
        command,
        ...args,
      ], {
        stdio: ['ignore', logFd, logFd],
        env: env ?? process.env,
        detached: true, // its own process group: survives this process's exit
      })
    } catch (error) {
      // Thrown rather than deferred: an argument Node refuses, or an errno it
      // does not defer to the 'error' event. The caller refuses the restart,
      // so the log must not end on a commit that started nothing.
      writeSync(logFd, stamped(`the restart helper could not start: ${(error as Error).message}`))
      throw error
    }
    helper.on('error', (error) => {
      // Spawn failures arrive asynchronously, after the caller may already
      // have committed the handoff. Without a listener Node rethrows the
      // event as an uncaught exception; retain the diagnosis in the log.
      try {
        appendFileSync(logFile, stamped(`the restart helper could not start: ${error.message}`))
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
