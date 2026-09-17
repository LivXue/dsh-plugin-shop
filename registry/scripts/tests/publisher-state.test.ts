import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  MAINTAINER_MAX_LENGTH, MAX_PINNED_PER_KEYWORD, MAX_PUBLISHERS, PublisherState, atRiskOwners, isMaintainerName,
  mergePublishers, nextCursor, parsePublisherState, pinFor, probeOrder, serializePublisherState, unpinFor,
} from '../src/publisher-state.ts'
import { PUBLISHER_PROBE_BUDGET_DEFAULT } from '../src/npm-client.ts'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

describe('the shipped budget against the shipped vocabulary', () => {
  it('is small enough that the rotation is live, not dormant', () => {
    // `nextCursor` returns 0 whenever `size <= budget`, so a budget at or above
    // the committed vocabulary disables the rotation ENTIRELY -- and silently,
    // because a cursor that never moves looks exactly like a cursor that has
    // nothing to do. Every run then probes the whole vocabulary, in one
    // sequential pass.
    //
    // That is not hypothetical. 0.8.1 shipped the axis with a 4,000 budget
    // against an EMPTY committed vocabulary, so its own CI proved only the
    // no-op path; the first green run wrote 3,474 publishers, and the next run
    // -- the first to probe them -- spent 57m37s on 3,474 sequential `size=1`
    // requests (~1.0s each, 429 backoffs included) before npm answered 503 and
    // `searchTotal` threw, on 2026-09-10. `deploy` and `publish` were skipped,
    // so nothing was published for that day.
    //
    // Asserted as the PROPERTY rather than against a literal, because the
    // vocabulary only grows (`mergePublishers` never removes a name it keeps),
    // so it moves away from this boundary and never back toward it.
    const state = parsePublisherState(readFileSync(join(repoRoot, 'registry', 'publisher-state.json'), 'utf8'))
    expect(
      PUBLISHER_PROBE_BUDGET_DEFAULT,
      `a ${PUBLISHER_PROBE_BUDGET_DEFAULT} budget against ${state.publishers.length} committed publishers `
      + 'leaves nextCursor pinned at 0: every run probes the whole vocabulary in one pass',
    ).toBeLessThan(state.publishers.length)
  })
})

describe('isMaintainerName', () => {
  it('accepts a subset of npm account grammar and nothing else', () => {
    // This value is interpolated into a search `text=`, so the grammar IS the
    // boundary that keeps it safe. Lowercase letters, digits, hyphen,
    // underscore and dot -- deliberately NARROWER than what npm accepts as an
    // account name, which is why a name outside it is dropped rather than
    // treated as impossible -- MAINTAINER_NAME's own docblock owns the live
    // counterexample.
    expect(isMaintainerName('ok-name_1.2')).toBe(true)
    expect(isMaintainerName('a b')).toBe(false)
    expect(isMaintainerName('has:colon')).toBe(false)
    expect(isMaintainerName('')).toBe(false)
    expect(isMaintainerName(7)).toBe(false)
    expect(isMaintainerName(null)).toBe(false)
    expect(isMaintainerName(undefined)).toBe(false)
  })

  it('rejects uppercase because `maintainer:` is case-sensitive', () => {
    // Not part of the narrowing above: measured 2026-09-09,
    // `maintainer:HUANLIN` answers 0 where `maintainer:huanlin` answers 92, so
    // an uppercase spelling is not a value this qualifier has an answer for
    // and admitting one would buy a cell that enumerates nothing. Contrast
    // `config.ts`'s NPM_NAME and `github-client.ts`'s BUNDLE_NAME_RE, which
    // both permit uppercase and say why -- those grammars name packages, which
    // npm does serve case-sensitively under a legacy spelling.
    expect(isMaintainerName('UPPER')).toBe(false)
    expect(isMaintainerName('Huanlin')).toBe(false)
  })

  it('is anchored to the whole string, trailing newline included', () => {
    // The property the safety claim rests on, and it is JS-specific: `$`
    // without the `m` flag is end-of-input, so `a\n` does not match. In a
    // flavour where `$` means end-of-line -- or after someone adds `m`, or
    // refactors through split('\n') -- `a\n` would pass the grammar and reach
    // a `text=` value carrying a newline. Untested, that regression is silent.
    expect(isMaintainerName('a\n')).toBe(false)
    expect(isMaintainerName('a\nb')).toBe(false)
    expect(isMaintainerName('\na')).toBe(false)
  })

  it('bounds the length', () => {
    expect(isMaintainerName('x'.repeat(MAINTAINER_MAX_LENGTH))).toBe(true)
    expect(isMaintainerName('x'.repeat(MAINTAINER_MAX_LENGTH + 1))).toBe(false)
  })
})

