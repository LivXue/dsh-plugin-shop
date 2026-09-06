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
  const repoEntry = (repo: string) => ({
    name: 'dsh-skill-manager', version: 'a'.repeat(40), integrity: null, publishedAt: null,
    repository: `https://github.com/${repo}`, license: 'MIT', tier: 'community' as const,
    metadata: 'derived' as const, source: 'github' as const, repo, added: '2026-08-25',
  })
  const twoRepos = (): CatalogSnapshot => ({
    schemaVersion: 2, builtAt: '2026-08-25T00:00:00Z', denied: [], stars: {},
    entries: [repoEntry('CLAPEILL/dsh-skill-manager'), repoEntry('Mvyvn/dsh-skill-manager')],
  })

  it('refuses to replace a DIFFERENT plugin that happens to share the name', () => {
    // Two same-named bundles cannot coexist: both declare the same loader
    // entry id in their own patch, and dsh then refuses to load the tree at
    // all ("duplicate loader entry id: skill-manager" — measured, the profile
    // does not boot). Through the shop the manifest keys by bundle name, so
    // the second install overwrites the first instead, silently, measured on
    // 0.8.0-beta.1. Either way the plugin the user chose is gone. 177 live
    // catalog names are claimed by more than one entry; dsh-skill-manager
    // alone is claimed by 14.
    const installed = 'github:CLAPEILL/dsh-skill-manager#3c32e1030a2a862a686928a6fbbf81c0a4056ad2'
    const result = validateInstall(twoRepos(), {
      name: 'dsh-skill-manager', version: 'a'.repeat(40),
      source: 'github', repo: 'Mvyvn/dsh-skill-manager', acknowledged: true,
    }, installed)
    expect(result).toMatchObject({ ok: false, code: 'name-taken' })
    // The detail names WHICH plugin holds the name, or the reader cannot act.
    if (!result.ok) {
      expect(result.detail).toContain('CLAPEILL/dsh-skill-manager')
      expect(result.detail).toContain('dsh-skill-manager')
    }
  })

  it('still allows updating the SAME plugin to a newer commit', () => {
    // The boundary this must not cross: a same-identity update is the normal
    // path and shares the manifest key by design.
    const installed = 'github:CLAPEILL/dsh-skill-manager#0000000000000000000000000000000000000000'
    const result = validateInstall(twoRepos(), {
      name: 'dsh-skill-manager', version: 'a'.repeat(40),
      source: 'github', repo: 'CLAPEILL/dsh-skill-manager', acknowledged: true,
    }, installed)
    expect(result.ok, result.ok ? '' : result.detail).toBe(true)
  })

  it('still allows updating an npm entry to a newer version', () => {
    const result = validateInstall(snapshot(), { name: 'dsh-hello-plugin', version: '1.2.0', acknowledged: true }, '1.1.0')
    expect(result.ok, result.ok ? '' : result.detail).toBe(true)
  })

  it('refuses a github entry whose name an npm package already holds', () => {
    // The two keyspaces collide in one manifest key. Installing across sources
    // is still a replacement of someone else's plugin.
    const result = validateInstall(twoRepos(), {
      name: 'dsh-skill-manager', version: 'a'.repeat(40),
      source: 'github', repo: 'Mvyvn/dsh-skill-manager', acknowledged: true,
    }, '2.0.0')
    expect(result).toMatchObject({ ok: false, code: 'name-taken' })
  })

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
