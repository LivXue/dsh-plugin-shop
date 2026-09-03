import { distance } from 'fastest-levenshtein'
import { isOwnRepo } from './own.ts'
import { parseCatalogSection } from './schema.ts'
import { DERIVED_SUMMARY_MAX_LENGTH, SIMILARITY_THRESHOLD, toWellFormedCatalog, truncateWholeCharacters } from './gate.ts'
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
  // The unit an author acts on: the repo, or `repo#subdir` for a monorepo
  // subpackage — rejection names must point at the thing to fix.
  const unit = candidate.subdir === undefined ? candidate.repo : `${candidate.repo}#${candidate.subdir}`

  // Denied by repo or by bundle name. `owner/slug` strings cannot collide
  // with npm package names (unscoped names carry no slash), so one map holds
  // both keyspaces.
  const denial = config.denied.get(candidate.repo) ?? config.denied.get(candidate.name)
  if (denial !== undefined) {
    const suffix = denial.replacement === undefined ? '' : ` Known replacement: ${denial.replacement}.`
    return reject(unit, 'denied', `Denied by the registry: ${denial.reason}${suffix}`, denial.replacement)
  }
  if (isOwnRepo(candidate.repo)) {
    return reject(unit, 'self',
      'This is the shop\'s own repository, so it is not listed on its own shelf; install it with dsh plugin add.')
  }


  if (!candidate.hasBundle) {
    return reject(unit, 'no-bundle',
      'Declares no dsh.bundle in its package.json, so dsh installs it as a plain dependency, not a plugin.')
  }
  if (candidate.requiresBuild && candidate.release === undefined) {
    return reject(unit, 'requires-build',
      'Declares a prepare/prepack build script, which a git install requires and pnpm blocks by default; the shop never enables build scripts, so the repository could not install. Publish to npm, or drop the script, and it can be listed.')
  }
  if (candidate.hasWorkspaceDeps) {
    return reject(unit, 'workspace-deps',
      'Declares workspace:-protocol dependencies, which resolve only inside the repository\'s own workspace; a git install from outside it cannot succeed. Publish the package to npm, or drop the workspace: specifiers, and it can be listed.')
  }
  if (candidate.license === null || candidate.license === '') {
    return reject(unit, 'no-license', 'The repository declares no license.')
  }

  let catalog: CatalogSection
  let metadata: 'declared' | 'derived'
  if (candidate.catalog === undefined || candidate.catalog === null) {
    // Same dual-track as the npm gate: derive a listing from the repo
    // description, or reject when there is nothing to show.
    const description = candidate.description?.trim()
    if (description === undefined || description === '') {
      return reject(unit, 'no-summary',
        'Declares no dsh.catalog and the repository has no description, so there is nothing to list.')
    }
    catalog = {
      category: config.categories.get(candidate.name) ?? 'other',
      summary: { en: truncateWholeCharacters(description, DERIVED_SUMMARY_MAX_LENGTH) },
      capabilities: [],
    }
    metadata = 'derived'
  } else {
    const parsed = parseCatalogSection(candidate.catalog)
    if (!parsed.ok) return reject(unit, 'invalid-catalog', parsed.error)
    catalog = parsed.value
    metadata = 'declared'
  }

  // The typosquatting hold probes the slug (without the owner, whose prefix
  // would drown any distance) AND the bundle name: either can impersonate a
  // verified package. Unlike the npm gate — where an exact name IS the same
  // identity — an exact match here is a DIFFERENT identity claiming a
  // verified name, the most dangerous lookalike there is, so edits === 0
  // holds too. `allowed-similar.yml` is the human escape for a legitimate
  // source (e.g. the verified package's own repository).
  const slug = candidate.repo.split('/')[1] ?? candidate.repo
  if (!config.allowedSimilar.has(candidate.repo) && !config.allowedSimilar.has(candidate.name)) {
    for (const verifiedName of config.verified.keys()) {
      for (const probe of [slug, candidate.name]) {
        const edits = distance(probe, verifiedName)
        if (edits > SIMILARITY_THRESHOLD) continue
        return reject(unit, 'name-too-similar',
          edits === 0
            ? `Exactly matches the verified package ${verifiedName}; only an explicitly allowed source may use that name; held for human adjudication.`
            : `Within ${edits} edit(s) of the verified package ${verifiedName}; held for human adjudication.`)
      }
    }
  }

  // The one place every accepted catalog passes, declared or derived.
  return { ok: true, accepted: { repo: candidate, catalog: toWellFormedCatalog(catalog), metadata } }
}
