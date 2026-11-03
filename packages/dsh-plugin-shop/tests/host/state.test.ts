import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { emptyShopState, FAVORITES_MAX, PREVIOUS_MAX, readShopState, rollbackSpec, shopStateFsFor, statePath, writeShopState, type ShopState } from '../../src/host/state.ts'
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
    expect(readShopState(bench(), PROFILE)).toEqual(emptyShopState())
  })

  it('reads an unparseable file as empty state rather than throwing', () => {
    expect(readShopState(bench('{not json'), PROFILE)).toEqual(emptyShopState())
  })

  it('reads a non-object document as empty state', () => {
    expect(readShopState(bench('[]'), PROFILE)).toEqual(emptyShopState())
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

  it("hands out a fresh empty state, so one caller's mutation is not the next one's", () => {
    // Both writers mutate what they are handed. A shared constant made a
    // failed save visible to the next reader — and a test comparing against
    // that same constant could not see it.
    const first = readShopState(bench(), PROFILE)
    first.favorites.push('npm:leaked')
    const second = readShopState(bench(), PROFILE)
    expect(second.favorites).toEqual([])
    expect(first).not.toBe(second)
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

describe('the writer (the Windows path every state test used to skip)', () => {
  /** IO whose rename can be scripted, so the EPERM retry runs on any host. */
  function ioWith(renames: Array<string | Error>): { io: Parameters<typeof shopStateFsFor>[0]; removed: string[]; written: string[]; waits: number[] } {
    const removed: string[] = []
    const written: string[] = []
    const waits: number[] = []
    let attempt = 0
    const io = {
      read: () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) },
      mkdir: () => {},
      writeFile: (path: string) => { written.push(path) },
      rename: (_from: string, to: string) => {
        const step = renames[Math.min(attempt, renames.length - 1)]
        attempt += 1
        if (step instanceof Error) throw step
        void to
      },
      remove: (path: string) => { removed.push(path) },
      wait: (ms: number) => { waits.push(ms) },
      processId: 4242,
    }
    return { io, removed, written, waits }
  }

  const eperm = (): Error => Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' })

  it('retries a rename Windows refused, and succeeds without touching the scratch cleanup', () => {
    const { io, removed, waits } = ioWith([eperm(), eperm(), 'ok'])
    shopStateFsFor(io).write('/p/.dsh-shop/state.json', '{}')
    expect(waits).toEqual([20, 20])
    expect(removed).toEqual([])
  })

  it('gives up after five tries and removes the scratch file', () => {
    const { io, removed, written } = ioWith([eperm()])
    expect(() => shopStateFsFor(io).write('/p/.dsh-shop/state.json', '{}')).toThrow(/EPERM/)
    expect(removed).toEqual(written)
  })

  it('does not retry a code Windows only reports once, and cleans up', () => {
    const { io, removed, waits } = ioWith([Object.assign(new Error('EACCES'), { code: 'EACCES' })])
    expect(() => shopStateFsFor(io).write('/p/.dsh-shop/state.json', '{}')).toThrow(/EACCES/)
    expect(waits).toEqual([])
    expect(removed).toHaveLength(1)
  })

  it('names each scratch file for its process and its write, never one fixed .tmp', () => {
    const { io, written } = ioWith(['ok'])
    const fs = shopStateFsFor(io)
    fs.write('/p/.dsh-shop/state.json', '{}')
    fs.write('/p/.dsh-shop/state.json', '{}')
    expect(written).toHaveLength(2)
    expect(written[0]).not.toBe(written[1])
    expect(written.every(path => path.includes('.4242.'))).toBe(true)
  })
})

describe('a read that failed is not an absent file', () => {
  it('rethrows a non-ENOENT read error instead of answering empty state', () => {
    // Both callers write what they are handed: reading EACCES as "no state
    // yet" is what let a failed save overwrite an intact file.
    const fs = { read: () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }) }, write: () => {} }
    expect(() => readShopState(fs, '/profile')).toThrow(/EACCES/)
  })
})
