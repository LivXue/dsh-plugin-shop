/** Catalog fetch, verification, and disk cache — the Host's only network path. */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { z } from 'zod'
import type { CatalogEntry, DeniedEntry } from './types.ts'

/** Highest schemaVersion this build understands; a higher one is refused (§10).
 * 3 adds `source` and repo entries (github install channel); 4 adds `subdir`
 * for monorepo-subpackage entries (2026-08-31 hub-borrowings A); 5 adds
 * `added`, `tarball` (release rescue), the `theme` category, and
 * `denied[].replacement` (2026-08-31 market borrowings);
 * 6 adds `peers`, the package's declared peer dependency names
 * (2026-09-01 harness compatibility). */
export const SUPPORTED_SCHEMA_VERSION = 6

/** A cached catalog younger than this is served without touching the network. */
const FRESH_MS = 5 * 60 * 1000

/** Records when the loader itself wrote the cache; the pointer's `builtAt` is
 * the catalog's build time, not the cache's fetch time. */
const META_FILE = 'index.meta.json'

const entrySchema = z.object({
  name: z.string(),
  version: z.string(),
  integrity: z.string().nullable(),
  publishedAt: z.string().nullable(),
  repository: z.string().nullable(),
  license: z.string().nullable(),
  tier: z.enum(['verified', 'verified-stale', 'community']),
  metadata: z.enum(['declared', 'derived']),
  review: z.object({
    reviewedVersion: z.string().optional(),
    reviewedCommit: z.string().optional(),
    // The release-rescued pin: the reviewed tarball's content hash, never the
    // tag (a tag is a mutable ref an author can re-point at different content).
    reviewedSha256: z.string().optional(),
    reviewer: z.string(),
    reviewCommit: z.string(),
    notes: z.string(),
  }).optional(),
  catalog: z.object({
    // v5: `theme` joins the enum. An old client's closed enum rejects a
    // catalog containing it wholesale, which is why v5 is emitted only behind
    // the release-time SHOP_CATALOG_V5 flag (design §3.5).
    category: z.enum(['tool', 'provider', 'ui', 'workflow', 'integration', 'theme', 'other']),
    summary: z.object({ en: z.string(), zh: z.string().optional() }),
    capabilities: z.array(z.string()),
  }).optional(),
  // v3 (github channel); defaulted so a cached v2 catalog still parses.
  source: z.enum(['npm', 'github']).default('npm'),
  repo: z.string().optional(),
  // v4 (monorepo subpackages). The value reaches the install spec's argv,
  // so the boundary keeps it to relative directory segments — and no
  // segment may be `.` or `..`, which would escape the repository root.
  subdir: z.string().regex(/^(?!.*(^|\/)\.\.?(\/|$))[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/).optional(),
  // v5 (market borrowings): `added` on every entry, and the release-rescue
  // `tarball` — whose URL the coherence check below binds to the entry's
  // own repo. `added` is OPTIONAL on the consumer: the live v4 catalog (and
  // any cached pre-v5 data file) carries no such field, and requiring it
  // made 0.5.0 refuse the still-published v4 catalog outright. Our own
  // builds always carry it (registry E9); the client never renders it.
  added: z.string().optional(),
  tarball: z.object({ url: z.string(), sha256: z.string() }).optional(),
  // v6: the package's declared peer dependency names. OPTIONAL on the
  // consumer, and this is not a style preference: the live catalog is v5 and
  // carries no such field, and making `added` required is exactly what made
  // 0.5.0 refuse the published catalog for every user.
  peers: z.array(z.string()).optional(),
})

const dataSchema = z.object({
  schemaVersion: z.number(),
  plugins: z.array(entrySchema),
  // v5: `replacement` names the known substitute on a denial.
  denied: z.array(z.object({ name: z.string(), detail: z.string(), replacement: z.string().optional() })).default([]),
})

/** The tarball URL must be the entry's own GitHub release — path segments
 * `/<owner>/<repo>/releases/...` matching the entry's `repo` (case-
 * insensitive). A catalog row that names a trusted repo but installs an
 * archive from somewhere else is refused loudly, never installed
 * (dsh-market's release-binding rule, their sources.ts:16-49). */
function validateEntryCoherence(entries: CatalogEntry[]): void {
  for (const entry of entries) {
    if (entry.tarball === undefined) continue
    if (entry.source !== 'github' || entry.repo === undefined) {
      throw new Error(`catalog entry ${entry.name}: tarball requires a github entry with a repo`)
    }
    let parsed: URL
    try {
      parsed = new URL(entry.tarball.url)
    } catch {
      throw new Error(`catalog entry ${entry.name}: tarball url is unparseable`)
    }
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com') {
      throw new Error(`catalog entry ${entry.name}: tarball url must be https on github.com`)
    }
    const segments = parsed.pathname.split('/').filter(s => s !== '')
    const owner = segments[0] ?? ''
    const slug = segments[1] ?? ''
    if (`${owner}/${slug}`.toLowerCase() !== entry.repo.toLowerCase() || segments[2] !== 'releases') {
      throw new Error(`catalog entry ${entry.name}: tarball url is not a release of ${entry.repo}`)
    }
  }
}

