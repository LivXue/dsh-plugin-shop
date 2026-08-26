import type { Candidate } from './types.ts'

/**
 * The keyword a plugin author declares. Ecosystem-neutral by design: an author
 * declares "I am a dsh plugin", not membership of this shop.
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

/**
 * Bound on HTTP 429 retries per request. npm rate-limits aggressively by IP,
 * and a CI runner shares its egress IP with every other tenant, so a single
 * 429 must not fail the daily publish. The retry is bounded: after
 * {@link RETRY_LIMIT} total attempts the last response is returned as-is and
 * the caller reports it the way it reports any other failure.
 *
 * The budget is sized for an IP-level throttle, not a blip. It was 4 attempts
 * over 7s, and on 2026-08-26 two catalog builds died anyway: a burst of pushes
 * ran the full harvest repeatedly from the same runner IP pool, npm throttled
 * the search endpoint, and seven seconds of backoff never outlives that. Five
 * delays of 2/4/8/16/32s give the limit ~62s to clear — still bounded, still
 * loud when npm is genuinely unavailable rather than merely annoyed.
 *
 * Note that a token does not exempt the search endpoint: those two builds sent
 * one (see the `token` parameter of {@link fetchWithRetry}) and were throttled
 * regardless, which is consistent with `/-/v1/search` metering by IP. The token
 * still lifts the per-packument limit, which is where most requests go.
 */
const RETRY_LIMIT = 6

const RETRY_BASE_DELAY_MS = 2000
/** Also the clamp on a `Retry-After` the registry sends; npm has answered with
 * values far larger than any build should wait for. */
const RETRY_MAX_DELAY_MS = 60_000

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Fetch one URL with bounded retries on HTTP 429, honoring a Retry-After
 * header when the registry sends one and backing off exponentially otherwise.
 * @param url - the registry URL.
 * @param fetchImpl - the fetch implementation, injected for testing.
 * @param sleep - the delay implementation, injected so tests do not wait.
 * @param token - an optional npm access token, sent as a Bearer header. npm
 *   rate-limits by IP and a CI runner shares its egress IP, so an
 *   unauthenticated search can be throttled before the first request; a
 *   read-only token lifts the limit onto the token instead of the IP.
 * @returns the first non-429 response, or the final 429 after the retries.
 */
async function fetchWithRetry(
  url: string,
  fetchImpl: typeof fetch,
  sleep: (ms: number) => Promise<void>,
  token: string | undefined,
): Promise<Response> {
  const init = token === undefined ? undefined : { headers: { Authorization: `Bearer ${token}` } }
  let response = await fetchImpl(url, init)
  for (let attempt = 0; response.status === 429 && attempt < RETRY_LIMIT - 1; attempt += 1) {
    const retryAfter = Number(response.headers.get('retry-after'))
    const delay = Number.isFinite(retryAfter) && retryAfter > 0
      ? Math.min(retryAfter * 1000, RETRY_MAX_DELAY_MS)
      : Math.min(RETRY_BASE_DELAY_MS * 2 ** attempt, RETRY_MAX_DELAY_MS)
    await sleep(delay)
    response = await fetchImpl(url, init)
  }
  return response
}

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
      description?: unknown
      keywords?: unknown
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
    description: typeof manifest.description === 'string' ? manifest.description : null,
    keywords: Array.isArray(manifest.keywords)
      ? manifest.keywords.filter((k): k is string => typeof k === 'string')
      : [],
  }
}

/**
 * List every package name carrying the harvest keyword.
 *
 * Harvesting by keyword rather than by name pattern is deliberate: a name
 * pattern is trivially spoofed.
 * @param fetchImpl - the fetch implementation, injected for testing.
 * @param sleep - the delay implementation, injected so tests do not wait.
 * @param token - an optional read-only npm token; see {@link fetchWithRetry}.
 * @returns every matching package name, in registry order.
 * @throws when the registry answers with a non-OK status after the 429
 *   retries are exhausted, or when more than {@link MAX_SEARCH_PAGES} pages
 *   are fetched without the harvest completing.
 */
export async function searchByKeyword(
  fetchImpl: typeof fetch = fetch,
  sleep: (ms: number) => Promise<void> = defaultSleep,
  token: string | undefined = undefined,
): Promise<string[]> {
  const names: string[] = []
  for (let page = 0; ; page += 1) {
    if (page >= MAX_SEARCH_PAGES) {
      throw new Error(
        `npm search exceeded ${MAX_SEARCH_PAGES} pages (${MAX_SEARCH_PAGES * PAGE_SIZE} names) without completing; harvest is incomplete`,
      )
    }
    const from = page * PAGE_SIZE
    const url = `${REGISTRY}/-/v1/search?text=keywords:${HARVEST_KEYWORD}&size=${PAGE_SIZE}&from=${from}`
    const response = await fetchWithRetry(url, fetchImpl, sleep, token)
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
 * @param sleep - the delay implementation, injected so tests do not wait.
 * @param token - an optional read-only npm token; see {@link fetchWithRetry}.
 * @returns the candidate, or the reason none could be produced. A 429 is
 *   retried a bounded number of times before it becomes a rejection, so a
 *   rate-limited runner does not reject the whole ecosystem at once.
 */
export async function fetchCandidate(
  name: string,
  fetchImpl: typeof fetch = fetch,
  sleep: (ms: number) => Promise<void> = defaultSleep,
  token: string | undefined = undefined,
): Promise<CandidateResult> {
  const response = await fetchWithRetry(`${REGISTRY}/${encodeURIComponent(name)}`, fetchImpl, sleep, token)
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
