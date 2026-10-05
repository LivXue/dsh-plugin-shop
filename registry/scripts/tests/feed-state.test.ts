import { describe, expect, it } from 'vitest'
import {
  bootstrapFeedState, classifyManifest, FEED_BOOTSTRAP_SEQ, FEED_NAME_PATTERN, FEED_PACKAGE_NAME_MAX_LENGTH,
  isDeprecated, isFeedPackageName, parseFeedState, serializeFeedState, type FeedState,
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

  it('reads a manifest with no name as not a carrier', () => {
    expect(classifyManifest('dsh-x', manifest({ name: undefined }), KEYWORDS)).toEqual({ kind: 'not-carrier', name: 'dsh-x' })
  })

  it.each([null, 'text', 42, ['dsh-plugin']])('reads a body that is not an object (%j) as not a carrier', (body) => {
    expect(classifyManifest('dsh-x', body, KEYWORDS)).toEqual({ kind: 'not-carrier', name: 'dsh-x' })
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
