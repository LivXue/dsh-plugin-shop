import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { CATALOG_SCHEMA_VERSION, SUBPACKAGE_SCHEMA_VERSION, emit, SCHEMA_VERSION } from '../src/emit.ts'
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

  it('names the plugins file by the hash of the bytes it actually writes', () => {
    // Recomputed from pluginsJson, NOT read back out of the index. The old
    // version asserted `pluginsFileName === plugins.${index.plugins.sha256}
    // .json`, and both sides came from the same variable inside emit — so
    // hashing bytes OTHER than the ones written left the whole suite green.
    // Proven by mutation: replacing `update(pluginsJson)` with
    // `update(JSON.stringify(sorted))` — the same data, a different
    // serialisation — passed 38 of 38.
    //
    // What that costs downstream is the reason this matters: the host verifies
    // the data file against this hash (packages/dsh-plugin-shop/src/host/
    // catalog.ts), so a hash over the wrong bytes makes every published
    // catalog unloadable while CI reports success.
    const { pluginsFileName, pluginsJson, indexJson } = emit([entry('dsh-a')], [], '2026-08-18T00:00:00.000Z')
    const actual = createHash('sha256').update(pluginsJson).digest('hex')
    expect(pluginsFileName).toBe(`plugins.${actual}.json`)
    const index = JSON.parse(indexJson) as { plugins: { url: string; sha256: string } }
    expect(index.plugins.sha256).toBe(actual)
    expect(index.plugins.url).toBe(pluginsFileName)
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

  it('neutralises control characters and bidi formatting in a rejection detail', () => {
    // `detail` carries text from a third party's package.json, and the
    // report's real reader is a maintainer in a terminal: U+001B opens an
    // escape sequence (the OSC-8 below hides an arbitrary target behind
    // harmless-looking text) and U+202E reverses the rest of the line, so a
    // row can be made to read as another package's. Each stripped code point
    // becomes U+FFFD rather than vanishing — a reader should see that
    // something was removed.
    //
    // Written as \u escapes throughout, here and in the implementation: a
    // literal U+202E in a source file is invisible to a reviewer, which is
    // the very problem being fixed.
    const osc8 = '\u001b]8;;https://evil.test\u0007click\u001b]8;;\u0007'
    const detail = `safe ${osc8} \u202egnidaelsim\u202c \u2066wrapped\u2069`
    const { report } = emit([], [{ name: 'dsh-x', code: 'invalid-catalog', detail }], '2026-08-18T00:00:00.000Z')
    const rows = report.split('\n').filter(line => line.startsWith('| dsh-x'))
    expect(rows).toHaveLength(1)
    expect(rows[0]).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/)
    expect(rows[0]).toContain('safe')
    expect(rows[0]).toContain('\ufffd')
  })

  it('neutralises a hostile rejection NAME the same way', () => {
    // A GitHub manifest name is unrestricted, and the name column is the one
    // a reader scans to find their own package.
    const { report } = emit([], [{ name: 'dsh-\u202eevil', code: 'no-bundle', detail: 'x' }], '2026-08-18T00:00:00.000Z')
    expect(report).not.toContain('\u202e')
    expect(report).toContain('dsh-\ufffdevil')
  })

  it('turns a tab into a space and leaves the pipe and newline rules intact', () => {
    const { report } = emit([], [{ name: 'dsh-x', code: 'no-bundle', detail: 'a\u0009b | c\u000ad' }], '2026-08-18T00:00:00.000Z')
    const rows = report.split('\n').filter(line => line.startsWith('| dsh-x'))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toBe('| dsh-x | no-bundle | a b \\| c d |')
  })

  it('leaves ordinary non-ASCII text alone', () => {
    // The strip is a closed list of control and formatting code points, not
    // an ASCII filter: a Chinese detail or an emoji is fine.
    const detail = 'a Chinese detail with an emoji \ud83d\ude42'
    const { report } = emit([], [{ name: 'dsh-x', code: 'no-summary', detail }], '2026-08-18T00:00:00.000Z')
    expect(report).toContain(`| dsh-x | no-summary | ${detail} |`)
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

describe('peers', () => {
  const withPeers: Entry = {
    ...entry('dsh-peered'),
    peers: ['@deepseek-ai/dsh-client-store'],
  }

  it('carries the peers at the version the catalog actually publishes', () => {
    // `peers` used to be gated behind schemaVersion 6 and the gate was never
    // opened, so the compatibility badges never shipped. The gate was never a
    // compatibility one: `peers` is an additive optional field and a client
    // that predates it strips it (consumer zod is non-strict by design). What
    // the version bump WOULD have done is throw on every client capping at 5 —
    // a hard break, bought for a field those clients ignore anyway.
    //
    // So it rides v5. The cost is bytes to clients that cannot read it; the
    // alternative was a bet on an installed base npm's download counts cannot
    // measure (36 versions, median 164, max 218 — mirror traffic enumerating
    // every version, with the current latest at zero).
    const artifacts = emit([withPeers], [], '2026-09-01T00:00:00.000Z', null, CATALOG_SCHEMA_VERSION)
    const data = JSON.parse(artifacts.pluginsJson) as { schemaVersion: number; plugins: { peers?: string[] }[] }
    expect(data.schemaVersion).toBe(5)
    // Guards against a DROPPED entry masquerading as a carried field: an empty
    // `plugins` array would make a `'peers' in ...` check vacuously true or
    // false either way, silently emptying the live catalog for every user.
    expect(data.plugins).toHaveLength(1)
    expect(data.plugins[0]?.peers).toEqual(['@deepseek-ai/dsh-client-store'])
  })

  it('carries them at the older versions too, so no gate can strand them again', () => {
    for (const version of [SCHEMA_VERSION, SUBPACKAGE_SCHEMA_VERSION, CATALOG_SCHEMA_VERSION]) {
      const artifacts = emit([withPeers], [], '2026-09-01T00:00:00.000Z', null, version)
      const data = JSON.parse(artifacts.pluginsJson) as { plugins: { peers?: string[] }[] }
      expect(data.plugins[0]?.peers, `stripped at schemaVersion ${version}`)
        .toEqual(['@deepseek-ai/dsh-client-store'])
    }
  })
})

describe('the shields endpoint badge', () => {
  // GitHub's own workflow badge can say only passing / failing, and it reports
  // the last COMPLETED run — so it never says anything while a build is
  // running, and a red one conflates our tests breaking with npm throttling
  // the search endpoint. This publishes what the reader actually wants to
  // know: the date of the catalog they would download right now. A build that
  // fails deploys nothing, so the date simply stops advancing, which says
  // "stale, and by how much" rather than "something, somewhere, failed".

  it('renders the build date in the shields endpoint schema', () => {
    const { badgeJson } = emit([entry('dsh-a')], [], '2026-08-18T00:00:00.000Z')
    expect(JSON.parse(badgeJson)).toMatchObject({
      schemaVersion: 1,
      label: 'catalog',
      message: 'built 2026-08-18',
    })
  })

  it('carries a colour and a cache window shields will honour', () => {
    const badge = JSON.parse(emit([entry('dsh-a')], [], '2026-08-18T00:00:00.000Z').badgeJson) as
      { color: string; cacheSeconds: number }
    expect(badge.color).toBeTruthy()
    // Long enough not to hammer Pages from every README view, short enough
    // that the date is never a day behind what /v1/index.json already says.
    expect(badge.cacheSeconds).toBeGreaterThanOrEqual(300)
    expect(badge.cacheSeconds).toBeLessThanOrEqual(21600)
  })

  it('takes the date from builtAt and nothing else', () => {
    const a = emit([entry('dsh-a')], [], '2026-08-18T23:59:59.999Z')
    const b = emit([entry('dsh-a')], [], '2027-01-01T00:00:00.000Z')
    expect(JSON.parse(a.badgeJson).message).toBe('built 2026-08-18')
    expect(JSON.parse(b.badgeJson).message).toBe('built 2027-01-01')
    // And it stays out of the hashed content, like builtAt itself.
    expect(a.pluginsJson).toBe(b.pluginsJson)
    expect(a.pluginsFileName).toBe(b.pluginsFileName)
  })
})

describe('the sorts key on the whole identity, not the name', () => {
  it('orders entries that share a bundle name by source, repo, then subdir', () => {
    const { pluginsJson } = emit([
      repoEntry('dsh-shared', 'bob/dsh-shared'),
      repoEntry('dsh-shared', 'alice/mono', 'packages/b'),
      entry('dsh-shared'),
      repoEntry('dsh-shared', 'alice/mono', 'packages/a'),
    ], [], '2026-08-18T00:00:00.000Z')
    const parsed = JSON.parse(pluginsJson) as { plugins: { source: string; repo?: string; subdir?: string }[] }
    expect(parsed.plugins.map(p => [p.source, p.repo ?? '', p.subdir ?? ''])).toEqual([
      ['github', 'alice/mono', 'packages/a'],
      ['github', 'alice/mono', 'packages/b'],
      ['github', 'bob/dsh-shared', ''],
      ['npm', '', ''],
    ])
  })

  it('orders rejections that share a name by code and then detail', () => {
    const { report } = emit([], [
      { name: 'a/b', code: 'no-license', detail: 'second' },
      { name: 'a/b', code: 'no-bundle', detail: 'zzz' },
      { name: 'a/b', code: 'no-bundle', detail: 'aaa' },
    ], '2026-08-18T00:00:00.000Z')
    const rows = report.split('\n').filter(line => line.startsWith('| a/b '))
    expect(rows).toEqual([
      '| a/b | no-bundle | aaa |',
      '| a/b | no-bundle | zzz |',
      '| a/b | no-license | second |',
    ])
  })

  it('orders the published denied list by name and then detail', () => {
    const { pluginsJson } = emit([], [
      { name: 'a/b', code: 'denied', detail: 'zzz' },
      { name: 'a/b', code: 'denied', detail: 'aaa' },
    ], '2026-08-18T00:00:00.000Z')
    const parsed = JSON.parse(pluginsJson) as { denied: { detail: string }[] }
    expect(parsed.denied.map(d => d.detail)).toEqual(['aaa', 'zzz'])
  })
})

describe('the index and the data file describe the same catalog', () => {
  it('reports a count equal to the data file it points at', () => {
    // emit.ts used to assert this by parsing pluginsJson back and comparing
    // lengths -- a throw that could not fire, because both numbers came from
    // the same `sorted` array a few lines apart and JSON.stringify cannot
    // change an array's length. The property is real; the guard was not. Here
    // the two sides are the two EMITTED artifacts, so it goes red the day
    // someone builds them from different sources.
    const { indexJson, pluginsJson } = emit(
      [entry('dsh-a'), entry('dsh-b'), entry('dsh-c')], [], '2026-08-18T00:00:00.000Z',
    )
    const index = JSON.parse(indexJson) as { count: number }
    const data = JSON.parse(pluginsJson) as { plugins: unknown[] }
    expect(index.count).toBe(data.plugins.length)
    expect(index.count).toBe(3)
  })
})

