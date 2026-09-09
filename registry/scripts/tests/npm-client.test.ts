import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { type Cell, cellKey, cellQuery, FetchTimeoutError, fetchCandidate, fetchCandidates, HARVEST_CONCURRENCY, HARVEST_KEYWORDS, keywordQuery, maintainersOf, MAINTAINERS_MAX_COUNT, MAX_PACKUMENT_BYTES, MAX_SEARCH_BODY_BYTES, MAX_SEARCH_FROM, MAX_SEARCH_SHORTFALL, MAX_UNREACHABLE_RESIDUAL, MIN_UNREACHABLE_RECOVERY, describeShortfall, parseKeywordShortfall, type KeywordShortfall, PARTITION_KEYWORDS, partitionKeyword, PEER_NAME_MAX_LENGTH, PEERS_MAX_COUNT, SEARCH_WINDOW, searchByKeywords, toCandidate, withTimeout } from '../src/npm-client.ts'
import { ENTRY_PAYLOAD_MAX_BYTES, entryPayloadBytes } from '../src/gate.ts'
import { MAX_TARBALL_BYTES } from '../src/github-client.ts'
import { headersThenBodyError, headersThenSlowBody, headersThenStalledBody } from './stalling-fetch.ts'

describe('HARVEST_KEYWORDS', () => {
  it('leads with the ecosystem keyword and adds the harness keyword, neither branded', () => {
    expect(HARVEST_KEYWORDS).toEqual(['dsh-plugin', 'deepseek-harness'])
  })
})

describe('toCandidate', () => {
  const packument = {
    name: 'dsh-hello-plugin',
    'dist-tags': { latest: '1.2.0' },
    time: { '1.2.0': '2026-08-01T12:00:00.000Z' },
    versions: {
      '1.2.0': {
        dist: { integrity: 'sha512-hello' },
        license: 'MIT',
        repository: { url: 'git+https://github.com/you/hello-plugin.git' },
        description: 'Says hello.',
        dsh: {
          bundle: { patch: './cordis.patch.yml' },
          catalog: { category: 'tool', summary: { en: 'x', zh: 'y' }, capabilities: [] },
        },
      },
    },
  }

  it('reads an empty deprecated string as NOT deprecated, which is how npm spells un-deprecate', () => {
    // `npm deprecate <pkg> ""` is the documented way to undo a deprecation
    // and it leaves the key in place with an empty value. Reading "the key
    // exists" published "Marked deprecated on npm." for a package whose
    // author had explicitly withdrawn that.
    const undeprecated = {
      ...packument,
      versions: { '1.2.0': { ...packument.versions['1.2.0'], deprecated: '' } },
    }
    expect(toCandidate(undeprecated)?.deprecated).toBe(false)
    const blank = {
      ...packument,
      versions: { '1.2.0': { ...packument.versions['1.2.0'], deprecated: '   ' } },
    }
    expect(blank && toCandidate(blank)?.deprecated).toBe(false)
  })

  it('still reads a real deprecation message, and a bare boolean', () => {
    const withMessage = {
      ...packument,
      versions: { '1.2.0': { ...packument.versions['1.2.0'], deprecated: 'use dsh-hello-2 instead' } },
    }
    expect(toCandidate(withMessage)?.deprecated).toBe(true)
    // Some manifests carry `true` rather than a message; refusing to read it
    // would list a deprecated package.
    const withBoolean = {
      ...packument,
      versions: { '1.2.0': { ...packument.versions['1.2.0'], deprecated: true } },
    }
    expect(toCandidate(withBoolean)?.deprecated).toBe(true)
  })

  it('reads the legacy license object and licenses array npm still serves', () => {
    const legacyObject = {
      ...packument,
      versions: {
        '1.2.0': { ...packument.versions['1.2.0'], license: { type: 'MIT', url: 'http://example.test/LICENSE' } },
      },
    }
    expect(toCandidate(legacyObject)?.license).toBe('MIT')
    const legacyArray = {
      ...packument,
      versions: {
        '1.2.0': {
          ...packument.versions['1.2.0'],
          license: undefined,
          licenses: [{ type: 'Apache-2.0', url: 'http://example.test/LICENSE' }],
        },
      },
    }
    expect(toCandidate(legacyArray)?.license).toBe('Apache-2.0')
    const legacyStringArray = {
      ...packument,
      versions: { '1.2.0': { ...packument.versions['1.2.0'], license: undefined, licenses: ['ISC'] } },
    }
    expect(toCandidate(legacyStringArray)?.license).toBe('ISC')
  })

  it('reports no license only when nothing declares one', () => {
    const none = {
      ...packument,
      versions: { '1.2.0': { ...packument.versions['1.2.0'], license: undefined } },
    }
    expect(toCandidate(none)?.license).toBeNull()
    const empty = {
      ...packument,
      versions: { '1.2.0': { ...packument.versions['1.2.0'], license: '  ' } },
    }
    expect(toCandidate(empty)?.license).toBeNull()
    const objectWithoutType = {
      ...packument,
      versions: { '1.2.0': { ...packument.versions['1.2.0'], license: { url: 'http://example.test/L' } } },
    }
    expect(toCandidate(objectWithoutType)?.license).toBeNull()
  })

  it('never takes the publisher from the unverified author field', () => {
    // `author` is free text the publisher writes, and a clone inherits it
    // verbatim: `dsh-agent-squad`, published by the account `shenzhsjtu`,
    // carries the name and email of the author of the package it copied.
    // Presenting that as the publisher would print the original author's name
    // on the clone — the exact opposite of what the row is for.
    const withAuthor = {
      ...packument,
      maintainers: [{ name: 'realauthor' }],
      versions: {
        '1.2.0': {
          ...packument.versions['1.2.0'],
          _npmUser: { name: 'realauthor', email: 'real@example.com' },
          author: { name: 'Someone Else', email: 'someone@else.test' },
        },
      },
    }
    expect(toCandidate(withAuthor)?.publisher).toBe('realauthor')
  })

  it('carries no publisher when there is no maintainer account to name', () => {
    // With no maintainers there is nothing corroborating `_npmUser`, and an
    // uncorroborated value can be the CI robot. No answer beats a wrong one.
    const orphan = {
      ...packument,
      versions: { '1.2.0': { ...packument.versions['1.2.0'], _npmUser: { name: 'GitHub Actions' } } },
    }
    expect(toCandidate(orphan)?.publisher).toBeUndefined()
  })

  it('falls back to the owning account when the publish came from CI', () => {
    // Measured on 250 live npm entries: 30 of them report `_npmUser` as the
    // literal robot identity "GitHub Actions" — the trusted-publisher path a
    // well-run project uses. Showing that would name no one, and it would
    // read WORSE for the original than for a clone: `@nanmicoder/dsh-agent-
    // teams` publishes from CI while the clone `dsh-agent-squad` was pushed
    // by hand, so the clone would be the one showing a human account. A
    // `_npmUser` that is not among the maintainers is not an identity.
    const ci = {
      ...packument,
      maintainers: [{ name: 'realauthor' }, { name: 'second' }],
      versions: {
        '1.2.0': { ...packument.versions['1.2.0'], _npmUser: { name: 'GitHub Actions' } },
      },
    }
    expect(toCandidate(ci)?.publisher).toBe('realauthor')
  })

  it('prefers the publishing account when it IS one of the maintainers', () => {
    // 220 of those 250 publish under their own account; that account is both
    // the owner and the one npm recorded for this version, so it is the
    // strongest single answer even when the package has several maintainers.
    const own = {
      ...packument,
      maintainers: [{ name: 'first' }, { name: 'realauthor' }],
      versions: {
        '1.2.0': { ...packument.versions['1.2.0'], _npmUser: { name: 'realauthor' } },
      },
    }
    expect(toCandidate(own)?.publisher).toBe('realauthor')
  })

  it('carries no publisher when npm records no account at all', () => {
    // Older packages predate `_npmUser`; the field stays absent rather than
    // falling back to the unverified `author`.
    expect(toCandidate(packument)?.publisher).toBeUndefined()
  })

  it('never carries the publisher email into the candidate', () => {
    const withUser = {
      ...packument,
      maintainers: [{ name: 'realauthor', email: 'real@example.com' }],
      versions: {
        '1.2.0': { ...packument.versions['1.2.0'], _npmUser: { name: 'realauthor', email: 'real@example.com' } },
      },
    }
    // npm publishes the address; our artifact has no use for it and must not
    // republish it. The publisher IS resolved here, so the assertion bites.
    expect(toCandidate(withUser)?.publisher).toBe('realauthor')
    expect(JSON.stringify(toCandidate(withUser))).not.toContain('real@example.com')
  })

  it('reads the latest version', () => {
    expect(toCandidate(packument)?.version).toBe('1.2.0')
  })

  it('projects the npm description onto the candidate', () => {
    expect(toCandidate(packument)?.description).toBe('Says hello.')
  })

  it('reports a missing description as null, not undefined', () => {
    const noDescription = {
      ...packument,
      versions: {
        '1.2.0': { ...packument.versions['1.2.0'], description: undefined },
      },
    }
    expect(toCandidate(noDescription)?.description).toBeNull()
  })

  it('normalizes a git repository url to https', () => {
    expect(toCandidate(packument)?.repository).toBe('https://github.com/you/hello-plugin')
  })

  it('reads the publication time of that version', () => {
    expect(toCandidate(packument)?.publishedAt).toBe('2026-08-01T12:00:00.000Z')
  })

  it('reports the presence of dsh.bundle', () => {
    expect(toCandidate(packument)?.hasBundle).toBe(true)
  })

  it('carries dsh.catalog through unvalidated', () => {
    expect(toCandidate(packument)?.catalog).toMatchObject({ category: 'tool' })
  })

  it('marks a deprecated version', () => {
    const deprecated = {
      ...packument,
      versions: {
        '1.2.0': { ...packument.versions['1.2.0'], deprecated: 'do not use' },
      },
    }
    expect(toCandidate(deprecated)?.deprecated).toBe(true)
  })

  it('returns null when the latest tag names a missing version', () => {
    expect(toCandidate({ ...packument, 'dist-tags': { latest: '9.9.9' } })).toBeNull()
  })

  it('returns null for a packument with no name', () => {
    expect(toCandidate({ 'dist-tags': { latest: '1.0.0' } })).toBeNull()
  })

  it('extracts keywords from the manifest', () => {
    const doc = {
      ...packument,
      versions: {
        '1.2.0': { ...packument.versions['1.2.0'], keywords: ['dsh-plugin', 'files', 'git'] },
      },
    }
    const candidate = toCandidate(doc)
    expect(candidate?.keywords).toEqual(['dsh-plugin', 'files', 'git'])
  })

  it('uses an empty keyword list when the manifest has none', () => {
    const candidate = toCandidate(packument)
    expect(candidate?.keywords).toEqual([])
  })

  it('keeps only string keywords', () => {
    const doc = {
      ...packument,
      versions: {
        '1.2.0': { ...packument.versions['1.2.0'], keywords: ['ok', 42, null, 'also-ok'] },
      },
    }
    const candidate = toCandidate(doc)
    expect(candidate?.keywords).toEqual(['ok', 'also-ok'])
  })

  it('keeps the names of the peer dependencies, dropping the ranges', () => {
    // Shape copied from dsh-timeline@0.1.4, the package whose peer on
    // @deepseek-ai/dsh-client-store broke a user's harness: every range there
    // is "*", which is why ranges are not recorded. Declared out of
    // alphabetical order (react first) so this assertion cannot pass against
    // an implementation that sorts peers instead of preserving manifest order.
    const withPeers = {
      ...packument,
      versions: {
        '1.2.0': {
          ...packument.versions['1.2.0'],
          peerDependencies: {
            react: '^18.2.0',
            '@deepseek-ai/cordis': '*',
            '@deepseek-ai/dsh-client-store': '*',
          },
        },
      },
    }
    expect(toCandidate(withPeers)?.peers).toEqual([
      'react',
      '@deepseek-ai/cordis',
      '@deepseek-ai/dsh-client-store',
    ])
  })

  it('reads no peers when the manifest declares none', () => {
    expect(toCandidate(packument)?.peers).toEqual([])
  })

  it('reads dist.unpackedSize as the entry size', () => {
    // The figure npm computed at publish time. Measured 2026-09-07, all 250
    // live `dsh-plugin` packages carry one, so this is the ordinary path.
    const sized = {
      ...packument,
      versions: {
        '1.2.0': { ...packument.versions['1.2.0'], dist: { integrity: 'sha512-hello', unpackedSize: 847407 } },
      },
    }
    expect(toCandidate(sized)?.unpackedSize).toBe(847407)
  })

  it('carries no size when the packument records none', () => {
    // npm has recorded unpackedSize since npm 5.6 (2017); a version published
    // before that has none. Absent stays absent — a 0 would tell every reader
    // the package is empty.
    expect(toCandidate(packument)?.unpackedSize).toBeUndefined()
    expect('unpackedSize' in (toCandidate(packument) ?? {})).toBe(false)
  })

  it('drops an unpackedSize that is not a safe non-negative integer, and keeps the listing', () => {
    // Hostile or broken npm metadata. Each of these would reach a published
    // artifact and then a size label on the shelf: a string renders as
    // "NaN kB" or worse, a negative as "-1.0 kB", a fraction as a size no
    // package can have, and a value past 2^53 cannot round-trip through JSON.
    // The size is a decoration, so a bad one costs the size and NOT the
    // listing — every case below still yields a candidate.
    for (const bad of ['847407', -1, 1.5, Number.MAX_SAFE_INTEGER + 2, null, {}, [], true]) {
      const hostile = {
        ...packument,
        versions: {
          '1.2.0': { ...packument.versions['1.2.0'], dist: { integrity: 'sha512-hello', unpackedSize: bad } },
        },
      }
      const candidate = toCandidate(hostile)
      expect(candidate, `${JSON.stringify(bad)} took the whole candidate down`).not.toBeNull()
      expect(candidate?.unpackedSize, `${JSON.stringify(bad)} reached the candidate`).toBeUndefined()
      // The rest of the manifest is unaffected: the size is read beside
      // `integrity`, and a bad one must not cost the entry its hash.
      expect(candidate?.integrity).toBe('sha512-hello')
    }
    // Zero is a legal answer and NOT dropped: npm really does report 0 for an
    // empty tarball, and that is a fact about the package worth showing.
    const empty = {
      ...packument,
      versions: {
        '1.2.0': { ...packument.versions['1.2.0'], dist: { integrity: 'sha512-hello', unpackedSize: 0 } },
      },
    }
    expect(toCandidate(empty)?.unpackedSize).toBe(0)
  })

  it('reads no peers when peerDependencies is not an object', () => {
    const hostile = {
      ...packument,
      versions: { '1.2.0': { ...packument.versions['1.2.0'], peerDependencies: 'everything' } },
    }
    expect(toCandidate(hostile)?.peers).toEqual([])
  })

  it('reads no peers when peerDependencies is an array, not a plain object', () => {
    // Object.keys on an array yields index strings ('0', '1', ...) rather than
    // throwing, so without this guard those indices would be recorded as peer
    // names and later reported to a user as peers the harness does not provide
    // — a false accusation manufactured from hostile input. An array is refused
    // outright rather than read.
    const hostileArray = {
      ...packument,
      versions: { '1.2.0': { ...packument.versions['1.2.0'], peerDependencies: ['react', 'vue'] } },
    }
    expect(toCandidate(hostileArray)?.peers).toEqual([])
  })

  it('reads no peers when peerDependencies is null', () => {
    // typeof null === 'object' in JS, which is exactly why the guard checks
    // `!== null` before checking `typeof === 'object'`. Without that clause,
    // Object.keys(null) throws TypeError, uncaught by fetchCandidate or the
    // batch in fetchCandidates — one package publishing this legal JSON would
    // take down the whole harvest instead of becoming one fetch-failed entry.
    const hostileNull = {
      ...packument,
      versions: { '1.2.0': { ...packument.versions['1.2.0'], peerDependencies: null } },
    }
    expect(toCandidate(hostileNull)?.peers).toEqual([])
  })

  it('caps the number of recorded peers, dropping the rest rather than rejecting the package', () => {
    // peerDependencies keys are hostile npm input with no size limit of
    // their own; a manifest declaring far more than any real dependency
    // list needs must not inflate the published catalog or hand every
    // reader's host that many resolutions to attempt on each catalog load.
    const many = Object.fromEntries(
      Array.from({ length: PEERS_MAX_COUNT + 50 }, (_, i) => [`peer-${i}`, '*']),
    )
    const hostile = {
      ...packument,
      versions: { '1.2.0': { ...packument.versions['1.2.0'], peerDependencies: many } },
    }
    const candidate = toCandidate(hostile)
    expect(candidate?.peers).toHaveLength(PEERS_MAX_COUNT)
    expect(candidate?.peers).toEqual(Object.keys(many).slice(0, PEERS_MAX_COUNT))
  })

  it('drops a peer name past the length bound, the way it drops the count tail', () => {
    // Every recorded peer name reaches every reader's plugins.json verbatim,
    // and a `peerDependencies` key carries no bound of its own. The documented
    // policy for this field is "the excess is dropped, never rejected" — an
    // oversized manifest costs the author the tail, not the listing.
    const result = toCandidate({
      ...packument,
      versions: {
        '1.2.0': {
          ...packument.versions['1.2.0'],
          peerDependencies: { ok: '*', ['x'.repeat(215)]: '*' },
        },
      },
    })
    expect(result?.peers).toEqual(['ok'])
  })

  it('keeps a peer name of exactly the bound, and no longer keeps the 214 npm allows', () => {
    // This pinned 214 on the rationale that 214 is npm's OWN name limit, so a
    // name of exactly that length is legal, publishable, and must survive the
    // filter. That rationale is retired, deliberately. The bound was never a
    // grammar check — a `peerDependencies` key is an arbitrary JSON key and
    // this filter only ever measured its length — and 200 names of 214 make
    // this one field 45,239 serialized bytes, 3.68x gate.ts's byte budget for
    // an ENTIRE entry. Measured against the published catalog on 2026-09-04,
    // the longest peer name any of 9,422 entries declares is 50 characters.
    // So the cap is a measured 128, 2.56x that, and a peer name of 129 to 214
    // characters — legal on npm, never yet observed — is now DROPPED. The
    // author loses the tail of one list, silently, by this field's own
    // documented policy; never the listing.
    //
    // The literals are written out rather than derived from
    // PEER_NAME_MAX_LENGTH, or the fixture would move with the constant and
    // pin nothing. Two off-by-one mutations are what it exists for: `<=` to
    // `<`, and 128 to 127.
    const kept = 'p'.repeat(128)
    const dropped = 'q'.repeat(214)
    const result = toCandidate({
      ...packument,
      versions: {
        '1.2.0': {
          ...packument.versions['1.2.0'],
          peerDependencies: { [kept]: '*', [dropped]: '*' },
        },
      },
    })
    expect(PEER_NAME_MAX_LENGTH).toBe(128)
    expect(result?.peers).toEqual([kept])
  })

  it('drops an empty peer name, which is no package at all', () => {
    // JSON permits "" as a key. It is not a resolvable package, and recording
    // it hands every reader's host a blank requirement to render and resolve.
    const result = toCandidate({
      ...packument,
      versions: {
        '1.2.0': {
          ...packument.versions['1.2.0'],
          peerDependencies: { '': '*', ok: '*' },
        },
      },
    })
    expect(result?.peers).toEqual(['ok'])
  })

  it('projects a packument that is not an object shape to no candidate, rather than throwing', () => {
    // `null` is legal JSON, so a 200 whose whole body is those four bytes
    // parses cleanly and reaches here — and every property read below the
    // cast throws a TypeError on it. github-client's twin projection took
    // this guard on this branch after a real public repository served exactly
    // that; the npm twin never got it. A throw here is not a rejection: it
    // escapes fetchCandidate (whose catches wrap the transport and the JSON
    // parse, not the projection), rejects fetchCandidates' Promise.all, and
    // neither build.ts nor classify.ts has an outer catch — one hostile
    // packument out of thousands would take the daily catalog down.
    for (const body of [null, undefined, 'a string', 42, true, ['an', 'array']]) {
      expect(toCandidate(body)).toBe(null)
    }
  })

  it('projects a null version entry to no candidate, rather than throwing', () => {
    // The second instance of the same input class, inside this same function:
    // `versions['1.2.0']: null` passes the `!== undefined` check the manifest
    // guard used to be, and `manifest.dist?.integrity` then throws on it. A
    // version entry that is not an object carries no manifest, so it names no
    // usable latest version — the same answer as a missing one, and the same
    // author-readable `fetch-failed` row rather than an aborted harvest.
    for (const entry of [null, 'not a manifest', 42, ['an', 'array']]) {
      expect(toCandidate({ ...packument, versions: { '1.2.0': entry } })).toBe(null)
    }
  })
})

