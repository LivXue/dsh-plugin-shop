import { describe, expect, it } from 'vitest'
import { assignTier } from '../src/tier.ts'
import { parseRegistryConfig } from '../src/config.ts'
import type { Accepted } from '../src/gate.ts'

const config = parseRegistryConfig({
  verified: '- name: dsh-hello-plugin\n  reviewedVersion: 1.2.0\n  reviewer: github:r\n  reviewCommit: abc\n  notes: fine\n',
  denied: '[]',
  allowedSimilar: '[]',
})

function accepted(name: string, version: string): Accepted {
  return {
    candidate: {
      name, version, integrity: 'sha512-abc', publishedAt: '2026-08-01T12:00:00.000Z',
      repository: 'https://github.com/you/x', license: 'MIT', deprecated: false,
      hasBundle: true, catalog: {},
    },
    catalog: { category: 'tool', summary: { en: 'x', zh: 'y' }, capabilities: [] },
    integrity: 'sha512-abc',
    publishedAt: '2026-08-01T12:00:00.000Z',
    repository: 'https://github.com/you/x',
    license: 'MIT',
  }
}

describe('assignTier', () => {
  it('marks an unlisted package community and attaches no review', () => {
    const entry = assignTier(accepted('dsh-other-plugin', '1.0.0'), config)
    expect(entry.tier).toBe('community')
    expect(entry.review).toBeUndefined()
  })

  it('marks the reviewed version verified', () => {
    const entry = assignTier(accepted('dsh-hello-plugin', '1.2.0'), config)
    expect(entry.tier).toBe('verified')
    expect(entry.review?.reviewedVersion).toBe('1.2.0')
  })

  it('downgrades a newer version to verified-stale', () => {
    const entry = assignTier(accepted('dsh-hello-plugin', '1.3.0'), config)
    expect(entry.tier).toBe('verified-stale')
    expect(entry.review?.reviewedVersion).toBe('1.2.0')
  })

  it('downgrades a newer patch to verified-stale', () => {
    expect(assignTier(accepted('dsh-hello-plugin', '1.2.1'), config).tier).toBe('verified-stale')
  })

  it('treats a version older than the review as verified', () => {
    expect(assignTier(accepted('dsh-hello-plugin', '1.1.0'), config).tier).toBe('verified')
  })

  it('keeps the review attached when stale, so the UI can name both versions', () => {
    const entry = assignTier(accepted('dsh-hello-plugin', '2.0.0'), config)
    expect(entry.review).toEqual({
      reviewedVersion: '1.2.0', reviewer: 'github:r', reviewCommit: 'abc', notes: 'fine',
    })
  })

  it('copies the accepted fields onto the entry', () => {
    const entry = assignTier(accepted('dsh-other-plugin', '1.0.0'), config)
    expect(entry).toMatchObject({
      name: 'dsh-other-plugin', version: '1.0.0', integrity: 'sha512-abc',
      license: 'MIT', repository: 'https://github.com/you/x',
    })
  })
})
