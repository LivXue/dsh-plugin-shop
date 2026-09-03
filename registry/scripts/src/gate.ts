import { distance } from 'fastest-levenshtein'
import { isHarnessRepo } from './github-repo.ts'
import { isOwnPackage } from './own.ts'
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

/**
 * Truncate to `maxLength` UTF-16 code units without splitting a surrogate pair.
 *
 * `String.prototype.slice` counts code units, so cutting at a fixed length can
 * land BETWEEN the two halves of an astral character (an emoji, most CJK
 * extension characters) and leave a lone surrogate in the result. That value
 * reaches `plugins.json`, the file every reader downloads: `JSON.stringify`
 * escapes the orphan as `\ud83d`, so the artifact stays valid JSON and its
 * content hash stays stable — which is exactly why nothing here would notice —
 * but any consumer that parses it and re-encodes UTF-8 fails on it (Python
 * raises `UnicodeEncodeError: surrogates not allowed`). Dropping the orphan
 * costs the author one character of a summary that was being cut anyway.
 *
 * Shared by both derived-summary sites — `gate.ts` and `repo-gate.ts` — rather
 * than written out twice; a bound that exists in two copies is a bound that
 * gets fixed in one.
 * @param value - the text to truncate.
 * @param maxLength - the maximum number of UTF-16 code units to keep.
 * @returns `value`, or its first `maxLength` code units with a trailing
 *   unpaired high surrogate removed.
 */
export function truncateWholeCharacters(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value
  const cut = value.slice(0, maxLength)
  const last = cut.charCodeAt(cut.length - 1)
  // A HIGH surrogate in final position is the first half of a pair whose
  // second half the cut just removed. A low surrogate there is a complete
  // pair that happens to end at the bound, and must survive.
  return last >= 0xD800 && last <= 0xDBFF ? cut.slice(0, -1) : cut
}

/**
 * Maximum length of a `license` string. npm takes the field verbatim and it
 * reaches every published entry; a value past this is not an SPDX identifier
 * (the longest expression in use, `Apache-2.0 WITH LLVM-exception`, is 30
 * characters). Bounded HERE and not in `toCandidate`, so the rejection can say
 * what is actually wrong: nulling the field in the shell would publish
 * "Declares no license." for a package that declared a one-megabyte one.
 */
export const LICENSE_MAX_LENGTH = 128

/**
 * Maximum length of a `repository` URL. A GitHub URL is under 100 characters;
 * the headroom covers a self-hosted path. Same reasoning as
 * {@link LICENSE_MAX_LENGTH} for why the bound is a gate rule.
 */
export const REPOSITORY_MAX_LENGTH = 512

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
function reject(
  name: string,
  code: Rejection['code'],
  detail: string,
  replacement?: string,
): { ok: false; rejection: Rejection } {
  return {
    ok: false,
    rejection: {
      name, code, detail,
      ...(replacement !== undefined ? { replacement } : {}),
    },
  }
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

  if (isOwnPackage(name)) {
    return reject(name, 'self',
      'This is the shop itself, so it is not listed on its own shelf; install it with dsh plugin add.')
  }

  const denial = config.denied.get(name)
  if (denial !== undefined) {
    const suffix = denial.replacement === undefined ? '' : ` Known replacement: ${denial.replacement}.`
    return reject(name, 'denied', `Denied by the registry: ${denial.reason}${suffix}`, denial.replacement)
  }

  if (!candidate.hasBundle) {
    return reject(name, 'no-bundle',
      'Declares no dsh.bundle, so it is a library rather than an installable plugin.')
  }
  if (candidate.deprecated) return reject(name, 'deprecated', 'Marked deprecated on npm.')
  if (candidate.license === null || candidate.license === '') {
    return reject(name, 'no-license', 'Declares no license.')
  }
  if (candidate.license.length > LICENSE_MAX_LENGTH) {
    return reject(name, 'no-license',
      `Declares a license string longer than ${LICENSE_MAX_LENGTH} characters, so it is not an SPDX identifier.`)
  }
  if (candidate.repository === null || candidate.repository === '') {
    return reject(name, 'no-repository',
      'Declares no repository, so the published code cannot be audited.')
  }
  if (candidate.repository.length > REPOSITORY_MAX_LENGTH) {
    return reject(name, 'no-repository',
      `Declares a repository URL longer than ${REPOSITORY_MAX_LENGTH} characters, so it cannot be audited as a source location.`)
  }
  if (isHarnessRepo(candidate.repository)) {
    return reject(name, 'harness-repository',
      "Declares deepseek-ai/deepseek-harness as its repository, which is the host project rather than this plugin's source, so the published code cannot be audited there.")
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
      summary: { en: truncateWholeCharacters(description, DERIVED_SUMMARY_MAX_LENGTH) },
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
