/**
 * Catalog build entry point.
 *
 * Network access is confined to `npm-client.ts`. Filesystem access lives in
 * this module (writing the build artifacts), in `config.ts` (reading the
 * registry inputs), and in `emit-schema.ts` (writing the generated schema).
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
import { githubOwnerName } from './github-repo.ts'
import { fetchCandidates, searchByKeyword } from './npm-client.ts'
import { runPipeline } from './pipeline.ts'
import type { Candidate, Rejection } from './types.ts'

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

const config = loadRegistryConfig(REGISTRY_DIR)
let candidates: Candidate[]
let rejections: Rejection[]
if (harvestFrom === undefined) {
  const names = await searchByKeyword(fetch, undefined, npmToken)
  process.stderr.write(`harvested ${names.length} candidate(s)\n`)
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
  process.stderr.write(`reusing harvest: ${candidates.length} candidate(s)\n`)
}

// Stars are daily-changing live data: they are quarantined in their own
// content-addressed sidecar so plugins.json keeps its cache-stable hash
// (spec 2026-08-26-github-stars-design.md D3). Advisory: any failure — no
// token, rate limit, down API — publishes without stars and retries next
// build. The step never throws.
const ghToken = process.env.GITHUB_TOKEN ?? ''
let starsInfo: { url: string; sha256: string } | null = null
let starsNote = ''
if (ghToken === '') {
  starsNote = 'no GITHUB_TOKEN'
  process.stderr.write(`stars: ${starsNote}\n`)
} else {
  const repos = new Map<string, { owner: string; name: string }>()
  for (const candidate of candidates) {
    const parsed = githubOwnerName(candidate.repository)
    if (parsed !== null) repos.set(`${parsed.owner}/${parsed.name}`, parsed)
  }
  if (repos.size === 0) {
    starsNote = 'no github.com repositories in the catalog'
  } else {
    try {
      const { stars: repoStars, skipped } = await fetchStarCounts([...repos.values()], { token: ghToken })
      const starsByPackage: Record<string, number> = {}
      for (const candidate of candidates) {
        const parsed = githubOwnerName(candidate.repository)
        if (parsed === null) continue
        const count = repoStars.get(`${parsed.owner}/${parsed.name}`)
        if (count !== undefined) starsByPackage[candidate.name] = count
      }
      const starsJson = `${JSON.stringify({ stars: Object.fromEntries(Object.entries(starsByPackage).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) }, null, 2)}\n`
      const starsSha = createHash('sha256').update(starsJson).digest('hex')
      writeFileSync(join(OUT_DIR, `stars.${starsSha}.json`), starsJson)
      starsInfo = { url: `stars.${starsSha}.json`, sha256: starsSha }
      starsNote = skipped.length === 0 ? `${Object.keys(starsByPackage).length} starred` : `${Object.keys(starsByPackage).length} starred, ${skipped.length} skipped`
      process.stderr.write(`stars: ${starsNote}\n`)
    } catch (error) {
      starsNote = `skipped: ${error instanceof Error ? error.message : String(error)}`
      process.stderr.write(`stars: ${starsNote}\n`)
    }
  }
}

const artifacts = runPipeline(candidates, config, new Date().toISOString(), rejections, starsInfo)

mkdirSync(OUT_DIR, { recursive: true })
mkdirSync(join(REGISTRY_DIR, 'snapshots'), { recursive: true })
writeFileSync(join(OUT_DIR, artifacts.pluginsFileName), artifacts.pluginsJson)
writeFileSync(join(OUT_DIR, 'index.json'), artifacts.indexJson)
writeFileSync(join(REGISTRY_DIR, 'snapshots/manifest.lock'), artifacts.manifestLock)
writeFileSync(join(OUT_DIR, 'report.md'), starsNote === '' ? artifacts.report : `${artifacts.report}\nStars: ${starsNote}\n`)

process.stderr.write(`wrote ${OUT_DIR}/${artifacts.pluginsFileName}\n`)