describe('the peers bounds', () => {
  // Measured against the published catalog on 2026-09-04, 9,422 entries: the
  // largest peerDependencies list any listed package declares is 58 names,
  // and the longest single peer name is 50 characters.
  const LIVE_MAX_PEER_COUNT = 58
  const LIVE_MAX_PEER_NAME_LENGTH = 50

  it('admits every peers list the live catalog holds', () => {
    // A peer dropped by these bounds is dropped SILENTLY: there is no
    // rejection code for it and no published `detail` an author can read. A
    // bound that cuts into real data therefore costs somebody a resolution
    // they declared and tells nobody, which is why both must clear the live
    // maximum outright rather than merely approach it.
    expect(PEERS_MAX_COUNT).toBeGreaterThanOrEqual(LIVE_MAX_PEER_COUNT)
    expect(PEER_NAME_MAX_LENGTH).toBeGreaterThanOrEqual(LIVE_MAX_PEER_NAME_LENGTH)
  })

  it('stays within reach of that maximum instead of an order of magnitude above it', () => {
    // 200 x 214 is 3.4x the live count and 4.3x the live name length, and the
    // two MULTIPLY. A per-field bound that far above anything real is not
    // bounding the field — it leaves gate.ts's byte budget to do all the work,
    // which is exactly what was happening.
    expect(PEERS_MAX_COUNT).toBeLessThan(LIVE_MAX_PEER_COUNT * 3)
    expect(PEER_NAME_MAX_LENGTH).toBeLessThan(LIVE_MAX_PEER_NAME_LENGTH * 3)
  })

  it('no longer lets the peers block alone dwarf gate.ts\u2019s whole per-entry budget', () => {
    // Measured through gate.ts's own serializer, so the two files cannot
    // disagree about the number. At 200 x 214 the peers block alone serialized
    // to 45,239 bytes — 3.68x ENTRY_PAYLOAD_MAX_BYTES, which is the budget for
    // an ENTIRE entry — so this one field set the per-entry ceiling. At
    // 128 x 128 it is 17,959, and the largest peers list actually listed
    // (58 x 50) is 3,635, under a third of the budget.
    //
    // Still ABOVE the budget, deliberately: a field bound says what one value
    // may look like, the budget says what a whole entry may cost, and a
    // package maxing out every field at once is refused entirely. The two are
    // not meant to be jointly satisfiable, so this pins that the peers block
    // no longer DOMINATES the budget — not that it fits inside it.
    const worst = Array.from({ length: PEERS_MAX_COUNT }, () => 'p'.repeat(PEER_NAME_MAX_LENGTH))
    expect(entryPayloadBytes({ peers: worst })).toBeLessThan(ENTRY_PAYLOAD_MAX_BYTES * 2)
    const live = Array.from({ length: LIVE_MAX_PEER_COUNT }, () => 'p'.repeat(LIVE_MAX_PEER_NAME_LENGTH))
    expect(entryPayloadBytes({ peers: live })).toBeLessThan(ENTRY_PAYLOAD_MAX_BYTES / 2)
  })
})

describe('PARTITION_KEYWORDS', () => {
  it('names each refinement once, so no intersection is probed and paged twice', () => {
    // On the partitioned branch every entry costs a size=1 probe and, if it
    // answers non-zero, a paged cell of up to 21 requests. A duplicate entry
    // buys no names at all and pays for both twice.
    expect(new Set(PARTITION_KEYWORDS).size).toBe(PARTITION_KEYWORDS.length)
  })

  it('ships every keyword its own coverage note credits with closing the gap', () => {
    // This constant's note has now been wrong twice about the same thing and
    // in the same direction — it described as covering a partition that was
    // not. Round 2 summed four MARGINAL contributions across four overlapping
    // sets (20+10+10+7 = 47 against a 44-name gap) and concluded from the sum
    // that the four additions closed all of it; paged the next day, the 13
    // cells reached 5,117 of keywords:deepseek-harness's 5,132. Prose cannot
    // be tested, but the one mechanical part of it — WHICH keywords the note
    // says it added — can be, and a note naming a keyword the constant below
    // it does not ship is the exact shape of both failures.
    const source = readFileSync(join(srcDir, 'npm-client.ts'), 'utf8')
    const note = source.slice(0, source.indexOf('export const PARTITION_KEYWORDS'))
    const credited = [...note.matchAll(/^\s*\*\s{3}(\S+) -> \S/gm)]
      .map(match => match[1])
      .filter((keyword): keyword is string => keyword !== undefined)
    // The scan's own positive control: with no claims found it would pass by
    // checking nothing. Deliberately an exact count and not a lower bound, so
    // growing the note is a decision somebody makes rather than something that
    // slides. 12 for the 2026-09-04 round, plus `deepwatch` for the 2026-09-07
    // window crossing.
    expect(credited).toHaveLength(13)
    for (const keyword of credited) {
      expect(
        PARTITION_KEYWORDS,
        `the coverage note credits \`${keyword}\` with closing part of the measured gap, but the constant below it does not ship that keyword`,
      ).toContain(keyword)
    }
  })
})

describe('cellQuery', () => {
  it('renders a keyword-only cell exactly as keywordQuery did', () => {
    // The published behaviour must not move: this is the query string the
    // harvest has always sent, and every fixture assumes it.
    expect(cellQuery({ keywords: ['dsh-plugin'] })).toBe('keywords:dsh-plugin')
    expect(cellQuery({ keywords: ['deepseek-harness', 'dsh'] })).toBe('keywords:deepseek-harness,dsh')
    expect(cellQuery({ keywords: ['dsh-plugin'] })).toBe(keywordQuery(['dsh-plugin']))
  })

  it('renders a publisher cell as the keyword ANDed with the maintainer', () => {
    expect(cellQuery({ keywords: ['deepseek-harness'], maintainer: 'sayedev' }))
      .toBe('keywords:deepseek-harness maintainer:sayedev')
  })

  it('refuses a maintainer outside the grammar instead of sending it', () => {
    // `text=` is a query LANGUAGE, not a value. encodeURIComponent makes this
    // a valid URL and npm then reads THREE qualifiers where the caller wrote
    // two, so the cell enumerates a set its probed total never measured and
    // the deficit lands on the residual cap instead of being reported. Every
    // producer validates, so arriving here unvalidated is our own plumbing
    // losing the invariant -- hence a throw rather than a drop.
    expect(() => cellQuery({ keywords: ['dsh-plugin'], maintainer: 'x keywords:evil' }))
      .toThrow(/maintainer outside the username grammar/)
    expect(() => cellQuery({ keywords: ['dsh-plugin'], maintainer: '' }))
      .toThrow(/maintainer outside the username grammar/)
    // The cell is named, the offending bytes are not: the value is unbounded
    // and registry-shaped, and what a reader needs is which cell broke.
    expect(() => cellQuery({ keywords: ['dsh-plugin'], maintainer: 'a b' }))
      .toThrow(/cell for keywords:dsh-plugin/)
  })

  it('cannot describe a cell with no keywords at all', () => {
    // A bare `keywords:` is answered with the whole registry, and beside a
    // maintainer the keyword scope does not narrow but VANISHES -- `Cell`'s
    // own docblock owns those measurements. The type is the guard, so this
    // assertion is checked by tsc rather than at runtime: if the empty literal
    // ever becomes assignable the expected error disappears and typecheck
    // fails.
    // @ts-expect-error a cell must carry at least one keyword
    const empty: Cell = { keywords: [] }
    expect(cellQuery(empty)).toBe('keywords:')
  })
})

describe('cellKey', () => {
  it('is order-insensitive, because `keywords:` is an intersection', () => {
    // `keywords:a,b` and `keywords:b,a` are one cell behind two `text` values,
    // so two parents reaching the same intersection from different directions
    // must share one memo entry. cellQuery cannot serve as this key for
    // exactly that reason: it preserves query order, and keying on it pages
    // the same intersection twice.
    expect(cellKey({ keywords: ['b', 'a'] })).toBe(cellKey({ keywords: ['a', 'b'] }))
    expect(cellKey({ keywords: ['a', 'b'] })).not.toBe(cellKey({ keywords: ['a', 'c'] }))
  })

  it('reads the maintainer too, so two cells cannot collide on their keywords', () => {
    // A Cell is a two-field descriptor. A key that reads one field lets
    // `keywords:X maintainer:alice` and `keywords:X maintainer:bob` collide,
    // and the cost is not the probe the memo exists to save: `split` is
    // credited from the other cell's measurement while the push is skipped, so
    // one parent's tail is never paged and nothing throws.
    const alice = cellKey({ keywords: ['dsh-plugin'], maintainer: 'alice' })
    const bob = cellKey({ keywords: ['dsh-plugin'], maintainer: 'bob' })
    expect(alice).not.toBe(bob)
    expect(alice).not.toBe(cellKey({ keywords: ['dsh-plugin'] }))
  })
})

describe('partitionKeyword', () => {
  it('never ANDs a harvest keyword onto itself', async () => {
    // PARTITION_KEYWORDS names `deepseek-harness`, which is also a harvest
    // keyword. `keywords:X,X` is X, so as a cell it partitions nothing — and
    // above the window, the only place this code runs, it lands in `oversized`
    // and can throw "no refinement keyword splits it" for a keyword every
    // other cell splits fine. The skip had no test of its own: deleting it
    // left the whole suite green, because every fixture reaching this function
    // drives it through searchByKeywords with static totals that hide the
    // extra cell.
    //
    // It is also the arithmetic in PARTITION_KEYWORDS' own comment: the 27
    // entries yield 26 cells against this keyword, because one of them IS this
    // keyword. Counted, not restated: the assertion below derives it, and this
    // comment read "ten entries yield NINE cells" beside an assertion
    // computing 26.
    const probed: string[] = []
    // `cellQuery`, not `keywordQuery(cell.keywords)`: the stub renders through
    // the same function the harvest does, so the byte-identical strings
    // asserted below are evidence that a keyword-only cell still sends what it
    // always sent, rather than an assumption restated.
    const probe = async (cell: Cell): Promise<number> => {
      const query = cellQuery(cell)
      probed.push(query)
      return query === 'keywords:deepseek-harness' ? SEARCH_WINDOW + 1 : 10
    }

    const { cells, partitioned } = await partitionKeyword('deepseek-harness', probe)
    expect(partitioned).toBe(true)
    expect(probed).not.toContain('keywords:deepseek-harness,deepseek-harness')
    expect(cells).toHaveLength(PARTITION_KEYWORDS.filter(k => k !== 'deepseek-harness').length)
    expect(cells.every(cell => cell.keywords.filter(k => k === 'deepseek-harness').length === 1)).toBe(true)
  })

  it('keeps a refinement that merely resembles the keyword', async () => {
    // The skip is an equality, not a prefix or a substring test: `harness`
    // and `deepseek-harness` are different queries, and dropping either as
    // "close enough" would silently delete a cell from the partition.
    const probe = async (cell: Cell): Promise<number> =>
      cell.keywords.length === 1 ? SEARCH_WINDOW + 1 : 10
    const { cells } = await partitionKeyword('harness', probe)
    // The cell's REPRESENTATION moved to a descriptor; the query it renders to
    // did not. `cellQuery` pins that separately.
    expect(cells).toContainEqual({ keywords: ['harness', 'deepseek-harness'] })
    expect(cells).toHaveLength(PARTITION_KEYWORDS.length)
  })

  it('pages a deeper intersection once, however many oversized cells reach it', async () => {
    // When both `[k,'dsh']` and `[k,'plugin']` are over the window, each is
    // split by the other's refinement — and `keywords:k,dsh,plugin` and
    // `keywords:k,plugin,dsh` are the SAME intersection behind two different
    // `text` values. Names deduplicate downstream, so the cost is purely the
    // paging: one wasted probe and up to 21 wasted page fetches for a set of
    // names already enumerated.
    const probed: string[] = []
    const probe = async (cell: Cell): Promise<number> => {
      probed.push(cellQuery(cell))
      if (cell.keywords.length === 1) return SEARCH_WINDOW + 1
      if (cell.keywords.length === 2) {
        return cell.keywords[1] === 'dsh' || cell.keywords[1] === 'plugin' ? SEARCH_WINDOW + 1 : 0
      }
      return 10
    }

    const { cells } = await partitionKeyword('deepseek-harness', probe)
    const intersections = cells.map(cell => [...cell.keywords].sort().join(','))
    expect(new Set(intersections).size).toBe(intersections.length)
    // Deduplicated on the SET and BEFORE the probe, so the second spelling
    // costs no request either.
    expect(probed).toContain('keywords:deepseek-harness,dsh,plugin')
    expect(probed).not.toContain('keywords:deepseek-harness,plugin,dsh')
  })
})

describe('describeShortfall', () => {
  /** A record whose two terms sum to the deficit, as the harvest emits them. */
  const record = (over: Partial<KeywordShortfall> = {}): KeywordShortfall => ({
    keyword: 'deepseek-harness',
    enumerated: 5400,
    required: 5407,
    unreachable: 157,
    recovered: 150,
    windowShortfall: 0,
    tailShortfall: 7,
    ...over,
  })

  it('names the tail term with the counts that bound it', () => {
    expect(describeShortfall(record())).toBe(
      'keywords:deepseek-harness enumerated 5400 of 5407, missing 7 of the 157 names'
      + ' the reported total puts beyond that window, of which the combined searches recovered 150',
    )
  })

  it('names the window term against the window it could have addressed', () => {
    expect(describeShortfall(record({
      enumerated: 5248, required: 5251, unreachable: 0, recovered: 0, windowShortfall: 3, tailShortfall: 0,
    }))).toBe(
      `keywords:deepseek-harness enumerated 5248 of 5251, missing 3 inside the ${SEARCH_WINDOW}-name`
      + ' query window, where every rank is addressable',
    )
  })

  it('separates the two terms so neither reads as a clause of the other', () => {
    // Both terms end in a subordinate clause ("where every rank is
    // addressable", "of which the combined searches recovered 0"), so joining
    // them with a bare `and` makes the second read as a continuation of the
    // first's clause rather than as a second count. This shape is live:
    // `emits one shortfall record per keyword` pins a [2, 1] split.
    const both = describeShortfall(record({
      enumerated: 5248, required: 5251, unreachable: 1, recovered: 0, windowShortfall: 2, tailShortfall: 1,
    }))
    expect(both).toBe(
      `keywords:deepseek-harness enumerated 5248 of 5251, missing 2 inside the ${SEARCH_WINDOW}-name`
      + ' query window, where every rank is addressable; 1 of the 1 names the reported total puts'
      + ' beyond that window, of which the combined searches recovered 0',
    )
    expect(both).not.toContain('addressable and')
  })
})

describe('parseKeywordShortfall', () => {
  const handoff = {
    keyword: 'deepseek-harness',
    enumerated: 5400,
    required: 5407,
    unreachable: 157,
    recovered: 150,
    windowShortfall: 0,
    tailShortfall: 7,
  }

  it('round-trips the record the harvest writes', () => {
    expect(parseKeywordShortfall(handoff, 'handoff.json')).toEqual(handoff)
  })

  it('refuses a record missing any count, naming the field and the remedy', () => {
    for (const field of ['enumerated', 'required', 'unreachable', 'recovered', 'windowShortfall', 'tailShortfall']) {
      const { [field]: _dropped, ...rest } = handoff as Record<string, unknown>
      expect(() => parseKeywordShortfall(rest, 'handoff.json'))
        .toThrow(new RegExp(`no integer \\\`${field}\\\`; re-run the harvest`))
    }
    expect(() => parseKeywordShortfall({ ...handoff, keyword: 7 }, 'handoff.json'))
      .toThrow(/no `keyword`/)
  })

  it('refuses a record whose terms do not sum to its own deficit', () => {
    // The identity {@link KeywordShortfall} documents. Without it a handoff
    // can carry two terms that describe a different gap than the
    // enumerated/required pair printed beside them in the same sentence.
    expect(() => parseKeywordShortfall({ ...handoff, tailShortfall: 6 }, 'handoff.json'))
      .toThrow(/window and tail terms sum to 6, not the 7 names/)
  })

  it('refuses a record that describes no shortfall at all', () => {
    // Both terms zero renders a sentence ending in a dangling "missing ".
    // `onShortfall` cannot emit one, so only a hand-written or truncated
    // handoff reaches here — which is the case this parser exists for.
    expect(() => parseKeywordShortfall(
      { ...handoff, enumerated: 10, required: 10, unreachable: 0, recovered: 0, windowShortfall: 0, tailShortfall: 0 },
      'handoff.json',
    )).toThrow(/enumerated 10 of 10, so it records no shortfall to describe/)
  })
})

