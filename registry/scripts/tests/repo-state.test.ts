import { describe, expect, it } from 'vitest'
import { diffRepoState, nextRepoState, parseRepoState, repoGoneDetail, serializeRepoState, staleFailureRepos } from '../src/repo-state.ts'
import type { RepoState, RepoStateEntry } from '../src/repo-state.ts'
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

describe('persisted subpackage failures', () => {
  const base = { pushedAt: '2026-08-02T00:00:00Z', commit: 'a'.repeat(40), candidates: [] }

  it('rejects an empty array, a shape nextRepoState never writes', () => {
    // nextRepoState only sets the key when there is at least one row, so
    // `subpackageFailures: []` in a committed file did not come from this
    // build. A malformed registry file throws rather than being normalized.
    const text = JSON.stringify({ 'a/b': { ...base, subpackageFailures: [] } })
    expect(() => parseRepoState(text)).toThrow('malformed subpackageFailures')
  })

  it('rejects a row with an unknown code or a missing field', () => {
    for (const row of [
      { repo: 'a/b#p', code: 'exploded', detail: 'x' },
      { repo: 'a/b#p', code: 'no-manifest' },
      { repo: 'a/b#p', detail: 'x' },
      { code: 'no-manifest', detail: 'x' },
      null,
      'a string',
    ]) {
      const text = JSON.stringify({ 'a/b': { ...base, subpackageFailures: [row] } })
      expect(() => parseRepoState(text), JSON.stringify(row)).toThrow('malformed subpackageFailures')
    }
  })

  it('omits the key entirely when there are no rows', () => {
    // The writer's side of the same rule, so the two cannot drift apart.
    const next = nextRepoState({}, [{ repo: 'a/b', pushedAt: base.pushedAt }],
      new Map([['a/b', { candidates: [], subpackageFailures: [] }]]))
    expect(Object.keys(next['a/b'] ?? {})).not.toContain('subpackageFailures')
  })
})

describe('staleFailureRepos', () => {
  const mislabelled = 'No package.json at the repository root, so there is nothing for dsh to install.'
  const failing = (code: 'no-manifest' | 'fetch-failed', detail: string): RepoStateEntry => ({
    pushedAt: '2026-08-01T00:00:00Z',
    commit: 'a'.repeat(40),
    candidates: [],
    failure: { code, detail },
  })

  const state: RepoState = {
    'z/mislabelled': failing('no-manifest', mislabelled),
    'a/mislabelled': failing('no-manifest', mislabelled),
    'b/unreadable': failing('no-manifest', 'package.json was unreadable.'),
    'c/transient': failing('fetch-failed', 'Could not resolve the head commit of c/transient.'),
    // Same detail, different code. Contrived — nothing writes this pair — but
    // `code` is a parameter a second caller can pass differently, and a
    // parameter that does not filter is a bug waiting for that caller.
    'e/same-detail-other-code': failing('fetch-failed', mislabelled),
    'd/listed': { pushedAt: '2026-08-01T00:00:00Z', commit: 'a'.repeat(40), candidates: [] },
  }

  it('selects only the records the mislabelling rule wrote, sorted', () => {
    // The old rule wrote this exact code and detail for a 404, a 403, a 451
    // and a 503 alike, so the whole class is invalidated together. The other
    // two `no-manifest` details only ever followed a successful 200, so their
    // reasons were never in doubt and they stay.
    expect(staleFailureRepos(state, 'no-manifest', mislabelled, Number.POSITIVE_INFINITY))
      .toEqual(['a/mislabelled', 'z/mislabelled'])
  })

  it('honours the limit so the invalidation can be paced across runs', () => {
    // Sorted before slicing, so day two's slice is disjoint from day one's.
    expect(staleFailureRepos(state, 'no-manifest', mislabelled, 1)).toEqual(['a/mislabelled'])
  })

  it('selects nothing for a state with no such records', () => {
    expect(staleFailureRepos({ 'd/listed': state['d/listed']! }, 'no-manifest', mislabelled, 10)).toEqual([])
  })
})

describe('repoGoneDetail', () => {
  it('names topic removal, the one cause that leaves a live repository its author can act on', () => {
    // `gone` means only that neither harvest topic returned the repository.
    // The published reason said "(deleted, renamed, or private)" and stopped
    // there, which is all three false for the likeliest cause of all: the
    // owner edited the repository's topics. That repository still exists, is
    // public and was never renamed — and its author reads this line to find
    // out why the shop dropped it. CLAUDE.md counts a misattributed reason as
    // a defect rather than a wording nit, and this one also hides the only
    // remedy: re-add the topic and the next build lists it again.
    const detail = repoGoneDetail(['dsh-plugin', 'deepseek-harness'])
    expect(detail).toContain('dsh-plugin/deepseek-harness')
    expect(detail).toContain('topic was removed')
    // The other three causes are real and stay named.
    expect(detail).toContain('deleted, renamed, or made private')
  })

  it('takes the topics rather than restating them, so the two cannot drift', () => {
    // Hardcoding the names here would be a third copy of HARVEST_TOPICS, and
    // repo-state.ts is pure — importing the list from the network module to
    // read it would be the wrong direction.
    expect(repoGoneDetail(['only-one'])).toContain('its only-one topic was removed')
  })
})
