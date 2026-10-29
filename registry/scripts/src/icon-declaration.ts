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
 * On it sit {@link readIconDeclaration}, which turns a manifest into the icon
 * dsh would try to read, or into the reason it would not;
 * {@link fileListIncludes}, which asks whether a git install would carry the
 * file at all; and {@link iconDetail}, the one place the sentences an author
 * reads about their icon are written, the later fetch's among them.
 *
 * Pure: no clock, no network, no filesystem, no environment, and no locale.
 *
 * @module icon-declaration
 */
import { posix, win32 } from 'node:path'

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
  // Node reads the target as a relative URL: `%20` names a space, and a
  // `?query` or `#fragment` is not part of the path it opens. Applied after
  // the segment rule, which reads the escapes as they stand.
  const opened = decodeTarget(filled)
  if (opened === null) return null
  // Normalising the whole target, `./` included, is what keeps `.//x.svg` from
  // coming out as the absolute `/x.svg`. A backslash is a separator to Node,
  // whose URL reading turns it into a slash, so it is one here.
  const normalised = posix.normalize(opened.replaceAll('\\', '/'))
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
  // The escaped separator is read on the target as WRITTEN: Node refuses it
  // after choosing the member, and decoding first would hide the escape behind
  // the separator it stands for. A segment SPELLED with escapes that names `..`
  // is refused too, because Node refuses that spelling — while a literal `..`
  // the star composed is resolved and may normalise away. `refused` reads the
  // escapes itself and is asked about the decoded path as well.
  if (escapedRefusal(filled.slice(2)) || refused(path) || ESCAPED_SEPARATOR.test(filled)) return FATAL
  return path
}

/**
 * A target with what Node's URL reading removes taken off: the fragment and the
 * query, then the percent escapes decoded. `decodeURIComponent` throws on a
 * malformed escape, and Node refuses such a target, so null is no target rather
 * than a refusal.
 */
