import { describe, expect, it } from 'vitest'
import { readRepoPins, writeRepoPins, type RepoPinFs } from '../../src/host/repo-pins.ts'

function memFs(): RepoPinFs & { files: Map<string, string> } {
  const files = new Map<string, string>()
  return {
    files,
    exists: path => files.has(path),
    read: path => files.get(path) ?? '',
    write: (path, data) => { files.set(path, data) },
  }
}

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
    fs.files.set('/pins.json', JSON.stringify({
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
    fs.files.set('/pins.json', JSON.stringify({ 'dsh-real': commit }))
    const pins = readRepoPins(fs, '/pins.json')
    for (const inherited of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__']) {
      expect(pins[inherited], `${inherited} answered a lookup`).toBeUndefined()
    }
    expect(pins['dsh-real']).toBe(commit)
  })

  it('reads a missing or corrupt file as no memory', () => {
    const fs = memFs()
    expect(readRepoPins(fs, '/pins.json')).toEqual({})
    fs.files.set('/pins.json', 'not json')
    expect(readRepoPins(fs, '/pins.json')).toEqual({})
    fs.files.set('/pins.json', '[1,2,3]')
    expect(readRepoPins(fs, '/pins.json')).toEqual({})
  })
})
