/** Plugin-command executor: spawn the dsh CLI, stream its output, serialize
 * per profile. One implementation drives both `dsh plugin add` (install) and
 * `dsh plugin remove` (uninstall); the only differences are the verb and the
 * post-exit manifest confirmation. */

import { spawn, spawnSync, type ChildProcessByStdio } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import { readProfileManifest, resolveProfileDir } from '@deepseek-ai/dsh-app-boot'
import { dshCommand, resolveDshScript, DSH_PACKAGE, type DshCliFs } from './dsh-cli.ts'
import type { HotRestartReason } from './hot.ts'

export type InstallState = 'running' | 'done' | 'failed'

export interface InstallStatus {
  state: InstallState
  log: string[]
  needsRestart?: boolean
  restartReason?: HotRestartReason
  detail?: string
}

const MAX_LOG_LINES = 200
const MAX_LOG_BYTES = 64 * 1024

/** Bound one dsh command so a stalled install cannot hold the profile queue
 * forever. Tests can pass a shorter value; production stays generous. */
const INSTALL_TIMEOUT_MS = Number(process.env.DSH_SHOP_INSTALL_TIMEOUT_MS) || 15 * 60 * 1000

/** Grace period for output already buffered after the child exits. */
const PIPE_DRAIN_MS = 500

interface RunningInstall {
  installId: string
  status: () => InstallStatus
  finished: Promise<InstallStatus>
}

// One in-flight command per profile (§7.2: pnpm locks itself, but its
// concurrent-access errors are unreadable to a user).
const profileQueues = new Map<string, Promise<unknown>>()

function chain<T>(profile: string, task: () => Promise<T>): Promise<T> {
  const previous = profileQueues.get(profile) ?? Promise.resolve()
  const next = previous.then(task, task)
  profileQueues.set(profile, next.catch(() => {}))
  return next
}

/** The §7.2 step-6 confirm: after a zero exit, re-read the profile manifest and
 * verify the bundle actually landed in `dsh.profile.bundles`. Exit 0 alone is
 * not success — a library-that-looked-like-a-plugin, or a stale catalog,
 * exits 0 while changing nothing (§10). The shop cannot force a client
 * refresh in P1, so the detail carries the signal. A manifest that cannot be
 * read or parsed is the same outcome, naming the file: the install's result
 * is then unknown, and a bare `done` would be plausible-but-wrong. `home` is
 * the DSH_HOME the child was spawned with — the parent's own DSH_HOME may
 * differ when `env` pinned it.
 */
function confirmBundleActivation(profile: string, home: string | undefined, expectedName: string): string | null {
  const profileDir = resolveProfileDir(profile, home)
  try {
    const manifest = readProfileManifest('dsh-plugin-shop', profileDir)
    if (manifest.dsh?.profile?.bundles?.includes(expectedName)) return null
    return 'installed but dsh.profile.bundles did not change — the catalog may be stale; refresh it'
  } catch {
    return `installed but the profile manifest could not be read (${join(profileDir, 'package.json')}) — the catalog may be stale; refresh it`
  }
}

/** The uninstall mirror of §7.2 step 6: after a zero exit, re-read the profile
 * manifest and verify the bundle actually left `dsh.profile.bundles`. A zero
 * exit that changed nothing must not read as success. */
function confirmBundleRemoval(profile: string, home: string | undefined, expectedName: string): string | null {
  const profileDir = resolveProfileDir(profile, home)
  try {
    const manifest = readProfileManifest('dsh-plugin-shop', profileDir)
    if (!manifest.dsh?.profile?.bundles?.includes(expectedName)) return null
    return 'removed but dsh.profile.bundles did not change — re-run the uninstall'
  } catch {
    return `removed but the profile manifest could not be read (${join(profileDir, 'package.json')}) — re-run the uninstall`
  }
}

/** Lines a failed install's log tends to END on, none of which tell the user
 * anything they can act on: dsh's own wrapper around the pnpm exit, node's
 * version footer, pnpm's progress and update banner, and the frames and
 * carets of a stack trace. */
