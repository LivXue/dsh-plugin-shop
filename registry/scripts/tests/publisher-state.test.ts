import { describe, expect, it } from 'vitest'
import {
  MAINTAINER_MAX_LENGTH, MAX_PUBLISHERS, isMaintainerName, mergePublishers,
  parsePublisherState, serializePublisherState,
} from '../src/publisher-state.ts'

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
    expect(raw).toBe('{\n  "publishers": [\n    "bowenliang123",\n    "sayedev"\n  ]\n}\n')
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
      .toBe('{\n  "publishers": [\n    "a"\n  ]\n}\n')
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
