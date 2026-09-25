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
import { compatibilityOf, FetchTimeoutError, fetchWithRetry, peerNamesOf, withTimeout } from './npm-client.ts'
import { canEverList } from './repo-gate.ts'
import { DECLARATIONS_RULE, diffRepoState, nextRepoState, type RepoSeen, type RepoState, type RepoStateEntry, type RepoToFetch } from './repo-state.ts'
import { hasWorkspaceDeps, monorepoSignal, selectSubpackagePaths } from './subpackage-select.ts'
import type { RepoCandidate } from './types.ts'
import { readCappedBody } from './http-body.ts'
import { treeInstallSize } from './tree-size.ts'
import { type PackedDeclarations, readPackedDeclarations, verifyReleaseAsset } from './release-asset.ts'

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
 * The largest release tarball the rescue probe will hold in memory. An
 * over-cap tarball is un-rescuable, same as an absent one: refusing it is a
 * decision WE make about an asset that answered, not a transport failure, so
 * the probe answers "no release" for it rather than throwing — and it must
 * refuse the body rather than OOM the build.
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
 * The largest git-tree JSON the sizing read will hold in memory.
 *
 * Bounded by GitHub's own truncation rather than by hope: a `recursive=1`
 * tree stops at 100,000 entries, and an entry serializes to roughly 200 bytes
 * of `path`/`mode`/`type`/`sha`/`size`/`url`, so a truncated-at-the-limit tree
 * lands near 20 MB. This sits above that and below the tarball reader's 32 MB,
 * and an over-cap body costs the size only — the entry still lists.
 *
 * Measured for scale, not for the cap: across 60 sampled repositories the
 * median tree held 62.7 kB of blobs and the largest 303 MB of blobs, but blob
 * BYTES are not body bytes — the body carries metadata per entry, and the
 * 303 MB repository held only 187 blobs.
 */
export const MAX_TREE_BYTES = 24 * 1024 * 1024

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
 * The deadline covers the body now (see withTimeout). This is the only path
 * that reads a body up to {@link MAX_TARBALL_BYTES} — 32 MB, or 32,768x a
 * manifest's cap — but no longer the only one that needs a raised deadline:
 * {@link TREE_REQUEST_TIMEOUT_MS} exists because the sizing read has the same
 * problem one size down. On the shared 30s bound a healthy 32 MB asset
 * would have to sustain 1.07 MB/s (8.5 Mbit/s) or be killed. At 300s the floor
 * is 109 KB/s (0.87 Mbit/s), far below any plausible runner-to-GitHub-CDN
 * throughput.
 *
 * A deadline that fires throws: the probe decides whether a rescued repository
 * is listed, so a killed download is a `fetch-failed` that keeps the recorded
 * rescue and retries next run, never a "no release" (see
 * `fetchLatestReleaseTarball`). That makes being wrong THIS way costly in a new
 * way: a bound too tight for a healthy asset fails its repository on every run
 * and counts each time toward the systematic-failure bound. The same deadline
 * bounds the declarations re-read's download of a recorded asset, where a kill
 * leaves the candidate unchanged and unstamped.
 */
export const TARBALL_REQUEST_TIMEOUT_MS = 300_000

/**
 * Per-attempt bound on the sizing tree read, for the same reason the tarball
 * download has one: {@link MAX_TREE_BYTES} admits 24 MB, and on the shared 30s
 * bound a healthy body that large would have to sustain 0.80 MB/s or be
 * killed — squarely inside the band the tarball comment computes as the
 * failure case. At 225s the floor is the same 109 KB/s that bound settled on
 * (24 MB / 225 s), which is far below any plausible runner-to-GitHub
 * throughput.
 *
 * Being wrong the cheap way here costs a decoration on one entry. Being wrong
 * the other way costs more than the tarball's equivalent: an aborted read
 * marks nothing, `fetchRobust` then retries four times with 2/4/8s backoff —
 * about 134s of wall clock per repository per run at REPO_CONCURRENCY 4 — and
 * `lacksSizeProbe` re-queues that repository on every future run, spending the
 * backfill budget on a read that can never settle.
 */
export const TREE_REQUEST_TIMEOUT_MS = 225_000

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
 * Whether a GitHub read waits out a 429 or a 5xx on fetchWithRetry's ladder
 * (`'ladder'`), or takes the first answer it gets (`'first-answer'`).
 *
 * Every read whose answer decides what is listed rides the ladder: a status
 * that says "not this time" is worth several waits there. Only the
 * declarations re-read takes the first answer. A failure there changes nothing
 * and is asked again next run, so a wait buys it nothing; and a read with no
 * status ladder ends within its own deadlines, which is what bounds how far
 * the re-read can overrun its time budget, since a read in flight cannot be
 * interrupted (see {@link DECLARATIONS_REREAD_TIME_BUDGET_MS_DEFAULT}).
 */
type StatusRetry = 'ladder' | 'first-answer'

/** The request init that sends `token` as a Bearer header, as fetchWithRetry builds it; none without one. */
function bearer(token: string | undefined): RequestInit | undefined {
  return token === undefined ? undefined : { headers: { Authorization: `Bearer ${token}` } }
}

/**
 * GitHub's API speaks HTTP/2 to undici, whose long-lived h2 connections can
 * die with a transient `UND_ERR_HEADERS_TIMEOUT` on the next request. A
 * bounded retry on network throws (4 attempts, doubling backoff 2/4/8s)
 * rides those out. This ladder is for THROWS only, so it does not compound
 * with fetchWithRetry's, which owns the statuses — a 429 or any 5xx is
 * returned rather than thrown, and is retried inside that call unless the
 * caller asks for the first answer ({@link StatusRetry}). Either way a throw
 * is retried: at four 30 s deadlines that costs at most 134 s with backoff.
 */
