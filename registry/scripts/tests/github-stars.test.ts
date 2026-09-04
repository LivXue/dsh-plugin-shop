import { describe, expect, it } from 'vitest'
import { fetchStarCounts, STAR_BATCH_SIZE, STARS_REQUEST_TIMEOUT_MS } from '../src/github-stars.ts'

const options = { token: 'gh-token' }
const repo = (i: number) => ({ owner: `owner${i}`, name: `repo${i}` })

const okResponse = (counts: Record<string, number | null>): Response => {
  const data = Object.fromEntries(Object.entries(counts).map(([k, n], i) => [`a${i}`, { stargazerCount: n }]))
  return new Response(JSON.stringify({ data }), { status: 200 })
}

describe('fetchStarCounts', () => {
  it('returns immediately for an empty token', async () => {
    const fetchImpl = (async () => { throw new Error('must not be called') }) as unknown as typeof fetch
    const result = await fetchStarCounts([{ owner: 'a', name: 'b' }], { token: '', fetchImpl })
    expect(result.stars.size).toBe(0)
    expect(result.skipped).toEqual([])
  })

  it('returns immediately for an empty repo list', async () => {
    const fetchImpl = (async () => { throw new Error('must not be called') }) as unknown as typeof fetch
    const result = await fetchStarCounts([], { ...options, fetchImpl })
    expect(result.stars.size).toBe(0)
  })

  it('batches 120 repos into 50/50/20 queries with aliases and a bearer header', async () => {
    const bodies: { aliases: number; auth: string }[] = []
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { query: string; variables?: unknown }
      bodies.push({
        aliases: (body.query.match(/a\d+:/g) ?? []).length,
        auth: String((init?.headers as Record<string, string>).Authorization),
      })
      return new Response(JSON.stringify({ data: {} }), { status: 200 })
    }) as unknown as typeof fetch
    await fetchStarCounts(Array.from({ length: 120 }, (_, i) => repo(i)), { ...options, fetchImpl })
    expect(bodies.map(b => b.aliases)).toEqual([50, 50, 20])
    expect(bodies.every(b => b.auth === 'Bearer gh-token')).toBe(true)
  })

  it('records a null stargazerCount as skipped', async () => {
    const fetchImpl = (async () => okResponse({ 'owner0/repo0': null, 'owner1/repo1': 42 })) as unknown as typeof fetch
    const result = await fetchStarCounts([repo(0), repo(1)], { ...options, fetchImpl })
    expect(result.stars.get('owner1/repo1')).toBe(42)
    expect(result.stars.has('owner0/repo0')).toBe(false)
    expect(result.skipped).toContain('owner0/repo0: no count')
  })

  it('discards a whole batch when the response carries an errors field', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ errors: [{ message: 'rate limit' }] }), { status: 200 })) as unknown as typeof fetch
    const result = await fetchStarCounts([repo(0), repo(1)], { ...options, fetchImpl })
    expect(result.stars.size).toBe(0)
    expect(result.skipped.length).toBe(2)
  })

  it('retries a 429 honoring Retry-After and succeeds', async () => {
    const delays: number[] = []
    const sleep = async (ms: number) => { delays.push(ms) }
    let calls = 0
    const fetchImpl = (async () => {
      calls += 1
      if (calls === 1) return new Response('slow', { status: 429, headers: { 'Retry-After': '2' } })
      return okResponse({ 'owner0/repo0': 7 })
    }) as unknown as typeof fetch
    const result = await fetchStarCounts([repo(0)], { ...options, fetchImpl, sleep })
    expect(delays).toEqual([2000])
    expect(result.stars.get('owner0/repo0')).toBe(7)
  })

  it('gives up after bounded retries and skips the batch', async () => {
    const sleep = async (_ms: number) => {}
    let calls = 0
    const fetchImpl = (async () => { calls += 1; return new Response('nope', { status: 503 }) }) as unknown as typeof fetch
    const result = await fetchStarCounts([repo(0)], { ...options, fetchImpl, sleep })
    expect(calls).toBe(4)
    expect(result.stars.size).toBe(0)
    expect(result.skipped[0]).toContain('503')
  })

  it('records a gateway-unreachable discard for every repo when the fetch rejects', async () => {
    const fetchImpl = (async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch
    const result = await fetchStarCounts([{ owner: 'a', name: 'b' }, { owner: 'c', name: 'd' }], { token: 't', fetchImpl })
    expect(result.stars.size).toBe(0)
    expect(result.skipped).toEqual([
      'a/b: gateway unreachable: ECONNREFUSED',
      'c/d: gateway unreachable: ECONNREFUSED',
    ])
  })
})

