import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
import { z } from 'zod'
import { CATEGORIES, type Category, type Review } from './types.ts'

const verifiedSchema = z.array(z.object({
  name: z.string().min(1),
  reviewedVersion: z.string().min(1).optional(),
  reviewedCommit: z.string().min(1).optional(),
  reviewer: z.string().min(1),
  reviewCommit: z.string().min(1),
  notes: z.string().default(''),
}).strict().refine(row => row.reviewedVersion !== undefined || row.reviewedCommit !== undefined, {
  message: 'declare reviewedVersion (npm) or reviewedCommit (github)',
}))

const deniedSchema = z.array(z.object({
  name: z.string().min(1),
  reason: z.string().min(1),
}).strict())

const allowedSimilarSchema = z.array(z.string().min(1))

const categoriesSchema = z.array(z.object({
  name: z.string().min(1),
  category: z.enum(CATEGORIES),
}).strict())

/** The human-authored inputs to one catalog build. */
export interface RegistryConfig {
  /** Package name to its pinned review. */
  verified: Map<string, Review>
  /** Package name to the reason it is excluded. */
  denied: Map<string, string>
  /** Names cleared past the similarity hold. */
  allowedSimilar: Set<string>
  /** Package name to its LLM-assigned category (spec 2026-08-26-llm-categorization-design.md). */
  categories: Map<string, Category>
}

/**
 * Parse one file, failing loudly with the file's name in the message. A
 * malformed registry file must stop the build: silently listing nothing looks
 * identical to an empty ecosystem.
 */
function parseFile<T>(label: string, text: string, schema: z.ZodType<T>): T {
  const raw: unknown = parse(text)
  if (!Array.isArray(raw)) throw new Error(`${label}: expected a YAML list, got ${typeof raw}`)
  const result = schema.safeParse(raw)
  if (result.success) return result.data
  const issue = result.error.issues[0]
  const path = issue === undefined ? '' : issue.path.join('.')
  const message = issue === undefined ? 'invalid' : issue.message
  throw new Error(`${label}: ${path} ${message}`)
}

/**
 * Insert into a map, failing loudly on a name already present. `verified.yml`
 * and `denied.yml` are each a human review record for one package; a second
 * entry for the same name would otherwise silently keep whichever one was
 * inserted last, with the outcome depending on file order.
 */
function setUnique<V>(map: Map<string, V>, label: string, name: string, value: V): void {
  if (map.has(name)) throw new Error(`${label}: duplicate entry for ${name}`)
  map.set(name, value)
}

/**
 * Parse the four registry files from their text.
 * @param input - the raw text of each file.
 * @returns the parsed configuration.
 * @throws when any file is malformed, or when `verified.yml`, `denied.yml`, or
 *   `categories.yml` lists the same package name twice.
 */
export function parseRegistryConfig(
  input: { verified: string; denied: string; allowedSimilar: string; categories: string },
): RegistryConfig {
  const verified = new Map<string, Review>()
  for (const row of parseFile('verified.yml', input.verified, verifiedSchema)) {
    setUnique(verified, 'verified.yml', row.name, {
      reviewedVersion: row.reviewedVersion,
      reviewedCommit: row.reviewedCommit,
      reviewer: row.reviewer,
      reviewCommit: row.reviewCommit,
      notes: row.notes,
    })
  }
  const denied = new Map<string, string>()
  for (const row of parseFile('denied.yml', input.denied, deniedSchema)) {
    setUnique(denied, 'denied.yml', row.name, row.reason)
  }
  const allowedSimilar = new Set(parseFile('allowed-similar.yml', input.allowedSimilar, allowedSimilarSchema))
  const categories = new Map<string, Category>()
  for (const row of parseFile('categories.yml', input.categories, categoriesSchema)) {
    setUnique(categories, 'categories.yml', row.name, row.category)
  }
  return { verified, denied, allowedSimilar, categories }
}

/**
 * Read and parse the registry files from a directory.
 * @param dir - the `registry/` directory.
 * @returns the parsed configuration.
 */
export function loadRegistryConfig(dir: string): RegistryConfig {
  return parseRegistryConfig({
    verified: readFileSync(join(dir, 'verified.yml'), 'utf8'),
    denied: readFileSync(join(dir, 'denied.yml'), 'utf8'),
    allowedSimilar: readFileSync(join(dir, 'allowed-similar.yml'), 'utf8'),
    categories: readOptional(dir, 'categories.yml'),
  })
}

function readOptional(dir: string, file: string): string {
  const path = join(dir, file)
  return existsSync(path) ? readFileSync(path, 'utf8') : '[]'
}
