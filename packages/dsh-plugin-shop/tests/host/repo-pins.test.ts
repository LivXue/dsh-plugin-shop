import { describe, expect, it } from 'vitest'
import { readRepoPins, writeRepoPins } from '../../src/host/repo-pins.ts'
// `RepoPinFs` is `CatalogFs`'s shape, so the shared fixture serves it. It was
// the fourth hand-rolled copy in this directory and carried the same two
// weaknesses as the others — a raw-string key and a `read` that answers `''`
// where the real one throws — dormant only because `repo-pins.ts` never
// builds a path of its own. See `mem-fs.ts`.
import { memCatalogFs as memFs } from './mem-fs.ts'

describe('readRepoPins', () => {
  const commit = 'a'.repeat(40)

  it('round-trips a commit pin', () => {
    const fs = memFs()
    writeRepoPins(fs, '/pins.json', { 'github:owner/slug#': commit })
    expect(readRepoPins(fs, '/pins.json')).toEqual({ 'github:owner/slug#': commit })
  })

  it('round-trips a release-tag pin (G-11)', () => {
    const fs = memFs()
    writeRepoPins(fs, '/pins.json', { 'github:owner/slug#': 'v1.0.0', 'github:o/s2#': 'release/1.0' })
    expect(readRepoPins(fs, '/pins.json')).toEqual({
      'github:owner/slug#': 'v1.0.0',
      'github:o/s2#': 'release/1.0',
    })
  })

  it('still drops a value that is neither a commit nor a tag', () => {
    const fs = memFs()
    fs.write('/pins.json', JSON.stringify({
      good: commit,
      spaced: 'v1.0.0 & calc.exe',
      empty: '',
      numeric: 7,
      nested: { v: commit },
    }))
    expect(readRepoPins(fs, '/pins.json')).toEqual({ good: commit })
  })

  it('never answers a lookup from Object.prototype', () => {
    // The lookup key is a catalog entry name — hostile npm/GitHub input — and
    // `constructor`, `toString` and `valueOf` are all legal npm package names,
    // while a GitHub bundle name is unrestricted. On a prototype-bearing
    // record each of them reads a FUNCTION, which `pins[entry.name] !==
    // undefined` accepts as a recorded pin: host/index.ts then reports a
    // function as the installed commit, with outdated: true, for a package
    // that was never installed.
    const fs = memFs()
    fs.write('/pins.json', JSON.stringify({ 'dsh-real': commit }))
    const pins = readRepoPins(fs, '/pins.json')
    for (const inherited of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__']) {
      expect(pins[inherited], `${inherited} answered a lookup`).toBeUndefined()
    }
    expect(pins['dsh-real']).toBe(commit)
  })

  it('reads a missing or corrupt file as no memory', () => {
    const fs = memFs()
    expect(readRepoPins(fs, '/pins.json')).toEqual({})
    fs.write('/pins.json', 'not json')
    expect(readRepoPins(fs, '/pins.json')).toEqual({})
    fs.write('/pins.json', '[1,2,3]')
    expect(readRepoPins(fs, '/pins.json')).toEqual({})
  })
})
