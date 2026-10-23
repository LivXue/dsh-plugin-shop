import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { DECLARATIONS_RULE, applyArchivedFlags, applyForkFlags, diffRepoState, layerArchivedFlags, layerForkFlags, needsDeclarationsReread, nextRepoState, parseRepoState, repoGoneDetail, serializeRepoState, staleFailureRepos } from '../src/repo-state.ts'
import type { RepoState, RepoStateEntry } from '../src/repo-state.ts'
import type { Candidate, RepoCandidate } from '../src/types.ts'
import { dshPeersOf } from '../src/npm-client.ts'
import { readIconDeclaration } from '../src/icon-declaration.ts'

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
    // And its tree was checked for the files its patch loads (design
    // 2026-09-26-market-borrowings §9). Unmarked, every fixture below would
    // queue for that backfill and stop testing what it names.
    entriesChecked: true,
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
    // re-read too. In-memory on purpose: the point here is the diff's
    // predicate, not the file's grammar, which the parse cases below pin.
    // (This said the older stamp was 0, which only an in-memory fixture can
    // hold, while the rule was 1. It is now the previous rule's own stamp,
    // whichever rule that is: the one a bump sends back through the re-read.)
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

  describe('needsDeclarationsReread, the one predicate the diff and the re-read both ask', () => {
    // Two halves, each its own case: a stamp that is not the current rule, and
    // a candidate that could list once read (`canEverList`). The re-read
    // phase in github-client.ts skips a candidate by this same predicate, so
    // the queue and the reads it buys cannot disagree.
    const release = { tag: 'v1', url: 'https://github.com/a/one/releases/download/v1/one.tgz', sha256: 'a'.repeat(64), assetVerified: true as const }

    it('asks for a listable candidate whose stamp is not the current rule, and only for one', () => {
      for (const rule of [undefined, DECLARATIONS_RULE - 1, DECLARATIONS_RULE + 1]) {
        expect(needsDeclarationsReread(stamped('a/one', rule)), String(rule)).toBe(true)
      }
      expect(needsDeclarationsReread(stamped('a/one', DECLARATIONS_RULE))).toBe(false)
      // A rescued root lists on its release, so it is re-read too: from the
      // recorded asset, which is what it installs.
      expect(needsDeclarationsReread(stamped('a/one', DECLARATIONS_RULE - 1, { requiresBuild: true, release }))).toBe(true)
    })

    it.each([
      ['no bundle', { hasBundle: false }],
      ['a build script and no release', { requiresBuild: true }],
      ['workspace: dependencies and no release', { hasWorkspaceDeps: true }],
      ['an unbuilt finding and no release', { unbuilt: { patch: './cordis.patch.yml' } }],
    ] as const)('never asks for a candidate that can never list (%s), stale stamp or not', (_label, extra) => {
      expect(needsDeclarationsReread(stamped('a/one', DECLARATIONS_RULE - 1, extra))).toBe(false)
      expect(needsDeclarationsReread(stamped('a/one', undefined, extra))).toBe(false)
    })

    it('is what queues a repository for the re-read, candidate for candidate', () => {
      const cases: RepoCandidate[] = [
        stamped('a/one', DECLARATIONS_RULE - 1),
        stamped('a/one', DECLARATIONS_RULE),
        stamped('a/one', DECLARATIONS_RULE - 1, { hasBundle: false }),
      ]
      for (const recorded of cases) {
        const { toReread } = diffRepoState({ 'a/one': { pushedAt: '2026-08-01T00:00:00Z', commit, candidates: [recorded] } }, unchanged)
        expect(toReread.length > 0, JSON.stringify(recorded.declarationsRule)).toBe(needsDeclarationsReread(recorded))
      }
    })
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

describe('the archived marker (design 2026-10-08-archived-flag-and-shadowed-recovery §1)', () => {
  it('round-trips archived true and false through parse and serialize', () => {
    const recorded: RepoState = {
      'a/archived': { pushedAt: '2026-08-01T00:00:00Z', commit, candidates: [candidate('a/archived')], archived: true },
      'b/live': { pushedAt: '2026-08-01T00:00:00Z', commit, candidates: [candidate('b/live')], archived: false },
    }
    expect(parseRepoState(serializeRepoState(recorded))).toEqual(recorded)
  })

  it('leaves a record written before the field existed without it, rather than inventing false', () => {
    // Every record in the committed repo-state.json predates the field, and an
    // archived:false written for a repository nobody observed would be a fact
    // GitHub never reported. Absent stays absent; the GraphQL pass fills it
    // on the next merge.
    const parsed = parseRepoState(JSON.stringify({
      'a/one': { pushedAt: '2026-08-01T00:00:00Z', commit, candidates: [candidate('a/one')] },
    }))
    expect(parsed['a/one']).not.toHaveProperty('archived')
    const text = serializeRepoState(parsed)
    expect(text).not.toContain('"archived"')
  })

  it('throws on a non-boolean archived, a shape this build never writes', () => {
    // Same rule as the failure record: this build is the only writer, so a
    // different shape means the file was edited, and a malformed registry file
    // throws rather than being normalized.
    for (const archived of ['yes', 1, null, {}]) {
      const text = JSON.stringify({
        'a/one': { pushedAt: '2026-08-01T00:00:00Z', commit, candidates: [candidate('a/one')], archived },
      })
      expect(() => parseRepoState(text), JSON.stringify(archived)).toThrow('a/one has a malformed archived record')
    }
  })

  it('keeps a recorded archived through nextRepoState, and applyArchivedFlags supersedes it', () => {
    // nextRepoState carries the recorded value forward on both the fresh and
    // carried paths — the search no longer supplies it (§1.3), so a record
    // holding it keeps it until the graph pass answers.
    const withArchived: RepoState = {
      'a/one': { pushedAt: '2026-08-01T00:00:00Z', commit, candidates: [candidate('a/one')], archived: true },
    }
    const fresh = new Map([['a/one', { candidates: [candidate('a/one')] }]])
    const afterFresh = nextRepoState(withArchived, [{ repo: 'a/one', pushedAt: '2026-08-02T00:00:00Z' }], fresh)
    expect(afterFresh['a/one']?.archived).toBe(true)
    const afterCarried = nextRepoState(withArchived, [{ repo: 'a/one', pushedAt: '2026-08-01T00:00:00Z' }], new Map())
    expect(afterCarried['a/one']?.archived).toBe(true)
    // applyArchivedFlags supersedes the recorded value with the GraphQL answer.
    const superseded = applyArchivedFlags(afterCarried, new Map([['a/one', false]]))
    expect(superseded['a/one']?.archived).toBe(false)
    // A repo the Map omits supplies no fact: the record stands.
    const untouched = applyArchivedFlags(afterCarried, new Map([['x/other', true]]))
    expect(untouched['a/one']?.archived).toBe(true)
    // An absent record + a flag = the record gains it.
    const added = applyArchivedFlags(state, new Map([['a/one', true]]))
    expect(added['a/one']?.archived).toBe(true)
  })

  it('layers a mixed-case repository\'s recorded flag onto its candidate (verbatim lookup)', () => {
    // The state key and the candidate's `repo` both come from GitHub's
    // `full_name` and share its case. A lowercased lookup — which build.ts
    // carried until this test — returned undefined for every mixed-case
    // repository (34% of the listed pool, measured 2026-10-09 over
    // `manifest.lock`), so the flag never reached the candidate and the
    // catalog row never carried `archived: true`.
    const mixed: RepoState = {
      'Diluka/dsh-agent-plugin-market': { pushedAt: '2026-08-01T00:00:00Z', commit, candidates: [candidate('Diluka/dsh-agent-plugin-market')], archived: true },
    }
    const candidates = [candidate('Diluka/dsh-agent-plugin-market'), candidate('a/lowercase')]
    layerArchivedFlags(mixed, candidates)
    expect(candidates[0]?.archived).toBe(true)
    // No record, no flag: the candidate stays without the field.
    expect(candidates[1]).not.toHaveProperty('archived')
  })

  it('layers only archived: true — a recorded false stays off the candidate', () => {
    // The emitted field is `archived?: true`; `false` is its omission, so the
    // layering writes nothing for a live repository.
    const live: RepoState = {
      'a/live': { pushedAt: '2026-08-01T00:00:00Z', commit, candidates: [candidate('a/live')], archived: false },
    }
    const candidates = [candidate('a/live')]
    layerArchivedFlags(live, candidates)
    expect(candidates[0]).not.toHaveProperty('archived')
  })
})

describe('the forked marker (design 2026-10-11-fork-flag §1.1)', () => {
  // Mirrored on the archived block above, assertion for assertion: the two
  // kinds decay independently, so the record keeps them as two fields
  // following one discipline. The field landed in this PR along with its
  // GraphQL-side apply (`applyForkFlags`) and its emit-side layer
  // (`layerForkFlags`); all three share this block.

  it('round-trips forked true and false through parse and serialize', () => {
    const recorded: RepoState = {
      'a/fork': { pushedAt: '2026-08-01T00:00:00Z', commit, candidates: [candidate('a/fork')], forked: true },
      'b/original': { pushedAt: '2026-08-01T00:00:00Z', commit, candidates: [candidate('b/original')], forked: false },
    }
    expect(parseRepoState(serializeRepoState(recorded))).toEqual(recorded)
  })

  it('leaves a record written before the field existed without it, rather than inventing false', () => {
    // Every record in the committed repo-state.json predates the field, and a
    // forked:false written for a repository nobody observed would be a fact
    // GitHub never reported. Absent stays absent; the GraphQL pass fills it
    // on the next merge.
    const parsed = parseRepoState(JSON.stringify({
      'a/one': { pushedAt: '2026-08-01T00:00:00Z', commit, candidates: [candidate('a/one')] },
    }))
    expect(parsed['a/one']).not.toHaveProperty('forked')
    const text = serializeRepoState(parsed)
    expect(text).not.toContain('"forked"')
  })

  it('throws on a non-boolean forked, a shape this build never writes', () => {
    // Same rule as the archived record: this build is the only writer, so a
    // different shape means the file was edited, and a malformed registry file
    // throws rather than being normalized.
    for (const forked of ['yes', 1, null, {}]) {
      const text = JSON.stringify({
        'a/one': { pushedAt: '2026-08-01T00:00:00Z', commit, candidates: [candidate('a/one')], forked },
      })
      expect(() => parseRepoState(text), JSON.stringify(forked)).toThrow('a/one has a malformed forked record')
    }
  })

  it('keeps a recorded forked through nextRepoState, on the fresh path and the carried one', () => {
    // nextRepoState carries the recorded value forward on both the fresh
    // and carried paths — the search item supplies no fork fact, so a record
    // holding one keeps it until the graph pass answers (design §1.3).
    const withForked: RepoState = {
      'a/one': { pushedAt: '2026-08-01T00:00:00Z', commit, candidates: [candidate('a/one')], forked: true },
    }
    const fresh = new Map([['a/one', { candidates: [candidate('a/one')] }]])
    const afterFresh = nextRepoState(withForked, [{ repo: 'a/one', pushedAt: '2026-08-02T00:00:00Z' }], fresh)
    expect(afterFresh['a/one']?.forked).toBe(true)
    const afterCarried = nextRepoState(withForked, [{ repo: 'a/one', pushedAt: '2026-08-01T00:00:00Z' }], new Map())
    expect(afterCarried['a/one']?.forked).toBe(true)
  })

  it("records forked and archived as two fields, so neither's absence costs the other", () => {
    // The two kinds decay independently (design §1.3): a parse that fused
    // them, or a record shape that required them together, would lose one
    // kind's observation whenever the other's GraphQL answer was skipped.
    const recorded: RepoState = {
      'a/fork': {
        pushedAt: '2026-08-01T00:00:00Z', commit,
        candidates: [candidate('a/fork')], archived: false, forked: true,
      },
      'b/original-archived': {
        pushedAt: '2026-08-01T00:00:00Z', commit,
        candidates: [candidate('b/original-archived')], archived: true, forked: false,
      },
    }
    expect(parseRepoState(serializeRepoState(recorded))).toEqual(recorded)
  })

  it('applyForkFlags supersedes the recorded forked with the GraphQL answer', () => {
    // Mirrored on applyArchivedFlags above: the Map keys are lowercased, an
    // omitted repo supplies no fact, and an answer equal to the record leaves
    // the entry object untouched — no churn in the serialized file.
    const carried: RepoState = {
      'a/one': { pushedAt: '2026-08-01T00:00:00Z', commit, candidates: [candidate('a/one')], forked: false },
    }
    const superseded = applyForkFlags(carried, new Map([['a/one', true]]))
    expect(superseded['a/one']?.forked).toBe(true)
    // A repo the Map omits supplies no fact: the record stands.
    const untouched = applyForkFlags(carried, new Map([['x/other', true]]))
    expect(untouched['a/one']?.forked).toBe(false)
    // An absent record + a flag = the record gains it.
    const added = applyForkFlags(state, new Map([['a/one', true]]))
    expect(added['a/one']?.forked).toBe(true)
    // A flag equal to the record: the entry object is reused, identity for identity.
    const unchanged = applyForkFlags(carried, new Map([['a/one', false]]))
    expect(unchanged['a/one']).toBe(carried['a/one'])
  })

  it('layers a mixed-case repository\'s recorded forked onto its candidate (verbatim lookup)', () => {
    // Same verbatim rule as layerArchivedFlags: the state key and the
    // candidate share `full_name` case, and a lowercased lookup would miss
    // exactly the mixed-case repositories the flag exists to describe.
    const mixed: RepoState = {
      'Diluka/dsh-agent-plugin-market': { pushedAt: '2026-08-01T00:00:00Z', commit, candidates: [candidate('Diluka/dsh-agent-plugin-market')], forked: true },
    }
    const candidates = [candidate('Diluka/dsh-agent-plugin-market'), candidate('a/lowercase')]
    layerForkFlags(mixed, candidates)
    expect(candidates[0]?.forked).toBe(true)
    // No record, no flag: the candidate stays without the field.
    expect(candidates[1]).not.toHaveProperty('forked')
  })

  it('layers only forked: true — a recorded false stays off the candidate', () => {
    // The emitted field is `forked?: true`; `false` is its omission, so the
    // layering writes nothing for an original repository.
    const original: RepoState = {
      'a/original': { pushedAt: '2026-08-01T00:00:00Z', commit, candidates: [candidate('a/original')], forked: false },
    }
    const candidates = [candidate('a/original')]
    layerForkFlags(original, candidates)
    expect(candidates[0]).not.toHaveProperty('forked')
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

describe('a carried declarations record is checked on the way in', () => {
  // Carried candidates are revived by a bare cast, and nothing downstream
  // re-derives a declaration field: `tier.ts` copies `peers`,
  // `compatibility`, `dshPeers` and `manifestVersion` into the published
  // entry as they stand. So a shape this build never writes is a malformed
  // registry file, and a malformed registry file throws rather than
  // publishing it.
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

  it('queues a record stamped by the previous rule for one re-read', () => {
    // The bump's whole effect on a carried record (design
    // 2026-09-28-bundle-components-and-github-peers, section 6.2): a stamp
    // one rule behind is re-read once, and nothing else about it moves.
    const parsed = parseRepoState(rowWith({ declarationsRule: DECLARATIONS_RULE - 1 }))
    const { toFetch, toReread } = diffRepoState(parsed, [{ repo: 'a/one', pushedAt: '2026-08-01T00:00:00Z' }])
    expect(toFetch).toEqual([])
    expect(toReread).toEqual(['a/one'])
  })

  it('queues a record stamped by the literal rule 1, the stamp every committed record holds when rule 2 lands', () => {
    // The case above passes for any DECLARATIONS_RULE greater than the stamp
    // it writes, so it does not depend on that constant's value. This one
    // names the stamp the committed records carry, and breaks the moment rule
    // 1 becomes current again: a record stamped 1 would then already be
    // current and never queued, and no github entry would ever gain the
    // rule-2 fields.
    const parsed = parseRepoState(rowWith({ declarationsRule: 1 }))
    const { toFetch, toReread } = diffRepoState(parsed, [{ repo: 'a/one', pushedAt: '2026-08-01T00:00:00Z' }])
    expect(toFetch).toEqual([])
    expect(toReread).toEqual(['a/one'])
  })

  it('queues a record stamped by the literal rule 2, the stamp every committed record holds when rule 3 lands', () => {
    // The same case one rule on, for the same reason: the previous-rule case
    // above holds for any greater DECLARATIONS_RULE, so it cannot say that the
    // icon declaration (design 2026-10-23-shop-plugin-icons §4) bumped the rule
    // to 3. This names the stamp the committed records carry now, and breaks
    // the moment rule 2 is current again: a record stamped 2 would then never
    // be queued, and no github entry would ever gain an icon declaration.
    const parsed = parseRepoState(rowWith({ declarationsRule: 2 }))
    const { toFetch, toReread } = diffRepoState(parsed, [{ repo: 'a/one', pushedAt: '2026-08-01T00:00:00Z' }])
    expect(toFetch).toEqual([])
    expect(toReread).toEqual(['a/one'])
  })

  it('round-trips the rule-2 pair, and leaves a record without it as it is', () => {
    const recorded: RepoState = {
      'a/one': {
        pushedAt: '2026-08-01T00:00:00Z',
        commit,
        candidates: [{ ...candidate('a/one'), dshPeers: { '@deepseek-ai/dsh': '0.1.5-rc.2' }, manifestVersion: '1.0.0' }],
      },
    }
    expect(parseRepoState(serializeRepoState(recorded))).toEqual(recorded)
    // Both absent is the ordinary shape: a manifest with no harness peer, or
    // one not yet read under rule 2. Nothing is invented for either.
    const plain = parseRepoState(rowWith({}))['a/one']?.candidates[0]
    expect(plain).not.toHaveProperty('dshPeers')
    expect(plain).not.toHaveProperty('manifestVersion')
  })

  it('round-trips a dshPeers built by its real producer, not one literal shape', () => {
    // `dshPeersOf` can return several keys, and keeps an EMPTY range, which dsh
    // reads as unsatisfiable: every shape it writes must parse back.
    const dshPeers = dshPeersOf({ peerDependencies: { '@deepseek-ai/dsh': '0.1.5-rc.2', '@deepseek-ai/dsh-tools': '*', '@deepseek-ai/dsh-app-boot': '' } })
    expect(dshPeers).toEqual({ '@deepseek-ai/dsh': '0.1.5-rc.2', '@deepseek-ai/dsh-tools': '*', '@deepseek-ai/dsh-app-boot': '' })
    const parsed = parseRepoState(rowWith({ dshPeers, manifestVersion: '1.0.0' }))['a/one']?.candidates[0]
    expect(parsed?.dshPeers).toEqual(dshPeers)
  })

  it.each([
    ['dshPeers without manifestVersion', { dshPeers: { '@deepseek-ai/dsh': '*' } }, 'dshPeers and manifestVersion recorded apart'],
    ['manifestVersion without dshPeers', { manifestVersion: '1.0.0' }, 'dshPeers and manifestVersion recorded apart'],
    ['a dshPeers key outside the harness scope', { dshPeers: { react: '*' }, manifestVersion: '1.0.0' }, 'a malformed dshPeers record'],
    ['an empty dshPeers', { dshPeers: {}, manifestVersion: '1.0.0' }, 'a malformed dshPeers record'],
    ['a dshPeers that is an array', { dshPeers: ['@deepseek-ai/dsh'], manifestVersion: '1.0.0' }, 'a malformed dshPeers record'],
    ['a null dshPeers', { dshPeers: null, manifestVersion: '1.0.0' }, 'a malformed dshPeers record'],
    ['a non-string range', { dshPeers: { '@deepseek-ai/dsh': 1 }, manifestVersion: '1.0.0' }, 'a malformed dshPeers record'],
    ['an empty manifestVersion', { dshPeers: { '@deepseek-ai/dsh': '*' }, manifestVersion: '' }, 'a malformed manifestVersion'],
    ['a blank manifestVersion', { dshPeers: { '@deepseek-ai/dsh': '*' }, manifestVersion: ' \t' }, 'a malformed manifestVersion'],
    ['a non-string manifestVersion', { dshPeers: { '@deepseek-ai/dsh': '*' }, manifestVersion: 1 }, 'a malformed manifestVersion'],
  ])('throws on %s', (_label, extra, message) => {
    // Each row pins the exact tail `parseRepoState` throws for one malformed
    // rule-2 shape. Both fields are copied into the published entry, so one
    // this build never writes is a malformed registry file, like a malformed
    // `peers` or `compatibility`.
    expect(() => parseRepoState(rowWith(extra))).toThrow(`a/one has a candidate with ${message}`)
  })

  describe('the icon record (design 2026-10-23-shop-plugin-icons §4)', () => {
    // A candidate's icon is `readIconDeclaration`'s answer, stored as it came:
    // `declared` or `refused`. `none` is never stored (the writer deletes the
    // key, so absent beside the current stamp means "declares none"), which
    // makes it, like every other shape this build never writes, a malformed
    // registry file.
    const ok = { source: 'icon', path: 'icon.svg', mediaType: 'image/svg+xml' } as const
    const declaredIcon = { kind: 'declared', declaration: ok } as const
    const message = 'a/one has a candidate with a malformed icon record'

    it('round-trips an icon built by its real producer, declared and refused, from either source', () => {
      const reads = [
        readIconDeclaration({ icon: './assets/Logo.SVG' }),
        readIconDeclaration({ exports: { './icon': './dist/logo.png' } }),
        readIconDeclaration({ icon: 7 }),
        readIconDeclaration({ icon: 'icon.gif' }),
      ]
      // The producer's own kinds, so a fixture that drifted from it would fail
      // here rather than round-trip a shape no build writes.
      expect(reads.map(read => read.kind)).toEqual(['declared', 'declared', 'refused', 'refused'])
      for (const icon of reads) {
        expect(parseRepoState(rowWith({ icon }))['a/one']?.candidates[0]?.icon, JSON.stringify(icon)).toEqual(icon)
      }
    })

    it('accepts every media type the reader writes, and both sources', () => {
      for (const source of ['icon', 'export']) {
        for (const { mediaType, path } of [
          { mediaType: 'image/svg+xml', path: 'icon.svg' },
          { mediaType: 'image/png', path: 'icon.png' },
          { mediaType: 'image/jpeg', path: 'icon.jpg' },
          { mediaType: 'image/webp', path: 'icon.webp' },
        ]) {
          const icon = { kind: 'declared', declaration: { source, path, mediaType } }
          expect(parseRepoState(rowWith({ icon }))['a/one']?.candidates[0]?.icon, JSON.stringify(icon)).toEqual(icon)
        }
      }
    })

    it('accepts a path whose file names only look like directions', () => {
      // The rule is about whole segments. A name holding dots, a percent
      // escape, a backslash or a control character is a file name, and
      // `readIconDeclaration` writes such paths: refusing one would stop the
      // build over a record it made itself.
      const paths = [
        '..icon.svg',
        'icon..svg',
        'a..b/icon.svg',
        '.../icon.svg',
        'assets/.hidden/icon.svg',
        '%2e%2e/icon.svg',
        'a\\..\\b.svg',
        'tab\there/new\nline.svg',
        'a b/图标.svg',
      ]
      for (const path of paths) {
        const icon = { kind: 'declared', declaration: { ...ok, path } }
        expect(parseRepoState(rowWith({ icon }))['a/one']?.candidates[0]?.icon, JSON.stringify(path)).toEqual(icon)
      }
    })

    it('has no place for the none read in the type of either candidate, and the parse refuses it besides', () => {
      // The two directives are compile-time assertions: `pnpm typecheck` fails
      // with "Unused '@ts-expect-error' directive" the day either field is
      // widened back to the reader's `IconRead`. `none` is the reader's answer
      // for a manifest that declares nothing, which a candidate records as an
      // absent key, so whatever plans or fetches icons from a record never has
      // to handle it.
      // @ts-expect-error not a StoredIconRead
      const npmIcon: Candidate['icon'] = { kind: 'none' }
      // @ts-expect-error not a StoredIconRead
      const repoIcon: RepoCandidate['icon'] = { kind: 'none' }
      // What the types keep out of a record the parse keeps out of the file.
      for (const icon of [npmIcon, repoIcon]) {
        expect(() => parseRepoState(rowWith({ icon }))).toThrow(message)
      }
    })

    it('leaves a record without an icon without one, never inventing the none read', () => {
      // Every committed record is in this state until the rule-3 re-read gets
      // to it, and absent is not a wrong shape.
      expect(parseRepoState(rowWith({}))['a/one']?.candidates[0]).not.toHaveProperty('icon')
    })

    it('keeps a carried candidate\'s icon through serialization and the next state', () => {
      const refusedIcon = readIconDeclaration({ icon: 7 })
      // The reader's answer, narrowed to what a record can hold: `IconRead`
      // itself no longer fits `RepoCandidate.icon`, which is the point.
      if (refusedIcon.kind !== 'refused') throw new Error('the fixture manifest declares an icon that is not a string, which is refused')
      const recorded: RepoState = {
        'a/one': { pushedAt: '2026-08-01T00:00:00Z', commit, candidates: [{ ...candidate('a/one'), icon: declaredIcon }] },
        'b/two': { pushedAt: '2026-08-01T00:00:00Z', commit, candidates: [{ ...candidate('b/two'), icon: refusedIcon }] },
      }
      const parsed = parseRepoState(serializeRepoState(recorded))
      expect(parsed).toEqual(recorded)
      // Untouched repositories carry their recorded candidates wholesale: the
      // search item says nothing about an icon, so nothing may drop it.
      const next = nextRepoState(parsed, [
        { repo: 'a/one', pushedAt: '2026-08-01T00:00:00Z' },
        { repo: 'b/two', pushedAt: '2026-08-01T00:00:00Z' },
      ], new Map())
      expect(next['a/one']?.candidates[0]?.icon).toEqual(declaredIcon)
      expect(next['b/two']?.candidates[0]?.icon).toEqual(refusedIcon)
    })

    it.each([
      ['null', null],
      ['a string', 'declared'],
      ['an array', [declaredIcon]],
      ['empty', {}],
      // What `readIconDeclaration` answers for a manifest that declares
      // nothing, and what the writer turns into an absent key.
      ['the none read', { kind: 'none' }],
      ['of a kind the reader never answers', { kind: 'withheld', detail: 'x' }],
      ['declared without its declaration', { kind: 'declared' }],
      ['declared with a null declaration', { kind: 'declared', declaration: null }],
      ['declared with an array for its declaration', { kind: 'declared', declaration: [ok] }],
      ['declared from a source that is neither dsh\'s', { kind: 'declared', declaration: { ...ok, source: 'field' } }],
      ['declared with no source', { kind: 'declared', declaration: { path: ok.path, mediaType: ok.mediaType } }],
      ['declared with an empty path', { kind: 'declared', declaration: { ...ok, path: '' } }],
      // A path is what a fetch builds a URL from, one encoded segment at a time,
      // and encoding leaves `.` and `..` alone: a URL parser reads them as
      // directions, and an empty segment as a different path. `readIconDeclaration`
      // normalises every path it writes, so a record holding one is a shape this
      // build never made, whatever the fetch would do with it.
      ['declared with a path that holds a dot segment', { kind: 'declared', declaration: { ...ok, path: 'assets/./icon.svg' } }],
      ['declared with a path that starts with a dot segment', { kind: 'declared', declaration: { ...ok, path: './icon.svg' } }],
      ['declared with a path that holds a dot-dot segment', { kind: 'declared', declaration: { ...ok, path: 'assets/../icon.svg' } }],
      ['declared with a path that climbs out of the package', { kind: 'declared', declaration: { ...ok, path: '../icon.svg' } }],
      ['declared with a path that is a dot-dot alone', { kind: 'declared', declaration: { ...ok, path: '..' } }],
      ['declared with a path that holds an empty segment', { kind: 'declared', declaration: { ...ok, path: 'assets//icon.svg' } }],
      ['declared with a path that starts at the root', { kind: 'declared', declaration: { ...ok, path: '/icon.svg' } }],
      ['declared with a path that ends in a slash', { kind: 'declared', declaration: { ...ok, path: 'assets/' } }],
      ['declared with a path that is not a string', { kind: 'declared', declaration: { ...ok, path: 7 } }],
      ['declared with no path', { kind: 'declared', declaration: { source: ok.source, mediaType: ok.mediaType } }],
      ['declared with a media type of no kind the reader writes', { kind: 'declared', declaration: { ...ok, mediaType: 'image/gif' } }],
      // Own keys only: an index read or an `in` test on the member tables
      // would answer for `Object.prototype`.
      ['declared with a media type that is only a name on Object.prototype', { kind: 'declared', declaration: { ...ok, mediaType: 'constructor' } }],
      ['declared from a source that is only a name on Object.prototype', { kind: 'declared', declaration: { ...ok, source: 'toString' } }],
      ['declared with no media type', { kind: 'declared', declaration: { source: ok.source, path: ok.path } }],
      // Both are published or built into keys by whatever reads them, so a key
      // the harvest never wrote would go out under the author's name.
      ['declared with a key the reader never writes in its declaration', { kind: 'declared', declaration: { ...ok, subdir: 'packages/a' } }],
      ['declared beside a detail', { kind: 'declared', declaration: ok, detail: 'x' }],
      ['refused without its detail', { kind: 'refused' }],
      ['refused with a detail that is not a string', { kind: 'refused', detail: 5 }],
      ['refused beside a declaration', { kind: 'refused', detail: 'x', declaration: ok }],
    ])('throws on an icon that is %s', (_label, icon) => {
      expect(() => parseRepoState(rowWith({ icon }))).toThrow(message)
    })
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

describe('the entry-check record (design 2026-09-26-market-borrowings §9.4, §9.6)', () => {
  const seen = (repo: string) => ({ repo, pushedAt: '2026-08-01T00:00:00Z' })
  const stateWith = (overrides: Partial<RepoCandidate>): RepoState => ({
    'o/r': { pushedAt: '2026-08-01T00:00:00Z', commit, candidates: [{ ...candidate('o/r'), ...overrides }] },
  })

  it('queues an unmarked listable candidate for one backfill fetch', () => {
    const { entriesChecked: _marker, ...unmarked } = candidate('o/r')
    const state: RepoState = { 'o/r': { pushedAt: '2026-08-01T00:00:00Z', commit, candidates: [unmarked] } }
    expect(diffRepoState(state, [seen('o/r')]).toFetch).toEqual([{ ...seen('o/r'), backfillOnly: true }])
  })

  it('does not queue a marked candidate, or a release-rescued one', () => {
    expect(diffRepoState(stateWith({}), [seen('o/r')]).toFetch).toEqual([])
    const { entriesChecked: _marker, ...unmarked } = candidate('o/r')
    const rescued: RepoState = {
      'o/r': {
        pushedAt: '2026-08-01T00:00:00Z', commit,
        candidates: [{ ...unmarked, release: { tag: 'v1', url: 'https://github.com/o/r/releases/download/v1/a.tgz', sha256: 'c'.repeat(64), assetVerified: true } }],
      },
    }
    expect(diffRepoState(rescued, [seen('o/r')]).toFetch).toEqual([])
  })

  it('round-trips both fields', () => {
    const state = stateWith({ unbuilt: { insert: 'dsh-r', path: 'lib/index.js' } })
    expect(parseRepoState(serializeRepoState(state))).toEqual(state)
  })

  it.each([
    ['a marker that is not true', { entriesChecked: 'yes' }],
    ['a finding without the marker', { entriesChecked: undefined, unbuilt: { patch: './x.yml' } }],
    ['a finding of neither shape', { unbuilt: { patch: './x.yml', insert: 'x' } }],
    ['an empty finding string', { unbuilt: { patch: '' } }],
    ['a finding string past its bound', { unbuilt: { patch: 'p'.repeat(201) } }],
  ])('refuses %s', (_what, overrides) => {
    const text = serializeRepoState(stateWith(overrides as Partial<RepoCandidate>))
    expect(() => parseRepoState(text)).toThrow(/malformed entry-check record/)
  })

  it('does not queue a candidate the check refused, so the backfill ends', () => {
    // The finding makes canEverList false, and lacksEntryCheck asks it.
    expect(diffRepoState(stateWith({ unbuilt: { patch: './cordis.patch.yml' } }), [seen('o/r')]).toFetch).toEqual([])
  })

  it('does not queue a refused candidate even when its marker is lost', () => {
    const { entriesChecked: _marker, ...unmarked } = candidate('o/r')
    const state: RepoState = { 'o/r': { pushedAt: '2026-08-01T00:00:00Z', commit, candidates: [{ ...unmarked, unbuilt: { patch: './cordis.patch.yml' } }] } }
    expect(diffRepoState(state, [seen('o/r')]).toFetch).toEqual([])
  })
})
