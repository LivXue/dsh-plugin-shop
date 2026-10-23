/**
 * What a package declares as its icon, read the way dsh 0.2.1 reads it
 * (design 2026-10-23-shop-plugin-icons §3.1 and §4), so the catalog build can
 * tell from a manifest it already holds whether dsh would draw an icon for the
 * package, and from which file.
 *
 * dsh reaches a package's manifest, and its `./icon` export, through Node's
 * ESM resolution of the package's `exports` map, so every icon question
 * starts with one about `exports`: which file the map hands to
 * `./package.json` and to `./icon`. That is {@link resolveExportsSubpath}.
 *
 * Pure: no clock, no network, no filesystem, no environment, and no locale.
 *
 * @module icon-declaration
 */
import { posix } from 'node:path'

/**
 * The conditions an `exports` map is matched against: the ones Node 26's ESM
 * resolver applies by default, which are `node`, `node-addons` (on unless Node
 * runs with `--no-addons`), `import`, `module-sync` and `default`, the one that
 * matches whatever is left. A scan of 40 condition names on 26.6.0 matched
 * these five and no other. Not `require`, `browser`, `types` or `development`:
 * a map whose only usable target sits behind one of those resolves nothing,
 * and dsh sees nothing.
 */
export const EXPORT_CONDITIONS: ReadonlySet<string> = new Set(['node', 'node-addons', 'import', 'module-sync', 'default'])

/**
 * Where an `exports` map sends a subpath. `path` is relative to the package
 * root, POSIX-separated, normalised, and without a leading `./`; it is the
 * empty string when the map names the package directory itself.
 *
 * `via` says how the map got there, and the caller needs it: a pattern such as
 * `"./*": "./*"` hands back every subpath there is, so `./icon` resolving to
 * the extensionless file `icon` through one only says the map is open, not
 * that the author exported an icon, while the same target under an exact
 * `./icon` key is the author's own statement. A package with no `exports`
 * field resolves `./package.json` as `exact`: there is no map to match against.
 *
 * What comes back stays inside the package: no segment of `path` is `.`, `..`
 * or `node_modules`, however it is spelled, and none holds an escaped slash.
 * Later code reads files and builds keys from it, and the map it came from is
 * hostile input.
 */
export interface ResolvedSubpath {
  path: string
  via: 'exact' | 'pattern'
}

/**
 * How deep a target may nest conditions and arrays before it resolves
 * nothing. Real maps nest a few levels. The bound is there because the field
 * is untrusted JSON and this recurses over it: Node itself recurses until the
 * stack runs out, which would take the catalog build with it.
 */
const MAX_TARGET_DEPTH = 32

/**
 * Node throws two kinds of error while resolving a target, and an array
 * recovers from only one. An invalid target (no leading `./`, a refused
 * segment, a number) is skipped by the next member of an array exactly as a
 * `null` member is, so it is `null` here. The others (a condition object with
 * an array-index key, a `*` that matched a refused segment, an escaped slash in
 * the path that came out) end the whole resolution whatever else the array
 * holds. That is `FATAL`.
 *
 * It is also what a path gets when it holds a segment the shop refuses though
 * Node would have resolved it (a `..` composed by a star, which Node resolves
 * outside the package): Node's array stops at that member, so no later member
 * may stand in for the one it took.
 */
const FATAL = Symbol('fatal')

/**
 * What a target resolves to, with Node's three outcomes: a path; `null`, which
 * excludes and stops a condition object; and `undefined`, which means no
 * condition matched, so the caller moves on to the next. And `FATAL`.
 */
type Resolved = string | null | undefined | typeof FATAL

