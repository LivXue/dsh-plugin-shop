/** Plugin-command executor: spawn the dsh CLI, stream its output, serialize
 * per profile. One implementation drives both `dsh plugin add` (install) and
 * `dsh plugin remove` (uninstall); the only differences are the verb and the
 * post-exit manifest confirmation. */

import { spawn, spawnSync, type ChildProcessByStdio } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'
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

/**
 * Why a zero-exit install left `dsh.profile.bundles` without the entry.
 *
 * This reports EVIDENCE, never a cause. "the catalog may be stale; refresh
 * it" used to be the whole message on every branch, and on the failure that
 * prompted the rewrite it was flatly wrong — the catalog had been fetched
 * minutes earlier and was correct. The first attempt at a replacement
 * inferred the opposite cause instead, reading "the entry has a `subdir` and
 * its name is absent" as "the spec's `&path:` was eaten". That predicate does
 * not entail that cause: `install()` builds three spec forms and only one
 * carries `&path:` at all, so a tarball-rescued or npm entry could be told
 * its path had been eaten from a spec that never had one. A guess in the
 * confident direction is still a guess.
 *
 * So: the profile manifest is read before and after, and only the difference
 * is reported.
 *   - the name IS an own dependency, but not a bundle — a fact, stated
 *     without a claim about why dsh did not list it;
 *   - the name is absent and something else was added — name what was added.
 *     That is the culprit, and naming it is what lets a user clean up; the
 *     package that lands here is by construction NOT a catalog entry, so the
 *     shop's own uninstall cannot reach it and a CLI line is the only usable
 *     instruction;
 *   - the name is absent and nothing was added — nothing installed under
 *     this name, and a catalog behind the registry IS a real candidate here.
 *
 * `Object.hasOwn` throughout, never an index read: these records are parsed
 * from the profile manifest and carry Object.prototype, so `deps.constructor`
 * answers with a function for a package that is not installed — and
 * `constructor` is a legal npm name (`[a-z0-9][a-z0-9._-]*`).
 *
 * Pure: every input is a value, so each branch is driven by a fixture.
 */
export function activationFailureDetail(args: {
  expectedName: string
  profile: string
  before: Readonly<Record<string, string>>
  after: Readonly<Record<string, string>>
}): string {
  const { expectedName, profile, before, after } = args
  if (Object.hasOwn(after, expectedName)) {
    return `${expectedName} is a dependency of the profile but is not in dsh.profile.bundles, so dsh`
      + ' did not activate it as a profile layer and the shop has nothing to mount.'
  }
  const added = Object.keys(after).filter(name => !Object.hasOwn(before, name)).sort()
  if (added.length > 0) {
    const names = added.join(', ')
    return `${expectedName} is not in the profile's dependencies — the install added ${names} instead.`
      + ` Remove it with: dsh plugin --profile ${profile} remove ${added[0]}`
  }
  return `${expectedName} is in neither dsh.profile.bundles nor the profile's dependencies, and the`
    + ' install added nothing — if the entry is new the catalog may be behind; refresh it and retry.'
}

/** The §7.2 step-6 confirm: after a zero exit, re-read the profile manifest and
 * verify the bundle actually landed in `dsh.profile.bundles`. Exit 0 alone is
 * not success — a library-that-looked-like-a-plugin, a subpackage entry whose
 * path was eaten, or a stale catalog all exit 0 while changing nothing (§10).
 * The shop cannot force a client refresh in P1, so the detail carries the
 * signal — see `activationFailureDetail` for which signal. A manifest that
 * cannot be read or parsed names the file instead: the install's result is
 * then unknown, and a bare `done` would be plausible-but-wrong. `home` is
 * the DSH_HOME the child was spawned with — the parent's own DSH_HOME may
 * differ when `env` pinned it.
 */
