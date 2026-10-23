import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { MAX_CATALOG_ICON_BYTES, iconDataUrl, sha256Hex } from '../src/icon-bytes.ts'
import { ICON_MEDIA_TYPES, iconDetail } from '../src/icon-declaration.ts'
import type { IconMediaType } from '../src/icon-declaration.ts'
import { githubIconKey, npmIconKey, releaseIconKey } from '../src/icon-state.ts'
import type { IconKey } from '../src/icon-state.ts'
import { compareStrings } from '../src/identity.ts'
import { ICONS_FILE_BUDGET_BYTES, assembleIcons, isIconDataUrl, parseIconsFile, serializeIcons } from '../src/icons-assemble.ts'
import type { IconsFile, PublishedIcon } from '../src/icons-assemble.ts'

/**
 * `length` bytes whose identity the test chooses: the seed is written into the
 * first two, so no two seeds make the same sha256, and the rest is one value.
 * These are no image; nothing under test reads the bytes, only their digest and
 * their length.
 */
function bytesOf(length: number, seed: number): Uint8Array {
  const bytes = new Uint8Array(length).fill(0xab)
  bytes[0] = seed & 0xff
  bytes[1] = seed >> 8
  return bytes
}

/** An icon as the build hands it over: the digest and the data URL are what the build makes of the bytes. */
function icon(key: IconKey, bytes: Uint8Array, mediaType: IconMediaType = 'image/png'): PublishedIcon {
  return { key, sha256: sha256Hex(bytes), dataUrl: iconDataUrl(bytes, mediaType) }
}

/** A key with nothing in it a message would have to escape. */
const keyOf = (name: string): IconKey => npmIconKey(name, '1.0.0', 'icon.png')

/**
 * One icon of each media type in the table, whose data URLs are written out
 * here from the table's own keys, so that no test lists the types a second time.
 */
function oneOfEachType(): PublishedIcon[] {
  return Object.keys(ICON_MEDIA_TYPES).map((mediaType, index) => {
    const bytes = bytesOf(MAX_CATALOG_ICON_BYTES / 8, 100 + index)
    return { key: keyOf(`type-${index}`), sha256: sha256Hex(bytes), dataUrl: `data:${mediaType};base64,${Buffer.from(bytes).toString('base64')}` }
  })
}

/**
 * The file that holds exactly these icons, built here by hand and not by
 * `assembleIcons`: what the budget tests hold the implementation to.
 */
function fileOf(icons: readonly PublishedIcon[]): IconsFile {
  return {
    icons: Object.fromEntries(icons.map(({ sha256, dataUrl }) => [sha256, dataUrl])),
    sources: Object.fromEntries(icons.map(({ key, sha256 }) => [key, sha256])),
  }
}

/** What the budget counts: the UTF-8 bytes of the text `serializeIcons` writes. */
const sizeOf = (file: IconsFile): number => Buffer.byteLength(serializeIcons(file).json)

const permutations = <T>(items: readonly T[]): T[][] => items.length <= 1
  ? [[...items]]
  : items.flatMap((item, index) =>
    permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [item, ...rest]))

/**
 * The order the budget admits icons in, said again here as the rule states it
 * and not as the implementation reaches it: the shortest data URL first, equal
 * lengths by sha256 in code-unit order, one place for each distinct sha256.
 */
function admissionOrder(icons: readonly PublishedIcon[]): string[] {
  const bySha = new Map(icons.map((each): [string, PublishedIcon] => [each.sha256, each]))
  return [...bySha.values()]
    .sort((a, b) => a.dataUrl.length - b.dataUrl.length || compareStrings(a.sha256, b.sha256))
    .map((each) => each.sha256)
}

/** The icons of the first `count` distinct sha256s in {@link admissionOrder}: every key that names one of them. */
function firstIcons(icons: readonly PublishedIcon[], count: number): PublishedIcon[] {
  const shas = new Set(admissionOrder(icons).slice(0, count))
  return icons.filter((each) => shas.has(each.sha256))
}

// Sizes are fractions of the largest icon the catalog carries, so that no
// fixture types a byte count.
const EIGHTH = MAX_CATALOG_ICON_BYTES / 8
const QUARTER = MAX_CATALOG_ICON_BYTES / 4
const HALF = MAX_CATALOG_ICON_BYTES / 2

