/** Harness compatibility: which declared peers the running installation does
 * not provide (design 2026-09-01-harness-compatibility), and — for the
 * shop's OWN declared peers — which ones it provides at a version outside
 * the declared range. */

import { readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { satisfies, valid, validRange } from 'semver'
import { identityKey, type EntryIdentity } from '../shared/identity.ts'

/** Answers "can this installation provide `spec`?" — injected so fixtures
 * drive every verdict and exactly one call site touches the filesystem. */
export type PeerResolver = (spec: string) => boolean

/**
 * The two filesystem reads the package lookup makes. Injected so fixtures can
 * drive every branch of the walk — including a permission failure, which a
 * real directory cannot stage when the suite runs as root — while
 * `NODE_LOOKUP_FS` below stays the one place this module touches the disk.
 */
export interface PackageLookupFs {
  /** `statSync`'s contract: follows symlinks, and throws an errno error
   * (`code` set) for a path it cannot stat. */
  stat(path: string): { isDirectory(): boolean }
  /** `readFileSync(path, 'utf8')`'s contract: throws for a file it cannot read. */
  readFile(path: string): string
}

const NODE_LOOKUP_FS: PackageLookupFs = {
  stat: path => statSync(path),
  readFile: path => readFileSync(path, 'utf8'),
}

/**
 * One segment of a bare package name, about to be spliced into a path.
 *
 * A leading `.` refuses the segment whole: `.` and `..` would walk the path
 * out of `node_modules`, and `.bin` or `.pnpm` are directories an install
 * carries that no package can be. The ESM resolver agrees as far as it goes:
 * it refuses an unscoped name that starts with `.`, and any name holding `%`
 * or `\`, with ERR_INVALID_MODULE_SPECIFIER (measured on Node 26.6.0 with
 * `.bin`, `a%2e`, `a\b`). `\` is also a separator on Windows, `:` names a
 * drive, an NTFS stream or a URL scheme (`node:fs`, `file:`), and NUL is a
 * byte no path may carry.
 */
function isNameSegment(segment: string): boolean {
  return segment.length > 0 && !segment.startsWith('.') && !/[\\:%\0]/.test(segment)
}

/**
 * Whether `spec` is a bare package name — `name`, or `@scope/name` — and so
 * safe to look up. Peer names are catalog input, and hostile; this check is
 * what keeps one from becoming a path. The lookup this replaced resolved
 * `'../x/package.json'` relative to the profile and an absolute name as
 * itself, so a peer name could point it at any path on the reader's disk.
 */
function isBarePackageName(spec: string): boolean {
  const segments = spec.split('/')
  const [first, second] = segments
  if (first === undefined) return false
  if (!first.startsWith('@')) return segments.length === 1 && isNameSegment(first)
  return segments.length === 2 && second !== undefined && isNameSegment(first.slice(1)) && isNameSegment(second)
}

/**
 * The directory `spec` is installed at as seen from `fromDir`, or null when
 * the walk reaches the filesystem root without finding one: for each ancestor
 * `dir`, `dir/node_modules/<spec>`, and the first that is a DIRECTORY is the
 * match. That is how the ESM resolver matches a bare package (PACKAGE_RESOLVE
 * continues past a candidate "if the folder does not exist", and stops at the
 * first that does), whatever the manifest inside says — the loader imports
 * from that directory or fails there, and never falls through to an ancestor.
 * Measured on Node 26.6.0: an empty `node_modules/<name>` in front of an
 * ancestor's working copy fails the import with ERR_MODULE_NOT_FOUND.
 *
 * Throws for a `spec` that is not a bare package name, and for a stat failure
 * other than ENOENT or ENOTDIR: both leave the answer unknown, and only a
 * walk that looked everywhere and found nothing may say "absent".
 */
function findPackageDir(fromDir: string, spec: string, fs: PackageLookupFs): string | null {
  if (!isBarePackageName(spec)) throw new TypeError(`not a bare package name: ${JSON.stringify(spec)}`)
  const segments = spec.split('/')
  for (let dir = fromDir; ;) {
    const candidate = join(dir, 'node_modules', ...segments)
    try {
      if (fs.stat(candidate).isDirectory()) return candidate
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      // ENOENT is nothing here — a dangling link included, since stat
      // follows it — and ENOTDIR is a component of the path that is a file.
      // Either way keep walking. EACCES, ELOOP and the rest mean this
      // candidate may hold the package, and nobody can tell.
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error
    }
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/**
 * The directory the walk starts from. `createRequire` took a file URL or an
 * absolute path and so does this — the production anchor is
 * `<profile>/cordis.yml` as a file URL — and, like `createRequire`, a
 * trailing separator names the directory itself rather than a file in its
 * parent. Anything else throws here, at construction, which the gateway's
 * call sites already treat as "no anchor, no verdict".
 */
function anchorDirectory(baseUrl: string): string {
  const path = isAbsolute(baseUrl) ? baseUrl : fileURLToPath(baseUrl)
  return path.endsWith('/') || path.endsWith(sep) ? path : dirname(path)
}

/** `nodeResolver` over an injected filesystem, walking up from `fromDir` —
 * the seam fixtures drive the lookup through. */
export function packageResolver(fromDir: string, fs: PackageLookupFs): PeerResolver {
  return spec => findPackageDir(fromDir, spec, fs) !== null
}

/**
 * The production resolver, anchored at the profile. A peer is present when
 * some ancestor's `node_modules/<spec>` is a directory, the way the ESM
 * resolver that loads plugins' host halves matches a bare package (see
 * `findPackageDir`). From `<profile>/cordis.yml` the walk reads
 * `<profile>/node_modules`, then `$DSH_HOME/profiles/node_modules` — the link
 * farm dsh-app-boot's `healProfilesModuleFallback` keeps, pointing into the
 * global dsh install — and so on up to the root.
 *
 * It used to ask `require.resolve('<spec>/package.json')`, a question that
 * answered wrongly twice:
 *
 *  - Under a packaged dsh executable (`process.pkg`) the link farm holds ESM
 *    proxy packages instead of symlinks, and a proxy's `exports` leaves
 *    `./package.json` out on purpose, so resolving it threw
 *    ERR_PACKAGE_PATH_NOT_EXPORTED for every proxied peer. Presence read that
 *    as present; the version resolver below could read nothing. Reproduced:
 *    a proxy at `0.2.0-rc.1` against a declared `^0.1.1-rc.2` gave presence
 *    true, version null, mismatches `[]` — the load-time self-check could
 *    never fire under a packaged dsh.
 *  - Node caches a SUCCESSFUL CJS resolution for the life of the process
 *    (`Module._pathCache`, keyed on request + lookup paths) and hands the
 *    cached filename back without looking at the disk; a failure is not
 *    cached. Measured on Node 26.6.0 in one process: absent → false,
 *    installed → true, uninstalled → STILL true. A peer the reader removed
 *    left every plugin declaring it unflagged until dsh restarted.
 *
 * So nothing is cached and `exports` is never consulted: every call stats
 * afresh, and present is present. `stat` follows symlinks, so a link to
 * nothing reads absent — which matters, because the link farm adds links and
 * never prunes them: 29 of its 511 dangled on the machine this was measured
 * on, after upgrades.
 *
 * The global folders — `NODE_PATH`, `~/.node_modules`, `~/.node_libraries`,
 * `$PREFIX/lib/node` — are deliberately not searched: the ESM resolver that
 * loads plugin host code does not search them either. That is not academic.
 * pnpm's bin shims export `NODE_PATH` (this repo's own `node_modules/.bin/
 * vitest` points it into the virtual store), and under one the old lookup
 * found harness packages from any anchor at all, a temp directory included.
 *
 * It throws for a `spec` that is not a bare package name and for a stat
 * failure other than absence, and `incompatibilityMap` turns a throw into no
 * verdict: neither is a fact this resolver can establish, and false is an
 * accusation.
 */
export function nodeResolver(baseUrl: string): PeerResolver {
  return packageResolver(anchorDirectory(baseUrl), NODE_LOOKUP_FS)
}

/**
 * Package name → the peer names that did not resolve. A key is present only
 * when at least one peer is missing, so an absent key means "runs here, or we
 * could not tell" — the client renders nothing for either.
 *
 * A resolver that throws yields NO verdict at all: an unavailable fact must
 * never read as an accusation, because one false warning teaches a reader to
 * ignore every warning.
 */
export function incompatibilityMap(
  entries: readonly (EntryIdentity & { peers?: string[] })[],
  resolve: PeerResolver,
): Record<string, string[]> {
  const known = new Map<string, boolean | null>() // null marks "threw"
  const out: Record<string, string[]> = {}
  for (const entry of entries) {
    if (entry.peers === undefined || entry.peers.length === 0) continue
    const missing: string[] = []
    let usable = true
    for (const spec of entry.peers) {
      let present = known.get(spec)
      if (present === undefined) {
        try {
          present = resolve(spec)
          known.set(spec, present)
        } catch {
          // Resolution threw; mark so we don't retry, and discard this entry's
          // partial list. See the doc comment above.
          known.set(spec, null)
          usable = false
          break
        }
      } else if (present === null) {
        // This name threw before; discard this entry's partial list.
        usable = false
        break
      }
      if (!present) missing.push(spec)
    }
    if (usable && missing.length > 0) out[identityKey(entry)] = missing
  }
  return out
}

/**
 * The same question one step further on: which VERSION does this
 * installation provide for `spec`? `null` is the no-verdict signal — the
 * peer is absent, or its manifest could not be read. Injected exactly like
 * `PeerResolver`, so fixtures drive every verdict and only one call site
 * touches the filesystem.
 */
export type PeerVersionResolver = (spec: string) => string | null

/** One declared peer whose provided version is outside its declared range. */
export interface PeerVersionMismatch {
  spec: string
  /** The range this build declares in `peerDependencies`. */
  range: string
  /** The version the installation actually provides. */
  found: string
}

/** `nodeVersionResolver` over an injected filesystem, walking up from
 * `fromDir` — the seam fixtures drive the lookup through. */
export function packageVersionResolver(fromDir: string, fs: PackageLookupFs): PeerVersionResolver {
  return spec => {
    let dir: string | null
    try {
      dir = findPackageDir(fromDir, spec, fs)
    } catch {
      // Swallows a spec that is not a bare package name and a stat failure
      // other than absence — the two cases the presence resolver throws for.
      // Null already means no verdict here, so nothing needs them apart.
      return null
    }
    if (dir === null) return null
    let manifest: unknown
    try {
      manifest = JSON.parse(fs.readFile(join(dir, 'package.json')))
    } catch {
      // Swallows a manifest that is missing, unreadable or malformed: a fact
      // we cannot read is not a mismatch, and this check must never be the
      // reason a load fails.
      return null
    }
    const version = typeof manifest === 'object' && manifest !== null
      ? (manifest as { version?: unknown }).version
      : undefined
    return typeof version === 'string' && version.length > 0 ? version : null
  }
}

/**
 * The production version resolver: `nodeResolver`'s lookup, then the matched
 * directory's own `package.json`, read directly. Reading it directly is the
 * fix, not a shortcut: resolving `<spec>/package.json` is what an exports map
 * can refuse, and a packaged dsh's module proxy refuses it by construction
 * while carrying the proxied package's version in exactly that file (see
 * `nodeResolver`).
 *
 * Anything that leaves no version to read answers null: a spec that is not a
 * bare package name, a stat failure other than absence, a peer that is
 * absent, a manifest that is missing, unreadable or malformed, a `version`
 * that is not a non-empty string. Absence is deliberately NOT reported as a
 * version violation: `incompatibilityMap` is what covers a missing peer.
 */
export function nodeVersionResolver(baseUrl: string): PeerVersionResolver {
  return packageVersionResolver(anchorDirectory(baseUrl), NODE_LOOKUP_FS)
}

/**
 * The declared peers whose provided version is outside the declared range,
 * ordered by peer name. Pure: the module graph arrives through `resolve`.
 *
 * `includePrerelease` is load-bearing, not a convenience. The harness ships
 * nothing but `-rc` versions, so under strict semver `^0.1.1-rc.2` excludes
 * every later rc on the same 0.1 line — including whichever one is installed
 * and working, named as a property because that version moves and a comment
 * naming it goes stale in place — and every future rc bump would raise a
 * false alarm. With it on, the range still excludes an older prerelease
 * (`0.1.1-rc.1`) and a minor- or major-line move
 * (`0.2.0-rc.1`, `1.0.0`), which are the moves that actually break a plugin
 * path. Discrimination on both sides is the whole point: one false warning
 * teaches a reader to ignore every warning.
 *
 * Anything unreadable yields NO verdict for that peer and never a violation:
 * a resolver that answers null or throws, a found version that is not
 * semver, a declared range semver cannot parse. The other peers are still
 * judged.
 */
export function peerVersionMismatches(
  ranges: Readonly<Record<string, string>>,
  resolve: PeerVersionResolver,
): PeerVersionMismatch[] {
  const mismatches: PeerVersionMismatch[] = []
  for (const spec of Object.keys(ranges).sort()) {
    const range = ranges[spec]
    if (range === undefined || validRange(range) === null) continue
    let found: string | null
    try {
      found = resolve(spec)
    } catch {
      // Swallows a resolver that threw: the same rule incompatibilityMap
      // documents, for the same reason — an unavailable fact must never read
      // as an accusation. Nothing else can reach it; every other failure mode
      // arrives as null.
      continue
    }
    if (found === null || valid(found) === null) continue
    if (satisfies(found, range, { includePrerelease: true })) continue
    mismatches.push({ spec, range, found })
  }
  return mismatches
}

/**
 * The load-time message for a set of mismatches, or null when there is
 * nothing to say. Every mismatch is named with its declared range and the
 * version found, in ONE message: the reader needs the whole picture in the
 * line they will scroll past, and the message says the shop still loads
 * because refusing to load would cost them the shop over a diagnostic.
 */
export function peerVersionWarning(mismatches: readonly PeerVersionMismatch[]): string | null {
  if (mismatches.length === 0) return null
  const named = mismatches.map(({ spec, range, found }) => `${spec} ${range}, found ${found}`).join('; ')
  return `dsh-plugin-shop: the harness does not provide the peer versions this shop declares — ${named}.`
    + ' The shop still loads; if a path misbehaves, check this first.'
}

/** What a load-time check needs: the ranges this build declares, a way to
 * read what the installation provides, and somewhere to say it once. */
export interface PeerVersionCheckDeps {
  ranges: Readonly<Record<string, string>>
  resolve: PeerVersionResolver
  warn: (message: string) => void
}

/**
 * A self-check that warns AT MOST ONCE, however many times it is called.
 * The guard is what keeps a diagnostic a diagnostic: a message repeated per
 * call is noise a reader learns to skip, and the shop's load path is not the
 * only place that could reasonably ask this question.
 *
 * It never throws. A check that could fail a load would be worse than the
 * mismatch it reports — the user would lose the whole shop over a warning.
 */
export function createPeerVersionCheck(deps: PeerVersionCheckDeps): () => void {
  let spoken = false
  return () => {
    if (spoken) return
    spoken = true
    try {
      const message = peerVersionWarning(peerVersionMismatches(deps.ranges, deps.resolve))
      if (message !== null) deps.warn(message)
    } catch {
      // Swallows anything the injected resolver, or the sink, throws.
      // peerVersionMismatches already turns a throwing resolver into
      // no-verdict, so nothing else should reach this; a load must not fail
      // over a self-check either way.
    }
  }
}