describe('publisher state', () => {
  it('round-trips a sorted vocabulary', () => {
    const raw = serializePublisherState({ publishers: ['sayedev', 'bowenliang123'] })
    // Sorted by code unit, like every other artifact this repo writes, so the
    // committed file does not churn on the order npm happened to answer in.
    expect(raw).toBe('{\n  "publishers": [\n    "bowenliang123",\n    "sayedev"\n  ],\n  "cursor": 0,\n  "pinned": {}\n}\n')
    expect(parsePublisherState(raw).publishers).toEqual(['bowenliang123', 'sayedev'])
  })

  it('accumulates monotonically — a publisher seen once is never forgotten', () => {
    // The whole point of persisting. Today `sayedev` is discoverable because
    // 14 of that family's 20 packages sit inside the window; when the window
    // is a smaller fraction of the keyword they may all fall outside it, and
    // the cell has to keep working.
    const first = mergePublishers({ publishers: [] }, ['sayedev'])
    const second = mergePublishers(first, ['bowenliang123'])
    expect(second.publishers).toEqual(['bowenliang123', 'sayedev'])
  })

  it('de-duplicates and re-sorts on merge', () => {
    expect(mergePublishers({ publishers: ['b'] }, ['a', 'b', 'a']).publishers).toEqual(['a', 'b'])
  })

  it('throws on a malformed file rather than harvesting with an empty vocabulary', () => {
    // Same posture as repo-state.ts: silently losing the memory would look
    // exactly like a first run, and quietly halve the partition.
    expect(() => parsePublisherState('not json')).toThrow(/not valid JSON/)
    expect(() => parsePublisherState('[]')).toThrow(/must be an object/)
    expect(() => parsePublisherState('{}')).toThrow(/publishers/)
    expect(() => parsePublisherState('{"publishers": "a"}')).toThrow(/publishers/)
    expect(() => parsePublisherState('{"publishers": [7]}')).toThrow(/publishers\[0\]/)
  })

  it('throws on a username it would not have written itself', () => {
    // The file is a build INPUT. A hand-edited or tampered entry reaches a
    // query, so the grammar is enforced on read as well as on write.
    expect(() => parsePublisherState('{"publishers": ["a b"]}')).toThrow(/publishers\[0\]/)
    expect(() => parsePublisherState(`{"publishers": ["${'x'.repeat(MAINTAINER_MAX_LENGTH + 1)}"]}`))
      .toThrow(/publishers\[0\]/)
  })

  it('ignores an unknown key rather than refusing the file', () => {
    // It IGNORES the key; it does not carry it through -- serializePublisher-
    // State writes `{ publishers }` alone, so the next daily write erases it.
    // The version-skew story this was justified with does not hold either:
    // daily.yml runs classify.ts and build.ts in one job from one checkout at
    // one commit, so there is no older reader. What the tolerance actually
    // buys is that a hand-added note does not stop a build -- and the honest
    // cost, stated because accept-then-erase is the misleading half, is that
    // the note is gone on the next run.
    const raw = '{\n  "publishers": [\n    "alice"\n  ],\n  "note": "hand-written"\n}\n'
    expect(parsePublisherState(raw).publishers).toEqual(['alice'])
    expect(serializePublisherState(parsePublisherState(raw))).not.toContain('note')
  })

  it('collapses a duplicate rather than round-tripping it forever', () => {
    // The interface says "sorted, unique" and mergePublishers cannot produce a
    // repeat, so a file carrying one was hand edited or badly merged -- and
    // the daily snapshot commit re-stages this file, so a merge that keeps
    // both sides of a one-line insertion is the realistic entry. Left in, the
    // duplicate survives every round trip and costs one wasted probe plus one
    // wasted paged sweep per build, against a probe budget with little
    // headroom. Collapsing is what the sibling shape gets for free:
    // repo-state.ts is a Record, where a repeated JSON key collapses too.
    expect(parsePublisherState('{"publishers":["b","a","a"]}').publishers).toEqual(['a', 'b'])
    expect(serializePublisherState(parsePublisherState('{"publishers":["a","a"]}')))
      .toBe('{\n  "publishers": [\n    "a"\n  ],\n  "cursor": 0,\n  "pinned": {}\n}\n')
  })

  describe('the probe cursor', () => {
    it('reads as zero when the file predates it', () => {
      // Every file written before the cursor existed, and every hand-written
      // one. Absent is not malformed; it means "start at the beginning".
      expect(parsePublisherState('{"publishers":["a"]}').cursor).toBe(0)
    })

    it('round-trips a position', () => {
      expect(parsePublisherState('{"publishers":["a","b"],"cursor":1}').cursor).toBe(1)
      expect(serializePublisherState({ publishers: ['a'], cursor: 7 }))
        .toBe('{\n  "publishers": [\n    "a"\n  ],\n  "cursor": 7,\n  "pinned": {}\n}\n')
    })

    it('throws on a cursor that is not a count', () => {
      // Same posture as every other field here: a malformed build INPUT stops
      // the run rather than silently restarting the rotation at zero, which
      // would starve the tail of the vocabulary and look like nothing at all.
      expect(() => parsePublisherState('{"publishers":[],"cursor":-1}')).toThrow(/cursor/)
      expect(() => parsePublisherState('{"publishers":[],"cursor":1.5}')).toThrow(/cursor/)
      expect(() => parsePublisherState('{"publishers":[],"cursor":"3"}')).toThrow(/cursor/)
    })

    it('stays put while the whole vocabulary fits one run', () => {
      // Rotating a list every run can already probe is churn in a committed
      // file for nothing.
      expect(nextCursor({ publishers: ['a', 'b', 'c'] }, 10)).toBe(0)
      expect(nextCursor({ publishers: ['a', 'b', 'c'], cursor: 2 }, 3)).toBe(0)
    })

    it('advances by one budget and wraps, so no publisher is starved forever', () => {
      // THE point of the cursor. `selectPublisherCells` walks the vocabulary in
      // sorted order and stops at the budget, so without rotation the same
      // prefix is probed every run and everything after it is never probed at
      // all -- not a partial run, a permanently excluded tail. The shape is
      // anticipated by this module's own bounds: MAX_PUBLISHERS is 20,000,
      // several times whatever per-run budget npm-client ships.
      const ten = { publishers: Array.from({ length: 10 }, (_, i) => `u${i}`) }
      expect(nextCursor(ten, 4)).toBe(4)
      expect(nextCursor({ ...ten, cursor: 4 }, 4)).toBe(8)
      expect(nextCursor({ ...ten, cursor: 8 }, 4)).toBe(2)
    })

    it('carries the cursor through a merge', () => {
      // The merge grows the vocabulary; it does not restart the rotation.
      expect(mergePublishers({ publishers: ['b'], cursor: 3 }, ['a']).cursor).toBe(3)
    })
  })

  it('filters the write side to the same grammar the read side throws on', () => {
    // Otherwise the module poisons its own input: a caller that assembles
    // usernames without going through maintainersOf writes a file that every
    // SUBSEQUENT build refuses to parse -- a self-inflicted stop one run away
    // from its cause, in the wrong module, repairable only by hand-editing a
    // generated file. Both the incoming names and the state's own rows are
    // filtered, so a hand-built state cannot smuggle one past either end.
    expect(mergePublishers({ publishers: [] }, ['A b:c', 'ok']).publishers).toEqual(['ok'])
    expect(mergePublishers({ publishers: ['A b:c'] }, ['ok']).publishers).toEqual(['ok'])
    const poisoned = serializePublisherState(mergePublishers({ publishers: [] }, ['My Bot', 'sayedev']))
    expect(() => parsePublisherState(poisoned)).not.toThrow()
  })

  it('takes an array, so a bare string cannot spread into six publishers', () => {
    // `string` is assignable to `Iterable<string>`, which this parameter was:
    // mergePublishers(state, 'sayedev') type-checked and merged 'a','d','e',
    // 's','v','y' -- every one passing the grammar, and then never removed,
    // each buying a live probe every run forever.
    // @ts-expect-error a single username is not a list of usernames
    const smuggled = mergePublishers({ publishers: [] }, 'sayedev')
    // The type is the WHOLE guard, which is why this asserts the damage rather
    // than the repair: a string still spreads to characters at runtime and
    // every character passes the grammar, so tsc is the only thing standing
    // between that typo and six permanent publishers. Widen the parameter back
    // and the expected error disappears, which fails typecheck.
    expect(smuggled.publishers).toEqual(['a', 'd', 'e', 's', 'v', 'y'])
  })

  it('caps the vocabulary, keeping the code-unit head so the file does not churn', () => {
    // The per-name bound was the only one. Every other npm-sourced list here
    // carries both halves (PEER_NAME_MAX_LENGTH with PEERS_MAX_COUNT,
    // MAX_SUBPACKAGES, REPO_BACKFILL_BUDGET), and this one needs the count
    // half most because merging never removes: without it one hostile page is
    // committed to git permanently. Dropping the TAIL rather than the newest
    // arrivals keeps the kept set a pure function of the union, so a full
    // vocabulary is stable across runs instead of churning the commit.
    const many = Array.from({ length: MAX_PUBLISHERS + 10 }, (_, i) => `u${String(i).padStart(6, '0')}`)
    const capped = mergePublishers({ publishers: [] }, many)
    expect(capped.publishers).toHaveLength(MAX_PUBLISHERS)
    expect(capped.publishers[0]).toBe('u000000')
    // Stable: re-merging the same union yields the same file, not a churn.
    expect(mergePublishers(capped, many).publishers).toEqual(capped.publishers)
  })
})

