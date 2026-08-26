import type { Category } from './types.ts'

/**
 * The category file's standing header. The file is regenerated on every
 * classify run, so the header lives in exactly one place.
 */
const HEADER = [
  '# LLM-assigned categories for derived listings (design 2026-08-26-llm-categorization-design.md).',
  '# A declared `dsh.catalog.category` always wins; a name absent from this file is simply',
  '# "not yet classified" and is retried on the next build.',
].join('\n')

/**
 * Merge the committed rows with a fresh classification pass, pruning rows
 * whose name no longer lives in the catalog, sorted by name. Pure: the
 * classifier's only write policy, fully fixture-driven (spec §2).
 */
export function mergeCategoryRows(
  existing: ReadonlyMap<string, Category>,
  fresh: ReadonlyMap<string, Category>,
  liveNames: ReadonlySet<string>,
): Map<string, Category> {
  const merged = new Map<string, Category>(existing)
  for (const [name, category] of fresh) merged.set(name, category)
  for (const name of merged.keys()) if (!liveNames.has(name)) merged.delete(name)
  return new Map([...merged].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)))
}

/** Serialize rows to the file text: header, sorted rows, trailing newline. */
export function serializeCategoryRows(rows: ReadonlyMap<string, Category>): string {
  // Names are ALWAYS double-quoted: npm scoped names start with `@`, which
  // YAML forbids at the start of a plain scalar — an unquoted `@scope/pkg`
  // row parses as YAMLParseError, so the file this step writes could not be
  // read back by the loader (regression: the backfill's own output). npm
  // names never contain `"` or `\`, so double quotes need no escaping.
  const rowsText = [...rows].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([name, category]) => `- name: "${name}"\n  category: ${category}`)
  // A document made of comments alone parses to `null`, and the loader
  // requires a list; a zero-row file (no key, or nothing new classified) must
  // still be one, or the very next build dies reading what this step wrote.
  const body = rowsText.length === 0 ? ['[]'] : rowsText
  return `${[HEADER, ...body].join('\n')}\n`
}
