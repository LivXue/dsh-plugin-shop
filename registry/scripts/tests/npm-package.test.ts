import { describe, expect, it } from 'vitest'
import { catalogPackageFiles, nextCatalogVersion } from '../src/npm-package.ts'

describe('nextCatalogVersion', () => {
  it('stamps YYYY.MMDD.0 for the first build of a day', () => {
    expect(nextCatalogVersion(new Date('2026-09-01T03:17:00Z'), null)).toBe('2026.901.0')
  })

  it('increments the counter for a second build the same day', () => {
    expect(nextCatalogVersion(new Date('2026-09-01T11:00:00Z'), '2026.901.0')).toBe('2026.901.1')
    expect(nextCatalogVersion(new Date('2026-09-01T11:00:00Z'), '2026.901.7')).toBe('2026.901.8')
  })

  it('restarts the counter on a new day', () => {
    expect(nextCatalogVersion(new Date('2026-09-02T03:17:00Z'), '2026.901.4')).toBe('2026.902.0')
  })

  it('pads nothing: October is 1015, not 1015 zero-padded', () => {
    expect(nextCatalogVersion(new Date('2026-10-15T03:17:00Z'), null)).toBe('2026.1015.0')
  })

  // These orderings are the whole point of the scheme; each is checked as
  // semver, not as a string.
  it('orders monotonically across month and year boundaries', () => {
    const asTuple = (v: string): number[] => v.split('.').map(Number)
    const gt = (a: string, b: string): boolean => {
      const [x, y] = [asTuple(a), asTuple(b)]
      for (let i = 0; i < 3; i += 1) {
        const l = x[i] ?? 0, r = y[i] ?? 0
        if (l !== r) return l > r
      }
      return false
    }
    expect(gt('2026.1015.0', '2026.901.0')).toBe(true)
    expect(gt('2027.101.0', '2026.1231.0')).toBe(true)
    expect(gt('2026.901.1', '2026.901.0')).toBe(true)
    expect(gt('2026.1231.0', '2026.1015.0')).toBe(true)
  })

  it('uses UTC, so a late-evening local build does not skip a day', () => {
    expect(nextCatalogVersion(new Date('2026-09-01T23:59:00Z'), null)).toBe('2026.901.0')
  })

  it('ignores a published latest it cannot parse', () => {
    expect(nextCatalogVersion(new Date('2026-09-01T00:00:00Z'), '2026.901.beta')).toBe('2026.901.0')
  })
})

describe('catalogPackageFiles', () => {
  const input = {
    version: '2026.901.0',
    builtAt: '2026-09-01T03:17:00.000Z',
    count: 8897,
    pluginsFileName: 'plugins.abc123.json',
    starsFileName: 'stars.def456.json',
    shas: { plugins: 'abc123', stars: 'def456' },
  }

  it('declares the package with the given version and ships only v1', () => {
    const manifest = JSON.parse(catalogPackageFiles(input).packageJson) as Record<string, unknown>
    expect(manifest.name).toBe('dsh-plugin-shop-catalog')
    expect(manifest.version).toBe('2026.901.0')
    expect(manifest.files).toEqual(['v1', 'index.js'])
    expect(manifest.main).toBe('index.js')
    expect(manifest.license).toBe('MIT')
  })

  it('records the content hashes so the next build can decide to skip', () => {
    const manifest = JSON.parse(catalogPackageFiles(input).packageJson) as Record<string, unknown>
    expect(manifest.catalogShas).toEqual({ plugins: 'abc123', stars: 'def456' })
  })

  it('records a null stars hash when the build published no sidecar', () => {
    const manifest = JSON.parse(
      catalogPackageFiles({ ...input, starsFileName: null, shas: { plugins: 'abc123', stars: null } }).packageJson,
    ) as Record<string, unknown>
    expect(manifest.catalogShas).toEqual({ plugins: 'abc123', stars: null })
  })

  it('names both data files in the entry point', () => {
    const indexJs = catalogPackageFiles(input).indexJs
    expect(indexJs).toContain('plugins.abc123.json')
    expect(indexJs).toContain('stars.def456.json')
  })

  it('omits the stars accessor when the build published no sidecar', () => {
    const indexJs = catalogPackageFiles({ ...input, starsFileName: null, shas: { plugins: 'abc123', stars: null } }).indexJs
    expect(indexJs).not.toContain('stars.')
    expect(indexJs).toContain('starsPath = null')
  })

  it('states the build time and count in the readme', () => {
    const readme = catalogPackageFiles(input).readme
    expect(readme).toContain('2026-09-01T03:17:00.000Z')
    expect(readme).toContain('8897')
  })

  it('ends every file with exactly one trailing newline', () => {
    const files = catalogPackageFiles(input)
    for (const text of [files.packageJson, files.indexJs, files.readme]) {
      expect(text.endsWith('\n')).toBe(true)
      expect(text.endsWith('\n\n')).toBe(false)
    }
  })
})
