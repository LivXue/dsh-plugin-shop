import { describe, expect, it } from 'vitest'
import { holderLabel, identityKey, installedSpecMatches, parseRepoSpec, parseSpec, sameInstall, specVerdict } from '../../src/shared/identity.ts'
import type { CatalogEntry } from '../../src/host/types.ts'

const npmEntry: CatalogEntry = {
  name: 'dsh-foo', version: '1.2.0', integrity: null, publishedAt: null,
  repository: null, license: 'MIT', tier: 'community', metadata: 'derived', source: 'npm',
  added: '2026-08-25',
}
const repoEntry: CatalogEntry = {
  ...npmEntry, version: 'a'.repeat(40), source: 'github', repo: 'alice/dsh-foo',
}

describe('identityKey', () => {
  it('is the registry uniqueness rule verbatim', () => {
    expect(identityKey(npmEntry)).toBe('npm:dsh-foo')
    expect(identityKey(repoEntry)).toBe('github:alice/dsh-foo#')
    expect(identityKey({ ...repoEntry, subdir: 'packages/a' })).toBe('github:alice/dsh-foo#packages/a')
  })

  it('separates two repositories that publish the same package name', () => {
    expect(identityKey(repoEntry)).not.toBe(identityKey({ ...repoEntry, repo: 'bob/dsh-foo' }))
  })

  it('falls back to the name for a github entry carrying no repo', () => {
    expect(identityKey({ ...repoEntry, repo: undefined })).toBe('github:dsh-foo#')
  })
})

describe('parseRepoSpec', () => {
  it('reads the repo out of every spec form pnpm writes for a repo install', () => {
    expect(parseRepoSpec('github:alice/dsh-foo')).toBe('alice/dsh-foo')
    expect(parseRepoSpec('github:Alice/DSH-Foo')).toBe('alice/dsh-foo')
    expect(parseRepoSpec(`github:alice/dsh-foo#${'a'.repeat(40)}`)).toBe('alice/dsh-foo')
    expect(parseRepoSpec(`github:alice/dsh-foo#${'a'.repeat(40)}&path:packages/a`)).toBe('alice/dsh-foo')
    expect(parseRepoSpec('https://github.com/alice/dsh-foo/releases/download/v1.0.0/p.tgz')).toBe('alice/dsh-foo')
    expect(parseRepoSpec('git+https://github.com/alice/dsh-foo.git')).toBe('alice/dsh-foo')
  })

  it('answers null for every npm range spec, which is not a repo at all', () => {
    expect(parseRepoSpec('^1.0.0')).toBeNull()
    expect(parseRepoSpec('1.5.0')).toBeNull()
    expect(parseRepoSpec('workspace:*')).toBeNull()
    expect(parseRepoSpec('latest')).toBeNull()
    expect(parseRepoSpec('')).toBeNull()
  })
})

describe('installedSpecMatches', () => {
  it('matches an npm entry only against a spec that is not a repo', () => {
    expect(installedSpecMatches(npmEntry, '^1.0.0')).toBe(true)
    expect(installedSpecMatches(npmEntry, 'workspace:*')).toBe(true)
    expect(installedSpecMatches(npmEntry, 'github:bob/dsh-foo')).toBe(false)
  })

  it('matches a github entry only against a spec naming its own repo', () => {
    expect(installedSpecMatches(repoEntry, 'github:alice/dsh-foo')).toBe(true)
    expect(installedSpecMatches(repoEntry, 'github:bob/dsh-foo')).toBe(false)
    expect(installedSpecMatches(repoEntry, '^1.0.0')).toBe(false)
  })

  it('matches a release-rescued entry against the release URL pnpm recorded', () => {
    const rescued: CatalogEntry = {
      ...repoEntry, version: 'v1.0.0',
      tarball: { url: 'https://github.com/alice/dsh-foo/releases/download/v1.0.0/p.tgz', sha256: 'a'.repeat(64) },
    }
    expect(installedSpecMatches(rescued, 'https://github.com/alice/dsh-foo/releases/download/v1.0.0/p.tgz')).toBe(true)
    expect(installedSpecMatches(rescued, 'https://github.com/bob/dsh-foo/releases/download/v1.0.0/p.tgz')).toBe(false)
  })

  it('gives an unattributable spec to the npm entry alone, so one row owns it', () => {
    // Both same-named rows claiming it would show one dependency twice, with
    // an uninstall button on each.
    for (const spec of ['file:../fork', 'workspace:*', 'git+ssh://git@github.com/alice/dsh-foo.git']) {
      expect(installedSpecMatches(npmEntry, spec)).toBe(true)
      expect(installedSpecMatches(repoEntry, spec)).toBe(false)
    }
  })

  it('never matches a github entry carrying no repo', () => {
    expect(installedSpecMatches({ ...repoEntry, repo: undefined }, 'github:alice/dsh-foo')).toBe(false)
  })
})

