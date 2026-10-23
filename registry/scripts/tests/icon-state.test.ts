import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { MAX_CATALOG_ICON_BYTES, sha256Hex } from '../src/icon-bytes.ts'
import { iconDetail, iconLabel, shownPath } from '../src/icon-declaration.ts'
import type { IconMediaType } from '../src/icon-declaration.ts'
import {
  githubIconKey,
  npmIconKey,
  parseIconState,
  pruneIconState,
  releaseIconKey,
  serializeIconState,
} from '../src/icon-state.ts'
import type { IconKey, IconOutcome } from '../src/icon-state.ts'

// One row of each outcome, built from what the build would have: the published
// row's figures come from real bytes, and the two details are sentences
// `iconDetail` writes, so no fixture can drift from the thing that produces it.
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>')
const published = {
  outcome: 'published',
  sha256: sha256Hex(SVG),
  mediaType: 'image/svg+xml',
  bytes: SVG.length,
} satisfies IconOutcome
const refused = {
  outcome: 'refused',
  detail: iconDetail.tooLarge(iconLabel('icon'), shownPath('packages/a/icon.png'), MAX_CATALOG_ICON_BYTES + 1),
} satisfies IconOutcome
const notRead = {
  outcome: 'not-read',
  detail: iconDetail.packageTooLarge('@scope/pkg', '1.2.3'),
} satisfies IconOutcome

// 40 and 64 hexadecimal digits: a commit and a sha256.
const COMMIT = 'a'.repeat(40)
const TARBALL_SHA = 'b'.repeat(64)
const NPM = npmIconKey('@scope/pkg', '1.2.3', 'assets/icon.svg')
const GITHUB = githubIconKey('owner/repo', COMMIT, 'packages/a/icon.png')
const RELEASE = releaseIconKey(TARBALL_SHA, 'icon.webp')
/** A key with nothing in it a message would have to escape, for the tests that build their own row. */
const KEY = npmIconKey('x', '1.0.0', 'icon.svg')

const threeRows = (): Map<IconKey, IconOutcome> => new Map<IconKey, IconOutcome>([
  [NPM, published],
  [GITHUB, refused],
  [RELEASE, notRead],
])

/** A committed file holding one row, which may be any shape: it is what `parseIconState` is given. */
const fileOf = (key: string, row: unknown): string => `${JSON.stringify({ [key]: row }, null, 2)}\n`

/** The message a call throws. Fails the test when it throws nothing. */
function thrown(run: () => unknown): string {
  try {
    run()
  } catch (error) {
    if (error instanceof Error) return error.message
    throw error
  }
  throw new Error('expected the call to throw')
}

const permutations = <T>(items: readonly T[]): T[][] => items.length <= 1
  ? [[...items]]
  : items.flatMap((item, index) =>
    permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [item, ...rest]))

describe('the icon keys', () => {
  it.each<[what: string, actual: IconKey, expected: IconKey]>([
    ['an npm package', npmIconKey('left-pad', '1.0.0', 'icon.svg'), 'npm:left-pad@1.0.0:icon.svg'],
    ['a scoped npm package, whose scope brings the only other @', npmIconKey('@scope/pkg', '1.2.3-beta.1', 'assets/icon.svg'), 'npm:@scope/pkg@1.2.3-beta.1:assets/icon.svg'],
    ['a git-installed repository, the path holding the subpackage directory', githubIconKey('owner/repo', COMMIT, 'packages/a/icon.png'), `github:owner/repo@${COMMIT}:packages/a/icon.png`],
    ['a release asset, named by its tarball\'s digest', releaseIconKey(TARBALL_SHA, 'icon.webp'), `release:${TARBALL_SHA}:icon.webp`],
  ])('names %s', (_what, actual, expected) => {
    expect(actual).toBe(expected)
  })

  it('writes a path that holds the delimiters as it stands, because the path is last', () => {
    // A recorded key never changes meaning, so escaping a path later would
    // re-key every row written before it.
    const path = 'dir@2/odd:name#1.svg'
    expect(npmIconKey('a', '1.0.0', path)).toBe('npm:a@1.0.0:dir@2/odd:name#1.svg')
    expect(githubIconKey('o/r', COMMIT, path)).toBe(`github:o/r@${COMMIT}:dir@2/odd:name#1.svg`)
    expect(releaseIconKey(TARBALL_SHA, path)).toBe(`release:${TARBALL_SHA}:dir@2/odd:name#1.svg`)
  })
})

