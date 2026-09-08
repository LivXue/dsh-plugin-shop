/**
 * Spawning a JS command line on both platforms.
 *
 * `spawnSync('npm', …)` and `spawnSync('npx', …)` are ENOENT on Windows for
 * the same reason `spawn('dsh')` is (see `src/host/dsh-cli.ts`): each installs
 * as `<name>`, `<name>.cmd` and `<name>.ps1` with no `.exe`, and libuv
 * resolves a bare name against `.com` and `.exe` only. Running the tool's own
 * JS entry through the CURRENT node keeps the shell out of it — so an argument
 * containing a space stays one argument — and pins the interpreter to the one
 * running the test rather than to whatever a shim resolves.
 *
 * Shared rather than per-file because it was not: the working version lived
 * unexported inside `local-registry.ts`, so `transport-parity.test.ts`
 * reimplemented the bare spelling and skipped all three of its cases on
 * Windows, and `temp-dir-leak.test.ts` reimplemented it again for `npx` and
 * went vacuously green.
 */

import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

/** `npm <args>` as something spawnable on every platform. npm ships beside
 * the node binary, so its entry is found there rather than resolved as a
 * dependency; the bare name remains the POSIX path and the Windows fallback. */
export function npmCommand(args: readonly string[]): { command: string; args: string[] } {
  if (process.platform === 'win32') {
    const cli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
    if (existsSync(cli)) return { command: process.execPath, args: [cli, ...args] }
  }
  return { command: 'npm', args: [...args] }
}

/**
 * A dependency's own bin script, run under the current node.
 *
 * Resolved through the package's `bin` field, never through
 * `node_modules/.bin` — on Windows those entries are the `.cmd`/`.ps1` shims
 * a bare spawn cannot reach, and under pnpm they are symlinks into a
 * content-addressed store whose path nothing should hard-code.
 */
export function nodeCliCommand(pkg: string, args: readonly string[]): { command: string; args: string[] } {
  const manifestPath = createRequire(import.meta.url).resolve(`${pkg}/package.json`)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    bin?: string | Record<string, string>
  }
  const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.[pkg]
  if (bin === undefined) throw new Error(`${pkg} declares no bin entry named ${pkg}`)
  return { command: process.execPath, args: [join(dirname(manifestPath), bin), ...args] }
}