const FAILURE_LOG_NOISE: readonly RegExp[] = [
  /^dsh: pnpm failed in profile directory/,
  /^Node\.js v/,
  /^(?:Progress|Packages):/,
  /^\++$/,
  /^[╭│╰]/,
  /^\^+$/,
  /^\s*$/,
  /^\s+at /,
  /^<anonymous(?:_script)?>/,
]

/**
 * The one log line worth putting in front of the user, plus the recovery hint.
 *
 * The last line is the wrong choice, which is what this replaces. Measured on
 * two real failures against the live catalog (dsh 0.1.1-rc.2, 2026-09-02),
 * the last line was `dsh: pnpm failed in profile directory <a path the user
 * did not choose>` and `Node.js v26.6.0` — while the line that explained the
 * failure sat a few lines above, in the log the client already receives. A
 * user seeing either of those cannot tell a blocked build script from a
 * crash, which is exactly the report this fixes.
 *
 * Scanning from the end: a pnpm error code first, then any thrown error, then
 * the last line that is not noise.
 */
export function installFailureDetail(profile: string, log: readonly string[]): string {
  const hint = `pnpm failed in the profile. Run: dsh plugin --profile ${profile} install`
  // Strip a trailing carriage return before filtering. The capture loop
  // normalizes now, so this is belt and braces — but every pattern in
  // FAILURE_LOG_NOISE anchors with `$`, which without /m matches only at end
  // of string, so a single `\r` silently disables the filter each was
  // written for and publishes punctuation as the reason an install failed.
  const usable = log
    .map(line => line.replace(/\r+$/, ''))
    .filter(line => !FAILURE_LOG_NOISE.some(rx => rx.test(line)))
  const reversed = [...usable].reverse()
  const pick = reversed.find(line => /ERR_[A-Z][A-Z_]*/.test(line))
    ?? reversed.find(line => /(?:^|\s)\w*Error:/.test(line))
    ?? usable[usable.length - 1]
  if (pick === undefined) return `${hint}.`
  // pnpm blocks build scripts by default and the shop never passes
  // `allowBuilds` — that stays the user's explicit decision in the CLI
  // (§7.2). So the detail names the approval step rather than a flag we
  // could have passed for them. The registry's `requires-build` gate reads
  // only a repo's OWN manifest, so a TRANSITIVE build script reaches the
  // install; the 2026-08-30 design's spot-check saw this and left it open.
  const approve = /ERR_PNPM_IGNORED_BUILDS/.test(pick)
    ? ' A dependency wants to run a build script, which pnpm blocks by default:'
      + ' run `pnpm approve-builds` in the profile directory to allow it, then retry.'
    : ''
  return `${hint} — ${pick}${approve}`
}

/**
 * Why a spawn of the dsh CLI never started.
 *
 * On Windows a bare name and a shim path fail differently and neither means
 * what the POSIX advice says. npm installs the CLI as `dsh`, `dsh.cmd` and
 * `dsh.ps1` with no `.exe`; libuv resolves a bare name against `.com` and
 * `.exe` only (ENOENT), and node has refused to spawn a `.cmd` without a
 * shell since the 2024 batfile argument-injection fix (EINVAL). `dsh-cli.ts`
 * gets past that by running the CLI's own JS entry through node, so reaching
 * here on Windows means that entry could not be located — telling the user to
 * install a dsh they already have would still be wrong. Reported from Windows
 * 2026-09-02 as "Update failed / dsh not found on PATH" on a working install.
 */
