/** Profile directory discovery and user-layer writes (§8: hot enable/disable). */

import { chmodSync, existsSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { loadOptionalPatches } from '@deepseek-ai/dsh-app-boot'
import { isMap, isSeq, parseDocument, type YAMLMap } from 'yaml'
import { bundlePatchFiles } from './bundle-patch.ts'

/** One id-targeted user-layer row (§8: the CLI hot-reloads this file). */
export interface UserLayerRow {
  id: string
  disabled: boolean
  /** The module the entry mounts, when the caller knows it. A user-layer row
   * that names a DIFFERENT module is one the harness skips
   * (applyEntryPatches), so only this name lets a named row be written. */
  name?: string
}

interface ProfileShape { dsh?: { profile?: { bundles?: unknown } } }

interface PackageShape { dsh?: { bundle?: { patch?: unknown } } }

/** The loader's `!!js` expression scalar, for the document edit: read as its
 * source text and written back under its own tag, never evaluated — the
 * loader evaluates it at entry activation. The same declaration the harness's
 * own writer of this file uses (`@deepseek-ai/dsh-plugin-manager` 0.1.7). */
const USER_LAYER_TAGS = [{ tag: 'tag:yaml.org,2002:js', resolve: (source: string) => source }]

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
 * Set one entry's `disabled` key in the profile's user layer
 * (`cordis.patch.yml`) — {@link setUserLayerRows} for a single row, with the
 * same rules: one key changes and nothing else does (§8: the CLI's
 * watchUserPatches applies the change hot through HMR).
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
 *
 * The edit changes one key and nothing else (design
 * 2026-09-26-market-borrowings §2). The layer is validated by the harness's
 * own parser first, so one it cannot load still throws and is never
 * rewritten; it is then edited as a YAML document, which keeps every comment,
 * every other row, every other key and every `!!js` scalar as the user wrote
 * them. The whole-file rewrite this replaced dropped each toggled id's row —
 * and with it a `config:` override the user had put there — and dumped the
 * list back through a library that models no comments, so the first toggle
 * erased the header dsh writes into every new profile.
 *
 * For each entry the row written is the LAST one carrying its id, when the
 * harness is sure to apply it: applyEntryPatches applies rows in order and
 * each key replaces the entry's value, so the last row that sets `disabled`
 * decides it. A row with `insert` is an insertion into a group, never an
 * override; a row naming another module is skipped by the harness; a named
 * row whose module the caller did not say cannot be judged. In each of those
 * cases a row is appended instead, which the harness applies last whatever
 * came before it — so appending is never wrong, only less tidy.
 *
 * An enable writes `disabled: false` rather than deleting the row, which is
 * what lost a user's row or the comment above it; it is also the harness's
 * own convention for this file from 0.1.7. The file keeps its permission bits
 * across the rename (a new one is created owner-only, as the harness's writer
 * does), because a config override can hold a credential.
 */
export function setUserLayerRows(options: { profileDir: string; rows: UserLayerRow[] }): void {
  const file = join(options.profileDir, 'cordis.patch.yml')
  // The harness's parser is still the authority on whether the layer loads:
  // what it refuses is never rewritten.
  loadOptionalPatches('dsh-plugin-shop', file)
  let text = '[]\n'
  let mode = 0o600
  if (existsSync(file)) {
    text = readFileSync(file, 'utf8')
    mode = statSync(file).mode & 0o777
  }
  const document = parseDocument(text, { customTags: USER_LAYER_TAGS })
  const parseError = document.errors[0]
  if (parseError !== undefined) throw parseError
  const list = document.contents
  if (!isSeq(list)) throw new Error(`dsh-plugin-shop: ${file} is not a YAML list of patch rows`)
  for (const row of options.rows) {
    const target = lastRowFor(list.items, row.id)
    if (target !== null && appliesTo(target, row.name)) {
      target.set('disabled', row.disabled)
      continue
    }
    // The template dsh writes is `[]`: an appended row would otherwise stay
    // inside the brackets, and the file would stop being one row per line.
    if (list.items.length === 0) list.flow = false
    document.add({ id: row.id, disabled: row.disabled })
  }
  const tmp = `${file}.tmp`
  writeFileSync(tmp, document.toString({ lineWidth: 0 }), { mode })
  // `mode` above applies only when the write CREATES the file, and a crashed
  // earlier write may have left this one behind.
  chmodSync(tmp, mode)
  renameSync(tmp, file)
}

/** The last override row carrying `id`, or null when there is none. A row
 * with `insert` is an insertion into group `id`, not an override of it. */
function lastRowFor(items: readonly unknown[], id: string): YAMLMap | null {
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index]
    if (isMap(item) && !item.has('insert') && item.get('id') === id) return item
  }
  return null
}

/** Whether the harness is sure to apply `row` to the entry mounting
 * `moduleName`: a row with no `name`, or one naming that very module. */
function appliesTo(row: YAMLMap, moduleName: string | undefined): boolean {
  if (!row.has('name')) return true
  return moduleName !== undefined && row.get('name') === moduleName
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
  return ownedEntries(options).map(entry => entry.id)
}

/** One loader entry a package's bundle patch inserts: its id, and the module
 * it mounts when the patch names one as a plain string. */
