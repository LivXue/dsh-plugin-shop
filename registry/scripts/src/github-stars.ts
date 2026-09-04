/**
 * GitHub star fetching — the THIRD network module (npm-client, llm-client,
 * this). Batched GraphQL: 50 repositories per request via aliases, requests
 * run sequentially. Every failure mode ends in `skipped` entries, never a
 * throw — stars are advisory and a failed fetch publishes without them
 * (spec 2026-08-26-github-stars-design.md §2.2, D4).
 * @module github-stars
 */

import { withTimeout } from './npm-client.ts'

export const STAR_BATCH_SIZE = 50

const RETRY_LIMIT = 4
const RETRY_BASE_DELAY_MS = 1000
const RETRY_MAX_DELAY_MS = 8000
const ENDPOINT = 'https://api.github.com/graphql'

/** Per-attempt bound on a stars GraphQL request. Matches the GitHub client's:
 * the same endpoint host, the same reason. */
export const STARS_REQUEST_TIMEOUT_MS = 30_000

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
  },
): Promise<StarFetchResult> {
  const { token, fetchImpl = fetch, sleep = defaultSleep, timeoutMs = STARS_REQUEST_TIMEOUT_MS } = options
  // Stars are advisory and every failure mode already ends in `skipped`; the
  // deadline is what makes a stalled GraphQL endpoint one of those failure
  // modes rather than the job's outer kill.
  const timed = withTimeout(fetchImpl, timeoutMs, 'github graphql')
  const stars = new Map<string, number>()
  const skipped: string[] = []
  if (token === '' || repos.length === 0) return { stars, skipped }

  const batches: { owner: string; name: string }[][] = []
  for (let i = 0; i < repos.length; i += STAR_BATCH_SIZE) batches.push(repos.slice(i, i + STAR_BATCH_SIZE))

  for (const batch of batches) {
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
      } catch {
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
