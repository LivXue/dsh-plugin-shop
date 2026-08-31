import { describe, expect, it } from 'vitest'
import { assembleStarsByKey } from '../src/stars-assemble.ts'
import type { Candidate, RepoCandidate } from '../src/types.ts'

const npm = (name: string, repository: string | null): Candidate => ({
  name,
  version: '1.0.0',
  integrity: null,
  publishedAt: null,
  repository,
  license: 'MIT',
  deprecated: false,
  hasBundle: true,
  catalog: null,
  description: null,
  keywords: [],
})

const repo = (repo: string): RepoCandidate => ({
  name: repo.split('/')[1] ?? repo,
  repo,
  commit: 'b'.repeat(40),
  version: 'b'.repeat(40),
  publishedAt: null,
  repository: `https://github.com/${repo}`,
  license: 'MIT',
  hasBundle: true,
  requiresBuild: false,
  hasWorkspaceDeps: false,
  catalog: null,
  description: 'x',
})

describe('assembleStarsByKey', () => {
  it('prefers the search count, keys npm entries by package name and github entries by repo', () => {
    const assembled = assembleStarsByKey(
      [npm('pkg-a', 'https://github.com/o/a'), npm('pkg-b', 'https://github.com/o/not-seen')],
      [repo('o/a')],
      new Map([['o/a', 42]]),
      new Map([['o/a', 99], ['o/not-seen', 7]]),
    )
    expect(assembled.stars).toEqual({ 'pkg-a': 42, 'o/a': 42, 'pkg-b': 7 })
    expect(assembled.fromSearch).toBe(2)
    expect(assembled.fromGraphql).toBe(1)
  })

  it('keeps a zero search count — zero is a real star count', () => {
    const assembled = assembleStarsByKey(
      [npm('pkg-a', 'https://github.com/o/a')],
      [],
      new Map([['o/a', 0]]),
      new Map([['o/a', 5]]),
    )
    expect(assembled.stars).toEqual({ 'pkg-a': 0 })
    expect(assembled.fromSearch).toBe(1)
  })

  it('drops entries with no count from either source, and non-github repository urls', () => {
    const assembled = assembleStarsByKey(
      [npm('pkg-a', 'https://gitlab.com/o/a'), npm('pkg-b', 'https://github.com/o/missing')],
      [],
      new Map(),
      new Map(),
    )
    expect(assembled.stars).toEqual({})
    expect(assembled.fromSearch).toBe(0)
    expect(assembled.fromGraphql).toBe(0)
  })

  it('never attributes the harness own stars to an npm entry claiming it as its repository', () => {
    const assembled = assembleStarsByKey(
      [npm('pkg-mos', 'https://github.com/deepseek-ai/deepseek-harness')],
      [],
      new Map([['deepseek-ai/deepseek-harness', 205302]]),
      new Map(),
    )
    expect(assembled.stars).toEqual({})
    expect(assembled.fromSearch).toBe(0)
    expect(assembled.fromGraphql).toBe(0)
  })

  it('keeps the count for a repo entry that is the harness itself', () => {
    // The skip is for misdeclared npm repositories; a github entry keyed by
    // the harness's own full name carries its own, factually correct count.
    const assembled = assembleStarsByKey(
      [],
      [repo('deepseek-ai/deepseek-harness')],
      new Map([['deepseek-ai/deepseek-harness', 205302]]),
      new Map(),
    )
    expect(assembled.stars).toEqual({ 'deepseek-ai/deepseek-harness': 205302 })
    expect(assembled.fromSearch).toBe(1)
  })
})
