import { gate, type Accepted } from './gate.ts'
import { gateRepo, type RepoAccepted } from './repo-gate.ts'
import { assignTier, assignRepoTier } from './tier.ts'
import { emit, SCHEMA_VERSION, type Artifacts, type StarsPointer } from './emit.ts'
import { compareStrings, firstSeenKey, repoUnit } from './identity.ts'
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
 * Registry rows that matched nothing this run, as report lines.
 *
 * A denial, a review or a clearance is matched EXACTLY (the repo keyspace
 * case-folded), so a row whose name is mistyped, re-cased, or left behind by
 * an unpublish simply never fires — and a denial nobody can act on is worse
 * than no denial, because it reads as protection (audit E-5). The grammar
 * check in `config.ts` catches shapes that can never match; this catches the
 * shapes that can but do not.
 *
 * Report-only: no row is dropped and no listing changes. Whether a stale row
 * should be deleted is a human's call — a package can be unpublished for a
 * week and come back.
 * @param candidates - every npm candidate this run harvested.
 * @param repoCandidates - every repository candidate this run harvested.
 * @param config - the human-authored registry files.
 * @returns the lines to add to the build report, or `[]` when everything matched.
 */
export function unmatchedRegistryNotes(
  candidates: readonly Candidate[],
  repoCandidates: readonly RepoCandidate[],
  config: RegistryConfig,
): string[] {
  const npmNames = new Set(candidates.map(candidate => candidate.name))
  const repoFullNames = new Set(repoCandidates.map(candidate => candidate.repo.toLowerCase()))
  const bundleNames = new Set(repoCandidates.map(candidate => candidate.name))
  const rows: { file: string; row: string }[] = []
  for (const [key, review] of config.verified) {
    // The key already says which channel the review is for: an npm review is
    // keyed by package name, a github review by lowercased `owner/slug`.
    const matched = review.reviewedVersion === undefined
      ? repoFullNames.has(key)
      : npmNames.has(key)
    if (!matched) rows.push({ file: 'verified.yml', row: key })
  }
  for (const key of config.denied.keys()) {
    // A denial may name an npm package, a repository, or a bundle name — the
    // repo gate reads all three.
    const matched = npmNames.has(key) || bundleNames.has(key) || repoFullNames.has(key.toLowerCase())
    if (!matched) rows.push({ file: 'denied.yml', row: key })
  }
  for (const entry of config.allowedSimilar) {
    const matched = npmNames.has(entry) || repoFullNames.has(entry.toLowerCase())
    if (!matched) rows.push({ file: 'allowed-similar.yml', row: entry })
  }
  if (rows.length === 0) return []
  rows.sort((a, b) => compareStrings(a.file, b.file) || compareStrings(a.row, b.row))
  return [
    'Registry rows that matched no harvested candidate this run:',
    ...rows.map(row => `- ${row.file}: ${row.row}`),
  ]
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
        // The same unit `repo-gate.ts` names, so a monorepo's shadowed
        // subpackages are distinguishable rows instead of N identical ones
        // whose order followed the harvest (C-6).
        name: repoUnit(repoCandidate),
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
  // Report-only diagnostics. They ride `report.md`, never the hashed data,
  // and they are sorted so the report diffs cleanly.
  const notes: string[] = []
  const listedNames = new Set(entries.map(entry => entry.name))
  const holds = [...config.marketHolds].filter(name => listedNames.has(name)).sort(compareStrings)
  if (holds.length > 0) {
    notes.push(
      `Market holds awaiting human confirmation: ${holds.length}. An LLM judged these a competing plugin market. They are still on the shelf: record \`market: true, by: human\` in markets.yml to withhold one, or \`market: false\` to clear it.`,
      ...holds.map(name => `- ${name}`),
    )
  }
  notes.push(...unmatchedRegistryNotes(candidates, repoCandidates, config))
  return {
    ...emit(entries, rejections, builtAt, stars, schemaVersion, config.notAShop, notes),
    firstSeen,
  }
}
