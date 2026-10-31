/**
 * Catalog build entry point.
 *
 * Network access is confined to `npm-client.ts`, `npm-feed.ts`,
 * `github-client.ts`, `icon-fetch.ts`, `llm-client.ts`, and `github-stars.ts`
 * (the only modules that reach the network). Filesystem access lives in this
 * module (writing the build artifacts), in `config.ts` (reading the registry
 * inputs), and in `emit-schema.ts` (writing the generated schema).
 * The pure core — `gate.ts`, `tier.ts`, `emit.ts`, `pipeline.ts`, `schema.ts`,
 * and `types.ts` — touches neither, so a failure here is an I/O failure
 * rather than a policy one.
 * @module build
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { loadRegistryConfig, serializeFirstSeen } from './config.ts'
import { describeDepartures, parseDepartureSummary, type DepartureSummary } from './departures.ts'
import { applyConfirmations, bootstrapFeedState, describeFeedCoverage, describeFeedRun, feedCarriersByKeyword, parseFeedCoverage, parseFeedRunReport, parseFeedState, serializeFeedState, type FeedInput, type FeedRead, type FeedState } from './feed-state.ts'
import { fetchStarCounts, fetchArchivedFlags, STARS_BUDGET_MS, STARS_REQUEST_TIMEOUT_MS } from './github-stars.ts'
import { GITHUB_REQUEST_TIMEOUT_MS, HARVEST_TOPICS, REPO_BACKFILL_BUDGET_DEFAULT, TARBALL_REQUEST_TIMEOUT_MS, describeSearchPhantoms, harvestRepos, parseHarvestBudget } from './github-client.ts'
import { applyArchivedFlags, applyForkFlags, layerArchivedFlags, layerForkFlags, parseRepoState, repoGoneDetail, serializeRepoState } from './repo-state.ts'
import { githubOwnerName } from './github-repo.ts'
import { ICON_FETCH_BUDGET_DEFAULT, ICON_FETCH_CONCURRENCY, ICON_FETCH_TIME_BUDGET_MS_DEFAULT, PUBLISHED_REQUEST_TIMEOUT_MS, harvestIcons, readPublishedIcons } from './icon-fetch.ts'
import { foldIconResults, iconSubjects, planIconWork, renderIconSection } from './icon-plan.ts'
import { parseIconState, serializeIconState, type IconKey, type IconOutcome } from './icon-state.ts'
import { serializeIcons } from './icons-assemble.ts'
import { accountForDepartures, fetchCandidates, searchByKeywords, describePublisherAxis, describeShortfall, HARVEST_KEYWORDS, parseKeywordShortfall, parsePublisherAxisReport, PUBLISHER_PROBE_BUDGET_DEFAULT, type KeywordShortfall, type PublisherAxisReport } from './npm-client.ts'
import { confirmCarriers, harvestFeed } from './npm-feed.ts'
import { applyAxisReport, MAX_EVICTIONS_PER_RUN, MAX_PINNED_PER_KEYWORD, mergePublishers, parsePublisherState, retainPinned, serializePublisherState, type PublisherState } from './publisher-state.ts'
import { pagesArtifactNames, pagesPointerOf } from './pages-artifacts.ts'
import { assertIconsInFile, budgetBeforeDeadline, describeLostIconsFile, describeRereadStopped, parseBudgetVariable, parseDeadlineVariable, repoPeersEmitted, runPipeline, selectEntries, withholdRepoPeers } from './pipeline.ts'
import { CATALOG_SCHEMA_VERSION, SCHEMA_VERSION, SUBPACKAGE_SCHEMA_VERSION } from './emit.ts'
import { assembleStarsForEntries, serializeStars } from './stars-assemble.ts'
import type { Candidate, Rejection, RepoCandidate } from './types.ts'

/**
 * The maintainer usernames a handoff's `publishers` names, held to the rule
 * the committed file is read by. Reusing `parsePublisherState` rather than a
 * second validator is the point: the handoff is where a username enters this
 * process, and the rule that rejects one has to be the rule that would reject
 * it on read, or a build can persist a vocabulary the next build refuses to
 * parse.
 */
function parsePublishersField(raw: unknown, where: string): string[] {
  try {
    return [...parsePublisherState(JSON.stringify({ publishers: raw })).publishers]
  } catch (error) {
    // The rule is the committed file's, and the FILE is not where this value
    // came from: a handoff's bad username used to be reported against a valid,
    // untouched publisher-state.json (PR #118 review).
    // The inner message opens with the file it validated (`<name>.json: …`);
    // the value came from the handoff, so that prefix is dropped rather than
    // left to read as a complaint about a file nobody touched. The pattern is
    // the FILE-NAME SHAPE, not the literal name: a reworded reader message
    // stays attributed correctly (PR #118 review).
    const message = (error instanceof Error ? error.message : String(error)).replace(/^[^:\n]+\.json: /, '')
    throw new Error(`${where}: ${message}`)
  }
}

/**
 * Whether `--name` was given, in either spelling: `--name value` or
 * `--name=value`. Both are what an operator types, and a guard that tested
 * only the first left `--axis-from=x` falling through BOTH entry guards and
 * running the full live build (PR #118 review).
 */
function argumentGiven(argv: readonly string[], name: string): boolean {
  return argv.includes(name) || argv.some(arg => arg.startsWith(`${name}=`))
}

/** The value of `--name` from either spelling, or undefined when absent or valueless. */
function argumentValue(argv: readonly string[], name: string): string | undefined {
  const prefixed = `${name}=`
  const joined = argv.find(arg => arg.startsWith(prefixed))
  if (joined !== undefined) {
    // `--flag=` names no file; reading it as an empty path died as an ENOENT
    // against `''` with no flag in the message (PR #118 review).
    const value = joined.slice(prefixed.length)
    return value === '' ? undefined : value
  }
  const index = argv.indexOf(name)
  if (index === -1) return undefined
  const next = argv[index + 1]
  // `--flag --other` must not take the next flag as its value, and `--flag ''`
  // names no file either.
  return next === undefined || next === '' || next.startsWith('--') ? undefined : next
}

/**
 * The JSON in `path`, with the failure attributed to `where`: a read problem
 * and a parse problem say different things, and neither is reported as the
 * other (PR #118 review). Shared by both handoff readers, whose try/catch
 * blocks were line-for-line copies.
 */
function readJsonFile(path: string, where: string): unknown {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    throw new Error(`${where}: ${error instanceof Error ? error.message : String(error)}`)
  }
  try {
    return JSON.parse(text) as unknown
  } catch (error) {
    throw new Error(`${where}: not JSON (${error instanceof Error ? error.message : String(error)})`)
  }
}

/**
 * Every record names a harvested keyword, and no keyword twice. Run where the
 * handoff is PARSED rather than where it is spent: the spend happens after the
 * pipeline, so a stale handoff's refusal used to leave the catalog artifacts,
 * `manifest.lock` and `first-seen.yml` written before the throw (PR #118
 * review).
 */
function assertAxisKeywords(axis: readonly PublisherAxisReport[], where: string): void {
  const seen = new Set<string>()
  for (const report of axis) {
    if (!HARVEST_KEYWORDS.includes(report.keyword)) {
      throw new Error(`${where}: publisher axis record names keyword \`${report.keyword}\`, which this build does not harvest`)
    }
    if (seen.has(report.keyword)) {
      throw new Error(`${where}: publisher axis names keyword \`${report.keyword}\` more than once`)
    }
    seen.add(report.keyword)
  }
}

/**
 * `--axis-from` applies a RED RUN's axis, and a red run reports every keyword:
 * a handoff holding one of two is applied alone, and the other keyword
 * re-probes the same band — the failure the mechanism exists to end (PR #118
 * review). Enforced before anything is written.
 */
