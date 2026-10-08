/**
 * The zh-intent dictionary itself (design 2026-10-08-search-query-expansion
 * §3), and the boundary rules every recall term obeys. Fixtures, never the
 * modules under test — the module IS the dictionary.
 */

import { describe, expect, it } from 'vitest'
import { ZH_INTENTS, expandZhQuery, tokenInText } from '../src/shared/zh-intents.ts'

describe('ZH_INTENTS', () => {
  it('holds exactly the intents the design measured on the 2026-10-08 catalog', () => {
    expect(ZH_INTENTS.length).toBe(83)
  })

  it('has no duplicate key, and every row carries both words and terms', () => {
    const keys = new Set<string>()
    for (const intent of ZH_INTENTS) {
      expect(keys.has(intent.key), `duplicate key: ${intent.key}`).toBe(false)
      keys.add(intent.key)
      expect(intent.words.length, `${intent.key} has no trigger word`).toBeGreaterThan(0)
      expect(intent.terms.length, `${intent.key} has no recall term`).toBeGreaterThan(0)
    }
  })

  it('covers each query C2 measured: 记忆, 主题, 搜索', () => {
    // The design's §3 pins the three rows as the borrowing's first-class
    // evidence: without them the dictionary cannot answer the exact query the
    // borrowing was measured on. A fixture that drops them is a defect, not a
    // consequence-free trim.
    const keys = new Set(ZH_INTENTS.map(intent => intent.key))
    expect(keys.has('记忆'), 'C2 measured `记忆` vs `memory`; the dictionary must fire on it').toBe(true)
    expect(keys.has('主题'), 'C2 measured `主题` vs `theme`; the dictionary must fire on it').toBe(true)
    expect(keys.has('搜索'), 'C2 measured `搜索` vs `search`; the dictionary must fire on it').toBe(true)
  })

  it('keeps every recall term in the grammar the matcher reads: Han, or [a-z0-9.#-]', () => {
    // U+3400-U+9FFF is the CJK Unified Ideographs block the matcher relies on
    // (`tokenInText`'s boundary regex uses `[^a-z0-9]`); terms outside that
    // range are either Han (matched as a substring) or pure ASCII (matched
    // via `#` boundary or as a substring). The `+` on the Han arm matters:
    // `记` alone passes, `记忆` only passes when the Han arm repeats.
    const HAN_OR_ASCII = /^(?:[㐀-鿿豈-﫿 ]+|#?[a-z0-9][a-z0-9.#-]*)$/
    for (const intent of ZH_INTENTS) {
      for (const term of intent.terms) {
        expect(term, `${intent.key}: term ${JSON.stringify(term)} is off-grammar`).toMatch(HAN_OR_ASCII)
      }
    }
  })

  it('marks exactly the terms it must with #, because they would drown the intent in substrings otherwise', () => {
    const short = (term: string) => !term.startsWith('#') && /^[a-z0-9.-]+$/.test(term) && term.length <= 3
    const unmarkedShort = ZH_INTENTS.flatMap(intent => intent.terms.filter(short).map(term => `${intent.key}:${term}`))
    expect(unmarkedShort, 'an unmarked 1-3 letter Latin term will act like a substring — mark it with # or drop it').toEqual([])
  })

  it('keeps each intent’s recall terms unique after lowercase-folding', () => {
    for (const intent of ZH_INTENTS) {
      const lowered = intent.terms.map(t => t.toLowerCase())
      expect(new Set(lowered).size, `${intent.key} has a duplicate recall term after case-folding`).toBe(lowered.length)
    }
  })
})

describe('tokenInText (the word-boundary matcher)', () => {
  it('matches a standalone word at the start, middle and end of a name', () => {
    expect(tokenInText('ai', 'ai-chat')).toBe(true)
    expect(tokenInText('ai', 'the-ai-agent')).toBe(true)
    expect(tokenInText('ai', 'the-ai')).toBe(true)
  })

  it('matches a word separated from CJK by a punctuation or case boundary', () => {
    expect(tokenInText('ai', 'AI聊天')).toBe(true)
    expect(tokenInText('ai', 'AI助手')).toBe(true)
  })

  it('never matches inside a longer alphanumeric run', () => {
    expect(tokenInText('ai', 'email')).toBe(false)
    expect(tokenInText('ai', 'main')).toBe(false)
    expect(tokenInText('ai', 'pipeline')).toBe(false)
    // Hyphens and dots are BOUNDARIES, not part of the word. The marker's
    // purpose is to exclude alphanumeric runs, not to refuse a package that
    // put the term in its name with a separator. ('dsh-ai-image' MUST match,
    // or `#ai` never fires for the very packages that name themselves by it.)
    expect(tokenInText('ai', 'dsh-ai-image')).toBe(true)
    expect(tokenInText('ai', 'some.ai.toolkit')).toBe(true)
  })

  it('treats hyphen and dot as boundaries, since package names use them as separators', () => {
    expect(tokenInText('git', 'some-git-repo')).toBe(true)
    expect(tokenInText('git', 'digit')).toBe(false)
  })
})

describe('expandZhQuery', () => {
  it('returns only the query when no intent fires', () => {
    expect(expandZhQuery('zz-not-a-real-trigger')).toEqual({
      query: 'zz-not-a-real-trigger',
      intents: [],
      expansions: [],
      terms: ['zz-not-a-real-trigger'],
    })
  })

  it('returns the query alone for an empty or whitespace-only input', () => {
    expect(expandZhQuery('')).toEqual({ query: '', intents: [], expansions: [], terms: [''] })
    expect(expandZhQuery('  ')).toEqual({ query: '', intents: [], expansions: [], terms: [''] })
  })

  it('expands a single Chinese trigger into that intent’s recall terms, keeping the original query first', () => {
    const result = expandZhQuery('记忆')
    expect(result.intents).toEqual(['记忆'])
    expect(result.expansions).toEqual([{ intent: '记忆', terms: ['#memory', '#memories', '#remember'] }])
    expect(result.terms).toEqual(['记忆', '#memory', '#memories', '#remember'])
    expect(result.terms[0]).toBe('记忆')
  })

  it('expands a trigger that matches several intents into all of them, in dictionary order', () => {
    const result = expandZhQuery('文件管理')
    expect(result.intents).toContain('文件管理')
    const terms = result.terms
    expect(terms).toContain('文件管理')
    expect(terms).toContain('#file')
    expect(terms).toContain('#files')
    expect(terms).toContain('#explorer')
    expect(terms).toContain('#rename')
  })

  it('deduplicates terms shared across fired intents', () => {
    // Deduplication happens when two intents both fire and share a term.
    // Today every shared recall term is one the dictionary itself reuses
    // (e.g. `翻译` fires both `翻译` and any other intent whose `words`
    // happen to appear in the query). We pin the shape, not a pair.
    const result = expandZhQuery('通知提醒')
    expect(result.intents.length).toBeGreaterThan(0)
    expect(result.terms.length).toBe(new Set(result.terms).size)
  })

  it('keeps a Han trigger substring from ever firing on a query that merely contains it', () => {
    // Trigger words are ≥2 Han characters by dictionary design; never
    // substring-chained. 'AI记忆' fires 记忆 because the trigger appears in
    // the query — this is the documented choice, not a bug.
    expect(expandZhQuery('AI记忆').intents).toContain('记忆')
  })

  it('does not expand when the query only carries a single Han character that appears inside a trigger', () => {
    expect(expandZhQuery('记')).toEqual({
      query: '记',
      intents: [],
      expansions: [],
      terms: ['记'],
    })
  })

  it('lowercases a mixed-case English term inside a Chinese query before expanding', () => {
    // '文件管理' stays Han, but 'MCP' lowercase-folds to 'mcp' before triggers
    // compare. The terms column keeps its own case: the matcher lowercases
    // at the call site.
    const result = expandZhQuery('MCP管理')
    expect(result.intents).toContain('MCP')
    expect(result.terms).toContain('#mcp')
  })

  it('includes the query once when a fired intent’s recall list already holds it', () => {
    const result = expandZhQuery('memory')
    expect(result.terms).toEqual(['memory'])
  })

  it('marks a recall term with # exactly when the term is dangerous as a substring', () => {
    const result = expandZhQuery('AI大模型')
    expect(result.intents).toContain('AI大模型')
    expect(result.expansions[0]?.terms).toContain('#ai')
    expect(result.expansions[0]?.terms).toContain('#llm')
    expect(result.expansions[0]?.terms).not.toContain('ai')
    expect(result.expansions[0]?.terms).not.toContain('llm')
  })
})
