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
 * failure. Refuses, non-zero, when `dist/v1` is older than that `latest` —
 * a tree nobody rebuilt, which the hash check cannot distinguish from a
 * fresh one (see `catalogPublishDecision`).
 */

import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { npmArtifactNames } from './pages-artifacts.ts'
import { withTimeout } from './npm-client.ts'
import {
  catalogPackageFiles,
  catalogPublishDecision,
  nextCatalogVersion,
  type PublishedCatalog,
} from './npm-package.ts'

/**
 * Deadline on resolving the published packument — the request that DECIDES
 * whether to publish. Generous, because being wrong here blocks a release
 * rather than degrading one, and it is a single request on a job with a
 * ten-minute budget.
 */
const REGISTRY_REQUEST_TIMEOUT_MS = 60_000

/**
 * Deadline on one npmmirror warm request. Tighter than the registry's because
 * the warm loop makes up to 21 of them with 3s between: at 30s apiece a
 * stalled mirror would need 11.5 minutes and take the job's ten-minute bound
 * with it, failing a release that had ALREADY published successfully. At 10s
 * the same total stall costs 4.4 minutes and still warms nothing, which is the
 * documented best-effort outcome.
 */
const MIRROR_REQUEST_TIMEOUT_MS = 10_000

const timedRegistryFetch = withTimeout(fetch, REGISTRY_REQUEST_TIMEOUT_MS, 'npm registry')
const timedMirrorFetch = withTimeout(fetch, MIRROR_REQUEST_TIMEOUT_MS, 'npmmirror')

// Real work — resolving the published packument over the network and, past
// that, an actual `npm publish` — belongs to the entry point alone, never to
// an import, so all of it runs inside the guard below and none of it outside.
// The guard is POSITIVE and the comparison EXACT, both deliberately.
// Positive: the form this replaced ended in `process.exit(0)` at module
// scope, which terminates whatever process IMPORTS this module — under
// vitest, a worker that vanishes mid-suite and reports success. emit-schema.ts
// drew the positive line first, and schema.test.ts already relies on it to
// import renderJsonSchema without the write side effect.
// Exact: `endsWith('publish-catalog.ts')` also admits `republish-catalog.ts`,
// and a wrapper or symlink of that name would have made this step exit 0
// having published nothing. `node -e` leaves process.argv[1] undefined, so
// basename('') matches no name and a bare import runs nothing.
// registry/scripts/tests/strip-types.test.ts derives the entry-point list and
// holds every member of it to both halves of this.
if (basename(process.argv[1] ?? '') === 'publish-catalog.ts') {
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

  /** The published `latest`: the hashes it was built from, and the build time
   * it carries. Absent when the package has never been published — the first
   * run. `catalogBuiltAt` is absent on every version published before the
   * ordering guard existed, which is what the `null` distinguishes. */
  async function publishedLatest(): Promise<PublishedCatalog | null> {
    const response = await timedRegistryFetch(`${REGISTRY}/${PACKAGE_NAME}`)
    if (response.status === 404) return null
    if (!response.ok) throw new Error(`resolving ${PACKAGE_NAME} returned ${response.status}`)
    const packument = await response.json() as {
      'dist-tags'?: { latest?: string }
      versions?: Record<string, {
        catalogShas?: { plugins: string; stars: string | null }
        catalogBuiltAt?: string
      }>
    }
    const version = packument['dist-tags']?.latest
    if (version === undefined) return null
    const record = packument.versions?.[version]
    return {
      version,
      shas: record?.catalogShas ?? { plugins: '', stars: null },
      builtAt: record?.catalogBuiltAt ?? null,
    }
  }

  const previous = await publishedLatest()
  const decision = catalogPublishDecision({ builtAt: pointer.builtAt, shas }, previous)
  if (decision.kind === 'skip') {
    console.log(decision.reason)
    process.exit(0)
  }
  if (decision.kind === 'refuse') {
    // Non-zero, and refused before `--dry-run` gets a say: a dry run whose only
    // fault is a tree nobody rebuilt should report that, not rehearse a publish
    // that must not happen. This is the last point at which anything can notice
    // (2026-09-03: nothing did, and `latest` went back two days).
    console.error(`publish:catalog refused: ${decision.reason}`)
    process.exit(1)
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
  // Copied, never regenerated: these are the bytes Pages serves. The list
  // itself lives in pages-artifacts.ts beside the Pages one, so the single
  // file the two transports differ by is stated rather than coincidental.
  for (const name of npmArtifactNames(pointer)) {
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
    const created = await timedMirrorFetch(`${MIRROR_SYNC}/-/package/${PACKAGE_NAME}/syncs`, { method: 'PUT' })
    const task = await created.json() as { id?: string }
    if (task.id === undefined) throw new Error(`sync request returned ${created.status}`)
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const status = await timedMirrorFetch(`${MIRROR_SYNC}/-/package/${PACKAGE_NAME}/syncs/${task.id}`)
      const state = (await status.json() as { state?: string }).state
      if (state !== 'waiting') { console.log(`npmmirror sync ${task.id}: ${String(state)}`); break }
      await new Promise(resolve => setTimeout(resolve, 3000))
    }
  } catch (error) {
    console.warn(`npmmirror sync could not be triggered: ${String(error)}`)
  }
}
