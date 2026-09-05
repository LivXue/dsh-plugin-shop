/**
 * The impure shell for the GitHub half of the harvest: partitioned topic
 * search and per-repository manifest fetches. Everything npm-shaped lives in
 * `npm-client.ts`; the policy decisions these feeds enable live in the pure
 * `repo-gate.ts` / `pipeline.ts` on the other side of this boundary, and the
 * harvest memory (what to re-fetch) lives in `repo-state.ts`.
 *
 * GitHub's search API caps every query at 1,000 results, and the topic pool
 * is ~13k repos with a single day alone exceeding the cap — so the pool is
 * enumerated through MUTUALLY EXCLUSIVE windows (stars bucket × created-date
 * range × size bucket) whose totals each fit under the cap. Window totality
 * is cheap (one `per_page=1` probe per window reads `total_count`); the
 * expensive part — per-repo manifest and commit fetches — runs only for the
 * repos whose `pushed_at` changed since the last recorded state.
 */

import { createHash } from 'node:crypto'
import { truncateWholeCharacters } from './gate.ts'
import { FetchTimeoutError, fetchWithRetry, withTimeout } from './npm-client.ts'
import { diffRepoState, nextRepoState, type RepoSeen, type RepoState } from './repo-state.ts'
import { hasWorkspaceDeps, monorepoSignal, selectSubpackagePaths } from './subpackage-select.ts'
import type { RepoCandidate } from './types.ts'
import { readCappedBody } from './http-body.ts'

const GITHUB_API = 'https://api.github.com'
const RAW_GITHUB = 'https://raw.githubusercontent.com'

const SEARCH_PAGE_SIZE = 100
/** GitHub's hard ceiling: 1,000 results per query, no page 11. */
export const GITHUB_SEARCH_CAP = 1000
/** Pages of the cap; windows are partitioned so each fits. */
export const MAX_SEARCH_PAGES = Math.ceil(GITHUB_SEARCH_CAP / SEARCH_PAGE_SIZE)

/** The GitHub topics the harvest searches, mirroring the npm keywords. */
export const HARVEST_TOPICS: readonly string[] = ['dsh-plugin', 'deepseek-harness']

/**
 * The largest release tarball the rescue probe will hold in memory. The
 * probe is advisory — an over-cap tarball is un-rescuable, same as an
 * absent one — so it must refuse the body rather than OOM the build.
 */
export const MAX_TARBALL_BYTES = 32 * 1024 * 1024

/**
 * The largest `package.json` the harvest will read. The manifest body had no
 * cap at all, unlike the tarball reader's 32 MB one, and both the raw manifest
 * `name` and the raw, unvalidated `dsh.catalog` value are stored verbatim in
 * the COMMITTED `repo-state.json` even when the gate later rejects the
 * candidate. The largest real dsh manifest observed is about 100 KB.
 */
export const MAX_MANIFEST_BYTES = 1024 * 1024

/**
 * Per-attempt bound on a GitHub request (API or raw). Matches npm-client's: a
 * run makes thousands of these, and a stalled one must not consume the job's
 * whole budget. Applied INSIDE {@link fetchRobust}'s retry ladder, so four
 * attempts cost at most four deadlines rather than four of undici's 300s
 * defaults.
 */
export const GITHUB_REQUEST_TIMEOUT_MS = 30_000

/**
 * Per-attempt bound on a release-tarball DOWNLOAD, as opposed to the metadata
 * requests around it.
 *
 * The deadline covers the body now (see withTimeout), and this is the only
 * path in the repo that reads a body up to {@link MAX_TARBALL_BYTES} — 32 MB,
 * or 32,768x a manifest's cap. On the shared 30s bound a healthy 32 MB asset
 * would have to sustain 1.07 MB/s (8.5 Mbit/s) or be killed. At 300s the floor
 * is 109 KB/s (0.87 Mbit/s), far below any plausible runner-to-GitHub-CDN
 * throughput. Being wrong the other way is cheap and self-correcting: the
 * probe is advisory and degrades to no release. Being wrong THIS way is not —
 * a missed release rides through the state file and is not re-probed until the
 * repository is pushed to again.
 */
export const TARBALL_REQUEST_TIMEOUT_MS = 300_000

/**
 * The share of one run's fetch attempts that may throw before the harvest is
 * treated as broken rather than the repositories.
 *
 * Isolating a per-repo throw keeps one bad repository from ending the run —
 * but unbounded it also turns a TOTAL failure into a green publish: every
 * repository throwing for one shared reason (a CI egress allowlist, a revoked
 * token, an API shape change) returns normally and the build ships zero GitHub
 * entries, or yesterday's plus hundreds of rejections naming innocent repos,
 * every day, because `fetch-failed` is not persisted and the same repositories
 * retry into the same failure. `build.ts` describes exactly this hole on the
 * npm half; the GitHub half must not reopen it.
 *
 * The two rates are far apart, so the threshold does not need to be delicate.
 * A run's queue is up to REPO_BACKFILL_BUDGET (2000) of the 14,740 repositories
 * in `repo-state.json`; the observed isolated rate is at most one or two per
 * run — the harvest that produced 13,120 candidates threw zero times until one
 * repository published a `null` manifest, and that input is now guarded. A
 * systematic cause produces ~100%. Ten percent is an order of magnitude above
 * the isolated rate and an order of magnitude below a systematic one.
 */
export const MAX_THROWN_FRACTION = 0.1

/**
 * Throws below this count never trip {@link MAX_THROWN_FRACTION}, whatever the
 * fraction works out to. A quiet day's queue can be a handful of repositories,
 * and three of three throwing is not evidence of anything systematic — it is
 * three repositories. The floor is what keeps a small run, and every test that
 * harvests a few fixtures, from tripping a bound meant for a pool-wide fault.
 */
export const MIN_THROWN_TO_BOUND = 20

/**
 * The longest bundle name accepted from a repository manifest, npm's own
 * limit. A name reaches `first-seen.yml`, `categories.yml`, `markets.yml`,
 * `manifest.lock`, the published entry and the build report, so an unbounded
 * one is a bloat vector in six places at once.
 */
export const BUNDLE_NAME_MAX_LENGTH = 214

/**
 * The package-name grammar a repository's manifest `name` must satisfy: an
 * optional `@scope/`, then url-safe characters, never leading with a dot or an
 * underscore. This is npm's grammar minus its lowercase-only rule for a NEW
 * publication — a GitHub bundle name is not an npm publication, and rejecting
 * `DSH-FS-TOOL` would drop a repository that installs fine (case folding on
 * this channel is repo-gate's job; see B-8). Everything the grammar excludes
 * is what broke the bot-written YAML: whitespace, quotes, backslashes,
 * newlines, `#`, and braces. `Skills Manager` and `{{PKG_NAME}}` are both
 * already in the committed repo-state.
 */
export const BUNDLE_NAME_RE = /^(?:@[A-Za-z0-9][A-Za-z0-9._-]*\/)?[A-Za-z0-9][A-Za-z0-9._-]*$/

/**
 * The longest subpackage directory path a repository may contribute.
 *
 * `MAX_SUBPACKAGES` bounds how MANY subpackages a repository contributes and
 * nothing bounded how long one of their paths is — but the path is not
 * incidental data, it is the entry's own identifier: `owner/slug#subdir` is
 * the key of every row this module publishes for a subpackage, and `repo-gate`
 * builds the same string as the unit for each of ITS rejections. So an
 * unbounded path is republished by the very rejection meant to stop it (the
 * npm half had the identical hole on `name`, gate.ts), lands in the COMMITTED
 * repo-state.json, and reaches report.md and the published entry.
 *
 * Bounded here, beside {@link BUNDLE_NAME_MAX_LENGTH}, for the same reason
 * that one is: this is where an untrusted string becomes a published
 * identifier. 200 is more than three times the longest path that exists —
 * measured against the committed repo-state.json, whose 597 subpackage entries
 * top out at 61 characters
 * (`apps/desktop/bundled-server/plugins/dsh-better-sidebar-skills`).
 */
export const SUBDIR_MAX_LENGTH = 200

/** Whether an untrusted manifest `name` is a usable bundle name. */
export function isBundleName(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= BUNDLE_NAME_MAX_LENGTH
    && BUNDLE_NAME_RE.test(value)
}

/**
 * GitHub's API speaks HTTP/2 to undici, whose long-lived h2 connections can
 * die with a transient `UND_ERR_HEADERS_TIMEOUT` on the next request. A
 * bounded retry on network throws (4 attempts, doubling backoff 2/4/8s)
 * rides those out; 429s still go through fetchWithRetry's own budget.
 */
