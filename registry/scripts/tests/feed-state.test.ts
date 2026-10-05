import { describe, expect, it } from 'vitest'
import {
  applyFeedReads, bootstrapFeedState, carrierCounts, classifyManifest, describeFeedCoverage, describeFeedRun,
  FEED_BOOTSTRAP_SEQ, FEED_NAME_PATTERN, FEED_PACKAGE_NAME_MAX_LENGTH, feedCarriersByKeyword, isDeprecated,
  isFeedPackageName, parseFeedCoverage, parseFeedPage, parseFeedRunReport, parseFeedState, planFeedVerification,
  selectFeedIds, serializeFeedState, type FeedCoverage, type FeedRow, type FeedRunReport, type FeedState,
} from '../src/feed-state.ts'

const KEYWORDS: readonly string[] = ['dsh-plugin', 'deepseek-harness']

describe('classifyManifest', () => {
  const manifest = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    name: 'dsh-x', keywords: ['dsh-plugin'], maintainers: [{ name: 'alice' }], ...overrides,
  })

  it('admits a manifest that lists a harvest keyword exactly', () => {
    expect(classifyManifest('dsh-x', manifest(), KEYWORDS)).toEqual({
      kind: 'carrier', name: 'dsh-x', carrier: { owner: 'alice', keywords: ['dsh-plugin'] },
    })
  })

  it('records every harvest keyword it lists, sorted by code unit', () => {
    const read = classifyManifest('dsh-x', manifest({ keywords: ['dsh-plugin', 'tool', 'deepseek-harness'] }), KEYWORDS)
    expect(read).toMatchObject({ kind: 'carrier', carrier: { keywords: ['deepseek-harness', 'dsh-plugin'] } })
  })

  it('refuses a keyword that matches only case-insensitively, as npm search does', () => {
    // 0 of 7,002 packuments matched only this way (spec section 2); the
    // index compares exactly, so crediting one would cancel a missing name.
    expect(classifyManifest('dsh-x', manifest({ keywords: ['DSH-Plugin'] }), KEYWORDS))
      .toEqual({ kind: 'not-carrier', name: 'dsh-x' })
  })

  it.each([true, 'Folded into dsh-y.'])('refuses a deprecated manifest (deprecated: %j)', (deprecated) => {
    expect(classifyManifest('dsh-x', manifest({ deprecated }), KEYWORDS)).toEqual({ kind: 'not-carrier', name: 'dsh-x' })
  })

  it.each([false, '', '   ', undefined])('keeps a manifest that is not deprecated (deprecated: %j)', (deprecated) => {
    expect(classifyManifest('dsh-x', manifest({ deprecated }), KEYWORDS).kind).toBe('carrier')
  })

  it('reads a keywords string as no keywords, never as a throw', () => {
    // Review Focus 3.
    expect(classifyManifest('dsh-x', manifest({ keywords: 'dsh-plugin, tool' }), KEYWORDS))
      .toEqual({ kind: 'not-carrier', name: 'dsh-x' })
  })

  it('ignores keyword entries that are not strings', () => {
    expect(classifyManifest('dsh-x', manifest({ keywords: [null, 7, { k: 1 }, 'dsh-plugin'] }), KEYWORDS).kind)
      .toBe('carrier')
  })

  it('reports a manifest for another package as failed, so the name is read again next run', () => {
    expect(classifyManifest('dsh-x', manifest({ name: 'dsh-y' }), KEYWORDS)).toMatchObject({ kind: 'failed', name: 'dsh-x' })
  })

  it('reports a body naming no package as failed: it is not a manifest, so it says nothing about the package', () => {
    // npm serializes every manifest with its name. A body without one is an
    // edge or a cache answering in npm's place, and CLAUDE.md's line holds:
    // dropping a name means the manifest was read, never that a request failed.
    expect(classifyManifest('dsh-x', manifest({ name: undefined }), KEYWORDS)).toMatchObject({ kind: 'failed', name: 'dsh-x' })
  })

  // Each row wrapped in its own array: vitest spreads an inner array into
  // arguments, so a bare ['dsh-plugin'] row would test the string instead.
  it.each([[null], ['text'], [42], [['dsh-plugin']]])('reports a body that is not an object (%j) as failed, not as a non-carrier', (body) => {
    expect(classifyManifest('dsh-x', body, KEYWORDS)).toMatchObject({ kind: 'failed', name: 'dsh-x' })
  })

  it('takes the code-unit-smallest maintainer username as owner, never _npmUser', () => {
    const read = classifyManifest('dsh-x', manifest({
      maintainers: [{ name: 'zed' }, { name: 'bob' }], _npmUser: { name: 'GitHub Actions' },
    }), KEYWORDS)
    expect(read).toMatchObject({ carrier: { owner: 'bob' } })
  })

  it('stores a null owner when no maintainer name passes the username grammar', () => {
    const read = classifyManifest('dsh-x', manifest({ maintainers: [{ name: 'Bob Smith' }, 'alice', null] }), KEYWORDS)
    expect(read).toMatchObject({ kind: 'carrier', carrier: { owner: null } })
  })
})