function confirmBundleActivation(
  profile: string,
  home: string | undefined,
  expectedName: string,
  before: Readonly<Record<string, string>>,
): string | null {
  const profileDir = resolveProfileDir(profile, home)
  try {
    const manifest = readProfileManifest('dsh-plugin-shop', profileDir)
    const after = manifest.dependencies ?? {}
    // Two conditions, not one. `bundles.includes` alone reports MEMBERSHIP,
    // and this install has to establish CHANGE: a bundle row left over from a
    // previous install passes a membership check while this attempt put a
    // different package on disk, and the caller then hot-mounts the OLD tree
    // and publishes "running now, no restart needed" over an install that
    // did nothing. Requiring the name to be an own dependency too closes it.
    //
    // `Array.isArray` is load-bearing: `readProfileManifest` validates only
    // that the document is an object, so `"bundles": "dsh-plugin-shop-extras"`
    // is a string whose `.includes('dsh-plugin-shop')` is true.
    const bundles = manifest.dsh?.profile?.bundles
    const listed = Array.isArray(bundles) && bundles.includes(expectedName)
    if (listed && Object.hasOwn(after, expectedName)) return null
    return activationFailureDetail({ expectedName, profile, before, after })
  } catch {
    return `installed but the profile manifest could not be read (${join(profileDir, 'package.json')})`
      + ' — the install\'s result is unknown; check that file.'
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
  // pnpm prints a code line and then a causal chain beneath it: `├─▶` for each
  // intermediate link, `╰─▶` for the innermost reason. Only the code line
  // carries an ERR_, so the picker above always takes it — and on its own it
  // names a failure CLASS and nothing about why. Reported 2026-09-06: a user
  // read `ERR_PNPM_PACKAGE_MANAGER_ADD_RESOLVE_GIT` and could not tell that
  // their network had timed out fetching a 151 MB repository tarball.
  //
  // Only the LAST link is appended. The intermediates restate the same failure
  // at widening scope ("error decoding response body", "request or response
  // body error"), so piling them on would bury the one line that answers the
  // question. Skipped when the picked line already says it, which is what
  // keeps a single-line pnpm failure — the common case — unchanged.
  const cause = reversed
    .map(line => /^\s*╰─▶\s*(\S.*)$/.exec(line)?.[1])
    .find((text): text is string => text !== undefined)
  const because = cause !== undefined && !pick.includes(cause) ? `: ${cause}` : ''
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
  return `${hint} — ${pick}${because}${approve}`
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

/** One stream's line assembler, retaining partial UTF-8 and text lines. */
export interface LineSink {
  write: (chunk: Buffer) => void
  flush: () => void
}

export function lineSink(emit: (line: string) => void): LineSink {
  const decoder = new StringDecoder('utf8')
  let pending = ''
  return {
    write(chunk) {
      pending += decoder.write(chunk)
      const parts = pending.split(/\r?\n/)
      pending = parts.pop() ?? ''
      for (const line of parts) if (line !== '') emit(line)
    },
    flush() {
      pending += decoder.end()
      if (pending !== '') emit(pending)
      pending = ''
    },
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
 * validates each component before it reaches this layer. `"` is NOT allowed,
 * and `shellSafeTarget` below leans on that: the only quote that can appear in
 * the spawned command line is the one we add ourselves, after this gate. */
const UNSAFE_TARGET = /[\s"'`|<>^$();\\{}]|[\u0000-\u001f\u007f]/

/**
 * The operand as the downstream dsh must receive it for pnpm to see it whole.
 *
 * dsh spawns pnpm with `shell: process.platform === 'win32'`
 * (`apps/cli/src/plugin.ts:137` at tag `dsh-v0.1.3-alpha.1`), and Node does
 * not escape under `shell: true` — it concatenates argv into one string for
 * cmd.exe. `&` is a cmd command separator, so a subpackage spec
 * `github:owner/repo#<sha>&path:<subdir>` is cut in half before pnpm sees it:
 * pnpm installs the repository ROOT and the tail runs as its own command. It
 * is silent because `path` happens to be a cmd builtin that succeeds and
 * prints nothing, so the chain still exits 0 and the install reports success
 * over a foreign package.
 *
 * Measured 2026-09-06, Windows 11, dsh 0.1.2-rc.1, pnpm 11.25.0, against
 * `nexu-io/open-design#c5ae629&path:packages/dsh-runtime`:
 *
 *   bare    -> `+ open-design github:nexu-io/open-design#c5ae629` (the ROOT), exit 0
 *   `^&`    -> the ROOT again; cmd consumes the caret before it re-parses
 *   `"..."` -> `+ @open-design/dsh-runtime ...&path:packages/dsh-runtime`, exit 0,
 *              and the name lands in dsh.profile.bundles
 *
 * So the quotes go on. Two constraints on doing it here:
 *
 *  - AFTER the `UNSAFE_TARGET` gate, never before. That gate refuses `"` in
 *    the operand, so every quote in the spawned command line is provably ours
 *    and catalog data cannot close one and append a command of its own.
 *  - Windows only, and only when the spec actually contains `&`. Off Windows
 *    dsh spawns pnpm with no shell, where a quote would be a literal character
 *    in the spec and would break an install that works today. Scoping to `&`
 *    holds the blast radius to exactly the specs that are broken now — and if
 *    dsh stops shelling its argv, those specs fail loudly at pnpm rather than
 *    silently installing a repository root. Reported upstream as
 *    deepseek-ai/deepseek-harness discussion #5815.
 */
export function shellSafeTarget(target: string, platform: NodeJS.Platform): string {
  if (platform !== 'win32' || !target.includes('&')) return target
  return `"${target}"`
}

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
  /** Injected so the win32 branches are reachable from a test on any host —
   * this file's own convention (`spawnFailureDetail`, `killTree`). Reading
   * `process.platform` inline is what left `shellSafeTarget`'s Windows arm
   * unexercisable on an ubuntu CI. */
  platform?: NodeJS.Platform
  /** Run inside the chained task immediately before the spawn, with the same
   * DSH_HOME the child gets — the confirm compares against what this saw. */
  beforeSpawn?: (home: string | undefined) => void
  confirm?: (home: string | undefined) => string | null
  afterDone?: (home: string | undefined) => Promise<{ needsRestart: boolean; restartReason?: HotRestartReason } | void>
  onStatus?: (status: InstallStatus) => void
  timeoutMs?: number
}): RunningInstall {
  const {
    profile, argv, dshBin, env, platform = process.platform,
    beforeSpawn, confirm, afterDone, onStatus, timeoutMs = INSTALL_TIMEOUT_MS,
  } = options
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
  // Only now, once the operand has passed the gate above, is it quoted for
  // the shell dsh puts it through on Windows. See `shellSafeTarget`.
  const spawnArgv = [...argv]
  spawnArgv[1] = shellSafeTarget(target, platform)
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

  // lineSink holds a trailing partial until the next chunk completes it, then
  // flushes it at settle if the stream ended without a newline.
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
    detail = spawnFailureDetail(error.code, error.message, dshBin, platform)
    onStatus?.(status())
    return status()
  }

  const finished = chain(profile, () => new Promise<InstallStatus>((resolve) => {
    beforeSpawn?.(env?.DSH_HOME)
    const { command, args } = dshCommand({
      dshBin,
      args: ['plugin', '--profile', profile, ...spawnArgv],
      platform,
      execPath: process.execPath,
      script: dshScript(),
    })
    let child: ChildProcessByStdio<null, Readable, Readable>
    try {
      child = spawn(command, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        // Deliberate F-12 residual: dsh inherits the environment it needs for
        // PATH, HOME, proxies, and npm/pnpm configuration. Callers may pass a
        // narrower env explicitly; guessing an allowlist here would break
        // valid installs and process.env carries no variable provenance.
        env: env ?? process.env,
        detached: platform !== 'win32',
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

    const outLines = lineSink(append)
    const errLines = lineSink(append)

    const settle = async (): Promise<void> => {
      if (state !== 'running') return
      clearTimeout(drainTimer)
      clearTimeout(deadlineTimer)
      outLines.flush()
      errLines.flush()
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
    child.stdout.on('data', (chunk: Buffer) => { outLines.write(chunk) })
    child.stderr.on('data', (chunk: Buffer) => { errLines.write(chunk) })
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
      killTree(child.pid, platform)
      drainThenSettle()
    }, timeoutMs)
  }))

  return { installId, status, finished }
}

/**
 * Run one `dsh plugin --profile <profile> add <spec>` and track it.
 * When `expectedName` is given, a zero exit is confirmed against the profile
 * manifest (§7.2 step 6) before the install reports `done`.
 * The confirm compares the profile's dependencies before and after the spawn,
 * so a miss can name what actually landed instead of guessing at a cause; the
 * executor takes both snapshots itself.
 * When `afterDone` is given, the terminal `done` waits for it to settle
 * (§D hot mount).
 */
export function startInstall(options: {
  profile: string
  spec: string
  dshBin?: string
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  expectedName?: string
  afterDone?: (home: string | undefined) => Promise<{ needsRestart: boolean; restartReason?: HotRestartReason } | void>
  onStatus?: (status: InstallStatus) => void
  timeoutMs?: number
}): RunningInstall {
  const {
    profile, spec, dshBin = 'dsh', env, platform, expectedName,
    afterDone, onStatus, timeoutMs,
  } = options
  // The `before` snapshot is taken by the executor, not by the caller, and
  // through the SAME resolution the confirm uses. A caller-supplied map would
  // couple the diff to the caller's idea of where the profile lives — and if
  // that ever diverged from `resolveProfileDir`, `before` and `after` would
  // come from two different files and the difference would be noise. It is
  // read inside the chained task, immediately before the spawn, so a command
  // waiting behind another install in the same profile still sees the state
  // the one ahead of it left.
  let before: Readonly<Record<string, string>> = {}
  return spawnPluginCli({
    profile,
    argv: ['add', spec],
    dshBin,
    env,
    platform,
    beforeSpawn: expectedName !== undefined
      ? (home) => { before = readProfileDependencies(profile, home) }
      : undefined,
    confirm: expectedName !== undefined
      ? home => confirmBundleActivation(profile, home, expectedName, before)
      : undefined,
    afterDone,
    onStatus,
    timeoutMs,
  })
}

/** The profile's declared dependencies, or `{}` when the manifest is absent
 * or unreadable. A missing manifest is the profile-not-initialized case —
 * `dsh plugin` creates it — and an unreadable one is reported by the confirm,
 * which names the file; neither is worth failing the spawn over. */
function readProfileDependencies(profile: string, home: string | undefined): Readonly<Record<string, string>> {
  try {
    return readProfileManifest('dsh-plugin-shop', resolveProfileDir(profile, home)).dependencies ?? {}
  } catch {
    return {}
  }
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