describe('the pinned map in the committed state', () => {
  it('round-trips, sorted by keyword and by username', () => {
    const raw = JSON.stringify({
      publishers: ['a'], cursor: 0,
      pinned: { 'dsh-plugin': ['zoe', 'adam'], 'deepseek-harness': ['bob'] },
    })
    const state = parsePublisherState(raw)
    expect(state.pinned).toEqual({ 'deepseek-harness': ['bob'], 'dsh-plugin': ['adam', 'zoe'] })
    expect(JSON.parse(serializePublisherState(state)).pinned)
      .toEqual({ 'deepseek-harness': ['bob'], 'dsh-plugin': ['adam', 'zoe'] })
    // Key order is committed bytes, so assert the order and not just the value.
    expect(Object.keys(JSON.parse(serializePublisherState(state)).pinned))
      .toEqual(['deepseek-harness', 'dsh-plugin'])
  })

  it('reads a file written before pinned existed as having none', () => {
    expect(parsePublisherState(JSON.stringify({ publishers: ['a'] })).pinned).toEqual({})
  })

  it('throws on a pinned that is not an object of arrays', () => {
    expect(() => parsePublisherState(JSON.stringify({ publishers: [], pinned: ['a'] })))
      .toThrow(/pinned must be an object/)
    expect(() => parsePublisherState(JSON.stringify({ publishers: [], pinned: { k: 'a' } })))
      .toThrow(/pinned\["k"\] must be an array/)
  })

  it('throws on a pinned username outside the grammar, like publishers does', () => {
    expect(() => parsePublisherState(JSON.stringify({ publishers: [], pinned: { k: ['ok', ''] } })))
      .toThrow(/pinned\["k"\]\[1\] is not a maintainer username/)
  })

  it('de-duplicates within a keyword', () => {
    const state = parsePublisherState(JSON.stringify({ publishers: [], pinned: { k: ['a', 'a'] } }))
    expect(state.pinned).toEqual({ k: ['a'] })
  })

  it('serializes an empty pinned as an empty object, so the key is always present', () => {
    expect(JSON.parse(serializePublisherState({ publishers: [], cursor: 0 })).pinned).toEqual({})
  })

  it('rides through mergePublishers untouched', () => {
    const state: PublisherState = { publishers: ['a'], cursor: 3, pinned: { k: ['pinned-one'] } }
    expect(mergePublishers(state, ['b']).pinned).toEqual({ k: ['pinned-one'] })
  })
})

