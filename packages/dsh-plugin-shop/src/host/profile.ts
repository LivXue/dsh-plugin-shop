/** Profile directory discovery and user-layer writes (§8: hot enable/disable). */

import { existsSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { loadOptionalPatches } from '@deepseek-ai/dsh-app-boot'
import { dump } from 'js-yaml'

/** One id-targeted user-layer row (§8: the CLI hot-reloads this file). */
export interface UserLayerRow { id: string; disabled: boolean }

interface ProfileShape { dsh?: { profile?: { bundles?: unknown } } }

interface PackageShape { dsh?: { bundle?: { patch?: unknown } } }

/**
 * Find the profile directory that owns `startPath`.
 *
 * `baseDir` is the boot-provided profile directory (the Loader root's own
 * directory, `ctx.baseUrl`) and is authoritative when it is a profile. The
 * walk-up from `startPath` covers the case where the package is materialized
 * inside the profile's node_modules — but a `link:` install keeps the package
 * at its source location, so no ancestor of the module path is a profile at
 * all. In that case only `baseDir` can answer.
 */
export function discoverProfile(startPath: string, baseDir?: string): { name: string; dir: string } {
  if (baseDir !== undefined && isProfileDir(baseDir)) return { name: basename(baseDir), dir: baseDir }
  let dir = realpathNearestExisting(startPath)
  for (;;) {
    if (isProfileDir(dir)) return { name: basename(dir), dir }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  throw new Error(`dsh-plugin-shop: no profile directory found above ${startPath}`)
}

/** A directory is a profile when it holds the Loader root next to the bundle
 * manifest the shop's own package.json declares itself part of. */
function isProfileDir(dir: string): boolean {
  if (!existsSync(join(dir, 'cordis.yml'))) return false
  try {
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as ProfileShape
    return Array.isArray(manifest.dsh?.profile?.bundles)
  } catch {
    // A package.json that cannot be read or parsed is not a profile manifest.
  }
  return false
}

/** Resolve symlinks through the deepest ancestor of `startPath` that exists.
 * The leaf — the shop's own module file — need not be present yet for
 * discovery to know where it lives. */
function realpathNearestExisting(startPath: string): string {
  let current = startPath
  for (;;) {
    try {
      return realpathSync(current)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = dirname(current)
      if (parent === current) return current
      current = parent
    }
  }
}

/**
 * Upsert one row of the profile's user layer (`cordis.patch.yml`). Enabling
 * removes the row so the bundle default rules again; disabling writes
 * `{ id, disabled: true }` (§8: the CLI's watchUserPatches applies the change
 * hot through HMR). Existing rows for other ids are preserved verbatim.
 */
export function setUserLayerRow(options: { profileDir: string; row: UserLayerRow }): void {
  setUserLayerRows({ profileDir: options.profileDir, rows: [options.row] })
}

/**
 * Write every user-layer row of one package in a single pass.
 *
 * A package owns as many loader entries as its bundle patch inserts (see
 * {@link ownedEntryIds}), and they toggle together: writing them one at a
 * time would read-modify-write the file once per entry, so a crash between
 * two writes would leave the package half disabled.
 */
export function setUserLayerRows(options: { profileDir: string; rows: UserLayerRow[] }): void {
  const file = join(options.profileDir, 'cordis.patch.yml')
  const existing = loadOptionalPatches('dsh-plugin-shop', file) ?? []
  const touched = new Set(options.rows.map(row => row.id))
  const others = existing.filter(row => !touched.has(row.id as string))
  const next = [...others, ...options.rows.filter(row => row.disabled).map(row => ({ id: row.id, disabled: true }))]
  const tmp = `${file}.tmp`
  writeFileSync(tmp, dump(next, { noRefs: true }))
  renameSync(tmp, file)
}

/**
 * The loader entry ids one installed package contributes to the tree.
 *
 * This — not the entry's module name — is what identifies a package's rows.
 * A package declares a bundle patch whose `insert` list may add zero, one, or
 * many entries, and an inserted entry's `name` is the MODULE it mounts, which
 * need not be the package at all: `@tt-a1i/archify-dsh` inserts a configured
 * instance of `@deepseek-ai/dsh-skill-filesystem` and registers no module of
 * its own. Matching a package to its rows by module name therefore finds
 * nothing for such a package, which is why the toggle reported it as not
 * installed. The ids the package's own patch inserts are the only honest
 * answer, and the inventory's `entryId` is exactly that id verbatim.
 *
 * Ids the patch merely TARGETS (a bare id-keyed row overriding config) are
 * not owned: those rows belong to whoever inserted them, and claiming them
 * would let one package disable another's entries.
 *
 * A package with no bundle patch, or one absent from the profile, owns
 * nothing and yields `[]` — a distinct fact from "the entry is not live",
 * which only the inventory can answer.
 */
export function ownedEntryIds(options: { profileDir: string; packageName: string }): string[] {
  const packageDir = join(options.profileDir, 'node_modules', ...options.packageName.split('/'))
  const manifestPath = join(packageDir, 'package.json')
  if (!existsSync(manifestPath)) return []
  let patchRelative: unknown
  try {
    patchRelative = (JSON.parse(readFileSync(manifestPath, 'utf8')) as PackageShape).dsh?.bundle?.patch
  } catch (error) {
    throw new Error(`dsh-plugin-shop: failed to read ${manifestPath}: ${String(error)}`)
  }
  if (typeof patchRelative !== 'string') return []
  // The path comes from an untrusted package manifest and is about to be
  // read: confine it to the package's own directory rather than trusting a
  // `../` spelling to be a typo.
  const patchFile = resolve(packageDir, patchRelative)
  const inside = relative(packageDir, patchFile)
  if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) {
    throw new Error(`dsh-plugin-shop: ${options.packageName} declares a bundle patch outside its own directory: ${patchRelative}`)
  }
  const ids: string[] = []
  collectInsertedIds(loadOptionalPatches('dsh-plugin-shop', patchFile) ?? [], ids)
  return [...new Set(ids)]
}

/** Walk a patch list, appending the id of every INSERTED entry. A patch row
 * without `insert` targets an entry someone else composed — the loader's
 * applyEntryPatches looks it up and skips it when absent, so it creates
 * nothing and owns nothing. An inserted GROUP owns its children, which the
 * loader reads from the group's own `config` array. */
function collectInsertedIds(rows: readonly unknown[], into: string[]): void {
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue
    const inserted = (row as { insert?: unknown }).insert
    if (Array.isArray(inserted)) collectEntryIds(inserted, into)
  }
}

