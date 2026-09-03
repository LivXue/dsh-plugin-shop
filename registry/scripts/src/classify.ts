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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mergeCategoryRows, serializeCategoryRows } from './categories.ts'
import { selectPending } from './classify-select.ts'
import { loadRegistryConfig } from './config.ts'
import { classifyPackages } from './llm-client.ts'
import { judgeMarkets, type MarketItem } from './market-judge.ts'
import { selectMarketPending } from './market-select.ts'
import { mergeMarketRows, serializeMarketRows } from './markets.ts'
import { fetchCandidates, searchByKeywords } from './npm-client.ts'
import { parseRepoState } from './repo-state.ts'
import type { Category, RepoCandidate } from './types.ts'

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

// The daily harvest runs HERE, not in build.ts: the workflow passes
// `--harvest-from dist/v1/harvest.json` so the ecosystem is fetched once. That
// made the mirror failover from the 2026-08-31 hub-borrowings design (C) dead
// code in production — build.ts had it and this path did not. Same default as
// build.ts. An empty string is MEANT to disable the backup, but
// `fetchWithFailover` does not honour that yet — it only treats `undefined`
// as disabled, so `''` builds a relative URL and crashes on the first primary
// failure (D-6, owned by Task 3). Leave `NPM_BACKUP_REGISTRY` unset rather
// than empty until that lands.
//
// This is the packument path ONLY. registry.npmmirror.com does not implement
// the `keywords:` qualifier `searchByKeywords` depends on — measured
// 2026-09-03, it answers `{"objects":[],"total":0}` for both harvest
// keywords — and Task 1's coverage guards do not catch a numeric zero total.
// Handing it to the search would let a stalled or 5xx npmjs search publish a
// zero-name harvest with a green build, so `searchByKeywords` below takes no
// backup argument.
const npmBackupRegistry = process.env.NPM_BACKUP_REGISTRY ?? 'https://registry.npmmirror.com'

const config = loadRegistryConfig(REGISTRY_DIR)
const names = await searchByKeywords(fetch, undefined, npmToken)
process.stderr.write(`classify: harvested ${names.length} candidate(s)\n`)
const { candidates, rejections } = await fetchCandidates(names, fetch, npmToken, npmBackupRegistry)

// The GitHub half, read from the committed harvest memory rather than
// re-harvested: `repo-state.json` records the very candidates `build.ts`
// composes the catalog from, so reading it costs no GitHub call, needs no
// token, and leaves `build.ts` the only writer of that state. The price is a
// day of lag for a brand-new repository — it is classified by the next run,
// which is the "unclassified, retried on the next build" state D4 defines.
// A missing file is the npm-only case; a malformed one throws, exactly as it
// does in the build (it is a committed build input).
const repoStatePath = join(REGISTRY_DIR, 'repo-state.json')
const repoCandidates: RepoCandidate[] = []
if (existsSync(repoStatePath)) {
  for (const entry of Object.values(parseRepoState(readFileSync(repoStatePath, 'utf8')))) {
    repoCandidates.push(...entry.candidates)
  }
}
process.stderr.write(`classify: ${repoCandidates.length} recorded repo candidate(s)\n`)

const { pending, liveNames } = selectPending(candidates, repoCandidates, config)
process.stderr.write(`classify: ${pending.length} pending name(s), ${liveNames.size} live\n`)

let discarded: { name: string; reason: string }[] = []
let fresh = new Map<string, Category>()
if (apiKey === '') {
  discarded = pending.map(p => ({ name: p.name, reason: 'no LLM_API_KEY (skipped)' }))
} else {
  const result = await classifyPackages(pending, { baseUrl, model, apiKey })
  fresh = result.classified
  discarded = result.discarded
}

// The market question, asked of the same harvest. Separate from the category
// question on purpose: it has its own vocabulary, its own failure cost, and a
// name it cannot decide must go UNANSWERED rather than be guessed — an omitted
// name keeps the heuristic's answer and is asked again tomorrow, a recorded one
// is not. Names already in markets.yml are never re-asked, whichever way they
// were judged.
const marketCandidates = [
  ...candidates.map(c => ({ name: c.name, description: c.description, keywords: c.keywords })),
  ...repoCandidates.map(c => ({ name: c.name, repo: c.repo, description: c.description, keywords: [] })),
]
const marketPending = selectMarketPending(marketCandidates, config.marketsJudged)
process.stderr.write(`classify: ${marketPending.length} name(s) awaiting a market verdict\n`)
const marketByName = new Map<string, MarketItem>()
for (const candidate of marketCandidates) {
  if (!marketByName.has(candidate.name)) marketByName.set(candidate.name, candidate)
}
const marketItems = marketPending
  .map(name => marketByName.get(name))
  .filter((item): item is MarketItem => item !== undefined)
let marketVerdicts = new Map<string, boolean>()
let marketDiscards: { name: string; reason: string }[] = []
if (apiKey === '') {
  marketDiscards = marketItems.map(i => ({ name: i.name, reason: 'no LLM_API_KEY (skipped)' }))
} else if (marketItems.length > 0) {
  const judged = await judgeMarkets(marketItems, { baseUrl, model, apiKey })
  marketVerdicts = judged.verdicts
  marketDiscards = judged.discarded
}
const marketReasons = new Map(
  [...marketVerdicts].map(([name, isMarket]) => [
    name,
    isMarket
      ? `Judged a dsh plugin market from: ${marketByName.get(name)?.description ?? '(no description)'}`
      : `Judged NOT a dsh plugin market from: ${marketByName.get(name)?.description ?? '(no description)'}`,
  ]),
)
writeFileSync(
  join(REGISTRY_DIR, 'markets.yml'),
  serializeMarketRows(mergeMarketRows(config.marketRows, marketVerdicts, marketReasons)),
)

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
