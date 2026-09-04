import { gate, type Accepted } from './gate.ts'
import { gateRepo, type RepoAccepted } from './repo-gate.ts'
import { assignTier, assignRepoTier } from './tier.ts'
import { emit, SCHEMA_VERSION, type Artifacts, type StarsPointer } from './emit.ts'
import { firstSeenKey } from './identity.ts'
import type { RegistryConfig } from './config.ts'
import type { Candidate, Entry, Rejection, RepoCandidate } from './types.ts'

/** Every artifact of one build, plus the rows to write back. */
export interface PipelineResult extends Artifacts {
  /**
   * The first-seen map as it must be committed: the rows already recorded,
   * plus the build date for every identity that reached the CATALOG for the
   * first time. Decided here rather than in `build.ts` because it is a policy
   * question — which candidates are entries — and `build.ts` cannot answer it
   * without running the gate.
   */
  firstSeen: Map<string, string>
}

/**
 * Run the whole catalog build as a pure function.
 *
 * Purity is what makes the determinism test possible: the only inputs are the
 * candidates, the registry files, and the timestamp, so the same three
 * produce byte-identical artifacts regardless of candidate order or clock.
 * The one clock-dependent output is `added` for an identity appearing for the
 * FIRST time, which is why the committed `first-seen.yml` is what keeps the
 * content hash stable from day to day.
 * @param candidates - packages fetched from npm, in any order.
 * @param repoCandidates - repositories fetched from GitHub, in any order.
 * @param config - the human-authored registry files.
 * @param builtAt - ISO 8601 build timestamp.
 * @param preexistingRejections - rejections decided before this function ran, such as a
 *   name that could not be turned into a candidate at all (e.g. a failed fetch); merged
 *   into the emitted report alongside every rejection this function produces itself.
 * @param stars - optional pointer to a published stars sidecar, passed through to emit.
 * @returns the artifacts to publish and commit, and the first-seen rows to write back.
 */
export function runPipeline(
  candidates: Candidate[],
  repoCandidates: RepoCandidate[],
  config: RegistryConfig,
  builtAt: string,
  preexistingRejections: Rejection[] = [],
  stars: StarsPointer | null = null,
  schemaVersion: number = SCHEMA_VERSION,
): PipelineResult {
  const rejections: Rejection[] = [...preexistingRejections]
  const today = builtAt.slice(0, 10)

  // Gate everything first, tier second. `added` is the date an entry first
  // appeared in the CATALOG (types.ts), so it cannot be decided until the
  // gate has said which candidates ARE entries. Stamping every harvested
  // candidate before the gate — what build.ts used to do — gave a package
  // rejected for weeks and then listed the date of its first HARVEST (B-9).
  //
  // npm first: its entries own the bundle names (npm wins by design — real
  // semver beats a commit pin), and repo candidates for the same name are
  // recorded as shadowed, not silently dropped. Only ACCEPTED npm names
  // shadow, so a denied npm package leaves its repository to be judged on its
  // own merits (B-6).
  const npmNames = new Set<string>()
  const accepted: Accepted[] = []
  for (const candidate of candidates) {
    const result = gate(candidate, config)
    if (!result.ok) {
      rejections.push(result.rejection)
      continue
    }
    npmNames.add(candidate.name)
    accepted.push(result.accepted)
  }
  const acceptedRepos: RepoAccepted[] = []
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
    if (!result.ok) {
      rejections.push(result.rejection)
      continue
    }
    acceptedRepos.push(result.accepted)
  }

  // First seen, for the entries that got in, keyed by identity: the npm name,
  // or the repository's lowercased `owner/slug`. A recorded row always wins —
  // this map only ever grows.
  const firstSeen = new Map(config.firstSeen)
  for (const item of accepted) {
    const key = firstSeenKey({ source: 'npm', name: item.candidate.name })
    if (!firstSeen.has(key)) firstSeen.set(key, today)
  }
  for (const item of acceptedRepos) {
    const key = firstSeenKey({ source: 'github', name: item.repo.name, repo: item.repo.repo })
    if (!firstSeen.has(key)) firstSeen.set(key, today)
  }
  const withFirstSeen: RegistryConfig = { ...config, firstSeen }

  const entries: Entry[] = [
    ...accepted.map(item => assignTier(item, withFirstSeen)),
    ...acceptedRepos.map(item => assignRepoTier(item, withFirstSeen)),
  ]
  return {
    ...emit(entries, rejections, builtAt, stars, schemaVersion, config.notAShop),
    firstSeen,
  }
}
