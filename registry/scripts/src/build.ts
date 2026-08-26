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

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadRegistryConfig } from './config.ts'
import { fetchCandidates, searchByKeyword } from './npm-client.ts'
import { runPipeline } from './pipeline.ts'

const REGISTRY_DIR = 'registry'
const OUT_DIR = 'dist/v1'

// Optional read-only npm token. npm rate-limits the search API by IP, and a
// CI runner shares its egress IP with every other tenant, so unauthenticated
// searches can be throttled before the first request. When NPM_TOKEN is set,
// requests carry it as a Bearer header and the quota lands on the token.
const npmToken = process.env.NPM_TOKEN

const config = loadRegistryConfig(REGISTRY_DIR)
const names = await searchByKeyword(fetch, undefined, npmToken)
process.stderr.write(`harvested ${names.length} candidate(s)\n`)

const { candidates, rejections } = await fetchCandidates(names, fetch, npmToken)
const artifacts = runPipeline(candidates, config, new Date().toISOString(), rejections)

mkdirSync(OUT_DIR, { recursive: true })
mkdirSync(join(REGISTRY_DIR, 'snapshots'), { recursive: true })
writeFileSync(join(OUT_DIR, artifacts.pluginsFileName), artifacts.pluginsJson)
writeFileSync(join(OUT_DIR, 'index.json'), artifacts.indexJson)
writeFileSync(join(REGISTRY_DIR, 'snapshots/manifest.lock'), artifacts.manifestLock)
writeFileSync(join(OUT_DIR, 'report.md'), artifacts.report)

process.stderr.write(`wrote ${OUT_DIR}/${artifacts.pluginsFileName}\n`)
