import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { tmpdir } from 'node:os'
import { dshCommand, resolveDshScript, type DshCliFs } from '../../src/host/dsh-cli.ts'

// Fixtures over mocks: every case builds a real directory tree and reads it
// through the same seam production uses, so a resolution bug cannot hide
// behind a stub that agrees with it.
const realFs: DshCliFs = {
  exists: path => existsSync(path),
  read: path => readFileSync(path, 'utf8'),
}

/** An npm-global layout: the shims' directory, with the CLI package installed
 * in `node_modules` beside them. Measured on Windows 2026-09-02 — npm writes
 * `dsh`, `dsh.cmd` and `dsh.ps1` into `%APPDATA%\npm` and the package into
 * `%APPDATA%\npm\node_modules\@deepseek-ai\dsh`. */
function npmGlobal(options: { bin?: unknown; entry?: string | null } = {}): { shimDir: string; entry: string } {
  const { bin = { dsh: 'lib/bin.js' }, entry = 'lib/bin.js' } = options
  const shimDir = mkdtempSync(join(tmpdir(), 'dsh-cli-global-'))
  const packageDir = join(shimDir, 'node_modules', '@deepseek-ai', 'dsh')
  mkdirSync(join(packageDir, 'lib'), { recursive: true })
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.1-rc.2', bin }))
  if (entry !== null) writeFileSync(join(packageDir, entry), '#!/usr/bin/env node\n')
  return { shimDir, entry: join(packageDir, 'lib', 'bin.js') }
}

describe('dshCommand', () => {
  const args = ['plugin', '--profile', 'web', 'add', 'dsh-hello-plugin@1.2.0'] as const

  it('runs the CLI entry through node on Windows, where the npm shim cannot be spawned', () => {
    // Measured 2026-09-02: `spawn('dsh')` is ENOENT because libuv resolves a
    // bare name against .com/.exe only, and spawning the .cmd shim throws
    // EINVAL (node's 2024 batfile argument-injection fix). Running the entry
    // through node is the only form that starts — and it takes no shell, so
    // a spec carrying `&` (a `github:` entry's `&path:` form, or a tarball
    // URL query) can never reach a cmd.exe command separator.
    expect(dshCommand({ dshBin: 'dsh', args, platform: 'win32', execPath: 'C:\\node\\node.exe', script: 'C:\\npm\\dsh\\lib\\bin.js' }))
      .toEqual({ command: 'C:\\node\\node.exe', args: ['C:\\npm\\dsh\\lib\\bin.js', ...args] })
  })

  it('falls back to the binary itself on Windows when no entry could be located', () => {
    expect(dshCommand({ dshBin: 'dsh', args, platform: 'win32', execPath: 'C:\\node\\node.exe', script: null }))
      .toEqual({ command: 'dsh', args: [...args] })
  })

  it('leaves POSIX untouched even when an entry is available', () => {
    // The shim problem is Windows-only: on POSIX npm writes an executable
    // script with a shebang and `spawn('dsh')` finds it on PATH. Routing
    // through node there would change a working path for no reason.
    for (const platform of ['linux', 'darwin'] as const) {
      expect(dshCommand({ dshBin: 'dsh', args, platform, execPath: '/usr/bin/node', script: '/usr/lib/dsh/bin.js' }))
        .toEqual({ command: 'dsh', args: [...args] })
    }
  })

  it('spawns an explicitly named binary as given, rather than substituting the entry', () => {
    // The node route replaces PATH lookup of the bare name, nothing else. A
    // caller that named a file meant that file; the real-installation test
    // and the fixture tests both depend on being spawned as written.
    expect(dshCommand({ dshBin: 'C:\\custom\\dsh.cmd', args, platform: 'win32', execPath: 'C:\\node\\node.exe', script: 'C:\\npm\\dsh\\lib\\bin.js' }))
      .toEqual({ command: 'C:\\custom\\dsh.cmd', args: [...args] })
  })

  it('does not alias the caller\'s args array', () => {
    const source = ['plugin', 'add']
    const result = dshCommand({ dshBin: 'dsh', args: source, platform: 'linux', execPath: '/usr/bin/node', script: null })
    result.args.push('mutated')
    expect(source).toEqual(['plugin', 'add'])
  })
})