describe('maintainersOf', () => {
  it("reads the usernames a search object's package carries", () => {
    expect(maintainersOf({ maintainers: [{ username: 'sayedev', email: 'a@b.c' }] })).toEqual(['sayedev'])
  })

  it('answers empty for every shape npm can legally serve instead', () => {
    // Hostile by default: this value reaches a URL. Anything that is not a
    // string username in the grammar is not a username.
    expect(maintainersOf(null)).toEqual([])
    expect(maintainersOf({})).toEqual([])
    expect(maintainersOf({ maintainers: 'sayedev' })).toEqual([])
    expect(maintainersOf({ maintainers: [null, 7, { username: 3 }, { name: 'x' }] })).toEqual([])
  })

  it('drops a username outside the grammar rather than putting it in a query', () => {
    expect(maintainersOf({ maintainers: [{ username: 'a b' }, { username: 'UPPER' }, { username: 'ok-name_1.2' }] }))
      .toEqual(['ok-name_1.2'])
  })

  it('de-duplicates, because one object can name a maintainer twice', () => {
    expect(maintainersOf({ maintainers: [{ username: 'a' }, { username: 'a' }] })).toEqual(['a'])
  })

  it('bounds the count, because every name it keeps is committed forever', () => {
    // The per-name grammar was the only bound here. The array is
    // registry-controlled, one page is capped only by MAX_SEARCH_BODY_BYTES,
    // and mergePublishers never removes -- so a burst of grammar-valid
    // usernames would enter the committed vocabulary permanently and buy a
    // live request on every run. The live maximum is 11 across 1,500 objects
    // (2026-09-09), so the tail this drops has never existed.
    const many = Array.from({ length: MAINTAINERS_MAX_COUNT + 5 }, (_, i) => ({ username: `u${i}` }))
    expect(maintainersOf({ maintainers: many })).toHaveLength(MAINTAINERS_MAX_COUNT)
  })
})

