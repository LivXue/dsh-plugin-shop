import { describe, expect, it } from 'vitest'
import { parseRegistryConfig } from '../src/config.ts'

const empty = { verified: '[]', denied: '[]', allowedSimilar: '[]' }

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

  it('throws on a verified entry missing reviewedVersion', () => {
    expect(() => parseRegistryConfig({
      ...empty,
      verified: '- name: dsh-hello-plugin\n  reviewer: github:someone\n',
    })).toThrow(/reviewedVersion/)
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
