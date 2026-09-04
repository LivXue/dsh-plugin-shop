import { createHash } from 'node:crypto'
import { compareEntries, compareRejections, compareStrings, installIdentity } from './identity.ts'
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

/* `peers` — the package's declared peer dependency names, which the Host
 * resolves against the running installation (design
 * 2026-09-01-harness-compatibility) — used to sit behind PEERS_SCHEMA_VERSION
 * = 6, on the reasoning that there was no point serving 410 KB of a 3.63 MB
 * file to clients that could not read it.
 *
 * The gate came off on 2026-09-03 without ever being opened, because opening
 * it was the wrong shape of change. It was never a COMPATIBILITY gate: `peers`
 * is additive and optional, and a client that predates it strips the key
 * (consumer zod is non-strict by design). Emitting `schemaVersion: 6` is what
 * would have broken things — every client capping at 5 throws on the version
 * NUMBER and the shop does not open at all — and the installed base that would
 * have hit is unmeasurable: npm's per-version counts are flat across 36
 * versions (median 164, max 218, the current latest at zero), which is mirror
 * traffic enumerating releases, not installs.
 *
 * So the field rides every version and the bytes go to everyone. That is the
 * cost that was chosen over a bet nothing could settle. */

/** The stars sidecar pointer the index may carry (spec 2026-08-26-github-stars-design.md §4.1). */
export interface StarsPointer { url: string; sha256: string }

/** The complete output of one catalog build. */
export interface Artifacts {
  /** Content-addressed file name of the data file. */
  pluginsFileName: string
  pluginsJson: string
  indexJson: string
  /** The shields.io endpoint payload behind the README's `catalog` badge:
   * `{ schemaVersion, label, message, color, cacheSeconds }`. It names the
   * build date, because GitHub's own workflow badge can say only passing or
   * failing and reports the last COMPLETED run — so it says nothing at all
   * while a build is in flight, and a red one does not distinguish our tests
   * breaking from npm throttling the search endpoint. A failed build deploys
   * nothing, so this date stops advancing, which tells a reader the catalog
   * is stale and by how much. */
  badgeJson: string
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
    const key = installIdentity(entry)
    if (identities.has(key)) throw new Error(`catalog invariant: duplicate install identity ${key}`)
    identities.add(key)
  }
}

/**
 * Replace every unpaired surrogate in an entry with U+FFFD, at any depth.
 *
 * A lone surrogate survives `JSON.stringify` as a `\udXXX` escape, so the
 * emitted file stays ASCII, stays valid JSON and keeps a stable content hash —
 * there is no symptom on this side at all. It appears on the reader's: parsing
 * that file and re-encoding UTF-8 fails, which for Python is
 * `UnicodeEncodeError: surrogates not allowed`.
 *
 * Deliberately structural rather than field-by-field. A list of fields is a
 * list of the routes someone thought of, and this project has now written that
 * list wrong three times; recursing over the value covers the field added next
 * year by someone who never read this comment. `toWellFormed` is the identity
 * on well-formed text, so an ordinary entry is returned unchanged, key order
 * included.
 * @param entry - one accepted, tiered entry about to be serialized.
 * @returns the same entry with every string well-formed UTF-16.
 */
function toWellFormedEntry(entry: Entry): Entry {
  // The cast is unavoidable and sound: `wellFormed` preserves the shape of
  // whatever it is handed exactly — same keys, same order, same array lengths
  // — and only ever replaces a string with another string.
  return wellFormed(entry) as Entry
}

function wellFormed(value: unknown): unknown {
  if (typeof value === 'string') return value.toWellFormed()
  if (Array.isArray(value)) return value.map(wellFormed)
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, wellFormed(inner)]))
  }
  return value
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
 * @param notAShop - names cleared past the client's shop-like NAME filter.
 * @param notes - report-only diagnostic lines (market holds, registry rows that
 *   matched nothing). They ride `report.md` and never the hashed data.
 * @returns the artifacts to publish and commit.
 */
