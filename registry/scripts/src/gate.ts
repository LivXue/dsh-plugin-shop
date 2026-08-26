import { distance } from 'fastest-levenshtein'
import { parseCatalogSection } from './schema.ts'
import type { RegistryConfig } from './config.ts'
import type { Candidate, CatalogSection, Rejection } from './types.ts'

/**
 * Maximum edit distance to a verified name that still trips the typosquatting
 * hold. A starting point tunable against the observed false-positive rate;
 * changing it touches this constant and its tests, not the process.
 */
export const SIMILARITY_THRESHOLD = 2

/**
 * Maximum length of a derived `summary.en`. Mirrors the `max(200)` the
 * author-facing schema already imposes on a declared summary, so a derived
 * one respects the same published limit rather than a different one.
 */
export const DERIVED_SUMMARY_MAX_LENGTH = 200

/** A candidate that passed every gate rule, with its optional fields resolved. */
export interface Accepted {
  candidate: Candidate
  catalog: CatalogSection
  integrity: string
  publishedAt: string
  repository: string
  license: string
  /** Whether `catalog` is the author's declaration or derived from npm metadata. */
  metadata: 'declared' | 'derived'
}

/** Build one rejection. */
function reject(name: string, code: Rejection['code'], detail: string): { ok: false; rejection: Rejection } {
  return { ok: false, rejection: { name, code, detail } }
}

/**
 * Apply every admission rule to one candidate.
 *
 * Order matters in one place: denial is checked before similarity, so a
 * lookalike a human already adjudicated reports the adjudication rather than
 * the hold that prompted it.
 * @param candidate - the package as fetched from npm.
 * @param config - the human-authored registry files.
 * @returns the accepted candidate, or a rejection carrying an author-readable reason.
 */
export function gate(
  candidate: Candidate,
  config: RegistryConfig,
): { ok: true; accepted: Accepted } | { ok: false; rejection: Rejection } {
  const { name } = candidate

  const deniedReason = config.denied.get(name)
  if (deniedReason !== undefined) return reject(name, 'denied', `Denied by the registry: ${deniedReason}`)

  if (!candidate.hasBundle) {
    return reject(name, 'no-bundle',
      'Declares no dsh.bundle, so it is a library rather than an installable plugin.')
  }
  if (candidate.deprecated) return reject(name, 'deprecated', 'Marked deprecated on npm.')
  if (candidate.license === null || candidate.license === '') {
    return reject(name, 'no-license', 'Declares no license.')
  }
  if (candidate.repository === null || candidate.repository === '') {
    return reject(name, 'no-repository',
      'Declares no repository, so the published code cannot be audited.')
  }
  if (candidate.integrity === null || candidate.integrity === '') {
    return reject(name, 'no-integrity',
      'The published version carries no dist.integrity, so it cannot be recorded in the snapshot.')
  }
  if (candidate.publishedAt === null) {
    return reject(name, 'no-publish-time', 'npm reports no publication time for this version.')
  }
  let catalog: CatalogSection
  let metadata: 'declared' | 'derived'
  if (candidate.catalog === undefined || candidate.catalog === null) {
    // No dsh.catalog: derive a listing from npm metadata rather than reject,
    // since the field is optional (§6.1). A missing description leaves
    // nothing to show, which is a rejection distinct from a malformed catalog.
    const description = candidate.description?.trim()
    if (description === undefined || description === '') {
      return reject(name, 'no-summary',
        'Declares no dsh.catalog and npm reports no description, so there is nothing to list.')
    }
    catalog = {
      // LLM-assigned when the classifier has a row for this name (spec
      // 2026-08-26-llm-categorization-design.md); `other` until it does.
      category: config.categories.get(name) ?? 'other',
      summary: { en: description.slice(0, DERIVED_SUMMARY_MAX_LENGTH) },
      capabilities: [],
    }
    metadata = 'derived'
  } else {
    // A declared dsh.catalog that fails validation is a rejection, never a
    // silent fallback to derived: the author declared the section and made a
    // mistake worth reporting, not one worth hiding.
    const parsed = parseCatalogSection(candidate.catalog)
    if (!parsed.ok) return reject(name, 'invalid-catalog', parsed.error)
    catalog = parsed.value
    metadata = 'declared'
  }

  if (!config.allowedSimilar.has(name)) {
    for (const verifiedName of config.verified.keys()) {
      const edits = distance(name, verifiedName)
      if (edits === 0 || edits > SIMILARITY_THRESHOLD) continue
      return reject(name, 'name-too-similar',
        `Within ${edits} edit(s) of the verified package ${verifiedName}; held for human adjudication.`)
    }
  }

  return {
    ok: true,
    accepted: {
      candidate,
      catalog,
      integrity: candidate.integrity,
      publishedAt: candidate.publishedAt,
      repository: candidate.repository,
      license: candidate.license,
      metadata,
    },
  }
}