const SMALL = icon(keyOf('small'), bytesOf(EIGHTH, 1))
const MEDIUM = icon(keyOf('medium'), bytesOf(QUARTER, 2))
const LARGE = icon(keyOf('large'), bytesOf(HALF, 3))
/** The same bytes as SMALL, held by another package. */
const SMALL_TWIN = icon(keyOf('small-twin'), bytesOf(EIGHTH, 1))
/** The same bytes as LARGE, held by another package. */
const LARGE_TWIN = icon(keyOf('large-twin'), bytesOf(HALF, 3))

/** A sha256 and a data URL for the files below that are written by hand, and a second sha256 that those files do not hold. */
const SHA = 'a'.repeat(64)
const OTHER_SHA = 'b'.repeat(64)
const DATA_URL = 'data:image/png;base64,AAAA'

describe('the fixtures', () => {
  it('are the sizes and the identities their names say', () => {
    expect(SMALL.dataUrl.length).toBeLessThan(MEDIUM.dataUrl.length)
    expect(MEDIUM.dataUrl.length).toBeLessThan(LARGE.dataUrl.length)
    expect(SMALL_TWIN.sha256).toBe(SMALL.sha256)
    expect(SMALL_TWIN.key).not.toBe(SMALL.key)
    expect(LARGE_TWIN.sha256).toBe(LARGE.sha256)
    expect(new Set([SMALL, MEDIUM, LARGE].map((each) => each.sha256)).size).toBe(3)
    expect(isIconDataUrl(DATA_URL)).toBe(true)
    expect(oneOfEachType().length).toBeGreaterThan(1)
  })
})

describe('assembleIcons: what the file holds', () => {
  it('holds each distinct icon once, and every key under the icon it names', () => {
    const { file, withheldForSize } = assembleIcons([SMALL, MEDIUM, SMALL_TWIN])
    expect(file).toEqual({
      icons: { [SMALL.sha256]: SMALL.dataUrl, [MEDIUM.sha256]: MEDIUM.dataUrl },
      sources: { [SMALL.key]: SMALL.sha256, [SMALL_TWIN.key]: SMALL.sha256, [MEDIUM.key]: MEDIUM.sha256 },
    })
    expect(withheldForSize).toEqual([])
  })

  it('reads an icon handed over twice as one', () => {
    expect(assembleIcons([SMALL, MEDIUM, SMALL, MEDIUM])).toEqual(assembleIcons([SMALL, MEDIUM]))
  })

  it('holds nothing for no icons', () => {
    expect(assembleIcons([])).toEqual({ file: { icons: {}, sources: {} }, withheldForSize: [] })
  })

  it('carries a data URL of each of the media types', () => {
    const everyType = oneOfEachType()
    expect(assembleIcons(everyType).file).toEqual(fileOf(everyType))
  })

  it('leaves the icons it is given as they were', () => {
    const given = [LARGE, SMALL, MEDIUM, SMALL_TWIN]
    const before = given.map((each) => each.key)
    assembleIcons(given, sizeOf(fileOf([SMALL, MEDIUM])))
    expect(given.map((each) => each.key)).toEqual(before)
  })

  // A sha256 names bytes and a key names one artifact, so a file that holds two
  // answers for either could carry only one of them and would not say which.
  it('refuses two data URLs for one sha256, whichever comes first', () => {
    const otherType = icon(keyOf('other-type'), bytesOf(EIGHTH, 1), 'image/webp')
    expect(otherType.sha256).toBe(SMALL.sha256)
    expect(otherType.dataUrl).not.toBe(SMALL.dataUrl)
    const refusal = `icons file: ${JSON.stringify(SMALL.sha256)} comes with two different data URLs`
    expect(() => assembleIcons([SMALL, otherType])).toThrow(refusal)
    expect(() => assembleIcons([otherType, SMALL])).toThrow(refusal)
  })

  it('refuses one key that names two icons, quoting the key', () => {
    const key = 'npm:odd"\nname@1.0.0:icon.png'
    const first = { ...MEDIUM, key }
    const second = { ...LARGE, key }
    expect(() => assembleIcons([first, second])).toThrow(`icons file: ${JSON.stringify(key)} names two different icons`)
  })
})