function assertCompleteAxis(axis: readonly PublisherAxisReport[], where: string): void {
  assertAxisKeywords(axis, where)
  const missing = HARVEST_KEYWORDS.filter((keyword) => !axis.some((report) => report.keyword === keyword))
  if (missing.length > 0) {
    throw new Error(`${where}: publisher axis has no record for ${missing.map((keyword) => `\`${keyword}\``).join(', ')}, and every harvest keyword needs one`)
  }
}

/**
 * A handoff's `publisherAxis`, every record through the strict parser. A
 * malformed record read as "no axis this run" would pin or evict nothing
 * while looking exactly like a run that had nothing to do.
 */
function parsePublisherAxisField(raw: unknown, where: string): PublisherAxisReport[] {
  if (!Array.isArray(raw)) {
    throw new Error(`${where}: expected an array of publisher axis records for \`publisherAxis\``)
  }
  return raw.map(record => parsePublisherAxisReport(record, where))
}

/**
 * The committed publisher state after one run's axis records, and the report
 * lines that say what they did. The one transition both modes below write:
 * the full build after its artifacts, and `--axis-from` for a run that failed
 * its coverage check, so a red run commits exactly what a passing run would
 * have from the same records (design
 * `docs/design/2026-10-22-publisher-axis-on-a-red-run.md`, section 3.3).
 * Pure; the callers read and write the file.
 *
 * Pruned to the keywords this build actually harvests. Both keyed maps copy
 * every existing key forward, so a key written once by a since-renamed
 * HARVEST_KEYWORDS entry, or by a handoff naming a keyword this build does
 * not harvest, would otherwise round-trip into the committed file forever
 * with nothing able to probe, evict or report it.
 *
 * One `applyAxisReport` per report, and every decision inside it — eviction
 * before seeding, how complete `seeded` is, how far this keyword's own cursor
 * moves. All of that is policy, so it lives in the pure module where a
 * fixture can drive it; what is left here is the loop and the reporting.
 */
function spendPublisherAxis(
  prior: PublisherState,
  saw: readonly string[],
  axis: readonly PublisherAxisReport[],
  where: string,
): { state: PublisherState; parts: string[] } {
  let state = retainPinned(mergePublishers(prior, saw), HARVEST_KEYWORDS)
  const parts: string[] = []
  const seenKeywords = new Set<string>()
  for (const report of axis) {
    // Pruning above keeps an unharvested key out of the MERGED state, and
    // would not keep one out of a key the REPORT names: `applyAxisReport`
    // writes `pinned[k]` and `cursors[k]` straight through. One hand-edited
    // handoff was enough to add a keyword the file's own bound refuses, and
    // every later parse throws (PR #118 review).
    if (!HARVEST_KEYWORDS.includes(report.keyword)) {
      throw new Error(`${where}: publisher axis record names keyword \`${report.keyword}\`, which this build does not harvest`)
    }
    // One record per keyword. Two for one and none for another pass a count
    // check, and the duplicated keyword's cursor advances twice while the
    // other stays stale (PR #118 review).
    if (seenKeywords.has(report.keyword)) {
      throw new Error(`${where}: publisher axis names keyword \`${report.keyword}\` more than once`)
    }
    seenKeywords.add(report.keyword)
    const applied = applyAxisReport(state, report)
    state = applied.state
    const notes: string[] = []
    // Reported from the call that actually refused, with a count. Derived
    // from the PRIOR pinned set instead, this said nothing at all on the one
    // run where refusal began -- the set is still under the bound when the
    // run starts -- and never said how many owners it cost.
    if (applied.refused.length > 0) {
      notes.push(`refused ${applied.refused.length} new residue owner(s): the pinned set is FULL at ${MAX_PINNED_PER_KEYWORD}`)
    }
    // Named with its count because the exit is unbounded by design: the first
    // run to pass releases most of a full set (design
    // 2026-10-20-cross-keyword-credit-and-feed-aware-pins, section 4.2), and a
    // set that shrinks by hundreds in silence reads as a fault. And with its
    // exit, which rests on different evidence inside the window and past it.
    if (applied.released.length > 0) {
      // A switch rather than a ternary: a third exit added to the union would
      // have been published as "judged" with no compile error, and the `never`
      // arm is what makes that a compile error (PR-1 review).
      switch (applied.releaseExit) {
        case 'complete-seeding':
          notes.push(`released ${applied.released.length} pin(s) seeding no longer names, the keyword counted whole inside its window`)
          break
        case 'judged':
          notes.push(`released ${applied.released.length} judged pin(s) seeding no longer names`)
          break
        case null:
          // Unreachable by construction: `released.length > 0` gives an exit.
          throw new Error('publisher axis: a report that released pins named no release exit')
        default: {
          const unreached: never = applied.releaseExit
          throw new Error(`publisher axis: unknown release exit ${String(unreached)}`)
        }
      }
    }
    // Loud, because the alternative reading of a large eviction list is a
    // registry fault and the run just declined to act on it. Left silent this
    // would look like a healthy run that evicted nothing.
    if (applied.evictionsRefused > 0) {
      notes.push(`REMOVED NO PINS: ${applied.evictionsRefused} pinned cells answered zero, more than the ${MAX_EVICTIONS_PER_RUN} one run may remove, which describes the registry rather than the ecosystem`)
    }
    parts.push([describePublisherAxis(report), ...notes].join(', '))
  }
  // An axis that reported nothing is reported AS nothing, rather than by an
  // absent heading. On the `--harvest-from` path a handoff carrying no
  // `publisherAxis` -- one written before the field existed -- pins nothing,
  // evicts nothing and advances no cursor, so every subsequent run re-probes
  // the same band while the vocabulary grows. That is the failure this
  // module's cursor exists to prevent, and it looked exactly like a healthy
  // run with nothing to do.
  if (axis.length === 0) {
    parts.push('no publisher axis record this run: nothing was pinned, evicted or rotated, and every keyword cursor stayed where it was')
  }
  return { state, parts }
}

// A red run's publisher axis, applied alone (design
// `docs/design/2026-10-22-publisher-axis-on-a-red-run.md`, section 3.3).
// Classify failed a coverage check after every keyword had reported its
// axis, and handed the records over in dist/publisher-axis.json. This writes
// registry/publisher-state.json exactly as the full build below would from
// the same records, and nothing else: no search, no fetch, no pipeline, no
// other file. A sibling of the full build's guard rather than a branch inside
// it, so that body keeps its shape; both guards are positive and exact, for
// the reasons the comment above the full build's gives.
if (basename(process.argv[1] ?? '') === 'build.ts' && argumentGiven(process.argv, '--axis-from')) {
  const axisFrom = argumentValue(process.argv, '--axis-from')
  if (axisFrom === undefined) {
    throw new Error('--axis-from requires a path')
  }
  if (argumentGiven(process.argv, '--harvest-from')) {
    throw new Error('--axis-from applies a red run\'s publisher axis alone and cannot be combined with --harvest-from')
  }
  const where = `--axis-from ${axisFrom}`
  const handoff = readJsonFile(axisFrom, where) as { publishers?: unknown; publisherAxis?: unknown } | null
  // Both fields required, where --harvest-from takes either as optional: an
  // older classifier wrote neither into its harvest, but every axis handoff
  // is written with both, and without them there is nothing to apply.
  if (handoff === null || typeof handoff !== 'object' || handoff.publishers === undefined || handoff.publisherAxis === undefined) {
    throw new Error(`${where}: expected { publishers, publisherAxis }, which every red run's handoff carries`)
  }
  const saw = parsePublishersField(handoff.publishers, where)
  const axis = parsePublisherAxisField(handoff.publisherAxis, where)
  assertCompleteAxis(axis, where)
  const REGISTRY_DIR = 'registry'
  const publisherStatePath = join(REGISTRY_DIR, 'publisher-state.json')
  const prior = existsSync(publisherStatePath)
    ? parsePublisherState(readFileSync(publisherStatePath, 'utf8'))
    : { publishers: [] }
  const spent = spendPublisherAxis(prior, [...saw], axis, where)
  // Written FIRST: a failed write used to leave a log claiming a transition
  // the file never took (PR #118 review).
  writeFileSync(publisherStatePath, serializePublisherState(spent.state))
  for (const part of spent.parts) process.stderr.write(`npm: ${part}\n`)
  process.stderr.write(`npm: publisher vocabulary ${prior.publishers.length} -> ${spent.state.publishers.length}\n`)
}

