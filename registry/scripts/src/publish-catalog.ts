/**
 * Publish `dist/v1/` to npm as `dsh-plugin-shop-catalog` (design §2).
 *
 * Shell: reads the clock, the filesystem, the network, and spawns `npm
 * publish`. Every decision that could be made without those is in
 * `npm-package.ts`, which this only calls.
 *
 *   node --experimental-strip-types registry/scripts/src/publish-catalog.ts [--dry-run]
 *
 * Skips when the published `latest` already carries the same plugins and
 * stars hashes. Exits 0 on a skip: an unchanged catalog is a success, not a
 * failure.
 */

import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { catalogPackageFiles, nextCatalogVersion } from './npm-package.ts'

const OUT_DIR = 'dist/v1'
const PKG_DIR = 'dist/npm'
const PACKAGE_NAME = 'dsh-plugin-shop-catalog'
const REGISTRY = 'https://registry.npmjs.org'
const MIRROR_SYNC = 'https://registry-direct.npmmirror.com'

const dryRun = process.argv.includes('--dry-run')

interface Pointer {
  builtAt: string
  count: number
  plugins: { url: string; sha256: string }
  stars?: { url: string; sha256: string }
}

const pointer = JSON.parse(readFileSync(join(OUT_DIR, 'index.json'), 'utf8')) as Pointer
const shas = { plugins: pointer.plugins.sha256, stars: pointer.stars?.sha256 ?? null }

/** The published `latest`, and the hashes it was built from. Absent when the
 * package has never been published — the first run. */
async function publishedLatest(): Promise<{ version: string; shas: { plugins: string; stars: string | null } } | null> {
  const response = await fetch(`${REGISTRY}/${PACKAGE_NAME}`)
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`resolving ${PACKAGE_NAME} returned ${response.status}`)
  const packument = await response.json() as {
    'dist-tags'?: { latest?: string }
    versions?: Record<string, { catalogShas?: { plugins: string; stars: string | null } }>
  }
  const version = packument['dist-tags']?.latest
  if (version === undefined) return null
  return { version, shas: packument.versions?.[version]?.catalogShas ?? { plugins: '', stars: null } }
}

const previous = await publishedLatest()
if (previous !== null && previous.shas.plugins === shas.plugins && previous.shas.stars === shas.stars) {
  console.log(`catalog unchanged since ${previous.version} — nothing to publish`)
  process.exit(0)
}

const version = nextCatalogVersion(new Date(), previous?.version ?? null)
const files = catalogPackageFiles({
  version,
  builtAt: pointer.builtAt,
  count: pointer.count,
  pluginsFileName: pointer.plugins.url,
  starsFileName: pointer.stars?.url ?? null,
  shas,
})

rmSync(PKG_DIR, { recursive: true, force: true })
mkdirSync(join(PKG_DIR, 'v1'), { recursive: true })
writeFileSync(join(PKG_DIR, 'package.json'), files.packageJson)
writeFileSync(join(PKG_DIR, 'index.js'), files.indexJs)
writeFileSync(join(PKG_DIR, 'README.md'), files.readme)
// Copied, never regenerated: these are the bytes Pages serves.
for (const name of ['index.json', pointer.plugins.url, ...(pointer.stars === undefined ? [] : [pointer.stars.url])]) {
  copyFileSync(join(OUT_DIR, name), join(PKG_DIR, 'v1', name))
}

if (dryRun) {
  console.log(`would publish ${PACKAGE_NAME}@${version} from ${PKG_DIR}`)
  // Actually invoke npm, with --dry-run appended, for exactly one reason:
  // what ships is decided by npm's own packlist (the `files` field in
  // package.json plus its built-in ignore rules), not by the copyFileSync
  // calls above, and nothing else here checks it. A wrong packlist is not a
  // re-runnable inconvenience once this is a real publish — npm refuses to
  // republish a version (item 2(a), 2026-09 review).
  //
  // That is ALL it proves. `--dry-run` performs no registry interaction, so
  // it exercises neither the ~/.npmrc auth path nor provenance minting nor
  // the registry's acceptance of the package: it exits 0 with an
  // unroutable registry, an unexpanded `_authToken`, and no token in the
  // environment at all (measured, item E of the 2026-09 review). Only the
  // real publish below proves those, and NPM_CONFIG_PROVENANCE is set on
  // that step alone.
  execFileSync('npm', ['publish', '--dry-run', '--access', 'public'], { cwd: PKG_DIR, stdio: 'inherit' })
  process.exit(0)
}

execFileSync('npm', ['publish', '--access', 'public'], { cwd: PKG_DIR, stdio: 'inherit' })
console.log(`published ${PACKAGE_NAME}@${version}`)

// Warm the mirror. npmmirror syncs on demand, and without this the first
// reader of each new version pays for the cold cache — precisely the reader
// this whole design exists for (design §2). Failing to warm is not failing to
// publish, so this never exits non-zero.
try {
  const created = await fetch(`${MIRROR_SYNC}/-/package/${PACKAGE_NAME}/syncs`, { method: 'PUT' })
  const task = await created.json() as { id?: string }
  if (task.id === undefined) throw new Error(`sync request returned ${created.status}`)
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const status = await fetch(`${MIRROR_SYNC}/-/package/${PACKAGE_NAME}/syncs/${task.id}`)
    const state = (await status.json() as { state?: string }).state
    if (state !== 'waiting') { console.log(`npmmirror sync ${task.id}: ${String(state)}`); break }
    await new Promise(resolve => setTimeout(resolve, 3000))
  }
} catch (error) {
  console.warn(`npmmirror sync could not be triggered: ${String(error)}`)
}
