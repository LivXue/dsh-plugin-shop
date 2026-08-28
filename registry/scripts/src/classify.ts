/**
 * Classification entry point: the daily step that keeps categories.yml
 * current (spec 2026-08-26-llm-categorization-design.md §4).
 *
 * One run: harvest the ecosystem once, classify every gate-accepted derived
 * listing without a row, write the merged/pruned/sorted categories.yml, and
 * drop the harvest at dist/harvest.json so `build.ts --harvest-from` reuses
 * it without a second pass over npm.
 *
 * The LLM is advisory: no key, a down gateway, or garbage output never fails
 * this step — the affected entries stay unclassified and the next build
 * retries them (D4). A harvest or registry-file failure IS fatal: those are
 * the same loud failures the build would have raised.
 * @module classify
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mergeCategoryRows, serializeCategoryRows } from './categories.ts'
import { gate } from './gate.ts'
import { loadRegistryConfig } from './config.ts'
import { classifyPackages, type ClassifyItem } from './llm-client.ts'
import { fetchCandidates, searchByKeywords } from './npm-client.ts'
import type { Category } from './types.ts'

const REGISTRY_DIR = 'registry'
const OUT_DIR = 'dist/v1'

// The gateway serves plain HTTP only (probed: no TLS listener). The Bearer
// key therefore rides plaintext on the runner→gateway path; the key is a
// rotate-able classification credential and the transport choice belongs to
// the gateway owner. Point LLM_BASE_URL at an https mirror when one exists.
const baseUrl = process.env.LLM_BASE_URL ?? 'http://8.141.31.123:3000/v1'
const model = process.env.LLM_MODEL ?? 'deepseek-v4-flash'
const apiKey = process.env.LLM_API_KEY ?? ''
const npmToken = process.env.NPM_TOKEN

const config = loadRegistryConfig(REGISTRY_DIR)
const names = await searchByKeywords(fetch, undefined, npmToken)
process.stderr.write(`classify: harvested ${names.length} candidate(s)\n`)
const { candidates, rejections } = await fetchCandidates(names, fetch, npmToken)

// pending = derived listings the gate accepts, minus what the file already has
const pending: ClassifyItem[] = []
const liveNames = new Set<string>()
for (const candidate of candidates) {
  const result = gate(candidate, config)
  if (!result.ok) continue
  if (result.accepted.metadata !== 'derived') continue
  liveNames.add(candidate.name)
  if (config.categories.has(candidate.name)) continue
  pending.push({ name: candidate.name, description: candidate.description, keywords: candidate.keywords })
}
process.stderr.write(`classify: ${pending.length} pending name(s)\n`)

let discarded: { name: string; reason: string }[] = []
let fresh = new Map<string, Category>()
if (apiKey === '') {
  discarded = pending.map(p => ({ name: p.name, reason: 'no LLM_API_KEY (skipped)' }))
} else {
  const result = await classifyPackages(pending, { baseUrl, model, apiKey })
  fresh = result.classified
  discarded = result.discarded
}

const merged = mergeCategoryRows(config.categories, fresh, liveNames)
mkdirSync(OUT_DIR, { recursive: true })
mkdirSync(join(REGISTRY_DIR), { recursive: true })
writeFileSync(join(REGISTRY_DIR, 'categories.yml'), serializeCategoryRows(merged))
writeFileSync(join(OUT_DIR, 'harvest.json'), `${JSON.stringify({ candidates, rejections })}\n`)
const sortedDiscards = [...discarded].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
const reportLines = [
  '# Classification report',
  '',
  `Classified: ${merged.size}`,
  `Discarded: ${sortedDiscards.length}`,
  '',
  '| Package | Reason |',
  '|---|---|',
  ...sortedDiscards.map(d => `| ${d.name} | ${d.reason.replace(/\|/g, '\\|').replace(/\r\n|\r|\n/g, ' ')} |`),
]
writeFileSync(join(OUT_DIR, 'classification-report.md'), `${reportLines.join('\n')}\n`)
process.stderr.write(`classify: ${merged.size} rows, ${sortedDiscards.length} discarded\n`)
