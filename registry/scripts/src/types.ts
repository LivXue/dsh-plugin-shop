/** Closed set of catalog categories. Adding one is a schema change. */
export const CATEGORIES = ['tool', 'provider', 'ui', 'workflow', 'integration', 'other'] as const
export type Category = typeof CATEGORIES[number]

/**
 * The `dsh.catalog` section, either author-declared or derived from npm
 * metadata (see {@link Entry.metadata}). `summary.zh` is absent on a derived
 * section: the build never synthesizes a translation. `capabilities` is
 * self-declared and unenforced: it exists for display and MUST NOT be treated
 * as a permission by any consumer.
 */
export interface CatalogSection {
  category: Category
  summary: { en: string; zh?: string }
  capabilities: string[]
}

/** One npm package as fetched, before any gating decision. */
export interface Candidate {
  name: string
  version: string
  integrity: string | null
  publishedAt: string | null
  repository: string | null
  license: string | null
  deprecated: boolean
  hasBundle: boolean
  /** The raw `dsh.catalog` value; unvalidated until the gate runs. */
  catalog: unknown
  /** The npm `description` field, used to derive a listing when `catalog` is absent. */
  description: string | null
}

/** Why a candidate did not reach the catalog. */
export type RejectionCode =
  | 'no-bundle'
  | 'invalid-catalog'
  | 'no-summary'
  | 'denied'
  | 'deprecated'
  | 'no-license'
  | 'no-repository'
  | 'no-integrity'
  | 'no-publish-time'
  | 'name-too-similar'
  | 'fetch-failed'

/** One rejection, carrying an author-readable explanation. */
export interface Rejection {
  name: string
  code: RejectionCode
  detail: string
}

/** Trust level of a catalog entry. */
export type Tier = 'verified' | 'verified-stale' | 'community'

/** A human review, pinned to the exact version it covered. */
export interface Review {
  reviewedVersion: string
  reviewer: string
  reviewCommit: string
  notes: string
}

/** One published catalog entry. */
export interface Entry {
  name: string
  version: string
  integrity: string
  publishedAt: string
  repository: string
  license: string
  tier: Tier
  review?: Review
  /**
   * Whether `catalog` is the author's own section or one derived from npm
   * metadata. Orthogonal to `tier`: a derived entry can still be `verified`,
   * because a review reads the code, not the author's prose.
   */
  metadata: 'declared' | 'derived'
  catalog: CatalogSection
}