describe('isDeprecated', () => {
  it.each([
    [true, true], ['Use dsh-y.', true], ['', false], ['  ', false], [false, false], [undefined, false], [1, false],
  ])('reads %j as deprecated: %s', (value, expected) => {
    expect(isDeprecated(value)).toBe(expected)
  })
})

describe('isFeedPackageName', () => {
  it.each(['dsh-recheck', '@pbfuzz/dsh-kanalyzer', 'a', 'x'.repeat(FEED_PACKAGE_NAME_MAX_LENGTH)])('accepts %s', (name) => {
    expect(isFeedPackageName(name)).toBe(true)
  })

  it.each([
    '', 'DSH-Thing', '_hidden', '.dot', '@scope', '@/x', 'a b', 'x'.repeat(FEED_PACKAGE_NAME_MAX_LENGTH + 1), '__proto__', 7,
  ])('refuses %j', (name) => {
    expect(isFeedPackageName(name)).toBe(false)
  })
})

describe('FEED_NAME_PATTERN', () => {
  it.each(['dsh-recheck', '@d0nj/dsh-web-search-multi', 'my-DeepSeek-tool', 'cordis-plugin-x', 'spreadsheet-utils'])(
    'matches %s', (id) => {
      expect(FEED_NAME_PATTERN.test(id)).toBe(true)
    },
  )

  it.each(['probe-kit', 'billion-context-relief', 'react'])('does not match %s', (id) => {
    expect(FEED_NAME_PATTERN.test(id)).toBe(false)
  })

  it('carries no g flag, so test() keeps no state between calls', () => {
    expect(FEED_NAME_PATTERN.flags).not.toContain('g')
    expect([FEED_NAME_PATTERN.test('dsh-a'), FEED_NAME_PATTERN.test('dsh-a')]).toEqual([true, true])
  })
})