export function spawnFailureDetail(
  code: string | undefined,
  message: string,
  dshBin: string,
  platform: NodeJS.Platform,
): string {
  if (platform === 'win32' && (code === 'ENOENT' || code === 'EINVAL')) {
    return `the shop could not locate the dsh CLI to run (${dshBin}): on Windows npm installs it`
      + ' as a .cmd shim, which cannot be spawned directly, so the shop runs the'
      + ` ${DSH_PACKAGE} package's own entry through node instead — and that entry was not found.`
      + ' Check that `dsh --version` works in a terminal, then reinstall the CLI if it does not.'
  }
  if (code === 'ENOENT') return 'dsh not found on PATH — install the dsh CLI to manage profile plugins'
  return `dsh spawn failed: ${message}`
}

/** The failure detail for a command stopped by the shop's deadline. */
export function installTimeoutDetail(profile: string, timeoutMs: number): string {
  const seconds = Math.max(1, Math.round(timeoutMs / 1000))
  return `dsh-plugin-shop: the command did not finish within ${seconds}s and was stopped.`
    + ` Run it yourself to see what it is waiting on: dsh plugin --profile ${profile} install`
}

/** Kill primitives injected by tests so both platform branches are testable. */
export interface KillFns {
  killGroup: (pid: number) => void
  killPid: (pid: number) => void
  taskkill: (pid: number) => void
}

const nodeKills: KillFns = {
  killGroup: pid => process.kill(-pid, 'SIGKILL'),
  killPid: pid => process.kill(pid, 'SIGKILL'),
  taskkill: pid => { spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }) },
}

/** Kill a child and its descendants (process group on POSIX, taskkill tree on Windows). */
export function killTree(pid: number | undefined, platform: NodeJS.Platform, kills: KillFns = nodeKills): void {
  if (pid === undefined) return
  if (platform === 'win32') {
    kills.taskkill(pid)
    return
  }
  try {
    kills.killGroup(pid)
  } catch {
    try {
      kills.killPid(pid)
    } catch {
      // The process already exited or cannot be signalled; the timeout result stands.
    }
  }
}

/** Read-only filesystem seam for the CLI lookup; the same shape as `pinFs`. */
const nodeFs: DshCliFs = {
  exists: path => existsSync(path),
  read: path => readFileSync(path, 'utf8'),
}

let cachedScript: string | null | undefined

/** The dsh CLI's JS entry, resolved once per process and only where it is
 * needed. On POSIX `spawn('dsh')` works and the lookup is skipped entirely,
 * so no platform but Windows pays for it. */
function dshScript(): string | null {
  if (process.platform !== 'win32') return null
  if (cachedScript === undefined) {
    cachedScript = resolveDshScript(nodeFs, { argv1: process.argv[1], path: process.env.PATH })
  }
  return cachedScript
}

/** Shell punctuation that must never reach the downstream CLI as an operand.
 * The downstream dsh invokes pnpm with shell mode on Windows, where these
 * characters alter the command line. `&` is intentionally allowed here: the
 * legitimate monorepo spec uses it as `&path:<subdir>`, and catalog.ts
 * validates each component before it reaches this layer. */
