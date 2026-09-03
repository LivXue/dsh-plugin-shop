import { z } from 'zod'
import { CATEGORIES, type CatalogSection } from './types.ts'

/** Closed category enum; adding a member is a schema change. */
export const categorySchema = z.enum(CATEGORIES)

/**
 * Maximum length of one `capabilities` item. The count was capped at 20 and
 * the item length was not, so a manifest declaring 20 one-megabyte strings
 * put 20 MB into a file every reader downloads — measured through the real
 * `toCandidate → gate → assignTier → emit` path, one package with 1 MB
 * strings produced a 203 MB `plugins.json`. A capability names a dsh service;
 * the longest real one is under twenty characters.
 */
export const CAPABILITY_MAX_LENGTH = 64

/**
 * The `dsh.catalog` section. Both summary languages are required and neither
 * is synthesized by the build: a missing translation is a missing translation.
 * Every free-text field is length-bounded, because a declared section reaches
 * a published artifact verbatim.
 */
export const catalogSectionSchema = z.object({
  category: categorySchema,
  summary: z.object({
    en: z.string().min(1).max(200),
    zh: z.string().min(1).max(200),
  }),
  capabilities: z.array(z.string().min(1).max(CAPABILITY_MAX_LENGTH)).max(20),
}).strict()

/**
 * Validate one author-declared catalog section.
 * @param value - the raw `dsh.catalog` value from a package manifest.
 * @returns the parsed section, or a single author-readable error string.
 */
export function parseCatalogSection(
  value: unknown,
): { ok: true; value: CatalogSection } | { ok: false; error: string } {
  const result = catalogSectionSchema.safeParse(value)
  if (result.success) return { ok: true, value: result.data }
  const first = result.error.issues[0]
  const path = first === undefined || first.path.length === 0 ? '(root)' : first.path.join('.')
  const message = first === undefined ? 'invalid' : first.message
  return { ok: false, error: `dsh.catalog.${path}: ${message}` }
}