describe('sameInstall', () => {
  // The rule behind both the host's `name-taken` refusal and the client's
  // badge. Callers have already matched on the bundle name, so this answers
  // only whether the thing under that name is this entry or another one.
  it('is true for two npm installs, whatever their versions', () => {
    const newer: CatalogEntry = { ...npmEntry, version: '9.9.9' }
    expect(sameInstall(npmEntry, newer)).toBe(true)
  })

  it('separates an npm install from a github one of the same name', () => {
    expect(sameInstall(npmEntry, repoEntry)).toBe(false)
    expect(sameInstall(repoEntry, npmEntry)).toBe(false)
  })

  it('separates two repositories publishing one bundle name', () => {
    // 83 live bundle names are claimed by both a fork and an original; this
    // is the comparison that keeps them apart.
    expect(sameInstall(repoEntry, { ...repoEntry, repo: 'bob/dsh-foo' })).toBe(false)
  })

  it('ignores repository case, which GitHub does not preserve for comparison', () => {
    expect(sameInstall(repoEntry, { ...repoEntry, repo: 'Alice/DSH-Foo' })).toBe(true)
  })

  it('is false when either side carries no repo, rather than collapsing them', () => {
    // Two unknowns are not a match: treating them as one would silently let a
    // malformed entry claim any name.
    expect(sameInstall({ ...repoEntry, repo: undefined }, repoEntry)).toBe(false)
    expect(sameInstall(repoEntry, { ...repoEntry, repo: undefined })).toBe(false)
    expect(sameInstall({ ...repoEntry, repo: undefined }, { ...repoEntry, repo: undefined })).toBe(false)
  })

  it('ignores subdir, which a dependency spec does not record', () => {
    // Coarser than identityKey on purpose: the installed state cannot tell
    // two subdirectories of one repository apart, so neither may this.
    expect(sameInstall(repoEntry, { ...repoEntry, subdir: 'packages/a' })).toBe(true)
  })
})

/** The spec forms a profile manifest actually carries, and what each one is.
 * `null` is "the grammar does not cover this", which is a THIRD answer and
 * never a synonym for npm — reading these as npm is what let an npm entry
 * replace a git or local install, and what named a local checkout "the npm
 * package". */
const SPECS: ReadonlyArray<readonly [string, ReturnType<typeof parseSpec>]> = [
  ['^1.0.0', { kind: 'npm' }],
  ['1.2.0', { kind: 'npm' }],
  ['1.x', { kind: 'npm' }],
  ['*', { kind: 'npm' }],
  ['>=1.0.0 <2.0.0', { kind: 'npm' }],
  ['github:CLAPEILL/dsh-foo', { kind: 'github', repo: 'CLAPEILL/dsh-foo' }],
  ['github:CLAPEILL/dsh-foo#abc', { kind: 'github', repo: 'CLAPEILL/dsh-foo' }],
  ['https://github.com/CLAPEILL/dsh-foo', { kind: 'github', repo: 'CLAPEILL/dsh-foo' }],
  ['git+https://github.com/CLAPEILL/dsh-foo.git', { kind: 'github', repo: 'CLAPEILL/dsh-foo' }],
  ['https://github.com/alice/dsh-foo/releases/download/v1.0.0/p.tgz', { kind: 'github', repo: 'alice/dsh-foo' }],
  // Every one of these read as npm before, and every one names something the
  // shop must not assume it may overwrite.
  ['git+ssh://git@github.com/CLAPEILL/dsh-foo.git', null],
  ['git@github.com:CLAPEILL/dsh-foo.git', null],
  ['file:../local-fork', null],
  ['link:../local-fork', null],
  ['workspace:*', null],
  ['npm:some-other-plugin@^2.0.0', null],
  ['https://gitlab.com/alice/dsh-foo/-/archive/main.tgz', null],
  ['', null],
]