// Non-strict on purpose: a future index may carry keys this build does not
// know, and stripping them is what keeps old installed hosts working against
// it. Do not add .strict().
const pointerSchema = z.object({
  schemaVersion: z.number(),
  builtAt: z.string(),
  count: z.number(),
  plugins: z.object({ url: z.string(), sha256: z.string() }),
  stars: z.object({ url: z.string(), sha256: z.string() }).optional(),
})

export interface CatalogSnapshot {
  schemaVersion: number
  builtAt: string
  entries: CatalogEntry[]
  denied: DeniedEntry[]
  /** GitHub star counts by package name; {} when the pointer names no
   * sidecar or the sidecar could not be fetched/verified (spec §5). */
  stars: Record<string, number>
}

export interface CatalogResult { snapshot: CatalogSnapshot; stale: boolean }

export interface CatalogFs {
  exists: (path: string) => boolean
  read: (path: string) => string
  write: (path: string, data: string) => void
}

const nodeFs: CatalogFs = {
  exists: path => existsSync(path),
  read: path => readFileSync(path, 'utf8'),
  write: (path, data) => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, data)
  },
}

export interface LoadCatalogOptions {
  baseUrl: string
  cacheDir: string
  refresh?: boolean
  fetchImpl?: typeof fetch
  now?: () => Date
  fsImpl?: CatalogFs
  sleep?: (ms: number) => Promise<void>
}

/** Resolve the pointer's data URL against the catalog base. An absolute URL —
 * any scheme, or a protocol-relative `//host/...` — would hand the pointer a
 * fetch primitive to arbitrary hosts, so it is refused loudly before any
 * fetch (§9.2). The guard is the resolved origin, not the raw string: WHATWG
 * normalization strips leading whitespace and accepts backslash spellings
 * before the string could be inspected, so only comparing the resolved URL's
 * origin to the base's closes every spelling class. */
function resolveDataUrl(baseUrl: string, url: string): string {
  const resolved = new URL(url, baseUrl)
  if (resolved.origin !== new URL(baseUrl).origin) {
    throw new Error('catalog data url must be relative to the catalog base')
  }
  return resolved.href
}

/** Read and verify a cached/fetched stars sidecar; ANY irregularity degrades
 * to an empty map — stars are advisory (spec §5). */
function parseStarsText(text: string): Record<string, number> {
  try {
    const parsed = JSON.parse(text) as { stars?: unknown }
    if (typeof parsed.stars !== 'object' || parsed.stars === null) return {}
    const out: Record<string, number> = {}
    for (const [key, value] of Object.entries(parsed.stars)) {
      if (typeof value === 'number') out[key] = value
    }
    return out
  } catch {
    return {}
  }
}

