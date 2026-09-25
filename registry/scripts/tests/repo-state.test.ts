import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { DECLARATIONS_RULE, diffRepoState, nextRepoState, parseRepoState, repoGoneDetail, serializeRepoState, staleFailureRepos } from '../src/repo-state.ts'
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
    // A normally recorded candidate has been through the sizing probe. Absent
    // here, every fixture below would queue for a re-probe and the tests about
    // `pushedAt` and `assetVerified` would stop testing those.
    sizeProbed: true,
    // And its manifest's declarations were read — no peers, here — under the
    // rule this build applies. Unstamped, every fixture would queue for the
    // declarations re-read instead, for the same reason. (This was `peers: []`
    // alone while the bare presence of `peers` was the marker.)
    peers: [],
    declarationsRule: DECLARATIONS_RULE,
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

  it('diff: an unchanged repo whose release predates the asset check is re-probed once', () => {
    // The retroactivity hole. `pushedAt` alone let an unverified rescue stand
    // forever: two of the bad ones measured on 2026-09-06 had been quiet
    // since 2026-08-22 and 2026-08-24, so "the next push fixes it" is not
    // true in any useful sense. Absence of `assetVerified` means the record
    // was taken on release metadata alone.
    const unverified: RepoState = {
      'a/one': {
        pushedAt: '2026-08-01T00:00:00Z',
        commit,
        candidates: [{ ...candidate('a/one'), release: { tag: 'v1', url: 'https://x/y.tgz', sha256: 'a'.repeat(64) } }],
      },
    }
    const { toFetch } = diffRepoState(unverified, [{ repo: 'a/one', pushedAt: '2026-08-01T00:00:00Z' }])
    expect(toFetch.map(e => e.repo)).toEqual(['a/one'])
  })

  it('diff: a verified release is left alone, so the re-probe is once and not daily', () => {
    const verified: RepoState = {
      'a/one': {
        pushedAt: '2026-08-01T00:00:00Z',
        commit,
        candidates: [{
          ...candidate('a/one'),
          release: { tag: 'v1', url: 'https://x/y.tgz', sha256: 'a'.repeat(64), assetVerified: true },
        }],
      },
    }
    const { toFetch } = diffRepoState(verified, [{ repo: 'a/one', pushedAt: '2026-08-01T00:00:00Z' }])
    expect(toFetch).toEqual([])
  })

  it('diff: an unchanged repo whose candidates were never size-probed is re-probed once', () => {
    // Same retroactivity hole as the release check above, for the same reason:
    // `pushedAt` alone would leave every repo recorded before `installSize`
    // existed without one forever. Measured on the 2026-09-08 dry run — 405
    // repositories fetched against 15,063 carried, so waiting for pushes
    // would populate the field for a few percent and trickle indefinitely.
    const unprobed: RepoState = {
      'a/one': {
        pushedAt: '2026-08-01T00:00:00Z',
        commit,
        candidates: [{ ...candidate('a/one'), sizeProbed: undefined }],
      },
    }
    const { toFetch } = diffRepoState(unprobed, [{ repo: 'a/one', pushedAt: '2026-08-01T00:00:00Z' }])
    expect(toFetch.map(e => e.repo)).toEqual(['a/one'])
    // Labelled, because the caller must be able to serve it AFTER anything
    // that actually changed: nothing about this repository is new, it is
    // queued to re-ask a question about the commit already recorded.
    expect(toFetch[0]?.backfillOnly).toBe(true)
  })

  it('diff: a repo whose head moved is never labelled backfill, even if it also lacks a probe', () => {
    // Both reasons at once is the common case during the one-time backfill:
    // 13,443 recorded repositories lack a probe, and some of them pushed
    // today. A repo with something NEW to say is served first — the label
    // must follow the change, not the marker.
    const both: RepoState = {
      'a/one': {
        pushedAt: '2026-07-01T00:00:00Z',
        commit,
        candidates: [{ ...candidate('a/one'), sizeProbed: undefined }],
      },
    }
    const { toFetch } = diffRepoState(both, [{ repo: 'a/one', pushedAt: '2026-08-01T00:00:00Z' }])
    expect(toFetch.map(e => e.backfillOnly)).toEqual([false])
  })

  it('diff: a repo the state has never seen is never labelled backfill', () => {
    const { toFetch } = diffRepoState({}, [{ repo: 'a/new', pushedAt: '2026-08-01T00:00:00Z' }])
    expect(toFetch.map(e => e.backfillOnly)).toEqual([false])
  })

  it('diff: a size-probed candidate with NO size is left alone, not re-asked daily', () => {
    // The reason the marker exists at all rather than testing `installSize`
    // directly. A tree can answer and still yield no figure — truncated, a
    // hostile blob size, a subdir matching nothing — and keying the re-probe
    // on the SIZE would put those repositories in every run's queue forever.
    // `sizeProbed` is written whichever way the answer went, exactly as
    // `assetVerified` is, so the re-probe happens once.
    const probedNoSize: RepoState = {
      'a/one': {
        pushedAt: '2026-08-01T00:00:00Z',
        commit,
        candidates: [{ ...candidate('a/one'), sizeProbed: true }],
      },
    }
    const { toFetch } = diffRepoState(probedNoSize, [{ repo: 'a/one', pushedAt: '2026-08-01T00:00:00Z' }])
    expect(toFetch).toEqual([])
  })

  /** `candidate()` with its declarations stamp removed or replaced. */
  function stamped(repo: string, declarationsRule: number | undefined, extra: Partial<RepoCandidate> = {}): RepoCandidate {
    const { declarationsRule: _current, ...rest } = candidate(repo)
    return { ...rest, ...extra, ...(declarationsRule === undefined ? {} : { declarationsRule }) }
  }
  const unchanged = [{ repo: 'a/one', pushedAt: '2026-08-01T00:00:00Z' }]

  it('diff: an unchanged repository whose listable candidate carries no stamp is re-read, not re-fetched', () => {
    // Changed with the declarations stamp (design
    // 2026-09-01-harness-compatibility section 9.8). This test sent the
    // repository to the FULL fetch queue on a
    // presence-only marker (`peers` absent): head commit, recursive sizing tree,
    // release probe and archive, subpackage discovery — to learn facts that sit
    // in one package.json at the recorded commit (the cost is measured once, on
    // DECLARATIONS_REREAD_BUDGET_DEFAULT). A repository whose ONLY need is the
    // stamp now goes to a separate re-read queue, which harvestRepos serves
    // with one manifest read per candidate.
    //
    // Why a re-read at all, unchanged: measured on the committed repo-state.json
    // of 2026-09-24, 0 of 10,864 listable candidates still lacked `sizeProbed`,
    // so with unchanged heads nothing else re-reads a dormant repository — and
    // without a marker its declarations would change only as it happened to push.
    const unread: RepoState = {
      'a/one': { pushedAt: '2026-08-01T00:00:00Z', commit, candidates: [stamped('a/one', undefined, { peers: undefined })] },
    }
    const { toFetch, toReread } = diffRepoState(unread, unchanged)
    expect(toFetch).toEqual([])
    expect(toReread).toEqual(['a/one'])
  })

  it('diff: a candidate stamped with the current rule queues nothing, whatever its peers say', () => {
    // `[]` is a record — the manifest was read and requires nothing — and it
    // is what every re-read leaves behind for a peerless plugin. Keying the
    // re-read on an EMPTY list would put every such repository in every run's
    // queue forever, the reason `sizeProbed` is a marker too; the stamp is the
    // marker now, and it is present here.
    const { toFetch, toReread } = diffRepoState(state, [
      { repo: 'a/one', pushedAt: '2026-08-01T00:00:00Z' },
      { repo: 'b/two', pushedAt: '2026-08-01T00:00:00Z' },
    ])
    expect(state['a/one'].candidates[0]?.peers).toEqual([])
    expect(state['a/one'].candidates[0]?.declarationsRule).toBe(DECLARATIONS_RULE)
    expect(toFetch).toEqual([])
    expect(toReread).toEqual([])
  })

  it('diff: a candidate stamped by any other rule is re-read — the reader changed since', () => {
    // The whole reason the marker is a version: `tier.ts` republishes carried
    // declarations verbatim, so a candidate written under an older
    // `peerNamesOf` would otherwise publish the old rule's answer forever. The
    // comparison is equality, so a LATER stamp (a build rolled back) is
    // re-read too. With the rule at 1 an older stamp is 0, which only this
    // in-memory fixture can hold — `parseRepoState` refuses 0 below — and the
    // point here is the diff's predicate, not the file's grammar.
    for (const other of [DECLARATIONS_RULE - 1, DECLARATIONS_RULE + 1]) {
      const stale: RepoState = { 'a/one': { pushedAt: '2026-08-01T00:00:00Z', commit, candidates: [stamped('a/one', other)] } }
      const { toFetch, toReread } = diffRepoState(stale, unchanged)
      expect(toFetch, String(other)).toEqual([])
      expect(toReread, String(other)).toEqual(['a/one'])
    }
  })

  it('diff: a repository whose head moved takes the full fetch alone, even when it also lacks the stamp', () => {
    // The full fetch re-projects every candidate and stamps it, so queueing
    // the same repository for a re-read too would read its manifest twice.
    const both: RepoState = {
      'a/one': { pushedAt: '2026-07-01T00:00:00Z', commit, candidates: [stamped('a/one', undefined, { peers: undefined })] },
    }
    const { toFetch, toReread } = diffRepoState(both, [{ repo: 'a/one', pushedAt: '2026-08-01T00:00:00Z' }])
    expect(toFetch.map(e => [e.repo, e.backfillOnly])).toEqual([['a/one', false]])
    expect(toReread).toEqual([])
  })

  it('diff: a repository queued for a size probe or an unverified release is not also re-read', () => {
    // Same rule for the full-fetch backfills: the stamp is the re-read's ONLY
    // reason, and any reason to fetch the repository in full answers it too.
    const cases: RepoCandidate[] = [
      stamped('a/one', undefined, { sizeProbed: undefined }),
      stamped('a/one', undefined, { requiresBuild: true, release: { tag: 'v1', url: 'https://x/y.tgz', sha256: 'a'.repeat(64) } }),
    ]
    for (const unstamped of cases) {
      const { toFetch, toReread } = diffRepoState({ 'a/one': { pushedAt: '2026-08-01T00:00:00Z', commit, candidates: [unstamped] } }, unchanged)
      expect(toFetch.map(e => [e.repo, e.backfillOnly])).toEqual([['a/one', true]])
      expect(toReread).toEqual([])
    }
  })

  it('diff: a candidate that can never list queues its repository for nothing, stamp or no stamp', () => {
    // The predicate the size marker asks, for the reason its comment gives.
    // One of gateRepo's three unconditional rejections can reach no entry, so
    // its declarations would reach no reader either; counting it would queue a
    // repo whose only candidate is bundle-less on every run for nothing. And
    // the absence stays: should the gate ever loosen, the same predicate
    // re-queues exactly the candidates the loosening made listable.
    const unlistable: RepoState = {
      'a/one': { pushedAt: '2026-08-01T00:00:00Z', commit, candidates: [stamped('a/one', undefined, { hasBundle: false, peers: undefined })] },
    }
    const { toFetch, toReread } = diffRepoState(unlistable, unchanged)
    expect(toFetch).toEqual([])
    expect(toReread).toEqual([])
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

describe('a carried installSize is re-bounded on the way in', () => {
  // The npm half re-bounds `dist.unpackedSize` on EVERY run and its comment
  // says why. The github figure was validated once, at the commit where it
  // was measured, and `sizeProbed` then guaranteed it was never measured
  // again — so a bad row in the 11.6 MB state file rode an unchecked cast all
  // the way to `plugins.json`, where nothing re-tests it.
  const rowWith = (extra: Record<string, unknown>): string => JSON.stringify({
    'a/one': {
      pushedAt: '2026-08-01T00:00:00Z',
      commit,
      candidates: [{ ...candidate('a/one'), sizeProbed: true, ...extra }],
    },
  })

  it.each([
    ['negative', -1],
    ['fractional', 1.5],
    ['a string', 'big'],
    ['past the safe-integer range', 1e999],
    ['null', null],
  ])('drops a %s installSize, and the probe marker with it', (_label, installSize) => {
    const parsed = parseRepoState(rowWith({ installSize }))
    const carried = parsed['a/one']?.candidates[0]
    expect(carried?.installSize).toBeUndefined()
    // The marker goes too, so the repository is re-queued for one honest
    // re-measurement. Dropping the size alone would leave it probed, and
    // therefore sizeless for as long as the row survives.
    expect(carried?.sizeProbed).toBeUndefined()
    expect(diffRepoState(parsed, [{ repo: 'a/one', pushedAt: '2026-08-01T00:00:00Z' }]).toFetch)
      .toHaveLength(1)
  })

  it('keeps a well-formed figure, zero included', () => {
    // Zero is a fact, not a falsy absence — the same rule the npm side keeps
    // for an empty tarball.
    for (const size of [0, 4242, Number.MAX_SAFE_INTEGER]) {
      const carried = parseRepoState(rowWith({ installSize: size }))['a/one']?.candidates[0]
      expect(carried?.installSize).toBe(size)
      expect(carried?.sizeProbed).toBe(true)
    }
  })

  it('normalizes a sizeProbed this build never writes', () => {
    // The type is `sizeProbed?: true`. A `false` already reads as unprobed,
    // but round-tripping it would put a shape the writer cannot produce back
    // into the committed file.
    const carried = parseRepoState(rowWith({ sizeProbed: false }))['a/one']?.candidates[0]
    expect(carried?.sizeProbed).toBeUndefined()
  })
})

describe('a carried peers or compatibility record is checked on the way in', () => {
  // Carried candidates are revived by a bare cast, and nothing downstream
  // re-derives either field: `tier.ts` copies both into the published entry
  // as they stand. So a shape this build never writes is a malformed registry
  // file, and a malformed registry file throws rather than publishing it.
  const rowWith = (extra: Record<string, unknown>): string => JSON.stringify({
    'a/one': { pushedAt: '2026-08-01T00:00:00Z', commit, candidates: [{ ...candidate('a/one'), ...extra }] },
  })

  it('round-trips both, and leaves an absent peers absent rather than inventing an empty one', () => {
    const recorded: RepoState = {
      'a/one': {
        pushedAt: '2026-08-01T00:00:00Z',
        commit,
        candidates: [{
          ...candidate('a/one'),
          peers: ['@deepseek-ai/cordis', 'react'],
          compatibility: { dsh: '0.1.5-rc.1 || 0.1.6', profiles: ['web'] },
        }],
      },
    }
    expect(parseRepoState(serializeRepoState(recorded))).toEqual(recorded)
    // A record from before either field existed carries neither `peers` nor a
    // stamp. A parse that filled in `[]` would record "requires nothing" for a
    // manifest nobody read; left absent, the missing stamp queues the re-read.
    // (Changed with the declarations stamp, design
    // 2026-09-01-harness-compatibility section 9.8: this asserted a FULL
    // fetch, when the absence of `peers` itself was the marker.)
    const { peers: _unread, declarationsRule: _unstamped, ...legacy } = candidate('a/one')
    const parsed = parseRepoState(JSON.stringify({ 'a/one': { pushedAt: '2026-08-01T00:00:00Z', commit, candidates: [legacy] } }))
    expect(parsed['a/one']?.candidates[0]).not.toHaveProperty('peers')
    expect(parsed['a/one']?.candidates[0]).not.toHaveProperty('declarationsRule')
    const { toFetch, toReread } = diffRepoState(parsed, [{ repo: 'a/one', pushedAt: '2026-08-01T00:00:00Z' }])
    expect(toFetch).toEqual([])
    expect(toReread).toEqual(['a/one'])
  })

  it('round-trips a well-formed declarations stamp, a later rule\'s included', () => {
    for (const declarationsRule of [DECLARATIONS_RULE, DECLARATIONS_RULE + 6]) {
      expect(parseRepoState(rowWith({ declarationsRule }))['a/one']?.candidates[0]?.declarationsRule).toBe(declarationsRule)
    }
  })

  it.each([
    ['zero', 0],
    ['negative', -1],
    ['fractional', 1.5],
    ['past the safe-integer range', 2 ** 53],
    ['a numeric string', '1'],
    ['null', null],
    ['a boolean', true],
    ['an array', [1]],
  ])('throws on a declarations stamp that is %s', (_label, declarationsRule) => {
    // The stamp decides whether a carried record is re-read, and this build is
    // its only writer, which writes a positive integer. Anything else means the
    // file was edited or corrupted: a value that silently compared unequal
    // would re-read the repository every run, and one that compared equal by
    // accident would freeze its declarations under a rule nobody applied.
    expect(() => parseRepoState(rowWith({ declarationsRule }))).toThrow('a/one has a candidate with a malformed declarationsRule stamp')
  })

  it.each([
    ['a string', 'react'],
    ['null', null],
    ['an object', { react: '*' }],
    ['a number in the list', ['react', 42]],
    ['a null in the list', [null]],
  ])('throws on a peers that is %s', (_label, peers) => {
    expect(() => parseRepoState(rowWith({ peers }))).toThrow('a/one has a candidate with a malformed peers record')
  })

  it('keeps each half of a compatibility record standing alone', () => {
    for (const compatibility of [{ dsh: '>=0.1.5' }, { profiles: ['web', 'tui'] }]) {
      expect(parseRepoState(rowWith({ compatibility }))['a/one']?.candidates[0]?.compatibility).toEqual(compatibility)
    }
  })

  it.each([
    ['null', null],
    ['a string', 'web'],
    ['an array', ['web']],
    ['a number range', { dsh: 5 }],
    ['a string profiles', { profiles: 'web' }],
    ['a number in profiles', { profiles: ['web', 1] }],
    // `compatibilityOf` returns nothing at all rather than an empty object,
    // because an empty object in the artifact reads as a declaration the
    // author did not make.
    ['empty', {}],
    // And it never writes a half that says nothing: an empty range and an
    // empty template list are dropped by that reader, so either one in the
    // committed file is a shape no build wrote.
    ['an empty range', { dsh: '' }],
    ['an empty profile list', { profiles: [] }],
    ['an empty profile name', { profiles: [''] }],
    // Copied into plugins.json whole, so a key this build never harvested
    // would be published under the author's name.
    ['carrying a key the harvest never writes', { dsh: '0.1.5', node: '>=22' }],
  ])('throws on a compatibility that is %s', (_label, compatibility) => {
    expect(() => parseRepoState(rowWith({ compatibility }))).toThrow('a/one has a candidate with a malformed compatibility record')
  })

  it('throws on a candidate that is not an object at all', () => {
    // Reading either field off it would otherwise be the first thing to
    // fail, as a TypeError naming nothing.
    for (const value of [null, 'a string', 42, ['nested']]) {
      const text = JSON.stringify({ 'a/one': { pushedAt: '2026-08-01T00:00:00Z', commit, candidates: [value] } })
      expect(() => parseRepoState(text), JSON.stringify(value)).toThrow('a/one has a candidate that is not an object')
    }
  })
})

describe('the committed harvest memory', () => {
  it('still parses registry/repo-state.json, which the stamp check must not turn into a build that cannot start', () => {
    // The file is a build input committed daily, and every record in it
    // predates the stamp. `checkCarriedDeclarations` now reads one more field
    // off each carried candidate; a check that refused the committed file would
    // stop the next build before it harvested anything.
    const committed = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'repo-state.json')
    const parsed = parseRepoState(readFileSync(committed, 'utf8'))
    expect(Object.keys(parsed).length).toBeGreaterThan(0)
  })
})

describe('a cap-refused sizing read is re-asked when the cap moves', () => {
  const capped = (sizeCappedAt: number): RepoState => ({
    'a/one': {
      pushedAt: '2026-08-01T00:00:00Z',
      commit,
      candidates: [{ ...candidate('a/one'), sizeProbed: true, sizeCappedAt }],
    },
  })
  const seen = [{ repo: 'a/one', pushedAt: '2026-08-01T00:00:00Z' }]

  it('re-queues a candidate refused under a smaller cap than this build applies', () => {
    // The hole this closes: `sizeProbed` recorded an over-cap refusal exactly
    // as it records a 404, so raising MAX_TREE_BYTES would have re-measured
    // none of the repositories the old cap excluded — the same retroactivity
    // hole `hasUnverifiedRelease` and the probe marker itself were written to
    // close, reintroduced one level down.
    const { toFetch } = diffRepoState(capped(8 * 1024 * 1024), seen, 24 * 1024 * 1024)
    expect(toFetch.map(e => e.repo)).toEqual(['a/one'])
    // Still a backfill, not a change: it must not displace a repository that
    // actually pushed.
    expect(toFetch[0]?.backfillOnly).toBe(true)
  })

  it('leaves a candidate refused under the cap still in force', () => {
    // Otherwise the re-probe is not one-shot: every run would re-read a body
    // it already knows is too big.
    expect(diffRepoState(capped(24 * 1024 * 1024), seen, 24 * 1024 * 1024).toFetch).toEqual([])
  })

  it('re-queues rather than going silent when the caller names no cap', () => {
    // The default is Infinity on purpose. A caller that forgets spends one
    // re-probe; the other default would leave those repositories sizeless
    // forever, and this project prefers the failure it can see.
    expect(diffRepoState(capped(24 * 1024 * 1024), seen).toFetch.map(e => e.repo)).toEqual(['a/one'])
  })
})
