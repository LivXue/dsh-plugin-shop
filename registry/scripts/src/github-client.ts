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
import { fetchWithRetry } from './npm-client.ts'
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
): Promise<Response> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fetchWithRetry(url, fetchImpl, sleep, token)
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
 * plugin unit, an author-readable fact distinct from a transient failure. */
export type RepoFetchResult =
  | { ok: true; candidates: RepoCandidate[] }
  | { ok: false; code: RepoFetchFailure['code']; detail: string }

/** One repository that could not become a candidate, with the reason. */
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
  const body = await response.json() as { total_count?: unknown }
  return typeof body.total_count === 'number' ? body.total_count : 0
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
  const body = await response.json() as { items?: unknown }
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
): Promise<{ sha: string; date: string } | null> {
  const url = `${GITHUB_API}/repos/${owner}/${slug}/commits/${branch}`
  const response = await fetchRobust(url, fetchImpl, sleep, token)
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
 * tarball asset, or the probe could not be read.
 */
async function fetchLatestReleaseTarball(
  owner: string,
  slug: string,
  fetchImpl: typeof fetch,
  sleep: (ms: number) => Promise<void>,
  token: string | undefined,
): Promise<{ tag: string; url: string; sha256: string } | null> {
  // The whole probe is advisory, so no failure inside it may crash the
  // harvest: every transport or read failure degrades to null, the
  // stars-sidecar rule ("any failure publishes without stars; the step
  // never throws").
  try {
    const url = `${GITHUB_API}/repos/${owner}/${slug}/releases/latest`
    const response = await fetchRobust(url, fetchImpl, sleep, token)
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
    const assetResponse = await fetchRobust(asset, fetchImpl, sleep, token)
    if (!assetResponse.ok) return null
    const bytes = new Uint8Array(await assetResponse.arrayBuffer())
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    return { tag: body.tag_name, url: asset, sha256 }
  } catch {
    // Swallows the transport failures every null-returning path above leaves
    // open: the releases call, and the asset download — the largest body read
    // in this file — whose stream can drop after the headers arrived. The
    // probe has nothing load-bearing; a permanent failure, say a CI egress
    // allowlist that permits api.github.com but blocks the asset redirect
    // host, must leave the unchanged `requires-build` rejection standing
    // rather than take the whole daily catalog down.
    return null
  }
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
  const m = manifest as {
    name?: unknown
    description?: unknown
    scripts?: { prepare?: unknown; prepack?: unknown }
    dsh?: { bundle?: unknown; catalog?: unknown }
  }
  const scripts = typeof m.scripts === 'object' && m.scripts !== null ? m.scripts : {}
  if (typeof m.name !== 'string' || m.name === '') return null
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
 * Probe a monorepo's subpackages: list the tree once, select the candidate
 * directories (pure `selectSubpackagePaths`), and project the manifests
 * that declare a bundle. Bundle-less subpackages are not plugin candidates —
 * rejecting each one would drown the report in noise the author already
 * knows; the repo-level `no-bundle` rejection covers the case where none
 * qualify. Only the `hasBundle` filter is applied here; the gate remains
 * the sole policy authority for every candidate it receives.
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
): Promise<RepoCandidate[]> {
  const treeUrl = `${GITHUB_API}/repos/${owner}/${slug}/git/trees/${meta.defaultBranch}?recursive=1`
  const treeResponse = await fetchRobust(treeUrl, fetchImpl, sleep, token)
  if (!treeResponse.ok) return []
  let treeBody: { tree?: unknown } = {}
  try {
    const parsed = await treeResponse.json() as unknown
    if (parsed !== null && typeof parsed === 'object') treeBody = parsed as typeof treeBody
  } catch {
    return []
  }
  // A truncated tree (>100k entries) may hide some subpackages; the repo is
  // re-probed when it changes, and the loss costs only a later re-probe —
  // unlike the search cap, this truncation is not pool-wide.
  const paths = Array.isArray(treeBody.tree)
    ? treeBody.tree.map(entry => (entry as { path?: unknown }).path).filter((p): p is string => typeof p === 'string')
    : []
  const dirs = selectSubpackagePaths(rootManifest, paths)
  const candidates: RepoCandidate[] = []
  for (const dir of dirs) {
    const subUrl = `${RAW_GITHUB}/${owner}/${slug}/${meta.defaultBranch}/${dir}/package.json`
    const subResponse = await fetchRobust(subUrl, fetchImpl, sleep, token)
    if (!subResponse.ok) continue
    let subManifest: unknown
    try {
      subManifest = await subResponse.json()
    } catch {
      continue
    }
    const sub = projectCandidate(meta, subManifest, head, dir)
    if (sub !== null && sub.hasBundle) candidates.push(sub)
  }
  return candidates
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
): Promise<RepoFetchResult> {
  const [owner, slug] = meta.fullName.split('/')
  if (owner === undefined || slug === undefined) {
    return { ok: false, code: 'fetch-failed', detail: `unusable repository name ${meta.fullName}` }
  }

  const rawUrl = `${RAW_GITHUB}/${owner}/${slug}/${meta.defaultBranch}/package.json`
  const manifestResponse = await fetchRobust(rawUrl, fetchImpl, sleep, token)
  if (!manifestResponse.ok) {
    return { ok: false, code: 'no-manifest', detail: 'No package.json at the repository root, so there is nothing for dsh to install.' }
  }
  let manifest: unknown
  try {
    manifest = await manifestResponse.json()
  } catch {
    // Same rule as npm: an unreadable body is a rejection, not a crash.
    return { ok: false, code: 'no-manifest', detail: 'package.json was unreadable.' }
  }

  const head = await fetchHeadCommit(owner, slug, meta.defaultBranch, fetchImpl, sleep, token)
  if (head === null) {
    return { ok: false, code: 'fetch-failed', detail: `Could not resolve the head commit of ${meta.fullName}.` }
  }

  const root = projectCandidate(meta, manifest, head, undefined)
  // The rescue probe: only a `requires-build` root can be rescued, so only it
  // is probed. The release rides the candidate through the state file, so a
  // repo with no release does not re-consume this budget daily.
  if (root !== null && root.requiresBuild) {
    const release = await fetchLatestReleaseTarball(owner, slug, fetchImpl, sleep, token)
    if (release !== null) root.release = release
  }
  if (root !== null && root.hasBundle) {
    return { ok: true, candidates: [root] }
  }
  if (probeSubpackages && monorepoSignal(manifest)) {
    const subs = await probeSubpackageCandidates(owner, slug, meta, manifest, head, fetchImpl, sleep, token)
    if (subs.length > 0) return { ok: true, candidates: subs }
  }
  if (root === null) {
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
  fetched: number
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
  } = options
  if (token === undefined) {
    return { candidates: [], failures: [], seen: [], gone: [], nextState: state, skipped: true, searchStars: new Map(), windowCount: 0, fetched: 0, carried: 0, deferred: 0 }
  }
  const { seen, metas, windowCount } = await searchReposByTopic(fetchImpl, sleep, token)
  const searchStars = new Map<string, number>()
  for (const [repo, meta] of metas) {
    if (meta.stars !== null) searchStars.set(repo, meta.stars)
  }
  const { toFetch, gone } = diffRepoState(state, seen)
  // Budget slice: sorted order keeps the deferral deterministic.
  const queue = toFetch.sort((a, b) => (a.repo < b.repo ? -1 : a.repo > b.repo ? 1 : 0)).slice(0, budget)
  const fresh = new Map<string, { candidates: RepoCandidate[]; failure?: { code: 'no-manifest'; detail: string } }>()
  const failures: RepoFetchFailure[] = []
  for (let i = 0; i < queue.length; i += REPO_CONCURRENCY) {
    const batch = queue.slice(i, i + REPO_CONCURRENCY)
    const results = await Promise.all(batch.map(async entry => {
      const meta = metas.get(entry.repo)
      if (meta === undefined) return { entry, result: { ok: false, code: 'fetch-failed', detail: 'search result lost between the enumeration and the fetch' } as RepoFetchResult }
      return { entry, result: await fetchRepoCandidate(meta, fetchImpl, sleep, token, probeSubpackages) }
    }))
    for (const { entry, result } of results) {
      if (result.ok) {
        fresh.set(entry.repo, { candidates: result.candidates })
      } else {
        failures.push({ repo: entry.repo, code: result.code, detail: result.detail })
        // A deterministic failure on a repo with NO recorded entry is
        // recorded so the next runs carry the reason instead of re-fetching
        // the same dead end and re-consuming the budget. A repo WITH a
        // recorded entry keeps its candidates: the old pushedAt mismatch
        // schedules the retry next run (a `fetch-failed` stays transient
        // either way).
        if (result.code === 'no-manifest' && state[entry.repo] === undefined) {
          fresh.set(entry.repo, { candidates: [], failure: { code: result.code, detail: result.detail } })
        }
      }
    }
  }
  const nextState = nextRepoState(state, seen, fresh)
  const candidates = Object.values(nextState).flatMap(entry => entry.candidates)
  const carried = Object.keys(nextState).length - fresh.size
  // Carried deterministic failures keep flowing into the report every run —
  // the catalog accounts for every pool member, fetched or carried.
  for (const [repo, entry] of Object.entries(nextState)) {
    if (entry.failure !== undefined && !fresh.has(repo)) {
      failures.push({ repo, code: entry.failure.code, detail: entry.failure.detail })
    }
  }
  return {
    candidates,
    failures,
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