describe('the state file', () => {
  const state: FeedState = {
    seq: 134466916,
    carriers: new Map([
      ['dsh-recheck', { owner: 'f1refly', keywords: ['deepseek-harness', 'dsh-plugin'] }],
      ['@pbfuzz/dsh-kanalyzer', { owner: null, keywords: ['dsh-plugin'] }],
    ]),
    pending: ['dsh-b', 'dsh-a'],
  }
  const text = [
    '{',
    '  "seq": 134466916,',
    '  "carriers": {',
    '    "@pbfuzz/dsh-kanalyzer": {"owner":null,"keywords":["dsh-plugin"]},',
    '    "dsh-recheck": {"owner":"f1refly","keywords":["deepseek-harness","dsh-plugin"]}',
    '  },',
    '  "pending": [',
    '    "dsh-a",',
    '    "dsh-b"',
    '  ]',
    '}',
    '',
  ].join('\n')

  it('serializes one carrier per line, sorted by code unit, with one trailing newline', () => {
    expect(serializeFeedState(state)).toBe(text)
  })

  it('serializes the same state the same way whatever order it was built in', () => {
    const reversed: FeedState = {
      ...state, carriers: new Map([...state.carriers].reverse()), pending: [...state.pending].reverse(),
    }
    expect(serializeFeedState(reversed)).toBe(text)
  })

  it('serializes an empty state compactly', () => {
    expect(serializeFeedState(bootstrapFeedState()))
      .toBe(`{\n  "seq": ${FEED_BOOTSTRAP_SEQ},\n  "carriers": {},\n  "pending": []\n}\n`)
  })

  it('round-trips', () => {
    const parsed = parseFeedState(text, KEYWORDS)
    expect(parsed.seq).toBe(134466916)
    expect(parsed.carriers).toEqual(state.carriers)
    expect(parsed.pending).toEqual(['dsh-a', 'dsh-b'])
    expect(serializeFeedState(parsed)).toBe(text)
  })

  it('ignores an unknown top-level key, and the next write drops it', () => {
    const parsed = parseFeedState('{"seq": 5, "carriers": {}, "pending": [], "note": "hi"}', KEYWORDS)
    expect(serializeFeedState(parsed)).toBe('{\n  "seq": 5,\n  "carriers": {},\n  "pending": []\n}\n')
  })

  it.each([
    ['not JSON', '{', /not JSON/],
    ['an array', '[]', /expected an object/],
    ['a negative seq', '{"seq": -1, "carriers": {}, "pending": []}', /`seq`/],
    ['a fractional seq', '{"seq": 1.5, "carriers": {}, "pending": []}', /`seq`/],
    ['a string seq', '{"seq": "1", "carriers": {}, "pending": []}', /`seq`/],
    ['carriers as an array', '{"seq": 1, "carriers": [], "pending": []}', /`carriers`/],
    ['a carrier outside the package-name rule',
      '{"seq": 1, "carriers": {"DSH-X": {"owner": null, "keywords": ["dsh-plugin"]}}, "pending": []}', /package name/],
    ['a carrier that is not an object', '{"seq": 1, "carriers": {"dsh-x": 3}, "pending": []}', /must be an object/],
    ['an owner outside the username grammar',
      '{"seq": 1, "carriers": {"dsh-x": {"owner": "Bob Smith", "keywords": ["dsh-plugin"]}}, "pending": []}', /owner/],
    ['a missing owner', '{"seq": 1, "carriers": {"dsh-x": {"keywords": ["dsh-plugin"]}}, "pending": []}', /owner/],
    ['an empty keyword list', '{"seq": 1, "carriers": {"dsh-x": {"owner": null, "keywords": []}}, "pending": []}', /at least one/],
    ['a keyword that is not a harvest keyword',
      '{"seq": 1, "carriers": {"dsh-x": {"owner": null, "keywords": ["dsh"]}}, "pending": []}', /not a harvest keyword/],
    ['keywords out of order',
      '{"seq": 1, "carriers": {"dsh-x": {"owner": null, "keywords": ["dsh-plugin", "deepseek-harness"]}}, "pending": []}',
      /out of order/],
    ['a keyword listed twice',
      '{"seq": 1, "carriers": {"dsh-x": {"owner": null, "keywords": ["dsh-plugin", "dsh-plugin"]}}, "pending": []}',
      /out of order or twice/],
    ['a missing pending list', '{"seq": 1, "carriers": {}}', /`pending`/],
    ['a pending name outside the rule', '{"seq": 1, "carriers": {}, "pending": ["DSH-X"]}', /`pending`/],
    ['a pending name listed twice', '{"seq": 1, "carriers": {}, "pending": ["dsh-a", "dsh-a"]}', /twice/],
  ])('throws on %s', (_what, raw, message) => {
    expect(() => parseFeedState(raw, KEYWORDS)).toThrow(message)
  })

  it('names the file and the way out in every error', () => {
    expect(() => parseFeedState('{', KEYWORDS)).toThrow(/registry\/feed-state\.json: .*delete it to re-read the feed/)
  })

  it('starts a bootstrap at FEED_BOOTSTRAP_SEQ holding nothing', () => {
    const fresh = bootstrapFeedState()
    expect(fresh.seq).toBe(FEED_BOOTSTRAP_SEQ)
    expect(fresh.carriers.size).toBe(0)
    expect(fresh.pending).toEqual([])
  })
})

