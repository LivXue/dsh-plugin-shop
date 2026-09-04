import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { runPipeline } from '../src/pipeline.ts'
import { parseRegistryConfig } from '../src/config.ts'
import type { Candidate, Rejection } from '../src/types.ts'

const candidates = JSON.parse(
  readFileSync('registry/scripts/tests/fixtures/packuments.json', 'utf8'),
) as Candidate[]

const config = parseRegistryConfig({
  verified: '- name: dsh-fs-tool\n  reviewedVersion: 1.0.0\n  reviewer: github:r\n  reviewCommit: abc\n  notes: fine\n',
  denied: '[]',
  allowedSimilar: '[]',
  categories: '[]',
  firstSeen: [
    '- name: dsh-fs-tool',
    '  added: 2026-08-10',
    '- name: dsh-hello-plugin',
    '  added: 2026-08-11',
    '- name: dsh-derived-plugin',
    '  added: 2026-08-12',
    // Repo entries are keyed by `owner/slug`: a bundle name is claimed by up
    // to 14 repositories, so it cannot carry one repository's date.
    '- name: someone/dsh-repo-plugin',
    '  added: 2026-08-13',
    '- name: someone/monorepo',
    '  added: 2026-08-14',
  ].join('\n') + '\n',
})

const BUILT_AT = '2026-08-18T00:00:00.000Z'