async function fetchRobust(
  url: string,
  fetchImpl: typeof fetch,
  sleep: (ms: number) => Promise<void>,
  token: string | undefined,
  timeoutMs: number = GITHUB_REQUEST_TIMEOUT_MS,
): Promise<Response> {
  // The deadline wraps the impl INSIDE the retry ladder, so each of the four
  // attempts is bounded rather than the ladder multiplying undici's 300s
  // default by four.
  const timed = withTimeout(fetchImpl, timeoutMs, 'github')
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fetchWithRetry(url, timed, sleep, token)
    } catch (error) {
      if (attempt >= 3) throw error
      await sleep(2000 * 2 ** attempt)
    }
  }
}

/** One repository's fetch outcome: gated-able candidates (one for a plugin
 * root, several for a monorepo's plugin subpackages), or the reason none
 * could be produced. `no-manifest` means the repo ANSWERED — a 404 for its
 * `package.json`, or a body that is not a usable manifest — so it is not an
 * installable plugin unit, an author-readable fact distinct from a transient
 * failure. Any other non-ok status is a transient failure and never a
 * `no-manifest`: it throws, and harvestRepos turns it into a `fetch-failed`
 * row that is counted and recorded nowhere.
 * `subpackageFailures` rides alongside a successful outcome: a subpackage
 * that declared `dsh.bundle` but failed the name grammar is not silently
 * dropped like a bundle-less one — it claimed to be a plugin, so it gets
 * its own `owner/slug#subdir` rejection even when the repo also produced
 * usable candidates, or none at all. */
export type RepoFetchResult =
  | { ok: true; candidates: RepoCandidate[]; subpackageFailures?: RepoFetchFailure[] }
  | { ok: false; code: RepoFetchFailure['code']; detail: string; subpackageFailures?: RepoFetchFailure[] }

/** One repository — or one `owner/slug#subdir` subpackage unit — that could
 * not become a candidate, with the reason. */
export interface RepoFetchFailure {
  repo: string
  code: 'no-manifest' | 'fetch-failed'
  detail: string
}

/** The search-item fields the harvest trusts, validated at the boundary. */
interface RepoMeta {
  fullName: string
  defaultBranch: string
  description: string | null
  license: string | null
  pushedAt: string
  /**
   * `stargazers_count` from the search item. The daily enumeration pages
   * the whole pool regardless of the fetch budget, so every listed repo's
   * count is a free byproduct of it. Null when the item lacks a usable
   * count — the repo then falls back to the GraphQL stars fetch. Never
   * persisted: stars are live daily data and belong in the sidecar alone.
   */
  stars: number | null
}

function parseRepoMeta(item: unknown): RepoMeta | null {
  // Total for `unknown`, the same contract subpackage-select.ts states: an
  // item this cannot read is skipped, exactly as one missing `full_name` is.
  // Only `null` ever threw — and it threw on the SEARCH path, outside the
  // per-repo try, so it ended the harvest rather than becoming a row.
  if (typeof item !== 'object' || item === null) return null
  const o = item as {
    full_name?: unknown
    default_branch?: unknown
    description?: unknown
    license?: { spdx_id?: unknown } | null
    pushed_at?: unknown
    stargazers_count?: unknown
  }
  if (typeof o.full_name !== 'string' || typeof o.default_branch !== 'string') return null
  return {
    fullName: o.full_name,
    defaultBranch: o.default_branch,
    description: typeof o.description === 'string' && o.description !== '' ? o.description : null,
    license: o.license != null && typeof o.license.spdx_id === 'string' ? o.license.spdx_id : null,
    pushedAt: typeof o.pushed_at === 'string' ? o.pushed_at : '',
    stars: typeof o.stargazers_count === 'number' && o.stargazers_count >= 0 ? o.stargazers_count : null,
  }
}

/**
 * The search API meters at 30 requests/minute (PAT) and 403s bursts; pace
 * every search request by a 2s gap and retry a secondary-rate-limit 403 once
 * after a 30s pause. 429s keep fetchWithRetry's own budget.
 */
async function searchRequest(
  url: string,
  fetchImpl: typeof fetch,
  sleep: (ms: number) => Promise<void>,
  token: string | undefined,
): Promise<Response> {
  await sleep(2000)
  let response = await fetchRobust(url, fetchImpl, sleep, token)
  if (response.status === 403) {
    await sleep(30_000)
    response = await fetchRobust(url, fetchImpl, sleep, token)
  }
  return response
}

/**
 * Probe one query's `total_count` with a minimal page.
 * @throws when the response answers no numeric total, or stays partial across
 *   {@link searchBody}'s retry. A malformed probe must not read as an empty
 *   window: this number decides the partition split, the zero-window skip in
 *   {@link searchReposByTopic} and the coverage check there, and a silent 0
 *   disables all three — it now skips the window outright. Same rule, and the
 *   same reason, as npm-client's `searchTotal`. `incomplete_results` is the
 *   same hazard wearing a 200: a timed-out probe answers an UNDERCOUNT, which
 *   reads as a smaller window rather than a broken measurement.
 */
export async function probeTotal(
  query: string,
  fetchImpl: typeof fetch,
  sleep: (ms: number) => Promise<void>,
  token: string | undefined,
): Promise<number> {
  const url = `${GITHUB_API}/search/repositories?q=${encodeURIComponent(query)}&per_page=1`
  const body = await searchBody(url, `github search probe for ${query}`, fetchImpl, sleep, token)
  if (typeof body.total_count !== 'number') {
    throw new Error(`github search probe for ${query} answered no total_count; a window's size cannot be measured without it`)
  }
  return body.total_count
}

/**
 * Read a search response body as an object.
 *
 * A 200 carrying `<!doctype html>` (a proxy's error page) makes `.json()`
 * throw, and a 200 carrying the four bytes `null` parses to a value every
 * property read below then throws on. Both escaped as a raw TypeError or
 * SyntaxError from a property access, out of harvestRepos, into build.ts's one
 * whole-harvest retry, and killed the build with a message naming neither the
 * query nor what arrived.
 *
 * It still throws — a search that cannot complete MUST abort the harvest,
 * because harvesting only the pages that answered silently shrinks the pool
 * and is indistinguishable from an empty ecosystem. The change is that the
 * error says which query and what came back.
 * @param response - an `ok` search response.
 * @param what - the operation, for the message.
 * @returns the parsed body as an object.
 */
