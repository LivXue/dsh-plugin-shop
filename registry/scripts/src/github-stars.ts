/**
 * GitHub star fetching — the THIRD network module (npm-client, llm-client,
 * this). Batched GraphQL: 50 repositories per request via aliases, requests
 * run sequentially. Every failure mode ends in `skipped` entries, never a
 * throw — stars are advisory and a failed fetch publishes without them
 * (spec 2026-08-26-github-stars-design.md §2.2, D4).
 * @module github-stars
 */

import { FetchTimeoutError, withTimeout } from './npm-client.ts'

export const STAR_BATCH_SIZE = 50

const RETRY_LIMIT = 4
const RETRY_BASE_DELAY_MS = 1000
const RETRY_MAX_DELAY_MS = 8000
const ENDPOINT = 'https://api.github.com/graphql'

/** Per-attempt bound on a stars GraphQL request. Matches the GitHub client's:
 * the same endpoint host, the same reason. */
export const STARS_REQUEST_TIMEOUT_MS = 30_000

/**
 * Wall-clock budget for the whole stars fetch. Past it, the remaining repos
 * are skipped unasked.
 *
 * Measured rather than assumed. Unlike llm-client there is no multiplier here:
 * batches run SEQUENTIALLY, and a throw is not retried (the ladder below
 * matches on status), so the cost of a stalled endpoint is
 * batches x 1 x {@link STARS_REQUEST_TIMEOUT_MS} — but that is linear in the
 * catalog and nothing caps it. At the ~4000 GitHub repositories the live
 * catalog carries, that is 80 batches x 30s = ~40 minutes, and it grows with
 * the ecosystem: at twice the catalog it exceeds what the job has left.
 *
 * That cost is charged to the CATALOG, not just to the stars: fetchStarCounts
 * runs at build.ts:214 and every artifact is written after it, at :264-270. So
 * a stalled GraphQL endpoint delays — and at the job bound, destroys — a
 * catalog that was otherwise ready, over data this module already treats as
 * optional in every other failure mode.
 *
 * Ten minutes is far above a healthy run (80 sequential requests answering in
 * a second or two is ~2-3 minutes, with room for the catalog to double) and
 * far below what the harvest needs.
 *
 * As with classify, the real cap is this plus one {@link
 * STARS_REQUEST_TIMEOUT_MS}, because the check cannot interrupt an in-flight
 * request: ~10.5 minutes. Together with classify's true 50, the advisory steps
 * cap near 60 of the job's 180 minutes (120 until 2026-10-04) rather than the
 * 40 an earlier version of this comment claimed; daily.yml's comment keeps
 * the rest of that split.
 */
export const STARS_BUDGET_MS = 10 * 60_000

function defaultSleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export interface StarFetchResult {
  /** Keyed `owner/name`. */
  stars: Map<string, number>
  /** `owner/name` entries that ended without a count, with a reason. */
  skipped: string[]
}

