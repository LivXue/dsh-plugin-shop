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
    hasWorkspaceDeps: false,
    catalog: null,
    description: 'x',
  }
}

const state = {
  'a/one': { pushedAt: '2026-08-01T00:00:00Z', commit, candidates: [candidate('a/one')] },
  'b/two': { pushedAt: '2026-08-01T00:00:00Z', commit, candidates: [candidate('b/two')] },
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
    const fresh = new Map([['c/three', { candidates: [candidate('c/three')] }]])
    const next = nextRepoState(state, [
      { repo: 'a/one', pushedAt: '2026-08-01T00:00:00Z' },
      { repo: 'b/two', pushedAt: '2026-08-01T00:00:00Z' },
      { repo: 'c/three', pushedAt: '2026-08-02T00:00:00Z' },
      { repo: 'd/four', pushedAt: '2026-08-02T00:00:00Z' }, // deferred, never fetched
    ], fresh)
    expect(Object.keys(next).sort()).toEqual(['a/one', 'b/two', 'c/three'])
    expect(next['c/three']?.candidates[0]?.repo).toBe('c/three')
    expect(next['a/one']?.candidates[0]?.repo).toBe('a/one')
  })
})

describe('state shape evolution', () => {
  it('parses the pre-subpackage shape (candidate, singular) and reserializes as candidates', () => {
    const legacy = JSON.stringify({
      'a/one': { pushedAt: '2026-08-01T00:00:00Z', commit, candidate: candidate('a/one') },
    })
    const parsed = parseRepoState(legacy)
    expect(parsed['a/one']?.candidates[0]?.repo).toBe('a/one')
    const text = serializeRepoState(parsed)
    expect(text).toContain('"candidates"')
    expect(text).not.toContain('"candidate"')
  })

  it('round-trips a recorded deterministic failure', () => {
    const withFailure = {
      'x/dead': {
        pushedAt: '2026-08-01T00:00:00Z',
        commit: '',
        candidates: [],
        failure: { code: 'no-manifest' as const, detail: 'No package.json at the repository root, so there is nothing for dsh to install.' },
      },
    }
    expect(parseRepoState(serializeRepoState(withFailure))).toEqual(withFailure)
  })

  it('throws on a malformed failure record', () => {
    const bad = JSON.stringify({
      'x/dead': { pushedAt: '2026-08-01T00:00:00Z', commit: '', candidates: [], failure: { code: 'nonsense', detail: 'x' } },
    })
    expect(() => parseRepoState(bad)).toThrow(/malformed failure/)
  })

  it('records a fresh deterministic failure for a never-fetched repo', () => {
    const next = nextRepoState({}, [{ repo: 'x/dead', pushedAt: '2026-08-01T00:00:00Z' }], new Map([
      ['x/dead', { candidates: [], failure: { code: 'no-manifest', detail: 'gone' } }],
    ]))
    expect(next['x/dead']?.failure).toEqual({ code: 'no-manifest', detail: 'gone' })
    expect(next['x/dead']?.candidates).toEqual([])
  })
})