async function readSearchBody(
  response: Response,
  what: string,
): Promise<{ total_count?: unknown; items?: unknown; incomplete_results?: unknown }> {
  let parsed: unknown
  try {
    parsed = await response.json()
  } catch (error) {
    // A deadline is not a malformed body. Both throw, and throwing is right
    // here — a search that cannot complete must abort the harvest rather than
    // publish a short ecosystem — but the REASON has to be true: "answered 200
    // with a body that is not JSON" sends an operator hunting a proxy error
    // page while GitHub is simply stalled and our own clock ran out.
    if (error instanceof FetchTimeoutError) throw error
    // Same rule as npm's search: a 200 that is not JSON is a loud failure,
    // not a zero-result page.
    throw new Error(`${what} answered 200 with a body that is not JSON`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${what} answered 200 with a body that is not JSON: ${JSON.stringify(parsed)?.slice(0, 60) ?? typeof parsed}`)
  }
  return parsed as { total_count?: unknown; items?: unknown; incomplete_results?: unknown }
}

/**
 * Request one search URL and read its body, retrying once when GitHub says the
 * answer it served is partial.
 *
 * `incomplete_results` is GitHub reporting that the query TIMED OUT server-side
 * and what came back is a partial result set wearing an ordinary 200. Both
 * callers have to refuse it, for the same reason and with different blast
 * radii: a partial PAGE cannot be told from a whole one by looking at its
 * items, and a partial PROBE answers an undercounted `total_count` — the
 * number the partition splits on, the zero-window skip reads, and the coverage
 * check in {@link searchReposByTopic} measures every enumeration against. A
 * probe that times out to 0 therefore skips its whole window in silence, which
 * is precisely the failure the throw-on-missing-total above exists to prevent;
 * checking one and not the other left the more dangerous half open.
 *
 * But a timeout is transient by definition, and throwing on the first one
 * fails the entire daily build — every window, each paged — on one slow second
 * at GitHub, publishing nothing at all. So it gets the one retry its
 * transience deserves (paced for free: {@link searchRequest} sleeps before
 * every request) and the throw stands only when the answer stays partial.
 * @param url - the fully-built search URL.
 * @param what - this request's name, used verbatim in every error it raises.
 * @throws when the request fails, the body is unreadable, or both attempts
 *   come back partial.
 */
async function searchBody(
  url: string,
  what: string,
  fetchImpl: typeof fetch,
  sleep: (ms: number) => Promise<void>,
  token: string | undefined,
): Promise<{ total_count?: unknown; items?: unknown; incomplete_results?: unknown }> {
  for (let attempt = 1; ; attempt += 1) {
    const response = await searchRequest(url, fetchImpl, sleep, token)
    if (!response.ok) throw new Error(`${what} failed: ${response.status}`)
    const body = await readSearchBody(response, what)
    if (body.incomplete_results !== true) return body
    if (attempt > 1) {
      throw new Error(`${what} answered incomplete_results on ${attempt} attempts: the query timed out and what it served is partial`)
    }
  }
}

/**
 * One page of a windowed search.
 *
 * `skipped` is separate from `metas` on purpose, and it is the whole reason
 * this is a record rather than an array. An item {@link parseRepoMeta} cannot
 * read still OCCUPIES a slot in the result set, so a caller that measures its
 * progress in parsed items alone falls one behind per unreadable item — and
 * the loop that broke on a short page of them abandoned everything after the
 * first one.
 */
interface SearchPageResult {
  metas: RepoMeta[]
  /** Items on this page that {@link parseRepoMeta} refused. */
  skipped: number
  /** `total_count` as answered for THIS page; tracks a window that shrank. */
  total: number
}

/**
 * Fetch one page of a windowed search.
 * @throws when the page answers no numeric total, or stays partial across
 *   {@link searchBody}'s retry — neither can be told apart from a complete
 *   page by looking at the items.
 */
async function searchPage(
  query: string,
  page: number,
  fetchImpl: typeof fetch,
  sleep: (ms: number) => Promise<void>,
  token: string | undefined,
): Promise<SearchPageResult> {
  const url = `${GITHUB_API}/search/repositories?q=${encodeURIComponent(query)}&per_page=${SEARCH_PAGE_SIZE}&page=${page}`
  const body = await searchBody(url, `github search for ${query} page ${page}`, fetchImpl, sleep, token)
  // Same rule as the npm half: a page carrying no total cannot be told apart
  // from a truncated one, so it throws rather than ending the window on
  // whatever happened to arrive.
  if (typeof body.total_count !== 'number') {
    throw new Error(`github search for ${query} page ${page} answered no total_count; a truncated page cannot be told from a complete one`)
  }
  const items = Array.isArray(body.items) ? body.items : []
  const metas: RepoMeta[] = []
  let skipped = 0
  for (const item of items) {
    const meta = parseRepoMeta(item)
    if (meta === null) skipped += 1
    else metas.push(meta)
  }
  return { metas, skipped, total: body.total_count }
}

/** One partition window: extra qualifiers appended to `topic:<topic>`. */
interface Window {
  created?: string
  stars?: '0' | '>=1'
  size?: '<100' | '100..999' | '>=1000'
}

function windowQuery(topic: string, window: Window): string {
  const parts = [`topic:${topic}`]
  if (window.stars !== undefined) parts.push(`stars:${window.stars}`)
  if (window.created !== undefined) parts.push(`created:${window.created}`)
  if (window.size !== undefined) parts.push(`size:${window.size}`)
  return parts.join(' ')
}

/** The day after a `YYYY-MM-DD` day. */
function nextDay(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

/**
 * Split a created range at its midpoint day. Returns the boundary day; the
 * caller builds `start..boundary` and `nextDay(boundary)..end`. Null when the
 * range cannot shrink (a single day). */
function splitRange(start: string, end: string): string | null {
  const startMs = Date.parse(`${start}T00:00:00Z`)
  const endMs = Date.parse(`${end}T00:00:00Z`)
  if (!(endMs > startMs)) return null
  const midMs = Math.floor((startMs + endMs) / 2)
  const boundary = new Date(midMs).toISOString().slice(0, 10)
  // `boundary === start` is VALID for a two-day range: the split becomes
  // start..start and nextDay(start)..end — two single days.
  if (boundary < start || boundary >= end) return null
  return boundary
}

/**
 * One window to page, with the size its own probe measured.
 *
 * The total used to be read for the split decision and then DISCARDED, which
 * left the paging loop with nothing to measure itself against: it stopped on
 * the first short page, so one unreadable item ended a window early and
 * nothing anywhere said so. Carrying it costs no extra request — the probe
 * already ran — and it is what turns "the pages stopped" into "the pages
 * stopped short", which is the difference between a harvest and a guess.
 */
export interface WindowPlan {
  window: Window
  total: number
}

/**
 * Partition one topic into mutually exclusive windows whose totals each fit
 * under {@link GITHUB_SEARCH_CAP}, so paging them enumerates the WHOLE pool.
 * Cascade: stars bucket → created-date bisection (day floor) → size bucket.
 * The probe counts every window once; the pool is ~13k repos concentrated in
 * recent days, and the stars split alone brings the worst day under the cap.
 * @returns each window paired with the total its probe answered.
 */
export async function partitionTopic(
  topic: string,
  probe: (query: string) => Promise<number>,
): Promise<WindowPlan[]> {
  const windows: WindowPlan[] = []
  const expand = async (window: Window): Promise<void> => {
    const total = await probe(windowQuery(topic, window))
    if (total <= GITHUB_SEARCH_CAP) {
      windows.push({ window, total })
      return
    }
    if (window.stars === undefined) {
      await expand({ ...window, stars: '0' })
      await expand({ ...window, stars: '>=1' })
      return
    }
    if (window.created === undefined) {
      await expand({ ...window, created: '2008-01-01..2099-01-01' })
      return
    }
    const [start, end] = window.created.split('..') as [string, string | undefined]
    const endDay = end ?? start
    const split = splitRange(start, endDay)
    if (split !== null) {
      await expand({ ...window, created: `${start}..${split}` })
      await expand({ ...window, created: `${nextDay(split)}..${endDay}` })
      return
    }
    if (window.size === undefined) {
      await expand({ ...window, size: '<100' })
      await expand({ ...window, size: '100..999' })
      await expand({ ...window, size: '>=1000' })
      return
    }
    // Every split dimension is exhausted and the window still exceeds the
    // cap: the pool changed shape under us. Failing loudly beats truncating.
    throw new Error(`github search window ${windowQuery(topic, window)} still exceeds ${GITHUB_SEARCH_CAP} results after stars/date/size splits`)
  }
  await expand({})
  return windows
}

/**
 * List every repository carrying one of the harvest topics, through the
 * partitioned windows. Deduplicated and sorted.
 * @returns the repos the search saw (with `pushedAt`), and the window count.
 */
export async function searchReposByTopic(
  fetchImpl: typeof fetch = fetch,
  sleep: (ms: number) => Promise<void> = async (ms: number) => { await new Promise(resolve => setTimeout(resolve, ms)) },
  token: string | undefined = undefined,
): Promise<{ seen: RepoSeen[]; metas: Map<string, RepoMeta>; windowCount: number }> {
  const byName = new Map<string, RepoMeta>()
  let windowCount = 0
  for (const topic of HARVEST_TOPICS) {
    const plans = await partitionTopic(topic, query => probeTotal(query, fetchImpl, sleep, token))
    windowCount += plans.length
    for (const { window, total: probed } of plans) {
      const query = windowQuery(topic, window)
      // A window the probe measured as empty has nothing to page, and asking
      // anyway costs a request plus the 2s search pace. `0 <= GITHUB_SEARCH_CAP`
      // is true, so every empty window used to be paged; the npm half skips a
      // zero cell explicitly, and the asymmetry reads as an oversight. Safe to
      // skip only because probeTotal now THROWS on a body with no total: a
      // malformed probe read as 0 would otherwise drop a whole window here.
      if (probed === 0) continue
      // Parsed plus skipped: an item we could not read still occupies a slot,
      // and counting only the parsed ones is precisely what let one `null`
      // item end a 250-repository window after 99 of them.
      let enumerated = 0
      for (let page = 1; ; page += 1) {
        if (page > MAX_SEARCH_PAGES) {
          // The window outgrew the cap between its probe and its pages. The
          // old bound stopped here in silence and published the first 1,000 —
          // the same defect as the short-page break, one line down.
          throw new Error(
            `github search for ${query} needs page ${page}, past the ${MAX_SEARCH_PAGES} pages the ${GITHUB_SEARCH_CAP}-result cap allows: it enumerated ${enumerated} of ${probed} measured at partition time, so the window has grown past the cap since and the partition is stale`,
          )
        }
        const { metas, skipped, total } = await searchPage(query, page, fetchImpl, sleep, token)
        for (const meta of metas) {
          if (!byName.has(meta.fullName)) byName.set(meta.fullName, meta)
        }
        enumerated += metas.length + skipped
        // Stop on the total the API answered for THIS page — which tracks a
        // window that shrank mid-run — never on a short page. An empty page is
        // the other terminator: there is nothing further to ask for, and the
        // coverage check below is what decides whether that is acceptable.
        if (metas.length + skipped === 0 || enumerated >= total) break
      }
      if (enumerated < probed) {
        // Safe by CHECK, the shape searchByKeywords uses on the npm half, and
        // for the same reason: the API has no way to prove a window was read
        // whole. The re-probe absorbs churn — these windows are `stars:0` and
        // `stars:>=1`, so a repository earning its first star mid-run leaves
        // one and joins another, and against a 14,740-repo pool that is an
        // ordinary day, not a broken harvest. It is paid for ONLY on the
        // shortfall path, so a healthy run costs no extra request.
        const after = await probeTotal(query, fetchImpl, sleep, token)
        const required = Math.min(probed, after)
        if (enumerated < required) {
          throw new Error(
            `github search for ${query} enumerated ${enumerated} of ${required} results; the window ended before its answered total, so the harvest would be silently short — and every repository it lost publishes repo-gone under its own name and is dropped from the committed state`,
          )
        }
      }
    }
  }
  const seen = [...byName.entries()]
    .map(([repo, meta]) => ({ repo, pushedAt: meta.pushedAt }))
    .sort((a, b) => (a.repo < b.repo ? -1 : a.repo > b.repo ? 1 : 0))
  return { seen, metas: byName, windowCount }
}

/** Fetch the default-branch head commit and its date for one repository. */
async function fetchHeadCommit(
  owner: string,
  slug: string,
  branch: string,
  fetchImpl: typeof fetch,
  sleep: (ms: number) => Promise<void>,
  token: string | undefined,
  timeoutMs: number = GITHUB_REQUEST_TIMEOUT_MS,
): Promise<{ sha: string; date: string } | null> {
  const url = `${GITHUB_API}/repos/${owner}/${slug}/commits/${branch}`
  const response = await fetchRobust(url, fetchImpl, sleep, token, timeoutMs)
  if (!response.ok) return null
  const body = await response.json() as { sha?: unknown; commit?: { author?: { date?: unknown } } }
  if (typeof body.sha !== 'string' || !/^[0-9a-f]{40}$/.test(body.sha)) return null
  const date = body.commit?.author?.date
  return { sha: body.sha, date: typeof date === 'string' ? date : '' }
}

/**
 * Probe a repository's latest GitHub Release for a prebuilt tarball — the
 * rescue channel for repos whose build script makes a git install impossible
 * through the shop (design 2026-08-31 market-borrowings §3.1). Only the
 * `requires-build` class triggers this probe, so its API cost is bounded by
 * the class it rescues. The result rides `repo-state.json` through the
 * candidate, so it re-probes only when the repo's `pushedAt` advances.
 * The tarball is downloaded once here and hashed: GitHub release assets are
 * immutable per URL (re-upload = new asset = new URL), so URL + sha256 is the
 * audit story. The probe is advisory — its fallback, the unchanged
 * `requires-build` rejection, is complete — so it returns null on any
 * failure and never throws. Returns null when there is no release, no
 * tarball asset, the probe could not be read, or the tarball exceeds
 * {@link MAX_TARBALL_BYTES}.
 */
async function fetchLatestReleaseTarball(
  owner: string,
  slug: string,
  fetchImpl: typeof fetch,
  sleep: (ms: number) => Promise<void>,
  token: string | undefined,
  timeoutMs: number = GITHUB_REQUEST_TIMEOUT_MS,
  tarballTimeoutMs: number = TARBALL_REQUEST_TIMEOUT_MS,
): Promise<{ tag: string; url: string; sha256: string } | null> {
  // The whole probe is advisory, so no failure inside it may crash the
  // harvest: every transport or read failure degrades to null, the
  // stars-sidecar rule ("any failure publishes without stars; the step
  // never throws").
  try {
    const url = `${GITHUB_API}/repos/${owner}/${slug}/releases/latest`
    const response = await fetchRobust(url, fetchImpl, sleep, token, timeoutMs)
    if (!response.ok) return null
    let body: { tag_name?: unknown; assets?: unknown }
    try {
      body = await response.json() as typeof body
    } catch {
      // Swallows an unreadable release body: a release we cannot read is a
      // release we cannot rescue — the same as an absent one.
      return null
    }
    if (typeof body.tag_name !== 'string' || !Array.isArray(body.assets)) return null
    const asset = body.assets
      .map(a => (a as { browser_download_url?: unknown }).browser_download_url)
      .find((u): u is string => typeof u === 'string' && /\.(?:tgz|tar\.gz)$/i.test(u))
    if (asset === undefined) return null
    // The asset alone gets the larger bound: the two requests above read a
    // few hundred bytes of GitHub's own JSON, and lending them 300s would
    // hand a stalled metadata call ten times the budget it needs.
    //
    // And it deliberately does NOT go through fetchRobust. That ladder retries
    // a throw four times with backoff, which is right for a few hundred bytes
    // over a flaky h2 connection and ruinous at 300s an attempt: a stalled
    // asset host -- the CI egress allowlist the catch below names, where
    // api.github.com is permitted and the asset's separate redirect host is
    // not -- cost 4 x 300s + 14s = 21 minutes per repository. Against the live
    // state file, 303 of 13,120 candidates carry a release, so a 2000-repo run
    // puts ~46 on this path: ~243 minutes at REPO_CONCURRENCY 4, twice the
    // whole job bound, for a probe that degrades to "no release" anyway. One
    // bounded attempt costs at most 5 minutes, so the same total is ~58 --
    // still the largest single thing the harvest can spend on advisory data,
    // and the place to put an aggregate budget if it is ever seen for real.
    // fetchWithRetry still absorbs a 429, which answers immediately.
    const assetResponse = await fetchWithRetry(asset, withTimeout(fetchImpl, tarballTimeoutMs, 'github'), sleep, token)
    if (!assetResponse.ok) return null
    const bytes = await readTarballBody(assetResponse)
    if (bytes === null) return null
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    return { tag: body.tag_name, url: asset, sha256 }
  } catch {
    // Swallows the transport failures every null-returning path above leaves
    // open: the releases call, and the asset download — the largest body read
    // in this file, capped at MAX_TARBALL_BYTES — whose stream can drop after
    // the headers arrived. The probe has nothing load-bearing; a permanent
    // failure, say a CI egress
    // allowlist that permits api.github.com but blocks the asset redirect
    // host, must leave the unchanged `requires-build` rejection standing
    // rather than take the whole daily catalog down.
    return null
  }
}


/**
 * Read an asset body with a hard cap, returning null when it exceeds
 * {@link MAX_TARBALL_BYTES}. The probe is advisory, so an over-cap tarball is
 * un-rescuable, same as an absent one — it must refuse the body rather than
 * hold a giant asset in memory. A `content-length` over the cap is refused
 * before any byte is read; everything else is measured by
 * {@link readCappedBody} as it arrives.
 */
async function readTarballBody(response: Response): Promise<Uint8Array | null> {
  const length = Number(response.headers.get('content-length'))
  if (Number.isFinite(length) && length > MAX_TARBALL_BYTES) return null
  return await readCappedBody(response, MAX_TARBALL_BYTES)
}

/**
 * Project one manifest (root or subpackage) into a candidate, or null when
 * it declares no usable name. `subdir` is present exactly for subpackages.
 */
function projectCandidate(
  meta: RepoMeta,
  manifest: unknown,
  head: { sha: string; date: string },
  subdir: string | undefined,
): RepoCandidate | null {
  // `null` is legal JSON, so a package.json of exactly those four bytes
  // reaches here as a parsed manifest — and every property read below would
  // throw on it. Anything that is not an object cannot carry a name, so it
  // projects to no candidate, the same as a manifest whose name fails the
  // grammar. Checked before the cast rather than after it: the cast is a
  // claim about shape that `null` satisfies structurally and not in fact.
  // The Array clause is belt-and-braces: an array reaches isBundleName with an
  // undefined name and is rejected there anyway, so it changes no behaviour —
  // it is here so the guard reads as "not an object shape" rather than as a
  // null check that happens to suffice today.
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) return null
  const m = manifest as {
    name?: unknown
    description?: unknown
    scripts?: { prepare?: unknown; prepack?: unknown }
    dsh?: { bundle?: unknown; catalog?: unknown }
  }
  const scripts = typeof m.scripts === 'object' && m.scripts !== null ? m.scripts : {}
  // The shape check is HERE, at the projection boundary, so no candidate with
  // an unusable name ever exists — not in the gate, not in repo-state.json,
  // not in the two bot-written YAML files. A bundle-less subpackage with a
  // bad name is dropped silently, same as a bundle-less one with a good
  // name — neither claimed to be a plugin. A subpackage that DOES declare
  // dsh.bundle is a different fact: probeSubpackageCandidates below gives it
  // its own author-readable rejection instead of letting it vanish. The
  // ROOT's own bad name is handled in fetchRepoCandidate below.
  if (!isBundleName(m.name)) return null
  return {
    name: m.name,
    repo: meta.fullName,
    commit: head.sha,
    version: head.sha,
    publishedAt: head.date === '' ? null : head.date,
    repository: `https://github.com/${meta.fullName}`,
    license: meta.license,
    hasBundle: m.dsh?.bundle !== undefined,
    requiresBuild: typeof scripts.prepare === 'string' || typeof scripts.prepack === 'string',
    hasWorkspaceDeps: hasWorkspaceDeps(manifest),
    catalog: m.dsh?.catalog ?? null,
    description: meta.description ?? (typeof m.description === 'string' ? m.description : null),
    ...(subdir !== undefined ? { subdir } : {}),
  }
}

/**
 * Format the reason a manifest `name` fails the bundle-name grammar. Shared
 * between the repo root (fetchRepoCandidate) and a subpackage
 * (probeSubpackageCandidates) so the wording never drifts between the two
 * call sites.
 */
function describeBadName(rawName: unknown): string {
  const grammar = `is not a usable package name (an optional @scope/, then letters, digits, ".", "-" or "_", at most ${BUNDLE_NAME_MAX_LENGTH} characters), so dsh cannot register it.`
  // 80 characters is an ECHO of hostile input, not a name bound: this string
  // is published to report.md on Pages. The name that gets here has already
  // failed the grammar, so its only remaining bound is
  // {@link MAX_MANIFEST_BYTES} — about a megabyte, copied verbatim into that
  // page and into every row quoting it. 80 is enough to recognise a name by;
  // the value itself is JSON-escaped because a raw one carries newlines and
  // quotes (`Skills Manager` and `{{PKG_NAME}}` are already in the committed
  // repo-state).
  if (typeof rawName === 'string') {
    return `package.json declares ${JSON.stringify(rawName.slice(0, 80))}, which ${grammar}`
  }
  // No name at all. Reachable from the SUBPACKAGE call site alone (the root
  // checks for undefined before asking), where a directory declared dsh.bundle
  // and no name — so the useful sentence names the missing field rather than
  // reciting a grammar the author did not break. It read "declares a
  // undefined".
  if (rawName === undefined || rawName === null) {
    return 'package.json declares no name, so dsh cannot register it.'
  }
  // A name that is not a string: an object, a number, a boolean. The old
  // `a ${typeof rawName}` published "declares a object" verbatim under the
  // repository's name. The type is the specific fact worth keeping; the
  // article was the part that was wrong.
  return `package.json declares a non-string name (${typeof rawName}), which ${grammar}`
}

/**
 * The outcome of reading one manifest body.
 *
 * The failure carries a `reason`, and that discriminant is the whole point:
 * `too-large` is a choice WE made about a body we never parsed, which may hold
 * a perfectly good plugin, while `unreadable` means the bytes are not a
 * manifest at all. A subpackage call site has to tell them apart — one is
 * worth publishing a row for, the other is the `{{ handlebars }}` template
 * this module's own noise policy declines to report per directory. A flat
 * `{ ok: false; detail }` cannot express that distinction, so a comment
 * claiming to make it would be describing something the code does not do.
 */
type ManifestRead =
  | { ok: true; manifest: unknown }
  | { ok: false; reason: 'too-large' | 'unreadable'; detail: string }

/**
 * Read one manifest response body, refusing anything past
 * {@link MAX_MANIFEST_BYTES}.
 *
 * EVERY manifest the harvest reads goes through here — the repository root's
 * and each subpackage's — and that is the point of the function existing
 * rather than the two checks being written out at each site. Both bodies land
 * in the same place: `projectCandidate` stores `dsh.catalog` raw,
 * `mergeRepoState` puts the candidate in `candidates`, and `build.ts` writes
 * `registry/repo-state.json`, which the daily workflow stages and pushes. An
 * unbounded manifest there is not a file a later build can shrink; it is a
 * commit. The root read was capped first and the subpackage read stayed
 * uncapped for exactly as long as the cap was a pair of inline `if`s —
 * `github-client.test.ts` now asserts structurally that no second reader
 * appears.
 * @param response - a manifest response, already known to be `ok`.
 * @returns the parsed manifest, or an author-readable reason it was refused.
 */
async function readManifest(
  response: Response,
): Promise<ManifestRead> {
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > MAX_MANIFEST_BYTES) {
    // Refused before a byte is read. An over-cap manifest is not an
    // installable plugin unit, and its raw `catalog` value would otherwise be
    // committed to repo-state.json whether or not the gate accepts it.
    //
    // This header is a FLOOR and never the cap: raw.githubusercontent.com
    // serves gzip, so it reports the COMPRESSED size (measured live: 744 bytes
    // for a 1,838-byte manifest, and a 256 MB one-character `description`
    // compresses to 260,986 — 1029:1). A value at the cap therefore admits
    // about a gigabyte, which is why the count that actually decides is taken
    // off the bytes as they arrive, below.
    return { ok: false, reason: 'too-large', detail: `package.json is larger than ${MAX_MANIFEST_BYTES} bytes, so it is not read.` }
  }
  let bytes: Uint8Array | null
  try {
    bytes = await readCappedBody(response, MAX_MANIFEST_BYTES)
  } catch (error) {
    // A deadline is not an unreadable manifest. `unreadable` becomes a
    // `no-manifest`, which harvestRepos PERSISTS in repo-state.json as a dead
    // end and publishes under the repository's name — a false and durable
    // accusation when the truth is that OUR request ran out of time. Now that
    // the deadline reaches the body, this catch can see one, so it rethrows:
    // the stall lands in harvestRepos' catch with every other transient
    // failure, sanitized, counted, and recorded nowhere.
    if (error instanceof FetchTimeoutError) throw error
    // Same rule as npm: an unreadable body is a rejection, not a crash.
    return { ok: false, reason: 'unreadable', detail: 'package.json was unreadable.' }
  }
  if (bytes === null) {
    // Over the cap by MEASUREMENT — the header understated it, or there was
    // none (a chunked response) — and the reader was cancelled the moment the
    // count crossed. The body did start reaching us on this path, so the
    // reason says discarded, not unread. A byte count, not a string length:
    // the constant and this sentence both say bytes, and `text.length` counted
    // UTF-16 code units, admitting up to 3x what it announced.
    return { ok: false, reason: 'too-large', detail: `package.json is larger than ${MAX_MANIFEST_BYTES} bytes, so it was discarded without being parsed.` }
  }
  try {
    return { ok: true, manifest: JSON.parse(new TextDecoder().decode(bytes)) }
  } catch {
    // A body that arrived but is not JSON is the same rejection as one that
    // could not be read: nothing else reaches here, and neither is a crash.
    return { ok: false, reason: 'unreadable', detail: 'package.json was unreadable.' }
  }
}

