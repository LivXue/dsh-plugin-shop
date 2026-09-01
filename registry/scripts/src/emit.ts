import { createHash } from 'node:crypto'
import type { Entry, Rejection } from './types.ts'

/**
 * Catalog format version. A consumer refuses a higher value. Bumped to 2 when
 * `Entry` gained `metadata` and `catalog.summary.zh` became optional (§6.2);
 * bumped to 3 when entries gained `source` and repo entries (`repo`, commit
 * pinning) joined the npm ones (2026-08-30 github-channel design). 4 adds
 * `subdir` for monorepo-subpackage entries (2026-08-31 hub-borrowings A) —
 * emitted only when the build's flag says so, so a v3 client never meets an
 * entry it would misinstall (v3 clients ignore `subdir` and would install
 * the monorepo root, a silent no-op).
 */
export const SCHEMA_VERSION = 3

/** The version this build emits; see {@link SCHEMA_VERSION} for the 4-bump. */
export const SUBPACKAGE_SCHEMA_VERSION = 4

/** v5 (market borrowings): `added` on every entry, optional `tarball`
 * (release rescue), `theme` category, `denied[].replacement`. Emitted only
 * when SHOP_CATALOG_V5 is set — `theme` is a new enum value, and an old
 * client's zod enum rejects a catalog containing it wholesale, so the client
 * that parses v5 must ship first (release-order choreography, §3.5). */
export const CATALOG_SCHEMA_VERSION = 5

/** v6 adds `peers` — the package's declared peer dependency names, which the
 * Host resolves against the running installation (design
 * 2026-09-01-harness-compatibility). Gated because it is 410 KB on a 3.63 MB
 * file: no reason to serve it before a client can read it. */
export const PEERS_SCHEMA_VERSION = 6

/** The stars sidecar pointer the index may carry (spec 2026-08-26-github-stars-design.md §4.1). */
export interface StarsPointer { url: string; sha256: string }

/** The complete output of one catalog build. */
export interface Artifacts {
  /** Content-addressed file name of the data file. */
  pluginsFileName: string
  pluginsJson: string
  indexJson: string
  manifestLock: string
  report: string
}

/**
 * Escape one field for placement inside a markdown table cell.
 *
 * A rejection's `name`, `code`, and `detail` can all carry text sourced from
 * a third party's `package.json` — `detail` in particular reaches here
 * carrying a zod validation message that echoes back an unrecognized key an
 * author supplied. An unescaped `|` would split the cell into extra columns
 * and an unescaped newline would break the row into extra lines, letting
 * that text forge or corrupt neighboring rows in the published report.
 */
function escapeCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r\n|\r|\n/g, ' ')
}

/**
 * Cross-field catalog invariants, checked before anything is emitted
 * (design 2026-08-31 market-borrowings §2, the E11/E12 borrowings). The
 * consumer cannot self-heal these: a duplicated install identity makes the
 * install route ambiguous, and a count that does not match the data file
 * breaks every consumer's summary. Throwing beats publishing either.
 * @param entries - the accepted entries, pre-sort.
 * @param builtAt - the build timestamp; its date part is the "now" reference.
 */
export function assertCatalogInvariants(entries: Entry[], builtAt: string): void {
  // E9: `added` is present and never in the future relative to the build date.
  // A date the build has not reached yet is a contradiction in the source
  // data — either the file was hand-edited ahead of reality or the clock is
  // wrong, and publishing either would let consumers trust a fiction.
  const today = builtAt.slice(0, 10)
  for (const entry of entries) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.added)) {
      throw new Error(`catalog invariant: ${entry.name} has an unparseable added date ${entry.added}`)
    }
    if (entry.added > today) {
      throw new Error(`catalog invariant: ${entry.name} added ${entry.added} is later than the build date ${today}`)
    }
  }
  const identities = new Set<string>()
  for (const entry of entries) {
    const key = entry.source === 'npm'
      ? `npm:${entry.name}`
      : `github:${entry.repo ?? entry.name}#${entry.subdir ?? ''}`
    if (identities.has(key)) throw new Error(`catalog invariant: duplicate install identity ${key}`)
    identities.add(key)
  }
}

