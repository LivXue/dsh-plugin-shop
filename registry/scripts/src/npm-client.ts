import type { Candidate, Rejection } from './types.ts'

/**
 * The keywords a plugin author declares. Ecosystem-neutral by design: an
 * author declares "I am a dsh plugin" (or "I integrate with
 * deepseek-harness"), not membership of this shop. The first entry is the
 * primary keyword; the rest widen the net for authors who tag their package
 * by the harness it plugs into rather than the plugin ecosystem's own tag.
 */
export const HARVEST_KEYWORDS: readonly string[] = ['dsh-plugin', 'deepseek-harness']

const REGISTRY = 'https://registry.npmjs.org'
const PAGE_SIZE = 250

/**
 * The largest `from` the npm search API honors. A `from` past it silently
 * returns page 0 rather than an error — measured 2026-09-03:
 * `keywords:deepseek-harness&size=250&from=5000` returned the 95-name tail of
 * a 5,095-name result set, and `from=5001` returned the same 250 objects as
 * `from=0`. `size` is capped at 250 (a `size=1000` request returned 250), so
 * the window cannot be widened from the caller's side either.
 */
export const MAX_SEARCH_FROM = 5000

/**
 * How many names ONE search query can enumerate: the last reachable page plus
 * its size. Past it the registry has no way to serve the tail, so the harvest
 * must partition the query rather than page into the wrap. Harvesting a subset
 * would be indistinguishable from an ecosystem that shrank.
 */
export const SEARCH_WINDOW = MAX_SEARCH_FROM + PAGE_SIZE

/**
 * Refinement keywords the harvest ANDs onto an over-window keyword to split it
 * into reachable cells, most-covering first.
 *
 * `keywords:a,b` is an INTERSECTION on `/-/v1/search`, and it is the ONLY
 * filtering qualifier the API honors. Probed 2026-09-03 against
 * `keywords:deepseek-harness` (total 5,103): `scope:`, `author:`,
 * `maintainer:`, `not:unstable`, `is:unstable`, and the
 * `quality`/`popularity`/`maintenance` weights each left both the total and
 * the first page unchanged — none of them can split or re-slice the window.
 * A bare text term (`keywords:deepseek-harness memory`) leaves the total
 * unchanged too, but re-ranks the page: only 138 of 250 names match at rank
 * 2,500 against the untermed query. It still cannot widen the reachable
 * window — the *tail* is score-stable (`from=5000` returns identical names
 * under three different terms), so a text term re-ranks the head but never
 * moves a name into the reachable window. The intersections do split it:
 * `dsh` 4,255, `dsh-plugin` 3,178, `plugin` 1,604, `deepseek` 949, `agent`
 * 498, `mcp` 213, `cli` 72, `harness` 41, `claude` 35, `tool` 29, `cordis`
 * 20, `codex` 10, `claude-code` 10, `desktop-pet` 7.
 *
 * There is no negation qualifier (`keywords:a,-b` returns total 0), so a
 * cell's complement cannot be expressed and this partition is NOT covering by
 * construction. {@link searchByKeywords} therefore MEASURES its coverage
 * against the keyword's own total and throws on a shortfall: safe by check,
 * not by construction. `cordis`, `codex`, `claude-code`, and `desktop-pet`
 * were added 2026-09-03 to close a measured 44-name gap (the other ten cells
 * alone reached 5,059 of 5,103, paged live the same day). Adding a keyword
 * here is the documented response to that throw; a cell is always
 * `keywords:<harvest-keyword>,<refinement>`, so a refinement can only narrow
 * the net a listing sees, never widen it — an addition is a coverage
 * decision, not a policy one.
 */
export const PARTITION_KEYWORDS: readonly string[] = [
  'dsh', 'dsh-plugin', 'deepseek-harness', 'plugin', 'deepseek',
  'agent', 'mcp', 'cli', 'claude', 'tool',
  'cordis', 'codex', 'claude-code', 'desktop-pet',
]

