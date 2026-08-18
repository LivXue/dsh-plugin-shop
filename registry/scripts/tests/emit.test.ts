import { describe, expect, it } from 'vitest'
import { emit, SCHEMA_VERSION } from '../src/emit.ts'
import type { Entry } from '../src/types.ts'

function entry(name: string, version = '1.0.0'): Entry {
  return {
    name, version, integrity: `sha512-${name}`, publishedAt: '2026-08-01T12:00:00.000Z',
    repository: `https://github.com/you/${name}`, license: 'MIT', tier: 'community',
    catalog: { category: 'tool', summary: { en: 'x', zh: 'y' }, capabilities: [] },
  }
}

describe('emit', () => {
  it('sorts entries by package name', () => {
    const { pluginsJson } = emit([entry('dsh-b'), entry('dsh-a')], [], '2026-08-18T00:00:00.000Z')
    const parsed = JSON.parse(pluginsJson) as { plugins: { name: string }[] }
    expect(parsed.plugins.map(p => p.name)).toEqual(['dsh-a', 'dsh-b'])
  })

  it('omits builtAt from the hashed content', () => {
    const a = emit([entry('dsh-a')], [], '2026-08-18T00:00:00.000Z')
    const b = emit([entry('dsh-a')], [], '2027-01-01T00:00:00.000Z')
    expect(a.pluginsJson).toBe(b.pluginsJson)
    expect(a.pluginsFileName).toBe(b.pluginsFileName)
  })

  it('puts builtAt in the index', () => {
    const { indexJson } = emit([entry('dsh-a')], [], '2026-08-18T00:00:00.000Z')
    expect(JSON.parse(indexJson)).toMatchObject({ builtAt: '2026-08-18T00:00:00.000Z', count: 1 })
  })

  it('names the plugins file by the hash of its content', () => {
    const { pluginsFileName, pluginsJson, indexJson } = emit([entry('dsh-a')], [], '2026-08-18T00:00:00.000Z')
    const index = JSON.parse(indexJson) as { plugins: { url: string; sha256: string } }
    expect(pluginsFileName).toBe(`plugins.${index.plugins.sha256}.json`)
    expect(index.plugins.url).toBe(pluginsFileName)
    expect(pluginsJson.length).toBeGreaterThan(0)
  })

  it('changes the hash when an entry changes', () => {
    const a = emit([entry('dsh-a', '1.0.0')], [], '2026-08-18T00:00:00.000Z')
    const b = emit([entry('dsh-a', '1.0.1')], [], '2026-08-18T00:00:00.000Z')
    expect(a.pluginsFileName).not.toBe(b.pluginsFileName)
  })

  it('stamps the schema version on both files', () => {
    const { pluginsJson, indexJson } = emit([entry('dsh-a')], [], '2026-08-18T00:00:00.000Z')
    expect(JSON.parse(pluginsJson).schemaVersion).toBe(SCHEMA_VERSION)
    expect(JSON.parse(indexJson).schemaVersion).toBe(SCHEMA_VERSION)
  })

  it('writes a sorted manifest lock of name, version, and integrity', () => {
    const { manifestLock } = emit([entry('dsh-b'), entry('dsh-a')], [], '2026-08-18T00:00:00.000Z')
    expect(manifestLock).toBe('dsh-a 1.0.0 sha512-dsh-a\ndsh-b 1.0.0 sha512-dsh-b\n')
  })

  it('lists every rejection with its code and reason in the report', () => {
    const { report } = emit([], [
      { name: 'dsh-x', code: 'no-bundle', detail: 'Declares no dsh.bundle.' },
    ], '2026-08-18T00:00:00.000Z')
    expect(report).toContain('dsh-x')
    expect(report).toContain('no-bundle')
    expect(report).toContain('Declares no dsh.bundle.')
  })

  it('sorts rejections by name so the report diffs cleanly', () => {
    const { report } = emit([], [
      { name: 'dsh-z', code: 'deprecated', detail: 'a' },
      { name: 'dsh-a', code: 'deprecated', detail: 'b' },
    ], '2026-08-18T00:00:00.000Z')
    expect(report.indexOf('dsh-a')).toBeLessThan(report.indexOf('dsh-z'))
  })

  it('ends every text artifact with exactly one newline', () => {
    const { pluginsJson, indexJson, manifestLock, report } = emit(
      [entry('dsh-a')], [], '2026-08-18T00:00:00.000Z')
    for (const text of [pluginsJson, indexJson, manifestLock, report]) {
      expect(text.endsWith('\n')).toBe(true)
      expect(text.endsWith('\n\n')).toBe(false)
    }
  })
})
