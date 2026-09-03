import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { CATALOG_ERROR_MAX_LENGTH, parseCatalogSection } from '../src/schema.ts'
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

  it('rejects a capability item past the published bound', () => {
    // `capabilities` capped the COUNT at 20 and not the item length, so one
    // package with 20 one-megabyte strings is 20 MB of a file every reader
    // downloads. Through the real toCandidate -> gate -> emit path, 1 MB
    // strings produced a 203 MB plugins.json.
    const result = parseCatalogSection({ ...valid, capabilities: ['x'.repeat(65)] })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('capabilities')
  })

  it('accepts a capability item at the bound', () => {
    expect(parseCatalogSection({ ...valid, capabilities: ['x'.repeat(64)] }).ok).toBe(true)
  })
})

describe('the composed error is itself a bounded published field', () => {
  // This error becomes a rejection `detail`, which emit.ts writes into
  // dist/v1/report.md, which daily.yml publishes to Pages. zod's
  // `unrecognized_keys` message ECHOES the offending key, so the one field
  // left unbounded by the capabilities/license/repository work was the reason
  // string explaining the bounds. Measured through the real parser, a
  // 200,000-character key produced a 200,040-character detail.

  it('bounds the detail when zod echoes a hostile key back into it', () => {
    const result = parseCatalogSection({ ...valid, ['K'.repeat(200000)]: 1 })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.length).toBeLessThanOrEqual(CATALOG_ERROR_MAX_LENGTH)
    // Still names the field it is about, so the author can act on it.
    expect(result.error.startsWith('dsh.catalog.(root): Unrecognized key:')).toBe(true)
    // And says it was cut, so a fragment is not read as the whole reason.
    expect(result.error).toContain('truncated')
  })

  it('leaves a message of exactly 200 characters untouched', () => {
    // Literals on purpose. The detail is a 40-character frame around the
    // echoed key -- `dsh.catalog.(root): Unrecognized key: "` is 39 and the
    // closing quote is 1 -- so 160 + 40 = 200, the bound exactly. Deriving the
    // key length from CATALOG_ERROR_MAX_LENGTH instead would move the fixture
    // with the constant, and lowering the constant to 199 would then still
    // pass: verified by mutation, that is precisely what happened.
    const key = 'K'.repeat(160)
    const result = parseCatalogSection({ ...valid, [key]: 1 })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(CATALOG_ERROR_MAX_LENGTH).toBe(200)
    expect(result.error.length).toBe(200)
    expect(result.error).toBe(`dsh.catalog.(root): Unrecognized key: "${key}"`)
    expect(result.error).not.toContain('truncated')
  })

  it('leaves every legitimate message byte-identical, marker included', () => {
    // The real messages measure 45-117 characters. Two properties at once:
    // none is truncated, and — the good news this must not regress — the
    // messages for the bounded fields do not echo the offending value, so
    // bounding those fields did not create a second echo vector.
    const cases: [string, unknown, string][] = [
      ['over-long capability', { ...valid, capabilities: ['x'.repeat(65)] },
        'dsh.catalog.capabilities.0: Too big: expected string to have <=64 characters'],
      ['too many capabilities', { ...valid, capabilities: Array.from({ length: 21 }, () => 'c') },
        'dsh.catalog.capabilities: Too big: expected array to have <=20 items'],
      ['empty summary', { ...valid, summary: { en: '', zh: 'y' } },
        'dsh.catalog.summary.en: Too small: expected string to have >=1 characters'],
      ['missing translation', { ...valid, summary: { en: 'x' } },
        'dsh.catalog.summary.zh: Invalid input: expected string, received undefined'],
      ['unknown category', { ...valid, category: 'plugin' },
        'dsh.catalog.category: Invalid option: expected one of "tool"|"provider"|"ui"|"workflow"|"integration"|"theme"|"other"'],
      ['a short unrecognized key', { ...valid, extra: 1 },
        'dsh.catalog.(root): Unrecognized key: "extra"'],
      ['not an object at all', null,
        'dsh.catalog.(root): Invalid input: expected object, received null'],
    ]
    for (const [label, input, expected] of cases) {
      const result = parseCatalogSection(input)
      expect(result.ok, label).toBe(false)
      if (result.ok) continue
      expect(result.error, label).toBe(expected)
      expect(result.error.length, label).toBeLessThanOrEqual(CATALOG_ERROR_MAX_LENGTH)
      expect(result.error, label).not.toContain('truncated')
    }
  })
})

describe('published JSON Schema', () => {
  it('matches the committed file', () => {
    const committed = readFileSync('registry/schema/plugin-entry.schema.json', 'utf8')
    expect(committed).toBe(renderJsonSchema())
  })
})
