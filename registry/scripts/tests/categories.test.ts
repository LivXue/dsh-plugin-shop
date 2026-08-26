import { describe, expect, it } from 'vitest'
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
  it('writes sorted rows with the standing header', () => {
    const text = serializeCategoryRows(new Map([['dsh-beta', 'ui'], ['dsh-alpha', 'tool']]))
    expect(text).toBe(
      '# LLM-assigned categories for derived listings (design 2026-08-26-llm-categorization-design.md).\n'
      + '# A declared `dsh.catalog.category` always wins; a name absent from this file is simply\n'
      + '# "not yet classified" and is retried on the next build.\n'
      + '- name: dsh-alpha\n'
      + '  category: tool\n'
      + '- name: dsh-beta\n'
      + '  category: ui\n',
    )
  })
})
