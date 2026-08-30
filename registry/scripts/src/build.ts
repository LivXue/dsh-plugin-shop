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
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadRegistryConfig } from './config.ts'
import { fetchStarCounts } from './github-stars.ts'
import { harvestRepos } from './github-client.ts'
import { githubOwnerName } from './github-repo.ts'
import { fetchCandidates, searchByKeywords } from './npm-client.ts'
import { runPipeline } from './pipeline.ts'
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

// The same token the stars sidecar uses; also the GitHub API's quota key.
const ghToken = process.env.GITHUB_TOKEN ?? ''

const config = loadRegistryConfig(REGISTRY_DIR)
let candidates: Candidate[]
let rejections: Rejection[]
if (harvestFrom === undefined) {
  const names = await searchByKeywords(fetch, undefined, npmToken)
  process.stderr.write(`harvested ${names.length} npm candidate(s)\n`)
  const harvested = await fetchCandidates(names, fetch, npmToken)
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
const repoFlag = process.env.SHOP_HARVEST_REPOS === '1'
if (ghToken === '') {
  repoNote = 'github harvest skipped: GITHUB_TOKEN is not set'
  process.stderr.write(`github: ${repoNote}\n`)
} else if (!repoFlag) {
  repoNote = 'github harvest skipped: SHOP_HARVEST_REPOS is not 1 (flipped in the release that ships the v3 client)'
  process.stderr.write(`github: ${repoNote}\n`)
} else {
  let repos: Awaited<ReturnType<typeof harvestRepos>>
  try {
    repos = await harvestRepos(fetch, undefined, ghToken)
  } catch (error) {
    // One whole-harvest retry after a pause: the GitHub half runs through
    // shared egress whose throttles outlast the per-request backoffs. A
    // second failure kills the build loudly — a half-harvested catalog is
    // worse than a red one, and the daily workflow retries next run.
    process.stderr.write(`github: first attempt failed (${error instanceof Error ? error.message : String(error)}); retrying once after 30s\n`)
    await new Promise(resolve => setTimeout(resolve, 30_000))
    repos = await harvestRepos(fetch, undefined, ghToken)
  }
  repoCandidates = repos.candidates
  for (const failure of repos.failures) {
    rejections.push({ name: failure.repo, code: failure.code, detail: failure.detail })
  }
  const capNote = repos.capped ? ' (GitHub caps topic search at 1000 results)' : ''
  repoNote = `${repoCandidates.length} repo candidate(s)${capNote}`
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
let starsInfo: { url: string; sha256: string } | null = null
let starsNote = ''
if (ghToken === '') {
  starsNote = 'no GITHUB_TOKEN'
  process.stderr.write(`stars: ${starsNote}\n`)
} else {
  const repos = new Map<string, { owner: string; name: string }>()
  for (const candidate of [...candidates, ...repoCandidates]) {
    const parsed = githubOwnerName(candidate.repository)
    if (parsed !== null) repos.set(`${parsed.owner}/${parsed.name}`, parsed)
  }
  if (repos.size === 0) {
    starsNote = 'no github.com repositories in the catalog'
  } else {
    try {
      const { stars: repoStars, skipped } = await fetchStarCounts([...repos.values()], { token: ghToken })
      const starsByKey: Record<string, number> = {}
      for (const candidate of candidates) {
        const parsed = githubOwnerName(candidate.repository)
        if (parsed === null) continue
        const count = repoStars.get(`${parsed.owner}/${parsed.name}`)
        if (count !== undefined) starsByKey[candidate.name] = count
      }
      for (const repo of repoCandidates) {
        const parsed = githubOwnerName(repo.repository)
        if (parsed === null) continue
        const count = repoStars.get(`${parsed.owner}/${parsed.name}`)
        if (count !== undefined) starsByKey[repo.repo] = count
      }
      const starsJson = `${JSON.stringify({ stars: Object.fromEntries(Object.entries(starsByKey).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) }, null, 2)}\n`
      const starsSha = createHash('sha256').update(starsJson).digest('hex')
      writeFileSync(join(OUT_DIR, `stars.${starsSha}.json`), starsJson)
      starsInfo = { url: `stars.${starsSha}.json`, sha256: starsSha }
      starsNote = skipped.length === 0 ? `${Object.keys(starsByKey).length} starred` : `${Object.keys(starsByKey).length} starred, ${skipped.length} skipped`
      process.stderr.write(`stars: ${starsNote}\n`)
    } catch (error) {
      starsNote = `skipped: ${error instanceof Error ? error.message : String(error)}`
      process.stderr.write(`stars: ${starsNote}\n`)
    }
  }
}

const artifacts = runPipeline(candidates, repoCandidates, config, new Date().toISOString(), rejections, starsInfo)

writeFileSync(join(OUT_DIR, artifacts.pluginsFileName), artifacts.pluginsJson)
writeFileSync(join(OUT_DIR, 'index.json'), artifacts.indexJson)
writeFileSync(join(REGISTRY_DIR, 'snapshots/manifest.lock'), artifacts.manifestLock)
const repoLine = repoNote === '' ? '' : `\nGitHub: ${repoNote}\n`
writeFileSync(join(OUT_DIR, 'report.md'), `${artifacts.report}\nStars: ${starsNote}\n${repoLine}`)

process.stderr.write(`wrote ${OUT_DIR}/${artifacts.pluginsFileName}\n`)
