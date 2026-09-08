/**
 * In-memory filesystems for the host tests: two fakes over two product
 * interfaces, one keying rule.
 *
 * One module rather than a copy per file. `tests/host/` had four `memFs`
 * definitions, two of them over the same `CatalogFs` driving the same
 * `loadCatalog`, and only one of them was ever fixed — so the same POSIX
 * path assumption stayed live next door to its own fix, dormant only because
 * no case in that file happened to seed a cache. This mirrors
 * `registry/scripts/tests/packed-tarball.ts`, and `temp-root.ts` beside it.
 */

import { dirname, resolve, sep } from 'node:path'
import type { CatalogFs } from '../../src/host/catalog.ts'
import type { HotFs } from '../../src/host/hot.ts'

/**
 * The key a path is stored under: resolved, then rewritten with forward
 * slashes.
 *
 * Test data here is written as POSIX literals — `'/cache'`,
 * `'/home/user/.dsh'` — because a path reads as a path, while a literal
 * naming whatever drive the checkout happens to sit on does not. The product
 * then addresses the same file through `join()` or `resolve()`, and on Windows
 * those two disagree with each other AND with the literal: measured,
 * `join('/cache', 'index.json')` is `\cache\index.json` and carries no drive,
 * while `resolve` of either is `D:\cache\index.json` and carries the drive of
 * the current working directory. Keyed on the raw string, a seed and the
 * lookup that should have found it were three different spellings.
 *
 * Both ends are therefore settled the same way, and each half of that is
 * load-bearing — measured on the two files this fixture serves:
 *
 *  - `resolve` supplies the drive and the separators the OS would have
 *    supplied anyway. Forward-slashing alone makes `'/cache/index.json'` and
 *    `join`'s `\cache\index.json` meet, but leaves `hot.ts`'s
 *    `resolve(packageDir, …)` missing its seed by the drive prefix.
 *  - splitting on the PLATFORM separator and rejoining on `/` is what lets
 *    `memHotFs`'s `list` scan by a `<dir>/` prefix. `resolve` alone leaves
 *    backslash keys that no `/`-terminated prefix matches — it fixes the
 *    lookup and breaks the listing.
 *
 * Splitting on `sep` rather than on both separators is also what keeps
 * distinct files distinct. A literal backslash is a legal POSIX FILENAME
 * character, so `/cache/a\b.json` and `/cache/a/b.json` are two files there
 * and stay two keys; on Windows they are one file and one key is the right
 * answer. Both measured, and `mem-fs.test.ts` pins them.
 */
export function memKey(path: string): string {
  return resolve(path).split(sep).join('/')
}

export interface MemCatalogFs extends CatalogFs {
  /** Every path written so far, in write order, keyed as above — for
   * asserting the ORDER in which a load commits its cache. */
  written: () => string[]
}

/**
 * An in-memory {@link CatalogFs}.
 *
 * Faithful to `catalog.ts`'s own `nodeFs` in the two ways a fake otherwise
 * papers over:
 *
 *  - `read` THROWS on a missing path, because `readFileSync` does. A fake
 *    returning `''` cannot express "absent" and agrees with the product only
 *    by accident — `''` reaches `JSON.parse` and lands in the same catch a
 *    real ENOENT would — so a read moved out of its `try` would keep the
 *    suite green while a real first boot threw.
 *  - `failWrite` can make a write fail, because `writeFileSync` can: a
 *    read-only cacheDir, a full disk, or another dsh holding `index.json`
 *    open. A fake that always succeeds is why the cache-write ordering
 *    defect in `loadCatalog` was invisible to all 79 cases.
 *
 * There is no raw `files` map. Seeding goes through `write`, so a seed cannot
 * reach the store under a key `exists` will not look up — that door is how
 * the original defect would have come back, via the idiomatic-looking
 * `files.set(join(cacheDir, 'index.json'), …)` storing one spelling while the
 * product reads another.
 *
 * @param failWrite - consulted with the ORIGINAL path before each write;
 * return a message to make that write throw it, `null` to allow it.
 */
export function memCatalogFs(failWrite?: (path: string) => string | null): MemCatalogFs {
  const files = new Map<string, string>()
  const order: string[] = []
  return {
    exists: path => files.has(memKey(path)),
    read: path => {
      const value = files.get(memKey(path))
      if (value === undefined) throw new Error(`ENOENT: no such file or directory, open '${path}'`)
      return value
    },
    write: (path, data) => {
      const why = failWrite?.(path) ?? null
      if (why !== null) throw new Error(why)
      order.push(memKey(path))
      files.set(memKey(path), data)
    },
    written: () => [...order],
  }
}

export interface MemHotFs extends HotFs {
  /** Read-back for assertions. `HotFs` carries no `exists` because `hot.ts`
   * never asks one — it reads and handles the throw. */
  exists: (path: string) => boolean
}

/**
 * An in-memory {@link HotFs}: `read` and `list` throw ENOENT on a missing
 * path, and a write registers its parent directory, mirroring `hot.ts`'s
 * `nodeFs` (whose `write` is a recursive `mkdirSync` plus `writeFileSync`).
 *
 * The throwing `list` is load-bearing rather than decorative:
 * `nextHotNumber` catches it to mean "no namespace directory yet, start at
 * hot-1.yml", so a `list` returning `[]` would test a branch the product
 * does not have.
 */
export function memHotFs(): MemHotFs {
  const files = new Map<string, string>()
  const dirs = new Set<string>()
  return {
    exists: path => files.has(memKey(path)),
    read: path => {
      const value = files.get(memKey(path))
      if (value === undefined) throw new Error(`ENOENT: no such file or directory, open '${path}'`)
      return value
    },
    write: (path, data) => {
      const key = memKey(path)
      // `dirname` over a key, not over the original path: a key is already
      // resolved and forward-slashed, and both platform dialects read `/` as
      // a separator, so the parent of a key is a key.
      dirs.add(dirname(key))
      files.set(key, data)
    },
    list: path => {
      const key = memKey(path)
      if (!dirs.has(key)) throw new Error(`ENOENT: no such file or directory, scandir '${path}'`)
      const prefix = key.endsWith('/') ? key : `${key}/`
      return [...files.keys()].filter(k => k.startsWith(prefix)).map(k => k.slice(prefix.length))
    },
  }
}