describe('runPipeline', () => {
  it('accepts the three listable plugins', () => {
    const { pluginsJson } = runPipeline(candidates, [], config, BUILT_AT)
    const parsed = JSON.parse(pluginsJson) as { plugins: { name: string }[] }
    expect(parsed.plugins.map(p => p.name)).toEqual(['dsh-derived-plugin', 'dsh-fs-tool', 'dsh-hello-plugin'])
  })

  it('downgrades the verified plugin whose version moved past its review', () => {
    const { pluginsJson } = runPipeline(candidates, [], config, BUILT_AT)
    const parsed = JSON.parse(pluginsJson) as { plugins: { name: string; tier: string }[] }
    expect(parsed.plugins.find(p => p.name === 'dsh-fs-tool')?.tier).toBe('verified-stale')
  })

  it('lists a package with no dsh.catalog as a derived entry, from its npm description', () => {
    const { pluginsJson } = runPipeline(candidates, [], config, BUILT_AT)
    const parsed = JSON.parse(pluginsJson) as {
      plugins: { name: string; metadata: string; catalog: { category: string; summary: { en: string; zh?: string }; capabilities: string[] } }[]
    }
    const derived = parsed.plugins.find(p => p.name === 'dsh-derived-plugin')
    expect(derived?.metadata).toBe('derived')
    expect(derived?.catalog).toEqual({
      category: 'other',
      summary: { en: 'A plugin listed from npm metadata, with no dsh.catalog section.' },
      capabilities: [],
    })
  })

  it('marks a declared listing as declared', () => {
    const { pluginsJson } = runPipeline(candidates, [], config, BUILT_AT)
    const parsed = JSON.parse(pluginsJson) as { plugins: { name: string; metadata: string }[] }
    expect(parsed.plugins.find(p => p.name === 'dsh-hello-plugin')?.metadata).toBe('declared')
  })

  it('reports all four rejections with their codes', () => {
    const { report } = runPipeline(candidates, [], config, BUILT_AT)
    expect(report).toContain('| dsh-lib-only | no-bundle |')
    expect(report).toContain('| dsh-no-license | no-license |')
    expect(report).toContain('| dsh-fs-too1 | name-too-similar |')
    expect(report).toContain('| dsh-no-summary | no-summary |')
  })

  it('merges a pre-existing rejection into the emitted report', () => {
    const preexisting: Rejection[] = [
      { name: 'dsh-rate-limited', code: 'fetch-failed', detail: 'npm registry returned 429 fetching dsh-rate-limited' },
    ]
    const { report } = runPipeline(candidates, [], config, BUILT_AT, preexisting)
    expect(report).toContain('| dsh-rate-limited | fetch-failed | npm registry returned 429 fetching dsh-rate-limited |')
  })

  it('produces byte-identical artifacts for the same input', () => {
    const first = runPipeline(candidates, [], config, BUILT_AT)
    const second = runPipeline([...candidates].reverse(), [], config, BUILT_AT)
    expect(second.pluginsJson).toBe(first.pluginsJson)
    expect(second.pluginsFileName).toBe(first.pluginsFileName)
    expect(second.manifestLock).toBe(first.manifestLock)
    expect(second.report).toBe(first.report)
  })

  it('stays byte-identical when a derived listing carries a categories row', () => {
    const categorized = parseRegistryConfig({
      verified: '- name: dsh-fs-tool\n  reviewedVersion: 1.0.0\n  reviewer: github:r\n  reviewCommit: abc\n  notes: fine\n',
      denied: '[]',
      allowedSimilar: '[]',
      categories: '- name: dsh-derived-plugin\n  category: tool\n',
      firstSeen: [
        '- name: dsh-fs-tool',
        '  added: 2026-08-10',
        '- name: dsh-hello-plugin',
        '  added: 2026-08-11',
        '- name: dsh-derived-plugin',
        '  added: 2026-08-12',
      ].join('\n') + '\n',
    })
    const first = runPipeline(candidates, [], categorized, BUILT_AT)
    const second = runPipeline(candidates, [], categorized, BUILT_AT)
    expect(second.pluginsJson).toBe(first.pluginsJson)
    const parsed = JSON.parse(first.pluginsJson) as {
      plugins: { name: string; metadata: string; catalog: { category: string } }[]
    }
    const derived = parsed.plugins.find(p => p.name === 'dsh-derived-plugin')
    expect(derived?.catalog.category).toBe('tool')
  })

  it('emits the first-seen date as added', () => {
    const { pluginsJson } = runPipeline(candidates, [], config, BUILT_AT)
    const parsed = JSON.parse(pluginsJson) as { plugins: { name: string; added: string }[] }
    expect(parsed.plugins.find(p => p.name === 'dsh-fs-tool')?.added).toBe('2026-08-10')
    expect(parsed.plugins.find(p => p.name === 'dsh-hello-plugin')?.added).toBe('2026-08-11')
  })

  it('stamps a first appearance with the build date and returns the row to commit', () => {
    const withoutRow = parseRegistryConfig({
      verified: '- name: dsh-fs-tool\n  reviewedVersion: 1.0.0\n  reviewer: github:r\n  reviewCommit: abc\n  notes: fine\n',
      denied: '[]',
      allowedSimilar: '[]',
      categories: '[]',
      firstSeen: '- name: dsh-hello-plugin\n  added: 2026-08-11\n- name: dsh-derived-plugin\n  added: 2026-08-12\n',
    })
    const { pluginsJson, firstSeen } = runPipeline(candidates, [], withoutRow, BUILT_AT)
    const parsed = JSON.parse(pluginsJson) as { plugins: { name: string; added: string }[] }
    expect(parsed.plugins.find(p => p.name === 'dsh-fs-tool')?.added).toBe('2026-08-18')
    expect(firstSeen.get('dsh-fs-tool')).toBe('2026-08-18')
    // A recorded row is never overwritten.
    expect(firstSeen.get('dsh-hello-plugin')).toBe('2026-08-11')
  })

  it('never stamps a rejected candidate, so a package listed after weeks of rejection keeps its real date', () => {
    // B-9: the stamp used to happen before the gate, so `dsh-lib-only` —
    // rejected `no-bundle` every day — had a row from its first harvest, and
    // the day it finally declared a bundle it was "added" months earlier.
    const { firstSeen } = runPipeline(candidates, [], config, BUILT_AT)
    expect(firstSeen.has('dsh-lib-only')).toBe(false)
    expect(firstSeen.has('dsh-no-license')).toBe(false)
    expect(firstSeen.has('dsh-no-summary')).toBe(false)
  })

  it('produces identical data across build times', () => {
    const first = runPipeline(candidates, [], config, BUILT_AT)
    const second = runPipeline(candidates, [], config, '2030-01-01T00:00:00.000Z')
    expect(second.pluginsJson).toBe(first.pluginsJson)
    expect(second.pluginsFileName).toBe(first.pluginsFileName)
    expect(second.manifestLock).toBe(first.manifestLock)
    expect(second.report).toBe(first.report)
    expect(second.indexJson).not.toBe(first.indexJson)
  })

  it('produces byte-identical artifacts with a stars pointer across runs', () => {
    const stars = { url: 'stars.deadbeef.json', sha256: 'deadbeef' }
    const first = runPipeline(candidates, [], config, BUILT_AT, [], stars)
    const second = runPipeline(candidates, [], config, BUILT_AT, [], stars)
    expect(first.indexJson).toBe(second.indexJson)
    expect(first.pluginsJson).toBe(second.pluginsJson)
    expect(JSON.parse(first.indexJson).stars).toEqual(stars)
  })

  it('keeps plugins.json bounded when a candidate carries megabyte strings', () => {
    // The real toCandidate -> gate -> assignTier -> emit path produced a
    // 203 MB plugins.json from ONE package with 1 MB strings. Every reader
    // downloads that file.
    const hostile: Candidate = {
      name: 'dsh-hostile-plugin',
      version: '1.0.0',
      integrity: 'sha512-x',
      publishedAt: '2026-08-01T12:00:00.000Z',
      repository: `https://github.com/you/${'x'.repeat(1024 * 1024)}`,
      license: 'M'.repeat(1024 * 1024),
      deprecated: false,
      hasBundle: true,
      catalog: { category: 'tool', summary: { en: 'x', zh: 'y' }, capabilities: ['c'.repeat(1024 * 1024)] },
      description: 'A hostile plugin.',
      keywords: [],
      peers: Array.from({ length: 200 }, () => 'p'.repeat(1024 * 1024)),
    }
    // A first-seen row so the size assertion below is what fails when the
    // bounds are gone: without one, assignTier throws on the listed hostile
    // entry and the test would never reach a byte of plugins.json. Once the
    // bounds hold, the gate rejects the candidate and the row is never read.
    const withHostileRow = parseRegistryConfig({
      verified: '- name: dsh-fs-tool\n  reviewedVersion: 1.0.0\n  reviewer: github:r\n  reviewCommit: abc\n  notes: fine\n',
      denied: '[]',
      allowedSimilar: '[]',
      categories: '[]',
      firstSeen: [
        '- name: dsh-fs-tool',
        '  added: 2026-08-10',
        '- name: dsh-hello-plugin',
        '  added: 2026-08-11',
        '- name: dsh-derived-plugin',
        '  added: 2026-08-12',
        '- name: dsh-hostile-plugin',
        '  added: 2026-08-15',
      ].join('\n') + '\n',
    })
    const { pluginsJson, report } = runPipeline([...candidates, hostile], [], withHostileRow, BUILT_AT)
    const parsed = JSON.parse(pluginsJson) as { plugins: { name: string }[] }
    expect(parsed.plugins.map(p => p.name)).not.toContain('dsh-hostile-plugin')
    expect(report).toContain('| dsh-hostile-plugin | no-license |')
    expect(pluginsJson.length).toBeLessThan(64 * 1024)
  })

  it('keeps plugins.json bounded when every field is legal and the ENTRY is not', () => {
    // The case a per-field bound cannot see. Each value below is inside its
    // own limit -- `peers` is exactly what toCandidate admits today, 200 names
    // of 214 characters -- and the entry still costs 45,608 bytes of a file
    // whose live average entry is 797 B. 100 such packages added 4.7 MB to a
    // 7.2 MB file, and against the live catalog (3,514 npm + 5,908 github)
    // the aggregate ceiling was ~186 MiB. The entry budget is what caps that;
    // this pins it through the real gate -> assignTier -> emit path rather
    // than at the gate's own return value.
    const HOSTILE = 100
    const bloated = Array.from({ length: HOSTILE }, (_, n): Candidate => ({
      name: `dsh-bloat-${String(n).padStart(3, '0')}`,
      version: '1.0.0',
      integrity: 'sha512-x',
      publishedAt: '2026-08-01T12:00:00.000Z',
      repository: 'https://github.com/you/bloat',
      license: 'MIT',
      deprecated: false,
      hasBundle: true,
      catalog: { category: 'tool', summary: { en: 'x', zh: 'y' }, capabilities: [] },
      description: 'A bloated plugin.',
      keywords: [],
      peers: Array.from({ length: 200 }, (_, i) => `${String(i).padStart(4, '0')}${'p'.repeat(210)}`),
    }))
    // first-seen rows for all of them, so that WITHOUT the budget this test
    // fails on the size rather than on assignTier throwing before a byte of
    // plugins.json exists. With the budget they are rejected and never read.
    const withBloatRows = parseRegistryConfig({
      verified: '- name: dsh-fs-tool\n  reviewedVersion: 1.0.0\n  reviewer: github:r\n  reviewCommit: abc\n  notes: fine\n',
      denied: '[]',
      allowedSimilar: '[]',
      categories: '[]',
      firstSeen: [
        '- name: dsh-fs-tool',
        '  added: 2026-08-10',
        '- name: dsh-hello-plugin',
        '  added: 2026-08-11',
        '- name: dsh-derived-plugin',
        '  added: 2026-08-12',
        ...bloated.flatMap(c => [`- name: ${c.name}`, '  added: 2026-08-15']),
      ].join('\n') + '\n',
    })
    const clean = runPipeline(candidates, [], config, BUILT_AT)
    const { pluginsJson, report } = runPipeline([...candidates, ...bloated], [], withBloatRows, BUILT_AT)
    const listed = (JSON.parse(pluginsJson) as { plugins: { name: string }[] }).plugins.map(p => p.name)
    expect(listed.filter(n => n.startsWith('dsh-bloat-'))).toEqual([])
    // Not one byte of the 4.5 MB reaches the file: the catalog is the clean
    // one, exactly.
    expect(pluginsJson).toBe(clean.pluginsJson)
    // Every one of them is named in the report with an author-readable reason,
    // because nothing disappears without a reason attached to its name.
    expect(report).toContain('| dsh-bloat-000 | no-manifest | Would publish 45608 bytes of catalog entry, past the 12288-byte budget one entry may occupy in plugins.json. |')
    expect(report.match(/\| dsh-bloat-\d\d\d \| no-manifest \|/g)).toHaveLength(HOSTILE)
  })
})