function decodeTarget(target: string): string | null {
  try {
    return decodeURIComponent(target.replace(/[?#].*$/, ''))
  } catch {
    return null
  }
}

/**
 * Whether a segment SPELLED with percent escapes names one Node refuses (`.`,
 * `..` or `node_modules`). A literal dot segment the star composed is Node's to
 * resolve; an escaped one is a spelling it rejects, and it is the spelling this
 * reads.
 */
function escapedRefusal(path: string): boolean {
  return path.split(/[\\/]/).some((segment) => {
    if (!segment.includes('%')) return false
    const plain = segment
      .replace(/%([\da-f]{2})/gi, (_escape, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
      .toLowerCase()
    return plain === '.' || plain === '..' || plain === 'node_modules'
  })
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

/**
 * The type dsh draws an icon as. dsh chooses it by the file's extension,
 * lower-cased, and by nothing else: the bytes are never sniffed
 * (`ICON_MEDIA_TYPES` in dsh-app-boot).
 */
export type IconMediaType = 'image/svg+xml' | 'image/png' | 'image/jpeg' | 'image/webp'

/** Every {@link IconMediaType}, as a record: a member added to the union stops compiling here until it is listed. */
export const ICON_MEDIA_TYPES: Readonly<Record<IconMediaType, true>> = {
  'image/svg+xml': true,
  'image/png': true,
  'image/jpeg': true,
  'image/webp': true,
}

const MEDIA_TYPES: ReadonlyMap<string, IconMediaType> = new Map<string, IconMediaType>([
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
])

/**
 * An icon a manifest declares, as dsh 0.2.1 would try to read it.
 *
 * `source` is which of dsh's two sources it came from, and the details quote
 * it ({@link iconLabel}). `path` is relative to the directory the manifest
 * sits in (the package root, or a subpackage's own directory), POSIX-separated
 * and normalised, with no leading `./` and no `..` segment: it stays inside
 * the package. It keeps the case it was written in, as the file system does,
 * while `mediaType` was chosen from its lower-cased extension.
 *
 * `path` is still hostile text. It is bounded by {@link MAX_ICON_PATH_LENGTH}
 * and otherwise anything a file name may hold: a control character, a `%`, a
 * `?` or a `#`. It is a name, not a URL, so whatever builds a URL from it must
 * encode it, and whatever prints it must quote it ({@link shownPath}).
 */
export interface IconDeclaration {
  source: 'icon' | 'export'
  path: string
  mediaType: IconMediaType
}

/**
 * What a manifest says about its icon. `none` is nothing dsh would read as an
 * icon. `refused` is a declaration dsh would not accept, with the sentence its
 * author is told. `declared` is one dsh would try to read: the manifest is
 * checked as far as a manifest alone can be, so whether the file exists, is
 * small enough and is an image the declared type draws is for the fetch.
 */
export type IconRead =
  | { kind: 'none' }
  | { kind: 'declared'; declaration: IconDeclaration }
  | { kind: 'refused'; detail: string }

/**
 * The longest icon path read. No file system dsh runs on opens a path past
 * 4096 characters (Linux's PATH_MAX; macOS stops at 1024 and Windows at 260),
 * so a package that declares a longer one has no icon dsh can draw.
 *
 * The bound is there for the shop's sake, though: a path becomes a key in a
 * committed file and a lookup in an archive, and a manifest may be a megabyte,
 * which a hostile one would spend on a single path. A path past it is read as
 * no icon rather than refused, because no refusal in {@link iconDetail} would
 * be true of it and an author never writes one.
 */
export const MAX_ICON_PATH_LENGTH = 4096

/**
 * How many characters of an author's path a sentence shows, the quotes and the
 * ellipsis included.
 */
const SHOWN_PATH_MAX = 80

/**
 * How a detail names the declaration it is about: dsh's two sources, as their
 * author would name them. `package.json "icon"` is the one the field-only
 * details in {@link iconDetail} hard-wire.
 */
export function iconLabel(source: IconDeclaration['source']): string {
  return source === 'icon' ? 'package.json "icon"' : 'the "./icon" export'
}

/**
 * An author's path as a sentence quotes it: as a JSON string, which escapes
 * quotes, backslashes and every control character, so no newline or stray
 * quote of theirs survives into a published line; and cut to 80 characters
 * (79 and an ellipsis) so a manifest cannot make a row as long as it likes.
 * It is the one place any of an author's text enters a detail.
 *
 * The cut is by character, not by UTF-16 unit: a cut inside a surrogate pair
 * leaves an ill-formed string, which whatever writes the report turns into
 * U+FFFD. Only the head of the value is read, because 80 characters never need
 * more of a value that may be megabytes: 162 units hold at least 81 characters,
 * enough to know it is past the bound, and the 79 it keeps are inside them.
 */
export function shownPath(value: string): string {
  const quoted = JSON.stringify(value.slice(0, 2 * (SHOWN_PATH_MAX + 1)))
  if (quoted.length <= SHOWN_PATH_MAX) return quoted
  const characters = Array.from(quoted)
  if (characters.length <= SHOWN_PATH_MAX) return quoted
  return `${characters.slice(0, SHOWN_PATH_MAX - 1).join('')}…`
}

/**
 * The sentences the build report and the catalog publish about an icon, one
 * function for each way an icon ends up without one (design 2026-10-23 §10).
 * Their reader is the author the icon belongs to, who has to act on them
 * (CLAUDE.md, "Every rejection carries an author-readable `detail`"), so each
 * says what dsh or the shop did and, where there is something to change, what.
 *
 * `label` is {@link iconLabel} of a declaration's source. `shown` is
 * {@link shownPath} of a path, which is an author's own text and so quoted and
 * cut: of the field's path as it was written where the declaration was refused
 * before a path existed, and of the declaration's normalised path from there
 * on. The four field-only details name `package.json "icon"` themselves,
 * because nothing else can have a value they are about.
 *
 * The sizes in the copy are the limits' values written out. This module sits
 * below the ones that own the limits and cannot import them.
 */
export const iconDetail = {
  notString: (): string => 'package.json "icon" must be a non-empty string; dsh shows no icon for this package.',
  notRelative: (shown: string): string =>
    `package.json "icon" ${shown} must be a relative file path inside the package; dsh shows no icon for this package.`,
  leavesPackage: (shown: string): string =>
    `package.json "icon" ${shown} leaves the package directory; dsh shows no icon for this package.`,
  badType: (label: string, shown: string): string =>
    `${label} ${shown} is not an SVG, PNG, JPEG or WebP file name; dsh chooses an icon's type by its extension.`,
  fieldUnreachable: (): string =>
    'package.json "icon" is never read: the package\'s "exports" does not expose "./package.json", so dsh cannot see the field. Add "./package.json": "./package.json" to "exports", or export "./icon".',
  fieldElsewhere: (): string =>
    'package.json "icon" is never read: the package\'s "exports" maps "./package.json" to another file, so dsh reads that file and not this manifest. Add "./package.json": "./package.json" to "exports", or export "./icon".',
  pathTooLong: (label: string, max: number): string =>
    `${label} is longer than the ${max} characters the catalog reads for an icon path; it was not read.`,
  notInFiles: (label: string, shown: string): string =>
    `${label} ${shown} is not in package.json "files", so a git install leaves it out and dsh never sees it.`,
  notInPackage: (label: string, shown: string, name: string, version: string): string =>
    `${label} ${shown} is not in the published package ${name}@${version}.`,
  notAtCommit: (label: string, shown: string, repo: string, commit: string): string =>
    `${label} ${shown} is not in ${repo} at commit ${commit.slice(0, 7)}.`,
  notInRelease: (label: string, shown: string): string =>
    `${label} ${shown} is not in the release asset this entry installs.`,
  // `bytes` is null where the read stopped at the bound and never learned the
  // size. Otherwise it is rounded up to the tenth of a KiB, so a file over the
  // bound never reads as exactly 32.0 KiB.
  tooLarge: (label: string, shown: string, bytes: number | null): string =>
    bytes === null
      ? `${label} ${shown} is larger than 32 KiB; the shop shows icons of at most 32 KiB.`
      : `${label} ${shown} is ${(Math.ceil(bytes / 102.4) / 10).toFixed(1)} KiB; the shop shows icons of at most 32 KiB.`,
  // `typeName` is SVG, PNG, JPEG or WebP: the type the extension promised.
  wrongBytes: (label: string, shown: string, typeName: string): string =>
    `${label} ${shown} does not hold ${typeName} data, although its extension says it does.`,
  packageTooLarge: (name: string, version: string): string =>
    `the published package ${name}@${version} is larger than the 32 MiB the catalog build downloads, so its icon was not read.`,
  packageUnpacksTooLarge: (name: string, version: string): string =>
    `the published package ${name}@${version} unpacks to more than the 64 MiB the catalog build reads, so its icon was not read.`,
  // A tarball the build downloaded, checked against the digest npm lists, and
  // still cannot open: not gzip, a tar its small reader refuses, or without the
  // one top-level directory `npm pack` writes. Said as what the build could not
  // do, and not as a fault of the package, since the reader's limits are as
  // likely the cause as the archive.
  packageUnreadable: (name: string, version: string): string =>
    `the published package ${name}@${version} could not be read by the catalog build as a gzipped tar archive with one top-level directory, so its icon was not read.`,
  releaseUnreadable: (): string =>
    'the release asset could not be read by the catalog build as a gzipped tar archive with one top-level directory, so its icon was not read.',
  withheldByHand: (reason: string): string => `withheld by registry/withheld-icons.yml: ${reason}`,
  withheldForSize: (): string =>
    'withheld: the icons file reached its 16 MiB budget, and the largest icons give way first.',
}

/**
 * What the manifest declares as its icon, by dsh 0.2.1's rule (design §3.1 and
 * §4; `readPluginMeta` and `iconOf` in dsh-app-boot):
 *
 * 1. dsh reads the manifest through `exports`. The field counts only where
 *    `./package.json` resolves to the manifest itself. A map that hands that
 *    subpath another file (`dist/package.json`, say) makes dsh read that
 *    file, which the shop does not hold, and this manifest's field is not what
 *    dsh reads.
 * 2. Where it does and `icon` is present, `icon` decides, and nothing else is
 *    tried. A bad one is refused, not skipped, as dsh throws on it.
 * 3. Otherwise, the `./icon` export.
 * 4. A package that declares an `icon` dsh never reads, and exports none, has
 *    an icon it will never draw. Its author is told why. Nothing else is no
 *    icon, and no refusal.
 *
 * The path rules apply to both sources, which dsh does not do: for the field
 * they are dsh's own, and for the export they are defence in depth over what
 * {@link resolveExportsSubpath} already answers with. See {@link readIconExport}.
 *
 * @param manifest - a package.json, untrusted: any JSON value.
 */
export function readIconDeclaration(manifest: unknown): IconRead {
  // dsh reads a package.json that is an object, and draws nothing for any other.
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) return { kind: 'none' }
  const fields = manifest as Record<string, unknown>
  const manifestAt = resolveExportsSubpath(fields.exports, './package.json')
  const readsManifest = manifestAt !== null && manifestAt.path === 'package.json'
  // dsh takes an absent field, `undefined` to it, for none, and anything else,
  // null included, for a declaration.
  if (readsManifest && fields.icon !== undefined) return readIconField(fields.icon)
  const exported = readIconExport(fields.exports)
  if (exported !== undefined) return exported
  // A field that is present here is one dsh never read: a readable one has
  // returned above. Two ways it goes unread, and the author is told which: an
  // `exports` that does not name "./package.json" at all, and one that names
  // it and points it at another file — the second sentence used to claim the
  // first, telling an author to add an export they already had.
  if (fields.icon === undefined) return { kind: 'none' }
  return refuseWith(manifestAt === null ? iconDetail.fieldUnreachable() : iconDetail.fieldElsewhere())
}

function refuseWith(detail: string): IconRead {
  return { kind: 'refused', detail }
}

/**
 * dsh's `iconOf` for the manifest's `icon` field, in its order: a non-empty
 * string (`textOf` refuses whitespace too), a relative path with no URL scheme,
 * a path that stays inside the manifest's directory, a known extension.
 */
function readIconField(value: unknown): IconRead {
  if (typeof value !== 'string' || value.trim() === '') return refuseWith(iconDetail.notString())
  if (!isRelativePath(value)) return refuseWith(iconDetail.notRelative(shownPath(value)))
  // After the relative test, so that a `data:` URL, which authors do write and
  // which can be long, is still refused and told why.
  if (value.length > MAX_ICON_PATH_LENGTH) return refuseWith(iconDetail.pathTooLong(iconLabel('icon'), MAX_ICON_PATH_LENGTH))
  const path = pathInsidePackage(value)
  if (path === null) return refuseWith(iconDetail.leavesPackage(shownPath(value)))
  const mediaType = mediaTypeOf(path)
  if (mediaType === undefined) return refuseWith(iconDetail.badType(iconLabel('icon'), shownPath(path)))
  return { kind: 'declared', declaration: { source: 'icon', path, mediaType } }
}

/**
 * The `./icon` export as a declaration or a refusal, or `undefined` where the
 * map exports no icon.
 *
 * What the map answers with already stays inside the package, so the path
 * rules can fault it only in ways no real package has (a name such as
 * `C:/icon.svg`, which dsh would open as a file of that name), and they are
 * applied anyway, as defence in depth. One that fails them is no export rather
 * than a refusal: the refusals for the field quote `package.json "icon"`, a
 * field the author of an export did not write, and none of them is true of an
 * export.
 *
 * What `via` records decides a file the rules accept but the extension does
 * not. Under an exact `./icon` key it is the author's own statement and
 * refused. A pattern such as `"./*": "./dist/*.js"` hands every subpath a
 * file, and one landing on `dist/icon.js` only says the map is open, so it is
 * no export at all.
 */
function readIconExport(exportsField: unknown): IconRead | undefined {
  const exported = resolveExportsSubpath(exportsField, './icon')
  if (exported === null || exported.path.length > MAX_ICON_PATH_LENGTH || !isRelativePath(exported.path)) return undefined
  const path = pathInsidePackage(exported.path)
  if (path === null) return undefined
  const mediaType = mediaTypeOf(path)
  if (mediaType === undefined) {
    return exported.via === 'exact' ? refuseWith(iconDetail.badType(iconLabel('export'), shownPath(path))) : undefined
  }
  return { kind: 'declared', declaration: { source: 'export', path, mediaType } }
}

/**
 * dsh's test for an `icon` that is not a relative path: anything that starts
 * with a URL scheme, which is how a `data:` URL fails and how a drive letter
 * does, or an absolute path of either kind of platform.
 */
const URL_SCHEME = /^[A-Za-z][A-Za-z\d+.-]*:/u

function isRelativePath(value: string): boolean {
  return !posix.isAbsolute(value) && !win32.isAbsolute(value) && !URL_SCHEME.test(value)
}

/**
 * The path as dsh's `resolve(root, icon)` would reach it, relative to `root`,
 * or `null` where it ends outside: normalised, a leading `./` gone with the
 * rest of the dots. `resolve` also drops a trailing slash, which
 * `posix.normalize` keeps, and `logo.svg/` is the file `logo.svg` to dsh. A
 * backslash is a file name character, as it is on the platforms dsh runs on
 * other than Windows.
 */
function pathInsidePackage(value: string): string | null {
  const normalised = posix.normalize(value)
  const path = normalised.endsWith('/') ? normalised.slice(0, -1) : normalised
  return path === '..' || path.startsWith('../') ? null : path
}

function mediaTypeOf(path: string): IconMediaType | undefined {
  return MEDIA_TYPES.get(posix.extname(path).toLowerCase())
}

/**
 * More entries than any real `files` list holds, and longer than any real
 * entry, so that past either the list is not read. With a path of at most
 * {@link MAX_ICON_PATH_LENGTH} they bound one entry's walk at some 256 * 4096
 * steps, and a list at 256 times that, which {@link MAX_FILES_MATCH_STEPS}
 * then cuts short; `files` is hostile input and a manifest may be a megabyte
 * of it.
 */
const MAX_FILES_ENTRIES = 256
const MAX_FILES_ENTRY_LENGTH = 256

/**
 * The most turns of the two walks below, {@link globMatches} and
 * {@link nameMatches}, that one call of {@link fileListIncludes} takes, counted
 * across all of its entries. Past it the list is not read and the file is
 * included, as for a list past the bounds above.
 *
 * Those bounds hold one walk to the product of its lengths, and the product is
 * no small number for a list built to reach it. 256 entries of a star, 254
 * `a`s and a `b`, against a path of 4,092 `a`s and `.svg`, kept one call busy
 * for 1.2 seconds of blocking CPU (measured 2026-10-24): each entry's star
 * slides one character along the path and reads its 254 `a`s again after every
 * slide, a million turns an entry and 259 million in all. Any repository that
 * carries the topic can hand the harvest that list in its root manifest and in
 * each of up to eight subpackages', on every full fetch and every re-read.
 *
 * A million turns — the whole budget — took 4 to 15 ms of the same CPU on the
 * shapes measured, and that holds only because every loop of the two walks
 * spends a step. The walks' closing runs of stars did not, and 256 entries
 * whose patterns end in 252 stars each read those tails for free: the same
 * call took 470 ms past a budget it had spent (measured 2026-10-24, at the
 * call site's own pair of `readIconDeclaration` and `fileListIncludes`), and
 * 4 ms once the tails were counted. A list as long as
 * {@link MAX_FILES_ENTRIES} allows, of globs with a `**` between directories
 * that reach into the path's (icon-declaration.test.ts reads one), spent about
 * 4,500 of them, so no list an author writes comes near it.
 */
export const MAX_FILES_MATCH_STEPS = 1_000_000

/**
 * What is left of one call's {@link MAX_FILES_MATCH_STEPS}, spent a turn at a
 * time by both walks. Below zero, the call has stopped reading.
 */
export interface MatchSteps {
  left: number
}

/**
 * Glob syntax beyond `*` and `**`: the `?`, character classes, braces,
 * extglobs and escapes of npm's minimatch, which the shop does not evaluate.
 */
const UNREAD_GLOB_SYNTAX = /[?[\]{}()\\]/

/**
 * Whether a git install of a package whose package.json lists `files` as given
 * carries the file at `path`, a declaration's path relative to that
 * package.json.
 *
 * pnpm installs a git dependency the way `npm pack` would pack it (design
 * §5.2), and with a `files` list npm packs what the list names, so an icon the
 * list leaves out is one dsh never sees. The rule is npm-packlist's, as its
 * answers show (the tests list them):
 *
 * - Entries are read in order, the last one that matches deciding, and an
 *   entry that starts with `!` excludes.
 * - An entry matches the path it names and, if it names a directory, every
 *   path under it. Every entry is anchored at the package root, and a leading
 *   `./` or `/` is that root.
 * - Otherwise the entry is a glob: `*` stays within a path segment and `**`
 *   crosses them. A glob matches only the paths it names, never a directory
 *   that holds them, except that npm reads a final `*` segment, `dir/*` or
 *   alone, as `**`.
 * - Case does not matter: npm matches its patterns without regard to it, which
 *   is why `*.svg` packs `Icon.SVG`. (A name spelled in the wrong case is a
 *   directory on a case-insensitive file system and a mere pattern on a
 *   case-sensitive one, so no refusal can rest on it either.)
 *
 * Two corners of npm's are not modelled, and both show only in lists that mix
 * such entries. A slash-less pattern (`*.png`) also matches inside any
 * directory another entry makes npm enter, where here it is anchored at the
 * root, so the shop can refuse an icon that npm packs. And an entry that names
 * an existing file outranks the others whatever their order, where here the
 * last entry decides.
 *
 * Three things leave the file included, because a refusal is published to an
 * author and has to be true:
 *
 * - A `files` that is not an array of strings restricts nothing.
 * - An entry this does not read cannot say what it matches: one that uses glob
 *   syntax beyond `*` and `**`, or names nothing. It includes, and as a `!`
 *   entry it excludes nothing, so the worst a wrong guess does is draw an icon
 *   a git install lacks, which §5.2 already accepts for `.npmignore`.
 * - A list or entry past the bounds above is not read, nor is a path past
 *   {@link MAX_ICON_PATH_LENGTH}. Matching is not done by a regular expression
 *   built from the entry, whose worst case is exponential, but by walking both
 *   with a bounded backtrack: at worst the product of their lengths. Nor is a
 *   list whose walks would take more than {@link MAX_FILES_MATCH_STEPS} turns
 *   between them, which is where a product that large is cut short.
 *
 * @param files - the manifest's `files`, untrusted: any JSON value.
 * @param path - normalised and POSIX-separated, as an {@link IconDeclaration}'s.
 * @param steps - the call's budget of turns. Callers leave it out; a test
 *   hands one in to read what the call spent.
 */
export function fileListIncludes(files: unknown, path: string, steps: MatchSteps = { left: MAX_FILES_MATCH_STEPS }): boolean {
  if (!Array.isArray(files) || files.length > MAX_FILES_ENTRIES || path.length > MAX_ICON_PATH_LENGTH) return true
  if (!files.every((entry) => typeof entry === 'string')) return true
  const segments = path.toLowerCase().split('/')
  // npm walks the root always, and a deeper directory when an entry names a
  // path on the way down to it — it cannot know the entry's next segment is
  // absent without looking. {@link entryMatches} uses this for the basename
  // matching npm was measured to do.
  const directory = segments.slice(0, -1)
  const prefixes = (files as readonly string[]).filter((entry) => !entry.startsWith('!')).map(literalPrefix)
  const walked = directory.length === 0
    || prefixes.some((prefix) => prefix.length > 0 && (isPrefix(prefix, directory) || isPrefix(directory, prefix)))
  let included = false
  for (const entry of files as readonly string[]) {
    const excludes = entry.startsWith('!')
    const matched = entryMatches(excludes ? entry.slice(1) : entry, segments, steps, walked)
    // A spent budget leaves the answer unknown, and an unknown answer includes.
    if (steps.left < 0) return true
    // An entry that cannot be read (`undefined`) counts as a match for an
    // include and as no match for an exclude.
    if (matched ?? !excludes) included = !excludes
  }
  return included
}

/**
 * Whether one `files` entry, without its `!`, matches a path, or `undefined`
 * where the entry is one this does not read. A glob's answer means nothing once
 * `steps` is spent, and the caller reads `steps` first.
 * @param walked - whether npm walks the directory `path` is in, which decides
 *   whether a slash-less entry is matched against the basename there
 *   ({@link fileListIncludes} measures why).
 */
function entryMatches(entry: string, path: readonly string[], steps: MatchSteps, walked: boolean): boolean | undefined {
  if (entry.length > MAX_FILES_ENTRY_LENGTH || UNREAD_GLOB_SYNTAX.test(entry)) return undefined
  // Empty segments (`a//b`, a trailing or a leading slash) are no segments, and
  // a leading `.` is the package root. `path` is lower-cased by the caller.
  const parts = entry.toLowerCase().split('/').filter((part) => part !== '')
  if (parts[0] === '.') parts.shift()
  if (parts.length === 0) return undefined
  // npm's packlist matches a pattern with no slash against a basename, not the
  // whole path — for the directories it walks. Measured with npm 11.7.0
  // (2026-10-29): `files: ["assets/sub", "*.svg"]` packs `assets/icon.svg`, and
  // `files: ["*.svg"]` alone does not, because nothing makes npm enter
  // `assets`. Matching the whole path instead refused an icon npm ships.
  const target = entry.includes('/') || !walked ? path : path.slice(-1)
  if (!entry.includes('*')) {
    // A plain name: the file itself, or a directory that holds it. A bare name
    // in a walked directory also matches a basename anywhere below it.
    return (parts.length <= path.length && parts.every((part, index) => part === path[index]))
      || (walked && parts.length === 1 && parts[0] === path[path.length - 1])
  }
  // npm packs everything below `dir/*`, not only the children of `dir`, and
  // everything for a lone `*`, an include or a `!`.
  if (parts[parts.length - 1] === '*') parts[parts.length - 1] = '**'
  return globMatches(parts, target, steps)
}

/** The literal segments of a `files` entry, up to its first wildcard; a bare name is all literal. */
function literalPrefix(entry: string): string[] {
  const parts = entry.replace(/^!/, '').toLowerCase().split('/').filter((part) => part !== '' && part !== '.')
  const literal: string[] = []
  for (const part of parts) {
    if (part.includes('*')) break
    literal.push(part)
  }
  return literal
}

/** Whether `a` is a prefix of `b`, segment for segment. */
function isPrefix(a: readonly string[], b: readonly string[]): boolean {
  return a.length <= b.length && a.every((part, index) => part === b[index])
}

/**
 * Whether glob segments match path segments, a `**` segment standing for any
 * number of them, none included. Walks both once, and where a segment fails
 * goes back only to the latest `**`: at worst the product of the lengths, with
 * nothing exponential in it however the entry is written. Each turn spends one
 * of `steps`, and the walk stops when they are spent, its answer then
 * meaningless.
 */
function globMatches(pattern: readonly string[], path: readonly string[], steps: MatchSteps): boolean {
  let at = 0
  let from = 0
  let globstar = -1
  let resume = 0
  while (from < path.length) {
    if (--steps.left < 0) return false
    const part = pattern[at]
    if (part === '**') {
      globstar = at++
      resume = from
    } else if (part !== undefined && nameMatches(part, path[from] ?? '', steps)) {
      at++
      from++
    } else if (globstar !== -1) {
      at = globstar + 1
      from = ++resume
    } else {
      return false
    }
  }
  // The trailing stars spend the budget like every other turn: a pattern of
  // 252 of them was read after each of a million counted turns for free, which
  // is how one hostile list cost 300 ms of blocking CPU past a budget it had
  // already spent (icon-declaration.test.ts measures it).
  while (pattern[at] === '**') {
    if (--steps.left < 0) return false
    at++
  }
  return at === pattern.length
}

/**
 * Whether a glob segment matches a path segment: `*` for any run of
 * characters, none included, and every other character for itself. The same
 * walk as {@link globMatches}, one level down, spending the same `steps`.
 */
function nameMatches(pattern: string, name: string, steps: MatchSteps): boolean {
  let at = 0
  let from = 0
  let star = -1
  let resume = 0
  while (from < name.length) {
    if (--steps.left < 0) return false
    if (pattern[at] === '*') {
      star = at++
      resume = from
    } else if (pattern[at] === name[from]) {
      at++
      from++
    } else if (star !== -1) {
      at = star + 1
      from = ++resume
    } else {
      return false
    }
  }
  // The same spend as {@link globMatches}, for the same reason: this tail is
  // where a pattern of stars outlived the budget.
  while (pattern[at] === '*') {
    if (--steps.left < 0) return false
    at++
  }
  return at === pattern.length
}