describe('partial GraphQL responses', () => {
  const batch = [
    { owner: 'good', name: 'one' },
    { owner: 'good', name: 'two' },
    { owner: 'gone', name: 'renamed' },
    { owner: 'good', name: 'three' },
  ]

  it('keeps the healthy aliases when one alias errors, with the real reason on the skip', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({
      data: { a0: { stargazerCount: 10 }, a1: { stargazerCount: 20 }, a2: null, a3: { stargazerCount: 30 } },
      errors: [{ message: 'Could not resolve to a Repository', path: ['a2'] }],
    }), { status: 200 })) as unknown as typeof fetch
    const { stars, skipped } = await fetchStarCounts(batch, { token: 't', fetchImpl, sleep: async () => {} })
    expect(stars.get('good/one')).toBe(10)
    expect(stars.get('good/two')).toBe(20)
    expect(stars.get('good/three')).toBe(30)
    expect(stars.size).toBe(3)
    expect(skipped).toEqual(['gone/renamed: Could not resolve to a Repository'])
  })

  it('skips per alias with the generic reason when errors carry no path', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({
      data: { a0: { stargazerCount: 5 }, a1: null, a2: null, a3: null },
      errors: [{ message: 'something else' }],
    }), { status: 200 })) as unknown as typeof fetch
    const { stars, skipped } = await fetchStarCounts(batch, { token: 't', fetchImpl, sleep: async () => {} })
    expect(stars.get('good/one')).toBe(5)
    expect(skipped).toHaveLength(3)
    expect(skipped.every(s => s.endsWith(': no count'))).toBe(true)
  })
})

describe('request deadlines', () => {
  it('has a per-request deadline at all', () => {
    // A literal, not a re-export of the constant: a fixture computed from the
    // value it tests can never detect that value moving.
    expect(STARS_REQUEST_TIMEOUT_MS).toBe(30_000)
  })

  it('skips a batch whose request never answers instead of hanging the build', async () => {
    // Stars are advisory and every failure mode already ends in `skipped`; the
    // deadline is what makes a stalled GraphQL endpoint one of those failure
    // modes rather than the job's six-hour kill.
    const fetchImpl = (async () => new Promise<Response>(() => {})) as unknown as typeof fetch
    const started = Date.now()
    const result = await fetchStarCounts([repo(0)], {
      ...options, fetchImpl, sleep: async (_ms: number) => {}, timeoutMs: 50,
    })
    expect(result.stars.size).toBe(0)
    expect(result.skipped).toHaveLength(1)
    expect(result.skipped[0]).toContain('owner0/repo0')
    expect(result.skipped[0]).toContain('gateway unreachable')
    expect(Date.now() - started).toBeLessThan(5000)
  })

  it('does not fire early: a slow but healthy batch still yields its counts', async () => {
    // The other side of the bound. A deadline wired to the wrong number passes
    // the stall test above and then drops every star count in the catalog —
    // silently, because losing them is already a supported outcome here.
    const SLOW_MS = 40
    const DEADLINE_MS = 2000
    const fetchImpl = (async () => {
      await new Promise(resolve => setTimeout(resolve, SLOW_MS))
      return okResponse({ 'owner0/repo0': 7 })
    }) as unknown as typeof fetch
    const result = await fetchStarCounts([repo(0)], { ...options, fetchImpl, timeoutMs: DEADLINE_MS })
    expect(result.stars.get('owner0/repo0')).toBe(7)
    expect(result.skipped).toEqual([])
  })
})
