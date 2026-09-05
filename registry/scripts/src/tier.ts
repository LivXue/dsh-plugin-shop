import { firstSeenKey } from './identity.ts'
import type { Accepted } from './gate.ts'
import type { RepoAccepted } from './repo-gate.ts'
import type { RegistryConfig } from './config.ts'
import type { Entry } from './types.ts'

/**
 * The first-seen date for one listed IDENTITY, failing loudly when the map
 * has no row for it. A listed entry without a date would silently omit a
 * field every consumer of `added` expects.
 *
 * The key comes from {@link firstSeenKey}: the npm name, or the repository's
 * lowercased `owner/slug`. `runPipeline` resolves a first appearance to the
 * build date before calling either tier function, so a throw here means a
 * caller skipped that resolution.
 */
function firstSeenOf(config: RegistryConfig, key: string): string {
  const added = config.firstSeen.get(key)
  if (added === undefined) throw new Error(`first-seen.yml: ${key} has no first-seen row`)
  return added
}

/**
 * Assign a trust tier to one accepted candidate.
 *
 * A review is pinned to the exact version it covered: any other published
 * version — newer OR older — makes the entry `verified-stale` and keeps the
 * review, so a consumer can name both versions. Attaching verification to a
 * package name instead would let an author publish a malicious version and
 * inherit the trust automatically.
 *
 * "Newer" is not the test, because a `latest` BEHIND the review is a real
 * shape: a hotfix published without `--tag` moves `latest` backwards (the
 * dsh-market incident, 2026-08-31-market-borrowings §C-2), and an unpublish
 * does the same. Under the old `gt` comparison every such version rendered
 * `verified` and the Host skipped its install acknowledgement.
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
    added: firstSeenOf(config, candidate.name),
    // Absent stays absent: a packument that named no account must not gain
    // an empty one in the catalog.
    ...(candidate.publisher !== undefined ? { publisher: candidate.publisher } : {}),
    ...(candidate.peers.length > 0 ? { peers: candidate.peers } : {}),
  }
  // Defence in depth: a github review is keyed by its repository now, so it
  // can no longer be reached by an npm name at all (config.ts). If one ever
  // were, a commit pin still says nothing about this npm package.
  if (review === undefined || review.reviewedVersion === undefined) return { ...base, tier: 'community' }
  // Exact match, like the commit and sha256 pins. A string comparison IS a
  // semver comparison here because `config.ts` requires `reviewedVersion` to
  // be the canonical spelling (no leading `v`, no build metadata), so the
  // only strings that differ are versions that differ. A version differing
  // only by build metadata reads as stale, which is the safe direction.
  const stale = candidate.version !== review.reviewedVersion
  return { ...base, tier: stale ? 'verified-stale' : 'verified', review }
}

/**
 * Assign a trust tier to one accepted repository candidate.
 *
 * The same pinning rule as npm, on commits: a review covers `reviewedCommit`,
 * and any other commit downgrades the entry to `verified-stale` while keeping
 * the review. Attaching verification to a repo instead would let an author
 * push a malicious commit and inherit the trust automatically. A
 * release-rescued candidate (`release` present) is pinned to its tarball
 * sha256 instead: the tag is a mutable ref an author can delete and re-create
 * on different content, so the trust pin must be the content-addressed
 * sha256 — pins never transfer across identity kinds (npm→version,
 * repo→commit, release→sha256).
 * @param accepted - a repository that passed the repo gate.
 * @param config - the human-authored registry files.
 * @returns the published catalog entry.
 */
export function assignRepoTier(accepted: RepoAccepted, config: RegistryConfig): Entry {
  const { repo } = accepted
  // By repository, never by bundle name. A review binds (repo, commit): 83
  // live bundle names are claimed by both a fork and an original and
  // `dsh-skill-manager` by 14 repositories, so a name lookup handed every one
  // of them the verdict, the reviewer's byline and — at the reviewed commit —
  // the skipped install acknowledgement. Lowercased because GitHub resolves
  // repository names case-insensitively.
  const review = config.verified.get(repo.repo.toLowerCase())
  const release = repo.release
  const base = {
    name: repo.name,
    version: release !== undefined ? release.tag : repo.commit,
    integrity: release !== undefined ? release.sha256 : repo.commit,
    publishedAt: repo.publishedAt ?? '',
    repository: repo.repository,
    license: repo.license ?? '',
    metadata: accepted.metadata,
    catalog: accepted.catalog,
    source: 'github' as const,
    repo: repo.repo,
    ...(repo.subdir !== undefined ? { subdir: repo.subdir } : {}),
    ...(release !== undefined ? { tarball: { url: release.url, sha256: release.sha256 } } : {}),
    added: firstSeenOf(config, firstSeenKey({ source: 'github', name: repo.name, repo: repo.repo })),
  }
  // A release-pinned entry is reviewed by its tarball sha256: the tag is
  // display only — a mutable ref an author can re-point at different content
  // — so verified trust must name the content-addressed hash the entry
  // installs, exactly as npm reviews name the version.
  if (release !== undefined) {
    if (review === undefined || review.reviewedSha256 === undefined) return { ...base, tier: 'community' }
    return { ...base, tier: review.reviewedSha256 === release.sha256 ? 'verified' : 'verified-stale', review }
  }
  // A review whose only pin is a version belongs to an npm entry of the same
  // bundle name, not to this repo candidate.
  if (review === undefined || review.reviewedCommit === undefined) return { ...base, tier: 'community' }
  const stale = review.reviewedCommit !== repo.commit
  return { ...base, tier: stale ? 'verified-stale' : 'verified', review }
}
