/** Catalog fetch, verification, and disk cache — the Host's only network path. */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { z } from 'zod'
import { type CatalogOrigin, type OriginHandle, TransportError, httpOrigin } from './origin.ts'
import { normalizeRegistryUrl, npmOrigin } from './npm-origin.ts'
import { inCompletionOrder } from './race.ts'
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

/** How long a probe may take before the race gives up on that origin. Long
 * enough for a slow but working link, short enough that a black-holed origin
 * does not hold the shelf closed. */
const PROBE_TIMEOUT_MS = 10_000

/** How long the committed origin has to produce its pointer. `httpOrigin`
 * answers instantly — its probe already fetched the bytes — but `npmOrigin`
 * downloads its tarball here, so this is a bulk-transfer budget, not a probe
 * one. Without it a winner that stalls mid-body parks the race forever while
 * healthy origins sit settled and unread, which is the exact failure the race
 * exists to prevent. Generous against every measured npm origin (12.53 MB/s
 * mirror -> 0.12 s for 1.5 MB; npmjs direct 1.99 MB/s -> 0.75 s). */
const COMMIT_TIMEOUT_MS = 30_000

/** Reject with a TransportError if `work` outlives `COMMIT_TIMEOUT_MS`. The
 * underlying fetch is left to finish or fail on its own and its result is
 * discarded: aborting it would need a signal threaded through OriginHandle,
 * and a stalled origin we have already abandoned costs nothing but its own
 * socket. */
async function withCommitTimeout<T>(work: Promise<T>, id: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new TransportError(`${id} did not produce a pointer within ${COMMIT_TIMEOUT_MS} ms`)),
          COMMIT_TIMEOUT_MS,
        )
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** npm's package-name grammar. The value becomes half of an install spec, so
 * aliases and shell punctuation must not reach the CLI. */
const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/

/** Canonical SemVer 2.0.0, including legal prerelease/build metadata. */
const NPM_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*)?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/

/** A GitHub commit pin. */
const COMMIT_SHA = /^[0-9a-f]{40}$/

/** A release tag used by a release-rescued GitHub entry. */
const RELEASE_TAG = /^[A-Za-z0-9][A-Za-z0-9._+/-]{0,127}$/

/** The repository binding used to build a GitHub install spec. */
const REPO_FULL_NAME = /^[\w.-]+\/[\w.-]+$/

/** Records when the loader itself wrote the cache; the pointer's `builtAt` is
 * the catalog's build time, not the cache's fetch time. */
const META_FILE = 'index.meta.json'

const entrySchema = z.object({
  // Bounded and control-character-free for every source. GitHub names can
  // originate in an untrusted repository manifest and still reach argv.
  name: z.string().min(1).max(214).regex(/^[^\u0000-\u001f\u007f]+$/, 'entry name carries a control character'),
  version: z.string().min(1).max(256),
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
  repo: z.string().regex(REPO_FULL_NAME, 'repo must be owner/slug').optional(),
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
  tarball: z.object({ url: z.string(), sha256: z.string().regex(/^[0-9a-f]{64}$/) }).optional(),
  // The npm publishing account, additive and optional — deliberately NOT a
  // schemaVersion bump. A version higher than SUPPORTED_SCHEMA_VERSION is
  // refused outright above, so bumping to 6 would make every installed 0.5.x
  // shop reject the catalog; an unknown key, by contrast, is stripped by this
  // non-strict schema, which is what lets old and new hosts share one
  // catalog. Same reasoning as `added`.
  publisher: z.string().optional(),
  // v6: the package's declared peer dependency names. OPTIONAL on the
  // consumer, and this is not a style preference: the live catalog is v5 and
  // carries no such field, and making `added` required is exactly what made
  // 0.5.0 refuse the published catalog for every user.
  peers: z.array(z.string()).optional(),
}).superRefine((entry, ctx) => {
  // The install spec differs by source, so the grammar does too. Refusing at
  // this boundary prevents catalog bytes from reaching the process layer.
  if (entry.source === 'npm') {
    if (!NPM_NAME.test(entry.name)) {
      ctx.addIssue({ code: 'custom', path: ['name'], message: `npm entry name ${JSON.stringify(entry.name)} is outside npm package-name grammar` })
    }
    if (!NPM_VERSION.test(entry.version)) {
      ctx.addIssue({ code: 'custom', path: ['version'], message: `npm entry version ${JSON.stringify(entry.version)} is not a plain semver version` })
    }
    return
  }
  if (entry.repo === undefined) {
    ctx.addIssue({ code: 'custom', path: ['repo'], message: 'a github entry must carry its repo — it is the entry\'s identity and the spec is built from it' })
  }
  // GitHub entries use either a commit pin or a release tag. A tag may exist
  // without a tarball; install() will report that missing rescue explicitly.
  if (!COMMIT_SHA.test(entry.version) && !RELEASE_TAG.test(entry.version)) {
    ctx.addIssue({ code: 'custom', path: ['version'], message: `github entry version ${JSON.stringify(entry.version)} is neither a 40-character commit sha nor a release tag` })
  }
})

