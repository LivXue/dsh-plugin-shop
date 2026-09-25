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
    /** Which repository was reviewed. A github review binds (`repo`,
     * `reviewedCommit`) and never a name, because 83 live bundle names are
     * claimed by both a fork and an original. */
    repo?: string
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
  /** The names of the package's REQUIRED peer dependencies — a peer its
   * author marks optional in `peerDependenciesMeta` is left out at harvest.
   * Additive and optional, so it rides every schemaVersion: the version-6
   * gate this comment used to name came off on 2026-09-03 without ever being
   * opened. Present on npm entries. Not on github entries yet: the registry
   * harvests their peers from 2026-09-24 but withholds them from the catalog
   * (`withholdRepoPeers`) until `SHOP_EMIT_REPO_PEERS` flips, in the release
   * commit that first promotes a shop refining peers against the browser's
   * module table to `latest` (design 2026-09-01-harness-compatibility §9.8).
   * An absent list forms no peer verdict. */
  peers?: string[]
  /** The author's own `dsh.compatibility` declaration, when they published
   * one. A REQUIREMENT, never a verdict: the host compares it against the
   * running installation (`ShopCatalogResult.incompatibleHarness`). Additive
   * and optional, so it rides every schemaVersion. */
  compatibility?: { dsh?: string; profiles?: string[] }
  /** Wire-compatibility key, not a field to read — see {@link installSize},
   * which the catalog parse fills from this one. It names npm's OWN quantity
   * (`dist.unpackedSize`), so it is npm-only and the parse REFUSES one on a
   * github entry: a github figure is a different measurement and would be
   * wrong under this key, not merely absent (registry `Entry.unpackedSize`).
   * The registry keeps emitting it so that a client older than this one still
   * shows npm sizes; it retires with the transform in `catalog.ts`. Additive
   * and optional, so it rides every schemaVersion. */
  unpackedSize?: number
  /** What installing this puts on disk, in bytes — the same quantity as
   * `unpackedSize`, for every source (registry `Entry.installSize`). npm
   * repeats its packument figure here; a github entry sums its git tree's
   * blobs, or the release tarball it was rescued from. Absent wherever the
   * measurement could not be made honestly: a size is a decoration, so a
   * missing one costs the label and never the listing. Additive and optional,
   * so it rides every schemaVersion.
   *
   * THE size field: read this one and never `unpackedSize`. The catalog parse
   * fills it from `unpackedSize` when an older catalog carries only that key,
   * so every consumer of a parsed entry sees one field whatever the data
   * predates (`catalog.ts`, the transform below the entry superRefine). For a
   * github entry the figure is scoped to `subdir` when it has one — 239 of the
   * 6,492 live github entries — which is the plugin's own cost and not the
   * repository's; registry `Entry.installSize` carries the measured caveat. */
  installSize?: number
}

export interface DeniedEntry { name: string; detail: string; replacement?: string }
