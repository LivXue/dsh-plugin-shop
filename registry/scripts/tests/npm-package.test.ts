import { describe, expect, it } from 'vitest'
import { catalogPackageFiles, catalogPublishDecision, nextCatalogVersion } from '../src/npm-package.ts'

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

  it('does not zero-pad: October 15 is 1015', () => {
    expect(nextCatalogVersion(new Date('2026-10-15T03:17:00Z'), null)).toBe('2026.1015.0')
  })

  // These orderings are the whole point of the scheme. Every version here is
  // PRODUCED by nextCatalogVersion, never written as a literal: a literal
  // version compared against a local helper tests only the helper, and would
  // pass against an implementation that returned a constant.
  it('orders monotonically across month and year boundaries', () => {
    const at = (iso: string, latest: string | null = null): string =>
      nextCatalogVersion(new Date(iso), latest)
    const sep = at('2026-09-01T03:17:00Z')
    const oct = at('2026-10-15T03:17:00Z')
    const dec = at('2026-12-31T03:17:00Z')
    const jan = at('2027-01-01T03:17:00Z')
    const sepAgain = at('2026-09-01T11:00:00Z', sep)

    // Every field is a bare integer, so a numeric tuple compare IS the semver
    // compare for this scheme — asserted below rather than assumed.
    for (const version of [sep, oct, dec, jan, sepAgain]) {
      expect(version.split('.').every(part => /^(0|[1-9]\d*)$/.test(part))).toBe(true)
    }
    const gt = (a: string, b: string): boolean => {
      const [x, y] = [a.split('.').map(Number), b.split('.').map(Number)]
      for (let i = 0; i < 3; i += 1) {
        const l = x[i] ?? 0, r = y[i] ?? 0
        if (l !== r) return l > r
      }
      return false
    }
    expect(gt(oct, sep)).toBe(true)
    expect(gt(jan, dec)).toBe(true)
    expect(gt(sepAgain, sep)).toBe(true)
    expect(gt(dec, oct)).toBe(true)
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

  it('carries the repository field npm provenance requires, matching the building repo', () => {
    const manifest = JSON.parse(catalogPackageFiles(input).packageJson) as Record<string, unknown>
    // npm provenance (NPM_CONFIG_PROVENANCE=true in daily.yml) mints an
    // attestation binding the publish to the repository this field names,
    // and rejects the publish outright (EUSAGE) when it does not match the
    // building repo — precisely the "first human-watched publish fails for
    // an unrelated reason" class this branch has already been bitten by
    // (item 11, 2026-09 review).
    expect(manifest.repository).toEqual({ type: 'git', url: 'git+https://github.com/LivXue/dsh-plugin-shop.git' })
  })

  it('records the content hashes so the next build can decide to skip', () => {
    const manifest = JSON.parse(catalogPackageFiles(input).packageJson) as Record<string, unknown>
    expect(manifest.catalogShas).toEqual({ plugins: 'abc123', stars: 'def456' })
  })

  it('records the build time so the next publish can refuse to go backwards', () => {
    const manifest = JSON.parse(catalogPackageFiles(input).packageJson) as Record<string, unknown>
    expect(manifest.catalogBuiltAt).toBe('2026-09-01T03:17:00.000Z')
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

describe('catalogPublishDecision', () => {
  const shas = { plugins: 'abc123', stars: 'def456' }
  const published = {
    version: '2026.903.5',
    shas: { plugins: 'older-plugins', stars: 'older-stars' },
    builtAt: '2026-09-03T09:27:42.934Z',
  }
  const newer = { builtAt: '2026-09-04T03:17:00.000Z', shas }

  it('publishes when the package has never been published', () => {
    expect(catalogPublishDecision(newer, null)).toEqual({ kind: 'publish' })
  })

  it('publishes a build newer than the published one', () => {
    expect(catalogPublishDecision(newer, published)).toEqual({ kind: 'publish' })
  })

  it('skips when both content hashes match the published version', () => {
    const decision = catalogPublishDecision({ ...newer, shas: published.shas }, published)
    expect(decision.kind).toBe('skip')
  })

  // The regression this guard exists for. At 2026-09-03T16:46Z a
  // `publish:catalog` run from a tree whose `dist/v1` had not been rebuilt
  // since 09-02 shipped that stale build as 2026.903.6, and npm moved
  // `latest` onto it: readers whose origin race went to npm got a catalog two
  // days old and 818 entries short. The hash check passed and always would --
  // stale content hashes differ from the published ones exactly as new
  // content does -- so the build time is the only fact that separates them.
  it('refuses a build older than the published one', () => {
    const decision = catalogPublishDecision({ builtAt: '2026-09-02T08:32:15.310Z', shas }, published)
    expect(decision.kind).toBe('refuse')
  })

  it('names both build times and the way out in the refusal', () => {
    const decision = catalogPublishDecision({ builtAt: '2026-09-02T08:32:15.310Z', shas }, published)
    if (decision.kind !== 'refuse') throw new Error(`expected a refusal, got ${decision.kind}`)
    expect(decision.reason).toContain('2026-09-02T08:32:15.310Z')
    expect(decision.reason).toContain('2026-09-03T09:27:42.934Z')
    expect(decision.reason).toContain('2026.903.5')
    expect(decision.reason).toContain('build:catalog')
  })

  // Same clock reading, different bytes: whatever produced this, it is not a
  // build that ran after the published one, and publishing it would move
  // `latest` onto content whose provenance we cannot order.
  it('refuses a build stamped at the same instant as the published one', () => {
    const decision = catalogPublishDecision({ builtAt: published.builtAt, shas }, published)
    expect(decision.kind).toBe('refuse')
  })

  // Identical content is nothing to publish whichever way the clock reads, so
  // the skip is decided before the guard. Refusing here would fail a job that
  // has nothing to do -- the daily build on an ecosystem that did not change.
  it('skips, rather than refuses, a stale build whose content is identical', () => {
    const decision = catalogPublishDecision(
      { builtAt: '2026-09-02T08:32:15.310Z', shas: published.shas },
      published,
    )
    expect(decision.kind).toBe('skip')
  })

  // Every version published before `catalogBuiltAt` existed carries no build
  // time, and 2026.903.5 -- the `latest` this guard ships against -- is one of
  // them. An unorderable pair cannot be refused without blocking the very
  // publish that introduces the field, so the guard starts working one
  // published version later, and says so rather than pretending otherwise.
  it('publishes against a published version that carries no build time', () => {
    expect(catalogPublishDecision(newer, { ...published, builtAt: null })).toEqual({ kind: 'publish' })
  })

  it('publishes against a published build time it cannot parse', () => {
    expect(catalogPublishDecision(newer, { ...published, builtAt: 'not a date' })).toEqual({ kind: 'publish' })
  })

  // A local build time that will not parse is a malformed `dist/v1/index.json`.
  // The project stops rather than publishing something plausible and wrong.
  it('refuses a local build time it cannot parse', () => {
    const decision = catalogPublishDecision({ builtAt: 'not a date', shas }, published)
    expect(decision.kind).toBe('refuse')
    expect(catalogPublishDecision({ builtAt: 'not a date', shas }, null).kind).toBe('refuse')
  })
})