describe('assembleIcons: whatever order the icons arrive in', () => {
  const icons = [SMALL, SMALL_TWIN, MEDIUM, LARGE]

  /** Everything the pair answers, in one value, for the assertions below to compare. */
  const written = (order: readonly PublishedIcon[], budget?: number) => {
    const { file, withheldForSize } = assembleIcons(order, budget)
    return { file, withheldForSize, ...serializeIcons(file) }
  }

  it('writes the same bytes, under the same name', () => {
    const all = permutations(icons).map((order) => written(order))
    expect(all).toHaveLength(24)
    const [first] = all
    expect(first?.json.length).toBeGreaterThan(0)
    for (const each of all) {
      expect(each.json).toBe(first?.json)
      expect(each.sha256).toBe(first?.sha256)
      expect(each.fileName).toBe(first?.fileName)
      expect(each.file).toEqual(first?.file)
      expect(each.withheldForSize).toEqual(first?.withheldForSize)
    }
  })

  it('withholds the same icons under a budget that binds', () => {
    const budget = sizeOf(fileOf([SMALL, SMALL_TWIN, MEDIUM]))
    const all = permutations(icons).map((order) => written(order, budget))
    const [first] = all
    expect(first?.withheldForSize).toEqual([LARGE.key])
    for (const each of all) {
      expect(each.json).toBe(first?.json)
      expect(each.sha256).toBe(first?.sha256)
      expect(each.fileName).toBe(first?.fileName)
      expect(each.file).toEqual(first?.file)
      expect(each.withheldForSize).toEqual(first?.withheldForSize)
    }
  })

  it('writes no builtAt, so the name does not change from one day to the next', () => {
    expect(written(icons).json).not.toContain('builtAt')
  })
})