describe('searchByKeywords', () => {
  it('pages every harvest keyword until the answered total is reached', async () => {
    // Every keyword costs a leading total-probe, the pages themselves, and a
    // trailing re-probe (round 2: the unpartitioned branch re-probes too, so
    // churn is tolerated symmetrically with the partitioned branch) — so
    // dsh-plugin costs 4 requests (probe, two pages, re-probe) and
    // deepseek-harness costs 3 (probe, one already-empty page, re-probe).
    const pages = [
      { total: 251, objects: [] }, // dsh-plugin: pre-paging probe
      { total: 251, objects: Array.from({ length: 250 }, (_, i) => ({ package: { name: `dsh-p${i}` } })) },
      { total: 251, objects: [{ package: { name: 'dsh-last' } }] },
      { total: 251, objects: [] }, // dsh-plugin: post-paging re-probe
      { total: 0, objects: [] }, // deepseek-harness: pre-paging probe
      { total: 0, objects: [] }, // deepseek-harness: one page, already empty
      { total: 0, objects: [] }, // deepseek-harness: post-paging re-probe
    ]
    const urls: string[] = []
    let call = 0
    const fetchImpl = (async (url: string | URL) => {
      urls.push(String(url))
      const body = pages[call] ?? { total: 0, objects: [] }
      call += 1
      return new Response(JSON.stringify(body), { status: 200 })
    }) as unknown as typeof fetch

    const names = await searchByKeywords(fetchImpl)
    expect(names).toHaveLength(251)
    expect(names).toContain('dsh-last') // the union is sorted, so it cannot anchor the tail
    expect(call).toBe(7)
    // `keywords:` is percent-encoded ahead of the name now (partition cells
    // need to carry a comma safely); decode before matching so this proves a
    // KEYWORD query, not just a substring anywhere in the URL — a bare,
    // unfiltered `text=dsh-plugin` would satisfy a loose `.includes`.
    expect(urls.some(url => decodeURIComponent(url).includes('keywords:dsh-plugin'))).toBe(true)
    expect(urls.some(url => decodeURIComponent(url).includes('keywords:deepseek-harness'))).toBe(true)
  })

  it('unions the keywords, deduplicates, and sorts', async () => {
    // Matches past the colon: `text=keywords:dsh-plugin` is now sent
    // percent-encoded (`keywords%3Adsh-plugin`), so the literal `keywords:`
    // prefix no longer appears in the URL — route on the decoded query so a
    // loose substring match cannot also route an unfiltered text search.
    // Both the probe and the page fetch land on the same branch, which is
    // harmless here: each response carries the total that matches its own
    // object count, so every cell still ends on its first (only) page.
    const fetchImpl = (async (url: string | URL) => {
      const text = decodeURIComponent(String(url))
      if (text.includes('keywords:dsh-plugin')) {
        return new Response(JSON.stringify({ total: 2, objects: [{ package: { name: 'b' } }, { package: { name: 'a' } }] }), { status: 200 })
      }
      if (text.includes('keywords:deepseek-harness')) {
        return new Response(JSON.stringify({ total: 2, objects: [{ package: { name: 'b' } }, { package: { name: 'c' } }] }), { status: 200 })
      }
      throw new Error(`unexpected url: ${text}`)
    }) as unknown as typeof fetch

    await expect(searchByKeywords(fetchImpl)).resolves.toEqual(['a', 'b', 'c'])
  })

  it('throws when the registry answers with an error status, naming the keyword', async () => {
    const fetchImpl = (async () => new Response('nope', { status: 503 })) as unknown as typeof fetch
    await expect(searchByKeywords(fetchImpl)).rejects.toThrow(/keywords:dsh-plugin.*503/)
  })

  it('aborts when a later keyword search fails, rather than harvesting a subset', async () => {
    // Matches past the colon — see the comment in the union test above.
    const fetchImpl = (async (url: string | URL) => {
      if (decodeURIComponent(String(url)).includes('keywords:deepseek-harness')) return new Response('nope', { status: 503 })
      return new Response(JSON.stringify({ total: 1, objects: [{ package: { name: 'fine' } }] }), { status: 200 })
    }) as unknown as typeof fetch

    await expect(searchByKeywords(fetchImpl)).rejects.toThrow(/keywords:deepseek-harness.*503/)
  })

  it('retries a rate-limited search and succeeds when the registry recovers', async () => {
    const sleep = async (_ms: number) => {}
    let call = 0
    const fetchImpl = (async () => {
      call += 1
      if (call === 1) return new Response('rate limited', { status: 429 })
      return new Response(JSON.stringify({ total: 0, objects: [] }), { status: 200 })
    }) as unknown as typeof fetch

    const names = await searchByKeywords(fetchImpl, sleep)
    expect(names).toHaveLength(0)
    // dsh-plugin's total-probe: the 429, then its retry (2); dsh-plugin's one
    // empty page (3); dsh-plugin's post-paging re-probe (4); deepseek-harness's
    // probe (5), one empty page (6), and its own post-paging re-probe (7).
    expect(call).toBe(7)
  })

  it('gives up after bounded retries and throws the final 429', async () => {
    const sleep = async (_ms: number) => {}
    let call = 0
    const fetchImpl = (async () => {
      call += 1
      return new Response('rate limited', { status: 429 })
    }) as unknown as typeof fetch

    await expect(searchByKeywords(fetchImpl, sleep)).rejects.toThrow(/429/)
    expect(call).toBe(6)
  })

  it('honors Retry-After when backing off a rate-limited search', async () => {
    const delays: number[] = []
    const sleep = async (ms: number) => { delays.push(ms) }
    let call = 0
    const fetchImpl = (async () => {
      call += 1
      if (call === 1) return new Response('rate limited', { status: 429, headers: { 'Retry-After': '3' } })
      return new Response(JSON.stringify({ total: 0, objects: [] }), { status: 200 })
    }) as unknown as typeof fetch

    await searchByKeywords(fetchImpl, sleep)
    expect(delays).toEqual([3000])
  })

  it('backs off exponentially when a 429 carries no Retry-After', async () => {
    const delays: number[] = []
    const sleep = async (ms: number) => { delays.push(ms) }
    let call = 0
    const fetchImpl = (async () => {
      call += 1
      if (call < 6) return new Response('rate limited', { status: 429 })
      return new Response(JSON.stringify({ total: 0, objects: [] }), { status: 200 })
    }) as unknown as typeof fetch

    await searchByKeywords(fetchImpl, sleep)
    expect(delays).toEqual([2000, 4000, 8000, 16000, 32000])
  })

  it('spends about a minute of backoff before giving up on a rate limit', async () => {
    // The budget is the point of the retry: an IP-level throttle takes minutes
    // to clear, and the 7s this used to spend never outlived one. Pinned as a
    // total so a change to either the count or the base has to be deliberate.
    const delays: number[] = []
    const sleep = async (ms: number) => { delays.push(ms) }
    const fetchImpl = (async () => new Response('rate limited', { status: 429 })) as unknown as typeof fetch

    await expect(searchByKeywords(fetchImpl, sleep)).rejects.toThrow(/429/)
    expect(delays.reduce((a, b) => a + b, 0)).toBe(62_000)
  })

  it('clamps an absurd Retry-After to the maximum delay', async () => {
    const delays: number[] = []
    const sleep = async (ms: number) => { delays.push(ms) }
    let call = 0
    const fetchImpl = (async () => {
      call += 1
      if (call === 1) return new Response('rate limited', { status: 429, headers: { 'Retry-After': '3600' } })
      return new Response(JSON.stringify({ total: 0, objects: [] }), { status: 200 })
    }) as unknown as typeof fetch

    await searchByKeywords(fetchImpl, sleep)
    expect(delays).toEqual([60_000])
  })

  it('sends an Authorization header when a token is given', async () => {
    const sleep = async (_ms: number) => {}
    const headersSeen: Array<Record<string, string> | undefined> = []
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
      headersSeen.push(init?.headers as Record<string, string> | undefined)
      return new Response(JSON.stringify({ total: 0, objects: [] }), { status: 200 })
    }) as unknown as typeof fetch

    await searchByKeywords(fetchImpl, sleep, 'npm_readonly_token')
    expect(headersSeen).toHaveLength(6) // a pre-paging probe, one page, and a post-paging re-probe, per keyword
    expect(headersSeen.every(headers => headers?.Authorization === 'Bearer npm_readonly_token')).toBe(true)
  })

  it('sends no Authorization header without a token', async () => {
    const sleep = async (_ms: number) => {}
    const headersSeen: Array<Record<string, string> | undefined> = []
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
      headersSeen.push(init?.headers as Record<string, string> | undefined)
      return new Response(JSON.stringify({ total: 0, objects: [] }), { status: 200 })
    }) as unknown as typeof fetch

    await searchByKeywords(fetchImpl, sleep)
    expect(headersSeen).toHaveLength(6) // a pre-paging probe, one page, and a post-paging re-probe, per keyword
    expect(headersSeen.every(headers => headers === undefined)).toBe(true)
  })

  // A search stub built from per-query totals and pages. `size=1` is the
  // total probe, anything else is a page fetch; both answer `total` the way
  // the live registry does, so the loop under test reads it.
  function stubSearch(
    totals: Record<string, number> | ((query: string) => number),
    pages: (query: string, from: number) => string[],
    pagedTotals: Record<string, number> = {},
    // Which maintainers each name's object carries. Optional because the
    // publisher axis is the only thing that reads them, and every fixture
    // predating it asserts on names alone.
    maintainersFor: (name: string) => readonly string[] = () => [],
  ): { fetchImpl: typeof fetch; urls: string[] } {
    const urls: string[] = []
    // A function lets a fixture answer a different total on a later call —
    // static totals can never move, so `before === after` in every prior
    // fixture, which left the coverage check's churn tolerance untested.
    const readTotal = (query: string): number =>
      typeof totals === 'function' ? totals(query) : (totals[query] ?? 0)
    const fetchImpl = (async (url: string | URL) => {
      const text = String(url)
      urls.push(text)
      const params = new URL(text).searchParams
      const query = params.get('text') ?? ''
      const total = readTotal(query)
      if (params.get('size') === '1') {
        return new Response(JSON.stringify({ total, objects: [] }), { status: 200 })
      }
      const from = Number(params.get('from') ?? '0')
      const names = pages(query, from)
      return new Response(JSON.stringify({
        total: pagedTotals[query] ?? total,
        objects: names.map(name => ({
          package: { name, maintainers: maintainersFor(name).map(username => ({ username })) },
        })),
      }), { status: 200 })
    }) as unknown as typeof fetch
    return { fetchImpl, urls }
  }

  it('does not end a keyword on a short non-final page — it reads the total', async () => {
    // Live shape: npm served a 249-object page of a 600-name result set. The
    // old `objects.length < PAGE_SIZE` break dropped pages 1 and 2 in silence.
    const totals = { 'keywords:dsh-plugin': 600, 'keywords:deepseek-harness': 0 }
    const { fetchImpl } = stubSearch(totals, (query, from) => {
      if (query !== 'keywords:dsh-plugin') return []
      if (from === 0) return Array.from({ length: 249 }, (_, i) => `a${i}`)
      if (from === 250) return Array.from({ length: 250 }, (_, i) => `b${i}`)
      if (from === 500) return Array.from({ length: 101 }, (_, i) => `c${i}`)
      return []
    })
    const names = await searchByKeywords(fetchImpl)
    expect(names).toHaveLength(600)
    expect(names).toContain('c100')
  })

  it('throws, naming the reachable window, when a keyword is past it and nothing splits it', async () => {
    // Every query — the keyword and every refinement cell — reports 6000, so
    // no cell fits. The message must name the window and the cap, not blame
    // "100 pages" the way the old bound did.
    const everythingOversized = new Proxy({} as Record<string, number>, { get: () => 6000 })
    const { fetchImpl, urls } = stubSearch(everythingOversized, () => [])
    await expect(searchByKeywords(fetchImpl)).rejects.toThrow(
      /npm search for keywords:dsh-plugin,\S+ reports more than the 5250 names one query can reach \(from is capped at 5000\) and no refinement keyword splits it/,
    )
    // Every request is a size=1 probe: not one wasted page fetch.
    expect(urls.every(url => new URL(url).searchParams.get('size') === '1')).toBe(true)
  })

  it('partitions an over-window keyword into refinement cells and unions them', async () => {
    // A self-consistent fixture: the keyword is 5,300 names, two refinement
    // cells hold 5,000 and 300, and the pages actually serve them — so the
    // coverage check below passes on the same arithmetic the cells report.
    const totals: Record<string, number> = {
      'keywords:dsh-plugin': 5300,
      'keywords:dsh-plugin,dsh': 5000,
      'keywords:dsh-plugin,deepseek-harness': 300,
      'keywords:deepseek-harness': 0,
    }
    const { fetchImpl } = stubSearch(totals, (query, from) => {
      const total = totals[query] ?? 0
      const prefix = query === 'keywords:dsh-plugin,dsh' ? 'd' : 'h'
      if (query !== 'keywords:dsh-plugin,dsh' && query !== 'keywords:dsh-plugin,deepseek-harness') return []
      return Array.from(
        { length: Math.max(0, Math.min(250, total - from)) },
        (_, i) => `${prefix}${from + i}`,
      )
    })
    const names = await searchByKeywords(fetchImpl)
    expect(names).toHaveLength(5300)
    expect(names).toContain('d0')
    expect(names).toContain('d4999')
    expect(names).toContain('h299')
  })

  it('pages the keyword\u2019s own reachable window beside the cells, and stops AT the window', async () => {
    // The structural half of the coverage story. A refinement partition is
    // never covering by construction — there is no negation qualifier — so
    // the keyword itself is also paged, as far as the registry will serve it,
    // and its names are unioned in. That cell is deliberately NON-COMPLETING:
    // it must stop at the window rather than trip the "needs from=N" throw,
    // which is the one place in this module a short enumeration is intended.
    //
    // The fixture is the residual, isolated: the refinement cell holds ONLY
    // the single name that lies outside the reachable window, so the harvest
    // completes if and only if both halves are unioned. Without the window
    // cell it enumerates 1 of 5,251.
    const pageSize = SEARCH_WINDOW - MAX_SEARCH_FROM // the last reachable page's size is the page size
    const totals: Record<string, number> = {
      'keywords:dsh-plugin': SEARCH_WINDOW + 1,
      'keywords:dsh-plugin,dsh': 1,
      'keywords:deepseek-harness': 0,
    }
    const { fetchImpl, urls } = stubSearch(totals, (query, from) => {
      if (query === 'keywords:dsh-plugin,dsh') return from === 0 ? [`p${SEARCH_WINDOW}`] : []
      if (query !== 'keywords:dsh-plugin') return []
      return Array.from({ length: pageSize }, (_, i) => `p${from + i}`)
    })

    const names = await searchByKeywords(fetchImpl)
    expect(names).toHaveLength(SEARCH_WINDOW + 1)
    expect(names).toContain('p0')
    expect(names).toContain(`p${SEARCH_WINDOW - 1}`) // the last name the window reaches
    expect(names).toContain(`p${SEARCH_WINDOW}`) // past it; only the refinement cell carries this one
    // Every page of the window cell, and not one request past the cap: a
    // `from` above it silently returns page 0 (measured live), so paging into
    // the wrap would re-count the head and read as coverage.
    const windowFroms = urls
      .map(url => new URL(url).searchParams)
      .filter(params => params.get('text') === 'keywords:dsh-plugin' && params.get('size') !== '1')
      .map(params => Number(params.get('from')))
    expect(windowFroms).toEqual(Array.from({ length: SEARCH_WINDOW / pageSize }, (_, i) => i * pageSize))
    expect(Math.max(...windowFroms)).toBe(MAX_SEARCH_FROM)
  })

  it('throws when a page of the window cell answers no total, exactly like any other cell', async () => {
    // The window cell is the one cell allowed to end short, and that must not
    // slide into tolerating a page whose completeness cannot be judged at
    // all: the registry has served a 200 with `<!doctype html>` on an
    // ordinary search page. Only the WINDOW cell's pages drop the total here,
    // so no other cell can satisfy this assertion by throwing first.
    const fetchImpl = (async (url: string | URL) => {
      const params = new URL(String(url)).searchParams
      const query = params.get('text') ?? ''
      const total = query === 'keywords:dsh-plugin'
        ? SEARCH_WINDOW + 1
        : query === 'keywords:dsh-plugin,dsh' ? 1 : 0
      if (params.get('size') === '1') return new Response(JSON.stringify({ total, objects: [] }), { status: 200 })
      if (query === 'keywords:dsh-plugin') return new Response(JSON.stringify({ objects: [] }), { status: 200 })
      return new Response(JSON.stringify({ total, objects: [{ package: { name: 'p0' } }] }), { status: 200 })
    }) as unknown as typeof fetch

    await expect(searchByKeywords(fetchImpl)).rejects.toThrow(
      /npm search for keywords:dsh-plugin at from=0 answered no total; a truncated page cannot be told from a complete one/,
    )
  })

  it('re-pages a keyword once when npm omits an object, rather than freezing the shelf for the day', async () => {
    // The floor is exact, so one missing name throws — and the anomaly that
    // motivated the floor does not survive it. npm served a 249-object page
    // of a 600-name result set; `from` advances by the page size, so the
    // omitted object is never re-requested and the keyword enumerates 599 of
    // 600. One registry hiccup would freeze the shelf until a human looked.
    // A second full pass separates a transient omission from a genuine
    // partition gap, which is the distinction the throw's own message claims
    // to draw.
    let firstPageFetches = 0
    const { fetchImpl } = stubSearch(
      { 'keywords:dsh-plugin': 600, 'keywords:deepseek-harness': 0 },
      (query, from) => {
        if (query !== 'keywords:dsh-plugin') return []
        if (from === 0) {
          firstPageFetches += 1
          // Pass 1 drops `a249` from an otherwise full page; pass 2 serves it.
          return Array.from({ length: firstPageFetches === 1 ? 249 : 250 }, (_, i) => `a${i}`)
        }
        if (from === 250) return Array.from({ length: 250 }, (_, i) => `b${i}`)
        if (from === 500) return Array.from({ length: 100 }, (_, i) => `c${i}`)
        return []
      },
    )

    const names = await searchByKeywords(fetchImpl)
    expect(names).toHaveLength(600)
    expect(names).toContain('a249') // the object pass 1 skipped
    // Twice, and only twice: a registry genuinely serving short must still
    // fail the build rather than loop.
    expect(firstPageFetches).toBe(2)
  })

  it('refuses a negative total, which would disable the coverage floor outright', async () => {
    // `typeof total === 'number'` was the whole check. A negative total makes
    // `required = min(total, after)` negative and `forKeyword.size < required`
    // false for any harvest at all: `{"total": -1, "objects": []}` for both
    // keywords returned an EMPTY name list with a green build — the zero-name
    // harvest with no error that the floor exists to refuse.
    const fetchImpl = (async () => new Response(JSON.stringify({ total: -1, objects: [] }), { status: 200 })) as unknown as typeof fetch
    await expect(searchByKeywords(fetchImpl)).rejects.toThrow(
      /npm search for keywords:dsh-plugin at from=0 answered total=-1, which is not a count of packages/,
    )
  })

  it('refuses a total that is not a whole number', async () => {
    // `1e999` parses to Infinity, and JSON has no integer type, so a
    // fractional total is one keystroke away too. Neither is a count of
    // packages: Infinity used to partition every keyword and then report "no
    // refinement keyword splits it", blaming PARTITION_KEYWORDS for a
    // malformed body.
    const fetchImpl = (async () => new Response('{"total": 1e999, "objects": []}', { status: 200 })) as unknown as typeof fetch
    await expect(searchByKeywords(fetchImpl)).rejects.toThrow(
      /npm search for keywords:dsh-plugin at from=0 answered total=Infinity, which is not a count of packages/,
    )
  })

  it('throws, naming the WINDOW, when the addressable range itself came up short', async () => {
    // Renamed against what this fixture actually builds. Its window cell
    // serves nothing at all — `pages` answers `[]` for `keywords:dsh-plugin` —
    // so 5,240 of the 5,290 missing names are at ranks the registry WILL
    // serve, and the fault is the window, not the cells. The old single
    // message said "the refinement keywords do not cover the keyword", which
    // was the only thing it could say and was the wrong half.
    //
    // The genuine uncovered-tail case now has its own test: see 'refuses when
    // the partition collapses' below, where the window is healthy and the
    // cells reach nothing past it.
    const totals: Record<string, number> = {
      'keywords:dsh-plugin': 5300,
      'keywords:dsh-plugin,dsh': 10,
      'keywords:deepseek-harness': 0,
    }
    const { fetchImpl } = stubSearch(totals, (query, from) =>
      query === 'keywords:dsh-plugin,dsh' && from === 0
        ? Array.from({ length: 10 }, (_, i) => `n${i}`)
        : [])
    // "reached only 10" is the UNION's in-window coverage, not the sweep's:
    // the sweep served nothing and the cell's 10 names are charged to the
    // window, because a cell name that cannot be proved to lie past the
    // window must not be credited as tail recovery. The sweep's own figure is
    // in the parenthetical, which is where the two halves are told apart.
    await expect(searchByKeywords(fetchImpl)).rejects.toThrow(
      /reached only 10 of the 5250 names its own window can address \(its window sweep served 0, beside 1 refinement cell\(s\)\).*inside the reachable range, so no partition can explain it/,
    )
  })

  it('tolerates a partition total that shrinks between the pre- and post-paging probe', async () => {
    // Ordinary publish/unpublish churn during a run must not fail a harvest
    // that is otherwise complete: `min(before, after)` is the tolerance. Every
    // fixture above uses a static `totals` map, so `before === after` always
    // held — swapping `Math.min` for `Math.max`, or deleting the second probe
    // entirely, left every one of them green.
    let dshPluginTotalReads = 0
    const totals = (query: string): number => {
      if (query === 'keywords:dsh-plugin') {
        dshPluginTotalReads += 1
        // Before paging: 5,300 (over the window, so it partitions). Every
        // later read of this query's total — the window cell's own pages
        // included — answers 5,297: three names unpublished mid-run.
        return dshPluginTotalReads === 1 ? 5300 : 5297
      }
      if (query === 'keywords:dsh-plugin,dsh') return 5000
      if (query === 'keywords:dsh-plugin,deepseek-harness') return 297
      return 0 // deepseek-harness itself, and every other refinement cell
    }
    const { fetchImpl, urls } = stubSearch(totals, (query, from) => {
      if (query !== 'keywords:dsh-plugin,dsh' && query !== 'keywords:dsh-plugin,deepseek-harness') return []
      const total = query === 'keywords:dsh-plugin,dsh' ? 5000 : 297
      const prefix = query === 'keywords:dsh-plugin,dsh' ? 'd' : 'h'
      return Array.from(
        { length: Math.max(0, Math.min(250, total - from)) },
        (_, i) => `${prefix}${from + i}`,
      )
    })
    const names = await searchByKeywords(fetchImpl)
    expect(names).toHaveLength(5297)
    // Counted off the URLs rather than off the stub's total reader: the
    // keyword's own reachable window is now PAGED as well as probed, so a
    // count of total-reads no longer isolates the probes. size=1 is the
    // probe, and there are exactly two — the pre-partition probe and the
    // post-paging recheck, which is the whole point of this fixture.
    const probes = urls.filter(url => {
      const params = new URL(url).searchParams
      return params.get('text') === 'keywords:dsh-plugin' && params.get('size') === '1'
    })
    expect(probes).toHaveLength(2)
  })

  it('tolerates churn on the unpartitioned branch too', async () => {
    // Round 1 reused the stale pre-paging `total` as `after` for an
    // unpartitioned keyword, so `required = min(total, total) = total` — zero
    // tolerance for any churn at all: an ordinary unpublish between the probe
    // and the page landing looked identical to a truncated harvest. The churn
    // test above never caught this — dsh-plugin there is always over the
    // window, so it only exercises the partitioned branch, which already
    // re-probed under round 1.
    let calls = 0
    const totals = (query: string): number => {
      if (query !== 'keywords:dsh-plugin') return 0 // deepseek-harness stays empty
      calls += 1
      // Touch 1: the pre-paging probe, answering 10. Touch 2: the page
      // itself, self-consistent at 8 objects of 8. Touch 3: the post-paging
      // re-probe, confirming 8 — two names unpublished between touch 1 and 3.
      return calls === 1 ? 10 : 8
    }
    const { fetchImpl } = stubSearch(totals, (query) =>
      query === 'keywords:dsh-plugin' ? Array.from({ length: 8 }, (_, i) => `p${i}`) : [])

    const names = await searchByKeywords(fetchImpl)
    expect(names).toHaveLength(8)
    expect(calls).toBe(3) // pre-paging probe, the one page, and the post-paging re-probe
  })

  it('refuses a short UNPARTITIONED harvest, naming the keyword and both counts', () => {
    // The coverage check runs on both branches, but only the partitioned
    // branch's shortfall message was ever asserted: making the check
    // `partitioned && forKeyword.size < required` — or deleting the
    // unpartitioned message outright — left the whole suite green, and this
    // is the branch that carries every keyword under the window, which today
    // is BOTH of them (keywords:deepseek-harness measured 5,131 against a
    // 5,250 window on 2026-09-04).
    //
    // The reachable shape is the mid-stream empty page the check's own
    // comment names: the `||` in the page loop's break ends a cell on ANY
    // empty page, including one arriving before the cell's answered total
    // says the cell is exhausted. Here page 0 carries 5 of 10 names and page
    // 1 is empty, so the cell ends four names early with nothing else to
    // notice it.
    const totals = { 'keywords:dsh-plugin': 10, 'keywords:deepseek-harness': 0 }
    const { fetchImpl } = stubSearch(totals, (query, from) =>
      query === 'keywords:dsh-plugin' && from === 0
        ? Array.from({ length: 5 }, (_, i) => `p${i}`)
        : [])
    return expect(searchByKeywords(fetchImpl)).rejects.toThrow(
      /^npm search for keywords:dsh-plugin enumerated 5 of 10 names, and a second full pass found no more; the search ended before reaching the answered total, so the harvest would be silently short$/,
    )
  })

  it('refuses to ask for a from past the window instead of paging into the wrap', async () => {
    // The probe says the keyword fits, the pages say it does not. `from=5250`
    // would silently return page 0 (measured live), so the loop must throw.
    const { fetchImpl, urls } = stubSearch(
      { 'keywords:dsh-plugin': 5250, 'keywords:deepseek-harness': 0 },
      () => Array.from({ length: 250 }, (_, i) => `p${i}`),
      { 'keywords:dsh-plugin': 9999 },
    )
    await expect(searchByKeywords(fetchImpl)).rejects.toThrow(
      /npm search for keywords:dsh-plugin needs from=5250, past the 5000 the registry honors \(a larger from silently returns page 0\)/,
    )
    expect(urls).toHaveLength(22) // one size=1 probe plus from=0..5000
  })

  it('throws when a page answers no total, rather than ending the cell silently', async () => {
    // A response carrying no `total` cannot be told apart from a truncated
    // page: defaulting it to 0 made `from + objects.length >= 0` true on the
    // very first page, so a full 250-object page silently ended the cell and
    // the harvest returned a quarter of a keyword's actual names without
    // complaint. Live shape: the registry has served a 200 with
    // `<!doctype html>` and a 429 with a 7 KB HTML body on ordinary search
    // pages, so a missing total is not hypothetical. The probe answers a
    // real total here — searchTotal's own missing-total throw is pinned
    // separately below — so this isolates the page loop's own check.
    let call = 0
    const fetchImpl = (async (url: string | URL) => {
      call += 1
      const params = new URL(String(url)).searchParams
      if (params.get('size') === '1') {
        return new Response(JSON.stringify({ total: 300, objects: [] }), { status: 200 })
      }
      const body = { objects: Array.from({ length: 250 }, (_, i) => ({ package: { name: `dsh-forever-${i}` } })) }
      return new Response(JSON.stringify(body), { status: 200 })
    }) as unknown as typeof fetch

    await expect(searchByKeywords(fetchImpl)).rejects.toThrow(
      /npm search for keywords:dsh-plugin at from=0 answered no total; a truncated page cannot be told from a complete one/,
    )
    expect(call).toBe(2) // the probe, then the one page that trips the throw
  })

  it('throws when the total probe itself answers no total', async () => {
    // searchTotal's own soft `?? 0` default made a malformed probe body read
    // as an empty keyword: partitionKeyword would return `{ total: 0,
    // partitioned: false }`, and the coverage floor above becomes
    // `min(0, 0) = 0` — silently disabled, never tripping regardless of what
    // the harvest actually finds. A missing total on the probe now throws
    // immediately, before any page is ever fetched.
    let call = 0
    const fetchImpl = (async () => {
      call += 1
      return new Response(JSON.stringify({ objects: [] }), { status: 200 })
    }) as unknown as typeof fetch

    await expect(searchByKeywords(fetchImpl)).rejects.toThrow(
      /npm search for keywords:dsh-plugin at from=0 answered no total; a keyword's size cannot be measured without it/,
    )
    expect(call).toBe(1) // the probe itself trips the throw; no page is ever fetched
  })

  it('names the keyword when a search body is null, rather than dying on a bare TypeError', async () => {
    // The same input class as A-1, one boundary over: `null` is legal JSON,
    // so readSearchBody's try/catch never fires and the `SearchBody` cast is
    // satisfied structurally by a value that has no properties at all.
    // `body.total` then throws `Cannot read properties of null` — naming no
    // keyword, which is the exact defect readSearchBody was written to fix
    // (page 13 of keywords:dsh-plugin once answered 200 with `<!doctype
    // html>`, and the bare SyntaxError named no keyword either).
    const fetchImpl = (async () => new Response('null', { status: 200 })) as unknown as typeof fetch
    await expect(searchByKeywords(fetchImpl)).rejects.toThrow(
      /npm search for keywords:dsh-plugin at from=0 answered 200 with a body that is not a search response/,
    )
  })

  it('skips a null object in a search page instead of dying on it', async () => {
    // `{"objects":[null]}` is legal JSON too, and `object.package?.name`
    // throws on the element rather than the body. A page entry that names no
    // package is not a package — skipped, exactly like one whose name is not
    // a string. That is this test's subject and it is unchanged.
    //
    // What its tail asserts DID change: the resulting 1-of-2 shortfall
    // used to be refused here, and a shortfall of one is now inside
    // MAX_SEARCH_SHORTFALL, so it is reported and the harvest publishes.
    // The refusal has not gone anywhere — the 5-of-10 case above and the
    // one-past-the-bound case in the shortfall describe below both keep
    // it covered.
    const fetchImpl = (async (url: string | URL) => {
      const params = new URL(String(url)).searchParams
      const query = params.get('text') ?? ''
      if (!query.includes('dsh-plugin')) return new Response(JSON.stringify({ total: 0, objects: [] }), { status: 200 })
      if (params.get('size') === '1') return new Response(JSON.stringify({ total: 2, objects: [] }), { status: 200 })
      return new Response(JSON.stringify({
        total: 2,
        objects: [null, { package: { name: 'dsh-real' } }, { package: null }, 'not an object'],
      }), { status: 200 })
    }) as unknown as typeof fetch
    const seen: KeywordShortfall[] = []
    const names = await searchByKeywords(fetchImpl, undefined, undefined, undefined, undefined, s => seen.push(s))
    expect(names).toEqual(['dsh-real'])
    expect(seen).toEqual([{ keyword: 'dsh-plugin', enumerated: 1, required: 2, unreachable: 0, recovered: 0, windowShortfall: 1, tailShortfall: 0 }])
  })

  it('does not blame a partition for a short final page at exactly the window', async () => {
    // Pre-existing, and the mirror of the overstated total this harvest
    // already tolerates: a keyword whose total is EXACTLY SEARCH_WINDOW is
    // not partitioned at all (partitionKeyword returns one
    // `{ keywords: [keyword] }` cell for any total that fits), so its one cell
    // is paged with pastWindow: 'throw'.
    // Let the last page serve 249 of 250 — the registry anomaly this module
    // cites twice — and `from` advances to 5250, past the cap, and the build
    // died with "the partition is wrong" naming a partition that does not
    // exist. A cell whose own answered total fits the window can never need
    // a page past the cap, so reaching there is count/paging noise for the
    // shortfall bounds to measure.
    const { fetchImpl } = stubSearch(
      { 'keywords:dsh-plugin': SEARCH_WINDOW, 'keywords:deepseek-harness': 0 },
      (query, from) => {
        if (query !== 'keywords:dsh-plugin') return []
        // 250 per page except the last, which is one object short.
        const size = from === MAX_SEARCH_FROM ? 249 : 250
        return Array.from({ length: size }, (_, i) => `p${from + i}`)
      },
    )
    const seen: KeywordShortfall[] = []
    await expect(searchByKeywords(fetchImpl, undefined, undefined, undefined, undefined, s => seen.push(s)))
      .resolves.toHaveLength(SEARCH_WINDOW - 1)
    expect(seen).toEqual([{
      keyword: 'dsh-plugin', enumerated: SEARCH_WINDOW - 1, required: SEARCH_WINDOW,
      unreachable: 0, recovered: 0, windowShortfall: 1, tailShortfall: 0,
    }])
  })

  describe('a shortfall small enough to be registry noise', () => {
    // Live on 2026-09-04, `main`'s daily build died here:
    //   npm search for keywords:dsh-plugin enumerated 3746 of 3747 names,
    //   and a second full pass found no more
    // One name out of 3747. The two churn tolerances above cannot help with
    // it: `Math.min(total, after)` needs the two probes to DISAGREE, and both
    // answered 3747, while the second full pass re-pages the same cells and
    // finds the same 3746. This module's own comment names the mechanism —
    // "Same for a `total` npm overstates by one" — so it is a shortfall no
    // amount of re-reading can close, and the build simply stopped.
    //
    // The scheduled run at 07:58 had passed and the push run at 08:39 failed,
    // so it is a coin flip per run, and a lost flip freezes the shelf for the
    // day. A bounded tolerance is the trade: at most MAX_SEARCH_SHORTFALL
    // names may be missing from one keyword, reported rather than silent,
    // against a build that publishes.

    /** total 10, page 0 serves `served`, page 1 is empty — the mid-stream
     * empty page that ends a cell early, which is the reachable shape. */
    const shortBy = (served: number) => stubSearch(
      { 'keywords:dsh-plugin': 10, 'keywords:deepseek-harness': 0 },
      (query, from) => (query === 'keywords:dsh-plugin' && from === 0
        ? Array.from({ length: served }, (_, i) => `p${i}`)
        : []),
    ).fetchImpl

    it('publishes, and reports the shortfall instead of swallowing it', async () => {
      const seen: KeywordShortfall[] = []
      const names = await searchByKeywords(shortBy(9), undefined, undefined, undefined, undefined, (s: KeywordShortfall) => seen.push(s))
      expect(names).toHaveLength(9)
      // Not silent: the caller gets the numbers so the build report can carry
      // them. Nothing else can name the missing package — that is the whole
      // difficulty — so the count is the honest thing to publish.
      // `unreachable: 0` is the point: this keyword fits the window, so its
      // shortfall is registry noise and not the API's ceiling. The two are
      // now distinguishable in the build report.
      expect(seen).toEqual([{
        keyword: 'dsh-plugin', enumerated: 9, required: 10,
        unreachable: 0, recovered: 0, windowShortfall: 1, tailShortfall: 0,
      }])
    })

    it('tolerates a shortfall exactly at the bound and refuses one past it', async () => {
      await expect(searchByKeywords(shortBy(10 - MAX_SEARCH_SHORTFALL))).resolves.toHaveLength(10 - MAX_SEARCH_SHORTFALL)
      await expect(searchByKeywords(shortBy(10 - MAX_SEARCH_SHORTFALL - 1)))
        .rejects.toThrow(/enumerated \d+ of 10 names/)
    })

    it('reports nothing when the keyword enumerated whole', async () => {
      const seen: unknown[] = []
      await searchByKeywords(shortBy(10), undefined, undefined, undefined, undefined, (s: KeywordShortfall) => seen.push(s))
      expect(seen).toEqual([])
    })

    it('stays well under the smallest coverage gap this repo has actually seen', () => {
      // The bound is not a round number picked for comfort. Two magnitudes are
      // recorded in npm-client.ts itself: a genuine partition gap is "hundreds
      // of names", and PARTITION_KEYWORDS was measured FIFTEEN names short the
      // day after it was documented as complete. A tolerance at or above 15
      // would have absorbed that real gap silently.
      expect(MAX_SEARCH_SHORTFALL).toBeLessThan(15)
      // And large enough for the mechanisms it exists for: npm overstating a
      // total by one, plus a page or two serving 249 objects of 250.
      expect(MAX_SEARCH_SHORTFALL).toBeGreaterThanOrEqual(1)
    })
  })

  describe('a shortfall beyond one search window', () => {
    // The two quantities MAX_SEARCH_SHORTFALL used to carry alone. They have
    // opposite properties and one bound cannot hold both:
    //
    //   race / overstatement   1-3, no growth, a re-page may close it
    //   unreachable            total - SEARCH_WINDOW, grows with the keyword,
    //                          reported tail beyond ONE search window
    //
    // Live on 2026-09-07 the second was 151 names against a bound of 3, so the
    // daily build went red on every tree. Sizing the bound for that would put
    // it far above the FIFTEEN-name partition gap this repo has actually seen,
    // which is exactly what MAX_SEARCH_SHORTFALL's own comment refuses.
    //
    // Counts can still be noisy above the window, and rankings can change
    // between passes. Both regressions are exercised below.

    /** A keyword past the window: `total` names exist, the window serves the
     * first SEARCH_WINDOW of them, and one refinement cell serves `recovered`
     * of the rest. Mirrors the live shape — a window cell that stops at the
     * window, plus cells that reach past it. */
    const pastWindow = (total: number, recovered: number, movedOnRetry = 0) => {
      const beyond = Array.from({ length: total - SEARCH_WINDOW }, (_, i) => `beyond${i}`)
      const window = Array.from({ length: SEARCH_WINDOW }, (_, i) => `w${i}`)
      let windowPass = 0
      // The cell always carries one IN-window name on top of what it recovers.
      // A cell whose total is 0 is dropped by `partitionKeyword` before the
      // coverage check ever sees it, so `recovered: 0` has to mean "a live
      // cell that reaches nothing new", not "no cell".
      const cell = ['w0', ...beyond.slice(0, recovered)]
      return stubSearch(
        query => (query === 'keywords:deepseek-harness' ? total
          : query === 'keywords:deepseek-harness,dsh' ? cell.length
          : 0),
        (query, from) => {
          if (query === 'keywords:deepseek-harness') {
            if (from === 0) windowPass += 1
            // Ranking can change without the total changing. The retry moves
            // already recovered tail names into a still-full window.
            const ranked = windowPass > 1 && movedOnRetry > 0
              ? [...window.slice(0, -movedOnRetry), ...beyond.slice(0, movedOnRetry)]
              : window
            return from > MAX_SEARCH_FROM ? [] : ranked.slice(from, from + 250)
          }
          if (query === 'keywords:deepseek-harness,dsh') return cell.slice(from, from + 250)
          return []
        },
      ).fetchImpl
    }

    it('publishes when the partition recovers nearly all of what is out of reach', async () => {
      // 5407 names, 157 past the window, cells recover 150 of them. The
      // residual of 7 is far past MAX_SEARCH_SHORTFALL and is NOT a defect:
      // it is the API's own limit, measured. This is the case that was red.
      const seen: KeywordShortfall[] = []
      await expect(
        searchByKeywords(pastWindow(5407, 150), undefined, undefined, undefined, undefined, s => seen.push(s)),
      ).resolves.toHaveLength(SEARCH_WINDOW + 150)
      expect(seen).toHaveLength(1)
      expect(seen[0]).toMatchObject({ keyword: 'deepseek-harness', unreachable: 157, recovered: 150 })
    })

    it.each([0, 20])('keeps coverage when %i recovered names move into the retry window', async (moved) => {
      // The union is 5400 in both runs. Moving 20 names merely grows the
      // two-window union to 5270; it must not change recovery from 150/157
      // to 130/157. Seven missing names keeps this outside the noise branch,
      // so restoring the noise allowance alone cannot make this test pass.
      const seen: KeywordShortfall[] = []
      const names = await searchByKeywords(
        pastWindow(5407, 150, moved), undefined, undefined, undefined, undefined, s => seen.push(s),
      )
      expect(names).toHaveLength(5400)
      expect(names).toContain('w5249') // displaced in the retry, retained from pass one
      expect(names).toContain('beyond149')
      expect(names).not.toContain('beyond150')
      expect(seen).toEqual([{
        keyword: 'deepseek-harness', enumerated: 5400, required: 5407, unreachable: 157, recovered: 150,
        // The whole shortfall is charged to the tail: the window served every
        // rank it can address in both runs, so moving 20 names between passes
        // must not book itself as an in-window miss.
        windowShortfall: 0, tailShortfall: 7,
      }])
    })

    it.each([1, 3])('tolerates a total overstated by %i across the window boundary', async (overstatement) => {
      // Exactly 5250 real names: both the window and its refinement serve
      // all of them. Only the parent query's reported total is inflated.
      const { fetchImpl } = stubSearch(
        { 'keywords:deepseek-harness': 5250 + overstatement, 'keywords:deepseek-harness,dsh': 5250 },
        (query, from) => query === 'keywords:deepseek-harness' || query === 'keywords:deepseek-harness,dsh'
          ? Array.from({ length: Math.max(0, Math.min(250, 5250 - from)) }, (_, i) => `real${from + i}`)
          : [],
      )
      const seen: KeywordShortfall[] = []
      const names = await searchByKeywords(fetchImpl, undefined, undefined, undefined, undefined, s => seen.push(s))
      expect(names).toHaveLength(5250)
      expect(seen).toEqual([{
        keyword: 'deepseek-harness', enumerated: 5250, required: 5250 + overstatement,
        unreachable: overstatement, recovered: 0,
        // An overstated total invents names PAST the window, so the phantom
        // lands on the tail term — and the tail carries the same bounded
        // noise allowance as the window, which is why it publishes.
        windowShortfall: 0, tailShortfall: overstatement,
      }])
    })

    it('still requires recovery for a four-name tail, past the noise allowance', async () => {
      await expect(searchByKeywords(pastWindow(5254, 0))).rejects.toThrow(/recovered 0 of 4/)
    })

    it('accepts the recovery floor and rejects a single name below it', async () => {
      // 45/50 = 90%; 44/50 < 90%. The tail is deliberately SMALL: it has to
      // leave the rate as the only thing deciding, and a 150-name tail at the
      // floor leaves 15 missing, which MAX_UNREACHABLE_RESIDUAL now refuses
      // on its own. Both residuals here (5 and 6) are inside that cap.
      await expect(searchByKeywords(pastWindow(5300, 45))).resolves.toHaveLength(5295)
      await expect(searchByKeywords(pastWindow(5300, 44))).rejects.toThrow(/under the 0\.9 floor/)
    })

    it('accepts the residual cap exactly', async () => {
      // 740/750 is healthy and leaves exactly MAX_UNREACHABLE_RESIDUAL missing.
      await expect(searchByKeywords(pastWindow(6000, 750 - MAX_UNREACHABLE_RESIDUAL)))
        .resolves.toHaveLength(SEARCH_WINDOW + 750 - MAX_UNREACHABLE_RESIDUAL)
    })

    it('refuses when the partition collapses, however small the keyword', async () => {
      // Same 157 out of reach, cells recover NOTHING. An absolute-residual
      // bound loose enough to pass the case above would pass this one too;
      // a recovery RATE cannot, which is the whole point of the split.
      await expect(searchByKeywords(pastWindow(5407, 0)))
        .rejects.toThrow(/recovered 0 of 157/)
    })

    it('refuses the fifteen-name partition gap at the live tail size', async () => {
      // THE case the cap was re-sized for, as behaviour rather than as a
      // bound on a constant. 157 out of reach, cells recover 142 — the shape
      // PARTITION_KEYWORDS took the day after it was documented as complete.
      // The rate floor passes it (142/157 = 0.9045, above 0.9), so at the
      // former cap of 25 this published fifteen names short in silence. The
      // cap is what refuses it, and the message names the tail term.
      // The cap is interpolated, not spelled: the sibling bound test admits
      // any value in [9, 15), and at 12 this gap is still correctly refused,
      // so a literal would redden this test for a reason it does not assert.
      await expect(searchByKeywords(pastWindow(5407, 142)))
        .rejects.toThrow(new RegExp(`a tail shortfall of 15, past the ${MAX_UNREACHABLE_RESIDUAL} names a build may publish short`))
      // The family event it must still absorb is `publishes when the
      // partition recovers nearly all of what is out of reach`, which runs
      // this same fixture and additionally asserts the shortfall record.
    })

    it('refuses when the residual outgrows what may be published short', async () => {
      // A high rate is not sufficient on its own: at 15% window coverage the
      // same rate leaves thousands missing. The absolute cap is what says how
      // many names the catalog may knowingly omit, and crossing it is the
      // signal that the partition has to get better — not that the bound
      // should get looser.
      const beyond = 6000 - SEARCH_WINDOW
      await expect(searchByKeywords(pastWindow(6000, beyond - MAX_UNREACHABLE_RESIDUAL - 1)))
        .rejects.toThrow(/past the .* names a build may publish short/)
    })

    it('keeps the race bound exactly as it was for a keyword inside the window', async () => {
      // Nothing is unreachable here, so a shortfall is registry noise and the
      // old bound governs unchanged — the split must not loosen this half.
      const inWindow = (served: number) => stubSearch(
        { 'keywords:dsh-plugin': 10, 'keywords:deepseek-harness': 0 },
        (query, from) => (query === 'keywords:dsh-plugin' && from === 0
          ? Array.from({ length: served }, (_, i) => `p${i}`)
          : []),
      ).fetchImpl
      await expect(searchByKeywords(inWindow(10 - MAX_SEARCH_SHORTFALL)))
        .resolves.toHaveLength(10 - MAX_SEARCH_SHORTFALL)
      await expect(searchByKeywords(inWindow(10 - MAX_SEARCH_SHORTFALL - 1)))
        .rejects.toThrow(/enumerated \d+ of 10 names/)
    })

    it('bounds each constant by the magnitudes this repo has measured', () => {
      // The rate floor has to catch a single cell dying. `dsh` alone recovers
      // 123 of a 157-name tail live, so losing it takes the rate far below
      // the floor. A floor under 0.5 could not do that.
      expect(MIN_UNREACHABLE_RECOVERY).toBeGreaterThanOrEqual(0.75)
      expect(MIN_UNREACHABLE_RECOVERY).toBeLessThan(1)
      // The cap is bracketed by two magnitudes this repo has actually
      // measured, and both bounds are load-bearing:
      //   >= 9   the `sayedev` family must be absorbed rather than redden the
      //          build. Its residual read 7 on the day, but that 7 was SIX
      //          family names past the window plus one name of the total
      //          climbing mid-run; past the window `windowShortfall` is 0, so
      //          that noise is charged to this cap. The same family on a full
      //          MAX_SEARCH_SHORTFALL allowance is 6 + 3.
      //   < 15   PARTITION_KEYWORDS was measured FIFTEEN names short, and
      //          MAX_SEARCH_SHORTFALL's comment refuses any bound at or above
      //          that because it absorbs a real partition gap silently.
      // An earlier 25 sat outside the upper bound, on the reasoning that the
      // family needed 20-plus of headroom — it needed 9. The two magnitudes
      // are compatible, so assert the window rather than a loose range.
      expect(MAX_UNREACHABLE_RESIDUAL).toBeGreaterThanOrEqual(6 + MAX_SEARCH_SHORTFALL)
      expect(MAX_UNREACHABLE_RESIDUAL).toBeLessThan(15)
    })

    it('keeps the prose copies of the cap in step with the constant', () => {
      // Hand-maintained copies of this bracket live in CLAUDE.md and in the
      // spec, and nothing pinned either to the code: the value, the floor and
      // the ceiling were all prose. That is how one cap value went stale in
      // two documents at once and had to be corrected by hand. The repo
      // already couples a doc to a decision this way — readme-pins.test.ts
      // pins the README versions to package.json, and repo-guards.test.ts
      // pins CLAUDE.md's release command to the workspace specifier.
      const root = join(srcDir, '..', '..', '..')
      const claude = readFileSync(join(root, 'CLAUDE.md'), 'utf8')
      const spec = readFileSync(join(root, 'docs', 'design', '2026-08-18-dsh-plugin-shop-design.md'), 'utf8')
      // Positive controls first, so a renamed heading or a moved paragraph
      // cannot let this pass by scanning text that no longer discusses the cap.
      expect(claude, 'CLAUDE.md no longer names the cap').toContain('MAX_UNREACHABLE_RESIDUAL')
      expect(spec, 'the spec no longer states the residual bound').toMatch(/a residual of at most \d+ names/)
      expect(claude).toContain(`\`MAX_UNREACHABLE_RESIDUAL\` (${MAX_UNREACHABLE_RESIDUAL})`)
      expect(spec).toContain(`a residual of at most ${MAX_UNREACHABLE_RESIDUAL} names`)
      // The BRACKET, not just the value. A copy that keeps the number while
      // losing the magnitudes that bound it is how 25 passed review once.
      for (const [name, doc] of [['CLAUDE.md', claude], ['the spec', spec]] as const) {
        expect(doc, `${name} lost the bracket floor`).toMatch(new RegExp(`at least \\*{0,2}${6 + MAX_SEARCH_SHORTFALL}\\b`))
        expect(doc, `${name} lost the bracket ceiling`).toMatch(/under \*{0,2}15\b/)
      }
    })

    it('divides the labour: the rate cannot catch a partition gap, the cap can', () => {
      // A rate floor's strictness DECAYS with the tail — 0.9 permits 10% of
      // it — so above this crossover every rate violation is already a cap
      // violation and the rate decides nothing but which message prints.
      const crossover = MAX_UNREACHABLE_RESIDUAL / (1 - MIN_UNREACHABLE_RECOVERY)
      // The tail from which the FIFTEEN-name partition gap first clears the
      // floor, derived rather than dated: a 0.9 floor permits a tenth of the
      // tail, so 150. `Math.round` and not `Math.ceil` — `1 - 0.9` is
      // 0.09999999999999998, which puts the quotient a hair above 150 and
      // would make a ceiling answer 151.
      const gap = 15
      const clearsFloorFrom = Math.round(gap / (1 - MIN_UNREACHABLE_RECOVERY))
      expect(clearsFloorFrom).toBe(150)
      // THE DIVISION OF LABOUR: that tail is past the crossover, so by the
      // time a gap this size can satisfy the rate, the rate was already inert
      // and the cap is the only bound left holding it. Asserted as a relation
      // and not as `crossover === 100`, which would pin the cap to exactly 10
      // and make the sibling test's deliberately loose bracket unreachable —
      // the relation holds across all of [9, 15).
      expect(clearsFloorFrom).toBeGreaterThan(crossover)
      // And the rate really does wave it through there. Written the way
      // production writes it, `rate < floor`, because the complementary form
      // `missing / tail < 1 - floor` disagrees at EVERY exact-90% tail:
      // `1 - 0.9` is strictly below a tenth, so it reports a refusal where
      // searchByKeywords accepts. Which bound then refuses the gap is the
      // sibling test's `< 15`; the behaviour is `refuses the fifteen-name
      // partition gap at the live tail size`.
      expect((clearsFloorFrom - gap) / clearsFloorFrom).not.toBeLessThan(MIN_UNREACHABLE_RECOVERY)
    })

    /** A partitioned keyword whose WINDOW comes up short while its cell
     * carries some of the very names the window missed. `inWindowFromCell`
     * names are ranked inside the window but served only by the cell. */
    const shortWindow = (total: number, served: number, inWindowFromCell: number, tailFromCell: number) => {
      const beyond = Array.from({ length: total - SEARCH_WINDOW }, (_, i) => `beyond${i}`)
      const window = Array.from({ length: SEARCH_WINDOW }, (_, i) => `w${i}`)
      // The sweep serves the first `served` ranks; the cell carries the next
      // `inWindowFromCell` of them plus `tailFromCell` names past the window.
      // `w0` rides along so a cell that adds nothing is still LIVE — a cell
      // whose total is 0 is dropped by partitionKeyword before the coverage
      // check sees it, and the sweep already served w0, so the union is
      // unchanged by it.
      const cell = [
        'w0',
        ...window.slice(served, served + inWindowFromCell),
        ...beyond.slice(0, tailFromCell),
      ]
      return stubSearch(
        query => (query === 'keywords:deepseek-harness' ? total
          : query === 'keywords:deepseek-harness,dsh' ? cell.length
          : 0),
        (query, from) => {
          if (query === 'keywords:deepseek-harness') {
            return from > MAX_SEARCH_FROM ? [] : window.slice(0, served).slice(from, from + 250)
          }
          if (query === 'keywords:deepseek-harness,dsh') return cell.slice(from, from + 250)
          return []
        },
      ).fetchImpl
    }

    it('never credits an in-window name a cell supplied as tail recovery', async () => {
      // The defect this pins. Tail of 30, the cells genuinely reach 26 of it
      // (86.7%, under the floor), and the window sweep is 3 names short —
      // inside its own allowance, so nothing else refuses this build.
      // Measuring recovery against the sweep's CONTRIBUTION books those 3
      // window misses as tail finds, reports 29 of 30 (96.7%) and publishes.
      // Measuring against what the window can ADDRESS reports 26 and throws.
      await expect(searchByKeywords(shortWindow(5280, 5247, 3, 26)))
        .rejects.toThrow(/recovered 26 of 30 .* under the 0\.9 floor/)
      // Control, holding true tail coverage fixed and healing the window: the
      // verdict must not depend on which half produced an in-window name.
      await expect(searchByKeywords(shortWindow(5280, 5250, 0, 26)))
        .rejects.toThrow(/recovered 26 of 30 .* under the 0\.9 floor/)
    })

    it('charges a window miss the cells covered to the tail, and says so', async () => {
      // The documented COST of charging every ambiguous name to the window.
      // A cell answers with names and no ranks, so this run — sweep 4 short,
      // cells returning 157 names — is byte-identical to one where the sweep
      // was whole and the cells missed 4 tail names. The arithmetic cannot
      // separate them, so it picks the reading that cannot be used to pay for
      // a partition gap, and the 4 names land on the tail term under the
      // tail's larger allowance rather than throwing at the window's 3.
      //
      // Pinned because it looks like a bug and is not: the alternative is
      // measuring recovery against the sweep, which is what let a 26-of-30
      // tail publish as 29 of 30 in the test above.
      const seen: KeywordShortfall[] = []
      await expect(
        searchByKeywords(shortWindow(5407, 5246, 0, 157), undefined, undefined, undefined, undefined, s => seen.push(s)),
      ).resolves.toHaveLength(5403)
      expect(seen).toEqual([{
        keyword: 'deepseek-harness', enumerated: 5403, required: 5407,
        unreachable: 157, recovered: 153, windowShortfall: 0, tailShortfall: 4,
      }])
      // And the same four names with a tail too small to absorb them still
      // fail loudly — the tolerance comes from the tail's size, not from the
      // ambiguity.
      await expect(searchByKeywords(shortWindow(5280, 5246, 0, 30)))
        .rejects.toThrow(/recovered 26 of 30 .* under the 0\.9 floor/)
    })

    it('names the window when it alone exceeds the noise allowance', async () => {
      // The old boundary assertion accepted three window misses plus one
      // tail miss. That spent the per-keyword noise allowance twice. A
      // window term above the bound still names the window in its error.
      await expect(searchByKeywords(shortWindow(5251, SEARCH_WINDOW - MAX_SEARCH_SHORTFALL - 1, 0, 0)))
        .rejects.toThrow(/names its own window can address .* no partition can explain it/)
    })

    it.each([1, 2, 3])('requires recovery when three window misses accompany %i tail miss(es)', async (tailMissing) => {
      // Four to six names are missing in total, with no tail recovered. Each
      // term separately fits the three-name allowance, but their sum does
      // not: these must take the recovery check, not publish as count noise.
      const seen: KeywordShortfall[] = []
      await expect(searchByKeywords(
        shortWindow(5250 + tailMissing, 5247, 0, 0),
        undefined, undefined, undefined, undefined, s => seen.push(s),
      )).rejects.toThrow(new RegExp(`recovered 0 of ${tailMissing} .* under the 0\\.9 floor`))
      expect(seen).toEqual([])
    })

    it.each([1, 2])('shares the three-name noise allowance with %i tail miss(es)', async (tailMissing) => {
      const windowMissing = 3 - tailMissing
      const seen: KeywordShortfall[] = []
      const names = await searchByKeywords(
        shortWindow(5250 + tailMissing, 5250 - windowMissing, 0, 0),
        undefined, undefined, undefined, undefined, s => seen.push(s),
      )
      expect(names).toHaveLength(5250 - windowMissing)
      expect(seen).toEqual([{
        keyword: 'deepseek-harness', enumerated: 5250 - windowMissing,
        required: 5250 + tailMissing, unreachable: tailMissing, recovered: 0,
        windowShortfall: windowMissing, tailShortfall: tailMissing,
      }])
    })

    it('names the window AND the cells when a partitioned keyword re-probes back inside', async () => {
      // `partitioned` is decided on the FIRST probe and `required` on the
      // last, so a keyword hovering at the boundary partitions and then
      // re-probes to a total that fits. Branching the message on `unreachable`
      // instead of `partitioned` sent this case to the text written for a
      // keyword that never partitioned — naming neither half, which is the
      // fault the split exists to remove.
      let probes = 0
      const { fetchImpl } = stubSearch(
        query => (query === 'keywords:deepseek-harness'
          // 5300 on the first probe, 5240 on every later one.
          ? (probes++ === 0 ? 5300 : 5240)
          : query === 'keywords:deepseek-harness,dsh' ? 10 : 0),
        (query, from) => (query === 'keywords:deepseek-harness,dsh' && from === 0
          ? Array.from({ length: 10 }, (_, i) => `n${i}`)
          : []),
      )
      await expect(searchByKeywords(fetchImpl))
        .rejects.toThrow(/its own window can address \(its window sweep served 0, beside 1 refinement cell\(s\)\)/)
    })

    it('keeps the two terms summing to the shortfall on every reported record', async () => {
      // The identity the split rests on. If it ever fails, one of the two
      // bounds is being applied to a quantity that is not what it names, and
      // the report's arithmetic stops adding up for a reader.
      const seen: KeywordShortfall[] = []
      const push = (s: KeywordShortfall) => seen.push(s)
      // A tail-only miss, a tail miss inside the noise allowance, a window
      // and tail miss sharing the noise allowance, and an in-window keyword.
      await searchByKeywords(pastWindow(5407, 150), undefined, undefined, undefined, undefined, push)
      await searchByKeywords(pastWindow(5253, 0), undefined, undefined, undefined, undefined, push)
      await searchByKeywords(shortWindow(5251, 5248, 0, 0), undefined, undefined, undefined, undefined, push)
      await searchByKeywords(
        stubSearch({ 'keywords:dsh-plugin': 10, 'keywords:deepseek-harness': 0 },
          (query, from) => (query === 'keywords:dsh-plugin' && from === 0
            ? Array.from({ length: 9 }, (_, i) => `p${i}`)
            : [])).fetchImpl,
        undefined, undefined, undefined, undefined, push,
      )
      expect(seen).toHaveLength(4)
      expect(seen.map(s => [s.windowShortfall, s.tailShortfall])).toEqual([
        [0, 7], [0, 3], [2, 1], [1, 0],
      ])
      for (const s of seen) {
        expect(s.windowShortfall + s.tailShortfall).toBe(s.required - s.enumerated)
        expect(s.recovered + s.tailShortfall).toBe(s.unreachable)
      }
    })
  })

  it('reports the maintainers every page carried, so the vocabulary can grow', async () => {
    const fetchImpl = (async (url: string | URL) => {
      const params = new URL(String(url)).searchParams
      const query = params.get('text') ?? ''
      if (!query.includes('dsh-plugin')) return new Response(JSON.stringify({ total: 0, objects: [] }), { status: 200 })
      if (params.get('size') === '1') return new Response(JSON.stringify({ total: 2, objects: [] }), { status: 200 })
      return new Response(JSON.stringify({
        total: 2,
        objects: [
          { package: { name: 'dsh-a', maintainers: [{ username: 'alice' }] } },
          { package: { name: 'dsh-b', maintainers: [{ username: 'alice' }, { username: 'bob' }] } },
        ],
      }), { status: 200 })
    }) as unknown as typeof fetch
    const seen: string[] = []
    const names = await searchByKeywords(fetchImpl, undefined, undefined, undefined, undefined, () => {},
      users => seen.push(...users))
    expect(names).toEqual(['dsh-a', 'dsh-b'])
    // Reported as observed, duplicates and all: de-duplication is
    // mergePublishers' job, and doing it here would make a page that carried
    // nothing indistinguishable from one that repeated a name.
    expect([...new Set(seen)].sort()).toEqual(['alice', 'bob'])
  })

  describe('publisher cells', () => {
    /** A keyword past the window whose tail is one publisher's family, which no
     * refinement cell reaches — the shape of the sayedev event. */
    const familyPastWindow = (total: number, family: number) => stubSearch(
      query => (query === 'keywords:deepseek-harness' ? total
        : query === 'keywords:deepseek-harness maintainer:sayedev' ? family
        : query === 'keywords:deepseek-harness,dsh' ? 1
        : 0),
      (query, from) => {
        const beyond = Array.from({ length: total - SEARCH_WINDOW }, (_, i) => `beyond${i}`)
        if (query === 'keywords:deepseek-harness') {
          return from > MAX_SEARCH_FROM ? [] : Array.from({ length: 250 }, (_, i) => `w${from + i}`)
        }
        if (query === 'keywords:deepseek-harness maintainer:sayedev') {
          return beyond.slice(0, family).slice(from, from + 250)
        }
        // A live refinement cell that reaches nothing past the window.
        if (query === 'keywords:deepseek-harness,dsh') return ['w0'].slice(from, from + 250)
        return []
      },
    ).fetchImpl

    it('recovers a publisher family the refinement cells cannot reach', async () => {
      // 5410 names, 160 past the window, all of them one publisher's. The
      // refinement cell reaches none of them; maintainer:sayedev reaches all.
      const names = await searchByKeywords(
        familyPastWindow(5410, 160), undefined, undefined, undefined, undefined,
        () => {}, () => {}, ['sayedev'])
      expect(names).toHaveLength(5410)
    })

    it('fails exactly as before when the vocabulary is empty', async () => {
      // The axis is a supplement. With no publishers known the shipped
      // behaviour is unchanged, which is what makes this safe to land.
      await expect(searchByKeywords(familyPastWindow(5410, 160)))
        .rejects.toThrow(/under the 0\.9 floor/)
    })

    it('spends no probes on a keyword that fits the window', async () => {
      // Thousands of probes is a real cost. A keyword inside the window needs
      // no partition at all, so it must buy none.
      const { fetchImpl, urls } = stubSearch(
        { 'keywords:dsh-plugin': 10, 'keywords:deepseek-harness': 0 },
        (query, from) => (query === 'keywords:dsh-plugin' && from === 0
          ? Array.from({ length: 10 }, (_, i) => `p${i}`) : []),
      )
      await searchByKeywords(fetchImpl, undefined, undefined, undefined, undefined,
        () => {}, () => {}, ['alice', 'bob'])
      expect(urls.filter(u => u.includes('maintainer'))).toEqual([])
    })

    it('stops probing at the budget rather than spending the whole vocabulary', async () => {
      // The vocabulary grows monotonically and forever; the per-run probe cost
      // must not. Same posture as REPO_BACKFILL_BUDGET on the GitHub half.
      const { fetchImpl, urls } = stubSearch(
        // The refinement cell is here so `partitionKeyword` finds a split and
        // the run reaches the publisher pass at all; it recovers nothing.
        query => (query === 'keywords:deepseek-harness' ? 5410
          : query === 'keywords:deepseek-harness,dsh' ? 1 : 0),
        (query, from) => {
          if (query === 'keywords:deepseek-harness,dsh') return ['w0'].slice(from, from + 250)
          return query === 'keywords:deepseek-harness' && from <= MAX_SEARCH_FROM
            ? Array.from({ length: 250 }, (_, i) => `w${from + i}`) : []
        },
      )
      const many = Array.from({ length: 50 }, (_, i) => `u${i}`)
      await expect(searchByKeywords(fetchImpl, undefined, undefined, undefined, undefined,
        () => {}, () => {}, many, 10)).rejects.toThrow()
      expect(urls.filter(u => u.includes('maintainer')).length).toBe(10)
      // Probed ten times, not twenty: the retry re-PAGES the partition but must
      // not re-PROBE the vocabulary, or the axis costs double on every keyword
      // whose residual sends it round again — which is the steady state.
    })

    it('pages only the publisher cells the window did not already serve whole', async () => {
      // The probe is the cheap half; PAGING every non-zero cell is what would
      // triple a run, because every maintainer in the vocabulary was read off a
      // `keywords:<harvest>` result and so answers non-zero for it. `alice` is
      // that common case — the window already served all three of her packages,
      // so her cell can only re-supply names the union holds. `sayedev` is the
      // family: twenty packages, fourteen in the window and six past it, so her
      // cell is the only thing that reaches those six.
      const aliceNames = new Set(['w0', 'w1', 'w2'])
      const sayedevNames = new Set([
        ...Array.from({ length: 14 }, (_, i) => `w${10 + i}`),
        ...Array.from({ length: 6 }, (_, i) => `beyond${i}`),
      ])
      const { fetchImpl, urls } = stubSearch(
        query => (query === 'keywords:deepseek-harness' ? 5256
          : query === 'keywords:deepseek-harness maintainer:alice' ? 3
          : query === 'keywords:deepseek-harness maintainer:sayedev' ? 20
          // A live refinement cell. It exists so `partitionKeyword` finds a
          // split — the publisher axis runs after it and cannot rescue a
          // keyword no refinement reaches at all — and it re-serves six names
          // the window already served and `sayedev` owns. That is what makes
          // this fixture distinguish a tally of DISTINCT NAMES from one of
          // occurrences: counting occurrences scores her 14 + 6 = 20 against a
          // cell total of 20, skips the cell, and loses the six names past the
          // window; counting distinct names scores her 14, and 20 > 14 pages
          // it. Both readings agree about `alice`, so she cannot show this.
          : query === 'keywords:deepseek-harness,dsh' ? 6
          : 0),
        (query, from) => {
          if (query === 'keywords:deepseek-harness') {
            return from > MAX_SEARCH_FROM ? [] : Array.from({ length: 250 }, (_, i) => `w${from + i}`)
          }
          if (query === 'keywords:deepseek-harness,dsh') {
            return Array.from({ length: 6 }, (_, i) => `w${10 + i}`).slice(from, from + 250)
          }
          if (query === 'keywords:deepseek-harness maintainer:alice') return [...aliceNames].slice(from, from + 250)
          if (query === 'keywords:deepseek-harness maintainer:sayedev') return [...sayedevNames].slice(from, from + 250)
          return []
        },
        {},
        name => (aliceNames.has(name) ? ['alice'] : sayedevNames.has(name) ? ['sayedev'] : []),
      )
      const names = await searchByKeywords(fetchImpl, undefined, undefined, undefined, undefined,
        () => {}, () => {}, ['alice', 'sayedev'])
      // The six past the window are recovered, so the run publishes whole.
      expect(names).toHaveLength(5256)
      const probes = (user: string) => urls.filter(u => u.includes(`maintainer%3A${user}`) && u.includes('size=1'))
      const pages = (user: string) => urls.filter(u => u.includes(`maintainer%3A${user}`) && !u.includes('size=1'))
      // Both are probed — the filter cannot know a cell is redundant until it
      // has the total to compare against what the window served.
      expect(probes('alice')).toHaveLength(1)
      expect(probes('sayedev')).toHaveLength(1)
      // Only the one carrying names the union lacks is paged.
      expect(pages('alice')).toEqual([])
      expect(pages('sayedev').length).toBeGreaterThan(0)
    })
  })

})