// Real work — network fetches, and filesystem writes that overwrite
// registry/snapshots/manifest.lock and registry/first-seen.yml — belongs to
// the entry point alone, never to an import, so all of it runs inside the
// guard below and none of it outside.
// The guard is POSITIVE and the comparison EXACT, both deliberately.
// Positive: the form this replaced ended in `process.exit(0)` at module
// scope, which terminates whatever process IMPORTS this module — under
// vitest, a worker that vanishes mid-suite and reports success. emit-schema.ts
// drew the positive line first, and schema.test.ts already relies on it to
// import renderJsonSchema without the write side effect.
// Exact: `endsWith('build.ts')` also admits `prebuild.ts` and `rebuild.ts`.
// `node -e` leaves process.argv[1] undefined, so basename('') matches no name
// and a bare import runs nothing.
// registry/scripts/tests/strip-types.test.ts derives the entry-point list and
// holds every member of it to both halves of this.
if (basename(process.argv[1] ?? '') === 'build.ts' && !argumentGiven(process.argv, '--axis-from')) {
  // The clock, read exactly once, here at the start, and never again: every
  // time the build needs is this reading plus what the monotonic clock has
  // counted since, which no step of the system clock can move. `builtAt` is
  // taken from the two after the harvest, where it always was, so the published
  // moment does not move; the job's deadline is measured against them before
  // the harvest as well, where the declarations re-read needs it.
  const clockMs = Date.now()
  const clockAt = performance.now()
  /** Milliseconds since the epoch, now, from the one reading of the clock. */
  const nowMs = (): number => clockMs + (performance.now() - clockAt)

  // `classify.ts` writes the harvest it already paid for; the workflow passes it
  // here so the daily run does not fetch the ecosystem twice.
  // Both spellings, through the same helpers the axis guard uses: read only
  // for `--harvest-from x`, the `=` form left this undefined and ran a LIVE
  // harvest where the operator asked to replay a handoff (PR #118 review).
  const harvestFrom = argumentValue(process.argv, '--harvest-from')
  if (argumentGiven(process.argv, '--harvest-from') && harvestFrom === undefined) {
    throw new Error('--harvest-from requires a path')
  }

  const REGISTRY_DIR = 'registry'
  const OUT_DIR = 'dist/v1'

  // Optional read-only npm token. npm rate-limits the search API by IP, and a
  // CI runner shares its egress IP with every other tenant, so unauthenticated
  // searches can be throttled before the first request. When NPM_TOKEN is set,
  // requests carry it as a Bearer header and the quota lands on the token.
  const npmToken = process.env.NPM_TOKEN

  // The backup registry the fetch layer fails over to on unavailability only
  // (network throw, stalled connection, 5xx — never a 404). Read-only: the
  // install path still runs through the user's own pnpm and registry config, and
  // NPM_TOKEN never travels here — it is an npmjs.org credential and this URL is
  // operator-supplied. Default-on per the 2026-08-31 hub-borrowings design (C);
  // an empty string (or an all-whitespace value) disables it, which
  // fetchWithFailover honors (D-6, Task 3). A non-empty value that is not a URL
  // is a typo, not a disable, so it is rejected below rather than silently
  // reaching fetchWithFailover as "no backup".
  const rawBackupRegistry = process.env.NPM_BACKUP_REGISTRY
  if (rawBackupRegistry !== undefined && rawBackupRegistry.trim() !== '' && !URL.canParse(rawBackupRegistry)) {
    throw new Error('NPM_BACKUP_REGISTRY is not a URL; use an empty string to disable')
  }
  const npmBackupRegistry = rawBackupRegistry ?? 'https://registry.npmmirror.com'

  // The same token the stars sidecar uses; also the GitHub API's quota key.
  const ghToken = process.env.GITHUB_TOKEN ?? ''

  const config = loadRegistryConfig(REGISTRY_DIR)

  // The icon step's two inputs that a typo or a hand edit can break, read here
  // with the rest of the environment and the committed state and spent after
  // the stars step. The harvest in between takes the better part of two hours,
  // and a mistyped budget or a malformed record has to stop the build in its
  // first second, not at the step that needs it.
  // The record is what became of every icon key (design
  // 2026-10-23-shop-plugin-icons §5.1). Only a file that is not there is a first
  // run, an empty record; any other failure to read it, or any malformation in
  // it, throws. Read as empty it would send every icon in the catalog to be
  // fetched again, the refused ones included, and a refusal is meant to be asked
  // once.
  const iconStatePath = join(REGISTRY_DIR, 'icon-state.json')
  let iconStateText: string | null = null
  try {
    iconStateText = readFileSync(iconStatePath, 'utf8')
  } catch (error) {
    // Swallows ENOENT alone: the first run, before any build has written the
    // record. Whatever else readFileSync throws (a permission, a directory in
    // its place) is rethrown, because it is not "no record".
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const iconState: Map<IconKey, IconOutcome> = iconStateText === null ? new Map() : parseIconState(iconStateText)
  // The budgets are defaults unless the variable is set, and a variable that is
  // set is held to what `parseBudgetVariable` accepts: a NaN deadline would be
  // no deadline, and a count that reads as zero would fetch nothing, each
  // reported as a healthy run.
  const iconFetchBudget = parseBudgetVariable('ICON_FETCH_BUDGET', process.env.ICON_FETCH_BUDGET, ICON_FETCH_BUDGET_DEFAULT)
  const iconFetchTimeBudgetMs = parseBudgetVariable('ICON_FETCH_TIME_BUDGET_MS', process.env.ICON_FETCH_TIME_BUDGET_MS, ICON_FETCH_TIME_BUDGET_MS_DEFAULT)
  // The catalog job's own deadline: the moment this build must be done by for
  // the steps after it to fit inside the job's `timeout-minutes`. The daily
  // workflow's first step writes it and keeps that arithmetic; a local run has
  // none, and nothing is cut short. A job killed at its limit publishes nothing
  // and commits no state, which is what the cuts below exist to prevent.
  const jobDeadlineMs = parseDeadlineVariable('CATALOG_JOB_DEADLINE_MS', process.env.CATALOG_JOB_DEADLINE_MS, nowMs())
  // Two steps read the deadline, the declarations re-read and the icon step,
  // and each stops STARTING work early enough that everything still to come is
  // done by it: its own last request, which it lets finish, and every later
  // step of this build, none of which reads the deadline. Measured from this
  // build's own stderr lines on the last three catalog runs before the icon
  // step existed (2026-10-21 to 2026-10-23):
  //
  //   after the GitHub half             took          counted here as
  //   the flags pass, archived and fork 3m44s-4m30s   6 minutes: it has no budget
  //   the repo-state write, stars pass  1m08s-1m13s   the stars pass's own bound
  //   the pipeline, emit and writes     1.1s-1.2s     1 minute
  //
  // The stars pass's bound is STARS_BUDGET_MS and one STARS_REQUEST_TIMEOUT_MS.
  // The icon step adds its two reads of the published icons file, each bounded
  // by PUBLISHED_REQUEST_TIMEOUT_MS. The re-read and the icon fetches each let
  // at most one request per worker run past their cut, by at most
  // TARBALL_REQUEST_TIMEOUT_MS, since every one takes its first answer
  // (DECLARATIONS_REREAD_TIME_BUDGET_MS_DEFAULT and
  // ICON_FETCH_TIME_BUDGET_MS_DEFAULT say why). So the icon fetches stop
  // starting 6 minutes before the deadline (their last request and the emit),
  // and the re-read 26.5 minutes before it (its last read, the flags and stars
  // passes, the two reads, and the emit, the icon step then starting nothing).
  // On the measured runs neither cut would bind, by the arithmetic in
  // DECLARATIONS_REREAD_TIME_BUDGET_MS_DEFAULT's comment; they bind when the
  // harvest has run long.
  const EMIT_ALLOWANCE_MS = 60_000
  const FLAGS_PASS_ALLOWANCE_MS = 6 * 60_000
  const iconStepReserveMs = TARBALL_REQUEST_TIMEOUT_MS + EMIT_ALLOWANCE_MS
  const rereadReserveMs = TARBALL_REQUEST_TIMEOUT_MS + FLAGS_PASS_ALLOWANCE_MS + STARS_BUDGET_MS + STARS_REQUEST_TIMEOUT_MS
    + 2 * PUBLISHED_REQUEST_TIMEOUT_MS + EMIT_ALLOWANCE_MS

  let candidates: Candidate[]
  let rejections: Rejection[]
  /** Tolerated npm search shortfalls, one entry per keyword, for the
   * published report. An array rather than a string built with an inline
   * separator sentinel: each entry now spans two clauses of its own, so a
   * hand-rolled `'; '` between them read as a delimiter at two nesting
   * levels once both harvest keywords were past the window. */
  const npmParts: string[] = []
  /** The departure step's counts (design 2026-09-26-market-borrowings §8.2),
   * from this build's own harvest or the classifier's handoff. Undefined only
   * for a handoff written before the field existed. */
  let departureSummary: DepartureSummary | undefined
  /** What the publisher axis did per keyword, reported under its own heading
   * rather than folded into `npmParts` above: vocabulary size, probe counts,
   * seeding and eviction are routine bookkeeping that can fill this array on
   * a build that is missing nothing, and filing that under "packages
   * missing from this build" would misdiagnose a healthy run for the plugin
   * authors who read the published report. */
  const axisParts: string[] = []
  /**
   * The publisher axis's committed vocabulary, read BEFORE the branch so both
   * halves share one seed and one observation set. The file is absent on a
   * first run and that is a first run, not an error — the axis is inert with
   * an empty vocabulary, which is what makes it safe to land.
   */
  const publisherStatePath = join(REGISTRY_DIR, 'publisher-state.json')
  const priorPublishers = existsSync(publisherStatePath)
    ? parsePublisherState(readFileSync(publisherStatePath, 'utf8'))
    : { publishers: [] }
  const sawPublishers = new Set<string>()
  // The change feed's committed state (spec 2026-10-04, section 4.8). This
  // module is its only writer, after the pipeline, beside
  // publisher-state.json.
  const feedStatePath = join(REGISTRY_DIR, 'feed-state.json')
  const priorFeed = existsSync(feedStatePath)
    ? parseFeedState(readFileSync(feedStatePath, 'utf8'), HARVEST_KEYWORDS)
    : bootstrapFeedState()
  let nextFeed: FeedState | undefined
  const feedParts: string[] = []
  // What the publisher axis did per keyword, from whichever source this run
  // has: the live search below, or the handoff's `publisherAxis` in the
  // `--harvest-from` branch. Spent once, after the branch, so both paths pin
  // and evict through the same pinFor/unpinFor/cursor logic.
  const axis: PublisherAxisReport[] = []
  if (harvestFrom === undefined) {
    // registry.npmmirror.com does not implement the `keywords:` qualifier this
    // search depends on — measured 2026-09-03, it answers
    // `{"objects":[],"total":0}` for both harvest keywords. A numeric zero
    // total slips past the coverage guards from Task 1 (D-1,
    // docs/plans/2026-09-03-audit-fix-a-urgent.md) — min(0, 0) = 0 passes — so
    // a stalled or 5xx npmjs search would publish a zero-name harvest with a
    // green build rather than failing loud. The search below therefore takes
    // no backup argument; classify.ts's harvest call carries the same fix.
    // A tolerated shortfall does not stop the harvest, but it does mean this
    // build is missing that many packages, and nothing here can name them.
    // Collected so the published report says so — the count is the only
    // honest thing available. One count/paging noise allowance covers the
    // whole keyword. Larger gaps require healthy recovery beyond one window
    // and must fit MAX_UNREACHABLE_RESIDUAL. The record carries both terms
    // for the report without claiming the missing names' cause is known.
    const feedRun = await harvestFeed(priorFeed, { harvestKeywords: HARVEST_KEYWORDS, token: npmToken })
    nextFeed = feedRun.next
    feedParts.push(describeFeedRun(feedRun.report))
    const feedConfirmations: FeedRead[] = []
    const feedInput: FeedInput = {
      carriers: feedRun.report.available ? feedCarriersByKeyword(feedRun.next, HARVEST_KEYWORDS) : new Map(),
      seed: feedRun.next.seq,
      onCoverage: coverage => { feedParts.push(describeFeedCoverage(coverage)) },
      // A name two complete pagings of its owner's cell omitted is re-read
      // from its current packument before it can disagree (spec 4.5).
      confirm: async names => {
        const reads = await confirmCarriers(names, { harvestKeywords: HARVEST_KEYWORDS, token: npmToken })
        for (const read of reads.values()) feedConfirmations.push(read)
        return reads
      },
    }
    const shortfalls: KeywordShortfall[] = []
    let names: string[]
    try {
      names = await searchByKeywords(
        fetch, undefined, npmToken, undefined, undefined,
        s => shortfalls.push(s),
        users => { for (const u of users) sawPublishers.add(u) },
        priorPublishers,
        PUBLISHER_PROBE_BUDGET_DEFAULT,
        report => axis.push(report),
        feedInput,
      )
    } catch (error) {
      // A coverage failure is thrown once every keyword has finished, so the
      // reports it HELD never reached the prints below: the later keyword's
      // shortfall and every axis line were measured and then dropped, on the
      // one path a maintainer uses to reproduce a red run locally (PR #118
      // review). Printed here without applying them — applying is what the
      // red run's own `--axis-from` step is for.
      // Stderr only: `npmParts` feeds the report this path never writes, and
      // the success path below prints the same lines once, after the throw is
      // impossible (PR #118 review).
      for (const s of shortfalls) process.stderr.write(`npm: ${describeShortfall(s)}\n`)
      for (const report of axis) process.stderr.write(`npm: ${describePublisherAxis(report)}\n`)
      // The feed lines are measured before the search returns too, and a green
      // run prints them: a red local run dropped the third array (PR #118
      // review).
      for (const part of feedParts) process.stderr.write(`npm: ${part}\n`)
      throw error
    }
    nextFeed = applyConfirmations(feedRun.next, feedConfirmations)
    for (const s of shortfalls) {
      npmParts.push(describeShortfall(s))
      process.stderr.write(`npm: ${describeShortfall(s)}\n`)
    }
    process.stderr.write(`harvested ${names.length} npm candidate(s)\n`)
    const harvested = await fetchCandidates(names, fetch, npmToken, npmBackupRegistry)
    const lockPath = join(REGISTRY_DIR, 'snapshots/manifest.lock')
    const departureRun = await accountForDepartures(
      existsSync(lockPath) ? readFileSync(lockPath, 'utf8') : null,
      harvested,
      { token: npmToken, backupRegistry: npmBackupRegistry },
    )
    candidates = departureRun.candidates
    rejections = departureRun.rejections
    departureSummary = departureRun.summary
  } else {
    const harvestWhere = `--harvest-from ${harvestFrom}`
    const parsedJson = readJsonFile(harvestFrom, harvestWhere)
    // `null` is valid JSON and not a handoff: reading `.candidates` off it
    // threw a bare TypeError with no file in the message (PR #118 review,
    // pre-existing on this path).
    if (parsedJson === null || typeof parsedJson !== 'object' || Array.isArray(parsedJson)) {
      throw new Error(`${harvestWhere}: expected a JSON object with { candidates, rejections } arrays, got ${parsedJson === null ? 'null' : Array.isArray(parsedJson) ? 'an array' : typeof parsedJson}`)
    }
    const parsed = parsedJson as {
      candidates?: unknown; rejections?: unknown; shortfalls?: unknown; publishers?: unknown
      publisherAxis?: unknown; feed?: unknown; departures?: unknown
    }
    if (!Array.isArray(parsed.candidates) || !Array.isArray(parsed.rejections)) {
      throw new Error(`--harvest-from ${harvestFrom}: expected { candidates, rejections } arrays`)
    }
    candidates = parsed.candidates as Candidate[]
    rejections = parsed.rejections as Rejection[]
    // Optional as a whole, like `shortfalls`: a handoff from before the field
    // existed must still build. A record present is validated, because its
    // counts reach the published report.
    if (parsed.departures !== undefined) {
      departureSummary = parseDepartureSummary(parsed.departures, `--harvest-from ${harvestFrom}`)
    }
    // Optional as a WHOLE — a handoff that recorded no shortfall carries no
    // array — but each record present is validated, because its fields are
    // interpolated into a published report. The cast this replaced rendered
    // `undefined` into dist/v1/report.md from any handoff missing a field,
    // under a comment claiming such a handoff was ignored. Nothing ignored it.
    for (const raw of Array.isArray(parsed.shortfalls) ? parsed.shortfalls : []) {
      npmParts.push(describeShortfall(parseKeywordShortfall(raw, `--harvest-from ${harvestFrom}`)))
    }
    // Optional as a whole for the same reason `shortfalls` is — an older
    // classifier wrote no such field and its handoff must still build — but a
    // field that IS present goes through the same parser the committed file
    // does (`parsePublishersField`).
    if (parsed.publishers !== undefined) {
      for (const username of parsePublishersField(parsed.publishers, `--harvest-from ${harvestFrom}`)) sawPublishers.add(username)
    }
    // STRICT where `shortfalls`/`publishers` above are lenient, and
    // deliberately so: those two only widen a report or a vocabulary, but this
    // one is what pinFor/unpinFor spend against the committed file below, so a
    // malformed record read as "no axis this run" would silently pin or evict
    // nothing while looking exactly like a run that had nothing to do —
    // `publisher-state.json`'s `pinned` map would stay empty on every real run
    // while every test that drives this branch with a well-formed fixture
    // stayed green. Optional as a WHOLE, like its siblings: a handoff written
    // before this field existed must still build.
    if (parsed.publisherAxis !== undefined) {
      const fromHandoff = parsePublisherAxisField(parsed.publisherAxis, harvestWhere)
      // COMPLETE, like `--axis-from`: a handoff holding one keyword applied
      // that cursor alone and re-probed the other band. Validated here, before
      // the pipeline, so a stale handoff leaves no artifacts behind.
      assertCompleteAxis(fromHandoff, harvestWhere)
      axis.push(...fromHandoff)
    }
    if (parsed.feed === undefined) {
      feedParts.push('no change-feed record in this handoff: registry/feed-state.json was left as it was')
    } else {
      const feed = parsed.feed as { state?: unknown; report?: unknown; coverage?: unknown } | null
      if (feed === null || typeof feed !== 'object' || typeof feed.state !== 'string' || !Array.isArray(feed.coverage)) {
        throw new Error(`--harvest-from ${harvestFrom}: expected \`feed\` to carry a serialized \`state\`, a \`report\` and a \`coverage\` array`)
      }
      const state = parseFeedState(feed.state, HARVEST_KEYWORDS)
      // Review Focus 4: an older handoff would move the cursor backwards,
      // and a carrier learned since would be un-learned until it changed.
      if (state.seq < priorFeed.seq) {
        throw new Error(`--harvest-from ${harvestFrom}: its change-feed state is at seq ${state.seq}, behind the committed ${priorFeed.seq}; writing it would move the cursor backwards`)
      }
      nextFeed = state
      feedParts.push(describeFeedRun(parseFeedRunReport(feed.report, `--harvest-from ${harvestFrom}`, HARVEST_KEYWORDS)))
      for (const raw of feed.coverage as unknown[]) {
        feedParts.push(describeFeedCoverage(parseFeedCoverage(raw, `--harvest-from ${harvestFrom}`, HARVEST_KEYWORDS)))
      }
    }
    process.stderr.write(`reusing harvest: ${candidates.length} npm candidate(s)\n`)
  }

  // The GitHub half of the harvest runs in both modes: `--harvest-from` reuses
  // only the npm fetch. It needs BOTH the token and the SHOP_HARVEST_REPOS=1
  // flag: the flag is flipped in the release commit that ships the v3-reading
  // client, so no live catalog ever serves repo entries (schemaVersion 3) to a
  // client that cannot parse them. A skip is LOUD — the report names the
  // missing piece, and the npm half still publishes.
  let repoCandidates: RepoCandidate[] = []
  let repoNote = ''
  // Hoisted from the harvest branch so the archived-flags merge can write
  // repo-state.json with the freshest flags after selectEntries (§1.3).
  let repoNextState: import('./repo-state.ts').RepoState | null = null
  // The GraphQL fork-flag half's one report line, hoisted so the report
  // composition below can quote the counters the flag pass measured — the
  // line lives on report.md, not on stderr (design 2026-10-11-fork-flag §1.1).
  let forkedNote = ''
  // Star counts the search itself carried, keyed by repo full name. Empty
  // when the github harvest skipped — every repo then goes through GraphQL.
  let repoSearchStars = new Map<string, number>()
  // Subpackage probing rides the schemaVersion-4 flag (set inside the harvest
  // branch); the emit at the bottom reads it for the version decision.
  let probeSubpackages = false
  // The path the repo-state file writes to, hoisted so the archived-flags
  // merge below can write it after selectEntries has run (design §1.3).
  const repoStatePath = join(REGISTRY_DIR, 'repo-state.json')
  const repoFlag = process.env.SHOP_HARVEST_REPOS === '1'
  if (ghToken === '') {
    repoNote = 'github harvest skipped: GITHUB_TOKEN is not set'
    process.stderr.write(`github: ${repoNote}\n`)
  } else if (!repoFlag) {
    repoNote = 'github harvest skipped: SHOP_HARVEST_REPOS is not 1 (flipped in the release that ships the v3 client)'
    process.stderr.write(`github: ${repoNote}\n`)
  } else {
    // The harvest memory: what the last run saw and fetched. Committed like
    // the other registry inputs; a missing file is the first run of the
    // backfill, an unreadable one fails loudly rather than scheduling a fresh
    // full sweep by accident.
    const repoState = existsSync(repoStatePath)
      ? parseRepoState(readFileSync(repoStatePath, 'utf8'))
      : {}
    const budget = parseHarvestBudget(process.env.REPO_BACKFILL_BUDGET, REPO_BACKFILL_BUDGET_DEFAULT)
    // Subpackage probing rides the schemaVersion-4 flag: probing off, the
    // harvest behaves exactly as before and emits v3; the flag flips in the
    // release commit that ships the v4-reading client.
    probeSubpackages = process.env.SHOP_HARVEST_SUBPACKAGES === '1'
    // One whole-harvest retry after a pause: the GitHub half runs through
    // shared egress whose throttles outlast the per-request backoffs. A second
    // failure kills the build loudly — a half-harvested catalog is worse than a
    // red one, and the daily workflow retries next run. The retry is inside
    // harvestRepos so that this one options object is the only one there is;
    // the version of this that rebuilt it by hand dropped `probeSubpackages`
    // and emitted v4 entries under schemaVersion 3.
    const repos = await harvestRepos({
      state: repoState, budget, fetchImpl: fetch, token: ghToken, probeSubpackages,
      retryAfterMs: 30_000,
      // Asked when the re-read starts, which is after every full fetch: the
      // time left to its cut, rereadReserveMs before the job's deadline.
      ...(jobDeadlineMs === null ? {} : { timeLeftMs: () => jobDeadlineMs - rereadReserveMs - nowMs() }),
    })
    if (repos.firstAttemptError !== null) {
      process.stderr.write(`github: first attempt failed (${repos.firstAttemptError}); retried once after 30s\n`)
    }
    repoCandidates = repos.candidates
    repoSearchStars = repos.searchStars
    for (const failure of repos.failures) {
      rejections.push({ name: failure.repo, code: failure.code, detail: failure.detail })
    }
    for (const repo of repos.gone) {
      rejections.push({
        name: repo,
        code: 'repo-gone',
        detail: repoGoneDetail(HARVEST_TOPICS),
      })
    }
    // The state write is deferred to after selectEntries and the archived-flags
    // merge below: the graph pass needs to know which repos are LISTED before
    // it asks GitHub about them, and the file should carry the freshest flags
    // in one write (design §1.3).
    repoNextState = repos.nextState
    // `fetched` is the queue length — attempts, not successes — so the throw
    // count rides beside it. A run where every attempt threw once read
    // "300 fetched, 300 carried": the one line a human scans for an outage said
    // everything was fine.
    // Declaration re-reads (design 2026-09-01-harness-compatibility section
    // 9.8): repos.rereadAttempted and .rereadDeferred count REPOSITORIES the
    // phase started or queued past its budget; .rereadUpdated, .rereadFailed
    // and .rereadAssetChanged count CANDIDATES among those started — a
    // re-read that succeeds writes only the declaration fields (`peers`,
    // `compatibility`, `dshPeers`, `manifestVersion` and `icon`) and the stamp,
    // so this line is the only place that number is visible outside the
    // harvest itself.
    // repos.rereadStopped says why the phase stopped starting reads early —
    // its own time budget (DECLARATIONS_REREAD_TIME_BUDGET_MS_DEFAULT) spent,
    // or the failure breaker (DECLARATIONS_REREAD_MAX_CONSECUTIVE_FAILURES)
    // tripping on the host rather than any one record — or null when neither
    // happened. `describeRereadStopped` (pipeline.ts) renders it, appending
    // nothing for null so a healthy run's line does not grow a clause that
    // says nothing.
    repoNote = `${repos.windowCount} windows, ${repos.seen.length} repos seen, ${repos.fetched} fetched (${repos.thrown} threw), ${repos.carried} carried, ${repos.deferred} deferred; declaration re-reads: ${repos.rereadAttempted} repos (${repos.rereadUpdated} updated, ${repos.rereadFailed} failed, ${repos.rereadAssetChanged} asset changed), ${repos.rereadDeferred} deferred${describeRereadStopped(repos.rereadStopped)}`
    // A tolerated index gap is named on the report's GitHub line: the harvest
    // published without repositories the search counted, and says which
    // windows and by how much.
    if (repos.searchPhantoms.length > 0) repoNote = `${repoNote}; ${describeSearchPhantoms(repos.searchPhantoms)}`
    process.stderr.write(`github: ${repoNote}\n`)
  }

  // Github `peers` are harvested and recorded above whatever this says, and
  // emitted only once the flag flips: a shop from 0.8.3 or earlier judges any
  // `peers` by node resolution alone, which badges platform seed words, so the
  // flag flips in the release commit that first promotes the shop that refines
  // against the module table (`withholdRepoPeers`). Applied here, once, so both
  // gate passes below — the stars selection and runPipeline — see the same
  // candidates and cannot disagree about what is listed. `classify.ts` applies
  // the same helper to its own copy of repo-state.json's candidates, and reads
  // the flag through the same `repoPeersEmitted` so the two steps cannot drift
  // (design 2026-09-01-harness-compatibility section 9.8).
  const emitRepoPeers = repoPeersEmitted(process.env.SHOP_EMIT_REPO_PEERS)
  const peersGate = withholdRepoPeers(repoCandidates, emitRepoPeers)
  repoCandidates = peersGate.candidates
  // `withholdRepoPeers` returns `withheld: 0` unconditionally when the flag is
  // on (its own early return), so `withheld > 0` already implies `!emitRepoPeers`
  // — testing both was redundant.
  if (peersGate.withheld > 0) {
    const peersNote = `github peers withheld from ${peersGate.withheld} candidates: SHOP_EMIT_REPO_PEERS is not 1 (flipped in the release that promotes the module-table client to latest)`
    process.stderr.write(`github: ${peersNote}\n`)
    // repoNote is never '' here: every branch above that can reach this point
    // (github-token-missing, flag-off, and the harvest branch) assigns it a
    // non-empty string before falling through (verified by reading all three
    // branches of the if/else-if/else above).
    repoNote = `${repoNote}; ${peersNote}`
  }

  // The stars sidecar and the final artifacts all land under OUT_DIR (the
  // committed manifest under snapshots); create both directories before any
  // write, so a standalone run on a fresh checkout does not fail the first
  // write with ENOENT.
  mkdirSync(OUT_DIR, { recursive: true })
  mkdirSync(join(REGISTRY_DIR, 'snapshots'), { recursive: true })

  // Stars are daily-changing live data: they are quarantined in their own
  // content-addressed sidecar so plugins.json keeps its cache-stable hash
  // (spec 2026-08-26-github-stars-design.md D3). Advisory: any failure — no
  // token, rate limit, down API — publishes without stars and retries next
  // build. The step never throws. Repo entries are keyed by their repo full
  // name, npm entries by package name.
  // Two sources feed the sidecar: the topic search itself (every enumerated
  // item carries `stargazers_count`, so repo entries and any npm repo the
  // search saw cost nothing) and GraphQL for the repos the search did not
  // see. GraphQL therefore covers only the npm pool (~4k points), which a
  // dedicated read-only PAT (STARS_TOKEN, 5k points/hour) absorbs; the
  // Actions GITHUB_TOKEN's ~1k quota would not.
  // The build date, here above the stars step: selectEntries needs it to stamp
  // `added`, and the stars step needs to know which candidates are ENTRIES
  // before it asks GraphQL about any of them. Taken from the clock's one
  // reading at the start and the time counted since, so it is the moment it
  // always was, after the harvest, and the clock is still read only once.
  const builtAt = new Date(nowMs()).toISOString()
  // The catalog this build will publish, decided before the network step.
  // runPipeline re-derives it from the same inputs and cannot disagree
  // (pipeline.test.ts asserts the equality).
  const { entries: selectedEntries } = selectEntries(candidates, repoCandidates, config, builtAt)

  // Archived flags (design 2026-10-08 §1.3): the LISTED github repositories'
  // `isArchived` from GraphQL, written into repo-state.json in one pass.
  // Advisory like the stars pass: every failure mode ends in a note, never a
  // throw, and a failed pass publishes the catalog with the previous flags.
  if (repoNextState !== null) {
    if (ghToken !== '') {
      const listedGitHubRepos: string[] = []
      for (const entry of selectedEntries) {
        if (entry.source === 'github' && entry.repo !== undefined) listedGitHubRepos.push(entry.repo)
      }
      if (listedGitHubRepos.length > 0) {
        const archivedResult = await fetchArchivedFlags(listedGitHubRepos, { token: ghToken })
        if (archivedResult.archived.size > 0) {
          repoNextState = applyArchivedFlags(repoNextState, archivedResult.archived)
        }
        const archivedCount = [...archivedResult.archived.values()].filter(Boolean).length
        const archivedNote = `github archived flags: ${archivedResult.archived.size} answered (${archivedCount} archived)${archivedResult.archivedSkipped.length > 0 ? `, ${archivedResult.archivedSkipped.length} skipped` : ''}`
        process.stderr.write(`${archivedNote}\n`)
        // Fork flags (design 2026-10-11-fork-flag §1.1): the same pass answers
        // `isFork` on the same aliases, but each scalar's skip list is its
        // own — a fork-only failure (or an archived-only drift) lands on the
        // line for the scalar that failed, not on the other's. The report
        // line is composed below beside `archivedLine`, in the report file the
        // design quotes it on (§1.1, §1.3) — not here on stderr.
        if (archivedResult.forked.size > 0) {
          repoNextState = applyForkFlags(repoNextState, archivedResult.forked)
        }
        const forkedCount = [...archivedResult.forked.values()].filter(Boolean).length
        forkedNote = `github fork flags: ${archivedResult.forked.size} answered (${forkedCount} forked)${archivedResult.forkSkipped.length > 0 ? `, ${archivedResult.forkSkipped.length} skipped` : ''}`
      }
    }
    // The deferred write from the harvest branch: now carries the freshest
    // flags, in one write.
    writeFileSync(repoStatePath, serializeRepoState(repoNextState))
  }

  // Layer the archived flag onto the candidates so the emit step can read it.
  // Done here, after the graph merge and before the pipeline: the flag lives
  // on the repo-state record, not on the harvested candidate (§1.3).
  if (repoNextState !== null) {
    layerArchivedFlags(repoNextState, repoCandidates)
    layerForkFlags(repoNextState, repoCandidates)
  }

  const starsToken = process.env.STARS_TOKEN ?? ghToken
  let starsInfo: { url: string; sha256: string } | null = null
  let starsNote = ''
  if (starsToken === '') {
    starsNote = 'no GITHUB_TOKEN'
    process.stderr.write(`stars: ${starsNote}\n`)
  } else {
    // Repos the search already covered: ask GraphQL only for the rest.
    // Listed entries only. Asking about every candidate spent quota points on
    // packages the gate had already rejected and that no reader would ever see
    // a star count for.
    const graphqlRepos = new Map<string, { owner: string; name: string }>()
    for (const entry of selectedEntries) {
      const parsed = githubOwnerName(entry.repository)
      if (parsed === null) continue
      const fullName = `${parsed.owner}/${parsed.name}`
      if (!repoSearchStars.has(fullName)) graphqlRepos.set(fullName, parsed)
    }
    if (graphqlRepos.size === 0 && repoSearchStars.size === 0) {
      starsNote = 'no github.com repositories in the catalog'
    } else {
      let graphqlStars = new Map<string, number>()
      let skipped: string[] = []
      let graphqlNote = ''
      if (graphqlRepos.size > 0) {
        try {
          const fetched = await fetchStarCounts([...graphqlRepos.values()], { token: starsToken })
          graphqlStars = fetched.stars
          skipped = fetched.skipped
        } catch (error) {
          // GraphQL unreachable as a whole: the search-derived counts are
          // already in hand and still publish (partial stars beat none).
          graphqlNote = `graphql failed: ${error instanceof Error ? error.message : String(error)}`
        }
      }
      const assembled = assembleStarsForEntries(selectedEntries, repoSearchStars, graphqlStars)
      if (Object.keys(assembled.stars).length === 0) {
        starsNote = graphqlNote === '' ? 'no star counts' : `no star counts (${graphqlNote})`
        process.stderr.write(`stars: ${starsNote}\n`)
      } else {
        const sidecar = serializeStars(assembled)
        writeFileSync(join(OUT_DIR, sidecar.fileName), sidecar.json)
        starsInfo = { url: sidecar.fileName, sha256: sidecar.sha256 }
        const parts = [`${Object.keys(assembled.stars).length} starred (${assembled.fromSearch} from the search, ${assembled.fromGraphql} from GraphQL)`]
        if (skipped.length > 0) parts.push(`${skipped.length} skipped`)
        if (graphqlNote !== '') parts.push(graphqlNote)
        starsNote = parts.join(', ')
        process.stderr.write(`stars: ${starsNote}\n`)
      }
    }
  }

  // Icons (design 2026-10-23-shop-plugin-icons §4 to §6): the icon each listed
  // entry's author declared, read once from the artifact the entry installs and
  // carried in a sidecar of its own, beside the stars. An icon never decides what
  // is listed (decision 6), so nothing below can delist an entry or fail the
  // build over an author's file: an icon that is missing, refused or unanswered
  // is an entry published with the default artwork, and the report says why.
  // What does stop the build is a malformed record or file of ours, which is a
  // defect and not an author's, and the two tripwires below.
  const iconSubjectList = iconSubjects(selectedEntries, candidates, repoCandidates)
  // Yesterday's icons file, for the bytes of every icon the record already holds.
  // The empty file when yesterday's index points at none, as a build that
  // published no icon leaves it; null when it cannot be read, which costs
  // fetches and nothing else.
  const publishedIcons = await readPublishedIcons(fetch)
  // The plan and the fold are handed the same record, file and withheld rows: a
  // plan made from one set and folded against another would reuse an icon the
  // fold then has no bytes for.
  const iconPlan = planIconWork(iconSubjectList, iconState, publishedIcons, config.withheldIcons, iconFetchBudget)
  process.stderr.write(`icons: ${iconPlan.reuse.length} reused, ${iconPlan.fetch.length} to fetch, ${iconPlan.deferred.length} past the budget\n`)
  // The fetches' time budget, cut to what the job has left: they stop starting
  // iconStepReserveMs before the job's deadline, so their last request and the
  // rest of this build are done by it. Measured here, after the published
  // file's reads, because harvestIcons counts its budget from its own call.
  const iconTimeBudgetMs = budgetBeforeDeadline(iconFetchTimeBudgetMs, jobDeadlineMs === null ? null : jobDeadlineMs - iconStepReserveMs, nowMs())
  const iconResults = await harvestIcons(
    iconPlan,
    {
      fetchImpl: fetch,
      sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
      // The job's GitHub token goes to raw.githubusercontent.com and nowhere
      // else (see IconTransport).
      token: ghToken,
      timeoutMs: GITHUB_REQUEST_TIMEOUT_MS,
      tarballTimeoutMs: TARBALL_REQUEST_TIMEOUT_MS,
    },
    { concurrency: ICON_FETCH_CONCURRENCY, deadlineMs: iconTimeBudgetMs },
  )
  // The plan's fetches the time budget ran out before starting have no result
  // at all, and the fold reads them as "not yet read" like the rest. Said here,
  // because the report's count cannot tell them from a fetch that failed.
  const iconsNotStarted = iconPlan.fetch.length - iconResults.size
  if (iconsNotStarted > 0) {
    const cut = iconTimeBudgetMs < iconFetchTimeBudgetMs ? `, cut from ${iconFetchTimeBudgetMs} ms to the time the job had left,` : ''
    process.stderr.write(`icons: ${iconsNotStarted} of ${iconPlan.fetch.length} planned fetches were not started: the time budget of ${iconTimeBudgetMs} ms${cut} ran out\n`)
  }
  // A fetch that said nothing about its artifact is recorded nowhere, and its
  // reason is for the log alone (IconFetchResult): ten of them, in plan order so
  // that the sample does not depend on which worker finished first, then the
  // count. The same cap the declarations re-read puts on its failure lines.
  const ICON_REASON_LINES = 10
  const unanswered = iconPlan.fetch.flatMap(work => {
    const result = iconResults.get(work.key)
    return result?.kind === 'not-yet-read' ? [{ key: work.key, reason: result.reason }] : []
  })
  for (const { key, reason } of unanswered.slice(0, ICON_REASON_LINES)) {
    // The key holds the author's path, quoted; the reason is flattened to one line.
    process.stderr.write(`icons: not yet read ${JSON.stringify(key)}: ${reason.replace(/\s+/g, ' ')}\n`)
  }
  if (unanswered.length > ICON_REASON_LINES) {
    process.stderr.write(`icons: ${unanswered.length - ICON_REASON_LINES} more not yet read\n`)
  }
  const iconFold = foldIconResults(iconSubjectList, iconPlan, iconResults, iconState, publishedIcons, config.withheldIcons)
  // Before anything this build writes or publishes about icons: a row the next
  // build could not read back throws here, with the committed record untouched
  // and no sidecar written. The text is written below, after the pipeline, with
  // the other state files.
  const iconStateOut = serializeIconState(iconFold.nextState)
  // The fold builds the file and the map of entries to icons together and
  // guarantees every icon an entry names is in the file. A dangling one would
  // pass every check from here on and draw the default artwork, which is how a
  // plugin with no icon looks, so it is asserted rather than trusted.
  assertIconsInFile(iconFold.byIdentity, iconFold.file)
  // No icon at all is no sidecar and no pointer, rather than an empty file
  // every shop would fetch and verify for nothing.
  const iconsFile = iconFold.file === null ? null : serializeIcons(iconFold.file)
  if (iconsFile !== null) writeFileSync(join(OUT_DIR, iconsFile.fileName), iconsFile.json)
  const iconsFileBytes = iconsFile === null ? null : Buffer.byteLength(iconsFile.json)
  const iconsLostNote = describeLostIconsFile(iconState, publishedIcons, iconPlan, iconResults)
  process.stderr.write(`icons: ${Object.entries(iconFold.counts).map(([name, count]) => `${name} ${count}`).join(', ')}; icons file: ${iconsFile === null ? 'none' : `${iconsFile.fileName}, ${iconsFileBytes} bytes`}\n`)
  if (iconsLostNote !== null) process.stderr.write(`icons: ${iconsLostNote}\n`)

  // The build date, from the clock's one reading, passed down. First-seen
  // bookkeeping moved into the pipeline: which candidates are ENTRIES is a
  // policy question the gate answers, and stamping every harvested candidate
  // here dated packages that were never listed (B-9). The appended file is
  // written back after the pipeline, so the daily commit carries both the new
  // dates and the manifest lock together.

  // v5 is a release-time flag (design §3.5): `theme` is a new enum value and an
  // old client's zod enum rejects a catalog containing it wholesale, so the flag
  // flips only in the release commit that ships the v5-parsing client — never
  // before (the v3→v4 precedent; recorded in the release plan, not executed here).
  const v5Flag = process.env.SHOP_CATALOG_V5 === '1'
  // SHOP_CATALOG_V6 went with the peers gate (2026-09-03). `peers` rides v5, so
  // the only thing bumping to 6 would still do is throw on every client that
  // caps at 5 — a break with nothing left to buy.
  const schemaVersion = v5Flag
    ? CATALOG_SCHEMA_VERSION
    : (probeSubpackages ? SUBPACKAGE_SCHEMA_VERSION : SCHEMA_VERSION)
  const artifacts = runPipeline(
    candidates, repoCandidates, config, builtAt, rejections, starsInfo, schemaVersion,
    iconsFile === null ? null : { pointer: { url: iconsFile.fileName, sha256: iconsFile.sha256 }, byIdentity: iconFold.byIdentity },
  )

  writeFileSync(join(OUT_DIR, artifacts.pluginsFileName), artifacts.pluginsJson)
  writeFileSync(join(OUT_DIR, 'index.json'), artifacts.indexJson)
  writeFileSync(join(OUT_DIR, 'badge.json'), artifacts.badgeJson)
  writeFileSync(join(REGISTRY_DIR, 'snapshots/manifest.lock'), artifacts.manifestLock)
  writeFileSync(join(REGISTRY_DIR, 'first-seen.yml'), serializeFirstSeen(artifacts.firstSeen))
  // The publisher vocabulary, written HERE rather than in either harvest
  // branch. CI never executes the direct branch — it runs classify.ts and
  // hands the result over — so a writer inside that branch is a writer the
  // daily run never reaches, and the vocabulary would stay empty forever while
  // every test that drives the direct branch passed.
  //
  // After the pipeline, so a build that throws on its own artifacts does not
  // leave a vocabulary, a pin or an evicted name recording work it did not
  // publish. A run that fails its coverage check never gets here: Classify
  // throws first. Its records reach this same transition through
  // `--axis-from` instead (design 2026-10-22-publisher-axis-on-a-red-run), so
  // a red run moves its cursor and keeps the pins it earned, where it used to
  // re-probe its slice on the next run.
  const spent = spendPublisherAxis(priorPublishers, [...sawPublishers], axis, harvestFrom === undefined ? 'the direct build' : `--harvest-from ${harvestFrom}`)
  const nextPublishers = spent.state
  axisParts.push(...spent.parts)
  // Written FIRST, as `--axis-from` writes before it prints: a disk-full or
  // read-only failure used to leave a log claiming a transition the file never
  // took (PR #118 review).
  writeFileSync(publisherStatePath, serializePublisherState(nextPublishers))
  if (nextFeed !== undefined) writeFileSync(feedStatePath, serializeFeedState(nextFeed))
  for (const part of axisParts) process.stderr.write(`npm: ${part}\n`)
  // The icon record, serialised before the pipeline ran (see above) and written
  // here with the other state files: after the pipeline, so that a build which
  // throws on its own artifacts leaves no record of icons it did not publish.
  writeFileSync(iconStatePath, iconStateOut)
  for (const part of feedParts) process.stderr.write(`npm: ${part}\n`)
  process.stderr.write(
    `npm: publisher vocabulary ${priorPublishers.publishers.length} -> ${nextPublishers.publishers.length}\n`)
  const npmLine = npmParts.length === 0 ? '' : `\nnpm search shortfall (tolerated, packages missing from this build):\n${npmParts.map(part => `- ${part}\n`).join('')}`
  const axisLine = axisParts.length === 0 ? '' : `\npublisher axis (per-keyword pinning and probing, not itself a shortfall):\n${axisParts.map(part => `- ${part}\n`).join('')}`
  const repoLine = repoNote === '' ? '' : `\nGitHub: ${repoNote}\n`
  // Count listed github entries whose repo-state record holds `archived: true`
  // (design 2026-10-08 §1.3, R5). The line always prints — zero carries no
  // special behavior.
  const archivedEntryCount = (JSON.parse(artifacts.pluginsJson) as { plugins: { source?: string; archived?: true }[] })
    .plugins.filter(p => p.source === 'github' && p.archived === true).length
  const archivedLine = `\ngithub entries from archived repositories: ${archivedEntryCount}\n`
  // The fork flag's one report line (design 2026-10-11-fork-flag §1.1 — "The
  // build report gains one line"). The line names the fact and its magnitude;
  // same conditional-count shape as `archivedLine`: empty when no flag pass
  // ran, the GraphQL counters when one did.
  const forkedLine = forkedNote === '' ? '' : `\n${forkedNote}\n`
  const feedLine = feedParts.length === 0 ? '' : `\nchange feed (npm, by publication time):\n${feedParts.map(part => `- ${part}\n`).join('')}`
  const departureParts = departureSummary === undefined ? [] : describeDepartures(departureSummary)
  for (const part of departureParts) process.stderr.write(`npm: ${part}\n`)
  const [departureHead, ...departureRest] = departureParts
  const departureLine = departureHead === undefined ? '' : `\n${departureHead}\n${departureRest.map(part => `- ${part}\n`).join('')}`
  // The icon section closes the report, as the last block, so that it can stand
  // on its own heading: it starts at the heading with no blank line before it
  // and ends in one newline, which is what keeps `report.md` ending in exactly
  // one. The note about a lost icons file belongs to it, and follows it.
  const iconSection = `${renderIconSection(iconFold, iconsFileBytes)}${iconsLostNote === null ? '' : `\n${iconsLostNote}\n`}`
  writeFileSync(join(OUT_DIR, 'report.md'), `${artifacts.report}\nStars: ${starsNote}\n${npmLine}${departureLine}${axisLine}${feedLine}${repoLine}${archivedLine}${forkedLine}\n${iconSection}`)

  // Pages gets a directory staged from scratch, holding exactly the artifacts
  // the spec lists. `dist/v1` is NOT cleaned and is not what deploys: the
  // classifier's harvest reaches this run through `dist/`, the two reports are
  // uploaded from `dist/v1` as run artifacts, and a local `dist/v1`
  // accumulates old sidecars — all harmless once nothing publishes from it.
  const PAGES_DIR = 'dist/pages'
  rmSync(PAGES_DIR, { recursive: true, force: true })
  mkdirSync(join(PAGES_DIR, 'v1'), { recursive: true })
  // The pointer is read back from the index this build just wrote, not
  // assembled from the pieces it was built from: what Pages stages is then
  // exactly what the index names, and a sidecar added to the index reaches
  // Pages with no second edit here (pagesPointerOf).
  // The classification report comes from `classify.ts`, which the daily
  // workflow runs before this and a local build does not run at all. Asking
  // the disk is the only honest answer: a name in the returned list that is
  // not there is a `copyFileSync` that throws and takes the build with it.
  const pagesFiles = pagesArtifactNames(
    pagesPointerOf(artifacts.indexJson),
    { classificationReport: existsSync(join(OUT_DIR, 'classification-report.md')) },
  )
  for (const name of pagesFiles) copyFileSync(join(OUT_DIR, name), join(PAGES_DIR, 'v1', name))
  process.stderr.write(`staged ${pagesFiles.length} file(s) for Pages: ${pagesFiles.join(', ')}\n`)

  process.stderr.write(`wrote ${OUT_DIR}/${artifacts.pluginsFileName}\n`)
}
