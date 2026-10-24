import { gate, type Accepted } from './gate.ts'
import { gateRepo, type RepoAccepted } from './repo-gate.ts'
import { assignTier, assignRepoTier } from './tier.ts'
import { emit, SCHEMA_VERSION, type Artifacts, type IconsPointer, type StarsPointer } from './emit.ts'
import { compareStrings, firstSeenKey, installIdentity } from './identity.ts'
import { acceptedNpmRepositories, npmShadowOf } from './npm-shadow.ts'
import type { RegistryConfig } from './config.ts'
import type { IconFetchResult, IconPlan } from './icon-plan.ts'
import type { IconKey, IconOutcome } from './icon-state.ts'
import type { IconsFile } from './icons-assemble.ts'
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
 * the entry listed as `other` every day until the flag flipped (design
 * 2026-09-01-harness-compatibility section 9.8). Taking the value as a
 * parameter rather than reading `process.env` keeps this module pure; the
 * callers are the ones that read the environment.
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
 * `RepoHarvestResult.rereadStopped` (github-client.ts) is `null` when
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
 * Parse a per-run budget from its environment string, for the variable `name`:
 * the icon step's `ICON_FETCH_BUDGET` (keys to fetch) and
 * `ICON_FETCH_TIME_BUDGET_MS` (how long fetches may keep starting).
 *
 * The same contract as `parseHarvestBudget` (github-client.ts), which names the
 * one variable it was written for in its message, and `Number()` fails open here
 * in the same ways. `''` and `' '` read as `0`. `Number('abc')` is `NaN`, which
 * `planIconWork` would slice its fetches at and `harvestIcons` would compare an
 * elapsed time with: `elapsed >= NaN` is never true, so a NaN deadline is no
 * deadline at all. A negative count counts from the end of a list. And a value
 * past 2**53 is an integer that no longer reads back as the number written.
 * `0` is deliberately not one of them: it is a real instruction, fetch nothing,
 * which is why the check cannot simply refuse a falsy budget.
 * @param name - the variable, for the message.
 * @param raw - the environment value, or undefined when unset.
 * @param fallback - the budget to use when the variable is unset.
 * @throws when the value is present but not a non-negative safe integer, naming
 *   the variable and quoting the value back: the operator cannot see it in a log
 *   line that says nothing was fetched.
 */
export function parseBudgetVariable(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback
  const budget = Number(raw)
  if (raw.trim() === '' || !Number.isSafeInteger(budget) || budget < 0) {
    throw new Error(`${name} must be a non-negative safe integer; got ${JSON.stringify(raw)}`)
  }
  return budget
}

/**
 * The report's note for a lost icons file, or `null` when nothing was lost
 * (design 2026-10-23-shop-plugin-icons §5.1).
 *
 * The icon step reuses an icon from the icons file the last build published, and
 * fetches again, from its recorded source, one whose bytes that file no longer
 * holds. When the file cannot be read at all (an outage, a deploy that failed
 * after the snapshot commit, a host that served something else) every icon the
 * record holds published takes that road at once, under the same per-run budget
 * as a first read, and the catalog quietly loses the icons the budget did not
 * reach. The section's counts say how many; this says why.
 *
 * Said only when the file is missing AND the record holds a published row: a
 * first run has no record, and a record of refusals loses nothing with the file.
 * An index with no icons pointer is not a missing file: `readPublishedIcons`
 * answers it with the empty file, since a build that published no icon (every
 * one withheld, say) writes exactly that index, and no line here is true of it.
 *
 * A fetch counts as a refetch when the plan expects a sha256 of it, which it
 * does exactly for a key the record holds published, and as started when
 * `harvestIcons` answered for it, whatever the answer. A refetch the time
 * budget never started has no answer, and was turned away as surely as a key
 * past the count budget. A key the record has never met is a first read, and
 * the budgets turning it away is the section's `not yet read`, not a loss.
 * @param state - the committed record, `icon-state.json`.
 * @param published - what `readPublishedIcons` returned.
 * @param plan - from `planIconWork` on the same record and file.
 * @param results - what `harvestIcons` answered: one result for each fetch it started.
 */