/**
 * Build one subpackage failure row, keyed `owner/slug#subdir`.
 *
 * EVERY subpackage row goes through here, which is the point of it existing
 * rather than the key being interpolated at each site: the key is a PUBLISHED
 * identifier — report.md's first column, and a value persisted verbatim into
 * the committed repo-state.json — so a path past {@link SUBDIR_MAX_LENGTH}
 * would be republished by the very rejection meant to stop it. The cut lands
 * on a whole character (see {@link truncateWholeCharacters}: a split astral
 * pair leaves an orphan surrogate that survives JSON and breaks any consumer
 * re-encoding it as UTF-8), it is marked with an ellipsis, and the detail says
 * it happened — a quietly cut key sends an author looking for a directory
 * whose name we invented.
 * @param owner - the repository owner.
 * @param slug - the repository name.
 * @param dir - the subpackage directory, untrusted and unbounded.
 * @param detail - the author-readable reason, before any cut is noted.
 */
function subpackageFailure(owner: string, slug: string, dir: string, detail: string): RepoFetchFailure {
  if (dir.length <= SUBDIR_MAX_LENGTH) {
    return { repo: `${owner}/${slug}#${dir}`, code: 'no-manifest', detail }
  }
  return {
    repo: `${owner}/${slug}#${truncateWholeCharacters(dir, SUBDIR_MAX_LENGTH)}…`,
    code: 'no-manifest',
    detail: `${detail} The path in this row is cut to that length.`,
  }
}

