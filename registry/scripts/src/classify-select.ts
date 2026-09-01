/**
 * Which listings the classifier is asked about, and which names must keep
 * their row (spec 2026-08-26-llm-categorization-design.md §4).
 *
 * Pure, because both halves of the answer are policy: `pending` spends LLM
 * calls, and `liveNames` decides which committed rows survive
 * `mergeCategoryRows`' prune. A name missing from `liveNames` loses its
 * category on the next run — the bug that left every GitHub entry reading
 * `other` — so the rule belongs where a fixture can pin it, not in the
 * script shell.
 * @module classify-select
 */

import type { RegistryConfig } from './config.ts'
import { gate } from './gate.ts'
import type { ClassifyItem } from './llm-client.ts'
import { gateRepo } from './repo-gate.ts'
import type { Candidate, RepoCandidate } from './types.ts'

/**
 * Split the harvest into the classifier's question list and the set of names
 * whose row is still earned.
 *
 * `liveNames` is every derived listing the catalog will carry, classified or
 * not; `pending` is the subset without a row yet. A declared category is in
 * neither: the author owns that row and the prune removes it.
 *
 * @param npmCandidates - the npm half of the harvest.
 * @param repoCandidates - the GitHub half, read from the committed
 *   `repo-state.json` rather than re-harvested: the recorded candidates are
 *   the same values `build.ts` composes the catalog from, and reading them
 *   costs no GitHub call and cannot advance the harvest state. A repository
 *   discovered by today's build is therefore classified by tomorrow's run —
 *   the same "unclassified, retried next build" state D4 already defines.
 * @param config - the human-authored registry files.
 */
export function selectPending(
  npmCandidates: readonly Candidate[],
  repoCandidates: readonly RepoCandidate[],
  config: RegistryConfig,
): { pending: ClassifyItem[]; liveNames: Set<string> } {
  const liveNames = new Set<string>()
  // Keyed by name: 83 of the 2704 bundle names on the GitHub side are claimed
  // by a fork as well as an original (measured 2026-09-01), and asking about
  // the same name twice spends two calls to write one row.
  const pending = new Map<string, ClassifyItem>()

  // npm first, as pipeline.ts composes the catalog: its entries own the bundle
  // names, so the ACCEPTED npm names — declared and derived alike — are what
  // shadows the repo half.
  const npmAccepted = new Set<string>()
  for (const candidate of npmCandidates) {
    const result = gate(candidate, config)
    if (!result.ok) continue
    npmAccepted.add(candidate.name)
    if (result.accepted.metadata !== 'derived') continue
    liveNames.add(candidate.name)
    if (config.categories.has(candidate.name)) continue
    if (!pending.has(candidate.name)) {
      pending.set(candidate.name, { name: candidate.name, description: candidate.description, keywords: candidate.keywords })
    }
  }

  for (const candidate of repoCandidates) {
    // shadowed-by-npm (pipeline.ts): the npm package is listed and the
    // repository is not, so this name's row describes the npm package.
    if (npmAccepted.has(candidate.name)) continue
    const result = gateRepo(candidate, config)
    if (!result.ok) continue
    if (result.accepted.metadata !== 'derived') continue
    liveNames.add(candidate.name)
    if (config.categories.has(candidate.name)) continue
    if (!pending.has(candidate.name)) {
      // No keywords: a RepoCandidate carries the repository description and
      // nothing else the classifier can read. Manifest keywords would need a
      // new field in repo-state.json and a re-fetch of every recorded repo to
      // fill it, since a carried-over entry has none.
      pending.set(candidate.name, { name: candidate.name, description: candidate.description, keywords: [] })
    }
  }

  // Sorted, so the same harvest asks the same questions in the same batches:
  // npm's search order is not stable, and which names share a batch is part of
  // what the classifier sees.
  return {
    pending: [...pending.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    liveNames,
  }
}
