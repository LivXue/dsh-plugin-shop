/** Plugin-command executor: spawn the dsh CLI, stream its output, serialize
 * per profile. One implementation drives both `dsh plugin add` (install) and
 * `dsh plugin remove` (uninstall); the only differences are the verb and the
 * post-exit manifest confirmation. */

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { readProfileManifest, resolveProfileDir } from '@deepseek-ai/dsh-app-boot'
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
  const usable = log.filter(line => !FAILURE_LOG_NOISE.some(rx => rx.test(line)))
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
 * On Windows this is the shop's own gap, not the user's setup, and saying
 * otherwise sends them to reinstall something that already works. npm
 * installs a CLI there as `dsh.cmd` and `dsh.ps1` shims with no `.exe`
 * alongside them, while `spawn` without a shell goes to CreateProcess, which
 * resolves a bare name against `.exe` only — and node has refused to spawn a
 * `.cmd` without a shell since the 2024 batfile argument-injection fix, so a
 * resolved absolute path to the shim fails too (EINVAL rather than ENOENT).
 * There is no configuration that gets past this: `dshBin` can name the shim
 * and the spawn still cannot run it. Reported from Windows 2026-09-02 as
 * "Update failed / dsh not found on PATH" on a working install.
 *
 * `restart.ts` has the same gap one step further on — it runs a POSIX one
 * liner through `sh` with `kill -0` and `sleep` — so a fixed spawn would
 * reach a second Unix-only path. Neither is fixed here; this function only
 * stops the report being wrong about the cause.
 */
export function spawnFailureDetail(
  code: string | undefined,
  message: string,
  dshBin: string,
  platform: NodeJS.Platform,
): string {
  if (platform === 'win32' && (code === 'ENOENT' || code === 'EINVAL')) {
    return `the shop cannot start the dsh CLI on Windows yet (${dshBin}): npm installs it`
      + ' as a .cmd shim, which node cannot spawn without a shell. Not a problem with your'
      + ' install — run the update from `dsh plugin --profile <name> add dsh-plugin-shop@<version>`'
      + ' in a terminal until the shop can do it for you.'
  }
  if (code === 'ENOENT') return 'dsh not found on PATH — install the dsh CLI to manage profile plugins'
  return `dsh spawn failed: ${message}`
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
  confirm?: (home: string | undefined) => string | null
  afterDone?: (home: string | undefined) => Promise<{ needsRestart: boolean; restartReason?: HotRestartReason } | void>
  onStatus?: (status: InstallStatus) => void
}): RunningInstall {
  const { profile, argv, dshBin, env, confirm, afterDone, onStatus } = options
  // Argv smuggling guard: an operand that begins with `-` would be parsed as
  // a flag by the CLI. A legitimate target — a catalog name for remove, a
  // `name@version` spec for add — never begins with `-`, so refusing here
  // cannot reject a real install or uninstall. Failing loudly beats letting
  // the CLI reinterpret an operand as an option.
  const target = argv[1]
  if (target === undefined || target.startsWith('-')) {
    throw new Error(`dsh-plugin-shop: refusing to spawn with a flag-like operand: ${target ?? '(none)'}`)
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

  const finished = chain(profile, () => new Promise<InstallStatus>((resolve) => {
    const child = spawn(dshBin, ['plugin', '--profile', profile, ...argv], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: env ?? process.env,
    })
    child.stdout.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n')) if (line !== '') append(line)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n')) if (line !== '') append(line)
    })
    child.on('error', (error) => {
      state = 'failed'
      detail = spawnFailureDetail(
        (error as NodeJS.ErrnoException).code, error.message, dshBin, process.platform,
      )
      onStatus?.(status())
      resolve(status())
    })
    child.on('close', async (exitCode) => {
      if (state !== 'running') return
      if (exitCode === 0) {
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
            // A failed hot path never fails the install — the package IS
            // installed; it activates on restart instead.
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
    })
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
}): RunningInstall {
  const { profile, spec, dshBin = 'dsh', env, expectedName, afterDone, onStatus } = options
  return spawnPluginCli({
    profile,
    argv: ['add', spec],
    dshBin,
    env,
    confirm: expectedName !== undefined ? home => confirmBundleActivation(profile, home, expectedName) : undefined,
    afterDone,
    onStatus,
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
}): RunningInstall {
  const { profile, name, dshBin = 'dsh', env, expectedName, afterDone, onStatus } = options
  return spawnPluginCli({
    profile,
    argv: ['remove', name],
    dshBin,
    env,
    confirm: expectedName !== undefined ? home => confirmBundleRemoval(profile, home, expectedName) : undefined,
    afterDone,
    onStatus,
  })
}