describe('parseFeedPage', () => {
  it('reads rows and the next cursor off a page', () => {
    expect(parseFeedPage({
      results: [{ seq: 5, id: 'dsh-a', changes: [{ rev: '1-x' }] }, { seq: 7, id: 'gone-b', deleted: true, changes: [] }],
      last_seq: 7,
    })).toEqual({ rows: [{ seq: 5, id: 'dsh-a', deleted: false }, { seq: 7, id: 'gone-b', deleted: true }], lastSeq: 7 })
  })

  it('reads only a literal true as deleted', () => {
    expect(parseFeedPage({ results: [{ seq: 1, id: 'a', deleted: 'yes' }], last_seq: 1 })?.rows[0]?.deleted).toBe(false)
  })

  it.each([
    ['null', null],
    ['an array', []],
    ['no results', { last_seq: 1 }],
    ['results that are not an array', { results: {}, last_seq: 1 }],
    ['a string cursor, the CouchDB 2 shape', { results: [], last_seq: '1-g1AAAA' }],
    ['a row with no seq', { results: [{ id: 'a' }], last_seq: 1 }],
    ['a row with a string seq', { results: [{ seq: '1', id: 'a' }], last_seq: 1 }],
    ['a row with no id', { results: [{ seq: 1 }], last_seq: 1 }],
    ['a row that is not an object', { results: [7], last_seq: 1 }],
  ])('refuses %s', (_what, page) => {
    expect(parseFeedPage(page)).toBeNull()
  })
})

describe('selectFeedIds', () => {
  const state = (carriers: Record<string, string[]> = {}, pending: string[] = []): FeedState => ({
    seq: 0,
    carriers: new Map(Object.entries(carriers).map(([name, keywords]) => [name, { owner: 'alice', keywords }])),
    pending,
  })
  const row = (seq: number, id: string, deleted = false): FeedRow => ({ seq, id, deleted })

  it('reads an id the name filter matches, and only those', () => {
    expect(selectFeedIds([row(1, 'dsh-a'), row(2, 'react')], state())).toEqual({ read: ['dsh-a'], gone: [], refused: 0 })
  })

  it('reads an id once when it appears on two pages, at its last row', () => {
    // Review Focus 2: the feed is live, so a package republished mid-read
    // shows up again further on, and a deletion then a republish is a read.
    expect(selectFeedIds([row(1, 'dsh-a'), row(9, 'dsh-a')], state())).toEqual({ read: ['dsh-a'], gone: [], refused: 0 })
    expect(selectFeedIds([row(1, 'dsh-a', true), row(9, 'dsh-a')], state({ 'dsh-a': ['dsh-plugin'] })).read)
      .toEqual(['dsh-a'])
  })

  it('re-reads a held carrier that changed even though the filter does not match it', () => {
    expect(selectFeedIds([row(1, 'probe-kit')], state({ 'probe-kit': ['dsh-plugin'] })).read).toEqual(['probe-kit'])
  })

  it('reads every pending name first, changed or not, then the changed ids in code-unit order', () => {
    expect(selectFeedIds([row(1, 'dsh-c'), row(2, 'dsh-b')], state({}, ['dsh-z', 'dsh-y'])).read)
      .toEqual(['dsh-y', 'dsh-z', 'dsh-b', 'dsh-c'])
  })

  it('reads a pending name that also changed only once', () => {
    expect(selectFeedIds([row(1, 'dsh-y')], state({}, ['dsh-y'])).read).toEqual(['dsh-y'])
  })

  it('marks a held carrier the feed deleted as gone, without a read', () => {
    expect(selectFeedIds([row(1, 'dsh-a', true)], state({ 'dsh-a': ['dsh-plugin'] })))
      .toEqual({ read: [], gone: ['dsh-a'], refused: 0 })
  })

  it('marks a deleted pending name gone and does not read it', () => {
    expect(selectFeedIds([row(1, 'dsh-p', true)], state({}, ['dsh-p']))).toEqual({ read: [], gone: ['dsh-p'], refused: 0 })
  })

  it('ignores the deletion of a package it never held', () => {
    expect(selectFeedIds([row(1, 'dsh-a', true)], state())).toEqual({ read: [], gone: [], refused: 0 })
  })

  it('refuses, and counts, a matching id outside the package-name rule', () => {
    // Review Focus 1: a legacy capitalized name must never be read into the
    // state, or the next run's strict parse throws.
    expect(selectFeedIds([row(1, 'DSH-Legacy'), row(2, 'dsh-ok')], state()))
      .toEqual({ read: ['dsh-ok'], gone: [], refused: 1 })
  })

  it('skips design documents', () => {
    expect(selectFeedIds([row(1, '_design/dsh')], state()).read).toEqual([])
  })
})

