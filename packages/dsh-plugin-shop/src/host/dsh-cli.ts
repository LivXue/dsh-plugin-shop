/**
 * How to start the dsh CLI as a child process.
 *
 * On POSIX this is `spawn('dsh', …)` and there is nothing to decide. On
 * Windows there is no form of that call which can work: npm installs a CLI as
 * `dsh`, `dsh.cmd` and `dsh.ps1` shims with no `.exe`, libuv resolves a bare
 * name against `.com` and `.exe` only, and node has refused to spawn a `.cmd`
 * without a shell since the 2024 batfile argument-injection fix. Measured on
 * Windows 11 with dsh 0.1.1-rc.2 (2026-09-02): the bare name gives ENOENT,
 * the resolved `.cmd` shim throws EINVAL *synchronously* out of `spawn()`.
 *
 * `shell: true` — what the shim exists for, and what dsh's own pnpm spawn
 * uses — is not available to us. node hands cmd.exe a joined, UNQUOTED
 * command string, and our argv carries catalog data: a `github:` entry's spec
 * is `github:owner/slug#<sha>&path:<subdir>`, `&` is a cmd command separator,
 * and `subdir` comes from npm. That is a command-injection surface on
 * untrusted input, so the shop resolves the CLI's JS entry and runs it through
 * node instead — no shell, and node escapes the argv itself.
 *
 * Pure core, impure shell: `dshCommand` decides, `resolveDshScript` takes the
 * process snapshot and a filesystem seam as parameters (the same shape as
 * `detectSupervisor(env, proc)` and `RepoPinFs`).
 */

import { dirname, join, resolve, delimiter } from 'node:path'

/** The npm package the dsh CLI is published as. */
export const DSH_PACKAGE = '@deepseek-ai/dsh'

/** The bin name that package declares (`bin: { dsh: 'lib/bin.js' }`), which is
 * also the unscoped name its plain-string `bin` form would take. */
const DSH_BIN_NAME = 'dsh'

export interface DshCliFs {
  exists: (path: string) => boolean
  read: (path: string) => string
}

/** A spawnable command: `spawn(command, args)` with no shell. */
export interface DshCommand {
  command: string
  args: string[]
}

/**
 * The command that starts the dsh CLI with `args`.
 *
 * The node route replaces exactly one thing: looking the bare name `dsh` up
 * on PATH, which on Windows can never succeed. A `dshBin` naming a specific
 * file is the caller's explicit choice and is spawned as given — honoring it
 * and reporting the real failure beats silently running something else.
 */
export function dshCommand(options: {
  dshBin: string
  args: readonly string[]
  platform: NodeJS.Platform
  execPath: string
  script: string | null
}): DshCommand {
  const { dshBin, args, platform, execPath, script } = options
  if (platform === 'win32' && script !== null && dshBin === DSH_BIN_NAME) {
    return { command: execPath, args: [script, ...args] }
  }
  return { command: dshBin, args: [...args] }
}

/** The dsh entry a package manifest declares, or null when this manifest is
 * not the dsh CLI. Everything read here is outside our control, so a manifest
 * that will not parse is simply not a match. */
function declaredEntry(fs: DshCliFs, manifestPath: string): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(fs.read(manifestPath))
  } catch {
    // Unreadable or not JSON — the only other reader is the PATH scan, which
    // continues to the next entry. Nothing else can reach this.
    return null
  }
  const { name, bin } = parsed as { name?: unknown; bin?: unknown }
  if (name !== DSH_PACKAGE) return null
  const declared = typeof bin === 'string' ? bin : (bin as Record<string, unknown> | null | undefined)?.[DSH_BIN_NAME]
  if (typeof declared !== 'string') return null
  const entry = join(dirname(manifestPath), declared)
  // A manifest may outlive its files (a half-removed global install). Handing
  // back a missing script would spawn node against nothing, and the error
  // would name node rather than the real problem.
  return fs.exists(entry) ? entry : null
}

/** The dsh entry declared by the package that OWNS `script` — the nearest
 * `package.json` at or above it, and only that one. A script whose owner is
 * some other package is not dsh's, so the search stops rather than walking up
 * into an unrelated workspace root. */
function owningEntry(fs: DshCliFs, script: string): string | null {
  let dir = dirname(resolve(script))
  for (;;) {
    const manifestPath = join(dir, 'package.json')
    if (fs.exists(manifestPath)) return declaredEntry(fs, manifestPath)
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/**
 * Locate the dsh CLI's JS entry, or null when it cannot be found.
 *
 * `argv1` first: the shop is loaded BY dsh, so the running script is dsh's own
 * entry, and reusing it guarantees the child is the same dsh that is serving
 * the shop rather than whichever one PATH happens to name. The owner check is
 * what makes this safe to try — under a test runner `argv1` belongs to the
 * runner, and accepting it would spawn the wrong program.
 *
 * Then the shims on PATH: npm installs the package into `node_modules` beside
 * them, so the manifest is one join away. This is the branch a test harness
 * takes, which is why the real-installation test exercises it.
 */
export function resolveDshScript(fs: DshCliFs, options: {
  argv1: string | undefined
  path: string | undefined
}): string | null {
  if (options.argv1 !== undefined) {
    const owned = owningEntry(fs, options.argv1)
    if (owned !== null) return owned
  }
  for (const dir of (options.path ?? '').split(delimiter)) {
    if (dir === '') continue
    const manifestPath = join(dir, 'node_modules', ...DSH_PACKAGE.split('/'), 'package.json')
    if (!fs.exists(manifestPath)) continue
    const entry = declaredEntry(fs, manifestPath)
    if (entry !== null) return entry
  }
  return null
}