/**
 * What the manifest's `exports` makes of `subpath`: the file Node's ESM
 * resolver would answer for `<package>/package.json` or `<package>/icon`, or
 * `null` when it would answer with an error, "not exported" among them. The
 * shop does not need to tell those apart: either way dsh sees no file.
 *
 * This is PACKAGE_EXPORTS_RESOLVE, restricted to the two subpaths the shop
 * asks about. Each rule that decides an answer was checked against Node
 * 26.6.0's own resolver, not only the specification, because the two differ
 * in small ways and dsh asks the resolver (the test file lists them).
 *
 * Deliberately stricter than Node: the path that comes out is checked again
 * (see `resolveString`), so a star cannot compose a `..` or a `node_modules`
 * that Node would resolve, outside the package for the first.
 *
 * Deliberately not replicated: Node reads a target as a URL, so a `%XX`
 * escape in one is decoded, and a `?query` or a `#fragment` dropped, before
 * the file is looked up. This reads it as a path and keeps them as written,
 * bar an escaped slash or backslash, which is refused as it is in Node. No
 * icon path carries one, and they are not worth a URL parser in a pure core.
 *
 * @param exportsField - the manifest's `exports`, untrusted: any JSON value.
 */
export function resolveExportsSubpath(
  exportsField: unknown,
  subpath: './package.json' | './icon',
): ResolvedSubpath | null {
  // A string or an array is sugar for `{ '.': it }`, the package root, which is
  // neither of our subpaths.
  if (typeof exportsField === 'string' || Array.isArray(exportsField)) return null
  // No field. Node reads `exports` only when it is a string, an array or an
  // object, so `null`, `false` and a number are no field either. With no map
  // every file in the package resolves, the manifest among them. `./icon` is
  // another matter: dsh's second source is an *exported* `<specifier>/icon`
  // (§3.1), and a file that merely happens to be called `icon` is no icon.
  if (typeof exportsField !== 'object' || exportsField === null) {
    return subpath === './package.json' ? { path: 'package.json', via: 'exact' } : null
  }
  const map = exportsField as Record<string, unknown>
  const keys = Object.keys(map)
  // An object maps subpaths only when every key starts with `.`. When none does
  // its keys are conditions, which is the same root sugar. A mix is an invalid
  // configuration: Node resolves nothing from the package, not even a
  // `./package.json` the map lists.
  if (!keys.every((key) => key.startsWith('.'))) return null

  // An exact key wins, and wins for good: if its target resolves to nothing
  // the subpath is not exported, whatever pattern would also have matched.
  // That is how `"./*": "./*", "./icon": null` hides one file.
  if (Object.hasOwn(map, subpath)) return answer(resolveTarget(map[subpath], null, 0), 'exact')

  // Otherwise the best of the keys holding exactly one `*` whose prefix and
  // suffix bracket the subpath, with at least one character for the star:
  // the longest prefix, then the longest key. Only that one is tried; a null
  // there does not fall back to a shorter pattern.
  let best: { key: string; star: number; match: string } | undefined
  for (const key of keys) {
    const star = key.indexOf('*')
    if (star === -1 || star !== key.lastIndexOf('*')) continue
    const suffix = key.slice(star + 1)
    if (subpath.length < key.length || !subpath.startsWith(key.slice(0, star)) || !subpath.endsWith(suffix)) continue
    if (best !== undefined && (star < best.star || (star === best.star && key.length <= best.key.length))) continue
    best = { key, star, match: subpath.slice(star, subpath.length - suffix.length) }
  }
  return best === undefined ? null : answer(resolveTarget(map[best.key], best.match, 0), 'pattern')
}

/** A resolved path as an answer, or `null` for everything that is not one. */
function answer(resolved: Resolved, via: ResolvedSubpath['via']): ResolvedSubpath | null {
  return typeof resolved === 'string' ? { path: resolved, via } : null
}

/**
 * Node's PACKAGE_TARGET_RESOLVE for an `exports` target. `match` is what the
 * `*` of a pattern key matched, or `null` for an exact key.
 */