describe('assembleIcons: the budget', () => {
  it('withholds the largest of three where the budget holds exactly the two smallest', () => {
    const budget = sizeOf(fileOf([SMALL, MEDIUM]))
    const { file, withheldForSize } = assembleIcons([LARGE, SMALL, MEDIUM], budget)
    expect(withheldForSize).toEqual([LARGE.key])
    // In neither map: the icon is not carried, and no key points at it.
    expect(Object.keys(file.icons)).not.toContain(LARGE.sha256)
    expect(Object.values(file.sources)).not.toContain(LARGE.sha256)
    expect(Object.keys(file.sources)).not.toContain(LARGE.key)
    expect(file).toEqual(fileOf([SMALL, MEDIUM]))
    // The file is the budget to the byte: at most the budget includes the budget.
    expect(sizeOf(file)).toBe(budget)
  })

  it('withholds the second as well where the budget is one byte short of holding it', () => {
    const budget = sizeOf(fileOf([SMALL, MEDIUM])) - 1
    const { file, withheldForSize } = assembleIcons([LARGE, SMALL, MEDIUM], budget)
    expect(withheldForSize).toEqual([MEDIUM.key, LARGE.key].sort(compareStrings))
    expect(file).toEqual(fileOf([SMALL]))
    expect(sizeOf(file)).toBeLessThanOrEqual(budget)
  })

  it('admits all three where the budget holds the whole set to the byte, and withholds the largest one byte short', () => {
    const whole = sizeOf(fileOf([SMALL, MEDIUM, LARGE]))
    expect(assembleIcons([SMALL, MEDIUM, LARGE], whole)).toEqual({ file: fileOf([SMALL, MEDIUM, LARGE]), withheldForSize: [] })
    expect(assembleIcons([SMALL, MEDIUM, LARGE], whole - 1).withheldForSize).toEqual([LARGE.key])
  })

  it('withholds every key of a withheld icon, sorted by code unit, and carries none of them', () => {
    const budget = sizeOf(fileOf([SMALL, MEDIUM]))
    const { file, withheldForSize } = assembleIcons([LARGE, LARGE_TWIN, SMALL, MEDIUM], budget)
    expect(withheldForSize).toEqual([LARGE.key, LARGE_TWIN.key].sort(compareStrings))
    expect(Object.keys(file.sources)).not.toContain(LARGE.key)
    expect(Object.keys(file.sources)).not.toContain(LARGE_TWIN.key)
    expect(sizeOf(file)).toBeLessThanOrEqual(budget)
  })

  it('decides equal sizes by the sha256 and not by the key or the order they arrive in', () => {
    // Three icons of one size under keys of one length, so that the file with
    // any two of them is as large as with any other two. The key that sorts
    // first goes to the icon whose sha256 sorts last: ordered by key, the budget
    // would turn away another icon than it does ordered by sha256.
    const equal = [4, 5, 6].map((seed) => bytesOf(EIGHTH, seed))
    const shaOrder = equal.map(sha256Hex).sort(compareStrings)
    const tied = equal.map((bytes) => icon(keyOf(`tied-${shaOrder.length - 1 - shaOrder.indexOf(sha256Hex(bytes))}`), bytes))
    expect(new Set(tied.map((each) => each.dataUrl.length)).size).toBe(1)
    expect(new Set(tied.map((each) => each.key.length)).size).toBe(1)
    expect(new Set(tied.map((each) => each.sha256)).size).toBe(3)
    expect(tied.find((each) => each.sha256 === shaOrder[2])?.key).toBe(keyOf('tied-0'))

    const budget = sizeOf(fileOf(tied.slice(0, 2)))
    for (const order of permutations(tied)) {
      const { file, withheldForSize } = assembleIcons(order, budget)
      expect(withheldForSize).toEqual([keyOf('tied-0')])
      expect(Object.keys(file.icons).sort(compareStrings)).toEqual(shaOrder.slice(0, 2))
    }
  })

  it('stops at the first icon that does not fit, and withholds a later one that would have', () => {
    // LONG_KEYED comes before SHORT_KEYED, as it has the shorter data URL, but
    // its key is so much longer that the file with SHORT_KEYED and without it
    // is the smaller. A budget that fits that file still ends the admission at
    // LONG_KEYED: "the largest icons give way first" is what an author is told,
    // and skipping ahead would carry a larger icon in place of a smaller one.
    // SHORT_KEYED is one group of base64 longer: three bytes more.
    const BASE64_GROUP_BYTES = 3
    const longKeyed = icon(npmIconKey('long-keyed', '1.0.0', `${'assets/'.repeat(40)}icon.png`), bytesOf(QUARTER, 31))
    const shortKeyed = icon(keyOf('short-keyed'), bytesOf(QUARTER + BASE64_GROUP_BYTES, 32))
    expect(shortKeyed.dataUrl.length).toBeGreaterThan(longKeyed.dataUrl.length)
    expect(longKeyed.dataUrl.length).toBeGreaterThan(SMALL.dataUrl.length)
    const budget = sizeOf(fileOf([SMALL, shortKeyed]))
    expect(sizeOf(fileOf([SMALL, longKeyed]))).toBeGreaterThan(budget)

    const { file, withheldForSize } = assembleIcons([shortKeyed, SMALL, longKeyed], budget)
    expect(file).toEqual(fileOf([SMALL]))
    expect(withheldForSize).toEqual([longKeyed.key, shortKeyed.key].sort(compareStrings))
  })

  it('withholds every icon where the budget holds the empty file and no more', () => {
    const budget = sizeOf({ icons: {}, sources: {} })
    expect(assembleIcons([SMALL, MEDIUM], budget)).toEqual({
      file: { icons: {}, sources: {} },
      withheldForSize: [SMALL.key, MEDIUM.key].sort(compareStrings),
    })
  })

  it('admits nothing, and does not throw, where not even the empty file fits', () => {
    const emptyFile = sizeOf({ icons: {}, sources: {} })
    for (const budget of [emptyFile - 1, 0, -1, Number.NaN]) {
      expect(assembleIcons([SMALL, MEDIUM], budget)).toEqual({
        file: { icons: {}, sources: {} },
        withheldForSize: [SMALL.key, MEDIUM.key].sort(compareStrings),
      })
    }
  })

  describe('the longest prefix of the order that fits', () => {
    // A set made to be awkward: equal sizes, one icon under two keys, a key past
    // ASCII and one that JSON escapes, so that the size of a file is not any
    // simple sum of what is in it. `UNIT` is a sixty-fourth of an icon.
    const UNIT = MAX_CATALOG_ICON_BYTES / 64
    const MIXED = [
      icon(keyOf('a'), bytesOf(UNIT, 11)),
      icon(keyOf('b'), bytesOf(UNIT, 12)),
      icon(keyOf('c'), bytesOf(2 * UNIT, 13)),
      icon(keyOf('c-twin'), bytesOf(2 * UNIT, 13)),
      icon(npmIconKey('d', '1.0.0', '图标/icon.png'), bytesOf(3 * UNIT, 14)),
      icon(npmIconKey('e', '1.0.0', 'a"b\nc\\d.png'), bytesOf(3 * UNIT, 15)),
      icon(githubIconKey('owner/repo', 'f'.repeat(40), 'packages/p/icon.png'), bytesOf(5 * UNIT, 16)),
      icon(releaseIconKey('9'.repeat(64), 'icon.png'), bytesOf(8 * UNIT, 17)),
    ]

    it('has the awkward shapes it claims', () => {
      expect(MIXED[2]?.sha256).toBe(MIXED[3]?.sha256)
      expect(new Set(MIXED.map((each) => each.sha256)).size).toBe(MIXED.length - 1)
      // Two pairs of one size: the order inside each is the sha256's.
      expect(MIXED[0]?.dataUrl.length).toBe(MIXED[1]?.dataUrl.length)
      expect(MIXED[4]?.dataUrl.length).toBe(MIXED[5]?.dataUrl.length)
      // Bytes and characters part ways, which is what a budget in bytes counts,
      // and JSON writes a key that holds a quote or a newline longer than it is.
      const written = serializeIcons(fileOf(MIXED)).json
      expect(Buffer.byteLength(written)).toBeGreaterThan(written.length)
      expect(JSON.stringify(MIXED[5]?.key)).not.toBe(`"${MIXED[5]?.key}"`)
    })

    // Every set from the first icon to all of them, so the search meets every
    // length of order; and for each, every budget that one of its prefixes is
    // exactly, and one byte short of that.
    const cases = MIXED.flatMap((_, index) => {
      const held = index + 1
      return Array.from({ length: admissionOrder(MIXED.slice(0, held)).length + 1 }, (__, count): [number, number] => [held, count])
    })

    // Each set arrives as it is listed and reversed, so that a pair of one size
    // cannot be put right by the order it came in: one of the two orders is the
    // wrong one for it.
    const arrivals = (icons: readonly PublishedIcon[]): PublishedIcon[][] => [[...icons], [...icons].reverse()]

    it.each(cases)('of the first %i icons: a budget for the first %i of the order admits them and no more', (held, count) => {
      const icons = MIXED.slice(0, held)
      const admitted = firstIcons(icons, count)
      const budget = sizeOf(fileOf(admitted))
      for (const arrival of arrivals(icons)) {
        const { file, withheldForSize } = assembleIcons(arrival, budget)
        expect(file).toEqual(fileOf(admitted))
        expect(sizeOf(file)).toBeLessThanOrEqual(budget)
        expect(withheldForSize).toEqual(icons.filter((each) => !admitted.includes(each)).map((each) => each.key).sort(compareStrings))
      }
    })

    it.each(cases.filter(([, count]) => count > 0))('of the first %i icons: one byte short of the first %i of the order, the last of them is withheld too', (held, count) => {
      const icons = MIXED.slice(0, held)
      const budget = sizeOf(fileOf(firstIcons(icons, count))) - 1
      for (const arrival of arrivals(icons)) {
        const { file } = assembleIcons(arrival, budget)
        expect(file).toEqual(fileOf(firstIcons(icons, count - 1)))
        expect(sizeOf(file)).toBeLessThanOrEqual(budget)
      }
    })
  })

  // This one builds and serialises a file of the budget's own size a dozen times
  // over, which takes well under a second here; the timeout is room for a slow
  // runner, and is no figure the test depends on.
  it('keeps the file within ICONS_FILE_BUDGET_BYTES when no budget is given', { timeout: 60_000 }, () => {
    // Icons as large as the catalog carries, and more of them than the budget
    // holds: the count comes from the constants, and each icon is its own bytes.
    const sample = icon(keyOf('sample'), bytesOf(MAX_CATALOG_ICON_BYTES, 0))
    const count = Math.ceil(ICONS_FILE_BUDGET_BYTES / sample.dataUrl.length) + 8
    const icons = Array.from({ length: count }, (_, seed) => icon(keyOf(`big-${seed}`), bytesOf(MAX_CATALOG_ICON_BYTES, seed)))
    expect(sizeOf(fileOf(icons))).toBeGreaterThan(ICONS_FILE_BUDGET_BYTES)

    const { file, withheldForSize } = assembleIcons(icons)
    const admitted = Object.keys(file.icons).length
    expect(withheldForSize.length).toBeGreaterThan(0)
    expect(admitted + withheldForSize.length).toBe(count)
    // The longest prefix: this one is within the budget, and one more is not.
    expect(sizeOf(file)).toBeLessThanOrEqual(ICONS_FILE_BUDGET_BYTES)
    expect(sizeOf(fileOf(firstIcons(icons, admitted + 1)))).toBeGreaterThan(ICONS_FILE_BUDGET_BYTES)
    expect(file).toEqual(fileOf(firstIcons(icons, admitted)))
  })
})

