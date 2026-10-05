/**
 * npm's replication change feed, read FORWARD from the committed cursor,
 * and the `/latest` manifest of every id it selects. Impure: this module
 * reaches the network. Every decision it applies lives in feed-state.ts.
 *
 * Forward only, because the feed offers nothing else: `descending=true`
 * ignores `since`, so a newest-first read can never page back past the
 * newest ~10,000 rows (spec section 2). Every request goes through this
 * repo's `withTimeout` and `fetchWithRetry`, and every body through
 * `readJsonCapped`.
 * Spec: docs/design/2026-10-04-change-feed-harvest.md, section 4.4.
 * @module npm-feed
 */
import {
  applyFeedReads, carrierCounts, classifyManifest, parseFeedPage, selectFeedIds,
  type FeedRead, type FeedRow, type FeedRunReport, type FeedState,
} from './feed-state.ts'
import { fetchWithRetry, readJsonCapped, withTimeout } from './npm-client.ts'

export const FEED_URL = 'https://replicate.npmjs.com/registry'
const REGISTRY = 'https://registry.npmjs.org'

/** The API's maximum: `limit=20000` answers HTTP 400 (measured 2026-10-04). */
export const FEED_PAGE_LIMIT = 10_000

/** Pages one run may read. A catch-up from FEED_BOOTSTRAP_SEQ measured 62; a day, 4. */
export const FEED_PAGE_BUDGET = 200

/** Cap on one head or page body. The largest page measured was 1,078,874 bytes. */
export const FEED_PAGE_MAX_BYTES = 8 * 1024 * 1024

/** Cap on one `/latest` manifest. They average 2.5 KB; github-client caps a package.json at 1 MiB. */
export const FEED_MANIFEST_MAX_BYTES = 1024 * 1024

/** Concurrent manifest reads: 600 at 16 answered 25.8 a second with no 429 (measured 2026-10-04). */
export const FEED_READ_CONCURRENCY = 16

/** Wall-clock budget for one run's manifest reads. The bootstrap's 17,779 take ~11.5 minutes
 * at the measured rate, a day's ~700 about 30 seconds; what is not started becomes pending. */
export const FEED_READ_TIME_BUDGET_MS = 20 * 60_000

/** Per-attempt bound. Matches npm-client's: the same registry host, the same reason. */
export const FEED_REQUEST_TIMEOUT_MS = 30_000

/** One run's result. */
export interface FeedHarvest {
  /** The state to commit; the prior one, unchanged, when the feed is unavailable. */
  readonly next: FeedState
  readonly report: FeedRunReport
}

export interface HarvestFeedOptions {
  readonly harvestKeywords: readonly string[]
  readonly fetchImpl?: typeof fetch
  readonly sleep?: (ms: number) => Promise<void>
  /** The npm token, sent to the registry's `/latest` reads; the feed host takes none. */
  readonly token?: string
  /** Monotonic clock for the read budget; a seam, so a test can spend twenty minutes in none. */
  readonly now?: () => number
  readonly timeoutMs?: number
  readonly pageBudget?: number
  readonly readBudgetMs?: number
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/**
 * Attempts at one head or page request that THREW -- a connection reset,
 * DNS, a deadline, mid-body included -- or answered a 200 that is not JSON.
 * `fetchWithRetry` retries statuses and never throws, so without this one
 * reset on the head or the first page made the feed unavailable for the day
 * (2026-10-05 review). Manifest reads need none: a failed one is pending and
 * read again next run.
 */
export const FEED_FETCH_ATTEMPTS = 3

/** The pause before the second attempt, doubled before the third. */
const FEED_FETCH_RETRY_DELAY_MS = 2_000

/** What the feed host said about the request -- a status the status ladder
 * already outlasted, or a body past the cap -- so asking again buys nothing. */
class FeedAnswerError extends Error {}

/** GET one JSON body under a cap, or throw a sentence saying why not. */
async function getJson(url: string, timed: typeof fetch, sleep: (ms: number) => Promise<void>, cap: number): Promise<unknown> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const response = await fetchWithRetry(url, timed, sleep, undefined)
      if (!response.ok) throw new FeedAnswerError(`${url} answered ${response.status}`)
      const body = await readJsonCapped(response, cap)
      if (body.ok) return body.value
      // Not JSON is an edge answering in npm's place -- the `<!doctype html>`
      // 200 this registry has served before -- so it is asked again like a
      // throw. Past the cap is the body itself, so it is not.
      if (body.reason === 'too-large') throw new FeedAnswerError(`${url} answered a body over ${cap} bytes`)
      throw new Error(`${url} answered a body that is not JSON`)
    } catch (error) {
      if (error instanceof FeedAnswerError || attempt >= FEED_FETCH_ATTEMPTS) throw error
      await sleep(FEED_FETCH_RETRY_DELAY_MS * 2 ** (attempt - 1))
    }
  }
}