const dataSchema = z.object({
  schemaVersion: z.number(),
  plugins: z.array(entrySchema),
  // v5: `replacement` names the known substitute on a denial.
  denied: z.array(z.object({ name: z.string(), detail: z.string(), replacement: z.string().optional() })).default([]),
  /** Names the client's shop-like NAME filter must NOT hide: entries whose
   * name reads like a competing plugin market but which are not one
   * (registry/not-a-shop.yml). Defaulted, so a catalog built before this key
   * existed still parses — the data file is non-strict for the same reason
   * the pointer is. */
  notAShop: z.array(z.string()).default([]),
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
    // Query strings and fragments can carry shell punctuation into the
    // install spec. Release assets are addressed by their path alone.
    if (parsed.search !== '' || parsed.hash !== '') {
      throw new Error(`catalog entry ${entry.name}: tarball url must carry no query or fragment`)
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
  /** Names the shop-like NAME filter must not hide (registry/not-a-shop.yml).
   * Absent for a catalog built before the key existed, which is why it is
   * optional rather than defaulted here: the parse defaults it, a snapshot
   * assembled by hand need not carry it. */
  notAShop?: string[]
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
  /** A single HTTP origin — the explicit-override spelling. Mutually
   * exclusive with `origins`; exactly one must be given. */
  baseUrl?: string
  /** Origins to race (design §3). */
  origins?: CatalogOrigin[]
  cacheDir: string
  refresh?: boolean
  fetchImpl?: typeof fetch
  now?: () => Date
  fsImpl?: CatalogFs
  sleep?: (ms: number) => Promise<void>
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
    cacheDir, refresh = false,
    fetchImpl = fetch, now = () => new Date(), fsImpl = nodeFs,
  } = options
  // Exactly one spelling of "where to fetch from": the explicit-override
  // single origin, or the list Task 5's race consumes. tsc cannot see the
  // XOR through to a narrowed `options.baseUrl`, hence the one assertion
  // below — safe only because this guard runs first.
  if ((options.baseUrl === undefined) === (options.origins === undefined)) {
    throw new Error('loadCatalog: exactly one of baseUrl or origins is required')
  }
  const originList = options.origins
    ?? [httpOrigin(options.baseUrl as string, fetchImpl)]
  if (originList.length === 0) throw new Error('loadCatalog: no origins')
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
      notAShop: data.notAShop,
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
  const cachedOrThrow = (error: unknown): CatalogResult => {
    const cached = readCached()
    if (cached !== null) return { snapshot: cached, stale: true }
    throw error
  }

  // Race every origin's cheap probe and commit to the first that answers
  // (design §3). A transport failure — in the probe, or in the `pointer()`
  // call below, which is where npmOrigin does its bulk tarball download —
  // moves to the next finisher; anything else throws, so a corrupt origin is
  // never hidden behind a healthy one. "Or on the bulk fetch" would be too
  // broad: the OTHER bulk fetch in this function, `handle.file()` for the
  // data file, happens after the loop has committed and falls back to the
  // disk cache instead, never to another origin (see below, and race.ts).
  let handle: OriginHandle | null = null
  let pointerText = ''
  let lastTransportError: unknown = new TransportError('no catalog origin was reachable')
  for await (const settled of inCompletionOrder(
    originList.map(origin => origin.probe(AbortSignal.timeout(PROBE_TIMEOUT_MS))),
  )) {
    if (!('value' in settled)) {
      if (!(settled.reason instanceof TransportError)) throw settled.reason
      lastTransportError = settled.reason
      continue
    }
    try {
      pointerText = await withCommitTimeout(settled.value.pointer(), settled.value.id)
      handle = settled.value
      break
    } catch (error) {
      if (!(error instanceof TransportError)) throw error
      lastTransportError = error
    }
  }
  if (handle === null) return cachedOrThrow(lastTransportError)

  const pointer = pointerSchema.parse(JSON.parse(pointerText))
  if (pointer.schemaVersion > SUPPORTED_SCHEMA_VERSION) {
    throw new Error(
      `catalog schemaVersion ${pointer.schemaVersion} is newer than this build supports (${SUPPORTED_SCHEMA_VERSION})`,
    )
  }

  // handle.file resolves (and refuses absolute/cross-origin) URLs internally
  // now, so a refused URL surfaces as a plain Error, never a TransportError —
  // the instanceof guard below is what keeps that refusal a loud throw like
  // the other pointer-interpretation failures, instead of a stale fallback.
  let dataText: string
  try {
    dataText = await handle.file(pointer.plugins.url)
  } catch (error) {
    if (!(error instanceof TransportError)) throw error
    return cachedOrThrow(error)
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
      const starsText = await handle.file(pointer.stars.url)
      const starsActual = createHash('sha256').update(starsText).digest('hex')
      if (starsActual === pointer.stars.sha256) {
        stars = parseStarsText(starsText)
        fsImpl.write(join(cacheDir, basename(pointer.stars.url)), starsText)
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
    notAShop: data.notAShop,
    stars,
  }
  fsImpl.write(indexPath, JSON.stringify(pointer))
  fsImpl.write(join(cacheDir, basename(pointer.plugins.url)), dataText)
  fsImpl.write(metaPath, JSON.stringify({ fetchedAt: now().toISOString() }))
  return { snapshot, stale: false }
}

/** The catalog base the shipped `cordis.patch.yml` names. A row carrying
 * exactly this value expresses no preference, so the loader races its
 * defaults; anything else is a deliberate override and is used alone. */
export const DEFAULT_CATALOG_URL = 'https://LivXue.github.io/dsh-plugin-shop/v1/'

/** The npm package carrying the same `v1/` tree (design §2). */
export const CATALOG_PACKAGE = 'dsh-plugin-shop-catalog'

/** Registries raced by default: the domestic mirror first for legibility —
 * the race, not the order, decides the winner. */
const DEFAULT_REGISTRIES = ['https://registry.npmmirror.com/', 'https://registry.npmjs.org/']

/**
 * The origins to race for this installation (design §3).
 *
 * @param catalogUrl - the row's configured base.
 * @param npmRegistry - the user's own registry from `~/.npmrc`, or null.
 */
export function catalogOrigins(
  catalogUrl: string,
  fetchImpl: typeof fetch,
  npmRegistry: string | null,
): CatalogOrigin[] {
  // An explicit override must not be raced: racing would make the e2e
  // fixture nondeterministic and would silently defeat "point the shop at my
  // own mirror", which the README documents.
  if (catalogUrl !== DEFAULT_CATALOG_URL) return [httpOrigin(catalogUrl, fetchImpl)]
  const registries = [...DEFAULT_REGISTRIES]
  // Normalised before the membership check: `npm config set` writes
  // `registry=https://registry.npmmirror.com` with no trailing slash, which
  // is byte-different from the default above and would otherwise race
  // npmmirror twice under two different origin ids.
  const normalizedNpmRegistry = npmRegistry === null ? null : normalizeRegistryUrl(npmRegistry)
  if (normalizedNpmRegistry !== null && !registries.includes(normalizedNpmRegistry)) registries.unshift(normalizedNpmRegistry)
  return [
    ...registries.map(registry => npmOrigin(registry, CATALOG_PACKAGE, fetchImpl)),
    httpOrigin(catalogUrl, fetchImpl),
  ]
}
