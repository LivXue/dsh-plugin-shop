import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseCatalogSection } from '../src/schema.ts'
import { renderJsonSchema } from '../src/emit-schema.ts'

const valid = {
  category: 'tool',
  summary: { en: 'Does a thing', zh: '做一件事' },
  capabilities: ['fs', 'shell'],
}

describe('parseCatalogSection', () => {
  it('accepts a complete section', () => {
    const result = parseCatalogSection(valid)
    expect(result).toEqual({ ok: true, value: valid })
  })

  it('rejects an unknown category', () => {
    const result = parseCatalogSection({ ...valid, category: 'plugin' })
    expect(result.ok).toBe(false)
  })

  it('rejects a summary missing zh', () => {
    const result = parseCatalogSection({ ...valid, summary: { en: 'x' } })
    expect(result.ok).toBe(false)
  })

  it('rejects an empty summary string', () => {
    const result = parseCatalogSection({ ...valid, summary: { en: '', zh: '做一件事' } })
    expect(result.ok).toBe(false)
  })

  it('reports an author-readable path on failure', () => {
    const result = parseCatalogSection({ ...valid, category: 'plugin' })
    if (result.ok) throw new Error('expected failure')
    expect(result.error).toContain('category')
  })
})

describe('published JSON Schema', () => {
  it('matches the committed file', () => {
    const committed = readFileSync('registry/schema/plugin-entry.schema.json', 'utf8')
    expect(committed).toBe(renderJsonSchema())
  })
})