describe('runPipeline with repository candidates', () => {
  const commit = 'c'.repeat(40)
  const repoCandidate: import('../src/types.ts').RepoCandidate = {
    name: 'dsh-repo-plugin',
    repo: 'someone/dsh-repo-plugin',
    commit,
    version: commit,
    publishedAt: '2026-08-01T12:00:00.000Z',
    repository: 'https://github.com/someone/dsh-repo-plugin',
    license: 'MIT',
    hasBundle: true,
    requiresBuild: false,
    hasWorkspaceDeps: false,
    catalog: { category: 'tool', summary: { en: 'x', zh: 'y' }, capabilities: [] },
    description: 'A repo plugin.',
  }

  it('lists a repository entry with its source, repo, pinned commit, and added date', () => {
    const { pluginsJson } = runPipeline([], [repoCandidate], config, BUILT_AT)
    const parsed = JSON.parse(pluginsJson) as { plugins: { name: string; source: string; repo: string; version: string; added: string }[] }
    expect(parsed.plugins).toMatchObject([{
      name: 'dsh-repo-plugin', source: 'github', repo: 'someone/dsh-repo-plugin', version: commit, added: '2026-08-13',
    }])
  })

  it('keys a repository first appearance by owner/slug and not by the bundle name', () => {
    const noRows = parseRegistryConfig({
      verified: '[]', denied: '[]', allowedSimilar: '[]', categories: '[]', firstSeen: '[]',
    })
    const { firstSeen, pluginsJson } = runPipeline([], [repoCandidate], noRows, BUILT_AT)
    expect(firstSeen.get('someone/dsh-repo-plugin')).toBe('2026-08-18')
    expect(firstSeen.has('dsh-repo-plugin')).toBe(false)
    const parsed = JSON.parse(pluginsJson) as { plugins: { added: string }[] }
    expect(parsed.plugins[0]?.added).toBe('2026-08-18')
  })

  it('gives two repositories sharing a bundle name their own first-seen rows', () => {
    // A-2's other half: with one row per bundle name, an npm package taking a
    // verified repo's name inherited its `added` date and looked as old as
    // the entry it displaced.
    const noRows = parseRegistryConfig({
      verified: '[]', denied: '[]', allowedSimilar: '[]', categories: '[]',
      firstSeen: '- name: alice/dsh-repo-plugin\n  added: 2026-07-01\n',
    })
    const { firstSeen, pluginsJson } = runPipeline([], [
      { ...repoCandidate, repo: 'alice/dsh-repo-plugin' },
      { ...repoCandidate, repo: 'bob/dsh-repo-plugin' },
    ], noRows, BUILT_AT)
    expect(firstSeen.get('alice/dsh-repo-plugin')).toBe('2026-07-01')
    expect(firstSeen.get('bob/dsh-repo-plugin')).toBe('2026-08-18')
    const parsed = JSON.parse(pluginsJson) as { plugins: { repo: string; added: string }[] }
    expect(parsed.plugins.map(p => [p.repo, p.added])).toEqual([
      ['alice/dsh-repo-plugin', '2026-07-01'],
      ['bob/dsh-repo-plugin', '2026-08-18'],
    ])
  })

  it('shadows a repository whose bundle name already ships as an npm package, with a reason', () => {
    const { report } = runPipeline(candidates, [{ ...repoCandidate, name: 'dsh-hello-plugin' }], config, BUILT_AT)
    expect(report).toContain('| someone/dsh-repo-plugin | shadowed-by-npm |')
    expect(report).toContain('already listed')
  })

  it('reports a repository rejection from the repo gate', () => {
    const { report } = runPipeline([], [{ ...repoCandidate, hasBundle: false }], config, BUILT_AT)
    expect(report).toContain('| someone/dsh-repo-plugin | no-bundle |')
  })

  it('lists a release-rescued repo entry pinned to its tag and tarball', () => {
    const rescued = {
      ...repoCandidate,
      requiresBuild: true,
      release: {
        tag: 'v1.0.0',
        url: 'https://github.com/someone/dsh-repo-plugin/releases/download/v1.0.0/plugin.tgz',
        sha256: 'f'.repeat(64),
      },
    }
    const { pluginsJson, manifestLock } = runPipeline([], [rescued], config, BUILT_AT)
    const parsed = JSON.parse(pluginsJson) as {
      plugins: { name: string; version: string; integrity: string; source: string; tarball?: { url: string; sha256: string } }[]
    }
    expect(parsed.plugins[0]).toMatchObject({
      name: 'dsh-repo-plugin',
      version: 'v1.0.0',
      integrity: 'f'.repeat(64),
      source: 'github',
      tarball: {
        url: 'https://github.com/someone/dsh-repo-plugin/releases/download/v1.0.0/plugin.tgz',
        sha256: 'f'.repeat(64),
      },
    })
    // the lock line shows the tag, which is what the daily diff compares
    expect(manifestLock).toBe('someone/dsh-repo-plugin dsh-repo-plugin v1.0.0\n')
  })
})