/** One query's `text` value: the keyword, plus any refinements ANDed on. */
export function keywordQuery(keywords: readonly string[]): string {
  return `keywords:${keywords.join(',')}`
}

/**
 * Split one harvest keyword into queries whose totals each fit
 * {@link SEARCH_WINDOW}.
 * @param keyword - the harvest keyword.
 * @param probe - reads one query's `total`; injected so tests need no network.
 * @returns the cells to page, the keyword's own total, and whether a split
 *   happened (an unsplit keyword needs no coverage check: paging to its
 *   answered total already enumerates all of it).
 * @throws when a cell is past the window and no refinement keyword splits it.
 */
export async function partitionKeyword(
  keyword: string,
  probe: (keywords: readonly string[]) => Promise<number>,
): Promise<{ cells: string[][]; total: number; partitioned: boolean }> {
  const total = await probe([keyword])
  if (total <= SEARCH_WINDOW) return { cells: [[keyword]], total, partitioned: false }
  const cells: string[][] = []
  const oversized: string[][] = []
  for (const refinement of PARTITION_KEYWORDS) {
    if (refinement === keyword) continue
    const cell = [keyword, refinement]
    const cellTotal = await probe(cell)
    if (cellTotal === 0) continue
    if (cellTotal <= SEARCH_WINDOW) cells.push(cell)
    else oversized.push(cell)
  }
  for (const cell of oversized) {
    let split = false
    for (const refinement of PARTITION_KEYWORDS) {
      if (cell.includes(refinement)) continue
      const deeperTotal = await probe([...cell, refinement])
      if (deeperTotal === 0 || deeperTotal > SEARCH_WINDOW) continue
      cells.push([...cell, refinement])
      split = true
    }
    if (!split) {
      throw new Error(
        `npm search for ${keywordQuery(cell)} reports more than the ${SEARCH_WINDOW} names one query can reach (from is capped at ${MAX_SEARCH_FROM}) and no refinement keyword splits it; add one to PARTITION_KEYWORDS`,
      )
    }
  }
  if (cells.length === 0) {
    throw new Error(
      `npm search for ${keywordQuery([keyword])} reports more than the ${SEARCH_WINDOW} names one query can reach (from is capped at ${MAX_SEARCH_FROM}) and no refinement keyword splits it; add one to PARTITION_KEYWORDS`,
    )
  }
  return { cells, total, partitioned: true }
}

/** The two fields the harvest reads off a search response. */
interface SearchBody {
  objects?: { package?: { name?: unknown } }[]
  total?: unknown
}

/**
 * Parse one search response, naming the query on a body that is not JSON.
 * Observed live: page 13 of `keywords:dsh-plugin` answered 200 with
 * `<!doctype html>`, and the bare `SyntaxError` named no keyword.
 */
async function readSearchBody(response: Response, query: string, from: number): Promise<SearchBody> {
  try {
    return await response.json() as SearchBody
  } catch {
    throw new Error(`npm search for ${query} at from=${from} answered 200 with a body that is not JSON`)
  }
}

/**
 * Read one query's `total` with a single-object request.
 * @throws when the request fails, or the response answers no numeric total —
 *   a malformed probe must not read as an empty keyword: {@link
 *   partitionKeyword} and the coverage check in {@link searchByKeywords} both
 *   trust this number, and a silent 0 disables both.
 */
async function searchTotal(
  keywords: readonly string[],
  fetchImpl: typeof fetch,
  sleep: (ms: number) => Promise<void>,
  token: string | undefined,
  backupRegistry: string | undefined,
  timeoutMs: number,
): Promise<number> {
  const query = keywordQuery(keywords)
  const path = `-/v1/search?text=${encodeURIComponent(query)}&size=1&from=0`
  const response = await fetchWithFailover(path, fetchImpl, sleep, token, backupRegistry, timeoutMs)
  if (!response.ok) throw new Error(`npm search for ${query} failed: ${response.status}`)
  const body = await readSearchBody(response, query, 0)
  if (typeof body.total !== 'number') {
    throw new Error(`npm search for ${query} at from=0 answered no total; a keyword's size cannot be measured without it`)
  }
  return body.total
}

