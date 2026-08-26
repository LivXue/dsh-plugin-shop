/** Profile directory discovery and user-layer writes (§8: hot enable/disable). */

import { existsSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { loadOptionalPatches } from '@deepseek-ai/dsh-app-boot'
import { dump } from 'js-yaml'

/** One id-targeted user-layer row (§8: the CLI hot-reloads this file). */
export interface UserLayerRow { id: string; disabled: boolean }

interface ProfileShape { dsh?: { profile?: { bundles?: unknown } } }

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
 * manifest the store's own package.json declares itself part of. */
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
 * The leaf — the store's own module file — need not be present yet for
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
  const file = join(options.profileDir, 'cordis.patch.yml')
  const rows = loadOptionalPatches('dsh-plugin-shop', file) ?? []
  const others = rows.filter(row => row.id !== options.row.id)
  const next = options.row.disabled
    ? [...others, { id: options.row.id, disabled: true }]
    : others
  const tmp = `${file}.tmp`
  writeFileSync(tmp, dump(next, { noRefs: true }))
  renameSync(tmp, file)
}
