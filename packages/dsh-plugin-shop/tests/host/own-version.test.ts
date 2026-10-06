/** `runningVersion()` is what the self-update check compares against
 * `dist-tags.latest` and what the client prints in the version row. It reads
 * `../package.json` relative to its OWN module url, and its correctness rests
 * on a layout claim in its header comment: the source tree and the bundled
 * `lib/index.js` both sit exactly one level below the package root, so the
 * same relative url resolves in both. Nothing tested either half (audit H-9),
 * and every 0.5.x release broke on an untested assumption of exactly this
 * kind.
 */

import { describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runningVersion, versionAtLoad } from '../../src/own-version.ts'

const packageRoot = join(import.meta.dirname, '..', '..')

function manifest(): { version: string; main: string } {
  return JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as { version: string; main: string }
}

describe('runningVersion', () => {
  it('reports the version in the package that ships it', () => {
    expect(runningVersion()).toBe(manifest().version)
    // A semver, not a path or an empty string: the self-update comparison
    // feeds this to a semver compare, and a non-version silently disables the
    // check rather than failing it.
    expect(runningVersion()).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/)
  })

  it('is one directory below the package root in both trees the module claims', () => {
    // The claim: `new URL('../package.json', import.meta.url)` resolves for
    // src/own-version.ts AND for lib/index.js. The first half is proven by the
    // case above; this pins the second, which a bundler layout change
    // (lib/host/index.js, say) would break at a user's boot and at no other
    // time. `pnpm test` and `pnpm typecheck` both run tsdown first, so lib/ is
    // present here — a bare `vitest run` after `rm -rf lib` is the one way to
    // see this fail without a real defect.
    expect(existsSync(join(packageRoot, 'src', 'own-version.ts'))).toBe(true)
    expect(existsSync(join(packageRoot, 'lib', 'index.js')), 'run tsdown: lib/ is a build output').toBe(true)
    expect(manifest().main).toBe('lib/index.js')
  })
})

describe('versionAtLoad', () => {
  it('keeps the version it read first, whatever the file says afterwards', () => {
    // A profile installs hoisted: a self-update rewrites package.json under
    // the RUNNING code. The version of that code is the one read before the
    // rewrite, so a later read must not replace it.
    const read = vi.fn<() => string>().mockReturnValueOnce('0.8.3').mockReturnValue('0.8.4')
    const running = versionAtLoad(read)
    expect(running()).toBe('0.8.3')
    expect(running()).toBe('0.8.3')
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('falls back to reading on demand when the first read failed', () => {
    // A manifest unreadable at load must not take the module import down with
    // it; the version row then answers from the file, as it always did.
    const read = vi.fn<() => string>()
      .mockImplementationOnce(() => { throw new Error('EACCES') })
      .mockReturnValue('0.8.4')
    expect(versionAtLoad(read)()).toBe('0.8.4')
  })
})

describe('bootId', () => {
  it('differs in every process that loads the shop', () => {
    // The page compares it across a restart: the same value after the reload
    // means the process that was asked to restart is still the one answering
    // (design §8, 2026-10-06 amendment). A value derived from anything a
    // restart keeps — the version, the profile, the port — would read every
    // restart that installed no new shop as one that never happened. Each
    // child is a process of its own, loading this module the way a dsh boot
    // does.
    const module = JSON.stringify(pathToFileURL(join(packageRoot, 'src', 'own-version.ts')).href)
    const inProcess = (): string => execFileSync(process.execPath, [
      '--input-type=module',
      '-e',
      `const { bootId } = await import(${module}); process.stdout.write(String(bootId))`,
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    const first = inProcess()
    const second = inProcess()
    expect(first).not.toBe('undefined')
    expect(first).not.toBe('')
    expect(second).not.toBe(first)
  })
})