export function describeLostIconsFile(
  state: ReadonlyMap<IconKey, IconOutcome>,
  published: IconsFile | null,
  plan: Pick<IconPlan, 'fetch' | 'deferred'>,
  results: ReadonlyMap<IconKey, IconFetchResult>,
): string | null {
  if (published !== null) return null
  if (![...state.values()].some(row => row.outcome === 'published')) return null
  const refetches = plan.fetch.filter(work => work.expectSha256 !== undefined)
  const started = refetches.filter(work => results.has(work.key)).length
  const turnedAway = refetches.length - started + plan.deferred.filter(key => state.get(key)?.outcome === 'published').length
  return `The published icons file could not be read, so icons recorded as published were fetched again: ${started} started within this build's budgets, ${turnedAway} turned away by them.`
}

/**
 * Throw when an entry would name an icon the icons file does not hold.
 *
 * `foldIconResults` builds the file and the map from entries to icons together,
 * and guarantees every sha256 in the map is a key of the file. The build asserts
 * it before `runPipeline` sets those keys on the entries anyway, because a
 * dangling one passes every check downstream: it is 64 hexadecimal digits, so the
 * grammar in `assertCatalogInvariants` accepts it, and the shop looks it up,
 * finds nothing and draws the default artwork, which is exactly how a plugin
 * with no icon looks. A published catalog that is plausible and wrong is what
 * this project stops instead of shipping.
 *
 * Own keys only, as everywhere an icon is looked up: `toString` is not an icon.
 * @param byIdentity - the install identity of each listed entry that carries an
 *   icon, to the sha256 of that icon.
 * @param file - the icons file the build publishes, or `null` when it publishes none.
 * @throws when any sha256 in `byIdentity` is not a key of `file.icons`. The
 *   message counts them and names the first by install identity, in code-unit
 *   order, so that it does not depend on the order the entries came in.
 */
