/**
 * GitHub star fetching — the THIRD network module (npm-client, llm-client,
 * this). Batched GraphQL: 50 repositories per request via aliases, requests
 * run sequentially. Every failure mode ends in `skipped` entries, never a
 * throw — stars are advisory and a failed fetch publishes without them
 * (spec 2026-08-26-github-stars-design.md §2.2, D4).
 * @module github-stars
 */

export const STAR_BATCH_SIZE = 50

const RETRY_LIMIT = 4
const RETRY_BASE_DELAY_MS = 1000
const RETRY_MAX_DELAY_MS = 8000
const ENDPOINT = 'https://api.github.com/graphql'

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
  options: { token: string; fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void> },
): Promise<StarFetchResult> {
  const { token, fetchImpl = fetch, sleep = defaultSleep } = options
  const stars = new Map<string, number>()
  const skipped: string[] = []
  if (token === '' || repos.length === 0) return { stars, skipped }

  const batches: { owner: string; name: string }[][] = []
  for (let i = 0; i < repos.length; i += STAR_BATCH_SIZE) batches.push(repos.slice(i, i + STAR_BATCH_SIZE))

  for (const batch of batches) {
    const aliases = batch.map((r, i) => `a${i}: repository(owner: ${JSON.stringify(r.owner)}, name: ${JSON.stringify(r.name)}) { stargazerCount }`).join('\n')
    const query = `query {\n${aliases}\n}`
    const request = (): Promise<Response> => fetchImpl(ENDPOINT, {
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
    let body: { data?: Record<string, { stargazerCount?: unknown }>; errors?: unknown[] }
    try {
      body = await response.json() as typeof body
    } catch {
      // A 200 whose body is not JSON: the batch has no readable counts.
      for (const r of batch) skipped.push(`${r.owner}/${r.name}: unreadable body`)
      continue
    }
    if (body.errors !== undefined) {
      for (const r of batch) skipped.push(`${r.owner}/${r.name}: graphql errors`)
      continue
    }
    for (let i = 0; i < batch.length; i++) {
      const r = batch[i]
      if (r === undefined) continue
      const count = body.data?.[`a${i}`]?.stargazerCount
      const key = `${r.owner}/${r.name}`
      if (typeof count === 'number') stars.set(key, count)
      else skipped.push(`${key}: no count`)
    }
  }
  return { stars, skipped }
}