export interface OwnedEntry { id: string; name: string | undefined }

/**
 * {@link ownedEntryIds} with the module each entry mounts beside its id. The
 * name is what the harness judges a NAMED user-layer row by — a row naming a
 * different module is skipped (applyEntryPatches) — so it is what lets the
 * toggle write a user's own named row rather than append one beside it. It is
 * read through the harness's parser, so a relative name arrives anchored to a
 * file URL exactly as the composed entry carries it; an `!!js` name has no
 * plain value and reads as undefined. Throws where `ownedEntryIds` does.
 */
export function ownedEntries(options: { profileDir: string; packageName: string }): OwnedEntry[] {
  const packageDir = join(options.profileDir, 'node_modules', ...options.packageName.split('/'))
  const manifestPath = join(packageDir, 'package.json')
  if (!existsSync(manifestPath)) return []
  let declared: unknown
  try {
    declared = (JSON.parse(readFileSync(manifestPath, 'utf8')) as PackageShape).dsh?.bundle?.patch
  } catch (error) {
    throw new Error(`dsh-plugin-shop: failed to read ${manifestPath}: ${String(error)}`)
  }
  // One file, or a list applied in order (dsh 0.1.7); a declaration dsh
  // refuses composes nothing, so it owns nothing.
  const files = bundlePatchFiles(declared)
  if (files === null) return []
  const entries: OwnedEntry[] = []
  for (const file of files) {
    // The path comes from an untrusted package manifest and is about to be
    // read: confine it to the package's own directory rather than trusting a
    // `../` spelling to be a typo.
    const patchFile = resolve(packageDir, file)
    const inside = relative(packageDir, patchFile)
    if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) {
      throw new Error(`dsh-plugin-shop: ${options.packageName} declares a bundle patch outside its own directory: ${file}`)
    }
    collectInsertedEntries(loadOptionalPatches('dsh-plugin-shop', patchFile) ?? [], entries)
  }
  // One per id, first spelling kept — the id is the identity, as before.
  const seen = new Set<string>()
  return entries.filter(entry => !seen.has(entry.id) && seen.add(entry.id) !== undefined)
}

/**
 * An installed package's own `dsh.bundle.patch`, exactly as declared, or
 * undefined when the package, its manifest or the field is absent — or the
 * manifest cannot be read, which no post-install check can judge either.
 */
export function declaredBundlePatch(options: { profileDir: string; packageName: string }): unknown {
  const manifestPath = join(options.profileDir, 'node_modules', ...options.packageName.split('/'), 'package.json')
  try {
    return (JSON.parse(readFileSync(manifestPath, 'utf8')) as PackageShape).dsh?.bundle?.patch
  } catch {
    // Swallows an absent or unparseable manifest: nothing then says what the
    // package declares, and the install's own confirm has already judged
    // whether it landed.
    return undefined
  }
}

/** Walk a patch list, appending every INSERTED entry. A patch row without
 * `insert` targets an entry someone else composed — the loader's
 * applyEntryPatches looks it up and skips it when absent, so it creates
 * nothing and owns nothing. An inserted GROUP owns its children, which the
 * loader reads from the group's own `config` array. */
function collectInsertedEntries(rows: readonly unknown[], into: OwnedEntry[]): void {
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue
    const inserted = (row as { insert?: unknown }).insert
    if (Array.isArray(inserted)) collectEntries(inserted, into)
  }
}

function collectEntries(entries: readonly unknown[], into: OwnedEntry[]): void {
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object') continue
    const { id, name, group, config } = entry as { id?: unknown; name?: unknown; group?: unknown; config?: unknown }
    if (typeof id === 'string') into.push({ id, name: typeof name === 'string' ? name : undefined })
    if (group === true && Array.isArray(config)) collectEntries(config, into)
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

/**
 * The loader entry id `packageName` shares with another installed package, or
 * null when it collides with nothing.
 *
 * The collision a bundle-name check cannot see. A bundle name and a loader
 * entry id are independent: two DIFFERENTLY-named bundles may both declare
 * `id: plugin-manager` — measured on `2768651338/dsh-plugin-manager` and
 * `Dingpenghui-good/dsh-plugin-manager` — and dsh then refuses to load the
 * whole tree ("duplicate loader entry id"), so the profile does not boot.
 * Conversely two SAME-named plugins often declare different ids and would
 * coexist fine, which is why the name gate is about overwriting a manifest
 * key and this is about the loader.
 *
 * Best-effort per package, the same rule the installed list uses: an
 * unreadable patch in some OTHER package owns nothing here rather than
 * failing the caller. A package declaring no ids collides with nothing.
 */
export function collidingEntryId(options: {
  profileDir: string
  packageName: string
  /** Every installed package name, `packageName` included or not. */
  dependencies: readonly string[]
}): { id: string; holder: string } | null {
  const idsOrNone = (packageName: string): string[] => {
    try {
      return ownedEntryIds({ profileDir: options.profileDir, packageName })
    } catch {
      return []
    }
  }
  const mine = new Set(idsOrNone(options.packageName))
  if (mine.size === 0) return null
  for (const holder of options.dependencies) {
    if (holder === options.packageName) continue
    for (const id of idsOrNone(holder)) {
      if (mine.has(id)) return { id, holder }
    }
  }
  return null
}