export function assertIconsInFile(byIdentity: ReadonlyMap<string, string>, file: IconsFile | null): void {
  const dangling = [...byIdentity]
    .filter(([, sha256]) => file === null || !Object.hasOwn(file.icons, sha256))
    .sort(([a], [b]) => compareStrings(a, b))
  const [first] = dangling
  if (first === undefined) return
  throw new Error(
    `icons: listed entries naming an icon the icons file does not hold: ${dangling.length}, the first being ${JSON.stringify(first[0])} (${JSON.stringify(first[1])})`,
  )
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
 * A `withheld-icons.yml` row has the same hazard: a well-formed but mistyped
 * name loads, matches nothing, and the icon it was written to hold back stays
 * published. It is judged against what the catalog LISTS, not against what the
 * harvest saw, because an icon can be withheld only from a listed entry: a row
 * naming a candidate the gate turned away withholds nothing today. Its keys are
 * the ones `firstSeenKey` gives an entry — an npm name as written, a
 * repository's `owner/slug` lower-cased — so a row that names a repository's
 * bundle name, which is no key of any entry, never fires and is reported.
 *
 * Report-only: no row is dropped and no listing changes. Whether a stale row
 * should be deleted is a human's call — a package can be unpublished for a
 * week and come back.
 * @param candidates - every npm candidate this run harvested.
 * @param repoCandidates - every repository candidate this run harvested.
 * @param config - the human-authored registry files.
 * @param listed - the entries the catalog lists. Only their identity is read,
 *   so it does not matter whether the icon step has attached an icon yet.
 * @returns the lines to add to the build report, or `[]` when everything matched.
 */
export function unmatchedRegistryNotes(
  candidates: readonly Candidate[],
  repoCandidates: readonly RepoCandidate[],
  config: RegistryConfig,
  listed: readonly Pick<Entry, 'source' | 'name' | 'repo'>[],
): string[] {
  const npmNames = new Set(candidates.map(candidate => candidate.name))
  const repoFullNames = new Set(repoCandidates.map(candidate => candidate.repo.toLowerCase()))
  const bundleNames = new Set(repoCandidates.map(candidate => candidate.name))
  const listedKeys = new Set(listed.map(entry => firstSeenKey(entry)))
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
  for (const key of config.withheldIcons.keys()) {
    // Already keyed as `firstSeenKey` keys an entry (config.ts), so the lookup
    // needs no folding of its own.
    if (!listedKeys.has(key)) rows.push({ file: 'withheld-icons.yml', row: key })
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
  // npm first: an npm package wins over its own repository by design (real
  // semver beats a commit pin), so a repository candidate of an accepted
  // package's bundle name is recorded as shadowed, not silently dropped, when
  // `npmShadowOf` says the package covers it: the package's own repository,
  // the other repositories of its owner, and — when the package's
  // `repository` is not a plain GitHub URL, so there is nothing to compare —
  // every repository of the name. Another owner's repository goes on to the
  // repo gate, and is listed beside the package only if it passes there
  // (design 2026-10-19-npm-shadow-by-owner §2). `selectPending` builds the
  // same map and asks the same function, so the classifier gives a candidate
  // the verdict the build gives it; it reads the committed `repo-state.json`,
  // one build behind this harvest, so it judges a repository that changed
  // owner in between a run after this build does (§4). The map holds only the
  // gate's ACCEPTED npm packages, so a denied npm package hides nothing and
  // leaves its repository to be judged on its own merits (B-6).
  const accepted: Accepted[] = []
  for (const candidate of candidates) {
    const result = gate(candidate, config)
    if (!result.ok) {
      rejections.push(result.rejection)
      continue
    }
    accepted.push(result.accepted)
  }
  const acceptedNpm = acceptedNpmRepositories(accepted)
  const acceptedRepos: RepoAccepted[] = []
  for (const repoCandidate of repoCandidates) {
    const shadow = npmShadowOf(repoCandidate, acceptedNpm)
    if (shadow !== null) {
      rejections.push(shadow)
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
 * @param icons - the icon step's output when it published an icons file: the
 *   `pointer` the index carries, and `byIdentity`, the sha256 that keys each
 *   listed entry's icon in that file, by the entry's install identity. An
 *   entry the map names gets `icon`; an identity that is no entry's changes
 *   nothing, so an icon decides nothing about what is listed. The icon is set
 *   after the gate, which is why the payload budget never counts it.
 *   `byIdentity` is read by a lookup per entry and never iterated: its order
 *   is the order the icon step met the entries in, which follows the input,
 *   and no artifact may depend on that.
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
  icons: { pointer: IconsPointer; byIdentity: ReadonlyMap<string, string> } | null = null,
): PipelineResult {
  const selected = selectEntries(candidates, repoCandidates, config, builtAt)
  const rejections: Rejection[] = [...preexistingRejections, ...selected.rejections]
  // After `selectEntries` and not inside it: the gate measures an entry's
  // payload against `ENTRY_PAYLOAD_MAX_BYTES` from the candidate, so an icon
  // attached here is never counted and can never delist the entry that
  // declares it (design 2026-10-23-shop-plugin-icons §6.1).
  const entries = icons === null
    ? selected.entries
    : selected.entries.map((entry): Entry => {
      const icon = icons.byIdentity.get(installIdentity(entry))
      return icon === undefined ? entry : { ...entry, icon }
    })
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
  notes.push(...unmatchedRegistryNotes(candidates, repoCandidates, config, entries))
  return {
    ...emit(entries, rejections, builtAt, stars, schemaVersion, config.notAShop, notes, icons?.pointer ?? null),
    firstSeen,
  }
}
