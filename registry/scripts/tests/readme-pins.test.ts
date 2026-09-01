/** The README install pins must name the version being published.
 *
 * CLAUDE.md requires a release commit to move `package.json` and all four
 * READMEs together. It drifted anyway: `packages/dsh-plugin-shop/docs/
 * README.zh.md` sat at 0.4.14 through the 0.5.0, 0.5.1 and 0.5.2 releases,
 * telling every Chinese reader to install a version three releases behind —
 * one of them the build that could not read the live catalog at all. A
 * convention no test enforces is a convention that drifts silently.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

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

  for (const file of READMES) {
    it(`${file} pins the published version`, () => {
      const text = readFileSync(join(repoRoot, file), 'utf8')
      const pins = [...text.matchAll(PIN_RE)].map(match => match[1])
      // A README with no pin at all would pass an "every" check vacuously,
      // which is the same silent drift in a different costume.
      expect(pins.length).toBeGreaterThan(0)
      expect([...new Set(pins)]).toEqual([version])
    })
  }
})
