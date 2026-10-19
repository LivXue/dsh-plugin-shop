import { describe, expect, it } from 'vitest'
import { parseRegistryConfig } from '../src/config.ts'
import { gate } from '../src/gate.ts'
import { gateRepo } from '../src/repo-gate.ts'
import { selectPending } from '../src/classify-select.ts'
import { selectEntries, withholdRepoPeers } from '../src/pipeline.ts'
import type { Candidate, RepoCandidate } from '../src/types.ts'

const commit = 'a'.repeat(40)

const configWith = (categories: string): ReturnType<typeof parseRegistryConfig> =>
  parseRegistryConfig({
    verified: '[]',
    denied: '[]',
    allowedSimilar: '[]',
    categories,
    firstSeen: '[]',
  })

const config = configWith('[]')

/** A gate-passing npm candidate; no `catalog`, so the gate derives a listing. */
function npm(overrides: Partial<Candidate> = {}): Candidate {
  return {
    name: 'dsh-npm-plugin',
    version: '1.0.0',
    integrity: 'sha512-abc',
    publishedAt: '2026-08-01T12:00:00.000Z',
    repository: 'https://github.com/you/npm-plugin',
    license: 'MIT',
    deprecated: false,
    hasBundle: true,
    catalog: undefined,
    description: 'An npm plugin.',
    keywords: ['dsh', 'tool'],
    peers: [],
    ...overrides,
  }
}

/** A gate-passing repo candidate; no `catalog`, so the gate derives a listing. */
function repo(overrides: Partial<RepoCandidate> = {}): RepoCandidate {
  return {
    name: 'dsh-repo-plugin',
    repo: 'someone/dsh-repo-plugin',
    commit,
    version: commit,
    publishedAt: '2026-08-01T12:00:00.000Z',
    repository: 'https://github.com/someone/dsh-repo-plugin',
    license: 'MIT',
    hasBundle: true,
    requiresBuild: false,
    hasWorkspaceDeps: false,
    catalog: undefined,
    description: 'A repo plugin.',
    ...overrides,
  }
}

