import { distance } from 'fastest-levenshtein'
import { parseCatalogSection } from './schema.ts'
import { DERIVED_SUMMARY_MAX_LENGTH, SIMILARITY_THRESHOLD } from './gate.ts'
import type { RegistryConfig } from './config.ts'
import type { CatalogSection, Rejection, RepoCandidate } from './types.ts'

/** A repo candidate that passed every gate rule. */
export interface RepoAccepted {
  repo: RepoCandidate
  catalog: CatalogSection
  /** Whether `catalog` is the author's declaration or derived from the repo description. */
  metadata: 'declared' | 'derived'
}

/** Build one rejection. */
function reject(name: string, code: Rejection['code'], detail: string): { ok: false; rejection: Rejection } {
  return { ok: false, rejection: { name, code, detail } }
}

/**
 * Apply every admission rule to one GitHub repository candidate. The repo
 * (`owner/slug`) is the rejection key — that is the unit an author acts on —
 * but a denial can name either the repo or the bundle name, and the
 * typosquatting hold probes both.
 *
 * The `no-bundle` rule is the one that matters most: a repo whose manifest
 * declares no `dsh.bundle` installs as a plain dependency (exit 0) while dsh
 * registers nothing, a silent no-op for the user. Rejecting it at harvest
 * time is the only honest place to stop it.
 * @param candidate - the repository as fetched.
 * @param config - the human-authored registry files.
 * @returns the accepted candidate, or a rejection carrying an author-readable reason.
 */
export function gateRepo(
  candidate: RepoCandidate,
  config: RegistryConfig,
): { ok: true; accepted: RepoAccepted } | { ok: false; rejection: Rejection } {
  // Denied by repo or by bundle name. `owner/slug` strings cannot collide
  // with npm package names (unscoped names carry no slash), so one map holds
  // both keyspaces.
  const deniedReason = config.denied.get(candidate.repo) ?? config.denied.get(candidate.name)
  if (deniedReason !== undefined) return reject(candidate.repo, 'denied', `Denied by the registry: ${deniedReason}`)

  if (!candidate.hasBundle) {
    return reject(candidate.repo, 'no-bundle',
      'Declares no dsh.bundle in its package.json, so dsh installs it as a plain dependency, not a plugin.')
  }
  if (candidate.license === null || candidate.license === '') {
    return reject(candidate.repo, 'no-license', 'The repository declares no license.')
  }

  let catalog: CatalogSection
  let metadata: 'declared' | 'derived'
  if (candidate.catalog === undefined || candidate.catalog === null) {
    // Same dual-track as the npm gate: derive a listing from the repo
    // description, or reject when there is nothing to show.
    const description = candidate.description?.trim()
    if (description === undefined || description === '') {
      return reject(candidate.repo, 'no-summary',
        'Declares no dsh.catalog and the repository has no description, so there is nothing to list.')
    }
    catalog = {
      category: config.categories.get(candidate.name) ?? 'other',
      summary: { en: description.slice(0, DERIVED_SUMMARY_MAX_LENGTH) },
      capabilities: [],
    }
    metadata = 'derived'
  } else {
    const parsed = parseCatalogSection(candidate.catalog)
    if (!parsed.ok) return reject(candidate.repo, 'invalid-catalog', parsed.error)
    catalog = parsed.value
    metadata = 'declared'
  }

  // The typosquatting hold probes the slug (without the owner, whose prefix
  // would drown any distance) AND the bundle name: either can impersonate a
  // verified package.
  const slug = candidate.repo.split('/')[1] ?? candidate.repo
  if (!config.allowedSimilar.has(candidate.repo) && !config.allowedSimilar.has(candidate.name)) {
    for (const verifiedName of config.verified.keys()) {
      for (const probe of [slug, candidate.name]) {
        const edits = distance(probe, verifiedName)
        if (edits === 0 || edits > SIMILARITY_THRESHOLD) continue
        return reject(candidate.repo, 'name-too-similar',
          `Within ${edits} edit(s) of the verified package ${verifiedName}; held for human adjudication.`)
      }
    }
  }

  return { ok: true, accepted: { repo: candidate, catalog, metadata } }
}