/**
 * Per-attempt bound on a registry request. A stalled connection fails over
 * to the backup registry instead of hanging the build — the hub's
 * stall-detection borrowing, in its read-only form (the install path still
 * runs through the user's own pnpm and registry config).
 */
const REQUEST_TIMEOUT_MS = 30_000

/** A request that outlived {@link REQUEST_TIMEOUT_MS}; a failover trigger. */
class FetchTimeoutError extends Error {}

function registryUrl(registry: string, path: string): string {
  return `${registry.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`
}

/** Wrap a fetch so no request can outlive `ms`: the timer aborts the
 * request's own signal and rejects the returned promise, whichever a given
 * implementation honors. */
function withTimeout(fetchImpl: typeof fetch, ms: number): typeof fetch {
  return async (input, init) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), ms)
    try {
      return await Promise.race([
        fetchImpl(input, { ...init, signal: controller.signal }),
        new Promise<never>((_, reject) => {
          controller.signal.addEventListener('abort', () => {
            reject(new FetchTimeoutError(`registry request exceeded ${ms}ms`))
          }, { once: true })
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }
}

/**
 * Fetch a registry path with a backup registry absorbing ONLY
 * unavailability: a network throw, a stalled connection (the per-attempt
 * timeout), or a 5xx. A 4xx answer from the primary is authoritative and is
 * returned as-is — a 404 is never re-litigated against a mirror, and an
 * exhausted 429 reports the throttle rather than quietly switching source.
 * When the backup also fails, the primary's failure is what propagates: a
 * mirror's opinion must never masquerade as npm's.
 */
async function fetchWithFailover(
  path: string,
  fetchImpl: typeof fetch,
  sleep: (ms: number) => Promise<void>,
  token: string | undefined,
  backupRegistry: string | undefined,
  timeoutMs: number,
): Promise<Response> {
  const timed = withTimeout(fetchImpl, timeoutMs)
  let primary: Response | null = null
  let primaryError: unknown = undefined
  try {
    primary = await fetchWithRetry(registryUrl(REGISTRY, path), timed, sleep, token)
    if (primary.ok || primary.status < 500) return primary
    primaryError = new Error(`npm registry returned ${primary.status}`)
  } catch (error) {
    primaryError = error
  }
  if (backupRegistry === undefined) {
    // No backup configured: behave exactly as before — the 5xx response
    // returns to the caller (whose contextual error names the keyword), a
    // network throw propagates.
    if (primary !== null) return primary
    throw primaryError
  }
  const backup = await fetchWithRetry(registryUrl(backupRegistry, path), timed, sleep, token)
  if (!backup.ok) throw primaryError
  return backup
}

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
export async function fetchWithRetry(
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
 * Maximum number of peer names recorded from one package's manifest.
 * `peerDependencies` keys are the one new field on this branch that flows
 * from hostile npm input straight to a published artifact, and the object
 * carries no size limit of its own: a manifest declaring thousands of them
 * would bloat every published `plugins.json` and force each reader's host
 * to attempt that many peer resolutions on every catalog load. The excess
 * is dropped, never rejected — an author's oversized manifest costs them
 * the tail of the list, not the listing.
 */
export const PEERS_MAX_COUNT = 200

/**
 * Project one npm packument into a candidate.
 * @param packument - the parsed registry document for one package.
 * @returns the candidate, or null when the document names no usable latest version.
 */
/**
 * The npm account behind one package: the account npm recorded for this
 * version when it is one of the package's maintainers, otherwise the first
 * maintainer.
 *
 * `_npmUser` alone is not an identity. Measured on 250 live catalog entries,
 * 30 report it as the literal string "GitHub Actions" — the trusted-publisher
 * path, which the better-run projects use. Naming that would tell a reader
 * nothing, and it would read backwards: the original `@nanmicoder/dsh-agent-
 * teams` publishes from CI while the clone `dsh-agent-squad` was pushed by
 * hand, so the clone would be the side showing a human. Requiring the value
 * to be a maintainer keeps it an account someone owns, and the fallback keeps
 * an answer for the CI case. 246 of those 250 have exactly one maintainer.
 */
function publisherOf(maintainers: unknown, npmUser: unknown): string | undefined {
  const names = Array.isArray(maintainers)
    ? maintainers
      .map(m => (m !== null && typeof m === 'object' ? (m as { name?: unknown }).name : m))
      .filter((n): n is string => typeof n === 'string')
    : []
  if (typeof npmUser === 'string' && names.includes(npmUser)) return npmUser
  return names[0]
}

export function toCandidate(packument: unknown): Candidate | null {
  const doc = packument as {
    name?: unknown
    'dist-tags'?: { latest?: unknown }
    maintainers?: unknown
    time?: Record<string, unknown>
    versions?: Record<string, {
      dist?: { integrity?: unknown }
      license?: unknown
      repository?: unknown
      deprecated?: unknown
      description?: unknown
      keywords?: unknown
      _npmUser?: { name?: unknown }
      peerDependencies?: unknown
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
    // The account name only: npm carries an address beside it and our
    // artifact has no use for republishing that (see Candidate.publisher for
    // why an account and not `author`).
    ...(() => {
      const publisher = publisherOf(doc.maintainers, manifest._npmUser?.name)
      return publisher === undefined ? {} : { publisher }
    })(),
    peers: manifest.peerDependencies !== null && typeof manifest.peerDependencies === 'object' && !Array.isArray(manifest.peerDependencies)
      ? Object.keys(manifest.peerDependencies).slice(0, PEERS_MAX_COUNT)
      : [],
  }
}

/**
 * List every package name carrying one of the harvest keywords: one paged
 * search per keyword, unioned and deduplicated, sorted for determinism.
 *
 * Harvesting by keyword rather than by name pattern is deliberate: a name
 * pattern is trivially spoofed. A keyword search that cannot complete
 * aborts the harvest — harvesting only the keywords that answered would
 * silently shrink the candidate set, which is indistinguishable from an
 * empty ecosystem.
 * @param fetchImpl - the fetch implementation, injected for testing.
 * @param sleep - the delay implementation, injected so tests do not wait.
 * @param token - an optional read-only npm token; see {@link fetchWithRetry}.
 * @returns every matching package name, sorted and deduplicated.
 * @throws when the registry answers with a non-OK status after the 429
 *   retries are exhausted; when a search page or a total probe answers with
 *   no numeric total; when a keyword's total is past {@link SEARCH_WINDOW}
 *   and no refinement keyword splits it; when a cell would need a `from`
 *   past {@link MAX_SEARCH_FROM}; or when a keyword's cells enumerate fewer
 *   names than its own total says to expect.
 */
export async function searchByKeywords(
  fetchImpl: typeof fetch = fetch,
  sleep: (ms: number) => Promise<void> = defaultSleep,
  token: string | undefined = undefined,
  backupRegistry: string | undefined = undefined,
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): Promise<string[]> {
  const seen = new Set<string>()
  const probe = (keywords: readonly string[]): Promise<number> =>
    searchTotal(keywords, fetchImpl, sleep, token, backupRegistry, timeoutMs)
  for (const keyword of HARVEST_KEYWORDS) {
    const { cells, total, partitioned } = await partitionKeyword(keyword, probe)
    const forKeyword = new Set<string>()
    for (const cell of cells) {
      const query = keywordQuery(cell)
      for (let from = 0; ; from += PAGE_SIZE) {
        if (from > MAX_SEARCH_FROM) {
          throw new Error(
            `npm search for ${query} needs from=${from}, past the ${MAX_SEARCH_FROM} the registry honors (a larger from silently returns page 0); the partition is wrong`,
          )
        }
        const path = `-/v1/search?text=${encodeURIComponent(query)}&size=${PAGE_SIZE}&from=${from}`
        const response = await fetchWithFailover(path, fetchImpl, sleep, token, backupRegistry, timeoutMs)
        if (!response.ok) throw new Error(`npm search for ${query} failed: ${response.status}`)
        const body = await readSearchBody(response, query, from)
        const objects = body.objects ?? []
        for (const object of objects) {
          if (typeof object.package?.name === 'string') {
            seen.add(object.package.name)
            forKeyword.add(object.package.name)
          }
        }
        // Stop on the total the registry answered, NEVER on a short page: npm
        // has served a 249-object page of a 600-name result set, and breaking
        // there dropped every later page of that keyword in silence. A
        // missing total cannot be told apart from a truncated page, so it
        // throws rather than defaulting to 0 and ending the cell on whatever
        // page happened to arrive first — live shape: the registry has
        // served a 200 with `<!doctype html>` and a 429 with a 7 KB HTML
        // body on ordinary search pages.
        if (typeof body.total !== 'number') {
          throw new Error(`npm search for ${query} at from=${from} answered no total; a truncated page cannot be told from a complete one`)
        }
        const cellTotal = body.total
        if (objects.length === 0 || from + objects.length >= cellTotal) break
      }
    }
    // The API has no complement operator, so a partition's coverage is
    // measured rather than assumed: `min` of the totals before and after
    // absorbs a package published or unpublished during the run, and a
    // genuine partition gap is hundreds of names and still throws. An
    // unpartitioned keyword gets the same floor AND the same re-probe: a
    // stale `total` reused as `after` gives `required = total` exactly, so
    // it could absorb no churn at all — an ordinary unpublish between the
    // probe and the page landing then looked identical to a truncated
    // harvest. The re-probe costs one extra size=1 request per top-level
    // keyword; it also catches a mid-stream empty page: the `||` in the
    // break above ends a cell on ANY empty page, even one arriving before
    // the cell's own total says the cell is exhausted.
    const after = await probe([keyword])
    const required = Math.min(total, after)
    if (forKeyword.size < required) {
      throw new Error(partitioned
        ? `npm search for ${keywordQuery([keyword])} enumerated ${forKeyword.size} of ${required} names across ${cells.length} partition cell(s); the refinement keywords do not cover the keyword, so the harvest would be silently short`
        : `npm search for ${keywordQuery([keyword])} enumerated ${forKeyword.size} of ${required} names; the search ended before reaching the answered total, so the harvest would be silently short`)
    }
  }
  return [...seen].sort()
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
  backupRegistry: string | undefined = undefined,
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): Promise<CandidateResult> {
  const response = await fetchWithFailover(encodeURIComponent(name), fetchImpl, sleep, token, backupRegistry, timeoutMs)
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

export const HARVEST_CONCURRENCY = 8

/**
 * Fetch every name into a candidate, turning un-fetchable names into
 * `fetch-failed` rejections rather than dropping them (build.ts rationale).
 */
export async function fetchCandidates(
  names: string[],
  fetchImpl: typeof fetch = fetch,
  token: string | undefined = undefined,
  backupRegistry: string | undefined = undefined,
): Promise<{ candidates: Candidate[]; rejections: Rejection[] }> {
  const candidates: Candidate[] = []
  const rejections: Rejection[] = []
  for (let i = 0; i < names.length; i += HARVEST_CONCURRENCY) {
    const batch = names.slice(i, i + HARVEST_CONCURRENCY)
    const results = await Promise.all(batch.map(async name => ({ name, result: await fetchCandidate(name, fetchImpl, undefined, token, backupRegistry) })))
    for (const { name, result } of results) {
      if (result.ok) candidates.push(result.candidate)
      else rejections.push({ name, code: 'fetch-failed', detail: result.detail })
    }
  }
  return { candidates, rejections }
}
