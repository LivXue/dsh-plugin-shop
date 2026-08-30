import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadRegistryConfig, parseRegistryConfig } from '../src/config.ts'

const empty = { verified: '[]', denied: '[]', allowedSimilar: '[]', categories: '[]' }

describe('parseRegistryConfig', () => {
  it('parses empty files', () => {
    const config = parseRegistryConfig(empty)
    expect(config.verified.size).toBe(0)
    expect(config.denied.size).toBe(0)
    expect(config.allowedSimilar.size).toBe(0)
  })

  it('parses a verified entry', () => {
    const config = parseRegistryConfig({
      ...empty,
      verified: `
- name: dsh-hello-plugin
  reviewedVersion: 1.2.0
  reviewer: github:someone
  reviewCommit: abc1234
  notes: fine
`,
    })
    expect(config.verified.get('dsh-hello-plugin')).toEqual({
      reviewedVersion: '1.2.0',
      reviewer: 'github:someone',
      reviewCommit: 'abc1234',
      notes: 'fine',
    })
  })

  it('parses a denied entry with its reason', () => {
    const config = parseRegistryConfig({
      ...empty,
      denied: `
- name: dsh-evil-plugin
  reason: Exfiltrates credentials.
`,
    })
    expect(config.denied.get('dsh-evil-plugin')).toBe('Exfiltrates credentials.')
  })

  it('parses allowed-similar names', () => {
    const config = parseRegistryConfig({ ...empty, allowedSimilar: '- dsh-fs-tools\n' })
    expect(config.allowedSimilar.has('dsh-fs-tools')).toBe(true)
  })

  it('throws on a verified entry with neither a version nor a commit pin', () => {
    expect(() => parseRegistryConfig({
      ...empty,
      verified: '- name: dsh-hello-plugin\n  reviewer: github:someone\n  reviewCommit: abc\n',
    })).toThrow(/reviewedVersion|reviewedCommit/)
  })

  it('accepts a verified entry pinned by commit for a repository', () => {
    const config = parseRegistryConfig({
      ...empty,
      verified: '- name: dsh-hello-plugin\n  reviewedCommit: abc123def\n  reviewer: github:someone\n  reviewCommit: abc\n',
    })
    expect(config.verified.get('dsh-hello-plugin')?.reviewedCommit).toBe('abc123def')
  })

  it('throws on a denied entry with no reason', () => {
    expect(() => parseRegistryConfig({ ...empty, denied: '- name: dsh-evil-plugin\n' }))
      .toThrow(/reason/)
  })

  it('throws when a file is not a list', () => {
    expect(() => parseRegistryConfig({ ...empty, denied: 'name: x\n' })).toThrow(/list/)
  })

  it('throws on a duplicate name in verified.yml instead of silently keeping the last entry', () => {
    expect(() => parseRegistryConfig({
      ...empty,
      verified: `
- name: dsh-hello-plugin
  reviewedVersion: 1.0.0
  reviewer: github:someone
  reviewCommit: abc1234
- name: dsh-hello-plugin
  reviewedVersion: 2.0.0
  reviewer: github:someone-else
  reviewCommit: def5678
`,
    })).toThrow(/verified\.yml.*dsh-hello-plugin/s)
  })

  it('throws on a duplicate name in denied.yml instead of silently keeping the last entry', () => {
    expect(() => parseRegistryConfig({
      ...empty,
      denied: `
- name: dsh-evil-plugin
  reason: Exfiltrates credentials.
- name: dsh-evil-plugin
  reason: Also does something else bad.
`,
    })).toThrow(/denied\.yml.*dsh-evil-plugin/s)
  })

  it('allows a duplicate name in allowed-similar.yml, treating it as a set', () => {
    const config = parseRegistryConfig({ ...empty, allowedSimilar: '- dsh-fs-tools\n- dsh-fs-tools\n' })
    expect(config.allowedSimilar.size).toBe(1)
  })
})

describe('parseRegistryConfig categories', () => {
  it('parses assigned categories', () => {
    const config = parseRegistryConfig({
      ...empty,
      categories: '- name: dsh-hello-plugin\n  category: tool\n- name: dsh-open-app\n  category: integration\n',
    })
    expect(config.categories.get('dsh-hello-plugin')).toBe('tool')
    expect(config.categories.get('dsh-open-app')).toBe('integration')
  })

  it('throws on an unknown category value', () => {
    expect(() => parseRegistryConfig({
      ...empty,
      categories: '- name: dsh-hello-plugin\n  category: wizardry\n',
    })).toThrow(/categories\.yml/)
  })

  it('throws on a duplicate name', () => {
    expect(() => parseRegistryConfig({
      ...empty,
      categories: '- name: dsh-hello-plugin\n  category: tool\n- name: dsh-hello-plugin\n  category: ui\n',
    })).toThrow(/duplicate entry for dsh-hello-plugin/)
  })

  it('throws when the file is not a list', () => {
    expect(() => parseRegistryConfig({ ...empty, categories: 'name: x\n' })).toThrow(/list/)
  })
})

describe('loadRegistryConfig', () => {
  it('treats a missing categories.yml as empty', () => {
    const dir = mkdtempSync(join(tmpdir(), 'categories-config-'))
    try {
      for (const f of ['verified.yml', 'denied.yml', 'allowed-similar.yml']) writeFileSync(join(dir, f), '[]\n')
      const config = loadRegistryConfig(dir)
      expect(config.categories.size).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
