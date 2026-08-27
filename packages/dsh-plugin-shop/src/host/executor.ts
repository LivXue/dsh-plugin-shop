/** Plugin-command executor: spawn the dsh CLI, stream its output, serialize
 * per profile. One implementation drives both `dsh plugin add` (install) and
 * `dsh plugin remove` (uninstall); the only differences are the verb and the
 * post-exit manifest confirmation. */

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { readProfileManifest, resolveProfileDir } from '@deepseek-ai/dsh-app-boot'

export type InstallState = 'running' | 'done' | 'failed'

export interface InstallStatus {
  state: InstallState
  log: string[]
  needsRestart?: boolean
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

/** Run one `dsh plugin --profile <profile> <verb> <target>` and track it.
 * Never rolls back; a failure surfaces stderr verbatim plus the recovery hint
 * (§10). The shop never passes build-script flags: `allowBuilds` stays the
 * user's explicit decision in the CLI (§7.2).
 * The child inherits the current environment unless `env` is given — the
 * real-install test pins DSH_HOME to a temporary directory this way.
 * When `confirm` is given, a zero exit is checked against the profile
 * manifest before the command reports `done` (§7.2 step 6 and its uninstall
 * mirror). */
function spawnPluginCli(options: {
  profile: string
  argv: string[]
  dshBin: string
  env?: NodeJS.ProcessEnv
  confirm?: (home: string | undefined) => string | null
  onStatus?: (status: InstallStatus) => void
}): RunningInstall {
  const { profile, argv, dshBin, env, confirm, onStatus } = options
  const installId = randomUUID()
  const log: string[] = []
  let logBytes = 0
  let state: InstallState = 'running'
  let detail: string | undefined

  const status = (): InstallStatus => ({
    state,
    log: [...log],
    ...(state === 'done' ? { needsRestart: true } : {}),
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
      const code = (error as NodeJS.ErrnoException).code
      state = 'failed'
      detail = code === 'ENOENT'
        ? 'dsh not found on PATH — install the dsh CLI to manage profile plugins'
        : `dsh spawn failed: ${error.message}`
      onStatus?.(status())
      resolve(status())
    })
    child.on('close', (exitCode) => {
      if (state !== 'running') return
      if (exitCode === 0) {
        state = 'done'
        if (confirm !== undefined) {
          const confirmDetail = confirm(env?.DSH_HOME)
          if (confirmDetail !== null) {
            state = 'failed'
            detail = confirmDetail
          }
        }
      } else {
        state = 'failed'
        const lastLogLine = log[log.length - 1] ?? ''
        detail = `pnpm failed in the profile. Run: dsh plugin --profile ${profile} install — ${lastLogLine}`
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
 * manifest (§7.2 step 6) before the install reports `done`.
 */
export function startInstall(options: {
  profile: string
  spec: string
  dshBin?: string
  env?: NodeJS.ProcessEnv
  expectedName?: string
  onStatus?: (status: InstallStatus) => void
}): RunningInstall {
  const { profile, spec, dshBin = 'dsh', env, expectedName, onStatus } = options
  return spawnPluginCli({
    profile,
    argv: ['add', spec],
    dshBin,
    env,
    confirm: expectedName !== undefined ? home => confirmBundleActivation(profile, home, expectedName) : undefined,
    onStatus,
  })
}

/**
 * Run one `dsh plugin --profile <profile> remove <name>` and track it.
 * When `expectedName` is given, a zero exit is confirmed against the profile
 * manifest — the bundle must actually have LEFT `dsh.profile.bundles` — before
 * the uninstall reports `done`.
 */
export function startUninstall(options: {
  profile: string
  name: string
  dshBin?: string
  env?: NodeJS.ProcessEnv
  expectedName?: string
  onStatus?: (status: InstallStatus) => void
}): RunningInstall {
  const { profile, name, dshBin = 'dsh', env, expectedName, onStatus } = options
  return spawnPluginCli({
    profile,
    argv: ['remove', name],
    dshBin,
    env,
    confirm: expectedName !== undefined ? home => confirmBundleRemoval(profile, home, expectedName) : undefined,
    onStatus,
  })
}
