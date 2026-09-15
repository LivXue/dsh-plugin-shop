/** Wire and catalog types for the shop Host half (§6.2, §7.3). */

export interface CatalogSummary { en: string; zh?: string }

export interface CatalogSection {
  category: 'tool' | 'provider' | 'ui' | 'workflow' | 'integration' | 'theme' | 'other'
  summary: CatalogSummary
  capabilities: string[]
}

export interface CatalogEntry {
  name: string
  version: string
  integrity: string | null
  publishedAt: string | null
  repository: string | null
  license: string | null
  tier: 'verified' | 'verified-stale' | 'community'
  metadata: 'declared' | 'derived'
  review?: {
    reviewedVersion?: string
    reviewedCommit?: string
    /** For release-rescued entries, the review pin is the tarball sha256 —
     * the content-addressed identity; the tag is display only, a mutable ref
     * that must never carry the trust. */
    reviewedSha256?: string
    reviewer: string
    reviewCommit: string
    notes: string
  }
  catalog?: CatalogSection
  /** Where the entry installs from. */
  source: 'npm' | 'github'
  /** The npm account behind this package — the account npm recorded for
   * this version when it is one of the maintainers, else the first
   * maintainer; npm entries only. Shown beside the npm page link so a person
   * can see WHO stands behind what they are about to install — the shop draws
   * no conclusion from it. Optional on the consumer: the live catalog carries
   * none until the next daily build. */
  publisher?: string
  /** `owner/slug`; present exactly when `source` is github. */
  repo?: string
  /** Subpackage directory inside the repo; present exactly when the entry is
   * a monorepo subpackage rather than the repo root. */
  subdir?: string
  /** The prebuilt GitHub Release tarball, present exactly when the entry was
   * rescued from `requires-build`. The Host installs this URL instead of the
   * git form (market borrowings §3.1). */
  tarball?: { url: string; sha256: string }
  /** The date this entry first appeared in the catalog (YYYY-MM-DD). */
  added?: string
  /** The package's declared peer dependency names (schemaVersion 6). */
  peers?: string[]
  /** What installing this puts on disk, in bytes — npm's own
   * `dist.unpackedSize`. npm entries only, and only where the packument
   * carried one; a github entry has no honest figure and therefore no field
   * (registry `Entry.unpackedSize`). Additive and optional, so it rides every
   * schemaVersion. */
  unpackedSize?: number
  /** What installing this puts on disk, in bytes — the same quantity as
   * `unpackedSize`, for every source (registry `Entry.installSize`). npm
   * repeats its packument figure here; a github entry sums its git tree's
   * blobs, or the release tarball it was rescued from. Absent wherever the
   * measurement could not be made honestly: a size is a decoration, so a
   * missing one costs the label and never the listing. Additive and optional,
   * so it rides every schemaVersion. Prefer it over `unpackedSize`, which is
   * npm-only and retires once the installed client floor has moved. */
  installSize?: number
}

export interface DeniedEntry { name: string; detail: string; replacement?: string }
