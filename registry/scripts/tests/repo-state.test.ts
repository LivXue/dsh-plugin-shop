import { describe, expect, it } from 'vitest'
import { diffRepoState, nextRepoState, parseRepoState, serializeRepoState } from '../src/repo-state.ts'
import type { RepoCandidate } from '../src/types.ts'

const commit = 'a'.repeat(40)

function candidate(repo: string): RepoCandidate {
  return {
    name: repo.split('/')[1] ?? repo,
    repo,
    commit,
    version: commit,
    publishedAt: null,
    repository: `https://github.com/${repo}`,
    license: 'MIT',
    hasBundle: true,
    requiresBuild: false,
    catalog: null,
    description: 'x',
  }
}

const state = {
  'a/one': { pushedAt: '2026-08-01T00:00:00Z', commit, candidate: candidate('a/one') },
  'b/two': { pushedAt: '2026-08-01T00:00:00Z', commit, candidate: candidate('b/two') },
}

describe('repo-state', () => {
  it('round-trips through serialization with sorted keys', () => {
    const text = serializeRepoState({ 'b/two': state['b/two']!, 'a/one': state['a/one']! })
    expect(text.indexOf('"a/one"')).toBeLessThan(text.indexOf('"b/two"'))
    expect(parseRepoState(text)).toEqual(state)
  })

  it('throws on a malformed file rather than dropping the harvest memory', () => {
    expect(() => parseRepoState('[]')).toThrow()
    expect(() => parseRepoState('{"a/one": {"pushedAt": "x"}}')).toThrow()
  })

  it('diff: new repos and pushed_at changes fetch; unseen recorded repos go', () => {
    const { toFetch, gone } = diffRepoState(state, [
      { repo: 'a/one', pushedAt: '2026-08-02T00:00:00Z' }, // changed
      { repo: 'b/two', pushedAt: '2026-08-01T00:00:00Z' }, // unchanged
      { repo: 'c/three', pushedAt: '2026-08-02T00:00:00Z' }, // new
    ])
    expect(toFetch.map(e => e.repo)).toEqual(['a/one', 'c/three'])
    expect(gone).toEqual([])
  })

  it('diff: recorded repos absent from the search are gone', () => {
    const { toFetch, gone } = diffRepoState(state, [{ repo: 'a/one', pushedAt: '2026-08-01T00:00:00Z' }])
    expect(toFetch).toEqual([])
    expect(gone).toEqual(['b/two'])
  })

  it('next: fresh candidates replace, untouched carry over, deferred never-fetched stay out', () => {
    const fresh = new Map([['c/three', candidate('c/three')]])
    const next = nextRepoState(state, [
      { repo: 'a/one', pushedAt: '2026-08-01T00:00:00Z' },
      { repo: 'b/two', pushedAt: '2026-08-01T00:00:00Z' },
      { repo: 'c/three', pushedAt: '2026-08-02T00:00:00Z' },
      { repo: 'd/four', pushedAt: '2026-08-02T00:00:00Z' }, // deferred, never fetched
    ], fresh)
    expect(Object.keys(next).sort()).toEqual(['a/one', 'b/two', 'c/three'])
    expect(next['c/three']?.candidate.repo).toBe('c/three')
    expect(next['a/one']?.candidate.repo).toBe('a/one')
  })
})