/**
 * Build every artifact of one catalog run.
 *
 * `builtAt` reaches the index and nothing else: putting it inside the hashed
 * data would change the content hash daily, invalidating every CDN cache and
 * filling each commit with noise.
 * @param entries - accepted catalog entries, in any order.
 * @param rejections - every rejected candidate with its reason.
 * @param builtAt - ISO 8601 build timestamp, supplied by the caller.
 * @param stars - optional pointer to a published stars sidecar; omitted from the index when null.
 * @returns the artifacts to publish and commit.
 */
export function emit(
  entries: Entry[],
  rejections: Rejection[],
  builtAt: string,
  stars?: StarsPointer | null,
  schemaVersion: number = SCHEMA_VERSION,
): Artifacts {
  assertCatalogInvariants(entries, builtAt)
  // Below v5 the catalog must not carry the `theme` category: `theme` is a
  // new enum value, and an old client's zod enum rejects a catalog containing
  // it wholesale (fail-loudly). The downgrade lives here, at the emission
  // boundary — the classifier and the config keep `theme`, so flipping
  // SHOP_CATALOG_V5 at release time restores it without re-reviewing anything
  // (design §3.5). The additive fields (`added`, `tarball`, `replacement`)
  // ride the lower versions: an old client's zod strips the unknown keys
  // (consumer-side zod is non-strict by design). `peers` cannot ride the same
  // way: it is additive too, but it is 410 KB on a 3.63 MB file, so below v6
  // it is stripped rather than served to a client that cannot use it yet.
  let themeDowngraded = 0
  const emitted = entries.map(entry => {
    let next = entry
    if (schemaVersion < CATALOG_SCHEMA_VERSION && next.catalog.category === 'theme') {
      themeDowngraded += 1
      next = { ...next, catalog: { ...next.catalog, category: 'other' as const } }
    }
    if (schemaVersion < PEERS_SCHEMA_VERSION && next.peers !== undefined) {
      const { peers: _peers, ...rest } = next
      next = rest
    }
    return next
  })
  const sorted = [...emitted].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  const denied = rejections
    .filter(r => r.code === 'denied')
    .map(r => ({
      name: r.name,
      detail: r.detail,
      ...(r.replacement !== undefined ? { replacement: r.replacement } : {}),
    }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  const pluginsJson = `${JSON.stringify({ schemaVersion, plugins: sorted, denied }, null, 2)}\n`
  const sha256 = createHash('sha256').update(pluginsJson).digest('hex')
  const pluginsFileName = `plugins.${sha256}.json`

  const sortedRejections = [...rejections].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))

  const indexJson = `${JSON.stringify({
    schemaVersion,
    builtAt,
    count: sorted.length,
    rejected: sortedRejections.length,
    plugins: { url: pluginsFileName, sha256 },
    ...(stars == null ? {} : { stars }),
  }, null, 2)}\n`

  // Repo entries carry their install target (`owner/slug`) so the daily diff
  // keeps both identities visible; the commit is both `version` and `integrity`.
  const manifestLock = sorted
    .map(e => e.source === 'github' ? `${e.repo ?? e.name} ${e.name} ${e.version}` : `${e.name} ${e.version} ${e.integrity}`)
    .join('\n') + (sorted.length > 0 ? '\n' : '')
  const lines = [
    '# Catalog build report',
    '',
    `Accepted: ${sorted.length}`,
    `Rejected: ${sortedRejections.length}`,
    ...(themeDowngraded > 0 ? [`Theme entries emitted as other (schemaVersion < 5): ${themeDowngraded}`] : []),
    '',
    '| Package | Reason | Detail |',
    '|---|---|---|',
    ...sortedRejections.map(r => `| ${escapeCell(r.name)} | ${escapeCell(r.code)} | ${escapeCell(r.detail)} |`),
  ]
  const report = `${lines.join('\n')}\n`

  // E12: the pointer's count must equal the data file's plugin array — the
  // two artifacts are built separately and this keeps them honest.
  const dataCount = (JSON.parse(pluginsJson) as { plugins: unknown[] }).plugins.length
  if (dataCount !== sorted.length) throw new Error('catalog invariant: index count does not match the data file')

  return { pluginsFileName, pluginsJson, indexJson, manifestLock, report }
}
