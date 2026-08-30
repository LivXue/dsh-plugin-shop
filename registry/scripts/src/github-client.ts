/**
 * The impure shell for the GitHub half of the harvest: topic search and
 * per-repository manifest fetches. Everything npm-shaped lives in
 * `npm-client.ts`; the policy decisions these feeds enable live in the pure
 * `repo-gate.ts` / `pipeline.ts` on the other side of this boundary.
 */

import { fetchWithRetry } from './npm-client.ts'
import type { RepoCandidate } from './types.ts'

const GITHUB_API = 'https://api.github.com'
const RAW_GITHUB = 'https://raw.githubusercontent.com'

/**
 * GitHub's endpoints are flaky from shared egress: undici's h2 connections
 * die with `UND_ERR_HEADERS_TIMEOUT`, and bursts of parallel connections can
 * draw connect timeouts from the CDN. Four attempts with a doubling backoff
 * (2/4/8s, ~14s worst case per request) ride most of it out; 429s still go
 * through fetchWithRetry's own budget.
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

/** Fewer parallel connections than the npm harvest: the GitHub CDN drops
 * bursts, and the API's per-token rate budget is modest. */
const REPO_CONCURRENCY = 4

/** GitHub's hard ceiling on search results: 1,000 per query, no page 11. */
export const GITHUB_SEARCH_CAP = 1000
const SEARCH_PAGE_SIZE = 100
/** Pages of the cap; hitting it is the platform limit, not a harvest bug. */
export const MAX_SEARCH_PAGES = Math.ceil(GITHUB_SEARCH_CAP / SEARCH_PAGE_SIZE)

/** The GitHub topics the harvest searches, mirroring the npm keywords. */
export const HARVEST_TOPICS: readonly string[] = ['dsh-plugin', 'deepseek-harness']

/**
 * One repository's fetch outcome: a gated-able candidate, or the reason none
 * could be produced. `no-manifest` means the repo exists but has no usable
 * `package.json` at the default branch — the repo is not an installable
 * plugin unit, an author-readable fact distinct from a transient failure.
 */
export type RepoFetchResult =
  | { ok: true; candidate: RepoCandidate }
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
}

function parseRepoMeta(item: unknown): RepoMeta | null {
  const o = item as {
    full_name?: unknown
    default_branch?: unknown
    description?: unknown
    license?: { spdx_id?: unknown } | null
  }
  if (typeof o.full_name !== 'string' || typeof o.default_branch !== 'string') return null
  return {
    fullName: o.full_name,
    defaultBranch: o.default_branch,
    description: typeof o.description === 'string' && o.description !== '' ? o.description : null,
    license: o.license != null && typeof o.license.spdx_id === 'string' ? o.license.spdx_id : null,
  }
}

/** Fetch one page of GitHub's topic search. */
async function searchPage(
  topic: string,
  page: number,
  fetchImpl: typeof fetch,
  sleep: (ms: number) => Promise<void>,
  token: string | undefined,
): Promise<{ items: unknown[]; capped: boolean }> {
  const url = `${GITHUB_API}/search/repositories?q=topic:${topic}&per_page=${SEARCH_PAGE_SIZE}&page=${page}`
  const response = await fetchRobust(url, fetchImpl, sleep, token)
  if (!response.ok) throw new Error(`github search for topic:${topic} failed: ${response.status}`)
  const body = await response.json() as { items?: unknown }
  const items = Array.isArray(body.items) ? body.items : []
  return { items, capped: items.length >= SEARCH_PAGE_SIZE && (page + 1) * SEARCH_PAGE_SIZE >= GITHUB_SEARCH_CAP }
}

/**
 * List every repository carrying one of the harvest topics, deduplicated and
 * sorted. GitHub search caps at {@link GITHUB_SEARCH_CAP} results per topic;
 * the caller is told when the cap was hit so the report can say so.
 * @returns the repo metadata, and whether any topic hit the platform cap.
 */
