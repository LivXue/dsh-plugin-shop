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
    '- name: dsh-repo-plugin',
    '  added: 2026-08-13',
    '- name: sub-plugin',
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

  it('throws with the file name when a listed name has no first-seen row', () => {
    const withoutRow = parseRegistryConfig({
      verified: '- name: dsh-fs-tool\n  reviewedVersion: 1.0.0\n  reviewer: github:r\n  reviewCommit: abc\n  notes: fine\n',
      denied: '[]',
      allowedSimilar: '[]',
      categories: '[]',
      firstSeen: '- name: dsh-hello-plugin\n  added: 2026-08-11\n- name: dsh-derived-plugin\n  added: 2026-08-12\n',
    })
    expect(() => runPipeline(candidates, [], withoutRow, BUILT_AT))
      .toThrow('first-seen.yml: dsh-fs-tool has no first-seen row')
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

  it('throws when a repository entry has no first-seen row', () => {
    const withoutRow = parseRegistryConfig({
      verified: '[]',
      denied: '[]',
      allowedSimilar: '[]',
      categories: '[]',
      firstSeen: '[]',
    })
    expect(() => runPipeline([], [repoCandidate], withoutRow, BUILT_AT))
      .toThrow('first-seen.yml: dsh-repo-plugin has no first-seen row')
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