/**
 * Probe a monorepo's subpackages: list the tree once, select the candidate
 * directories (pure `selectSubpackagePaths`), and project the manifests
 * that declare a bundle. Bundle-less subpackages are not plugin candidates —
 * rejecting each one would drown the report in noise the author already
 * knows; the repo-level `no-bundle` rejection covers the case where none
 * qualify. Only the `hasBundle` filter is applied here; the gate remains
 * the sole policy authority for every candidate it receives.
 *
 * A subpackage that DOES declare `dsh.bundle` but fails the name grammar is
 * different: it claimed to be a plugin, so CLAUDE.md's "nothing disappears
 * without a reason attached to its name" applies, same as the repo root. It
 * gets its own `owner/slug#subdir` failure instead of vanishing.
 */
async function probeSubpackageCandidates(
  owner: string,
  slug: string,
  meta: RepoMeta,
  rootManifest: unknown,
  head: { sha: string; date: string },
  fetchImpl: typeof fetch,
  sleep: (ms: number) => Promise<void>,
  token: string | undefined,
  timeoutMs: number = GITHUB_REQUEST_TIMEOUT_MS,
): Promise<{ candidates: RepoCandidate[]; failures: RepoFetchFailure[]; anyClaimed: boolean; probed: number }> {
  const treeUrl = `${GITHUB_API}/repos/${owner}/${slug}/git/trees/${meta.defaultBranch}?recursive=1`
  const treeResponse = await fetchRobust(treeUrl, fetchImpl, sleep, token, timeoutMs)
  // A 404 is a fact: there is no tree at that branch, so there are no
  // subpackages to find. Any other status is our transport failing, and
  // swallowing it makes a monorepo look like it has none — after which a
  // bundle-less root earns a PERSISTED, published "declares no name and no
  // installable subpackage" that is false. That is exactly the reasoning the
  // catch below already applies to a deadline on this same read; a 500 or a
  // rate-limit 403 differs from a stall only in how it is spelled.
  if (treeResponse.status === 404) return { candidates: [], failures: [], anyClaimed: false, probed: 0 }
  if (!treeResponse.ok) {
    throw new Error(`github api returned ${treeResponse.status} listing the tree of ${owner}/${slug}`)
  }
  let treeBody: { tree?: unknown } = {}
  try {
    const parsed = await treeResponse.json() as unknown
    if (parsed !== null && typeof parsed === 'object') treeBody = parsed as typeof treeBody
  } catch (error) {
    // Same rule as readManifest's: swallowing a deadline here would make a
    // stalled tree read look like a monorepo with no subpackages, and a root
    // with no bundle of its own then earns a persisted `no-manifest` saying it
    // "declares no name and no installable subpackage" — false, and durable.
    if (error instanceof FetchTimeoutError) throw error
    return { candidates: [], failures: [], anyClaimed: false, probed: 0 }
  }
  // A truncated tree (>100k entries) may hide some subpackages; the repo is
  // re-probed when it changes, and the loss costs only a later re-probe —
  // unlike the search cap, this truncation is not pool-wide.
  const paths = Array.isArray(treeBody.tree)
    ? treeBody.tree.map(entry => (entry as { path?: unknown }).path).filter((p): p is string => typeof p === 'string')
    : []
  const dirs = selectSubpackagePaths(rootManifest, paths)
  const candidates: RepoCandidate[] = []
  const failures: RepoFetchFailure[] = []
  // Whether ANY subpackage claimed to be a plugin (declared dsh.bundle and
  // then failed the name grammar). Returned as an aggregate rather than a flag
  // on each row, deliberately: the rows are published verbatim and persisted
  // into the committed repo-state.json, so a per-row internal field has to be
  // stripped at every return that carries them — and one of three returns did
  // not, making the state file's round-trip non-idempotent. A boolean beside
  // the array is a shape that cannot leak, which beats a rule that has to be
  // remembered at each new return site.
  let anyClaimed = false
  for (const dir of dirs) {
    // The path itself, before it costs a request. A subpackage's directory is
    // its published identifier — this row's key, `repo-gate`'s unit for every
    // rejection it makes, and the `subdir` field of the entry in plugins.json
    // — and unlike a name it cannot be truncated for the entry, because a cut
    // path is an install location that does not exist. So an over-long one is
    // refused outright, with a reason, rather than listed under a lie or
    // dropped in silence.
    if (dir.length > SUBDIR_MAX_LENGTH) {
      failures.push(subpackageFailure(owner, slug, dir,
        `dsh does not list a subpackage whose directory path is longer than ${SUBDIR_MAX_LENGTH} characters: the path identifies the entry and is published in the catalog and in this report.`))
      continue
    }
    const subUrl = `${RAW_GITHUB}/${owner}/${slug}/${meta.defaultBranch}/${dir}/package.json`
    const subResponse = await fetchRobust(subUrl, fetchImpl, sleep, token, timeoutMs)
    // Same rule, third site: a 404 means the tree listed a path that is not
    // there, which is nothing to report. Anything else is a subpackage we
    // FAILED to read — a plugin silently missing from the catalog, and, when
    // it was the only one, a root handed the same false "no installable
    // subpackage" verdict. The whole repository is retried next run instead.
    if (subResponse.status === 404) continue
    if (!subResponse.ok) {
      throw new Error(`github raw returned ${subResponse.status} fetching ${owner}/${slug}/${dir}/package.json`)
    }
    const subRead = await readManifest(subResponse)
    if (!subRead.ok) {
      // Only the size refusal is reported. A failure here is keyed by PATH,
      // and the path is known right here, so it CAN carry a reason — but an
      // `unreadable` body is not a manifest and never claimed to be a plugin,
      // and reporting one row per directory for a template repo is the noise
      // this function's own policy declines to publish. An over-cap body is
      // the opposite: we declined to read something that may well be a plugin,
      // and staying silent would let the repository be published as having no
      // installable subpackage when it plainly has one.
      if (subRead.reason === 'too-large') {
        failures.push(subpackageFailure(owner, slug, dir, subRead.detail))
      }
      continue
    }
    const subManifest = subRead.manifest
    const sub = projectCandidate(meta, subManifest, head, dir)
    if (sub !== null && sub.hasBundle) {
      candidates.push(sub)
      continue
    }
    // sub === null means the name failed the grammar (projectCandidate's
    // only rejection reason); a good name with no bundle just falls through
    // silently, same as before — it never claimed to be a plugin.
    const declaresBundle = (subManifest as { dsh?: { bundle?: unknown } } | null)?.dsh?.bundle !== undefined
    if (sub === null && declaresBundle) {
      const rawName = (subManifest as { name?: unknown } | null)?.name
      anyClaimed = true
      failures.push(subpackageFailure(owner, slug, dir, describeBadName(rawName)))
    }
  }
  return { candidates, failures, anyClaimed, probed: dirs.length }
}

