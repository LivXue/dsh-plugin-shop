import { describe, expect, it } from 'vitest'
import { identityKey, installedSpecMatches, parseRepoSpec } from '../../src/shared/identity.ts'
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

  it('never matches a github entry carrying no repo', () => {
    expect(installedSpecMatches({ ...repoEntry, repo: undefined }, 'github:alice/dsh-foo')).toBe(false)
  })
})