const REFINEMENTS = ['dsh', 'dsh-plugin', 'deepseek-harness', 'agent', 'mcp']

describe('atRiskOwners', () => {
  it('returns the owners of names carrying no refinement beyond the harvest keyword', () => {
    const names = [
      { keywords: ['dsh-plugin'], maintainers: ['huanlin'] },
      { keywords: ['dsh-plugin', 'agent'], maintainers: ['covered'] },
    ]
    expect(atRiskOwners(names, 'dsh-plugin', REFINEMENTS)).toEqual(['huanlin'])
  })

  it('does not count the other harvest keyword as bare: its intersection cell reaches the name', () => {
    const names = [{ keywords: ['dsh-plugin', 'deepseek-harness'], maintainers: ['reachable'] }]
    expect(atRiskOwners(names, 'dsh-plugin', REFINEMENTS)).toEqual([])
  })

  it('ignores keywords that are not refinements, because no cell is built from them', () => {
    // `typescript` is not in PARTITION_KEYWORDS, so it buys no reachability.
    const names = [{ keywords: ['dsh-plugin', 'typescript'], maintainers: ['still-at-risk'] }]
    expect(atRiskOwners(names, 'dsh-plugin', REFINEMENTS)).toEqual(['still-at-risk'])
  })

  it('returns every owner of an at-risk name, sorted and unique', () => {
    const names = [
      { keywords: ['dsh-plugin'], maintainers: ['zoe', 'adam'] },
      { keywords: ['dsh-plugin'], maintainers: ['adam'] },
    ]
    expect(atRiskOwners(names, 'dsh-plugin', REFINEMENTS)).toEqual(['adam', 'zoe'])
  })

  it('drops owners that are not maintainer usernames', () => {
    const names = [{ keywords: ['dsh-plugin'], maintainers: ['ok', '', 'a'.repeat(200)] }]
    expect(atRiskOwners(names, 'dsh-plugin', REFINEMENTS)).toEqual(['ok'])
  })

  it('is empty when a name carries no keywords at all, which cannot be attributed', () => {
    // A name with no keywords did not reach the harvest through a keyword
    // search, so treating it as at-risk for this keyword is unfounded.
    expect(atRiskOwners([{ keywords: [], maintainers: ['x'] }], 'dsh-plugin', REFINEMENTS)).toEqual([])
  })
})