/**
 * Fetch one repository's manifest — and, for a monorepo root without a
 * bundle, its subpackage manifests — and project them into candidates.
 * @returns the candidates, or a code + author-readable reason.
 * @throws when a request fails in a way that says nothing about the
 *   repository: a stalled deadline, or any non-ok status that is not a 404.
 *   {@link harvestRepos} is the handler — it publishes a reason we wrote,
 *   diagnoses to stderr, persists nothing, and counts the failure toward the
 *   systematic-failure bound. Returning those as `no-manifest` instead is what
 *   let one blocked host write off every repository new to the state file.
 */
export async function fetchRepoCandidate(
  meta: RepoMeta,
  fetchImpl: typeof fetch = fetch,
  sleep: (ms: number) => Promise<void> = async (ms: number) => { await new Promise(resolve => setTimeout(resolve, ms)) },
  token: string | undefined = undefined,
  probeSubpackages = true,
  timeoutMs: number = GITHUB_REQUEST_TIMEOUT_MS,
  tarballTimeoutMs: number = TARBALL_REQUEST_TIMEOUT_MS,
): Promise<RepoFetchResult> {
  const [owner, slug] = meta.fullName.split('/')
  if (owner === undefined || slug === undefined) {
    return { ok: false, code: 'fetch-failed', detail: `unusable repository name ${meta.fullName}` }
  }

  const rawUrl = `${RAW_GITHUB}/${owner}/${slug}/${meta.defaultBranch}/package.json`
  // No catch here on purpose. A deadline rejection propagates to harvestRepos,
  // whose existing catch is already the right handler for it: it publishes a
  // reason we wrote rather than a raw exception message under the repository's
  // name, sends the diagnostic to stderr, and — the part a local catch would
  // silently disable — counts the failure toward the systematic-failure bound.
  // A GitHub that stalls for EVERY repo is a broken harvest, not three hundred
  // bad repositories, and it must stop the build rather than publish a catalog
  // that blames each of them by name.
  const manifestResponse = await fetchRobust(rawUrl, fetchImpl, sleep, token, timeoutMs)
  if (manifestResponse.status === 404) {
    return { ok: false, code: 'no-manifest', detail: 'No package.json at the repository root, so there is nothing for dsh to install.' }
  }
  if (!manifestResponse.ok) {
    // ONLY a 404 is a verdict about the repository. Every other status is a
    // failure of the transport this module owns — a 5xx, or the CI egress
    // allowlist that permits api.github.com and not raw.githubusercontent.com
    // that fetchLatestReleaseTarball's own catch names — and `no-manifest` was
    // returned for all of them. fetchWithRetry retries only a 429, so a 500 or
    // a 403 was RETURNED rather than thrown, harvestRepos PERSISTED it for
    // every repository with no recorded entry, and each was written off with
    // "No package.json at the repository root" until its `pushedAt` moved.
    //
    // It throws for the reason the comment above gives for a deadline:
    // harvestRepos is the right handler. It publishes a reason we wrote,
    // sends the status to stderr, records nothing — and counts the failure
    // toward the systematic-failure bound, which counts throws alone and so
    // could never fire for a status. A whole pool answering 403 is a broken
    // harvest, not fourteen thousand bad repositories.
    throw new Error(`github raw returned ${manifestResponse.status} fetching ${meta.fullName}/${meta.defaultBranch}/package.json`)
  }
  const rootRead = await readManifest(manifestResponse)
  if (!rootRead.ok) return { ok: false, code: 'no-manifest', detail: rootRead.detail }
  const manifest = rootRead.manifest

  const head = await fetchHeadCommit(owner, slug, meta.defaultBranch, fetchImpl, sleep, token, timeoutMs)
  if (head === null) {
    return { ok: false, code: 'fetch-failed', detail: `Could not resolve the head commit of ${meta.fullName}.` }
  }

  // A root name outside the grammar is a different, more specific fact than
  // "declares no name" — but reporting it must never cost a monorepo its
  // subpackages: a container with an unusable name can still hold valid
  // plugins underneath it (this cost jiweiyeah/Skills-Manager every one of
  // its subpackages before this fix). So the grammar is checked here, but
  // the rejection itself is only returned below, from the terminal
  // `root === null` branch, after the subpackage probe has had its chance.
  const rawRootName = (manifest as { name?: unknown } | null)?.name
  const rootNameInvalid = rawRootName !== undefined && rawRootName !== null && !isBundleName(rawRootName)
  const root = projectCandidate(meta, manifest, head, undefined)
  // The rescue probe: only a `requires-build` root can be rescued, so only it
  // is probed. The release rides the candidate through the state file, so a
  // repo with no release does not re-consume this budget daily.
  if (root !== null && root.requiresBuild) {
    const release = await fetchLatestReleaseTarball(owner, slug, fetchImpl, sleep, token, timeoutMs, tarballTimeoutMs)
    if (release !== null) root.release = release
  }
  if (root !== null && root.hasBundle) {
    return { ok: true, candidates: [root] }
  }
  if (probeSubpackages && monorepoSignal(manifest)) {
    const { candidates: subs, failures: subFailures, anyClaimed, probed } = await probeSubpackageCandidates(owner, slug, meta, manifest, head, fetchImpl, sleep, token, timeoutMs)
    // The probe happened and found nothing installable. Record how many
    // manifests it read so the root's rejection can say so instead of
    // pointing the author at the root manifest (B-7).
    if (root !== null && subs.length === 0 && probed > 0) root.probedSubpackages = probed
    if (subs.length > 0) {
      return { ok: true, candidates: subs, ...(subFailures.length > 0 ? { subpackageFailures: subFailures } : {}) }
    }
    if (subFailures.length > 0) {
      // A subpackage that claimed to be a plugin and failed its name grammar
      // is a more specific, more useful fact than the root's own name
      // problem (or its absence) — report that instead of the rejection
      // below, same as when subpackages had produced usable candidates. And
      // when there IS a root candidate the rejection below never runs anyway.
      if (root !== null || anyClaimed) {
        return { ok: true, candidates: root === null ? [] : [root], subpackageFailures: subFailures }
      }
      // Nothing claimed anything: every failure here is a body we declined to
      // read for size, and there is no root candidate either. What gets
      // published now turns on whether the root's own reason is TRUE.
      //
      // A root that declared an unusable name has a specific, wholly accurate
      // fact against it, and a size refusal — a choice we made about bytes we
      // never read — must not suppress it. Published alongside the rows.
      if (rootNameInvalid) {
        return {
          ok: false,
          code: 'no-manifest',
          detail: describeBadName(rawRootName),
          subpackageFailures: subFailures,
        }
      }
      // A root that declared NO name has only the reason below available, and
      // half of it — "no installable subpackage" — is false exactly here: the
      // subpackage may be a fine plugin we declined to read. Publishing it
      // would re-create the misattribution the size row exists to prevent, so
      // the rows are published on their own and nothing false is said.
      return { ok: true, candidates: [], subpackageFailures: subFailures }
    }
  }
  if (root === null) {
    if (rootNameInvalid) return { ok: false, code: 'no-manifest', detail: describeBadName(rawRootName) }
    return { ok: false, code: 'no-manifest', detail: 'package.json declares no name and no installable subpackage, so dsh has nothing to register.' }
  }
  // A root without a bundle: returned so the gate can reject it with the
  // author-readable no-bundle reason.
  return { ok: true, candidates: [root] }
}