describe('serializeIconState', () => {
  it('writes an empty record as {} and a newline', () => {
    expect(serializeIconState(new Map())).toBe('{}\n')
  })

  it('writes two-space JSON, one block to a row, and ends in one newline', () => {
    const text = serializeIconState(new Map<IconKey, IconOutcome>([[NPM, { outcome: 'refused', detail: 'it is a gif' }]]))
    expect(text).toBe([
      '{',
      `  ${JSON.stringify(NPM)}: {`,
      '    "outcome": "refused",',
      '    "detail": "it is a gif"',
      '  }',
      '}',
      '',
    ].join('\n'))
  })

  it('reads back, row for row, what it wrote', () => {
    expect(parseIconState(serializeIconState(threeRows()))).toStrictEqual(threeRows())
  })

  it('writes the same bytes for the same rows, whatever order they were inserted in', () => {
    const texts = permutations([...threeRows()]).map((order) => serializeIconState(new Map(order)))
    expect(texts).toHaveLength(6)
    expect(new Set(texts).size).toBe(1)
  })

  it('writes the keys in code-unit order, as compareStrings orders them', () => {
    // Every key the constructors make opens with its source, so these three
    // sort github, npm, release however they were inserted.
    const text = serializeIconState(new Map<IconKey, IconOutcome>([[RELEASE, notRead], [NPM, published], [GITHUB, refused]]))
    expect(Object.keys(JSON.parse(text) as object)).toEqual([GITHUB, NPM, RELEASE])
    // And by code unit, not by locale: 'Z' (U+005A) sorts before 'a' (U+0061)
    // here and after it in almost every locale. npm still serves names with
    // capitals.
    const upper = npmIconKey('Zeta', '1.0.0', 'icon.svg')
    const lower = npmIconKey('alpha', '1.0.0', 'icon.svg')
    const mixed = serializeIconState(new Map<IconKey, IconOutcome>([[lower, refused], [upper, refused]]))
    expect(Object.keys(JSON.parse(mixed) as object)).toEqual([upper, lower])
  })

  it('writes a row\'s fields in one order, however the row was built', () => {
    const reorderedPublished = {
      bytes: published.bytes,
      mediaType: published.mediaType,
      sha256: published.sha256,
      outcome: published.outcome,
    } satisfies IconOutcome
    const reorderedRefused = { detail: refused.detail, outcome: refused.outcome } satisfies IconOutcome
    const reordered = serializeIconState(new Map<IconKey, IconOutcome>([[NPM, reorderedPublished], [GITHUB, reorderedRefused]]))
    expect(reordered).toBe(serializeIconState(new Map<IconKey, IconOutcome>([[NPM, published], [GITHUB, refused]])))
    const rows = JSON.parse(reordered) as Record<string, object>
    expect(Object.keys(rows[NPM] ?? {})).toEqual(['outcome', 'sha256', 'mediaType', 'bytes'])
    expect(Object.keys(rows[GITHUB] ?? {})).toEqual(['outcome', 'detail'])
  })

  it('keeps a key named __proto__, which assigning into a plain object would lose', () => {
    // Keys are not format-checked, so a hand-edited file may hold one. An
    // assignment `sorted['__proto__'] = row` sets the prototype and the row
    // is gone from the text.
    const text = serializeIconState(new Map<IconKey, IconOutcome>([['__proto__', refused]]))
    expect(Object.hasOwn(JSON.parse(text) as object, '__proto__')).toBe(true)
    expect(parseIconState(text)).toStrictEqual(new Map<IconKey, IconOutcome>([['__proto__', refused]]))
  })

  it('refuses to write a row it would refuse to read, naming the key', () => {
    // What it writes, the next build reads: a row that could not be read back
    // fails here, in the build that made it, and not in the next one, which
    // could not start.
    const bad = new Map<IconKey, IconOutcome>([[KEY, { ...published, sha256: 'abc' }]])
    expect(() => serializeIconState(bad)).toThrow(`icon-state.json: ${JSON.stringify(KEY)} has a published row whose sha256 is not 64 lowercase hexadecimal digits`)
  })
})

