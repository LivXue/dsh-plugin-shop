/**
 * The dictionary's consistency check (design 2026-10-08-search-query-expansion §6):
 * every intent's terms must have at least one measured hit in today's live
 * catalog. If the catalog drifts and an entire intent loses its recall, the
 * row earns a "kept for X" comment or gets deleted. Data file, read from disk.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ZH_INTENTS, tokenInText } from '../src/shared/zh-intents.ts'

// A snapshot of the live catalog, fetched 2026-10-08 by design §3's
// measurement. In the worktree the same file lives under /tmp/c2compete; in CI
// it is committed next to this test. Update procedure: refresh plugins-live.json
// from https://LivXue.github.io/dsh-plugin-shop/v1/plugins.<sha>.json, then
// re-run the two scripts in /tmp/c2compete/scripts/ and update the snapshot's
// comments below.
const fixturePath = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'plugins-live.json')

interface CatalogEntry {
  name: string
  catalog?: { summary?: { en?: string; zh?: string } }
}

describe('the zh-intent dictionary against the measured catalog', () => {
  const plugins: CatalogEntry[] = (JSON.parse(readFileSync(fixturePath, 'utf-8')) as { plugins: CatalogEntry[] }).plugins

  const termInText = (term: string, text: string) =>
    term.startsWith('#')
      ? tokenInText(term.slice(1), text)
      : text.includes(term.toLowerCase())

  it('gives every one of the 83 intents at least one hit', () => {
    const miss: string[] = []
    for (const intent of ZH_INTENTS) {
      const hits = plugins.filter(p => {
        const blob = [p.name, p.catalog?.summary?.en ?? '', p.catalog?.summary?.zh ?? ''].join(' ').toLowerCase()
        return intent.terms.some(term => termInText(term, blob))
      })
      if (hits.length === 0) {
        miss.push(`${intent.key} (terms: ${intent.terms.join(', ')})`)
      }
    }
    expect(miss, 'these intents have no recall on the measured catalog — they earn a comment naming why they stay, or they go').toEqual([])
  })

  it('every intent’s marginal recall on the measured catalog is at least the design’s floor (10)', () => {
    // A "Chinese-trigger" hit is one where the intent's own `words` appear
    // in the entry's name or zh summary — the subset the raw query can
    // already reach. Marginal is what the dictionary expands BEYOND it.
    // Design §3 trimmed the dictionary to intents whose marginal ≥ 10; this
    // IS the trim line.
    const tooThin: string[] = []
    for (const intent of ZH_INTENTS) {
      const zhTriggers = new Set(
        plugins.filter(p => {
          const blob = [p.name ?? '', p.catalog?.summary?.zh ?? ''].join(' ').toLowerCase()
          return intent.words.some(w => blob.includes(w))
        }).map(p => p.name),
      )
      const termsHits = new Set(
        plugins.filter(p => {
          const blob = [p.name, p.catalog?.summary?.en ?? '', p.catalog?.summary?.zh ?? ''].join(' ').toLowerCase()
          return intent.terms.some(term => termInText(term, blob))
        }).map(p => p.name),
      )
      const marginal = [...termsHits].filter(n => !zhTriggers.has(n)).length
      if (marginal < 10) tooThin.push(`${intent.key}: marginal ${marginal}`)
    }
    expect(tooThin, 'an intent whose marginal recall is below the design’s floor goes — it costs UI noise without saving the user any recall').toEqual([])
  })
})