describe('ICONS_FILE_BUDGET_BYTES', () => {
  // `iconDetail` sits below this module and cannot import the constant, so it
  // writes the budget out in the sentence an author reads. If the constant moves
  // and the copy does not, an author is told a budget the build does not apply;
  // this is what makes one change drag the other.
  it('is the figure iconDetail.withheldForSize tells an author', () => {
    const mib = ICONS_FILE_BUDGET_BYTES / (1024 * 1024)
    expect(iconDetail.withheldForSize()).toContain(`reached its ${mib} MiB budget`)
  })
})

describe('serializeIcons', () => {
  it('writes two-space JSON, icons ahead of sources, and ends in one newline', () => {
    const { json } = serializeIcons(fileOf([SMALL]))
    expect(json).toBe([
      '{',
      '  "icons": {',
      `    ${JSON.stringify(SMALL.sha256)}: ${JSON.stringify(SMALL.dataUrl)}`,
      '  },',
      '  "sources": {',
      `    ${JSON.stringify(SMALL.key)}: ${JSON.stringify(SMALL.sha256)}`,
      '  }',
      '}',
      '',
    ].join('\n'))
  })

  it('writes the empty file as two empty maps', () => {
    expect(serializeIcons({ icons: {}, sources: {} }).json).toBe('{\n  "icons": {},\n  "sources": {}\n}\n')
  })

  it('sorts both maps by code unit, hashes the exact bytes, and names the file after them', () => {
    // 'Z' (U+005A) sorts before 'a' (U+0061) here and after it in almost every
    // locale, and npm still serves names with capitals. Both maps are given in
    // the reverse of the order they must be written in.
    const upper = icon(npmIconKey('Zeta', '1.0.0', 'icon.png'), bytesOf(EIGHTH, 21))
    const lower = icon(npmIconKey('alpha', '1.0.0', 'icon.png'), bytesOf(EIGHTH, 22))
    const descendingByKey = [upper, lower].sort((a, b) => compareStrings(b.key, a.key))
    const descendingBySha = [upper, lower].sort((a, b) => compareStrings(b.sha256, a.sha256))
    const unsorted: IconsFile = { icons: fileOf(descendingBySha).icons, sources: fileOf(descendingByKey).sources }
    expect(Object.keys(unsorted.sources)).toEqual([lower.key, upper.key])

    const { json, sha256, fileName } = serializeIcons(unsorted)
    const written = JSON.parse(json) as IconsFile
    expect(Object.keys(written.sources)).toEqual([upper.key, lower.key])
    expect(Object.keys(written.icons)).toEqual([upper.sha256, lower.sha256].sort(compareStrings))
    expect(sha256).toBe(createHash('sha256').update(json).digest('hex'))
    expect(fileName).toBe(`icons.${sha256}.json`)
  })

  it('writes the same bytes for the same icons, whatever order the maps were built in', () => {
    const forward = serializeIcons(fileOf([SMALL, MEDIUM, LARGE]))
    const backward = serializeIcons(fileOf([LARGE, MEDIUM, SMALL]))
    expect(backward.json).toBe(forward.json)
    expect(backward.sha256).toBe(forward.sha256)
    expect(backward.fileName).toBe(forward.fileName)
  })

  it('names a different file for different bytes', () => {
    expect(serializeIcons(fileOf([SMALL])).fileName).not.toBe(serializeIcons(fileOf([SMALL, MEDIUM])).fileName)
  })

  it('keeps a key named __proto__, which assigning into a plain object would lose', () => {
    // The keys of `sources` are opaque, so a file that was edited by hand may
    // hold this one. An assignment `sources['__proto__'] = sha` sets the
    // prototype, and the entry is gone from the text.
    const file: IconsFile = { icons: { [SHA]: DATA_URL }, sources: Object.fromEntries([['__proto__', SHA]]) }
    const { json } = serializeIcons(file)
    expect(Object.hasOwn((JSON.parse(json) as IconsFile).sources, '__proto__')).toBe(true)
    expect(Object.entries(parseIconsFile(json)?.sources ?? {})).toEqual([['__proto__', SHA]])
  })
})

