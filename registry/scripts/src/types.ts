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
   * The npm account behind this package: `_npmUser.name` when that account is
   * one of the maintainers, else the first maintainer (see `publisherOf`).
   * Absent when npm names no maintainer at all.
   *
   * Not `author`: that field is free text the publisher writes, and a clone
   * inherits it verbatim — `dsh-agent-squad`, published by `shenzhsjtu`,
   * carries the name and email of the author of the package it copied. Not
   * `maintainers` either: it is a list, and one listed package has 49 of
   * them. `_npmUser` is exactly one name and the registry, not the package,
   * is what says it. The email npm carries beside it is dropped.
   */
  publisher?: string
  /**
   * The names of the package's `peerDependencies`, without ranges. A peer is
   * what the environment must already provide, so an unresolvable one means
   * the plugin cannot run on this harness — the failure that broke a user on
   * 2026-09-01. Ranges are deliberately dropped: nearly every dsh plugin
   * declares `"*"`, and the harness's own prerelease versions do not satisfy
   * ordinary ranges, so checking them would accuse working plugins.
   */
  peers: string[]
  /**
   * `dist.unpackedSize` — the total UNPACKED bytes of the published tarball,
   * as npm computed it at publish time. Absent when the packument does not
   * carry one: npm has recorded it since npm 5.6 (2017), so a version
   * published before that, or by a client that did not report it, simply has
   * no figure and the shelf shows none.
   *
   * Unpacked and not the download: those differ by roughly the compression
   * ratio, and the number a reader cares about is what lands in the profile.
   * Every consumer of this must say which one it is showing.
   */
  unpackedSize?: number
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
  /**
   * The bytes this candidate puts on disk, measured from the repository's git
   * tree (or the release tarball, for a rescued one) — see
   * {@link Entry.installSize}. Absent when it could not be measured honestly,
   * which includes every transport failure: the read is best-effort, because a
   * size is a decoration and must not cost a listing.
   *
   * Persisted, because it rides {@link RepoStateEntry.candidates} into
   * `repo-state.json`. That is the whole caching story: the figure is a
   * property of the pinned commit, so it is measured once and carried until
   * `pushedAt` changes, and the daily run pays for churned repositories only.
   */
  installSize?: number
  /**
   * That the sizing probe ran for this candidate and got an ANSWER — whether
   * or not an answer produced a figure.
   *
   * Its absence is what queues a recorded repository for one re-probe
   * (`repo-state.ts`), so that repositories recorded before `installSize`
   * existed do not wait for a push that may never come. Measured on the
   * 2026-09-08 dry run: 405 repositories fetched against 15,063 carried, so
   * without this the field would populate a few percent and then trickle.
   *
   * A separate marker rather than testing `installSize` itself, and this is
   * the whole reason it exists: a tree can answer and still yield no figure —
   * truncated, a hostile blob size, a `subdir` matching nothing — so keying
   * the re-probe on the SIZE would put every unmeasurable repository in every
   * run's queue forever. Same shape as `release.assetVerified`, whose comment
   * makes the same point: the marker is present either way, so the re-probe
   * happens once.
   *
   * Written only for an ANSWER, never for a transport failure. That is the
   * project's `no-manifest`-versus-`fetch-failed` rule applied here: a
   * deterministic no-size (this tree, this commit) will not change without a
   * push and must not be re-asked, while a stalled or rate-limited read says
   * nothing about the repository and must be.
   */
  sizeProbed?: true
  /**
   * The body cap that refused this candidate's sizing tree, when one did.
   *
   * `sizeProbed` alone cannot express this outcome honestly. A 404 and a
   * `truncated: true` are facts about the commit and stay settled until it
   * moves; a body past `MAX_TREE_BYTES` is a fact about a constant WE chose,
   * so recording it as settled would mean a later raise re-measured none of
   * the repositories the old cap had excluded. Storing the cap makes the
   * invalidation automatic: `diffRepoState` re-queues a candidate whose
   * recorded cap is below the one the current build applies, which is the
   * same one-shot re-probe `assetVerified`'s absence buys, without a second
   * marker to remember to add.
   */
  sizeCappedAt?: number
  /**
   * How many subpackage manifests the harvest probed for this root, when it
   * probed any and none declared a bundle. Present only on a bundle-less
   * monorepo root, and only to make its rejection truthful: without it the
   * root is told to add `dsh.bundle` to the file the author already knows is
   * not the plugin (hub-borrowings §A, audit B-7).
   */
  probedSubpackages?: number
  /** A prebuilt GitHub Release tarball, when the fetch layer probed one for a
   * `requiresBuild` repo. Its presence turns the entry into a
   * release-pinned entry: `version` = the tag, `integrity` = the tarball
   * sha256. */
  release?: {
    tag: string
    url: string
    sha256: string
    /**
     * That `verifyReleaseAsset` opened this asset and accepted it.
     *
     * Persisted so the record says which RULES produced it. Absent means the
     * rescue predates the check — taken on release metadata alone — and
     * `diffRepoState` queues that repo for one re-probe rather than trusting
     * it, because `pushedAt` alone would let an unverified rescue stand
     * forever on a repo that never pushes again.
     */
    assetVerified?: true
  }
  /**
   * Why a release asset that DID exist was refused as a rescue — it packs a
   * different package, declares no `dsh.bundle`, or could not be read
   * (`verifyReleaseAsset`).
   *
   * Present only alongside an absent `release`, and only so the rejection can
   * say why the rescue did not apply. Without it the author reads the plain
   * `requires-build` reason and is told to drop a build script, when what is
   * actually wrong is the tarball they attached — a misattributed reason, and
   * those are defects here rather than wording nits.
   */
  releaseRejected?: string
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
  | 'self'

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
  /**
   * `owner/slug` of the repository the review covers, as the reviewer wrote
   * it. Present exactly when the pin is a commit or a release sha256.
   *
   * A GitHub review binds `(repo, commit)`. A bundle name is not an identity:
   * 83 live bundle names are claimed by both a fork and an original, so a
   * review found by bundle name alone handed `bob/dsh-repo-plugin` the
   * verdict — and the reviewer's name — that a human wrote about
   * `alice/dsh-repo-plugin`, and at the reviewed commit it also handed it the
   * skipped install acknowledgement.
   */
  repo?: string
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
  /** The npm account that published this version; present only for npm
   * entries whose packument named one. A github entry has no npm publisher.
   * See {@link Candidate.publisher} for why this and not `author`. */
  publisher?: string
  /**
   * The package's declared peer dependency names, present exactly when it
   * declares any. The Host resolves them against the running installation to
   * tell the reader whether the plugin can run there; the catalog records the
   * requirement, never a verdict, because compatibility depends on who is
   * reading.
   *
   * Additive and optional, so it rides every schemaVersion — see
   * {@link Entry.unpackedSize} for the reasoning. This said "Emitted only at
   * schemaVersion 6 and above" long after that gate came off in `emit.ts`,
   * which is how the gate sat unopened and the compatibility badges never
   * shipped; a stale version claim here is what the next additive field will
   * copy.
   */
  peers?: string[]
  /**
   * The entry's unpacked size in bytes — what installing it puts on disk.
   *
   * npm entries only, and only when the packument carried one (see
   * {@link Candidate.unpackedSize}). A github entry has none and gets none:
   * GitHub's repo `size` is the repository's own disk usage including history,
   * which is not this plugin — and for a monorepo subpackage it is not even
   * close. A number labelled "size" that measures something else is the kind
   * of plausible-and-wrong this project would rather not publish, so those
   * entries show no size at all.
   *
   * Additive and optional, so it rides every schemaVersion: a client that
   * predates it strips the key (consumer zod is non-strict by design), and
   * bumping the version NUMBER is the change that breaks old clients. Same
   * reasoning as `publisher` and `peers`.
   *
   * Superseded for new readers by {@link Entry.installSize}, which carries the
   * same quantity for every source. This key stays npm-only and keeps every
   * word above: an installed client REFUSES a github entry that carries it.
   */
  unpackedSize?: number
  /**
   * What installing this entry puts on disk, in bytes — the same quantity as
   * {@link Entry.unpackedSize}, for EVERY source.
   *
   * Per source: an npm entry repeats the packument's `dist.unpackedSize`; a
   * commit-pinned github entry sums its git tree's blobs, scoped to `subdir`
   * when it has one; a release-rescued entry sums the tarball it already
   * inflated to verify. Absent whenever the measurement could not be made
   * honestly — see {@link treeInstallSize} for each way that happens. A size
   * is a decoration, so a missing one costs the size and never the listing.
   *
   * WHY A SECOND KEY, when `unpackedSize` already names this quantity: the
   * consumer's entry schema does not merely ignore a github `unpackedSize`,
   * it raises an issue on one (`host/catalog.ts` superRefine), and the data
   * file is read with a throwing `parse`. So one github entry carrying that
   * key makes the WHOLE catalog fail to load for every already-installed
   * shop — all entries, not the one. An UNKNOWN key is stripped instead, so
   * a new key ships on the next daily build with no client coordination at
   * all, while filling the old one could not ship until every installed
   * client had updated, which is not observable. `unpackedSize` keeps being
   * emitted for npm so old clients keep showing npm sizes, and is retired
   * once the client floor has moved.
   *
   * Comparable across sources, with a measured caveat. ONE sample of 69
   * tag-matched npm packages, partitioned by whether the repository holds one
   * package or several: a single-package tree sum runs a median 1.48x of the
   * same package's npm figure (n=58, p75 2.78x, max 14.2x, 37 within 2x),
   * while a monorepo charged whole runs 6.37x (n=11, p75 19.3x, max 35.4x).
   * That gap is why `subdir` scoping is not optional.
   *
   * The residual on the single-package side is real content rather than
   * error: a repository holds the tests, docs and screenshots npm's `files`
   * whitelist omits, and a repo install genuinely puts all of it on disk.
   *
   * Do not pin the median tighter than the sampling supports. A separate
   * sample read 1.22x where this one reads 1.48x, so it sits somewhere near
   * 1.2-1.5x and what the figure has to carry is a magnitude — the same
   * order, not the same number — rather than its digits.
   *
   * An earlier version of this comment quoted 1.22x against a 1.67x "naive"
   * median and charged the whole difference to the monorepo confound. Those
   * came from two samples with different seeds and sizes, so the difference
   * was not attributable to anything; the confound is real, but only the
   * partition above measures it. Two figures over different populations do
   * not make a ratio — the same correction `PARTITION_KEYWORDS`' comment
   * carries about the two keywords' uncovered rates.
   *
   * NOT the download. Both differ from the bytes on the wire by a ratio that
   * is itself unstable — npm unpacked/download measured a median 2.88x over
   * 16 packages but ranged 1.01x to 5.91x — so neither figure converts into
   * the other, and a reader is owed the label it was measured under.
   */
  installSize?: number
}