describe('fetchCandidate', () => {
  const packument = {
    name: 'dsh-hello-plugin',
    'dist-tags': { latest: '1.2.0' },
    time: { '1.2.0': '2026-08-01T12:00:00.000Z' },
    versions: {
      '1.2.0': {
        dist: { integrity: 'sha512-hello' },
        license: 'MIT',
        repository: { url: 'git+https://github.com/you/hello-plugin.git' },
        dsh: {
          bundle: { patch: './cordis.patch.yml' },
          catalog: { category: 'tool', summary: { en: 'x', zh: 'y' }, capabilities: [] },
        },
      },
    },
  }

  it('returns the candidate for a readable packument', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify(packument), { status: 200 })) as unknown as typeof fetch
    const result = await fetchCandidate('dsh-hello-plugin', fetchImpl)
    expect(result.ok).toBe(true)
    expect(result.ok && result.candidate.name).toBe('dsh-hello-plugin')
  })

  it('retries a rate-limited packument fetch and succeeds when the registry recovers', async () => {
    const sleep = async (_ms: number) => {}
    let call = 0
    const fetchImpl = (async () => {
      call += 1
      if (call === 1) return new Response('rate limited', { status: 429 })
      return new Response(JSON.stringify(packument), { status: 200 })
    }) as unknown as typeof fetch

    const result = await fetchCandidate('dsh-hello-plugin', fetchImpl, sleep)
    expect(result.ok).toBe(true)
    expect(call).toBe(2)
  })

  it('sends an Authorization header when a token is given', async () => {
    const sleep = async (_ms: number) => {}
    const headersSeen: Array<Record<string, string> | undefined> = []
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
      headersSeen.push(init?.headers as Record<string, string> | undefined)
      return new Response(JSON.stringify(packument), { status: 200 })
    }) as unknown as typeof fetch

    const result = await fetchCandidate('dsh-hello-plugin', fetchImpl, sleep, 'npm_readonly_token')
    expect(result.ok).toBe(true)
    expect(headersSeen[0]?.Authorization).toBe('Bearer npm_readonly_token')
  })

  it('reports the HTTP status when the registry answers with a non-OK status', async () => {
    // The 429 is retried a bounded number of times; when the registry never
    // recovers, the last response's status still reaches the rejection detail.
    const sleep = async (_ms: number) => {}
    const fetchImpl = (async () => new Response('nope', { status: 429 })) as unknown as typeof fetch
    const result = await fetchCandidate('dsh-rate-limited', fetchImpl, sleep)
    expect(result.ok).toBe(false)
    expect(!result.ok && result.detail).toContain('429')
  })

  it('reports an unusable packument distinctly from an HTTP failure', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ 'dist-tags': { latest: '1.0.0' } }), { status: 200 })) as unknown as typeof fetch
    const result = await fetchCandidate('dsh-no-name', fetchImpl)
    expect(result.ok).toBe(false)
    expect(!result.ok && result.detail).not.toContain('200')
  })

  it('reports a body that cannot be parsed as JSON as a rejection, not a thrown error', async () => {
    const fetchImpl = (async () => new Response('not valid json{{{', { status: 200 })) as unknown as typeof fetch
    const result = await fetchCandidate('dsh-malformed-body', fetchImpl)
    expect(result.ok).toBe(false)
    expect(!result.ok && result.detail).toContain('unreadable')
  })

  it('reports a deadline that lands MID-BODY as the stall it is, not as an unreadable body', async () => {
    // withTimeout leaves its timer armed past the headers precisely so a
    // stalled body aborts, and the abort reason is the FetchTimeoutError
    // itself — so this catch can tell "our 30s deadline fired" from "npm sent
    // something malformed". The header-phase catch immediately above already
    // does; readSearchBody in the same module already does, with a comment
    // saying a deadline is not a malformed body; this site was the one missed,
    // and it publishes the wrong half of that pair to the author.
    const expiry = new FetchTimeoutError('registry request exceeded 50ms')
    const result = await fetchCandidate('dsh-stalled-body', headersThenBodyError(expiry), async (_ms: number) => {}, undefined, undefined, 50)
    expect(result.ok).toBe(false)
    // The same sentence the HEADER phase produces for the same deadline.
    expect(!result.ok && result.detail).toBe('dsh-stalled-body: the npm registry did not answer within 50ms')
  })

  it('refuses a packument that names a package other than the one requested', async () => {
    // Nothing compared the answered `doc.name` with the name we asked for,
    // and `name`, `version`, `integrity`, `publishedAt` and `publisher` are
    // then taken verbatim into plugins.json, manifest.lock, the committed
    // first-seen.yml and the published report. The integrity hash pins the
    // tarball a reader installs; it says nothing about which package that
    // tarball is filed under.
    const fetchImpl = (async () => new Response(JSON.stringify(packument), { status: 200 })) as unknown as typeof fetch
    const result = await fetchCandidate('dsh-hello-plugln', fetchImpl)
    expect(result.ok).toBe(false)
    expect(!result.ok && result.detail).toBe('dsh-hello-plugln: the registry answered with the packument for dsh-hello-plugin')
  })
})