describe('MAX_PINNED_PER_KEYWORD', () => {
  it('is half the probe budget, so rotation always keeps half a run', () => {
    // Asserted as the relation, not the literal: the bound exists to stop
    // pinned probes starving rotation, and that property is what must hold if
    // the budget ever moves.
    expect(MAX_PINNED_PER_KEYWORD * 2).toBe(PUBLISHER_PROBE_BUDGET_DEFAULT)
  })
})

describe('pinFor and unpinFor', () => {
  it('adds, sorted and unique, without touching another keyword', () => {
    const state: PublisherState = { publishers: [], cursor: 0, pinned: { other: ['keepme'] } }
    const next = pinFor(state, 'dsh-plugin', ['zoe', 'adam', 'zoe'])
    expect(next.pinned).toEqual({ 'dsh-plugin': ['adam', 'zoe'], other: ['keepme'] })
  })

  it('refuses to grow a keyword past MAX_PINNED_PER_KEYWORD, keeping what it has', () => {
    const full = Array.from({ length: MAX_PINNED_PER_KEYWORD }, (_, i) => `u${String(i).padStart(5, '0')}`)
    const next = pinFor({ publishers: [], pinned: { k: full } }, 'k', ['newcomer'])
    expect(next.pinned?.k).toHaveLength(MAX_PINNED_PER_KEYWORD)
    expect(next.pinned?.k).not.toContain('newcomer')
  })

  it('drops names outside the grammar rather than committing a file it cannot read', () => {
    expect(pinFor({ publishers: [] }, 'k', ['ok', '']).pinned).toEqual({ k: ['ok'] })
  })

  it('adds no key when nothing survives, so an empty entry cannot reach the committed file', () => {
    expect(pinFor({ publishers: [] }, 'k', []).pinned).toEqual({})
    expect(pinFor({ publishers: [] }, 'k', ['', 'a'.repeat(200)]).pinned).toEqual({})
  })

  it('unpins only the named users, and only for that keyword', () => {
    const state: PublisherState = { publishers: [], pinned: { k: ['a', 'b'], other: ['a'] } }
    expect(unpinFor(state, 'k', ['a']).pinned).toEqual({ k: ['b'], other: ['a'] })
  })

  it('drops a keyword whose last pin is removed, rather than leaving an empty array', () => {
    expect(unpinFor({ publishers: [], pinned: { k: ['a'] } }, 'k', ['a']).pinned).toEqual({})
  })
})

