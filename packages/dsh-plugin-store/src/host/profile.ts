/** Profile directory discovery and user-layer writes (§8: hot enable/disable). */

import { existsSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { loadOptionalPatches } from '@deepseek-ai/dsh-app-boot'
import { dump } from 'js-yaml'

/** One id-targeted user-layer row (§8: the CLI hot-reloads this file). */
export interface UserLayerRow { id: string; disabled: boolean }

interface ProfileShape { dsh?: { profile?: { bundles?: unknown } } }

/**
 * Find the profile directory that owns `startPath` — the store bundle is a
 * dependency installed inside the active profile, so ascending from its own
 * module path to the nearest ancestor holding both the Loader root
 * (`cordis.yml`) and a `dsh.profile.bundles` manifest is filesystem fact,
 * not a guess.
 */
export function discoverProfile(startPath: string): { name: string; dir: string } {
  let dir = realpathNearestExisting(startPath)
  for (;;) {
    if (isProfileDir(dir)) return { name: basename(dir), dir }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  throw new Error(`dsh-plugin-store: no profile directory found above ${startPath}`)
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
  const rows = loadOptionalPatches('dsh-plugin-store', file) ?? []
  const others = rows.filter(row => row.id !== options.row.id)
  const next = options.row.disabled
    ? [...others, { id: options.row.id, disabled: true }]
    : others
  const tmp = `${file}.tmp`
  writeFileSync(tmp, dump(next, { noRefs: true }))
  renameSync(tmp, file)
}
