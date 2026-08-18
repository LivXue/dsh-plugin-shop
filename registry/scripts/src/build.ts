/**
 * Catalog build entry point: the only module that both fetches and writes.
 * Everything it composes is pure, so a failure here is an I/O failure rather
 * than a policy one.
 * @module build
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadRegistryConfig } from './config.ts'
import { fetchCandidate, searchByKeyword } from './npm-client.ts'
import { runPipeline } from './pipeline.ts'
import type { Candidate, Rejection } from './types.ts'

const REGISTRY_DIR = 'registry'
const OUT_DIR = 'dist/v1'
const CONCURRENCY = 8

/**
 * Fetch every candidate with a bounded number of concurrent requests.
 *
 * A name that produced no candidate becomes a `fetch-failed` rejection rather
 * than being dropped: at this volume of requests, a transient HTTP failure is
 * otherwise indistinguishable from a package that was legitimately
 * unpublished between the search and the fetch.
 */
async function fetchAll(names: string[]): Promise<{ candidates: Candidate[]; rejections: Rejection[] }> {
  const candidates: Candidate[] = []
  const rejections: Rejection[] = []
  for (let i = 0; i < names.length; i += CONCURRENCY) {
    const batch = names.slice(i, i + CONCURRENCY)
    const results = await Promise.all(batch.map(async name => ({ name, result: await fetchCandidate(name) })))
    for (const { name, result } of results) {
      if (result.ok) candidates.push(result.candidate)
      else rejections.push({ name, code: 'fetch-failed', detail: result.detail })
    }
  }
  return { candidates, rejections }
}

const config = loadRegistryConfig(REGISTRY_DIR)
const names = await searchByKeyword()
process.stderr.write(`harvested ${names.length} candidate(s)\n`)

const { candidates, rejections } = await fetchAll(names)
const artifacts = runPipeline(candidates, config, new Date().toISOString(), rejections)

mkdirSync(OUT_DIR, { recursive: true })
mkdirSync(join(REGISTRY_DIR, 'snapshots'), { recursive: true })
writeFileSync(join(OUT_DIR, artifacts.pluginsFileName), artifacts.pluginsJson)
writeFileSync(join(OUT_DIR, 'index.json'), artifacts.indexJson)
writeFileSync(join(REGISTRY_DIR, 'snapshots/manifest.lock'), artifacts.manifestLock)
writeFileSync(join(OUT_DIR, 'report.md'), artifacts.report)

process.stderr.write(`wrote ${OUT_DIR}/${artifacts.pluginsFileName}\n`)