describe('parseIconState', () => {
  it.each([['with its newline', '{}\n'], ['without one', '{}']])('reads an empty record %s', (_what, text) => {
    expect(parseIconState(text)).toStrictEqual(new Map())
  })

  it.each<IconMediaType>(['image/svg+xml', 'image/png', 'image/jpeg', 'image/webp'])('reads a published row of %s', (mediaType) => {
    const row = { ...published, mediaType }
    expect(parseIconState(fileOf(NPM, row)).get(NPM)).toStrictEqual(row)
  })

  // Types only, as `repo-state.json`'s carried records are. What an icon may
  // weigh is `MAX_CATALOG_ICON_BYTES`'s to say where bytes are read, and a
  // bound lowered later must not turn every row written under the old one
  // into a build that cannot start.
  it.each([
    ['no bytes at all', 0],
    ['exactly what the catalog carries', MAX_CATALOG_ICON_BYTES],
    ['one byte more than the catalog carries', MAX_CATALOG_ICON_BYTES + 1],
    ['the most a number can count exactly', Number.MAX_SAFE_INTEGER],
  ])('reads a published row of %s', (_what, bytes) => {
    const row = { ...published, bytes }
    expect(parseIconState(fileOf(NPM, row)).get(NPM)).toStrictEqual(row)
  })

  it('reads a key of any shape: the rows are checked, not the keys', () => {
    expect(parseIconState(fileOf('not a key the build would make', refused)).get('not a key the build would make')).toStrictEqual(refused)
  })

  it('reads a key named __proto__ as a key', () => {
    // `JSON.parse` makes it an own property, and a Map holds it as any other.
    const text = `{\n  "__proto__": {\n    "outcome": "refused",\n    "detail": ${JSON.stringify(refused.detail)}\n  }\n}\n`
    expect(parseIconState(text)).toStrictEqual(new Map<IconKey, IconOutcome>([['__proto__', refused]]))
  })

  it.each([
    ['text that is not JSON', 'not json'],
    ['an empty file', ''],
    ['a file cut short', `{\n  ${JSON.stringify(NPM)}: {`],
  ])('throws on %s', (_what, text) => {
    expect(() => parseIconState(text)).toThrow('icon-state.json: not JSON')
  })

  it.each([
    ['an array', '[]'],
    ['null', 'null'],
    ['a string', '"{}"'],
    ['a number', '7'],
    ['a boolean', 'true'],
  ])('throws on a file that is %s, not an object of rows', (_what, text) => {
    expect(() => parseIconState(text)).toThrow('icon-state.json: expected an object')
  })

  // Each case below changes one thing in `valid`, and the message pins that
  // thing, so a case cannot pass by failing for another reason.
  const SHA = 'ab'.repeat(32) // 64 lowercase hexadecimal digits
  const valid = { outcome: 'published', sha256: SHA, mediaType: 'image/svg+xml', bytes: SVG.length }

  it('reads the row the cases below change one thing in', () => {
    expect(parseIconState(fileOf(KEY, valid)).get(KEY)).toStrictEqual(valid)
  })

  const NOT_AN_OBJECT = 'is not an object'
  const NO_SUCH_OUTCOME = 'has an outcome that is none of published, refused or not-read'
  const PUBLISHED_FIELDS = 'has a published row whose fields are not exactly outcome, sha256, mediaType, bytes'
  const REFUSED_FIELDS = 'has a refused row whose fields are not exactly outcome, detail'
  const NOT_READ_FIELDS = 'has a not-read row whose fields are not exactly outcome, detail'
  const BAD_SHA = 'has a published row whose sha256 is not 64 lowercase hexadecimal digits'
  const BAD_MEDIA_TYPE = 'has a published row whose mediaType is not an icon media type'
  const BAD_BYTES = 'has a published row whose bytes is not a non-negative safe integer'
  const BAD_REFUSED_DETAIL = 'has a refused row whose detail is not a string'
  const BAD_NOT_READ_DETAIL = 'has a not-read row whose detail is not a string'

  it.each<[what: string, row: unknown, reason: string]>([
    ['a row that is null', null, NOT_AN_OBJECT],
    ['a row that is a string', 'published', NOT_AN_OBJECT],
    ['a row that is a number', 7, NOT_AN_OBJECT],
    ['a row that is an array', ['refused', 'x'], NOT_AN_OBJECT],

    ['an outcome of maybe', { outcome: 'maybe', detail: 'x' }, NO_SUCH_OUTCOME],
    ['no outcome', { detail: 'x' }, NO_SUCH_OUTCOME],
    ['an outcome that is not a string', { outcome: 7, detail: 'x' }, NO_SUCH_OUTCOME],
    ['an outcome spelled with an underscore', { outcome: 'not_read', detail: 'x' }, NO_SUCH_OUTCOME],
    ['an outcome in the wrong case', { ...valid, outcome: 'Published' }, NO_SUCH_OUTCOME],

    ['a published row with a sha256 of abc', { ...valid, sha256: 'abc' }, BAD_SHA],
    ['a published row with a sha256 of 63 digits', { ...valid, sha256: SHA.slice(1) }, BAD_SHA],
    ['a published row with a sha256 of 65 digits', { ...valid, sha256: `${SHA}a` }, BAD_SHA],
    ['a published row with a sha256 in upper case', { ...valid, sha256: SHA.toUpperCase() }, BAD_SHA],
    ['a published row with a sha256 holding a digit that is not hex', { ...valid, sha256: `g${SHA.slice(1)}` }, BAD_SHA],
    ['a published row with a sha256 that is not a string', { ...valid, sha256: 7 }, BAD_SHA],

    ['a published row with a media type no icon has', { ...valid, mediaType: 'image/gif' }, BAD_MEDIA_TYPE],
    // Own keys of the table only: an `in` test or an index read would answer
    // for what `Object.prototype` holds.
    ['a published row with a media type that is a name on Object.prototype', { ...valid, mediaType: 'constructor' }, BAD_MEDIA_TYPE],
    ['a published row with a media type that is not a string', { ...valid, mediaType: 7 }, BAD_MEDIA_TYPE],

    ['a published row with bytes of -1', { ...valid, bytes: -1 }, BAD_BYTES],
    ['a published row with bytes that are a fraction', { ...valid, bytes: 1.5 }, BAD_BYTES],
    ['a published row with bytes past what a number counts exactly', { ...valid, bytes: Number.MAX_SAFE_INTEGER + 1 }, BAD_BYTES],
    ['a published row with bytes that are a string', { ...valid, bytes: `${SVG.length}` }, BAD_BYTES],
    ['a published row with bytes that are null', { ...valid, bytes: null }, BAD_BYTES],

    ['a published row with a field of its own to spare', { ...valid, detail: 'x' }, PUBLISHED_FIELDS],
    ['a published row without its bytes', { outcome: 'published', sha256: SHA, mediaType: 'image/svg+xml' }, PUBLISHED_FIELDS],
    ['a published row that is only a detail', { outcome: 'published', detail: 'x' }, PUBLISHED_FIELDS],
    // The right number of fields, one of them not the one asked for.
    ['a published row that calls its bytes something else', { outcome: 'published', sha256: SHA, mediaType: 'image/svg+xml', size: SVG.length }, PUBLISHED_FIELDS],

    ['a refused row with a field of its own to spare', { outcome: 'refused', detail: 'x', sha256: SHA }, REFUSED_FIELDS],
    ['a refused row without its detail', { outcome: 'refused' }, REFUSED_FIELDS],
    ['a refused row that calls its detail something else', { outcome: 'refused', reason: 'x' }, REFUSED_FIELDS],
    ['a refused row that is only a published one\'s figures', { outcome: 'refused', sha256: SHA, mediaType: 'image/png', bytes: SVG.length }, REFUSED_FIELDS],
    ['a refused row with a detail that is not a string', { outcome: 'refused', detail: 5 }, BAD_REFUSED_DETAIL],
    ['a refused row with a detail that is null', { outcome: 'refused', detail: null }, BAD_REFUSED_DETAIL],

    ['a not-read row with a field of its own to spare', { outcome: 'not-read', detail: 'x', bytes: SVG.length }, NOT_READ_FIELDS],
    ['a not-read row without its detail', { outcome: 'not-read' }, NOT_READ_FIELDS],
    ['a not-read row with a detail that is not a string', { outcome: 'not-read', detail: ['x'] }, BAD_NOT_READ_DETAIL],
  ])('throws, naming the row, on %s', (_what, row, reason) => {
    expect(() => parseIconState(fileOf(KEY, row))).toThrow(`icon-state.json: ${JSON.stringify(KEY)} ${reason}`)
  })

  it('names the row that is malformed, not the one before it', () => {
    const text = JSON.stringify({ [NPM]: refused, [GITHUB]: { outcome: 'maybe' } })
    const message = thrown(() => parseIconState(text))
    expect(message).toContain(JSON.stringify(GITHUB))
    expect(message).not.toContain(NPM)
  })

  it('quotes a key that holds a newline, so no line of the message can open with ::', () => {
    // A path is the package author's text and may hold a newline, and GitHub
    // Actions reads a log line that opens with `::` as a workflow command.
    const key = `${KEY}\n::error::forged`
    const message = thrown(() => parseIconState(fileOf(key, { outcome: 'maybe' })))
    expect(message).toContain(JSON.stringify(key))
    expect(message).not.toMatch(/[\r\n]/)
  })
})

