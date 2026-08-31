import { describe, expect, it } from 'vitest'
import { emit, SCHEMA_VERSION } from '../src/emit.ts'
import type { Entry } from '../src/types.ts'

function entry(name: string, version = '1.0.0'): Entry {
  return {
    name, version, integrity: `sha512-${name}`, publishedAt: '2026-08-01T12:00:00.000Z',
    repository: `https://github.com/you/${name}`, license: 'MIT', tier: 'community',
    metadata: 'declared',
    catalog: { category: 'tool', summary: { en: 'x', zh: 'y' }, capabilities: [] },
    source: 'npm',
  }
}

function repoEntry(name: string, repo: string, subdir?: string): Entry {
  return {
    name, version: '1.0.0', integrity: `sha512-${name}`, publishedAt: '2026-08-01T12:00:00.000Z',
    repository: `https://github.com/${repo}`, license: 'MIT', tier: 'community',
    metadata: 'declared',
    catalog: { category: 'tool', summary: { en: 'x', zh: 'y' }, capabilities: [] },
    source: 'github',
    repo,
    ...(subdir == null ? {} : { subdir }),
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

  it('puts builtAt, the entry count, and the rejection count in the index', () => {
    const { indexJson } = emit([entry('dsh-a')], [{ name: 'dsh-no', code: 'no-bundle', detail: 'x' }], '2026-08-18T00:00:00.000Z')
    expect(JSON.parse(indexJson)).toMatchObject({ builtAt: '2026-08-18T00:00:00.000Z', count: 1, rejected: 1 })
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

  it('publishes a derived entry with no summary.zh', () => {
    const derived: Entry = {
      ...entry('dsh-derived'),
      metadata: 'derived',
      catalog: { category: 'other', summary: { en: 'x' }, capabilities: [] },
    }
    const { pluginsJson } = emit([derived], [], '2026-08-18T00:00:00.000Z')
    const parsed = JSON.parse(pluginsJson) as { plugins: { metadata: string; catalog: { summary: { zh?: string } } }[] }
    expect(parsed.plugins[0]?.metadata).toBe('derived')
    expect(parsed.plugins[0]?.catalog.summary.zh).toBeUndefined()
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

  it('escapes a rejection detail containing a pipe and a newline so the row stays intact', () => {
    const { report } = emit([], [
      { name: 'dsh-x', code: 'invalid-catalog', detail: 'dsh.catalog.foo | bar\nbaz: unrecognized key' },
    ], '2026-08-18T00:00:00.000Z')
    const tableLines = report.split('\n').filter(line => line.startsWith('| dsh-x'))
    expect(tableLines).toHaveLength(1)
    expect(tableLines[0]).toBe('| dsh-x | invalid-catalog | dsh.catalog.foo \\| bar baz: unrecognized key |')
  })

  it('ends every text artifact with exactly one newline', () => {
    const { pluginsJson, indexJson, manifestLock, report } = emit(
      [entry('dsh-a')], [], '2026-08-18T00:00:00.000Z')
    for (const text of [pluginsJson, indexJson, manifestLock, report]) {
      expect(text.endsWith('\n')).toBe(true)
      expect(text.endsWith('\n\n')).toBe(false)
    }
  })

  it('publishes only denylist rejections as the denied list, with their details', () => {
    const artifacts = emit(
      [entry('dsh-listed')],
      [
        { name: 'dsh-blocked', code: 'denied', detail: 'matched the denylist' },
        { name: 'dsh-no-summary', code: 'no-summary', detail: 'nothing to show' },
      ],
      '2026-08-25T00:00:00.000Z',
    )
    const data = JSON.parse(artifacts.pluginsJson)
    expect(data.denied).toEqual([{ name: 'dsh-blocked', detail: 'matched the denylist' }])
  })

  it('carries the replacement pointer on a denied rejection when one is recorded, and omits it otherwise', () => {
    const artifacts = emit(
      [entry('dsh-listed')],
      [
        { name: 'dsh-blocked', code: 'denied', detail: 'matched the denylist', replacement: 'dsh-good' },
        { name: 'dsh-blocked-2', code: 'denied', detail: 'no substitute' },
      ],
      '2026-08-25T00:00:00.000Z',
    )
    const data = JSON.parse(artifacts.pluginsJson)
    expect(data.denied).toEqual([
      { name: 'dsh-blocked', detail: 'matched the denylist', replacement: 'dsh-good' },
      { name: 'dsh-blocked-2', detail: 'no substitute' },
    ])
  })

  it('emits a stars pointer when one is supplied and omits it when null', () => {
    const entries: Entry[] = []
    const withStars = emit(entries, [], '2026-08-26T00:00:00.000Z', { url: 'stars.abc.json', sha256: 'abc' })
    const parsed = JSON.parse(withStars.indexJson) as { stars?: { url: string; sha256: string } }
    expect(parsed.stars).toEqual({ url: 'stars.abc.json', sha256: 'abc' })

    const without = emit(entries, [], '2026-08-26T00:00:00.000Z', null)
    expect('stars' in (JSON.parse(without.indexJson) as object)).toBe(false)

    const omitted = emit(entries, [], '2026-08-26T00:00:00.000Z')
    expect('stars' in (JSON.parse(omitted.indexJson) as object)).toBe(false)
  })
})

describe('assertCatalogInvariants', () => {
  it('throws on two entries with the same npm identity', () => {
    const npm = entry('dsh-a')
    expect(() => emit([npm, { ...npm }], [], '2026-08-31T00:00:00Z')).toThrow(/duplicate install identity/)
  })

  it('throws on two github entries with the same repo and subdir', () => {
    const repo = repoEntry('dsh-a', 'owner/slug', 'packages/a')
    expect(() => emit([repo, { ...repo }], [], '2026-08-31T00:00:00Z')).toThrow(/duplicate install identity/)
  })

  it('allows the same bundle name from different repos', () => {
    // the registry legitimately holds distinct plugins under one name
    const a = repoEntry('dsh-a', 'owner-a/slug')
    const b = repoEntry('dsh-a', 'owner-b/slug')
    expect(() => emit([a, b], [], '2026-08-31T00:00:00Z')).not.toThrow()
  })
})
