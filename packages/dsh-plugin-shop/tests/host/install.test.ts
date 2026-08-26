import { describe, expect, it } from 'vitest'
import { validateInstall } from '../../src/host/install.ts'
import type { CatalogSnapshot } from '../../src/host/catalog.ts'

function snapshot(overrides: Partial<CatalogSnapshot['entries'][number]> = {}): CatalogSnapshot {
  return {
    schemaVersion: 2,
    builtAt: '2026-08-25T00:00:00Z',
    entries: [{
      name: 'dsh-hello-plugin', version: '1.2.0', integrity: null, publishedAt: null,
      repository: null, license: 'MIT', tier: 'community', metadata: 'derived',
      ...overrides,
    }],
    denied: [{ name: 'dsh-blocked', detail: 'matched the denylist' }],
    stars: {},
  }
}

describe('validateInstall', () => {
  it('rejects a name absent from the snapshot as not-in-catalog', () => {
    const result = validateInstall(snapshot(), { name: 'dsh-unknown', version: '1.0.0' })
    expect(result).toMatchObject({ ok: false, code: 'not-in-catalog' })
    if (!result.ok) expect(result.detail).toContain('dsh-unknown')
  })

  it('rejects a denied name as denied, with the denial reason', () => {
    const result = validateInstall(snapshot(), { name: 'dsh-blocked', version: '1.0.0' })
    expect(result).toMatchObject({ ok: false, code: 'denied' })
    if (!result.ok) expect(result.detail).toContain('matched the denylist')
  })

  it('rejects a version that is not the snapshot version as version-mismatch', () => {
    const result = validateInstall(snapshot(), { name: 'dsh-hello-plugin', version: '9.9.9' })
    expect(result).toMatchObject({ ok: false, code: 'version-mismatch' })
    if (!result.ok) expect(result.detail).toContain('1.2.0')
  })

  it('requires acknowledgement for a community entry', () => {
    const result = validateInstall(snapshot(), { name: 'dsh-hello-plugin', version: '1.2.0' })
    expect(result).toMatchObject({ ok: false, code: 'needs-acknowledgement' })
    if (!result.ok) {
      expect(result.detail).toBe('dsh-plugin-shop: dsh-hello-plugin is community-tier and has not been reviewed; acknowledgement is required')
    }
  })

  it('requires acknowledgement for a verified-stale entry', () => {
    const result = validateInstall(snapshot({ tier: 'verified-stale' }), { name: 'dsh-hello-plugin', version: '1.2.0' })
    expect(result).toMatchObject({ ok: false, code: 'needs-acknowledgement' })
    if (!result.ok) {
      expect(result.detail).toBe('dsh-plugin-shop: dsh-hello-plugin is verified-stale: a newer version than the review is current and has not been reviewed; acknowledgement is required')
    }
  })

  it('passes an acknowledged community install', () => {
    const result = validateInstall(snapshot(), { name: 'dsh-hello-plugin', version: '1.2.0', acknowledged: true })
    expect(result).toEqual({ ok: true })
  })

  it('passes a verified install without acknowledgement', () => {
    const result = validateInstall(snapshot({ tier: 'verified' }), { name: 'dsh-hello-plugin', version: '1.2.0' })
    expect(result).toEqual({ ok: true })
  })
})