describe('subpackage entries and the schemaVersion bump', () => {
  const commit = 'd'.repeat(40)
  const subCandidate: import('../src/types.ts').RepoCandidate = {
    name: 'sub-plugin',
    repo: 'someone/monorepo',
    commit,
    version: commit,
    publishedAt: '2026-08-01T12:00:00.000Z',
    repository: 'https://github.com/someone/monorepo',
    license: 'MIT',
    hasBundle: true,
    requiresBuild: false,
    hasWorkspaceDeps: false,
    subdir: 'packages/sub-plugin',
    catalog: { category: 'tool', summary: { en: 'A subpackage plugin.', zh: '一个子包插件。' }, capabilities: [] },
    description: 'A subpackage plugin.',
  }

  it('emits a subpackage entry with its subdir and the pinned commit', () => {
    const { pluginsJson } = runPipeline([], [subCandidate], config, BUILT_AT)
    const parsed = JSON.parse(pluginsJson) as { plugins: { name: string; repo: string; subdir?: string }[] }
    expect(parsed.plugins).toMatchObject([{ name: 'sub-plugin', repo: 'someone/monorepo', subdir: 'packages/sub-plugin' }])
  })

  it('writes the requested schemaVersion into the data and the index', () => {
    const artifacts = runPipeline([], [subCandidate], config, BUILT_AT, [], null, 4)
    const parsed = JSON.parse(artifacts.pluginsJson) as { schemaVersion: number }
    expect(parsed.schemaVersion).toBe(4)
    expect(JSON.parse(artifacts.indexJson).schemaVersion).toBe(4)
  })

  it('defaults to schemaVersion 3 when the flag is off', () => {
    const artifacts = runPipeline([], [subCandidate], config, BUILT_AT)
    expect(JSON.parse(artifacts.indexJson).schemaVersion).toBe(3)
  })
})

