import type { Candidate } from './types.ts'

/**
 * The keyword a plugin author declares. Ecosystem-neutral by design: an author
 * declares "I am a dsh plugin", not membership of this store.
 */
export const HARVEST_KEYWORD = 'dsh-plugin'

const REGISTRY = 'https://registry.npmjs.org'
const PAGE_SIZE = 250

/**
 * Upper bound on the number of search pages fetched by {@link searchByKeyword}.
 * Guards against an unbounded loop issuing endless requests against a public
 * API if the registry ever kept returning full pages: at `PAGE_SIZE` names
 * per page this bound covers catalog sizes far beyond the ecosystem's current
 * scale, so hitting it means the harvest is broken, not that the ecosystem
 * grew.
 */
const MAX_SEARCH_PAGES = 100

/** Normalize an npm repository field to a plain https URL. */
function normalizeRepository(value: unknown): string | null {
  const url = typeof value === 'string'
    ? value
    : typeof (value as { url?: unknown } | null)?.url === 'string'
      ? (value as { url: string }).url
      : null
  if (url === null) return null
  return url.replace(/^git\+/, '').replace(/\.git$/, '')
}

/**
 * Project one npm packument into a candidate.
 * @param packument - the parsed registry document for one package.
 * @returns the candidate, or null when the document names no usable latest version.
 */
export function toCandidate(packument: unknown): Candidate | null {
  const doc = packument as {
    name?: unknown
    'dist-tags'?: { latest?: unknown }
    time?: Record<string, unknown>
    versions?: Record<string, {
      dist?: { integrity?: unknown }
      license?: unknown
      repository?: unknown
      deprecated?: unknown
      dsh?: { bundle?: unknown; catalog?: unknown }
    }>
  }
  const name = doc.name
  const version = doc['dist-tags']?.latest
  if (typeof name !== 'string' || typeof version !== 'string') return null
  const manifest = doc.versions?.[version]
  if (manifest === undefined) return null
  const publishedAt = doc.time?.[version]
  return {
    name,
    version,
    integrity: typeof manifest.dist?.integrity === 'string' ? manifest.dist.integrity : null,
    publishedAt: typeof publishedAt === 'string' ? publishedAt : null,
    repository: normalizeRepository(manifest.repository),
    license: typeof manifest.license === 'string' ? manifest.license : null,
    deprecated: manifest.deprecated !== undefined,
    hasBundle: manifest.dsh?.bundle !== undefined,
    catalog: manifest.dsh?.catalog ?? null,
  }
}

/**
 * List every package name carrying the harvest keyword.
 *
 * Harvesting by keyword rather than by name pattern is deliberate: a name
 * pattern is trivially spoofed.
 * @param fetchImpl - the fetch implementation, injected for testing.
 * @returns every matching package name, in registry order.
 * @throws when the registry answers with a non-OK status, or when more than
 *   {@link MAX_SEARCH_PAGES} pages are fetched without the harvest completing.
 */
export async function searchByKeyword(fetchImpl: typeof fetch = fetch): Promise<string[]> {
  const names: string[] = []
  for (let page = 0; ; page += 1) {
    if (page >= MAX_SEARCH_PAGES) {
      throw new Error(
        `npm search exceeded ${MAX_SEARCH_PAGES} pages (${MAX_SEARCH_PAGES * PAGE_SIZE} names) without completing; harvest is incomplete`,
      )
    }
    const from = page * PAGE_SIZE
    const url = `${REGISTRY}/-/v1/search?text=keywords:${HARVEST_KEYWORD}&size=${PAGE_SIZE}&from=${from}`
    const response = await fetchImpl(url)
    if (!response.ok) throw new Error(`npm search failed: ${response.status}`)
    const body = await response.json() as { objects?: { package?: { name?: unknown } }[] }
    const objects = body.objects ?? []
    for (const object of objects) {
      if (typeof object.package?.name === 'string') names.push(object.package.name)
    }
    if (objects.length < PAGE_SIZE) return names
  }
}

/**
 * The outcome of fetching one package: either a usable candidate, or the
 * reason none could be produced. Distinguishing the two lets a caller record
 * a transient fetch failure as its own audited rejection rather than
 * conflating it with a package that simply carries no `dsh.catalog`.
 */
export type CandidateResult =
  | { ok: true; candidate: Candidate }
  | { ok: false; detail: string }

/**
 * Fetch one package's full packument and project it into a candidate.
 * @param name - the package name.
 * @param fetchImpl - the fetch implementation, injected for testing.
 * @returns the candidate, or the reason none could be produced.
 */
export async function fetchCandidate(
  name: string,
  fetchImpl: typeof fetch = fetch,
): Promise<CandidateResult> {
  const response = await fetchImpl(`${REGISTRY}/${encodeURIComponent(name)}`)
  if (!response.ok) return { ok: false, detail: `npm registry returned ${response.status} fetching ${name}` }
  let body: unknown
  try {
    body = await response.json()
  } catch {
    // response.json() throws on a body that is not valid JSON; recorded as a
    // rejection like any other unusable response, rather than aborting the build.
    return { ok: false, detail: `${name}: response body was unreadable` }
  }
  const candidate = toCandidate(body)
  if (candidate === null) return { ok: false, detail: `${name}: packument names no usable latest version` }
  return { ok: true, candidate }
}