/** Fewer parallel connections than the npm harvest: the GitHub CDN drops
 * bursts, and the API's per-token rate budget is modest. */
const REPO_CONCURRENCY = 4

/**
 * The per-run fetch budget when `REPO_BACKFILL_BUDGET` is unset: 2,000 of the
 * ~14,700 recorded repositories. Named here, beside the knob it bounds, rather
 * than left as a `?? '2000'` literal in build.ts — that file is a
 * top-level-await script with no test seam, so a policy number written there
 * is one nothing can read back.
 */
export const REPO_BACKFILL_BUDGET_DEFAULT = 2000

/**
 * Parse the per-run fetch budget from its environment string.
 *
 * `Number()` fails open in three ways that all end in the same place — a
 * silent no-harvest reported as `0 fetched` — because {@link harvestRepos}
 * slices its queue at the budget:
 *
 * - `Number('abc')` is `NaN`, and `[...].slice(0, NaN)` is `[]`.
 * - `Number('')` is `0`, and so is `Number(' ')`.
 * - `slice(0, -1)` counts from the END, so a negative budget quietly fetches
 *   all-but-one instead of the one it looks like.
 *
 * `0` is deliberately NOT one of them: it is a real instruction — search the
 * topics, fetch nothing — which is why the check cannot just refuse a falsy
 * budget.
 * @param raw - the environment value, or undefined when unset.
 * @param fallback - the budget to use when the variable is unset.
 * @throws when the value is present but not a non-negative integer, quoting it
 *   back: the operator cannot see the value in a log line that says `0 fetched`.
 */
export function parseHarvestBudget(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback
  const budget = Number(raw)
  if (raw.trim() === '' || !Number.isInteger(budget) || budget < 0) {
    throw new Error(`REPO_BACKFILL_BUDGET must be a non-negative integer; got ${JSON.stringify(raw)}`)
  }
  return budget
}

export interface RepoHarvestOptions {
  /** The previous committed state; the run carries untouched repos over. */
  state: RepoState
  /** Maximum repos to fetch this run — the backfill pacing knob; the rest
   * defer to later runs rather than bursting the REST quota. */
  budget: number
  fetchImpl?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  token?: string
  /** Whether bundle-less monorepo roots get a subpackage probe. Gated by the
   * schemaVersion-4 flag so no v3 client ever meets a subdir entry. */
  probeSubpackages?: boolean
  /** Per-attempt deadline on every per-repo request. Defaults to
   * {@link GITHUB_REQUEST_TIMEOUT_MS}; a seam, so a test need not wait one out. */
  timeoutMs?: number
  /** Per-attempt deadline on a release-tarball download, which reads a body up
   * to {@link MAX_TARBALL_BYTES}. Defaults to {@link TARBALL_REQUEST_TIMEOUT_MS}. */
  tarballTimeoutMs?: number
  /**
   * Pause before retrying the WHOLE harvest once, when the first attempt
   * throws. Unset means no retry.
   *
   * Opt-in on purpose, and deliberately not defaulted: a unit test that
   * retried by accident would turn a real failure into a slow pass. The daily
   * build sets it because the GitHub half runs through shared egress whose
   * throttles outlast the per-request backoffs.
   */
  retryAfterMs?: number
}

export interface RepoHarvestResult {
  /** Every candidate this run produced — fresh and carried alike. */
  candidates: RepoCandidate[]
  failures: RepoFetchFailure[]
  /** Everything the partitioned search saw. */
  seen: RepoSeen[]
  /** Recorded repos the search no longer returns. */
  gone: string[]
  /** The state to commit for the next run. */
  nextState: RepoState
  /** Whether the harvest was skipped (no token). */
  skipped: boolean
  /**
   * Star counts the search itself carried (`stargazers_count` on every
   * item), keyed by repo full name. Repos absent here fall back to the
   * GraphQL stars fetch. Not part of {@link nextState}: daily-changing
   * data must never enter the committed harvest memory.
   */
  searchStars: Map<string, number>
  windowCount: number
  /** Repositories this run ATTEMPTED to fetch — the queue length, not a
   * success count. See {@link RepoHarvestResult.thrown} for why the build note
   * reports both: a run where every attempt threw once read "300 fetched". */
  fetched: number
  /** How many of those attempts ended in an unexpected throw, isolated into a
   * `fetch-failed` row. Bounded per run by {@link MAX_THROWN_FRACTION}; the
   * count is surfaced so the one line a human reads cannot say a harvest went
   * fine when none of it did. */
  thrown: number
  carried: number
  deferred: number
  /**
   * The first attempt's error message when {@link RepoHarvestOptions.retryAfterMs}
   * bought a second one, else null. Reported rather than swallowed: a harvest
   * that needed a retry is not the same event as one that did not.
   */
  firstAttemptError: string | null
}

