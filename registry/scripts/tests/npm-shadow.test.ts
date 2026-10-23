import { describe, expect, it } from 'vitest'
import { parseRegistryConfig } from '../src/config.ts'
import { gate } from '../src/gate.ts'
import { acceptedNpmRepositories, npmShadowOf } from '../src/npm-shadow.ts'
import type { Candidate, RepoCandidate } from '../src/types.ts'

const commit = 'a'.repeat(40)

/** A gate-passing npm candidate; no `catalog`, so the gate derives a listing. */
function npm(overrides: Partial<Candidate> = {}): Candidate {
  return {
    name: 'dsh-x',
    version: '1.0.0',
    integrity: 'sha512-abc',
    publishedAt: '2026-08-01T12:00:00.000Z',
    repository: 'https://github.com/alice/dsh-x',
    license: 'MIT',
    deprecated: false,
    hasBundle: true,
    catalog: undefined,
    description: 'An npm plugin.',
    keywords: ['dsh'],
    peers: [],
    ...overrides,
  }
}

/** A gate-passing repo candidate: alice's `dsh-x`. */
function repo(overrides: Partial<RepoCandidate> = {}): RepoCandidate {
  return {
    name: 'dsh-x',
    repo: 'alice/dsh-x',
    commit,
    version: commit,
    publishedAt: '2026-08-01T12:00:00.000Z',
    repository: 'https://github.com/alice/dsh-x',
    license: 'MIT',
    hasBundle: true,
    requiresBuild: false,
    hasWorkspaceDeps: false,
    catalog: undefined,
    description: 'A repo plugin.',
    ...overrides,
  }
}

// The three sentences an author reads in report.md, written out here and not
// imported: the published copy is what is under test, so rewording it in the
// module has to fail these cases until this file says the same.

/** The npm package names this very repository. */
function ownDetail(npm: string): string {
  return `The npm package ${npm} names this repository as its source and is already listed; the repository is not listed separately.`
}

/**
 * The npm package names a different `owner/name` of the candidate's owner:
 * this repository under an earlier name, or another one, which a string
 * comparison cannot tell apart.
 */
function sameOwnerDetail(npm: string, declared: string): string {
  return `The npm package ${npm} is already listed and names ${declared} as its source: a repository of the same owner, either this one under an earlier name or another. This repository is not listed separately. If it is a different plugin, giving it a package name of its own lets the catalog judge it on its own.`
}

/** The npm package names a repository the rule cannot read as a GitHub URL. */
function unparsedDetail(npm: string): string {
  return `The npm package ${npm} is already listed, and the repository it names is not a plain https://github.com/owner/name URL, so this repository cannot be told apart from it and is not listed separately. If it is a different plugin, giving it a package name of its own lets the catalog judge it on its own.`
}