function collectEntryIds(entries: readonly unknown[], into: string[]): void {
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object') continue
    const { id, group, config } = entry as { id?: unknown; group?: unknown; config?: unknown }
    if (typeof id === 'string') into.push(id)
    if (group === true && Array.isArray(config)) collectEntryIds(config, into)
  }
}

/**
 * Does a live loader entry id belong to the package that owns `owned`?
 *
 * `owned` holds CONFIG ids — the ids a bundle patch's `insert` declares. A
 * LIVE id is that id under the namespace of every tree composed above it,
 * colon-joined, so the last segment is the declared id and the segments
 * before it name the trees:
 *
 * - `foo` — no tree above the entry at all (a harness that composes the
 *   entry list directly).
 * - `include:foo` — what a REAL dsh boot produces: app-boot mounts the whole
 *   profile as one root Include entry (`id: include`), so EVERY entry any
 *   bundle patch inserted is namespaced by it. Matching only the bare
 *   spelling found no row for any installed package, and the toggle answered
 *   "not in the running plugin tree" for all of them.
 * - `include:<tree>:mkt-foo` — the shop's own hot subtree, which prefixes its
 *   rows `mkt-` so a plugin installed this session cannot collide with a
 *   boot-layer id. The same plugin, one restart earlier.
 *
 * The last segment is therefore the answer, with `mkt-` stripped when a tree
 * namespace is present.
 */
export function ownsEntryId(owned: ReadonlySet<string>, entryId: string): boolean {
  if (owned.has(entryId)) return true
  // The hot spelling is only ever reachable through an Include tree, so it
  // always carries the tree's namespace. Without that colon requirement a
  // BARE boot id literally named `mkt-foo` would be read as the hot form of
  // `foo` and hand one package's toggle another package's live entry.
  const colon = entryId.lastIndexOf(':')
  if (colon === -1) return false
  const tail = entryId.slice(colon + 1)
  if (owned.has(tail)) return true
  return tail.startsWith('mkt-') && owned.has(tail.slice('mkt-'.length))
}