describe('applyFeedReads', () => {
  const prior: FeedState = {
    seq: 10,
    carriers: new Map([['dsh-held', { owner: 'alice', keywords: ['dsh-plugin'] }]]),
    pending: ['dsh-pend'],
  }

  it('sets a carrier and clears it from pending', () => {
    const next = applyFeedReads(prior, [
      { kind: 'carrier', name: 'dsh-pend', carrier: { owner: 'bob', keywords: ['deepseek-harness'] } },
    ], 20)
    expect(next.carriers.get('dsh-pend')).toEqual({ owner: 'bob', keywords: ['deepseek-harness'] })
    expect(next.pending).toEqual([])
    expect(next.seq).toBe(20)
  })

  it.each(['not-carrier', 'gone'] as const)('removes a held name read as %s', (kind) => {
    expect(applyFeedReads(prior, [{ kind, name: 'dsh-held' }], 20).carriers.has('dsh-held')).toBe(false)
  })

  it('keeps a held carrier whose read failed, and makes it pending', () => {
    const next = applyFeedReads(prior, [{ kind: 'failed', name: 'dsh-held', reason: 'the registry answered 503' }], 20)
    expect(next.carriers.get('dsh-held')).toEqual({ owner: 'alice', keywords: ['dsh-plugin'] })
    expect(next.pending).toEqual(['dsh-held', 'dsh-pend'])
  })

  it('makes an unreached name pending', () => {
    expect(applyFeedReads(prior, [{ kind: 'unreached', name: 'dsh-new' }], 20).pending).toEqual(['dsh-new', 'dsh-pend'])
  })

  it('never stores a name outside the package-name rule, so the next parse cannot throw', () => {
    // Review Focus 1, at the writer: whatever reaches the merge, the file
    // it produces parses.
    const next = applyFeedReads(prior, [
      { kind: 'carrier', name: 'DSH-Legacy', carrier: { owner: null, keywords: ['dsh-plugin'] } },
      { kind: 'failed', name: 'Bad Name', reason: 'x' },
    ], 20)
    expect(next.carriers.has('DSH-Legacy')).toBe(false)
    expect(next.pending).toEqual(['dsh-pend'])
    expect(() => parseFeedState(serializeFeedState(next), KEYWORDS)).not.toThrow()
  })

  it('refuses to move the cursor backwards', () => {
    expect(() => applyFeedReads(prior, [], 9)).toThrow(/cannot move from 10 to 9/)
  })

  it('leaves the prior state untouched', () => {
    applyFeedReads(prior, [{ kind: 'gone', name: 'dsh-held' }], 20)
    expect(prior.carriers.has('dsh-held')).toBe(true)
  })
})