describe('registry failover', () => {
  const noSleep = async (_ms: number) => {}
  const packument = { name: 'dsh-failover', 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': { dist: { integrity: 'sha512-x' }, license: 'MIT' } } }

  it('falls back to the backup registry when the primary throws, and uses the backup answer', async () => {
    const urls: string[] = []
    const fetchImpl = (async (url: string | URL) => {
      urls.push(String(url))
      if (String(url).startsWith('https://registry.npmjs.org')) throw new Error('UND_ERR_HEADERS_TIMEOUT')
      return new Response(JSON.stringify(packument), { status: 200 })
    }) as unknown as typeof fetch
    const result = await fetchCandidate('dsh-failover', fetchImpl, noSleep, undefined, 'https://registry.npmmirror.com')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.candidate.name).toBe('dsh-failover')
    expect(urls[0]).toContain('registry.npmjs.org')
    expect(urls[1]).toContain('registry.npmmirror.com')
  })

  it('falls back on a primary 5xx', async () => {
    let calls = 0
    const fetchImpl = (async (url: string | URL) => {
      calls += 1
      if (String(url).startsWith('https://registry.npmjs.org')) return new Response('bad gateway', { status: 502 })
      return new Response(JSON.stringify(packument), { status: 200 })
    }) as unknown as typeof fetch
    const result = await fetchCandidate('dsh-failover', fetchImpl, noSleep, undefined, 'https://registry.npmmirror.com')
    expect(result.ok).toBe(true)
    expect(calls).toBe(2)
  })

  it('falls back on a stalled primary — the timeout bounds the hang', async () => {
    let backupCalled = false
    const fetchImpl = (async (url: string | URL) => {
      if (String(url).startsWith('https://registry.npmjs.org')) return new Promise<Response>(() => {})
      backupCalled = true
      return new Response(JSON.stringify(packument), { status: 200 })
    }) as unknown as typeof fetch
    const result = await fetchCandidate('dsh-failover', fetchImpl, noSleep, undefined, 'https://registry.npmmirror.com', 50)
    expect(result.ok).toBe(true)
    expect(backupCalled).toBe(true)
  })

  it('never falls back on a 404 — the primary answer is authoritative', async () => {
    const fetchImpl = (async (url: string | URL) => {
      if (String(url).startsWith('https://registry.npmjs.org')) return new Response('not found', { status: 404 })
      throw new Error('backup must not be consulted for a 404')
    }) as unknown as typeof fetch
    const result = await fetchCandidate('dsh-missing', fetchImpl, noSleep, undefined, 'https://registry.npmmirror.com')
    expect(result.ok).toBe(false)
    expect(!result.ok && result.detail).toContain('404')
  })

  it('does not fall back on an exhausted 429', async () => {
    let backupCalls = 0
    const fetchImpl = (async (url: string | URL) => {
      if (String(url).startsWith('https://registry.npmjs.org')) return new Response('throttled', { status: 429 })
      backupCalls += 1
      return new Response('unexpected', { status: 500 })
    }) as unknown as typeof fetch
    const result = await fetchCandidate('dsh-throttled', fetchImpl, noSleep, undefined, 'https://registry.npmmirror.com')
    expect(result.ok).toBe(false)
    expect(!result.ok && result.detail).toContain('429')
    expect(backupCalls).toBe(0)
  })

  it('reports the primary failure in the detail when the backup also fails', async () => {
    // Changed with D-2: this asserted a THROW, which is what took the whole
    // harvest down on one dead packument. The primary's failure is still what
    // is reported — a mirror's opinion must never masquerade as npm's — but it
    // now arrives as the row CLAUDE.md requires instead of as an abort.
    const fetchImpl = (async (url: string | URL) => {
      if (String(url).startsWith('https://registry.npmjs.org')) throw new Error('primary down')
      return new Response('not found', { status: 404 })
    }) as unknown as typeof fetch
    const result = await fetchCandidate('dsh-failover', fetchImpl, noSleep, undefined, 'https://registry.npmmirror.com')
    expect(result.ok).toBe(false)
    expect(!result.ok && result.detail).toBe('dsh-failover: could not reach the npm registry (primary down)')
  })

  it('reports the primary cause, not the backup\'s own error, when the backup also throws', async () => {
    // The backup call inside fetchWithFailover used to be unwrapped: a
    // throwing backup escaped in place of primaryError, so a caller heard
    // the mirror's own failure instead of npm's — exactly what the function's
    // own doc comment forbids ("a mirror's opinion must never masquerade as
    // npm's"). A primary throw plus a throwing (or stalled) backup used to
    // surface the backup's own message; it must still surface the primary's.
    const fetchImpl = (async (url: string | URL) => {
      if (String(url).startsWith('https://registry.npmjs.org')) throw new Error('primary down')
      throw new Error('mirror down')
    }) as unknown as typeof fetch
    const result = await fetchCandidate('dsh-failover', fetchImpl, noSleep, undefined, 'https://registry.npmmirror.com')
    expect(result.ok).toBe(false)
    expect(!result.ok && result.detail).toBe('dsh-failover: could not reach the npm registry (primary down)')
  })

  it('reports the primary status, not a wrapped message, when a primary 5xx survives a failed backup', async () => {
    // The same 500 produced two different, self-contradicting details
    // depending on whether a backup was configured and also failed: no
    // backup (or a healthy backup) reports "npm registry returned 500
    // fetching x"; a backup that ALSO failed used to wrap that same fact as
    // "could not reach the npm registry (npm registry returned 500)" — a
    // second, invented-sounding cause for the identical failure.
    const fetchImpl = (async (url: string | URL) => {
      if (String(url).startsWith('https://registry.npmjs.org')) return new Response('bad gateway', { status: 500 })
      return new Response('also down', { status: 500 })
    }) as unknown as typeof fetch
    const result = await fetchCandidate('dsh-failover', fetchImpl, noSleep, undefined, 'https://registry.npmmirror.com')
    expect(result.ok).toBe(false)
    expect(!result.ok && result.detail).toBe('npm registry returned 500 fetching dsh-failover')
  })

  it('reports the throw as a rejection when no backup registry is configured', async () => {
    // Same change of shape, same reason: a rejection with a truthful cause,
    // not an abort. searchByKeywords still THROWS on a failed search — a
    // partial keyword list is indistinguishable from a shrunken ecosystem.
    const fetchImpl = (async () => { throw new Error('primary down') }) as unknown as typeof fetch
    const result = await fetchCandidate('dsh-failover', fetchImpl, noSleep)
    expect(result.ok).toBe(false)
    expect(!result.ok && result.detail).toBe('dsh-failover: could not reach the npm registry (primary down)')
  })

  it('searches through the failover too — an API the production callers must not use', async () => {
    // The parameter works, and this pins that it does. It is nonetheless
    // withheld at BOTH production call sites, and the scan lower in this file
    // is what enforces that: registry.npmmirror.com does not implement the
    // `keywords:` qualifier — measured 2026-09-03, it answers
    // `{"objects":[],"total":0}` for both harvest keywords — so failing the
    // search over to it publishes a zero-name harvest that the coverage floor
    // waves through at min(0, 0). Nothing about THIS test is wrong; a reader
    // reaching for the fourth argument because a test blesses it is, so the
    // reason lives here beside it rather than only at the call sites.
    const fetchImpl = (async (url: string | URL) => {
      if (String(url).startsWith('https://registry.npmjs.org')) throw new Error('primary down')
      return new Response(JSON.stringify({ total: 1, objects: [{ package: { name: 'dsh-from-backup' } }] }), { status: 200 })
    }) as unknown as typeof fetch
    const names = await searchByKeywords(fetchImpl, noSleep, undefined, 'https://registry.npmmirror.com')
    expect(names).toContain('dsh-from-backup')
  })

  it('never takes a candidate the BACKUP registry renamed', async () => {
    // This is the threat the cross-check exists for. The backup answers
    // whenever the primary throws, stalls or 5xxs, and NPM_BACKUP_REGISTRY is
    // any URL an operator sets — registry.npmmirror.com by default. A mirror
    // answering `/dsh-failover` with another package's document publishes
    // that package's version, integrity, publisher and publish date under the
    // name we asked for, into artifacts that are committed and pushed. The
    // integrity hash — the stated reason a mirror answer is interchangeable —
    // pins the tarball, not the name it is filed under.
    const fetchImpl = (async (url: string | URL) => {
      if (String(url).startsWith('https://registry.npmjs.org')) throw new Error('primary down')
      return new Response(JSON.stringify({ ...packument, name: 'dsh-something-else' }), { status: 200 })
    }) as unknown as typeof fetch
    const result = await fetchCandidate('dsh-failover', fetchImpl, noSleep, undefined, 'https://registry.npmmirror.com')
    expect(result.ok).toBe(false)
    expect(!result.ok && result.detail).toBe('dsh-failover: the registry answered with the packument for dsh-something-else')
  })

  it('never sends the npm token to the backup registry', async () => {
    // The token is an npmjs.org credential. Forwarding it to a third-party
    // mirror hands that mirror a Bearer token it was never issued; the fixture
    // recorded `registry.npmmirror.com auth=Bearer npm_...` going out.
    const seen: { url: string; auth: string | null }[] = []
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      seen.push({ url: String(url), auth: headers.get('authorization') })
      if (String(url).startsWith('https://registry.npmjs.org')) throw new Error('primary down')
      return new Response(JSON.stringify(packument), { status: 200 })
    }) as unknown as typeof fetch
    const result = await fetchCandidate(
      'dsh-failover', fetchImpl, noSleep, 'npm_readonly_token', 'https://registry.npmmirror.com',
    )
    expect(result.ok).toBe(true)
    expect(seen[0]?.auth).toBe('Bearer npm_readonly_token') // the primary gets it
    expect(seen[1]?.url).toContain('registry.npmmirror.com')
    expect(seen[1]?.auth).toBe(null) // the backup does not
  })

  it('treats an empty backup registry as disabled rather than building /name', async () => {
    // The documented disable value is an empty string, but the guard tested
    // for `undefined`: registryUrl('', 'x') is '/x', and the first primary
    // failure died with `Failed to parse URL` instead of reporting the
    // primary's own failure.
    const urls: string[] = []
    const fetchImpl = (async (url: string | URL) => {
      urls.push(String(url))
      throw new Error('primary down')
    }) as unknown as typeof fetch
    const result = await fetchCandidate('dsh-failover', fetchImpl, noSleep, undefined, '')
    expect(result.ok).toBe(false)
    expect(!result.ok && result.detail).toBe('dsh-failover: could not reach the npm registry (primary down)')
    expect(urls).toEqual(['https://registry.npmjs.org/dsh-failover'])
  })

  it('treats a whitespace-only backup registry as disabled too', async () => {
    // Same guard, the other shape an operator might actually type: a stray
    // space left behind by NPM_BACKUP_REGISTRY='' under a shell that quotes
    // it loosely. `backupRegistry.trim() === ''` catches '   ' exactly like
    // the empty string above — neither builds a backup URL.
    const urls: string[] = []
    const fetchImpl = (async (url: string | URL) => {
      urls.push(String(url))
      throw new Error('primary down')
    }) as unknown as typeof fetch
    const result = await fetchCandidate('dsh-failover', fetchImpl, noSleep, undefined, '   ')
    expect(result.ok).toBe(false)
    expect(!result.ok && result.detail).toBe('dsh-failover: could not reach the npm registry (primary down)')
    expect(urls).toEqual(['https://registry.npmjs.org/dsh-failover'])
  })
})

