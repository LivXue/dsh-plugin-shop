/** Bilingual documentation comes in pairs, and the pairs must stay linked.
 *
 * CLAUDE.md requires every user-facing document to exist as `X.md` and
 * `X.zh.md` with an `English | 中文` header linking them both ways. That
 * convention held only because one person remembered it: the sibling test in
 * this directory exists because `packages/dsh-plugin-shop/docs/README.zh.md`
 * sat three releases behind its English half with CI green the whole way. A
 * convention no test enforces is a convention that drifts silently, and adding
 * four new pairs at once is four new chances to drift.
 *
 * The link is checked by resolution, not by spelling. Five pairs link
 * relatively; the sixth links absolutely, because npm renders the package
 * README on its own page where a relative path resolves against nothing. Both
 * shapes are correct, so the assertion accepts either and insists only that
 * whichever is used points at the actual sibling.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { dirname as posixDirname, relative as posixRelative } from 'node:path/posix'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

const BLOB = 'https://github.com/LivXue/dsh-plugin-shop/blob/main/'

const PAIRS: ReadonlyArray<{ en: string; zh: string }> = [
  { en: 'README.md', zh: 'README.zh.md' },
  { en: 'CONTRIBUTING.md', zh: 'CONTRIBUTING.zh.md' },
  { en: 'CODE_OF_CONDUCT.md', zh: 'CODE_OF_CONDUCT.zh.md' },
  { en: 'SECURITY.md', zh: 'SECURITY.zh.md' },
  { en: 'docs/schema.md', zh: 'docs/schema.zh.md' },
  // The one irregular shape. npm ships every README* at a package root and
  // picks which one its page shows, so the Chinese half is parked under
  // docs/ instead of beside its sibling — and both halves link absolutely,
  // because that page is not GitHub and a relative path dies there.
  { en: 'packages/dsh-plugin-shop/README.md', zh: 'packages/dsh-plugin-shop/docs/README.zh.md' },
]

/** Either spelling of a link from `from` to `to`, as it may appear in `from`. */
const linkTargets = (from: string, to: string): string[] => [
  posixRelative(posixDirname(from), to),
  `${BLOB}${to}`,
]

describe('bilingual documentation pairs', () => {
  for (const { en, zh } of PAIRS) {
    it(`${en} and ${zh} link to each other`, () => {
      const english = readFileSync(join(repoRoot, en), 'utf8')
      const chinese = readFileSync(join(repoRoot, zh), 'utf8')

      // The header itself, so a pair cannot pass on an incidental link buried
      // in the body — `English | [中文](…)` one way, `[English](…) | 中文` the
      // other.
      const toZh = linkTargets(en, zh).map(target => `English | [中文](${target})`)
      const toEn = linkTargets(zh, en).map(target => `[English](${target}) | 中文`)

      expect(
        toZh.some(header => english.includes(header)),
        `${en} carries no header link to ${zh}; expected one of ${toZh.join(' or ')}`,
      ).toBe(true)
      expect(
        toEn.some(header => chinese.includes(header)),
        `${zh} carries no header link to ${en}; expected one of ${toEn.join(' or ')}`,
      ).toBe(true)
    })

    it(`${en} and ${zh} each end with exactly one newline`, () => {
      for (const file of [en, zh]) {
        const text = readFileSync(join(repoRoot, file), 'utf8')
        expect(text.endsWith('\n'), `${file} does not end with a newline`).toBe(true)
        expect(text.endsWith('\n\n'), `${file} ends with more than one newline`).toBe(false)
      }
    })
  }
})
