import { describe, expect, it } from 'vitest'
import { gate } from '../src/gate.ts'
import { parseRegistryConfig } from '../src/config.ts'
import type { Candidate } from '../src/types.ts'

const config = parseRegistryConfig({
  verified: '- name: dsh-fs-tool\n  reviewedVersion: 1.0.0\n  reviewer: github:r\n  reviewCommit: abc\n',
  denied: '- name: dsh-evil-plugin\n  reason: Exfiltrates credentials.\n',
  allowedSimilar: '- dsh-fs-tools\n',
  categories: '[]',
})

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
    ...overrides,
  }
}

const withCategories = (rows: Record<string, string>): ReturnType<typeof parseRegistryConfig> =>
  parseRegistryConfig({
    verified: '- name: dsh-fs-tool\n  reviewedVersion: 1.0.0\n  reviewer: github:r\n  reviewCommit: abc\n',
    denied: '- name: dsh-evil-plugin\n  reason: Exfiltrates credentials.\n',
    allowedSimilar: '- dsh-fs-tools\n',
    categories: Object.keys(rows).length === 0 ? '[]' : Object.entries(rows).map(([name, category]) => `- name: ${name}\n  category: ${category}\n`).join(''),
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

  it('rejects a denied package and quotes the reason', () => {
    const result = gate(candidate({ name: 'dsh-evil-plugin' }), config)
    if (result.ok) throw new Error('expected rejection')
    expect(result.rejection.code).toBe('denied')
    expect(result.rejection.detail).toContain('Exfiltrates credentials.')
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
    })
    const result = gate(candidate({ name: 'dsh-fs-too1' }), denied)
    if (result.ok) throw new Error('expected rejection')
    expect(result.rejection.code).toBe('denied')
  })
})
