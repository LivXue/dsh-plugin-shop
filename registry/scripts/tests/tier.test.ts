import { describe, expect, it } from 'vitest'
import { assignRepoTier, assignTier } from '../src/tier.ts'
import { parseRegistryConfig } from '../src/config.ts'
import type { Accepted } from '../src/gate.ts'
import type { RepoAccepted } from '../src/repo-gate.ts'

const commit = 'c'.repeat(40)
const reviewedSha256 = 'a'.repeat(64)

const config = parseRegistryConfig({
  verified: [
    '- name: dsh-hello-plugin',
    '  reviewedVersion: 1.2.0',
    '  reviewer: github:r',
    '  reviewCommit: abc',
    '  notes: fine',
    '- name: dsh-tagged-plugin',
    `  reviewedSha256: ${reviewedSha256}`,
    '  reviewer: github:r',
    '  reviewCommit: abc',
    '  notes: fine',
    '- name: dsh-version-pinned',
    '  reviewedVersion: 1.2.0',
    '  reviewer: github:r',
    '  reviewCommit: abc',
    '  notes: fine',
    '- name: dsh-commit-pinned',
    `  reviewedCommit: ${commit}`,
    '  reviewer: github:r',
    '  reviewCommit: abc',
    '  notes: fine',
  ].join('\n') + '\n',
  denied: '[]',
  allowedSimilar: '[]',
  categories: '[]',
  firstSeen: [
    '- name: dsh-hello-plugin',
    '  added: 2026-08-10',
    '- name: dsh-other-plugin',
    '  added: 2026-08-11',
    '- name: dsh-derived-plugin',
    '  added: 2026-08-12',
    '- name: dsh-repo-plugin',
    '  added: 2026-08-13',
    '- name: dsh-tagged-plugin',
    '  added: 2026-08-14',
    '- name: dsh-commit-pinned',
    '  added: 2026-08-15',
    '- name: dsh-version-pinned',
    '  added: 2026-08-16',
  ].join('\n') + '\n',
})

function accepted(name: string, version: string, metadata: Accepted['metadata'] = 'declared'): Accepted {
  return {
    candidate: {
      name, version, integrity: 'sha512-abc', publishedAt: '2026-08-01T12:00:00.000Z',
      repository: 'https://github.com/you/x', license: 'MIT', deprecated: false,
      hasBundle: true, catalog: {}, description: 'x', keywords: [], peers: [],
    },
    catalog: { category: 'tool', summary: { en: 'x', zh: 'y' }, capabilities: [] },
    integrity: 'sha512-abc',
    publishedAt: '2026-08-01T12:00:00.000Z',
    repository: 'https://github.com/you/x',
    license: 'MIT',
    metadata,
  }
}

describe('assignTier', () => {
  it('marks an unlisted package community and attaches no review', () => {
    const entry = assignTier(accepted('dsh-other-plugin', '1.0.0'), config)
    expect(entry.tier).toBe('community')
    expect(entry.review).toBeUndefined()
  })

  it('marks the reviewed version verified', () => {
    const entry = assignTier(accepted('dsh-hello-plugin', '1.2.0'), config)
    expect(entry.tier).toBe('verified')
    expect(entry.review?.reviewedVersion).toBe('1.2.0')
  })

  it('downgrades a newer version to verified-stale', () => {
    const entry = assignTier(accepted('dsh-hello-plugin', '1.3.0'), config)
    expect(entry.tier).toBe('verified-stale')
    expect(entry.review?.reviewedVersion).toBe('1.2.0')
  })

  it('downgrades a newer patch to verified-stale', () => {
    expect(assignTier(accepted('dsh-hello-plugin', '1.2.1'), config).tier).toBe('verified-stale')
  })

  it('treats a version older than the review as verified', () => {
    expect(assignTier(accepted('dsh-hello-plugin', '1.1.0'), config).tier).toBe('verified')
  })

  it('keeps the review attached when stale, so the UI can name both versions', () => {
    const entry = assignTier(accepted('dsh-hello-plugin', '2.0.0'), config)
    expect(entry.review).toEqual({
      reviewedVersion: '1.2.0', reviewer: 'github:r', reviewCommit: 'abc', notes: 'fine',
    })
  })

  it('copies the accepted fields onto the entry', () => {
    const entry = assignTier(accepted('dsh-other-plugin', '1.0.0'), config)
    expect(entry).toMatchObject({
      name: 'dsh-other-plugin', version: '1.0.0', integrity: 'sha512-abc',
      license: 'MIT', repository: 'https://github.com/you/x',
    })
  })

  it('copies metadata through unchanged', () => {
    const declared = assignTier(accepted('dsh-other-plugin', '1.0.0', 'declared'), config)
    const derived = assignTier(accepted('dsh-derived-plugin', '1.0.0', 'derived'), config)
    expect(declared.metadata).toBe('declared')
    expect(derived.metadata).toBe('derived')
  })

  it('lets a derived entry carry the verified tier, since a review reads the code, not the prose', () => {
    const entry = assignTier(accepted('dsh-hello-plugin', '1.2.0', 'derived'), config)
    expect(entry.tier).toBe('verified')
    expect(entry.metadata).toBe('derived')
  })

  it('attaches the first-seen date as added', () => {
    const entry = assignTier(accepted('dsh-other-plugin', '1.0.0'), config)
    expect(entry.added).toBe('2026-08-11')
  })

  it('throws when a listed name has no first-seen row', () => {
    expect(() => assignTier(accepted('dsh-unseen', '1.0.0'), config))
      .toThrow('first-seen.yml: dsh-unseen has no first-seen row')
  })
})