describe('parseIconsFile', () => {
  const written = (icons: readonly PublishedIcon[]): string => serializeIcons(assembleIcons(icons).file).json

  it('reads back, equal to the file, what serializeIcons wrote', () => {
    const { file } = assembleIcons([SMALL, SMALL_TWIN, MEDIUM, LARGE])
    expect(parseIconsFile(serializeIcons(file).json)).toEqual(file)
  })

  it('reads back a data URL of each of the media types', () => {
    const everyType = oneOfEachType()
    expect(parseIconsFile(written(everyType))).toEqual(fileOf(everyType))
  })

  it('reads the empty file', () => {
    expect(parseIconsFile(written([]))).toEqual({ icons: {}, sources: {} })
  })

  it('reads the file the budget cut, as the file it is', () => {
    const budget = sizeOf(fileOf([SMALL, MEDIUM]))
    const { file } = assembleIcons([SMALL, MEDIUM, LARGE], budget)
    expect(parseIconsFile(serializeIcons(file).json)).toEqual(fileOf([SMALL, MEDIUM]))
  })

  it('writes, for a file it has read, the same bytes again, so that reusing yesterday\'s icons does not rename the file', () => {
    const first = serializeIcons(assembleIcons([SMALL, SMALL_TWIN, MEDIUM, LARGE]).file)
    const parsed = parseIconsFile(first.json)
    expect(parsed).not.toBeNull()
    expect(serializeIcons(parsed ?? { icons: {}, sources: {} })).toEqual(first)
  })

  it('does not check the keys of sources, which are icon keys and opaque', () => {
    const odd = { icons: { [SHA]: DATA_URL }, sources: { 'not a key the build would make': SHA } }
    expect(parseIconsFile(JSON.stringify(odd))).toEqual(odd)
  })

  it('reads an icon that no source names, which is no malformation', () => {
    const unreferenced = { icons: { [SHA]: DATA_URL }, sources: {} }
    expect(parseIconsFile(JSON.stringify(unreferenced))).toEqual(unreferenced)
  })

  it('reads a key named __proto__ as a key', () => {
    // `JSON.parse` makes it an own property, and the file it returns keeps it as one.
    const parsed = parseIconsFile(`{"icons":{"${SHA}":"${DATA_URL}"},"sources":{"__proto__":"${SHA}"}}`)
    expect(Object.entries(parsed?.sources ?? {})).toEqual([['__proto__', SHA]])
    expect(Object.getPrototypeOf(parsed?.sources)).toBe(Object.prototype)
  })

  const textOf = (icons: unknown, sources: unknown): string => JSON.stringify({ icons, sources })
  const KEY = keyOf('x')

  it.each<[what: string, text: string]>([
    ['text that is not JSON', 'not json'],
    ['an empty text', ''],
    ['text cut short', `{"icons":{"${SHA}":"${DATA_URL}"},"sour`],
    ['a JSON array', '[]'],
    ['JSON null', 'null'],
    ['a JSON string', '"icons"'],
    ['a JSON number', '1'],
    ['an object with no keys', '{}'],
    ['a file with no sources', JSON.stringify({ icons: { [SHA]: DATA_URL } })],
    ['a file with no icons', JSON.stringify({ sources: {} })],
    ['a file with a third key', JSON.stringify({ icons: {}, sources: {}, builtAt: '2026-10-23T00:00:00.000Z' })],
    ['icons that is an array', textOf([], {})],
    ['icons that is null', textOf(null, {})],
    ['icons that is a string', textOf(DATA_URL, {})],
    ['sources that is an array', textOf({}, [])],
    ['sources that is null', textOf({}, null)],
    ['sources that is a string', textOf({}, SHA)],
    ['an icon under a key of one digit fewer than a sha256', textOf({ [SHA.slice(1)]: DATA_URL }, {})],
    ['an icon under a key of one digit more than a sha256', textOf({ [`${SHA}a`]: DATA_URL }, {})],
    ['an icon under a key that is not hexadecimal', textOf({ ['g'.repeat(SHA.length)]: DATA_URL }, {})],
    ['an icon under a key in upper-case hexadecimal', textOf({ [SHA.toUpperCase()]: DATA_URL }, {})],
    ['an icon under a key that is a name', textOf({ 'not-a-sha': DATA_URL }, {})],
    ['an icon that is not a string', textOf({ [SHA]: 1 }, {})],
    ['an icon that is null', textOf({ [SHA]: null }, {})],
    ['an icon that is javascript:alert(1)', textOf({ [SHA]: 'javascript:alert(1)' }, {})],
    ['an icon that is a data URL of text/html', textOf({ [SHA]: 'data:text/html;base64,PGh0bWw+' }, {})],
    ['an icon that is a data URL of SVG text and not base64', textOf({ [SHA]: 'data:image/svg+xml;utf8,<svg/>' }, {})],
    ['an icon that is a data URL with no payload', textOf({ [SHA]: 'data:image/png;base64,' }, {})],
    ['an icon that is a web address', textOf({ [SHA]: 'https://example.com/icon.png' }, {})],
    ['a source that names a sha256 icons does not hold', textOf({ [SHA]: DATA_URL }, { [KEY]: OTHER_SHA })],
    ['a source that names an icon in the wrong case', textOf({ [SHA]: DATA_URL }, { [KEY]: SHA.toUpperCase() })],
    ['a source that is not a string', textOf({ [SHA]: DATA_URL }, { [KEY]: 1 })],
    ['a source that is null', textOf({ [SHA]: DATA_URL }, { [KEY]: null })],
    ['a source that names a member of Object.prototype and no icon', textOf({ [SHA]: DATA_URL }, { [KEY]: 'constructor' })],
    ['a source that names the prototype accessor and no icon', textOf({ [SHA]: DATA_URL }, { [KEY]: '__proto__' })],
  ])('returns null for %s', (_what, text) => {
    expect(parseIconsFile(text)).toBeNull()
  })

  it('returns null, and does not throw, for text nested a hundred thousand deep', () => {
    expect(parseIconsFile('['.repeat(100_000))).toBeNull()
    expect(parseIconsFile(`${'['.repeat(100_000)}${']'.repeat(100_000)}`)).toBeNull()
  })
})