describe('fetchCandidates', () => {
  const noSleep = async (_ms: number) => {}
  const packument = {
    name: 'good',
    'dist-tags': { latest: '1.0.0' },
    time: { '1.0.0': '2026-08-01T12:00:00.000Z' },
    versions: { '1.0.0': { dist: { integrity: 'sha512-x' }, license: 'MIT' } },
  }

  it('records a 500 as a fetch-failed row and still returns the other candidates', async () => {
    // H-2: no test ever called fetchCandidates, so mislabelling the code and
    // dropping the rejection entirely both survived the suite. The list is
    // longer than HARVEST_CONCURRENCY and the bad name sits in the MIDDLE of
    // it, so good names are in flight both before and after the failure — the
    // claim round 3's comment made about a fixture that ended on the bad name
    // and could not support it. A worker that stops claiming after a
    // rejection, or an index claimed twice, shows up here as a short or
    // duplicated candidate list.
    const goodNames = Array.from({ length: HARVEST_CONCURRENCY }, (_, i) => `good-${i}`)
    const names = [...goodNames.slice(0, 4), 'bad', ...goodNames.slice(4)]
    const fetchImpl = (async (url: string | URL) => {
      if (String(url).endsWith('/bad')) return new Response('server error', { status: 500 })
      const name = decodeURIComponent(String(url).split('/').pop() ?? '')
      return new Response(JSON.stringify({ ...packument, name }), { status: 200 })
    }) as unknown as typeof fetch
    const { candidates, rejections } = await fetchCandidates(names, fetchImpl, undefined, undefined, noSleep)
    // Unsorted: the pool completes in whatever order the network answers, and
    // the result is collected by INPUT index so that harvest.json does not
    // churn on a reordering nobody chose.
    expect(candidates.map(c => c.name)).toEqual(goodNames)
    expect(rejections).toEqual([
      { name: 'bad', code: 'fetch-failed', detail: 'npm registry returned 500 fetching bad' },
    ])
  })

  it('records a network throw as a fetch-failed row naming the cause', async () => {
    // D-2: Promise.all over a throwing fetchCandidate rejected the whole
    // harvest of ~5,600 packuments on one ECONNRESET.
    const fetchImpl = (async (url: string | URL) => {
      if (String(url).endsWith('/bad')) throw new Error('read ECONNRESET')
      return new Response(JSON.stringify(packument), { status: 200 })
    }) as unknown as typeof fetch
    const { candidates, rejections } = await fetchCandidates(['good', 'bad'], fetchImpl, undefined, undefined, noSleep)
    expect(candidates.map(c => c.name)).toEqual(['good'])
    expect(rejections).toHaveLength(1)
    expect(rejections[0]?.code).toBe('fetch-failed')
    expect(rejections[0]?.detail).toBe('bad: could not reach the npm registry (read ECONNRESET)')
  })

  it('records a stalled connection as a fetch-failed row naming the timeout', async () => {
    const fetchImpl = (async (url: string | URL) => {
      if (String(url).endsWith('/bad')) return new Promise<Response>(() => {})
      return new Response(JSON.stringify(packument), { status: 200 })
    }) as unknown as typeof fetch
    const { candidates, rejections } = await fetchCandidates(['good', 'bad'], fetchImpl, undefined, undefined, noSleep, 50)
    expect(candidates.map(c => c.name)).toEqual(['good'])
    expect(rejections).toHaveLength(1)
    expect(rejections[0]?.detail).toBe('bad: the npm registry did not answer within 50ms')
  })

  it('fetches through the backup registry when one is configured', async () => {
    const urls: string[] = []
    const fetchImpl = (async (url: string | URL) => {
      urls.push(String(url))
      if (String(url).startsWith('https://registry.npmjs.org')) throw new Error('primary down')
      return new Response(JSON.stringify(packument), { status: 200 })
    }) as unknown as typeof fetch
    const { candidates, rejections } = await fetchCandidates(
      ['good'], fetchImpl, undefined, 'https://registry.npmmirror.com', noSleep,
    )
    expect(candidates.map(c => c.name)).toEqual(['good'])
    expect(rejections).toEqual([])
    expect(urls[1]).toContain('registry.npmmirror.com')
  })

  it('records a null packument body as a fetch-failed row and still returns the rest of the batch', async () => {
    // A-1: `null` is legal JSON, response.json() returns it without throwing,
    // and toCandidate then read `doc.name` off it. The TypeError escaped
    // fetchCandidate entirely, rejected this Promise.all, and — with no outer
    // catch in build.ts or classify.ts — ended the daily catalog on one
    // packument. The list is longer than HARVEST_CONCURRENCY and the bad name
    // sits in the middle of it, so the good names really are on both sides of
    // it while the pool is running.
    const goodNames = Array.from({ length: HARVEST_CONCURRENCY }, (_, i) => `good-${i}`)
    const names = [...goodNames.slice(0, 4), 'bad', ...goodNames.slice(4)]
    const fetchImpl = (async (url: string | URL) => {
      if (String(url).endsWith('/bad')) return new Response('null', { status: 200 })
      const name = decodeURIComponent(String(url).split('/').pop() ?? '')
      return new Response(JSON.stringify({ ...packument, name }), { status: 200 })
    }) as unknown as typeof fetch
    const { candidates, rejections } = await fetchCandidates(names, fetchImpl, undefined, undefined, noSleep)
    expect(candidates.map(c => c.name)).toEqual(goodNames)
    expect(rejections).toEqual([
      { name: 'bad', code: 'fetch-failed', detail: 'bad: packument names no usable latest version' },
    ])
  })

  it('keeps every slot working while one name stalls, instead of idling behind a batch barrier', async () => {
    // Round 3 awaited Promise.all over each slice of HARVEST_CONCURRENCY, so
    // every batch cost its SLOWEST member: one packument stalling for the
    // full 30s deadline idled the other seven slots for those 30 seconds,
    // ~5,650 names deep. Here `n0` never answers until this test releases it,
    // and every other name must still have been requested — under a batch
    // barrier exactly HARVEST_CONCURRENCY of them ever start.
    const names = Array.from({ length: HARVEST_CONCURRENCY * 2 }, (_, i) => `n${i}`)
    let release = (): void => {}
    const stall = new Promise<void>(resolve => { release = resolve })
    const started: string[] = []
    const fetchImpl = (async (url: string | URL) => {
      const name = decodeURIComponent(String(url).split('/').pop() ?? '')
      started.push(name)
      if (name === 'n0') await stall
      return new Response(JSON.stringify({ ...packument, name }), { status: 200 })
    }) as unknown as typeof fetch

    const running = fetchCandidates(names, fetchImpl, undefined, undefined, noSleep)
    // Let the pool run itself dry against the one name that never answers.
    for (let turn = 0; turn < 100; turn += 1) await new Promise(resolve => setTimeout(resolve, 0))
    expect(started.sort()).toEqual([...names].sort())

    release()
    const { candidates, rejections } = await running
    expect(rejections).toEqual([])
    // n0 finishes LAST and is still first in the output: the results are
    // collected by input index, not by completion.
    expect(candidates.map(c => c.name)).toEqual(names)
  })
})