export async function searchReposByTopic(
  fetchImpl: typeof fetch = fetch,
  sleep: (ms: number) => Promise<void> = async (ms: number) => { await new Promise(resolve => setTimeout(resolve, ms)) },
  token: string | undefined = undefined,
): Promise<{ repos: RepoMeta[]; capped: boolean }> {
  const seen = new Set<string>()
  const repos: RepoMeta[] = []
  let capped = false
  for (const topic of HARVEST_TOPICS) {
    for (let page = 1; page <= MAX_SEARCH_PAGES; page += 1) {
      const pageResult = await searchPage(topic, page, fetchImpl, sleep, token)
      for (const item of pageResult.items) {
        const meta = parseRepoMeta(item)
        if (meta === null || seen.has(meta.fullName)) continue
        seen.add(meta.fullName)
        repos.push(meta)
      }
      capped = capped || pageResult.capped
      if (pageResult.items.length < SEARCH_PAGE_SIZE) break
    }
  }
  repos.sort((a, b) => (a.fullName < b.fullName ? -1 : a.fullName > b.fullName ? 1 : 0))
  return { repos, capped }
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
 * Fetch one repository's manifest and project it into a candidate.
 * @returns the candidate, or a code + author-readable reason.
 */
export async function fetchRepoCandidate(
  meta: RepoMeta,
  fetchImpl: typeof fetch = fetch,
  sleep: (ms: number) => Promise<void> = async (ms: number) => { await new Promise(resolve => setTimeout(resolve, ms)) },
  token: string | undefined = undefined,
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
  const m = manifest as {
    name?: unknown
    description?: unknown
    scripts?: { prepare?: unknown; prepack?: unknown }
    dsh?: { bundle?: unknown; catalog?: unknown }
  }
  const scripts = typeof m.scripts === 'object' && m.scripts !== null ? m.scripts : {}
  const requiresBuild = typeof scripts.prepare === 'string' || typeof scripts.prepack === 'string'
  if (typeof m.name !== 'string' || m.name === '') {
    return { ok: false, code: 'no-manifest', detail: 'package.json declares no name, so dsh has nothing to register.' }
  }

  const head = await fetchHeadCommit(owner, slug, meta.defaultBranch, fetchImpl, sleep, token)
  if (head === null) {
    return { ok: false, code: 'fetch-failed', detail: `Could not resolve the head commit of ${meta.fullName}.` }
  }

  return {
    ok: true,
    candidate: {
      name: m.name,
      repo: meta.fullName,
      commit: head.sha,
      version: head.sha,
      publishedAt: head.date === '' ? null : head.date,
      repository: `https://github.com/${owner}/${slug}`,
      license: meta.license,
      hasBundle: m.dsh?.bundle !== undefined,
      requiresBuild,
      catalog: m.dsh?.catalog ?? null,
      description: meta.description ?? (typeof m.description === 'string' ? m.description : null),
    },
  }
}

/**
 * Harvest every repository candidate for the topics, with bounded
 * concurrency, mirroring the npm harvest's shape.
 * @returns usable candidates, and per-repo failures with author-readable reasons.
 */
export async function harvestRepos(
  fetchImpl: typeof fetch = fetch,
  sleep: (ms: number) => Promise<void> = async (ms: number) => { await new Promise(resolve => setTimeout(resolve, ms)) },
  token: string | undefined = undefined,
): Promise<{ candidates: RepoCandidate[]; failures: RepoFetchFailure[]; capped: boolean; skipped: boolean }> {
  if (token === undefined) {
    return { candidates: [], failures: [], capped: false, skipped: true }
  }
  const { repos, capped } = await searchReposByTopic(fetchImpl, sleep, token)
  const candidates: RepoCandidate[] = []
  const failures: RepoFetchFailure[] = []
  for (let i = 0; i < repos.length; i += REPO_CONCURRENCY) {
    const batch = repos.slice(i, i + REPO_CONCURRENCY)
    const results = await Promise.all(batch.map(async meta => ({ meta, result: await fetchRepoCandidate(meta, fetchImpl, sleep, token) })))
    for (const { meta, result } of results) {
      if (result.ok) candidates.push(result.candidate)
      else failures.push({ repo: meta.fullName, code: result.code, detail: result.detail })
    }
  }
  return { candidates, failures, capped, skipped: false }
}
