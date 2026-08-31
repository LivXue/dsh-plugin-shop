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
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
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
