/** Catalog fetch, verification, and disk cache — the Host's only network path. */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { z } from 'zod'
import type { CatalogEntry, DeniedEntry } from './types.ts'

/** Highest schemaVersion this build understands; a higher one is refused (§10). */
export const SUPPORTED_SCHEMA_VERSION = 2

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
    reviewedVersion: z.string(),
    reviewer: z.string(),
    reviewCommit: z.string(),
    notes: z.string(),
  }).optional(),
  catalog: z.object({
    category: z.enum(['tool', 'provider', 'ui', 'workflow', 'integration', 'other']),
    summary: z.object({ en: z.string(), zh: z.string().optional() }),
    capabilities: z.array(z.string()),
  }).optional(),
})

const dataSchema = z.object({
  schemaVersion: z.number(),
  plugins: z.array(entrySchema),
  denied: z.array(z.object({ name: z.string(), detail: z.string() })).default([]),
})

const pointerSchema = z.object({
  schemaVersion: z.number(),
  builtAt: z.string(),
  count: z.number(),
  plugins: z.object({ url: z.string(), sha256: z.string() }),
})

export interface CatalogSnapshot {
  schemaVersion: number
  builtAt: string
  entries: CatalogEntry[]
  denied: DeniedEntry[]
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

function resolveDataUrl(baseUrl: string, url: string): string {
  return /^https?:\/\//.test(url) ? url : new URL(url, baseUrl).href
}

/**
 * Load the catalog snapshot: fetch the pointer, verify the data file's sha256
 * against it, cache both on disk, and serve the cached copy with `stale: true`
 * when the network is unavailable (§10). A schemaVersion higher than this
 * build supports, or a data file that fails the hash or shape check, throws —
 * never silently degraded.
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
    try {
      const pointer = pointerSchema.parse(JSON.parse(fsImpl.read(indexPath)))
      if (pointer.schemaVersion > SUPPORTED_SCHEMA_VERSION) throw new Error(
        `catalog schemaVersion ${pointer.schemaVersion} is newer than this build supports (${SUPPORTED_SCHEMA_VERSION})`,
      )
      const dataPath = join(cacheDir, basename(pointer.plugins.url))
      const data = dataSchema.parse(JSON.parse(fsImpl.read(dataPath)))
      if (data.schemaVersion > SUPPORTED_SCHEMA_VERSION) throw new Error(
        `catalog schemaVersion ${data.schemaVersion} is newer than this build supports (${SUPPORTED_SCHEMA_VERSION})`,
      )
      return { schemaVersion: pointer.schemaVersion, builtAt: pointer.builtAt, entries: data.plugins, denied: data.denied }
    } catch {
      // Cache unreadable or invalid — treat as absent rather than failing a
      // boot that could instead fetch a fresh catalog.
      return null
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

  let pointer: z.infer<typeof pointerSchema> | undefined
  let dataText: string
  try {
    const response = await fetchImpl(new URL('index.json', baseUrl).href)
    if (!response.ok) throw new Error(`catalog pointer returned ${response.status}`)
    pointer = pointerSchema.parse(JSON.parse(await response.text()))
    if (pointer.schemaVersion > SUPPORTED_SCHEMA_VERSION) throw new Error(
      `catalog schemaVersion ${pointer.schemaVersion} is newer than this build supports (${SUPPORTED_SCHEMA_VERSION})`,
    )
    const dataResponse = await fetchImpl(resolveDataUrl(baseUrl, pointer.plugins.url))
    if (!dataResponse.ok) throw new Error(`catalog data returned ${dataResponse.status}`)
    dataText = await dataResponse.text()
    const actual = createHash('sha256').update(dataText).digest('hex')
    if (actual !== pointer.plugins.sha256) {
      throw new Error(`catalog data failed integrity check: expected ${pointer.plugins.sha256}, got ${actual}`)
    }
  } catch (error) {
    const cached = readCached()
    if (cached !== null) return { snapshot: cached, stale: true }
    throw error
  }

  const data = dataSchema.parse(JSON.parse(dataText))
  if (data.schemaVersion > SUPPORTED_SCHEMA_VERSION) throw new Error(
    `catalog schemaVersion ${data.schemaVersion} is newer than this build supports (${SUPPORTED_SCHEMA_VERSION})`,
  )
  const snapshot: CatalogSnapshot = {
    schemaVersion: pointer.schemaVersion,
    builtAt: pointer.builtAt,
    entries: data.plugins,
    denied: data.denied,
  }
  fsImpl.write(indexPath, JSON.stringify(pointer))
  fsImpl.write(join(cacheDir, basename(pointer.plugins.url)), dataText)
  fsImpl.write(metaPath, JSON.stringify({ fetchedAt: now().toISOString() }))
  return { snapshot, stale: false }
}