/**
 * Harvest every repository candidate for the topics, retrying the whole run
 * once when {@link RepoHarvestOptions.retryAfterMs} is set.
 *
 * The retry lives HERE rather than at the call site, and that is the point.
 * It used to sit in build.ts, which rebuilt the options object by hand for the
 * second attempt and left out `probeSubpackages`; this function defaults that
 * to `true` while build.ts's `schemaVersion` kept following the env flag. So a
 * retried harvest emitted `subdir` entries under schemaVersion 3 — and a v3
 * client ignores `subdir` and installs the monorepo ROOT, a silent no-op for
 * the user. Only the retry path could produce it, which is why nothing ever
 * saw it. One call site and one options object makes the class impossible
 * rather than merely fixed.
 */
export async function harvestRepos(options: RepoHarvestOptions): Promise<RepoHarvestResult> {
  const { retryAfterMs } = options
  try {
    return { ...await harvestOnce(options), firstAttemptError: null }
  } catch (error) {
    if (retryAfterMs === undefined) throw error
    const firstAttemptError = error instanceof Error ? error.message : String(error)
    const sleep = options.sleep ?? (async (ms: number) => { await new Promise(resolve => setTimeout(resolve, ms)) })
    await sleep(retryAfterMs)
    // The SAME object, never a rebuilt one. A second failure propagates: a
    // half-harvested catalog is worse than a red build, and the daily workflow
    // runs again tomorrow.
    return { ...await harvestOnce(options), firstAttemptError }
  }
}

/**
 * One harvest attempt: partition the search, diff against the recorded state,
 * re-fetch only new or changed repos (up to the budget), and carry the
 * untouched candidates over.
 */
async function harvestOnce(options: RepoHarvestOptions): Promise<Omit<RepoHarvestResult, 'firstAttemptError'>> {
  const {
    state, budget,
    fetchImpl = fetch,
    sleep = async (ms: number) => { await new Promise(resolve => setTimeout(resolve, ms)) },
    token = undefined,
    probeSubpackages = true,
    timeoutMs = GITHUB_REQUEST_TIMEOUT_MS,
    tarballTimeoutMs = TARBALL_REQUEST_TIMEOUT_MS,
  } = options
  if (token === undefined) {
    return { candidates: [], failures: [], thrown: 0, seen: [], gone: [], nextState: state, skipped: true, searchStars: new Map(), windowCount: 0, fetched: 0, carried: 0, deferred: 0 }
  }
  const { seen, metas, windowCount } = await searchReposByTopic(fetchImpl, sleep, token)
  const searchStars = new Map<string, number>()
  for (const [repo, meta] of metas) {
    if (meta.stars !== null) searchStars.set(repo, meta.stars)
  }
  const { toFetch, gone } = diffRepoState(state, seen)
  // Budget slice: sorted order keeps the deferral deterministic.
  const queue = toFetch.sort((a, b) => (a.repo < b.repo ? -1 : a.repo > b.repo ? 1 : 0)).slice(0, budget)
  const fresh = new Map<string, {
    candidates: RepoCandidate[]
    failure?: { code: 'no-manifest'; detail: string }
    subpackageFailures?: RepoFetchFailure[]
  }>()
  const failures: RepoFetchFailure[] = []
  // Counted separately from every other fetch-failed: a deleted or renamed
  // repository is a legitimate isolated failure and must stay a row, so only
  // THROW-derived failures feed the systematic-failure bound below.
  let thrown = 0
  const thrownMessages: string[] = []
  for (let i = 0; i < queue.length; i += REPO_CONCURRENCY) {
    const batch = queue.slice(i, i + REPO_CONCURRENCY)
    const results = await Promise.all(batch.map(async entry => {
      const meta = metas.get(entry.repo)
      if (meta === undefined) return { entry, result: { ok: false, code: 'fetch-failed', detail: 'search result lost between the enumeration and the fetch' } as RepoFetchResult }
      try {
        return { entry, result: await fetchRepoCandidate(meta, fetchImpl, sleep, token, probeSubpackages, timeoutMs, tarballTimeoutMs) }
      } catch (error) {
        // One repository must not be able to end the harvest. Everything in
        // this file already turns a bad package into a row; without this, an
        // unguarded throw anywhere in the projection escaped Promise.all, left
        // harvestRepos, and met build.ts's single whole-harvest retry — which
        // replays the same deterministic input and rethrows. A public repo
        // containing the four bytes `null` did exactly that. The bound after
        // the loop is what keeps this from turning a pool-wide fault into a
        // green publish.
        //
        // fetch-failed, not no-manifest: a throw is more likely our own defect
        // than a verdict on the repository, and fetch-failed is the code this
        // module does not persist as a dead end, so the repo is re-fetched
        // next run rather than written off.
        const message = error instanceof Error ? error.message : String(error)
        thrown += 1
        thrownMessages.push(`${entry.repo}: ${message}`)
        // The raw message is a diagnostic, not a verdict. It goes to stderr,
        // where whoever is reading the build can act on it — never into the
        // row, which is published to Pages under the repository's name and
        // would otherwise blame an author for what the comment above calls
        // our own defect.
        process.stderr.write(`github: harvesting ${entry.repo} threw: ${message}\n`)
        return {
          entry,
          result: {
            ok: false,
            code: 'fetch-failed',
            detail: 'The harvest could not process this repository. This is a fault on our side, not a judgement on the repository; it is retried on the next run.',
          } as RepoFetchResult,
        }
      }
    }))
    for (const { entry, result } of results) {
      if (result.ok) {
        // Subpackage failures ride the ok branch (they do not make the whole
        // repo a failure) — drained into this run's report, AND persisted, so
        // they carry across runs that do not re-fetch the repo exactly like a
        // repo-level failure. They were once deliberately not persisted; see
        // RepoStateEntry.subpackageFailures for why that stopped being safe.
        fresh.set(entry.repo, {
          candidates: result.candidates,
          ...(result.subpackageFailures !== undefined ? { subpackageFailures: result.subpackageFailures } : {}),
        })
        if (result.subpackageFailures !== undefined) failures.push(...result.subpackageFailures)
      } else {
        failures.push({ repo: entry.repo, code: result.code, detail: result.detail })
        // A repo-level rejection can now carry subpackage rows alongside it
        // (a root with an unusable name whose subpackage was refused for
        // size); they are reported and persisted the same as on the ok branch.
        if (result.subpackageFailures !== undefined) failures.push(...result.subpackageFailures)
        // A `no-manifest` is a fact about the repository's contents at this
        // `pushed_at`, so it is recorded whether or not the repo was recorded
        // before. Recording it for a KNOWN repo is what retires a stale
        // candidate: a repo that deletes its package.json used to keep its
        // old candidate on the shelf forever while the same run reported it
        // `no-manifest`, and re-consumed the fetch budget every day because
        // the recorded `pushedAt` never advanced (D-3).
        //
        // A `fetch-failed` is a fact about the network and is never recorded:
        // the recorded entry and its old `pushedAt` stay, which schedules the
        // retry next run, and a repo never fetched at all stays out of the
        // state entirely so next run's `toFetch` picks it up again.
        if (result.code === 'no-manifest') {
          fresh.set(entry.repo, {
            candidates: [],
            failure: { code: result.code, detail: result.detail },
            ...(result.subpackageFailures !== undefined ? { subpackageFailures: result.subpackageFailures } : {}),
          })
        }
      }
    }
  }
  // Safe by CHECK, not by construction — the same shape searchByKeywords uses
  // for its coverage guards. Isolating one throwing repository is right;
  // isolating every one of them and publishing the result is how a total
  // failure becomes a green build with a catalog full of innocent names.
  if (thrown >= MIN_THROWN_TO_BOUND && thrown > queue.length * MAX_THROWN_FRACTION) {
    throw new Error(
      `github harvest: ${thrown} of ${queue.length} repositories threw, over the ${MIN_THROWN_TO_BOUND}-failure floor `
      + `and ${MAX_THROWN_FRACTION * 100}% share that separate a bad repository from a broken harvest. `
      + `Publishing this run would list none of them and blame each by name. First: ${thrownMessages[0] ?? '(none)'}`,
    )
  }
  const nextState = nextRepoState(state, seen, fresh)
  const candidates = Object.values(nextState).flatMap(entry => entry.candidates)
  const carried = Object.keys(nextState).length - fresh.size
  // Carried deterministic failures keep flowing into the report every run —
  // the catalog accounts for every pool member, fetched or carried.
  for (const [repo, entry] of Object.entries(nextState)) {
    if (fresh.has(repo)) continue
    if (entry.failure !== undefined) {
      failures.push({ repo, code: entry.failure.code, detail: entry.failure.detail })
    }
    if (entry.subpackageFailures !== undefined) failures.push(...entry.subpackageFailures)
  }
  return {
    candidates,
    failures,
    thrown,
    seen,
    gone,
    nextState,
    skipped: false,
    searchStars,
    windowCount,
    fetched: queue.length,
    carried,
    deferred: toFetch.length - queue.length,
  }
}