describe('selectPending', () => {
  it('sends an unclassified derived npm listing with its npm keywords', () => {
    const { pending, liveNames } = selectPending([npm()], [], config)
    expect(pending).toEqual([{ name: 'dsh-npm-plugin', description: 'An npm plugin.', keywords: ['dsh', 'tool'] }])
    expect([...liveNames]).toEqual(['dsh-npm-plugin'])
  })

  it('sends an unclassified derived repo listing, with no keywords to carry', () => {
    // RepoCandidate has a description and no keywords: the GitHub half of the
    // harvest never reads manifest keywords, and back-filling them would mean
    // re-fetching every recorded repo.
    const { pending, liveNames } = selectPending([], [repo()], config)
    expect(pending).toEqual([{ name: 'dsh-repo-plugin', description: 'A repo plugin.', keywords: [] }])
    expect([...liveNames]).toEqual(['dsh-repo-plugin'])
  })

  it('keeps an already-classified repo name live so its row survives the prune', () => {
    // The load-bearing case: mergeCategoryRows deletes every row whose name is
    // absent from liveNames. A github name missing here loses its category on
    // the very next run — which is why every repo entry read `other`.
    const { pending, liveNames } = selectPending([], [repo()], configWith('- name: dsh-repo-plugin\n  category: ui\n'))
    expect(pending).toEqual([])
    expect(liveNames.has('dsh-repo-plugin')).toBe(true)
  })

  it('skips the repository an accepted npm package names as its source', () => {
    // pipeline.ts lists npm and records the repo as shadowed-by-npm. Classifying
    // it would attach a category derived from the repo description to a name the
    // catalog serves from npm. The npm entry here is declared, so the name is
    // live in neither half: an author-declared category owns the row. The repo
    // is the `you/npm-plugin` the fixture package declares; another owner's
    // repository of the name is listed beside the package, not hidden by it
    // (the case below).
    const declared = npm({
      name: 'dsh-same-name',
      catalog: { category: 'tool', summary: { en: 'x', zh: 'y' }, capabilities: [] },
    })
    // The fixture must be ACCEPTED-declared, not an invalid-catalog rejection:
    // a rejected npm package does not shadow, and this test would then pass
    // while proving nothing. (`summary.zh` is required in a declared section.)
    expect(gate(declared, config).ok).toBe(true)
    const { pending, liveNames } = selectPending(
      [declared],
      [repo({ name: 'dsh-same-name', repo: 'you/npm-plugin', repository: 'https://github.com/you/npm-plugin' })],
      config,
    )
    expect(pending).toEqual([])
    expect(liveNames.has('dsh-same-name')).toBe(false)
  })

  it('classifies another owner\'s repository beside an accepted npm namesake', () => {
    // The same declared package as above, and the default `someone/…`
    // repository, which is derived. The package does not name it and its owner
    // does not own it, so pipeline.ts lists it beside the package and its name
    // is live: the row has to survive the prune, and it is asked for if it has
    // none.
    const declared = npm({
      name: 'dsh-same-name',
      catalog: { category: 'tool', summary: { en: 'x', zh: 'y' }, capabilities: [] },
    })
    expect(gate(declared, config).ok).toBe(true)
    const { pending, liveNames } = selectPending([declared], [repo({ name: 'dsh-same-name' })], config)
    expect(pending).toEqual([{ name: 'dsh-same-name', description: 'A repo plugin.', keywords: [] }])
    expect(liveNames.has('dsh-same-name')).toBe(true)
  })

  it('still classifies a repo whose npm namesake the gate rejected', () => {
    // The shadow map holds only the ACCEPTED npm packages, each name with the
    // repository it declares, built by the same `acceptedNpmRepositories` as
    // pipeline.ts's: a rejected npm package is not in it and leaves the
    // repository listed on its own. The repo is the one the rejected package
    // names as its source, so an accepted package would hide it and only the
    // rejection explains the result.
    const rejected = npm({ name: 'dsh-same-name', hasBundle: false })
    const { pending, liveNames } = selectPending(
      [rejected],
      [repo({ name: 'dsh-same-name', repo: 'you/npm-plugin', repository: 'https://github.com/you/npm-plugin' })],
      config,
    )
    expect(pending.map(p => p.name)).toEqual(['dsh-same-name'])
    expect(liveNames.has('dsh-same-name')).toBe(true)
  })

  it('leaves a repo that declares its own catalog out of both sets', () => {
    const declared = repo({ catalog: { category: 'ui', summary: { en: 'x', zh: 'y' }, capabilities: [] } })
    // Accepted-as-declared, not rejected: both outcomes are empty sets here,
    // so without this the test would hold for the wrong reason.
    expect(gateRepo(declared, config).ok).toBe(true)
    const { pending, liveNames } = selectPending([], [declared], config)
    expect(pending).toEqual([])
    expect(liveNames.size).toBe(0)
  })

  it('leaves a gate-rejected repo out of both sets', () => {
    const { pending, liveNames } = selectPending([], [repo({ license: null })], config)
    expect(pending).toEqual([])
    expect(liveNames.size).toBe(0)
  })

  it('asks once for a bundle name two repositories both claim', () => {
    // Measured on the live catalog: 2826 repo entries carry 2704 distinct
    // manifest names — 83 names are claimed by a fork as well as an original.
    const candidates = [
      repo({ repo: 'first/dsh-fork-bait', description: 'The original.' }),
      repo({ repo: 'second/dsh-fork-bait', description: 'The fork.' }),
    ]
    const { pending } = selectPending([], candidates, config)
    expect(pending).toEqual([{ name: 'dsh-repo-plugin', description: 'The original.', keywords: [] }])
  })

  it('orders the questions by name so the same inputs produce the same batches', () => {
    const { pending } = selectPending(
      [npm({ name: 'dsh-zulu' }), npm({ name: 'dsh-mike' })],
      [repo({ name: 'dsh-alpha' })],
      config,
    )
    expect(pending.map(p => p.name)).toEqual(['dsh-alpha', 'dsh-mike', 'dsh-zulu'])
  })
})

describe('a github repository whose peers alone cross the payload budget', () => {
  // Design 2026-09-01-harness-compatibility section 9.8, "The classifier
  // gates the candidates the build lists": build.ts always withholds github
  // `peers` before its own gate passes (SHOP_EMIT_REPO_PEERS is '0' by default), but
  // classify.ts used to read repo-state.json's raw record — peers still
  // attached — straight into this same selectPending/gateRepo pass. A
  // repository whose peers alone push it past the 12 KiB payload budget then
  // listed (build.ts's withheld copy fits) but dropped out of `liveNames` on
  // the very next run (classify's raw copy does not), which deleted its
  // categories.yml row and left it reading `other` forever. 128 names of 128
  // characters is the same fixture pipeline.test.ts's "does not charge
  // withheld peers to the payload budget" proves at 17,959 bytes, well past
  // the 12,288-byte budget.
  const heavyPeers = Array.from({ length: 128 }, (_, index) => `${'p'.repeat(124)}-${String(index).padStart(3, '0')}`)
  const heavy = repo({ name: 'dsh-heavy-peers', repo: 'someone/dsh-heavy-peers', peers: heavyPeers })

  it('is dropped from liveNames when gated with peers still attached, as classify.ts used to', () => {
    expect(gateRepo(heavy, config).ok).toBe(false)
    const { liveNames } = selectPending([], [heavy], config)
    expect(liveNames.has('dsh-heavy-peers')).toBe(false)
  })

  it('stays in liveNames once withheld the same way build.ts withholds them', () => {
    const withheld = withholdRepoPeers([heavy], false).candidates
    const { liveNames } = selectPending([], withheld, config)
    expect(liveNames.has('dsh-heavy-peers')).toBe(true)
  })

  it('agrees with the raw candidate once SHOP_EMIT_REPO_PEERS is on, because withholding is then a no-op', () => {
    const passthrough = withholdRepoPeers([heavy], true).candidates
    const raw = selectPending([], [heavy], config)
    const emitted = selectPending([], passthrough, config)
    expect(raw.liveNames.has('dsh-heavy-peers')).toBe(false)
    expect(emitted.liveNames.has('dsh-heavy-peers')).toBe(false)
  })
})

