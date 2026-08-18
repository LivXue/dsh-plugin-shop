import { z } from 'zod'
import type { CatalogSection } from './types.ts'

/** Closed category enum; adding a member is a schema change. */
export const categorySchema = z.enum(['tool', 'provider', 'ui', 'workflow', 'integration', 'other'])

/**
 * The `dsh.catalog` section. Both summary languages are required and neither
 * is synthesized by the build: a missing translation is a missing translation.
 */
export const catalogSectionSchema = z.object({
  category: categorySchema,
  summary: z.object({
    en: z.string().min(1).max(200),
    zh: z.string().min(1).max(200),
  }),
  capabilities: z.array(z.string().min(1)).max(20),
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
