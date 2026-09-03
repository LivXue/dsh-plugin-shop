import { describe, expect, it } from 'vitest'
import { gate } from '../src/gate.ts'
import { parseRegistryConfig } from '../src/config.ts'
import type { Candidate } from '../src/types.ts'

const config = parseRegistryConfig({
  verified: '- name: dsh-fs-tool\n  reviewedVersion: 1.0.0\n  reviewer: github:r\n  reviewCommit: abc\n',
  denied: '- name: dsh-evil-plugin\n  reason: Exfiltrates credentials.\n',
  allowedSimilar: '- dsh-fs-tools\n',
  categories: '[]',
  firstSeen: '[]',
})

/** An unpaired UTF-16 surrogate: what a naive slice through an astral
 * character leaves behind. `test` is called on fresh strings only, so the
 * regex carries no /g state between assertions. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

function candidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    name: 'dsh-hello-plugin',
    version: '1.0.0',
    integrity: 'sha512-abc',
    publishedAt: '2026-08-01T12:00:00.000Z',
    repository: 'https://github.com/you/hello-plugin',
    license: 'MIT',
    deprecated: false,
    hasBundle: true,
    catalog: { category: 'tool', summary: { en: 'x', zh: 'y' }, capabilities: [] },
    description: 'A friendly hello-world plugin.',
    keywords: [],
    peers: [],
    ...overrides,
  }
}

const withCategories = (rows: Record<string, string>): ReturnType<typeof parseRegistryConfig> =>
  parseRegistryConfig({
    verified: '- name: dsh-fs-tool\n  reviewedVersion: 1.0.0\n  reviewer: github:r\n  reviewCommit: abc\n',
    denied: '- name: dsh-evil-plugin\n  reason: Exfiltrates credentials.\n',
    allowedSimilar: '- dsh-fs-tools\n',
    categories: Object.keys(rows).length === 0 ? '[]' : Object.entries(rows).map(([name, category]) => `- name: ${name}\n  category: ${category}\n`).join(''),
    firstSeen: '[]',
  })

describe('gate', () => {
  it('accepts a complete candidate and marks it declared', () => {
    const result = gate(candidate(), config)
    expect(result.ok).toBe(true)
    expect(result.ok && result.accepted.metadata).toBe('declared')
  })

  it('rejects a package with no dsh.bundle', () => {
    const result = gate(candidate({ hasBundle: false }), config)
    if (result.ok) throw new Error('expected rejection')
    expect(result.rejection.code).toBe('no-bundle')
    expect(result.rejection.detail).toContain('dsh.bundle')
  })

  it('derives a listing from the npm description when dsh.catalog is absent', () => {
    const result = gate(candidate({ catalog: undefined, description: 'Does a helpful thing.' }), config)
    if (!result.ok) throw new Error('expected acceptance')
    expect(result.accepted.metadata).toBe('derived')
    expect(result.accepted.catalog).toEqual({
      category: 'other',
      summary: { en: 'Does a helpful thing.' },
      capabilities: [],
    })
  })

  it('fills a derived listing with its LLM-assigned category', () => {
    const result = gate(
      candidate({ catalog: undefined, description: 'Does a helpful thing.' }),
      withCategories({ 'dsh-hello-plugin': 'tool' }),
    )
    if (!result.ok) throw new Error('expected acceptance')
    expect(result.accepted.metadata).toBe('derived')
    expect(result.accepted.catalog.category).toBe('tool')
  })

  it('defaults a derived listing without a row to other', () => {
    const result = gate(candidate({ catalog: undefined, description: 'Does a helpful thing.' }), withCategories({}))
    if (!result.ok) throw new Error('expected acceptance')
    expect(result.accepted.catalog.category).toBe('other')
  })

  it('never overrides a declared category', () => {
    // candidate() declares category: 'tool' (line 22); a provider row must not win
    const result = gate(candidate(), withCategories({ 'dsh-hello-plugin': 'provider' }))
    if (!result.ok) throw new Error('expected acceptance')
    expect(result.accepted.metadata).toBe('declared')
    expect(result.accepted.catalog.category).toBe('tool')
  })

  it('trims and caps a derived summary at 200 characters', () => {
    const description = `  ${'a'.repeat(210)}  `
    const result = gate(candidate({ catalog: null, description }), config)
    if (!result.ok) throw new Error('expected acceptance')
    expect(result.accepted.catalog.summary.en).toBe('a'.repeat(200))
  })

  it('never splits a surrogate pair when capping a derived summary', () => {
    // Scope, precisely: this pins that the CUT does not create an orphan, so
    // the astral character is dropped whole rather than halved. It is not what
    // keeps plugins.json free of unpaired surrogates — toWellFormedCatalog is,
    // at the projection boundary, and the three-route test below covers the
    // orphans that arrive by other means. Both exist because they do different
    // things: dropping a half-character reads better than publishing a
    // replacement character in the middle of a word.
    //
    // Why any of it matters, measured end to end: a lone surrogate leaves the
    // emitted JSON valid (JSON.stringify escapes it as \ud83d, so the file is
    // ASCII and the content hash is stable — which is why nothing here would
    // notice), but a consumer that parses that file and re-encodes UTF-8 fails
    // on it; Python raises "surrogates not allowed".
    // 199 filler + a 2-unit emoji puts the split exactly at the bound.
    const description = `${'a'.repeat(199)}\u{1F600}tail`
    const result = gate(candidate({ catalog: null, description }), config)
    if (!result.ok) throw new Error('expected acceptance')
    const en = result.accepted.catalog.summary.en
    expect(en).toMatch(/^a{199}$/)
    expect(LONE_SURROGATE.test(en)).toBe(false)
  })

  it('keeps an astral character that ends exactly at the cap', () => {
    // The complement, and the reason the fix drops a code unit rather than
    // always trimming one: 198 filler + a 2-unit emoji is exactly 200, a whole
    // pair, and it must survive intact.
    const description = `${'a'.repeat(198)}\u{1F600}tail`
    const result = gate(candidate({ catalog: null, description }), config)
    if (!result.ok) throw new Error('expected acceptance')
    const en = result.accepted.catalog.summary.en
    expect(en.length).toBe(200)
    expect(en.endsWith('\u{1F600}')).toBe(true)
    expect(LONE_SURROGATE.test(en)).toBe(false)
  })

  it('never splits a pair at either end of the surrogate range', () => {
    // The emoji above has the high surrogate 0xD83D, comfortably inside the
    // range, so it cannot tell 0xDBFF from 0xDBFE — verified by mutation, that
    // narrowing survived. These three pin both ends: U+10000 is the first
    // astral character (high 0xD800) and U+10FFFF the last (high 0xDBFF).
    for (const [label, codePoint] of [
      ['U+10000, high surrogate 0xD800', 0x10000],
      ['U+1F600, high surrogate 0xD83D', 0x1F600],
      ['U+10FFFF, high surrogate 0xDBFF', 0x10FFFF],
    ] as [string, number][]) {
      const description = `${'a'.repeat(199)}${String.fromCodePoint(codePoint)}tail`
      const result = gate(candidate({ catalog: null, description }), config)
      expect(result.ok, label).toBe(true)
      if (!result.ok) continue
      const en = result.accepted.catalog.summary.en
      expect(en, label).toMatch(/^a{199}$/)
      expect(LONE_SURROGATE.test(en), label).toBe(false)
    }
  })

  it('rejects a package with neither dsh.catalog nor an npm description as no-summary', () => {
    const result = gate(candidate({ catalog: undefined, description: null }), config)
    if (result.ok) throw new Error('expected rejection')
    expect(result.rejection.code).toBe('no-summary')
  })

  it('rejects a package whose description is blank as no-summary', () => {
    const result = gate(candidate({ catalog: null, description: '   ' }), config)
    if (result.ok) throw new Error('expected rejection')
    expect(result.rejection.code).toBe('no-summary')
  })

  it('rejects an invalid dsh.catalog and names the offending field, never falling back to derived', () => {
    const result = gate(candidate({ catalog: { category: 'nope' } }), config)
    if (result.ok) throw new Error('expected rejection')
    expect(result.rejection.code).toBe('invalid-catalog')
    expect(result.rejection.detail).toContain('category')
  })

  it('rejects a denied package and quotes the reason, carrying no replacement when none is recorded', () => {
    const result = gate(candidate({ name: 'dsh-evil-plugin' }), config)
    if (result.ok) throw new Error('expected rejection')
    expect(result.rejection.code).toBe('denied')
    expect(result.rejection.detail).toBe('Denied by the registry: Exfiltrates credentials.')
    expect(result.rejection.replacement).toBeUndefined()
  })

  it('names the recorded replacement in the detail of a denied package', () => {
    const denied = parseRegistryConfig({
      verified: '- name: dsh-fs-tool\n  reviewedVersion: 1.0.0\n  reviewer: github:r\n  reviewCommit: abc\n',
      denied: '- name: dsh-evil-plugin\n  reason: Exfiltrates credentials.\n  replacement: dsh-good-plugin\n',
      allowedSimilar: '[]',
      categories: '[]',
      firstSeen: '[]',
    })
    const result = gate(candidate({ name: 'dsh-evil-plugin' }), denied)
    if (result.ok) throw new Error('expected rejection')
    expect(result.rejection.code).toBe('denied')
    expect(result.rejection.detail)
      .toBe('Denied by the registry: Exfiltrates credentials. Known replacement: dsh-good-plugin.')
    expect(result.rejection.replacement).toBe('dsh-good-plugin')
  })

  it('rejects a deprecated package', () => {
    const result = gate(candidate({ deprecated: true }), config)
    if (result.ok) throw new Error('expected rejection')
    expect(result.rejection.code).toBe('deprecated')
  })

  it('rejects a package with no license', () => {
    const result = gate(candidate({ license: null }), config)
    if (result.ok) throw new Error('expected rejection')
    expect(result.rejection.code).toBe('no-license')
  })

  it('rejects a package with no repository and says why that matters', () => {
    const result = gate(candidate({ repository: null }), config)
    if (result.ok) throw new Error('expected rejection')
    expect(result.rejection.code).toBe('no-repository')
    expect(result.rejection.detail).toContain('audit')
  })

  it('rejects a repository naming the harness itself, which holds none of the plugin source', () => {
    const result = gate(candidate({ repository: 'https://github.com/deepseek-ai/deepseek-harness' }), config)
    if (result.ok) throw new Error('expected rejection')
    expect(result.rejection.code).toBe('harness-repository')
    expect(result.rejection.detail).toContain('deepseek-harness')
  })

  it('rejects the harness repository even with a trailing slash', () => {
    const result = gate(candidate({ repository: 'https://github.com/deepseek-ai/deepseek-harness/' }), config)
    if (result.ok) throw new Error('expected rejection')
    expect(result.rejection.code).toBe('harness-repository')
  })

  it('rejects the harness repository regardless of letter case', () => {
    // GitHub resolves repo URLs case-insensitively, so a casing variant of
    // the same URL is still the host project, not the plugin's source.
    const result = gate(candidate({ repository: 'https://github.com/DEEPSEEK-AI/DEEPSEEK-HARNESS' }), config)
    if (result.ok) throw new Error('expected rejection')
    expect(result.rejection.code).toBe('harness-repository')
  })

  it('keeps a repository whose own name merely contains deepseek-harness', () => {
    const result = gate(candidate({ repository: 'https://github.com/syncended/deepseek-harness-automations' }), config)
    expect(result.ok).toBe(true)
  })

  it('rejects a package with no integrity', () => {
    const result = gate(candidate({ integrity: null }), config)
    if (result.ok) throw new Error('expected rejection')
    expect(result.rejection.code).toBe('no-integrity')
  })

  it('rejects a package with no publication time under its own code', () => {
    const result = gate(candidate({ publishedAt: null }), config)
    if (result.ok) throw new Error('expected rejection')
    expect(result.rejection.code).toBe('no-publish-time')
  })

  it('holds a name one edit away from a verified name', () => {
    const result = gate(candidate({ name: 'dsh-fs-too1' }), config)
    if (result.ok) throw new Error('expected rejection')
    expect(result.rejection.code).toBe('name-too-similar')
    expect(result.rejection.detail).toContain('dsh-fs-tool')
  })

  it('holds a name two edits away from a verified name', () => {
    const result = gate(candidate({ name: 'dsh-fs-t00l' }), config)
    if (result.ok) throw new Error('expected rejection')
    expect(result.rejection.code).toBe('name-too-similar')
  })

  it('admits a name three edits away', () => {
    expect(gate(candidate({ name: 'dsh-fs-t001' }), config).ok).toBe(true)
  })

  it('admits the verified name itself, which is distance zero', () => {
    expect(gate(candidate({ name: 'dsh-fs-tool' }), config).ok).toBe(true)
  })

  it('admits a similar name cleared in allowed-similar', () => {
    expect(gate(candidate({ name: 'dsh-fs-tools' }), config).ok).toBe(true)
  })

  it('checks denial before similarity, so a denied lookalike reports denial', () => {
    const denied = parseRegistryConfig({
      verified: '- name: dsh-fs-tool\n  reviewedVersion: 1.0.0\n  reviewer: r\n  reviewCommit: c\n',
      denied: '- name: dsh-fs-too1\n  reason: Typosquat.\n',
      allowedSimilar: '[]',
      categories: '[]',
      firstSeen: '[]',
    })
    const result = gate(candidate({ name: 'dsh-fs-too1' }), denied)
    if (result.ok) throw new Error('expected rejection')
    expect(result.rejection.code).toBe('denied')
  })
})

describe('the shop excludes itself', () => {
  // The shop is a dsh plugin and its package.json now carries both harvest
  // keywords, exactly as it asks plugin authors to. That makes it a candidate
  // in its own catalog: `gate.ts` has no build-script or workspace-deps check
  // (those live in repo-gate.ts), so nothing else here would stop it. Only the
  // client's shop-like NAME filter would, and that hides it from the shelf
  // while still counting it in the data — the discrepancy that filter's own
  // history is a record of. Excluded at the gate instead, with a reason.

  it('rejects its own npm package rather than listing itself', () => {
    const result = gate(candidate({ name: 'dsh-plugin-shop' }), config)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.rejection.code).toBe('self')
    expect(result.rejection.detail).toMatch(/the shop itself/i)
    expect(result.rejection.detail).toMatch(/dsh plugin add/)
  })

  it('rejects the catalog package it publishes alongside itself', () => {
    const result = gate(candidate({ name: 'dsh-plugin-shop-catalog' }), config)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.rejection.code).toBe('self')
  })

  it('does not reject someone else whose name merely contains ours', () => {
    // Exact names only. A fork, a scoped republish or a near-miss is somebody
    // else's package: it gets judged on its merits, and the shop-like name
    // filter is what keeps a competing market off the shelf.
    for (const name of ['dsh-plugin-shop-fork', '@someone/dsh-plugin-shop', 'my-dsh-plugin-shop']) {
      const result = gate(candidate({ name }), config)
      expect(result.ok, `${name} must not be excluded as self`).toBe(true)
    }
  })
})

describe('field length bounds', () => {
  it('rejects an over-long license with a reason that is about its length', () => {
    // Not "Declares no license." — the author declared one and it is 1 MB. A
    // wrong published reason is a defect, not a wording nit.
    const result = gate(candidate({ license: 'M'.repeat(129) }), config)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.rejection.code).toBe('no-license')
      expect(result.rejection.detail).toBe('Declares a license string longer than 128 characters, so it is not an SPDX identifier.')
    }
  })

  it('rejects an over-long repository with a reason that is about its length', () => {
    const result = gate(candidate({ repository: `https://github.com/you/${'x'.repeat(512)}` }), config)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.rejection.code).toBe('no-repository')
      expect(result.rejection.detail).toBe('Declares a repository URL longer than 512 characters, so it cannot be audited as a source location.')
    }
  })

  it('accepts a license and a repository at the bounds', () => {
    expect(gate(candidate({ license: 'M'.repeat(128) }), config).ok).toBe(true)
    expect(gate(candidate({ repository: `https://h/${'x'.repeat(502)}` }), config).ok).toBe(true)
  })
})
