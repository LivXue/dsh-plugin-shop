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
 * Whether a build may publish github `peers`, decided from the raw value of
 * `SHOP_EMIT_REPO_PEERS` alone.
 *
 * The flag has two readers and they must agree: `build.ts`, which withholds
 * before its own gate passes, and `classify.ts`, which re-reads the same
 * `repo-state.json` candidates a day later and gates them a third time. An
 * inline `=== '1'` in each is two places to drift, and they had: classify
 * gated candidates with peers still attached, so a repository whose peers
 * alone cross the payload budget was listed by the build and dropped from
 * `liveNames` by the classifier, which then pruned its `categories.yml` row —
 * the entry listed as `other` every day until the flag flipped (finding #5 of
 * the PR #58 review). Taking the value as a parameter rather than reading
 * `process.env` keeps this module pure; the callers are the ones that read
 * the environment.
 * @param flag - `process.env.SHOP_EMIT_REPO_PEERS` as the caller read it.
 * @returns whether the flag is the exact string `'1'`.
 */
export function repoPeersEmitted(flag: string | undefined): boolean {
  return flag === '1'
}

/**
 * The repository candidates this build may emit, with their `peers` withheld
 * until the release that can read them is out.
 *
 * `peers` on a github entry is a record every shop judges — and a shop from
 * 0.8.3 or earlier judges it by node resolution alone, which on the current
 * harness badges platform seed words (design 2026-09-01-harness-compatibility
 * §9.1). Measured on a seeded sample of 297 real github manifests
 * (2026-09-24): such a client would badge about 15% of github entries, half of
 * them for seed words alone. Publishing github peers before the shop that
 * refines against the module table is `latest` would therefore raise an
 * installed shop's false alarms rather than lower them — so emission waits on
 * `SHOP_EMIT_REPO_PEERS`, flipped in the release commit that first promotes
 * that shop, the same choreography `SHOP_HARVEST_REPOS`,
 * `SHOP_HARVEST_SUBPACKAGES` and `SHOP_CATALOG_V5` followed.
 *
 * Only EMISSION is gated. The harvest reads peers and `repo-state.json` keeps
 * them whatever this answers, so the record is as complete as the backfill has
 * made it on the day the flag flips. Two callers apply this to their own copy
 * of the same harvest: `build.ts`, after that file is written, and
 * `classify.ts`, reading the file back a day later — and because
 * `repo-state.json` keeps the peers it recorded, the classifier's copy has
 * them attached until this strips them. Both must, or the payload budget
 * measures two different candidates. Stripping before either gate pass also
 * keeps that budget honest: it measures the bytes `emit` will write, and
 * withheld peers are not written. npm entries are untouched — their peers
 * already reach every shop.
 * @param repoCandidates - the repository candidates this run harvested.
 * @param emitRepoPeers - whether this build may publish github peers
 *   ({@link repoPeersEmitted} decides it from the raw flag).
 * @returns the candidates to gate and emit, and how many candidates had a
 *   non-empty `peers` withheld — a report figure, never a listing decision.
 */
export function withholdRepoPeers(
  repoCandidates: readonly RepoCandidate[],
  emitRepoPeers: boolean,
): { candidates: RepoCandidate[]; withheld: number } {
  if (emitRepoPeers) return { candidates: [...repoCandidates], withheld: 0 }
  let withheld = 0
  const candidates = repoCandidates.map(candidate => {
    if (candidate.peers === undefined) return candidate
    if (candidate.peers.length > 0) withheld += 1
    const { peers: _withheld, ...rest } = candidate
    return rest
  })
  return { candidates, withheld }
}

/**
 * Why the github declarations re-read stopped early, as a build-note
 * fragment to append next to its counts — `''` when it did not.
 *
 * `RepoHarvestResult.rereadStopped` (github-client.ts, Task 3) is `null` when
 * the phase ran to its own budget or its queue simply emptied, so there is
 * nothing to add. The two non-null values are `'time-budget'` (the phase's
 * own time budget, {@link DECLARATIONS_REREAD_TIME_BUDGET_MS_DEFAULT} in
 * github-client.ts, was spent) and `'failure-breaker'` (the host, not any one
 * record, failed {@link DECLARATIONS_REREAD_MAX_CONSECUTIVE_FAILURES} times in
 * a row — see that constant's doc in github-client.ts). Either way the counts
 * already printed beside it (`rereadAttempted`, `rereadDeferred`, ...) say how
 * much of the queue that left; this only says why.
 * @param stopped - `RepoHarvestResult.rereadStopped`, verbatim.
 * @returns `'; re-read stopped: time budget'`, `'; re-read stopped: failure
 *   breaker'`, or `''` for `null`.
 */
export function describeRereadStopped(stopped: 'time-budget' | 'failure-breaker' | null): string {
  switch (stopped) {
    case null: return ''
    case 'time-budget': return '; re-read stopped: time budget'
    case 'failure-breaker': return '; re-read stopped: failure breaker'
  }
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
 * Run the admission gate and the tiering, and nothing else.
 *
 * Split out of {@link runPipeline} because `build.ts` needs to know which
 * candidates ARE entries before its network step: the stars sidecar is keyed
 * by the catalog, and the GraphQL star fetch should ask about listed entries
 * rather than every candidate the harvest saw. Both callers pass the same
 * inputs and this function is pure, so they cannot disagree — a property
 * `pipeline.test.ts` asserts directly, because a sidecar keyed off a different
 * catalog than the published one is exactly the bug this replaced.
 *
 * The gate therefore runs twice per build. Both passes are pure, do no I/O,
 * and their heaviest work is a levenshtein sweep against `verified.yml`, which
 * holds zero rows. The alternative — `build.ts` calling this and `emit`
 * directly, skipping `runPipeline` — was rejected because it would leave
 * `runPipeline` exercised only by tests.
 * @param candidates - packages fetched from npm, in any order.
 * @param repoCandidates - repositories fetched from GitHub, in any order.
 * @param config - the human-authored registry files.
 * @param builtAt - ISO 8601 build timestamp; only its date part is read, to
 *   stamp `added` for an identity reaching the catalog for the first time.
 * @returns the tiered entries, every rejection the gate produced, and the
 *   first-seen map to commit.
 */
export function selectEntries(
  candidates: readonly Candidate[],
  repoCandidates: readonly RepoCandidate[],
  config: RegistryConfig,
  builtAt: string,
): { entries: Entry[]; rejections: Rejection[]; firstSeen: Map<string, string> } {
  const rejections: Rejection[] = []
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
  return { entries, rejections, firstSeen }
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
  const selected = selectEntries(candidates, repoCandidates, config, builtAt)
  const rejections: Rejection[] = [...preexistingRejections, ...selected.rejections]
  const entries = selected.entries
  const firstSeen = selected.firstSeen

  // Report-only diagnostics. They ride `report.md`, never the hashed data,
  // and they are sorted so the report diffs cleanly.
  const notes: string[] = []
  const listedNames = new Set(entries.map(entry => entry.name))
  // Withheld on a classifier pass alone. The verdict stands — one pass is
  // accurate enough for the question — but a recorded row is never asked
  // again, so this line is the only thing that would ever surface a wrong one
  // for a spot-check.
  const llmOnly = config.marketRows
    .filter(row => row.market && row.by === 'llm' && listedNames.has(row.name))
    .map(row => row.name)
    .sort(compareStrings)
  if (llmOnly.length > 0) {
    notes.push(
      `Withheld from the shelf on an LLM verdict alone: ${llmOnly.length}. Each was judged a competing plugin market by the classifier and no human has looked. To correct one, edit its row in markets.yml — \`market: false\` clears it, and a recorded row is never re-asked.`,
      ...llmOnly.map(name => `- ${name}`),
    )
  }
  notes.push(...unmatchedRegistryNotes(candidates, repoCandidates, config))
  return {
    ...emit(entries, rejections, builtAt, stars, schemaVersion, config.notAShop, notes),
    firstSeen,
  }
}
