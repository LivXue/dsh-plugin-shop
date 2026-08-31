import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadRegistryConfig, parseRegistryConfig, serializeFirstSeen } from '../src/config.ts'

const empty = {
  verified: '[]', denied: '[]', allowedSimilar: '[]', categories: '[]', firstSeen: '[]',
}

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
    expect(config.denied.get('dsh-evil-plugin')).toEqual({ reason: 'Exfiltrates credentials.' })
  })

  it('parses a denied entry with a known replacement', () => {
    const config = parseRegistryConfig({
      ...empty,
      denied: `
- name: dsh-evil-plugin
  reason: Exfiltrates credentials.
  replacement: dsh-good-plugin
`,
    })
    expect(config.denied.get('dsh-evil-plugin')).toEqual({
      reason: 'Exfiltrates credentials.',
      replacement: 'dsh-good-plugin',
    })
  })

  it('parses allowed-similar names', () => {
    const config = parseRegistryConfig({ ...empty, allowedSimilar: '- dsh-fs-tools\n' })
    expect(config.allowedSimilar.has('dsh-fs-tools')).toBe(true)
  })

  it('throws on a verified entry with none of the three pins', () => {
    expect(() => parseRegistryConfig({
      ...empty,
      verified: '- name: dsh-hello-plugin\n  reviewer: github:someone\n  reviewCommit: abc\n',
    })).toThrow(/reviewedVersion.*reviewedCommit.*reviewedSha256/)
  })

  it('accepts a verified entry pinned by commit for a repository', () => {
    const config = parseRegistryConfig({
      ...empty,
      verified: '- name: dsh-hello-plugin\n  reviewedCommit: abc123def\n  reviewer: github:someone\n  reviewCommit: abc\n',
    })
    expect(config.verified.get('dsh-hello-plugin')?.reviewedCommit).toBe('abc123def')
  })

  it('accepts a verified entry pinned by tarball sha256 for a release-rescued entry', () => {
    const config = parseRegistryConfig({
      ...empty,
      verified: `- name: dsh-hello-plugin\n  reviewedSha256: ${'a'.repeat(64)}\n  reviewer: github:someone\n  reviewCommit: abc\n`,
    })
    expect(config.verified.get('dsh-hello-plugin')?.reviewedSha256).toBe('a'.repeat(64))
  })

  it('throws on a denied entry with no reason', () => {
    expect(() => parseRegistryConfig({ ...empty, denied: '- name: dsh-evil-plugin\n' }))
      .toThrow(/reason/)
  })

  it('throws on a denied entry whose replacement is not a string', () => {
    expect(() => parseRegistryConfig({
      ...empty,
      denied: '- name: dsh-evil-plugin\n  reason: Bad.\n  replacement: 42\n',
    })).toThrow(/replacement/)
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

  it('parses first-seen rows, including quoted scoped names', () => {
    const config = parseRegistryConfig({
      ...empty,
      firstSeen: '- name: dsh-hello-plugin\n  added: 2026-08-10\n- name: "@scope/dsh-a"\n  added: 2026-08-12\n',
    })
    expect(config.firstSeen.get('dsh-hello-plugin')).toBe('2026-08-10')
    expect(config.firstSeen.get('@scope/dsh-a')).toBe('2026-08-12')
  })

  it('throws on a duplicate name in first-seen.yml instead of silently keeping the last row', () => {
    expect(() => parseRegistryConfig({
      ...empty,
      firstSeen: '- name: dsh-hello-plugin\n  added: 2026-08-10\n- name: dsh-hello-plugin\n  added: 2026-08-11\n',
    })).toThrow(/first-seen\.yml.*duplicate entry for dsh-hello-plugin/s)
  })

  it('throws on a malformed added date', () => {
    expect(() => parseRegistryConfig({
      ...empty,
      firstSeen: '- name: dsh-hello-plugin\n  added: not-a-date\n',
    })).toThrow(/first-seen\.yml/)
  })

  it('throws when the file is not a list', () => {
    expect(() => parseRegistryConfig({ ...empty, firstSeen: 'name: x\n' })).toThrow(/list/)
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

describe('serializeFirstSeen', () => {
  it('quotes every name — scoped names would break unquoted — and sorts rows by name', () => {
    const text = serializeFirstSeen(new Map([
      ['dsh-b', '2026-08-01'],
      ['@scope/dsh-a', '2026-08-02'],
    ]))
    expect(text).toBe([
      '# First catalog appearance per package name (YYYY-MM-DD). Appended by the daily build;',
      '# a name absent here is simply "first seen today".',
      '- name: "@scope/dsh-a"',
      '  added: 2026-08-02',
      '- name: "dsh-b"',
      '  added: 2026-08-01',
      '',
    ].join('\n'))
  })

  it('serializes an empty map as an empty list under the header', () => {
    expect(serializeFirstSeen(new Map())).toBe([
      '# First catalog appearance per package name (YYYY-MM-DD). Appended by the daily build;',
      '# a name absent here is simply "first seen today".',
      '[]',
      '',
    ].join('\n'))
  })

  it('round-trips through parseRegistryConfig', () => {
    const rows = new Map([['@scope/dsh-a', '2026-08-02'], ['dsh-b', '2026-08-01']])
    const config = parseRegistryConfig({ ...empty, firstSeen: serializeFirstSeen(rows) })
    expect([...config.firstSeen]).toEqual([['@scope/dsh-a', '2026-08-02'], ['dsh-b', '2026-08-01']])
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

  it('treats a missing first-seen.yml as empty', () => {
    const dir = mkdtempSync(join(tmpdir(), 'first-seen-config-'))
    try {
      for (const f of ['verified.yml', 'denied.yml', 'allowed-similar.yml']) writeFileSync(join(dir, f), '[]\n')
      const config = loadRegistryConfig(dir)
      expect(config.firstSeen.size).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
