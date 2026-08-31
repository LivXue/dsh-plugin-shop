import { gate } from './gate.ts'
import { gateRepo } from './repo-gate.ts'
import { assignTier, assignRepoTier } from './tier.ts'
import { emit, SCHEMA_VERSION, type Artifacts, type StarsPointer } from './emit.ts'
import type { RegistryConfig } from './config.ts'
import type { Candidate, Entry, Rejection, RepoCandidate } from './types.ts'

/**
 * Run the whole catalog build as a pure function.
 *
 * Purity is what makes the determinism test possible: the only inputs are the
 * candidates, the registry files, and the timestamp, so the same three
 * produce byte-identical artifacts regardless of candidate order or clock.
 * @param candidates - packages fetched from npm, in any order.
 * @param repoCandidates - repositories fetched from GitHub, in any order.
 * @param config - the human-authored registry files.
 * @param builtAt - ISO 8601 build timestamp.
 * @param preexistingRejections - rejections decided before this function ran, such as a
 *   name that could not be turned into a candidate at all (e.g. a failed fetch); merged
 *   into the emitted report alongside every rejection this function produces itself.
 * @param stars - optional pointer to a published stars sidecar, passed through to emit.
 * @returns the artifacts to publish and commit.
 */
export function runPipeline(
  candidates: Candidate[],
  repoCandidates: RepoCandidate[],
  config: RegistryConfig,
  builtAt: string,
  preexistingRejections: Rejection[] = [],
  stars: StarsPointer | null = null,
  schemaVersion: number = SCHEMA_VERSION,
): Artifacts {
  const entries: Entry[] = []
  const rejections: Rejection[] = [...preexistingRejections]

  // npm first: its entries own the bundle names (npm wins by design — real
  // semver beats a commit pin), and repo candidates for the same name are
  // recorded as shadowed, not silently dropped.
  const npmNames = new Set<string>()
  for (const candidate of candidates) {
    const result = gate(candidate, config)
    if (result.ok) {
      npmNames.add(candidate.name)
      entries.push(assignTier(result.accepted, config))
    } else {
      rejections.push(result.rejection)
    }
  }
  for (const repoCandidate of repoCandidates) {
    if (npmNames.has(repoCandidate.name)) {
      rejections.push({
        name: repoCandidate.repo,
        code: 'shadowed-by-npm',
        detail: `The npm package ${repoCandidate.name} is already listed; the repository is not listed separately.`,
      })
      continue
    }
    const result = gateRepo(repoCandidate, config)
    if (result.ok) entries.push(assignRepoTier(result.accepted, config))
    else rejections.push(result.rejection)
  }
  return emit(entries, rejections, builtAt, stars, schemaVersion)
}
