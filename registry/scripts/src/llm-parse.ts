import { CATEGORIES, type Category } from './types.ts'

/** A validated classification row. */
interface RawRow {
  name?: unknown
  category?: unknown
}

function isCategory(value: string): value is Category {
  return (CATEGORIES as readonly string[]).includes(value)
}

/**
 * Parse one LLM batch response into the rows worth adopting.
 *
 * The model's output is advisory (spec 2026-08-26-llm-categorization-design.md
 * D4/§5): rows with an unknown name or a category outside the fixed
 * vocabulary are dropped, and a response that is not a JSON array yields
 * nothing. Dropped rows leave the entry unclassified, which the next build
 * retries. Purity: no network, no clock, no filesystem.
 * @param text - the raw completion content.
 * @param expectedNames - the names this batch asked about; anything else is
 *   not evidence about the batch.
 * @returns the valid name→category assignments.
 */
export function parseClassificationResponse(text: string, expectedNames: ReadonlySet<string>): Map<string, Category> {
  const adopted = new Map<string, Category>()
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    // Not JSON: adopt nothing; the caller records the discard.
    return adopted
  }
  if (!Array.isArray(raw)) return adopted
  for (const row of raw as RawRow[]) {
    if (typeof row !== 'object' || row === null) continue
    if (typeof row.name !== 'string' || !expectedNames.has(row.name)) continue
    if (typeof row.category !== 'string') continue
    if (!isCategory(row.category)) continue
    adopted.set(row.name, row.category)
  }
  return adopted
}