describe('isIconDataUrl', () => {
  // The grammar is `data:`, an icon media type, `;base64,`, then at least one
  // character of the standard base64 alphabet and at most two `=`. It is the
  // one grammar the icons file is read by: a file that holds anything else is
  // refused, so that no other kind of URL can reach an image's `src`.
  it.each(Object.keys(ICON_MEDIA_TYPES))('accepts %s, a type of the table of media types', (mediaType) => {
    expect(isIconDataUrl(`data:${mediaType};base64,AAAA`)).toBe(true)
  })

  it.each<[what: string, value: string]>([
    ['a payload of one character', 'data:image/png;base64,A'],
    ['a payload of a group of four', 'data:image/png;base64,AAAA'],
    ['a payload padded with one =', 'data:image/png;base64,AAA='],
    ['a payload padded with two =', 'data:image/png;base64,AA=='],
    ['every character of the standard alphabet', 'data:image/png;base64,ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'],
    ['a payload that a real icon makes', iconDataUrl(bytesOf(EIGHTH, 41), 'image/webp')],
  ])('accepts %s', (_what, value) => {
    expect(isIconDataUrl(value)).toBe(true)
  })

  it.each<[what: string, value: string]>([
    ['the empty string', ''],
    ['javascript:alert(1)', 'javascript:alert(1)'],
    ['a data URL of text/html', 'data:text/html;base64,PGh0bWw+'],
    ['a data URL of an image type that is not an icon type', 'data:image/gif;base64,AAAA'],
    ['a data URL of image/svg, which is not the SVG type', 'data:image/svg;base64,AAAA'],
    ['a data URL with no media type', 'data:;base64,AAAA'],
    ['a data URL that is not base64', 'data:image/png,AAAA'],
    ['an SVG data URL that is text', 'data:image/svg+xml;utf8,<svg/>'],
    ['a data URL with a parameter before base64', 'data:image/png;charset=utf-8;base64,AAAA'],
    ['a data URL with no payload', 'data:image/png;base64,'],
    ['a data URL with three =', 'data:image/png;base64,AAAA==='],
    ['a data URL with = inside the payload', 'data:image/png;base64,AA=A'],
    ['a data URL that starts its payload with =', 'data:image/png;base64,=AAA'],
    ['a payload in the URL-safe alphabet', 'data:image/png;base64,AA-_'],
    ['a payload with a space', 'data:image/png;base64,AA AA'],
    ['a payload with a newline at the end', 'data:image/png;base64,AAAA\n'],
    ['a payload with a letter past ASCII', 'data:image/png;base64,AAé='],
    ['a payload with a second data URL after it', 'data:image/png;base64,AAAA;base64,AAAA'],
    ['a payload with a fragment', 'data:image/png;base64,AAAA#x'],
    ['a scheme in capitals', 'DATA:image/png;base64,AAAA'],
    ['a media type in capitals', 'data:image/PNG;base64,AAAA'],
    ['a base64 marker in capitals', 'data:image/png;BASE64,AAAA'],
    ['a URL with something ahead of it', ' data:image/png;base64,AAAA'],
    ['a web address', 'https://example.com/icon.png'],
  ])('rejects %s', (_what, value) => {
    expect(isIconDataUrl(value)).toBe(false)
  })

  it('rejects a media type of the table with something added to its name', () => {
    for (const mediaType of Object.keys(ICON_MEDIA_TYPES)) {
      expect(isIconDataUrl(`data:${mediaType}x;base64,AAAA`)).toBe(false)
      expect(isIconDataUrl(`data:x${mediaType};base64,AAAA`)).toBe(false)
    }
  })

  it('rejects the members of Object.prototype as media types', () => {
    for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      expect(isIconDataUrl(`data:${name};base64,AAAA`)).toBe(false)
    }
  })
})