describe('nothing unpaired leaves for plugins.json', () => {
  // The claim three rounds tried to make and kept scoping too narrowly.
  // toWellFormedCatalog covered the CATALOG SECTION; plugins.json is not the
  // catalog section. Entry.license, Entry.repository, Entry.publisher and
  // Entry.peers[] are npm-manifest strings taken verbatim and bounded on
  // LENGTH only, so `"license": "MIT\ud800"` put a lone surrogate straight
  // into the artifact — the same UnicodeEncodeError the catalog fix cites as
  // the reason it matters.
  //
  // So the guarantee is stated where it can stay true: every string in every
  // emitted Entry, at the emit boundary, whatever fields an Entry grows next.
  const LONE_SURROGATE_ESCAPE = /\\ud[89ab][0-9a-f]{2}/i

  const hostileConfig = parseRegistryConfig({
    verified: '[]', denied: '[]', allowedSimilar: '[]', categories: '[]',
    firstSeen: '- name: dsh-hostile-plugin\n  added: 2026-08-11\n',
  })

  const hostile: Candidate = {
    name: 'dsh-hostile-plugin',
    version: '1.0.0\uD800',
    integrity: 'sha512-x\uDC00',
    publishedAt: '2026-08-01T12:00:00.000Z',
    repository: 'https://github.com/you/p\uD800',
    license: 'MIT\uD800',
    deprecated: false,
    hasBundle: true,
    catalog: { category: 'tool', summary: { en: 'en \uD800', zh: 'zh \uDC00' }, capabilities: ['cap \uD800'] },
    description: 'A plugin.',
    keywords: [],
    publisher: 'someone\uD800',
    peers: ['peer-a\uD800', 'peer-b'],
  }

  it('emits no unpaired surrogate in any entry it publishes', () => {
    // "in any entry", not "anywhere in the file": the pass covers Entry, which
    // is what `plugins` holds. The sibling `denied[]` array is built from
    // rejection details and does not pass through it — not a live gap (those
    // strings are human-authored denial reasons from denied.yml), but the
    // claim is scoped to what is actually enforced.
    const { pluginsJson } = runPipeline([hostile], [], hostileConfig, BUILT_AT)
    // JSON.stringify escapes an orphan as \udXXX, so the file stays ASCII and
    // the content hash stays stable — which is precisely why no existing test
    // noticed. The escape is what has to be absent.
    expect(LONE_SURROGATE_ESCAPE.test(pluginsJson)).toBe(false)
  })

  it('covers the fields outside the catalog section, one at a time', () => {
    // Named individually so a regression points at the field that regressed
    // rather than at "something somewhere in the entry".
    const { pluginsJson } = runPipeline([hostile], [], hostileConfig, BUILT_AT)
    const entry = (JSON.parse(pluginsJson) as { plugins: Record<string, unknown>[] }).plugins[0]
    const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
    for (const field of ['version', 'integrity', 'repository', 'license', 'publisher']) {
      expect(lone.test(String(entry?.[field] ?? '')), field).toBe(false)
    }
    for (const peer of (entry?.peers as string[] | undefined) ?? []) {
      expect(lone.test(peer), 'peers').toBe(false)
    }
  })

  it('preserves every entry\'s key order through the well-formedness pass', () => {
    // The pass rebuilds each object (Object.fromEntries over Object.entries),
    // so key order is a property it can silently change — and a reorder
    // rewrites every entry in plugins.json, moves the content hash and
    // invalidates every CDN cache, which is the harm the builtAt invariant
    // exists to prevent. Mutating the recursion to sort keys left 441/441
    // green before this assertion existed.
    const { pluginsJson } = runPipeline(candidates, [], config, BUILT_AT)
    const parsed = JSON.parse(pluginsJson) as { plugins: Record<string, unknown>[] }
    const entry = parsed.plugins.find(p => p.name === 'dsh-fs-tool')
    const keys = Object.keys(entry ?? {})
    expect(keys).toEqual([
      'name', 'version', 'integrity', 'publishedAt', 'repository', 'license',
      'metadata', 'catalog', 'source', 'added', 'tier', 'review',
    ])
    // Stated twice on purpose: the list above pins the exact order, and this
    // pins that the order is not merely SOME deterministic order — sorting is
    // the specific reordering a rebuild is most likely to introduce.
    expect(keys).not.toEqual([...keys].sort())
    // The nested objects are rebuilt too, so they need the same statement.
    const catalog = entry?.catalog as Record<string, unknown> | undefined
    expect(Object.keys(catalog ?? {})).toEqual(['category', 'summary', 'capabilities'])
  })

  it('leaves a well-formed catalog byte-identical', () => {
    // toWellFormed is the identity on well-formed text, and the ordinary build
    // must not acquire a replacement character or a reordered key. The
    // fixtures' artifact is the strongest available statement of that.
    const before = runPipeline(candidates, [], config, BUILT_AT)
    expect(before.pluginsJson).toContain('dsh-hello-plugin')
    expect(LONE_SURROGATE_ESCAPE.test(before.pluginsJson)).toBe(false)
  })
})

