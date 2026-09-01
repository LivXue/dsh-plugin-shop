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
 * Strip one surrounding markdown code fence, with or without a language tag
 * and with or without the newlines around it. Text that is not fenced comes
 * back untouched, so a genuinely unparseable response stays unparseable.
 */
function unfence(text: string): string {
  const fenced = /^\s*```(?:[A-Za-z]+)?\s*\n?([\s\S]*?)\n?\s*```\s*$/.exec(text)
  return fenced?.[1] ?? text
}

/**
 * Parse one LLM batch response into the rows worth adopting.
 *
 * The model's output is advisory (spec 2026-08-26-llm-categorization-design.md
 * D4/§5): rows with an unknown name or a category outside the fixed
 * vocabulary are dropped, and a response that is not a JSON array yields
 * nothing. Dropped rows leave the entry unclassified, which the next build
 * retries. Purity: no network, no clock, no filesystem.
 *
 * A markdown code fence around the array is unwrapped first: the prompt asks
 * for bare JSON, but a fence is not the model disagreeing about the answer,
 * and losing 20 good rows over three backticks is a worse reading of
 * "advisory" than accepting them.
 * @param text - the raw completion content.
 * @param expectedNames - the names this batch asked about; anything else is
 *   not evidence about the batch.
 * @returns the valid name→category assignments.
 */
export function parseClassificationResponse(text: string, expectedNames: ReadonlySet<string>): Map<string, Category> {
  const adopted = new Map<string, Category>()
  let raw: unknown
  try {
    raw = JSON.parse(unfence(text))
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