describe('npmShadowOf', () => {
  it('returns null for a name no accepted npm package holds', () => {
    // The package that IS held declares this candidate's own repository, so
    // only the name lookup can keep the candidate listed.
    const acceptedNpm = new Map([['dsh-other', 'https://github.com/alice/dsh-x']])
    expect(npmShadowOf(repo(), acceptedNpm)).toBeNull()
  })

  it('hides the npm package\'s own repository, whatever its case', () => {
    const row = npmShadowOf(repo(), new Map([['dsh-x', 'https://github.com/Alice/DSH-X']]))
    expect(row).toMatchObject({ name: 'alice/dsh-x', code: 'shadowed-by-npm' })
    expect(row?.detail).toBe(ownDetail('dsh-x'))
  })

  it('names a hidden monorepo subpackage by its repo#subdir unit', () => {
    // C-6: one monorepo hides several subpackages, and each is its own row
    // instead of N identical ones whose order followed the harvest.
    const candidate = repo({
      repo: 'alice/mono',
      subdir: 'packages/x',
      repository: 'https://github.com/alice/mono',
    })
    const row = npmShadowOf(candidate, new Map([['dsh-x', 'https://github.com/alice/mono']]))
    expect(row).toMatchObject({ name: 'alice/mono#packages/x', code: 'shadowed-by-npm' })
    expect(row?.detail).toBe(ownDetail('dsh-x'))
  })

  it('hides a different owner/name of the same owner, naming the one the npm package declares', () => {
    // The sentence quotes the declared repository in the case its author
    // wrote, not a folded copy: `Alice/dsh-x-npm`, though the owner compares
    // as `alice`.
    const row = npmShadowOf(repo(), new Map([['dsh-x', 'https://github.com/Alice/dsh-x-npm']]))
    expect(row).toMatchObject({ name: 'alice/dsh-x', code: 'shadowed-by-npm' })
    expect(row?.detail).toBe(sameOwnerDetail('dsh-x', 'Alice/dsh-x-npm'))
  })

  // The two cases below need the candidate's side folded. The search returns
  // `owner/slug` in the case GitHub holds it, and an npm `repository` is
  // often written in lower case: on 2026-10-19, 1,917 of the 4,581 rows whose
  // npm package named their own repository carried an upper-case letter in
  // the candidate's `repo`. Every other candidate in this file is lower case,
  // so these two are the ones that fail if that fold is dropped.

  it('hides the npm package\'s own repository when the candidate\'s repo is the one in mixed case', () => {
    const candidate = repo({ repo: 'StarsHarryZhu/Dsh-X', repository: 'https://github.com/StarsHarryZhu/Dsh-X' })
    const row = npmShadowOf(candidate, new Map([['dsh-x', 'https://github.com/starsharryzhu/dsh-x']]))
    expect(row).toMatchObject({ name: 'StarsHarryZhu/Dsh-X', code: 'shadowed-by-npm' })
    expect(row?.detail).toBe(ownDetail('dsh-x'))
  })

  it('hides a repository of the same owner when the candidate\'s owner is the one in mixed case', () => {
    const candidate = repo({ repo: 'StarsHarryZhu/Dsh-X', repository: 'https://github.com/StarsHarryZhu/Dsh-X' })
    const row = npmShadowOf(candidate, new Map([['dsh-x', 'https://github.com/starsharryzhu/dsh-x-npm']]))
    expect(row).toMatchObject({ name: 'StarsHarryZhu/Dsh-X', code: 'shadowed-by-npm' })
    expect(row?.detail).toBe(sameOwnerDetail('dsh-x', 'starsharryzhu/dsh-x-npm'))
  })

  it.each([
    'https://gitee.com/alice/dsh-x',
    'ssh://git@github.com/alice/dsh-x',
    'github:alice/dsh-x',
    'https://github.com/alice/dsh-x/tree/main/packages/x',
    'https://www.github.com/alice/dsh-x',
  ])('hides a repository it cannot compare, for each unreadable spelling: %s', (repository) => {
    // Each spelling points at alice's repository to a human reader and is not
    // a plain https://github.com/owner/name URL, so `githubOwnerName`
    // (unchanged: its no-guesses rule is shared with the stars sidecar and the
    // denial check) answers null. With nothing to compare, the candidate stays
    // hidden as it was. If that function ever learns one of the GitHub
    // spellings, that row here changes and this case says so.
    const row = npmShadowOf(repo(), new Map([['dsh-x', repository]]))
    expect(row).toMatchObject({ name: 'alice/dsh-x', code: 'shadowed-by-npm' })
    expect(row?.detail).toBe(unparsedDetail('dsh-x'))
  })

  it('leaves another owner\'s repository to the gate', () => {
    // Issue #88: yunyv's npm package and gulagala001's repository share a
    // name and nothing else.
    const candidate = repo({
      name: 'dsh-intelligent-ui',
      repo: 'gulagala001/dsh-intelligent-ui',
      repository: 'https://github.com/gulagala001/dsh-intelligent-ui',
    })
    const acceptedNpm = new Map([['dsh-intelligent-ui', 'https://github.com/yunyv/dsh-intelligent-ui']])
    expect(npmShadowOf(candidate, acceptedNpm)).toBeNull()
  })

  it('does not read an owner that is a prefix of the candidate\'s owner as the same owner', () => {
    // `ali` begins `alice`. Only the slash that ends the owner in the
    // comparison keeps the two apart.
    expect(npmShadowOf(repo(), new Map([['dsh-x', 'https://github.com/ali/dsh-x']]))).toBeNull()
  })

  it('compares the candidate\'s repo, not its repository field', () => {
    // `repository` names alice and `repo` says bob. The owner is the one in
    // `repo`, the search's own `owner/slug`, so this is another owner's
    // repository.
    const candidate = repo({ repo: 'bob/dsh-x', repository: 'https://github.com/alice/dsh-x' })
    expect(npmShadowOf(candidate, new Map([['dsh-x', 'https://github.com/alice/dsh-x']]))).toBeNull()
  })
})

describe('acceptedNpmRepositories', () => {
  it('maps each package the gate accepted to the repository it declares, as declared', () => {
    // `npmShadowOf` reads the declared string itself, so the map carries it
    // unchanged: in its author's case, which a same-owner detail quotes, and a
    // `github:` spelling as one, which is case 2 there.
    const config = parseRegistryConfig({
      verified: '[]', denied: '[]', allowedSimilar: '[]', withheldIcons: '[]', categories: '[]', firstSeen: '[]',
    })
    const accepted = [
      npm({ name: 'dsh-a', repository: 'https://github.com/Alice/dsh-a' }),
      npm({ name: 'dsh-b', repository: 'github:bob/dsh-b' }),
    ].flatMap(candidate => {
      const result = gate(candidate, config)
      return result.ok ? [result.accepted] : []
    })
    expect([...acceptedNpmRepositories(accepted)]).toEqual([
      ['dsh-a', 'https://github.com/Alice/dsh-a'],
      ['dsh-b', 'github:bob/dsh-b'],
    ])
  })
})
