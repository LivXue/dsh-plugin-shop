import { createHash } from 'node:crypto'
import type { Entry, Rejection } from './types.ts'

/**
 * Catalog format version. A consumer refuses a higher value. Bumped to 2 when
 * `Entry` gained `metadata` and `catalog.summary.zh` became optional (§6.2).
 */
export const SCHEMA_VERSION = 2

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
export function emit(entries: Entry[], rejections: Rejection[], builtAt: string, stars?: StarsPointer | null): Artifacts {
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  const denied = rejections
    .filter(r => r.code === 'denied')
    .map(r => ({ name: r.name, detail: r.detail }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  const pluginsJson = `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, plugins: sorted, denied }, null, 2)}\n`
  const sha256 = createHash('sha256').update(pluginsJson).digest('hex')
  const pluginsFileName = `plugins.${sha256}.json`

  const indexJson = `${JSON.stringify({
    schemaVersion: SCHEMA_VERSION,
    builtAt,
    count: sorted.length,
    plugins: { url: pluginsFileName, sha256 },
    ...(stars == null ? {} : { stars }),
  }, null, 2)}\n`

  const manifestLock = sorted.map(e => `${e.name} ${e.version} ${e.integrity}`).join('\n') + (sorted.length > 0 ? '\n' : '')

  const sortedRejections = [...rejections].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
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

  return { pluginsFileName, pluginsJson, indexJson, manifestLock, report }
}
