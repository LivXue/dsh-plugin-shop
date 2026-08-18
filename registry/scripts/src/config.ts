import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
import { z } from 'zod'
import type { Review } from './types.ts'

const verifiedSchema = z.array(z.object({
  name: z.string().min(1),
  reviewedVersion: z.string().min(1),
  reviewer: z.string().min(1),
  reviewCommit: z.string().min(1),
  notes: z.string().default(''),
}).strict())

const deniedSchema = z.array(z.object({
  name: z.string().min(1),
  reason: z.string().min(1),
}).strict())

const allowedSimilarSchema = z.array(z.string().min(1))

/** The human-authored inputs to one catalog build. */
export interface RegistryConfig {
  /** Package name to its pinned review. */
  verified: Map<string, Review>
  /** Package name to the reason it is excluded. */
  denied: Map<string, string>
  /** Names cleared past the similarity hold. */
  allowedSimilar: Set<string>
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
 * Parse the three registry files from their text.
 * @param input - the raw text of each file.
 * @returns the parsed configuration.
 * @throws when any file is malformed.
 */
export function parseRegistryConfig(
  input: { verified: string; denied: string; allowedSimilar: string },
): RegistryConfig {
  const verified = new Map<string, Review>()
  for (const row of parseFile('verified.yml', input.verified, verifiedSchema)) {
    verified.set(row.name, {
      reviewedVersion: row.reviewedVersion,
      reviewer: row.reviewer,
      reviewCommit: row.reviewCommit,
      notes: row.notes,
    })
  }
  const denied = new Map<string, string>()
  for (const row of parseFile('denied.yml', input.denied, deniedSchema)) denied.set(row.name, row.reason)
  const allowedSimilar = new Set(parseFile('allowed-similar.yml', input.allowedSimilar, allowedSimilarSchema))
  return { verified, denied, allowedSimilar }
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
  })
}