export function emit(
  entries: Entry[],
  rejections: Rejection[],
  builtAt: string,
  stars?: StarsPointer | null,
  schemaVersion: number = SCHEMA_VERSION,
  notAShop: ReadonlySet<string> = new Set(),
  notes: readonly string[] = [],
): Artifacts {
  assertCatalogInvariants(entries, builtAt)
  // Below v5 the catalog must not carry the `theme` category: `theme` is a
  // new enum value, and an old client's zod enum rejects a catalog containing
  // it wholesale (fail-loudly). The downgrade lives here, at the emission
  // boundary — the classifier and the config keep `theme`, so flipping
  // SHOP_CATALOG_V5 at release time restores it without re-reviewing anything
  // (design §3.5). The additive fields (`added`, `tarball`, `replacement`,
  // `peers`) ride EVERY version: an old client's zod strips a key it does not
  // know (consumer-side zod is non-strict by design), so none of them needs a
  // gate. `peers` had one anyway, on size rather than safety; see the note on
  // it above for why it came off instead of being opened.
  let themeDowngraded = 0
  const emitted = entries.map(entry => {
    // Well-formed FIRST, and over the whole entry, because plugins.json is not
    // the catalog section: `license`, `repository`, `publisher` and each
    // `peers` name are npm-manifest strings taken verbatim and bounded on
    // length alone, so `"license": "MIT\ud800"` put a lone surrogate straight
    // into the artifact. Every earlier attempt at this guarantee named the
    // routes it knew about and was overtaken by one it did not, so it is
    // stated here instead — at the boundary every published string crosses,
    // covering whatever fields an Entry grows next.
    let next = toWellFormedEntry(entry)
    if (schemaVersion < CATALOG_SCHEMA_VERSION && next.catalog.category === 'theme') {
      themeDowngraded += 1
      next = { ...next, catalog: { ...next.catalog, category: 'other' as const } }
    }
    return next
  })
  // Name first — that is the order §7.1 promises a reader — then the rest of
  // the identity, so a tie can never fall back to the order npm or GitHub
  // answered in. 172 live bundle names over 451 entries are claimed by
  // several repositories.
  const sorted = [...emitted].sort(compareEntries)
  const denied = rejections
    .filter(r => r.code === 'denied')
    .map(r => ({
      name: r.name,
      detail: r.detail,
      ...(r.replacement !== undefined ? { replacement: r.replacement } : {}),
    }))
    // One name can be denied twice — an npm package and its repository both
    // carry a row — so the detail breaks the tie.
    .sort((a, b) => compareStrings(a.name, b.name) || compareStrings(a.detail, b.detail))
  // The client hides entries whose NAME reads like a competing plugin market.
  // That heuristic cannot tell a plugin storing tea from one selling plugins,
  // so `not-a-shop.yml` clears the ones a human or the classifier judged
  // innocent, and the verdict rides with the data rather than the client —
  // a client-side list would only take effect on its next release, while this
  // lands on the next daily build. Restricted to names actually listed, and
  // sorted, so the content hash follows the catalog and not the file's order.
  // Deduplicated: the list is keyed by NAME because that is what the client's
  // filter reads, and one name can belong to many entries — 151 live names
  // are shared by 243 entries, so the old expression emitted the same name
  // once per entry.
  const notAShopListed = [...new Set(sorted.filter(entry => notAShop.has(entry.name)).map(entry => entry.name))]
    .sort(compareStrings)
  const pluginsJson = `${JSON.stringify({ schemaVersion, plugins: sorted, denied, notAShop: notAShopListed }, null, 2)}\n`
  const sha256 = createHash('sha256').update(pluginsJson).digest('hex')
  const pluginsFileName = `plugins.${sha256}.json`

  // Name, code, detail: a monorepo emits several rows under one repo, and a
  // pre-existing fetch failure can share a name with a gate rejection.
  const sortedRejections = [...rejections].sort(compareRejections)

  const indexJson = `${JSON.stringify({
    schemaVersion,
    builtAt,
    count: sorted.length,
    rejected: sortedRejections.length,
    plugins: { url: pluginsFileName, sha256 },
    ...(stars == null ? {} : { stars }),
  }, null, 2)}\n`

  // The date alone, not the timestamp: a badge has room for ten characters,
  // and the hour a build finished is not something a reader acts on. Sliced
  // rather than reformatted so it cannot drift from `builtAt` — the same
  // string, shortened. Like `builtAt`, this never enters the hashed content.
  const badgeJson = `${JSON.stringify({
    schemaVersion: 1,
    label: 'catalog',
    message: `built ${builtAt.slice(0, 10)}`,
    color: 'blue',
    cacheSeconds: 3600,
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
    // Diagnostics before the table, escaped like a cell: a note can quote a
    // package name, and an unescaped `|` or newline in one would corrupt the
    // document a maintainer reads.
    ...(notes.length > 0 ? ['', ...notes.map(escapeCell)] : []),
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

  return { pluginsFileName, pluginsJson, indexJson, badgeJson, manifestLock, report }
}