describe('resolveDshScript', () => {
  it('takes the entry of the CLI package that owns the running script', () => {
    // In production this is the fast path AND the correct one: the shop is
    // loaded by dsh, so `process.argv[1]` is dsh's own entry, and running it
    // guarantees the child is the SAME dsh serving the shop rather than
    // whichever one PATH happens to name.
    const { shimDir, entry } = npmGlobal()
    expect(resolveDshScript(realFs, { argv1: entry, path: undefined })).toBe(entry)
    expect(shimDir).toBeTruthy()
  })

  it('rejects a running script owned by some other package and falls back to PATH', () => {
    // Under vitest `argv1` is the test runner's entry. Accepting it would
    // spawn `node <vitest cli> plugin --profile …`, so the owner check is
    // what keeps the real-install test honest.
    const decoy = mkdtempSync(join(tmpdir(), 'dsh-cli-decoy-'))
    const vitestDir = join(decoy, 'node_modules', 'vitest')
    mkdirSync(vitestDir, { recursive: true })
    writeFileSync(join(vitestDir, 'package.json'), JSON.stringify({ name: 'vitest', bin: { vitest: 'cli.js' } }))
    writeFileSync(join(vitestDir, 'cli.js'), '')

    expect(resolveDshScript(realFs, { argv1: join(vitestDir, 'cli.js'), path: undefined })).toBeNull()

    const { shimDir, entry } = npmGlobal()
    expect(resolveDshScript(realFs, { argv1: join(vitestDir, 'cli.js'), path: shimDir })).toBe(entry)
  })

  it('finds the CLI package beside a shim on PATH', () => {
    const { shimDir, entry } = npmGlobal()
    const path = [join(tmpdir(), 'nothing-here'), shimDir].join(delimiter)
    expect(resolveDshScript(realFs, { argv1: undefined, path })).toBe(entry)
  })

  it('accepts the plain-string bin form', () => {
    // `"bin": "lib/bin.js"` on a scoped package names the bin after the
    // unscoped package name, so it is the same declaration as `{ dsh: … }`.
    const { shimDir, entry } = npmGlobal({ bin: 'lib/bin.js' })
    expect(resolveDshScript(realFs, { argv1: undefined, path: shimDir })).toBe(entry)
  })

  it('refuses a declared entry that is not on disk', () => {
    // A half-removed global install: the manifest still declares the bin but
    // the file is gone. Returning it would spawn node against a missing
    // script, whose error names node rather than the real problem.
    const { shimDir } = npmGlobal({ entry: null })
    expect(resolveDshScript(realFs, { argv1: undefined, path: shimDir })).toBeNull()
  })

  it('refuses a same-named package that declares no dsh bin', () => {
    const { shimDir } = npmGlobal({ bin: { other: 'lib/bin.js' } })
    expect(resolveDshScript(realFs, { argv1: undefined, path: shimDir })).toBeNull()
  })

  it('returns null when nothing on PATH carries the CLI package', () => {
    expect(resolveDshScript(realFs, { argv1: undefined, path: undefined })).toBeNull()
    expect(resolveDshScript(realFs, { argv1: undefined, path: '' })).toBeNull()
    expect(resolveDshScript(realFs, { argv1: undefined, path: mkdtempSync(join(tmpdir(), 'dsh-cli-empty-')) })).toBeNull()
  })

  it('survives a malformed manifest rather than throwing', () => {
    // Everything read off disk here is outside our control; a manifest that
    // is not JSON means "not the package we are looking for", and the scan
    // must continue to the next PATH entry.
    const broken = mkdtempSync(join(tmpdir(), 'dsh-cli-broken-'))
    mkdirSync(join(broken, 'node_modules', '@deepseek-ai', 'dsh'), { recursive: true })
    writeFileSync(join(broken, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), '{ not json')
    const { shimDir, entry } = npmGlobal()
    expect(resolveDshScript(realFs, { argv1: undefined, path: [broken, shimDir].join(delimiter) })).toBe(entry)
  })
})
