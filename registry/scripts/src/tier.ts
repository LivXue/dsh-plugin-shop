import { gt } from 'semver'
import type { Accepted } from './gate.ts'
import type { RepoAccepted } from './repo-gate.ts'
import type { RegistryConfig } from './config.ts'
import type { Entry } from './types.ts'

/**
 * Assign a trust tier to one accepted candidate.
 *
 * A review is pinned to the version it covered: when the published version is
 * newer than `reviewedVersion` the entry becomes `verified-stale` and keeps
 * the review, so a consumer can name both versions. Attaching verification to
 * a package name instead would let an author publish a malicious version and
 * inherit the trust automatically.
 * @param accepted - a candidate that passed the gate.
 * @param config - the human-authored registry files.
 * @returns the published catalog entry.
 */
export function assignTier(accepted: Accepted, config: RegistryConfig): Entry {
  const { candidate } = accepted
  const review = config.verified.get(candidate.name)
  const base = {
    name: candidate.name,
    version: candidate.version,
    integrity: accepted.integrity,
    publishedAt: accepted.publishedAt,
    repository: accepted.repository,
    license: accepted.license,
    metadata: accepted.metadata,
    catalog: accepted.catalog,
    source: 'npm' as const,
  }
  // A review whose only pin is a commit belongs to a repo entry of the same
  // bundle name, not to this npm candidate.
  if (review === undefined || review.reviewedVersion === undefined) return { ...base, tier: 'community' }
  const stale = gt(candidate.version, review.reviewedVersion)
  return { ...base, tier: stale ? 'verified-stale' : 'verified', review }
}

/**
 * Assign a trust tier to one accepted repository candidate.
 *
 * The same pinning rule as npm, on commits: a review covers `reviewedCommit`,
 * and any other commit downgrades the entry to `verified-stale` while keeping
 * the review. Attaching verification to a repo instead would let an author
 * push a malicious commit and inherit the trust automatically.
 * @param accepted - a repository that passed the repo gate.
 * @param config - the human-authored registry files.
 * @returns the published catalog entry.
 */
export function assignRepoTier(accepted: RepoAccepted, config: RegistryConfig): Entry {
  const { repo } = accepted
  const review = config.verified.get(repo.name)
  const base = {
    name: repo.name,
    version: repo.commit,
    integrity: repo.commit,
    publishedAt: repo.publishedAt ?? '',
    repository: repo.repository,
    license: repo.license ?? '',
    metadata: accepted.metadata,
    catalog: accepted.catalog,
    source: 'github' as const,
    repo: repo.repo,
    ...(repo.subdir !== undefined ? { subdir: repo.subdir } : {}),
  }
  // A review whose only pin is a version belongs to an npm entry of the same
  // bundle name, not to this repo candidate.
  if (review === undefined || review.reviewedCommit === undefined) return { ...base, tier: 'community' }
  const stale = review.reviewedCommit !== repo.commit
  return { ...base, tier: stale ? 'verified-stale' : 'verified', review }
}
