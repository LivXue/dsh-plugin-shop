import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  MAINTAINER_MAX_LENGTH, MAX_PINNED_KEYWORDS, MAX_PINNED_PER_KEYWORD, MAX_PUBLISHERS, MIN_PROBE_BUDGET_PER_KEYWORD,
  PublisherState, advanceCursor, allocateProbeBudgets, applyAxisReport, atRiskNameCount, atRiskOwners, cursorFor,
  isMaintainerName, mergePublishers, parsePublisherState,
  pinFor, probeOrder, retainPinned, serializePublisherState, unpinFor,
} from '../src/publisher-state.ts'
import { HARVEST_KEYWORDS, PUBLISHER_PROBE_BUDGET_DEFAULT } from '../src/npm-client.ts'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

describe('the shipped budget against the shipped vocabulary', () => {
  it('is small enough that the rotation is live, not dormant', () => {
    // A budget at or above the committed vocabulary means one run walks the
    // whole of it, so `advanceCursor` lands back where it started and the
    // rotation is inert -- silently, because a cursor that never moves looks
    // exactly like a cursor that has nothing to do. Every run then probes the
    // whole vocabulary, in one sequential pass.
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
    //
    // Against the POOL, not the per-keyword term, since `allocateProbeBudgets`
    // began splitting by tail: one keyword can now be allocated nearly all of
    // `PUBLISHER_PROBE_BUDGET_DEFAULT x HARVEST_KEYWORDS.length`, so that
    // product is what has to stay under the vocabulary. Bounding the smaller
    // number would have left the dormant-rotation defect reachable by the
    // reallocation that was meant to be free.
    const state = parsePublisherState(readFileSync(join(repoRoot, 'registry', 'publisher-state.json'), 'utf8'))
    const pool = PUBLISHER_PROBE_BUDGET_DEFAULT * HARVEST_KEYWORDS.length
    expect(
      pool,
      `a ${pool} pool against ${state.publishers.length} committed publishers `
      + 'walks the whole vocabulary in one run: the cursor returns to where it started and the rotation is inert',
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
    expect(raw).toBe('{\n  "publishers": [\n    "bowenliang123",\n    "sayedev"\n  ],\n  "cursor": 0,\n  "cursors": {},\n  "pinned": {}\n}\n')
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
      .toBe('{\n  "publishers": [\n    "a"\n  ],\n  "cursor": 0,\n  "cursors": {},\n  "pinned": {}\n}\n')
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
        .toBe('{\n  "publishers": [\n    "a"\n  ],\n  "cursor": 7,\n  "cursors": {},\n  "pinned": {}\n}\n')
    })

    it('throws on a cursor that is not a count', () => {
      // Same posture as every other field here: a malformed build INPUT stops
      // the run rather than silently restarting the rotation at zero, which
      // would starve the tail of the vocabulary and look like nothing at all.
      expect(() => parsePublisherState('{"publishers":[],"cursor":-1}')).toThrow(/cursor/)
      expect(() => parsePublisherState('{"publishers":[],"cursor":1.5}')).toThrow(/cursor/)
      expect(() => parsePublisherState('{"publishers":[],"cursor":"3"}')).toThrow(/cursor/)
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

  it('throws on a dangerous pinned key rather than silently dropping it', () => {
    // out[keyword] = ... in readPinned is a bracket ASSIGNMENT; for
    // keyword === '__proto__' that invokes the inherited Object.prototype
    // accessor and reassigns the object's own prototype instead of creating a
    // visible property, so the entry silently vanishes from Object.keys with
    // no thrown error and no trace of what was lost. The JSON has to be a raw
    // string here, not a JS object literal with a `__proto__` key: `{
    // __proto__: [...] }` in source sets the new object's prototype at parse
    // time and never becomes an own property for JSON.stringify to see,
    // which is the opposite of what JSON.parse does to the same text.
    expect(() => parsePublisherState('{"publishers": [], "pinned": {"__proto__": ["a"]}}'))
      .toThrow(/pinned key "__proto__" is not a valid harvest keyword/)
    expect(() => parsePublisherState('{"publishers": [], "pinned": {"constructor": ["a"]}}'))
      .toThrow(/pinned key "constructor" is not a valid harvest keyword/)
    expect(() => parsePublisherState('{"publishers": [], "pinned": {"prototype": ["a"]}}'))
      .toThrow(/pinned key "prototype" is not a valid harvest keyword/)
  })

  it('throws on an empty or over-length pinned key', () => {
    const long = 'k'.repeat(129)
    expect(() => parsePublisherState(JSON.stringify({ publishers: [], pinned: { '': ['a'] } })))
      .toThrow(/pinned key "" is not a valid harvest keyword/)
    expect(() => parsePublisherState(JSON.stringify({ publishers: [], pinned: { [long]: ['a'] } })))
      .toThrow(/is not a valid harvest keyword/)
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

describe('atRiskNameCount', () => {
  it('does not count a name covered by a refinement', () => {
    const names = [{ keywords: ['dsh-plugin', 'agent'], maintainers: ['covered'] }]
    expect(atRiskNameCount(names, 'dsh-plugin', REFINEMENTS)).toBe(0)
  })

  it('counts a name carrying only the harvest keyword', () => {
    const names = [{ keywords: ['dsh-plugin'], maintainers: ['huanlin'] }]
    expect(atRiskNameCount(names, 'dsh-plugin', REFINEMENTS)).toBe(1)
  })

  it('counts an at-risk name even when its only maintainer fails the grammar, unlike atRiskOwners', () => {
    // The distinguishing case the correction exists for: atRiskOwners
    // aggregates OWNERS and has nothing to report once every maintainer of an
    // at-risk name fails isMaintainerName. atRiskNameCount counts NAMES and
    // must not inherit that blind spot, so both are asserted on one fixture.
    const names = [{ keywords: ['dsh-plugin'], maintainers: ['a'.repeat(200)] }]
    expect(atRiskOwners(names, 'dsh-plugin', REFINEMENTS)).toEqual([])
    expect(atRiskNameCount(names, 'dsh-plugin', REFINEMENTS)).toBe(1)
  })

  it('does not count a name with no keywords at all', () => {
    const names = [{ keywords: [], maintainers: ['x'] }]
    expect(atRiskNameCount(names, 'dsh-plugin', REFINEMENTS)).toBe(0)
  })
})

describe('MAX_PINNED_PER_KEYWORD', () => {
  it('is half the probe budget, so everything stored can also be probed', () => {
    // Asserted as the relation, not the literal. Rotation's half is guaranteed
    // by probeOrder itself (see 'never lets the pinned half take more than half
    // the budget'), so what this relation protects is the other direction: a
    // bound ABOVE half the budget lets a pinned set grow a tail probeOrder
    // never reaches, pinned in name only and silently -- the set size is
    // reported, the unreachable part of it is not.
    expect(MAX_PINNED_PER_KEYWORD * 2).toBe(PUBLISHER_PROBE_BUDGET_DEFAULT)
  })

  it('lets EVERY keyword hold a full pinned set and still probe all of it', () => {
    // The property the relation above exists for, asserted through the two
    // functions that actually enforce it rather than as arithmetic between two
    // literals. The worst case is every keyword at the bound at once: that is
    // when `allocateProbeBudgets` has to clamp, because the floors it would
    // otherwise honour (twice each pinned set) sum to the whole pool, and a
    // clamp that cut into a pinned set would leave `probeOrder` slicing the
    // same alphabetical prefix every run -- the tail pinned in name only, and
    // silently, since the axis line reports the set's SIZE and not how much of
    // it was reached.
    //
    // It is also the test that says what raising one of the two constants
    // costs: raise MAX_PINNED_PER_KEYWORD alone and this goes red, because
    // ⌊budget/2⌋ can no longer reach the bound.
    const pinned: Record<string, string[]> = {}
    for (const keyword of HARVEST_KEYWORDS) {
      pinned[keyword] = Array.from({ length: MAX_PINNED_PER_KEYWORD },
        (_, i) => `${keyword}-u${String(i).padStart(4, '0')}`)
    }
    const state: PublisherState = {
      publishers: Array.from({ length: 4_000 }, (_, i) => `v${i}`), pinned,
    }
    const budgets = allocateProbeBudgets(
      state,
      HARVEST_KEYWORDS.map(keyword => ({ keyword, tail: 1 })),
      PUBLISHER_PROBE_BUDGET_DEFAULT,
    )
    for (const keyword of HARVEST_KEYWORDS) {
      expect(
        probeOrder(state, keyword, budgets[keyword] ?? 0).pinned,
        `${keyword} holds ${MAX_PINNED_PER_KEYWORD} pins but was allocated ${budgets[keyword]} probes, `
        + 'so probeOrder can only reach half of that many',
      ).toHaveLength(MAX_PINNED_PER_KEYWORD)
    }
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

  it('throws on a dangerous keyword rather than crashing inside Set/Array logic', () => {
    // Historically: pinned['__proto__'] ?? [] in pinFor read through the
    // inherited Object.prototype accessor ('pinned' was a plain {} literal),
    // returning Object.prototype itself -- truthy, so `?? []` never fired --
    // and `new Set(Object.prototype)` threw "object is not iterable", a raw,
    // unfiled TypeError. unpinFor has the same construction and would have
    // thrown "pinned[keyword].filter is not a function" instead.
    expect(() => pinFor({ publishers: [] }, '__proto__', ['a']))
      .toThrow(/pinFor keyword "__proto__" is not a valid harvest keyword/)
    expect(() => unpinFor({ publishers: [] }, '__proto__', ['a']))
      .toThrow(/unpinFor keyword "__proto__" is not a valid harvest keyword/)
  })

  it('throws on constructor, prototype, and an empty or over-length keyword', () => {
    expect(() => pinFor({ publishers: [] }, 'constructor', ['a'])).toThrow(/is not a valid harvest keyword/)
    expect(() => pinFor({ publishers: [] }, 'prototype', ['a'])).toThrow(/is not a valid harvest keyword/)
    expect(() => pinFor({ publishers: [] }, '', ['a'])).toThrow(/is not a valid harvest keyword/)
    expect(() => pinFor({ publishers: [] }, 'k'.repeat(129), ['a'])).toThrow(/is not a valid harvest keyword/)
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

  it('rotates to nobody on an empty vocabulary rather than looping', () => {
    expect(probeOrder({ publishers: [], cursor: 0 }, 'k', 5)).toEqual({ pinned: [], rotated: [], stepped: 0 })
  })

  it('still probes the pinned set when the vocabulary is empty', () => {
    // A pin is not a member of the vocabulary -- it is read from `state.pinned`
    // and survives MAX_PUBLISHERS truncation -- so an empty vocabulary is a
    // reason to rotate to nobody, never a reason to stop probing pins.
    // Returning early above the pinned slice stranded them: never probed, so
    // never supplied and never evicted, with the axis line reading as an
    // ordinary empty-vocabulary no-op.
    expect(probeOrder({ publishers: [], pinned: { k: ['a', 'b'] } }, 'k', 5))
      .toEqual({ pinned: ['a', 'b'], rotated: [], stepped: 0 })
  })

  it('never lets the pinned half take more than half the budget', () => {
    // The guarantee has to be a property of this function, not a coincidence
    // between MAX_PINNED_PER_KEYWORD and a budget declared in another module.
    // Capping at `min(budget, MAX_PINNED_PER_KEYWORD)` meant any budget at or
    // below 250 -- a reduced-cost run, a rate-limit backoff, a future override
    // -- handed the whole budget to the pinned set, leaving `rotated` empty
    // and, with it, the cursor frozen: the starvation the cursor exists to
    // prevent, reached through the pinned set instead of through a fixed
    // prefix.
    const pinned = Array.from({ length: 10 }, (_, i) => `p${i}`)
    const order = probeOrder({ publishers: vocabulary, pinned: { k: pinned } }, 'k', 4)
    expect(order.pinned).toEqual(['p0', 'p1'])
    expect(order.rotated).toHaveLength(2)
  })
})

describe('the cursor advances by what the rotation WALKED', () => {
  it('advances by the positions walked, not by the budget and not by the rotation length', () => {
    const publishers = Array.from({ length: 100 }, (_, i) => `u${String(i).padStart(3, '0')}`)
    const state: PublisherState = { publishers, cursor: 0, pinned: { k: ['u099'] } }
    const order = probeOrder(state, 'k', 10)
    // Budget 10, capped at 5 pinned; `u099` is the only pin, so 1 pinned and 9
    // rotated, walking positions 0..8.
    expect(order.rotated).toHaveLength(9)
    expect(order.stepped).toBe(9)
    // Advancing by the budget would land on 10 and skip u009 forever.
    expect(cursorFor(advanceCursor(state, 'k', order.stepped), 'k')).toBe(9)
  })

  it('advances past a pinned publisher the walk stepped over but did not rotate to', () => {
    // `stepped` and `rotated.length` come apart exactly here: the walk
    // consumes the pinned candidate's position without returning it. Advancing
    // by the shorter figure restarts the next run INSIDE the band this one
    // already covered, re-probing it -- ~16 wasted probes a run at the 250-pin
    // bound over a 3,775-name vocabulary, and a correspondingly longer lap.
    const state: PublisherState = { publishers: ['u0', 'u1', 'u2', 'u3', 'u4'], cursor: 0, pinned: { k: ['u1'] } }
    const order = probeOrder(state, 'k', 4)
    expect(order.rotated).toEqual(['u0', 'u2', 'u3'])
    expect(order.stepped).toBe(4)
    // 3, the rotation length, would restart on u3 -- already probed this run.
    expect(cursorFor(advanceCursor(state, 'k', order.stepped), 'k')).toBe(4)
  })

  it('gives every keyword a lap of its own, so the more-pinned one is not starved', () => {
    // THE reason the cursor is per keyword. `probeOrder` leaves a keyword's
    // rotation `budget - |pinned[K]|` slots, so two keywords with different
    // pinned sets walk different distances; one shared cursor has to advance
    // by one of those distances and is wrong for the other keyword either way.
    // Advancing by the larger starved the more-pinned keyword -- and at a
    // vocabulary commensurate with the advance it starved it PERMANENTLY,
    // which is the case simulated here: 40 publishers, budget 10, 5 pins on
    // `heavy` (so it rotates 5 and the shared advance would be `light`'s 10).
    // 40 is a multiple of 10, so the shared cursor visits only 0/10/20/30 and
    // `heavy` sees positions 0-4 of each band and never 5-9, forever.
    const publishers = Array.from({ length: 40 }, (_, i) => `u${String(i).padStart(2, '0')}`)
    let state: PublisherState = { publishers, pinned: { heavy: ['p0', 'p1', 'p2', 'p3', 'p4'] } }
    const seen = new Set<string>()
    for (let run = 0; run < 20; run++) {
      const order = probeOrder(state, 'heavy', 10)
      for (const user of order.rotated) seen.add(user)
      state = advanceCursor(state, 'heavy', order.stepped)
      // The other keyword walks its own, longer band on its own cursor.
      state = advanceCursor(state, 'light', probeOrder(state, 'light', 10).stepped)
    }
    expect(seen.size).toBe(publishers.length)
  })

  it('holds the position when nothing was walked, rather than restarting at zero', () => {
    // A keyword that did not partition, or a run with no axis record at all,
    // walked nothing; snapping to the start of the vocabulary would abandon
    // the lap in progress.
    expect(cursorFor(advanceCursor({ publishers: ['a', 'b', 'c', 'd', 'e'], cursor: 3 }, 'k', 0), 'k')).toBe(3)
  })

  it('stays put when one run walks the whole vocabulary, rather than churning the file', () => {
    // Restored as arithmetic rather than as a special case: a run that walked
    // `size` positions lands on `(cursor + size) % size`, which is `cursor`.
    // Rotating a list every run can already probe is churn in a committed file
    // for nothing.
    const three = { publishers: ['a', 'b', 'c'] }
    expect(cursorFor(advanceCursor(three, 'k', probeOrder(three, 'k', 10).stepped), 'k')).toBe(0)
    expect(cursorFor(advanceCursor({ ...three, cursor: 2 }, 'k', 3), 'k')).toBe(2)
  })

  it('clamps a walk longer than the vocabulary, which only a handoff can claim', () => {
    // `probeOrder` stops at `stepped < size`, so a larger figure reaches
    // `advanceCursor` only from an untrusted `--harvest-from` record, which
    // `parsePublisherAxisReport` can hold to integer-ness but not to a
    // vocabulary it does not know. A full lap is the one reading that skips
    // nobody.
    expect(cursorFor(advanceCursor({ publishers: ['a', 'b', 'c'], cursor: 1 }, 'k', 100_000), 'k')).toBe(1)
  })

  it('throws on a dangerous keyword rather than corrupting the cursor map', () => {
    expect(() => advanceCursor({ publishers: ['a'] }, '__proto__', 1))
      .toThrow(/advanceCursor keyword "__proto__" is not a valid harvest keyword/)
  })

  it('seeds a keyword with no cursor of its own from the legacy field', () => {
    // The migration path, and the shape of today's committed file: it carries
    // `cursor` and no `cursors`.
    expect(cursorFor({ publishers: ['a', 'b'], cursor: 1 }, 'k')).toBe(1)
    expect(cursorFor({ publishers: ['a', 'b'], cursor: 1, cursors: { k: 0 } }, 'k')).toBe(0)
  })

  it('writes the legacy cursor as the minimum over the per-keyword ones', () => {
    // The only value that cannot put a reader AHEAD of a keyword's own lap: a
    // keyword joining the harvest starts where the vocabulary is least
    // covered, and a reader predating `cursors` re-probes a band rather than
    // skipping one.
    const raw = serializePublisherState({ publishers: ['a'], cursor: 9, cursors: { late: 7, early: 2 } })
    expect(JSON.parse(raw).cursor).toBe(2)
    expect(JSON.parse(raw).cursors).toEqual({ early: 2, late: 7 })
  })
})

describe('the pinned map cannot grow without bound or keep a key nothing uses', () => {
  it('drops an empty entry on READ, as every writer already does on write', () => {
    // `pinFor` and `unpinFor` delete a keyword whose list empties because
    // `serializePublisherState` copies every existing key forward, so an empty
    // entry once written round-trips forever. The parser was the one path that
    // did not hold to it, and self-healing reaches an entry only for a keyword
    // some axis report names -- a stale key is passed to neither writer.
    expect(parsePublisherState('{"publishers":[],"pinned":{"k":[]}}').pinned).toEqual({})
  })

  it('throws past MAX_PINNED_KEYWORDS rather than letting the map widen forever', () => {
    // MAX_PINNED_PER_KEYWORD caps the names under one key; nothing capped the
    // keys. Throws rather than truncating: the only writer is `pinFor`, which
    // cannot produce a key `retainPinned` has not kept, so a file over this
    // bound was hand-edited or badly merged and dropping keys silently would
    // discard real pins under the name of a repair.
    const wide = Object.fromEntries(
      Array.from({ length: MAX_PINNED_KEYWORDS + 1 }, (_, i) => [`k${i}`, ['owner']]),
    )
    expect(() => parsePublisherState(JSON.stringify({ publishers: [], pinned: wide })))
      .toThrow(/pinned names 17 keywords, more than the 16/)
  })

  it('prunes a key no current harvest keyword names, from both maps', () => {
    const state: PublisherState = {
      publishers: ['a'],
      cursors: { live: 5, renamed: 9 },
      pinned: { live: ['keepme'], renamed: ['dropme'] },
    }
    const kept = retainPinned(state, ['live'])
    expect(kept.pinned).toEqual({ live: ['keepme'] })
    expect(kept.cursors).toEqual({ live: 5 })
  })

  it('builds every map with a null prototype, including the paths that had a plain literal', () => {
    // The `DANGEROUS_KEYWORD_KEYS` comment rests its whole safety argument on
    // this, and names the three-name refusal as explicitly insufficient:
    // `toString` is admitted, and on a plain object `pinned['toString'] ?? []`
    // returns a function, so the fallback never fires and the spread throws
    // "is not iterable" as a raw, unfiled TypeError. Both offending paths were
    // live -- the absent-field return is what today's committed file takes,
    // and `mergePublishers` is what `build.ts` seeds from when the file is
    // missing altogether.
    const parsed = parsePublisherState('{"publishers":["a","b"],"cursor":0}')
    expect(Object.getPrototypeOf(parsed.pinned)).toBeNull()
    expect(() => probeOrder(parsed, 'toString', 2)).not.toThrow()
    const merged = mergePublishers({ publishers: ['a'] }, ['b'])
    expect(Object.getPrototypeOf(merged.pinned)).toBeNull()
    expect(() => probeOrder(merged, 'valueOf', 2)).not.toThrow()
  })
})

describe('applyAxisReport', () => {
  const base = (over: Partial<PublisherState> = {}): PublisherState =>
    ({ publishers: ['u0', 'u1', 'u2', 'u3'], ...over })
  const outcome = (over: Partial<Parameters<typeof applyAxisReport>[1]> = {}) =>
    ({ keyword: 'k', seedingComplete: false, seeded: [], evicted: [], stepped: 0, ...over })

  it('evicts before it pins, so this run\'s own harvest outlasts a contradicting probe', () => {
    // Both lists can name one maintainer: `seeded`'s atRiskOwners half reads
    // this run's harvest, and the probe that produced `evicted` can disagree
    // with it (a lagging search index, a rename, a scoped package whose
    // `maintainers` array and the `maintainer:` qualifier differ). Pinning
    // first let the probe win, and because atRiskOwners is recomputed from
    // scratch every run the two then ALTERNATED forever -- pinned on odd runs,
    // evicted on even ones, a diff in the committed file every other day and
    // the maintainer's cell probed on only half of all runs.
    const after = applyAxisReport(base({ pinned: { k: ['flap'] } }), outcome({ seeded: ['flap'], evicted: ['flap'] }))
    expect(after.state.pinned?.k).toEqual(['flap'])
  })

  it('reuses a slot freed this run, instead of refusing a seed while a dead pin holds it', () => {
    const full = Array.from({ length: MAX_PINNED_PER_KEYWORD }, (_, i) => `u${String(i).padStart(5, '0')}`)
    const after = applyAxisReport(
      base({ pinned: { k: full } }),
      outcome({ seeded: ['newresidueowner'], evicted: [full[0] as string] }),
    )
    expect(after.state.pinned?.k).toContain('newresidueowner')
    expect(after.refused).toEqual([])
  })

  it('reports what the bound refused, in the run that refused it', () => {
    // Derived from the PRIOR pinned set instead, the warning said nothing at
    // all on the one run where refusal began -- the set is still under the
    // bound when such a run starts -- and never said how many owners it cost.
    const full = Array.from({ length: MAX_PINNED_PER_KEYWORD }, (_, i) => `u${String(i).padStart(5, '0')}`)
    const after = applyAxisReport(base({ pinned: { k: full } }), outcome({ seeded: ['za', 'zb'] }))
    expect(after.refused).toEqual(['za', 'zb'])
  })

  it('does not report a name the bound never had a chance at', () => {
    // Outside the grammar is not "refused for want of a slot", and reporting
    // it as such sends a reader looking for a full set that is not there.
    expect(applyAxisReport(base(), outcome({ seeded: ['ok', 'Not A Name'] })).refused).toEqual([])
  })

  it('removes a pin the complete seeding of an un-partitioned keyword does not name', () => {
    // Entry runs for every keyword; exit is `selectPublisherCells`'s alone and
    // that only runs once a keyword partitions. Without this the pinned set of
    // a keyword still inside its window is MONOTONE -- it climbs to the bound
    // and then reports itself FULL about a set nothing has ever probed. Under
    // the window every name was paged, so `seeded` IS the whole at-risk owner
    // set and a pin it omits has stopped being at risk.
    const after = applyAxisReport(
      base({ pinned: { k: ['gone', 'still'] } }),
      outcome({ seedingComplete: true, seeded: ['still'] }),
    )
    expect(after.state.pinned?.k).toEqual(['still'])
  })

  it('keeps a pin the partial seeding of a partitioned keyword does not name', () => {
    // The mirror image, and the reason the two cases cannot share a rule: past
    // the window `seeded` is only what the window sweep showed, and the owners
    // this axis exists for are precisely the ones it cannot show.
    const after = applyAxisReport(
      base({ pinned: { k: ['past-the-window', 'still'] } }),
      outcome({ seedingComplete: false, seeded: ['still'] }),
    )
    expect(after.state.pinned?.k).toEqual(['past-the-window', 'still'])
  })

  it('advances only its own keyword\'s cursor', () => {
    const after = applyAxisReport(base({ cursors: { k: 1, other: 2 } }), outcome({ stepped: 2 }))
    expect(after.state.cursors).toEqual({ k: 3, other: 2 })
  })
})

describe('allocateProbeBudgets', () => {
  /**
   * The two harvest keywords as the 2026-09-19 build measured them: tails of
   * 376 and 1,969 names past the window, pinned sets of 45 and 228. That run
   * spent 500 probes on each keyword and the published report records what it
   * bought — `dsh-plugin` recovered 0 names against a residual of 1, while
   * `deepseek-harness` recovered 13 against a residual of 15.
   */
  const measured = [
    { keyword: 'dsh-plugin', tail: 376 },
    { keyword: 'deepseek-harness', tail: 1969 },
  ] as const
  const shipped: PublisherState = {
    publishers: Array.from({ length: 3887 }, (_, i) => `u${i}`),
    pinned: {
      'dsh-plugin': Array.from({ length: 45 }, (_, i) => `a${i}`),
      'deepseek-harness': Array.from({ length: 228 }, (_, i) => `b${i}`),
    },
  }
  const sum = (budgets: Readonly<Record<string, number>>): number =>
    Object.values(budgets).reduce((a, b) => a + b, 0)

  it('spends exactly the pool the flat per-keyword budget spent', () => {
    // The whole change is a REDISTRIBUTION. Two over-window keywords at 500
    // each cost 1,000 probes before and must cost 1,000 after, or this buys
    // its coverage with wall clock and rate-limit exposure the budget comment
    // sized deliberately.
    expect(sum(allocateProbeBudgets(shipped, measured, 500))).toBe(1000)
  })

  it('sends the probes to the keyword that holds the tail', () => {
    // 1,969 names past the window against 376 — a 5.2x demand ratio answered
    // with an even split, and worse than even: probeOrder caps the pinned half
    // at floor(budget/2), so the keyword with the SMALLER pinned set took the
    // larger rotation (455 against 272) on the run this fixture is taken from.
    const budgets = allocateProbeBudgets(shipped, measured, 500)
    const light = budgets['dsh-plugin'] ?? 0
    const heavy = budgets['deepseek-harness'] ?? 0
    expect(heavy).toBeGreaterThan(light * 4)
  })

  it('gives a lone over-window keyword exactly the budget it had before', () => {
    // The pool is the per-keyword budget times the keywords that partition, so
    // one crossing keyword is allocated precisely what the flat rule gave it.
    // Without this the same constant would mean two different spends depending
    // on how many keywords happened to cross that day.
    const budgets = allocateProbeBudgets(shipped, [{ keyword: 'deepseek-harness', tail: 1969 }], 500)
    expect(budgets['deepseek-harness']).toBe(500)
  })

  it('spends nothing on a keyword inside the window, and does not pool for it', () => {
    // A keyword under the window never partitions, so it never reaches the
    // probe pass at all. Counting it into the pool would hand the crossing
    // keyword a budget nobody measured.
    const budgets = allocateProbeBudgets(shipped, [
      { keyword: 'dsh-plugin', tail: 0 },
      { keyword: 'deepseek-harness', tail: 1969 },
    ], 500)
    expect(budgets['dsh-plugin'] ?? 0).toBe(0)
    expect(budgets['deepseek-harness']).toBe(500)
  })

  it('never drops a keyword below the budget that probes its whole pinned set', () => {
    // The floor, and the reason it is 2x the pinned set rather than 1x:
    // `probeOrder` caps the pinned half at floor(budget/2). A pin that is not
    // probed supplies nothing and is never evicted either, so starving the
    // pinned half raises the very residual this allocation exists to lower —
    // and the pinned half is the productive one (13 of 13 recoveries on the
    // 2026-09-19 run came from it).
    const budgets = allocateProbeBudgets(
      { publishers: [], pinned: { small: Array.from({ length: 250 }, (_, i) => `p${i}`) } },
      [{ keyword: 'small', tail: 1 }, { keyword: 'huge', tail: 100_000 }],
      500,
    )
    expect(budgets['small']).toBeGreaterThanOrEqual(500)
    // The property itself, not just the arithmetic behind it: the floor exists
    // so `probeOrder`'s cap never truncates a pinned set, and the two live in
    // different functions.
    expect(probeOrder(
      { publishers: [], pinned: { small: Array.from({ length: 250 }, (_, i) => `p${i}`) } },
      'small', budgets['small'] ?? 0,
    ).pinned).toHaveLength(250)
  })

  it('keeps a keyword with no pins rotating, so it can seed its first one', () => {
    // The standing-start trap, per keyword. A pinned set accumulates across
    // runs and only the rotation can seed the first entry, so an allocation
    // that rounds a small-tailed keyword to nothing locks it at zero pins
    // forever — the same failure MAX_UNREACHABLE_RESIDUAL's comment records
    // for the axis as a whole.
    const budgets = allocateProbeBudgets(
      { publishers: Array.from({ length: 3887 }, (_, i) => `u${i}`) },
      [{ keyword: 'tiny', tail: 1 }, { keyword: 'huge', tail: 1_000_000 }],
      500,
    )
    expect(budgets['tiny']).toBeGreaterThanOrEqual(MIN_PROBE_BUDGET_PER_KEYWORD)
  })

  it('still never exceeds the pool when the floors alone would', () => {
    // A reduced-cost run, or a rate-limit backoff, hands this a budget smaller
    // than the floors. The budget is a CAP before it is an allocation — the
    // one it replaced spent 57m37s on 3,474 sequential probes and threw.
    const budgets = allocateProbeBudgets(shipped, measured, 10)
    expect(sum(budgets)).toBeLessThanOrEqual(20)
    expect(sum(budgets)).toBe(20)
  })

  it('allocates whole probes, and the same ones whatever order it is asked in', () => {
    // A probe is a request; a fractional one cannot be spent. Largest
    // remainder rather than rounding, so the shares sum to the pool exactly,
    // and the tie-break is the keyword's own position so two runs over the
    // same measurements allocate identically.
    const forward = allocateProbeBudgets(shipped, measured, 500)
    const reversed = allocateProbeBudgets(shipped, [...measured].reverse(), 500)
    expect(Object.values(forward).every(Number.isInteger)).toBe(true)
    expect(reversed['dsh-plugin']).toBe(forward['dsh-plugin'])
    expect(reversed['deepseek-harness']).toBe(forward['deepseek-harness'])
  })

  it('allocates nothing at all when the budget is zero or negative', () => {
    expect(sum(allocateProbeBudgets(shipped, measured, 0))).toBe(0)
    expect(sum(allocateProbeBudgets(shipped, measured, -5))).toBe(0)
  })
})