/** Read one `/latest` manifest and say what it established. Never throws. */
async function readLatest(
  name: string,
  timed: typeof fetch,
  sleep: (ms: number) => Promise<void>,
  token: string | undefined,
  harvestKeywords: readonly string[],
): Promise<FeedRead> {
  let response: Response
  try {
    response = await fetchWithRetry(`${REGISTRY}/${encodeURIComponent(name)}/latest`, timed, sleep, token)
  } catch (error) {
    return { kind: 'failed', name, reason: message(error) }
  }
  if (response.status === 404) return { kind: 'gone', name }
  // Only a 404 is an answer about the package. Every other non-2xx -- a 429
  // or 5xx the ladder could not outlast, but also a 403 from a blocking
  // edge -- is a statement about this request, so the name keeps its status
  // and is read again next run. CLAUDE.md: `no-manifest` means the manifest
  // was read, or a 404 answered for it, never that a request failed; a
  // blocked host once wrote that verdict into a durable record.
  if (!response.ok) return { kind: 'failed', name, reason: `the registry answered ${response.status}` }
  let body: Awaited<ReturnType<typeof readJsonCapped>>
  try {
    body = await readJsonCapped(response, FEED_MANIFEST_MAX_BYTES)
  } catch (error) {
    // A deadline that lands mid-body, or a stream that errors: a statement
    // about the transport, not about the manifest, so the name is retried.
    return { kind: 'failed', name, reason: message(error) }
  }
  // npm serializes every manifest as JSON well under the cap, so a body past
  // it or not JSON -- the `<!doctype html>` 200 this registry has served
  // before -- is not the package's manifest either.
  if (!body.ok) {
    return { kind: 'failed', name, reason: body.reason === 'too-large' ? `the registry answered a body over ${FEED_MANIFEST_MAX_BYTES} bytes` : 'the registry answered a body that is not JSON' }
  }
  return classifyManifest(name, body.value, harvestKeywords)
}

/**
 * Read the feed forward from `prior.seq` and the manifests it selects, and
 * return the next state (spec section 4.4). Never throws for a feed
 * problem: an unreadable head or first page, or a cursor past the head,
 * makes the feed unavailable and returns `prior` unchanged; a later page
 * that fails ends paging with the prefix already read.
 */
export async function harvestFeed(prior: FeedState, options: HarvestFeedOptions): Promise<FeedHarvest> {
  const {
    harvestKeywords, fetchImpl = fetch, sleep = defaultSleep, token,
    // A duration, so a monotonic clock: an NTP step must not expire it.
    now = () => performance.now(),
    timeoutMs = FEED_REQUEST_TIMEOUT_MS, pageBudget = FEED_PAGE_BUDGET, readBudgetMs = FEED_READ_TIME_BUDGET_MS,
  } = options
  const timed = withTimeout(fetchImpl, timeoutMs, 'npm change feed')
  const unavailable = (note: string): FeedHarvest => ({
    next: prior,
    report: {
      available: false, note, fromSeq: prior.seq, toSeq: prior.seq, pages: 0,
      selected: 0, read: 0, failed: 0, unreached: 0, refused: 0,
      pending: prior.pending.length, carriers: carrierCounts(prior, harvestKeywords),
    },
  })

  let head: unknown
  try {
    head = await getJson(`${FEED_URL}/`, timed, sleep, FEED_PAGE_MAX_BYTES)
  } catch (error) {
    return unavailable(`the feed head could not be read: ${message(error)}`)
  }
  const updateSeq = head !== null && typeof head === 'object' ? (head as { update_seq?: unknown }).update_seq : undefined
  if (typeof updateSeq !== 'number' || !Number.isSafeInteger(updateSeq) || updateSeq < 0) {
    return unavailable('the feed head carries no integer update_seq')
  }
  if (prior.seq > updateSeq) {
    return unavailable(`the stored cursor ${prior.seq} is past the feed head ${updateSeq}: the replica was rebuilt or renumbered, so registry/feed-state.json must be re-seeded`)
  }

  const rows: FeedRow[] = []
  let seq = prior.seq
  let pages = 0
  let note = ''
  for (;;) {
    if (pages >= pageBudget) {
      note = `stopped at the ${pageBudget}-page budget`
      break
    }
    let page: ReturnType<typeof parseFeedPage>
    try {
      page = parseFeedPage(await getJson(`${FEED_URL}/_changes?since=${seq}&limit=${FEED_PAGE_LIMIT}`, timed, sleep, FEED_PAGE_MAX_BYTES))
    } catch (error) {
      if (pages === 0) return unavailable(`the first feed page could not be read: ${message(error)}`)
      note = `stopped after ${pages} page(s): ${message(error)}`
      break
    }
    // A page whose cursor goes backwards, or a non-empty one that does not
    // advance it, would re-read forever or apply rows out of order.
    if (page === null || page.lastSeq < seq || (page.rows.length > 0 && page.lastSeq === seq)) {
      if (pages === 0) return unavailable('the first feed page has an unexpected shape')
      note = `stopped after ${pages} page(s): a page has an unexpected shape`
      break
    }
    for (const row of page.rows) rows.push(row)
    pages += 1
    seq = page.lastSeq
    if (page.rows.length < FEED_PAGE_LIMIT) break
  }

  const selection = selectFeedIds(rows, prior)
  const results: FeedRead[] = selection.gone.map((name): FeedRead => ({ kind: 'gone', name }))
  const reads: (FeedRead | undefined)[] = new Array<FeedRead | undefined>(selection.read.length)
  const started = now()
  let claimed = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = claimed
      claimed += 1
      const name = selection.read[index]
      if (name === undefined) return
      reads[index] = now() - started >= readBudgetMs
        ? { kind: 'unreached', name }
        : await readLatest(name, timed, sleep, token, harvestKeywords)
    }
  }
  await Promise.all(Array.from({ length: Math.min(FEED_READ_CONCURRENCY, selection.read.length) }, worker))
  for (const read of reads) if (read !== undefined) results.push(read)

  const next = applyFeedReads(prior, results, seq)
  const count = (kind: FeedRead['kind']): number => results.filter(read => read.kind === kind).length
  return {
    next,
    report: {
      available: true, note, fromSeq: prior.seq, toSeq: seq, pages,
      selected: selection.read.length,
      read: selection.read.length - count('unreached'),
      failed: count('failed'),
      unreached: count('unreached'),
      refused: selection.refused,
      pending: next.pending.length,
      carriers: carrierCounts(next, harvestKeywords),
    },
  }
}