describe('parseSpec', () => {
  it.each(SPECS)('attributes %s', (spec, origin) => {
    expect(parseSpec(spec)).toEqual(origin)
  })

  it('is the one parse parseRepoSpec reads, lowercased', () => {
    // The two used to apply the same regexes separately, so a grammar fix
    // could land in one and not the other.
    for (const [spec] of SPECS) {
      const origin = parseSpec(spec)
      expect(parseRepoSpec(spec)).toBe(origin?.kind === 'github' ? origin.repo.toLowerCase() : null)
    }
  })
})

describe('specVerdict', () => {
  it('answers same for a spec naming this very install', () => {
    expect(specVerdict(npmEntry, '^1.0.0')).toBe('same')
    expect(specVerdict(repoEntry, 'github:alice/dsh-foo')).toBe('same')
  })

  it('answers different for a spec naming another install of this name', () => {
    expect(specVerdict(repoEntry, 'github:bob/dsh-foo')).toBe('different')
    expect(specVerdict(npmEntry, 'github:bob/dsh-foo')).toBe('different')
    expect(specVerdict(repoEntry, '^1.0.0')).toBe('different')
  })

  it('answers unknown — not npm — for a spec it cannot attribute', () => {
    // The hole this closes: `sameInstall` short-circuits true for npm-vs-npm,
    // so an unattributable spec read as npm made the gate pass and pnpm
    // overwrote a git remote, a local checkout or an alias to another package.
    for (const spec of ['git+ssh://git@github.com/bob/dsh-foo.git', 'file:../fork', 'link:../fork', 'workspace:*', 'npm:other@1.0.0']) {
      expect(specVerdict(npmEntry, spec)).toBe('unknown')
      expect(specVerdict(repoEntry, spec)).toBe('unknown')
    }
  })
})

describe('holderLabel', () => {
  it('names a github holder by its repository, in the spec own spelling', () => {
    expect(holderLabel('github:CLAPEILL/dsh-foo#abc', 'dsh-foo')).toBe('CLAPEILL/dsh-foo')
    expect(holderLabel('https://github.com/CLAPEILL/dsh-foo.git', 'dsh-foo')).toBe('CLAPEILL/dsh-foo')
  })

  it('names an npm holder by a language-neutral token', () => {
    // Both halves wrap this token in their own sentence, so it must not carry
    // English prose into a Chinese card.
    expect(holderLabel('^1.0.0', 'dsh-foo')).toBe('npm:dsh-foo')
  })

  it('quotes a spec it cannot attribute rather than calling it npm', () => {
    expect(holderLabel('file:/home/me/dev/dsh-foo', 'dsh-foo')).toBe('file:/home/me/dev/dsh-foo')
    expect(holderLabel('git+ssh://git@github.com/bob/dsh-foo.git', 'dsh-foo'))
      .toBe('git+ssh://git@github.com/bob/dsh-foo.git')
  })

  it('renders a blank dependency value as a visible empty token', () => {
    // Quoted verbatim it would leave a hole in the sentence, which reads as a
    // bug in the shop rather than as a fact about the profile.
    expect(holderLabel('', 'dsh-foo')).toBe('\"\"')
  })

  it('caps a pathological spec instead of printing a wall of text', () => {
    // The profile manifest is not ours to trust.
    const label = holderLabel(`file:/${'x'.repeat(500)}`, 'dsh-foo')
    expect(label.length).toBe(80)
    expect(label.endsWith('…')).toBe(true)
  })
})
