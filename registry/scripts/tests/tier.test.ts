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
    '  repo: someone/dsh-tagged-plugin',
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
    '  repo: someone/dsh-commit-pinned',
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
    // Repo entries are keyed by lowercased `owner/slug` (identity.ts).
    '- name: someone/dsh-repo-plugin',
    '  added: 2026-08-13',
    '- name: someone/dsh-tagged-plugin',
    '  added: 2026-08-14',
    '- name: someone/dsh-commit-pinned',
    '  added: 2026-08-15',
    '- name: someone/dsh-version-pinned',
    '  added: 2026-08-16',
    '- name: bob/dsh-commit-pinned',
    '  added: 2026-08-17',
  ].join('\n') + '\n',
})

function accepted(
  name: string,
  version: string,
  metadata: Accepted['metadata'] = 'declared',
  publisher?: string,
): Accepted {
  return {
    candidate: {
      name, version, integrity: 'sha512-abc', publishedAt: '2026-08-01T12:00:00.000Z',
      repository: 'https://github.com/you/x', license: 'MIT', deprecated: false,
      hasBundle: true, catalog: {}, description: 'x', keywords: [], peers: [],
      ...(publisher !== undefined ? { publisher } : {}),
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
  it('carries the publishing npm account onto the entry', () => {
    // The shop shows this beside the npm page link so a person can see who
    // published the thing they are about to install — two packages with the
    // same text and different publishers are the case it answers.
    expect(assignTier(accepted('dsh-other-plugin', '1.0.0', 'declared', 'realauthor'), config).publisher)
      .toBe('realauthor')
  })

  it('omits the publisher when the candidate has none', () => {
    expect(assignTier(accepted('dsh-other-plugin', '1.0.0'), config).publisher).toBeUndefined()
    expect('publisher' in assignTier(accepted('dsh-other-plugin', '1.0.0'), config)).toBe(false)
  })

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

  // Rewritten 2026-09-03 (audit B-1). The old assertion — "treats a version
  // older than the review as verified" — PINNED the defect: `gt` only caught
  // newer versions, so anything at or below the reviewed version rendered
  // `verified` and skipped the install acknowledgement (host install.ts:36).
  // A `latest` behind the review is not a hypothetical: it is what a hotfix
  // published without `--tag` leaves behind (dsh-market incident,
  // 2026-08-31-market-borrowings §C-2) and what an unpublish produces. An npm
  // review now means the reviewed version and no other, exactly as the commit
  // and sha256 pins already did.
  it('downgrades a version OLDER than the review to verified-stale', () => {
    expect(assignTier(accepted('dsh-hello-plugin', '1.1.0'), config).tier).toBe('verified-stale')
  })

  it('downgrades a much older version to verified-stale and keeps the review', () => {
    const entry = assignTier(accepted('dsh-hello-plugin', '0.0.1'), config)
    expect(entry.tier).toBe('verified-stale')
    expect(entry.review?.reviewedVersion).toBe('1.2.0')
  })

  it('downgrades a prerelease of the reviewed version to verified-stale', () => {
    // 1.2.0-rc.9 sorts BELOW 1.2.0, so `gt` said "not newer" and the release
    // candidate inherited the verdict written about the release.
    expect(assignTier(accepted('dsh-hello-plugin', '1.2.0-rc.9'), config).tier).toBe('verified-stale')
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

  it('carries the candidate peer names onto the entry', () => {
    const input = accepted('dsh-other-plugin', '1.0.0')
    input.candidate.peers = ['@deepseek-ai/cordis', '@deepseek-ai/dsh-client-store']
    expect(assignTier(input, config).peers).toEqual(['@deepseek-ai/cordis', '@deepseek-ai/dsh-client-store'])
  })

  it('omits the field entirely when the package declares no peers', () => {
    const entry = assignTier(accepted('dsh-other-plugin', '1.0.0'), config)
    // Absent, not []: an empty array on every peerless entry is bytes that
    // carry no fact, on a file served to every reader.
    expect('peers' in entry).toBe(false)
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

  it('throws, naming the repository, when a repo identity has no first-seen row', () => {
    // The loud failure stays: `assignRepoTier` must never invent a date. The
    // pipeline resolves a first appearance before it gets here (B-9), so this
    // throw now means a caller skipped that resolution.
    expect(() => assignRepoTier(repoAccepted('dsh-unseen'), config))
      .toThrow('first-seen.yml: someone/dsh-unseen has no first-seen row')
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

  it('gives a fork of the reviewed bundle name no tier and no review', () => {
    // B-3 / A-4: `bob/dsh-commit-pinned` at the commit ALICE reviewed used to
    // list as `verified` — acknowledgement skipped — and at any other commit
    // as `verified-stale` carrying Alice's byline. The review names a
    // repository; a bundle name is claimed by up to 14 of them.
    const base = repoAccepted('dsh-commit-pinned')
    const fork = { ...base, repo: { ...base.repo, repo: 'bob/dsh-commit-pinned' } }
    const entry = assignRepoTier(fork, config)
    expect(entry.tier).toBe('community')
    expect(entry.review).toBeUndefined()
  })

  it('finds the review whatever case the repository is spelled in', () => {
    const base = repoAccepted('dsh-commit-pinned')
    const cased = { ...base, repo: { ...base.repo, repo: 'Someone/dsh-commit-pinned' } }
    expect(assignRepoTier(cased, config).tier).toBe('verified')
  })
})