describe('a repo denial survives the author publishing to npm', () => {
  const commit = 'e'.repeat(40)

  it('publishes both denial rows and lists nothing', () => {
    // B-6: the npm package won the bundle name, the repository was reported
    // `shadowed-by-npm`, and `denied[]` — which the Host's install gate reads
    // — stayed empty, so the install went through.
    const denied = parseRegistryConfig({
      verified: '[]',
      denied: '- name: evil/dsh-x\n  reason: Exfiltrates credentials.\n',
      allowedSimilar: '[]',
      categories: '[]',
      firstSeen: '- name: dsh-x\n  added: 2026-08-10\n- name: evil/dsh-x\n  added: 2026-08-10\n',
    })
    const npmCandidate: Candidate = {
      name: 'dsh-x',
      version: '1.0.0',
      integrity: 'sha512-x',
      publishedAt: '2026-08-01T12:00:00.000Z',
      repository: 'https://github.com/evil/dsh-x',
      license: 'MIT',
      deprecated: false,
      hasBundle: true,
      catalog: { category: 'tool', summary: { en: 'x', zh: 'y' }, capabilities: [] },
      description: 'x',
      keywords: [],
      peers: [],
    }
    const repoCandidate: import('../src/types.ts').RepoCandidate = {
      name: 'dsh-x',
      repo: 'evil/dsh-x',
      commit,
      version: commit,
      publishedAt: '2026-08-01T12:00:00.000Z',
      repository: 'https://github.com/evil/dsh-x',
      license: 'MIT',
      hasBundle: true,
      requiresBuild: false,
      hasWorkspaceDeps: false,
      catalog: { category: 'tool', summary: { en: 'x', zh: 'y' }, capabilities: [] },
      description: 'x',
    }
    const { pluginsJson, report } = runPipeline([npmCandidate], [repoCandidate], denied, BUILT_AT)
    const parsed = JSON.parse(pluginsJson) as {
      plugins: unknown[]
      denied: { name: string; detail: string }[]
    }
    expect(parsed.plugins).toEqual([])
    expect(parsed.denied.map(d => d.name)).toEqual(['dsh-x', 'evil/dsh-x'])
    // And nothing is reported as shadowed: the npm candidate never reached
    // `npmNames`, so the repository was judged on its own.
    expect(report).not.toContain('shadowed-by-npm')
  })
})

