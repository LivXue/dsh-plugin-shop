import { describe, expect, it } from 'vitest'
import { CATALOG_SCHEMA_VERSION, PEERS_SCHEMA_VERSION, SUBPACKAGE_SCHEMA_VERSION, emit, SCHEMA_VERSION } from '../src/emit.ts'
import type { Entry } from '../src/types.ts'

function entry(name: string, version = '1.0.0'): Entry {
  return {
    name, version, integrity: `sha512-${name}`, publishedAt: '2026-08-01T12:00:00.000Z',
    repository: `https://github.com/you/${name}`, license: 'MIT', tier: 'community',
    metadata: 'declared',
    catalog: { category: 'tool', summary: { en: 'x', zh: 'y' }, capabilities: [] },
    source: 'npm',
    // Before every builtAt used in this suite, so the E9 future-date check
    // never trips on a fixture.
    added: '2026-08-01',
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
    added: '2026-08-01',
  }
}

describe('emit publisher', () => {
  it('carries the publisher into plugins.json at every emitted schema version', () => {
    // An additive optional field rides the LOWER versions too: an old client's
    // zod is non-strict and strips keys it does not know, which is exactly
    // what keeps installed hosts working against a newer catalog. Bumping
    // schemaVersion instead would make every installed 0.5.x shop refuse the
    // catalog outright — a higher version than the client supports is a hard
    // refusal (host/catalog.ts SUPPORTED_SCHEMA_VERSION), which is why v5's
    // category-enum change needed a release-time flag and this field does not.
    const withPublisher = { ...entry('dsh-a'), publisher: 'realauthor' }
    for (const version of [SCHEMA_VERSION, SUBPACKAGE_SCHEMA_VERSION, CATALOG_SCHEMA_VERSION]) {
      const { pluginsJson } = emit([withPublisher], [], '2026-08-26T00:00:00.000Z', null, version)
      const parsed = JSON.parse(pluginsJson) as { schemaVersion: number; plugins: { publisher?: string }[] }
      expect(parsed.schemaVersion).toBe(version)
      expect(parsed.plugins[0]?.publisher).toBe('realauthor')
    }
  })

  it('emits no publisher key for an entry without one', () => {
    const { pluginsJson } = emit([entry('dsh-a'), repoEntry('dsh-b', 'you/dsh-b')], [], '2026-08-26T00:00:00.000Z')
    expect(pluginsJson).not.toContain('publisher')
  })
})

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

  it('serializes the tarball of a release-rescued repo entry, absent for other entries', () => {
    const rescued: Entry = {
      ...repoEntry('dsh-rescued', 'owner/slug'),
      version: 'v1.0.0',
      integrity: 'a'.repeat(64),
      tarball: { url: 'https://github.com/owner/slug/releases/download/v1.0.0/plugin.tgz', sha256: 'a'.repeat(64) },
    }
    const plain = repoEntry('dsh-plain', 'owner/plain')
    const { pluginsJson, manifestLock } = emit([rescued, plain], [], '2026-08-18T00:00:00.000Z')
    const parsed = JSON.parse(pluginsJson) as { plugins: { name: string; tarball?: { url: string; sha256: string } }[] }
    const rescuedOut = parsed.plugins.find(p => p.name === 'dsh-rescued')
    const plainOut = parsed.plugins.find(p => p.name === 'dsh-plain')
    expect(rescuedOut?.tarball).toEqual({
      url: 'https://github.com/owner/slug/releases/download/v1.0.0/plugin.tgz',
      sha256: 'a'.repeat(64),
    })
    expect(plainOut?.tarball).toBeUndefined()
    // the lock line shows the tag — the version — which is what the daily diff compares
    expect(manifestLock).toBe('owner/plain dsh-plain 1.0.0\nowner/slug dsh-rescued v1.0.0\n')
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

describe('schemaVersion 5 (market borrowings)', () => {
  const theme: Entry = {
    ...entry('dsh-theme'),
    catalog: { category: 'theme', summary: { en: 'x', zh: 'y' }, capabilities: [] },
  }
  const rescued: Entry = {
    ...repoEntry('dsh-rescued', 'owner/slug'),
    version: 'v1.0.0',
    integrity: 'a'.repeat(64),
    tarball: { url: 'https://github.com/owner/slug/releases/download/v1.0.0/plugin.tgz', sha256: 'a'.repeat(64) },
  }

  it('emits schemaVersion 5 with the new fields when asked', () => {
    const artifacts = emit([theme, rescued], [
      { name: 'dsh-blocked', code: 'denied', detail: 'matched the denylist', replacement: 'dsh-good' },
    ], '2026-08-31T00:00:00.000Z', null, CATALOG_SCHEMA_VERSION)
    const data = JSON.parse(artifacts.pluginsJson) as {
      schemaVersion: number
      plugins: Array<{ name: string; catalog: { category: string }; added: string; tarball?: { url: string; sha256: string } }>
      denied: Array<{ name: string; detail: string; replacement?: string }>
    }
    expect(data.schemaVersion).toBe(5)
    expect(JSON.parse(artifacts.indexJson)).toMatchObject({ schemaVersion: 5 })
    const themeOut = data.plugins.find(p => p.name === 'dsh-theme')
    expect(themeOut?.catalog.category).toBe('theme')
    expect(themeOut?.added).toBe('2026-08-01')
    const rescuedOut = data.plugins.find(p => p.name === 'dsh-rescued')
    expect(rescuedOut?.tarball).toEqual({
      url: 'https://github.com/owner/slug/releases/download/v1.0.0/plugin.tgz',
      sha256: 'a'.repeat(64),
    })
    expect(data.denied).toEqual([{ name: 'dsh-blocked', detail: 'matched the denylist', replacement: 'dsh-good' }])
  })

  it('emits a theme entry as other below v5 and notes the downgrade count in the report', () => {
    const v3 = emit([theme], [], '2026-08-31T00:00:00.000Z')
    const v3Data = JSON.parse(v3.pluginsJson) as { plugins: Array<{ catalog: { category: string } }> }
    expect(v3Data.plugins[0]?.catalog.category).toBe('other')
    expect(v3.report).toContain('Theme entries emitted as other')
    expect(v3.report).toContain('1')

    const v4 = emit([theme], [], '2026-08-31T00:00:00.000Z', null, SUBPACKAGE_SCHEMA_VERSION)
    const v4Data = JSON.parse(v4.pluginsJson) as { plugins: Array<{ catalog: { category: string } }> }
    expect(v4Data.plugins[0]?.catalog.category).toBe('other')
    expect(v4.report).toContain('Theme entries emitted as other')
    expect(v4.report).toContain('1')
  })

  it('keeps a non-theme entry untouched below v5 and stays silent in the report', () => {
    const v3 = emit([entry('dsh-tool')], [], '2026-08-31T00:00:00.000Z')
    const data = JSON.parse(v3.pluginsJson) as { plugins: Array<{ catalog: { category: string } }> }
    expect(data.plugins[0]?.catalog.category).toBe('tool')
    expect(v3.report).not.toContain('Theme entries emitted as other')
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

  it('throws when an entry carries an added date later than the build date', () => {
    const future = { ...entry('dsh-a'), added: '2026-08-26' }
    expect(() => emit([future], [], '2026-08-25T00:00:00.000Z'))
      .toThrow(/added 2026-08-26 is later than the build date 2026-08-25/)
  })

  it('throws when an entry carries an unparseable added date', () => {
    const broken = { ...entry('dsh-a'), added: 'yesterday' }
    expect(() => emit([broken], [], '2026-08-25T00:00:00.000Z'))
      .toThrow(/unparseable added date yesterday/)
  })
})

describe('peers and schemaVersion 6', () => {
  const withPeers: Entry = {
    ...entry('dsh-peered'),
    peers: ['@deepseek-ai/dsh-client-store'],
  }

  it('emits the peers at schemaVersion 6', () => {
    const artifacts = emit([withPeers], [], '2026-09-01T00:00:00.000Z', null, PEERS_SCHEMA_VERSION)
    const data = JSON.parse(artifacts.pluginsJson) as { schemaVersion: number; plugins: { peers?: string[] }[] }
    expect(data.schemaVersion).toBe(6)
    expect(data.plugins[0]?.peers).toEqual(['@deepseek-ai/dsh-client-store'])
  })

  it('strips the peers below schemaVersion 6', () => {
    const artifacts = emit([withPeers], [], '2026-09-01T00:00:00.000Z', null, CATALOG_SCHEMA_VERSION)
    const data = JSON.parse(artifacts.pluginsJson) as { schemaVersion: number; plugins: Record<string, unknown>[] }
    expect(data.schemaVersion).toBe(5)
    // Guards against a DROPPED entry masquerading as a stripped field: an
    // empty `plugins` array would also make the `'peers' in ...` check below
    // vacuously false, silently emptying the live v5 catalog for every user.
    expect(data.plugins).toHaveLength(1)
    expect(data.plugins[0] !== undefined && 'peers' in data.plugins[0]).toBe(false)
  })
})
