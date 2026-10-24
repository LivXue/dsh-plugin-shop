import { describe, expect, it } from 'vitest'
import { PAGES_ONLY_FILES, npmArtifactNames, pagesArtifactNames } from '../src/pages-artifacts.ts'

const WITH_CLASSIFICATION = { classificationReport: true }
const WITHOUT_CLASSIFICATION = { classificationReport: false }
const ICONS = { url: 'icons.ghi.json', sha256: 'ghi' }

describe('pagesArtifactNames', () => {
  it('publishes the data files, the badge and both reports', () => {
    expect(pagesArtifactNames(
      { plugins: { url: 'plugins.abc.json' }, stars: { url: 'stars.def.json' } },
      WITH_CLASSIFICATION,
    )).toEqual([
      'index.json', 'plugins.abc.json', 'stars.def.json',
      'badge.json', 'report.md', 'classification-report.md',
    ])
  })

  it('publishes the icons file beside the stars sidecar, and either without the other', () => {
    // The icons file is addressed by its own hash like the stars sidecar and
    // reaches Pages the same way (design 2026-10-23-shop-plugin-icons §6.3).
    expect(pagesArtifactNames(
      { plugins: { url: 'plugins.abc.json' }, stars: { url: 'stars.def.json' }, icons: ICONS },
      WITH_CLASSIFICATION,
    )).toEqual([
      'index.json', 'plugins.abc.json', 'stars.def.json', 'icons.ghi.json',
      'badge.json', 'report.md', 'classification-report.md',
    ])
    expect(pagesArtifactNames({ plugins: { url: 'plugins.abc.json' }, icons: ICONS }, WITH_CLASSIFICATION))
      .toEqual(['index.json', 'plugins.abc.json', 'icons.ghi.json', 'badge.json', 'report.md', 'classification-report.md'])
  })

  it('omits the sidecar when the build produced none', () => {
    // The stars fetch is advisory: no token, a rate limit or a down API
    // publishes without it, and the pointer then has no `stars` key. The icon
    // step is advisory in the same way (an icon never blocks a listing, design
    // 2026-10-23-shop-plugin-icons §2, decision 6): a build that read no icon
    // writes no file and the pointer has no `icons` key.
    expect(pagesArtifactNames({ plugins: { url: 'plugins.abc.json' } }, WITH_CLASSIFICATION))
      .toEqual(['index.json', 'plugins.abc.json', 'badge.json', 'report.md', 'classification-report.md'])
  })

  it('omits the classification report when the classifier did not run', () => {
    // `classify.ts` is a separate process. The daily workflow runs it before
    // the build, but a local `pnpm build:catalog` does not, and a name in this
    // list that is not on disk is a copy that throws in `build.ts`.
    expect(pagesArtifactNames({ plugins: { url: 'plugins.abc.json' } }, WITHOUT_CLASSIFICATION))
      .toEqual(['index.json', 'plugins.abc.json', 'badge.json', 'report.md'])
  })

  it('publishes the build report unconditionally, because the build writes it', () => {
    // Not a flag on purpose: `build.ts` writes report.md a few lines before it
    // stages Pages, so there is no build that lacks one, and a flag would only
    // create a way to unpublish it by passing false.
    for (const reports of [WITH_CLASSIFICATION, WITHOUT_CLASSIFICATION]) {
      expect(pagesArtifactNames({ plugins: { url: 'plugins.abc.json' } }, reports)).toContain('report.md')
    }
  })

  it('never lists the internal handoff', () => {
    // Pages served harvest.json because upload-pages-artifact was pointed at
    // `dist`. Measured live on 2026-09-04: 4,037,180 bytes of every candidate
    // verbatim, rejected ones included, with unvalidated dsh.catalog values.
    // Unlike the two reports beside it, nothing escapes it and nothing is
    // meant to read it, so it stays out permanently (2026-09-07 amendment).
    for (const reports of [WITH_CLASSIFICATION, WITHOUT_CLASSIFICATION]) {
      expect(pagesArtifactNames(
        { plugins: { url: 'plugins.abc.json' }, stars: { url: 'stars.def.json' }, icons: ICONS },
        reports,
      )).not.toContain('harvest.json')
    }
  })

  it('names the browser-only artifacts, and only those, as Pages-only', () => {
    expect([...PAGES_ONLY_FILES]).toEqual(['badge.json', 'report.md', 'classification-report.md'])
  })

  it('returns a fresh array a caller cannot corrupt for the next call', () => {
    const first = pagesArtifactNames({ plugins: { url: 'plugins.abc.json' } }, WITH_CLASSIFICATION)
    first.push('harvest.json')
    expect(pagesArtifactNames({ plugins: { url: 'plugins.abc.json' } }, WITH_CLASSIFICATION))
      .not.toContain('harvest.json')
  })
})

describe('npmArtifactNames', () => {
  it('carries the machine-readable set and none of the browser-only files', () => {
    // The badge is a shields.io endpoint fetched over HTTP from Pages; the two
    // reports are opened by a person in a browser. Nothing reads any of them
    // out of the tarball, and a 1.7 MB report in every consumer's node_modules
    // has no reader at all. The data files are stated once for both
    // transports, so a new one reaches both or neither.
    const pointer = { plugins: { url: 'plugins.abc.json' }, stars: { url: 'stars.def.json' }, icons: ICONS }
    const pages = pagesArtifactNames(pointer, WITH_CLASSIFICATION)
    const npm = npmArtifactNames(pointer)
    expect(pages.filter(n => !npm.includes(n))).toEqual([...PAGES_ONLY_FILES])
    expect(npm.filter(n => !pages.includes(n))).toEqual([])
  })

  it('publishes the pointer and the addressed files, sidecars included when present', () => {
    expect(npmArtifactNames({ plugins: { url: 'plugins.abc.json' }, stars: { url: 'stars.def.json' } }))
      .toEqual(['index.json', 'plugins.abc.json', 'stars.def.json'])
    expect(npmArtifactNames({ plugins: { url: 'plugins.abc.json' } }))
      .toEqual(['index.json', 'plugins.abc.json'])
    // The icons file rides the package with the others: the shop's npm origin
    // serves a named file out of the tarball and answers a name the package
    // does not hold with a TransportError, so an index naming a file this list
    // left out would break the icons on that route.
    expect(npmArtifactNames({ plugins: { url: 'plugins.abc.json' }, stars: { url: 'stars.def.json' }, icons: ICONS }))
      .toEqual(['index.json', 'plugins.abc.json', 'stars.def.json', 'icons.ghi.json'])
    expect(npmArtifactNames({ plugins: { url: 'plugins.abc.json' }, icons: ICONS }))
      .toEqual(['index.json', 'plugins.abc.json', 'icons.ghi.json'])
  })

  it('returns a fresh array a caller cannot corrupt for the next call', () => {
    const pointer = { plugins: { url: 'plugins.abc.json' } }
    npmArtifactNames(pointer).push('report.md')
    expect(npmArtifactNames(pointer)).toEqual(['index.json', 'plugins.abc.json'])
  })
})
