import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { assembleStarsForEntries, serializeStars } from '../src/stars-assemble.ts'
import type { Entry } from '../src/types.ts'

function npmEntry(name: string, repository: string): Entry {
  return {
    name, version: '1.0.0', integrity: `sha512-${name}`, publishedAt: '2026-08-01T12:00:00.000Z',
    repository, license: 'MIT', tier: 'community', metadata: 'declared',
    catalog: { category: 'tool', summary: { en: 'x', zh: 'y' }, capabilities: [] },
    source: 'npm', added: '2026-08-01',
  }
}

function repoEntry(repo: string, subdir?: string): Entry {
  return {
    ...npmEntry(repo.split('/')[1] ?? repo, `https://github.com/${repo}`),
    source: 'github',
    repo,
    ...(subdir === undefined ? {} : { subdir }),
  }
}

describe('assembleStarsForEntries', () => {
  it('prefers the search count, keys npm entries by package name and github entries by repo', () => {
    const assembled = assembleStarsForEntries(
      [npmEntry('pkg-a', 'https://github.com/o/a'), npmEntry('pkg-b', 'https://github.com/o/not-seen'), repoEntry('o/a')],
      new Map([['o/a', 42]]),
      new Map([['o/a', 99], ['o/not-seen', 7]]),
    )
    // A search-derived count rides a response the harvest already paid for and
    // is exactly as fresh as the build, so it beats the GraphQL 99.
    expect(assembled.stars).toEqual({ 'pkg-a': 42, 'o/a': 42, 'pkg-b': 7 })
    expect(assembled.fromSearch).toBe(2)
    expect(assembled.fromGraphql).toBe(1)
  })

  it('keeps a zero search count — zero is a real star count', () => {
    const assembled = assembleStarsForEntries(
      [npmEntry('pkg-a', 'https://github.com/o/a')],
      new Map([['o/a', 0]]),
      new Map([['o/a', 5]]),
    )
    expect(assembled.stars).toEqual({ 'pkg-a': 0 })
    expect(assembled.fromSearch).toBe(1)
  })

  it('drops entries with no count from either source, and non-github repository urls', () => {
    const assembled = assembleStarsForEntries(
      [npmEntry('pkg-a', 'https://gitlab.com/o/a'), npmEntry('pkg-b', 'https://github.com/o/missing')],
      new Map(),
      new Map(),
    )
    expect(assembled.stars).toEqual({})
    expect(assembled.fromSearch).toBe(0)
    expect(assembled.fromGraphql).toBe(0)
  })

  it('never attributes the harness own stars to an npm entry claiming it as its repository', () => {
    const assembled = assembleStarsForEntries(
      [npmEntry('pkg-mos', 'https://github.com/deepseek-ai/deepseek-harness')],
      new Map([['deepseek-ai/deepseek-harness', 205302]]),
      new Map(),
    )
    expect(assembled.stars).toEqual({})
    expect(assembled.fromSearch).toBe(0)
  })

  it('keeps the count for a repo entry that is the harness itself', () => {
    // The skip is for misdeclared npm repositories; a github entry keyed by
    // the harness's own full name carries its own, factually correct count.
    const assembled = assembleStarsForEntries(
      [repoEntry('deepseek-ai/deepseek-harness')],
      new Map([['deepseek-ai/deepseek-harness', 205302]]),
      new Map(),
    )
    expect(assembled.stars).toEqual({ 'deepseek-ai/deepseek-harness': 205302 })
    expect(assembled.fromSearch).toBe(1)
  })

  it('counts each KEY once when a monorepo contributes several entries', () => {
    // Measured against the old assembleStarsByKey: three plugin subpackages of
    // one repo produced one key and a tally of three, so the build note read
    // "1 starred (3 from the search, 0 from GraphQL)" — a line whose own
    // numbers contradict each other. The subpackages share a repository, and
    // the repository has one star count.
    const assembled = assembleStarsForEntries(
      [repoEntry('o/mono', 'packages/a'), repoEntry('o/mono', 'packages/b'), repoEntry('o/mono', 'packages/c')],
      new Map([['o/mono', 7]]),
      new Map(),
    )
    expect(assembled.stars).toEqual({ 'o/mono': 7 })
    expect(Object.keys(assembled.stars).length).toBe(assembled.fromSearch + assembled.fromGraphql)
  })

  it('takes ENTRIES, so a candidate the gate rejected cannot reach the sidecar', () => {
    // The whole point of the signature. The sidecar used to be keyed by the
    // harvest: every candidate got a row whether or not it was ever published,
    // and every reader downloaded them. There is no way to express a rejected
    // candidate here any more — the type only admits entries.
    const assembled = assembleStarsForEntries(
      [npmEntry('listed', 'https://github.com/o/listed')],
      new Map([['o/listed', 3], ['o/rejected', 999]]),
      new Map(),
    )
    expect(assembled.stars).toEqual({ listed: 3 })
  })
})

describe('serializeStars', () => {
  it('sorts by code unit, hashes the exact bytes, and names the file after them', () => {
    // Four lines of policy that lived in build.ts with no test: the sort, the
    // Object.fromEntries, the sha256 and the file name. The sort is what keeps
    // the content hash stable across two builds that assembled the same counts
    // in a different order.
    const out = serializeStars({ stars: { b: 2, A: 1, a: 3 }, fromSearch: 3, fromGraphql: 0 })
    // Code-unit order, not dictionary order: 'A' (0x41) before 'a' (0x61).
    expect(Object.keys(JSON.parse(out.json).stars)).toEqual(['A', 'a', 'b'])
    expect(out.json.endsWith('\n')).toBe(true)
    expect(out.sha256).toBe(createHash('sha256').update(out.json).digest('hex'))
    expect(out.fileName).toBe(`stars.${out.sha256}.json`)
  })

  it('is order-independent: the same counts assembled in any order hash alike', () => {
    const one = serializeStars({ stars: { a: 1, b: 2 }, fromSearch: 2, fromGraphql: 0 })
    const two = serializeStars({ stars: { b: 2, a: 1 }, fromSearch: 2, fromGraphql: 0 })
    expect(one.sha256).toBe(two.sha256)
  })
})