describe('feedCarriersByKeyword and carrierCounts', () => {
  const state: FeedState = {
    seq: 1,
    carriers: new Map([
      ['dsh-b', { owner: null, keywords: ['dsh-plugin'] }],
      ['dsh-a', { owner: 'alice', keywords: ['deepseek-harness', 'dsh-plugin'] }],
    ]),
    pending: [],
  }

  it('groups carriers by harvest keyword with their owners, in code-unit order of name', () => {
    const byKeyword = feedCarriersByKeyword(state, KEYWORDS)
    expect([...(byKeyword.get('dsh-plugin') ?? [])]).toEqual([['dsh-a', 'alice'], ['dsh-b', null]])
    expect([...(byKeyword.get('deepseek-harness') ?? [])]).toEqual([['dsh-a', 'alice']])
  })

  it('holds an empty map for a keyword nothing carries', () => {
    expect(feedCarriersByKeyword(bootstrapFeedState(), KEYWORDS).get('dsh-plugin')?.size).toBe(0)
  })

  it('counts carriers per keyword', () => {
    expect(carrierCounts(state, KEYWORDS)).toEqual({ 'dsh-plugin': 2, 'deepseek-harness': 1 })
  })
})

describe('planFeedVerification', () => {
  const owners = new Map<string, string | null>([
    ['n-a1', 'a'], ['n-a2', 'a'], ['n-b', 'b'], ['n-c', 'c'], ['n-d', 'd'], ['n-e', 'e'], ['n-null', null],
  ])
  const all = ['n-a1', 'n-a2', 'n-b', 'n-c', 'n-d', 'n-e', 'n-null']

  it('checks every owner when they fit the budget, and leaves an ownerless name unverified', () => {
    const plan = planFeedVerification(all, owners, 16, 0)
    expect(plan.owners).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(plan.namesOf.get('a')).toEqual(['n-a1', 'n-a2'])
    expect(plan.unverified).toEqual(['n-null'])
    expect(plan.ownersTotal).toBe(5)
  })

  it('rotates the owners it checks by the seed, wrapping round', () => {
    // Five owners a..e: seed 3 starts at d; seed 4 starts at e and wraps
    // to a; 4 + 5,000 is 4 again modulo 5.
    expect(planFeedVerification(all, owners, 2, 3).owners).toEqual(['d', 'e'])
    expect(planFeedVerification(all, owners, 2, 4).owners).toEqual(['e', 'a'])
    expect(planFeedVerification(all, owners, 2, 5004).owners).toEqual(['e', 'a'])
  })

  it('leaves the names of every owner it does not check unverified', () => {
    expect(planFeedVerification(all, owners, 2, 3).unverified).toEqual(['n-a1', 'n-a2', 'n-b', 'n-c', 'n-null'])
  })

  it('checks nothing with a zero budget or no feed-only names', () => {
    expect(planFeedVerification(all, owners, 0, 0).owners).toEqual([])
    expect(planFeedVerification([], owners, 16, 0)).toEqual({ owners: [], namesOf: new Map(), unverified: [], ownersTotal: 0 })
  })

  it('treats a name with no recorded owner as unverified', () => {
    expect(planFeedVerification(['n-unknown'], owners, 16, 0).unverified).toEqual(['n-unknown'])
  })
})

const runReport: FeedRunReport = {
  available: true, note: '', fromSeq: 100, toSeq: 160, pages: 1, selected: 3, read: 3, failed: 1,
  unreached: 0, refused: 2, pending: 1, carriers: { 'dsh-plugin': 7, 'deepseek-harness': 5 },
}
const unavailableReport: FeedRunReport = {
  ...runReport, available: false, note: 'the feed head could not be read: x', toSeq: 100, pages: 0,
  selected: 0, read: 0, failed: 0, refused: 0,
}
const coverage: FeedCoverage = {
  keyword: 'deepseek-harness', feedOnly: 16, supplied: 17, ownersVerified: 12, ownersTotal: 12,
  verified: 16, unverified: 0, disagreed: [],
}

