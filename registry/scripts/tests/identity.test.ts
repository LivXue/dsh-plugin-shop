import { describe, expect, it } from 'vitest'
import {
  compareEntries, compareRejections, compareStrings, firstSeenKey, installIdentity, repoUnit,
} from '../src/identity.ts'
import type { Entry, Rejection } from '../src/types.ts'

function npmEntry(name: string): Entry {
  return {
    name, version: '1.0.0', integrity: `sha512-${name}`, publishedAt: '2026-08-01T12:00:00.000Z',
    repository: `https://github.com/you/${name}`, license: 'MIT', tier: 'community',
    metadata: 'declared',
    catalog: { category: 'tool', summary: { en: 'x', zh: 'y' }, capabilities: [] },
    source: 'npm',
    added: '2026-08-01',
  }
}

function repoEntry(name: string, repo: string, subdir?: string): Entry {
  return {
    ...npmEntry(name),
    source: 'github',
    repo,
    ...(subdir === undefined ? {} : { subdir }),
  }
}

describe('repoUnit', () => {
  it('is the repo for a root candidate and repo#subdir for a subpackage', () => {
    // The unit an author acts on — the string repo-gate.ts already used for
    // every rejection name, now shared so the shadow row cannot drift from it.
    expect(repoUnit({ repo: 'someone/dsh-repo-plugin' })).toBe('someone/dsh-repo-plugin')
    expect(repoUnit({ repo: 'someone/monorepo', subdir: 'packages/sub-plugin' }))
      .toBe('someone/monorepo#packages/sub-plugin')
  })
})

describe('installIdentity', () => {
  it('separates the two install channels and the subpackages within one repo', () => {
    expect(installIdentity(npmEntry('dsh-x'))).toBe('npm:dsh-x')
    expect(installIdentity(repoEntry('dsh-x', 'good/dsh-x'))).toBe('github:good/dsh-x#')
    expect(installIdentity(repoEntry('dsh-x', 'good/mono', 'packages/a')))
      .toBe('github:good/mono#packages/a')
  })

  it('distinguishes two repositories publishing the same bundle name', () => {
    // 151 live names are shared by 243 entries; dsh-skill-manager is claimed
    // by 14 repositories. A name is not an identity.
    expect(installIdentity(repoEntry('dsh-foo', 'alice/dsh-foo')))
      .not.toBe(installIdentity(repoEntry('dsh-foo', 'bob/dsh-foo')))
  })
})

describe('firstSeenKey', () => {
  it('keys an npm entry by name and a repo entry by lowercased owner/slug', () => {
    // `owner/slug` carries a slash and never a leading `@`, so it cannot
    // collide with an npm name in the one first-seen map. Lowercased because
    // GitHub resolves repository names case-insensitively — a repo that
    // changes its casing must not read as a new listing and re-stamp `added`.
    expect(firstSeenKey(npmEntry('dsh-x'))).toBe('dsh-x')
    expect(firstSeenKey(repoEntry('dsh-x', 'good/dsh-x'))).toBe('good/dsh-x')
    expect(firstSeenKey(repoEntry('dsh-x', 'Good/DSH-X'))).toBe('good/dsh-x')
    // The npm name is NOT folded: an npm name is a distinct string, and npm
    // still serves legacy uppercase names.
    expect(firstSeenKey(npmEntry('DSH-Legacy'))).toBe('DSH-Legacy')
  })
})

describe('compareEntries', () => {
  it('orders by name first, then by the rest of the identity', () => {
    expect(compareEntries(npmEntry('dsh-a'), npmEntry('dsh-b'))).toBe(-1)
    // github sorts before npm on a name tie ('g' < 'n'), and two repos with
    // the same bundle name order by repo — the tie that kept input order and
    // made the content hash depend on the harvest order (C-2).
    expect(compareEntries(repoEntry('dsh-a', 'alice/x'), npmEntry('dsh-a'))).toBe(-1)
    expect(compareEntries(repoEntry('dsh-a', 'alice/x'), repoEntry('dsh-a', 'bob/x'))).toBe(-1)
    expect(compareEntries(repoEntry('dsh-a', 'a/mono', 'packages/a'), repoEntry('dsh-a', 'a/mono', 'packages/b')))
      .toBe(-1)
    expect(compareEntries(npmEntry('dsh-a'), npmEntry('dsh-a'))).toBe(0)
  })
})

describe('compareRejections', () => {
  it('breaks a name tie on the code and then the detail', () => {
    const a: Rejection = { name: 'a/b', code: 'no-bundle', detail: 'x' }
    const b: Rejection = { name: 'a/b', code: 'no-license', detail: 'x' }
    const c: Rejection = { name: 'a/b', code: 'no-bundle', detail: 'y' }
    expect(compareRejections(a, b)).toBe(-1)
    expect(compareRejections(a, c)).toBe(-1)
    expect(compareRejections(a, a)).toBe(0)
  })
})

describe('compareStrings', () => {
  it('compares by code unit, with no locale involved', () => {
    expect(compareStrings('a', 'b')).toBe(-1)
    expect(compareStrings('b', 'a')).toBe(1)
    expect(compareStrings('a', 'a')).toBe(0)
    // Code-unit order, not dictionary order: purity requires the same answer
    // under every LANG.
    expect(compareStrings('Z', 'a')).toBe(-1)
  })
})