const UNSAFE_TARGET = /[\s"'`|<>^$();\\{}]|[\u0000-\u001f\u007f]/

/** Run one `dsh plugin --profile <profile> <verb> <target>` and track it.
 * Never rolls back; a failure surfaces stderr verbatim plus the recovery hint
 * (§10). The shop never passes build-script flags: `allowBuilds` stays the
 * user's explicit decision in the CLI (§7.2).
 * The child inherits the current environment unless `env` is given — the
 * real-install test pins DSH_HOME to a temporary directory this way.
 * When `confirm` is given, a zero exit is checked against the profile
 * manifest before the command reports `done` (§7.2 step 6 and its uninstall
 * mirror). When `afterDone` is given, a zero exit that passes `confirm`
 * withholds the terminal `done` until the callback — typically the hot-mount
 * attempt — settles; its result sets `needsRestart` (default `true`) and
 * `restartReason`. The client stops polling at `done`, so the hot outcome
 * must settle before it. A throwing callback never fails the install — the
 * package IS installed; it reports `done` with the restart fallback. */
function spawnPluginCli(options: {
  profile: string
  argv: string[]
  dshBin: string
  env?: NodeJS.ProcessEnv
  confirm?: (home: string | undefined) => string | null
  afterDone?: (home: string | undefined) => Promise<{ needsRestart: boolean; restartReason?: HotRestartReason } | void>
  onStatus?: (status: InstallStatus) => void
  timeoutMs?: number
}): RunningInstall {
  const { profile, argv, dshBin, env, confirm, afterDone, onStatus, timeoutMs = INSTALL_TIMEOUT_MS } = options
  // Argv smuggling guard: an operand that begins with `-` would be parsed as
  // a flag by the CLI. A legitimate target — a catalog name for remove, a
  // `name@version` spec for add — never begins with `-`, so refusing here
  // cannot reject a real install or uninstall. Failing loudly beats letting
  // the CLI reinterpret an operand as an option.
  const target = argv[1]
  if (target === undefined || target.startsWith('-')) {
    throw new Error(`dsh-plugin-shop: refusing to spawn with a flag-like operand: ${target ?? '(none)'}`)
  }
  if (UNSAFE_TARGET.test(target)) {
    throw new Error(`dsh-plugin-shop: refusing to spawn with an unsafe operand: ${JSON.stringify(target)}`)
  }
  const installId = randomUUID()
  const log: string[] = []
  let logBytes = 0
  let state: InstallState = 'running'
  let needsRestartOnDone = true
  let restartReason: HotRestartReason | undefined
  let detail: string | undefined

  const status = (): InstallStatus => ({
    state,
    log: [...log],
    ...(state === 'done' ? { needsRestart: needsRestartOnDone, ...(restartReason !== undefined ? { restartReason } : {}) } : {}),
    ...(detail !== undefined ? { detail } : {}),
  })

  // Chunks are split into lines; a trailing partial line (a chunk that does
  // not end in \n) is appended as-is — the next chunk usually completes it
  // and the log renders plain text, so a fragment is acceptable at v0.
  const append = (line: string): void => {
    if (state !== 'running') return
    log.push(line)
    logBytes += Buffer.byteLength(line)
    // Drop oldest until both caps hold; the newest line is never dropped,
    // even when a single pathological line alone exceeds the byte cap.
    while ((log.length > MAX_LOG_LINES || logBytes > MAX_LOG_BYTES) && log.length > 1) {
      const oldest = log.shift()
      if (oldest !== undefined) logBytes -= Buffer.byteLength(oldest)
    }
    onStatus?.(status())
  }

  const failToStart = (error: NodeJS.ErrnoException): InstallStatus => {
    state = 'failed'
    detail = spawnFailureDetail(error.code, error.message, dshBin, process.platform)
    onStatus?.(status())
    return status()
  }

  const finished = chain(profile, () => new Promise<InstallStatus>((resolve) => {
    const { command, args } = dshCommand({
      dshBin,
      args: ['plugin', '--profile', profile, ...argv],
      platform: process.platform,
      execPath: process.execPath,
      script: dshScript(),
    })
    let child: ChildProcessByStdio<null, Readable, Readable>
    try {
      child = spawn(command, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: env ?? process.env,
        detached: process.platform !== 'win32',
      })
    } catch (error) {
      resolve(failToStart(error as NodeJS.ErrnoException))
      return
    }

    let exited = false
    let closed = false
    let exitCode: number | null = null
    let timedOut = false
    let drainTimer: ReturnType<typeof setTimeout> | undefined
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined

    const settle = async (): Promise<void> => {
      if (state !== 'running') return
      clearTimeout(drainTimer)
      clearTimeout(deadlineTimer)
      child.stdout.destroy()
      child.stderr.destroy()
      if (timedOut) {
        state = 'failed'
        detail = installTimeoutDetail(profile, timeoutMs)
      } else if (exitCode === 0) {
        const confirmDetail = confirm?.(env?.DSH_HOME)
        if (confirmDetail != null) {
          state = 'failed'
          detail = confirmDetail
        } else if (afterDone !== undefined) {
          try {
            const outcome = await afterDone(env?.DSH_HOME)
            needsRestartOnDone = outcome?.needsRestart ?? true
            restartReason = outcome?.restartReason
          } catch {
            needsRestartOnDone = true
            restartReason = 'mount-failed'
          }
          state = 'done'
        } else {
          state = 'done'
        }
      } else {
        state = 'failed'
        detail = installFailureDetail(profile, log)
      }
      onStatus?.(status())
      resolve(status())
    }

    const drainThenSettle = (): void => {
      clearTimeout(drainTimer)
      drainTimer = setTimeout(() => { void settle() }, PIPE_DRAIN_MS)
    }

    // Split on CRLF as well as LF. Every console producer on Windows —
    // pnpm, node, dsh's own wrapper — terminates with `\r\n`.
    child.stdout.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().split(/\r?\n/)) if (line !== '') append(line)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().split(/\r?\n/)) if (line !== '') append(line)
    })
    child.on('error', (error) => {
      if (state !== 'running') return
      clearTimeout(drainTimer)
      clearTimeout(deadlineTimer)
      resolve(failToStart(error as NodeJS.ErrnoException))
    })
    // `exit` is the child's completion. `close` waits for every holder of the
    // inherited pipes, so the record settles after a bounded drain instead.
    child.on('exit', (code) => {
      exited = true
      exitCode = code
      if (closed) void settle()
      else drainThenSettle()
    })
    child.on('close', () => {
      closed = true
      if (exited) void settle()
    })
    deadlineTimer = setTimeout(() => {
      if (state !== 'running') return
      timedOut = true
      killTree(child.pid, process.platform)
      drainThenSettle()
    }, timeoutMs)
  }))

  return { installId, status, finished }
}

