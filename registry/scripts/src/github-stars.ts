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
 * The GitHub REST search does carry both `archived` and `fork` on its
 * items; what the probe disproved was only that the REST projection feeds
 * the emit, not that the field is absent. The build reads both flags from
 * GraphQL (`isArchived`, `isFork`) so the full repo-state pool can be
 * answered in one batched pass. The batching is wider than the stars pass:
 * 200 repositories per call rather than 50, because each flag is a single
 * scalar on a well-bounded type and the query stays well inside the
 * 500-point-per-cost-window budget.
 * -------------------------------------------------------------------------- */

/** Repositories per GraphQL batch. The pass asks two scalars
 * (`isArchived` and `isFork`) on 200 aliases per call; the GitHub GraphQL
 * `rateLimit.cost` response for this query measures 1 point per response,
 * well inside the 5,000-point hourly budget the stars pass already
 * amortizes (and would still fit even at a hypothetical 400/call). Larger
 * than {@link STAR_BATCH_SIZE} because the per-item payload is two
 * booleans, not a count plus an alias header. The flags the pass returns
 * persist (`archived`/`forked` on the repo-state record, mirrored to the
 * catalog entry); stars and repo-gone read per-item summaries, per the
 * github-release-assets §1.3 fairness. */
export const ARCHIVED_BATCH_SIZE = 200

export interface RepoFlagsFetchResult {
  /** Keyed `owner/name`, lowercased. Present only when GitHub answered. */
  archived: Map<string, boolean>
  /** `owner/name` entries whose `isArchived` ended without an answer, with a reason. */
  archivedSkipped: string[]
  /** Keyed `owner/name`, lowercased. Present only when GitHub answered. */
  forked: Map<string, boolean>
  /** `owner/name` entries whose `isFork` ended without an answer, with a reason. */
  forkSkipped: string[]
}

/**
 * Fetch `isArchived` and `isFork` for a set of listed repositories via
 * GraphQL, on the same aliases in one batched pass.
 *
 * Advisory like the stars pass: every failure mode ends in a skip list, the
 * module never rejects. A repo the response omits (renamed, transferred,
 * deleted between the search and the batch) gets NO entry in either returned
 * Map — "no fact supplied ⇒ no write", the same rule `nextRepoState`
 * carries for absent values. Each scalar is its own fact: an alias whose
 * `isArchived` is boolean but whose `isFork` is not (schema drift) records
 * the archived half and skips on the fork half alone. The skip lists are
 * per-scalar so a fork-only failure never inflates the archived skip count
 * the build prints, and vice versa.
 *
 * @param repos - `owner/slug` full names, exactly as GitHub resolves them
 *   (case-insensitive). Keys in the returned Maps are lowercased.
 */
export async function fetchArchivedFlags(
  repos: string[],
  options: {
    token: string
    fetchImpl?: typeof fetch
    sleep?: (ms: number) => Promise<void>
    timeoutMs?: number
  },
): Promise<RepoFlagsFetchResult> {
  const {
    token, fetchImpl = fetch, sleep = defaultSleep,
    timeoutMs = STARS_REQUEST_TIMEOUT_MS,
  } = options
  const timed = withTimeout(fetchImpl, timeoutMs, 'github graphql')
  const archived = new Map<string, boolean>()
  const forked = new Map<string, boolean>()
  const archivedSkipped: string[] = []
  const forkSkipped: string[] = []
  if (token === '' || repos.length === 0) return { archived, archivedSkipped, forked, forkSkipped }

  const batches: string[][] = []
  for (let i = 0; i < repos.length; i += ARCHIVED_BATCH_SIZE) batches.push(repos.slice(i, i + ARCHIVED_BATCH_SIZE))

  for (const batch of batches) {
    try {
      const aliases = batch.map((fullName, i) => {
        const [owner, name] = fullName.split('/', 2)
        return `a${i}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { isArchived isFork }`
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
        for (const fullName of batch) {
          archivedSkipped.push(`${fullName}: gateway ${response.status}`)
          forkSkipped.push(`${fullName}: gateway ${response.status}`)
        }
        continue
      }
      let body: { data?: Record<string, { isArchived?: unknown; isFork?: unknown } | null>; errors?: unknown[] } = {}
      try {
        const parsed = await response.json() as unknown
        if (parsed !== null && typeof parsed === 'object') body = parsed as typeof body
      } catch (error) {
        if (error instanceof FetchTimeoutError) throw error
        for (const fullName of batch) {
          archivedSkipped.push(`${fullName}: unreadable body`)
          forkSkipped.push(`${fullName}: unreadable body`)
        }
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
        // absent from the response entirely (both are "no fact supplied"). A
        // null node fails BOTH scalars, so it lands on both skip lists.
        if (node === null || node === undefined) {
          const reason = errorByAlias.get(`a${i}`) !== undefined
            ? `${fullName}: ${errorByAlias.get(`a${i}`)}`
            : `${fullName}: no answer`
          archivedSkipped.push(reason)
          forkSkipped.push(reason)
          continue
        }
        const key = fullName.toLowerCase()
        // Each scalar is answered independently: a good isArchived beside a
        // malformed isFork still records archived, and vice versa. A failure
        // names its own list only — a bad isFork does NOT charge a skip to
        // archived, and vice versa.
        const isArchived = node.isArchived
        const isFork = node.isFork
        if (typeof isArchived === 'boolean') archived.set(key, isArchived)
        else archivedSkipped.push(`${fullName}: no answer`)
        if (typeof isFork === 'boolean') forked.set(key, isFork)
        else forkSkipped.push(`${fullName}: no answer`)
      }
    } catch (error) {
      for (const fullName of batch) {
        archivedSkipped.push(`${fullName}: gateway unreachable: ${error instanceof Error ? error.message : String(error)}`)
        forkSkipped.push(`${fullName}: gateway unreachable: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
  return { archived, archivedSkipped, forked, forkSkipped }
}
