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
import { FetchTimeoutError, fetchWithRetry, withTimeout } from './npm-client.ts'
import { diffRepoState, nextRepoState, type RepoSeen, type RepoState } from './repo-state.ts'
import { hasWorkspaceDeps, monorepoSignal, selectSubpackagePaths } from './subpackage-select.ts'
import type { RepoCandidate } from './types.ts'

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
 * could be produced. `no-manifest` means the repo exists but has no usable
 * `package.json` at the default branch — the repo is not an installable
 * plugin unit, an author-readable fact distinct from a transient failure.
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

/** Probe one query's `total_count` with a minimal page. */
export async function probeTotal(
  query: string,
  fetchImpl: typeof fetch,
  sleep: (ms: number) => Promise<void>,
  token: string | undefined,
): Promise<number> {
  const url = `${GITHUB_API}/search/repositories?q=${encodeURIComponent(query)}&per_page=1`
  const response = await searchRequest(url, fetchImpl, sleep, token)
  if (!response.ok) throw new Error(`github search probe for ${query} failed: ${response.status}`)
  const body = await readSearchBody(response, `github search probe for ${query}`)
  return typeof body.total_count === 'number' ? body.total_count : 0
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
): Promise<{ total_count?: unknown; items?: unknown }> {
  let parsed: unknown
  try {
    parsed = await response.json()
  } catch {
    // Same rule as npm's search: a 200 that is not JSON is a loud failure,
    // not a zero-result page.
    throw new Error(`${what} answered 200 with a body that is not JSON`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${what} answered 200 with a body that is not JSON: ${JSON.stringify(parsed)?.slice(0, 60) ?? typeof parsed}`)
  }
  return parsed as { total_count?: unknown; items?: unknown }
}

/** Fetch one page of a windowed search. */
async function searchPage(
  query: string,
  page: number,
  fetchImpl: typeof fetch,
  sleep: (ms: number) => Promise<void>,
  token: string | undefined,
): Promise<RepoMeta[]> {
  const url = `${GITHUB_API}/search/repositories?q=${encodeURIComponent(query)}&per_page=${SEARCH_PAGE_SIZE}&page=${page}`
  const response = await searchRequest(url, fetchImpl, sleep, token)
  if (!response.ok) throw new Error(`github search for ${query} failed: ${response.status}`)
  const body = await readSearchBody(response, `github search for ${query}`)
  const items = Array.isArray(body.items) ? body.items : []
  const metas: RepoMeta[] = []
  for (const item of items) {
    const meta = parseRepoMeta(item)
    if (meta !== null) metas.push(meta)
  }
  return metas
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
 * Partition one topic into mutually exclusive windows whose totals each fit
 * under {@link GITHUB_SEARCH_CAP}, so paging them enumerates the WHOLE pool.
 * Cascade: stars bucket → created-date bisection (day floor) → size bucket.
 * The probe counts every window once; the pool is ~13k repos concentrated in
 * recent days, and the stars split alone brings the worst day under the cap.
 */
export async function partitionTopic(
  topic: string,
  probe: (query: string) => Promise<number>,
): Promise<Window[]> {
  const windows: Window[] = []
  const expand = async (window: Window): Promise<void> => {
    const total = await probe(windowQuery(topic, window))
    if (total <= GITHUB_SEARCH_CAP) {
      windows.push(window)
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
    const windows = await partitionTopic(topic, query => probeTotal(query, fetchImpl, sleep, token))
    windowCount += windows.length
    for (const window of windows) {
      const query = windowQuery(topic, window)
      for (let page = 1; page <= MAX_SEARCH_PAGES; page += 1) {
        const metas = await searchPage(query, page, fetchImpl, sleep, token)
        for (const meta of metas) {
          if (!byName.has(meta.fullName)) byName.set(meta.fullName, meta)
        }
        if (metas.length < SEARCH_PAGE_SIZE) break
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
    const assetResponse = await fetchRobust(asset, fetchImpl, sleep, token, tarballTimeoutMs)
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
 * before any byte is read; a streamed body (no content-length) is pulled
 * through a reader and cancelled the moment the cap trips.
 */
async function readTarballBody(response: Response): Promise<Uint8Array | null> {
  const length = Number(response.headers.get('content-length'))
  if (Number.isFinite(length) && length > MAX_TARBALL_BYTES) return null
  const body = response.body
  if (body == null) {
    // No readable stream (or a fixture that only fakes `arrayBuffer`): the
    // content-length check above already bounded the body, so the one-shot
    // read cannot OOM — any failure just degrades the probe to null.
    try {
      return new Uint8Array(await response.arrayBuffer())
    } catch {
      return null
    }
  }
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_TARBALL_BYTES) {
        // Stop pulling the rest of the body: over the cap, refuse.
        await reader.cancel()
        return null
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
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
  const shown = typeof rawName === 'string'
    ? JSON.stringify(rawName.slice(0, 80))
    : `a ${typeof rawName}`
  return `package.json declares ${shown}, which is not a usable package name (an optional @scope/, then letters, digits, ".", "-" or "_", at most ${BUNDLE_NAME_MAX_LENGTH} characters), so dsh cannot register it.`
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
    return { ok: false, reason: 'too-large', detail: `package.json is larger than ${MAX_MANIFEST_BYTES} bytes, so it is not read.` }
  }
  let text: string
  try {
    text = await response.text()
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
  if (text.length > MAX_MANIFEST_BYTES) {
    // No content-length (a chunked response): the cap is applied to what
    // arrived rather than trusted from a header a third party wrote. The body
    // did reach us on this path, so the reason says discarded, not unread.
    return { ok: false, reason: 'too-large', detail: `package.json is larger than ${MAX_MANIFEST_BYTES} bytes, so it was discarded without being parsed.` }
  }
  try {
    return { ok: true, manifest: JSON.parse(text) }
  } catch {
    // A body that arrived but is not JSON is the same rejection as one that
    // could not be read: nothing else reaches here, and neither is a crash.
    return { ok: false, reason: 'unreadable', detail: 'package.json was unreadable.' }
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
): Promise<{ candidates: RepoCandidate[]; failures: RepoFetchFailure[]; anyClaimed: boolean }> {
  const treeUrl = `${GITHUB_API}/repos/${owner}/${slug}/git/trees/${meta.defaultBranch}?recursive=1`
  const treeResponse = await fetchRobust(treeUrl, fetchImpl, sleep, token, timeoutMs)
  if (!treeResponse.ok) return { candidates: [], failures: [], anyClaimed: false }
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
    return { candidates: [], failures: [], anyClaimed: false }
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
    const subUrl = `${RAW_GITHUB}/${owner}/${slug}/${meta.defaultBranch}/${dir}/package.json`
    const subResponse = await fetchRobust(subUrl, fetchImpl, sleep, token, timeoutMs)
    if (!subResponse.ok) continue
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
        failures.push({ repo: `${owner}/${slug}#${dir}`, code: 'no-manifest', detail: subRead.detail })
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
      failures.push({ repo: `${owner}/${slug}#${dir}`, code: 'no-manifest', detail: describeBadName(rawName) })
    }
  }
  return { candidates, failures, anyClaimed }
}

/**
 * Fetch one repository's manifest — and, for a monorepo root without a
 * bundle, its subpackage manifests — and project them into candidates.
 * @returns the candidates, or a code + author-readable reason.
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
  if (!manifestResponse.ok) {
    return { ok: false, code: 'no-manifest', detail: 'No package.json at the repository root, so there is nothing for dsh to install.' }
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
    const { candidates: subs, failures: subFailures, anyClaimed } = await probeSubpackageCandidates(owner, slug, meta, manifest, head, fetchImpl, sleep, token, timeoutMs)
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
}

/**
 * Harvest every repository candidate for the topics: partition the search,
 * diff against the recorded state, re-fetch only new or changed repos (up to
 * the budget), and carry the untouched candidates over.
 */
export async function harvestRepos(options: RepoHarvestOptions): Promise<RepoHarvestResult> {
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
        // A deterministic failure on a repo with NO recorded entry is
        // recorded so the next runs carry the reason instead of re-fetching
        // the same dead end and re-consuming the budget. A repo WITH a
        // recorded entry keeps its candidates: the old pushedAt mismatch
        // schedules the retry next run (a `fetch-failed` stays transient
        // either way).
        if (result.code === 'no-manifest' && state[entry.repo] === undefined) {
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