async function fetchRobust(
  url: string,
  fetchImpl: typeof fetch,
  sleep: (ms: number) => Promise<void>,
  token: string | undefined,
  timeoutMs: number = GITHUB_REQUEST_TIMEOUT_MS,
  statusRetry: StatusRetry = 'ladder',
): Promise<Response> {
  // The deadline wraps the impl INSIDE the retry ladder, so each of the four
  // attempts is bounded rather than the ladder multiplying undici's 300s
  // default by four.
  const timed = withTimeout(fetchImpl, timeoutMs, 'github')
  for (let attempt = 0; ; attempt += 1) {
    try {
      return statusRetry === 'ladder'
        ? await fetchWithRetry(url, timed, sleep, token)
        : await timed(url, bearer(token))
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
 * after a 30s pause. A 429 or a 5xx keeps fetchWithRetry's own budget; the
 * 403 is here because that one is a decision about the caller, which
 * fetchWithRetry deliberately does not retry.
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

/**
 * Fetch the default-branch head commit and its date for one repository.
 *
 * `null` means the endpoint ANSWERED that there is no such commit — a 404 for
 * a branch that moved or vanished, or a 200 carrying a body that is not a
 * commit. Both are facts about this repository and become a `fetch-failed`
 * row naming it.
 *
 * @throws on any other non-ok status, which is our transport failing and says
 *   nothing about the repository. This is the manifest read's rule applied
 *   one function over, and the reason is the one its comment already gives:
 *   the systematic-failure bound counts THROWS alone, so a returned row is
 *   invisible to it. Under an exhausted rate limit every repository in the
 *   queue answers 403 here, and returning null published thousands of "Could
 *   not resolve the head commit of <repo>" rows naming healthy repositories
 *   while the build went green — the outcome that bound exists to prevent,
 *   reached through the one path it could not observe. The sizing read made
 *   that reachable in practice by roughly doubling the per-repo core cost.
 */
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
  if (response.status === 404) return null
  if (!response.ok) {
    throw new Error(`github api returned ${response.status} resolving the head commit of ${owner}/${slug}`)
  }
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
 * The tarball is downloaded once here and hashed, and the HASH is the audit
 * story, not the URL: a `browser_download_url` names a tag and a file name, so
 * an asset deleted and re-uploaded under its old name serves different bytes
 * at the same URL. The recorded sha256 is what the host verifies at install,
 * and what the declarations re-read checks before it believes a byte.
 *
 * NOT advisory, and it throws rather than degrading. It used to return null on
 * any failure, on the reasoning that its fallback — the unchanged
 * `requires-build` rejection — was complete. It is complete only for a
 * repository with nothing recorded. For a recorded rescue this probe DECIDES
 * whether the entry is listed: the root it re-projects is `requires-build`,
 * `nextRepoState` swaps a fetched repository's candidates wholesale, and so a
 * null from one 403 or one dropped download replaced a verified rescue with a
 * root the gate rejects as "Declares a prepare/prepack build script ...
 * Publish to npm" — while the verified tarball was still there, and with
 * nothing to re-queue the repository until it pushed again. So every transport
 * failure throws now and lands in harvestRepos' catch with the others: a
 * `fetch-failed` row, nothing persisted, the recorded rescue standing, and a
 * retry next run. The cost is stated rather than hidden: a CI egress allowlist
 * that permits api.github.com and blocks the asset's redirect host now fails
 * every repository on this path, and enough of them trip the systematic-failure
 * bound and stop the build — where it used to delist every rescued entry and
 * go green.
 *
 * Three answers, not two, and `null` is now narrow. It is a DEFINITE "nothing
 * to rescue with": a 404 from `releases/latest` (no release), a release that
 * names no tarball asset, an asset past {@link MAX_TARBALL_BYTES} (a refusal we
 * make about an asset that answered), or a 404 for the asset itself.
 * `{ ok: false, detail }` is an asset that WAS there and did not hold up under
 * {@link verifyReleaseAsset} — that detail is published to the author and
 * persisted, so the rejection standing in the rescue's place can say why rather
 * than blaming a build script. `{ ok: true }` carries the pin, and the packed
 * manifest's own declaration inputs, because the entry installs THIS archive
 * and not the default branch the candidate was projected from.
 * @throws on every transport failure: a non-ok status other than 404 from
 *   either request (after its retry ladder), a request that throws, a body that
 *   fails mid-read, a deadline — and on a 200 that is not GitHub's release
 *   answer: a body that is not JSON, or JSON that is not an object with a string
 *   `tag_name` and an `assets` array.
 */
async function fetchLatestReleaseTarball(
  owner: string,
  slug: string,
  bundleName: string,
  fetchImpl: typeof fetch,
  sleep: (ms: number) => Promise<void>,
  token: string | undefined,
  timeoutMs: number = GITHUB_REQUEST_TIMEOUT_MS,
  tarballTimeoutMs: number = TARBALL_REQUEST_TIMEOUT_MS,
): Promise<
  | { ok: true; tag: string; url: string; sha256: string; installSize: number; declarations: PackedDeclarations }
  /** An asset existed and was refused; the detail reaches the author. */
  | { ok: false; detail: string }
  /** Nothing to rescue with, definitely — see above for the four ways. */
  | null
> {
  const url = `${GITHUB_API}/repos/${owner}/${slug}/releases/latest`
  const response = await fetchRobust(url, fetchImpl, sleep, token, timeoutMs)
  // GitHub's own answer that this repository has no published release, and
  // the only status here that says anything about the repository.
  if (response.status === 404) return null
  if (!response.ok) {
    throw new Error(`github api returned ${response.status} reading the latest release of ${owner}/${slug}`)
  }
  // Read, then parse — the discovery tree's two steps, for the same reason.
  // Reading is the transport and sits outside any catch: a deadline, a reset
  // mid-body (undici's `TypeError: terminated`) or any stream error propagates
  // as it is, never relabelled as a malformed body.
  const releaseText = await response.text()
  let parsed: unknown
  try {
    parsed = JSON.parse(releaseText)
  } catch {
    // Catches only the JSON syntax error, and throws in its place one that
    // names the request: bytes that arrived whole and are not GitHub's answer
    // — a proxy's error page wearing a 200 is the likely source. Answering "no
    // release" for them would durably drop a recorded rescue, the delisting
    // this probe throws on transport to avoid.
    throw new Error(`github api answered ${response.status} for the latest release of ${owner}/${slug} with a body that is not JSON`)
  }
  const body = parsed as { tag_name?: unknown; assets?: unknown } | null
  // Every release GitHub serves carries a string `tag_name` and an `assets`
  // array, empty or not. A 200 without both is not its release answer — a
  // proxy's JSON error object is the likely one — so it throws for the reason
  // above rather than reading as "no release". "Names no tarball asset", the
  // one null left in this body, is a release that says so.
  if (typeof body !== 'object' || body === null || Array.isArray(body)
    || typeof body.tag_name !== 'string' || !Array.isArray(body.assets)) {
    throw new Error(`github api answered ${response.status} for the latest release of ${owner}/${slug} with a body that is not a release object`)
  }
  const asset = body.assets
    .map(a => (a as { browser_download_url?: unknown } | null)?.browser_download_url)
    .find((u): u is string => typeof u === 'string' && /\.(?:tgz|tar\.gz)$/i.test(u))
  if (asset === undefined) return null
  const download = await downloadReleaseAsset(asset, fetchImpl, sleep, tarballTimeoutMs, 'ladder')
  if (download.outcome !== 'bytes') return null
  // The bytes are already in hand for the hash, so verifying that they ARE
  // this package costs nothing more. Until this check the rescue carried the
  // repo tree's name onto an asset nobody had opened.
  const verdict = verifyReleaseAsset(download.bytes, bundleName)
  if (!verdict.ok) return { ok: false, detail: verdict.detail }
  const sha256 = createHash('sha256').update(download.bytes).digest('hex')
  return {
    ok: true,
    tag: body.tag_name,
    url: asset,
    sha256,
    installSize: verdict.installSize,
    declarations: verdict.declarations,
  }
}

/** What one release-asset download answered, when it answered at all. */
type AssetDownload =
  | { outcome: 'bytes'; bytes: Uint8Array }
  /** A 404: there is no such asset. */
  | { outcome: 'not-found' }
  /** Past {@link MAX_TARBALL_BYTES}: a refusal of ours, see readTarballBody. */
  | { outcome: 'over-cap' }

/**
 * Download one release asset under the tarball deadline and body cap, as many
 * attempts as `statusRetry` allows.
 *
 * Shared by the rescue probe and the declarations re-read, so the one path
 * that reads up to 32 MB is bounded one way wherever it runs. Each caller
 * decides what a non-`bytes` outcome means: the probe reads both as "no
 * release"; the re-read reads both, like bytes that miss the pin, as the
 * recorded asset being gone, and unverifies the rescue for a full re-probe.
 *
 * It sends no token, to any URL, and there is no parameter to pass one: a
 * public release asset needs none, and the one rule that keeps the job's
 * GITHUB_TOKEN off every asset request lives here rather than at two call
 * sites. The re-read's URL comes from a file a pull request can edit, and
 * even the probe's — GitHub's own `browser_download_url` — redirects to a
 * separate asset host. Only requests to api.github.com and
 * raw.githubusercontent.com carry the token.
 *
 * The asset alone gets the larger bound: the metadata requests around it read
 * a few hundred bytes of GitHub's own JSON, and lending them 300s would hand a
 * stalled metadata call ten times the budget it needs.
 *
 * And it deliberately does NOT go through fetchRobust. That ladder retries a
 * throw four times with backoff, which is right for a few hundred bytes over a
 * flaky h2 connection and ruinous at 300s an attempt: a stalled asset host —
 * a CI egress allowlist that permits api.github.com and blocks the asset's
 * separate redirect host — cost 4 x 300s + 14s = 21 minutes per repository.
 * Against the committed state file of 2026-09-25, 441 of its 17,849
 * repositories reach this download (411 rescued, 30 whose asset was refused),
 * so a 2000-repository run puts ~49 on this path: ~250 minutes at
 * REPO_CONCURRENCY 4, twice the whole 120-minute job bound. One bounded attempt
 * costs at most 5 minutes, so the same total is ~62 — still the largest single
 * thing the full fetch can spend, and the place to put an aggregate budget if
 * it is ever seen for real. (The declarations re-read has one: see
 * DECLARATIONS_REREAD_TIME_BUDGET_MS_DEFAULT.)
 *
 * A failed download throws, and the repository behind it reaches harvestRepos'
 * catch. What that costs is the caller's `statusRetry`: `'first-answer'` puts
 * it there in one deadline, and `'ladder'` lets a 429 or a 5xx that answers
 * immediately ride fetchWithRetry's ladder first — which the PROBE does,
 * because it decides whether a changed repository's rescue is listed. The
 * re-read takes the first answer, so that one download in flight when its
 * time budget runs out is bounded by this deadline alone: it is what makes
 * that constant's arithmetic hold.
 * @param url - the asset URL, as the releases API or the checked recorded pin gives it.
 * @throws on any status but an ok one or a 404 (with the ladder, a 5xx after
 *   fetchWithRetry's retries), a request that throws, a body that fails
 *   mid-read, or a deadline.
 */
async function downloadReleaseAsset(
  url: string,
  fetchImpl: typeof fetch,
  sleep: (ms: number) => Promise<void>,
  tarballTimeoutMs: number,
  statusRetry: StatusRetry,
): Promise<AssetDownload> {
  const timed = withTimeout(fetchImpl, tarballTimeoutMs, 'github')
  // No token on either path, deliberately: see above. fetchWithRetry adds an
  // Authorization header to whatever URL it is given a token for, so it is
  // given `undefined`, and the single attempt is sent no init at all.
  const response = statusRetry === 'ladder'
    ? await fetchWithRetry(url, timed, sleep, undefined)
    : await timed(url)
  if (response.status === 404) return { outcome: 'not-found' }
  if (!response.ok) throw new Error(`github returned ${response.status} downloading the release asset ${url}`)
  const bytes = await readTarballBody(response)
  return bytes === null ? { outcome: 'over-cap' } : { outcome: 'bytes', bytes }
}

/**
 * Read an asset body with a hard cap, returning null when it exceeds
 * {@link MAX_TARBALL_BYTES}. An over-cap tarball is un-rescuable, same as an
 * absent one — a refusal we make, so it must refuse the body rather than hold
 * a giant asset in memory. A `content-length` over the cap is refused before
 * any byte is read; everything else is measured by {@link readCappedBody} as it
 * arrives, and a body that fails mid-read throws out of it, uncaught here.
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
    peerDependencies?: unknown
    peerDependenciesMeta?: unknown
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
  const candidate: RepoCandidate = {
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
  // `peers` (`[]` included), `compatibility` and the rule stamp, always and
  // together: a missing stamp is what queues a carried repository for a
  // re-read (repo-state.ts), and a stamp beside peers that were never read
  // would freeze them. `manifest` is this candidate's own — the subpackage's
  // for a subpackage, never the root's.
  writeDeclarations(candidate, m)
  return candidate
}

/**
 * Write one manifest's declarations onto a candidate: `peers` and
 * `compatibility`, each through the one reader it has on both channels, and
 * the {@link DECLARATIONS_RULE} stamp that says which rule wrote them.
 *
 * The one writer, and every place that writes a candidate's declarations goes
 * through it: the projection, a rescued root overwriting the ones its HEAD
 * projection wrote with its tarball's, and the manifest-only re-read. So the
 * stamp can never be written without the two fields, nor the fields without
 * the stamp, and the places that decide WHERE declarations come from cannot
 * drift in how they are read. `compatibility` is removed when nothing usable
 * survives — absent means "declares none", and leaving the previous source's
 * value would publish a declaration this manifest never made.
 * @param candidate - the candidate to write onto, mutated in place.
 * @param declarations - the manifest (or its three declaration inputs).
 */
function writeDeclarations(
  candidate: RepoCandidate,
  declarations: { peerDependencies?: unknown; peerDependenciesMeta?: unknown; dsh?: unknown },
): void {
  candidate.peers = peerNamesOf(declarations)
  const compatibility = compatibilityOf(declarations.dsh)
  if (compatibility === undefined) delete candidate.compatibility
  else candidate.compatibility = compatibility
  candidate.declarationsRule = DECLARATIONS_RULE
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
 * @throws whatever reading the body throws — a deadline, a connection reset
 *   mid-body, any stream error. Those are the transport failing, and
 *   `unreadable` is reserved for bytes that arrived whole and do not parse.
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
  // No catch, and that is the rule rather than an omission. `unreadable`
  // becomes a `no-manifest`, which harvestRepos PERSISTS in repo-state.json as
  // a dead end and publishes under the repository's name — so it may only ever
  // describe bytes that reached us. A read that throws never delivered them:
  // this used to rethrow a deadline alone and call everything else
  // "package.json was unreadable.", and a connection reset mid-body surfaces
  // from undici as a plain `TypeError: terminated`, not as a deadline. That
  // wrote a durable, false verdict for a repository whose manifest never
  // arrived. Every throw here now lands in harvestRepos' catch with the other
  // transport failures: sanitized, counted, and recorded nowhere.
  const bytes = await readCappedBody(response, MAX_MANIFEST_BYTES)
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
    // Swallows the one thing that can throw here, a JSON syntax error: the
    // bytes arrived whole and are not a manifest. That is the only
    // `unreadable` left — the author's to fix, and never a crash.
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
  // Read, then parse — two steps, because they have opposite failure policies
  // and one `.json()` call cannot tell them apart. Reading is the transport:
  // it is outside any catch, so a deadline, a connection reset mid-body or any
  // other stream error propagates. Swallowing one made a tree we never
  // received look like a monorepo with no subpackages, which silently dropped
  // every subpackage entry the repository had — and a root with no bundle of
  // its own then earned a persisted `no-manifest` saying it "declares no name
  // and no installable subpackage", false and durable. `.json()` used to be
  // guarded against a deadline alone, which is readManifest's old hole.
  const treeText = await treeResponse.text()
  let treeBody: { tree?: unknown } = {}
  try {
    const parsed = JSON.parse(treeText) as unknown
    if (parsed !== null && typeof parsed === 'object') treeBody = parsed as typeof treeBody
  } catch {
    // Swallows a JSON syntax error on a body that arrived whole — GitHub's own
    // answer, and one this probe can read nothing out of — so there are no
    // subpackages to find. Nothing else in this block can throw.
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
 * One repository's git tree at `sha`, parsed, or `undefined` when it cannot
 * be read. Feeds {@link treeInstallSize} and nothing else.
 *
 * Pinned to the commit, never to `meta.defaultBranch`: the branch can move
 * between the commit read and this one, and the published figure has to
 * describe the commit the entry installs. It is also what makes the number
 * cacheable — keyed to a commit, it stays valid until `pushedAt` changes, so
 * the daily run measures churned repositories only.
 */
type SizingRead =
  /**
   * The endpoint ANSWERED: a tree, a 404 saying this commit has none, or a
   * body past the cap. Whatever the body yields, the outcome is a property of
   * this commit and will not change without a push — so the candidates are
   * marked `sizeProbed` and never re-asked.
   */
  | { answered: true; body: unknown }
  /**
   * The body was past {@link MAX_TREE_BYTES}. Settled for now, so the repo is
   * marked and does not re-read a 24 MB body every run — but settled by OUR
   * constant rather than by the commit, so the cap that refused it is recorded
   * and a later raise re-queues exactly the repositories it had excluded.
   */
  | { answered: true; body: undefined; cappedAt: number }
  /**
   * The read failed in a way that says nothing about the repository. Nothing
   * is marked, so the next run retries it — the same rule that keeps a
   * transport failure out of the durable `no-manifest` record.
   */
  | { answered: false }

async function readSizingTree(
  fullName: string,
  sha: string,
  fetchImpl: typeof fetch,
  sleep: (ms: number) => Promise<void>,
  token: string | undefined,
  timeoutMs: number,
): Promise<SizingRead> {
  try {
    const response = await fetchRobust(
      `${GITHUB_API}/repos/${fullName}/git/trees/${sha}?recursive=1`, fetchImpl, sleep, token, timeoutMs,
    )
    // A 404 is a fact about this commit; any other non-ok status is our
    // transport failing, exactly as the discovery tree read reads them.
    if (response.status === 404) return { answered: true, body: undefined }
    if (!response.ok) return { answered: false }
    const bytes = await readCappedBody(response, MAX_TREE_BYTES)
    // NOT the same outcome as the 404 above, though both yield no size. A 404
    // and a `truncated: true` are properties of this commit and will not
    // change without a push; a body past the cap is a property of a constant
    // we chose. Recording them identically reintroduced one level down the
    // retroactivity hole `hasUnverifiedRelease` and `lacksSizeProbe` were
    // both written to close — raising the cap would have re-measured none of
    // the repositories it had excluded, and the only escape would have been
    // yet another one-shot invalidation marker.
    if (bytes === null) return { answered: true, body: undefined, cappedAt: MAX_TREE_BYTES }
    return { answered: true, body: JSON.parse(new TextDecoder().decode(bytes)) as unknown }
  } catch {
    // Swallows every way this read can fail — a deadline, a rate-limit 403, a
    // 5xx, a body that is not JSON. Named per the empty-catch rule: what is
    // lost is one entry's size, and nothing else can reach here, because the
    // candidates are already decided by the time this runs and the caller
    // returns them unchanged on this path.
    //
    // Deliberately NOT the failure policy of the subpackage-discovery tree
    // read, which throws on any non-404: there, a swallowed error makes a
    // monorepo look like it has no subpackages and earns its root a durable,
    // PUBLISHED "declares no name and no installable subpackage" that is
    // false. Here the same swallow costs a decoration. Propagating instead
    // would turn a rate-limited sizing read into a `fetch-failed` for a
    // repository whose manifest was read successfully — inventing a harvest
    // failure out of a missing nicety.
    return { answered: false }
  }
}

/**
 * Fetch one repository's candidates and attach each one's measured on-disk
 * size ({@link Entry.installSize}).
 *
 * The sizing read is a separate, best-effort request rather than a reuse of
 * the discovery tree, for two reasons that both matter: the discovery tree is
 * fetched at the BRANCH and only for a monorepo signal — a root that declares
 * its own bundle returns before it — and its failure policy is to throw.
 *
 * One tree sizes every candidate the repository produced: they all share the
 * pinned commit, and each is scoped by its own `subdir`.
 */
export async function fetchRepoCandidate(
  meta: RepoMeta,
  fetchImpl: typeof fetch = fetch,
  sleep: (ms: number) => Promise<void> = async (ms: number) => { await new Promise(resolve => setTimeout(resolve, ms)) },
  token: string | undefined = undefined,
  probeSubpackages = true,
  timeoutMs: number = GITHUB_REQUEST_TIMEOUT_MS,
  tarballTimeoutMs: number = TARBALL_REQUEST_TIMEOUT_MS,
  treeTimeoutMs: number = TREE_REQUEST_TIMEOUT_MS,
): Promise<RepoFetchResult> {
  const result = await projectRepoCandidates(
    meta, fetchImpl, sleep, token, probeSubpackages, timeoutMs, tarballTimeoutMs,
  )
  if (!result.ok) return result
  // A release-rescued candidate installs the TARBALL, not the repository at
  // this commit, so sizing it from the tree would measure a different
  // artifact than the one the entry installs — often a very different one,
  // since the archive holds what the author packed and the tree holds the
  // whole repository. Its figure comes from the archive `release-asset.ts`
  // already inflated to verify it.
  // Also skipped: a candidate `repo-gate` rejects unconditionally. Its size
  // could never reach an entry, and buying one costs a request, a persisted
  // figure and a marker — a third of the sizeable candidates in the recorded
  // state. `canEverList` is the shared predicate, and `lacksSizeProbe` asks
  // it too, so a skipped candidate is re-queued if a rule ever loosens.
  const sizeable = result.candidates.filter(
    candidate => candidate.release === undefined && canEverList(candidate),
  )
  const first = sizeable[0]
  if (first === undefined) return result
  // `treeTimeoutMs`, not `timeoutMs`: a 24 MB body cannot be read on the 30s
  // bound the metadata requests share. See TREE_REQUEST_TIMEOUT_MS.
  const read = await readSizingTree(meta.fullName, first.commit, fetchImpl, sleep, token, treeTimeoutMs)
  if (!read.answered) return result
  const cappedAt = 'cappedAt' in read ? read.cappedAt : undefined
  return {
    ...result,
    candidates: result.candidates.map(candidate => {
      // Release candidates were marked where their archive was measured.
      if (candidate.release !== undefined) return candidate
      // Neither measured nor marked, deliberately: see `canEverList`. The
      // ABSENCE of the marker is what re-queues it should the gate loosen.
      if (!canEverList(candidate)) return candidate
      const installSize = treeInstallSize(read.body, candidate.subdir)
      // `sizeProbed` whichever way it went. A tree that answered and yielded
      // nothing is settled for this commit, and leaving it unmarked would put
      // the repository in every future run's backfill queue.
      return {
        ...candidate,
        sizeProbed: true,
        ...(installSize !== undefined ? { installSize } : {}),
        ...(cappedAt !== undefined ? { sizeCappedAt: cappedAt } : {}),
      }
    }),
  }
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
async function projectRepoCandidates(
  meta: RepoMeta,
  fetchImpl: typeof fetch,
  sleep: (ms: number) => Promise<void>,
  token: string | undefined,
  probeSubpackages: boolean,
  timeoutMs: number,
  tarballTimeoutMs: number,
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
    // failure of the transport this module owns — a 5xx, or a CI egress
    // allowlist that permits api.github.com and not raw.githubusercontent.com,
    // the same shape fetchLatestReleaseTarball's comment gives for the asset
    // host — and `no-manifest` was
    // returned for all of them. fetchWithRetry RETURNS rather than throws
    // whatever it could not resolve, so a 500 or a 403 arrived here as an
    // ordinary response, harvestRepos PERSISTED it for every repository with
    // no recorded entry, and each was written off with "No package.json at
    // the repository root" until its `pushedAt` moved. A 5xx now spends that
    // function's retry ladder before it lands here, which makes this branch
    // rarer; it does not make it unreachable, and a non-secondary 403 still
    // arrives on the first answer.
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
  // Probed for EITHER objection the rescue can answer, not just the build
  // script. `workspace-deps` literally advises "attach a packed release
  // tarball", and a repo with `workspace:` deps and no prepare/prepack was
  // never probed at all — so an author who followed that advice and attached
  // a perfect tarball got no rescue and no explanation, permanently.
  if (root !== null && (root.requiresBuild || root.hasWorkspaceDeps)) {
    const release = await fetchLatestReleaseTarball(owner, slug, root.name, fetchImpl, sleep, token, timeoutMs, tarballTimeoutMs)
    if (release?.ok === true) {
      root.release = { tag: release.tag, url: release.url, sha256: release.sha256, assetVerified: true }
      // Measured from the archive the probe just inflated, and the reason the
      // sizing tree read skips a release candidate: this entry installs the
      // TARBALL, so the repository tree at this commit is a different
      // artifact — it holds everything the author did not pack.
      root.installSize = release.installSize
      // The archive IS this candidate's sizing probe — it never reaches the
      // tree read below. Without the marker it would queue for a re-probe in
      // every run, spending backfill budget on a repo already measured.
      root.sizeProbed = true
      // And what it requires is what the ARCHIVE declares, by the rule the two
      // lines above apply to its name and size. `projectCandidate` wrote HEAD's
      // declarations, and HEAD can be a different version: wyzh0117/dsh-notebook's
      // 0.2.3 requires nothing while the v0.1.0 tarball it installs requires
      // @deepseek-ai/dsh-client-runtime, and a HEAD-only `"dsh": ">=0.1.7-0"`
      // badged an old tarball "Incompatible" on 0.1.5-rc.3.
      writeDeclarations(root, release.declarations)
    } else if (release?.ok === false) {
      // An asset was there and did not hold up. The rescue does not apply, and
      // the standing rejection has to say that rather than blame the build
      // script the author would otherwise go and remove for nothing.
      root.releaseRejected = release.detail
    }
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
 * The most repositories one run re-reads for their declarations alone, when
 * {@link RepoHarvestOptions.rereadBudget} is unset.
 *
 * A budget of its own rather than a share of {@link REPO_BACKFILL_BUDGET_DEFAULT},
 * because the two queues cost different things. A full fetch is a head commit,
 * a manifest, a recursive sizing tree (bodies up to 24 MB), subpackage
 * discovery and, for a rescued root, a release probe plus the archive — the
 * backfill that sent every carried repository down that path for its `peers`
 * would have spent about 21.5k REST calls and 411 archive downloads to learn
 * facts that sit in one `package.json` at the recorded commit. A re-read is
 * that one raw request per listable candidate (a rescued root downloads its
 * recorded asset instead), with no REST call at all.
 *
 * The estimate this is sized from, against the committed repo-state.json of
 * 2026-09-25: 10,864 listable candidates in 10,629 repositories, none stamped,
 * 411 of them rescued. At 4,000 repositories a run the queue clears in three
 * runs (4,000 + 4,000 + 2,629) unless the time budget cuts a slice short, at
 * about 1.02 requests a repository, and the three slices hold 132, 213 and 66
 * rescued roots, each an asset download.
 *
 * This bounds how MANY repositories a run re-reads, not how long that takes.
 * A healthy slice should take minutes, but a stalled host holds each batch for
 * a whole deadline: against the same file a stalled asset host would have
 * held the first slice about 9.5 hours and the second about 14. Time is
 * bounded separately, by {@link DECLARATIONS_REREAD_TIME_BUDGET_MS_DEFAULT}
 * and the failure breaker beside it. It runs after the full fetches and never
 * takes their budget, so a quiet day's backfill cannot displace a repository
 * that pushed.
 */
export const DECLARATIONS_REREAD_BUDGET_DEFAULT = 4000

/**
 * The longest the declarations re-read may keep STARTING reads in one run,
 * when {@link RepoHarvestOptions.rereadTimeBudgetMs} is unset: 10 minutes.
 *
 * daily.yml bounds the build job at 120 minutes (`timeout-minutes`), and a job
 * that reaches it is killed and commits no state: the next run meets the same
 * slice, and the catalog stops publishing. So the budget, and the read still in
 * flight when it runs out, must fit in what the rest of the job leaves. Build
 * job durations, from each job's own start and end, over the last five
 * successful catalog runs — none of which ran this phase:
 *
 *   run               build job   GitHub half   repositories fetched in full
 *   2026-09-21          71m20s       33m10s       1,167
 *   2026-09-22          69m24s       32m48s       1,231
 *   2026-09-23          69m24s       33m13s       1,418
 *   2026-09-23 (push)   79m26s       32m01s       1,477
 *   2026-09-24          86m25s       32m00s       1,517
 *
 * The arithmetic, on the longest of them:
 *
 *   86m25s   the build job without this phase
 * + 10m      this budget, spent in full
 * +  5m      at most one batch in flight when it runs out
 * = 101m25s  18m35s inside the 120-minute bound.
 *
 * Why one batch in flight costs at most 5 minutes: the phase asks before
 * every read, not only every batch, so each repository in the last batch has
 * at most one read in flight, and they run side by side. And every re-read
 * request takes the first answer it gets ({@link StatusRetry}), so no read
 * rides a status ladder. The asset download is then one attempt, at most
 * TARBALL_REQUEST_TIMEOUT_MS: 300 s. The raw manifest read still retries a
 * THROW on fetchRobust's ladder, but four 30 s deadlines and 14 s of backoff
 * are 134 s, never the larger of the two.
 *
 * It was 15 minutes, 14 inside the bound on the same arithmetic — and that
 * held only while the read in flight had no status ladder. With one, a host
 * answering 5xx just as each deadline expired could hold one asset read
 * through six 300 s attempts and the backoff between them, over half an hour.
 * Taking the first answer bounds that read; the smaller budget buys back the
 * margin. (daily.yml's own header says the job "takes about 50 minutes": that
 * was written on 2026-09-04, before these runs.)
 *
 * What a healthy slice needs is INFERRED, NOT TIMED: no catalog run has timed
 * this phase. The GitHub half took 32 to 33 minutes on every run above whether
 * it fetched 1,167 repositories or 1,517, so the search's fixed 2 s pace sets
 * its length, and 88 more batches of full fetches, several requests each, do
 * not show in it. A slice is 1,000 batches of one request each. A slice the
 * budget does cut short defers its tail, which slows the stamp backfill and
 * costs the catalog nothing.
 *
 * A budget on STARTING reads, not a deadline on them: what is not started is
 * deferred and unchanged, and the stamp that queued it is still missing next
 * run.
 */
export const DECLARATIONS_REREAD_TIME_BUDGET_MS_DEFAULT = 10 * 60 * 1000

/**
 * Consecutive host failures after which the declarations re-read starts no
 * more reads: eight, two batches of {@link REPO_CONCURRENCY}.
 *
 * The time budget alone would let a failing host spend all of it for
 * nothing, since a failed read changes nothing: a stalled asset host holds
 * each batch for a 300 s deadline, a stalled raw host for fetchRobust's 134 s,
 * and a host answering 5xx at once would be sent every read in the slice. So
 * what the breaker counts is exactly those — reads that threw, or were
 * answered 429 or 5xx — and any read the host answered otherwise resets it,
 * whether the answer was usable or not.
 *
 * What it does not count matters as much, because the queue is served in
 * name order and every read that succeeds is stamped and leaves it. A record
 * that fails the same way on every run is therefore found at the HEAD of every
 * later run's queue, beside every other such record however far apart their
 * names — and once eight had gathered there, a breaker that counted them would
 * trip at the head of every run for good, and nothing behind them would be
 * read again. Those persistent failures are the answers a record gives — a
 * 404 or 403, a manifest that is unreadable or another package's, a pinned
 * archive that does not open — and the refusals made before any request (a
 * recorded URL or commit that fails its check). Each costs one prompt request
 * or none, and says nothing about a host: answers reset the count, as any
 * answer does, and refusals neither count nor reset.
 *
 * A host failure that recurs at the head — the asset host blocked outright,
 * say — still stops the phase there each run, and the time budget would too.
 * That clears when the host does, because it was never the record's.
 */
export const DECLARATIONS_REREAD_MAX_CONSECUTIVE_FAILURES = 8

/**
 * How many failed re-reads one run describes on stderr before it only counts
 * them: ten, then one line with the total. The breaker stops a host that
 * fails every read after eight, but not one that fails three reads in four —
 * each success resets it — nor the answers and refusals it does not count, and
 * any of those could print one line per candidate for most of a
 * 4,000-repository slice, most of them the same sentence. The counts in the
 * result carry the total; these lines are for diagnosing, and ten of them
 * diagnose.
 */
export const DECLARATIONS_REREAD_FAILURE_LINES = 10

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
   * Maximum repositories whose declarations are re-read this run — the pacing
   * knob for the stamp backfill, separate from {@link budget} and never
   * drawing on it. The rest defer to later runs. Defaults to
   * {@link DECLARATIONS_REREAD_BUDGET_DEFAULT}. A non-negative integer, or
   * {@link harvestRepos} throws: `.slice(0, NaN)` would read nothing and
   * `.slice(0, -1)` all but one, both in silence.
   */
  rereadBudget?: number
  /**
   * How long the declarations re-read may keep starting reads, in
   * milliseconds of {@link now}. Defaults to
   * {@link DECLARATIONS_REREAD_TIME_BUDGET_MS_DEFAULT}; a non-negative finite
   * number, or {@link harvestRepos} throws.
   */
  rereadTimeBudgetMs?: number
  /**
   * The clock the re-read's time budget is measured on. Defaults to
   * `Date.now`; a seam, so a test can spend a budget without waiting it out.
   * Only this phase reads it.
   */
  now?: () => number
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
   * Repositories whose declarations re-read this run STARTED — at most
   * {@link RepoHarvestOptions.rereadBudget}, fewer when the time budget or the
   * failure breaker stopped the phase ({@link rereadStopped}); not a success
   * count. Disjoint from {@link fetched}: a repository fetched in full is
   * re-projected and stamped by that fetch, so it is never also re-read.
   */
  rereadAttempted: number
  /** Candidates whose re-read succeeded: `peers`, `compatibility` and the
   * stamp written, and nothing else about them changed. */
  rereadUpdated: number
  /**
   * Candidates whose re-read failed, of every kind: a request that threw; on
   * the raw path any non-ok status (a 404 included) or a manifest that is
   * unreadable, over the cap or another package's; on the rescued path any
   * status but a 404, or a pinned archive that does not open as this
   * package; and on either path a record refused before any request — a
   * recorded commit that is not a sha, a recorded release URL that is not
   * this repository's own github.com download. (Only the throws and the raw
   * 429s and 5xx count toward the failure breaker; see
   * {@link DECLARATIONS_REREAD_MAX_CONSECUTIVE_FAILURES}.) Each is left
   * byte-identical and unstamped, so the next run asks again. Counted here
   * and NOWHERE else: never a failure record, never a published row, and
   * never part of {@link thrown}, because a failure that changes nothing is
   * not evidence of a harvest that would publish something wrong.
   */
  rereadFailed: number
  /**
   * Rescued candidates whose recorded release asset is no longer the verified
   * one — it answered 404, answered past the tarball cap, or no longer hashes
   * to its recorded sha256. Not a failure, a finding: the release loses
   * `assetVerified` and stays unstamped, so the next run sends the repository
   * through the full re-probe (`hasUnverifiedRelease`), where GitHub's own
   * releases answer decides.
   */
  rereadAssetChanged: number
  /**
   * Repositories queued for a re-read and not started this run: beyond
   * {@link RepoHarvestOptions.rereadBudget}, or left when the time budget or
   * the failure breaker stopped the phase. Deferring changes nothing.
   */
  rereadDeferred: number
  /**
   * Why the re-read stopped starting reads before its queue ran out, or null
   * when it did not: `'time-budget'` once
   * {@link RepoHarvestOptions.rereadTimeBudgetMs} was spent, `'failure-breaker'`
   * after {@link DECLARATIONS_REREAD_MAX_CONSECUTIVE_FAILURES} host failures in
   * a row. The second is the host failing rather than any one record, and worth
   * saying so in the build note.
   */
  rereadStopped: 'time-budget' | 'failure-breaker' | null
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
  // Before the first request, and outside the retry: a misconfigured budget is
  // not a transient failure, and a retry would only repeat it thirty seconds on.
  const { rereadBudget, rereadTimeBudgetMs } = options
  if (rereadBudget !== undefined && !(Number.isSafeInteger(rereadBudget) && rereadBudget >= 0)) {
    throw new Error(`harvestRepos: rereadBudget must be a non-negative integer; got ${String(rereadBudget)}`)
  }
  if (rereadTimeBudgetMs !== undefined && !(Number.isFinite(rereadTimeBudgetMs) && rereadTimeBudgetMs >= 0)) {
    throw new Error(`harvestRepos: rereadTimeBudgetMs must be a non-negative finite number; got ${String(rereadTimeBudgetMs)}`)
  }
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
 * re-fetch only new or changed repos (up to the budget), carry the untouched
 * candidates over, and re-read the declarations of carried ones whose stamp is
 * stale (up to the re-read budget).
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
    rereadBudget = DECLARATIONS_REREAD_BUDGET_DEFAULT,
    rereadTimeBudgetMs = DECLARATIONS_REREAD_TIME_BUDGET_MS_DEFAULT,
    now = Date.now,
  } = options
  if (token === undefined) {
    return {
      candidates: [], failures: [], thrown: 0, seen: [], gone: [], nextState: state, skipped: true,
      searchStars: new Map(), windowCount: 0, fetched: 0, carried: 0, deferred: 0,
      rereadAttempted: 0, rereadUpdated: 0, rereadFailed: 0, rereadAssetChanged: 0, rereadDeferred: 0,
      rereadStopped: null,
    }
  }
  const { seen, metas, windowCount } = await searchReposByTopic(fetchImpl, sleep, token)
  const searchStars = new Map<string, number>()
  for (const [repo, meta] of metas) {
    if (meta.stars !== null) searchStars.set(repo, meta.stars)
  }
  const { toFetch, toReread, gone } = diffRepoState(state, seen, MAX_TREE_BYTES)
  // Budget slice: sorted order keeps the deferral deterministic, and CHANGED
  // repositories are served before the backfill.
  //
  // Sorting the two together by name was safe only while a backfill was
  // smaller than one run. `lacksSizeProbe` queued 13,443 recorded
  // repositories at once against a budget of 2,000, so for about seven
  // consecutive runs an alphabetically-late repository that published a fix,
  // deleted its package.json or renamed its bundle would not have been
  // fetched at all — displaced by unchanged repositories being re-measured
  // for a decoration. The precedent this borrowed from is not comparable:
  // `hasUnverifiedRelease` matched 332 candidates, which fits inside a single
  // run; this was forty times that.
  //
  // Ordering rather than a second budget, deliberately: a separate cap would
  // leave the backfill idle on a quiet day, and its own bound would have to
  // be tuned against a queue that shrinks every run. Changed-first needs no
  // tuning and cannot starve either side — the backfill spends exactly what
  // the day's changes left over, and is still bounded and self-terminating.
  const byName = (a: RepoToFetch, b: RepoToFetch) => (a.repo < b.repo ? -1 : a.repo > b.repo ? 1 : 0)
  const queue = [
    ...toFetch.filter(entry => !entry.backfillOnly).sort(byName),
    ...toFetch.filter(entry => entry.backfillOnly).sort(byName),
  ].slice(0, budget)
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
  // The declarations re-read, after every full fetch and after the bound: it
  // cannot trip that bound (its failures change nothing, so they are not
  // evidence of a harvest about to publish something wrong), and a run the
  // bound stops has no state to update. The queue is disjoint from the one
  // above by construction — a full fetch stamps what it projects — and has a
  // budget of its own. That is not the second budget the comment above argues
  // against: this queue never competes with a changed repository for anything,
  // so there is nothing to order; the budget exists because a re-read costs
  // one raw request where a full fetch costs several REST calls and a sizing
  // tree, and its one-time backlog is measured on
  // DECLARATIONS_REREAD_BUDGET_DEFAULT.
  const rereadQueue = [...toReread].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).slice(0, rereadBudget)
  const reread = await rereadDeclarations(
    nextRepoState(state, seen, fresh),
    rereadQueue,
    { fetchImpl, sleep, token, timeoutMs, tarballTimeoutMs },
    rereadTimeBudgetMs,
    now,
  )
  const nextState = reread.state
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
    rereadAttempted: reread.attempted,
    rereadUpdated: reread.updated,
    rereadFailed: reread.failed,
    rereadAssetChanged: reread.assetChanged,
    // Beyond the count budget, and whatever a time budget or the breaker left
    // unstarted: `attempted` counts only the repositories a batch began.
    rereadDeferred: toReread.length - reread.attempted,
    rereadStopped: reread.stopped,
  }
}

/** What one carried candidate's declarations re-read came to. */
type RereadOutcome =
  /** Read: the candidate with `peers`, `compatibility` and the stamp written. */
  | { outcome: 'updated'; candidate: RepoCandidate }
  /** The recorded asset is no longer the verified one: the candidate unverified. */
  | { outcome: 'asset-changed'; candidate: RepoCandidate; reason: string }
  /**
   * The host failed to answer: the request threw (on the raw path, after
   * fetchRobust's retries), or was answered 429 or 5xx — the statuses
   * fetchWithRetry treats as "not this time", which the re-read takes as its
   * answer rather than waiting out ({@link StatusRetry}). The candidate stays
   * exactly as recorded.
   */
  | { outcome: 'failed'; reason: string }
  /**
   * The host answered, and the answer is no use to this record: any other
   * non-ok status, or bytes that are not this candidate's manifest. A fact
   * about the record, so the same record answers it again next run. The
   * candidate stays exactly as recorded.
   */
  | { outcome: 'unusable'; reason: string }
  /** Refused before any request: the candidate stays exactly as recorded. */
  | { outcome: 'refused'; reason: string }

/** The harvest's transport, as every re-read uses it. */
interface RereadTransport {
  fetchImpl: typeof fetch
  sleep: (ms: number) => Promise<void>
  token: string | undefined
  timeoutMs: number
  tarballTimeoutMs: number
}

/**
 * The recorded release URL, parsed, when it is one this repository's own
 * GitHub release could have produced — or null for anything else.
 *
 * `release.url` is read back from repo-state.json, and that file is not only
 * this build's output: a pull request can edit it, and daily.yml runs the
 * build on `pull_request` with the job's GITHUB_TOKEN, with every recorded
 * rescue queued for a re-read. The probe only ever records GitHub's own
 * `browser_download_url`, which is always
 * `https://github.com/<owner>/<repo>/releases/download/…`, so anything else in
 * the file was not written by the probe and is not requested at all. Parsed,
 * never matched as a string: a string test is what
 * `https://github.com@evil.example/` and `https://github.com.evil.example/`
 * exist to pass. Even an accepted URL is sent no token — downloadReleaseAsset
 * never sends one.
 *
 * A trailing dot on the host is normalized away, since `github.com.` is the
 * same host written fully qualified. No port and no credentials, because the
 * probe's URL never carries either. Owner and name compare case-insensitively
 * against the state key, as GitHub resolves them.
 * @param raw - the recorded URL, untrusted.
 * @param owner - the state key's owner.
 * @param slug - the state key's repository name.
 */
function recordedReleaseUrl(raw: string, owner: string, slug: string): URL | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    // Swallows the TypeError `new URL` throws for a string that is no URL at
    // all. There is nothing to request, which is the refusal the caller counts.
    return null
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.port !== '') return null
  if (url.hostname.toLowerCase().replace(/[.]$/, '') !== 'github.com') return null
  const [root, urlOwner, urlSlug, releases, download, ...asset] = url.pathname.split('/')
  if (root !== '' || urlOwner === undefined || urlSlug === undefined) return null
  if (urlOwner.toLowerCase() !== owner.toLowerCase() || urlSlug.toLowerCase() !== slug.toLowerCase()) return null
  if (releases !== 'releases' || download !== 'download' || asset.join('/') === '') return null
  return url
}

/**
 * Re-read one carried candidate's declarations from what the entry installs,
 * and from nothing else: the manifest at the RECORDED commit and subdir — never
 * the branch, which may have moved — or, for a rescued root, the recorded
 * release asset, checked against its recorded sha256 before a byte of it is
 * believed.
 *
 * The candidate's own facts decide the path, because they are all the entry
 * installs: `commit` for a commit-pinned entry, `release.url` + `sha256` for a
 * rescued one. Nothing else is re-asked — not the head commit, not the size,
 * not whether the release still verifies under today's rules, not whether the
 * repository still has the same subpackages — so nothing else can change.
 *
 * Never throws, and three answers leave the candidate exactly as recorded,
 * unstamped, for the next run to ask again; they differ only in what the
 * phase's failure breaker makes of them. `refused` is a record whose pin fails
 * its check before any request: a commit that is not a sha, a release URL
 * that is not this repository's own github.com download. `failed` is the host
 * failing — a throw, or on the raw path a 429 or 5xx, taken as the first
 * answer: neither request here rides a status ladder ({@link StatusRetry}).
 * On the rescued path downloadReleaseAsset throws for every status but a 404,
 * so any other status is `failed` there too; a public release asset has no
 * status of the record's own to answer. `unusable` is an
 * answer that cannot be used: on the raw path any other non-ok status, a 404
 * included, or an unreadable, over-cap or foreign manifest; on the rescued
 * path a pinned archive that does not open as this package.
 *
 * A raw 404 is not a verdict here, where it is one on the full fetch, because
 * the full fetch read this manifest at the default branch and took the commit
 * from a separate request: the two name the same file unless a push landed
 * between those requests, and a push moves `pushedAt`, which sends the
 * repository to the full fetch instead of here. So a 404 at the recorded
 * commit says the read went wrong, not that the manifest is gone.
 *
 * On the rescued path a 404, an answer past the cap and bytes that miss the pin
 * are all `asset-changed` instead: definite answers that the verified asset is
 * gone from its URL, which unverify the rescue so the full re-probe can ask
 * GitHub's releases API what stands there now.
 * @param owner - the repository owner, from the state key.
 * @param slug - the repository name, from the state key.
 * @param candidate - a carried, listable candidate whose stamp is stale.
 */
async function rereadCandidate(
  owner: string,
  slug: string,
  candidate: RepoCandidate,
  transport: RereadTransport,
): Promise<RereadOutcome> {
  const { fetchImpl, sleep, token, timeoutMs, tarballTimeoutMs } = transport
  const release = candidate.release
  // Both pins are checked before any request, and a record that fails one is
  // not read at all: the URL could send a request anywhere, and a commit that
  // is not a sha — `main`, say — would read some other ref than the one the
  // entry installs.
  const assetUrl = release === undefined ? null : recordedReleaseUrl(release.url, owner, slug)
  if (release !== undefined && assetUrl === null) {
    return { outcome: 'refused', reason: `the recorded release URL is not a https://github.com/${owner}/${slug}/releases/download/ URL, so it was not requested` }
  }
  if (release === undefined && !/^[0-9a-f]{40}$/.test(candidate.commit)) {
    return { outcome: 'refused', reason: 'the recorded commit is not a 40-character sha, so it pins nothing to read' }
  }
  try {
    if (release !== undefined && assetUrl !== null) {
      // The parsed URL's own spelling, so what is requested is exactly what was
      // checked — no second parser gets a say.
      const download = await downloadReleaseAsset(assetUrl.href, fetchImpl, sleep, tarballTimeoutMs, 'first-answer')
      // Three definite answers that the verified bytes are not what this URL
      // serves now — deleted, grown past a cap they passed, or different.
      if (download.outcome === 'not-found') return unverified(candidate, release, 'the recorded release asset answered 404')
      if (download.outcome === 'over-cap') {
        return unverified(candidate, release, `the recorded release asset answered past the ${MAX_TARBALL_BYTES}-byte cap it was verified under`)
      }
      if (createHash('sha256').update(download.bytes).digest('hex') !== release.sha256) {
        return unverified(candidate, release, 'the recorded release asset no longer hashes to its recorded sha256')
      }
      const read = readPackedDeclarations(download.bytes, candidate.name)
      // The pinned bytes, so the same bytes next run, and the same answer.
      if (!read.ok) return { outcome: 'unusable', reason: read.detail }
      const updated: RepoCandidate = { ...candidate }
      writeDeclarations(updated, read.declarations)
      return { outcome: 'updated', candidate: updated }
    }
    const path = candidate.subdir === undefined ? 'package.json' : `${candidate.subdir}/package.json`
    const rawUrl = `${RAW_GITHUB}/${owner}/${slug}/${candidate.commit}/${path}`
    const response = await fetchRobust(rawUrl, fetchImpl, sleep, token, timeoutMs, 'first-answer')
    if (!response.ok) {
      // The line fetchWithRetry draws: what it retries is the host unable to
      // answer this time, and anything else is an answer.
      const hostFailed = response.status === 429 || response.status >= 500
      return { outcome: hostFailed ? 'failed' : 'unusable', reason: `github raw returned ${response.status}` }
    }
    const read = await readManifest(response)
    if (!read.ok) return { outcome: 'unusable', reason: read.detail }
    const manifest = read.manifest as { name?: unknown; peerDependencies?: unknown; peerDependenciesMeta?: unknown; dsh?: unknown } | null
    // The name decides whether these are this candidate's declarations, and it
    // decides every manifest that is not an object as well: `null` has no name
    // through the optional chain, and an array or a primitive has none that can
    // equal a bundle name. The candidate was projected from the manifest at
    // this path on the default branch, read moments before its commit was
    // resolved — the same file unless a push landed between the two requests,
    // and a push routes the repository to the full fetch. So a name that
    // differs means the read reached something else, and its declarations
    // would describe a package this entry does not install.
    if (manifest?.name !== candidate.name) {
      return { outcome: 'unusable', reason: 'the manifest at the recorded commit names a different package' }
    }
    const updated: RepoCandidate = { ...candidate }
    writeDeclarations(updated, manifest)
    return { outcome: 'updated', candidate: updated }
  } catch (error) {
    // Swallows every way a read can throw — a stalled or reset request, a body
    // that fails mid-read, a deadline — because each is the transport and none
    // may change the record: the caller keeps the candidate exactly as it was,
    // and the missing stamp re-queues it. The message reaches stderr through
    // the caller, within its line cap.
    return { outcome: 'failed', reason: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * A rescued candidate whose verified asset is gone from its URL, unverified —
 * the one change such an answer makes. Only `assetVerified` goes, which sends
 * the repository through the full re-probe next run (`hasUnverifiedRelease`),
 * where GitHub's releases answer decides what stands; the declarations are not
 * stamped, because the archive they would describe is gone.
 */
function unverified(
  candidate: RepoCandidate,
  release: NonNullable<RepoCandidate['release']>,
  reason: string,
): RereadOutcome {
  const { assetVerified: _unverified, ...rest } = release
  return { outcome: 'asset-changed', candidate: { ...candidate, release: rest }, reason }
}

/**
 * One run's re-read phase: what it has settled, and whether it may still
 * start a read. Shared by every repository in flight, so the time budget and
 * the failure breaker see the whole phase rather than one batch.
 */
interface RereadPhase {
  /** Whether a read may start now; once it says no, it says no for good. */
  mayStart(): boolean
  /** Count one read's outcome, and describe it on stderr within the cap. */
  settle(unit: string, result: RereadOutcome): void
  readonly stopped: 'time-budget' | 'failure-breaker' | null
  readonly updated: number
  readonly failed: number
  readonly assetChanged: number
}

/**
 * Open a re-read phase that may start reads until `timeBudgetMs` of `now` is
 * spent, or until {@link DECLARATIONS_REREAD_MAX_CONSECUTIVE_FAILURES} reads in
 * a row have failed at the host — whichever comes first.
 */
function rereadPhase(timeBudgetMs: number, now: () => number): RereadPhase {
  const startedAt = now()
  let stopped: RereadPhase['stopped'] = null
  let consecutiveFailures = 0
  let updated = 0
  let failed = 0
  let assetChanged = 0
  return {
    mayStart() {
      if (stopped !== null) return false
      if (now() - startedAt >= timeBudgetMs) stopped = 'time-budget'
      else if (consecutiveFailures >= DECLARATIONS_REREAD_MAX_CONSECUTIVE_FAILURES) stopped = 'failure-breaker'
      return stopped === null
    },
    settle(unit, result) {
      switch (result.outcome) {
        case 'updated':
          updated += 1
          consecutiveFailures = 0
          return
        case 'asset-changed':
          // An answer, and a definite one: the host is up, whatever it said.
          assetChanged += 1
          consecutiveFailures = 0
          process.stderr.write(`github: re-reading ${unit}: ${result.reason}, so the rescue is unverified for a full re-probe\n`)
          return
        case 'failed':
          consecutiveFailures += 1
          break
        case 'unusable':
          // An answer, if a useless one: the host is up. And never counted, for
          // the reason DECLARATIONS_REREAD_MAX_CONSECUTIVE_FAILURES gives.
          consecutiveFailures = 0
          break
        case 'refused':
          // Neither counts nor resets: see DECLARATIONS_REREAD_MAX_CONSECUTIVE_FAILURES.
          break
      }
      failed += 1
      // A diagnostic for whoever reads the build, never a row: the entry is
      // unchanged, so there is nothing to say about the repository.
      if (failed <= DECLARATIONS_REREAD_FAILURE_LINES) {
        process.stderr.write(`github: re-reading the declarations of ${unit} failed, left as recorded for the next run: ${result.reason}\n`)
      }
    },
    get stopped() { return stopped },
    get updated() { return updated },
    get failed() { return failed },
    get assetChanged() { return assetChanged },
  }
}

/**
 * Re-read one recorded repository's stale declarations, candidate by
 * candidate, and hand back the entry to record — the recorded object itself
 * when nothing moved, so a repository whose every re-read failed is not merely
 * equal to what was recorded but identical to it.
 *
 * Only listable candidates whose stamp is stale are read, by the predicate the
 * diff queued the repository on; the rest, a candidate that can never list
 * included, are carried as they are. No candidate is added, removed or renamed
 * and no failure record is written: a re-read can only ever refine a record.
 *
 * Every read after the repository's first asks the phase first. A monorepo's
 * stale subpackages are read one after another — eight in one queued
 * repository today — so a check between batches alone would let a single
 * batch overrun the time budget by that many deadlines. A candidate the phase
 * no longer allows is left exactly as recorded, like a deferred repository.
 * @param repo - the state key, `owner/slug`.
 */
async function rereadEntry(
  repo: string,
  entry: RepoStateEntry,
  transport: RereadTransport,
  phase: RereadPhase,
): Promise<RepoStateEntry> {
  const [owner, slug] = repo.split('/')
  let reads = 0
  let changed = false
  const candidates: RepoCandidate[] = []
  for (const candidate of entry.candidates) {
    if (!canEverList(candidate) || candidate.declarationsRule === DECLARATIONS_RULE || (reads > 0 && !phase.mayStart())) {
      candidates.push(candidate)
      continue
    }
    reads += 1
    const unit = candidate.subdir === undefined ? repo : `${repo}#${candidate.subdir}`
    const result: RereadOutcome = owner === undefined || slug === undefined
      ? { outcome: 'refused', reason: `unusable repository name ${repo}` }
      : await rereadCandidate(owner, slug, candidate, transport)
    phase.settle(unit, result)
    if (result.outcome === 'updated' || result.outcome === 'asset-changed') {
      changed = true
      candidates.push(result.candidate)
    } else {
      candidates.push(candidate)
    }
  }
  return changed ? { ...entry, candidates } : entry
}

/**
 * Serve the declarations re-read queue against the state this run is about to
 * record, {@link REPO_CONCURRENCY} repositories at a time, and hand back that
 * state with each re-read entry in place.
 *
 * Bounded three ways: the queue arrives cut to the count budget, a batch starts
 * only while the phase allows it (`timeBudgetMs` of `now`, and the failure
 * breaker), and so does every read after a repository's first. What is not
 * started is deferred and unchanged, which is all R9 asks of a deferral: the
 * missing stamp queues it again next run.
 *
 * The input state is never mutated — harvestRepos retries a whole attempt
 * with the SAME options, and a first attempt that had written into them would
 * hand the second a different start.
 * @param state - the next state as the full fetches left it.
 * @param queue - repositories to re-read, already sorted and budgeted.
 * @returns the state to record, and how many repositories a batch started.
 */
async function rereadDeclarations(
  state: RepoState,
  queue: readonly string[],
  transport: RereadTransport,
  timeBudgetMs: number,
  now: () => number,
): Promise<{
  state: RepoState
  attempted: number
  updated: number
  failed: number
  assetChanged: number
  stopped: 'time-budget' | 'failure-breaker' | null
}> {
  const next: RepoState = { ...state }
  const phase = rereadPhase(timeBudgetMs, now)
  let attempted = 0
  for (let i = 0; i < queue.length; i += REPO_CONCURRENCY) {
    if (!phase.mayStart()) break
    const batch = queue.slice(i, i + REPO_CONCURRENCY)
    attempted += batch.length
    const results = await Promise.all(batch.map(async repo => {
      // hasOwn: the key is a repository name the search returned.
      const entry = Object.hasOwn(state, repo) ? state[repo] : undefined
      if (entry === undefined) return undefined
      return { repo, entry: await rereadEntry(repo, entry, transport, phase) }
    }))
    for (const result of results) {
      if (result !== undefined) next[result.repo] = result.entry
    }
  }
  if (phase.failed > DECLARATIONS_REREAD_FAILURE_LINES) {
    process.stderr.write(`github: ${phase.failed} declaration re-reads failed this run and were left as recorded; the first ${DECLARATIONS_REREAD_FAILURE_LINES} are above\n`)
  }
  if (phase.stopped !== null) {
    const why = phase.stopped === 'time-budget'
      ? `its ${timeBudgetMs} ms budget was spent`
      : `the host failed ${DECLARATIONS_REREAD_MAX_CONSECUTIVE_FAILURES} reads in a row`
    process.stderr.write(`github: the declarations re-read stopped after ${attempted} of ${queue.length} repositories because ${why}; the rest are deferred, unchanged, to the next run\n`)
  }
  return {
    state: next,
    attempted,
    updated: phase.updated,
    failed: phase.failed,
    assetChanged: phase.assetChanged,
    stopped: phase.stopped,
  }
}
