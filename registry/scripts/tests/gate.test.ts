import { describe, expect, it } from 'vitest'
import {
  ENTRY_PAYLOAD_MAX_BYTES, INTEGRITY_MAX_LENGTH, NAME_MAX_LENGTH, PUBLISHED_AT_MAX_LENGTH,
  PUBLISHER_MAX_LENGTH, VERSION_MAX_LENGTH, gate,
} from '../src/gate.ts'
import { parseRegistryConfig } from '../src/config.ts'
import type { Candidate } from '../src/types.ts'

const config = parseRegistryConfig({
  verified: '- name: dsh-fs-tool\n  reviewedVersion: 1.0.0\n  reviewer: github:r\n  reviewCommit: abc\n',
  denied: '- name: dsh-evil-plugin\n  reason: Exfiltrates credentials.\n',
  allowedSimilar: '- dsh-fs-tools\n',
  categories: '[]',
  firstSeen: '[]',
})

/** An unpaired UTF-16 surrogate: what a naive slice through an astral
 * character leaves behind. `test` is called on fresh strings only, so the
 * regex carries no /g state between assertions. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

function candidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    name: 'dsh-hello-plugin',
    version: '1.0.0',
    integrity: 'sha512-abc',
    publishedAt: '2026-08-01T12:00:00.000Z',
    repository: 'https://github.com/you/hello-plugin',
    license: 'MIT',
    deprecated: false,
    hasBundle: true,
    catalog: { category: 'tool', summary: { en: 'x', zh: 'y' }, capabilities: [] },
    description: 'A friendly hello-world plugin.',
    keywords: [],
    peers: [],
    ...overrides,
  }
}

const withCategories = (rows: Record<string, string>): ReturnType<typeof parseRegistryConfig> =>
  parseRegistryConfig({
    verified: '- name: dsh-fs-tool\n  reviewedVersion: 1.0.0\n  reviewer: github:r\n  reviewCommit: abc\n',
    denied: '- name: dsh-evil-plugin\n  reason: Exfiltrates credentials.\n',
    allowedSimilar: '- dsh-fs-tools\n',
    categories: Object.keys(rows).length === 0 ? '[]' : Object.entries(rows).map(([name, category]) => `- name: ${name}\n  category: ${category}\n`).join(''),
    firstSeen: '[]',
  })

describe('gate', () => {
  it('accepts a complete candidate and marks it declared', () => {
    const result = gate(candidate(), config)
    expect(result.ok).toBe(true)
    expect(result.ok && result.accepted.metadata).toBe('declared')
  })

  it('rejects a package with no dsh.bundle', () => {
    const result = gate(candidate({ hasBundle: false }), config)
    if (result.ok) throw new Error('expected rejection')
    expect(result.rejection.code).toBe('no-bundle')
    expect(result.rejection.detail).toContain('dsh.bundle')
  })

  it('derives a listing from the npm description when dsh.catalog is absent', () => {
    const result = gate(candidate({ catalog: undefined, description: 'Does a helpful thing.' }), config)
    if (!result.ok) throw new Error('expected acceptance')
    expect(result.accepted.metadata).toBe('derived')
    expect(result.accepted.catalog).toEqual({
      category: 'other',
      summary: { en: 'Does a helpful thing.' },
      capabilities: [],
    })
  })

  it('fills a derived listing with its LLM-assigned category', () => {
    const result = gate(
      candidate({ catalog: undefined, description: 'Does a helpful thing.' }),
      withCategories({ 'dsh-hello-plugin': 'tool' }),
    )
    if (!result.ok) throw new Error('expected acceptance')
    expect(result.accepted.metadata).toBe('derived')
    expect(result.accepted.catalog.category).toBe('tool')
  })

  it('defaults a derived listing without a row to other', () => {
    const result = gate(candidate({ catalog: undefined, description: 'Does a helpful thing.' }), withCategories({}))
    if (!result.ok) throw new Error('expected acceptance')
    expect(result.accepted.catalog.category).toBe('other')
  })

  it('never overrides a declared category', () => {
    // candidate() declares category: 'tool' (line 22); a provider row must not win
    const result = gate(candidate(), withCategories({ 'dsh-hello-plugin': 'provider' }))
    if (!result.ok) throw new Error('expected acceptance')
    expect(result.accepted.metadata).toBe('declared')
    expect(result.accepted.catalog.category).toBe('tool')
  })

  it('trims and caps a derived summary at 200 characters', () => {
    const description = `  ${'a'.repeat(210)}  `
    const result = gate(candidate({ catalog: null, description }), config)
    if (!result.ok) throw new Error('expected acceptance')
    expect(result.accepted.catalog.summary.en).toBe('a'.repeat(200))
  })

  it('never splits a surrogate pair when capping a derived summary', () => {
    // Scope, precisely: this pins that the CUT does not create an orphan, so
    // the astral character is dropped whole rather than halved. It is NOT what
    // keeps plugins.json free of unpaired surrogates — the well-formedness
    // pass in emit.ts is, over every string of every Entry, and pipeline.test
    // asserts that. Both exist because they do different things: dropping a
    // half-character reads better than publishing a replacement character in
    // the middle of a word.
    //
    // Why any of it matters, measured end to end: a lone surrogate leaves the
    // emitted JSON valid (JSON.stringify escapes it as \ud83d, so the file is
    // ASCII and the content hash is stable — which is why nothing here would
    // notice), but a consumer that parses that file and re-encodes UTF-8 fails
    // on it; Python raises "surrogates not allowed".
    // 199 filler + a 2-unit emoji puts the split exactly at the bound.
    const description = `${'a'.repeat(199)}\u{1F600}tail`
    const result = gate(candidate({ catalog: null, description }), config)
    if (!result.ok) throw new Error('expected acceptance')
    const en = result.accepted.catalog.summary.en
    expect(en).toMatch(/^a{199}$/)
    expect(LONE_SURROGATE.test(en)).toBe(false)
  })

  it('keeps an astral character that ends exactly at the cap', () => {
    // The complement, and the reason the fix drops a code unit rather than
    // always trimming one: 198 filler + a 2-unit emoji is exactly 200, a whole
    // pair, and it must survive intact.
    const description = `${'a'.repeat(198)}\u{1F600}tail`
    const result = gate(candidate({ catalog: null, description }), config)
    if (!result.ok) throw new Error('expected acceptance')
    const en = result.accepted.catalog.summary.en
    expect(en.length).toBe(200)
    expect(en.endsWith('\u{1F600}')).toBe(true)
    expect(LONE_SURROGATE.test(en)).toBe(false)
  })

  it('never splits a pair at either end of the surrogate range', () => {
    // The emoji above has the high surrogate 0xD83D, comfortably inside the
    // range, so it cannot tell 0xDBFF from 0xDBFE — verified by mutation, that
    // narrowing survived. These three pin both ends: U+10000 is the first
    // astral character (high 0xD800) and U+10FFFF the last (high 0xDBFF).
    for (const [label, codePoint] of [
      ['U+10000, high surrogate 0xD800', 0x10000],
      ['U+1F600, high surrogate 0xD83D', 0x1F600],
      ['U+10FFFF, high surrogate 0xDBFF', 0x10FFFF],
    ] as [string, number][]) {
      const description = `${'a'.repeat(199)}${String.fromCodePoint(codePoint)}tail`
      const result = gate(candidate({ catalog: null, description }), config)
      expect(result.ok, label).toBe(true)
      if (!result.ok) continue
      const en = result.accepted.catalog.summary.en
      expect(en, label).toMatch(/^a{199}$/)
      expect(LONE_SURROGATE.test(en), label).toBe(false)
    }
  })

  it('rejects a package with neither dsh.catalog nor an npm description as no-summary', () => {
    const result = gate(candidate({ catalog: undefined, description: null }), config)
    if (result.ok) throw new Error('expected rejection')
    expect(result.rejection.code).toBe('no-summary')
  })

  it('rejects a package whose description is blank as no-summary', () => {
    const result = gate(candidate({ catalog: null, description: '   ' }), config)
    if (result.ok) throw new Error('expected rejection')
    expect(result.rejection.code).toBe('no-summary')
  })

  it('rejects an invalid dsh.catalog and names the offending field, never falling back to derived', () => {
    const result = gate(candidate({ catalog: { category: 'nope' } }), config)
    if (result.ok) throw new Error('expected rejection')
    expect(result.rejection.code).toBe('invalid-catalog')
    expect(result.rejection.detail).toContain('category')
  })

  it('rejects a denied package and quotes the reason, carrying no replacement when none is recorded', () => {
    const result = gate(candidate({ name: 'dsh-evil-plugin' }), config)
    if (result.ok) throw new Error('expected rejection')
    expect(result.rejection.code).toBe('denied')
    expect(result.rejection.detail).toBe('Denied by the registry: Exfiltrates credentials.')
    expect(result.rejection.replacement).toBeUndefined()
  })

  it('names the recorded replacement in the detail of a denied package', () => {
    const denied = parseRegistryConfig({
      verified: '- name: dsh-fs-tool\n  reviewedVersion: 1.0.0\n  reviewer: github:r\n  reviewCommit: abc\n',
      denied: '- name: dsh-evil-plugin\n  reason: Exfiltrates credentials.\n  replacement: dsh-good-plugin\n',
      allowedSimilar: '[]',
      categories: '[]',
      firstSeen: '[]',
    })
    const result = gate(candidate({ name: 'dsh-evil-plugin' }), denied)
    if (result.ok) throw new Error('expected rejection')
    expect(result.rejection.code).toBe('denied')
    expect(result.rejection.detail)
      .toBe('Denied by the registry: Exfiltrates credentials. Known replacement: dsh-good-plugin.')
    expect(result.rejection.replacement).toBe('dsh-good-plugin')
  })

  it('rejects a deprecated package', () => {
    const result = gate(candidate({ deprecated: true }), config)
    if (result.ok) throw new Error('expected rejection')
    expect(result.rejection.code).toBe('deprecated')
  })

  it('rejects a package with no license', () => {
    const result = gate(candidate({ license: null }), config)
    if (result.ok) throw new Error('expected rejection')
    expect(result.rejection.code).toBe('no-license')
  })

  it('rejects a package with no repository and says why that matters', () => {
    const result = gate(candidate({ repository: null }), config)
    if (result.ok) throw new Error('expected rejection')
    expect(result.rejection.code).toBe('no-repository')
    expect(result.rejection.detail).toContain('audit')
  })

  it('rejects a repository naming the harness itself, which holds none of the plugin source', () => {
    const result = gate(candidate({ repository: 'https://github.com/deepseek-ai/deepseek-harness' }), config)
    if (result.ok) throw new Error('expected rejection')
    expect(result.rejection.code).toBe('harness-repository')
    expect(result.rejection.detail).toContain('deepseek-harness')
  })

  it('rejects the harness repository even with a trailing slash', () => {
    const result = gate(candidate({ repository: 'https://github.com/deepseek-ai/deepseek-harness/' }), config)
    if (result.ok) throw new Error('expected rejection')
    expect(result.rejection.code).toBe('harness-repository')
  })

  it('rejects the harness repository regardless of letter case', () => {
    // GitHub resolves repo URLs case-insensitively, so a casing variant of
    // the same URL is still the host project, not the plugin's source.
    const result = gate(candidate({ repository: 'https://github.com/DEEPSEEK-AI/DEEPSEEK-HARNESS' }), config)
    if (result.ok) throw new Error('expected rejection')
    expect(result.rejection.code).toBe('harness-repository')
  })

  it('keeps a repository whose own name merely contains deepseek-harness', () => {
    const result = gate(candidate({ repository: 'https://github.com/syncended/deepseek-harness-automations' }), config)
    expect(result.ok).toBe(true)
  })

  it('rejects a package with no integrity', () => {
    const result = gate(candidate({ integrity: null }), config)
    if (result.ok) throw new Error('expected rejection')
    expect(result.rejection.code).toBe('no-integrity')
  })

  it('rejects a package with no publication time under its own code', () => {
    const result = gate(candidate({ publishedAt: null }), config)
    if (result.ok) throw new Error('expected rejection')
    expect(result.rejection.code).toBe('no-publish-time')
  })

  it('holds a name one edit away from a verified name', () => {
    const result = gate(candidate({ name: 'dsh-fs-too1' }), config)
    if (result.ok) throw new Error('expected rejection')
    expect(result.rejection.code).toBe('name-too-similar')
    expect(result.rejection.detail).toContain('dsh-fs-tool')
  })

  it('holds a name two edits away from a verified name', () => {
    const result = gate(candidate({ name: 'dsh-fs-t00l' }), config)
    if (result.ok) throw new Error('expected rejection')
    expect(result.rejection.code).toBe('name-too-similar')
  })

  it('admits a name three edits away', () => {
    expect(gate(candidate({ name: 'dsh-fs-t001' }), config).ok).toBe(true)
  })

  it('admits the verified name itself, which is distance zero', () => {
    // `dsh-fs-tool` is verified by `reviewedVersion`, i.e. AS THIS NPM
    // PACKAGE, so the candidate is the reviewed identity and the hold does
    // not apply. A name verified by a repository pin is a different identity
    // and IS held — see "holds an npm package whose exact name is verified as
    // a REPOSITORY".
    expect(gate(candidate({ name: 'dsh-fs-tool' }), config).ok).toBe(true)
  })

  it('admits a similar name cleared in allowed-similar', () => {
    expect(gate(candidate({ name: 'dsh-fs-tools' }), config).ok).toBe(true)
  })

  it('checks denial before similarity, so a denied lookalike reports denial', () => {
    const denied = parseRegistryConfig({
      verified: '- name: dsh-fs-tool\n  reviewedVersion: 1.0.0\n  reviewer: r\n  reviewCommit: c\n',
      denied: '- name: dsh-fs-too1\n  reason: Typosquat.\n',
      allowedSimilar: '[]',
      categories: '[]',
      firstSeen: '[]',
    })
    const result = gate(candidate({ name: 'dsh-fs-too1' }), denied)
    if (result.ok) throw new Error('expected rejection')
    expect(result.rejection.code).toBe('denied')
  })
})

describe('the shop excludes itself', () => {
  // The shop is a dsh plugin and its package.json now carries both harvest
  // keywords, exactly as it asks plugin authors to. That makes it a candidate
  // in its own catalog: `gate.ts` has no build-script or workspace-deps check
  // (those live in repo-gate.ts), so nothing else here would stop it. Only the
  // client's shop-like NAME filter would, and that hides it from the shelf
  // while still counting it in the data — the discrepancy that filter's own
  // history is a record of. Excluded at the gate instead, with a reason.

  it('rejects its own npm package rather than listing itself', () => {
    const result = gate(candidate({ name: 'dsh-plugin-shop' }), config)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.rejection.code).toBe('self')
    expect(result.rejection.detail).toMatch(/the shop itself/i)
    expect(result.rejection.detail).toMatch(/dsh plugin add/)
  })

  it('rejects the catalog package it publishes alongside itself', () => {
    const result = gate(candidate({ name: 'dsh-plugin-shop-catalog' }), config)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.rejection.code).toBe('self')
  })

  it('does not reject someone else whose name merely contains ours', () => {
    // Exact names only. A fork, a scoped republish or a near-miss is somebody
    // else's package: it gets judged on its merits, and the shop-like name
    // filter is what keeps a competing market off the shelf.
    for (const name of ['dsh-plugin-shop-fork', '@someone/dsh-plugin-shop', 'my-dsh-plugin-shop']) {
      const result = gate(candidate({ name }), config)
      expect(result.ok, `${name} must not be excluded as self`).toBe(true)
    }
  })
})

describe('field length bounds', () => {
  it('rejects an over-long license with a reason that is about its length', () => {
    // Not "Declares no license." — the author declared one and it is 1 MB. A
    // wrong published reason is a defect, not a wording nit.
    const result = gate(candidate({ license: 'M'.repeat(129) }), config)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.rejection.code).toBe('no-license')
      expect(result.rejection.detail).toBe('Declares a license string longer than 128 characters, so it is not an SPDX identifier.')
    }
  })

  it('rejects an over-long repository with a reason that is about its length', () => {
    const result = gate(candidate({ repository: `https://github.com/you/${'x'.repeat(512)}` }), config)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.rejection.code).toBe('no-repository')
      expect(result.rejection.detail).toBe('Declares a repository URL longer than 512 characters, so it cannot be audited as a source location.')
    }
  })

  it('accepts a license and a repository at the bounds', () => {
    expect(gate(candidate({ license: 'M'.repeat(128) }), config).ok).toBe(true)
    expect(gate(candidate({ repository: `https://h/${'x'.repeat(502)}` }), config).ok).toBe(true)
  })
})

describe('the identity and provenance fields npm hands us', () => {
  // `name`, `version`, `integrity`, `publishedAt` and `publisher` are taken
  // from the packument verbatim and reach plugins.json, manifest.lock,
  // first-seen.yml (committed and pushed) and report.md. Nothing bounded them:
  // Task 7 set out to bound "every free-text field that reaches a published
  // artifact" and its Produces list simply never named these five.
  //
  // Each bound lives in the gate rather than in `toCandidate`, for the reason
  // the license bound already states: nulling the field in the projection
  // would publish "Declares no license." about a package that declared a
  // megabyte one, and a misattributed published reason is a defect.

  it('states each bound as a literal, so a fixture cannot follow the value it tests', () => {
    expect(NAME_MAX_LENGTH).toBe(214)
    expect(VERSION_MAX_LENGTH).toBe(128)
    expect(INTEGRITY_MAX_LENGTH).toBe(256)
    expect(PUBLISHED_AT_MAX_LENGTH).toBe(64)
    expect(PUBLISHER_MAX_LENGTH).toBe(128)
  })

  it('rejects an over-long package name and does not republish it in the row', () => {
    // The rejection's own `name` is what report.md prints, so an unbounded
    // name would put its megabyte into the published report by way of the
    // rejection that was meant to stop it. Checked FIRST in the gate for
    // exactly that reason: every later rejection then carries a bounded name.
    const name = `dsh-${'n'.repeat(300)}`
    const result = gate(candidate({ name }), config)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.rejection.code).toBe('no-manifest')
    expect(result.rejection.detail).toBe(
      "Declares a package name longer than 214 characters, which is past npm's own limit, so it cannot be listed; the name in this row is cut to that length.")
    expect(result.rejection.name.length).toBeLessThanOrEqual(NAME_MAX_LENGTH + 1)
    expect(result.rejection.name.startsWith('dsh-nnn')).toBe(true)
  })

  it("accepts a package name exactly at npm's own limit", () => {
    expect(gate(candidate({ name: 'd'.repeat(NAME_MAX_LENGTH) }), config).ok).toBe(true)
  })

  it('rejects an over-long version with a reason about its length', () => {
    const result = gate(candidate({ version: `1.0.0-${'b'.repeat(200)}` }), config)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.rejection.code).toBe('no-manifest')
    expect(result.rejection.detail).toBe(
      'Declares a version string longer than 128 characters, so it is not a version the snapshot can record.')
  })

  it('rejects an over-long dist.integrity under the integrity code', () => {
    // Not `no-manifest`: npm's own no-integrity rejection already says "cannot
    // be recorded in the snapshot", and this is the same failure by another
    // route, so it reads under the same code.
    const result = gate(candidate({ integrity: `sha512-${'A'.repeat(300)}` }), config)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.rejection.code).toBe('no-integrity')
    expect(result.rejection.detail).toBe(
      "The published version's dist.integrity is longer than 256 characters, so it cannot be recorded in the snapshot.")
  })

  it('rejects an over-long publication time under the publish-time code', () => {
    const result = gate(candidate({ publishedAt: `2026-08-01T12:00:00.000Z${' '.repeat(80)}` }), config)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.rejection.code).toBe('no-publish-time')
    expect(result.rejection.detail).toBe(
      'npm reports a publication time longer than 64 characters, which is not a timestamp.')
  })

  it('rejects an over-long publisher rather than publishing the provenance claim', () => {
    // `publisher` is the registry's own statement of who pushed this version —
    // provenance, not decoration (see Candidate.publisher for why it is not
    // `author`). A value that cannot be an account name is a provenance claim
    // we will not republish, and the gate cannot drop the field on its own:
    // assignTier reads candidate.publisher directly.
    const result = gate(candidate({ publisher: 'p'.repeat(129) }), config)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.rejection.code).toBe('no-manifest')
    expect(result.rejection.detail).toBe(
      'Names a publishing account longer than 128 characters, which is not an npm account name.')
  })

  it('accepts every one of the five at its bound', () => {
    // The other side of each bound. A bound wired one character low would pass
    // every rejection test above and quietly stop listing real packages.
    expect(gate(candidate({ name: 'd'.repeat(NAME_MAX_LENGTH) }), config).ok, 'name').toBe(true)
    expect(gate(candidate({ version: '1'.repeat(VERSION_MAX_LENGTH) }), config).ok, 'version').toBe(true)
    expect(gate(candidate({ integrity: 'i'.repeat(INTEGRITY_MAX_LENGTH) }), config).ok, 'integrity').toBe(true)
    expect(gate(candidate({ publishedAt: 'p'.repeat(PUBLISHED_AT_MAX_LENGTH) }), config).ok, 'publishedAt').toBe(true)
    expect(gate(candidate({ publisher: 'p'.repeat(PUBLISHER_MAX_LENGTH) }), config).ok, 'publisher').toBe(true)
  })

  it('leaves a package that names no publisher alone', () => {
    // Absent stays absent: the bound must not turn a missing field into a
    // rejection or into an empty string.
    const result = gate(candidate({ publisher: undefined }), config)
    expect(result.ok).toBe(true)
  })
})

describe('the per-entry size budget', () => {
  // Every field above is bounded on its own, and their PRODUCT was the
  // ceiling: against the peer bounds this budget was written to answer (200
  // names x 214 characters) one npm entry cost 49,055 bytes of plugins.json,
  // 44.2 KiB of it `peers`. Against the live catalog (3,514 npm + 5,908 github
  // entries, 7.51 MB, 797 B average) that put the aggregate ceiling at ~186 MiB
  // and let 100 hostile packages add 4.7 MB to a 7.2 MB file. The peer bounds
  // have since been cut to 128 x 128 (peers block 17,959 bytes, entry 21,775),
  // which is still 1.46x this budget on the peers alone — the budget, not the
  // peer bounds, is what caps the total instead of each part.
  //
  // Deliberately NOT jointly satisfiable with the per-field bounds: the field
  // bounds say what one value may look like, the budget says what the whole
  // entry may cost, and a package that maxes out every field at once is
  // refused. That is the point of having both.

  const peers = (count: number, length: number): string[] =>
    Array.from({ length: count }, (_, i) => `${String(i).padStart(4, '0')}${'p'.repeat(length - 4)}`)

  it('states the budget as a literal', () => {
    expect(ENTRY_PAYLOAD_MAX_BYTES).toBe(12 * 1024)
  })

  it('rejects an entry whose published payload is past the budget', () => {
    // The shape the risk actually has today: `peers` was bounded at 200 names
    // of 214 characters, 12x the live maximum of 58 names of 50 characters.
    const result = gate(candidate({ peers: peers(200, 214) }), config)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.rejection.code).toBe('no-manifest')
    expect(result.rejection.detail).toBe(
      'Would publish 45620 bytes of catalog entry, past the 12288-byte budget one entry may occupy in plugins.json.')
  })

  it('accepts the worst entry the live catalog could hold', () => {
    // Every maximum measured against the live published catalog on 2026-09-04,
    // all in ONE entry — they are independent observations, so this entry
    // almost certainly does not exist, and it is the ceiling of what the data
    // could hold. It measures 6,261 bytes against a 12,288-byte budget, so
    // the budget drops nothing that is listed today.
    //
    // capability item 14, license 37, repository 108, summary.en 200 code
    // units / 599 UTF-8 bytes, peer name 50, peers count 58. The summaries are
    // CJK, which is where the 599 bytes come from: the budget counts UTF-8
    // bytes, because that is what a reader downloads.
    const summary = `${'中'.repeat(199)}x`
    const result = gate(candidate({
      name: 'd'.repeat(214),
      version: '1.0.0-rc.1+build.20260904',
      integrity: `sha512-${'A'.repeat(88)}`,
      publishedAt: '2026-09-04T12:00:00.000Z',
      repository: `https://github.com/an-organization/${'r'.repeat(73)}`,
      license: 'l'.repeat(37),
      publisher: 'p'.repeat(50),
      peers: peers(58, 50),
      catalog: {
        category: 'tool',
        summary: { en: summary, zh: summary },
        capabilities: Array.from({ length: 20 }, () => 'c'.repeat(14)),
      },
    }), config)
    expect(result.ok).toBe(true)
  })

  it('reports the size only after every reason that names a field', () => {
    // A hostile package that is over budget AND missing a license reads the
    // license reason: the specific answer helps the author, the size does not.
    const result = gate(candidate({ peers: peers(200, 214), license: null }), config)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.rejection.code).toBe('no-license')
  })

  it('counts UTF-8 bytes, not code units', () => {
    // A three-byte character costs a reader three bytes, so that is what the
    // budget counts. 100 peer names of 48 characters, 44 of them CJK, weigh
    // 15,220 UTF-8 bytes and 6,439 code units: over the budget by the true
    // measure and half of it by the wrong one. A budget counting code units
    // would let a CJK entry occupy three times what it may.
    const cjkPeers = Array.from({ length: 100 }, (_, i) => `${String(i).padStart(4, '0')}${'中'.repeat(44)}`)
    const result = gate(candidate({ peers: cjkPeers }), config)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.rejection.code).toBe('no-manifest')
    expect(result.rejection.detail).toBe(
      'Would publish 15220 bytes of catalog entry, past the 12288-byte budget one entry may occupy in plugins.json.')
    // The arithmetic the claim rests on, stated rather than assumed: measured
    // in code units the same payload is well inside the budget, so a budget
    // reading `String.length` would have accepted it.
    expect(JSON.stringify({ plugins: [{ peers: cjkPeers }] }, null, 2).length).toBeLessThan(ENTRY_PAYLOAD_MAX_BYTES)
  })
})

describe('the hold and the candidate own identity', () => {
  it('lists two verified names one edit apart instead of holding each against the other', () => {
    // B-4: verifying dsh-tool-a and dsh-tool-b — distance 1, the shape of a
    // same-author suite — removed BOTH from the catalog, each "Within 1
    // edit(s) of the verified package" the other. A review is already the
    // adjudication the hold asks for.
    const suite = parseRegistryConfig({
      verified: [
        '- name: dsh-tool-a\n  reviewedVersion: 1.0.0\n  reviewer: r\n  reviewCommit: c\n',
        '- name: dsh-tool-b\n  reviewedVersion: 1.0.0\n  reviewer: r\n  reviewCommit: c\n',
      ].join(''),
      denied: '[]',
      allowedSimilar: '[]',
      categories: '[]',
      firstSeen: '[]',
    })
    expect(gate(candidate({ name: 'dsh-tool-a' }), suite).ok).toBe(true)
    expect(gate(candidate({ name: 'dsh-tool-b' }), suite).ok).toBe(true)
  })

  const repoPinned = parseRegistryConfig({
    verified: [
      '- name: dsh-x',
      '  repo: good/dsh-x',
      `  reviewedCommit: ${'a'.repeat(40)}`,
      '  reviewer: github:r',
      '  reviewCommit: c',
    ].join('\n') + '\n',
    denied: '[]',
    allowedSimilar: '[]',
    categories: '[]',
    firstSeen: '[]',
  })

  it('holds an npm package whose exact name is verified as a REPOSITORY', () => {
    // A-2: `good/dsh-x` is verified by commit. Publishing `dsh-x` on npm used
    // to skip the hold at distance 0, shadow the repo entry, and turn
    // `github:good/dsh-x tier=verified` into `npm:dsh-x tier=community
    // publisher=whoever`. The npm package is a DIFFERENT identity.
    const result = gate(candidate({ name: 'dsh-x' }), repoPinned)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.rejection.code).toBe('name-too-similar')
    expect(result.rejection.detail).toContain('dsh-x')
    expect(result.rejection.detail).toContain('verified as a repository')
  })

  it('clears that npm name when a human records it in allowed-similar', () => {
    // The escape is the npm NAME form: `good/dsh-x` in allowed-similar.yml
    // clears the GitHub channel and says nothing about who may publish the
    // name on npm.
    const cleared = parseRegistryConfig({
      verified: [
        '- name: dsh-x',
        '  repo: good/dsh-x',
        `  reviewedCommit: ${'a'.repeat(40)}`,
        '  reviewer: github:r',
        '  reviewCommit: c',
      ].join('\n') + '\n',
      denied: '[]',
      allowedSimilar: '- dsh-x\n',
      categories: '[]',
      firstSeen: '[]',
    })
    expect(gate(candidate({ name: 'dsh-x' }), cleared).ok).toBe(true)
  })

  it('still holds a lookalike of a repo-verified name', () => {
    const result = gate(candidate({ name: 'dsh-xx' }), repoPinned)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.rejection.code).toBe('name-too-similar')
  })
})

describe('a denial names a project, not one of its two spellings', () => {
  const denied = parseRegistryConfig({
    verified: '[]',
    denied: '- name: Evil/dsh-x\n  reason: Exfiltrates credentials.\n  replacement: dsh-good\n',
    allowedSimilar: '[]',
    categories: '[]',
    firstSeen: '[]',
  })

  it('rejects an npm package whose declared repository is denied, whatever the case', () => {
    const result = gate(candidate({ name: 'dsh-x', repository: 'https://github.com/evil/dsh-x' }), denied)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.rejection.code).toBe('denied')
    expect(result.rejection.detail)
      .toBe('Denied by the registry: Exfiltrates credentials. Known replacement: dsh-good.')
    expect(result.rejection.replacement).toBe('dsh-good')

    // And with the OTHER spelling. The denial is written `Evil/dsh-x` and
    // lowercased at insert, so only a candidate declaring the repository in a
    // different case exercises the fold on the lookup side — the assertion
    // above passes with it removed.
    const cased = gate(candidate({ name: 'dsh-x', repository: 'https://github.com/Evil/dsh-x' }), denied)
    expect(cased.ok).toBe(false)
    if (!cased.ok) expect(cased.rejection.code).toBe('denied')
  })

  it('leaves a package from another repository alone', () => {
    expect(gate(candidate({ name: 'dsh-x', repository: 'https://github.com/honest/dsh-x' }), denied).ok).toBe(true)
  })

  it('does not trip over a package that declares no repository', () => {
    // The denial check runs before the no-repository check, so a null
    // repository must reach the no-repository rejection, not throw here.
    const result = gate(candidate({ name: 'dsh-x', repository: null }), denied)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.rejection.code).toBe('no-repository')
  })
})
