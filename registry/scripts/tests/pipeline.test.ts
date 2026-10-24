import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { assertIconsInFile, budgetBeforeDeadline, describeLostIconsFile, describeRereadStopped, parseBudgetVariable, parseDeadlineVariable, repoPeersEmitted, runPipeline, selectEntries, unmatchedRegistryNotes, withholdRepoPeers } from '../src/pipeline.ts'
import { parseRegistryConfig } from '../src/config.ts'
import { lockNpmNames, SCHEMA_VERSION, type IconsPointer } from '../src/emit.ts'
import { sha256Hex } from '../src/icon-bytes.ts'
import { planIconWork, type IconFetchResult, type IconSubject } from '../src/icon-plan.ts'
import { npmIconKey, type IconKey, type IconOutcome } from '../src/icon-state.ts'
import type { IconsFile } from '../src/icons-assemble.ts'
import type { Candidate, Rejection, RepoCandidate } from '../src/types.ts'

const candidates = JSON.parse(
  // Resolved from THIS module, not the cwd: a cwd-relative fixture path makes
  // the suite pass or fail on where it was invoked from, and running it from
  // any other directory raised ENOENT before this.
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'packuments.json'), 'utf8'),
) as Candidate[]

const config = parseRegistryConfig({
  verified: '- name: dsh-fs-tool\n  reviewedVersion: 1.0.0\n  reviewer: github:r\n  reviewCommit: abc\n  notes: fine\n',
  denied: '[]',
  allowedSimilar: '[]',
  withheldIcons: '[]',
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

  it('reports all five rejections with their codes', () => {
    const { report } = runPipeline(candidates, [], config, BUILT_AT)
    expect(report).toContain('| dsh-lib-only | no-bundle |')
    expect(report).toContain('| dsh-no-license | no-license |')
    expect(report).toContain('| dsh-fs-too1 | name-too-similar |')
    expect(report).toContain('| dsh-no-summary | no-summary |')
    expect(report).toContain('| dsh-bad-catalog | invalid-catalog |')
  })

  it('publishes the invalid-catalog row escaped, and lists nothing for that package', () => {
    const { report, pluginsJson } = runPipeline(candidates, [], config, BUILT_AT)
    // The row a plugin author reads to find out why their text never appeared,
    // produced end to end rather than at the unit gate (H-8). The
    // author-supplied key name reaches a PUBLISHED artifact, so the `|` it
    // carries has to be escaped or it forges a column in the table.
    expect(report).toContain(
      '| dsh-bad-catalog | invalid-catalog | dsh.catalog.(root): Unrecognized key: "tags \\| extra" |',
    )
    // "rejected, never downgraded to a derived listing" (CLAUDE.md): the
    // package has a usable npm description, and it still must not list.
    const parsed = JSON.parse(pluginsJson) as { plugins: { name: string }[] }
    expect(parsed.plugins.map(p => p.name)).toEqual(['dsh-derived-plugin', 'dsh-fs-tool', 'dsh-hello-plugin'])
  })

  it('merges a pre-existing rejection into the emitted report', () => {
    const preexisting: Rejection[] = [
      { name: 'dsh-rate-limited', code: 'fetch-failed', detail: 'npm registry returned 429 fetching dsh-rate-limited' },
    ]
    const { report } = runPipeline(candidates, [], config, BUILT_AT, preexisting)
    expect(report).toContain('| dsh-rate-limited | fetch-failed | npm registry returned 429 fetching dsh-rate-limited |')
  })

  it('stays byte-identical when a derived listing carries a categories row', () => {
    const categorized = parseRegistryConfig({
      verified: '- name: dsh-fs-tool\n  reviewedVersion: 1.0.0\n  reviewer: github:r\n  reviewCommit: abc\n  notes: fine\n',
      denied: '[]',
      allowedSimilar: '[]',
      withheldIcons: '[]',
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
      withheldIcons: '[]',
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
      withheldIcons: '[]',
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
      withheldIcons: '[]',
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

  it('keeps an integrity that would forge a manifest.lock line out of the lock and the names read back from it', () => {
    // The lock is `name version integrity`, one entry per line, and the next
    // build reads it back as the npm names the last catalog listed (design
    // 2026-09-26-market-borrowings §8.2). A newline in an author-supplied
    // integrity would end its line and add one naming any package at all.
    // No first-seen row is needed: an accepted name is stamped with the build
    // date, so without the gate's rule this candidate lists and the forged
    // line reaches the lock, which is what the assertions below would catch.
    const forger: Candidate = {
      name: 'dsh-forger-plugin',
      version: '1.0.0',
      integrity: 'sha512-x\nforged-name 1.0.0 sha512-y',
      publishedAt: '2026-08-01T12:00:00.000Z',
      repository: 'https://github.com/you/forger-plugin',
      license: 'MIT',
      deprecated: false,
      hasBundle: true,
      catalog: { category: 'tool', summary: { en: 'x', zh: 'y' }, capabilities: [] },
      description: 'A plugin.',
      keywords: [],
      peers: [],
    }
    const clean = runPipeline(candidates, [], config, BUILT_AT)
    const { manifestLock, report } = runPipeline([...candidates, forger], [], config, BUILT_AT)
    expect(manifestLock).toBe(clean.manifestLock)
    expect(lockNpmNames(manifestLock)).toEqual(['dsh-derived-plugin', 'dsh-fs-tool', 'dsh-hello-plugin'])
    expect(report).toContain('| dsh-forger-plugin | no-integrity |')
  })

  it('sorts departure rows with every other rejection, whatever order they arrive in (design 2026-09-26-market-borrowings §8.4)', () => {
    const rows: Rejection[] = [
      { name: 'dsh-z', code: 'npm-gone', detail: 'npm no longer has a package of this name: the registry answers 404.' },
      { name: 'dsh-y', code: 'deprecated', detail: 'Marked deprecated on npm.' },
    ]
    const forward = runPipeline(candidates, [], config, BUILT_AT, rows)
    const reversed = runPipeline(candidates, [], config, BUILT_AT, [...rows].reverse())
    expect(forward.report).toBe(reversed.report)
    expect(forward.report).toContain('| dsh-z | npm-gone | npm no longer has a package of this name: the registry answers 404. |')
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
      verified: '[]', denied: '[]', allowedSimilar: '[]', withheldIcons: '[]', categories: '[]', firstSeen: '[]',
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
      verified: '[]', denied: '[]', allowedSimilar: '[]', withheldIcons: '[]', categories: '[]',
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

  it('shadows the repository the npm package names as its source, with a reason', () => {
    // The fixture's `dsh-hello-plugin` declares `you/hello-plugin`, so this is
    // the package's own repository, hidden with no hint: there is no other
    // plugin to judge (design 2026-10-19-npm-shadow-by-owner §2-§3).
    const { report, pluginsJson } = runPipeline(candidates, [{
      ...repoCandidate,
      name: 'dsh-hello-plugin',
      repo: 'you/hello-plugin',
      repository: 'https://github.com/you/hello-plugin',
    }], config, BUILT_AT)
    expect(report).toContain(
      '| you/hello-plugin | shadowed-by-npm | The npm package dsh-hello-plugin names this repository as its source and is already listed; the repository is not listed separately. |',
    )
    const parsed = JSON.parse(pluginsJson) as { plugins: { source: string }[] }
    expect(parsed.plugins.filter(plugin => plugin.source === 'github')).toEqual([])
  })

  it('lists another owner\'s repository beside the npm package of its name', () => {
    // `someone/dsh-repo-plugin` is neither the package's repository nor
    // another of its owner's, so it is a plugin that happens to choose the
    // same name (issue #88): the gate judges it on its own, and it is listed.
    const { report, pluginsJson } = runPipeline(candidates, [{ ...repoCandidate, name: 'dsh-hello-plugin' }], config, BUILT_AT)
    expect(report).not.toContain('shadowed-by-npm')
    const parsed = JSON.parse(pluginsJson) as { plugins: { name: string; source: string; repo?: string }[] }
    const named = parsed.plugins.filter(plugin => plugin.name === 'dsh-hello-plugin')
    expect(named.map(plugin => [plugin.source, plugin.repo ?? null])).toEqual([
      ['github', 'someone/dsh-repo-plugin'],
      ['npm', null],
    ])
  })

  it('escapes a | the npm package declares in its repository name', () => {
    // The sentence quotes the owner and name read out of the package's own
    // `repository`, which is attacker-controlled text, so it reaches the
    // report through the same cell writer as every other detail: a backslash
    // stands before the pipe, where an unescaped one would end the detail
    // cell early and add a column to the row.
    const piped = candidates.filter(candidate => candidate.name === 'dsh-hello-plugin')
      .map(candidate => ({ ...candidate, repository: 'https://github.com/you/hello|plugin' }))
    expect(piped).toHaveLength(1)
    const { report } = runPipeline(piped, [{
      ...repoCandidate,
      name: 'dsh-hello-plugin',
      repo: 'you/hello-plugin-next',
      repository: 'https://github.com/you/hello-plugin-next',
    }], config, BUILT_AT)
    expect(report).toContain(
      '| you/hello-plugin-next | shadowed-by-npm | The npm package dsh-hello-plugin is already listed and names you/hello\\|plugin as its source: a repository of the same owner, either this one under an earlier name or another.',
    )
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

  it('emits archived: true on a github entry whose candidate carries the flag (design §1.3)', () => {
    const { pluginsJson } = runPipeline([], [{ ...repoCandidate, archived: true }], config, BUILT_AT)
    const parsed = JSON.parse(pluginsJson) as { plugins: { name: string; archived?: true }[] }
    expect(parsed.plugins[0]?.archived).toBe(true)
    // An npm entry never carries the flag — the field is github-only.
    const npmArtifacts = runPipeline(candidates, [], config, BUILT_AT)
    const npmParsed = JSON.parse(npmArtifacts.pluginsJson) as { plugins: { name: string; archived?: true }[] }
    expect(npmParsed.plugins.every(p => !('archived' in p))).toBe(true)
  })

  it('omits archived on a github entry whose candidate has none', () => {
    const { pluginsJson } = runPipeline([], [repoCandidate], config, BUILT_AT)
    const parsed = JSON.parse(pluginsJson) as { plugins: { name: string; archived?: true }[] }
    expect(parsed.plugins[0]).not.toHaveProperty('archived')
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
    verified: '[]', denied: '[]', allowedSimilar: '[]', withheldIcons: '[]', categories: '[]',
    firstSeen: '- name: dsh-hostile-plugin\n  added: 2026-08-11\n',
  })

  const hostile: Candidate = {
    name: 'dsh-hostile-plugin',
    version: '1.0.0\uD800',
    // Well formed, unlike every field around it: the gate admits an integrity
    // only as SRI hashes, so a lone surrogate there is refused before emit
    // sees it (gate.test.ts) and would delist this entry, leaving the
    // absence assertions below to pass over an empty catalog.
    integrity: 'sha512-x',
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
    // Listed first: an absence over an empty catalog proves nothing, and a
    // gate rule that refuses this fixture empties it without turning anything
    // here red.
    expect((JSON.parse(pluginsJson) as { plugins: unknown[] }).plugins).toHaveLength(1)
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
    expect(entry?.name).toBe('dsh-hostile-plugin')
    const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
    for (const field of ['version', 'integrity', 'repository', 'license', 'publisher']) {
      expect(lone.test(String(entry?.[field] ?? '')), field).toBe(false)
    }
    for (const peer of (entry?.peers as string[] | undefined) ?? []) {
      expect(lone.test(peer), 'peers').toBe(false)
    }
  })

  it('covers a github entry\'s manifest version and its harness peer names, keys included', () => {
    // Both are manifest text copied verbatim (design
    // 2026-09-28-bundle-components-and-github-peers, section 6.1), bounded on
    // length alone, and a harness peer's NAME is a key of `dshPeers`.
    const commit = 'f'.repeat(40)
    const hostileRepo: RepoCandidate = {
      name: 'dsh-hostile-repo',
      repo: 'someone/dsh-hostile-repo',
      commit,
      version: commit,
      publishedAt: '2026-08-01T12:00:00.000Z',
      repository: 'https://github.com/someone/dsh-hostile-repo',
      license: 'MIT',
      hasBundle: true,
      requiresBuild: false,
      hasWorkspaceDeps: false,
      catalog: { category: 'tool', summary: { en: 'x', zh: 'y' }, capabilities: [] },
      description: 'x',
      dshPeers: { '@deepseek-ai/dsh-x\uD800': '^0.1.7-0\uDC00' },
      manifestVersion: '1.0.0\uD800',
    }
    const { pluginsJson } = runPipeline([], [hostileRepo], hostileConfig, BUILT_AT)
    const entry = (JSON.parse(pluginsJson) as { plugins: { dshPeers?: Record<string, string>; manifestVersion?: string }[] }).plugins[0]
    // Listed first, for the reason the case above gives.
    expect(entry?.manifestVersion).toBe('1.0.0\uFFFD')
    expect(entry?.dshPeers).toEqual({ '@deepseek-ai/dsh-x\uFFFD': '^0.1.7-0\uFFFD' })
    expect(LONE_SURROGATE_ESCAPE.test(pluginsJson)).toBe(false)
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
      withheldIcons: '[]',
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
    // `acceptedNpm`, so the repository was judged on its own.
    expect(report).not.toContain('shadowed-by-npm')
  })
})

/** `runPipeline`'s icons argument: the index pointer and the sha256 that keys each entry's icon, by install identity. */
type Icons = { pointer: IconsPointer; byIdentity: ReadonlyMap<string, string> }

describe('runPipeline with an icons sidecar', () => {
  // Digits, not the letters the suite's commits are made of, so a sha that
  // names an icon cannot be mistaken for one that pins a commit.
  const ICON_SHA = '1'.repeat(64)
  const FILE_SHA = 'f'.repeat(64)
  const pointer: IconsPointer = { url: `icons.${FILE_SHA}.json`, sha256: FILE_SHA }
  const stars = { url: 'stars.deadbeef.json', sha256: 'deadbeef' }
  type Published = { name: string; icon?: string } & Record<string, unknown>
  const pluginsOf = (pluginsJson: string): Published[] => (JSON.parse(pluginsJson) as { plugins: Published[] }).plugins
  const run = (icons: Icons | null) =>
    runPipeline(candidates, [], config, BUILT_AT, [], stars, SCHEMA_VERSION, icons)
  const hello: Icons = { pointer, byIdentity: new Map([['npm:dsh-hello-plugin', ICON_SHA]]) }

  it('sets the icon on the entry whose install identity the map names, and on no other', () => {
    const { pluginsJson } = run(hello)
    expect(pluginsOf(pluginsJson).map(p => [p.name, p.icon])).toEqual([
      ['dsh-derived-plugin', undefined],
      ['dsh-fs-tool', undefined],
      ['dsh-hello-plugin', ICON_SHA],
    ])
  })

  it('points the index at the icons file, after the stars pointer', () => {
    const index = JSON.parse(run(hello).indexJson) as Record<string, unknown>
    expect(index.icons).toEqual(pointer)
    expect(Object.keys(index).slice(-2)).toEqual(['stars', 'icons'])
  })

  it('writes neither the icon nor the pointer when it is handed no icons', () => {
    const none = run(null)
    expect(pluginsOf(none.pluginsJson).filter(p => 'icon' in p)).toEqual([])
    expect('icons' in (JSON.parse(none.indexJson) as object)).toBe(false)
    // And null is the default, so a caller that predates the sidecar gets the
    // same bytes it always did.
    const omitted = runPipeline(candidates, [], config, BUILT_AT, [], stars)
    for (const key of ['pluginsFileName', 'pluginsJson', 'indexJson', 'badgeJson', 'manifestLock', 'report'] as const) {
      expect(none[key], key).toBe(omitted[key])
    }
  })

  it('lets an icon decide nothing about the listing', () => {
    // CLAUDE.md: what is IN the catalog is the gate's decision and nothing
    // else's, and an icon is presentation. A map that names a candidate the
    // gate rejected (`dsh-lib-only`: no bundle) or one that was never
    // harvested must neither list it nor leave a trace in the report.
    const none = run(null)
    const handed = run({
      pointer,
      byIdentity: new Map([
        ['npm:dsh-hello-plugin', ICON_SHA],
        ['npm:dsh-lib-only', ICON_SHA],
        ['npm:dsh-never-harvested', ICON_SHA],
      ]),
    })
    for (const key of ['badgeJson', 'manifestLock', 'report'] as const) {
      expect(handed[key], key).toBe(none[key])
    }
    // The one difference in plugins.json is the icon key on the entry the map
    // names that is listed: strip it and the files are the same.
    const withoutIcon = ({ icon: _icon, ...rest }: Published): Record<string, unknown> => rest
    expect(pluginsOf(handed.pluginsJson).map(withoutIcon)).toEqual(pluginsOf(none.pluginsJson))
    expect(pluginsOf(handed.pluginsJson).filter(p => 'icon' in p).map(p => p.name)).toEqual(['dsh-hello-plugin'])
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

  // Five accepted repository entries — four sharing two bundle names, two of
  // them subpackages of one repository, and a fifth that is another owner's
  // repository named like the accepted npm package `dsh-hello-plugin` — plus
  // two rejected subpackages of another repository: every tie the comparators
  // have to break. The first carries the github harness peers and its
  // manifest version (design 2026-09-28-bundle-components-and-github-peers,
  // section 6), so every artifact each case below compares covers both
  // fields.
  const repos = [
    { ...repoAt('dsh-shared', 'alice/dsh-shared', commitA), dshPeers: { '@deepseek-ai/dsh': '0.1.5-rc.2' }, manifestVersion: '1.0.0' },
    repoAt('dsh-shared', 'bob/dsh-shared', commitB),
    repoAt('dsh-sub', 'carol/monorepo', commitA, 'packages/one'),
    repoAt('dsh-sub', 'carol/monorepo', commitA, 'packages/two'),
    repoAt('dsh-hello-plugin', 'erin/hello-fork', commitB),
    { ...repoAt('dsh-bad', 'dave/monorepo', commitA, 'packages/x'), hasBundle: false },
    { ...repoAt('dsh-bad', 'dave/monorepo', commitA, 'packages/y'), hasBundle: false },
  ]
  const preexisting: Rejection[] = [
    { name: 'dsh-twice', code: 'fetch-failed', detail: 'npm registry returned 500' },
    { name: 'dsh-twice', code: 'no-manifest', detail: 'package.json was unreadable.' },
  ]
  const stars = { url: 'stars.deadbeef.json', sha256: 'deadbeef' }
  // The icons sidecar's pointer and the identities the icon step published an
  // icon for. They pick out each tie the lookup has to break: the npm package
  // whose name a fork shares (`erin/hello-fork` gets none), one of two forks
  // sharing a bundle name (`bob/dsh-shared` gets none) and one of two
  // subpackages of a repository (`packages/one` gets none). Two entries share
  // an icon, as two plugins by one author can.
  const ICON_A = '1'.repeat(64)
  const ICON_B = '2'.repeat(64)
  const ICONS_FILE_SHA = 'f'.repeat(64)
  const iconRows: ReadonlyArray<readonly [string, string]> = [
    ['npm:dsh-hello-plugin', ICON_A],
    ['github:alice/dsh-shared#', ICON_B],
    ['github:carol/monorepo#packages/two', ICON_A],
  ]
  const iconsFrom = (rows: ReadonlyArray<readonly [string, string]>): Icons => ({
    pointer: { url: `icons.${ICONS_FILE_SHA}.json`, sha256: ICONS_FILE_SHA },
    byIdentity: new Map(rows),
  })
  // Every ACCEPTED entry needs a recorded row here, or its `added` comes from
  // the clock (Task 10) and the across-clocks comparison below would fail for
  // the right reason. The verified row keeps `dsh-fs-too1` held, exactly as
  // the suite's shared config does, so the accepted set is the three plugins
  // plus the five repository entries, one of them another owner's repository
  // named like an npm package.
  const dated = parseRegistryConfig({
    verified: '- name: dsh-fs-tool\n  reviewedVersion: 1.0.0\n  reviewer: github:r\n  reviewCommit: abc\n  notes: fine\n',
    denied: '[]',
    allowedSimilar: '[]',
    withheldIcons: '[]',
    categories: '[]',
    firstSeen: [
      '- name: dsh-derived-plugin\n  added: 2026-08-12\n',
      '- name: dsh-fs-tool\n  added: 2026-08-10\n',
      '- name: dsh-hello-plugin\n  added: 2026-08-11\n',
      '- name: alice/dsh-shared\n  added: 2026-08-01\n',
      '- name: bob/dsh-shared\n  added: 2026-08-02\n',
      '- name: carol/monorepo\n  added: 2026-08-03\n',
      '- name: erin/hello-fork\n  added: 2026-08-04\n',
    ].join(''),
  })

  it('is byte-identical in every artifact under a reversed input and a repeated run', () => {
    const first = runPipeline(candidates, repos, dated, BUILT_AT, preexisting, stars, SCHEMA_VERSION, iconsFrom(iconRows))
    // The icon map is an input too, and its order is the order the icon step
    // met the entries in, which is the catalog's input order: the reversed run
    // inserts the same rows the other way round, so an artifact built by
    // iterating the map and not by looking each entry up would move.
    const second = runPipeline(
      [...candidates].reverse(), [...repos].reverse(), dated, BUILT_AT, [...preexisting].reverse(), stars,
      SCHEMA_VERSION, iconsFrom([...iconRows].reverse()),
    )
    // The same inputs a second time, which is a different claim from order
    // independence: it is what would catch a Set or Map iterated in insertion
    // order, or a clock read inside emit.
    const repeated = runPipeline(candidates, repos, dated, BUILT_AT, preexisting, stars, SCHEMA_VERSION, iconsFrom(iconRows))
    // The byte comparisons below hold just as well when erin's repository is
    // hidden, so without this they say nothing about an npm package and
    // another owner's repository of its name sharing one catalog.
    expect(first.pluginsJson).toContain('erin/hello-fork')
    for (const key of ['pluginsFileName', 'pluginsJson', 'indexJson', 'badgeJson', 'manifestLock', 'report'] as const) {
      expect(second[key], `${key} moved with input order`).toBe(first[key])
      expect(repeated[key], `${key} moved between runs`).toBe(first[key])
    }
    expect([...second.firstSeen]).toEqual([...first.firstSeen])
    expect([...repeated.firstSeen]).toEqual([...first.firstSeen])
    // The sidecar pointers ride the index and are not otherwise perturbed.
    const index = JSON.parse(first.indexJson) as { stars: unknown; icons: unknown }
    expect(index.stars).toEqual(stars)
    expect(index.icons).toEqual(iconsFrom(iconRows).pointer)
    // And the icons are on the entries, or every comparison above would hold
    // just as well for a pipeline that dropped them.
    expect(first.pluginsJson).toContain(ICON_A)
    expect(first.pluginsJson).toContain(ICON_B)
  })

  it('gives an icon to the entry whose identity the map names, and to no other entry of its name', () => {
    const { pluginsJson } = runPipeline(candidates, repos, dated, BUILT_AT, preexisting, stars, SCHEMA_VERSION, iconsFrom(iconRows))
    const plugins = (JSON.parse(pluginsJson) as {
      plugins: { name: string; source: string; repo?: string; subdir?: string; icon?: string }[]
    }).plugins
    expect(plugins.map(p => [p.name, p.source, p.repo ?? null, p.subdir ?? null, p.icon ?? null])).toEqual([
      ['dsh-derived-plugin', 'npm', null, null, null],
      ['dsh-fs-tool', 'npm', null, null, null],
      // A fork that shares the npm package's name does not inherit its icon...
      ['dsh-hello-plugin', 'github', 'erin/hello-fork', null, null],
      ['dsh-hello-plugin', 'npm', null, null, ICON_A],
      // ...and neither do the other claimants of a bundle name or the sibling
      // subpackage of a repository.
      ['dsh-shared', 'github', 'alice/dsh-shared', null, ICON_B],
      ['dsh-shared', 'github', 'bob/dsh-shared', null, null],
      ['dsh-sub', 'github', 'carol/monorepo', 'packages/one', null],
      ['dsh-sub', 'github', 'carol/monorepo', 'packages/two', ICON_A],
    ])
  })

  it('keeps the hashed data identical across build times, with only the index and badge moving', () => {
    const first = runPipeline(candidates, repos, dated, BUILT_AT, preexisting, stars, SCHEMA_VERSION, iconsFrom(iconRows))
    const second = runPipeline(
      [...candidates].reverse(), [...repos].reverse(), dated, '2030-01-01T00:00:00.000Z',
      [...preexisting].reverse(), stars, SCHEMA_VERSION, iconsFrom([...iconRows].reverse()),
    )
    expect(second.pluginsJson).toBe(first.pluginsJson)
    expect(second.pluginsFileName).toBe(first.pluginsFileName)
    expect(second.manifestLock).toBe(first.manifestLock)
    expect(second.report).toBe(first.report)
    // builtAt belongs to the index and the badge alone.
    expect(second.indexJson).not.toBe(first.indexJson)
    expect(second.badgeJson).not.toBe(first.badgeJson)
  })

  it('publishes the harness peers and manifest version it is handed, on that github entry alone', () => {
    // The two cases above are only as strong as the fields the artifacts
    // carry: an emitter that dropped both would be byte-identical too.
    const { pluginsJson } = runPipeline(candidates, repos, dated, BUILT_AT, preexisting, stars)
    const plugins = (JSON.parse(pluginsJson) as { plugins: { repo?: string; dshPeers?: unknown; manifestVersion?: unknown }[] }).plugins
    const carrying = plugins.filter(plugin => plugin.dshPeers !== undefined || plugin.manifestVersion !== undefined)
    expect(carrying.map(plugin => [plugin.repo, plugin.dshPeers, plugin.manifestVersion])).toEqual([
      ['alice/dsh-shared', { '@deepseek-ai/dsh': '0.1.5-rc.2' }, '1.0.0'],
    ])
  })

  it('names each shadowed subpackage by its repo#subdir unit', () => {
    // C-6: both rows read `you/hello-plugin` and were indistinguishable, so
    // their order in the report followed the harvest. They are subpackages of
    // the repository the npm package names, which is what hides them.
    const shadowing: Candidate[] = candidates.filter(c => c.name === 'dsh-hello-plugin')
    const { report } = runPipeline(shadowing, [
      repoAt('dsh-hello-plugin', 'you/hello-plugin', commitA, 'packages/y'),
      repoAt('dsh-hello-plugin', 'you/hello-plugin', commitA, 'packages/x'),
    ], dated, BUILT_AT)
    const rows = report.split('\n').filter(line => line.includes('shadowed-by-npm'))
    expect(rows).toHaveLength(2)
    expect(rows[0]).toContain('| you/hello-plugin#packages/x |')
    expect(rows[1]).toContain('| you/hello-plugin#packages/y |')
  })

  it('lists each subpackage of another owner\'s repository beside the npm package', () => {
    // The case above with a monorepo that belongs to someone other than the
    // package's owner (`you`): none of its subpackages is the package's
    // source, so each is judged on its own and listed.
    const shadowing: Candidate[] = candidates.filter(c => c.name === 'dsh-hello-plugin')
    const { report, pluginsJson } = runPipeline(shadowing, [
      repoAt('dsh-hello-plugin', 'dave/monorepo', commitA, 'packages/y'),
      repoAt('dsh-hello-plugin', 'dave/monorepo', commitA, 'packages/x'),
    ], dated, BUILT_AT)
    expect(report).not.toContain('shadowed-by-npm')
    const parsed = JSON.parse(pluginsJson) as { plugins: { name: string; source: string; repo?: string; subdir?: string }[] }
    const named = parsed.plugins.filter(plugin => plugin.name === 'dsh-hello-plugin')
    expect(named.map(plugin => [plugin.source, plugin.repo ?? null, plugin.subdir ?? null])).toEqual([
      ['github', 'dave/monorepo', 'packages/x'],
      ['github', 'dave/monorepo', 'packages/y'],
      ['npm', null, null],
    ])
  })
})

describe('the LLM-only market verdicts reach the build report', () => {
  it('names every listing withheld on an LLM verdict alone, so it can be spot-checked', () => {
    const withLlmVerdict = parseRegistryConfig({
      verified: '[]',
      denied: '[]',
      allowedSimilar: '[]',
      withheldIcons: '[]',
      categories: '[]',
      firstSeen: '- name: dsh-hello-plugin\n  added: 2026-08-11\n- name: dsh-derived-plugin\n  added: 2026-08-12\n- name: dsh-fs-tool\n  added: 2026-08-10\n',
      markets: [
        '- name: dsh-hello-plugin\n  market: true\n  by: llm\n  reason: looks like a market\n',
        // A human verdict needs no spot-check, and there are 45 of them live:
        // listing those would bury the rows that do need one.
        '- name: dsh-derived-plugin\n  market: true\n  by: human\n  reason: really is a market\n',
        // An LLM verdict about a name this build did not list is noise — the
        // reader cannot act on a row that reaches no entry.
        '- name: dsh-not-harvested\n  market: true\n  by: llm\n  reason: looks like a market\n',
      ].join(''),
    })
    const { report, pluginsJson } = runPipeline(candidates, [], withLlmVerdict, BUILT_AT)
    expect(report).toContain('Withheld from the shelf on an LLM verdict alone: 1')
    expect(report).toContain('- dsh-hello-plugin')
    expect(report, 'a human verdict needs no spot-check').not.toContain('- dsh-derived-plugin')
    expect(report, 'a row reaching no listed entry is noise').not.toContain('- dsh-not-harvested')
    // The verdict decides, so the name is NOT cleared. The report line is the
    // whole review mechanism: a recorded row is never re-asked, so nothing
    // else would ever surface an LLM-only withholding.
    const parsed = JSON.parse(pluginsJson) as { notAShop: string[] }
    expect(parsed.notAShop).not.toContain('dsh-hello-plugin')
  })

  it('says nothing when no listing was withheld by the classifier alone', () => {
    const { report } = runPipeline(candidates, [], config, BUILT_AT)
    expect(report).not.toContain('Withheld from the shelf')
  })

  it('publishes each cleared name once, however many entries share it', () => {
    // A-8 adjacent: `notAShop` was built one element per ENTRY, and 151 live
    // names are shared by 243 entries.
    const commit = 'f'.repeat(40)
    const cleared = parseRegistryConfig({
      verified: '[]', denied: '[]', allowedSimilar: '[]', withheldIcons: '[]', categories: '[]',
      firstSeen: '- name: alice/dsh-store\n  added: 2026-08-01\n- name: bob/dsh-store\n  added: 2026-08-02\n',
      markets: '- name: dsh-store\n  market: false\n  by: human\n  reason: stores session logs\n',
    })
    const base: import('../src/types.ts').RepoCandidate = {
      name: 'dsh-store', repo: 'alice/dsh-store', commit, version: commit,
      publishedAt: '2026-08-01T12:00:00.000Z', repository: 'https://github.com/alice/dsh-store',
      license: 'MIT', hasBundle: true, requiresBuild: false, hasWorkspaceDeps: false,
      catalog: { category: 'tool', summary: { en: 'x', zh: 'y' }, capabilities: [] },
      description: 'x',
    }
    const { pluginsJson } = runPipeline([], [
      base,
      { ...base, repo: 'bob/dsh-store', repository: 'https://github.com/bob/dsh-store' },
    ], cleared, BUILT_AT)
    const parsed = JSON.parse(pluginsJson) as { notAShop: string[] }
    expect(parsed.notAShop).toEqual(['dsh-store'])
  })
})

describe('unmatchedRegistryNotes', () => {
  const commit = 'c'.repeat(40)
  const npmCandidate = candidates.find(c => c.name === 'dsh-hello-plugin')
  if (npmCandidate === undefined) throw new Error('fixture dsh-hello-plugin is missing')
  const repoCandidate: import('../src/types.ts').RepoCandidate = {
    name: 'dsh-repo-plugin', repo: 'Someone/dsh-repo-plugin', commit, version: commit,
    publishedAt: '2026-08-01T12:00:00.000Z', repository: 'https://github.com/Someone/dsh-repo-plugin',
    license: 'MIT', hasBundle: true, requiresBuild: false, hasWorkspaceDeps: false,
    catalog: { category: 'tool', summary: { en: 'x', zh: 'y' }, capabilities: [] },
    description: 'x',
  }
  // The two candidates as the gate lists them: what a withheld icon row has to
  // name. `repo` keeps the case GitHub spells it in.
  const listedNpm = { source: 'npm', name: 'dsh-hello-plugin' } as const
  const listedRepo = { source: 'github', name: 'dsh-repo-plugin', repo: 'Someone/dsh-repo-plugin' } as const

  it('says nothing when every row matched something', () => {
    const matched = parseRegistryConfig({
      verified: '- name: dsh-hello-plugin\n  reviewedVersion: 1.0.0\n  reviewer: r\n  reviewCommit: c\n',
      denied: '- name: someone/dsh-repo-plugin\n  reason: known bad actor\n',
      allowedSimilar: '- dsh-hello-plugin\n',
      withheldIcons: '[]',
      categories: '[]',
      firstSeen: '[]',
    })
    expect(unmatchedRegistryNotes([npmCandidate], [repoCandidate], matched, [])).toEqual([])
  })

  it('names every row that matched nothing, with its file, sorted', () => {
    // A denial nobody can act on is worse than none: it reads as protection.
    const stale = parseRegistryConfig({
      verified: [
        '- name: dsh-unpublished\n  reviewedVersion: 1.0.0\n  reviewer: r\n  reviewCommit: c\n',
        `- name: dsh-renamed\n  repo: old/dsh-renamed\n  reviewedCommit: ${commit}\n  reviewer: r\n  reviewCommit: c\n`,
      ].join(''),
      denied: '- name: DSH-Evil\n  reason: typed in the wrong case\n',
      allowedSimilar: '- dsh-gone\n',
      withheldIcons: '[]',
      categories: '[]',
      firstSeen: '[]',
    })
    expect(unmatchedRegistryNotes([npmCandidate], [repoCandidate], stale, [])).toEqual([
      'Registry rows that matched no harvested candidate this run:',
      '- allowed-similar.yml: dsh-gone',
      '- denied.yml: DSH-Evil',
      '- verified.yml: dsh-unpublished',
      '- verified.yml: old/dsh-renamed',
    ])
  })

  it('matches a repo row case-folded, and a denial against the bundle name too', () => {
    // A review and a denial of the same name cannot coexist (Task 4 throws),
    // so the two shapes are checked one config at a time. The candidate's
    // repo is `Someone/dsh-repo-plugin`, spelled differently in both rows.
    const reviewedAndCleared = parseRegistryConfig({
      verified: `- name: dsh-repo-plugin\n  repo: someone/dsh-repo-plugin\n  reviewedCommit: ${commit}\n  reviewer: r\n  reviewCommit: c\n`,
      denied: '[]',
      allowedSimilar: '- SOMEONE/dsh-repo-plugin\n',
      withheldIcons: '[]',
      categories: '[]',
      firstSeen: '[]',
    })
    expect(unmatchedRegistryNotes([], [repoCandidate], reviewedAndCleared, [])).toEqual([])

    const deniedByBundleName = parseRegistryConfig({
      verified: '[]',
      denied: '- name: dsh-repo-plugin\n  reason: denied by bundle name\n',
      allowedSimilar: '[]',
      withheldIcons: '[]',
      categories: '[]',
      firstSeen: '[]',
    })
    expect(unmatchedRegistryNotes([], [repoCandidate], deniedByBundleName, [])).toEqual([])
  })

  it('says nothing about a withheld icon row that names a listed entry, in whatever case a repository is written', () => {
    // The row is looked up the way the icon planner looks it up, by the key
    // `firstSeenKey` gives the entry: an npm name as written, a repository
    // lower-cased. `SOMEONE/...` below is the entry's `Someone/...` in
    // another case, and loads as one project.
    const withheld = parseRegistryConfig({
      verified: '[]',
      denied: '[]',
      allowedSimilar: '[]',
      withheldIcons: '- name: dsh-hello-plugin\n  reason: not ours to show\n- name: SOMEONE/dsh-repo-plugin\n  reason: not ours to show\n',
      categories: '[]',
      firstSeen: '[]',
    })
    expect(unmatchedRegistryNotes([npmCandidate], [repoCandidate], withheld, [listedNpm, listedRepo])).toEqual([])
  })

  it('names a withheld icon row that matches no listed entry, under its own heading after the other files\' rows', () => {
    // The hazard is the one the other three files have: a well-formed but
    // mistyped name loads, matches nothing, and the icon it was written to
    // hold back stays published. `dsh-hello-plugn` is `dsh-hello-plugin` with
    // a letter dropped; `zeta-gone` and `Alpha/gone` have left; and
    // `dsh-repo-plugin` is the BUNDLE name of the listed repository, which a
    // row cannot use: a repository is keyed by its owner/slug.
    const stale = parseRegistryConfig({
      verified: '- name: dsh-unpublished\n  reviewedVersion: 1.0.0\n  reviewer: r\n  reviewCommit: c\n',
      denied: '[]',
      allowedSimilar: '[]',
      withheldIcons: [
        '- name: zeta-gone\n  reason: r\n',
        '- name: dsh-hello-plugn\n  reason: r\n',
        '- name: Alpha/gone\n  reason: r\n',
        '- name: dsh-repo-plugin\n  reason: r\n',
      ].join(''),
      categories: '[]',
      firstSeen: '[]',
    })
    expect(unmatchedRegistryNotes([npmCandidate], [repoCandidate], stale, [listedNpm, listedRepo])).toEqual([
      'Registry rows that matched no harvested candidate this run:',
      '- verified.yml: dsh-unpublished',
      'withheld-icons.yml rows that named no listed entry this run:',
      '- withheld-icons.yml: alpha/gone',
      '- withheld-icons.yml: dsh-hello-plugn',
      '- withheld-icons.yml: dsh-repo-plugin',
      '- withheld-icons.yml: zeta-gone',
    ])
  })

  it('does not take a harvested candidate for a listed entry', () => {
    // An icon can be withheld only from an entry the catalog lists. A name
    // the harvest saw and the gate turned away (rejected, denied) lists
    // nothing, so a row naming it withholds nothing today. It is reported all
    // the same, rather than left to read as protection, and under a heading of
    // its own: the other files' heading says no harvested candidate matched,
    // which is false of this row, whose name the harvest did see.
    const turnedAway = parseRegistryConfig({
      verified: '[]',
      denied: '[]',
      allowedSimilar: '[]',
      withheldIcons: '- name: dsh-hello-plugin\n  reason: r\n',
      categories: '[]',
      firstSeen: '[]',
    })
    expect(unmatchedRegistryNotes([npmCandidate], [repoCandidate], turnedAway, [listedRepo])).toEqual([
      'withheld-icons.yml rows that named no listed entry this run:',
      '- withheld-icons.yml: dsh-hello-plugin',
    ])
  })

  it('rides the build report', () => {
    const stale = parseRegistryConfig({
      verified: '[]',
      denied: '- name: dsh-never-seen\n  reason: nothing matches this\n',
      allowedSimilar: '[]',
      withheldIcons: '[]',
      categories: '[]',
      firstSeen: '- name: dsh-hello-plugin\n  added: 2026-08-11\n- name: dsh-derived-plugin\n  added: 2026-08-12\n- name: dsh-fs-tool\n  added: 2026-08-10\n',
    })
    const { report } = runPipeline(candidates, [], stale, BUILT_AT)
    expect(report).toContain('Registry rows that matched no harvested candidate this run:')
    expect(report).toContain('- denied.yml: dsh-never-seen')
  })

  it('rides the build report for a withheld icon row, judged against what the pipeline lists', () => {
    // `dsh-hello-plugin` is listed by this fixture, so its row fires and is
    // not reported; `dsh-never-listed` is nobody's.
    const withheld = parseRegistryConfig({
      verified: '[]',
      denied: '[]',
      allowedSimilar: '[]',
      withheldIcons: '- name: dsh-hello-plugin\n  reason: r\n- name: dsh-never-listed\n  reason: r\n',
      categories: '[]',
      firstSeen: '- name: dsh-hello-plugin\n  added: 2026-08-11\n- name: dsh-derived-plugin\n  added: 2026-08-12\n- name: dsh-fs-tool\n  added: 2026-08-10\n',
    })
    const { report } = runPipeline(candidates, [], withheld, BUILT_AT)
    // Under its own heading; the other files' heading says no harvested
    // candidate matched, and no row of theirs is stale here.
    expect(report).toContain('withheld-icons.yml rows that named no listed entry this run:\n- withheld-icons.yml: dsh-never-listed')
    expect(report).not.toContain('Registry rows that matched no harvested candidate this run:')
    expect(report).not.toContain('- withheld-icons.yml: dsh-hello-plugin')
  })
})

describe('selectEntries', () => {
  it('produces exactly the entries runPipeline publishes, from the same inputs', () => {
    // This equality is the whole licence for build.ts calling selectEntries
    // before the network step and runPipeline after it. If the two could
    // disagree, the stars sidecar would be keyed off a different catalog than
    // the one that gets published — which is the class of bug the sidecar had
    // in the first place.
    const selected = selectEntries(candidates, [], config, BUILT_AT)
    const built = runPipeline(candidates, [], config, BUILT_AT)
    const published = (JSON.parse(built.pluginsJson) as { plugins: { name: string }[] }).plugins
    expect(selected.entries).toHaveLength(published.length)
    expect(selected.entries.map(e => e.name).sort()).toEqual(published.map(p => p.name).sort())
  })

  it('is a gate, so a rejected candidate is not among its entries', () => {
    const selected = selectEntries(candidates, [], config, BUILT_AT)
    const names = new Set(selected.entries.map(e => e.name))
    expect(selected.rejections.length).toBeGreaterThan(0)
    for (const rejection of selected.rejections) {
      // A rejection can share a NAME with an accepted entry from the other
      // channel (a shadowed repo), so this checks the npm-keyed ones only.
      if (rejection.code === 'shadowed-by-npm') continue
      expect(names.has(rejection.name), `${rejection.name} was both rejected and listed`).toBe(false)
    }
  })

  it('stamps added from the build date it is given, and a recorded row still wins', () => {
    // Purity: the one clock read lives in build.ts, and selectEntries is now a
    // second caller of the same value rather than a second reader of the clock.
    //
    // Both halves, because the shared config fixture happens to record every
    // name the packuments fixture yields — so a test that only looked for
    // freshly-stamped entries would have found none and proved nothing about
    // the date at all.
    const unrecorded = parseRegistryConfig({
      verified: '[]', denied: '[]', allowedSimilar: '[]', withheldIcons: '[]', categories: '[]', firstSeen: '[]',
    })
    const fresh = selectEntries(candidates, [], unrecorded, '2026-12-25T00:00:00.000Z')
    expect(fresh.entries.length).toBeGreaterThan(0)
    expect(fresh.entries.every(e => e.added === '2026-12-25')).toBe(true)

    // The same build date against the recorded fixture: every date is the
    // committed one, and none of them is today's.
    const recorded = selectEntries(candidates, [], config, '2026-12-25T00:00:00.000Z')
    expect(recorded.entries.length).toBeGreaterThan(0)
    expect(recorded.entries.some(e => e.added === '2026-12-25')).toBe(false)
  })
})

describe('repoPeersEmitted (SHOP_EMIT_REPO_PEERS)', () => {
  // Design 2026-09-01-harness-compatibility section 9.8: build.ts and
  // classify.ts each used to test the flag inline, and classify.ts's own
  // copy never existed at all — it ran gateRepo over
  // repo-state.json candidates with peers still attached, so the two steps
  // disagreed about which repositories cross the payload budget. One helper
  // both callers read closes that gap by construction: there is only one
  // place left that can drift from `'1'`.
  it('is true only for the exact string "1"', () => {
    expect(repoPeersEmitted('1')).toBe(true)
  })

  it('is false for every other value, including unset, empty, and truthy-looking strings', () => {
    expect(repoPeersEmitted(undefined)).toBe(false)
    expect(repoPeersEmitted('')).toBe(false)
    expect(repoPeersEmitted('0')).toBe(false)
    expect(repoPeersEmitted('true')).toBe(false)
    expect(repoPeersEmitted('yes')).toBe(false)
    // A leading/trailing space is not '1' either — the flag is set verbatim
    // in daily.yml, never through a shell that would trim it for us.
    expect(repoPeersEmitted(' 1')).toBe(false)
    expect(repoPeersEmitted('1 ')).toBe(false)
  })
})

describe('withholdRepoPeers (SHOP_EMIT_REPO_PEERS)', () => {
  // A shop from 0.8.3 or earlier judges any `peers` by node resolution alone,
  // which badges platform seed words (design 2026-09-01 §9.1), so github peers
  // are emitted only once the refining shop is `latest` (§9.8). The harvest
  // and repo-state.json are not this function's concern: it is applied to the
  // build's own copy of the candidates.
  const commit = 'd'.repeat(40)
  const repo = (name: string, peers: string[] | undefined): RepoCandidate => ({
    name,
    repo: `someone/${name}`,
    commit,
    version: commit,
    publishedAt: '2026-08-01T12:00:00.000Z',
    repository: `https://github.com/someone/${name}`,
    license: 'MIT',
    hasBundle: true,
    requiresBuild: false,
    hasWorkspaceDeps: false,
    catalog: { category: 'tool', summary: { en: 'x', zh: 'y' }, capabilities: [] },
    description: 'A repo plugin.',
    ...(peers === undefined ? {} : { peers }),
  })

  it('strips github peers while the flag is off, and counts only the ones that declared any', () => {
    const input = [repo('with-peers', ['react', '@x/absent']), repo('none', []), repo('unread', undefined)]
    const { candidates, withheld } = withholdRepoPeers(input, false)
    expect(candidates.map(candidate => 'peers' in candidate)).toEqual([false, false, false])
    // `[]` is withheld too — publishing it would be the same record — but it
    // declared nothing, so it is not counted as a withheld declaration.
    expect(withheld).toBe(1)
    // The input is left alone: the harvest's own record is not this
    // function's to change.
    expect(input[0]?.peers).toEqual(['react', '@x/absent'])
  })

  it('passes every candidate through unchanged once the flag is on', () => {
    const input = [repo('with-peers', ['react']), repo('unread', undefined)]
    expect(withholdRepoPeers(input, true)).toEqual({ candidates: input, withheld: 0 })
  })

  it('withholds `peers` alone: a github entry\'s harness peers and manifest version are published either way', () => {
    // No flag gates these two (design
    // 2026-09-28-bundle-components-and-github-peers, section 6.1): every shop
    // published before section 7.3 skips github entries in its peer verdict
    // and strips a key it does not declare, so no older reader acts on
    // either, unlike the `peers` a 0.8.3 shop misjudges.
    const dshPeers = { '@deepseek-ai/dsh': '0.1.5-rc.2' }
    const input = [{ ...repo('dsh-repo-peers', ['@deepseek-ai/dsh']), dshPeers, manifestVersion: '1.0.0' }]
    const kept = withholdRepoPeers(input, false).candidates[0]
    expect(kept).not.toHaveProperty('peers')
    expect(kept).toMatchObject({ dshPeers, manifestVersion: '1.0.0' })
    const parse = (json: string) => (JSON.parse(json) as { plugins: { name: string; peers?: string[]; dshPeers?: unknown; manifestVersion?: unknown }[] }).plugins
    const published = parse(runPipeline([], withholdRepoPeers(input, false).candidates, config, BUILT_AT).pluginsJson)
    expect(published.map(entry => [entry.name, entry.peers, entry.dshPeers, entry.manifestVersion]))
      .toEqual([['dsh-repo-peers', undefined, dshPeers, '1.0.0']])
  })

  it('publishes no github peers while withheld, and publishes them once emitted', () => {
    const parse = (json: string) => (JSON.parse(json) as { plugins: { name: string; peers?: string[] }[] }).plugins
    const input = [repo('dsh-repo-peers', ['@x/absent'])]
    const withheld = parse(runPipeline([], withholdRepoPeers(input, false).candidates, config, BUILT_AT).pluginsJson)
    expect(withheld.map(entry => [entry.name, entry.peers])).toEqual([['dsh-repo-peers', undefined]])
    const emitted = parse(runPipeline([], withholdRepoPeers(input, true).candidates, config, BUILT_AT).pluginsJson)
    expect(emitted.map(entry => [entry.name, entry.peers])).toEqual([['dsh-repo-peers', ['@x/absent']]])
  })

  it('does not charge withheld peers to the payload budget', () => {
    // The budget measures the bytes `emit` will write, so peers that will not
    // be written must not cost a listing. 128 names of 128 characters — both
    // exactly at their bounds, so no field rule fires first — serialize to a
    // block npm-client.ts measures at 17,959 bytes, past the 12,288-byte
    // budget on their own: emitted, the entry is refused; withheld, it lists.
    const peers = Array.from({ length: 128 }, (_, index) => `${'p'.repeat(124)}-${String(index).padStart(3, '0')}`)
    expect(peers.every(peer => peer.length === 128)).toBe(true)
    const heavy = [repo('dsh-heavy-peers', peers)]

    const emitted = runPipeline([], withholdRepoPeers(heavy, true).candidates, config, BUILT_AT)
    expect(JSON.parse(emitted.pluginsJson).plugins).toEqual([])
    expect(emitted.report).toMatch(/\| someone\/dsh-heavy-peers \| no-manifest \| Would publish \d+ bytes of catalog entry, past the 12288-byte budget/)

    const withheld = runPipeline([], withholdRepoPeers(heavy, false).candidates, config, BUILT_AT)
    const listed = (JSON.parse(withheld.pluginsJson) as { plugins: { name: string }[] }).plugins
    expect(listed.map(entry => entry.name)).toEqual(['dsh-heavy-peers'])
  })
})

describe('describeRereadStopped (github declarations re-read)', () => {
  // RepoHarvestResult.rereadStopped (github-client.ts) says why the
  // re-read phase stopped starting reads before its queue ran out, or null
  // when it did not. build.ts appends the phrase next to the re-read counts
  // on the github report line, and only when it is non-null — a healthy run
  // (budget unspent, queue drained or empty) must not grow a trailing clause
  // that says nothing.
  it('names the time budget', () => {
    expect(describeRereadStopped('time-budget')).toBe('; re-read stopped: time budget')
  })

  it('names the failure breaker', () => {
    expect(describeRereadStopped('failure-breaker')).toBe('; re-read stopped: failure breaker')
  })

  it('is empty when the phase did not stop early', () => {
    expect(describeRereadStopped(null)).toBe('')
  })
})

describe('parseBudgetVariable (the icon step\'s two budgets)', () => {
  // The same contract as parseHarvestBudget, for a variable of any name. The
  // two budgets fail open in the same way the backfill's did: planIconWork
  // slices its fetches at the count, so NaN fetches nothing and a negative
  // count reads from the end; and harvestIcons stops starting fetches once
  // `elapsed >= deadline`, which is never true of NaN, so a NaN deadline is
  // no deadline at all.
  it('reads a plain integer, and falls back when the variable is unset', () => {
    expect(parseBudgetVariable('ICON_FETCH_BUDGET', '500', 1500)).toBe(500)
    expect(parseBudgetVariable('ICON_FETCH_BUDGET', undefined, 1500)).toBe(1500)
  })

  it('accepts zero, a deliberate "fetch nothing" run', () => {
    expect(parseBudgetVariable('ICON_FETCH_BUDGET', '0', 1500)).toBe(0)
    expect(parseBudgetVariable('ICON_FETCH_TIME_BUDGET_MS', '0', 900_000)).toBe(0)
  })

  it('accepts the largest safe integer and refuses the next', () => {
    expect(parseBudgetVariable('ICON_FETCH_BUDGET', String(Number.MAX_SAFE_INTEGER), 1500)).toBe(Number.MAX_SAFE_INTEGER)
    // 2**53 is an integer, but past it a number no longer reads back as the
    // one written: 2**53 + 1 is 2**53, so a budget this large is not the
    // budget its operator typed.
    expect(() => parseBudgetVariable('ICON_FETCH_BUDGET', String(Number.MAX_SAFE_INTEGER + 1), 1500)).toThrow(/ICON_FETCH_BUDGET/)
  })

  it('throws on every value that would fail open, naming the variable it was asked about', () => {
    for (const raw of ['abc', '', ' ', '-1', '1.5', 'Infinity', 'NaN', '1e400']) {
      for (const name of ['ICON_FETCH_BUDGET', 'ICON_FETCH_TIME_BUDGET_MS']) {
        expect(() => parseBudgetVariable(name, raw, 1500), `${name}=${JSON.stringify(raw)} must throw`)
          .toThrow(new RegExp(`^${name} must be`))
      }
    }
  })

  it('quotes the value back, because the operator cannot see it in a log line that says nothing was fetched', () => {
    expect(() => parseBudgetVariable('ICON_FETCH_TIME_BUDGET_MS', '15 minutes', 900_000)).toThrow(/got "15 minutes"/)
  })
})

describe('parseDeadlineVariable (the catalog job\'s deadline)', () => {
  // Unset on every local run and in every test, and no step is cut short
  // then. Set, it is held to the budgets' contract, because it fails open the
  // same way: `deadline - now` is NaN for a value that is no number, and a cap
  // of NaN caps nothing.
  it('reads milliseconds since the epoch, and answers null when the variable is unset', () => {
    expect(parseDeadlineVariable('CATALOG_JOB_DEADLINE_MS', '1761284280000')).toBe(1_761_284_280_000)
    expect(parseDeadlineVariable('CATALOG_JOB_DEADLINE_MS', undefined)).toBeNull()
    expect(parseDeadlineVariable('CATALOG_JOB_DEADLINE_MS', '0')).toBe(0)
  })

  it('throws on every value that would fail open, naming the variable and quoting the value back', () => {
    for (const raw of ['abc', '', ' ', '-1', '1.5', 'Infinity', 'NaN', '1e400', String(Number.MAX_SAFE_INTEGER + 1), '1761284280000%3N']) {
      expect(() => parseDeadlineVariable('CATALOG_JOB_DEADLINE_MS', raw), `${JSON.stringify(raw)} must throw`)
        .toThrow(new RegExp(`^CATALOG_JOB_DEADLINE_MS must be a non-negative safe integer; got ${JSON.stringify(raw).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`))
    }
  })
})

describe('budgetBeforeDeadline', () => {
  const MINUTE = 60_000
  const deadline = 1_761_284_280_000

  it('is the budget when there is no deadline', () => {
    expect(budgetBeforeDeadline(15 * MINUTE, null, deadline + 60 * MINUTE)).toBe(15 * MINUTE)
  })

  it('is the budget when the deadline leaves more time than that', () => {
    expect(budgetBeforeDeadline(15 * MINUTE, deadline, deadline - 40 * MINUTE)).toBe(15 * MINUTE)
    expect(budgetBeforeDeadline(15 * MINUTE, deadline, deadline - 15 * MINUTE)).toBe(15 * MINUTE)
  })

  it('is the time left when the deadline leaves less', () => {
    expect(budgetBeforeDeadline(15 * MINUTE, deadline, deadline - 4 * MINUTE)).toBe(4 * MINUTE)
    expect(budgetBeforeDeadline(15 * MINUTE, deadline, deadline - 1)).toBe(1)
  })

  it('is zero, which starts nothing, at the deadline and past it', () => {
    expect(budgetBeforeDeadline(15 * MINUTE, deadline, deadline)).toBe(0)
    expect(budgetBeforeDeadline(15 * MINUTE, deadline, deadline + 3 * MINUTE)).toBe(0)
  })

  it('never raises a budget of zero, which is an instruction to start nothing', () => {
    expect(budgetBeforeDeadline(0, deadline, deadline - 60 * MINUTE)).toBe(0)
    expect(budgetBeforeDeadline(0, null, deadline)).toBe(0)
  })
})

describe('describeLostIconsFile', () => {
  const KEY = (name: string): IconKey => npmIconKey(name, '1.0.0', 'icon.svg')

  /** What the record holds for an icon that was published: the digest of a label, which no other label shares. */
  const publishedRow = (label: string): IconOutcome => ({
    outcome: 'published', sha256: sha256Hex(new TextEncoder().encode(label)), mediaType: 'image/svg+xml', bytes: label.length,
  })

  /** The subject of an npm entry that declares `icon.svg`, with what the planner needs to fetch it. */
  function subject(name: string): IconSubject {
    return {
      identity: `npm:${name}`,
      name,
      withheldKey: name,
      read: { kind: 'declared', declaration: { source: 'icon', path: 'icon.svg', mediaType: 'image/svg+xml' } },
      key: KEY(name),
      target: {
        kind: 'npm', name, version: '1.0.0', tarball: `https://registry.npmjs.org/${name}/-/${name}-1.0.0.tgz`,
        integrity: 'sha512-AAAA', path: 'icon.svg',
      },
    }
  }

  // a, b and c are recorded as published; d is a key the record has never met.
  const subjects = ['a', 'b', 'c', 'd'].map(subject)
  const record = new Map<IconKey, IconOutcome>(['a', 'b', 'c'].map(name => [KEY(name), publishedRow(name)]))
  const emptyFile: IconsFile = { icons: {}, sources: {} }
  const plan = (published: IconsFile | null, budget: number) => planIconWork(subjects, record, published, new Map(), budget)
  /** What `harvestIcons` answers when it starts the fetches of `names` and no others: one result for each. */
  const started = (...names: string[]) => new Map<IconKey, IconFetchResult>(names.map(name => [KEY(name), { kind: 'not-yet-read', reason: 'a timeout' }]))

  // The counts are of fetches the build STARTED. A plan's fetch the time budget
  // ran out before starting has no result, and was turned away as surely as a
  // key past the count budget; the line used to count it as fetched again.
  it('says how many recorded icons were fetched again within the budgets, and how many they turned away', () => {
    // With the file gone every recorded key is fetched again, in key order, so
    // a and b fit the budget of two and c does not. d was never recorded: its
    // fetch is a first read, not a refetch, and it is turned away without
    // being counted either way.
    expect(describeLostIconsFile(record, null, plan(null, 2), started('a', 'b'))).toBe(
      'The published icons file could not be read, so icons recorded as published were fetched again: 2 started within this build\'s budgets, 1 turned away by them.',
    )
  })

  it('counts a planned refetch the time budget never started as turned away, not as fetched', () => {
    // All four fit the count budget; the time budget ran out after a's fetch
    // had started, so b and c never were, and d's is no refetch either way.
    expect(describeLostIconsFile(record, null, plan(null, 4), started('a'))).toBe(
      'The published icons file could not be read, so icons recorded as published were fetched again: 1 started within this build\'s budgets, 2 turned away by them.',
    )
  })

  it('does not count the fetch of a key the record has never met as a refetch', () => {
    expect(describeLostIconsFile(record, null, plan(null, 4), started('a', 'b', 'c', 'd'))).toBe(
      'The published icons file could not be read, so icons recorded as published were fetched again: 3 started within this build\'s budgets, 0 turned away by them.',
    )
  })

  it('still says so when the record names icons that no listing wants any more', () => {
    // Nothing is left to fetch, and the file was still lost: the line is the
    // only trace of it in the report.
    expect(describeLostIconsFile(record, null, planIconWork([], record, null, new Map(), 10), started())).toBe(
      'The published icons file could not be read, so icons recorded as published were fetched again: 0 started within this build\'s budgets, 0 turned away by them.',
    )
  })

  it('says nothing when the published file was read', () => {
    expect(describeLostIconsFile(record, emptyFile, plan(emptyFile, 4), started('a', 'b', 'c', 'd'))).toBeNull()
  })

  it('says nothing on a first run, which has no record to lose', () => {
    const none = new Map<IconKey, IconOutcome>()
    expect(describeLostIconsFile(none, null, planIconWork(subjects, none, null, new Map(), 4), started('a', 'b', 'c', 'd'))).toBeNull()
  })

  it('says nothing when the record holds no published row, whatever became of the file', () => {
    // A refusal and a package past the caps are asked once and never fetched
    // again, so a lost file costs them nothing.
    const sad = new Map<IconKey, IconOutcome>([
      [KEY('a'), { outcome: 'refused', detail: 'icon ./icon.svg is not in the published package' }],
      [KEY('b'), { outcome: 'not-read', detail: 'the published package b@1.0.0 is too large' }],
    ])
    expect(describeLostIconsFile(sad, null, planIconWork(subjects, sad, null, new Map(), 4), started('a', 'b', 'c', 'd'))).toBeNull()
  })
})

describe('assertIconsInFile', () => {
  const SHA_A = sha256Hex(new TextEncoder().encode('a'))
  const SHA_B = sha256Hex(new TextEncoder().encode('b'))
  const file: IconsFile = {
    icons: { [SHA_A]: 'data:image/svg+xml;base64,AAAA' },
    sources: { 'npm:a@1.0.0:icon.svg': SHA_A },
  }

  it('passes when every entry names an icon the file holds, one icon for many entries included', () => {
    expect(() => assertIconsInFile(new Map([['npm:a', SHA_A], ['npm:fork-of-a', SHA_A]]), file)).not.toThrow()
  })

  it('passes when there are no icons at all, and no file', () => {
    expect(() => assertIconsInFile(new Map(), null)).not.toThrow()
    expect(() => assertIconsInFile(new Map(), file)).not.toThrow()
  })

  it('throws, naming the entry, on a well-formed sha256 the file does not hold', () => {
    // A dangling key passes every grammar check downstream and draws the
    // default artwork, which looks exactly like a plugin with no icon.
    expect(() => assertIconsInFile(new Map([['npm:a', SHA_A], ['npm:b', SHA_B]]), file))
      .toThrow(/does not hold: 1, the first being "npm:b"/)
  })

  it('throws when entries name icons and there is no file to hold them', () => {
    expect(() => assertIconsInFile(new Map([['npm:a', SHA_A]]), null)).toThrow(/"npm:a"/)
  })

  it('does not take a name on the prototype chain for a held icon', () => {
    expect(() => assertIconsInFile(new Map([['npm:a', 'toString']]), file)).toThrow(/"npm:a"/)
  })

  it('counts every dangling entry and names the first in code-unit order, whatever order they came in', () => {
    const dangling = new Map([['npm:z', SHA_B], ['npm:m', SHA_B], ['npm:a', SHA_A]])
    expect(() => assertIconsInFile(dangling, file)).toThrow(/does not hold: 2, the first being "npm:m"/)
  })
})
