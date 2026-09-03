import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { mergeCategoryRows, serializeCategoryRows } from '../src/categories.ts'

describe('mergeCategoryRows', () => {
  it('keeps existing rows, adds fresh ones, and prunes dead names', () => {
    const merged = mergeCategoryRows(
      new Map([['dsh-old', 'tool'], ['dsh-gone', 'ui']]),
      new Map([['dsh-new', 'provider']]),
      new Set(['dsh-old', 'dsh-new']),
    )
    expect(merged.get('dsh-old')).toBe('tool')
    expect(merged.get('dsh-new')).toBe('provider')
    expect(merged.has('dsh-gone')).toBe(false)
  })

  it('sorts rows by name', () => {
    const merged = mergeCategoryRows(
      new Map([['dsh-zebra', 'ui']]),
      new Map([['dsh-alpha', 'tool']]),
      new Set(['dsh-zebra', 'dsh-alpha']),
    )
    expect([...merged.keys()]).toEqual(['dsh-alpha', 'dsh-zebra'])
  })
})

describe('serializeCategoryRows', () => {
  it('round-trips scoped package names through the YAML loader', async () => {
    const { parse } = await import('yaml')
    const text = serializeCategoryRows(new Map([['@scope/dsh-plugin', 'tool'], ['dsh-plain', 'ui']]))
    const parsed = parse(text) as { name: string; category: string }[]
    expect(parsed).toEqual([
      { name: '@scope/dsh-plugin', category: 'tool' },
      { name: 'dsh-plain', category: 'ui' },
    ])
  })


  it('writes sorted rows with the standing header', () => {
    const text = serializeCategoryRows(new Map([['dsh-beta', 'ui'], ['dsh-alpha', 'tool']]))
    expect(text).toBe(
      '# LLM-assigned categories for derived listings (design 2026-08-26-llm-categorization-design.md).\n'
      + '# A declared `dsh.catalog.category` always wins; a name absent from this file is simply\n'
      + '# "not yet classified" and is retried on the next build.\n'
      // Names are quoted since the scoped-name regression: an unquoted
      // `@scope/pkg` row cannot be parsed back by the YAML loader.
      + '- name: "dsh-alpha"\n'
      + '  category: tool\n'
      + '- name: "dsh-beta"\n'
      + '  category: ui\n',
    )
  })

  it('still writes a valid YAML list when there are no rows', () => {
    const text = serializeCategoryRows(new Map())
    expect(text).toBe(
      '# LLM-assigned categories for derived listings (design 2026-08-26-llm-categorization-design.md).\n'
      + '# A declared `dsh.catalog.category` always wins; a name absent from this file is simply\n'
      + '# "not yet classified" and is retried on the next build.\n'
      + '[]\n',
    )
    // The loader (config.ts) requires a YAML list; a comment-only document
    // parses to `null` and kills the next build. Parse with the same library.
    expect(parse(text)).toEqual([])
  })

  it('round-trips the four hostile-name probes through serialise then parse', () => {
    // GitHub manifest names are unrestricted and reach BOTH bot-written files.
    // The comment justifying `- name: "${name}"` claimed npm names never carry
    // `"` or `\` — true for npm, false for a repo manifest. Each probe below
    // was run against the real serialiser: the first is a YAMLParseError, the
    // second forges a second row and throws `duplicate entry for dsh-victim`,
    // the third parses with the name silently altered, the fourth parses as
    // `dsh-b` and overwrites another package's row.
    const probes = [
      'dsh-"quote',
      'dsh-a"\n  category: tool\n- name: "dsh-victim',
      'dsh-trailing\\',
      'dsh-b" # comment',
    ]
    const rows = new Map<string, 'tool'>(probes.map(name => [name, 'tool' as const]))
    const parsed = parse(serializeCategoryRows(rows)) as { name: string; category: string }[]
    expect(parsed).toHaveLength(4)
    expect(parsed.map(row => row.name).sort()).toEqual([...probes].sort())
    expect(parsed.every(row => row.category === 'tool')).toBe(true)
  })
})