describe('assignRepoTier', () => {
  function repoAccepted(
    name: string,
    release?: { tag: string; url: string; sha256: string },
    pinnedCommit: string = commit,
  ): RepoAccepted {
    return {
      repo: {
        name,
        repo: `someone/${name}`,
        commit: pinnedCommit,
        version: pinnedCommit,
        publishedAt: '2026-08-01T12:00:00.000Z',
        repository: `https://github.com/someone/${name}`,
        license: 'MIT',
        hasBundle: true,
        requiresBuild: false,
        hasWorkspaceDeps: false,
        catalog: { category: 'tool', summary: { en: 'x', zh: 'y' }, capabilities: [] },
        description: 'x',
        ...(release !== undefined ? { release } : {}),
      },
      catalog: { category: 'tool', summary: { en: 'x', zh: 'y' }, capabilities: [] },
      metadata: 'declared',
    }
  }

  it('attaches the first-seen date as added', () => {
    expect(assignRepoTier(repoAccepted('dsh-repo-plugin'), config).added).toBe('2026-08-13')
  })

  it('throws when a repo name has no first-seen row', () => {
    expect(() => assignRepoTier(repoAccepted('dsh-unseen'), config))
      .toThrow('first-seen.yml: dsh-unseen has no first-seen row')
  })

  it('pins a release-rescued entry to its tag and tarball', () => {
    const entry = assignRepoTier(repoAccepted('dsh-tagged-plugin', {
      tag: 'v1.0.0',
      url: 'https://github.com/someone/dsh-tagged-plugin/releases/download/v1.0.0/plugin.tgz',
      sha256: reviewedSha256,
    }), config)
    expect(entry).toMatchObject({
      version: 'v1.0.0',
      integrity: reviewedSha256,
      source: 'github',
      repo: 'someone/dsh-tagged-plugin',
      tarball: {
        url: 'https://github.com/someone/dsh-tagged-plugin/releases/download/v1.0.0/plugin.tgz',
        sha256: reviewedSha256,
      },
    })
  })

  it('marks a release-rescued entry verified when the review covers its tarball sha256', () => {
    const entry = assignRepoTier(repoAccepted('dsh-tagged-plugin', {
      tag: 'v1.0.0',
      url: 'https://github.com/someone/dsh-tagged-plugin/releases/download/v1.0.0/plugin.tgz',
      sha256: reviewedSha256,
    }), config)
    expect(entry.tier).toBe('verified')
    expect(entry.review?.reviewedSha256).toBe(reviewedSha256)
  })

  it('downgrades a release-rescued entry whose tarball moved past the review', () => {
    const entry = assignRepoTier(repoAccepted('dsh-tagged-plugin', {
      tag: 'v1.1.0',
      url: 'https://github.com/someone/dsh-tagged-plugin/releases/download/v1.1.0/plugin.tgz',
      sha256: 'e'.repeat(64),
    }), config)
    expect(entry.tier).toBe('verified-stale')
    expect(entry.review?.reviewedSha256).toBe(reviewedSha256)
  })

  it('does not transfer a version-only review pin onto a release entry', () => {
    const entry = assignRepoTier(repoAccepted('dsh-version-pinned', {
      tag: 'v1.0.0',
      url: 'https://github.com/someone/dsh-version-pinned/releases/download/v1.0.0/plugin.tgz',
      sha256: 'd'.repeat(64),
    }), config)
    expect(entry.tier).toBe('community')
    expect(entry.review).toBeUndefined()
  })

  it('does not transfer a commit-only review pin onto a release entry', () => {
    const entry = assignRepoTier(repoAccepted('dsh-commit-pinned', {
      tag: 'v1.0.0',
      url: 'https://github.com/someone/dsh-commit-pinned/releases/download/v1.0.0/plugin.tgz',
      sha256: 'f'.repeat(64),
    }), config)
    expect(entry.tier).toBe('community')
    expect(entry.review).toBeUndefined()
  })

  it('keeps commit pinning for a non-release entry with a matching commit-only review', () => {
    const entry = assignRepoTier(repoAccepted('dsh-commit-pinned'), config)
    expect(entry.tier).toBe('verified')
    expect(entry.review?.reviewedCommit).toBe(commit)
  })

  it('downgrades a non-release entry whose commit moved past a commit-only review', () => {
    const entry = assignRepoTier(repoAccepted('dsh-commit-pinned', undefined, 'd'.repeat(40)), config)
    expect(entry.tier).toBe('verified-stale')
  })
})
