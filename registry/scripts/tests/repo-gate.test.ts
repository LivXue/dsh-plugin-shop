import { describe, expect, it } from 'vitest'
import { gateRepo } from '../src/repo-gate.ts'
import { parseRegistryConfig } from '../src/config.ts'
import type { RepoCandidate } from '../src/types.ts'

const config = parseRegistryConfig({
  verified: '- name: dsh-fs-tool\n  reviewedVersion: 1.0.0\n  reviewer: github:r\n  reviewCommit: abc\n  notes: fine\n',
  denied: '[]',
  allowedSimilar: '[]',
  categories: '[]',
})

const commit = 'a'.repeat(40)

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
    catalog: { category: 'tool', summary: { en: 'x', zh: 'y' }, capabilities: [] },
    description: 'A repo plugin.',
    ...overrides,
  }
}

describe('gateRepo', () => {
  it('accepts a repository with a bundle, license, and a declared catalog', () => {
    const result = gateRepo(repo(), config)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.accepted.metadata).toBe('declared')
  })

  it('rejects a repository whose manifest declares no dsh.bundle — the silent no-op install', () => {
    const result = gateRepo(repo({ hasBundle: false }), config)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.rejection.name).toBe('someone/dsh-repo-plugin')
      expect(result.rejection.code).toBe('no-bundle')
      expect(result.rejection.detail).toContain('plain dependency')
    }
  })

  it('rejects a repository without a license', () => {
    const result = gateRepo(repo({ license: null }), config)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.rejection.code).toBe('no-license')
  })

  it('derives a listing from the repo description when no dsh.catalog is declared', () => {
    const result = gateRepo(repo({ catalog: null, description: 'Derives from the description.' }), config)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.accepted.metadata).toBe('derived')
      expect(result.accepted.catalog.summary.en).toBe('Derives from the description.')
    }
  })

  it('rejects a repository with neither a catalog nor a description', () => {
    const result = gateRepo(repo({ catalog: null, description: null }), config)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.rejection.code).toBe('no-summary')
  })

  it('rejects a malformed declared catalog, never downgrading to derived', () => {
    const result = gateRepo(repo({ catalog: { category: 'not-a-category' } }), config)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.rejection.code).toBe('invalid-catalog')
  })

  it('denies by repo identity and by bundle name, preferring the repo as the key', () => {
    const denied = parseRegistryConfig({
      verified: '[]',
      denied: '- name: someone/dsh-repo-plugin\n  reason: known bad actor\n- name: dsh-denied-name\n  reason: bundle name denied\n',
      allowedSimilar: '[]',
      categories: '[]',
    })
    const byRepo = gateRepo(repo(), denied)
    expect(byRepo.ok).toBe(false)
    if (!byRepo.ok) expect(byRepo.rejection.name).toBe('someone/dsh-repo-plugin')
    const byName = gateRepo(repo({ repo: 'other/dsh-denied-name', name: 'dsh-denied-name' }), denied)
    expect(byName.ok).toBe(false)
    if (!byName.ok) expect(byName.rejection.code).toBe('denied')
  })

  it('holds a lookalike slug AND a lookalike bundle name for adjudication', () => {
    const bySlug = gateRepo(repo({ repo: 'someone/dsh-fs-tol', name: 'something-else' }), config)
    expect(bySlug.ok).toBe(false)
    if (!bySlug.ok) expect(bySlug.rejection.code).toBe('name-too-similar')
    const byName = gateRepo(repo({ repo: 'someone/original', name: 'dsh-fs-too1' }), config)
    expect(byName.ok).toBe(false)
    if (!byName.ok) expect(byName.rejection.code).toBe('name-too-similar')
  })
})

describe('workspace-deps and subpackage units', () => {
  it('rejects a manifest with workspace:-protocol dependencies, naming the exit', () => {
    const result = gateRepo(repo({ hasWorkspaceDeps: true }), config)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.rejection.code).toBe('workspace-deps')
      expect(result.rejection.detail).toContain('Publish the package to npm')
    }
  })

  it('names a subpackage rejection by repo#subdir — the unit an author fixes', () => {
    const result = gateRepo(repo({ subdir: 'packages/plugin', license: null }), config)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.rejection.name).toBe('someone/dsh-repo-plugin#packages/plugin')
      expect(result.rejection.code).toBe('no-license')
    }
  })
})