describe('probeOrder', () => {
  const vocabulary = Array.from({ length: 10 }, (_, i) => `u${i}`)

  it('puts the pinned first and rotates the rest from the cursor', () => {
    const state: PublisherState = { publishers: vocabulary, cursor: 2, pinned: { k: ['u7'] } }
    const order = probeOrder(state, 'k', 4)
    expect(order.pinned).toEqual(['u7'])
    // 4 budget minus 1 pinned leaves 3 rotated, starting at index 2.
    expect(order.rotated).toEqual(['u2', 'u3', 'u4'])
  })

  it('does not rotate to a publisher it already pinned, which would probe it twice', () => {
    const state: PublisherState = { publishers: vocabulary, cursor: 2, pinned: { k: ['u3'] } }
    const order = probeOrder(state, 'k', 4)
    expect(order.pinned).toEqual(['u3'])
    expect(order.rotated).toEqual(['u2', 'u4', 'u5'])
  })

  it('wraps the rotation past the end of the vocabulary', () => {
    const state: PublisherState = { publishers: vocabulary, cursor: 8 }
    expect(probeOrder(state, 'k', 4).rotated).toEqual(['u8', 'u9', 'u0', 'u1'])
  })

  it('ignores another keyword\'s pins', () => {
    const state: PublisherState = { publishers: vocabulary, cursor: 0, pinned: { other: ['u5'] } }
    const order = probeOrder(state, 'k', 2)
    expect(order.pinned).toEqual([])
    expect(order.rotated).toEqual(['u0', 'u1'])
  })

  it('never spends more than the budget in total', () => {
    const pinned = vocabulary.slice(0, 6)
    const order = probeOrder({ publishers: vocabulary, cursor: 0, pinned: { k: pinned } }, 'k', 4)
    expect(order.pinned.length + order.rotated.length).toBeLessThanOrEqual(4)
  })

  it('is empty on an empty vocabulary rather than looping', () => {
    expect(probeOrder({ publishers: [], cursor: 0 }, 'k', 5)).toEqual({ pinned: [], rotated: [] })
  })
})
