import { describe, expect, it } from 'vitest'
import { PAGES_FIXED_FILES, npmArtifactNames, pagesArtifactNames } from '../src/pages-artifacts.ts'

describe('pagesArtifactNames', () => {
  it('publishes exactly the four spec-listed artifacts when the build produced stars', () => {
    expect(pagesArtifactNames({ plugins: { url: 'plugins.abc.json' }, stars: { url: 'stars.def.json' } }))
      .toEqual(['index.json', 'badge.json', 'plugins.abc.json', 'stars.def.json'])
  })

  it('omits the sidecar when the build produced none', () => {
    // The stars fetch is advisory: no token, a rate limit or a down API
    // publishes without it, and the pointer then has no `stars` key.
    expect(pagesArtifactNames({ plugins: { url: 'plugins.abc.json' } }))
      .toEqual(['index.json', 'badge.json', 'plugins.abc.json'])
  })

  it('never lists the internal handoff or either report', () => {
    // Pages served all three because upload-pages-artifact was pointed at
    // `dist`. Measured live on 2026-09-04: /v1/harvest.json was 4,037,180
    // bytes of every candidate verbatim, rejected ones included, with
    // unvalidated dsh.catalog values, beside a 1,722,904-byte report.md.
    const names = pagesArtifactNames({ plugins: { url: 'plugins.abc.json' }, stars: { url: 'stars.def.json' } })
    for (const forbidden of ['harvest.json', 'report.md', 'classification-report.md']) {
      expect(names).not.toContain(forbidden)
    }
  })

  it('names the two fixed artifacts, and only those, as fixed', () => {
    expect([...PAGES_FIXED_FILES]).toEqual(['index.json', 'badge.json'])
  })

  it('returns a fresh array a caller cannot corrupt for the next call', () => {
    const first = pagesArtifactNames({ plugins: { url: 'plugins.abc.json' } })
    first.push('harvest.json')
    expect(pagesArtifactNames({ plugins: { url: 'plugins.abc.json' } })).not.toContain('harvest.json')
  })
})

describe('npmArtifactNames', () => {
  it('differs from the Pages set by badge.json, and only by that', () => {
    // The badge is a shields.io endpoint fetched over HTTP from Pages; nothing
    // reads it out of the npm tarball. That one-file difference was the only
    // thing separating two hardcoded lists, one of them untested — so it is
    // stated once, here, instead of being a coincidence between two files.
    const pointer = { plugins: { url: 'plugins.abc.json' }, stars: { url: 'stars.def.json' } }
    const pages = pagesArtifactNames(pointer)
    const npm = npmArtifactNames(pointer)
    expect(pages.filter(n => !npm.includes(n))).toEqual(['badge.json'])
    expect(npm.filter(n => !pages.includes(n))).toEqual([])
  })

  it('publishes the pointer and the addressed files, sidecar included when present', () => {
    expect(npmArtifactNames({ plugins: { url: 'plugins.abc.json' }, stars: { url: 'stars.def.json' } }))
      .toEqual(['index.json', 'plugins.abc.json', 'stars.def.json'])
    expect(npmArtifactNames({ plugins: { url: 'plugins.abc.json' } }))
      .toEqual(['index.json', 'plugins.abc.json'])
  })
})

