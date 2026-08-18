import { gt } from 'semver'
import type { Accepted } from './gate.ts'
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
  }
  if (review === undefined) return { ...base, tier: 'community' }
  const stale = gt(candidate.version, review.reviewedVersion)
  return { ...base, tier: stale ? 'verified-stale' : 'verified', review }
}
