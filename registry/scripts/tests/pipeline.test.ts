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
})

const BUILT_AT = '2026-08-18T00:00:00.000Z'

describe('runPipeline', () => {
  it('accepts the three listable plugins', () => {
    const { pluginsJson } = runPipeline(candidates, config, BUILT_AT)
    const parsed = JSON.parse(pluginsJson) as { plugins: { name: string }[] }
    expect(parsed.plugins.map(p => p.name)).toEqual(['dsh-derived-plugin', 'dsh-fs-tool', 'dsh-hello-plugin'])
  })

  it('downgrades the verified plugin whose version moved past its review', () => {
    const { pluginsJson } = runPipeline(candidates, config, BUILT_AT)
    const parsed = JSON.parse(pluginsJson) as { plugins: { name: string; tier: string }[] }
    expect(parsed.plugins.find(p => p.name === 'dsh-fs-tool')?.tier).toBe('verified-stale')
  })

  it('lists a package with no dsh.catalog as a derived entry, from its npm description', () => {
    const { pluginsJson } = runPipeline(candidates, config, BUILT_AT)
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
    const { pluginsJson } = runPipeline(candidates, config, BUILT_AT)
    const parsed = JSON.parse(pluginsJson) as { plugins: { name: string; metadata: string }[] }
    expect(parsed.plugins.find(p => p.name === 'dsh-hello-plugin')?.metadata).toBe('declared')
  })

  it('reports all four rejections with their codes', () => {
    const { report } = runPipeline(candidates, config, BUILT_AT)
    expect(report).toContain('| dsh-lib-only | no-bundle |')
    expect(report).toContain('| dsh-no-license | no-license |')
    expect(report).toContain('| dsh-fs-too1 | name-too-similar |')
    expect(report).toContain('| dsh-no-summary | no-summary |')
  })

  it('merges a pre-existing rejection into the emitted report', () => {
    const preexisting: Rejection[] = [
      { name: 'dsh-rate-limited', code: 'fetch-failed', detail: 'npm registry returned 429 fetching dsh-rate-limited' },
    ]
    const { report } = runPipeline(candidates, config, BUILT_AT, preexisting)
    expect(report).toContain('| dsh-rate-limited | fetch-failed | npm registry returned 429 fetching dsh-rate-limited |')
  })

  it('produces byte-identical artifacts for the same input', () => {
    const first = runPipeline(candidates, config, BUILT_AT)
    const second = runPipeline([...candidates].reverse(), config, BUILT_AT)
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
    })
    const first = runPipeline(candidates, categorized, BUILT_AT)
    const second = runPipeline(candidates, categorized, BUILT_AT)
    expect(second.pluginsJson).toBe(first.pluginsJson)
    const parsed = JSON.parse(first.pluginsJson) as {
      plugins: { name: string; metadata: string; catalog: { category: string } }[]
    }
    const derived = parsed.plugins.find(p => p.name === 'dsh-derived-plugin')
    expect(derived?.catalog.category).toBe('tool')
  })

  it('produces identical data across build times', () => {
    const first = runPipeline(candidates, config, BUILT_AT)
    const second = runPipeline(candidates, config, '2030-01-01T00:00:00.000Z')
    expect(second.pluginsJson).toBe(first.pluginsJson)
    expect(second.pluginsFileName).toBe(first.pluginsFileName)
    expect(second.manifestLock).toBe(first.manifestLock)
    expect(second.report).toBe(first.report)
    expect(second.indexJson).not.toBe(first.indexJson)
  })
})
