/** Closed set of catalog categories. Adding one is a schema change. */
export const CATEGORIES = ['tool', 'provider', 'ui', 'workflow', 'integration', 'theme', 'other'] as const
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
  /** npm manifest `keywords`, strings only, `[]` when absent. Classify input. */
  keywords: string[]
  /**
   * The names of the package's `peerDependencies`, without ranges. A peer is
   * what the environment must already provide, so an unresolvable one means
   * the plugin cannot run on this harness — the failure that broke a user on
   * 2026-09-01. Ranges are deliberately dropped: nearly every dsh plugin
   * declares `"*"`, and the harness's own prerelease versions do not satisfy
   * ordinary ranges, so checking them would accuse working plugins.
   */
  peers: string[]
}

/**
 * One GitHub repository as fetched, before any gating decision. The unit of
 * listing is the repo (`owner/slug`); `name` is the manifest's bundle name —
 * what `dsh` registers on install. `version` and `integrity` both carry the
 * pinned commit: a commit is the closest thing to content addressing git has.
 */
export interface RepoCandidate {
  /** The manifest `name` — the bundle name dsh registers. */
  name: string
  /** `owner/slug`, the install target's identity. */
  repo: string
  /** The pinned default-branch commit, 40 hex chars. */
  commit: string
  /** The commit, repeated for field uniformity with npm candidates. */
  version: string
  /** The commit date, ISO 8601. */
  publishedAt: string | null
  /** The repo's https URL. */
  repository: string
  /** The repo's declared license (GitHub metadata `spdx_id`), null when none. */
  license: string | null
  hasBundle: boolean
  /**
   * Whether the manifest declares a `prepare`/`prepack` build script. A git
   * install requires running it, pnpm blocks it by default, and the shop
   * never enables build scripts — so such a repo can never install through
   * the shop and is rejected at harvest.
   */
  requiresBuild: boolean
  /**
   * Whether the manifest declares a `workspace:`-protocol dependency. Those
   * resolve only inside the repository's own workspace, so a git install
   * from outside it cannot succeed (measured: pnpm fails with
   * WORKSPACE_PKG_NOT_FOUND) — rejected at harvest.
   */
  hasWorkspaceDeps: boolean
  /**
   * The subpackage directory (e.g. `packages/foo`) when this candidate is a
   * monorepo subpackage rather than the repo root; absent for root entries.
   */
  subdir?: string
  /** A prebuilt GitHub Release tarball, when the fetch layer probed one for a
   * `requiresBuild` repo. Its presence turns the entry into a
   * release-pinned entry: `version` = the tag, `integrity` = the tarball
   * sha256. */
  release?: { tag: string; url: string; sha256: string }
  /** The raw `dsh.catalog` value from the repo's manifest; unvalidated until the gate runs. */
  catalog: unknown
  /** The GitHub repo `description`, used to derive a listing when `catalog` is absent. */
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
  | 'harness-repository'
  | 'no-integrity'
  | 'no-publish-time'
  | 'name-too-similar'
  | 'fetch-failed'
  | 'no-manifest'
  | 'shadowed-by-npm'
  | 'requires-build'
  | 'workspace-deps'
  | 'repo-gone'

/** One rejection, carrying an author-readable explanation. */
export interface Rejection {
  name: string
  code: RejectionCode
  detail: string
  /** The known replacement, when a human recorded one in denied.yml. */
  replacement?: string
}

/** Trust level of a catalog entry. */
export type Tier = 'verified' | 'verified-stale' | 'community'

/**
 * A human review, pinned to the exact version (npm), commit (github), or
 * release tarball sha256 (github release rescue) it covered. Exactly one of
 * the three pins is present, matching the entry's source: trust never
 * inherits across unreviewed code on any source.
 */
export interface Review {
  reviewedVersion?: string
  reviewedCommit?: string
  /** For release-rescued entries, the pin is the tarball sha256 — the
   * content-addressed identity; the tag is display only, a mutable ref that
   * must never carry the trust. */
  reviewedSha256?: string
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
  /** Where the entry installs from. */
  source: 'npm' | 'github'
  /** `owner/slug` of the repository; present exactly when `source` is github. */
  repo?: string
  /** The subpackage directory inside the repo; present exactly when the entry
   * is a monorepo subpackage rather than the repo root. */
  subdir?: string
  /** The prebuilt GitHub Release tarball, present exactly when the entry was
   * rescued from `requires-build`. The Host installs this URL instead of the
   * git form. */
  tarball?: { url: string; sha256: string }
  /** The date this entry first appeared in the catalog (YYYY-MM-DD). */
  added: string
  /**
   * The package's declared peer dependency names, present exactly when it
   * declares any. The Host resolves them against the running installation to
   * tell the reader whether the plugin can run there; the catalog records the
   * requirement, never a verdict, because compatibility depends on who is
   * reading. Emitted only at schemaVersion 6 and above.
   */
  peers?: string[]
}
