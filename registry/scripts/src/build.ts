/**
 * Catalog build entry point.
 *
 * Network access is confined to `npm-client.ts`, `llm-client.ts`, and
 * `github-stars.ts` (the only modules that reach the network). Filesystem
 * access lives in this module (writing the build artifacts), in `config.ts`
 * (reading the registry inputs), and in `emit-schema.ts` (writing the
 * generated schema).
 * The pure core — `gate.ts`, `tier.ts`, `emit.ts`, `pipeline.ts`, `schema.ts`,
 * and `types.ts` — touches neither, so a failure here is an I/O failure
 * rather than a policy one.
 * @module build
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadRegistryConfig, serializeFirstSeen } from './config.ts'
import { fetchStarCounts } from './github-stars.ts'
import { harvestRepos } from './github-client.ts'
import { parseRepoState, serializeRepoState } from './repo-state.ts'
import { githubOwnerName } from './github-repo.ts'
import { fetchCandidates, searchByKeywords } from './npm-client.ts'
import { runPipeline } from './pipeline.ts'
import { CATALOG_SCHEMA_VERSION, SCHEMA_VERSION, SUBPACKAGE_SCHEMA_VERSION } from './emit.ts'
import { assembleStarsByKey } from './stars-assemble.ts'
import type { Candidate, Rejection, RepoCandidate } from './types.ts'

// `classify.ts` writes the harvest it already paid for; the workflow passes it
// here so the daily run does not fetch the ecosystem twice.
const harvestFromIndex = process.argv.indexOf('--harvest-from')
const harvestFrom = harvestFromIndex === -1 ? undefined : process.argv[harvestFromIndex + 1]
if (harvestFromIndex !== -1 && harvestFrom === undefined) {
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
// install path still runs through the user's own pnpm and registry config.
// Default-on per the 2026-08-31 hub-borrowings design (C); set
// NPM_BACKUP_REGISTRY to an empty string to disable.
const npmBackupRegistry = process.env.NPM_BACKUP_REGISTRY ?? 'https://registry.npmmirror.com'

// The same token the stars sidecar uses; also the GitHub API's quota key.
const ghToken = process.env.GITHUB_TOKEN ?? ''

const config = loadRegistryConfig(REGISTRY_DIR)
let candidates: Candidate[]
let rejections: Rejection[]
if (harvestFrom === undefined) {
  const names = await searchByKeywords(fetch, undefined, npmToken, npmBackupRegistry)
  process.stderr.write(`harvested ${names.length} npm candidate(s)\n`)
  const harvested = await fetchCandidates(names, fetch, npmToken, npmBackupRegistry)
  candidates = harvested.candidates
  rejections = harvested.rejections
} else {
  const parsed = JSON.parse(readFileSync(harvestFrom, 'utf8')) as { candidates?: unknown; rejections?: unknown }
  if (!Array.isArray(parsed.candidates) || !Array.isArray(parsed.rejections)) {
    throw new Error(`--harvest-from ${harvestFrom}: expected { candidates, rejections } arrays`)
  }
  candidates = parsed.candidates as Candidate[]
  rejections = parsed.rejections as Rejection[]
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
// Star counts the search itself carried, keyed by repo full name. Empty
// when the github harvest skipped — every repo then goes through GraphQL.
let repoSearchStars = new Map<string, number>()
// Subpackage probing rides the schemaVersion-4 flag (set inside the harvest
// branch); the emit at the bottom reads it for the version decision.
let probeSubpackages = false
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
  const repoStatePath = join(REGISTRY_DIR, 'repo-state.json')
  const repoState = existsSync(repoStatePath)
    ? parseRepoState(readFileSync(repoStatePath, 'utf8'))
    : {}
  const budget = Number(process.env.REPO_BACKFILL_BUDGET ?? '2000')
  // Subpackage probing rides the schemaVersion-4 flag: probing off, the
  // harvest behaves exactly as before and emits v3; the flag flips in the
  // release commit that ships the v4-reading client.
  probeSubpackages = process.env.SHOP_HARVEST_SUBPACKAGES === '1'
  let repos: Awaited<ReturnType<typeof harvestRepos>>
  try {
    repos = await harvestRepos({ state: repoState, budget, fetchImpl: fetch, token: ghToken, probeSubpackages })
  } catch (error) {
    // One whole-harvest retry after a pause: the GitHub half runs through
    // shared egress whose throttles outlast the per-request backoffs. A
    // second failure kills the build loudly — a half-harvested catalog is
    // worse than a red one, and the daily workflow retries next run.
    process.stderr.write(`github: first attempt failed (${error instanceof Error ? error.message : String(error)}); retrying once after 30s\n`)
    await new Promise(resolve => setTimeout(resolve, 30_000))
    repos = await harvestRepos({ state: repoState, budget, fetchImpl: fetch, token: ghToken })
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
      detail: 'The topic search no longer returns this repository (deleted, renamed, or private).',
    })
  }
  writeFileSync(repoStatePath, serializeRepoState(repos.nextState))
  repoNote = `${repos.windowCount} windows, ${repos.seen.length} repos seen, ${repos.fetched} fetched, ${repos.carried} carried, ${repos.deferred} deferred`
  process.stderr.write(`github: ${repoNote}\n`)
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
const starsToken = process.env.STARS_TOKEN ?? ghToken
let starsInfo: { url: string; sha256: string } | null = null
let starsNote = ''
if (starsToken === '') {
  starsNote = 'no GITHUB_TOKEN'
  process.stderr.write(`stars: ${starsNote}\n`)
} else {
  // Repos the search already covered: ask GraphQL only for the rest.
  const graphqlRepos = new Map<string, { owner: string; name: string }>()
  for (const candidate of [...candidates, ...repoCandidates]) {
    const parsed = githubOwnerName(candidate.repository)
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
    const assembled = assembleStarsByKey(candidates, repoCandidates, repoSearchStars, graphqlStars)
    if (Object.keys(assembled.stars).length === 0) {
      starsNote = graphqlNote === '' ? 'no star counts' : `no star counts (${graphqlNote})`
      process.stderr.write(`stars: ${starsNote}\n`)
    } else {
      const starsJson = `${JSON.stringify({ stars: Object.fromEntries(Object.entries(assembled.stars).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) }, null, 2)}\n`
      const starsSha = createHash('sha256').update(starsJson).digest('hex')
      writeFileSync(join(OUT_DIR, `stars.${starsSha}.json`), starsJson)
      starsInfo = { url: `stars.${starsSha}.json`, sha256: starsSha }
      const parts = [`${Object.keys(assembled.stars).length} starred (${assembled.fromSearch} from the search, ${assembled.fromGraphql} from GraphQL)`]
      if (skipped.length > 0) parts.push(`${skipped.length} skipped`)
      if (graphqlNote !== '') parts.push(graphqlNote)
      starsNote = parts.join(', ')
      process.stderr.write(`stars: ${starsNote}\n`)
    }
  }
}

// First-seen bookkeeping: any name this run harvested for the first time gets
// today. The appended file is written back after the pipeline, so the daily
// commit carries both the new dates and the manifest lock together.
const builtAt = new Date().toISOString()
const today = builtAt.slice(0, 10)
const firstSeen = new Map(config.firstSeen)
for (const candidate of candidates) if (!firstSeen.has(candidate.name)) firstSeen.set(candidate.name, today)
for (const repo of repoCandidates) if (!firstSeen.has(repo.name)) firstSeen.set(repo.name, today)
const configWithFirstSeen = { ...config, firstSeen }

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
const artifacts = runPipeline(candidates, repoCandidates, configWithFirstSeen, builtAt, rejections, starsInfo, schemaVersion)

writeFileSync(join(OUT_DIR, artifacts.pluginsFileName), artifacts.pluginsJson)
writeFileSync(join(OUT_DIR, 'index.json'), artifacts.indexJson)
writeFileSync(join(REGISTRY_DIR, 'snapshots/manifest.lock'), artifacts.manifestLock)
writeFileSync(join(REGISTRY_DIR, 'first-seen.yml'), serializeFirstSeen(firstSeen))
const repoLine = repoNote === '' ? '' : `\nGitHub: ${repoNote}\n`
writeFileSync(join(OUT_DIR, 'report.md'), `${artifacts.report}\nStars: ${starsNote}\n${repoLine}`)

process.stderr.write(`wrote ${OUT_DIR}/${artifacts.pluginsFileName}\n`)
