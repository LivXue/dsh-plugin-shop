import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { EMPTY_SHOP_STATE, FAVORITES_MAX, PREVIOUS_MAX, readShopState, rollbackSpec, statePath, writeShopState, type ShopState } from '../../src/host/state.ts'
import { memHotFs } from './mem-fs.ts'

/**
 * The state file over the shared in-memory filesystem. `memHotFs` is the same
 * two methods `ShopStateFs` asks for (a throwing `read`, a registering
 * `write`), and reusing it keeps the keying rule of `mem-fs.ts` — resolved,
 * forward-slashed — rather than a second spelling of it.
 */
function bench(initial?: string) {
  const fs = memHotFs()
  if (initial !== undefined) fs.write(statePath(PROFILE), initial)
  return fs
}

const PROFILE = '/profile'

describe('the profile state file', () => {
  it('lives under .dsh-shop, where the boot wipe does not reach', () => {
    // Built with `join`, never as a POSIX literal: the product composes the
    // path with `join` too, and on Windows the two spellings differ (the
    // rule `mem-fs.ts` records for every path fixture in this directory).
    expect(statePath(PROFILE)).toBe(join(PROFILE, '.dsh-shop', 'state.json'))
  })

  it('reads a missing file as empty state', () => {
    expect(readShopState(bench(), PROFILE)).toEqual(EMPTY_SHOP_STATE)
  })

  it('reads an unparseable file as empty state rather than throwing', () => {
    expect(readShopState(bench('{not json'), PROFILE)).toEqual(EMPTY_SHOP_STATE)
  })

  it('reads a non-object document as empty state', () => {
    expect(readShopState(bench('[]'), PROFILE)).toEqual(EMPTY_SHOP_STATE)
  })

  it('keeps the favorites a corrupt previous map cannot cost', () => {
    // The halves are validated apart on purpose: the file is a reading aid,
    // and a broken rollback record must not take the reader's stars with it.
    const fs = bench(JSON.stringify({ favorites: ['npm:a'], previous: { 'npm:a': { source: 'npm' } } }))
    expect(readShopState(fs, PROFILE)).toEqual({ favorites: ['npm:a'], previous: {} })
  })

  it('keeps the rollback records a corrupt favorites list cannot cost', () => {
    const fs = bench(JSON.stringify({
      favorites: 'nope',
      previous: { 'npm:a': { source: 'npm', name: 'a', version: '1.0.0' } },
    }))
    expect(readShopState(fs, PROFILE).previous).toEqual({ 'npm:a': { source: 'npm', name: 'a', version: '1.0.0' } })
  })

  it('drops a favorite that is not a string, and a duplicate', () => {
    const fs = bench(JSON.stringify({ favorites: ['npm:a', 7, '', 'npm:a', null] }))
    expect(readShopState(fs, PROFILE).favorites).toEqual(['npm:a'])
  })

  it('drops a github record with no repository — it could not be spelled back into a spec', () => {
    const fs = bench(JSON.stringify({
      previous: {
        'github:o/r': { source: 'github', name: 'r', version: 'a'.repeat(40) },
        'npm:a': { source: 'npm', name: 'a', version: '1.0.0' },
      },
    }))
    expect(Object.keys(readShopState(fs, PROFILE).previous)).toEqual(['npm:a'])
  })

  it('drops a record whose version is not a string', () => {
    const fs = bench(JSON.stringify({ previous: { 'npm:a': { source: 'npm', name: 'a', version: 1 } } }))
    expect(readShopState(fs, PROFILE).previous).toEqual({})
  })

  it('bounds the lists it reads, so a hand-edited file cannot make every render walk it', () => {
    const favorites = Array.from({ length: FAVORITES_MAX + 5 }, (_, i) => `npm:p${i}`)
    const previous = Object.fromEntries(Array.from({ length: PREVIOUS_MAX + 5 }, (_, i) => [`npm:p${i}`, { source: 'npm', name: `p${i}`, version: '1.0.0' }]))
    const fs = bench(JSON.stringify({ favorites, previous }))
    const state = readShopState(fs, PROFILE)
    expect(state.favorites).toHaveLength(FAVORITES_MAX)
    expect(Object.keys(state.previous)).toHaveLength(PREVIOUS_MAX)
  })

  it('writes normalized JSON with one trailing newline, and reads it back unchanged', () => {
    const fs = bench()
    const state: ShopState = {
      favorites: ['npm:a', 'npm:a'],
      previous: { 'npm:a': { source: 'npm', name: 'a', version: '1.0.0' } },
    }
    writeShopState(fs, PROFILE, state)
    const text = fs.read(statePath(PROFILE))
    expect(text.endsWith('}\n')).toBe(true)
    expect(readShopState(fs, PROFILE)).toEqual({
      favorites: ['npm:a'],
      previous: { 'npm:a': { source: 'npm', name: 'a', version: '1.0.0' } },
    })
  })

  it('replaces a malformed file with a valid one on the next write', () => {
    const fs = bench('{not json')
    writeShopState(fs, PROFILE, { favorites: ['npm:a'], previous: {} })
    expect(readShopState(fs, PROFILE).favorites).toEqual(['npm:a'])
  })
})

describe('the rollback spec', () => {
  it('is the pinned npm version, never a range', () => {
    expect(rollbackSpec({ source: 'npm', name: 'dsh-a', version: '1.2.3' })).toBe('dsh-a@1.2.3')
    expect(rollbackSpec({ source: 'npm', name: '@scope/a', version: '1.2.3-beta.1' })).toBe('@scope/a@1.2.3-beta.1')
  })

  it('refuses an npm version that is a range — it would resolve forward, not back', () => {
    expect(rollbackSpec({ source: 'npm', name: 'dsh-a', version: '^1.2.3' })).toBeUndefined()
    expect(rollbackSpec({ source: 'npm', name: 'dsh-a', version: 'latest' })).toBeUndefined()
  })

  it('is the pinned commit for a github entry, subdirectory included', () => {
    const commit = '0123456789abcdef0123456789abcdef01234567'
    expect(rollbackSpec({ source: 'github', name: 'r', repo: 'o/r', version: commit }))
      .toBe(`github:o/r#${commit}`)
    expect(rollbackSpec({ source: 'github', name: 'r', repo: 'o/r', subdir: 'packages/x', version: commit }))
      .toBe(`github:o/r#${commit}&path:packages/x`)
  })

  it('refuses a github record whose version is not a commit', () => {
    expect(rollbackSpec({ source: 'github', name: 'r', repo: 'o/r', version: 'v1.0.0' })).toBeUndefined()
  })
})
