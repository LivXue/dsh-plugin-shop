/**
 * The fixture's keying, pinned to the product's own path building.
 *
 * `catalog.test.ts` seeds a cache and `hot.test.ts` seeds an installed
 * package, both as POSIX literals, and the product then looks the same file
 * up through `join` (catalog.ts) or `resolve` (hot.ts). That coupling held by
 * inspection, was stated nowhere, and quietly stopped holding on Windows —
 * where those two spellings differ from the literal and from each other. Some
 * of the cases it took down went red; others kept passing while proving
 * nothing, which is the half no run reports.
 *
 * So the coupling is asserted rather than assumed, the way
 * `github-client.test.ts` asserts the body-cap habit over the source instead
 * of trusting each call site. Two of the three cases below discriminate on
 * every platform; the drive-prefix one can only fail on Windows, which is the
 * argument for the `windows-latest` leg in `plugin.yml` rather than a reason
 * to leave it unwritten.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { memCatalogFs, memHotFs, memKey } from './mem-fs.ts'

describe('memKey', () => {
  it('finds a POSIX-literal seed through the product\'s join and resolve', () => {
    const fs = memCatalogFs()
    fs.write('/cache/index.json', 'pointer')
    // catalog.ts addresses the cache with join(cacheDir, …); hot.ts addresses
    // a package file with resolve(packageDir, …). On Windows those answer
    // `\cache\index.json` and `D:\cache\index.json` — neither of which is the
    // string the seed was written as.
    expect(fs.exists(join('/cache', 'index.json'))).toBe(true)
    expect(fs.exists(resolve('/cache', 'index.json'))).toBe(true)
    expect(fs.read(join('/cache', 'index.json'))).toBe('pointer')
  })

  it('keys on the resolved path, not the raw string', () => {
    // Discriminates on POSIX too, so CI can see a regression to raw-string
    // keying: `.` is collapsed by resolve on every platform, and a raw key
    // would store one spelling and miss the other here as surely as it missed
    // the drive prefix on Windows.
    const fs = memCatalogFs()
    fs.write('/cache/./index.json', 'pointer')
    expect(fs.exists('/cache/index.json')).toBe(true)
  })

  it('keeps two paths distinct exactly when the platform does', () => {
    // A literal backslash is a legal POSIX filename character, so
    // `/cache/a\b.json` and `/cache/a/b.json` are two files there and must
    // stay two keys; on Windows they are one file and one key is right.
    // Expressed against `resolve` rather than hard-coded, so the case reads
    // the same on both — and a key built by replacing backslashes wholesale
    // goes red on POSIX, where it would fuse the two.
    const backslash = '/cache/a\\b.json'
    const slash = '/cache/a/b.json'
    expect(memKey(backslash) === memKey(slash)).toBe(resolve(backslash) === resolve(slash))
  })
})

describe('memCatalogFs', () => {
  it('throws on a missing read, like readFileSync', () => {
    // A fake answering '' cannot express "absent"; it agrees with the product
    // only because '' reaches JSON.parse and lands in the same catch a real
    // ENOENT would, so a read moved out of its try would stay green here and
    // throw on a real first boot.
    expect(() => memCatalogFs().read('/cache/index.json')).toThrow(/ENOENT/)
  })

  it('records write order and can fail a write', () => {
    const fs = memCatalogFs(path => (path.endsWith('index.json') ? 'EACCES: permission denied' : null))
    fs.write('/cache/plugins.abc.json', 'data')
    expect(() => fs.write('/cache/index.json', 'pointer')).toThrow(/EACCES/)
    // The data file landed and the pointer did not — the shape loadCatalog's
    // ordering has to survive.
    expect(fs.written()).toEqual([memKey('/cache/plugins.abc.json')])
    expect(fs.exists('/cache/index.json')).toBe(false)
  })
})

/** A hand-rolled store whose keying is deliberately its own takes an entry
 * here, naming why. Keyed by SNIPPET rather than by file, matching
 * `EXCUSED_BODY_READS` in `github-client.test.ts`: a line number goes stale on
 * the next edit above it, and a whole-file excuse hides the second store
 * someone adds later. */
const EXCUSED_STORES: readonly { snippet: string; reason: string }[] = []

describe('every in-memory filesystem in tests/host comes from mem-fs.ts', () => {
  // The structural half of this fix. The keying rule above is only worth
  // anything while it is the ONLY one: four copies of this fake existed, two
  // over the same interface driving the same loader, and fixing one of them
  // left the same defect live next door — dormant, undetectable, and
  // indistinguishable from fixed. A comment asking the next person to reuse
  // the shared fixture is not enforcement; this is.
  const hostDir = fileURLToPath(new URL('.', import.meta.url))
  const store = /new Map<\s*string\s*,\s*string\s*>\s*\(/
  const files = readdirSync(hostDir).filter(name => name.endsWith('.ts') && name !== 'mem-fs.ts')

  it('finds the shared store at all, so the scan cannot pass by matching nothing', () => {
    // Without this, a regex that stops matching turns the exhaustiveness
    // check below into a scan over nothing — green, and guarding nothing.
    const shared = readFileSync(join(hostDir, 'mem-fs.ts'), 'utf8').split('\n').filter(l => store.test(l))
    expect(shared.length).toBeGreaterThanOrEqual(2)
    expect(files.length).toBeGreaterThan(5)
  })

  it('declares no second one', () => {
    const offenders: string[] = []
    for (const name of files) {
      for (const [index, line] of readFileSync(join(hostDir, name), 'utf8').split('\n').entries()) {
        // Prose about a store is not a store; this file's own comments say
        // `new Map<string, string>()` while arguing against writing one.
        const code = line.trim()
        if (code.startsWith('//') || code.startsWith('*') || code.startsWith('/*')) continue
        if (!store.test(code)) continue
        if (EXCUSED_STORES.some(e => code.includes(e.snippet))) continue
        offenders.push(`${name}:${index + 1}: ${code}`)
      }
    }
    expect(
      offenders,
      'these hand-roll a path-keyed store instead of importing memCatalogFs/memHotFs from mem-fs.ts;\n'
        + 'reuse it, or add the line to EXCUSED_STORES with the reason its keying has to differ:\n'
        + offenders.join('\n'),
    ).toEqual([])
  })
})

describe('memHotFs', () => {
  it('throws from list until a write registers the directory, then lists it', () => {
    // nextHotNumber CATCHES this throw to mean "no namespace directory yet,
    // start at hot-1.yml", so a list answering [] would exercise a branch
    // hot.ts does not have.
    const fs = memHotFs()
    expect(() => fs.list('/home/user/.dsh/.dsh-shop')).toThrow(/ENOENT/)
    fs.write(join('/home/user/.dsh/.dsh-shop', 'hot-1.yml'), '- id: mkt-a\n  name: a\n')
    expect(fs.list('/home/user/.dsh/.dsh-shop')).toEqual(['hot-1.yml'])
    // The prefix scan must not leak the parent's other children into a
    // listing of the child directory.
    fs.write('/home/user/.dsh/settings.yaml', 'x')
    expect(fs.list('/home/user/.dsh/.dsh-shop')).toEqual(['hot-1.yml'])
  })
})
