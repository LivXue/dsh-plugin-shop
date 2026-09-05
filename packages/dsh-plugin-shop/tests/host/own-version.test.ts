/** `ownVersion()` is what the self-update check compares against
 * `dist-tags.latest` and what the client prints in the version row. It reads
 * `../package.json` relative to its OWN module url, and its correctness rests
 * on a layout claim in its header comment: the source tree and the bundled
 * `lib/index.js` both sit exactly one level below the package root, so the
 * same relative url resolves in both. Nothing tested either half (audit H-9),
 * and every 0.5.x release broke on an untested assumption of exactly this
 * kind.
 */

import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ownVersion } from '../../src/own-version.ts'

const packageRoot = join(import.meta.dirname, '..', '..')

function manifest(): { version: string; main: string } {
  return JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as { version: string; main: string }
}

describe('ownVersion', () => {
  it('reports the version in the package that ships it', () => {
    expect(ownVersion()).toBe(manifest().version)
    // A semver, not a path or an empty string: the self-update comparison
    // feeds this to a semver compare, and a non-version silently disables the
    // check rather than failing it.
    expect(ownVersion()).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/)
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