describe('withTimeout', () => {
  /** A socket that accepts and never writes: the shape neither undici's
   * defaults nor any retry ladder bounds usefully. */
  const stalled = (async () => new Promise<Response>(() => {})) as unknown as typeof fetch

  it('rejects a request that outlives the deadline, naming the stalled counterpart', async () => {
    await expect(withTimeout(stalled, 20, 'github')('https://example.invalid/x'))
      .rejects.toBeInstanceOf(FetchTimeoutError)
    await expect(withTimeout(stalled, 20, 'github')('https://example.invalid/x'))
      .rejects.toThrow('github request exceeded 20ms')
  })

  it('defaults the subject to the registry, so every existing call site keeps its message', async () => {
    // fetchCandidate turns this rejection into "the npm registry did not
    // answer within Nms"; a subject that changed under it would republish a
    // wrong reason on an author's package.
    await expect(withTimeout(stalled, 20)('https://example.invalid/x'))
      .rejects.toThrow('registry request exceeded 20ms')
  })

  it('does not fire early: a response that arrives inside the deadline is returned untouched', async () => {
    // The other side of the bound. A wrapper that aborts too eagerly — a zero,
    // a seconds/milliseconds mix-up, a timer started before the deadline is
    // read — passes every stall test above and then kills every slow but
    // healthy request in production, which is the failure this whole task is
    // meant to prevent, inverted.
    //
    // Both numbers are literals rather than fractions of the deadline: a
    // fixture computed from the constant it tests can never detect that
    // constant moving.
    // The margin is deliberately UNDER 10x. At the 50x it started with, the
    // test could not see the very unit error it is named after: `ms / 10`
    // survived green across the whole suite, and in production that is GitHub
    // at 3s and the gateway at 12s. 8x still fails deterministically under
    // `ms / 10` (a 50ms deadline against a 50ms body) because both are timers
    // and the shorter one is queued first — it is timer ordering, not a
    // wall-clock race, so load delays both equally.
    const SLOW_MS = 50
    const DEADLINE_MS = 400
    const slow = (async () => {
      await new Promise(resolve => setTimeout(resolve, SLOW_MS))
      return new Response('a slow but healthy answer', { status: 200 })
    }) as unknown as typeof fetch
    const response = await withTimeout(slow, DEADLINE_MS, 'registry')('https://example.invalid/x')
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('a slow but healthy answer')
  })

  it('bounds the BODY, not only the headers', async () => {
    // `fetch` resolves when the HEADERS arrive. A deadline cleared at that
    // moment bounds nothing that follows, and this module newly routes the
    // largest body read in the repo — a 32 MB release tarball — through here.
    // Measured against a real localhost socket that answered 200 and then
    // stalled its body: armed, the read threw at 153ms; cleared, the same read
    // was still hanging at 1206ms. undici's bodyTimeout is inactivity-based,
    // so a slow trickle never trips it either.
    const started = Date.now()
    const response = await withTimeout(headersThenStalledBody(), 60, 'github')('https://example.invalid/x')
    expect(response.status).toBe(200)
    await expect(response.text()).rejects.toBeInstanceOf(FetchTimeoutError)
    await expect(withTimeout(headersThenStalledBody(), 60, 'github')('https://example.invalid/x')
      .then(async r => r.text())).rejects.toThrow('github request exceeded 60ms')
    expect(Date.now() - started).toBeLessThan(5000)
  })

  it('does not fire early on a body that arrives, slowly, inside the deadline', async () => {
    // The other side of the body bound, and the reason the tarball path needs
    // a deadline of its own: a large body is slow by nature, and killing a
    // healthy one is the same defect as never bounding a stalled one.
    const CHUNKS = 5
    const GAP_MS = 10
    const DEADLINE_MS = 400
    const response = await withTimeout(headersThenSlowBody(CHUNKS, GAP_MS), DEADLINE_MS, 'github')('https://example.invalid/x')
    const body = new Uint8Array(await response.arrayBuffer())
    expect(body.byteLength).toBe(CHUNKS * 1024)
  })

  it('passes an abort signal through to the implementation', async () => {
    // The rejection alone would satisfy the tests above while leaving the real
    // socket open for undici's 300s default; the signal is what actually ends
    // the request.
    let signal: AbortSignal | undefined
    const capture = (async (_input: string, init?: RequestInit) => {
      signal = init?.signal ?? undefined
      return new Response('ok', { status: 200 })
    }) as unknown as typeof fetch
    await withTimeout(capture, 2000, 'registry')('https://example.invalid/x')
    expect(signal).toBeInstanceOf(AbortSignal)
    expect(signal?.aborted).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// The deadline is a property of EVERY network module, not of this one.
//
// npm-client was for a long time the only module that passed an AbortSignal.
// Against a socket that accepts and never writes it rejected after 2s while
// github-client was still pending at 8s: the only bound anywhere else was
// undici's 300s headers timeout, multiplied by each client's own retry ladder.
// The fix wraps three more clients — and the third one added is exactly the
// one a future change forgets, so this reads the sources instead of trusting
// a list somebody has to remember to extend.
//
// Three separate ways past this scan have already been identified and closed:
// a module that types its seam structurally rather than as `typeof fetch`; a
// module whose only mention of `withTimeout(` is the comment explaining it;
// and — the realistic one — a module that builds the wrapper, keeps it in a
// const, and then calls the RAW seam anyway, which satisfies a
// does-it-mention-withTimeout check, compiles clean (there is no
// `noUnusedLocals`), and is bounded by nothing at all.
// ---------------------------------------------------------------------------

const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')

interface SourceLine {
  readonly text: string
  readonly lineNumber: number
}

/** The lines of a module that are CODE. A line whose trimmed form opens with a
 * comment marker is prose, and prose about a deadline is not a deadline. */
function codeLines(source: string): SourceLine[] {
  return source.split('\n')
    .map((line, index) => ({ text: line.trim(), lineNumber: index + 1 }))
    .filter(({ text }) => !(text.startsWith('*') || text.startsWith('//') || text.startsWith('/*')))
}

/**
 * The marks an injectable fetch seam leaves, any one of which makes a module a
 * network module. `typeof fetch` alone was too narrow: a module declaring
 * `type FetchLike = (input: string, init?: RequestInit) => Promise<Response>`
 * never entered the scan, though it is every bit as injectable, as testable,
 * and as able to hang the build for six hours.
 */
const SEAM_MARKERS: readonly RegExp[] = [
  /typeof fetch/,
  /Promise<\s*Response\s*>/,
  /\bRequestInit\b/,
  /(?<![.\w])fetch\s*\(/,
]

function networkModules(): { file: string; source: string }[] {
  return readdirSync(srcDir)
    .filter(file => file.endsWith('.ts'))
    .sort()
    .map(file => ({ file, source: readFileSync(join(srcDir, file), 'utf8') }))
    .filter(({ source }) => codeLines(source).some(line => SEAM_MARKERS.some(marker => marker.test(line.text))))
}

/** Where the raw, unwrapped seam is invoked. Only npm-client may: it owns
 * `withTimeout` and `fetchWithRetry`, the two primitives that necessarily call
 * the impl they were handed. Everywhere else the wrapped value is the only
 * thing that may be called, which is what makes this detectable at all. */
function rawSeamInvocations(source: string): SourceLine[] {
  return codeLines(source).filter(line =>
    /\bfetchImpl\s*\(/.test(line.text) || /(?<![.\w])fetch\s*\(/.test(line.text))
}

describe('every network module bounds its requests with withTimeout', () => {
  it('finds the network modules at all, so the scan cannot pass by matching nothing', () => {
    const files = networkModules().map(m => m.file)
    expect(files).toContain('npm-client.ts')
    expect(files).toContain('github-client.ts')
    expect(files).toContain('llm-client.ts')
    expect(files).toContain('github-stars.ts')
  })

  it('detects a raw invocation at all, so the prohibition below cannot pass by matching nothing', () => {
    // npm-client is the one module that legitimately invokes the impl handed
    // to it, so it doubles as the detector's own positive control: if this
    // stops finding anything, the check below is guarding an empty list.
    const npmClient = networkModules().find(m => m.file === 'npm-client.ts')
    expect(npmClient?.source).toBeDefined()
    expect(rawSeamInvocations(npmClient?.source ?? '').length).toBeGreaterThan(0)
  })

  it('routes each of them through this module’s withTimeout, in code and not in a comment', () => {
    for (const { file, source } of networkModules()) {
      if (file === 'npm-client.ts') {
        expect(
          codeLines(source).some(line => /export function withTimeout\(/.test(line.text)),
          'npm-client.ts owns withTimeout and must keep exporting it: the other three network '
            + 'modules import their deadline from here rather than each growing a copy.',
        ).toBe(true)
        continue
      }
      expect(
        codeLines(source).some(line => /withTimeout\s*\(/.test(line.text)) && source.includes("'./npm-client.ts'"),
        `${file} accepts an injected fetch — it reaches the network — but never calls `
          + "npm-client's withTimeout in code. An unwrapped client falls back on undici's 300s "
          + 'headers timeout, multiplied by its own retry ladder, and a stalled counterpart then '
          + "runs to the build job's outer kill with no report and no state commit.",
      ).toBe(true)
    }
  })

  it('never invokes the raw seam, so a wrapper that is built and then bypassed cannot pass', () => {
    for (const { file, source } of networkModules()) {
      if (file === 'npm-client.ts') continue
      for (const line of rawSeamInvocations(source)) {
        expect(
          false,
          `${file}:${line.lineNumber} calls the RAW injected fetch. Only the value returned by `
            + 'withTimeout may be invoked — building the wrapper and then calling `fetchImpl` '
            + 'anyway leaves the request bounded by nothing, and passes every other check in '
            + `this file. Line: ${line.text}`,
        ).toBe(true)
      }
    }
  })
})

// ---------------------------------------------------------------------------
// The backup registry reaches the PACKUMENT fetch and NEVER the paged search.
//
// registry.npmmirror.com does not implement the `keywords:` qualifier the
// harvest depends on: measured 2026-09-03, it answers
// `{"objects":[],"total":0}` for both harvest keywords while answering
// `total=10000` for `text=react`. A numeric zero is not an error, so nothing
// upstream refuses it — `searchTotal` returns 0, the keyword reports
// unpartitioned, the empty first page breaks the cell, and the coverage floor
// becomes `min(0, 0) = 0`, which passes. A stalled or 5xx npmjs search would
// therefore publish a ZERO-NAME npm harvest with a green build, and
// classify.ts:155 prunes categories.yml by the live names — roughly nine
// thousand deleted category rows, committed and pushed by the classifier
// step.
//
// Both production callers withhold the argument, each with a long comment
// saying why. A comment is not a guard: adding the argument back to either
// call site compiles, typechecks, and passed all 500 tests in this repo.
// npm-client.test.ts also has a module-level test asserting that the search
// DOES fail over, because the API still supports it — so the rule cannot live
// in the module's own behaviour and has to be read off the call sites.
// ---------------------------------------------------------------------------

/** `source` with every comment-only line blanked and the line numbering
 * preserved, so a call site can be located but prose ABOUT a call site cannot
 * be mistaken for one. Same definition of prose as {@link codeLines}. */
function withoutCommentLines(source: string): string {
  return source.split('\n')
    .map(line => (/^\s*(?:\/\/|\/\*|\*)/.test(line) ? '' : line))
    .join('\n')
}

interface SearchCall {
  readonly args: string[]
  readonly lineNumber: number
}

/** Every `searchByKeywords(…)` call in `source`, with its arguments split at
 * top-level commas. Hand-scanned rather than matched: the argument list is
 * variable-length and may nest parentheses or carry a string, and a regex
 * capture group keeps only its last repetition. */
function searchCalls(source: string): SearchCall[] {
  const scanned = withoutCommentLines(source)
  const needle = 'searchByKeywords('
  const calls: SearchCall[] = []
  let searchFrom = 0
  for (;;) {
    const start = scanned.indexOf(needle, searchFrom)
    if (start === -1) break
    searchFrom = start + needle.length
    // The declaration is not a call site: `export async function
    // searchByKeywords(` opens the same parenthesis, and its parameter list
    // names `backupRegistry` by definition. Skipping it here rather than
    // excluding npm-client.ts by name keeps the caller set derived — if the
    // search ever moves to another module, that module is still scanned.
    if (/\bfunction\s+$/.test(scanned.slice(Math.max(0, start - 32), start))) continue
    const args: string[] = []
    let current = ''
    let depth = 1
    let quote = ''
    let cursor = searchFrom
    while (cursor < scanned.length && depth > 0) {
      const ch = scanned.charAt(cursor)
      if (quote !== '') {
        if (ch === '\\') { current += scanned.slice(cursor, cursor + 2); cursor += 2; continue }
        if (ch === quote) quote = ''
        current += ch
        cursor += 1
        continue
      }
      if (ch === "'" || ch === '"' || ch === '`') { quote = ch }
      else if (ch === '(' || ch === '[' || ch === '{') { depth += 1 }
      else if (ch === ')' || ch === ']' || ch === '}') {
        depth -= 1
        if (depth === 0) { cursor += 1; break }
      }
      else if (ch === ',' && depth === 1) { args.push(current.trim()); current = ''; cursor += 1; continue }
      current += ch
      cursor += 1
    }
    if (current.trim() !== '') args.push(current.trim())
    calls.push({ args, lineNumber: scanned.slice(0, start).split('\n').length })
  }
  return calls
}

/** The zero-based position of `backupRegistry` in `searchByKeywords`'s
 * parameter list — `(fetchImpl, sleep, token, backupRegistry, timeoutMs)`.
 * The slot, not the arity, is what the rule is about: a call overriding
 * `timeoutMs` must still be able to pass this one as `undefined`. */
const BACKUP_ARGUMENT_INDEX = 3

/** The modules that call the paged search in production. Derived from the
 * sources, so a THIRD caller added later is checked without anyone
 * remembering to extend a list. */
function searchCallers(): { file: string; calls: SearchCall[] }[] {
  return readdirSync(srcDir)
    .filter(file => file.endsWith('.ts'))
    .sort()
    .map(file => ({ file, calls: searchCalls(readFileSync(join(srcDir, file), 'utf8')) }))
    .filter(({ calls }) => calls.length > 0)
}

describe('no production caller hands the paged search a backup registry', () => {
  it('finds the callers at all, so the rule below cannot pass by matching nothing', () => {
    const files = searchCallers().map(c => c.file)
    expect(files).toContain('build.ts')
    expect(files).toContain('classify.ts')
  })

  it('reads the argument list far enough to see a fourth argument, so the rule cannot pass by parsing nothing', () => {
    // The realistic way past a scan like this is a parser that stops early
    // and reports three arguments for a five-argument call. This is the
    // detector's own positive control: the exact mutation the rule exists to
    // catch, in a synthetic source, must be visible as argument 4.
    const mutated = 'const names = await searchByKeywords(fetch, undefined, npmToken, npmBackupRegistry)\n'
    const [call] = searchCalls(mutated)
    expect(call?.args).toEqual(['fetch', 'undefined', 'npmToken', 'npmBackupRegistry'])
    expect(call?.args[BACKUP_ARGUMENT_INDEX]).not.toBe('undefined')
    // …and prose about a call site is not a call site.
    expect(searchCalls('// searchByKeywords(fetch, undefined, npmToken, npmBackupRegistry)\n')).toEqual([])
    // …nor is the declaration, whose parameter list names backupRegistry by
    // definition. This skip is the one that could swallow a real call, so it
    // is pinned in both directions: the declaration is dropped, and a call on
    // the very next line of the same source is still found.
    const declared = 'export async function searchByKeywords(\n  backupRegistry: string | undefined = undefined,\n) {}\n'
    expect(searchCalls(declared)).toEqual([])
    expect(searchCalls(`${declared}await searchByKeywords(fetch)\n`).map(c => c.args)).toEqual([['fetch']])
  })

  it('withholds the backup argument at every production call site', () => {
    for (const { file, calls } of searchCallers()) {
      for (const call of calls) {
        const passed = call.args[BACKUP_ARGUMENT_INDEX]
        expect(
          passed === undefined || passed === 'undefined',
          `${file}:${call.lineNumber} passes \`${passed}\` as searchByKeywords' backup registry. `
            + 'registry.npmmirror.com does not implement the `keywords:` qualifier this search '
            + 'depends on — it answers {"objects":[],"total":0} for both harvest keywords — and a '
            + 'numeric zero total is not an error: the coverage floor becomes min(0, 0) = 0 and '
            + 'passes, so a stalled or 5xx npmjs search publishes a ZERO-NAME harvest with a green '
            + 'build, and the classifier then prunes ~9,000 category rows against that empty name '
            + 'list. The backup belongs on the PACKUMENT fetch (fetchCandidates), where a mirror '
            + 'answer is interchangeable because the integrity hash pins it.',
        ).toBe(true)
      }
    }
  })
})

describe('a deadline is never relabelled as a malformed body', () => {
  it('says the npm search stalled, not that npm sent something that is not JSON', async () => {
    // The twin of github-client's search reader, and the same fix: this module
    // is where the deadline is built, so a wrong reason here is the one an
    // operator is least likely to doubt.
    const expiry = new FetchTimeoutError('registry request exceeded 30000ms')
    const fetchImpl = headersThenBodyError(expiry)
    await expect(searchByKeywords(fetchImpl, async (_ms: number) => {}, undefined, undefined, 50))
      .rejects.toThrow('exceeded 30000ms')
    await expect(searchByKeywords(fetchImpl, async (_ms: number) => {}, undefined, undefined, 50))
      .rejects.not.toThrow('not JSON')
  })
})

describe('body bounds', () => {
  const sleep = async (_ms: number) => {}
  // The github half caps every body it reads (MAX_TARBALL_BYTES,
  // MAX_MANIFEST_BYTES); the npm half capped nothing. `response.json()`
  // buffers whatever the origin sends before any of our code sees a byte, and
  // the origin is not always npm: fetchWithFailover serves a
  // NPM_BACKUP_REGISTRY answer — registry.npmmirror.com by default — whenever
  // the primary throws, stalls or 5xxs, and a run fetches one packument per
  // harvested name.
  const packument = {
    name: 'dsh-hello-plugin',
    'dist-tags': { latest: '1.2.0' },
    time: { '1.2.0': '2026-08-01T12:00:00.000Z' },
    versions: { '1.2.0': { dist: { integrity: 'sha512-hello' }, license: 'MIT', repository: 'https://github.com/o/r', dsh: { bundle: {} } } },
  }

  it('refuses a search page whose content-length exceeds the cap, before reading the body', async () => {
    let requested = false
    const fetchImpl = (async () => {
      requested = true
      return new Response('{"objects":[],"total":0}', {
        status: 200,
        headers: { 'content-length': String(MAX_SEARCH_BODY_BYTES + 1) },
      })
    }) as unknown as typeof fetch
    await expect(searchByKeywords(fetchImpl, sleep)).rejects.toThrow(new RegExp(String(MAX_SEARCH_BODY_BYTES)))
    expect(requested).toBe(true) // the request happened; the BODY did not
  })

  it('refuses a streamed search page that exceeds the cap mid-download', async () => {
    // No content-length, so only the count taken off the bytes as they arrive
    // can stop it — the same reason github's reader measures the stream rather
    // than trusting the header. The stream never ends on its own: without the
    // cap this test hangs instead of failing.
    const chunk = new Uint8Array(1024 * 1024)
    const fetchImpl = (async () => new Response(new ReadableStream({
      pull(controller) { controller.enqueue(chunk) },
    }), { status: 200 })) as unknown as typeof fetch
    await expect(searchByKeywords(fetchImpl, sleep)).rejects.toThrow(new RegExp(String(MAX_SEARCH_BODY_BYTES)))
  })

  it('turns an over-cap packument into a rejection naming the package, not a crash', async () => {
    // Asymmetric with the search on purpose: a packument the build cannot read
    // is one package, and nothing disappears without a reason attached to its
    // name. A search page that cannot be read is the whole candidate set.
    const fetchImpl = (async () => new Response(JSON.stringify(packument), {
      status: 200,
      headers: { 'content-length': String(MAX_PACKUMENT_BYTES + 1) },
    })) as unknown as typeof fetch
    const result = await fetchCandidate('dsh-enormous', fetchImpl, sleep)
    expect(result.ok).toBe(false)
    expect(!result.ok && result.detail).toContain('dsh-enormous')
    expect(!result.ok && result.detail).toContain(String(MAX_PACKUMENT_BYTES))
  })

  it('still reads a packument under the cap', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify(packument), { status: 200 })) as unknown as typeof fetch
    const result = await fetchCandidate('dsh-hello-plugin', fetchImpl, sleep)
    expect(result.ok).toBe(true)
    expect(result.ok && result.candidate.version).toBe('1.2.0')
  })

  it('caps a search page below a packument, and a packument below a tarball', () => {
    // The relationship is the justification: a search page carries size=250
    // objects of registry metadata (~500 KB live), a packument may legitimately
    // be large, and neither may approach the 32 MB a tarball is allowed.
    expect(MAX_SEARCH_BODY_BYTES).toBeLessThan(MAX_PACKUMENT_BYTES)
    expect(MAX_SEARCH_BODY_BYTES).toBe(8 * 1024 * 1024)
    expect(MAX_PACKUMENT_BYTES).toBe(16 * 1024 * 1024)
    expect(MAX_PACKUMENT_BYTES).toBeLessThan(MAX_TARBALL_BYTES)
  })
})
