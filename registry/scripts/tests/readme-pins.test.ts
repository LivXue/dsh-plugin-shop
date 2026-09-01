/** The README install pins must name the version a reader should install.
 *
 * CLAUDE.md requires a release commit to move `package.json` and all four
 * READMEs together. It drifted anyway: `packages/dsh-plugin-shop/docs/
 * README.zh.md` sat at 0.4.14 through the 0.5.0, 0.5.1 and 0.5.2 releases,
 * telling every Chinese reader to install a version three releases behind —
 * one of them the build that could not read the live catalog at all. A
 * convention no test enforces is a convention that drifts silently.
 *
 * A PRERELEASE is the one version the READMEs must NOT name. `package.json`
 * carries `X.Y.Z-beta.N` for as long as that build is being proven on the beta
 * tag, while `dsh plugin add dsh-plugin-shop` still resolves `latest` — so a
 * README pinning the prerelease would hand every reader the untested build,
 * which is exactly what the beta channel exists to prevent (CLAUDE.md, Release
 * channels). During that window the pins must agree on one STABLE version
 * below the release being prepared; the promotion commit then moves all four
 * to it and equality resumes. This first bit at 0.5.4-beta.0: the test
 * demanded the prerelease pin the release rules forbid.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { lt, major, minor, patch, prerelease } from 'semver'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

const READMES = [
  'README.md',
  'README.zh.md',
  'packages/dsh-plugin-shop/README.md',
  'packages/dsh-plugin-shop/docs/README.zh.md',
]

const PIN_RE = /dsh-plugin-shop@(\d[^\s`]*)/g

describe('README install pins', () => {
  const version = (JSON.parse(
    readFileSync(join(repoRoot, 'packages', 'dsh-plugin-shop', 'package.json'), 'utf8'),
  ) as { version: string }).version
  // `X.Y.Z-beta.N` prepares the release `X.Y.Z`; the pins must sit below it.
  const preparing = prerelease(version) === null
    ? null
    : `${major(version)}.${minor(version)}.${patch(version)}`

  const pinsByFile = Object.fromEntries(READMES.map(file => [
    file,
    [...new Set([...readFileSync(join(repoRoot, file), 'utf8').matchAll(PIN_RE)].map(match => match[1]))],
  ])) as Record<string, string[]>

  it('every README carries an install pin, and all four name the same version', () => {
    // Checked across the four files, not against `version`: in the prerelease
    // window there is no per-file anchor to compare to, and a README left
    // behind at 0.4.14 while its siblings moved is the exact drift this file
    // exists to catch.
    for (const [file, pins] of Object.entries(pinsByFile)) {
      // A README with no pin at all would pass an "every" check vacuously,
      // which is the same silent drift in a different costume.
      expect(pins, `${file} carries no dsh-plugin-shop@<version> install pin`).toHaveLength(1)
    }
    expect(
      [...new Set(Object.values(pinsByFile).flat())],
      `the READMEs disagree: ${JSON.stringify(pinsByFile)}`,
    ).toHaveLength(1)
  })

  it('the pin names the version a reader installing today would get', () => {
    const [pin] = [...new Set(Object.values(pinsByFile).flat())]
    // The agreement test above owns "there is exactly one"; this guard keeps
    // the type honest without asserting a state that test does not allow.
    if (pin === undefined) throw new Error('no README carries an install pin')
    if (preparing === null) {
      // A stable version IS what `latest` resolves to; the release commit
      // moves package.json and the four READMEs together.
      expect(pin).toBe(version)
      return
    }
    // The prerelease window: `latest` still resolves to the previous stable,
    // so that is what the READMEs must name. Drift cannot accumulate here —
    // the promotion commit restores equality before the next window opens.
    expect(prerelease(pin)).toBeNull()
    expect(lt(pin, preparing)).toBe(true)
  })
})