describe('describeFeedRun', () => {
  it('states the cursor, the reads and the carriers', () => {
    expect(describeFeedRun(runReport)).toBe(
      'change feed: seq 100 -> 160 (1 page(s)); read 3 of 3 selected (1 failed, 0 not reached, 2 refused); '
        + '1 pending; carriers: deepseek-harness 5, dsh-plugin 7')
  })

  it('says where paging stopped', () => {
    expect(describeFeedRun({ ...runReport, note: 'stopped at the 200-page budget' }))
      .toContain('(1 page(s), stopped at the 200-page budget)')
  })

  it('says nothing was listed or credited when the feed was unavailable', () => {
    expect(describeFeedRun(unavailableReport))
      .toBe('change feed unavailable: the feed head could not be read: x; no feed name was listed or credited')
  })

  it('escapes the note, which can quote a server', () => {
    expect(describeFeedRun({ ...unavailableReport, note: 'a|b\nc' }))
      .toBe('change feed unavailable: a\\|b c; no feed name was listed or credited')
  })
})

describe('describeFeedCoverage', () => {
  it('states what the feed supplied and how much of it was verified', () => {
    expect(describeFeedCoverage(coverage)).toBe('keywords:deepseek-harness feed supplied 17 (owners verified 12 of 12)')
  })

  it('names unverified and disagreeing names, escaped', () => {
    expect(describeFeedCoverage({ ...coverage, verified: 13, unverified: 1, disagreed: ['dsh-a', 'dsh-b'] }))
      .toBe('keywords:deepseek-harness feed supplied 17 (owners verified 12 of 12; 1 unverified; 2 disagreed: dsh-a, dsh-b)')
  })
})

describe('parseFeedRunReport', () => {
  it('round-trips a report', () => {
    expect(parseFeedRunReport(JSON.parse(JSON.stringify(runReport)), 'harvest.json', KEYWORDS)).toEqual(runReport)
    expect(parseFeedRunReport(JSON.parse(JSON.stringify(unavailableReport)), 'harvest.json', KEYWORDS)).toEqual(unavailableReport)
  })

  it.each([
    ['no available flag', { available: undefined }],
    ['a fractional count', { pages: 1.5 }],
    ['a negative count', { failed: -1 }],
    ['no note', { note: 7 }],
    ['a missing keyword count', { carriers: { 'dsh-plugin': 1 } }],
    ['a cursor moving backwards', { toSeq: 99 }],
    ['reads that do not add up', { read: 2 }],
    ['more failures than reads', { failed: 4 }],
    ['an unavailable feed that read pages', { available: false }],
  ])('throws on %s', (_what, patch) => {
    expect(() => parseFeedRunReport({ ...runReport, ...patch }, 'harvest.json', KEYWORDS))
      .toThrow(/harvest\.json: change-feed report/)
  })
})

describe('parseFeedCoverage', () => {
  it('round-trips a record', () => {
    expect(parseFeedCoverage(JSON.parse(JSON.stringify(coverage)), 'harvest.json', KEYWORDS)).toEqual(coverage)
  })

  it.each([
    ['a keyword that is not a harvest keyword', { keyword: 'dsh' }],
    ['parts that do not add up', { verified: 15 }],
    ['more owners verified than held', { ownersVerified: 13 }],
    ['less supplied than credited', { supplied: 15 }],
    ['a disagreed name outside the rule', { disagreed: ['DSH-X'], verified: 15 }],
    ['a disagreed list that is not an array', { disagreed: 'dsh-a' }],
  ])('throws on %s', (_what, patch) => {
    expect(() => parseFeedCoverage({ ...coverage, ...patch }, 'harvest.json', KEYWORDS))
      .toThrow(/harvest\.json: change-feed coverage record/)
  })
})
