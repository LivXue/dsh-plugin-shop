import { describe, expect, it } from 'vitest'
import { validateInstall } from '../../src/host/install.ts'
import type { CatalogSnapshot } from '../../src/host/catalog.ts'

function snapshot(overrides: Partial<CatalogSnapshot['entries'][number]> = {}): CatalogSnapshot {
  return {
    schemaVersion: 2,
    builtAt: '2026-08-25T00:00:00Z',
    entries: [{
      name: 'dsh-hello-plugin', version: '1.2.0', integrity: null, publishedAt: null,
      repository: null, license: 'MIT', tier: 'community', metadata: 'derived', source: 'npm',
      added: '2026-08-25',
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
    expect(result).toMatchObject({ ok: true })
  })

  it('passes a verified install without acknowledgement', () => {
    const result = validateInstall(snapshot({ tier: 'verified' }), { name: 'dsh-hello-plugin', version: '1.2.0' })
    expect(result).toMatchObject({ ok: true })
  })
})

describe('validateInstall identity (G-1)', () => {
  const commit = 'a'.repeat(40)
  const alice: CatalogSnapshot['entries'][number] = {
    name: 'dsh-foo', version: commit, integrity: commit, publishedAt: null,
    repository: 'https://github.com/alice/dsh-foo', license: 'MIT',
    tier: 'community', metadata: 'derived', source: 'github', repo: 'alice/dsh-foo',
    added: '2026-08-25',
  }
  const bob = { ...alice, version: 'b'.repeat(40), integrity: 'b'.repeat(40), repo: 'bob/dsh-foo' }
  const twoRepos: CatalogSnapshot = {
    schemaVersion: 6, builtAt: '2026-09-03T00:00:00Z', entries: [alice, bob], denied: [], stars: {},
  }

  it('resolves the requested identity, not the first entry sharing the name', () => {
    const result = validateInstall(twoRepos, {
      name: 'dsh-foo', version: bob.version, acknowledged: true,
      source: 'github', repo: 'bob/dsh-foo',
    })
    expect(result).toMatchObject({ ok: true })
    if (result.ok) expect(result.entry.repo).toBe('bob/dsh-foo')
  })

  it('separates two subpackages of one repository', () => {
    const mono = { ...alice, repo: 'someone/mono', subdir: 'packages/a' }
    const other = { ...alice, version: 'c'.repeat(40), repo: 'someone/mono', subdir: 'packages/b' }
    const snap: CatalogSnapshot = {
      schemaVersion: 6, builtAt: '', entries: [mono, other], denied: [], stars: {},
    }
    const result = validateInstall(snap, {
      name: 'dsh-foo', version: other.version, acknowledged: true,
      source: 'github', repo: 'someone/mono', subdir: 'packages/b',
    })
    expect(result).toMatchObject({ ok: true })
    if (result.ok) expect(result.entry.subdir).toBe('packages/b')
  })

  it('reports an identity the catalog does not hold as not-in-catalog', () => {
    const result = validateInstall(twoRepos, {
      name: 'dsh-foo', version: commit, acknowledged: true,
      source: 'github', repo: 'carol/dsh-foo',
    })
    expect(result).toMatchObject({ ok: false, code: 'not-in-catalog' })
    if (!result.ok) expect(result.detail).toContain('github:carol/dsh-foo#')
  })

  it('refuses a name-only request the catalog cannot disambiguate', () => {
    const result = validateInstall(twoRepos, { name: 'dsh-foo', version: commit, acknowledged: true })
    expect(result).toMatchObject({ ok: false, code: 'ambiguous-identity' })
    if (!result.ok) {
      expect(result.detail).toBe('dsh-plugin-shop: the catalog holds 2 entries named dsh-foo, and this request does not say which one; refresh the shop and try again')
    }
  })

  it('still serves a name-only request when the name is unique', () => {
    const single: CatalogSnapshot = {
      schemaVersion: 6, builtAt: '', entries: [alice], denied: [], stars: {},
    }
    const result = validateInstall(single, { name: 'dsh-foo', version: commit, acknowledged: true })
    expect(result).toMatchObject({ ok: true })
  })
})
