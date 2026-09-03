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
 * Maximum length of the error this module composes.
 *
 * The string is an author-readable rejection `detail`: `emit.ts` writes it
 * into `dist/v1/report.md` and the daily workflow publishes that to Pages. So
 * it is a free-text field reaching a published artifact, exactly like the ones
 * bounded above — and it was the last one left, because zod's
 * `unrecognized_keys` message ECHOES the offending key verbatim. Measured
 * through the real parser, a 200,000-character key composed a
 * 200,040-character detail.
 *
 * 200 is chosen against measurement, not taste: every message this schema can
 * produce is 45-117 characters, so no legitimate reason is altered by a single
 * byte. Note that the bounds added for `capabilities`, `license` and
 * `repository` do NOT echo the offending value — `Too big: expected string to
 * have <=64 characters` names the limit and not the input — so the echo is
 * specific to an unrecognized key, and that property is worth keeping.
 */
export const CATALOG_ERROR_MAX_LENGTH = 200

/**
 * Appended when the message above was cut. Visible on purpose: without it an
 * author reads a truncated reason as the whole reason and goes looking for a
 * problem in the wrong place.
 */
const TRUNCATION_MARKER = '… (truncated)'

/**
 * Validate one author-declared catalog section.
 * @param value - the raw `dsh.catalog` value from a package manifest.
 * @returns the parsed section, or a single author-readable error string,
 *   bounded to {@link CATALOG_ERROR_MAX_LENGTH}.
 */
export function parseCatalogSection(
  value: unknown,
): { ok: true; value: CatalogSection } | { ok: false; error: string } {
  const result = catalogSectionSchema.safeParse(value)
  if (result.success) return { ok: true, value: result.data }
  const first = result.error.issues[0]
  const path = first === undefined || first.path.length === 0 ? '(root)' : first.path.join('.')
  const message = first === undefined ? 'invalid' : first.message
  const composed = `dsh.catalog.${path}: ${message}`
  if (composed.length <= CATALOG_ERROR_MAX_LENGTH) return { ok: false, error: composed }
  // The path comes first in `composed`, so the surviving head still names the
  // field the author has to fix.
  const head = composed.slice(0, CATALOG_ERROR_MAX_LENGTH - TRUNCATION_MARKER.length)
  return { ok: false, error: `${head}${TRUNCATION_MARKER}` }
}