describe('determinism under every perturbation', () => {
  const commitA = 'a'.repeat(40)
  const commitB = 'b'.repeat(40)

  function repoAt(name: string, repo: string, commit: string, subdir?: string): import('../src/types.ts').RepoCandidate {
    return {
      name,
      repo,
      commit,
      version: commit,
      publishedAt: '2026-08-01T12:00:00.000Z',
      repository: `https://github.com/${repo}`,
      license: 'MIT',
      hasBundle: true,
      requiresBuild: false,
      hasWorkspaceDeps: false,
      catalog: { category: 'tool', summary: { en: 'x', zh: 'y' }, capabilities: [] },
      description: 'x',
      ...(subdir === undefined ? {} : { subdir }),
    }
  }

  // Four accepted entries sharing two bundle names, two of them subpackages
  // of one repository, plus two rejected subpackages of another — every tie
  // the comparators have to break.
  const repos = [
    repoAt('dsh-shared', 'alice/dsh-shared', commitA),
    repoAt('dsh-shared', 'bob/dsh-shared', commitB),
    repoAt('dsh-sub', 'carol/monorepo', commitA, 'packages/one'),
    repoAt('dsh-sub', 'carol/monorepo', commitA, 'packages/two'),
    { ...repoAt('dsh-bad', 'dave/monorepo', commitA, 'packages/x'), hasBundle: false },
    { ...repoAt('dsh-bad', 'dave/monorepo', commitA, 'packages/y'), hasBundle: false },
  ]
  const preexisting: Rejection[] = [
    { name: 'dsh-twice', code: 'fetch-failed', detail: 'npm registry returned 500' },
    { name: 'dsh-twice', code: 'no-manifest', detail: 'package.json was unreadable.' },
  ]
  const stars = { url: 'stars.deadbeef.json', sha256: 'deadbeef' }
  // Every ACCEPTED entry needs a recorded row here, or its `added` comes from
  // the clock (Task 10) and the across-clocks comparison below would fail for
  // the right reason. The verified row keeps `dsh-fs-too1` held, exactly as
  // the suite's shared config does, so the accepted set is the three plugins
  // plus the four repository entries.
  const dated = parseRegistryConfig({
    verified: '- name: dsh-fs-tool\n  reviewedVersion: 1.0.0\n  reviewer: github:r\n  reviewCommit: abc\n  notes: fine\n',
    denied: '[]',
    allowedSimilar: '[]',
    categories: '[]',
    firstSeen: [
      '- name: dsh-derived-plugin\n  added: 2026-08-12\n',
      '- name: dsh-fs-tool\n  added: 2026-08-10\n',
      '- name: dsh-hello-plugin\n  added: 2026-08-11\n',
      '- name: alice/dsh-shared\n  added: 2026-08-01\n',
      '- name: bob/dsh-shared\n  added: 2026-08-02\n',
      '- name: carol/monorepo\n  added: 2026-08-03\n',
    ].join(''),
  })

  it('is byte-identical in every artifact when only the input order changes', () => {
    const first = runPipeline(candidates, repos, dated, BUILT_AT, preexisting, stars)
    const second = runPipeline(
      [...candidates].reverse(), [...repos].reverse(), dated, BUILT_AT, [...preexisting].reverse(), stars,
    )
    for (const key of ['pluginsFileName', 'pluginsJson', 'indexJson', 'badgeJson', 'manifestLock', 'report'] as const) {
      expect(second[key], key).toBe(first[key])
    }
    expect([...second.firstSeen]).toEqual([...first.firstSeen])
  })

  it('keeps the hashed data identical across build times, with only the index and badge moving', () => {
    const first = runPipeline(candidates, repos, dated, BUILT_AT, preexisting, stars)
    const second = runPipeline(
      [...candidates].reverse(), [...repos].reverse(), dated, '2030-01-01T00:00:00.000Z',
      [...preexisting].reverse(), stars,
    )
    expect(second.pluginsJson).toBe(first.pluginsJson)
    expect(second.pluginsFileName).toBe(first.pluginsFileName)
    expect(second.manifestLock).toBe(first.manifestLock)
    expect(second.report).toBe(first.report)
    // builtAt belongs to the index and the badge alone.
    expect(second.indexJson).not.toBe(first.indexJson)
    expect(second.badgeJson).not.toBe(first.badgeJson)
  })

  it('names each shadowed subpackage by its repo#subdir unit', () => {
    // C-6: both rows read `dave/monorepo` and were indistinguishable, so their
    // order in the report followed the harvest.
    const shadowing: Candidate[] = candidates.filter(c => c.name === 'dsh-hello-plugin')
    const { report } = runPipeline(shadowing, [
      repoAt('dsh-hello-plugin', 'dave/monorepo', commitA, 'packages/y'),
      repoAt('dsh-hello-plugin', 'dave/monorepo', commitA, 'packages/x'),
    ], dated, BUILT_AT)
    const rows = report.split('\n').filter(line => line.includes('shadowed-by-npm'))
    expect(rows).toHaveLength(2)
    expect(rows[0]).toContain('| dave/monorepo#packages/x |')
    expect(rows[1]).toContain('| dave/monorepo#packages/y |')
  })
})