describe('selectPending agrees with selectEntries', () => {
  // Both build the accepted-npm map with acceptedNpmRepositories and ask
  // npmShadowOf which repositories it hides (design
  // 2026-10-19-npm-shadow-by-owner §4). If they read it differently, a name the
  // build lists drops out of `liveNames` and the next prune deletes its
  // category row. The agreement is on the same inputs, which is what this case
  // gives both; in production the classifier's repositories are a build
  // behind, the lag §4 names.
  it('makes liveNames exactly the names of the derived entries the build lists', () => {
    // Each verdict alone decides one name. Four names each have a DECLARED
    // npm package, which never makes its name live, and exactly one
    // repository, so the name is live exactly when that repository is not
    // hidden. A derived npm package would make its name live whatever became
    // of its repositories, and hide the verdicts on them.
    const declared = (name: string, repository: string): Candidate => npm({
      name,
      repository,
      catalog: { category: 'tool', summary: { en: 'x', zh: 'y' }, capabilities: [] },
    })
    const npmCandidates = [
      declared('dsh-own', 'https://github.com/you/dsh-own'),
      declared('dsh-same-owner', 'https://github.com/you/dsh-same-owner'),
      // Not a github.com URL, so a repository of this name cannot be compared
      // with it.
      declared('dsh-gitee', 'https://gitee.com/you/dsh-gitee'),
      declared('dsh-other-owner', 'https://github.com/you/dsh-other-owner'),
      // Derived, and so live on the npm side: the one name the build lists
      // twice, as this package and another owner's repository.
      npm({ name: 'dsh-twice', repository: 'https://github.com/you/dsh-twice' }),
    ]
    const at = (name: string, fullName: string): RepoCandidate =>
      repo({ name, repo: fullName, repository: `https://github.com/${fullName}` })
    const repoCandidates = [
      at('dsh-own', 'you/dsh-own'), // the package's own repository: hidden
      at('dsh-same-owner', 'you/dsh-same-owner-next'), // a different owner/name of its owner: hidden
      at('dsh-gitee', 'someone/dsh-gitee'), // nothing to compare: hidden
      at('dsh-other-owner', 'someone/dsh-other-owner'), // another owner's: listed
      at('dsh-twice', 'someone/dsh-twice'), // another owner's, beside a derived package: listed
    ]
    // What makes each verdict visible: every npm package is accepted (a
    // rejected one hides nothing), the first four as declared, and every
    // repository passes the gate on its own as derived (a rejected one would
    // stay out of liveNames whether it was hidden or not).
    const verdictOf = (result: ReturnType<typeof gate> | ReturnType<typeof gateRepo>): string =>
      result.ok ? result.accepted.metadata : result.rejection.code
    expect(npmCandidates.map(candidate => verdictOf(gate(candidate, config))))
      .toEqual(['declared', 'declared', 'declared', 'declared', 'derived'])
    expect(repoCandidates.map(candidate => verdictOf(gateRepo(candidate, config))))
      .toEqual(['derived', 'derived', 'derived', 'derived', 'derived'])

    const { liveNames } = selectPending(npmCandidates, repoCandidates, config)
    const { entries } = selectEntries(npmCandidates, repoCandidates, config, '2026-08-18T00:00:00.000Z')
    // A name is live once however many entries carry it: `dsh-twice` is an npm
    // entry and another owner's repository entry.
    const listed = [...new Set(entries.filter(entry => entry.metadata === 'derived').map(entry => entry.name))].sort()
    expect([...liveNames].sort()).toEqual(listed)
    // The names themselves: two readers that drifted the same way, or both
    // returned nothing, would still agree with each other.
    expect(listed).toEqual(['dsh-other-owner', 'dsh-twice'])
  })
})