export async function fetchStarCounts(
  repos: { owner: string; name: string }[],
  options: {
    token: string
    fetchImpl?: typeof fetch
    sleep?: (ms: number) => Promise<void>
    /** Per-attempt deadline on a GraphQL request. Defaults to
     * {@link STARS_REQUEST_TIMEOUT_MS}; a seam, so a test need not wait one out. */
    timeoutMs?: number
    /** Wall-clock budget for the whole fetch. Defaults to {@link STARS_BUDGET_MS}. */
    budgetMs?: number
    /** The clock, so a test can spend a ten-minute budget in milliseconds. */
    now?: () => number
  },
): Promise<StarFetchResult> {
  const {
    token, fetchImpl = fetch, sleep = defaultSleep,
    timeoutMs = STARS_REQUEST_TIMEOUT_MS, budgetMs = STARS_BUDGET_MS,
    // A duration, so a monotonic clock: an NTP step must not expire it.
    now = () => performance.now(),
  } = options
  // Stars are advisory and every failure mode already ends in `skipped`; the
  // deadline is what makes a stalled GraphQL endpoint one of those failure
  // modes rather than the job's outer kill.
  const timed = withTimeout(fetchImpl, timeoutMs, 'github graphql')
  const stars = new Map<string, number>()
  const skipped: string[] = []
  if (token === '' || repos.length === 0) return { stars, skipped }

  const batches: { owner: string; name: string }[][] = []
  for (let i = 0; i < repos.length; i += STAR_BATCH_SIZE) batches.push(repos.slice(i, i + STAR_BATCH_SIZE))

  const startedAt = now()
  for (const batch of batches) {
    if (now() - startedAt >= budgetMs) {
      // Skipped, not dropped: a repo that vanished from the report would be
      // indistinguishable from one with no stars, and the note build.ts prints
      // is the only place this is visible at all.
      for (const r of batch) skipped.push(`${r.owner}/${r.name}: stars budget spent (${budgetMs}ms), not asked`)
      continue
    }
    try {
      const aliases = batch.map((r, i) => `a${i}: repository(owner: ${JSON.stringify(r.owner)}, name: ${JSON.stringify(r.name)}) { stargazerCount }`).join('\n')
      const query = `query {\n${aliases}\n}`
      const request = (): Promise<Response> => timed(ENDPOINT, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
      })
      let response = await request()
      for (let attempt = 0; (response.status === 429 || response.status >= 500) && attempt < RETRY_LIMIT - 1; attempt += 1) {
        const retryAfter = Number(response.headers.get('retry-after'))
        const delay = Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(retryAfter * 1000, RETRY_MAX_DELAY_MS)
          : Math.min(RETRY_BASE_DELAY_MS * 2 ** attempt, RETRY_MAX_DELAY_MS)
        await sleep(delay)
        response = await request()
      }
      if (!response.ok) {
        for (const r of batch) skipped.push(`${r.owner}/${r.name}: gateway ${response.status}`)
        continue
      }
      let body: { data?: Record<string, { stargazerCount?: unknown }>; errors?: unknown[] } = {}
      try {
        const parsed = await response.json() as unknown
        // A `null` body or a primitive parses without throwing but has no
        // `.errors`/`.data` to read; default to an empty object so the access
        // below cannot throw (spec D4 — every failure mode stays in `skipped`).
        if (parsed !== null && typeof parsed === 'object') body = parsed as typeof body
      } catch (error) {
        // A deadline is not a malformed body. `unreadable body` is a statement
        // about GitHub's response, and a mid-body stall is a statement about
        // our own clock; rethrown, it lands in this batch's outer catch with
        // every other transport failure and reports `gateway unreachable:
        // github graphql request exceeded <n>ms`, which is true. The same
        // rethrow npm-client's search reader and github-client's three readers
        // already carry — the rule, not a special case for stars.
        if (error instanceof FetchTimeoutError) throw error
        // A 200 whose body is not JSON: the batch has no readable counts.
        for (const r of batch) skipped.push(`${r.owner}/${r.name}: unreadable body`)
        continue
      }
      // GraphQL returns PARTIAL responses: a failing alias (renamed, deleted,
      // private) yields `errors` alongside `data` with that alias nulled. The
      // batch must not be discarded — the healthy aliases still carry counts.
      // Errors are matched back to their alias by `path[0]` so the skipped
      // entry carries the real reason instead of a generic line.
      const errorByAlias = new Map<string, string>()
      if (body.errors !== undefined) {
        for (const error of body.errors) {
          const path = (error as { path?: unknown } | null)?.path
          const alias = Array.isArray(path) && typeof path[0] === 'string' ? path[0] : undefined
          const message = typeof (error as { message?: unknown } | null)?.message === 'string'
            ? (error as { message: string }).message.slice(0, 80)
            : 'graphql error'
          if (alias !== undefined) errorByAlias.set(alias, message)
        }
      }
      for (let i = 0; i < batch.length; i++) {
        const r = batch[i]
        if (r === undefined) continue
        const count = body.data?.[`a${i}`]?.stargazerCount
        const key = `${r.owner}/${r.name}`
        if (typeof count === 'number') stars.set(key, count)
        else skipped.push(errorByAlias.get(`a${i}`) !== undefined ? `${key}: ${errorByAlias.get(`a${i}`)}` : `${key}: no count`)
      }
    } catch (error) {
      // A transport failure (connection refused, DNS, TLS) or any other throw
      // from this batch's own logic: every repo in the batch becomes a
      // gateway-unreachable discard. A down gateway never fails the star fetch
      // (spec D4) — the module never rejects.
      for (const r of batch) skipped.push(`${r.owner}/${r.name}: gateway unreachable: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return { stars, skipped }
}

/* --------------------------------------------------------------------------
 * Archived flags (design 2026-10-08-archived-flag-and-shadowed-recovery §1.3)
 *
 * The GitHub REST search does not carry `archived` on its items (the probe
 * proved this), so the flag comes from GraphQL `isArchived` instead. The
 * batching is wider than the stars pass: 200 repositories per call rather
 * than 50, because `isArchived` is a single scalar on a well-bounded type
 * and the query stays well inside the 500-point-per-cost-window budget.
 * -------------------------------------------------------------------------- */

/** Repositories per GraphQL batch. One `isArchived` scalar on a repository
 * type costs 1 point per alias, so 200 aliases = 200 points against the
 * 5,000-point hourly budget — the same budget the stars pass already
 * amortizes. Larger than {@link STAR_BATCH_SIZE} because the per-item
 * payload is one boolean, not a count plus an alias header. */
export const ARCHIVED_BATCH_SIZE = 200

export interface ArchivedFetchResult {
  /** Keyed `owner/name`, lowercased. Present only when GitHub answered. */
  flags: Map<string, boolean>
  /** `owner/name` entries that ended without an answer, with a reason. */
  skipped: string[]
}

/**
 * Fetch `isArchived` for a set of listed repositories via GraphQL.
 *
 * Advisory like the stars pass: every failure mode ends in `skipped`, the
 * module never rejects. A repo the response omits (renamed, transferred,
 * deleted between the search and the batch) gets NO entry in the returned
 * Map — "no fact supplied ⇒ no write", the same rule `nextRepoState`
 * carries for absent values.
 *
 * @param repos - `owner/slug` full names, exactly as GitHub resolves them
 *   (case-insensitive). Keys in the returned Map are lowercased.
 */
export async function fetchArchivedFlags(
  repos: string[],
  options: {
    token: string
    fetchImpl?: typeof fetch
    sleep?: (ms: number) => Promise<void>
    timeoutMs?: number
  },
): Promise<ArchivedFetchResult> {
  const {
    token, fetchImpl = fetch, sleep = defaultSleep,
    timeoutMs = STARS_REQUEST_TIMEOUT_MS,
  } = options
  const timed = withTimeout(fetchImpl, timeoutMs, 'github graphql')
  const flags = new Map<string, boolean>()
  const skipped: string[] = []
  if (token === '' || repos.length === 0) return { flags, skipped }

  const batches: string[][] = []
  for (let i = 0; i < repos.length; i += ARCHIVED_BATCH_SIZE) batches.push(repos.slice(i, i + ARCHIVED_BATCH_SIZE))

  for (const batch of batches) {
    try {
      const aliases = batch.map((fullName, i) => {
        const [owner, name] = fullName.split('/', 2)
        return `a${i}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { isArchived }`
      }).join('\n')
      const query = `query {\n${aliases}\n}`
      const request = (): Promise<Response> => timed(ENDPOINT, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
      })
      let response = await request()
      for (let attempt = 0; (response.status === 429 || response.status >= 500) && attempt < RETRY_LIMIT - 1; attempt += 1) {
        const retryAfter = Number(response.headers.get('retry-after'))
        const delay = Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(retryAfter * 1000, RETRY_MAX_DELAY_MS)
          : Math.min(RETRY_BASE_DELAY_MS * 2 ** attempt, RETRY_MAX_DELAY_MS)
        await sleep(delay)
        response = await request()
      }
      if (!response.ok) {
        for (const fullName of batch) skipped.push(`${fullName}: gateway ${response.status}`)
        continue
      }
      let body: { data?: Record<string, { isArchived?: unknown } | null>; errors?: unknown[] } = {}
      try {
        const parsed = await response.json() as unknown
        if (parsed !== null && typeof parsed === 'object') body = parsed as typeof body
      } catch (error) {
        if (error instanceof FetchTimeoutError) throw error
        for (const fullName of batch) skipped.push(`${fullName}: unreadable body`)
        continue
      }
      const errorByAlias = new Map<string, string>()
      if (body.errors !== undefined) {
        for (const error of body.errors) {
          const path = (error as { path?: unknown } | null)?.path
          const alias = Array.isArray(path) && typeof path[0] === 'string' ? path[0] : undefined
          const message = typeof (error as { message?: unknown } | null)?.message === 'string'
            ? (error as { message: string }).message.slice(0, 80)
            : 'graphql error'
          if (alias !== undefined) errorByAlias.set(alias, message)
        }
      }
      for (let i = 0; i < batch.length; i++) {
        const fullName = batch[i]
        if (fullName === undefined) continue
        const node = body.data?.[`a${i}`]
        // `null` means GitHub answered for the alias but the repository is
        // gone (renamed, deleted, private); `undefined` means the alias is
        // absent from the response entirely (both are "no fact supplied").
        if (node === null || node === undefined) {
          skipped.push(errorByAlias.get(`a${i}`) !== undefined
            ? `${fullName}: ${errorByAlias.get(`a${i}`)}`
            : `${fullName}: no answer`)
          continue
        }
        if (typeof node.isArchived === 'boolean') {
          flags.set(fullName.toLowerCase(), node.isArchived)
        } else {
          skipped.push(`${fullName}: no answer`)
        }
      }
    } catch (error) {
      for (const fullName of batch) skipped.push(`${fullName}: gateway unreachable: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return { flags, skipped }
}