/**
 * Run one `dsh plugin --profile <profile> add <spec>` and track it.
 * When `expectedName` is given, a zero exit is confirmed against the profile
 * manifest (§7.2 step 6) before the install reports `done`. When `afterDone`
 * is given, the terminal `done` waits for it to settle (§D hot mount).
 */
export function startInstall(options: {
  profile: string
  spec: string
  dshBin?: string
  env?: NodeJS.ProcessEnv
  expectedName?: string
  afterDone?: (home: string | undefined) => Promise<{ needsRestart: boolean; restartReason?: HotRestartReason } | void>
  onStatus?: (status: InstallStatus) => void
  timeoutMs?: number
}): RunningInstall {
  const { profile, spec, dshBin = 'dsh', env, expectedName, afterDone, onStatus, timeoutMs } = options
  return spawnPluginCli({
    profile,
    argv: ['add', spec],
    dshBin,
    env,
    confirm: expectedName !== undefined ? home => confirmBundleActivation(profile, home, expectedName) : undefined,
    afterDone,
    onStatus,
    timeoutMs,
  })
}

/**
 * Run one `dsh plugin --profile <profile> remove <name>` and track it.
 * When `expectedName` is given, a zero exit is confirmed against the profile
 * manifest — the bundle must actually have LEFT `dsh.profile.bundles` — before
 * the uninstall reports `done`. When `afterDone` is given, the terminal `done`
 * waits for it to settle (§D hot mount).
 */
export function startUninstall(options: {
  profile: string
  name: string
  dshBin?: string
  env?: NodeJS.ProcessEnv
  expectedName?: string
  afterDone?: (home: string | undefined) => Promise<{ needsRestart: boolean; restartReason?: HotRestartReason } | void>
  onStatus?: (status: InstallStatus) => void
  timeoutMs?: number
}): RunningInstall {
  const { profile, name, dshBin = 'dsh', env, expectedName, afterDone, onStatus, timeoutMs } = options
  return spawnPluginCli({
    profile,
    argv: ['remove', name],
    dshBin,
    env,
    confirm: expectedName !== undefined ? home => confirmBundleRemoval(profile, home, expectedName) : undefined,
    afterDone,
    onStatus,
    timeoutMs,
  })
}