function resolveTarget(target: unknown, match: string | null, depth: number): Resolved {
  if (depth > MAX_TARGET_DEPTH) return null
  if (typeof target === 'string') return resolveString(target, match)
  if (target === null) return null
  if (Array.isArray(target)) {
    if (target.length === 0) return null
    // The first member that resolves wins, and one that does not is moved
    // past. If none resolves, the array answers `null` when any member was a
    // `null` (or an invalid target), and `undefined` when every member merely
    // matched no condition, which lets an enclosing condition object go on.
    let outcome: null | undefined = undefined
    for (const member of target as readonly unknown[]) {
      const resolved = resolveTarget(member, match, depth + 1)
      if (typeof resolved === 'string' || resolved === FATAL) return resolved
      if (resolved === null) outcome = null
    }
    return outcome
  }
  if (typeof target === 'object') {
    const keys = Object.keys(target)
    if (keys.some(isArrayIndex)) return FATAL
    // Read in the object's own order. The first key that is a condition we
    // match decides, unless it resolves to `undefined`, which moves on to the
    // next. A `null` decides too: it is an exclusion, not a miss.
    for (const key of keys) {
      if (!EXPORT_CONDITIONS.has(key)) continue
      const resolved = resolveTarget((target as Record<string, unknown>)[key], match, depth + 1)
      if (resolved !== undefined) return resolved
    }
    return undefined
  }
  // A number or a boolean is no target.
  return null
}

/** An escaped slash or backslash: Node refuses a path that holds one. */
const ESCAPED_SEPARATOR = /%2f|%5c/i

/**
 * A string target as a path inside the package. It must start with `./` (a
 * bare specifier is allowed only in `imports`), and none of its segments, nor
 * those of what the star matched, may be one Node refuses. Then the path that
 * comes out is held to the same rule.
 */
function resolveString(target: string, match: string | null): string | null | typeof FATAL {
  if (!target.startsWith('./')) return null
  // The leading `./` is the one `.` segment a target may have.
  if (refused(target.slice(2))) return null
  if (match !== null && refused(match)) return FATAL
  const filled = match === null ? target : target.split('*').join(match)
  // Normalising the whole target, `./` included, is what keeps `.//x.svg` from
  // coming out as the absolute `/x.svg`. A backslash is a separator to Node,
  // whose URL reading turns it into a slash, so it is one here.
  const normalised = posix.normalize(filled.replaceAll('\\', '/'))
  const path = normalised === './' ? '' : normalised
  // The two halves were clean, but a star can compose what neither held. With
  // a key such as `.*` the match starts with a slash, so a target segment
  // `..*` fills in as `..`; with `./ic*n` the match is `o`, so `n*de_modules`
  // fills in as `node_modules`. Node does not look again: it resolves
  // `{ '.*': './..*' }` for `./icon` to a file outside the package. `exports`
  // is hostile and `path` drives reads and keys further on, so the path that
  // comes out is held to the rule the target was. It is `FATAL`, not skipped:
  // Node takes this member, so none after it may stand in. An escaped slash or
  // backslash goes the same way, as Node refuses it after choosing the member,
  // and because it could hide a separator from the segment check.
  if (refused(path) || ESCAPED_SEPARATOR.test(path)) return FATAL
  return path
}

/**
 * Whether a path holds a segment Node refuses in a target: `.`, `..` or
 * `node_modules`, split on either kind of slash, in any case, and spelled out
 * or with percent escapes. Segments are read as they stand: a target written
 * `a/../x.svg` is refused though it stays inside the package, because Node
 * reads it before anything is collapsed. It is applied to a target as written,
 * to what a star matched, and to the path that comes out.
 */
function refused(path: string): boolean {
  return path.split(/[\\/]/).some((segment) => {
    const plain = segment
      .replace(/%([\da-f]{2})/gi, (_escape, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
      .toLowerCase()
    return plain === '.' || plain === '..' || plain === 'node_modules'
  })
}

/** Node's test for an array-index key: a canonical integer below 2**32 - 1. */
function isArrayIndex(key: string): boolean {
  const index = Number(key)
  return `${index}` === key && index >= 0 && index < 2 ** 32 - 1
}
