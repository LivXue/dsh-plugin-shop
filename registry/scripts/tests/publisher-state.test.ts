import { describe, expect, it } from 'vitest'
import {
  MAINTAINER_MAX_LENGTH, isMaintainerName, mergePublishers,
  parsePublisherState, serializePublisherState,
} from '../src/publisher-state.ts'

describe('isMaintainerName', () => {
  it('accepts npm account grammar and nothing else', () => {
    // This value is interpolated into a search `text=`, so the grammar IS the
    // boundary that keeps it safe. npm usernames are lowercase letters,
    // digits, hyphen, underscore and dot.
    expect(isMaintainerName('ok-name_1.2')).toBe(true)
    expect(isMaintainerName('a b')).toBe(false)
    expect(isMaintainerName('UPPER')).toBe(false)
    expect(isMaintainerName('has:colon')).toBe(false)
    expect(isMaintainerName('')).toBe(false)
    expect(isMaintainerName(7)).toBe(false)
    expect(isMaintainerName(null)).toBe(false)
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
    expect(() => parsePublisherState(`{"publishers": ["${'x'.repeat(65)}"]}`)).toThrow(/publishers\[0\]/)
  })

  it('carries an unknown key through rather than refusing the file', () => {
    // Two entry points read this file and may be different versions mid-
    // deploy. An older reader must not refuse a newer file over a key it does
    // not know; it reads `publishers` and ignores the rest.
    const raw = '{\n  "publishers": [\n    "alice"\n  ],\n  "note": "hand-written"\n}\n'
    expect(parsePublisherState(raw).publishers).toEqual(['alice'])
  })
})
