import { describe, expect, it } from 'vitest'
import { parseRegistryConfig } from '../src/config.ts'
import { gate } from '../src/gate.ts'
import { gateRepo } from '../src/repo-gate.ts'
import { selectPending } from '../src/classify-select.ts'
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

  it('skips a repo candidate shadowed by an accepted npm package of the same name', () => {
    // pipeline.ts lists npm and records the repo as shadowed-by-npm. Classifying
    // it would attach a category derived from the repo description to a name the
    // catalog serves from npm. The npm entry here is declared, so the name is
    // live in neither half: an author-declared category owns the row.
    const declared = npm({
      name: 'dsh-same-name',
      catalog: { category: 'tool', summary: { en: 'x', zh: 'y' }, capabilities: [] },
    })
    // The fixture must be ACCEPTED-declared, not an invalid-catalog rejection:
    // a rejected npm package does not shadow, and this test would then pass
    // while proving nothing. (`summary.zh` is required in a declared section.)
    expect(gate(declared, config).ok).toBe(true)
    const { pending, liveNames } = selectPending([declared], [repo({ name: 'dsh-same-name' })], config)
    expect(pending).toEqual([])
    expect(liveNames.has('dsh-same-name')).toBe(false)
  })

  it('still classifies a repo whose npm namesake the gate rejected', () => {
    // The shadow set is the ACCEPTED npm names, exactly as pipeline.ts builds
    // it: a rejected npm package leaves the repository listed on its own.
    const rejected = npm({ name: 'dsh-same-name', hasBundle: false })
    const { pending, liveNames } = selectPending([rejected], [repo({ name: 'dsh-same-name' })], config)
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