/**
 * Load the catalog snapshot: fetch the pointer, verify the data file's sha256
 * against it, cache both on disk, and serve the cached copy with `stale: true`
 * only when the transport itself failed — the fetch threw or returned a
 * non-2xx (§10). A schemaVersion higher than this build supports, a malformed
 * pointer or data file, an absolute data URL, or a sha256 mismatch — fresh or
 * cached — throws even when a cache exists; never silently degraded. The stars
 * sidecar is the sole exception: any irregularity there, a refused url
 * included, degrades to no stars (spec §5).
 */
export async function loadCatalog(options: LoadCatalogOptions): Promise<CatalogResult> {
  const {
    baseUrl, cacheDir, refresh = false,
    fetchImpl = fetch, now = () => new Date(), fsImpl = nodeFs,
  } = options
  const indexPath = join(cacheDir, 'index.json')
  const metaPath = join(cacheDir, META_FILE)

  /** The timestamp freshness is measured from: the sidecar's fetch time when
   * it exists and parses, else the pointer's builtAt when that parses, else
   * null ("no usable freshness fact"). */
  const freshnessTimeOf = (builtAt: string): number | null => {
    if (fsImpl.exists(metaPath)) {
      try {
        const fetchedAt = Date.parse((JSON.parse(fsImpl.read(metaPath)) as { fetchedAt: string }).fetchedAt)
        if (!Number.isNaN(fetchedAt)) return fetchedAt
      } catch {
        // A corrupt sidecar means "no freshness fact"; fall through to builtAt.
      }
    }
    const built = Date.parse(builtAt)
    return Number.isNaN(built) ? null : built
  }

  const readCached = (): CatalogSnapshot | null => {
    let pointer: ReturnType<typeof pointerSchema.parse>
    let data: ReturnType<typeof dataSchema.parse>
    try {
      pointer = pointerSchema.parse(JSON.parse(fsImpl.read(indexPath)))
      if (pointer.schemaVersion > SUPPORTED_SCHEMA_VERSION) throw new Error(
        `catalog schemaVersion ${pointer.schemaVersion} is newer than this build supports (${SUPPORTED_SCHEMA_VERSION})`,
      )
      const dataPath = join(cacheDir, basename(pointer.plugins.url))
      const dataText = fsImpl.read(dataPath)
      // The cached bytes must still bind to the pointer's sha: installed
      // plugins hold full fs access and could rewrite the cache, so a file
      // that fails the check is treated as absent, never served (§9.2).
      const actual = createHash('sha256').update(dataText).digest('hex')
      if (actual !== pointer.plugins.sha256) {
        throw new Error(`cached catalog data failed integrity check: expected ${pointer.plugins.sha256}, got ${actual}`)
      }
      data = dataSchema.parse(JSON.parse(dataText))
      if (data.schemaVersion > SUPPORTED_SCHEMA_VERSION) throw new Error(
        `catalog schemaVersion ${data.schemaVersion} is newer than this build supports (${SUPPORTED_SCHEMA_VERSION})`,
      )
    } catch {
      // Cache unreadable or invalid — treat as absent rather than failing a
      // boot that could instead fetch a fresh catalog.
      return null
    }
    // The binding check sits OUTSIDE the swallow: a cached row that names a
    // trusted repo but installs an archive from somewhere else is a poisoned
    // cache, refused loudly like the wire version — never served stale and
    // never silently refetched (§9.2 fail-loudly).
    validateEntryCoherence(data.plugins)
    let stars: Record<string, number> = {}
    if (pointer.stars !== undefined) {
      try {
        const starsText = fsImpl.read(join(cacheDir, basename(pointer.stars.url)))
        const starsActual = createHash('sha256').update(starsText).digest('hex')
        if (starsActual === pointer.stars.sha256) stars = parseStarsText(starsText)
      } catch {
        // A missing or tampered cached sidecar means no stars this boot; the
        // catalog bytes are already verified above, so nothing else fails.
      }
    }
    return {
      schemaVersion: pointer.schemaVersion,
      builtAt: pointer.builtAt,
      entries: data.plugins,
      denied: data.denied,
      stars,
    }
  }

  if (!refresh && fsImpl.exists(indexPath)) {
    const cached = readCached()
    if (cached !== null) {
      const fetchedAt = freshnessTimeOf(cached.builtAt)
      if (fetchedAt !== null && now().getTime() - fetchedAt < FRESH_MS) {
        return { snapshot: cached, stale: false }
      }
    }
  }

  // Transport failures only (fetch threw, or a non-2xx response) degrade to
  // the cached snapshot with `stale: true`. Everything that interprets the
  // fetched bytes — pointer parse, schemaVersion checks, sha256 comparison,
  // data parse — throws on any irregularity, cache or no cache (§9.2, §10).
  let pointerText: string
  try {
    const response = await fetchImpl(new URL('index.json', baseUrl).href)
    if (!response.ok) throw new Error(`catalog pointer returned ${response.status}`)
    pointerText = await response.text()
  } catch (error) {
    const cached = readCached()
    if (cached !== null) return { snapshot: cached, stale: true }
    throw error
  }

  const pointer = pointerSchema.parse(JSON.parse(pointerText))
  if (pointer.schemaVersion > SUPPORTED_SCHEMA_VERSION) {
    throw new Error(
      `catalog schemaVersion ${pointer.schemaVersion} is newer than this build supports (${SUPPORTED_SCHEMA_VERSION})`,
    )
  }

  // Resolve (and refuse absolute URLs) before any fetch; a refused URL is a
  // loud error like the other pointer-interpretation failures, never a stale
  // fallback.
  const dataUrl = resolveDataUrl(baseUrl, pointer.plugins.url)
  let dataText: string
  try {
    const dataResponse = await fetchImpl(dataUrl)
    if (!dataResponse.ok) throw new Error(`catalog data returned ${dataResponse.status}`)
    dataText = await dataResponse.text()
  } catch (error) {
    const cached = readCached()
    if (cached !== null) return { snapshot: cached, stale: true }
    throw error
  }

  const actual = createHash('sha256').update(dataText).digest('hex')
  if (actual !== pointer.plugins.sha256) {
    throw new Error(`catalog data failed integrity check: expected ${pointer.plugins.sha256}, got ${actual}`)
  }

  const data = dataSchema.parse(JSON.parse(dataText))
  if (data.schemaVersion > SUPPORTED_SCHEMA_VERSION) {
    throw new Error(
      `catalog schemaVersion ${data.schemaVersion} is newer than this build supports (${SUPPORTED_SCHEMA_VERSION})`,
    )
  }
  // Same coherence gate as the cached path: a tarball URL bound to anything
  // but the entry's own repo is refused loudly whether it came from the wire
  // or the cache — before any install spec could be built from it.
  validateEntryCoherence(data.plugins)

  let stars: Record<string, number> = {}
  if (pointer.stars !== undefined) {
    try {
      // Resolution sits inside the advisory catch: a refused (absolute or
      // cross-origin) stars url must degrade to no stars like any other
      // sidecar failure — it still prevents the fetch, but never throws the
      // loader out of a catalog whose data fetched fine (spec §5, §9.2).
      const starsUrl = resolveDataUrl(baseUrl, pointer.stars.url)
      const starsResponse = await fetchImpl(starsUrl)
      if (starsResponse.ok) {
        const starsText = await starsResponse.text()
        const starsActual = createHash('sha256').update(starsText).digest('hex')
        if (starsActual === pointer.stars.sha256) {
          stars = parseStarsText(starsText)
          fsImpl.write(join(cacheDir, basename(pointer.stars.url)), starsText)
        }
      }
    } catch {
      // Advisory: an unreachable or refused sidecar means no stars this run
      // (spec §5).
    }
  }

  const snapshot: CatalogSnapshot = {
    schemaVersion: pointer.schemaVersion,
    builtAt: pointer.builtAt,
    entries: data.plugins,
    denied: data.denied,
    stars,
  }
  fsImpl.write(indexPath, JSON.stringify(pointer))
  fsImpl.write(join(cacheDir, basename(pointer.plugins.url)), dataText)
  fsImpl.write(metaPath, JSON.stringify({ fetchedAt: now().toISOString() }))
  return { snapshot, stale: false }
}