describe('pruneIconState', () => {
  it('keeps exactly the live keys, and a live key with no row stays out', () => {
    const state = threeRows()
    const unrecorded = npmIconKey('unrecorded', '1.0.0', 'icon.svg')
    const pruned = pruneIconState(state, new Set([NPM, RELEASE, unrecorded]))
    expect(pruned).toStrictEqual(new Map<IconKey, IconOutcome>([[NPM, published], [RELEASE, notRead]]))
    expect(pruned.has(GITHUB)).toBe(false)
    expect(pruned.has(unrecorded)).toBe(false)
  })

  it('leaves the record it was given as it was', () => {
    const state = threeRows()
    pruneIconState(state, new Set([NPM]))
    expect(state).toStrictEqual(threeRows())
  })

  it('drops every row when nothing is live, and keeps every row when all are', () => {
    expect(pruneIconState(threeRows(), new Set())).toStrictEqual(new Map())
    const all = pruneIconState(threeRows(), new Set([NPM, GITHUB, RELEASE]))
    expect(all).toStrictEqual(threeRows())
  })
})

describe('the committed outcome record', () => {
  it('still parses registry/icon-state.json, which a malformed row would turn into a build that cannot start', () => {
    // A build input committed daily. The parse refuses what this build never
    // writes, so a hand edit that went wrong fails here, at the pull request,
    // rather than at the next daily run.
    const committed = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'icon-state.json')
    expect(() => parseIconState(readFileSync(committed, 'utf8'))).not.toThrow()
  })
})
